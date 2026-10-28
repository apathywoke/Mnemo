(() => {
  const ns = window.mnemoRenderer;
  const LEVEL_KEYS = Object.freeze({
    empty: "strength.empty",
    weak: "strength.weak",
    fair: "strength.fair",
    strong: "strength.strong",
  });

  // Meters for master passphrases being set ([data-strength-for] names the
  // input). The main process uses the same estimate and accepts only
  // "strong", which also means at least 12 characters.
  function update(meter) {
    const input = document.getElementById(meter.dataset.strengthFor);
    const result = window.passwordTools.estimatePasswordStrength(input?.value ?? "");
    meter.dataset.strength = result.level;
    meter.querySelector(".password-strength-label").textContent = ns.shared.i18n.t(LEVEL_KEYS[result.level]);
    meter.querySelector("[role='meter']").setAttribute("aria-valuenow", String(result.value));
  }

  function meters() {
    return document.querySelectorAll("[data-strength-for]");
  }

  // For fields cleared without an input event.
  function refreshAll() {
    for (const meter of meters()) update(meter);
  }

  function bindAll() {
    for (const meter of meters()) {
      document.getElementById(meter.dataset.strengthFor)?.addEventListener("input", () => update(meter));
    }
    ns.shared.i18n.onChange(refreshAll);
    refreshAll();
  }

  ns.shared.passphraseStrength = { bindAll, refreshAll };
})();
