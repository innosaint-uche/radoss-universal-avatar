# Universal Avatar release status

Updated: 2026-08-31 (Africa/Lagos)

## What this project is

Radoss Universal Avatar is a user-owned, personal Avatar setup and connection
layer. It is intended to let a non-technical user create an Avatar, choose
privacy, approve account connections in a browser, and carry the Avatar's
preferences and governed memory across supported AI hosts.

The required product path is:

1. no-code Tauri setup;
2. browser OAuth with no copied codes or tokens;
3. local SQLite + FTS5 canonical memory;
4. Hermes as the visible layered orchestrator;
5. guarded adapters for Codex, Antigravity, Hermes, and hosted AI clients;
6. a branded, authenticated NAAS MCP authority;
7. explicit privacy, backup, rollback, disconnect, export, and deletion paths;
8. public source and contributor documentation.

Ollama is not part of the default public path. ReMe is an optional projection.
MemU, NotebookLM, Supabase, and Firebase are integration candidates, not
claims of completed production features in this baseline.

## Current status by release surface

| Surface | Status | Evidence |
| --- | --- | --- |
| Public source for developers | Available | [repository](https://github.com/innosaint-uche/radoss-universal-avatar), current `main` at `f61d85b`; clean source tag `v0.2.0-public-source` |
| NAAS public source mirror | Available | [repository](https://github.com/innosaint-uche/naavos), tag `v0.1.0-public-source` |
| Local CLI and adapters | Validated locally | 31 universal tests; central `local-agents` QA passed |
| Packaged macOS no-code journey | Validated locally | Central Tauri adapter passed isolated setup/persistence journey |
| Cross-platform unsigned build path | Passed for macOS `.app`/`.dmg`, Windows `.msi`, and Linux `.deb`/`.rpm` | Manual `Desktop build (unsigned)` run `33342208151` on runtime commit `3ce82c0`; the current `8e3407b` delta is README-only; AppImage, signing, and OS credential stores remain separate gates |
| Public dashboard | Live controlled-development surface | `https://naavos.radoss.agency` returned HTTP 200 |
| Branded MCP route | Live and protocol-protected | `https://mcp.naavos.radoss.agency/mcp` with health/OAuth discovery verified |
| Individual local handoff profile | Implemented as a separate fail-closed gate | `RADOS_RELEASE_CHANNEL=individual_local`; does not claim hosted multi-user or ChatGPT/Claude acceptance |
| Customer-ready hosted release | Not yet approved | External evidence below remains open |

## Why customer release is still gated

The hosted-release items below are not code-test failures. They require
independent production or account-level proof. They do not block a genuinely
local-only individual handoff once that profile's signing and security gates
are complete:

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
