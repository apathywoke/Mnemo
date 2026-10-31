// Entry point of the favicon decoder process, started by favicon-decoder.js
// with utilityProcess.fork(). It decodes one image, replies with the source
// dimensions and the icon's RGBA pixels, and is then killed by main (or
// earlier, when it takes too long).
const { prepareFaviconImage } = require("./favicon-image");

process.parentPort.once("message", ({ data }) => {
  let image = null;
  let reply;
  try {
    image = Buffer.from(data.image);
    const { width, height, icon } = prepareFaviconImage(image);
    // A copy with its own ArrayBuffer: structured cloning sends the whole
    // ArrayBuffer behind a view.
    reply = { ok: true, width, height, pixels: new Uint8Array(icon.pixels) };
    icon.pixels.fill(0);
  } catch {
    reply = { ok: false };
  } finally {
    image?.fill(0);
  }
  process.parentPort.postMessage(reply);
});
