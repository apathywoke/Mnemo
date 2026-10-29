// Locking the vault, and the auto-lock timer.

const AUTO_LOCK_MS = 5 * 60 * 1000;

function createLock(ctx) {
  const { state, clearTemporaryClipboard } = ctx;

  function clearAutoLockTimer() {
    if (state.autoLockTimer) clearTimeout(state.autoLockTimer);
    state.autoLockTimer = null;
  }

  function lockVault(notifyRenderer = false) {
    state.lockEpoch += 1;
    const wasUnlocked = state.vaultStore?.isUnlocked() ?? false;
    clearAutoLockTimer();
    for (const controller of state.openVaultDialogs) controller.abort();
    state.pendingRecoveryKey = null;
    state.pendingImport = null;
    state.passwordHealthKey?.fill(0);
    state.passwordHealthKey = null;
    state.breachResults = null;
    state.breachCheckedAt = null;
    state.openVaultDialogs.clear();
    clearTemporaryClipboard();
    state.vaultStore?.lock();

    if (
      notifyRenderer &&
      wasUnlocked &&
      state.mainWindow &&
      !state.mainWindow.isDestroyed() &&
      !state.mainWindow.webContents.isDestroyed()
    ) {
      state.mainWindow.webContents.send("vault:auto-locked");
    }
  }

  function resetAutoLockTimer() {
    clearAutoLockTimer();
    if (!state.vaultStore?.isUnlocked()) return;
    state.autoLockTimer = setTimeout(() => lockVault(true), AUTO_LOCK_MS);
  }

  return { lockVault, resetAutoLockTimer };
}

module.exports = { createLock };
