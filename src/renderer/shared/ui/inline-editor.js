// The item editors (login and other types) open in the detail area, in
// place of the detail, like editing in Apple Passwords. They stay <dialog>
// elements, shown without a modal backdrop, so the code that checks for an
// open dialog (Escape, menu commands, locking) treats them as before.
//
// While one is open the rest of the vault cannot be used: the sidebar, the
// list, the notices, and the title bar's buttons are inert, so an unsaved
// edit is not left behind by picking another item. Lock stays usable: the
// vault can always be locked, and locking closes the editor. Save, Cancel,
// and Escape close it too and give the rest back.

const OUTSIDE = [
  "#vault-sidebar",
  ".entry-browser",
  "#vault-notices",
  "#reports-button",
  "#switch-profile-button",
  "#vault-settings-button",
];

function setOutsideInert(inert) {
  document.body.classList.toggle("is-editing", inert);
  for (const selector of OUTSIDE) {
    const element = /** @type {HTMLElement | null} */ (document.querySelector(selector));
    if (element) element.inert = inert;
  }
}

/** @param {HTMLDialogElement} dialog */
function open(dialog) {
  if (!dialog.open) dialog.show();
  setOutsideInert(true);
  const area = dialog.closest(".entry-detail-area");
  if (area) area.scrollTop = 0;
}

/** @param {HTMLDialogElement} dialog */
function bind(dialog) {
  dialog.addEventListener("close", () => {
    if (!document.querySelector("dialog.inline-editor[open]")) setOutsideInert(false);
  });
}

export { bind, open };
