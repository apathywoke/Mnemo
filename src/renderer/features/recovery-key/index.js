import { $ } from "../../shared/lib/dom.js";
import { t, errorText } from "../../shared/lib/i18n.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";

// Shows a newly issued recovery key until the user confirms it is saved by
// typing its last characters, which main checks. The dialog cannot be
// dismissed with Escape; locking the vault closes it.
function init(ctx) {
  const dialog = $("#recovery-key-dialog");
  const value = $("#recovery-key-value");
  const confirm = $("#recovery-key-confirm");
  const done = $("#recovery-key-done");
  const confirmError = $("#recovery-key-confirm-error");
  const replacedNote = $("#recovery-key-replaced");
  const keyStep = $("#recovery-key-step");
  const backupStep = $("#recovery-backup-step");
  let resolveShown = null;

  const typedSuffix = () => confirm.value.replace(/[\s-]/g, "");

  function finish() {
    value.textContent = "";
    confirm.value = "";
    confirmError.hidden = true;
    replacedNote.hidden = true;
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
    // Main turns the backup reminder back on for a new key.
    void ctx.pages.vault?.refreshBackupReminder();
  }

  // `replaced`: an earlier key of this vault stopped working.
  function show(recoveryKey, { replaced = false } = {}) {
    value.textContent = recoveryKey;
    confirm.value = "";
    confirmError.hidden = true;
    replacedNote.hidden = !replaced;
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
  confirm.addEventListener("input", () => {
    confirmError.hidden = true;
    done.disabled = typedSuffix().length !== 4;
  });
  confirm.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !done.disabled) {
      event.preventDefault();
      done.click();
    }
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
  done.addEventListener("click", async () => {
    if (done.disabled) return;
    done.disabled = true;
    try {
      await ctx.api.confirmRecoveryKeySaved(typedSuffix());
    } catch (cause) {
      confirmError.textContent = errorText(cause, "errors.recoveryKeyMismatch");
      confirmError.hidden = false;
      done.disabled = false;
      confirm.select();
      return;
    }
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

export { init };
