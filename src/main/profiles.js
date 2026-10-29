// Profile helpers shared by several IPC groups.

function createProfileHelpers(ctx) {
  const { state } = ctx;

  // Restore credentials from the renderer: the backup's passphrase, or a
  // recovery key with a new passphrase. Only known fields are passed on.
  function toRestoreCredentials(value) {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
      return { recoveryKey: value.recoveryKey, newPassphrase: value.newPassphrase };
    }
    throw new Error("Enter a master passphrase.");
  }

  async function activeProfileName() {
    if (state.activeProfileId === null) return "Mnemo";
    try {
      return (await state.profileManager.getProfile(state.activeProfileId)).name;
    } catch {
      return "Mnemo";
    }
  }

  return { toRestoreCredentials, activeProfileName };
}

module.exports = { createProfileHelpers };
