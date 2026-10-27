// Field schema for the non-login item types. Shared by the renderer (plain
// script) and the main process (require) so both validate the same shape.
//
// kind: "text" (one line), "multiline", or "secret". Secret fields are sealed
// per item in the vault and never sent to the renderer; they can be copied or
// shown in a native dialog. `multiline` on a secret only affects the editor.
(() => {
  const ITEM_TYPES = Object.freeze({
    card: Object.freeze({
      fields: Object.freeze([
        { key: "cardholder", kind: "text", max: 200, copy: true },
        // `reveal`: shown as text while typing so the grouping is visible;
        // still never sent back to the renderer once saved.
        { key: "number", kind: "secret", max: 32, copy: true, inputMode: "numeric", reveal: true },
        { key: "expiry", kind: "text", max: 7, copy: true, placeholder: "MM/YY", inputMode: "numeric" },
        { key: "cvv", kind: "secret", max: 4, copy: true, inputMode: "numeric" },
        { key: "pin", kind: "secret", max: 12, copy: true, inputMode: "numeric" },
      ]),
      // Shown openly, like other password managers: last four digits.
      derived: Object.freeze(["last4"]),
    }),
    note: Object.freeze({
      fields: Object.freeze([
        { key: "body", kind: "multiline", max: 65536, copy: true },
      ]),
      derived: Object.freeze([]),
    }),
    identity: Object.freeze({
      fields: Object.freeze([
        { key: "firstName", kind: "text", max: 200, copy: true },
        { key: "lastName", kind: "text", max: 200, copy: true },
        { key: "email", kind: "text", max: 320, copy: true, inputMode: "email" },
        { key: "phone", kind: "text", max: 64, copy: true, inputMode: "tel" },
        { key: "address", kind: "multiline", max: 2048, copy: true },
        { key: "birthDate", kind: "text", max: 32, copy: true },
        { key: "documentNumber", kind: "secret", max: 128, copy: true },
      ]),
      derived: Object.freeze([]),
    }),
    ssh: Object.freeze({
      fields: Object.freeze([
        { key: "privateKey", kind: "secret", multiline: true, max: 16384, copy: true, mono: true },
        { key: "publicKey", kind: "multiline", max: 16384, copy: true, mono: true },
        { key: "passphrase", kind: "secret", max: 1024, copy: true },
      ]),
      // Computed from the public key: algorithm and SHA256 fingerprint.
      derived: Object.freeze(["keyType", "fingerprint"]),
    }),
  });

  const ALL_TYPES = Object.freeze(["login", ...Object.keys(ITEM_TYPES)]);

  function fieldsOf(type) {
    return ITEM_TYPES[type]?.fields ?? [];
  }

  const api = { ITEM_TYPES, ALL_TYPES, fieldsOf };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    window.mnemoRenderer.shared.itemTypes = api;
  }
})();
