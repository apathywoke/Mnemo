// Checking the recovery key and the master passphrase without changing
// anything, and the reminder to check the key (step 5 of the data safety plan).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const SettingsStore = require("../src/main/settings-store");
const { createRecoveryKeys, KEY_CHECK_INTERVAL_MS, KEY_CHECK_SNOOZE_MS } = require("../src/main/recovery-keys");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";

async function makeVault(t, name = "check.vault") {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, name));
  t.after(() => store.lock());
  await store.create(PASSPHRASE);
  await store.saveEntry(makeLogin());
  return { directory, store, recoveryKey: store.takeIssuedRecoveryKey() };
}

test("the recovery key is checked against the open vault, and nothing changes", async (t) => {
  const { store, recoveryKey } = await makeVault(t);
  const other = await makeVault(t, "other.vault");
  const before = await fs.readFile(store.filePath);

  assert.deepEqual(await store.checkRecoveryKey(recoveryKey), { matches: true });
  // Lower case and without dashes, as people type it.
  assert.deepEqual(await store.checkRecoveryKey(recoveryKey.replace(/-/g, "").toLowerCase()), { matches: true });
  await assert.rejects(store.checkRecoveryKey(other.recoveryKey), /does not open this vault/);
  const typo = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("0") ? "1" : "0"}`;
  await assert.rejects(store.checkRecoveryKey(typo), /not valid/);
  assert.deepEqual(await fs.readFile(store.filePath), before);
  assert.equal(store.isUnlocked(), true);

  // After a change of keys the old key no longer opens the vault.
  const newKey = await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  await assert.rejects(store.checkRecoveryKey(recoveryKey), /does not open this vault/);
  assert.deepEqual(await store.checkRecoveryKey(newKey), { matches: true });

  store.lock();
  await assert.rejects(store.checkRecoveryKey(newKey), /Unlock the vault first/);
});

test("the master passphrase is checked without changing anything", async (t) => {
  const { store } = await makeVault(t);
  const before = await fs.readFile(store.filePath);
  assert.deepEqual(await store.checkPassphrase(PASSPHRASE), { matches: true });
  await assert.rejects(store.checkPassphrase("not the passphrase at all"), /incorrect/);
  assert.deepEqual(await fs.readFile(store.filePath), before);
});

test("the vault screen asks to check the key every 90 days; Later waits 14", async (t) => {
  const directory = await makeTempDirectory(t);
  const settingsStore = new SettingsStore(directory, { isSupportedLanguage: () => true, defaultLanguage: "en" });
  await settingsStore.load();
  const clock = { now: Date.UTC(2026, 10, 4) };
  const state = { settingsStore, settingsLoaded: Promise.resolve(), pendingRecoveryKey: null, activeProfileId: "profile-1" };
  const keys = createRecoveryKeys({ state, activeProfileName: async () => "Personal", now: () => clock.now });

  assert.equal(await keys.isKeyCheckDue("profile-1"), false, "a vault seen for the first time starts its interval");
  clock.now += KEY_CHECK_INTERVAL_MS - 1;
  assert.equal(await keys.isKeyCheckDue("profile-1"), false);
  clock.now += 1;
  assert.equal(await keys.isKeyCheckDue("profile-1"), true);

  await keys.snoozeKeyCheck("profile-1");
  assert.equal(await keys.isKeyCheckDue("profile-1"), false);
  clock.now += KEY_CHECK_SNOOZE_MS;
  assert.equal(await keys.isKeyCheckDue("profile-1"), true);

  // A key that was never confirmed counts as saved once it checks out.
  await settingsStore.setRecoveryKeyConfirmed("profile-1", false);
  await keys.recordKeyChecked("profile-1");
  assert.equal(settingsStore.isRecoveryKeyConfirmed("profile-1"), true);
  assert.equal(await keys.isKeyCheckDue("profile-1"), false);

  // The schedule survives a restart and stays out of what the page reads.
  const reloaded = new SettingsStore(directory, { isSupportedLanguage: () => true, defaultLanguage: "en" });
  await reloaded.load();
  assert.equal(reloaded.getKeyCheckDue("profile-1"), clock.now + KEY_CHECK_INTERVAL_MS);
  assert.equal(Object.hasOwn(reloaded.get(), "keyCheckDue"), false);
});
