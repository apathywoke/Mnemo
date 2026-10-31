# Mnemo security notes

## Status

This is a prototype. It has had an internal review and has a written threat
model (`docs/THREAT_MODEL.md`), but no independent third-party audit. It supports encrypted login entries, search,
editing, deletion, encrypted backup, and restore. Do not use it for real
passwords until the design has received independent security review.

## Initial design commitments

- No analytics, telemetry, crash reporting, account, or sync backend. The
  only background network activity is the update check described below,
  which can be turned off.
- UI code runs in a sandboxed renderer without Node.js integration.
- Electron capabilities are exposed through a small, typed preload API.
- Secrets must not be written to logs, console output, diagnostics, or crash
  reports.
- The master passphrase is not persisted. Node's asynchronous scrypt derives a
  wrapping key using a fresh 16-byte salt and parameters N=2^17, r=8, p=1.
- A master passphrase that is being set (a new vault, recovery with the
  recovery key, restoring a backup with the recovery key) must be at least
  12 characters (counted in code points) and rated Strong by
  `estimatePasswordStrength` (`src/renderer/shared/lib/password-tools.js`),
  checked in the main process; the forms show the same estimate while
  typing. The estimate counts letters and digits of any script, so a long
  phrase in Cyrillic rates like one in Latin letters. It is a heuristic,
  not a measure of entropy: it knows a few common words and keyboard runs
  but no dictionary. Existing vaults with a passphrase of 7 or more
  characters keep opening; the stricter rule applies only when a passphrase
  is set.
- A random 256-bit vault key is wrapped with AES-256-GCM; vault data is
  separately encrypted with AES-256-GCM and authenticated metadata.
- Login records have bounded fields and are validated before entering the
  encrypted vault. Search runs locally over names, usernames, and website URLs.
- Each profile has an independent encrypted vault file and master passphrase.
  Profile names and IDs are stored in a local, permission-restricted registry
  in plain text; profile names are not secret vault data.
- The interface language is stored in `settings.json` in the same folder
  (plain text, `0600`). It holds no vault data.
- The renderer receives only entry metadata (name, username, website, icon,
  timestamps). Notes are fetched for the selected entry. Passwords never cross
  IPC: the main process decrypts one password when the user copies it, or
  shows it in a native dialog owned by the main process. Editing a login
  leaves the password field empty, and an empty field keeps the stored value.
- Inside the encrypted vault data (schema 2), each password is sealed again
  with AES-256-GCM under the vault key, with the entry ID as associated data,
  so unlocking does not decrypt every password. Schema 1 vaults and backups are
  upgraded in memory on unlock and written as schema 2 on the next save.
- Keys and entry data are cleared from managed buffers and UI fields on lock
  where possible, but JavaScript strings and objects cannot be reliably
  zeroized.
- Copying a username or password writes it to the system clipboard and clears
  it after 30 seconds if its plain-text contents still match the copied value.
  If another app replaces that text, the app leaves the new clipboard contents
  alone. Locking the vault queues the same best-effort cleanup. Other clipboard
  managers or macOS Universal Clipboard may retain or sync copied text outside
  this app's control; the app cannot guarantee its removal from those services.
- The encrypted file is versioned and written to a temporary file before being
  renamed into place with restrictive file permissions. The prototype supports
  one running app instance.
- Exported `.vault` files contain the encrypted envelope as-is; no plaintext is
  written to the backup. A backup uses the same master passphrase as the local
  vault. Restore verifies the file and passphrase before replacing the local
  vault, and asks for confirmation first when a local vault already exists.
  When the vault has attachments, the backup is a container (`MNEMOBK1`) with
  the envelope and the attachment files exactly as they are stored, still
  encrypted (see `src/main/backup-file.js`). Export decrypts every attachment once
  first and refuses, naming the file, if one is missing or damaged. Restore
  checks that every attachment the vault refers to is present and decrypts;
  only then does it copy the files and replace the vault file in one rename.
  A damaged or truncated backup leaves the current vault and its files as
  they were.
