# Mnemo threat model

Status: draft for the prototype, written alongside the Electron hardening
work (fuses, metadata-only renderer, signing and notarization). Review it
again whenever a trigger at the end of this document applies. Updated
2026-10-28 for in-app updates (B6, A8) and 2026-10-31 for the favicon
decoder process (B7, A2).

## 1. What Mnemo protects

| Asset | Where it lives | Notes |
| --- | --- | --- |
| Card numbers, security codes, PINs, document numbers, SSH private keys | Vault file (encrypted, then sealed per item and field); main-process memory while unlocked; clipboard after a copy | Same protection as passwords; never sent to the renderer. Secure note text and identity details are not sealed separately and reach the renderer when the item is opened. |
| One-time code (TOTP) secrets | Vault file (encrypted, then sealed per entry); main-process memory while unlocked | Same protection as passwords; only current codes reach the renderer. |
| Entry passwords | Vault file (encrypted, then sealed per entry); main-process memory while unlocked; clipboard for up to 30 s after a copy | Highest value. |
| Other entry fields: name, username, website, notes, site icon | Vault file (encrypted); main-process memory while unlocked; renderer memory and DOM for the visible list or selected entry | Usernames and websites reveal which accounts exist. |
| Master passphrase | Typed into the renderer, sent once over IPC, then dropped | Never stored. |
| Recovery key (256-bit) | Shown once in the renderer; kept in main memory until the user confirms it is saved; optionally in a user-saved text file; on paper | Opens the vault and resets the passphrase. |
| Vault data key (256-bit) | Wrapped in the vault file; main-process `Buffer` while unlocked, zeroed on lock; if Touch ID is on, also in `biometric/<profile>.key`, encrypted with a Keychain-held key | Unwraps everything. |
| Attachments | `<vault>.attachments/<id>.bin`, each encrypted under its own key sealed inside the vault data; main-process memory while being added, saved, or verified; a plain copy wherever the user saves one | A file alone reveals only its size. |
| Earlier versions (history) | Inside the encrypted vault data, sealed values kept sealed | Old passwords remain until 20 newer versions push them out or the item is deleted for good. |
| Encrypted backups (`.vault`) | Wherever the user saves them | Same envelope and passphrase as the local vault; with attachments, a container that also holds the encrypted attachment files. |
| Profile registry (`profiles.json`) | Application support folder, `0600` | Profile names in plain text, not secret by design. |
| Integrity of the shipped app | `Mnemo.app` in `/Applications`; ad-hoc signed when installed from GitHub releases | A modified app can steal everything the user types. |
| Update signing key (Ed25519 private key) | GitHub Actions secret in the `release` environment; nowhere else | Whoever holds it can install code on every copy that accepts updates. The matching public keys ship in `build/update-keys/`. |

## 2. System and trust boundaries

```
 ┌──────────────────────── macOS user account ─────────────────────────┐
 │                                                                     │
 │  Renderer (sandboxed Chromium, contextIsolation, CSP, no Node)       │
 │    sees: entry metadata, the selected entry's notes, passphrase     │
 │          while it is typed                                          │
 │    ── preload `vaultApp` (fixed method list, contextBridge) ──      │  B1
 │  Main process (Node.js, trusted)                                    │
 │    holds: data key, decrypted vault index, sealed passwords         │
 │    ── fs (0700 dir / 0600 files) ──── vault files, profiles.json    │  B2
 │    ── clipboard ───────────────────── other apps, Universal Clip.   │  B3
 │    ── HTTPS (user-initiated only) ─── favicon; HIBP password ranges │  B4
 │    ── HTTPS (scheduled, can be off) ─ GitHub releases (updates)     │  B6
 │    ── native dialogs ──────────────── reveal password, file pickers │
 │    ── utilityProcess (per image) ── favicon decoder, bytes → pixels │  B7
 └─────────────────────────────────────────────────────────────────────┘
   B5: GitHub Actions build → ad-hoc signature, hardened runtime → GitHub release → user's Mac
       (or: build machine → Developer ID signature → notarization)
```

