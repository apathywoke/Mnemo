(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText, onChange } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const ICONS = Object.freeze({
    all: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/></svg>',
    manage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/></svg>',
  });

  // Folders, favorites, and the trash. Owns the scope menu above the list
  // (all items, favorites, a folder, the trash), the folders dialog, the
  // favorite and folder controls in a detail, and the banner on items in the
  // trash. Main keeps the data; this only shows it and sends changes.
  function init(ctx, { getEntry, refreshEntries, renderEntryList, renderEntryDetail, applySummary }) {
    const state = ctx.state.vault;
    const scopeButton = $("#scope-button");
    const scopeMenu = $("#scope-menu");
    const foldersDialog = $("#folders-dialog");
    const folderList = $("#folder-list");
    const folderInput = $("#folder-name-input");
    const foldersError = $("#folders-error");
    const folderSelect = $("#entry-folder-select");
    const favoriteButton = $("#favorite-button");
    const trashBanner = $("#trash-banner");
    const organizeBar = $("#detail-organize");
    const createButton = $("#create-entry-button");
    const emptyTrashButton = $("#empty-trash-button");
    let armedFolderDelete = null;
    let armedTimer = null;

    const inScope = (entry, scope) => ns.entities.login.inScope(entry, scope);
    const countIn = (scope) => state.entries.filter((entry) => inScope(entry, scope)).length;
    const folderById = (id) => state.folders.find((folder) => folder.id === id) ?? null;
    const formatDate = (timestamp) => new Intl.DateTimeFormat(ns.shared.i18n.language, { dateStyle: "medium" })
      .format(new Date(timestamp));

    // The list title for the scope, or null to use the type filter's title.
    function scopeTitle() {
      if (state.scope.kind === "favorites") return t("organize.favorites");
      if (state.scope.kind === "trash") return t("trash.title");
      if (state.scope.kind === "folder") return folderById(state.scope.folderId)?.name ?? null;
      return null;
    }

    function scopeEmptyText() {
      if (state.scope.kind === "favorites") return t("organize.favoritesEmpty");
      if (state.scope.kind === "trash") return t("trash.emptyList");
      if (state.scope.kind === "folder") return t("organize.folderEmpty");
      return "";
    }

    // A scope that points at a deleted folder falls back to all items.
    function checkScope() {
      if (state.scope.kind === "folder" && !folderById(state.scope.folderId)) {
        state.scope = { kind: "all" };
      }
      updateDock();
    }

    function updateDock() {
      const trash = state.scope.kind === "trash";
      createButton.hidden = trash;
      emptyTrashButton.hidden = !trash;
      emptyTrashButton.disabled = countIn({ kind: "trash" }) === 0;
    }

    function setScope(scope) {
      state.scope = scope;
      setMenuOpen(false);
      updateDock();
      renderEntryList();
      const selected = getEntry(state.selectedEntryId);
      if (selected && !inScope(selected, scope)) renderEntryDetail(null);
    }

    // When an item that is not in the current scope is selected on purpose
    // (just saved, restored, or opened from a report), show all items.
    function revealEntry(entry) {
      if (entry && !inScope(entry, state.scope)) {
        state.scope = entry.deletedAt ? { kind: "trash" } : { kind: "all" };
        updateDock();
      }
    }

    // --- Scope menu ---------------------------------------------------------

    function menuOption({ label, count = null, icon, selected = false, onSelect, role = "menuitemradio" }) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "new-item-option scope-option";
      option.setAttribute("role", role);
      if (role === "menuitemradio") option.setAttribute("aria-checked", String(selected));
      const glyph = document.createElement("span");
      glyph.className = "scope-option-icon";
      glyph.innerHTML = icon;
      const text = document.createElement("span");
      text.className = "scope-option-label";
      text.textContent = label;
      option.append(glyph, text);
      if (count !== null) {
        const number = document.createElement("span");
        number.className = "scope-option-count";
        number.textContent = String(count);
        option.append(number);
      }
      option.addEventListener("click", onSelect);
      return option;
    }

    function renderScopeMenu() {
      const scope = state.scope;
      const items = [
        menuOption({
          label: t("vault.allItems"),
          count: countIn({ kind: "all" }),
          icon: ICONS.all,
          selected: scope.kind === "all",
          onSelect: () => setScope({ kind: "all" }),
        }),
        menuOption({
          label: t("organize.favorites"),
          count: countIn({ kind: "favorites" }),
          icon: ICONS.star,
          selected: scope.kind === "favorites",
          onSelect: () => setScope({ kind: "favorites" }),
        }),
      ];
      const heading = document.createElement("p");
      heading.className = "scope-menu-label";
      heading.setAttribute("role", "presentation");
      heading.textContent = t("organize.folders");
      items.push(heading);
      for (const folder of state.folders) {
        const folderScope = { kind: "folder", folderId: folder.id };
        items.push(menuOption({
          label: folder.name,
          count: countIn(folderScope),
          icon: ICONS.folder,
          selected: scope.kind === "folder" && scope.folderId === folder.id,
          onSelect: () => setScope(folderScope),
        }));
      }
      items.push(menuOption({
        label: t(state.folders.length ? "folders.manage" : "folders.newFolder"),
        icon: ICONS.manage,
        role: "menuitem",
        onSelect: openFoldersDialog,
      }));
      const separator = document.createElement("hr");
      separator.className = "scope-menu-separator";
      items.push(separator);
      items.push(menuOption({
        label: t("trash.title"),
        count: countIn({ kind: "trash" }),
        icon: ICONS.trash,
        selected: scope.kind === "trash",
        onSelect: () => setScope({ kind: "trash" }),
      }));
      scopeMenu.replaceChildren(...items);
    }

    function setMenuOpen(open) {
      if (open) renderScopeMenu();
      scopeMenu.hidden = !open;
      scopeButton.setAttribute("aria-expanded", String(open));
      if (open) {
        (scopeMenu.querySelector("[aria-checked='true']") ?? scopeMenu.querySelector("[role^='menuitem']"))?.focus();
      }
    }

    scopeButton.addEventListener("click", () => setMenuOpen(scopeMenu.hidden));
    scopeMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        scopeButton.focus();
        return;
      }
      const options = [...scopeMenu.querySelectorAll("[role^='menuitem']")];
      const index = options.indexOf(document.activeElement);
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      options[(next + options.length) % options.length].focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!scopeMenu.hidden && !event.target.closest(".scope-picker")) setMenuOpen(false);
    });

    // --- Folders dialog -----------------------------------------------------

    async function reloadFolders() {
      await refreshEntries();
      renderFolderList();
    }

    function disarmDelete() {
      armedFolderDelete = null;
      clearTimeout(armedTimer);
    }

    function folderRow(folder) {
      const row = document.createElement("li");
      row.className = "folder-row";
      const icon = document.createElement("span");
      icon.className = "folder-row-icon";
      icon.innerHTML = ICONS.folder;
      const name = document.createElement("span");
      name.className = "folder-row-name";
      name.textContent = folder.name;
      const count = document.createElement("span");
      count.className = "folder-row-count";
      count.textContent = String(countIn({ kind: "folder", folderId: folder.id }));

      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "detail-action";
      rename.textContent = t("folders.rename");
      rename.addEventListener("click", () => startRename(row, folder));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "detail-action danger-action";
      remove.textContent = t(armedFolderDelete === folder.id ? "folders.confirmDelete" : "common.delete");
      remove.addEventListener("click", () => void deleteFolder(folder));

      row.append(icon, name, count, rename, remove);
      return row;
    }

    function renderFolderList() {
      folderList.replaceChildren(...state.folders.map(folderRow));
      $("#folders-empty").hidden = state.folders.length > 0;
    }

    function showFolderError(cause, fallback) {
      ctx.setError(foldersError, errorText(cause, fallback));
    }

    function startRename(row, folder) {
      disarmDelete();
      const form = document.createElement("form");
      form.className = "folder-rename";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 100;
      input.value = folder.name;
      input.setAttribute("aria-label", t("folders.renameLabel", { name: folder.name }));
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "detail-action";
      save.textContent = t("folders.save");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "detail-action";
      cancel.textContent = t("common.cancel");
      cancel.addEventListener("click", renderFolderList);
      input.addEventListener("keydown", (event) => {
        // Escape cancels the rename instead of closing the dialog.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          renderFolderList();
        }
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        foldersError.hidden = true;
        save.disabled = true;
        try {
          await ctx.api.renameFolder(folder.id, input.value);
          await reloadFolders();
        } catch (cause) {
          save.disabled = false;
          showFolderError(cause, "errors.saveFolder");
        }
      });
      form.append(input, save, cancel);
      row.replaceChildren(row.querySelector(".folder-row-icon"), form);
      input.focus();
      input.select();
    }

    // Two clicks: the first arms the button for a few seconds.
    async function deleteFolder(folder) {
      foldersError.hidden = true;
      if (armedFolderDelete !== folder.id) {
        disarmDelete();
        armedFolderDelete = folder.id;
        armedTimer = setTimeout(() => {
          disarmDelete();
          renderFolderList();
        }, 4000);
        renderFolderList();
        return;
      }
      disarmDelete();
      try {
        await ctx.api.deleteFolder(folder.id);
        await reloadFolders();
        showToast(t("toast.folderDeleted", { name: folder.name }));
      } catch (cause) {
        showFolderError(cause, "errors.saveFolder");
        renderFolderList();
      }
    }

    function openFoldersDialog() {
      setMenuOpen(false);
      disarmDelete();
      foldersError.hidden = true;
      folderInput.value = "";
      renderFolderList();
      foldersDialog.showModal();
      folderInput.focus();
    }

    $("#folder-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      foldersError.hidden = true;
      const button = event.currentTarget.querySelector("button[type='submit']");
      button.disabled = true;
      try {
        await ctx.api.createFolder(folderInput.value);
        folderInput.value = "";
        await reloadFolders();
      } catch (cause) {
        showFolderError(cause, "errors.saveFolder");
      } finally {
        button.disabled = false;
        folderInput.focus();
      }
    });
    $("#close-folders-dialog").addEventListener("click", () => foldersDialog.close());
    foldersDialog.addEventListener("close", () => {
      disarmDelete();
      folderList.replaceChildren();
    });

    // --- Detail controls ------------------------------------------------------

    function renderFolderSelect(entry) {
      const options = [new Option(t("organize.noFolder"), "")];
      for (const folder of state.folders) options.push(new Option(folder.name, folder.id));
      folderSelect.replaceChildren(...options);
      folderSelect.value = entry.folderId ?? "";
    }

    // Moves the shared controls into the shown detail `section` and fills
    // them for `entry` (a summary from the list).
    function attachDetail(section, entry) {
      const toolbar = section.querySelector(".detail-toolbar");
      toolbar.after(trashBanner);
      section.querySelector(".detail-title-block").after(organizeBar);
      const trashed = Boolean(entry.deletedAt);
      trashBanner.hidden = !trashed;
      for (const action of toolbar.querySelectorAll(".detail-action")) action.hidden = trashed;
      if (trashed) {
        $("#trash-banner-detail").textContent = t("trash.bannerDetail", {
          date: formatDate(entry.deletedAt + TRASH_RETENTION_MS),
        });
      }
      favoriteButton.hidden = trashed;
      favoriteButton.setAttribute("aria-pressed", String(entry.favorite === true));
      favoriteButton.querySelector("span").textContent = t(entry.favorite ? "organize.favorited" : "organize.favorite");
      folderSelect.closest(".folder-chip").hidden = trashed;
      renderFolderSelect(entry);
    }

    async function run(action, fallbackKey) {
      try {
        return await action();
      } catch (cause) {
        showToast(errorText(cause, fallbackKey), { type: "error" });
        return null;
      }
    }

    favoriteButton.addEventListener("click", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry || entry.deletedAt) return;
      favoriteButton.disabled = true;
      const summary = await run(() => ctx.api.setFavorite(entry.id, !entry.favorite), "errors.saveItem");
      favoriteButton.disabled = false;
      if (summary) applySummary(summary);
    });

    folderSelect.addEventListener("change", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry) return;
      const folderId = folderSelect.value || null;
      const summary = await run(() => ctx.api.setFolder(entry.id, folderId), "errors.saveItem");
      if (!summary) {
        renderFolderSelect(entry);
        return;
      }
      applySummary(summary);
      const folder = folderById(folderId);
      showToast(folder ? t("toast.movedToFolder", { name: folder.name }) : t("toast.removedFromFolder"));
    });

    // Deleting is undoable: the item goes to the trash, and the toast offers
    // to bring it back.
    async function moveToTrash() {
      const entry = getEntry(state.selectedEntryId);
      if (!entry || entry.deletedAt) return;
      const summary = await run(() => ctx.api.deleteEntry(entry.id), "errors.deleteLogin");
      if (!summary) return;
      state.selectedEntryId = null;
      await refreshEntries(null, true);
      showToast(t("toast.movedToTrash"), {
        type: "info",
        action: {
          label: t("trash.undo"),
          onClick: async () => {
            const restored = await run(() => ctx.api.restoreEntry(entry.id), "errors.deleteLogin");
            if (restored) await refreshEntries(entry.id);
          },
        },
      });
    }
    $("#delete-entry-button").addEventListener("click", () => void moveToTrash());
    $("#delete-item-button").addEventListener("click", () => void moveToTrash());

    $("#restore-entry-button").addEventListener("click", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry?.deletedAt) return;
      const summary = await run(() => ctx.api.restoreEntry(entry.id), "errors.deleteLogin");
      if (!summary) return;
      await refreshEntries(entry.id);
      showToast(t("toast.restoredFromTrash", { name: entry.name }));
    });

    $("#delete-forever-button").addEventListener("click", async () => {
      const entry = getEntry(state.selectedEntryId);
      if (!entry?.deletedAt) return;
      const result = await run(() => ctx.api.deleteForever(entry.id), "errors.deleteLogin");
      if (!result?.deleted) return;
      state.selectedEntryId = null;
      await refreshEntries(null, true);
      showToast(t("toast.deletedForever"));
    });

    emptyTrashButton.addEventListener("click", async () => {
      emptyTrashButton.disabled = true;
      const result = await run(() => ctx.api.emptyTrash(), "errors.deleteLogin");
      if (result?.deleted) {
        state.selectedEntryId = null;
        await refreshEntries(null, true);
        showToast(t("toast.trashEmptied", { count: result.deleted }));
      }
      updateDock();
    });

    function clear() {
      setMenuOpen(false);
      disarmDelete();
      if (foldersDialog.open) foldersDialog.close();
      state.scope = { kind: "all" };
      state.folders = [];
      folderSelect.replaceChildren();
      updateDock();
    }

    onChange(() => {
      if (!scopeMenu.hidden) renderScopeMenu();
      if (foldersDialog.open) renderFolderList();
    });

    return {
      attachDetail,
      checkScope,
      clear,
      revealEntry,
      scopeEmptyText,
      scopeTitle,
      updateDock,
      // New items created while a folder is open go into that folder.
      newItemFolderId: () => (state.scope.kind === "folder" ? state.scope.folderId : null),
    };
  }

  ns.features.organize = { init };
})();
