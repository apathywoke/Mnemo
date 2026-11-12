// Detecting a rollback to an older copy of a vault (docs/design-rollback.md).
//
// Inside the vault data: `vaultId`, `revision` (plus one on every write),
// `savedAt` (the time of that write), and `revisionKey`. Outside it, one
// record per profile, { version, vaultId, revision, mac }: the newest
// revision this Mac has seen. Its MAC is keyed with `revisionKey`, so
// writing a record that passes needs the vault's key.
const fs = require("node:fs/promises");
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { writeFileDurably } = require("../durable-file");
const { UUID_PATTERN } = require("./constants");
const { hasExactKeys, decodeBase64 } = require("./records");

const REVISION_KEYS = Object.freeze(["vaultId", "revision", "savedAt", "revisionKey"]);
const REVISION_KEY_BYTES = 32;
const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 1024;

// For a vault that has never been saved with a revision: revision 0 is
// "not tracked", and exists only in memory.
function newRevisionFields() {
  return {
    vaultId: randomUUID(),
    revision: 0,
    savedAt: null,
    revisionKey: randomBytes(REVISION_KEY_BYTES).toString("base64"),
  };
}

const isRevisionNumber = (value) => Number.isSafeInteger(value) && value >= 1;

// The fields as a saved vault has them: a write happened, so revision ≥ 1.
function isValidRevisionFields(value) {
  if (
    typeof value?.vaultId !== "string" ||
    !UUID_PATTERN.test(value.vaultId) ||
    !isRevisionNumber(value.revision) ||
    !Number.isSafeInteger(value.savedAt) ||
    value.savedAt < 0
  ) {
    return false;
  }
  try {
    decodeBase64(value.revisionKey, REVISION_KEY_BYTES).fill(0);
    return true;
  } catch {
    return false;
  }
}

function revisionFieldsOf(vaultData) {
  return {
    vaultId: vaultData.vaultId,
    revision: vaultData.revision,
    savedAt: vaultData.savedAt,
    revisionKey: vaultData.revisionKey,
  };
}

// The fields of the next write of `vaultData`. `floor` is the newest
// revision known from elsewhere (the record), so the counter never goes down.
function nextRevisionFields(vaultData, floor = 0, now = Date.now()) {
  return {
    vaultId: vaultData.vaultId,
    revision: Math.max(vaultData.revision, floor) + 1,
    savedAt: now,
    revisionKey: vaultData.revisionKey,
  };
}

function recordMac(revisionKey, profileId, vaultId, revision) {
  const key = decodeBase64(revisionKey, REVISION_KEY_BYTES);
  try {
    return createHmac("sha256", key)
      .update(`local-vault:revision-record:v1:${profileId}:${vaultId}:${revision}`, "utf8")
      .digest();
  } finally {
    key.fill(0);
  }
}

// The record at `recordPath` if it has the right shape, else null. Its MAC
// is not checked here (that needs the vault).
async function readRecord(recordPath) {
  try {
    const stats = await fs.stat(recordPath);
    if (stats.size <= 0 || stats.size > MAX_RECORD_BYTES) return null;
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    if (
      !hasExactKeys(record, ["version", "vaultId", "revision", "mac"]) ||
      record.version !== RECORD_VERSION ||
      typeof record.vaultId !== "string" ||
      !UUID_PATTERN.test(record.vaultId) ||
      !isRevisionNumber(record.revision) ||
      typeof record.mac !== "string"
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function writeRecord(recordPath, profileId, vaultData) {
  const { vaultId, revision, revisionKey } = vaultData;
  const mac = recordMac(revisionKey, profileId, vaultId, revision).toString("base64");
  const contents = Buffer.from(JSON.stringify({ version: RECORD_VERSION, vaultId, revision, mac }), "utf8");
  await writeFileDurably(recordPath, contents);
}

async function deleteRecord(recordPath) {
  await fs.unlink(recordPath).catch(() => {});
}

function hasValidMac(record, profileId, vaultData) {
  try {
    const expected = recordMac(vaultData.revisionKey, profileId, record.vaultId, record.revision);
    const actual = Buffer.from(record.mac, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// What the record says about a vault that just decrypted:
// - "current": nothing to ask (the record may be behind and is raised);
// - "noRecord": the vault is tracked and has no valid record. A record whose
//   MAC fails counts as none, never as a lower or higher revision;
// - "differentVault": the record belongs to another vault;
// - "older": the record has seen a newer revision of this vault.
// `recordRevision` is the record's revision when its MAC holds, else 0.
function assessRevision(record, profileId, vaultData) {
  const tracked = vaultData.revision >= 1;
  if (!record) return { kind: tracked ? "noRecord" : "current", recordRevision: 0 };
  if (record.vaultId !== vaultData.vaultId) return { kind: "differentVault", recordRevision: 0 };
  if (!hasValidMac(record, profileId, vaultData)) return { kind: tracked ? "noRecord" : "current", recordRevision: 0 };
  return {
    kind: record.revision > vaultData.revision ? "older" : "current",
    recordRevision: record.revision,
  };
}

module.exports = {
  REVISION_KEYS,
  newRevisionFields,
  isValidRevisionFields,
  revisionFieldsOf,
  nextRevisionFields,
  readRecord,
  writeRecord,
  deleteRecord,
  assessRevision,
};
