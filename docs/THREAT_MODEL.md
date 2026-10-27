# Mnemo threat model

Status: draft for the prototype, written alongside the Electron hardening
work (fuses, metadata-only renderer, signing and notarization). Review it
again whenever a trigger at the end of this document applies. Updated
2026-10-28 for in-app updates (B6, A8).

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
| Encrypted backups (`.vault`) | Wherever the user saves them | Same envelope and passphrase as the local vault. |
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
 │    ── HTTPS (user-initiated only) ─── website for its favicon       │  B4
 │    ── HTTPS (daily, can be off) ───── GitHub releases (updates)     │  B6
 │    ── native dialogs ──────────────── reveal password, file pickers │
 └─────────────────────────────────────────────────────────────────────┘
   B5: GitHub Actions build → ad-hoc signature → GitHub release → user's Mac
       (or: build machine → Developer ID signature → notarization)
```

- **B1, renderer → main.** The renderer is treated as compromisable (for
  example by a future XSS bug or a malicious vault value). Every IPC handler
  checks that the sender is the app's own main frame loaded from the packaged
  `index.html`, and validates its arguments. The renderer cannot ask for a
  password in plain text: copy and reveal are performed by the main process.
- **B2, main → disk.** Everything secret is encrypted before it is written.
  Writes are atomic (temp file plus rename) with restrictive permissions.
- **B3, main → clipboard.** Leaves the app's control once written.
- **B4, main → network.** Only the explicit "Load site icon" action and the
  update check (B6). Renderer network access is blocked by CSP and by
  `webRequest`.
- **B5, supply chain.** Fuses and asar integrity make tampering with app code
  inside an installed copy detectable by Electron. A Developer ID build adds
  notarization and Gatekeeper; the ad-hoc builds published on GitHub do not
  identify their author to macOS.
- **B6, main → GitHub releases.** The main process reads the latest release
  of `apathywoke/Mnemo`, its signed manifest, and the archive for this Mac.
  Trust rests on the Ed25519 signature checked against keys bundled in the
  running app, not on TLS or GitHub. The renderer only sees the version,
  release notes, and progress, and can only ask main to check, download,
  install, or open the release page.

## 3. Assumptions

- macOS, the user account, and the kernel are not compromised while the vault
  is unlocked. Mnemo cannot defend against malware running as the same user
  with Accessibility, screen-recording, or debugger rights, or as root.
- The user picks a master passphrase that resists offline guessing. The app
  enforces only a 7-character minimum.
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
| Strip or replace the recovery wrap to plant a key the attacker knows | The recovery salt is in the AES-GCM associated data of the key wraps and the vault data; a missing or different recovery wrap cannot unwrap the real vault key, and the strict format check rejects the file | An attacker with write access can delete the recovery wrap together with the file (denial of service only). |
| Brute-force the master passphrase from a vault or backup | scrypt N=2^17, r=8, p=1 with a 16-byte random salt per vault; random 256-bit data key wrapped with AES-256-GCM | A weak passphrase still falls. The 7-character minimum is a usability floor, not a strength guarantee. |
| Tamper with a vault or backup to plant data or downgrade parameters | AES-GCM with the header (format, version, KDF parameters, salt) as AAD; strict schema and size validation before and after decryption; fixed KDF parameters | None known. |
| Swap sealed passwords between entries | Each password is sealed with the entry ID in its AAD; a swapped value fails authentication | None known. |
| Recover deleted vaults | Not addressed: deletion unlinks the file | APFS snapshots, Time Machine, and SSD remapping may keep old encrypted copies. These remain protected by their passphrase. |

### A2, malicious website (favicon fetch)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| SSRF to the local network or loopback | Public HTTPS hosts only; DNS resolved and a public IPv4 address pinned; redirects only to the same host or its `www` variant, at most three | IPv6-only sites cannot provide icons. |
| Image-parser exploit or decompression bomb | Response size limits; dimensions checked before decoding; only PNG, JPEG, and limited ICO accepted; re-encoded to PNG; stored PNG revalidated | Relies on Electron's `nativeImage` decoders. |
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
| Spoof IPC from another frame | Handlers accept only the main frame whose URL is the packaged `index.html` | None known. |

### A4, local process while locked

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Run the signed binary as Node (`ELECTRON_RUN_AS_NODE`) to inherit its identity | `RunAsNode` fuse off | None known. |
| Inject code with `NODE_OPTIONS`, `--inspect`, or `--inspect-brk` | `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` fuses off | None known. |
| Launch with `--remote-debugging-port` or `--remote-debugging-pipe` and drive the renderer | Packaged builds exit at startup when either switch is present | Other Chromium switches (`--js-flags`, `--disable-web-security`, and so on) are not filtered. They cannot reach Node.js and do not change the main-process checks, but should be reviewed. |
| Modify `app.asar` or plant `Resources/app/` to backdoor the app | `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` fuses on; the asar hash is inside the signed `Info.plist`; hardened runtime with library validation (no `disable-library-validation` entitlement) | An attacker who can rewrite the whole bundle and re-sign it ad hoc produces an app that Gatekeeper does not trust; a quarantined download fails assessment, but a local unquarantined copy may still launch. Install in `/Applications` and keep it owned by an admin. |
| Replace the vault file or `profiles.json` | AES-GCM authentication; schema validation; registry validation | The attacker can delete or roll back vaults (old encrypted copy). Rollback is not detected. |
| Read the Touch ID key file and ask the Keychain for its key | The Keychain item belongs to the signed app; another app gets a macOS Keychain prompt. The file is `0600` and bound to its profile ID | A user who clicks "Always Allow", or an attacker who knows the login password and has the disk, can decrypt the vault key without Touch ID or the master passphrase. Touch ID is checked by the app, not by the Keychain item. |
| Read clipboard leftovers | Copied values are cleared after 30 s, and on lock, if unchanged | Clipboard managers and Universal Clipboard may keep copies. |

### A5, local process while unlocked

Out of scope beyond best effort. A same-user process with debugger,
Accessibility, or screen-recording rights can read the main process's memory,
watch the screen, or log keystrokes. The hardened runtime (no
`get-task-allow`, no `allow-dyld-environment-variables`) blocks casual
debugger attachment and `DYLD_*` injection into the signed release build, and
auto-lock limits how long secrets stay in memory.

### A6, physical or visual access

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Unattended unlocked app | Auto-lock after 5 minutes without input, on screen lock, sleep, window close, and quit | Up to 5 minutes of exposure. |
| Shoulder surfing | Passwords masked; reveal is an explicit action in a separate dialog | The dialog shows the password until dismissed. |
| Recovery key found on paper or in a saved file | The user is told to keep it offline and to move or delete the file; a new key can be issued from Settings, which invalidates the old one for the current file | Old backups still open with the key that was valid when they were made, including through the restore screen. Replacing a key does not protect backups made before the replacement. |

### A7, distribution

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Trojanized download | Developer ID builds: signature, hardened runtime, notarization with a stapled ticket, Gatekeeper | GitHub releases are ad-hoc signed, so the first install asks the user to override Gatekeeper and cannot tell a genuine download from a re-signed one. Compare against the release page; the in-app updater (A8) protects later versions. |
| Shipping an unsigned or misconfigured build | `forceCodeSigning`; the `afterSign` hook verifies fuses, asar integrity, the signature, entitlements, the ticket, and Gatekeeper; tests pin the fuse and entitlement configuration | Build-machine compromise is out of scope. Signing keys must be protected; prefer App Store Connect API keys stored in a secrets manager. |
| Compromised npm dependency | No runtime dependencies; build tools pinned to exact versions with a lockfile; `npm audit` clean at the time of writing | Build-time dependencies (electron-builder) run with developer privileges. |

### A8, update channel

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Network or GitHub serves a modified archive | The archive's SHA-512 and size must match the Ed25519-signed manifest; the unpacked app must have Mnemo's bundle ID, the signed version, and a valid code signature | None known without the private key. |
| Attacker publishes a release from a stolen GitHub account or token | The release still needs a manifest signed by a bundled key; the key is not in the repository or on a developer machine | A stolen key plus a release is a full compromise of every auto-updating copy (see below). |
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

1. **`file://` privileges.** `GrantFileProtocolExtraPrivileges` stays on because
   `loadFile()` from `app.asar` fails without it. Move the UI to a custom
   `app://` protocol (`protocol.handle`) and then turn the fuse off.
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
6. **Favicon decoding** runs in the main process; move it to a sandboxed
   process.
