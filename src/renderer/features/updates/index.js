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
  // version is available or ready, and a status card in Settings → Updates.
  // Main does the checking, downloading, verification, and installation.
  function init(ctx) {
    const banner = $("#update-banner");
    const title = $("#update-banner-title");
    const detail = $("#update-banner-detail");
    const action = $("#update-action-button");
    const notesButton = $("#update-notes-button");
    const notes = $("#update-notes");
    const progress = $("#update-progress");
    const progressBar = $("#update-progress-bar");
    const card = $("#update-status-card");
    const cardTitle = $("#update-status-title");
    const cardDetail = $("#update-status-detail");
    const cardProgress = $("#update-status-progress");
    const cardProgressBar = $("#update-status-progress-bar");
    const cardAction = $("#settings-update-action");
    const cardNotesButton = $("#settings-update-notes-button");
    const cardNotes = $("#settings-update-notes");
    const tabDot = $("#settings-updates-dot");
    const interval = $("#settings-update-interval");
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

    // Title, detail, and the main button for each state.
    function describe() {
      const current = state.currentVersion;
      const blocked = t(BLOCKER_KEYS[state.blocker] ?? "updates.blockerDevelopment");
      switch (state.status) {
        case "checking":
          return { title: t("updates.cardChecking"), detail: t("updates.cardCurrent", { current }) };
        case "upToDate":
          return {
            title: t("updates.cardUpToDate"),
            detail: t("updates.cardChecked", { current, time: formatTime(state.checkedAt) }),
          };
        case "available":
          return {
            title: t("updates.availableTitle", { version: state.version }),
            detail: state.error || (state.canInstall ? t("updates.cardAvailable", { current }) : blocked),
            action: state.canInstall ? "updates.downloadInstall" : "updates.downloadGitHub",
          };
        case "downloading":
          return {
            title: t("updates.downloadingTitle", { version: state.version }),
            detail: t("updates.downloadingDetail", { percent: state.progress ?? 0 }),
          };
        case "ready":
          return { title: t("updates.readyTitle", { version: state.version }), detail: t("updates.readyDetail"), action: "updates.restart" };
        case "error":
          return { title: t("updates.cardError"), detail: state.error };
        default:
          return {
            title: t("updates.cardCurrent", { current }),
            detail: t(state.updateInterval === "off" ? "updates.cardOff" : "updates.cardNotChecked"),
          };
      }
    }

    function renderSettings() {
      if (!state) return;
      const { title, detail, action: actionKey } = describe();
      card.dataset.status = state.status;
      card.classList.toggle("has-error", Boolean(state.error) && ["available", "error"].includes(state.status));
      cardTitle.textContent = title;
      cardDetail.textContent = detail;
      cardProgress.hidden = state.status !== "downloading";
      cardProgressBar.style.width = `${state.progress ?? 0}%`;
      cardAction.hidden = !actionKey;
      if (actionKey) cardAction.textContent = t(actionKey);
      const hasNotes = Boolean(state.notes) && ["available", "downloading", "ready"].includes(state.status);
      cardNotesButton.hidden = !hasNotes;
      cardNotes.textContent = state.notes ?? "";
      if (!hasNotes) cardNotes.hidden = true;
      cardNotesButton.setAttribute("aria-expanded", String(!cardNotes.hidden));
      checkButton.hidden = state.status === "ready";
      checkButton.disabled = state.status === "checking" || state.status === "downloading";
      tabDot.hidden = !["available", "ready"].includes(state.status);
      interval.value = state.updateInterval;
    }

    // "Later" hides the banner for that version only; a newer one shows again.
    function apply(next) {
      state = next;
      renderBanner();
      renderSettings();
    }

    async function runAction() {
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
    }
    action.addEventListener("click", runAction);
    cardAction.addEventListener("click", runAction);
    for (const [button, panel] of [[notesButton, notes], [cardNotesButton, cardNotes]]) {
      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      });
    }
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
    interval.addEventListener("change", async () => {
      try {
        await ctx.api.setUpdateInterval(interval.value);
      } catch (cause) {
        if (state) interval.value = state.updateInterval;
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
