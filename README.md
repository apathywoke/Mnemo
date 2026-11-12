# Mnemo

A macOS-first Electron prototype of Mnemo, a local-first password manager.
Everything stays in encrypted vaults on your Mac; there is no account and no
server. It has not had an independent security review.

> **Prototype: not for real passwords yet.** The app no longer says so on
> every screen, so this page does.

- **Items:** logins with one-time codes (TOTP), payment cards, secure notes,
  identities, and SSH keys; folders, favorites, a trash kept for 30 days,
  the last 20 versions of each item, and encrypted attachments.
- **Vaults:** several named vaults, each with its own master passphrase and a
  recovery key; Touch ID unlock through the Secure Enclave (macOS 13 or
  later).
- **Keeping data safe:** verified local snapshots, encrypted copies in a
  folder outside this Mac (iCloud Drive or an external disk), restoring from
  either, encrypted backups, and checks of the recovery key and passphrase
  that change nothing (see below).
- **Moving in and out:** import from Bitwarden, 1Password, and Mnemo
  backups; export without encryption in Bitwarden's JSON or CSV format.
- **Reports:** weak, reused, and breached passwords (the breach check sends
  only the first 5 characters of a hash, and only when you ask).
- An on-device password generator with a zxcvbn-style strength estimate
  (English, German, and Russian dictionaries; see `NOTICE.md`), optional
  site icons, and an interface in English, German, and Russian.

## Start

```sh
npm install
npm start
```

Electron is pinned to version 45.0.0. Keep Electron and its bundled Chromium
security updates current.

## Checks

```sh
npm run check            # ESLint, TypeScript checks of the JSDoc types, unit tests
npm run test:e2e         # drives the real app with Playwright (needs Electron's binary)
npm run test:durability  # kills vault operations at every file change (several minutes)
```

`npm test` runs a sample of the durability test: a save and a copy outside
this Mac, killed at every fourth step. The full run kills every operation
that writes (saves, attachments, a passphrase change, import, restores,
snapshot rotation, copies outside) at every step and checks that the vault,
its snapshots, and the next launch are intact.

The app has no runtime dependencies; ESLint, TypeScript, and
`playwright-core` are development tools only and are not packaged. Types are
written as JSDoc in the `.js` files, so what `tsc` checks is exactly what
ships. The end-to-end tests start the app from this checkout with a fresh
data folder and update checks turned off.

For a change that should not alter how the app looks (moving CSS, for
example), capture the main screens in both themes before and after it and
compare them pixel by pixel. Rendering can differ by a pixel between runs,
so capture each side a few times; a screen passes when some "after" image
equals some "before" image:

```sh
node e2e/capture-screens.js /tmp/before-1   # old code; repeat for -2 and -3
node e2e/capture-screens.js /tmp/after-1    # new code; repeat for -2 and -3
node e2e/compare-screens.js /tmp/before-* -- /tmp/after-* --diff /tmp/diff
```

## Keeping data safe

Mnemo keeps several layers between a mistake or a broken disk and lost data
(details in [SECURITY.md](./SECURITY.md)):

- **Writes** go to a temporary file that is flushed to the disk
  (`F_FULLFSYNC`) before it replaces the vault in one rename, so a power cut
  leaves the old file or the new one.
- **Snapshots on this Mac** (Settings → Backups): after changes, a copy of
  the encrypted vault is kept and verified (read back and decrypted, with
  every attachment). Kept: the last ten, one a day for 30 days, and one
  before every import, restore, format upgrade, or change of keys, for 90
  days.
- **A copy outside this Mac:** choose a folder in iCloud Drive or on an
  external disk; snapshots are copied there, still encrypted, and read back
  after each copy. The vault screen reminds you after 14 days without a
  checked copy.
- **Restore** a snapshot from Settings → Backups, from the unlock screen when
  the vault file is damaged, or, on another Mac, as a new vault from the
  folder of copies. A snapshot opens with the master passphrase or recovery
  key that was valid when it was taken.
