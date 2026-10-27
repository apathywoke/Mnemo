const assert = require("node:assert/strict");
const test = require("node:test");
const cards = require("../src/renderer/shared/lib/card-tools");

test("card numbers are grouped by brand and checked with the Luhn digit", () => {
  const cases = [
    ["4242424242424242", "Visa", "4242 4242 4242 4242"],
    ["378282246310005", "American Express", "3782 822463 10005"],
    ["5555555555554444", "Mastercard", "5555 5555 5555 4444"],
    ["2223003122003222", "Mastercard", "2223 0031 2200 3222"],
    ["2200000000000004", "Мир", "2200 0000 0000 0004"],
    ["6011111111111117", "Discover", "6011 1111 1111 1117"],
    ["3530111333300000", "JCB", "3530 1113 3330 0000"],
    ["6200000000000005", "UnionPay", "6200 0000 0000 0005"],
    ["30569309025904", "Diners Club", "3056 930902 5904"],
  ];
  for (const [digits, brand, formatted] of cases) {
    assert.equal(cards.detectBrand(digits).name, brand, digits);
    assert.equal(cards.formatNumber(digits), formatted, digits);
    assert.equal(cards.numberStatus(formatted), "complete", digits);
  }
  assert.equal(cards.formatNumber("4242-4242 4242x4242 999"), "4242 4242 4242 4242 999");
  assert.equal(cards.formatNumber("3782822463100051234"), "3782 822463 10005");
  assert.equal(cards.numberStatus("4242 4242 4242 4241"), "invalid");
  assert.equal(cards.numberStatus("4242 4242"), "incomplete");
  assert.equal(cards.numberStatus(""), "");
  assert.equal(cards.cvvLength("3782"), 4);
  assert.equal(cards.cvvLength("4242"), 3);
});

test("expiry input gets its slash and month padding automatically", () => {
  const cases = [
    ["0", {}, "0"], ["1", {}, "1"], ["7", {}, "07/"], ["07", {}, "07/"], ["072", {}, "07/2"],
    ["0729", {}, "07/29"], ["1229", {}, "12/29"], ["13", {}, "01/3"], ["7/29", {}, "07/29"],
    ["07/2029", {}, "07/29"], ["07.2029", {}, "07/29"], ["1/", {}, "01/"],
    ["07", { deleting: true }, "07"], ["07/", { deleting: true }, "07"],
  ];
  for (const [input, options, expected] of cases) {
    assert.equal(cards.formatExpiry(input, options), expected, `${input} ${JSON.stringify(options)}`);
  }
});

test("expiry status distinguishes incomplete, invalid, and expired dates", () => {
  const now = new Date(2026, 9, 27);
  assert.equal(cards.expiryStatus("10/26", now), "complete");
  assert.equal(cards.expiryStatus("09/26", now), "expired");
  assert.equal(cards.expiryStatus("13/29", now), "invalid");
  assert.equal(cards.expiryStatus("00/29", now), "invalid");
  assert.equal(cards.expiryStatus("07/", now), "incomplete");
  assert.equal(cards.expiryStatus("", now), "");
});
