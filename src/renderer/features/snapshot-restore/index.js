import { $ } from "../../shared/lib/dom.js";
import * as i18n from "../../shared/lib/i18n.js";

// The list of snapshots to restore from: the open profile's own (on this
// Mac and in the folder outside it), or those in a snapshot folder picked on
// the profile screen, for a new vault. Choosing one opens the restore form
// (`openRestore(snapshot)`); main resolves the ID, the page never sees paths.
function bind(ctx, { openRestore, back }) {
  const panel = $("#snapshots-panel");
  const list = $("#snapshot-list");
  const empty = $("#snapshots-empty");
  const error = $("#snapshots-error");
  const description = $("#snapshots-description");
  let snapshots = [];

  const formatDate = (time) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));

  function metaOf(snapshot) {
    const parts = [i18n.t(snapshot.location === "local" ? "snapshots.locationLocal" : "snapshots.locationOutside")];
    if (snapshot.pinned) parts.push(i18n.t(`snapshots.pinned${snapshot.pinned.charAt(0).toUpperCase()}${snapshot.pinned.slice(1)}`));
    if (snapshot.attachments > 0) parts.push(i18n.t("snapshots.attachments", { count: snapshot.attachments }));
    if (!snapshot.verified) parts.push(i18n.t("snapshots.unverified"));
    return parts.join(" · ");
  }

  function render() {
    list.replaceChildren();
    const groups = new Set(snapshots.map((snapshot) => snapshot.group ?? ""));
    let lastGroup = null;
    for (const snapshot of snapshots) {
      // Snapshots from several vaults (a picked folder): one heading each.
      if (groups.size > 1 && snapshot.group !== lastGroup) {
        lastGroup = snapshot.group;
        const heading = document.createElement("p");
        heading.className = "eyebrow section-label";
        heading.textContent = i18n.t("snapshots.group", { id: String(snapshot.group).slice(0, 8) });
        list.append(heading);
      }
      const card = document.createElement("div");
      card.className = "profile-card";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-choice";
      const name = document.createElement("span");
      name.className = "profile-choice-name";
      name.textContent = formatDate(snapshot.createdAt);
      const meta = document.createElement("span");
      meta.className = "profile-choice-meta";
      meta.textContent = metaOf(snapshot);
      const arrow = document.createElement("span");
      arrow.className = "profile-choice-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      button.append(name, meta, arrow);
      button.addEventListener("click", () => openRestore(snapshot));
      card.append(button);
      list.append(card);
    }
    empty.hidden = snapshots.length > 0;
  }

  function show(items, descriptionKey) {
    snapshots = items;
    error.hidden = true;
    description.dataset.i18n = descriptionKey;
    description.textContent = i18n.t(descriptionKey);
    render();
    ctx.showPanel("snapshots");
    list.querySelector("button")?.focus();
  }

  // The open profile's snapshots. Works while locked.
  async function openForVault() {
    let items = [];
    try {
      items = await ctx.api.listSnapshots();
    } catch (cause) {
      show([], "snapshots.description");
      ctx.setError(error, i18n.errorText(cause, "errors.restoreVault"));
      return;
    }
    show(items, "snapshots.description");
  }

  // Snapshots in a folder the user picks, restored as a new vault.
  async function openForFolder() {
    try {
      const result = await ctx.api.chooseSnapshotFolder();
      if (result.canceled) return;
      show(result.snapshots, "snapshots.folderDescription");
    } catch (cause) {
      show([], "snapshots.folderDescription");
      ctx.setError(error, i18n.errorText(cause, "errors.restoreVault"));
    }
  }

  $("#snapshots-back-button").addEventListener("click", () => void back());
  i18n.onChange(() => {
    if (!panel.hidden) render();
  });

  return { openForVault, openForFolder };
}

export { bind };
