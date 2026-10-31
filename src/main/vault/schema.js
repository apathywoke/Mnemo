// Validation and upgrades of the decrypted vault data as a whole.
const {
  VAULT_SCHEMA_VERSION,
  SEALED_SCHEMA_VERSION,
  LEGACY_VAULT_SCHEMA_VERSION,
  MAX_ENTRIES,
} = require("./constants");
const { hasExactKeys } = require("./records");
const { sealPassword } = require("./crypto");
const { isValidItemEntry, isValidLoginEntry } = require("./entries");
const { isValidFolderList, splitEntry, isValidEntryMeta } = require("./history");

function validateVaultData(value) {
  const version = value?.schemaVersion;
  const isCurrent = version === VAULT_SCHEMA_VERSION;
  if (
    !hasExactKeys(value, isCurrent ? ["schemaVersion", "entries", "folders"] : ["schemaVersion", "entries"]) ||
    ![VAULT_SCHEMA_VERSION, SEALED_SCHEMA_VERSION, LEGACY_VAULT_SCHEMA_VERSION].includes(version) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    (isCurrent && !isValidFolderList(value.folders))
  ) {
    return false;
  }
  const context = {
    folderIds: new Set(isCurrent ? value.folders.map((folder) => folder.id) : []),
    attachmentIds: new Set(),
  };
  return (
    value.entries.every((entry) => {
      const parts = splitEntry(entry);
      if (!parts || (!isCurrent && Object.keys(parts.meta).length > 0)) return false;
      const contentValid = parts.core.type === "login"
        ? isValidLoginEntry(parts.core, version)
        : version !== LEGACY_VAULT_SCHEMA_VERSION && isValidItemEntry(parts.core);
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
    // Schema 3 only adds optional data; the next save writes it.
    upgraded = { schemaVersion: VAULT_SCHEMA_VERSION, entries: upgraded.entries, folders: [] };
  }
  return upgraded;
}

module.exports = {
  validateVaultData,
  isFromNewerVersion,
  upgradeVaultData,
};
