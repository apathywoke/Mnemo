(() => {
  const registry = Object.create(null);
  for (const layer of ["app", "pages", "widgets", "features", "entities", "shared"]) {
    registry[layer] = Object.create(null);
  }
  Object.defineProperty(window, "mnemoRenderer", {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
