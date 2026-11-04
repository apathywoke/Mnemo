// Local snapshots: taking, verifying, pinning, and rotating them. Methods of
// VaultStore, added to its prototype by ./index.js. Layout and retention
// rules are in ./snapshots.js.
//
// A snapshot is taken from the vault file as it is on disk, inside the
// mutation queue, so it matches one saved state. It counts only once it is
// verified: its bytes read back, its key wraps equal to those of the file
// that is open, its data decrypted with the vault key, and every attachment
// it refers to present in the pool and decrypted. Without the vault key (at
// launch, or before a restore while locked) a copy is kept unverified and
// checked at the next unlock. Snapshot failures never stop a save.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const VaultStore = require("./store");
const { MAX_FILE_BYTES, MAX_ATTACHMENT_BYTES, UUID_PATTERN } = require("./constants");
const { decryptGcm } = require("./crypto");
const { headerOf, getAad, parseEnvelope } = require("./envelope");
const { validateVaultData } = require("./schema");
const {
  ATTACHMENT_OVERHEAD,
  openAttachmentKey,
  decryptAttachment,
  attachmentsOf,
  readFileWithLimit,
} = require("./attachments");
const {
  MIN_INTERVAL_MS,
  INCOMPLETE_GRACE_MS,
  MAX_DESCRIPTION_BYTES,
  snapshotDirectoryFor,
  snapshotName,
  groupSnapshotFiles,
  sha256Hex,
  parseDescription,
  describeSnapshot,
  snapshotsToRemove,
} = require("./snapshots");

/** @typedef {import("./index").Instance} Store */

// Internal errors; never shown (snapshot failures are only remembered).
const INTERRUPTED = "snapshot interrupted";

// The parts of an envelope that decide which secrets open it.
function keyMaterialOf(envelope) {
  return JSON.stringify([headerOf(envelope), envelope.keyWrap, envelope.recoveryWrap ?? null]);
}

function readEnvelope(bytes) {
  const envelope = JSON.parse(bytes.toString("utf8"));
  const parsed = parseEnvelope(envelope);
  parsed.salt.fill(0);
  parsed.recoverySalt?.fill(0);
  return { envelope, header: parsed.header };
}

class VaultStoreSnapshots {
  static snapshotDirectoryFor(vaultPath) {
    return snapshotDirectoryFor(vaultPath);
  }

  /** @this {Store} */
  get snapshotDirectory() {
    return snapshotDirectoryFor(this.filePath);
  }

  /** @this {Store} */
  get snapshotPoolDirectory() {
    return path.join(this.snapshotDirectory, "attachments");
  }

  /** @this {Store} */
  snapshotNow() {
    return this.snapshotOptions.now();
  }

  /** @this {Store} */
  async ensureSnapshotDirectories() {
    for (const directory of [this.snapshotDirectory, this.snapshotPoolDirectory]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(directory, 0o700);
    }
  }

