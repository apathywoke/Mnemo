// Translated messages for dialogs, and errors sent to the renderer.
const { encodeIpcError } = require("../../src/renderer/shared/i18n/translate");

function createTranslation(ctx) {
  const { state, translator } = ctx;

  function tr(key, params) {
    return translator.t(state.language, key, params);
  }

  // Main-process modules throw English messages; send the renderer a translated
  // message tagged with its key. Unrecognized errors get a generic message so
  // internal details do not reach the UI.
  function toIpcError(error) {
    const match = translator.matchError(error?.message);
    const key = match?.key ?? "errors.unknown";
    return new Error(encodeIpcError(key, tr(key, match?.params)));
  }

  return { tr, toIpcError };
}

module.exports = { createTranslation };
