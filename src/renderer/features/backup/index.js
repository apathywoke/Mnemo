import { $ } from "../../shared/lib/dom.js";
import * as i18n from "../../shared/lib/i18n.js";

// Backups are exported from Settings, where the master passphrase is
// confirmed first; this slice only keeps the reminder banners.
// - The backup reminder: closing it is remembered in the settings; main
//   shows it again once a new recovery key is confirmed.
// - A recovery key that was never confirmed as saved (the vault locked or
//   the app quit first): shown until a new key is confirmed, and cannot be
//   closed. It takes the place of the backup reminder.
// - The recovery key check: every 90 days, a reminder to make sure the key
//   is still at hand. "Check now" opens the check in Settings; "Later" asks
//   again in 14 days. Not shown while a new key waits for its confirmation.
// - The copy outside this Mac: offered once for a new vault ("Later" is
//   remembered), and a reminder after 14 days without a checked copy, which
//   closes only until the next unlock.
//
// The notices share one strip, most important first (index.html). Folded,
// only the first one shown is visible, on one line; "N more" unfolds them
// all, as does Security in the sidebar (ctx.notices.expand).
function bind(ctx) {
  const notices = $("#vault-notices");
  const toggle = $("#vault-notices-toggle");
  const warning = $("#backup-recovery-warning");
  const unconfirmed = $("#recovery-unconfirmed-warning");
  const dismissWarningButton = $("#dismiss-backup-warning");
  const outsideBanner = $("#outside-copy-banner");
  const outsideTitle = $("#outside-copy-banner-title");
  const outsideBody = $("#outside-copy-banner-body");
  const outsideAction = $("#outside-copy-banner-action");
  const outsideLater = $("#outside-copy-banner-later");
  const outsideDismiss = $("#dismiss-outside-copy-banner");
  const keyCheck = $("#key-check-banner");
  const banners = [unconfirmed, outsideBanner, keyCheck, warning];
  let outside = null;
  let expanded = false;

  const shownCount = () => banners.filter((banner) => !banner.hidden).length;

  // Call after any banner is shown or hidden.
  function renderNotices() {
    const count = shownCount();
    if (count < 2) expanded = false;
    notices.hidden = count === 0;
    notices.classList.toggle("is-expanded", expanded);
    toggle.hidden = count < 2;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded
      ? i18n.t("vault.noticesFewer")
      : i18n.t("vault.noticesMore", { count: count - 1 });
    ctx.organize?.renderSidebar();
  }

  function setExpanded(value) {
    expanded = value;
    renderNotices();
  }

  function renderOutside() {
    const show = outside !== null && (outside.reminderDue || outside.offer);
    outsideBanner.hidden = !show;
    renderNotices();
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
    keyCheck.hidden = !unconfirmed.hidden || recovery?.pending === true || recovery?.checkDue !== true;
    outside = outsideStatus;
    expanded = false;
    renderOutside();
  }

  dismissWarningButton.addEventListener("click", () => {
    warning.hidden = true;
    renderNotices();
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
    renderNotices();
    ctx.api.dismissOutsideCopyOffer().catch(() => {});
  });

  // Until the next unlock only: the reminder comes back while there is no
  // checked copy.
  outsideDismiss.addEventListener("click", () => {
    outsideBanner.hidden = true;
    renderNotices();
  });

  $("#key-check-banner-now").addEventListener("click", () => ctx.openSettings("security", { checkKey: true }));
  $("#key-check-banner-later").addEventListener("click", () => {
    keyCheck.hidden = true;
    renderNotices();
    ctx.api.snoozeKeyCheck().catch(() => {});
  });

  toggle.addEventListener("click", () => setExpanded(!expanded));

  i18n.onChange(renderOutside);
  warning.hidden = true;
  unconfirmed.hidden = true;
  outsideBanner.hidden = true;
  keyCheck.hidden = true;
  renderNotices();
  ctx.notices = { count: shownCount, expand: () => setExpanded(true) };
  return { refresh };
}

export { bind };
