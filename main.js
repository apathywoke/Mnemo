const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  powerMonitor,
  session,
} = require("electron");
const ProfileManager = require("./profile-manager");
const VaultStore = require("./vault-store");
const { fetchSiteFavicon, getFaviconHost } = require("./favicon-fetcher");

const APP_PAGE = path.join(__dirname, "index.html");
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30_000;
const COPYABLE_ENTRY_FIELDS = new Set(["username", "password"]);
// Chromium's remote debugging switches have no Electron fuse. A local process
// that relaunches the app with them could drive the unlocked renderer and call
// the preload API, so packaged builds refuse to start with them.
const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];
const launchedWithRemoteDebugging =
  app.isPackaged === true &&
  REMOTE_DEBUGGING_SWITCHES.some((name) => app.commandLine.hasSwitch(name));
const hasSingleInstanceLock =
  !launchedWithRemoteDebugging && app.requestSingleInstanceLock();
let mainWindow = null;
let vaultStore = null;
let profileManager = null;
let activeProfileId = null;
let lockEpoch = 0;
let autoLockTimer = null;
let clipboardClearTimer = null;
let ownedClipboardText = null;
let clipboardOperationQueue = Promise.resolve();
// Native dialogs that display vault data; lockVault() closes them so a revealed
// password does not stay on screen after the vault locks.
const openVaultDialogs = new Set();

async function showVaultDialog(options) {
  const controller = new AbortController();
  openVaultDialogs.add(controller);
  try {
    return await dialog.showMessageBox(mainWindow, { ...options, signal: controller.signal });
  } finally {
    openVaultDialogs.delete(controller);
  }
}

function enqueueClipboardOperation(operation) {
  const result = clipboardOperationQueue.then(operation);
  clipboardOperationQueue = result.catch(() => {});
  return result;
}

function clearAutoLockTimer() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
}

async function clearOwnedClipboardNow() {
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = null;

  const expectedText = ownedClipboardText;
  ownedClipboardText = null;

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
    ownedClipboardText = value;
    clipboardClearTimer = setTimeout(() => {
      void clearTemporaryClipboard();
    }, CLIPBOARD_CLEAR_MS);
    return { clearsAfterMs: CLIPBOARD_CLEAR_MS };
  });
}

function clearTemporaryClipboard() {
  return enqueueClipboardOperation(clearOwnedClipboardNow);
}

function lockVault(notifyRenderer = false) {
  lockEpoch += 1;
  const wasUnlocked = vaultStore?.isUnlocked() ?? false;
  clearAutoLockTimer();
  for (const controller of openVaultDialogs) controller.abort();
  openVaultDialogs.clear();
  clearTemporaryClipboard();
  vaultStore?.lock();

  if (
    notifyRenderer &&
    wasUnlocked &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send("vault:auto-locked");
  }
}

function resetAutoLockTimer() {
  clearAutoLockTimer();
  if (!vaultStore?.isUnlocked()) return;
  autoLockTimer = setTimeout(() => lockVault(true), AUTO_LOCK_MS);
}

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
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Mnemo",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  // WebRTC ICE traffic bypasses webRequest and CSP connect-src; keep it from
  // opening direct UDP connections (the session proxy below blocks the rest).
  mainWindow.webContents.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAppPage({ url: targetUrl })) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  mainWindow.on("closed", () => {
    lockVault(false);
    mainWindow = null;
  });

  mainWindow.webContents.on("before-input-event", resetAutoLockTimer);

  mainWindow.loadFile(APP_PAGE);
  return mainWindow;
}

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !isAppPage(event.senderFrame)
    ) {
      throw new Error("Rejected IPC request from an untrusted frame");
    }

    const result = await handler(...args);
    resetAutoLockTimer();
    return result;
  });
}

