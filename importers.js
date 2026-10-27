// Parses password-manager exports into Mnemo logins. Runs in the main process
// only: these files hold passwords in plain text and never reach the renderer.
//
// Supported: Bitwarden unencrypted JSON and CSV; 1Password 1PUX and CSV.
// Mnemo stores logins only, so other item types are counted and skipped.
// One-time code (TOTP) settings come along when they are standard; others,
// such as Steam Guard, are counted and left out.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseTotpInput } = require("./totp");

const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_DATA_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_ITEMS = 20000;

const SOURCES = Object.freeze({
  bitwarden: Object.freeze({ extensions: ["json", "csv"] }),
  onepassword: Object.freeze({ extensions: ["1pux", "csv"] }),
});

function emptyStats() {
  return { found: 0, nonLogin: 0, noPassword: 0, archived: 0, withTotp: 0, totpNotImported: 0 };
}

function text(value) {
  return typeof value === "string" ? value : "";
}

// Keeps web addresses only; app links (androidapp://, iosapp://) are dropped.
function pickUrl(candidates) {
  for (const candidate of candidates) {
    const value = text(candidate).trim();
    if (!value) continue;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") return value;
      } catch {
        // Not a URL; try the next candidate.
      }
    } else if (/^[^\s/]+\.[^\s/]+/.test(value)) {
      return value;
    }
  }
  return "";
}

function hostOf(url) {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return "";
  }
}

function toLogin({ name, username, password, url, notes, totp }, fallbackName) {
  const cleanUrl = pickUrl(Array.isArray(url) ? url : [url]);
  return {
    name: text(name).trim() || hostOf(cleanUrl) || text(username).trim() || fallbackName,
    username: text(username),
    password: text(password),
    url: cleanUrl,
    notes: text(notes),
    totp: text(totp).trim(),
  };
}

function addLogin(result, fields, fallbackName) {
  result.stats.found += 1;
  if (!text(fields.password)) {
    result.stats.noPassword += 1;
    return;
  }
  const login = toLogin(fields, fallbackName);
  if (login.totp) {
    try {
      parseTotpInput(login.totp);
      result.stats.withTotp += 1;
    } catch {
      result.stats.totpNotImported += 1;
      login.totp = "";
    }
  }
  result.logins.push(login);
}

function checkItemCount(count) {
  if (count > MAX_IMPORT_ITEMS) throw new Error("The import file is too large.");
}

// RFC 4180: quoted fields may contain commas, quotes ("") and line breaks.
function parseCsv(input) {
  const source = input.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    if (quoted) {
      if (character === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("invalid csv");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const CSV_COLUMNS = Object.freeze({
  name: ["name", "title"],
  url: ["login_uri", "url", "website", "location"],
  username: ["login_username", "username", "user name"],
  password: ["login_password", "password"],
  notes: ["notes", "note", "notesplain"],
  totp: ["login_totp", "otpauth", "totp", "one-time password"],
  type: ["type"],
  archived: ["archived"],
});

function parseLoginCsv(contents, fallbackName, invalidMessage) {
  let rows;
  try {
    rows = parseCsv(contents);
  } catch {
    throw new Error(invalidMessage);
  }
  if (rows.length === 0) throw new Error(invalidMessage);
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const column = Object.fromEntries(
    Object.entries(CSV_COLUMNS).map(([key, names]) => [
      key,
      header.findIndex((cell) => names.includes(cell)),
    ]),
  );
  if (column.password === -1 || (column.name === -1 && column.url === -1)) {
    throw new Error(invalidMessage);
  }
  checkItemCount(rows.length - 1);

  const result = { logins: [], stats: emptyStats() };
  const cell = (row, key) => (column[key] === -1 ? "" : row[column[key]] ?? "");
  for (const row of rows.slice(1)) {
    const type = cell(row, "type").trim().toLowerCase();
    if (type && type !== "login") {
      result.stats.nonLogin += 1;
      continue;
    }
    if (/^(true|yes|1)$/i.test(cell(row, "archived").trim())) {
      result.stats.archived += 1;
      continue;
    }
    // Bitwarden CSV can list several URIs separated by commas or newlines.
    const urls = cell(row, "url").split(/[\n,]/);
    addLogin(result, {
      name: cell(row, "name"),
      username: cell(row, "username"),
      password: cell(row, "password"),
      url: urls,
      notes: cell(row, "notes"),
      totp: cell(row, "totp"),
    }, fallbackName);
  }
  return result;
}

function parseBitwardenJson(contents, fallbackName) {
  const invalid = "This file is not a supported Bitwarden export.";
  let data;
  try {
    data = JSON.parse(contents);
  } catch {
    throw new Error(invalid);
  }
  if (data?.encrypted === true) {
    throw new Error(
      "This Bitwarden export is encrypted. Export your vault again as unencrypted JSON or CSV.",
    );
  }
  if (!Array.isArray(data?.items)) throw new Error(invalid);
  checkItemCount(data.items.length);

  const result = { logins: [], stats: emptyStats() };
  for (const item of data.items) {
    // Bitwarden item types: 1 login, 2 secure note, 3 card, 4 identity.
    if (item?.type !== 1 || typeof item.login !== "object" || item.login === null) {
      result.stats.nonLogin += 1;
      continue;
    }
    addLogin(result, {
      name: item.name,
      username: item.login.username,
      password: item.login.password,
      url: Array.isArray(item.login.uris) ? item.login.uris.map((uri) => uri?.uri) : [],
      notes: item.notes,
      totp: item.login.totp,
    }, fallbackName);
  }
  return result;
}

// Minimal ZIP reader for 1PUX: finds export.data through the central
// directory and inflates it with an output limit. ZIP64 is not supported.
function readZipEntry(archive, entryName) {
  const invalid = () => new Error("This file is not a supported 1Password export.");
  const searchStart = Math.max(0, archive.length - 65557);
  let eocd = -1;
  for (let i = archive.length - 22; i >= searchStart; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw invalid();

  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw invalid();
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;

    if (uncompressedSize > MAX_EXPORT_DATA_BYTES) throw new Error("The import file is too large.");
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalid();
    }
    const dataStart = localOffset + 30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw invalid();
    if (method === 0) return Buffer.from(compressed);
    if (method !== 8) throw invalid();
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_EXPORT_DATA_BYTES });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new Error("The import file is too large.");
      throw invalid();
    }
  }
  throw invalid();
}

