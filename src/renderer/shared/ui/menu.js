// A button that opens a small menu of actions (the "⋯" in a detail).
//
// The menu opens on a click; from the keyboard (Enter, Space, or the down
// arrow) its first item takes the focus. The arrow keys, Home, and End move
// between the items, Escape closes it and returns the focus to the button,
// and choosing an item, Tab, or a press outside closes it.
function bindMenu(button, menu) {
  const items = () => Array.from(menu.querySelectorAll("[role='menuitem']"))
    .filter((item) => !item.hidden && !(/** @type {HTMLButtonElement} */ (item).disabled));

  function setOpen(open, { focusFirst = false } = {}) {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open && focusFirst) /** @type {HTMLElement | undefined} */ (items()[0])?.focus();
  }

  const close = () => setOpen(false);

  button.addEventListener("click", (event) => {
    // A keyboard click has no pointer position.
    setOpen(menu.hidden, { focusFirst: event.detail === 0 });
  });

  button.addEventListener("keydown", (event) => {
    // Opened with the pointer, the focus stays on the button.
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" || !menu.hidden) return;
    event.preventDefault();
    setOpen(true, { focusFirst: true });
  });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // Only the menu: the page's own Escape would also close the detail.
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const options = items();
    const index = options.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
    if (next === undefined || options.length === 0) return;
    event.preventDefault();
    /** @type {HTMLElement} */ (options[(next + options.length) % options.length]).focus();
  });

  // The item's own click handler runs first; this only closes the menu.
  menu.addEventListener("click", (event) => {
    if (/** @type {Element} */ (event.target).closest("[role='menuitem']")) close();
  });

  document.addEventListener("pointerdown", (event) => {
    const target = /** @type {Node} */ (event.target);
    if (!menu.hidden && !menu.contains(target) && !button.contains(target)) close();
  });

  close();
  return { close };
}

export { bindMenu };
