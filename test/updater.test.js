const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  MANIFEST_FORMAT,
  Updater,
  assertAllowedUrl,
  compareVersions,
  loadTrustedKeys,
  verifyManifest,
} = require("../src/main/updater");
const { makeTempDirectory } = require("../support/helpers");

const isMac = process.platform === "darwin";

async function makeKeys(t) {
  const directory = await makeTempDirectory(t, "mnemo-update-keys-");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(directory, "test.pem"), publicKey.export({ type: "spki", format: "pem" }));
  return { directory, privateKey };
}

function signManifest(manifest, privateKey) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return { bytes, signature: sign(null, bytes, privateKey).toString("base64") };
}

function manifestFor(version, archive) {
  return {
    format: MANIFEST_FORMAT,
    version: 1,
    appVersion: version,
    notes: "Fixes and improvements.",
    assets: archive
      ? { [process.arch]: { name: `Mnemo-${version}-mac.zip`, size: archive.length, sha512: createHash("sha512").update(archive).digest("base64") } }
      : {},
  };
}

// A fake GitHub: serves the release JSON and assets from memory.
function fakeGitHub({ tag, manifest, signature, archive, releaseStatus = 200 }) {
  const requests = [];
  const files = {
    "https://github.com/dl/update-manifest.json": manifest,
    "https://github.com/dl/update-manifest.json.sig": Buffer.from(signature ?? ""),
    "https://github.com/dl/archive.zip": archive,
  };
  async function get(url, options) {
    requests.push(url);
    if (url.includes("/releases/latest")) {
      if (releaseStatus === 404) throw Object.assign(new Error("No update was found."), { notFound: true });
      return {
        buffer: Buffer.from(JSON.stringify({
          tag_name: tag,
          html_url: `https://github.com/apathywoke/Mnemo/releases/tag/${tag}`,
          assets: [
            { name: "update-manifest.json", browser_download_url: "https://github.com/dl/update-manifest.json" },
            { name: "update-manifest.json.sig", browser_download_url: "https://github.com/dl/update-manifest.json.sig" },
            ...(archive ? [{ name: `Mnemo-${tag.slice(1)}-mac.zip`, browser_download_url: "https://github.com/dl/archive.zip" }] : []),
          ],
        })),
      };
    }
    const content = files[url];
    if (options.toFile) {
      await fs.writeFile(options.toFile, content, { flag: "wx" });
      return { sha512: createHash("sha512").update(content).digest("base64"), size: content.length };
    }
    return { buffer: content };
  }
  return { get, requests };
}

test("versions compare numerically, with prereleases first", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("v1.0.0", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("1.0.0-beta", "1.0.0-alpha.1") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-rc") > 0);
  assert.ok(compareVersions("1.0.0-2", "1.0.0-alpha") < 0);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.throws(() => compareVersions("latest", "0.1.0"), /Invalid version/);
});

test("only HTTPS addresses on GitHub release hosts are allowed", () => {
  for (const url of [
    "https://api.github.com/repos/apathywoke/Mnemo/releases/latest",
    "https://objects.githubusercontent.com/x",
    "https://release-assets.githubusercontent.com/x",
  ]) {
    assert.equal(assertAllowedUrl(url).protocol, "https:");
  }
  for (const url of [
    "http://github.com/x",
    "https://evil.example/x",
    "https://github.com.evil.example/x",
    "https://user:pass@github.com/x",
    "https://github.com:8443/x",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => assertAllowedUrl(url), /not allowed/, url);
  }
});

test("manifests must be signed by a trusted key and well formed", async (t) => {
  const { directory, privateKey } = await makeKeys(t);
  const keys = loadTrustedKeys(directory);
  const { bytes, signature } = signManifest(manifestFor("0.2.0", Buffer.from("zip")), privateKey);
  assert.equal(verifyManifest(bytes, signature, keys).appVersion, "0.2.0");

  const tampered = Buffer.from(bytes.toString().replace("0.2.0", "9.9.9"));
  assert.throws(() => verifyManifest(tampered, signature, keys), /signature is invalid/);
  const other = generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => verifyManifest(bytes, sign(null, bytes, other).toString("base64"), keys), /signature is invalid/);
  assert.throws(() => verifyManifest(bytes, "not base64!", keys), /signature is invalid/);
  const bad = signManifest({ ...manifestFor("0.2.0"), assets: { arm64: { name: "../evil.zip", size: 1, sha512: "x" } } }, privateKey);
  assert.throws(() => verifyManifest(bad.bytes, bad.signature, keys), /information is invalid/);
});