- The in-memory vault locks after five minutes without keyboard or pointer
  activity, when macOS reports screen lock or suspend, when the window closes,
  and when the app exits.
- Site icons require an explicit click on **Load site icon**. The main process
  first requests the saved domain's `/favicon.ico` endpoint. If that is missing or small,
  it reads the homepage and tries at most five PNG or ICO icon links hosted
  on that same domain. PNG files, PNG-backed ICO files, and uncompressed
  24/32-bit ICO images are supported; JPEG, SVG, and other formats are
  skipped.
  Requests carry no cookies or referrer and use no
  third-party favicon service. HTTPS redirects are followed only to the same
  host or its `www` variant, with a three-redirect limit. The site can see the
  device's IP address, and the domain may be visible to the configured DNS
  resolver. Only public HTTPS hosts are allowed; the app resolves and pins a
  public IPv4 address and limits response size. Each downloaded image is
  decoded outside the main process, in a new Electron `utilityProcess`, by
  plain JavaScript PNG and ICO decoders rather than native image codecs. That
  process gets only a copy of the image bytes and an environment without the
  app's variables, checks dimensions before decoding, caps decompressed data
  near the size the image header declares, and is killed after its reply or
  after five seconds. It returns only the icon's pixels: the main process
  checks that they match the expected icon size and encodes the PNG itself.
  A decoder crash or timeout ends that fetch with an error and does not
  affect the app. The decoder process is not in Chromium's sandbox. The app
  prefers higher-resolution variants without enlarging small icons, preserves
  aspect ratio, and saves the icon within the encrypted vault. These requests
  are not repeated unless the user explicitly loads or updates the icon.
- Packaged builds have Electron fuses set: `RunAsNode`,
  `EnableNodeCliInspectArguments`, and `EnableNodeOptionsEnvironmentVariable`
  are off; `OnlyLoadAppFromAsar` and embedded asar integrity validation are on.
  Packaged builds refuse to start with Chromium remote-debugging switches.
  `npm run dist:mac` signs with a Developer ID certificate and the hardened
  runtime and notarizes. Releases published on GitHub are currently
  **ad-hoc signed with the hardened runtime** (no Developer ID, no
  notarization): the app ignores `DYLD_*` environment variables and refuses
  debuggers, but macOS asks the user to allow the first launch, and the
  signature proves only that the bundle is intact, not who made it. Because
  an ad-hoc signature has no Team ID, these builds also carry
  `disable-library-validation`; without it they cannot load their own
  Electron framework. See `docs/RELEASING.md`.
- Updates come from this project's GitHub releases. About 20 seconds after
  launch and then on the schedule chosen in Settings → Updates (every 30
  minutes, hour, 6 hours, or day; daily by default; or never), and when the
  user clicks **Check for updates**, the main process asks `api.github.com`
  for the latest release. The schedule counts from the last check by the
  clock, so time asleep counts. GitHub sees the device's IP address and the
  app version in the User-Agent; nothing else is sent.
- Every release carries `update-manifest.json` and an Ed25519 signature over
  its exact bytes. The app trusts only the public keys bundled in it
  (`build/update-keys/*.pem`); a manifest that does not verify is ignored.
  The manifest gives the version and each archive's size and SHA-512. The app
  never installs an older or equal version, requires the release tag to
  match the signed version, downloads over HTTPS from GitHub's release hosts
  only (redirects included), and caps sizes and time. The downloaded archive
  must match the signed hash; after unpacking, the app must carry Mnemo's
  bundle ID, the signed version, and a valid code signature. Nothing is
  installed without the user clicking **Restart now**; the vault is locked
  first. The old app is swapped out with renames on the same volume and put
  back if the swap fails.
- The private update key is held only in the GitHub Actions environment
  `release`, used by a job that installs no npm packages. Whoever holds it can
  ship code to every installed copy that auto-updates.
