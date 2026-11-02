// Starts the real app from this checkout for end-to-end tests, with a fresh
// data folder per launch. Playwright drives it through Chromium's debugging
// protocol, which main.js allows only in unpackaged builds.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const electronBinary = require("electron");

const ROOT = path.join(__dirname, "..");
// Rated Strong by the built-in estimate; made-up test data only.
const TEST_PASSPHRASE = "violet anchor quarry 47 mosaic";

// `settings` is written as settings.json before the app starts. Update checks
// are off so that tests make no network requests.
async function createDataFolder(settings = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemo-e2e-"));
  await fs.writeFile(
    path.join(userDataDir, "settings.json"),
    JSON.stringify({ version: 1, language: "en", theme: "light", updateInterval: "off", ...settings }),
  );
  return userDataDir;
}

// `chromiumArgs` are extra Chromium switches, such as the ones
// capture-screens.js uses for repeatable rendering.
async function launchApp(userDataDir, { chromiumArgs = [] } = {}) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [ROOT, `--user-data-dir=${userDataDir}`, ...chromiumArgs],
    // No emulation: the theme comes from the app's own setting, through
    // nativeTheme, as for a user.
    colorScheme: null,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function removeDataFolder(userDataDir) {
  await fs.rm(userDataDir, { recursive: true, force: true });
}

// Visible panel ids: exactly one panel of the access flow is shown.
async function visiblePanel(page) {
  return page.locator("section.vault-panel:not([hidden])").first().getAttribute("id");
}

// From the first launch to an open, empty vault. The recovery key dialog
// and the backup offer that follow vault creation are dismissed.
// Confirms the recovery key shown in its dialog by typing its last 4
// characters, as a user does, and skips the backup offer that follows.
async function confirmRecoveryKey(page) {
  await page.locator("#recovery-key-dialog[open]").waitFor();
  const key = await page.textContent("#recovery-key-value");
  await page.fill("#recovery-key-confirm", key.trim().slice(-4));
  await page.click("#recovery-key-done");
  await page.locator("#recovery-backup-later").click();
  await page.locator("#recovery-key-dialog").waitFor({ state: "hidden" });
}

async function createVault(page, { name = "Test vault", passphrase = TEST_PASSPHRASE } = {}) {
  await page.locator("#setup-panel:not([hidden])").waitFor();
  await page.fill("#profile-name", name);
  await page.fill("#create-passphrase", passphrase);
  await page.fill("#confirm-passphrase", passphrase);
  await page.click("#create-form button[type='submit']");
  await confirmRecoveryKey(page);
  await page.locator("#open-panel:not([hidden])").waitFor();
}

module.exports = {
  confirmRecoveryKey,
  ROOT,
  TEST_PASSPHRASE,
  createDataFolder,
  createVault,
  launchApp,
  removeDataFolder,
  visiblePanel,
};
