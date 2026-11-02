// Types for the VaultStore that index.js assembles at run time: the class in
// store.js with the methods of every store-*.js class copied onto it. The
// methods of those classes run with `this` set to such a store; they say so
// with `@this {Store}`.
import VaultStoreBase = require("./store");
import VaultStoreKeys = require("./store-keys");
import VaultStoreBackup = require("./store-backup");
import VaultStoreEntries = require("./store-entries");
import VaultStoreOrganize = require("./store-organize");
import VaultStoreAttachments = require("./store-attachments");

declare namespace VaultStore {
  type Instance = VaultStoreBase &
    VaultStoreKeys &
    VaultStoreBackup &
    VaultStoreEntries &
    VaultStoreOrganize &
    VaultStoreAttachments;
}

declare const VaultStore: {
  new (filePath: string): VaultStore.Instance;
  prototype: VaultStore.Instance;
  readBackupLogins: typeof VaultStoreBackup.readBackupLogins;
  attachmentDirectoryFor: typeof VaultStoreAttachments.attachmentDirectoryFor;
};

export = VaultStore;
