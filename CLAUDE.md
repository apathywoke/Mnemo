# Mnemo — notes for Claude Code

Mnemo is a password manager: security beats convenience.

- Write code, comments, docs, and commit messages in English.
- Add no dependencies: having none at runtime is a
  security property of this project. Development tools
  go in devDependencies, pinned to exact versions.
- Types are JSDoc checked by `tsc` (tsconfig.json; the
  stricter tsconfig.strict.json covers src/main/vault/
  and src/shared/). Methods in src/main/vault/store-*.js
  carry `/** @this {Store} */`. Set innerHTML only from
  constants (ESLint enforces it); build DOM with
  textContent.
- Keep the vault file format, AAD strings, and crypto
  parameters unless the task says otherwise. Vault data
  is schema 4: passwords and TOTP (`entry-password:v2`,
  `entry-totp:v2`), secret item fields
  (`item-secret:v2:<field>`), and notes and `sealed` item
  fields (`entry-notes:v4:<field>`) are sealed per entry.
  A new sealed value takes the label of the schema that
  adds it; old labels never change. Tests that write an
  older schema use plainTextEntries() (support/helpers.js).
- Follow existing patterns: enqueueMutation; re-check
  sessionEpoch/lockEpoch after every await; zero Buffers
  in `finally`; atomic writes (temp file + rename);
  registerHandler for IPC; native dialogs in main for
  destructive actions.
- New IPC method: add it to preload.js and to the list
  in test/preload.test.js. Never return notes or sealed
  text except from vault:reveal-notes, which needs a
  real press (src/main/notes-reveal.js).
- New UI text: add en, de, and ru (test/i18n.test.js
  checks this). Errors thrown in main are English and
  must match an `errors.*` message in messages.js.
- Main-process code lives in src/main/ (vault/ for the
  vault store, ipc/ for IPC handlers, other modules next
  to them). Only main.js, preload.js, and the
  vault-store.js shim stay at the root. src/main/ is
  packaged by `src/main/**/*.js`; a main-process file
  anywhere else goes into `files` in
  electron-builder.config.js.
- Renderer slices are ES modules: import what you use with
  a relative path ending in `.js`; never use a global
  registry. index.html loads only app/index.js (and
  theme.js in <head>).
- Styles go in a .css file next to their slice, listed
  in the root styles.css; its @import order is the
  cascade order, so keep it. A change meant to keep the
  look must leave e2e/compare-screens.js with identical
  screens (README, Checks).
- Code that both the main process and the renderer load
  (i18n catalog, item types, card tools, password-tools)
  lives in src/shared/ as ES modules, packaged by
  `src/shared/**/*.js` and `src/shared/package.json`.
  Main loads them with require(); they may use only what
  both Node.js and the browser have.
- The strength dictionaries in src/shared/strength/data/
  are generated (scripts/make-strength-dictionaries.js)
  from pinned devDependencies; never edit them by hand.
  The estimator must keep matching zxcvbn 4.4.2 on its
  own dictionaries (test/password-strength.test.js).
- Paths built from `__dirname` must exist and be
  packaged (test/build-config.test.js checks every one);
  moving a file changes what they point to.
- Mutable main-process state lives in the `state` object
  that main.js creates; modules receive it and keep none
  of their own, since tests reload main.js.
- test/i18n.test.js finds main-process files and key
  prefixes by itself.
- Security behavior changed: update SECURITY.md and
  docs/THREAT_MODEL.md.
- No `Co-Authored-By: Claude` or other Claude
  attribution in commits or pull requests.
- Finish with `npm run check` (lint, types, `npm test`)
  passing, plus `npm run test:e2e` when the UI or startup
  changed, and a short summary of what changed and what
  is left.
