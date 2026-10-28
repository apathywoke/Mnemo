# Releasing Mnemo for macOS

There are two ways to ship:

- **GitHub releases with in-app updates** (what the project uses today, no
  Apple account): push a version tag and GitHub Actions builds, signs the
  update manifest, and publishes. The app is ad-hoc signed with the hardened
  runtime and is not notarized. See
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
npm run verify:mac -- release/mac-arm64/Mnemo.app                       # Developer ID
npm run verify:mac -- release/mac-arm64/Mnemo.app --mode=adhoc-release  # GitHub build
```

`scripts/verify-mac-release.js` has three modes (`--mode=` or
`MNEMO_VERIFY_MODE`):

| Check | `release` | `adhoc-release` | `local` |
| --- | --- | --- | --- |
| Fuses, asar integrity, `codesign --verify --deep --strict` | yes | yes | yes |
| Hardened runtime on every executable (app, helpers, crashpad) | yes | yes | no |
| Signature | Developer ID Application | ad-hoc | any |
| Entitlements allowed | `allow-jit` | `allow-jit`, `disable-library-validation` | `allow-jit` |
| Stapled ticket and Gatekeeper | yes | no | no |

No mode allows `allow-dyld-environment-variables` or `get-task-allow`.
`MNEMO_LOCAL_TEST_BUILD=1` and `--local` still select `local`.

Useful manual checks:

```sh
npx @electron/fuses read --app release/mac-arm64/Mnemo.app
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Mnemo.app
codesign --display --entitlements - --xml release/mac-arm64/Mnemo.app
xcrun stapler validate release/mac-arm64/Mnemo.app
spctl --assess --type execute --verbose=2 release/mac-arm64/Mnemo.app
```

## Local builds

`npm run dist:mac:local` runs `npm run dist:mac:adhoc`, the command the
release workflow uses: `.dmg` and `.zip` for `arm64` and `x64`, ad-hoc signed
with the hardened runtime and `build/entitlements.adhoc.plist`, verified in
`adhoc-release` mode. It is the way to check a release build before tagging.

`npm run pack:mac:local` builds an unpacked `release/mac-*/Mnemo.app` for
debugging: same fuses and asar integrity, ad-hoc signature, but no hardened
runtime, so `DYLD_*` variables and debuggers work on it. The verification
hook runs in `local` mode. Do not distribute these builds.

A packaged build uses the same per-user data directory as `npm start`
(`~/Library/Application Support/local-vault-prototype`). Pass
`--user-data-dir=/some/scratch/dir` when testing a build so it does not touch
real vaults.

## Publishing a release

`.github/workflows/release.yml` runs on every pushed tag that starts with `v`.

1. **build** (macOS, no secrets): checks that the tag equals `v` + the
   `package.json` version, runs `npm ci` and `npm test`, and builds
   `Mnemo-<version>-mac-<arch>.dmg` and `.zip` for `arm64` and `x64` with
   `npm run dist:mac:adhoc` (see [Ad-hoc release builds](#ad-hoc-release-builds)).
   The `afterSign` hook verifies them in `adhoc-release` mode.
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

**Build without releasing.** Actions → Release → **Run workflow** runs only
the build job on the chosen branch and uploads the `.dmg` and `.zip` files as
the `mac-builds` artifact (kept 7 days). The publish job is skipped, so the
update key is never used and nothing is released. The tag check is skipped
too, so the version is whatever `package.json` says. GitHub shows the
button only once this workflow, with `workflow_dispatch`, is on the default
branch.

### Ad-hoc release builds

Without a Developer ID, the workflow signs ad hoc (`identity=-`), still with
the hardened runtime on the app, every helper, and the crashpad handler, and
skips notarization. They use `build/entitlements.adhoc.plist`:

- `com.apple.security.cs.allow-jit`, as in Developer ID builds;
- `com.apple.security.cs.disable-library-validation`, only here. An ad-hoc
  signature has no Team ID, and library validation compares Team IDs, so
  without it the app cannot load its own `Electron Framework` and dyld
  aborts at launch ("mapping process and mapped file (non-platform) have
  different Team IDs").

The hardened runtime still makes the process ignore `DYLD_*` environment
variables and, without `get-task-allow`, refuse debuggers. The `DYLD_*` part
was checked on macOS 27 (arm64): a test library passed in
`DYLD_INSERT_LIBRARIES` is loaded into the main process, the helpers, and the
renderer of a `pack:mac:local` build, and into none of them in a
`dist:mac:local` build. `codesign -dv` shows `flags=0x10002(adhoc,runtime)`.

What these builds lack compared to Developer ID: notarization (Gatekeeper
warns on first open), an author macOS can identify, library validation, and
a Keychain identity that survives updates. See `docs/THREAT_MODEL.md` (A4,
A5, A7).

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

The updater checks a downloaded app with `codesign --verify --deep --strict`,
which accepts ad-hoc signatures with or without the hardened runtime, so
copies built before the hardened runtime update to builds with it. This was
checked by running `Updater` (real `ditto`, `codesign`, and bundle swap; a
local fake GitHub) from an installed build without the runtime to a
`dist:mac:local` zip; the swapped-in app started and passed
`--mode=adhoc-release`.

`test/updater.test.js` builds small ad-hoc-signed app bundles, zips them with
`ditto`, signs a manifest with a throwaway key, and runs check, download, and
install against a temporary `Applications` folder with a fake GitHub. It
also covers tampered archives, foreign bundle IDs, and version mismatches.
`test/make-update-manifest.test.js` runs the signing script against a test
key pair.

## App name, data folder, and the Keychain

**Data folder.** `main.js` pins the data folder (vaults, `profiles.json`,
`settings.json`, `biometric/`) to
`~/Library/Application Support/local-vault-prototype` (`USER_DATA_FOLDER`).
It no longer follows `name` or `productName` in `package.json`, so renaming
the package cannot point the app at an empty folder. `--user-data-dir`
still overrides it, for test builds.

**Keychain.** Touch ID unlock stores each vault key encrypted with
`safeStorage`, whose key lives in the login Keychain as the generic
password **"<app name> Safe Storage"** (account "<app name>"). In
Electron 45 the app name is `app.getName()`: the value of `app.setName()`
if called, otherwise `productName`, otherwise `name` from the packaged
`package.json`. Electron reads it once per launch, in
`ElectronBrowserMainParts::PostCreateMainMessageLoop`
(`shell/browser/electron_browser_main_parts.cc`). The top level of
`main.js` runs earlier (`PostEarlyInitialization` → `LoadEnvironment`). Today
the item is **"local-vault-prototype Safe Storage"**; `productName: "Mnemo"`
in `electron-builder.config.js` only names the bundle and does not change it.

Changing `name` in `package.json` or adding `productName` there therefore
changes the Keychain item. Electron then creates a new key, the existing
`biometric/<profile>.key` files no longer decrypt, and Touch ID unlock stops
("Touch ID can no longer unlock this vault…"). Vaults, backups, and
passphrases are not affected.

**Renaming safely.** Keep the internal name and change only what users see:

1. In the same change as the rename, call
   `app.setName("local-vault-prototype")` at the top of `main.js`, before
   anything else runs. The Keychain item and every other name-derived value
   stay as they are.
2. Set the visible name separately: the bundle name already comes from
   `productName` in `electron-builder.config.js`; the About panel can use
   `app.setAboutPanelOptions({ applicationName: "Mnemo" })`.
3. Before releasing, test on a Mac with Touch ID turned on: install the
   previous release, turn on Touch ID, update, and unlock with Touch ID.

If the internal name must change after all, there is no way to read the old
item with `safeStorage` once the name has changed (it is read once per
launch). Users then turn Touch ID on again with their master passphrase; the
old Keychain item is left behind and can be deleted in Keychain Access.
