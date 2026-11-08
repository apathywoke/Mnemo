// The password generator and the strength of the entered password.
//
// The generator opens from the button beside the password, as a popover:
// it shows a password made with the chosen length and character sets, its
// expected strength, and the options. "Use password" puts it in the field;
// the password is kept nowhere else, and closing the popover (Escape, a
// press outside, leaving it with Tab, or closing the editor) clears it.
//
// password-tools.js stays language-neutral; map its levels to UI text here.
import { $ } from "../../shared/lib/dom.js";
import { t, onChange } from "../../shared/lib/i18n.js";
import * as passwordTools from "../../../shared/password-tools.js";
import { showStrengthFeedback } from "../../shared/ui/strength-feedback.js";

const STRENGTH_KEYS = {
  empty: "strength.empty",
  weak: "strength.weak",
  fair: "strength.fair",
  strong: "strength.strong",
};

/** Digits and symbols in their own colors, so the password reads easily. */
function showPassword(element, password) {
  element.textContent = "";
  for (const character of password) {
    const span = document.createElement("span");
    if (/[0-9]/.test(character)) span.className = "generated-digit";
    else if (!/[A-Za-z]/.test(character)) span.className = "generated-symbol";
    span.textContent = character;
    element.append(span);
  }
}

function init(ctx) {
  const passwordInput = $("#entry-password");
  const toggle = $("#password-generator-button");
  const popover = $("#password-generator");
  const preview = $("#generated-password");
  const lengthInput = $("#password-length");
  const lengthValue = $("#password-length-value");
  const strength = $("#password-strength");
  const strengthLabel = $("#password-strength-label");
  const strengthMeter = $("#password-strength-meter");
  const generatedStrength = $("#generated-password-strength");
  const generatedLabel = $("#generated-password-strength-label");
  const generatedMeter = $("#generated-password-strength-meter");
  const error = $("#entry-form-error");
  const options = {
    uppercase: $("#password-uppercase"),
    numbers: $("#password-numbers"),
    symbols: $("#password-symbols"),
  };
  let generated = "";

  function getOptions() {
    return Object.fromEntries(
      Object.entries(options).map(([name, checkbox]) => [name, checkbox.checked]),
    );
  }

  function updatePasswordStrength() {
    const result = passwordTools.estimatePasswordStrength(passwordInput.value);
    strength.dataset.strength = result.level;
    strengthLabel.textContent = t(STRENGTH_KEYS[result.level]);
    strengthMeter.setAttribute("aria-valuenow", String(result.value));
    showStrengthFeedback(strength, result);
  }

  function updateGeneratedPasswordStrength() {
    const result = passwordTools.estimateGeneratedPasswordStrength(
      Number(lengthInput.value),
      getOptions(),
    );
    generatedStrength.dataset.strength = result.level;
    generatedLabel.textContent = t(STRENGTH_KEYS[result.level]);
    generatedMeter.setAttribute("aria-valuenow", String(result.value));
  }

  // The filled part of the slider's track (password-tools.css).
  function showLength() {
    lengthValue.value = lengthInput.value;
    const min = Number(lengthInput.min);
    const share = (Number(lengthInput.value) - min) / (Number(lengthInput.max) - min);
    lengthInput.style.setProperty("--fill", `${share * 100}%`);
  }

  function regenerate() {
    error.hidden = true;
    try {
      generated = passwordTools.generatePassword(Number(lengthInput.value), getOptions());
      showPassword(preview, generated);
    } catch (cause) {
      generated = "";
      preview.textContent = "";
      ctx.setError(error, t("errors.generatePassword"));
    }
  }

  const isOpen = () => !popover.hidden;

  function open() {
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    regenerate();
    // Near the bottom of the editor, scroll so the whole popover shows.
    popover.scrollIntoView({ block: "nearest" });
    $("#generate-password-button").focus({ preventScroll: true });
  }

  function close({ focusToggle = false } = {}) {
    if (!isOpen()) return;
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    generated = "";
    preview.textContent = "";
    if (focusToggle) toggle.focus();
  }

  toggle.addEventListener("click", () => {
    if (isOpen()) close();
    else open();
  });

  $("#regenerate-password-button").addEventListener("click", regenerate);
  $("#generate-password-button").addEventListener("click", () => {
    if (!generated) return;
    passwordInput.value = generated;
    close();
    updatePasswordStrength();
    passwordInput.focus();
  });

  lengthInput.addEventListener("input", () => {
    showLength();
    updateGeneratedPasswordStrength();
    regenerate();
  });
  for (const checkbox of Object.values(options)) {
    checkbox.addEventListener("change", () => {
      updateGeneratedPasswordStrength();
      regenerate();
    });
  }

  // Escape in the editor closes only the popover; the page's own Escape
  // (navigation.js) would close the editor too.
  $("#entry-dialog").addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    close({ focusToggle: true });
  });
  document.addEventListener("pointerdown", (event) => {
    const target = /** @type {Node} */ (event.target);
    if (isOpen() && !popover.contains(target) && !toggle.contains(target)) close();
  });
  popover.addEventListener("focusout", (event) => {
    const next = /** @type {Node | null} */ (event.relatedTarget);
    if (next && !popover.contains(next) && next !== toggle) close();
  });
  $("#entry-dialog").addEventListener("close", () => close());

  passwordInput.addEventListener("input", updatePasswordStrength);

  /** For a new form: the popover closed and the options as reset. */
  function reset() {
    close();
    showLength();
    updatePasswordStrength();
    updateGeneratedPasswordStrength();
  }

  showLength();
  updateGeneratedPasswordStrength();
  onChange(() => {
    updatePasswordStrength();
    updateGeneratedPasswordStrength();
  });
  return { updatePasswordStrength, updateGeneratedPasswordStrength, reset };
}

export { init };
