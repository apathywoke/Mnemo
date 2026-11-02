import { $ } from "../../shared/lib/dom.js";

// Backups are exported from Settings, where the master passphrase is
// confirmed first; this slice only keeps the reminder banner. Closing it is
// remembered in the settings; main shows it again after a new recovery key.
function bind(ctx) {
  const warning = $("#backup-recovery-warning");
  const dismissWarningButton = $("#dismiss-backup-warning");

  // Hidden until the settings say otherwise, so it never flashes up.
  async function refresh() {
    try {
      warning.hidden = (await ctx.api.getSettings()).backupReminder === false;
    } catch {
      warning.hidden = false;
    }
  }

  dismissWarningButton.addEventListener("click", () => {
    warning.hidden = true;
    // If saving fails, the reminder only comes back on the next launch.
    ctx.api.dismissBackupReminder().catch(() => {});
  });

  warning.hidden = true;
  return { refresh };
}

export { bind };
