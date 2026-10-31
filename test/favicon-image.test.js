const assert = require("node:assert/strict");
const test = require("node:test");
const { deflateSync } = require("node:zlib");
const { chunk, crc32, encodePng, makePng, makeIco, makeIcoBitmap } = require("../support/png");
const {
  MAX_IMAGE_BYTES,
  MAX_OUTPUT_BYTES,
  OUTPUT_ICON_SIZE,
  readPngSize,
  decodePng,
  decodeIco,
  decodeFaviconImage,
  iconSize,
  downscaleImage,
  encodeRgbaPng,
  prepareFaviconImage,
} = require("../src/main/favicon-image");

const FORMATS = [
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Deterministic sample values that cover the whole range at a bit depth.
function sampleValue(x, y, channel, bitDepth) {
  const range = 2 ** bitDepth;
  return (x * 7919 + y * 104729 + channel * 15485863 + x * y * 31) % range;
}

function to8Bit(value, bitDepth) {
  return bitDepth === 8 ? value : Math.round((value * 255) / (2 ** bitDepth - 1));
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
}

// The RGBA a correct decoder must produce for each format, from the PNG
// specification: samples scaled to 8 bits, palette lookup, and tRNS.
function expectedPixel({ colorType, bitDepth, palette, alphas, key }, values) {
  if (colorType === 3) {
    const [index] = values;
    return [...palette[index], index < alphas.length ? alphas[index] : 255];
  }
  if (colorType === 0 || colorType === 4) {
    const gray = to8Bit(values[0], bitDepth);
    let alpha = colorType === 4 ? to8Bit(values[1], bitDepth) : 255;
    if (colorType === 0 && key !== undefined && values[0] === key[0]) alpha = 0;
    return [gray, gray, gray, alpha];
  }
  const color = values.slice(0, 3).map((value) => to8Bit(value, bitDepth));
  let alpha = colorType === 6 ? to8Bit(values[3], bitDepth) : 255;
  if (colorType === 2 && key && values.slice(0, 3).every((value, index) => value === key[index])) alpha = 0;
  return [...color, alpha];
}

function sixteenBit(values) {
  return values.flatMap((value) => [value >> 8, value & 0xff]);
}

function formatCase(colorType, bitDepth, interlaced, width, height) {
  const channels = CHANNELS[colorType];
  const sample = (x, y) => Array.from({ length: channels }, (_, channel) => sampleValue(x, y, channel, bitDepth));
  const format = { colorType, bitDepth, alphas: [] };
  let palette = null;
  let transparency = null;
  if (colorType === 3) {
    const entries = 2 ** bitDepth;
    palette = Array.from({ length: entries }, (_, index) => [(index * 3) % 256, (index * 7) % 256, (index * 11) % 256]);
    format.palette = palette;
    format.alphas = Array.from({ length: Math.ceil(entries / 2) }, (_, index) => (index * 37) % 256);
    transparency = format.alphas;
  } else if (colorType === 0 || colorType === 2) {
    // The color of pixel (1, 0) becomes fully transparent.
    format.key = sample(1, 0);
    transparency = sixteenBit(format.key);
  }
  const png = encodePng({
    width,
    height,
    colorType,
    bitDepth,
    interlaced,
    sample,
    palette,
    transparency,
    filter: (row) => row % 5,
  });
  return { png, sample, format };
}

test("every PNG color type, bit depth, filter, and interlacing decodes to the right RGBA", () => {
  let checked = 0;
  for (const [colorType, bitDepths] of FORMATS) {
    for (const bitDepth of bitDepths) {
      for (const interlaced of [false, true]) {
        for (const [width, height] of [[13, 11], [1, 1], [9, 1], [3, 17]]) {
          const { png, sample, format } = formatCase(colorType, bitDepth, interlaced, width, height);
          const image = decodePng(png);
          const label = `type ${colorType}, ${bitDepth}-bit, ${interlaced ? "Adam7" : "plain"}, ${width}×${height}`;
          assert.equal(image.width, width, label);
          assert.equal(image.height, height, label);
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              assert.deepEqual(pixelAt(image, x, y), expectedPixel(format, sample(x, y)), `${label} at ${x},${y}`);
            }
          }
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 120);
});

test("split image data, ancillary chunks, and a missing IEND are read", () => {
  const base = { width: 6, height: 4, sample: (x, y) => [x * 40, y * 60, 90, 255], filter: (row) => row % 5 };
  const expected = decodePng(encodePng(base));
  assert.deepEqual(pixelAt(expected, 5, 3), [200, 180, 90, 255]);

  const split = decodePng(encodePng({ ...base, idatParts: 4 }));
  assert.deepEqual(split.pixels, expected.pixels);

  const withAncillary = encodePng({
    ...base,
    chunks: ({ header, data, end }) => [
      header,
      chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
      chunk("tEXt", Buffer.from("Comment\0icon")),
      ...data,
      chunk("zzZz", Buffer.from("ancillary, unknown")),
      end,
    ],
  });
  assert.deepEqual(decodePng(withAncillary).pixels, expected.pixels);

  const withoutEnd = encodePng({ ...base, chunks: ({ header, data }) => [header, ...data] });
  assert.deepEqual(decodePng(withoutEnd).pixels, expected.pixels);
});

test("malformed or unsupported PNGs are refused", () => {
  const good = encodePng({ width: 4, height: 4 });
  const header = (width, height, bitDepth, colorType, extra = [0, 0, 0]) => {
    const body = Buffer.alloc(13);
    body.writeUInt32BE(width, 0);
    body.writeUInt32BE(height, 4);
    body[8] = bitDepth;
    body[9] = colorType;
    Buffer.from(extra).copy(body, 10);
    return chunk("IHDR", body);
  };
  const withHeader = (ihdr) => encodePng({ width: 4, height: 4, chunks: ({ data, end }) => [ihdr, ...data, end] });
  const flip = (buffer, offset) => {
    const copy = Buffer.from(buffer);
    copy[offset] ^= 0x01;
    return copy;
  };
  const idatOffset = good.indexOf("IDAT") + 4;

  const cases = [
    ["not a PNG", Buffer.from("GIF89a, not a PNG at all"), /Not a PNG/],
    ["truncated chunk", good.subarray(0, good.length - 20), /truncated|incomplete|decompress/],
    ["IHDR not first", encodePng({ width: 4, height: 4, chunks: ({ header, data, end }) => [data[0], header, end] }), /start with IHDR/],
    ["two headers", encodePng({ width: 4, height: 4, chunks: ({ header, data, end }) => [header, header, ...data, end] }), /two headers/],
    ["no image data", encodePng({ width: 4, height: 4, chunks: ({ header, end }) => [header, end] }), /no image data/],
    ["zero width", withHeader(header(0, 4, 8, 6)), /dimensions/],
    ["too wide", withHeader(header(513, 4, 8, 6)), /dimensions/],
    ["RGB at 4 bits", withHeader(header(4, 4, 4, 2)), /format/],
    ["color type 5", withHeader(header(4, 4, 8, 5)), /format/],
    ["compression 1", withHeader(header(4, 4, 8, 6, [1, 0, 0])), /format/],
    ["interlace 2", withHeader(header(4, 4, 8, 6, [0, 0, 2])), /format/],
    ["short IHDR", encodePng({ width: 4, height: 4, chunks: ({ data, end }) => [chunk("IHDR", Buffer.alloc(12)), ...data, end] }), /wrong length/],
    ["bad header CRC", flip(good, 16), /wrong CRC/],
    ["bad data CRC", flip(good, idatOffset + 4), /wrong CRC/],
    ["unknown critical chunk", encodePng({ width: 4, height: 4, chunks: ({ header, data, end }) => [header, chunk("ZZZZ", Buffer.alloc(4)), ...data, end] }), /not supported/],
    ["invalid chunk type", encodePng({ width: 4, height: 4, chunks: ({ header, data, end }) => [header, chunk("a1b2", Buffer.alloc(4)), ...data, end] }), /type is invalid/],
    ["palette image without PLTE", encodePng({ width: 4, height: 4, colorType: 3, bitDepth: 8, sample: () => [0] }), /palette/],
    ["palette index out of range", encodePng({ width: 4, height: 4, colorType: 3, bitDepth: 8, sample: () => [3], palette: [[1, 2, 3]] }), /out of range/],
    ["palette of 257 entries", encodePng({ width: 4, height: 4, colorType: 3, bitDepth: 8, sample: () => [0], palette: Array.from({ length: 257 }, () => [0, 0, 0]) }), /palette/],
    ["unknown row filter", encodePng({ width: 4, height: 4, filter: () => 5 }), /filter/],
    ["data that is not zlib", encodePng({ width: 4, height: 4, chunks: ({ header, end }) => [header, chunk("IDAT", Buffer.from("not compressed")), end] }), /decompress/],
    ["incomplete data", encodePng({ width: 4, height: 4, chunks: ({ header, end }) => [header, chunk("IDAT", deflateSync(Buffer.alloc(10))), end] }), /incomplete/],
  ];
  for (const [label, png, reason] of cases) {
    assert.throws(() => decodePng(png), reason, label);
  }
});

test("a decompression bomb is refused without inflating it", () => {
  // 16×16 RGBA needs 1,040 bytes; this stream inflates to 64 MB.
  const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024));
  assert.ok(bomb.length < MAX_IMAGE_BYTES);
  const png = encodePng({ width: 16, height: 16, chunks: ({ header, end }) => [header, chunk("IDAT", bomb), end] });
  const started = process.hrtime.bigint();
  assert.throws(() => decodePng(png), /decompress/);
  assert.ok(process.hrtime.bigint() - started < 1_000_000_000n, "took longer than a second");

  // A little data after the image is ignored, as libpng does.
  const scanlines = Buffer.alloc(4 * (1 + 16));
  const padded = encodePng({ width: 4, height: 4, chunks: ({ header, end }) => [header, chunk("IDAT", deflateSync(Buffer.concat([scanlines, Buffer.alloc(100)]))), end] });
  assert.equal(decodePng(padded).width, 4);
});

