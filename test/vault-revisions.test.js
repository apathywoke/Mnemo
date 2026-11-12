// Rollback detection (docs/design-rollback.md, section 11): the revision
// inside the vault, the record outside it, the check on every way to open a
// vault, and restores.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const ProfileManager = require("../src/main/profile-manager");
const { validateVaultData } = require("../src/main/vault/schema");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";

// A store with rollback detection on. `asked` collects what the user was
// asked; `answer.open` is their reply to the next questions.
async function makeTracked(t, { profileId = "profile-one", directory = null } = {}) {
  const folder = directory ?? await makeTempDirectory(t);
  const asked = [];
  const answer = { open: false };
  const recordPath = path.join(folder, "revisions", `${profileId}.json`);
  const store = new VaultStore(path.join(folder, `${profileId}.vault`), {
    revisions: {
      recordPath,
      profileId,
      confirm: async (finding) => {
        asked.push(finding);
        return answer.open;
      },
    },
  });
  return { directory: folder, store, asked, answer, recordPath };
}

async function createTracked(t, options) {
  const tracked = await makeTracked(t, options);
  await tracked.store.create(PASSPHRASE);
  const recoveryKey = tracked.store.takeIssuedRecoveryKey();
  return { ...tracked, recoveryKey };
}

const readRecord = async (recordPath) => JSON.parse(await fs.readFile(recordPath, "utf8"));
const exists = (filePath) => fs.access(filePath).then(() => true, () => false);
const save = (store, name = "Login") => store.saveEntry(makeLogin({ name }));
const kinds = (asked) => asked.map((finding) => finding.kind);

async function reopen(store) {
  store.lock();
  return store.unlock(PASSPHRASE);
}

test("every write raises the revision inside the vault, and the record follows it", async (t) => {
  const { store, recordPath, asked } = await createTracked(t);
  const { vaultId, revisionKey } = store.vaultData;
  assert.equal(store.vaultData.revision, 1);
  assert.equal(validateVaultData(store.vaultData), true);
  assert.deepEqual(await readRecord(recordPath).then(({ vaultId: id, revision }) => ({ id, revision })), { id: vaultId, revision: 1 });

  const createdAt = store.vaultData.savedAt;
  await save(store);
  assert.equal(store.vaultData.revision, 2);
  assert.ok(store.vaultData.savedAt >= createdAt);
  await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  assert.equal(store.vaultData.revision, 3);
  await store.createRecoveryKey(NEW_PASSPHRASE);
  assert.equal(store.vaultData.revision, 4);
  assert.equal((await readRecord(recordPath)).revision, 4);

  // The revision is in the file, and the vault keeps its ID and record key.
  store.lock();
  await store.unlock(NEW_PASSPHRASE);
  assert.equal(store.vaultData.revision, 4);
  assert.equal(store.vaultData.vaultId, vaultId);
  assert.equal(store.vaultData.revisionKey, revisionKey);
  assert.deepEqual(asked, []);
});

