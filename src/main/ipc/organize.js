// IPC handlers. Folders, favorites, trash, history, and attachments.
const path = require("node:path");

function register(ctx) {
  const {
    state,
    tr,
    toIpcError,
    showVaultDialog,
    showSecretDialog,
    copyToClipboardTemporarily,
    registerHandler,
  } = ctx;
  const { app, dialog } = ctx.electron;

  // Folders and favorites.
  registerHandler("vault:list-folders", () => state.vaultStore.listFolders());

  registerHandler("vault:create-folder", (name) => state.vaultStore.createFolder(name));

  registerHandler("vault:rename-folder", (id, name) => state.vaultStore.renameFolder(id, name));

  registerHandler("vault:delete-folder", (id) => state.vaultStore.deleteFolder(id));

  registerHandler("vault:set-folder", (id, folderId) => state.vaultStore.setFolder(id, folderId));

  registerHandler("vault:set-favorite", (id, favorite) => state.vaultStore.setFavorite(id, favorite));

  // Trash. Deleting for good cannot be undone, so it is confirmed in a
  // native dialog that a compromised renderer cannot click through.
  registerHandler("vault:restore-entry", (id) => state.vaultStore.restoreEntry(id));

  async function confirmVaultAction(store, { title, message, detail, confirm }) {
    const epoch = state.lockEpoch;
    const confirmation = await showVaultDialog({
      type: "warning",
      title,
      message,
      detail,
      buttons: [tr("common.cancel"), confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return false;
    if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
    return true;
  }

  registerHandler("vault:delete-forever", async (id) => {
    const store = state.vaultStore;
    const entry = store.getEntry(id);
    if (!entry.deletedAt) throw new Error("Move this item to the trash first.");
    const confirmed = await confirmVaultAction(store, {
      title: tr("dialog.deleteForeverTitle"),
      message: tr("dialog.deleteForeverMessage", { name: entry.name }),
      detail: tr("dialog.deleteForeverDetail"),
      confirm: tr("dialog.deleteForeverConfirm"),
    });
    if (!confirmed) return { deleted: 0 };
    return store.deletePermanently(id);
  });

  registerHandler("vault:empty-trash", async () => {
    const store = state.vaultStore;
    const count = store.listEntries().filter((entry) => entry.deletedAt).length;
    if (count === 0) return { deleted: 0 };
    const confirmed = await confirmVaultAction(store, {
      title: tr("dialog.emptyTrashTitle"),
      message: tr("dialog.emptyTrashMessage", { count }),
      detail: tr("dialog.deleteForeverDetail"),
      confirm: tr("dialog.emptyTrashConfirm"),
    });
    if (!confirmed) return { deleted: 0 };
    return store.emptyTrash();
  });

  // History: summaries without secrets; old secrets are copied or shown by
  // main, like current ones.
  registerHandler("vault:get-history", (id) => state.vaultStore.getHistory(id));

  registerHandler("vault:restore-version", (id, versionId) => state.vaultStore.restoreVersion(id, versionId));

  registerHandler("vault:copy-version-field", (id, versionId, field) => {
    const value = state.vaultStore.revealVersionSecret(id, versionId, field);
    if (!value) throw new Error("Could not copy this value.");
    return copyToClipboardTemporarily(value);
  });

  registerHandler("vault:reveal-version-field", async (id, versionId, field) => {
    const entry = state.vaultStore.getEntry(id);
    const value = state.vaultStore.revealVersionSecret(id, versionId, field);
    const version = state.vaultStore.getHistory(id).find((item) => item.id === versionId);
    const when = new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(version.updatedAt));
    await showSecretDialog({
      entryName: entry.name,
      fieldLabel: tr("history.secretLabel", {
        field: entry.type === "login" ? tr("editor.password") : tr(`item.field.${entry.type}.${field}`),
        date: when,
      }),
      value,
    });
    return { shown: true };
  });

  // Attachments: files are picked and saved through native dialogs here, so
  // the renderer never sees paths or contents.
  registerHandler("vault:add-attachments", async (id) => {
    const store = state.vaultStore;
    const epoch = state.lockEpoch;
    store.getEntry(id);
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.addAttachmentTitle"),
      buttonLabel: tr("dialog.addAttachmentButton"),
      properties: ["openFile", "multiSelections"],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { added: [], failed: [] };
    if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
    const added = [];
    const failed = [];
    for (const filePath of selection.filePaths) {
      try {
        added.push(await store.addAttachment(id, filePath));
      } catch (error) {
        failed.push({ name: path.basename(filePath), error: toIpcError(error).message });
        if (!store.isUnlocked()) break;
      }
    }
    return { added, failed };
  });

  registerHandler("vault:save-attachment", async (id, attachmentId) => {
    const store = state.vaultStore;
    const epoch = state.lockEpoch;
    const { attachment } = store.findAttachment(id, attachmentId);
    const selection = await dialog.showSaveDialog(state.mainWindow, {
      title: tr("dialog.saveAttachmentTitle"),
      buttonLabel: tr("dialog.saveAttachmentButton"),
      defaultPath: path.join(app.getPath("downloads"), attachment.name),
    });
    if (selection.canceled || !selection.filePath) return { saved: false };
    if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
    return store.exportAttachment(id, attachmentId, selection.filePath);
  });

  registerHandler("vault:delete-attachment", async (id, attachmentId) => {
    const store = state.vaultStore;
    const { attachment } = store.findAttachment(id, attachmentId);
    const confirmed = await confirmVaultAction(store, {
      title: tr("dialog.deleteAttachmentTitle"),
      message: tr("dialog.deleteAttachmentMessage", { name: attachment.name }),
      detail: tr("dialog.deleteAttachmentDetail"),
      confirm: tr("dialog.deleteAttachmentConfirm"),
    });
    if (!confirmed) return { deleted: false };
    return store.deleteAttachment(id, attachmentId);
  });
}

module.exports = { register };
