// Translation helpers shared by the renderer (plain script) and the main
// process (require). They depend only on the catalog in messages.js.
(() => {
  function createTranslator(catalog) {
    const { defaultLanguage, languages, messages } = catalog;
    const supported = new Set(languages.map(({ code }) => code));

    function isSupported(code) {
      return typeof code === "string" && supported.has(code);
    }

    function format(template, params = {}) {
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match);
    }

    function t(language, key, params) {
      const table = messages[isSupported(language) ? language : defaultLanguage];
      const template = table[key] ?? messages[defaultLanguage][key] ?? key;
      return format(template, params);
    }

    // Picks the first supported language from a list of BCP 47 tags, such as
    // app.getPreferredSystemLanguages() or navigator.languages.
    function pickLanguage(tags) {
      for (const tag of tags ?? []) {
        const base = String(tag).toLowerCase().split(/[-_]/)[0];
        if (isSupported(base)) return base;
      }
      return defaultLanguage;
    }

    // English error templates become anchored patterns, so a message thrown in
    // English by the main process can be translated with its parameters.
    const errorPatterns = Object.entries(messages[defaultLanguage])
      .filter(([key]) => key.startsWith("errors."))
      .map(([key, template]) => {
        const names = [];
        const source = template
          .split(/(\{\w+\})/)
          .map((part) => {
            const name = part.match(/^\{(\w+)\}$/)?.[1];
            if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            names.push(name);
            return "(.*?)";
          })
          .join("");
        return { key, names, pattern: new RegExp(`^${source}$`, "s") };
      });

    function matchError(message) {
      if (typeof message !== "string") return null;
      for (const { key, names, pattern } of errorPatterns) {
        const match = message.match(pattern);
        if (match) {
          return { key, params: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])) };
        }
      }
      return null;
    }

    return { languages, defaultLanguage, isSupported, t, pickLanguage, matchError };
  }

  // Errors cross IPC as "[mnemo:<key>] <translated text>". Electron prefixes
  // rejected invoke() messages with "Error invoking remote method …".
  const IPC_ERROR_PATTERN = /\[mnemo:([\w.]+)\] ([\s\S]*)$/;

  function encodeIpcError(key, text) {
    return `[mnemo:${key}] ${text}`;
  }

  function decodeIpcError(message) {
    const match = typeof message === "string" ? message.match(IPC_ERROR_PATTERN) : null;
    return match ? { key: match[1], text: match[2] } : null;
  }

  const api = { createTranslator, encodeIpcError, decodeIpcError };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    window.mnemoRenderer.shared.i18nTranslate = api;
  }
})();
