(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h6.5L18 8v12.5H7Z"/><path d="M13.5 3.5V8H18"/></svg>';

  // The attachments of the selected item: names and sizes only. Files are
  // picked, saved, and deleted through native dialogs in the main process;
  // their contents never reach this renderer.
  function init(ctx, { refreshEntries }) {
    const section = $("#detail-attachments");
    const list = $("#attachment-list");
    const empty = $("#attachments-empty");
    const addButton = $("#add-attachment-button");
    let current = null;

    // "812 Б", "47 KB", "2,3 MB": units in the interface language.
    function formatSize(bytes) {
      const units = ["byte", "kilobyte", "megabyte", "gigabyte"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return new Intl.NumberFormat(ns.shared.i18n.language, {
        style: "unit",
        unit: units[unit],
        unitDisplay: "short",
        maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
      }).format(value);
    }

    function actionButton(label, onClick, extraClass = "") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `detail-action ${extraClass}`.trim();
      button.textContent = label;
      button.addEventListener("click", onClick);
      return button;
    }

    function row(attachment, trashed) {
      const item = document.createElement("li");
      item.className = "attachment-row";
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.innerHTML = FILE_ICON;
      const name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent = attachment.name;
      name.title = attachment.name;
      const size = document.createElement("span");
      size.className = "attachment-size";
      size.textContent = formatSize(attachment.size);
      item.append(icon, name, size, actionButton(t("attachments.save"), () => void save(attachment)));
      if (!trashed) {
        item.append(actionButton(t("common.delete"), () => void remove(attachment), "danger-action"));
      }
      return item;
    }

    // `host` is the shown detail section; `details` comes from getEntry().
    function render(host, details) {
      current = { id: details.id, trashed: Boolean(details.deletedAt) };
      host.append(section);
      addButton.hidden = current.trashed;
      list.replaceChildren(...details.attachments.map((attachment) => row(attachment, current.trashed)));
      empty.hidden = details.attachments.length > 0;
      empty.textContent = t(current.trashed ? "attachments.emptyTrash" : "attachments.empty");
      section.hidden = current.trashed && details.attachments.length === 0;
    }

    async function save(attachment) {
      const id = current?.id;
      if (!id) return;
      try {
        const result = await ctx.api.saveAttachment(id, attachment.id);
        if (result.saved) showToast(t("attachments.savedToast", { name: attachment.name }));
      } catch (cause) {
        showToast(errorText(cause, "errors.attachmentSave"), { type: "error" });
      }
    }

    async function remove(attachment) {
      const id = current?.id;
      if (!id) return;
      try {
        const result = await ctx.api.deleteAttachment(id, attachment.id);
        if (!result.deleted) return;
        await refreshEntries(id);
        showToast(t("attachments.deletedToast", { name: attachment.name }));
      } catch (cause) {
        showToast(errorText(cause, "errors.attachmentDelete"), { type: "error" });
      }
    }

    addButton.addEventListener("click", async () => {
      const id = current?.id;
      if (!id || current.trashed) return;
      addButton.disabled = true;
      try {
        const result = await ctx.api.addAttachments(id);
        if (result.added.length > 0) {
          await refreshEntries(id);
          showToast(t("attachments.addedToast", { count: result.added.length }));
        }
        // Each refused file is named with its reason, one at a time.
        if (result.failed.length > 0) {
          const [first] = result.failed;
          showToast(t("attachments.failedToast", {
            name: first.name,
            reason: errorText({ message: first.error }, "errors.attachmentAdd"),
          }), { type: "error" });
        }
      } catch (cause) {
        showToast(errorText(cause, "errors.attachmentAdd"), { type: "error" });
      } finally {
        addButton.disabled = false;
      }
    });

    function hide() {
      current = null;
      section.hidden = true;
      list.replaceChildren();
    }

    return { render, hide };
  }

  ns.features.attachments = { init };
})();
