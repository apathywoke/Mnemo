const panels = {
  profiles: document.querySelector("#profiles-panel"),
  setup: document.querySelector("#setup-panel"),
  unlock: document.querySelector("#unlock-panel"),
  restore: document.querySelector("#restore-panel"),
  open: document.querySelector("#open-panel"),
  fatal: document.querySelector("#fatal-panel"),
};

const createForm = document.querySelector("#create-form");
const profileName = document.querySelector("#profile-name");
const createPassphrase = document.querySelector("#create-passphrase");
const confirmPassphrase = document.querySelector("#confirm-passphrase");
const createError = document.querySelector("#create-error");
const unlockForm = document.querySelector("#unlock-form");
const unlockPassphrase = document.querySelector("#unlock-passphrase");
const unlockError = document.querySelector("#unlock-error");
const restoreForm = document.querySelector("#restore-form");
const restorePassphrase = document.querySelector("#restore-passphrase");
const restoreProfileName = document.querySelector("#restore-profile-name");
const restoreProfileNameField = document.querySelector("#restore-profile-name-field");
const restoreDescription = document.querySelector("#restore-description");
const restoreError = document.querySelector("#restore-error");
const fatalMessage = document.querySelector("#fatal-message");
const versionLabel = document.querySelector("#app-version");
const backupStatus = document.querySelector("#backup-status");

const entryList = document.querySelector("#entry-list");
const entryCount = document.querySelector("#entry-count");
const entrySearch = document.querySelector("#entry-search");
const emptyList = document.querySelector("#empty-list");
const noSearchResults = document.querySelector("#no-search-results");
const entryDetail = document.querySelector("#entry-detail");
const detailEmpty = document.querySelector("#detail-empty");
const entryDialog = document.querySelector("#entry-dialog");
const entryForm = document.querySelector("#entry-form");
const entryFormError = document.querySelector("#entry-form-error");
const entryPasswordInput = document.querySelector("#entry-password");
const passwordLengthInput = document.querySelector("#password-length");
const passwordLengthValue = document.querySelector("#password-length-value");
const passwordStrength = document.querySelector("#password-strength");
const passwordStrengthLabel = document.querySelector("#password-strength-label");
const passwordStrengthMeter = document.querySelector("#password-strength-meter");
const generatedPasswordStrength = document.querySelector("#generated-password-strength");
const generatedPasswordStrengthLabel = document.querySelector("#generated-password-strength-label");
const generatedPasswordStrengthMeter = document.querySelector("#generated-password-strength-meter");
const passwordGeneratorOptions = {
  uppercase: document.querySelector("#password-uppercase"),
  numbers: document.querySelector("#password-numbers"),
  symbols: document.querySelector("#password-symbols"),
};
const fetchSiteIconButton = document.querySelector("#fetch-site-icon-button");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteProfileDialog = document.querySelector("#delete-profile-dialog");
const deleteProfileConfirmInput = document.querySelector("#delete-profile-confirm-input");
const deleteProfileConfirmButton = document.querySelector("#confirm-profile-delete-button");
const deleteProfileError = document.querySelector("#delete-profile-error");
const copyStatus = document.querySelector("#copy-status");
const profileList = document.querySelector("#profile-list");
const activeProfileName = document.querySelector("#active-profile-name");
const unlockProfileName = document.querySelector("#unlock-profile-name");

let entries = [];
let availableProfiles = [];
let selectedProfileId = null;
let selectedProfileName = null;
let restoringNewProfile = false;
let selectedEntryId = null;
let passwordVisible = false;
let fetchingFaviconForId = null;
let copyStatusTimer = null;
let lastActivitySentAt = 0;
let backNavigationInProgress = false;
let pendingProfileToDelete = null;

function setPasswordToggleButton(button, visible) {
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  button.title = visible ? "Hide password" : "Show password";
}

