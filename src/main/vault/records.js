// Checks shared by the record validators: plain objects, exact key sets,
// and bounded base64.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function decodeBase64(value, expectedLength, maxLength = expectedLength) {
  if (typeof value !== "string") throw new Error("Invalid vault file");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.length < expectedLength ||
    decoded.length > maxLength
  ) {
    throw new Error("Invalid vault file");
  }
  return decoded;
}

module.exports = {
  isPlainObject,
  hasExactKeys,
  decodeBase64,
};
