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
  let clipboardText = "";
  let messageResponse = 0;
  let openSelection = { canceled: true, filePaths: [] };
  let saveSelection = { canceled: true, filePath: undefined };
  const app = Object.assign(appEvents, {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => directory,
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
      showMessageBox: async () => ({ response: messageResponse }),
      showOpenDialog: async () => openSelection,
      showSaveDialog: async () => saveSelection,
    },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      on(channel, handler) { ipcEvents.set(channel, handler); },
    },
    powerMonitor,
    session: {
      defaultSession: {
        webRequest: {
          onBeforeRequest: (...args) => webRequestOptions.push(args),
        },
        setPermissionRequestHandler() {},
      },
    },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  };

  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return electronStub;
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
  await assert.rejects(untrustedInvoke("app:get-version"), /untrusted frame/);
  assert.deepEqual(await invoke("profiles:choose"), []);
  await assert.rejects(invoke("profiles:create", "Primary", "short"), /at least 7 characters/);

  const created = await invoke("profiles:create", "Primary", "correct horse battery staple");
  const profileId = created.profile.id;
  assert.equal(created.status.unlocked, true);
  assert.equal((await invoke("vault:get-status")).entryCount, 0);

  const saved = await invoke("vault:save-entry", makeLogin());
  assert.equal((await invoke("vault:get-entries")).length, 1);
  messageResponse = 0;
  assert.deepEqual(await invoke("vault:fetch-site-icon", saved.id), { canceled: true });
  assert.deepEqual(await invoke("vault:export-backup"), { canceled: true });
  assert.deepEqual(await invoke("vault:restore-backup", "correct horse battery staple"), { canceled: true });

  assert.deepEqual(await invoke("clipboard:copy-secret", "clipboard-secret"), { clearsAfterMs: 30000 });
  assert.equal(clipboardText, "clipboard-secret");
  assert.equal((await invoke("vault:lock")).unlocked, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clipboardText, "");
  await assert.rejects(invoke("clipboard:copy-secret", "secret"), /Could not copy/);
  await assert.rejects(invoke("vault:get-entries"), /Unlock the vault first/);

  await invoke("profiles:choose");
  assert.deepEqual(await invoke("profiles:restore-new", "Imported", "correct horse battery staple"), { canceled: true });
  const selected = await invoke("profiles:select", profileId);
  assert.equal(selected.vaultExists, true);
  assert.equal(selected.unlocked, false);
  await invoke("vault:unlock", "correct horse battery staple");
  await invoke("vault:delete-entry", saved.id);
  assert.equal((await invoke("vault:get-entries")).length, 0);
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
  assert.deepEqual(sentToRenderer, []);
});
