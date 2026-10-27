const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomUUID,
  randomBytes,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");

const scryptAsync = promisify(scrypt);
const FORMAT = "local-vault";
// Format 2 adds a recovery key: the data key is wrapped a second time under a
// key derived from a random recovery key, and the recovery salt is part of the
// authenticated header. Format 1 files (no recovery key) remain readable.
const FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;
const RECOVERY_KDF = "hkdf-sha256";
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_CHECKSUM_BYTES = 3;
// Crockford Base32: no I, L, O, or U, so the key is easy to read and type.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_KEY_CHARACTERS = ((RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES) * 8) / 5;
const RECOVERY_GROUP_SIZE = 4;
// Schema 1 stored passwords as plain strings inside the encrypted vault data.
// Schema 2 additionally seals each password under the vault key, bound to its
// entry ID, so unlocking does not decrypt every password at once.
const VAULT_SCHEMA_VERSION = 2;
const LEGACY_VAULT_SCHEMA_VERSION = 1;
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
const TEXT_FIELDS = Object.freeze(["name", "username", "url", "notes"]);
// UTF-8 needs at most three bytes per UTF-16 code unit.
const MAX_SEALED_PASSWORD_BYTES = ENTRY_LIMITS.password * 3;
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

function getHeader(kdf, recovery = null) {
  return recovery
    ? { format: FORMAT, version: FORMAT_VERSION, kdf, recovery }
    : { format: FORMAT, version: LEGACY_FORMAT_VERSION, kdf };
}

function headerOf(envelope) {
  return getHeader(envelope.kdf, envelope.recovery ?? null);
}

function getAad(purpose, header) {
  return Buffer.from(
    `local-vault:${purpose}:v${header.version}:${JSON.stringify(header)}`,
    "utf8",
  );
}

function recoveryChecksum(keyBytes) {
  return createHash("sha256").update(keyBytes).digest().subarray(0, RECOVERY_CHECKSUM_BYTES);
}

function encodeRecoveryKey(keyBytes) {
  const bytes = Buffer.concat([keyBytes, recoveryChecksum(keyBytes)]);
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  bytes.fill(0);
  return text.match(new RegExp(`.{1,${RECOVERY_GROUP_SIZE}}`, "g")).join("-");
}

// Accepts any case, spaces, and dashes, and the usual look-alikes (O→0,
// I/L→1). The checksum catches typos before any decryption is attempted.
function decodeRecoveryKey(input) {
  const invalid = () => new Error("The recovery key is not valid. Check it and try again.");
  if (typeof input !== "string" || input.length > 200) throw invalid();
  const text = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (text.length !== RECOVERY_KEY_CHARACTERS) throw invalid();

  const bytes = Buffer.alloc(RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const character of text) {
    const digit = RECOVERY_ALPHABET.indexOf(character);
    if (digit === -1) throw invalid();
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }

  const keyBytes = Buffer.from(bytes.subarray(0, RECOVERY_KEY_BYTES));
  const checksum = bytes.subarray(RECOVERY_KEY_BYTES);
  const valid = timingSafeEqual(checksum, recoveryChecksum(keyBytes));
  bytes.fill(0);
  if (!valid) {
    keyBytes.fill(0);
    throw invalid();
  }
  return keyBytes;
}

