// Site icons downloaded from websites. The decoding below runs only in the
// favicon decoder process (favicon-decoder-process.js), never in main: PNG,
// ICO, and sequential JPEG (favicon-jpeg.js) are decoded in plain JavaScript,
// so no native image codec parses bytes from a website; other formats are
// not supported. The decoder hands back RGBA pixels at icon size; main checks
// their size with iconSize() and encodes the PNG it stores with
// encodeRgbaPng().
const { deflateSync, inflateSync, constants: zlibConstants } = require("node:zlib");
const { decodeJpeg } = require("./favicon-jpeg");

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_ICON_DIMENSION = 512;
const OUTPUT_ICON_SIZE = 96;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Channels of each PNG color type and the bit depths it allows.
const PNG_COLOR_TYPES = new Map([
  [0, { channels: 1, bitDepths: [1, 2, 4, 8, 16] }], // gray
  [2, { channels: 3, bitDepths: [8, 16] }], // RGB
  [3, { channels: 1, bitDepths: [1, 2, 4, 8] }], // palette index
  [4, { channels: 2, bitDepths: [8, 16] }], // gray and alpha
  [6, { channels: 4, bitDepths: [8, 16] }], // RGBA
]);
// Adam7 interlacing: first column, first row, column step, row step.
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];
// The chunks the decoder reads; their CRCs must match.
const CHECKED_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
// Decompressed bytes past the end of the image are ignored, as libpng does,
// up to this many; a stream that inflates further is refused unread.
const MAX_EXTRA_IMAGE_BYTES = 64 * 1024;

// The reason stays in the decoder process: main learns only that the image
// could not be used, and reports its own translated error.
function invalidImage(reason) {
  return new Error(reason);
}

function isWithinIconBounds(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_ICON_DIMENSION &&
    height <= MAX_ICON_DIMENSION
  );
}

// Width and height from a PNG's IHDR, or null if the data does not start like
// a PNG of icon size.
function readPngSize(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return isWithinIconBounds(width, height) ? { width, height } : null;
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- PNG decoding --------------------------------------------------------------

function readPngHeader(body) {
  if (body.length !== 13) throw invalidImage("PNG header has the wrong length");
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const [bitDepth, colorType, compression, filter, interlace] = body.subarray(8, 13);
  if (!isWithinIconBounds(width, height)) throw invalidImage("PNG dimensions are not supported");
  const color = PNG_COLOR_TYPES.get(colorType);
  if (!color?.bitDepths.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
    throw invalidImage("PNG format is not supported");
  }
  return { width, height, bitDepth, colorType, channels: color.channels, interlaced: interlace === 1 };
}

// Splits a PNG into the chunks the decoder uses. Unknown ancillary chunks are
// skipped; an unknown critical chunk would change how the image is read, so
// it is refused. A missing IEND is accepted if the image data is complete.
function readPngChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalidImage("Not a PNG image");
  }
  const png = { header: null, palette: null, transparency: null, data: [] };
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw invalidImage("PNG chunk is truncated");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalidImage("PNG chunk type is invalid");
    if (length > buffer.length || end + 4 > buffer.length) throw invalidImage("PNG chunk is truncated");
    if (CHECKED_CHUNKS.has(type) && pngCrc32(buffer.subarray(offset + 4, end)) !== buffer.readUInt32BE(end)) {
      throw invalidImage(`PNG chunk ${type} has a wrong CRC`);
    }
    const body = buffer.subarray(offset + 8, end);
    offset = end + 4;

    if (!png.header && type !== "IHDR") throw invalidImage("PNG does not start with IHDR");
    if (type === "IHDR") {
      if (png.header) throw invalidImage("PNG has two headers");
      png.header = readPngHeader(body);
    } else if (type === "PLTE") {
      png.palette = body;
    } else if (type === "tRNS") {
      png.transparency = body;
    } else if (type === "IDAT") {
      png.data.push(body);
    } else if (type === "IEND") {
      break;
    } else if (type.charCodeAt(0) < 0x61) {
      throw invalidImage(`PNG chunk ${type} is not supported`);
    }
  }
  if (!png.header || png.data.length === 0) throw invalidImage("PNG has no image data");
  return png;
}

