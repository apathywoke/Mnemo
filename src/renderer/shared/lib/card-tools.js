// Payment card helpers shared by the editor (formatting as you type) and the
// main process (validation on save), so both apply the same rules.
(() => {
  // Brand detection by issuer prefix. `gaps` are the digit positions after
  // which a space is shown; `lengths` are the valid card number lengths.
  const BRANDS = Object.freeze([
    { id: "amex", name: "American Express", pattern: /^3[47]/, lengths: [15], gaps: [4, 10], cvv: 4 },
    { id: "diners", name: "Diners Club", pattern: /^3(0[0-5]|[689])/, lengths: [14, 15, 16, 17, 18, 19], gaps: [4, 10], cvv: 3 },
    { id: "mir", name: "Мир", pattern: /^220[0-4]/, lengths: [16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 },
    { id: "mastercard", name: "Mastercard", pattern: /^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/, lengths: [16], gaps: [4, 8, 12], cvv: 3 },
    { id: "visa", name: "Visa", pattern: /^4/, lengths: [13, 16, 19], gaps: [4, 8, 12, 16], cvv: 3 },
    { id: "jcb", name: "JCB", pattern: /^35(2[89]|[3-8])/, lengths: [16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 },
    { id: "unionpay", name: "UnionPay", pattern: /^62/, lengths: [16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 },
    { id: "discover", name: "Discover", pattern: /^(6011|64[4-9]|65)/, lengths: [16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 },
    { id: "maestro", name: "Maestro", pattern: /^(5[06-8]|6)/, lengths: [12, 13, 14, 15, 16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 },
  ]);
  const DEFAULT_BRAND = Object.freeze({ id: "", name: "", lengths: [12, 13, 14, 15, 16, 17, 18, 19], gaps: [4, 8, 12, 16], cvv: 3 });
  const MAX_DIGITS = 19;

  function digitsOnly(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  function detectBrand(digits) {
    return BRANDS.find((brand) => brand.pattern.test(digits)) ?? DEFAULT_BRAND;
  }

  function maxLength(brand) {
    return Math.max(...brand.lengths);
  }

  // "4242424242424242" -> "4242 4242 4242 4242"; Amex 4-6-5.
  function formatNumber(value) {
    const digits = digitsOnly(value);
    const brand = detectBrand(digits);
    const limited = digits.slice(0, Math.min(MAX_DIGITS, maxLength(brand)));
    let out = "";
    for (let i = 0; i < limited.length; i += 1) {
      if (i > 0 && brand.gaps.includes(i)) out += " ";
      out += limited[i];
    }
    return out;
  }

  function luhnValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let digit = Number(digits[i]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return digits.length > 0 && sum % 10 === 0;
  }

  // "", "complete", "incomplete", or "invalid" (wrong check digit).
  function numberStatus(value) {
    const digits = digitsOnly(value);
    if (!digits) return "";
    const brand = detectBrand(digits);
    if (digits.length < Math.min(...brand.lengths)) return "incomplete";
    if (!brand.lengths.includes(digits.length)) {
      return digits.length < maxLength(brand) ? "incomplete" : "invalid";
    }
    return luhnValid(digits) ? "complete" : "invalid";
  }

  // Formats expiry input as MM/YY: inserts the slash, pads a single month
  // digit above 1 ("7" -> "07/"), and accepts pasted MM/YYYY.
  function formatExpiry(value, { deleting = false } = {}) {
    const text = String(value ?? "");
    // A separator typed or pasted by the user ("7/29", "07.2029", "7-") marks
    // where the month ends.
    const separated = text.match(/^\s*(\d{1,2})\s*[/.\-\s]\s*(\d{0,4})\s*$/);
    if (separated && !(separated[1].length === 2 && deleting && !separated[2])) {
      const month = separated[1].padStart(2, "0");
      const year = separated[2].length === 4 ? separated[2].slice(2) : separated[2].slice(0, 2);
      return `${month}/${year}`;
    }
    let digits = digitsOnly(text).slice(0, 4);
    if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`;
    if (digits.length >= 2 && Number(digits.slice(0, 2)) > 12 && digits[0] === "1") {
      // "13" is not a month: read it as "01/3".
      digits = `0${digits}`.slice(0, 4);
    }
    if (digits.length < 2) return digits;
    if (digits.length === 2) return deleting ? digits : `${digits}/`;
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }

  // "", "complete", "incomplete", "invalid", or "expired" (still saveable).
  function expiryStatus(value, now = new Date()) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const match = text.match(/^(\d{2})\/(\d{2})$/);
    if (!match) return /^\d{0,2}\/?\d{0,1}$/.test(text) ? "incomplete" : "invalid";
    const month = Number(match[1]);
    if (month < 1 || month > 12) return "invalid";
    const year = 2000 + Number(match[2]);
    const lastDay = new Date(year, month, 0, 23, 59, 59);
    return lastDay < now ? "expired" : "complete";
  }

  function cvvLength(numberValue) {
    return detectBrand(digitsOnly(numberValue)).cvv;
  }

  const api = {
    BRANDS,
    cvvLength,
    detectBrand,
    digitsOnly,
    expiryStatus,
    formatExpiry,
    formatNumber,
    luhnValid,
    numberStatus,
  };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    window.mnemoRenderer.shared.cardTools = api;
  }
})();
