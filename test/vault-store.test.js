const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { makeLogin, makePngHeader, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";

test("vault lifecycle, encrypted entries, validation, icon storage, and locking", async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "vault.json");
  const store = new VaultStore(filePath);

  assert.deepEqual(await store.getStatus(), {
    vaultExists: false,
    unlocked: false,
    entryCount: 0,
  });
  await assert.rejects(store.create("short"), /at least 7 characters/);

  const created = await store.create(PASSPHRASE);
  assert.deepEqual(created, { vaultExists: true, unlocked: true, entryCount: 0 });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
  await assert.rejects(store.create(PASSPHRASE), /already exists/);

  const login = await store.saveEntry(makeLogin({ name: "  Example account  " }));
  assert.match(login.id, /^[0-9a-f-]{36}$/i);
  assert.equal(login.name, "Example account");
  assert.equal(login.url, "https://example.com/login");
  assert.equal(login.favicon, "");
  assert.equal(Object.hasOwn(login, "password"), false);

  const encrypted = await fs.readFile(filePath, "utf8");
  assert.equal(encrypted.includes(login.password), false);
  assert.equal(encrypted.includes(login.username), false);

  const copiedEntry = store.listEntries()[0];
  copiedEntry.name = "mutated copy";
  assert.equal(store.listEntries()[0].name, "Example account");
  assert.deepEqual(Object.keys(copiedEntry).sort(), [
    "createdAt", "favicon", "id", "name", "type", "updatedAt", "url", "username",
  ]);
  assert.equal(store.getEntry(login.id).notes, "local test data");
  assert.equal(Object.hasOwn(store.getEntry(login.id), "password"), false);
  assert.equal(store.revealPassword(login.id), "test-password-value");
  assert.throws(() => store.revealPassword("not-an-id"), /Invalid login entry/);
  assert.equal(JSON.stringify(store.vaultData).includes("test-password-value"), false);

  await assert.rejects(
    store.saveEntry(makeLogin({ name: "   " })),
    /Enter a name/,
  );
  await assert.rejects(
    store.saveEntry(makeLogin({ password: "" })),
    /Enter a password/,
  );
  await assert.rejects(
    store.saveEntry({ ...makeLogin(), unexpected: true }),
    /Invalid login entry/,
  );
  await assert.rejects(
    store.saveEntry(makeLogin({ url: "javascript:alert(1)" })),
    /valid website address/,
  );

  const favicon = `data:image/png;base64,${makePngHeader(48, 48).toString("base64")}`;
  const iconUpdated = await store.saveFavicon(login.id, favicon);
  assert.equal(iconUpdated.favicon, favicon);
  await assert.rejects(
    store.saveFavicon(login.id, "data:image/svg+xml;base64,PHN2Zy8+"),
    /website icon is invalid/,
  );
  const edited = await store.saveEntry({
    id: login.id,
    name: "Renamed account",
    username: "new@example.com",
    password: "updated-password",
    url: "https://example.com/account",
    notes: "updated",
  });
  assert.equal(edited.id, login.id);
  assert.equal(edited.createdAt, login.createdAt);
  assert.equal(edited.favicon, favicon);
  assert.equal(store.listEntries()[0].name, "Renamed account");
  assert.equal(store.revealPassword(login.id), "updated-password");

  await store.saveEntry({ ...makeLogin({ id: login.id, name: "Kept password" }), password: "" });
  assert.equal(store.revealPassword(login.id), "updated-password");

  await store.deleteEntry(login.id);
  assert.deepEqual(store.listEntries(), []);
  await assert.rejects(store.deleteEntry(login.id), /no longer exists/);
  await assert.rejects(store.deleteEntry("not-an-id"), /Invalid login entry/);

  await store.saveEntry(makeLogin());
  store.lock();
  assert.deepEqual(await store.getStatus(), {
    vaultExists: true,
    unlocked: false,
    entryCount: 0,
  });
  assert.throws(() => store.listEntries(), /Unlock the vault first/);
  assert.throws(() => store.revealPassword(login.id), /Unlock the vault first/);
  await assert.rejects(store.unlock("wrong passphrase"), /Could not open the vault/);

  const unlocked = await store.unlock(PASSPHRASE);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.entryCount, 1);
  assert.equal(store.revealPassword(store.listEntries()[0].id), "test-password-value");
});

