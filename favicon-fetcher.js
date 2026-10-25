const dns = require("node:dns/promises");
const https = require("node:https");
const { isIP } = require("node:net");
const { deflateSync } = require("node:zlib");
const { nativeImage } = require("electron");

const MAX_DOWNLOAD_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_ICONS = 5;
const MAX_ICON_DIMENSION = 512;
const OUTPUT_ICON_SIZE = 96;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function validatePngDimensions(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("The website did not provide a supported PNG or ICO favicon.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!isWithinIconBounds(width, height)) {
    throw new Error("The website's favicon dimensions are not supported.");
  }
}

function validateIcoDimensions(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("The website did not provide a supported PNG or ICO favicon.");
  }

  const imageCount = buffer.readUInt16LE(4);
  const directoryEnd = 6 + imageCount * 16;
  if (imageCount < 1 || imageCount > 64 || directoryEnd > buffer.length) {
    throw new Error("The website did not provide a supported ICO favicon.");
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
      throw new Error("The website did not provide a supported ICO favicon.");
    }

    const image = buffer.subarray(imageOffset, imageEnd);
    if (image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      validatePngDimensions(image);
      const width = image.readUInt32BE(16);
      const height = image.readUInt32BE(20);
      const quality = Math.min(width, height);
      const area = width * height;
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
    return bestPng;
  }
  if (bestDib) return decodeIcoDibToPng(bestDib);
  return bestPng;
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

function decodeIcoDibToPng(icon) {
  const { image, width, height, headerSize, bitDepth, xorStride, maskStride, xorBytes } = icon;
  const maskOffset = headerSize + xorBytes;
  const hasMask = maskOffset + maskStride * height <= image.length;
  const pixels = Buffer.alloc(width * height * 4);
  let alphaIsEmpty = bitDepth === 32;

  for (let y = 0; y < height; y += 1) {
    const sourceRow = height - 1 - y;
    const sourceOffset = headerSize + sourceRow * xorStride;
    const maskRowOffset = maskOffset + sourceRow * maskStride;
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

  const png = encodeRgbaPng(width, height, pixels);
  pixels.fill(0);
  return png;
}

function validateJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("The website did not provide a supported PNG, JPEG, or ICO favicon.");
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new Error("The website's JPEG favicon is malformed.");
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) {
      throw new Error("The website's JPEG favicon is incomplete.");
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new Error("The website's JPEG favicon is malformed.");
    }
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) throw new Error("The website's JPEG favicon is malformed.");
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!isWithinIconBounds(width, height)) {
        throw new Error("The website's favicon dimensions are not supported.");
      }
      return;
    }
    offset += segmentLength;
  }
  throw new Error("The website's JPEG favicon did not declare image dimensions.");
}

function extractSupportedImage(buffer) {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    validatePngDimensions(buffer);
    return buffer;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    validateJpegDimensions(buffer);
    return buffer;
  }
  const pngFromIco = validateIcoDimensions(buffer);
  if (pngFromIco) return pngFromIco;
  throw new Error("This ICO contains no supported PNG or 24/32-bit uncompressed icon image.");
}

function unsupportedFavicon(message) {
  const error = new Error(message);
  error.unsupportedFavicon = true;
  return error;
}

function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second, third] = address.split(".").map(Number);

  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function getFaviconHost(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Enter a valid HTTPS website to load its icon.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTPS website to load its icon.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".example")
  ) {
    throw new Error("Site icons can only be loaded from a public HTTPS domain.");
  }

  return hostname;
}

