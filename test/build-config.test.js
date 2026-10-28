const assert = require("node:assert/strict");
const { createPublicKey } = require("node:crypto");
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

test("release builds ship only Ed25519 public update keys", async () => {
  const directory = path.join(__dirname, "..", "build", "update-keys");
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".pem"));
  assert.ok(names.length > 0, "no update keys: installed copies could never update");
  for (const name of names) {
    const text = await fs.readFile(path.join(directory, name), "utf8");
    assert.doesNotMatch(text, /PRIVATE KEY/, `${name} is a private key`);
    assert.equal(createPublicKey(text).asymmetricKeyType, "ed25519", name);
  }
  assert.ok(config.files.includes("build/update-keys/*.pem"));
});

// Every local module the main process or preload loads must be packaged,
// or the release build fails at startup.
test("release builds include every module that main and preload require", async () => {
  const root = path.join(__dirname, "..");
  // electron-builder globs: "**/" is any number of folders, "*" one name part.
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const patterns = config.files.map((pattern) => new RegExp(`^${pattern
    .split("**/")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join("(?:.*/)?")}$`));
  const seen = new Set();
  const queue = ["main.js", "preload.js"];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(path.join(root, file), "utf8");
    for (const [, request] of source.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      let resolved = path.relative(root, path.resolve(root, path.dirname(file), request));
      if (!resolved.endsWith(".js") && !resolved.endsWith(".json")) resolved += ".js";
      queue.push(resolved.split(path.sep).join("/"));
    }
  }
  const missing = [...seen].filter((file) => !patterns.some((pattern) => pattern.test(file)));
  assert.deepEqual(missing, []);
  assert.ok(seen.has("backup-file.js") && seen.has("vault-store.js"));
});