- **B1, renderer → main.** The renderer is treated as compromisable (for
  example by a future XSS bug or a malicious vault value). Every IPC handler
  checks that the sender is the app's own main frame loaded from
  `app://mnemo/index.html`, and validates its arguments. The renderer cannot
  ask for a password in plain text: copy and reveal are performed by the main
  process.
- **B2, main → disk.** Everything secret is encrypted before it is written.
  Writes are atomic (temp file plus rename) with restrictive permissions.
- **B3, main → clipboard.** Leaves the app's control once written.
- **B4, main → network.** Only the explicit "Load site icon" action, the
  breach check in Reports (5-character SHA-1 prefixes to Have I Been Pwned,
  on click), and the update check (B6). Renderer network access is blocked by CSP and by
  `webRequest`.
- **B5, supply chain.** Fuses and asar integrity make tampering with app code
  inside an installed copy detectable by Electron. Every published build has
  the hardened runtime. A Developer ID build adds library validation,
  notarization, and Gatekeeper; the ad-hoc builds published on GitHub do not
  identify their author to macOS and run without library validation.
- **B6, main → GitHub releases.** The main process reads the latest release
  of `apathywoke/Mnemo`, its signed manifest, and the archive for this Mac.
  Trust rests on the Ed25519 signature checked against keys bundled in the
  running app, not on TLS or GitHub. The renderer only sees the version,
  release notes, and progress, and can only ask main to check, download,
  install, or open the release page.
- **B7, main → favicon decoder.** Every downloaded icon is decoded in a new
  `utilityProcess` running plain JavaScript PNG and ICO decoders. It gets an
  exact copy of the image bytes and an environment without main's
  variables, holds no vault data, and is killed after its reply or after 5
  seconds. Main treats its reply as untrusted: it accepts only RGBA pixels
  whose count matches the expected icon size and encodes the stored PNG
  itself. The process runs Node.js without Chromium's sandbox.

## 3. Assumptions

- macOS, the user account, and the kernel are not compromised while the vault
  is unlocked. Mnemo cannot defend against malware running as the same user
  with Accessibility, screen-recording, or debugger rights, or as root.
- The user picks a master passphrase that resists offline guessing. A new
  passphrase must be at least 12 characters and rated Strong by a simple
  heuristic; older vaults may still have a 7-character one.
- Apple's code-signing, notarization, and Gatekeeper checks work as designed.
- Electron 45 / Chromium are kept current; sandbox escapes are fixed upstream.

## 4. Adversaries

| ID | Adversary | Capability |
| --- | --- | --- |
| A1 | Offline attacker | Has a copy of a vault file or backup (stolen disk, cloud or Time Machine copy, lost USB stick). Unlimited offline compute. |
| A2 | Malicious or compromised website | Controls responses when the user loads that site's icon; may control DNS for its domain. |
| A3 | Attacker controlling renderer JavaScript | Arbitrary JS in the renderer via an XSS bug, a malicious value in an imported backup, or a Chromium renderer bug, without a sandbox escape. |
| A4 | Local process, same user, vault **locked** | Can read and write files in the user's home, launch the app with arbitrary arguments and environment, and modify files inside an app bundle the user can write to. |
| A5 | Local process, same user, vault **unlocked** | As A4, while the user is working in Mnemo. |
| A6 | Opportunistic physical or visual access | Unlocked, unattended Mac; shoulder surfing; screen sharing. |
| A7 | Distribution attacker | Modifies the app in transit or on a download mirror, or re-signs it. |
| A8 | Update channel attacker | Controls the network path, GitHub's responses, a GitHub release (through a stolen account or token), or the release workflow. |

## 5. Threats and mitigations

