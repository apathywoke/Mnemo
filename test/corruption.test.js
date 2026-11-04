// Damaged bytes are never accepted silently (step 5 of the data safety plan):
// in the vault file, attachments, snapshots, their descriptions and pool,
// and copies outside this Mac.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { OutsideCopies } = require("../src/main/outside-copies");
const { listSnapshotDirectory, MIN_INTERVAL_MS } = require("../src/main/vault/snapshots");
const { decodeRecoveryKey } = require("../src/main/vault/recovery-key");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const PROFILE_ID = "6f1b0c1e-3a4d-4b5c-8d6e-7f8091a2b3c4";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// A vault with an attachment and a verified snapshot, copied outside.
async function setUp(t) {
  const directory = await makeTempDirectory(t);
  const vaultPath = path.join(directory, "data", `${PROFILE_ID}.vault`);
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  const clock = { now: Date.now() };
  const store = new VaultStore(vaultPath, { snapshots: true, now: () => clock.now });
  t.after(() => store.lock());
  await store.create(PASSPHRASE);
  const recoveryKey = store.takeIssuedRecoveryKey();
  const login = await store.saveEntry(makeLogin({ name: "Original" }));
  const source = path.join(directory, "file.txt");
  await fs.writeFile(source, "attachment contents ".repeat(50));
  const attachment = await store.addAttachment(login.id, source);
  await store.enqueueMutation(async () => {});
  clock.now += MIN_INTERVAL_MS;
  await store.enqueueMutation(() => store.takeSnapshotNow());
  const outsideFolder = path.join(directory, "outside");
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
  const [snapshot] = (await store.listSnapshots()).complete;
  return { directory, vaultPath, store, login, attachment, snapshot, outside, outsideFolder, recoveryKey, dataKey: store.exportDataKey() };
}

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// Positions of base64 characters inside each field of an envelope, with the
// part they belong to (kdf, recovery, keyWrap, recoveryWrap, data):
// changing one keeps the JSON valid, so the cryptography has to catch it.
function base64Fields(text) {
  const fields = [];
  for (const match of text.matchAll(/"(salt|nonce|tag|ciphertext)":"([A-Za-z0-9+/=]+)"/g)) {
    const start = match.index + match[0].indexOf(match[2]);
    const part = ["kdf", "recovery", "keyWrap", "recoveryWrap", "data"]
      .map((name) => ({ name, at: text.lastIndexOf(`"${name}":`, match.index) }))
      .sort((a, b) => b.at - a.at)[0].name;
    fields.push({ name: `${part}.${match[1]}`, part, start, length: match[2].replace(/=+$/, "").length });
  }
  return fields;
}

function changeCharacter(text, position) {
  const current = text[position];
  const next = BASE64[(BASE64.indexOf(current) + 1 + (current === "A" ? 1 : 0)) % 64];
  return `${text.slice(0, position)}${next}${text.slice(position + 1)}`;
}

test("a changed character in any part of a vault stops the secret that uses it", async (t) => {
  const { store, vaultPath, dataKey, recoveryKey } = await setUp(t);
  store.lock();
  const original = await fs.readFile(vaultPath, "utf8");
  const fields = base64Fields(original);
  assert.deepEqual([...new Set(fields.map((field) => field.part))].sort(), ["data", "kdf", "keyWrap", "recovery", "recoveryWrap"]);
  const recoveryKeyBytes = decodeRecoveryKey(recoveryKey);
  t.after(() => recoveryKeyBytes.fill(0));
  const random = seededRandom(7);
  for (const field of fields) {
    // The last character may hold padding bits, so it is left alone.
    const position = field.start + Math.floor(random() * Math.max(1, field.length - 1));
    await fs.writeFile(vaultPath, changeCharacter(original, position));
    const reader = new VaultStore(vaultPath);
    const where = `${field.name} at ${position}`;
    if (field.part === "data" || field.part === "kdf" || field.part === "recovery") {
      // In the authenticated header or the data: nothing opens it.
      await assert.rejects(reader.decryptVaultFile(vaultPath, { dataKey }), undefined, where);
      await assert.rejects(reader.decryptVaultFile(vaultPath, { recoveryKeyBytes }), undefined, where);
    } else if (field.part === "keyWrap") {
      await assert.rejects(reader.decryptVaultFile(vaultPath, PASSPHRASE), /Could not open/, where);
    } else {
      // A damaged recovery wrap: the passphrase still opens the vault, the
      // recovery key does not, and checking the key says so. The reminder
      // to check the key is how a user finds out in time.
      await assert.rejects(reader.decryptVaultFile(vaultPath, { recoveryKeyBytes }), /recovery key/, where);
      await reader.unlock(PASSPHRASE);
      await assert.rejects(reader.checkRecoveryKey(recoveryKey), /does not open this vault/, where);
      reader.lock();
    }
  }

  // Raw damage that breaks the JSON is reported as damage.
  const bytes = Buffer.from(original, "utf8");
  for (const position of [0, 1, Math.floor(bytes.length / 2), bytes.length - 1]) {
    const damaged = Buffer.from(bytes);
    damaged[position] = 0x00;
    await fs.writeFile(vaultPath, damaged);
    await assert.rejects(new VaultStore(vaultPath).unlock(PASSPHRASE), /damaged|Could not open/);
  }
  await fs.writeFile(vaultPath, original);
  await store.unlock(PASSPHRASE);
  assert.equal(store.vaultData.entries[0].name, "Original");
});

