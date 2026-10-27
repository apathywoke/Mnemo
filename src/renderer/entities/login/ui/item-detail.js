(() => {
  const ns = window.mnemoRenderer;
  const { t } = ns.shared.i18n;

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

  function maskFor(type, key, details) {
    if (type === "card" && key === "number" && details.fields.last4) {
      return `•••• •••• •••• ${details.fields.last4}`;
    }
    return "••••••••••••";
  }

  // `details` comes from getEntry(): plain fields, notes, and the names of
  // stored secret fields. Secret values are never part of it.
  function renderItemDetail(details, ui, { onCopy, onReveal }) {
    const { type } = details;
    const schema = ns.shared.itemTypes.ITEM_TYPES[type];
    ui.kind.textContent = t(`item.type.${type}`).toLocaleUpperCase();
    ns.entities.login.setItemIcon(ui.icon, type);
    ui.name.textContent = details.name;
    ui.subtitle.textContent = details.subtitle ?? "";
    ui.subtitle.hidden = !details.subtitle;

    const rows = [];
    for (const field of schema.fields) {
      const label = t(`item.field.${type}.${field.key}`);
      const copy = field.copy
        ? [iconButton(COPY, t("item.copyField", { field: label }), () => onCopy(field.key))]
        : [];
      if (field.kind === "secret") {
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
    if (details.notes) {
      rows.push(fieldRow(t("detail.notes"), { value: details.notes, multiline: true }));
    }
    ui.fields.replaceChildren(...rows);
    ui.detail.hidden = false;
  }

  ns.entities.login.renderItemDetail = renderItemDetail;
})();