### A1, offline attacker

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Brute-force the recovery key | 256 random bits; the 24-bit checksum only detects typos and reveals nothing about the key | None known. |
| Use a vault key learned once (an old recovery key with an old copy of the file, or the Touch ID file with Keychain access) to read later versions | Every change of credentials replaces the vault key: all sealed values and attachments are encrypted again under new keys, and the Touch ID file is removed | Old backups and copies keep their old key and open with the credentials they had; rotation cannot reach them. Changing credentials is not automatic: the user has to do it after a suspected leak. |
| Strip or replace the recovery wrap to plant a key the attacker knows | The recovery salt is in the AES-GCM associated data of the key wraps and the vault data; a missing or different recovery wrap cannot unwrap the real vault key, and the strict format check rejects the file | An attacker with write access can delete the recovery wrap together with the file (denial of service only). |
| Brute-force the master passphrase from a vault or backup | scrypt N=2^17, r=8, p=1 with a 16-byte random salt per vault; random 256-bit data key wrapped with AES-256-GCM; a passphrase being set must be at least 12 characters and rated Strong by the built-in estimate, checked in main | The estimate is a heuristic without a dictionary, so a long but predictable phrase can pass. Vaults from before this rule may still have a 7-character passphrase until it is changed through recovery. |
| Tamper with a vault or backup to plant data or downgrade parameters | AES-GCM with the header (format, version, KDF parameters, salt) as AAD; strict schema and size validation before and after decryption; fixed KDF parameters | None known. |
| Swap sealed passwords between entries | Each password is sealed with the entry ID in its AAD; a swapped value fails authentication | None known. |
| Read, alter, or swap attachment files | Each file is AES-256-GCM under its own key with the attachment ID as AAD; the key is sealed with the item and attachment IDs inside the vault data. A changed or swapped file fails to decrypt and is reported by name; backups are verified before they are written and before a restore replaces anything | File sizes and counts are visible. Deleting files is possible (denial of service); the vault then reports them as missing. |
| Corrupt a backup to damage the vault it is restored into | The container must end exactly after its last file; every referenced attachment is decrypted before anything is written; the vault file is replaced last, in one rename | None known. |
| Recover deleted vaults | Not addressed: deletion unlinks the file | APFS snapshots, Time Machine, and SSD remapping may keep old encrypted copies. These remain protected by their passphrase. |

### A2, malicious website (favicon fetch)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| SSRF to the local network or loopback | Public HTTPS hosts only; DNS resolved and a public IPv4 address pinned; redirects only to the same host or its `www` variant, at most three | IPv6-only sites cannot provide icons. |
| Image-parser exploit or decompression bomb | Response size limit (512 KB). Images are decoded outside main, in a new `utilityProcess` per image (B7), by plain JavaScript PNG and ICO decoders: no native image codec parses website data, and JPEG and other formats are skipped. Dimensions are checked before decoding; inflated data is capped near the size the header declares; a hang is killed after 5 seconds, and a crash fails only that fetch. Main accepts only RGBA pixels of the expected icon size and encodes the PNG itself; the vault validates it again | The decoder process is not in Chromium's sandbox: an image that took it over would run with the user's rights (the vault files are encrypted, the key is not there). The decoders are memory-safe JavaScript, so this needs a bug in V8 or in Node's zlib. |
| Tracking | Requires an explicit click with a confirmation dialog; no cookies or referrer; no third-party favicon service | The site learns the user's IP address and that the icon was requested. |

