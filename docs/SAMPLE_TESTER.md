# NAAvOS Avatar OS sample tester

This DMG is an isolated customer-test build. It is safe to run alongside a
personal NAAvOS installation.

- App state, adapters, backups, memory, and setup logs go to
  `~/NAAvOS-Sample-Test/.naavos/`.
- OAuth credentials use the isolated `naavos-isolated-test` Keychain service.
- The sample does not read or write the normal `~/.naavos`, `~/.hermes`, Codex,
  or Antigravity configuration paths.
- Choose **On this device only** for a local test. Online hosting is optional;
  do not enter a real production endpoint unless you intend to test it.

To report a problem, send the exact screen message and the time it occurred.
Do not send `setup.json`, backups, Keychain exports, tokens, or screenshots
containing account information.
