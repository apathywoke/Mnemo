// Password health reports: weak, reused, and breached login passwords.
//
// Everything runs in the main process. Weak and reused passwords are found
// locally. Breaches are checked against Have I Been Pwned's Pwned Passwords
// range API with k-anonymity: only the first 5 hex characters of each
// password's SHA-1 leave the Mac, responses are padded so their size says
// nothing, and the full hash is compared locally. Only on an explicit click.
//
// Reports name entries by ID only; no password, hash, or fingerprint is
// returned to the renderer.
const { createHash, createHmac } = require("node:crypto");
const https = require("node:https");
const { estimatePasswordStrength } = require("../shared/password-tools.js");

const PWNED_HOST = "api.pwnedpasswords.com";
const MAX_RANGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const SHA1_HEX = /^[0-9A-F]{40}$/;
const RANGE_LINE = /^([0-9A-F]{35}):(\d{1,12})$/;

function sha1Hex(text) {
  return createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
}

// Reads every login password once and keeps only what the report needs: a
// keyed fingerprint (to spot reuse and to remember breach results until
// lock), the SHA-1 for the range query, and whether it is weak.
function collectPasswords(store, fingerprintKey) {
  const passwords = [];
  for (const entry of store.listEntries()) {
    // Items in the trash are not part of the report.
    if (entry.type !== "login" || entry.deletedAt) continue;
    let password;
    try {
      password = store.revealPassword(entry.id);
    } catch {
      continue;
    }
    if (!password) continue;
    passwords.push({
      id: entry.id,
      fingerprint: createHmac("sha256", fingerprintKey).update(password, "utf8").digest("base64"),
      sha1: sha1Hex(password),
      weak: estimatePasswordStrength(password).level === "weak",
    });
  }
  return passwords;
}

// `breaches` maps fingerprints to breach counts from the last check; a
// password changed since then is reported as not yet checked.
function buildReport(passwords, { breaches = null, checkedAt = null } = {}) {
  const groups = new Map();
  for (const { id, fingerprint } of passwords) {
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(id);
  }
  const reused = [...groups.values()]
    .filter((ids) => ids.length > 1)
    .sort((left, right) => right.length - left.length);

  let breached = null;
  let unchecked = 0;
  if (breaches) {
    breached = [];
    for (const { id, fingerprint } of passwords) {
      if (!breaches.has(fingerprint)) unchecked += 1;
      else if (breaches.get(fingerprint) > 0) breached.push({ id, count: breaches.get(fingerprint) });
    }
    breached.sort((left, right) => right.count - left.count);
  }

  return {
    total: passwords.length,
    weak: passwords.filter((password) => password.weak).map((password) => password.id),
    reused,
    breached,
    breachCheckedAt: breaches ? checkedAt : null,
    breachUnchecked: unchecked,
  };
}

// --- Pwned Passwords ----------------------------------------------------------

function getRange(prefix) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: PWNED_HOST,
      path: `/range/${prefix}`,
      headers: {
        "Add-Padding": "true",
        "User-Agent": "Mnemo-password-manager",
        Accept: "text/plain",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Could not reach Have I Been Pwned."));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RANGE_BYTES) {
          request.destroy();
          reject(new Error("Could not reach Have I Been Pwned."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", () => reject(new Error("Could not reach Have I Been Pwned.")));
    });
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Could not reach Have I Been Pwned."));
    });
    request.on("error", () => reject(new Error("Could not reach Have I Been Pwned.")));
  });
}

// Parses a range response into suffix → count. Padding lines have count 0.
function parseRange(text) {
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(RANGE_LINE);
    if (match) counts.set(match[1], Number(match[2]));
  }
  return counts;
}

// Resolves with SHA-1 → times seen in breaches (0 when not found). One
// request per distinct 5-character prefix, a few at a time.
async function checkPwnedHashes(hashes, { get = getRange, concurrency = CONCURRENCY } = {}) {
  const byPrefix = new Map();
  for (const hash of new Set(hashes)) {
    if (!SHA1_HEX.test(hash)) throw new Error("Invalid password hash");
    const prefix = hash.slice(0, 5);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(hash);
  }

  const results = new Map();
  const queue = [...byPrefix.keys()];
  async function worker() {
    while (queue.length > 0) {
      const prefix = queue.shift();
      const counts = parseRange(await get(prefix));
      for (const hash of byPrefix.get(prefix)) results.set(hash, counts.get(hash.slice(5)) ?? 0);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

module.exports = {
  PWNED_HOST,
  buildReport,
  checkPwnedHashes,
  collectPasswords,
  parseRange,
};
