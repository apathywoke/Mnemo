const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { encodeJpeg } = require("../support/jpeg");
const { decodeJpeg } = require("../src/main/favicon-jpeg");
const { decodeFaviconImage, prepareFaviconImage } = require("../src/main/favicon-image");

// A gentle pattern: JPEG keeps it close in every sampling layout.
const gentle = (x, y) => [40 + 3 * x, 220 - 3 * y, Math.round(90 + 40 * Math.sin((x + y) / 9))];
const luma = ([red, green, blue]) => Math.round(0.299 * red + 0.587 * green + 0.114 * blue);

function differences(image, expected) {
  let total = 0;
  let max = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      assert.equal(image.pixels[offset + 3], 255);
      expected(x, y).forEach((value, channel) => {
        const difference = Math.abs(image.pixels[offset + channel] - value);
        total += difference;
        max = Math.max(max, difference);
      });
    }
  }
  return { mean: total / (image.width * image.height * 3), max };
}

// Replaces the body of the first segment with `marker` (or drops it).
const editSegment = (marker, edit) => (list) => list.flatMap((segment) => {
  if (segment.marker !== marker || segment.done) return [segment];
  const edited = edit(segment);
  if (edited) edited.done = true;
  return edited ? [edited] : [];
});

const LAYOUTS = {
  gray: { gray: true },
  "gray, 2×2 factors": { gray: true, sampling: [[2, 2]] },
  "4:4:4": {},
  "4:2:2": { sampling: [[2, 1], [1, 1], [1, 1]] },
  "4:2:0": { sampling: [[2, 2], [1, 1], [1, 1]] },
  "4:4:0": { sampling: [[1, 2], [1, 1], [1, 1]] },
  "4:1:1": { sampling: [[4, 1], [1, 1], [1, 1]] },
  "2×2, 1×2, 2×1": { sampling: [[2, 2], [1, 2], [2, 1]] },
};

