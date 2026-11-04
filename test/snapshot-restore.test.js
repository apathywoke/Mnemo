// Restoring from snapshots (src/main/snapshot-sources.js, restoreBackup with
// a pool folder).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const ProfileManager = require("../src/main/profile-manager");
const { OutsideCopies } = require("../src/main/outside-copies");
const { MIN_INTERVAL_MS } = require("../src/main/vault/snapshots");
const { listForVault, snapshotFoldersIn, listForFolders, resolveSnapshot } = require("../src/main/snapshot-sources");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";
const PROFILE_ID = "6f1b0c1e-3a4d-4b5c-8d6e-7f8091a2b3c4";

// A vault with an attachment, a snapshot of that state, and later changes.
async function setUp(t) {
  const directory = await makeTempDirectory(t);
  const vaultPath = path.join(directory, "vaults", `${PROFILE_ID}.vault`);
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  const clock = { now: Date.now() };
  const store = new VaultStore(vaultPath, { snapshots: true, now: () => clock.now });
  t.after(() => store.lock());
  await store.create(PASSPHRASE);
  const recoveryKey = store.takeIssuedRecoveryKey();
  const login = await store.saveEntry(makeLogin({ name: "Kept" }));
  const source = path.join(directory, "file.txt");
  await fs.writeFile(source, "attachment from then");
  await store.addAttachment(login.id, source);
  await store.enqueueMutation(async () => {});
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());
  const [snapshot] = (await store.listSnapshots()).complete;
  // Later: the item is renamed and the attachment deleted.
  clock.now += MIN_INTERVAL_MS;
  await store.saveEntry(makeLogin({ id: login.id, name: "Renamed later" }));
  await store.deleteAttachment(login.id, store.vaultData.entries[0].attachments[0].id);
  await store.enqueueMutation(async () => {});
  return { directory, vaultPath, clock, store, snapshot, recoveryKey, login };
}

async function attachmentText(store) {
  const entry = store.vaultData.entries[0];
  const bytes = await store.openAttachment(entry, entry.attachments[0]);
  return bytes.toString("utf8");
}

test("a local snapshot restores the vault with its attachments, keeping the current state", async (t) => {
  const { store, snapshot, vaultPath, clock } = await setUp(t);
  const [item] = await listForVault(vaultPath, null);
  assert.equal(item.id, `local:${snapshot.name}`);
  assert.equal(item.attachments, 1);
  const source = resolveSnapshot(item.id, { vaultPath });
  assert.equal(source.localName, snapshot.name);

  clock.now += MIN_INTERVAL_MS;
  await store.keepSnapshotForRestore(source.localName);
  await store.restoreBackup(source.file, PASSPHRASE, { poolDirectory: source.poolDirectory });
  assert.equal(store.vaultData.entries[0].name, "Kept");
  assert.equal(await attachmentText(store), "attachment from then");

  await store.enqueueMutation(async () => {});
  const list = (await store.listSnapshots()).complete;
  assert.equal(list.find((s) => s.name === snapshot.name).description.pinned.reason, "restore", "the source is kept");
  const before = list.find((s) => s.name !== snapshot.name && s.description.pinned?.reason === "restore");
  assert.ok(before, "the replaced state is pinned");
  const reader = new VaultStore(store.snapshotFile(before.name, "vault"));
  const opened = await reader.decryptVaultFile(reader.filePath, PASSPHRASE);
  opened.dataKey.fill(0);
  assert.equal(opened.vaultData.entries[0].name, "Renamed later");
});

test("a snapshot from before a passphrase change opens with the old passphrase or the old recovery key", async (t) => {
  const { store, snapshot, vaultPath, recoveryKey } = await setUp(t);
  await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  await store.enqueueMutation(async () => {});
  const source = resolveSnapshot(`local:${snapshot.name}`, { vaultPath });

  await assert.rejects(
    store.restoreBackup(source.file, NEW_PASSPHRASE, { poolDirectory: source.poolDirectory }),
    /Could not open the vault/,
  );
  assert.equal(store.vaultData.entries[0].name, "Renamed later");

  // The recovery key of that time, with a new passphrase: the restored
  // vault gets a new key, and its attachments come from the pool.
  store.lock();
  await store.restoreBackup(source.file, { recoveryKey, newPassphrase: "eine ganz neue lange Passphrase 42" }, {
    poolDirectory: source.poolDirectory,
  });
  assert.ok(store.takeIssuedRecoveryKey());
  assert.equal(store.vaultData.entries[0].name, "Kept");
  assert.equal(await attachmentText(store), "attachment from then");
});