if (launchedWithRemoteDebugging) {
  app.exit(1);
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
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

    profileManager = new ProfileManager(app.getPath("userData"));
    vaultStore = new VaultStore(profileManager.legacyVaultPath);

    registerHandler("app:get-version", () => app.getVersion());
    registerHandler("profiles:choose", () => {
      lockVault(false);
      activeProfileId = null;
      vaultStore = new VaultStore(profileManager.legacyVaultPath);
      return profileManager.listProfiles();
    });
    registerHandler("profiles:select", async (profileId) => {
      const profile = await profileManager.getProfile(profileId);
      lockVault(false);
      vaultStore = new VaultStore(profileManager.getVaultPath(profile.id));
      activeProfileId = profile.id;
      return vaultStore.getStatus();
    });
    registerHandler("profiles:delete", async (profileId) => {
      if (activeProfileId !== null || vaultStore?.isUnlocked()) {
        throw new Error("Lock the current vault before deleting a profile.");
      }
      return profileManager.deleteProfile(profileId);
    });
    registerHandler("profiles:create", async (name, passphrase) => {
      if (activeProfileId !== null) {
        throw new Error("Choose the profile screen before creating a vault.");
      }
      lockVault(false);
      const creationEpoch = lockEpoch;
      const created = await profileManager.createProfile(name, passphrase);
      vaultStore = created.vaultStore;
      activeProfileId = created.profile.id;
      if (lockEpoch !== creationEpoch) {
        vaultStore.lock();
        throw new Error("The vault was created but remained locked.");
      }
      return { profile: created.profile, status: await vaultStore.getStatus() };
    });
    registerHandler("profiles:restore-new", async (name, passphrase) => {
      if (activeProfileId !== null) {
        throw new Error("Choose the profile screen before restoring a new vault.");
      }
      lockVault(false);
      const restoreEpoch = lockEpoch;
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "Choose encrypted backup",
        buttonLabel: "Choose Backup",
        properties: ["openFile"],
        filters: [{ name: "Encrypted Vault Backup", extensions: ["vault"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }
      if (lockEpoch !== restoreEpoch) {
        throw new Error("Restore was interrupted because the Mac was locked.");
      }

      const restored = await profileManager.restoreProfile(
        name,
        selection.filePaths[0],
        passphrase,
      );
      vaultStore = restored.vaultStore;
      activeProfileId = restored.profile.id;
      if (lockEpoch !== restoreEpoch) {
        vaultStore.lock();
        throw new Error("The backup was restored but the vault remained locked.");
      }
      return { canceled: false, profile: restored.profile };
    });
    registerHandler("vault:get-status", () => vaultStore.getStatus());
    registerHandler("vault:unlock", async (passphrase) => {
      const status = await vaultStore.unlock(passphrase);
      if (activeProfileId !== null) {
        await profileManager.markOpened(activeProfileId).catch(() => {});
      }
      return status;
    });
    // The renderer gets entry metadata only. Passwords are decrypted in this
    // process on an explicit copy or reveal and are never returned over IPC.
    registerHandler("vault:list-entries", () => vaultStore.listEntries());
    registerHandler("vault:get-entry", (entryId) => vaultStore.getEntry(entryId));
    registerHandler("vault:save-entry", (entry) =>
      vaultStore.saveEntry(entry),
    );
    registerHandler("vault:fetch-site-icon", async (entryId) => {
      if (!vaultStore.isUnlocked()) throw new Error("Unlock the vault first.");
      const entry = vaultStore.getEntry(entryId);
      if (!entry.url) {
        throw new Error("Add a website address to this login first.");
      }

      const hostname = getFaviconHost(entry.url);
      const confirmation = await showVaultDialog({
        type: "info",
        title: "Load website icon?",
        message: `Request the icon from ${hostname}?`,
        detail: `Mnemo will try https://${hostname}/favicon.ico first. If the icon is small or unavailable, it may read the site's homepage and try up to five PNG, JPEG, or ICO icon links hosted on the same domain, preferring higher-resolution variants. It follows only HTTPS redirects to the same host or its www variant (up to three). The site can see your IP address and these requests; your DNS resolver may also see the domain. No third-party favicon service is used.`,
        buttons: ["Cancel", "Load icon"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { canceled: true };

      const favicon = await fetchSiteFavicon(entry.url);
      const savedEntry = await vaultStore.saveFavicon(entry.id, favicon.dataUrl);
      return {
        canceled: false,
        entry: savedEntry,
        hostname: favicon.hostname,
      };
    });
    registerHandler("vault:delete-entry", (id) => vaultStore.deleteEntry(id));
    registerHandler("vault:copy-entry-field", (entryId, field) => {
      if (!COPYABLE_ENTRY_FIELDS.has(field)) {
        throw new Error("Could not copy this value.");
      }
      const value = field === "password"
        ? vaultStore.revealPassword(entryId)
        : vaultStore.getEntry(entryId).username;
      if (!value) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(value);
    });
    registerHandler("vault:reveal-password", async (entryId) => {
      const entry = vaultStore.getEntry(entryId);
      const password = vaultStore.revealPassword(entry.id);
      // Shown in a native dialog owned by the main process, so the plaintext
      // never enters the renderer's JavaScript heap or DOM.
      await showVaultDialog({
        type: "none",
        title: entry.name,
        message: entry.name,
        detail: password,
        buttons: ["Done"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return { shown: true };
    });
    registerHandler("vault:export-backup", async () => {
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: "Save encrypted backup",
        buttonLabel: "Save Backup",
        defaultPath: "Mnemo Backup.vault",
        filters: [{ name: "Encrypted Vault Backup", extensions: ["vault"] }],
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      await vaultStore.exportBackup(selection.filePath);
      return { canceled: false };
    });
    registerHandler("vault:restore-backup", async (passphrase) => {
      // Bind to the vault that was open when the request started; a profile
      // switch or lock while the dialogs are open cancels the restore.
      const store = vaultStore;
      const restoreEpoch = lockEpoch;
      const isStale = () => store !== vaultStore || lockEpoch !== restoreEpoch;
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "Choose encrypted backup",
        buttonLabel: "Choose Backup",
        properties: ["openFile"],
        filters: [{ name: "Encrypted Vault Backup", extensions: ["vault"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }
      if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

      if ((await store.getStatus()).vaultExists) {
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "Replace the current vault?",
          message: "Restoring will replace the vault on this Mac.",
          detail: "Create an encrypted backup of the current vault first if you may need it.",
          buttons: ["Cancel", "Replace Vault"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) return { canceled: true };
      }
      if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

      await store.restoreBackup(selection.filePaths[0], passphrase);
      if (isStale()) {
        store.lock();
        throw new Error("Restore was interrupted because the vault was locked.");
      }
      return { canceled: false };
    });
    registerHandler("vault:lock", () => {
      lockVault(false);
      return vaultStore.getStatus();
    });

    ipcMain.on("vault:activity", (event) => {
      if (
        event.senderFrame === event.sender.mainFrame &&
        isAppPage(event.senderFrame)
      ) {
        resetAutoLockTimer();
      }
    });

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
