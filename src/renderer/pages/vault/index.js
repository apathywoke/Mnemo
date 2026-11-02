import * as backupFeature from "../../features/backup/index.js";
import { $ } from "../../shared/lib/dom.js";
import * as vaultBrowserWidget from "../../widgets/vault-browser/index.js";

function create(ctx) {
  const browser = vaultBrowserWidget.create(ctx);
  const backupReminder = backupFeature.bind(ctx);
  $("#lock-button").addEventListener("click", () => void ctx.pages.access.lockVault());
  $("#retry-button").addEventListener("click", () => void ctx.pages.access.refreshState());

  return Object.assign(browser, { refreshBackupReminder: backupReminder.refresh });
}

export { create };
