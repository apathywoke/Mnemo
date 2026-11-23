# Design: Windows and Linux

Status: **plan, not approved.** Written on 2026-11-12 from a reading of the
code at `c088ea6`. Nothing below is implemented. The decisions in section 3
need the owner's choice before work starts. Start after the open pull
requests (#61–#64: profile deletion, rollback detection, end-to-end flows,
coverage) are merged.

## 1. Where Mnemo stands

Most of the code does not depend on macOS: the vault store
(`src/main/vault/`), importers, snapshots, the i18n catalog, and the page.
The unit tests already run on Linux in CI. What is tied to macOS:

| Area | Where | What breaks on Windows and Linux |
| --- | --- | --- |
| Window | `src/main/window.js` (line 42), `access-native.css` | `hiddenInset` and vibrancy exist on macOS only; the 64px padding for the window buttons applies on every platform. |
| Menu | `src/main/app-menu.js` | `services`, `hide`, `hideOthers`, `unhide`, `front` are macOS roles; there is no menu for Windows and Linux. |
| Tray icon | `src/main/menu-bar.js` | A template image (`setTemplateImage`) is macOS only; Linux needs AppIndicator. |
| Closing the window | `main.js` (`window-all-closed`) | Quits on Windows and Linux even while the tray icon is on. |
| Touch ID | `biometric-unlock.js`, `native/touch-id/` | Already off elsewhere (`isAvailable` is false), but the helper is a global `extraResources` entry, so a Windows or Linux build fails. |
| Screen lock | `main.js` (`powerMonitor` `lock-screen`) | Electron fires `lock-screen` on macOS and Windows only. |
| Updates | `src/main/updater.js` | macOS only: `ditto`, `codesign`, `.app` bundles. |
| Update manifest | `verifyManifest` in `updater.js` | Released macOS clients accept only `arm64`/`x64` keys with `.zip` names in `assets` and reject the whole manifest otherwise (section 7). |
| Copies outside | `src/main/outside-copies.js` | Uses `/sbin/mount`, iCloud folders, and `stats.blocks === 0` for placeholders (`blocks` is undefined on Windows). |
| File modes | five `chmod` calls | Skipped on Windows; only the profile's ACL protects the files. |
| Text | `src/shared/i18n/messages.js` | About 105 strings per language name "this Mac", iCloud, Finder, macOS, or Touch ID, including errors thrown in main that must match the catalog. |
| Fonts | `tokens.css`, the monospace rules | `-apple-system` and SF Mono, without good fallbacks for Windows and Linux. |
| Build and release | `electron-builder.config.js`, `release.yml` | `mac` targets only; `forceCodeSigning: true` for every platform; end-to-end tests run on macOS only. |

## 2. Goals and non-goals

Goals:

1. Windows 10 and 11 (x64, arm64) and Linux (x64; Ubuntu 24.04 and Fedora
   as the reference systems) run Mnemo with the same vault format, the same
   data safety, and the same security properties wherever the platform
   allows them.
2. Where a platform cannot match macOS, SECURITY.md and THREAT_MODEL say so
   per platform.
3. macOS behavior and looks do not change (`e2e/compare-screens.js` gives
   identical screens).
4. No new runtime dependencies and no native Node modules.

Non-goals for the first release:

- Biometric unlock on Windows or Linux (section 3, decision 6).
- Self-installing updates (step 5B in section 5).
- `.rpm`, Flatpak, Snap, the Microsoft Store.

## 3. Decisions for the owner

1. **Formats.** Recommended: an NSIS installer for Windows (x64, arm64);
   AppImage and `.deb` for Linux (x64).
2. **Install location on Windows.** A per-user install
   (`%LOCALAPPDATA%\Programs`) is writable by any process of the user (A4).
   A per-machine install (`Program Files`) needs administrator rights but
   protects the app files. Recommended: per-machine.
3. **Signing on Windows.** Azure Trusted Signing (about $10 a month), an OV
   certificate, or none. Unsigned builds get SmartScreen warnings, and the
   updater cannot check an Authenticode signature.
