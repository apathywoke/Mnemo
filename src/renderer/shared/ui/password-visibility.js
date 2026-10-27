(() => {
  const ns = window.mnemoRenderer;

  function setToggleButton(button, visible) {
    const label = ns.shared.i18n.t(visible ? "common.hidePassword" : "common.showPassword");
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function setInputVisibility(input, button, visible) {
    input.type = visible ? "text" : "password";
    setToggleButton(button, visible);
  }

  function conceal(container = document) {
    for (const button of container.querySelectorAll("[data-password-visibility-for]")) {
      const input = document.getElementById(button.dataset.passwordVisibilityFor);
      if (input) setInputVisibility(input, button, false);
    }
  }

  function bindAll(container = document) {
    for (const button of container.querySelectorAll("[data-password-visibility-for]")) {
      const input = document.getElementById(button.dataset.passwordVisibilityFor);
      if (!input || button.dataset.visibilityBound === "true") continue;
      button.dataset.visibilityBound = "true";
      button.addEventListener("click", () => {
        setInputVisibility(input, button, input.type === "password");
      });
    }
  }

  ns.shared.i18n.onChange(() => {
    for (const button of document.querySelectorAll("[data-password-visibility-for]")) {
      setToggleButton(button, button.getAttribute("aria-pressed") === "true");
    }
  });

  ns.shared.passwordVisibility = { conceal, bindAll, setInputVisibility, setToggleButton };
})();
