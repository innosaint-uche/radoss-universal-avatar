# Radoss Universal Avatar: No-Code Setup

## Product promise

> Connect your accounts once. Radoss configures supported AI agents and shows what is actually verified.

The user should not edit `config.toml`, `mcp.json`, `config.yaml`, `.env` files, bearer tokens, or redirect URLs. When local setup is already configured but account evidence is missing, the primary action becomes `Connect account` and opens only the browser OAuth step; the status remains amber until account evidence is verified. ChatGPT and Claude expose explicit host handoff buttons; Radoss opens the approved host page but does not claim to control the host account UI.

The desktop authority panel makes the boundary visible in plain language: the
local NAAS control plane is available to the installed wizard, while the hosted
NAAS gateway is configured separately through
`RADOS_NAAS_GATEWAY_URL=https://mcp.naavos.radoss.agency/mcp`.
The Worker URL is retained only as an implementation/test origin. Hosted
OAuth/MCP evidence exists, while ChatGPT
and Claude still require their own host-managed acceptance and must not be
inferred from local setup.

## Current implementation

The setup control plane lives in:

- `lib/setup-runtime.mjs`
- `lib/setup-state.mjs`
- `lib/oauth.mjs`
- `lib/avatar-memory.mjs`
- `lib/reme.mjs`
- `lib/mcp-registry.mjs`
- `lib/mcp-adapters.mjs`
- `lib/mcp-orchestrator.mjs`
- `bin/radoss-mcp.mjs`
- `desktop-setup/`

Start the local wizard:

```bash
cd /path/to/radoss-universal-avatar
node bin/radoss.mjs setup
```

The service binds to `127.0.0.1` and opens the setup interface in the system browser. It does not expose a public network listener, and its API rejects browser requests from untrusted origins before reading or applying a request body.

## One-click flow

1. Create or load local setup state.
2. Create or load a named local Avatar.
3. Initialize the local SQLite + FTS5 memory ledger.
4. Create a recoverable snapshot before mutation.
5. Register the selected provider in `~/.naavos/mcp.json`.
6. Configure Codex, Antigravity, and Hermes from the canonical registry.
   Hermes is written to its named `avatar` profile; the existing default Hermes profile and running gateway are left untouched.
7. Add the local `radoss_avatar` stdio MCP server to Codex, Antigravity, and the isolated Hermes `avatar` profile. Hermes remains the visible orchestrator; every local host can reach the guarded Avatar control plane.
8. Discover provider OAuth metadata and start public-client S256 PKCE over a loopback callback; use the provider's explicit login endpoint when it offers one (Hugging Face uses `?login`). Hermes uses dynamic registration for this browser bridge rather than its fixed-port Client-ID Metadata Document.
9. Store any returned credential bundle in the OS credential store, never in agent configuration or setup state.
10. Run a live MCP protocol probe, using the stored token only for the local health check when available; validate JSON-RPC initialization, the initialized notification, session continuity, and `tools/list`.
11. Show protocol health separately from account authentication evidence.
12. Record the action in the local audit trail.

The optional ReMe control is separate from the setup mutation: the user can explicitly install ReMe into `~/.naavos/reme/venv` and start a loopback service. The action is not automatic and requires Python 3.11+. The installer uses ReMe's base package plus its direct `agentscope` runtime import dependency, not the broad `core` extra; Ollama remains excluded from this product. After ReMe is healthy, a second confirmation-gated control can project only already-approved SQLite memories into readable ReMe Markdown. SQLite remains canonical; the projection never promotes, edits, or deletes canonical memory.

## Evidence language

The cross-project evidence rules are defined in [`EVIDENCE_STANDARD.md`](EVIDENCE_STANDARD.md).
They are enforced by the release gate, so the wizard cannot turn a configured
or recommended integration into an observed/verified claim.

The wizard must distinguish:

