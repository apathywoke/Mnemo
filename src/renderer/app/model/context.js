import * as siteIcon from "../../entities/login/ui/site-icon.js";
import * as settingsFeature from "../../features/settings/index.js";
import { $, $$, setError as setElementError } from "../../shared/lib/dom.js";
import * as passphraseStrength from "../../shared/ui/passphrase-strength.js";
import { conceal } from "../../shared/ui/password-visibility.js";

// How long a lock or unlock motion may wait for the window's old picture
// before the change is made without it (ctx.transition).
const TRANSITION_START_MS = 300;

function createContext() {
  const ctx = {
    $,
    $$,
    api: window.vaultApp,
    state: {
      access: {
        availableProfiles: [],
        selectedProfileId: null,
        selectedProfileName: null,
        restoringNewProfile: false,
        // The snapshot being restored, from the snapshot list; null when
        // restoring a backup file.
        restoreSnapshot: null,
      },
      vault: {
        entries: [],
        selectedEntryId: null,
        // Notes of the selected login once the user chose Show, and whether
        // it has any.
        selectedEntryNotes: "",
        selectedEntryHasNotes: false,
        typeFilter: "all",
        // { kind: "all" | "favorites" | "folder" | "trash", folderId }
        scope: { kind: "all" },
        folders: [],
        fetchingFaviconForId: null,
      },
      ui: {
        lastActivitySentAt: 0,
        backNavigationInProgress: false,
      },
    },
    pages: Object.create(null),
    // Opens Settings at a category; set by the settings slice.
    /** @type {(tab?: string, options?: { checkKey?: boolean }) => void} */
    openSettings: () => {},
    setError(element, message) {
      setElementError(element, message);
    },
    /**
     * Unlocking and locking as one motion (app/styles/transitions.css): on
     * "unlock" the access screen lifts away and the vault is behind it; on
     * "lock" it comes down over the vault. `update` makes the change; the
     * browser shows the old picture until it is done. Without motion (the
     * system setting, a hidden window, or a window without the focus, as
     * while the Touch ID prompt is up), only `update` runs.
     *
     * The browser runs `update` only once it has drawn the old picture. A
     * window that draws nothing (covered by a system prompt) would leave the
     * change waiting, and the page on the lock screen with the vault open in
     * main; so if the picture is not taken soon, the motion is skipped and
     * `update` runs at once.
     * @param {"unlock" | "lock"} kind
     * @param {() => void | Promise<void>} update
     */
    async transition(kind, update) {
      const root = document.documentElement;
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.hidden || !document.hasFocus();
      if (still || typeof document.startViewTransition !== "function") {
        await update();
        return;
      }
      root.dataset.transition = kind;
      // Set when the browser calls `update`, that is, once the old picture
      // is taken. Skipping a transition whose `update` has not run yet runs
      // it at once.
      let started = false;
      const transition = document.startViewTransition(() => {
        started = true;
        return update();
      });
      const fallback = setTimeout(() => {
        if (!started) transition.skipTransition();
      }, TRANSITION_START_MS);
      transition.updateCallbackDone.catch(() => {}).finally(() => clearTimeout(fallback));
      transition.finished.catch(() => {}).finally(() => {
        if (root.dataset.transition === kind) delete root.dataset.transition;
      });
      await transition.updateCallbackDone;
    },
    showPanel(activePanel) {
      conceal();
      const panels = {
        profiles: $("#profiles-panel"),
        setup: $("#setup-panel"),
        unlock: $("#unlock-panel"),
        restore: $("#restore-panel"),
        snapshots: $("#snapshots-panel"),
        recover: $("#recover-panel"),
        open: $("#open-panel"),
        fatal: $("#fatal-panel"),
      };
      for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== activePanel;
      document.body.classList.toggle("is-unlocked", activePanel === "open");
    },
    clearSensitiveFields() {
      for (const id of [
        "create-passphrase",
        "confirm-passphrase",
        "unlock-passphrase",
        "restore-passphrase",
        "recover-key",
        "restore-recovery-key",
        "restore-new-passphrase",
        "restore-confirm-passphrase",
        "recover-passphrase",
        "recover-confirm-passphrase",
        "settings-confirm-passphrase",
        "settings-new-passphrase",
        "settings-confirm-new-passphrase",
        "settings-check-key-input",
        "import-passphrase",
        "import-recovery-key",
        "profile-name",
        "restore-profile-name",
        "entry-password",
        "entry-totp",
      ]) {
        const input = $(`#${id}`);
        if (input) input.value = "";
      }
      conceal();
      ctx.pages.vault?.updatePasswordStrength();
      passphraseStrength.refreshAll();
    },
    clearVaultView() {
      ctx.recoveryKey?.discard();
      ctx.importer?.close();
      settingsFeature.showRecoveryLocked?.();
      ctx.pages.vault?.clear();
      $("#entry-search").value = "";
      $("#entry-count").textContent = "0";
      $("#entry-list").replaceChildren();
      $("#entry-detail").hidden = true;
      $("#detail-empty").hidden = false;
      $("#detail-name").textContent = "";
      $("#detail-url").textContent = "";
      $("#detail-username").textContent = "";
      $("#detail-password").textContent = "••••••••••••";
      $("#detail-notes").textContent = "";
      $("#detail-notes-field").hidden = true;
      ctx.state.vault.selectedEntryNotes = "";
      ctx.state.vault.selectedEntryHasNotes = false;
      siteIcon.setSiteIcon($("#detail-icon"), "", "");
      for (const id of ["entry-dialog", "history-dialog", "folders-dialog"]) {
        const dialog = $(`#${id}`);
        if (dialog.open) dialog.close();
      }
      ctx.pages.access?.closeProfileDeleteDialog();
      $("#entry-form").reset();
      $("#entry-form-error").hidden = true;
    },
    reportActivity() {
      const now = Date.now();
      if (now - ctx.state.ui.lastActivitySentAt < 1000) return;
      ctx.state.ui.lastActivitySentAt = now;
      ctx.api.reportActivity();
    },
  };
  return ctx;
}

export { createContext };
