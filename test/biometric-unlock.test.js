const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createECDH, randomBytes } = require("node:crypto");
const test = require("node:test");
const BiometricUnlock = require("../src/main/biometric-unlock");
const { makeTempDirectory, makeTouchIdHelper: makeHelper } = require("../support/helpers");

const PROFILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("with the helper, Touch ID keeps the vault key in a Secure Enclave key file", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { helper, platform: "darwin" });
  const dataKey = randomBytes(32);

  assert.equal(await biometric.isAvailable(), true);
  assert.equal(await biometric.isEnabled(PROFILE), false);
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  const agrees = helper.requests.filter((request) => request.command === "agree");
  assert.deepEqual(agrees.map((request) => request.reason), ["turn on Touch ID"]);
  assert.equal(agrees[0].interactive, undefined);
  assert.equal(await biometric.isEnabled(PROFILE), true);

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
  assert.equal(await biometric.isEnabled(PROFILE), false);
});

test("a Secure Enclave key file opens only for its own vault and only intact", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { helper, platform: "darwin" });
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

  // Without the helper (an older macOS, or a build without it), the file
  // does not unlock but is kept.
  await write(original);
  const withoutHelper = new BiometricUnlock(directory, { platform: "darwin" });
  await assert.rejects(withoutHelper.releaseKey(PROFILE, "unlock"), /not available on this Mac/);
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
});

test("turning Touch ID on with the helper writes nothing if the touch fails", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { helper, platform: "darwin" });
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
  const withLying = new BiometricUnlock(directory, { helper: lying, platform: "darwin" });
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
    const withBroken = new BiometricUnlock(directory, { helper: broken, platform: "darwin" });
    await assert.rejects(withBroken.enable(PROFILE, randomBytes(32), "x"), /Could not turn on Touch ID/);
    assert.equal(await biometric.isEnabled(PROFILE), false);
  }
});

test("an old Keychain key file is deleted, and Touch ID is off until turned on again", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  const biometric = new BiometricUnlock(directory, { helper, platform: "darwin" });
  const file = path.join(directory, "biometric", `${PROFILE}.key`);
  // Version 1: Electron safeStorage output, which starts with "v10".
  const writeOld = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.concat([Buffer.from("v10"), randomBytes(120)]));
  };

  await writeOld();
  assert.equal(await biometric.isEnabled(PROFILE), false);
  await assert.rejects(fs.access(file), { code: "ENOENT" });

  await writeOld();
  await assert.rejects(biometric.releaseKey(PROFILE, "unlock"), /not turned on/);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  assert.equal(helper.requests.some((request) => request.command === "agree"), false);

  // At startup, old files of every vault go, and Secure Enclave files stay.
  const other = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  const kept = randomBytes(32);
  await biometric.enable(other, kept, "turn on Touch ID");
  await writeOld();
  await fs.writeFile(path.join(directory, "biometric", "notes.txt"), "v10 not a key file");
  await biometric.removeOldFiles();
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), [`${other}.key`, "notes.txt"]);
  assert.deepEqual(await biometric.releaseKey(other, "unlock"), kept);
  await new BiometricUnlock(path.join(directory, "missing"), { helper }).removeOldFiles();

  const dataKey = randomBytes(32);
  await writeOld();
  await biometric.enable(PROFILE, dataKey, "turn on Touch ID");
  assert.equal(await biometric.isEnabled(PROFILE), true);
  assert.deepEqual(await biometric.releaseKey(PROFILE, "unlock"), dataKey);
});

test("Touch ID needs the helper on macOS", async (t) => {
  const directory = await makeTempDirectory(t);
  const helper = makeHelper();
  assert.equal(await new BiometricUnlock(directory, { helper, platform: "darwin" }).isAvailable(), true);
  for (const options of [
    { helper, platform: "linux" },
    { platform: "darwin" },
    { helper: makeHelper({ available: false }), platform: "darwin" },
    { helper: { run: async () => { throw new Error("spawn failed"); } }, platform: "darwin" },
  ]) {
    const biometric = new BiometricUnlock(directory, options);
    assert.equal(await biometric.isAvailable(), false);
    await assert.rejects(biometric.enable(PROFILE, randomBytes(32), "x"), /not available on this Mac/);
    assert.equal(await biometric.isEnabled(PROFILE), false);
  }
  await assert.rejects(new BiometricUnlock(directory, { helper }).isEnabled("../../etc"), /valid vault profile/);
});
