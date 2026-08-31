# NAAvOS Avatar OS sample tester

This DMG is an isolated customer-test build. It is safe to run alongside a
personal NAAvOS installation.

- App state, backups, memory, and setup logs go to
  `~/NAAvOS-Sample-Test/.naavos/`; generated adapter files are kept under
  `~/NAAvOS-Sample-Test/.codex/`, `~/NAAvOS-Sample-Test/.gemini/`, and
  `~/NAAvOS-Sample-Test/.hermes/`.
- OAuth credentials use the isolated `naavos-isolated-test` Keychain service.
- The sample does not read or write the normal `~/.naavos`, `~/.hermes`,
  `~/.codex`, or `~/.gemini` configuration paths, and it does not modify the
  installed agent applications themselves.
- Choose **On this device only** for a local test. Online hosting is optional;
  do not enter a real production endpoint unless you intend to test it.

To report a problem, send the exact screen message and the time it occurred.
Do not send `setup.json`, backups, Keychain exports, tokens, or screenshots
containing account information.
