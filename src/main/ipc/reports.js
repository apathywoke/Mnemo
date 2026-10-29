// IPC handlers. Password reports: weak, reused, and breached passwords.
const { randomBytes } = require("node:crypto");
const { buildReport, checkPwnedHashes, collectPasswords } = require("../../../password-health");

function register(ctx) {
  const { state, registerHandler } = ctx;

  // Reports: weak and reused passwords are found locally on every request;
  // breaches only when the user asks, through k-anonymity range queries.
  function readPasswordsForReport() {
    if (!state.vaultStore?.isUnlocked()) throw new Error("Unlock the vault first.");
    state.passwordHealthKey ??= randomBytes(32);
    return collectPasswords(state.vaultStore, state.passwordHealthKey);
  }

  registerHandler("vault:password-health", () =>
    buildReport(readPasswordsForReport(), { breaches: state.breachResults, checkedAt: state.breachCheckedAt }));

  registerHandler("vault:check-breaches", async () => {
    const store = state.vaultStore;
    const epoch = state.lockEpoch;
    const passwords = readPasswordsForReport();
    const counts = await checkPwnedHashes(passwords.map((password) => password.sha1));
    if (store !== state.vaultStore || state.lockEpoch !== epoch) throw new Error("Unlock the vault first.");
    state.breachResults = new Map(passwords.map((password) => [password.fingerprint, counts.get(password.sha1)]));
    state.breachCheckedAt = Date.now();
    return buildReport(passwords, { breaches: state.breachResults, checkedAt: state.breachCheckedAt });
  });
}

module.exports = { register };
