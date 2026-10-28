(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText } = ns.shared.i18n;

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
      totpField: $("#detail-totp-field"),
      copyUsername: $("#copy-username-button"),
    };

    const itemUi = {
      detail: $("#item-detail"),
      kind: $("#item-detail-kind"),
      icon: $("#item-detail-icon"),
      name: $("#item-detail-name"),
      subtitle: $("#item-detail-subtitle"),
      fields: $("#item-detail-fields"),
    };
    const { show: showToast } = ns.shared.toast;

    const getEntry = (id) => ns.entities.login.getById(state.entries, id);
    const totpCode = ns.features.totpCode.init(ctx);

    function renderEntryList() {
      ns.entities.login.renderList({
        entries: state.entries,
        selectedId: state.selectedEntryId,
        query: $("#entry-search").value,
        container: list,
        count: $("#entry-count"),
        empty: $("#empty-list"),
        noResults: $("#no-search-results"),
        typeFilter: state.typeFilter,
        onSelect: renderEntryDetail,
      });
      $("#entry-list-title").textContent = t(
        state.typeFilter === "all" ? "vault.allItems" : `vault.filter${state.typeFilter[0].toUpperCase()}${state.typeFilter.slice(1)}`,
      ).toLocaleUpperCase();
    }

    // Cards, notes, identities, and SSH keys: details (without secrets) are
    // loaded when the item is selected.
    async function loadItemDetail(id) {
      try {
        const details = await ctx.api.getEntry(id);
        if (state.selectedEntryId !== id) return;
        ns.entities.login.renderItemDetail(details, itemUi, {
          onCopy: (field) => void copyItemField(id, field),
          onReveal: (field) => void revealItemField(id, field),
        });
      } catch {
        // The vault may have locked meanwhile.
      }
    }

    async function copyItemField(id, field) {
      try {
        await ctx.api.copyEntryField(id, field);
        showToast(t("toast.copied"));
      } catch (cause) {
        showToast(errorText(cause, "errors.copyValue"), { type: "error" });
      }
    }

    async function revealItemField(id, field) {
      try {
        await ctx.api.revealField(id, field);
      } catch (cause) {
        showToast(errorText(cause, "errors.showPassword"), { type: "error" });
      }
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
      reports.hide();
      const entry = getEntry(id);
      if (!entry) {
        state.selectedEntryId = null;
        state.selectedEntryNotes = "";
        ns.entities.login.renderDetail(null, detailUi, { updateSiteIconButton });
        itemUi.detail.hidden = true;
        totpCode.stop();
        renderEntryList();
        return;
      }
      if (entry.type && entry.type !== "login") {
        const changed = state.selectedEntryId !== entry.id;
        state.selectedEntryId = entry.id;
        state.selectedEntryNotes = "";
        totpCode.stop();
        detailUi.detail.hidden = true;
        detailUi.empty.hidden = true;
        if (changed) itemUi.fields.replaceChildren();
        renderEntryList();
        void loadItemDetail(entry.id);
        return;
      }
      itemUi.detail.hidden = true;
      const notes = state.selectedEntryId === entry.id ? state.selectedEntryNotes : "";
      const needsNotes = state.selectedEntryId !== entry.id;
      state.selectedEntryId = entry.id;
      state.selectedEntryNotes = notes;
      ns.entities.login.renderDetail(entry, detailUi, { notes, updateSiteIconButton });
      totpCode.follow(entry);
      renderEntryList();
      if (needsNotes) void loadSelectedNotes(entry.id);
    }

    async function refreshEntries(preferredId = null, selectFirst = false) {
      state.entries = await ctx.api.listEntries();
      // The entry may have a new or removed one-time code; start over.
      totpCode.stop();
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
        itemUi.detail.hidden = true;
        detailUi.empty.hidden = reports.isOpen();
      }
    }

    function clear() {
      reports.clear();
      totpCode.stop();
      itemUi.detail.hidden = true;
      itemUi.fields.replaceChildren();
      itemEditor.close();
      newItemMenu.hidden = true;
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
    const itemEditor = ns.features.itemEditor.init(ctx, { refreshEntries });
    const reports = ns.features.passwordHealth.init(ctx, {
      getEntry,
      openEntry: renderEntryDetail,
      deselect() {
        state.selectedEntryId = null;
        state.selectedEntryNotes = "";
        totpCode.stop();
        renderEntryList();
      },
    });

    // "+ New item" opens a menu of item types.
    const newItemButton = $("#create-entry-button");
    const newItemMenu = $("#new-item-menu");
    function setMenuOpen(open) {
      newItemMenu.hidden = !open;
      newItemButton.setAttribute("aria-expanded", String(open));
      if (open) newItemMenu.querySelector("[role='menuitem']").focus();
    }
    newItemButton.addEventListener("click", () => setMenuOpen(newItemMenu.hidden));
    for (const option of newItemMenu.querySelectorAll("[data-new-item]")) {
      option.addEventListener("click", () => {
        setMenuOpen(false);
        const type = option.dataset.newItem;
        if (type === "login") editor.openNew();
        else itemEditor.open(type);
      });
    }
    newItemMenu.addEventListener("keydown", (event) => {
      const options = [...newItemMenu.querySelectorAll("[role='menuitem']")];
      const index = options.indexOf(document.activeElement);
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      options[(next + options.length) % options.length].focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!newItemMenu.hidden && !event.target.closest(".new-item")) setMenuOpen(false);
    });

    // Type filter above the list.
    for (const option of document.querySelectorAll("[data-type-filter]")) {
      option.addEventListener("click", () => {
        state.typeFilter = option.dataset.typeFilter;
        for (const other of document.querySelectorAll("[data-type-filter]")) {
          other.setAttribute("aria-checked", String(other === option));
        }
        renderEntryList();
      });
    }

    $("#edit-item-button").addEventListener("click", async () => {
      const id = state.selectedEntryId;
      try {
        const details = await ctx.api.getEntry(id);
        if (state.selectedEntryId === id) itemEditor.open(details.type, details);
      } catch (cause) {
        showToast(errorText(cause, "errors.openLogin"), { type: "error" });
      }
    });
    $("#delete-item-button").addEventListener("click", () => {
      if (getEntry(state.selectedEntryId)) $("#delete-dialog").showModal();
    });

    $("#entry-search").addEventListener("input", renderEntryList);
    ns.shared.i18n.onChange(() => {
      renderEntryList();
      updateSiteIconButton();
      const selected = getEntry(state.selectedEntryId);
      if (selected && selected.type !== "login") void loadItemDetail(selected.id);
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