function setPasswordInputVisibility(input, button, visible) {
  input.type = visible ? "text" : "password";
  setPasswordToggleButton(button, visible);
}

function concealPasswordInputs(container = document) {
  for (const button of container.querySelectorAll("[data-password-visibility-for]")) {
    const input = document.getElementById(button.dataset.passwordVisibilityFor);
    if (input) setPasswordInputVisibility(input, button, false);
  }
}

function showPanel(activePanel) {
  concealPasswordInputs();
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== activePanel;
  }
  document.body.classList.toggle("is-unlocked", activePanel === "open");
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearSensitiveFields() {
  createPassphrase.value = "";
  confirmPassphrase.value = "";
  unlockPassphrase.value = "";
  restorePassphrase.value = "";
  profileName.value = "";
  restoreProfileName.value = "";
  entryPasswordInput.value = "";
  concealPasswordInputs();
  updatePasswordStrength();
}

function clearVaultView() {
  entries = [];
  selectedEntryId = null;
  passwordVisible = false;
  entrySearch.value = "";
  entryList.replaceChildren();
  entryCount.textContent = "0";
  entryDetail.hidden = true;
  detailEmpty.hidden = false;
  document.querySelector("#detail-name").textContent = "";
  document.querySelector("#detail-url").textContent = "";
  document.querySelector("#detail-username").textContent = "";
  document.querySelector("#detail-password").textContent = "••••••••••••";
  document.querySelector("#detail-notes").textContent = "";
  document.querySelector("#detail-notes-field").hidden = true;
  setSiteIcon(document.querySelector("#detail-icon"), "", "");
  setPasswordToggleButton(document.querySelector("#toggle-password-button"), false);
  copyStatus.hidden = true;
  backupStatus.hidden = true;
  if (entryDialog.open) entryDialog.close();
  if (deleteDialog.open) deleteDialog.close();
  if (deleteProfileDialog.open) closeDeleteProfileDialog();
  entryForm.reset();
  entryFormError.hidden = true;
}

function reportActivity() {
  const now = Date.now();
  if (now - lastActivitySentAt < 1000) return;
  lastActivitySentAt = now;
  window.vaultApp.reportActivity();
}

async function lockVault() {
  await window.vaultApp.lockVault();
  clearSensitiveFields();
  await refreshState();
}

async function goBack() {
  if (backNavigationInProgress) return;
  backNavigationInProgress = true;

  try {
    if (entryDialog.open) {
      entryDialog.close();
      return;
    }
    if (deleteDialog.open) {
      deleteDialog.close();
      return;
    }
    if (deleteProfileDialog.open) {
      closeDeleteProfileDialog();
      return;
    }
    if (!panels.restore.hidden) {
      await cancelRestore();
      return;
    }
    if (!panels.unlock.hidden) {
      await chooseProfiles();
      return;
    }
    if (!panels.setup.hidden) {
      if (availableProfiles.length > 0) await chooseProfiles();
      return;
    }
    if (!panels.open.hidden) {
      if (document.activeElement === entrySearch) {
        if (entrySearch.value) {
          entrySearch.value = "";
          renderEntryList();
        } else {
          entrySearch.blur();
        }
        return;
      }
      if (selectedEntryId) {
        renderEntryDetail(null);
        return;
      }
      if (entrySearch.value) {
        entrySearch.value = "";
        renderEntryList();
        return;
      }
      await lockVault();
      return;
    }
    if (!panels.fatal.hidden) await chooseProfiles();
  } finally {
    backNavigationInProgress = false;
  }
}

async function refreshState() {
  try {
    const status = await window.vaultApp.getVaultStatus();
    if (status.unlocked) {
      activeProfileName.textContent = selectedProfileName ?? "";
      showPanel("open");
      await refreshEntries();
    } else {
      clearVaultView();
      clearSensitiveFields();
      if (status.vaultExists) {
        unlockProfileName.textContent = selectedProfileName ?? "";
        showPanel("unlock");
      }
      else await refreshProfiles();
    }
  } catch {
    clearVaultView();
    fatalMessage.textContent = "Could not read the vault status.";
    showPanel("fatal");
  }
}

