// electron-builder configuration for signed, notarized macOS releases.
// Signing identity and notarization credentials come from the environment
// (CSC_LINK/CSC_NAME, APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER); none
// are stored in this repository. See docs/RELEASING.md.

// Shared with scripts/verify-mac-release.js and test/build-config.test.js so
// the requested fuse state and the verified fuse state cannot drift apart.
const electronFuses = Object.freeze({
  // Blocks ELECTRON_RUN_AS_NODE, which would turn the signed binary into a
  // generic Node.js interpreter that inherits the app's code signature.
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  // Blocks --inspect/--inspect-brk, so a local process cannot attach a
  // debugger to the main process and read the unlocked vault key.
  enableNodeCliInspectArguments: false,
  // Verifies app.asar against the hash embedded in the signed Info.plist.
  enableEmbeddedAsarIntegrityValidation: true,
  // Refuses to load app code from anything other than the verified app.asar.
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  // Off: the UI is served from app://mnemo/ (src/main/app-protocol.js), so
  // file:// pages get no privileges beyond a browser's and cannot read
  // app.asar.
  grantFileProtocolExtraPrivileges: false,
});

module.exports = {
  appId: "app.mnemo.desktop",
  productName: "Mnemo",
  directories: { output: "release", buildResources: "build" },
  asar: true,
  // Explicit allow-list: tests, support files, docs, and local data never ship.
  files: [
    "package.json",
    "main.js",
    "preload.js",
    "vault-store.js",
    "build/update-keys/*.pem",
    "index.html",
    "styles.css",
    "src/main/**/*.js",
    "src/renderer/**/*.js",
    "src/shared/**/*.js",
  ],
  electronFuses,
  // Fail the build instead of producing an unsigned app.
  forceCodeSigning: true,
  mac: {
    category: "public.app-category.productivity",
    // Generated from build/icon.svg by `npm run icon`.
    icon: "build/icon.icns",
    // Fixed names: the update manifest refers to the zips by name.
    artifactName: "${productName}-${version}-mac-${arch}.${ext}",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true,
  },
  afterSign: "scripts/verify-mac-release.js",
};

module.exports.electronFuses = electronFuses;
