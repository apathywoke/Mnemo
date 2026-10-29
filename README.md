# Mnemo

A macOS-first Electron prototype for the local-first password manager Mnemo. It can
create, unlock, and back up an encrypted vault, and manage login entries with
search, edit, delete, and copy actions. It also includes an on-device password
generator with a heuristic strength estimate and optional, user-requested site
icons. Multiple named vault profiles can be created, selected, and restored
independently. It has not had an independent security review.

## Start

```sh
npm install
npm start
```

Electron is pinned to version 45.0.0. Keep Electron and its bundled Chromium
security updates current.

## Release builds

`npm run dist:mac` produces signed, notarized `.dmg` and `.zip` builds with
hardened Electron fuses and asar integrity checks. It needs a Developer ID
certificate and App Store Connect API key; see `docs/RELEASING.md`.
`npm run dist:mac:local` builds exactly what the release workflow publishes
(ad-hoc signed, hardened runtime, `.dmg` and `.zip`) in `release/`;
`npm run pack:mac:local` makes an unpacked debug build without the hardened
runtime. The app icon is drawn in `build/icon.svg`; `npm run icon`
regenerates `build/icon.png` and `build/icon.icns` from it.

Pushing a version tag (`v0.2.0`) runs `.github/workflows/release.yml`, which
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
document entry point. Because this renderer has no bundler, its local slices
register their APIs under an internal `window.mnemoRenderer` namespace and are
loaded in dependency order there. The renderer has no Node.js access; sensitive
operations still go through the narrow `vaultApp` preload API. `main.js` and
`preload.js` remain outside the renderer feature layers because they belong to
separate Electron processes.

The main process lives in `src/main/`. `main.js` is its entry point: it pins
the data folder, creates the shared `state` object and a `ctx` with the
helpers from `src/main/` (dialogs, clipboard, lock, window, updates), and
registers the IPC handlers from `src/main/ipc/`, one file per feature. The
other main-process modules (updater, importers, Touch ID, profiles, settings,
backup files, favicons, TOTP, SSH keys, password reports) sit next to them in
`src/main/`; only `main.js`, `preload.js`, and `vault-store.js` stay at the
root. The
vault store is in `src/main/vault/`: `store.js` holds the file lifecycle, the
`store-*.js` files add feature methods, and the other files hold the file
format, crypto, and validation; `vault-store.js` only re-exports it.

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
  schedule chosen in Settings → Updates: every 30 minutes, hour, 6 hours, or
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
- Backup files contain the same encrypted vault envelope, not plaintext, plus
  the encrypted attachment files when there are any. They require the same
  master passphrase; forgetting it means the data cannot be recovered.
- Items can be sorted into folders and favorites. Deleted items wait in the
  trash for 30 days. Each item keeps its last 20 versions, including earlier
  passwords, which can be restored. Attachments are encrypted files stored
  next to the vault.
- The vault locks after five minutes without keyboard or pointer activity, when
  the Mac locks or sleeps, when the app window closes, or when the app exits.
- This prototype has no telemetry or crash-reporting SDK. Site icons are only
  requested after you choose **Load site icon** for a login. The app contacts
  that login's HTTPS domain directly at `/favicon.ico` first. If unavailable or small,
  it may read the homepage and try up to five PNG, JPEG, or ICO icon links on the
  same domain. PNG-backed ICO files and uncompressed 24/32-bit ICO images are supported.
  It prefers larger variants, keeps their aspect ratio, and does not enlarge a
  small source image before saving it.
  It follows only HTTPS redirects to the same host or its `www` variant,
  up to three redirects. The site can see your IP address and those requests,
  and your DNS resolver can observe the domain. No third-party favicon service
  is used. The downloaded icon is resized, stored inside the encrypted vault,
  and is not fetched again unless you choose to update it.

See [SECURITY.md](./SECURITY.md) before using the prototype with real
credentials or adding network access.

## Not decided yet

Other item types, authenticator, browser integration, and any future sync
protocol still need design. The password strength display is a rough heuristic,
not a security guarantee. Do not use this prototype for real passwords.
