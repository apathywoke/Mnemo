// Russian in passwords, which zxcvbn does not see: the Russian dictionary
// (@zxcvbn-ts/language-ru) is written in Latin transliteration, while
// people type Russian words in Cyrillic ("пароль") or with the keyboard
// still in the English layout ("gfhjkm"), and English words with the
// keyboard in the Russian layout ("зфыыцщкв" for "password"). These
// matchers find all three as dictionary matches.

// The transliteration of the Russian dictionary, read from its words:
// "kotoriy" (который), "esche" (ещё, not "eshche"), "yolka", "obyekt".
const TRANSLITERATION = Object.freeze({
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "y", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
});

// The same keys on the Russian (ЙЦУКЕН) and English (QWERTY) layouts. Both
// the PC and the Mac layout put ё on ` or \.
const LATIN_TO_CYRILLIC = Object.freeze({
  q: "й", w: "ц", e: "у", r: "к", t: "е", y: "н", u: "г", i: "ш", o: "щ",
  p: "з", "[": "х", "]": "ъ", a: "ф", s: "ы", d: "в", f: "а", g: "п",
  h: "р", j: "о", k: "л", l: "д", ";": "ж", "'": "э", z: "я", x: "ч",
  c: "с", v: "м", b: "и", n: "т", m: "ь", ",": "б", ".": "ю", "`": "ё",
  "\\": "ё",
});
const CYRILLIC_TO_LATIN = Object.freeze(Object.fromEntries(
  Object.entries(LATIN_TO_CYRILLIC).filter(([latin]) => latin !== "\\").map(([latin, cyrillic]) => [cyrillic, latin]),
));

// Words this short typed in the other layout are too often accidents.
const MIN_LAYOUT_LENGTH = 3;

function transliterate(cyrillic) {
  // "-ый" is written "iy" in the dictionary ("noviy", "kotoriy").
  return cyrillic.replace(/ый/g, "iy").split("").map((character) => TRANSLITERATION[character] ?? character).join("");
}

function isCyrillicWord(text) {
  return /^[а-яё]+$/.test(text);
}

function dictionaryHit(dictionaries, word) {
  for (const { name, ranked } of dictionaries) {
    const rank = ranked.get(word);
    if (rank !== undefined) return { rank, dictionaryName: name };
  }
  return null;
}

// Every substring [i, j] of the lowercased password that `convert` turns
// into a word of `dictionaries`; `convert` returns null to skip one.
function convertedMatches(password, dictionaries, convert, extra, minLength = 1) {
  const matches = [];
  const lower = password.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    for (let j = i + minLength - 1; j < lower.length; j += 1) {
      const word = convert(lower.slice(i, j + 1));
      if (word === null || word === "") continue;
      const hit = dictionaryHit(dictionaries, word);
      if (!hit) continue;
      matches.push({
        pattern: "dictionary",
        i,
        j,
        token: password.slice(i, j + 1),
        matchedWord: word,
        rank: hit.rank,
        dictionaryName: hit.dictionaryName,
        reversed: false,
        l33t: false,
        ...extra,
      });
    }
  }
  return matches;
}

// "пароль": a Cyrillic word, transliterated, in any dictionary.
function cyrillicMatch(password, dictionaries) {
  return convertedMatches(password, dictionaries, (text) => (isCyrillicWord(text) ? transliterate(text) : null), {
    transliterated: true,
  });
}

// "gfhjkm": Latin keys that spell a Russian dictionary word on the Russian
// layout. Only Russian dictionaries, so English words are left alone.
function russianLayoutMatch(password, dictionaries) {
  const russian = dictionaries.filter((dictionary) => dictionary.language === "ru");
  const convert = (text) => {
    if (![...text].every((character) => Object.hasOwn(LATIN_TO_CYRILLIC, character))) return null;
    return transliterate(text.split("").map((character) => LATIN_TO_CYRILLIC[character]).join(""));
  };
  return convertedMatches(password, russian, convert, { layout: "ru" }, MIN_LAYOUT_LENGTH);
}

// "зфыыцщкв": Cyrillic keys that spell a word of the other dictionaries on
// the English layout.
function englishLayoutMatch(password, dictionaries) {
  const others = dictionaries.filter((dictionary) => dictionary.language !== "ru");
  const convert = (text) => {
    if (!isCyrillicWord(text)) return null;
    return text.split("").map((character) => CYRILLIC_TO_LATIN[character]).join("");
  };
  return convertedMatches(password, others, convert, { layout: "en" }, MIN_LAYOUT_LENGTH);
}

const RUSSIAN_MATCHERS = Object.freeze([cyrillicMatch, russianLayoutMatch, englishLayoutMatch]);

export { RUSSIAN_MATCHERS, transliterate };
