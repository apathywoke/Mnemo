import * as loginModel from "../../entities/login/model/login.js";
import * as itemDetail from "../../entities/login/ui/item-detail.js";
import * as loginDetail from "../../entities/login/ui/login-detail.js";
import * as loginList from "../../entities/login/ui/login-list.js";
import * as attachmentsFeature from "../../features/attachments/index.js";
import * as historyFeature from "../../features/history/index.js";
import * as itemEditorFeature from "../../features/item-editor/index.js";
import * as loginActionsFeature from "../../features/login-actions/index.js";
import * as loginEditorFeature from "../../features/login-editor/index.js";
import * as organizeFeature from "../../features/organize/index.js";
import * as passwordGeneratorFeature from "../../features/password-generator/index.js";
import * as passwordHealthFeature from "../../features/password-health/index.js";
import * as totpCodeFeature from "../../features/totp-code/index.js";
import { $ } from "../../shared/lib/dom.js";
import { t, errorText, onChange } from "../../shared/lib/i18n.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";

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
    notesReveal: $("#detail-notes-reveal"),
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

  const getEntry = (id) => loginModel.getById(state.entries, id);
  const totpCode = totpCodeFeature.init(ctx);
  // Set up below, once the functions they call exist.
  let organize = null;
  let attachments = null;
  let history = null;

  function renderEntryList() {
    loginList.renderList({
      entries: state.entries,
      selectedId: state.selectedEntryId,
      query: $("#entry-search").value,
      container: list,
      count: $("#entry-count"),
      empty: $("#empty-list"),
      noResults: $("#no-search-results"),
      typeFilter: state.typeFilter,
      scope: state.scope,
      scopeEmptyText: organize?.scopeEmptyText() ?? "",
      onSelect: renderEntryDetail,
    });
    const typeTitle = t(
      state.typeFilter === "all" ? "vault.allItems" : `vault.filter${state.typeFilter[0].toUpperCase()}${state.typeFilter.slice(1)}`,
    );
    $("#entry-list-title").textContent = (organize?.scopeTitle() ?? typeTitle).toLocaleUpperCase();
    organize?.updateDock();
  }

  // Folder, favorite, trash, attachments, and history for the shown item.
  function showSharedDetail(section, entry, details = null) {
    organize.attachDetail(section, entry);
    if (details) {
      attachments.render(section, details);
      history.render(details);
    }
  }

  // A summary changed by an action in the detail (favorite, folder).
  function applySummary(summary) {
    state.entries = state.entries.map((entry) => (entry.id === summary.id ? summary : entry));
    renderEntryList();
    if (state.selectedEntryId === summary.id) {
      organize.attachDetail(summary.type === "login" ? detailUi.detail : itemUi.detail, summary);
    }
  }

  // Cards, notes, identities, and SSH keys: details (without secrets) are
  // loaded when the item is selected. Notes and a secure note's text come
  // only when the user chooses Show (`revealed`).
  async function loadItemDetail(id, revealed = null) {
    try {
      const details = await ctx.api.getEntry(id);
      if (state.selectedEntryId !== id) return;
      itemDetail.renderItemDetail(details, itemUi, {
        onCopy: (field) => void copyItemField(id, field),
        onReveal: (field) => void revealItemField(id, field),
        revealed,
        onRevealText: () => void revealItemText(id),
      });
      showSharedDetail(itemUi.detail, getEntry(id) ?? details, details);
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

  // Main answers only right after the click on Show (notes-reveal.js).
  async function revealItemText(id) {
    try {
      const revealed = await ctx.api.revealNotes(id);
      if (state.selectedEntryId === id) await loadItemDetail(id, revealed);
    } catch (cause) {
      showToast(errorText(cause, "errors.showNotes"), { type: "error" });
    }
  }

  async function revealSelectedNotes() {
    const id = state.selectedEntryId;
    try {
      const revealed = await ctx.api.revealNotes(id);
      if (state.selectedEntryId !== id) return;
      state.selectedEntryNotes = revealed.notes;
      loginDetail.renderDetail(getEntry(id), detailUi, {
        notes: revealed.notes,
        hasNotes: state.selectedEntryHasNotes,
        updateSiteIconButton,
      });
    } catch (cause) {
      showToast(errorText(cause, "errors.showNotes"), { type: "error" });
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
      // Notes are only flagged here; Show reveals them.
      state.selectedEntryHasNotes = details.hasNotes;
      loginDetail.renderDetail(getEntry(id), detailUi, {
        notes: state.selectedEntryNotes,
        hasNotes: details.hasNotes,
        updateSiteIconButton,
      });
      showSharedDetail(detailUi.detail, getEntry(id), details);
    } catch {
      // The list stays usable; the vault may have locked meanwhile.
    }
  }

  function renderEntryDetail(id) {
    reports.hide();
    const entry = getEntry(id);
    if (!entry || entry.id !== state.selectedEntryId) {
      // Attachments and history load with the item's details.
      attachments.hide();
      history.hide();
    }
    if (!entry) {
      state.selectedEntryId = null;
      state.selectedEntryNotes = "";
      state.selectedEntryHasNotes = false;
      loginDetail.renderDetail(null, detailUi, { updateSiteIconButton });
      itemUi.detail.hidden = true;
      totpCode.stop();
      renderEntryList();
      return;
    }
    if (entry.type && entry.type !== "login") {
      const changed = state.selectedEntryId !== entry.id;
      state.selectedEntryId = entry.id;
      state.selectedEntryNotes = "";
      state.selectedEntryHasNotes = false;
      totpCode.stop();
      detailUi.detail.hidden = true;
      detailUi.empty.hidden = true;
      if (changed) itemUi.fields.replaceChildren();
      renderEntryList();
      void loadItemDetail(entry.id);
      return;
    }
    itemUi.detail.hidden = true;
    const same = state.selectedEntryId === entry.id;
    const notes = same ? state.selectedEntryNotes : "";
    const hasNotes = same && state.selectedEntryHasNotes;
    state.selectedEntryId = entry.id;
    state.selectedEntryNotes = notes;
    state.selectedEntryHasNotes = hasNotes;
    loginDetail.renderDetail(entry, detailUi, { notes, hasNotes, updateSiteIconButton });
    organize.attachDetail(detailUi.detail, entry);
    totpCode.follow(entry);
    renderEntryList();
    // Notes, attachments, and history come with the details.
    void loadSelectedNotes(entry.id);
  }

  async function refreshEntries(preferredId = null, selectFirst = false) {
    const [entries, folders] = await Promise.all([ctx.api.listEntries(), ctx.api.listFolders()]);
    state.entries = entries;
    state.folders = folders;
    organize.checkScope();
    // The entry may have a new or removed one-time code; start over.
    totpCode.stop();
    const previousId = state.selectedEntryId;
    // Saved entries may have changed notes; clearing the selection makes
    // renderEntryDetail fetch them again.
    state.selectedEntryId = null;
    if (preferredId) organize.revealEntry(getEntry(preferredId));
    const visible = () => loginModel.filter(state.entries, $("#entry-search").value, state.typeFilter, state.scope);
    const nextId = preferredId && getEntry(preferredId)
      ? preferredId
      : previousId && getEntry(previousId)
        ? previousId
        : selectFirst
          ? visible()[0]?.id ?? null
          : null;
    renderEntryList();
    if (nextId) renderEntryDetail(nextId);
    else {
      state.selectedEntryNotes = "";
      state.selectedEntryHasNotes = false;
      detailUi.detail.hidden = true;
      itemUi.detail.hidden = true;
      detailUi.empty.hidden = reports.isOpen();
    }
  }

  function clear() {
    reports.clear();
    organize.clear();
    attachments.hide();
    history.hide();
    totpCode.stop();
    itemUi.detail.hidden = true;
    itemUi.fields.replaceChildren();
    itemEditor.close();
    newItemMenu.hidden = true;
    state.entries = [];
    state.selectedEntryId = null;
    state.selectedEntryNotes = "";
    state.selectedEntryHasNotes = false;
    state.fetchingFaviconForId = null;
    $("#entry-search").value = "";
    renderEntryList();
    updateSiteIconButton(null);
  }

  const passwordGenerator = passwordGeneratorFeature.init(ctx);
  const editor = loginEditorFeature.init(ctx, {
    getEntry,
    refreshEntries,
    passwordGenerator,
  });
  loginActionsFeature.init(ctx, {
    getEntry,
    renderEntryList,
    renderEntryDetail,
    updateSiteIconButton,
  });
  const itemEditor = itemEditorFeature.init(ctx, { refreshEntries });
  organize = organizeFeature.init(ctx, {
    getEntry,
    refreshEntries,
    renderEntryList,
    renderEntryDetail,
    applySummary,
  });
  ctx.organize = organize;
  attachments = attachmentsFeature.init(ctx, { refreshEntries });
  history = historyFeature.init(ctx, { refreshEntries });
  const reports = passwordHealthFeature.init(ctx, {
    getEntry,
    openEntry: renderEntryDetail,
    deselect() {
      state.selectedEntryId = null;
      state.selectedEntryNotes = "";
      state.selectedEntryHasNotes = false;
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
    if (!newItemMenu.hidden && !/** @type {Element} */ (event.target).closest(".new-item")) setMenuOpen(false);
  });

  // Type filter above the list.
  for (const option of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-type-filter]"))) {
    option.addEventListener("click", () => {
      state.typeFilter = option.dataset.typeFilter;
      for (const other of document.querySelectorAll("[data-type-filter]")) {
        other.setAttribute("aria-checked", String(other === option));
      }
      renderEntryList();
    });
  }

  // The editor needs the item's notes and sealed text, so opening it reveals
  // them (the click on Edit allows it). Without them the editor stays
  // closed: saving would otherwise clear them.
  $("#edit-item-button").addEventListener("click", async () => {
    const id = state.selectedEntryId;
    let details;
    try {
      details = await ctx.api.getEntry(id);
    } catch (cause) {
      showToast(errorText(cause, "errors.openLogin"), { type: "error" });
      return;
    }
    let revealed = { notes: "", fields: {} };
    if (details.hasNotes || details.sealedFields.length > 0) {
      try {
        revealed = await ctx.api.revealNotes(id);
      } catch (cause) {
        showToast(errorText(cause, "errors.showNotes"), { type: "error" });
        return;
      }
    }
    if (state.selectedEntryId !== id) return;
    itemEditor.open(details.type, { ...details, notes: revealed.notes, fields: { ...details.fields, ...revealed.fields } });
  });

  detailUi.notesReveal.addEventListener("click", () => void revealSelectedNotes());

  $("#entry-search").addEventListener("input", renderEntryList);
  onChange(() => {
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

export { create };
