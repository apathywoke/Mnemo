// Reading and writing Mnemo vault and backup files.
//
// A vault file, and a backup of a vault without attachments, is the
// encrypted envelope as JSON. A backup of a vault with attachments is a
// container that carries the same envelope plus the attachment files, which
// are already encrypted and are copied as they are:
//
//   "MNEMOBK1" | header length (uint32, big-endian) | header JSON | files…
//
// The header is { format, version, vault: <envelope>, attachments: [{ id,
// size }] }, and the files follow in the same order. Nothing in the
// container is decrypted or re-encrypted to write it; the keys for the
// attachments live inside the encrypted vault data.
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");

const BACKUP_MAGIC = Buffer.from("MNEMOBK1", "ascii");
const BACKUP_FORMAT = "mnemo-backup";
const BACKUP_VERSION = 1;
const PREFIX_BYTES = BACKUP_MAGIC.length + 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid() {
  return new Error("Invalid vault file");
}

async function readExactly(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw invalid();
    offset += bytesRead;
  }
  return buffer;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

// Opens a vault or backup file. Resolves with { envelopeBytes } for a plain
// envelope (the caller parses and wipes it), or with { envelope, container }
// for a container, where `container.blobs` maps attachment IDs to their
// place in the file. Sizes are checked against `limits` before anything
// large is read, and a container must end exactly after its last file.
async function openVaultSource(filePath, limits) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0) throw invalid();
    const prefixLength = Math.min(PREFIX_BYTES, stats.size);
    const prefix = await readExactly(handle, 0, prefixLength);
    if (prefixLength < PREFIX_BYTES || !prefix.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
      if (stats.size > limits.maxEnvelopeBytes) throw invalid();
      return { envelopeBytes: await readExactly(handle, 0, stats.size), container: null };
    }
    if (!limits.allowContainer) throw invalid();

    const headerLength = prefix.readUInt32BE(BACKUP_MAGIC.length);
    if (headerLength <= 0 || headerLength > limits.maxHeaderBytes || PREFIX_BYTES + headerLength > stats.size) {
      throw invalid();
    }
    const headerBytes = await readExactly(handle, PREFIX_BYTES, headerLength);
    let header;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw invalid();
    }
    if (
      header === null ||
      typeof header !== "object" ||
      Object.keys(header).length !== 4 ||
      header.format !== BACKUP_FORMAT ||
      header.version !== BACKUP_VERSION ||
      header.vault === null ||
      typeof header.vault !== "object" ||
      !Array.isArray(header.attachments) ||
      header.attachments.length > limits.maxAttachments
    ) {
      throw invalid();
    }

    const blobs = new Map();
    let offset = PREFIX_BYTES + headerLength;
    for (const attachment of header.attachments) {
      if (
        attachment === null ||
        typeof attachment !== "object" ||
        Object.keys(attachment).length !== 2 ||
        typeof attachment.id !== "string" ||
        !UUID_PATTERN.test(attachment.id) ||
        blobs.has(attachment.id) ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size <= 0 ||
        attachment.size > limits.maxAttachmentFileBytes
      ) {
        throw invalid();
      }
      blobs.set(attachment.id, { offset, size: attachment.size });
      offset += attachment.size;
    }
    if (offset !== stats.size) throw invalid();
    return { envelope: header.vault, container: { filePath, blobs } };
  } finally {
    await handle.close();
  }
}

// The encrypted bytes of one attachment from a container.
async function readContainerFile(container, id) {
  const blob = container.blobs.get(id);
  if (!blob) throw invalid();
  const handle = await fs.open(container.filePath, "r");
  try {
    return await readExactly(handle, blob.offset, blob.size);
  } finally {
    await handle.close();
  }
}

// Writes a container atomically (temporary file, fsync, rename), reading the
// attachment files one at a time. `attachments` is [{ id, path, size }];
// each file must still have exactly the expected size.
async function writeContainer(destinationPath, envelope, attachments) {
  const header = Buffer.from(JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    vault: envelope,
    attachments: attachments.map(({ id, size }) => ({ id, size })),
  }), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  BACKUP_MAGIC.copy(prefix);
  prefix.writeUInt32BE(header.length, BACKUP_MAGIC.length);

  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await writeAll(handle, prefix);
    await writeAll(handle, header);
    for (const attachment of attachments) {
      const bytes = await fs.readFile(attachment.path);
      if (bytes.length !== attachment.size) {
        throw Object.assign(new Error("invalid"), { attachmentId: attachment.id });
      }
      await writeAll(handle, bytes);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    header.fill(0);
  }
}

module.exports = { BACKUP_MAGIC, openVaultSource, readContainerFile, writeContainer };
