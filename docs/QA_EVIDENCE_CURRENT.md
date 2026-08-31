# NAAvOS current QA evidence

Updated: 2026-08-31 (Africa/Lagos)

This is a time-bound evidence snapshot, not a public-release declaration.
The central reusable harness is maintained outside project repositories at
`~/.radoss-qa`; project adapters describe the real surface without copying
Playwright, browser binaries, or Rust into this repository.

## Aggregate run

- Run started: `2026-08-31T01:28:26Z`
- Result: **PASS**
- `local-agents`: PASS
- `naas-public`: PASS
- `universal-tauri-macos`: PASS
- token values written: **false**
- sample/package state: isolated temporary state; no personal agent paths used

## Evidence covered

- Codex, Antigravity, and Hermes adapter marker/config checks.
- Token-free `radoss doctor` health assertions.
- `https://naavos.radoss.agency/` HTTP 200.
- `https://mcp.naavos.radoss.agency/health` HTTP 200.
- OAuth protected-resource discovery HTTP 200.
- Unauthenticated MCP initialize rejected with HTTP 401 and bearer challenge.
- Tauri startup, sidecar readiness, setup UI, privacy mutation/readback,
  encrypted backup, persistence, and user-owned Cloudflare hosting selection.
- Tauri sidecar readiness used an ephemeral loopback port (`127.0.0.1:62246` in
  this run), proving the sample does not guess or reuse another installation's
  fixed port.
- A separate simultaneous-launch check ran the normal and sample bundles at
  the same time on `127.0.0.1:62075` and `127.0.0.1:62097`; both returned HTTP
  200 and the sample used its isolated bundle identifier and state root.

## Warnings and limits

The local-agent adapter reported two pre-existing embedded credential fields in
the personal Antigravity configuration. Values were not read, printed, or
modified. They must be rotated or removed by the account owner before any
public distribution claim.

This run does not prove two independent live production tenants, ChatGPT or
Claude host acceptance, production signing/notarisation, or cross-platform
customer distribution. Those remain fail-closed release gates.