test("ICO bitmaps and PNG entries decode, and the sharpest entry wins", () => {
  // 32-bit with alpha.
  const alphaBitmap = makeIcoBitmap(4, 3, { pixel: (x, y) => [x * 60, y * 80, 7, x === 0 ? 0 : 200] });
  const alphaIcon = decodeIco(makeIco([{ width: 4, height: 3, data: alphaBitmap }]));
  assert.deepEqual(pixelAt(alphaIcon, 0, 0), [0, 0, 7, 0]);
  assert.deepEqual(pixelAt(alphaIcon, 3, 2), [180, 160, 7, 200]);

  // 32-bit without alpha: the AND mask decides.
  const maskedBitmap = makeIcoBitmap(4, 4, { pixel: () => [10, 20, 30, 0], masked: (x, y) => x === y });
  const maskedIcon = decodeIco(makeIco([{ width: 4, height: 4, data: maskedBitmap }]));
  assert.deepEqual(pixelAt(maskedIcon, 2, 2), [10, 20, 30, 0]);
  assert.deepEqual(pixelAt(maskedIcon, 1, 2), [10, 20, 30, 255]);

  // 24-bit with a mask.
  const rgbBitmap = makeIcoBitmap(5, 2, { bitDepth: 24, pixel: (x) => [x * 50, 1, 2], masked: (x) => x === 4 });
  const rgbIcon = decodeIco(makeIco([{ width: 5, height: 2, data: rgbBitmap }]));
  assert.deepEqual(pixelAt(rgbIcon, 3, 1), [150, 1, 2, 255]);
  assert.deepEqual(pixelAt(rgbIcon, 4, 0), [200, 1, 2, 0]);

  // The 32×32 PNG beats the 16×16 bitmap; a larger bitmap beats a smaller PNG.
  const smallBitmap = makeIcoBitmap(16, 16, { pixel: () => [1, 1, 1, 255] });
  const mixed = makeIco([
    { width: 16, height: 16, data: smallBitmap },
    { width: 32, height: 32, data: makePng(32, 32, [9, 8, 7, 255]) },
  ]);
  const best = decodeIco(mixed);
  assert.deepEqual([best.width, pixelAt(best, 0, 0)], [32, [9, 8, 7, 255]]);
  const largeBitmap = makeIcoBitmap(48, 48, { pixel: () => [4, 5, 6, 255] });
  const preferBitmap = decodeIco(makeIco([
    { width: 16, height: 16, data: makePng(16, 16) },
    { width: 48, height: 48, data: largeBitmap },
  ]));
  assert.deepEqual([preferBitmap.width, pixelAt(preferBitmap, 0, 0)], [48, [4, 5, 6, 255]]);

  const unsupportedBitmap = Buffer.from(smallBitmap);
  unsupportedBitmap.writeUInt16LE(8, 14);
  assert.throws(() => decodeIco(makeIco([{ width: 16, height: 16, data: unsupportedBitmap }])), /no supported image/);
  const outOfFile = makeIco([{ width: 16, height: 16, data: smallBitmap }]);
  outOfFile.writeUInt32LE(outOfFile.length, 6 + 12);
  assert.throws(() => decodeIco(outOfFile), /entry is invalid/);
  assert.throws(() => decodeIco(makeIco([{ width: 16, height: 16, data: makePng(600, 16) }])), /unsupported size/);
});

