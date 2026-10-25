(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;

  function bind(ctx) {
    const button = $("#backup-button");
    const status = $("#backup-status");
    button.addEventListener("click", async () => {
      status.hidden = true;
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        const result = await ctx.api.exportBackup();
        if (!result.canceled) {
          status.textContent = "Encrypted backup saved. Keep the same master passphrase safe; it cannot be recovered if lost.";
          status.hidden = false;
        }
      } catch (cause) {
        status.textContent = cause.message || "Could not save the backup.";
        status.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = "Backup";
      }
    });
  }

  ns.features.backup = { bind };
})();
