# Design: detecting frozen updates

Status: **planned, deferred.** On 2026-11-01 the owner decided not to build
this while Mnemo is a prototype without users; it is recorded here so it
can be picked up later. Nothing below is implemented. `docs/THREAT_MODEL.md`
(section 7, item 10) links here.

## 1. The gap

The updater (`src/main/updater.js`) trusts a release only if its manifest is
signed by a bundled Ed25519 key, and installs it only if it is newer than the
running version. That stops forged and older builds. It does not stop a
**freeze**: someone who controls what the app downloads (a compromised
GitHub account or release, a network attacker who can get past TLS, or GitHub
itself) serves an old but validly signed release as "latest", or blocks the
check. The app then reports "up to date" while a newer release with security
fixes exists.

- **F1, freeze.** An older, correctly signed release is presented as the
  latest.
- **F2, partial freeze.** A newer but not the newest release is presented
  (0.3.0 while 0.3.1 has the fix).
- **F3, blocking.** Every check fails; the user sees an error and may ignore
  it.

## 2. Design (after TUF's timestamp role)

### A separate freshness key

- A second Ed25519 key, the **freshness key**, signs `update-status.json`.
  It lives in its own GitHub environment (`update-status`), separate from
  the release key.
- Its public keys ship in `build/update-keys/freshness/*.pem`, a different
  folder from the release keys. The updater must never accept a freshness
  key for a manifest, or a release key for a status; a test checks both.
- Leaking the freshness key allows only freezing (claiming an old release is
  current), which is no worse than today. It cannot install code.

### The signed status

`update-status.json` with `update-status.json.sig`:

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"mnemo-update-status"`, 1 |
| `latestVersion` | The newest full release |
| `manifestSha512` | SHA-512 of that release's exact `update-manifest.json` |
| `sequence` | Increases with every status ever signed |
| `issuedAt`, `expiresAt` | Validity window; `expiresAt - issuedAt` at most 30 days |

- A scheduled workflow re-signs it **daily**, and the release workflow signs
  one with every release. Validity: **14 days**.
- It is published at a fixed URL that does not depend on "latest": an asset
  of a dedicated prerelease named `update-status`, replaced on every signing.

### Checks in the app

On every update check, besides the current manifest checks:

1. Download the status and its signature; verify with the freshness keys.
2. Reject it if `expiresAt` has passed, if `issuedAt` is more than one day in
   the future, or if the window is longer than 30 days.
3. Reject it if its `sequence` is lower than the highest one this app has
   accepted (kept in `settings.json`), so an old status cannot be replayed.
4. Require `latestVersion` and `manifestSha512` to match the manifest of the
   release GitHub calls latest. A mismatch is reported as inconsistent
   update information (F1, F2).
5. Remember the highest `latestVersion` seen; never accept a "latest" below it.

### What the user sees

- Settings → Updates shows "Last confirmed up to date: <date>".
- If no valid status has been seen for 14 days (expired, missing, or the
  check keeps failing: F3), a persistent notice says that Mnemo could not
  confirm it is up to date and links the releases page.
- Nothing is blocked: the vault keeps working.

## 3. Owner actions

- Create the freshness key pair, the `update-status` environment with
  required reviewers, and its secret. Claude provides the script and steps
  and never handles the private key.
- Ship the freshness public key in a release signed with the current release
  key before the first status is signed, as for any new key
  (`docs/RELEASING.md`, rotating keys).
- Optionally keep an **offline backup release key**, whose public half ships
  with the app, so a lost release key does not strand installed copies.

## 4. Limits

- GitHub disables scheduled workflows after 60 days without activity in the
  repository. The status then expires and users see the notice;
  `docs/RELEASING.md` must say how to re-enable the schedule.
- The local clock is trusted. An attacker who controls the user's clock is
  out of scope.
- `settings.json` (the highest sequence and version seen) is not
  authenticated; a local attacker who can change it is out of scope.

## 5. Tests (when built)

- Signature, expiry, future `issuedAt`, a too-long window, replayed
  sequence, and manifest mismatch are each refused.
- A freshness key cannot sign a manifest, and a release key cannot sign a
  status.
- The notice appears after 14 days without a valid status and disappears
  after one.
