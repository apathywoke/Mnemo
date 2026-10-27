(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

  function bind(ctx) {
    async function goBack() {
      if (ctx.state.ui.backNavigationInProgress) return;
      ctx.state.ui.backNavigationInProgress = true;
      try {
        if (ctx.recoveryKey.isOpen) return;
        if (ctx.importer.isOpen) {
          ctx.importer.close();
          return;
        }
        if ($("#settings-dialog").open) {
          $("#settings-dialog").close();
          return;
        }
        if ($("#entry-dialog").open) {
          $("#entry-dialog").close();
          return;
        }
        if ($("#delete-dialog").open) {
          $("#delete-dialog").close();
          return;
        }
        if (ctx.pages.access.isProfileDeleteDialogOpen()) {
          ctx.pages.access.closeProfileDeleteDialog();
          return;
        }
        if (!$("#restore-panel").hidden) {
          await ctx.pages.access.cancelRestore();
          return;
        }
        if (!$("#recover-panel").hidden) {
          await ctx.pages.access.cancelRecover();
          return;
        }
        if (!$("#unlock-panel").hidden) {
          await ctx.pages.access.chooseProfiles();
          return;
        }
        if (!$("#setup-panel").hidden) {
          if (ctx.state.access.availableProfiles.length > 0) {
            await ctx.pages.access.chooseProfiles();
          }
          return;
        }
        if (!$("#open-panel").hidden) {
          const search = $("#entry-search");
          if (document.activeElement === search) {
            if (search.value) {
              search.value = "";
              ctx.pages.vault.renderEntryList();
            } else {
              search.blur();
            }
            return;
          }
          if (ctx.state.vault.selectedEntryId) {
            ctx.pages.vault.renderEntryDetail(null);
            return;
          }
          if (search.value) {
            search.value = "";
            ctx.pages.vault.renderEntryList();
            return;
          }
          await ctx.pages.access.lockVault();
          return;
        }
        if (!$("#fatal-panel").hidden) await ctx.pages.access.chooseProfiles();
      } finally {
        ctx.state.ui.backNavigationInProgress = false;
      }
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (ctx.recoveryKey.isOpen) return;
        const canGoBack =
          ctx.importer.isOpen ||
          $("#settings-dialog").open ||
          $("#entry-dialog").open ||
          $("#delete-dialog").open ||
          ctx.pages.access.isProfileDeleteDialogOpen() ||
          !$("#restore-panel").hidden ||
          !$("#recover-panel").hidden ||
          !$("#unlock-panel").hidden ||
          (!$("#setup-panel").hidden && ctx.state.access.availableProfiles.length > 0) ||
          !$("#open-panel").hidden ||
          !$("#fatal-panel").hidden;
        if (canGoBack) {
          event.preventDefault();
          void goBack();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (document.body.classList.contains("is-unlocked")) $("#entry-search").focus();
      }
    });
    document.addEventListener("pointerdown", () => ctx.reportActivity(), true);
    document.addEventListener("keydown", () => ctx.reportActivity(), true);

    ctx.api.onAutoLocked(() => {
      ctx.clearVaultView();
      ctx.clearSensitiveFields();
      $("#unlock-error").textContent = ns.shared.i18n.t("unlock.autoLocked");
      $("#unlock-error").hidden = false;
      ctx.showPanel("unlock");
    });

    return { goBack };
  }

  ns.app.bindNavigation = bind;
})();
