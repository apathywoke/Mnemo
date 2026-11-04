// Where snapshots can be restored from: the vault's own snapshots on this
// Mac, their copies in the folder outside it, and, for a new vault on another
// Mac, a snapshot folder the user picks. The page gets IDs, times, and
// labels; paths stay in main.
const fs = require("node:fs/promises");
const path = require("node:path");
const { snapshotDirectoryFor, listSnapshotDirectory } = require("./vault/snapshots");
const { profileIdOf } = require("./outside-copies");

const SNAPSHOT_ID = /^(local|outside|folder):(?:(\d{1,3}):)?(\d{13}-[0-9a-f]{16})$/;
// Folders searched under a picked folder: itself, its subfolders, and the
// subfolders of a "Mnemo" folder in it (the layout outside-copies.js makes).
const MAX_PICKED_FOLDERS = 50;

function outsideDirectory(outsideFolder, vaultPath) {
  return outsideFolder ? path.join(outsideFolder, "Mnemo", profileIdOf(vaultPath)) : null;
}

function describe(location, snapshot, id) {
  return {
    id,
    location,
    createdAt: snapshot.description.createdAt,
    pinned: snapshot.description.pinned?.reason ?? null,
    verified: snapshot.description.verifiedAt !== null,
    attachments: snapshot.description.attachments.length,
  };
}

// The snapshots of one vault, newest first: the local ones, then copies
// outside this Mac that are not also here. A folder that cannot be read
// adds nothing.
async function listForVault(vaultPath, outsideFolder) {
  const local = await listSnapshotDirectory(snapshotDirectoryFor(vaultPath)).catch(() => ({ complete: [] }));
  const names = new Set(local.complete.map((item) => item.name));
  const items = local.complete.map((item) => describe("local", item, `local:${item.name}`));
  const outside = outsideDirectory(outsideFolder, vaultPath);
  if (outside) {
    const copies = await listSnapshotDirectory(outside).catch(() => ({ complete: [] }));
    for (const item of copies.complete) {
      if (!names.has(item.name)) items.push(describe("outside", item, `outside:${item.name}`));
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

// The folders under a picked folder that hold snapshots.
async function snapshotFoldersIn(picked) {
  const candidates = [picked];
  const subfolders = async (directory) => {
    try {
      return (await fs.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== "attachments")
        .map((entry) => path.join(directory, entry.name));
    } catch {
      return [];
    }
  };
  candidates.push(...await subfolders(picked));
  candidates.push(...await subfolders(path.join(picked, "Mnemo")));
  const found = [];
  for (const directory of candidates.slice(0, MAX_PICKED_FOLDERS)) {
    const { complete } = await listSnapshotDirectory(directory).catch(() => ({ complete: [] }));
    if (complete.length > 0) found.push({ directory, complete });
  }
  return found;
}

// The snapshots in the folders found under a picked folder. `group` tells
// vaults apart (one subfolder per vault); its label is the folder's name,
// which outside-copies.js makes the profile ID.
function listForFolders(found) {
  return found.flatMap(({ directory, complete }, index) =>
    complete.map((item) => ({
      ...describe("folder", item, `folder:${index}:${item.name}`),
      group: path.basename(directory),
    })));
}

// The files of one snapshot: { file, poolDirectory, localName }. Throws for
// an ID the page made up.
function resolveSnapshot(id, { vaultPath = null, outsideFolder = null, pickedFolders = [] } = {}) {
  const match = typeof id === "string" ? id.match(SNAPSHOT_ID) : null;
  if (!match) throw new Error("This snapshot is no longer available.");
  const [, location, index, name] = match;
  let directory = null;
  if (location === "local" && vaultPath && index === undefined) directory = snapshotDirectoryFor(vaultPath);
  if (location === "outside" && vaultPath && index === undefined) directory = outsideDirectory(outsideFolder, vaultPath);
  if (location === "folder" && index !== undefined) directory = pickedFolders[Number(index)] ?? null;
  if (!directory) throw new Error("This snapshot is no longer available.");
  return {
    file: path.join(directory, `${name}.vault`),
    poolDirectory: path.join(directory, "attachments"),
    localName: location === "local" ? name : null,
  };
}

module.exports = { listForVault, snapshotFoldersIn, listForFolders, resolveSnapshot };
