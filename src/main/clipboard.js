// Copying secrets to the clipboard and clearing them again.

const CLIPBOARD_CLEAR_MS = 30_000;

function createClipboard(ctx) {
  const { state } = ctx;
  const { clipboard } = ctx.electron;

  function enqueueClipboardOperation(operation) {
    const result = state.clipboardOperationQueue.then(operation);
    state.clipboardOperationQueue = result.catch(() => {});
    return result;
  }

  async function clearOwnedClipboardNow() {
    if (state.clipboardClearTimer) clearTimeout(state.clipboardClearTimer);
    state.clipboardClearTimer = null;

    const expectedText = state.ownedClipboardText;
    state.ownedClipboardText = null;

    if (expectedText !== null) {
      try {
        if ((await clipboard.readText()) === expectedText) {
          await clipboard.clear();
        }
      } catch {
        // Clipboard cleanup is best-effort if macOS denies access or exits.
      }
    }
  }

  function copyToClipboardTemporarily(value) {
    return enqueueClipboardOperation(async () => {
      await clearOwnedClipboardNow();
      await clipboard.writeText(value);
      state.ownedClipboardText = value;
      state.clipboardClearTimer = setTimeout(() => {
        void clearTemporaryClipboard();
      }, CLIPBOARD_CLEAR_MS);
      return { clearsAfterMs: CLIPBOARD_CLEAR_MS };
    });
  }

  function clearTemporaryClipboard() {
    return enqueueClipboardOperation(clearOwnedClipboardNow);
  }

  return { copyToClipboardTemporarily, clearTemporaryClipboard };
}

module.exports = { createClipboard };
