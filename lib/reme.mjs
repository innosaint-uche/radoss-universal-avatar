import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { listApprovedMemory } from "./avatar-memory.mjs";

const HOME = process.env.RADOS_HOME ?? os.homedir();
const execFileAsync = promisify(execFile);
const DEFAULT_ENDPOINT = process.env.RADOS_REME_ENDPOINT ?? "http://127.0.0.1:2333";
const REME_INSTALL_ROOT = path.join(HOME, ".naavos", "reme");
const REME_VENV = path.join(REME_INSTALL_ROOT, "venv");
const REME_WORKSPACE = process.env.RADOS_REME_WORKSPACE ?? path.join(REME_INSTALL_ROOT, "workspace");
const REME_LOCAL_CONFIG = path.join(REME_INSTALL_ROOT, "radoss-local.yaml");
const REME_VENV_BIN = process.platform === "win32" ? "Scripts" : "bin";
const REME_LLM_ENV_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL_NAME",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL_NAME"
];

function executableCandidates() {
  const candidates = [process.env.RADOS_REME_BIN, "reme"];
  const pathEntries = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) candidates.push(path.join(directory, process.platform === "win32" ? "reme.exe" : "reme"));
  candidates.push(
    path.join(HOME, ".local", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "reme.exe" : "reme"),
    path.join(HOME, ".venvs", "reme", REME_VENV_BIN, process.platform === "win32" ? "reme.exe" : "reme"),
    path.join(HOME, ".naavos", "reme", "venv", REME_VENV_BIN, process.platform === "win32" ? "reme.exe" : "reme")
  );
  return [...new Set(candidates.filter(Boolean))];
}

function isRunnable(filePath) {
  if (filePath.includes(path.sep)) return fs.existsSync(filePath);
  return true;
}

async function run(executable, args, timeout = 3000) {
  try {
    const result = await execFileAsync(executable, args, {
      timeout,
      maxBuffer: 128 * 1024,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
    });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "", error: error.message };
  }
}

async function resolveExecutable() {
  for (const candidate of executableCandidates()) {
    if (!isRunnable(candidate)) continue;
    const pythonCandidates = candidate.includes(path.sep)
      ? [
          path.join(path.dirname(candidate), process.platform === "win32" ? "python.exe" : "python"),
          process.env.RADOS_REME_PYTHON
        ]
      : [process.env.RADOS_REME_PYTHON, "python3", "python"];
    for (const python of [...new Set(pythonCandidates.filter(Boolean))]) {
      const result = await run(python, ["-c", "import reme, agentscope"], 5000);
      if (result.code === 0) return candidate;
    }
  }
  return null;
}

function parseDiscoveredEndpoint(output) {
  const host = output.match(/(?:^|\s)HOST=([^\s]+)/)?.[1];
  const port = output.match(/(?:^|\s)PORT=(\d+)/)?.[1];
  if (!host || !port) return null;
  return `http://${host}:${port}`;
}

async function discoverEndpoint(executable) {
  const result = await run(executable, ["find_reme"], 2500);
  return parseDiscoveredEndpoint(`${result.stdout}\n${result.stderr}`) ?? DEFAULT_ENDPOINT;
}

