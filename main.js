const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} = require("electron");
const ProfileManager = require("./profile-manager");
const SettingsStore = require("./settings-store");
const BiometricUnlock = require("./biometric-unlock");
const { parseImportFile } = require("./importers");
const { ITEM_TYPES } = require("./src/renderer/shared/item-types");
const cardTools = require("./src/renderer/shared/lib/card-tools");
const i18nCatalog = require("./src/renderer/shared/i18n/messages");
const { createTranslator, encodeIpcError } = require("./src/renderer/shared/i18n/translate");
const VaultStore = require("./vault-store");
const { fetchSiteFavicon, getFaviconHost } = require("./favicon-fetcher");

const APP_PAGE = path.join(__dirname, "index.html");
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30_000;
// Windows that show a secret close on their own, like the clipboard clears.
const REVEAL_DIALOG_MS = 30_000;
const COPYABLE_ENTRY_FIELDS = new Set(["username", "password", "totp"]);
// Chromium's remote debugging switches have no Electron fuse. A local process
// that relaunches the app with them could drive the unlocked renderer and call
// the preload API, so packaged builds refuse to start with them.
const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];
const launchedWithRemoteDebugging =
  app.isPackaged === true &&
  REMOTE_DEBUGGING_SWITCHES.some((name) => app.commandLine.hasSwitch(name));
const hasSingleInstanceLock =
  !launchedWithRemoteDebugging && app.requestSingleInstanceLock();
const translator = createTranslator(i18nCatalog);
let language = translator.defaultLanguage;
let settingsStore = null;
let biometricUnlock = null;
let settingsLoaded = Promise.resolve();
let mainWindow = null;
let vaultStore = null;
let profileManager = null;
let activeProfileId = null;
let lockEpoch = 0;
let autoLockTimer = null;
let clipboardClearTimer = null;
let ownedClipboardText = null;
let clipboardOperationQueue = Promise.resolve();
// The recovery key most recently issued, kept only until the user confirms it
// is saved (or the vault locks) so that copy and save work without the
// renderer sending it back.
let pendingRecoveryKey = null;
// A parsed import waiting for the user's confirmation. The logins hold plain
// passwords, so they are dropped on commit, cancel, or lock.
let pendingImport = null;
const IMPORT_SOURCES = Object.freeze({
  bitwarden: { filterKey: "dialog.importFilterBitwarden", extensions: ["json", "csv"] },
  onepassword: { filterKey: "dialog.importFilterOnePassword", extensions: ["1pux", "csv"] },
  mnemo: { filterKey: "dialog.backupFilter", extensions: ["vault"] },
});
// Native dialogs that display vault data; lockVault() closes them so a revealed
// password does not stay on screen after the vault locks.
const openVaultDialogs = new Set();

