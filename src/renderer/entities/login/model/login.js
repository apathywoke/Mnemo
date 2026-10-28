(() => {
  const ns = window.mnemoRenderer;

  function getById(entries, id) {
    return entries.find((entry) => entry.id === id) ?? null;
  }

  function secondaryLabel(entry) {
    if (entry.type && entry.type !== "login") {
      return entry.subtitle || ns.shared.i18n.t(`item.type.${entry.type}`);
    }
    if (entry.username) return entry.username;
    if (entry.url) {
      try {
        return new URL(entry.url).hostname;
      } catch {
        return entry.url;
      }
    }
    return ns.shared.i18n.t("login.fallbackLabel");
  }

  // Where the list is looking: { kind: "all" | "favorites" | "folder" |
  // "trash", folderId }. Items in the trash appear only in the trash.
  function inScope(entry, scope = { kind: "all" }) {
    if (scope.kind === "trash") return Boolean(entry.deletedAt);
    if (entry.deletedAt) return false;
    if (scope.kind === "favorites") return entry.favorite === true;
    if (scope.kind === "folder") return entry.folderId === scope.folderId;
    return true;
  }

  // `type` is "all" or one item type; search covers name and the visible
  // secondary text (username, website, card ending, fingerprint).
  function filter(entries, query, type = "all", scope = { kind: "all" }) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
      inScope(entry, scope) &&
      (type === "all" || (entry.type ?? "login") === type) &&
      [entry.name, entry.username, entry.url, entry.subtitle]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }

  // Type glyphs for items without a site icon; drawn with a CSS mask.
  function setItemIcon(container, type) {
    container.replaceChildren();
    container.classList.remove("has-site-icon");
    const glyph = document.createElement("span");
    glyph.className = "item-type-glyph";
    glyph.dataset.type = type;
    container.append(glyph);
  }

  ns.entities.login = { getById, secondaryLabel, filter, inScope, setItemIcon };
})();