test("check reports newer signed releases only", async (t) => {
  const { directory, privateKey } = await makeKeys(t);
  const archive = Buffer.from("archive bytes");
  const make = (tag, manifest, { currentVersion = "0.1.0", ...extra } = {}) => {
    const { bytes, signature } = signManifest(manifest, privateKey);
    const github = fakeGitHub({ tag, manifest: bytes, signature, archive, ...extra });
    return new Updater({ currentVersion, keysDirectory: directory, get: github.get });
  };

  const update = await make("v0.2.0", manifestFor("0.2.0", archive)).check();
  assert.equal(update.version, "0.2.0");
  assert.equal(update.notes, "Fixes and improvements.");
  assert.equal(update.asset.url, "https://github.com/dl/archive.zip");
  assert.match(update.releaseUrl, /^https:\/\/github\.com\/apathywoke\/Mnemo\/releases\//);

  assert.equal(await make("v0.1.0", manifestFor("0.1.0", archive)).check(), null);
  // An older signed release cannot be offered as an update (no rollback).
  assert.equal(await make("v0.2.0", manifestFor("0.2.0", archive), { currentVersion: "0.3.0" }).check(), null);
  // A signed manifest attached to a release with another tag is refused.
  await assert.rejects(make("v0.5.0", manifestFor("0.2.0", archive)).check(), /information is invalid/);
  assert.equal(await make("v0.2.0", manifestFor("0.2.0", archive), { releaseStatus: 404 }).check(), null);

  const empty = await makeTempDirectory(t);
  await assert.rejects(new Updater({ currentVersion: "0.1.0", keysDirectory: empty }).check(), /not configured/);
});

test("install blockers describe copies that cannot replace themselves", async (t) => {
  const { directory } = await makeKeys(t);
  const base = { currentVersion: "0.1.0", keysDirectory: directory, platform: "darwin", isPackaged: true };
  assert.equal(new Updater({ ...base, isPackaged: false }).installBlocker(), "notPackaged");
  assert.equal(new Updater({ ...base, execPath: "/private/var/folders/x/AppTranslocation/y/d/Mnemo.app/Contents/MacOS/Mnemo" }).installBlocker(), "notInApplications");
  assert.equal(new Updater({ ...base, execPath: "/Volumes/Mnemo/Mnemo.app/Contents/MacOS/Mnemo" }).installBlocker(), "notInApplications");
  assert.equal(new Updater({ ...base, platform: "linux" }).installBlocker(), "notPackaged");
});

// A minimal ad-hoc-signed app bundle with a given bundle ID and version.
async function makeBundle(parent, { id = "app.mnemo.desktop", version }) {
  const bundle = path.join(parent, "Mnemo.app");
  await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(path.join(bundle, "Contents", "MacOS", "Mnemo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Mnemo</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  execFileSync("/usr/bin/codesign", ["--sign", "-", "--force", bundle], { stdio: "ignore" });
  return bundle;
}

async function zipBundle(bundle, archivePath) {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archivePath]);
  return fs.readFile(archivePath);
}

test("download verifies and stages; install swaps the app and cleans up", { skip: !isMac }, async (t) => {
  const { directory, privateKey } = await makeKeys(t);
  const root = await makeTempDirectory(t, "mnemo-update-e2e-");
  const applications = path.join(root, "Applications");
  const build = path.join(root, "build");
  await fs.mkdir(applications);
  await fs.mkdir(build);
  const installed = await makeBundle(applications, { version: "0.1.0" });
  const newBuild = await makeBundle(build, { version: "0.2.0" });
  const archive = await zipBundle(newBuild, path.join(root, "update.zip"));
  const { bytes, signature } = signManifest(manifestFor("0.2.0", archive), privateKey);
  const github = fakeGitHub({ tag: "v0.2.0", manifest: bytes, signature, archive });
  const relaunched = [];
  const updater = new Updater({
    currentVersion: "0.1.0",
    keysDirectory: directory,
    execPath: path.join(installed, "Contents", "MacOS", "Mnemo"),
    isPackaged: true,
    platform: "darwin",
    get: github.get,
    tempDirectory: root,
    relaunch: (bundle) => relaunched.push(bundle),
  });

  assert.equal(updater.installBlocker(), null);
  const update = await updater.check();
  await assert.rejects(updater.install(), /No update is ready/);
  await updater.download(update);
  assert.ok((await fs.readdir(applications)).some((name) => name.startsWith(".Mnemo-update-")));

  await updater.install();
  const info = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(installed, "Contents", "Info.plist")]).toString().trim();
  assert.equal(info, "0.2.0");
  assert.deepEqual(relaunched, [installed]);
  const leftovers = (await fs.readdir(applications)).filter((name) => name.startsWith(".Mnemo-"));
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /^\.Mnemo-previous-[0-9a-f]{16}\.app$/);
  await updater.cleanUpLeftovers();
  assert.deepEqual((await fs.readdir(applications)).sort(), ["Mnemo.app"]);
});

