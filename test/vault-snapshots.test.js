// Local snapshots (src/main/vault/snapshots.js, store-snapshots.js).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const ProfileManager = require("../src/main/profile-manager");
const { openAttachmentKey, decryptAttachment } = require("../src/main/vault/attachments");
const {
  DAY_MS,
  KEEP_RECENT,
  MIN_INTERVAL_MS,
  PIN_MS,
  describeSnapshot,
  snapshotsToRemove,
} = require("../src/main/vault/snapshots");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";
const FIXTURE = path.join(__dirname, "fixtures", "schema3-notes.vault");
const fixture = require("./fixtures/schema3-notes.json");

// A store with snapshots on and a clock the test moves.
async function makeStore(t, { create = true } = {}) {
  const directory = await makeTempDirectory(t);
  const clock = { now: Date.now() };
  const filePath = path.join(directory, "test.vault");
  const store = new VaultStore(filePath, { snapshots: true, now: () => clock.now });
  t.after(() => store.lock());
  if (create) await store.create(PASSPHRASE);
  return { directory, clock, filePath, store };
}

// Waits for queued snapshot work.
const settle = (store) => store.enqueueMutation(async () => {});

async function snapshots(store) {
  return (await store.listSnapshots()).complete;
}

test("a save is followed by a verified snapshot of the file as saved", async (t) => {
  const { store, filePath } = await makeStore(t);
  assert.deepEqual(await snapshots(store), []);
  await store.saveEntry(makeLogin());
  await settle(store);

  const [snapshot, ...rest] = await snapshots(store);
  assert.equal(rest.length, 0);
  assert.notEqual(snapshot.description.verifiedAt, null);
  assert.equal(snapshot.description.pinned, null);
  assert.deepEqual(
    await fs.readFile(store.snapshotFile(snapshot.name, "vault")),
    await fs.readFile(filePath),
  );
  assert.equal(store.snapshotFailedAt, null);
  const status = await store.getSnapshotStatus();
  assert.equal(status.count, 1);
  assert.equal(status.lastVerifiedAt, snapshot.description.createdAt);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(store.snapshotDirectory)).mode & 0o777, 0o700);
  }
  // The snapshot folder is no place for user files.
  assert.equal(store.isVaultPath(path.join(store.snapshotDirectory, "x.vault")), true);
});

test("ordinary snapshots wait for the interval, then take the newest state", async (t) => {
  const { store, clock, filePath } = await makeStore(t);
  await store.saveEntry(makeLogin({ name: "First" }));
  await settle(store);
  assert.equal((await snapshots(store)).length, 1);

  clock.now += 60_000;
  await store.saveEntry(makeLogin({ name: "Second" }));
  await settle(store);
  assert.equal((await snapshots(store)).length, 1, "no second snapshot inside the interval");
  assert.notEqual(store.snapshotTimer, null, "one is scheduled for the end of the interval");

  clock.now += MIN_INTERVAL_MS;
  assert.ok(await store.enqueueMutation(() => store.takeSnapshotNow()));
  const [newest] = await snapshots(store);
  assert.deepEqual(await fs.readFile(store.snapshotFile(newest.name, "vault")), await fs.readFile(filePath));

  // Nothing new to copy: the same file is not copied twice.
  clock.now += MIN_INTERVAL_MS;
  assert.equal(await store.enqueueMutation(() => store.takeSnapshotNow()), newest.name);
  assert.equal((await snapshots(store)).length, 2);

  store.lock();
  assert.equal(store.snapshotTimer, null, "locking cancels the scheduled snapshot");
});

test("tests and other stores without the option take no snapshots", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "plain.vault"));
  await store.create(PASSPHRASE);
  await store.saveEntry(makeLogin());
  await settle(store);
  assert.deepEqual(await fs.readdir(directory), ["plain.vault"]);
});