async function probeEndpoint(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/version`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2500)
    });
    return {
      ok: response.ok,
      http_status: response.status,
      content_type: response.headers.get("content-type") ?? null
    };
  } catch (error) {
    return { ok: false, http_status: null, content_type: null, error: error.message };
  }
}

async function postJob(endpoint, job, payload) {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/${job}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`ReMe ${job} failed with HTTP ${response.status}`);
  return body;
}

async function pythonAvailability() {
  const candidates = [process.env.RADOS_REME_PYTHON, "python3", "python"].filter(Boolean);
  for (const python of [...new Set(candidates)]) {
    const result = await run(python, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], 1800);
    const version = result.stdout.trim();
    const parts = version.split(".").map(Number);
    if (result.code === 0 && parts.length >= 2 && parts.every(Number.isFinite)) {
      return {
        executable: python,
        available: true,
        version: version || null,
        supported: parts[0] > 3 || (parts[0] === 3 && parts[1] >= 11)
      };
    }
  }
  return { executable: null, available: false, version: null, supported: false };
}

async function remeRuntimeImport(python) {
  return run(python, ["-c", "import reme, agentscope"], 8000);
}

function venvExecutable(name) {
  return path.join(REME_VENV, REME_VENV_BIN, process.platform === "win32" ? `${name}.exe` : name);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForEndpoint(endpoint, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await probeEndpoint(endpoint);
    if (health.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return probeEndpoint(endpoint);
}

async function ensureLocalOnlyConfig(python) {
  const script = [
    "import sys",
    "from pathlib import Path",
    "import yaml",
    "import reme",
    "source = Path(reme.__file__).resolve().parent / 'config' / 'default.yaml'",
    "data = yaml.safe_load(source.read_text(encoding='utf-8')) or {}",
    "jobs = data.setdefault('jobs', {})",
    "for name in ('chat', 'auto_memory', 'auto_memory_cc', 'auto_resource', 'auto_dream', 'dream_cron', 'resource_watch_loop'):",
    "    jobs.pop(name, None)",
    "components = data.setdefault('components', {})",
    "components.pop('as_llm', None)",
    "components.pop('agent_wrapper', None)",
    "service = data.setdefault('service', {})",
    "service['backend'] = 'http'",
    "service['web_enabled'] = False",
    "data['enable_logo'] = False",
    "data['log_to_file'] = False",
    "target = Path(sys.argv[1])",
    "target.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')",
  ].join("\n");
  const result = await run(python, ["-c", script, REME_LOCAL_CONFIG], 10000);
  if (result.code !== 0 || !fs.existsSync(REME_LOCAL_CONFIG)) {
    throw new Error("Could not create the Ollama-free, credential-free ReMe configuration");
  }
  fs.chmodSync(REME_LOCAL_CONFIG, 0o600);
  return REME_LOCAL_CONFIG;
}

function remeEnvironment() {
  const env = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
  for (const key of REME_LLM_ENV_KEYS) delete env[key];
  return env;
}

async function startService(executable, python) {
  const existing = await inspectReMe({ executable });
  if (existing.status === "healthy") return existing;
  const port = await freePort();
  const workspace = REME_WORKSPACE;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const config = await ensureLocalOnlyConfig(python);
  const child = spawn(executable, [
    "start",
    `config=${config}`,
    `workspace_dir=${workspace}`,
    "service.backend=http",
    "service.host=127.0.0.1",
    `service.port=${port}`
  ], {
    detached: true,
    stdio: "ignore",
    cwd: REME_INSTALL_ROOT,
    env: remeEnvironment()
  });
  child.unref();
  const health = await waitForEndpoint(`http://127.0.0.1:${port}`);
  if (!health.ok) throw new Error("ReMe was installed but its local service did not become healthy");
  return inspectReMe({ executable });
}

/**
 * Install ReMe into an isolated NAAvOS-owned virtual environment and start it.
 * This is intentionally explicit; setupStatus/inspectReMe never call it.
 */
