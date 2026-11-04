// Newly issued recovery keys, shared by several IPC groups.
const { timingSafeEqual } = require("node:crypto");

// How many characters from the end of the key the user types to confirm
// that it was saved.
const CONFIRM_SUFFIX_LENGTH = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
// The vault screen reminds the user to check the recovery key this long
// after it was last confirmed or checked; "Later" asks again after
// KEY_CHECK_SNOOZE_MS.
const KEY_CHECK_INTERVAL_MS = 90 * DAY_MS;
const KEY_CHECK_SNOOZE_MS = 14 * DAY_MS;

function createRecoveryKeys(ctx) {
  const { state, activeProfileName } = ctx;
  const now = () => (ctx.now ?? Date.now)();

  // Pushes the next reminder to check the key `delay` from now.
  async function scheduleKeyCheck(profileId, delay = KEY_CHECK_INTERVAL_MS) {
    if (profileId === null) return;
    await state.settingsLoaded;
    await state.settingsStore.setKeyCheckDue(profileId, now() + delay).catch(() => {});
  }

  // Whether the vault screen should remind the user to check the key. A
  // vault seen for the first time starts its interval now.
  async function isKeyCheckDue(profileId) {
    if (profileId === null) return false;
    await state.settingsLoaded;
    const due = state.settingsStore.getKeyCheckDue(profileId);
    if (due === null) {
      await scheduleKeyCheck(profileId);
      return false;
    }
    return now() >= due;
  }

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
      await scheduleKeyCheck(pending.profileId);
    }
    return { confirmed: true };
  }

  // The user typed the whole key and it opens the vault: it is saved
  // somewhere, which also confirms a key never confirmed before.
  async function recordKeyChecked(profileId) {
    if (profileId === null) return;
    await state.settingsLoaded;
    await state.settingsStore.setRecoveryKeyConfirmed(profileId, true).catch(() => {});
    await scheduleKeyCheck(profileId);
  }

  return {
    issueRecoveryKey,
    confirmRecoveryKeySaved,
    isKeyCheckDue,
    recordKeyChecked,
    snoozeKeyCheck: (profileId) => scheduleKeyCheck(profileId, KEY_CHECK_SNOOZE_MS),
  };
}

module.exports = { CONFIRM_SUFFIX_LENGTH, KEY_CHECK_INTERVAL_MS, KEY_CHECK_SNOOZE_MS, createRecoveryKeys };
