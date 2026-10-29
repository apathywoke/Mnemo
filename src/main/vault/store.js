// The vault store: one encrypted vault file, its lifecycle (create, unlock,
// lock), the mutation queue, and atomic writes. Feature methods are added to
// the prototype by ./index.js.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomUUID,
  randomBytes,
} = require("node:crypto");
const { openVaultSource, readContainerFile } = require("../../../backup-file");
const {
  VAULT_SCHEMA_VERSION,
  KEY_BYTES,
  MAX_FILE_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ENTRIES,
  UUID_PATTERN,
  MAX_FOLDERS,
  HISTORY_LIMIT,
  TRASH_RETENTION_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  MAX_TOTAL_ATTACHMENT_BYTES,
} = require("./constants");
const { deriveRecoveryWrappingKey } = require("./recovery-key");
const {
  encryptGcm,
  decryptGcm,
  openPassword,
  deriveWrappingKey,
  openItemSecret,
} = require("./crypto");
const {
  headerOf,
  getAad,
  validatePassphrase,
  validateNewPassphrase,
  makeEnvelope,
  parseEnvelope,
} = require("./envelope");
const {
  ATTACHMENT_OVERHEAD,
  sealAttachmentKey,
  openAttachmentKey,
  encryptAttachment,
  decryptAttachment,
  normalizeAttachmentName,
  toAttachmentSummary,
  attachmentsOf,
  pathExists,
  readFileWithLimit,
} = require("./attachments");
const { isFolderIdInput, toEntrySummary, toEntryDetails } = require("./entries");
const {
  normalizeFolderName,
  withMeta,
  snapshotOf,
  toVersionSummary,
  pruneHistory,
} = require("./history");
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

  // --- Folders and favorites ------------------------------------------------------
  //
  // Folder and favorite are organization, not content: changing them does not
  // change the entry's date or add a version to its history.

  listFolders() {
    this.requireUnlocked();
    return this.vaultData.folders
      .map((folder) => ({ ...folder }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  }

  findFolder(id) {
    this.requireUnlocked();
    const folder = typeof id === "string" ? this.vaultData.folders.find((item) => item.id === id) : null;
    if (!folder) throw new Error("This folder no longer exists.");
    return folder;
  }

  requireUniqueFolderName(name, exceptId) {
    const lowered = name.toLowerCase();
    if (this.vaultData.folders.some((folder) => folder.id !== exceptId && folder.name.toLowerCase() === lowered)) {
      throw new Error("A folder with this name already exists.");
    }
  }

  async createFolder(name) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const folderName = normalizeFolderName(name);
      if (this.vaultData.folders.length >= MAX_FOLDERS) {
        throw new Error("The vault has reached its folder limit.");
      }
      this.requireUniqueFolderName(folderName, null);
      const folder = { id: randomUUID(), name: folderName, createdAt: Date.now() };
      await this.persistVaultData(this.nextVaultData({ folders: [...this.vaultData.folders, folder] }));
      return { ...folder };
    });
  }

  async renameFolder(id, name) {
    return this.enqueueMutation(async () => {
      const folder = this.findFolder(id);
      const folderName = normalizeFolderName(name);
      if (folderName === folder.name) return { ...folder };
      this.requireUniqueFolderName(folderName, folder.id);
      const renamed = { ...folder, name: folderName };
      await this.persistVaultData(this.nextVaultData({
        folders: this.vaultData.folders.map((item) => (item === folder ? renamed : item)),
      }));
      return { ...renamed };
    });
  }

  // Items in a deleted folder are kept; they only leave the folder.
  async deleteFolder(id) {
    return this.enqueueMutation(async () => {
      const folder = this.findFolder(id);
      await this.persistVaultData(this.nextVaultData({
        folders: this.vaultData.folders.filter((item) => item !== folder),
        entries: this.vaultData.entries.map((entry) =>
          entry.folderId === folder.id ? withMeta(entry, entry, { folderId: null }) : entry),
      }));
      return { deleted: true };
    });
  }

  // `folderId` is a folder ID, or null to take the entry out of its folder.
  async setFolder(id, folderId) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if (folderId === undefined || !isFolderIdInput(folderId)) throw new Error("This folder no longer exists.");
      const target = this.folderIdFor(folderId || null);
      if ((entry.folderId ?? null) === target) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { folderId: target });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async setFavorite(id, favorite) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (typeof favorite !== "boolean") throw new Error("Invalid login entry.");
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if ((entry.favorite === true) === favorite) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { favorite });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  // --- Trash -----------------------------------------------------------------------
  //
  // Deleting moves an entry to the trash, unchanged, with its attachments and
  // history. It can be restored for 30 days (maintainNow removes it after
  // that) or deleted for good, which also removes its attachment files.

  async deleteEntry(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { deletedAt: Date.now() });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async restoreEntry(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (!entry.deletedAt) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { deletedAt: null });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async deletePermanently(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (!entry.deletedAt) throw new Error("Move this item to the trash first.");
      await this.removeEntries((item) => item === entry);
      return { deleted: 1 };
    });
  }

  async emptyTrash() {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      return { deleted: await this.removeEntries((entry) => Boolean(entry.deletedAt)) };
    });
  }

  // Removes matching entries; their attachment files go after the save, so
  // the vault never refers to a missing file.
  async removeEntries(predicate) {
    const removed = this.vaultData.entries.filter(predicate);
    if (removed.length === 0) return 0;
    const removedSet = new Set(removed);
    await this.persistVaultData(this.nextVaultData({
      entries: this.vaultData.entries.filter((entry) => !removedSet.has(entry)),
    }));
    await this.deleteAttachmentFiles(removed.flatMap((entry) => (entry.attachments ?? []).map((item) => item.id)));
    return removed.length;
  }

  // --- History ---------------------------------------------------------------------

  // Earlier versions, newest first, without secrets. `changes` lists the
  // fields that were different in the version that replaced each one.
  getHistory(id) {
    const entry = this.findEntry(id);
    const versions = entry.history ?? [];
    return versions.map((version, index) =>
      toVersionSummary(entry, version, index === 0 ? entry : versions[index - 1]));
  }

  findVersion(entry, versionId) {
    const version = typeof versionId === "string"
      ? (entry.history ?? []).find((item) => item.id === versionId)
      : null;
    if (!version) throw new Error("This version no longer exists.");
    return version;
  }

  // A secret from an earlier version (the old password, or a secret field of
  // a card, identity, or SSH key), for copy or reveal by main.
  revealVersionSecret(id, versionId, field) {
    const entry = this.findEntry(id);
    const version = this.findVersion(entry, versionId);
    let record = null;
    if (entry.type === "login") {
      if (field === "password") record = version.password;
    } else if (typeof field === "string" && Object.hasOwn(version.secrets, field)) {
      record = version.secrets[field];
    }
    if (!record) throw new Error("Could not copy this value.");
    try {
      return entry.type === "login"
        ? openPassword(record, this.dataKey, entry.id)
        : openItemSecret(record, this.dataKey, entry.id, field);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // Makes an earlier version current. The content it replaces becomes the
  // newest version, so restoring can itself be undone.
  async restoreVersion(id, versionId) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      const version = this.findVersion(entry, versionId);
      const now = Math.max(Date.now(), entry.createdAt);
      const content = entry.type === "login"
        ? {
          id: entry.id,
          type: "login",
          name: version.name,
          username: version.username,
          password: version.password,
          url: version.url,
          notes: version.notes,
          favicon: entry.favicon ?? "",
          createdAt: entry.createdAt,
          updatedAt: now,
          ...(version.totp ? { totp: version.totp } : {}),
        }
        : {
          id: entry.id,
          type: entry.type,
          name: version.name,
          notes: version.notes,
          fields: { ...version.fields },
          secrets: { ...version.secrets },
          createdAt: entry.createdAt,
          updatedAt: now,
        };
      const others = (entry.history ?? []).filter((item) => item !== version);
      const history = [snapshotOf(entry, now), ...others].slice(0, HISTORY_LIMIT);
      const saved = withMeta(content, entry, { history });
      await this.replaceEntry(entry, saved);
      return toEntryDetails(saved);
    });
  }

  // --- Attachments ------------------------------------------------------------------

  static attachmentDirectoryFor(vaultPath) {
    return `${vaultPath}.attachments`;
  }

  get attachmentDirectory() {
    return VaultStore.attachmentDirectoryFor(this.filePath);
  }

  attachmentPath(attachmentId) {
    return path.join(this.attachmentDirectory, `${attachmentId}.bin`);
  }

  // The vault file and its attachment folder are never a source or target
  // for user files.
  isVaultPath(candidate) {
    const resolved = path.resolve(candidate);
    const directory = path.resolve(this.attachmentDirectory);
    return resolved === path.resolve(this.filePath) ||
      resolved === directory ||
      resolved.startsWith(`${directory}${path.sep}`);
  }

  async ensureAttachmentDirectory() {
    await fs.mkdir(this.attachmentDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.attachmentDirectory, 0o700);
  }

  findAttachment(id, attachmentId) {
    const entry = this.findEntry(id);
    const attachment = typeof attachmentId === "string"
      ? (entry.attachments ?? []).find((item) => item.id === attachmentId)
      : null;
    if (!attachment) throw new Error("This attachment no longer exists.");
    return { entry, attachment };
  }

  totalAttachmentBytes() {
    return attachmentsOf(this.vaultData).reduce((sum, { attachment }) => sum + attachment.size, 0);
  }

  // Encrypts a copy of `sourcePath` and adds it to the entry. The encrypted
  // file is written first and the vault second, so an interruption leaves at
  // most an unreferenced file, which maintainNow removes.
  async addAttachment(id, sourcePath) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      const sessionEpoch = this.sessionEpoch;
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if ((entry.attachments?.length ?? 0) >= MAX_ATTACHMENTS_PER_ENTRY) {
        throw new Error("An item can have up to 20 attachments.");
      }
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || this.isVaultPath(sourcePath)) {
        throw new Error("Could not read this file.");
      }

      const attachmentId = randomUUID();
      const fileKey = randomBytes(KEY_BYTES);
      let plaintext = null;
      let encrypted = null;
      try {
        try {
          plaintext = await readFileWithLimit(sourcePath, MAX_ATTACHMENT_BYTES);
        } catch (error) {
          if (error?.tooLarge) throw new Error("Attachments can be up to 50 MB each.");
          throw new Error("Could not read this file.");
        }
        if (this.sessionEpoch !== sessionEpoch || !this.isUnlocked()) {
          throw new Error("The vault was locked while saving. Unlock it again.");
        }
        if (this.totalAttachmentBytes() + plaintext.length > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error("Attachments in one vault can take up to 1 GB.");
        }
        encrypted = encryptAttachment(plaintext, fileKey, attachmentId);
        const attachment = {
          id: attachmentId,
          name: normalizeAttachmentName(path.basename(sourcePath)),
          size: plaintext.length,
          key: sealAttachmentKey(fileKey, this.dataKey, entry.id, attachmentId),
          createdAt: Date.now(),
        };
        const filePath = this.attachmentPath(attachmentId);
        await this.ensureAttachmentDirectory();
        await this.writeBytesAtomically(filePath, encrypted);
        try {
          await this.replaceEntry(entry, withMeta(entry, entry, {
            attachments: [...(entry.attachments ?? []), attachment],
          }));
        } catch (error) {
          if (!error?.written) await fs.unlink(filePath).catch(() => {});
          throw error;
        }
        return toAttachmentSummary(attachment);
      } finally {
        plaintext?.fill(0);
        encrypted?.fill(0);
        fileKey.fill(0);
      }
    });
  }

  // Decrypts an attachment and writes it to `destinationPath`.
  async exportAttachment(id, attachmentId, destinationPath) {
    return this.enqueueMutation(async () => {
      const { entry, attachment } = this.findAttachment(id, attachmentId);
      if (typeof destinationPath !== "string" || !path.isAbsolute(destinationPath) || this.isVaultPath(destinationPath)) {
        throw new Error("Choose a different location for the file.");
      }
      const plaintext = await this.openAttachment(entry, attachment);
      try {
        await this.writeBytesAtomically(path.resolve(destinationPath), plaintext);
      } catch {
        throw new Error("Could not save the file.");
      } finally {
        plaintext.fill(0);
      }
      return { saved: true, name: attachment.name };
    });
  }

  async openAttachment(entry, attachment) {
    let fileBytes = null;
    let fileKey = null;
    try {
      fileBytes = await readFileWithLimit(this.attachmentPath(attachment.id), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
      fileKey = openAttachmentKey(attachment.key, this.dataKey, entry.id, attachment.id);
      return decryptAttachment(fileBytes, fileKey, attachment.id, attachment.size);
    } catch {
      throw new Error(`The attachment “${attachment.name}” in “${entry.name}” is missing or damaged.`);
    } finally {
      fileBytes?.fill(0);
      fileKey?.fill(0);
    }
  }

  async deleteAttachment(id, attachmentId) {
    return this.enqueueMutation(async () => {
      const { entry, attachment } = this.findAttachment(id, attachmentId);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      await this.replaceEntry(entry, withMeta(entry, entry, {
        attachments: entry.attachments.filter((item) => item !== attachment),
      }));
      await this.deleteAttachmentFiles([attachment.id]);
      return { deleted: true };
    });
  }

  async deleteAttachmentFiles(attachmentIds) {
    await Promise.all(attachmentIds.map((attachmentId) =>
      fs.unlink(this.attachmentPath(attachmentId)).catch(() => {})));
  }

  // Removes files no entry refers to: left by an interrupted save, deletion,
  // or restore. Runs inside the mutation queue, so no attachment is being
  // written at the same time.
  async removeUnreferencedAttachments() {
    if (!this.isUnlocked()) return 0;
    const referenced = new Set(attachmentsOf(this.vaultData).map(({ attachment }) => attachment.id));
    let names;
    try {
      names = await fs.readdir(this.attachmentDirectory);
    } catch {
      return 0;
    }
    if (!this.isUnlocked()) return 0;
    let removed = 0;
    for (const name of names) {
      const match = name.match(/^(.+)\.bin$/);
      const unreferenced = match
        ? UUID_PATTERN.test(match[1]) && !referenced.has(match[1])
        : name.endsWith(".tmp");
      if (unreferenced) {
        await fs.unlink(path.join(this.attachmentDirectory, name)).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }

  // Verifies and copies the attachments of a vault being restored. Returns
  // the files it created; files that already existed hold the same content
  // (attachment IDs are unique and files never change).
  async restoreAttachmentFiles(opened) {
    const wanted = attachmentsOf(opened.vaultData);
    if (wanted.length === 0) return [];
    const added = [];
    try {
      if (!opened.container) throw new Error("invalid");
      await this.ensureAttachmentDirectory();
      for (const { entryId, attachment } of wanted) {
        const blob = opened.container.blobs.get(attachment.id);
        if (!blob || blob.size !== attachment.size + ATTACHMENT_OVERHEAD) throw new Error("invalid");
        const bytes = await readContainerFile(opened.container, attachment.id);
        let fileKey = null;
        let plaintext = null;
        try {
          fileKey = openAttachmentKey(attachment.key, opened.dataKey, entryId, attachment.id);
          plaintext = decryptAttachment(bytes, fileKey, attachment.id, attachment.size);
        } finally {
          fileKey?.fill(0);
          plaintext?.fill(0);
        }
        const target = this.attachmentPath(attachment.id);
        const existed = await pathExists(target);
        await this.writeBytesAtomically(target, bytes);
        if (!existed) added.push(target);
      }
      return added;
    } catch {
      await Promise.all(added.map((file) => fs.unlink(file).catch(() => {})));
      throw new Error("This backup is incomplete or damaged. Nothing was restored.");
    }
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
