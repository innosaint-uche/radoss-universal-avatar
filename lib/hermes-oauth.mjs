import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openExternal } from "./oauth.mjs";

const PROFILE = "avatar";
const HERMES_SERVER_NAMES = { huggingface: "hugging_face" };
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const execFileAsync = promisify(execFile);

function home() {
  return process.env.RADOS_HOME ?? os.homedir();
}

function hermesRoot() {
  return process.env.RADOS_HERMES_ROOT ?? path.join(home(), ".hermes");
}

function hermesAgentRoot() {
  return process.env.RADOS_HERMES_AGENT_ROOT ?? path.join(hermesRoot(), "hermes-agent");
}

function hermesProfileHome() {
  return path.join(hermesRoot(), "profiles", PROFILE);
}

function pythonCandidates() {
  const root = hermesAgentRoot();
  return [
    process.env.RADOS_HERMES_PYTHON,
    path.join(root, "venv", "bin", "python"),
    path.join(root, "venv", "bin", "python3"),
    "python3",
    "python"
  ].filter(Boolean);
}

function findHermesPython() {
  return pythonCandidates().find((candidate) => candidate === "python3" || candidate === "python" || fs.existsSync(candidate)) ?? null;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "[provider URL]");
}

function providerServerName(providerName) {
  return HERMES_SERVER_NAMES[providerName] ?? providerName;
}

function hermesOAuthPaths(providerName, profileHome = hermesProfileHome()) {
  const serverName = providerServerName(providerName);
  const tokenDirectory = path.join(profileHome, "mcp-tokens");
  return [
    `${serverName}.json`,
    `${serverName}.client.json`,
    `${serverName}.meta.json`,
    `${serverName}.cimd-off`
  ].map((name) => path.join(tokenDirectory, name));
}

function presentHermesOAuthFiles(providerName, profileHome = hermesProfileHome()) {
  return hermesOAuthPaths(providerName, profileHome)
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => path.basename(filePath));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isolatedTestResult(reason = "isolated_test_home") {
  return {
    provider: "huggingface",
    profile: PROFILE,
    status: "not_checked",
    verification: "not_checked",
    reason
  };
}

