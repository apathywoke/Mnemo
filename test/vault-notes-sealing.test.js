// Schema 4: notes, and a secure note's text, sealed per entry
// (docs/design-notes-sealing.md, section 10). The fixture was written by the
// schema 3 release (0.2.1) and holds made-up data only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { parseLoginCsv } = require("../src/main/importers");
const { decryptGcm, openNotes, sealNotes } = require("../src/main/vault/crypto");
const { headerOf, getAad } = require("../src/main/vault/envelope");
const { validateVaultData } = require("../src/main/vault/schema");
const { makeLogin, makeTempDirectory, plainTextEntries } = require("../support/helpers");
const fixture = require("./fixtures/schema3-notes.json");

const FIXTURE = path.join(__dirname, "fixtures", "schema3-notes.vault");
const NEW_PASSPHRASE = "lantern orbit quietly 83 marble";
const DAMAGED = /notes of this item are damaged/;
const { ids } = fixture;

async function copyFixture(t) {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, "vault.json");
  await fs.copyFile(FIXTURE, filePath);
  return { directory, filePath };
}

async function openFixture(t) {
  const { directory, filePath } = await copyFixture(t);
  const store = new VaultStore(filePath);
  await store.unlock(fixture.passphrase);
  return { directory, filePath, store };
}

// The vault data as it is on disk, decrypted with the open store's key.
async function dataOnDisk(store) {
  const envelope = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  const dataKey = store.exportDataKey();
  try {
    return JSON.parse(decryptGcm(envelope.data, dataKey, getAad("vault-data", headerOf(envelope))).toString("utf8"));
  } finally {
    dataKey.fill(0);
  }
}

const isSealed = (value) => typeof value === "object" && value?.name === "aes-256-gcm";
const entryOf = (store, id) => store.vaultData.entries.find((entry) => entry.id === id);

// Every note of the fixture, read through the store as the app would: the
// details only flag notes, and revealText() opens them.
function assertFixtureNotes(store) {
  const notes = (id, versionId) => store.revealText(id, versionId).notes;
  assert.equal(notes(ids.login), "Login notes, second version.");
  assert.equal(store.getEntry(ids.login).hasNotes, true);
  assert.equal(notes(ids.plainLogin), "");
  assert.equal(store.getEntry(ids.plainLogin).hasNotes, false);
  assert.equal(notes(ids.card), "Card notes ✓ — ünïcödé");
  assert.equal(notes(ids.note), "Notes of a secure note.");
  assert.equal(store.revealText(ids.note).fields.body, "Network: example\nPassword: made-up-4");
  assert.deepEqual(store.getEntry(ids.note).sealedFields, ["body"]);
  assert.equal(notes(ids.identity), "Identity notes.");
  assert.equal(notes(ids.ssh), "SSH notes.");
  assert.equal(notes(ids.trashed), "Notes of a deleted login.");
  const loginHistory = store.getHistory(ids.login);
  assert.deepEqual(loginHistory.map((version) => notes(ids.login, version.id)), ["Login notes, second version.", "Login notes, first version."]);
  assert.deepEqual(loginHistory.map((version) => version.changes), [["name"], ["notes"]]);
  const [noteVersion] = store.getHistory(ids.note);
  assert.equal(store.revealText(ids.note, noteVersion.id).fields.body, "Network: example\nPassword: made-up-3");
  assert.deepEqual(noteVersion.sealedFields, ["body"]);
  assert.deepEqual(noteVersion.changes, ["body"]);
}

test("a schema 3 vault opens with every note and is written as schema 5 on the next save", async (t) => {
  const { store } = await openFixture(t);
  assert.equal((await dataOnDisk(store)).schemaVersion, 3);
  assert.equal(store.vaultData.schemaVersion, 5);
  assertFixtureNotes(store);

  // Unlocking sealed the notes in memory; equal text within an entry shares
  // one record, so the history sees no change where there was none.
  const login = entryOf(store, ids.login);
  assert.ok(isSealed(login.notes));
  assert.deepEqual(login.history[0].notes, login.notes);
  assert.notDeepEqual(login.history[1].notes, login.notes);
  assert.equal(entryOf(store, ids.plainLogin).notes, "");
  assert.equal((await dataOnDisk(store)).schemaVersion, 3);

  await store.setFavorite(ids.card, true);
  const saved = await dataOnDisk(store);
  assert.equal(saved.schemaVersion, 5);
  for (const entry of saved.entries) {
    for (const content of [entry, ...(entry.history ?? [])]) {
      assert.ok(content.notes === "" || isSealed(content.notes), entry.name);
      if (entry.type === "note") assert.ok(isSealed(content.fields.body));
    }
  }
  assert.equal(saved.entries.find((entry) => entry.id === ids.plainLogin).notes, "");
  assert.ok(!JSON.stringify(saved).includes("Login notes"));
  assert.ok(!JSON.stringify(saved).includes("made-up-4"));

  store.lock();
  await store.unlock(fixture.passphrase);
  assertFixtureNotes(store);
});

