const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const {
  parseCsv,
  parseImportFile,
} = require("../src/main/importers");
const { makeTempDirectory } = require("../support/helpers");

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(contents));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(contents), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(contents), 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function writeFile(t, name, contents) {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

test("CSV parser handles quotes, commas, newlines, and a BOM", () => {
  assert.deepEqual(
    parseCsv('﻿a,b\r\n"x, y","multi\nline ""quoted"""\n'),
    [["a", "b"], ["x, y", 'multi\nline "quoted"']],
  );
});

test("Bitwarden JSON imports logins and counts what it skips", async (t) => {
  const filePath = await writeFile(t, "bitwarden.json", JSON.stringify({
    encrypted: false,
    items: [
      { type: 1, name: "Bank", notes: "n", login: { username: "alice", password: "pw1", totp: "otpauth://x", uris: [{ uri: "androidapp://bank" }, { uri: "https://bank.example/login" }] } },
      { type: 1, name: "", login: { username: "bob", password: "pw2", totp: "JBSWY3DPEHPK3PXP", uris: [{ uri: "mail.example" }] } },
      { type: 1, name: "No password", login: { username: "c", password: "" } },
      { type: 2, name: "Secure note" },
      { type: 3, name: "Card" },
    ],
  }));
  const result = await parseImportFile("bitwarden", filePath);
  assert.deepEqual(result.logins, [
    { name: "Bank", username: "alice", password: "pw1", url: "https://bank.example/login", notes: "n", totp: "" },
    { name: "mail.example", username: "bob", password: "pw2", url: "mail.example", notes: "", totp: "JBSWY3DPEHPK3PXP" },
  ]);
  // "otpauth://x" is not a valid TOTP link, so it is counted and dropped.
  assert.deepEqual(result.stats, { found: 3, nonLogin: 2, noPassword: 1, archived: 0, withTotp: 1, totpNotImported: 1 });
});

test("Bitwarden encrypted exports and wrong files are rejected clearly", async (t) => {
  const encrypted = await writeFile(t, "enc.json", JSON.stringify({ encrypted: true, passwordProtected: true }));
  await assert.rejects(parseImportFile("bitwarden", encrypted), /export is encrypted/);
  const wrong = await writeFile(t, "wrong.json", "{}");
  await assert.rejects(parseImportFile("bitwarden", wrong), /not a supported Bitwarden export/);
  const wrongType = await writeFile(t, "data.txt", "x");
  await assert.rejects(parseImportFile("bitwarden", wrongType), /file type is not supported/);
  await assert.rejects(parseImportFile("lastpass", wrongType), /file type is not supported/);
});

test("Bitwarden CSV imports logins only", async (t) => {
  const filePath = await writeFile(t, "bitwarden.csv", [
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
    ',,login,Mail,"line1\nline2",,0,https://mail.example,me@example.com,secret,',
    ",,note,Just a note,text,,0,,,,",
  ].join("\n"));
  const result = await parseImportFile("bitwarden", filePath);
  assert.deepEqual(result.logins, [
    { name: "Mail", username: "me@example.com", password: "secret", url: "https://mail.example", notes: "line1\nline2", totp: "" },
  ]);
  assert.equal(result.stats.nonLogin, 1);
});

test("1Password CSV imports logins and skips archived items", async (t) => {
  const filePath = await writeFile(t, "1password.csv", [
    "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
    "Shop,https://shop.example,sam,pw,,false,false,,",
    "Old,https://old.example,sam,pw,,false,true,,",
  ].join("\n"));
  const result = await parseImportFile("onepassword", filePath);
  assert.deepEqual(result.logins.map(({ name }) => name), ["Shop"]);
  assert.equal(result.stats.archived, 1);
});

test("1Password 1PUX archives are read through export.data", async (t) => {
  const exportData = JSON.stringify({
    accounts: [{
      vaults: [{
        items: [
          {
            item: {
              categoryUuid: "001",
              state: "active",
              overview: { title: "Forum", url: "https://forum.example" },
              details: {
                loginFields: [
                  { designation: "username", value: "fan" },
                  { designation: "password", value: "pw" },
                ],
                notesPlain: "hello",
                sections: [{ fields: [{ value: { totp: "otpauth://totp/Forum:fan?secret=JBSWY3DPEHPK3PXP" } }] }],
              },
            },
          },
          { categoryUuid: "005", state: "active", overview: { title: "Wi-Fi" }, details: { password: "wifi-pw" } },
          { categoryUuid: "002", overview: { title: "Card" }, details: {} },
          { categoryUuid: "001", state: "archived", overview: { title: "Gone" }, details: {} },
        ],
      }],
    }],
  });
  const filePath = await writeFile(t, "export.1pux", makeZip({
    "export.attributes": "{}",
    "export.data": exportData,
  }));
  const result = await parseImportFile("onepassword", filePath);
  assert.deepEqual(result.logins, [
    { name: "Forum", username: "fan", password: "pw", url: "https://forum.example", notes: "hello", totp: "otpauth://totp/Forum:fan?secret=JBSWY3DPEHPK3PXP" },
    { name: "Wi-Fi", username: "", password: "wifi-pw", url: "", notes: "", totp: "" },
  ]);
  assert.deepEqual(result.stats, { found: 2, nonLogin: 1, noPassword: 0, archived: 1, withTotp: 1, totpNotImported: 0 });

  const broken = await writeFile(t, "broken.1pux", Buffer.from("not a zip"));
  await assert.rejects(parseImportFile("onepassword", broken), /not a supported 1Password export/);
  const noData = await writeFile(t, "nodata.1pux", makeZip({ "other.txt": "x" }));
  await assert.rejects(parseImportFile("onepassword", noData), /not a supported 1Password export/);
});

test("oversized decompressed 1PUX data is refused", async (t) => {
  const bomb = makeZip({ "export.data": "a".repeat(51 * 1024 * 1024) });
  const filePath = await writeFile(t, "bomb.1pux", bomb);
  await assert.rejects(parseImportFile("onepassword", filePath), /too large/);
});
