(() => {
  const ns = window.mnemoRenderer;
  ns.shared.dom = {
    $: (selector, root = document) => root.querySelector(selector),
    $$: (selector, root = document) => Array.from(root.querySelectorAll(selector)),
    setError(element, message) {
      element.textContent = message;
      element.hidden = false;
    },
  };
})();