### A3, compromised renderer

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Read all passwords in bulk | **New in this change.** The renderer receives metadata only (`listEntries`); passwords never cross IPC. `copyEntryField` writes to the clipboard from the main process; `revealPassword` shows a native dialog. The renderer cannot read the clipboard back: permission requests and permission checks are both denied, so `navigator.clipboard.readText()` fails and `document.execCommand("paste")` returns `false` (verified in the running app). | An attacker can still read usernames, websites, and the selected entry's notes, and can call `getEntry` for every ID to read all notes. It can trigger copies or reveal dialogs, which the user sees. |
| Write arbitrary clipboard contents (for example, a malicious command) | The old `copySecret(value)` API is removed; only an entry's username or password can be copied | None known. |
| Modify or delete entries, or export a backup | Entries can be changed through the preload API while unlocked. Exporting a backup and deleting the vault need the master passphrase again; deletion also needs a native confirmation; export, import, and restore always show a native file dialog | A compromised renderer can corrupt entries, and one that captured the passphrase at unlock can pass these checks. Keep backups. |
| Read a third-party export through import | Import files are chosen in a native dialog and parsed in main; only counts return to the renderer | Main parses untrusted JSON, CSV, and ZIP; sizes are capped, but parser bugs would run in the privileged process. |
| Read the master passphrase | Typed into the renderer by design | A compromised renderer during unlock sees the passphrase. |
| Read or mint a recovery key | The key is shown in the renderer once, by design. Creating a new key requires the current master passphrase in main | A compromised renderer during vault creation, recovery, or key creation sees the recovery key, which is equivalent to the passphrase it can already see. |
| Exfiltrate what it can read (metadata, notes, passphrase) | CSP `connect-src 'none'`; `webRequest` cancels HTTP(S) and WebSocket; WebRTC removed from the page, UDP restricted, and the session proxied to a closed port; DevTools disabled in packaged builds | DNS prefetch or other Chromium side channels not covered here. |
| Escape to Node.js or the filesystem | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; narrow preload; no `webview`; window opening and navigation denied; strict CSP (`script-src 'self'`, `connect-src 'none'`); remote requests cancelled | Depends on Chromium's sandbox. |
| Spoof IPC from another frame | Handlers accept only the main frame whose URL is `app://mnemo/index.html`; `file://` and other origins are refused | None known. |
| Read local files through the page's origin | The page is served from `app://mnemo/`, not `file://`; `GrantFileProtocolExtraPrivileges` is off; the `app://` handler serves only HTML, JavaScript, and CSS files inside the app folder and rejects traversal (percent-encoded `..`, backslashes, NUL) after normalizing the path and checking its prefix | In development (`npm start`) the app folder is the repository, so any `.html`, `.js`, or `.css` file in it, including `node_modules`, can be read by the page. Packaged builds serve only what is in `app.asar`. |
| Destroy data through trash, history, or attachments | Deleting moves items to the trash (restorable for 30 days); deleting for good, emptying the trash, and deleting an attachment need a native confirmation in main; restoring a version keeps the replaced content as a version | It can move items to the trash, change folders and favorites, and restore older versions without a click. |
| Read attachments or plant files | Files are chosen and saved only through native open and save dialogs in main; the renderer never sends a path and never receives contents | It can open those dialogs, which the user must still complete. |
| Use Reports to learn about passwords | Main returns entry IDs, breach counts, and weak/reused flags only; fingerprints use a per-unlock HMAC key and never leave main | The renderer learns which entries share a password, which are weak, and (after a check) which are breached. It can start a breach check without a click, which sends 5-character SHA-1 prefixes to Have I Been Pwned. |
| Learn passwords from the breach check (network observer or Have I Been Pwned) | Only the first 5 hex characters of each SHA-1 are sent, over HTTPS, with padded responses; matching is local | The prefixes and the number of distinct passwords are visible to Have I Been Pwned. A prefix narrows a password's SHA-1 to one of about a million hashes, which matters only for a password already in a guess list. |

### A4, local process while locked

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Run the signed binary as Node (`ELECTRON_RUN_AS_NODE`) to inherit its identity | `RunAsNode` fuse off | None known. |
| Inject code with `NODE_OPTIONS`, `--inspect`, or `--inspect-brk` | `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` fuses off | None known. |
| Launch with `--remote-debugging-port` or `--remote-debugging-pipe` and drive the renderer | Packaged builds exit at startup when either switch is present | Other Chromium switches (`--js-flags`, `--disable-web-security`, and so on) are not filtered. They cannot reach Node.js and do not change the main-process checks, but should be reviewed. |
| Modify `app.asar` or plant `Resources/app/` to backdoor the app | `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` fuses on; the asar hash is inside the signed `Info.plist`; Developer ID builds add library validation | An attacker who can rewrite the whole bundle and re-sign it ad hoc produces an app that Gatekeeper does not trust; a quarantined download fails assessment, but a local unquarantined copy may still launch. Install in `/Applications` and keep it owned by an admin. |
| Load a foreign library: `DYLD_INSERT_LIBRARIES` or another `DYLD_*` variable | Hardened runtime on the app and every helper, without `allow-dyld-environment-variables`; checked with an injected test library (`docs/RELEASING.md`) | None known for injection through the environment. |
| Load a foreign library by replacing one inside the bundle (for example `Electron Framework`) | Developer ID builds: library validation refuses code from another Team ID | GitHub builds have `disable-library-validation` (an ad-hoc signature has no Team ID to compare), so a replaced, re-signed framework loads. This needs write access to the bundle, which already allows the re-signing attack in the row above. |
| Replace the vault file or `profiles.json` | AES-GCM authentication; schema validation; registry validation | The attacker can delete or roll back vaults (old encrypted copy). Rollback is not detected. |
| Read the Touch ID key file and ask the Keychain for its key | The Keychain item belongs to the signed app; another app gets a macOS Keychain prompt. The file is `0600` and bound to its profile ID | A user who clicks "Always Allow", or an attacker who knows the login password and has the disk, can decrypt the vault key without Touch ID or the master passphrase. Touch ID is checked by the app, not by the Keychain item. |
| Read clipboard leftovers | Copied values are cleared after 30 s, and on lock, if unchanged | Clipboard managers and Universal Clipboard may keep copies. |

