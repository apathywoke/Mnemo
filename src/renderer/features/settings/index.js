import { $, $$ } from "../../shared/lib/dom.js";
import * as i18n from "../../shared/lib/i18n.js";
import * as passphraseStrength from "../../shared/ui/passphrase-strength.js";
import * as passwordVisibility from "../../shared/ui/password-visibility.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";

let resetVaultActions = () => {};
let savedTheme = "system";
let showVaultLocked = () => {};

// Actions that need the master passphrase again. Each names its prompt,
// confirm label, fallback error, and what to do once the passphrase is in.
const PASSPHRASE_ACTIONS = Object.freeze({
  // Also asks for the new passphrase twice (see the confirm form).
  passphrase: {
    prompt: "settings.passphrasePrompt",
    confirm: "settings.passphraseConfirm",
    error: "errors.changePassphrase",
  },
  recovery: {
    prompt: "settings.recoveryPrompt",
    confirm: "settings.recoveryConfirm",
    error: "errors.createRecoveryKey",
  },
  touchid: {
    prompt: "touchId.prompt",
    confirm: "touchId.confirm",
    error: "errors.touchIdEnable",
  },
  export: {
    prompt: "settings.exportPrompt",
    confirm: "settings.exportConfirm",
    error: "errors.saveBackup",
  },
  exportJson: {
    prompt: "settings.exportOpenPrompt",
    confirm: "settings.exportOpenConfirm",
    error: "errors.exportOpen",
  },
  exportCsv: {
    prompt: "settings.exportOpenPrompt",
    confirm: "settings.exportOpenConfirm",
    error: "errors.exportOpen",
  },
  delete: {
    prompt: "settings.deletePrompt",
    confirm: "settings.deleteConfirm",
    error: "errors.deleteVault",
  },
});

