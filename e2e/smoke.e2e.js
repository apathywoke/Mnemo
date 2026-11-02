// Smoke tests against the real app: create a vault, add a login, lock,
// unlock, relaunch, and check that the page stays offline. Run with
// `npm run test:e2e` (needs the Electron binary; macOS or Linux with a
// display).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
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

// package.json says "mnemo", but the Keychain item of the Touch ID files is
// named after the app name, so main.js keeps the internal one.
// The internal name keeps every name-derived value (such as the "Safe
// Storage" Keychain item earlier versions used) as it was. Touch ID key
// files from those versions are deleted at startup.
test("the app keeps its internal name and deletes Keychain-based Touch ID files", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));
  const oldKeyFile = path.join(userDataDir, "biometric", "0f8fad5b-d9cb-469f-a165-70867728950e.key");
  await fs.mkdir(path.dirname(oldKeyFile), { recursive: true });
  await fs.writeFile(oldKeyFile, Buffer.concat([Buffer.from("v10"), Buffer.alloc(120, 7)]));

  const { app } = await launchApp(userDataDir);
  try {
    assert.equal(require("../package.json").name, "mnemo");
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getName()), "local-vault-prototype");
    const deadline = Date.now() + 10_000;
    while (await fs.access(oldKeyFile).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, "the old Touch ID file was not deleted");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await app.close();
  }
});

// Schema 4 seals notes per entry, and the page gets their text only after a
// real click (src/main/notes-reveal.js). The vault file never holds them in
// the clear.
test("notes and a secure note's text appear only after a real click, and are sealed on disk", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  const { app, page } = await launchApp(userDataDir);
  try {
    await createVault(page);
    const note = await page.evaluate(() => window.vaultApp.saveItem({
      id: "", type: "note", name: "Wi-Fi", notes: "Router in the hall", fields: { body: "Network: example-net" },
    }));
    assert.equal(note.hasNotes, true);
    assert.deepEqual(note.sealedFields, ["body"]);
    assert.ok(!JSON.stringify(note).includes("example-net"));

    await page.click("#lock-button");
    await unlock(page, TEST_PASSPHRASE);
    await page.locator("#entry-list .entry-row-name", { hasText: "Wi-Fi" }).click();
    const reveal = page.locator("#item-detail-fields .detail-reveal-button").first();
    await reveal.waitFor();
    assert.equal(await page.getByText("Network: example-net").count(), 0);

    // A page script cannot read the text without a real press.
    await page.waitForTimeout(3500);
    const scripted = await page.evaluate((id) => window.vaultApp.revealNotes(id).then(() => "revealed", () => "refused"), note.id);
    assert.equal(scripted, "refused");

    await reveal.click();
    await page.getByText("Network: example-net").waitFor();
    await page.getByText("Router in the hall").waitFor();

    const vaults = path.join(userDataDir, "vaults");
    const files = (await fs.readdir(vaults)).filter((name) => name.endsWith(".vault"));
    assert.equal(files.length, 1);
    const contents = await fs.readFile(path.join(vaults, files[0]), "utf8");
    assert.doesNotMatch(contents, /example-net|Router in the hall/);
  } finally {
    await app.close();
  }
});

// A login's notes: Show in the detail, the editor (opened by a real click on
// Edit), and an earlier version in the history.
test("a login's notes are revealed by Show, by Edit, and by opening a version", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  const { app, page } = await launchApp(userDataDir);
  try {
    await createVault(page);
    await page.click("#create-entry-button");
    await page.click("[data-new-item='login']");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", LOGIN.name);
    await page.fill("#entry-password", LOGIN.password);
    await page.fill("#entry-notes", "First notes");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });

    await page.locator("#entry-list .entry-row-name", { hasText: LOGIN.name }).click();
    await page.locator("#detail-notes-reveal:not([hidden])").waitFor();
    assert.equal(await page.locator("#detail-notes").isVisible(), false);
    await page.click("#detail-notes-reveal");
    await page.locator("#detail-notes", { hasText: "First notes" }).waitFor();

    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    assert.equal(await page.inputValue("#entry-notes"), "First notes");
    await page.fill("#entry-notes", "Second notes");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });

    await page.click("#history-button");
    await page.locator("#history-dialog[open]").waitFor();
    await page.locator("#history-list .history-version-head button").first().click();
    await page.locator("#history-list .history-field-value", { hasText: "First notes" }).waitFor();
  } finally {
    await app.close();
  }
});
