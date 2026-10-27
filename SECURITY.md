# Mnemo security notes

## Status

This is a prototype. It has had an internal review and has a written threat
model (`docs/THREAT_MODEL.md`), but no independent third-party audit. It supports encrypted login entries, search,
editing, deletion, encrypted backup, and restore. Do not use it for real
passwords until the design has received independent security review.

## Initial design commitments

- No analytics, telemetry, crash reporting, account, sync backend, or
  background network activity.
- UI code runs in a sandboxed renderer without Node.js integration.
- Electron capabilities are exposed through a small, typed preload API.
- Secrets must not be written to logs, console output, diagnostics, or crash
  reports.
- The master passphrase is not persisted. Node's asynchronous scrypt derives a
  wrapping key using a fresh 16-byte salt and parameters N=2^17, r=8, p=1.
- The UI accepts master passphrases of at least 7 characters. This is only a
  minimum input limit, not a recommended secure length; use a longer, unique
  passphrase because short or common phrases are easier to guess offline.
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
- The in-memory vault locks after five minutes without keyboard or pointer
  activity, when macOS reports screen lock or suspend, when the window closes,
  and when the app exits.
- Site icons require an explicit click on **Load site icon**. The main process
  first requests the saved domain's `/favicon.ico` endpoint. If that is missing or small,
  it reads the homepage and tries at most five PNG, JPEG, or ICO icon links hosted
  on that same domain. PNG-backed ICO files and uncompressed 24/32-bit ICO images
  are supported.
  Requests carry no cookies or referrer and use no
  third-party favicon service. HTTPS redirects are followed only to the same
  host or its `www` variant, with a three-redirect limit. The site can see the
  device's IP address, and the domain may be visible to the configured DNS
  resolver. Only public HTTPS hosts are allowed; the app resolves and pins a
  public IPv4 address, limits response size, checks image dimensions before
  decoding, prefers higher-resolution variants without enlarging small icons,
  preserves aspect ratio, converts the result to PNG, and saves it within the
  encrypted vault. These requests are not repeated unless the user explicitly
  loads or updates the icon.
- Release builds are signed with a Developer ID certificate and the hardened
  runtime, notarized, and have Electron fuses set: `RunAsNode`,
  `EnableNodeCliInspectArguments`, and `EnableNodeOptionsEnvironmentVariable`
  are off; `OnlyLoadAppFromAsar` and embedded asar integrity validation are on.
  Packaged builds refuse to start with Chromium remote-debugging switches. See
  `docs/RELEASING.md`.
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
- Deleting a profile unlinks its encrypted vault file. It does not guarantee
  secure erasure from APFS snapshots, Time Machine backups, SSD remapping, or
  other copies of that file.

## Before storing real credentials

The threat model is in `docs/THREAT_MODEL.md`, including the residual risks
and open findings from the internal review. Obtain an independent third-party
security review before treating this as a real password manager. Changes that add network access must document every
connection and must not add telemetry by default.

## Reporting a vulnerability

Before making this repository public, configure a private reporting route (for
example, GitHub private vulnerability reporting) and link it here. Until then,
report security issues to the project maintainer privately rather than opening
a public issue with exploit details.