test("the record is written after the file: one that is behind is accepted and raised", async (t) => {
  const { store, recordPath, asked } = await createTracked(t);
  const behind = await fs.readFile(recordPath);
  await save(store);
  // A crash between the two writes leaves the old record with the new file.
  await fs.writeFile(recordPath, behind);
  await reopen(store);
  assert.deepEqual(asked, []);
  assert.equal((await readRecord(recordPath)).revision, 2);

  // A record that cannot be written does not fail the save; the next open
  // writes it.
  await fs.rm(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(path.dirname(recordPath), "in the way");
  await save(store, "Second");
  assert.equal(store.vaultData.revision, 3);
  await fs.rm(path.dirname(recordPath));
  store.lock();
});

test("the reverse (a record ahead of the file) is what an older copy looks like", async (t) => {
  const { store, recordPath, asked } = await createTracked(t);
  const file = await fs.readFile(store.filePath);
  await save(store);
  // Had the record been written first and the file write failed, the file
  // would be behind its record, as here: a false alarm.
  await fs.writeFile(store.filePath, file);
  await assert.rejects(reopen(store), /The vault was not opened/);
  assert.deepEqual(kinds(asked), ["older"]);
  assert.equal((await readRecord(recordPath)).revision, 2);
});

test("an older copy asks on every way to open it and stays closed by default", async (t) => {
  const { store, recordPath, asked, answer, recoveryKey } = await createTracked(t);
  await save(store, "Kept");
  const olderCopy = await fs.readFile(store.filePath);
  const dataKey = store.exportDataKey();
  t.after(() => dataKey.fill(0));
  await save(store, "Lost by the rollback");
  await save(store, "Lost too");
  store.lock();
  await fs.writeFile(store.filePath, olderCopy);
  const record = await fs.readFile(recordPath);

  await assert.rejects(store.unlock(PASSPHRASE), /The vault was not opened/);
  await assert.rejects(store.unlockWithDataKey(dataKey), /The vault was not opened/);
  await assert.rejects(store.recoverWithKey(recoveryKey, NEW_PASSPHRASE), /The vault was not opened/);
  assert.deepEqual(asked.map(({ kind, revision, recordRevision }) => [kind, revision, recordRevision]), [
    ["older", 2, 4],
    ["older", 2, 4],
    ["older", 2, 4],
  ]);
  assert.ok(Number.isSafeInteger(asked[0].savedAt));
  // "Close": locked, and nothing was written.
  assert.equal(store.isUnlocked(), false);
  assert.deepEqual(await fs.readFile(store.filePath), olderCopy);
  assert.deepEqual(await fs.readFile(recordPath), record);

  // "Open this copy": it opens, the record stays until the next save, which
  // goes above it; after that nothing is asked.
  answer.open = true;
  await store.unlock(PASSPHRASE);
  assert.equal(store.vaultData.revision, 2);
  assert.equal((await readRecord(recordPath)).revision, 4);
  await save(store, "After the choice");
  assert.equal(store.vaultData.revision, 5);
  assert.equal((await readRecord(recordPath)).revision, 5);
  asked.length = 0;
  answer.open = false;
  await reopen(store);
  assert.deepEqual(asked, []);
  assert.deepEqual(store.listEntries().map((entry) => entry.name).sort(), ["After the choice", "Kept"]);
});

test("an older copy opened with the recovery key is rekeyed above the record", async (t) => {
  const { store, recordPath, asked, answer, recoveryKey } = await createTracked(t);
  const olderCopy = await fs.readFile(store.filePath);
  await save(store);
  await save(store, "Second");
  store.lock();
  await fs.writeFile(store.filePath, olderCopy);
  answer.open = true;
  await store.recoverWithKey(recoveryKey, NEW_PASSPHRASE);
  assert.deepEqual(kinds(asked), ["older"]);
  assert.equal(store.vaultData.revision, 4);
  assert.equal((await readRecord(recordPath)).revision, 4);
});

test("another vault in the profile's place is asked about", async (t) => {
  const { directory, store, recordPath, asked, answer } = await createTracked(t);
  await save(store);
  store.lock();
  const other = await createTracked(t, { profileId: "profile-two", directory });
  await save(other.store, "Other vault");
  await save(other.store, "Other vault, again");
  other.store.lock();
  await fs.copyFile(other.store.filePath, store.filePath);

  await assert.rejects(store.unlock(PASSPHRASE), /The vault was not opened/);
  assert.deepEqual(kinds(asked), ["differentVault"]);
  answer.open = true;
  await store.unlock(PASSPHRASE);
  // The record now follows the vault that was opened.
  assert.deepEqual(await readRecord(recordPath).then(({ vaultId, revision }) => [vaultId, revision]), [store.vaultData.vaultId, 3]);
  asked.length = 0;
  await reopen(store);
  assert.deepEqual(asked, []);
});

test("a tracked vault without its record asks, and opening it starts a new record", async (t) => {
  const { store, recordPath, asked, answer } = await createTracked(t);
  await save(store);
  store.lock();
  await fs.unlink(recordPath);

  await assert.rejects(store.unlock(PASSPHRASE), /The vault was not opened/);
  assert.deepEqual(asked.map(({ kind, revision }) => [kind, revision]), [["noRecord", 2]]);
  assert.equal(await exists(recordPath), false);
  answer.open = true;
  await store.unlock(PASSPHRASE);
  assert.equal((await readRecord(recordPath)).revision, 2);
  asked.length = 0;
  await reopen(store);
  assert.deepEqual(asked, []);
});

test("a record that was tampered with counts as no record, never as a lower revision", async (t) => {
  const { directory, store, recordPath, asked } = await createTracked(t);
  await save(store);
  await save(store, "Second");
  const olderCopy = await fs.readFile(store.filePath);
  await save(store, "Third");
  store.lock();
  const record = await readRecord(recordPath);
  const tryWith = async (changed) => {
    asked.length = 0;
    await fs.writeFile(recordPath, typeof changed === "string" ? changed : JSON.stringify(changed));
    await assert.rejects(store.unlock(PASSPHRASE), /The vault was not opened/);
    return kinds(asked);
  };

  // With the older copy in place, lowering the record would hide the rollback.
  await fs.writeFile(store.filePath, olderCopy);
  assert.deepEqual(await tryWith(record), ["older"]);
  assert.deepEqual(await tryWith({ ...record, revision: 3 }), ["noRecord"]);
  assert.deepEqual(await tryWith({ ...record, revision: 1 }), ["noRecord"]);
  const mac = Buffer.from(record.mac, "base64");
  mac[0] ^= 1;
  assert.deepEqual(await tryWith({ ...record, mac: mac.toString("base64") }), ["noRecord"]);
  assert.deepEqual(await tryWith({ ...record, mac: "" }), ["noRecord"]);
  assert.deepEqual(await tryWith("not JSON"), ["noRecord"]);
  assert.deepEqual(await tryWith({ ...record, extra: true }), ["noRecord"]);

  // A record made for another profile of the same vault file does not pass
  // here: the profile is part of what its MAC covers.
  const twin = await makeTracked(t, { profileId: "profile-two", directory });
  await fs.copyFile(store.filePath, twin.store.filePath);
  twin.answer.open = true;
  await twin.store.unlock(PASSPHRASE);
  twin.store.lock();
  assert.deepEqual(await tryWith(await readRecord(twin.recordPath)), ["noRecord"]);
});

test("a vault from before revisions is not asked about until its first save tracks it", async (t) => {
  const { store, recordPath, asked } = await makeTracked(t);
  // Schema 4, as 0.3.0 wrote it: no revision.
  const plain = new VaultStore(store.filePath);
  await plain.create(PASSPHRASE);
  await save(plain);
  await plain.persistVaultData({ schemaVersion: 4, entries: plain.vaultData.entries, folders: plain.vaultData.folders });
  plain.lock();
  await fs.rm(path.dirname(recordPath), { recursive: true, force: true });

  await store.unlock(PASSPHRASE);
  assert.equal(store.vaultData.revision, 0);
  assert.equal(await exists(recordPath), false);
  await reopen(store);
  assert.deepEqual(asked, []);

  await save(store, "First save by this version");
  assert.equal(store.vaultData.schemaVersion, 5);
  assert.equal(store.vaultData.revision, 1);
  assert.equal((await readRecord(recordPath)).revision, 1);
  await reopen(store);
  assert.deepEqual(asked, []);
});

test("a copy from before revisions put in a tracked vault's place is asked about", async (t) => {
  const { store, asked, answer, recordPath } = await createTracked(t);
  await save(store);
  const plain = new VaultStore(path.join(path.dirname(store.filePath), "old.vault"));
  await plain.create(PASSPHRASE);
  await plain.persistVaultData({ schemaVersion: 4, entries: [], folders: [] });
  plain.lock();
  store.lock();
  await fs.copyFile(plain.filePath, store.filePath);

  await assert.rejects(store.unlock(PASSPHRASE), /The vault was not opened/);
  assert.deepEqual(asked.map(({ kind, savedAt }) => [kind, savedAt]), [["differentVault", null]]);
  answer.open = true;
  await store.unlock(PASSPHRASE);
  await save(store, "Tracked again");
  assert.deepEqual(await readRecord(recordPath).then(({ vaultId, revision }) => [vaultId, revision]), [store.vaultData.vaultId, 1]);
});

for (const [title, credentials] of [
  ["by passphrase", () => PASSPHRASE],
  ["with the recovery key", (recoveryKey) => ({ recoveryKey, newPassphrase: NEW_PASSPHRASE })],
]) {
  test(`restoring an older backup of the same vault ${title} needs a confirmation`, async (t) => {
    const { directory, store, recordPath, asked, answer, recoveryKey } = await createTracked(t);
    await save(store, "In the backup");
    const backup = path.join(directory, "older-backup.vault");
    await store.exportBackup(backup);
    await save(store, "After the backup");
    await save(store, "After the backup, again");

    // Cancel: the vault and its record stay byte for byte. Asked whether the
    // vault is open or locked.
    for (const locked of [false, true]) {
      if (locked) store.lock();
      const before = [await fs.readFile(store.filePath), await fs.readFile(recordPath)];
      asked.length = 0;
      assert.deepEqual(await store.restoreBackup(backup, credentials(recoveryKey)), { canceled: true });
      assert.deepEqual(asked.map(({ kind, revision, recordRevision }) => [kind, revision, recordRevision]), [["restoreOlder", 2, 4]]);
      assert.deepEqual([await fs.readFile(store.filePath), await fs.readFile(recordPath)], before);
      assert.equal(store.isUnlocked(), !locked);
    }

    // Confirm: restored, and saved once above the newest revision known.
    answer.open = true;
    const status = await store.restoreBackup(backup, credentials(recoveryKey));
    assert.equal(status.unlocked, true);
    assert.deepEqual(store.listEntries().map((entry) => entry.name), ["In the backup"]);
    assert.equal(store.vaultData.revision, 5);
    assert.equal((await readRecord(recordPath)).revision, 5);

    // The replaced file can no longer be taken for a newer copy, and the
    // restored vault opens without a question.
    asked.length = 0;
    answer.open = false;
    store.lock();
    await store.unlock(typeof credentials(recoveryKey) === "string" ? PASSPHRASE : NEW_PASSPHRASE);
    assert.equal(store.vaultData.revision, 5);
    assert.deepEqual(asked, []);
  });
}

test("restoring a backup that is not older, or of another vault, asks nothing more", async (t) => {
  const { directory, store, recordPath, asked } = await createTracked(t);
  await save(store);
  const same = path.join(directory, "same.vault");
  await store.exportBackup(same);
  await store.restoreBackup(same, PASSPHRASE);
  assert.equal(store.vaultData.revision, 2);

  const other = await createTracked(t, { profileId: "profile-two", directory });
  await save(other.store, "Other");
  const otherBackup = path.join(directory, "other.vault");
  await other.store.exportBackup(otherBackup);
  await store.restoreBackup(otherBackup, PASSPHRASE);
  assert.deepEqual(asked, []);
  // The record follows the restored vault, so the next unlock asks nothing.
  assert.deepEqual(
    await readRecord(recordPath).then(({ vaultId, revision }) => [vaultId, revision]),
    [other.store.vaultData.vaultId, 2],
  );
  await reopen(store);
  assert.deepEqual(asked, []);

  // A backup from before revisions: the record goes, until the first save.
  const plain = new VaultStore(path.join(directory, "plain.vault"));
  await plain.create(PASSPHRASE);
  await plain.persistVaultData({ schemaVersion: 4, entries: [], folders: [] });
  plain.lock();
  await store.restoreBackup(plain.filePath, PASSPHRASE);
  assert.equal(await exists(recordPath), false);
  await reopen(store);
  await save(store, "Tracked again");
  assert.equal((await readRecord(recordPath)).revision, 1);
  assert.deepEqual(asked, []);
});

test("a backup restored as a new profile is a vault of its own", async (t) => {
  const directory = await makeTempDirectory(t);
  const asked = [];
  const manager = new ProfileManager(directory, {
    confirmRevision: async (finding) => {
      asked.push(finding);
      return false;
    },
  });
  const original = await manager.createProfile("Original", PASSPHRASE);
  const recoveryKey = original.vaultStore.takeIssuedRecoveryKey();
  await save(original.vaultStore);
  const backup = path.join(directory, "backup.vault");
  await original.vaultStore.exportBackup(backup);

  const byPassphrase = await manager.restoreProfile("By passphrase", backup, PASSPHRASE);
  const byKey = await manager.restoreProfile("By key", backup, { recoveryKey, newPassphrase: NEW_PASSPHRASE });
  const stores = [original.vaultStore, byPassphrase.vaultStore, byKey.vaultStore];
  assert.equal(new Set(stores.map((store) => store.vaultData.vaultId)).size, 3);
  assert.equal(new Set(stores.map((store) => store.vaultData.revisionKey)).size, 3);
  assert.deepEqual(stores.map((store) => store.vaultData.revision), [2, 1, 1]);

  // All three keep saving and reopening without tripping each other.
  for (const [store, passphrase] of [[stores[0], PASSPHRASE], [stores[1], PASSPHRASE], [stores[2], NEW_PASSPHRASE]]) {
    await save(store, "More");
    store.lock();
    await store.unlock(passphrase);
  }
  assert.deepEqual(asked, []);

  // Each profile has its own record, and deleting a profile removes it.
  const recordOf = (profile) => manager.getRevisionRecordPath(profile.id);
  assert.equal((await readRecord(recordOf(original.profile))).revision, 3);
  assert.equal((await readRecord(recordOf(byKey.profile))).revision, 2);
  byKey.vaultStore.lock();
  await manager.deleteProfile(byKey.profile.id);
  assert.equal(await exists(recordOf(byKey.profile)), false);
  assert.equal(await exists(recordOf(original.profile)), true);
});

test("the legacy profile has a record of its own, and an unanswered question keeps a vault closed", async (t) => {
  const directory = await makeTempDirectory(t);
  // No `confirmRevision`: nobody to ask.
  const manager = new ProfileManager(directory);
  const legacy = manager.createStore(manager.legacyVaultPath);
  await legacy.create(PASSPHRASE);
  const older = await fs.readFile(legacy.filePath);
  await save(legacy);
  assert.equal((await readRecord(manager.getRevisionRecordPath("legacy"))).revision, 2);
  legacy.lock();
  await fs.writeFile(legacy.filePath, older);
  await assert.rejects(legacy.unlock(PASSPHRASE), /The vault was not opened/);
});
