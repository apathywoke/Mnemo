// Attachments: adding, saving, deleting, and cleaning up their files. Methods of VaultStore, added to its prototype by
// ./index.js.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomUUID,
  randomBytes,
} = require("node:crypto");
const { readContainerFile } = require("../backup-file");
const VaultStore = require("./store");
const {
  KEY_BYTES,
  UUID_PATTERN,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  MAX_TOTAL_ATTACHMENT_BYTES,
} = require("./constants");
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
const { withMeta } = require("./history");

/** @typedef {import("./index").Instance} Store */

class VaultStoreAttachments {
  // --- Attachments ------------------------------------------------------------------

  static attachmentDirectoryFor(vaultPath) {
    return `${vaultPath}.attachments`;
  }

  /** @this {Store} */
  get attachmentDirectory() {
    // A static method of this class, copied onto VaultStore by ./index.js.
    return /** @type {import("./index")} */ (/** @type {unknown} */ (VaultStore)).attachmentDirectoryFor(this.filePath);
  }

  /** @this {Store} */
  attachmentPath(attachmentId) {
    return path.join(this.attachmentDirectory, `${attachmentId}.bin`);
  }

  // The vault file and its attachment and snapshot folders are never a
  // source or target for user files.
  /** @this {Store} */
  isVaultPath(candidate) {
    const resolved = path.resolve(candidate);
    return resolved === path.resolve(this.filePath) ||
      [this.attachmentDirectory, this.snapshotDirectory].some((folder) => {
        const directory = path.resolve(folder);
        return resolved === directory || resolved.startsWith(`${directory}${path.sep}`);
      });
  }

  /** @this {Store} */
  async ensureAttachmentDirectory() {
    await fs.mkdir(this.attachmentDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.attachmentDirectory, 0o700);
  }

  /** @this {Store} */
  findAttachment(id, attachmentId) {
    const entry = this.findEntry(id);
    const attachment = typeof attachmentId === "string"
      ? (entry.attachments ?? []).find((item) => item.id === attachmentId)
      : null;
    if (!attachment) throw new Error("This attachment no longer exists.");
    return { entry, attachment };
  }

  /** @this {Store} */
  totalAttachmentBytes() {
    return attachmentsOf(this.vaultData).reduce((sum, { attachment }) => sum + attachment.size, 0);
  }

  // Encrypts a copy of `sourcePath` and adds it to the entry. The encrypted
  // file is written first and the vault second, so an interruption leaves at
  // most an unreferenced file, which maintainNow removes.
  /** @this {Store} */
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
  /** @this {Store} */
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

  /** @this {Store} */
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

  /** @this {Store} */
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

  /** @this {Store} */
  async deleteAttachmentFiles(attachmentIds) {
    await Promise.all(attachmentIds.map((attachmentId) =>
      fs.unlink(this.attachmentPath(attachmentId)).catch(() => {})));
  }

  // Removes files no entry refers to: left by an interrupted save, deletion,
  // or restore. Runs inside the mutation queue, so no attachment is being
  // written at the same time.
  /** @this {Store} */
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
  /** @this {Store} */
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
}

module.exports = VaultStoreAttachments;
