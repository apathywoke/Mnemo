// Kills a process running a vault operation at each of its file system
// changes in turn (support/crash-hook.js, support/crash-scenario.js), then
// checks what a power cut or a force quit at that moment would leave:
//
// - the vault opens, and holds the state before or after the operation;
// - every attachment it refers to is present and decrypts;
// - every complete snapshot matches its description, and every verified one
//   opens with a known key and has all its attachments in the pool;
// - copies outside this Mac match their descriptions;
// - the next launch (a launch copy, an unlock, a copy outside) succeeds and
//   leaves no temporary files of the killed run.
//
// `npm test` runs a sample (two operations, every fourth step).
// `npm run test:durability` runs every operation at every step.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const VaultStore = require("../vault-store");
const { listSnapshotDirectory, snapshotDirectoryFor, sha256Hex } = require("../src/main/vault/snapshots");
const { openAttachmentKey, decryptAttachment, attachmentsOf } = require("../src/main/vault/attachments");
const { PASSPHRASE, NEW_PASSPHRASE, paths } = require("../support/crash-scenario");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const FULL = process.env.MNEMO_DURABILITY === "full";
const HOOK = path.join(__dirname, "..", "support", "crash-hook.js");
const SCENARIO = path.join(__dirname, "..", "support", "crash-scenario.js");
const START = Date.UTC(2026, 10, 4, 9);
const DAY = 24 * 60 * 60 * 1000;
const PROFILE_ID = "6f1b0c1e-3a4d-4b5c-8d6e-7f8091a2b3c4";

// A vault with logins, attachments, snapshots over several days, a backup,
// and a file to attach. Copied for every run.
async function buildTemplate(t) {
  const directory = await makeTempDirectory(t, "mnemo-durability-");
  const files = paths(directory);
  await fs.mkdir(path.dirname(files.vault), { recursive: true });
  const clock = { now: START - 5 * DAY };
  const store = new VaultStore(files.vault, { snapshots: true, now: () => clock.now });
  await store.create(PASSPHRASE);
  const login = await store.saveEntry(makeLogin({ name: "First" }));
  for (const [index, text] of ["one attachment", "another attachment"].entries()) {
    const source = path.join(directory, `seed-${index}.txt`);
    await fs.writeFile(source, text);
    await store.addAttachment(login.id, source);
  }
  for (let day = 0; day < 4; day += 1) {
    clock.now += DAY;
    await store.saveEntry(makeLogin({ name: `Day ${day}` }));
    await store.enqueueMutation(async () => {});
    await store.enqueueMutation(() => store.takeSnapshotNow());
  }
  await store.exportBackup(files.backup);
  await fs.writeFile(files.newFile, "attached during the crash test");
  const oldKey = store.exportDataKey();
  store.lock();
  return { directory, oldKey };
}

function names(vaultData) {
  return vaultData.entries.filter((entry) => !entry.deletedAt).map((entry) => entry.name).sort().join("\n");
}

