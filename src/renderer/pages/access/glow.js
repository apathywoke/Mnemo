// Makes the glow behind the access screens (access-glow.css) answer what
// happens on them: when a screen or a setup step changes, the ribbons drift
// and the colors run through a short shimmer; pressing a button on a screen
// gives a smaller one. Each shimmer is a Web Animation that adds to the
// glow's own style (composite "add"), so shimmers that overlap blend
// instead of jumping, and every one ends where it began. They animate only
// transform and filter, which the compositor runs, and nothing moves
// between shimmers. With reduced motion, a hidden window, or an open vault
// there is no shimmer.

const DURATION_MS = 1400;
const EASING = "cubic-bezier(0.33, 0, 0.2, 1)";
// How far each ribbon drifts at full strength, in pixels.
const DRIFT = [
  [46, -22],
  [-54, 26],
  [34, 18],
];
// Changes the observer reports: a screen, a setup step, or a stepper step.
const WATCHED = ".vault-panel, .setup-step, .setup-stepper li";

/**
 * @param {Element} glow The .access-glow layer.
 */
function start(glow) {
  const ribbons = [...glow.children];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let turn = 1;
  let queued = false;

  function quiet() {
    return reducedMotion.matches
      || document.hidden
      || document.body.classList.contains("is-unlocked")
      || glow.getAnimations().length > 3;
  }

  /**
   * @param {number} strength 1 for a new screen, less for a press.
   */
  function shimmer(strength) {
    if (quiet()) return;
    turn = -turn;
    const options = { duration: DURATION_MS, easing: EASING, composite: /** @type {const} */ ("add") };
    const hue = 48 * turn * strength;
    glow.animate([
      { filter: "hue-rotate(0deg) saturate(1) brightness(1)" },
      { filter: `hue-rotate(${hue}deg) saturate(${1 + 0.45 * strength}) brightness(${1 + 0.4 * strength})`, offset: 0.35 },
      { filter: "hue-rotate(0deg) saturate(1) brightness(1)" },
    ], options);
    ribbons.forEach((ribbon, index) => {
      const [x, y] = DRIFT[index % DRIFT.length];
      const dx = x * turn * strength;
      const dy = y * turn * strength;
      ribbon.animate([
        { translate: "0px 0px", scale: "1" },
        { translate: `${dx}px ${dy}px`, scale: `${1 + 0.06 * strength}`, offset: 0.35 },
        { translate: "0px 0px", scale: "1" },
      ], { ...options, delay: index * 70 });
    });
  }

  // Several elements change at once when a screen changes; one shimmer.
  function screenChanged() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      shimmer(1);
    });
  }

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target instanceof Element && record.target.matches(WATCHED))) {
      screenChanged();
    }
  });
  const workspace = glow.parentElement;
  if (workspace) {
    observer.observe(workspace, { attributes: true, attributeFilter: ["hidden", "aria-current"], subtree: true });
    workspace.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".vault-panel button:not(:disabled)")) shimmer(0.5);
    });
  }
}

export { start };
