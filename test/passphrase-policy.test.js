const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { estimatePasswordStrength } = require("../src/shared/password-tools");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const STRONG = "correct horse battery staple";
const CYRILLIC = "мой длинный пароль для сейфа";
// A vault made before this policy, with the 7-character passphrase "seven77"
// and one login. It was created with the regular API; nothing bypasses the
// policy to make it.
const FIXTURE = path.join(__dirname, "fixtures", "seven-character-passphrase.vault");

async function storeIn(t, name = "policy.vault") {
  const directory = await makeTempDirectory(t);
  return { directory, store: new VaultStore(path.join(directory, name)) };
}

test("a new master passphrase needs 12 characters and a Strong rating", async (t) => {
  const { store } = await storeIn(t);
  for (const [passphrase, message] of [
    ["seven77", /at least 12 characters/],
    ["abcdefghijk", /at least 12 characters/],
    // 6 code points, 12 UTF-16 units: counted as typed.
    ["🔒🔒🔒🔒🔒🔒", /at least 12 characters/],
    ["abcdefghijkl", /too easy to guess/],
    ["Password1234", /too easy to guess/],
    ["aaaaaaaaaaaaaaaaaaaa", /too easy to guess/],
    ["another passphrase", /too easy to guess/],
  ]) {
    await assert.rejects(store.create(passphrase), message, passphrase);
  }
  await assert.rejects(store.getStatus().then(({ vaultExists }) => {
    if (!vaultExists) throw new Error("no vault");
  }), /no vault/);

  await store.create(CYRILLIC);
  await store.saveEntry(makeLogin());
  store.lock();
  await store.unlock(CYRILLIC);
  assert.equal(store.listEntries().length, 1);
});

test("recovery and restore with the recovery key apply the same policy", async (t) => {
  const { directory, store } = await storeIn(t);
  await store.create(STRONG);
  const recoveryKey = store.takeIssuedRecoveryKey();
  await assert.rejects(store.recoverWithKey(recoveryKey, "weak weak 1"), /at least 12 characters/);
  await assert.rejects(store.recoverWithKey(recoveryKey, "password password"), /too easy to guess/);
  const backupPath = path.join(directory, "backup.vault");
  await store.exportBackup(backupPath);

  const { store: target } = await storeIn(t, "target.vault");
  await assert.rejects(
    target.restoreBackup(backupPath, { recoveryKey, newPassphrase: "password password" }),
    /too easy to guess/,
  );
  await target.restoreBackup(backupPath, { recoveryKey, newPassphrase: CYRILLIC });
  target.lock();
  await target.unlock(CYRILLIC);
});

test("a vault with an old 7-character passphrase still opens and works", async (t) => {
  const { directory, store } = await storeIn(t);
  await fs.copyFile(FIXTURE, store.filePath);

  await store.unlock("seven77");
  assert.deepEqual(store.listEntries().map((entry) => entry.name), ["Old login"]);
  assert.equal(store.revealPassword(store.listEntries()[0].id), "old-password");
  await store.verifyPassphrase("seven77");
  // Checks of the current passphrase are unchanged: a new recovery key,
  // backups, restoring and importing a backup by its passphrase.
  const recoveryKey = await store.createRecoveryKey("seven77");
  const backupPath = path.join(directory, "old.vault");
  await store.exportBackup(backupPath);
  const { store: restored } = await storeIn(t, "restored.vault");
  await restored.restoreBackup(backupPath, "seven77");
  assert.equal(restored.listEntries().length, 1);
  assert.equal((await VaultStore.readBackupLogins(backupPath, "seven77")).logins[0].password, "old-password");

  // Setting a passphrase is where the policy applies.
  store.lock();
  await assert.rejects(store.recoverWithKey(recoveryKey, "seven88"), /at least 12 characters/);
  await store.recoverWithKey(recoveryKey, STRONG);
  store.lock();
  await store.unlock(STRONG);
  assert.equal(store.listEntries().length, 1);
});

test("the estimate counts letters of any script and length in code points", () => {
  assert.equal(estimatePasswordStrength(CYRILLIC).level, "strong");
  assert.equal(estimatePasswordStrength(STRONG).level, "strong");
  assert.equal(estimatePasswordStrength("Мой Пароль 2026!").level, "strong");
  assert.equal(estimatePasswordStrength("пароль").level, "weak");
  // Eight emoji are eight characters, not sixteen.
  assert.equal(estimatePasswordStrength("🔒".repeat(8)).level, estimatePasswordStrength("!".repeat(8)).level);
});