### A5, local process while unlocked

Out of scope beyond best effort. A same-user process with debugger,
Accessibility, or screen-recording rights can read the main process's memory,
watch the screen, or log keystrokes. The hardened runtime (no
`get-task-allow`, no `allow-dyld-environment-variables`) blocks casual
debugger attachment and `DYLD_*` injection into every published build,
Developer ID and ad hoc alike, and auto-lock limits how long secrets stay in
memory. Builds from `npm run pack:mac:local` have no hardened runtime and
must not be used with real vaults on a shared machine.

### A6, physical or visual access

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Unattended unlocked app | Auto-lock after 5 minutes without input, on screen lock, sleep, window close, and quit | Up to 5 minutes of exposure. |
| Shoulder surfing | Passwords masked; reveal is an explicit action in a separate dialog | The dialog shows the password until dismissed. |
| Recovery key found on paper or in a saved file | The user is told to keep it offline and to move or delete the file; a new key can be issued from Settings, which invalidates the old one for the current file and replaces the vault key | Old backups still open with the key that was valid when they were made, including through the restore screen. Replacing a key does not protect backups made before the replacement. |
| Master passphrase seen while typed (shoulder surfing, screen recording) | The passphrase can be changed in Settings with the current one; the change replaces the vault key and the recovery key and removes the Touch ID key | Old backups and copies of the file still open with the old passphrase. |

### A7, distribution

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Trojanized download | Developer ID builds: signature, hardened runtime, notarization with a stapled ticket, Gatekeeper | GitHub releases are ad-hoc signed (with the hardened runtime), so the first install asks the user to override Gatekeeper and cannot tell a genuine download from a re-signed one. Compare against the release page; the in-app updater (A8) protects later versions. |
| Shipping an unsigned or misconfigured build | `forceCodeSigning`; the `afterSign` hook verifies fuses, asar integrity, the signature, entitlements, the ticket, and Gatekeeper (`release` mode), or everything except the Developer ID and the ticket (`adhoc-release` mode, used by the release workflow); the hardened runtime is required on every executable in both; tests pin the fuse and entitlement configuration and that the workflow does not turn the hardened runtime off | Build-machine compromise is out of scope. Signing keys must be protected; prefer App Store Connect API keys stored in a secrets manager. |
| Compromised npm dependency | No runtime dependencies; build tools pinned to exact versions with a lockfile; `npm audit` clean at the time of writing | Build-time dependencies (electron-builder) run with developer privileges. |

