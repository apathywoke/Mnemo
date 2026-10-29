// Update checks and downloads, and the update state shown in the renderer.

// Automatic checks wait at least this long after launch, wake, or a
// schedule change, so the network has time to come up.
const UPDATE_FIRST_CHECK_MS = 20_000;
const UPDATE_INTERVALS_MS = Object.freeze({
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

function createUpdates(ctx) {
  const { state, toIpcError } = ctx;
  const { app } = ctx.electron;

  function publicUpdateState() {
    // installBlocker() returns null when the app can update itself.
    const blocker = state.updater ? state.updater.installBlocker() : "notPackaged";
    return {
      ...state.updateState,
      currentVersion: app.getVersion(),
      canInstall: blocker === null,
      blocker,
      updateInterval: state.settingsStore?.get().updateInterval ?? "1d",
    };
  }

  // Plans the next automatic check from the last one (wall clock), so a new
  // interval applies at once and time asleep counts. Off, or with an update
  // already downloaded, nothing is planned.
  function scheduleUpdateCheck() {
    clearTimeout(state.updateTimer);
    state.updateTimer = null;
    const interval = UPDATE_INTERVALS_MS[state.settingsStore?.get().updateInterval];
    if (!interval || !state.updater || state.updateState.status === "ready") return;
    const due = state.updateState.checkedAt ? state.updateState.checkedAt + interval - Date.now() : 0;
    state.updateTimer = setTimeout(() => void checkForUpdates(), Math.max(due, UPDATE_FIRST_CHECK_MS));
    state.updateTimer.unref?.();
  }

  function setUpdateState(patch) {
    state.updateState = { ...state.updateState, ...patch };
    if (state.mainWindow && !state.mainWindow.isDestroyed() && !state.mainWindow.webContents.isDestroyed()) {
      state.mainWindow.webContents.send("updates:state", publicUpdateState());
    }
  }

  // One check or download at a time; a second request joins the first.
  function runUpdateTask(task) {
    if (!state.updateTask) {
      state.updateTask = task().finally(() => {
        state.updateTask = null;
      });
    }
    return state.updateTask;
  }

  function checkForUpdates() {
    return runUpdateTask(async () => {
      if (state.updateState.status === "ready") return publicUpdateState();
      setUpdateState({ status: "checking", error: null });
      try {
        const update = await state.updater.check();
        state.availableUpdate = update;
        setUpdateState(update
          ? { status: "available", version: update.version, notes: update.notes, checkedAt: Date.now() }
          : { status: "upToDate", version: null, notes: "", checkedAt: Date.now() });
      } catch (error) {
        setUpdateState({ status: "error", error: toIpcError(error).message, checkedAt: Date.now() });
      }
      scheduleUpdateCheck();
      return publicUpdateState();
    });
  }

  function downloadUpdate() {
    return runUpdateTask(async () => {
      if (!state.availableUpdate) throw new Error("No update is available for this Mac.");
      setUpdateState({ status: "downloading", progress: 0, error: null });
      try {
        await state.updater.download(state.availableUpdate, (received, total) => {
          const progress = total ? Math.floor((received / total) * 100) : 0;
          if (progress !== state.updateState.progress) setUpdateState({ progress });
        });
        setUpdateState({ status: "ready", progress: 100 });
        scheduleUpdateCheck();
      } catch (error) {
        setUpdateState({ status: "available", error: toIpcError(error).message });
        throw error;
      }
      return publicUpdateState();
    });
  }

  return { publicUpdateState, scheduleUpdateCheck, setUpdateState, checkForUpdates, downloadUpdate };
}

module.exports = { createUpdates };