| State | Meaning |
|---|---|
| `configured` | Local registry and selected agent adapters were written. |
| `browser_opened` | The provider login URL was opened. |
| `pending_provider_confirmation` | The provider has not supplied independent login evidence to Radoss. |
| `authenticated` | The OAuth callback returned a token and the provider userinfo endpoint verified the account. |
| `token_storage` | Only the storage backend and reference are shown; token values are never returned. |
| `healthy` | The MCP endpoint accepted the protocol initialize request. |
| `authenticated: unverified` | Reachability did not prove the user account or OAuth session. |

The public Hugging Face MCP endpoint can be reachable without proving the user's account login. Do not collapse these states.

The preferred browser action uses provider OAuth discovery, a public client, S256 PKCE, and a loopback callback. If client registration or discovery is unavailable, the wizard falls back to the provider-managed login and retains the `pending_provider_confirmation` label. Tokens are never copied into NAAS state or agent configuration. The packaged macOS path now uses a native Keychain helper. For Hugging Face, the live run uses `https://huggingface.co/mcp?login`, dynamic registration, and a separate Hermes-owned OAuth cache.

## Supported user controls

```bash
node bin/radoss.mjs setup status
node bin/radoss.mjs setup run
node bin/radoss.mjs setup run --open-auth
node bin/radoss.mjs setup retry
node bin/radoss.mjs setup connect huggingface
node bin/radoss.mjs setup backup --reason user-requested
node bin/radoss.mjs setup rollback <backup-id>
node bin/radoss.mjs setup privacy local_only
node bin/radoss.mjs setup privacy local_and_sync
node bin/radoss.mjs setup privacy paused
node bin/radoss.mjs setup disconnect huggingface
node bin/radoss.mjs setup memory status
node bin/radoss.mjs setup memory install
node bin/radoss.mjs setup memory project
node bin/radoss.mjs doctor
```

Both `radoss doctor` and `radoss mcp doctor` use any credential already held by
the OS credential store internally for the live protocol probe. They report only
token-free health evidence; credentials are never accepted as command-line
values or printed in diagnostics.

`local_and_sync` records the user's preference but does not claim that Supabase is configured. `paused` blocks setup mutation. Telemetry remains disabled. `setup retry` repeats the last recorded request and creates a new backup first.

Disconnect is a privacy action: it creates an encrypted backup, removes the
provider's registered adapter entries, and deletes that provider's saved OAuth
credential from the OS credential store and its matching Hermes Avatar-profile
OAuth bundle. Other Hermes provider sessions are preserved. If Hermes cleanup
cannot be verified, the operation fails closed and the pre-disconnect adapter
snapshot is restored. Restoring a backup restores files, but
the status becomes pending provider confirmation if the credential was removed,
so the user is sent through browser OAuth again instead of seeing a false
connected state.

The local canonical ledger is `~/.naavos/avatar.sqlite` with an FTS5 index. Memory capture is approval-gated; ReMe is an optional readable projection and is never the identity or consent authority. A user can explicitly choose the ReMe button to install it into an isolated local Python environment and start its loopback service, then choose `Project approved memory`. Setup never installs, starts, or copies memory silently.

The release label is evidence-gated. A signed one-person desktop handoff uses
`RADOS_RELEASE_CHANNEL=individual_local` and requires local Tauri/OAuth proof,
public source visibility, security remediation, and signed/notarised artifacts
for every advertised platform. A shared hosted product uses
`RADOS_RELEASE_CHANNEL=public` and additionally requires remote MCP
conformance, OAuth, branded routing, two independent live-user tenant
isolation, ChatGPT and Claude host acceptance, a clean tagged release,
deployment identity, and the remaining public-service evidence. Neither value
alone makes a build releasable; `RADOS_RELEASE_EVIDENCE_FILE` must prove the
selected profile. Otherwise the wizard remains labelled `Local validation
build`.

Radoss snapshots use authenticated local encryption (AES-256-GCM) and keep the key at `~/.naavos/.snapshot-key` with mode `0600`. Snapshot contents are not plaintext copies of agent configuration. Legacy schema-1 snapshots created before this hardening must be scrubbed before public release; do not treat their presence as safe backup evidence.