  // Complete snapshots ({ name, description }), newest first, and
  // incomplete ones (a copy without a description, or the reverse).
  /** @this {Store} */
  async listSnapshots() {
    let fileNames;
    try {
      fileNames = await fs.readdir(this.snapshotDirectory);
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
          description = parseDescription(await readFileWithLimit(this.snapshotFile(group.name, "json"), MAX_DESCRIPTION_BYTES));
        } catch {
          description = null;
        }
      }
      if (description) complete.push({ name: group.name, description });
      else incomplete.push(group);
    }
    complete.sort((a, b) => b.description.createdAt - a.description.createdAt || b.name.localeCompare(a.name));
    return { complete, incomplete };
  }

  /** @this {Store} */
  snapshotFile(name, extension) {
    return path.join(this.snapshotDirectory, `${name}.${extension}`);
  }

  /** @this {Store} */
  async writeSnapshotDescription(name, description) {
    const contents = Buffer.from(JSON.stringify(description), "utf8");
    await this.writeBytesAtomically(this.snapshotFile(name, "json"), contents);
  }

  // Reads the vault file for a snapshot. Null when there is no vault file.
  /** @this {Store} */
  async readVaultFileForSnapshot() {
    try {
      return await readFileWithLimit(this.filePath, MAX_FILE_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  // Writes a new snapshot: the copy first, then its description. Returns its
  // name. Its time is after `newestAt` (the newest snapshot's) even when the
  // clock disagrees, so the newest snapshot is always the latest state.
  /** @this {Store} */
  async writeSnapshotFiles(bytes, { attachments, verifiedAt, pinReason, newestAt }) {
    const createdAt = Math.max(this.snapshotNow(), (newestAt ?? 0) + 1);
    const name = snapshotName(createdAt, randomBytes(8).toString("hex"));
    await this.ensureSnapshotDirectories();
    await this.writeBytesAtomically(this.snapshotFile(name, "vault"), bytes);
    const description = describeSnapshot({
      createdAt,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      attachments,
      verifiedAt,
      pinReason,
    });
    await this.writeSnapshotDescription(name, description);
    return { name, description };
  }

  // Pins an existing snapshot (for 90 days from now) instead of copying the
  // same file again.
  /** @this {Store} */
  async pinSnapshot(snapshot, pinReason) {
    const pinned = /** @type {{ reason: string, until: number }} */ (
      describeSnapshot({ ...snapshot.description, createdAt: this.snapshotNow(), pinReason }).pinned);
    if (snapshot.description.pinned && snapshot.description.pinned.until >= pinned.until) return;
    await this.writeSnapshotDescription(snapshot.name, { ...snapshot.description, pinned });
  }

  // --- Without the vault key -----------------------------------------------------

  // Copies the vault file, and attachment files not yet in the pool, as an
  // unverified snapshot. Works while locked. Skips (or only pins) when the
  // newest snapshot already holds the same file.
  /**
   * @this {Store}
   * @param {{ pinReason?: string | null }} [options]
   */
  async copyUnverifiedSnapshotNow({ pinReason = null } = {}) {
    const bytes = await this.readVaultFileForSnapshot();
    if (!bytes) return null;
    try {
      const sha256 = sha256Hex(bytes);
      const { complete } = await this.listSnapshots();
      const newest = complete[0];
      if (newest && newest.description.sha256 === sha256) {
        if (pinReason) await this.pinSnapshot(newest, pinReason);
        return newest.name;
      }
      await this.ensureSnapshotDirectories();
      const attachments = [];
      let names = [];
      try {
        names = await fs.readdir(this.attachmentDirectory);
      } catch {
        // No attachments.
      }
      for (const fileName of names) {
        const match = fileName.match(/^(.+)\.bin$/);
        if (!match || !UUID_PATTERN.test(match[1])) continue;
        const target = path.join(this.snapshotPoolDirectory, fileName);
        try {
          await fs.access(target);
        } catch {
          const fileBytes = await readFileWithLimit(path.join(this.attachmentDirectory, fileName), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
          try {
            await this.writeBytesAtomically(target, fileBytes);
          } finally {
            fileBytes.fill(0);
          }
        }
        attachments.push(match[1]);
      }
      return (await this.writeSnapshotFiles(bytes, {
        attachments,
        verifiedAt: null,
        pinReason,
        newestAt: newest?.description.createdAt,
      })).name;
    } finally {
      bytes.fill(0);
    }
  }

  // --- With the vault key ----------------------------------------------------------

  // Decrypts a snapshot's bytes with the open vault's key after checking
  // that they carry the same key wraps as the open vault. Returns the
  // attachments its data refers to.
  /** @this {Store} */
  openSnapshotBytes(bytes, epoch) {
    if (this.sessionEpoch !== epoch || !this.isUnlocked()) throw new Error(INTERRUPTED);
    const { envelope, header } = readEnvelope(bytes);
    if (keyMaterialOf(envelope) !== keyMaterialOf(this.envelope)) {
      throw Object.assign(new Error("snapshot key"), { otherKey: true });
    }
    const plaintext = decryptGcm(envelope.data, this.dataKey, getAad("vault-data", header));
    try {
      const vaultData = JSON.parse(plaintext.toString("utf8"));
      if (!validateVaultData(vaultData)) throw new Error("Invalid vault data");
      return attachmentsOf(vaultData);
    } finally {
      plaintext.fill(0);
    }
  }

  // Makes sure the pool holds a good copy of an attachment. A file already
  // there is decrypted when `full` is set and otherwise checked by size; a
  // missing or damaged one is copied from the vault's own folder after it
  // decrypts.
  /** @this {Store} */
  async poolAttachment(entryId, attachment, { full, epoch }) {
    const target = path.join(this.snapshotPoolDirectory, `${attachment.id}.bin`);
    const expectedSize = attachment.size + ATTACHMENT_OVERHEAD;
    const decrypts = async (filePath) => {
      let fileBytes = null;
      let fileKey = null;
      try {
        fileBytes = await readFileWithLimit(filePath, MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
        if (this.sessionEpoch !== epoch || !this.isUnlocked()) throw new Error(INTERRUPTED);
        fileKey = openAttachmentKey(attachment.key, this.dataKey, entryId, attachment.id);
        decryptAttachment(fileBytes, fileKey, attachment.id, attachment.size).fill(0);
        return Buffer.from(fileBytes);
      } catch (error) {
        if (error?.message === INTERRUPTED) throw error;
        return null;
      } finally {
        fileBytes?.fill(0);
        fileKey?.fill(0);
      }
    };

    let size = null;
    try {
      size = (await fs.stat(target)).size;
    } catch {
      // Not in the pool yet.
    }
    if (size === expectedSize) {
      if (!full) return;
      const good = await decrypts(target);
      if (good) {
        good.fill(0);
        return;
      }
    }
    const source = await decrypts(this.attachmentPath(attachment.id));
    if (!source) throw new Error("snapshot damaged");
    try {
      if (this.sessionEpoch !== epoch) throw new Error(INTERRUPTED);
      await this.writeBytesAtomically(target, source);
    } finally {
      source.fill(0);
    }
  }

  // Takes a verified snapshot of the vault file. Ordinary snapshots are
  // taken at most once per MIN_INTERVAL_MS unless `force` is set; a pinned
  // one is always taken. Nothing is copied when the newest snapshot holds the
  // same file (it is pinned instead, when asked). Returns the snapshot's
  // name, or null when none was needed yet.
  /**
   * @this {Store}
   * @param {{ pinReason?: string | null, force?: boolean }} [options]
   */
  async takeSnapshotNow({ pinReason = null, force = false } = {}) {
    this.requireUnlocked();
    const epoch = this.sessionEpoch;
    const check = () => {
      if (this.sessionEpoch !== epoch || !this.isUnlocked()) throw new Error(INTERRUPTED);
    };
    const now = this.snapshotNow();
    const { complete } = await this.listSnapshots();
    check();
    const newest = complete[0];
    const bytes = await this.readVaultFileForSnapshot();
    check();
    if (!bytes) return null;
    try {
      const sha256 = sha256Hex(bytes);
      let same = newest?.description.sha256 === sha256;
      if (same && newest.description.verifiedAt === null) {
        // An unverified copy of this file counts only once it checks out;
        // a damaged one is replaced by a new snapshot.
        try {
          same = await this.verifySnapshotNow(newest, epoch);
        } catch (error) {
          if (error?.message === INTERRUPTED) throw error;
          same = false;
        }
      }
      if (same) {
        if (pinReason) await this.pinSnapshot(newest, pinReason);
        this.lastSnapshotAt = newest.description.createdAt;
        return newest.name;
      }
      const lastAt = newest?.description.createdAt ?? null;
      if (!pinReason && !force && lastAt !== null && lastAt <= now && now - lastAt < MIN_INTERVAL_MS) {
        this.lastSnapshotAt = lastAt;
        this.scheduleSnapshot();
        return null;
      }

      // The first snapshot of a day decrypts every pooled attachment; the
      // others decrypt only the ones they add.
      const full = !newest || new Date(newest.description.createdAt).toDateString() !== new Date(now).toDateString();
      const referenced = this.openSnapshotBytes(bytes, epoch);
      await this.ensureSnapshotDirectories();
      for (const { entryId, attachment } of referenced) {
        await this.poolAttachment(entryId, attachment, { full, epoch });
      }
      check();
      const written = await this.writeSnapshotFiles(bytes, {
        attachments: referenced.map(({ attachment }) => attachment.id),
        verifiedAt: null,
        pinReason,
        newestAt: newest?.description.createdAt,
      });
      check();
      const readBack = await readFileWithLimit(this.snapshotFile(written.name, "vault"), MAX_FILE_BYTES);
      try {
        if (!readBack.equals(bytes)) throw new Error("snapshot damaged");
        this.openSnapshotBytes(readBack, epoch);
      } finally {
        readBack.fill(0);
      }
      await this.writeSnapshotDescription(written.name, { ...written.description, verifiedAt: this.snapshotNow() });
      this.lastSnapshotAt = written.description.createdAt;
      check();
      await this.rotateSnapshotsNow();
      return written.name;
    } finally {
      bytes.fill(0);
    }
  }

  // Verifies an unverified snapshot with the open vault's key. Returns false
  // when it was made under another key (it then stays unverified).
  /** @this {Store} */
  async verifySnapshotNow(snapshot, epoch) {
    const bytes = await readFileWithLimit(this.snapshotFile(snapshot.name, "vault"), MAX_FILE_BYTES);
    try {
      if (bytes.length !== snapshot.description.size || sha256Hex(bytes) !== snapshot.description.sha256) {
        throw new Error("snapshot damaged");
      }
      let referenced;
      try {
        referenced = this.openSnapshotBytes(bytes, epoch);
      } catch (error) {
        if (error?.otherKey) return false;
        throw error;
      }
      await this.ensureSnapshotDirectories();
      for (const { entryId, attachment } of referenced) {
        await this.poolAttachment(entryId, attachment, { full: true, epoch });
      }
      if (this.sessionEpoch !== epoch) throw new Error(INTERRUPTED);
      await this.writeSnapshotDescription(snapshot.name, {
        ...snapshot.description,
        attachments: [...new Set(referenced.map(({ attachment }) => attachment.id))].sort(),
        verifiedAt: this.snapshotNow(),
      });
      return true;
    } finally {
      bytes.fill(0);
    }
  }

  // After an unlock: checks unverified snapshots made under this key, then
  // takes a snapshot if the file changed since the newest one (pinned when
  // this version is about to upgrade the file's format).
  /** @this {Store} */
  async snapshotAfterUnlockNow() {
    const epoch = this.sessionEpoch;
    const { complete } = await this.listSnapshots();
    for (const snapshot of complete) {
      if (snapshot.description.verifiedAt !== null) continue;
      try {
        await this.verifySnapshotNow(snapshot, epoch);
      } catch (error) {
        if (error?.message === INTERRUPTED) throw error;
        // A damaged copy stays unverified and never counts.
      }
    }
    await this.takeSnapshotNow({ pinReason: this.formatOutdated ? "upgrade" : null, force: true });
  }

  // Removes snapshots the retention rules no longer keep, what interrupted
  // writes left behind, and pool files no snapshot refers to. Runs only
  // after a new snapshot was verified.
  /** @this {Store} */
  async rotateSnapshotsNow() {
    const now = this.snapshotNow();
    const { complete, incomplete } = await this.listSnapshots();
    for (const name of snapshotsToRemove(complete, now)) await this.removeSnapshotFiles(name);
    for (const group of incomplete) {
      // A copy without a description may still be getting one.
      const file = this.snapshotFile(group.name, group.hasData ? "vault" : "json");
      try {
        if (now - (await fs.stat(file)).mtimeMs < INCOMPLETE_GRACE_MS) continue;
      } catch {
        continue;
      }
      await this.removeSnapshotFiles(group.name);
    }
    await this.removeUnreferencedPoolFiles();
  }

  // The description goes first: a copy left without one is incomplete and
  // removed later; a description without its copy would be a lie.
  /** @this {Store} */
  async removeSnapshotFiles(name) {
    await fs.unlink(this.snapshotFile(name, "json")).catch(() => {});
    await fs.unlink(this.snapshotFile(name, "vault")).catch(() => {});
  }

  /** @this {Store} */
  async removeUnreferencedPoolFiles() {
    const { complete } = await this.listSnapshots();
    const referenced = new Set(complete.flatMap((snapshot) => snapshot.description.attachments));
    let names;
    try {
      names = await fs.readdir(this.snapshotPoolDirectory);
    } catch {
      return;
    }
    const now = this.snapshotNow();
    for (const fileName of names) {
      const match = fileName.match(/^(.+)\.bin$/);
      if (match && referenced.has(match[1])) continue;
      const filePath = path.join(this.snapshotPoolDirectory, fileName);
      try {
        if (now - (await fs.stat(filePath)).mtimeMs < INCOMPLETE_GRACE_MS) continue;
      } catch {
        continue;
      }
      await fs.unlink(filePath).catch(() => {});
    }
  }

  // How many snapshots were made under a different key than the open vault's
  // (before a change of passphrase or recovery key).
  /** @this {Store} */
  async snapshotsWithOtherKeys() {
    this.requireUnlocked();
    const current = keyMaterialOf(this.envelope);
    const { complete } = await this.listSnapshots();
    const other = [];
    for (const snapshot of complete) {
      try {
        const bytes = await readFileWithLimit(this.snapshotFile(snapshot.name, "vault"), MAX_FILE_BYTES);
        try {
          if (keyMaterialOf(readEnvelope(bytes).envelope) !== current) other.push(snapshot.name);
        } finally {
          bytes.fill(0);
        }
      } catch {
        // A damaged copy opens with nothing.
      }
    }
    return other;
  }

  // Deletes the snapshots that open with an earlier passphrase or recovery
  // key. The open vault's own snapshots stay.
  /** @this {Store} */
  async deleteSnapshotsWithOtherKeys() {
    return this.enqueueMutation(async () => {
      const names = await this.snapshotsWithOtherKeys();
      for (const name of names) await this.removeSnapshotFiles(name);
      await this.removeUnreferencedPoolFiles();
      return { deleted: names.length };
    });
  }

  // --- Scheduling --------------------------------------------------------------------

  // Runs `operation` in the mutation queue without waiting for it. Failures
  // are remembered for the status, never thrown: a save must not fail
  // because its snapshot did.
  /** @this {Store} */
  queueSnapshotWork(operation) {
    if (!this.snapshotOptions.enabled) return Promise.resolve();
    return this.enqueueMutation(() => this.runSnapshotWork(operation));
  }

  /** @this {Store} */
  async runSnapshotWork(operation) {
    if (!this.snapshotOptions.enabled) return;
    const epoch = this.sessionEpoch;
    try {
      // A skipped snapshot (none was due) says nothing about failures.
      if ((await operation()) && this.sessionEpoch === epoch) this.snapshotFailedAt = null;
    } catch (error) {
      if (error?.message === INTERRUPTED || this.sessionEpoch !== epoch) return;
      this.snapshotFailedAt = this.snapshotNow();
    }
  }

  // Called after every save of the open vault.
  /** @this {Store} */
  scheduleSnapshot() {
    if (!this.snapshotOptions.enabled || this.snapshotTimer || !this.isUnlocked()) return;
    const epoch = this.sessionEpoch;
    const now = this.snapshotNow();
    const lastAt = this.lastSnapshotAt;
    const delay = lastAt === null || lastAt > now ? 0 : Math.max(0, lastAt + MIN_INTERVAL_MS - now);
    const run = () => {
      this.snapshotTimer = null;
      if (this.sessionEpoch !== epoch || !this.isUnlocked()) return;
      void this.queueSnapshotWork(() => this.takeSnapshotNow());
    };
    if (delay === 0) {
      run();
      return;
    }
    this.snapshotTimer = setTimeout(run, delay);
    this.snapshotTimer.unref?.();
  }

  /** @this {Store} */
  cancelScheduledSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  // Before an operation that replaces much of the vault: a pinned snapshot of
  // the file as it is, verified when the vault is open and copied unverified
  // when it is not. Never throws.
  /** @this {Store} */
  async pinSnapshotBefore(pinReason) {
    await this.runSnapshotWork(() => (this.isUnlocked()
      ? this.takeSnapshotNow({ pinReason })
      : this.copyUnverifiedSnapshotNow({ pinReason })));
  }

  // The snapshot status for this vault: when the newest verified snapshot
  // was taken, and whether the last attempt failed.
  /** @this {Store} */
  async getSnapshotStatus() {
    const { complete } = await this.listSnapshots().catch(() => ({ complete: [] }));
    const verified = complete.filter((snapshot) => snapshot.description.verifiedAt !== null);
    return {
      count: complete.length,
      lastVerifiedAt: verified[0]?.description.createdAt ?? null,
      failedAt: this.snapshotFailedAt,
    };
  }

  // The unverified copy taken at launch for a vault whose last changes may
  // have no snapshot yet. Never throws.
  static async copySnapshotAtLaunch(vaultPath) {
    const store = /** @type {Store} */ (/** @type {unknown} */ (new VaultStore(vaultPath, { snapshots: true })));
    try {
      await store.copyUnverifiedSnapshotNow();
    } catch {
      // Tried again at the next launch, and checked at the next unlock.
    }
  }
}

module.exports = VaultStoreSnapshots;
