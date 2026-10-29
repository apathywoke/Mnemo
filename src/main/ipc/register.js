// IPC handlers: only the app's own page may call them.

function createRegisterHandler(ctx) {
  const { toIpcError, resetAutoLockTimer, isAppPage } = ctx;
  const { ipcMain } = ctx.electron;

  // `countsAsActivity: false` is for background refreshes (one-time codes)
  // that must not keep an idle vault unlocked.
  function registerHandler(channel, handler, { countsAsActivity = true } = {}) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (
          event.senderFrame !== event.sender.mainFrame ||
          !isAppPage(event.senderFrame)
        ) {
          throw new Error("Rejected IPC request from an untrusted frame");
        }

        const result = await handler(...args);
        if (countsAsActivity) resetAutoLockTimer();
        return result;
      } catch (error) {
        throw toIpcError(error);
      }
    });
  }

  return { registerHandler };
}

module.exports = { createRegisterHandler };
