(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { i18n } = ns.shared;
  const { show: showToast } = ns.shared.toast;
  let resetVaultActions = () => {};
  let showVaultLocked = () => {};

  // Actions that need the master passphrase again. Each names its prompt,
  // confirm label, fallback error, and what to do once the passphrase is in.
  const PASSPHRASE_ACTIONS = Object.freeze({
    recovery: {
      prompt: "settings.recoveryPrompt",
      confirm: "settings.recoveryConfirm",
      error: "errors.createRecoveryKey",
    },
    export: {
      prompt: "settings.exportPrompt",
      confirm: "settings.exportConfirm",
      error: "errors.saveBackup",
    },
    delete: {
      prompt: "settings.deletePrompt",
      confirm: "settings.deleteConfirm",
      error: "errors.deleteVault",
    },
  });

  function bind(ctx) {
    const dialog = $("#settings-dialog");
    const languageSelect = $("#settings-language");
    const error = $("#settings-error");

    // Language names stay in their own language so each is recognizable.
    for (const { code, name } of i18n.languages) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      option.lang = code;
      languageSelect.append(option);
    }
    languageSelect.value = i18n.language;
    i18n.onChange((code) => { languageSelect.value = code; });

    languageSelect.addEventListener("change", async () => {
      const requested = languageSelect.value;
      error.hidden = true;
      languageSelect.disabled = true;
      try {
        const settings = await ctx.api.setLanguage(requested);
        i18n.setLanguage(settings.language);
        showToast(i18n.t("toast.languageChanged"));
      } catch (cause) {
        languageSelect.value = i18n.language;
        ctx.setError(error, i18n.errorText(cause, "errors.saveSettings"));
      } finally {
        languageSelect.disabled = false;
      }
    });

    // Vault sections: recovery key, backups and import, deletion. They need an
    // unlocked vault; otherwise a single hint explains that.
    const vaultSections = $("#settings-vault");
    const lockedHint = $("#settings-vault-locked");
    const recoveryStatus = $("#settings-recovery-status");
    const recoveryButton = $("#settings-recovery-button");
    const confirmForm = $("#settings-confirm-form");
    const confirmPrompt = $("#settings-confirm-prompt");
    const confirmPassphrase = $("#settings-confirm-passphrase");
    const confirmSubmit = $("#settings-confirm-submit");
    const confirmError = $("#settings-confirm-error");
    let recoveryEnabled = null;
    let pendingAction = null;

    function renderVault() {
      recoveryStatus.textContent = recoveryEnabled === null
        ? ""
        : i18n.t(recoveryEnabled ? "settings.recoveryEnabled" : "settings.recoveryMissing");
      recoveryButton.hidden = recoveryEnabled === null;
      recoveryButton.textContent = i18n.t(
        recoveryEnabled ? "settings.recoveryReplace" : "settings.recoveryCreate",
      );
      if (pendingAction) {
        confirmPrompt.textContent = i18n.t(PASSPHRASE_ACTIONS[pendingAction].prompt);
        confirmSubmit.textContent = i18n.t(PASSPHRASE_ACTIONS[pendingAction].confirm);
      }
    }

    resetVaultActions = () => {
      pendingAction = null;
      confirmForm.reset();
      confirmForm.hidden = true;
      confirmError.hidden = true;
      confirmSubmit.classList.remove("danger-confirm-button");
      ns.shared.passwordVisibility.conceal(confirmForm);
      for (const button of vaultSections.querySelectorAll("[data-settings-action]")) {
        button.disabled = false;
      }
    };

    showVaultLocked = () => {
      resetVaultActions();
      recoveryEnabled = null;
      vaultSections.hidden = true;
      lockedHint.hidden = false;
    };

    async function refreshVault() {
      if (!document.body.classList.contains("is-unlocked")) {
        showVaultLocked();
        return;
      }
      resetVaultActions();
      lockedHint.hidden = true;
      vaultSections.hidden = false;
      recoveryEnabled = null;
      renderVault();
      try {
        recoveryEnabled = (await ctx.api.getRecoveryStatus()).enabled;
        renderVault();
      } catch {
        showVaultLocked();
      }
    }

    function askPassphrase(action) {
      resetVaultActions();
      pendingAction = action;
      confirmSubmit.classList.toggle("danger-confirm-button", action === "delete");
      renderVault();
      for (const button of vaultSections.querySelectorAll("[data-settings-action]")) {
        button.disabled = button.dataset.settingsAction !== action;
      }
      confirmForm.hidden = false;
      confirmPassphrase.focus();
    }

    async function runAction(action, passphrase) {
      if (action === "recovery") {
        const { recoveryKey } = await ctx.api.createRecoveryKey(passphrase);
        resetVaultActions();
        dialog.close();
        await ctx.recoveryKey.show(recoveryKey);
        showToast(i18n.t("toast.recoveryKeyCreated"));
      } else if (action === "export") {
        const result = await ctx.api.exportBackup(passphrase);
        resetVaultActions();
        if (!result.canceled) showToast(i18n.t("toast.backupSaved"));
      } else if (action === "delete") {
        const result = await ctx.api.deleteActiveVault(passphrase);
        resetVaultActions();
        if (!result.deleted) return;
        dialog.close();
        await ctx.pages.access.chooseProfiles();
        showToast(i18n.t("toast.vaultDeleted"));
      }
    }

    for (const button of vaultSections.querySelectorAll("[data-settings-action]")) {
      button.addEventListener("click", () => askPassphrase(button.dataset.settingsAction));
    }
    $("#settings-confirm-cancel").addEventListener("click", resetVaultActions);
    confirmForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = pendingAction;
      if (!action) return;
      confirmError.hidden = true;
      confirmSubmit.disabled = true;
      try {
        await runAction(action, confirmPassphrase.value);
      } catch (cause) {
        confirmPassphrase.value = "";
        ctx.setError(confirmError, i18n.errorText(cause, PASSPHRASE_ACTIONS[action].error));
        confirmPassphrase.focus();
      } finally {
        confirmSubmit.disabled = false;
      }
    });
    $("#settings-import-button").addEventListener("click", () => {
      dialog.close();
      ctx.importer.open();
    });
    dialog.addEventListener("close", resetVaultActions);
    i18n.onChange(renderVault);

    $("#settings-button").addEventListener("click", () => {
      error.hidden = true;
      dialog.showModal();
      void refreshVault();
    });
    $("#close-settings-dialog").addEventListener("click", () => dialog.close());
  }

  // Applies the saved language before the first screen is shown.
  async function loadSettings(ctx) {
    try {
      const settings = await ctx.api.getSettings();
      i18n.setLanguage(settings.language);
    } catch {
      i18n.setLanguage(i18n.language);
    }
  }

  ns.features.settings = {
    bind,
    loadSettings,
    showRecoveryLocked: () => showVaultLocked(),
  };
})();
