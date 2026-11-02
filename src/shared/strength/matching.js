// Finds every part of a password an attacker would guess as a unit:
// dictionary words (also reversed and with l33t substitutions), keyboard
// patterns, repeats, sequences, recent years, and dates. A port of zxcvbn
// 4.4.2's matching (MIT, Dropbox), with the dictionaries passed in and room
// for extra matchers (src/shared/strength/russian.js).

const L33T_TABLE = Object.freeze({
  a: ["4", "@"],
  b: ["8"],
  c: ["(", "{", "[", "<"],
  e: ["3"],
  g: ["6", "9"],
  i: ["1", "!", "|"],
  l: ["1", "|", "7"],
  o: ["0"],
  s: ["$", "5"],
  t: ["+", "7"],
  x: ["%"],
  z: ["2"],
});

const DATE_MAX_YEAR = 2050;
const DATE_MIN_YEAR = 1000;
const DATE_SPLITS = Object.freeze({
  4: [[1, 2], [2, 3]],
  5: [[1, 3], [2, 3]],
  6: [[1, 2], [2, 4], [4, 5]],
  7: [[1, 3], [2, 3], [4, 5], [4, 6]],
  8: [[2, 4], [4, 6]],
});
const SHIFTED_RX = /[~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:"ZXCVBNM<>?]/;
const MAX_DELTA = 5;

function sorted(matches) {
  return matches.sort((left, right) => (left.i - right.i) || (left.j - right.j));
}

function translate(text, map) {
  return text.split("").map((character) => map[character] || character).join("");
}

// { word: rank } with rank 1 for the most common word. A repeated word keeps
// its last rank, as in zxcvbn.
function rankedDictionary(words) {
  const ranked = new Map();
  words.forEach((word, index) => ranked.set(word, index + 1));
  return ranked;
}

// `dictionaries`: [{ name, ranked }] in the order they are searched.
function dictionaryMatch(password, dictionaries) {
  const matches = [];
  const length = password.length;
  const lower = password.toLowerCase();
  for (const { name, ranked } of dictionaries) {
    for (let i = 0; i < length; i += 1) {
      for (let j = i; j < length; j += 1) {
        const word = lower.slice(i, j + 1);
        const rank = ranked.get(word);
        if (rank !== undefined) {
          matches.push({
            pattern: "dictionary",
            i,
            j,
            token: password.slice(i, j + 1),
            matchedWord: word,
            rank,
            dictionaryName: name,
            reversed: false,
            l33t: false,
          });
        }
      }
    }
  }
  return sorted(matches);
}

function reverseDictionaryMatch(password, dictionaries) {
  const reversed = password.split("").reverse().join("");
  const matches = dictionaryMatch(reversed, dictionaries);
  for (const match of matches) {
    match.token = match.token.split("").reverse().join("");
    match.reversed = true;
    [match.i, match.j] = [password.length - 1 - match.j, password.length - 1 - match.i];
  }
  return sorted(matches);
}

function relevantL33tSubtable(password, table) {
  const present = new Set(password.split(""));
  const subtable = {};
  for (const [letter, subs] of Object.entries(table)) {
    const relevant = subs.filter((sub) => present.has(sub));
    if (relevant.length > 0) subtable[letter] = relevant;
  }
  return subtable;
}

function enumerateL33tSubs(table) {
  const keys = Object.keys(table);
  /** @type {Array<Array<[string, string]>>} */
  let subs = [[]];
  const dedup = (list) => {
    const deduped = [];
    const members = new Set();
    for (const sub of list) {
      const label = sub.map((pair, index) => [pair, index]).sort().map(([pair, index]) => `${pair},${index}`).join("-");
      if (!members.has(label)) {
        members.add(label);
        deduped.push(sub);
      }
    }
    return deduped;
  };
  for (const firstKey of keys) {
    const next = [];
    for (const l33tCharacter of table[firstKey]) {
      for (const sub of subs) {
        const duplicate = sub.findIndex((pair) => pair[0] === l33tCharacter);
        if (duplicate === -1) {
          next.push(sub.concat([[l33tCharacter, firstKey]]));
        } else {
          const alternative = sub.slice(0);
          alternative.splice(duplicate, 1);
          alternative.push([l33tCharacter, firstKey]);
          next.push(sub);
          next.push(alternative);
        }
      }
    }
    subs = dedup(next);
  }
  return subs.map((sub) => Object.fromEntries(sub));
}

function l33tMatch(password, dictionaries) {
  const matches = [];
  for (const sub of enumerateL33tSubs(relevantL33tSubtable(password, L33T_TABLE))) {
    if (Object.keys(sub).length === 0) break;
    const subbed = translate(password, sub);
    for (const match of dictionaryMatch(subbed, dictionaries)) {
      const token = password.slice(match.i, match.j + 1);
      if (token.toLowerCase() === match.matchedWord) continue;
      const matchSub = {};
      for (const [subbedCharacter, character] of Object.entries(sub)) {
        if (token.includes(subbedCharacter)) matchSub[subbedCharacter] = character;
      }
      match.l33t = true;
      match.token = token;
      match.sub = matchSub;
      matches.push(match);
    }
  }
  return sorted(matches.filter((match) => match.token.length > 1));
}

function spatialMatchHelper(password, graph, graphName) {
  const matches = [];
  let i = 0;
  while (i < password.length - 1) {
    let j = i + 1;
    let lastDirection = null;
    let turns = 0;
    let shiftedCount = (graphName === "qwerty" || graphName === "dvorak") && SHIFTED_RX.test(password.charAt(i)) ? 1 : 0;
    for (;;) {
      const previous = password.charAt(j - 1);
      let found = false;
      let foundDirection = -1;
      let direction = -1;
      const adjacents = graph[previous] || [];
      if (j < password.length) {
        const current = password.charAt(j);
        for (const adjacent of adjacents) {
          direction += 1;
          if (adjacent && adjacent.includes(current)) {
            found = true;
            foundDirection = direction;
            if (adjacent.indexOf(current) === 1) shiftedCount += 1;
            if (lastDirection !== foundDirection) {
              turns += 1;
              lastDirection = foundDirection;
            }
            break;
          }
        }
      }
      if (found) {
        j += 1;
      } else {
        if (j - i > 2) {
          matches.push({ pattern: "spatial", i, j: j - 1, token: password.slice(i, j), graph: graphName, turns, shiftedCount });
        }
        i = j;
        break;
      }
    }
  }
  return matches;
}

function sequenceMatch(password) {
  if (password.length === 1) return [];
  const result = [];
  const update = (i, j, delta) => {
    if ((j - i > 1 || Math.abs(delta) === 1) && Math.abs(delta) > 0 && Math.abs(delta) <= MAX_DELTA) {
      const token = password.slice(i, j + 1);
      let sequenceName = "unicode";
      let sequenceSpace = 26;
      if (/^[a-z]+$/.test(token)) {
        sequenceName = "lower";
      } else if (/^[A-Z]+$/.test(token)) {
        sequenceName = "upper";
      } else if (/^\d+$/.test(token)) {
        sequenceName = "digits";
        sequenceSpace = 10;
      }
      result.push({ pattern: "sequence", i, j, token, sequenceName, sequenceSpace, ascending: delta > 0 });
    }
  };
  let i = 0;
  let lastDelta = null;
  for (let k = 1; k < password.length; k += 1) {
    const delta = password.charCodeAt(k) - password.charCodeAt(k - 1);
    if (lastDelta === null) lastDelta = delta;
    if (delta === lastDelta) continue;
    const j = k - 1;
    update(i, j, lastDelta);
    i = j;
    lastDelta = delta;
  }
  update(i, password.length - 1, lastDelta);
  return result;
}

function regexMatch(password, recentYear) {
  const matches = [];
  const regex = new RegExp(recentYear.source, "g");
  let found;
  while ((found = regex.exec(password))) {
    matches.push({
      pattern: "regex",
      token: found[0],
      i: found.index,
      j: found.index + found[0].length - 1,
      regexName: "recentYear",
      regexMatch: found,
    });
  }
  return sorted(matches);
}

function twoToFourDigitYear(year) {
  if (year > 99) return year;
  return year > 50 ? year + 1900 : year + 2000;
}

function mapIntsToDm(ints) {
  for (const [day, month] of [ints, ints.slice().reverse()]) {
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month };
  }
  return null;
}