async function resolvePublicIPv4(hostname) {
  let addresses;
  let lookupError = null;
  try {
    addresses = await dns.lookup(hostname, {
      all: true,
      family: 4,
    });
  } catch (error) {
    lookupError = error;
  }

  if (!addresses?.length) {
    try {
      // `lookup` uses the operating system resolver. If it fails, try an A-record
      // query through the same configured DNS servers before reporting failure.
      addresses = (await dns.resolve4(hostname)).map((address) => ({ address }));
    } catch (resolveError) {
      const code = resolveError?.code ?? lookupError?.code;
      if (code === "ETIMEOUT" || code === "EAI_AGAIN") {
        throw new Error(`DNS lookup for ${hostname} temporarily failed. Check your connection or DNS settings and try again.`);
      }
      if (code === "ENODATA") {
        throw new Error(`${hostname} has no IPv4 address (DNS A record).`);
      }
      if (code === "ENOTFOUND") {
        throw new Error(`DNS could not find ${hostname}. Check the website address, connection, and DNS settings.`);
      }
      throw new Error(`Could not resolve ${hostname}${code ? ` (${code})` : ""}. Check your connection or DNS settings.`);
    }
  }

  const publicAddress = addresses.find((record) => isPublicIPv4(record.address));
  if (!publicAddress) {
    throw new Error("This website does not resolve to a public IPv4 address.");
  }
  return publicAddress.address;
}

function downloadResourceOnce(hostname, address, requestPath, accept, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = https.get(
      {
        hostname,
        servername: hostname,
        port: 443,
        family: 4,
        autoSelectFamily: false,
        path: requestPath,
        headers: {
          accept,
          "user-agent": "LocalVault/0.1 favicon fetch",
        },
        agent: false,
        lookup: (_host, options, callback) => {
          // Newer Node versions may request all addresses for family selection.
          // Return the callback shape it expects while keeping the pinned IP.
          if (options?.all) {
            callback(null, [{ address, family: 4 }]);
          } else {
            callback(null, address, 4);
          }
        },
      },
      (response) => {
        const contentType = String(response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        response.on("error", (error) => fail(makeNetworkError(hostname, error)));
        response.on("aborted", () => fail(new Error("The download was interrupted.")));

        if (response.statusCode !== 200) {
          finish({
            statusCode: response.statusCode,
            contentType,
            location: response.headers.location ?? null,
            data: null,
            hostname,
            address,
          });
          response.destroy();
          return;
        }

        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          fail(new Error("The website response is too large."));
          response.destroy();
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            fail(new Error("The website response is too large."));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.complete) {
            finish({
              statusCode: response.statusCode,
              contentType,
              data: Buffer.concat(chunks, totalBytes),
              hostname,
              address,
            });
          } else {
            fail(new Error("The website response was incomplete."));
          }
        });
      },
    );

    request.setTimeout(7000, () => {
      const error = new Error("Favicon request timed out");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", (error) => fail(makeNetworkError(hostname, error)));
  });
}

async function downloadResource(
  hostname,
  address,
  requestPath,
  accept,
  maxBytes,
  redirectCount = 0,
) {
  const response = await downloadResourceOnce(
    hostname,
    address,
    requestPath,
    accept,
    maxBytes,
  );
  if (![301, 302, 303, 307, 308].includes(response.statusCode) || !response.location) {
    return response;
  }
  if (redirectCount >= 3) {
    throw new Error("The website redirected too many times.");
  }

  let target;
  try {
    target = new URL(response.location, `https://${hostname}${requestPath}`);
  } catch {
    throw new Error("The website returned an invalid redirect address.");
  }
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    isIP(target.hostname) !== 0
  ) {
    throw new Error("The website redirected to an address that is not allowed.");
  }

  let targetHostname;
  try {
    targetHostname = getFaviconHost(target.href);
  } catch {
    throw new Error("The website redirected to an address that is not allowed.");
  }
  const isSameSiteAlias =
    targetHostname === hostname ||
    targetHostname === `www.${hostname}` ||
    hostname === `www.${targetHostname}`;
  if (!isSameSiteAlias) {
    throw new Error("The website redirected to a different domain, so the request was blocked.");
  }

  const targetAddress = targetHostname === hostname
    ? address
    : await resolvePublicIPv4(targetHostname);
  return downloadResource(
    targetHostname,
    targetAddress,
    `${target.pathname}${target.search}`,
    accept,
    maxBytes,
    redirectCount + 1,
  );
}

