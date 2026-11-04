const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const ProfileManager = require("../src/main/profile-manager");
const SettingsStore = require("../src/main/settings-store");
const { describeWriteError, removeStaleTemporaryFiles, syncDirectory } = require("../src/main/durable-file");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const DISK_FULL = /not enough free disk space/;

async function makeVault(t) {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "vault.json"));
  await store.create(PASSPHRASE);
  const saved = await store.saveEntry(makeLogin());
  return { directory, store, saved };
}

// Every write to a file opened for writing fails, as on a full disk.
function fillDisk(t, code = "ENOSPC") {
  const realOpen = fs.open;
  const full = async () => { throw Object.assign(new Error("no space"), { code }); };
  const mock = t.mock.method(fs, "open", async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    if (flags !== "r") {
      handle.writeFile = full;
      handle.write = full;
    }
    return handle;
  });
  return () => mock.mock.restore();
}

test("a rename is followed by a sync of its directory", async (t) => {
  const { directory, store, saved } = await makeVault(t);
  const steps = [];
  const realOpen = fs.open;
  const realRename = fs.rename;
  t.mock.method(fs, "rename", async (...args) => {
    steps.push("rename");
    return realRename(...args);
  });
  t.mock.method(fs, "open", async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    if (file === directory && flags === "r") {
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        steps.push("directory sync");
        return realSync();
      };
    }
    return handle;
  });
  await store.saveEntry({ ...makeLogin(), id: saved.id, name: "Renamed" });
  assert.deepEqual(steps, ["rename", "directory sync"]);

  steps.length = 0;
  await store.exportBackup(path.join(directory, "backup.vault"));
  assert.deepEqual(steps, ["rename", "directory sync"]);
});

test("a directory that cannot be synced does not fail a finished write", async (t) => {
  const directory = await makeTempDirectory(t);
  await syncDirectory(path.join(directory, "missing"));
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    if (file === directory) handle.sync = async () => { throw Object.assign(new Error("no"), { code: "EINVAL" }); };
    return handle;
  });
  await syncDirectory(directory);
});

test("a full disk says so, keeps the old data, and leaves no temporary file", async (t) => {
  const { directory, store, saved } = await makeVault(t);
  const before = await fs.readdir(directory);
  const restore = fillDisk(t);

  await assert.rejects(store.saveEntry({ ...makeLogin(), id: saved.id, name: "Renamed" }), DISK_FULL);
  await assert.rejects(store.exportBackup(path.join(directory, "backup.vault")), DISK_FULL);
  await assert.rejects(new VaultStore(path.join(directory, "new.json")).create(PASSPHRASE), DISK_FULL);
  restore();

  assert.deepEqual(await fs.readdir(directory), before);
  assert.equal(store.listEntries()[0].name, saved.name);
  store.lock();
  await store.unlock(PASSPHRASE);
  assert.equal(store.listEntries()[0].name, saved.name);
});

test("disk quota errors count as a full disk, and other errors stay as they are", () => {
  assert.match(describeWriteError(Object.assign(new Error("x"), { code: "EDQUOT" })).message, DISK_FULL);
  const other = Object.assign(new Error("x"), { code: "EACCES" });
  assert.equal(describeWriteError(other), other);
});

test("a full disk while saving the profile list says so", async (t) => {
  const directory = await makeTempDirectory(t);
  const manager = new ProfileManager(directory);
  fillDisk(t);
  await assert.rejects(manager.createProfile("Personal", PASSPHRASE), DISK_FULL);
});

test("damage is told apart from a wrong passphrase wherever it can be", async (t) => {
  const { store } = await makeVault(t);
  const recoveryKey = store.takeIssuedRecoveryKey();
  store.lock();
  const original = await fs.readFile(store.filePath, "utf8");
  const WRONG = /Check the master passphrase/;
  const DAMAGED = /vault file is damaged/;

  // A wrong passphrase, and a damaged key wrap, cannot be told apart.
  await assert.rejects(store.unlock("a wrong but long passphrase"), WRONG);
  const wrap = JSON.parse(original);
  wrap.keyWrap.ciphertext = Buffer.alloc(32, 7).toString("base64");
  await fs.writeFile(store.filePath, JSON.stringify(wrap));
  await assert.rejects(store.unlock(PASSPHRASE), WRONG);

  // The key opened, and the data did not.
  const data = JSON.parse(original);
  const ciphertext = Buffer.from(data.data.ciphertext, "base64");
  ciphertext[0] ^= 1;
  data.data.ciphertext = ciphertext.toString("base64");
  await fs.writeFile(store.filePath, JSON.stringify(data));
  await assert.rejects(store.unlock(PASSPHRASE), DAMAGED);
  await assert.rejects(store.recoverWithKey(recoveryKey, "new passphrase 123"), DAMAGED);
  // ... but with a wrong passphrase there is no telling.
  await assert.rejects(store.unlock("a wrong but long passphrase"), WRONG);

  // The file does not parse, whatever the passphrase.
  for (const contents of [original.slice(0, original.length / 2), "", "null", "{}"]) {
    await fs.writeFile(store.filePath, contents);
    await assert.rejects(store.unlock("a wrong but long passphrase"), DAMAGED);
  }

  // A file that cannot be read says nothing about what it holds.
  await fs.unlink(store.filePath);
  await assert.rejects(store.unlock(PASSPHRASE), WRONG);

  await fs.writeFile(store.filePath, original);
  await store.unlock(PASSPHRASE);
});

test("temporary files left by a crash are removed, and nothing else", async (t) => {
  const { directory, store } = await makeVault(t);
  const stale = `${store.filePath}.123.0123456789abcdef.tmp`;
  const keep = [
    `${store.filePath}.123.0123456789abcdef.deleting`,
    `${store.filePath}.tmp`,
    `${store.filePath}.123.short.tmp`,
    path.join(directory, "other.json.123.0123456789abcdef.tmp"),
  ];
  await fs.writeFile(stale, "leftover");
  for (const file of keep) await fs.writeFile(file, "keep");

  await store.maintain();
  await assert.rejects(fs.access(stale), { code: "ENOENT" });
  for (const file of keep) await fs.access(file);
  assert.equal(await removeStaleTemporaryFiles(path.join(directory, "missing", "file")), 0);

  const manager = new ProfileManager(directory);
  const staleRegistry = path.join(directory, "profiles.json.9.0123456789abcdef.tmp");
  await fs.writeFile(staleRegistry, "leftover");
  await manager.removeStaleTemporaryFiles();
  await assert.rejects(fs.access(staleRegistry), { code: "ENOENT" });

  const staleSettings = path.join(directory, "settings.json.9.0123456789abcdef.tmp");
  await fs.writeFile(staleSettings, "leftover");
  await new SettingsStore(directory, { isSupportedLanguage: () => true, defaultLanguage: "en" }).load();
  await assert.rejects(fs.access(staleSettings), { code: "ENOENT" });
});
