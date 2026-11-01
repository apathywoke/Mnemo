// Opens every main screen and dialog of an unlocked vault and fails on any
// uncaught page error or console error, so a slice that breaks at run time
// is noticed even where no other test clicks.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createDataFolder, createVault, launchApp, removeDataFolder } = require("./app");

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function closeDialog(page, dialogId, closeId) {
  await page.click(`#${closeId}`);
  await page.locator(`#${dialogId}[open]`).waitFor({ state: "detached" });
}

test("every main screen and dialog opens without page errors", async (t) => {
  const userDataDir = await createDataFolder();
  t.after(() => removeDataFolder(userDataDir));

  const { app, page } = await launchApp(userDataDir);
  try {
    const errors = collectErrors(page);
    await createVault(page);

    // A login with a generated password, then its detail and history.
    await page.click("#create-entry-button");
    await page.click("[data-new-item='login']");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", "Generated");
    await page.click("#generate-password-button");
    assert.ok((await page.inputValue("#entry-password")).length >= 8);
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.click("#entry-list .entry-row");
    await page.locator("#entry-detail:not([hidden])").waitFor();
    // History appears once there is an earlier version, so edit the login.
    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", "Generated, renamed");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.click("#history-button");
    await page.locator("#history-dialog[open]").waitFor();
    await closeDialog(page, "history-dialog", "close-history-dialog");

    // Every other item type opens its editor.
    for (const type of ["card", "note", "identity", "ssh"]) {
      await page.click("#create-entry-button");
      await page.click(`[data-new-item='${type}']`);
      await page.locator("#item-dialog[open]").waitFor();
      await closeDialog(page, "item-dialog", "close-item-dialog");
    }

    // The scope menu and the folder dialog.
    await page.click("#scope-button");
    await page.locator("#scope-menu:not([hidden])").waitFor();
    await page.locator("#scope-menu [role='menuitem']").last().click();
    await page.locator("#folders-dialog[open]").waitFor();
    await closeDialog(page, "folders-dialog", "close-folders-dialog");

    // Reports.
    await page.click("#reports-button");
    await page.locator("#reports-view:not([hidden])").waitFor();
    await page.click("#reports-close");
    await page.locator("#reports-view").waitFor({ state: "hidden" });

    // Settings: every tab, the language, and the theme.
    await page.click("#settings-button");
    await page.locator("#settings-dialog[open]").waitFor();
    for (const tab of ["updates", "security", "data", "vault", "general"]) {
      await page.click(`#settings-tab-${tab}`);
      await page.locator(`#settings-pane-${tab}:not([hidden])`).waitFor();
    }
    await page.selectOption("#settings-language", "de");
    await page.waitForFunction(() => document.documentElement.lang === "de");
    await page.selectOption("#settings-language", "en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.click(".theme-options input[value='dark'] + *, .theme-options label:has(input[value='dark'])");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await closeDialog(page, "settings-dialog", "close-settings-dialog");

    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});