4. **Data folder on Windows.** Electron's default is `%APPDATA%` (Roaming),
   which domain networks copy to a server. Recommended: `%LOCALAPPDATA%`.
5. **"This Mac" in the text.** Neutral wording ("this computer", "diesem
   Computer", "этом компьютере": the grammar matches "Mac" in all three
   languages), or variants per platform. Recommended: neutral wording, with
   keys per platform only for the cloud folder (iCloud, OneDrive), the file
   manager (Finder, File Explorer), and Touch ID.
6. **Biometrics.** None in the first release. Windows Hello would be a
   separate native helper, which CLAUDE.md does not allow today ("Native
   code is the Touch ID helper only"); it needs its own design and
   approval.

## 4. Stages

### Stage 1. Runs and looks right (3 pull requests)

- **`src/main/platform.js`**, the one place that checks the platform. It
  reports capabilities: vibrancy, a template tray image, a screen-lock
  event, self-update, biometrics. It keeps no state (CLAUDE.md, `state`).
- **Window.** Windows: `titleBarStyle: "hidden"` with `titleBarOverlay`,
  its colors following the theme. Linux: the standard frame. The page gets
  `data-platform="win"` or `"linux"`; the 64px padding stays macOS only.
- **Menu.** A template for Windows and Linux: File (Settings, Lock, Quit),
  Edit, Help (About). No reload and no developer tools in packaged builds,
  as today.
- **Tray.** A colored icon instead of the template image. With the icon on,
  closing the window does not quit.
- **Fonts.** `system-ui`, `"Segoe UI Variable"`, Cantarell, Ubuntu;
  monospace: Cascadia Mono, Consolas, DejaVu Sans Mono.
- **Build.** The Touch ID helper moves to `mac.extraResources`;
  `test/build-config.test.js` follows.
- **Checks.** macOS screens stay identical; Windows and Linux get their own
  reference screens.

### Stage 2. File safety (2 pull requests; the riskiest stage)

- **Renames on Windows.** Antivirus and the search indexer keep files open,
  so an atomic replace fails with `EPERM`, `EBUSY`, or `EACCES`. Retry with
  backoff in `writeFileDurably`, profile deletion, snapshots, and copies
  outside.
- **Flushing.** `fsync` is FlushFileBuffers on Windows. A folder cannot be
  synced there (`syncDirectory` already ignores the failure); NTFS journals
  the rename. Document it.
- **Paths.** The recovery key's default file name drops `<>:"|?*` and
  reserved names (`CON` and the like). The "folder inside Mnemo's data"
  check compares case-insensitively on NTFS (and on APFS, which it already
  should).
- **Modes.** `0700`/`0600` already work on Linux. On Windows the profile's
  ACL and decision 4 protect the files.
- **Copies outside.**
  - Linux: the mount table from `/proc/self/mounts`; `vfat`, `cifs`, and
    `fuse.*` count as unreliable.
  - Windows: the file system is not checked at first (no external tools, no
    native code).
  - OneDrive: cloud roots from the `OneDrive*` environment variables.
    Files On-Demand placeholders are not visible to Node; check by hand what
    reading one does.
- **CI.** Unit tests and the durability sample on `windows-latest`. Tests
  that need `/bin/sh` already skip on win32; fix the rest.

### Stage 3. Security (2 pull requests; required before any release)

- **Chromium's sandbox on Linux.** Ubuntu 24.04's AppArmor blocks
  unprivileged user namespaces, so an AppImage does not start without
  `--no-sandbox`. Never ship or document that switch.
  - The `.deb` installs the SUID `chrome-sandbox`; the AppImage needs an
    AppArmor profile or instructions.
  - The app exits at startup when the sandbox is off, as it does today with
    `--remote-debugging-port`.
- **Screen lock on Linux.** Poll `powerMonitor.getSystemIdleState()` for
  `locked`, which some desktops report. Record the gap in THREAT_MODEL.
- **Clipboard** (a short spike first):
  - Windows: keep copied secrets out of the clipboard history (Win+V) and
    cloud clipboard (`ExcludeClipboardContentFromMonitorProcessing`,
    `CanIncludeInClipboardHistory`). Check whether Electron can write these
    formats together with the text.
  - Linux: the hint for clipboard managers (`x-kde-passwordManagerHint`);
    clearing the clipboard under Wayland.
- **Fuses.** Embedded asar integrity works on Windows, not on Linux. Linux
  relies on `OnlyLoadAppFromAsar`; the AppImage file is writable by the
  user. Record it as a residual risk (A4).
- **Documents.** THREAT_MODEL gains per-platform parts for A4, A6, A7, and
  A8; SECURITY.md follows.

### Stage 4. Text (1 pull request)

- About 105 strings in en, de, and ru, per decision 5, including errors
  thrown in main that must match the catalog (`errors.vaultExists`,
  `errors.restoreInterruptedMac`, `errors.updateNone`).
- Hints for the cloud folder and the file manager per platform.
- Shortcuts in text: `⌘` becomes `Ctrl` on Windows and Linux.

### Stage 5. Build, release, updates (3 pull requests)

- **Build.** `win` and `linux` targets in electron-builder with fixed
  `artifactName`s; `forceCodeSigning` per platform; the fuse check after
  every build, on every platform.
- **Release.** `release.yml` builds on `windows-latest` and `ubuntu-24.04`;
  the publishing job collects the artifacts.
- **Manifests** (section 7). `update-manifest.json` stays macOS only.
  Windows and Linux get `update-manifest-win32.json` and
  `update-manifest-linux.json`, signed with the same Ed25519 key.
- **5A.** On Windows and Linux the app only tells about a new version and
  opens its release page (a new `installBlocker` value).
- **5B.**
  - Windows: download the NSIS installer, check its SHA-512 against the
    signed manifest and, if signed, its Authenticode signature; install
    silently and relaunch.
  - AppImage: replace the file named by `$APPIMAGE` atomically.
  - `.deb`: tell only.
- **CI.** End-to-end tests on Ubuntu (under xvfb) and on Windows.

### Stage 6. Documentation (1 pull request)

- README is no longer "macOS-first"; RELEASING.md describes the builds per
  platform.
- CLAUDE.md: check the platform only through `platform.js`; keep text
  neutral.
- The first Windows and Linux releases are marked beta.

## 5. Order

```
1 (window, menu, tray, build) ─┐
2 (files)  ── in parallel ─────┼─→ 4 (text) ─→ 5A (build + notices) ─→ beta
3 (security) ──────────────────┘                  5B (self-update) ─→ 6
```

- About 12 pull requests. Stages 1–3 touch different files and can run in
  parallel.
- The least for a beta: stages 1–4 and 5A. Stage 3 is not optional: on
  Linux the sandbox may otherwise be off.
- Manual checks before the beta: Windows 10 and 11, Ubuntu 24.04 (GNOME,
  Wayland), Fedora (KDE).

## 6. Risks

1. **Antivirus breaks atomic replaces on Windows.** Retries, and the
   durability test on Windows CI.
2. **The sandbox off on Linux** leaves the page without its protection.
   The check at startup.
3. **Manifest compatibility.** One mistake and macOS users stop getting
   updates. Separate manifests, and a test that runs a new manifest through
   the validator of the released version.
4. **No signature on Windows** gives a poor first impression (SmartScreen)
   and a weaker update check.

## 7. Why the manifests are separate

`verifyManifest` in released versions requires every key of `assets` to be
`arm64` or `x64` and every name to end in `.zip`. A Windows or Linux entry
in the same `assets` makes those versions reject the manifest, so they stop
updating. Unknown top-level keys are ignored, but separate files keep each
platform's manifest small and let a platform ship without touching the
others. Each file is signed on its own with the keys in
`build/update-keys/`.
