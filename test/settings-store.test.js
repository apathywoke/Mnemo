const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const SettingsStore = require("../src/main/settings-store");
const { makeTempDirectory } = require("../support/helpers");

const options = {
  isSupportedLanguage: (code) => ["en", "de", "ru"].includes(code),
  defaultLanguage: "ru",
};

test("settings default to the system language and persist a chosen language", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new SettingsStore(directory, options);
  assert.deepEqual(await store.load(), { language: "ru", theme: "system", updateInterval: "1d", backupReminder: true });

  assert.deepEqual(await store.setLanguage("de"), { language: "de", theme: "system", updateInterval: "1d", backupReminder: true });
  await assert.rejects(store.setLanguage("fr"), /Could not save the settings/);
  assert.deepEqual(store.get(), { language: "de", theme: "system", updateInterval: "1d", backupReminder: true });

  // Quick successive changes build on each other.
  await Promise.all([store.setTheme("light"), store.setLanguage("en"), store.setLanguage("de")]);
  assert.deepEqual(store.get(), { language: "de", theme: "light", updateInterval: "1d", backupReminder: true });
  await assert.rejects(store.setTheme("sepia"), /Could not save the settings/);
  assert.deepEqual(await store.setUpdateInterval("30m"), { language: "de", theme: "light", updateInterval: "30m", backupReminder: true });
  await assert.rejects(store.setUpdateInterval("5m"), /Could not save the settings/);
  await assert.rejects(store.setUpdateInterval(true), /Could not save the settings/);
  await store.setUpdateInterval("1d");

  const filePath = path.join(directory, "settings.json");
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { version: 1, language: "de", theme: "light", updateInterval: "1d", backupReminder: true, unconfirmedRecoveryKeys: [], outsideFolder: null });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "de", theme: "light", updateInterval: "1d", backupReminder: true });
});

test("corrupt or unsupported settings fall back to the default", async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "settings.json");
  for (const contents of ["{not json", JSON.stringify({ version: 1, language: "fr" }), JSON.stringify({ version: 2, language: "de" })]) {
    await fs.writeFile(filePath, contents);
    assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "ru", theme: "system", updateInterval: "1d", backupReminder: true });
  }
  // A bad theme does not discard a good language, and vice versa.
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", theme: "sepia" }));
  assert.deepEqual(await new SettingsStore(directory, options).load(), { language: "de", theme: "system", updateInterval: "1d", backupReminder: true });
});

test("the old on/off update setting carries over to an interval", async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "settings.json");
  const load = () => new SettingsStore(directory, options).load();
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", theme: "dark", autoUpdate: false }));
  assert.deepEqual(await load(), { language: "de", theme: "dark", updateInterval: "off", backupReminder: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", theme: "dark", autoUpdate: true }));
  assert.equal((await load()).updateInterval, "1d");
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", updateInterval: "6h" }));
  assert.equal((await load()).updateInterval, "6h");
  await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", updateInterval: "1m" }));
  assert.equal((await load()).updateInterval, "1d");
});

test("the backup reminder is shown until closed, and the choice is kept", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new SettingsStore(directory, options);
  assert.equal((await store.load()).backupReminder, true);
  assert.equal((await store.setBackupReminder(false)).backupReminder, false);
  assert.equal((await new SettingsStore(directory, options).load()).backupReminder, false);
  assert.equal((await store.setBackupReminder(true)).backupReminder, true);
  await assert.rejects(store.setBackupReminder("no"), /Could not save the settings/);

  // Anything but an explicit false shows it, as for settings from before it.
  const filePath = path.join(directory, "settings.json");
  for (const value of [undefined, "false", 0, null]) {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, language: "de", backupReminder: value }));
    assert.equal((await new SettingsStore(directory, options).load()).backupReminder, true);
  }
});

test("vaults with an unconfirmed recovery key are remembered, and kept out of get()", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new SettingsStore(directory, options);
  await store.load();
  const vault = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(store.isRecoveryKeyConfirmed(vault), true);
  await store.setRecoveryKeyConfirmed(vault, false);
  await store.setRecoveryKeyConfirmed(vault, false);
  assert.equal(store.isRecoveryKeyConfirmed(vault), false);
  assert.equal(Object.hasOwn(store.get(), "unconfirmedRecoveryKeys"), false);

  // Other settings changes keep the record, and it survives a relaunch.
  await store.setTheme("dark");
  const reloaded = new SettingsStore(directory, options);
  await reloaded.load();
  assert.equal(reloaded.isRecoveryKeyConfirmed(vault), false);
  assert.deepEqual(reloaded.unconfirmedRecoveryKeys, [vault]);

  await reloaded.setRecoveryKeyConfirmed(vault, true);
  assert.equal(reloaded.isRecoveryKeyConfirmed(vault), true);
  await assert.rejects(store.setRecoveryKeyConfirmed("../x", false), /Could not save the settings/);

  // Bad entries in the file are dropped.
  const filePath = path.join(directory, "settings.json");
  await fs.writeFile(filePath, JSON.stringify({ version: 1, unconfirmedRecoveryKeys: [vault, 7, "../x", ""] }));
  const fromFile = new SettingsStore(directory, options);
  await fromFile.load();
  assert.deepEqual(fromFile.unconfirmedRecoveryKeys, [vault]);
});
