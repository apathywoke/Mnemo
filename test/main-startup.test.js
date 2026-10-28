const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadMainWith(app) {
  const electronStub = { app, BrowserWindow: class {}, ipcMain: {}, session: {} };
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const mainPath = require.resolve("../main");
  try {
    delete require.cache[mainPath];
    require("../main");
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
  }
}

for (const name of ["remote-debugging-port", "remote-debugging-pipe"]) {
  test(`packaged app exits when launched with --${name}`, () => {
    const calls = [];
    const app = Object.assign(new EventEmitter(), {
      getPath: () => "/tmp/app-data",
      setPath: () => {},
      isPackaged: true,
      commandLine: { hasSwitch: (value) => value === name },
      exit: (code) => calls.push(["exit", code]),
      quit: () => calls.push(["quit"]),
      requestSingleInstanceLock: () => calls.push(["lock"]) && true,
      whenReady: () => {
        calls.push(["whenReady"]);
        return new Promise(() => {});
      },
    });

    loadMainWith(app);
    assert.deepEqual(calls, [["exit", 1]]);
  });
}

// The data folder must not follow package.json: a new "name" or an added
// "productName" would otherwise point the app at an empty folder.
for (const name of ["local-vault-prototype", "mnemo", "Mnemo"]) {
  test(`the data folder stays the same when the app is named ${name}`, () => {
    const calls = [];
    const app = Object.assign(new EventEmitter(), {
      name,
      getName: () => name,
      commandLine: { hasSwitch: () => false },
      getPath: (key) => (key === "appData" ? "/Users/test/Library/Application Support" : `/default/${name}`),
      setPath: (key, value) => calls.push(["setPath", key, value]),
      requestSingleInstanceLock: () => calls.push(["lock"]) && false,
      quit: () => calls.push(["quit"]),
      whenReady: () => new Promise(() => {}),
    });
    loadMainWith(app);
    assert.deepEqual(calls.slice(0, 2), [
      ["setPath", "userData", path.join("/Users/test/Library/Application Support", "local-vault-prototype")],
      ["lock"],
    ]);
  });
}

test("--user-data-dir still chooses the data folder", () => {
  const calls = [];
  const app = Object.assign(new EventEmitter(), {
    commandLine: { hasSwitch: (value) => value === "user-data-dir" },
    getPath: () => "/tmp/app-data",
    setPath: (key, value) => calls.push(["setPath", key, value]),
    requestSingleInstanceLock: () => calls.push(["lock"]) && false,
    quit: () => calls.push(["quit"]),
    whenReady: () => new Promise(() => {}),
  });
  loadMainWith(app);
  assert.equal(calls.some(([call]) => call === "setPath"), false);
});
