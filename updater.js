// Self-hosted updates through GitHub Releases, without an Apple certificate.
//
// Trust comes from our own Ed25519 key: every release carries
// update-manifest.json and update-manifest.json.sig. The manifest lists the
// version, notes, and each archive's size and SHA-512; the signature covers
// the manifest bytes and is checked against the public keys bundled with the
// app (build/update-keys/*.pem). An archive is installed only if its hash
// matches the signed manifest, its version is newer than the running one,
// and the unpacked app has our bundle ID, the expected version, and a valid
// code signature.
//
// Network access is limited to HTTPS on GitHub's release hosts, with size
// and time limits. See docs/RELEASING.md and docs/THREAT_MODEL.md.
const { execFile, spawn } = require("node:child_process");
const { createHash, createPublicKey, randomBytes, verify } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const UPDATE_REPOSITORY = "apathywoke/Mnemo";
const MANIFEST_NAME = "update-manifest.json";
const SIGNATURE_NAME = "update-manifest.json.sig";
const MANIFEST_FORMAT = "mnemo-update-manifest";
const MANIFEST_VERSION = 1;
const ALLOWED_HOSTS = Object.freeze(new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]));
const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_NOTES_LENGTH = 8000;
const LEFTOVER_PATTERN = /^\.Mnemo-(previous|update)-[0-9a-f]{16}(\.app)?$/;

// --- Versions ---------------------------------------------------------------

function parseVersion(text) {
  const match = String(text).match(/^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] ?? "" };
}

// Returns >0 when `a` is newer than `b`. A prerelease sorts before its release.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("Invalid version");
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  // Semver: compare dot-separated identifiers; numbers numerically and
  // before words; a shorter list sorts first when all else is equal.
  const ours = left.prerelease.split(".");
  const theirs = right.prerelease.split(".");
  for (let i = 0; i < Math.min(ours.length, theirs.length); i += 1) {
    if (ours[i] === theirs[i]) continue;
    const ourNumber = /^\d+$/.test(ours[i]);
    const theirNumber = /^\d+$/.test(theirs[i]);
    if (ourNumber && theirNumber) return Number(ours[i]) - Number(theirs[i]);
    if (ourNumber !== theirNumber) return ourNumber ? -1 : 1;
    return ours[i] < theirs[i] ? -1 : 1;
  }
  return ours.length - theirs.length;
}

// --- Keys and manifest --------------------------------------------------------

function loadTrustedKeys(directory) {
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".pem")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const text = fs.readFileSync(path.join(directory, name), "utf8");
    // createPublicKey() also accepts a private key; refuse one shipped by mistake.
    const key = text.includes("PRIVATE KEY") ? null : createPublicKey(text);
    if (key?.asymmetricKeyType !== "ed25519") throw new Error(`Update key ${name} is not an Ed25519 public key`);
    return key;
  });
}

// Accepts the manifest only if a trusted key signed exactly these bytes.
function verifyManifest(manifestBytes, signatureText, trustedKeys) {
  const signature = Buffer.from(String(signatureText).trim(), "base64");
  if (signature.length !== 64) throw new Error("The update signature is invalid.");
  if (!trustedKeys.some((key) => verify(null, manifestBytes, key, signature))) {
    throw new Error("The update signature is invalid.");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("The update information is invalid.");
  }
  const valid =
    manifest?.format === MANIFEST_FORMAT &&
    manifest.version === MANIFEST_VERSION &&
    parseVersion(manifest.appVersion) &&
    typeof manifest.notes === "string" &&
    manifest.notes.length <= MAX_NOTES_LENGTH &&
    manifest.assets !== null &&
    typeof manifest.assets === "object" &&
    Object.entries(manifest.assets).every(([arch, asset]) =>
      /^(arm64|x64)$/.test(arch) &&
      typeof asset?.name === "string" &&
      /^[A-Za-z0-9._-]{1,200}\.zip$/.test(asset.name) &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      asset.size <= MAX_ARCHIVE_BYTES &&
      typeof asset.sha512 === "string" &&
      Buffer.from(asset.sha512, "base64").length === 64);
  if (!valid) throw new Error("The update information is invalid.");
  return manifest;
}

// --- HTTPS --------------------------------------------------------------------

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The update server address is not allowed.");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error("The update server address is not allowed.");
  }
  return url;
}

