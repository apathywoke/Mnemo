// Newly issued recovery keys, shared by several IPC groups.
const { timingSafeEqual } = require("node:crypto");

// How many characters from the end of the key the user types to confirm
// that it was saved.
const CONFIRM_SUFFIX_LENGTH = 4;

function createRecoveryKeys(ctx) {
  const { state, activeProfileName } = ctx;

  // Holds the key until the user confirms it is saved (or the vault locks),
  // and records the vault as having an unconfirmed key. The record is
  // written now, so quitting or a crash before the confirmation leaves the
  // reminder in place.
  async function issueRecoveryKey(key, profileName = null) {
    const profileId = state.activeProfileId;
    state.pendingRecoveryKey = { key, profileId, profileName: profileName ?? await activeProfileName() };
    if (profileId === null) return;
    await state.settingsLoaded;
    await state.settingsStore.setRecoveryKeyConfirmed(profileId, false).catch(() => {});
  }

  // `typed`: what the user entered for the end of the key. Checked here,
  // not in the page.
  async function confirmRecoveryKeySaved(typed) {
    const pending = state.pendingRecoveryKey;
    if (!pending) throw new Error("Unlock the vault first.");
    const expected = Buffer.from(pending.key.replace(/-/g, "").slice(-CONFIRM_SUFFIX_LENGTH), "utf8");
    const given = Buffer.from(String(typed ?? "").replace(/[\s-]/g, "").toUpperCase(), "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new Error("These are not the last characters of the recovery key.");
    }
    if (pending.profileId !== null) {
      await state.settingsLoaded;
      await state.settingsStore.setRecoveryKeyConfirmed(pending.profileId, true).catch(() => {});
      // Backups made before this key still open only with the old one.
      await state.settingsStore.setBackupReminder(true).catch(() => {});
    }
    return { confirmed: true };
  }

  return { issueRecoveryKey, confirmRecoveryKeySaved };
}

module.exports = { CONFIRM_SUFFIX_LENGTH, createRecoveryKeys };
