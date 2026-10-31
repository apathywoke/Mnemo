# Design: detecting vault rollback

Status: proposal for review (stage 3, task 8). Nothing here is implemented.
The decisions that need approval are listed in section 12.

## 1. The problem

AES-GCM proves that a vault file was written with its key, not that it is
the newest one. Replacing a vault with an older encrypted copy is accepted
without a word: THREAT_MODEL A4 ("Rollback is not detected"), section 7,
item 4, and review finding 9.

Why it matters:

- **Key downgrade.** A passphrase change or a new recovery key replaces the
  vault key, so an old recovery key and an old copy of the file cannot read
  what is saved later (THREAT_MODEL, A1). Putting the old file back undoes
  this.
  - The user is asked for the old passphrase; Touch ID no longer opens the
    vault.
  - A user who remembers the old passphrase and types it keeps working in a
    vault whose key and recovery key someone else may know.
- **Data rollback.** A deleted item, a changed password, or a removed
  one-time code comes back without notice.
- **Accidents.** A sync tool, a Time Machine restore of one file, or a
  copied file can silently drop recent changes.

## 2. Goals and non-goals

Goals:

1. Opening a copy older than the newest one this Mac has seen for that
   profile needs an explicit choice.
2. Restoring an older backup of the same vault through the app needs an
   explicit confirmation; afterwards the restored state counts as the newest.
3. A missing or damaged record leads to a clear prompt, never to silently
   accepting an older copy of a vault that was tracked. The vault always
   still opens after the user confirms.
4. No new dependencies and no new Keychain prompts.

Non-goals:

- **Both files put back together.** An attacker with the user's file
  access, or a restore of the whole data folder, who earlier saved both the
  vault and its record, can put both back (section 10).
- **Freshness across Macs.** Mnemo has no sync.

## 3. Overview

- **Inside the vault data** (encrypted and authenticated with the vault
  key):
  - `vaultId`: a random UUID, created with the vault;
  - `revision`: an integer, plus one on every write;
  - `savedAt`: the time of that write;
  - `revisionKey`: 32 random bytes.
- **Outside the vault:** one record per profile at
  `<userData>/revisions/<profileId>.json`, laid out like the Touch ID
  files. It is written atomically with mode `0600` and holds
  `{ version: 1, vaultId, revision, mac }`, where `mac` is HMAC-SHA256
  under `revisionKey` of `local-vault:revision-record:v1:<profileId>:
  <vaultId>:<revision>`.
- **The check.** Every time a vault opens, its `vaultId` and `revision` are
  compared with the record (section 5).

## 4. Where the record's integrity comes from (decision R1)

The task names safeStorage or the Keychain. The options:

- **A, recommended: the key is inside the vault (`revisionKey`).**
  - Forging a record needs the vault key.
  - There is no Keychain access, so no new prompts, and nothing breaks when
    Keychain access is denied or safeStorage is unavailable.
- **B: the record, or its key, is sealed with safeStorage.**
  - On ad-hoc builds every update changes the signature, and macOS asks
    again to let Mnemo use its "Safe Storage" item (THREAT_MODEL A8 table).
    Today only Touch ID users see that prompt. With B every user would, after
    every update, and denying it would turn the check off.
  - safeStorage's macOS format is not documented as authenticated (Chromium
    has used AES-CBC without a MAC there), so B needs the same HMAC anyway.
  - It does no better against the attack that remains: an old sealed file
    can be put back as easily as an old HMAC'd one.
- **C, later hardening: a Keychain item updated in place.** This is an item,
  not a file, with an access list that names the app. Putting back an old
  value would then need Keychain access, which closes the gap in section 10.
  Electron has no API for Keychain items, so C needs the small native helper
  that THREAT_MODEL already lists for Touch ID binding and concealed
  clipboard types. It is out of scope here and listed as a follow-up.

## 5. The check on open

Runs after the vault data decrypts, on every path: passphrase, Touch ID,
recovery key.

