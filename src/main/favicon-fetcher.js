const dns = require("node:dns/promises");
const https = require("node:https");
const { isIP } = require("node:net");
const { decodeFavicon } = require("./favicon-decoder");
const { MAX_ICON_DIMENSION, MAX_IMAGE_BYTES, OUTPUT_ICON_SIZE } = require("./favicon-image");

// Images are decoded in a separate process (favicon-decoder.js); this module
// only finds and downloads them.
const MAX_DOWNLOAD_BYTES = MAX_IMAGE_BYTES;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_ICONS = 5;

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
      const codeSuffix = code ? ` (${code})` : "";
      throw new Error(`Could not resolve ${hostname}${codeSuffix}. Check your connection or DNS settings.`);
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
    "image/png,image/x-icon,image/vnd.microsoft.icon,image/webp,image/gif;q=0.8",
    MAX_DOWNLOAD_BYTES,
  );
  if (
    response.statusCode !== 200 ||
    response.contentType === "image/svg+xml" ||
    response.contentType === "text/html"
  ) {
    response.data?.fill(0);
    throw unsupportedFavicon("The site did not provide a supported PNG or ICO icon at this address.");
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
      const converted = await convertFavicon(downloaded.data);
      const candidate = { ...converted, hostname: downloaded.hostname };
      if (isHigherQualityIcon(candidate, bestIcon)) bestIcon = candidate;
    } catch (error) {
      if (error?.unsupportedFavicon) continue;
      throw error;
    }
  }

  if (bestIcon) return bestIcon;

  throw new Error(
    "No supported PNG or ICO icon was found. This site may only provide SVG, JPEG, or an unsupported ICO format.",
  );
}

async function convertFavicon(downloaded) {
  try {
    const decoded = await decodeFavicon(downloaded);
    if (!decoded) throw unsupportedFavicon("The website's favicon image could not be decoded.");
    const { png, width, height } = decoded;
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
    bestIcon = { ...(await convertFavicon(downloaded.data)), hostname: downloaded.hostname };
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