test("sequential JPEGs decode close to the source in every sampling layout", () => {
  let checked = 0;
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    const fullColor = !layout.sampling || layout.gray || layout.sampling.every(([h, v]) => h === 1 && v === 1);
    for (const [width, height] of [[37, 23], [1, 1], [8, 8], [17, 1], [3, 30], [50, 50]]) {
      for (const interleaved of [true, false]) {
        for (const restartInterval of [0, 1, 5]) {
          const label = `${name}, ${width}×${height}, ${interleaved ? "interleaved" : "one scan per component"}, restart ${restartInterval}`;
          const jpeg = encodeJpeg({ width, height, sample: gentle, quality: 95, interleaved, restartInterval, ...layout });
          const image = decodeJpeg(jpeg, 512);
          assert.deepEqual([image.width, image.height], [width, height], label);
          const expected = layout.gray ? (x, y) => Array(3).fill(luma(gentle(x, y))) : gentle;
          const { mean, max } = differences(image, expected);
          assert.ok(mean <= (fullColor ? 1 : 3) && max <= (fullColor ? 5 : 12), `${label}: mean ${mean}, max ${max}`);
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 288);
});

test("RGB JPEGs are recognized as libjpeg does", () => {
  const vivid = (x, y) => [(x * 37) % 256, 255 - ((y * 23) % 256), (x * y * 7) % 256];
  const close = (jpeg, expected) => {
    const { mean, max } = differences(decodeJpeg(jpeg, 512), expected);
    return mean < 1 && max <= 6;
  };
  // An Adobe marker with transform 0, or component IDs R, G, B without any
  // marker, mean RGB.
  assert.ok(close(encodeJpeg({ width: 24, height: 16, sample: vivid, quality: 100, rgb: "adobe" }), vivid));
  assert.ok(close(encodeJpeg({ width: 24, height: 16, sample: vivid, quality: 100, rgb: "ids" }), vivid));
  // A JFIF marker means YCbCr, even next to an Adobe marker saying RGB.
  const withBoth = encodeJpeg({
    width: 24,
    height: 16,
    sample: vivid,
    quality: 100,
    segments: (list) => [{ marker: 0xee, body: Buffer.from([...Buffer.from("Adobe"), 0, 100, 0, 0, 0, 0, 0]) }, ...list],
  });
  assert.ok(close(withBoth, vivid));
});

test("JPEGs from Chromium's and macOS's encoders decode", () => {
  // Both were made from the gentle pattern at 40×24, quality 92: by Electron's
  // nativeImage.toJPEG (libjpeg-turbo, 4:2:0), and by `sips` (Apple ImageIO,
  // 4:2:0, with Exif and Photoshop segments, tables after the frame header,
  // and restart markers).
  for (const name of ["favicon-chromium.jpg", "favicon-imageio.jpg"]) {
    const image = decodeJpeg(fs.readFileSync(path.join(__dirname, "fixtures", name)), 512);
    assert.deepEqual([image.width, image.height], [40, 24], name);
    const { mean, max } = differences(image, gentle);
    assert.ok(mean <= 2.5 && max <= 12, `${name}: mean ${mean}, max ${max}`);
  }
});

test("JPEG is one of the icon formats", () => {
  const jpeg = encodeJpeg({ width: 300, height: 150, sample: () => [200, 100, 50], sampling: [[2, 2], [1, 1], [1, 1]] });
  assert.equal(decodeFaviconImage(jpeg).width, 300);
  const prepared = prepareFaviconImage(jpeg);
  assert.deepEqual([prepared.width, prepared.height, prepared.icon.width, prepared.icon.height], [300, 150, 96, 48]);
  const pixel = [...prepared.icon.pixels.subarray(0, 4)];
  assert.ok(pixel.every((value, channel) => Math.abs(value - [200, 100, 50, 255][channel]) <= 3), String(pixel));

  // A JPEG without an end marker, or with data after it, still decodes.
  const plain = encodeJpeg({ width: 16, height: 16, sample: gentle });
  assert.equal(decodeJpeg(plain.subarray(0, plain.length - 2), 512).width, 16);
  assert.equal(decodeJpeg(Buffer.concat([plain, Buffer.from("trailing")]), 512).width, 16);
});

test("JPEG types other than sequential 8-bit gray or color are refused", () => {
  const small = { width: 16, height: 16, sample: gentle };
  const frame = (edit) => encodeJpeg({ ...small, segments: editSegment(0xc0, edit) });
  const cases = [
    ["progressive", encodeJpeg({ ...small, frameMarker: 0xc2 }), /coding is not supported/],
    ["lossless", encodeJpeg({ ...small, frameMarker: 0xc3 }), /coding is not supported/],
    ["arithmetic", encodeJpeg({ ...small, frameMarker: 0xc9 }), /coding is not supported/],
    ["12-bit", frame(({ marker, body }) => ({ marker, body: Buffer.from([12, ...body.subarray(1)]) })), /precision/],
    ["four components", frame(({ marker, body }) => ({ marker, body: Buffer.from([...body.subarray(0, 5), 4, ...body.subarray(6), 4, 0x11, 1]) })), /component count/],
    ["height 0 (line count marker)", frame(({ marker, body }) => ({ marker, body: Buffer.from([8, 0, 0, ...body.subarray(3)]) })), /dimensions/],
    ["513 wide", encodeJpeg({ width: 513, height: 1, sample: gentle }), /dimensions/],
  ];
  for (const [label, jpeg, reason] of cases) {
    assert.throws(() => decodeJpeg(jpeg, 512), reason, label);
  }
  assert.equal(decodeJpeg(encodeJpeg({ width: 512, height: 2, sample: gentle }), 512).width, 512);
});

test("malformed JPEGs are refused", () => {
  const small = { width: 16, height: 16, sample: gentle, sampling: [[2, 2], [1, 1], [1, 1]] };
  const edit = (marker, change, options = {}) => encodeJpeg({ ...small, ...options, segments: editSegment(marker, change) });
  const scanData = (change, options = {}) => edit(0xda, (segment) => ({ ...segment, data: change(segment.data) }), options);
  const restartFree = (data) => {
    const bytes = [];
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] === 0xff && data[index + 1] >= 0xd0 && data[index + 1] <= 0xd7) index += 1;
      else bytes.push(data[index]);
    }
    return Buffer.from(bytes);
  };
  const cases = [
    ["not a JPEG", Buffer.from("\x89PNG\r\n\x1a\n not a JPEG", "latin1"), /Not a JPEG/],
    ["no frame header", edit(0xc0, () => null), /before the frame/],
    ["no Huffman tables", edit(0xc4, () => null), /scan component is invalid/],
    ["no quantization tables", edit(0xdb, () => null), /scan component is invalid/],
    ["quantization table 4", edit(0xdb, ({ marker, body }) => ({ marker, body: Buffer.from([4, ...body.subarray(1)]) })), /quantization table is invalid/],
    ["truncated quantization table", edit(0xdb, ({ marker, body }) => ({ marker, body: body.subarray(0, 40) })), /quantization table is invalid/],
    ["Huffman table with 400 codes", edit(0xc4, ({ marker }) => ({ marker, body: Buffer.from([0x00, ...Array(14).fill(0), 200, 200, ...Array(400).fill(0)]) })), /Huffman table is invalid/],
    ["Huffman codes that do not fit", edit(0xc4, ({ marker }) => ({ marker, body: Buffer.from([0x00, 3, ...Array(15).fill(0), 0, 1, 2]) })), /Huffman table is invalid/],
    ["spectral selection", edit(0xda, (segment) => ({ ...segment, body: Buffer.from([...segment.body.subarray(0, -3), 1, 63, 0]) })), /not sequential/],
    ["successive approximation", edit(0xda, (segment) => ({ ...segment, body: Buffer.from([...segment.body.subarray(0, -1), 0x10]) })), /not sequential/],
    ["unknown scan component", edit(0xda, (segment) => ({ ...segment, body: Buffer.from([segment.body[0], 9, ...segment.body.subarray(2)]) })), /scan component is invalid/],
    ["two frame headers", edit(0xc0, (segment) => ({ marker: 0xc0, body: segment.body, data: Buffer.from([0xff, 0xc0, 0, 2 + segment.body.length, ...segment.body]) })), /two frames/],
    ["a component scanned twice", encodeJpeg({ ...small, interleaved: false, segments: (list) => [...list, list.at(-1)] }), /scan component is invalid/],
    ["a component never scanned", encodeJpeg({ ...small, interleaved: false, segments: (list) => list.slice(0, -1) }), /incomplete/],
    ["too many blocks per MCU", encodeJpeg({ ...small, sampling: [[4, 4], [1, 1], [1, 1]] }), /too many blocks/],
    ["sampling factor 0", edit(0xc0, ({ marker, body }) => ({ marker, body: Buffer.from([...body.subarray(0, 7), 0x02, ...body.subarray(8)]) })), /component is invalid/],
    ["sampling factor 5", edit(0xc0, ({ marker, body }) => ({ marker, body: Buffer.from([...body.subarray(0, 7), 0x51, ...body.subarray(8)]) })), /component is invalid/],
    ["truncated data", scanData((data) => data.subarray(0, data.length >> 1)), /ends early/],
    ["a marker inside the data", scanData((data) => Buffer.concat([data.subarray(0, 8), Buffer.from([0xff, 0xc4]), data.subarray(8)])), /ends early|invalid Huffman|too many values/],
    ["missing restart markers", scanData(restartFree, { restartInterval: 1, width: 48 }), /restart marker is missing/],
    ["DC size 12", edit(0xc4, ({ marker, body }) => {
      const changed = Buffer.from(body);
      changed[17] = 12;
      return { marker, body: changed };
    }, { sample: () => [128, 128, 128] }), /DC value is invalid/],
    ["segment longer than the file", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00, 1, 2, 3]), /truncated/],
    ["bytes where a marker belongs", Buffer.from([0xff, 0xd8, 0x12, 0x34]), /marker is missing/],
  ];
  for (const [label, jpeg, reason] of cases) {
    assert.throws(() => decodeJpeg(jpeg, 512), reason, label);
  }
});

