(() => {
  const ns = window.mnemoRenderer;

  function setToggleButton(button, visible) {
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    button.title = visible ? "Hide password" : "Show password";
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

  ns.shared.passwordVisibility = { conceal, bindAll, setInputVisibility, setToggleButton };
})();