### A8, update channel

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Network or GitHub serves a modified archive | The archive's SHA-512 and size must match the Ed25519-signed manifest; the unpacked app must have Mnemo's bundle ID, the signed version, and a valid code signature | None known without the private key. |
| Attacker publishes a release from a stolen GitHub account or token | The release still needs a manifest signed by a bundled key; the key is not in the repository or on a developer machine | A stolen key plus a release is a full compromise of every auto-updating copy (see below). |
| A `v*` tag on a commit that never reached `main` (a side branch, an unreviewed commit) is published | The publish job checks out the full history and stops unless the tag's commit is an ancestor of `origin/main`, before the key is used; tests run that check against a temporary repository | Done in the workflow. Anyone who can push to `main` and create a `v*` tag can still release. Required reviewers on the `release` environment, its `v*`-only tag rule, and a tag ruleset that lets only the owner create `v*` tags are GitHub settings the workflow cannot enforce; `docs/RELEASING.md` lists them for the owner. |
| Downgrade to an older, vulnerable signed release | Only versions newer than the running one are offered; the release tag must equal the signed version | — |
| Freeze: withholding updates by serving an old "latest" release or blocking GitHub | — | Not detected. The manifest has `releasedAt` but the app does not require freshness. The user can compare with the release page. |
| Update key leak or misuse | Key held only in the `release` environment, used by a job that installs no npm packages; build job has no secrets; actions pinned to commit SHAs; the signing script refuses keys the app does not trust | Anyone with repository admin rights can read the environment's secrets through a workflow. Recovering from a leak needs a release signed with the leaked key that drops it, which the attacker can race. Protect the environment with tag rules and required reviewers. |
| Malicious dependency in the build job tampers with the archive | Build tools pinned in the lockfile; tests run before the build | The signed manifest covers whatever the build produced; a compromised build tool is not detected. |
| Path or command injection while installing | Archive names are restricted to `[A-Za-z0-9._-]` in the signed manifest; files are unpacked with `ditto` into a fresh directory next to the app; the relaunch script receives the PID and path as arguments, not as shell text | — |
| Partially installed app | Staging and swap use renames on the same volume; a failed swap restores the previous app; leftovers are removed on the next launch | A crash between the two renames leaves the app at `.Mnemo-previous-….app` in the same folder; the user must rename it back. |
| Updater installs into a translocated or read-only copy | Installation is refused outside a writable folder, on a mounted disk image, or under App Translocation; the banner offers the release page instead | — |
| Keychain item tied to an ad-hoc signature | — | The ad-hoc signature changes with every build, so after an update macOS asks to let Mnemo use its "Safe Storage" Keychain item (Touch ID). Denying it disables Touch ID unlock until it is turned on again; the master passphrase still works. A Developer ID signature removes the prompt. |

## 6. Out of scope

- Malware running as root, kernel compromise, or hardware attacks such as
  cold boot.
- Recovering a forgotten master passphrase without the recovery key. There is
  no other way back in by design.
- Sync, sharing, browser autofill, and multi-device use. These features do not
  exist yet.
- Side channels in Node.js or Chromium crypto implementations.

## 7. Known residual risks and follow-ups

1. **`file://` privileges.** **Done.** The UI is served from `app://mnemo/`
   by `protocol.handle` with a path traversal check, and
   `GrantFileProtocolExtraPrivileges` is off.
2. **Notes are not sealed per entry.** They are decrypted with the vault index
   and can be read by a compromised renderer one entry at a time. Seal them like
   passwords if notes are expected to hold secrets.
3. **Memory hygiene.** JavaScript strings (the passphrase in the renderer,
   decrypted passwords during copy, schema 1 vaults during upgrade) cannot be
   zeroized.
4. **Rollback.** Replacing a vault with an older encrypted copy is not
   detected.
5. **Profile deletion from the profile list** (vault locked) is confirmed
   only in the renderer; add a native confirmation there too.
6. **Favicon decoding.** **Partly done.** Images are decoded in a separate
   `utilityProcess` by plain JavaScript decoders, and main receives only
   pixels (B7). That process runs Node.js without Chromium's sandbox;
   decoding in a sandboxed hidden renderer (`createImageBitmap`) would
   confine it further.
7. **Touch ID binding.** Replace the `safeStorage` backend with a Secure
   Enclave key whose access control requires biometry (current set), so the
   Keychain itself refuses to release the key without a fingerprint and the
   key is invalidated when fingerprints change. Needs a native module, the
   data protection keychain, and a provisioning profile.
8. **Passphrase strength.** Partly done. New passphrases need 12
   characters and a Strong rating from a simple heuristic: length,
   character classes of any script, a few common words and runs, and since
   then repeats (one block repeated, by its smallest period, or fewer than 8
   different characters is Weak). The passphrase can be changed in Settings
   with the current one, so old 7-character vaults can be upgraded; they are
   not forced to. Still open: a dictionary-based estimate (such as zxcvbn,
   which would be a new dependency) or a word-count rule, and raising scrypt
   cost or moving to Argon2id.
