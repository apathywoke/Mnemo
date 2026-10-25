const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  createCipheriv,
  createDecipheriv,
  randomUUID,
  randomBytes,
  scrypt,
} = require("node:crypto");

const scryptAsync = promisify(scrypt);
const FORMAT = "local-vault";
const FORMAT_VERSION = 1;
const KDF = Object.freeze({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VAULT_PLAINTEXT_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_FAVICON_BASE64_LENGTH = Math.ceil(MAX_FAVICON_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ENTRY_LIMITS = Object.freeze({
  name: 200,
  username: 1024,
  password: 4096,
  url: 2048,
  notes: 16384,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PASSPHRASE_BYTES = 1024;
const MIN_PASSPHRASE_CHARACTERS = 7;
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function decodeBase64(value, expectedLength, maxLength = expectedLength) {
  if (typeof value !== "string") throw new Error("Invalid vault file");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.length < expectedLength ||
    decoded.length > maxLength
  ) {
    throw new Error("Invalid vault file");
  }
  return decoded;
}

function getHeader(kdf) {
  return { format: FORMAT, version: FORMAT_VERSION, kdf };
}

function getAad(purpose, header) {
  return Buffer.from(
    `local-vault:${purpose}:v${FORMAT_VERSION}:${JSON.stringify(header)}`,
    "utf8",
  );
}

function encryptGcm(plaintext, key, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  return {
    name: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptGcm(record, key, aad, exactCiphertextLength = null) {
  const nonce = decodeBase64(record.nonce, NONCE_BYTES, NONCE_BYTES);
  const tag = decodeBase64(record.tag, TAG_BYTES, TAG_BYTES);
  const ciphertext = decodeBase64(
    record.ciphertext,
    exactCiphertextLength ?? 1,
    MAX_FILE_BYTES,
  );

  if (
    exactCiphertextLength !== null &&
    ciphertext.length !== exactCiphertextLength
  ) {
    throw new Error("Invalid vault file");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string") {
    throw new Error("Enter a master passphrase.");
  }

  const characterCount = Array.from(passphrase).length;
  const byteCount = Buffer.byteLength(passphrase, "utf8");

  if (characterCount < MIN_PASSPHRASE_CHARACTERS) {
    throw new Error(
      `The master passphrase must be at least ${MIN_PASSPHRASE_CHARACTERS} characters long.`,
    );
  }
  if (byteCount > MAX_PASSPHRASE_BYTES) {
    throw new Error("The master passphrase is too long.");
  }
}

async function deriveWrappingKey(passphrase, salt) {
  const passwordBytes = Buffer.from(passphrase, "utf8");
  try {
    return await scryptAsync(passwordBytes, salt, KEY_BYTES, {
      N: KDF.N,
      r: KDF.r,
      p: KDF.p,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    });
  } finally {
    passwordBytes.fill(0);
  }
}

function makeEnvelope(vaultData, wrappingKey, dataKey, salt) {
  const kdf = {
    name: KDF.name,
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString("base64"),
  };
  const header = getHeader(kdf);
  const wrappedKey = encryptGcm(
    dataKey,
    wrappingKey,
    getAad("key-wrap", header),
  );
  const serializedVault = Buffer.from(JSON.stringify(vaultData), "utf8");

  try {
    const data = encryptGcm(
      serializedVault,
      dataKey,
      getAad("vault-data", header),
    );
    return { ...header, keyWrap: wrappedKey, data };
  } finally {
    serializedVault.fill(0);
  }
}

function parseEnvelope(envelope) {
  if (
    !hasExactKeys(envelope, ["format", "version", "kdf", "keyWrap", "data"]) ||
    envelope.format !== FORMAT ||
    envelope.version !== FORMAT_VERSION ||
    !hasExactKeys(envelope.kdf, ["name", "N", "r", "p", "salt"]) ||
    envelope.kdf.name !== KDF.name ||
    envelope.kdf.N !== KDF.N ||
    envelope.kdf.r !== KDF.r ||
    envelope.kdf.p !== KDF.p ||
    !hasExactKeys(envelope.keyWrap, ["name", "nonce", "tag", "ciphertext"]) ||
    !hasExactKeys(envelope.data, ["name", "nonce", "tag", "ciphertext"]) ||
    envelope.keyWrap.name !== "aes-256-gcm" ||
    envelope.data.name !== "aes-256-gcm"
  ) {
    throw new Error("Invalid vault file");
  }

  const salt = decodeBase64(envelope.kdf.salt, SALT_BYTES, SALT_BYTES);
  // Validate lengths and base64 encoding before doing the expensive KDF.
  decodeBase64(envelope.keyWrap.nonce, NONCE_BYTES, NONCE_BYTES);
  decodeBase64(envelope.keyWrap.tag, TAG_BYTES, TAG_BYTES);
  decodeBase64(envelope.keyWrap.ciphertext, KEY_BYTES, KEY_BYTES);
  decodeBase64(envelope.data.nonce, NONCE_BYTES, NONCE_BYTES);
  decodeBase64(envelope.data.tag, TAG_BYTES, TAG_BYTES);
  decodeBase64(envelope.data.ciphertext, 1, MAX_FILE_BYTES);

  return { salt, header: getHeader(envelope.kdf) };
}

function validateVaultData(value) {
  return (
    hasExactKeys(value, ["schemaVersion", "entries"]) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.entries) &&
    value.entries.length <= MAX_ENTRIES &&
    value.entries.every(isValidLoginEntry) &&
    new Set(value.entries.map((entry) => entry.id)).size === value.entries.length
  );
}

function isValidLoginEntry(entry) {
  if (
    (!hasExactKeys(entry, [
      "id",
      "type",
      "name",
      "username",
      "password",
      "url",
      "notes",
      "createdAt",
      "updatedAt",
    ]) &&
      !hasExactKeys(entry, [
        "id",
        "type",
        "name",
        "username",
        "password",
        "url",
        "notes",
        "createdAt",
        "updatedAt",
        "favicon",
      ])) ||
    !UUID_PATTERN.test(entry.id) ||
    entry.type !== "login" ||
    !Number.isSafeInteger(entry.createdAt) ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.createdAt <= 0 ||
    entry.updatedAt < entry.createdAt
  ) {
    return false;
  }

  if (!isValidFavicon(entry.favicon ?? "")) return false;

  for (const field of Object.keys(ENTRY_LIMITS)) {
    if (
      typeof entry[field] !== "string" ||
      entry[field].length > ENTRY_LIMITS[field]
    ) {
      return false;
    }
  }

  if (!entry.name.trim()) return false;
  if (!entry.password) return false;
  return isAllowedWebsite(entry.url);
}

function isValidFavicon(value) {
  if (value === "") return true;
  const prefix = "data:image/png;base64,";
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length > prefix.length + MAX_FAVICON_BASE64_LENGTH
  ) {
    return false;
  }

  const encoded = value.slice(prefix.length);
  const decoded = Buffer.from(encoded, "base64");
  const valid =
    decoded.length >= 24 &&
    decoded.length <= MAX_FAVICON_BYTES &&
    decoded.toString("base64") === encoded &&
    decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    decoded.toString("ascii", 12, 16) === "IHDR" &&
    decoded.readUInt32BE(16) > 0 &&
    decoded.readUInt32BE(20) > 0 &&
    decoded.readUInt32BE(16) <= 512 &&
    decoded.readUInt32BE(20) <= 512;
  decoded.fill(0);
  return valid;
}

function isAllowedWebsite(value) {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function normalizeLoginInput(input) {
  const inputKeys = ["id", "name", "username", "password", "url", "notes"];
  if (!hasExactKeys(input, inputKeys)) {
    throw new Error("Invalid login entry.");
  }

  for (const field of Object.keys(ENTRY_LIMITS)) {
    if (
      typeof input[field] !== "string" ||
      input[field].length > ENTRY_LIMITS[field]
    ) {
      throw new Error(`${field} is invalid or too long.`);
    }
  }

  const name = input.name.trim();
  if (!name) throw new Error("Enter a name for this login.");
  if (!input.password) throw new Error("Enter a password for this login.");

  let url = input.url.trim();
  if (url && !/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (!isAllowedWebsite(url)) {
    throw new Error("Enter a valid website address using HTTP or HTTPS.");
  }

  if (input.id !== "" && !UUID_PATTERN.test(input.id)) {
    throw new Error("Invalid login entry.");
  }

  return { ...input, id: input.id, name, url };
}

class VaultStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    this.sessionEpoch = 0;
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async fileExists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async getStatus() {
    const vaultExists = await this.fileExists();
    return {
      vaultExists,
      unlocked: this.dataKey !== null && this.vaultData !== null,
      entryCount: this.vaultData?.entries.length ?? 0,
    };
  }

  isUnlocked() {
    return this.dataKey !== null && this.vaultData !== null;
  }

  async create(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    validatePassphrase(passphrase);
    if (await this.fileExists()) {
      throw new Error("A vault already exists on this Mac.");
    }

    const salt = randomBytes(SALT_BYTES);
    let wrappingKey = null;
    let dataKey = randomBytes(KEY_BYTES);

    try {
      wrappingKey = await deriveWrappingKey(passphrase, salt);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      const vaultData = { schemaVersion: 1, entries: [] };
      const envelope = makeEnvelope(vaultData, wrappingKey, dataKey, salt);
      await this.writeEnvelope(envelope);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }

      this.sessionEpoch += 1;
      this.dataKey = dataKey;
      this.vaultData = vaultData;
      this.envelope = envelope;
      dataKey = null;
      return this.getStatus();
    } catch (error) {
      if (error.message === "A vault already exists on this Mac.") throw error;
      if (error.message === "Creation was interrupted because the vault was locked.") {
        throw error;
      }
      throw new Error("Could not create the encrypted vault.");
    } finally {
      wrappingKey?.fill(0);
      dataKey?.fill(0);
      salt.fill(0);
    }
  }

  async unlock(passphrase) {
    const sessionEpoch = this.sessionEpoch;
    await this.mutationQueue;
    validatePassphrase(passphrase);
    const opened = await this.decryptVaultFile(this.filePath, passphrase);
    if (this.sessionEpoch !== sessionEpoch) {
      opened.dataKey.fill(0);
      throw new Error("Unlock was interrupted because the vault was locked.");
    }
    this.lock();
    this.dataKey = opened.dataKey;
    this.vaultData = opened.vaultData;
    this.envelope = opened.envelope;
    return this.getStatus();
  }

  getEntries() {
    this.requireUnlocked();
    return this.vaultData.entries
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((entry) => ({ ...entry }));
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
      if (existingIndex === -1 && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }

      const existing = existingIndex >= 0
        ? this.vaultData.entries[existingIndex]
        : null;
      const timestamp = Math.max(Date.now(), existing?.createdAt ?? 0);
      const savedEntry = {
        id: existing?.id ?? randomUUID(),
        type: "login",
        name: normalized.name,
        username: normalized.username,
        password: normalized.password,
        url: normalized.url,
        notes: normalized.notes,
        favicon: existing?.favicon ?? "",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = savedEntry;
      else entries.push(savedEntry);

      const nextVaultData = { schemaVersion: 1, entries };
      await this.persistVaultData(nextVaultData);
      return { ...savedEntry };
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
      if (existingIndex === -1) throw new Error("This login no longer exists.");

      const savedEntry = {
        ...this.vaultData.entries[existingIndex],
        favicon,
      };
      const entries = this.vaultData.entries.slice();
      entries[existingIndex] = savedEntry;
      await this.persistVaultData({ schemaVersion: 1, entries });
      return { ...savedEntry };
    });
  }

  async deleteEntry(id) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        throw new Error("Invalid login entry.");
      }

      const entries = this.vaultData.entries.filter((entry) => entry.id !== id);
      if (entries.length === this.vaultData.entries.length) {
        throw new Error("This login no longer exists.");
      }

      await this.persistVaultData({ schemaVersion: 1, entries });
    });
  }

  requireUnlocked() {
    if (!this.isUnlocked() || !this.envelope) {
      throw new Error("Unlock the vault first.");
    }
  }

  async persistVaultData(vaultData) {
    this.requireUnlocked();
    const sessionEpoch = this.sessionEpoch;
    const dataKey = this.dataKey;
    const plaintext = Buffer.from(JSON.stringify(vaultData), "utf8");
    try {
      if (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) {
        throw new Error("The vault is too large to save.");
      }

      const header = getHeader(this.envelope.kdf);
      const nextEnvelope = {
        ...this.envelope,
        data: encryptGcm(
          plaintext,
          this.dataKey,
          getAad("vault-data", header),
        ),
      };
      await this.writeEnvelope(nextEnvelope);
      if (this.sessionEpoch !== sessionEpoch || this.dataKey !== dataKey) {
        throw new Error("The vault was locked while saving. Unlock it again.");
      }
      this.envelope = nextEnvelope;
      this.vaultData = vaultData;
    } finally {
      plaintext.fill(0);
    }
  }

  async exportBackup(destinationPath) {
    if (!this.isUnlocked()) throw new Error("Unlock the vault first.");

    const resolvedDestination = path.resolve(destinationPath);
    if (resolvedDestination === path.resolve(this.filePath)) {
      throw new Error("Choose a different location for the backup.");
    }

    let encryptedFile = null;
    try {
      const stats = await fs.stat(this.filePath);
      if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
        throw new Error("Invalid vault file");
      }
      encryptedFile = await fs.readFile(this.filePath);
      if (encryptedFile.length <= 0 || encryptedFile.length > MAX_FILE_BYTES) {
        throw new Error("Invalid vault file");
      }
      const envelope = JSON.parse(encryptedFile.toString("utf8"));
      parseEnvelope(envelope);
      await this.writeBytesAtomically(resolvedDestination, encryptedFile);
      return { exported: true };
    } catch {
      throw new Error("Could not create the encrypted backup.");
    } finally {
      encryptedFile?.fill(0);
    }
  }

  async restoreBackup(sourcePath, passphrase) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      validatePassphrase(passphrase);
      const opened = await this.decryptVaultFile(sourcePath, passphrase);

      try {
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        await this.writeEnvelope(opened.envelope);
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        this.lock();
        this.dataKey = opened.dataKey;
        this.vaultData = opened.vaultData;
        this.envelope = opened.envelope;
        opened.dataKey = null;
        return this.getStatus();
      } finally {
        opened.dataKey?.fill(0);
      }
    });
  }

  async decryptVaultFile(filePath, passphrase) {
    let wrappingKey = null;
    let dataKey = null;
    let plaintext = null;
    let salt = null;
    let rawFile = null;

    try {
      const stats = await fs.stat(filePath);
      if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
        throw new Error("Invalid vault file");
      }
      rawFile = await fs.readFile(filePath);
      const envelope = JSON.parse(rawFile.toString("utf8"));
      const parsed = parseEnvelope(envelope);
      salt = parsed.salt;
      wrappingKey = await deriveWrappingKey(passphrase, salt);
      dataKey = decryptGcm(
        envelope.keyWrap,
        wrappingKey,
        getAad("key-wrap", parsed.header),
        KEY_BYTES,
      );
      plaintext = decryptGcm(
        envelope.data,
        dataKey,
        getAad("vault-data", parsed.header),
      );
      const vaultData = JSON.parse(plaintext.toString("utf8"));
      if (!validateVaultData(vaultData)) throw new Error("Invalid vault data");

      const opened = { envelope, vaultData, dataKey };
      dataKey = null;
      return opened;
    } catch {
      throw new Error(
        "Could not open the vault. Check the master passphrase and make sure the vault or backup file is intact.",
      );
    } finally {
      salt?.fill(0);
      wrappingKey?.fill(0);
      dataKey?.fill(0);
      plaintext?.fill(0);
      rawFile?.fill(0);
    }
  }

  lock() {
    this.sessionEpoch += 1;
    this.dataKey?.fill(0);
    this.dataKey = null;
    this.vaultData = null;
    this.envelope = null;
    return { vaultExists: true, unlocked: false, entryCount: 0 };
  }

  async writeEnvelope(envelope) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);

    const contents = Buffer.from(JSON.stringify(envelope), "utf8");
    try {
      await this.writeBytesAtomically(this.filePath, contents);
    } finally {
      contents.fill(0);
    }
  }

  async writeBytesAtomically(destinationPath, contents) {
    const directory = path.dirname(destinationPath);
    const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fileHandle = null;

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      fileHandle = await fs.open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(contents);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fs.rename(temporaryPath, destinationPath);
    } catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

module.exports = VaultStore;
