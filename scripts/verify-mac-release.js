// Verifies a packaged Mnemo.app: Electron fuses, embedded asar integrity,
// code signature, entitlements, and the stapled notarization ticket.
//
// Runs automatically as electron-builder's afterSign hook (after signing and
// notarization) and can be run by hand against any build:
//
//   node scripts/verify-mac-release.js release/mac-arm64/Mnemo.app
//
// Modes (MNEMO_VERIFY_MODE, or --mode=<name>):
//   release        Developer ID, notarization, and everything below. Default.
//   adhoc-release  What the GitHub workflow publishes: an ad-hoc signature
//                  with the hardened runtime on every executable, fuses, asar
//                  integrity, and entitlements. No Developer ID and no
//                  notarization, so Gatekeeper still warns on first open.
//   local          `npm run pack:mac:local` only: like adhoc-release but the
//                  hardened runtime is not required. Never distribute these.
// MNEMO_LOCAL_TEST_BUILD=1 and --local still select "local".
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { FuseState, FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");
const { electronFuses } = require("../electron-builder.config");

const FUSE_NAMES = Object.freeze({
  runAsNode: FuseV1Options.RunAsNode,
  enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
  loadBrowserProcessSpecificV8Snapshot: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
  grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
});
const MODES = Object.freeze(["release", "adhoc-release", "local"]);
// allow-dyld-environment-variables and get-task-allow are never allowed: they
// would undo the hardened runtime's protection against injected libraries and
// debuggers.
const ALLOWED_ENTITLEMENTS = Object.freeze({
  release: new Set(["com.apple.security.cs.allow-jit"]),
  // An ad-hoc signature has no Team ID, so library validation would refuse
  // the app's own Electron Framework (build/entitlements.adhoc.plist).
  "adhoc-release": new Set(["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]),
  local: new Set(["com.apple.security.cs.allow-jit"]),
});
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const MH_EXECUTE = 2;

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readPlistJson(plistPath) {
  return JSON.parse(run("plutil", ["-convert", "json", "-o", "-", plistPath]));
}

function findExecutable(appPath) {
  const info = readPlistJson(path.join(appPath, "Contents", "Info.plist"));
  return { info, executable: path.join(appPath, "Contents", "MacOS", info.CFBundleExecutable) };
}

async function verifyFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  const failures = [];
  for (const [name, expected] of Object.entries(electronFuses)) {
    const actual = wire[FUSE_NAMES[name]];
    const expectedState = expected ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual !== expectedState) {
      failures.push(`${name}: expected ${FuseState[expectedState]}, found ${FuseState[actual] ?? actual}`);
    }
  }
  return failures;
}

function verifyAsarIntegrity(appPath, info) {
  const integrity = info.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (!integrity || integrity.algorithm !== "SHA256" || !/^[0-9a-f]{64}$/.test(integrity.hash)) {
    return ["Info.plist has no SHA256 ElectronAsarIntegrity entry for Resources/app.asar"];
  }
  const resources = path.join(appPath, "Contents", "Resources");
  for (const extra of ["app", "app.asar.unpacked"]) {
    if (fs.existsSync(path.join(resources, extra))) {
      return [`Contents/Resources/${extra} exists next to app.asar; only app.asar may ship`];
    }
  }
  return [];
}

function findNestedBundles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /\.(app|framework)$/.test(entry.name))
    .flatMap((entry) => {
      const bundle = path.join(directory, entry.name);
      const nested = path.join(bundle, "Contents", "Frameworks");
      return [bundle, ...(fs.existsSync(nested) ? findNestedBundles(nested) : [])];
    });
}

function readBytes(file, length, position) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, position);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

// Thin or universal 64-bit Mach-O main program (not a dylib or bundle).
function isMachExecutable(file) {
  const start = readBytes(file, 20, 0);
  // A universal binary's first slice offset is at byte 16 (big-endian).
  const offset = start.readUInt32BE(0) === FAT_MAGIC ? start.readUInt32BE(16) : 0;
  const header = offset === 0 ? start : readBytes(file, 16, offset);
  return header.readUInt32LE(0) === MH_MAGIC_64 && header.readUInt32LE(12) === MH_EXECUTE;
}

