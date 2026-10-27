(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  const RING_LENGTH = 2 * Math.PI * 9;
  const PLACEHOLDER = "——— ———";

  // Shows the current one-time code of the selected login with a countdown.
  // The main process computes codes; this asks for a new one when the
  // current one expires. These requests do not count as user activity, so
  // an open code does not keep the vault unlocked.
  function init(ctx) {
    const code = $("#detail-totp");
    const ring = $("#detail-totp-ring");
    const seconds = $("#detail-totp-seconds");
    const copyButton = $("#copy-totp-button");
    let entryId = null;
    let current = null;
    let timer = null;
    let request = 0;

    function format(value) {
      const middle = Math.ceil(value.length / 2);
      return `${value.slice(0, middle)} ${value.slice(middle)}`;
    }

    function render() {
      if (!current) {
        code.textContent = PLACEHOLDER;
        seconds.textContent = "";
        ring.style.strokeDashoffset = "0";
        return;
      }
      const remaining = Math.max(0, (current.expiresAt - Date.now()) / 1000);
      code.textContent = format(current.code);
      seconds.textContent = String(Math.ceil(remaining));
      ring.style.strokeDasharray = String(RING_LENGTH);
      ring.style.strokeDashoffset = String(RING_LENGTH * (1 - remaining / current.period));
      ring.closest(".totp-timer").classList.toggle("is-ending", remaining <= 5);
    }

    async function refresh() {
      const requestId = ++request;
      const id = entryId;
      try {
        const next = await ctx.api.getTotpCode(id);
        if (requestId !== request || id !== entryId) return;
        current = next;
      } catch {
        if (requestId !== request) return;
        current = null;
      }
      render();
    }

    function tick() {
      if (current && Date.now() >= current.expiresAt) {
        current = null;
        void refresh();
      }
      render();
    }

    function stop() {
      entryId = null;
      current = null;
      request += 1;
      if (timer) window.clearInterval(timer);
      timer = null;
      render();
    }

    // Starts, keeps, or stops the display for the selected entry summary.
    function follow(entry) {
      if (!entry?.hasTotp) {
        stop();
        return;
      }
      if (entry.id === entryId) return;
      stop();
      entryId = entry.id;
      timer = window.setInterval(tick, 500);
      void refresh();
    }

    copyButton.addEventListener("click", async () => {
      if (!entryId) return;
      try {
        await ctx.api.copyEntryField(entryId, "totp");
        showToast(t("toast.copied"));
      } catch (cause) {
        showToast(errorText(cause, "errors.copyValue"), { type: "error" });
      }
    });

    return { follow, stop };
  }

  ns.features.totpCode = { init };
})();