test("Touch ID and recovery key unlocks read the notes of a schema 3 vault", async (t) => {
  const { store } = await openFixture(t);
  const dataKey = store.exportDataKey();
  t.after(() => dataKey.fill(0));
  store.lock();
  await store.unlockWithDataKey(dataKey);
  assertFixtureNotes(store);

  // Recovery replaces the vault key and writes schema 5 at once.
  const recovering = new VaultStore((await copyFixture(t)).filePath);
  await recovering.recoverWithKey(fixture.recoveryKey, NEW_PASSPHRASE);
  assert.equal((await dataOnDisk(recovering)).schemaVersion, 5);
  assertFixtureNotes(recovering);
});

test("saving keeps unchanged notes, records changed ones, and stores cleared notes as \"\"", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "vault.json"));
  await store.create(fixture.passphrase);
  const login = await store.saveEntry(makeLogin({ notes: "first" }));
  const record = entryOf(store, login.id).notes;
  assert.ok(isSealed(record));

  await store.saveEntry(makeLogin({ id: login.id, notes: "first", password: "" }));
  assert.equal(entryOf(store, login.id).notes, record);
  assert.equal(entryOf(store, login.id).history, undefined);

  await store.saveEntry(makeLogin({ id: login.id, notes: "second", password: "" }));
  assert.equal(entryOf(store, login.id).history.length, 1);
  assert.deepEqual(store.getHistory(login.id)[0].changes, ["notes"]);
  assert.equal(store.revealText(login.id, store.getHistory(login.id)[0].id).notes, "first");

  const cleared = await store.saveEntry(makeLogin({ id: login.id, notes: "", password: "" }));
  assert.equal(cleared.hasNotes, false);
  assert.equal(entryOf(store, login.id).notes, "");

  const note = await store.saveItem({ id: "", type: "note", name: "Note", notes: "", fields: { body: "text" } });
  const body = entryOf(store, note.id).fields.body;
  assert.ok(isSealed(body));
  await store.saveItem({ id: note.id, type: "note", name: "Note", notes: "", fields: { body: "text" } });
  assert.equal(entryOf(store, note.id).fields.body, body);
  assert.equal(entryOf(store, note.id).history, undefined);
  await store.saveItem({ id: note.id, type: "note", name: "Note", notes: "", fields: { body: "" } });
  assert.equal(Object.hasOwn(entryOf(store, note.id).fields, "body"), false);
  assert.equal(store.revealText(note.id).fields.body, undefined);
  assert.deepEqual(store.getEntry(note.id).sealedFields, []);
});

test("a note record moved to another entry or field does not open, and only that entry fails", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "vault.json"));
  await store.create(fixture.passphrase);
  const first = await store.saveEntry(makeLogin({ name: "First", notes: "first notes" }));
  const second = await store.saveEntry(makeLogin({ name: "Second", notes: "second notes" }));
  await store.saveEntry(makeLogin({ id: second.id, name: "Second", notes: "changed", password: "" }));
  const note = await store.saveItem({ id: "", type: "note", name: "Note", notes: "", fields: { body: "body text" } });

  const moved = (changes) => store.vaultData.entries.map((entry) => (changes[entry.id] ? changes[entry.id](entry) : entry));
  const firstNotes = entryOf(store, first.id).notes;
  const body = entryOf(store, note.id).fields.body;
  await store.persistVaultData({
    ...store.vaultData,
    entries: moved({
      // The first login's notes in the second login's history.
      [second.id]: (entry) => ({ ...entry, history: [{ ...entry.history[0], notes: firstNotes }] }),
      // The note's body in its notes field.
      [note.id]: (entry) => ({ ...entry, notes: body }),
    }),
  });
  store.lock();
  await store.unlock(fixture.passphrase);

  assert.throws(() => store.revealText(second.id, store.getHistory(second.id)[0].id), DAMAGED);
  assert.throws(() => store.revealText(note.id), DAMAGED);
  assert.equal(store.revealText(second.id).notes, "changed");
  assert.equal(store.revealText(first.id).notes, "first notes");
  assert.equal(store.listEntries().length, 3);
});

test("rekeying reseals notes, keeps shared records shared, and leaves none for the old key", async (t) => {
  const { store } = await openFixture(t);
  const oldKey = store.exportDataKey();
  t.after(() => oldKey.fill(0));
  await store.changePassphrase(fixture.passphrase, NEW_PASSPHRASE);
  const newKey = store.exportDataKey();
  t.after(() => newKey.fill(0));

  for (const entry of store.vaultData.entries) {
    for (const content of [entry, ...(entry.history ?? [])]) {
      const records = [["notes", content.notes], ["body", content.fields?.body]].filter(([, record]) => isSealed(record));
      for (const [field, record] of records) {
        assert.throws(() => openNotes(record, oldKey, entry.id, field));
        assert.equal(typeof openNotes(record, newKey, entry.id, field), "string");
      }
    }
  }
  const login = entryOf(store, ids.login);
  assert.deepEqual(login.history[0].notes, login.notes);
  store.lock();
  await store.unlock(NEW_PASSPHRASE);
  assertFixtureNotes(store);
});