| Record | Vault | Result |
| --- | --- | --- |
| none | untracked (from before this change, or never saved since) | Open. The first save writes revision 1 and the record. |
| none, or its MAC fails | tracked (`revision` ≥ 1) | "No record" prompt (section 7). A bad MAC never counts as a lower revision. |
| other `vaultId` | any | "Different vault" prompt. |
| `revision` ≤ the vault's | same `vaultId` | Open. The record is raised to the vault's revision. |
| `revision` > the vault's | same `vaultId` | "Older copy" prompt. |

- **The prompts** are native dialogs in main, like the app's other
  confirmations. They show when the copy was saved (`savedAt`) and both
  revisions, in en/de/ru.
- **"Close"** is the default. The vault stays locked and nothing is written.
- **"Open this copy"** opens it. The next save writes revision
  `max(vault, record) + 1`, so the counter never goes down, and the prompt
  does not come back after that save.

## 6. Saving

- **What counts as a write.** Every write of the vault file by the app
  increments `revision` and sets `savedAt`:
  - `persistVaultData`, including the clean-up after unlocking;
  - `rekeyNow`: passphrase change, new recovery key, recovery, and restore
    with the recovery key;
  - `create`;
  - the save after a confirmed restore of an older copy.
- **Order.** The vault file is written first (atomically), then the record
  (atomically).
  - A crash in between leaves the record behind the file; the next open
    accepts that and raises it.
  - The reverse order would cause false alarms.
- **A failed record write** does not fail the save: the vault is already
  written. The record is written again on the next save or open.
- **Export** copies the file as it is, so a backup carries the revision it
  had at export.

## 7. A lost or damaged record

- **When it happens:** Mnemo's data was reset or restored without the
  vault, the vault was moved to another Mac, or someone deleted or altered
  the record.
- **Untracked vault** (the first open after this change ships): no prompt.
- **Tracked vault without a valid record:** a native prompt, "Mnemo has no
  record of this vault's latest version on this Mac".
  - It shows when this copy was saved and its revision.
  - It says when this is expected (a new Mac, reset data) and what it may
    mean otherwise.
  - "Open" creates the record from this copy; "Close" keeps the vault
    locked.
- **No lockout:** the vault always opens after the user confirms.

## 8. Restoring backups

**Restoring over the current profile**, by passphrase or with the recovery
key. After the backup decrypts and before anything is replaced:

- **Same `vaultId`, backup revision below the record:** an explicit
  confirmation in a native dialog, default "Cancel": "This backup is older
  than the vault on this Mac (saved … vs …). Changes made since will be
  lost."
  - Cancel replaces nothing.
  - Confirm restores the backup, then saves it once with revision
    `record + 1`, so the restored state is the newest and the replaced file
    can no longer be taken for a newer copy.
- **Same `vaultId`, backup revision at or above the record:** no extra
  prompt.
- **Different `vaultId`:** no rollback prompt (the existing restore
  confirmation applies); the record is replaced with the backup's.

**Restoring as a new profile** (`restoreProfile`, or `restoreNewProfile`
with the recovery key). Today this writes the backup's vault as it is. Here
it also gets a new `vaultId` and `revisionKey`, written with one save,
because it is a separate vault from then on; two profiles restored from one
backup then do not trip each other's checks.

**Importing items from a backup** into the current vault is not affected.

## 9. Format and migration

- **A schema change.** The four new keys (`vaultId`, `revision`, `savedAt`,
  `revisionKey`) go into the vault data. Recommended (R2): ship them in the
  same schema as task 7 (schema 4), so there is one migration and one
  "saved by a newer version" release (see
  `docs/design-notes-sealing.md`, section 9). Otherwise they need schema 5.
- **Migration.** Unlocking an older schema adds the keys in memory: a new
  `vaultId` and `revisionKey`, and revision 0. The first save writes
  revision 1 and the record. Until then the vault is untracked and no
  prompt appears.
- **`profiles.json`** is not covered. A rolled-back registry can only list
  vaults whose files still exist, and each of those is checked on open.

