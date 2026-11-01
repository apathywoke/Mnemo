// Compares screens written by capture-screens.js, pixel by pixel.
//
//   node e2e/compare-screens.js <before>... -- <after>... [--diff <folder>]
//   node e2e/compare-screens.js <before> <after>
//
// Rendering can differ by a pixel or two between runs of the same code (an
// antialiased edge drawn or not), so each side may be captured more than
// once: a screen passes when some "after" image equals some "before" image
// in every pixel. Exits with 1 otherwise or if a screen is missing; with
// --diff, writes the closest pair of each failing screen with the changed
// pixels in red.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { encodePng } = require("../support/png");

// Decodes the 8-bit, non-interlaced RGB or RGBA PNGs that Chromium writes.
function decodeScreenshot(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colorType];
      if (bitDepth !== 8 || !channels || interlace !== 0) throw new Error("Unsupported PNG");
    } else if (type === "IDAT") {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4, 0xff);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        add = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      row[x] = (row[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) pixels[(y * width + x) * 4 + c] = row[x * channels + c];
    }
    previous = row;
  }
  return { width, height, pixels };
}

function parseArguments(args) {
  const diffIndex = args.indexOf("--diff");
  const diffFolder = diffIndex >= 0 ? args[diffIndex + 1] : null;
  const folders = diffIndex >= 0 ? [...args.slice(0, diffIndex), ...args.slice(diffIndex + 2)] : args;
  const split = folders.indexOf("--");
  const [before, after] = split >= 0
    ? [folders.slice(0, split), folders.slice(split + 1)]
    : [folders.slice(0, 1), folders.slice(1, 2)];
  if (before.length === 0 || after.length === 0) {
    throw new Error("Usage: node e2e/compare-screens.js <before>... -- <after>... [--diff <folder>]");
  }
  return { before, after, diffFolder };
}

// Changed pixels between two decoded images, or null if their sizes differ.
function changedPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  const changed = [];
  for (let i = 0; i < a.pixels.length; i += 4) {
    if (a.pixels.readUInt32BE(i) !== b.pixels.readUInt32BE(i)) changed.push(i);
  }
  return changed;
}

async function readAll(folders, name) {
  const files = await Promise.all(folders.map((folder) => fs.readFile(path.join(folder, name)).catch(() => null)));
  return files.filter(Boolean);
}

async function main() {
  const { before, after, diffFolder } = parseArguments(process.argv.slice(2));
  const listings = await Promise.all([...before, ...after].map((folder) => fs.readdir(folder)));
  const names = new Set(listings.flat().filter((name) => name.endsWith(".png")));
  let failed = false;
  for (const name of [...names].sort()) {
    const [beforeFiles, afterFiles] = await Promise.all([readAll(before, name), readAll(after, name)]);
    if (beforeFiles.length !== before.length || afterFiles.length !== after.length) {
      console.log(`${name}: missing in some folders`);
      failed = true;
      continue;
    }
    if (afterFiles.some((file) => beforeFiles.some((other) => other.equals(file)))) {
      console.log(`${name}: identical`);
      continue;
    }
    const decodedBefore = beforeFiles.map(decodeScreenshot);
    const decodedAfter = afterFiles.map(decodeScreenshot);
    let closest = null;
    for (const a of decodedBefore) {
      for (const b of decodedAfter) {
        const changed = changedPixels(a, b);
        if (changed && (!closest || changed.length < closest.changed.length)) closest = { b, changed };
      }
    }
    if (closest?.changed.length === 0) {
      console.log(`${name}: identical pixels`);
      continue;
    }
    failed = true;
    if (!closest) {
      console.log(`${name}: sizes differ`);
      continue;
    }
    console.log(`${name}: ${closest.changed.length} pixels differ`);
    if (diffFolder) {
      const { b, changed } = closest;
      const diff = Buffer.from(b.pixels);
      for (const i of changed) diff.writeUInt32BE(0xff0000ff, i);
      await fs.mkdir(diffFolder, { recursive: true });
      const png = encodePng({
        width: b.width,
        height: b.height,
        sample: (x, y) => diff.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4),
      });
      await fs.writeFile(path.join(diffFolder, name), png);
    }
  }
  console.log(failed ? "Screens differ." : `All ${names.size} screens are identical.`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
