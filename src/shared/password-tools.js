// Password generation and the strength estimate. Shared by the renderer
// (import), which shows the estimate, and the main process (require), which
// enforces it for new master passphrases.
import { strengthDictionaries, KEYBOARD_GRAPHS } from "./strength/dictionaries.js";
import { createEstimator } from "./strength/estimator.js";
import { RUSSIAN_MATCHERS } from "./strength/russian.js";

const characterSets = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
};

function secureRandomInt(maxExclusive) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
    throw new RangeError("Random range is invalid.");
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure password generation is unavailable in this environment.");
  }

  const range = 0x100000000;
  const unbiasedLimit = Math.floor(range / maxExclusive) * maxExclusive;
  const sample = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(sample);
  } while (sample[0] >= unbiasedLimit);
  return sample[0] % maxExclusive;
}

function generatePassword(length, options = {}) {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new RangeError("Password length must be between 8 and 64 characters.");
  }

  const enabledSets = [characterSets.lowercase];
  if (options.uppercase !== false) enabledSets.push(characterSets.uppercase);
  if (options.numbers !== false) enabledSets.push(characterSets.numbers);
  if (options.symbols !== false) enabledSets.push(characterSets.symbols);

  const allCharacters = enabledSets.join("");
  const passwordCharacters = enabledSets.map((set) => set[secureRandomInt(set.length)]);
  while (passwordCharacters.length < length) {
    passwordCharacters.push(allCharacters[secureRandomInt(allCharacters.length)]);
  }

  for (let index = passwordCharacters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomInt(index + 1);
    [passwordCharacters[index], passwordCharacters[swapIndex]] =
      [passwordCharacters[swapIndex], passwordCharacters[index]];
  }

  return passwordCharacters.join("");
}

function estimateGeneratedPasswordStrength(length, options = {}) {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new RangeError("Password length must be between 8 and 64 characters.");
  }

  const enabledSets = [characterSets.lowercase];
  if (options.uppercase !== false) enabledSets.push(characterSets.uppercase);
  if (options.numbers !== false) enabledSets.push(characterSets.numbers);
  if (options.symbols !== false) enabledSets.push(characterSets.symbols);

  let score = 0;
  if (length >= 8) score += 1;
  if (length >= 12) score += 1;
  if (length >= 16) score += 1;
  if (length >= 20) score += 1;
  if (enabledSets.length >= 2) score += 1;
  if (enabledSets.length >= 3) score += 1;
  if (enabledSets.length === 4) score += 1;

  if (score >= 5) return { level: "strong", value: 3, label: "Strong" };
  if (score >= 3) return { level: "fair", value: 2, label: "Fair" };
  return { level: "weak", value: 1, label: "Weak" };
}

// The strength of a typed password: a zxcvbn-style estimate of the guesses
// an attacker needs (src/shared/strength/), with dictionaries of common
// passwords, English, German, and Russian words and names, and Russian
// typed in Cyrillic or in the wrong keyboard layout. zxcvbn's score (0–4)
// is shown as three levels:
// - weak: score 0–2, under 10^8 guesses (what Bitwarden reports as weak);
// - fair: score 3;
// - strong: score 4, at least 10^10 guesses, required for a new master
//   passphrase (src/main/vault/envelope.js).
let estimator = null;

function getEstimator() {
  estimator ??= createEstimator({
    dictionaries: strengthDictionaries(),
    graphs: KEYBOARD_GRAPHS,
    extraMatchers: RUSSIAN_MATCHERS,
  });
  return estimator;
}

const LEVELS = Object.freeze({
  weak: { level: "weak", value: 1, label: "Weak" },
  fair: { level: "fair", value: 2, label: "Fair" },
  strong: { level: "strong", value: 3, label: "Strong" },
});

// `userInputs`: text someone who knows the user would try first, such as
// the vault name; each is also tried word by word. `feedback` holds UI text
// keys ("strength.*").
/** @param {string} password @param {{ userInputs?: string[] }} [options] */
function estimatePasswordStrength(password, { userInputs = [] } = {}) {
  if (!password) {
    return { level: "empty", value: 0, label: "Enter a password", score: 0, feedback: { warning: "", suggestions: [] } };
  }
  const inputs = userInputs
    .filter((input) => typeof input === "string" && input.trim())
    .flatMap((input) => [input.trim(), ...input.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3)]);
  const result = getEstimator().estimate(password, inputs);
  const level = result.score === 4 ? LEVELS.strong : result.score === 3 ? LEVELS.fair : LEVELS.weak;
  return { ...level, score: result.score, guessesLog10: result.guessesLog10, feedback: result.feedback };
}

export {
  generatePassword,
  estimatePasswordStrength,
  estimateGeneratedPasswordStrength,
};
