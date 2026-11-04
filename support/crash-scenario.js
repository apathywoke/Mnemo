// One operation on a prepared vault, run in its own process by
// test/durability.test.js, which kills it (support/crash-hook.js) at each
// file system change in turn. Usage: node crash-scenario.js '<json>' where
// the JSON is { directory, scenario }. The clock moves on by `step` on every
// read, so snapshots are always due and no timer is needed.
const fs = require("node:fs/promises");
const path = require("node:path");
const VaultStore = require("../vault-store");
const { OutsideCopies } = require("../src/main/outside-copies");
const { listSnapshotDirectory, snapshotDirectoryFor } = require("../src/main/vault/snapshots");

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "мой длинный пароль для сейфа";
const MINUTE = 60 * 1000;

function paths(directory) {
  return {
    vault: path.join(directory, "data", "vaults", "6f1b0c1e-3a4d-4b5c-8d6e-7f8091a2b3c4.vault"),
    backup: path.join(directory, "backup.vault"),
    newFile: path.join(directory, "new-attachment.txt"),
    outside: path.join(directory, "outside"),
    data: path.join(directory, "data"),
  };
}

function makeClock(start, step) {
  let now = start;
  return () => {
    now += step;
    return now;
  };
}

async function openStore(vaultPath, clock, passphrases = [PASSPHRASE]) {
  const store = new VaultStore(vaultPath, { snapshots: true, now: clock });
  let lastError = null;
  for (const passphrase of passphrases) {
    try {
      await store.unlock(passphrase);
      await store.enqueueMutation(async () => {});
      return store;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const settle = (store) => store.enqueueMutation(async () => {});

const SCENARIOS = {
  async save({ vault }, clock) {
    const store = await openStore(vault, clock);
    await store.saveEntry({ id: "", name: "Saved in the crash test", username: "u", password: "p", url: "", notes: "" });
    await settle(store);
  },

  async attachment({ vault, newFile }, clock) {
    const store = await openStore(vault, clock);
    const entry = store.vaultData.entries.find((item) => (item.attachments ?? []).length > 0);
    await store.addAttachment(entry.id, newFile);
    await store.deleteAttachment(entry.id, entry.attachments[0].id);
    await settle(store);
  },

  async passphrase({ vault }, clock) {
    const store = await openStore(vault, clock);
    await store.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
    await settle(store);
    await store.deleteSnapshotsWithOtherKeys();
  },

  async import({ vault }, clock) {
    const store = await openStore(vault, clock);
    await store.importLogins([1, 2, 3].map((n) => ({
      name: `Imported ${n}`, username: `user${n}`, password: `password ${n}`, url: "", notes: "",
    })));
    await settle(store);
  },

  async restoreBackup({ vault, backup }, clock) {
    const store = await openStore(vault, clock);
    await store.restoreBackup(backup, PASSPHRASE);
    await settle(store);
  },

  async restoreSnapshot({ vault }, clock) {
    const store = await openStore(vault, clock);
    const directory = snapshotDirectoryFor(vault);
    const { complete } = await listSnapshotDirectory(directory);
    const oldest = complete[complete.length - 1];
    await store.keepSnapshotForRestore(oldest.name);
    await store.restoreBackup(path.join(directory, `${oldest.name}.vault`), PASSPHRASE, {
      poolDirectory: path.join(directory, "attachments"),
    });
    await settle(store);
  },

  // Many saves a few hours apart: snapshots are taken and rotated away.
  async rotation({ vault }, clock) {
    const store = await openStore(vault, clock);
    for (let index = 0; index < 8; index += 1) {
      await store.saveEntry({ id: "", name: `Day ${index}`, username: "", password: "x", url: "", notes: "" });
      await settle(store);
    }
  },

  async outside({ vault, outside, data, directory }, clock) {
    const copies = new OutsideCopies({
      getFolder: () => outside,
      userDataPath: data,
      homePath: directory,
      now: clock,
      readMounts: async () => [],
    });
    const status = await copies.copy(vault);
    if (status?.failure) throw new Error(`copy failed: ${status.failure}`);
  },

  // The next launch after a crash: the launch copy, then an unlock with
  // whichever passphrase opens the vault, and whatever is due outside.
  async recover({ vault, outside, data, directory }, clock) {
    await VaultStore.copySnapshotAtLaunch(vault);
    const store = await openStore(vault, clock, [PASSPHRASE, NEW_PASSPHRASE]);
    await settle(store);
    if (await fs.stat(outside).then(() => true, () => false)) {
      const copies = new OutsideCopies({ getFolder: () => outside, userDataPath: data, homePath: directory, now: clock, readMounts: async () => [] });
      await copies.copy(vault);
    }
  },
};

async function main() {
  const { directory, scenario, start } = JSON.parse(process.argv[2]);
  const step = scenario === "rotation" ? 6 * 60 * MINUTE : 11 * MINUTE;
  await SCENARIOS[scenario](paths(directory), makeClock(start, step));
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}

module.exports = { PASSPHRASE, NEW_PASSPHRASE, paths };
