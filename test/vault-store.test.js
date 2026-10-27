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

test("recovery key opens the vault, resets the passphrase, and is replaced", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "recovery.vault"));
  await store.create(PASSPHRASE);
  const recoveryKey = store.takeIssuedRecoveryKey();
  assert.match(recoveryKey, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(store.takeIssuedRecoveryKey(), null);
  assert.equal(store.hasRecoveryKey(), true);
  const { id } = await store.saveEntry(makeLogin());

  const file = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  assert.equal(file.version, 2);
  assert.equal(JSON.stringify(file).includes(recoveryKey.replaceAll("-", "")), false);
  store.lock();

  // Typos are caught by the checksum before any decryption.
  const typo = recoveryKey.slice(0, -1) + (recoveryKey.endsWith("0") ? "1" : "0");
  await assert.rejects(store.recoverWithKey(typo, "new passphrase 123"), /recovery key is not valid/);
  await assert.rejects(store.recoverWithKey(recoveryKey, "short"), /at least 7 characters/);

  // Lowercase, spaces, and look-alike letters are accepted.
  const typed = recoveryKey.toLowerCase().replaceAll("-", " ").replaceAll("0", "o");
  const recovered = await store.recoverWithKey(typed, "new passphrase 123");
  assert.equal(recovered.status.unlocked, true);
  assert.notEqual(recovered.recoveryKey, recoveryKey);
  assert.equal(store.revealPassword(id), "test-password-value");
  store.lock();

  await assert.rejects(store.unlock(PASSPHRASE), /Could not open the vault/);
  await assert.rejects(store.recoverWithKey(recoveryKey, "another passphrase"), /with this recovery key/);
  await store.unlock("new passphrase 123");
  assert.equal(store.revealPassword(id), "test-password-value");
  store.lock();
  await store.recoverWithKey(recovered.recoveryKey, "third passphrase 123");
});

test("a new recovery key needs the current passphrase and replaces the old one", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "rotate.vault"));
  await store.create(PASSPHRASE);
  const original = store.takeIssuedRecoveryKey();
  await store.saveEntry(makeLogin());

  await assert.rejects(store.createRecoveryKey("wrong passphrase"), /master passphrase is incorrect/);
  const replacement = await store.createRecoveryKey(PASSPHRASE);
  assert.notEqual(replacement, original);
  store.lock();

  await assert.rejects(store.recoverWithKey(original, "new passphrase 123"), /with this recovery key/);
  await store.unlock(PASSPHRASE);
  store.lock();
  await store.recoverWithKey(replacement, "new passphrase 123");
});

test("format 1 vaults still open and gain a recovery key on request", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "legacy-format.vault"));
  await store.create(PASSPHRASE);
  const { id } = await store.saveEntry(makeLogin());
  store.lock();

  // Rebuild the file as format 1: same data key, no recovery wrap.
  const crypto = require("node:crypto");
  const v2 = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  const v2Header = { format: v2.format, version: 2, kdf: v2.kdf, recovery: v2.recovery };
  const aad = (purpose, header) => Buffer.from(`local-vault:${purpose}:v${header.version}:${JSON.stringify(header)}`);
  const unwrap = (record, key, data) => {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "base64"));
    decipher.setAAD(data);
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  };
  const wrap = (plaintext, key, data) => {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(data);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { name: "aes-256-gcm", nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  };
  const wrappingKey = crypto.scryptSync(PASSPHRASE, Buffer.from(v2.kdf.salt, "base64"), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const dataKey = unwrap(v2.keyWrap, wrappingKey, aad("key-wrap", v2Header));
  const vaultData = unwrap(v2.data, dataKey, aad("vault-data", v2Header));
  const v1Header = { format: v2.format, version: 1, kdf: v2.kdf };
  await fs.writeFile(store.filePath, JSON.stringify({
    ...v1Header,
    keyWrap: wrap(dataKey, wrappingKey, aad("key-wrap", v1Header)),
    data: wrap(vaultData, dataKey, aad("vault-data", v1Header)),
  }));

  await store.unlock(PASSPHRASE);
  assert.equal(store.hasRecoveryKey(), false);
  assert.equal(store.revealPassword(id), "test-password-value");
  store.lock();
  await assert.rejects(store.recoverWithKey("0".repeat(56), "new passphrase 123"), /recovery key is not valid|no recovery key/);

  await store.unlock(PASSPHRASE);
  const recoveryKey = await store.createRecoveryKey(PASSPHRASE);
  assert.equal(store.hasRecoveryKey(), true);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).version, 2);
  store.lock();
  await store.recoverWithKey(recoveryKey, "new passphrase 123");
  assert.equal(store.revealPassword(id), "test-password-value");
});

