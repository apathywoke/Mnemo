const fs = require("node:fs/promises");
const path = require("node:path");
const { createECDH, hkdfSync, randomBytes, timingSafeEqual } = require("node:crypto");
const { encryptGcm, decryptGcm } = require("./vault/crypto");

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

// Touch ID unlock backed by the Secure Enclave, recorded per vault in
// biometric/<profile>.key. The helper (native/touch-id/main.swift, via
// touch-id-helper.js) creates a P-256 key in the Secure Enclave that can
// only be used after Touch ID with the fingerprints enrolled now. The vault
// key is encrypted (AES-256-GCM) under a key derived (HKDF-SHA-256) from an
// ECDH agreement between that key and a one-time key whose private half is
// discarded. Unlocking asks the helper for the same agreement, which the
// Secure Enclave performs only after Touch ID. The file holds the key's blob
// (usable only by this Mac's Secure Enclave), the one-time public key, a
// salt, and the encrypted key. See docs/THREAT_MODEL.md ("Touch ID helper").
//
// Files from before the helper (version 1) held the vault key encrypted
// with Electron safeStorage, released after an app-side Touch ID check.
// They are deleted at startup and whenever one is found: Touch ID is off
// for that vault until it is turned on again.
class BiometricUnlock {
  // `helper`: { run(request) } from touch-id-helper.js, or null.
  constructor(directory, { helper = null, platform = process.platform } = {}) {
    this.directory = path.join(directory, "biometric");
    this.helper = helper;
    this.platform = platform;
  }

  // The helper runs (macOS 13 or later, built into the app) and reports a
  // Secure Enclave and an enrolled finger.
  async isAvailable() {
    if (this.platform !== "darwin" || !this.helper) return false;
    try {
      return (await this.helper.run({ command: "status" })).available === true;
    } catch {
      return false;
    }
  }

  filePath(profileId) {
    if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error("Choose a valid vault profile.");
    }
    return path.join(this.directory, `${profileId}.key`);
  }

  // Whether a Secure Enclave key file exists. A version 1 file is deleted
  // here, so it never lingers as a copy of the vault key.
  async isEnabled(profileId) {
    this.filePath(profileId);
    let contents;
    try {
      contents = await this.readKeyFile(profileId);
    } catch (error) {
      // A file that is too large is still "on"; unlocking reports it invalid.
      return error.code !== "ENOENT";
    }
    try {
      if (isEnclaveFile(contents)) return true;
    } finally {
      contents.fill(0);
    }
    await this.disable(profileId);
    return false;
  }

  // Deletes every version 1 file, including those of vaults that are not
  // opened. main.js runs it once at startup, before Touch ID can be turned
  // on for any vault.
  async removeOldFiles() {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names) {
      const profileId = name.endsWith(".key") ? name.slice(0, -".key".length) : "";
      if (PROFILE_ID_PATTERN.test(profileId)) await this.isEnabled(profileId).catch(() => {});
    }
  }

  async readKeyFile(profileId) {
    const filePath = this.filePath(profileId);
    const stats = await fs.stat(filePath);
    if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) throw new Error("invalid");
    return fs.readFile(filePath);
  }

  // Stores the data key after a successful Touch ID check, so enrollment
  // proves the sensor works for this user.
  async enable(profileId, dataKey, reason) {
    const filePath = this.filePath(profileId);
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
      throw new Error(ENABLE_FAILED);
    }
    if (!(await this.isAvailable())) throw new Error(UNAVAILABLE);
    const contents = await this.enclaveFile(profileId, dataKey, reason);
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

// Secure Enclave key files are JSON; version 1 files were safeStorage
// output, which starts with "v10".
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
