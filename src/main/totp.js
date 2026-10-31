// Time-based one-time passwords (RFC 6238, built on HOTP from RFC 4226).
// Runs in the main process: secrets never reach the renderer, only the
// current code and when it expires.
const { createHmac } = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = Object.freeze({ SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" });
const MIN_SECRET_BYTES = 10;
const MAX_SECRET_BYTES = 128;
const MAX_INPUT_LENGTH = 2048;
const DEFAULTS = Object.freeze({ algorithm: "SHA1", digits: 6, period: 30 });

function invalid() {
  return new Error("Enter a valid one-time code secret or otpauth:// link.");
}

function decodeBase32(input) {
  const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (text.length === 0 || /[^A-Z2-7]/.test(text)) throw invalid();
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const character of text) {
    value = ((value << 5) | BASE32_ALPHABET.indexOf(character)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      text += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) text += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return text;
}

// Normalized form stored in the vault: the secret in canonical Base32 plus
// the parameters needed to compute codes. Labels are kept for display only.
function normalizeConfig({ secret, algorithm, digits, period, issuer = "", account = "" }) {
  const secretBytes = decodeBase32(secret);
  try {
    if (secretBytes.length < MIN_SECRET_BYTES || secretBytes.length > MAX_SECRET_BYTES) {
      throw invalid();
    }
    const normalizedAlgorithm = String(algorithm ?? DEFAULTS.algorithm).toUpperCase().replace("-", "");
    if (!Object.hasOwn(ALGORITHMS, normalizedAlgorithm)) throw invalid();
    const normalizedDigits = Number(digits ?? DEFAULTS.digits);
    const normalizedPeriod = Number(period ?? DEFAULTS.period);
    if (!Number.isInteger(normalizedDigits) || normalizedDigits < 6 || normalizedDigits > 8) {
      throw invalid();
    }
    if (!Number.isInteger(normalizedPeriod) || normalizedPeriod < 15 || normalizedPeriod > 300) {
      throw invalid();
    }
    return {
      secret: encodeBase32(secretBytes),
      algorithm: normalizedAlgorithm,
      digits: normalizedDigits,
      period: normalizedPeriod,
      issuer: String(issuer).slice(0, 200),
      account: String(account).slice(0, 200),
    };
  } finally {
    secretBytes.fill(0);
  }
}

// Accepts an otpauth://totp/ link (as encoded in setup QR codes) or a bare
// Base32 secret, which uses the common defaults (SHA-1, 6 digits, 30 s).
function parseTotpInput(input) {
  if (typeof input !== "string") throw invalid();
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) throw invalid();

  if (!/^otpauth:/i.test(text)) return normalizeConfig({ secret: text });

  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") {
    throw new Error("Only time-based (TOTP) codes are supported.");
  }
  const params = url.searchParams;
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [labelIssuer, labelAccount] = label.includes(":") ? label.split(/:(.*)/s) : ["", label];
  return normalizeConfig({
    secret: params.get("secret") ?? "",
    algorithm: params.get("algorithm") ?? undefined,
    digits: params.get("digits") ?? undefined,
    period: params.get("period") ?? undefined,
    issuer: params.get("issuer") ?? labelIssuer.trim(),
    account: (labelAccount ?? "").trim(),
  });
}

function toOtpauthUri(config) {
  const label = [config.issuer, config.account].filter(Boolean).map(encodeURIComponent).join(":") || "Mnemo";
  const params = new URLSearchParams({
    secret: config.secret,
    algorithm: config.algorithm,
    digits: String(config.digits),
    period: String(config.period),
  });
  if (config.issuer) params.set("issuer", config.issuer);
  return `otpauth://totp/${label}?${params}`;
}

function generateTotp(config, now = Date.now()) {
  const counter = Math.floor(now / 1000 / config.period);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const key = decodeBase32(config.secret);
  try {
    const digest = createHmac(ALGORITHMS[config.algorithm], key).update(counterBytes).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;
    const code = String(binary % 10 ** config.digits).padStart(config.digits, "0");
    return {
      code,
      period: config.period,
      expiresAt: (counter + 1) * config.period * 1000,
    };
  } finally {
    key.fill(0);
  }
}

module.exports = {
  decodeBase32,
  encodeBase32,
  generateTotp,
  parseTotpInput,
  toOtpauthUri,
};