function formatLastOpened(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return "Last opened · Not recorded";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Last opened · Not recorded";
  const formattedDate = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return `Last opened · ${formattedDate}`;
}

function closeDeleteProfileDialog() {
  if (deleteProfileDialog.open) deleteProfileDialog.close();
  pendingProfileToDelete = null;
  deleteProfileConfirmInput.value = "";
  deleteProfileError.hidden = true;
  deleteProfileConfirmButton.disabled = true;
  deleteProfileConfirmButton.textContent = "Delete vault";
}

function openDeleteProfileDialog(profile) {
  pendingProfileToDelete = { id: profile.id, name: profile.name };
  document.querySelector("#delete-profile-name-confirm").textContent = profile.name;
  deleteProfileConfirmInput.value = "";
  deleteProfileError.hidden = true;
  deleteProfileConfirmButton.disabled = true;
  deleteProfileConfirmButton.textContent = "Delete vault";
  deleteProfileDialog.showModal();
  deleteProfileConfirmInput.focus();
}

function renderProfiles() {
  profileList.replaceChildren();
  for (const profile of availableProfiles) {
    const card = document.createElement("div");
    card.className = "profile-card";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-choice";

    const name = document.createElement("span");
    name.className = "profile-choice-name";
    name.textContent = profile.name;
    const meta = document.createElement("span");
    meta.className = "profile-choice-meta";
    meta.textContent = `Encrypted vault · ${formatLastOpened(profile.lastOpenedAt)}`;
    const arrow = document.createElement("span");
    arrow.className = "profile-choice-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    button.append(name, meta, arrow);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await window.vaultApp.selectProfile(profile.id);
        selectedProfileId = profile.id;
        selectedProfileName = profile.name;
        await refreshState();
      } catch (error) {
        button.disabled = false;
        fatalMessage.textContent = error.message || "Could not open this vault profile.";
        showPanel("fatal");
      }
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "profile-delete-button";
    deleteButton.setAttribute("aria-label", `Delete ${profile.name}`);
    deleteButton.title = "Delete vault";
    deleteButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6m4-6v6"/><path d="M5 7l1 13h12l1-13"/><path d="M9 7V4h6v3"/></svg>';
    deleteButton.addEventListener("click", () => openDeleteProfileDialog(profile));

    card.append(button, deleteButton);
    profileList.append(card);
  }
}

async function refreshProfiles() {
  try {
    availableProfiles = await window.vaultApp.chooseProfile();
    renderProfiles();
    selectedProfileId = null;
    selectedProfileName = null;
    if (availableProfiles.length === 0) {
      selectedProfileId = null;
      selectedProfileName = null;
      document.querySelector("#setup-back-button").hidden = true;
      showPanel("setup");
    } else {
      showPanel("profiles");
    }
  } catch (error) {
    fatalMessage.textContent = error.message || "Could not read the local vault profiles.";
    showPanel("fatal");
  }
}

async function chooseProfiles() {
  try {
    availableProfiles = await window.vaultApp.chooseProfile();
    selectedProfileId = null;
    selectedProfileName = null;
    clearVaultView();
    clearSensitiveFields();
    renderProfiles();
    if (availableProfiles.length === 0) {
      document.querySelector("#setup-back-button").hidden = true;
      showPanel("setup");
    } else {
      showPanel("profiles");
    }
  } catch (error) {
    fatalMessage.textContent = error.message || "Could not switch vault profiles.";
    showPanel("fatal");
  }
}

