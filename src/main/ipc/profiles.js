// IPC handlers. Profiles: choosing, creating, restoring, and deleting vaults.

function register(ctx) {
  const { state, tr, toRestoreCredentials, lockVault, issueRecoveryKey, registerHandler, confirmDeletingSnapshots } = ctx;
  const { dialog } = ctx.electron;

  registerHandler("profiles:choose", () => {
    lockVault(false);
    state.activeProfileId = null;
    state.vaultStore = state.profileManager.createStore(state.profileManager.legacyVaultPath);
    return state.profileManager.listProfiles();
  });

  registerHandler("profiles:select", async (profileId) => {
    const profile = await state.profileManager.getProfile(profileId);
    lockVault(false);
    state.vaultStore = state.profileManager.createStore(state.profileManager.getVaultPath(profile.id));
    state.activeProfileId = profile.id;
    return state.vaultStore.getStatus();
  });

  registerHandler("profiles:delete", async (profileId) => {
    if (state.activeProfileId !== null || state.vaultStore?.isUnlocked()) {
      throw new Error("Lock the current vault before deleting a profile.");
    }
    const profile = await state.profileManager.getProfile(profileId);
    // A native confirmation, so a compromised renderer cannot delete a vault
    // alone: its own type-the-name dialog is no barrier to it.
    const epoch = state.lockEpoch;
    const isStale = () => state.activeProfileId !== null || state.vaultStore?.isUnlocked() || state.lockEpoch !== epoch;
    const confirmation = await dialog.showMessageBox(state.mainWindow, {
      type: "warning",
      title: tr("dialog.deleteVaultTitle"),
      message: tr("dialog.deleteVaultMessage", { name: profile.name }),
      detail: tr("dialog.deleteVaultDetail"),
      buttons: [tr("common.cancel"), tr("dialog.deleteVaultConfirm")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { deleted: false };
    if (isStale()) throw new Error("Lock the current vault before deleting a profile.");
    const deleteSnapshots = await confirmDeletingSnapshots(profile);
    if (isStale()) throw new Error("Lock the current vault before deleting a profile.");
    const deleted = await state.profileManager.deleteProfile(profileId, { deleteSnapshots });
    await state.biometricUnlock.disable(profileId).catch(() => {});
    return deleted;
  });

  registerHandler("profiles:create", async (name, passphrase) => {
    if (state.activeProfileId !== null) {
      throw new Error("Choose the profile screen before creating a vault.");
    }
    lockVault(false);
    const creationEpoch = state.lockEpoch;
    const created = await state.profileManager.createProfile(name, passphrase);
    const recoveryKey = created.vaultStore.takeIssuedRecoveryKey();
    if (state.lockEpoch !== creationEpoch || !recoveryKey) {
      // The user never saw this vault's recovery key, so remove the new,
      // still empty vault instead of leaving one without a known key.
      created.vaultStore.lock();
      await state.profileManager.deleteProfile(created.profile.id).catch(() => {});
      throw new Error("Creation was interrupted because the vault was locked.");
    }
    state.vaultStore = created.vaultStore;
    state.activeProfileId = created.profile.id;
    await issueRecoveryKey(recoveryKey, created.profile.name);
    return { profile: created.profile, status: await state.vaultStore.getStatus(), recoveryKey };
  });

  registerHandler("profiles:restore-new", async (name, credentials) => {
    const restoreCredentials = toRestoreCredentials(credentials);
    if (state.activeProfileId !== null) {
      throw new Error("Choose the profile screen before restoring a new vault.");
    }
    lockVault(false);
    const restoreEpoch = state.lockEpoch;
    const selection = await dialog.showOpenDialog(state.mainWindow, {
      title: tr("dialog.chooseBackupTitle"),
      buttonLabel: tr("dialog.chooseBackupButton"),
      properties: ["openFile"],
      filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true };
    }
    if (state.lockEpoch !== restoreEpoch) {
      throw new Error("Restore was interrupted because the Mac was locked.");
    }

    const restored = await state.profileManager.restoreProfile(
      name,
      selection.filePaths[0],
      restoreCredentials,
    );
    state.vaultStore = restored.vaultStore;
    state.activeProfileId = restored.profile.id;
    const recoveryKey = state.vaultStore.takeIssuedRecoveryKey();
    if (state.lockEpoch !== restoreEpoch) {
      state.vaultStore.lock();
      throw new Error("The backup was restored but the vault remained locked.");
    }
    if (recoveryKey) {
      await issueRecoveryKey(recoveryKey, restored.profile.name);
    }
    return { canceled: false, profile: restored.profile, recoveryKey };
  });
}

module.exports = { register };