7. **Touch ID binding.** Replace the `safeStorage` backend with a Secure
   Enclave key whose access control requires biometry (current set), so the
   Keychain itself refuses to release the key without a fingerprint and the
   key is invalidated when fingerprints change. Needs a native module, the
   data protection keychain, and a provisioning profile.
8. **Passphrase strength.** Consider a stronger minimum or an entropy-based
   check, and consider raising scrypt cost or moving to Argon2id.
9. **Developer ID.** GitHub releases are ad-hoc signed. With a Developer ID,
   sign and notarize in the release workflow, check the new app's Team ID in
   the updater, and the Gatekeeper and Keychain prompts go away.
10. **Update freshness.** Reject manifests older than a set age, or show the
    date of the newest known release, to make freeze attacks visible.

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
| 6 | Low/Info | `file://` origin with `GrantFileProtocolExtraPrivileges` makes CSP `'self'` cover any local file | **Open.** See follow-up 1 in section 7. |
| 7 | Info | Untrusted favicon images are decoded in the unsandboxed main process | **Open.** Move decoding to a sandboxed `utilityProcess` or to the renderer. |
| 8 | Info | Release verification checked entitlements only on the outer app | **Fixed.** Every nested `.app`/`.framework` is checked, and `app.asar.unpacked` is rejected. |
| 9 | Info | Clipboard text is not marked concealed or transient; vault rollback is not detected; 7-character passphrase minimum | **Open.** Already listed in section 7; concealed clipboard types need a small native helper. |

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
