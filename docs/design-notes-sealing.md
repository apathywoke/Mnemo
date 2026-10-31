# Design: sealing notes per entry

Status: approved plan (stage 3, task 7), not implemented. The owner
approved the decisions in section 12 as recommended on 2026-10-31.

## 1. What happens today

- **Where notes live.** Every entry (logins and all item types) has `notes`,
  up to 16,384 characters, stored as a plain string inside the vault data.
  The vault data is one AES-256-GCM record in the file
  (`getAad("vault-data", header)`), so notes are encrypted at rest, but
  unlocking decrypts all of them at once: from then on every note, current
  and historical, is a plain string in main-process memory.
- **Secure notes.** The `note` item type keeps its text in `fields.body`
  (up to 65,536 characters), a plain field like a card's cardholder name.
  - THREAT_MODEL's data table already records this: "Secure note text and
    identity details are not sealed separately and reach the renderer when
    the item is opened."
  - Identity details (name, email, phone, address, birth date) are plain
    fields too; of an identity, only the document number is sealed.
- **What is sealed.** Passwords, one-time code settings, and secret item
  fields are each sealed with the vault key, with AAD that binds them to
  their entry, and are decrypted only in main, on copy or reveal:
  - `local-vault:entry-password:v2:<entryId>`
  - `local-vault:entry-totp:v2:<entryId>`
  - `local-vault:item-secret:v2:<entryId>:<field>`
- **What reaches the renderer.**
  - `listEntries` sends no notes.
  - `getEntry` sends the entry's notes, and a secure note's body, as plain
    text.
  - `getHistory` sends the notes of every earlier version of that entry.
  - A compromised renderer can call these for every ID (THREAT_MODEL A3;
    section 7, item 2).
- **Search** runs in the renderer
  (`src/renderer/entities/login/model/login.js`) over name, username,
  website, and subtitle. Notes are not searched.
- **History.**
  - `snapshotOf` copies `notes` into each version.
  - `contentChanged` and `versionChanges` compare notes as strings, and
    sealed values as records. Comparing records works because an unchanged
    value keeps its record (`resealedPassword`).
- **Backups** are copies of the encrypted vault file (`exportBackup`), so a
  backup keeps the schema the file had when it was made.

## 2. Goals and non-goals

Goals:

1. Unlocking decrypts no notes. A note is decrypted in main only when that
   entry is opened, saved, read for import, or rekeyed.
2. Each sealed note is bound to its entry, so it cannot be moved to another
   entry unnoticed (as passwords are).
3. Existing vaults migrate without user action, on the next save, and a
   failed save loses nothing.
4. An older version of Mnemo refuses a migrated vault with a clear message,
   not with "check the master passphrase".

Non-goals:

- **At-rest protection does not change.** The vault data is already
  encrypted under the vault key, so an offline attacker (A1) gains or loses
  nothing.
- **Search in notes** (section 7).
- **Hiding notes from the renderer** the user is working in. Section 8 says
  what can and cannot be done there.

## 3. Format

- **Schema 4.** The vault data schema goes from 3 to 4
  (`VAULT_SCHEMA_VERSION`). The file envelope (format 2: header, key wrap,
  recovery wrap) does not change: the schema lives inside the encrypted
  data, as it did for the 1→2 and 2→3 changes. CLAUDE.md asks to keep the
  format, AAD strings, and crypto parameters unless a task says otherwise;
  this task asks for a new format version, and every existing AAD string
  stays as it is.
- **Value.** In schema 4, `notes` is either `""` (no notes) or a sealed
  record with the shape of a sealed password:
  `{ name: "aes-256-gcm", nonce, tag, ciphertext }`. History versions
  follow the same rule.
  - Schema 4 refuses a non-empty plain string.
  - Schemas 1–3 refuse a sealed record.
- **AAD:** `local-vault:entry-notes:v4:<entryId>:notes`, built like
  `getPasswordAad`.
  - **`entry-notes`, not `item-notes`.** Notes exist on logins and items
    alike. Existing labels use `entry-` for values every entry can have,
    and `item-secret` for fields of item types.
  - **`v4`.** constants.js says "sealed values keep the label of the schema
    that introduced them", so a value new in schema 4 is labeled `v4`, and
    the existing `v2` values are not touched.
  - **The trailing field name** leaves room for a secure note's text
    (`:body`, decision D2) under the same purpose.
- **Size.** A sealed note is the base64 of its UTF-8 bytes plus a 12-byte
  nonce and a 16-byte tag: about 4/3 of the text plus roughly 90 bytes of
  JSON.
  - Validation caps the ciphertext at 16,384 × 3 bytes, like
    `MAX_SEALED_PASSWORD_BYTES`.
  - The 10 MB plaintext limit stays; `pruneHistory` already drops the
    oldest versions first.
