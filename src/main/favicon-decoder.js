// Decodes a downloaded site icon in a separate process, so main never parses
// image data from a website. Each image gets a new utilityProcess running
// favicon-decoder-process.js: it receives the image bytes and nothing else,
// has a few seconds to reply, and is killed afterwards. It replies with RGBA
// pixels only; main checks their size and encodes the stored PNG itself, so
// no image format from the decoder reaches main or the vault. A crash or a
// hang there only fails this icon.
const path = require("node:path");
const { utilityProcess } = require("electron");
const {
  MAX_IMAGE_BYTES,
  MAX_OUTPUT_BYTES,
  encodeRgbaPng,
  iconSize,
  isWithinIconBounds,
} = require("./favicon-image");

const DECODER_PATH = path.join(__dirname, "favicon-decoder-process.js");
const DECODE_TIMEOUT_MS = 5000;
// Electron 45 starts the process with main's whole environment when `env` is
// empty, so it gets one variable of its own and nothing from main.
const DECODER_ENV = Object.freeze({ MNEMO_FAVICON_DECODER: "1" });

// The decoder's reply, checked: { png, width, height } for a decoded icon,
// null when the decoder could not use the image, and undefined for anything
// else. The pixels must be exactly the icon size for the source dimensions.
function readReply(message) {
  if (message?.ok === false) return null;
  if (message?.ok !== true || !(message.pixels instanceof Uint8Array)) return undefined;
  const { width, height } = message;
  if (!isWithinIconBounds(width, height)) return undefined;
  const icon = iconSize(width, height);
  if (message.pixels.length !== icon.width * icon.height * 4) return undefined;

  const pixels = Buffer.from(message.pixels);
  const png = encodeRgbaPng(icon.width, icon.height, pixels);
  pixels.fill(0);
  if (png.length > MAX_OUTPUT_BYTES) {
    png.fill(0);
    return undefined;
  }
  return { png, width, height };
}

// Resolves with { png, width, height } (width and height of the source
// image), or with null if the image is not a usable PNG or ICO. Rejects if the
// decoder cannot start, does not reply in time, exits, or replies with
// something else.
function decodeFavicon(image, {
  fork = (...args) => utilityProcess.fork(...args),
  timeoutMs = DECODE_TIMEOUT_MS,
} = {}) {
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > MAX_IMAGE_BYTES) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    let child = null;
    let timer = null;
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // The process is already gone.
      }
      if (error) reject(error);
      else resolve(result);
    };
    const fail = () => settle(new Error("The site icon could not be processed."));

    try {
      child = fork(DECODER_PATH, [], {
        serviceName: "Mnemo favicon decoder",
        env: { ...DECODER_ENV },
        stdio: "ignore",
      });
    } catch {
      fail();
      return;
    }
    timer = setTimeout(() => settle(new Error("Processing the site icon took too long.")), timeoutMs);
    child.on("message", (message) => {
      const reply = readReply(message);
      if (reply === undefined) fail();
      else settle(null, reply);
    });
    // Without a listener, an "error" event would throw in main.
    child.on("error", fail);
    child.on("exit", fail);

    // A copy with its own ArrayBuffer: structured cloning sends the whole
    // ArrayBuffer behind a view, and a small Buffer shares Node's pool with
    // other data in main.
    const copy = new Uint8Array(image.length);
    copy.set(image);
    try {
      child.postMessage({ image: copy });
    } catch {
      fail();
    } finally {
      copy.fill(0);
    }
  });
}

module.exports = { decodeFavicon, DECODE_TIMEOUT_MS };
