const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 4096;
const THEMES = Object.freeze(["system", "dark", "light"]);
const DEFAULT_THEME = "system";
const UPDATE_INTERVALS = Object.freeze(["30m", "1h", "6h", "1d", "off"]);
const DEFAULT_UPDATE_INTERVAL = "1d";

// Non-secret application preferences (interface language and theme), kept
// next to the profile registry in the per-user application data folder.
class SettingsStore {
  constructor(directory, { isSupportedLanguage, defaultLanguage }) {
    this.filePath = path.join(directory, "settings.json");
    this.isSupportedLanguage = isSupportedLanguage;
    // Update checks contact GitHub; daily by default because they deliver
    // security fixes, and adjustable or off in Settings.
    this.settings = { language: defaultLanguage, theme: DEFAULT_THEME, updateInterval: DEFAULT_UPDATE_INTERVAL };
    this.writeQueue = Promise.resolve();
  }

  async load() {
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
        };
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

  async write(settings) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        temporaryPath,
        JSON.stringify({ version: SETTINGS_VERSION, ...settings }),
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
