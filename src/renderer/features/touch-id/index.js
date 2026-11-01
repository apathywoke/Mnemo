import { $ } from "../../shared/lib/dom.js";
import { t, errorText, errorKey } from "../../shared/lib/i18n.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";

// Touch ID on the unlock screen. The vault key is released and used in the
// main process; this renderer only asks for it and refreshes the view.
function init(ctx) {
  const button = $("#unlock-touchid-button");
  let inProgress = false;

  async function unlock({ quietCancel = false } = {}) {
    if (inProgress) return;
    inProgress = true;
    button.disabled = true;
    $("#unlock-error").hidden = true;
    try {
      await ctx.api.unlockWithTouchId();
      ctx.clearSensitiveFields();
      await ctx.pages.access.refreshState();
      showToast(t("toast.vaultUnlocked"));
    } catch (cause) {
      const key = errorKey(cause);
      if (key === "errors.touchIdCanceled" && quietCancel) return;
      if (key === "errors.touchIdInvalid") button.hidden = true;
      ctx.setError($("#unlock-error"), errorText(cause, "errors.unlockVault"));
    } finally {
      inProgress = false;
      button.disabled = false;
    }
  }

  async function prepareUnlock({ autoPrompt = false } = {}) {
    button.hidden = true;
    let status;
    try {
      status = await ctx.api.getTouchIdStatus();
    } catch {
      return;
    }
    if (!status.available || !status.enabled || $("#unlock-panel").hidden) return;
    button.hidden = false;
    if (autoPrompt) await unlock({ quietCancel: true });
  }

  button.addEventListener("click", () => void unlock());

  return { prepareUnlock };
}

export { init };
