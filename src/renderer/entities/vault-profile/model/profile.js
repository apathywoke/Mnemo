(() => {
  const ns = window.mnemoRenderer;

  function formatLastOpened(timestamp) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      return "Last opened · Not recorded";
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "Last opened · Not recorded";
    return `Last opened · ${new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date)}`;
  }

  ns.entities.vaultProfile = { formatLastOpened };
})();
