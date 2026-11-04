// Backups: export, restore, and reading a backup for import. Methods of VaultStore, added to its prototype by
// ./index.js.
const fs = require("node:fs/promises");
const path = require("node:path");
const { toOtpauthUri } = require("../totp");
const { ITEM_TYPES } = require("../../shared/item-types.js");
const { toBitwardenCsv, toBitwardenJson } = require("../bitwarden-format");
const { readContainerFile, writeContainer } = require("../backup-file");
const { isDiskFullError } = require("../durable-file");
const VaultStore = require("./store");
const { MAX_FILE_BYTES } = require("./constants");
const { hasExactKeys } = require("./records");
const { decodeRecoveryKey } = require("./recovery-key");
const { openTotp, openPassword, openItemSecret, openNotes } = require("./crypto");
const { validatePassphrase, validateNewPassphrase, parseEnvelope } = require("./envelope");
const { ATTACHMENT_OVERHEAD, attachmentsOf } = require("./attachments");

/** @typedef {import("./index").Instance} Store */

// One item with its secrets open: a login, or { type, name, notes, fields }.
function plainEntry(entry, dataKey) {
  const text = (record, field) => (record ? openNotes(record, dataKey, entry.id, field) : "");
  if (entry.type !== "login") {
    return {
      type: entry.type,
      name: entry.name,
      notes: text(entry.notes, "notes"),
      fields: Object.fromEntries(
        ITEM_TYPES[entry.type].fields.map((field) => [
          field.key,
          field.kind === "secret"
            ? (entry.secrets[field.key]
              ? openItemSecret(entry.secrets[field.key], dataKey, entry.id, field.key)
              : "")
            : field.sealed
              ? text(entry.fields[field.key], field.key)
              : entry.fields[field.key] ?? "",
        ]),
      ),
    };
  }
  return {
    name: entry.name,
    username: entry.username,
    password: openPassword(entry.password, dataKey, entry.id),
    url: entry.url,
    notes: text(entry.notes, "notes"),
    totp: entry.totp ? toOtpauthUri(openTotp(entry.totp, dataKey, entry.id)) : "",
  };
}

class VaultStoreBackup {
  // Reads the logins of a Mnemo backup for import, using its passphrase or
  // { recoveryKey }. Returns plain values; the caller must not keep them.
  static async readBackupLogins(filePath, credentials) {
    const reader = new VaultStore(filePath);
    let secret = credentials;
    let recoveryKeyBytes = null;
    if (typeof credentials === "string") {
      validatePassphrase(credentials);
    } else {
      if (!hasExactKeys(credentials, ["recoveryKey"])) {
        throw new Error("The recovery key is not valid. Check it and try again.");
      }
      recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
      secret = { recoveryKeyBytes };
    }
    let opened;
    try {
      opened = await reader.decryptVaultFile(filePath, secret, { allowContainer: true });
    } finally {
      recoveryKeyBytes?.fill(0);
    }
    try {
      // Items in the backup's trash are left out. Attachments are not
      // imported; their number is reported.
      // The data is schema 4 by now (upgraded on reading), so its text is
      // sealed under the backup's key.
      const entries = opened.vaultData.entries.filter((entry) => !entry.deletedAt);
      const attachments = entries.reduce((sum, entry) => sum + (entry.attachments?.length ?? 0), 0);
      const logins = entries.map((entry) => plainEntry(entry, opened.dataKey));
      return { logins, attachments };
    } finally {
      opened.dataKey.fill(0);
    }
  }

