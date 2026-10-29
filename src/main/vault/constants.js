// File format, crypto parameters, and limits of the vault.

const FORMAT = "local-vault";
// Format 2 adds a recovery key: the data key is wrapped a second time under a
// key derived from a random recovery key, and the recovery salt is part of the
// authenticated header. Format 1 files (no recovery key) remain readable.
const FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;
const RECOVERY_KDF = "hkdf-sha256";
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_CHECKSUM_BYTES = 3;
// Crockford Base32: no I, L, O, or U, so the key is easy to read and type.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_KEY_CHARACTERS = ((RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES) * 8) / 5;
const RECOVERY_GROUP_SIZE = 4;
// Schema 1 stored passwords as plain strings inside the encrypted vault data.
// Schema 2 additionally seals each password under the vault key, bound to its
// entry ID, so unlocking does not decrypt every password at once.
// Schema 3 adds folders, favorites, the trash, version history, and
// attachments. Older schemas are upgraded in memory on unlock and written as
// schema 3 on the next save.
const VAULT_SCHEMA_VERSION = 3;
const SEALED_SCHEMA_VERSION = 2;
const LEGACY_VAULT_SCHEMA_VERSION = 1;
// Sealed values keep the label of the schema that introduced them, so a new
// schema never changes what an existing sealed value is bound to.
const SEALED_AAD_VERSION = 2;
const KDF = Object.freeze({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VAULT_PLAINTEXT_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_FAVICON_BASE64_LENGTH = Math.ceil(MAX_FAVICON_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ENTRY_LIMITS = Object.freeze({
  name: 200,
  username: 1024,
  password: 4096,
  url: 2048,
  notes: 16384,
});
const TEXT_FIELDS = Object.freeze(["name", "username", "url", "notes"]);
// UTF-8 needs at most three bytes per UTF-16 code unit.
const MAX_SEALED_PASSWORD_BYTES = ENTRY_LIMITS.password * 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PASSPHRASE_BYTES = 1024;
// Existing vaults keep opening with passphrases of 7 or more characters; a
// passphrase that is being set must be longer and rated strong, since it is
// the only protection of the file against offline guessing.
const MIN_PASSPHRASE_CHARACTERS = 7;
const MIN_NEW_PASSPHRASE_CHARACTERS = 12;
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
// Organization (schema 3).
const MAX_FOLDERS = 500;
const MAX_FOLDER_NAME = 100;
const HISTORY_LIMIT = 20;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ENTRY = 20;
const MAX_TOTAL_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const MAX_ATTACHMENT_NAME = 255;
// Optional keys on every entry, stored only when they differ from the
// default: no folder, not a favorite, not in the trash, no attachments, no
// earlier versions.
const META_KEYS = Object.freeze(["folderId", "favorite", "deletedAt", "attachments", "history"]);

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  LEGACY_FORMAT_VERSION,
  RECOVERY_KDF,
  RECOVERY_KEY_BYTES,
  RECOVERY_CHECKSUM_BYTES,
  RECOVERY_ALPHABET,
  RECOVERY_KEY_CHARACTERS,
  RECOVERY_GROUP_SIZE,
  VAULT_SCHEMA_VERSION,
  SEALED_SCHEMA_VERSION,
  LEGACY_VAULT_SCHEMA_VERSION,
  SEALED_AAD_VERSION,
  KDF,
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
  MAX_SEALED_PASSWORD_BYTES,
  UUID_PATTERN,
  MAX_PASSPHRASE_BYTES,
  MIN_PASSPHRASE_CHARACTERS,
  MIN_NEW_PASSPHRASE_CHARACTERS,
  MAX_SCRYPT_MEMORY_BYTES,
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  HISTORY_LIMIT,
  TRASH_RETENTION_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME,
  META_KEYS,
};
