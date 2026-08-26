import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-universal-"));
process.env.RADOS_HOME = home;
process.env.RADOSS_NO_OPEN = "1";
process.env.RADOS_TOKEN_STORE = "memory";

const runtime = await import("../lib/setup-runtime.mjs");
const state = await import("../lib/setup-state.mjs");
const registry = await import("../lib/mcp-registry.mjs");
const memory = await import("../lib/avatar-memory.mjs");
const reme = await import("../lib/reme.mjs");
const oauth = await import("../lib/oauth.mjs");

function seedAgentFiles() {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  fs.mkdirSync(path.join(home, ".hermes", "profiles", "avatar"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "[mcp_servers.existing]\nurl = \"https://example.com/mcp\"\n\n");
  fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), `${JSON.stringify({ mcpServers: { existing: { serverUrl: "https://example.com/mcp" } } }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "profile: avatar\n");
}

function seedHermesOAuthFiles() {
  const tokenDir = path.join(home, ".hermes", "profiles", "avatar", "mcp-tokens");
  fs.mkdirSync(tokenDir, { recursive: true });
  for (const name of ["hugging_face.json", "hugging_face.client.json", "hugging_face.meta.json", "hugging_face.cimd-off", "notion.json"]) {
    fs.writeFileSync(path.join(tokenDir, name), "fixture-secret-not-read\n");
  }
}

test("setup configures known agents, opens provider login, and records evidence", async () => {
  seedAgentFiles();
  const result = await runtime.runSetup({ openAuth: true });
  assert.equal(result.provider.id, "huggingface");
  assert.equal(result.auth.status, "browser_open_skipped");
  assert.equal(result.health.status, "healthy");
  assert.equal(result.status.setup.status, "configured");
  assert.equal(result.status.setup.last_failed_at, null);
  assert.equal(result.status.release.public_release, false);
  assert.equal(result.status.release.label, "Local validation build");
  assert.ok(result.status.avatar.id);
  assert.equal(result.status.avatar.name, "My Avatar");
  assert.equal(result.status.memory.status, "ready");
  assert.equal(result.status.memory.fts5, true);
  assert.deepEqual(result.status.setup.last_request.targets, ["codex", "antigravity", "hermes"]);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /huggingface/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /mcp_servers\.radoss_avatar/);
  assert.match(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"), /huggingface/);
  assert.match(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"), /radoss_avatar/);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "utf8"), /hugging_face/);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "utf8"), /mcp\?login/);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "utf8"), /cimd: false/);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "utf8"), /radoss_avatar/);
});

test("setup reuses a valid secure-store session instead of reopening browser OAuth", async () => {
  seedAgentFiles();
  oauth.getTokenStore().set("oauth:huggingface", { access_token: "cached-fixture-access-token" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_endpoint, options) => {
    const message = JSON.parse(options.body);
    const headers = { "content-type": "application/json", "mcp-session-id": "cached-fixture-session" };
    if (message.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "cached-fixture", version: "1" } }
      }), { status: 200, headers });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202, headers });
    if (message.method === "tools/list") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "avatar_status", inputSchema: { type: "object" } }] }
      }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }), { status: 200, headers });
  };
  try {
    const result = await runtime.runSetup({ openAuth: true, avatarName: "Cached Avatar" });
    assert.equal(result.auth.status, "authenticated");
    assert.equal(result.auth.mode, "secure_store_cached");
    assert.equal(result.auth.verification, "secure_store_credential_verified");
    assert.equal(result.status.setup.status, "configured");
    assert.equal(result.status.avatar.name, "Cached Avatar");
  } finally {
    globalThis.fetch = originalFetch;
    oauth.deleteStoredToken("huggingface");
  }
});

test("Hermes can discover the NAAS local orchestrator over stdio MCP", async () => {
  const child = spawn(process.execPath, [path.resolve("bin/radoss-mcp.mjs")], { env: { ...process.env, RADOS_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  const waitFor = (id) => new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const message = messages.find((item) => item.id === id);
      if (message) { clearInterval(timer); resolve(message); }
    }, 10);
    setTimeout(() => { clearInterval(timer); reject(new Error(`MCP response ${id} timed out`)); }, 2000);
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`);
    assert.equal((await waitFor(1)).result.serverInfo.name, "radoss-naas-avatar");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const tools = (await waitFor(2)).result.tools;
    assert.ok(tools.some((tool) => tool.name === "avatar_setup"));
    assert.ok(tools.some((tool) => tool.name === "avatar_status"));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "avatar_status", arguments: {} } })}\n`);
    assert.doesNotMatch((await waitFor(3)).result.content[0].text, /access_token|refresh_token/i);
  } finally {
    child.kill("SIGTERM");
  }
});

test("security status detects embedded credentials without returning their values", async () => {
  const configPath = path.join(home, ".gemini", "config", "mcp_config.json");
  const original = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: { existing: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_dummy_secret_value" } } }
  }));
  try {
    const status = await runtime.setupStatus();
    assert.ok(status.security_warnings.some((warning) => warning.target === "antigravity" && warning.field.includes("GITHUB_PERSONAL_ACCESS_TOKEN")));
    assert.doesNotMatch(JSON.stringify(status), /ghp_dummy_secret_value/);
  } finally {
    fs.writeFileSync(configPath, original);
  }
});

test("memory capture is approval-gated and searchable through local FTS5", () => {
  const avatarId = state.loadSetupState().avatar.id;
  assert.equal(memory.remember({ avatarId, content: "Prefer concise release reports" }).status, "pending_approval");
  assert.equal(memory.remember({ avatarId, content: "Prefer concise release reports", approved: true }).status, "stored");
  const results = memory.searchMemory({ avatarId, query: "concise release" });
  assert.equal(results.length, 1);
  assert.match(results[0].content, /concise/);
});

test("ReMe is reported as an optional projection without installation or writes", async () => {
  const status = await reme.inspectReMe({ executable: "/definitely/missing/reme" });
  assert.equal(status.canonical_memory, "sqlite_fts5");
  assert.equal(status.install_action, "user_initiated_only");
  assert.equal(status.status, "not_installed");
  assert.equal(status.projection, "not_available");
});

test("ReMe projection requires explicit confirmation and does not run while paused", async () => {
  const instance = await runtime.createSetupServer({ open: false });
  try {
    const response = await fetch(`${instance.url}api/memory/reme/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /confirmation/i);
    runtime.setPrivacyMode("paused");
    const paused = await fetch(`${instance.url}api/memory/reme/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(paused.status, 400);
    assert.match((await paused.json()).error, /paused/i);
    runtime.setPrivacyMode("local_only");
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
  }
});

test("retry repeats the last request and creates a fresh backup", async () => {
  const before = state.listSnapshots().length;
  const result = await runtime.retrySetup({ openAuth: false });
  assert.equal(result.health.status, "healthy");
  assert.equal(result.auth.status, "not_opened");
  assert.ok(state.listSnapshots().length > before);
  assert.equal(state.loadSetupState().setup.status, "configured");
});

test("failed setup is recorded and restores the pre-run configuration", async () => {
  await assert.rejects(runtime.runSetup({ provider: "missing-provider", openAuth: false }), /Unknown provider/);
  const failed = state.loadSetupState();
  assert.equal(failed.setup.status, "failed");
  assert.equal(failed.setup.phase, "error");
  assert.equal(failed.setup.last_request.provider, "missing-provider");
  assert.ok(registry.loadRegistry().servers.huggingface);
});

test("health failure blocks a successful setup claim", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(runtime.runSetup({ provider: "huggingface", openAuth: false }), /health check failed/);
    assert.equal(state.loadSetupState().setup.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed account reconnect restores adapters and removes a newly-created credential", async () => {
  const codexPath = path.join(home, ".codex", "config.toml");
  const originalCodex = fs.readFileSync(codexPath, "utf8");
  const tokenStore = oauth.createMemoryTokenStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      runtime.connectProvider("huggingface", { tokenStore }),
      /health check failed/
    );
    assert.equal(tokenStore.get("oauth:huggingface"), null);
    assert.equal(fs.readFileSync(codexPath, "utf8"), originalCodex);
    assert.equal(state.loadSetupState().setup.status, "failed");
    assert.equal(registry.loadRegistry().servers.huggingface?.id, "huggingface");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("privacy modes are explicit and telemetry remains disabled", async () => {
  const privacy = runtime.setPrivacyMode("paused");
  assert.equal(privacy.mode, "paused");
  assert.equal(privacy.telemetry, false);
  await assert.rejects(runtime.runSetup({ openAuth: false }), /paused/);
  runtime.setPrivacyMode("local_only");
});

test("disconnect creates a backup and removes only the registered provider", async () => {
  const beforeDisconnect = state.loadSetupState();
  beforeDisconnect.providers.huggingface = {
    ...(beforeDisconnect.providers.huggingface ?? {}),
    auth_status: "authenticated",
    auth_verification: "provider_userinfo_verified",
    account: { username: "fixture-user" }
  };
  state.saveSetupState(beforeDisconnect);
  oauth.getTokenStore().set("oauth:huggingface", { access_token: "fixture-access-token" });
  seedHermesOAuthFiles();
  const result = await runtime.disconnectProvider("huggingface");
  assert.ok(result.backup.id);
  assert.deepEqual(result.credential, { status: "deleted", deleted: true });
  assert.deepEqual(result.hermes_auth.status, "deleted");
  const tokenDir = path.join(home, ".hermes", "profiles", "avatar", "mcp-tokens");
  for (const name of ["hugging_face.json", "hugging_face.client.json", "hugging_face.meta.json", "hugging_face.cimd-off"]) {
    assert.equal(fs.existsSync(path.join(tokenDir, name)), false);
  }
  assert.equal(fs.existsSync(path.join(tokenDir, "notion.json")), true);
  assert.equal(oauth.getTokenStore().get("oauth:huggingface"), null);
  assert.equal(registry.loadRegistry().servers.huggingface, undefined);
  assert.equal(state.loadSetupState().agents.codex.configured, true);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /existing/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /huggingface/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /mcp_servers\.radoss_avatar/);
  assert.match(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"), /radoss_avatar/);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "profiles", "avatar", "config.yaml"), "utf8"), /radoss_avatar/);
});

test("rollback restores the setup snapshot", () => {
  const backups = state.listSnapshots();
  const disconnectBackup = backups.find((item) => item.reason === "disconnect-provider");
  assert.ok(disconnectBackup);
  runtime.rollbackBackup(disconnectBackup.id);
  assert.ok(registry.loadRegistry().servers.huggingface);
  assert.equal(state.loadSetupState().providers.huggingface.auth_status, "pending_provider_confirmation");
  assert.equal(state.loadSetupState().agents.codex.configured, true);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /huggingface/);
});

test("local setup server exposes a usable status API", async () => {
  const instance = await runtime.createSetupServer({ open: false });
  const rootResponse = await fetch(instance.url);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type"), /text\/html/);
  assert.match(rootResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(rootResponse.headers.get("x-content-type-options"), "nosniff");
  const rootHtml = await rootResponse.text();
  assert.doesNotMatch(rootHtml, /ollama/i);
  assert.match(rootHtml, /Where your Avatar lives/);
  const scriptResponse = await fetch(`${instance.url}app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(await scriptResponse.text(), /Connect account/);
  const faviconResponse = await fetch(`${instance.url}favicon.svg`);
  assert.equal(faviconResponse.status, 200);
  const response = await fetch(`${instance.url}api/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.product, "Radoss Universal Avatar");
  assert.equal(body.authority.name, "NAAS");
  assert.equal(body.authority.local_control_plane.status, "available");
  assert.ok(["not_configured", "configured_unverified"].includes(body.authority.hosted_gateway.status));
  assert.equal(body.capabilities.ollama, "excluded");
  assert.equal(body.agents.chatgpt.mode, "account_ui");
  assert.equal(body.agents.chatgpt.configured, false);
  assert.equal(body.agents.claude.mode, "account_ui");
  assert.equal(body.agents.claude.configured, false);
  assert.match(body.agents.chatgpt.note, /cannot edit account settings/i);
  const setupResponse = await fetch(`${instance.url}api/setup/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ openAuth: false })
  });
  assert.equal(setupResponse.status, 200);
  const setupBody = await setupResponse.json();
  assert.equal(setupBody.health.status, "healthy");
  assert.equal(setupBody.auth.status, "not_opened");
  const authResponse = await fetch(`${instance.url}api/auth/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "huggingface" })
  });
  assert.equal(authResponse.status, 200);
  const authBody = await authResponse.json();
  assert.equal(authBody.status, "browser_open_skipped");
  assert.ok(authBody.backup.id);
  assert.equal(authBody.health.status, "healthy");
  const hostResponse = await fetch(`${instance.url}api/host/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "chatgpt" })
  });
  assert.equal(hostResponse.status, 200);
  assert.equal((await hostResponse.json()).status, "browser_open_skipped");
  const invalidHostResponse = await fetch(`${instance.url}api/host/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "unknown" })
  });
  assert.equal(invalidHostResponse.status, 400);
  const privacyResponse = await fetch(`${instance.url}api/privacy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "local_only" })
  });
  assert.equal(privacyResponse.status, 200);
  const remeSetupResponse = await fetch(`${instance.url}api/memory/reme/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: false })
  });
  assert.equal(remeSetupResponse.status, 400);
  assert.match((await remeSetupResponse.json()).error, /confirmation/i);
  await new Promise((resolve) => instance.server.close(resolve));
});

test("public release labels require complete external evidence", async () => {
  const previousChannel = process.env.RADOS_RELEASE_CHANNEL;
  const previousEvidence = process.env.RADOS_RELEASE_EVIDENCE_FILE;
  const evidencePath = path.join(home, "release-evidence.json");
  process.env.RADOS_RELEASE_CHANNEL = "public";
  delete process.env.RADOS_RELEASE_EVIDENCE_FILE;
  try {
    const blocked = await runtime.setupStatus();
    assert.equal(blocked.release.public_release, false);
    assert.equal(blocked.release.channel, "local_validation");
    assert.equal(blocked.release.reason, "public_release_evidence_missing");
    fs.writeFileSync(evidencePath, `${JSON.stringify({
      evidence_standard: {
        version: "1.0",
        source_authority: "docs/design/NAAS-Avatar-OS-Productisation-System-Design.pdf#page=18",
        fact_recommendation_separation: "enforced",
        adapter_reverification: "required_on_host_change",
        adapter_records: [{
          adapter: "fixture",
          status: "observed",
          fact_sources: ["fixture-source"],
          verified_at: "2026-08-25"
        }]
      },
      release_identity: { source_marker: "source-sha", deployment_id: "deployment-id" },
      remote_gateway: {
        conformance: "pass",
        oauth: "pass",
        tenant_isolation: "pass",
        branded_route: "verified"
      },
      host_acceptance: { chatgpt: "accepted", claude: "accepted" },
      source_release: { visibility: "public", repository: "verified", clean_tag: "verified" },
      security: { secret_scan: "pass", credential_remediation: "verified" },
      distribution: { signing: "verified", notarization: "verified", platforms: "verified" }
    })}\n`);
    process.env.RADOS_RELEASE_EVIDENCE_FILE = evidencePath;
    const verified = await runtime.setupStatus();
    assert.equal(verified.release.public_release, true);
    assert.equal(verified.release.channel, "public");
  } finally {
    if (previousChannel === undefined) delete process.env.RADOS_RELEASE_CHANNEL;
    else process.env.RADOS_RELEASE_CHANNEL = previousChannel;
    if (previousEvidence === undefined) delete process.env.RADOS_RELEASE_EVIDENCE_FILE;
    else process.env.RADOS_RELEASE_EVIDENCE_FILE = previousEvidence;
    fs.rmSync(evidencePath, { force: true });
  }
});

test("hosted gateway health is read-only, endpoint-scoped, and token-free", async () => {
  const previous = process.env.RADOS_NAAS_GATEWAY_URL;
  delete process.env.RADOS_NAAS_GATEWAY_URL;
  try {
    assert.equal((await runtime.inspectHostedGateway()).status, "not_configured");
    process.env.RADOS_NAAS_GATEWAY_URL = "http://127.0.0.1:45678/mcp";
    const fakeFetch = async (_endpoint, options) => {
      const message = JSON.parse(options.body);
      const headers = { "content-type": "application/json", "mcp-session-id": "hosted-fixture" };
      if (message.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "hosted-fixture", version: "1" } } }), { status: 200, headers });
      if (message.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (message.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "avatar_status", inputSchema: { type: "object" } }] } }), { status: 200, headers });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }), { status: 200, headers });
    };
    const healthy = await runtime.inspectHostedGateway({ fetchImpl: fakeFetch });
    assert.equal(healthy.status, "protocol_healthy");
    assert.equal(healthy.protocol.tools_count, 1);
    assert.doesNotMatch(JSON.stringify(healthy), /access_token|refresh_token|authorization/i);
    process.env.RADOS_NAAS_GATEWAY_URL = "http://public.example/mcp";
    assert.equal((await runtime.inspectHostedGateway()).status, "invalid_endpoint");
  } finally {
    if (previous === undefined) delete process.env.RADOS_NAAS_GATEWAY_URL;
    else process.env.RADOS_NAAS_GATEWAY_URL = previous;
  }
});

test("local API rejects untrusted browser origins while allowing the setup UI", async () => {
  const instance = await runtime.createSetupServer({ open: false });
  try {
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ agent: "chatgpt" })
    };
    const rejected = await fetch(`${instance.url}api/host/open`, request);
    assert.equal(rejected.status, 403);
    assert.match((await rejected.json()).error, /origin/i);

    const trusted = await fetch(`${instance.url}api/host/open`, {
      ...request,
      headers: { ...request.headers, origin: new URL(instance.url).origin }
    });
    assert.equal(trusted.status, 200);
    assert.equal((await trusted.json()).status, "browser_open_skipped");

    const tauri = await fetch(`${instance.url}api/host/open`, {
      ...request,
      headers: { ...request.headers, origin: "tauri://localhost" }
    });
    assert.equal(tauri.status, 200);
    assert.equal((await tauri.json()).status, "browser_open_skipped");
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
  }
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
