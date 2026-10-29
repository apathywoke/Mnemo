// Logins and items: reading, saving, one-time codes, import, and icons. Methods of VaultStore, added to its prototype by
// ./index.js.
const {
  randomUUID,
} = require("node:crypto");
const { generateTotp, parseTotpInput, toOtpauthUri } = require("../../../totp");
const { describeSshKey } = require("../../../ssh-keys");
const { VAULT_SCHEMA_VERSION, MAX_ENTRIES, UUID_PATTERN } = require("./constants");
const {
  sealTotp,
  openTotp,
  sealPassword,
  openPassword,
  sealItemSecret,
  openItemSecret,
} = require("./crypto");
const {
  normalizeItemInput,
  toEntrySummary,
  toEntryDetails,
  isValidFavicon,
  normalizeLoginInput,
} = require("./entries");
const { withMeta, historyAfterChange, contentChanged } = require("./history");

class VaultStoreEntries {
  // Returns display metadata only. Passwords and notes stay in the main process
  // until a caller asks for one entry explicitly.
  listEntries() {
    this.requireUnlocked();
    return this.vaultData.entries
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(toEntrySummary);
  }

  getEntry(id) {
    return toEntryDetails(this.findEntry(id));
  }

  revealPassword(id) {
    const entry = this.findEntry(id);
    if (entry.type !== "login") throw new Error("Invalid login entry.");
    try {
      return openPassword(entry.password, this.dataKey, entry.id);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // A secret field of a card, identity, or SSH key, for copy or reveal.
  revealItemSecret(id, field) {
    const entry = this.findEntry(id);
    if (entry.type === "login" || !Object.hasOwn(entry.secrets, field)) {
      throw new Error("Could not copy this value.");
    }
    try {
      return openItemSecret(entry.secrets[field], this.dataKey, entry.id, field);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
  }

  // Builds the stored form of an item from normalized input, keeping secrets
  // that were left blank and recomputing derived fields.
  buildItemEntry(normalized, existing, id, timestamp) {
    const secrets = {};
    const plainSecrets = {};
    for (const [key, value] of Object.entries(normalized.secrets)) {
      if (value) {
        // Re-entering the same value keeps the sealed record, so the save
        // does not count as a change.
        let current = null;
        if (existing?.secrets[key]) {
          try {
            current = openItemSecret(existing.secrets[key], this.dataKey, id, key);
          } catch {
            current = null;
          }
        }
        secrets[key] = current === value ? existing.secrets[key] : sealItemSecret(value, this.dataKey, id, key);
        plainSecrets[key] = value;
      } else if (existing?.secrets[key]) {
        secrets[key] = existing.secrets[key];
      }
    }
    const secretValue = (key) =>
      plainSecrets[key] ??
      (existing?.secrets[key] ? openItemSecret(existing.secrets[key], this.dataKey, id, key) : "");

    const fields = { ...normalized.plain };
    if (normalized.type === "card") {
      const number = secretValue("number");
      if (number) fields.last4 = number.slice(-4);
    } else if (normalized.type === "ssh") {
      const privateKey = secretValue("privateKey");
      if (!privateKey && !fields.publicKey.trim()) throw new Error("Add a private or public key.");
      const described = describeSshKey({
        privateKey,
        publicKey: fields.publicKey,
        passphrase: secretValue("passphrase"),
      });
      fields.publicKey = described.publicKey;
      if (described.keyType) fields.keyType = described.keyType;
      if (described.fingerprint) fields.fingerprint = described.fingerprint;
    }
    for (const key of Object.keys(fields)) {
      if (fields[key] === "") delete fields[key];
    }
    return {
      id,
      type: normalized.type,
      name: normalized.name,
      notes: normalized.notes,
      fields,
      secrets,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: Math.max(timestamp, existing?.createdAt ?? 0),
    };
  }

  async saveItem(input) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const normalized = normalizeItemInput(input);
      const existingIndex = normalized.id
        ? this.vaultData.entries.findIndex((entry) => entry.id === normalized.id)
        : -1;
      if (normalized.id && existingIndex === -1) throw new Error("This login no longer exists.");
      const existing = existingIndex >= 0 ? this.vaultData.entries[existingIndex] : null;
      if (existing && existing.type !== normalized.type) throw new Error("Invalid login entry.");
      if (existing?.deletedAt) throw new Error("Restore this item from the trash first.");
      if (!existing && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }
      const folderId = this.folderIdFor(normalized.folderId);
      const now = Date.now();
      const content = this.buildItemEntry(normalized, existing, existing?.id ?? randomUUID(), now);
      const saved = this.withSavedContent(existing, content, folderId, now);
      if (saved === existing) return toEntryDetails(existing);
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = saved;
      else entries.push(saved);
      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntryDetails(saved);
    });
  }

