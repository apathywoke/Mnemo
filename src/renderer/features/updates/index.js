(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText, onChange } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  const BLOCKER_KEYS = Object.freeze({
    notInApplications: "updates.blockerApplications",
    notWritable: "updates.blockerWritable",
    notPackaged: "updates.blockerDevelopment",
    noKeys: "updates.blockerDevelopment",
  });

  // Shows update state from main: a banner across the window when a new
  // version is available or ready, and a status line in Settings. Main does
  // the checking, downloading, verification, and installation.
  function init(ctx) {
    const banner = $("#update-banner");
    const title = $("#update-banner-title");
    const detail = $("#update-banner-detail");
    const action = $("#update-action-button");
    const notesButton = $("#update-notes-button");
    const notes = $("#update-notes");
    const progress = $("#update-progress");
    const progressBar = $("#update-progress-bar");
    const settingsStatus = $("#settings-update-status");
    const autoUpdate = $("#settings-auto-update");
    const checkButton = $("#settings-check-updates");
    let state = null;
    let dismissedVersion = null;

    function formatTime(timestamp) {
      return new Intl.DateTimeFormat(ns.shared.i18n.language, { dateStyle: "medium", timeStyle: "short" })
        .format(new Date(timestamp));
    }

    function renderBanner() {
      const show = state &&
        ["available", "downloading", "ready"].includes(state.status) &&
        state.version !== dismissedVersion;
      banner.hidden = !show;
      if (!show) return;

      const params = { version: state.version };
      progress.hidden = state.status !== "downloading";
      progressBar.style.width = `${state.progress ?? 0}%`;
      notesButton.hidden = !state.notes;
      notes.textContent = state.notes ?? "";
      $("#update-later-button").hidden = state.status === "downloading";
      action.disabled = state.status === "downloading";

      if (state.status === "ready") {
        title.textContent = t("updates.readyTitle", params);
        detail.textContent = t("updates.readyDetail");
        action.textContent = t("updates.restart");
      } else if (state.status === "downloading") {
        title.textContent = t("updates.downloadingTitle", params);
        detail.textContent = t("updates.downloadingDetail", { percent: state.progress ?? 0 });
        action.textContent = t("updates.downloading");
      } else {
        title.textContent = t("updates.availableTitle", params);
        detail.textContent = state.error
          ? state.error
          : state.canInstall
            ? t("updates.availableDetail")
            : t(BLOCKER_KEYS[state.blocker] ?? "updates.blockerDevelopment");
        action.textContent = t(state.canInstall ? "updates.install" : "updates.download");
      }
      banner.dataset.status = state.status;
      banner.classList.toggle("has-error", Boolean(state.error) && state.status === "available");
    }

    function renderSettings() {
      if (!state) return;
      autoUpdate.checked = state.autoUpdate;
      const current = { version: state.currentVersion };
      let text;
      switch (state.status) {
        case "checking":
          text = t("updates.statusChecking");
          break;
        case "upToDate":
          text = t("updates.statusUpToDate", { ...current, time: formatTime(state.checkedAt) });
          break;
        case "available":
        case "downloading":
          text = t("updates.statusAvailable", { version: state.version, current: state.currentVersion });
          break;
        case "ready":
          text = t("updates.readyTitle", { version: state.version });
          break;
        case "error":
          text = `${t("updates.statusVersion", current)} ${state.error}`;
          break;
        default:
          text = t("updates.statusVersion", current);
      }
      settingsStatus.textContent = text;
      checkButton.disabled = state.status === "checking" || state.status === "downloading";
    }

    // "Later" hides the banner for that version only; a newer one shows again.
    function apply(next) {
      state = next;
      renderBanner();
      renderSettings();
    }

    action.addEventListener("click", async () => {
      try {
        if (state.status === "ready") {
          await ctx.api.installUpdate();
        } else if (state.canInstall) {
          await ctx.api.downloadUpdate();
        } else {
          await ctx.api.openReleasePage();
        }
      } catch (cause) {
        showToast(errorText(cause, "errors.updateInstall"), { type: "error" });
      }
    });
    notesButton.addEventListener("click", () => {
      notes.hidden = !notes.hidden;
      notesButton.setAttribute("aria-expanded", String(!notes.hidden));
    });
    $("#update-later-button").addEventListener("click", () => {
      dismissedVersion = state?.version ?? null;
      renderBanner();
    });
    checkButton.addEventListener("click", async () => {
      try {
        const result = await ctx.api.checkForUpdates();
        if (result.status === "upToDate") showToast(t("updates.toastUpToDate"));
        // A manual check brings back a banner that was put off with "Later".
        dismissedVersion = null;
        apply(result);
      } catch (cause) {
        showToast(errorText(cause, "errors.updateCheck"), { type: "error" });
      }
    });
    autoUpdate.addEventListener("change", async () => {
      try {
        await ctx.api.setAutoUpdate(autoUpdate.checked);
      } catch (cause) {
        autoUpdate.checked = !autoUpdate.checked;
        showToast(errorText(cause, "errors.saveSettings"), { type: "error" });
      }
    });

    ctx.api.onUpdateState(apply);
    onChange(() => {
      renderBanner();
      renderSettings();
    });
    ctx.api.getUpdateState().then(apply).catch(() => {});

    return {};
  }

  ns.features.updates = { init };
})();
