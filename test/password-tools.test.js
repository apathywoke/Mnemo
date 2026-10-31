const assert = require("node:assert/strict");
const test = require("node:test");
const {
  estimateGeneratedPasswordStrength,
  estimatePasswordStrength,
  generatePassword,
} = require("../src/shared/password-tools");

test("password generation honors length and enabled character groups", () => {
  const password = generatePassword(32, {
    uppercase: true,
    numbers: true,
    symbols: true,
  });

  assert.equal(password.length, 32);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /\d/);
  assert.match(password, /[^a-zA-Z0-9]/);
});

test("password generation always uses lowercase and excludes disabled groups", () => {
  const password = generatePassword(24, {
    uppercase: false,
    numbers: false,
    symbols: false,
  });

  assert.equal(password.length, 24);
  assert.match(password, /^[a-z]+$/);
});

test("password generation enforces the supported length range", () => {
  assert.throws(() => generatePassword(7), /between 8 and 64/);
  assert.throws(() => generatePassword(65), /between 8 and 64/);
});

test("strength estimate distinguishes weak, fair, and strong passwords", () => {
  assert.deepEqual(estimatePasswordStrength(""), {
    level: "empty",
    value: 0,
    label: "Enter a password",
  });
  assert.equal(estimatePasswordStrength("password123!").level, "weak");
  assert.equal(estimatePasswordStrength("tealRiver82").level, "fair");
  assert.equal(estimatePasswordStrength("8T!cL4m@Q2v#n6Wx").level, "strong");
});

test("one block repeated, or fewer than 8 different characters, is weak", () => {
  for (const password of ["Ab1!Ab1!Ab1!", "Mnemo-Mnemo-Mnemo", "abcabcabcabc"]) {
    assert.equal(estimatePasswordStrength(password).level, "weak", password);
  }
  for (const password of ["correct horse battery staple", "Tr0ub4dor&3x", "корова летит над домом"]) {
    assert.equal(estimatePasswordStrength(password).level, "strong", password);
  }
  // Each rule on its own: a repeated block with 11 different characters, and
  // 4 different characters without a repeated block.
  assert.equal(estimatePasswordStrength("Tr0ub4dor&3xTr0ub4dor&3x").level, "weak");
  assert.equal(estimatePasswordStrength("Aa1!Aa1!aA1!").level, "weak");
});

test("generated password estimate reflects length and selected character groups", () => {
  assert.equal(
    estimateGeneratedPasswordStrength(8, {
      uppercase: false,
      numbers: false,
      symbols: false,
    }).level,
    "weak",
  );
  assert.equal(
    estimateGeneratedPasswordStrength(8, {
      uppercase: true,
      numbers: true,
      symbols: true,
    }).level,
    "fair",
  );
  assert.equal(
    estimateGeneratedPasswordStrength(12, {
      uppercase: true,
      numbers: true,
      symbols: true,
    }).level,
    "strong",
  );
  assert.throws(() => estimateGeneratedPasswordStrength(65), /between 8 and 64/);
});
