const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { makePng } = require("../support/png");
const { createUtilityProcessStub } = require("../support/utility-process");

// favicon-decoder.js takes utilityProcess from Electron when it loads; every
// test passes its own fork, so this one must never run.
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return { utilityProcess: { fork() { throw new Error("tests pass their own fork"); } } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { decodeFavicon } = require("../src/main/favicon-decoder");
Module._load = originalLoad;
const { MAX_IMAGE_BYTES, decodePng, prepareFaviconImage, readPngSize } = require("../src/main/favicon-image");

const DECODER_PATH = path.join(__dirname, "..", "src", "main", "favicon-decoder-process.js");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function validReply(width = 16, height = 16) {
  const { icon } = prepareFaviconImage(makePng(width, height));
  return { ok: true, width, height, pixels: new Uint8Array(icon.pixels) };
}

test("each image is converted in a new process that gets the image and nothing else", async () => {
  const processes = createUtilityProcessStub();
  // A small Buffer lives in Node's shared pool, next to other data.
  const image = Buffer.concat([makePng(40, 20)]);
  assert.ok(image.buffer.byteLength > image.length, "the test image should come from the pool");
  const original = Buffer.from(image);

  const decoded = await decodeFavicon(image, { fork: processes.fork });
  assert.deepEqual([decoded.width, decoded.height], [40, 20]);
  assert.deepEqual(readPngSize(decoded.png), { width: 40, height: 20 });

  const [run] = processes.forks;
  assert.equal(processes.forks.length, 1);
  assert.equal(run.modulePath, DECODER_PATH);
  await fs.access(run.modulePath);
  assert.deepEqual(run.args, []);
  assert.deepEqual(run.options, {
    serviceName: "Mnemo favicon decoder",
    env: { MNEMO_FAVICON_DECODER: "1" },
    stdio: "ignore",
  });
  // Electron ignores an empty env; this one must not carry main's variables.
  assert.ok(Object.keys(run.options.env).every((name) => !Object.hasOwn(process.env, name)));

  // Only the image's own bytes are sent, not the pool around them.
  const [message] = run.messages;
  assert.deepEqual(Object.keys(message), ["image"]);
  assert.ok(message.image instanceof Uint8Array);
  assert.equal(message.image.buffer.byteLength, image.length);
  assert.deepEqual(Buffer.from(message.image), original);
  assert.deepEqual(image, original, "the caller's buffer is left alone");
  assert.equal(run.killed, true);

  await decodeFavicon(makePng(8, 8), { fork: processes.fork });
  assert.equal(processes.forks.length, 2);
});

test("an image the decoder cannot use resolves to null", async () => {
  const processes = createUtilityProcessStub();
  assert.equal(await decodeFavicon(JPEG, { fork: processes.fork }), null);
  assert.equal(processes.forks[0].killed, true);
});

test("empty, oversized, or non-Buffer input starts no process", async () => {
  const processes = createUtilityProcessStub();
  for (const input of [Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1), "PNG", new Uint8Array(8), null]) {
    assert.equal(await decodeFavicon(input, { fork: processes.fork }), null);
  }
  assert.equal(processes.forks.length, 0);
});

test("a decoder that does not reply in time is killed", async () => {
  const processes = createUtilityProcessStub({ behavior: () => {} });
  const started = Date.now();
  await assert.rejects(
    decodeFavicon(makePng(16, 16), { fork: processes.fork, timeoutMs: 30 }),
    /^Error: Processing the site icon took too long\.$/,
  );
  assert.ok(Date.now() - started >= 25);
  assert.equal(processes.forks[0].killed, true);
});

test("a decoder that crashes fails this icon only", async () => {
  const crashes = [
    (child) => child.emit("exit", 1),
    (child) => {
      // Electron reports a fatal V8 error, then the exit.
      child.emit("error", "FatalError", "favicon-image.js:1", "report");
      child.emit("exit", 134);
    },
    (child) => child.emit("exit", 0),
  ];
  for (const behavior of crashes) {
    const processes = createUtilityProcessStub({ behavior });
    await assert.rejects(
      decodeFavicon(makePng(16, 16), { fork: processes.fork }),
      /^Error: The site icon could not be processed\.$/,
    );
    assert.equal(processes.forks[0].killed, true);
  }

  // Main carries on: the next icon gets a new process and works.
  const healthy = createUtilityProcessStub();
  assert.equal((await decodeFavicon(makePng(16, 16), { fork: healthy.fork })).width, 16);
});

test("main encodes the stored PNG from the pixels it receives", async () => {
  const processes = createUtilityProcessStub({ behavior: (child) => child.emit("message", validReply(200, 100)) });
  const decoded = await decodeFavicon(makePng(16, 16), { fork: processes.fork });
  assert.deepEqual([decoded.width, decoded.height], [200, 100]);
  assert.deepEqual(readPngSize(decoded.png), { width: 96, height: 48 });
  assert.deepEqual([...decodePng(decoded.png).pixels.subarray(0, 4)], [0x35, 0x70, 0xc0, 0xff]);
});

test("replies that are not exactly an icon's pixels are refused", async () => {
  const valid = validReply();
  const replies = [
    null,
    "pixels",
    { ok: "yes" },
    { ok: true },
    { ok: true, width: 16, height: 16, pixels: "AAAA" },
    { ok: true, width: 16, height: 16, pixels: Array.from(valid.pixels) },
    // The old reply format, a PNG, is not accepted.
    { ok: true, width: 16, height: 16, png: new Uint8Array(makePng(16, 16)) },
    { ...valid, width: 0 },
    { ...valid, height: 513 },
    { ...valid, width: 1.5 },
    { ...valid, pixels: valid.pixels.subarray(4) },
    { ...valid, pixels: new Uint8Array(valid.pixels.length + 4) },
    // Pixels for 16×16 while claiming a 32×32 source (icon 32×32).
    { ...valid, width: 32, height: 32 },
    // A 200×200 source must arrive shrunk to 96×96.
    { ok: true, width: 200, height: 200, pixels: new Uint8Array(200 * 200 * 4) },
  ];
  for (const reply of replies) {
    const processes = createUtilityProcessStub({ behavior: (child) => child.emit("message", reply) });
    await assert.rejects(
      decodeFavicon(makePng(16, 16), { fork: processes.fork }),
      /could not be processed/,
      JSON.stringify(reply)?.slice(0, 80),
    );
    assert.equal(processes.forks[0].killed, true);
  }
});

test("a decoder that cannot start or receive the image fails cleanly", async () => {
  await assert.rejects(
    decodeFavicon(makePng(16, 16), { fork: () => { throw new Error("spawn failed"); } }),
    /could not be processed/,
  );

  const processes = createUtilityProcessStub();
  const fork = (...args) => {
    const child = processes.fork(...args);
    child.postMessage = () => { throw new Error("could not clone"); };
    return child;
  };
  await assert.rejects(decodeFavicon(makePng(16, 16), { fork }), /could not be processed/);
  assert.equal(processes.forks[0].killed, true);
});

test("a reply after the time limit is ignored", async () => {
  const processes = createUtilityProcessStub({
    behavior: (child) => setTimeout(() => child.emit("message", validReply()), 60),
  });
  await assert.rejects(
    decodeFavicon(makePng(16, 16), { fork: processes.fork, timeoutMs: 20 }),
    /took too long/,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
});
