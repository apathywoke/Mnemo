const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { parseCsv, parseImportFile } = require("../src/main/importers");
const { makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";
const TOTP = "otpauth://totp/Mnemo?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30";
const item = (type, name, notes, fields) => ({ id: "", type, name, notes, fields });

// One vault with every item type and every field filled.
async function fullVault(t) {
  const directory = await makeTempDirectory(t);
  const store = new VaultStore(path.join(directory, "source.vault"));
  await store.create(PASSPHRASE);
  const login = await store.saveEntry({
    id: "",
    name: 'Mail, "work"',
    username: "alice@example.com",
    password: 'pa"ss,word\n=1+1',
    url: "https://mail.example/login",
    notes: "line one\nline two",
    totp: TOTP,
  });
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const items = {
    card: await store.saveItem(item("card", "Visa", "card notes", {
      cardholder: "Alice Example", number: "4242 4242 4242 4242", expiry: "07/28", cvv: "123", pin: "9876",
    })),
    note: await store.saveItem(item("note", "Recipe", "extra notes", { body: "secret body\nsecond line" })),
    identity: await store.saveItem(item("identity", "Passport", "identity notes", {
      firstName: "Alice",
      lastName: "Example",
      email: "alice@example.com",
      phone: "+1 555 0100",
      address: "1 Main St\nTown",
      birthDate: "1990-01-02",
      documentNumber: "P1234567",
    })),
    ssh: await store.saveItem(item("ssh", "Server", "ssh notes", { privateKey, publicKey: "", passphrase: "key words" })),
  };
  const folder = await store.createFolder("Work");
  await store.setFolder(login.id, folder.id);
  await store.setFavorite(login.id, true);
  return { directory, store, login, items, folder };
}

async function plainItems(store, directory, name) {
  const backupPath = path.join(directory, `${name}.vault`);
  await store.exportBackup(backupPath);
  const { logins } = await VaultStore.readBackupLogins(backupPath, PASSPHRASE);
  return logins.sort((a, b) => a.name.localeCompare(b.name));
}

test("every item type survives a JSON export and an import into a new vault", async (t) => {
  const { directory, store } = await fullVault(t);
  const filePath = path.join(directory, "export.json");
  assert.deepEqual(await store.exportOpenFormat(filePath, "json"), { exported: 5 });

  const parsed = await parseImportFile("bitwarden", filePath);
  assert.equal(parsed.stats.nonLogin, 0);
  const target = new VaultStore(path.join(directory, "target.vault"));
  await target.create(PASSPHRASE);
  const result = await target.importLogins(parsed.logins);
  assert.equal(result.imported, 5);
  assert.equal(result.invalid, 0);

  assert.deepEqual(
    await plainItems(target, directory, "target-backup"),
    await plainItems(store, directory, "source-backup"),
  );
});

test("the JSON file follows Bitwarden's format and is private to the user", async (t) => {
  const { directory, store, login, folder, items } = await fullVault(t);
  const filePath = path.join(directory, "export.json");
  await store.exportOpenFormat(filePath, "json");
  if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(data.encrypted, false);
  assert.deepEqual(data.folders, [{ id: folder.id, name: "Work" }]);
  const byName = new Map(data.items.map((entry) => [entry.name, entry]));
  assert.deepEqual([...byName.values()].map((entry) => entry.type).sort(), [1, 2, 3, 4, 5]);

  const mail = byName.get('Mail, "work"');
  assert.equal(mail.id, login.id);
  assert.equal(mail.folderId, folder.id);
  assert.equal(mail.favorite, true);
  assert.deepEqual(mail.login.uris, [{ match: null, uri: "https://mail.example/login" }]);
  assert.equal(mail.login.totp, TOTP);
  assert.match(mail.creationDate, /^\d{4}-\d{2}-\d{2}T/);

  const visa = byName.get("Visa");
  assert.deepEqual(visa.card, {
    cardholderName: "Alice Example", brand: null, number: "4242424242424242", expMonth: "7", expYear: "2028", code: "123",
  });
  // What Bitwarden has no field for is kept, hidden when it is a secret.
  assert.deepEqual(visa.fields, [{ name: "PIN", value: "9876", type: 1, linkedId: null }]);
  assert.equal(byName.get("Recipe").notes, "secret body\nsecond line");
  assert.deepEqual(byName.get("Recipe").secureNote, { type: 0 });
  assert.equal(byName.get("Passport").fields.find(({ name }) => name === "Document number").type, 1);
  assert.equal(byName.get("Server").sshKey.keyFingerprint, items.ssh.subtitle);
});

test("the trash, earlier versions, and attachments stay out of an export", async (t) => {
  const { directory, store, login, items } = await fullVault(t);
  const attachment = path.join(directory, "file.txt");
  await fs.writeFile(attachment, "attachment contents");
  await store.addAttachment(login.id, attachment);
  await store.saveEntry({
    id: login.id,
    name: login.name,
    username: "alice@example.com",
    password: "the new password",
    url: "https://mail.example/login",
    notes: "line one\nline two",
    totp: TOTP,
  });
  await store.deleteEntry(items.note.id);

  const filePath = path.join(directory, "export.json");
  assert.deepEqual(await store.exportOpenFormat(filePath, "json"), { exported: 4 });
  const contents = await fs.readFile(filePath, "utf8");
  assert.ok(contents.includes("the new password"));
  assert.equal(contents.includes('pa\\"ss'), false);
  assert.equal(contents.includes("secret body"), false);
  assert.equal(contents.includes("attachment contents"), false);
});

test("the CSV file has the logins, exactly, in Bitwarden's columns", async (t) => {
  const { directory, store } = await fullVault(t);
  const filePath = path.join(directory, "export.csv");
  await store.exportOpenFormat(filePath, "csv");
  if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  const contents = await fs.readFile(filePath, "utf8");

  const rows = parseCsv(contents);
  assert.deepEqual(rows[0], [
    "folder", "favorite", "type", "name", "notes", "fields", "reprompt",
    "login_uri", "login_username", "login_password", "login_totp",
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], [
    "Work", "1", "login", 'Mail, "work"', "line one\nline two", "", "0",
    "https://mail.example/login", "alice@example.com", 'pa"ss,word\n=1+1', TOTP,
  ]);

  const { logins } = await parseImportFile("bitwarden", filePath);
  assert.deepEqual(logins.map(({ password }) => password), ['pa"ss,word\n=1+1']);
});

test("an export needs an open vault and another file than the vault", async (t) => {
  const { directory, store } = await fullVault(t);
  await assert.rejects(store.exportOpenFormat(store.filePath, "json"), /different location/);
  const filePath = path.join(directory, "locked.json");
  store.lock();
  await assert.rejects(store.exportOpenFormat(filePath, "json"), /Unlock the vault first/);
  await assert.rejects(fs.access(filePath), { code: "ENOENT" });
});
