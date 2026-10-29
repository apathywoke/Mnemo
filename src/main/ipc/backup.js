// IPC handlers. Backups, import, restoring, and deleting the open vault.
const path = require("node:path");
const { parseImportFile } = require("../../../importers");
const VaultStore = require("../../../vault-store");

const IMPORT_SOURCES = Object.freeze({
  bitwarden: { filterKey: "dialog.importFilterBitwarden", extensions: ["json", "csv"] },
  onepassword: { filterKey: "dialog.importFilterOnePassword", extensions: ["1pux", "csv"] },
  mnemo: { filterKey: "dialog.backupFilter", extensions: ["vault"] },
});

function register(ctx) {
  const {
    state,
    tr,
    toRestoreCredentials,
    activeProfileName,
    showVaultDialog,
    lockVault,
    registerHandler,
  } = ctx;
  const { dialog, shell } = ctx.electron;

  async function saveBackup(store) {
    const selection = await dialog.showSaveDialog(state.mainWindow, {
      title: tr("dialog.saveBackupTitle"),
      buttonLabel: tr("dialog.saveBackupButton"),
      defaultPath: tr("dialog.backupFileName"),
      filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    if (store !== state.vaultStore) throw new Error("Unlock the vault first.");
    await store.exportBackup(selection.filePath);
    return { canceled: false };
  }

  // Exporting copies every secret in the vault, so it asks for the master
  // passphrase again even though the vault is open.
  registerHandler("vault:export-backup", async (passphrase) => {
    const store = state.vaultStore;
    store.requireUnlocked();
    await store.verifyPassphrase(passphrase);
    return saveBackup(store);
  });

  // Right after a recovery key is issued the passphrase was just entered;
  // this path stays available only until that key dialog is closed.
  registerHandler("vault:export-backup-new-key", async () => {
    if (!state.pendingRecoveryKey) throw new Error("Unlock the vault first.");
    return saveBackup(state.vaultStore);
  });

  registerHandler("import:choose-file", async (source, credentials) => {
    if (!Object.hasOwn(IMPORT_SOURCES, source)) throw new Error("This file type is not supported.");
    const store = state.vaultStore;
    store.requireUnlocked();
    state.pendingImport = null;
    const { filterKey, extensions } = IMPORT_SOURCES[source];
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.importTitle"),
      buttonLabel: tr("dialog.importButton"),
      properties: ["openFile"],
      filters: [{ name: tr(filterKey), extensions }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    const filePath = selection.filePaths[0];

    let parsed;
    if (source === "mnemo") {
      const backupCredentials = typeof credentials === "string"
        ? credentials
        : { recoveryKey: credentials?.recoveryKey };
      const { logins, attachments } = await VaultStore.readBackupLogins(filePath, backupCredentials);
      parsed = {
        logins,
        stats: {
          found: logins.length,
          nonLogin: 0,
          noPassword: 0,
          archived: 0,
          withTotp: logins.filter((login) => login.totp).length,
          totpNotImported: 0,
          attachmentsNotImported: attachments,
        },
      };
    } else {
      parsed = await parseImportFile(source, filePath, { fallbackName: tr("import.untitled") });
    }
    if (store !== state.vaultStore || !store.isUnlocked()) throw new Error("Unlock the vault first.");
    state.pendingImport = { source, filePath, logins: parsed.logins, store };
    return {
      canceled: false,
      fileName: path.basename(filePath),
      count: parsed.logins.length,
      stats: parsed.stats,
    };
  });

  registerHandler("import:commit", async () => {
    const pending = state.pendingImport;
    if (!pending?.logins || pending.store !== state.vaultStore) {
      throw new Error("Unlock the vault first.");
    }
    const { logins } = pending;
    pending.logins = null;
    const result = await pending.store.importLogins(logins);
    return { ...result, canTrashFile: pending.source !== "mnemo" };
  });

  registerHandler("import:trash-file", async () => {
    const pending = state.pendingImport;
    state.pendingImport = null;
    if (!pending || pending.source === "mnemo") return { trashed: false };
    await shell.trashItem(pending.filePath);
    return { trashed: true };
  });

  registerHandler("import:cancel", () => {
    state.pendingImport = null;
    return { canceled: true };
  });

  // Deletes the open vault's profile. Needs the master passphrase and a
  // native confirmation, so a compromised renderer cannot do it alone.
  registerHandler("vault:delete-active", async (passphrase) => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    store.requireUnlocked();
    await store.verifyPassphrase(passphrase);
    const profileName = await activeProfileName();
    const confirmation = await showVaultDialog({
      type: "warning",
      title: tr("dialog.deleteVaultTitle"),
      message: tr("dialog.deleteVaultMessage", { name: profileName }),
      detail: tr("dialog.deleteVaultDetail"),
      buttons: [tr("common.cancel"), tr("dialog.deleteVaultConfirm")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { deleted: false };
    if (store !== state.vaultStore || state.activeProfileId !== profileId) {
      throw new Error("Unlock the vault first.");
    }
    lockVault(false);
    state.activeProfileId = null;
    state.vaultStore = new VaultStore(state.profileManager.legacyVaultPath);
    await state.profileManager.deleteProfile(profileId);
    await state.biometricUnlock.disable(profileId).catch(() => {});
    return { deleted: true };
  });

  registerHandler("vault:restore-backup", async (credentials) => {
    const restoreCredentials = toRestoreCredentials(credentials);
    // Bind to the vault that was open when the request started; a profile
    // switch or lock while the dialogs are open cancels the restore.
    const store = state.vaultStore;
    const restoreEpoch = state.lockEpoch;
    const isStale = () => store !== state.vaultStore || state.lockEpoch !== restoreEpoch;
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.chooseBackupTitle"),
      buttonLabel: tr("dialog.chooseBackupButton"),
      properties: ["openFile"],
      filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true };
    }
    if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

    if ((await store.getStatus()).vaultExists) {
      const confirmation = await dialog.showMessageBox(state.mainWindow, {
        type: "warning",
        title: tr("dialog.replaceTitle"),
        message: tr("dialog.replaceMessage"),
        detail: tr("dialog.replaceDetail"),
        buttons: [tr("common.cancel"), tr("dialog.replaceConfirm")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { canceled: true };
    }
    if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

    await store.restoreBackup(selection.filePaths[0], restoreCredentials);
    const recoveryKey = store.takeIssuedRecoveryKey();
    // The restored file may use a different vault key than the one stored
    // for Touch ID.
    if (state.activeProfileId !== null) {
      await state.biometricUnlock.disable(state.activeProfileId).catch(() => {});
    }
    if (isStale()) {
      store.lock();
      throw new Error("Restore was interrupted because the vault was locked.");
    }
    if (recoveryKey) {
      state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
    }
    return { canceled: false, recoveryKey };
  });
}

module.exports = { register };
