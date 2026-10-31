const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const ProfileManager = require("../src/main/profile-manager");
const VaultStore = require("../vault-store");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;
const card = (fields, id = "") => ({
  id,
  type: "card",
  name: "Visa",
  notes: "",
  fields: { cardholder: "Alice", number: "4242 4242 4242 4242", expiry: "07/28", cvv: "123", pin: "", ...fields },
});

async function openStore(t, name = "organize.vault") {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, name));
  await store.create(PASSPHRASE);
  return { directory, store };
}

async function writeFile(directory, name, contents) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

async function reopen(store) {
  store.lock();
  await store.unlock(PASSPHRASE);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("schema 2 vaults open with every sealed value readable and are saved as schema 3", async (t) => {
  const { store } = await openStore(t);
  const login = await store.saveEntry({ ...makeLogin(), totp: "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP" });
  const visa = await store.saveItem(card({}));
  // Write the vault the way the previous version stored it.
  await store.persistVaultData({ schemaVersion: 2, entries: store.vaultData.entries });
  await reopen(store);

  assert.equal(store.vaultData.schemaVersion, 3);
  assert.deepEqual(store.vaultData.folders, []);
  assert.equal(store.revealPassword(login.id), "test-password-value");
  assert.match(store.getTotpCode(login.id).code, /^\d{6}$/);
  assert.equal(store.revealItemSecret(visa.id, "number"), "4242424242424242");
  await store.saveEntry(makeLogin({ id: login.id, name: "Renamed", password: "" }));
  await reopen(store);
  assert.equal(store.vaultData.schemaVersion, 3);
  assert.equal(store.revealPassword(login.id), "test-password-value");
});

test("folders are named uniquely, keep their items on delete, and survive reopening", async (t) => {
  const { store } = await openStore(t);
  const work = await store.createFolder("  Work  ");
  assert.equal(work.name, "Work");
  await assert.rejects(store.createFolder("work"), /already exists/);
  await assert.rejects(store.createFolder("   "), /Enter a folder name/);
  await assert.rejects(store.createFolder("x".repeat(101)), /1–100 characters/);

  const login = await store.saveEntry(makeLogin({ folderId: work.id }));
  assert.equal(login.folderId, work.id);
  // Editing without a folder keeps it; null takes the item out.
  await store.saveEntry(makeLogin({ id: login.id, name: "Edited", password: "" }));
  assert.equal(store.getEntry(login.id).folderId, work.id);
  await assert.rejects(store.saveEntry(makeLogin({ folderId: randomUUID() })), /no longer exists/);
  await assert.rejects(store.setFolder(login.id, randomUUID()), /no longer exists/);

  const home = await store.createFolder("Home");
  await assert.rejects(store.renameFolder(home.id, "WORK"), /already exists/);
  assert.equal((await store.renameFolder(home.id, "Family")).name, "Family");
  assert.deepEqual(store.listFolders().map((folder) => folder.name), ["Family", "Work"]);
  await reopen(store);
  assert.equal(store.getEntry(login.id).folderId, work.id);

  await store.deleteFolder(work.id);
  assert.equal(store.getEntry(login.id).folderId, null);
  assert.equal(store.listEntries().length, 1);
  await assert.rejects(store.deleteFolder(work.id), /no longer exists/);
  await reopen(store);
  assert.deepEqual(store.listFolders().map((folder) => folder.name), ["Family"]);
});

test("favorites and folders do not change the date or add a version", async (t) => {
  const { store } = await openStore(t);
  const folder = await store.createFolder("Work");
  const login = await store.saveEntry(makeLogin());
  await store.setFavorite(login.id, true);
  await store.setFolder(login.id, folder.id);
  const after = store.getEntry(login.id);
  assert.equal(after.favorite, true);
  assert.equal(after.updatedAt, login.updatedAt);
  assert.equal(after.historyCount, 0);
  await assert.rejects(store.setFavorite(login.id, "yes"), /Invalid login entry/);
  await store.setFavorite(login.id, false);
  assert.equal(store.getEntry(login.id).favorite, false);
});

test("the trash keeps items restorable, blocks edits, and purges after 30 days", async (t) => {
  const { directory, store } = await openStore(t);
  const login = await store.saveEntry(makeLogin());
  const other = await store.saveEntry(makeLogin({ name: "Other" }));

  const trashed = await store.deleteEntry(login.id);
  assert.equal(typeof trashed.deletedAt, "number");
  await assert.rejects(store.saveEntry(makeLogin({ id: login.id, password: "" })), /Restore this item from the trash first/);
  await assert.rejects(store.setFavorite(login.id, true), /Restore this item from the trash first/);
  // Secrets of a trashed item can still be read before restoring it.
  assert.equal(store.revealPassword(login.id), "test-password-value");
  assert.equal((await store.restoreEntry(login.id)).deletedAt, null);

  // Deleting for good removes the item and its attachment files.
  const source = await writeFile(directory, "notes.txt", "secret notes");
  const attachment = await store.addAttachment(other.id, source);
  const attachmentFile = path.join(store.attachmentDirectory, `${attachment.id}.bin`);
  assert.equal(await exists(attachmentFile), true);
  await store.deleteEntry(other.id);
  assert.equal(await exists(attachmentFile), true);
  await store.deletePermanently(other.id);
  assert.equal(await exists(attachmentFile), false);
  assert.deepEqual(store.listEntries().map((entry) => entry.id), [login.id]);

  // Items trashed more than 30 days ago are removed when the vault opens.
  await store.deleteEntry(login.id);
  await store.maintain(Date.now() + 29 * DAY);
  assert.equal(store.listEntries().length, 1);
  await store.persistVaultData({
    ...store.vaultData,
    entries: store.vaultData.entries.map((entry) => ({ ...entry, deletedAt: Date.now() - 31 * DAY })),
  });
  await reopen(store);
  assert.equal(store.listEntries().length, 0);

  await store.saveEntry(makeLogin({ name: "A" }));
  await store.saveEntry(makeLogin({ name: "B" }));
  for (const entry of store.listEntries()) await store.deleteEntry(entry.id);
  assert.deepEqual(await store.emptyTrash(), { deleted: 2 });
  assert.equal(store.listEntries().length, 0);
});

test("history keeps earlier versions, skips saves that change nothing, and restores them", async (t) => {
  const { store } = await openStore(t);
  const login = await store.saveEntry(makeLogin({ password: "first password" }));
  await store.saveEntry(makeLogin({ id: login.id, password: "second password" }));
  let history = store.getHistory(login.id);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].changes, ["password"]);
  assert.equal(JSON.stringify(history).includes("first password"), false);
  assert.equal(store.revealVersionSecret(login.id, history[0].id, "password"), "first password");
  assert.throws(() => store.revealVersionSecret(login.id, history[0].id, "username"), /Could not copy/);
  assert.throws(() => store.revealVersionSecret(login.id, randomUUID(), "password"), /no longer exists/);

  // Saving the same values, or typing the same password again, is no change.
  const before = store.getEntry(login.id);
  await store.saveEntry(makeLogin({ id: login.id, password: "" }));
  await store.saveEntry(makeLogin({ id: login.id, password: "second password" }));
  assert.equal(store.getEntry(login.id).historyCount, 1);
  assert.equal(store.getEntry(login.id).updatedAt, before.updatedAt);

  await store.restoreVersion(login.id, history[0].id);
  assert.equal(store.revealPassword(login.id), "first password");
  history = store.getHistory(login.id);
  assert.equal(history.length, 1);
  assert.equal(store.revealVersionSecret(login.id, history[0].id, "password"), "second password");
  await reopen(store);
  assert.equal(store.revealPassword(login.id), "first password");

  for (let index = 0; index < 25; index += 1) {
    await store.saveEntry(makeLogin({ id: login.id, password: "", notes: `edit ${index}` }));
  }
  history = store.getHistory(login.id);
  assert.equal(history.length, 20);
  assert.equal(history[0].notes, "edit 23");
  assert.deepEqual(history[0].changes, ["notes"]);

  // Items: secret fields are compared and kept the same way.
  const visa = await store.saveItem(card({}));
  await store.saveItem(card({ number: "", cvv: "999" }, visa.id));
  await store.saveItem(card({ number: "4242 4242 4242 4242", cvv: "" }, visa.id));
  const versions = store.getHistory(visa.id);
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].changes, ["cvv"]);
  assert.equal(store.revealVersionSecret(visa.id, versions[0].id, "cvv"), "123");
  // A three-digit CVV can also turn up inside a random ID or a timestamp in
  // the summary, so look for it as a whole JSON string value.
  assert.equal(JSON.stringify(versions).includes(JSON.stringify("123")), false);
});

