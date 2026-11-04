// What the atomic writers (temporary file, sync, rename) share.
//
// fileHandle.sync() already reaches the disk on macOS: libuv's fsync uses
// F_FULLFSYNC there, falling back to F_BARRIERFSYNC and fsync.
const fs = require("node:fs/promises");
const path = require("node:path");

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

module.exports = { describeWriteError, isDiskFullError, removeStaleTemporaryFiles, syncDirectory };
