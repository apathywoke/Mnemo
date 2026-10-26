(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { conceal } = ns.shared.passwordVisibility;
  const { show: showToast } = ns.shared.toast;

  function init(ctx, { getEntry, refreshEntries, passwordGenerator }) {
    const form = $("#entry-form");
    const dialog = $("#entry-dialog");
    const passwordInput = $("#entry-password");
    const error = $("#entry-form-error");

    function clearForm() {
      form.reset();
      $("#entry-id").value = "";
      passwordInput.value = "";
      conceal(form);
      error.hidden = true;
      $("#password-length-value").value = $("#password-length").value;
      passwordGenerator.updatePasswordStrength();
      passwordGenerator.updateGeneratedPasswordStrength();
    }

    function openNew() {
      clearForm();
      $("#entry-dialog-title").textContent = "New login";
      dialog.showModal();
      $("#entry-name").focus();
    }

    function openEdit() {
      const entry = getEntry(ctx.state.vault.selectedEntryId);
      if (!entry) return;
      clearForm();
      $("#entry-dialog-title").textContent = "Edit login";
      $("#entry-id").value = entry.id;
      $("#entry-name").value = entry.name;
      $("#entry-url").value = entry.url;
      $("#entry-username").value = entry.username;
      passwordInput.value = entry.password;
      $("#entry-notes").value = entry.notes;
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
      button.textContent = "Saving…";
      const wasEditing = Boolean($("#entry-id").value);
      try {
        const savedEntry = await ctx.api.saveEntry({
          id: $("#entry-id").value,
          name: $("#entry-name").value,
          username: $("#entry-username").value,
          password: passwordInput.value,
          url: $("#entry-url").value,
          notes: $("#entry-notes").value,
        });
        dialog.close();
        await refreshEntries(savedEntry.id);
        showToast(wasEditing ? "Login updated." : "Login saved.");
      } catch (cause) {
        ctx.setError(error, cause.message || "Could not save this login.");
      } finally {
        button.disabled = false;
        button.textContent = "Save login";
      }
    });

    $("#create-entry-button").addEventListener("click", openNew);
    $("#empty-create-button").addEventListener("click", openNew);
    $("#edit-entry-button").addEventListener("click", openEdit);
    $("#cancel-entry-button").addEventListener("click", () => dialog.close());
    $("#close-entry-dialog").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", clearForm);

    return { clearForm, openNew, openEdit };
  }

  ns.features.loginEditor = { init };
})();