async function openNewProfile() {
  try {
    availableProfiles = await window.vaultApp.chooseProfile();
    renderProfiles();
    selectedProfileId = null;
    selectedProfileName = null;
  } catch (error) {
    fatalMessage.textContent = error.message || "Could not open the profile list.";
    showPanel("fatal");
    return;
  }
  createForm.reset();
  createError.hidden = true;
  document.querySelector("#setup-back-button").hidden = availableProfiles.length === 0;
  showPanel("setup");
  profileName.focus();
}

async function openRestorePanel() {
  restoringNewProfile = selectedProfileId === null;
  if (restoringNewProfile) {
    try {
      availableProfiles = await window.vaultApp.chooseProfile();
      renderProfiles();
      selectedProfileId = null;
      selectedProfileName = null;
    } catch (error) {
      fatalMessage.textContent = error.message || "Could not open the profile list.";
      showPanel("fatal");
      return;
    }
  }
  restoreForm.reset();
  restoreError.hidden = true;
  restoreProfileNameField.hidden = !restoringNewProfile;
  restoreProfileName.required = restoringNewProfile;
  restoreDescription.textContent = restoringNewProfile
    ? "Choose an encrypted backup and enter its master passphrase. It will be added as a new vault profile."
    : "Choose an encrypted backup and enter its master passphrase. Restoring replaces the selected vault after you confirm.";
  showPanel("restore");
  if (restoringNewProfile) restoreProfileName.focus();
  else restorePassphrase.focus();
}

async function cancelRestore() {
  clearSensitiveFields();
  restoreError.hidden = true;
  if (selectedProfileId === null) await refreshProfiles();
  else await refreshState();
}

function getEntry(id) {
  return entries.find((entry) => entry.id === id) ?? null;
}

function secondaryLabel(entry) {
  if (entry.username) return entry.username;
  if (entry.url) {
    try {
      return new URL(entry.url).hostname;
    } catch {
      return entry.url;
    }
  }
  return "Login";
}

function renderEntryList() {
  const query = entrySearch.value.trim().toLocaleLowerCase();
  const filteredEntries = entries.filter((entry) => {
    const searchableText = `${entry.name} ${entry.username} ${entry.url}`;
    return searchableText.toLocaleLowerCase().includes(query);
  });

  entryList.replaceChildren();
  entryCount.textContent = String(entries.length);
  emptyList.hidden = entries.length !== 0;
  noSearchResults.hidden = entries.length === 0 || filteredEntries.length !== 0;
  entryList.hidden = filteredEntries.length === 0;

  for (const entry of filteredEntries) {
    const row = document.createElement("button");
    row.className = "entry-row";
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(entry.id === selectedEntryId));

    const icon = document.createElement("span");
    icon.className = "entry-row-icon";
    icon.setAttribute("aria-hidden", "true");
    setSiteIcon(icon, entry.favicon, Array.from(entry.name)[0] ?? "•");

    const copy = document.createElement("span");
    copy.className = "entry-row-copy";
    const name = document.createElement("span");
    name.className = "entry-row-name";
    name.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "entry-row-meta";
    meta.textContent = secondaryLabel(entry);
    copy.append(name, meta);
    row.append(icon, copy);
    row.addEventListener("click", () => renderEntryDetail(entry.id));
    entryList.append(row);
  }
}

function setSiteIcon(container, favicon, fallbackText) {
  container.replaceChildren();
  container.classList.remove("has-site-icon");

  const fallback = document.createElement("span");
  fallback.className = "site-icon-fallback";
  fallback.textContent = fallbackText || "•";
  container.append(fallback);

  if (
    typeof favicon !== "string" ||
    !favicon.startsWith("data:image/png;base64,")
  ) {
    return;
  }

  const image = document.createElement("img");
  image.className = "site-icon-image";
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", () => {
    image.remove();
    container.classList.remove("has-site-icon");
  }, { once: true });
  image.addEventListener("load", () => {
    container.classList.add("has-site-icon");
  }, { once: true });
  container.append(image);
  image.src = favicon;
}