test("history is trimmed, oldest first, when the vault would exceed its size limit", async (t) => {
  const { store } = await openStore(t);
  for (let index = 0; index < 40; index += 1) await store.saveEntry(makeLogin({ name: `Login ${index}` }));
  const longNotes = "n".repeat(16000);
  let savedAt = Date.now();
  const entries = store.vaultData.entries.map((entry) => ({
    ...entry,
    history: Array.from({ length: 20 }, () => ({
      id: randomUUID(),
      savedAt: (savedAt += 1),
      updatedAt: entry.updatedAt,
      name: entry.name,
      username: entry.username,
      url: entry.url,
      notes: longNotes,
      password: entry.password,
    })).reverse(),
  }));
  const allVersions = entries.flatMap((entry) => entry.history);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...store.vaultData, entries })) > 10 * 1024 * 1024);

  await store.persistVaultData({ ...store.vaultData, entries });
  const kept = store.vaultData.entries.flatMap((entry) => entry.history ?? []);
  assert.ok(kept.length > 0 && kept.length < allVersions.length);
  assert.ok(Buffer.byteLength(JSON.stringify(store.vaultData)) <= 10 * 1024 * 1024);
  const oldestKept = Math.min(...kept.map((version) => version.savedAt));
  const keptIds = new Set(kept.map((version) => version.id));
  assert.ok(allVersions.filter((version) => !keptIds.has(version.id)).every((version) => version.savedAt < oldestKept));
  await reopen(store);
  assert.equal(store.listEntries().length, 40);
});

