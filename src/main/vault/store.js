// The vault store: one encrypted vault file, its lifecycle (create, unlock,
// lock), the mutation queue, and atomic writes. Feature methods are added to
// the prototype by ./index.js.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
} = require("node:crypto");
const { openVaultSource } = require("../backup-file");
const {
  VAULT_SCHEMA_VERSION,
  KEY_BYTES,
  MAX_FILE_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ENTRIES,
  TRASH_RETENTION_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
} = require("./constants");
const { deriveRecoveryWrappingKey } = require("./recovery-key");
const { encryptGcm, decryptGcm, deriveWrappingKey } = require("./crypto");
const {
  headerOf,
  getAad,
  validatePassphrase,
  validateNewPassphrase,
  makeEnvelope,
  parseEnvelope,
} = require("./envelope");
const { ATTACHMENT_OVERHEAD } = require("./attachments");
const { pruneHistory } = require("./history");
const { validateVaultData, upgradeVaultData } = require("./schema");

class VaultStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    this.sessionEpoch = 0;
    this.mutationQueue = Promise.resolve();
    this.issuedRecoveryKey = null;
  }

  enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async fileExists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async getStatus() {
    const vaultExists = await this.fileExists();
    return {
      vaultExists,
      unlocked: this.dataKey !== null && this.vaultData !== null,
      entryCount: this.vaultData?.entries.length ?? 0,
    };
  }

  isUnlocked() {
    return this.dataKey !== null && this.vaultData !== null;
  }

  async create(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    validateNewPassphrase(passphrase);
    if (await this.fileExists()) {
      throw new Error("A vault already exists on this Mac.");
    }

    let dataKey = randomBytes(KEY_BYTES);

    try {
      const vaultData = { schemaVersion: VAULT_SCHEMA_VERSION, entries: [], folders: [] };
      const { envelope, recoveryKey } = await makeEnvelope(vaultData, passphrase, dataKey);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      await this.writeEnvelope(envelope);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }

      this.sessionEpoch += 1;
      this.dataKey = dataKey;
      this.vaultData = vaultData;
      this.envelope = envelope;
      this.issuedRecoveryKey = recoveryKey;
      dataKey = null;
      return this.getStatus();
    } catch (error) {
      if (error.message === "A vault already exists on this Mac.") throw error;
      if (error.message === "Creation was interrupted because the vault was locked.") {
        throw error;
      }
      throw new Error("Could not create the encrypted vault.");
    } finally {
      dataKey?.fill(0);
    }
  }

  // Unlocks with the vault key itself, as released from the Keychain after
  // Touch ID. The key is copied; the caller should wipe its own buffer.
  async unlockWithDataKey(dataKey) {
    const sessionEpoch = this.sessionEpoch;
    await this.mutationQueue;
    const opened = await this.decryptVaultFile(this.filePath, { dataKey });
    if (this.sessionEpoch !== sessionEpoch) {
      opened.dataKey.fill(0);
      throw new Error("Unlock was interrupted because the vault was locked.");
    }
    this.lock();
    this.dataKey = opened.dataKey;
    this.vaultData = opened.vaultData;
    this.envelope = opened.envelope;
    await this.enqueueMutation(() => this.maintainNow());
    return this.getStatus();
  }

  // A copy of the vault key for Touch ID enrollment.
  exportDataKey() {
    this.requireUnlocked();
    return Buffer.from(this.dataKey);
  }

  async unlock(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.mutationQueue;
    validatePassphrase(passphrase);
    const opened = await this.decryptVaultFile(this.filePath, passphrase);
    if (this.sessionEpoch !== sessionEpoch) {
      opened.dataKey.fill(0);
      throw new Error("Unlock was interrupted because the vault was locked.");
    }
    this.lock();
    this.dataKey = opened.dataKey;
    this.vaultData = opened.vaultData;
    this.envelope = opened.envelope;
    await this.enqueueMutation(() => this.maintainNow());
    return this.getStatus();
  }

  // --- Housekeeping -------------------------------------------------------------------

  // After the vault opens (inside the mutation queue): removes items that
  // have been in the trash for 30 days and attachment files no item refers
  // to. Failures are left for the next time.
  async maintainNow(now = Date.now()) {
    if (!this.isUnlocked()) return;
    const cutoff = now - TRASH_RETENTION_MS;
    try {
      await this.removeEntries((entry) => Boolean(entry.deletedAt) && entry.deletedAt <= cutoff);
    } catch {
      // Tried again on the next unlock.
    }
    try {
      await this.removeUnreferencedAttachments();
    } catch {
      // Tried again on the next unlock.
    }
  }

  async maintain(now = Date.now()) {
    return this.enqueueMutation(() => this.maintainNow(now));
  }

  requireUnlocked() {
    if (!this.isUnlocked() || !this.envelope) {
      throw new Error("Unlock the vault first.");
    }
  }

  async persistVaultData(nextVaultData) {
    this.requireUnlocked();
    const sessionEpoch = this.sessionEpoch;
    const dataKey = this.dataKey;
    let vaultData = nextVaultData;
    let plaintext = Buffer.from(JSON.stringify(vaultData), "utf8");
    // Oldest versions in the history make room before a save is refused.
    while (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) {
      const pruned = pruneHistory(vaultData, 0.1);
      if (!pruned) break;
      plaintext.fill(0);
      vaultData = pruned;
      plaintext = Buffer.from(JSON.stringify(vaultData), "utf8");
    }
    try {
      if (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }

      const header = headerOf(this.envelope);
      const nextEnvelope = {
        ...this.envelope,
        data: encryptGcm(
          plaintext,
          this.dataKey,
          getAad("vault-data", header),
        ),
      };
      await this.writeEnvelope(nextEnvelope);
      if (this.sessionEpoch !== sessionEpoch || this.dataKey !== dataKey) {
        // The new data is on disk; callers must not undo file changes.
        throw Object.assign(new Error("The vault was locked while saving. Unlock it again."), { written: true });
      }
      this.envelope = nextEnvelope;
      this.vaultData = vaultData;
    } finally {
      plaintext.fill(0);
    }
  }

  // `secret` is the master passphrase (string), { recoveryKeyBytes }, or
  // { dataKey } for a key released by Touch ID. Backups may be containers
  // with attachments (`allowContainer`); the vault file itself never is.
  async decryptVaultFile(filePath, secret, { allowContainer = false } = {}) {
    const usingRecoveryKey = Boolean(secret?.recoveryKeyBytes);
    const usingDataKey = Boolean(secret?.dataKey);
    let wrappingKey = null;
    let dataKey = null;
    let plaintext = null;
    let salt = null;
    let rawFile = null;

    try {
      const source = await openVaultSource(filePath, {
        allowContainer,
        maxEnvelopeBytes: MAX_FILE_BYTES,
        maxHeaderBytes: MAX_FILE_BYTES * 2,
        maxAttachments: MAX_ENTRIES * MAX_ATTACHMENTS_PER_ENTRY,
        maxAttachmentFileBytes: MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD,
      });
      rawFile = source.envelopeBytes ?? null;
      const envelope = source.container ? source.envelope : JSON.parse(rawFile.toString("utf8"));
      const parsed = parseEnvelope(envelope);
      if (usingDataKey) {
        parsed.salt.fill(0);
        parsed.recoverySalt?.fill(0);
        if (secret.dataKey.length !== KEY_BYTES) throw new Error("Invalid key");
        dataKey = Buffer.from(secret.dataKey);
      } else if (usingRecoveryKey) {
        if (!parsed.recoverySalt) {
          parsed.salt.fill(0);
          throw Object.assign(new Error("This vault has no recovery key."), { userFacing: true });
        }
        salt = parsed.recoverySalt;
        parsed.salt.fill(0);
        wrappingKey = deriveRecoveryWrappingKey(secret.recoveryKeyBytes, salt);
        dataKey = decryptGcm(
          envelope.recoveryWrap,
          wrappingKey,
          getAad("recovery-wrap", parsed.header),
          KEY_BYTES,
        );
      } else {
        salt = parsed.salt;
        parsed.recoverySalt?.fill(0);
        wrappingKey = await deriveWrappingKey(secret, salt);
        dataKey = decryptGcm(
          envelope.keyWrap,
          wrappingKey,
          getAad("key-wrap", parsed.header),
          KEY_BYTES,
        );
      }
      plaintext = decryptGcm(
        envelope.data,
        dataKey,
        getAad("vault-data", parsed.header),
      );
      const vaultData = JSON.parse(plaintext.toString("utf8"));
      if (!validateVaultData(vaultData)) throw new Error("Invalid vault data");

      const opened = {
        envelope,
        vaultData: upgradeVaultData(vaultData, dataKey),
        dataKey,
        container: source.container,
      };
      dataKey = null;
      return opened;
    } catch (error) {
      if (error?.userFacing) throw new Error(error.message);
      if (usingDataKey) {
        throw new Error("Touch ID can no longer unlock this vault. Unlock it with your master passphrase and turn Touch ID on again.");
      }
      throw new Error(
        usingRecoveryKey
          ? "Could not open the vault with this recovery key. Check the key and make sure the vault file is intact."
          : "Could not open the vault. Check the master passphrase and make sure the vault or backup file is intact.",
      );
    } finally {
      salt?.fill(0);
      wrappingKey?.fill(0);
      dataKey?.fill(0);
      plaintext?.fill(0);
      rawFile?.fill(0);
    }
  }

  lock() {
    this.sessionEpoch += 1;
    this.issuedRecoveryKey = null;
    this.dataKey?.fill(0);
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    return { vaultExists: true, unlocked: false, entryCount: 0 };
  }

  async writeEnvelope(envelope) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);

    const contents = Buffer.from(JSON.stringify(envelope), "utf8");
    try {
      await this.writeBytesAtomically(this.filePath, contents);
    } finally {
      contents.fill(0);
    }
  }

  async writeBytesAtomically(destinationPath, contents) {
    const directory = path.dirname(destinationPath);
    const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fileHandle = null;

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      fileHandle = await fs.open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(contents);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fs.rename(temporaryPath, destinationPath);
    } catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

module.exports = VaultStore;
