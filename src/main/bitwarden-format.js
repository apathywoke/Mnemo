// Mnemo items in Bitwarden's unencrypted export format, in both directions:
// the open export writes it, and the Bitwarden importer reads it. Most
// password managers import this format, so a user can leave Mnemo.
//
// `plain` items are what plainEntry() in vault/store-backup.js returns: a
// login without `type`, or { type, name, notes, fields }. Values Bitwarden
// has no place for go in custom fields with these fixed English names.

const ITEM_TYPE = Object.freeze({ login: 1, note: 2, card: 3, identity: 4, ssh: 5 });
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;
const CUSTOM = Object.freeze({
  notes: "Notes",
  expiry: "Expiry",
  pin: "PIN",
  birthDate: "Birth date",
  documentNumber: "Document number",
  passphrase: "Passphrase",
});
const CSV_HEADER = Object.freeze([
  "folder", "favorite", "type", "name", "notes", "fields", "reprompt",
  "login_uri", "login_username", "login_password", "login_totp",
]);

const text = (value) => (typeof value === "string" ? value : "");
const orNull = (value) => value || null;

function customField(name, value, type = FIELD_TEXT) {
  return value ? [{ name, value, type, linkedId: null }] : [];
}

// "MM/YY" or "MM/YYYY"; Bitwarden keeps the month and a four-digit year.
function splitExpiry(expiry) {
  const match = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(text(expiry).trim());
  if (!match) return null;
  return { expMonth: String(Number(match[1])), expYear: match[2].length === 2 ? `20${match[2]}` : match[2] };
}

function joinExpiry(month, year) {
  const digits = text(year).trim();
  if (!text(month).trim() || !/^\d{2,4}$/.test(digits)) return "";
  return `${text(month).trim().padStart(2, "0")}/${digits.slice(-2)}`;
}

function itemToBitwarden(plain) {
  const type = plain.type ?? "login";
  const fields = plain.fields ?? {};
  /** @type {any} */
  const item = {
    id: plain.id,
    organizationId: null,
    folderId: orNull(plain.folderId),
    type: ITEM_TYPE[type],
    reprompt: 0,
    name: plain.name,
    notes: orNull(plain.notes),
    favorite: plain.favorite === true,
    fields: [],
    collectionIds: null,
    creationDate: new Date(plain.createdAt).toISOString(),
    revisionDate: new Date(plain.updatedAt).toISOString(),
  };
  if (type === "login") {
    item.login = {
      uris: plain.url ? [{ match: null, uri: plain.url }] : [],
      username: orNull(plain.username),
      password: orNull(plain.password),
      totp: orNull(plain.totp),
    };
  } else if (type === "note") {
    // The text of a secure note is Bitwarden's notes field.
    item.notes = orNull(fields.body);
    item.secureNote = { type: 0 };
    item.fields = customField(CUSTOM.notes, plain.notes);
  } else if (type === "card") {
    const expiry = splitExpiry(fields.expiry);
    item.card = {
      cardholderName: orNull(fields.cardholder),
      brand: null,
      number: orNull(fields.number),
      expMonth: expiry?.expMonth ?? null,
      expYear: expiry?.expYear ?? null,
      code: orNull(fields.cvv),
    };
    item.fields = [
      ...customField(CUSTOM.pin, fields.pin, FIELD_HIDDEN),
      ...(expiry ? [] : customField(CUSTOM.expiry, fields.expiry)),
    ];
  } else if (type === "identity") {
    item.identity = {
      title: null,
      firstName: orNull(fields.firstName),
      middleName: null,
      lastName: orNull(fields.lastName),
      address1: orNull(fields.address),
      address2: null,
      address3: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      company: null,
      email: orNull(fields.email),
      phone: orNull(fields.phone),
      ssn: null,
      username: null,
      passportNumber: null,
      licenseNumber: null,
    };
    item.fields = [
      ...customField(CUSTOM.birthDate, fields.birthDate),
      ...customField(CUSTOM.documentNumber, fields.documentNumber, FIELD_HIDDEN),
    ];
  } else if (type === "ssh") {
    item.sshKey = {
      privateKey: orNull(fields.privateKey),
      publicKey: orNull(fields.publicKey),
      keyFingerprint: orNull(plain.fingerprint),
    };
    item.fields = customField(CUSTOM.passphrase, fields.passphrase, FIELD_HIDDEN);
  } else {
    throw new Error("Could not export the vault.");
  }
  return item;
}

// A Bitwarden item other than a login, as importLogins() takes it, or null
// for a type Mnemo does not have.
function bitwardenToItem(item) {
  const custom = (name) => {
    const field = Array.isArray(item.fields) ? item.fields.find((candidate) => candidate?.name === name) : null;
    return text(field?.value);
  };
  const part = (group, key) => text(group?.[key]);
  const name = text(item.name);
  if (item.type === ITEM_TYPE.note) {
    return { type: "note", name, notes: custom(CUSTOM.notes), fields: { body: text(item.notes) } };
  }
  if (item.type === ITEM_TYPE.card) {
    const { card } = item;
    return {
      type: "card",
      name,
      notes: text(item.notes),
      fields: {
        cardholder: part(card, "cardholderName"),
        number: part(card, "number"),
        expiry: joinExpiry(card?.expMonth, card?.expYear) || custom(CUSTOM.expiry),
        cvv: part(card, "code"),
        pin: custom(CUSTOM.pin),
      },
    };
  }
  if (item.type === ITEM_TYPE.identity) {
    const { identity } = item;
    const address = ["address1", "address2", "address3", "city", "state", "postalCode", "country"]
      .map((key) => part(identity, key))
      .filter(Boolean)
      .join("\n");
    return {
      type: "identity",
      name,
      notes: text(item.notes),
      fields: {
        firstName: part(identity, "firstName"),
        lastName: part(identity, "lastName"),
        email: part(identity, "email"),
        phone: part(identity, "phone"),
        address,
        birthDate: custom(CUSTOM.birthDate),
        documentNumber: custom(CUSTOM.documentNumber)
          || part(identity, "passportNumber")
          || part(identity, "licenseNumber")
          || part(identity, "ssn"),
      },
    };
  }
  if (item.type === ITEM_TYPE.ssh) {
    const { sshKey } = item;
    return {
      type: "ssh",
      name,
      notes: text(item.notes),
      fields: {
        privateKey: part(sshKey, "privateKey"),
        publicKey: part(sshKey, "publicKey"),
        passphrase: custom(CUSTOM.passphrase),
      },
    };
  }
  return null;
}

function toBitwardenJson({ items, folders }) {
  return JSON.stringify({
    encrypted: false,
    folders: folders.map(({ id, name }) => ({ id, name })),
    items: items.map(itemToBitwarden),
  }, null, 2);
}

// RFC 4180. Values stay exact, so a spreadsheet may treat one that starts
// with "=" as a formula; the export warns against opening the file there.
function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// Logins only: Bitwarden's CSV format has no other item types.
function toBitwardenCsv({ items, folders }) {
  const folderName = new Map(folders.map(({ id, name }) => [id, name]));
  const rows = items.filter((item) => (item.type ?? "login") === "login").map((item) => [
    folderName.get(item.folderId) ?? "",
    item.favorite === true ? "1" : "",
    "login",
    item.name,
    item.notes,
    "",
    "0",
    item.url,
    item.username,
    item.password,
    item.totp,
  ]);
  return `${[CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

module.exports = { bitwardenToItem, itemToBitwarden, toBitwardenCsv, toBitwardenJson };