test("a damaged attachment is reported by name and stops a backup", async (t) => {
  const { store, login, attachment, directory } = await setUp(t);
  const file = store.attachmentPath(attachment.id);
  const original = await fs.readFile(file);
  for (const position of [0, 8, 20, 36, original.length - 1]) {
    const damaged = Buffer.from(original);
    damaged[position] ^= 0x01;
    await fs.writeFile(file, damaged);
    await assert.rejects(store.exportAttachment(login.id, attachment.id, path.join(directory, "out.txt")), /missing or damaged/);
    await assert.rejects(store.exportBackup(path.join(directory, "backup.vault")), /missing or damaged/);
  }
  await fs.writeFile(file, original.subarray(0, original.length - 1));
  await assert.rejects(store.exportAttachment(login.id, attachment.id, path.join(directory, "out.txt")), /missing or damaged/);
});

test("damaged snapshots, descriptions, and pool files restore nothing", async (t) => {
  const { store, snapshot, vaultPath } = await setUp(t);
  const snapshots = store.snapshotDirectory;
  const dataFile = store.snapshotFile(snapshot.name, "vault");
  const pool = path.join(snapshots, "attachments");
  const vaultBefore = await fs.readFile(vaultPath);
  const restore = () => store.restoreBackup(dataFile, PASSPHRASE, { poolDirectory: pool });

  const data = await fs.readFile(dataFile, "utf8");
  // Restoring with the passphrase uses the header, the key wrap, and the data.
  for (const field of base64Fields(data).filter((item) => item.part !== "recoveryWrap")) {
    await fs.writeFile(dataFile, changeCharacter(data, field.start + 2));
    await assert.rejects(restore(), undefined, field.name);
    assert.deepEqual(await fs.readFile(vaultPath), vaultBefore);
  }
  await fs.writeFile(dataFile, data);

  const [id] = snapshot.description.attachments;
  const poolFile = path.join(pool, `${id}.bin`);
  const pooled = await fs.readFile(poolFile);
  const damaged = Buffer.from(pooled);
  damaged[damaged.length - 5] ^= 0x10;
  await fs.writeFile(poolFile, damaged);
  await assert.rejects(restore(), /incomplete or damaged/);
  assert.deepEqual(await fs.readFile(vaultPath), vaultBefore);
  await fs.writeFile(poolFile, pooled);

  // A description that does not parse makes the snapshot incomplete: it is
  // not listed, and never counts as verified.
  const descriptionFile = store.snapshotFile(snapshot.name, "json");
  const description = await fs.readFile(descriptionFile, "utf8");
  await fs.writeFile(descriptionFile, description.replace('"version":1', '"version":9'));
  assert.equal((await listSnapshotDirectory(snapshots)).complete.some((item) => item.name === snapshot.name), false);
  // One whose hash no longer matches the copy is not trusted by a check.
  await fs.writeFile(descriptionFile, JSON.stringify({ ...JSON.parse(description), sha256: "0".repeat(64), verifiedAt: null }));
  const altered = (await store.listSnapshots()).complete.find((item) => item.name === snapshot.name);
  const outcome = await store.enqueueMutation(() => store.verifySnapshotNow(altered, store.sessionEpoch))
    .then(() => "verified", (error) => error.message);
  assert.equal(outcome, "snapshot damaged");
  await fs.writeFile(descriptionFile, description);

  // After all that the snapshot still restores.
  await restore();
  assert.equal(store.vaultData.entries[0].name, "Original");
});

test("a damaged copy outside this Mac is a failure and restores nothing", async (t) => {
  const { store, snapshot, vaultPath, outside, outsideFolder } = await setUp(t);
  const target = path.join(outsideFolder, "Mnemo", PROFILE_ID);
  const copy = path.join(target, `${snapshot.name}.vault`);
  const original = await fs.readFile(copy);
  const damaged = Buffer.from(original);
  damaged[Math.floor(damaged.length / 2)] ^= 0x01;
  await fs.writeFile(copy, damaged);
  assert.equal((await outside.copy(vaultPath)).failure, "mismatch");
  assert.equal(await fs.readFile(copy).then((bytes) => bytes.equals(damaged)), true, "the damaged copy is not written over");

  const vaultBefore = await fs.readFile(vaultPath);
  await assert.rejects(store.restoreBackup(copy, PASSPHRASE, { poolDirectory: path.join(target, "attachments") }));
  assert.deepEqual(await fs.readFile(vaultPath), vaultBefore);
});