- Every new vault gets a recovery key: 256 random bits shown once as 14
  groups of Crockford Base32 with a 24-bit checksum. The vault key is wrapped
  a second time under a key derived from it with HKDF-SHA256 and a separate
  salt (file format 2). The recovery salt is part of the authenticated header,
  so removing or swapping the recovery wrap makes the file fail to open.
  Recovering access requires the key and a new master passphrase; a new
  recovery key is issued at the same time, and the old one stops opening the
  current file. Older backups still open with the passphrase or recovery key
  that was valid when they were made. Creating a new key from Settings needs
  the current master passphrase. Vaults in format 1 keep working and get a
  key when the user creates one.
- The master passphrase can be changed in Settings with the current one;
  the new one must meet the same rule as for a new vault.
- Every change of credentials — a new passphrase, a new recovery key,
  recovery with the recovery key, restoring a backup with the recovery key —
  replaces the vault key itself, not only its wrapping. Every sealed value
  (passwords, one-time code settings, secret fields, including those in the
  history) is sealed again under the new key with the same associated data;
  each distinct sealed record once, so values that were the same stay the
  same and the history shows no changes that did not happen. Attachments
  are encrypted again under new file keys and new IDs, one file at a time.
  New files are written first, the vault file is replaced in one rename, and
  the old files are deleted afterwards; if anything fails before the rename,
  the new files are removed and the old vault keeps working. A new recovery
  key is issued and the Touch ID key file is removed, since it holds the old
  vault key. Someone who once obtained the old vault key (an old recovery
  key with an old copy of the file, or the Touch ID file with Keychain
  access) cannot read anything saved afterwards. Old backups and copies of
  the file are not changed and still open with the credentials they had.
  Restoring a backup with its passphrase keeps the backup's key.
- The recovery key is shown in the app window once and can be copied (cleared
  from the clipboard after 30 seconds) or saved as a text file with mode
  `0600`. Anyone who holds it can open the vault; it is a second secret of the
  same strength as the vault key, not a weaker one.
- A backup can be restored with its master passphrase, or with the recovery
  key that was valid when it was made. With the recovery key, the restored
  vault is re-encrypted under a new master passphrase and gets a new recovery
  key; the backup file itself is not changed.
- Backups are exported from Settings after the master passphrase is entered
  again, or right after a recovery key is issued (when the passphrase was
  just entered). The new-key dialog offers that backup, because a recovery
  key alone cannot restore a vault whose file was deleted.
- Import from Bitwarden (unencrypted JSON or CSV), 1Password (1PUX or CSV),
  and other Mnemo backups adds logins to the open vault. Import files are
  opened and parsed only in the main process; the renderer receives counts,
  never file contents. Parsing is size-limited, including the decompressed
  size of 1PUX archives. Non-login items, archived items, and two-factor
  secrets are skipped and reported. After importing a plain-text export, the
  app offers to move it to the Trash; it cannot securely erase it.
- Deleting the open vault from Settings requires the master passphrase and a
  native confirmation dialog in the main process.
- Besides logins, the vault holds cards, secure notes, identities, and SSH
  keys. Their secret fields (card number, security code, PIN, document
  number, SSH private key and its passphrase) are sealed one by one with
  AES-256-GCM under the vault key, bound to the item ID and the field name,
  and never sent to the renderer: they are copied or shown in a native
  dialog by the main process. Other fields (cardholder, expiry, the last four
  card digits, identity details, public keys, and the text of secure notes)
  are protected by the vault encryption and shown in the interface like
  login notes. SSH fingerprints are computed from the public key, which is
  derived from OpenSSH and unencrypted PEM private keys when not provided.
- **Reports** (Vault → Reports) list breached, reused, and weak login
  passwords. The main process reads each password once per report to
  compute a strength estimate, a keyed HMAC-SHA-256 fingerprint (the key is
  random per unlock and erased on lock), and a SHA-1 hash; the strings are
  then dropped. The renderer receives entry IDs and counts only. Reuse and
  strength are computed locally. The breach check runs only when the user
  clicks it: for each distinct password, the first 5 hex characters of its
  SHA-1 go to `api.pwnedpasswords.com/range/` (Have I Been Pwned's
  k-anonymity API, with `Add-Padding` so response sizes reveal nothing), and
  the full hash is compared locally. HTTPS to that host only, no redirects,
  1 MiB and 15 s limits per response. Have I Been Pwned sees the device's IP
  address and the prefixes; each prefix matches hundreds of unrelated
  hashes. Results stay in memory, keyed by fingerprint, until the vault
  locks; a changed password shows as not yet checked.
