(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { setToggleButton } = ns.shared.passwordVisibility;
  const { show: showToast } = ns.shared.toast;

  function init(ctx, { getEntry, refreshEntries, renderEntryList, renderEntryDetail, updateSiteIconButton }) {
    const state = ctx.state.vault;
    const deleteDialog = $("#delete-dialog");

    async function copyValue(value) {
      if (!value) return;
      try {
        await ctx.api.copySecret(value);
        showToast("Copied. Clipboard clears in 30 seconds.");
      } catch {
        showToast("Could not copy this value.", { type: "error" });
      }
    }

    $("#delete-entry-button").addEventListener("click", () => {
      if (getEntry(state.selectedEntryId)) deleteDialog.showModal();
    });
    $("#cancel-delete-button").addEventListener("click", () => deleteDialog.close());
    $("#confirm-delete-button").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const deletedId = state.selectedEntryId;
      button.disabled = true;
      try {
        await ctx.api.deleteEntry(deletedId);
        deleteDialog.close();
        state.selectedEntryId = null;
        await refreshEntries(null, true);
        showToast("Login deleted.");
      } catch (cause) {
        deleteDialog.close();
        showToast(cause.message || "Could not delete this login.", { type: "error" });
      } finally {
        button.disabled = false;
      }
    });

    $("#toggle-password-button").addEventListener("click", () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry) return;
      state.passwordVisible = !state.passwordVisible;
      $("#detail-password").textContent = state.passwordVisible ? entry.password : "••••••••••••";
      setToggleButton($("#toggle-password-button"), state.passwordVisible);
    });
    $("#copy-username-button").addEventListener("click", () => {
      const entry = getEntry(state.selectedEntryId);
      if (entry) void copyValue(entry.username);
    });
    $("#copy-password-button").addEventListener("click", () => {
      const entry = getEntry(state.selectedEntryId);
      if (entry) void copyValue(entry.password);
    });

    $("#fetch-site-icon-button").addEventListener("click", async () => {
      const requestedEntry = getEntry(state.selectedEntryId);
      if (!requestedEntry?.url || state.fetchingFaviconForId !== null) return;
      state.fetchingFaviconForId = requestedEntry.id;
      updateSiteIconButton();
      try {
        const result = await ctx.api.fetchSiteIcon(requestedEntry.id);
        if (result.canceled) return;
        state.entries = state.entries.map((entry) =>
          entry.id === result.entry.id ? result.entry : entry,
        );
        renderEntryList();
        if (state.selectedEntryId === requestedEntry.id) {
          renderEntryDetail(requestedEntry.id);
          showToast("Icon from " + result.hostname + " saved inside the encrypted vault.");
        }
      } catch (cause) {
        if (state.selectedEntryId === requestedEntry.id) {
          showToast(cause.message || "Could not load the site icon.", { type: "error" });
        }
      } finally {
        state.fetchingFaviconForId = null;
        updateSiteIconButton();
      }
    });
  }

  ns.features.loginActions = { init };
})();
