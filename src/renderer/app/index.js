(async () => {
  const ns = window.mnemoRenderer;
  const ctx = ns.app.createContext();

  await ns.features.settings.loadSettings(ctx);
  ctx.recoveryKey = ns.features.recoveryKey.init(ctx);
  ctx.importer = ns.features.importer.init(ctx);
  ctx.touchId = ns.features.touchId.init(ctx);
  ns.features.settings.bind(ctx);

  // Page composition follows FSD direction: pages compose widgets and features;
  // the app layer wires pages together and owns application-wide navigation.
  ctx.pages.vault = ns.pages.vault.create(ctx);
  ctx.pages.access = ns.pages.access.create(ctx);
  ns.shared.passwordVisibility.bindAll();
  ns.app.bindNavigation(ctx);

  ctx.api.getVersion()
    .then((version) => { ns.shared.dom.$("#app-version").textContent = version; })
    .catch(() => { ns.shared.dom.$("#app-version").textContent = ns.shared.i18n.t("common.unavailable"); });

  void ctx.pages.access.refreshProfiles();
})();
