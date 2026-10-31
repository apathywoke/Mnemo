// The vault file envelope: header, AAD, passphrase rules, and wrapping the
// vault key with the passphrase and the recovery key.
const {
  randomBytes,
} = require("node:crypto");
const { estimatePasswordStrength } = require("../../shared/password-tools");
const {
  FORMAT,
  FORMAT_VERSION,
  LEGACY_FORMAT_VERSION,
  RECOVERY_KDF,
  RECOVERY_KEY_BYTES,
  KDF,
  KEY_BYTES,
  SALT_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  MAX_FILE_BYTES,
  MAX_PASSPHRASE_BYTES,
  MIN_PASSPHRASE_CHARACTERS,
  MIN_NEW_PASSPHRASE_CHARACTERS,
} = require("./constants");
const { hasExactKeys, decodeBase64 } = require("./records");
const { encodeRecoveryKey, deriveRecoveryWrappingKey } = require("./recovery-key");
const { encryptGcm, deriveWrappingKey } = require("./crypto");

function getHeader(kdf, recovery = null) {
  return recovery
    ? { format: FORMAT, version: FORMAT_VERSION, kdf, recovery }
    : { format: FORMAT, version: LEGACY_FORMAT_VERSION, kdf };
}

function headerOf(envelope) {
  return getHeader(envelope.kdf, envelope.recovery ?? null);
}

function getAad(purpose, header) {
  return Buffer.from(
    `local-vault:${purpose}:v${header.version}:${JSON.stringify(header)}`,
    "utf8",
  );
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string") {
    throw new Error("Enter a master passphrase.");
  }

  const characterCount = Array.from(passphrase).length;
  const byteCount = Buffer.byteLength(passphrase, "utf8");

  if (characterCount < MIN_PASSPHRASE_CHARACTERS) {
    throw new Error(
      `The master passphrase must be at least ${MIN_PASSPHRASE_CHARACTERS} characters long.`,
    );
  }
  if (byteCount > MAX_PASSPHRASE_BYTES) {
    throw new Error("The master passphrase is too long.");
  }
}

// For a passphrase being set (new vault, recovery, restore with the recovery
// key), with the same estimate the editor shows. Unlocking and other checks
// of the current passphrase use validatePassphrase() only.
function validateNewPassphrase(passphrase) {
  // The 12-character rule is reported first, not the 7-character floor.
  if (typeof passphrase === "string" && Array.from(passphrase).length < MIN_NEW_PASSPHRASE_CHARACTERS) {
    throw new Error(
      `The master passphrase must be at least ${MIN_NEW_PASSPHRASE_CHARACTERS} characters long.`,
    );
  }
  validatePassphrase(passphrase);
  if (estimatePasswordStrength(passphrase).level !== "strong") {
    throw new Error("This master passphrase is too easy to guess. Use a longer phrase of several unrelated words.");
  }
}

// Builds a format 2 envelope with fresh salts and a new recovery key. Returns
// the envelope and the recovery key text, which is shown to the user once.
async function makeEnvelope(vaultData, passphrase, dataKey) {
  const salt = randomBytes(SALT_BYTES);
  const recoverySalt = randomBytes(SALT_BYTES);
  const recoveryKeyBytes = randomBytes(RECOVERY_KEY_BYTES);
  let wrappingKey = null;
  let recoveryWrappingKey = null;
  const serializedVault = Buffer.from(JSON.stringify(vaultData), "utf8");

  try {
    wrappingKey = await deriveWrappingKey(passphrase, salt);
    recoveryWrappingKey = deriveRecoveryWrappingKey(recoveryKeyBytes, recoverySalt);
    const header = getHeader(
      { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString("base64") },
      { name: RECOVERY_KDF, salt: recoverySalt.toString("base64") },
    );
    const envelope = {
      ...header,
      keyWrap: encryptGcm(dataKey, wrappingKey, getAad("key-wrap", header)),
      recoveryWrap: encryptGcm(dataKey, recoveryWrappingKey, getAad("recovery-wrap", header)),
      data: encryptGcm(serializedVault, dataKey, getAad("vault-data", header)),
    };
    return { envelope, recoveryKey: encodeRecoveryKey(recoveryKeyBytes) };
  } finally {
    serializedVault.fill(0);
    wrappingKey?.fill(0);
    recoveryWrappingKey?.fill(0);
    recoveryKeyBytes.fill(0);
    salt.fill(0);
    recoverySalt.fill(0);
  }
}

