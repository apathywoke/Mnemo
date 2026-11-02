const { createECDH, randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function makeTempDirectory(t, prefix = "local-vault-test-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function makePngHeader(width, height) {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function makeLogin(overrides = {}) {
  return {
    id: "",
    name: "Example account",
    username: "user@example.com",
    password: "test-password-value",
    url: "example.com/login",
    notes: "local test data",
    ...overrides,
  };
}

// An open store's entries as schema 3 kept them: notes and sealed item fields
// (a secure note's body) as plain text, in the entry and its history. For
// tests that write a vault the way an earlier version did.
function plainTextEntries(store) {
  const plain = (entry, content) => {
    const { notes, fields } = store.readableText(entry, content);
    return entry.type === "login" ? { ...content, notes } : { ...content, notes, fields: { ...content.fields, ...fields } };
  };
  return store.vaultData.entries.map((entry) => {
    const next = plain(entry, entry);
    if (entry.history) next.history = entry.history.map((version) => plain(entry, version));
    return next;
  });
}

// The page's whole stylesheet as the browser sees it: styles.css with every
// @import replaced by the imported file, in order.
async function readPageStyles(file = path.join(__dirname, "..", "styles.css")) {
  const source = await fs.readFile(file, "utf8");
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(/@import\s+"([^"]+)";/g)) {
    parts.push(source.slice(last, match.index), await readPageStyles(path.resolve(path.dirname(file), match[1])));
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return parts.join("");
}

// A stand-in for the Touch ID helper (native/touch-id/main.swift) that does
// the key agreement in software. The "Secure Enclave" keys live in `keys`,
// so a blob only works with the helper that made it, like on a real Mac.
// `respond` sets the reply of the next agree: "allow", or an error code.
function makeTouchIdHelper({ available = true } = {}) {
  const keys = new Map();
  const requests = [];
  let nextAgree = "allow";
  return {
    requests,
    keys,
    respond(value) { nextAgree = value; },
    async run(request) {
      requests.push(request);
      if (request.command === "status") return { available };
      if (!available) return { error: "unavailable" };
      if (request.command === "create") {
        const key = createECDH("prime256v1");
        const publicKey = key.generateKeys();
        const keyBlob = randomBytes(96).toString("base64");
        keys.set(keyBlob, key);
        return { publicKey: publicKey.toString("base64"), keyBlob };
      }
      if (request.command === "agree") {
        if (nextAgree !== "allow") return { error: nextAgree };
        const key = keys.get(request.keyBlob);
        if (!key) return { error: "invalidated" };
        const secret = key.computeSecret(Buffer.from(request.peerPublicKey, "base64"));
        return { sharedSecret: secret.toString("base64") };
      }
      return { error: "invalidRequest" };
    },
  };
}

module.exports = { makeLogin, makePngHeader, makeTempDirectory, makeTouchIdHelper, plainTextEntries, readPageStyles };