test("download refuses archives that do not match the signed manifest", { skip: !isMac }, async (t) => {
  const { directory, privateKey } = await makeKeys(t);
  const root = await makeTempDirectory(t, "mnemo-update-bad-");
  const applications = path.join(root, "Applications");
  const build = path.join(root, "build");
  await fs.mkdir(applications);
  await fs.mkdir(build);
  const installed = await makeBundle(applications, { version: "0.1.0" });
  const setup = async ({ manifestVersion, bundle, archiveOverride }) => {
    const archive = await zipBundle(bundle, path.join(root, `a-${Math.random()}.zip`));
    const manifest = manifestFor(manifestVersion, archive);
    const { bytes, signature } = signManifest(manifest, privateKey);
    const github = fakeGitHub({ tag: `v${manifestVersion}`, manifest: bytes, signature, archive: archiveOverride ?? archive });
    return new Updater({
      currentVersion: "0.1.0",
      keysDirectory: directory,
      execPath: path.join(installed, "Contents", "MacOS", "Mnemo"),
      isPackaged: true,
      platform: "darwin",
      get: github.get,
      tempDirectory: root,
      relaunch: () => assert.fail("must not relaunch"),
    });
  };

  // Archive bytes changed after signing (same length, different content).
  const v2 = await makeBundle(path.join(build), { version: "0.2.0" });
  const good = await zipBundle(v2, path.join(root, "good.zip"));
  const swapped = Buffer.from(good);
  swapped[swapped.length - 30] ^= 0xff;
  let updater = await setup({ manifestVersion: "0.2.0", bundle: v2, archiveOverride: swapped });
  await assert.rejects(updater.download(await updater.check()), /does not match its signature/);

  // A correctly signed archive whose app has another bundle ID.
  await fs.rm(v2, { recursive: true });
  const foreign = await makeBundle(build, { id: "com.example.other", version: "0.3.0" });
  updater = await setup({ manifestVersion: "0.3.0", bundle: foreign });
  await assert.rejects(updater.download(await updater.check()), /not a valid Mnemo build/);

  // The app inside says a different version than the manifest.
  await fs.rm(foreign, { recursive: true });
  const mislabeled = await makeBundle(build, { version: "0.4.0" });
  updater = await setup({ manifestVersion: "0.5.0", bundle: mislabeled });
  await assert.rejects(updater.download(await updater.check()), /not a valid Mnemo build/);

  // Nothing was staged and the installed app is untouched.
  assert.deepEqual((await fs.readdir(applications)).sort(), ["Mnemo.app"]);
});

// A minimal valid asar archive holding one file. Inside Electron, `fs` sees it
// as a folder.
function asarArchive() {
  const json = Buffer.from(JSON.stringify({ files: { "main.js": { size: 1, offset: "0" } } }));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, Buffer.from(";")]);
}

// The Electron binary, or null when it was not downloaded
// (ELECTRON_SKIP_BINARY_DOWNLOAD).
function electronBinary() {
  try {
    return require("electron");
  } catch {
    return null;
  }
}

test("leftovers holding an app.asar are removed under Electron", { skip: !electronBinary() && "Electron is not installed" }, async (t) => {
  const applications = await makeTempDirectory(t, "mnemo-update-asar-");
  const installed = path.join(applications, "Mnemo.app");
  await fs.mkdir(installed);
  // A previous app that is already only partly deleted, and an unpacked
  // download that was rejected.
  for (const resources of [
    path.join(applications, ".Mnemo-previous-0123456789abcdef.app", "Contents", "Resources"),
    path.join(applications, ".Mnemo-update-fedcba9876543210", "Mnemo.app", "Contents", "Resources"),
  ]) {
    await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(resources, "app.asar"), asarArchive());
  }

  const script = `
    const [updaterPath, execPath] = process.argv.slice(1);
    const { Updater } = require(updaterPath);
    new Updater({ currentVersion: "0.1.0", execPath, isPackaged: true, platform: "darwin" })
      .cleanUpLeftovers()
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(electronBinary(), ["-e", script, require.resolve("../src/main/updater"), path.join(installed, "Contents", "MacOS", "Mnemo")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "pipe",
  });
  assert.deepEqual(await fs.readdir(applications), ["Mnemo.app"]);
});

test("a private key in the update keys folder is refused", async (t) => {
  const directory = await makeTempDirectory(t, "mnemo-update-keys-");
  const { privateKey } = generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(directory, "oops.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.throws(() => loadTrustedKeys(directory), /not an Ed25519 public key/);
  await fs.writeFile(path.join(directory, "oops.pem"), generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }));
  assert.throws(() => loadTrustedKeys(directory), /not an Ed25519 public key/);
  const updater = new Updater({ currentVersion: "0.1.0", keysDirectory: directory, platform: "darwin", isPackaged: true });
  assert.equal(updater.installBlocker(), "noKeys");
});