function readPalette(chunk) {
  if (!chunk || chunk.length === 0 || chunk.length % 3 !== 0 || chunk.length > 256 * 3) {
    throw invalidImage("PNG palette is missing or invalid");
  }
  return chunk;
}

// tRNS: an alpha value per palette entry, or the one gray level or RGB color
// that is fully transparent (stored as 16-bit values at any bit depth).
function readTransparency(chunk, colorType, paletteEntries) {
  if (!chunk) return null;
  if (colorType === 3) return chunk.subarray(0, Math.min(chunk.length, paletteEntries));
  if (colorType === 0 && chunk.length >= 2) return { gray: chunk.readUInt16BE(0) };
  if (colorType === 2 && chunk.length >= 6) {
    return { red: chunk.readUInt16BE(0), green: chunk.readUInt16BE(2), blue: chunk.readUInt16BE(4) };
  }
  return null;
}

// The passes in which the image data is stored: one for a plain image, up to
// seven for Adam7. Empty passes (a small image has some) hold no data.
function pngPasses({ width, height, interlaced, channels, bitDepth }) {
  const passes = interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]];
  return passes
    .map(([x, y, stepX, stepY]) => {
      const passWidth = Math.max(0, Math.ceil((width - x) / stepX));
      const passHeight = Math.max(0, Math.ceil((height - y) / stepY));
      const rowBytes = Math.ceil((passWidth * channels * bitDepth) / 8);
      return { x, y, stepX, stepY, width: passWidth, height: passHeight, rowBytes };
    })
    .filter((pass) => pass.width > 0 && pass.height > 0);
}

// Inflates the IDAT data, which must hold at least `expected` bytes. The
// output limit makes a decompression bomb fail early instead of filling
// memory.
function inflateImageData(chunks, expected) {
  const compressed = Buffer.concat(chunks);
  let raw;
  try {
    raw = inflateSync(compressed, {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
      maxOutputLength: expected + MAX_EXTRA_IMAGE_BYTES,
    });
  } catch {
    throw invalidImage("PNG image data does not decompress");
  } finally {
    compressed.fill(0);
  }
  if (raw.length < expected) {
    raw.fill(0);
    throw invalidImage("PNG image data is incomplete");
  }
  return raw;
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

// Reverses the per-row filters of one pass in place. Each row starts with its
// filter type; the row before the first is all zeros.
function unfilterPass(raw, start, { height, rowBytes }, bytesPerPixel) {
  const stride = rowBytes + 1;
  for (let row = 0; row < height; row += 1) {
    const rowStart = start + row * stride + 1;
    const previousStart = row > 0 ? rowStart - stride : -1;
    const filter = raw[rowStart - 1];
    if (filter > 4) throw invalidImage("PNG row filter is invalid");
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? raw[rowStart + index - bytesPerPixel] : 0;
      const up = previousStart >= 0 ? raw[previousStart + index] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const upLeft = previousStart >= 0 && index >= bytesPerPixel
          ? raw[previousStart + index - bytesPerPixel]
          : 0;
        predictor = paethPredictor(left, up, upLeft);
      }
      raw[rowStart + index] = (raw[rowStart + index] + predictor) & 0xff;
    }
  }
}