function mapIntsToDmy(ints) {
  if (ints[1] > 31 || ints[1] <= 0) return null;
  let over12 = 0;
  let over31 = 0;
  let under1 = 0;
  for (const value of ints) {
    if ((value > 99 && value < DATE_MIN_YEAR) || value > DATE_MAX_YEAR) return null;
    if (value > 31) over31 += 1;
    if (value > 12) over12 += 1;
    if (value <= 0) under1 += 1;
  }
  if (over31 >= 2 || over12 === 3 || under1 >= 2) return null;
  const splits = [[ints[2], ints.slice(0, 2)], [ints[0], ints.slice(1, 3)]];
  for (const [year, rest] of splits) {
    if (year >= DATE_MIN_YEAR && year <= DATE_MAX_YEAR) {
      const dm = mapIntsToDm(rest);
      return dm ? { year, month: dm.month, day: dm.day } : null;
    }
  }
  for (const [year, rest] of splits) {
    const dm = mapIntsToDm(rest);
    if (dm) return { year: twoToFourDigitYear(year), month: dm.month, day: dm.day };
  }
  return null;
}

function dateMatch(password, referenceYear) {
  const matches = [];
  const noSeparator = /^\d{4,8}$/;
  const withSeparator = /^(\d{1,4})([\s/\\_.-])(\d{1,2})\2(\d{1,4})$/;
  for (let i = 0; i <= password.length - 4; i += 1) {
    for (let j = i + 3; j <= i + 7; j += 1) {
      if (j >= password.length) break;
      const token = password.slice(i, j + 1);
      if (!noSeparator.test(token)) continue;
      const candidates = [];
      for (const [k, l] of DATE_SPLITS[token.length]) {
        const dmy = mapIntsToDmy([
          Number.parseInt(token.slice(0, k), 10),
          Number.parseInt(token.slice(k, l), 10),
          Number.parseInt(token.slice(l), 10),
        ]);
        if (dmy) candidates.push(dmy);
      }
      if (candidates.length === 0) continue;
      let best = candidates[0];
      let minDistance = Math.abs(candidates[0].year - referenceYear);
      for (const candidate of candidates.slice(1)) {
        const distance = Math.abs(candidate.year - referenceYear);
        if (distance < minDistance) {
          best = candidate;
          minDistance = distance;
        }
      }
      matches.push({ pattern: "date", token, i, j, separator: "", year: best.year, month: best.month, day: best.day });
    }
  }
  for (let i = 0; i <= password.length - 6; i += 1) {
    for (let j = i + 5; j <= i + 9; j += 1) {
      if (j >= password.length) break;
      const token = password.slice(i, j + 1);
      const found = withSeparator.exec(token);
      if (!found) continue;
      const dmy = mapIntsToDmy([
        Number.parseInt(found[1], 10),
        Number.parseInt(found[3], 10),
        Number.parseInt(found[4], 10),
      ]);
      if (!dmy) continue;
      matches.push({ pattern: "date", token, i, j, separator: found[2], year: dmy.year, month: dmy.month, day: dmy.day });
    }
  }
  return sorted(matches.filter((match) =>
    !matches.some((other) => other !== match && other.i <= match.i && other.j >= match.j)));
}

