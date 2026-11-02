// Runs the Touch ID helper (native/touch-id/main.swift): one process per
// request, one JSON request on stdin, one JSON reply on stdout. The protocol
// is described in the helper's source and in docs/THREAT_MODEL.md.
const { spawn } = require("node:child_process");

const MAX_REPLY_BYTES = 16 * 1024;
// Long enough for the user to find the sensor; a short request needs less.
const PROMPT_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 15_000;

// `helperPath`: the binary, inside the app bundle (or build/native/ for
// `npm start`). Resolves with the reply; a helper that cannot start (missing,
// or built for a newer macOS) replies { error: "unavailable" }.
function createTouchIdHelper(helperPath) {
  function run(request, { timeoutMs = request.command === "agree" ? PROMPT_TIMEOUT_MS : QUICK_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reply);
      };
      let child;
      try {
        // No shell and no inherited environment: the helper needs neither.
        child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"], env: {}, shell: false });
      } catch {
        finish({ error: "unavailable" });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ error: "failed" });
      }, timeoutMs);
      const chunks = [];
      let received = 0;
      child.stdout.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_REPLY_BYTES) {
          child.kill("SIGKILL");
          finish({ error: "failed" });
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finish({ error: "unavailable" }));
      child.on("close", () => {
        const output = Buffer.concat(chunks);
        try {
          const reply = JSON.parse(output.toString("utf8"));
          finish(reply !== null && typeof reply === "object" && !Array.isArray(reply) ? reply : { error: "failed" });
        } catch {
          finish({ error: "failed" });
        } finally {
          output.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }

  return { run };
}

module.exports = { MAX_REPLY_BYTES, createTouchIdHelper };