## Agent boundary

Automatic local adapters currently cover:

- Codex: `~/.codex/config.toml`
- Antigravity: `~/.gemini/config/mcp_config.json`
- Hermes: `~/.hermes/profiles/avatar/config.yaml`

Each supported local adapter also receives the `radoss_avatar` stdio server. Disconnecting a cloud provider removes only that provider entry and preserves the local Avatar control plane.

ChatGPT and Claude are shown as host-managed connections. The user completes the final connection in the host UI: ChatGPT Settings → Apps/Connectors, or Claude Settings → Integrations. Radoss must not silently edit account-managed host settings or pretend that a local file proves an online account connection.

The required hosted-client boundary is documented in [`REMOTE_MCP_GATEWAY_CONTRACT.md`](REMOTE_MCP_GATEWAY_CONTRACT.md). The deployed Worker passes the live MCP/OAuth path; ChatGPT and Claude remain correctly labelled `account_ui` until each host's own account connection is accepted and verified.

Before sharing a diagnostic, snapshot, or public build, the wizard scans supported target configuration files for embedded credential values. It reports only the target, file, field name, and corrective action; it never returns the value. Environment-variable references and OS credential-store references are not treated as embedded credentials.

Hermes is the selected single visible orchestration agent in the product policy. The wizard verifies the exact Hermes Avatar profile with `hermes -p avatar mcp list` and `hermes -p avatar mcp test radoss_avatar`; it does not silently switch or overwrite the user's default Hermes profile. NAAS remains the guarded setup control plane underneath that visible orchestration surface. All mutating local tools require explicit `confirm=true`; the packaged Hermes-driven installation handoff still needs a signed end-to-end user-approval run.

## Verification update — 2026-08-31

- `npm test`: 33/33 tests passed, including the separate `individual_local`
  and hosted `public` release-gate behavior.
- `npm run public:preflight`: passed; 97 public-package files scanned.
- Public CI run `33342638162`: passed on source `8188617`; subsequent changes
  in this verification sequence are documentation-only.
- Desktop build run `33342208151`: macOS, Windows, and Linux unsigned bundles
  passed for runtime commit `3ce82c0`; later commits in this sequence changed
  documentation only.
- Central QA run `run-2026-08-30T23-43-13-287Z`: local agents, live NAAS, and
  packaged Tauri adapters passed. Two Antigravity embedded-credential field
  warnings remain intentionally visible and redacted.

## Historical verification record — 2026-08-24

Validated locally:

- `npm test`: that historical snapshot passed 31/31, including OAuth, MCP,
  setup, memory, Hermes, retry, rollback, disconnect, security, HTTP, and
  release-gate coverage plus secure-session reuse.
