const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createECDH } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { MAX_REPLY_BYTES, createTouchIdHelper } = require("../src/main/touch-id-helper");
const { build } = require("../scripts/build-touch-id");
const { makeTempDirectory } = require("../support/helpers");

const posixOnly = { skip: process.platform === "win32" && "needs a POSIX shell" };

// A stand-in helper: a shell script that runs `body`. The helper is started
// with an empty environment, so commands are given by full path.
async function makeScript(t, body) {
  const directory = await makeTempDirectory(t);
  const script = path.join(directory, "helper");
  await fs.writeFile(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return script;
}

test("the helper runner sends one request and reads one JSON reply", posixOnly, async (t) => {
  const echo = await makeScript(t, "/bin/cat");
  const request = { command: "status", reason: "unlock \"Work\"" };
  assert.deepEqual(await createTouchIdHelper(echo).run(request), request);

  // Nothing from Electron's environment reaches the helper.
  const environment = await makeScript(t, "printf '{\"count\":%s}' \"$(/usr/bin/env | /usr/bin/wc -l | /usr/bin/tr -d ' ')\"");
  const { count } = await createTouchIdHelper(environment).run({ command: "status" });
  assert.ok(count <= 3, `the helper saw ${count} environment variables`);
});

test("a missing, broken, slow, or chatty helper gives an error reply", posixOnly, async (t) => {
  const directory = await makeTempDirectory(t);
  assert.deepEqual(
    await createTouchIdHelper(path.join(directory, "missing")).run({ command: "status" }),
    { error: "unavailable" },
  );
  for (const body of [
    "printf 'not json'",
    "printf 'null'",
    "printf '[1,2]'",
    "exit 1",
  ]) {
    const reply = await createTouchIdHelper(await makeScript(t, body)).run({ command: "status" });
    assert.deepEqual(reply, { error: "failed" }, body);
  }

  const slow = await makeScript(t, "/bin/sleep 5");
  const started = Date.now();
  assert.deepEqual(await createTouchIdHelper(slow).run({ command: "status" }, { timeoutMs: 200 }), { error: "failed" });
  assert.ok(Date.now() - started < 3000);

  const chatty = await makeScript(t, `/usr/bin/head -c ${MAX_REPLY_BYTES * 4} /dev/zero`);
  assert.deepEqual(await createTouchIdHelper(chatty).run({ command: "status" }), { error: "failed" });
});

// Builds the real helper for this Mac and checks its protocol without ever
// showing a Touch ID prompt: agreements are made with "interactive": false.
// On a Mac without a Secure Enclave or an enrolled finger (CI) only the
// parts that need neither are checked.
test("the Swift helper answers the protocol without prompting", {
  skip: process.platform !== "darwin" && "the helper runs on macOS only",
  timeout: 300_000,
}, async (t) => {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
  } catch {
    t.skip("Xcode command line tools are not installed");
    return;
  }
  const directory = await makeTempDirectory(t);
  const binary = build(path.join(directory, "mnemo-touch-id"), {
    architectures: [process.arch === "arm64" ? "arm64" : "x86_64"],
  });
  const helper = createTouchIdHelper(binary);

  for (const request of [
    { command: "nope" },
    { command: "agree" },
    { command: "agree", keyBlob: "AAAA", peerPublicKey: "AAAA", reason: "" },
    { command: "agree", keyBlob: "AAAA", peerPublicKey: "AAAA", reason: "x".repeat(201) },
    { command: "status", padding: "x".repeat(70 * 1024) },
  ]) {
    assert.deepEqual(await helper.run(request), { error: "invalidRequest" }, JSON.stringify(request).slice(0, 80));
  }

  const { available } = await helper.run({ command: "status" });
  assert.equal(typeof available, "boolean");
  if (!available) return;

  const created = await helper.run({ command: "create" });
  const publicKey = Buffer.from(created.publicKey, "base64");
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 0x04);
  assert.equal(typeof created.keyBlob, "string");
  assert.ok(created.keyBlob.length <= 2048);

  const peer = createECDH("prime256v1");
  peer.generateKeys();
  assert.deepEqual(await helper.run({
    command: "agree",
    keyBlob: created.keyBlob,
    peerPublicKey: peer.getPublicKey("base64"),
    reason: "Mnemo test",
    interactive: false,
  }), { error: "interactionRequired" });
  assert.deepEqual(await helper.run({
    command: "agree",
    keyBlob: created.keyBlob,
    peerPublicKey: Buffer.alloc(65, 1).toString("base64"),
    reason: "Mnemo test",
    interactive: false,
  }), { error: "invalidRequest" });
});
