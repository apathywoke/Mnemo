(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;
  const { t, errorText } = ns.shared.i18n;

  function init(ctx, { getEntry, refreshEntries, renderEntryList, renderEntryDetail, updateSiteIconButton }) {
    const state = ctx.state.vault;

    async function copyField(entryId, field) {
      try {
        await ctx.api.copyEntryField(entryId, field);
        showToast(t("toast.copied"));
      } catch (cause) {
        showToast(errorText(cause, "errors.copyValue"), { type: "error" });
      }
    }

    // The main process shows the password in a native dialog; it is not
    // returned to this renderer.
    $("#toggle-password-button").addEventListener("click", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry) return;
      try {
        await ctx.api.revealPassword(entry.id);
      } catch (cause) {
        showToast(errorText(cause, "errors.showPassword"), { type: "error" });
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
          showToast(t("toast.iconSaved", { hostname: result.hostname }));
        }
      } catch (cause) {
        if (state.selectedEntryId === requestedEntry.id) {
          showToast(errorText(cause, "errors.loadIcon"), { type: "error" });
        }
      } finally {
        state.fetchingFaviconForId = null;
        updateSiteIconButton();
      }
    });
  }

  ns.features.loginActions = { init };
})();
