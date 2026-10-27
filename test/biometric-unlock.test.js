const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const BiometricUnlock = require("../biometric-unlock");
const { makeTempDirectory } = require("../support/helpers");

// Stand-ins for Electron's safeStorage (Keychain-backed) and Touch ID prompt.
function makeElectron({ touchId = true, encryption = true } = {}) {
  const prompts = [];
  let nextPrompt = "allow";
  const keychainKey = randomBytes(32);
  const xor = (buffer) => Buffer.from(buffer.map((byte, i) => byte ^ keychainKey[i % 32]));
  return {
    prompts,
    respond(value) { nextPrompt = value; },
    safeStorage: {
      isEncryptionAvailable: () => encryption,
      encryptString: (text) => Buffer.concat([Buffer.from("v10"), xor(Buffer.from(text))]),
      decryptString: (buffer) => {
        if (buffer.subarray(0, 3).toString() !== "v10") throw new Error("bad");
        return xor(buffer.subarray(3)).toString();
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

const PROFILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("Touch ID stores the vault key encrypted and releases it after a prompt", async (t) => {
  const directory = await makeTempDirectory(t);
  const electron = makeElectron();
  const biometric = new BiometricUnlock(directory, { ...electron, platform: "darwin" });
  const dataKey = randomBytes(32);

  assert.equal(biometric.isAvailable(), true);
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
    [{}, "linux"],
  ]) {
    const biometric = new BiometricUnlock(directory, { ...makeElectron(options), platform });
    assert.equal(biometric.isAvailable(), false);
    await assert.rejects(
      biometric.enable(PROFILE, randomBytes(32), "x"),
      /not available on this Mac/,
    );
  }
});
