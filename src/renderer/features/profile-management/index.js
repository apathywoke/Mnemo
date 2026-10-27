(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;
  const { t, errorText } = ns.shared.i18n;

  function init(ctx, { onDeleted }) {
    const dialog = $("#delete-profile-dialog");
    const confirmInput = $("#delete-profile-confirm-input");
    const confirmButton = $("#confirm-profile-delete-button");
    const error = $("#delete-profile-error");
    let pendingProfile = null;

    function close() {
      if (dialog.open) dialog.close();
      pendingProfile = null;
      confirmInput.value = "";
      error.hidden = true;
      confirmButton.disabled = true;
      confirmButton.textContent = t("deleteProfile.submit");
    }

    function open(profile) {
      pendingProfile = { id: profile.id, name: profile.name };
      $("#delete-profile-name-confirm").textContent = profile.name;
      confirmInput.value = "";
      error.hidden = true;
      confirmButton.disabled = true;
      confirmButton.textContent = t("deleteProfile.submit");
      dialog.showModal();
      confirmInput.focus();
    }

    confirmInput.addEventListener("input", () => {
      confirmButton.disabled = !pendingProfile || confirmInput.value !== pendingProfile.name;
    });
    $("#cancel-profile-delete-button").addEventListener("click", close);
    confirmButton.addEventListener("click", async () => {
      const profile = pendingProfile;
      if (!profile || confirmInput.value !== profile.name) return;
      confirmButton.disabled = true;
      confirmButton.textContent = t("deleteProfile.deleting");
      error.hidden = true;
      try {
        await ctx.api.deleteProfile(profile.id);
        close();
        await onDeleted();
        showToast(t("toast.vaultDeleted"));
      } catch (cause) {
        ctx.setError(error, errorText(cause, "errors.deleteVault"));
      } finally {
        confirmButton.textContent = t("deleteProfile.submit");
        confirmButton.disabled = !pendingProfile || confirmInput.value !== pendingProfile.name;
      }
    });

    return { open, close, get isOpen() { return dialog.open; } };
  }

  ns.features.profileManagement = { init };
})();
