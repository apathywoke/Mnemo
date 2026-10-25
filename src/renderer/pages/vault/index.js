(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

  function create(ctx) {
    const browser = ns.widgets.vaultBrowser.create(ctx);
    ns.features.backup.bind(ctx);
    $("#lock-button").addEventListener("click", () => void ctx.pages.access.lockVault());
    $("#retry-button").addEventListener("click", () => void ctx.pages.access.refreshState());

    return browser;
  }

  ns.pages.vault = { create };
})();
