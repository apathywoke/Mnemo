// JPEG decoding for site icons, in plain JavaScript, in the favicon decoder
// process (see favicon-image.js). Supported: baseline and extended sequential
// Huffman-coded JPEG with 8-bit samples, gray or three components (YCbCr, or
// RGB), any sampling factors, restart intervals, and one scan per component
// or one interleaved scan. Progressive, arithmetic-coded, lossless, 12-bit,
// and four-component (CMYK) images are refused.

// Position in the 8×8 block of the k-th coefficient in zigzag order.
const ZIGZAG = Object.freeze([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);
// IDCT_BASIS[x * 8 + u] = C(u) · cos((2x + 1)uπ/16) / 2, with C(0) = 1/√2;
// one pass per dimension gives the 1/4 of the inverse DCT.
const IDCT_BASIS = (() => {
  const basis = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) {
      basis[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
    }
  }
  return basis;
})();
// SOF0 baseline and SOF1 extended sequential, both Huffman-coded.
const SEQUENTIAL_FRAMES = new Set([0xc0, 0xc1]);
// Progressive, lossless, hierarchical, and arithmetic-coded frames.
const UNSUPPORTED_FRAMES = new Set([0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// An interleaved scan may hold at most 10 blocks per MCU.
const MAX_BLOCKS_PER_MCU = 10;

// The reason stays in the decoder process, as in favicon-image.js.
function invalidImage(reason) {
  return new Error(reason);
}

function readQuantizationTables(segment, tables) {
  let position = 0;
  while (position < segment.length) {
    const precision = segment[position] >> 4;
    const id = segment[position] & 15;
    const size = precision === 1 ? 128 : 64;
    if (precision > 1 || id > 3 || position + 1 + size > segment.length) {
      throw invalidImage("JPEG quantization table is invalid");
    }
    const table = new Uint16Array(64);
    for (let k = 0; k < 64; k += 1) {
      table[ZIGZAG[k]] = precision === 1
        ? segment.readUInt16BE(position + 1 + k * 2)
        : segment[position + 1 + k];
    }
    tables[id] = table;
    position += 1 + size;
  }
}

// Canonical Huffman codes from the code counts per length (1–16 bits), as in
// the JPEG specification (Annex C and F.2.2.3).
function buildHuffmanTable(counts, symbols) {
  const maxCode = new Int32Array(17).fill(-1);
  const valueOffset = new Int32Array(17);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = counts[length - 1];
    valueOffset[length] = index - code;
    code += count;
    index += count;
    if (count > 0) maxCode[length] = code - 1;
    if (code > 2 ** length) throw invalidImage("JPEG Huffman table is invalid");
    code *= 2;
  }
  return { maxCode, valueOffset, symbols };
}

function readHuffmanTables(segment, dcTables, acTables) {
  let position = 0;
  while (position < segment.length) {
    const tableClass = segment[position] >> 4;
    const id = segment[position] & 15;
    if (tableClass > 1 || id > 3 || position + 17 > segment.length) {
      throw invalidImage("JPEG Huffman table is invalid");
    }
    const counts = segment.subarray(position + 1, position + 17);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total > 256 || position + 17 + total > segment.length) {
      throw invalidImage("JPEG Huffman table is invalid");
    }
    const symbols = Uint8Array.from(segment.subarray(position + 17, position + 17 + total));
    (tableClass === 0 ? dcTables : acTables)[id] = buildHuffmanTable(counts, symbols);
    position += 17 + total;
  }
}

