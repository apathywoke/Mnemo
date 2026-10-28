// Renders build/icon.svg to build/icon.png (1024 px) and build/icon.icns.
//
//   npm run icon
//
// Runs inside Electron (a hidden window's canvas) so no image tools need to be
// installed; the .icns is assembled with macOS's sips and iconutil.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const BUILD = path.join(__dirname, "..", "build");
const SIZE = 1024;
// Every size an .icns iconset expects: [points, scale].
const ICONSET = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];

// Draws the SVG onto a canvas in a hidden window and returns the PNG bytes.
async function render() {
  const svg = fs.readFileSync(path.join(BUILD, "icon.svg"), "utf8");
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL("data:text/html;charset=utf-8,<!doctype html><title>icon</title>");
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ${SIZE};
      canvas.getContext("2d").drawImage(image, 0, 0, ${SIZE}, ${SIZE});
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not load icon.svg"));
    image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)};
  })`);
  window.destroy();
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

app.whenReady().then(async () => {
  try {
    const png = path.join(BUILD, "icon.png");
    fs.writeFileSync(png, await render());

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-icon-"));
    const iconset = path.join(work, "icon.iconset");
    fs.mkdirSync(iconset);
    for (const [points, scale] of ICONSET) {
      const name = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      const pixels = String(points * scale);
      execFileSync("/usr/bin/sips", ["-z", pixels, pixels, png, "--out", path.join(iconset, name)], { stdio: "ignore" });
    }
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(BUILD, "icon.icns")]);
    fs.rmSync(work, { recursive: true, force: true });
    console.log("Wrote build/icon.png and build/icon.icns");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