function parseOnePasswordPux(archive, fallbackName) {
  const invalid = "This file is not a supported 1Password export.";
  const exportData = readZipEntry(archive, "export.data");
  let data;
  try {
    data = JSON.parse(exportData.toString("utf8"));
  } catch {
    throw new Error(invalid);
  } finally {
    exportData.fill(0);
  }
  if (!Array.isArray(data?.accounts)) throw new Error(invalid);

  const items = data.accounts.flatMap((account) =>
    (Array.isArray(account?.vaults) ? account.vaults : []).flatMap((vault) =>
      Array.isArray(vault?.items) ? vault.items : []));
  checkItemCount(items.length);

  const result = { logins: [], stats: emptyStats() };
  for (const wrapper of items) {
    const item = wrapper?.item ?? wrapper;
    // 1Password categories: 001 Login, 005 Password; everything else is skipped.
    if (item?.categoryUuid !== "001" && item?.categoryUuid !== "005") {
      result.stats.nonLogin += 1;
      continue;
    }
    if (item.state === "archived") {
      result.stats.archived += 1;
      continue;
    }
    const details = item.details ?? {};
    const overview = item.overview ?? {};
    const loginFields = Array.isArray(details.loginFields) ? details.loginFields : [];
    const fieldValue = (designation) =>
      loginFields.find((field) => field?.designation === designation)?.value;
    const sectionFields = (Array.isArray(details.sections) ? details.sections : [])
      .flatMap((section) => (Array.isArray(section?.fields) ? section.fields : []));
    const totp = sectionFields.find((field) => typeof field?.value?.totp === "string")?.value.totp;
    addLogin(result, {
      name: overview.title,
      username: fieldValue("username"),
      password: fieldValue("password") ?? details.password,
      url: [overview.url, ...(Array.isArray(overview.urls) ? overview.urls.map((entry) => entry?.url) : [])],
      notes: details.notesPlain,
      totp,
    }, fallbackName);
  }
  return result;
}

async function parseImportFile(source, filePath, { fallbackName = "Imported login" } = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error("This file type is not supported.");
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!SOURCES[source].extensions.includes(extension)) {
    throw new Error("This file type is not supported.");
  }
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error("The import file is too large.");
  }

  const contents = await fs.readFile(filePath);
  try {
    if (source === "onepassword" && extension === "1pux") {
      return parseOnePasswordPux(contents, fallbackName);
    }
    const textContents = contents.toString("utf8");
    if (source === "bitwarden" && extension === "json") {
      return parseBitwardenJson(textContents, fallbackName);
    }
    return parseLoginCsv(
      textContents,
      fallbackName,
      source === "bitwarden"
        ? "This file is not a supported Bitwarden export."
        : "This file is not a supported 1Password export.",
    );
  } finally {
    contents.fill(0);
  }
}

module.exports = {
  SOURCES,
  parseCsv,
  parseImportFile,
  parseBitwardenJson,
  parseLoginCsv,
  parseOnePasswordPux,
};