test("only PNG and ICO are decoded", () => {
  assert.equal(decodeFaviconImage(makePng(2, 2)).width, 2);
  assert.equal(decodeFaviconImage(makeIco([{ width: 2, height: 2, data: makePng(2, 2) }])).width, 2);
  for (const [label, bytes] of [
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])],
    ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
    ["WebP", Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8 ", "latin1")],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["empty", Buffer.alloc(0)],
  ]) {
    assert.throws(() => decodeFaviconImage(bytes), /Not a PNG or ICO/, label);
  }
});

test("downscaling keeps the aspect ratio, never enlarges, and weights color by alpha", () => {
  const solid = (width, height, color) => ({
    width,
    height,
    pixels: Buffer.from(Array.from({ length: width * height }, () => color).flat()),
  });

  const small = solid(16, 16, [1, 2, 3, 255]);
  assert.equal(downscaleImage(small), small);
  assert.deepEqual(
    [downscaleImage(solid(512, 100, [0, 0, 0, 255])).width, downscaleImage(solid(512, 100, [0, 0, 0, 255])).height],
    [96, 19],
  );
  const tall = downscaleImage(solid(97, 300, [0, 0, 0, 255]));
  assert.deepEqual([tall.width, tall.height], [31, 96]);

  // A uniform image stays uniform, including at fractional coverage.
  const uniform = downscaleImage(solid(200, 130, [10, 20, 30, 255]));
  assert.deepEqual([uniform.width, uniform.height], [96, 62]);
  for (let offset = 0; offset < uniform.pixels.length; offset += 4) {
    assert.deepEqual([...uniform.pixels.subarray(offset, offset + 4)], [10, 20, 30, 255]);
  }

  // Averages of 2×2 blocks.
  const checker = {
    width: 2,
    height: 2,
    pixels: Buffer.from([0, 0, 0, 255, 200, 100, 40, 255, 200, 100, 40, 255, 0, 0, 0, 255]),
  };
  assert.deepEqual([...downscaleImage(checker, 1).pixels], [100, 50, 20, 255]);
  // A transparent red pixel does not tint an opaque blue one.
  const edge = { width: 2, height: 1, pixels: Buffer.from([255, 0, 0, 0, 0, 0, 255, 255]) };
  assert.deepEqual([...downscaleImage(edge, 1).pixels], [0, 0, 255, 128]);
  const clear = { width: 2, height: 1, pixels: Buffer.from([255, 0, 0, 0, 0, 255, 0, 0]) };
  assert.deepEqual([...downscaleImage(clear, 1).pixels], [0, 0, 0, 0]);
});