function readFrame(segment, maxDimension) {
  if (segment.length < 6) throw invalidImage("JPEG frame header is invalid");
  const precision = segment[0];
  const height = segment.readUInt16BE(1);
  const width = segment.readUInt16BE(3);
  const count = segment[5];
  if (precision !== 8) throw invalidImage("JPEG sample precision is not supported");
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) {
    throw invalidImage("JPEG dimensions are not supported");
  }
  if ((count !== 1 && count !== 3) || segment.length !== 6 + count * 3) {
    throw invalidImage("JPEG component count is not supported");
  }

  const components = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 3;
    const component = {
      id: segment[offset],
      horizontal: segment[offset + 1] >> 4,
      vertical: segment[offset + 1] & 15,
      quantization: segment[offset + 2],
    };
    if (
      component.horizontal < 1 || component.horizontal > 4 ||
      component.vertical < 1 || component.vertical > 4 ||
      component.quantization > 3 ||
      components.some(({ id }) => id === component.id)
    ) {
      throw invalidImage("JPEG component is invalid");
    }
    components.push(component);
  }

  const maxHorizontal = Math.max(...components.map(({ horizontal }) => horizontal));
  const maxVertical = Math.max(...components.map(({ vertical }) => vertical));
  const mcusPerLine = Math.ceil(width / (8 * maxHorizontal));
  const mcusPerColumn = Math.ceil(height / (8 * maxVertical));
  for (const component of components) {
    // Interleaved scans fill whole MCUs; a scan of one component covers only
    // the blocks inside its own (subsampled) size.
    component.planeWidth = mcusPerLine * component.horizontal * 8;
    component.plane = new Uint8Array(component.planeWidth * mcusPerColumn * component.vertical * 8);
    component.ownBlocksPerLine = Math.ceil(Math.ceil((width * component.horizontal) / maxHorizontal) / 8);
    component.ownBlocksPerColumn = Math.ceil(Math.ceil((height * component.vertical) / maxVertical) / 8);
  }
  return { width, height, components, maxHorizontal, maxVertical, mcusPerLine, mcusPerColumn };
}

function readScan(segment, frame, tables, decoded) {
  const count = segment[0];
  if (count < 1 || count > 4 || segment.length !== 4 + count * 2) {
    throw invalidImage("JPEG scan header is invalid");
  }
  const scan = [];
  for (let index = 0; index < count; index += 1) {
    const component = frame.components.find(({ id }) => id === segment[1 + index * 2]);
    const dcTable = tables.dc[segment[2 + index * 2] >> 4];
    const acTable = tables.ac[segment[2 + index * 2] & 15];
    const quantization = component && tables.quantization[component.quantization];
    if (
      !component || !dcTable || !acTable || !quantization ||
      decoded.has(component) || scan.some((entry) => entry.component === component)
    ) {
      throw invalidImage("JPEG scan component is invalid");
    }
    scan.push({ component, dcTable, acTable, quantization, predictor: 0 });
  }
  const [spectralStart, spectralEnd, approximation] = segment.subarray(1 + count * 2);
  if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) {
    throw invalidImage("JPEG scan is not sequential");
  }
  const blocksPerMcu = scan.reduce((sum, { component }) => sum + component.horizontal * component.vertical, 0);
  if (count > 1 && blocksPerMcu > MAX_BLOCKS_PER_MCU) {
    throw invalidImage("JPEG scan has too many blocks per MCU");
  }
  for (const { component } of scan) decoded.add(component);
  return scan;
}

// Reads entropy-coded data bit by bit. A 0xFF byte is followed by a stuffed
// 0x00; any other byte after it is a marker, which means the data ended too
// early.
function createBitReader(data, start) {
  let offset = start;
  let byte = 0;
  let bitsLeft = 0;
  const reader = {
    bit() {
      if (bitsLeft === 0) {
        if (offset >= data.length) throw invalidImage("JPEG data ends early");
        byte = data[offset];
        if (byte === 0xff) {
          if (data[offset + 1] !== 0x00) throw invalidImage("JPEG data ends early");
          offset += 2;
        } else {
          offset += 1;
        }
        bitsLeft = 8;
      }
      bitsLeft -= 1;
      return (byte >> bitsLeft) & 1;
    },
    bits(count) {
      let value = 0;
      for (let index = 0; index < count; index += 1) value = (value << 1) | reader.bit();
      return value;
    },
    // Skips the padding bits and the RSTn marker that end a restart interval.
    restart() {
      bitsLeft = 0;
      while (data[offset] === 0xff && data[offset + 1] === 0xff) offset += 1;
      const marker = data[offset + 1];
      if (data[offset] !== 0xff || !(marker >= 0xd0 && marker <= 0xd7)) {
        throw invalidImage("JPEG restart marker is missing");
      }
      offset += 2;
    },
    get offset() {
      return offset;
    },
  };
  return reader;
}

