const assert = require("node:assert/strict");
const test = require("node:test");
const {
  estimateGeneratedPasswordStrength,
  estimatePasswordStrength,
  generatePassword,
} = require("../src/shared/password-tools.js");

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
    score: 0,
    feedback: { warning: "", suggestions: [] },
  });
  // Levels follow the estimate's score: 0–2 weak, 3 fair, 4 strong.
  assert.deepEqual(
    ["password123!", "tealRiver82", "8T!cL4m@Q2v#n6Wx"].map((password) => {
      const { level, value, score } = estimatePasswordStrength(password);
      return [level, value, score];
    }),
    [["weak", 1, 1], ["fair", 2, 3], ["strong", 3, 4]],
  );
});

test("repeats, sequences, keyboard rows, and common passwords are weak however long", () => {
  for (const password of ["Ab1!Ab1!Ab1!", "abcabcabcabc", "aaaaaaaaaaaaaaaaaaaa", "abcdefghijkl", "qwertyuiop12", "iloveyou123456"]) {
    assert.equal(estimatePasswordStrength(password).level, "weak", password);
  }
  for (const password of ["correct horse battery staple", "Tr0ub4dor&3x", "корова летит над домом"]) {
    assert.equal(estimatePasswordStrength(password).level, "strong", password);
  }
  assert.equal(estimatePasswordStrength("abcabcabcabc").feedback.warning, "strength.warning.repeatedText");
  assert.equal(estimatePasswordStrength("password").feedback.warning, "strength.warning.topTen");
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