export async function installReMe() {
  const python = await pythonAvailability();
  if (!python.supported) throw new Error("ReMe setup requires Python 3.11 or newer");
  fs.mkdirSync(REME_INSTALL_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(REME_INSTALL_ROOT, 0o700);
  const venvPython = venvExecutable("python");
  const executable = venvExecutable("reme");
  if (!fs.existsSync(venvPython)) {
    const venv = await run(python.executable, ["-m", "venv", REME_VENV], 120000);
    if (venv.code !== 0) throw new Error("Could not create the isolated ReMe environment");
  }

  const runtime = await remeRuntimeImport(venvPython);
  if (runtime.code !== 0) {
    // ReMe's current base wheel imports AgentScope at startup but leaves it in
    // the core extra. Install the direct runtime dependency only: the core
    // extra is intentionally excluded because it adds unrelated model,
    // vector-store and studio dependencies. AgentScope itself does not pull
    // Ollama; verify this dependency boundary when upgrading ReMe.
    const install = await run(venvPython, ["-m", "pip", "--disable-pip-version-check", "--no-input", "install", "reme-ai", "agentscope"], 900000);
    if (install.code !== 0) throw new Error("Could not install the Ollama-free ReMe environment");
    const repaired = await remeRuntimeImport(venvPython);
    if (repaired.code !== 0) throw new Error("ReMe installed but its runtime dependencies are incomplete");
  }
  return startService(executable, venvPython);
}

/**
 * Inspect ReMe without installing, starting, or writing to it.
 * SQLite + FTS5 remains the canonical Avatar ledger; ReMe is a projection only.
 */
export async function inspectReMe({ executable: explicitExecutable = null } = {}) {
  const executable = explicitExecutable ?? await resolveExecutable();
  const python = await pythonAvailability();
  const base = {
    provider: "reme",
    role: "optional_memory_projection",
    canonical_memory: "sqlite_fts5",
    endpoint: DEFAULT_ENDPOINT,
    workspace: REME_WORKSPACE,
    executable,
    python,
    install_action: "user_initiated_only"
  };

  if (!executable || !isRunnable(executable)) {
    return {
      ...base,
      status: "not_installed",
      service: "not_checked",
      projection: "not_available",
      detail: python.supported ? "ReMe is available as an optional user-owned install" : "ReMe requires Python 3.11 or newer"
    };
  }

  const endpoint = await discoverEndpoint(executable);
  const health = await probeEndpoint(endpoint);
  if (!health.ok) {
    return {
      ...base,
      endpoint,
      status: "not_running",
      service: "not_running",
      projection: "not_available",
      detail: "ReMe is installed but its local service is not healthy"
    };
  }

  return {
    ...base,
    endpoint,
    status: "healthy",
    service: "healthy",
    projection: "available",
    workspace: REME_WORKSPACE,
    health
  };
}

function projectionPath(id) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `digest/personal/naavos-avatar/memory-${safeId}`;
}

function projectionName(item) {
  const kind = String(item.kind || "note").trim() || "note";
  return `Avatar ${kind} memory ${item.id}`;
}

/**
 * Project only already-approved SQLite memories into ReMe through its local
 * HTTP job API. This never promotes, edits, or deletes canonical memories.
 */
export async function projectApprovedMemory({ avatarId } = {}) {
  if (!avatarId) throw new Error("Avatar identity is required before projecting memory");
  const status = await inspectReMe();
  if (status.status !== "healthy") throw new Error("ReMe must be installed and healthy before projecting memory");
  const items = listApprovedMemory({ avatarId });
  const projected = [];
  for (const item of items) {
    const path = projectionPath(item.id);
    const content = [
      `# ${projectionName(item)}`,
      "",
      `- Canonical source: SQLite + FTS5 (${item.source})`,
      `- Avatar memory ID: ${item.id}`,
      `- Last updated: ${item.updated_at}`,
      "",
      item.content
    ].join("\n");
    await postJob(status.endpoint, "write", {
      path,
      name: projectionName(item),
      description: "Explicitly approved projection from the NAAvOS SQLite Avatar ledger.",
      content
    });
    projected.push({ id: item.id, path });
  }
  let reindex = { status: "not_needed" };
  if (projected.length) {
    try {
      await postJob(status.endpoint, "reindex", {});
      reindex = { status: "complete" };
    } catch (error) {
      reindex = { status: "pending", detail: error.message };
    }
  }
  return {
    status: "projected",
    canonical_memory: "sqlite_fts5",
    projection: "reme_markdown",
    workspace: status.workspace,
    count: projected.length,
    projected,
    reindex
  };
}
