(() => {
  const ns = window.mnemoRenderer;
  const { setSiteIcon } = ns.entities.login;

  // `entry` is a summary from listEntries(); `notes` arrive separately from
  // getEntry(). The password is never part of renderer state.
  function renderLoginDetail(entry, ui, { notes = "", updateSiteIconButton }) {
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
    ui.password.textContent = "••••••••••••";
    ui.notes.textContent = notes;
    ui.notesField.hidden = !notes;
    ui.copyUsername.disabled = !entry.username;
    ui.detail.hidden = false;
    ui.empty.hidden = true;
  }

  ns.entities.login.renderDetail = renderLoginDetail;
})();
