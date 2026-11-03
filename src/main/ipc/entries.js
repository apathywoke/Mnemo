// IPC handlers. Entries: listing, saving, copying, and revealing values, and site icons.
const { ITEM_TYPES } = require("../../shared/item-types.js");
const cardTools = require("../../shared/card-tools.js");
const { fetchSiteFavicon, getFaviconHost } = require("../favicon-fetcher");

const COPYABLE_ENTRY_FIELDS = new Set(["username", "password", "totp"]);

function register(ctx) {
  const {
    state,
    tr,
    showVaultDialog,
    showSecretDialog,
    copyToClipboardTemporarily,
    registerHandler,
    takeRevealGrant,
  } = ctx;

  // The renderer gets entry metadata only. Passwords are decrypted in this
  // process on an explicit copy or reveal and are never returned over IPC.
  registerHandler("vault:list-entries", () => state.vaultStore.listEntries());

  registerHandler("vault:get-entry", (entryId) => state.vaultStore.getEntry(entryId));

  // The notes and sealed text (a secure note's body) of one entry, or of one
  // of its earlier versions, only right after a real key or mouse press
  // (src/main/notes-reveal.js). getEntry and getHistory say only whether
  // there is any.
  registerHandler("vault:reveal-notes", (entryId, versionId = null) => {
    if (!takeRevealGrant()) throw new Error("Click Show to read the notes.");
    return state.vaultStore.revealText(entryId, versionId);
  });

  // The current one-time code only; the secret never leaves this process.
  registerHandler(
    "vault:get-totp",
    (entryId) => state.vaultStore.getTotpCode(entryId),
    { countsAsActivity: false },
  );

  registerHandler("vault:save-entry", (entry) =>
    state.vaultStore.saveEntry(entry),
  );

  registerHandler("vault:fetch-site-icon", async (entryId) => {
    if (!state.vaultStore.isUnlocked()) throw new Error("Unlock the vault first.");
    const entry = state.vaultStore.getEntry(entryId);
    if (!entry.url) {
      throw new Error("Add a website address to this login first.");
    }

    const hostname = getFaviconHost(entry.url);
    const confirmation = await showVaultDialog({
      type: "info",
      title: tr("dialog.iconTitle"),
      message: tr("dialog.iconMessage", { hostname }),
      detail: tr("dialog.iconDetail", { hostname }),
      buttons: [tr("common.cancel"), tr("dialog.iconConfirm")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { canceled: true };

    const favicon = await fetchSiteFavicon(entry.url);
    const savedEntry = await state.vaultStore.saveFavicon(entry.id, favicon.dataUrl);
    return {
      canceled: false,
      entry: savedEntry,
      hostname: favicon.hostname,
    };
  });

  // Deleting moves an item to the trash; see vault:delete-forever.
  registerHandler("vault:delete-entry", (id) => state.vaultStore.deleteEntry(id));

  // Item fields a user may copy: schema fields marked `copy` and the SSH
  // fingerprint. Secret fields are read here and never returned.
  function copyableItemValue(entry, field) {
    const schemaField = ITEM_TYPES[entry.type].fields.find((item) => item.key === field);
    if (schemaField?.copy) {
      if (schemaField.kind === "secret") return state.vaultStore.revealItemSecret(entry.id, field);
      // Sealed text (a secure note's body) goes to the clipboard from here,
      // like secrets, without passing through the page.
      if (schemaField.sealed) return state.vaultStore.revealText(entry.id).fields[field] ?? "";
      return entry.fields[field] ?? "";
    }
    if (entry.type === "ssh" && field === "fingerprint") return entry.fields.fingerprint ?? "";
    throw new Error("Could not copy this value.");
  }

  registerHandler("vault:copy-entry-field", (entryId, field) => {
    if (typeof field !== "string") throw new Error("Could not copy this value.");
    const entry = state.vaultStore.getEntry(entryId);
    let value;
    if (entry.type !== "login") {
      value = copyableItemValue(entry, field);
    } else if (!COPYABLE_ENTRY_FIELDS.has(field)) {
      throw new Error("Could not copy this value.");
    } else {
      value = field === "password"
        ? state.vaultStore.revealPassword(entryId)
        : field === "totp"
          ? state.vaultStore.getTotpCode(entryId).code
          : entry.username;
    }
    if (!value) throw new Error("Could not copy this value.");
    return copyToClipboardTemporarily(value);
  });

  registerHandler("vault:save-item", (item) => state.vaultStore.saveItem(item));

  registerHandler("vault:reveal-field", async (entryId, field) => {
    const entry = state.vaultStore.getEntry(entryId);
    if (entry.type === "login" || !entry.secretFields.includes(field)) {
      throw new Error("Could not copy this value.");
    }
    const raw = state.vaultStore.revealItemSecret(entry.id, field);
    // Card numbers are easier to read and compare in groups of four.
    const value = entry.type === "card" && field === "number" ? cardTools.formatNumber(raw) : raw;
    const { copied } = await showSecretDialog({
      entryName: entry.name,
      fieldLabel: tr(`item.field.${entry.type}.${field}`),
      value,
    });
    return { shown: true, copied };
  });

  registerHandler("vault:reveal-password", async (entryId) => {
    const entry = state.vaultStore.getEntry(entryId);
    const password = state.vaultStore.revealPassword(entry.id);
    const { copied } = await showSecretDialog({
      entryName: entry.name,
      fieldLabel: tr("editor.password"),
      value: password,
    });
    return { shown: true, copied };
  });
}

module.exports = { register };
