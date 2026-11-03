// Captures the main screens in the light and dark themes, for comparing the
// look of the app before and after a change that should not alter it (such
// as reorganizing the CSS):
//
//   node e2e/capture-screens.js <folder>
//   node e2e/compare-screens.js <before-folder> <after-folder>
//
// The same made-up data is entered on every run. Values that differ from run
// to run (the recovery key, times) are masked, toasts are removed, and
// animations run to their end, so two runs of the same code give equal
// images.
const fs = require("node:fs/promises");
const path = require("node:path");
const { confirmRecoveryKey, createDataFolder, launchApp, removeDataFolder, TEST_PASSPHRASE } = require("./app");

// Makes the page the same on every run. Playwright's own options for this
// (style, animations, caret) inject a <style> element, which the page's CSP
// refuses, so this works through the DOM and CSSOM instead: toasts (which
// come and go with timers) are removed, the caret is made transparent, and
// every finite animation and transition is allowed to finish.
// A fixed color profile, so colors do not depend on the display.
const RENDERING_ARGS = ["--force-color-profile=srgb"];

async function settle(page) {
  // Hover styles depend on where the last click left the pointer.
  await page.mouse.move(1, 1);
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById("toast-region")?.replaceChildren();
    for (const field of document.querySelectorAll("input, textarea")) field.style.caretColor = "transparent";
    const finite = document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
    // The entrance animations end on the element's own style but keep it
    // (fill-mode both), which keeps the element on a compositor layer
    // rasterized mid-animation: text then lands a fraction of a pixel off,
    // differently on every run. Cancelling a finished one changes nothing
    // visible and lets the layer be drawn again from its final state.
    for (const animation of document.getAnimations()) {
      if (animation.playState === "finished" && animation instanceof CSSAnimation) animation.cancel();
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(page, folder, name, mask = []) {
  await settle(page);
  await page.screenshot({
    path: path.join(folder, `${name}.png`),
    mask: mask.map((selector) => page.locator(selector)),
  });
}

async function addLogin(page, { name, username, url, password }) {
  await page.click("#create-entry-button");
  await page.click("[data-new-item='login']");
  await page.locator("#entry-dialog[open]").waitFor();
  await page.fill("#entry-name", name);
  await page.fill("#entry-url", url);
  await page.fill("#entry-username", username);
  await page.fill("#entry-password", password);
  await page.click("#entry-form button[type='submit']");
  await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
}

async function captureTheme(theme, folder) {
  const userDataDir = await createDataFolder({ theme });
  const { app, page } = await launchApp(userDataDir, { chromiumArgs: RENDERING_ARGS });
  const shot = (name, mask) => capture(page, folder, `${theme}-${name}`, mask);
  try {
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    await page.locator("#setup-panel:not([hidden])").waitFor();
    await shot("01-setup");
    await page.fill("#profile-name", "Personal");
    await page.fill("#create-passphrase", TEST_PASSPHRASE);
    await shot("02-setup-strength");

    await page.fill("#confirm-passphrase", TEST_PASSPHRASE);
    await page.click("#create-form button[type='submit']");
    await page.locator("#recovery-key-dialog[open]").waitFor();
    await shot("03-recovery-key", ["#recovery-key-value"]);
    // Finish creating the vault, as createVault() in app.js does.
    await confirmRecoveryKey(page);
    await page.locator("#open-panel:not([hidden])").waitFor();
    await shot("04-vault-empty");

    await page.click("#create-entry-button");
    await page.locator("#new-item-menu:not([hidden])").waitFor();
    await shot("05-new-item-menu");
    await page.click("[data-new-item='login']");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", "Example mail");
    await page.fill("#entry-url", "https://mail.example.com");
    await page.fill("#entry-username", "someone@example.com");
    await page.fill("#entry-password", "Made-up test 12 password");
    await shot("06-login-editor");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await addLogin(page, { name: "Bank", username: "someone", url: "https://bank.example", password: "password1" });

    await page.click("#create-entry-button");
    await page.click("[data-new-item='card']");
    await page.locator("#item-dialog[open]").waitFor();
    await shot("07-card-editor");
    await page.click("#close-item-dialog");
    await page.locator("#item-dialog[open]").waitFor({ state: "detached" });

    await page.click("#entry-list .entry-row >> nth=0");
    await page.locator("#entry-detail:not([hidden])").waitFor();
    await shot("08-login-detail");

    await page.click("#edit-entry-button");
    await page.locator("#entry-dialog[open]").waitFor();
    await page.fill("#entry-name", "Bank account");
    await page.click("#entry-form button[type='submit']");
    await page.locator("#entry-dialog[open]").waitFor({ state: "detached" });
    await page.click("#history-button");
    await page.locator("#history-dialog[open]").waitFor();
    // A fixed time, so the line keeps one width on every run.
    await page.evaluate(() => {
      for (const time of document.querySelectorAll("#history-list time")) time.textContent = "1 Jan 2026, 12:00";
    });
    await shot("09-history");
    await page.click("#close-history-dialog");
    await page.locator("#history-dialog[open]").waitFor({ state: "detached" });

    await page.click("#vault-sidebar .sidebar-item:has([data-type='card'])");
    await page.locator("#vault-sidebar [aria-current='true']:has([data-type='card'])").waitFor();
    await shot("10-sidebar-cards");
    // Back to all items.
    await page.click("#vault-sidebar .sidebar-item >> nth=0");
    await page.click("#vault-sidebar .sidebar-item-folders");
    await page.locator("#folders-dialog[open]").waitFor();
    await shot("11-folders");
    await page.click("#close-folders-dialog");
    await page.locator("#folders-dialog[open]").waitFor({ state: "detached" });

    await page.click("#reports-button");
    await page.locator("#reports-view:not([hidden])").waitFor();
    await shot("12-reports", ["#reports-summary"]);
    await page.click("#reports-close");
    await page.locator("#reports-view").waitFor({ state: "hidden" });

    await page.click("#vault-settings-button");
    await page.locator("#settings-dialog[open]").waitFor();
    for (const [index, tab] of ["general", "updates", "security", "data", "vault"].entries()) {
      await page.click(`#settings-tab-${tab}`);
      await page.locator(`#settings-pane-${tab}:not([hidden])`).waitFor();
      await shot(`${13 + index}-settings-${tab}`);
    }
    await page.click("#close-settings-dialog");
    await page.locator("#settings-dialog[open]").waitFor({ state: "detached" });

    await page.click("#lock-button");
    await page.locator("#unlock-panel:not([hidden])").waitFor();
    await shot("18-unlock");
    await page.click("#unlock-profiles-button");
    await page.locator("#profiles-panel:not([hidden])").waitFor();
    await shot("19-profiles", [".profile-choice-meta"]);
  } finally {
    await app.close();
    await removeDataFolder(userDataDir);
  }
}

async function main() {
  const folder = process.argv[2];
  if (!folder) throw new Error("Usage: node e2e/capture-screens.js <folder>");
  await fs.mkdir(folder, { recursive: true });
  for (const theme of ["light", "dark"]) await captureTheme(theme, folder);
  const files = (await fs.readdir(folder)).filter((name) => name.endsWith(".png"));
  console.log(`Captured ${files.length} screens in ${folder}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
