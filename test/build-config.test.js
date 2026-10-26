const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const config = require("../electron-builder.config");

test("release build disables Node entry points and enforces asar integrity", () => {
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(config.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(config.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(config.asar, true);
  assert.equal(config.files.some((pattern) => /test|support|\.md$/.test(pattern)), false);
});

test("release build is signed with the hardened runtime and notarized", async () => {
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.afterSign, "scripts/verify-mac-release.js");

  const entitlements = await fs.readFile(
    path.join(__dirname, "..", config.mac.entitlements),
    "utf8",
  );
  const keys = Array.from(entitlements.matchAll(/<key>([^<]+)<\/key>/g), ([, key]) => key);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit"]);
});
