const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { makeTempDirectory } = require("../support/helpers");
const {
  APP_PAGE_URL,
  createAppFileHandler,
  isAppPageUrl,
  resolveAppFile,
} = require("../src/main/app-protocol");

async function makeAppFolder(t) {
  const parent = await makeTempDirectory(t, "mnemo-app-protocol-");
  const root = path.join(parent, "app");
  await fs.mkdir(path.join(root, "src", "renderer"), { recursive: true });
  await fs.writeFile(path.join(root, "index.html"), "<title>Mnemo</title>");
  await fs.writeFile(path.join(root, "styles.css"), "body {}");
  await fs.writeFile(path.join(root, "src", "renderer", "app.js"), "void 0;");
  await fs.writeFile(path.join(root, "notes.txt"), "not served");
  // Next to the app folder, and sharing its name as a prefix.
  await fs.writeFile(path.join(parent, "secret.js"), "secret");
  await fs.mkdir(path.join(parent, "app-other"));
  await fs.writeFile(path.join(parent, "app-other", "secret.js"), "secret");
  return root;
}

test("the app page URL is app://mnemo/index.html and nothing else", () => {
  assert.equal(APP_PAGE_URL, "app://mnemo/index.html");
  assert.equal(isAppPageUrl("app://mnemo/index.html"), true);
  assert.equal(isAppPageUrl("app://mnemo/index.html?x=1#top"), true);
  for (const url of [
    "file:///Applications/Mnemo.app/Contents/Resources/app.asar/index.html",
    "app://mnemo/other.html",
    "app://mnemo:8080/index.html",
    "app://user@mnemo/index.html",
    "app://mnemo.example/index.html",
    "https://mnemo/index.html",
    "not a url",
    undefined,
  ]) {
    assert.equal(isAppPageUrl(url), false, String(url));
  }
});

test("app:// paths resolve inside the app folder", async (t) => {
  const root = await makeAppFolder(t);
  assert.equal(resolveAppFile(root, "app://mnemo/index.html"), path.join(root, "index.html"));
  assert.equal(
    resolveAppFile(root, "app://mnemo/src/renderer/app.js?v=1"),
    path.join(root, "src", "renderer", "app.js"),
  );
  // Plain dot segments are removed by the URL parser and stay inside.
  assert.equal(resolveAppFile(root, "app://mnemo/src/../index.html"), path.join(root, "index.html"));
  assert.equal(resolveAppFile(root, "app://mnemo/../../index.html"), path.join(root, "index.html"));
  // So are percent-encoded dots when they form a whole segment.
  assert.equal(resolveAppFile(root, "app://mnemo/%2e%2e/%2E%2E/secret.js"), path.join(root, "secret.js"));
  // An encoded absolute path is still taken relative to the app folder.
  const outside = path.join(path.dirname(root), "secret.js");
  assert.equal(
    resolveAppFile(root, `app://mnemo/${encodeURIComponent(outside)}`),
    path.join(root, outside),
  );
});

test("path traversal out of the app folder is rejected", async (t) => {
  const root = await makeAppFolder(t);
  for (const url of [
    "app://mnemo/..%2fsecret.js",
    "app://mnemo/%2e%2e%2fsecret.js",
    "app://mnemo/src/..%2f..%2f..%2fsecret.js",
    "app://mnemo/..%2fapp-other/secret.js",
    "app://mnemo/..%5csecret.js",
    "app://mnemo/src%5c..%5c..%5csecret.js",
    "app://mnemo/index.html%00.js",
    "app://mnemo/%E0%A4%A",
    "app://other/index.html",
    "app://user:pass@mnemo/index.html",
    "file:///etc/passwd",
  ]) {
    assert.equal(resolveAppFile(root, url), null, url);
  }
});

test("only HTML, JavaScript, and CSS files are served", async (t) => {
  const root = await makeAppFolder(t);
  assert.equal(resolveAppFile(root, "app://mnemo/notes.txt"), null);
  assert.equal(resolveAppFile(root, "app://mnemo/package.json"), null);
  assert.equal(resolveAppFile(root, "app://mnemo/"), null);
  assert.equal(resolveAppFile(root, "app://mnemo/build/update-keys/key.pem"), null);
});

test("the handler serves app files with their type and refuses the rest", async (t) => {
  const root = await makeAppFolder(t);
  const handle = createAppFileHandler(root);

  const page = await handle(new Request("app://mnemo/index.html"));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await page.text(), "<title>Mnemo</title>");

  const script = await handle(new Request("app://mnemo/src/renderer/app.js"));
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const style = await handle(new Request("app://mnemo/styles.css"));
  assert.equal(style.headers.get("content-type"), "text/css; charset=utf-8");

  for (const url of ["app://mnemo/..%2fsecret.js", "app://mnemo/missing.js", "app://mnemo/notes.txt", "app://mnemo/src.js"]) {
    const response = await handle(new Request(url));
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), "Not found");
  }
  // A folder whose name looks like a file is not a file.
  await fs.mkdir(path.join(root, "folder.js"));
  assert.equal((await handle(new Request("app://mnemo/folder.js"))).status, 404);

  assert.equal((await handle(new Request("app://mnemo/index.html", { method: "POST", body: "x" }))).status, 405);
  const head = await handle(new Request("app://mnemo/index.html", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
