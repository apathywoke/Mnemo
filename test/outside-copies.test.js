// Copies of snapshots in a folder outside this Mac (src/main/outside-copies.js).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const SettingsStore = require("../src/main/settings-store");
const {
  OutsideCopies,
  COPY_INTERVAL_MS,
  REMINDER_MS,
  profileIdOf,
  parseMountTable,
  fileSystemOf,
  isPlaceholder,
} = require("../src/main/outside-copies");
const { DAY_MS, MIN_INTERVAL_MS } = require("../src/main/vault/snapshots");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";
const PROFILE_ID = "6f1b0c1e-3a4d-4b5c-8d6e-7f8091a2b3c4";

// A vault with snapshots on, a folder "outside", and one clock for both.
async function setUp(t, { folderInside = false } = {}) {
  const directory = await makeTempDirectory(t);
  const userData = path.join(directory, "data");
  const vaultPath = path.join(userData, "vaults", `${PROFILE_ID}.vault`);
  const outsideFolder = folderInside ? userData : path.join(directory, "outside");
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  await fs.mkdir(outsideFolder, { recursive: true });
  const clock = { now: Date.now() };
  const settings = { folder: outsideFolder };
  const outside = new OutsideCopies({
    getFolder: () => settings.folder,
    userDataPath: userData,
    homePath: path.join(directory, "home"),
    now: () => clock.now,
    readMounts: async () => [],
  });
  t.after(() => outside.cancelTimers());
  const store = new VaultStore(vaultPath, { snapshots: true, now: () => clock.now });
  t.after(() => store.lock());
  await store.create(PASSPHRASE);
  const target = path.join(outsideFolder, "Mnemo", PROFILE_ID);
  return { directory, userData, vaultPath, outsideFolder, target, clock, settings, outside, store };
}

const settle = (store) => store.enqueueMutation(async () => {});

async function save(store, clock, name) {
  clock.now += MIN_INTERVAL_MS;
  await store.saveEntry(makeLogin({ name }));
  await settle(store);
}

test("verified snapshots are copied byte for byte and read back", async (t) => {
  const { store, clock, outside, vaultPath, target, directory } = await setUp(t);
  const login = await store.saveEntry(makeLogin());
  const source = path.join(directory, "file.txt");
  await fs.writeFile(source, "attachment contents");
  const attachment = await store.addAttachment(login.id, source);
  await settle(store);
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());

  const status = await outside.copy(vaultPath);
  assert.equal(status.verifiedAt, clock.now);
  assert.equal(status.failure, null);
  const [newest] = (await store.listSnapshots()).complete;
  assert.deepEqual(
    await fs.readFile(path.join(target, `${newest.name}.vault`)),
    await fs.readFile(store.snapshotFile(newest.name, "vault")),
  );
  assert.deepEqual(
    await fs.readFile(path.join(target, "attachments", `${attachment.id}.bin`)),
    await fs.readFile(path.join(store.snapshotPoolDirectory, `${attachment.id}.bin`)),
  );
  const description = JSON.parse(await fs.readFile(path.join(target, `${newest.name}.json`), "utf8"));
  assert.equal(description.sha256, newest.description.sha256);

  // Nothing new: nothing is written again, and the copy still counts.
  const before = (await fs.stat(path.join(target, `${newest.name}.vault`))).mtimeMs;
  clock.now += 1000;
  assert.equal((await outside.copy(vaultPath)).verifiedAt, clock.now);
  assert.equal((await fs.stat(path.join(target, `${newest.name}.vault`))).mtimeMs, before);
});

test("no vault name leaves the Mac", async (t) => {
  const { store, clock, outside, vaultPath, outsideFolder } = await setUp(t);
  await save(store, clock, "Bank");
  await outside.copy(vaultPath);
  assert.deepEqual(await fs.readdir(path.join(outsideFolder, "Mnemo")), [PROFILE_ID]);
  assert.equal(profileIdOf("/x/vault.json"), "legacy");
  assert.throws(() => profileIdOf("/x/../evil.vault"), /valid vault profile/);
});