function renderEntryDetail(id) {
  const entry = getEntry(id);
  if (!entry) {
    selectedEntryId = null;
    entryDetail.hidden = true;
    detailEmpty.hidden = false;
    renderEntryList();
    return;
  }

  selectedEntryId = entry.id;
  passwordVisible = false;
  setSiteIcon(
    document.querySelector("#detail-icon"),
    entry.favicon,
    Array.from(entry.name)[0] ?? "•",
  );
  updateFetchSiteIconButton();
  document.querySelector("#detail-name").textContent = entry.name;
  document.querySelector("#detail-url").textContent = entry.url;
  document.querySelector("#detail-username").textContent =
    entry.username || "—";
  document.querySelector("#detail-password").textContent = "••••••••••••";
  setPasswordToggleButton(document.querySelector("#toggle-password-button"), false);
  document.querySelector("#detail-notes").textContent = entry.notes;
  document.querySelector("#detail-notes-field").hidden = !entry.notes;
  document.querySelector("#copy-username-button").disabled = !entry.username;
  copyStatus.hidden = true;
  entryDetail.hidden = false;
  detailEmpty.hidden = true;
  renderEntryList();
}

function updateFetchSiteIconButton() {
  const entry = getEntry(selectedEntryId);
  fetchSiteIconButton.disabled = !entry?.url || fetchingFaviconForId !== null;
  fetchSiteIconButton.textContent = fetchingFaviconForId === selectedEntryId
    ? "Loading…"
    : entry?.favicon
      ? "Update icon"
      : "Load site icon";
}

async function refreshEntries(preferredId = null, selectFirst = false) {
  entries = await window.vaultApp.getEntries();
  const nextId = preferredId && getEntry(preferredId)
    ? preferredId
    : selectedEntryId && getEntry(selectedEntryId)
      ? selectedEntryId
      : selectFirst
        ? entries[0]?.id ?? null
        : null;

  renderEntryList();
  if (nextId) renderEntryDetail(nextId);
  else {
    selectedEntryId = null;
    entryDetail.hidden = true;
    detailEmpty.hidden = false;
  }
}

function clearEntryForm() {
  entryForm.reset();
  document.querySelector("#entry-id").value = "";
  entryPasswordInput.value = "";
  concealPasswordInputs(entryForm);
  entryFormError.hidden = true;
  passwordLengthValue.value = passwordLengthInput.value;
  updatePasswordStrength();
  updateGeneratedPasswordStrength();
}

function updatePasswordStrength() {
  const result = window.passwordTools.estimatePasswordStrength(entryPasswordInput.value);
  passwordStrength.dataset.strength = result.level;
  passwordStrengthLabel.textContent = result.label;
  passwordStrengthMeter.setAttribute("aria-valuenow", String(result.value));
}

function getPasswordGeneratorOptions() {
  return Object.fromEntries(
    Object.entries(passwordGeneratorOptions).map(([name, checkbox]) => [name, checkbox.checked]),
  );
}

function updateGeneratedPasswordStrength() {
  const result = window.passwordTools.estimateGeneratedPasswordStrength(
    Number(passwordLengthInput.value),
    getPasswordGeneratorOptions(),
  );
  generatedPasswordStrength.dataset.strength = result.level;
  generatedPasswordStrengthLabel.textContent = result.label;
  generatedPasswordStrengthMeter.setAttribute("aria-valuenow", String(result.value));
}

function openNewEntry() {
  clearEntryForm();
  document.querySelector("#entry-dialog-title").textContent = "New login";
  entryDialog.showModal();
  document.querySelector("#entry-name").focus();
}

function openEditEntry() {
  const entry = getEntry(selectedEntryId);
  if (!entry) return;

  clearEntryForm();
  document.querySelector("#entry-dialog-title").textContent = "Edit login";
  document.querySelector("#entry-id").value = entry.id;
  document.querySelector("#entry-name").value = entry.name;
  document.querySelector("#entry-url").value = entry.url;
  document.querySelector("#entry-username").value = entry.username;
  entryPasswordInput.value = entry.password;
  document.querySelector("#entry-notes").value = entry.notes;
  concealPasswordInputs(entryForm);
  updatePasswordStrength();
  entryDialog.showModal();
  document.querySelector("#entry-name").focus();
}

