(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { conceal } = ns.shared.passwordVisibility;
  const { show: showToast } = ns.shared.toast;
  const { t, errorText, errorKey } = ns.shared.i18n;

  function bind(ctx, access) {
    const createForm = $("#create-form");
    const unlockForm = $("#unlock-form");
    const restoreForm = $("#restore-form");
    const recoverForm = $("#recover-form");

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(createForm);
      $("#create-error").hidden = true;
      if ($("#create-passphrase").value !== $("#confirm-passphrase").value) {
        ctx.setError($("#create-error"), t("errors.passphrasesMismatch"));
        return;
      }
      const button = createForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = t("setup.creating");
      try {
        const created = await ctx.api.createProfile(
          $("#profile-name").value,
          $("#create-passphrase").value,
        );
        ctx.state.access.selectedProfileId = created.profile.id;
        ctx.state.access.selectedProfileName = created.profile.name;
        ctx.clearSensitiveFields();
        await access.refreshState();
        await ctx.recoveryKey.show(created.recoveryKey);
        showToast(t("toast.vaultCreated"));
      } catch (cause) {
        $("#create-passphrase").value = "";
        $("#confirm-passphrase").value = "";
        if (errorKey(cause) === "errors.vaultCreatedLocked") {
          await access.refreshProfiles();
          showToast(t("toast.vaultCreatedLocked"));
          return;
        }
        ctx.setError($("#create-error"), errorText(cause, "errors.createVault"));
      } finally {
        button.disabled = false;
        button.textContent = t("setup.submit");
      }
    });

    unlockForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(unlockForm);
      $("#unlock-error").hidden = true;
      const button = unlockForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = t("unlock.unlocking");
      try {
        await ctx.api.unlockVault($("#unlock-passphrase").value);
        ctx.clearSensitiveFields();
        await access.refreshState();
        showToast(t("toast.vaultUnlocked"));
      } catch (cause) {
        ctx.setError($("#unlock-error"), errorText(cause, "errors.unlockVault"));
        $("#unlock-passphrase").value = "";
        $("#unlock-passphrase").focus();
      } finally {
        button.disabled = false;
        button.textContent = t("unlock.submit");
      }
    });

    // The restore form takes either the backup's passphrase or, when that is
    // forgotten, a recovery key plus a new passphrase.
    let restoreWithRecoveryKey = false;
    function setRestoreMode(useRecoveryKey) {
      restoreWithRecoveryKey = useRecoveryKey;
      $("#restore-passphrase-fields").hidden = useRecoveryKey;
      $("#restore-recovery-fields").hidden = !useRecoveryKey;
      $("#restore-passphrase").required = !useRecoveryKey;
      for (const id of ["restore-recovery-key", "restore-new-passphrase", "restore-confirm-passphrase"]) {
        $(`#${id}`).required = useRecoveryKey;
      }
      const toggle = $("#restore-mode-button");
      toggle.dataset.i18n = useRecoveryKey ? "restore.usePassphrase" : "restore.useRecoveryKey";
      toggle.textContent = t(toggle.dataset.i18n);
      $("#restore-error").hidden = true;
      conceal(restoreForm);
    }
    $("#restore-mode-button").addEventListener("click", () => {
      setRestoreMode(!restoreWithRecoveryKey);
      $(restoreWithRecoveryKey ? "#restore-recovery-key" : "#restore-passphrase").focus();
    });
    restoreForm.addEventListener("reset", () => setRestoreMode(false));

    recoverForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(recoverForm);
      $("#recover-error").hidden = true;
      if ($("#recover-passphrase").value !== $("#recover-confirm-passphrase").value) {
        ctx.setError($("#recover-error"), t("errors.passphrasesMismatch"));
        return;
      }
      const button = recoverForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = t("recover.checking");
      try {
        const result = await ctx.api.recoverVault(
          $("#recover-key").value,
          $("#recover-passphrase").value,
        );
        ctx.clearSensitiveFields();
        await access.refreshState();
        await ctx.recoveryKey.show(result.recoveryKey);
        showToast(t("toast.vaultRecovered"));
      } catch (cause) {
        $("#recover-passphrase").value = "";
        $("#recover-confirm-passphrase").value = "";
        ctx.setError($("#recover-error"), errorText(cause, "errors.recoverVault"));
      } finally {
        button.disabled = false;
        button.textContent = t("restore.submit");
      }
    });

    restoreForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(restoreForm);
      $("#restore-error").hidden = true;
      if (
        restoreWithRecoveryKey &&
        $("#restore-new-passphrase").value !== $("#restore-confirm-passphrase").value
      ) {
        ctx.setError($("#restore-error"), t("errors.passphrasesMismatch"));
        return;
      }
      const credentials = restoreWithRecoveryKey
        ? {
            recoveryKey: $("#restore-recovery-key").value,
            newPassphrase: $("#restore-new-passphrase").value,
          }
        : $("#restore-passphrase").value;
      let recoveryKey = null;
      const button = restoreForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = t("restore.checking");
      const restoringNewProfile = ctx.state.access.restoringNewProfile;
      try {
        if (restoringNewProfile) {
          const restored = await ctx.api.restoreNewProfile(
            $("#restore-profile-name").value,
            credentials,
          );
          if (restored.canceled) {
            await access.refreshProfiles();
            return;
          }
          ctx.state.access.selectedProfileId = restored.profile.id;
          ctx.state.access.selectedProfileName = restored.profile.name;
          recoveryKey = restored.recoveryKey;
        } else {
          const restored = await ctx.api.restoreBackup(credentials);
          if (restored.canceled) return;
          recoveryKey = restored.recoveryKey;
        }
        ctx.clearSensitiveFields();
        await access.refreshState();
        if (recoveryKey) await ctx.recoveryKey.show(recoveryKey);
        showToast(t(restoringNewProfile ? "toast.backupRestoredNew" : "toast.vaultRestored"));
      } catch (cause) {
        for (const id of ["restore-passphrase", "restore-new-passphrase", "restore-confirm-passphrase"]) {
          $(`#${id}`).value = "";
        }
        if (errorKey(cause) === "errors.backupRestoredLocked") {
          await access.refreshProfiles();
          showToast(t("toast.backupRestoredLocked"));
          return;
        }
        ctx.setError($("#restore-error"), errorText(cause, "errors.restoreVault"));
        $("#restore-passphrase").focus();
      } finally {
        button.disabled = false;
        button.textContent = t("restore.submit");
      }
    });
  }

  ns.features.vaultAccess = { bind };
})();