test("tampering with the recovery wrap or header is detected", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "tamper.vault"));
  await store.create(PASSPHRASE);
  const recoveryKey = store.takeIssuedRecoveryKey();
  store.lock();
  const original = await fs.readFile(store.filePath, "utf8");

  const stripped = JSON.parse(original);
  delete stripped.recoveryWrap;
  await fs.writeFile(store.filePath, JSON.stringify(stripped));
  await assert.rejects(store.unlock(PASSPHRASE), /Could not open the vault/);

  const resalted = JSON.parse(original);
  resalted.recovery.salt = Buffer.alloc(16, 7).toString("base64");
  await fs.writeFile(store.filePath, JSON.stringify(resalted));
  await assert.rejects(store.unlock(PASSPHRASE), /Could not open the vault/);
  await assert.rejects(store.recoverWithKey(recoveryKey, "new passphrase 123"), /with this recovery key/);

  await fs.writeFile(store.filePath, original);
  await store.unlock(PASSPHRASE);
});

test("a backup opens with its recovery key and gets a new passphrase and key", async (t) => {
  const directory = await makeTempDirectory(t);
  const source = new VaultStore(path.join(directory, "source.vault"));
  await source.create(PASSPHRASE);
  const recoveryKey = source.takeIssuedRecoveryKey();
  const { id } = await source.saveEntry(makeLogin());
  const backupPath = path.join(directory, "backup.vault");
  await source.exportBackup(backupPath);

  const target = new VaultStore(path.join(directory, "target.vault"));
  await assert.rejects(
    target.restoreBackup(backupPath, { recoveryKey, newPassphrase: "short" }),
    /at least 7 characters/,
  );
  await assert.rejects(
    target.restoreBackup(backupPath, { recoveryKey, newPassphrase: "new passphrase 123", extra: 1 }),
    /recovery key is not valid/,
  );
  const status = await target.restoreBackup(backupPath, {
    recoveryKey,
    newPassphrase: "new passphrase 123",
  });
  assert.equal(status.unlocked, true);
  const newKey = target.takeIssuedRecoveryKey();
  assert.ok(newKey && newKey !== recoveryKey);
  assert.equal(target.revealPassword(id), "test-password-value");
  target.lock();

  await assert.rejects(target.unlock(PASSPHRASE), /Could not open the vault/);
  await target.unlock("new passphrase 123");
  target.lock();
  await target.recoverWithKey(newKey, "third passphrase 123");

  // Restoring with the passphrase keeps the file as-is and issues no key.
  const plain = new VaultStore(path.join(directory, "plain.vault"));
  await plain.restoreBackup(backupPath, PASSPHRASE);
  assert.equal(plain.takeIssuedRecoveryKey(), null);
});

test("imported logins are sealed, deduplicated, and validated", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "import.vault"));
  await store.create(PASSPHRASE);
  await store.saveEntry(makeLogin({ name: "Existing", password: "same" }));

  const result = await store.importLogins([
    { name: "Existing", username: "user@example.com", password: "same", url: "example.com/login", notes: "" },
    { name: "New", username: "n", password: "new-pw", url: "new.example", notes: "x" },
    { name: "New", username: "n", password: "new-pw", url: "new.example", notes: "x" },
    { name: "Bad", username: "", password: "pw", url: "javascript:alert(1)", notes: "" },
    { name: "Long", username: "", password: "x".repeat(5000), url: "", notes: "" },
  ]);
  assert.deepEqual(result, { imported: 1, duplicates: 2, invalid: 2 });
  const added = store.listEntries().find((entry) => entry.name === "New");
  assert.equal(added.url, "https://new.example");
  assert.equal(store.revealPassword(added.id), "new-pw");
  assert.equal(JSON.stringify(store.vaultData).includes("new-pw"), false);

  // A Mnemo backup can be read for import with its passphrase or recovery key.
  const recoveryKey = store.takeIssuedRecoveryKey();
  const backupPath = path.join(directory, "import-backup.vault");
  await store.exportBackup(backupPath);
  const byPassphrase = await VaultStore.readBackupLogins(backupPath, PASSPHRASE);
  const byKey = await VaultStore.readBackupLogins(backupPath, { recoveryKey });
  assert.deepEqual(byKey, byPassphrase);
  assert.equal(byKey.find((login) => login.name === "New").password, "new-pw");
  await assert.rejects(VaultStore.readBackupLogins(backupPath, "wrong passphrase"), /Could not open the vault/);
});

test("the vault opens with its data key, and a wrong key is refused", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "datakey.vault"));
  await store.create(PASSPHRASE);
  const { id } = await store.saveEntry(makeLogin());
  const dataKey = store.exportDataKey();
  assert.notEqual(dataKey, store.dataKey);
  store.lock();
  assert.throws(() => store.exportDataKey(), /Unlock the vault first/);

  const status = await store.unlockWithDataKey(dataKey);
  assert.equal(status.unlocked, true);
  assert.equal(store.revealPassword(id), "test-password-value");
  store.lock();

  await assert.rejects(
    store.unlockWithDataKey(Buffer.alloc(32, 1)),
    /Touch ID can no longer unlock this vault/,
  );
  await assert.rejects(store.unlockWithDataKey(Buffer.alloc(16)), /Touch ID can no longer/);
});
