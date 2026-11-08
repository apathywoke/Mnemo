// Smoke tests against the real app: create a vault, add a login, lock,
// unlock, relaunch, and check that the page stays offline. Run with
// `npm run test:e2e` (needs the Electron binary; macOS or Linux with a
// display).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { TEST_PASSPHRASE, createDataFolder, createVault, fillSetup, launchApp, removeDataFolder, visiblePanel, unlock } = require("./app");

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
    // The lock screen comes down over the vault (transitions.css).
    await page.locator("#unlock-panel:not([hidden])").waitFor();
    assert.equal(await visiblePanel(page), "unlock-panel");
    assert.equal(await page.locator("#entry-list .entry-row").count(), 0);

    await unlock(page, "not the right passphrase");
    await page.locator("#unlock-error:not([hidden])").waitFor();
    assert.equal(await visiblePanel(page), "unlock-panel");

    await page.fill("#unlock-passphrase", "");
    await unlock(page, TEST_PASSPHRASE);
    await page.locator("#open-panel:not([hidden])").waitFor();
    await row.waitFor();

    // Nothing that drags the window lies over the vault: macOS takes real
    // clicks there before the page sees them.
    const dragOverVault = await page.evaluate(() => {
      const boxes = ["#vault-sidebar", ".entry-browser", ".entry-detail-area", "#vault-notices"]
        .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
        .filter((box) => box && box.width > 0 && box.height > 0);
      const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return Array.from(document.querySelectorAll("*"))
        .filter((element) => getComputedStyle(element).getPropertyValue("app-region") === "drag")
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && boxes.some((vault) => overlaps(box, vault));
        })
        .map((element) => element.tagName + "." + element.getAttribute("class"));
    });
    assert.deepEqual(dragOverVault, []);

    // The notices share one strip: the offer of a copy outside this Mac
    // comes first, the backup reminder is folded behind it ("1 more").
    await page.locator("#outside-copy-banner").waitFor();
    assert.equal(await page.locator("#backup-recovery-warning").isVisible(), false);
    assert.equal(await page.textContent("#vault-notices-toggle"), "1 more");
    // Security in the sidebar unfolds them, with the reports.
    assert.equal(await page.textContent(".sidebar-item-security .sidebar-item-count"), "2");
    await page.click(".sidebar-item-security");
    await page.locator("#vault-notices.is-expanded").waitFor();
    await page.locator("#reports-view:not([hidden])").waitFor();

    // The backup reminder shows until it is closed.
    await page.locator("#backup-recovery-warning").waitFor();
    await page.click("#dismiss-backup-warning");
    await page.locator("#backup-recovery-warning").waitFor({ state: "hidden" });
    // One notice left: no toggle, and the strip folds again.
    await page.locator("#vault-notices-toggle").waitFor({ state: "hidden" });
    assert.equal(await page.textContent(".sidebar-item-security .sidebar-item-count"), "1");
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
    // Closed in the previous launch, it stays closed (not only folded).
    assert.equal(await page.getAttribute("#backup-recovery-warning", "hidden"), "");
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