- **Empty notes stay `""`.** Sealing an empty string would cost space and
  would not hide anything, since the renderer learns whether there are
  notes anyway.

## 4. Reading and writing (main process)

New helpers in `src/main/vault/crypto.js`, next to the password ones:
`getNotesAad(entryId, field)`, `sealNotes`, and `openNotes`. As elsewhere,
the plaintext Buffer is zeroed in `finally`.

- **Unlock:** unchanged; notes stay sealed in `vaultData`.
- **`getEntry(id)`** opens that entry's notes and returns them as today
  (decision D3 may change this).
  - A record that does not open gives a new error, `errors.notesDamaged`
    (en/de/ru), for that entry only; the rest of the vault keeps working.
- **Saving (`saveEntry`, `saveItem`)** uses `resealedNotes(existing, id,
  notes)`, which works like `resealedPassword`:
  - text equal to the opened current notes keeps the record, so it is not a
    change and adds no history version;
  - empty text gives `""`.
- **`importLogins`** seals notes as it creates entries.
- **`readBackupLogins`** (importing a Mnemo backup) opens the backup's
  notes with the backup's key.
- **`restoreVersion`** reuses the version's record, which is bound to the
  same entry.
- **Rekeying** (`rekeyNow`) runs on a passphrase change, a new recovery
  key, recovery, and restore with the recovery key. `resealContent` reseals
  notes like passwords, and its cache keeps a record shared by several
  versions as one record.
- **Unchanged:** `listEntries`, site icons, folders, the trash, and Reports.

## 5. Migration on the next save

- **New step 3 → 4** in `upgradeVaultData`, after the existing 1 → 2 and
  2 → 3 steps. It seals every non-empty `notes` of every entry and every
  history version under the vault key. Equal text within one entry's
  versions is sealed once and shared, so history comparisons stay right.
- **When.** As with the existing upgrades, this runs in memory:
  - on every unlock (passphrase, Touch ID, recovery key);
  - whenever a backup is read.
- **Writing.**
  - The next save (`persistVaultData`) writes schema 4 atomically (temp
    file, then rename).
  - Until then the file stays schema 3 and still opens in older versions.
- **Cost.** One AES-GCM operation per distinct note. 10,000 entries with 20
  versions each should take well under a second; the PR measures it.
- **Leftover plaintext.** The plain strings parsed from schema 3 data cannot
  be zeroed (they are JavaScript strings); they are dropped after the
  upgrade. After the first schema 4 save, unlocking no longer creates them.

## 6. History

- **Snapshots** keep the sealed record, as for passwords.
- **Comparisons.** `contentChanged` and `versionChanges` compare notes with
  `sameSealed` instead of `!==`. This is correct because:
  - an unchanged note keeps its record (section 4);
  - the upgrade shares records between versions with equal text (section 5).
- **The history panel.** `getHistory` opens the notes of that one entry's
  versions, as `getEntry` does for the entry. With D3b, versions report
  `hasNotes` instead, and the text is revealed the same way as the current
  notes.
- **Validation.** `isValidSnapshot` validates notes for the vault's schema;
  today it validates snapshots as schema 2.

## 7. Search

Nothing changes: search runs in the renderer over `listEntries` metadata,
and notes were never part of it.

Searching notes would make main open every note for every query and answer
"does entry X contain Y?". A compromised renderer could use that as an
oracle and read notes character by character. If notes search is ever
wanted, it has to be treated as reading notes (gated like D3b), not as
metadata.

## 8. The renderer (decision D3)

Sealing changes what main holds, not what the renderer may ask for. As long
as `getEntry` returns notes, a compromised renderer can read every note, one
call at a time, exactly as today.

- **D3a (recommended for this task): `getEntry` keeps returning notes.**
  THREAT_MODEL section 7, item 2 becomes "Partly done": notes are no longer
  decrypted with the index, and renderer exposure is unchanged.
- **D3b (a follow-up PR): notes are revealed only after real user input.**
  - `getEntry` returns `hasNotes`; the detail view shows "Show notes", and
    editing starts with the same call.
  - Main answers `notes:reveal` only right after user input it saw itself
    (the `webContents` `input-event`, which page scripts cannot fake), and
    only one reveal per input.
  - **Effect:** a compromised renderer cannot read notes while the user is
    idle, but can still take one note per real click or key press.
  - **Cost:** notes are one click away, and there is more IPC and test code.

## 9. Compatibility and rollback

