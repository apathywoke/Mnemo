const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomUUID,
  randomBytes,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");

const { generateTotp, parseTotpInput, toOtpauthUri } = require("./totp");
const { ITEM_TYPES } = require("./src/renderer/shared/item-types");
const { describeSshKey, isPrivateKey } = require("./ssh-keys");
const cardTools = require("./src/renderer/shared/lib/card-tools");
const { estimatePasswordStrength } = require("./src/renderer/shared/lib/password-tools");
const { openVaultSource, readContainerFile, writeContainer } = require("./backup-file");
const {
  FORMAT_VERSION,
  VAULT_SCHEMA_VERSION,
  SEALED_SCHEMA_VERSION,
  LEGACY_VAULT_SCHEMA_VERSION,
  KEY_BYTES,
  SALT_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  MAX_FILE_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ENTRIES,
  MAX_FAVICON_BYTES,
  MAX_FAVICON_BASE64_LENGTH,
  PNG_SIGNATURE,
  ENTRY_LIMITS,
  TEXT_FIELDS,
  UUID_PATTERN,
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  HISTORY_LIMIT,
  TRASH_RETENTION_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME,
  META_KEYS,
} = require("./src/main/vault/constants");
const { isPlainObject, hasExactKeys, decodeBase64 } = require("./src/main/vault/records");
const { decodeRecoveryKey, deriveRecoveryWrappingKey } = require("./src/main/vault/recovery-key");
const {
  encryptGcm,
  decryptGcm,
  getTotpAad,
  sealTotp,
  openTotp,
  getPasswordAad,
  sealPassword,
  openPassword,
  isValidSealedPassword,
  deriveWrappingKey,
  getItemSecretAad,
  sealItemSecret,
  openItemSecret,
} = require("./src/main/vault/crypto");
const {
  headerOf,
  getAad,
  validatePassphrase,
  validateNewPassphrase,
  makeEnvelope,
  isGcmRecord,
  parseEnvelope,
} = require("./src/main/vault/envelope");

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

// Cards, notes, identities, and SSH keys share one shape: plain `fields`
// (including values derived on save) and per-field sealed `secrets`.
const ITEM_ENTRY_KEYS = Object.freeze([
  "id", "type", "name", "notes", "fields", "secrets", "createdAt", "updatedAt",
]);
const MAX_ITEM_NAME = 200;
const MAX_DERIVED_LENGTH = 16384;

function itemSchema(type) {
  const schema = ITEM_TYPES[type];
  return {
    plain: new Map(schema.fields.filter((field) => field.kind !== "secret").map((field) => [field.key, field])),
    secret: new Map(schema.fields.filter((field) => field.kind === "secret").map((field) => [field.key, field])),
    derived: new Set(schema.derived),
  };
}

function isValidItemEntry(entry) {
  if (
    !hasExactKeys(entry, ITEM_ENTRY_KEYS) ||
    !Object.hasOwn(ITEM_TYPES, entry.type) ||
    !UUID_PATTERN.test(entry.id) ||
    typeof entry.name !== "string" ||
    !entry.name.trim() ||
    entry.name.length > MAX_ITEM_NAME ||
    typeof entry.notes !== "string" ||
    entry.notes.length > ENTRY_LIMITS.notes ||
    !Number.isSafeInteger(entry.createdAt) ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.createdAt <= 0 ||
    entry.updatedAt < entry.createdAt ||
    !isPlainObject(entry.fields) ||
    !isPlainObject(entry.secrets)
  ) {
    return false;
  }
  const schema = itemSchema(entry.type);
  return (
    Object.entries(entry.fields).every(([key, value]) =>
      typeof value === "string" &&
      (schema.plain.has(key)
        ? value.length <= schema.plain.get(key).max
        : schema.derived.has(key) && value.length <= MAX_DERIVED_LENGTH)) &&
    Object.entries(entry.secrets).every(([key, value]) =>
      schema.secret.has(key) && isValidSealedPassword(value))
  );
}

// --- Attachments ----------------------------------------------------------------
//
// Each attachment is a file next to the vault (<vault>.attachments/<id>.bin),
// encrypted with its own random key. That key is sealed under the vault key,
// bound to the entry and attachment IDs, and kept with the attachment's name
// and size inside the encrypted vault data. A file on its own reveals only
// its size. Files never change after they are written.
const ATTACHMENT_MAGIC = Buffer.from("MNEMOAT1", "ascii");
const ATTACHMENT_OVERHEAD = ATTACHMENT_MAGIC.length + NONCE_BYTES + TAG_BYTES;

function getAttachmentKeyAad(entryId, attachmentId) {
  return Buffer.from(`local-vault:attachment-key:v1:${entryId}:${attachmentId}`, "utf8");
}

function getAttachmentFileAad(attachmentId) {
  return Buffer.from(`local-vault:attachment-file:v1:${attachmentId}`, "utf8");
}

function sealAttachmentKey(fileKey, dataKey, entryId, attachmentId) {
  return encryptGcm(fileKey, dataKey, getAttachmentKeyAad(entryId, attachmentId));
}

function openAttachmentKey(record, dataKey, entryId, attachmentId) {
  return decryptGcm(record, dataKey, getAttachmentKeyAad(entryId, attachmentId), KEY_BYTES);
}

