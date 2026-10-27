const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeBase32, generateTotp, parseTotpInput, toOtpauthUri } = require("../totp");

// RFC 6238 appendix B: 8-digit codes for three algorithms at six times.
const SECRETS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890".repeat(6) + "1234",
};
const VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("codes match the RFC 6238 test vectors", () => {
  for (const [seconds, ...codes] of VECTORS) {
    ["SHA1", "SHA256", "SHA512"].forEach((algorithm, index) => {
      const config = { secret: encodeBase32(Buffer.from(SECRETS[algorithm])), algorithm, digits: 8, period: 30 };
      assert.equal(generateTotp(config, seconds * 1000).code, codes[index], `${algorithm} @ ${seconds}`);
    });
  }
});

test("codes report their expiry and keep leading zeros", () => {
  const config = parseTotpInput(encodeBase32(Buffer.from(SECRETS.SHA1)));
  assert.deepEqual(generateTotp(config, 59_000), { code: "287082", period: 30, expiresAt: 60_000 });
  const eight = { ...config, digits: 8 };
  assert.equal(generateTotp(eight, 1111111109_000).code, "07081804");
});

test("otpauth links and bare secrets are parsed and normalized", () => {
  assert.deepEqual(
    parseTotpInput("otpauth://totp/ACME%20Co:john@example.com?secret=jbswy3dpehpk3pxp&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60"),
    { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60, issuer: "ACME Co", account: "john@example.com" },
  );
  assert.deepEqual(parseTotpInput("  jbsw y3dp ehpk 3pxp  "), {
    secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30, issuer: "", account: "",
  });
  const config = parseTotpInput("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example");
  assert.deepEqual(parseTotpInput(toOtpauthUri(config)), config);
});

test("invalid secrets and parameters are rejected", () => {
  for (const input of [
    "",
    "not base32 1!",
    "JBSWY3DP",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=10",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=5",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5",
    "otpauth://totp/x",
    "x".repeat(3000),
  ]) {
    assert.throws(() => parseTotpInput(input), /valid one-time code secret/, input.slice(0, 40));
  }
  assert.throws(() => parseTotpInput("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1"), /Only time-based/);
  assert.throws(() => parseTotpInput(42), /valid one-time code secret/);
});