async function downloadFavicon(hostname, address, requestPath = "/favicon.ico") {
  const response = await downloadResource(
    hostname,
    address,
    requestPath,
    "image/png,image/x-icon,image/vnd.microsoft.icon,image/webp,image/jpeg,image/gif;q=0.8",
    MAX_DOWNLOAD_BYTES,
  );
  if (
    response.statusCode !== 200 ||
    response.contentType === "image/svg+xml" ||
    response.contentType === "text/html"
  ) {
    response.data?.fill(0);
    throw unsupportedFavicon("The site did not provide a supported PNG, JPEG, or ICO icon at this address.");
  }
  return {
    data: response.data,
    hostname: response.hostname,
    address: response.address,
  };
}

function readHtmlAttributes(tag) {
  const attributes = new Map();
  const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attributePattern.exec(tag)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(match[1].toLowerCase(), value);
  }
  return attributes;
}

function getDeclaredIconSize(attributes, rel) {
  const sizes = attributes.get("sizes") ?? "";
  const dimensions = [...sizes.matchAll(/(?:^|\s)(\d{1,4})x(\d{1,4})(?=\s|$)/gi)]
    .map((match) => Math.min(Number(match[1]), Number(match[2])))
    .filter((size) => size > 0 && size <= MAX_ICON_DIMENSION);
  if (dimensions.length > 0) return Math.max(...dimensions);
  if (rel.some((part) => part.startsWith("apple-touch-icon"))) return 180;
  return 32;
}

function discoverIconPaths(html, hostname) {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);

  const head = (headMatch?.[1] ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const discovered = [];
  const seen = new Map();
  const linkPattern = /<link\b[^>]*>/gi;
  let match;

  while ((match = linkPattern.exec(head)) !== null) {
    const attributes = readHtmlAttributes(match[0]);
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const isIcon = rel.includes("icon") || rel.some((part) => part.startsWith("apple-touch-icon"));
    const href = attributes.get("href")
      ?.replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
    if (!isIcon || !href) continue;

    let candidate;
    try {
      candidate = new URL(href, `https://${hostname}/`);
    } catch {
      continue;
    }

    if (
      candidate.protocol !== "https:" ||
      candidate.hostname.toLowerCase() !== hostname ||
      candidate.port ||
      candidate.username ||
      candidate.password ||
      candidate.pathname.toLowerCase().endsWith(".svg")
    ) {
      continue;
    }

    const path = `${candidate.pathname}${candidate.search}`;
    const declaredSize = getDeclaredIconSize(attributes, rel);
    const previous = seen.get(path);
    if (!previous || declaredSize > previous.declaredSize) {
      const icon = { path, declaredSize };
      if (previous) {
        discovered[previous.index] = icon;
        seen.set(path, { declaredSize, index: previous.index });
      } else {
        seen.set(path, { declaredSize, index: discovered.length });
        discovered.push(icon);
      }
    }
  }

  for (const [path, declaredSize] of [
    ["/apple-touch-icon.png", 180],
    ["/apple-touch-icon-precomposed.png", 180],
    ["/favicon.png", 64],
  ]) {
    if (!seen.has(path)) {
      seen.set(path, { declaredSize, index: discovered.length });
      discovered.push({ path, declaredSize });
    }
  }

  return discovered
    .sort((left, right) => right.declaredSize - left.declaredSize)
    .slice(0, MAX_DISCOVERED_ICONS)
    .map((icon) => icon.path);
}

function isHigherQualityIcon(candidate, current) {
  if (!current) return true;
  if (candidate.quality !== current.quality) return candidate.quality > current.quality;
  return candidate.area > current.area;
}

