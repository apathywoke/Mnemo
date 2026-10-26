(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

  function bind() {
    const dialog = $("#settings-dialog");

    $("#settings-button").addEventListener("click", () => dialog.showModal());
    $("#close-settings-dialog").addEventListener("click", () => dialog.close());
  }

  ns.features.settings = { bind };
})();
