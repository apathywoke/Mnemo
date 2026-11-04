// IPC handlers. Restoring a vault from a snapshot: one of its own (on this
// Mac or in the folder outside it), or, as a new vault, one from a snapshot
// folder the user picks (another Mac's copies). The page sends snapshot IDs
// from the lists below, never paths.
const { listForVault, snapshotFoldersIn, listForFolders, resolveSnapshot } = require("../snapshot-sources");

function register(ctx) {
  const { state, tr, toRestoreCredentials, lockVault, issueRecoveryKey, registerHandler } = ctx;
  const { dialog } = ctx.electron;

  const outsideFolder = () => state.settingsStore.getOutsideFolder();

  // Works while locked: the list holds times and labels only.
  registerHandler("snapshots:list", async () => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    await state.settingsLoaded;
    return listForVault(state.vaultStore.filePath, outsideFolder());
  });

  registerHandler("snapshots:restore", async (id, credentials) => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    await state.settingsLoaded;
    const restoreCredentials = toRestoreCredentials(credentials);
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    const restoreEpoch = state.lockEpoch;
    const isStale = () => store !== state.vaultStore || state.lockEpoch !== restoreEpoch;
    const source = resolveSnapshot(id, { vaultPath: store.filePath, outsideFolder: outsideFolder() });

    if ((await store.getStatus()).vaultExists) {
      const confirmation = await dialog.showMessageBox(state.mainWindow, {
        type: "warning",
        title: tr("dialog.replaceTitle"),
        message: tr("dialog.restoreSnapshotMessage"),
        detail: tr("dialog.restoreSnapshotDetail"),
        buttons: [tr("common.cancel"), tr("dialog.replaceConfirm")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { canceled: true };
    }
    if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

    // A local snapshot is pinned first, so the snapshot of the current state
    // taken by the restore cannot rotate it away; a copy outside is read
    // while nothing else writes to that folder.
    if (source.localName) await store.keepSnapshotForRestore(source.localName);
    const restore = () => store.restoreBackup(source.file, restoreCredentials, { poolDirectory: source.poolDirectory });
    if (source.localName) await restore();
    else await state.outsideCopies.enqueue(store.filePath, restore);

    const recoveryKey = store.takeIssuedRecoveryKey();
    // The restored file may use a different vault key than the one stored
    // for Touch ID.
    await state.biometricUnlock.disable(profileId).catch(() => {});
    if (isStale()) {
      store.lock();
      throw new Error("Restore was interrupted because the vault was locked.");
    }
    if (recoveryKey) await issueRecoveryKey(recoveryKey);
    return { canceled: false, recoveryKey };
  });

  // On the profile screen: the user picks a folder of snapshots (the copies
  // another Mac made, or a vault's own snapshot folder).
  registerHandler("snapshots:choose-folder", async () => {
    if (state.activeProfileId !== null) {
      throw new Error("Choose the profile screen before restoring a new vault.");
    }
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.snapshotFolderTitle"),
      buttonLabel: tr("dialog.snapshotFolderButton"),
      message: tr("dialog.snapshotFolderMessage"),
      properties: ["openDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    const found = await snapshotFoldersIn(selection.filePaths[0]);
    state.pickedSnapshotFolders = found.map(({ directory }) => directory);
    return { canceled: false, snapshots: listForFolders(found) };
  });

  registerHandler("profiles:restore-snapshot", async (name, id, credentials) => {
    const restoreCredentials = toRestoreCredentials(credentials);
    if (state.activeProfileId !== null) {
      throw new Error("Choose the profile screen before restoring a new vault.");
    }
    const source = resolveSnapshot(id, { pickedFolders: state.pickedSnapshotFolders });
    lockVault(false);
    const restoreEpoch = state.lockEpoch;
    const restored = await state.profileManager.restoreProfile(name, source.file, restoreCredentials, {
      poolDirectory: source.poolDirectory,
    });
    state.pickedSnapshotFolders = [];
    state.vaultStore = restored.vaultStore;
    state.activeProfileId = restored.profile.id;
    const recoveryKey = state.vaultStore.takeIssuedRecoveryKey();
    if (state.lockEpoch !== restoreEpoch) {
      state.vaultStore.lock();
      throw new Error("The backup was restored but the vault remained locked.");
    }
    if (recoveryKey) await issueRecoveryKey(recoveryKey, restored.profile.name);
    return { profile: restored.profile, recoveryKey };
  });
}

module.exports = { register };