function run(directory, scenario, { crashAt = 0, countFile = "" } = {}) {
  const result = spawnSync(process.execPath, ["--require", HOOK, SCENARIO, JSON.stringify({ directory, scenario, start: START })], {
    env: { ...process.env, MNEMO_CRASH_AT: String(crashAt), MNEMO_CRASH_COUNT_FILE: countFile },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { signal: result.signal, status: result.status, stderr: result.stderr };
}

// Opens a vault or snapshot file with one of `keys`, then the passphrases.
async function open(filePath, keys) {
  const reader = new VaultStore(filePath);
  for (const dataKey of keys) {
    try {
      return await reader.decryptVaultFile(filePath, { dataKey });
    } catch {
      // Another key.
    }
  }
  for (const passphrase of [PASSPHRASE, NEW_PASSPHRASE]) {
    try {
      return await reader.decryptVaultFile(filePath, passphrase);
    } catch {
      // Another passphrase.
    }
  }
  throw new Error(`${path.basename(filePath)} opens with no known key or passphrase`);
}

async function attachmentsDecrypt(opened, directory, where) {
  for (const { entryId, attachment } of attachmentsOf(opened.vaultData)) {
    const bytes = await fs.readFile(path.join(directory, `${attachment.id}.bin`)).catch(() => null);
    assert.ok(bytes, `${where}: attachment ${attachment.id} is missing`);
    const fileKey = openAttachmentKey(attachment.key, opened.dataKey, entryId, attachment.id);
    decryptAttachment(bytes, fileKey, attachment.id, attachment.size).fill(0);
    fileKey.fill(0);
  }
}

async function checkSnapshots(directory, keys, where) {
  const { complete } = await listSnapshotDirectory(directory);
  for (const snapshot of complete) {
    const bytes = await fs.readFile(path.join(directory, `${snapshot.name}.vault`));
    assert.equal(sha256Hex(bytes), snapshot.description.sha256, `${where}: ${snapshot.name} does not match its description`);
    if (snapshot.description.verifiedAt === null) continue;
    const opened = await open(path.join(directory, `${snapshot.name}.vault`), keys);
    try {
      const ids = new Set(attachmentsOf(opened.vaultData).map(({ attachment }) => attachment.id));
      assert.deepEqual([...ids].sort(), [...snapshot.description.attachments].sort(), `${where}: ${snapshot.name} lists other attachments`);
      await attachmentsDecrypt(opened, path.join(directory, "attachments"), `${where} ${snapshot.name}`);
    } finally {
      opened.dataKey.fill(0);
    }
  }
}

// What the files must look like after a run, killed or not.
async function check(directory, { keys, states, where }) {
  const files = paths(directory);
  const opened = await open(files.vault, keys);
  try {
    if (states) assert.ok(states.includes(names(opened.vaultData)), `${where}: the vault holds neither the old nor the new state`);
    await attachmentsDecrypt(opened, VaultStore.attachmentDirectoryFor(files.vault), where);
    const allKeys = [...keys, opened.dataKey];
    await checkSnapshots(snapshotDirectoryFor(files.vault), allKeys, `${where} (local)`);
    await checkSnapshots(path.join(files.outside, "Mnemo", PROFILE_ID), allKeys, `${where} (outside)`);
  } finally {
    opened.dataKey.fill(0);
  }
}

async function temporaryFiles(directory) {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tmp")) found.push(path.relative(directory, full));
    }
  };
  await walk(directory);
  return found;
}

const SCENARIOS = [
  { name: "save", single: true, sample: true },
  { name: "passphrase", single: true },
  { name: "attachment" },
  { name: "import", single: true },
  { name: "restoreBackup", single: true },
  { name: "restoreSnapshot", single: true },
  { name: "rotation" },
  { name: "outside", outside: true, sample: true },
];

for (const scenario of SCENARIOS) {
  const skip = !FULL && !scenario.sample;
  test(`killed at every step: ${scenario.name}`, { skip, timeout: 30 * 60 * 1000 }, async (t) => {
    const template = await buildTemplate(t);
    const work = await makeTempDirectory(t, "mnemo-durability-run-");
    const fresh = async () => {
      const directory = path.join(work, `run-${Math.random().toString(16).slice(2)}`);
      await fs.cp(template.directory, directory, { recursive: true });
      if (scenario.outside) await fs.mkdir(path.join(directory, "outside"));
      return directory;
    };
    const keys = [template.oldKey];

    // A run without a crash counts the steps and gives the new state.
    const counted = await fresh();
    const before = names((await open(paths(counted).vault, keys)).vaultData);
    const countFile = path.join(work, "count");
    const clean = run(counted, scenario.name, { countFile });
    assert.equal(clean.status, 0, clean.stderr);
    const steps = Number(await fs.readFile(countFile, "utf8"));
    assert.ok(steps > 3, `${scenario.name}: only ${steps} steps`);
    const after = names((await open(paths(counted).vault, keys)).vaultData);
    const states = scenario.single ? [before, after] : null;
    await check(counted, { keys, states, where: `${scenario.name}, no crash` });

    const stride = FULL ? 1 : 4;
    for (let crashAt = 1; crashAt <= steps; crashAt += stride) {
      const directory = await fresh();
      const where = `${scenario.name}, killed at step ${crashAt} of ${steps}`;
      const killed = run(directory, scenario.name, { crashAt });
      assert.ok(killed.signal === "SIGKILL" || killed.status === 0, `${where}: ${killed.stderr}`);
      await check(directory, { keys, states, where });

      const recovered = run(directory, "recover");
      assert.equal(recovered.status, 0, `${where}, next launch: ${recovered.stderr}`);
      await check(directory, { keys, states, where: `${where}, next launch` });
      assert.deepEqual(await temporaryFiles(directory), [], `${where}: temporary files stay after the next launch`);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
