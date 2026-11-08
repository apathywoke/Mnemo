import * as cardInputFeature from "../card-input/index.js";
import { $ } from "../../shared/lib/dom.js";
import { t, errorText } from "../../shared/lib/i18n.js";
import * as passwordVisibility from "../../shared/ui/password-visibility.js";
import { show as showToast } from "../../shared/ui/toast-notifications.js";
import * as itemTypes from "../../../shared/item-types.js";
import * as inlineEditor from "../../shared/ui/inline-editor.js";

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m3 3 18 18"/></svg>';

// Editor for cards, notes, identities, and SSH keys. Fields come from the
// shared schema. As with login passwords, secret fields start empty when
// editing and an empty value keeps what is stored.
function init(ctx, { refreshEntries }) {
  const dialog = $("#item-dialog");
  const form = $("#item-form");
  const fieldsContainer = $("#item-fields");
  const error = $("#item-form-error");
  let current = null;
  // Optional per-type input helper (cards) with its own validate().
  let typeHelper = null;

  function buildField(type, field, details) {
    const id = `item-field-${field.key}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = t(`item.field.${type}.${field.key}`);

    const multiline = field.kind === "multiline" || field.multiline;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.id = id;
    input.dataset.fieldKey = field.key;
    input.maxLength = field.max;
    input.autocomplete = "off";
    input.spellcheck = false;
    if (multiline) /** @type {HTMLTextAreaElement} */ (input).rows = field.mono ? 6 : 4;
    if (field.mono) input.classList.add("mono-input");
    if (field.inputMode) input.inputMode = field.inputMode;
    if (field.placeholder) input.placeholder = field.placeholder;
    const stored = details?.secretFields?.includes(field.key);
    if (field.kind === "secret" && stored) input.placeholder = t("editor.keepSecret");
    if (field.kind !== "secret") input.value = details?.fields?.[field.key] ?? "";

    if (field.kind === "secret" && !multiline && !field.reveal) {
      /** @type {HTMLInputElement} */ (input).type = "password";
      const row = document.createElement("div");
      row.className = "password-input-row";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "password-visibility-toggle";
      toggle.dataset.passwordVisibilityFor = id;
      toggle.setAttribute("aria-controls", id);
      toggle.setAttribute("aria-pressed", "false");
      toggle.innerHTML = EYE;
      row.append(input, toggle);
      return [label, row];
    }
    if (!multiline) /** @type {HTMLInputElement} */ (input).type = "text";
    return [label, input];
  }

  function open(type, details = null) {
    current = { type, id: details?.id ?? "" };
    form.reset();
    error.hidden = true;
    $("#item-dialog-eyebrow").textContent = t(`item.type.${type}`);
    $("#item-dialog-title").textContent = t(details ? "editor.editItem" : "editor.newItem", {
      type: t(`item.type.${type}`),
    });
    $("#item-name").value = details?.name ?? "";
    $("#item-notes").value = details?.notes ?? "";
    const nodes = itemTypes.fieldsOf(type).flatMap((field) => buildField(type, field, details));
    fieldsContainer.replaceChildren(...nodes);
    passwordVisibility.bindAll(fieldsContainer);
    passwordVisibility.conceal(fieldsContainer);
    typeHelper = type === "card" ? cardInputFeature.attach(fieldsContainer) : null;
    inlineEditor.open(dialog);
    $("#item-name").focus();
  }

  function clear() {
    typeHelper = null;
    fieldsContainer.replaceChildren();
    form.reset();
    current = null;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current) return;
    error.hidden = true;
    if (typeHelper && !typeHelper.validate()) return;
    const button = $("#save-item-button");
    button.disabled = true;
    try {
      const fields = {};
      for (const input of fieldsContainer.querySelectorAll("[data-field-key]")) {
        fields[input.dataset.fieldKey] = input.value;
      }
      // A new item made while a folder is open goes into that folder.
      const folderId = current.id ? null : ctx.organize?.newItemFolderId();
      const saved = await ctx.api.saveItem({
        ...(folderId ? { folderId } : {}),
        id: current.id,
        type: current.type,
        name: $("#item-name").value,
        notes: $("#item-notes").value,
        fields,
      });
      const wasEditing = Boolean(current.id);
      dialog.close();
      await refreshEntries(saved.id);
      showToast(t(wasEditing ? "toast.itemUpdated" : "toast.itemSaved"));
    } catch (cause) {
      ctx.setError(error, errorText(cause, "errors.saveItem"));
    } finally {
      button.disabled = false;
    }
  });

  $("#cancel-item-button").addEventListener("click", () => dialog.close());
  $("#close-item-dialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", clear);
  inlineEditor.bind(dialog);

  return { open, close: () => dialog.open && dialog.close() };
}

export { init };
