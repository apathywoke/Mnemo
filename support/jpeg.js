// A small baseline JPEG encoder for tests, independent of the decoder in
// src/main/favicon-jpeg.js: gray or three components (YCbCr, or RGB marked by
// an Adobe segment or by R, G, B component IDs), whole-number sampling
// factors, restart intervals, and one interleaved scan or one scan per
// component. `segments` lets a test change the segments before they are
// written.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
// The example tables of the JPEG specification (Annex K.1), row by row.
const LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMINANCE = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...Array(32).fill(99),
];
// Code counts per length from Annex K.3. The AC symbols are listed in a plain
// order (end of block, run of 16 zeros, then every run and size); with these
// counts any order is a valid code.
const DC_COUNTS = [
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
];
const AC_COUNTS = [
  [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
];
const DC_SYMBOLS = Array.from({ length: 12 }, (_, size) => size);
const AC_SYMBOLS = [0x00, 0xf0, ...Array.from({ length: 160 }, (_, index) => (Math.floor(index / 10) << 4) | ((index % 10) + 1))];
// COSINES[x * 8 + u] = cos((2x + 1)uπ/16)
const COSINES = Array.from({ length: 64 }, (_, index) => Math.cos(((2 * (index >> 3) + 1) * (index & 7) * Math.PI) / 16));

function scaleTable(table, quality) {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return table.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

function huffmanCodes(counts, symbols) {
  const codes = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let count = 0; count < counts[length - 1]; count += 1) {
      codes.set(symbols[index], { code, length });
      code += 1;
      index += 1;
    }
    code *= 2;
  }
  return codes;
}

function forwardDct(samples) {
  const coefficients = new Float64Array(64);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) sum += samples[y * 8 + x] * COSINES[x * 8 + u] * COSINES[y * 8 + v];
      }
      coefficients[v * 8 + u] = 0.25 * (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1) * sum;
    }
  }
  return coefficients;
}

function createBitWriter() {
  const bytes = [];
  let current = 0;
  let filled = 0;
  const writer = {
    bytes,
    write(value, length) {
      for (let bit = length - 1; bit >= 0; bit -= 1) {
        current = (current << 1) | ((value >> bit) & 1);
        filled += 1;
        if (filled === 8) {
          bytes.push(current);
          if (current === 0xff) bytes.push(0x00);
          current = 0;
          filled = 0;
        }
      }
    },
    // Pads the last byte with 1 bits.
    flush() {
      if (filled > 0) writer.write((1 << (8 - filled)) - 1, 8 - filled);
    },
  };
  return writer;
}

function bitLength(value) {
  let magnitude = Math.abs(value);
  let length = 0;
  while (magnitude > 0) {
    magnitude >>= 1;
    length += 1;
  }
  return length;
}

function writeValue(writer, value, size) {
  if (size > 0) writer.write(value >= 0 ? value : value + (1 << size) - 1, size);
}

function writeCode(writer, codes, symbol) {
  const { code, length } = codes.get(symbol);
  writer.write(code, length);
}

// Encodes one block of quantized values in zigzag order; returns its DC value.
function encodeBlock(writer, quantized, previousDc, dcCodes, acCodes) {
  const difference = quantized[0] - previousDc;
  const dcSize = bitLength(difference);
  writeCode(writer, dcCodes, dcSize);
  writeValue(writer, difference, dcSize);
  let run = 0;
  for (let k = 1; k < 64; k += 1) {
    if (quantized[k] === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      writeCode(writer, acCodes, 0xf0);
      run -= 16;
    }
    const size = bitLength(quantized[k]);
    writeCode(writer, acCodes, (run << 4) | size);
    writeValue(writer, quantized[k], size);
    run = 0;
  }
  if (run > 0) writeCode(writer, acCodes, 0x00);
  return quantized[0];
}