// A new recovery key is confirmed by typing its last characters, which main
// checks; a vault that locks first keeps a reminder until a new key is saved.
test("a new recovery key is confirmed by its last characters", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  const { app, page } = await launchApp(userDataDir);
  try {
    // Setup goes step by step: a passphrase main would refuse stays on the
    // first step, and Back returns to it from the second.
    await page.locator("#setup-panel:not([hidden])").waitFor();
    await page.fill("#profile-name", "Test vault");
    await page.fill("#create-passphrase", "short");
    await page.click("#setup-continue");
    await page.locator("#setup-step-error:not([hidden])").waitFor();
    assert.equal(await page.isVisible("#setup-step-2"), false);
    await page.fill("#create-passphrase", TEST_PASSPHRASE);
    await page.press("#create-passphrase", "Enter");
    await page.locator("#setup-step-2:not([hidden])").waitFor();
    // Confirming is still the passphrase step, shown in the title bar.
    assert.equal(await page.textContent(".setup-stepper [aria-current='step']"), "1Passphrase");
    assert.ok(await page.isVisible(".setup-stepper"));
    await page.click("#setup-step-back");
    await page.locator("#setup-step-1:not([hidden])").waitFor();
    await fillSetup(page);
    await page.locator("#recovery-key-dialog[open]").waitFor();
    assert.equal(await page.locator("#recovery-key-replaced").isHidden(), true);
    const key = (await page.textContent("#recovery-key-value")).trim();

    await page.fill("#recovery-key-confirm", key.slice(-4, -1));
    assert.equal(await page.isDisabled("#recovery-key-done"), true);
    const wrong = key.slice(-4) === "AAAA" ? "BBBB" : "AAAA";
    await page.fill("#recovery-key-confirm", wrong);
    await page.click("#recovery-key-done");
    await page.locator("#recovery-key-confirm-error:not([hidden])").waitFor();
    assert.equal(await page.locator("#recovery-backup-step").isHidden(), true);

    // Locking now leaves the key unconfirmed: the vault shows a reminder
    // that cannot be closed, in place of the backup reminder.
    // The Mac's screen locks (the app locks the vault and tells the page).
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await page.locator("#recovery-key-dialog").waitFor({ state: "hidden" });
    await page.locator("#unlock-panel:not([hidden])").waitFor();
    await page.fill("#unlock-passphrase", TEST_PASSPHRASE);
    await page.click("#unlock-form button[type='submit']");
    await page.locator("#open-panel:not([hidden])").waitFor();
    await page.locator("#recovery-unconfirmed-warning:not([hidden])").waitFor();
    assert.equal(await page.getAttribute("#backup-recovery-warning", "hidden"), "");
  } finally {
    await app.close();
  }
});

// Step 4b of the data safety plan: Settings → Backups locks the vault, lists
// its snapshots, and restores one with the passphrase of its time. The
// native confirmation is answered from the main process.
test("a snapshot is restored from Settings through the restore form", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));
  const { app, page } = await launchApp(userDataDir);
  try {
    await createVault(page);
    // The first save is followed by a snapshot at once; later saves wait.
    await addLogin(page, LOGIN);
    await page.locator("#entry-list .entry-row-name", { hasText: LOGIN.name }).waitFor();
    const second = { ...LOGIN, name: "Added after the snapshot" };
    await addLogin(page, second);
    await page.locator("#entry-list .entry-row-name", { hasText: second.name }).waitFor();

    await page.click("#vault-settings-button");
    await page.click("#settings-tab-backups");
    await page.locator("#settings-snapshot-status", { hasText: "Newest checked snapshot" }).waitFor();
    // A snapshot from just now reads green; no copy outside this Mac, red.
    assert.equal(await page.getAttribute("#settings-snapshot-status", "data-tone"), "good");
    assert.equal(await page.getAttribute("#settings-outside-status", "data-tone"), "bad");
    await page.click("#settings-restore-snapshot");
    await page.locator("#snapshots-panel:not([hidden])").waitFor();
    const rows = page.locator("#snapshot-list .profile-choice");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().textContent(), /On this Mac/);

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await rows.first().click();
    await page.locator("#restore-panel:not([hidden])").waitFor();
    assert.match(await page.textContent("#restore-description"), /Restore the snapshot from/);
    await page.fill("#restore-passphrase", TEST_PASSPHRASE);
    await page.click("#restore-form button[type='submit']");
    await page.locator("#open-panel:not([hidden])").waitFor();
    await page.locator("#entry-list .entry-row-name", { hasText: LOGIN.name }).waitFor();
    assert.equal(await page.locator("#entry-list .entry-row-name", { hasText: second.name }).count(), 0);

    // The replaced state was kept: the list now has it, pinned.
    const snapshots = await page.evaluate(() => window.vaultApp.listSnapshots());
    assert.ok(snapshots.some((item) => item.pinned === "restore"));
  } finally {
    await app.close();
  }
});
