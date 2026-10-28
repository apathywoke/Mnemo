(() => {
  const ns = window.mnemoRenderer;
  const { secondaryLabel, filter } = ns.entities.login;
  const { setSiteIcon } = ns.entities.login;

  // `scope` narrows the list (all, favorites, a folder, or the trash);
  // `scopeEmptyText` is shown when the scope itself has nothing to list.
  function renderLoginList({
    entries, selectedId, query, typeFilter = "all", scope = { kind: "all" },
    container, count, empty, noResults, scopeEmptyText = "", onSelect,
  }) {
    const filteredEntries = filter(entries, query, typeFilter, scope);
    const inScope = entries.filter((entry) => ns.entities.login.inScope(entry, scope));
    const vaultEmpty = !entries.some((entry) => !entry.deletedAt) && scope.kind !== "trash";
    container.replaceChildren();
    count.textContent = String(inScope.length);
    empty.hidden = !vaultEmpty;
    noResults.hidden = vaultEmpty || filteredEntries.length !== 0;
    noResults.textContent = inScope.length === 0 && scopeEmptyText
      ? scopeEmptyText
      : ns.shared.i18n.t("vault.noResults");
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
      if (entry.type && entry.type !== "login") ns.entities.login.setItemIcon(icon, entry.type);
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
        star.setAttribute("aria-label", ns.shared.i18n.t("organize.favorite"));
        star.textContent = "★";
        row.append(star);
      }
      row.addEventListener("click", () => onSelect(entry.id));
      container.append(row);
    }
  }

  ns.entities.login.renderList = renderLoginList;
})();
