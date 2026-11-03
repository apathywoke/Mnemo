import { secondaryLabel, filter, setItemIcon } from "../model/login.js";
import { setSiteIcon } from "./site-icon.js";
import * as i18n from "../../../shared/lib/i18n.js";

// `scope` (all, favorites, a folder, or the trash) and `typeFilter` narrow
// the list; `scopeEmptyText` is shown when they leave nothing to list,
// before any search.
function renderLoginList({
  entries, selectedId, query, typeFilter = "all", scope = { kind: "all" },
  container, count, empty, noResults, scopeEmptyText = "", onSelect,
}) {
  const filteredEntries = filter(entries, query, typeFilter, scope);
  const inScope = filter(entries, "", typeFilter, scope);
  const vaultEmpty = !entries.some((entry) => !entry.deletedAt) && scope.kind !== "trash";
  container.replaceChildren();
  count.textContent = String(inScope.length);
  empty.hidden = !vaultEmpty;
  noResults.hidden = vaultEmpty || filteredEntries.length !== 0;
  noResults.textContent = inScope.length === 0 && scopeEmptyText
    ? scopeEmptyText
    : i18n.t("vault.noResults");
  container.hidden = filteredEntries.length === 0;

  for (const entry of filteredEntries) {
    const row = document.createElement("button");
    row.className = "entry-row";
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(entry.id === selectedId));
    const icon = document.createElement("span");
    icon.className = "entry-row-icon";
    icon.setAttribute("aria-hidden", "true");
    if (entry.type && entry.type !== "login") setItemIcon(icon, entry.type);
    else setSiteIcon(icon, entry.favicon, Array.from(entry.name)[0] ?? "•");
    const copy = document.createElement("span");
    copy.className = "entry-row-copy";
    const name = document.createElement("span");
    name.className = "entry-row-name";
    name.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "entry-row-meta";
    meta.textContent = secondaryLabel(entry);
    copy.append(name, meta);
    row.append(icon, copy);
    if (entry.favorite && !entry.deletedAt) {
      const star = document.createElement("span");
      star.className = "entry-row-star";
      star.setAttribute("aria-label", i18n.t("organize.favorite"));
      star.textContent = "★";
      row.append(star);
    }
    row.addEventListener("click", () => onSelect(entry.id));
    container.append(row);
  }
}

export { renderLoginList as renderList };
