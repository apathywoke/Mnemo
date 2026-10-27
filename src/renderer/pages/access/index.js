(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;
  const { t, errorText } = ns.shared.i18n;

  function create(ctx) {
    const state = ctx.state.access;
    const profiles = $("#profile-list");
    const profileManagement = ns.features.profileManagement.init(ctx, {
      onDeleted: chooseProfiles,
    });

    function renderProfiles() {
      ns.entities.vaultProfile.renderList(profiles, state.availableProfiles, {
        onSelect: selectProfile,
        onDelete: profileManagement.open,
      });
    }

    async function selectProfile(profile, button) {
      button.disabled = true;
      try {
        await ctx.api.selectProfile(profile.id);
        state.selectedProfileId = profile.id;
        state.selectedProfileName = profile.name;
        await refreshState();
      } catch (cause) {
        button.disabled = false;
        $("#fatal-message").textContent = errorText(cause, "errors.openProfile");
        ctx.showPanel("fatal");
      }
    }

    async function refreshProfiles() {
      try {
        state.availableProfiles = await ctx.api.chooseProfile();
        renderProfiles();
        state.selectedProfileId = null;
        state.selectedProfileName = null;
        if (state.availableProfiles.length === 0) {
          $("#setup-back-button").hidden = true;
          ctx.showPanel("setup");
        } else {
          ctx.showPanel("profiles");
        }
      } catch (cause) {
        $("#fatal-message").textContent = errorText(cause, "errors.readProfiles");
        ctx.showPanel("fatal");
      }
    }

    async function chooseProfiles() {
      try {
        state.availableProfiles = await ctx.api.chooseProfile();
        state.selectedProfileId = null;
        state.selectedProfileName = null;
        ctx.clearVaultView();
        ctx.clearSensitiveFields();
        renderProfiles();
        if (state.availableProfiles.length === 0) {
          $("#setup-back-button").hidden = true;
          ctx.showPanel("setup");
        } else {
          ctx.showPanel("profiles");
        }
      } catch (cause) {
        $("#fatal-message").textContent = errorText(cause, "errors.switchProfiles");
        ctx.showPanel("fatal");
      }
    }

    async function refreshState() {
      try {
        const status = await ctx.api.getVaultStatus();
        if (status.unlocked) {
          $("#active-profile-name").textContent = state.selectedProfileName ?? "";
          ctx.showPanel("open");
          await ctx.pages.vault.refreshEntries();
        } else {
          ctx.clearVaultView();
          ctx.clearSensitiveFields();
          if (status.vaultExists) {
            $("#unlock-profile-name").textContent = state.selectedProfileName ?? "";
            ctx.showPanel("unlock");
          } else {
            await refreshProfiles();
          }
        }
      } catch {
        ctx.clearVaultView();
        $("#fatal-message").textContent = t("errors.readStatus");
        ctx.showPanel("fatal");
      }
    }

    async function openNewProfile() {
      try {
        state.availableProfiles = await ctx.api.chooseProfile();
        renderProfiles();
        state.selectedProfileId = null;
        state.selectedProfileName = null;
      } catch (cause) {
        $("#fatal-message").textContent = errorText(cause, "errors.openProfileList");
        ctx.showPanel("fatal");
        return;
      }
      $("#create-form").reset();
      $("#create-error").hidden = true;
      $("#setup-back-button").hidden = state.availableProfiles.length === 0;
      ctx.showPanel("setup");
      $("#profile-name").focus();
    }

    async function openRestorePanel() {
      state.restoringNewProfile = state.selectedProfileId === null;
      if (state.restoringNewProfile) {
        try {
          state.availableProfiles = await ctx.api.chooseProfile();
          renderProfiles();
          state.selectedProfileId = null;
          state.selectedProfileName = null;
        } catch (cause) {
          $("#fatal-message").textContent = errorText(cause, "errors.openProfileList");
          ctx.showPanel("fatal");
          return;
        }
      }
      $("#restore-form").reset();
      $("#restore-error").hidden = true;
      $("#restore-profile-name-field").hidden = !state.restoringNewProfile;
      $("#restore-profile-name").required = state.restoringNewProfile;
      const description = $("#restore-description");
      description.dataset.i18n = state.restoringNewProfile
        ? "restore.descriptionNew"
        : "restore.descriptionReplace";
      description.textContent = t(description.dataset.i18n);
      ctx.showPanel("restore");
      $(state.restoringNewProfile ? "#restore-profile-name" : "#restore-passphrase").focus();
    }

    function openRecoverPanel() {
      $("#recover-form").reset();
      $("#recover-error").hidden = true;
      ctx.showPanel("recover");
      $("#recover-key").focus();
    }

    async function cancelRecover() {
      ctx.clearSensitiveFields();
      $("#recover-error").hidden = true;
      await refreshState();
    }

    async function cancelRestore() {
      ctx.clearSensitiveFields();
      $("#restore-error").hidden = true;
      if (state.selectedProfileId === null) await refreshProfiles();
      else await refreshState();
    }

    async function lockVault() {
      try {
        await ctx.api.lockVault();
        ctx.clearSensitiveFields();
        await refreshState();
        showToast(t("toast.vaultLocked"));
      } catch (cause) {
        showToast(errorText(cause, "errors.lockVault"), { type: "error" });
      }
    }

    ns.features.vaultAccess.bind(ctx, {
      refreshProfiles,
      refreshState,
    });

    ns.shared.i18n.onChange(renderProfiles);

    $("#new-profile-button").addEventListener("click", openNewProfile);
    $("#setup-back-button").addEventListener("click", chooseProfiles);
    $("#restore-profile-button").addEventListener("click", openRestorePanel);
    $("#setup-restore-button").addEventListener("click", openRestorePanel);
    $("#unlock-restore-button").addEventListener("click", openRestorePanel);
    $("#unlock-recover-button").addEventListener("click", openRecoverPanel);
    $("#recover-cancel-button").addEventListener("click", () => void cancelRecover());
    $("#unlock-profiles-button").addEventListener("click", chooseProfiles);
    $("#switch-profile-button").addEventListener("click", chooseProfiles);
    $("#restore-cancel-button").addEventListener("click", () => void cancelRestore());

    return {
      cancelRecover,
      cancelRestore,
      chooseProfiles,
      closeProfileDeleteDialog: profileManagement.close,
      isProfileDeleteDialogOpen: () => profileManagement.isOpen,
      lockVault,
      refreshProfiles,
      refreshState,
    };
  }

  ns.pages.access = { create };
})();