test("backup export and restore reject tampering and wrong passphrases", async (t) => {
  const directory = await makeTempDirectory(t);
  const source = new VaultStore(path.join(directory, "source.vault"));
  await source.create(PASSPHRASE);
  await source.saveEntry(makeLogin());

  const backupPath = path.join(directory, "backup.vault");
  assert.deepEqual(await source.exportBackup(backupPath), { exported: true });
  await assert.rejects(source.exportBackup(source.filePath), /different location/);

  const originalBytes = await fs.readFile(backupPath, "utf8");
  const tamperedEnvelope = JSON.parse(originalBytes);
  const ciphertext = Buffer.from(tamperedEnvelope.data.ciphertext, "base64");
  ciphertext[0] ^= 1;
  tamperedEnvelope.data.ciphertext = ciphertext.toString("base64");
  const tamperedPath = path.join(directory, "tampered.vault");
  await fs.writeFile(tamperedPath, JSON.stringify(tamperedEnvelope));

  const restored = new VaultStore(path.join(directory, "restored.vault"));
  await assert.rejects(
    restored.restoreBackup(backupPath, "incorrect passphrase"),
    /Could not open the vault/,
  );
  await assert.rejects(
    restored.restoreBackup(tamperedPath, PASSPHRASE),
    /Could not open the vault/,
  );
  assert.equal(await restored.fileExists(), false);

  const status = await restored.restoreBackup(backupPath, PASSPHRASE);
  assert.equal(status.unlocked, true);
  assert.equal(status.entryCount, 1);
  assert.equal(restored.revealPassword(restored.listEntries()[0].id), "test-password-value");

  const restoredBytes = await fs.readFile(restored.filePath, "utf8");
  assert.equal(restoredBytes, originalBytes);
});

test("backup restoration is serialized with entry mutations", async (t) => {
  const directory = await makeTempDirectory(t);
  const source = new VaultStore(path.join(directory, "source.vault"));
  await source.create(PASSPHRASE);
  await source.saveEntry(makeLogin({ name: "From backup" }));
  const backupPath = path.join(directory, "source-backup.vault");
  await source.exportBackup(backupPath);

  const target = new VaultStore(path.join(directory, "target.vault"));
  await target.create("another secure passphrase");
  await target.saveEntry(makeLogin({ name: "Old target entry" }));

  const restore = target.restoreBackup(backupPath, PASSPHRASE);
  const saveAfterRestore = target.saveEntry(makeLogin({ name: "Saved during restore" }));
  await Promise.all([restore, saveAfterRestore]);

  assert.deepEqual(
    new Set(target.listEntries().map((entry) => entry.name)),
    new Set(["From backup", "Saved during restore"]),
  );
});

test("schema 1 vaults with plain password fields are upgraded to sealed passwords", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "legacy.vault"));
  await store.create(PASSPHRASE);
  const { id } = await store.saveEntry(makeLogin());

  // Rewrite the vault as schema 1, the format used before per-entry sealing.
  const legacyEntries = store.vaultData.entries.map((entry) => ({
    ...entry,
    password: store.revealPassword(entry.id),
  }));
  await store.persistVaultData({ schemaVersion: 1, entries: legacyEntries });
  store.lock();

  await store.unlock(PASSPHRASE);
  assert.equal(store.vaultData.schemaVersion, 2);
  assert.equal(typeof store.vaultData.entries[0].password, "object");
  assert.equal(store.revealPassword(id), "test-password-value");

  await store.saveEntry(makeLogin({ id, name: "Upgraded", password: "" }));
  store.lock();
  await store.unlock(PASSPHRASE);
  assert.equal(store.vaultData.schemaVersion, 2);
  assert.equal(store.revealPassword(id), "test-password-value");
});

test("sealed passwords are bound to their entry ID", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "bound.vault"));
  await store.create(PASSPHRASE);
  const first = await store.saveEntry(makeLogin({ name: "First", password: "first-secret" }));
  const second = await store.saveEntry(makeLogin({ name: "Second", password: "second-secret" }));

  const [firstEntry, secondEntry] = ["First", "Second"].map((name) =>
    store.vaultData.entries.find((entry) => entry.name === name));
  secondEntry.password = firstEntry.password;
  assert.equal(store.revealPassword(first.id), "first-secret");
  assert.throws(() => store.revealPassword(second.id), /Could not decrypt/);
});