test("an existing file outside is never rewritten; a different one is a failure", async (t) => {
  const { store, clock, outside, vaultPath, target } = await setUp(t);
  await save(store, clock, "First");
  const [newest] = (await store.listSnapshots()).complete;
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, `${newest.name}.vault`), "not the same bytes");
  const status = await outside.copy(vaultPath);
  assert.equal(status.failure, "mismatch");
  assert.equal(status.verifiedAt, null);
  assert.equal(await fs.readFile(path.join(target, `${newest.name}.vault`), "utf8"), "not the same bytes");
});

test("an unplugged disk and a folder inside Mnemo's data fail clearly", async (t) => {
  const { store, clock, outside, vaultPath, outsideFolder, settings } = await setUp(t);
  await save(store, clock, "First");
  await fs.rm(outsideFolder, { recursive: true });
  const status = await outside.copy(vaultPath);
  assert.equal(status.failure, "unavailable");
  assert.equal(status.failedAt, clock.now);
  assert.equal((await outside.getStatus(vaultPath)).failure, "unavailable");

  settings.folder = path.dirname(vaultPath);
  assert.equal(await outside.folderProblem(settings.folder), "inside-data");
  assert.equal(await outside.folderProblem(path.join(outsideFolder, "missing")), "unavailable");
});

test("an iCloud placeholder is never written over and never counts", async (t) => {
  const { store, clock, outside, vaultPath, target } = await setUp(t);
  await save(store, clock, "First");
  const [newest] = (await store.listSnapshots()).complete;
  await fs.mkdir(target, { recursive: true });
  // How older iCloud versions show a file whose data is in the cloud only.
  await fs.writeFile(path.join(target, `.${newest.name}.json.icloud`), "");
  const status = await outside.copy(vaultPath);
  assert.equal(status.failure, "placeholder");
  await assert.rejects(fs.access(path.join(target, `${newest.name}.json`)));

  assert.equal(isPlaceholder({ size: 4096, blocks: 0 }), true);
  assert.equal(isPlaceholder({ size: 4096, blocks: 8 }), false);
  assert.equal(isPlaceholder({ size: 0, blocks: 0 }), false);
});

test("ordinary snapshots go out hourly, pinned ones at once", async (t) => {
  const { store, clock, outside, vaultPath, target } = await setUp(t);
  await save(store, clock, "First");
  await outside.copy(vaultPath);
  const count = async () => (await fs.readdir(target)).filter((name) => name.endsWith(".json")).length;
  assert.equal(await count(), 1);

  await save(store, clock, "Second");
  outside.noteSnapshot(vaultPath);
  await outside.enqueue(vaultPath, async () => {});
  assert.equal(await count(), 1, "within the hour: waits");
  assert.ok(outside.timers.has(vaultPath));

  await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  await settle(store);
  outside.noteSnapshot(vaultPath, { pinned: true });
  await outside.enqueue(vaultPath, async () => {});
  assert.ok(await count() >= 2, "a pinned snapshot goes out at once");

  clock.now += COPY_INTERVAL_MS;
  outside.cancelTimers();
  outside.noteSnapshot(vaultPath);
  await outside.enqueue(vaultPath, async () => {});
  const [newest] = (await store.listSnapshots()).complete;
  await fs.access(path.join(target, `${newest.name}.json`));
});

test("copies outside are rotated like local ones", async (t) => {
  const { store, clock, outside, vaultPath, target } = await setUp(t);
  for (let day = 0; day < 40; day += 1) {
    await save(store, clock, `Day ${day}`);
    await outside.copy(vaultPath);
    clock.now += DAY_MS;
  }
  const names = (await fs.readdir(target)).filter((name) => name.endsWith(".json"));
  // The newest of each of the last 30 days, at most: nothing older.
  assert.ok(names.length <= 31, `${names.length} copies kept`);
  const oldest = Math.min(...names.map((name) => Number(name.slice(0, 13))));
  assert.ok(clock.now - oldest <= 31 * DAY_MS);
  // Every kept copy has its file.
  for (const name of names) await fs.access(path.join(target, name.replace(/\.json$/, ".vault")));
});

