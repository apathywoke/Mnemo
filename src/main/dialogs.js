// Native dialogs that show vault data and close when the vault locks.

// Windows that show a secret close on their own, like the clipboard clears.
const REVEAL_DIALOG_MS = 30_000;

function createDialogs(ctx) {
  const { state, tr } = ctx;
  const { dialog } = ctx.electron;

  async function showVaultDialog(options, { closeAfterMs = 0 } = {}) {
    const controller = new AbortController();
    state.openVaultDialogs.add(controller);
    const timer = closeAfterMs ? setTimeout(() => controller.abort(), closeAfterMs) : null;
    try {
      return await dialog.showMessageBox(state.mainWindow, { ...options, signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
      state.openVaultDialogs.delete(controller);
    }
  }

  // A native window with one secret value. It is drawn by macOS, so the value
  // never enters the renderer, and it closes after REVEAL_DIALOG_MS or on lock.
  // "Copy" puts the value on the clipboard for 30 seconds, as the copy
  // buttons do; resolves { copied }.
  async function showSecretDialog({ entryName, fieldLabel, value }) {
    const epoch = state.lockEpoch;
    const { response } = await showVaultDialog({
      type: "none",
      title: entryName,
      // The value is alone in `detail` so selecting it copies nothing extra;
      // the auto-close note goes under the heading instead.
      message: `${entryName} · ${fieldLabel}\n${tr("dialog.revealCloses", { seconds: REVEAL_DIALOG_MS / 1000 })}`,
      detail: value,
      buttons: [tr("dialog.done"), tr("dialog.copy")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }, { closeAfterMs: REVEAL_DIALOG_MS });
    // A window closed by locking reports Done; the epoch check also covers
    // a click that raced with the lock.
    if (response !== 1 || state.lockEpoch !== epoch) return { copied: false };
    await ctx.copyToClipboardTemporarily(value);
    return { copied: true };
  }

  return { showVaultDialog, showSecretDialog };
}

module.exports = { createDialogs };
