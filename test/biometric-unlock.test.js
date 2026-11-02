const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createECDH, randomBytes } = require("node:crypto");
const test = require("node:test");
const BiometricUnlock = require("../src/main/biometric-unlock");
const { makeTempDirectory } = require("../support/helpers");

// Stand-ins for Electron's safeStorage (Keychain-backed) and Touch ID prompt.
// Only the async safeStorage API is offered: the synchronous one is
// deprecated, and a call to it fails these tests. `encryption` may be an
// Error, which isAsyncEncryptionAvailable then rejects with.
function makeElectron({ touchId = true, encryption = true, reEncrypt = false } = {}) {
  const prompts = [];
  let nextPrompt = "allow";
  const keychainKey = randomBytes(32);
  const xor = (buffer) => Buffer.from(buffer.map((byte, i) => byte ^ keychainKey[i % 32]));
  return {
    prompts,
    respond(value) { nextPrompt = value; },
    safeStorage: {
      isAsyncEncryptionAvailable: async () => {
        if (encryption instanceof Error) throw encryption;
        return encryption;
      },
      encryptStringAsync: async (text) => Buffer.concat([Buffer.from("v10"), xor(Buffer.from(text))]),
      decryptStringAsync: async (buffer) => {
        if (buffer.subarray(0, 3).toString() !== "v10") throw new Error("bad");
        return { shouldReEncrypt: reEncrypt, result: xor(buffer.subarray(3)).toString() };
      },
    },
    systemPreferences: {
      canPromptTouchID: () => touchId,
      promptTouchID: async (reason) => {
        prompts.push(reason);
        if (nextPrompt !== "allow") throw new Error("User canceled");
      },
    },
  };
}

// A stand-in for the Touch ID helper (native/touch-id/main.swift) that does
// the key agreement in software. The "Secure Enclave" keys live in `keys`,
// so a blob only works with the helper that made it, like on a real Mac.
// `respond` sets the reply of the next agree: "allow", or an error code.
function makeHelper({ available = true } = {}) {
  const keys = new Map();
  const requests = [];
  let nextAgree = "allow";
  return {
    requests,
    keys,
    respond(value) { nextAgree = value; },
    async run(request) {
      requests.push(request);
      if (request.command === "status") return { available };
      if (!available) return { error: "unavailable" };
      if (request.command === "create") {
        const key = createECDH("prime256v1");
        const publicKey = key.generateKeys();
        const keyBlob = randomBytes(96).toString("base64");
        keys.set(keyBlob, key);
        return { publicKey: publicKey.toString("base64"), keyBlob };
      }
      if (request.command === "agree") {
        if (nextAgree !== "allow") return { error: nextAgree };
        const key = keys.get(request.keyBlob);
        if (!key) return { error: "invalidated" };
        const secret = key.computeSecret(Buffer.from(request.peerPublicKey, "base64"));
        return { sharedSecret: secret.toString("base64") };
      }
      return { error: "invalidRequest" };
    },
  };
}

const PROFILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("Touch ID stores the vault key encrypted and releases it after a prompt", async (t) => {
  const directory = await makeTempDirectory(t);
  const electron = makeElectron();
  const biometric = new BiometricUnlock(directory, { ...electron, platform: "darwin" });
  const dataKey = randomBytes(32);

  assert.equal(await biometric.isAvailable(), true);
  assert.equal(await biometric.isEnabled(PROFILE), false);
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  assert.deepEqual(electron.prompts, ["turn on Touch ID"]);
  assert.equal(await biometric.isEnabled(PROFILE), true);

  const file = path.join(directory, "biometric", `${PROFILE}.key`);
  const stored = await fs.readFile(file);
  assert.equal(stored.includes(dataKey.toString("base64")), false);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }

  const released = await biometric.releaseKey(PROFILE, "unlock");
  assert.deepEqual(released, dataKey);

  electron.respond("cancel");
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /canceled or did not match/);
  electron.respond("allow");

  // A key file copied to another profile does not unlock it.
  const other = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  await fs.copyFile(file, path.join(directory, "biometric", `${other}.key`));
  await assert.rejects(biometric.releaseKey(other, "unlock"), /can no longer unlock/);

  await biometric.disable(PROFILE);
  assert.equal(await biometric.isEnabled(PROFILE), false);
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /not turned on/);
  await biometric.disable(PROFILE);
  await assert.rejects(biometric.isEnabled("../../etc"), /valid vault profile/);
});

