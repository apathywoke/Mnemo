import { t } from "../lib/i18n.js";

// One line under a strength meter that says why a password is not strong:
// the estimate's warning, or else its first suggestion. Empty when the
// password is strong or the field is empty.
function showStrengthFeedback(meter, result) {
  let line = meter.querySelector(".password-strength-feedback");
  if (!line) {
    line = document.createElement("p");
    line.className = "password-strength-feedback";
    line.setAttribute("aria-live", "polite");
    meter.append(line);
  }
  const key = result.level === "strong" || result.level === "empty"
    ? ""
    : result.feedback.warning || result.feedback.suggestions[0] || "";
  line.textContent = key ? t(key) : "";
  line.hidden = !key;
}

export { showStrengthFeedback };
