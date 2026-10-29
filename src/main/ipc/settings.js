// IPC handlers. Settings and the app version.

function register(ctx) {
  const { state, registerHandler } = ctx;
  const { app, nativeTheme } = ctx.electron;

  registerHandler("app:get-version", () => app.getVersion());

  registerHandler("settings:get", async () => {
    await state.settingsLoaded;
    return state.settingsStore.get();
  });

  registerHandler("settings:set-theme", async (theme) => {
    await state.settingsLoaded;
    const settings = await state.settingsStore.setTheme(theme);
    if (nativeTheme) nativeTheme.themeSource = settings.theme;
    return settings;
  });

  registerHandler("settings:set-language", async (code) => {
    await state.settingsLoaded;
    const settings = await state.settingsStore.setLanguage(code);
    state.language = settings.language;
    return settings;
  });
}

module.exports = { register };
