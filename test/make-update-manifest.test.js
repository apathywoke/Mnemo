const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { loadTrustedKeys, verifyManifest } = require("../updater");
const { makeTempDirectory } = require("../support/helpers");

const ROOT = path.join(__dirname, "..");

// A copy of the repository layout the script expects, with a test key pair
// standing in for the release key.
async function makeRepo(t, { version = "0.2.0" } = {}) {
  const root = await makeTempDirectory(t, "mnemo-manifest-");
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "build", "update-keys"), { recursive: true });
  await fs.mkdir(path.join(root, "release"));
  await fs.copyFile(path.join(ROOT, "scripts", "make-update-manifest.js"), path.join(root, "scripts", "make-update-manifest.js"));
  await fs.copyFile(path.join(ROOT, "updater.js"), path.join(root, "updater.js"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(root, "build", "update-keys", "test.pem"), publicKey.export({ type: "spki", format: "pem" }));
  for (const arch of ["arm64", "x64"]) {
    await fs.writeFile(path.join(root, "release", `Mnemo-${version}-mac-${arch}.zip`), `${arch} archive`);
  }
  await fs.writeFile(path.join(root, "notes.txt"), "Faster unlock.\n\n- Fixed a crash.\n");
  return { root, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function runScript(root, args, key) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "make-update-manifest.js"), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...(key ? { MNEMO_UPDATE_PRIVATE_KEY: key } : {}) },
    encoding: "utf8",
  });
}

test("signs a manifest the app accepts, with each archive's size and hash", async (t) => {
  const { root, privateKey } = await makeRepo(t);
  const result = runScript(root, ["--version", "v0.2.0", "--dist", "release", "--notes-file", "notes.txt"], privateKey);
  assert.equal(result.status, 0, result.stderr);

  const bytes = await fs.readFile(path.join(root, "release", "update-manifest.json"));
  const signature = await fs.readFile(path.join(root, "release", "update-manifest.json.sig"), "utf8");
  const manifest = verifyManifest(bytes, signature, loadTrustedKeys(path.join(root, "build", "update-keys")));
  assert.equal(manifest.appVersion, "0.2.0");
  assert.equal(manifest.notes, "Faster unlock.\n\n- Fixed a crash.");
  assert.deepEqual(manifest.assets.arm64, {
    name: "Mnemo-0.2.0-mac-arm64.zip",
    size: "arm64 archive".length,
    sha512: createHash("sha512").update("arm64 archive").digest("base64"),
  });
  assert.equal(manifest.assets.x64.name, "Mnemo-0.2.0-mac-x64.zip");
});

test("refuses a key the app does not trust, a version mismatch, or missing archives", async (t) => {
  const { root, privateKey } = await makeRepo(t);
  const args = ["--version", "0.2.0", "--dist", "release"];
  const stranger = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

  assert.match(runScript(root, args, stranger).stderr, /does not verify with the app's public keys/);
  assert.match(runScript(root, args, rsa).stderr, /not an Ed25519 key/);
  assert.match(runScript(root, args, null).stderr, /MNEMO_UPDATE_PRIVATE_KEY is not set/);
  assert.match(runScript(root, ["--version", "0.3.0", "--dist", "release"], privateKey).stderr, /does not match package\.json/);
  await fs.rm(path.join(root, "release", "Mnemo-0.2.0-mac-x64.zip"));
  assert.match(runScript(root, args, privateKey).stderr, /missing .*Mnemo-0\.2\.0-mac-x64\.zip/);
  await assert.rejects(fs.access(path.join(root, "release", "update-manifest.json")));
});
