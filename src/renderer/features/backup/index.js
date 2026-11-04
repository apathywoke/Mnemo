import { $ } from "../../shared/lib/dom.js";
import * as i18n from "../../shared/lib/i18n.js";

// Backups are exported from Settings, where the master passphrase is
// confirmed first; this slice only keeps the reminder banners.
// - The backup reminder: closing it is remembered in the settings; main
//   shows it again once a new recovery key is confirmed.
// - A recovery key that was never confirmed as saved (the vault locked or
//   the app quit first): shown until a new key is confirmed, and cannot be
//   closed. It takes the place of the backup reminder.
// - The copy outside this Mac: offered once for a new vault ("Later" is
//   remembered), and a reminder after 14 days without a checked copy, which
//   closes only until the next unlock.
function bind(ctx) {
  const warning = $("#backup-recovery-warning");
  const unconfirmed = $("#recovery-unconfirmed-warning");
  const dismissWarningButton = $("#dismiss-backup-warning");
  const outsideBanner = $("#outside-copy-banner");
  const outsideTitle = $("#outside-copy-banner-title");
  const outsideBody = $("#outside-copy-banner-body");
  const outsideAction = $("#outside-copy-banner-action");
  const outsideLater = $("#outside-copy-banner-later");
  const outsideDismiss = $("#dismiss-outside-copy-banner");
  let outside = null;

  function renderOutside() {
    const show = outside !== null && (outside.reminderDue || outside.offer);
    outsideBanner.hidden = !show;
    if (!show) return;
    const offer = !outside.reminderDue;
    outsideBanner.setAttribute("role", offer ? "note" : "alert");
    outsideTitle.textContent = i18n.t(offer ? "vault.outsideOfferTitle" : "vault.outsideReminderTitle");
    const folder = outside.folderName;
    outsideBody.textContent = offer || folder === null
      ? i18n.t(offer ? "vault.outsideOfferBody" : "vault.outsideReminderNoFolder")
      : outside.verifiedAt === null
        ? i18n.t("vault.outsideReminderNever", { folder })
        : i18n.t("vault.outsideReminderOld", {
          folder,
          date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(outside.verifiedAt)),
        });
    outsideAction.textContent = i18n.t(offer ? "vault.outsideChoose" : "vault.outsideOpenSettings");
    outsideLater.hidden = !offer;
    outsideDismiss.hidden = offer;
  }

  // Hidden until the settings say otherwise, so neither flashes up.
  async function refresh() {
    const [settings, recovery, outsideStatus] = await Promise.all([
      ctx.api.getSettings().catch(() => null),
      ctx.api.getRecoveryStatus().catch(() => null),
      ctx.api.getOutsideCopyStatus().catch(() => null),
    ]);
    unconfirmed.hidden = recovery?.confirmed !== false || recovery.pending;
    warning.hidden = !unconfirmed.hidden || settings?.backupReminder === false;
    outside = outsideStatus;
    renderOutside();
  }

  dismissWarningButton.addEventListener("click", () => {
    warning.hidden = true;
    // If saving fails, the reminder only comes back on the next launch.
    ctx.api.dismissBackupReminder().catch(() => {});
  });

  outsideAction.addEventListener("click", async () => {
    if (outside?.reminderDue) {
      ctx.openSettings("backups");
      return;
    }
    try {
      const result = await ctx.api.chooseOutsideFolder();
      if (!result.canceled) {
        outside = result.status;
        renderOutside();
      }
    } catch {
      // Settings shows what went wrong.
      ctx.openSettings("backups");
    }
  });

  outsideLater.addEventListener("click", () => {
    outsideBanner.hidden = true;
    ctx.api.dismissOutsideCopyOffer().catch(() => {});
  });

  // Until the next unlock only: the reminder comes back while there is no
  // checked copy.
  outsideDismiss.addEventListener("click", () => {
    outsideBanner.hidden = true;
  });

  i18n.onChange(renderOutside);
  warning.hidden = true;
  unconfirmed.hidden = true;
  outsideBanner.hidden = true;
  return { refresh };
}

export { bind };
