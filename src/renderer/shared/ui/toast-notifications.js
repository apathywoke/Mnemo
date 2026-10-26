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

  function show(message, { type = "success" } = {}) {
    const host = document.getElementById("toast-region");
    if (!host || typeof message !== "string" || !message.trim()) return;

    const safeType = ["success", "error", "info"].includes(type) ? type : "info";
    if (dismissalTimer) clearTimeout(dismissalTimer);
    host.replaceChildren();
    host.setAttribute("aria-live", safeType === "error" ? "assertive" : "polite");

    const notification = document.createElement("div");
    notification.className = `toast-notification toast-${safeType}`;

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
    close.setAttribute("aria-label", "Dismiss notification");
    close.title = "Dismiss notification";
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener("click", () => dismiss(notification));

    notification.append(icon, text, close);
    host.append(notification);
    window.requestAnimationFrame(() => notification.classList.add("is-visible"));
    dismissalTimer = window.setTimeout(() => dismiss(notification), 2500);
  }

  ns.shared.toast = { show };
})();