test("attachments are pooled once, verified, and kept after the vault drops them", async (t) => {
  const { store, clock, directory } = await makeStore(t);
  const login = await store.saveEntry(makeLogin());
  const source = path.join(directory, "file.txt");
  await fs.writeFile(source, "attachment contents");
  const attachment = await store.addAttachment(login.id, source);
  await settle(store);
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());

  const pooled = path.join(store.snapshotPoolDirectory, `${attachment.id}.bin`);
  assert.deepEqual(await fs.readFile(pooled), await fs.readFile(store.attachmentPath(attachment.id)));
  const [withAttachment] = await snapshots(store);
  assert.deepEqual(withAttachment.description.attachments, [attachment.id]);

  // Deleting the attachment removes it from the vault, not from the pool
  // while a snapshot refers to it.
  await store.deleteAttachment(login.id, attachment.id);
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());
  await assert.rejects(fs.access(store.attachmentPath(attachment.id)));
  assert.ok(await fs.readFile(pooled));

  // A damaged pool file is replaced from the vault's copy on the first
  // snapshot of a day, which decrypts every pooled file.
  const second = path.join(directory, "second.txt");
  await fs.writeFile(second, "second file");
  const kept = await store.addAttachment(login.id, second);
  await settle(store);
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());
  const keptPool = path.join(store.snapshotPoolDirectory, `${kept.id}.bin`);
  const good = await fs.readFile(keptPool);
  const damaged = Buffer.from(good);
  damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(keptPool, damaged);
  await store.saveEntry(makeLogin({ name: "Next day" }));
  await settle(store);
  clock.now += DAY_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());
  assert.deepEqual(await fs.readFile(keptPool), good);
});

test("a key change pins the old state, and old snapshots open with the old secrets only", async (t) => {
  const { store, directory, clock } = await makeStore(t);
  const login = await store.saveEntry(makeLogin());
  const source = path.join(directory, "file.txt");
  await fs.writeFile(source, "kept in the old snapshot");
  const attachment = await store.addAttachment(login.id, source);
  await settle(store);
  clock.now += 60_000;

  await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  await settle(store);
  const list = await snapshots(store);
  const pinned = list.find((snapshot) => snapshot.description.pinned?.reason === "rekey");
  assert.ok(pinned, "the state before the change is pinned");
  assert.equal(pinned.description.pinned.until, clock.now + PIN_MS);
  assert.notEqual(list[0].name, pinned.name, "the new state has its own, newer snapshot");
  assert.ok(list[0].description.createdAt > pinned.description.createdAt);
  assert.notEqual(list[0].description.verifiedAt, null);

  // The pinned snapshot opens with the old passphrase, and its attachment,
  // gone from the vault after the rotation, is still in the pool.
  await assert.rejects(fs.access(store.attachmentPath(attachment.id)));
  const reader = new VaultStore(store.snapshotFile(pinned.name, "vault"));
  await assert.rejects(reader.decryptVaultFile(reader.filePath, NEW_PASSPHRASE), /Could not open/);
  const opened = await reader.decryptVaultFile(reader.filePath, PASSPHRASE);
  try {
    const [entry] = opened.vaultData.entries;
    const [record] = entry.attachments;
    const fileKey = openAttachmentKey(record.key, opened.dataKey, entry.id, record.id);
    const bytes = await fs.readFile(path.join(store.snapshotPoolDirectory, `${record.id}.bin`));
    assert.equal(decryptAttachment(bytes, fileKey, record.id, record.size).toString(), "kept in the old snapshot");
  } finally {
    opened.dataKey.fill(0);
  }

  // Deleting the old ones keeps the new one and its pooled files.
  const others = await store.snapshotsWithOtherKeys();
  assert.ok(others.includes(pinned.name));
  assert.ok(!others.includes(list[0].name));
  assert.deepEqual(await store.deleteSnapshotsWithOtherKeys(), { deleted: others.length });
  const remaining = await snapshots(store);
  assert.deepEqual(remaining.map((snapshot) => snapshot.name), [list[0].name]);
  const [newAttachment] = store.vaultData.entries[0].attachments;
  assert.ok(await fs.readFile(path.join(store.snapshotPoolDirectory, `${newAttachment.id}.bin`)));
});

