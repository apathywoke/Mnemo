// IPC handlers. Profiles: choosing, creating, restoring, and deleting vaults.
const VaultStore = require("../../../vault-store");

function register(ctx) {
  const { state, tr, toRestoreCredentials, lockVault, registerHandler } = ctx;
  const { dialog } = ctx.electron;

  registerHandler("profiles:choose", () => {
    lockVault(false);
    state.activeProfileId = null;
    state.vaultStore = new VaultStore(state.profileManager.legacyVaultPath);
    return state.profileManager.listProfiles();
  });

  registerHandler("profiles:select", async (profileId) => {
    const profile = await state.profileManager.getProfile(profileId);
    lockVault(false);
    state.vaultStore = new VaultStore(state.profileManager.getVaultPath(profile.id));
    state.activeProfileId = profile.id;
    return state.vaultStore.getStatus();
  });

  registerHandler("profiles:delete", async (profileId) => {
    if (state.activeProfileId !== null || state.vaultStore?.isUnlocked()) {
      throw new Error("Lock the current vault before deleting a profile.");
    }
    const deleted = await state.profileManager.deleteProfile(profileId);
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
    state.pendingRecoveryKey = { key: recoveryKey, profileName: created.profile.name };
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
      state.pendingRecoveryKey = { key: recoveryKey, profileName: restored.profile.name };
    }
    return { canceled: false, profile: restored.profile, recoveryKey };
  });
}

module.exports = { register };