- One-time codes (TOTP, RFC 6238) are stored per login like passwords:
  sealed with AES-256-GCM under the vault key, bound to the entry ID with a
  separate purpose label. The secret never reaches the renderer; the main
  process returns only the current code and its expiry. Fetching codes does
  not count as activity, so an open code does not delay auto-lock. Keeping
  passwords and second factors in one vault means a single compromised vault
  exposes both; users who want them separate can keep codes elsewhere.
- Touch ID unlock is opt-in per vault and needs the master passphrase plus a
  successful Touch ID check to turn on. The vault key is then encrypted with
  Electron `safeStorage`, whose key lives in the macOS login Keychain under
  the app's signature, and stored in `biometric/<profile>.key` (`0600`). It
  is released only in the main process after `promptTouchID` succeeds. This
  is a convenience trade-off: Touch ID is enforced by the app rather than by
  the Keychain item, and someone who can unlock your macOS login keychain
  (for example, with your Mac login password) could recover the vault key
  without the master passphrase. Restoring a backup into the vault, deleting
  the vault, or any change of credentials (which replaces the vault key)
  removes the stored key.
- Items can be organized in folders (one per item) and marked as favorites.
  Both are stored inside the encrypted vault data; changing them does not
  change an item's date or history.
- Deleting an item moves it to the trash, unchanged and restorable, with its
  history and attachments. Items are removed for good after 30 days (checked
  when the vault opens) or when the user deletes them forever or empties the
  trash; both ask for confirmation in a native dialog in the main process.
  Items in the trash cannot be edited and are left out of reports.
- Each item keeps its last 20 earlier versions. Sealed values (passwords,
  one-time code settings, secret fields) are kept sealed as they were, bound
  to the same item, and are copied or shown only by the main process. Saving
  without a change adds no version; restoring a version keeps the replaced
  content as the newest version. If the vault would grow past its size
  limit, the oldest versions are dropped first. Old passwords stay in the
  history until they are pushed out or the item is deleted for good.
- Attachments (up to 50 MB each, 20 per item, 1 GB per vault) are stored as
  separate files in `<vault>.attachments/` (folder `0700`, files `0600`).
  Each file is encrypted with AES-256-GCM under its own random key, with the
  attachment ID as associated data; that key is sealed under the vault key,
  bound to the item and attachment IDs, inside the encrypted vault data. A
  file alone reveals only its size. Files are picked and saved through
  native dialogs in the main process; contents and paths never reach the
  renderer. A new file is written before the vault refers to it, and a
  deleted one is removed after the vault stops referring to it, so the vault
  never points at a missing file; files left by an interruption are removed
  when the vault opens. Saving an attachment writes a plain copy where the
  user chooses; that copy is outside Mnemo's protection.
- Deleting a profile unlinks its encrypted vault file and removes its
  attachment folder. It does not guarantee secure erasure from APFS
  snapshots, Time Machine backups, SSD remapping, or other copies of those
  files.

## Before storing real credentials

The threat model is in `docs/THREAT_MODEL.md`, including the residual risks
and open findings from the internal review. Obtain an independent third-party
security review before treating this as a real password manager. Changes that add network access must document every
connection and must not add telemetry by default.

## Reporting a vulnerability

Report security issues privately through GitHub:
<https://github.com/apathywoke/Mnemo/security/advisories/new>. Please do not
open a public issue, pull request, or discussion with details of a
vulnerability.

Only the latest release is supported; check whether the issue still exists
there before reporting.

What counts as in scope is described in `docs/THREAT_MODEL.md`: the assets,
trust boundaries, and adversaries it lists. Issues it names as out of scope
or as known residual risks are still welcome as reports, but may be handled
as improvements rather than vulnerabilities.

Reports are read and answered, but there is no promised response time; this
is a small project maintained in spare time.
