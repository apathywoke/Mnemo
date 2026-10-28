const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const OLD = "correct horse battery staple";
const NEW = "мой длинный пароль для сейфа";
const TOTP = "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP";
const card = (fields, id = "") => ({
  id,
  type: "card",
  name: "Visa",
  notes: "",
  fields: { cardholder: "Alice", number: "4242 4242 4242 4242", expiry: "07/28", cvv: "123", pin: "", ...fields },
});

// A vault with every kind of sealed value: a login with a one-time code and
// an earlier password, a card with an earlier security code, and two
// attachments.
async function makeVault(t) {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "rekey.vault"));
  await store.create(OLD);
  const login = await store.saveEntry({ ...makeLogin({ password: "first password" }), totp: TOTP });
  await store.saveEntry({ ...makeLogin({ id: login.id, password: "second password" }), totp: "" });
  await store.saveEntry({ ...makeLogin({ id: login.id, password: "", notes: "edited" }), totp: "" });
  const visa = await store.saveItem(card({}));
  await store.saveItem(card({ number: "", cvv: "999" }, visa.id));
  const contents = [randomBytes(70 * 1024), Buffer.from("second file")];
  for (const [index, bytes] of contents.entries()) {
    const source = path.join(directory, `file-${index}.bin`);
    await fs.writeFile(source, bytes);
    await store.addAttachment(index === 0 ? login.id : visa.id, source);
  }
  return { directory, store, login, visa, contents, recoveryKey: store.takeIssuedRecoveryKey() };
}

// Everything a user can read, for comparing before and after a rotation.
async function snapshot(store, { directory, login, visa }) {
  const exports = [];
  for (const id of [login.id, visa.id]) {
    for (const attachment of store.getEntry(id).attachments) {
      const target = path.join(directory, `out-${attachment.id}`);
      await store.exportAttachment(id, attachment.id, target);
      exports.push([attachment.name, (await fs.readFile(target)).toString("base64")]);
    }
  }
  const versionSecrets = [
    ...store.getHistory(login.id).map((version) => store.revealVersionSecret(login.id, version.id, "password")),
    ...store.getHistory(visa.id).flatMap((version) =>
      version.secretFields.map((field) => store.revealVersionSecret(visa.id, version.id, field))),
  ];
  return {
    password: store.revealPassword(login.id),
    totp: store.getTotpCode(login.id, 1_800_000_000_000).code,
    card: ["number", "cvv"].map((field) => store.revealItemSecret(visa.id, field)),
    history: [store.getHistory(login.id), store.getHistory(visa.id)],
    versionSecrets,
    exports,
  };
}

async function attachmentFiles(store) {
  return (await fs.readdir(store.attachmentDirectory)).filter((name) => name.endsWith(".bin")).sort();
}

test("changing the passphrase replaces the vault key and keeps everything readable", async (t) => {
  const vault = await makeVault(t);
  const { store, directory } = vault;
  const before = await snapshot(store, vault);
  const oldKey = store.exportDataKey();
  const oldFiles = await attachmentFiles(store);
  const oldCopy = path.join(directory, "old-copy.vault");
  await fs.copyFile(store.filePath, oldCopy);

  await assert.rejects(store.changePassphrase("wrong passphrase 123", NEW), /passphrase is incorrect/);
  await assert.rejects(store.changePassphrase(OLD, "short"), /at least 12 characters/);
  await assert.rejects(store.changePassphrase(OLD, "password password"), /too easy to guess/);
  const newRecoveryKey = await store.changePassphrase(OLD, NEW);
  assert.notEqual(newRecoveryKey, vault.recoveryKey);

  // Secrets, history with its changes, and attachments read as before.
  assert.deepEqual(await snapshot(store, vault), before);
  assert.deepEqual(before.history[0].map((version) => version.changes), [["notes"], ["password"]]);
  // New attachment files under new IDs; the old ones are gone.
  const newFiles = await attachmentFiles(store);
  assert.equal(newFiles.length, oldFiles.length);
  assert.equal(newFiles.some((name) => oldFiles.includes(name)), false);

  // The old passphrase, recovery key, and vault key no longer open the file.
  store.lock();
  await assert.rejects(store.unlock(OLD), /Could not open the vault/);
  await assert.rejects(store.unlockWithDataKey(oldKey), /Touch ID can no longer unlock/);
  await assert.rejects(store.recoverWithKey(vault.recoveryKey, "another strong passphrase 9"), /with this recovery key/);
  await store.unlock(NEW);
  assert.deepEqual(await snapshot(store, vault), before);

  // Residual risk, by design: an old copy still opens with the old passphrase.
  const copy = new VaultStore(oldCopy);
  await copy.unlock(OLD);
  assert.equal(copy.revealPassword(vault.login.id), "second password");
});

