import { $ } from "../../shared/lib/dom.js";

// Backups are exported from Settings, where the master passphrase is
// confirmed first; this slice only keeps the reminder banner.
function bind() {
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
}

export { bind };