test("after a key change, copies with the old key can be deleted outside too", async (t) => {
  const { store, clock, outside, vaultPath, target } = await setUp(t);
  await save(store, clock, "Before");
  await outside.copy(vaultPath);
  await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
  await settle(store);
  clock.now += COPY_INTERVAL_MS;
  await outside.copy(vaultPath);
  const before = (await fs.readdir(target)).filter((name) => name.endsWith(".vault"));
  assert.ok(before.length >= 2);

  const result = await outside.deleteWithOtherKeys(vaultPath, (bytes) => store.isOtherKeyBytes(bytes));
  assert.equal(result.unchecked, 0);
  const after = (await fs.readdir(target)).filter((name) => name.endsWith(".vault"));
  assert.equal(after.length, before.length - result.deleted);
  for (const name of after) {
    assert.equal(store.isOtherKeyBytes(await fs.readFile(path.join(target, name))), false);
  }
});

test("the offer, then the reminder after 14 days without a checked copy", async (t) => {
  const { store, clock, outside, vaultPath, settings } = await setUp(t);
  settings.folder = null;
  let status = await outside.getStatus(vaultPath);
  assert.equal(status.offer, true);
  assert.equal(status.reminderDue, false);
  await outside.dismissOffer(vaultPath);
  assert.equal((await outside.getStatus(vaultPath)).offer, false);

  clock.now += REMINDER_MS;
  status = await outside.getStatus(vaultPath);
  assert.equal(status.reminderDue, true);

  settings.folder = (await makeTempDirectory(t));
  await save(store, clock, "Now copied");
  await outside.copy(vaultPath);
  status = await outside.getStatus(vaultPath);
  assert.equal(status.reminderDue, false);
  clock.now += REMINDER_MS;
  assert.equal((await outside.getStatus(vaultPath)).reminderDue, true);
});

test("folders on this disk, on unreliable file systems, and in cloud storage", async (t) => {
  const { outside, outsideFolder, directory } = await setUp(t);
  assert.equal(await outside.folderWarning(outsideFolder), "same-disk");

  const cloud = path.join(directory, "home", "Library", "CloudStorage", "Dropbox");
  await fs.mkdir(cloud, { recursive: true });
  assert.equal(await outside.folderWarning(cloud), null);

  const resolved = await fs.realpath(outsideFolder);
  outside.readMounts = async () => parseMountTable(`/dev/disk3s1 on / (apfs, local, journaled)\n/dev/disk9s1 on ${resolved} (exfat, local, nodev)\n`);
  assert.equal(await outside.folderWarning(outsideFolder), "unreliable-disk");

  const mounts = parseMountTable([
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "//me@nas/Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by me)",
    "/dev/disk5s1 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled)",
  ].join("\n"));
  assert.equal(fileSystemOf("/Volumes/My Share/Mnemo", mounts), "smbfs");
  assert.equal(fileSystemOf("/Volumes/Backup", mounts), "apfs");
  assert.equal(fileSystemOf("/Users/me", mounts), "apfs");
});

test("the folder is kept in settings, but not in what the page reads", async (t) => {
  const directory = await makeTempDirectory(t);
  const options = { isSupportedLanguage: (code) => code === "en", defaultLanguage: "en" };
  const settings = new SettingsStore(directory, options);
  await settings.load();
  await assert.rejects(settings.setOutsideFolder("relative/path"), /Could not save/);
  await settings.setOutsideFolder("/Volumes/Backup/Mnemo copies");
  assert.equal(Object.hasOwn(settings.get(), "outsideFolder"), false);
  const reloaded = new SettingsStore(directory, options);
  await reloaded.load();
  assert.equal(reloaded.getOutsideFolder(), "/Volumes/Backup/Mnemo copies");
  await reloaded.setOutsideFolder(null);
  const cleared = new SettingsStore(directory, options);
  await cleared.load();
  assert.equal(cleared.getOutsideFolder(), null);
});