function decodeHuffman(reader, table) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | reader.bit();
    if (code <= table.maxCode[length]) return table.symbols[code + table.valueOffset[length]];
  }
  throw invalidImage("JPEG data has an invalid Huffman code");
}

// A value of `size` bits; values below 2^(size−1) are negative (F.2.2.1).
function receiveExtend(reader, size) {
  if (size === 0) return 0;
  const value = reader.bits(size);
  return value < 2 ** (size - 1) ? value - 2 ** size + 1 : value;
}

function decodeBlock(reader, entry, coefficients) {
  const dcSize = decodeHuffman(reader, entry.dcTable);
  if (dcSize > 11) throw invalidImage("JPEG DC value is invalid");
  entry.predictor += receiveExtend(reader, dcSize);
  coefficients[0] = entry.predictor;
  for (let k = 1; k < 64;) {
    const symbol = decodeHuffman(reader, entry.acTable);
    const run = symbol >> 4;
    const size = symbol & 15;
    if (size === 0) {
      // End of block, or a run of 16 zeros.
      if (run !== 15) break;
      k += 16;
      continue;
    }
    k += run;
    if (k > 63) throw invalidImage("JPEG block has too many values");
    coefficients[ZIGZAG[k]] = receiveExtend(reader, size);
    k += 1;
  }
}

// Dequantizes and inverse-transforms one block into the component's plane.
function writeBlock(coefficients, quantization, component, blockX, blockY, workspace) {
  for (let v = 0; v < 8; v += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) {
        const coefficient = coefficients[v * 8 + u];
        if (coefficient !== 0) sum += IDCT_BASIS[x * 8 + u] * coefficient * quantization[v * 8 + u];
      }
      workspace[v * 8 + x] = sum;
    }
  }
  const { plane, planeWidth } = component;
  const origin = blockY * 8 * planeWidth + blockX * 8;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) sum += IDCT_BASIS[y * 8 + v] * workspace[v * 8 + x];
      const sample = Math.round(sum + 128);
      plane[origin + y * planeWidth + x] = sample < 0 ? 0 : sample > 255 ? 255 : sample;
    }
  }
}

// Decodes one scan starting at `start`; returns where its data stopped.
function decodeScan(data, start, frame, scan, restartInterval) {
  const reader = createBitReader(data, start);
  const coefficients = new Int32Array(64);
  const workspace = new Float64Array(64);
  const single = scan.length === 1;
  const unitsPerLine = single ? scan[0].component.ownBlocksPerLine : frame.mcusPerLine;
  const units = single
    ? scan[0].component.ownBlocksPerLine * scan[0].component.ownBlocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  const decodeInto = (entry, blockX, blockY) => {
    coefficients.fill(0);
    decodeBlock(reader, entry, coefficients);
    writeBlock(coefficients, entry.quantization, entry.component, blockX, blockY, workspace);
  };

  for (let unit = 0; unit < units; unit += 1) {
    if (restartInterval > 0 && unit > 0 && unit % restartInterval === 0) {
      reader.restart();
      for (const entry of scan) entry.predictor = 0;
    }
    const unitX = unit % unitsPerLine;
    const unitY = Math.floor(unit / unitsPerLine);
    if (single) {
      decodeInto(scan[0], unitX, unitY);
      continue;
    }
    for (const entry of scan) {
      const { horizontal, vertical } = entry.component;
      for (let row = 0; row < vertical; row += 1) {
        for (let column = 0; column < horizontal; column += 1) {
          decodeInto(entry, unitX * horizontal + column, unitY * vertical + row);
        }
      }
    }
  }
  return reader.offset;
}

// Entropy-coded data ends at the first 0xFF that is not followed by a
// stuffed 0x00, a fill byte, or a restart marker.
function nextMarker(data, offset) {
  for (let position = offset; position < data.length - 1; position += 1) {
    if (data[position] !== 0xff) continue;
    const next = data[position + 1];
    if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) return position;
  }
  return data.length;
}

function clampSample(value) {
  const sample = Math.round(value);
  return sample < 0 ? 0 : sample > 255 ? 255 : sample;
}