test("the decoder returns the source dimensions and the icon's pixels at icon size", () => {
  const prepared = prepareFaviconImage(encodePng({
    width: 300,
    height: 150,
    colorType: 2,
    bitDepth: 16,
    interlaced: true,
    sample: () => [0x1000, 0x8000, 0xffff],
  }));
  assert.deepEqual([prepared.width, prepared.height], [300, 150]);
  assert.deepEqual([prepared.icon.width, prepared.icon.height], [OUTPUT_ICON_SIZE, 48]);
  assert.deepEqual(iconSize(300, 150), { width: OUTPUT_ICON_SIZE, height: 48 });
  assert.equal(prepared.icon.pixels.length, OUTPUT_ICON_SIZE * 48 * 4);
  assert.deepEqual(pixelAt(prepared.icon, 50, 20), [16, 128, 255, 255]);

  const ico = prepareFaviconImage(makeIco([{ width: 16, height: 16, data: makeIcoBitmap(16, 16, { pixel: () => [5, 6, 7, 255] }) }]));
  assert.deepEqual([ico.width, ico.height, ico.icon.width, ico.icon.height], [16, 16, 16, 16]);

  assert.throws(() => prepareFaviconImage(Buffer.alloc(0)), /size is not supported/);
  assert.throws(() => prepareFaviconImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /size is not supported/);
});

