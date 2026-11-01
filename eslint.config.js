// ESLint flat config. `npm run lint` checks every JavaScript file in the
// repository; the rules below add the project's security conventions to
// ESLint's recommended set.
const js = require("@eslint/js");
const globals = require("globals");

// HTML is set only from constants (static SVG icons): a string literal, a
// constant name, or a property of a constant table. Anything built from
// values, such as a template literal or a concatenation, is refused.
const htmlSinkRules = [
  {
    selector:
      "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]:not([right.type='Literal']):not([right.type='Identifier']):not([right.type='MemberExpression'])",
    message: "Set innerHTML/outerHTML only from a constant; build DOM with textContent instead.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment)$/]",
    message: "Build DOM nodes with textContent instead of parsing HTML.",
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: "document.write is not used in Mnemo.",
  },
];

const securityRules = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",
  "no-restricted-syntax": ["error", ...htmlSinkRules],
};

// App code never logs: secrets must not reach logs or the console.
const appCodeRules = {
  ...securityRules,
  "no-console": "error",
};

module.exports = [
  {
    ignores: ["node_modules/**", "release/**", "dist/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      // Errors are replaced on purpose: a user-facing message must not carry
      // the underlying error (paths, parser details, or values) along.
      "preserve-caught-error": "off",
      // `let value = null;` before a try block is the project's idiom, so
      // `finally` can wipe whatever was assigned.
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2025 },
    rules: securityRules,
  },
  // Main process, preload, and Node.js tooling: CommonJS. Page code gets no
  // Node.js globals, so a stray require() or process is reported.
  {
    files: ["**/*.js"],
    ignores: ["src/renderer/**", "src/shared/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["main.js", "preload.js", "vault-store.js", "src/main/**/*.js"],
    rules: appCodeRules,
  },
  // The preload also runs a function in the page's main world.
  {
    files: ["preload.js"],
    languageOptions: { globals: { ...globals.node, window: "readonly" } },
  },
  // Renderer slices are ES modules loaded by index.html.
  {
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: appCodeRules,
  },
  // theme.js runs as a classic script in <head>.
  {
    files: ["src/renderer/shared/lib/theme.js"],
    languageOptions: { sourceType: "script" },
  },
  // ES modules imported by the page and required by the main process: only
  // what both environments have.
  {
    files: ["src/shared/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals["shared-node-browser"] },
    },
    rules: appCodeRules,
  },
  // Page code that runs inside the browser of an end-to-end test.
  {
    files: ["e2e/**/*.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
