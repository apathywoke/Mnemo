// A zxcvbn-style password strength estimator: how many guesses an attacker
// who knows common passwords, words, names, keyboard patterns, and the usual
// tricks would need. Dictionaries and matchers are passed in, so the same
// code runs with Mnemo's dictionaries (src/shared/password-tools.js) and,
// in the tests, with zxcvbn's own to compare the results.
//
// matching.js, scoring.js, feedback.js, and data/graphs.js are ported from
// zxcvbn 4.4.2 (https://github.com/dropbox/zxcvbn), which comes with this
// notice:
//
// Copyright (c) 2012-2016 Dan Wheeler and Dropbox, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
import { createMatching, rankedDictionary } from "./matching.js";
import { REFERENCE_YEAR, createScoring, guessesToScore } from "./scoring.js";
import { getFeedback } from "./feedback.js";

// Longer passwords are judged by their first characters only: matching is
// quadratic in the length, and the estimate can only be lower than the
// whole password deserves, never higher.
const MAX_ANALYZED_LENGTH = 100;

/**
 * Dictionaries are searched in their order; `kind` picks the warning
 * (feedback.js). `recentYear` matches years people pick. `extraMatchers`:
 * see matching.js.
 * @param {{
 *   dictionaries: Array<{ name: string, words: string[], kind: string, language?: string | null }>,
 *   graphs: Record<string, Record<string, Array<string | null>>>,
 *   recentYear?: RegExp,
 *   extraMatchers?: ReadonlyArray<(password: string, dictionaries: any[]) => any[]>,
 * }} options
 */
function createEstimator({ dictionaries, graphs, recentYear = /19\d\d|20\d\d/, extraMatchers = [] }) {
  const ranked = dictionaries.map(({ name, words, kind, language = null }) => ({
    name,
    kind,
    language,
    ranked: rankedDictionary(words),
  }));
  const kinds = new Map(ranked.map(({ name, kind }) => [name, kind]));
  const kindOf = (name) => kinds.get(name) ?? "other";
  const scoring = createScoring(graphs);
  const matching = createMatching({
    graphs,
    recentYear,
    referenceYear: REFERENCE_YEAR,
    mostGuessable: (password, matches) => scoring.mostGuessableMatchSequence(password, matches),
    extraMatchers,
  });

  /**
   * @param {string} password
   * @param {unknown[]} [userInputs] words that make this password easier to
   *   guess for someone who knows them (the vault name, for example)
   */
  function estimate(password, userInputs = []) {
    const analyzed = password.slice(0, MAX_ANALYZED_LENGTH);
    const inputs = userInputs
      .filter((input) => ["string", "number", "boolean"].includes(typeof input))
      .map((input) => String(input).toLowerCase());
    const searched = [...ranked, { name: "userInputs", kind: "other", language: null, ranked: rankedDictionary(inputs) }];
    const matches = matching.omnimatch(analyzed, searched);
    const result = scoring.mostGuessableMatchSequence(analyzed, matches);
    const score = guessesToScore(result.guesses);
    return {
      guesses: result.guesses,
      guessesLog10: result.guessesLog10,
      score,
      sequence: result.sequence,
      feedback: getFeedback(score, result.sequence, kindOf),
    };
  }

  return { estimate };
}

export { MAX_ANALYZED_LENGTH, createEstimator };
