const fs = require("node:fs/promises");
const path = require("node:path");
const { createECDH, hkdfSync, randomBytes, timingSafeEqual } = require("node:crypto");
const { encryptGcm, decryptGcm } = require("./vault/crypto");

const KEYCHAIN_FILE_VERSION = 1;
const ENCLAVE_FILE_VERSION = 2;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const P256_POINT_BYTES = 65;
const MAX_FILE_BYTES = 4096;
const MAX_KEY_BLOB_LENGTH = 2048;
const PROFILE_ID_PATTERN = /^(legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const CANCELED = "Touch ID was canceled or did not match.";
const UNAVAILABLE = "Touch ID is not available on this Mac.";
const ENABLE_FAILED = "Could not turn on Touch ID.";
const INVALID = "Touch ID can no longer unlock this vault. Unlock it with your master passphrase and turn Touch ID on again.";

// Touch ID unlock, in one of two ways, recorded per vault in
// biometric/<profile>.key:
//
// - Secure Enclave (version 2, the default where available). The helper
//   (native/touch-id/main.swift, via touch-id-helper.js) creates a P-256 key
//   in the Secure Enclave that can only be used after Touch ID with the
//   fingerprints enrolled now. The vault key is encrypted (AES-256-GCM)
//   under a key derived (HKDF-SHA-256) from an ECDH agreement between that
//   key and a one-time key whose private half is discarded. Unlocking asks
//   the helper for the same agreement, which the Secure Enclave performs only
//   after Touch ID. The file holds the key's blob (usable only by this Mac's
//   Secure Enclave), the one-time public key, a salt, and the encrypted key.
//   No Keychain item is involved. See docs/THREAT_MODEL.md ("Touch ID helper").
//
// - Keychain (version 1, written by earlier versions, and still used where
//   the helper cannot run: macOS 12, `npm start` without a built helper). The
//   vault key is encrypted with Electron safeStorage, whose key lives in the
//   login Keychain, and is released after systemPreferences.promptTouchID:
//   Touch ID is checked by the app, not by the Keychain. Kept, and existing
//   files are not converted, until Secure Enclave unlock is confirmed on real
//   hardware.
//
// safeStorage is used through its async API; the synchronous one is
// deprecated in Electron 45. Electron documents that data written by the
// old encryptString decrypts with decryptStringAsync, so key files written
// by earlier versions keep working.
class BiometricUnlock {
  // `helper`: { run(request) } from touch-id-helper.js, or null.
  constructor(directory, { safeStorage, systemPreferences, helper = null, platform = process.platform }) {
    this.directory = path.join(directory, "biometric");
    this.safeStorage = safeStorage;
    this.systemPreferences = systemPreferences;
    this.helper = helper;
    this.platform = platform;
  }

  async keychainAvailable() {
    try {
      return (
        this.platform === "darwin" &&
        Boolean(this.systemPreferences?.canPromptTouchID?.()) &&
        Boolean(await this.safeStorage?.isAsyncEncryptionAvailable?.())
      );
    } catch {
      return false;
    }
  }

  async enclaveAvailable() {
    if (this.platform !== "darwin" || !this.helper) return false;
    try {
      return (await this.helper.run({ command: "status" })).available === true;
    } catch {
      return false;
    }
  }

  async isAvailable() {
    return (await this.enclaveAvailable()) || (await this.keychainAvailable());
  }

  filePath(profileId) {
    if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error("Choose a valid vault profile.");
    }
    return path.join(this.directory, `${profileId}.key`);
  }

  async isEnabled(profileId) {
    const filePath = this.filePath(profileId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // "secureEnclave", "keychain", or null when Touch ID is off.
  async backend(profileId) {
    const contents = await this.readKeyFile(profileId).catch(() => null);
    if (!contents) return null;
    try {
      return isEnclaveFile(contents) ? "secureEnclave" : "keychain";
    } finally {
      contents.fill(0);
    }
  }

  async readKeyFile(profileId) {
    const filePath = this.filePath(profileId);
    const stats = await fs.stat(filePath);
    if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) throw new Error("invalid");
    return fs.readFile(filePath);
  }

  async prompt(reason) {
    if (!(await this.keychainAvailable())) throw new Error(UNAVAILABLE);
    try {
      await this.systemPreferences.promptTouchID(reason);
    } catch {
      throw new Error(CANCELED);
    }
  }

  // Stores the data key after a successful Touch ID check, so enrollment
  // proves the sensor works for this user: in the Secure Enclave where the
  // helper runs, otherwise with the Keychain.
  async enable(profileId, dataKey, reason) {
    const filePath = this.filePath(profileId);
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
      throw new Error(ENABLE_FAILED);
    }
    const contents = (await this.enclaveAvailable())
      ? await this.enclaveFile(profileId, dataKey, reason)
      : await this.keychainFile(profileId, dataKey, reason);
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
      await fs.writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
    } catch {
      await fs.unlink(temporaryPath).catch(() => {});
      throw new Error(ENABLE_FAILED);
    } finally {
      contents.fill(0);
    }
  }

  async keychainFile(profileId, dataKey, reason) {
    await this.prompt(reason);
    const payload = JSON.stringify({
      version: KEYCHAIN_FILE_VERSION,
      profileId,
      key: dataKey.toString("base64"),
    });
    try {
      return await this.safeStorage.encryptStringAsync(payload);
    } catch {
      throw new Error(ENABLE_FAILED);
    }
  }

  // Creates the Secure Enclave key, wraps the data key under the agreement
  // with a one-time key, and unwraps it once through the helper (Touch ID)
  // before anything is written.
  async enclaveFile(profileId, dataKey, reason) {
    const created = await this.helper.run({ command: "create" });
    if (created.error) throw new Error(helperError(created.error, ENABLE_FAILED));
    const enclavePublicKey = decode(created.publicKey, P256_POINT_BYTES);
    if (!enclavePublicKey || typeof created.keyBlob !== "string" || created.keyBlob.length > MAX_KEY_BLOB_LENGTH) {
      throw new Error(ENABLE_FAILED);
    }
    const oneTime = createECDH("prime256v1");
    const ephemeralPublicKey = oneTime.generateKeys();
    const salt = randomBytes(SALT_BYTES);
    let secret = null;
    let confirmed = null;
    let wrappingKey = null;
    try {
      secret = oneTime.computeSecret(enclavePublicKey);
      confirmed = await this.agree(created.keyBlob, ephemeralPublicKey, reason, ENABLE_FAILED);
      if (confirmed.length !== secret.length || !timingSafeEqual(confirmed, secret)) throw new Error(ENABLE_FAILED);
      wrappingKey = deriveWrappingKey(secret, salt, profileId);
      const payload = {
        version: ENCLAVE_FILE_VERSION,
        profileId,
        keyBlob: created.keyBlob,
        ephemeralPublicKey: ephemeralPublicKey.toString("base64"),
        salt: salt.toString("base64"),
        wrap: encryptGcm(dataKey, wrappingKey, wrapAad(profileId)),
      };
      return Buffer.from(JSON.stringify(payload), "utf8");
    } finally {
      secret?.fill(0);
      confirmed?.fill(0);
      wrappingKey?.fill(0);
    }
  }

  // The helper's key agreement, after Touch ID. Returns the shared secret.
  async agree(keyBlob, peerPublicKey, reason, fallbackMessage) {
    const reply = await this.helper.run({
      command: "agree",
      keyBlob,
      peerPublicKey: peerPublicKey.toString("base64"),
      reason: String(reason).slice(0, 200),
    });
    if (reply.error) throw new Error(helperError(reply.error, fallbackMessage));
    const secret = decode(reply.sharedSecret, KEY_BYTES);
    if (!secret) throw new Error(fallbackMessage);
    return secret;
  }

  async disable(profileId) {
    await fs.unlink(this.filePath(profileId)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  // Returns the data key after Touch ID. The caller must wipe the buffer.
  async releaseKey(profileId, reason) {
    if (!(await this.isEnabled(profileId))) {
      throw new Error("Touch ID is not turned on for this vault.");
    }
    let contents;
    try {
      contents = await this.readKeyFile(profileId);
    } catch {
      throw new Error(INVALID);
    }
    try {
      if (!isEnclaveFile(contents)) return await this.releaseFromKeychain(contents, profileId, reason);
      const payload = enclavePayload(contents, profileId);
      if (!payload) throw new Error(INVALID);
      return await this.releaseFromEnclave(payload, profileId, reason);
    } finally {
      contents.fill(0);
    }
  }

  async releaseFromEnclave(payload, profileId, reason) {
    // Not INVALID, on which the caller deletes the file: the file is fine,
    // only the helper is missing here (`npm start` without a built helper).
    if (this.platform !== "darwin" || !this.helper) {
      payload.salt.fill(0);
      throw new Error(UNAVAILABLE);
    }
    let secret = null;
    let wrappingKey = null;
    try {
      secret = await this.agree(payload.keyBlob, payload.ephemeralPublicKey, reason, INVALID);
      wrappingKey = deriveWrappingKey(secret, payload.salt, profileId);
      return decryptGcm(payload.wrap, wrappingKey, wrapAad(profileId), KEY_BYTES);
    } catch (error) {
      throw new Error(error.message === CANCELED || error.message === UNAVAILABLE ? error.message : INVALID);
    } finally {
      secret?.fill(0);
      wrappingKey?.fill(0);
      payload.salt.fill(0);
    }
  }

  async releaseFromKeychain(encrypted, profileId, reason) {
    await this.prompt(reason);
    try {
      // shouldReEncrypt is not acted on: rewriting the file here could race
      // with turning Touch ID off and bring back a key that was removed. A
      // file that stops decrypting ends in the error below, and the user
      // turns Touch ID on again.
      const { result } = await this.safeStorage.decryptStringAsync(encrypted);
      const payload = JSON.parse(result);
      if (
        payload?.version !== KEYCHAIN_FILE_VERSION ||
        payload.profileId !== profileId ||
        typeof payload.key !== "string"
      ) {
        throw new Error("invalid");
      }
      const key = Buffer.from(payload.key, "base64");
      if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new Error("invalid");
      }
      return key;
    } catch {
      throw new Error(INVALID);
    }
  }
}

