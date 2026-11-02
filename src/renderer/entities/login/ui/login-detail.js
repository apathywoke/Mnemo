import { setSiteIcon } from "./site-icon.js";

// `entry` is a summary from listEntries(). getEntry() says whether there are
// notes (`hasNotes`); their text (`notes`) arrives only after Show. The
// password is never part of renderer state.
function renderLoginDetail(entry, ui, { notes = "", hasNotes = false, updateSiteIconButton }) {
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
  ui.totpField.hidden = !entry.hasTotp;
  ui.notes.textContent = notes;
  ui.notes.hidden = !notes;
  ui.notesReveal.hidden = Boolean(notes);
  ui.notesField.hidden = !hasNotes;
  ui.copyUsername.disabled = !entry.username;
  ui.detail.hidden = false;
  ui.empty.hidden = true;
}

export { renderLoginDetail as renderDetail };