test("corrupted JPEGs fail cleanly and quickly", () => {
  let seed = 0x1ec;
  const random = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  const seeds = [
    encodeJpeg({ width: 33, height: 20, sample: gentle, sampling: [[2, 2], [1, 1], [1, 1]], restartInterval: 2 }),
    encodeJpeg({ width: 20, height: 33, sample: gentle, gray: true, interleaved: false }),
    encodeJpeg({ width: 24, height: 24, sample: gentle, rgb: "adobe", interleaved: false, restartInterval: 3 }),
    fs.readFileSync(path.join(__dirname, "fixtures", "favicon-imageio.jpg")),
  ];
  const started = Date.now();
  let refused = 0;
  for (let round = 0; round < 400; round += 1) {
    const mutated = Buffer.from(seeds[round % seeds.length]);
    const edits = 1 + random(4);
    for (let edit = 0; edit < edits; edit += 1) mutated[2 + random(mutated.length - 2)] = random(256);
    try {
      const image = decodeJpeg(mutated.subarray(0, mutated.length - random(40)), 512);
      assert.equal(image.pixels.length, image.width * image.height * 4);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.ok(error instanceof Error, `round ${round} threw ${error}`);
      refused += 1;
    }
  }
  assert.ok(refused > 50, `only ${refused} of 400 corrupted files were refused`);
  assert.ok(Date.now() - started < 10_000);
});

test("a 512×512 JPEG with every coefficient set decodes in reasonable time", () => {
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  const pixels = Array.from({ length: 512 * 512 }, () => [noise(), noise(), noise()]);
  const jpeg = encodeJpeg({ width: 512, height: 512, sample: (x, y) => pixels[y * 512 + x], quality: 100 });
  const started = Date.now();
  const image = decodeJpeg(jpeg, 512);
  assert.equal(image.width, 512);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});
