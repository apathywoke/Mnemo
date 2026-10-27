// Applies the light or dark palette. The main process sets
// nativeTheme.themeSource from the saved setting ("system", "dark", or
// "light"), and Chromium reflects it in prefers-color-scheme, so this only
// follows that media query. Runs before namespace.js, from <head>.
(() => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");

  function apply() {
    document.documentElement.dataset.theme = query.matches ? "dark" : "light";
  }

  apply();
  query.addEventListener("change", apply);
})();
