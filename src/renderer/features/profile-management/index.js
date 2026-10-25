(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

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
      confirmButton.textContent = "Delete vault";
    }

    function open(profile) {
      pendingProfile = { id: profile.id, name: profile.name };
      $("#delete-profile-name-confirm").textContent = profile.name;
      confirmInput.value = "";
      error.hidden = true;
      confirmButton.disabled = true;
      confirmButton.textContent = "Delete vault";
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
      confirmButton.textContent = "Deleting…";
      error.hidden = true;
      try {
        await ctx.api.deleteProfile(profile.id);
        close();
        await onDeleted();
      } catch (cause) {
        ctx.setError(error, cause.message || "Could not delete this vault.");
      } finally {
        confirmButton.textContent = "Delete vault";
        confirmButton.disabled = !pendingProfile || confirmInput.value !== pendingProfile.name;
      }
    });

    return { open, close, get isOpen() { return dialog.open; } };
  }

  ns.features.profileManagement = { init };
})();
