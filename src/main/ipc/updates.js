// IPC handlers. Updates: state, check, download, install, and the check interval.

function register(ctx) {
  const {
    state,
    lockVault,
    registerHandler,
    publicUpdateState,
    scheduleUpdateCheck,
    setUpdateState,
    checkForUpdates,
    downloadUpdate,
  } = ctx;
  const { app, shell } = ctx.electron;

  // Update state changes do not count as user activity.
  registerHandler("updates:get-state", () => publicUpdateState(), { countsAsActivity: false });

  registerHandler("updates:check", () => checkForUpdates());

  registerHandler("updates:download", () => downloadUpdate());

  registerHandler("updates:install", async () => {
    // Lock first so no key material outlives the swap.
    lockVault(false);
    await state.updater.install();
    setImmediate(() => app.exit(0));
    return { relaunching: true };
  });

  registerHandler("updates:open-release", async () => {
    const url = state.availableUpdate?.releaseUrl ?? "https://github.com/apathywoke/Mnemo/releases/latest";
    if (!url.startsWith("https://github.com/apathywoke/Mnemo/releases/")) {
      throw new Error("The update server address is not allowed.");
    }
    await shell.openExternal(url);
    return { opened: true };
  });

  registerHandler("settings:set-update-interval", async (interval) => {
    await state.settingsLoaded;
    const settings = await state.settingsStore.setUpdateInterval(interval);
    scheduleUpdateCheck();
    setUpdateState({});
    return settings;
  });
}

module.exports = { register };