// Combines the component planes into RGBA, repeating subsampled samples.
// Three components are RGB or YCbCr as libjpeg decides: a JFIF marker means
// YCbCr; otherwise an Adobe marker's transform says which; otherwise
// component IDs R, G, B mean RGB.
function toRgba(frame, { jfif, adobeTransform }) {
  const { width, height, components, maxHorizontal, maxVertical } = frame;
  const [first, second, third] = components;
  const isRgb = components.length === 3 && !jfif && (
    adobeTransform === 0 ||
    (adobeTransform === null && first.id === 0x52 && second.id === 0x47 && third.id === 0x42)
  );
  const sampleAt = (component, x, y) => component.plane[
    Math.floor((y * component.vertical) / maxVertical) * component.planeWidth +
    Math.floor((x * component.horizontal) / maxHorizontal)
  ];
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luma = sampleAt(first, x, y);
      if (components.length === 1) {
        pixels[offset] = luma;
        pixels[offset + 1] = luma;
        pixels[offset + 2] = luma;
      } else if (isRgb) {
        pixels[offset] = luma;
        pixels[offset + 1] = sampleAt(second, x, y);
        pixels[offset + 2] = sampleAt(third, x, y);
      } else {
        const blue = sampleAt(second, x, y) - 128;
        const red = sampleAt(third, x, y) - 128;
        pixels[offset] = clampSample(luma + 1.402 * red);
        pixels[offset + 1] = clampSample(luma - 0.344136 * blue - 0.714136 * red);
        pixels[offset + 2] = clampSample(luma + 1.772 * blue);
      }
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

// Decodes a JPEG whose sides are at most `maxDimension` into 8-bit RGBA.
function decodeJpeg(buffer, maxDimension) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw invalidImage("Not a JPEG image");
  }
  const tables = { quantization: [], dc: [], ac: [] };
  const decoded = new Set();
  let frame = null;
  let restartInterval = 0;
  let jfif = false;
  let adobeTransform = null;
  let offset = 2;
  try {
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) throw invalidImage("JPEG marker is missing");
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        // A fill byte before the marker.
        offset += 1;
        continue;
      }
      offset += 2;
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === undefined || marker === 0xd8 || offset + 2 > buffer.length) {
        throw invalidImage("JPEG marker is invalid");
      }
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) throw invalidImage("JPEG segment is truncated");
      const segment = buffer.subarray(offset + 2, offset + length);
      offset += length;

      if (marker === 0xdb) {
        readQuantizationTables(segment, tables.quantization);
      } else if (marker === 0xc4) {
        readHuffmanTables(segment, tables.dc, tables.ac);
      } else if (marker === 0xdd) {
        if (segment.length !== 2) throw invalidImage("JPEG restart interval is invalid");
        restartInterval = segment.readUInt16BE(0);
      } else if (SEQUENTIAL_FRAMES.has(marker)) {
        if (frame) throw invalidImage("JPEG has two frames");
        frame = readFrame(segment, maxDimension);
      } else if (UNSUPPORTED_FRAMES.has(marker)) {
        throw invalidImage("JPEG coding is not supported");
      } else if (marker === 0xda) {
        if (!frame) throw invalidImage("JPEG scan comes before the frame");
        const scan = readScan(segment, frame, tables, decoded);
        offset = nextMarker(buffer, decodeScan(buffer, offset, frame, scan, restartInterval));
      } else if (marker === 0xdc) {
        throw invalidImage("JPEG line count marker is not supported");
      } else if (marker === 0xe0 && segment.toString("latin1", 0, 5) === "JFIF\0") {
        jfif = true;
      } else if (marker === 0xee && segment.length >= 12 && segment.toString("latin1", 0, 5) === "Adobe") {
        adobeTransform = segment[11];
      }
      // APPn, COM, and other segments are skipped.
    }
    if (!frame || decoded.size !== frame.components.length) {
      throw invalidImage("JPEG image data is incomplete");
    }
    return toRgba(frame, { jfif, adobeTransform });
  } finally {
    for (const component of frame?.components ?? []) component.plane.fill(0);
  }
}

module.exports = { decodeJpeg };