function decode(value, length) {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length && bytes.toString("base64") === value ? bytes : null;
}

// Binds the wrapped key to its vault profile and to this file format.
function wrapAad(profileId) {
  return Buffer.from(`local-vault:touch-id:v${ENCLAVE_FILE_VERSION}:${profileId}`, "utf8");
}

function deriveWrappingKey(secret, salt, profileId) {
  return Buffer.from(hkdfSync("sha256", secret, salt, wrapAad(profileId), KEY_BYTES));
}

// Secure Enclave key files are JSON; Keychain files are safeStorage output,
// which starts with "v10".
function isEnclaveFile(contents) {
  return contents[0] === 0x7b;
}

// The fields of a Secure Enclave key file, or null if it is damaged or
// belongs to another vault.
function enclavePayload(contents, profileId) {
  let payload;
  try {
    payload = JSON.parse(contents.toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.version !== ENCLAVE_FILE_VERSION || payload.profileId !== profileId) return null;
  const ephemeralPublicKey = decode(payload.ephemeralPublicKey, P256_POINT_BYTES);
  const salt = decode(payload.salt, SALT_BYTES);
  if (
    !ephemeralPublicKey || !salt ||
    typeof payload.keyBlob !== "string" || payload.keyBlob.length > MAX_KEY_BLOB_LENGTH ||
    payload.wrap === null || typeof payload.wrap !== "object"
  ) {
    return null;
  }
  return { keyBlob: payload.keyBlob, ephemeralPublicKey, salt, wrap: payload.wrap };
}

function helperError(code, fallbackMessage) {
  if (code === "canceled" || code === "interactionRequired") return CANCELED;
  if (code === "unavailable") return UNAVAILABLE;
  return fallbackMessage;
}

module.exports = BiometricUnlock;
