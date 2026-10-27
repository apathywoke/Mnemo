const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const FILE_VERSION = 1;
const KEY_BYTES = 32;
const MAX_FILE_BYTES = 4096;
const PROFILE_ID_PATTERN = /^(legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

// Touch ID unlock. A vault's data key is encrypted with Electron safeStorage,
// whose key lives in the macOS Keychain under this app's code signature, and
// is released only after systemPreferences.promptTouchID succeeds.
//
// Limits (see docs/THREAT_MODEL.md): Touch ID is checked by the app, not by
// the Keychain item, and the stored key is protected by the login keychain.
// A Secure Enclave key with biometric access control would bind the release
// to the fingerprint itself; it needs a native module and signed builds.
// Keep this interface (isAvailable/isEnabled/enable/disable/releaseKey) so
// that backend can replace this one.
class BiometricUnlock {
  constructor(directory, { safeStorage, systemPreferences, platform = process.platform }) {
    this.directory = path.join(directory, "biometric");
    this.safeStorage = safeStorage;
    this.systemPreferences = systemPreferences;
    this.platform = platform;
  }

  isAvailable() {
    try {
      return (
        this.platform === "darwin" &&
        Boolean(this.systemPreferences?.canPromptTouchID?.()) &&
        Boolean(this.safeStorage?.isEncryptionAvailable?.())
      );
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

  async isEnabled(profileId) {
    const filePath = this.filePath(profileId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async prompt(reason) {
    if (!this.isAvailable()) throw new Error("Touch ID is not available on this Mac.");
    try {
      await this.systemPreferences.promptTouchID(reason);
    } catch {
      throw new Error("Touch ID was canceled or did not match.");
    }
  }

  // Stores the data key after a successful Touch ID check, so enrollment
  // proves the sensor works for this user.
  async enable(profileId, dataKey, reason) {
    const filePath = this.filePath(profileId);
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
      throw new Error("Could not turn on Touch ID.");
    }
    await this.prompt(reason);
    const payload = JSON.stringify({
      version: FILE_VERSION,
      profileId,
      key: dataKey.toString("base64"),
    });
    let encrypted;
    try {
      encrypted = this.safeStorage.encryptString(payload);
    } catch {
      throw new Error("Could not turn on Touch ID.");
    }

    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
      await fs.writeFile(temporaryPath, encrypted, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
    } catch {
      await fs.unlink(temporaryPath).catch(() => {});
      throw new Error("Could not turn on Touch ID.");
    } finally {
      encrypted.fill(0);
    }
  }

  async disable(profileId) {
    await fs.unlink(this.filePath(profileId)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  // Returns the data key after Touch ID. The caller must wipe the buffer.
  async releaseKey(profileId, reason) {
    const filePath = this.filePath(profileId);
    if (!(await this.isEnabled(profileId))) {
      throw new Error("Touch ID is not turned on for this vault.");
    }
    await this.prompt(reason);

    let encrypted = null;
    try {
      const stats = await fs.stat(filePath);
      if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) throw new Error("invalid");
      encrypted = await fs.readFile(filePath);
      const payload = JSON.parse(this.safeStorage.decryptString(encrypted));
      if (
        payload?.version !== FILE_VERSION ||
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
      throw new Error(
        "Touch ID can no longer unlock this vault. Unlock it with your master passphrase and turn Touch ID on again.",
      );
    } finally {
      encrypted?.fill(0);
    }
  }
}

module.exports = BiometricUnlock;
