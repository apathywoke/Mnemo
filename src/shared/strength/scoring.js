// How many guesses each kind of match costs an attacker, and the cheapest
// way to cover the whole password with matches. A port of zxcvbn 4.4.2's
// scoring (MIT, Dropbox; https://github.com/dropbox/zxcvbn), kept to the
// same numbers so test/password-strength.test.js can compare the two.

const BRUTEFORCE_CARDINALITY = 10;
const MIN_GUESSES_BEFORE_GROWING_SEQUENCE = 10000;
const MIN_SUBMATCH_GUESSES_SINGLE_CHAR = 10;
const MIN_SUBMATCH_GUESSES_MULTI_CHAR = 50;
const MIN_YEAR_SPACE = 20;
const REFERENCE_YEAR = new Date().getFullYear();

// Letter case for any script, so a capitalized Cyrillic word counts like a
// capitalized Latin one. For ASCII these match zxcvbn's [A-Z] and [a-z].
const START_UPPER = /^\p{Lu}[^\p{Lu}]+$/u;
const END_UPPER = /^[^\p{Lu}]+\p{Lu}$/u;
const ALL_UPPER = /^[^\p{Ll}]+$/u;
const ALL_LOWER = /^[^\p{Lu}]+$/u;

function nCk(n, k) {
  if (k > n) return 0;
  if (k === 0) return 1;
  let result = 1;
  let remaining = n;
  for (let d = 1; d <= k; d += 1) {
    result *= remaining;
    result /= d;
    remaining -= 1;
  }
  return result;
}

function log10(n) {
  return Math.log(n) / Math.log(10);
}

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

function averageDegree(graph) {
  const keys = Object.keys(graph);
  let total = 0;
  for (const key of keys) total += graph[key].filter(Boolean).length;
  return total / keys.length;
}

