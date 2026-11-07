// Applies the light or dark palette. The main process sets
// nativeTheme.themeSource from the saved setting ("system", "dark", or
// "light"), and Chromium reflects it in prefers-color-scheme, so this only
// follows that media query. A classic script in <head>, so it runs before
// the first paint, ahead of the module scripts.
(() => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");

  function apply() {
    document.documentElement.dataset.theme = query.matches ? "dark" : "light";
  }

  apply();
  query.addEventListener("change", apply);

  // macOS windows have the sidebar material behind the page (vibrancy.css).
  if (navigator.userAgent.includes("Macintosh")) document.documentElement.dataset.platform = "mac";
})();