  // Writes the open vault's items without encryption, in Bitwarden's format:
  // `format` is "json" (all types) or "csv" (logins). Attachments, earlier
  // versions, and the trash are left out. The caller has checked the master
  // passphrase and warned the user.
  /** @this {Store} */
  async exportOpenFormat(destinationPath, format) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const resolvedDestination = path.resolve(destinationPath);
      if (this.isVaultPath(resolvedDestination)) {
        throw new Error("Choose a different location for the backup.");
      }
      const items = this.vaultData.entries
        .filter((entry) => !entry.deletedAt)
        .map((entry) => ({
          ...plainEntry(entry, this.dataKey),
          id: entry.id,
          folderId: entry.folderId ?? null,
          favorite: entry.favorite === true,
          fingerprint: entry.fields?.fingerprint ?? "",
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }));
      const vault = { items, folders: this.vaultData.folders ?? [] };
      const contents = Buffer.from(format === "csv" ? toBitwardenCsv(vault) : toBitwardenJson(vault), "utf8");
      try {
        await this.writeBytesAtomically(resolvedDestination, contents);
      } catch (error) {
        if (isDiskFullError(error)) throw error;
        throw new Error("Could not export the vault.");
      } finally {
        contents.fill(0);
      }
      return { exported: items.length };
    });
  }

  // Copies the encrypted vault file, plus its encrypted attachment files when
  // there are any (see backup-file.js). Runs in the mutation queue so the
  // copy matches one saved state. Every attachment is decrypted once first:
  // a backup that could not be restored is not written at all.
  /** @this {Store} */
  async exportBackup(destinationPath) {
    return this.enqueueMutation(async () => {
      if (!this.isUnlocked()) throw new Error("Unlock the vault first.");

      const resolvedDestination = path.resolve(destinationPath);
      if (this.isVaultPath(resolvedDestination)) {
        throw new Error("Choose a different location for the backup.");
      }

      const attachments = [];
      for (const { entryId, attachment } of attachmentsOf(this.vaultData)) {
        const entry = this.vaultData.entries.find((item) => item.id === entryId);
        (await this.openAttachment(entry, attachment)).fill(0);
        attachments.push({
          id: attachment.id,
          path: this.attachmentPath(attachment.id),
          size: attachment.size + ATTACHMENT_OVERHEAD,
        });
      }

      let encryptedFile = null;
      try {
        const stats = await fs.stat(this.filePath);
        if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
          throw new Error("Invalid vault file");
        }
        encryptedFile = await fs.readFile(this.filePath);
        if (encryptedFile.length <= 0 || encryptedFile.length > MAX_FILE_BYTES) {
          throw new Error("Invalid vault file");
        }
        const envelope = JSON.parse(encryptedFile.toString("utf8"));
        parseEnvelope(envelope);
        if (attachments.length === 0) {
          await this.writeBytesAtomically(resolvedDestination, encryptedFile);
        } else {
          await writeContainer(resolvedDestination, envelope, attachments);
        }
        return { exported: true, attachments: attachments.length };
      } catch (error) {
        if (isDiskFullError(error)) throw error;
        throw new Error("Could not create the encrypted backup.");
      } finally {
        encryptedFile?.fill(0);
      }
    });
  }

  // `credentials` is the backup's master passphrase, or
  // { recoveryKey, newPassphrase } when that passphrase is forgotten. With a
  // recovery key the backup is re-encrypted under the new passphrase and a new
  // recovery key, available afterwards from takeIssuedRecoveryKey().
  /** @this {Store} */
  async restoreBackup(sourcePath, credentials) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      // The key is handed to the store below; `dataKey` is then set to null.
      /** @type {{ envelope: any, vaultData: any, dataKey: Buffer | null, container: any }} */
      let opened;
      let envelope;
      if (typeof credentials === "string") {
        validatePassphrase(credentials);
        opened = await this.decryptVaultFile(sourcePath, credentials, { allowContainer: true });
        envelope = opened.envelope;
      } else {
        if (!hasExactKeys(credentials, ["recoveryKey", "newPassphrase"])) {
          throw new Error("The recovery key is not valid. Check it and try again.");
        }
        validateNewPassphrase(credentials.newPassphrase);
        const recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
        try {
          opened = await this.decryptVaultFile(sourcePath, { recoveryKeyBytes }, { allowContainer: true });
        } finally {
          recoveryKeyBytes.fill(0);
        }
        await this.pinSnapshotBefore("restore");
        return this.restoreWithNewKey(opened, credentials.newPassphrase, sessionEpoch);
      }

      try {
        // The vault being replaced, kept for 90 days (verified when it is
        // open, copied for a later check when it is not).
        await this.pinSnapshotBefore("restore");
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        // Attachment files go in first, then the vault file is replaced in
        // one rename. Until then the current vault and its files are intact,
        // and files added for a restore that does not finish are removed.
        const addedFiles = await this.restoreAttachmentFiles(opened);
        try {
          if (this.sessionEpoch !== sessionEpoch) {
            throw new Error("Restore was interrupted because the vault was locked.");
          }
          await this.writeEnvelope(envelope);
        } catch (error) {
          await Promise.all(addedFiles.map((file) => fs.unlink(file).catch(() => {})));
          throw error;
        }
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        this.lock();
        this.dataKey = opened.dataKey;
        this.vaultData = opened.vaultData;
        this.envelope = envelope;
        // Restoring by passphrase keeps the backup's keys and recovery key.
        this.issuedRecoveryKey = null;
        opened.dataKey = null;
        // The replaced vault's files are no longer referenced.
        await this.maintainNow();
        this.queueSnapshotAfterUnlock();
        return this.getStatus();
      } finally {
        opened.dataKey?.fill(0);
      }
    });
  }

  // Restoring with the recovery key: the backup's vault key is known to anyone
  // with that backup and the recovery key just typed in, so the restored vault
  // gets a new key. Attachments come straight from the backup, are verified
  // by decrypting them, and are stored under new keys and IDs.
  /** @this {Store} */
  async restoreWithNewKey(opened, newPassphrase, sessionEpoch) {
    try {
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Restore was interrupted because the vault was locked.");
      }
      let rotated;
      try {
        rotated = await this.rekeyNow({
          vaultData: opened.vaultData,
          oldKey: opened.dataKey,
          passphrase: newPassphrase,
          readAttachment: async (attachment) => {
            const blob = opened.container?.blobs.get(attachment.id);
            if (!blob || blob.size !== attachment.size + ATTACHMENT_OVERHEAD) throw new Error("invalid");
            return readContainerFile(opened.container, attachment.id);
          },
          sessionEpoch,
          interrupted: "Restore was interrupted because the vault was locked.",
        });
      } catch (error) {
        if (/missing or damaged/.test(error.message)) {
          throw new Error("This backup is incomplete or damaged. Nothing was restored.");
        }
        throw error;
      }
      this.lock();
      this.dataKey = rotated.dataKey;
      this.vaultData = rotated.vaultData;
      this.envelope = rotated.envelope;
      this.issuedRecoveryKey = rotated.recoveryKey;
      // The replaced vault's files are no longer referenced.
      await this.maintainNow();
      this.queueSnapshotAfterUnlock();
      return this.getStatus();
    } finally {
      opened.dataKey.fill(0);
    }
  }
}

module.exports = VaultStoreBackup;
