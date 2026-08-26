# Remote MCP gateway contract

## Decision

The local Tauri sidecar is the canonical no-code setup control plane. It must
not be exposed directly to the public internet or presented as a ChatGPT or
Claude connector. Those hosts require a reachable HTTPS MCP endpoint and their
own account-managed connection flow.

The deployed remote gateway is a separate deployment boundary:

```text
Tauri + local sidecar
  ├─ owns Avatar setup, local SQLite/FTS5, backups and privacy controls
  └─ configures local Codex, Antigravity and Hermes

HTTPS remote MCP gateway
  ├─ authenticates a user with OAuth 2.1 + S256 PKCE
  ├─ resolves only that user's approved Avatar projection
  └─ serves ChatGPT, Claude and other hosted MCP clients
```

NAAS remains the Avatar authority. Supabase may provide durable cloud storage
or synchronisation, but it must not silently become identity, consent or policy
authority. ReMe remains a readable projection, never the remote source of truth.

## Required protocol surface

The gateway is not ready until it passes a standards-conformant Streamable HTTP
MCP harness for:

1. `initialize` with negotiated protocol version and server capabilities;
2. `notifications/initialized`;
3. `tools/list` with stable, scoped tool schemas;
4. `tools/call` with request correlation and structured JSON-RPC errors;
5. invalid method, unknown tool, malformed body, timeout and oversized-request
   handling;
6. session and transport rules required by the selected MCP specification.

The Universal project includes an executable version of this gate:

```bash
npx radoss mcp conformance https://your-gateway.example/mcp
```

If the endpoint requires a bearer token for a controlled test, pass only the
name of an environment variable; never put the token on the command line:

```bash
npx radoss mcp conformance https://your-gateway.example/mcp --bearer-env RADOSS_GATEWAY_TOKEN --status-tool avatar_get
```

The harness emits token-free evidence and deliberately rejects REST-like
responses, missing lifecycle methods, malformed tool schemas, credential-shaped
tool output, JSON-RPC method errors that are not structured, and hostile browser
origins. Use `--allow-origin` only for a non-browser server that has a separately
documented origin policy.

`--status-tool` is required when a gateway's read-only health tool is not named
`avatar_status`; NAAS uses `avatar_get`.

The current NAAS Worker in the NAAS repository's `apps/mcp-server/` directory
implements this contract. The user-facing branded route is
`https://mcp.naavos.radoss.agency/mcp`; the Worker URL
`https://naavos-mcp.innosaint-uche.workers.dev/mcp` remains an implementation
and test origin.

## Required security boundary

- OAuth discovery and S256 PKCE are mandatory; no pasted codes or tokens.
- Validate issuer, redirect URI, state, PKCE, token expiry, audience and scopes.
- Map the authenticated subject to one Avatar tenant; never accept an arbitrary
  identity header as authorization.
- Use a strict Origin/CORS allowlist; never `Access-Control-Allow-Origin: *` for
  authenticated data.
- Keep provider tokens in the server-side credential boundary; never place them
  in Avatar state, generated agent files, logs, screenshots or MCP tool output.
- Enforce user, project and memory-scope authorization on every read and write.
- Default to read-only Avatar context tools; require explicit confirmation for
  mutations and record an audit event.

## No-code client experience

The desktop wizard should show ChatGPT and Claude as **host-managed** until the
gateway is deployed and its HTTPS/OAuth checks pass. The user clicks a host
connection button, completes the provider's browser flow, and returns to the
wizard for a provider-status refresh. The wizard must never claim that opening a
host page proves the account is connected.

## Acceptance evidence for removing the NO-GO

- deployed HTTPS endpoint and exact release SHA;
- MCP lifecycle, transport and auth conformance report;
- two isolated users cannot read or mutate each other's Avatar state;
- OAuth revoke, expiry and retry behavior verified;
- ChatGPT and Claude host acceptance recorded by a named human;
- rollback and disconnect remove only the remote connection, not canonical local
  Avatar data;
- no secret values in logs, diagnostics or generated configuration.
