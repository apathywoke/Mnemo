// What to tell the user about a weak password: a warning and suggestions,
// as keys of the UI text catalog (src/shared/i18n/messages.js, "strength.*").
// A port of zxcvbn 4.4.2's feedback (MIT, Dropbox); the English texts are
// zxcvbn's own. Each dictionary has a `kind` that picks the warning:
// "passwords", "words", "names", or "other".
import { ALL_UPPER, START_UPPER } from "./scoring.js";

const DEFAULT_FEEDBACK = Object.freeze({
  warning: "",
  suggestions: ["strength.suggestion.useWords", "strength.suggestion.noNeedForSymbols"],
});

function dictionaryFeedback(match, isSoleMatch, kindOf) {
  const kind = kindOf(match.dictionaryName);
  let warning = "";
  if (kind === "passwords") {
    if (isSoleMatch && !match.l33t && !match.reversed) {
      if (match.rank <= 10) warning = "strength.warning.topTen";
      else if (match.rank <= 100) warning = "strength.warning.topHundred";
      else warning = "strength.warning.common";
    } else if (match.guessesLog10 <= 4) {
      warning = "strength.warning.similarToCommon";
    }
  } else if (kind === "words") {
    if (isSoleMatch) warning = "strength.warning.wordByItself";
  } else if (kind === "names") {
    warning = isSoleMatch ? "strength.warning.namesByThemselves" : "strength.warning.commonNames";
  }

  const suggestions = [];
  const word = match.token;
  if (START_UPPER.test(word)) {
    suggestions.push("strength.suggestion.capitalization");
  } else if (ALL_UPPER.test(word) && word.toLowerCase() !== word) {
    suggestions.push("strength.suggestion.allUppercase");
  }
  if (match.reversed && match.token.length >= 4) suggestions.push("strength.suggestion.reversedWords");
  if (match.l33t) suggestions.push("strength.suggestion.l33t");
  if (match.layout) suggestions.push("strength.suggestion.otherLayout");
  return { warning, suggestions };
}

function matchFeedback(match, isSoleMatch, kindOf) {
  switch (match.pattern) {
    case "dictionary":
      return dictionaryFeedback(match, isSoleMatch, kindOf);
    case "spatial":
      return {
        warning: match.turns === 1 ? "strength.warning.straightRows" : "strength.warning.keyPattern",
        suggestions: ["strength.suggestion.longerKeyboardPattern"],
      };
    case "repeat":
      return {
        warning: match.baseToken.length === 1 ? "strength.warning.repeatedCharacter" : "strength.warning.repeatedText",
        suggestions: ["strength.suggestion.repeated"],
      };
    case "sequence":
      return { warning: "strength.warning.sequences", suggestions: ["strength.suggestion.sequences"] };
    case "regex":
      return {
        warning: "strength.warning.recentYears",
        suggestions: ["strength.suggestion.recentYears", "strength.suggestion.associatedYears"],
      };
    case "date":
      return { warning: "strength.warning.dates", suggestions: ["strength.suggestion.associatedDates"] };
    default:
      return null;
  }
}

// `kindOf(dictionaryName)` gives a dictionary's kind.
function getFeedback(score, sequence, kindOf) {
  if (sequence.length === 0) return { warning: DEFAULT_FEEDBACK.warning, suggestions: [...DEFAULT_FEEDBACK.suggestions] };
  if (score > 2) return { warning: "", suggestions: [] };
  let longest = sequence[0];
  for (const match of sequence.slice(1)) {
    if (match.token.length > longest.token.length) longest = match;
  }
  const feedback = matchFeedback(longest, sequence.length === 1, kindOf);
  const extra = "strength.suggestion.addWord";
  if (feedback) {
    feedback.suggestions.unshift(extra);
    return feedback;
  }
  return { warning: "", suggestions: [extra] };
}

export { getFeedback };
