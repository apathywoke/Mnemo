// Smoke tests against the real app: create a vault, add a login, lock,
// unlock, relaunch, and check that the page stays offline. Run with
// `npm run test:e2e` (needs the Electron binary; macOS or Linux with a
// display).
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TEST_PASSPHRASE,
  createDataFolder,
  createVault,
  launchApp,
  removeDataFolder,
  visiblePanel,
} = require("./app");

const LOGIN = { name: "Example mail", username: "someone@example.com", password: "Made-up test 12 password" };

async function addLogin(page, login) {
  await page.click("#create-entry-button");
  await page.click("[data-new-item='login']");
  await page.locator("#entry-dialog[open]").waitFor();
  await page.fill("#entry-name", login.name);
  await page.fill("#entry-username", login.username);
  await page.fill("#entry-password", login.password);
  await page.click("#entry-form button[type='submit']");
  await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
}

async function unlock(page, passphrase) {
  await page.locator("#unlock-panel:not([hidden])").waitFor();
  await page.fill("#unlock-passphrase", passphrase);
  await page.click("#unlock-form button[type='submit']");
}

test("a vault is created, keeps a login across lock and relaunch, and never gives the page a password", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  let { app, page } = await launchApp(userDataDir);
  try {
    assert.equal(await visiblePanel(page), "setup-panel");
    await createVault(page);
    await addLogin(page, LOGIN);

    const row = page.locator("#entry-list .entry-row-name", { hasText: LOGIN.name });
    await row.waitFor();
    // The page receives entry metadata only.
    const entries = await page.evaluate(() => window.vaultApp.listEntries());
    assert.equal(entries.length, 1);
    assert.ok(!JSON.stringify(entries).includes(LOGIN.password));
    const details = await page.evaluate((id) => window.vaultApp.getEntry(id), entries[0].id);
    assert.ok(!JSON.stringify(details).includes(LOGIN.password));

    await page.click("#lock-button");
    assert.equal(await visiblePanel(page), "unlock-panel");
    assert.equal(await page.locator("#entry-list .entry-row").count(), 0);

    await unlock(page, "not the right passphrase");
    await page.locator("#unlock-error:not([hidden])").waitFor();
    assert.equal(await visiblePanel(page), "unlock-panel");

    await page.fill("#unlock-passphrase", "");
    await unlock(page, TEST_PASSPHRASE);
    await page.locator("#open-panel:not([hidden])").waitFor();
    await row.waitFor();
  } finally {
    await app.close();
  }

  // The vault is on disk: a new launch lists the profile, asks for the
  // passphrase, and shows the login.
  ({ app, page } = await launchApp(userDataDir));
  try {
    await page.locator("#profiles-panel:not([hidden])").waitFor();
    await page.click("#profile-list .profile-choice");
    await unlock(page, TEST_PASSPHRASE);
    await page.locator("#open-panel:not([hidden])").waitFor();
    await page.locator("#entry-list .entry-row-name", { hasText: LOGIN.name }).waitFor();
  } finally {
    await app.close();
  }
});

test("the page makes no network requests and has no WebRTC", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  const { app, page } = await launchApp(userDataDir);
  try {
    const requested = [];
    page.on("request", (request) => requested.push(request.url()));

    await createVault(page);
    await addLogin(page, LOGIN);
    await page.locator("#entry-list .entry-row").first().waitFor();

    const probe = await page.evaluate(async () => {
      let fetched = "blocked";
      try {
        await fetch("https://example.com/");
        fetched = "reached";
      } catch {
        // Refused by connect-src 'none'.
      }
      return {
        fetched,
        peerConnection: typeof window.RTCPeerConnection,
        dataChannel: typeof window.RTCDataChannel,
      };
    });
    assert.deepEqual(probe, { fetched: "blocked", peerConnection: "undefined", dataChannel: "undefined" });

    const remote = requested.filter((url) => !url.startsWith("app://mnemo/") && !url.startsWith("data:"));
    // The probe above is the only attempt; it must not have left the page.
    assert.deepEqual(remote.filter((url) => url !== "https://example.com/"), []);
  } finally {
    await app.close();
  }
});