- **Older versions cannot read schema 4.** Today they would report "Could
  not open the vault. Check the master passphrase…", which is wrong and
  alarming. So the change ships in two releases (decision D4):
  - **Release N, before the change.** `decryptVaultFile` tells apart "the
    data decrypted, but its schema is newer than this version knows" and
    reports `errors.vaultFromNewerVersion` ("This vault was saved by a newer
    version of Mnemo. Update Mnemo to open it.", en/de/ru). This covers
    vault files, backups, and the Touch ID path, which today replaces every
    error with its own message.
  - **Release N+1:** schema 4.

  Going back from N+1 to N then gives the right message; versions before N
  still give the old one.
- **No automatic way back.** N+1 never writes schema 3. A user who must
  return to an older version can restore a backup made before the migration
  (backups keep their schema) and loses the changes made since.
- **A failed migrating save** leaves the schema 3 file as it was (atomic
  write), and the next save tries again.
- **Restoring an older backup into N+1:**
  - by passphrase, the backup file is written as it is (schema 1–3) and
    migrated on the next save;
  - with the recovery key, the vault is rekeyed and written as schema 4 at
    once.
- **A damaged note record** affects only its entry (section 4).
- **The updater never installs an older version**, so going back is always
  a manual reinstall.

## 10. Tests

Migration:

1. **A schema 3 fixture from the current release.** It is committed and
   holds notes on logins, cards, secure notes, identities, and SSH keys, in
   history versions, and on items in the trash.
   - It unlocks with N+1 and every note reads back unchanged.
   - The file stays schema 3 until a save.
   - After one save (a favorite toggle, say), the raw file decrypts to
     schema 4, with every non-empty note sealed and `""` for empty ones.
2. **The same from schemas 1 and 2** (built with `persistVaultData`, as
   existing tests do), and through Touch ID and recovery-key unlock.
3. **History survives:**
   - versions whose notes differ are still reported as changed, and equal
     ones are not;
   - versions that had the same text share one record.
4. **Saving:**
   - the same text keeps the record and adds no version;
   - changed text adds one;
   - cleared text stores `""`.
5. **AAD binding.** A note record moved to another entry, or to a version of
   another entry, does not open. That entry gives `errors.notesDamaged`, and
   the others still open.
6. **Rekeying** (passphrase change, new recovery key, recovery, restore with
   the recovery key):
   - reseals notes under the new key;
   - keeps shared records shared;
   - leaves none that opens with the old key.
7. **Import** from CSV and from schema 3 and 4 Mnemo backups gives the same
   notes, sealed.
8. **Validation:**
   - schema 4 refuses a plain non-empty `notes`, and a record of the wrong
     shape or over the size limit;
   - schemas 1–3 refuse a sealed `notes`.
9. **Size.** A vault close to 10 MB of notes still saves; history is pruned
   first.

Rollback:

10. **Failed migrating save.** A write that fails during the migrating save
    (stubbed rename) leaves the schema 3 file byte for byte, and it unlocks
    with both N and N+1.
11. **Release N:**
    - refuses a schema 4 vault and a schema 4 backup with
      `errors.vaultFromNewerVersion`, not with the passphrase message;
    - a wrong passphrase still gives the passphrase message.
12. **Pre-migration backup.** It restores into N+1 by both the passphrase
    path and the recovery key path, and migrates as in test 1.
13. **Mutation checks**, each of which must make a test fail:
    - the AAD;
    - the upgrade step;
    - `sameSealed` in history;
    - keeping the record when the text is unchanged.

## 11. Documentation changes (with the code)

- **SECURITY.md:** what is sealed.
- **docs/THREAT_MODEL.md:**
  - the data table and A3;
  - section 7, item 2: "Partly done" with D3a, "Done" with D3b;
  - a section 9 trigger for format changes.
- **CLAUDE.md:** schema 4 and the AAD list.

## 12. Decisions (approved as recommended, 2026-10-31)

Approved choices: D1 `entry-notes`; D2 seal a secure note's text too; D3a
in this change, with D3b as a follow-up; D4 two releases.

- **D1. AAD.** `local-vault:entry-notes:v4:<entryId>:notes`, rather than
  `item-notes`.
- **D2. Secure note text.** Also seal it: `fields.body` becomes a sealed
  record with `:body`, decrypted for display like notes.
  - Recommended: yes, in the same schema 4. Otherwise the item called
    "secure note" stays the least protected text in the vault.
  - The PR will describe how the item schema marks such a field.
  - With D2, the THREAT_MODEL data row changes to match.
  - Identity details stay as they are. Name and email are list and search
    metadata; the other fields could follow the same pattern later.
- **D3. Renderer exposure.** D3a now and D3b as a follow-up (recommended),
  or D3b in the same change.
- **D4. Two releases.** N with the newer-schema message, then N+1 with
  schema 4. Recommended: yes.

## 13. Work plan

1. **PR for release N:** detection of a newer schema and its message;
   test 11.
2. **PR for release N+1, schema 4:**
   - helpers, migration, history, rekeying, import, and validation;
   - tests 1–10, 12, and 13;
   - the documentation changes.
3. **Optional PR:** D3b.
