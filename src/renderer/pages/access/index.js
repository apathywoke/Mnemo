(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { show: showToast } = ns.shared.toast;

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
        $("#fatal-message").textContent = cause.message || "Could not open this vault profile.";
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
        $("#fatal-message").textContent = cause.message || "Could not read the local vault profiles.";
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
        $("#fatal-message").textContent = cause.message || "Could not switch vault profiles.";
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
        $("#fatal-message").textContent = "Could not read the vault status.";
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
        $("#fatal-message").textContent = cause.message || "Could not open the profile list.";
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
          $("#fatal-message").textContent = cause.message || "Could not open the profile list.";
          ctx.showPanel("fatal");
          return;
        }
      }
      $("#restore-form").reset();
      $("#restore-error").hidden = true;
      $("#restore-profile-name-field").hidden = !state.restoringNewProfile;
      $("#restore-profile-name").required = state.restoringNewProfile;
      $("#restore-description").textContent = state.restoringNewProfile
        ? "Choose an encrypted backup and enter its master passphrase. It will be added as a new vault profile."
        : "Choose an encrypted backup and enter its master passphrase. Restoring replaces the selected vault after you confirm.";
      ctx.showPanel("restore");
      $(state.restoringNewProfile ? "#restore-profile-name" : "#restore-passphrase").focus();
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
        showToast("Vault locked.");
      } catch (cause) {
        showToast(cause.message || "Could not lock the vault.", { type: "error" });
      }
    }

    ns.features.vaultAccess.bind(ctx, {
      refreshProfiles,
      refreshState,
    });

    $("#new-profile-button").addEventListener("click", openNewProfile);
    $("#setup-back-button").addEventListener("click", chooseProfiles);
    $("#restore-profile-button").addEventListener("click", openRestorePanel);
    $("#setup-restore-button").addEventListener("click", openRestorePanel);
    $("#unlock-restore-button").addEventListener("click", openRestorePanel);
    $("#unlock-profiles-button").addEventListener("click", chooseProfiles);
    $("#switch-profile-button").addEventListener("click", chooseProfiles);
    $("#restore-cancel-button").addEventListener("click", () => void cancelRestore());

    return {
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
