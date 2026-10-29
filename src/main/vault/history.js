// Folders, favorites, trash, and history: the per-entry metadata.
const {
  randomUUID,
} = require("node:crypto");
const { ITEM_TYPES } = require("../../renderer/shared/item-types");
const {
  SEALED_SCHEMA_VERSION,
  UUID_PATTERN,
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  HISTORY_LIMIT,
  MAX_ATTACHMENTS_PER_ENTRY,
  META_KEYS,
} = require("./constants");
const { isPlainObject, hasExactKeys } = require("./records");
const { isValidAttachment } = require("./attachments");
const { isValidItemEntry, isValidLoginEntry } = require("./entries");

// --- Folders, history, and other per-entry metadata ---------------------------------

function normalizeFolderName(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Enter a folder name.");
  const name = input.normalize("NFC").trim();
  if (name.length > MAX_FOLDER_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Folder names must be 1–100 characters long.");
  }
  return name;
}

function isValidFolder(folder) {
  if (
    !hasExactKeys(folder, ["id", "name", "createdAt"]) ||
    typeof folder.id !== "string" ||
    !UUID_PATTERN.test(folder.id) ||
    !Number.isSafeInteger(folder.createdAt) ||
    folder.createdAt <= 0
  ) {
    return false;
  }
  try {
    return normalizeFolderName(folder.name) === folder.name;
  } catch {
    return false;
  }
}

function isValidFolderList(folders) {
  return (
    Array.isArray(folders) &&
    folders.length <= MAX_FOLDERS &&
    folders.every(isValidFolder) &&
    new Set(folders.map((folder) => folder.id)).size === folders.length &&
    new Set(folders.map((folder) => folder.name.toLowerCase())).size === folders.length
  );
}

// A version in an entry's history keeps the content fields as they were,
// with sealed values reused as they are (still bound to the same entry).
const LOGIN_SNAPSHOT_KEYS = Object.freeze(["id", "savedAt", "updatedAt", "name", "username", "url", "notes", "password"]);
const ITEM_SNAPSHOT_KEYS = Object.freeze(["id", "savedAt", "updatedAt", "name", "notes", "fields", "secrets"]);

function isValidSnapshot(snapshot, entry) {
  if (
    !isPlainObject(snapshot) ||
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !Number.isSafeInteger(snapshot.savedAt) ||
    !Number.isSafeInteger(snapshot.updatedAt) ||
    snapshot.savedAt < snapshot.updatedAt
  ) {
    return false;
  }
  const { id: _versionId, savedAt: _savedAt, ...content } = snapshot;
  if (entry.type === "login") {
    const keys = Object.hasOwn(snapshot, "totp") ? [...LOGIN_SNAPSHOT_KEYS, "totp"] : LOGIN_SNAPSHOT_KEYS;
    return hasExactKeys(snapshot, keys) &&
      isValidLoginEntry({ ...content, id: entry.id, type: "login", createdAt: entry.createdAt }, SEALED_SCHEMA_VERSION);
  }
  return hasExactKeys(snapshot, ITEM_SNAPSHOT_KEYS) &&
    isValidItemEntry({ ...content, id: entry.id, type: entry.type, createdAt: entry.createdAt });
}

// Splits a stored entry into its content (validated by type) and metadata.
function splitEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const core = {};
  const meta = {};
  for (const [key, value] of Object.entries(entry)) {
    if (META_KEYS.includes(key)) meta[key] = value;
    else core[key] = value;
  }
  return { core, meta };
}

// `context` carries the vault's folder IDs and collects attachment IDs, which
// must be unique across the vault (they name the files).
function isValidEntryMeta(meta, core, context) {
  for (const [key, value] of Object.entries(meta)) {
    if (key === "folderId" && !(typeof value === "string" && context.folderIds.has(value))) return false;
    if (key === "favorite" && value !== true) return false;
    if (key === "deletedAt" && !(Number.isSafeInteger(value) && value > 0)) return false;
    if (key === "attachments") {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS_PER_ENTRY) return false;
      for (const attachment of value) {
        if (!isValidAttachment(attachment) || context.attachmentIds.has(attachment.id)) return false;
        context.attachmentIds.add(attachment.id);
      }
    }
    if (
      key === "history" &&
      (!Array.isArray(value) ||
        value.length === 0 ||
        value.length > HISTORY_LIMIT ||
        !value.every((snapshot) => isValidSnapshot(snapshot, core)) ||
        new Set(value.map((snapshot) => snapshot.id)).size !== value.length)
    ) {
      return false;
    }
  }
  return true;
}

function metaOf(entry) {
  const meta = {};
  for (const key of META_KEYS) {
    if (entry && Object.hasOwn(entry, key)) meta[key] = entry[key];
  }
  return meta;
}

