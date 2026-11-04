// Local snapshots of a vault: their files, their descriptions, and which
// ones to keep. The store methods that write and check them are in
// store-snapshots.js.
//
// Layout, next to the vault file (found without profiles.json):
//
//   <vault>.snapshots/<13-digit time>-<16 hex>.vault  a copy of the vault file
//   <vault>.snapshots/<13-digit time>-<16 hex>.json   its description
//   <vault>.snapshots/attachments/<id>.bin            attachment files, shared
//
// A copy is never overwritten. Its description is written after it and says
// whether the copy has been verified: read back and opened with the vault
// key, with every attachment it refers to present and decrypted. Attachment
// files never change after they are written, and key rotation gives them new
// IDs, so one pool file per ID serves every snapshot that refers to it.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { hasExactKeys } = require("./records");
const { UUID_PATTERN, MAX_ENTRIES, MAX_ATTACHMENTS_PER_ENTRY } = require("./constants");

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_FORMAT_VERSION = 1;
// Kept: the newest verified ones, the newest verified one of each recent
// day, and pinned ones until their time runs out.
const KEEP_RECENT = 10;
const KEEP_DAILY_MS = 30 * DAY_MS;
const PIN_MS = 90 * DAY_MS;
// At most one ordinary snapshot per interval; a save in between is taken
// when the interval ends.
const MIN_INTERVAL_MS = 10 * 60 * 1000;
// Files without a description, and pool files no description names, are
// removed only after this long: another writer (the copy taken at launch)
// may be between its two writes.
const INCOMPLETE_GRACE_MS = 60 * 60 * 1000;
const PIN_REASONS = ["upgrade", "rekey", "import", "restore"];
const MAX_DESCRIPTION_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_ATTACHMENTS = MAX_ENTRIES * MAX_ATTACHMENTS_PER_ENTRY;
const SNAPSHOT_NAME = /^(\d{13})-([0-9a-f]{16})$/;

function snapshotDirectoryFor(vaultPath) {
  return `${vaultPath}.snapshots`;
}

function snapshotName(createdAt, randomHex) {
  return `${String(Math.max(0, Math.floor(createdAt))).padStart(13, "0")}-${randomHex}`;
}

// Base names of the snapshot files in a directory listing, with what the
// listing shows about each: { name, hasData, hasDescription }.
function groupSnapshotFiles(fileNames) {
  const groups = new Map();
  for (const fileName of fileNames) {
    const match = fileName.match(/^(.+)\.(vault|json)$/);
    if (!match || !SNAPSHOT_NAME.test(match[1])) continue;
    const group = groups.get(match[1]) ?? { name: match[1], hasData: false, hasDescription: false };
    if (match[2] === "vault") group.hasData = true;
    else group.hasDescription = true;
    groups.set(match[1], group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

function isTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidDescription(value) {
  return (
    hasExactKeys(value, ["version", "createdAt", "sha256", "size", "attachments", "verifiedAt", "pinned"]) &&
    value.version === SNAPSHOT_FORMAT_VERSION &&
    isTime(value.createdAt) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= MAX_SNAPSHOT_ATTACHMENTS &&
    value.attachments.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) &&
    new Set(value.attachments).size === value.attachments.length &&
    (value.verifiedAt === null || isTime(value.verifiedAt)) &&
    (value.pinned === null ||
      (hasExactKeys(value.pinned, ["reason", "until"]) &&
        PIN_REASONS.includes(value.pinned.reason) &&
        isTime(value.pinned.until)))
  );
}

function parseDescription(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return isValidDescription(value) ? value : null;
}

function describeSnapshot({ createdAt, sha256, size, attachments, verifiedAt = null, pinReason = null }) {
  return {
    version: SNAPSHOT_FORMAT_VERSION,
    createdAt,
    sha256,
    size,
    attachments: [...new Set(attachments)].sort(),
    verifiedAt,
    pinned: pinReason ? { reason: pinReason, until: createdAt + PIN_MS } : null,
  };
}

function localDay(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

const newestFirst = (a, b) =>
  b.description.createdAt - a.description.createdAt || b.name.localeCompare(a.name);

// Names of the snapshots to remove. `snapshots`: [{ name, description }],
// complete ones only. Only verified snapshots count toward what is kept; the
// newest verified one is never removed, and nothing is removed while there
// is no verified snapshot at all. An unverified snapshot newer than the
// newest verified one waits for its check. Times in the future (a clock that
// went back) count as now.
function snapshotsToRemove(snapshots, now) {
  const verified = snapshots.filter((item) => item.description.verifiedAt !== null).sort(newestFirst);
  if (verified.length === 0) return [];
  const keep = new Set();
  const isPinned = (item) => item.description.pinned !== null && item.description.pinned.until > now;
  const ageOf = (item) => Math.max(0, now - item.description.createdAt);

  verified.slice(0, KEEP_RECENT).forEach((item) => keep.add(item.name));
  const days = new Set();
  for (const item of verified) {
    if (ageOf(item) > KEEP_DAILY_MS) continue;
    const day = localDay(Math.min(item.description.createdAt, now));
    if (days.has(day)) continue;
    days.add(day);
    keep.add(item.name);
  }
  const newestVerified = verified[0];
  for (const item of snapshots) {
    if (isPinned(item)) keep.add(item.name);
    if (item.description.verifiedAt === null &&
      (newestFirst(item, newestVerified) < 0 || ageOf(item) <= KEEP_DAILY_MS)) {
      keep.add(item.name);
    }
  }
  return snapshots.filter((item) => !keep.has(item.name)).map((item) => item.name);
}

// Reads a whole file, refusing anything larger than `limit` bytes.
async function readSmallFile(filePath, limit) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > limit) throw new Error("invalid");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// The snapshots in `directory`: complete ones ({ name, description }),
// newest first, and incomplete ones (a copy without a description, or the
// reverse). A missing folder has none.
async function listSnapshotDirectory(directory) {
  let fileNames;
  try {
    fileNames = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { complete: [], incomplete: [] };
    throw error;
  }
  const complete = [];
  const incomplete = [];
  for (const group of groupSnapshotFiles(fileNames)) {
    let description = null;
    if (group.hasData && group.hasDescription) {
      try {
        description = parseDescription(await readSmallFile(path.join(directory, `${group.name}.json`), MAX_DESCRIPTION_BYTES));
      } catch {
        description = null;
      }
    }
    if (description) complete.push({ name: group.name, description });
    else incomplete.push(group);
  }
  complete.sort(newestFirst);
  return { complete, incomplete };
}

module.exports = {
  DAY_MS,
  KEEP_RECENT,
  KEEP_DAILY_MS,
  PIN_MS,
  MIN_INTERVAL_MS,
  INCOMPLETE_GRACE_MS,
  PIN_REASONS,
  MAX_DESCRIPTION_BYTES,
  snapshotDirectoryFor,
  snapshotName,
  groupSnapshotFiles,
  sha256Hex,
  isValidDescription,
  parseDescription,
  describeSnapshot,
  snapshotsToRemove,
  newestFirst,
  listSnapshotDirectory,
};
