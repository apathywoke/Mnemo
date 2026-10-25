(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { setToggleButton } = ns.shared.passwordVisibility;

  function init(ctx, { getEntry, refreshEntries, renderEntryList, renderEntryDetail, updateSiteIconButton }) {
    const state = ctx.state.vault;
    const copyStatus = $("#copy-status");
    const deleteDialog = $("#delete-dialog");

    async function copyValue(value) {
      if (!value) return;
      try {
        await ctx.api.copySecret(value);
        copyStatus.textContent = "Copied. Clipboard clears in 30 seconds.";
        copyStatus.hidden = false;
        if (ctx.state.ui.copyStatusTimer) clearTimeout(ctx.state.ui.copyStatusTimer);
        ctx.state.ui.copyStatusTimer = setTimeout(() => { copyStatus.hidden = true; }, 4000);
      } catch {
        copyStatus.textContent = "Could not copy this value.";
        copyStatus.hidden = false;
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
      } catch (cause) {
        deleteDialog.close();
        copyStatus.textContent = cause.message || "Could not delete this login.";
        copyStatus.hidden = false;
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
      copyStatus.hidden = true;
      try {
        const result = await ctx.api.fetchSiteIcon(requestedEntry.id);
        if (result.canceled) return;
        state.entries = state.entries.map((entry) =>
          entry.id === result.entry.id ? result.entry : entry,
        );
        renderEntryList();
        if (state.selectedEntryId === requestedEntry.id) {
          renderEntryDetail(requestedEntry.id);
          copyStatus.textContent = `Icon from ${result.hostname} saved inside the encrypted vault.`;
          copyStatus.hidden = false;
        }
      } catch (cause) {
        if (state.selectedEntryId === requestedEntry.id) {
          copyStatus.textContent = cause.message || "Could not load the site icon.";
          copyStatus.hidden = false;
        }
      } finally {
        state.fetchingFaviconForId = null;
        updateSiteIconButton();
      }
    });
  }

  ns.features.loginActions = { init };
})();
