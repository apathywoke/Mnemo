const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { makeTempDirectory } = require("../support/helpers");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Loads main.js with Electron and the updater replaced by stand-ins, so the
// update flow in main (schedule, state, IPC, install) runs without network.
async function loadMain(t) {
  const directory = await makeTempDirectory(t, "mnemo-main-updates-");
  const handlers = new Map();
  const sent = [];
  const opened = [];
  const exits = [];
  const fake = {
    options: null,
    blocker: null,
    update: null,
    checkError: null,
    downloadError: null,
    checks: 0,
    downloaded: null,
    installed: 0,
    cleaned: 0,
  };
  class FakeUpdater {
    constructor(options) {
      fake.options = options;
    }
    installBlocker() {
      return fake.blocker;
    }
    async check() {
      fake.checks += 1;
      if (fake.checkError) throw fake.checkError;
      return fake.update;
    }
    async download(update, onProgress) {
      onProgress(25, 100);
      onProgress(100, 100);
      if (fake.downloadError) throw fake.downloadError;
      fake.downloaded = update;
      return { version: update.version };
    }
    async install() {
      fake.installed += 1;
      return { relaunching: true };
    }
    async cleanUpLeftovers() {
      fake.cleaned += 1;
    }
  }

  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => directory,
    getVersion: () => "0.1.0",
    exit: (code) => exits.push(code),
    quit() {},
  });
  let window;
  const electronStub = {
    app,
    BrowserWindow: class extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler() {},
          setWebRTCIPHandlingPolicy() {},
          isDestroyed: () => false,
          send: (...args) => sent.push(args),
        });
        this.loadFile = () => Promise.resolve();
        this.show = () => {};
        this.isDestroyed = () => false;
        window = this;
      }
      static getAllWindows() {
        return window ? [window] : [];
      }
    },
    clipboard: { readText: async () => "", writeText: async () => {}, clear: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    powerMonitor: new EventEmitter(),
    nativeTheme: { themeSource: "system" },
    session: {
      defaultSession: {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setProxy: async () => {},
      },
    },
    shell: { openExternal: async (url) => opened.push(url), trashItem: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    systemPreferences: { canPromptTouchID: () => false },
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (request === "./updater" && parent?.filename?.endsWith(`${path.sep}main.js`)) return { Updater: FakeUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  const mainPath = require.resolve("../main");
  try {
    delete require.cache[mainPath];
    require("../main");
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => { delete require.cache[mainPath]; });

  const frame = { url: pathToFileURL(path.join(__dirname, "..", "index.html")).href };
  const invoke = (channel, ...args) => handlers.get(channel)({ senderFrame: frame, sender: { mainFrame: frame } }, ...args);
  // Settings load from disk before the first check is planned.
  await new Promise((resolve) => setImmediate(resolve));
  await invoke("settings:get");
  return { app, electronStub, fake, invoke, sent, opened, exits };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const UPDATE = {
  version: "0.2.0",
  notes: "Faster unlock.",
  releaseUrl: "https://github.com/apathywoke/Mnemo/releases/tag/v0.2.0",
  asset: { name: "Mnemo-0.2.0-mac-arm64.zip", size: 100, sha512: "x", url: "https://github.com/dl" },
};

test("automatic checks follow the chosen interval and stop when off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 28) });
  const { fake, invoke, sent } = await loadMain(t);
  assert.equal(fake.cleaned, 1);
  assert.equal(fake.options.currentVersion, "0.1.0");
  assert.ok(fake.options.keysDirectory.endsWith(path.join("build", "update-keys")));

  // First check about 20 seconds after launch, not before.
  t.mock.timers.tick(19_000);
  await flush();
  assert.equal(fake.checks, 0);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(fake.checks, 1);
  const states = sent.filter(([channel]) => channel === "updates:state").map(([, state]) => state.status);
  assert.deepEqual(states, ["checking", "upToDate"]);

  // Default: daily.
  t.mock.timers.tick(DAY - 1);
  await flush();
  assert.equal(fake.checks, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fake.checks, 2);

  // A shorter interval applies from the last check.
  t.mock.timers.tick(10 * MINUTE);
  assert.equal((await invoke("settings:set-update-interval", "30m")).updateInterval, "30m");
  t.mock.timers.tick(19 * MINUTE);
  await flush();
  assert.equal(fake.checks, 2);
  t.mock.timers.tick(1 * MINUTE);
  await flush();
  assert.equal(fake.checks, 3);

  // Switching from daily after a long gap checks soon, not a day later.
  await invoke("settings:set-update-interval", "1d");
  t.mock.timers.tick(5 * HOUR);
  await invoke("settings:set-update-interval", "1h");
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(fake.checks, 4);

  // Never: no more automatic checks; a manual check still works.
  await invoke("settings:set-update-interval", "off");
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(fake.checks, 4);
  assert.equal((await invoke("updates:check")).status, "upToDate");
  assert.equal(fake.checks, 5);
  t.mock.timers.tick(3 * DAY);
  await flush();
  assert.equal(fake.checks, 5);
});

test("check, download, and install move through the states and relaunch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 28) });
  const { fake, invoke, sent, opened, exits } = await loadMain(t);

  // A failed check is reported, then a later one finds the update.
  fake.checkError = new Error("Could not reach the update server.");
  const failed = await invoke("updates:check");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /\[mnemo:errors\.updateReach\]/);
  fake.checkError = null;
  fake.update = UPDATE;
  const available = await invoke("updates:check");
  assert.equal(available.status, "available");
  assert.equal(available.version, "0.2.0");
  assert.equal(available.notes, "Faster unlock.");
  assert.equal(available.canInstall, true);
  assert.equal(available.error, null);

  // Without a self-update (for example outside Applications) the release page opens.
  fake.blocker = "notInApplications";
  assert.equal((await invoke("updates:get-state")).canInstall, false);
  await invoke("updates:open-release");
  assert.deepEqual(opened, [UPDATE.releaseUrl]);
  fake.blocker = null;

  // A failed download goes back to "available" with the reason.
  fake.downloadError = new Error("The downloaded update does not match its signature.");
  await assert.rejects(invoke("updates:download"), /\[mnemo:errors\.updateMismatch\]/);
  const afterFailure = await invoke("updates:get-state");
  assert.equal(afterFailure.status, "available");
  assert.match(afterFailure.error, /errors\.updateMismatch/);
  fake.downloadError = null;

  sent.length = 0;
  const ready = await invoke("updates:download");
  assert.equal(ready.status, "ready");
  assert.equal(fake.downloaded, UPDATE);
  const progress = sent.filter(([channel]) => channel === "updates:state").map(([, state]) => [state.status, state.progress]);
  assert.deepEqual(progress, [["downloading", 0], ["downloading", 25], ["downloading", 100], ["ready", 100]]);

  // Once ready, nothing is checked again until restart.
  await invoke("settings:set-update-interval", "30m");
  t.mock.timers.tick(2 * DAY);
  await flush();
  assert.equal(fake.checks, 2);
  assert.equal((await invoke("updates:check")).status, "ready");
  assert.equal(fake.checks, 2);

  assert.deepEqual(await invoke("updates:install"), { relaunching: true });
  assert.equal(fake.installed, 1);
  assert.equal((await invoke("vault:get-status")).unlocked, false);
  await flush();
  assert.deepEqual(exits, [0]);
});

test("the release page opens only for this project's GitHub releases", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 28) });
  const { fake, invoke, opened } = await loadMain(t);
  await invoke("updates:open-release");
  assert.deepEqual(opened, ["https://github.com/apathywoke/Mnemo/releases/latest"]);
  fake.update = { ...UPDATE, releaseUrl: "https://evil.example/apathywoke/Mnemo/releases/" };
  await invoke("updates:check");
  await assert.rejects(invoke("updates:open-release"), /\[mnemo:errors\.updateAddress\]/);
  assert.equal(opened.length, 1);
});