9. **Developer ID.** GitHub releases are ad-hoc signed. With a Developer ID,
   sign and notarize in the release workflow, drop
   `build/entitlements.adhoc.plist` so library validation is back, check the
   new app's Team ID in the updater, and the Gatekeeper and Keychain prompts
   go away.
10. **Update freshness.** Reject manifests older than a set age, or show the
    date of the newest known release, to make freeze attacks visible.
11. **Attachments in memory.** Adding, saving, and verifying an attachment
    holds the whole file (up to 50 MB) in main-process memory; buffers are
    zeroed afterwards, but copies made by Node or the OS are not controlled.
    Saved copies are plain files outside Mnemo.
12. **History and deletion.** An old password stays in the vault (and in
    backups made meanwhile) until 20 newer versions replace it or the item is
    deleted for good. A per-item "clear history" action would let users drop
    it sooner.

## 8. Internal review (2026-10-26)

A separate reviewer with no access to the implementation discussion audited
the whole app (not only this change). It was an internal review, **not** an
independent third-party audit; that is still required before real use. It
found no Critical or High issues.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Medium | The reveal-password dialog stayed open after auto-lock, screen lock, or sleep | **Fixed.** Vault dialogs use an `AbortController`; `lockVault()` closes them. Covered by a test. |
| 2 | Medium | A compromised renderer could exfiltrate metadata and the master passphrase through WebRTC (STUN/TURN), which bypasses `webRequest` and CSP `connect-src` | **Fixed.** The preload removes `RTCPeerConnection`, `webkitRTCPeerConnection`, and `RTCDataChannel` (verified in the running app); the IP handling policy is `disable_non_proxied_udp`; the session proxy points to a closed local port; CSP adds `webrtc 'block'`. |
| 3 | Low | No permission check handler, so checks report "granted" | **Fixed.** Permission checks and device permissions are denied; clipboard reads verified to fail in the running app. |
| 4 | Low | Restore read the global vault after awaiting dialogs and ignored the lock epoch; profile deletion is confirmed only in the renderer | **Mostly fixed.** Restore binds to the vault and epoch at the start and aborts if either changes. Deleting the open vault from Settings needs its passphrase and a native confirmation. Deleting a locked profile from the profile list still relies on the renderer's type-the-name dialog. |
| 5 | Low | DevTools available in packaged builds (self-XSS through the console) | **Fixed.** `devTools` is disabled when packaged. |
| 6 | Low/Info | `file://` origin with `GrantFileProtocolExtraPrivileges` makes CSP `'self'` cover any local file | **Fixed.** The page is served from `app://mnemo/`, so `'self'` covers only that origin; the fuse is off. See follow-up 1 in section 7. |
| 7 | Info | Untrusted favicon images are decoded in the unsandboxed main process | **Fixed.** Images are decoded in a separate `utilityProcess` by plain JavaScript PNG and ICO decoders with a 5-second limit; main receives only pixels and encodes the PNG itself. That process is not sandboxed by Chromium (section 7, item 6). |
| 8 | Info | Release verification checked entitlements only on the outer app | **Fixed.** Every nested `.app`/`.framework` is checked, and `app.asar.unpacked` is rejected. |
| 9 | Info | Clipboard text is not marked concealed or transient; vault rollback is not detected; 7-character passphrase minimum | **Partly fixed.** New passphrases need 12 characters and a Strong rating (section 7, item 8). Clipboard and rollback are still open; concealed clipboard types need a small native helper. |

The reviewer confirmed: IPC sender checks on every handler, a fixed preload
surface, input validation, that passwords never reach the renderer, a DOM
built with `textContent`, AES-GCM nonce and AAD use (including the per-entry
password binding), lock-epoch handling for unlock, create, and restore-new,
atomic `0600` writes, DNS pinning and redirect limits in the favicon fetcher,
the fuse and entitlement configuration, and no logging of secrets.

## 9. When to revisit this document

- Adding any network feature (sync, breach checks), or changing the update
  channel, its keys, or the release workflow.
- Adding browser autofill or a browser extension bridge.
- Changing the vault format, KDF, or key hierarchy.
- Adding IPC methods or widening what the renderer receives.
- Upgrading Electron across a major version (review new fuses).
- Before the first public release, and after the independent audit.
