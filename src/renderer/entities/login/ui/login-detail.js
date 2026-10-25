(() => {
  const ns = window.mnemoRenderer;
  const { setSiteIcon } = ns.entities.login;

  function renderLoginDetail(entry, ui, { passwordVisible, updateSiteIconButton }) {
    if (!entry) {
      ui.detail.hidden = true;
      ui.empty.hidden = false;
      return;
    }

    setSiteIcon(ui.icon, entry.favicon, Array.from(entry.name)[0] ?? "•");
    updateSiteIconButton(entry);
    ui.name.textContent = entry.name;
    ui.url.textContent = entry.url;
    ui.username.textContent = entry.username || "—";
    ui.password.textContent = passwordVisible ? entry.password : "••••••••••••";
    ui.notes.textContent = entry.notes;
    ui.notesField.hidden = !entry.notes;
    ui.copyUsername.disabled = !entry.username;
    ui.detail.hidden = false;
    ui.empty.hidden = true;
  }

  ns.entities.login.renderDetail = renderLoginDetail;
})();