## 10. Residual risks

- **Old copies of both the vault and its record put back together** are not
  detected. This needs an attacker with the user's file access who copied
  both earlier, or a restore of the whole user data folder. Option C would
  close it.

  **This is an accepted risk (decision R6).** When the code lands,
  THREAT_MODEL records it as such in the A4 row's residual risk and in
  section 7, item 4, with option C as the way to close it.
- **Deleting the record** turns the next open into a prompt. A user who
  chooses "Open" on an older copy accepts it; the prompt shows when the copy
  was saved, to help that choice.
- **Versions before this change** do not check anything.
- **The record file reveals** a vault ID and how many times the vault was
  saved, nothing about its contents.

## 11. Tests

1. **Revision on every write.** It goes up on every save, rekey, and create,
   is stored inside the vault, and `savedAt` follows it.
2. **Order of writes.** The record is written after the vault file. A failed
   record write keeps the save; the next open repairs the record. A test
   that writes the record first must produce a false alarm, which shows the
   order matters.
3. **Older copy:**
   - Copy the vault at revision R, save more, then put the copy back.
   - Unlock with the passphrase, Touch ID, and the recovery key: each shows
     the "older copy" prompt.
   - "Close" leaves the vault locked and the files unchanged.
   - "Open" opens it; the next save writes the old record's revision + 1,
     and the prompt does not come back.
4. **Different vault.** Another vault file in the profile's place gives the
   "different vault" prompt.
5. **Missing or bad record:**
   - Delete the record of a tracked vault: the "no record" prompt; "Open"
     recreates it.
   - An untracked vault: no prompt; the record appears after the first save.
6. **Tampering.** A record with a lowered revision but no valid MAC, a
   flipped bit, or a record copied from another profile is treated as no
   record, never as a lower revision.
7. **Restoring an older backup of the same vault:**
   - Cancel leaves the current vault and its files byte for byte.
   - Confirm restores it at the old record's revision + 1.
   - Both the passphrase path and the recovery key path.
8. **Restoring a backup of a different vault:** no rollback prompt; the
   record follows the restored vault.
9. **Restoring as a new profile:** a new `vaultId` and `revisionKey`, and
   both profiles keep saving without false alarms.
10. **Profiles:**
    - Deleting a profile removes its record.
    - Records of different profiles are independent; the legacy profile
      included.
11. **Migration** from schemas 1–3: untracked until the first save, then
    tracked.
12. **Mutation checks**, each of which must make a test fail:
    - the comparison direction;
    - the order of the writes;
    - skipping the MAC check;
    - restoring without the confirmation;
    - not raising the revision after a confirmed older copy.

## 12. Decisions for approval

- **R1. Integrity of the record:** a key inside the vault (A,
  recommended), safeStorage (B), or later a Keychain item (C, follow-up).
- **R2. Schema:** the same schema 4 as task 7 (recommended), or a separate
  schema 5.
- **R3. A detected older copy:** "Open this copy" after an explicit choice,
  which then becomes the newest (recommended), or always refuse and point to
  restoring a newer backup.
- **R4. A tracked vault with no record:** a confirmation prompt
  (recommended), or silently starting over.
- **R5.** Keep the Keychain item (C) as a follow-up together with the native
  helper for Touch ID binding.
- **R6. The remaining risk is accepted.** Old copies of both the vault and
  its record, put back together, are not detected (section 10). THREAT_MODEL
  states it as an accepted risk, not as an open gap.

## 13. Work plan

1. **With task 7's release N:** the "saved by a newer version" message
   covers this schema change too.
2. **PR: revision tracking:**
   - vault keys, the record store, the check on open, the prompts (en/de/ru),
     and the restore paths;
   - tests 1–12;
   - SECURITY.md;
   - THREAT_MODEL:
     - the A4 row: rollback is detected, and putting back both files is an
       accepted risk;
     - section 7, item 4, with the same accepted risk and option C;
     - review finding 9.
3. **Follow-up:** option C.
