// Builds the Touch ID helper (native/touch-id/main.swift) as a universal
// macOS binary in build/native/mnemo-touch-id:
//
//   node scripts/build-touch-id.js
//
// Needs Xcode's command line tools (swiftc, lipo). electron-builder copies
// the binary into Contents/Resources and signs it with the app; `npm start`
// finds it at the same path in the checkout. Without it, Touch ID falls back
// to the Keychain-based unlock (src/main/biometric-unlock.js).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "native", "touch-id", "main.swift");
const OUTPUT = path.join(ROOT, "build", "native", "mnemo-touch-id");
// Electron 45 runs on macOS 12, but on 12 the helper would need Swift's
// back-deployment libraries, which Command Line Tools ship for arm64 only.
// On macOS 12 the helper does not start and Touch ID keeps using the
// Keychain-based unlock.
const MINIMUM_MACOS = "13.0";
const ARCHITECTURES = ["arm64", "x86_64"];

// `architectures`: tests build only the slice for the running Mac.
function build(output = OUTPUT, { architectures = ARCHITECTURES } = {}) {
  if (process.platform !== "darwin") throw new Error("The Touch ID helper builds on macOS only.");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-touch-id-"));
  try {
    const slices = architectures.map((arch) => {
      const slice = path.join(work, arch);
      execFileSync("xcrun", [
        "swiftc", "-O", "-target", `${arch}-apple-macos${MINIMUM_MACOS}`, SOURCE, "-o", slice,
      ], { stdio: "inherit" });
      return slice;
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync("xcrun", ["lipo", "-create", ...slices, "-output", output], { stdio: "inherit" });
    // Ad-hoc signed for `npm start`; release builds sign it again with the app.
    execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", output], { stdio: "inherit" });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return output;
}

if (require.main === module) {
  console.log(`Built ${path.relative(ROOT, build())}`);
}

module.exports = { ARCHITECTURES, OUTPUT, SOURCE, build };
