(() => {
  const ns = window.mnemoRenderer;
  const { $, $$ } = ns.shared.dom;
  const { i18n } = ns.shared;
  const { show: showToast } = ns.shared.toast;
  let resetVaultActions = () => {};
  let savedTheme = "system";
  let showVaultLocked = () => {};

  // Actions that need the master passphrase again. Each names its prompt,
  // confirm label, fallback error, and what to do once the passphrase is in.
  const PASSPHRASE_ACTIONS = Object.freeze({
    // Also asks for the new passphrase twice (see the confirm form).
    passphrase: {
      prompt: "settings.passphrasePrompt",
      confirm: "settings.passphraseConfirm",
      error: "errors.changePassphrase",
    },
    recovery: {
      prompt: "settings.recoveryPrompt",
      confirm: "settings.recoveryConfirm",
      error: "errors.createRecoveryKey",
    },
    touchid: {
      prompt: "touchId.prompt",
      confirm: "touchId.confirm",
      error: "errors.touchIdEnable",
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

    // Theme: applying is done by main through nativeTheme; theme.js follows
    // the resulting prefers-color-scheme change.
    const themeInputs = $$("input[name='settings-theme']", dialog);
    const themeError = $("#settings-theme-error");
    function showSavedTheme() {
      for (const input of themeInputs) input.checked = input.value === savedTheme;
    }
    for (const input of themeInputs) {
      input.addEventListener("change", async () => {
        if (!input.checked) return;
        themeError.hidden = true;
        try {
          savedTheme = (await ctx.api.setTheme(input.value)).theme;
        } catch (cause) {
          ctx.setError(themeError, i18n.errorText(cause, "errors.saveSettings"));
        }
        showSavedTheme();
      });
    }

    // Categories. General works any time; the others act on the open vault
    // and show a hint instead while it is locked.
    const tabs = $$("[data-settings-tab]", dialog);
    let activeTab = "general";

    function selectTab(name, { focus = false } = {}) {
      activeTab = name;
      resetVaultActions();
      for (const tab of tabs) {
        const selected = tab.dataset.settingsTab === name;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        $(`#${tab.getAttribute("aria-controls")}`).hidden = !selected;
        if (selected && focus) tab.focus();
      }
    }

    for (const tab of tabs) {
      tab.addEventListener("click", () => selectTab(tab.dataset.settingsTab));
      tab.addEventListener("keydown", (event) => {
        const index = tabs.indexOf(tab);
        const next = {
          ArrowDown: index + 1,
          ArrowRight: index + 1,
          ArrowUp: index - 1,
          ArrowLeft: index - 1,
          Home: 0,
          End: tabs.length - 1,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const target = tabs[(next + tabs.length) % tabs.length];
        selectTab(target.dataset.settingsTab, { focus: true });
      });
    }

    const paneBodies = $$(".settings-pane-body", dialog);
    const lockedHints = $$(".settings-pane-locked", dialog);
    const actionButtons = $$("[data-settings-action]", dialog);
    function setVaultUnlocked(unlocked) {
      for (const body of paneBodies) body.hidden = !unlocked;
      for (const hint of lockedHints) hint.hidden = unlocked;
    }
    const recoveryStatus = $("#settings-recovery-status");
    const recoveryButton = $("#settings-recovery-button");
    const confirmForm = $("#settings-confirm-form");
    const confirmPrompt = $("#settings-confirm-prompt");
    const confirmPassphrase = $("#settings-confirm-passphrase");
    const confirmSubmit = $("#settings-confirm-submit");
    const confirmError = $("#settings-confirm-error");
    const newPassphraseFields = $("#settings-new-passphrase-fields");
    const newPassphrase = $("#settings-new-passphrase");
    const confirmNewPassphrase = $("#settings-confirm-new-passphrase");
    const touchIdStatus = $("#settings-touchid-status");
    const touchIdEnable = $("#settings-touchid-enable");
    const touchIdDisable = $("#settings-touchid-disable");
    let recoveryEnabled = null;
    let touchId = null;
    let pendingAction = null;

    function renderVault() {
      recoveryStatus.textContent = recoveryEnabled === null
        ? ""
        : i18n.t(recoveryEnabled ? "settings.recoveryEnabled" : "settings.recoveryMissing");
      recoveryButton.hidden = recoveryEnabled === null;
      recoveryButton.textContent = i18n.t(
        recoveryEnabled ? "settings.recoveryReplace" : "settings.recoveryCreate",
      );
      touchIdStatus.textContent = touchId === null
        ? ""
        : i18n.t(!touchId.available
          ? "touchId.unavailable"
          : touchId.enabled ? "touchId.enabled" : "touchId.disabled");
      touchIdEnable.hidden = !touchId?.available || touchId.enabled;
      touchIdDisable.hidden = !touchId?.available || !touchId.enabled;
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
      showNewPassphrase(false);
      ns.shared.passwordVisibility.conceal(confirmForm);
      ns.shared.passphraseStrength.refreshAll();
      for (const button of actionButtons) button.disabled = false;
    };

    showVaultLocked = () => {
      resetVaultActions();
      recoveryEnabled = null;
      setVaultUnlocked(false);
    };

    async function refreshVault() {
      if (!document.body.classList.contains("is-unlocked")) {
        showVaultLocked();
        return;
      }
      resetVaultActions();
      setVaultUnlocked(true);
      recoveryEnabled = null;
      touchId = null;
      renderVault();
      try {
        [recoveryEnabled, touchId] = await Promise.all([
          ctx.api.getRecoveryStatus().then((status) => status.enabled),
          ctx.api.getTouchIdStatus(),
        ]);
        renderVault();
      } catch {
        showVaultLocked();
      }
    }

    function showNewPassphrase(show) {
      newPassphraseFields.hidden = !show;
      newPassphrase.required = show;
      confirmNewPassphrase.required = show;
    }

    function askPassphrase(action, button) {
      resetVaultActions();
      pendingAction = action;
      confirmSubmit.classList.toggle("danger-confirm-button", action === "delete");
      showNewPassphrase(action === "passphrase");
      renderVault();
      // The form sits under the section of the action it confirms.
      button.closest(".settings-section").after(confirmForm);
      for (const other of actionButtons) {
        other.disabled = other.dataset.settingsAction !== action;
      }
      confirmForm.hidden = false;
      confirmPassphrase.focus();
    }

    async function runAction(action, passphrase) {
      if (action === "passphrase") {
        const { recoveryKey } = await ctx.api.changePassphrase(passphrase, newPassphrase.value);
        resetVaultActions();
        dialog.close();
        // The vault key changed, so Touch ID was turned off in main.
        await ctx.recoveryKey.show(recoveryKey);
        showToast(i18n.t("toast.passphraseChanged"));
      } else if (action === "recovery") {
        const { recoveryKey } = await ctx.api.createRecoveryKey(passphrase);
        resetVaultActions();
        dialog.close();
        await ctx.recoveryKey.show(recoveryKey);
        showToast(i18n.t("toast.recoveryKeyCreated"));
      } else if (action === "touchid") {
        await ctx.api.enableTouchId(passphrase);
        resetVaultActions();
        touchId = { ...touchId, enabled: true };
        renderVault();
        showToast(i18n.t("toast.touchIdEnabled"));
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

    for (const button of actionButtons) {
      button.addEventListener("click", () => askPassphrase(button.dataset.settingsAction, button));
    }
    $("#settings-confirm-cancel").addEventListener("click", resetVaultActions);
    touchIdDisable.addEventListener("click", async () => {
      touchIdDisable.disabled = true;
      try {
        await ctx.api.disableTouchId();
        touchId = { ...touchId, enabled: false };
        renderVault();
        showToast(i18n.t("toast.touchIdDisabled"));
      } catch (cause) {
        showToast(i18n.errorText(cause, "errors.touchIdDisable"), { type: "error" });
      } finally {
        touchIdDisable.disabled = false;
      }
    });
    confirmForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = pendingAction;
      if (!action) return;
      confirmError.hidden = true;
      if (action === "passphrase" && newPassphrase.value !== confirmNewPassphrase.value) {
        ctx.setError(confirmError, i18n.t("errors.passphrasesMismatch"));
        confirmNewPassphrase.focus();
        return;
      }
      confirmSubmit.disabled = true;
      try {
        await runAction(action, confirmPassphrase.value);
      } catch (cause) {
        ctx.setError(confirmError, i18n.errorText(cause, PASSPHRASE_ACTIONS[action].error));
        // A refused new passphrase keeps the current one typed in.
        if (["errors.passphraseWeak", "errors.passphraseTooShort"].includes(i18n.errorKey(cause))) {
          newPassphrase.focus();
        } else {
          confirmPassphrase.value = "";
          confirmPassphrase.focus();
        }
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
      themeError.hidden = true;
      showSavedTheme();
      selectTab(activeTab);
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
      savedTheme = settings.theme ?? "system";
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
