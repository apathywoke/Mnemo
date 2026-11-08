// Creating a vault, one step at a time: (1) the vault's name and the master
// passphrase with its strength, (2) the warning that Mnemo cannot recover
// the passphrase and the passphrase typed again, (3) the recovery key
// (features/recovery-key). Continue checks step 1 the way main will, so a
// passphrase main would refuse is fixed where it was typed.
import { $ } from "../../shared/lib/dom.js";
import { t } from "../../shared/lib/i18n.js";
import { conceal } from "../../shared/ui/password-visibility.js";

const MIN_PASSPHRASE_LENGTH = 12;

function bind(ctx) {
  const form = $("#create-form");
  const description = $("#setup-description");
  const steps = [$("#setup-step-1"), $("#setup-step-2")];
  const stepError = $("#setup-step-error");
  const name = $("#profile-name");
  const passphrase = $("#create-passphrase");
  const meter = $("[data-strength-for='create-passphrase']");
  let current = 1;

  function setKey(element, key) {
    element.dataset.i18n = key;
    element.textContent = t(key);
  }

  function show(step) {
    current = step;
    steps.forEach((element, index) => { element.hidden = index + 1 !== step; });
    setKey(description, step === 1 ? "setup.description" : "setup.descriptionConfirm");
    conceal(form);
  }

  function next() {
    stepError.hidden = true;
    if (!name.reportValidity()) return;
    if (passphrase.value.length < MIN_PASSPHRASE_LENGTH) {
      ctx.setError(stepError, t("errors.passphraseTooShort", { min: MIN_PASSPHRASE_LENGTH }));
      passphrase.focus();
      return;
    }
    if (meter.dataset.strength !== "strong") {
      ctx.setError(stepError, t("errors.passphraseWeak"));
      passphrase.focus();
      return;
    }
    $("#create-error").hidden = true;
    show(2);
    $("#confirm-passphrase").focus();
  }

  $("#setup-continue").addEventListener("click", next);
  // Enter in a field of step 1 continues. The form's own Enter would press
  // Create, which is hidden on this step.
  steps[0].addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !/** @type {Element} */ (event.target).matches("input")) return;
    event.preventDefault();
    next();
  });
  $("#setup-step-back").addEventListener("click", () => {
    $("#confirm-passphrase").value = "";
    $("#create-error").hidden = true;
    show(1);
    passphrase.focus();
  });
  // A new form starts again at step 1.
  form.addEventListener("reset", () => {
    stepError.hidden = true;
    show(1);
  });

  return {
    /** The step shown: 1 or 2. */
    step: () => current,
    next,
    /** Back to step 1 with an error there (a refused or failed create). */
    restart(message) {
      show(1);
      ctx.setError(stepError, message);
      passphrase.focus();
    },
  };
}

export { bind };
