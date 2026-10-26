(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;

  function init(ctx, { getEntry, refreshEntries, renderEntryList, renderEntryDetail, updateSiteIconButton }) {
    const state = ctx.state.vault;
    const deleteDialog = $("#delete-dialog");

    async function copyField(entryId, field) {
      try {
        await ctx.api.copyEntryField(entryId, field);
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

    // The main process shows the password in a native dialog; it is not
    // returned to this renderer.
    $("#toggle-password-button").addEventListener("click", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry) return;
      try {
        await ctx.api.revealPassword(entry.id);
      } catch (cause) {
        showToast(cause.message || "Could not show this password.", { type: "error" });
      }
    });
    $("#copy-username-button").addEventListener("click", () => {
      const entry = getEntry(state.selectedEntryId);
      if (entry?.username) void copyField(entry.id, "username");
    });
    $("#copy-password-button").addEventListener("click", () => {
      const entry = getEntry(state.selectedEntryId);
      if (entry) void copyField(entry.id, "password");
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
