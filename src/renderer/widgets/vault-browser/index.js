(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t } = ns.shared.i18n;

  function create(ctx) {
    const state = ctx.state.vault;
    const list = $("#entry-list");
    const detailUi = {
      detail: $("#entry-detail"),
      empty: $("#detail-empty"),
      icon: $("#detail-icon"),
      name: $("#detail-name"),
      url: $("#detail-url"),
      username: $("#detail-username"),
      password: $("#detail-password"),
      notes: $("#detail-notes"),
      notesField: $("#detail-notes-field"),
      copyUsername: $("#copy-username-button"),
    };

    const getEntry = (id) => ns.entities.login.getById(state.entries, id);

    function renderEntryList() {
      ns.entities.login.renderList({
        entries: state.entries,
        selectedId: state.selectedEntryId,
        query: $("#entry-search").value,
        container: list,
        count: $("#entry-count"),
        empty: $("#empty-list"),
        noResults: $("#no-search-results"),
        onSelect: renderEntryDetail,
      });
    }

    function updateSiteIconButton(entry = getEntry(state.selectedEntryId)) {
      const button = $("#fetch-site-icon-button");
      button.disabled = !entry?.url || state.fetchingFaviconForId !== null;
      button.textContent = state.fetchingFaviconForId === state.selectedEntryId
        ? t("detail.loadingIcon")
        : entry?.favicon
          ? t("detail.updateIcon")
          : t("detail.loadIcon");
    }

    async function loadSelectedNotes(id) {
      try {
        const details = await ctx.api.getEntry(id);
        if (state.selectedEntryId !== id) return;
        state.selectedEntryNotes = details.notes;
        ns.entities.login.renderDetail(getEntry(id), detailUi, {
          notes: details.notes,
          updateSiteIconButton,
        });
      } catch {
        // The list stays usable; the vault may have locked meanwhile.
      }
    }

    function renderEntryDetail(id) {
      const entry = getEntry(id);
      if (!entry) {
        state.selectedEntryId = null;
        state.selectedEntryNotes = "";
        ns.entities.login.renderDetail(null, detailUi, { updateSiteIconButton });
        renderEntryList();
        return;
      }
      const notes = state.selectedEntryId === entry.id ? state.selectedEntryNotes : "";
      const needsNotes = state.selectedEntryId !== entry.id;
      state.selectedEntryId = entry.id;
      state.selectedEntryNotes = notes;
      ns.entities.login.renderDetail(entry, detailUi, { notes, updateSiteIconButton });
      renderEntryList();
      if (needsNotes) void loadSelectedNotes(entry.id);
    }

    async function refreshEntries(preferredId = null, selectFirst = false) {
      state.entries = await ctx.api.listEntries();
      const previousId = state.selectedEntryId;
      // Saved entries may have changed notes; clearing the selection makes
      // renderEntryDetail fetch them again.
      state.selectedEntryId = null;
      const nextId = preferredId && getEntry(preferredId)
        ? preferredId
        : previousId && getEntry(previousId)
          ? previousId
          : selectFirst
            ? state.entries[0]?.id ?? null
            : null;
      renderEntryList();
      if (nextId) renderEntryDetail(nextId);
      else {
        state.selectedEntryNotes = "";
        detailUi.detail.hidden = true;
        detailUi.empty.hidden = false;
      }
    }

    function clear() {
      state.entries = [];
      state.selectedEntryId = null;
      state.selectedEntryNotes = "";
      state.fetchingFaviconForId = null;
      $("#entry-search").value = "";
      renderEntryList();
      updateSiteIconButton(null);
    }

    const passwordGenerator = ns.features.passwordGenerator.init(ctx);
    const editor = ns.features.loginEditor.init(ctx, {
      getEntry,
      refreshEntries,
      passwordGenerator,
    });
    ns.features.loginActions.init(ctx, {
      getEntry,
      refreshEntries,
      renderEntryList,
      renderEntryDetail,
      updateSiteIconButton,
    });
    $("#entry-search").addEventListener("input", renderEntryList);
    ns.shared.i18n.onChange(() => {
      renderEntryList();
      updateSiteIconButton();
    });

    return {
      clear,
      getEntry,
      refreshEntries,
      renderEntryList,
      renderEntryDetail,
      updatePasswordStrength: passwordGenerator.updatePasswordStrength,
      clearEntryForm: editor.clearForm,
    };
  }

  ns.widgets.vaultBrowser = { create };
})();
