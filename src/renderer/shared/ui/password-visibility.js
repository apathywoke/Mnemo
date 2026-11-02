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

  /** @param {ParentNode} container */
  function buttonsIn(container) {
    return /** @type {NodeListOf<HTMLButtonElement>} */ (container.querySelectorAll("[data-password-visibility-for]"));
  }

  /** @param {HTMLButtonElement} button */
  function inputFor(button) {
    return /** @type {HTMLInputElement | null} */ (document.getElementById(button.dataset.passwordVisibilityFor));
  }

  function conceal(container = document) {
    for (const button of buttonsIn(container)) {
      const input = inputFor(button);
      if (input) setInputVisibility(input, button, false);
    }
  }

  function bindAll(container = document) {
    for (const button of buttonsIn(container)) {
      const input = inputFor(button);
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
