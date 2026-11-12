// Rollback detection: comparing a vault with the record of the newest
// revision this Mac has seen (./revisions.js, docs/design-rollback.md).
// Methods of VaultStore, added to its prototype by ./index.js. A store
// without `revisions` options counts its writes and checks nothing.
const { readRecord, writeRecord, deleteRecord, assessRevision } = require("./revisions");

/** @typedef {import("./index").Instance} Store */

class VaultStoreRevisions {
  // After a vault file decrypted and before it opens, on every path
  // (passphrase, Touch ID, recovery key). Asks the user about a copy that is
  // older than the record, belongs to another vault, or has lost its record;
  // throws when they keep it closed. Nothing is written here.
  /** @this {Store} */
  async admitRevision(vaultData) {
    const options = this.revisionOptions;
    if (!options) return { kind: "current", recordRevision: 0 };
    const verdict = assessRevision(await readRecord(options.recordPath), options.profileId, vaultData);
    if (verdict.kind !== "current") {
      const open = await options.confirm({
        kind: verdict.kind,
        savedAt: vaultData.savedAt,
        revision: vaultData.revision,
        recordRevision: verdict.recordRevision,
      });
      if (!open) throw new Error("The vault was not opened.");
    }
    return verdict;
  }

  // Once the admitted vault is open. A record that is behind, missing, or
  // another vault's is brought up to this vault. After "Open this copy" of
  // an older one the record stays, and the next save goes above it.
  /** @this {Store} */
  async settleRevision(verdict) {
    this.revisionFloor = verdict.recordRevision;
    if (verdict.kind === "older") return;
    if (verdict.kind !== "current" || verdict.recordRevision < this.vaultData.revision) {
      await this.writeRevisionRecord(this.vaultData);
    }
  }

  // After the vault file is written, never before: a crash in between
  // leaves the record behind the file, which the next open accepts. A
  // failure does not fail the save; the next save or open writes it again.
  /** @this {Store} */
  async writeRevisionRecord(vaultData) {
    const options = this.revisionOptions;
    if (!options || vaultData.revision < 1) return;
    try {
      await writeRecord(options.recordPath, options.profileId, vaultData);
    } catch {
      // See above.
    }
  }

  // Before a backup or snapshot replaces this profile's vault: whether it
  // is an older revision of the same vault, and the newest revision known
  // (from the record, and from the vault itself when it is open).
  /** @this {Store} */
  async assessRestore(vaultData) {
    const options = this.revisionOptions;
    if (!options) return { older: false, newest: 0 };
    let newest = assessRevision(await readRecord(options.recordPath), options.profileId, vaultData).recordRevision;
    if (this.isUnlocked() && this.vaultData.vaultId === vaultData.vaultId) {
      newest = Math.max(newest, this.vaultData.revision);
    }
    return { older: newest > vaultData.revision, newest };
  }

  // After a restore replaced the vault file with `vaultData`'s: the record
  // follows it. A backup from before revisions has none until its first save.
  /** @this {Store} */
  async replaceRevisionRecord(vaultData) {
    const options = this.revisionOptions;
    if (!options) return;
    if (vaultData.revision < 1) await deleteRecord(options.recordPath);
    else await this.writeRevisionRecord(vaultData);
  }
}

module.exports = VaultStoreRevisions;
