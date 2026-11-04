// Files from earlier versions still restore (step 5 of the data safety plan):
// a snapshot in today's format (a fixed fixture later versions must keep
// reading), a vault written by 0.2.1 (schema 3), and a format 1 vault.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { listSnapshotDirectory } = require("../src/main/vault/snapshots");
const { snapshotFoldersIn, listForFolders } = require("../src/main/snapshot-sources");
const { makeLogin, makeTempDirectory } = require("../support/helpers");
const snapshotFixture = require("./fixtures/snapshot-v1.json");
const schema3Fixture = require("./fixtures/schema3-notes.json");

const SNAPSHOT_FOLDER = path.join(__dirname, "fixtures", "snapshot-v1");
const SCHEMA3_VAULT = path.join(__dirname, "fixtures", "schema3-notes.vault");
const NEW_PASSPHRASE = "eine ganz neue lange Passphrase 42";

async function emptyStore(t, options = {}) {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "restored.vault"), options);
  t.after(() => store.lock());
  return { directory, store };
}

async function attachmentText(store, entryId) {
  const entry = store.vaultData.entries.find((item) => item.id === entryId);
  return (await store.openAttachment(entry, entry.attachments[0])).toString("utf8");
}

test("the fixed snapshot fixture is read and restored", async (t) => {
  const { complete, incomplete } = await listSnapshotDirectory(SNAPSHOT_FOLDER);
  assert.deepEqual(incomplete, []);
  assert.deepEqual(complete.map((item) => item.name), [snapshotFixture.snapshot]);
  assert.deepEqual(complete[0].description.attachments, [snapshotFixture.attachmentId]);
  assert.equal(listForFolders(await snapshotFoldersIn(SNAPSHOT_FOLDER)).length, 1);

  const file = path.join(SNAPSHOT_FOLDER, `${snapshotFixture.snapshot}.vault`);
  const poolDirectory = path.join(SNAPSHOT_FOLDER, "attachments");
  const byPassphrase = await emptyStore(t);
  await byPassphrase.store.restoreBackup(file, snapshotFixture.passphrase, { poolDirectory });
  assert.equal(byPassphrase.store.vaultData.entries[0].name, snapshotFixture.entryName);
  assert.equal(await attachmentText(byPassphrase.store, snapshotFixture.entryId), snapshotFixture.attachmentText);

  const byRecoveryKey = await emptyStore(t);
  await byRecoveryKey.store.restoreBackup(file, { recoveryKey: snapshotFixture.recoveryKey, newPassphrase: NEW_PASSPHRASE }, { poolDirectory });
  assert.equal(await attachmentText(byRecoveryKey.store, snapshotFixture.entryId), snapshotFixture.attachmentText);
});

test("a 0.2.1 vault restores as a backup and from its pinned pre-upgrade snapshot", async (t) => {
  const asBackup = await emptyStore(t);
  await asBackup.store.restoreBackup(SCHEMA3_VAULT, schema3Fixture.passphrase);
  assert.equal(asBackup.store.vaultData.schemaVersion, 4);
  assert.ok(asBackup.store.vaultData.entries.some((entry) => entry.id === schema3Fixture.ids.login));

  // Opened with snapshots on: the file is pinned before it is upgraded, and
  // that snapshot restores to the same items.
  const { directory, store } = await emptyStore(t, { snapshots: true });
  await fs.copyFile(SCHEMA3_VAULT, store.filePath);
  await store.unlock(schema3Fixture.passphrase);
  await store.saveEntry(makeLogin({ name: "Added after the upgrade" }));
  await store.enqueueMutation(async () => {});
  const pinned = (await store.listSnapshots()).complete.find((item) => item.description.pinned?.reason === "upgrade");
  assert.deepEqual(await fs.readFile(store.snapshotFile(pinned.name, "vault")), await fs.readFile(SCHEMA3_VAULT));
  const target = new VaultStore(path.join(directory, "from-snapshot.vault"));
  t.after(() => target.lock());
  await target.restoreBackup(store.snapshotFile(pinned.name, "vault"), schema3Fixture.passphrase, {
    poolDirectory: store.snapshotPoolDirectory,
  });
  assert.deepEqual(
    target.vaultData.entries.map((entry) => entry.id).sort(),
    asBackup.store.vaultData.entries.map((entry) => entry.id).sort(),
  );
});

test("a format 1 vault (no recovery key) restores from a snapshot", async (t) => {
  const { directory, store } = await emptyStore(t);
  const passphrase = "correct horse battery staple";
  await store.create(passphrase);
  const { id } = await store.saveEntry(makeLogin({ name: "Format 1" }));
  store.lock();

  // Rebuild the file as format 1: same data key, no recovery wrap.
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
  const wrappingKey = crypto.scryptSync(passphrase, Buffer.from(v2.kdf.salt, "base64"), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const dataKey = unwrap(v2.keyWrap, wrappingKey, aad("key-wrap", v2Header));
  const vaultData = unwrap(v2.data, dataKey, aad("vault-data", v2Header));
  const v1Header = { format: v2.format, version: 1, kdf: v2.kdf };
  const snapshotFolder = path.join(directory, "picked", "Mnemo", "legacy");
  await fs.mkdir(path.join(snapshotFolder, "attachments"), { recursive: true });
  const file = path.join(snapshotFolder, "format1.vault");
  await fs.writeFile(file, JSON.stringify({
    ...v1Header,
    keyWrap: wrap(dataKey, wrappingKey, aad("key-wrap", v1Header)),
    data: wrap(vaultData, dataKey, aad("vault-data", v1Header)),
  }));

  const target = new VaultStore(path.join(directory, "target.vault"));
  t.after(() => target.lock());
  await target.restoreBackup(file, passphrase, { poolDirectory: path.join(snapshotFolder, "attachments") });
  assert.equal(target.vaultData.entries.find((entry) => entry.id === id).name, "Format 1");
  assert.equal(target.hasRecoveryKey(), false);
  await assert.rejects(target.checkRecoveryKey("ABCD"), /no recovery key/);
});