// Sample `index` of a row (pixel × channels + channel) at the image's bit
// depth.
function readSample(raw, rowStart, index, bitDepth) {
  if (bitDepth === 8) return raw[rowStart + index];
  if (bitDepth === 16) return (raw[rowStart + index * 2] << 8) | raw[rowStart + index * 2 + 1];
  const bit = index * bitDepth;
  return (raw[rowStart + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
}

// Writes the pixels of one unfiltered pass into the RGBA output.
function writePassPixels(raw, start, pass, png, output) {
  const { width, bitDepth, colorType, channels } = png.header;
  const maxSample = 2 ** bitDepth - 1;
  const to8Bit = (value) => (bitDepth === 8 ? value : Math.round((value * 255) / maxSample));
  const { palette, transparency } = png;
  for (let row = 0; row < pass.height; row += 1) {
    const rowStart = start + row * (pass.rowBytes + 1) + 1;
    const y = pass.y + row * pass.stepY;
    for (let column = 0; column < pass.width; column += 1) {
      const x = pass.x + column * pass.stepX;
      const offset = (y * width + x) * 4;
      const sample = (channel) => readSample(raw, rowStart, column * channels + channel, bitDepth);
      let red;
      let green;
      let blue;
      let alpha = 255;
      if (colorType === 3) {
        const index = sample(0);
        if (index * 3 >= palette.length) throw invalidImage("PNG palette index is out of range");
        red = palette[index * 3];
        green = palette[index * 3 + 1];
        blue = palette[index * 3 + 2];
        if (transparency && index < transparency.length) alpha = transparency[index];
      } else if (colorType === 0 || colorType === 4) {
        const gray = sample(0);
        red = to8Bit(gray);
        green = red;
        blue = red;
        if (colorType === 4) alpha = to8Bit(sample(1));
        else if (transparency && gray === transparency.gray) alpha = 0;
      } else {
        const values = [sample(0), sample(1), sample(2)];
        [red, green, blue] = values.map(to8Bit);
        if (colorType === 6) {
          alpha = to8Bit(sample(3));
        } else if (
          transparency &&
          values[0] === transparency.red &&
          values[1] === transparency.green &&
          values[2] === transparency.blue
        ) {
          alpha = 0;
        }
      }
      output[offset] = red;
      output[offset + 1] = green;
      output[offset + 2] = blue;
      output[offset + 3] = alpha;
    }
  }
}

// Decodes a PNG of any standard color type, bit depth, and interlacing into
// 8-bit RGBA. Gamma and color profile chunks are ignored.
function decodePng(buffer) {
  const png = readPngChunks(buffer);
  const { header } = png;
  if (header.colorType === 3) png.palette = readPalette(png.palette);
  png.transparency = readTransparency(png.transparency, header.colorType, (png.palette?.length ?? 0) / 3);

  const passes = pngPasses(header);
  const expected = passes.reduce((total, pass) => total + pass.height * (pass.rowBytes + 1), 0);
  const bytesPerPixel = Math.max(1, (header.channels * header.bitDepth) >> 3);
  const raw = inflateImageData(png.data, expected);
  const pixels = Buffer.alloc(header.width * header.height * 4);
  try {
    let start = 0;
    for (const pass of passes) {
      unfilterPass(raw, start, pass, bytesPerPixel);
      writePassPixels(raw, start, pass, png, pixels);
      start += pass.height * (pass.rowBytes + 1);
    }
  } catch (error) {
    pixels.fill(0);
    throw error;
  } finally {
    raw.fill(0);
  }
  return { width: header.width, height: header.height, pixels };
}

// --- ICO decoding --------------------------------------------------------------

// Picks the sharpest image in an ICO (PNG-backed, or an uncompressed 24/32-bit
// bitmap) and decodes it.
function decodeIco(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw invalidImage("Not an ICO image");
  }

  const imageCount = buffer.readUInt16LE(4);
  const directoryEnd = 6 + imageCount * 16;
  if (imageCount < 1 || imageCount > 64 || directoryEnd > buffer.length) {
    throw invalidImage("ICO directory is invalid");
  }

  let bestPng = null;
  let bestPngQuality = 0;
  let bestPngArea = 0;
  let bestDib = null;
  let bestDibQuality = 0;
  let bestDibArea = 0;
  for (let index = 0; index < imageCount; index += 1) {
    const offset = 6 + index * 16;
    const directoryWidth = buffer[offset] || 256;
    const directoryHeight = buffer[offset + 1] || 256;
    const imageBytes = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    const imageEnd = imageOffset + imageBytes;

    if (
      !isWithinIconBounds(directoryWidth, directoryHeight) ||
      imageBytes < 8 ||
      imageOffset < directoryEnd ||
      imageEnd > buffer.length
    ) {
      throw invalidImage("ICO directory entry is invalid");
    }

    const image = buffer.subarray(imageOffset, imageEnd);
    if (image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      const size = readPngSize(image);
      if (!size) throw invalidImage("ICO contains a PNG of unsupported size");
      const quality = Math.min(size.width, size.height);
      const area = size.width * size.height;
      if (quality > bestPngQuality || (quality === bestPngQuality && area > bestPngArea)) {
        bestPng = image;
        bestPngQuality = quality;
        bestPngArea = area;
      }
      continue;
    }

    if (image.length < 40) {
      continue;
    }
    const headerSize = image.readUInt32LE(0);
    const width = image.readInt32LE(4);
    const storedHeight = image.readInt32LE(8);
    const height = storedHeight / 2;
    if (
      headerSize < 40 ||
      headerSize > image.length ||
      width !== directoryWidth ||
      height !== directoryHeight ||
      !isWithinIconBounds(width, height) ||
      image.readUInt16LE(12) !== 1
    ) {
      continue;
    }

    const bitDepth = image.readUInt16LE(14);
    const compression = image.readUInt32LE(16);
    if (![24, 32].includes(bitDepth) || compression !== 0) continue;

    const xorStride = Math.ceil((width * bitDepth) / 32) * 4;
    const maskStride = Math.ceil(width / 32) * 4;
    const xorBytes = xorStride * height;
    const maskBytes = maskStride * height;
    if (headerSize + xorBytes > image.length) continue;
    if (bitDepth === 24 && headerSize + xorBytes + maskBytes > image.length) continue;

    const area = width * height;
    const quality = Math.min(width, height);
    if (quality > bestDibQuality || (quality === bestDibQuality && area > bestDibArea)) {
      bestDib = { image, width, height, headerSize, bitDepth, xorStride, maskStride, xorBytes };
      bestDibQuality = quality;
      bestDibArea = area;
    }
  }

  if (
    bestPng &&
    (bestPngQuality > bestDibQuality ||
      (bestPngQuality === bestDibQuality && bestPngArea >= bestDibArea))
  ) {
    return decodePng(bestPng);
  }
  if (bestDib) return decodeIcoDib(bestDib);
  throw invalidImage("ICO contains no supported image");
}

// An ICO bitmap: bottom-up BGR(A) rows, then a 1-bit AND mask that marks
// transparent pixels when the bitmap has no alpha of its own.
function decodeIcoDib(icon) {
  const { image, width, height, headerSize, bitDepth, xorStride, maskStride, xorBytes } = icon;
  const maskOffset = headerSize + xorBytes;
  const hasMask = maskOffset + maskStride * height <= image.length;
  const pixels = Buffer.alloc(width * height * 4);
  let alphaIsEmpty = bitDepth === 32;

  for (let y = 0; y < height; y += 1) {
    const sourceRow = height - 1 - y;
    const sourceOffset = headerSize + sourceRow * xorStride;
    for (let x = 0; x < width; x += 1) {
      const sourcePixelOffset = sourceOffset + x * (bitDepth / 8);
      const pixelOffset = (y * width + x) * 4;
      pixels[pixelOffset] = image[sourcePixelOffset + 2];
      pixels[pixelOffset + 1] = image[sourcePixelOffset + 1];
      pixels[pixelOffset + 2] = image[sourcePixelOffset];
      const alpha = bitDepth === 32 ? image[sourcePixelOffset + 3] : 255;
      pixels[pixelOffset + 3] = alpha;
      if (alpha !== 0) alphaIsEmpty = false;
    }
  }

  if (bitDepth === 32 && alphaIsEmpty) {
    for (let y = 0; y < height; y += 1) {
      const sourceRow = height - 1 - y;
      const maskRowOffset = maskOffset + sourceRow * maskStride;
      for (let x = 0; x < width; x += 1) {
        const transparent = hasMask && (image[maskRowOffset + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
        pixels[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  } else if (hasMask) {
    for (let y = 0; y < height; y += 1) {
      const sourceRow = height - 1 - y;
      const maskRowOffset = maskOffset + sourceRow * maskStride;
      for (let x = 0; x < width; x += 1) {
        if ((image[maskRowOffset + (x >> 3)] & (0x80 >> (x & 7))) !== 0) {
          pixels[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  }

  return { width, height, pixels };
}

function decodeFaviconImage(buffer) {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return decodePng(buffer);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return decodeJpeg(buffer, MAX_ICON_DIMENSION);
  }
  if (buffer.length >= 4 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) {
    return decodeIco(buffer);
  }
  throw invalidImage("Not a PNG, JPEG, or ICO image");
}

// --- Resizing and PNG encoding ------------------------------------------------

// For each output column (or row): the source columns it covers, and how much
// of each.
function coverage(sourceSize, outputSize) {
  const ratio = sourceSize / outputSize;
  return Array.from({ length: outputSize }, (_, index) => {
    const start = index * ratio;
    const end = start + ratio;
    const covered = [];
    for (let source = Math.floor(start); source < end && source < sourceSize; source += 1) {
      const weight = Math.min(end, source + 1) - Math.max(start, source);
      if (weight > 0) covered.push([source, weight]);
    }
    return covered;
  });
}

// The size of the stored icon for a source image: at most `maxSize` square,
// the same aspect ratio, never enlarged.
function iconSize(width, height, maxSize = OUTPUT_ICON_SIZE) {
  const scale = Math.min(1, maxSize / width, maxSize / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Shrinks an RGBA image to iconSize() by averaging the source pixels each
// output pixel covers. Colors are weighted by alpha, so transparent pixels do
// not darken edges. An image that already fits is returned as it is.
function downscaleImage(image, maxSize = OUTPUT_ICON_SIZE) {
  const { width, height, pixels } = image;
  const { width: outputWidth, height: outputHeight } = iconSize(width, height, maxSize);
  if (outputWidth === width && outputHeight === height) return image;

  const columns = coverage(width, outputWidth);
  const rows = coverage(height, outputHeight);
  const output = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let area = 0;
      for (const [sourceY, rowWeight] of rows[y]) {
        for (const [sourceX, columnWeight] of columns[x]) {
          const weight = rowWeight * columnWeight;
          const offset = (sourceY * width + sourceX) * 4;
          const weightedAlpha = pixels[offset + 3] * weight;
          red += pixels[offset] * weightedAlpha;
          green += pixels[offset + 1] * weightedAlpha;
          blue += pixels[offset + 2] * weightedAlpha;
          alpha += weightedAlpha;
          area += weight;
        }
      }
      const offset = (y * outputWidth + x) * 4;
      if (alpha > 0) {
        output[offset] = Math.round(red / alpha);
        output[offset + 1] = Math.round(green / alpha);
        output[offset + 2] = Math.round(blue / alpha);
      }
      output[offset + 3] = Math.round(alpha / area);
    }
  }
  return { width: outputWidth, height: outputHeight, pixels: output };
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodeRgbaPng(width, height, pixels) {
  const scanlineLength = width * 4 + 1;
  const scanlines = Buffer.alloc(scanlineLength * height);
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * scanlineLength;
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, row * width * 4, (row + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const compressed = deflateSync(scanlines);
  scanlines.fill(0);
  const png = Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
  compressed.fill(0);
  return png;
}

// The decoder process's whole job: decode a PNG or ICO and shrink it to the
// stored icon size. Returns the source dimensions, by which main ranks
// candidates, and the icon's RGBA pixels.
function prepareFaviconImage(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw invalidImage("Image size is not supported");
  }
  const image = decodeFaviconImage(buffer);
  const icon = downscaleImage(image);
  if (icon !== image) image.pixels.fill(0);
  return { width: image.width, height: image.height, icon };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_ICON_DIMENSION,
  MAX_OUTPUT_BYTES,
  OUTPUT_ICON_SIZE,
  isWithinIconBounds,
  readPngSize,
  decodePng,
  decodeIco,
  decodeFaviconImage,
  iconSize,
  downscaleImage,
  encodeRgbaPng,
  prepareFaviconImage,
};