test("unchanged sealed values stay identical, so history shows no false changes", async (t) => {
  const vault = await makeVault(t);
  const { store, login } = vault;
  const entry = () => store.vaultData.entries.find((item) => item.id === login.id);
  // The latest version only changed notes, so its password is the current one.
  assert.deepEqual(entry().history[0].password, entry().password);
  await store.changePassphrase(OLD, NEW);
  assert.deepEqual(entry().history[0].password, entry().password);
  assert.notDeepEqual(entry().history[1].password, entry().password);
  assert.deepEqual(store.getHistory(login.id)[0].changes, ["notes"]);
});

test("a failed write leaves the old vault and its files as they were", async (t) => {
  const vault = await makeVault(t);
  const { store } = vault;
  const before = await snapshot(store, vault);
  const oldFiles = await attachmentFiles(store);
  const writeEnvelope = store.writeEnvelope;

  store.writeEnvelope = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(store.changePassphrase(OLD, NEW), /disk full/);
  store.writeEnvelope = writeEnvelope;
  assert.deepEqual(await attachmentFiles(store), oldFiles);
  assert.deepEqual(await snapshot(store, vault), before);

  // Failing on the second new attachment file removes the first one too.
  const writeBytes = store.writeBytesAtomically;
  let writes = 0;
  store.writeBytesAtomically = async (...args) => {
    writes += 1;
    if (writes === 2) throw new Error("disk full");
    return writeBytes.apply(store, args);
  };
  await assert.rejects(store.createRecoveryKey(OLD), /disk full/);
  store.writeBytesAtomically = writeBytes;
  assert.deepEqual(await attachmentFiles(store), oldFiles);

  store.lock();
  await store.unlock(OLD);
  assert.deepEqual(await snapshot(store, vault), before);
});

test("a new recovery key and recovery also replace the vault key", async (t) => {
  const vault = await makeVault(t);
  const { store } = vault;
  const before = await snapshot(store, vault);

  let oldKey = store.exportDataKey();
  const fromSettings = await store.createRecoveryKey(OLD);
  assert.deepEqual(await snapshot(store, vault), before);
  store.lock();
  await assert.rejects(store.unlockWithDataKey(oldKey), /Touch ID can no longer unlock/);
  await assert.rejects(store.recoverWithKey(vault.recoveryKey, NEW), /with this recovery key/);

  await store.unlock(OLD);
  oldKey = store.exportDataKey();
  const oldFiles = await attachmentFiles(store);
  store.lock();
  const recovered = await store.recoverWithKey(fromSettings, NEW);
  assert.deepEqual(await snapshot(store, vault), before);
  assert.equal((await attachmentFiles(store)).some((name) => oldFiles.includes(name)), false);
  store.lock();
  await assert.rejects(store.unlockWithDataKey(oldKey), /Touch ID can no longer unlock/);
  await assert.rejects(store.recoverWithKey(fromSettings, OLD), /with this recovery key/);
  await store.recoverWithKey(recovered.recoveryKey, "a third long passphrase 7");
});