test("Touch ID is unavailable without the sensor, Keychain encryption, or macOS", async (t) => {
  const directory = await makeTempDirectory(t);
  for (const [options, platform] of [
    [{ touchId: false }, "darwin"],
    [{ encryption: false }, "darwin"],
    [{ encryption: new Error("Keychain is not ready") }, "darwin"],
    [{}, "linux"],
  ]) {
    const biometric = new BiometricUnlock(directory, { ...makeElectron(options), platform });
    assert.equal(await biometric.isAvailable(), false);
    await assert.rejects(
      biometric.enable(PROFILE, randomBytes(32), "x"),
      /not available on this Mac/,
    );
  }
});

test("a key file Electron asks to re-encrypt still unlocks and is left as it is", async (t) => {
  const directory = await makeTempDirectory(t);
  const electron = makeElectron({ reEncrypt: true });
  const biometric = new BiometricUnlock(directory, { ...electron, platform: "darwin" });
  const dataKey = randomBytes(32);
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  const file = path.join(directory, "biometric", `${PROFILE}.key`);
  const before = await fs.readFile(file);

  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
  assert.deepEqual(await fs.readFile(file), before);

  // A Keychain that refuses to decrypt gives the error on which the app turns
  // Touch ID off for this vault.
  electron.safeStorage.decryptStringAsync = async () => {
    throw new Error("Keychain access was denied");
  };
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /can no longer unlock/);
});

test("with the helper, Touch ID keeps the vault key in a Secure Enclave key file", async (t) => {
  const directory = await makeTempDirectory(t);
  const electron = makeElectron();
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { ...electron, helper, platform: "darwin" });
  const dataKey = randomBytes(32);

  assert.equal(await biometric.isAvailable(), true);
  assert.equal(await biometric.backend(PROFILE), null);
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  // The helper asked for Touch ID; Electron's own prompt and the Keychain
  // were not used.
  assert.deepEqual(electron.prompts, []);
  const agrees = helper.requests.filter((request) => request.command === "agree");
  assert.deepEqual(agrees.map((request) => request.reason), ["turn on Touch ID"]);
  assert.equal(agrees[0].interactive, undefined);
  assert.equal(await biometric.backend(PROFILE), "secureEnclave");

  const file = path.join(directory, "biometric", `${PROFILE}.key`);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["ephemeralPublicKey", "keyBlob", "profileId", "salt", "version", "wrap"]);
  assert.equal(stored.version, 2);
  assert.equal(JSON.stringify(stored).includes(dataKey.toString("base64")), false);
  assert.equal(JSON.stringify(stored).includes(dataKey.toString("hex")), false);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }

  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
  assert.equal(helper.requests.at(-1).reason, "unlock");

  // A canceled or failed touch leaves the file in place.
  for (const code of ["canceled", "interactionRequired"]) {
    helper.respond(code);
    await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /canceled or did not match/);
  }
  helper.respond("unavailable");
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /not available on this Mac/);
  helper.respond("allow");
  assert.equal(await biometric.isEnabled(PROFILE), true);
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);

  // A fingerprint added or removed: the Secure Enclave refuses the key.
  helper.respond("invalidated");
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /can no longer unlock/);
  helper.respond("allow");

  await biometric.disable(PROFILE);
  assert.equal(await biometric.backend(PROFILE), null);
});

test("a Secure Enclave key file opens only for its own vault and only intact", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const electron = makeElectron();
  const biometric = new BiometricUnlock(directory, { ...electron, helper, platform: "darwin" });
  const dataKey = randomBytes(32);
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  const file = path.join(directory, "biometric", `${PROFILE}.key`);
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  const write = (payload) => fs.writeFile(file, JSON.stringify(payload));

  // Copied to another profile, with or without its profileId changed: the
  // wrap is bound to the profile, so it does not unlock.
  const other = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  const otherFile = path.join(directory, "biometric", `${other}.key`);
  await fs.copyFile(file, otherFile);
  await assert.rejects(biometric.releaseKey(other, "unlock"), /can no longer unlock/);
  await fs.writeFile(otherFile, JSON.stringify({ ...original, profileId: other }));
  await assert.rejects(biometric.releaseKey(other, "unlock"), /can no longer unlock/);

  const flip = (base64) => {
    const bytes = Buffer.from(base64, "base64");
    bytes[bytes.length - 1] ^= 1;
    return bytes.toString("base64");
  };
  const otherPoint = createECDH("prime256v1");
  for (const tampered of [
    { ...original, wrap: { ...original.wrap, ciphertext: flip(original.wrap.ciphertext) } },
    { ...original, wrap: { ...original.wrap, tag: flip(original.wrap.tag) } },
    { ...original, salt: flip(original.salt) },
    { ...original, ephemeralPublicKey: otherPoint.generateKeys().toString("base64") },
    { ...original, keyBlob: randomBytes(96).toString("base64") },
    { ...original, keyBlob: "A".repeat(4000) },
    { ...original, version: 3 },
    { ...original, wrap: null },
  ]) {
    await write(tampered);
    await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /can no longer unlock/);
  }
  // A damaged Secure Enclave file never falls back to the Keychain prompt.
  assert.deepEqual(electron.prompts, []);

  // Without the helper (an older macOS, or a build without it), the file
  // does not unlock and is not mistaken for a Keychain file.
  await write(original);
  const withoutHelper = new BiometricUnlock(directory, { ...makeElectron(), platform: "darwin" });
  await assert.rejects(withoutHelper.releaseKey(PROFILE, "unlock"), /not available on this Mac/);
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
});

