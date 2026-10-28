const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { buildReport, checkPwnedHashes, collectPasswords, parseRange } = require("../password-health");

const sha1 = (text) => createHash("sha1").update(text).digest("hex").toUpperCase();
const KEY = Buffer.alloc(32, 7);

function fakeStore(entries) {
  return {
    listEntries: () => entries.map(({ password, ...summary }) => summary),
    revealPassword(id) {
      const entry = entries.find((item) => item.id === id);
      if (entry.password instanceof Error) throw entry.password;
      return entry.password;
    },
  };
}

const ENTRIES = [
  { id: "a", type: "login", name: "Mail", password: "correct-horse-battery-staple-91!" },
  { id: "b", type: "login", name: "Shop", password: "correct-horse-battery-staple-91!" },
  { id: "c", type: "login", name: "Forum", password: "password123" },
  { id: "d", type: "login", name: "Old", password: "" },
  { id: "e", type: "login", name: "Broken", password: new Error("Could not decrypt this password.") },
  { id: "f", type: "card", name: "Visa" },
  { id: "g", type: "login", name: "Bank", password: "Zq8#vN2!pL5@xR7k" },
];

test("finds weak and reused passwords locally, skipping other items", () => {
  const passwords = collectPasswords(fakeStore(ENTRIES), KEY);
  assert.deepEqual(passwords.map((password) => password.id), ["a", "b", "c", "g"]);
  assert.equal(passwords[0].sha1, sha1("correct-horse-battery-staple-91!"));
  // Nothing in the collected data is the password itself.
  assert.equal(JSON.stringify(passwords).includes("correct-horse"), false);

  const report = buildReport(passwords);
  assert.equal(report.total, 4);
  assert.deepEqual(report.weak, ["c"]);
  assert.deepEqual(report.reused, [["a", "b"]]);
  assert.equal(report.breached, null);
  assert.equal(report.breachCheckedAt, null);
  // Only IDs and counts go to the renderer.
  assert.equal(/sha1|fingerprint|correct-horse/.test(JSON.stringify(report)), false);
});

test("fingerprints depend on the per-unlock key", () => {
  const store = fakeStore(ENTRIES);
  const [first] = collectPasswords(store, KEY);
  const [second] = collectPasswords(store, Buffer.alloc(32, 8));
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("breach results are matched by fingerprint, so changed passwords count as unchecked", () => {
  const passwords = collectPasswords(fakeStore(ENTRIES), KEY);
  const byId = Object.fromEntries(passwords.map((password) => [password.id, password.fingerprint]));
  const breaches = new Map([[byId.a, 0], [byId.c, 120000]]);
  const report = buildReport(passwords, { breaches, checkedAt: 1234 });
  assert.deepEqual(report.breached, [{ id: "c", count: 120000 }]);
  assert.equal(report.breachCheckedAt, 1234);
  // "g" was not part of the check (for example, changed afterwards).
  assert.equal(report.breachUnchecked, 1);
});

test("range responses are parsed, including padding and CRLF", () => {
  const counts = parseRange(
    "0018A45C4D1DEF81644B54AB7F969B88D65:10\r\n" +
    "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n" +
    "garbage line\r\n" +
    "011053FD0102E94D6AE2F8B83D76FAF94F6:3",
  );
  assert.equal(counts.get("0018A45C4D1DEF81644B54AB7F969B88D65"), 10);
  assert.equal(counts.get("00D4F6E8FA6EECAD2A3AA415EEC418D38EC"), 0);
  assert.equal(counts.size, 3);
});

test("only 5-character prefixes are sent, once per prefix", async () => {
  const weak = sha1("password123");
  const strong = sha1("Zq8#vN2!pL5@xR7k");
  const twin = `${weak.slice(0, 5)}${"0".repeat(35)}`;
  const requests = [];
  const get = async (prefix) => {
    requests.push(prefix);
    if (prefix === weak.slice(0, 5)) return `${weak.slice(5)}:251682\r\n${"F".repeat(35)}:0`;
    return `${"A".repeat(35)}:4`;
  };
  const results = await checkPwnedHashes([weak, strong, weak, twin], { get });
  assert.deepEqual(requests.sort(), [weak.slice(0, 5), strong.slice(0, 5)].sort());
  assert.ok(requests.every((prefix) => /^[0-9A-F]{5}$/.test(prefix)));
  assert.equal(results.get(weak), 251682);
  assert.equal(results.get(strong), 0);
  assert.equal(results.get(twin), 0);
  await assert.rejects(checkPwnedHashes(["not-a-hash"], { get }), /Invalid password hash/);
  assert.equal((await checkPwnedHashes([], { get })).size, 0);
});

test("a failed range request fails the whole check", async () => {
  const get = async () => {
    throw new Error("Could not reach Have I Been Pwned.");
  };
  await assert.rejects(checkPwnedHashes([sha1("x")], { get }), /Could not reach Have I Been Pwned/);
});
