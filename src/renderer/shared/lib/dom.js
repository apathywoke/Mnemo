(() => {
  const ns = window.mnemoRenderer;
  // Elements are found by selector, so their exact type is not known here.
  ns.shared.dom = {
    /** @type {(selector: string, root?: ParentNode) => any} */
    $: (selector, root = document) => root.querySelector(selector),
    /** @type {(selector: string, root?: ParentNode) => any[]} */
    $$: (selector, root = document) => Array.from(root.querySelectorAll(selector)),
    setError(element, message) {
      element.textContent = message;
      element.hidden = false;
    },
  };
})();
