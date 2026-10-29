// Everything that changes while the app runs, in one object. Handlers compare
// state.vaultStore and state.lockEpoch before and after an await to notice a
// lock or a profile switch, so these values are read from here every time
// and never copied out.
function createState(translator) {
  return {
    language: translator.defaultLanguage,
    settingsStore: null,
    biometricUnlock: null,
    updater: null,
    updateTimer: null,
    // What the renderer shows about updates. `available` holds the verified
    // manifest data for the newest release while one is pending.
    updateState: { status: "idle", checkedAt: null, version: null, notes: "", progress: 0, error: null },
    availableUpdate: null,
    updateTask: null,
    settingsLoaded: Promise.resolve(),
    mainWindow: null,
    vaultStore: null,
    profileManager: null,
    activeProfileId: null,
    lockEpoch: 0,
    // Password health: a per-unlock key for password fingerprints, and breach
    // counts from the last Have I Been Pwned check, by fingerprint. Memory only;
    // cleared on lock.
    passwordHealthKey: null,
    breachResults: null,
    breachCheckedAt: null,
    autoLockTimer: null,
    clipboardClearTimer: null,
    ownedClipboardText: null,
    clipboardOperationQueue: Promise.resolve(),
    // The recovery key most recently issued, kept only until the user confirms it
    // is saved (or the vault locks) so that copy and save work without the
    // renderer sending it back.
    pendingRecoveryKey: null,
    // A parsed import waiting for the user's confirmation. The logins hold plain
    // passwords, so they are dropped on commit, cancel, or lock.
    pendingImport: null,
    // Native dialogs that display vault data; lockVault() closes them so a revealed
    // password does not stay on screen after the vault locks.
    openVaultDialogs: new Set(),
  };
}

module.exports = { createState };
