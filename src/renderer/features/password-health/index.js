(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText, onChange } = ns.shared.i18n;
  const { show: showToast } = ns.shared.toast;

  // Reports in the detail area: breached (Have I Been Pwned, on request),
  // reused, and weak login passwords. Main sends entry IDs and counts only;
  // names come from the entry list the renderer already has.
  function init(ctx, { getEntry, openEntry, deselect }) {
    const view = $("#reports-view");
    const button = $("#reports-button");
    const checkButton = $("#reports-check-breaches");
    const breachStatus = $("#report-breach-status");
    const lists = {
      breached: $("#report-breached-list"),
      reused: $("#report-reused-list"),
      weak: $("#report-weak-list"),
    };
    const counts = {
      breached: $("#report-breached-count"),
      reused: $("#report-reused-count"),
      weak: $("#report-weak-count"),
    };
    let report = null;
    let checking = false;
    // Ignores answers that arrive after the view was closed or reopened.
    let generation = 0;

    const number = (value) => new Intl.NumberFormat(ns.shared.i18n.language).format(value);
    const formatTime = (timestamp) => new Intl.DateTimeFormat(ns.shared.i18n.language, { timeStyle: "short" })
      .format(new Date(timestamp));

    function row(id, badge, tone) {
      const entry = getEntry(id);
      if (!entry) return null;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "entry-row report-row";
      const icon = document.createElement("span");
      icon.className = "entry-row-icon";
      icon.setAttribute("aria-hidden", "true");
      ns.entities.login.setSiteIcon(icon, entry.favicon, Array.from(entry.name)[0] ?? "•");
      const copy = document.createElement("span");
      copy.className = "entry-row-copy";
      const name = document.createElement("span");
      name.className = "entry-row-name";
      name.textContent = entry.name;
      const meta = document.createElement("span");
      meta.className = "entry-row-meta";
      meta.textContent = ns.entities.login.secondaryLabel(entry);
      copy.append(name, meta);
      item.append(icon, copy);
      if (badge) {
        const label = document.createElement("span");
        label.className = "report-badge";
        label.dataset.tone = tone;
        label.textContent = badge;
        item.append(label);
      }
      item.addEventListener("click", () => openEntry(id));
      return item;
    }

    function note(text) {
      const paragraph = document.createElement("p");
      paragraph.className = "report-empty";
      paragraph.textContent = text;
      return paragraph;
    }

    function renderBreaches() {
      const list = lists.breached;
      list.replaceChildren();
      checkButton.disabled = checking || !report || report.total === 0;
      checkButton.textContent = t(checking
        ? "reports.breachChecking"
        : report?.breachCheckedAt ? "reports.breachRecheck" : "reports.breachCheck");
      if (!report?.breached) {
        counts.breached.textContent = "–";
        breachStatus.textContent = checking ? "" : t("reports.breachNotChecked");
        return;
      }
      counts.breached.textContent = number(report.breached.length);
      const status = [t("reports.breachChecked", { time: formatTime(report.breachCheckedAt) })];
      if (report.breachUnchecked > 0) status.push(t("reports.breachChanged", { count: number(report.breachUnchecked) }));
      breachStatus.textContent = status.join(" ");
      if (report.breached.length === 0) {
        list.append(note(t("reports.breachNone")));
        return;
      }
      for (const { id, count } of report.breached) {
        const item = row(id, t("reports.breachSeen", { count: number(count) }), "danger");
        if (item) list.append(item);
      }
    }

    function render() {
      if (!report) return;
      $("#reports-summary").textContent = report.total === 0
        ? t("reports.empty")
        : t("reports.summary", { count: number(report.total) });
      view.classList.toggle("is-empty", report.total === 0);
      renderBreaches();

      const reusedItems = report.reused.reduce((sum, group) => sum + group.length, 0);
      counts.reused.textContent = number(reusedItems);
      lists.reused.replaceChildren();
      if (report.reused.length === 0) lists.reused.append(note(t("reports.reusedNone")));
      for (const group of report.reused) {
        const block = document.createElement("div");
        block.className = "report-group";
        const heading = document.createElement("p");
        heading.className = "report-group-title";
        heading.textContent = t("reports.reusedGroup", { count: number(group.length) });
        block.append(heading, ...group.map((id) => row(id)).filter(Boolean));
        lists.reused.append(block);
      }

      counts.weak.textContent = number(report.weak.length);
      lists.weak.replaceChildren();
      if (report.weak.length === 0) lists.weak.append(note(t("reports.weakNone")));
      for (const id of report.weak) {
        const item = row(id, t("reports.weakBadge"), "warning");
        if (item) lists.weak.append(item);
      }

      for (const [kind, element] of Object.entries(counts)) {
        const value = kind === "breached" ? report.breached?.length : kind === "reused" ? reusedItems : report.weak.length;
        element.closest(".report-tile").dataset.state = value === undefined ? "unknown" : value > 0 ? "issues" : "clear";
      }
    }

    async function load() {
      const current = ++generation;
      try {
        const next = await ctx.api.getPasswordHealth();
        if (current !== generation || view.hidden) return;
        report = next;
        render();
      } catch (cause) {
        if (current === generation) showToast(errorText(cause, "errors.passwordHealth"), { type: "error" });
      }
    }

    function open() {
      deselect();
      for (const id of ["#entry-detail", "#item-detail", "#detail-empty"]) $(id).hidden = true;
      view.hidden = false;
      button.setAttribute("aria-expanded", "true");
      view.closest(".entry-detail-area").scrollTop = 0;
      void load();
    }

    // Hides the view; the caller shows whatever replaces it.
    function hide() {
      if (view.hidden) return;
      generation += 1;
      view.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    function close() {
      hide();
      $("#detail-empty").hidden = false;
    }

    // On lock: forget everything shown.
    function clear() {
      hide();
      report = null;
      checking = false;
      for (const list of Object.values(lists)) list.replaceChildren();
      for (const count of Object.values(counts)) count.textContent = "–";
    }

    button.addEventListener("click", () => (view.hidden ? open() : close()));
    $("#reports-close").addEventListener("click", close);
    $("#reports-refresh").addEventListener("click", () => void load());
    for (const tile of view.querySelectorAll("[data-report-tile]")) {
      tile.addEventListener("click", (event) => {
        event.preventDefault();
        $(`#report-${tile.dataset.reportTile}`).scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    checkButton.addEventListener("click", async () => {
      const current = generation;
      checking = true;
      renderBreaches();
      try {
        const next = await ctx.api.checkBreaches();
        if (current !== generation) return;
        report = next;
      } catch (cause) {
        if (current === generation) showToast(errorText(cause, "errors.breachCheck"), { type: "error" });
      } finally {
        checking = false;
        if (current === generation) render();
      }
    });
    onChange(() => {
      if (!view.hidden) render();
    });

    return { open, hide, close, clear, isOpen: () => !view.hidden };
  }

  ns.features.passwordHealth = { init };
})();
