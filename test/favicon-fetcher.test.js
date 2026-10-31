const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");
const dns = require("node:dns/promises");
const https = require("node:https");
const { encodeJpeg } = require("../support/jpeg");
const { makePng } = require("../support/png");
const { createUtilityProcessStub } = require("../support/utility-process");
const { decodePng } = require("../src/main/favicon-image");

// Images are decoded by the real decoder entry, run in this process by the
// utilityProcess stand-in; a test can swap in another fork.
const decoderProcesses = createUtilityProcessStub();
let forkOverride = null;
const utilityProcess = { fork: (...args) => (forkOverride ?? decoderProcesses.fork)(...args) };

const originalModuleLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return { utilityProcess };
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { fetchSiteFavicon, getFaviconHost } = require("../src/main/favicon-fetcher");
Module._load = originalModuleLoad;

function makeResponse(statusCode, contentType, body = Buffer.alloc(0), location = null) {
  return { statusCode, contentType, body, location };
}

function installNetworkStubs(t, { route, lookup, resolve4 }) {
  const originalLookup = dns.lookup;
  const originalResolve4 = dns.resolve4;
  const originalGet = https.get;
  const requested = [];

  dns.lookup = lookup ?? (async () => [{ address: "93.184.216.34", family: 4 }]);
  dns.resolve4 = resolve4 ?? (async () => ["93.184.216.34"]);
  https.get = (options, callback) => {
    requested.push({ hostname: options.hostname, path: options.path, accept: options.headers?.accept });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (error) request.emit("error", error);
      return request;
    };

    process.nextTick(() => {
      const result = route(options);
      const response = new EventEmitter();
      response.statusCode = result.statusCode;
      response.headers = {
        "content-type": result.contentType,
        ...(result.location ? { location: result.location } : {}),
      };
      response.complete = true;
      response.destroy = () => {};
      callback(response);
      if (result.statusCode === 200) {
        response.emit("data", Buffer.from(result.body));
        response.emit("end");
      }
    });
    return request;
  };

  t.after(() => {
    dns.lookup = originalLookup;
    dns.resolve4 = originalResolve4;
    https.get = originalGet;
  });
  return requested;
}

function pngResponse(width, height) {
  return makeResponse(200, "image/png", makePng(width, height));
}

