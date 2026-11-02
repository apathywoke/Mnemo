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

module.exports = { makeLogin, makePngHeader, makeTempDirectory, readPageStyles };
