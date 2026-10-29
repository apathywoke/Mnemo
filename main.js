const path = require("node:path");
const electron = require("electron");
const {
  app,
  BrowserWindow,
  dialog,
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
const i18nCatalog = require("./src/renderer/shared/i18n/messages");
const { createTranslator } = require("./src/renderer/shared/i18n/translate");
const VaultStore = require("./vault-store");
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
const IPC_GROUPS = [
  require("./src/main/ipc/updates"),
  require("./src/main/ipc/settings"),
  require("./src/main/ipc/profiles"),
  require("./src/main/ipc/security"),
  require("./src/main/ipc/entries"),
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
  createWindow,
  registerHandler,
  scheduleUpdateCheck,
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

    for (const group of IPC_GROUPS) group.register(ctx);

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
