// Recovery keys, passphrase changes, and replacing the vault key. Methods of VaultStore, added to its prototype by
// ./index.js.
const fs = require("node:fs/promises");
const {
  randomUUID,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const {
  FORMAT_VERSION,
  KEY_BYTES,
  SALT_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ATTACHMENT_BYTES,
} = require("./constants");
const { decodeBase64 } = require("./records");
const { decodeRecoveryKey } = require("./recovery-key");
const {
  encryptGcm,
  decryptGcm,
  getTotpAad,
  getPasswordAad,
  deriveWrappingKey,
  getItemSecretAad,
} = require("./crypto");
const {
  headerOf,
  getAad,
  validatePassphrase,
  validateNewPassphrase,
  makeEnvelope,
} = require("./envelope");
const {
  ATTACHMENT_OVERHEAD,
  sealAttachmentKey,
  openAttachmentKey,
  encryptAttachment,
  decryptAttachment,
  readFileWithLimit,
} = require("./attachments");

class VaultStoreKeys {
  // The recovery key created with the vault, handed out once.
  takeIssuedRecoveryKey() {
    const recoveryKey = this.issuedRecoveryKey;
    this.issuedRecoveryKey = null;
    return recoveryKey;
  }

  hasRecoveryKey() {
    this.requireUnlocked();
    return this.envelope.version === FORMAT_VERSION;
  }

  // Creates a new recovery key for the open vault; the previous one stops
  // working for this file. The passphrase is required again so that an
  // unattended unlocked app cannot be used to mint a key.
  async createRecoveryKey(passphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(passphrase);
      return this.rotateOpenVault(passphrase, passphrase);
    });
  }

  // Sets a new master passphrase. Like every change of credentials it also
  // replaces the vault key and the recovery key; the new recovery key is
  // returned.
  async changePassphrase(currentPassphrase, newPassphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(currentPassphrase);
      validateNewPassphrase(newPassphrase);
      return this.rotateOpenVault(currentPassphrase, newPassphrase);
    });
  }

  // For the open vault, inside the mutation queue: checks the current
  // passphrase, then rotates the key under `newPassphrase`.
  async rotateOpenVault(currentPassphrase, newPassphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.verifyPassphrase(currentPassphrase);
    if (this.sessionEpoch !== sessionEpoch) {
      throw new Error("The vault was locked while saving. Unlock it again.");
    }
    const rotated = await this.rekeyNow({
      vaultData: this.vaultData,
      oldKey: this.dataKey,
      passphrase: newPassphrase,
      readAttachment: (attachment) => this.readAttachmentFile(attachment),
      sessionEpoch,
      interrupted: "The vault was locked while saving. Unlock it again.",
    });
    const oldKey = this.dataKey;
    this.dataKey = rotated.dataKey;
    this.vaultData = rotated.vaultData;
    this.envelope = rotated.envelope;
    oldKey.fill(0);
    await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
    return rotated.recoveryKey;
  }

  async verifyPassphrase(passphrase) {
    const header = headerOf(this.envelope);
    const salt = decodeBase64(this.envelope.kdf.salt, SALT_BYTES, SALT_BYTES);
    let wrappingKey = null;
    let unwrapped = null;
    try {
      wrappingKey = await deriveWrappingKey(passphrase, salt);
      unwrapped = decryptGcm(this.envelope.keyWrap, wrappingKey, getAad("key-wrap", header), KEY_BYTES);
      if (!timingSafeEqual(unwrapped, this.dataKey)) throw new Error("mismatch");
    } catch {
      throw new Error("The master passphrase is incorrect.");
    } finally {
      salt.fill(0);
      wrappingKey?.fill(0);
      unwrapped?.fill(0);
    }
  }

  // Opens the vault with its recovery key, sets a new master passphrase, and
  // replaces the recovery key, since the old one has now been typed in.
  async recoverWithKey(recoveryKeyText, newPassphrase) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      validateNewPassphrase(newPassphrase);
      const recoveryKeyBytes = decodeRecoveryKey(recoveryKeyText);
      let opened = null;
      try {
        opened = await this.decryptVaultFile(this.filePath, { recoveryKeyBytes });
      } finally {
        recoveryKeyBytes.fill(0);
      }

      try {
        // The recovery key has now been typed in, so the vault key it
        // protected is replaced along with it.
        const rotated = await this.rekeyNow({
          vaultData: opened.vaultData,
          oldKey: opened.dataKey,
          passphrase: newPassphrase,
          readAttachment: (attachment) => this.readAttachmentFile(attachment),
          sessionEpoch,
          interrupted: "Recovery was interrupted because the vault was locked.",
        });
        this.lock();
        this.dataKey = rotated.dataKey;
        this.vaultData = rotated.vaultData;
        this.envelope = rotated.envelope;
        await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
        await this.maintainNow();
        return { status: await this.getStatus(), recoveryKey: rotated.recoveryKey };
      } finally {
        opened.dataKey.fill(0);
      }
    });
  }

  // --- Key rotation ------------------------------------------------------------
  //
  // Every change of credentials (a new passphrase, a new recovery key,
  // recovery, restoring with the recovery key) replaces the vault key, so
  // anyone who learned the old key (an old recovery key with an old copy of
  // the file, or the Touch ID file with Keychain access) cannot read what is
  // saved afterwards.
  //
  // Sealed values are sealed again under the new key with the same
  // associated data. Each distinct record is resealed once and reused, so
  // records that were the same (a password kept between versions) stay the
  // same, and the history shows no changes that did not happen. Attachments
  // are encrypted again under new file keys and new IDs, one file at a time.
  //
  // New files are written first, then the vault file in one rename. If
  // anything fails before the rename, the new files are removed and the old
  // vault and its files are untouched. Afterwards the caller removes the old
  // files (`replacedAttachmentIds`).
  async rekeyNow({ vaultData, oldKey, passphrase, readAttachment, sessionEpoch, interrupted }) {
    const newKey = randomBytes(KEY_BYTES);
    const resealed = new Map();
    const reseal = (record, aad) => {
      const cacheKey = `${aad.toString("utf8")}\n${JSON.stringify(record)}`;
      if (!resealed.has(cacheKey)) {
        const plaintext = decryptGcm(record, oldKey, aad);
        try {
          resealed.set(cacheKey, encryptGcm(plaintext, newKey, aad));
        } finally {
          plaintext.fill(0);
        }
      }
      return resealed.get(cacheKey);
    };
    // `content` is the entry itself or one of its history versions.
    const resealContent = (entry, content) => {
      if (entry.type === "login") {
        const next = { ...content, password: reseal(content.password, getPasswordAad(entry.id)) };
        if (content.totp) next.totp = reseal(content.totp, getTotpAad(entry.id));
        return next;
      }
      return {
        ...content,
        secrets: Object.fromEntries(Object.entries(content.secrets).map(([field, record]) =>
          [field, reseal(record, getItemSecretAad(entry.id, field))])),
      };
    };

    const addedFiles = [];
    const replacedAttachmentIds = [];
    let written = false;
    try {
      const entries = [];
      for (const entry of vaultData.entries) {
        const next = resealContent(entry, entry);
        if (entry.history) next.history = entry.history.map((version) => resealContent(entry, version));
        if (entry.attachments) {
          next.attachments = [];
          for (const attachment of entry.attachments) {
            next.attachments.push(await this.rekeyAttachment(entry, attachment, oldKey, newKey, readAttachment, addedFiles));
            replacedAttachmentIds.push(attachment.id);
            if (this.sessionEpoch !== sessionEpoch) throw new Error(interrupted);
          }
        }
        entries.push(next);
      }
      const nextVaultData = { ...vaultData, entries };
      if (Buffer.byteLength(JSON.stringify(nextVaultData), "utf8") > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }
      const { envelope, recoveryKey } = await makeEnvelope(nextVaultData, passphrase, newKey);
      if (this.sessionEpoch !== sessionEpoch) throw new Error(interrupted);
      await this.writeEnvelope(envelope);
      written = true;
      if (this.sessionEpoch !== sessionEpoch) {
        // On disk already; the new files are now the referenced ones.
        throw Object.assign(new Error(interrupted), { written: true });
      }
      return { envelope, recoveryKey, vaultData: nextVaultData, dataKey: newKey, replacedAttachmentIds };
    } catch (error) {
      newKey.fill(0);
      if (!written) await Promise.all(addedFiles.map((file) => fs.unlink(file).catch(() => {})));
      throw error;
    }
  }

  // Decrypts one attachment with the old keys and writes it again under a
  // new file key and ID. Only this one file is held in memory.
  async rekeyAttachment(entry, attachment, oldKey, newKey, readAttachment, addedFiles) {
    const attachmentId = randomUUID();
    const fileKey = randomBytes(KEY_BYTES);
    let fileBytes = null;
    let oldFileKey = null;
    let plaintext = null;
    let encrypted = null;
    try {
      try {
        fileBytes = await readAttachment(attachment);
        oldFileKey = openAttachmentKey(attachment.key, oldKey, entry.id, attachment.id);
        plaintext = decryptAttachment(fileBytes, oldFileKey, attachment.id, attachment.size);
      } catch {
        throw new Error(`The attachment “${attachment.name}” in “${entry.name}” is missing or damaged.`);
      }
      encrypted = encryptAttachment(plaintext, fileKey, attachmentId);
      const target = this.attachmentPath(attachmentId);
      await this.ensureAttachmentDirectory();
      await this.writeBytesAtomically(target, encrypted);
      addedFiles.push(target);
      return { ...attachment, id: attachmentId, key: sealAttachmentKey(fileKey, newKey, entry.id, attachmentId) };
    } finally {
      fileBytes?.fill(0);
      oldFileKey?.fill(0);
      plaintext?.fill(0);
      encrypted?.fill(0);
      fileKey.fill(0);
    }
  }

  readAttachmentFile(attachment) {
    return readFileWithLimit(this.attachmentPath(attachment.id), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
  }
}

module.exports = VaultStoreKeys;
