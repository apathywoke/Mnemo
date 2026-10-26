const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const ProfileManager = require("../profile-manager");
const VaultStore = require("../vault-store");
const { makeLogin, makeTempDirectory } = require("../support/helpers");

const PASSPHRASE = "correct horse battery staple";

test("profiles create, list, restore, mark opened, and delete", async (t) => {
  const directory = await makeTempDirectory(t);
  const manager = new ProfileManager(directory);

  if (process.platform !== "win32") await fs.chmod(directory, 0o755);
  assert.deepEqual(await manager.listProfiles(), []);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(manager.vaultDirectory)).mode & 0o777, 0o700);
  }
  await assert.rejects(manager.getProfile("missing"), /not available/);
  assert.throws(() => manager.getVaultPath("../outside"), /valid vault profile/);

  await assert.rejects(manager.createProfile("   ", PASSPHRASE), /Vault names must/);
  await assert.rejects(manager.createProfile("Personal", "short"), /at least 7 characters/);

  const created = await manager.createProfile("  Personal  ", PASSPHRASE);
  assert.equal(created.profile.name, "Personal");
  assert.equal(created.profile.lastOpenedAt > 0, true);
  assert.equal(created.vaultStore.isUnlocked(), true);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(manager.vaultDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(manager.registryPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(manager.getVaultPath(created.profile.id))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await manager.listProfiles(), [created.profile]);
  assert.deepEqual(await manager.getProfile(created.profile.id), created.profile);

  await assert.rejects(
    manager.createProfile("personal", PASSPHRASE),
    /already exists/,
  );

  const backupPath = path.join(directory, "profile-backup.vault");
  await created.vaultStore.saveEntry(makeLogin({ name: "Backup round trip" }));
  await created.vaultStore.exportBackup(backupPath);
  const restored = await manager.restoreProfile("Imported", backupPath, PASSPHRASE);
  assert.equal(restored.profile.name, "Imported");
  assert.equal(restored.vaultStore.isUnlocked(), true);
  assert.deepEqual(restored.vaultStore.listEntries(), created.vaultStore.listEntries());
  assert.equal((await manager.listProfiles()).length, 2);

  const markedAt = await manager.markOpened(restored.profile.id);
  assert.equal(Number.isSafeInteger(markedAt), true);
  assert.equal((await manager.getProfile(restored.profile.id)).lastOpenedAt, markedAt);
  await assert.rejects(manager.markOpened("unknown"), /not available/);

  created.vaultStore.lock();
  restored.vaultStore.lock();
  assert.deepEqual(
    await manager.deleteProfile(created.profile.id),
    { deleted: true, profile: { id: created.profile.id, name: "Personal" } },
  );
  assert.equal(await fs.access(manager.getVaultPath(created.profile.id)).then(() => true, () => false), false);
  assert.equal((await manager.listProfiles()).length, 1);
  await manager.deleteProfile(restored.profile.id);
  assert.deepEqual(await manager.listProfiles(), []);
  await assert.rejects(manager.deleteProfile(restored.profile.id), /not available/);
});

test("legacy profile metadata and malformed registry handling", async (t) => {
  const directory = await makeTempDirectory(t);
  const manager = new ProfileManager(directory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(manager.legacyVaultPath, "legacy placeholder");

  assert.deepEqual(await manager.listProfiles(), [
    { id: "legacy", name: "Local Vault", lastOpenedAt: null },
  ]);
  const lastOpenedAt = await manager.markOpened("legacy");
  assert.equal((await manager.getProfile("legacy")).lastOpenedAt, lastOpenedAt);
  await manager.deleteProfile("legacy");
  assert.deepEqual(await manager.listProfiles(), []);

  await fs.writeFile(manager.registryPath, "not valid JSON");
  await assert.rejects(manager.listProfiles(), /profile list is invalid/);
});

test("profile restore refuses a backup with another passphrase", async (t) => {
  const directory = await makeTempDirectory(t);
  const source = new VaultStore(path.join(directory, "source.vault"));
  await source.create(PASSPHRASE);
  const backupPath = path.join(directory, "source-backup.vault");
  await source.exportBackup(backupPath);

  const manager = new ProfileManager(path.join(directory, "profiles"));
  await assert.rejects(
    manager.restoreProfile("Wrong key", backupPath, "wrong passphrase"),
    /Could not open the vault/,
  );
  assert.deepEqual(await manager.listProfiles(), []);

  const damagedPath = path.join(directory, "damaged.vault");
  await fs.writeFile(damagedPath, "not a valid encrypted vault");
  await assert.rejects(
    manager.restoreProfile("Damaged backup", damagedPath, PASSPHRASE),
    /Could not open the vault/,
  );
  assert.deepEqual(await manager.listProfiles(), []);
  assert.deepEqual(await fs.readdir(manager.vaultDirectory), []);
  source.lock();
});
