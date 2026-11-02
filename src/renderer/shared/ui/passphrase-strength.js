import * as i18n from "../lib/i18n.js";
import * as passwordTools from "../../../shared/password-tools.js";
import { showStrengthFeedback } from "./strength-feedback.js";

const LEVEL_KEYS = Object.freeze({
  empty: "strength.empty",
  weak: "strength.weak",
  fair: "strength.fair",
  strong: "strength.strong",
});

// Meters for master passphrases being set ([data-strength-for] names the
// input; [data-strength-inputs] lists inputs whose text makes it easier to
// guess, such as the vault name). The main process uses the same estimate
// and accepts only "strong", which also means at least 12 characters.
function relatedInputs(meter) {
  return (meter.dataset.strengthInputs ?? "").split(" ").filter(Boolean)
    .map((id) => /** @type {HTMLInputElement | null} */ (document.getElementById(id)))
    .filter(Boolean);
}

function update(meter) {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(meter.dataset.strengthFor));
  const userInputs = relatedInputs(meter).map((related) => related.value);
  const result = passwordTools.estimatePasswordStrength(input?.value ?? "", { userInputs });
  meter.dataset.strength = result.level;
  meter.querySelector(".password-strength-label").textContent = i18n.t(LEVEL_KEYS[result.level]);
  meter.querySelector("[role='meter']").setAttribute("aria-valuenow", String(result.value));
  showStrengthFeedback(meter, result);
}

function meters() {
  return /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-strength-for]"));
}

// For fields cleared without an input event.
function refreshAll() {
  for (const meter of meters()) update(meter);
}

function bindAll() {
  for (const meter of meters()) {
    document.getElementById(meter.dataset.strengthFor)?.addEventListener("input", () => update(meter));
    for (const related of relatedInputs(meter)) related.addEventListener("input", () => update(meter));
  }
  i18n.onChange(refreshAll);
  refreshAll();
}

export { bindAll, refreshAll };
