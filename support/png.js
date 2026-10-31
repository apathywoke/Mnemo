// A small PNG encoder for tests, independent of src/main/favicon-image.js:
// any color type and bit depth, any row filter, and Adam7 interlacing.
const { deflateSync } = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function filterRow(type, row, previous, bytesPerPixel) {
  const out = Buffer.alloc(row.length);
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous[index];
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
    let predictor = 0;
    if (type === 1) predictor = left;
    if (type === 2) predictor = up;
    if (type === 3) predictor = Math.floor((left + up) / 2);
    if (type === 4) {
      const estimate = left + up - upLeft;
      const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
      predictor = distances[0] <= distances[1] && distances[0] <= distances[2]
        ? left
        : distances[1] <= distances[2] ? up : upLeft;
    }
    out[index] = (row[index] - predictor + 256) % 256;
  }
  return out;
}

// The filtered scanlines, before compression. `sample(x, y)` returns the
// channel values of a pixel at the bit depth; `filter(row)` the filter type.
function encodeScanlines({ width, height, colorType, bitDepth, interlaced, sample, filter }) {
  const channels = CHANNELS[colorType];
  const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8);
  const lines = [];
  let rowNumber = 0;
  for (const [startX, startY, stepX, stepY] of interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
    const passWidth = Math.max(0, Math.ceil((width - startX) / stepX));
    const passHeight = Math.max(0, Math.ceil((height - startY) / stepY));
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * channels * bitDepth) / 8);
    let previous = Buffer.alloc(rowBytes);
    for (let row = 0; row < passHeight; row += 1) {
      const line = Buffer.alloc(rowBytes);
      let bit = 0;
      for (let column = 0; column < passWidth; column += 1) {
        for (const value of sample(startX + column * stepX, startY + row * stepY)) {
          if (bitDepth === 16) line.writeUInt16BE(value, bit / 8);
          else if (bitDepth === 8) line[bit / 8] = value;
          else line[bit >> 3] |= value << (8 - bitDepth - (bit & 7));
          bit += bitDepth;
        }
      }
      const type = filter(rowNumber);
      rowNumber += 1;
      lines.push(Buffer.from([type]), filterRow(type, line, previous, Math.floor(bytesPerPixel) || 1));
      previous = line;
    }
  }
  return Buffer.concat(lines);
}

// Encodes a PNG. `chunks` (optional) replaces the default chunk list, given
// the encoded parts: { header, palette, transparency, data }.
function encodePng({
  width,
  height,
  colorType = 6,
  bitDepth = 8,
  interlaced = false,
  sample = () => [0x35, 0x70, 0xc0, 0xff],
  filter = () => 0,
  palette = null,
  transparency = null,
  idatParts = 1,
  chunks = null,
}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlaced ? 1 : 0;
  const data = deflateSync(encodeScanlines({ width, height, colorType, bitDepth, interlaced, sample, filter }));
  const parts = {
    header: chunk("IHDR", header),
    palette: palette ? chunk("PLTE", Buffer.from(palette.flat())) : null,
    transparency: transparency ? chunk("tRNS", Buffer.from(transparency)) : null,
    data: Array.from({ length: idatParts }, (_, index) => {
      const size = Math.ceil(data.length / idatParts);
      return chunk("IDAT", data.subarray(index * size, (index + 1) * size));
    }),
    end: chunk("IEND"),
  };
  const list = chunks ? chunks(parts) : [parts.header, parts.palette, parts.transparency, ...parts.data, parts.end];
  return Buffer.concat([SIGNATURE, ...list.filter(Boolean)]);
}

// A solid RGBA PNG of the given size.
function makePng(width, height, color = [0x35, 0x70, 0xc0, 0xff]) {
  return encodePng({ width, height, sample: () => color });
}

// An ICO holding the given images, each { width, height, data } (PNG or BMP
// bytes); width and height go into the directory.
function makeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ width, height, data }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = width === 256 ? 0 : width;
    directory[entry + 1] = height === 256 ? 0 : height;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...images.map(({ data }) => data)]);
}

// A bottom-up BMP for an ICO: `pixel(x, y)` gives [r, g, b, a] for 32-bit
// or [r, g, b] for 24-bit; `masked(x, y)` sets the AND mask bit.
function makeIcoBitmap(width, height, { bitDepth = 32, pixel, masked = () => false }) {
  const xorStride = Math.ceil((width * bitDepth) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const image = Buffer.alloc(40 + xorStride * height + maskStride * height);
  image.writeUInt32LE(40, 0);
  image.writeInt32LE(width, 4);
  image.writeInt32LE(height * 2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(bitDepth, 14);
  for (let y = 0; y < height; y += 1) {
    const row = 40 + (height - 1 - y) * xorStride;
    const maskRow = 40 + xorStride * height + (height - 1 - y) * maskStride;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y);
      const offset = row + x * (bitDepth / 8);
      image[offset] = blue;
      image[offset + 1] = green;
      image[offset + 2] = red;
      if (bitDepth === 32) image[offset + 3] = alpha;
      if (masked(x, y)) image[maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return image;
}

module.exports = { crc32, chunk, encodePng, makePng, makeIco, makeIcoBitmap };
