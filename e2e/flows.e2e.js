// Flows through the real app that the smoke tests leave out: one-time
// codes, the trash, export without encryption, and import. Native dialogs
// are answered from the main process. Run with `npm run test:e2e`.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { TEST_PASSPHRASE, createDataFolder, createVault, launchApp, removeDataFolder } = require("./app");

const LOGIN = {
  name: "Example mail",
  username: "someone@example.com",
  password: "Made-up test 12 password",
  totp: "JBSWY3DPEHPK3PXP",
};

async function addLogin(page, login) {
  await page.click("#create-entry-button");
  await page.click("[data-new-item='login']");
  await page.locator("#entry-dialog[open]").waitFor();
  await page.fill("#entry-name", login.name);
  await page.fill("#entry-username", login.username);
  await page.fill("#entry-password", login.password);
  if (login.totp) await page.fill("#entry-totp", login.totp);
  await page.click("#entry-form button[type='submit']");
  await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
  await row(page, login.name).waitFor();
}

const row = (page, name) => page.locator("#entry-list .entry-row-name", { hasText: name });
const toast = (page, text) => page.locator(".toast-notification", { hasText: text }).first().waitFor();

async function moveShownLoginToTrash(page) {
  await page.click("#entry-more-button");
  await page.click("#delete-entry-button");
  await toast(page, "Moved to the trash");
}

// Every native message box is answered with the button at `response`.
const answerMessageBoxes = (app, response) =>
  app.evaluate(({ dialog }, value) => {
    dialog.showMessageBox = async () => ({ response: value, checkboxChecked: false });
  }, response);

async function clipboardText(app) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Nothing was copied.");
}

async function shownCode(page) {
  await page.locator("#detail-totp-field:not([hidden])").waitFor();
  await page.waitForFunction(() => /^\d{3}\s?\d{3}$/.test(document.querySelector("#detail-totp").textContent.trim()));
  return (await page.textContent("#detail-totp")).replace(/\s/g, "");
}

test("a deleted login waits in the trash, comes back, and is gone after the trash is emptied", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));
  const { app, page } = await launchApp(userDataDir);
  try {
    await createVault(page);
    await addLogin(page, LOGIN);
    await row(page, LOGIN.name).click();
    await moveShownLoginToTrash(page);
    assert.equal(await row(page, LOGIN.name).count(), 0);

    // The trash lists it, with a banner instead of the usual actions.
    await page.click("#vault-sidebar .sidebar-item-trash");
    await row(page, LOGIN.name).click();
    await page.locator("#trash-banner").waitFor();
    await page.click("#restore-entry-button");
    await toast(page, `${LOGIN.name} restored`);
    await page.click("#vault-sidebar .sidebar-item >> nth=0");
    await row(page, LOGIN.name).waitFor();

    // Emptying the trash asks in a native dialog; Cancel keeps the item.
    await row(page, LOGIN.name).click();
    await moveShownLoginToTrash(page);
    await page.click("#vault-sidebar .sidebar-item-trash");
    await row(page, LOGIN.name).waitFor();
    await answerMessageBoxes(app, 0);
    await page.click("#empty-trash-button");
    await page.waitForFunction(() => !document.querySelector("#empty-trash-button").disabled);
    assert.equal(await row(page, LOGIN.name).count(), 1);
    await answerMessageBoxes(app, 1);
    await page.click("#empty-trash-button");
    await toast(page, "Trash emptied");
    assert.equal(await row(page, LOGIN.name).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.vaultApp.listEntries()), []);
  } finally {
    await app.close();
  }
});

test("a login with a one-time code leaves in Bitwarden's format and comes back through import", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));
  const exportPath = path.join(userDataDir, "exported.json");
  const { app, page } = await launchApp(userDataDir);
  try {
    await createVault(page);
    await addLogin(page, LOGIN);
    await row(page, LOGIN.name).click();
    // The code is made in the main process; the page never gets the secret.
    assert.match(await shownCode(page), /^\d{6}$/);
    const entries = await page.evaluate(() => window.vaultApp.listEntries());
    assert.equal(JSON.stringify(entries).includes(LOGIN.totp), false);

    // Export without encryption: the passphrase again, a native warning,
    // then the save dialog.
    await answerMessageBoxes(app, 1);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportPath);
    await page.click("#vault-settings-button");
    await page.click("#settings-tab-advanced");
    await page.click("#settings-export-json-button");
    await page.fill("#settings-confirm-passphrase", "not the passphrase");
    await page.click("#settings-confirm-submit");
    await page.locator("#settings-confirm-error:not([hidden])").waitFor();
    assert.equal(await fs.access(exportPath).then(() => true, () => false), false);
    await page.fill("#settings-confirm-passphrase", TEST_PASSPHRASE);
    await page.click("#settings-confirm-submit");
    await toast(page, "Exported");
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8"));
    assert.equal(exported.encrypted, false);
    assert.equal(exported.items.length, 1);
    assert.equal(exported.items[0].login.password, LOGIN.password);
    assert.match(exported.items[0].login.totp, new RegExp(LOGIN.totp));
    await page.click("#close-settings-dialog");
    await page.locator("#settings-dialog[open]").waitFor({ state: "detached" });

    // Remove the login for good, then bring it back from the file.
    await row(page, LOGIN.name).click();
    await moveShownLoginToTrash(page);
    await page.click("#vault-sidebar .sidebar-item-trash");
    await page.click("#empty-trash-button");
    await toast(page, "Trash emptied");
    await page.click("#vault-sidebar .sidebar-item >> nth=0");

    await app.evaluate(({ dialog, shell }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      // Not the real Trash of whoever runs the tests.
      shell.trashItem = async (target) => {
        globalThis.trashedByTest = target;
      };
    }, exportPath);
    await page.click("#vault-settings-button");
    await page.click("#settings-tab-backups");
    await page.click("#settings-import-button");
    await page.locator("#import-dialog[open]").waitFor();
    await page.check("input[name='import-source'][value='bitwarden']");
    await page.click("#import-choose");
    await page.locator("#import-review-step:not([hidden])").waitFor();
    assert.equal(await page.textContent("#import-file-name"), "exported.json");
    assert.match(await page.textContent("#import-commit"), /1/);
    await page.click("#import-commit");
    await page.locator("#import-done-step:not([hidden])").waitFor();
    // The plain-text file is offered for the Trash, and main is asked to
    // move that file there.
    await page.locator("#import-trash-note:not([hidden])").waitFor();
    await page.click("#import-trash");
    await page.waitForFunction(() => document.querySelector("#import-trash").hidden);
    assert.equal(await app.evaluate(() => globalThis.trashedByTest), exportPath);
    await page.click("#import-done");
    await page.locator("#import-dialog[open]").waitFor({ state: "detached" });
    if (await page.locator("#settings-dialog[open]").count()) await page.click("#close-settings-dialog");

    // The imported login has its password and still makes codes.
    await row(page, LOGIN.name).click();
    assert.match(await shownCode(page), /^\d{6}$/);
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.click("#detail-password");
    assert.equal(await clipboardText(app), LOGIN.password);
  } finally {
    await app.close();
  }
});