// GETs a URL into a buffer or a file, following redirects only to allowed
// hosts. Resolves with { buffer } or { sha512, size }.
function httpsGet(value, { maxBytes, accept = "*/*", userAgent, toFile = null, onProgress = null }, redirects = 0) {
  const url = assertAllowedUrl(value);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: accept, "User-Agent": userAgent },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const { statusCode } = response;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error("Could not download the update."));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        httpsGet(next, { maxBytes, accept, userAgent, toFile, onProgress }, redirects + 1).then(resolve, reject);
        return;
      }
      if (statusCode === 404) {
        response.resume();
        reject(Object.assign(new Error("No update was found."), { notFound: true }));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error("Could not reach the update server."));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > maxBytes) {
        response.destroy();
        reject(new Error("The update is too large."));
        return;
      }

      let received = 0;
      const chunks = [];
      const hash = createHash("sha512");
      const file = toFile ? fs.createWriteStream(toFile, { mode: 0o600, flags: "wx" }) : null;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(new Error("The update is too large."));
          return;
        }
        if (file) {
          hash.update(chunk);
          file.write(chunk);
          onProgress?.(received, declared);
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", (error) => {
        file?.destroy();
        reject(error.message === "The update is too large." ? error : new Error("Could not download the update."));
      });
      response.on("end", () => {
        if (!file) {
          resolve({ buffer: Buffer.concat(chunks) });
          return;
        }
        file.end(() => resolve({ sha512: hash.digest("base64"), size: received }));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Could not reach the update server.")));
    request.on("error", (error) => reject(
      error.notFound || /too large|not allowed|reach/.test(error.message)
        ? error
        : new Error("Could not reach the update server."),
    ));
  });
}

// --- Commands -----------------------------------------------------------------

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readBundleInfo(bundlePath) {
  const json = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(bundlePath, "Contents", "Info.plist")]);
  const info = JSON.parse(json);
  return { id: info.CFBundleIdentifier, version: info.CFBundleShortVersionString };
}

// Waits for this process to exit (single-instance lock), then reopens the
// app. Values are passed as arguments, not interpolated into the script.
function relaunchAfterExit(bundle) {
  spawn("/bin/sh", [
    "-c",
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; /usr/bin/open "$2"',
    "mnemo-relaunch",
    String(process.pid),
    bundle,
  ], { detached: true, stdio: "ignore" }).unref();
}

// --- Updater ------------------------------------------------------------------

class Updater {
  constructor({
    currentVersion,
    arch = process.arch,
    keysDirectory,
    execPath = process.execPath,
    isPackaged = false,
    platform = process.platform,
    repository = UPDATE_REPOSITORY,
    get = httpsGet,
    exec = run,
    relaunch = relaunchAfterExit,
    tempDirectory = os.tmpdir(),
  }) {
    this.currentVersion = currentVersion;
    this.arch = arch;
    // A broken key file disables updates, not the app (tests catch it first).
    try {
      this.trustedKeys = loadTrustedKeys(keysDirectory);
    } catch {
      this.trustedKeys = [];
    }
    this.execPath = execPath;
    this.isPackaged = isPackaged;
    this.platform = platform;
    this.repository = repository;
    this.get = get;
    this.exec = exec;
    this.relaunch = relaunch;
    this.tempDirectory = tempDirectory;
    this.userAgent = `Mnemo/${currentVersion} (update check)`;
    this.staged = null;
  }

  bundlePath() {
    return path.resolve(this.execPath, "..", "..", "..");
  }

