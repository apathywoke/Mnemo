(() => {
  const ns = window.mnemoRenderer;

  function formatLastOpened(timestamp) {
    const { t, language } = ns.shared.i18n;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      return t("profile.lastOpenedUnknown");
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return t("profile.lastOpenedUnknown");
    return t("profile.lastOpened", {
      date: new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date),
    });
  }

  ns.entities.vaultProfile = { formatLastOpened };
})();
