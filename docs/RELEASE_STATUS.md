# NAAvOS Avatar OS release status

Updated: 2026-08-31 (Africa/Lagos)

## What this project is

NAAvOS Avatar OS is a user-owned, personal Avatar setup and connection
layer. It is intended to let a non-technical user create an Avatar, choose
privacy, approve account connections in a browser, and carry the Avatar's
preferences and governed memory across supported AI hosts.

The required product path is:

1. no-code Tauri setup;
2. browser OAuth with no copied codes or tokens;
3. local SQLite + FTS5 canonical memory;
4. Hermes as the visible layered orchestrator;
5. guarded adapters for Codex, Antigravity, Hermes, and hosted AI clients;
6. a branded, authenticated NAAvOS MCP authority;
7. explicit privacy, backup, rollback, disconnect, export, and deletion paths;
8. public source and contributor documentation.

Ollama is not part of the default public path. ReMe is an optional projection.
MemU, NotebookLM, Supabase, and Firebase are integration candidates, not
claims of completed production features in this baseline.

## Current status by release surface

| Surface | Status | Evidence |
| --- | --- | --- |
| Public source for developers | Available | [repository](https://github.com/innosaint-uche/radoss-universal-avatar), current `main` at the latest verified commit; `v0.2.0-public-source` is the earlier tagged baseline |
| NAAvOS public source mirror | Available | [repository](https://github.com/innosaint-uche/naavos), tag `v0.1.0-public-source` |
| Local CLI and adapters | Validated locally | 38/38 Universal tests; central `local-agents` QA passed in aggregate run `2026-08-31T01:26:34Z` |
| Packaged macOS no-code journey | Validated locally | Central Tauri adapter passed isolated setup/persistence journey |
| Cross-platform unsigned build path | Previously passed for macOS `.app`/`.dmg`, Windows `.msi`, and Linux `.deb`/`.rpm` | Manual `Desktop build (unsigned)` run `33342208151`; this is not signing, notarisation, or current-platform acceptance evidence |
| Public dashboard | Live controlled-development surface | `https://naavos.radoss.agency` returned HTTP 200 |
| Branded MCP route | Live and protocol-protected | `https://mcp.naavos.radoss.agency/mcp` with health/OAuth discovery verified |
| Individual local handoff profile | Implemented as a separate fail-closed gate | `RADOS_RELEASE_CHANNEL=individual_local`; does not claim hosted multi-user or ChatGPT/Claude acceptance |
| Individual hosted handoff profile | Implemented as a separate fail-closed gate | `RADOS_RELEASE_CHANNEL=individual_hosted`; proves one user's endpoint and owner isolation without claiming shared NAAvOS tenancy |
| Customer-ready hosted release | Not yet approved | External evidence below remains open |

## Current verification snapshot — 2026-08-31

The following checks were rerun after the isolated sample and branding updates:

| Check | Result | Evidence |
| --- | --- | --- |
| Universal unit/integration tests | PASS — 38/38 | `npm test` on `cd5af87` |
| Public package preflight | PASS — 102 files scanned | `npm run public:preflight` |
| Production dependency audit | PASS — 0 high/critical vulnerabilities | `npm audit --omit=dev --audit-level=high` |
| npm package shape | PASS — `naavos-cli@0.2.0`, 98 files | `npm pack --dry-run` |
| Universal source CI | PASS | GitHub Actions run `33347485036`, SHA `cd5af87`; the later evidence-documentation commit also passed run `33347656074` |
| NAAvOS mirror CI | PASS | GitHub Actions run `33345403980`, SHA `bb5702f` |
| Central local-agent adapter | PASS | Aggregate adapter `local-agents` |
| Live NAAvOS route adapter | PASS | Aggregate adapter `naas-public` |
| Packaged Tauri adapter | PASS | Aggregate adapter `universal-tauri-macos`; isolated state verified |
| Sample tester artifact | PASS — isolated DMG and ZIP checksum verified | `NAAvOS-Sample-Test-macOS.dmg` and sendable tester bundle |

These are technical and packaging results. They do not replace the external
acceptance gates listed below.

## Why customer release is still gated

The shared-hosted release items below are not code-test failures. They require
independent production or account-level proof. They do not block a genuinely
local or user-owned single-hosted handoff once that profile's own signing,
security, endpoint, and owner-isolation gates are complete:

- two independent live users must demonstrate tenant isolation;
- ChatGPT and Claude must each be accepted in their own host UI;
- pre-existing embedded Antigravity credentials must be rotated or removed;
- production signing, Apple notarisation, and Windows/Linux package evidence
  must be recorded.

The old `https://api.naavos.io/mcp/v1` endpoint is retired and must never be
configured. The current branded route is the only documented public MCP route.

## Verification method

All projects use the external `~/.radoss-qa` harness. Projects contribute thin
adapters; they do not receive duplicate Playwright, browser binaries, or Rust.
The aggregate run covers local agents, the live NAAS surface, and the packaged
Tauri app. Technical green status does not replace the four external release
acceptance layers above.

## Contributor rule

Do not change a release claim, endpoint, OAuth boundary, memory authority, or
agent adapter without updating the evidence record and rerunning the relevant
central adapter. Facts, recommendations, and named human acceptance must remain
separate.
