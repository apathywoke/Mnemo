(() => {
  const ns = window.mnemoRenderer;

  function getById(entries, id) {
    return entries.find((entry) => entry.id === id) ?? null;
  }

  function secondaryLabel(entry) {
    if (entry.username) return entry.username;
    if (entry.url) {
      try {
        return new URL(entry.url).hostname;
      } catch {
        return entry.url;
      }
    }
    return "Login";
  }

  function filter(entries, query) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
      `${entry.name} ${entry.username} ${entry.url}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }

  ns.entities.login = { getById, secondaryLabel, filter };
})();
