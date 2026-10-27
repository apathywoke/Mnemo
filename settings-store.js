const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 4096;

// Non-secret application preferences (currently only the UI language), kept
// next to the profile registry in the per-user application data folder.
class SettingsStore {
  constructor(directory, { isSupportedLanguage, defaultLanguage }) {
    this.filePath = path.join(directory, "settings.json");
    this.isSupportedLanguage = isSupportedLanguage;
    this.settings = { language: defaultLanguage };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const stats = await fs.stat(this.filePath);
      if (stats.size > MAX_SETTINGS_BYTES) return this.get();
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (
        parsed?.version === SETTINGS_VERSION &&
        this.isSupportedLanguage(parsed.language)
      ) {
        this.settings = { language: parsed.language };
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
    const next = { language };
    const write = this.writeQueue.then(() => this.write(next));
    this.writeQueue = write.catch(() => {});
    return write.then(() => {
      this.settings = next;
      return this.get();
    });
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