  // Why the running copy cannot replace itself, or null if it can.
  installBlocker() {
    if (this.platform !== "darwin" || !this.isPackaged) return "notPackaged";
    if (this.trustedKeys.length === 0) return "noKeys";
    const bundle = this.bundlePath();
    if (!bundle.endsWith(".app")) return "notPackaged";
    if (bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) return "notInApplications";
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    } catch {
      return "notWritable";
    }
    return null;
  }

  // Looks at the latest GitHub release. Resolves with null when the running
  // version is current, or with the verified update description.
  async check() {
    if (this.trustedKeys.length === 0) throw new Error("Updates are not configured in this build.");
    const api = `https://api.github.com/repos/${this.repository}/releases/latest`;
    let release;
    try {
      const { buffer } = await this.get(api, {
        maxBytes: MAX_RELEASE_JSON_BYTES,
        accept: "application/vnd.github+json",
        userAgent: this.userAgent,
      });
      release = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      if (error.notFound) return null;
      throw error.message?.startsWith("Could not") ? error : new Error("Could not reach the update server.");
    }

    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const assetUrl = (name) => assets.find((asset) => asset?.name === name)?.browser_download_url;
    const manifestUrl = assetUrl(MANIFEST_NAME);
    const signatureUrl = assetUrl(SIGNATURE_NAME);
    if (!manifestUrl || !signatureUrl) throw new Error("The update information is invalid.");

    const [{ buffer: manifestBytes }, { buffer: signatureBytes }] = await Promise.all([
      this.get(manifestUrl, { maxBytes: MAX_MANIFEST_BYTES, userAgent: this.userAgent }),
      this.get(signatureUrl, { maxBytes: MAX_SIGNATURE_BYTES, userAgent: this.userAgent }),
    ]);
    const manifest = verifyManifest(manifestBytes, signatureBytes.toString("utf8"), this.trustedKeys);

    // The tag must name the same version, so a signed manifest cannot be
    // attached to another release.
    if (typeof release.tag_name !== "string" || compareVersions(release.tag_name, manifest.appVersion) !== 0) {
      throw new Error("The update information is invalid.");
    }
    if (compareVersions(manifest.appVersion, this.currentVersion) <= 0) return null;

    const asset = manifest.assets[this.arch];
    const url = asset && assetUrl(asset.name);
    return {
      version: manifest.appVersion,
      notes: manifest.notes,
      releaseUrl: typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${this.repository}/releases/`)
        ? release.html_url
        : `https://github.com/${this.repository}/releases/latest`,
      asset: asset && url ? { ...asset, url } : null,
    };
  }

  // Downloads, verifies, and unpacks the update next to the installed app,
  // ready to be swapped in on restart.
  async download(update, onProgress) {
    const blocker = this.installBlocker();
    if (blocker) throw Object.assign(new Error("This copy of Mnemo cannot update itself."), { blocker });
    if (!update?.asset) throw new Error("No update is available for this Mac.");

    const bundle = this.bundlePath();
    const token = randomBytes(8).toString("hex");
    const workDirectory = await fsp.mkdtemp(path.join(this.tempDirectory, "mnemo-update-"));
    const archivePath = path.join(workDirectory, "update.zip");
    const stageDirectory = path.join(path.dirname(bundle), `.Mnemo-update-${token}`);
    try {
      const { sha512, size } = await this.get(update.asset.url, {
        maxBytes: update.asset.size,
        userAgent: this.userAgent,
        toFile: archivePath,
        onProgress,
      });
      if (size !== update.asset.size || sha512 !== update.asset.sha512) {
        throw new Error("The downloaded update does not match its signature.");
      }

      await fsp.mkdir(stageDirectory, { mode: 0o700 });
      // ditto keeps the symlinks and signatures inside the app bundle.
      await this.exec("/usr/bin/ditto", ["-x", "-k", archivePath, stageDirectory]);
      const stagedApp = path.join(stageDirectory, path.basename(bundle));
      const [current, staged] = await Promise.all([readBundleInfo(bundle), readBundleInfo(stagedApp)]);
      if (staged.id !== current.id || compareVersions(staged.version, update.version) !== 0) {
        throw new Error("The downloaded update is not a valid Mnemo build.");
      }
      await this.exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);

      this.staged = { version: update.version, stageDirectory, stagedApp };
      return { version: update.version };
    } catch (error) {
      await fsp.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
      if (/does not match|not a valid|too large|reach|download/.test(error.message)) throw error;
      throw new Error("Could not install the update.");
    } finally {
      await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Swaps the staged app into place and starts it once this process exits.
  // On failure the installed app is put back.
  async install() {
    if (!this.staged) throw new Error("No update is ready to install.");
    const bundle = this.bundlePath();
    const previous = path.join(path.dirname(bundle), `.Mnemo-previous-${randomBytes(8).toString("hex")}.app`);
    try {
      await fsp.rename(bundle, previous);
    } catch {
      throw new Error("Could not install the update.");
    }
    try {
      await fsp.rename(this.staged.stagedApp, bundle);
    } catch {
      await fsp.rename(previous, bundle);
      throw new Error("Could not install the update.");
    }
    await fsp.rm(this.staged.stageDirectory, { recursive: true, force: true }).catch(() => {});
    this.staged = null;

    this.relaunch(bundle);
    return { relaunching: true };
  }

  // Removes the previous app and unfinished downloads left by earlier updates.
  // Never touches the running bundle (if it was started from a leftover name)
  // or a download staged in this session.
  async cleanUpLeftovers() {
    if (this.platform !== "darwin" || !this.isPackaged) return;
    const bundle = this.bundlePath();
    if (LEFTOVER_PATTERN.test(path.basename(bundle))) return;
    const parent = path.dirname(bundle);
    const keep = this.staged ? path.basename(this.staged.stageDirectory) : null;
    let names = [];
    try {
      names = await fsp.readdir(parent);
    } catch {
      return;
    }
    await Promise.all(names
      .filter((name) => LEFTOVER_PATTERN.test(name) && name !== keep)
      .map((name) => fsp.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {})));
  }
}

module.exports = {
  ALLOWED_HOSTS,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
  MANIFEST_VERSION,
  MAX_NOTES_LENGTH,
  SIGNATURE_NAME,
  UPDATE_REPOSITORY,
  Updater,
  assertAllowedUrl,
  compareVersions,
  httpsGet,
  loadTrustedKeys,
  parseVersion,
  verifyManifest,
};