async function copyValue(value) {
  if (!value) return;
  try {
    await window.vaultApp.copySecret(value);
    copyStatus.textContent = "Copied. Clipboard clears in 30 seconds.";
    copyStatus.hidden = false;
    if (copyStatusTimer) clearTimeout(copyStatusTimer);
    copyStatusTimer = setTimeout(() => {
      copyStatus.hidden = true;
    }, 4000);
  } catch {
    copyStatus.textContent = "Could not copy this value.";
    copyStatus.hidden = false;
  }
}

window.vaultApp
  .getVersion()
  .then((version) => {
    versionLabel.textContent = version;
  })
  .catch(() => {
    versionLabel.textContent = "unavailable";
  });

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  concealPasswordInputs(createForm);
  createError.hidden = true;

  if (createPassphrase.value !== confirmPassphrase.value) {
    setError(createError, "The passphrases do not match.");
    return;
  }

  const button = createForm.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Creating…";

  try {
    const created = await window.vaultApp.createProfile(
      profileName.value,
      createPassphrase.value,
    );
    selectedProfileId = created.profile.id;
    selectedProfileName = created.profile.name;
    clearSensitiveFields();
    await refreshState();
  } catch (error) {
    createPassphrase.value = "";
    confirmPassphrase.value = "";
    if (error.message === "The vault was created but remained locked.") {
      await refreshProfiles();
      return;
    }
    setError(createError, error.message || "Could not create the vault.");
  } finally {
    button.disabled = false;
    button.textContent = "Create";
  }
});

unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  concealPasswordInputs(unlockForm);
  unlockError.hidden = true;

  const button = unlockForm.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Unlocking…";

  try {
    await window.vaultApp.unlockVault(unlockPassphrase.value);
    clearSensitiveFields();
    await refreshState();
  } catch (error) {
    setError(unlockError, error.message || "Could not unlock the vault.");
    unlockPassphrase.value = "";
    unlockPassphrase.focus();
  } finally {
    button.disabled = false;
    button.textContent = "Unlock";
  }
});

restoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  concealPasswordInputs(restoreForm);
  restoreError.hidden = true;
  const button = restoreForm.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Checking…";

  try {
    if (restoringNewProfile) {
      const restored = await window.vaultApp.restoreNewProfile(
        restoreProfileName.value,
        restorePassphrase.value,
      );
      if (restored.canceled) {
        await refreshProfiles();
        return;
      }
      selectedProfileId = restored.profile.id;
      selectedProfileName = restored.profile.name;
    } else {
      await window.vaultApp.restoreBackup(restorePassphrase.value);
    }
    clearSensitiveFields();
    await refreshState();
  } catch (error) {
    restorePassphrase.value = "";
    if (error.message === "The vault was restored but the vault remained locked.") {
      await refreshProfiles();
      return;
    }
    setError(restoreError, error.message || "Could not restore the vault.");
    restorePassphrase.focus();
  } finally {
    button.disabled = false;
    button.textContent = "Continue";
  }
});

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  concealPasswordInputs(entryForm);
  entryFormError.hidden = true;
  const button = entryForm.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    const savedEntry = await window.vaultApp.saveEntry({
      id: document.querySelector("#entry-id").value,
      name: document.querySelector("#entry-name").value,
      username: document.querySelector("#entry-username").value,
      password: document.querySelector("#entry-password").value,
      url: document.querySelector("#entry-url").value,
      notes: document.querySelector("#entry-notes").value,
    });
    entryDialog.close();
    await refreshEntries(savedEntry.id);
  } catch (error) {
    setError(entryFormError, error.message || "Could not save this login.");
  } finally {
    button.disabled = false;
    button.textContent = "Save login";
  }
});