- **An older copy is noticed:** the vault counts its saves, and Mnemo
  remembers the newest one it has seen on this Mac. If the vault file is
  replaced by an older copy (a sync tool, a restored file, someone with
  access to your files), Mnemo asks before opening it; restoring an older
  backup of the same vault asks too.
- **Check the recovery key and passphrase** in Settings → Security without
  changing anything; the vault screen asks you to check the key every 90
  days. If both are lost, nobody, including Mnemo, can open the vault.
- **Leave at any time:** export without encryption in Bitwarden's format,
  which most password managers import.

## Release builds

`npm run dist:mac` produces signed, notarized `.dmg` and `.zip` builds with
hardened Electron fuses and asar integrity checks. It needs a Developer ID
certificate and App Store Connect API key; see `docs/RELEASING.md`.
`npm run dist:mac:local` builds exactly what the release workflow publishes
(ad-hoc signed, hardened runtime, `.dmg` and `.zip`) in `release/`;
`npm run pack:mac:local` makes an unpacked debug build without the hardened
runtime. Each of them first builds the Touch ID helper
(`native/touch-id/main.swift`, needs Xcode's command line tools);
`npm run build:touch-id` builds it alone, so `npm start` uses it too. The
app icon is drawn in `build/icon.svg`; `npm run icon`
regenerates `build/icon.png` and `build/icon.icns` from it.

Pushing a version tag (such as `v0.2.5`) runs `.github/workflows/release.yml`, which
tests, builds ad-hoc-signed `.dmg` and `.zip` files with the hardened
runtime, signs an update manifest with the project's Ed25519 key, and
publishes a GitHub release. Installed
copies find it through the in-app updater; see `docs/RELEASING.md`.

## Renderer architecture

The renderer is organized by Feature-Sliced Design layers under
`src/renderer/`:

- `app/` creates the application context and global navigation.
- `pages/` assembles the access and vault screens.
- `widgets/` composes larger screen areas such as the vault browser.
- `features/` holds user actions such as vault access, login editing, backup,
  password generation, and copy/delete/icon operations.
- `entities/` contains profile and login models and their UI rendering.
- `shared/` contains cross-cutting DOM, password-visibility, and password-tool
  utilities.

Dependencies flow down from `app` to `pages`, `widgets` and `features`, then
`entities` and `shared`. `index.html` stays at the project root as Electron's
document entry point. Every slice is a native ES module; there is no bundler.
`index.html` loads one module script, `src/renderer/app/index.js`, whose
imports pull in the rest, so what ships is exactly the source.
`src/renderer/shared/lib/theme.js` is the only classic script: it runs in
`<head>` to pick the light or dark palette before the first paint. Styles
live next to the slices that use them (`*.css` under `src/renderer/`); the
root `styles.css` only `@import`s them, and its order is the cascade order.
The renderer has no Node.js access; sensitive
operations still go through the narrow `vaultApp` preload API. `main.js` and
`preload.js` remain outside the renderer feature layers because they belong to
separate Electron processes.

The main process lives in `src/main/`. `main.js` is its entry point: it pins
the data folder, creates the shared `state` object and a `ctx` with the
helpers from `src/main/` (dialogs, clipboard, lock, window, menu bar,
updates), and
registers the IPC handlers from `src/main/ipc/`, one file per feature. The
other main-process modules (updater, importers, Touch ID, profiles, settings,
backup files, favicons, TOTP, SSH keys, password reports) sit next to them in
`src/main/`; only `main.js`, `preload.js`, and `vault-store.js` stay at the
root. The
vault store is in `src/main/vault/`: `store.js` holds the file lifecycle, the
`store-*.js` files add feature methods, and the other files hold the file
format, crypto, and validation; `vault-store.js` only re-exports it.
`src/shared/` holds ES modules that both processes load: the page imports
them, and the main process loads them with `require()` (its `package.json`
marks the folder as ES modules). They are the UI text catalog and translator
(`i18n/`), the item type schema, the payment card rules, and
`password-tools.js`, the password strength estimate that the renderer shows
and the main process enforces for new master passphrases.

## Current security boundary

- The renderer loads only the packaged local HTML, CSS, and JavaScript.
- Renderer Node.js integration is disabled; context isolation and sandboxing
  are enabled.
- The preload exposes narrow, purpose-specific methods; it does not expose
  arbitrary IPC or filesystem access to the renderer.
- IPC requests are accepted only from the app's main frame.
- Renderer-originated remote HTTP(S) and WebSocket requests are blocked;
  renderer `connect-src` is also set to `none`. The main process makes three
  kinds of requests: the explicit site-icon request described below, the
  breach check in Reports (only when you click it; it sends the first 5
  characters of each password's SHA-1 hash to Have I Been Pwned), and the
  update check against this project's GitHub releases (on demand and on a
  schedule chosen in Settings → General: every 30 minutes, hour, 6 hours, or
  day, or never; daily by default).
- Each profile has its own vault under Electron's per-user application data
  directory. The existing `vault.json` is retained as the “Local Vault” profile.
- Profile names are stored locally in `profiles.json` in plain text; vault
  contents remain encrypted.
- The master passphrase is not stored; scrypt derives a wrapping key for a
  randomly generated vault key, and AES-256-GCM encrypts the vault contents.
  A new master passphrase must be at least 12 characters and rated Strong
  by the built-in estimate (shown while typing); a phrase of several
  unrelated words works well. Vaults created earlier with a shorter
  passphrase still open.
- Login data is encrypted before it is written to disk. While the vault is
  unlocked, the main process holds the decrypted vault index; each password
  stays sealed until it is copied or shown. The renderer receives entry
  metadata only and never receives passwords.
- Copied usernames and passwords are cleared from the system clipboard after
  30 seconds if its plain-text contents still match the copied value. If
  another app replaces that text, the app leaves the new clipboard contents
  alone.
- Backup files, snapshots, and copies outside this Mac contain the same
  encrypted vault envelope, not plaintext, plus the encrypted attachment
  files. Each opens with the master passphrase or recovery key that was valid
  when it was made; without either, the data cannot be recovered.
- Items can be sorted into folders and favorites. Deleted items wait in the
  trash for 30 days. Each item keeps its last 20 versions, including earlier
  passwords, which can be restored. Attachments are encrypted files stored
  next to the vault.
- The vault locks after five minutes without keyboard or pointer activity, when
  the Mac locks or sleeps, when the app window closes, or when the app exits.
- This prototype has no telemetry or crash-reporting SDK. Site icons are only
  requested after you choose **Load site icon** for a login. The app contacts
  that login's HTTPS domain directly at `/favicon.ico` first. If unavailable or small,
  it may read the homepage and try up to five PNG or ICO icon links on the
  same domain. PNG-backed ICO files and uncompressed 24/32-bit ICO images are
  supported; JPEG and SVG icons are skipped. Images are decoded in a separate
  process, not in the app's main process.
  It prefers larger variants, keeps their aspect ratio, and does not enlarge a
  small source image before saving it.
  It follows only HTTPS redirects to the same host or its `www` variant,
  up to three redirects. The site can see your IP address and those requests,
  and your DNS resolver can observe the domain. No third-party favicon service
  is used. The downloaded icon is resized, stored inside the encrypted vault,
  and is not fetched again unless you choose to update it.

See [SECURITY.md](./SECURITY.md) before using the prototype with real
credentials or adding network access.

## Not there yet

Browser autofill, sync between Macs, passkeys, sharing, and apps for other
systems do not exist yet; sync and anything that adds network access will
get a design document first. Builds from GitHub are ad-hoc signed, not
notarized. The password strength display is an estimate of known attack
strategies, not a security guarantee. Do not use this prototype for real
passwords.
