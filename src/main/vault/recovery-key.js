// Recovery keys: the text form with its checksum, and the key that wraps
// the vault key.
const {
  createHash,
  hkdfSync,
  timingSafeEqual,
} = require("node:crypto");
const {
  RECOVERY_KEY_BYTES,
  RECOVERY_CHECKSUM_BYTES,
  RECOVERY_ALPHABET,
  RECOVERY_KEY_CHARACTERS,
  RECOVERY_GROUP_SIZE,
  KEY_BYTES,
} = require("./constants");

function recoveryChecksum(keyBytes) {
  return createHash("sha256").update(keyBytes).digest().subarray(0, RECOVERY_CHECKSUM_BYTES);
}

function encodeRecoveryKey(keyBytes) {
  const bytes = Buffer.concat([keyBytes, recoveryChecksum(keyBytes)]);
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  bytes.fill(0);
  return text.match(new RegExp(`.{1,${RECOVERY_GROUP_SIZE}}`, "g")).join("-");
}

// Accepts any case, spaces, and dashes, and the usual look-alikes (O→0,
// I/L→1). The checksum catches typos before any decryption is attempted.
function decodeRecoveryKey(input) {
  const invalid = () => new Error("The recovery key is not valid. Check it and try again.");
  if (typeof input !== "string" || input.length > 200) throw invalid();
  const text = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (text.length !== RECOVERY_KEY_CHARACTERS) throw invalid();

  const bytes = Buffer.alloc(RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const character of text) {
    const digit = RECOVERY_ALPHABET.indexOf(character);
    if (digit === -1) throw invalid();
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }

  const keyBytes = Buffer.from(bytes.subarray(0, RECOVERY_KEY_BYTES));
  const checksum = bytes.subarray(RECOVERY_KEY_BYTES);
  const valid = timingSafeEqual(checksum, recoveryChecksum(keyBytes));
  bytes.fill(0);
  if (!valid) {
    keyBytes.fill(0);
    throw invalid();
  }
  return keyBytes;
}

// The recovery key already has 256 bits of entropy, so a fast KDF is enough.
function deriveRecoveryWrappingKey(recoveryKeyBytes, salt) {
  return Buffer.from(
    hkdfSync("sha256", recoveryKeyBytes, salt, "local-vault:recovery-wrap", KEY_BYTES),
  );
}

module.exports = {
  recoveryChecksum,
  encodeRecoveryKey,
  decodeRecoveryKey,
  deriveRecoveryWrappingKey,
};
