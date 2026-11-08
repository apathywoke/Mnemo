import { formatLastOpened } from "../model/profile.js";
import { t } from "../../../shared/lib/i18n.js";
import { showContextMenu } from "../../../shared/ui/context-menu.js";

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
    // Deleting is rare and needs no passphrase (a forgotten one is a reason
    // to delete), so it is in the row's menu: a right click, or the menu
    // key. It asks for the vault's name first (profile-management).
    button.addEventListener("contextmenu", (event) => {
      showContextMenu(event, [
        { label: t("profile.deleteMenu"), danger: true, onSelect: () => onDelete(profile) },
      ]);
    });

    card.append(button);
    container.append(card);
  }
}

export { renderProfileList as renderList };
