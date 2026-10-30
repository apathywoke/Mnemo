// The app:// scheme that serves the app's own page instead of file://. With
// file:// the page needed the grantFileProtocolExtraPrivileges fuse; app://
// serves only files from the app folder (app.asar when packaged), and only
// the kinds of files the page loads. src/main/window.js passes the folder.
const fs = require("node:fs/promises");
const path = require("node:path");

const APP_SCHEME = "app";
const APP_HOST = "mnemo";
const APP_PAGE_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// The page loads HTML, scripts, and one stylesheet; nothing else is served.
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
});

// Must run before the app is ready. `standard` gives app:// URLs a host and
// relative URLs; `secure` makes the page a secure context like file:// was.
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

// The page URL is app://mnemo/index.html and nothing else: no port, no user
// name, no other host. The query and fragment are ignored.
function isAppPageUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === `${APP_SCHEME}:` &&
      url.host === APP_HOST &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/index.html"
    );
  } catch {
    return false;
  }
}

// Maps an app:// URL to a file inside `root`, or returns null. The URL parser
// already removes plain "." and ".." segments; this also rejects encoded ones
// ("%2e%2e%2f"), encoded slashes and backslashes, NUL bytes, and anything
// that still resolves outside `root`.
function resolveAppFile(root, value) {
  let url;
  let relative;
  try {
    url = new URL(value);
    relative = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (relative.includes("\0") || relative.includes("\\")) return null;
  if (relative.split("/").some((segment) => segment === "..")) return null;

  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, `.${path.posix.normalize(relative)}`);
  const inside = path.relative(resolvedRoot, file);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (!Object.hasOwn(CONTENT_TYPES, path.extname(file).toLowerCase())) return null;
  return file;
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// The handler for protocol.handle(). Files are read with fs, which reads from
// app.asar in a packaged build without any file:// privileges.
function createAppFileHandler(root) {
  return async function handleAppRequest(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Method not allowed");
    }
    const file = resolveAppFile(root, request.url);
    if (!file) return textResponse(404, "Not found");

    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      return textResponse(404, "Not found");
    }
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()],
        "x-content-type-options": "nosniff",
      },
    });
  };
}

module.exports = {
  APP_SCHEME,
  APP_PAGE_URL,
  registerAppScheme,
  createAppFileHandler,
  resolveAppFile,
  isAppPageUrl,
};