/**
 * @param {{
 *   graphs: Record<string, Record<string, Array<string | null>>>,
 *   recentYear: RegExp,
 *   referenceYear: number,
 *   mostGuessable: (password: string, matches: any[]) => { guesses: number, sequence: any[] },
 *   extraMatchers?: ReadonlyArray<(password: string, dictionaries: any[]) => any[]>,
 * }} options extraMatchers find more matches (src/shared/strength/russian.js).
 */
function createMatching({ graphs, recentYear, referenceYear, mostGuessable, extraMatchers = [] }) {
  function omnimatch(password, dictionaries) {
    const matches = [
      ...dictionaryMatch(password, dictionaries),
      ...reverseDictionaryMatch(password, dictionaries),
      ...l33tMatch(password, dictionaries),
      ...Object.entries(graphs).flatMap(([name, graph]) => sorted(spatialMatchHelper(password, graph, name))),
      ...repeatMatch(password, dictionaries),
      ...sequenceMatch(password),
      ...regexMatch(password, recentYear),
      ...dateMatch(password, referenceYear),
      ...extraMatchers.flatMap((matcher) => matcher(password, dictionaries)),
    ];
    return sorted(matches);
  }

  function repeatMatch(password, dictionaries) {
    const matches = [];
    const greedy = /(.+)\1+/g;
    const lazy = /(.+?)\1+/g;
    const lazyAnchored = /^(.+?)\1+$/;
    let lastIndex = 0;
    while (lastIndex < password.length) {
      greedy.lastIndex = lastIndex;
      lazy.lastIndex = lastIndex;
      const greedyMatch = greedy.exec(password);
      if (!greedyMatch) break;
      // Where the greedy pattern matches, so do the lazy ones.
      const lazyMatch = /** @type {RegExpExecArray} */ (lazy.exec(password));
      let match;
      let baseToken;
      if (greedyMatch[0].length > lazyMatch[0].length) {
        match = greedyMatch;
        baseToken = /** @type {RegExpExecArray} */ (lazyAnchored.exec(match[0]))[1];
      } else {
        match = lazyMatch;
        baseToken = match[1];
      }
      const i = match.index;
      const j = match.index + match[0].length - 1;
      const base = mostGuessable(baseToken, omnimatch(baseToken, dictionaries));
      matches.push({
        pattern: "repeat",
        i,
        j,
        token: match[0],
        baseToken,
        baseGuesses: base.guesses,
        baseMatches: base.sequence,
        repeatCount: match[0].length / baseToken.length,
      });
      lastIndex = j + 1;
    }
    return matches;
  }

  return { omnimatch };
}

export { createMatching, dictionaryMatch, rankedDictionary, sorted };
