// Writes and signs update-manifest.json for a release.
//
//   MNEMO_UPDATE_PRIVATE_KEY="$(cat key.pem)" \
//     node scripts/make-update-manifest.js --version 0.2.0 --dist release --notes-file notes.txt
//
// Reads Mnemo-<version>-mac-<arch>.zip for arm64 and x64 from --dist, records
// each one's size and SHA-512, signs the manifest bytes with the Ed25519
// private key from the environment, and writes update-manifest.json and
// update-manifest.json.sig next to the zips.
//
// Before writing, the signature is checked against the public keys the app
// ships (build/update-keys/*.pem) with the app's own verifier, so a wrong or
// rotated-out key fails the release instead of publishing an update no
// installed copy would accept. Uses only Node built-ins: this runs in the CI
// job that holds the key, which never installs npm packages.
const { createHash, createPrivateKey, sign } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MANIFEST_FORMAT,
  MANIFEST_NAME,
  MANIFEST_VERSION,
  MAX_NOTES_LENGTH,
  SIGNATURE_NAME,
  loadTrustedKeys,
  parseVersion,
  verifyManifest,
} = require("../updater");

const ARCHES = ["arm64", "x64"];
const KEYS_DIRECTORY = path.join(__dirname, "..", "build", "update-keys");

function fail(message) {
  console.error(`make-update-manifest: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!["--version", "--dist", "--notes-file"].includes(name) || value === undefined) {
      fail(`unexpected argument ${name ?? ""}`);
    }
    args[name.slice(2)] = value;
  }
  if (!args.version || !args.dist) fail("--version and --dist are required");
  return args;
}

function sha512File(file) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version.replace(/^v/, "");
  if (!parseVersion(version)) fail(`invalid version ${args.version}`);
  const packageVersion = require("../package.json").version;
  if (version !== packageVersion) fail(`version ${version} does not match package.json (${packageVersion})`);

  const keyText = process.env.MNEMO_UPDATE_PRIVATE_KEY;
  if (!keyText) fail("MNEMO_UPDATE_PRIVATE_KEY is not set");
  let privateKey;
  try {
    privateKey = createPrivateKey(keyText);
  } catch {
    fail("MNEMO_UPDATE_PRIVATE_KEY is not a readable private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("MNEMO_UPDATE_PRIVATE_KEY is not an Ed25519 key");

  const notes = args["notes-file"] ? fs.readFileSync(args["notes-file"], "utf8").trim() : "";
  if (notes.length > MAX_NOTES_LENGTH) fail(`release notes are longer than ${MAX_NOTES_LENGTH} characters`);

  const assets = {};
  for (const arch of ARCHES) {
    const name = `Mnemo-${version}-mac-${arch}.zip`;
    const file = path.join(args.dist, name);
    if (!fs.existsSync(file)) fail(`missing ${file}`);
    assets[arch] = { name, size: fs.statSync(file).size, sha512: sha512File(file) };
  }

  const manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    appVersion: version,
    releasedAt: new Date().toISOString(),
    notes,
    assets,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, bytes, privateKey).toString("base64");

  const trustedKeys = loadTrustedKeys(KEYS_DIRECTORY);
  if (trustedKeys.length === 0) fail(`no public keys in ${KEYS_DIRECTORY}`);
  try {
    verifyManifest(bytes, signature, trustedKeys);
  } catch (error) {
    fail(`the signed manifest does not verify with the app's public keys (${error.message})`);
  }

  fs.writeFileSync(path.join(args.dist, MANIFEST_NAME), bytes);
  fs.writeFileSync(path.join(args.dist, SIGNATURE_NAME), `${signature}\n`);
  for (const [arch, asset] of Object.entries(assets)) {
    console.log(`${arch}: ${asset.name} ${asset.size} bytes`);
  }
  console.log(`Wrote ${MANIFEST_NAME} and ${SIGNATURE_NAME} for ${version}`);
}

main();
