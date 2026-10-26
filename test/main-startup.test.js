const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
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
