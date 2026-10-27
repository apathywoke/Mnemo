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
  const mainWorldScripts = [];
  const electronStub = {
    contextBridge: {
      executeInMainWorld(script) {
        mainWorldScripts.push(script);
      },
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
  assert.equal(mainWorldScripts.length, 1);
  const fakeWindow = { RTCPeerConnection() {}, webkitRTCPeerConnection() {}, RTCDataChannel() {}, fetch() {} };
  globalThis.window = fakeWindow;
  try {
    mainWorldScripts[0].func();
  } finally {
    delete globalThis.window;
  }
  assert.deepEqual(Object.keys(fakeWindow), ["fetch"]);
  assert.deepEqual(Object.keys(exposedApi).sort(), [
    "chooseProfile",
    "copyEntryField",
    "cancelImport",
    "chooseImportFile",
    "commitImport",
    "copyRecoveryKey",
    "createRecoveryKey",
    "createProfile",
    "deleteActiveVault",
    "disableTouchId",
    "deleteEntry",
    "deleteProfile",
    "dismissRecoveryKey",
    "enableTouchId",
    "exportBackup",
    "exportBackupWithNewKey",
    "fetchSiteIcon",
    "getEntry",
    "getRecoveryStatus",
    "getSettings",
    "getTouchIdStatus",
    "listEntries",
    "getVersion",
    "getVaultStatus",
    "lockVault",
    "recoverVault",
    "onAutoLocked",
    "reportActivity",
    "restoreBackup",
    "restoreNewProfile",
    "revealPassword",
    "saveRecoveryKey",
    "saveEntry",
    "selectProfile",
    "trashImportFile",
    "unlockWithTouchId",
    "setLanguage",
    "unlockVault",
  ].sort());

  const calls = [
    ["getVersion", "app:get-version", []],
    ["getSettings", "settings:get", []],
    ["setLanguage", "settings:set-language", ["de"]],
    ["chooseProfile", "profiles:choose", []],
    ["selectProfile", "profiles:select", ["profile-id"]],
    ["deleteProfile", "profiles:delete", ["profile-id"]],
    ["createProfile", "profiles:create", ["name", "passphrase"]],
    ["restoreNewProfile", "profiles:restore-new", ["name", "passphrase"]],
    ["getVaultStatus", "vault:get-status", []],
    ["listEntries", "vault:list-entries", []],
    ["getEntry", "vault:get-entry", ["entry-id"]],
    ["saveEntry", "vault:save-entry", [{ name: "entry" }]],
    ["fetchSiteIcon", "vault:fetch-site-icon", ["entry-id"]],
    ["deleteEntry", "vault:delete-entry", ["entry-id"]],
    ["copyEntryField", "vault:copy-entry-field", ["entry-id", "password"]],
    ["revealPassword", "vault:reveal-password", ["entry-id"]],
    ["unlockVault", "vault:unlock", ["passphrase"]],
    ["recoverVault", "vault:recover", ["key", "passphrase"]],
    ["getRecoveryStatus", "vault:get-recovery-status", []],
    ["createRecoveryKey", "vault:create-recovery-key", ["passphrase"]],
    ["copyRecoveryKey", "recovery:copy", []],
    ["saveRecoveryKey", "recovery:save", []],
    ["dismissRecoveryKey", "recovery:dismiss", []],
    ["exportBackup", "vault:export-backup", ["passphrase"]],
    ["exportBackupWithNewKey", "vault:export-backup-new-key", []],
    ["chooseImportFile", "import:choose-file", ["bitwarden", undefined]],
    ["commitImport", "import:commit", []],
    ["trashImportFile", "import:trash-file", []],
    ["cancelImport", "import:cancel", []],
    ["deleteActiveVault", "vault:delete-active", ["passphrase"]],
    ["unlockWithTouchId", "vault:unlock-biometric", []],
    ["getTouchIdStatus", "biometric:status", []],
    ["enableTouchId", "biometric:enable", ["passphrase"]],
    ["disableTouchId", "biometric:disable", []],
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
