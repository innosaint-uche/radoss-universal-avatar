# NAAvOS Avatar OS sample tester

This DMG is an isolated customer-test build. It is safe to run alongside a
personal NAAvOS installation.

Maintainers can regenerate the DMG with `npm run desktop:sample:macos` and the
sendable ZIP with `npm run desktop:sample:macos:zip`. The ZIP contains the DMG,
this guide, and a SHA-256 checksum file.

The packaged shell uses an ephemeral loopback port for its private setup
service, so starting the sample does not compete with another NAAvOS instance.

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
