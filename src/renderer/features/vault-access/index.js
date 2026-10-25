(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { conceal } = ns.shared.passwordVisibility;

  function bind(ctx, access) {
    const createForm = $("#create-form");
    const unlockForm = $("#unlock-form");
    const restoreForm = $("#restore-form");

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(createForm);
      $("#create-error").hidden = true;
      if ($("#create-passphrase").value !== $("#confirm-passphrase").value) {
        ctx.setError($("#create-error"), "The passphrases do not match.");
        return;
      }
      const button = createForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Creating…";
      try {
        const created = await ctx.api.createProfile(
          $("#profile-name").value,
          $("#create-passphrase").value,
        );
        ctx.state.access.selectedProfileId = created.profile.id;
        ctx.state.access.selectedProfileName = created.profile.name;
        ctx.clearSensitiveFields();
        await access.refreshState();
      } catch (cause) {
        $("#create-passphrase").value = "";
        $("#confirm-passphrase").value = "";
        if (cause.message === "The vault was created but remained locked.") {
          await access.refreshProfiles();
          return;
        }
        ctx.setError($("#create-error"), cause.message || "Could not create the vault.");
      } finally {
        button.disabled = false;
        button.textContent = "Create";
      }
    });

    unlockForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(unlockForm);
      $("#unlock-error").hidden = true;
      const button = unlockForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Unlocking…";
      try {
        await ctx.api.unlockVault($("#unlock-passphrase").value);
        ctx.clearSensitiveFields();
        await access.refreshState();
      } catch (cause) {
        ctx.setError($("#unlock-error"), cause.message || "Could not unlock the vault.");
        $("#unlock-passphrase").value = "";
        $("#unlock-passphrase").focus();
      } finally {
        button.disabled = false;
        button.textContent = "Unlock";
      }
    });

    restoreForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      conceal(restoreForm);
      $("#restore-error").hidden = true;
      const button = restoreForm.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Checking…";
      try {
        if (ctx.state.access.restoringNewProfile) {
          const restored = await ctx.api.restoreNewProfile(
            $("#restore-profile-name").value,
            $("#restore-passphrase").value,
          );
          if (restored.canceled) {
            await access.refreshProfiles();
            return;
          }
          ctx.state.access.selectedProfileId = restored.profile.id;
          ctx.state.access.selectedProfileName = restored.profile.name;
        } else {
          await ctx.api.restoreBackup($("#restore-passphrase").value);
        }
        ctx.clearSensitiveFields();
        await access.refreshState();
      } catch (cause) {
        $("#restore-passphrase").value = "";
        if (cause.message === "The vault was restored but the vault remained locked.") {
          await access.refreshProfiles();
          return;
        }
        ctx.setError($("#restore-error"), cause.message || "Could not restore the vault.");
        $("#restore-passphrase").focus();
      } finally {
        button.disabled = false;
        button.textContent = "Continue";
      }
    });
  }

  ns.features.vaultAccess = { bind };
})();
