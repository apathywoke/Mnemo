const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const { httpsGet } = require("../updater");
const { makeTempDirectory } = require("../support/helpers");

const BASE = "https://github.com/apathywoke/Mnemo/releases/download/v1.0.0";

// Replaces https.get with responses from `routes` (URL → { status,
// headers, chunks }); no network is used.
function serve(t, routes) {
  const requested = [];
  t.mock.method(https, "get", (url, _options, callback) => {
    requested.push(url.toString());
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit("error", error));
    };
    const route = routes[url.toString()];
    process.nextTick(() => {
      const response = Readable.from(route.chunks ?? []);
      response.statusCode = route.status ?? 200;
      response.headers = route.headers ?? {};
      callback(response);
    });
    return request;
  });
  return requested;
}

// Fails the test if anything reaches process "uncaughtException".
function watchUncaught(t) {
  const caught = [];
  const listener = (error) => caught.push(error);
  process.on("uncaughtException", listener);
  t.after(() => process.off("uncaughtException", listener));
  return caught;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a download to a file has the SHA-512, size, and progress of what was written", async (t) => {
  const directory = await makeTempDirectory(t);
  const chunks = Array.from({ length: 40 }, () => randomBytes(16 * 1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  serve(t, { [`${BASE}/app.zip`]: { headers: { "content-length": String(total) }, chunks } });
  const progress = [];
  const toFile = path.join(directory, "app.zip");

  const result = await httpsGet(`${BASE}/app.zip`, {
    maxBytes: total,
    userAgent: "test",
    toFile,
    onProgress: (received, declared) => progress.push([received, declared]),
  });
  const written = await fs.readFile(toFile);
  assert.equal(result.size, written.length);
  assert.equal(result.size, total);
  assert.equal(result.sha512, createHash("sha512").update(written).digest("base64"));
  assert.deepEqual(progress.at(-1), [total, total]);
  assert.ok(progress.every(([received], index) => index === 0 || received > progress[index - 1][0]));
  if (process.platform !== "win32") assert.equal((await fs.stat(toFile)).mode & 0o777, 0o600);
});

test("a file that cannot be written rejects once, without an uncaught exception", async (t) => {
  const directory = await makeTempDirectory(t);
  const caught = watchUncaught(t);
  serve(t, { [`${BASE}/app.zip`]: { chunks: [randomBytes(1024), randomBytes(1024)] } });
  await assert.rejects(
    httpsGet(`${BASE}/app.zip`, {
      maxBytes: 1024 * 1024,
      userAgent: "test",
      toFile: path.join(directory, "missing", "app.zip"),
    }),
    /^Error: Could not download the update\.$/,
  );
  await settle();
  assert.deepEqual(caught, []);

  // An existing file is never overwritten or removed.
  const existing = path.join(directory, "existing.zip");
  await fs.writeFile(existing, "keep me");
  await assert.rejects(
    httpsGet(`${BASE}/app.zip`, { maxBytes: 1024 * 1024, userAgent: "test", toFile: existing }),
    /Could not download the update/,
  );
  await settle();
  assert.equal(await fs.readFile(existing, "utf8"), "keep me");
  assert.deepEqual(caught, []);
});

test("more than maxBytes is refused, declared or not, and the partial file is removed", async (t) => {
  const directory = await makeTempDirectory(t);
  serve(t, {
    [`${BASE}/declared.zip`]: { headers: { "content-length": "999999" }, chunks: [randomBytes(10)] },
    [`${BASE}/streamed.zip`]: { chunks: Array.from({ length: 10 }, () => randomBytes(1024)) },
    [`${BASE}/manifest.json`]: { chunks: Array.from({ length: 10 }, () => randomBytes(1024)) },
  });
  await assert.rejects(
    httpsGet(`${BASE}/declared.zip`, { maxBytes: 4096, userAgent: "test", toFile: path.join(directory, "a.zip") }),
    /The update is too large/,
  );
  const partial = path.join(directory, "b.zip");
  await assert.rejects(
    httpsGet(`${BASE}/streamed.zip`, { maxBytes: 4096, userAgent: "test", toFile: partial }),
    /The update is too large/,
  );
  await settle();
  await assert.rejects(fs.access(partial));
  await assert.rejects(
    httpsGet(`${BASE}/manifest.json`, { maxBytes: 4096, userAgent: "test" }),
    /The update is too large/,
  );
});

test("redirects are followed only to allowed hosts", async (t) => {
  const caught = watchUncaught(t);
  const requested = serve(t, {
    [`${BASE}/app.zip`]: { status: 302, headers: { location: "https://release-assets.githubusercontent.com/x" } },
    "https://release-assets.githubusercontent.com/x": { chunks: [Buffer.from("ok")] },
    [`${BASE}/evil.zip`]: { status: 302, headers: { location: "https://evil.example/x" } },
    [`${BASE}/plain.zip`]: { status: 301, headers: { location: "http://github.com/x" } },
  });
  assert.equal((await httpsGet(`${BASE}/app.zip`, { maxBytes: 100, userAgent: "test" })).buffer.toString(), "ok");
  await assert.rejects(httpsGet(`${BASE}/evil.zip`, { maxBytes: 100, userAgent: "test" }), /not allowed/);
  await assert.rejects(httpsGet(`${BASE}/plain.zip`, { maxBytes: 100, userAgent: "test" }), /not allowed/);
  await settle();
  assert.deepEqual(caught, []);
  assert.equal(requested.includes("https://evil.example/x"), false);
});
