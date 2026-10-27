(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  // Shows a newly issued recovery key until the user confirms it is saved.
  // The dialog cannot be dismissed with Escape; locking the vault closes it.
  function init(ctx) {
    const dialog = $("#recovery-key-dialog");
    const value = $("#recovery-key-value");
    const confirm = $("#recovery-key-confirm");
    const done = $("#recovery-key-done");
    const keyStep = $("#recovery-key-step");
    const backupStep = $("#recovery-backup-step");
    let resolveShown = null;

    function finish() {
      value.textContent = "";
      confirm.checked = false;
      done.disabled = true;
      keyStep.hidden = false;
      backupStep.hidden = true;
      if (dialog.open) dialog.close();
      resolveShown?.();
      resolveShown = null;
    }

    async function closeAndForget() {
      await ctx.api.dismissRecoveryKey().catch(() => {});
      finish();
    }

    function show(recoveryKey) {
      value.textContent = recoveryKey;
      confirm.checked = false;
      done.disabled = true;
      keyStep.hidden = false;
      backupStep.hidden = true;
      dialog.showModal();
      return new Promise((resolve) => {
        resolveShown = resolve;
      });
    }

    // Called when the vault locks: main has already forgotten the key.
    function discard() {
      if (dialog.open || resolveShown) finish();
    }

    dialog.addEventListener("cancel", (event) => event.preventDefault());
    confirm.addEventListener("change", () => {
      done.disabled = !confirm.checked;
    });
    $("#recovery-key-copy").addEventListener("click", async () => {
      try {
        await ctx.api.copyRecoveryKey();
        showToast(t("toast.copied"));
      } catch (cause) {
        showToast(errorText(cause, "errors.copyValue"), { type: "error" });
      }
    });
    $("#recovery-key-save").addEventListener("click", async () => {
      try {
        const result = await ctx.api.saveRecoveryKey();
        if (!result.canceled) showToast(t("toast.recoveryKeySaved"));
      } catch (cause) {
        showToast(errorText(cause, "errors.saveRecoveryKey"), { type: "error" });
      }
    });
    // A key on its own cannot restore a deleted vault, so offer a backup
    // that pairs with it. The key text leaves the DOM at this step.
    done.addEventListener("click", () => {
      if (!confirm.checked) return;
      value.textContent = "";
      keyStep.hidden = true;
      backupStep.hidden = false;
      $("#recovery-backup-save").focus();
    });
    $("#recovery-backup-later").addEventListener("click", () => void closeAndForget());
    $("#recovery-backup-save").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await ctx.api.exportBackupWithNewKey();
        if (result.canceled) return;
        showToast(t("toast.backupSaved"));
        await closeAndForget();
      } catch (cause) {
        showToast(errorText(cause, "errors.saveBackup"), { type: "error" });
      } finally {
        button.disabled = false;
      }
    });

    return {
      show,
      discard,
      get isOpen() {
        return dialog.open;
      },
    };
  }

  ns.features.recoveryKey = { init };
})();