class HermesGatewayClient {
  constructor({ spawnImpl = spawn, python = findHermesPython(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.spawnImpl = spawnImpl;
    this.python = python;
    this.timeoutMs = timeoutMs;
    this.agentRoot = hermesAgentRoot();
    this.profileHome = hermesProfileHome();
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
  }

  start() {
    if (!this.python || !fs.existsSync(this.agentRoot)) throw new Error("Hermes runtime is not installed");
    this.child = this.spawnImpl(this.python, ["-m", "tui_gateway.entry"], {
      cwd: this.agentRoot,
      env: {
        ...process.env,
        HERMES_HOME: this.profileHome,
        PYTHONPATH: [this.agentRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        NO_COLOR: "1",
        TERM: "dumb"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("exit", (code, signal) => {
      if (!this.ready) this.failPending(new Error(`Hermes gateway exited (${code ?? signal ?? "unknown"})`));
    });
    this.ready = true;
    return this;
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || message.id === null) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Hermes gateway request failed"));
      else pending.resolve(message.result ?? null);
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Hermes gateway is not available"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close() {
    this.failPending(new Error("Hermes gateway closed"));
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.stdin?.end(); } catch { /* already closed */ }
    await wait(100);
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
    }
  }
}

async function cachedHermesAuth(client, serverName) {
  const listed = await client.request("mcp.servers.list", {});
  const server = (listed?.servers ?? []).find((entry) => entry.name === serverName);
  if (!server) return null;
  if (!server.oauth_tokens_present) return { configured: true, authenticated: false };
  const tested = await client.request("mcp.servers.test", { name: serverName });
  if (!tested?.ok || tested.oauth_tokens_present !== true) return { configured: true, authenticated: false };
  return { configured: true, authenticated: true, tools: Array.isArray(tested.tools) ? tested.tools.length : 0 };
}

/**
 * Complete Hermes's own MCP OAuth flow in the named Avatar profile.
 *
 * This deliberately does not read, copy, return, or store a Radoss token.
 * Hermes persists its own OAuth bundle through its own credential machinery;
 * Radoss receives only token-free status evidence.
 */
export async function ensureHermesMcpOAuth(providerName = "huggingface", {
  openBrowser = openExternal,
  spawnImpl = spawn,
  python = findHermesPython(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS
} = {}) {
  if (process.env.RADOS_HOME) return isolatedTestResult();
  const serverName = providerServerName(providerName);
  const client = new HermesGatewayClient({ spawnImpl, python, timeoutMs });
  try {
    client.start();
    const cached = await cachedHermesAuth(client, serverName);
    if (cached?.authenticated) {
      return {
        provider: providerName,
        profile: PROFILE,
        status: "authenticated",
        verification: "hermes_mcp_probe_with_cached_oauth",
        tools: cached.tools
      };
    }

    const started = await client.request("mcp.servers.oauth.start", { name: serverName });
    if (!started?.auth_url || !started.session_id) throw new Error("Hermes did not return a browser OAuth session");
    const opened = await openBrowser(started.auth_url);
    if (opened?.skipped) {
      return {
        provider: providerName,
        profile: PROFILE,
        status: "browser_open_skipped",
        verification: "pending_provider_confirmation",
        session: "hermes_gateway_oauth"
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await client.request("mcp.servers.oauth.poll", { name: serverName, session_id: started.session_id }, Math.min(timeoutMs, 30_000));
      if (result?.status === "approved") {
        return {
          provider: providerName,
          profile: PROFILE,
          status: "authenticated",
          verification: "hermes_mcp_oauth_approved",
          tools: Array.isArray(result.tools) ? result.tools.length : 0
        };
      }
      if (result?.status === "error") throw new Error(result.error_message || "Hermes OAuth was not completed");
      await wait(pollIntervalMs);
    }
    throw new Error("Hermes OAuth callback timed out");
  } catch (error) {
    throw new Error(`Hermes account connection failed: ${safeError(error)}`);
  } finally {
    await client.close();
  }
}

/**
 * Remove only the selected provider's Hermes OAuth bundle. The cleanup uses
 * Hermes' public remover in a real profile and exact, isolated fixture paths
 * in tests. It never reads or returns token contents.
 */
export async function disconnectHermesMcpOAuth(providerName = "huggingface") {
  const profileHome = hermesProfileHome();
  const before = presentHermesOAuthFiles(providerName, profileHome);
  if (!before.length) {
    return { provider: providerName, profile: PROFILE, status: "absent", deleted: false, files: [] };
  }

  if (process.env.RADOS_HOME) {
    for (const filePath of hermesOAuthPaths(providerName, profileHome)) fs.rmSync(filePath, { force: true });
  } else {
    const python = findHermesPython();
    if (!python || !fs.existsSync(hermesAgentRoot())) throw new Error("Hermes OAuth cleanup is unavailable");
    const script = [
      "import sys",
      "from tools.mcp_oauth import remove_oauth_tokens",
      "remove_oauth_tokens(sys.argv[1], hermes_home=sys.argv[2])"
    ].join("; ");
    await execFileAsync(python, ["-c", script, providerServerName(providerName), profileHome], {
      cwd: hermesAgentRoot(),
      env: {
        ...process.env,
        HERMES_HOME: profileHome,
        PYTHONPATH: [hermesAgentRoot(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        NO_COLOR: "1"
      },
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  }

  const after = presentHermesOAuthFiles(providerName, profileHome);
  if (after.length) throw new Error(`Hermes OAuth cleanup incomplete for ${providerName}`);
  return { provider: providerName, profile: PROFILE, status: "deleted", deleted: true, files: before };
}

export function hermesOAuthRuntimeStatus() {
  if (process.env.RADOS_HOME) return isolatedTestResult();
  const profilePath = hermesProfileHome();
  if (!fs.existsSync(profilePath)) return { provider: "huggingface", profile: PROFILE, status: "missing_profile", path: profilePath };
  const python = findHermesPython();
  if (!python || !fs.existsSync(hermesAgentRoot())) return { provider: "huggingface", profile: PROFILE, status: "not_available", path: profilePath };
  return { provider: "huggingface", profile: PROFILE, status: "ready", path: profilePath, python: "installed" };
}
