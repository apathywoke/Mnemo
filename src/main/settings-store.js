const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { removeStaleTemporaryFiles } = require("./durable-file");

const SETTINGS_VERSION = 1;
// Room for a folder path (up to 1024 bytes as JSON can escape it).
const MAX_SETTINGS_BYTES = 16 * 1024;
const MAX_FOLDER_PATH_LENGTH = 1024;
const THEMES = Object.freeze(["system", "dark", "light"]);
const DEFAULT_THEME = "system";
const UPDATE_INTERVALS = Object.freeze(["30m", "1h", "6h", "1d", "off"]);
const DEFAULT_UPDATE_INTERVAL = "1d";
// Vaults whose newest recovery key was not confirmed as saved; bounded so
// the file stays small.
const MAX_UNCONFIRMED_RECOVERY_KEYS = 32;
const PROFILE_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

function isFolderPath(value) {
  return typeof value === "string" &&
    value.length > 1 &&
    value.length <= MAX_FOLDER_PATH_LENGTH &&
    path.isAbsolute(value) &&
    // eslint-disable-next-line no-control-regex -- rejects control characters in paths
    !/[\u0000-\u001f]/.test(value);
}

// Non-secret application preferences (interface language and theme), kept
// next to the profile registry in the per-user application data folder.
class SettingsStore {
  constructor(directory, { isSupportedLanguage, defaultLanguage }) {
    this.filePath = path.join(directory, "settings.json");
    this.isSupportedLanguage = isSupportedLanguage;
    // Update checks contact GitHub; daily by default because they deliver
    // security fixes, and adjustable or off in Settings.
    // `backupReminder`: whether the vault screen shows the reminder that
    // backups open with the credentials valid when they were made. It is
    // turned off when the user closes it and back on with each new recovery
    // key.
    this.settings = {
      language: defaultLanguage,
      theme: DEFAULT_THEME,
      updateInterval: DEFAULT_UPDATE_INTERVAL,
      backupReminder: true,
    };
    // Kept in the same file, but not part of get(): the page does not need
    // the list of profile IDs.
    /** @type {string[]} */
    this.unconfirmedRecoveryKeys = [];
    // The folder outside this Mac that gets copies of the snapshots
    // (outside-copies.js), or null. Not part of get(): the page sees only
    // its name, through the copy status.
    /** @type {string | null} */
    this.outsideFolder = null;
    /** @type {Promise<unknown>} */
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await removeStaleTemporaryFiles(this.filePath);
    try {
      const stats = await fs.stat(this.filePath);
      if (stats.size > MAX_SETTINGS_BYTES) return this.get();
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.version === SETTINGS_VERSION) {
        // Each value falls back on its own, so a bad theme keeps the language.
        this.settings = {
          language: this.isSupportedLanguage(parsed.language)
            ? parsed.language
            : this.settings.language,
          theme: THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_THEME,
          updateInterval: UPDATE_INTERVALS.includes(parsed.updateInterval)
            ? parsed.updateInterval
            : parsed.autoUpdate === false ? "off" : DEFAULT_UPDATE_INTERVAL,
          backupReminder: parsed.backupReminder !== false,
        };
        if (isFolderPath(parsed.outsideFolder)) this.outsideFolder = parsed.outsideFolder;
        if (Array.isArray(parsed.unconfirmedRecoveryKeys)) {
          this.unconfirmedRecoveryKeys = parsed.unconfirmedRecoveryKeys
            .filter((id) => typeof id === "string" && PROFILE_ID_PATTERN.test(id))
            .slice(-MAX_UNCONFIRMED_RECOVERY_KEYS);
        }
      }
    } catch {
      // Missing or unreadable settings fall back to the defaults.
    }
    return this.get();
  }

  get() {
    return { ...this.settings };
  }

  setLanguage(language) {
    if (!this.isSupportedLanguage(language)) {
      return Promise.reject(new Error("Could not save the settings."));
    }
    return this.update({ language });
  }

  setTheme(theme) {
    if (!THEMES.includes(theme)) {
      return Promise.reject(new Error("Could not save the settings."));
    }
    return this.update({ theme });
  }

  setUpdateInterval(interval) {
    if (!UPDATE_INTERVALS.includes(interval)) {
      return Promise.reject(new Error("Could not save the settings."));
    }
    return this.update({ updateInterval: interval });
  }

  setBackupReminder(shown) {
    if (typeof shown !== "boolean") {
      return Promise.reject(new Error("Could not save the settings."));
    }
    return this.update({ backupReminder: shown });
  }

  isRecoveryKeyConfirmed(profileId) {
    return !this.unconfirmedRecoveryKeys.includes(profileId);
  }

  setRecoveryKeyConfirmed(profileId, confirmed) {
    if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
      return Promise.reject(new Error("Could not save the settings."));
    }
    const write = this.writeQueue.then(async () => {
      const others = this.unconfirmedRecoveryKeys.filter((id) => id !== profileId);
      const next = confirmed ? others : [...others, profileId].slice(-MAX_UNCONFIRMED_RECOVERY_KEYS);
      await this.write(this.settings, { unconfirmedRecoveryKeys: next });
      this.unconfirmedRecoveryKeys = next;
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  getOutsideFolder() {
    return this.outsideFolder;
  }

  // An absolute folder path, or null to stop copying.
  setOutsideFolder(folder) {
    if (folder !== null && !isFolderPath(folder)) {
      return Promise.reject(new Error("Could not save the settings."));
    }
    const write = this.writeQueue.then(async () => {
      await this.write(this.settings, { outsideFolder: folder });
      this.outsideFolder = folder;
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  // Queued so that quick successive changes each build on the last one.
  update(patch) {
    const write = this.writeQueue.then(async () => {
      const next = { ...this.settings, ...patch };
      await this.write(next);
      this.settings = next;
      return this.get();
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  // `changes`: the values kept outside get() that this write changes.
  async write(settings, changes = {}) {
    const { unconfirmedRecoveryKeys = this.unconfirmedRecoveryKeys, outsideFolder = this.outsideFolder } = changes;
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        temporaryPath,
        JSON.stringify({ version: SETTINGS_VERSION, ...settings, unconfirmedRecoveryKeys, outsideFolder }),
        { mode: 0o600, flag: "wx" },
      );
      await fs.rename(temporaryPath, this.filePath);
    } catch {
      await fs.unlink(temporaryPath).catch(() => {});
      throw new Error("Could not save the settings.");
    }
  }
}

module.exports = SettingsStore;
module.exports.THEMES = THEMES;
module.exports.UPDATE_INTERVALS = UPDATE_INTERVALS;