async function showVaultDialog(options, { closeAfterMs = 0 } = {}) {
  const controller = new AbortController();
  openVaultDialogs.add(controller);
  const timer = closeAfterMs ? setTimeout(() => controller.abort(), closeAfterMs) : null;
  try {
    return await dialog.showMessageBox(mainWindow, { ...options, signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
    openVaultDialogs.delete(controller);
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

function tr(key, params) {
  return translator.t(language, key, params);
}

// Main-process modules throw English messages; send the renderer a translated
// message tagged with its key. Unrecognized errors get a generic message so
// internal details do not reach the UI.
function toIpcError(error) {
  const match = translator.matchError(error?.message);
  const key = match?.key ?? "errors.unknown";
  return new Error(encodeIpcError(key, tr(key, match?.params)));
}

// Restore credentials from the renderer: the backup's passphrase, or a
// recovery key with a new passphrase. Only known fields are passed on.
function toRestoreCredentials(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    return { recoveryKey: value.recoveryKey, newPassphrase: value.newPassphrase };
  }
  throw new Error("Enter a master passphrase.");
}

async function activeProfileName() {
  if (activeProfileId === null) return "Mnemo";
  try {
    return (await profileManager.getProfile(activeProfileId)).name;
  } catch {
    return "Mnemo";
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
  pendingRecoveryKey = null;
  pendingImport = null;
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
    biometricUnlock = new BiometricUnlock(app.getPath("userData"), {
      safeStorage,
      systemPreferences,
    });

    settingsStore = new SettingsStore(app.getPath("userData"), {
      isSupportedLanguage: translator.isSupported,
      defaultLanguage: translator.pickLanguage(app.getPreferredSystemLanguages?.()),
    });
    // nativeTheme drives both the native dialogs and the renderer's
    // prefers-color-scheme, so "system" follows macOS automatically.
    settingsLoaded = settingsStore.load().then((settings) => {
      language = settings.language;
      if (nativeTheme) nativeTheme.themeSource = settings.theme;
    });

    registerHandler("app:get-version", () => app.getVersion());
    registerHandler("settings:get", async () => {
      await settingsLoaded;
      return settingsStore.get();
    });
    registerHandler("settings:set-theme", async (theme) => {
      await settingsLoaded;
      const settings = await settingsStore.setTheme(theme);
      if (nativeTheme) nativeTheme.themeSource = settings.theme;
      return settings;
    });
    registerHandler("settings:set-language", async (code) => {
      await settingsLoaded;
      const settings = await settingsStore.setLanguage(code);
      language = settings.language;
      return settings;
    });
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
      const deleted = await profileManager.deleteProfile(profileId);
      await biometricUnlock.disable(profileId).catch(() => {});
      return deleted;
    });
    registerHandler("profiles:create", async (name, passphrase) => {
      if (activeProfileId !== null) {
        throw new Error("Choose the profile screen before creating a vault.");
      }
      lockVault(false);
      const creationEpoch = lockEpoch;
      const created = await profileManager.createProfile(name, passphrase);
      const recoveryKey = created.vaultStore.takeIssuedRecoveryKey();
      if (lockEpoch !== creationEpoch || !recoveryKey) {
        // The user never saw this vault's recovery key, so remove the new,
        // still empty vault instead of leaving one without a known key.
        created.vaultStore.lock();
        await profileManager.deleteProfile(created.profile.id).catch(() => {});
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      vaultStore = created.vaultStore;
      activeProfileId = created.profile.id;
      pendingRecoveryKey = { key: recoveryKey, profileName: created.profile.name };
      return { profile: created.profile, status: await vaultStore.getStatus(), recoveryKey };
    });
    registerHandler("profiles:restore-new", async (name, credentials) => {
      const restoreCredentials = toRestoreCredentials(credentials);
      if (activeProfileId !== null) {
        throw new Error("Choose the profile screen before restoring a new vault.");
      }
      lockVault(false);
      const restoreEpoch = lockEpoch;
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: tr("dialog.chooseBackupTitle"),
        buttonLabel: tr("dialog.chooseBackupButton"),
        properties: ["openFile"],
        filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
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
        restoreCredentials,
      );
      vaultStore = restored.vaultStore;
      activeProfileId = restored.profile.id;
      const recoveryKey = vaultStore.takeIssuedRecoveryKey();
      if (lockEpoch !== restoreEpoch) {
        vaultStore.lock();
        throw new Error("The backup was restored but the vault remained locked.");
      }
      if (recoveryKey) {
        pendingRecoveryKey = { key: recoveryKey, profileName: restored.profile.name };
      }
      return { canceled: false, profile: restored.profile, recoveryKey };
    });
    registerHandler("vault:get-status", () => vaultStore.getStatus());
    registerHandler("vault:unlock", async (passphrase) => {
      const status = await vaultStore.unlock(passphrase);
      if (activeProfileId !== null) {
        await profileManager.markOpened(activeProfileId).catch(() => {});
      }
      return status;
    });
    registerHandler("vault:recover", async (recoveryKey, newPassphrase) => {
      const recoveryEpoch = lockEpoch;
      const store = vaultStore;
      const result = await store.recoverWithKey(recoveryKey, newPassphrase);
      if (store !== vaultStore || lockEpoch !== recoveryEpoch) {
        store.lock();
        throw new Error("Recovery was interrupted because the vault was locked.");
      }
      if (activeProfileId !== null) {
        await profileManager.markOpened(activeProfileId).catch(() => {});
      }
      pendingRecoveryKey = { key: result.recoveryKey, profileName: await activeProfileName() };
      return result;
    });
    registerHandler("vault:get-recovery-status", () => ({
      enabled: vaultStore.hasRecoveryKey(),
    }));
    registerHandler("vault:create-recovery-key", async (passphrase) => {
      const recoveryKey = await vaultStore.createRecoveryKey(passphrase);
      pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
      return { recoveryKey };
    });
    registerHandler("recovery:copy", () => {
      if (!pendingRecoveryKey) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(pendingRecoveryKey.key);
    });
    registerHandler("recovery:save", async () => {
      if (!pendingRecoveryKey) throw new Error("Could not save the recovery key.");
      const pending = pendingRecoveryKey;
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: tr("dialog.saveRecoveryTitle"),
        buttonLabel: tr("dialog.saveRecoveryButton"),
        defaultPath: tr("dialog.recoveryFileName", {
          name: pending.profileName.replace(/[\\/:]/g, "-"),
        }),
        filters: [{ name: tr("dialog.recoveryFilter"), extensions: ["txt"] }],
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      if (pendingRecoveryKey !== pending) throw new Error("Could not save the recovery key.");
      const contents = [
        tr("recoveryFile.title"),
        "",
        `${tr("recoveryFile.vault")}: ${pending.profileName}`,
        `${tr("recoveryFile.created")}: ${new Date().toISOString().slice(0, 10)}`,
        "",
        pending.key,
        "",
        tr("recoveryFile.instructions"),
        "",
      ].join("\n");
      try {
        await fs.writeFile(selection.filePath, contents, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(selection.filePath, 0o600);
      } catch {
        throw new Error("Could not save the recovery key.");
      }
      return { canceled: false };
    });
    registerHandler("recovery:dismiss", () => {
      pendingRecoveryKey = null;
      return { dismissed: true };
    });
    // Touch ID unlock for the selected profile. Status works while locked so
    // the unlock screen can offer it.
    registerHandler("biometric:status", async () => ({
      available: biometricUnlock.isAvailable(),
      enabled: activeProfileId !== null && (await biometricUnlock.isEnabled(activeProfileId)),
    }));
    registerHandler("biometric:enable", async (passphrase) => {
      if (activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = vaultStore;
      const profileId = activeProfileId;
      store.requireUnlocked();
      await store.verifyPassphrase(passphrase);
      const dataKey = store.exportDataKey();
      try {
        await biometricUnlock.enable(
          profileId,
          dataKey,
          tr("biometric.reasonEnable", { name: await activeProfileName() }),
        );
      } finally {
        dataKey.fill(0);
      }
      return { enabled: true };
    });
    registerHandler("biometric:disable", async () => {
      if (activeProfileId === null) throw new Error("Choose a valid vault profile.");
      await biometricUnlock.disable(activeProfileId);
      return { enabled: false };
    });
    registerHandler("vault:unlock-biometric", async () => {
      if (activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = vaultStore;
      const profileId = activeProfileId;
      const unlockEpoch = lockEpoch;
      const dataKey = await biometricUnlock.releaseKey(
        profileId,
        tr("biometric.reasonUnlock", { name: await activeProfileName() }),
      );
      try {
        if (store !== vaultStore || lockEpoch !== unlockEpoch) {
          throw new Error("Unlock was interrupted because the vault was locked.");
        }
        let status;
        try {
          status = await store.unlockWithDataKey(dataKey);
        } catch (error) {
          // A key that no longer opens the file (restored from another
          // backup, for example) is removed so the button stops appearing.
          if (/^Touch ID can no longer/.test(error.message)) {
            await biometricUnlock.disable(profileId).catch(() => {});
          }
          throw error;
        }
        await profileManager.markOpened(profileId).catch(() => {});
        return status;
      } finally {
        dataKey.fill(0);
      }
    });

    // The renderer gets entry metadata only. Passwords are decrypted in this
    // process on an explicit copy or reveal and are never returned over IPC.
    registerHandler("vault:list-entries", () => vaultStore.listEntries());
    registerHandler("vault:get-entry", (entryId) => vaultStore.getEntry(entryId));
    // The current one-time code only; the secret never leaves this process.
    registerHandler(
      "vault:get-totp",
      (entryId) => vaultStore.getTotpCode(entryId),
      { countsAsActivity: false },
    );
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
        title: tr("dialog.iconTitle"),
        message: tr("dialog.iconMessage", { hostname }),
        detail: tr("dialog.iconDetail", { hostname }),
        buttons: [tr("common.cancel"), tr("dialog.iconConfirm")],
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
    // Item fields a user may copy: schema fields marked `copy` and the SSH
    // fingerprint. Secret fields are read here and never returned.
    function copyableItemValue(entry, field) {
      const schemaField = ITEM_TYPES[entry.type].fields.find((item) => item.key === field);
      if (schemaField?.copy) {
        return schemaField.kind === "secret"
          ? vaultStore.revealItemSecret(entry.id, field)
          : entry.fields[field] ?? "";
      }
      if (entry.type === "ssh" && field === "fingerprint") return entry.fields.fingerprint ?? "";
      throw new Error("Could not copy this value.");
    }

    registerHandler("vault:copy-entry-field", (entryId, field) => {
      if (typeof field !== "string") throw new Error("Could not copy this value.");
      const entry = vaultStore.getEntry(entryId);
      let value;
      if (entry.type !== "login") {
        value = copyableItemValue(entry, field);
      } else if (!COPYABLE_ENTRY_FIELDS.has(field)) {
        throw new Error("Could not copy this value.");
      } else {
        value = field === "password"
          ? vaultStore.revealPassword(entryId)
          : field === "totp"
            ? vaultStore.getTotpCode(entryId).code
            : entry.username;
      }
      if (!value) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(value);
    });
    registerHandler("vault:save-item", (item) => vaultStore.saveItem(item));
    registerHandler("vault:reveal-field", async (entryId, field) => {
      const entry = vaultStore.getEntry(entryId);
      if (entry.type === "login" || !entry.secretFields.includes(field)) {
        throw new Error("Could not copy this value.");
      }
      const raw = vaultStore.revealItemSecret(entry.id, field);
      // Card numbers are easier to read and compare in groups of four.
      const value = entry.type === "card" && field === "number" ? cardTools.formatNumber(raw) : raw;
      await showSecretDialog({
        entryName: entry.name,
        fieldLabel: tr(`item.field.${entry.type}.${field}`),
        value,
      });
      return { shown: true };
    });
    registerHandler("vault:reveal-password", async (entryId) => {
      const entry = vaultStore.getEntry(entryId);
      const password = vaultStore.revealPassword(entry.id);
      await showSecretDialog({
        entryName: entry.name,
        fieldLabel: tr("editor.password"),
        value: password,
      });
      return { shown: true };
    });
    async function saveBackup(store) {
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: tr("dialog.saveBackupTitle"),
        buttonLabel: tr("dialog.saveBackupButton"),
        defaultPath: tr("dialog.backupFileName"),
        filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      if (store !== vaultStore) throw new Error("Unlock the vault first.");
      await store.exportBackup(selection.filePath);
      return { canceled: false };
    }
    // Exporting copies every secret in the vault, so it asks for the master
    // passphrase again even though the vault is open.
    registerHandler("vault:export-backup", async (passphrase) => {
      const store = vaultStore;
      store.requireUnlocked();
      await store.verifyPassphrase(passphrase);
      return saveBackup(store);
    });
    // Right after a recovery key is issued the passphrase was just entered;
    // this path stays available only until that key dialog is closed.
    registerHandler("vault:export-backup-new-key", async () => {
      if (!pendingRecoveryKey) throw new Error("Unlock the vault first.");
      return saveBackup(vaultStore);
    });

    registerHandler("import:choose-file", async (source, credentials) => {
      if (!Object.hasOwn(IMPORT_SOURCES, source)) throw new Error("This file type is not supported.");
      const store = vaultStore;
      store.requireUnlocked();
      pendingImport = null;
      const { filterKey, extensions } = IMPORT_SOURCES[source];
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: tr("dialog.importTitle"),
        buttonLabel: tr("dialog.importButton"),
        properties: ["openFile"],
        filters: [{ name: tr(filterKey), extensions }],
      });
      if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
      const filePath = selection.filePaths[0];

      let parsed;
      if (source === "mnemo") {
        const backupCredentials = typeof credentials === "string"
          ? credentials
          : { recoveryKey: credentials?.recoveryKey };
        const logins = await VaultStore.readBackupLogins(filePath, backupCredentials);
        parsed = {
          logins,
          stats: {
            found: logins.length,
            nonLogin: 0,
            noPassword: 0,
            archived: 0,
            withTotp: logins.filter((login) => login.totp).length,
            totpNotImported: 0,
          },
        };
      } else {
        parsed = await parseImportFile(source, filePath, { fallbackName: tr("import.untitled") });
      }
      if (store !== vaultStore || !store.isUnlocked()) throw new Error("Unlock the vault first.");
      pendingImport = { source, filePath, logins: parsed.logins, store };
      return {
        canceled: false,
        fileName: path.basename(filePath),
        count: parsed.logins.length,
        stats: parsed.stats,
      };
    });
    registerHandler("import:commit", async () => {
      const pending = pendingImport;
      if (!pending?.logins || pending.store !== vaultStore) {
        throw new Error("Unlock the vault first.");
      }
      const { logins } = pending;
      pending.logins = null;
      const result = await pending.store.importLogins(logins);
      return { ...result, canTrashFile: pending.source !== "mnemo" };
    });
    registerHandler("import:trash-file", async () => {
      const pending = pendingImport;
      pendingImport = null;
      if (!pending || pending.source === "mnemo") return { trashed: false };
      await shell.trashItem(pending.filePath);
      return { trashed: true };
    });
    registerHandler("import:cancel", () => {
      pendingImport = null;
      return { canceled: true };
    });

    // Deletes the open vault's profile. Needs the master passphrase and a
    // native confirmation, so a compromised renderer cannot do it alone.
    registerHandler("vault:delete-active", async (passphrase) => {
      if (activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = vaultStore;
      const profileId = activeProfileId;
      store.requireUnlocked();
      await store.verifyPassphrase(passphrase);
      const profileName = await activeProfileName();
      const confirmation = await showVaultDialog({
        type: "warning",
        title: tr("dialog.deleteVaultTitle"),
        message: tr("dialog.deleteVaultMessage", { name: profileName }),
        detail: tr("dialog.deleteVaultDetail"),
        buttons: [tr("common.cancel"), tr("dialog.deleteVaultConfirm")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { deleted: false };
      if (store !== vaultStore || activeProfileId !== profileId) {
        throw new Error("Unlock the vault first.");
      }
      lockVault(false);
      activeProfileId = null;
      vaultStore = new VaultStore(profileManager.legacyVaultPath);
      await profileManager.deleteProfile(profileId);
      await biometricUnlock.disable(profileId).catch(() => {});
      return { deleted: true };
    });
    registerHandler("vault:restore-backup", async (credentials) => {
      const restoreCredentials = toRestoreCredentials(credentials);
      // Bind to the vault that was open when the request started; a profile
      // switch or lock while the dialogs are open cancels the restore.
      const store = vaultStore;
      const restoreEpoch = lockEpoch;
      const isStale = () => store !== vaultStore || lockEpoch !== restoreEpoch;
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: tr("dialog.chooseBackupTitle"),
        buttonLabel: tr("dialog.chooseBackupButton"),
        properties: ["openFile"],
        filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }
      if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

      if ((await store.getStatus()).vaultExists) {
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: tr("dialog.replaceTitle"),
          message: tr("dialog.replaceMessage"),
          detail: tr("dialog.replaceDetail"),
          buttons: [tr("common.cancel"), tr("dialog.replaceConfirm")],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) return { canceled: true };
      }
      if (isStale()) throw new Error("Restore was interrupted because the vault was locked.");

      await store.restoreBackup(selection.filePaths[0], restoreCredentials);
      const recoveryKey = store.takeIssuedRecoveryKey();
      // The restored file may use a different vault key than the one stored
      // for Touch ID.
      if (activeProfileId !== null) {
        await biometricUnlock.disable(activeProfileId).catch(() => {});
      }
      if (isStale()) {
        store.lock();
        throw new Error("Restore was interrupted because the vault was locked.");
      }
      if (recoveryKey) {
        pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
      }
      return { canceled: false, recoveryKey };
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
