# Releasing Mnemo for macOS

Release builds are produced by electron-builder with the configuration in
`electron-builder.config.js`. A release build:

1. packages the app into a single `app.asar` (only the files in the `files`
   allow-list; tests, docs, and local data never ship);
2. flips the Electron fuses listed below and embeds the SHA-256 of `app.asar`
   in `Info.plist` (`ElectronAsarIntegrity`);
3. signs every binary with a **Developer ID Application** certificate, the
   hardened runtime, and the entitlements in `build/entitlements.mac.plist`
   (`com.apple.security.cs.allow-jit` only);
4. notarizes the app with Apple and staples the ticket;
5. runs `scripts/verify-mac-release.js` as the `afterSign` hook, which fails
   the build if any fuse, the asar integrity entry, the signature, the
   entitlements, the stapled ticket, or the Gatekeeper assessment is wrong.

`forceCodeSigning` is on: without a usable identity the build fails instead of
producing an unsigned app.

## Fuses

| Fuse | State | Why |
| --- | --- | --- |
| `RunAsNode` | off | `ELECTRON_RUN_AS_NODE=1` would turn the signed binary into a plain Node.js interpreter that inherits the app's signature and Keychain/TCC identity. |
| `EnableNodeCliInspectArguments` | off | `--inspect`/`--inspect-brk` would let a local process attach a debugger to the main process, which holds the unlocked vault key. |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS=--require …` would inject code into the main process. |
| `OnlyLoadAppFromAsar` | on | Electron refuses to load app code from anything other than `app.asar` (for example a planted `Resources/app/` folder). |
| `EnableEmbeddedAsarIntegrityValidation` | on | `app.asar` is checked against the hash in the signed `Info.plist`; a modified archive aborts startup with "ASAR Integrity Violation". |
| `EnableCookieEncryption` | on | Defense in depth; the app stores no cookies it relies on. |
| `LoadBrowserProcessSpecificV8Snapshot` | off | Not used. |
| `GrantFileProtocolExtraPrivileges` | **on** | Required while the UI is loaded with `loadFile()`: with it off, `file://` cannot read from `app.asar`. Turn it off after moving the UI to a custom `app://` protocol. |

Chromium's `--remote-debugging-port`/`--remote-debugging-pipe` switches have no
fuse; `main.js` makes packaged builds exit immediately when either is present.

## One-time setup

1. Join the Apple Developer Program and create a **Developer ID Application**
   certificate. Install it in the login keychain of the build machine, or
   export it as a password-protected `.p12`.
2. Create an App Store Connect API key with the *Developer* role (Users and
   Access → Integrations → App Store Connect API) and download the `.p8` file.
   API keys are preferred over an Apple ID with an app-specific password.
3. Replace `appId` in `electron-builder.config.js` (`app.mnemo.desktop`) with a
   reverse-DNS identifier you control before the first public release; it is
   part of the signed identity and should not change afterwards.

Never commit certificates, `.p8` keys, or passwords. `.gitignore` already
excludes `*.p12`, `*.pem`, `*.key`, and `.env*`.

## Building a release

```sh
npm ci
npm test

# Signing identity: either a keychain identity…
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
# …or a .p12 file (CI):
# export CSC_LINK=/secure/path/DeveloperID.p12
# export CSC_KEY_PASSWORD=…

# Notarization (App Store Connect API key):
export APPLE_API_KEY=/secure/path/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

npm run dist:mac
```

Output goes to `release/`: a `.dmg` and a `.zip` for `arm64` and `x64`.

If the notarization variables are missing, electron-builder skips notarization
with a warning, and the `afterSign` verification then fails the build because
no ticket is stapled.

## Verifying an artifact by hand

```sh
npm run verify:mac -- release/mac-arm64/Mnemo.app
```

Useful manual checks:

```sh
npx @electron/fuses read --app release/mac-arm64/Mnemo.app
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Mnemo.app
codesign --display --entitlements - --xml release/mac-arm64/Mnemo.app
xcrun stapler validate release/mac-arm64/Mnemo.app
spctl --assess --type execute --verbose=2 release/mac-arm64/Mnemo.app
```

## Local test builds

`npm run pack:mac:local` builds an unpacked `release/mac-*/Mnemo.app` with the
same fuses and asar integrity, but with an ad-hoc signature, no hardened
runtime, and no notarization. The verification hook runs in "local" mode and
still checks fuses, asar integrity, `codesign --verify`, and entitlements. Do
not distribute these builds.

A packaged build uses the same per-user data directory as `npm start`
(`~/Library/Application Support/local-vault-prototype`). Pass
`--user-data-dir=/some/scratch/dir` when testing a build so it does not touch
real vaults.