document.querySelector("#create-entry-button").addEventListener("click", openNewEntry);
document.querySelector("#empty-create-button").addEventListener("click", openNewEntry);
document.querySelector("#edit-entry-button").addEventListener("click", openEditEntry);
document.querySelector("#cancel-entry-button").addEventListener("click", () => entryDialog.close());
document.querySelector("#close-entry-dialog").addEventListener("click", () => entryDialog.close());
entryDialog.addEventListener("close", clearEntryForm);
for (const button of document.querySelectorAll("[data-password-visibility-for]")) {
  const input = document.getElementById(button.dataset.passwordVisibilityFor);
  if (!input) continue;
  button.addEventListener("click", () => {
    setPasswordInputVisibility(input, button, input.type === "password");
  });
}
entryPasswordInput.addEventListener("input", updatePasswordStrength);
passwordLengthInput.addEventListener("input", () => {
  passwordLengthValue.value = passwordLengthInput.value;
  updateGeneratedPasswordStrength();
});
for (const checkbox of Object.values(passwordGeneratorOptions)) {
  checkbox.addEventListener("change", updateGeneratedPasswordStrength);
}
document.querySelector("#generate-password-button").addEventListener("click", () => {
  entryFormError.hidden = true;
  try {
    entryPasswordInput.value = window.passwordTools.generatePassword(
      Number(passwordLengthInput.value),
      getPasswordGeneratorOptions(),
    );
    updatePasswordStrength();
    entryPasswordInput.focus();
  } catch (error) {
    setError(entryFormError, error.message || "Could not generate a secure password.");
  }
});

document.querySelector("#delete-entry-button").addEventListener("click", () => {
  if (getEntry(selectedEntryId)) deleteDialog.showModal();
});
document.querySelector("#cancel-delete-button").addEventListener("click", () => deleteDialog.close());
document.querySelector("#confirm-delete-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const deletedId = selectedEntryId;
  button.disabled = true;
  try {
    await window.vaultApp.deleteEntry(deletedId);
    deleteDialog.close();
    selectedEntryId = null;
    await refreshEntries(null, true);
  } catch (error) {
    deleteDialog.close();
    copyStatus.textContent = error.message || "Could not delete this login.";
    copyStatus.hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#toggle-password-button").addEventListener("click", () => {
  const entry = getEntry(selectedEntryId);
  if (!entry) return;
  passwordVisible = !passwordVisible;
  document.querySelector("#detail-password").textContent = passwordVisible
    ? entry.password
    : "••••••••••••";
  setPasswordToggleButton(document.querySelector("#toggle-password-button"), passwordVisible);
});

document.querySelector("#copy-username-button").addEventListener("click", () => {
  const entry = getEntry(selectedEntryId);
  if (entry) copyValue(entry.username);
});
document.querySelector("#copy-password-button").addEventListener("click", () => {
  const entry = getEntry(selectedEntryId);
  if (entry) copyValue(entry.password);
});

fetchSiteIconButton.addEventListener("click", async () => {
  const requestedEntry = getEntry(selectedEntryId);
  if (!requestedEntry?.url || fetchingFaviconForId !== null) return;

  fetchingFaviconForId = requestedEntry.id;
  updateFetchSiteIconButton();
  copyStatus.hidden = true;

  try {
    const result = await window.vaultApp.fetchSiteIcon(requestedEntry.id);
    if (result.canceled) return;

    entries = entries.map((entry) =>
      entry.id === result.entry.id ? result.entry : entry,
    );
    renderEntryList();
    if (selectedEntryId === requestedEntry.id) {
      renderEntryDetail(requestedEntry.id);
      copyStatus.textContent = `Icon from ${result.hostname} saved inside the encrypted vault.`;
      copyStatus.hidden = false;
    }
  } catch (error) {
    if (selectedEntryId === requestedEntry.id) {
      copyStatus.textContent = error.message || "Could not load the site icon.";
      copyStatus.hidden = false;
    }
  } finally {
    fetchingFaviconForId = null;
    updateFetchSiteIconButton();
  }
});

