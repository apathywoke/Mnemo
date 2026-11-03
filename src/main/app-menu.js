// The macOS menu bar. It replaces Electron's default menu, whose View menu
// can reload the page (which would leave main unlocked behind a fresh page)
// and open the developer tools.
//
// Lock is done here, like a screen lock. The other commands are sent to the
// page as "menu:command" with a fixed name; the page acts on them only where
// they make sense (an open vault for New item and Find).

const MENU_COMMANDS = Object.freeze(["settings", "new-item", "find"]);

function createAppMenu(ctx) {
  const { state, tr, lockVault } = ctx;
  const { app, Menu } = ctx.electron;

  function send(command) {
    const window = state.mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("menu:command", command);
  }

  /** @type {Electron.MenuItemConstructorOptions} */
  const separator = { type: "separator" };

  // Built again when the language changes.
  function buildAppMenu() {
    if (!Menu) return;
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [
      {
        label: "Mnemo",
        submenu: [
          { role: "about", label: tr("menu.about") },
          separator,
          { label: tr("menu.settings"), accelerator: "CommandOrControl+,", click: () => send("settings") },
          separator,
          { role: "services", label: tr("menu.services") },
          separator,
          { role: "hide", label: tr("menu.hide") },
          { role: "hideOthers", label: tr("menu.hideOthers") },
          { role: "unhide", label: tr("menu.showAll") },
          separator,
          { role: "quit", label: tr("menu.quit") },
        ],
      },
      {
        label: tr("menu.file"),
        submenu: [
          { label: tr("menu.newItem"), accelerator: "CommandOrControl+N", click: () => send("new-item") },
          { label: tr("menu.find"), accelerator: "CommandOrControl+F", click: () => send("find") },
          separator,
          { label: tr("menu.lock"), accelerator: "CommandOrControl+L", click: () => lockVault(true) },
          separator,
          { role: "close", label: tr("menu.closeWindow") },
        ],
      },
      {
        label: tr("menu.edit"),
        submenu: [
          { role: "undo", label: tr("menu.undo") },
          { role: "redo", label: tr("menu.redo") },
          separator,
          { role: "cut", label: tr("menu.cut") },
          { role: "copy", label: tr("menu.copy") },
          { role: "paste", label: tr("menu.paste") },
          { role: "selectAll", label: tr("menu.selectAll") },
        ],
      },
      {
        label: tr("menu.window"),
        submenu: [
          { role: "minimize", label: tr("menu.minimize") },
          { role: "zoom", label: tr("menu.zoom") },
          separator,
          { role: "front", label: tr("menu.front") },
        ],
      },
    ];
    // Developer tools only for `npm start`; packaged builds disable them.
    if (!app.isPackaged) {
      template.push({ label: "Develop", submenu: [{ role: "toggleDevTools" }] });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  return { buildAppMenu };
}

module.exports = { MENU_COMMANDS, createAppMenu };
