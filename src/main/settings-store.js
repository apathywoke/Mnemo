const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { removeStaleTemporaryFiles } = require("./durable-file");

const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 4096;
const THEMES = Object.freeze(["system", "dark", "light"]);
const DEFAULT_THEME = "system";
const UPDATE_INTERVALS = Object.freeze(["30m", "1h", "6h", "1d", "off"]);
const DEFAULT_UPDATE_INTERVAL = "1d";
// Vaults whose newest recovery key was not confirmed as saved; bounded so
// the file stays small.
const MAX_UNCONFIRMED_RECOVERY_KEYS = 32;
const PROFILE_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

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
      await this.write(this.settings, next);
      this.unconfirmedRecoveryKeys = next;
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  // Queued so that quick successive changes each build on the last one.
  update(patch) {
    const write = this.writeQueue.then(async () => {
      const next = { ...this.settings, ...patch };
      await this.write(next, this.unconfirmedRecoveryKeys);
      this.settings = next;
      return this.get();
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async write(settings, unconfirmedRecoveryKeys) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        temporaryPath,
        JSON.stringify({ version: SETTINGS_VERSION, ...settings, unconfirmedRecoveryKeys }),
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
