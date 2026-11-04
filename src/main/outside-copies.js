// Copies of local snapshots in a folder outside this Mac (iCloud Drive, a
// cloud storage folder, an external disk), chosen by the user.
//
// Layout: <folder>/Mnemo/<profile ID>/ holds the same files as
// <vault>.snapshots/ (snapshot copies, descriptions, attachments/). The
// subfolder is named by the profile ID only, so no vault name leaves the Mac.
//
// Only verified local snapshots are copied: the newest one, pinned ones, and
// the newest one of each recent day. Copying needs no key: every file is
// read back and must equal the local one byte for byte. New files are only
// added; an existing file is never rewritten in place. Old copies go by the
// same rules as local snapshots, and only after a new copy was verified.
// A file whose data is not on this Mac (an iCloud placeholder) is left alone
// and never counts as a verified copy.
//
// The status of each vault's copies is kept in <vault>.snapshots/outside.json.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { isDiskFullError, writeFileDurably, removeStaleTemporaryFiles } = require("./durable-file");
const {
  DAY_MS,
  KEEP_DAILY_MS,
  INCOMPLETE_GRACE_MS,
  snapshotDirectoryFor,
  groupSnapshotFiles,
  parseDescription,
  snapshotsToRemove,
  newestFirst,
  listSnapshotDirectory,
} = require("./vault/snapshots");
const { MAX_FILE_BYTES, MAX_ATTACHMENT_BYTES, UUID_PATTERN } = require("./vault/constants");
const { ATTACHMENT_OVERHEAD } = require("./vault/attachments");

// Ordinary snapshots go out at most once an hour; pinned ones at once.
const COPY_INTERVAL_MS = 60 * 60 * 1000;
// Without a verified copy outside for this long, the vault screen reminds.
const REMINDER_MS = 14 * DAY_MS;
const STATUS_VERSION = 1;
const MAX_STATUS_BYTES = 4096;
const MAX_DESCRIPTION_BYTES = 4 * 1024 * 1024;
const FAILURES = ["unavailable", "full", "placeholder", "mismatch", "other"];
// File systems that may not honor F_FULLFSYNC, or that live on a network.
const UNRELIABLE_FILE_SYSTEMS = new Set(["msdos", "exfat", "smbfs", "afpfs", "nfs", "webdav", "ftp", "cifs"]);

// The profile ID a vault file belongs to: <uuid>.vault, or "legacy" for the
// first vault (vault.json). Used as the subfolder name outside.
function profileIdOf(vaultPath) {
  const base = path.basename(vaultPath);
  const match = base.match(/^(.+)\.vault$/);
  if (match && UUID_PATTERN.test(match[1])) return match[1].toLowerCase();
  if (base === "vault.json") return "legacy";
  throw new Error("Choose a valid vault profile.");
}

// A file listed in the folder whose data is not on this Mac: macOS keeps a
// "dataless" placeholder that the next read would try to download.
function isPlaceholder(stats) {
  return stats.size > 0 && stats.blocks === 0;
}

function failureOf(error) {
  if (FAILURES.includes(error?.failure)) return error.failure;
  if (isDiskFullError(error) || error?.code === "ENOSPC" || error?.code === "EDQUOT") return "full";
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS", "ENXIO", "EIO", "ETIMEDOUT"].includes(error?.code)) return "unavailable";
  return "other";
}

const fail = (failure) => Object.assign(new Error(`outside copy ${failure}`), { failure });

// The file system of the volume that holds `folder`, from the system's list
// of mounted volumes (/sbin/mount), or null when it cannot be told.
function parseMountTable(output) {
  const mounts = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^.*? on (.+) \(([^,)]+)[,)]/);
    if (match) mounts.push({ point: match[1], type: match[2].trim().toLowerCase() });
  }
  return mounts;
}

