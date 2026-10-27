const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

test("selected login hides the detail empty state despite its flex layout", async () => {
  const styles = await fs.readFile(path.join(__dirname, "..", "styles.css"), "utf8");
  const hiddenStateRule = styles.match(/\.detail-empty\[hidden\]\s*\{([^}]*)\}/);

  assert.ok(hiddenStateRule, "detail empty state needs an explicit hidden rule");
  assert.match(hiddenStateRule[1], /display\s*:\s*none\s*;/);
});

test("every password input has an accessible visibility toggle", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const passwordInputs = Array.from(
    html.matchAll(/<input\b[^>]*\btype="password"[^>]*>/gs),
    ([tag]) => tag,
  );

  assert.ok(passwordInputs.length > 0);
  for (const input of passwordInputs) {
    const id = input.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(id, "password input must have an id");
    assert.match(html, new RegExp(`data-password-visibility-for="${id}"`));
  }
  assert.match(html, /id="toggle-password-button"[^>]*class="[^"]*password-visibility-toggle/);
});

test("vault creation, backup, and restore explain how access can be recovered", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");

  assert.match(html, /Mnemo cannot recover your master passphrase/);
  assert.match(html, /recovery key\. It is the only way back in/);
  assert.match(html, /Backups open with their master passphrase or recovery key/);
  assert.match(html, /Every backup opens with the master passphrase or the recovery key/);
});

test("password strength UI describes its estimate as a heuristic", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");

  assert.match(html, /rough estimate, not a guarantee that a password is safe/i);
});

test("Mnemo is the application brand while Local Vault remains a legacy profile name", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const main = await fs.readFile(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(html, /<title>Mnemo<\/title>/);
  assert.match(html, /aria-label="Mnemo"/);
  assert.match(html, /<span>MNEMO<\/span>/);
  assert.match(main, /title: "Mnemo"/);
});
