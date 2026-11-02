// Mnemo's strength dictionaries, in the order they are searched: common
// passwords first, then the EFF diceware list, then English, German, and
// Russian words and names (the interface languages). The words are
// generated into ./data/ by scripts/make-strength-dictionaries.js.
import * as common from "./data/common.js";
import * as de from "./data/de.js";
import * as en from "./data/en.js";
import * as graphs from "./data/graphs.js";
import * as ru from "./data/ru.js";

const SEPARATOR = "|";
const split = (text) => text.split(SEPARATOR);

function languageDictionaries(language, data) {
  return [
    { name: `${language}-commonWords`, words: split(data.commonWords), kind: "words", language },
    { name: `${language}-wikipedia`, words: split(data.wikipedia), kind: "words", language },
    { name: `${language}-firstnames`, words: split(data.firstnames), kind: "names", language },
    { name: `${language}-lastnames`, words: split(data.lastnames), kind: "names", language },
  ];
}

// Built when first asked for, since splitting the lists takes a moment.
function strengthDictionaries() {
  return [
    { name: "passwords", words: split(common.passwords), kind: "passwords" },
    { name: "diceware", words: split(common.diceware), kind: "words", language: "en" },
    ...languageDictionaries("en", en),
    ...languageDictionaries("de", de),
    ...languageDictionaries("ru", ru),
  ];
}

const KEYBOARD_GRAPHS = Object.freeze({
  qwerty: graphs.qwerty,
  dvorak: graphs.dvorak,
  keypad: graphs.keypad,
  mac_keypad: graphs.macKeypad,
});

export { KEYBOARD_GRAPHS, strengthDictionaries };
