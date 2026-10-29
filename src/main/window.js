// The app window and the check that a frame is the app's own page.
const path = require("node:path");
const { fileURLToPath } = require("node:url");

// main.js and index.html are two folders up.
const APP_ROOT = path.join(__dirname, "..", "..");
const APP_PAGE = path.join(APP_ROOT, "index.html");

function createWindowManager(ctx) {
  const { state, lockVault, resetAutoLockTimer } = ctx;
  const { app, BrowserWindow } = ctx.electron;

  function isAppPage(frame) {
    if (!frame) return false;

    try {
      const url = new URL(frame.url);
      return url.protocol === "file:" && fileURLToPath(url) === APP_PAGE;
    } catch {
      return false;
    }
  }

  function createWindow() {
    state.mainWindow = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: "Mnemo",
      webPreferences: {
        preload: path.join(APP_ROOT, "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });

    // WebRTC ICE traffic bypasses webRequest and CSP connect-src; keep it from
    // opening direct UDP connections (the session proxy below blocks the rest).
    state.mainWindow.webContents.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
    state.mainWindow.once("ready-to-show", () => state.mainWindow.show());
    state.mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    state.mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isAppPage({ url: targetUrl })) event.preventDefault();
    });
    state.mainWindow.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    state.mainWindow.on("closed", () => {
      lockVault(false);
      state.mainWindow = null;
    });

    state.mainWindow.webContents.on("before-input-event", resetAutoLockTimer);

    state.mainWindow.loadFile(APP_PAGE);
    return state.mainWindow;
  }

  return { isAppPage, createWindow };
}

module.exports = { createWindowManager };
