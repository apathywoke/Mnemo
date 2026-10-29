// Attachment files and their records in the vault data.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");
const {
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  UUID_PATTERN,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME,
} = require("./constants");
const { hasExactKeys, decodeBase64 } = require("./records");
const { encryptGcm, decryptGcm } = require("./crypto");
const { isGcmRecord } = require("./envelope");

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

module.exports = {
  ATTACHMENT_MAGIC,
  ATTACHMENT_OVERHEAD,
  getAttachmentKeyAad,
  getAttachmentFileAad,
  sealAttachmentKey,
  openAttachmentKey,
  encryptAttachment,
  decryptAttachment,
  truncateUnits,
  normalizeAttachmentName,
  isValidSealedKey,
  isValidAttachment,
  toAttachmentSummary,
  attachmentsOf,
  pathExists,
  readFileWithLimit,
};
