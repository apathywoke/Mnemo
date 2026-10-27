const { contextBridge, ipcRenderer } = require("electron");

// The UI does not use WebRTC; removing it denies injected scripts an outbound
// channel that webRequest and CSP connect-src do not cover.
contextBridge.executeInMainWorld?.({
  func: () => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
      delete window[name];
    }
  },
});

// Keep this API deliberately small. Add one validated method at a time;
// never expose ipcRenderer, filesystem access, or arbitrary IPC channels.
contextBridge.exposeInMainWorld("vaultApp", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setLanguage: (code) => ipcRenderer.invoke("settings:set-language", code),
  chooseProfile: () => ipcRenderer.invoke("profiles:choose"),
  selectProfile: (profileId) =>
    ipcRenderer.invoke("profiles:select", profileId),
  deleteProfile: (profileId) =>
    ipcRenderer.invoke("profiles:delete", profileId),
  createProfile: (name, passphrase) =>
    ipcRenderer.invoke("profiles:create", name, passphrase),
  // `credentials` is a passphrase or { recoveryKey, newPassphrase }.
  restoreNewProfile: (name, credentials) =>
    ipcRenderer.invoke("profiles:restore-new", name, credentials),
  getVaultStatus: () => ipcRenderer.invoke("vault:get-status"),
  listEntries: () => ipcRenderer.invoke("vault:list-entries"),
  getEntry: (id) => ipcRenderer.invoke("vault:get-entry", id),
  saveEntry: (entry) => ipcRenderer.invoke("vault:save-entry", entry),
  fetchSiteIcon: (entryId) =>
    ipcRenderer.invoke("vault:fetch-site-icon", entryId),
  deleteEntry: (id) => ipcRenderer.invoke("vault:delete-entry", id),
  // Secrets are copied or shown by the main process; the renderer only names
  // the entry and field.
  copyEntryField: (id, field) =>
    ipcRenderer.invoke("vault:copy-entry-field", id, field),
  revealPassword: (id) => ipcRenderer.invoke("vault:reveal-password", id),
  unlockVault: (passphrase) => ipcRenderer.invoke("vault:unlock", passphrase),
  unlockWithTouchId: () => ipcRenderer.invoke("vault:unlock-biometric"),
  getTouchIdStatus: () => ipcRenderer.invoke("biometric:status"),
  enableTouchId: (passphrase) => ipcRenderer.invoke("biometric:enable", passphrase),
  disableTouchId: () => ipcRenderer.invoke("biometric:disable"),
  recoverVault: (recoveryKey, newPassphrase) =>
    ipcRenderer.invoke("vault:recover", recoveryKey, newPassphrase),
  getRecoveryStatus: () => ipcRenderer.invoke("vault:get-recovery-status"),
  createRecoveryKey: (passphrase) =>
    ipcRenderer.invoke("vault:create-recovery-key", passphrase),
  copyRecoveryKey: () => ipcRenderer.invoke("recovery:copy"),
  saveRecoveryKey: () => ipcRenderer.invoke("recovery:save"),
  dismissRecoveryKey: () => ipcRenderer.invoke("recovery:dismiss"),
  exportBackup: (passphrase) => ipcRenderer.invoke("vault:export-backup", passphrase),
  exportBackupWithNewKey: () => ipcRenderer.invoke("vault:export-backup-new-key"),
  // Import files are opened and parsed by the main process; only counts come
  // back here. `credentials` is used for Mnemo backups only.
  chooseImportFile: (source, credentials) =>
    ipcRenderer.invoke("import:choose-file", source, credentials),
  commitImport: () => ipcRenderer.invoke("import:commit"),
  trashImportFile: () => ipcRenderer.invoke("import:trash-file"),
  cancelImport: () => ipcRenderer.invoke("import:cancel"),
  deleteActiveVault: (passphrase) => ipcRenderer.invoke("vault:delete-active", passphrase),
  restoreBackup: (credentials) =>
    ipcRenderer.invoke("vault:restore-backup", credentials),
  lockVault: () => ipcRenderer.invoke("vault:lock"),
  reportActivity: () => ipcRenderer.send("vault:activity"),
  onAutoLocked: (callback) => {
    ipcRenderer.on("vault:auto-locked", () => callback());
  },
});
