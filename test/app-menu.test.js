const assert = require("node:assert/strict");
const test = require("node:test");
const { MENU_COMMANDS, createAppMenu } = require("../src/main/app-menu");

function setup({ isPackaged = true } = {}) {
  const sent = [];
  const locks = [];
  let template = null;
  const ctx = {
    state: {
      mainWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) },
      },
    },
    tr: (key) => `[${key}]`,
    lockVault: (notify) => locks.push(notify),
    electron: {
      app: { isPackaged },
      Menu: {
        buildFromTemplate: (value) => { template = value; return value; },
        setApplicationMenu: () => {},
      },
    },
  };
  createAppMenu(ctx).buildAppMenu();
  const items = template.flatMap((menu) => menu.submenu ?? []);
  const byLabel = (label) => items.find((item) => item.label === label);
  return { template, items, byLabel, sent, locks };
}

test("the menu bar has no reload, locks in main, and sends only named commands", () => {
  const { template, items, byLabel, sent, locks } = setup();

  // Electron's default View menu could reload the page or open DevTools.
  const roles = items.map((item) => item.role).filter(Boolean);
  for (const role of ["reload", "forceReload", "toggleDevTools", "viewMenu"]) {
    assert.equal(roles.includes(role), false, role);
  }
  assert.ok(["undo", "redo", "cut", "copy", "paste", "selectAll", "quit"].every((role) => roles.includes(role)));
  assert.deepEqual(template.map((menu) => menu.label), ["Mnemo", "[menu.file]", "[menu.edit]", "[menu.window]"]);

  assert.equal(byLabel("[menu.lock]").accelerator, "CommandOrControl+L");
  byLabel("[menu.lock]").click();
  assert.deepEqual(locks, [true]);
  assert.deepEqual(sent, []);

  byLabel("[menu.settings]").click();
  byLabel("[menu.newItem]").click();
  byLabel("[menu.find]").click();
  assert.equal(byLabel("[menu.copyPassword]").accelerator, "CommandOrControl+Shift+C");
  byLabel("[menu.copyPassword]").click();
  assert.deepEqual(sent, MENU_COMMANDS.map((command) => ["menu:command", command]));
});

test("developer tools are in the menu only for npm start", () => {
  const roles = (options) => setup(options).items.map((item) => item.role);
  assert.equal(roles({ isPackaged: true }).includes("toggleDevTools"), false);
  assert.equal(roles({ isPackaged: false }).includes("toggleDevTools"), true);
});
