const assert = require("node:assert/strict");
const test = require("node:test");
const { createMenuBar, drawMark } = require("../src/main/menu-bar");

// Fake Electron: a Tray that records its menu, a Menu that returns its
// template, and an image that records the template flag.
function setup({ menuBarIcon = true, unlocked = false } = {}) {
  const trays = [];
  const calls = { quit: 0, locks: [], created: 0, shown: 0 };
  let settings = { menuBarIcon };
  class Tray {
    constructor(image) {
      this.image = image;
      this.handlers = {};
      this.destroyed = false;
      this.menus = [];
      trays.push(this);
    }
    setToolTip(text) { this.toolTip = text; }
    on(event, handler) { this.handlers[event] = handler; }
    popUpContextMenu(menu) { this.menus.push(menu); }
    destroy() { this.destroyed = true; }
  }
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    show: () => { calls.shown += 1; },
    focus: () => {},
  };
  const ctx = {
    state: {
      tray: null,
      mainWindow: null,
      settingsStore: { get: () => settings },
      vaultStore: { isUnlocked: () => unlocked },
    },
    tr: (key) => `[${key}]`,
    lockVault: (notify) => calls.locks.push(notify),
    createWindow: () => { calls.created += 1; ctx.state.mainWindow = window; },
    electron: {
      app: { quit: () => { calls.quit += 1; }, focus: () => {} },
      Menu: { buildFromTemplate: (template) => template },
      Tray,
      nativeImage: {
        createFromBitmap: (buffer, options) => ({ buffer, options, setTemplateImage(value) { this.template = value; } }),
      },
    },
  };
  const menuBar = createMenuBar(ctx);
  return { ctx, menuBar, trays, calls, setSetting: (value) => { settings = { menuBarIcon: value }; } };
}

test("the menu bar icon follows the setting", () => {
  const { ctx, menuBar, trays, setSetting } = setup({ menuBarIcon: false });
  menuBar.updateMenuBar();
  assert.equal(trays.length, 0);
  setSetting(true);
  menuBar.updateMenuBar();
  menuBar.updateMenuBar();
  assert.equal(trays.length, 1, "one icon, however often it is updated");
  assert.equal(ctx.state.tray, trays[0]);
  assert.equal(trays[0].image.template, true);
  assert.deepEqual(trays[0].image.options, { width: 36, height: 36, scaleFactor: 2 });
  setSetting(false);
  menuBar.updateMenuBar();
  assert.equal(trays[0].destroyed, true);
  assert.equal(ctx.state.tray, null);
});

test("the menu opens the window, locks only an open vault, and quits", () => {
  const locked = setup();
  locked.menuBar.updateMenuBar();
  locked.trays[0].handlers.click();
  const [open, lock, separator, quit] = locked.trays[0].menus[0];
  assert.equal(open.label, "[menuBar.open]");
  assert.equal(lock.enabled, false);
  assert.equal(separator.type, "separator");
  open.click();
  assert.equal(locked.calls.created, 1, "a closed window is created again");
  open.click();
  assert.equal(locked.calls.shown, 1, "an existing window is shown");
  quit.click();
  assert.equal(locked.calls.quit, 1);

  const unlocked = setup({ unlocked: true });
  unlocked.menuBar.updateMenuBar();
  unlocked.trays[0].handlers["right-click"]();
  const lockItem = unlocked.trays[0].menus[0][1];
  assert.equal(lockItem.enabled, true);
  lockItem.click();
  assert.deepEqual(unlocked.calls.locks, [true]);
  // Labels only: the menu shows nothing from the vault.
  assert.deepEqual(unlocked.trays[0].menus[0].map((item) => item.label ?? item.type),
    ["[menuBar.open]", "[menu.lock]", "separator", "[menu.quit]"]);
});

test("the mark is drawn in black with transparency, empty in the middle", () => {
  const size = 36;
  const pixels = drawMark(size);
  assert.equal(pixels.length, size * size * 4);
  const alpha = (x, y) => pixels[(y * size + x) * 4 + 3];
  const color = Array.from(pixels).filter((_, index) => index % 4 !== 3);
  assert.ok(color.every((value) => value === 0), "only the alpha channel is set");
  assert.equal(alpha(size / 2, size / 2), 0, "the center is empty");
  assert.equal(alpha(Math.round(size * 0.85), size / 2), 255, "a ray to the right is solid");
  assert.equal(alpha(0, 0), 0, "the corners are empty");
});
