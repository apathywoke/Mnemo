// Opens every main screen and dialog of an unlocked vault and fails on any
// uncaught page error or console error, so a slice that breaks at run time
// is noticed even where no other test clicks.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createDataFolder, createVault, launchApp, removeDataFolder, TEST_PASSPHRASE, unlock } = require("./app");

async function waitForClipboard(app) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await app.evaluate(({ clipboard }) => clipboard.readText())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Nothing was copied.");
}

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
    // The generator opens beside the password. Escape closes only it.
    await page.click("#password-generator-button");
    await page.locator("#password-generator:not([hidden])").waitFor();
    assert.equal((await page.textContent("#generated-password")).length, 20);
    // The editor fits the detail area: nothing scrolls sideways.
    assert.ok(await page.evaluate(() => {
      const area = document.querySelector(".entry-detail-area");
      return area.scrollWidth <= area.clientWidth;
    }));
    // A press on its background keeps it open; its close button closes it.
    const generatorBox = await page.locator("#password-generator").boundingBox();
    await page.mouse.click(generatorBox.x + 6, generatorBox.y + generatorBox.height / 2);
    assert.ok(await page.locator("#password-generator").isVisible());
    await page.click("#close-password-generator");
    await page.locator("#password-generator").waitFor({ state: "hidden" });
    await page.click("#password-generator-button");
    await page.locator("#password-generator:not([hidden])").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#password-generator").waitFor({ state: "hidden" });
    assert.ok(await page.locator("#entry-dialog[open]").isVisible());
    assert.equal(await page.textContent("#generated-password"), "");
    // "Use password" puts the shown password in the field.
    await page.click("#password-generator-button");
    await page.fill("#password-length", "32");
    const generated = await page.textContent("#generated-password");
    assert.equal(generated.length, 32);
    await page.click("#generate-password-button");
    await page.locator("#password-generator").waitFor({ state: "hidden" });
    assert.equal(await page.inputValue("#entry-password"), generated);
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.click("#entry-list .entry-row");
    await page.locator("#entry-detail:not([hidden])").waitFor();
    // History appears once there is an earlier version, so edit the login.
    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    // The editor opens in place of the detail. The rest of the vault waits
    // until it closes, except Lock.
    const editingState = () => page.evaluate(() => ({
      detail: !document.querySelector("#entry-detail").checkVisibility(),
      sidebar: document.querySelector("#vault-sidebar").inert,
      list: document.querySelector(".entry-browser").inert,
      lock: document.querySelector("#lock-button").closest("[inert]") === null,
      modal: document.querySelector("#entry-dialog").matches(":modal"),
    }));
    assert.deepEqual(await editingState(), { detail: true, sidebar: true, list: true, lock: true, modal: false });
    await page.fill("#entry-name", "Generated, renamed");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    // The "close" event comes a moment after the dialog closes.
    await page.waitForFunction(() => !document.querySelector("#vault-sidebar").inert, null, { timeout: 3000 });
    await page.click("#history-button");
    await page.locator("#history-dialog[open]").waitFor();
    await closeDialog(page, "history-dialog", "close-history-dialog");

    // The detail's "⋯" menu: the keyboard opens it on its first item it can
    // use (this login has no website, so Load site icon is off), the arrows
    // stay on the items, Escape closes it and returns to the button.
    await page.focus("#entry-more-button");
    await page.keyboard.press("Enter");
    await page.locator("#entry-more-menu").waitFor();
    assert.equal(await page.getAttribute("#entry-more-button", "aria-expanded"), "true");
    assert.equal(await page.isDisabled("#fetch-site-icon-button"), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "delete-entry-button");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "delete-entry-button");
    await page.keyboard.press("Escape");
    await page.locator("#entry-more-menu").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "entry-more-button");
    // Opened with the pointer, Escape closes only the menu, not the detail.
    await page.click("#entry-more-button");
    await page.locator("#entry-more-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#entry-more-menu").waitFor({ state: "hidden" });
    assert.equal(await page.isVisible("#entry-detail"), true);
    // A press outside closes it too.
    await page.click("#entry-more-button");
    await page.locator("#entry-more-menu").waitFor();
    await page.click("#detail-name");
    await page.locator("#entry-more-menu").waitFor({ state: "hidden" });

    // A click on a value copies it, as its copy button does: main copies,
    // and the page only sees the toast.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.click("#detail-password");
    await page.locator(".toast-notification", { hasText: "Copied" }).first().waitFor();
    assert.ok((await app.evaluate(({ clipboard }) => clipboard.readText())).length >= 8);
    // Edit > Copy Password (⌘⇧C) copies the shown login's password the same way.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu:command", "copy-password"));
    await waitForClipboard(app);

    // ↑ and ↓ move through the list, from a row or from the search field.
    await page.click("#create-entry-button");
    await page.click("[data-new-item='login']");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", "Second");
    await page.fill("#entry-password", "Made-up test 12 password");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.querySelector("#vault-sidebar").inert, null, { timeout: 3000 });
    const selectedName = () => page.textContent("#entry-list .entry-row[aria-selected='true'] .entry-row-name");
    // The newest is first.
    await page.click("#entry-list .entry-row >> nth=0");
    assert.equal(await selectedName(), "Second");
    await page.keyboard.press("ArrowDown");
    assert.equal(await selectedName(), "Generated, renamed");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-selected")), "true");
    await page.keyboard.press("ArrowUp");
    assert.equal(await selectedName(), "Second");
    await page.focus("#entry-search");
    await page.keyboard.press("ArrowDown");
    assert.equal(await selectedName(), "Generated, renamed");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "entry-search");

    // Escape closes the editor and gives the vault back.
    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.querySelector("#vault-sidebar").inert, null, { timeout: 3000 });
    await page.locator("#entry-detail").waitFor();

    // Locking while editing closes the editor; after unlocking nothing is
    // left inert.
    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.click("#lock-button");
    await page.locator("#unlock-panel:not([hidden])").waitFor();
    assert.equal(await page.locator("#entry-dialog[open]").count(), 0);
    await unlock(page, TEST_PASSPHRASE);
    await page.locator("#open-panel:not([hidden])").waitFor();
    assert.equal(await page.evaluate(() => document.querySelectorAll("[inert]").length), 0);
    await page.click("#entry-list .entry-row");
    await page.locator("#entry-detail:not([hidden])").waitFor();

    // Every other item type opens its editor.
    for (const type of ["card", "note", "identity", "ssh"]) {
      await page.click("#create-entry-button");
      await page.click(`[data-new-item='${type}']`);
      await page.locator("#item-dialog[open]").waitFor();
      await closeDialog(page, "item-dialog", "close-item-dialog");
    }

    // The sidebar lists only the types the vault has; then the folder dialog.
    assert.equal(await page.locator("#vault-sidebar [data-type='card']").count(), 0);
    await page.click("#vault-sidebar .sidebar-item:has([data-type='login'])");
    await page.locator("#vault-sidebar [aria-current='true']:has([data-type='login'])").waitFor();
    await page.click("#vault-sidebar .sidebar-item-folders");
    await page.locator("#folders-dialog[open]").waitFor();
    await closeDialog(page, "folders-dialog", "close-folders-dialog");

    // Security opens the reports and is the selected item; picking another
    // item in the sidebar closes them.
    await page.click(".sidebar-item-security");
    await page.locator("#reports-view:not([hidden])").waitFor();
    await page.locator(".sidebar-item-security[aria-current='true']").waitFor();
    assert.equal(await page.locator("#vault-sidebar [aria-current='true']").count(), 1);
    await page.click("#vault-sidebar .sidebar-item >> nth=0");
    await page.locator("#reports-view").waitFor({ state: "hidden" });
    await page.click(".sidebar-item-security");
    await page.locator("#reports-view:not([hidden])").waitFor();
    await page.click("#reports-close");
    await page.locator("#reports-view").waitFor({ state: "hidden" });

    // Settings: every tab, the language, and the theme.
    await page.click("#vault-settings-button");
    await page.locator("#settings-dialog[open]").waitFor();
    for (const tab of ["updates", "security", "data", "backups", "vault", "general"]) {
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
