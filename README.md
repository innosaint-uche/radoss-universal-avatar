# Radoss Universal Avatar

The no-code desktop setup layer for a personal, user-owned Avatar.

NAAS is the Avatar authority. Hermes is the visible setup and orchestration agent. SQLite + FTS5 is the local canonical memory ledger. ReMe is an optional readable projection; Ollama is deliberately excluded from the public product.

## For non-technical users

Use the signed desktop installer when it is released:

1. Install and open **Radoss Universal Avatar**.
2. Name your Avatar.
3. Choose a privacy mode.
4. Click **Set up my Avatar**.
5. Approve the account connection in the browser. Do not copy a code or token.
6. Reopen or refresh the supported AI host when the wizard confirms the local adapter.

The desktop wizard creates encrypted local backups before mutations and exposes retry, rollback, privacy, disconnect, health, and security controls.

The product has three deliberately different connection paths:

- **No-code users:** use the desktop wizard and browser OAuth; never copy a
  code, token, or configuration file.
- **Developers:** use the universal CLI and local stdio MCP adapters when they
  want scripted or repository-based control.
- **Hosted AI users:** use the branded HTTPS MCP gateway, then complete the
  final ChatGPT or Claude account connection in that host's own UI. Radoss
  never claims a host account is connected from a local file alone.

## CLI development path

The package is prepared for public npm publication but is not yet published.
After authenticating the npm account that owns the package name, publish the
verified tarball with:

```bash
cd /path/to/radoss-universal-avatar
npm login
npm publish --access public
```

The universal CLI is maintained separately from the NAAS source repository.
Its public source repository is
[`innosaint-uche/radoss-universal-avatar`](https://github.com/innosaint-uche/radoss-universal-avatar).

For local development from a checkout:

```bash
cd /path/to/radoss-universal-avatar
node bin/radoss.mjs setup
node bin/radoss.mjs setup status
node bin/radoss.mjs doctor
# Validate the deployed HTTPS MCP gateway without exposing a token
node bin/radoss.mjs mcp conformance https://mcp.naavos.radoss.agency/mcp --bearer-env RADOSS_GATEWAY_TOKEN --status-tool avatar_get
```

The CLI automatically manages the supported local targets:

- Codex: `~/.codex/config.toml`
- Antigravity: `~/.gemini/config/mcp_config.json`
- Hermes: `~/.hermes/profiles/avatar/config.yaml`, isolated `avatar` profile

Each receives the local `radoss_avatar` MCP server. Hermes remains the visible orchestrator; the default Hermes profile is not silently replaced.

## Connection boundary

Local agents use guarded stdio MCP. The deployed HTTPS Streamable HTTP gateway is
available at `https://mcp.naavos.radoss.agency/mcp` with OAuth, D1-backed
tenant-owner enforcement, and MCP lifecycle checks. Two-independent-live-user
tenant acceptance remains a separate public-release gate. The canonical Worker
origin remains an implementation detail behind the Hostinger/Coolify branded route. ChatGPT
and Claude account connections remain host-managed; a local configuration file
cannot prove an online ChatGPT or Claude connection.

The remote boundary and release evidence required for hosted clients are defined in [`docs/REMOTE_MCP_GATEWAY_CONTRACT.md`](docs/REMOTE_MCP_GATEWAY_CONTRACT.md). The local sidecar must never be exposed directly as a public connector.

The verified local Hugging Face flow completes browser OAuth, verifies the provider account, stores credentials through the macOS Keychain helper, and separately verifies Hermes' OAuth-owned cache. It never prints or stores token values in setup state or agent configuration.

## Verification

```bash
npm test
npm audit
npm pack --dry-run
```

See [`docs/NO_CODE_SETUP.md`](docs/NO_CODE_SETUP.md) for the evidence contract and release gates, and [`desktop-setup/README.md`](desktop-setup/README.md) for the Tauri packaging boundary.

See [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md) for the current
developer, local-validation, and customer-release boundaries.

## Universal QA

Reusable browser and live-surface E2E belongs in the central
external `~/.radoss-qa` harness. Each project contributes only a small
adapter describing its real URL and contract; it does not add Playwright,
browser binaries, or Rust to the project. Rust is used only by a central Tauri
or artifact adapter when process, IPC, filesystem, or signing evidence is
needed. See the local harness README after installing the universal development environment.
