// Backups: export, restore, and reading a backup for import. Methods of VaultStore, added to its prototype by
// ./index.js.
const fs = require("node:fs/promises");
const path = require("node:path");
const { toOtpauthUri } = require("../totp");
const { ITEM_TYPES } = require("../../renderer/shared/item-types");
const { readContainerFile, writeContainer } = require("../backup-file");
const VaultStore = require("./store");
const { MAX_FILE_BYTES } = require("./constants");
const { hasExactKeys } = require("./records");
const { decodeRecoveryKey } = require("./recovery-key");
const { openTotp, openPassword, openItemSecret } = require("./crypto");
const { validatePassphrase, validateNewPassphrase, parseEnvelope } = require("./envelope");
const { ATTACHMENT_OVERHEAD, attachmentsOf } = require("./attachments");

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
      const entries = opened.vaultData.entries.filter((entry) => !entry.deletedAt);
      const attachments = entries.reduce((sum, entry) => sum + (entry.attachments?.length ?? 0), 0);
      const logins = entries.map((entry) => entry.type !== "login"
        ? {
          type: entry.type,
          name: entry.name,
          notes: entry.notes,
          fields: Object.fromEntries(
            ITEM_TYPES[entry.type].fields.map((field) => [
              field.key,
              field.kind === "secret"
                ? (entry.secrets[field.key]
                  ? openItemSecret(entry.secrets[field.key], opened.dataKey, entry.id, field.key)
                  : "")
                : entry.fields[field.key] ?? "",
            ]),
          ),
        }
        : {
        name: entry.name,
        username: entry.username,
        password: openPassword(entry.password, opened.dataKey, entry.id),
        url: entry.url,
        notes: entry.notes,
        totp: entry.totp ? toOtpauthUri(openTotp(entry.totp, opened.dataKey, entry.id)) : "",
      });
      return { logins, attachments };
    } finally {
      opened.dataKey.fill(0);
    }
  }

  // Copies the encrypted vault file, plus its encrypted attachment files when
  // there are any (see backup-file.js). Runs in the mutation queue so the
  // copy matches one saved state. Every attachment is decrypted once first:
  // a backup that could not be restored is not written at all.
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
      } catch {
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
  async restoreBackup(sourcePath, credentials) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
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
        return this.restoreWithNewKey(opened, credentials.newPassphrase, sessionEpoch);
      }

      try {
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
      return this.getStatus();
    } finally {
      opened.dataKey.fill(0);
    }
  }
}

module.exports = VaultStoreBackup;
