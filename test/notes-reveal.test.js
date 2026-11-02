const assert = require("node:assert/strict");
const test = require("node:test");
const { REVEAL_WINDOW_MS, createNotesReveal } = require("../src/main/notes-reveal");

function setup() {
  const state = { lockEpoch: 0, notesRevealGrant: null };
  return { state, ...createNotesReveal({ state }) };
}

test("only key and mouse presses grant a reveal of notes", () => {
  const { grantRevealFromInput, takeRevealGrant } = setup();
  for (const type of ["mouseMove", "mouseUp", "keyUp", "char", "mouseWheel", undefined]) {
    grantRevealFromInput({ type });
    assert.equal(takeRevealGrant(), false, String(type));
  }
  grantRevealFromInput(null);
  assert.equal(takeRevealGrant(), false);
  for (const type of ["mouseDown", "rawKeyDown", "keyDown", "gestureTap"]) {
    grantRevealFromInput({ type });
    assert.equal(takeRevealGrant(), true, type);
  }
});

test("a grant is used once, does not pile up, and expires", () => {
  const { state, grantRevealFromInput, takeRevealGrant } = setup();
  grantRevealFromInput({ type: "mouseDown" });
  grantRevealFromInput({ type: "keyDown" });
  assert.equal(takeRevealGrant(), true);
  assert.equal(takeRevealGrant(), false);

  grantRevealFromInput({ type: "mouseDown" });
  const grantedAt = state.notesRevealGrant.at;
  assert.equal(takeRevealGrant(grantedAt + REVEAL_WINDOW_MS + 1), false);
  // A failed attempt also uses the grant.
  assert.equal(takeRevealGrant(grantedAt), false);

  grantRevealFromInput({ type: "mouseDown" });
  assert.equal(takeRevealGrant(state.notesRevealGrant.at - 1), false);
});

test("a grant from before a lock does not count after it", () => {
  const { state, grantRevealFromInput, takeRevealGrant } = setup();
  grantRevealFromInput({ type: "mouseDown" });
  state.lockEpoch += 1;
  assert.equal(takeRevealGrant(), false);
});