test("the stored PNG is encoded from the pixels and stays small", () => {
  const pixels = Buffer.alloc(OUTPUT_ICON_SIZE * OUTPUT_ICON_SIZE * 4);
  for (let offset = 0; offset < pixels.length; offset += 1) pixels[offset] = (offset * 2654435761) >>> 24;
  const png = encodeRgbaPng(OUTPUT_ICON_SIZE, OUTPUT_ICON_SIZE, pixels);
  assert.ok(png.length <= MAX_OUTPUT_BYTES, `${png.length} bytes for incompressible pixels`);
  assert.deepEqual(readPngSize(png), { width: OUTPUT_ICON_SIZE, height: OUTPUT_ICON_SIZE });
  assert.deepEqual(decodePng(png).pixels, pixels);
});

test("corrupted PNG and ICO files fail cleanly", () => {
  // A fixed seed, so a failure can be reproduced.
  let seed = 0x5eed;
  const random = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  // Mutations with fixed CRCs reach the zlib and filter code, not just the
  // CRC check.
  const fixCrcs = (png) => {
    const fixed = Buffer.from(png);
    let offset = 8;
    while (offset + 12 <= fixed.length) {
      const length = fixed.readUInt32BE(offset);
      if (offset + 12 + length > fixed.length) break;
      fixed.writeUInt32BE(crc32(fixed.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
      offset += 12 + length;
    }
    return fixed;
  };
  const seeds = [
    encodePng({ width: 24, height: 20, colorType: 6, filter: (row) => row % 5, sample: (x, y) => [x * 9, y * 11, 77, 200] }),
    encodePng({ width: 17, height: 9, colorType: 3, bitDepth: 2, interlaced: true, sample: (x) => [x % 4], palette: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]], transparency: [0, 128] }),
    encodePng({ width: 9, height: 9, colorType: 0, bitDepth: 16, interlaced: true, sample: (x, y) => [x * y * 700] }),
    makeIco([
      { width: 16, height: 16, data: makeIcoBitmap(16, 16, { pixel: (x) => [x, 2, 3, 255] }) },
      { width: 32, height: 32, data: makePng(32, 32) },
    ]),
  ];
  let failures = 0;
  for (let round = 0; round < 400; round += 1) {
    const mutated = Buffer.from(seeds[round % seeds.length]);
    const edits = 1 + random(4);
    for (let edit = 0; edit < edits; edit += 1) mutated[8 + random(mutated.length - 8)] = random(256);
    const input = round % 2 === 0 ? fixCrcs(mutated) : mutated;
    try {
      const { width, height, icon } = prepareFaviconImage(input.subarray(0, input.length - random(3)));
      const expected = iconSize(width, height);
      assert.deepEqual([icon.width, icon.height, icon.pixels.length], [expected.width, expected.height, expected.width * expected.height * 4]);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.ok(error instanceof Error, `round ${round} threw ${error}`);
      failures += 1;
    }
  }
  assert.ok(failures > 100, `only ${failures} of 400 corrupted files were refused`);
});
