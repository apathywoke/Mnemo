const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createPublicKey } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const config = require("../electron-builder.config");
const { makeTempDirectory } = require("../support/helpers");

test("release build disables Node entry points and enforces asar integrity", () => {
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(config.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(config.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  // The UI is served from app://mnemo/ (src/main/app-protocol.js).
  assert.equal(config.electronFuses.grantFileProtocolExtraPrivileges, false);
  assert.equal(config.asar, true);
  assert.equal(config.files.some((pattern) => /test|support|\.md$/.test(pattern)), false);
});

test("release verification requires the security fuses whatever the config says", () => {
  const { FuseState, FuseV1Options } = require("@electron/fuses");
  const { REQUIRED_FUSES, compareFuses } = require("../scripts/verify-mac-release");
  assert.equal(REQUIRED_FUSES.grantFileProtocolExtraPrivileges, false);
  for (const [name, required] of Object.entries(REQUIRED_FUSES)) {
    assert.equal(config.electronFuses[name], required, name);
  }

  const option = {
    runAsNode: FuseV1Options.RunAsNode,
    enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
    enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
    loadBrowserProcessSpecificV8Snapshot: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
  };
  const wireFor = (fuses) => Object.fromEntries(Object.entries(fuses).map(
    ([name, on]) => [option[name], on ? FuseState.ENABLE : FuseState.DISABLE],
  ));

  assert.deepEqual(compareFuses(wireFor(config.electronFuses)), []);
  // A binary built with file:// privileges on fails.
  assert.deepEqual(
    compareFuses(wireFor({ ...config.electronFuses, grantFileProtocolExtraPrivileges: true })),
    ["grantFileProtocolExtraPrivileges: expected DISABLE, found ENABLE"],
  );
  // So does a config that asks for them, even if the binary matches it.
  const relaxed = { ...config.electronFuses, grantFileProtocolExtraPrivileges: true };
  assert.deepEqual(compareFuses(wireFor(relaxed), relaxed), [
    "grantFileProtocolExtraPrivileges: electron-builder.config.js sets true, releases require false",
  ]);
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

// A v* tag on a commit that is not on main must not be published
// (docs/RELEASING.md, "GitHub settings").
test("the publish job checks that the tag's commit is on main before using the key", async () => {
  const workflow = await fs.readFile(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
  const checkoutAt = publish.indexOf("actions/checkout@");
  assert.match(publish.slice(checkoutAt, publish.indexOf("\n\n", checkoutAt)), /^ {10}fetch-depth: 0$/m);
  const checkAt = publish.indexOf("git merge-base --is-ancestor");
  assert.ok(checkAt > checkoutAt, "no ancestry check after the checkout");
  assert.match(publish, /git merge-base --is-ancestor "\$commit" origin\/main/);
  assert.match(publish.slice(checkAt), /::error::[^\n]*not on main[^\n]*\n\s*exit 1/);
  assert.ok(checkAt < publish.indexOf("MNEMO_UPDATE_PRIVATE_KEY"), "the check must run before the key is used");
  assert.ok(checkAt < publish.indexOf("gh release create"), "the check must run before publishing");
});

// Runs that step's script against a temporary "origin": a tag on main passes,
// a tag on a side branch fails with the error message.
test("the tag check passes a tag on main and stops a tag that is not on main", async (t) => {
  const workflow = await fs.readFile(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  const lines = workflow.split("\n");
  const runAt = lines.findIndex((line, index) => line.trim() === "run: |" && /- name: Check the tag is on main/.test(lines[index - 1] ?? ""));
  assert.ok(runAt > 0, "step not found");
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  const script = body.join("\n");

  const directory = await makeTempDirectory(t, "mnemo-tag-check-");
  // No user or system git configuration (signing, hooks, default branch).
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    GIT_CONFIG_GLOBAL: path.join(directory, "no-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = path.join(directory, "origin.git");
  const work = path.join(directory, "work");
  git(directory, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(directory, "clone", "--quiet", origin, work);
  git(work, "commit", "--quiet", "--allow-empty", "-m", "On main");
  git(work, "tag", "-a", "v1.0.0", "-m", "On main");
  git(work, "switch", "--quiet", "-c", "side");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "Only on a side branch");
  git(work, "tag", "-a", "v1.0.1", "-m", "Not on main");
  git(work, "push", "--quiet", "origin", "main", "side", "--tags");
  // Like actions/checkout with fetch-depth: 0.
  const ci = path.join(directory, "ci");
  git(directory, "clone", "--quiet", origin, ci);

  const runCheck = (tag) => spawnSync("bash", ["-e", "-c", script], { cwd: ci, env: { ...env, TAG: tag }, encoding: "utf8" });
  const onMain = runCheck("v1.0.0");
  assert.equal(onMain.status, 0, onMain.stderr);
  assert.match(onMain.stdout, /Tag v1\.0\.0 \([0-9a-f]{40}\) is on main\./);
  const offMain = runCheck("v1.0.1");
  assert.equal(offMain.status, 1);
  assert.match(offMain.stdout, /::error::Tag v1\.0\.1 points to [0-9a-f]{40}, which is not on main\./);
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

// Files under a folder, as paths relative to the repository root.
async function listFiles(root, folder) {
  const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const relative = `${folder}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, relative) : [relative];
  }));
  return nested.flat();
}

// Paths that only `npm start` uses; packaged builds do not need them.
const DEVELOPMENT_ONLY_PATHS = new Set([
  // The Dock icon for the stock Electron.app; a packaged app has its own.
  "build/icon.png",
]);

// Paths built from __dirname are relative to the file's folder, which is the
// same in the repository and inside app.asar (main.js's folder is the app
// root in both). So each one must exist here and, for code that ships, match
// `files`, or the packaged app would look in the wrong place. Moving a file
// to another folder breaks one of these checks.
test("every path built from __dirname exists, and is packaged when the code ships", async () => {
  const root = path.join(__dirname, "..");
  const shipped = ["main.js", "preload.js", ...(await listFiles(root, "src/main"))].filter((file) => file.endsWith(".js"));
  const scripts = (await listFiles(root, "scripts")).filter((file) => file.endsWith(".js"));
  const patterns = packagedPatterns();
  const literals = (args) => Array.from(args.matchAll(/"([^"]*)"/g), ([, part]) => part);
  const found = [];
  for (const file of [...shipped, ...scripts]) {
    const source = await fs.readFile(path.join(root, file), "utf8");
    const folder = path.dirname(path.join(root, file));
    // const NAME = path.join(__dirname, ...) can be used as a base later.
    const bases = new Map([["__dirname", folder]]);
    for (const [, name, args] of source.matchAll(/const ([A-Z_]+) = path\.join\(__dirname((?:, "[^"]*")*)\);/g)) {
      bases.set(name, path.join(folder, ...literals(args)));
    }
    let checked = 0;
    for (const [, base, args] of source.matchAll(/path\.join\((__dirname|[A-Z_]+)((?:, "[^"]*")+)\)/g)) {
      if (!bases.has(base)) continue;
      if (base === "__dirname") checked += 1;
      found.push({ file, target: path.join(bases.get(base), ...literals(args)), ships: shipped.includes(file) });
    }
    assert.equal((source.match(/__dirname/g) ?? []).length, checked, `${file} uses __dirname in a form this test does not check`);
  }

  for (const { file, target, ships } of found) {
    const relative = path.relative(root, target).split(path.sep).join("/");
    const stats = await fs.stat(target).catch(() => null);
    assert.ok(stats, `${file}: ${relative} does not exist`);
    if (!ships || relative === "" || DEVELOPMENT_ONLY_PATHS.has(relative)) continue;
    const packaged = stats.isDirectory()
      ? (await fs.readdir(target)).some((name) => patterns.some((pattern) => pattern.test(`${relative}/${name}`)))
      : patterns.some((pattern) => pattern.test(relative));
    assert.ok(packaged, `${file}: ${relative} is not in files`);
  }
  const targets = found.map(({ target }) => path.relative(root, target).split(path.sep).join("/"));
  for (const expected of ["build/update-keys", "index.html", "preload.js"]) {
    assert.ok(targets.includes(expected), `${expected} not found among ${targets.join(", ")}`);
  }
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

// electron-builder globs as regular expressions: "**/" is any number of
// folders, "*" one name part.
function packagedPatterns() {
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return config.files.map((pattern) => new RegExp(`^${pattern
    .split("**/")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join("(?:.*/)?")}$`));
}

// Every local module the main process or preload loads must be packaged,
// or the release build fails at startup.
test("release builds include every module that main and preload require", async () => {
  const root = path.join(__dirname, "..");
  const patterns = packagedPatterns();
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
  assert.ok(seen.has("src/main/backup-file.js") && seen.has("vault-store.js"));
});


// The page loads its scripts and styles by path, so a file moved out of
// src/renderer must still exist and be packaged.
test("every script and stylesheet the page loads exists and is packaged", async () => {
  const root = path.join(__dirname, "..");
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const assets = Array.from(
    html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/([^"]+)"/g),
    ([, file]) => file,
  );
  assert.ok(assets.includes("src/shared/password-tools.js") && assets.includes("styles.css"), assets.join(", "));
  const patterns = packagedPatterns();
  for (const file of assets) {
    await fs.access(path.join(root, file));
    assert.ok(patterns.some((pattern) => pattern.test(file)), `${file} is not in files`);
  }
});
