const path = require("node:path");
const electron = require("electron");
const {
  app,
  BrowserWindow,
  nativeTheme,
  powerMonitor,
  safeStorage,
  session,
  systemPreferences,
} = electron;
const ProfileManager = require("./profile-manager");
const SettingsStore = require("./settings-store");
const BiometricUnlock = require("./biometric-unlock");
const { Updater } = require("./updater");
const i18nCatalog = require("./src/renderer/shared/i18n/messages");
const { createTranslator } = require("./src/renderer/shared/i18n/translate");
const VaultStore = require("./vault-store");
const { createState } = require("./src/main/state");
const { createTranslation } = require("./src/main/i18n");
const { createProfileHelpers } = require("./src/main/profiles");
const { createDialogs } = require("./src/main/dialogs");
const { createClipboard } = require("./src/main/clipboard");
const { createLock } = require("./src/main/lock");
const { createWindowManager } = require("./src/main/window");
const { createRegisterHandler } = require("./src/main/ipc/register");
const { createUpdates } = require("./src/main/updates");
const IPC_GROUPS = [
  require("./src/main/ipc/updates"),
  require("./src/main/ipc/settings"),
  require("./src/main/ipc/profiles"),
  require("./src/main/ipc/security"),
  require("./src/main/ipc/entries"),
  require("./src/main/ipc/organize"),
  require("./src/main/ipc/reports"),
  require("./src/main/ipc/backup"),
];

// Chromium's remote debugging switches have no Electron fuse. A local process
// that relaunches the app with them could drive the unlocked renderer and call
// the preload API, so packaged builds refuse to start with them.
const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];
const launchedWithRemoteDebugging =
  app.isPackaged === true &&
  REMOTE_DEBUGGING_SWITCHES.some((name) => app.commandLine.hasSwitch(name));
// The data folder (vaults, settings, Touch ID files) is fixed instead of
// following package.json "name"/"productName", so renaming the package
// cannot strand existing vaults. Set before the single-instance lock, which
// lives in this folder. --user-data-dir (used for test builds) still wins.
// The Keychain item of safeStorage still follows the app name; see
// docs/RELEASING.md before renaming.
const USER_DATA_FOLDER = "local-vault-prototype";
if (!app.commandLine?.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), USER_DATA_FOLDER));
}
const hasSingleInstanceLock =
  !launchedWithRemoteDebugging && app.requestSingleInstanceLock();
const translator = createTranslator(i18nCatalog);

const state = createState(translator);
const ctx = { state, translator, electron };
Object.assign(ctx, createTranslation(ctx));
Object.assign(ctx, createProfileHelpers(ctx));
Object.assign(ctx, createDialogs(ctx));
Object.assign(ctx, createClipboard(ctx));
Object.assign(ctx, createLock(ctx));
Object.assign(ctx, createWindowManager(ctx));
Object.assign(ctx, createRegisterHandler(ctx));
Object.assign(ctx, createUpdates(ctx));
const { lockVault, createWindow, scheduleUpdateCheck } = ctx;

if (launchedWithRemoteDebugging) {
  app.exit(1);
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!state.mainWindow) return;
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.focus();
  });

  app.whenReady().then(() => {
    // `npm start` runs the stock Electron.app; give its Dock tile Mnemo's
    // icon. Packaged builds carry the icon (and the name) in the bundle.
    if (!app.isPackaged) app.dock?.setIcon?.(path.join(__dirname, "build", "icon.png"));

    // Keep remote access disabled in the renderer; favicon retrieval is a separate,
    // explicit user action handled by the main process with host validation.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );

    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    // Without a check handler Electron reports every permission (including
    // clipboard-read) as granted to synchronous checks.
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setDevicePermissionHandler?.(() => false);
    // The renderer never needs the network. Route any Chromium traffic that
    // escapes webRequest (WebRTC TURN/STUN over TCP) to a closed local port.
    // The favicon fetcher uses Node's https module and is unaffected.
    void session.defaultSession.setProxy?.({ proxyRules: "socks5://127.0.0.1:9" });

    powerMonitor.on("lock-screen", () => lockVault(true));
    powerMonitor.on("suspend", () => lockVault(true));

    state.profileManager = new ProfileManager(app.getPath("userData"));
    state.vaultStore = new VaultStore(state.profileManager.legacyVaultPath);
    state.biometricUnlock = new BiometricUnlock(app.getPath("userData"), {
      safeStorage,
      systemPreferences,
    });

    state.settingsStore = new SettingsStore(app.getPath("userData"), {
      isSupportedLanguage: translator.isSupported,
      defaultLanguage: translator.pickLanguage(app.getPreferredSystemLanguages?.()),
    });
    // nativeTheme drives both the native dialogs and the renderer's
    // prefers-color-scheme, so "system" follows macOS automatically.
    state.settingsLoaded = state.settingsStore.load().then((settings) => {
      state.language = settings.language;
      if (nativeTheme) nativeTheme.themeSource = settings.theme;
    });

    state.updater = new Updater({
      currentVersion: app.getVersion(),
      keysDirectory: path.join(__dirname, "build", "update-keys"),
      isPackaged: app.isPackaged,
      tempDirectory: app.getPath("temp"),
    });
    void state.updater.cleanUpLeftovers();
    void state.settingsLoaded.then(() => scheduleUpdateCheck());
    // Timers stand still while the Mac sleeps; re-plan from the clock.
    powerMonitor.on("resume", () => scheduleUpdateCheck());

    for (const group of IPC_GROUPS) group.register(ctx);

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    lockVault(false);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