test("restoring a backup with the recovery key gives the restored vault a new key", async (t) => {
  const vault = await makeVault(t);
  const { store, directory } = vault;
  const before = await snapshot(store, vault);
  const backupKey = store.exportDataKey();
  const backupPath = path.join(directory, "backup.vault");
  await store.exportBackup(backupPath);

  const target = new VaultStore(path.join(directory, "target.vault"));
  await target.restoreBackup(backupPath, { recoveryKey: vault.recoveryKey, newPassphrase: NEW });
  assert.deepEqual(await snapshot(target, vault), before);
  const restoredIds = (await attachmentFiles(target)).map((name) => name.replace(".bin", ""));
  const backupIds = store.vaultData.entries.flatMap((entry) => (entry.attachments ?? []).map((item) => item.id));
  assert.equal(restoredIds.some((id) => backupIds.includes(id)), false);
  target.lock();
  await assert.rejects(target.unlockWithDataKey(backupKey), /Touch ID can no longer unlock/);
  await target.unlock(NEW);

  // A damaged backup still restores nothing.
  const damaged = Buffer.from(await fs.readFile(backupPath));
  damaged[damaged.length - 5] ^= 0xff;
  await fs.writeFile(backupPath, damaged);
  const other = new VaultStore(path.join(directory, "other.vault"));
  await assert.rejects(
    other.restoreBackup(backupPath, { recoveryKey: vault.recoveryKey, newPassphrase: NEW }),
    /incomplete or damaged/,
  );
  assert.equal((await other.getStatus()).vaultExists, false);
  await assert.rejects(fs.readdir(other.attachmentDirectory).then((names) => {
    if (names.length) throw new Error("files left");
    throw new Error("empty");
  }), /empty|ENOENT/);
});

// Locking (which changes sessionEpoch) while a rotation runs must stop it
// before the vault file is replaced, remove the files it already wrote, and
// say why.
test("locking during a rotation stops it and leaves the old vault whole", async (t) => {
  const vault = await makeVault(t);
  const { store } = vault;
  const before = await snapshot(store, vault);
  const oldFiles = await attachmentFiles(store);
  const writeBytes = store.writeBytesAtomically;
  const writeEnvelope = store.writeEnvelope;
  let envelopeWrites = 0;
  store.writeEnvelope = async (...args) => {
    envelopeWrites += 1;
    return writeEnvelope.apply(store, args);
  };

  // 1. After the first of two new attachment files.
  let writes = 0;
  store.writeBytesAtomically = async (...args) => {
    await writeBytes.apply(store, args);
    writes += 1;
    if (writes === 1) store.lock();
  };
  await assert.rejects(store.changePassphrase(OLD, NEW), /^Error: The vault was locked while saving\. Unlock it again\.$/);
  store.writeBytesAtomically = writeBytes;
  assert.equal(writes, 1);
  assert.equal(envelopeWrites, 0);
  assert.equal(store.isUnlocked(), false);
  assert.deepEqual(await attachmentFiles(store), oldFiles);
  await store.unlock(OLD);
  assert.deepEqual(await snapshot(store, vault), before);

  // 2. After all new files, while the new envelope is being derived
  //    (scrypt takes far longer than this timer).
  writes = 0;
  store.writeBytesAtomically = async (...args) => {
    await writeBytes.apply(store, args);
    writes += 1;
    if (writes === oldFiles.length) setTimeout(() => store.lock(), 10);
  };
  await assert.rejects(store.createRecoveryKey(OLD), /^Error: The vault was locked while saving\. Unlock it again\.$/);
  store.writeBytesAtomically = writeBytes;
  assert.equal(writes, oldFiles.length);
  assert.equal(envelopeWrites, 0);
  assert.deepEqual(await attachmentFiles(store), oldFiles);
  await store.unlock(OLD);
  assert.deepEqual(await snapshot(store, vault), before);

  // 3. Recovery from the lock screen says it was interrupted.
  store.lock();
  writes = 0;
  store.writeBytesAtomically = async (...args) => {
    await writeBytes.apply(store, args);
    writes += 1;
    if (writes === 1) store.lock();
  };
  await assert.rejects(store.recoverWithKey(vault.recoveryKey, NEW), /^Error: Recovery was interrupted because the vault was locked\.$/);
  store.writeBytesAtomically = writeBytes;
  assert.equal(envelopeWrites, 0);
  assert.deepEqual(await attachmentFiles(store), oldFiles);
  await store.unlock(OLD);
  assert.deepEqual(await snapshot(store, vault), before);
});
