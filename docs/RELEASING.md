# Releasing Mnemo for macOS

There are two ways to ship:

- **GitHub releases with in-app updates** (what the project uses today, no
  Apple account): push a version tag and GitHub Actions builds, signs the
  update manifest, and publishes. The app is ad-hoc signed. See
  [Publishing a release](#publishing-a-release).
- **Developer ID builds** (`npm run dist:mac`), signed and notarized by Apple,
  described next. The release workflow does not use them yet.

A Developer ID release build is produced by electron-builder with the
configuration in `electron-builder.config.js`. It:

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

## Publishing a release

`.github/workflows/release.yml` runs on every pushed tag that starts with `v`.

1. **build** (macOS, no secrets): checks that the tag equals `v` + the
   `package.json` version, runs `npm ci` and `npm test`, and builds ad-hoc
   signed `Mnemo-<version>-mac-<arch>.dmg` and `.zip` for `arm64` and `x64`.
   The `afterSign` hook still verifies fuses and asar integrity.
2. **publish** (Linux, environment `release`): takes the release notes from
   the tag message, runs `scripts/make-update-manifest.js` with the
   `MNEMO_UPDATE_PRIVATE_KEY` secret, and creates the GitHub release with the
   zips, dmgs, `update-manifest.json`, and `update-manifest.json.sig`. This
   job installs no npm packages, so dependencies never see the key.

To release:

```sh
npm version 0.2.0 --no-git-tag-version   # or edit package.json
git commit -am "Release 0.2.0"
git tag -a v0.2.0 -m "Short title" -m "- What changed
- What else changed"
git push origin main v0.2.0
```

The tag message becomes the GitHub release notes and the app's "What's new"
(at most 8000 characters). A tag with a hyphen (`v0.3.0-beta.1`) becomes a
GitHub prerelease, which the in-app updater never offers.

### One-time setup

1. Generate the Ed25519 key pair on a trusted machine, put the private key in
   the environment secret, and delete the local copy:

   ```sh
   openssl genpkey -algorithm ed25519 -out mnemo-update-private.pem
   openssl pkey -in mnemo-update-private.pem -pubout -out mnemo-update-public.pem
   ```

2. Repository Settings → Environments → `release`: add the secret
   `MNEMO_UPDATE_PRIVATE_KEY` (the whole PEM). Under deployment branches and
   tags, allow only tags matching `v*`; add yourself as a required reviewer
   so every release waits for an approval.
3. Commit the public key to `build/update-keys/` (any `*.pem` name). Every
   `.pem` there is trusted by the builds that include it.

Never commit the private key, paste it into an issue or chat, or store it on
a shared machine.

### What the app does

About 20 seconds after launch and then on the schedule chosen in
Settings → Updates (every 30 minutes, hour, 6 hours, or day; daily by
default; or never), and whenever the user clicks **Check for updates**,
the app reads the latest release, verifies the manifest
signature with the bundled keys, and shows a banner when a newer version
exists. **Install** downloads the archive for this Mac, checks its hash and
size against the manifest, unpacks it next to the installed app, and checks
the bundle ID, version, and code signature. **Restart now** locks the vault,
swaps the app with renames, and relaunches. The details and limits are in
`SECURITY.md` and `docs/THREAT_MODEL.md` (B6, A8).

The app can update itself only when it runs from a folder the user can write
to (normally `/Applications`). Started from the disk image, from Downloads
with App Translocation, or from a read-only folder, it offers the release
page instead.

### Ad-hoc signature: what users see

- **First install**: macOS refuses to open an app that is not notarized. The
  user opens it once, then allows it in System Settings → Privacy & Security
  → **Open Anyway**. Updates installed by the app are not quarantined and do
  not ask again.
- **After each update**, if Touch ID unlock is on, macOS may ask to let
  Mnemo use its "Safe Storage" Keychain item, because an ad-hoc signature is
  different for every build. **Always Allow** keeps Touch ID working; denying
  it means unlocking with the master passphrase until Touch ID is turned on
  again.

Both go away with a Developer ID signature.

### Rotating or revoking the update key

The app accepts a manifest signed by any key in `build/update-keys/` of the
running copy, so a new key has to reach users before it is used:

1. Add the new public key to `build/update-keys/` and release a version
   signed with the **old** key. Copies that update now trust both.
2. Switch the `MNEMO_UPDATE_PRIVATE_KEY` secret to the new key.
3. After most users have updated, remove the old public key in a later
   release.

If the private key leaks, anyone can sign updates for every copy that still
trusts it. Release a version that drops the leaked key as soon as possible,
signed with it, and announce it; copies that miss it stay exposed until
they update manually.

### Testing the updater locally

`test/updater.test.js` builds small ad-hoc-signed app bundles, zips them with
`ditto`, signs a manifest with a throwaway key, and runs check, download, and
install against a temporary `Applications` folder with a fake GitHub. It
also covers tampered archives, foreign bundle IDs, and version mismatches.
`test/make-update-manifest.test.js` runs the signing script against a test
key pair.
