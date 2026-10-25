const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("preload exposes only the approved IPC methods and forwards arguments", async () => {
  const originalLoad = Module._load;
  let exposedName;
  let exposedApi;
  const invocations = [];
  const sent = [];
  const listeners = new Map();
  const electronStub = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposedName = name;
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        return Promise.resolve(channel);
      },
      send(channel, ...args) {
        sent.push([channel, ...args]);
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
    },
  };

  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../preload")];
    require("../preload");
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(exposedName, "vaultApp");
  assert.deepEqual(Object.keys(exposedApi).sort(), [
    "chooseProfile",
    "copySecret",
    "createProfile",
    "deleteEntry",
    "deleteProfile",
    "exportBackup",
    "fetchSiteIcon",
    "getEntries",
    "getVersion",
    "getVaultStatus",
    "lockVault",
    "onAutoLocked",
    "reportActivity",
    "restoreBackup",
    "restoreNewProfile",
    "saveEntry",
    "selectProfile",
    "unlockVault",
  ].sort());

  const calls = [
    ["getVersion", "app:get-version", []],
    ["chooseProfile", "profiles:choose", []],
    ["selectProfile", "profiles:select", ["profile-id"]],
    ["deleteProfile", "profiles:delete", ["profile-id"]],
    ["createProfile", "profiles:create", ["name", "passphrase"]],
    ["restoreNewProfile", "profiles:restore-new", ["name", "passphrase"]],
    ["getVaultStatus", "vault:get-status", []],
    ["getEntries", "vault:get-entries", []],
    ["saveEntry", "vault:save-entry", [{ name: "entry" }]],
    ["fetchSiteIcon", "vault:fetch-site-icon", ["entry-id"]],
    ["deleteEntry", "vault:delete-entry", ["entry-id"]],
    ["copySecret", "clipboard:copy-secret", ["secret"]],
    ["unlockVault", "vault:unlock", ["passphrase"]],
    ["exportBackup", "vault:export-backup", []],
    ["restoreBackup", "vault:restore-backup", ["passphrase"]],
    ["lockVault", "vault:lock", []],
  ];

  for (const [method, channel, args] of calls) {
    assert.equal(await exposedApi[method](...args), channel);
  }
  assert.deepEqual(invocations, calls.map(([, channel, ...rest]) => [channel, ...rest[0]]));

  exposedApi.reportActivity();
  assert.deepEqual(sent, [["vault:activity"]]);
  let autoLocked = false;
  exposedApi.onAutoLocked(() => { autoLocked = true; });
  listeners.get("vault:auto-locked")();
  assert.equal(autoLocked, true);
});