test("attachments are encrypted, saved back exactly, limited, and bound to their item", async (t) => {
  const { directory, store } = await openStore(t);
  const login = await store.saveEntry(makeLogin());
  const contents = randomBytes(200 * 1024);
  const source = await writeFile(directory, "scan.pdf", contents);

  const attachment = await store.addAttachment(login.id, source);
  assert.equal(attachment.name, "scan.pdf");
  assert.equal(attachment.size, contents.length);
  const stored = await fs.readFile(path.join(store.attachmentDirectory, `${attachment.id}.bin`));
  assert.equal(stored.length, contents.length + 36);
  assert.equal(stored.includes(contents.subarray(0, 64)), false);
  assert.equal((await fs.stat(store.attachmentDirectory)).mode & 0o777, 0o700);
  assert.deepEqual(store.getEntry(login.id).attachments, [attachment]);
  assert.equal(store.listEntries()[0].attachmentCount, 1);

  const copy = path.join(directory, "copy.pdf");
  assert.deepEqual(await store.exportAttachment(login.id, attachment.id, copy), { saved: true, name: "scan.pdf" });
  assert.deepEqual(await fs.readFile(copy), contents);
  await assert.rejects(
    store.exportAttachment(login.id, attachment.id, path.join(store.attachmentDirectory, "x")),
    /different location/,
  );
  await reopen(store);
  assert.deepEqual(await fs.readFile(copy), contents);

  // Sources: an absolute path to a readable file that is not the vault's own.
  await assert.rejects(store.addAttachment(login.id, "relative.txt"), /Could not read this file/);
  await assert.rejects(store.addAttachment(login.id, directory), /Could not read this file/);
  await assert.rejects(store.addAttachment(login.id, store.filePath), /Could not read this file/);
  const large = path.join(directory, "large.bin");
  await fs.writeFile(large, "");
  await fs.truncate(large, 50 * 1024 * 1024 + 1);
  await assert.rejects(store.addAttachment(login.id, large), /up to 50 MB/);
  const small = await writeFile(directory, "small.txt", "x");
  for (let index = 1; index < 20; index += 1) await store.addAttachment(login.id, small);
  await assert.rejects(store.addAttachment(login.id, small), /up to 20 attachments/);

  // A file that was changed on disk is reported by name, not silently used.
  const file = path.join(store.attachmentDirectory, `${attachment.id}.bin`);
  const damaged = Buffer.from(stored);
  damaged[damaged.length - 1] ^= 0xff;
  await fs.writeFile(file, damaged);
  await assert.rejects(
    store.exportAttachment(login.id, attachment.id, path.join(directory, "again.pdf")),
    /“scan\.pdf” in “Example account” is missing or damaged/,
  );
  await assert.rejects(store.exportBackup(path.join(directory, "backup.vault")), /“scan\.pdf”.*missing or damaged/);
  await fs.writeFile(file, stored);

  // The file key is bound to its item: moved to another item, it does not open.
  const other = await store.saveEntry(makeLogin({ name: "Other" }));
  const moved = store.vaultData.entries.map((entry) => {
    if (entry.id === login.id) {
      const { attachments, ...rest } = entry;
      return { ...rest, attachments: attachments.filter((item) => item.id !== attachment.id) };
    }
    if (entry.id === other.id) {
      return { ...entry, attachments: [login && store.vaultData.entries.find((item) => item.id === login.id).attachments[0]] };
    }
    return entry;
  });
  await store.persistVaultData({ ...store.vaultData, entries: moved });
  await assert.rejects(
    store.exportAttachment(other.id, attachment.id, path.join(directory, "moved.pdf")),
    /missing or damaged/,
  );

  // Deleting removes the file; unreferenced files are cleaned up on open.
  const remaining = store.getEntry(login.id).attachments[0];
  await store.deleteAttachment(login.id, remaining.id);
  assert.equal(await exists(path.join(store.attachmentDirectory, `${remaining.id}.bin`)), false);
  const orphan = path.join(store.attachmentDirectory, `${randomUUID()}.bin`);
  const leftover = path.join(store.attachmentDirectory, "x.bin.1.abc.tmp");
  await fs.writeFile(orphan, "orphan");
  await fs.writeFile(leftover, "partial");
  await reopen(store);
  assert.equal(await exists(orphan), false);
  assert.equal(await exists(leftover), false);
  assert.equal((await fs.readdir(store.attachmentDirectory)).length, 19);
});

