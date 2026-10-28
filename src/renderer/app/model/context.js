(() => {
  const ns = window.mnemoRenderer;
  const { $, $$ } = ns.shared.dom;
  const { conceal } = ns.shared.passwordVisibility;

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
        },
        vault: {
          entries: [],
          selectedEntryId: null,
          selectedEntryNotes: "",
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
      setError(element, message) {
        ns.shared.dom.setError(element, message);
      },
      showPanel(activePanel) {
        conceal();
        const panels = {
          profiles: $("#profiles-panel"),
          setup: $("#setup-panel"),
          unlock: $("#unlock-panel"),
          restore: $("#restore-panel"),
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
      },
      clearVaultView() {
        ctx.recoveryKey?.discard();
        ctx.importer?.close();
        ns.features.settings.showRecoveryLocked?.();
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
        ns.entities.login.setSiteIcon($("#detail-icon"), "", "");
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

  ns.app.createContext = createContext;
})();
