(() => {
  const ns = window.mnemoRenderer;
  const { formatLastOpened } = ns.entities.vaultProfile;
  const { t } = ns.shared.i18n;

  function renderProfileList(container, profiles, { onSelect, onDelete }) {
    container.replaceChildren();
    for (const profile of profiles) {
      const card = document.createElement("div");
      card.className = "profile-card";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-choice";
      const name = document.createElement("span");
      name.className = "profile-choice-name";
      name.textContent = profile.name;
      const meta = document.createElement("span");
      meta.className = "profile-choice-meta";
      meta.textContent = `${t("profile.encryptedVault")} · ${formatLastOpened(profile.lastOpenedAt)}`;
      const arrow = document.createElement("span");
      arrow.className = "profile-choice-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      button.append(name, meta, arrow);
      button.addEventListener("click", () => onSelect(profile, button));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "profile-delete-button";
      deleteButton.setAttribute("aria-label", t("profile.deleteAria", { name: profile.name }));
      deleteButton.title = t("profile.deleteTitle");
      deleteButton.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6m4-6v6"/><path d="M5 7l1 13h12l1-13"/><path d="M9 7V4h6v3"/></svg>';
      deleteButton.addEventListener("click", () => onDelete(profile));

      card.append(button, deleteButton);
      container.append(card);
    }
  }

  ns.entities.vaultProfile.renderList = renderProfileList;
})();
