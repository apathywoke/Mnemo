// What the atomic writers (temporary file, sync, rename) share.
//
// fileHandle.sync() already reaches the disk on macOS: libuv's fsync uses
// F_FULLFSYNC there, falling back to F_BARRIERFSYNC and fsync.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const DISK_FULL_MESSAGE = "There is not enough free disk space. Free some space and try again.";

// `error` as the user should see it: a full disk has a clear remedy, and the
// old file is still in place.
function describeWriteError(error) {
  return error?.code === "ENOSPC" || error?.code === "EDQUOT" ? new Error(DISK_FULL_MESSAGE) : error;
}

const isDiskFullError = (error) => error?.message === DISK_FULL_MESSAGE;

// Makes a rename in `directory` survive a power cut. The rename has already
// happened, so a failure is not reported: some file systems (exFAT, network
// volumes) cannot sync a directory, and the new file is in place regardless.
async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // See above.
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Removes what a crash left behind while writing `destinationPath`
// (`<destination>.<pid>.<16 hex>.tmp`). Call it only when no write to this
// destination is running; failures are left for the next time.
async function removeStaleTemporaryFiles(destinationPath) {
  const directory = path.dirname(destinationPath);
  const prefix = `${path.basename(destinationPath)}.`;
  let names;
  try {
    names = await fs.readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+\.[0-9a-f]{16}\.tmp$/.test(name.slice(prefix.length))) continue;
    await fs.unlink(path.join(directory, name)).then(() => { removed += 1; }, () => {});
  }
  return removed;
}

// Removes temporary files (`<name>.<pid>.<16 hex>.tmp`) that another process
// left in `directory` when it was killed while writing. Files of this
// process may belong to a write that is still running and are kept; Mnemo
// runs one instance at a time, so another PID means a crashed run. Failures
// are left for the next time.
async function removeCrashedTemporaryFiles(directory) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = name.match(/\.(\d+)\.[0-9a-f]{16}\.tmp$/);
    if (!match || Number(match[1]) === process.pid) continue;
    await fs.unlink(path.join(directory, name)).then(() => { removed += 1; }, () => {});
  }
  return removed;
}

// Writes `contents` to `destinationPath` through a temporary file in the same
// folder (mode 0600), flushed before the rename and the folder after it. A
// crash leaves the old file or the new one; removeStaleTemporaryFiles cleans
// up the temporary file.
async function writeFileDurably(destinationPath, contents) {
  const directory = path.dirname(destinationPath);
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fileHandle = null;

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    fileHandle = await fs.open(temporaryPath, "wx", 0o600);
    await fileHandle.writeFile(contents);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await fs.rename(temporaryPath, destinationPath);
    await syncDirectory(directory);
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw describeWriteError(error);
  }
}

module.exports = {
  describeWriteError,
  isDiskFullError,
  removeCrashedTemporaryFiles,
  removeStaleTemporaryFiles,
  syncDirectory,
  writeFileDurably,
};
