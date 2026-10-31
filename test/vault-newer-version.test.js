const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const catalog = require("../src/renderer/shared/i18n/messages");
const { createTranslator } = require("../src/renderer/shared/i18n/translate");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "violet lantern orbit quietly";
const NEWER_VAULT = /^Error: This vault was saved by a newer version of Mnemo\. Update Mnemo to open it\.$/;
const NEWER_BACKUP = /^Error: This backup was made by a newer version of Mnemo\. Update Mnemo to use it\.$/;
const WRONG_PASSPHRASE = /Check the master passphrase/;

// A vault as a newer Mnemo would leave it: the same file format, with vault
// data of a schema this version does not know.
async function makeNewerVault(t) {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "newer.vault");
  const store = new VaultStore(filePath);
  await store.create(PASSPHRASE);
  const recoveryKey = store.takeIssuedRecoveryKey();
  await store.saveEntry(makeLogin());
  const dataKey = store.exportDataKey();
  t.after(() => dataKey.fill(0));
  await store.persistVaultData({ ...store.vaultData, schemaVersion: 4 });
  store.lock();
  return { directory, filePath, recoveryKey, dataKey };
}

test("a vault saved by a newer version says so on every way in, and is not changed", async (t) => {
  const { filePath, recoveryKey, dataKey } = await makeNewerVault(t);
  const before = await fs.readFile(filePath);
  const store = new VaultStore(filePath);

  await assert.rejects(store.unlock(PASSPHRASE), NEWER_VAULT);
  assert.equal(store.isUnlocked(), false);
  // A wrong passphrase is still reported as one: the schema is only read
  // after the data decrypts.
  await assert.rejects(store.unlock("a wrong but long passphrase"), WRONG_PASSPHRASE);
  // Touch ID: not "Touch ID can no longer unlock this vault", so the IPC
  // handler keeps Touch ID turned on for after the update.
  await assert.rejects(store.unlockWithDataKey(dataKey), NEWER_VAULT);
  await assert.rejects(store.recoverWithKey(recoveryKey, NEW_PASSPHRASE), NEWER_VAULT);

  assert.deepEqual(await fs.readFile(filePath), before);
});

test("a vault file in a newer format says so before any passphrase check", async (t) => {
  const { filePath } = await makeNewerVault(t);
  const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
  await fs.writeFile(filePath, JSON.stringify({ ...envelope, version: 3 }));
  const store = new VaultStore(filePath);
  await assert.rejects(store.unlock(PASSPHRASE), NEWER_VAULT);
  await assert.rejects(store.unlock("a wrong but long passphrase"), NEWER_VAULT);

  // Another format name, or a version that is not a whole number, is a
  // damaged file, as before.
  for (const changed of [{ ...envelope, format: "other-app", version: 3 }, { ...envelope, version: 2.5 }, { ...envelope, version: "3" }]) {
    await fs.writeFile(filePath, JSON.stringify(changed));
    await assert.rejects(new VaultStore(filePath).unlock(PASSPHRASE), WRONG_PASSPHRASE);
  }
});

test("a backup made by a newer version says so and replaces nothing", async (t) => {
  const { filePath: backupPath, recoveryKey } = await makeNewerVault(t);
  const directory = await makeTempDirectory(t);
  const currentPath = path.join(directory, "current.vault");
  const current = new VaultStore(currentPath);
  await current.create(PASSPHRASE);
  await current.saveEntry(makeLogin({ name: "Current" }));
  const before = await fs.readFile(currentPath);

  await assert.rejects(current.restoreBackup(backupPath, PASSPHRASE), NEWER_BACKUP);
  await assert.rejects(current.restoreBackup(backupPath, { recoveryKey, newPassphrase: NEW_PASSPHRASE }), NEWER_BACKUP);
  await assert.rejects(VaultStore.readBackupLogins(backupPath, PASSPHRASE), NEWER_BACKUP);
  await assert.rejects(VaultStore.readBackupLogins(backupPath, { recoveryKey }), NEWER_BACKUP);

  assert.deepEqual(await fs.readFile(currentPath), before);
  assert.deepEqual(current.listEntries().map(({ name }) => name), ["Current"]);
});

test("the messages reach the renderer translated", () => {
  const translator = createTranslator(catalog);
  const vault = "This vault was saved by a newer version of Mnemo. Update Mnemo to open it.";
  const backup = "This backup was made by a newer version of Mnemo. Update Mnemo to use it.";
  assert.equal(translator.matchError(vault).key, "errors.vaultFromNewerVersion");
  assert.equal(translator.matchError(backup).key, "errors.backupFromNewerVersion");
  assert.match(translator.t("ru", "errors.vaultFromNewerVersion"), /более новой версией Mnemo/);
  assert.match(translator.t("de", "errors.backupFromNewerVersion"), /neueren Version von Mnemo/);
});
