// Elements are found by selector, so their exact type is not known here.
/** @type {(selector: string, root?: ParentNode) => any} */
const $ = (selector, root = document) => root.querySelector(selector);
/** @type {(selector: string, root?: ParentNode) => any[]} */
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

export { $, $$, setError };
