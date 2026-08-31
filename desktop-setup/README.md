# NAAvOS Avatar OS desktop shell

This directory contains the user-facing setup surface and the Tauri v2 shell contract.

## Development boundary

- `index.html`, `app.js`, and `styles.css` are the accessible setup UI.
- The current verified service is `node ../bin/radoss.mjs setup --no-open` from this directory.
- `src-tauri/` is the desktop packaging scaffold. It must start a bundled local setup service before the packaged UI is considered functional.
- Hermes is configured in the isolated `avatar` profile and verified with `hermes -p avatar`; the user's default profile is not silently replaced.
- Codex, Antigravity, and the isolated Hermes `avatar` profile receive `radoss_avatar`, a local stdio MCP control surface for guarded NAAvOS setup and health actions; Hermes remains the visible orchestrator and every mutating tool requires explicit confirmation.
- Provider tokens must be stored through an OS credential store. They must not be written into `setup.json`, the registry, or agent configuration files. The macOS package includes a native Security.framework helper; Linux libsecret is used only when installed, and Windows packaging still needs its native credential-store implementation. If no secure store is available, OAuth is blocked before the browser opens.
- Setup backups are authenticated and encrypted locally; they are not plaintext copies of agent configuration. Legacy backups made before this hardening require migration or removal before distribution.
- The setup status performs a value-free preflight over supported target files and shows only credential field names and remediation guidance. It does not copy embedded values into NAAvOS state.
- The Tauri shell owns the bundled setup sidecar and terminates it on app exit; the sidecar also watches its parent so a force-terminated shell does not leave a listener on port `49312`.
- ReMe is an optional, readable, user-owned projection. The desktop surface can install its base package into an isolated Python environment only after an explicit click; it deliberately does not install ReMe's Ollama-bearing core extra. A separate confirmation is required before any already-approved SQLite memory is projected.

The preferred OAuth path uses provider metadata discovery, public-client S256 PKCE, and an ephemeral loopback callback. Providers with an explicit login endpoint are configured with it; Hugging Face uses `https://huggingface.co/mcp?login`. The isolated Hermes profile disables Hermes' fixed-port CIMD path for this flow and uses dynamic registration so the browser callback matches the active session bridge. If discovery or client registration cannot be completed, the provider-managed browser path is labelled unverified. The loopback API rejects browser requests from untrusted origins before applying state changes. The packaged macOS runtime uses the bundled native Keychain helper. Linux and Windows use platform-specific Tauri bundle configuration so the macOS helper is not declared for those targets; Linux requires `secret-tool`/libsecret and Windows still needs its native credential-store implementation. Cross-platform credential-store support and distribution signing remain release gates.

Build the local sidecar with `npm run desktop:sidecar` on the target platform (Node 26+). It produces the target-suffixed binary required by Tauri and ad-hoc signs it on macOS for local smoke testing; release signing remains a distribution gate. After a macOS Tauri build, run `npm run desktop:package:macos` so the DMG is regenerated from the verified app rather than retaining the pre-signature bundle.

From `desktop-setup/`, run `npx @tauri-apps/cli@latest build` after source or sidecar changes. The Tauri configuration invokes the repository-root build script through `../scripts/`, so the app embeds the current sidecar rather than a stale previous binary.

## Required desktop acceptance test

The Tauri release is not complete until a signed build proves:

1. install and launch without Node or a terminal;
2. create or load an Avatar;
3. open browser OAuth and receive the loopback callback;
4. configure the selected local agents;
5. run protocol and account health checks;
6. retry a failed setup;
7. restore a backup;
8. disconnect a provider without removing unrelated MCP entries.
9. discover the local `radoss_avatar` MCP server from the isolated Hermes profile and require explicit confirmation for mutations.

ChatGPT and Claude remain host-managed: the wizard hands the user to ChatGPT Settings → Apps/Connectors or Claude Settings → Integrations for the final account connection. A local adapter file cannot prove those account-level connections.

Hermes is the visible orchestrator selected by product policy. The NAAvOS setup runtime performs the guarded local mutation underneath it, and the `radoss_avatar` MCP server exposes the same controls to the exact `avatar` profile. A signed packaged user-approval run remains a release gate.

ReMe projection is intentionally one-way from approved SQLite records to ReMe Markdown. The canonical ledger is not replaced, and the desktop flow never imports or promotes ReMe content automatically.
