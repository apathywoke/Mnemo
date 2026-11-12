// Login and item entries: validation, input normalization, and the
// summaries sent to the renderer.
const { ITEM_TYPES } = require("../../shared/item-types.js");
const { isPrivateKey } = require("../ssh-keys");
const cardTools = require("../../shared/card-tools.js");
const {
  VAULT_SCHEMA_VERSION,
  NOTES_SCHEMA_VERSION,
  LEGACY_VAULT_SCHEMA_VERSION,
  MAX_FAVICON_BYTES,
  MAX_FAVICON_BASE64_LENGTH,
  PNG_SIGNATURE,
  ENTRY_LIMITS,
  TEXT_FIELDS,
  UUID_PATTERN,
} = require("./constants");
const { isPlainObject, hasExactKeys } = require("./records");
const { isValidSealedPassword, isValidSealedText } = require("./crypto");
const { toAttachmentSummary } = require("./attachments");

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

// Text fields of an item type that schema 4 stores sealed (`sealed` in
// item-types.js), such as a secure note's body.
function sealedFieldKeys(type) {
  return ITEM_TYPES[type].fields.filter((field) => field.sealed).map((field) => field.key);
}

// Notes: plain text up to schema 3; "" or a sealed record from schema 4.
function isValidNotes(notes, schemaVersion) {
  return schemaVersion >= NOTES_SCHEMA_VERSION
    ? isValidSealedText(notes, ENTRY_LIMITS.notes * 3)
    : typeof notes === "string" && notes.length <= ENTRY_LIMITS.notes;
}

function isValidPlainField(field, value, schemaVersion) {
  return field.sealed && schemaVersion >= NOTES_SCHEMA_VERSION
    ? isValidSealedPassword(value, field.max * 3)
    : typeof value === "string" && value.length <= field.max;
}

function isValidItemEntry(entry, schemaVersion = VAULT_SCHEMA_VERSION) {
  if (
    !hasExactKeys(entry, ITEM_ENTRY_KEYS) ||
    !Object.hasOwn(ITEM_TYPES, entry.type) ||
    !UUID_PATTERN.test(entry.id) ||
    typeof entry.name !== "string" ||
    !entry.name.trim() ||
    entry.name.length > MAX_ITEM_NAME ||
    !isValidNotes(entry.notes, schemaVersion) ||
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
      schema.plain.has(key)
        ? isValidPlainField(schema.plain.get(key), value, schemaVersion)
        : schema.derived.has(key) && typeof value === "string" && value.length <= MAX_DERIVED_LENGTH) &&
    Object.entries(entry.secrets).every(([key, value]) =>
      schema.secret.has(key) && isValidSealedPassword(value))
  );
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

function isValidLoginEntry(entry, schemaVersion = VAULT_SCHEMA_VERSION) {
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
    if (field === "notes") {
      if (!isValidNotes(entry.notes, schemaVersion)) return false;
    } else if (
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

// Plain item fields, and the keys of the sealed ones present (a secure
// note's body), for an entry or one of its versions.
function splitSealedFields(type, fields) {
  const sealed = new Set(sealedFieldKeys(type));
  return {
    fields: Object.fromEntries(Object.entries(fields).filter(([key]) => !sealed.has(key))),
    sealedFields: Object.keys(fields).filter((key) => sealed.has(key)),
  };
}

// What the page gets when an entry is opened. Notes and sealed text are
// only flagged: they are read with revealText() after real user input
// (src/main/notes-reveal.js).
function toEntryDetails(entry) {
  const shared = {
    hasNotes: Boolean(entry.notes),
    attachments: (entry.attachments ?? []).map(toAttachmentSummary),
    historyCount: entry.history?.length ?? 0,
  };
  if (entry.type !== "login") {
    return {
      ...toEntrySummary(entry),
      ...shared,
      ...splitSealedFields(entry.type, entry.fields),
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

module.exports = {
  ITEM_ENTRY_KEYS,
  MAX_ITEM_NAME,
  MAX_DERIVED_LENGTH,
  itemSchema,
  sealedFieldKeys,
  splitSealedFields,
  isValidNotes,
  isValidItemEntry,
  ITEM_NORMALIZERS,
  normalizeItemInput,
  isFolderIdInput,
  REQUIRED_ENTRY_KEYS,
  OPTIONAL_ENTRY_KEYS,
  hasAllowedEntryKeys,
  isValidLoginEntry,
  itemSubtitle,
  organizationSummary,
  toEntrySummary,
  toEntryDetails,
  isValidFavicon,
  isAllowedWebsite,
  normalizeLoginInput,
};