test("imports and restores pin the state before them", async (t) => {
  const { store, directory, clock } = await makeStore(t);
  await store.saveEntry(makeLogin());
  await settle(store);
  clock.now += 60_000;
  await store.saveEntry(makeLogin({ name: "Changed" }));
  await settle(store);

  await store.importLogins([makeLogin({ name: "Imported" })]);
  await settle(store);
  const imported = (await snapshots(store)).find((snapshot) => snapshot.description.pinned?.reason === "import");
  assert.ok(imported);
  assert.notEqual(imported.description.verifiedAt, null);

  // Restoring while locked: the file being replaced is copied unverified.
  const backup = path.join(directory, "backup.vault");
  await store.exportBackup(backup);
  const before = await fs.readFile(store.filePath);
  store.lock();
  clock.now += 60_000;
  await store.restoreBackup(backup, PASSPHRASE);
  await settle(store);
  const restored = (await snapshots(store)).find((snapshot) => snapshot.description.pinned?.reason === "restore");
  assert.ok(restored);
  assert.deepEqual(await fs.readFile(store.snapshotFile(restored.name, "vault")), before);
});

test("a vault saved without a snapshot gets an unverified copy at launch, verified at unlock", async (t) => {
  const { store, clock, filePath } = await makeStore(t);
  await store.saveEntry(makeLogin({ name: "First" }));
  await settle(store);
  clock.now += 60_000;
  await store.saveEntry(makeLogin({ name: "Saved just before quitting" }));
  store.lock();

  await VaultStore.copySnapshotAtLaunch(filePath);
  let [newest] = await snapshots(store);
  assert.equal(newest.description.verifiedAt, null);
  assert.deepEqual(await fs.readFile(store.snapshotFile(newest.name, "vault")), await fs.readFile(filePath));
  // A second launch adds nothing.
  await VaultStore.copySnapshotAtLaunch(filePath);
  assert.equal((await snapshots(store)).length, 2);

  await store.unlock(PASSPHRASE);
  await settle(store);
  [newest] = await snapshots(store);
  assert.notEqual(newest.description.verifiedAt, null);
  assert.equal((await snapshots(store)).length, 2);
});

test("a damaged copy is never counted as verified", async (t) => {
  const { store, clock, filePath } = await makeStore(t);
  await store.saveEntry(makeLogin());
  await settle(store);
  clock.now += 60_000;
  await store.saveEntry(makeLogin({ name: "Second" }));
  store.lock();
  await VaultStore.copySnapshotAtLaunch(filePath);
  const [copy] = await snapshots(store);
  const copyPath = store.snapshotFile(copy.name, "vault");
  const bytes = await fs.readFile(copyPath);
  bytes[bytes.length - 10] ^= 1;
  await fs.writeFile(copyPath, bytes);

  await store.unlock(PASSPHRASE);
  await settle(store);
  const list = await snapshots(store);
  assert.equal(list.find((snapshot) => snapshot.name === copy.name).description.verifiedAt, null);
  // The unlock took a verified snapshot of the real file instead.
  assert.equal(list.length, 3);
  assert.notEqual(list[0].name, copy.name);
  assert.notEqual(list[0].description.verifiedAt, null);
  assert.deepEqual(await fs.readFile(store.snapshotFile(list[0].name, "vault")), await fs.readFile(filePath));
});

test("opening a vault in an older format pins it before it is saved in the new one", async (t) => {
  const { store, filePath } = await makeStore(t, { create: false });
  await fs.copyFile(FIXTURE, filePath);
  const original = await fs.readFile(filePath);
  await store.unlock(fixture.passphrase);
  await settle(store);
  const pinned = (await snapshots(store)).find((snapshot) => snapshot.description.pinned?.reason === "upgrade");
  assert.ok(pinned);
  assert.notEqual(pinned.description.verifiedAt, null);
  assert.deepEqual(await fs.readFile(store.snapshotFile(pinned.name, "vault")), original);
});

test("a failed snapshot never fails the save and is remembered", async (t) => {
  const { store } = await makeStore(t);
  // A file where the snapshot folder belongs.
  await fs.writeFile(store.snapshotDirectory, "not a folder");
  await store.saveEntry(makeLogin());
  await settle(store);
  assert.equal(store.vaultData.entries.length, 1);
  assert.notEqual(store.snapshotFailedAt, null);
  assert.equal((await store.getSnapshotStatus()).failedAt, store.snapshotFailedAt);

  await fs.rm(store.snapshotDirectory);
  await store.saveEntry(makeLogin({ name: "Second" }));
  await settle(store);
  assert.equal(store.snapshotFailedAt, null);
});

