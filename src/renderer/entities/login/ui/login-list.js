(() => {
  const ns = window.mnemoRenderer;
  const { secondaryLabel, filter } = ns.entities.login;
  const { setSiteIcon } = ns.entities.login;

  function renderLoginList({ entries, selectedId, query, typeFilter = "all", container, count, empty, noResults, onSelect }) {
    const filteredEntries = filter(entries, query, typeFilter);
    container.replaceChildren();
    count.textContent = String(entries.length);
    empty.hidden = entries.length !== 0;
    noResults.hidden = entries.length === 0 || filteredEntries.length !== 0;
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
      row.addEventListener("click", () => onSelect(entry.id));
      container.append(row);
    }
  }

  ns.entities.login.renderList = renderLoginList;
})();