// The recovery key already has 256 bits of entropy, so a fast KDF is enough.
function deriveRecoveryWrappingKey(recoveryKeyBytes, salt) {
  return Buffer.from(
    hkdfSync("sha256", recoveryKeyBytes, salt, "local-vault:recovery-wrap", KEY_BYTES),
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

function getPasswordAad(entryId) {
  return Buffer.from(
    `local-vault:entry-password:v${VAULT_SCHEMA_VERSION}:${entryId}`,
    "utf8",
  );
}

function sealPassword(password, dataKey, entryId) {
  const plaintext = Buffer.from(password, "utf8");
  try {
    return encryptGcm(plaintext, dataKey, getPasswordAad(entryId));
  } finally {
    plaintext.fill(0);
  }
}

function openPassword(record, dataKey, entryId) {
  const plaintext = decryptGcm(record, dataKey, getPasswordAad(entryId));
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

function isValidSealedPassword(record) {
  if (
    !hasExactKeys(record, ["name", "nonce", "tag", "ciphertext"]) ||
    record.name !== "aes-256-gcm"
  ) {
    return false;
  }
  try {
    decodeBase64(record.nonce, NONCE_BYTES, NONCE_BYTES);
    decodeBase64(record.tag, TAG_BYTES, TAG_BYTES);
    decodeBase64(record.ciphertext, 1, MAX_SEALED_PASSWORD_BYTES);
    return true;
  } catch {
    return false;
  }
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

// Builds a format 2 envelope with fresh salts and a new recovery key. Returns
// the envelope and the recovery key text, which is shown to the user once.
async function makeEnvelope(vaultData, passphrase, dataKey) {
  const salt = randomBytes(SALT_BYTES);
  const recoverySalt = randomBytes(SALT_BYTES);
  const recoveryKeyBytes = randomBytes(RECOVERY_KEY_BYTES);
  let wrappingKey = null;
  let recoveryWrappingKey = null;
  const serializedVault = Buffer.from(JSON.stringify(vaultData), "utf8");

  try {
    wrappingKey = await deriveWrappingKey(passphrase, salt);
    recoveryWrappingKey = deriveRecoveryWrappingKey(recoveryKeyBytes, recoverySalt);
    const header = getHeader(
      { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString("base64") },
      { name: RECOVERY_KDF, salt: recoverySalt.toString("base64") },
    );
    const envelope = {
      ...header,
      keyWrap: encryptGcm(dataKey, wrappingKey, getAad("key-wrap", header)),
      recoveryWrap: encryptGcm(dataKey, recoveryWrappingKey, getAad("recovery-wrap", header)),
      data: encryptGcm(serializedVault, dataKey, getAad("vault-data", header)),
    };
    return { envelope, recoveryKey: encodeRecoveryKey(recoveryKeyBytes) };
  } finally {
    serializedVault.fill(0);
    wrappingKey?.fill(0);
    recoveryWrappingKey?.fill(0);
    recoveryKeyBytes.fill(0);
    salt.fill(0);
    recoverySalt.fill(0);
  }
}

function isGcmRecord(value) {
  return hasExactKeys(value, ["name", "nonce", "tag", "ciphertext"]) &&
    value.name === "aes-256-gcm";
}

function parseEnvelope(envelope) {
  const hasRecovery = envelope?.version === FORMAT_VERSION;
  const expectedKeys = hasRecovery
    ? ["format", "version", "kdf", "recovery", "keyWrap", "recoveryWrap", "data"]
    : ["format", "version", "kdf", "keyWrap", "data"];
  if (
    !hasExactKeys(envelope, expectedKeys) ||
    envelope.format !== FORMAT ||
    (envelope.version !== FORMAT_VERSION && envelope.version !== LEGACY_FORMAT_VERSION) ||
    (hasRecovery &&
      (!hasExactKeys(envelope.recovery, ["name", "salt"]) ||
        envelope.recovery.name !== RECOVERY_KDF ||
        !isGcmRecord(envelope.recoveryWrap))) ||
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
  let recoverySalt = null;
  if (hasRecovery) {
    recoverySalt = decodeBase64(envelope.recovery.salt, SALT_BYTES, SALT_BYTES);
    decodeBase64(envelope.recoveryWrap.nonce, NONCE_BYTES, NONCE_BYTES);
    decodeBase64(envelope.recoveryWrap.tag, TAG_BYTES, TAG_BYTES);
    decodeBase64(envelope.recoveryWrap.ciphertext, KEY_BYTES, KEY_BYTES);
  }

  return { salt, recoverySalt, header: headerOf(envelope) };
}

function validateVaultData(value) {
  return (
    hasExactKeys(value, ["schemaVersion", "entries"]) &&
    (value.schemaVersion === VAULT_SCHEMA_VERSION ||
      value.schemaVersion === LEGACY_VAULT_SCHEMA_VERSION) &&
    Array.isArray(value.entries) &&
    value.entries.length <= MAX_ENTRIES &&
    value.entries.every((entry) => isValidLoginEntry(entry, value.schemaVersion)) &&
    new Set(value.entries.map((entry) => entry.id)).size === value.entries.length
  );
}

function isValidLoginEntry(entry, schemaVersion) {
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

  for (const field of TEXT_FIELDS) {
    if (
      typeof entry[field] !== "string" ||
      entry[field].length > ENTRY_LIMITS[field]
    ) {
      return false;
    }
  }

  if (!entry.name.trim()) return false;
  if (schemaVersion === LEGACY_VAULT_SCHEMA_VERSION) {
    if (
      typeof entry.password !== "string" ||
      entry.password.length === 0 ||
      entry.password.length > ENTRY_LIMITS.password
    ) {
      return false;
    }
  } else if (!isValidSealedPassword(entry.password)) {
    return false;
  }
  return isAllowedWebsite(entry.url);
}

function upgradeVaultData(vaultData, dataKey) {
  if (vaultData.schemaVersion === VAULT_SCHEMA_VERSION) return vaultData;
  // The legacy password strings already exist in memory after parsing; this
  // seals them so later reads go through revealPassword(). The next save
  // writes schema 2.
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    entries: vaultData.entries.map((entry) => ({
      ...entry,
      password: sealPassword(entry.password, dataKey, entry.id),
    })),
  };
}

function toEntrySummary(entry) {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    username: entry.username,
    url: entry.url,
    favicon: entry.favicon ?? "",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toEntryDetails(entry) {
  return { ...toEntrySummary(entry), notes: entry.notes };
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
    this.issuedRecoveryKey = null;
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

    let dataKey = randomBytes(KEY_BYTES);

    try {
      const vaultData = { schemaVersion: VAULT_SCHEMA_VERSION, entries: [] };
      const { envelope, recoveryKey } = await makeEnvelope(vaultData, passphrase, dataKey);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }
      await this.writeEnvelope(envelope);
      if (this.sessionEpoch !== sessionEpoch) {
        throw new Error("Creation was interrupted because the vault was locked.");
      }

      this.sessionEpoch += 1;
      this.dataKey = dataKey;
      this.vaultData = vaultData;
      this.envelope = envelope;
      this.issuedRecoveryKey = recoveryKey;
      dataKey = null;
      return this.getStatus();
    } catch (error) {
      if (error.message === "A vault already exists on this Mac.") throw error;
      if (error.message === "Creation was interrupted because the vault was locked.") {
        throw error;
      }
      throw new Error("Could not create the encrypted vault.");
    } finally {
      dataKey?.fill(0);
    }
  }

  // The recovery key created with the vault, handed out once.
  takeIssuedRecoveryKey() {
    const recoveryKey = this.issuedRecoveryKey;
    this.issuedRecoveryKey = null;
    return recoveryKey;
  }

  hasRecoveryKey() {
    this.requireUnlocked();
    return this.envelope.version === FORMAT_VERSION;
  }

  // Creates a new recovery key for the open vault; the previous one stops
  // working for this file. The passphrase is required again so that an
  // unattended unlocked app cannot be used to mint a key.
  async createRecoveryKey(passphrase) {
    return this.enqueueMutation(async () => {
      this.requireUnlocked();
      validatePassphrase(passphrase);
      const sessionEpoch = this.sessionEpoch;
      const dataKey = this.dataKey;
      await this.verifyPassphrase(passphrase);
      const { envelope, recoveryKey } = await makeEnvelope(this.vaultData, passphrase, dataKey);
      if (this.sessionEpoch !== sessionEpoch || this.dataKey !== dataKey) {
        throw new Error("The vault was locked while saving. Unlock it again.");
      }
      await this.writeEnvelope(envelope);
      if (this.sessionEpoch !== sessionEpoch || this.dataKey !== dataKey) {
        throw new Error("The vault was locked while saving. Unlock it again.");
      }
      this.envelope = envelope;
      return recoveryKey;
    });
  }

  async verifyPassphrase(passphrase) {
    const header = headerOf(this.envelope);
    const salt = decodeBase64(this.envelope.kdf.salt, SALT_BYTES, SALT_BYTES);
    let wrappingKey = null;
    let unwrapped = null;
    try {
      wrappingKey = await deriveWrappingKey(passphrase, salt);
      unwrapped = decryptGcm(this.envelope.keyWrap, wrappingKey, getAad("key-wrap", header), KEY_BYTES);
      if (!timingSafeEqual(unwrapped, this.dataKey)) throw new Error("mismatch");
    } catch {
      throw new Error("The master passphrase is incorrect.");
    } finally {
      salt.fill(0);
      wrappingKey?.fill(0);
      unwrapped?.fill(0);
    }
  }

  // Opens the vault with its recovery key, sets a new master passphrase, and
  // replaces the recovery key, since the old one has now been typed in.
  async recoverWithKey(recoveryKeyText, newPassphrase) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      validatePassphrase(newPassphrase);
      const recoveryKeyBytes = decodeRecoveryKey(recoveryKeyText);
      let opened = null;
      try {
        opened = await this.decryptVaultFile(this.filePath, { recoveryKeyBytes });
      } finally {
        recoveryKeyBytes.fill(0);
      }

      try {
        const { envelope, recoveryKey } = await makeEnvelope(
          opened.vaultData,
          newPassphrase,
          opened.dataKey,
        );
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Recovery was interrupted because the vault was locked.");
        }
        await this.writeEnvelope(envelope);
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Recovery was interrupted because the vault was locked.");
        }
        this.lock();
        this.dataKey = opened.dataKey;
        this.vaultData = opened.vaultData;
        this.envelope = envelope;
        opened.dataKey = null;
        return { status: await this.getStatus(), recoveryKey };
      } finally {
        opened.dataKey?.fill(0);
      }
    });
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
    try {
      return openPassword(entry.password, this.dataKey, entry.id);
    } catch {
      throw new Error("Could not decrypt this password.");
    }
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
      if (existingIndex === -1 && this.vaultData.entries.length >= MAX_ENTRIES) {
        throw new Error("The vault has reached its entry limit.");
      }

      const existing = existingIndex >= 0
        ? this.vaultData.entries[existingIndex]
        : null;
      // An empty password while editing keeps the sealed value, so the editor
      // never needs the current password in the renderer.
      if (!existing && !normalized.password) {
        throw new Error("Enter a password for this login.");
      }
      const id = existing?.id ?? randomUUID();
      const timestamp = Math.max(Date.now(), existing?.createdAt ?? 0);
      const savedEntry = {
        id,
        type: "login",
        name: normalized.name,
        username: normalized.username,
        password: normalized.password
          ? sealPassword(normalized.password, this.dataKey, id)
          : existing.password,
        url: normalized.url,
        notes: normalized.notes,
        favicon: existing?.favicon ?? "",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const entries = this.vaultData.entries.slice();
      if (existingIndex >= 0) entries[existingIndex] = savedEntry;
      else entries.push(savedEntry);

      const nextVaultData = { schemaVersion: VAULT_SCHEMA_VERSION, entries };
      await this.persistVaultData(nextVaultData);
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
        const key = JSON.stringify([entry.name, entry.username, entry.url]);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
      }

      let imported = 0;
      let duplicates = 0;
      let invalid = 0;
      const timestamp = Date.now();
      for (const login of logins) {
        let normalized;
        try {
          normalized = normalizeLoginInput({ id: "", ...login });
          if (!normalized.password) throw new Error("missing password");
        } catch {
          invalid += 1;
          continue;
        }
        const key = JSON.stringify([normalized.name, normalized.username, normalized.url]);
        const sameLabel = existingKeys.get(key) ?? [];
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
        entries.push(entry);
        if (!existingKeys.has(key)) existingKeys.set(key, []);
        existingKeys.get(key).push(entry);
        imported += 1;
      }

      if (imported > 0) {
        await this.persistVaultData({ schemaVersion: VAULT_SCHEMA_VERSION, entries });
      }
      return { imported, duplicates, invalid };
    });
  }

  // Reads the logins of a Mnemo backup for import, using its passphrase or
  // { recoveryKey }. Returns plain values; the caller must not keep them.
  static async readBackupLogins(filePath, credentials) {
    const reader = new VaultStore(filePath);
    let secret = credentials;
    let recoveryKeyBytes = null;
    if (typeof credentials === "string") {
      validatePassphrase(credentials);
    } else {
      if (!hasExactKeys(credentials, ["recoveryKey"])) {
        throw new Error("The recovery key is not valid. Check it and try again.");
      }
      recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
      secret = { recoveryKeyBytes };
    }
    let opened;
    try {
      opened = await reader.decryptVaultFile(filePath, secret);
    } finally {
      recoveryKeyBytes?.fill(0);
    }
    try {
      return opened.vaultData.entries.map((entry) => ({
        name: entry.name,
        username: entry.username,
        password: openPassword(entry.password, opened.dataKey, entry.id),
        url: entry.url,
        notes: entry.notes,
      }));
    } finally {
      opened.dataKey.fill(0);
    }
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
      await this.persistVaultData({ schemaVersion: VAULT_SCHEMA_VERSION, entries });
      return toEntrySummary(savedEntry);
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

      await this.persistVaultData({ schemaVersion: VAULT_SCHEMA_VERSION, entries });
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

      const header = headerOf(this.envelope);
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

  // `credentials` is the backup's master passphrase, or
  // { recoveryKey, newPassphrase } when that passphrase is forgotten. With a
  // recovery key the backup is re-encrypted under the new passphrase and a new
  // recovery key, available afterwards from takeIssuedRecoveryKey().
  async restoreBackup(sourcePath, credentials) {
    return this.enqueueMutation(async () => {
      const sessionEpoch = this.sessionEpoch;
      let opened;
      let envelope;
      let recoveryKey = null;
      if (typeof credentials === "string") {
        validatePassphrase(credentials);
        opened = await this.decryptVaultFile(sourcePath, credentials);
        envelope = opened.envelope;
      } else {
        if (!hasExactKeys(credentials, ["recoveryKey", "newPassphrase"])) {
          throw new Error("The recovery key is not valid. Check it and try again.");
        }
        validatePassphrase(credentials.newPassphrase);
        const recoveryKeyBytes = decodeRecoveryKey(credentials.recoveryKey);
        try {
          opened = await this.decryptVaultFile(sourcePath, { recoveryKeyBytes });
        } finally {
          recoveryKeyBytes.fill(0);
        }
        try {
          ({ envelope, recoveryKey } = await makeEnvelope(
            opened.vaultData,
            credentials.newPassphrase,
            opened.dataKey,
          ));
        } catch (error) {
          opened.dataKey.fill(0);
          throw error;
        }
      }

      try {
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        await this.writeEnvelope(envelope);
        if (this.sessionEpoch !== sessionEpoch) {
          throw new Error("Restore was interrupted because the vault was locked.");
        }
        this.lock();
        this.dataKey = opened.dataKey;
        this.vaultData = opened.vaultData;
        this.envelope = envelope;
        this.issuedRecoveryKey = recoveryKey;
        opened.dataKey = null;
        return this.getStatus();
      } finally {
        opened.dataKey?.fill(0);
      }
    });
  }

  // `secret` is the master passphrase (string) or { recoveryKeyBytes }.
  async decryptVaultFile(filePath, secret) {
    const usingRecoveryKey = typeof secret !== "string";
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
      if (usingRecoveryKey) {
        if (!parsed.recoverySalt) {
          parsed.salt.fill(0);
          throw Object.assign(new Error("This vault has no recovery key."), { userFacing: true });
        }
        salt = parsed.recoverySalt;
        parsed.salt.fill(0);
        wrappingKey = deriveRecoveryWrappingKey(secret.recoveryKeyBytes, salt);
        dataKey = decryptGcm(
          envelope.recoveryWrap,
          wrappingKey,
          getAad("recovery-wrap", parsed.header),
          KEY_BYTES,
        );
      } else {
        salt = parsed.salt;
        parsed.recoverySalt?.fill(0);
        wrappingKey = await deriveWrappingKey(secret, salt);
        dataKey = decryptGcm(
          envelope.keyWrap,
          wrappingKey,
          getAad("key-wrap", parsed.header),
          KEY_BYTES,
        );
      }
      plaintext = decryptGcm(
        envelope.data,
        dataKey,
        getAad("vault-data", parsed.header),
      );
      const vaultData = JSON.parse(plaintext.toString("utf8"));
      if (!validateVaultData(vaultData)) throw new Error("Invalid vault data");

      const opened = {
        envelope,
        vaultData: upgradeVaultData(vaultData, dataKey),
        dataKey,
      };
      dataKey = null;
      return opened;
    } catch (error) {
      if (error?.userFacing) throw new Error(error.message);
      throw new Error(
        usingRecoveryKey
          ? "Could not open the vault with this recovery key. Check the key and make sure the vault file is intact."
          : "Could not open the vault. Check the master passphrase and make sure the vault or backup file is intact.",
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
    this.issuedRecoveryKey = null;
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
