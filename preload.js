const { contextBridge, ipcRenderer } = require("electron");

// Keep this API deliberately small. Add one validated method at a time;
// never expose ipcRenderer, filesystem access, or arbitrary IPC channels.
contextBridge.exposeInMainWorld("vaultApp", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  chooseProfile: () => ipcRenderer.invoke("profiles:choose"),
  selectProfile: (profileId) =>
    ipcRenderer.invoke("profiles:select", profileId),
  deleteProfile: (profileId) =>
    ipcRenderer.invoke("profiles:delete", profileId),
  createProfile: (name, passphrase) =>
    ipcRenderer.invoke("profiles:create", name, passphrase),
  restoreNewProfile: (name, passphrase) =>
    ipcRenderer.invoke("profiles:restore-new", name, passphrase),
  getVaultStatus: () => ipcRenderer.invoke("vault:get-status"),
  getEntries: () => ipcRenderer.invoke("vault:get-entries"),
  saveEntry: (entry) => ipcRenderer.invoke("vault:save-entry", entry),
  fetchSiteIcon: (entryId) =>
    ipcRenderer.invoke("vault:fetch-site-icon", entryId),
  deleteEntry: (id) => ipcRenderer.invoke("vault:delete-entry", id),
  copySecret: (value) => ipcRenderer.invoke("clipboard:copy-secret", value),
  unlockVault: (passphrase) => ipcRenderer.invoke("vault:unlock", passphrase),
  exportBackup: () => ipcRenderer.invoke("vault:export-backup"),
  restoreBackup: (passphrase) =>
    ipcRenderer.invoke("vault:restore-backup", passphrase),
  lockVault: () => ipcRenderer.invoke("vault:lock"),
  reportActivity: () => ipcRenderer.send("vault:activity"),
  onAutoLocked: (callback) => {
    ipcRenderer.on("vault:auto-locked", () => callback());
  },
});