function bind(ctx) {
  const dialog = $("#settings-dialog");
  const languageSelect = $("#settings-language");
  const error = $("#settings-error");

  // Language names stay in their own language so each is recognizable.
  for (const { code, name } of i18n.languages) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    option.lang = code;
    languageSelect.append(option);
  }
  languageSelect.value = i18n.language;
  i18n.onChange((code) => { languageSelect.value = code; });

  languageSelect.addEventListener("change", async () => {
    const requested = languageSelect.value;
    error.hidden = true;
    languageSelect.disabled = true;
    try {
      const settings = await ctx.api.setLanguage(requested);
      i18n.setLanguage(settings.language);
      showToast(i18n.t("toast.languageChanged"));
    } catch (cause) {
      languageSelect.value = i18n.language;
      ctx.setError(error, i18n.errorText(cause, "errors.saveSettings"));
    } finally {
      languageSelect.disabled = false;
    }
  });

  // Theme: applying is done by main through nativeTheme; theme.js follows
  // the resulting prefers-color-scheme change.
  const themeInputs = $$("input[name='settings-theme']", dialog);
  const themeError = $("#settings-theme-error");
  function showSavedTheme() {
    for (const input of themeInputs) input.checked = input.value === savedTheme;
  }
  for (const input of themeInputs) {
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      themeError.hidden = true;
      try {
        savedTheme = (await ctx.api.setTheme(input.value)).theme;
      } catch (cause) {
        ctx.setError(themeError, i18n.errorText(cause, "errors.saveSettings"));
      }
      showSavedTheme();
    });
  }

  // Categories. General works any time; the others act on the open vault
  // and show a hint instead while it is locked.
  const tabs = $$("[data-settings-tab]", dialog);
  let activeTab = "general";

  function selectTab(name, { focus = false } = {}) {
    activeTab = name;
    resetVaultActions();
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`#${tab.getAttribute("aria-controls")}`).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.settingsTab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next = {
        ArrowDown: index + 1,
        ArrowRight: index + 1,
        ArrowUp: index - 1,
        ArrowLeft: index - 1,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      selectTab(target.dataset.settingsTab, { focus: true });
    });
  }

  const paneBodies = $$(".settings-pane-body", dialog);
  const lockedHints = $$(".settings-pane-locked", dialog);
  const actionButtons = $$("[data-settings-action]", dialog);
  function setVaultUnlocked(unlocked) {
    for (const body of paneBodies) body.hidden = !unlocked;
    for (const hint of lockedHints) hint.hidden = unlocked;
  }
  const recoveryStatus = $("#settings-recovery-status");
  const snapshotStatus = $("#settings-snapshot-status");
  const outsideStatus = $("#settings-outside-status");
  const outsideProblem = $("#settings-outside-problem");
  const outsideWarning = $("#settings-outside-warning");
  const outsideChoose = $("#settings-outside-choose");
  const outsideCopy = $("#settings-outside-copy");
  const outsideStop = $("#settings-outside-stop");
  const outsideError = $("#settings-outside-error");
  const recoveryButton = $("#settings-recovery-button");
  const confirmForm = $("#settings-confirm-form");
  const confirmPrompt = $("#settings-confirm-prompt");
  const confirmPassphrase = $("#settings-confirm-passphrase");
  const confirmSubmit = $("#settings-confirm-submit");
  const confirmError = $("#settings-confirm-error");
  const newPassphraseFields = $("#settings-new-passphrase-fields");
  const newPassphrase = $("#settings-new-passphrase");
  const confirmNewPassphrase = $("#settings-confirm-new-passphrase");
  const touchIdStatus = $("#settings-touchid-status");
  const touchIdEnable = $("#settings-touchid-enable");
  const touchIdDisable = $("#settings-touchid-disable");
  let recoveryEnabled = null;
  let recoveryConfirmed = true;
  let touchId = null;
  let snapshots = null;
  let outside = null;
  let pendingAction = null;
  const formatDateTime = (time) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));

  function renderVault() {
    recoveryStatus.textContent = recoveryEnabled === null
      ? ""
      : i18n.t(!recoveryEnabled
        ? "settings.recoveryMissing"
        : recoveryConfirmed ? "settings.recoveryEnabled" : "settings.recoveryUnconfirmed");
    recoveryButton.hidden = recoveryEnabled === null;
    recoveryButton.textContent = i18n.t(
      recoveryEnabled ? "settings.recoveryReplace" : "settings.recoveryCreate",
    );
    touchIdStatus.textContent = touchId === null
      ? ""
      : i18n.t(!touchId.available
        ? "touchId.unavailable"
        : touchId.enabled ? "touchId.enabled" : "touchId.disabled");
    snapshotStatus.textContent = snapshots === null
      ? ""
      : snapshots.failedAt !== null
        ? i18n.t("settings.snapshotFailed")
        : snapshots.lastVerifiedAt === null
          ? i18n.t("settings.snapshotNone")
          : i18n.t("settings.snapshotLast", { date: formatDateTime(snapshots.lastVerifiedAt) });
    snapshotStatus.classList.toggle("settings-hint-warning", (snapshots?.failedAt ?? null) !== null);
    renderOutside();
    touchIdEnable.hidden = !touchId?.available || touchId.enabled;
    touchIdDisable.hidden = !touchId?.available || !touchId.enabled;
    if (pendingAction) {
      confirmPrompt.textContent = i18n.t(PASSPHRASE_ACTIONS[pendingAction].prompt);
      confirmSubmit.textContent = i18n.t(PASSPHRASE_ACTIONS[pendingAction].confirm);
    }
  }

  // The copy outside this Mac: where to, when it was last checked, and what
  // went wrong.
  function renderOutside() {
    const folder = outside?.folderName ?? null;
    outsideStatus.textContent = outside === null
      ? ""
      : folder === null
        ? i18n.t("settings.outsideNone")
        : outside.verifiedAt !== null
          ? i18n.t("settings.outsideLast", { folder, date: formatDateTime(outside.verifiedAt) })
          : i18n.t("settings.outsideNever", { folder });
    const failed = folder !== null && outside.failedAt !== null &&
      (outside.verifiedAt === null || outside.failedAt > outside.verifiedAt);
    outsideProblem.hidden = !failed;
    outsideProblem.textContent = failed
      ? i18n.t("settings.outsideFailed", {
        date: formatDateTime(outside.failedAt),
        reason: i18n.t(`settings.outsideFailure${outside.failure.charAt(0).toUpperCase()}${outside.failure.slice(1)}`),
      })
      : "";
    const warning = folder !== null ? outside.warning : null;
    outsideWarning.hidden = warning === null;
    outsideWarning.textContent = warning === "same-disk"
      ? i18n.t("settings.outsideSameDisk")
      : warning === "unreliable-disk" ? i18n.t("settings.outsideUnreliableDisk") : "";
    outsideChoose.hidden = outside === null;
    outsideChoose.textContent = i18n.t(folder === null ? "settings.outsideChoose" : "settings.outsideChange");
    outsideCopy.hidden = folder === null;
    outsideStop.hidden = folder === null;
  }

  async function runOutside(button, call) {
    outsideError.hidden = true;
    for (const other of [outsideChoose, outsideCopy, outsideStop]) other.disabled = true;
    try {
      const result = await call();
      if (result?.canceled) return;
      outside = result?.status ?? result;
      renderOutside();
    } catch (cause) {
      ctx.setError(outsideError, i18n.errorText(cause, "errors.outsideCopy"));
    } finally {
      for (const other of [outsideChoose, outsideCopy, outsideStop]) other.disabled = false;
      button.focus();
    }
  }

  outsideChoose.addEventListener("click", () => runOutside(outsideChoose, () => ctx.api.chooseOutsideFolder()));
  outsideCopy.addEventListener("click", () => runOutside(outsideCopy, () => ctx.api.copyOutsideNow()));
  outsideStop.addEventListener("click", () => runOutside(outsideStop, () => ctx.api.stopOutsideCopies()));
  $("#settings-restore-snapshot").addEventListener("click", () => {
    dialog.close();
    void ctx.pages.access.openSnapshotsForVault();
  });

  resetVaultActions = () => {
    pendingAction = null;
    confirmForm.reset();
    confirmForm.hidden = true;
    confirmError.hidden = true;
    confirmSubmit.classList.remove("danger-confirm-button");
    showNewPassphrase(false);
    passwordVisibility.conceal(confirmForm);
    passphraseStrength.refreshAll();
    for (const button of actionButtons) button.disabled = false;
  };

  showVaultLocked = () => {
    resetVaultActions();
    recoveryEnabled = null;
    setVaultUnlocked(false);
  };

  async function refreshVault() {
    if (!document.body.classList.contains("is-unlocked")) {
      showVaultLocked();
      return;
    }
    resetVaultActions();
    setVaultUnlocked(true);
    recoveryEnabled = null;
    touchId = null;
    snapshots = null;
    outside = null;
    outsideError.hidden = true;
    renderVault();
    try {
      let recovery;
      [recovery, touchId, snapshots, outside] = await Promise.all([
        ctx.api.getRecoveryStatus(),
        ctx.api.getTouchIdStatus(),
        ctx.api.getSnapshotStatus().catch(() => null),
        ctx.api.getOutsideCopyStatus().catch(() => null),
      ]);
      recoveryEnabled = recovery.enabled;
      recoveryConfirmed = recovery.confirmed !== false || recovery.pending === true;
      renderVault();
    } catch {
      showVaultLocked();
    }
  }

  function showNewPassphrase(show) {
    newPassphraseFields.hidden = !show;
    newPassphrase.required = show;
    confirmNewPassphrase.required = show;
  }

  function askPassphrase(action, button) {
    resetVaultActions();
    pendingAction = action;
    confirmSubmit.classList.toggle("danger-confirm-button", action === "delete");
    showNewPassphrase(action === "passphrase");
    renderVault();
    // The form sits under the section of the action it confirms, not at
    // the end of the pane (which put it below unrelated sections).
    button.closest(".settings-section").after(confirmForm);
    for (const other of actionButtons) {
      other.disabled = other.dataset.settingsAction !== action;
    }
    confirmForm.hidden = false;
    confirmPassphrase.focus();
  }

  async function runAction(action, passphrase) {
    // Both replace the recovery key after a native warning in main;
    // cancelling it leaves the form as it was.
    if (action === "passphrase") {
      const result = await ctx.api.changePassphrase(passphrase, newPassphrase.value);
      if (result.canceled) return;
      resetVaultActions();
      dialog.close();
      // The vault key changed, so Touch ID was turned off in main.
      await ctx.recoveryKey.show(result.recoveryKey, { replaced: recoveryEnabled === true });
      showToast(i18n.t("toast.passphraseChanged"));
    } else if (action === "recovery") {
      const result = await ctx.api.createRecoveryKey(passphrase);
      if (result.canceled) return;
      resetVaultActions();
      dialog.close();
      await ctx.recoveryKey.show(result.recoveryKey, { replaced: recoveryEnabled === true });
      showToast(i18n.t("toast.recoveryKeyCreated"));
    } else if (action === "touchid") {
      await ctx.api.enableTouchId(passphrase);
      resetVaultActions();
      touchId = { ...touchId, enabled: true };
      renderVault();
      showToast(i18n.t("toast.touchIdEnabled"));
    } else if (action === "export") {
      const result = await ctx.api.exportBackup(passphrase);
      resetVaultActions();
      if (!result.canceled) showToast(i18n.t("toast.backupSaved"));
    } else if (action === "exportJson" || action === "exportCsv") {
      const result = await ctx.api.exportOpenFormat(passphrase, action === "exportJson" ? "json" : "csv");
      resetVaultActions();
      if (!result.canceled) showToast(i18n.t("toast.exportedOpen"));
    } else if (action === "delete") {
      const result = await ctx.api.deleteActiveVault(passphrase);
      resetVaultActions();
      if (!result.deleted) return;
      dialog.close();
      await ctx.pages.access.chooseProfiles();
      showToast(i18n.t("toast.vaultDeleted"));
    }
  }

  for (const button of actionButtons) {
    button.addEventListener("click", () => askPassphrase(button.dataset.settingsAction, button));
  }
  $("#settings-confirm-cancel").addEventListener("click", resetVaultActions);
  touchIdDisable.addEventListener("click", async () => {
    touchIdDisable.disabled = true;
    try {
      await ctx.api.disableTouchId();
      touchId = { ...touchId, enabled: false };
      renderVault();
      showToast(i18n.t("toast.touchIdDisabled"));
    } catch (cause) {
      showToast(i18n.errorText(cause, "errors.touchIdDisable"), { type: "error" });
    } finally {
      touchIdDisable.disabled = false;
    }
  });
  confirmForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = pendingAction;
    if (!action) return;
    confirmError.hidden = true;
    if (action === "passphrase" && newPassphrase.value !== confirmNewPassphrase.value) {
      ctx.setError(confirmError, i18n.t("errors.passphrasesMismatch"));
      confirmNewPassphrase.focus();
      return;
    }
    confirmSubmit.disabled = true;
    try {
      await runAction(action, confirmPassphrase.value);
    } catch (cause) {
      ctx.setError(confirmError, i18n.errorText(cause, PASSPHRASE_ACTIONS[action].error));
      // A refused new passphrase keeps the current one typed in.
      if (["errors.passphraseWeak", "errors.passphraseTooShort"].includes(i18n.errorKey(cause))) {
        newPassphrase.focus();
      } else {
        confirmPassphrase.value = "";
        confirmPassphrase.focus();
      }
    } finally {
      confirmSubmit.disabled = false;
    }
  });
  $("#settings-import-button").addEventListener("click", () => {
    dialog.close();
    ctx.importer.open();
  });
  dialog.addEventListener("close", resetVaultActions);
  i18n.onChange(renderVault);

  function open(tab = activeTab) {
    error.hidden = true;
    themeError.hidden = true;
    showSavedTheme();
    selectTab(tab);
    dialog.showModal();
    void refreshVault();
  }
  // One button in the access screens' header, one in the vault's; the
  // reminder banners open a category directly.
  for (const button of [$("#settings-button"), $("#vault-settings-button")]) {
    button.addEventListener("click", () => open());
  }
  ctx.openSettings = open;
  $("#close-settings-dialog").addEventListener("click", () => dialog.close());
}

// Applies the saved language before the first screen is shown.
async function loadSettings(ctx) {
  try {
    const settings = await ctx.api.getSettings();
    i18n.setLanguage(settings.language);
    savedTheme = settings.theme ?? "system";
  } catch {
    i18n.setLanguage(i18n.language);
  }
}

const showRecoveryLocked = () => showVaultLocked();

export { bind, loadSettings, showRecoveryLocked };