async function discoverFavicon(hostname, address, bestIcon = null) {
  const page = await downloadResource(
    hostname,
    address,
    "/",
    "text/html,application/xhtml+xml;q=0.9",
    MAX_PAGE_BYTES,
  );
  if (page.statusCode !== 200) {
    throw new Error(`The site has no usable /favicon.ico or homepage (HTTP ${page.statusCode}).`);
  }
  if (!page.contentType.includes("html") && page.contentType !== "application/xhtml+xml") {
    page.data?.fill(0);
    throw new Error("The site has no /favicon.ico and its homepage did not provide HTML.");
  }

  const paths = discoverIconPaths(page.data.toString("utf8"), page.hostname);
  page.data.fill(0);
  if (paths.length === 0) {
    throw new Error("No same-domain PNG or ICO icon link was found on the homepage.");
  }

  for (const path of paths) {
    try {
      const downloaded = await downloadFavicon(page.hostname, page.address, path);
      const converted = convertFavicon(downloaded.data);
      const candidate = { ...converted, hostname: downloaded.hostname };
      if (isHigherQualityIcon(candidate, bestIcon)) bestIcon = candidate;
    } catch (error) {
      if (error?.unsupportedFavicon) continue;
      throw error;
    }
  }

  if (bestIcon) return bestIcon;

  throw new Error(
    "No supported PNG, JPEG, or ICO icon was found. This site may only provide SVG or an unsupported ICO format.",
  );
}

function convertFavicon(downloaded) {
  let imageBuffer;
  try {
    // Check dimensions before decoding to prevent oversized image allocations.
    try {
      imageBuffer = extractSupportedImage(downloaded);
    } catch (error) {
      throw unsupportedFavicon(error.message);
    }
    let image;
    try {
      image = nativeImage.createFromBuffer(imageBuffer);
    } catch {
      throw unsupportedFavicon("The website's favicon image could not be decoded.");
    }
    if (image.isEmpty()) {
      throw unsupportedFavicon("The website did not provide a supported image icon.");
    }

    const { width, height } = image.getSize();
    if (
      width < 1 ||
      height < 1 ||
      width > MAX_ICON_DIMENSION ||
      height > MAX_ICON_DIMENSION
    ) {
      throw unsupportedFavicon("The website's favicon dimensions are not supported.");
    }

    const scale = Math.min(
      1,
      OUTPUT_ICON_SIZE / width,
      OUTPUT_ICON_SIZE / height,
    );
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    const resizeOptions = {
      quality: "best",
      ...(width >= height
        ? { width: outputWidth }
        : { height: outputHeight }),
    };
    const png = image.resize(resizeOptions).toPNG();
    if (png.length > MAX_OUTPUT_BYTES) {
      throw unsupportedFavicon("The processed favicon is too large.");
    }

    const encoded = png.toString("base64");
    png.fill(0);
    return {
      dataUrl: `data:image/png;base64,${encoded}`,
      width,
      height,
      quality: Math.min(width, height),
      area: width * height,
    };
  } finally {
    if (imageBuffer && imageBuffer !== downloaded) imageBuffer.fill(0);
    downloaded.fill(0);
  }
}

function makeNetworkError(hostname, error) {
  const codes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const code = codes.has(error?.code) ? error.code : null;

  if (code === "ETIMEDOUT") {
    return new Error(`The connection to ${hostname} timed out.`);
  }
  if (code === "CERT_HAS_EXPIRED" || code?.startsWith("ERR_TLS_") || code?.includes("CERT")) {
    return new Error(`The HTTPS certificate for ${hostname} could not be verified.`);
  }
  if (code) {
    return new Error(`Could not connect to ${hostname} (${code}).`);
  }
  return new Error(`Could not connect to ${hostname}. Check your internet connection and try again.`);
}

async function fetchSiteFavicon(value) {
  const hostname = getFaviconHost(value);
  const address = await resolvePublicIPv4(hostname);
  let bestIcon = null;
  try {
    const downloaded = await downloadFavicon(hostname, address);
    bestIcon = { ...convertFavicon(downloaded.data), hostname: downloaded.hostname };
  } catch (error) {
    if (!error?.unsupportedFavicon) throw error;
  }

  if (bestIcon?.quality >= OUTPUT_ICON_SIZE) {
    return { hostname: bestIcon.hostname, dataUrl: bestIcon.dataUrl };
  }

  try {
    bestIcon = await discoverFavicon(hostname, address, bestIcon);
  } catch (error) {
    if (!bestIcon) throw error;
  }

  return {
    dataUrl: bestIcon.dataUrl,
    hostname: bestIcon.hostname ?? hostname,
  };
}

module.exports = { fetchSiteFavicon, getFaviconHost };