test("locking during a snapshot stops it without counting a failure", async (t) => {
  const { store } = await makeStore(t);
  await store.saveEntry(makeLogin());
  // The queued snapshot runs after this lock.
  store.lock();
  await settle(store);
  assert.deepEqual(await snapshots(store), []);
  assert.equal(store.snapshotFailedAt, null);
});

test("deleting a profile keeps its snapshots unless asked to delete them", async (t) => {
  const directory = await makeTempDirectory(t);
  const manager = new ProfileManager(directory);
  for (const deleteSnapshots of [false, true]) {
    const { profile, vaultStore } = await manager.createProfile(`Vault ${deleteSnapshots}`, PASSPHRASE);
    await vaultStore.saveEntry(makeLogin());
    await settle(vaultStore);
    vaultStore.lock();
    assert.equal(await manager.hasSnapshots(profile.id), true);
    const snapshotDirectory = VaultStore.snapshotDirectoryFor(manager.getVaultPath(profile.id));
    await manager.deleteProfile(profile.id, { deleteSnapshots });
    await assert.rejects(fs.access(manager.getVaultPath(profile.id)));
    assert.equal(await fs.access(snapshotDirectory).then(() => true, () => false), !deleteSnapshots);
  }
});

// --- Retention ----------------------------------------------------------------------

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("retention keeps what the rules promise on random histories", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = seededRandom(seed);
    const now = Date.UTC(2026, 10, 4, 12);
    const items = [];
    const count = Math.floor(random() * 80);
    for (let index = 0; index < count; index += 1) {
      // Mostly the last 60 days; a few from a clock that ran ahead.
      const createdAt = random() < 0.05 ? now + Math.floor(random() * DAY_MS) : now - Math.floor(random() * 60 * DAY_MS);
      const verifiedAt = random() < 0.8 ? createdAt : null;
      const pinReason = random() < 0.1 ? "rekey" : null;
      items.push({
        name: `${String(createdAt).padStart(13, "0")}-${index.toString(16).padStart(16, "0")}`,
        description: describeSnapshot({ createdAt, sha256: "0".repeat(64), size: 1, attachments: [], verifiedAt, pinReason }),
      });
    }
    const removed = new Set(snapshotsToRemove(items, now));
    const kept = items.filter((item) => !removed.has(item.name));
    const byNewest = (a, b) => b.description.createdAt - a.description.createdAt || b.name.localeCompare(a.name);
    const verified = items.filter((item) => item.description.verifiedAt !== null).sort(byNewest);

    if (verified.length === 0) {
      assert.equal(removed.size, 0, `seed ${seed}: nothing goes before a snapshot is verified`);
      continue;
    }
    for (const item of verified.slice(0, KEEP_RECENT)) {
      assert.ok(!removed.has(item.name), `seed ${seed}: one of the newest verified was removed`);
    }
    for (const item of items) {
      if (item.description.pinned && item.description.pinned.until > now) {
        assert.ok(!removed.has(item.name), `seed ${seed}: a pinned snapshot was removed`);
      }
      if (item.description.verifiedAt === null && byNewest(item, verified[0]) < 0) {
        assert.ok(!removed.has(item.name), `seed ${seed}: a copy waiting for its check was removed`);
      }
    }
    // Every recent day with a verified snapshot keeps one.
    const day = (time) => new Date(Math.min(time, now)).toDateString();
    for (const item of verified) {
      if (now - item.description.createdAt > 30 * DAY_MS) continue;
      assert.ok(
        kept.some((other) => other.description.verifiedAt !== null && day(other.description.createdAt) === day(item.description.createdAt)),
        `seed ${seed}: a recent day lost all its snapshots`,
      );
    }
    // Old, unpinned, and not among the newest: removed.
    for (const item of verified.slice(KEEP_RECENT)) {
      if (now - item.description.createdAt > 30 * DAY_MS && !item.description.pinned) {
        assert.ok(removed.has(item.name), `seed ${seed}: an expired snapshot was kept`);
      }
    }
  }
});