function fileSystemOf(folder, mounts) {
  let best = null;
  for (const mount of mounts) {
    const prefix = mount.point.endsWith("/") ? mount.point : `${mount.point}/`;
    if ((folder === mount.point || folder.startsWith(prefix)) && (!best || mount.point.length > best.point.length)) {
      best = mount;
    }
  }
  return best?.type ?? null;
}

function readMountTable() {
  return new Promise((resolve) => {
    execFile("/sbin/mount", [], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parseMountTable(String(stdout)));
    });
  });
}

async function readLimited(filePath, limit) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > limit) throw fail("mismatch");
    if (isPlaceholder(stats)) throw fail("placeholder");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

class OutsideCopies {
  // `getFolder`: the chosen folder or null. `userDataPath`: Mnemo's data
  // folder, which a chosen folder must not be inside. `homePath`: to tell
  // cloud storage folders (synced elsewhere) from plain folders on this disk.
  constructor({ getFolder, userDataPath, homePath, now = Date.now, readMounts = readMountTable }) {
    this.getFolder = getFolder;
    this.userDataPath = userDataPath;
    this.homePath = homePath;
    this.now = now;
    this.readMounts = readMounts;
    /** @type {Map<string, Promise<unknown>>} */
    this.queues = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.timers = new Map();
  }

  // --- The folder ---------------------------------------------------------------------

