const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const VaultStore = require("./vault/index");

const REGISTRY_VERSION = 2;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_PROFILES = 100;
const MAX_REGISTRY_PROFILES = MAX_PROFILES + 1;
const MAX_PROFILE_NAME_CHARACTERS = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_PROFILE_ID = "legacy";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function normalizeProfileName(value) {
  if (typeof value !== "string") throw new Error("Enter a name for this vault.");
  const name = value.trim();
  const length = Array.from(name).length;
  if (
    length < 1 ||
    length > MAX_PROFILE_NAME_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error(`Vault names must be 1–${MAX_PROFILE_NAME_CHARACTERS} characters long.`);
  }
  return name;
}

class ProfileManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.registryPath = path.join(userDataPath, "profiles.json");
    this.legacyVaultPath = path.join(userDataPath, "vault.json");
    this.vaultDirectory = path.join(userDataPath, "vaults");
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async pathExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async ensurePrivateDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  }

  async readRegistry() {
    let raw;
    try {
      await this.ensurePrivateDirectory(this.userDataPath);
      const stats = await fs.stat(this.registryPath);
      if (stats.size <= 0 || stats.size > MAX_REGISTRY_BYTES) {
        throw new Error("Invalid profile registry");
      }
      raw = await fs.readFile(this.registryPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Could not read the local vault profiles.");
    }

    try {
      const registry = JSON.parse(raw);
      const supportedVersion = isPlainObject(registry) &&
        (registry.version === 1 || registry.version === REGISTRY_VERSION);
      const validProfiles = isPlainObject(registry) &&
        Array.isArray(registry.profiles) &&
        registry.profiles.length <= MAX_REGISTRY_PROFILES &&
        registry.profiles.every((profile) => {
          if (!isPlainObject(profile)) return false;
          const validShape = registry.version === 1
            ? hasExactKeys(profile, ["id", "name"])
            : hasExactKeys(profile, ["id", "name", "lastOpenedAt"]);
          const validId = registry.version === 1
            ? UUID_PATTERN.test(profile.id)
            : profile.id === LEGACY_PROFILE_ID
              ? profile.name === "Local Vault"
              : UUID_PATTERN.test(profile.id);
          const validLastOpened = registry.version === 1 ||
            profile.lastOpenedAt === null ||
            (Number.isSafeInteger(profile.lastOpenedAt) && profile.lastOpenedAt >= 0);

          return (
            validShape &&
            validId &&
            typeof profile.name === "string" &&
            normalizeProfileName(profile.name) === profile.name &&
            validLastOpened
          );
        });

      if (
        !hasExactKeys(registry, ["version", "profiles"]) ||
        !supportedVersion ||
        !validProfiles ||
        new Set(registry.profiles.map((profile) => profile.id)).size !==
          registry.profiles.length
      ) {
        throw new Error("Invalid profile registry");
      }
      return registry.profiles.map((profile) => ({
        ...profile,
        lastOpenedAt: registry.version === 1 ? null : profile.lastOpenedAt,
      }));
    } catch {
      throw new Error("The local vault profile list is invalid.");
    }
  }

  async listProfiles() {
    const registeredProfiles = await this.readRegistry();
    await this.ensurePrivateDirectory(this.vaultDirectory);
    const profiles = [];

    if (await this.pathExists(this.legacyVaultPath)) {
      const legacyProfile = registeredProfiles.find(
        (profile) => profile.id === LEGACY_PROFILE_ID,
      );
      profiles.push({
        id: LEGACY_PROFILE_ID,
        name: "Local Vault",
        lastOpenedAt: legacyProfile?.lastOpenedAt ?? null,
      });
    }

    for (const profile of registeredProfiles) {
      if (
        profile.id !== LEGACY_PROFILE_ID &&
        await this.pathExists(this.getVaultPath(profile.id))
      ) {
        profiles.push({ ...profile });
      }
    }

    return profiles;
  }

  getVaultPath(profileId) {
    if (profileId === LEGACY_PROFILE_ID) return this.legacyVaultPath;
    if (typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) {
      throw new Error("Choose a valid vault profile.");
    }
    return path.join(this.vaultDirectory, `${profileId}.vault`);
  }

  async getProfile(profileId) {
    const profile = (await this.listProfiles()).find(
      (item) => item.id === profileId,
    );
    if (!profile) throw new Error("This vault profile is not available.");
    return profile;
  }

  async createProfile(name, passphrase) {
    return this.enqueueMutation(() =>
      this.createProfileWith(name, (store) => store.create(passphrase)),
    );
  }

  async restoreProfile(name, sourcePath, passphrase) {
    return this.enqueueMutation(() =>
      this.createProfileWith(name, (store) =>
        store.restoreBackup(sourcePath, passphrase),
      ),
    );
  }

  async markOpened(profileId) {
    return this.enqueueMutation(async () => {
      const profiles = await this.readRegistry();
      let profile = profiles.find((item) => item.id === profileId);

      if (profileId === LEGACY_PROFILE_ID) {
        if (!(await this.pathExists(this.legacyVaultPath))) {
          throw new Error("This vault profile is not available.");
        }
        if (!profile) {
          profile = {
            id: LEGACY_PROFILE_ID,
            name: "Local Vault",
            lastOpenedAt: null,
          };
          profiles.push(profile);
        }
      } else if (
        typeof profileId !== "string" ||
        !UUID_PATTERN.test(profileId) ||
        !(await this.pathExists(this.getVaultPath(profileId))) ||
        !profile
      ) {
        throw new Error("This vault profile is not available.");
      }

      profile.lastOpenedAt = Date.now();
      await this.writeRegistry(profiles);
      return profile.lastOpenedAt;
    });
  }

  async deleteProfile(profileId) {
    return this.enqueueMutation(async () => {
      const profile = (await this.listProfiles()).find(
        (item) => item.id === profileId,
      );
      if (!profile) throw new Error("This vault profile is not available.");

      const vaultPath = this.getVaultPath(profile.id);
      const stagedPath = `${vaultPath}.${process.pid}.${randomBytes(8).toString("hex")}.deleting`;
      // Attachments live in a folder next to the vault file and go with it.
      const attachmentPath = VaultStore.attachmentDirectoryFor(vaultPath);
      const stagedAttachmentPath = `${stagedPath}.attachments`;
      const profiles = await this.readRegistry();
      const remainingProfiles = profiles.filter((item) => item.id !== profile.id);
      let registryUpdated = false;
      let vaultStaged = false;
      let attachmentsStaged = false;

      try {
        await fs.rename(vaultPath, stagedPath);
        vaultStaged = true;
        try {
          await fs.rename(attachmentPath, stagedAttachmentPath);
          attachmentsStaged = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await this.writeRegistry(remainingProfiles);
        registryUpdated = true;
        await fs.unlink(stagedPath);
        vaultStaged = false;
        if (attachmentsStaged) {
          await fs.rm(stagedAttachmentPath, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        let rollbackFailed = false;
        if (registryUpdated) {
          try {
            await this.writeRegistry(profiles);
          } catch {
            rollbackFailed = true;
          }
        }
        if (vaultStaged) {
          try {
            await fs.rename(stagedPath, vaultPath);
          } catch {
            rollbackFailed = true;
          }
          if (attachmentsStaged) {
            try {
              await fs.rename(stagedAttachmentPath, attachmentPath);
            } catch {
              rollbackFailed = true;
            }
          }
        }
        if (rollbackFailed) {
          throw new Error("Could not complete the deletion or restore the vault. Check the local vault files before continuing.");
        }
        throw new Error("Could not delete this vault profile.");
      }

      return { deleted: true, profile: { id: profile.id, name: profile.name } };
    });
  }

  async createProfileWith(nameInput, initializeVault) {
    const name = normalizeProfileName(nameInput);
    const registeredProfiles = await this.readRegistry();
    const profiles = await this.listProfiles();
    const names = [
      ...registeredProfiles.map((profile) => profile.name),
      ...profiles.map((profile) => profile.name),
    ];

    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw new Error("A vault with this name already exists.");
    }
    if (
      registeredProfiles.filter((profile) => profile.id !== LEGACY_PROFILE_ID).length >=
      MAX_PROFILES
    ) {
      throw new Error("The maximum number of vault profiles has been reached.");
    }

    const profile = { id: randomUUID(), name, lastOpenedAt: Date.now() };
    const vaultPath = this.getVaultPath(profile.id);
    const store = new VaultStore(vaultPath);
    let ownsVaultPath = false;

    try {
      await this.ensurePrivateDirectory(this.vaultDirectory);
      if (await this.pathExists(vaultPath)) {
        throw new Error("Could not allocate a new vault profile.");
      }
      ownsVaultPath = true;
      await initializeVault(store);
      await this.writeRegistry([...registeredProfiles, profile]);
      return { profile, vaultStore: store };
    } catch (error) {
      store.lock();
      if (ownsVaultPath) {
        await fs.unlink(vaultPath).catch(() => {});
        await fs.rm(VaultStore.attachmentDirectoryFor(vaultPath), { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async writeRegistry(profiles) {
    if (profiles.length > MAX_REGISTRY_PROFILES) {
      throw new Error("The maximum number of vault profiles has been reached.");
    }
    const contents = Buffer.from(
      JSON.stringify({
        version: REGISTRY_VERSION,
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          lastOpenedAt: profile.lastOpenedAt ?? null,
        })),
      }),
      "utf8",
    );
    const temporaryPath = `${this.registryPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fileHandle = null;

    try {
      await this.ensurePrivateDirectory(this.userDataPath);
      fileHandle = await fs.open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(contents);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fs.rename(temporaryPath, this.registryPath);
    } catch {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw new Error("Could not save the local vault profile list.");
    } finally {
      contents.fill(0);
    }
  }
}

module.exports = ProfileManager;
