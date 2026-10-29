const fs = require("node:fs/promises");
const path = require("node:path");
const electron = require("electron");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} = electron;
const ProfileManager = require("./profile-manager");
const SettingsStore = require("./settings-store");
const BiometricUnlock = require("./biometric-unlock");
const { Updater } = require("./updater");
const { parseImportFile } = require("./importers");
const { ITEM_TYPES } = require("./src/renderer/shared/item-types");
const cardTools = require("./src/renderer/shared/lib/card-tools");
const i18nCatalog = require("./src/renderer/shared/i18n/messages");
const { createTranslator } = require("./src/renderer/shared/i18n/translate");
const VaultStore = require("./vault-store");
const { fetchSiteFavicon, getFaviconHost } = require("./favicon-fetcher");
const { randomBytes } = require("node:crypto");
const { buildReport, checkPwnedHashes, collectPasswords } = require("./password-health");
const { createState } = require("./src/main/state");
const { createTranslation } = require("./src/main/i18n");
const { createProfileHelpers } = require("./src/main/profiles");
const { createDialogs } = require("./src/main/dialogs");
const { createClipboard } = require("./src/main/clipboard");
const { createLock } = require("./src/main/lock");
const { createWindowManager } = require("./src/main/window");
const { createRegisterHandler } = require("./src/main/ipc/register");
const { createUpdates } = require("./src/main/updates");