// File layout: magic (8) | nonce (12) | tag (16) | ciphertext.
function encryptAttachment(plaintext, fileKey, attachmentId) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", fileKey, nonce);
  cipher.setAAD(getAttachmentFileAad(attachmentId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ATTACHMENT_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptAttachment(fileBytes, fileKey, attachmentId, expectedSize) {
  if (
    fileBytes.length !== ATTACHMENT_OVERHEAD + expectedSize ||
    !fileBytes.subarray(0, ATTACHMENT_MAGIC.length).equals(ATTACHMENT_MAGIC)
  ) {
    throw new Error("Invalid attachment");
  }
  const nonceStart = ATTACHMENT_MAGIC.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", fileKey, fileBytes.subarray(nonceStart, tagStart));
  decipher.setAAD(getAttachmentFileAad(attachmentId));
  decipher.setAuthTag(fileBytes.subarray(tagStart, ATTACHMENT_OVERHEAD));
  return Buffer.concat([decipher.update(fileBytes.subarray(ATTACHMENT_OVERHEAD)), decipher.final()]);
}

// Shortens to at most `max` UTF-16 units without splitting a surrogate pair.
function truncateUnits(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// A safe display and save-as name taken from the original file name.
function normalizeAttachmentName(rawName) {
  let name = String(rawName ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").trim();
  if (!name || name === "." || name === "..") name = "attachment";
  if (name.length > MAX_ATTACHMENT_NAME) {
    const extension = path.extname(name).slice(0, 16);
    name = `${truncateUnits(name.slice(0, name.length - extension.length), MAX_ATTACHMENT_NAME - extension.length)}${extension}`;
  }
  return name;
}

function isValidSealedKey(record) {
  if (!isGcmRecord(record)) return false;
  try {
    decodeBase64(record.nonce, NONCE_BYTES, NONCE_BYTES);
    decodeBase64(record.tag, TAG_BYTES, TAG_BYTES);
    decodeBase64(record.ciphertext, KEY_BYTES, KEY_BYTES);
    return true;
  } catch {
    return false;
  }
}

function isValidAttachment(value) {
  return (
    hasExactKeys(value, ["id", "name", "size", "key", "createdAt"]) &&
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    normalizeAttachmentName(value.name) === value.name &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= MAX_ATTACHMENT_BYTES &&
    isValidSealedKey(value.key) &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt > 0
  );
}

function toAttachmentSummary(attachment) {
  return { id: attachment.id, name: attachment.name, size: attachment.size, createdAt: attachment.createdAt };
}

// Every attachment in a vault, with the entry it belongs to.
function attachmentsOf(vaultData) {
  return vaultData.entries.flatMap((entry) =>
    (entry.attachments ?? []).map((attachment) => ({ entryId: entry.id, attachment })));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Reads a whole file, refusing anything larger than `limit` bytes even if it
// grows while being read.
async function readFileWithLimit(filePath, limit) {
  const handle = await fs.open(filePath, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  const chunks = [];
  let total = 0;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("invalid");
    if (stats.size > limit) throw Object.assign(new Error("invalid"), { tooLarge: true });
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw Object.assign(new Error("invalid"), { tooLarge: true });
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    chunk.fill(0);
    for (const part of chunks) part.fill(0);
    await handle.close();
  }
}

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

// Per-type checks and normalization for values typed into the editor.
const ITEM_NORMALIZERS = Object.freeze({
  card: {
    // Same rules as the editor (card-tools.js): known lengths and a valid
    // check digit. Expired dates are allowed; old cards may be kept.
    number(value) {
      if (/[^\d\s-]/.test(value)) throw new Error("Enter a valid card number.");
      const digits = cardTools.digitsOnly(value);
      if (digits && cardTools.numberStatus(digits) !== "complete") {
        throw new Error("Enter a valid card number.");
      }
      return digits;
    },
    expiry(value) {
      if (!value.trim()) return "";
      const formatted = cardTools.formatExpiry(value);
      const status = cardTools.expiryStatus(formatted);
      if (status !== "complete" && status !== "expired") {
        throw new Error("Enter the expiry date as MM/YY.");
      }
      return formatted;
    },
    cvv(value) {
      if (value && !/^\d{3,4}$/.test(value)) throw new Error("The security code must be 3 or 4 digits.");
      return value;
    },
    pin(value) {
      if (value && !/^\d{4,12}$/.test(value)) throw new Error("The PIN must be 4 to 12 digits.");
      return value;
    },
  },
  ssh: {
    privateKey(value) {
      const text = value.trim();
      if (text && !isPrivateKey(text)) throw new Error("Paste the private key in OpenSSH or PEM format.");
      return text ? `${text}\n` : "";
    },
  },
});

// `fields` holds every editable field as a string. For secret fields an empty
// string keeps the stored value, so the editor never needs to read secrets.
function normalizeItemInput(input) {
  const required = ["id", "type", "name", "notes", "fields"];
  if (
    !isPlainObject(input) ||
    !required.every((key) => Object.hasOwn(input, key)) ||
    !Object.keys(input).every((key) => required.includes(key) || key === "folderId") ||
    !isFolderIdInput(input.folderId) ||
    !Object.hasOwn(ITEM_TYPES, input.type) ||
    (input.id !== "" && (typeof input.id !== "string" || !UUID_PATTERN.test(input.id))) ||
    typeof input.name !== "string" ||
    typeof input.notes !== "string" ||
    !isPlainObject(input.fields)
  ) {
    throw new Error("Invalid login entry.");
  }
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name for this item.");
  if (name.length > MAX_ITEM_NAME) throw new Error("name is invalid or too long.");
  if (input.notes.length > ENTRY_LIMITS.notes) throw new Error("notes is invalid or too long.");

  const schema = ITEM_TYPES[input.type];
  const normalizers = ITEM_NORMALIZERS[input.type] ?? {};
  const known = new Set(schema.fields.map((field) => field.key));
  if (!Object.keys(input.fields).every((key) => known.has(key))) {
    throw new Error("Invalid login entry.");
  }
  const plain = {};
  const secrets = {};
  for (const field of schema.fields) {
    const raw = input.fields[field.key] ?? "";
    if (typeof raw !== "string" || raw.length > field.max) {
      throw new Error(`${field.key} is invalid or too long.`);
    }
    const value = normalizers[field.key] ? normalizers[field.key](raw) : raw;
    if (field.kind === "secret") secrets[field.key] = value;
    else plain[field.key] = value;
  }
  return {
    id: input.id,
    type: input.type,
    name,
    notes: input.notes,
    plain,
    secrets,
    folderId: Object.hasOwn(input, "folderId") ? input.folderId || null : undefined,
  };
}

// `folderId` in editor input: absent (keep), null or "" (no folder), or an ID.
function isFolderIdInput(value) {
  return value === undefined || value === null || value === "" ||
    (typeof value === "string" && UUID_PATTERN.test(value));
}

const REQUIRED_ENTRY_KEYS = Object.freeze([
  "id",
  "type",
  "name",
  "username",
  "password",
  "url",
  "notes",
  "createdAt",
  "updatedAt",
]);
const OPTIONAL_ENTRY_KEYS = Object.freeze(["favicon", "totp"]);

function hasAllowedEntryKeys(entry) {
  return (
    isPlainObject(entry) &&
    REQUIRED_ENTRY_KEYS.every((key) => Object.hasOwn(entry, key)) &&
    Object.keys(entry).every(
      (key) => REQUIRED_ENTRY_KEYS.includes(key) || OPTIONAL_ENTRY_KEYS.includes(key),
    )
  );
}

function isValidLoginEntry(entry, schemaVersion) {
  if (
    !hasAllowedEntryKeys(entry) ||
    (Object.hasOwn(entry, "totp") &&
      (schemaVersion === LEGACY_VAULT_SCHEMA_VERSION || !isValidSealedPassword(entry.totp))) ||
    !UUID_PATTERN.test(entry.id) ||
    entry.type !== "login" ||
    !Number.isSafeInteger(entry.createdAt) ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.createdAt <= 0 ||
    entry.updatedAt < entry.createdAt
  ) {
    return false;
  }

  if (!isValidFavicon(entry.favicon ?? "")) return false;

  for (const field of TEXT_FIELDS) {
    if (
      typeof entry[field] !== "string" ||
      entry[field].length > ENTRY_LIMITS[field]
    ) {
      return false;
    }
  }

  if (!entry.name.trim()) return false;
  if (schemaVersion === LEGACY_VAULT_SCHEMA_VERSION) {
    if (
      typeof entry.password !== "string" ||
      entry.password.length === 0 ||
      entry.password.length > ENTRY_LIMITS.password
    ) {
      return false;
    }
  } else if (!isValidSealedPassword(entry.password)) {
    return false;
  }
  return isAllowedWebsite(entry.url);
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

function itemSubtitle(entry) {
  const fields = entry.fields;
  if (entry.type === "card") return fields.last4 ? `•••• ${fields.last4}` : fields.cardholder ?? "";
  if (entry.type === "identity") {
    return [fields.firstName, fields.lastName].filter(Boolean).join(" ") || fields.email || "";
  }
  if (entry.type === "ssh") return fields.fingerprint ?? "";
  return "";
}

function organizationSummary(entry) {
  return {
    folderId: entry.folderId ?? null,
    favorite: entry.favorite === true,
    deletedAt: entry.deletedAt ?? null,
    attachmentCount: entry.attachments?.length ?? 0,
  };
}

function toEntrySummary(entry) {
  if (entry.type !== "login") {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      subtitle: itemSubtitle(entry),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...organizationSummary(entry),
    };
  }
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    username: entry.username,
    url: entry.url,
    favicon: entry.favicon ?? "",
    hasTotp: Boolean(entry.totp),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...organizationSummary(entry),
  };
}

function toEntryDetails(entry) {
  const shared = {
    notes: entry.notes,
    attachments: (entry.attachments ?? []).map(toAttachmentSummary),
    historyCount: entry.history?.length ?? 0,
  };
  if (entry.type !== "login") {
    return {
      ...toEntrySummary(entry),
      ...shared,
      fields: { ...entry.fields },
      secretFields: Object.keys(entry.secrets),
    };
  }
  return { ...toEntrySummary(entry), ...shared };
}

function isValidFavicon(value) {
  if (value === "") return true;
  const prefix = "data:image/png;base64,";
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length > prefix.length + MAX_FAVICON_BASE64_LENGTH
  ) {
    return false;
  }

  const encoded = value.slice(prefix.length);
  const decoded = Buffer.from(encoded, "base64");
  const valid =
    decoded.length >= 24 &&
    decoded.length <= MAX_FAVICON_BYTES &&
    decoded.toString("base64") === encoded &&
    decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    decoded.toString("ascii", 12, 16) === "IHDR" &&
    decoded.readUInt32BE(16) > 0 &&
    decoded.readUInt32BE(20) > 0 &&
    decoded.readUInt32BE(16) <= 512 &&
    decoded.readUInt32BE(20) <= 512;
  decoded.fill(0);
  return valid;
}

function isAllowedWebsite(value) {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function normalizeLoginInput(input) {
  // `totp` (an otpauth link or Base32 secret; empty keeps the current one)
  // and `removeTotp` are optional so older callers keep working.
  const inputKeys = ["id", "name", "username", "password", "url", "notes"];
  const optionalKeys = ["totp", "removeTotp", "folderId"];
  if (
    !isPlainObject(input) ||
    !inputKeys.every((key) => Object.hasOwn(input, key)) ||
    !Object.keys(input).every((key) => inputKeys.includes(key) || optionalKeys.includes(key)) ||
    (Object.hasOwn(input, "totp") && (typeof input.totp !== "string" || input.totp.length > 2048)) ||
    (Object.hasOwn(input, "removeTotp") && typeof input.removeTotp !== "boolean") ||
    !isFolderIdInput(input.folderId)
  ) {
    throw new Error("Invalid login entry.");
  }

  for (const field of Object.keys(ENTRY_LIMITS)) {
    if (
      typeof input[field] !== "string" ||
      input[field].length > ENTRY_LIMITS[field]
    ) {
      throw new Error(`${field} is invalid or too long.`);
    }
  }

  const name = input.name.trim();
  if (!name) throw new Error("Enter a name for this login.");

  let url = input.url.trim();
  if (url && !/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (!isAllowedWebsite(url)) {
    throw new Error("Enter a valid website address using HTTP or HTTPS.");
  }

  if (input.id !== "" && !UUID_PATTERN.test(input.id)) {
    throw new Error("Invalid login entry.");
  }

  return {
    ...input,
    id: input.id,
    name,
    url,
    totp: (input.totp ?? "").trim(),
    removeTotp: input.removeTotp === true,
    folderId: Object.hasOwn(input, "folderId") ? input.folderId || null : undefined,
  };
}

class VaultStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    this.sessionEpoch = 0;
    this.mutationQueue = Promise.resolve();
    this.issuedRecoveryKey = null;
  }

  enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async fileExists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async getStatus() {
    const vaultExists = await this.fileExists();
    return {
      vaultExists,
      unlocked: this.dataKey !== null && this.vaultData !== null,
      entryCount: this.vaultData?.entries.length ?? 0,
    };
  }

  isUnlocked() {
    return this.dataKey !== null && this.vaultData !== null;
  }

  async create(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    validateNewPassphrase(passphrase);
    if (await this.fileExists()) {
      throw new Error("A vault already exists on this Mac.");
    }

    let dataKey = randomBytes(KEY_BYTES);

    try {
      const vaultData = { schemaVersion: VAULT_SCHEMA_VERSION, entries: [], folders: [] };
      const { envelope, recoveryKey } = await makeEnvelope(vaultData, passphrase, dataKey);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      await this.writeEnvelope(envelope);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }

      this.sessionEpoch += 1;
      this.dataKey = dataKey;
      this.vaultData = vaultData;
      this.envelope = envelope;
      this.issuedRecoveryKey = recoveryKey;
      dataKey = null;
      return this.getStatus();
    } catch (error) {
      if (error.message === "A vault already exists on this Mac.") throw error;
      if (error.message === "Creation was interrupted because the vault was locked.") {
        throw error;
      }
      throw new Error("Could not create the encrypted vault.");
    } finally {
      dataKey?.fill(0);
    }
  }

  // Unlocks with the vault key itself, as released from the Keychain after
  // Touch ID. The key is copied; the caller should wipe its own buffer.
  async unlockWithDataKey(dataKey) {
    const sessionEpoch = this.sessionEpoch;
    await this.mutationQueue;
    const opened = await this.decryptVaultFile(this.filePath, { dataKey });
    if (this.sessionEpoch !== sessionEpoch) {
      opened.dataKey.fill(0);
      throw new Error("Unlock was interrupted because the vault was locked.");
    }
    this.lock();
    this.dataKey = opened.dataKey;
    this.vaultData = opened.vaultData;
    this.envelope = opened.envelope;
    await this.enqueueMutation(() => this.maintainNow());
    return this.getStatus();
  }

  // A copy of the vault key for Touch ID enrollment.
  exportDataKey() {
    this.requireUnlocked();
    return Buffer.from(this.dataKey);
  }

  // The recovery key created with the vault, handed out once.
  takeIssuedRecoveryKey() {
    const recoveryKey = this.issuedRecoveryKey;
    this.issuedRecoveryKey = null;
    return recoveryKey;
  }

  hasRecoveryKey() {
    this.requireUnlocked();
    return this.envelope.version === FORMAT_VERSION;
  }

  // Creates a new recovery key for the open vault; the previous one stops
  // working for this file. The passphrase is required again so that an
  // unattended unlocked app cannot be used to mint a key.
  async createRecoveryKey(passphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(passphrase);
      return this.rotateOpenVault(passphrase, passphrase);
    });
  }

  // Sets a new master passphrase. Like every change of credentials it also
  // replaces the vault key and the recovery key; the new recovery key is
  // returned.
  async changePassphrase(currentPassphrase, newPassphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(currentPassphrase);
      validateNewPassphrase(newPassphrase);
      return this.rotateOpenVault(currentPassphrase, newPassphrase);
    });
  }

  // For the open vault, inside the mutation queue: checks the current
  // passphrase, then rotates the key under `newPassphrase`.
  async rotateOpenVault(currentPassphrase, newPassphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.verifyPassphrase(currentPassphrase);
    if (this.sessionEpoch !== sessionEpoch) {
      throw new Error("The vault was locked while saving. Unlock it again.");
    }
    const rotated = await this.rekeyNow({
      vaultData: this.vaultData,
      oldKey: this.dataKey,
      passphrase: newPassphrase,
      readAttachment: (attachment) => this.readAttachmentFile(attachment),
      sessionEpoch,
      interrupted: "The vault was locked while saving. Unlock it again.",
    });
    const oldKey = this.dataKey;
    this.dataKey = rotated.dataKey;
    this.vaultData = rotated.vaultData;
    this.envelope = rotated.envelope;
    oldKey.fill(0);
    await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
    return rotated.recoveryKey;
  }

  async verifyPassphrase(passphrase) {
    const header = headerOf(this.envelope);
    const salt = decodeBase64(this.envelope.kdf.salt, SALT_BYTES, SALT_BYTES);
    let wrappingKey = null;
    let unwrapped = null;
    try {
      wrappingKey = await deriveWrappingKey(passphrase, salt);
      unwrapped = decryptGcm(this.envelope.keyWrap, wrappingKey, getAad("key-wrap", header), KEY_BYTES);
      if (!timingSafeEqual(unwrapped, this.dataKey)) throw new Error("mismatch");
    } catch {
      throw new Error("The master passphrase is incorrect.");
    } finally {
      salt.fill(0);
      wrappingKey?.fill(0);
      unwrapped?.fill(0);
    }
  }

  // Opens the vault with its recovery key, sets a new master passphrase, and
  // replaces the recovery key, since the old one has now been typed in.
  async recoverWithKey(recoveryKeyText, newPassphrase) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      validateNewPassphrase(newPassphrase);
      const recoveryKeyBytes = decodeRecoveryKey(recoveryKeyText);
      let opened = null;
      try {
        opened = await this.decryptVaultFile(this.filePath, { recoveryKeyBytes });
      } finally {
        recoveryKeyBytes.fill(0);
      }

      try {
        // The recovery key has now been typed in, so the vault key it
        // protected is replaced along with it.
        const rotated = await this.rekeyNow({
          vaultData: opened.vaultData,
          oldKey: opened.dataKey,
          passphrase: newPassphrase,
          readAttachment: (attachment) => this.readAttachmentFile(attachment),
          sessionEpoch,
          interrupted: "Recovery was interrupted because the vault was locked.",
        });
        this.lock();
        this.dataKey = rotated.dataKey;
        this.vaultData = rotated.vaultData;
        this.envelope = rotated.envelope;
        await this.deleteAttachmentFiles(rotated.replacedAttachmentIds);
        await this.maintainNow();
        return { status: await this.getStatus(), recoveryKey: rotated.recoveryKey };
      } finally {
        opened.dataKey.fill(0);
      }
    });
  }

  async unlock(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.mutationQueue;
    validatePassphrase(passphrase);
    const opened = await this.decryptVaultFile(this.filePath, passphrase);
    if (this.sessionEpoch !== sessionEpoch) {
      opened.dataKey.fill(0);
      throw new Error("Unlock was interrupted because the vault was locked.");
    }
    this.lock();
    this.dataKey = opened.dataKey;
    this.vaultData = opened.vaultData;
    this.envelope = opened.envelope;
    await this.enqueueMutation(() => this.maintainNow());
    return this.getStatus();
  }

  // Returns display metadata only. Passwords and notes stay in the main process
  // until a caller asks for one entry explicitly.
  listEntries() {
    this.requireUnlocked();
    return this.vaultData.entries
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(toEntrySummary);
  }

  getEntry(id) {
    return toEntryDetails(this.findEntry(id));
  }

  revealPassword(id) {
    const entry = this.findEntry(id);
    if (entry.type !== "login") throw new Error("Invalid login entry.");
    try {
      return openPassword(entry.password, this.dataKey, entry.id);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // A secret field of a card, identity, or SSH key, for copy or reveal.
  revealItemSecret(id, field) {
    const entry = this.findEntry(id);
    if (entry.type === "login" || !Object.hasOwn(entry.secrets, field)) {
      throw new Error("Could not copy this value.");
    }
    try {
      return openItemSecret(entry.secrets[field], this.dataKey, entry.id, field);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // Builds the stored form of an item from normalized input, keeping secrets
  // that were left blank and recomputing derived fields.
  buildItemEntry(normalized, existing, id, timestamp) {
    const secrets = {};
    const plainSecrets = {};
    for (const [key, value] of Object.entries(normalized.secrets)) {
      if (value) {
        // Re-entering the same value keeps the sealed record, so the save
        // does not count as a change.
        let current = null;
        if (existing?.secrets[key]) {
          try {
            current = openItemSecret(existing.secrets[key], this.dataKey, id, key);
          } catch {
            current = null;
          }
        }
        secrets[key] = current === value ? existing.secrets[key] : sealItemSecret(value, this.dataKey, id, key);
        plainSecrets[key] = value;
      } else if (existing?.secrets[key]) {
        secrets[key] = existing.secrets[key];
      }
    }
    const secretValue = (key) =>
      plainSecrets[key] ??
      (existing?.secrets[key] ? openItemSecret(existing.secrets[key], this.dataKey, id, key) : "");

    const fields = { ...normalized.plain };
    if (normalized.type === "card") {
      const number = secretValue("number");
      if (number) fields.last4 = number.slice(-4);
    } else if (normalized.type === "ssh") {
      const privateKey = secretValue("privateKey");
      if (!privateKey && !fields.publicKey.trim()) throw new Error("Add a private or public key.");
      const described = describeSshKey({
        privateKey,
        publicKey: fields.publicKey,
        passphrase: secretValue("passphrase"),
      });
      fields.publicKey = described.publicKey;
      if (described.keyType) fields.keyType = described.keyType;
      if (described.fingerprint) fields.fingerprint = described.fingerprint;
    }
    for (const key of Object.keys(fields)) {
      if (fields[key] === "") delete fields[key];
    }
    return {
      id,
      type: normalized.type,
      name: normalized.name,
      notes: normalized.notes,
      fields,
      secrets,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: Math.max(timestamp, existing?.createdAt ?? 0),
    };
  }

  async saveItem(input) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const normalized = normalizeItemInput(input);
      const existingIndex = normalized.id
        ? this.vaultData.entries.findIndex((entry) => entry.id === normalized.id)
        : -1;
      if (normalized.id && existingIndex === -1) throw new Error("This login no longer exists.");
      const existing = existingIndex >= 0 ? this.vaultData.entries[existingIndex] : null;
      if (existing && existing.type !== normalized.type) throw new Error("Invalid login entry.");
      if (existing?.deletedAt) throw new Error("Restore this item from the trash first.");
      if (!existing && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }
      const folderId = this.folderIdFor(normalized.folderId);
      const now = Date.now();
      const content = this.buildItemEntry(normalized, existing, existing?.id ?? randomUUID(), now);
      const saved = this.withSavedContent(existing, content, folderId, now);
      if (saved === existing) return toEntryDetails(existing);
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = saved;
      else entries.push(saved);
      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntryDetails(saved);
    });
  }

  // The current one-time code for an entry. The secret stays here.
  getTotpCode(id, now = Date.now()) {
    const entry = this.findEntry(id);
    if (!entry.totp) throw new Error("This login has no one-time code.");
    let config;
    try {
      config = openTotp(entry.totp, this.dataKey, entry.id);
    } catch {
      throw new Error("Could not read the one-time code settings.");
    }
    return generateTotp(config, now);
  }

  findEntry(id) {
    this.requireUnlocked();
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new Error("Invalid login entry.");
    }
    const entry = this.vaultData.entries.find((item) => item.id === id);
    if (!entry) throw new Error("This login no longer exists.");
    return entry;
  }

  async saveEntry(input) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const normalized = normalizeLoginInput(input);
      const existingIndex = normalized.id
        ? this.vaultData.entries.findIndex((entry) => entry.id === normalized.id)
        : -1;

      if (normalized.id && existingIndex === -1) {
        throw new Error("This login no longer exists.");
      }
      if (existingIndex >= 0 && this.vaultData.entries[existingIndex].type !== "login") {
        throw new Error("Invalid login entry.");
      }
      if (existingIndex === -1 && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }

      const existing = existingIndex >= 0
        ? this.vaultData.entries[existingIndex]
        : null;
      if (existing?.deletedAt) throw new Error("Restore this item from the trash first.");
      // An empty password while editing keeps the sealed value, so the editor
      // never needs the current password in the renderer.
      if (!existing && !normalized.password) {
        throw new Error("Enter a password for this login.");
      }
      const folderId = this.folderIdFor(normalized.folderId);
      const id = existing?.id ?? randomUUID();
      const totpConfig = normalized.totp ? parseTotpInput(normalized.totp) : null;
      const now = Date.now();
      const timestamp = Math.max(now, existing?.createdAt ?? 0);
      const content = {
        id,
        type: "login",
        name: normalized.name,
        username: normalized.username,
        password: normalized.password
          ? this.resealedPassword(existing, id, normalized.password)
          : existing.password,
        url: normalized.url,
        notes: normalized.notes,
        favicon: existing?.favicon ?? "",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (totpConfig) {
        content.totp = this.resealedTotp(existing, id, totpConfig);
      } else if (existing?.totp && !normalized.removeTotp) {
        content.totp = existing.totp;
      }
      const savedEntry = this.withSavedContent(existing, content, folderId, now);
      if (savedEntry === existing) return toEntryDetails(existing);
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = savedEntry;
      else entries.push(savedEntry);

      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntryDetails(savedEntry);
    });
  }

  // Adds logins from an import ({ name, username, password, url, notes }) in
  // one save. Entries that fail validation or already exist with the same
  // name, username, website, and password are skipped and counted.
  async importLogins(logins) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (!Array.isArray(logins)) throw new Error("Invalid login entry.");
      const entries = this.vaultData.entries.slice();
      const existingKeys = new Map();
      for (const entry of entries) {
        // An item in the trash does not hide an imported copy.
        if (entry.deletedAt) continue;
        const key = entry.type === "login"
          ? JSON.stringify([entry.name, entry.username, entry.url])
          : JSON.stringify([entry.type, entry.name, entry.fields]);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
      }

      let imported = 0;
      let duplicates = 0;
      let invalid = 0;
      let totpSkipped = 0;
      const timestamp = Date.now();
      for (const login of logins) {
        // Cards, notes, identities, and SSH keys (from Mnemo backups).
        if (login?.type && login.type !== "login") {
          let entry;
          try {
            const normalized = normalizeItemInput({
              id: "",
              type: login.type,
              name: login.name,
              notes: login.notes ?? "",
              fields: login.fields ?? {},
            });
            entry = this.buildItemEntry(normalized, null, randomUUID(), timestamp);
          } catch {
            invalid += 1;
            continue;
          }
          const key = JSON.stringify([entry.type, entry.name, entry.fields]);
          if (existingKeys.has(key)) {
            duplicates += 1;
            continue;
          }
          if (entries.length >= MAX_ENTRIES) throw new Error("The vault has reached its entry limit.");
          entries.push(entry);
          existingKeys.set(key, [entry]);
          imported += 1;
          continue;
        }
        let normalized;
        try {
          normalized = normalizeLoginInput({ id: "", ...login });
          if (!normalized.password) throw new Error("missing password");
        } catch {
          invalid += 1;
          continue;
        }
        const key = JSON.stringify([normalized.name, normalized.username, normalized.url]);
        const sameLabel = (existingKeys.get(key) ?? []).filter((entry) => entry.type === "login");
        if (sameLabel.some((entry) => openPassword(entry.password, this.dataKey, entry.id) === normalized.password)) {
          duplicates += 1;
          continue;
        }
        if (entries.length >= MAX_ENTRIES) {
          throw new Error("The vault has reached its entry limit.");
        }
        const id = randomUUID();
        const entry = {
          id,
          type: "login",
          name: normalized.name,
          username: normalized.username,
          password: sealPassword(normalized.password, this.dataKey, id),
          url: normalized.url,
          notes: normalized.notes,
          favicon: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        // A one-time code in an unsupported form does not block the login.
        if (normalized.totp) {
          try {
            entry.totp = sealTotp(parseTotpInput(normalized.totp), this.dataKey, id);
          } catch {
            totpSkipped += 1;
          }
        }
        entries.push(entry);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
        imported += 1;
      }

      if (imported > 0) {
        await this.persistVaultData(this.nextVaultData({ entries }));
      }
      return { imported, duplicates, invalid, totpSkipped };
    });
  }

  // Reads the logins of a Mnemo backup for import, using its passphrase or
  // { recoveryKey }. Returns plain values; the caller must not keep them.
  static async readBackupLogins(filePath, credentials) {
    const reader = new VaultStore(filePath);
    let secret = credentials;
    let recoveryKeyBytes = null;
    if (typeof credentials === "string") {
      validatePassphrase(credentials);
    } else {
      if (!hasExactKeys(credentials, ["recoveryKey"])) {
        throw new Error("The recovery key is not valid. Check it and try again.");
      }
      recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
      secret = { recoveryKeyBytes };
    }
    let opened;
    try {
      opened = await reader.decryptVaultFile(filePath, secret, { allowContainer: true });
    } finally {
      recoveryKeyBytes?.fill(0);
    }
    try {
      // Items in the backup's trash are left out. Attachments are not
      // imported; their number is reported.
      const entries = opened.vaultData.entries.filter((entry) => !entry.deletedAt);
      const attachments = entries.reduce((sum, entry) => sum + (entry.attachments?.length ?? 0), 0);
      const logins = entries.map((entry) => entry.type !== "login"
        ? {
          type: entry.type,
          name: entry.name,
          notes: entry.notes,
          fields: Object.fromEntries(
            ITEM_TYPES[entry.type].fields.map((field) => [
              field.key,
              field.kind === "secret"
                ? (entry.secrets[field.key]
                  ? openItemSecret(entry.secrets[field.key], opened.dataKey, entry.id, field.key)
                  : "")
                : entry.fields[field.key] ?? "",
            ]),
          ),
        }
        : {
        name: entry.name,
        username: entry.username,
        password: openPassword(entry.password, opened.dataKey, entry.id),
        url: entry.url,
        notes: entry.notes,
        totp: entry.totp ? toOtpauthUri(openTotp(entry.totp, opened.dataKey, entry.id)) : "",
      });
      return { logins, attachments };
    } finally {
      opened.dataKey.fill(0);
    }
  }

  async saveFavicon(id, favicon) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (
        typeof id !== "string" ||
        !UUID_PATTERN.test(id) ||
        typeof favicon !== "string" ||
        favicon === "" ||
        !isValidFavicon(favicon)
      ) {
        throw new Error("The website icon is invalid.");
      }

      const existingIndex = this.vaultData.entries.findIndex(
        (entry) => entry.id === id,
      );
      if (existingIndex === -1 || this.vaultData.entries[existingIndex].type !== "login") {
        throw new Error("This login no longer exists.");
      }
      if (this.vaultData.entries[existingIndex].deletedAt) {
        throw new Error("Restore this item from the trash first.");
      }

      const savedEntry = {
        ...this.vaultData.entries[existingIndex],
        favicon,
      };
      const entries = this.vaultData.entries.slice();
      entries[existingIndex] = savedEntry;
      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntrySummary(savedEntry);
    });
  }

  // --- Saving content ------------------------------------------------------------

  nextVaultData(changes) {
    return {
      schemaVersion: VAULT_SCHEMA_VERSION,
      entries: changes.entries ?? this.vaultData.entries,
      folders: changes.folders ?? this.vaultData.folders,
    };
  }

  async replaceEntry(entry, next) {
    const index = this.vaultData.entries.indexOf(entry);
    if (index === -1) throw new Error("This login no longer exists.");
    const entries = this.vaultData.entries.slice();
    entries[index] = next;
    await this.persistVaultData(this.nextVaultData({ entries }));
  }

  // Editor input to a folder: undefined keeps the current folder, null means
  // none, and an ID must name an existing folder.
  folderIdFor(folderId) {
    if (folderId === undefined || folderId === null) return folderId;
    if (!this.vaultData.folders.some((folder) => folder.id === folderId)) {
      throw new Error("This folder no longer exists.");
    }
    return folderId;
  }

  // Combines saved content with the entry's metadata. A new entry gets the
  // chosen folder. An edit that changes nothing returns `existing` itself; a
  // real change puts the previous content into the history.
  withSavedContent(existing, content, folderId, now) {
    if (!existing) return withMeta(content, null, folderId ? { folderId } : {});
    const changed = contentChanged(existing, content);
    const folderChanged = folderId !== undefined && (existing.folderId ?? null) !== folderId;
    if (!changed && !folderChanged) return existing;
    const changes = {};
    if (folderId !== undefined) changes.folderId = folderId;
    if (changed) changes.history = historyAfterChange(existing, now);
    return withMeta(changed ? content : { ...content, updatedAt: existing.updatedAt }, existing, changes);
  }

  // Typing the same password again keeps the sealed record (not a change).
  resealedPassword(existing, id, password) {
    if (existing) {
      try {
        if (openPassword(existing.password, this.dataKey, existing.id) === password) return existing.password;
      } catch {
        // An unreadable value is replaced.
      }
    }
    return sealPassword(password, this.dataKey, id);
  }

  resealedTotp(existing, id, config) {
    if (existing?.totp) {
      try {
        if (toOtpauthUri(openTotp(existing.totp, this.dataKey, existing.id)) === toOtpauthUri(config)) {
          return existing.totp;
        }
      } catch {
        // An unreadable value is replaced.
      }
    }
    return sealTotp(config, this.dataKey, id);
  }

  // --- Folders and favorites ------------------------------------------------------
  //
  // Folder and favorite are organization, not content: changing them does not
  // change the entry's date or add a version to its history.

  listFolders() {
    this.requireUnlocked();
    return this.vaultData.folders
      .map((folder) => ({ ...folder }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  }

  findFolder(id) {
    this.requireUnlocked();
    const folder = typeof id === "string" ? this.vaultData.folders.find((item) => item.id === id) : null;
    if (!folder) throw new Error("This folder no longer exists.");
    return folder;
  }

  requireUniqueFolderName(name, exceptId) {
    const lowered = name.toLowerCase();
    if (this.vaultData.folders.some((folder) => folder.id !== exceptId && folder.name.toLowerCase() === lowered)) {
      throw new Error("A folder with this name already exists.");
    }
  }

  async createFolder(name) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const folderName = normalizeFolderName(name);
      if (this.vaultData.folders.length >= MAX_FOLDERS) {
        throw new Error("The vault has reached its folder limit.");
      }
      this.requireUniqueFolderName(folderName, null);
      const folder = { id: randomUUID(), name: folderName, createdAt: Date.now() };
      await this.persistVaultData(this.nextVaultData({ folders: [...this.vaultData.folders, folder] }));
      return { ...folder };
    });
  }

  async renameFolder(id, name) {
    return this.enqueueMutation(async () => {
      const folder = this.findFolder(id);
      const folderName = normalizeFolderName(name);
      if (folderName === folder.name) return { ...folder };
      this.requireUniqueFolderName(folderName, folder.id);
      const renamed = { ...folder, name: folderName };
      await this.persistVaultData(this.nextVaultData({
        folders: this.vaultData.folders.map((item) => (item === folder ? renamed : item)),
      }));
      return { ...renamed };
    });
  }

  // Items in a deleted folder are kept; they only leave the folder.
  async deleteFolder(id) {
    return this.enqueueMutation(async () => {
      const folder = this.findFolder(id);
      await this.persistVaultData(this.nextVaultData({
        folders: this.vaultData.folders.filter((item) => item !== folder),
        entries: this.vaultData.entries.map((entry) =>
          entry.folderId === folder.id ? withMeta(entry, entry, { folderId: null }) : entry),
      }));
      return { deleted: true };
    });
  }

  // `folderId` is a folder ID, or null to take the entry out of its folder.
  async setFolder(id, folderId) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if (folderId === undefined || !isFolderIdInput(folderId)) throw new Error("This folder no longer exists.");
      const target = this.folderIdFor(folderId || null);
      if ((entry.folderId ?? null) === target) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { folderId: target });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async setFavorite(id, favorite) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (typeof favorite !== "boolean") throw new Error("Invalid login entry.");
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if ((entry.favorite === true) === favorite) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { favorite });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  // --- Trash -----------------------------------------------------------------------
  //
  // Deleting moves an entry to the trash, unchanged, with its attachments and
  // history. It can be restored for 30 days (maintainNow removes it after
  // that) or deleted for good, which also removes its attachment files.

  async deleteEntry(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { deletedAt: Date.now() });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async restoreEntry(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (!entry.deletedAt) return toEntrySummary(entry);
      const saved = withMeta(entry, entry, { deletedAt: null });
      await this.replaceEntry(entry, saved);
      return toEntrySummary(saved);
    });
  }

  async deletePermanently(id) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (!entry.deletedAt) throw new Error("Move this item to the trash first.");
      await this.removeEntries((item) => item === entry);
      return { deleted: 1 };
    });
  }

  async emptyTrash() {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      return { deleted: await this.removeEntries((entry) => Boolean(entry.deletedAt)) };
    });
  }

  // Removes matching entries; their attachment files go after the save, so
  // the vault never refers to a missing file.
  async removeEntries(predicate) {
    const removed = this.vaultData.entries.filter(predicate);
    if (removed.length === 0) return 0;
    const removedSet = new Set(removed);
    await this.persistVaultData(this.nextVaultData({
      entries: this.vaultData.entries.filter((entry) => !removedSet.has(entry)),
    }));
    await this.deleteAttachmentFiles(removed.flatMap((entry) => (entry.attachments ?? []).map((item) => item.id)));
    return removed.length;
  }

  // --- History ---------------------------------------------------------------------

  // Earlier versions, newest first, without secrets. `changes` lists the
  // fields that were different in the version that replaced each one.
  getHistory(id) {
    const entry = this.findEntry(id);
    const versions = entry.history ?? [];
    return versions.map((version, index) =>
      toVersionSummary(entry, version, index === 0 ? entry : versions[index - 1]));
  }

  findVersion(entry, versionId) {
    const version = typeof versionId === "string"
      ? (entry.history ?? []).find((item) => item.id === versionId)
      : null;
    if (!version) throw new Error("This version no longer exists.");
    return version;
  }

  // A secret from an earlier version (the old password, or a secret field of
  // a card, identity, or SSH key), for copy or reveal by main.
  revealVersionSecret(id, versionId, field) {
    const entry = this.findEntry(id);
    const version = this.findVersion(entry, versionId);
    let record = null;
    if (entry.type === "login") {
      if (field === "password") record = version.password;
    } else if (typeof field === "string" && Object.hasOwn(version.secrets, field)) {
      record = version.secrets[field];
    }
    if (!record) throw new Error("Could not copy this value.");
    try {
      return entry.type === "login"
        ? openPassword(record, this.dataKey, entry.id)
        : openItemSecret(record, this.dataKey, entry.id, field);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // Makes an earlier version current. The content it replaces becomes the
  // newest version, so restoring can itself be undone.
  async restoreVersion(id, versionId) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      const version = this.findVersion(entry, versionId);
      const now = Math.max(Date.now(), entry.createdAt);
      const content = entry.type === "login"
        ? {
          id: entry.id,
          type: "login",
          name: version.name,
          username: version.username,
          password: version.password,
          url: version.url,
          notes: version.notes,
          favicon: entry.favicon ?? "",
          createdAt: entry.createdAt,
          updatedAt: now,
          ...(version.totp ? { totp: version.totp } : {}),
        }
        : {
          id: entry.id,
          type: entry.type,
          name: version.name,
          notes: version.notes,
          fields: { ...version.fields },
          secrets: { ...version.secrets },
          createdAt: entry.createdAt,
          updatedAt: now,
        };
      const others = (entry.history ?? []).filter((item) => item !== version);
      const history = [snapshotOf(entry, now), ...others].slice(0, HISTORY_LIMIT);
      const saved = withMeta(content, entry, { history });
      await this.replaceEntry(entry, saved);
      return toEntryDetails(saved);
    });
  }

  // --- Attachments ------------------------------------------------------------------

  static attachmentDirectoryFor(vaultPath) {
    return `${vaultPath}.attachments`;
  }

  get attachmentDirectory() {
    return VaultStore.attachmentDirectoryFor(this.filePath);
  }

  attachmentPath(attachmentId) {
    return path.join(this.attachmentDirectory, `${attachmentId}.bin`);
  }

  // The vault file and its attachment folder are never a source or target
  // for user files.
  isVaultPath(candidate) {
    const resolved = path.resolve(candidate);
    const directory = path.resolve(this.attachmentDirectory);
    return resolved === path.resolve(this.filePath) ||
      resolved === directory ||
      resolved.startsWith(`${directory}${path.sep}`);
  }

  async ensureAttachmentDirectory() {
    await fs.mkdir(this.attachmentDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.attachmentDirectory, 0o700);
  }

  findAttachment(id, attachmentId) {
    const entry = this.findEntry(id);
    const attachment = typeof attachmentId === "string"
      ? (entry.attachments ?? []).find((item) => item.id === attachmentId)
      : null;
    if (!attachment) throw new Error("This attachment no longer exists.");
    return { entry, attachment };
  }

  totalAttachmentBytes() {
    return attachmentsOf(this.vaultData).reduce((sum, { attachment }) => sum + attachment.size, 0);
  }

  // Encrypts a copy of `sourcePath` and adds it to the entry. The encrypted
  // file is written first and the vault second, so an interruption leaves at
  // most an unreferenced file, which maintainNow removes.
  async addAttachment(id, sourcePath) {
    return this.enqueueMutation(async () => {
      const entry = this.findEntry(id);
      const sessionEpoch = this.sessionEpoch;
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      if ((entry.attachments?.length ?? 0) >= MAX_ATTACHMENTS_PER_ENTRY) {
        throw new Error("An item can have up to 20 attachments.");
      }
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || this.isVaultPath(sourcePath)) {
        throw new Error("Could not read this file.");
      }

      const attachmentId = randomUUID();
      const fileKey = randomBytes(KEY_BYTES);
      let plaintext = null;
      let encrypted = null;
      try {
        try {
          plaintext = await readFileWithLimit(sourcePath, MAX_ATTACHMENT_BYTES);
        } catch (error) {
          if (error?.tooLarge) throw new Error("Attachments can be up to 50 MB each.");
          throw new Error("Could not read this file.");
        }
        if (this.sessionEpoch !== sessionEpoch || !this.isUnlocked()) {
          throw new Error("The vault was locked while saving. Unlock it again.");
        }
        if (this.totalAttachmentBytes() + plaintext.length > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error("Attachments in one vault can take up to 1 GB.");
        }
        encrypted = encryptAttachment(plaintext, fileKey, attachmentId);
        const attachment = {
          id: attachmentId,
          name: normalizeAttachmentName(path.basename(sourcePath)),
          size: plaintext.length,
          key: sealAttachmentKey(fileKey, this.dataKey, entry.id, attachmentId),
          createdAt: Date.now(),
        };
        const filePath = this.attachmentPath(attachmentId);
        await this.ensureAttachmentDirectory();
        await this.writeBytesAtomically(filePath, encrypted);
        try {
          await this.replaceEntry(entry, withMeta(entry, entry, {
            attachments: [...(entry.attachments ?? []), attachment],
          }));
        } catch (error) {
          if (!error?.written) await fs.unlink(filePath).catch(() => {});
          throw error;
        }
        return toAttachmentSummary(attachment);
      } finally {
        plaintext?.fill(0);
        encrypted?.fill(0);
        fileKey.fill(0);
      }
    });
  }

  // Decrypts an attachment and writes it to `destinationPath`.
  async exportAttachment(id, attachmentId, destinationPath) {
    return this.enqueueMutation(async () => {
      const { entry, attachment } = this.findAttachment(id, attachmentId);
      if (typeof destinationPath !== "string" || !path.isAbsolute(destinationPath) || this.isVaultPath(destinationPath)) {
        throw new Error("Choose a different location for the file.");
      }
      const plaintext = await this.openAttachment(entry, attachment);
      try {
        await this.writeBytesAtomically(path.resolve(destinationPath), plaintext);
      } catch {
        throw new Error("Could not save the file.");
      } finally {
        plaintext.fill(0);
      }
      return { saved: true, name: attachment.name };
    });
  }

  async openAttachment(entry, attachment) {
    let fileBytes = null;
    let fileKey = null;
    try {
      fileBytes = await readFileWithLimit(this.attachmentPath(attachment.id), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
      fileKey = openAttachmentKey(attachment.key, this.dataKey, entry.id, attachment.id);
      return decryptAttachment(fileBytes, fileKey, attachment.id, attachment.size);
    } catch {
      throw new Error(`The attachment “${attachment.name}” in “${entry.name}” is missing or damaged.`);
    } finally {
      fileBytes?.fill(0);
      fileKey?.fill(0);
    }
  }

  async deleteAttachment(id, attachmentId) {
    return this.enqueueMutation(async () => {
      const { entry, attachment } = this.findAttachment(id, attachmentId);
      if (entry.deletedAt) throw new Error("Restore this item from the trash first.");
      await this.replaceEntry(entry, withMeta(entry, entry, {
        attachments: entry.attachments.filter((item) => item !== attachment),
      }));
      await this.deleteAttachmentFiles([attachment.id]);
      return { deleted: true };
    });
  }

  async deleteAttachmentFiles(attachmentIds) {
    await Promise.all(attachmentIds.map((attachmentId) =>
      fs.unlink(this.attachmentPath(attachmentId)).catch(() => {})));
  }

  // Removes files no entry refers to: left by an interrupted save, deletion,
  // or restore. Runs inside the mutation queue, so no attachment is being
  // written at the same time.
  async removeUnreferencedAttachments() {
    if (!this.isUnlocked()) return 0;
    const referenced = new Set(attachmentsOf(this.vaultData).map(({ attachment }) => attachment.id));
    let names;
    try {
      names = await fs.readdir(this.attachmentDirectory);
    } catch {
      return 0;
    }
    if (!this.isUnlocked()) return 0;
    let removed = 0;
    for (const name of names) {
      const match = name.match(/^(.+)\.bin$/);
      const unreferenced = match
        ? UUID_PATTERN.test(match[1]) && !referenced.has(match[1])
        : name.endsWith(".tmp");
      if (unreferenced) {
        await fs.unlink(path.join(this.attachmentDirectory, name)).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }

  // Verifies and copies the attachments of a vault being restored. Returns
  // the files it created; files that already existed hold the same content
  // (attachment IDs are unique and files never change).
  async restoreAttachmentFiles(opened) {
    const wanted = attachmentsOf(opened.vaultData);
    if (wanted.length === 0) return [];
    const added = [];
    try {
      if (!opened.container) throw new Error("invalid");
      await this.ensureAttachmentDirectory();
      for (const { entryId, attachment } of wanted) {
        const blob = opened.container.blobs.get(attachment.id);
        if (!blob || blob.size !== attachment.size + ATTACHMENT_OVERHEAD) throw new Error("invalid");
        const bytes = await readContainerFile(opened.container, attachment.id);
        let fileKey = null;
        let plaintext = null;
        try {
          fileKey = openAttachmentKey(attachment.key, opened.dataKey, entryId, attachment.id);
          plaintext = decryptAttachment(bytes, fileKey, attachment.id, attachment.size);
        } finally {
          fileKey?.fill(0);
          plaintext?.fill(0);
        }
        const target = this.attachmentPath(attachment.id);
        const existed = await pathExists(target);
        await this.writeBytesAtomically(target, bytes);
        if (!existed) added.push(target);
      }
      return added;
    } catch {
      await Promise.all(added.map((file) => fs.unlink(file).catch(() => {})));
      throw new Error("This backup is incomplete or damaged. Nothing was restored.");
    }
  }

  // --- Housekeeping -------------------------------------------------------------------

  // After the vault opens (inside the mutation queue): removes items that
  // have been in the trash for 30 days and attachment files no item refers
  // to. Failures are left for the next time.
  async maintainNow(now = Date.now()) {
    if (!this.isUnlocked()) return;
    const cutoff = now - TRASH_RETENTION_MS;
    try {
      await this.removeEntries((entry) => Boolean(entry.deletedAt) && entry.deletedAt <= cutoff);
    } catch {
      // Tried again on the next unlock.
    }
    try {
      await this.removeUnreferencedAttachments();
    } catch {
      // Tried again on the next unlock.
    }
  }

  async maintain(now = Date.now()) {
    return this.enqueueMutation(() => this.maintainNow(now));
  }

  requireUnlocked() {
    if (!this.isUnlocked() || !this.envelope) {
      throw new Error("Unlock the vault first.");
    }
  }

  async persistVaultData(nextVaultData) {
    this.requireUnlocked();
    const sessionEpoch = this.sessionEpoch;
    const dataKey = this.dataKey;
    let vaultData = nextVaultData;
    let plaintext = Buffer.from(JSON.stringify(vaultData), "utf8");
    // Oldest versions in the history make room before a save is refused.
    while (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) {
      const pruned = pruneHistory(vaultData, 0.1);
      if (!pruned) break;
      plaintext.fill(0);
      vaultData = pruned;
      plaintext = Buffer.from(JSON.stringify(vaultData), "utf8");
    }
    try {
      if (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }

      const header = headerOf(this.envelope);
      const nextEnvelope = {
        ...this.envelope,
        data: encryptGcm(
          plaintext,
          this.dataKey,
          getAad("vault-data", header),
        ),
      };
      await this.writeEnvelope(nextEnvelope);
      if (this.sessionEpoch !== sessionEpoch || this.dataKey !== dataKey) {
        // The new data is on disk; callers must not undo file changes.
        throw Object.assign(new Error("The vault was locked while saving. Unlock it again."), { written: true });
      }
      this.envelope = nextEnvelope;
      this.vaultData = vaultData;
    } finally {
      plaintext.fill(0);
    }
  }

  // Copies the encrypted vault file, plus its encrypted attachment files when
  // there are any (see backup-file.js). Runs in the mutation queue so the
  // copy matches one saved state. Every attachment is decrypted once first:
  // a backup that could not be restored is not written at all.
  async exportBackup(destinationPath) {
    return this.enqueueMutation(async () => {
      if (!this.isUnlocked()) throw new Error("Unlock the vault first.");

      const resolvedDestination = path.resolve(destinationPath);
      if (this.isVaultPath(resolvedDestination)) {
        throw new Error("Choose a different location for the backup.");
      }

      const attachments = [];
      for (const { entryId, attachment } of attachmentsOf(this.vaultData)) {
        const entry = this.vaultData.entries.find((item) => item.id === entryId);
        (await this.openAttachment(entry, attachment)).fill(0);
        attachments.push({
          id: attachment.id,
          path: this.attachmentPath(attachment.id),
          size: attachment.size + ATTACHMENT_OVERHEAD,
        });
      }

      let encryptedFile = null;
      try {
        const stats = await fs.stat(this.filePath);
        if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
          throw new Error("Invalid vault file");
        }
        encryptedFile = await fs.readFile(this.filePath);
        if (encryptedFile.length <= 0 || encryptedFile.length > MAX_FILE_BYTES) {
          throw new Error("Invalid vault file");
        }
        const envelope = JSON.parse(encryptedFile.toString("utf8"));
        parseEnvelope(envelope);
        if (attachments.length === 0) {
          await this.writeBytesAtomically(resolvedDestination, encryptedFile);
        } else {
          await writeContainer(resolvedDestination, envelope, attachments);
        }
        return { exported: true, attachments: attachments.length };
      } catch {
        throw new Error("Could not create the encrypted backup.");
      } finally {
        encryptedFile?.fill(0);
      }
    });
  }

  // `credentials` is the backup's master passphrase, or
  // { recoveryKey, newPassphrase } when that passphrase is forgotten. With a
  // recovery key the backup is re-encrypted under the new passphrase and a new
  // recovery key, available afterwards from takeIssuedRecoveryKey().
  async restoreBackup(sourcePath, credentials) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      let opened;
      let envelope;
      if (typeof credentials === "string") {
        validatePassphrase(credentials);
        opened = await this.decryptVaultFile(sourcePath, credentials, { allowContainer: true });
        envelope = opened.envelope;
      } else {
        if (!hasExactKeys(credentials, ["recoveryKey", "newPassphrase"])) {
          throw new Error("The recovery key is not valid. Check it and try again.");
        }
        validateNewPassphrase(credentials.newPassphrase);
        const recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
        try {
          opened = await this.decryptVaultFile(sourcePath, { recoveryKeyBytes }, { allowContainer: true });
        } finally {
          recoveryKeyBytes.fill(0);
        }
        return this.restoreWithNewKey(opened, credentials.newPassphrase, sessionEpoch);
      }

      try {
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        // Attachment files go in first, then the vault file is replaced in
        // one rename. Until then the current vault and its files are intact,
        // and files added for a restore that does not finish are removed.
        const addedFiles = await this.restoreAttachmentFiles(opened);
        try {
          if (this.sessionEpoch !== sessionEpoch) {
            throw new Error("Restore was interrupted because the vault was locked.");
          }
          await this.writeEnvelope(envelope);
        } catch (error) {
          await Promise.all(addedFiles.map((file) => fs.unlink(file).catch(() => {})));
          throw error;
        }
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        this.lock();
        this.dataKey = opened.dataKey;
        this.vaultData = opened.vaultData;
        this.envelope = envelope;
        // Restoring by passphrase keeps the backup's keys and recovery key.
        this.issuedRecoveryKey = null;
        opened.dataKey = null;
        // The replaced vault's files are no longer referenced.
        await this.maintainNow();
        return this.getStatus();
      } finally {
        opened.dataKey?.fill(0);
      }
    });
  }

  // Restoring with the recovery key: the backup's vault key is known to anyone
  // with that backup and the recovery key just typed in, so the restored vault
  // gets a new key. Attachments come straight from the backup, are verified
  // by decrypting them, and are stored under new keys and IDs.
  async restoreWithNewKey(opened, newPassphrase, sessionEpoch) {
    try {
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Restore was interrupted because the vault was locked.");
      }
      let rotated;
      try {
        rotated = await this.rekeyNow({
          vaultData: opened.vaultData,
          oldKey: opened.dataKey,
          passphrase: newPassphrase,
          readAttachment: async (attachment) => {
            const blob = opened.container?.blobs.get(attachment.id);
            if (!blob || blob.size !== attachment.size + ATTACHMENT_OVERHEAD) throw new Error("invalid");
            return readContainerFile(opened.container, attachment.id);
          },
          sessionEpoch,
          interrupted: "Restore was interrupted because the vault was locked.",
        });
      } catch (error) {
        if (/missing or damaged/.test(error.message)) {
          throw new Error("This backup is incomplete or damaged. Nothing was restored.");
        }
        throw error;
      }
      this.lock();
      this.dataKey = rotated.dataKey;
      this.vaultData = rotated.vaultData;
      this.envelope = rotated.envelope;
      this.issuedRecoveryKey = rotated.recoveryKey;
      // The replaced vault's files are no longer referenced.
      await this.maintainNow();
      return this.getStatus();
    } finally {
      opened.dataKey.fill(0);
    }
  }

  // --- Key rotation ------------------------------------------------------------
  //
  // Every change of credentials (a new passphrase, a new recovery key,
  // recovery, restoring with the recovery key) replaces the vault key, so
  // anyone who learned the old key (an old recovery key with an old copy of
  // the file, or the Touch ID file with Keychain access) cannot read what is
  // saved afterwards.
  //
  // Sealed values are sealed again under the new key with the same
  // associated data. Each distinct record is resealed once and reused, so
  // records that were the same (a password kept between versions) stay the
  // same, and the history shows no changes that did not happen. Attachments
  // are encrypted again under new file keys and new IDs, one file at a time.
  //
  // New files are written first, then the vault file in one rename. If
  // anything fails before the rename, the new files are removed and the old
  // vault and its files are untouched. Afterwards the caller removes the old
  // files (`replacedAttachmentIds`).
  async rekeyNow({ vaultData, oldKey, passphrase, readAttachment, sessionEpoch, interrupted }) {
    const newKey = randomBytes(KEY_BYTES);
    const resealed = new Map();
    const reseal = (record, aad) => {
      const cacheKey = `${aad.toString("utf8")}\n${JSON.stringify(record)}`;
      if (!resealed.has(cacheKey)) {
        const plaintext = decryptGcm(record, oldKey, aad);
        try {
          resealed.set(cacheKey, encryptGcm(plaintext, newKey, aad));
        } finally {
          plaintext.fill(0);
        }
      }
      return resealed.get(cacheKey);
    };
    // `content` is the entry itself or one of its history versions.
    const resealContent = (entry, content) => {
      if (entry.type === "login") {
        const next = { ...content, password: reseal(content.password, getPasswordAad(entry.id)) };
        if (content.totp) next.totp = reseal(content.totp, getTotpAad(entry.id));
        return next;
      }
      return {
        ...content,
        secrets: Object.fromEntries(Object.entries(content.secrets).map(([field, record]) =>
          [field, reseal(record, getItemSecretAad(entry.id, field))])),
      };
    };

    const addedFiles = [];
    const replacedAttachmentIds = [];
    let written = false;
    try {
      const entries = [];
      for (const entry of vaultData.entries) {
        const next = resealContent(entry, entry);
        if (entry.history) next.history = entry.history.map((version) => resealContent(entry, version));
        if (entry.attachments) {
          next.attachments = [];
          for (const attachment of entry.attachments) {
            next.attachments.push(await this.rekeyAttachment(entry, attachment, oldKey, newKey, readAttachment, addedFiles));
            replacedAttachmentIds.push(attachment.id);
            if (this.sessionEpoch !== sessionEpoch) throw new Error(interrupted);
          }
        }
        entries.push(next);
      }
      const nextVaultData = { ...vaultData, entries };
      if (Buffer.byteLength(JSON.stringify(nextVaultData), "utf8") > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }
      const { envelope, recoveryKey } = await makeEnvelope(nextVaultData, passphrase, newKey);
      if (this.sessionEpoch !== sessionEpoch) throw new Error(interrupted);
      await this.writeEnvelope(envelope);
      written = true;
      if (this.sessionEpoch !== sessionEpoch) {
        // On disk already; the new files are now the referenced ones.
        throw Object.assign(new Error(interrupted), { written: true });
      }
      return { envelope, recoveryKey, vaultData: nextVaultData, dataKey: newKey, replacedAttachmentIds };
    } catch (error) {
      newKey.fill(0);
      if (!written) await Promise.all(addedFiles.map((file) => fs.unlink(file).catch(() => {})));
      throw error;
    }
  }

  // Decrypts one attachment with the old keys and writes it again under a
  // new file key and ID. Only this one file is held in memory.
  async rekeyAttachment(entry, attachment, oldKey, newKey, readAttachment, addedFiles) {
    const attachmentId = randomUUID();
    const fileKey = randomBytes(KEY_BYTES);
    let fileBytes = null;
    let oldFileKey = null;
    let plaintext = null;
    let encrypted = null;
    try {
      try {
        fileBytes = await readAttachment(attachment);
        oldFileKey = openAttachmentKey(attachment.key, oldKey, entry.id, attachment.id);
        plaintext = decryptAttachment(fileBytes, oldFileKey, attachment.id, attachment.size);
      } catch {
        throw new Error(`The attachment “${attachment.name}” in “${entry.name}” is missing or damaged.`);
      }
      encrypted = encryptAttachment(plaintext, fileKey, attachmentId);
      const target = this.attachmentPath(attachmentId);
      await this.ensureAttachmentDirectory();
      await this.writeBytesAtomically(target, encrypted);
      addedFiles.push(target);
      return { ...attachment, id: attachmentId, key: sealAttachmentKey(fileKey, newKey, entry.id, attachmentId) };
    } finally {
      fileBytes?.fill(0);
      oldFileKey?.fill(0);
      plaintext?.fill(0);
      encrypted?.fill(0);
      fileKey.fill(0);
    }
  }

  readAttachmentFile(attachment) {
    return readFileWithLimit(this.attachmentPath(attachment.id), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
  }

  // `secret` is the master passphrase (string), { recoveryKeyBytes }, or
  // { dataKey } for a key released by Touch ID. Backups may be containers
  // with attachments (`allowContainer`); the vault file itself never is.
  async decryptVaultFile(filePath, secret, { allowContainer = false } = {}) {
    const usingRecoveryKey = Boolean(secret?.recoveryKeyBytes);
    const usingDataKey = Boolean(secret?.dataKey);
    let wrappingKey = null;
    let dataKey = null;
    let plaintext = null;
    let salt = null;
    let rawFile = null;

    try {
      const source = await openVaultSource(filePath, {
        allowContainer,
        maxEnvelopeBytes: MAX_FILE_BYTES,
        maxHeaderBytes: MAX_FILE_BYTES * 2,
        maxAttachments: MAX_ENTRIES * MAX_ATTACHMENTS_PER_ENTRY,
        maxAttachmentFileBytes: MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD,
      });
      rawFile = source.envelopeBytes ?? null;
      const envelope = source.container ? source.envelope : JSON.parse(rawFile.toString("utf8"));
      const parsed = parseEnvelope(envelope);
      if (usingDataKey) {
        parsed.salt.fill(0);
        parsed.recoverySalt?.fill(0);
        if (secret.dataKey.length !== KEY_BYTES) throw new Error("Invalid key");
        dataKey = Buffer.from(secret.dataKey);
      } else if (usingRecoveryKey) {
        if (!parsed.recoverySalt) {
          parsed.salt.fill(0);
          throw Object.assign(new Error("This vault has no recovery key."), { userFacing: true });
        }
        salt = parsed.recoverySalt;
        parsed.salt.fill(0);
        wrappingKey = deriveRecoveryWrappingKey(secret.recoveryKeyBytes, salt);
        dataKey = decryptGcm(
          envelope.recoveryWrap,
          wrappingKey,
          getAad("recovery-wrap", parsed.header),
          KEY_BYTES,
        );
      } else {
        salt = parsed.salt;
        parsed.recoverySalt?.fill(0);
        wrappingKey = await deriveWrappingKey(secret, salt);
        dataKey = decryptGcm(
          envelope.keyWrap,
          wrappingKey,
          getAad("key-wrap", parsed.header),
          KEY_BYTES,
        );
      }
      plaintext = decryptGcm(
        envelope.data,
        dataKey,
        getAad("vault-data", parsed.header),
      );
      const vaultData = JSON.parse(plaintext.toString("utf8"));
      if (!validateVaultData(vaultData)) throw new Error("Invalid vault data");

      const opened = {
        envelope,
        vaultData: upgradeVaultData(vaultData, dataKey),
        dataKey,
        container: source.container,
      };
      dataKey = null;
      return opened;
    } catch (error) {
      if (error?.userFacing) throw new Error(error.message);
      if (usingDataKey) {
        throw new Error("Touch ID can no longer unlock this vault. Unlock it with your master passphrase and turn Touch ID on again.");
      }
      throw new Error(
        usingRecoveryKey
          ? "Could not open the vault with this recovery key. Check the key and make sure the vault file is intact."
          : "Could not open the vault. Check the master passphrase and make sure the vault or backup file is intact.",
      );
    } finally {
      salt?.fill(0);
      wrappingKey?.fill(0);
      dataKey?.fill(0);
      plaintext?.fill(0);
      rawFile?.fill(0);
    }
  }

  lock() {
    this.sessionEpoch += 1;
    this.issuedRecoveryKey = null;
    this.dataKey?.fill(0);
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    return { vaultExists: true, unlocked: false, entryCount: 0 };
  }

  async writeEnvelope(envelope) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);

    const contents = Buffer.from(JSON.stringify(envelope), "utf8");
    try {
      await this.writeBytesAtomically(this.filePath, contents);
    } finally {
      contents.fill(0);
    }
  }

  async writeBytesAtomically(destinationPath, contents) {
    const directory = path.dirname(destinationPath);
    const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fileHandle = null;

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      fileHandle = await fs.open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(contents);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fs.rename(temporaryPath, destinationPath);
    } catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

module.exports = VaultStore;