- Browser smoke test: rendered the setup page, named an Avatar, completed setup, paused privacy, blocked retry, resumed local-only mode, retried successfully, and created a backup.
- Fresh browser E2E after the release-gate correction: setup and privacy selection completed in an isolated home with Chrome, zero console errors, and zero console warnings.
- Fresh browser disconnect E2E after the Hermes-session correction: setup, disconnect, and rollback completed in an isolated home with zero console errors and zero console warnings; the rendered action confirmed both Universal and Hermes provider-session removal.
- Fresh browser health E2E: the desktop health action reported local/provider evidence separately from hosted-gateway readiness with zero console errors and zero console warnings.
- Fresh isolated browser E2E: the same no-code journey passed through `npx playwright cli` in a temporary home; the final rendered page had zero console errors or warnings. Artifact: `output/playwright/browser-qa.png`.
- Fresh protocol-probe browser E2E: the current setup page completed Avatar creation, local-only privacy resume, paused-retry blocking, live health check, and encrypted backup creation in a temporary home; Playwright reported 0 console errors and 0 warnings. Artifact: `output/playwright/browser-protocol-probe.png`.
- OAuth progress UX: while setup or account connection awaits browser approval, the runtime persists explicit phases (`awaiting_browser_oauth`, `configuring_orchestrator`, and `running_health_checks`) and the desktop UI polls status so the user sees what is happening instead of a silent long-running request.
- Reconnect safety: a configured Avatar's `Connect account` path now creates an encrypted backup, repairs the selected adapters, runs the live MCP protocol probe, and restores the prior files/state while deleting a newly-created credential if the browser, Hermes, or health handoff fails.
- Disconnect privacy proof: an isolated provider disconnect removed the Universal credential and the exact `hugging_face.*` Hermes OAuth files, preserved an unrelated `notion.json` Hermes session, and kept rollback honest by requiring fresh provider confirmation after credential removal.
- Release clarity: the setup status exposes `local_validation` and the rendered desktop footer says `Local validation build · not public distribution`; a future public build must explicitly set its release channel.
- Remote MCP conformance harness: `radoss mcp conformance` now exercises initialize, initialized notification, session continuity, tools/list, read-only tools/call, structured method errors, credential-shaped output rejection, and hostile-Origin rejection; its fixture also proves the current REST-like shape fails the gate.
- Local health probe hardening: setup, `radoss doctor`, and the desktop health action now require a valid JSON-RPC initialize result, initialized notification, negotiated session continuity when offered, and valid `tools/list` schemas before reporting protocol health.
- Authority clarity: the desktop status API and rendered wizard expose NAAS local-control-plane availability separately from hosted-gateway readiness.
- Hosted gateway health: \`Run health check\` performs a read-only MCP protocol probe when \`RADOS_NAAS_GATEWAY_URL\` is configured, displays protocol reachability without claiming OAuth or tenant verification, and rejects non-HTTPS public endpoints.
- Retired NAAS endpoint probe: `https://api.naavos.io/mcp/v1` could not resolve in the current environment (`DNS resolution failed (ENOTFOUND)`) and must not be configured. The current verified public website is `https://naavos.radoss.agency`; the branded hosted MCP surface is now `https://mcp.naavos.radoss.agency/mcp`, backed by the deployed Worker through the Hostinger/Coolify edge route.
- Public source status **at the 2026-08-24 snapshot**: the configured NAAS GitHub repository was private at that time; no public source URL was certified in that historical snapshot. The previously documented repository URL was not a valid source authority. This historical statement is superseded by the current public-source evidence recorded in the 2026-08-25 section and the NAAS deployment evidence.
- NAAS reference QA: the current checkout passes `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, the Worker MCP fixture, and full working-tree `gitleaks dir` scanning. The branded route now passes DNS/TLS/health/OAuth metadata checks; two live production tenants and named host acceptance remain external gates.
- Live MCP doctor: Hugging Face returned a valid JSON-RPC lifecycle and `tools/list` response; Codex, Antigravity, and Hermes adapters were in sync.
- Hermes profile check: `hermes -p avatar mcp list` reports `radoss_avatar` plus `hugging_face`; `hermes -p avatar mcp test radoss_avatar` connected and discovered 11 tools. The live browser flow then completed `hermes -p avatar mcp test hugging_face`, connected to `https://huggingface.co/mcp?login`, and discovered 7 authenticated tools.
- Local control-plane correction: the real Codex, Antigravity, and Hermes Avatar-profile configuration files all contain the same `radoss_avatar` stdio command; a direct initialize/tools-list probe returned the NAAS server identity and all 11 tools.
- Native macOS Keychain helper: a dummy credential round-tripped through Keychain and was deleted; no real provider credential was used in this test.
- Encrypted snapshot proof: a dummy secret was absent from the snapshot bytes and restored correctly; the local snapshot key was mode `0600`.
- `npm pack --dry-run`: packaged only the CLI, setup surface, Tauri scaffold, libraries, and docs; the real Desktop folder was excluded.
- `npm run desktop:sidecar`: built the target-suffixed macOS arm64 Node SEA sidecar and native Keychain helper; the sidecar was ad-hoc signed for local smoke testing.
- `npx @tauri-apps/cli@latest build --debug` and `npx @tauri-apps/cli@latest build`: both completed and produced macOS `.app` and `.dmg` artifacts.
- `npm run desktop:package:macos`: re-signed the local app, regenerated the DMG from that verified app, and verified the embedded app signature and bundled sidecar; this is local ad-hoc packaging only, not public notarisation.
- Tauri reproducibility correction: `desktop-setup/src-tauri/tauri.conf.json` now resolves `beforeDevCommand` and `beforeBuildCommand` through `../bin` and `../scripts`; a fresh `npx @tauri-apps/cli@latest build` embedded the current sidecar, and packaged `/api/status` reported `Local validation build`, SQLite/FTS5, and Ollama exclusion.
- Packaged Hermes handoff: an isolated packaged setup wrote `radoss_avatar` to Hermes as the bundled sidecar `radoss-setup --mcp-stdio`; the packaged MCP handshake discovered 11 tools and the rendered UI showed `Hermes · visible orchestrator profile` with no product Ollama text.
- Packaged app smoke: launched the `.app` without a terminal or system Node process; the bundled service served `/` and `/api/status`, and the UI rendered with zero browser-console errors.
- Packaged lifecycle smoke: launching the `.app` started the bundled sidecar and returned HTTP 200; quitting the app removed the sidecar process without manual cleanup.
- Sidecar termination hardening: the bundled sidecar exits on normal Tauri quit and detects parent disappearance after force termination; both paths were rechecked against the packaged macOS app with no remaining `radoss-setup --port 49312` process.
- Packaged lifecycle E2E in an isolated home: setup, privacy pause/block, retry, backup, disconnect, rollback, and final configured state passed. Packaged setup also reported `macos_keychain`, `available: true`, `persistent: true`, `token_values: native_helper_only`.
- Packaged reconnect E2E in an isolated home: the bundled app served the UI without Node or a terminal, completed setup, completed the reconnect path with healthy protocol evidence, disconnected, rolled back, reported NAAS/local-validation/Ollama-excluded status, and left no listener on port `49312` after termination.
- Packaged public-label safety E2E: launching with `RADOS_RELEASE_CHANNEL=public` but without a release evidence manifest remained `local_validation` with `public_release: false` and `public_release_evidence_missing`; setup health and disconnect still completed successfully.
- Packaged hosted-gateway safety E2E: an insecure public `RADOS_NAAS_GATEWAY_URL` was reported as `invalid_endpoint` without a network attempt, while the packaged app remained available.
- `npm pack --dry-run` after packaging controls: the generated platform binary was excluded from the npm package; the reproducible sidecar build script was included.
- Runtime dependency hardening: the published CLI now declares only `commander`; the unused Tailwind/PostCSS build chain was removed, and both `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities.
- Security preflight: the live status surface reports value-free warnings for embedded credentials in existing Codex/Antigravity target configuration; rotation remains a user-owned release gate.
- ReMe readiness: the live environment reports ReMe not installed; the no-code surface exposes explicit install and approved-memory projection controls rather than implying it is active.
- Clean-room live ReMe E2E: a temporary home installed `reme-ai` plus its direct `agentscope` runtime import dependency, generated a Radoss local-only configuration with LLM/embedding components removed, started ReMe 0.4.1.7 over loopback HTTP without credentials, projected one approved SQLite memory to Markdown, and completed ReMe reindex. No Ollama package was installed; the real machine remained untouched.
- Hermes orchestration: the real isolated `avatar` profile now contains the local `radoss_avatar` stdio server; the default Hermes profile was not changed.
- Live Universal setup run: `node bin/radoss.mjs setup run --open-auth` completed with provider account proof (`innosaint-uche`), persistent macOS Keychain storage, Codex/Antigravity/Hermes adapter sync, Hermes Avatar-profile OAuth proof, healthy MCP protocol response, and an encrypted schema-2 backup.

## Verification record — 2026-08-25 current pass

Current source status: the `innosaint-uche/naavos` GitHub repository is public and its current CI run is recorded in the NAAS deployment evidence. The older 2026-08-24 private-repository statement above is retained only as a dated incident history.

Observed in a fresh temporary home with the browser setup surface:

- A guarded retry on the real local installation recovered the historical
  OAuth-timeout state: setup is now `configured`, Hugging Face is verified as
  `innosaint-uche`, and the existing Codex, Antigravity, and Hermes adapters
  remain in sync.
- Setup created an Avatar and configured Codex, Antigravity, and the Hermes
  `avatar` profile without terminal or configuration editing.
- Privacy `paused` blocked retry with an explicit reason; switching to
  `local_only` resumed the flow.
- Health check completed and kept local/provider evidence separate from hosted
  gateway readiness.
- Backup, restore, disconnect, and rollback completed through the UI. After
  disconnect, the provider disappeared; restoring the latest backup restored
  the provider state. Playwright reported 0 console errors and 0 warnings.
- `npm run desktop:sidecar` rebuilt the arm64 bundled sidecar and native
  Keychain helper. `npm run desktop:package:macos` regenerated and verified the
  local app and DMG.
- `codesign --verify --deep --strict` passed for the app. `spctl` rejected the
  ad-hoc app and `xcrun stapler validate` reported no stapled ticket; therefore
  signing and notarisation remain correctly blocked for public distribution.
- Live route probes returned HTTP 200 for `https://naavos.radoss.agency/` and
  `https://mcp.naavos.radoss.agency/health`, HTTP 405 for an unauthenticated
  GET to the branded MCP route (POST-only), and HTTP 401 for an unauthenticated
  MCP initialize POST with a bearer challenge. These results prove route
  behavior, not account or tenant acceptance.