test("a snapshot missing an attachment, or damaged, restores nothing", async (t) => {
  const { store, snapshot, vaultPath } = await setUp(t);
  const source = resolveSnapshot(`local:${snapshot.name}`, { vaultPath });
  const vaultBefore = await fs.readFile(vaultPath);
  const [id] = snapshot.description.attachments;
  const pooled = path.join(source.poolDirectory, `${id}.bin`);
  const pooledBytes = await fs.readFile(pooled);
  await fs.rm(pooled);
  await assert.rejects(
    store.restoreBackup(source.file, PASSPHRASE, { poolDirectory: source.poolDirectory }),
    /incomplete or damaged/,
  );
  assert.deepEqual(await fs.readFile(vaultPath), vaultBefore);

  await fs.writeFile(pooled, pooledBytes);
  const damaged = await fs.readFile(source.file);
  damaged[damaged.length - 20] ^= 1;
  await fs.writeFile(source.file, damaged);
  await assert.rejects(store.restoreBackup(source.file, PASSPHRASE, { poolDirectory: source.poolDirectory }), /damaged/);
  assert.deepEqual(await fs.readFile(vaultPath), vaultBefore);
});

test("a damaged vault is restored from a snapshot while locked", async (t) => {
  const { store, snapshot, vaultPath } = await setUp(t);
  store.lock();
  const bytes = await fs.readFile(vaultPath);
  bytes[bytes.length - 20] ^= 1;
  await fs.writeFile(vaultPath, bytes);
  await assert.rejects(store.unlock(PASSPHRASE), /damaged/);

  const source = resolveSnapshot(`local:${snapshot.name}`, { vaultPath });
  await store.restoreBackup(source.file, PASSPHRASE, { poolDirectory: source.poolDirectory });
  assert.equal(store.vaultData.entries[0].name, "Kept");
  // The damaged file is kept too, as an unverified copy pinned before the restore.
  const pinned = (await store.listSnapshots()).complete.find((s) => s.description.pinned?.reason === "restore" && s.name !== snapshot.name);
  assert.deepEqual(await fs.readFile(store.snapshotFile(pinned.name, "vault")), bytes);
});

test("copies outside this Mac restore a new vault on another Mac", async (t) => {
  const { store, vaultPath, clock, directory } = await setUp(t);
  const outsideFolder = path.join(directory, "iCloud");
  await fs.mkdir(outsideFolder);
  const outside = new OutsideCopies({
    getFolder: () => outsideFolder,
    userDataPath: path.dirname(vaultPath),
    homePath: directory,
    now: () => clock.now,
    readMounts: async () => [],
  });
  t.after(() => outside.cancelTimers());
  assert.equal((await outside.copy(vaultPath)).failure, null);

  // The vault's own list shows each snapshot once.
  const own = await listForVault(vaultPath, outsideFolder);
  assert.equal(new Set(own.map((item) => item.id.split(":").pop())).size, own.length);

  // Another Mac: pick the folder, choose the snapshot of "Kept".
  const found = await snapshotFoldersIn(outsideFolder);
  assert.equal(found.length, 1);
  const items = listForFolders(found);
  assert.ok(items.every((item) => item.group === PROFILE_ID));
  const pickedFolders = found.map((folder) => folder.directory);
  const otherMac = await makeTempDirectory(t);
  const manager = new ProfileManager(otherMac);
  let restoredName = null;
  for (const item of items) {
    const source = resolveSnapshot(item.id, { pickedFolders });
    const reader = new VaultStore(source.file);
    const opened = await reader.decryptVaultFile(source.file, PASSPHRASE);
    opened.dataKey.fill(0);
    if (opened.vaultData.entries[0].name !== "Kept") continue;
    const restored = await manager.restoreProfile("From iCloud", source.file, PASSPHRASE, { poolDirectory: source.poolDirectory });
    t.after(() => restored.vaultStore.lock());
    restoredName = restored.vaultStore.vaultData.entries[0].name;
    assert.equal(await attachmentText(restored.vaultStore), "attachment from then");
    break;
  }
  assert.equal(restoredName, "Kept");
  store.lock();
});

test("snapshot IDs from the page are checked", () => {
  const vaultPath = `/data/vaults/${PROFILE_ID}.vault`;
  const name = "1793790605580-9f9c9f476efe439a";
  assert.equal(resolveSnapshot(`local:${name}`, { vaultPath }).file, `${vaultPath}.snapshots/${name}.vault`);
  assert.equal(resolveSnapshot(`outside:${name}`, { vaultPath, outsideFolder: "/Volumes/Disk" }).file,
    `/Volumes/Disk/Mnemo/${PROFILE_ID}/${name}.vault`);
  for (const bad of [
    `local:../${name}`,
    `local:${name}/../../x`,
    `outside:${name}`,
    `folder:0:${name}`,
    `folder:${name}`,
    `local:0:${name}`,
    "local:123",
    42,
  ]) {
    assert.throws(() => resolveSnapshot(bad, { vaultPath, pickedFolders: [] }), /no longer available/, String(bad));
  }
});
