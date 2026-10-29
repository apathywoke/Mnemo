// AES-256-GCM records, the scrypt wrapping key, and the sealed per-entry
// secrets (passwords, one-time code settings, item fields) with their AAD.
const { promisify } = require("node:util");
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} = require("node:crypto");
const { parseTotpInput, toOtpauthUri } = require("../../../totp");
const {
  SEALED_AAD_VERSION,
  KDF,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  MAX_FILE_BYTES,
  MAX_SEALED_PASSWORD_BYTES,
  MAX_SCRYPT_MEMORY_BYTES,
} = require("./constants");
const { hasExactKeys, decodeBase64 } = require("./records");

const scryptAsync = promisify(scrypt);

function encryptGcm(plaintext, key, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  return {
    name: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptGcm(record, key, aad, exactCiphertextLength = null) {
  const nonce = decodeBase64(record.nonce, NONCE_BYTES, NONCE_BYTES);
  const tag = decodeBase64(record.tag, TAG_BYTES, TAG_BYTES);
  const ciphertext = decodeBase64(
    record.ciphertext,
    exactCiphertextLength ?? 1,
    MAX_FILE_BYTES,
  );

  if (
    exactCiphertextLength !== null &&
    ciphertext.length !== exactCiphertextLength
  ) {
    throw new Error("Invalid vault file");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// One-time code settings are sealed like passwords, under their own purpose
// label so a sealed password and a sealed TOTP secret cannot be swapped.
function getTotpAad(entryId) {
  return Buffer.from(
    `local-vault:entry-totp:v${SEALED_AAD_VERSION}:${entryId}`,
    "utf8",
  );
}

function sealTotp(config, dataKey, entryId) {
  const plaintext = Buffer.from(JSON.stringify(config), "utf8");
  try {
    return encryptGcm(plaintext, dataKey, getTotpAad(entryId));
  } finally {
    plaintext.fill(0);
  }
}

function openTotp(record, dataKey, entryId) {
  const plaintext = decryptGcm(record, dataKey, getTotpAad(entryId));
  try {
    // Re-validate through the parser so stored values meet the same rules.
    return parseTotpInput(toOtpauthUri(JSON.parse(plaintext.toString("utf8"))));
  } finally {
    plaintext.fill(0);
  }
}

function getPasswordAad(entryId) {
  return Buffer.from(
    `local-vault:entry-password:v${SEALED_AAD_VERSION}:${entryId}`,
    "utf8",
  );
}

function sealPassword(password, dataKey, entryId) {
  const plaintext = Buffer.from(password, "utf8");
  try {
    return encryptGcm(plaintext, dataKey, getPasswordAad(entryId));
  } finally {
    plaintext.fill(0);
  }
}

function openPassword(record, dataKey, entryId) {
  const plaintext = decryptGcm(record, dataKey, getPasswordAad(entryId));
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

function isValidSealedPassword(record) {
  if (
    !hasExactKeys(record, ["name", "nonce", "tag", "ciphertext"]) ||
    record.name !== "aes-256-gcm"
  ) {
    return false;
  }
  try {
    decodeBase64(record.nonce, NONCE_BYTES, NONCE_BYTES);
    decodeBase64(record.tag, TAG_BYTES, TAG_BYTES);
    decodeBase64(record.ciphertext, 1, MAX_SEALED_PASSWORD_BYTES);
    return true;
  } catch {
    return false;
  }
}

async function deriveWrappingKey(passphrase, salt) {
  const passwordBytes = Buffer.from(passphrase, "utf8");
  try {
    return await scryptAsync(passwordBytes, salt, KEY_BYTES, {
      N: KDF.N,
      r: KDF.r,
      p: KDF.p,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    });
  } finally {
    passwordBytes.fill(0);
  }
}

function getItemSecretAad(entryId, field) {
  return Buffer.from(
    `local-vault:item-secret:v${SEALED_AAD_VERSION}:${entryId}:${field}`,
    "utf8",
  );
}

function sealItemSecret(value, dataKey, entryId, field) {
  const plaintext = Buffer.from(value, "utf8");
  try {
    return encryptGcm(plaintext, dataKey, getItemSecretAad(entryId, field));
  } finally {
    plaintext.fill(0);
  }
}

function openItemSecret(record, dataKey, entryId, field) {
  const plaintext = decryptGcm(record, dataKey, getItemSecretAad(entryId, field));
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

module.exports = {
  scryptAsync,
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
};