const COPYABLE_ENTRY_FIELDS = new Set(["username", "password", "totp"]);
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
const IMPORT_SOURCES = Object.freeze({
  bitwarden: { filterKey: "dialog.importFilterBitwarden", extensions: ["json", "csv"] },
  onepassword: { filterKey: "dialog.importFilterOnePassword", extensions: ["1pux", "csv"] },
  mnemo: { filterKey: "dialog.backupFilter", extensions: ["vault"] },
});

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
const {
  tr,
  toIpcError,
  toRestoreCredentials,
  activeProfileName,
  showVaultDialog,
  showSecretDialog,
  copyToClipboardTemporarily,
  lockVault,
  resetAutoLockTimer,
  isAppPage,
  createWindow,
  registerHandler,
  publicUpdateState,
  scheduleUpdateCheck,
  setUpdateState,
  checkForUpdates,
  downloadUpdate,
} = ctx;

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

    registerHandler("app:get-version", () => app.getVersion());
    registerHandler("settings:get", async () => {
      await state.settingsLoaded;
      return state.settingsStore.get();
    });
    registerHandler("settings:set-theme", async (theme) => {
      await state.settingsLoaded;
      const settings = await state.settingsStore.setTheme(theme);
      if (nativeTheme) nativeTheme.themeSource = settings.theme;
      return settings;
    });
    registerHandler("settings:set-language", async (code) => {
      await state.settingsLoaded;
      const settings = await state.settingsStore.setLanguage(code);
      state.language = settings.language;
      return settings;
    });
    registerHandler("profiles:choose", () => {
      lockVault(false);
      state.activeProfileId = null;
      state.vaultStore = new VaultStore(state.profileManager.legacyVaultPath);
      return state.profileManager.listProfiles();
    });
    registerHandler("profiles:select", async (profileId) => {
      const profile = await state.profileManager.getProfile(profileId);
      lockVault(false);
      state.vaultStore = new VaultStore(state.profileManager.getVaultPath(profile.id));
      state.activeProfileId = profile.id;
      return state.vaultStore.getStatus();
    });
    registerHandler("profiles:delete", async (profileId) => {
      if (state.activeProfileId !== null || state.vaultStore?.isUnlocked()) {
        throw new Error("Lock the current vault before deleting a profile.");
      }
      const deleted = await state.profileManager.deleteProfile(profileId);
      await state.biometricUnlock.disable(profileId).catch(() => {});
      return deleted;
    });
    registerHandler("profiles:create", async (name, passphrase) => {
      if (state.activeProfileId !== null) {
        throw new Error("Choose the profile screen before creating a vault.");
      }
      lockVault(false);
      const creationEpoch = state.lockEpoch;
      const created = await state.profileManager.createProfile(name, passphrase);
      const recoveryKey = created.vaultStore.takeIssuedRecoveryKey();
      if (state.lockEpoch !== creationEpoch || !recoveryKey) {
        // The user never saw this vault's recovery key, so remove the new,
        // still empty vault instead of leaving one without a known key.
        created.vaultStore.lock();
        await state.profileManager.deleteProfile(created.profile.id).catch(() => {});
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      state.vaultStore = created.vaultStore;
      state.activeProfileId = created.profile.id;
      state.pendingRecoveryKey = { key: recoveryKey, profileName: created.profile.name };
      return { profile: created.profile, status: await state.vaultStore.getStatus(), recoveryKey };
    });
    registerHandler("profiles:restore-new", async (name, credentials) => {
      const restoreCredentials = toRestoreCredentials(credentials);
      if (state.activeProfileId !== null) {
        throw new Error("Choose the profile screen before restoring a new vault.");
      }
      lockVault(false);
      const restoreEpoch = state.lockEpoch;
      const selection = await dialog.showOpenDialog(state.mainWindow, {
        title: tr("dialog.chooseBackupTitle"),
        buttonLabel: tr("dialog.chooseBackupButton"),
        properties: ["openFile"],
        filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }
      if (state.lockEpoch !== restoreEpoch) {
        throw new Error("Restore was interrupted because the Mac was locked.");
      }

      const restored = await state.profileManager.restoreProfile(
        name,
        selection.filePaths[0],
        restoreCredentials,
      );
      state.vaultStore = restored.vaultStore;
      state.activeProfileId = restored.profile.id;
      const recoveryKey = state.vaultStore.takeIssuedRecoveryKey();
      if (state.lockEpoch !== restoreEpoch) {
        state.vaultStore.lock();
        throw new Error("The backup was restored but the vault remained locked.");
      }
      if (recoveryKey) {
        state.pendingRecoveryKey = { key: recoveryKey, profileName: restored.profile.name };
      }
      return { canceled: false, profile: restored.profile, recoveryKey };
    });
    registerHandler("vault:get-status", () => state.vaultStore.getStatus());
    registerHandler("vault:unlock", async (passphrase) => {
      const status = await state.vaultStore.unlock(passphrase);
      if (state.activeProfileId !== null) {
        await state.profileManager.markOpened(state.activeProfileId).catch(() => {});
      }
      return status;
    });
    // Every change of credentials replaces the vault key (VaultStore
    // rekeyNow), so a Touch ID file holds a key that no longer opens the
    // vault: it is removed, and Touch ID is turned on again by the user.
    async function forgetTouchIdKey(profileId) {
      if (profileId !== null) await state.biometricUnlock.disable(profileId).catch(() => {});
    }
    registerHandler("vault:recover", async (recoveryKey, newPassphrase) => {
      const recoveryEpoch = state.lockEpoch;
      const store = state.vaultStore;
      const profileId = state.activeProfileId;
      const result = await store.recoverWithKey(recoveryKey, newPassphrase);
      // The new key is on disk even if the vault locked meanwhile.
      await forgetTouchIdKey(profileId);
      if (store !== state.vaultStore || state.lockEpoch !== recoveryEpoch) {
        store.lock();
        throw new Error("Recovery was interrupted because the vault was locked.");
      }
      if (state.activeProfileId !== null) {
        await state.profileManager.markOpened(state.activeProfileId).catch(() => {});
      }
      state.pendingRecoveryKey = { key: result.recoveryKey, profileName: await activeProfileName() };
      return result;
    });
    registerHandler("vault:get-recovery-status", () => ({
      enabled: state.vaultStore.hasRecoveryKey(),
    }));
    registerHandler("vault:create-recovery-key", async (passphrase) => {
      const profileId = state.activeProfileId;
      const recoveryKey = await state.vaultStore.createRecoveryKey(passphrase);
      await forgetTouchIdKey(profileId);
      state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
      return { recoveryKey };
    });
    // A new master passphrase comes with a new recovery key, shown and
    // offered for backup like one created from Settings.
    registerHandler("vault:change-passphrase", async (currentPassphrase, newPassphrase) => {
      const store = state.vaultStore;
      const profileId = state.activeProfileId;
      const recoveryKey = await store.changePassphrase(currentPassphrase, newPassphrase);
      await forgetTouchIdKey(profileId);
      if (store !== state.vaultStore) throw new Error("Unlock the vault first.");
      state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
      return { recoveryKey };
    });
    registerHandler("recovery:copy", () => {
      if (!state.pendingRecoveryKey) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(state.pendingRecoveryKey.key);
    });
    registerHandler("recovery:save", async () => {
      if (!state.pendingRecoveryKey) throw new Error("Could not save the recovery key.");
      const pending = state.pendingRecoveryKey;
      const selection = await dialog.showSaveDialog(state.mainWindow, {
        title: tr("dialog.saveRecoveryTitle"),
        buttonLabel: tr("dialog.saveRecoveryButton"),
        defaultPath: tr("dialog.recoveryFileName", {
          name: pending.profileName.replace(/[\\/:]/g, "-"),
        }),
        filters: [{ name: tr("dialog.recoveryFilter"), extensions: ["txt"] }],
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      if (state.pendingRecoveryKey !== pending) throw new Error("Could not save the recovery key.");
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
      state.pendingRecoveryKey = null;
      return { dismissed: true };
    });
    // Touch ID unlock for the selected profile. Status works while locked so
    // the unlock screen can offer it.
    registerHandler("biometric:status", async () => ({
      available: state.biometricUnlock.isAvailable(),
      enabled: state.activeProfileId !== null && (await state.biometricUnlock.isEnabled(state.activeProfileId)),
    }));
    registerHandler("biometric:enable", async (passphrase) => {
      if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = state.vaultStore;
      const profileId = state.activeProfileId;
      store.requireUnlocked();
      await store.verifyPassphrase(passphrase);
      const dataKey = store.exportDataKey();
      try {
        await state.biometricUnlock.enable(
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
      if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
      await state.biometricUnlock.disable(state.activeProfileId);
      return { enabled: false };
    });
    registerHandler("vault:unlock-biometric", async () => {
      if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = state.vaultStore;
      const profileId = state.activeProfileId;
      const unlockEpoch = state.lockEpoch;
      const dataKey = await state.biometricUnlock.releaseKey(
        profileId,
        tr("biometric.reasonUnlock", { name: await activeProfileName() }),
      );
      try {
        if (store !== state.vaultStore || state.lockEpoch !== unlockEpoch) {
          throw new Error("Unlock was interrupted because the vault was locked.");
        }
        let status;
        try {
          status = await store.unlockWithDataKey(dataKey);
        } catch (error) {
          // A key that no longer opens the file (restored from another
          // backup, for example) is removed so the button stops appearing.
          if (/^Touch ID can no longer/.test(error.message)) {
            await state.biometricUnlock.disable(profileId).catch(() => {});
          }
          throw error;
        }
        await state.profileManager.markOpened(profileId).catch(() => {});
        return status;
      } finally {
        dataKey.fill(0);
      }
    });

    // The renderer gets entry metadata only. Passwords are decrypted in this
    // process on an explicit copy or reveal and are never returned over IPC.
    registerHandler("vault:list-entries", () => state.vaultStore.listEntries());
    registerHandler("vault:get-entry", (entryId) => state.vaultStore.getEntry(entryId));
    // The current one-time code only; the secret never leaves this process.
    registerHandler(
      "vault:get-totp",
      (entryId) => state.vaultStore.getTotpCode(entryId),
      { countsAsActivity: false },
    );
    registerHandler("vault:save-entry", (entry) =>
      state.vaultStore.saveEntry(entry),
    );
    registerHandler("vault:fetch-site-icon", async (entryId) => {
      if (!state.vaultStore.isUnlocked()) throw new Error("Unlock the vault first.");
      const entry = state.vaultStore.getEntry(entryId);
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
      const savedEntry = await state.vaultStore.saveFavicon(entry.id, favicon.dataUrl);
      return {
        canceled: false,
        entry: savedEntry,
        hostname: favicon.hostname,
      };
    });
    // Deleting moves an item to the trash; see vault:delete-forever.
    registerHandler("vault:delete-entry", (id) => state.vaultStore.deleteEntry(id));

    // Folders and favorites.
    registerHandler("vault:list-folders", () => state.vaultStore.listFolders());
    registerHandler("vault:create-folder", (name) => state.vaultStore.createFolder(name));
    registerHandler("vault:rename-folder", (id, name) => state.vaultStore.renameFolder(id, name));
    registerHandler("vault:delete-folder", (id) => state.vaultStore.deleteFolder(id));
    registerHandler("vault:set-folder", (id, folderId) => state.vaultStore.setFolder(id, folderId));
    registerHandler("vault:set-favorite", (id, favorite) => state.vaultStore.setFavorite(id, favorite));

    // Trash. Deleting for good cannot be undone, so it is confirmed in a
    // native dialog that a compromised renderer cannot click through.
    registerHandler("vault:restore-entry", (id) => state.vaultStore.restoreEntry(id));
    async function confirmVaultAction(store, { title, message, detail, confirm }) {
      const epoch = state.lockEpoch;
      const confirmation = await showVaultDialog({
        type: "warning",
        title,
        message,
        detail,
        buttons: [tr("common.cancel"), confirm],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return false;
      if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
      return true;
    }
    registerHandler("vault:delete-forever", async (id) => {
      const store = state.vaultStore;
      const entry = store.getEntry(id);
      if (!entry.deletedAt) throw new Error("Move this item to the trash first.");
      const confirmed = await confirmVaultAction(store, {
        title: tr("dialog.deleteForeverTitle"),
        message: tr("dialog.deleteForeverMessage", { name: entry.name }),
        detail: tr("dialog.deleteForeverDetail"),
        confirm: tr("dialog.deleteForeverConfirm"),
      });
      if (!confirmed) return { deleted: 0 };
      return store.deletePermanently(id);
    });
    registerHandler("vault:empty-trash", async () => {
      const store = state.vaultStore;
      const count = store.listEntries().filter((entry) => entry.deletedAt).length;
      if (count === 0) return { deleted: 0 };
      const confirmed = await confirmVaultAction(store, {
        title: tr("dialog.emptyTrashTitle"),
        message: tr("dialog.emptyTrashMessage", { count }),
        detail: tr("dialog.deleteForeverDetail"),
        confirm: tr("dialog.emptyTrashConfirm"),
      });
      if (!confirmed) return { deleted: 0 };
      return store.emptyTrash();
    });

    // History: summaries without secrets; old secrets are copied or shown by
    // main, like current ones.
    registerHandler("vault:get-history", (id) => state.vaultStore.getHistory(id));
    registerHandler("vault:restore-version", (id, versionId) => state.vaultStore.restoreVersion(id, versionId));
    registerHandler("vault:copy-version-field", (id, versionId, field) => {
      const value = state.vaultStore.revealVersionSecret(id, versionId, field);
      if (!value) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(value);
    });
    registerHandler("vault:reveal-version-field", async (id, versionId, field) => {
      const entry = state.vaultStore.getEntry(id);
      const value = state.vaultStore.revealVersionSecret(id, versionId, field);
      const version = state.vaultStore.getHistory(id).find((item) => item.id === versionId);
      const when = new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" })
        .format(new Date(version.updatedAt));
      await showSecretDialog({
        entryName: entry.name,
        fieldLabel: tr("history.secretLabel", {
          field: entry.type === "login" ? tr("editor.password") : tr(`item.field.${entry.type}.${field}`),
          date: when,
        }),
        value,
      });
      return { shown: true };
    });

    // Attachments: files are picked and saved through native dialogs here, so
    // the renderer never sees paths or contents.
    registerHandler("vault:add-attachments", async (id) => {
      const store = state.vaultStore;
      const epoch = state.lockEpoch;
      store.getEntry(id);
      const selection = await dialog.showOpenDialog(state.mainWindow, {
        title: tr("dialog.addAttachmentTitle"),
        buttonLabel: tr("dialog.addAttachmentButton"),
        properties: ["openFile", "multiSelections"],
      });
      if (selection.canceled || selection.filePaths.length === 0) return { added: [], failed: [] };
      if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
      const added = [];
      const failed = [];
      for (const filePath of selection.filePaths) {
        try {
          added.push(await store.addAttachment(id, filePath));
        } catch (error) {
          failed.push({ name: path.basename(filePath), error: toIpcError(error).message });
          if (!store.isUnlocked()) break;
        }
      }
      return { added, failed };
    });
    registerHandler("vault:save-attachment", async (id, attachmentId) => {
      const store = state.vaultStore;
      const epoch = state.lockEpoch;
      const { attachment } = store.findAttachment(id, attachmentId);
      const selection = await dialog.showSaveDialog(state.mainWindow, {
        title: tr("dialog.saveAttachmentTitle"),
        buttonLabel: tr("dialog.saveAttachmentButton"),
        defaultPath: path.join(app.getPath("downloads"), attachment.name),
      });
      if (selection.canceled || !selection.filePath) return { saved: false };
      if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
      return store.exportAttachment(id, attachmentId, selection.filePath);
    });
    registerHandler("vault:delete-attachment", async (id, attachmentId) => {
      const store = state.vaultStore;
      const { attachment } = store.findAttachment(id, attachmentId);
      const confirmed = await confirmVaultAction(store, {
        title: tr("dialog.deleteAttachmentTitle"),
        message: tr("dialog.deleteAttachmentMessage", { name: attachment.name }),
        detail: tr("dialog.deleteAttachmentDetail"),
        confirm: tr("dialog.deleteAttachmentConfirm"),
      });
      if (!confirmed) return { deleted: false };
      return store.deleteAttachment(id, attachmentId);
    });

    // Reports: weak and reused passwords are found locally on every request;
    // breaches only when the user asks, through k-anonymity range queries.
    function readPasswordsForReport() {
      if (!state.vaultStore?.isUnlocked()) throw new Error("Unlock the vault first.");
      state.passwordHealthKey ??= randomBytes(32);
      return collectPasswords(state.vaultStore, state.passwordHealthKey);
    }
    registerHandler("vault:password-health", () =>
      buildReport(readPasswordsForReport(), { breaches: state.breachResults, checkedAt: state.breachCheckedAt }));
    registerHandler("vault:check-breaches", async () => {
      const store = state.vaultStore;
      const epoch = state.lockEpoch;
      const passwords = readPasswordsForReport();
      const counts = await checkPwnedHashes(passwords.map((password) => password.sha1));
      if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
      state.breachResults = new Map(passwords.map((password) => [password.fingerprint, counts.get(password.sha1)]));
      state.breachCheckedAt = Date.now();
      return buildReport(passwords, { breaches: state.breachResults, checkedAt: state.breachCheckedAt });
    });
    // Item fields a user may copy: schema fields marked `copy` and the SSH
    // fingerprint. Secret fields are read here and never returned.
    function copyableItemValue(entry, field) {
      const schemaField = ITEM_TYPES[entry.type].fields.find((item) => item.key === field);
      if (schemaField?.copy) {
        return schemaField.kind === "secret"
          ? state.vaultStore.revealItemSecret(entry.id, field)
          : entry.fields[field] ?? "";
      }
      if (entry.type === "ssh" && field === "fingerprint") return entry.fields.fingerprint ?? "";
      throw new Error("Could not copy this value.");
    }

    registerHandler("vault:copy-entry-field", (entryId, field) => {
      if (typeof field !== "string") throw new Error("Could not copy this value.");
      const entry = state.vaultStore.getEntry(entryId);
      let value;
      if (entry.type !== "login") {
        value = copyableItemValue(entry, field);
      } else if (!COPYABLE_ENTRY_FIELDS.has(field)) {
        throw new Error("Could not copy this value.");
      } else {
        value = field === "password"
          ? state.vaultStore.revealPassword(entryId)
          : field === "totp"
            ? state.vaultStore.getTotpCode(entryId).code
            : entry.username;
      }
      if (!value) throw new Error("Could not copy this value.");
      return copyToClipboardTemporarily(value);
    });
    registerHandler("vault:save-item", (item) => state.vaultStore.saveItem(item));
    registerHandler("vault:reveal-field", async (entryId, field) => {
      const entry = state.vaultStore.getEntry(entryId);
      if (entry.type === "login" || !entry.secretFields.includes(field)) {
        throw new Error("Could not copy this value.");
      }
      const raw = state.vaultStore.revealItemSecret(entry.id, field);
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
      const entry = state.vaultStore.getEntry(entryId);
      const password = state.vaultStore.revealPassword(entry.id);
      await showSecretDialog({
        entryName: entry.name,
        fieldLabel: tr("editor.password"),
        value: password,
      });
      return { shown: true };
    });
    async function saveBackup(store) {
      const selection = await dialog.showSaveDialog(state.mainWindow, {
        title: tr("dialog.saveBackupTitle"),
        buttonLabel: tr("dialog.saveBackupButton"),
        defaultPath: tr("dialog.backupFileName"),
        filters: [{ name: tr("dialog.backupFilter"), extensions: ["vault"] }],
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      if (store !== state.vaultStore) throw new Error("Unlock the vault first.");
      await store.exportBackup(selection.filePath);
      return { canceled: false };
    }
    // Exporting copies every secret in the vault, so it asks for the master
    // passphrase again even though the vault is open.
    registerHandler("vault:export-backup", async (passphrase) => {
      const store = state.vaultStore;
      store.requireUnlocked();
      await store.verifyPassphrase(passphrase);
      return saveBackup(store);
    });
    // Right after a recovery key is issued the passphrase was just entered;
    // this path stays available only until that key dialog is closed.
    registerHandler("vault:export-backup-new-key", async () => {
      if (!state.pendingRecoveryKey) throw new Error("Unlock the vault first.");
      return saveBackup(state.vaultStore);
    });

    registerHandler("import:choose-file", async (source, credentials) => {
      if (!Object.hasOwn(IMPORT_SOURCES, source)) throw new Error("This file type is not supported.");
      const store = state.vaultStore;
      store.requireUnlocked();
      state.pendingImport = null;
      const { filterKey, extensions } = IMPORT_SOURCES[source];
      const selection = await dialog.showOpenDialog(state.mainWindow, {
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
        const { logins, attachments } = await VaultStore.readBackupLogins(filePath, backupCredentials);
        parsed = {
          logins,
          stats: {
            found: logins.length,
            nonLogin: 0,
            noPassword: 0,
            archived: 0,
            withTotp: logins.filter((login) => login.totp).length,
            totpNotImported: 0,
            attachmentsNotImported: attachments,
          },
        };
      } else {
        parsed = await parseImportFile(source, filePath, { fallbackName: tr("import.untitled") });
      }
      if (store !== state.vaultStore || !store.isUnlocked()) throw new Error("Unlock the vault first.");
      state.pendingImport = { source, filePath, logins: parsed.logins, store };
      return {
        canceled: false,
        fileName: path.basename(filePath),
        count: parsed.logins.length,
        stats: parsed.stats,
      };
    });
    registerHandler("import:commit", async () => {
      const pending = state.pendingImport;
      if (!pending?.logins || pending.store !== state.vaultStore) {
        throw new Error("Unlock the vault first.");
      }
      const { logins } = pending;
      pending.logins = null;
      const result = await pending.store.importLogins(logins);
      return { ...result, canTrashFile: pending.source !== "mnemo" };
    });
    registerHandler("import:trash-file", async () => {
      const pending = state.pendingImport;
      state.pendingImport = null;
      if (!pending || pending.source === "mnemo") return { trashed: false };
      await shell.trashItem(pending.filePath);
      return { trashed: true };
    });
    registerHandler("import:cancel", () => {
      state.pendingImport = null;
      return { canceled: true };
    });

    // Deletes the open vault's profile. Needs the master passphrase and a
    // native confirmation, so a compromised renderer cannot do it alone.
    registerHandler("vault:delete-active", async (passphrase) => {
      if (state.activeProfileId === null) throw new Error("Choose a valid vault profile.");
      const store = state.vaultStore;
      const profileId = state.activeProfileId;
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
      if (store !== state.vaultStore || state.activeProfileId !== profileId) {
        throw new Error("Unlock the vault first.");
      }
      lockVault(false);
      state.activeProfileId = null;
      state.vaultStore = new VaultStore(state.profileManager.legacyVaultPath);
      await state.profileManager.deleteProfile(profileId);
      await state.biometricUnlock.disable(profileId).catch(() => {});
      return { deleted: true };
    });
    registerHandler("vault:restore-backup", async (credentials) => {
      const restoreCredentials = toRestoreCredentials(credentials);
      // Bind to the vault that was open when the request started; a profile
      // switch or lock while the dialogs are open cancels the restore.
      const store = state.vaultStore;
      const restoreEpoch = state.lockEpoch;
      const isStale = () => store !== state.vaultStore || state.lockEpoch !== restoreEpoch;
      const selection = await dialog.showOpenDialog(state.mainWindow, {
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
        const confirmation = await dialog.showMessageBox(state.mainWindow, {
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
      if (state.activeProfileId !== null) {
        await state.biometricUnlock.disable(state.activeProfileId).catch(() => {});
      }
      if (isStale()) {
        store.lock();
        throw new Error("Restore was interrupted because the vault was locked.");
      }
      if (recoveryKey) {
        state.pendingRecoveryKey = { key: recoveryKey, profileName: await activeProfileName() };
      }
      return { canceled: false, recoveryKey };
    });
    registerHandler("vault:lock", () => {
      lockVault(false);
      return state.vaultStore.getStatus();
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