function makeBmpIco(width, height) {
  const xorStride = width * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const xorBytes = xorStride * height;
  const image = Buffer.alloc(40 + xorBytes + maskStride * height);
  image.writeUInt32LE(40, 0);
  image.writeInt32LE(width, 4);
  image.writeInt32LE(height * 2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(32, 14);
  image.writeUInt32LE(0, 16);
  image.writeUInt32LE(xorBytes, 20);
  for (let offset = 40; offset < 40 + xorBytes; offset += 4) {
    image[offset] = 0x35;
    image[offset + 1] = 0x70;
    image[offset + 2] = 0xc0;
    image[offset + 3] = 0xff;
  }

  const ico = Buffer.alloc(22 + image.length);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = width === 256 ? 0 : width;
  ico[7] = height === 256 ? 0 : height;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(image.length, 14);
  ico.writeUInt32LE(22, 18);
  image.copy(ico, 22);
  return ico;
}

function pngDimensions(dataUrl) {
  const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("site URL validation accepts public HTTPS domains and blocks unsafe inputs", () => {
  assert.equal(getFaviconHost("https://www.example.com/login?next=home"), "www.example.com");
  for (const value of [
    "http://example.com",
    "file:///etc/passwd",
    "https://user@example.com",
    "https://127.0.0.1",
    "https://localhost",
    "https://private.local",
    "https://example.com:444",
  ]) {
    assert.throws(() => getFaviconHost(value), /public HTTPS domain/);
  }
});

test("small direct favicons trigger homepage discovery and the sharpest actual candidate wins", async (t) => {
  const html = Buffer.from([
    '<html><head>',
    '<link rel="icon" sizes="16x16" href="/low.png">',
    '<link rel="apple-touch-icon" sizes="128x128" href="/high.png">',
    '</head></html>',
  ].join(""));
  const requested = installNetworkStubs(t, {
    route: ({ path: requestPath }) => {
      if (requestPath === "/favicon.ico") return pngResponse(16, 16);
      if (requestPath === "/") return makeResponse(200, "text/html", html);
      if (requestPath === "/high.png") return pngResponse(96, 64);
      if (requestPath === "/low.png") return pngResponse(16, 16);
      if (requestPath === "/favicon.png") return pngResponse(32, 32);
      return makeResponse(404, "text/html");
    },
  });

  const favicon = await fetchSiteFavicon("https://example.com/login");
  assert.equal(favicon.hostname, "example.com");
  assert.deepEqual(pngDimensions(favicon.dataUrl), { width: 96, height: 64 });
  assert.deepEqual(requested.slice(0, 4).map(({ path: requestPath }) => requestPath), [
    "/favicon.ico",
    "/",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
  ]);
  assert.equal(requested.some(({ path: requestPath }) => requestPath === "/high.png"), true);
  assert.equal(requested.length <= 7, true);
});

test("small icons are not enlarged, ICO DIB images are converted, and aspect ratio is preserved", async (t) => {
  installNetworkStubs(t, {
    route: ({ path: requestPath }) => {
      if (requestPath === "/favicon.ico") {
        return makeResponse(200, "image/x-icon", makeBmpIco(16, 16));
      }
      if (requestPath === "/") return makeResponse(200, "text/html", "<html><head></head></html>");
      return makeResponse(404, "text/html");
    },
  });

  const favicon = await fetchSiteFavicon("https://example.com");
  assert.deepEqual(pngDimensions(favicon.dataUrl), { width: 16, height: 16 });

  const landscape = installNetworkStubs(t, {
    route: ({ path: requestPath }) =>
      requestPath === "/favicon.ico"
        ? pngResponse(512, 100)
        : makeResponse(404, "text/html"),
  });
  const wideIcon = await fetchSiteFavicon("https://wide.example.com");
  assert.deepEqual(pngDimensions(wideIcon.dataUrl), { width: 96, height: 19 });
  assert.equal(landscape.some(({ path: requestPath }) => requestPath === "/"), false);
});

test("DNS fallback resolves public addresses and rejects private addresses", async (t) => {
  let fallbackQueries = 0;
  installNetworkStubs(t, {
    lookup: async () => {
      const error = new Error("temporary resolver failure");
      error.code = "EAI_AGAIN";
      throw error;
    },
    resolve4: async () => {
      fallbackQueries += 1;
      return ["93.184.216.34"];
    },
    route: ({ path: requestPath }) =>
      requestPath === "/favicon.ico"
        ? pngResponse(96, 96)
        : makeResponse(404, "text/html"),
  });
  await fetchSiteFavicon("https://example.com");
  assert.equal(fallbackQueries, 1);

  const blocked = installNetworkStubs(t, {
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    route: () => makeResponse(404, "text/html"),
  });
  await assert.rejects(fetchSiteFavicon("https://example.com"), /public IPv4/);
  assert.equal(blocked.length, 0);
});

test("cross-domain redirects and SVG-only sites are rejected safely", async (t) => {
  const redirected = installNetworkStubs(t, {
    route: ({ path: requestPath }) => requestPath === "/favicon.ico"
      ? makeResponse(302, "text/html", Buffer.alloc(0), "https://attacker.invalid/icon.png")
      : makeResponse(404, "text/html"),
  });
  await assert.rejects(fetchSiteFavicon("https://example.com"), /redirected to an address that is not allowed/);
  assert.equal(redirected.length, 1);

  installNetworkStubs(t, {
    route: ({ path: requestPath }) => {
      if (requestPath === "/favicon.ico") return makeResponse(404, "text/html");
      if (requestPath === "/") {
        return makeResponse(200, "text/html", '<html><head><link rel="icon" href="/brand.svg"></head></html>');
      }
      return makeResponse(404, "text/html");
    },
  });
  await assert.rejects(fetchSiteFavicon("https://example.com"), /may only provide SVG/);
});

test("JPEG icons are decoded and progressive ones are skipped", async (t) => {
  const color = () => [30, 120, 200];
  const html = '<html><head><link rel="icon" sizes="192x192" href="/progressive.jpg"><link rel="icon" sizes="64x64" href="/icon.jpg"></head></html>';
  const requested = installNetworkStubs(t, {
    route: ({ path: requestPath }) => {
      if (requestPath === "/favicon.ico") return makeResponse(200, "image/jpeg", encodeJpeg({ width: 48, height: 48, sample: color }));
      if (requestPath === "/progressive.jpg") return makeResponse(200, "image/jpeg", encodeJpeg({ width: 192, height: 192, sample: color, frameMarker: 0xc2 }));
      if (requestPath === "/icon.jpg") return makeResponse(200, "image/jpeg", encodeJpeg({ width: 64, height: 64, sample: color, sampling: [[2, 2], [1, 1], [1, 1]] }));
      if (requestPath === "/") return makeResponse(200, "text/html", html);
      return makeResponse(404, "text/html");
    },
  });
  const forksBefore = decoderProcesses.forks.length;

  const favicon = await fetchSiteFavicon("https://example.com");
  assert.deepEqual(pngDimensions(favicon.dataUrl), { width: 64, height: 64 });
  const icon = decodePng(Buffer.from(favicon.dataUrl.slice("data:image/png;base64,".length), "base64"));
  const pixel = [...icon.pixels.subarray(0, 4)];
  assert.ok(pixel.every((value, channel) => Math.abs(value - [30, 120, 200, 255][channel]) <= 3), String(pixel));
  assert.equal(requested.some(({ path: requestPath }) => requestPath === "/progressive.jpg"), true);
  for (const { accept } of requested.filter(({ path: requestPath }) => requestPath !== "/")) {
    assert.match(accept, /image\/jpeg/);
  }
  // One decoder process per downloaded image, each killed afterwards.
  const forks = decoderProcesses.forks.slice(forksBefore);
  assert.equal(forks.length, 3);
  assert.ok(forks.every(({ killed }) => killed));
});

test("a decoder crash stops the fetch, but an icon already found is kept", async (t) => {
  t.after(() => { forkOverride = null; });
  installNetworkStubs(t, {
    route: ({ path: requestPath }) => {
      if (requestPath === "/favicon.ico") return pngResponse(16, 16);
      if (requestPath === "/") return makeResponse(200, "text/html", '<html><head><link rel="icon" href="/icon.png"></head></html>');
      if (requestPath === "/icon.png") return pngResponse(64, 64);
      return makeResponse(404, "text/html");
    },
  });

  forkOverride = createUtilityProcessStub({ behavior: (child) => child.emit("exit", 1) }).fork;
  await assert.rejects(fetchSiteFavicon("https://example.com"), /^Error: The site icon could not be processed\.$/);

  // A crash after a usable icon was found keeps that icon.
  let calls = 0;
  const crashOnSecond = createUtilityProcessStub({
    behavior: (child) => child.emit("exit", 1),
  });
  forkOverride = (...args) => (calls++ === 0 ? decoderProcesses.fork : crashOnSecond.fork)(...args);
  const kept = await fetchSiteFavicon("https://example.com");
  assert.deepEqual(pngDimensions(kept.dataUrl), { width: 16, height: 16 });
});