- `https://api.naavos.io/mcp/v1` failed DNS resolution and remains retired.

The attached productisation PDF page-18 Evidence Standard is therefore a
machine-enforced release layer, not a reporting note: the current manifest
passes the evidence-standard block, while the public gate remains fail-closed
for missing two-live-user tenant isolation, ChatGPT/Claude host acceptance,
credential remediation, source release, signing, and notarisation evidence.

Not yet validated:

- rotation of pre-existing embedded credentials still present in the active Antigravity configuration; Radoss-created NAAS snapshots have been migrated to encrypted schema 2.
- distribution signing/notarisation, and Windows/Linux packaged builds and credential stores;
- direct automatic configuration of ChatGPT or Claude account-managed settings.
- ReMe-side search round-trip and cross-platform ReMe packaging; the isolated credential-free install/projection/reindex flow is verified, while the real machine remains ReMe-not-installed by design;
- platform credential-store validation where the OS store is unavailable; the setup now fails before opening OAuth instead of risking an unpersisted account connection;
- remediation or formal acceptance for the two development-only audit findings.

## Tauri boundary

`desktop-setup/` is the Tauri-ready setup surface. The local browser wizard and macOS packaged app are now verified. A public distribution still needs:

1. installer signing/notarisation and platform builds;
2. packaged credential-store implementations for Windows and Linux;
3. a signed packaged smoke test that proves install → setup → OAuth return → agent configuration → rollback;
4. named human acceptance of the signed packaged flow on each supported platform.

Until those gates pass, the desktop product remains **NO-GO for public release** even though the local wizard and lifecycle API are usable.

## Verification record — 2026-08-26 current source and QA pass

The Universal Avatar source is now public at
`https://github.com/innosaint-uche/radoss-universal-avatar` with the
`v0.2.0-public-source` baseline tag. The central QA harness now covers the
Codex, Antigravity, Hermes, NAAS, and packaged Tauri adapters in one run.
This expands verification coverage; it does not remove the external release
gates above.
