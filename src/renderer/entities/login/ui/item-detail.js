import * as loginModel from "../model/login.js";
import { t } from "../../../shared/lib/i18n.js";
import * as itemTypes from "../../../../shared/item-types.js";

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';

function iconButton(svg, label, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `copy-button password-copy-toggle ${extraClass}`.trim();
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = svg;
  button.addEventListener("click", onClick);
  return button;
}

function fieldRow(labelText, { value, masked = false, mono = false, multiline = false, actions = [] }) {
  const field = document.createElement("div");
  field.className = "detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const row = document.createElement("div");
  row.className = "detail-value-row";
  const text = document.createElement(multiline ? "p" : "span");
  text.className = [
    "detail-value",
    masked ? "secret-value" : "",
    mono ? "detail-mono" : "",
    multiline ? "detail-multiline" : "",
  ].filter(Boolean).join(" ");
  text.textContent = value;
  row.append(text, ...actions);
  field.append(label, row);
  return field;
}

function textButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "detail-action detail-reveal-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// Notes or sealed text: the text once revealed, otherwise a placeholder and
// a Show button.
function textRow(labelText, value, { onRevealText, multiline = true, mono = false, actions = [] }) {
  if (value !== null) return fieldRow(labelText, { value, multiline, mono, actions });
  return fieldRow(labelText, {
    value: t("detail.hiddenText"),
    actions: [textButton(t("detail.showText"), onRevealText), ...actions],
  });
}

function maskFor(type, key, details) {
  if (type === "card" && key === "number" && details.fields.last4) {
    return `•••• •••• •••• ${details.fields.last4}`;
  }
  return "••••••••••••";
}

// `details` comes from getEntry(): plain fields, the names of stored secret
// and sealed fields, and whether there are notes. Secret values are never
// part of it; notes and sealed text (a secure note's body) are in
// `revealed` ({ notes, fields }) once the user chose Show.
function renderItemDetail(details, ui, { onCopy, onReveal, revealed = null, onRevealText }) {
  const { type } = details;
  const schema = itemTypes.ITEM_TYPES[type];
  ui.kind.textContent = t(`item.type.${type}`).toLocaleUpperCase();
  loginModel.setItemIcon(ui.icon, type);
  ui.name.textContent = details.name;
  ui.subtitle.textContent = details.subtitle ?? "";
  ui.subtitle.hidden = !details.subtitle;

  const rows = [];
  for (const field of schema.fields) {
    const label = t(`item.field.${type}.${field.key}`);
    const copy = field.copy
      ? [iconButton(COPY, t("item.copyField", { field: label }), () => onCopy(field.key))]
      : [];
    if (field.sealed) {
      if (!details.sealedFields.includes(field.key)) continue;
      rows.push(textRow(label, revealed ? revealed.fields[field.key] ?? "" : null, {
        onRevealText,
        multiline: field.kind === "multiline",
        mono: field.mono,
        actions: copy,
      }));
    } else if (field.kind === "secret") {
      if (!details.secretFields.includes(field.key)) continue;
      rows.push(fieldRow(label, {
        value: maskFor(type, field.key, details),
        masked: true,
        actions: [
          iconButton(EYE, t("item.showField", { field: label }), () => onReveal(field.key), "password-visibility-toggle"),
          ...copy,
        ],
      }));
    } else if (details.fields[field.key]) {
      rows.push(fieldRow(label, {
        value: details.fields[field.key],
        mono: field.mono,
        multiline: field.kind === "multiline",
        actions: copy,
      }));
    }
  }
  if (type === "ssh" && details.fields.fingerprint) {
    const label = t("item.field.ssh.fingerprint");
    rows.push(fieldRow(label, {
      value: `${details.fields.keyType ?? ""} ${details.fields.fingerprint}`.trim(),
      mono: true,
      actions: [iconButton(COPY, t("item.copyField", { field: label }), () => onCopy("fingerprint"))],
    }));
  }
  if (details.hasNotes) {
    rows.push(textRow(t("detail.notes"), revealed ? revealed.notes : null, { onRevealText }));
  }
  ui.fields.replaceChildren(...rows);
  ui.detail.hidden = false;
}

export { renderItemDetail };