function createScoring(graphs) {
  const keyboardStarts = Object.keys(graphs.qwerty).length;
  const keyboardDegree = averageDegree(graphs.qwerty);
  const keypadStarts = Object.keys(graphs.keypad).length;
  const keypadDegree = averageDegree(graphs.keypad);

  function bruteforceGuesses(match) {
    let guesses = BRUTEFORCE_CARDINALITY ** match.token.length;
    if (guesses === Number.POSITIVE_INFINITY) guesses = Number.MAX_VALUE;
    const minimum = match.token.length === 1
      ? MIN_SUBMATCH_GUESSES_SINGLE_CHAR + 1
      : MIN_SUBMATCH_GUESSES_MULTI_CHAR + 1;
    return Math.max(guesses, minimum);
  }

  function repeatGuesses(match) {
    return match.baseGuesses * match.repeatCount;
  }

  function sequenceGuesses(match) {
    const first = match.token.charAt(0);
    let base;
    if (["a", "A", "z", "Z", "0", "1", "9"].includes(first)) base = 4;
    else if (/\d/.test(first)) base = 10;
    else base = 26;
    if (!match.ascending) base *= 2;
    return base * match.token.length;
  }

  function regexGuesses(match) {
    if (match.regexName === "recentYear") {
      return Math.max(Math.abs(Number.parseInt(match.regexMatch[0], 10) - REFERENCE_YEAR), MIN_YEAR_SPACE);
    }
    return 0;
  }

  function dateGuesses(match) {
    const yearSpace = Math.max(Math.abs(match.year - REFERENCE_YEAR), MIN_YEAR_SPACE);
    return yearSpace * 365 * (match.separator ? 4 : 1);
  }

  function spatialGuesses(match) {
    const keyboard = match.graph === "qwerty" || match.graph === "dvorak";
    const starts = keyboard ? keyboardStarts : keypadStarts;
    const degree = keyboard ? keyboardDegree : keypadDegree;
    let guesses = 0;
    const length = match.token.length;
    for (let i = 2; i <= length; i += 1) {
      const possibleTurns = Math.min(match.turns, i - 1);
      for (let j = 1; j <= possibleTurns; j += 1) {
        guesses += nCk(i - 1, j - 1) * starts * degree ** j;
      }
    }
    if (match.shiftedCount) {
      const shifted = match.shiftedCount;
      const unshifted = match.token.length - match.shiftedCount;
      if (shifted === 0 || unshifted === 0) {
        guesses *= 2;
      } else {
        let variations = 0;
        for (let i = 1; i <= Math.min(shifted, unshifted); i += 1) variations += nCk(shifted + unshifted, i);
        guesses *= variations;
      }
    }
    return guesses;
  }

  function uppercaseVariations(match) {
    const word = match.token;
    if (ALL_LOWER.test(word) || word.toLowerCase() === word) return 1;
    for (const pattern of [START_UPPER, END_UPPER, ALL_UPPER]) {
      if (pattern.test(word)) return 2;
    }
    const upper = [...word].filter((character) => /\p{Lu}/u.test(character)).length;
    const lower = [...word].filter((character) => /\p{Ll}/u.test(character)).length;
    let variations = 0;
    for (let i = 1; i <= Math.min(upper, lower); i += 1) variations += nCk(upper + lower, i);
    return variations;
  }

  function l33tVariations(match) {
    if (!match.l33t) return 1;
    let variations = 1;
    for (const [subbed, unsubbed] of Object.entries(match.sub)) {
      const characters = match.token.toLowerCase().split("");
      const subbedCount = characters.filter((character) => character === subbed).length;
      const unsubbedCount = characters.filter((character) => character === unsubbed).length;
      if (subbedCount === 0 || unsubbedCount === 0) {
        variations *= 2;
      } else {
        let possibilities = 0;
        for (let i = 1; i <= Math.min(unsubbedCount, subbedCount); i += 1) {
          possibilities += nCk(unsubbedCount + subbedCount, i);
        }
        variations *= possibilities;
      }
    }
    return variations;
  }

  // A word typed with the other keyboard layout (src/shared/strength/
  // russian.js) is one more thing to try: twice the guesses.
  function dictionaryGuesses(match) {
    match.baseGuesses = match.rank;
    match.uppercaseVariations = uppercaseVariations(match);
    match.l33tVariations = l33tVariations(match);
    const reversed = match.reversed ? 2 : 1;
    const layout = match.layout ? 2 : 1;
    return match.baseGuesses * match.uppercaseVariations * match.l33tVariations * reversed * layout;
  }

  const ESTIMATORS = {
    bruteforce: bruteforceGuesses,
    dictionary: dictionaryGuesses,
    spatial: spatialGuesses,
    repeat: repeatGuesses,
    sequence: sequenceGuesses,
    regex: regexGuesses,
    date: dateGuesses,
  };

  function estimateGuesses(match, password) {
    if (match.guesses !== undefined) return match.guesses;
    let minimum = 1;
    if (match.token.length < password.length) {
      minimum = match.token.length === 1 ? MIN_SUBMATCH_GUESSES_SINGLE_CHAR : MIN_SUBMATCH_GUESSES_MULTI_CHAR;
    }
    match.guesses = Math.max(ESTIMATORS[match.pattern](match), minimum);
    match.guessesLog10 = log10(match.guesses);
    return match.guesses;
  }

  // The match sequence that covers the password with the fewest guesses
  // (dynamic programming over the end position and the number of matches).
  // Plain objects keyed by sequence length keep zxcvbn's iteration order.
  function mostGuessableMatchSequence(password, matches, excludeAdditive = false) {
    const n = password.length;
    /** @type {any[][]} */
    const matchesByEnd = Array.from({ length: n }, () => []);
    for (const match of matches) matchesByEnd[match.j].push(match);
    for (const list of matchesByEnd) list.sort((left, right) => left.i - right.i);

    const optimal = {
      m: Array.from({ length: n }, () => ({})),
      pi: Array.from({ length: n }, () => ({})),
      g: Array.from({ length: n }, () => ({})),
    };

    function update(match, length) {
      const k = match.j;
      let pi = estimateGuesses(match, password);
      if (length > 1) pi *= optimal.pi[match.i - 1][length - 1];
      let g = factorial(length) * pi;
      if (!excludeAdditive) g += MIN_GUESSES_BEFORE_GROWING_SEQUENCE ** (length - 1);
      for (const [competingLength, competingG] of Object.entries(optimal.g[k])) {
        if (Number(competingLength) > length) continue;
        if (competingG <= g) return;
      }
      optimal.g[k][length] = g;
      optimal.m[k][length] = match;
      optimal.pi[k][length] = pi;
    }

    const bruteforceMatch = (i, j) => ({ pattern: "bruteforce", token: password.slice(i, j + 1), i, j });

    function bruteforceUpdate(k) {
      update(bruteforceMatch(0, k), 1);
      for (let i = 1; i <= k; i += 1) {
        const match = bruteforceMatch(i, k);
        for (const [length, last] of Object.entries(optimal.m[i - 1])) {
          if (last.pattern === "bruteforce") continue;
          update(match, Number(length) + 1);
        }
      }
    }

    function unwind() {
      /** @type {any[]} */
      const sequence = [];
      let k = n - 1;
      let length = 0;
      let best = Infinity;
      for (const [candidateLength, candidateG] of Object.entries(optimal.g[k])) {
        if (candidateG < best) {
          length = Number(candidateLength);
          best = candidateG;
        }
      }
      while (k >= 0) {
        const match = optimal.m[k][length];
        sequence.unshift(match);
        k = match.i - 1;
        length -= 1;
      }
      return sequence;
    }

    for (let k = 0; k < n; k += 1) {
      for (const match of matchesByEnd[k]) {
        if (match.i > 0) {
          for (const length of Object.keys(optimal.m[match.i - 1])) update(match, Number(length) + 1);
        } else {
          update(match, 1);
        }
      }
      bruteforceUpdate(k);
    }
    const sequence = n === 0 ? [] : unwind();
    const guesses = n === 0 ? 1 : optimal.g[n - 1][sequence.length];
    return { guesses, guessesLog10: log10(guesses), sequence };
  }

  return { estimateGuesses, mostGuessableMatchSequence };
}

function guessesToScore(guesses) {
  const DELTA = 5;
  if (guesses < 1e3 + DELTA) return 0;
  if (guesses < 1e6 + DELTA) return 1;
  if (guesses < 1e8 + DELTA) return 2;
  if (guesses < 1e10 + DELTA) return 3;
  return 4;
}

export {
  ALL_UPPER,
  REFERENCE_YEAR,
  START_UPPER,
  createScoring,
  guessesToScore,
};
