// The light behind the access screens (access-glow.css): pools of the app's
// blues that drift slowly and flow into each other, with dark between them.
//
// They are drawn on a tiny canvas that CSS stretches over the window, so a
// frame is a few radial gradients on about 128 by 80 pixels, 20 times a
// second (the light moves slowly and is soft, so more frames would not
// show, but would cost). Drawing stops whenever nobody can see it move:
// the window is hidden or in the background, a vault is open, or the
// system asks for reduced motion (then one still frame is drawn).
//
// The light answers what happens on the screens: a new screen, a setup
// step, or a step in the title bar stirs the pools and runs the colors
// through a short shimmer; pressing a button stirs them a little.

const WIDTH = 128;
const FRAME_MS = 1000 / 20;
// How long the hue shimmer runs.
const SHIMMER_MS = 1400;
// Changes the observer reports: a screen, a setup step, or a stepper step.
const WATCHED = ".vault-panel, .setup-step, .setup-stepper li";

// Each pool: its color, its middle and radius (as parts of the width and
// height), and how far and how fast it wanders. The speeds have no common
// beat, so the picture does not visibly repeat.
const POOLS = [
  { rgb: [96, 156, 250], alpha: 0.44, x: 0.22, y: 0.2, r: 0.55, ax: 0.16, ay: 0.14, fx: 0.11, fy: 0.083, phase: 0 },
  { rgb: [120, 116, 248], alpha: 0.4, x: 0.86, y: 0.52, r: 0.5, ax: 0.14, ay: 0.2, fx: 0.071, fy: 0.097, phase: 2.1 },
  { rgb: [94, 208, 252], alpha: 0.34, x: 0.5, y: 1.0, r: 0.5, ax: 0.26, ay: 0.12, fx: 0.089, fy: 0.061, phase: 4.2 },
  { rgb: [59, 120, 245], alpha: 0.3, x: 0.36, y: 0.62, r: 0.42, ax: 0.22, ay: 0.18, fx: 0.053, fy: 0.117, phase: 1.3 },
];

/**
 * @param {Element} glow The .access-glow layer, holding the canvas.
 */
function start(glow) {
  const canvas = glow.querySelector("canvas");
  const context = canvas?.getContext("2d");
  if (!(glow instanceof HTMLElement) || !canvas || !context) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // The picture's own clock, in seconds; a stir makes it run faster for a
  // moment, which is what makes the pools swirl.
  let time = 0;
  let energy = 1.6;
  let turn = 1;
  let frame = 0;
  let lastTick = 0;
  let queued = false;

  function fitCanvas() {
    const box = glow.getBoundingClientRect();
    const height = box.width > 0 ? Math.max(1, Math.round(WIDTH * box.height / box.width)) : 80;
    if (canvas.height !== height) canvas.height = height;
  }

  function draw() {
    const { width, height } = canvas;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, width, height);
    // Overlapping light adds up, as light does.
    context.globalCompositeOperation = "lighter";
    for (const pool of POOLS) {
      const x = (pool.x + pool.ax * Math.sin(time * pool.fx + pool.phase)) * width;
      const y = (pool.y + pool.ay * Math.cos(time * pool.fy + pool.phase * 1.7)) * height;
      const radius = pool.r * width * (1 + 0.18 * Math.sin(time * (pool.fx + pool.fy) + pool.phase));
      const [red, green, blue] = pool.rgb;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgb(${red} ${green} ${blue} / ${pool.alpha})`);
      gradient.addColorStop(0.4, `rgb(${red} ${green} ${blue} / ${pool.alpha * 0.4})`);
      gradient.addColorStop(1, `rgb(${red} ${green} ${blue} / 0)`);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    // The middle stays calmer, so the form reads well: an oval there takes
    // away some of the light.
    context.globalCompositeOperation = "destination-out";
    context.save();
    context.translate(width / 2, height * 0.52);
    context.scale(1, (0.4 * height) / (0.3 * width));
    const calm = context.createRadialGradient(0, 0, 0, 0, 0, 0.3 * width);
    calm.addColorStop(0.2, "rgb(0 0 0 / 0.6)");
    calm.addColorStop(1, "rgb(0 0 0 / 0)");
    context.fillStyle = calm;
    context.fillRect(-width, -height * 2, width * 2, height * 4);
    context.restore();
  }

  function canMove() {
    return !reducedMotion.matches
      && !document.hidden
      && document.hasFocus()
      && !document.body.classList.contains("is-unlocked");
  }

  function tick() {
    frame = 0;
    if (!canMove()) return;
    const now = performance.now();
    const step = Math.min(0.2, (now - lastTick) / 1000);
    lastTick = now;
    time += step * (1 + energy * 5);
    energy *= Math.exp(-step * 1.6);
    draw();
    frame = window.setTimeout(tick, FRAME_MS);
  }

  function wake() {
    fitCanvas();
    if (reducedMotion.matches) {
      time = 0;
      draw();
      return;
    }
    if (frame || !canMove()) return;
    lastTick = performance.now();
    frame = window.setTimeout(tick, FRAME_MS);
  }

  /**
   * @param {number} strength 1 for a new screen, less for a press.
   */
  function stir(strength) {
    if (!canMove()) return;
    energy = Math.min(2, energy + strength);
    turn = -turn;
    const hue = 40 * turn * strength;
    glow.animate([
      { filter: "hue-rotate(0deg) brightness(1)" },
      { filter: `hue-rotate(${hue}deg) brightness(${1 + 0.35 * strength})`, offset: 0.35 },
      { filter: "hue-rotate(0deg) brightness(1)" },
    ], { duration: SHIMMER_MS, easing: "cubic-bezier(0.33, 0, 0.2, 1)" });
    wake();
  }

  // Several elements change at once when a screen changes; one stir.
  function screenChanged() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      wake();
      stir(1);
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
      if (target?.closest(".vault-panel button:not(:disabled)")) stir(0.5);
    });
  }
  window.addEventListener("focus", wake);
  window.addEventListener("resize", () => {
    fitCanvas();
    draw();
  });
  document.addEventListener("visibilitychange", wake);
  reducedMotion.addEventListener("change", wake);

  fitCanvas();
  draw();
  wake();
}

export { start };
