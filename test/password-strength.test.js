// The password strength estimator (src/shared/strength/): the same results
// as zxcvbn 4.4.2 on zxcvbn's own dictionaries, Mnemo's dictionaries as
// generated, and the Russian matchers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zxcvbn = require("zxcvbn");
const zxcvbnLists = require("zxcvbn/lib/frequency_lists");
const zxcvbnGraphs = require("zxcvbn/lib/adjacency_graphs");
const { build, OUTPUT } = require("../scripts/make-strength-dictionaries");
const { createEstimator, MAX_ANALYZED_LENGTH } = require("../src/shared/strength/estimator.js");
const { transliterate } = require("../src/shared/strength/russian.js");
const { estimatePasswordStrength } = require("../src/shared/password-tools.js");
const { catalog } = require("../src/shared/i18n/messages.js");

// A small deterministic generator, so the corpus is the same on every run.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Passwords people choose and the tricks they use, plus random strings.
function corpus() {
  const next = random(20261102);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);
  const l33t = (word) => word.replace(/a/g, "@").replace(/o/g, "0").replace(/e/g, "3").replace(/s/g, "$");
  const reverse = (word) => word.split("").reverse().join("");
  const year = () => String(1950 + Math.floor(next() * 80));
  const { passwords, english_wikipedia: words, female_names: names, surnames } = zxcvbnLists;
  const common = passwords.slice(0, 3000);
  const result = [
    "", "a", "password", "Password1", "P@ssw0rd", "zxcvbn", "1qaz2wsx", "!QAZxsw2", "zaq1@WSX",
    "correct horse battery staple", "Tr0ub4dour&3", "aaaaaaaa", "abcabcabc", "abcdefg", "9876543",
    "1987", "12/25/1987", "19870525", "25.05.87", "1-1-2001", "asdfghjkl;'", "7896541230", "ZXCVBN",
    "hunter2", "letmein!", "qazwsxedc", "poiuytrewq", "1234567890-=", "!@#$%^&*()",
  ];
  const randomCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{};:,.?/ ";
  for (let index = 0; index < 400; index += 1) {
    result.push(
      pick(common),
      pick(common) + year(),
      capitalize(pick(common)) + "!",
      l33t(pick(common)),
      reverse(pick(common)),
      pick(words) + pick(words),
      `${pick(words)} ${pick(words)} ${pick(words)}`,
      capitalize(pick(names)) + Math.floor(next() * 100),
      pick(surnames).toUpperCase() + pick(["1", "12", "123", "!", ""]),
      pick(words).repeat(1 + Math.floor(next() * 3)),
      Array.from({ length: 6 + Math.floor(next() * 14) }, () => pick(randomCharacters)).join(""),
    );
  }
  return result;
}

test("on zxcvbn's own dictionaries the estimate equals zxcvbn 4.4.2's", () => {
  const kinds = {
    passwords: "passwords",
    english_wikipedia: "words",
    female_names: "names",
    male_names: "names",
    surnames: "names",
    us_tv_and_film: "other",
  };
  const estimator = createEstimator({
    dictionaries: Object.entries(zxcvbnLists).map(([name, words]) => ({ name, words, kind: kinds[name] })),
    graphs: zxcvbnGraphs,
    // zxcvbn 4.4.2 stops at 2019.
    recentYear: /19\d\d|200\d|201\d/,
  });
  const english = (key) => (key ? catalog.messages.en[key] : "");
  const passwords = corpus();
  assert.ok(passwords.length > 4000);
  for (const password of passwords) {
    const expected = zxcvbn(password);
    const actual = estimator.estimate(password);
    assert.equal(actual.guesses, expected.guesses, password);
    assert.equal(actual.score, expected.score, password);
    assert.deepEqual(
      { warning: english(actual.feedback.warning), suggestions: actual.feedback.suggestions.map(english) },
      { warning: expected.feedback.warning, suggestions: expected.feedback.suggestions },
      password,
    );
  }
});

test("the committed dictionaries are what the generator makes from the pinned packages", () => {
  for (const [name, contents] of Object.entries(build())) {
    assert.equal(fs.readFileSync(path.join(OUTPUT, name), "utf8"), contents, name);
  }
});

test("Russian is recognized in Cyrillic and typed with the wrong keyboard layout", () => {
  assert.equal(transliterate("который"), "kotoriy");
  assert.equal(transliterate("ещё"), "eschyo");
  assert.equal(transliterate("щука"), "schuka");
  const first = (password) => estimatePasswordStrength(password);
  for (const [password, warning] of [
    ["пароль", "strength.warning.common"], // Cyrillic, through "parol"
    ["зфыыцщкв", "strength.warning.topTen"], // "password" on the Russian layout
  ]) {
    assert.equal(first(password).level, "weak", password);
    assert.equal(first(password).feedback.warning, warning, password);
  }
  // "привет мир" typed on the English layout: Russian words, found as such.
  const greeting = first("ghbdtnvbh");
  assert.equal(greeting.level, "weak");
  assert.ok(greeting.feedback.suggestions.includes("strength.suggestion.otherLayout"));
  // Capitals in Cyrillic count like Latin ones, so "Пароль" is not stronger.
  assert.ok(first("Пароль").guessesLog10 < 3.5);
  assert.equal(first("корова летит над домом").level, "strong");
});

test("the vault name and recent years make a password easier to guess", () => {
  assert.equal(estimatePasswordStrength("Personal vault 2026").level, "strong");
  assert.equal(estimatePasswordStrength("Personal vault 2026", { userInputs: ["Personal vault"] }).level, "weak");
  // Years after zxcvbn's 2019 count as recent years too.
  assert.ok(estimatePasswordStrength("2024").guessesLog10 < 2);
});

test("long passwords are judged quickly by their first characters", () => {
  const started = performance.now();
  const result = estimatePasswordStrength("a".repeat(5000));
  assert.ok(performance.now() - started < 2000);
  assert.equal(result.level, "weak");
  assert.ok(MAX_ANALYZED_LENGTH >= 64);
  assert.equal(estimatePasswordStrength(`${"violet anchor quarry 47 mosaic ".repeat(10)}`).level, "strong");
});
