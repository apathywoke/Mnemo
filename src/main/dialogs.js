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
  function showSecretDialog({ entryName, fieldLabel, value }) {
    return showVaultDialog({
      type: "none",
      title: entryName,
      // The value is alone in `detail` so selecting it copies nothing extra;
      // the auto-close note goes under the heading instead.
      message: `${entryName} · ${fieldLabel}\n${tr("dialog.revealCloses", { seconds: REVEAL_DIALOG_MS / 1000 })}`,
      detail: value,
      buttons: [tr("dialog.done")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }, { closeAfterMs: REVEAL_DIALOG_MS });
  }

  return { showVaultDialog, showSecretDialog };
}

module.exports = { createDialogs };
