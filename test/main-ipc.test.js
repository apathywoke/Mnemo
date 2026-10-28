const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

test("main IPC enforces trusted frames and coordinates profiles, vault, dialogs, and clipboard", async (t) => {
  const directory = await makeTempDirectory(t, "local-vault-main-test-");
  const handlers = new Map();
  const ipcEvents = new Map();
  const appEvents = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const webRequestOptions = [];
  const sentToRenderer = [];
  let browserWindow;
  let permissionCheckHandler;
  let clipboardText = "";
  let messageResponse = 0;
  const messageBoxes = [];
  const nativeThemeStub = { themeSource: "system" };
  let holdDialogs = false;
  let webRtcPolicy;
  let proxyConfig;
  let openSelection = { canceled: true, filePaths: [] };
  let saveSelection = { canceled: true, filePath: undefined };
  const app = Object.assign(appEvents, {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    // Paths behave like Electron's: setPath() changes what getPath() returns.
    paths: { appData: directory },
    setPath(name, value) { this.paths[name] = value; },
    getPath(name) { return this.paths[name] ?? directory; },
    getVersion: () => "0.1.0-test",
    quit() {},
  });
  const electronStub = {
    app,
    BrowserWindow: class FakeBrowserWindow extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.webContents = new EventEmitter();
        this.webContents.setWindowOpenHandler = () => {};
        this.webContents.setWebRTCIPHandlingPolicy = (policy) => { webRtcPolicy = policy; };
        this.webContents.isDestroyed = () => false;
        this.webContents.send = (...args) => sentToRenderer.push(args);
        this.loadFile = () => Promise.resolve();
        this.show = () => {};
        this.isDestroyed = () => false;
        this.isMinimized = () => false;
        this.restore = () => {};
        this.focus = () => {};
        browserWindow = this;
      }
      static getAllWindows() {
        return browserWindow ? [browserWindow] : [];
      }
    },
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (value) => { clipboardText = value; },
      clear: async () => { clipboardText = ""; },
    },
    dialog: {
      showMessageBox: async (_window, options) => {
        messageBoxes.push(options);
        if (holdDialogs) {
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
        }
        return { response: messageResponse };
      },
      showOpenDialog: async () => openSelection,
      showSaveDialog: async () => saveSelection,
    },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      on(channel, handler) { ipcEvents.set(channel, handler); },
    },
    powerMonitor,
    nativeTheme: nativeThemeStub,
    session: {
      defaultSession: {
        webRequest: {
          onBeforeRequest: (...args) => webRequestOptions.push(args),
        },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler(handler) { permissionCheckHandler = handler; },
        setProxy: async (config) => { proxyConfig = config; },
      },
    },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`sealed:${text}`),
      decryptString: (buffer) => buffer.toString().replace(/^sealed:/, ""),
    },
    systemPreferences: {
      canPromptTouchID: () => true,
      promptTouchID: async () => {},
    },
  };

  // The real updater, kept offline: if the automatic check runs (20 s after
  // launch, reached on a slow or busy machine), it finds no release instead
  // of contacting GitHub.
  const { Updater: RealUpdater } = require("../updater");
  class OfflineUpdater extends RealUpdater {
    constructor(options) {
      super({
        ...options,
        get: async () => {
          throw Object.assign(new Error("No update was found."), { notFound: true });
        },
      });
    }
  }
  // Update state messages can arrive at any time; checks of what else was
  // sent to the renderer leave them out.
  const vaultEvents = () => sentToRenderer.splice(0).filter(([channel]) => channel !== "updates:state");

  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (request === "./updater" && parent?.filename?.endsWith(`${path.sep}main.js`)) {
      return { Updater: OfflineUpdater };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let mainPath;
  try {
    mainPath = require.resolve("../main");
    delete require.cache[mainPath];
    require("../main");
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => { delete require.cache[mainPath]; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(browserWindow);
  assert.equal(browserWindow.options.title, "Mnemo");
  assert.equal(browserWindow.options.webPreferences.nodeIntegration, false);
  assert.equal(browserWindow.options.webPreferences.contextIsolation, true);
  assert.equal(browserWindow.options.webPreferences.sandbox, true);
  assert.equal(webRequestOptions.length, 1);
  assert.equal(permissionCheckHandler(null, "clipboard-read"), false);
  assert.equal(webRtcPolicy, "disable_non_proxied_udp");
  assert.match(proxyConfig.proxyRules, /^socks5:\/\/127\.0\.0\.1:/);
  assert.equal(browserWindow.options.webPreferences.devTools, true);
  assert.equal(handlers.has("vault:fetch-site-icon"), true);

  const trustedFrame = { url: pathToFileURL(path.join(__dirname, "..", "index.html")).href };
  const invoke = (channel, ...args) => handlers.get(channel)(
    { senderFrame: trustedFrame, sender: { mainFrame: trustedFrame } },
    ...args,
  );
  const untrustedInvoke = (channel, ...args) => handlers.get(channel)(
    { senderFrame: { url: "https://attacker.example/" }, sender: { mainFrame: trustedFrame } },
    ...args,
  );

  assert.equal(await invoke("app:get-version"), "0.1.0-test");
  assert.deepEqual(await invoke("settings:get"), { language: "en", theme: "system", updateInterval: "1d" });
  assert.equal(nativeThemeStub.themeSource, "system");
  assert.deepEqual(await invoke("settings:set-theme", "light"), { language: "en", theme: "light", updateInterval: "1d" });
  assert.equal(nativeThemeStub.themeSource, "light");
  await assert.rejects(invoke("settings:set-theme", "sepia"), /\[mnemo:errors\.saveSettings\]/);
  await invoke("settings:set-theme", "system");
  await assert.rejects(invoke("settings:set-language", "fr"), /\[mnemo:errors\.saveSettings\]/);
  assert.deepEqual(await invoke("settings:set-language", "de"), { language: "de", theme: "system", updateInterval: "1d" });
  await assert.rejects(
    invoke("profiles:create", "Primary", "short"),
    /\[mnemo:errors\.passphraseTooShort\] Die Master-Passphrase muss mindestens 12 Zeichen lang sein\./,
  );
  await invoke("settings:set-language", "en");

  // Updates: the development build reports that it cannot replace itself,
  // and the release page link stays on the project's GitHub releases.
  const updates = await invoke("updates:get-state");
  assert.equal(updates.currentVersion, "0.1.0-test");
  assert.equal(updates.canInstall, false);
  assert.equal(updates.blocker, "notPackaged");
  assert.equal(updates.updateInterval, "1d");
  assert.deepEqual(await invoke("settings:set-update-interval", "6h"), { language: "en", theme: "system", updateInterval: "6h" });
  assert.equal((await invoke("updates:get-state")).updateInterval, "6h");
  await assert.rejects(invoke("settings:set-update-interval", "5m"), /\[mnemo:errors\.saveSettings\]/);
  await invoke("settings:set-update-interval", "off");
  await invoke("settings:set-update-interval", "1d");
  await assert.rejects(invoke("updates:install"), /\[mnemo:errors\.updateNotReady\]/);
  await assert.rejects(invoke("updates:download"), /\[mnemo:errors\.updateNone\]/);
  assert.ok(sentToRenderer.every(([channel]) => channel === "updates:state"));
  sentToRenderer.length = 0;
  await assert.rejects(untrustedInvoke("app:get-version"), /untrusted frame/);
  assert.deepEqual(await invoke("profiles:choose"), []);
  await assert.rejects(invoke("profiles:create", "Primary", "short"), /at least 12 characters/);

  const created = await invoke("profiles:create", "Primary", "correct horse battery staple");
  const profileId = created.profile.id;
  assert.equal(created.status.unlocked, true);
  assert.equal((await invoke("vault:get-status")).entryCount, 0);

  // The recovery key is returned once and can be copied until dismissed.
  assert.match(created.recoveryKey, /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  assert.deepEqual(await invoke("vault:get-recovery-status"), { enabled: true });
  await invoke("recovery:copy");
  assert.equal(clipboardText, created.recoveryKey);
  await invoke("recovery:dismiss");
  await assert.rejects(invoke("recovery:copy"), /\[mnemo:errors\.copyValue\]/);
  await assert.rejects(
    invoke("vault:create-recovery-key", "wrong passphrase"),
    /\[mnemo:errors\.passphraseIncorrect\]/,
  );
  const rotated = await invoke("vault:create-recovery-key", "correct horse battery staple");
  assert.notEqual(rotated.recoveryKey, created.recoveryKey);
  await invoke("recovery:dismiss");

  // Touch ID: enabling needs the passphrase; unlocking releases the key.
  assert.deepEqual(await invoke("biometric:status"), { available: true, enabled: false });
  await assert.rejects(invoke("biometric:enable", "wrong passphrase"), /\[mnemo:errors\.passphraseIncorrect\]/);
  assert.deepEqual(await invoke("biometric:enable", "correct horse battery staple"), { enabled: true });
  assert.equal((await invoke("vault:lock")).unlocked, false);
  assert.equal((await invoke("vault:unlock-biometric")).unlocked, true);
  assert.deepEqual(await invoke("biometric:status"), { available: true, enabled: true });

  const saved = await invoke("vault:save-entry", makeLogin());
  assert.equal(Object.hasOwn(saved, "password"), false);
  const listed = await invoke("vault:list-entries");
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes("test-password-value"), false);
  assert.equal(Object.hasOwn(listed[0], "notes"), false);
  assert.equal((await invoke("vault:get-entry", saved.id)).notes, "local test data");
  assert.equal(JSON.stringify(await invoke("vault:get-entry", saved.id)).includes("test-password-value"), false);
  messageResponse = 0;
  assert.deepEqual(await invoke("vault:fetch-site-icon", saved.id), { canceled: true });
  await assert.rejects(invoke("vault:export-backup", "wrong passphrase"), /\[mnemo:errors\.passphraseIncorrect\]/);
  assert.deepEqual(await invoke("vault:export-backup", "correct horse battery staple"), { canceled: true });
  assert.deepEqual(await invoke("vault:restore-backup", "correct horse battery staple"), { canceled: true });
  await assert.rejects(invoke("vault:restore-backup", 42), /\[mnemo:errors\.enterPassphrase\]/);

  assert.equal(handlers.has("clipboard:copy-secret"), false);
  assert.deepEqual(await invoke("vault:copy-entry-field", saved.id, "username"), { clearsAfterMs: 30000 });
  assert.equal(clipboardText, "user@example.com");
  await assert.rejects(invoke("vault:copy-entry-field", saved.id, "notes"), /Could not copy/);
  await assert.rejects(untrustedInvoke("vault:copy-entry-field", saved.id, "password"), /untrusted frame/);
  assert.deepEqual(await invoke("vault:copy-entry-field", saved.id, "password"), { clearsAfterMs: 30000 });
  assert.equal(clipboardText, "test-password-value");

  // One-time codes: only the code crosses IPC, and it can be copied.
  await assert.rejects(invoke("vault:get-totp", saved.id), /\[mnemo:errors\.totpMissing\]/);
  await invoke("vault:save-entry", {
    ...makeLogin({ id: saved.id, password: "" }),
    totp: "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP",
    removeTotp: false,
  });
  const totp = await invoke("vault:get-totp", saved.id);
  assert.deepEqual(Object.keys(totp).sort(), ["code", "expiresAt", "period"]);
  assert.match(totp.code, /^\d{6}$/);
  assert.equal((await invoke("vault:list-entries"))[0].hasTotp, true);
  await invoke("vault:copy-entry-field", saved.id, "totp");
  assert.match(clipboardText, /^\d{6}$/);

  // Reports: weak and reused passwords by entry ID, no secrets.
  const twin = await invoke("vault:save-entry", makeLogin({ name: "Twin" }));
  const weak = await invoke("vault:save-entry", makeLogin({ name: "Weak", password: "password1" }));
  const health = await invoke("vault:password-health");
  assert.equal(health.total, 3);
  assert.deepEqual(health.reused.map((group) => group.slice().sort()), [[saved.id, twin.id].sort()]);
  assert.ok(health.weak.includes(weak.id));
  assert.equal(health.breached, null);
  assert.equal(/test-password-value|password1/.test(JSON.stringify(health)), false);
  await invoke("vault:delete-entry", twin.id);
  await invoke("vault:delete-entry", weak.id);

  // Items: secrets are copied or shown by main, never returned.
  const card = await invoke("vault:save-item", {
    id: "", type: "card", name: "Visa", notes: "",
    fields: { cardholder: "Alice", number: "4242424242424242", expiry: "07/28", cvv: "123", pin: "" },
  });
  assert.equal(JSON.stringify(card).includes("4242424242424242"), false);
  assert.equal(JSON.stringify(await invoke("vault:list-entries")).includes("4242424242424242"), false);
  await invoke("vault:copy-entry-field", card.id, "number");
  assert.equal(clipboardText, "4242424242424242");
  await invoke("vault:copy-entry-field", card.id, "cardholder");
  assert.equal(clipboardText, "Alice");
  await assert.rejects(invoke("vault:copy-entry-field", card.id, "last4"), /\[mnemo:errors\.copyValue\]/);
  await assert.rejects(invoke("vault:copy-entry-field", card.id, "pin"), /\[mnemo:errors\.copyValue\]/);
  messageBoxes.length = 0;
  assert.deepEqual(await invoke("vault:reveal-field", card.id, "cvv"), { shown: true });
  assert.equal(messageBoxes.at(-1).detail, "123");
  await invoke("vault:reveal-field", card.id, "number");
  assert.equal(messageBoxes.at(-1).detail, "4242 4242 4242 4242");
  assert.match(messageBoxes.at(-1).message, /^Visa · Card number\n/);
  await assert.rejects(invoke("vault:reveal-field", card.id, "cardholder"), /\[mnemo:errors\.copyValue\]/);
  await assert.rejects(
    invoke("vault:save-item", { id: "", type: "card", name: "Bad", notes: "", fields: { number: "12" } }),
    /\[mnemo:errors\.cardNumber\]/,
  );
  await invoke("vault:delete-entry", card.id);

  // Folders and favorites change organization only.
  const folder = await invoke("vault:create-folder", "  Work  ");
  assert.equal(folder.name, "Work");
  await assert.rejects(invoke("vault:create-folder", "work"), /\[mnemo:errors\.folderExists\]/);
  assert.equal((await invoke("vault:set-folder", saved.id, folder.id)).folderId, folder.id);
  assert.equal((await invoke("vault:set-favorite", saved.id, true)).favorite, true);
  assert.deepEqual((await invoke("vault:list-folders")).map((item) => item.name), ["Work"]);
  await invoke("vault:delete-folder", folder.id);
  assert.equal((await invoke("vault:get-entry", saved.id)).folderId, null);
  await invoke("vault:set-favorite", saved.id, false);

  // History: summaries only; the old password is copied or shown by main.
  await invoke("vault:save-entry", { ...makeLogin({ id: saved.id, password: "a new password value" }), totp: "", removeTotp: true });
  const [previous] = await invoke("vault:get-history", saved.id);
  assert.ok(previous.changes.includes("password"));
  assert.equal(/test-password-value|a new password value/.test(JSON.stringify(previous)), false);
  await invoke("vault:copy-version-field", saved.id, previous.id, "password");
  assert.equal(clipboardText, "test-password-value");
  messageBoxes.length = 0;
  await invoke("vault:reveal-version-field", saved.id, previous.id, "password");
  assert.equal(messageBoxes.at(-1).detail, "test-password-value");
  await invoke("vault:restore-version", saved.id, previous.id);
  await invoke("vault:copy-entry-field", saved.id, "password");
  assert.equal(clipboardText, "test-password-value");

  // Attachments: chosen and saved through native dialogs; contents stay in main.
  const attachmentSource = path.join(directory, "contract.txt");
  await require("node:fs/promises").writeFile(attachmentSource, "signed contract");
  openSelection = { canceled: false, filePaths: [attachmentSource] };
  const attached = await invoke("vault:add-attachments", saved.id);
  assert.equal(attached.added.length, 1);
  assert.deepEqual(attached.failed, []);
  assert.equal(attached.added[0].name, "contract.txt");
  openSelection = { canceled: true, filePaths: [] };
  const exportedAttachment = path.join(directory, "contract-copy.txt");
  saveSelection = { canceled: false, filePath: exportedAttachment };
  assert.equal((await invoke("vault:save-attachment", saved.id, attached.added[0].id)).saved, true);
  assert.equal(await require("node:fs/promises").readFile(exportedAttachment, "utf8"), "signed contract");
  saveSelection = { canceled: true, filePath: undefined };
  messageResponse = 1;
  assert.deepEqual(await invoke("vault:delete-attachment", saved.id, attached.added[0].id), { deleted: true });
  messageResponse = 0;
  assert.deepEqual((await invoke("vault:get-entry", saved.id)).attachments, []);

  messageBoxes.length = 0;
  assert.deepEqual(await invoke("vault:reveal-password", saved.id), { shown: true });
  assert.equal(messageBoxes.length, 1);
  // The value is the whole detail text, so selecting it copies it exactly.
  assert.equal(messageBoxes[0].detail, "test-password-value");
  assert.match(messageBoxes[0].message, /^Example account · Password\n.*30 seconds/);

  // A revealed password must not outlive the unlocked session.
  holdDialogs = true;
  const pendingReveal = invoke("vault:reveal-password", saved.id);
  await new Promise((resolve) => setImmediate(resolve));
  const heldDialog = messageBoxes.at(-1);
  assert.equal(heldDialog.signal.aborted, false);
  powerMonitor.emit("lock-screen");
  assert.equal(heldDialog.signal.aborted, true);
  assert.deepEqual(vaultEvents(), [["vault:auto-locked"]]);
  await pendingReveal;
  holdDialogs = false;
  await invoke("vault:unlock", "correct horse battery staple");
  assert.equal((await invoke("vault:lock")).unlocked, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clipboardText, "");
  await assert.rejects(invoke("vault:copy-entry-field", saved.id, "password"), /Unlock the vault first/);
  await assert.rejects(invoke("vault:list-entries"), /Unlock the vault first/);

  await invoke("profiles:choose");
  assert.deepEqual(await invoke("profiles:restore-new", "Imported", "correct horse battery staple"), { canceled: true });
  const selected = await invoke("profiles:select", profileId);
  assert.equal(selected.vaultExists, true);
  assert.equal(selected.unlocked, false);
  await assert.rejects(
    invoke("vault:recover", created.recoveryKey, "new passphrase 123"),
    /\[mnemo:errors\.recoveryKeyWrong\]/,
  );
  const recovered = await invoke("vault:recover", rotated.recoveryKey, "new passphrase 123");
  assert.equal(recovered.status.unlocked, true);
  await invoke("recovery:copy");
  assert.equal(clipboardText, recovered.recoveryKey);
  assert.equal((await invoke("vault:lock")).unlocked, false);
  await assert.rejects(invoke("recovery:copy"), /\[mnemo:errors\.copyValue\]/);
  await invoke("vault:unlock", "new passphrase 123");

  // Changing the passphrase needs the current one and a strong new one,
  // replaces the vault key, turns Touch ID off, and shows a new recovery key.
  await invoke("biometric:enable", "new passphrase 123");
  assert.equal((await invoke("biometric:status")).enabled, true);
  await assert.rejects(
    invoke("vault:change-passphrase", "not the passphrase 1", "a brand new long passphrase 4"),
    /\[mnemo:errors\.passphraseIncorrect\]/,
  );
  await assert.rejects(
    invoke("vault:change-passphrase", "new passphrase 123", "password password"),
    /\[mnemo:errors\.passphraseWeak\]/,
  );
  assert.equal((await invoke("biometric:status")).enabled, true);
  const changed = await invoke("vault:change-passphrase", "new passphrase 123", "a brand new long passphrase 4");
  assert.match(changed.recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
  assert.deepEqual(await invoke("biometric:status"), { available: true, enabled: false });
  await invoke("recovery:copy");
  assert.equal(clipboardText, changed.recoveryKey);
  await invoke("recovery:dismiss");
  assert.equal((await invoke("vault:lock")).unlocked, false);
  await assert.rejects(invoke("vault:unlock", "new passphrase 123"), /\[mnemo:errors\.unlockFailed\]|Could not open the vault/);
  await invoke("vault:unlock", "a brand new long passphrase 4");
  await invoke("vault:delete-entry", saved.id);
  // Deleted items wait in the trash; emptying it needs a native confirmation.
  assert.ok((await invoke("vault:list-entries")).every((entry) => entry.deletedAt));
  messageResponse = 0;
  assert.deepEqual(await invoke("vault:empty-trash"), { deleted: 0 });
  messageResponse = 1;
  assert.deepEqual(await invoke("vault:empty-trash"), { deleted: 4 });
  messageResponse = 0;
  assert.equal((await invoke("vault:list-entries")).length, 0);
  await assert.rejects(invoke("profiles:delete", profileId), /Lock the current vault/);

  assert.equal((await invoke("vault:lock")).unlocked, false);
  assert.deepEqual(await invoke("profiles:choose").then((profiles) => profiles.map(({ id }) => id)), [profileId]);
  assert.deepEqual(await invoke("profiles:delete", profileId), {
    deleted: true,
    profile: { id: profileId, name: "Primary" },
  });
  assert.deepEqual(await invoke("profiles:choose"), []);

  ipcEvents.get("vault:activity")(
    { senderFrame: { url: "https://attacker.example/" }, sender: { mainFrame: trustedFrame } },
  );
  assert.deepEqual(vaultEvents(), []);
});
