// A small menu at the pointer for a right click (or the keyboard's menu
// key): the actions for one thing, as in a macOS context menu. It looks
// like the detail's "⋯" menu (detail-card.css). The arrow keys move
// between the items; Escape, a press outside, a choice, or the window
// losing focus close it.

/** @type {{ menu: HTMLElement, close: () => void } | null} */
let current = null;

/**
 * @param {MouseEvent} event
 * @param {{ label: string, danger?: boolean, onSelect: () => void }[]} items
 */
function showContextMenu(event, items) {
  event.preventDefault();
  current?.close();
  const opener = /** @type {HTMLElement | null} */ (document.activeElement);
  const menu = document.createElement("div");
  menu.className = "detail-more-menu context-menu";
  menu.setAttribute("role", "menu");
  const buttons = items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "detail-menu-item danger-action" : "detail-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.addEventListener("click", () => {
      close();
      item.onSelect();
    });
    return button;
  });
  menu.append(...buttons);
  document.body.append(menu);

  // At the pointer, kept inside the window. From the keyboard there is no
  // pointer position: below the element instead.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  const anchor = /** @type {Element} */ (event.currentTarget ?? event.target).getBoundingClientRect();
  const x = fromKeyboard ? anchor.left + 12 : event.clientX;
  const y = fromKeyboard ? anchor.bottom - 6 : event.clientY;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
  buttons[0]?.focus();

  function onPointerDown(pointer) {
    if (!menu.contains(/** @type {Node} */ (pointer.target))) close();
  }
  function onKeyDown(key) {
    if (key.key === "Escape") {
      key.preventDefault();
      key.stopPropagation();
      close();
      opener?.focus();
      return;
    }
    if (key.key === "Tab") {
      key.preventDefault();
      return;
    }
    const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[key.key];
    if (next === undefined) return;
    key.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus();
  }
  function close() {
    if (current?.menu !== menu) return;
    current = null;
    menu.remove();
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  }
  menu.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  current = { menu, close };
}

export { showContextMenu };
