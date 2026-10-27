(() => {
  const ns = window.mnemoRenderer;
  const translator = ns.shared.i18nTranslate.createTranslator(ns.shared.i18nCatalog);
  const listeners = new Set();
  let language = translator.pickLanguage(navigator.languages);

  // Elements opt in with data-i18n (text content) or data-i18n-<attribute>,
  // e.g. data-i18n-aria-label="key" or data-i18n-placeholder="key".
  const TRANSLATED_ATTRIBUTES = ["aria-label", "title", "placeholder"];

  function t(key, params) {
    return translator.t(language, key, params);
  }

  function apply(root = document) {
    for (const element of root.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  }

  function setLanguage(code) {
    if (!translator.isSupported(code)) return;
    language = code;
    document.documentElement.lang = code;
    apply();
    for (const listener of listeners) listener(code);
  }

  function onChange(listener) {
    listeners.add(listener);
  }

  // Text for an error that may have crossed IPC; falls back to a generic
  // translated message rather than showing Electron's wrapper text.
  function errorText(cause, fallbackKey = "errors.unknown") {
    const decoded = ns.shared.i18nTranslate.decodeIpcError(cause?.message);
    if (decoded) return decoded.text;
    return t(fallbackKey);
  }

  function errorKey(cause) {
    return ns.shared.i18nTranslate.decodeIpcError(cause?.message)?.key ?? null;
  }

  ns.shared.i18n = {
    t,
    apply,
    setLanguage,
    onChange,
    errorText,
    errorKey,
    languages: translator.languages,
    get language() {
      return language;
    },
  };
})();