  // The current one-time code for an entry. The secret stays here.
  getTotpCode(id, now = Date.now()) {
    const entry = this.findEntry(id);
    if (!entry.totp) throw new Error("This login has no one-time code.");
    let config;
    try {
      config = openTotp(entry.totp, this.dataKey, entry.id);
    } catch {
      throw new Error("Could not read the one-time code settings.");
    }
    return generateTotp(config, now);
  }

  findEntry(id) {
    this.requireUnlocked();
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new Error("Invalid login entry.");
    }
    const entry = this.vaultData.entries.find((item) => item.id === id);
    if (!entry) throw new Error("This login no longer exists.");
    return entry;
  }

  async saveEntry(input) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      const normalized = normalizeLoginInput(input);
      const existingIndex = normalized.id
        ? this.vaultData.entries.findIndex((entry) => entry.id === normalized.id)
        : -1;

      if (normalized.id && existingIndex === -1) {
        throw new Error("This login no longer exists.");
      }
      if (existingIndex >= 0 && this.vaultData.entries[existingIndex].type !== "login") {
        throw new Error("Invalid login entry.");
      }
      if (existingIndex === -1 && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }

      const existing = existingIndex >= 0
        ? this.vaultData.entries[existingIndex]
        : null;
      if (existing?.deletedAt) throw new Error("Restore this item from the trash first.");
      // An empty password while editing keeps the sealed value, so the editor
      // never needs the current password in the renderer.
      if (!existing && !normalized.password) {
        throw new Error("Enter a password for this login.");
      }
      const folderId = this.folderIdFor(normalized.folderId);
      const id = existing?.id ?? randomUUID();
      const totpConfig = normalized.totp ? parseTotpInput(normalized.totp) : null;
      const now = Date.now();
      const timestamp = Math.max(now, existing?.createdAt ?? 0);
      const content = {
        id,
        type: "login",
        name: normalized.name,
        username: normalized.username,
        password: normalized.password
          ? this.resealedPassword(existing, id, normalized.password)
          : existing.password,
        url: normalized.url,
        notes: normalized.notes,
        favicon: existing?.favicon ?? "",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (totpConfig) {
        content.totp = this.resealedTotp(existing, id, totpConfig);
      } else if (existing?.totp && !normalized.removeTotp) {
        content.totp = existing.totp;
      }
      const savedEntry = this.withSavedContent(existing, content, folderId, now);
      if (savedEntry === existing) return toEntryDetails(existing);
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = savedEntry;
      else entries.push(savedEntry);

      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntryDetails(savedEntry);
    });
  }

  // Adds logins from an import ({ name, username, password, url, notes }) in
  // one save. Entries that fail validation or already exist with the same
  // name, username, website, and password are skipped and counted.
  async importLogins(logins) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (!Array.isArray(logins)) throw new Error("Invalid login entry.");
      const entries = this.vaultData.entries.slice();
      const existingKeys = new Map();
      for (const entry of entries) {
        // An item in the trash does not hide an imported copy.
        if (entry.deletedAt) continue;
        const key = entry.type === "login"
          ? JSON.stringify([entry.name, entry.username, entry.url])
          : JSON.stringify([entry.type, entry.name, entry.fields]);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
      }

      let imported = 0;
      let duplicates = 0;
      let invalid = 0;
      let totpSkipped = 0;
      const timestamp = Date.now();
      for (const login of logins) {
        // Cards, notes, identities, and SSH keys (from Mnemo backups).
        if (login?.type && login.type !== "login") {
          let entry;
          try {
            const normalized = normalizeItemInput({
              id: "",
              type: login.type,
              name: login.name,
              notes: login.notes ?? "",
              fields: login.fields ?? {},
            });
            entry = this.buildItemEntry(normalized, null, randomUUID(), timestamp);
          } catch {
            invalid += 1;
            continue;
          }
          const key = JSON.stringify([entry.type, entry.name, entry.fields]);
          if (existingKeys.has(key)) {
            duplicates += 1;
            continue;
          }
          if (entries.length >= MAX_ENTRIES) throw new Error("The vault has reached its entry limit.");
          entries.push(entry);
          existingKeys.set(key, [entry]);
          imported += 1;
          continue;
        }
        let normalized;
        try {
          normalized = normalizeLoginInput({ id: "", ...login });
          if (!normalized.password) throw new Error("missing password");
        } catch {
          invalid += 1;
          continue;
        }
        const key = JSON.stringify([normalized.name, normalized.username, normalized.url]);
        const sameLabel = (existingKeys.get(key) ?? []).filter((entry) => entry.type === "login");
        if (sameLabel.some((entry) => openPassword(entry.password, this.dataKey, entry.id) === normalized.password)) {
          duplicates += 1;
          continue;
        }
        if (entries.length >= MAX_ENTRIES) {
          throw new Error("The vault has reached its entry limit.");
        }
        const id = randomUUID();
        const entry = {
          id,
          type: "login",
          name: normalized.name,
          username: normalized.username,
          password: sealPassword(normalized.password, this.dataKey, id),
          url: normalized.url,
          notes: normalized.notes,
          favicon: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        // A one-time code in an unsupported form does not block the login.
        if (normalized.totp) {
          try {
            entry.totp = sealTotp(parseTotpInput(normalized.totp), this.dataKey, id);
          } catch {
            totpSkipped += 1;
          }
        }
        entries.push(entry);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
        imported += 1;
      }

      if (imported > 0) {
        await this.persistVaultData(this.nextVaultData({ entries }));
      }
      return { imported, duplicates, invalid, totpSkipped };
    });
  }

  async saveFavicon(id, favicon) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (
        typeof id !== "string" ||
        !UUID_PATTERN.test(id) ||
        typeof favicon !== "string" ||
        favicon === "" ||
        !isValidFavicon(favicon)
      ) {
        throw new Error("The website icon is invalid.");
      }

      const existingIndex = this.vaultData.entries.findIndex(
        (entry) => entry.id === id,
      );
      if (existingIndex === -1 || this.vaultData.entries[existingIndex].type !== "login") {
        throw new Error("This login no longer exists.");
      }
      if (this.vaultData.entries[existingIndex].deletedAt) {
        throw new Error("Restore this item from the trash first.");
      }

      const savedEntry = {
        ...this.vaultData.entries[existingIndex],
        favicon,
      };
      const entries = this.vaultData.entries.slice();
      entries[existingIndex] = savedEntry;
      await this.persistVaultData(this.nextVaultData({ entries }));
      return toEntrySummary(savedEntry);
    });
  }

  // --- Saving content ------------------------------------------------------------

  nextVaultData(changes) {
    return {
      schemaVersion: VAULT_SCHEMA_VERSION,
      entries: changes.entries ?? this.vaultData.entries,
      folders: changes.folders ?? this.vaultData.folders,
    };
  }

  async replaceEntry(entry, next) {
    const index = this.vaultData.entries.indexOf(entry);
    if (index === -1) throw new Error("This login no longer exists.");
    const entries = this.vaultData.entries.slice();
    entries[index] = next;
    await this.persistVaultData(this.nextVaultData({ entries }));
  }

  // Editor input to a folder: undefined keeps the current folder, null means
  // none, and an ID must name an existing folder.
  folderIdFor(folderId) {
    if (folderId === undefined || folderId === null) return folderId;
    if (!this.vaultData.folders.some((folder) => folder.id === folderId)) {
      throw new Error("This folder no longer exists.");
    }
    return folderId;
  }

  // Combines saved content with the entry's metadata. A new entry gets the
  // chosen folder. An edit that changes nothing returns `existing` itself; a
  // real change puts the previous content into the history.
  withSavedContent(existing, content, folderId, now) {
    if (!existing) return withMeta(content, null, folderId ? { folderId } : {});
    const changed = contentChanged(existing, content);
    const folderChanged = folderId !== undefined && (existing.folderId ?? null) !== folderId;
    if (!changed && !folderChanged) return existing;
    const changes = {};
    if (folderId !== undefined) changes.folderId = folderId;
    if (changed) changes.history = historyAfterChange(existing, now);
    return withMeta(changed ? content : { ...content, updatedAt: existing.updatedAt }, existing, changes);
  }

  // Typing the same password again keeps the sealed record (not a change).
  resealedPassword(existing, id, password) {
    if (existing) {
      try {
        if (openPassword(existing.password, this.dataKey, existing.id) === password) return existing.password;
      } catch {
        // An unreadable value is replaced.
      }
    }
    return sealPassword(password, this.dataKey, id);
  }

  resealedTotp(existing, id, config) {
    if (existing?.totp) {
      try {
        if (toOtpauthUri(openTotp(existing.totp, this.dataKey, existing.id)) === toOtpauthUri(config)) {
          return existing.totp;
        }
      } catch {
        // An unreadable value is replaced.
      }
    }
    return sealTotp(config, this.dataKey, id);
  }
}

module.exports = VaultStoreEntries;