  // Why `folder` cannot be used, or null. Inside Mnemo's own data it would
  // copy the vault next to itself.
  async folderProblem(folder) {
    try {
      const resolved = await fs.realpath(folder);
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) return "unavailable";
      const data = await fs.realpath(this.userDataPath).catch(() => path.resolve(this.userDataPath));
      if (resolved === data || resolved.startsWith(`${data}${path.sep}`) || data.startsWith(`${resolved}${path.sep}`)) {
        return "inside-data";
      }
      return null;
    } catch {
      return "unavailable";
    }
  }

  // A warning about where the folder is: "same-disk" when it is a plain
  // folder on the disk that holds Mnemo's data (it does not survive losing
  // the Mac), "unreliable-disk" when its file system may not flush writes
  // (exFAT, FAT, network volumes). Null otherwise or when unknown.
  async folderWarning(folder) {
    try {
      const resolved = await fs.realpath(folder);
      const type = fileSystemOf(resolved, await this.readMounts());
      if (type && UNRELIABLE_FILE_SYSTEMS.has(type)) return "unreliable-disk";
      const home = await fs.realpath(this.homePath).catch(() => path.resolve(this.homePath));
      const cloudRoots = ["Library/Mobile Documents", "Library/CloudStorage"].map((part) => path.join(home, part));
      const inCloud = cloudRoots.some((root) => resolved.startsWith(`${root}${path.sep}`));
      const [folderStats, dataStats] = await Promise.all([fs.stat(resolved), fs.stat(this.userDataPath)]);
      if (!inCloud && folderStats.dev === dataStats.dev) return "same-disk";
      return null;
    } catch {
      return null;
    }
  }

  // <folder>/Mnemo/<profile ID>, created as real folders (never followed
  // through a symbolic link Mnemo did not make).
  async targetDirectory(folder, vaultPath) {
    const root = path.join(folder, "Mnemo");
    const target = path.join(root, profileIdOf(vaultPath));
    for (const directory of [root, target, path.join(target, "attachments")]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(directory)).isDirectory()) throw fail("other");
    }
    return target;
  }

  // --- Status -------------------------------------------------------------------------

  statusPath(vaultPath) {
    return path.join(snapshotDirectoryFor(vaultPath), "outside.json");
  }

  async readStatus(vaultPath) {
    const empty = { since: null, verifiedAt: null, failedAt: null, failure: null, lastRunAt: null, offerDismissedAt: null };
    try {
      const value = JSON.parse((await readLimited(this.statusPath(vaultPath), MAX_STATUS_BYTES)).toString("utf8"));
      if (value?.version !== STATUS_VERSION) return empty;
      const time = (field) => (Number.isSafeInteger(value[field]) && value[field] > 0 ? value[field] : null);
      return {
        since: time("since"),
        verifiedAt: time("verifiedAt"),
        failedAt: time("failedAt"),
        failure: FAILURES.includes(value.failure) ? value.failure : null,
        lastRunAt: time("lastRunAt"),
        offerDismissedAt: time("offerDismissedAt"),
      };
    } catch {
      return empty;
    }
  }

  async writeStatus(vaultPath, patch) {
    const status = { ...(await this.readStatus(vaultPath)), ...patch };
    if (status.since === null) status.since = this.now();
    await fs.mkdir(snapshotDirectoryFor(vaultPath), { recursive: true, mode: 0o700 });
    await writeFileDurably(this.statusPath(vaultPath), Buffer.from(JSON.stringify({ version: STATUS_VERSION, ...status }), "utf8"));
    return status;
  }

  // What Settings and the vault screen show for one vault. `folderName` is
  // the last part of the path only.
  async getStatus(vaultPath) {
    const folder = this.getFolder();
    let status = await this.readStatus(vaultPath);
    // The reminder counts from when this vault was first seen here.
    if (status.since === null) status = await this.writeStatus(vaultPath, {}).catch(() => ({ ...status, since: this.now() }));
    const now = this.now();
    const lastGood = status.verifiedAt ?? status.since;
    const reminderDue = now - lastGood >= REMINDER_MS;
    return {
      folderName: folder ? path.basename(folder) : null,
      warning: folder ? await this.folderWarning(folder) : null,
      verifiedAt: status.verifiedAt,
      failedAt: status.failedAt,
      failure: status.failure,
      reminderDue,
      offer: folder === null && status.offerDismissedAt === null && !reminderDue,
    };
  }

  async dismissOffer(vaultPath) {
    await this.writeStatus(vaultPath, { offerDismissedAt: this.now() });
  }

  // --- Copying ------------------------------------------------------------------------

  // Runs `operation` after any earlier one for the same vault.
  enqueue(vaultPath, operation) {
    const previous = this.queues.get(vaultPath) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.catch(() => {});
    this.queues.set(vaultPath, settled);
    void settled.then(() => {
      if (this.queues.get(vaultPath) === settled) this.queues.delete(vaultPath);
    });
    return result;
  }

  // Called after a local snapshot of `vaultPath` was verified. A pinned one
  // goes out now; otherwise at most once per COPY_INTERVAL_MS.
  noteSnapshot(vaultPath, { pinned = false } = {}) {
    if (!this.getFolder()) return;
    void this.enqueue(vaultPath, async () => {
      const { lastRunAt } = await this.readStatus(vaultPath);
      const now = this.now();
      const wait = lastRunAt === null || lastRunAt > now ? 0 : lastRunAt + COPY_INTERVAL_MS - now;
      if (pinned || wait <= 0) {
        await this.copyNow(vaultPath).catch(() => {});
        return;
      }
      if (this.timers.has(vaultPath)) return;
      const timer = setTimeout(() => {
        this.timers.delete(vaultPath);
        void this.enqueue(vaultPath, () => this.copyNow(vaultPath).catch(() => {}));
      }, wait);
      timer.unref?.();
      this.timers.set(vaultPath, timer);
    });
  }

  // Copies what is missing outside for one vault, now. Records and returns
  // the outcome; throws nothing for folder or file problems.
  copy(vaultPath) {
    return this.enqueue(vaultPath, () => this.copyNow(vaultPath));
  }

  async copyNow(vaultPath) {
    const folder = this.getFolder();
    if (!folder) return this.readStatus(vaultPath);
    const now = this.now();
    try {
      const problem = await this.folderProblem(folder);
      if (problem) throw fail(problem === "inside-data" ? "other" : "unavailable");
      const target = await this.targetDirectory(folder, vaultPath);
      await removeStaleTemporaryFiles(path.join(target, "x"));
      // Nothing verified here yet: nothing to copy, and nothing failed.
      if (!(await this.copySnapshots(vaultPath, target, now))) return await this.writeStatus(vaultPath, { lastRunAt: now });
      return await this.writeStatus(vaultPath, { verifiedAt: now, failedAt: null, failure: null, lastRunAt: now });
    } catch (error) {
      return this.writeStatus(vaultPath, { failedAt: now, failure: failureOf(error), lastRunAt: now }).catch(() => null);
    }
  }

  // The local snapshots that belong outside: verified, and the newest one,
  // a pinned one, or the newest one of a recent day.
  async snapshotsToCopy(vaultPath, now) {
    const { complete } = await listSnapshotDirectory(snapshotDirectoryFor(vaultPath));
    const verified = complete.filter((item) => item.description.verifiedAt !== null).sort(newestFirst);
    const days = new Set();
    return verified.filter((item, index) => {
      const { createdAt, pinned } = item.description;
      const day = new Date(Math.min(createdAt, now)).toDateString();
      const newestOfDay = now - createdAt <= KEEP_DAILY_MS && !days.has(day);
      if (newestOfDay) days.add(day);
      return index === 0 || (pinned !== null && pinned.until > now) || newestOfDay;
    });
  }

  // What is in the folder outside: readable descriptions, and the names of
  // every file present (placeholders included, so they are never written
  // over).
  async listOutside(target) {
    const names = await fs.readdir(target);
    const present = new Set(names);
    // Older iCloud versions show an evicted file as ".<name>.icloud".
    for (const name of names) {
      const match = name.match(/^\.(.+)\.icloud$/);
      if (match) present.add(match[1]);
    }
    const complete = [];
    for (const group of groupSnapshotFiles([...present])) {
      if (!group.hasData || !group.hasDescription) continue;
      try {
        const description = parseDescription(await readLimited(path.join(target, `${group.name}.json`), MAX_DESCRIPTION_BYTES));
        if (description) complete.push({ name: group.name, description });
      } catch {
        // A placeholder or an unreadable description: kept, never counted.
      }
    }
    return { present, complete: complete.sort(newestFirst) };
  }

  // Writes `bytes` to a new file outside and reads it back.
  async writeVerified(filePath, bytes, limit) {
    await writeFileDurably(filePath, bytes);
    const readBack = await readLimited(filePath, limit);
    if (!readBack.equals(bytes)) throw fail("mismatch");
  }

  async copySnapshots(vaultPath, target, now) {
    const localDirectory = snapshotDirectoryFor(vaultPath);
    const pool = path.join(target, "attachments");
    let outside = await this.listOutside(target);
    const poolPresent = new Set(await fs.readdir(pool));
    for (const name of [...poolPresent]) {
      const match = name.match(/^\.(.+)\.icloud$/);
      if (match) poolPresent.add(match[1]);
    }

    const wanted = (await this.snapshotsToCopy(vaultPath, now)).reverse();
    let copied = 0;
    for (const snapshot of wanted) {
      if (outside.present.has(`${snapshot.name}.json`)) continue;
      // Attachments first, then the copy, then its description: a
      // description outside always has its files.
      for (const id of snapshot.description.attachments) {
        const fileName = `${id}.bin`;
        if (poolPresent.has(fileName)) continue;
        const bytes = await readLimited(path.join(localDirectory, "attachments", fileName), MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
        await this.writeVerified(path.join(pool, fileName), bytes, MAX_ATTACHMENT_BYTES + ATTACHMENT_OVERHEAD);
        poolPresent.add(fileName);
      }
      const data = await readLimited(path.join(localDirectory, `${snapshot.name}.vault`), MAX_FILE_BYTES);
      if (data.length !== snapshot.description.size) throw fail("mismatch");
      if (!outside.present.has(`${snapshot.name}.vault`)) {
        await this.writeVerified(path.join(target, `${snapshot.name}.vault`), data, MAX_FILE_BYTES);
      } else {
        const existing = await readLimited(path.join(target, `${snapshot.name}.vault`), MAX_FILE_BYTES);
        if (!existing.equals(data)) throw fail("mismatch");
      }
      const description = { ...snapshot.description, verifiedAt: this.now() };
      await this.writeVerified(path.join(target, `${snapshot.name}.json`), Buffer.from(JSON.stringify(description), "utf8"), MAX_DESCRIPTION_BYTES);
      copied += 1;
    }
    if (wanted.length === 0) return false;
    // The newest snapshot must now be outside, readable, and equal to the
    // local one; only then does the copy count as verified.
    const newest = wanted[wanted.length - 1];
    outside = await this.listOutside(target);
    if (!outside.complete.some((item) => item.name === newest.name)) {
      throw fail(outside.present.has(`${newest.name}.json`) ? "placeholder" : "mismatch");
    }
    const [local, remote] = await Promise.all([
      readLimited(path.join(localDirectory, `${newest.name}.vault`), MAX_FILE_BYTES),
      readLimited(path.join(target, `${newest.name}.vault`), MAX_FILE_BYTES),
    ]);
    if (!local.equals(remote)) throw fail("mismatch");
    if (copied > 0) await this.rotate(target, outside, now);
    return true;
  }

  // Removes what the retention rules no longer keep outside, and pool files
  // no readable description refers to. Placeholders are left alone, and so
  // are pool files while any description cannot be read.
  async rotate(target, outside, now) {
    for (const name of snapshotsToRemove(outside.complete, now)) {
      await fs.unlink(path.join(target, `${name}.json`)).catch(() => {});
      await fs.unlink(path.join(target, `${name}.vault`)).catch(() => {});
    }
    const after = await this.listOutside(target);
    const unreadable = groupSnapshotFiles([...after.present]).some((group) =>
      group.hasDescription && !after.complete.some((item) => item.name === group.name));
    if (unreadable) return;
    const referenced = new Set(after.complete.flatMap((item) => item.description.attachments));
    const pool = path.join(target, "attachments");
    for (const fileName of await fs.readdir(pool)) {
      const match = fileName.match(/^(.+)\.bin$/);
      if (!match || referenced.has(match[1])) continue;
      const filePath = path.join(pool, fileName);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs < INCOMPLETE_GRACE_MS) continue;
      } catch {
        continue;
      }
      await fs.unlink(filePath).catch(() => {});
    }
  }

  // Deletes the copies outside whose file opens with other secrets than
  // `keyMaterialOf` says the open vault has (after a change of passphrase or
  // recovery key, when the user asks). Returns how many it deleted and how
  // many it could not check (placeholders).
  async deleteWithOtherKeys(vaultPath, isOtherKey) {
    const folder = this.getFolder();
    if (!folder) return { deleted: 0, unchecked: 0 };
    return this.enqueue(vaultPath, async () => {
      let deleted = 0;
      let unchecked = 0;
      let target;
      try {
        target = path.join(folder, "Mnemo", profileIdOf(vaultPath));
        const outside = await this.listOutside(target);
        for (const group of groupSnapshotFiles([...outside.present])) {
          if (!group.hasData) continue;
          let other;
          try {
            other = isOtherKey(await readLimited(path.join(target, `${group.name}.vault`), MAX_FILE_BYTES));
          } catch {
            unchecked += 1;
            continue;
          }
          if (!other) continue;
          await fs.unlink(path.join(target, `${group.name}.json`)).catch(() => {});
          await fs.unlink(path.join(target, `${group.name}.vault`)).catch(() => {});
          deleted += 1;
        }
      } catch {
        // The folder is not there: nothing to delete now.
      }
      return { deleted, unchecked };
    });
  }

  // Runs at launch for every vault: copies what is due.
  async copyAtLaunch(vaultPaths) {
    if (!this.getFolder()) return;
    for (const vaultPath of vaultPaths) this.noteSnapshot(vaultPath);
  }

  cancelTimers() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

module.exports = {
  OutsideCopies,
  COPY_INTERVAL_MS,
  REMINDER_MS,
  profileIdOf,
  parseMountTable,
  fileSystemOf,
  isPlaceholder,
};
