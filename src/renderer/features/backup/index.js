import { $ } from "../../shared/lib/dom.js";

// Backups are exported from Settings, where the master passphrase is
// confirmed first; this slice only keeps the reminder banners.
// - The backup reminder: closing it is remembered in the settings; main
//   shows it again once a new recovery key is confirmed.
// - A recovery key that was never confirmed as saved (the vault locked or
//   the app quit first): shown until a new key is confirmed, and cannot be
//   closed. It takes the place of the backup reminder.
function bind(ctx) {
  const warning = $("#backup-recovery-warning");
  const unconfirmed = $("#recovery-unconfirmed-warning");
  const dismissWarningButton = $("#dismiss-backup-warning");

  // Hidden until the settings say otherwise, so neither flashes up.
  async function refresh() {
    const [settings, recovery] = await Promise.all([
      ctx.api.getSettings().catch(() => null),
      ctx.api.getRecoveryStatus().catch(() => null),
    ]);
    unconfirmed.hidden = recovery?.confirmed !== false || recovery.pending;
    warning.hidden = !unconfirmed.hidden || settings?.backupReminder === false;
  }

  dismissWarningButton.addEventListener("click", () => {
    warning.hidden = true;
    // If saving fails, the reminder only comes back on the next launch.
    ctx.api.dismissBackupReminder().catch(() => {});
  });

  warning.hidden = true;
  unconfirmed.hidden = true;
  return { refresh };
}

export { bind };
