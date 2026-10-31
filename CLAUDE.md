# Mnemo — notes for Claude Code

Mnemo is a password manager: security beats convenience.

- Write code, comments, docs, and commit messages in English.
- Add no dependencies: having none at runtime is a
  security property of this project.
- Keep the vault file format, AAD strings, and crypto
  parameters unless the task says otherwise.
- Follow existing patterns: enqueueMutation; re-check
  sessionEpoch/lockEpoch after every await; zero Buffers
  in `finally`; atomic writes (temp file + rename);
  registerHandler for IPC; native dialogs in main for
  destructive actions.
- New IPC method: add it to preload.js and to the list
  in test/preload.test.js.
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
- Code that both the main process and the renderer load
  (password-tools.js) lives in src/shared/, packaged by
  `src/shared/**/*.js`. It must work as a CommonJS module
  and as a plain <script>.
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
- Finish with `npm test` passing and a short summary
  of what changed and what is left.