test("backups carry attachments and are restored only when every file checks out", async (t) => {
  const { directory, store } = await openStore(t, "source.vault");
  const login = await store.saveEntry(makeLogin());
  const contents = randomBytes(64 * 1024);
  const attachment = await store.addAttachment(login.id, await writeFile(directory, "id-card.jpg", contents));
  const trashedItem = await store.saveEntry(makeLogin({ name: "Old" }));
  await store.deleteEntry(trashedItem.id);

  const backupPath = path.join(directory, "with-files.vault");
  assert.deepEqual(await store.exportBackup(backupPath), { exported: true, attachments: 1 });
  const backup = await fs.readFile(backupPath);
  assert.equal(backup.subarray(0, 8).toString("ascii"), "MNEMOBK1");
  assert.equal(backup.includes(contents.subarray(0, 64)), false);

  // Restored into a new vault, the file comes back byte for byte.
  const restored = new VaultStore(path.join(directory, "restored.vault"));
  await restored.restoreBackup(backupPath, PASSPHRASE);
  const copy = path.join(directory, "restored.jpg");
  await restored.exportAttachment(login.id, attachment.id, copy);
  assert.deepEqual(await fs.readFile(copy), contents);

  // Import reads the logins and reports the attachments it leaves out.
  const imported = await VaultStore.readBackupLogins(backupPath, PASSPHRASE);
  assert.deepEqual(imported.logins.map((item) => item.name), ["Example account"]);
  assert.equal(imported.attachments, 1);

  // Restoring over a vault with its own attachments replaces them.
  const target = new VaultStore(path.join(directory, "target.vault"));
  await target.create(PASSPHRASE);
  const own = await target.saveEntry(makeLogin({ name: "Own" }));
  const ownAttachment = await target.addAttachment(own.id, await writeFile(directory, "own.txt", "own file"));
  const ownFile = path.join(target.attachmentDirectory, `${ownAttachment.id}.bin`);

  // A damaged backup changes nothing: not the vault, not its files.
  const damaged = Buffer.from(backup);
  damaged[damaged.length - 10] ^= 0xff;
  const damagedPath = path.join(directory, "damaged.vault");
  await fs.writeFile(damagedPath, damaged);
  await assert.rejects(target.restoreBackup(damagedPath, PASSPHRASE), /incomplete or damaged/);
  const truncatedPath = path.join(directory, "truncated.vault");
  await fs.writeFile(truncatedPath, backup.subarray(0, backup.length - 1));
  await assert.rejects(target.restoreBackup(truncatedPath, PASSPHRASE), /Could not open the vault/);
  await reopen(target);
  assert.deepEqual(target.listEntries().map((entry) => entry.name), ["Own"]);
  assert.equal(await exists(ownFile), true);
  assert.deepEqual(await fs.readdir(target.attachmentDirectory), [`${ownAttachment.id}.bin`]);

  await target.restoreBackup(backupPath, PASSPHRASE);
  assert.deepEqual(target.listEntries().map((entry) => entry.name).sort(), ["Example account", "Old"]);
  assert.equal(await exists(ownFile), false);
  await target.exportAttachment(login.id, attachment.id, path.join(directory, "target.jpg"));
  assert.deepEqual(await fs.readFile(path.join(directory, "target.jpg")), contents);

  // A vault file is never read as a container, and a plain backup stays plain.
  await fs.copyFile(backupPath, store.filePath);
  store.lock();
  await assert.rejects(store.unlock(PASSPHRASE), /Could not open the vault/);
  const plain = new VaultStore(path.join(directory, "plain.vault"));
  await plain.create(PASSPHRASE);
  await plain.saveEntry(makeLogin());
  await plain.exportBackup(path.join(directory, "plain-backup.vault"));
  assert.equal((await fs.readFile(path.join(directory, "plain-backup.vault"), "utf8"))[0], "{");
});

test("deleting a profile removes its attachment files too", async (t) => {
  const directory = await makeTempDirectory(t);
  const manager = new ProfileManager(directory);
  const { profile, vaultStore } = await manager.createProfile("Personal", PASSPHRASE);
  const login = await vaultStore.saveEntry(makeLogin());
  await vaultStore.addAttachment(login.id, await writeFile(directory, "file.txt", "contents"));
  const attachmentDirectory = vaultStore.attachmentDirectory;
  assert.equal(await exists(attachmentDirectory), true);
  vaultStore.lock();

  await manager.deleteProfile(profile.id);
  assert.equal(await exists(attachmentDirectory), false);
  assert.deepEqual(
    (await fs.readdir(path.join(directory, "vaults"))).filter((name) => !name.startsWith(".")),
    [],
  );
});
