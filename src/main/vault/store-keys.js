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
const { decodeRecoveryKey, deriveRecoveryWrappingKey } = require("./recovery-key");
const {
  encryptGcm,
  decryptGcm,
  getTotpAad,
  getPasswordAad,
  deriveWrappingKey,
  getItemSecretAad,
  getNotesAad,
} = require("./crypto");
const { sealedFieldKeys } = require("./entries");
const { nextRevisionFields } = require("./revisions");
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

/** @typedef {import("./index").Instance} Store */

class VaultStoreKeys {
  // The recovery key created with the vault, handed out once.
  /** @this {Store} */
  takeIssuedRecoveryKey() {
    const recoveryKey = this.issuedRecoveryKey;
    this.issuedRecoveryKey = null;
    return recoveryKey;
  }

  /** @this {Store} */
  hasRecoveryKey() {
    this.requireUnlocked();
    return this.envelope.version === FORMAT_VERSION;
  }

  // Creates a new recovery key for the open vault; the previous one stops
  // working for this file. The passphrase is required again so that an
  // unattended unlocked app cannot be used to mint a key.
  /** @this {Store} */
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
  /** @this {Store} */
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
  /** @this {Store} */
  async rotateOpenVault(currentPassphrase, newPassphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.verifyPassphrase(currentPassphrase);
    // The file as it is, under the old key, kept for 90 days.
    await this.pinSnapshotBefore("rekey");
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
      revisionFloor: this.revisionFloor,
    });
    const oldKey = this.dataKey;
    this.dataKey = rotated.dataKey;
    this.vaultData = rotated.vaultData;
    this.envelope = rotated.envelope;
    oldKey.fill(0);
    await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
    this.queueSnapshotAfterUnlock();
    return rotated.recoveryKey;
  }

  /** @this {Store} */
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

  // Checks that `recoveryKeyText` opens the open vault, and changes nothing:
  // the key unwraps the vault key, which must equal the one in use. Throws
  // for a mistyped key (its checksum) and for a key that does not open this
  // vault; the key is not "typed in" in the sense of recovery, so it is not
  // replaced.
  /** @this {Store} */
  async checkRecoveryKey(recoveryKeyText) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (this.envelope.version !== FORMAT_VERSION) throw new Error("This vault has no recovery key.");
      const recoveryKeyBytes = decodeRecoveryKey(recoveryKeyText);
      const header = headerOf(this.envelope);
      const salt = decodeBase64(this.envelope.recovery.salt, SALT_BYTES, SALT_BYTES);
      let wrappingKey = null;
      let unwrapped = null;
      try {
        wrappingKey = deriveRecoveryWrappingKey(recoveryKeyBytes, salt);
        unwrapped = decryptGcm(this.envelope.recoveryWrap, wrappingKey, getAad("recovery-wrap", header), KEY_BYTES);
        if (!timingSafeEqual(unwrapped, /** @type {Buffer} */ (this.dataKey))) throw new Error("mismatch");
      } catch {
        throw new Error("This recovery key does not open this vault.");
      } finally {
        recoveryKeyBytes.fill(0);
        salt.fill(0);
        wrappingKey?.fill(0);
        unwrapped?.fill(0);
      }
      return { matches: true };
    });
  }

  // Checks the master passphrase of the open vault, and changes nothing.
  /** @this {Store} */
  async checkPassphrase(passphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(passphrase);
      await this.verifyPassphrase(passphrase);
      return { matches: true };
    });
  }

  // Opens the vault with its recovery key, sets a new master passphrase, and
  // replaces the recovery key, since the old one has now been typed in.
  /** @this {Store} */
  async recoverWithKey(recoveryKeyText, newPassphrase) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      validateNewPassphrase(newPassphrase);
      const recoveryKeyBytes = decodeRecoveryKey(recoveryKeyText);
      // Locked here, so the copy is checked at a later unlock with its key.
      await this.pinSnapshotBefore("rekey");
      let opened = null;
      try {
        opened = await this.decryptVaultFile(this.filePath, { recoveryKeyBytes });
      } finally {
        recoveryKeyBytes.fill(0);
      }

      try {
        // An older copy is not rekeyed and opened without a word either.
        const verdict = await this.admitRevision(opened.vaultData);
        // The recovery key has now been typed in, so the vault key it
        // protected is replaced along with it.
        const rotated = await this.rekeyNow({
          vaultData: opened.vaultData,
          oldKey: opened.dataKey,
          passphrase: newPassphrase,
          readAttachment: (attachment) => this.readAttachmentFile(attachment),
          sessionEpoch,
          interrupted: "Recovery was interrupted because the vault was locked.",
          revisionFloor: verdict.recordRevision,
        });
        this.lock();
        this.dataKey = rotated.dataKey;
        this.vaultData = rotated.vaultData;
        this.envelope = rotated.envelope;
        await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
        await this.maintainNow();
        this.queueSnapshotAfterUnlock();
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
  //
  // It is a write like any other: the revision goes up, above
  // `revisionFloor` (the newest one the record has seen), and the record
  // follows the file.
  /** @this {Store} */
  async rekeyNow({ vaultData, oldKey, passphrase, readAttachment, sessionEpoch, interrupted, revisionFloor = 0 }) {
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
    // `content` is the entry itself or one of its history versions. Empty
    // notes stay "".
    const resealContent = (entry, content) => {
      const notes = content.notes ? reseal(content.notes, getNotesAad(entry.id, "notes")) : "";
      if (entry.type === "login") {
        const next = { ...content, notes, password: reseal(content.password, getPasswordAad(entry.id)) };
        if (content.totp) next.totp = reseal(content.totp, getTotpAad(entry.id));
        return next;
      }
      const fields = { ...content.fields };
      for (const key of sealedFieldKeys(entry.type)) {
        if (fields[key]) fields[key] = reseal(fields[key], getNotesAad(entry.id, key));
      }
      return {
        ...content,
        notes,
        fields,
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
      const nextVaultData = { ...vaultData, entries, ...nextRevisionFields(vaultData, revisionFloor) };
      if (Buffer.byteLength(JSON.stringify(nextVaultData), "utf8") > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }
      const { envelope, recoveryKey } = await makeEnvelope(nextVaultData, passphrase, newKey);
      if (this.sessionEpoch !== sessionEpoch) throw new Error(interrupted);
      await this.writeEnvelope(envelope);
      written = true;
      await this.writeRevisionRecord(nextVaultData);
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
  /** @this {Store} */
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

  /** @this {Store} */
  readAttachmentFile(attachment) {
    return readFileWithLimit(this.attachmentPath(attachment.id), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
  }
}

module.exports = VaultStoreKeys;
