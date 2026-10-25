(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

  function init(ctx) {
    const passwordInput = $("#entry-password");
    const lengthInput = $("#password-length");
    const lengthValue = $("#password-length-value");
    const strength = $("#password-strength");
    const strengthLabel = $("#password-strength-label");
    const strengthMeter = $("#password-strength-meter");
    const generatedStrength = $("#generated-password-strength");
    const generatedLabel = $("#generated-password-strength-label");
    const generatedMeter = $("#generated-password-strength-meter");
    const options = {
      uppercase: $("#password-uppercase"),
      numbers: $("#password-numbers"),
      symbols: $("#password-symbols"),
    };

    function getOptions() {
      return Object.fromEntries(
        Object.entries(options).map(([name, checkbox]) => [name, checkbox.checked]),
      );
    }

    function updatePasswordStrength() {
      const result = window.passwordTools.estimatePasswordStrength(passwordInput.value);
      strength.dataset.strength = result.level;
      strengthLabel.textContent = result.label;
      strengthMeter.setAttribute("aria-valuenow", String(result.value));
    }

    function updateGeneratedPasswordStrength() {
      const result = window.passwordTools.estimateGeneratedPasswordStrength(
        Number(lengthInput.value),
        getOptions(),
      );
      generatedStrength.dataset.strength = result.level;
      generatedLabel.textContent = result.label;
      generatedMeter.setAttribute("aria-valuenow", String(result.value));
    }

    passwordInput.addEventListener("input", updatePasswordStrength);
    lengthInput.addEventListener("input", () => {
      lengthValue.value = lengthInput.value;
      updateGeneratedPasswordStrength();
    });
    for (const checkbox of Object.values(options)) {
      checkbox.addEventListener("change", updateGeneratedPasswordStrength);
    }
    $("#generate-password-button").addEventListener("click", () => {
      const error = $("#entry-form-error");
      error.hidden = true;
      try {
        passwordInput.value = window.passwordTools.generatePassword(
          Number(lengthInput.value),
          getOptions(),
        );
        updatePasswordStrength();
        passwordInput.focus();
      } catch (cause) {
        ctx.setError(error, cause.message || "Could not generate a secure password.");
      }
    });

    lengthValue.value = lengthInput.value;
    updateGeneratedPasswordStrength();
    return { updatePasswordStrength, updateGeneratedPasswordStrength };
  }

  ns.features.passwordGenerator = { init };
})();
