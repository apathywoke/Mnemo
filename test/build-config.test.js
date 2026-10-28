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

// The GitHub workflow publishes ad-hoc builds. They have no Developer ID, but
// they must still have the hardened runtime (docs/THREAT_MODEL.md, A4 and A5).
test("the release workflow builds with the hardened runtime", async () => {
  const root = path.join(__dirname, "..");
  const workflow = await fs.readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const { scripts } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const adhoc = scripts["dist:mac:adhoc"];

  for (const text of [workflow, adhoc]) {
    assert.doesNotMatch(text, /hardenedRuntime=false/);
    assert.doesNotMatch(text, /MNEMO_LOCAL_TEST_BUILD/);
  }
  assert.match(workflow, /^\s*run: npm run dist:mac:adhoc$/m);
  assert.match(adhoc, /^MNEMO_VERIFY_MODE=adhoc-release electron-builder --mac /);
  assert.match(adhoc, /-c\.mac\.entitlements=build\/entitlements\.adhoc\.plist/);
  assert.match(adhoc, /-c\.mac\.entitlementsInherit=build\/entitlements\.adhoc\.plist/);
  assert.equal(scripts["dist:mac:local"], "npm run dist:mac:adhoc");
});

test("a manual run of the release workflow never publishes", async () => {
  const workflow = await fs.readFile(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
  assert.match(publish, /^ {4}if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)$/m);
  // The update key is only referenced by the publish job.
  assert.equal(workflow.indexOf("MNEMO_UPDATE_PRIVATE_KEY") > workflow.indexOf("\n  publish:\n"), true);
});

test("only ad-hoc builds may disable library validation", async () => {
  const { ALLOWED_ENTITLEMENTS, resolveMode } = require("../scripts/verify-mac-release");
  const plist = await fs.readFile(path.join(__dirname, "..", "build", "entitlements.adhoc.plist"), "utf8");
  const keys = Array.from(plist.matchAll(/<key>([^<]+)<\/key>/g), ([, key]) => key);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]);

  assert.deepEqual([...ALLOWED_ENTITLEMENTS.release], ["com.apple.security.cs.allow-jit"]);
  assert.deepEqual([...ALLOWED_ENTITLEMENTS.local], ["com.apple.security.cs.allow-jit"]);
  assert.deepEqual([...ALLOWED_ENTITLEMENTS["adhoc-release"]], keys);
  for (const allowed of Object.values(ALLOWED_ENTITLEMENTS)) {
    assert.equal(allowed.has("com.apple.security.cs.allow-dyld-environment-variables"), false);
    assert.equal(allowed.has("com.apple.security.get-task-allow"), false);
  }

  assert.equal(resolveMode({ env: {} }), "release");
  assert.equal(resolveMode({ env: { MNEMO_VERIFY_MODE: "adhoc-release" } }), "adhoc-release");
  assert.equal(resolveMode({ env: { MNEMO_LOCAL_TEST_BUILD: "1" } }), "local");
  assert.equal(resolveMode({ flags: ["--mode=adhoc-release"], env: { MNEMO_LOCAL_TEST_BUILD: "1" } }), "adhoc-release");
  assert.throws(() => resolveMode({ env: { MNEMO_VERIFY_MODE: "adhoc" } }), /Unknown verification mode/);
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
