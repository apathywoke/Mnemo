// Validation and upgrades of the decrypted vault data as a whole.
const {
  VAULT_SCHEMA_VERSION,
  ORGANIZED_SCHEMA_VERSION,
  SEALED_SCHEMA_VERSION,
  LEGACY_VAULT_SCHEMA_VERSION,
  MAX_ENTRIES,
} = require("./constants");
const { hasExactKeys } = require("./records");
const { sealPassword, sealNotes } = require("./crypto");
const { isValidItemEntry, isValidLoginEntry, sealedFieldKeys } = require("./entries");
const { isValidFolderList, splitEntry, isValidEntryMeta } = require("./history");

function validateVaultData(value) {
  const version = value?.schemaVersion;
  // Schema 3 and later have folders and per-entry metadata.
  const organized = version >= ORGANIZED_SCHEMA_VERSION;
  if (
    !hasExactKeys(value, organized ? ["schemaVersion", "entries", "folders"] : ["schemaVersion", "entries"]) ||
    ![VAULT_SCHEMA_VERSION, ORGANIZED_SCHEMA_VERSION, SEALED_SCHEMA_VERSION, LEGACY_VAULT_SCHEMA_VERSION].includes(version) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    (organized && !isValidFolderList(value.folders))
  ) {
    return false;
  }
  const context = {
    schemaVersion: version,
    folderIds: new Set(organized ? value.folders.map((folder) => folder.id) : []),
    attachmentIds: new Set(),
  };
  return (
    value.entries.every((entry) => {
      const parts = splitEntry(entry);
      if (!parts || (!organized && Object.keys(parts.meta).length > 0)) return false;
      const contentValid = parts.core.type === "login"
        ? isValidLoginEntry(parts.core, version)
        : version !== LEGACY_VAULT_SCHEMA_VERSION && isValidItemEntry(parts.core, version);
      return contentValid && isValidEntryMeta(parts.meta, parts.core, context);
    }) &&
    new Set(value.entries.map((entry) => entry.id)).size === value.entries.length
  );
}

// Vault data written by a newer version of Mnemo, whose schema this version
// does not know. Telling it apart from damaged data lets the user see that
// the passphrase was right and Mnemo needs an update.
function isFromNewerVersion(value) {
  return Number.isSafeInteger(value?.schemaVersion) && value.schemaVersion > VAULT_SCHEMA_VERSION;
}

// Schema 3 → 4: seals the notes and sealed item fields (a secure note's body)
// of an entry and of every version in its history. Equal text within one
// entry is sealed once and shared, so history comparisons, which compare
// sealed records, see no change where there was none. Empty text stays ""
// (and an empty item field is left out).
function sealEntryText(entry, dataKey) {
  const sealed = new Map();
  const seal = (text, field) => {
    const cacheKey = `${field}\n${text}`;
    if (!sealed.has(cacheKey)) sealed.set(cacheKey, sealNotes(text, dataKey, entry.id, field));
    return sealed.get(cacheKey);
  };
  const fieldKeys = entry.type === "login" ? [] : sealedFieldKeys(entry.type);
  const sealContent = (content) => {
    const next = { ...content, notes: content.notes === "" ? "" : seal(content.notes, "notes") };
    if (fieldKeys.length > 0) {
      next.fields = { ...content.fields };
      for (const key of fieldKeys) {
        if (!Object.hasOwn(next.fields, key)) continue;
        if (next.fields[key] === "") delete next.fields[key];
        else next.fields[key] = seal(next.fields[key], key);
      }
    }
    return next;
  };
  const next = sealContent(entry);
  if (entry.history) next.history = entry.history.map(sealContent);
  return next;
}

function upgradeVaultData(vaultData, dataKey) {
  let upgraded = vaultData;
  if (upgraded.schemaVersion === LEGACY_VAULT_SCHEMA_VERSION) {
    // The legacy password strings already exist in memory after parsing;
    // this seals them so later reads go through revealPassword().
    upgraded = {
      schemaVersion: SEALED_SCHEMA_VERSION,
      entries: upgraded.entries.map((entry) => ({
        ...entry,
        password: sealPassword(entry.password, dataKey, entry.id),
      })),
    };
  }
  if (upgraded.schemaVersion === SEALED_SCHEMA_VERSION) {
    // Schema 3 only adds optional data.
    upgraded = { schemaVersion: ORGANIZED_SCHEMA_VERSION, entries: upgraded.entries, folders: [] };
  }
  if (upgraded.schemaVersion === ORGANIZED_SCHEMA_VERSION) {
    // The plain note strings parsed from schema 3 cannot be wiped (they are
    // JavaScript strings); they are dropped here. The next save writes
    // schema 4, and later unlocks no longer create them.
    upgraded = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      entries: upgraded.entries.map((entry) => sealEntryText(entry, dataKey)),
      folders: upgraded.folders,
    };
  }
  return upgraded;
}

module.exports = {
  validateVaultData,
  isFromNewerVersion,
  upgradeVaultData,
};
