// Notes, and a secure note's text, reach the page only right after real user
// input (docs/design-notes-sealing.md, decision D3b). The app window's
// webContents reports every mouse button and key press that reaches the page
// ("input-event"); events that page scripts create (element.click(),
// dispatchEvent) never pass through it. Each press grants one reveal, used
// within a few seconds or not at all, so a compromised page cannot read notes
// while the user is idle, and gets at most one entry per real press.

// Presses only: releases and pointer moves grant nothing.
const REVEAL_INPUT_TYPES = new Set(["mouseDown", "rawKeyDown", "keyDown", "gestureTap"]);
const REVEAL_WINDOW_MS = 3000;

function createNotesReveal(ctx) {
  const { state } = ctx;

  // From the window's "input-event". A newer press replaces an unused grant,
  // so grants never pile up.
  function grantRevealFromInput(inputEvent) {
    if (!REVEAL_INPUT_TYPES.has(inputEvent?.type)) return;
    state.notesRevealGrant = { at: Date.now(), lockEpoch: state.lockEpoch };
  }

  // Uses the grant if there is a fresh one from this unlock session.
  function takeRevealGrant(now = Date.now()) {
    const grant = state.notesRevealGrant;
    state.notesRevealGrant = null;
    return Boolean(grant) &&
      grant.lockEpoch === state.lockEpoch &&
      now >= grant.at &&
      now - grant.at <= REVEAL_WINDOW_MS;
  }

  return { grantRevealFromInput, takeRevealGrant };
}

module.exports = { REVEAL_INPUT_TYPES, REVEAL_WINDOW_MS, createNotesReveal };
