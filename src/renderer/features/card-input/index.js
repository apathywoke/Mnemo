(() => {
  const ns = window.mnemoRenderer;
  const { t } = ns.shared.i18n;
  const cards = ns.shared.cardTools;

  // Card entry helpers for the item editor: groups the number as you type,
  // inserts the expiry slash, keeps fields to digits, shows the brand, moves
  // to the next field when one is complete, and explains problems inline.
  function attach(container) {
    const holder = container.querySelector("#item-field-cardholder");
    const number = container.querySelector("#item-field-number");
    const expiry = container.querySelector("#item-field-expiry");
    const cvv = container.querySelector("#item-field-cvv");
    const pin = container.querySelector("#item-field-pin");
    const messages = new Map();

    // A message line under each field (or under its row for masked inputs).
    for (const input of [number, expiry, cvv, pin]) {
      const message = document.createElement("p");
      message.className = "field-message";
      message.hidden = true;
      message.id = `${input.id}-message`;
      input.setAttribute("aria-describedby", message.id);
      const anchor = input.closest(".password-input-row") ?? input;
      anchor.after(message);
      messages.set(input, message);
    }

    // The number gets a row with the detected brand on the right.
    const numberRow = document.createElement("div");
    numberRow.className = "card-number-row";
    const brand = document.createElement("span");
    brand.className = "card-brand";
    brand.setAttribute("aria-live", "polite");
    number.replaceWith(numberRow);
    numberRow.append(number, brand);
    numberRow.after(messages.get(number));

    function show(input, key, params, kind = "error") {
      const message = messages.get(input);
      message.textContent = key ? t(key, params) : "";
      message.hidden = !key;
      message.dataset.kind = kind;
      input.setAttribute("aria-invalid", String(Boolean(key) && kind === "error"));
      (input.closest(".card-number-row, .password-input-row") ?? input)
        .classList.toggle("has-error", Boolean(key) && kind === "error");
    }

    // Keeps the caret after the same number of digits once spaces move.
    function setFormatted(input, formatted) {
      const caret = input.selectionStart ?? input.value.length;
      const digitsBefore = cards.digitsOnly(input.value.slice(0, caret)).length;
      input.value = formatted;
      let position = 0;
      let seen = 0;
      while (position < formatted.length && seen < digitsBefore) {
        if (/\d/.test(formatted[position])) seen += 1;
        position += 1;
      }
      input.setSelectionRange(position, position);
    }

    function atEnd(input) {
      return input.selectionStart === input.value.length;
    }

    function advance(from, to) {
      if (to && document.activeElement === from && atEnd(from) && !to.value) to.focus();
    }

    function cvvLength() {
      // When editing with the stored number kept, the brand is unknown.
      return number.value ? cards.cvvLength(number.value) : 4;
    }

    function checkNumber({ final = false } = {}) {
      const status = cards.numberStatus(number.value);
      if (status === "invalid") show(number, "card.numberInvalid");
      else if (status === "incomplete" && final) show(number, "card.numberIncomplete");
      else show(number, "");
      return status !== "invalid" && status !== "incomplete";
    }

    function checkExpiry({ final = false } = {}) {
      const status = cards.expiryStatus(expiry.value);
      if (status === "invalid") show(expiry, "card.expiryInvalid");
      else if (status === "incomplete" && final) show(expiry, "card.expiryIncomplete");
      else if (status === "expired") show(expiry, "card.expired", {}, "warning");
      else show(expiry, "");
      return status !== "invalid" && status !== "incomplete";
    }

    function checkDigits(input, lengths, { final = false } = {}) {
      const value = input.value;
      if (value && final && !lengths.includes(value.length)) {
        show(input, "card.digits", { count: lengths.length === 1 ? lengths[0] : `${lengths[0]}–${lengths.at(-1)}` });
        return false;
      }
      show(input, "");
      return true;
    }

    const pinLengths = [4, 5, 6, 7, 8, 9, 10, 11, 12];

    number.addEventListener("input", (event) => {
      setFormatted(number, cards.formatNumber(number.value));
      const detected = cards.detectBrand(cards.digitsOnly(number.value));
      brand.textContent = detected.name;
      cvv.maxLength = cvvLength();
      if (cvv.value.length > cvv.maxLength) cvv.value = cvv.value.slice(0, cvv.maxLength);
      const complete = checkNumber();
      const digits = cards.digitsOnly(number.value);
      // Move on at the usual length (16, or 15 for Amex); a rarer longer
      // number can still be finished by returning to the field.
      const usual = detected.lengths.includes(16) ? 16 : Math.max(...detected.lengths);
      if (complete && event.inputType?.startsWith("insert") && digits.length === usual) {
        advance(number, expiry);
      }
    });
    number.addEventListener("blur", () => checkNumber({ final: true }));

    let deleting = false;
    expiry.addEventListener("beforeinput", (event) => {
      deleting = event.inputType.startsWith("delete");
    });
    expiry.addEventListener("input", () => {
      expiry.value = cards.formatExpiry(expiry.value, { deleting });
      const status = cards.expiryStatus(expiry.value);
      checkExpiry();
      if (!deleting && (status === "complete" || status === "expired")) advance(expiry, cvv);
    });
    expiry.addEventListener("blur", () => checkExpiry({ final: true }));

    cvv.addEventListener("input", (event) => {
      cvv.value = cards.digitsOnly(cvv.value).slice(0, cvvLength());
      show(cvv, "");
      if (event.inputType?.startsWith("insert") && cvv.value.length === cvvLength()) advance(cvv, pin);
    });
    cvv.addEventListener("blur", () => checkDigits(cvv, number.value ? [cvvLength()] : [3, 4], { final: true }));

    pin.addEventListener("input", () => {
      pin.value = cards.digitsOnly(pin.value).slice(0, 12);
      show(pin, "");
    });
    pin.addEventListener("blur", () => checkDigits(pin, pinLengths, { final: true }));

    holder.autocapitalize = "characters";
    holder.addEventListener("input", () => {
      const caret = holder.selectionStart;
      holder.value = holder.value.toLocaleUpperCase();
      holder.setSelectionRange(caret, caret);
    });

    // Existing values (when editing) start formatted.
    expiry.value = cards.formatExpiry(expiry.value, { deleting: true });
    cvv.maxLength = cvvLength();

    // Checks every field before saving; focuses the first problem.
    function validate() {
      const results = [
        [number, checkNumber({ final: true })],
        [expiry, checkExpiry({ final: true })],
        [cvv, checkDigits(cvv, number.value ? [cvvLength()] : [3, 4], { final: true })],
        [pin, checkDigits(pin, pinLengths, { final: true })],
      ];
      const failed = results.find(([, ok]) => !ok);
      failed?.[0].focus();
      return !failed;
    }

    return { validate };
  }

  ns.features.cardInput = { attach };
})();
