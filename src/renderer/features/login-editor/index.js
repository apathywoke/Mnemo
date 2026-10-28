(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { conceal } = ns.shared.passwordVisibility;
  const { show: showToast } = ns.shared.toast;
  const { t, errorText } = ns.shared.i18n;

  function init(ctx, { getEntry, refreshEntries, passwordGenerator }) {
    const form = $("#entry-form");
    const dialog = $("#entry-dialog");
    const passwordInput = $("#entry-password");
    const totpInput = $("#entry-totp");
    const removeTotp = $("#entry-remove-totp");
    removeTotp.addEventListener("change", () => {
      totpInput.disabled = removeTotp.checked;
      if (removeTotp.checked) totpInput.value = "";
    });
    const error = $("#entry-form-error");

    // The data-i18n key keeps the title correct if the language changes while
    // the dialog is open.
    function setTitle(key) {
      const title = $("#entry-dialog-title");
      title.dataset.i18n = key;
      title.textContent = t(key);
    }

    function clearForm() {
      form.reset();
      $("#entry-id").value = "";
      passwordInput.value = "";
      passwordInput.required = true;
      passwordInput.placeholder = "";
      passwordInput.removeAttribute("data-i18n-placeholder");
      totpInput.value = "";
      totpInput.dataset.i18nPlaceholder = "editor.totpPlaceholder";
      totpInput.placeholder = t("editor.totpPlaceholder");
      $("#entry-remove-totp").checked = false;
      $("#entry-remove-totp-field").hidden = true;
      totpInput.disabled = false;
      conceal(form);
      error.hidden = true;
      $("#password-length-value").value = $("#password-length").value;
      passwordGenerator.updatePasswordStrength();
      passwordGenerator.updateGeneratedPasswordStrength();
    }

    function openNew() {
      clearForm();
      setTitle("editor.titleNew");
      dialog.showModal();
      $("#entry-name").focus();
    }

    async function openEdit() {
      const summary = getEntry(ctx.state.vault.selectedEntryId);
      if (!summary) return;
      let entry;
      try {
        entry = await ctx.api.getEntry(summary.id);
      } catch (cause) {
        showToast(errorText(cause, "errors.openLogin"), { type: "error" });
        return;
      }
      if (ctx.state.vault.selectedEntryId !== entry.id) return;
      clearForm();
      setTitle("editor.titleEdit");
      $("#entry-id").value = entry.id;
      $("#entry-name").value = entry.name;
      $("#entry-url").value = entry.url;
      $("#entry-username").value = entry.username;
      // The current password stays in the main process; leaving the field
      // empty keeps it.
      passwordInput.required = false;
      passwordInput.dataset.i18nPlaceholder = "editor.keepPassword";
      passwordInput.placeholder = t("editor.keepPassword");
      $("#entry-notes").value = entry.notes;
      // Like the password, the TOTP secret stays in main: blank keeps it.
      if (entry.hasTotp) {
        totpInput.dataset.i18nPlaceholder = "editor.totpKeep";
        totpInput.placeholder = t("editor.totpKeep");
        $("#entry-remove-totp-field").hidden = false;
      }
      conceal(form);
      passwordGenerator.updatePasswordStrength();
      dialog.showModal();
      $("#entry-name").focus();
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(form);
      error.hidden = true;
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = t("common.saving");
      const wasEditing = Boolean($("#entry-id").value);
      // A new login made while a folder is open goes into that folder.
      const folderId = wasEditing ? null : ctx.organize?.newItemFolderId();
      try {
        const savedEntry = await ctx.api.saveEntry({
          ...(folderId ? { folderId } : {}),
          id: $("#entry-id").value,
          name: $("#entry-name").value,
          username: $("#entry-username").value,
          password: passwordInput.value,
          url: $("#entry-url").value,
          notes: $("#entry-notes").value,
          totp: removeTotp.checked ? "" : totpInput.value,
          removeTotp: removeTotp.checked,
        });
        dialog.close();
        await refreshEntries(savedEntry.id);
        showToast(t(wasEditing ? "toast.loginUpdated" : "toast.loginSaved"));
      } catch (cause) {
        ctx.setError(error, errorText(cause, "errors.saveLogin"));
      } finally {
        button.disabled = false;
        button.textContent = t("editor.save");
      }
    });

    $("#empty-create-button").addEventListener("click", openNew);
    $("#edit-entry-button").addEventListener("click", openEdit);
    $("#cancel-entry-button").addEventListener("click", () => dialog.close());
    $("#close-entry-dialog").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", clearForm);

    return { clearForm, openNew, openEdit };
  }

  ns.features.loginEditor = { init };
})();