function encodeJpeg({
  width,
  height,
  sample,
  gray = false,
  sampling = [[1, 1], [1, 1], [1, 1]],
  quality = 90,
  restartInterval = 0,
  interleaved = true,
  rgb = null,
  frameMarker = 0xc0,
  segments = (list) => list,
}) {
  const count = gray ? 1 : 3;
  const factors = sampling.slice(0, count);
  const maxHorizontal = Math.max(...factors.map(([horizontal]) => horizontal));
  const maxVertical = Math.max(...factors.map(([, vertical]) => vertical));
  const mcusX = Math.ceil(width / (8 * maxHorizontal));
  const mcusY = Math.ceil(height / (8 * maxVertical));
  const fullWidth = mcusX * 8 * maxHorizontal;
  const fullHeight = mcusY * 8 * maxVertical;

  // Full-resolution planes, padded to whole MCUs by repeating the edges.
  const planes = Array.from({ length: count }, () => new Float64Array(fullWidth * fullHeight));
  for (let y = 0; y < fullHeight; y += 1) {
    for (let x = 0; x < fullWidth; x += 1) {
      const [red, green, blue] = sample(Math.min(x, width - 1), Math.min(y, height - 1));
      const index = y * fullWidth + x;
      const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
      if (gray) {
        planes[0][index] = luma;
      } else if (rgb) {
        planes[0][index] = red;
        planes[1][index] = green;
        planes[2][index] = blue;
      } else {
        planes[0][index] = luma;
        planes[1][index] = 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue;
        planes[2][index] = 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue;
      }
    }
  }

  const components = factors.map(([horizontal, vertical], index) => {
    const stepX = maxHorizontal / horizontal;
    const stepY = maxVertical / vertical;
    const planeWidth = fullWidth / stepX;
    const planeHeight = fullHeight / stepY;
    const data = new Float64Array(planeWidth * planeHeight);
    for (let y = 0; y < planeHeight; y += 1) {
      for (let x = 0; x < planeWidth; x += 1) {
        let sum = 0;
        for (let dy = 0; dy < stepY; dy += 1) {
          for (let dx = 0; dx < stepX; dx += 1) sum += planes[index][(y * stepY + dy) * fullWidth + x * stepX + dx];
        }
        data[y * planeWidth + x] = sum / (stepX * stepY);
      }
    }
    return {
      id: rgb === "ids" ? "RGB".charCodeAt(index) : index + 1,
      horizontal,
      vertical,
      table: index === 0 ? 0 : 1,
      planeWidth,
      data,
      ownBlocksX: Math.ceil(Math.ceil((width * horizontal) / maxHorizontal) / 8),
      ownBlocksY: Math.ceil(Math.ceil((height * vertical) / maxVertical) / 8),
    };
  });

  const tableCount = gray ? 1 : 2;
  const quantization = [scaleTable(LUMINANCE, quality), scaleTable(CHROMINANCE, quality)];
  const dcCodes = DC_COUNTS.map((counts) => huffmanCodes(counts, DC_SYMBOLS));
  const acCodes = AC_COUNTS.map((counts) => huffmanCodes(counts, AC_SYMBOLS));
  const quantizedBlock = (component, blockX, blockY) => {
    const samples = new Float64Array(64);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        samples[y * 8 + x] = component.data[(blockY * 8 + y) * component.planeWidth + blockX * 8 + x] - 128;
      }
    }
    const coefficients = forwardDct(samples);
    const table = quantization[component.table];
    return ZIGZAG.map((position) => Math.round(coefficients[position] / table[position]));
  };

  const encodeScan = (scan) => {
    const writer = createBitWriter();
    const single = scan.length === 1;
    const unitsX = single ? scan[0].ownBlocksX : mcusX;
    const units = single ? unitsX * scan[0].ownBlocksY : mcusX * mcusY;
    const predictors = scan.map(() => 0);
    for (let unit = 0, restarts = 0; unit < units; unit += 1) {
      if (restartInterval > 0 && unit > 0 && unit % restartInterval === 0) {
        writer.flush();
        writer.bytes.push(0xff, 0xd0 + (restarts % 8));
        restarts += 1;
        predictors.fill(0);
      }
      const unitX = unit % unitsX;
      const unitY = Math.floor(unit / unitsX);
      scan.forEach((component, index) => {
        const blocksX = single ? 1 : component.horizontal;
        const blocksY = single ? 1 : component.vertical;
        for (let row = 0; row < blocksY; row += 1) {
          for (let column = 0; column < blocksX; column += 1) {
            const quantized = quantizedBlock(component, unitX * blocksX + column, unitY * blocksY + row);
            predictors[index] = encodeBlock(writer, quantized, predictors[index], dcCodes[component.table], acCodes[component.table]);
          }
        }
      });
    }
    writer.flush();
    return Buffer.from(writer.bytes);
  };

  // A JFIF marker means YCbCr, so RGB images carry an Adobe marker or, with
  // "ids", no marker at all.
  const list = [];
  if (rgb === "adobe") {
    list.push({ marker: 0xee, body: Buffer.from([...Buffer.from("Adobe"), 0, 100, 0, 0, 0, 0, 0]) });
  } else if (!rgb) {
    list.push({ marker: 0xe0, body: Buffer.from([...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]) });
  }
  list.push({
    marker: 0xdb,
    body: Buffer.from(quantization.slice(0, tableCount).flatMap((table, id) => [id, ...ZIGZAG.map((position) => table[position])])),
  });
  list.push({
    marker: frameMarker,
    body: Buffer.from([
      8, height >> 8, height & 0xff, width >> 8, width & 0xff, count,
      ...components.flatMap(({ id, horizontal, vertical, table }) => [id, (horizontal << 4) | vertical, table]),
    ]),
  });
  const huffman = [];
  for (let id = 0; id < tableCount; id += 1) {
    huffman.push(id, ...DC_COUNTS[id], ...DC_SYMBOLS, 0x10 | id, ...AC_COUNTS[id], ...AC_SYMBOLS);
  }
  list.push({ marker: 0xc4, body: Buffer.from(huffman) });
  if (restartInterval > 0) {
    list.push({ marker: 0xdd, body: Buffer.from([restartInterval >> 8, restartInterval & 0xff]) });
  }
  for (const scan of interleaved ? [components] : components.map((component) => [component])) {
    list.push({
      marker: 0xda,
      body: Buffer.from([scan.length, ...scan.flatMap(({ id, table }) => [id, (table << 4) | table]), 0, 63, 0]),
      data: encodeScan(scan),
    });
  }

  const parts = [Buffer.from([0xff, 0xd8])];
  for (const { marker, body, data } of segments(list)) {
    parts.push(Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body);
    if (data) parts.push(data);
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

module.exports = { encodeJpeg };
