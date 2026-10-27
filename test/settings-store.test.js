const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const SettingsStore = require("../settings-store");
const { makeTempDirectory } = require("../support/helpers");

const options = {
  isSupportedLanguage: (code) => ["en", "de", "ru"].includes(code),
  defaultLanguage: "ru",
};

test("settings default to the system language and persist a chosen language", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new SettingsStore(directory, options);
  assert.deepEqual(await store.load(), { language: "ru", theme: "system", autoUpdate: true });

  assert.deepEqual(await store.setLanguage("de"), { language: "de", theme: "system", autoUpdate: true });
  await assert.rejects(store.setLanguage("fr"), /Could not save the settings/);
  assert.deepEqual(store.get(), { language: "de", theme: "system", autoUpdate: true });

  // Quick successive changes build on each other.
  await Promise.all([store.setTheme("light"), store.setLanguage("en"), store.setLanguage("de")]);
  assert.deepEqual(store.get(), { language: "de", theme: "light", autoUpdate: true });
  await assert.rejects(store.setTheme("sepia"), /Could not save the settings/);
  assert.deepEqual(await store.setAutoUpdate(false), { language: "de", theme: "light", autoUpdate: false });
  await assert.rejects(store.setAutoUpdate("yes"), /Could not save the settings/);
  await store.setAutoUpdate(true);

  const filePath = path.join(directory, "settings.json");
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { version: 1, language: "de", theme: "light", autoUpdate: true });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "de", theme: "light", autoUpdate: true });
});

test("corrupt or unsupported settings fall back to the default", async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "settings.json");
  for (const contents of ["{not json", JSON.stringify({ version: 1, language: "fr" }), JSON.stringify({ version: 2, language: "de" })]) {
    await fs.writeFile(filePath, contents);
    assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "ru", theme: "system", autoUpdate: true });
  }
  // A bad theme does not discard a good language, and vice versa.
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", theme: "sepia" }));
  assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "de", theme: "system", autoUpdate: true });
});