// Main programs inside the bundle (the app, helpers, crashpad handler). The
// hardened runtime applies per process, so each one needs the flag; dylibs and
// frameworks run inside one of them.
function findExecutables(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return findExecutables(file);
    if (!entry.isFile() || (fs.statSync(file).mode & 0o111) === 0) return [];
    return isMachExecutable(file) ? [file] : [];
  });
}

// codesign --display prints its report on stderr.
function signatureDetails(target) {
  return spawnSync("codesign", ["--display", "--verbose=4", target], { encoding: "utf8" }).stderr;
}

function verifySignature(appPath, mode) {
  const failures = [];
  try {
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  } catch (error) {
    return [`codesign --verify failed: ${error.stderr || error.message}`];
  }

  const details = signatureDetails(appPath);
  if (mode === "release" && !/Authority=Developer ID Application:/.test(details)) {
    failures.push("app is not signed with a Developer ID Application certificate");
  }
  if (mode === "adhoc-release" && !/^Signature=adhoc$/m.test(details)) {
    failures.push("app is not ad-hoc signed; use the release mode for Developer ID builds");
  }
  if (mode !== "local") {
    for (const executable of findExecutables(appPath)) {
      if (!/flags=.*\bruntime\b/.test(signatureDetails(executable))) {
        failures.push(`hardened runtime flag is missing on ${path.relative(appPath, executable)}`);
      }
    }
  }

  // Helper apps are signed separately; a stray get-task-allow on a helper
  // would let a debugger attach to the renderer.
  for (const bundle of [appPath, ...findNestedBundles(path.join(appPath, "Contents", "Frameworks"))]) {
    const entitlementsXml = run("codesign", ["--display", "--entitlements", "-", "--xml", bundle]);
    const granted = Array.from(entitlementsXml.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g), ([, key]) => key);
    for (const key of granted) {
      if (!ALLOWED_ENTITLEMENTS[mode].has(key)) {
        failures.push(`unexpected entitlement ${key} on ${path.relative(appPath, bundle) || "Mnemo.app"}`);
      }
    }
  }

  if (mode === "release") {
    try {
      run("xcrun", ["stapler", "validate", appPath]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
    } catch (error) {
      failures.push(`notarization ticket or Gatekeeper assessment failed: ${error.stderr || error.message}`);
    }
  }
  return failures;
}

function resolveMode({ flags = [], env = process.env } = {}) {
  const flag = flags.find((value) => value.startsWith("--mode="));
  const mode = flag ? flag.slice("--mode=".length)
    : flags.includes("--local") ? "local"
      : env.MNEMO_VERIFY_MODE || (env.MNEMO_LOCAL_TEST_BUILD === "1" ? "local" : "release");
  if (!MODES.includes(mode)) throw new Error(`Unknown verification mode "${mode}" (expected ${MODES.join(", ")})`);
  return mode;
}

async function verifyApp(appPath, { mode = "release" } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown verification mode "${mode}"`);
  const { info, executable } = findExecutable(appPath);
  const failures = [
    ...(await verifyFuses(executable)),
    ...verifyAsarIntegrity(appPath, info),
    ...verifySignature(appPath, mode),
  ];
  if (failures.length > 0) {
    throw new Error(`Release verification failed for ${appPath}:\n- ${failures.join("\n- ")}`);
  }
  console.log(`Verified ${appPath} (${mode})`);
}

// electron-builder afterSign hook.
async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await verifyApp(appPath, { mode: resolveMode() });
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.ALLOWED_ENTITLEMENTS = ALLOWED_ENTITLEMENTS;
module.exports.resolveMode = resolveMode;
module.exports.verifyApp = verifyApp;

if (require.main === module) {
  const [appPath, ...flags] = process.argv.slice(2);
  if (!appPath) {
    console.error(`Usage: node scripts/verify-mac-release.js <path/to/Mnemo.app> [--mode=${MODES.join("|")}]`);
    process.exit(2);
  }
  Promise.resolve()
    .then(() => verifyApp(path.resolve(appPath), { mode: resolveMode({ flags }) }))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
