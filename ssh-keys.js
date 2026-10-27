// SSH key helpers for the main process: derive the public key from a private
// key where possible, and compute OpenSSH-style SHA256 fingerprints.
const { createHash, createPublicKey } = require("node:crypto");

const PUBLIC_KEY_PATTERN = /^((?:ssh|ecdsa|sk)-[a-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/;

function sshString(buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

// SSH mpint: big-endian, with a leading zero when the high bit is set.
function sshMpint(buffer) {
  let bytes = buffer;
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return sshString(bytes);
}

function readString(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error("truncated");
  const length = buffer.readUInt32BE(offset);
  const end = offset + 4 + length;
  if (end > buffer.length) throw new Error("truncated");
  return { value: buffer.subarray(offset + 4, end), next: end };
}

function parsePublicKey(text) {
  const match = String(text).trim().match(PUBLIC_KEY_PATTERN);
  if (!match) return null;
  const blob = Buffer.from(match[2], "base64");
  try {
    const { value } = readString(blob, 0);
    if (value.toString("ascii") !== match[1]) return null;
  } catch {
    return null;
  }
  return { keyType: match[1], blob, comment: match[3] ?? "" };
}

function fingerprintOf(blob) {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

// OpenSSH private keys keep the public key in clear text, even when the
// private part is encrypted.
function publicBlobFromOpenSsh(privateKey) {
  const body = privateKey
    .replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const data = Buffer.from(body, "base64");
  const magic = Buffer.from("openssh-key-v1\0");
  if (!data.subarray(0, magic.length).equals(magic)) return null;
  let offset = magic.length;
  offset = readString(data, offset).next; // cipher name
  offset = readString(data, offset).next; // kdf name
  offset = readString(data, offset).next; // kdf options
  if (offset + 4 > data.length || data.readUInt32BE(offset) < 1) return null;
  offset += 4;
  return readString(data, offset).value;
}

// PEM keys (PKCS#8, PKCS#1, SEC1) through Node's crypto; encrypted PEM keys
// cannot be read without their passphrase.
function publicBlobFromPem(privateKey, passphrase) {
  const key = createPublicKey({ key: privateKey, format: "pem", passphrase: passphrase || undefined });
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.from(jwk.x, "base64url"))]);
  }
  if (jwk.kty === "RSA") {
    return Buffer.concat([
      sshString(Buffer.from("ssh-rsa")),
      sshMpint(Buffer.from(jwk.e, "base64url")),
      sshMpint(Buffer.from(jwk.n, "base64url")),
    ]);
  }
  const curves = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" };
  if (jwk.kty === "EC" && curves[jwk.crv]) {
    const name = curves[jwk.crv];
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    return Buffer.concat([
      sshString(Buffer.from(`ecdsa-sha2-${name}`)),
      sshString(Buffer.from(name)),
      sshString(point),
    ]);
  }
  return null;
}

function isPrivateKey(text) {
  return /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/.test(String(text).trim());
}

// Returns { publicKey, keyType, fingerprint } for whatever can be learned
// from the inputs; fields are empty when nothing can be derived.
function describeSshKey({ privateKey = "", publicKey = "", passphrase = "" }) {
  let parsed = publicKey.trim() ? parsePublicKey(publicKey) : null;
  if (publicKey.trim() && !parsed) throw new Error("Enter a valid OpenSSH public key.");

  if (!parsed && privateKey.trim()) {
    let blob = null;
    try {
      blob = /OPENSSH PRIVATE KEY/.test(privateKey)
        ? publicBlobFromOpenSsh(privateKey)
        : publicBlobFromPem(privateKey, passphrase);
    } catch {
      blob = null;
    }
    if (blob) {
      const keyType = readString(blob, 0).value.toString("ascii");
      parsed = { keyType, blob, comment: "" };
      publicKey = `${keyType} ${blob.toString("base64")}`;
    }
  }

  return parsed
    ? { publicKey: publicKey.trim(), keyType: parsed.keyType, fingerprint: fingerprintOf(parsed.blob) }
    : { publicKey: publicKey.trim(), keyType: "", fingerprint: "" };
}

module.exports = { describeSshKey, isPrivateKey, parsePublicKey, fingerprintOf };