test("turning Touch ID on with the helper writes nothing if the touch fails", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { ...makeElectron(), helper, platform: "darwin" });
  for (const [code, message] of [
    ["canceled", /canceled or did not match/],
    ["unavailable", /not available on this Mac/],
    ["failed", /Could not turn on Touch ID/],
  ]) {
    helper.respond(code);
    await assert.rejects(biometric.enable(PROFILE, randomBytes(32), "turn on Touch ID"), message);
    assert.equal(await biometric.isEnabled(PROFILE), false);
  }
  helper.respond("allow");

  // A helper whose agreement does not match its public key is not trusted.
  const lying = makeHelper();
  const run = lying.run;
  lying.run = async (request) => {
    const reply = await run(request);
    return request.command === "agree" ? { sharedSecret: randomBytes(32).toString("base64") } : reply;
  };
  const withLying = new BiometricUnlock(directory, { ...makeElectron(), helper: lying, platform: "darwin" });
  await assert.rejects(withLying.enable(PROFILE, randomBytes(32), "x"), /Could not turn on Touch ID/);
  assert.equal(await biometric.isEnabled(PROFILE), false);

  for (const reply of [
    {},
    { publicKey: "not base64!", keyBlob: "AAAA" },
    { publicKey: randomBytes(65).toString("base64") },
    { publicKey: createECDH("prime256v1").generateKeys().toString("base64"), keyBlob: "A".repeat(4000) },
  ]) {
    const broken = makeHelper();
    const brokenRun = broken.run;
    broken.run = async (request) => (request.command === "create" ? reply : brokenRun(request));
    const withBroken = new BiometricUnlock(directory, { ...makeElectron(), helper: broken, platform: "darwin" });
    await assert.rejects(withBroken.enable(PROFILE, randomBytes(32), "x"), /Could not turn on Touch ID/);
    assert.equal(await biometric.isEnabled(PROFILE), false);
  }
});

test("Keychain key files keep working next to the helper, which is used only for new ones", async (t) => {
  const directory = await makeTempDirectory(t);
  const electron = makeElectron();
  const dataKey = randomBytes(32);
  // Written before the helper existed, or where it cannot run.
  const old = new BiometricUnlock(directory, { ...electron, helper: makeHelper({ available: false }), platform: "darwin" });
  assert.equal(await old.isAvailable(), true);
  await old.enable(PROFILE, dataKey, "turn on Touch ID");
  assert.equal(await old.backend(PROFILE), "keychain");
  assert.deepEqual(electron.prompts, ["turn on Touch ID"]);

  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { ...electron, helper, platform: "darwin" });
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
  assert.deepEqual(electron.prompts, ["turn on Touch ID", "unlock"]);
  assert.equal(helper.requests.some((request) => request.command === "agree"), false);
  // Not converted: still a Keychain file.
  assert.equal(await biometric.backend(PROFILE), "keychain");

  // Turning Touch ID on again moves the vault to the Secure Enclave.
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  assert.equal(await biometric.backend(PROFILE), "secureEnclave");
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
  assert.equal(electron.prompts.length, 2);
});

test("the helper alone makes Touch ID available, and never off macOS", async (t) => {
  const directory = await makeTempDirectory(t);
  const keychainOff = makeElectron({ encryption: false });
  const helper = makeHelper();
  assert.equal(await new BiometricUnlock(directory, { ...keychainOff, helper, platform: "darwin" }).isAvailable(), true);
  assert.equal(await new BiometricUnlock(directory, { ...keychainOff, helper, platform: "linux" }).isAvailable(), false);
  const throwing = { run: async () => { throw new Error("spawn failed"); } };
  assert.equal(await new BiometricUnlock(directory, { ...keychainOff, helper: throwing, platform: "darwin" }).isAvailable(), false);
});
