// IPC handlers. Copies of the open vault's snapshots in a folder outside this
// Mac (src/main/outside-copies.js). The folder is chosen in a native dialog
// here; the page never sends a path and sees only the folder's name.

function register(ctx) {
  const { state, tr, registerHandler } = ctx;
  const { dialog } = ctx.electron;

  function openVaultPath() {
    state.vaultStore.requireUnlocked();
    return state.vaultStore.filePath;
  }

  registerHandler("outside:get-status", async () => {
    await state.settingsLoaded;
    return state.outsideCopies.getStatus(openVaultPath());
  });

  registerHandler("outside:choose-folder", async () => {
    await state.settingsLoaded;
    const store = state.vaultStore;
    const vaultPath = openVaultPath();
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.outsideFolderTitle"),
      buttonLabel: tr("dialog.outsideFolderButton"),
      message: tr("dialog.outsideFolderMessage"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    const folder = selection.filePaths[0];
    const problem = await state.outsideCopies.folderProblem(folder);
    if (problem === "inside-data") throw new Error("Choose a folder outside Mnemo’s own data.");
    if (problem) throw new Error("Mnemo cannot use this folder. Choose another one.");
    await state.settingsStore.setOutsideFolder(folder);
    if (store !== state.vaultStore) throw new Error("Unlock the vault first.");
    await state.outsideCopies.copy(vaultPath);
    return { canceled: false, status: await state.outsideCopies.getStatus(vaultPath) };
  });

  // Stops copying. What is already in the folder stays there.
  registerHandler("outside:stop", async () => {
    await state.settingsLoaded;
    const vaultPath = openVaultPath();
    await state.settingsStore.setOutsideFolder(null);
    state.outsideCopies.cancelTimers();
    return state.outsideCopies.getStatus(vaultPath);
  });

  registerHandler("outside:copy-now", async () => {
    await state.settingsLoaded;
    const vaultPath = openVaultPath();
    await state.outsideCopies.copy(vaultPath);
    return state.outsideCopies.getStatus(vaultPath);
  });

  registerHandler("outside:dismiss-offer", async () => {
    await state.outsideCopies.dismissOffer(openVaultPath());
    return { dismissed: true };
  });
}

module.exports = { register };
