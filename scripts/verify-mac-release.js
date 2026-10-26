// Verifies a packaged Mnemo.app: Electron fuses, embedded asar integrity,
// code signature, entitlements, and the stapled notarization ticket.
//
// Runs automatically as electron-builder's afterSign hook (after signing and
// notarization) and can be run by hand against any build:
//
//   node scripts/verify-mac-release.js release/mac-arm64/Mnemo.app
//
// MNEMO_LOCAL_TEST_BUILD=1 (or --local) accepts an ad-hoc signature without
// notarization, for `npm run pack:mac:local` only. Release builds must pass
// every check.
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
const ALLOWED_ENTITLEMENTS = new Set(["com.apple.security.cs.allow-jit"]);

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

function verifySignature(appPath, local) {
  const failures = [];
  try {
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  } catch (error) {
    return [`codesign --verify failed: ${error.stderr || error.message}`];
  }

  // codesign --display prints its report on stderr.
  const details = spawnSync("codesign", ["--display", "--verbose=4", appPath], { encoding: "utf8" }).stderr;
  if (!local && !/flags=.*\bruntime\b/.test(details)) {
    failures.push("hardened runtime flag is missing");
  }
  if (!local && !/Authority=Developer ID Application:/.test(details)) {
    failures.push("app is not signed with a Developer ID Application certificate");
  }

  // Helper apps are signed separately; a stray get-task-allow on a helper
  // would let a debugger attach to the renderer.
  for (const bundle of [appPath, ...findNestedBundles(path.join(appPath, "Contents", "Frameworks"))]) {
    const entitlementsXml = run("codesign", ["--display", "--entitlements", "-", "--xml", bundle]);
    const granted = Array.from(entitlementsXml.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g), ([, key]) => key);
    for (const key of granted) {
      if (!ALLOWED_ENTITLEMENTS.has(key)) {
        failures.push(`unexpected entitlement ${key} on ${path.relative(appPath, bundle) || "Mnemo.app"}`);
      }
    }
  }

  if (!local) {
    try {
      run("xcrun", ["stapler", "validate", appPath]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
    } catch (error) {
      failures.push(`notarization ticket or Gatekeeper assessment failed: ${error.stderr || error.message}`);
    }
  }
  return failures;
}

async function verifyApp(appPath, { local = false } = {}) {
  const { info, executable } = findExecutable(appPath);
  const failures = [
    ...(await verifyFuses(executable)),
    ...verifyAsarIntegrity(appPath, info),
    ...verifySignature(appPath, local),
  ];
  if (failures.length > 0) {
    throw new Error(`Release verification failed for ${appPath}:\n- ${failures.join("\n- ")}`);
  }
  console.log(`Verified ${appPath}`);
}

// electron-builder afterSign hook.
async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await verifyApp(appPath, { local: process.env.MNEMO_LOCAL_TEST_BUILD === "1" });
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.verifyApp = verifyApp;

if (require.main === module) {
  const [appPath, ...flags] = process.argv.slice(2);
  if (!appPath) {
    console.error("Usage: node scripts/verify-mac-release.js <path/to/Mnemo.app> [--local]");
    process.exit(2);
  }
  verifyApp(path.resolve(appPath), {
    local: flags.includes("--local") || process.env.MNEMO_LOCAL_TEST_BUILD === "1",
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