// Rebuilds `entry` with the metadata of `source`, updated by `changes`.
// Default values (no folder, false, null, empty lists) are left out.
function withMeta(entry, source, changes = {}) {
  const result = { ...entry };
  for (const key of META_KEYS) delete result[key];
  const meta = { ...metaOf(source), ...changes };
  if (meta.folderId) result.folderId = meta.folderId;
  if (meta.favorite === true) result.favorite = true;
  if (meta.deletedAt) result.deletedAt = meta.deletedAt;
  if (meta.attachments?.length) result.attachments = meta.attachments;
  if (meta.history?.length) result.history = meta.history;
  return result;
}

function snapshotOf(entry, now) {
  const base = {
    id: randomUUID(),
    savedAt: Math.max(now, entry.updatedAt),
    updatedAt: entry.updatedAt,
    name: entry.name,
    notes: entry.notes,
  };
  if (entry.type === "login") {
    const snapshot = { ...base, username: entry.username, url: entry.url, password: entry.password };
    if (entry.totp) snapshot.totp = entry.totp;
    return snapshot;
  }
  return { ...base, fields: { ...entry.fields }, secrets: { ...entry.secrets } };
}

// The current content goes to the top of the history; the oldest versions
// beyond the limit are dropped.
function historyAfterChange(entry, now) {
  return [snapshotOf(entry, now), ...(entry.history ?? [])].slice(0, HISTORY_LIMIT);
}

function sameSealed(left, right) {
  return left === right || (Boolean(left) && Boolean(right) && JSON.stringify(left) === JSON.stringify(right));
}

function sameRecord(left, right, same) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key) || !same(left[key], right[key])) return false;
  }
  return true;
}

// Whether a save changes what the entry contains (not its folder, favorite,
// icon, or attachments). Unchanged sealed values are reused, so comparing
// the sealed records is enough.
function contentChanged(previous, next) {
  if (previous.name !== next.name || previous.notes !== next.notes) return true;
  if (previous.type === "login") {
    return previous.username !== next.username ||
      previous.url !== next.url ||
      !sameSealed(previous.password, next.password) ||
      !sameSealed(previous.totp, next.totp);
  }
  return !sameRecord(previous.fields, next.fields, (left, right) => left === right) ||
    !sameRecord(previous.secrets, next.secrets, sameSealed);
}

// Which fields differ between an earlier version and the one that replaced it.
function versionChanges(entry, version, newer) {
  const changes = ["name", "notes"].filter((key) => version[key] !== newer[key]);
  if (entry.type === "login") {
    for (const key of ["username", "url"]) {
      if (version[key] !== newer[key]) changes.push(key);
    }
    if (!sameSealed(version.password, newer.password)) changes.push("password");
    if (!sameSealed(version.totp, newer.totp)) changes.push("totp");
    return changes;
  }
  for (const field of ITEM_TYPES[entry.type].fields) {
    const changed = field.kind === "secret"
      ? !sameSealed(version.secrets[field.key], newer.secrets[field.key])
      : (version.fields[field.key] ?? "") !== (newer.fields[field.key] ?? "");
    if (changed) changes.push(field.key);
  }
  return changes;
}

function toVersionSummary(entry, version, newer) {
  const summary = {
    id: version.id,
    savedAt: version.savedAt,
    updatedAt: version.updatedAt,
    name: version.name,
    notes: version.notes,
    changes: versionChanges(entry, version, newer),
  };
  if (entry.type === "login") {
    return {
      ...summary,
      username: version.username,
      url: version.url,
      secretFields: ["password"],
      hasTotp: Boolean(version.totp),
    };
  }
  return { ...summary, fields: { ...version.fields }, secretFields: Object.keys(version.secrets) };
}

// Old versions go first when the vault would exceed its size limit, oldest
// first, so a save never fails because of history alone.
function pruneHistory(vaultData, fraction) {
  const versions = [];
  for (const entry of vaultData.entries) {
    for (const version of entry.history ?? []) versions.push(version);
  }
  if (versions.length === 0) return null;
  versions.sort((left, right) => left.savedAt - right.savedAt);
  const dropped = new Set(versions.slice(0, Math.max(1, Math.ceil(versions.length * fraction))));
  return {
    ...vaultData,
    entries: vaultData.entries.map((entry) =>
      entry.history?.some((version) => dropped.has(version))
        ? withMeta(entry, entry, { history: entry.history.filter((version) => !dropped.has(version)) })
        : entry),
  };
}

module.exports = {
  normalizeFolderName,
  isValidFolder,
  isValidFolderList,
  LOGIN_SNAPSHOT_KEYS,
  ITEM_SNAPSHOT_KEYS,
  isValidSnapshot,
  splitEntry,
  isValidEntryMeta,
  metaOf,
  withMeta,
  snapshotOf,
  historyAfterChange,
  sameSealed,
  sameRecord,
  contentChanged,
  versionChanges,
  toVersionSummary,
  pruneHistory,
};
