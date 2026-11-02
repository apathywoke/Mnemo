// Globals of the renderer page.
export {};

declare global {
  interface Window {
    /** The preload API (preload.js), exposed through contextBridge. */
    vaultApp: any;
  }
}
