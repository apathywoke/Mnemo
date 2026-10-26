(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;

  function bind(ctx) {
    const button = $("#backup-button");
    const warning = $("#backup-recovery-warning");
    const dismissWarningButton = $("#dismiss-backup-warning");
    const warningDismissalKey = "mnemo.backup-recovery-warning.dismissed";

    try {
      warning.hidden = window.sessionStorage.getItem(warningDismissalKey) === "true";
    } catch {
      // Keep the warning usable even when browser storage is unavailable.
    }

    dismissWarningButton.addEventListener("click", () => {
      warning.hidden = true;
      try {
        window.sessionStorage.setItem(warningDismissalKey, "true");
      } catch {
        // The dismissal remains effective for the current renderer session.
      }
    });

    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        const result = await ctx.api.exportBackup();
        if (!result.canceled) {
          showToast("Encrypted backup saved. Keep your master passphrase safe; Mnemo cannot recover it if lost.");
        }
      } catch (cause) {
        showToast(cause.message || "Could not save the backup.", { type: "error" });
      } finally {
        button.disabled = false;
        button.textContent = "Backup";
      }
    });
  }

  ns.features.backup = { bind };
})();
