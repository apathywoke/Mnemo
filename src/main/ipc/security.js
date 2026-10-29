// IPC handlers. Unlocking and locking, recovery keys, passphrase changes, and Touch ID.
const fs = require("node:fs/promises");

function register(ctx) {
  const {
    state,
    tr,
    activeProfileName,
    copyToClipboardTemporarily,
    lockVault,
    resetAutoLockTimer,
    isAppPage,
    registerHandler,
  } = ctx;
  const { dialog, ipcMain } = ctx.electron;

  registerHandler("vault:get-status", () => state.vaultStore.getStatus());

  registerHandler("vault:unlock", async (passphrase) => {
    const status = await state.vaultStore.unlock(passphrase);
    if (state.activeProfileId !== null) {
      await state.profileManager.markOpened(state.activeProfileId).catch(() => {});
    }
    return status;
  });

  // Every change of credentials replaces the vault key (VaultStore
  // rekeyNow), so a Touch ID file holds a key that no longer opens the
  // vault: it is removed, and Touch ID is turned on again by the user.
  async function forgetTouchIdKey(profileId) {
    if (profileId !== null) await state.biometricUnlock.disable(profileId).catch(() => {});
  }

  registerHandler("vault:recover", async (recoveryKey, newPassphrase) => {
    const recoveryEpoch = state.lockEpoch;
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    const result = await store.recoverWithKey(recoveryKey, newPassphrase);
    // The new key is on disk even if the vault locked meanwhile.
    await forgetTouchIdKey(profileId);
    if (store !== state.vaultStore || state.lockEpoch !== recoveryEpoch) {
      store.lock();
      throw new Error("Recovery was interrupted because the vault was locked.");
    }
    if (state.activeProfileId !== null) {
      await state.profileManager.markOpened(state.activeProfileId).catch(() => {});
    }
    state.pendingRecoveryKey = { key: result.recoveryKey, profileName: await activeProfileName() };
    return result;
  });

  registerHandler("vault:get-recovery-status", () => ({
    enabled: state.vaultStore.hasRecoveryKey(),
  }));

  registerHandler("vault:create-recovery-key", async (passphrase) => {
    const profileId = state.activeProfileId;
    const recoveryKey = await state.vaultStore.createRecoveryKey(passphrase);
    await forgetTouchIdKey(profileId);
    state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
    return { recoveryKey };
  });

  // A new master passphrase comes with a new recovery key, shown and
  // offered for backup like one created from Settings.
  registerHandler("vault:change-passphrase", async (currentPassphrase, newPassphrase) => {
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    const recoveryKey = await store.changePassphrase(currentPassphrase, newPassphrase);
    await forgetTouchIdKey(profileId);
    if (store !== state.vaultStore) throw new Error("Unlock the vault first.");
    state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
    return { recoveryKey };
  });

  registerHandler("recovery:copy", () => {
    if (!state.pendingRecoveryKey) throw new Error("Could not copy this value.");
    return copyToClipboardTemporarily(state.pendingRecoveryKey.key);
  });

  registerHandler("recovery:save", async () => {
    if (!state.pendingRecoveryKey) throw new Error("Could not save the recovery key.");
    const pending = state.pendingRecoveryKey;
    const selection = await dialog.showSaveDialog(state.mainWindow, {
      title: tr("dialog.saveRecoveryTitle"),
      buttonLabel: tr("dialog.saveRecoveryButton"),
      defaultPath: tr("dialog.recoveryFileName", {
        name: pending.profileName.replace(/[\\/:]/g, "-"),
      }),
      filters: [{ name: tr("dialog.recoveryFilter"), extensions: ["txt"] }],
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    if (state.pendingRecoveryKey !== pending) throw new Error("Could not save the recovery key.");
    const contents = [
      tr("recoveryFile.title"),
      "",
      `${tr("recoveryFile.vault")}: ${pending.profileName}`,
      `${tr("recoveryFile.created")}: ${new Date().toISOString().slice(0, 10)}`,
      "",
      pending.key,
      "",
      tr("recoveryFile.instructions"),
      "",
    ].join("\n");
    try {
      await fs.writeFile(selection.filePath, contents, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(selection.filePath, 0o600);
    } catch {
      throw new Error("Could not save the recovery key.");
    }
    return { canceled: false };
  });

  registerHandler("recovery:dismiss", () => {
    state.pendingRecoveryKey = null;
    return { dismissed: true };
  });

  // Touch ID unlock for the selected profile. Status works while locked so
  // the unlock screen can offer it.
  registerHandler("biometric:status", async () => ({
    available: state.biometricUnlock.isAvailable(),
    enabled: state.activeProfileId !== null && (await state.biometricUnlock.isEnabled(state.activeProfileId)),
  }));

  registerHandler("biometric:enable", async (passphrase) => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    store.requireUnlocked();
    await store.verifyPassphrase(passphrase);
    const dataKey = store.exportDataKey();
    try {
      await state.biometricUnlock.enable(
        profileId,
        dataKey,
        tr("biometric.reasonEnable", { name: await activeProfileName() }),
      );
    } finally {
      dataKey.fill(0);
    }
    return { enabled: true };
  });

  registerHandler("biometric:disable", async () => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    await state.biometricUnlock.disable(state.activeProfileId);
    return { enabled: false };
  });

  registerHandler("vault:unlock-biometric", async () => {
    if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
    const store = state.vaultStore;
    const profileId = state.activeProfileId;
    const unlockEpoch = state.lockEpoch;
    const dataKey = await state.biometricUnlock.releaseKey(
      profileId,
      tr("biometric.reasonUnlock", { name: await activeProfileName() }),
    );
    try {
      if (store !== state.vaultStore || state.lockEpoch !== unlockEpoch) {
        throw new Error("Unlock was interrupted because the vault was locked.");
      }
      let status;
      try {
        status = await store.unlockWithDataKey(dataKey);
      } catch (error) {
        // A key that no longer opens the file (restored from another
        // backup, for example) is removed so the button stops appearing.
        if (/^Touch ID can no longer/.test(error.message)) {
          await state.biometricUnlock.disable(profileId).catch(() => {});
        }
        throw error;
      }
      await state.profileManager.markOpened(profileId).catch(() => {});
      return status;
    } finally {
      dataKey.fill(0);
    }
  });

  registerHandler("vault:lock", () => {
    lockVault(false);
    return state.vaultStore.getStatus();
  });

  ipcMain.on("vault:activity", (event) => {
    if (
      event.senderFrame === event.sender.mainFrame &&
      isAppPage(event.senderFrame)
    ) {
      resetAutoLockTimer();
    }
  });
}

module.exports = { register };