// A vault file in a newer format than this version reads. It cannot be
// decrypted here, but it is not a damaged file.
function isNewerEnvelope(envelope) {
  return envelope?.format === FORMAT && Number.isSafeInteger(envelope.version) && envelope.version > FORMAT_VERSION;
}

function isGcmRecord(value) {
  return hasExactKeys(value, ["name", "nonce", "tag", "ciphertext"]) &&
    value.name === "aes-256-gcm";
}

function parseEnvelope(envelope) {
  const hasRecovery = envelope?.version === FORMAT_VERSION;
  const expectedKeys = hasRecovery
    ? ["format", "version", "kdf", "recovery", "keyWrap", "recoveryWrap", "data"]
    : ["format", "version", "kdf", "keyWrap", "data"];
  if (
    !hasExactKeys(envelope, expectedKeys) ||
    envelope.format !== FORMAT ||
    (envelope.version !== FORMAT_VERSION && envelope.version !== LEGACY_FORMAT_VERSION) ||
    (hasRecovery &&
      (!hasExactKeys(envelope.recovery, ["name", "salt"]) ||
        envelope.recovery.name !== RECOVERY_KDF ||
        !isGcmRecord(envelope.recoveryWrap))) ||
    !hasExactKeys(envelope.kdf, ["name", "N", "r", "p", "salt"]) ||
    envelope.kdf.name !== KDF.name ||
    envelope.kdf.N !== KDF.N ||
    envelope.kdf.r !== KDF.r ||
    envelope.kdf.p !== KDF.p ||
    !hasExactKeys(envelope.keyWrap, ["name", "nonce", "tag", "ciphertext"]) ||
    !hasExactKeys(envelope.data, ["name", "nonce", "tag", "ciphertext"]) ||
    envelope.keyWrap.name !== "aes-256-gcm" ||
    envelope.data.name !== "aes-256-gcm"
  ) {
    throw new Error("Invalid vault file");
  }

  const salt = decodeBase64(envelope.kdf.salt, SALT_BYTES, SALT_BYTES);
  // Validate lengths and base64 encoding before doing the expensive KDF.
  decodeBase64(envelope.keyWrap.nonce, NONCE_BYTES, NONCE_BYTES);
  decodeBase64(envelope.keyWrap.tag, TAG_BYTES, TAG_BYTES);
  decodeBase64(envelope.keyWrap.ciphertext, KEY_BYTES, KEY_BYTES);
  decodeBase64(envelope.data.nonce, NONCE_BYTES, NONCE_BYTES);
  decodeBase64(envelope.data.tag, TAG_BYTES, TAG_BYTES);
  decodeBase64(envelope.data.ciphertext, 1, MAX_FILE_BYTES);
  let recoverySalt = null;
  if (hasRecovery) {
    recoverySalt = decodeBase64(envelope.recovery.salt, SALT_BYTES, SALT_BYTES);
    decodeBase64(envelope.recoveryWrap.nonce, NONCE_BYTES, NONCE_BYTES);
    decodeBase64(envelope.recoveryWrap.tag, TAG_BYTES, TAG_BYTES);
    decodeBase64(envelope.recoveryWrap.ciphertext, KEY_BYTES, KEY_BYTES);
  }

  return { salt, recoverySalt, header: headerOf(envelope) };
}

module.exports = {
  getHeader,
  headerOf,
  getAad,
  validatePassphrase,
  validateNewPassphrase,
  makeEnvelope,
  isNewerEnvelope,
  isGcmRecord,
  parseEnvelope,
};
