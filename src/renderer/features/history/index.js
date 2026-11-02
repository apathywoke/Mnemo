import { $ } from "../../shared/lib/dom.js";
import { t, errorText, language } from "../../shared/lib/i18n.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";
import * as itemTypes from "../../../shared/item-types.js";

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const LOGIN_FIELDS = Object.freeze({
  name: "editor.name",
  username: "editor.username",
  url: "editor.website",
  password: "editor.password",
  totp: "editor.totp",
  notes: "editor.notes",
});

// Earlier versions of the selected item, newest first. Main sends the
// plain fields and the names of sealed ones; old secrets are copied or
// shown by main, like current ones. A version's notes and sealed text
// (a secure note's body) are revealed when the user opens that version.
function init(ctx, { refreshEntries }) {
  const dialog = $("#history-dialog");
  const list = $("#history-list");
  const button = $("#history-button");
  const label = $("#history-button-label");
  let current = null;

  const formatTime = (timestamp) => new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));

  function fieldLabel(type, key) {
    if (type === "login" || key === "name" || key === "notes") {
      return t(LOGIN_FIELDS[key] ?? "editor.notes");
    }
    return t(`item.field.${type}.${key}`);
  }

  function iconButton(svg, text, onClick) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "copy-button password-copy-toggle";
    control.setAttribute("aria-label", text);
    control.title = text;
    control.innerHTML = svg;
    control.addEventListener("click", onClick);
    return control;
  }

  function valueRow(name, value, actions = []) {
    const row = document.createElement("div");
    row.className = "history-field";
    const key = document.createElement("span");
    key.className = "history-field-label";
    key.textContent = name;
    const text = document.createElement("span");
    text.className = "history-field-value";
    text.textContent = value;
    row.append(key, text, ...actions);
    return row;
  }

  // `revealed` ({ notes, fields }) once the version was opened, else null.
  function versionBody(version, revealed = null) {
    const hidden = t("detail.hiddenText");
    const body = document.createElement("div");
    body.className = "history-version-body";
    body.hidden = true;
    const { type } = current;
    const rows = [valueRow(fieldLabel(type, "name"), version.name)];
    if (type === "login") {
      if (version.username) rows.push(valueRow(fieldLabel(type, "username"), version.username));
      if (version.url) rows.push(valueRow(fieldLabel(type, "url"), version.url));
    } else {
      for (const field of itemTypes.ITEM_TYPES[type].fields) {
        if (field.sealed && version.sealedFields.includes(field.key)) {
          rows.push(valueRow(fieldLabel(type, field.key), revealed ? revealed.fields[field.key] ?? "" : hidden));
        } else if (field.kind !== "secret" && version.fields[field.key]) {
          rows.push(valueRow(fieldLabel(type, field.key), version.fields[field.key]));
        }
      }
    }
    for (const field of version.secretFields) {
      const name = fieldLabel(type, field);
      rows.push(valueRow(name, "••••••••••••", [
        iconButton(EYE, t("item.showField", { field: name }), () => void reveal(version, field)),
        iconButton(COPY, t("item.copyField", { field: name }), () => void copy(version, field)),
      ]));
    }
    if (version.hasNotes) rows.push(valueRow(fieldLabel(type, "notes"), revealed ? revealed.notes : hidden));
    body.append(...rows);
    if (!current.trashed) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "secondary-button history-restore";
      restore.textContent = t("history.restore");
      restore.addEventListener("click", () => void restoreVersion(version, restore));
      body.append(restore);
    }
    return body;
  }

  function versionItem(version) {
    const item = document.createElement("li");
    item.className = "history-version";
    const head = document.createElement("div");
    head.className = "history-version-head";
    const when = document.createElement("time");
    when.dateTime = new Date(version.updatedAt).toISOString();
    when.textContent = formatTime(version.updatedAt);
    const changes = document.createElement("span");
    changes.className = "history-changes";
    changes.textContent = version.changes.length
      ? t("history.changedAfter", { fields: version.changes.map((key) => fieldLabel(current.type, key)).join(", ") })
      : "";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "detail-action";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = t("history.show");
    let body = versionBody(version);
    let revealed = null;
    const hasText = version.hasNotes || (version.sealedFields ?? []).length > 0;
    toggle.addEventListener("click", async () => {
      // Opening a version reveals its text; the click allows one reveal.
      if (body.hidden && hasText && !revealed) {
        try {
          revealed = await ctx.api.revealNotes(current.id, version.id);
          const next = versionBody(version, revealed);
          body.replaceWith(next);
          body = next;
        } catch (cause) {
          showToast(errorText(cause, "errors.showNotes"), { type: "error" });
        }
      }
      body.hidden = !body.hidden;
      toggle.setAttribute("aria-expanded", String(!body.hidden));
      toggle.textContent = t(body.hidden ? "history.show" : "history.hide");
    });
    const text = document.createElement("div");
    text.className = "history-version-text";
    text.append(when, changes);
    head.append(text, toggle);
    item.append(head, body);
    return item;
  }

  async function reveal(version, field) {
    try {
      const { copied } = await ctx.api.revealVersionField(current.id, version.id, field);
      if (copied) showToast(t("toast.copied"));
    } catch (cause) {
      showToast(errorText(cause, "errors.showPassword"), { type: "error" });
    }
  }

  async function copy(version, field) {
    try {
      await ctx.api.copyVersionField(current.id, version.id, field);
      showToast(t("toast.copied"));
    } catch (cause) {
      showToast(errorText(cause, "errors.copyValue"), { type: "error" });
    }
  }

  async function restoreVersion(version, control) {
    const id = current.id;
    control.disabled = true;
    try {
      await ctx.api.restoreVersion(id, version.id);
      dialog.close();
      await refreshEntries(id);
      showToast(t("history.restoredToast", { date: formatTime(version.updatedAt) }));
    } catch (cause) {
      control.disabled = false;
      showToast(errorText(cause, "errors.restoreVersion"), { type: "error" });
    }
  }

  // `details` from getEntry(): the button shows how many versions exist.
  function render(details) {
    current = {
      id: details.id,
      type: details.type ?? "login",
      name: details.name,
      trashed: Boolean(details.deletedAt),
    };
    button.hidden = !details.historyCount;
    label.textContent = t("history.button", { count: details.historyCount ?? 0 });
  }

  button.addEventListener("click", async () => {
    if (!current) return;
    try {
      const versions = await ctx.api.getHistory(current.id);
      $("#history-title").textContent = current.name;
      list.replaceChildren(...versions.map(versionItem));
      dialog.showModal();
    } catch (cause) {
      showToast(errorText(cause, "errors.openLogin"), { type: "error" });
    }
  });
  $("#close-history-dialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => list.replaceChildren());

  function hide() {
    current = null;
    button.hidden = true;
    if (dialog.open) dialog.close();
  }

  return { render, hide };
}

export { init };
