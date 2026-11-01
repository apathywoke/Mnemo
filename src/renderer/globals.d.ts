// Globals of the renderer page. The slices are classic scripts that register
// on window.mnemoRenderer, so their APIs are not typed yet; the move to ES
// modules replaces this registry with imports.
export {};

declare global {
  interface Window {
    /** Renderer slices by layer (app/namespace.js). */
    mnemoRenderer: any;
    /** The preload API (preload.js). */
    vaultApp: any;
    /** src/shared/password-tools.js, loaded as a classic script. */
    passwordTools: any;
  }
}
