(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

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
        ? "Loading…"
        : entry?.favicon
          ? "Update icon"
          : "Load site icon";
    }

    function renderEntryDetail(id) {
      const entry = getEntry(id);
      if (!entry) {
        state.selectedEntryId = null;
        state.passwordVisible = false;
        ns.entities.login.renderDetail(null, detailUi, {
          passwordVisible: false,
          updateSiteIconButton,
        });
        renderEntryList();
        return;
      }
      state.selectedEntryId = entry.id;
      state.passwordVisible = false;
      ns.entities.login.renderDetail(entry, detailUi, {
        passwordVisible: false,
        updateSiteIconButton,
      });
      ns.shared.passwordVisibility.setToggleButton($("#toggle-password-button"), false);
      $("#copy-status").hidden = true;
      renderEntryList();
    }

    async function refreshEntries(preferredId = null, selectFirst = false) {
      state.entries = await ctx.api.getEntries();
      const nextId = preferredId && getEntry(preferredId)
        ? preferredId
        : state.selectedEntryId && getEntry(state.selectedEntryId)
          ? state.selectedEntryId
          : selectFirst
            ? state.entries[0]?.id ?? null
            : null;
      renderEntryList();
      if (nextId) renderEntryDetail(nextId);
      else {
        state.selectedEntryId = null;
        state.passwordVisible = false;
        detailUi.detail.hidden = true;
        detailUi.empty.hidden = false;
      }
    }

    function clear() {
      state.entries = [];
      state.selectedEntryId = null;
      state.passwordVisible = false;
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
