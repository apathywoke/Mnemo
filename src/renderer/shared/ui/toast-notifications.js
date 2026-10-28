(() => {
  const ns = window.mnemoRenderer;
  let dismissalTimer = null;

  function dismiss(notification) {
    const host = document.getElementById("toast-region");
    if (!host || !host.contains(notification)) return;
    if (dismissalTimer) clearTimeout(dismissalTimer);
    dismissalTimer = null;
    notification.classList.remove("is-visible");
    window.setTimeout(() => notification.remove(), 180);
  }

  // `action` ({ label, onClick }) adds a button, such as Undo, and keeps the
  // notification up a little longer.
  function show(message, { type = "success", action = null } = {}) {
    const host = document.getElementById("toast-region");
    if (!host || typeof message !== "string" || !message.trim()) return;

    const safeType = ["success", "error", "info"].includes(type) ? type : "info";
    if (dismissalTimer) clearTimeout(dismissalTimer);
    host.replaceChildren();
    host.setAttribute("aria-live", safeType === "error" ? "assertive" : "polite");

    const notification = document.createElement("div");
    notification.className = `toast-notification toast-${safeType}${action ? " has-action" : ""}`;

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = safeType === "success" ? "✓" : safeType === "error" ? "!" : "i";

    const text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = message;

    const close = document.createElement("button");
    close.className = "toast-dismiss";
    close.type = "button";
    close.setAttribute("aria-label", ns.shared.i18n.t("toast.dismiss"));
    close.title = ns.shared.i18n.t("toast.dismiss");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener("click", () => dismiss(notification));

    notification.append(icon, text);
    if (action) {
      const button = document.createElement("button");
      button.className = "toast-action";
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        dismiss(notification);
        action.onClick();
      });
      notification.append(button);
    }
    notification.append(close);
    host.append(notification);
    window.requestAnimationFrame(() => notification.classList.add("is-visible"));
    dismissalTimer = window.setTimeout(() => dismiss(notification), action ? 6000 : 2500);
  }

  ns.shared.toast = { show };
})();