test("import from CSV and from schema 3 and 4 backups gives the same notes, sealed", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "vault.json"));
  await store.create(fixture.passphrase);

  const csv = parseLoginCsv("name,url,username,password,notes\nCSV,https://csv.example,me,made-up-6,\"CSV notes, with a comma\"\n", "import", "invalid");
  assert.equal((await store.importLogins(csv.logins)).imported, 1);
  const fromCsv = store.vaultData.entries.find((entry) => entry.name === "CSV");
  assert.ok(isSealed(fromCsv.notes));
  assert.equal(store.revealText(fromCsv.id).notes, "CSV notes, with a comma");

  const fromSchema3 = await VaultStore.readBackupLogins(FIXTURE, fixture.passphrase);
  // Six items; the one in the backup's trash is left out.
  const result = await store.importLogins(fromSchema3.logins);
  assert.equal(result.imported, 6);
  const byName = (name) => store.vaultData.entries.find((entry) => entry.name === name);
  assert.ok(isSealed(byName("Wi-Fi").fields.body));
  assert.equal(store.revealText(byName("Wi-Fi").id).fields.body, "Network: example\nPassword: made-up-4");
  assert.equal(store.revealText(byName("Visa").id).notes, "Card notes ✓ — ünïcödé");
  // Importing again finds every item, including the one with a sealed body.
  assert.equal((await store.importLogins(fromSchema3.logins)).imported, 0);

  // A schema 4 backup: the fixture after its migrating save.
  const { store: migrated, directory: migratedDirectory } = await openFixture(t);
  await migrated.setFavorite(ids.card, true);
  const backupPath = path.join(migratedDirectory, "backup.vault");
  await migrated.exportBackup(backupPath);
  const fromSchema4 = await VaultStore.readBackupLogins(backupPath, fixture.passphrase);
  assert.deepEqual(fromSchema4.logins, fromSchema3.logins);
});

test("a backup from before the migration restores by passphrase and by recovery key", async (t) => {
  for (const credentials of [fixture.passphrase, { recoveryKey: fixture.recoveryKey, newPassphrase: NEW_PASSPHRASE }]) {
    const directory = await makeTempDirectory(t);
    const store = new VaultStore(path.join(directory, "vault.json"));
    await store.create(NEW_PASSPHRASE);
    await store.restoreBackup(FIXTURE, credentials);
    assertFixtureNotes(store);
    // By passphrase the backup is written as it is and migrated on the next
    // save; with the recovery key it is rekeyed and written as schema 5.
    const schema = (await dataOnDisk(store)).schemaVersion;
    assert.equal(schema, typeof credentials === "string" ? 3 : 5);
    await store.setFavorite(ids.card, true);
    assert.equal((await dataOnDisk(store)).schemaVersion, 5);
  }
});

test("schemas 4 and 5 accept only sealed notes and schemas 1–3 only plain ones", async (t) => {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "vault.json"));
  await store.create(fixture.passphrase);
  await store.saveEntry(makeLogin({ notes: "notes" }));
  await store.saveItem({ id: "", type: "note", name: "Note", notes: "", fields: { body: "body" } });
  const current = store.vaultData;
  assert.equal(validateVaultData(current), true);

  const [login, note] = current.entries;
  const withLogin = (changes) => ({ ...current, entries: [{ ...login, ...changes }, note] });
  const dataKey = store.exportDataKey();
  t.after(() => dataKey.fill(0));
  assert.equal(validateVaultData(withLogin({ notes: "plain text" })), false);
  assert.equal(validateVaultData(withLogin({ notes: { name: "aes-256-gcm", nonce: "x" } })), false);
  assert.equal(validateVaultData(withLogin({ notes: sealNotes("n".repeat(16384 * 3 + 1), dataKey, login.id, "notes") })), false);
  assert.equal(validateVaultData(withLogin({ notes: "" })), true);
  assert.equal(validateVaultData({ ...current, entries: [login, { ...note, fields: { body: "plain body" } }] }), false);

  // Schema 3 data is plain text, and a sealed record there is refused.
  const plain = { schemaVersion: 3, entries: plainTextEntries(store), folders: current.folders };
  assert.equal(validateVaultData(plain), true);
  assert.equal(validateVaultData({ ...plain, entries: [{ ...plain.entries[0], notes: login.notes }, plain.entries[1]] }), false);
  assert.equal(validateVaultData({ ...plain, entries: [plain.entries[0], { ...plain.entries[1], fields: note.fields }] }), false);
});

test("a migrating save that fails leaves the schema 3 file as it was", async (t) => {
  const { filePath, store } = await openFixture(t);
  const before = await fs.readFile(filePath);
  const fsPromises = require("node:fs/promises");
  const rename = fsPromises.rename;
  fsPromises.rename = async () => {
    throw Object.assign(new Error("simulated failure"), { code: "EIO" });
  };
  try {
    await assert.rejects(store.setFavorite(ids.card, true));
  } finally {
    fsPromises.rename = rename;
  }
  assert.deepEqual(await fs.readFile(filePath), before);
  store.lock();
  await store.unlock(fixture.passphrase);
  assert.equal((await dataOnDisk(store)).schemaVersion, 3);
  assertFixtureNotes(store);
});