entrySearch.addEventListener("input", renderEntryList);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const canGoBack =
      entryDialog.open ||
      deleteDialog.open ||
      deleteProfileDialog.open ||
      !panels.restore.hidden ||
      !panels.unlock.hidden ||
      (!panels.setup.hidden && availableProfiles.length > 0) ||
      !panels.open.hidden ||
      !panels.fatal.hidden;
    if (!canGoBack) return;

    event.preventDefault();
    void goBack();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (document.body.classList.contains("is-unlocked")) entrySearch.focus();
  }
});

document.querySelector("#lock-button").addEventListener("click", async () => {
  await lockVault();
});

document.querySelector("#retry-button").addEventListener("click", refreshState);
document.querySelector("#new-profile-button").addEventListener("click", openNewProfile);
document.querySelector("#setup-back-button").addEventListener("click", chooseProfiles);
deleteProfileConfirmInput.addEventListener("input", () => {
  deleteProfileConfirmButton.disabled =
    !pendingProfileToDelete ||
    deleteProfileConfirmInput.value !== pendingProfileToDelete.name;
});
document
  .querySelector("#cancel-profile-delete-button")
  .addEventListener("click", closeDeleteProfileDialog);
deleteProfileConfirmButton.addEventListener("click", async () => {
  const profile = pendingProfileToDelete;
  if (!profile || deleteProfileConfirmInput.value !== profile.name) return;

  deleteProfileConfirmButton.disabled = true;
  deleteProfileConfirmButton.textContent = "Deleting…";
  deleteProfileError.hidden = true;
  try {
    await window.vaultApp.deleteProfile(profile.id);
    closeDeleteProfileDialog();
    await chooseProfiles();
  } catch (error) {
    setError(deleteProfileError, error.message || "Could not delete this vault.");
  } finally {
    deleteProfileConfirmButton.textContent = "Delete vault";
    deleteProfileConfirmButton.disabled =
      !pendingProfileToDelete ||
      deleteProfileConfirmInput.value !== pendingProfileToDelete.name;
  }
});
document.querySelector("#restore-profile-button").addEventListener("click", openRestorePanel);
document
  .querySelector("#setup-restore-button")
  .addEventListener("click", openRestorePanel);
document
  .querySelector("#unlock-restore-button")
  .addEventListener("click", openRestorePanel);
document.querySelector("#unlock-profiles-button").addEventListener("click", chooseProfiles);
document.querySelector("#switch-profile-button").addEventListener("click", chooseProfiles);
document
  .querySelector("#restore-cancel-button")
  .addEventListener("click", () => void cancelRestore());

document.querySelector("#backup-button").addEventListener("click", async () => {
  backupStatus.hidden = true;
  const button = document.querySelector("#backup-button");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await window.vaultApp.exportBackup();
    if (!result.canceled) {
      backupStatus.textContent = "Encrypted backup saved. Keep the same master passphrase safe; it cannot be recovered if lost.";
      backupStatus.hidden = false;
    }
  } catch (error) {
    backupStatus.textContent = error.message || "Could not save the backup.";
    backupStatus.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Backup";
  }
});

document.addEventListener("pointerdown", reportActivity, true);
document.addEventListener("keydown", reportActivity, true);

passwordLengthValue.value = passwordLengthInput.value;
updateGeneratedPasswordStrength();

window.vaultApp.onAutoLocked(() => {
  clearVaultView();
  clearSensitiveFields();
  unlockError.textContent =
    "Vault locked after your Mac was locked or the app was idle.";
  unlockError.hidden = false;
  showPanel("unlock");
});

refreshProfiles();
