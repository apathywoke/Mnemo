const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const catalog = require("../src/renderer/shared/i18n/messages");
const {
  createTranslator,
  decodeIpcError,
  encodeIpcError,
} = require("../src/renderer/shared/i18n/translate");

const root = path.join(__dirname, "..");
const translator = createTranslator(catalog);
const english = catalog.messages.en;

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

// Main-process sources: every .js file at the root and under src/main/,
// except tests. The renderer lives in src/renderer/ and is not included.
async function mainProcessFiles() {
  const rootFiles = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(root, entry.name));
  const mainDirectory = path.join(root, "src", "main");
  const nested = await fs.stat(mainDirectory).then(() => listFiles(mainDirectory), () => []);
  return [...rootFiles, ...nested.filter((file) => file.endsWith(".js"))]
    .filter((file) => !file.endsWith(".test.js"));
}

// Key prefixes come from the catalog, so a new group of keys is checked as
// soon as it has its first English message.
const KEY_PREFIXES = new Set(Object.keys(english).map((key) => key.split(".")[0]));

// "profiles.json" looks like a key but is a file name.
const FILE_NAME = /\.(?:asar|bin|css|dmg|html|icns|js|json|pem|plist|png|sig|tmp|txt|vault|zip)$/;

function placeholders(template) {
  return Array.from(template.matchAll(/\{(\w+)\}/g), ([, name]) => name).sort();
}

test("every language translates every key with the same placeholders", () => {
  assert.deepEqual(catalog.languages.map(({ code }) => code), ["en", "de", "ru"]);
  for (const { code } of catalog.languages) {
    const table = catalog.messages[code];
    assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), code);
    for (const [key, template] of Object.entries(table)) {
      assert.ok(template.trim(), `${code}:${key} is empty`);
      assert.deepEqual(placeholders(template), placeholders(english[key]), `${code}:${key}`);
    }
  }
});

test("translator formats parameters, falls back to English, and picks system languages", () => {
  assert.equal(translator.t("ru", "toast.iconSaved", { hostname: "example.com" }),
    "Иконка с example.com сохранена в зашифрованном хранилище.");
  assert.equal(translator.t("xx", "vault.lock"), "Lock");
  assert.equal(translator.t("de", "missing.key"), "missing.key");
  assert.equal(translator.pickLanguage(["fr-FR", "de-AT", "en-US"]), "de");
  assert.equal(translator.pickLanguage(["ru_RU"]), "ru");
  assert.equal(translator.pickLanguage(["fr"]), "en");
  assert.equal(translator.pickLanguage(undefined), "en");
});

test("main-process errors are recognized and survive the IPC wrapper", () => {
  assert.deepEqual(
    translator.matchError("The master passphrase must be at least 7 characters long."),
    { key: "errors.passphraseTooShort", params: { min: "7" } },
  );
  assert.deepEqual(
    translator.matchError("Could not connect to example.com (ECONNRESET)."),
    { key: "errors.connectCode", params: { hostname: "example.com", code: "ECONNRESET" } },
  );
  assert.equal(translator.matchError("ENOENT: no such file"), null);

  const wrapped = `Error invoking remote method 'vault:unlock': Error: ${encodeIpcError("errors.unlockFirst", "Сначала разблокируйте хранилище.")}`;
  assert.deepEqual(decodeIpcError(wrapped), {
    key: "errors.unlockFirst",
    text: "Сначала разблокируйте хранилище.",
  });
  assert.equal(decodeIpcError("plain message"), null);
});

test("every English error thrown by the main process has a translation", async () => {
  const sources = await mainProcessFiles();
  const names = sources.map((file) => path.relative(root, file));
  assert.ok(names.includes("main.js") && names.includes("vault-store.js"), names.join(", "));
  const internalOnly = new Set(["Invalid vault file", "Invalid vault data", "Invalid profile registry", "mismatch", "missing password", "invalid csv", "invalid", "Invalid key", "truncated", "Invalid version", "Update key ${name} is not an Ed25519 public key", "Invalid password hash", "Invalid attachment"]);
  let checked = 0;
  for (const file of sources) {
    const source = await fs.readFile(file, "utf8");
    const pattern = /(?:new Error|unsupportedFavicon)\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g;
    for (const [, , literal] of source.matchAll(pattern)) {
      if (internalOnly.has(literal)) continue;
      // Replace template interpolations with sample values before matching.
      const sample = literal.replace(/\$\{[^}]+\}/g, "x");
      assert.ok(translator.matchError(sample), `${path.relative(root, file)}: no errors.* template for "${literal}"`);
      checked += 1;
    }
  }
  assert.ok(checked > 60);
});

test("every translation key used by the UI exists", async () => {
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const keys = new Set(Array.from(
    html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g),
    ([, key]) => key,
  ));
  const rendererFiles = (await listFiles(path.join(root, "src", "renderer")))
    .filter((file) => file.endsWith(".js") && !file.includes(`${path.sep}i18n${path.sep}`));
  for (const file of [...rendererFiles, ...(await mainProcessFiles())]) {
    const source = await fs.readFile(file, "utf8");
    // Any "prefix.name" string with a known prefix is a key...
    for (const [, key] of source.matchAll(/["']((?:[a-z]+[A-Za-z]*)\.[a-zA-Z]+)["']/g)) {
      if (KEY_PREFIXES.has(key.split(".")[0]) && !FILE_NAME.test(key)) keys.add(key);
    }
    // ...and so is a literal passed to t() or tr(), even with a new prefix.
    for (const [, key] of source.matchAll(/\b(?:t|tr)\(\s*["']([a-zA-Z]+\.[\w.]+)["']/g)) keys.add(key);
  }
  assert.ok(keys.size > 150);
  for (const key of keys) assert.ok(Object.hasOwn(english, key), `missing key ${key}`);
});

test("the language selector and its scripts are in the page", async () => {
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<select id="settings-language"/);
  const order = ["i18n/messages.js", "i18n/translate.js", "lib/i18n.js", "lib/dom.js"]
    .map((name) => html.indexOf(name));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index > 0));
});

test("every item type and field has a label", () => {
  const { ITEM_TYPES } = require("../src/renderer/shared/item-types");
  for (const [type, schema] of Object.entries(ITEM_TYPES)) {
    assert.ok(english[`item.type.${type}`], type);
    for (const field of schema.fields) assert.ok(english[`item.field.${type}.${field.key}`], `${type}.${field.key}`);
  }
  assert.ok(english["item.type.login"]);
  assert.ok(english["item.field.ssh.fingerprint"]);
});
