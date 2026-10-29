// Folders, favorites, trash, and history. Methods of VaultStore, added to its prototype by
// ./index.js.
const {
  randomUUID,
} = require("node:crypto");
const { MAX_FOLDERS, HISTORY_LIMIT } = require("./constants");
const { openPassword, openItemSecret } = require("./crypto");
const { isFolderIdInput, toEntrySummary, toEntryDetails } = require("./entries");
const { normalizeFolderName, withMeta, snapshotOf, toVersionSummary } = require("./history");

class VaultStoreOrganize {
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
}

module.exports = VaultStoreOrganize;
