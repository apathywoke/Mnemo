(function exposePasswordTools(root) {
  const characterSets = {
    lowercase: "abcdefghijklmnopqrstuvwxyz",
    uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    numbers: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{}:,.?",
  };

  const commonFragments = [
    "password",
    "qwerty",
    "letmein",
    "welcome",
    "admin",
    "iloveyou",
    "monkey",
    "dragon",
    "sunshine",
    "football",
    "baseball",
    "master",
  ];

  function secureRandomInt(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
      throw new RangeError("Random range is invalid.");
    }

    if (!root.crypto?.getRandomValues) {
      throw new Error("Secure password generation is unavailable in this environment.");
    }

    const range = 0x100000000;
    const unbiasedLimit = Math.floor(range / maxExclusive) * maxExclusive;
    const sample = new Uint32Array(1);
    do {
      root.crypto.getRandomValues(sample);
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

  function hasObviousSequence(password) {
    const lowered = password.toLowerCase();
    const sequences = [
      "0123456789",
      "abcdefghijklmnopqrstuvwxyz",
      "qwertyuiop",
      "asdfghjkl",
      "zxcvbnm",
    ];

    for (const sequence of sequences) {
      const candidates = [sequence, [...sequence].reverse().join("")];
      if (candidates.some((candidate) => {
        for (let index = 0; index <= candidate.length - 4; index += 1) {
          if (lowered.includes(candidate.slice(index, index + 4))) return true;
        }
        return false;
      })) return true;
    }
    return false;
  }

  // Character groups for any script: lowercase (and letters without case,
  // such as CJK), uppercase, numbers, and everything else. For ASCII these
  // are exactly a-z, A-Z, 0-9, and the rest.
  const CHARACTER_GROUPS = [
    /[\p{Ll}\p{Lm}\p{Lo}]/u,
    /[\p{Lu}\p{Lt}]/u,
    /\p{N}/u,
    /[^\p{L}\p{N}]/u,
  ];

  // Smallest p such that the string repeats itself every p characters,
  // from the KMP prefix function: 3 for "abcabcab", the length for "abcd".
  function smallestPeriod(characters) {
    const prefix = new Array(characters.length).fill(0);
    for (let index = 1; index < characters.length; index += 1) {
      let matched = prefix[index - 1];
      while (matched > 0 && characters[index] !== characters[matched]) matched = prefix[matched - 1];
      if (characters[index] === characters[matched]) matched += 1;
      prefix[index] = matched;
    }
    return characters.length - prefix[characters.length - 1];
  }

  // Below this many different characters a password is weak at any length.
  const MIN_DISTINCT_CHARACTERS = 8;

  function estimatePasswordStrength(password) {
    if (!password) return { level: "empty", value: 0, label: "Enter a password" };

    // Length in code points, so "пароль" or an emoji counts as typed.
    const characters = Array.from(password);
    // One block repeated ("Ab1!Ab1!Ab1!") is only as long as the block, and
    // is weak however often it repeats.
    const period = smallestPeriod(characters);
    const repeated = period <= characters.length / 2;
    const length = repeated ? period : characters.length;
    let score = 0;
    if (length >= 8) score += 1;
    if (length >= 12) score += 1;
    if (length >= 16) score += 1;
    if (length >= 20) score += 1;

    const groups = CHARACTER_GROUPS.filter((group) => group.test(password)).length;
    if (groups >= 2) score += 1;
    if (groups >= 3) score += 1;
    if (groups === 4) score += 1;

    const lowered = password.toLowerCase();
    if (commonFragments.some((fragment) => lowered.includes(fragment))) score -= 4;
    if (/(.)\1{2,}/u.test(password)) score -= 2;
    if (hasObviousSequence(password)) score -= 2;

    if (repeated || new Set(characters).size < MIN_DISTINCT_CHARACTERS) {
      return { level: "weak", value: 1, label: "Weak" };
    }
    if (score >= 5) return { level: "strong", value: 3, label: "Strong" };
    if (score >= 3) return { level: "fair", value: 2, label: "Fair" };
    return { level: "weak", value: 1, label: "Weak" };
  }

  const api = {
    generatePassword,
    estimatePasswordStrength,
    estimateGeneratedPasswordStrength,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.passwordTools = api;
})(globalThis);
