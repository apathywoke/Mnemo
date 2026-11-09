// The icon in the macOS menu bar (Settings → General). Its menu opens the
// window, locks the vault, or quits; it shows nothing from the vault. The
// menu is built when it is opened, so Lock is offered only while a vault
// is open and the labels follow the language.
//
// The icon is drawn here, as a template image (black with transparency,
// which macOS tints for the menu bar), so no image file is packaged.

const ICON_POINTS = 18;
const ICON_SCALE = 2;
// The asterisk of the app's mark: eight rays around an empty center.
const RAY_INNER = 0.2;
const RAY_OUTER = 0.46;
const RAY_WIDTH = 0.11;

/** RGBA pixels of the mark, `size` pixels square. */
function drawMark(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const half = (RAY_WIDTH * size) / 2;
  const rays = Array.from({ length: 8 }, (_, index) => {
    const angle = (index * Math.PI) / 4;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    return {
      x1: center + dx * RAY_INNER * size, y1: center + dy * RAY_INNER * size,
      x2: center + dx * RAY_OUTER * size, y2: center + dy * RAY_OUTER * size,
    };
  });
  // Distance from a pixel's center to the nearest ray, as a round-capped
  // stroke; one pixel of soft edge.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let nearest = Infinity;
      for (const ray of rays) {
        const vx = ray.x2 - ray.x1;
        const vy = ray.y2 - ray.y1;
        const t = Math.max(0, Math.min(1, ((px - ray.x1) * vx + (py - ray.y1) * vy) / (vx * vx + vy * vy)));
        nearest = Math.min(nearest, Math.hypot(px - (ray.x1 + t * vx), py - (ray.y1 + t * vy)));
      }
      const alpha = Math.max(0, Math.min(1, half + 0.5 - nearest));
      pixels[(y * size + x) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function createMenuBar(ctx) {
  const { state, tr, lockVault } = ctx;
  const { app, Menu, Tray, nativeImage } = ctx.electron;

  function showWindow() {
    const window = state.mainWindow;
    if (!window || window.isDestroyed()) {
      ctx.createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    app.focus?.({ steal: true });
  }

  function buildMenu() {
    const unlocked = state.vaultStore?.isUnlocked() ?? false;
    return Menu.buildFromTemplate([
      { label: tr("menuBar.open"), click: showWindow },
      { label: tr("menu.lock"), enabled: unlocked, click: () => lockVault(true) },
      { type: "separator" },
      { label: tr("menu.quit"), click: () => app.quit() },
    ]);
  }

  function createTray() {
    const size = ICON_POINTS * ICON_SCALE;
    const image = nativeImage.createFromBitmap(drawMark(size), {
      width: size, height: size, scaleFactor: ICON_SCALE,
    });
    image.setTemplateImage(true);
    const tray = new Tray(image);
    tray.setToolTip("Mnemo");
    const open = () => tray.popUpContextMenu(buildMenu());
    tray.on("click", open);
    tray.on("right-click", open);
    return tray;
  }

  // Shows or removes the icon to match the setting.
  function updateMenuBar() {
    const shown = state.settingsStore?.get().menuBarIcon === true;
    if (shown && !state.tray && Tray) state.tray = createTray();
    if (!shown && state.tray) {
      state.tray.destroy();
      state.tray = null;
    }
  }

  return { updateMenuBar };
}

module.exports = { createMenuBar, drawMark };
