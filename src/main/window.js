// The app window, the app:// handler that serves its page, and the check
// that a frame is the app's own page.
const path = require("node:path");
const {
  APP_SCHEME,
  APP_PAGE_URL,
  createAppFileHandler,
  isAppPageUrl,
} = require("./app-protocol");

// main.js and index.html are two folders up.
const APP_ROOT = path.join(__dirname, "..", "..");

function createWindowManager(ctx) {
  const { state, lockVault, resetAutoLockTimer } = ctx;
  const { app, BrowserWindow, protocol } = ctx.electron;

  // Serves app://mnemo/ from the app folder (app.asar when packaged). Called
  // once the app is ready, before the first window.
  function registerAppProtocol() {
    protocol.handle(APP_SCHEME, createAppFileHandler(APP_ROOT));
  }

  // Only app://mnemo/index.html; the same page under file:// is not trusted.
  function isAppPage(frame) {
    return Boolean(frame) && isAppPageUrl(frame.url);
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
    // The page never navigates; anything other than reloading itself (an
    // external site, file://) is refused.
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

    state.mainWindow.loadURL(APP_PAGE_URL);
    return state.mainWindow;
  }

  return { isAppPage, createWindow, registerAppProtocol };
}

module.exports = { createWindowManager };
