import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { MEMU_BRIDGE_SOURCE } from "./memu-bridge-source.mjs";
import { memoryLedgerId, listApprovedMemory, remember, searchMemory, forgetMemory } from "./avatar-memory.mjs";
import { NAAVOS_DIR, loadSetupState, createSnapshot } from "./setup-state.mjs";
const execFileAsync = promisify(execFile);

export const MEMU_CONFIG_PATH = path.join(NAAVOS_DIR, "memu.json");
export const MEMU_INDEX_PATH = path.join(NAAVOS_DIR, "memu-index.sqlite");
const LOCK_PATH = path.join(NAAVOS_DIR, ".memu.lock");
const providers = new Set(["openai", "jina", "voyage", "doubao", "openrouter"]);

function requireActive() {
  const state = loadSetupState();
  if (state.privacy.mode === "paused") throw new Error("Memory access is paused by the privacy control");
  if (!state.avatar.id) throw new Error("Create your local Avatar first");
  return state;
}

function validate(input) {
  const allowed = ["enabled", "mode", "python", "provider", "model", "base_url", "api_key_env", "allow_network", "ledger_id"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw new Error("Unknown MemU configuration field");
  const cfg = { enabled: true, mode: "local", python: process.platform === "win32" ? "python" : "python3", ...input };
  if (typeof cfg.enabled !== "boolean" || !["local", "cloud"].includes(cfg.mode)) throw new Error("Invalid MemU mode");
  if (typeof cfg.python !== "string" || !/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(cfg.python))) throw new Error("Use a Python executable, without shell arguments");
  if (cfg.mode === "local" && !providers.has(cfg.provider)) throw new Error("Choose an embedding provider: openai, jina, voyage, doubao or openrouter");
  if (typeof cfg.api_key_env !== "string" || !/^[A-Z][A-Z0-9_]{0,100}$/.test(cfg.api_key_env)) throw new Error("Provide the credential environment-variable name, not its value");
  if (cfg.allow_network !== true) throw new Error("Explicit allow_network=true consent is required before MemU can send approved notes and queries to its backend/embedding provider");
  if (cfg.model !== undefined && (typeof cfg.model !== "string" || !cfg.model.trim() || cfg.model.length > 200)) throw new Error("Invalid embedding model");
  if (cfg.base_url !== undefined) {
    const url = new URL(cfg.base_url);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Embedding URL must be HTTPS or loopback HTTP without credentials or query parameters");
    if (cfg.mode === "cloud") throw new Error("MemU Cloud uses its official endpoint; custom cloud endpoints are not accepted");
  }
  return cfg;
}

function readConfig() {
  if (!fs.existsSync(MEMU_CONFIG_PATH)) return null;
  if (fs.lstatSync(MEMU_CONFIG_PATH).isSymbolicLink()) throw new Error("Refusing a symlinked MemU configuration");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(MEMU_CONFIG_PATH, "utf8")); }
  catch { throw new Error("Invalid MemU configuration; local memory remains available"); }
  return validate(parsed);
}

function writeConfig(cfg) {
  fs.mkdirSync(NAAVOS_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(MEMU_CONFIG_PATH) && fs.lstatSync(MEMU_CONFIG_PATH).isSymbolicLink()) throw new Error("Refusing a symlinked MemU configuration");
  const temp = `${MEMU_CONFIG_PATH}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, MEMU_CONFIG_PATH);
}

export function memuStatus() {
  let cfg;
  try { cfg = readConfig(); } catch { return { enabled: false, status: "invalid_configuration", authority: "local_sqlite" }; }
  if (!cfg) return { enabled: false, status: "not_configured", authority: "local_sqlite" };
  return { enabled: cfg.enabled, mode: cfg.mode, status: cfg.enabled ? "configured_unprobed" : "disabled", authority: "local_sqlite", auto_capture: false, network_consent: cfg.allow_network };
}

async function withLock(action, lockPath = LOCK_PATH) {
  fs.mkdirSync(NAAVOS_DIR, { recursive: true, mode: 0o700 });
  let fd;
  for (let i = 0; i < 250; i++) {
    try { fd = fs.openSync(lockPath, "wx", 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        if (fs.lstatSync(lockPath).isSymbolicLink()) throw new Error("Refusing a symlinked memory lock");
        owner = Number(fs.readFileSync(lockPath, "utf8"));
      } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (e) { if (e.code === "ESRCH") { try { fs.unlinkSync(lockPath); } catch {} continue; } }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (fd === undefined) throw new Error("Memory is busy; retry shortly");
  try { return await action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

export async function installMemu({ python = process.platform === "win32" ? "python" : "python3", confirm = false } = {}) {
  if (confirm !== true) throw new Error("Installing optional MemU dependencies requires confirm=true");
  if (typeof python !== "string" || !/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(python))) throw new Error("Use a Python executable, without shell arguments");
  return withLock(async () => {
    const directory = path.join(NAAVOS_DIR, "memu-python");
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing a symlinked MemU environment");
    const selected = path.join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const env = { ...process.env, PIP_NO_INPUT: "1", PYTHONIOENCODING: "utf-8" };
    try {
      await execFileAsync(python, ["-c", "import sys; assert sys.version_info >= (3,11), 'Python 3.11+ is required'"], { env, timeout: 10000, windowsHide: true });
      if (!fs.existsSync(selected)) await execFileAsync(python, ["-m", "venv", directory], { env, timeout: 60000, windowsHide: true });
      await execFileAsync(selected, ["-m", "pip", "install", "--disable-pip-version-check", "memu-cli==0.11.0b3", "httpx[socks]==0.28.1"], { env, timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      return { status: "dependencies_installed", python: selected, package: "memu-cli==0.11.0b3", memory_enabled: memuStatus().enabled, configuration_changed: false, next: "Configure an embedding provider or MemU Cloud with explicit network consent" };
    } catch { throw new Error("MemU dependency installation failed; Python 3.11+, venv/pip and package-registry connectivity are required. Existing memory is unchanged"); }
  }, path.join(NAAVOS_DIR, ".memu-install.lock"));
}

function bridge(cfg, operation, state, query) {
  if (cfg.mode === "cloud" && state.privacy.mode !== "local_and_sync") throw new Error("MemU Cloud is blocked in local_only mode; explicitly enable local_and_sync first");
  if (cfg.mode === "cloud" && operation !== "probe" && cfg.ledger_id !== memoryLedgerId()) throw new Error("The local memory database has been replaced or lost; restore its backup before syncing so existing cloud memory is not overwritten");
  if (fs.existsSync(MEMU_INDEX_PATH) && fs.lstatSync(MEMU_INDEX_PATH).isSymbolicLink()) throw new Error("Refusing a symlinked MemU index");
  const notes = operation === "probe" ? [] : listApprovedMemory({ avatarId: state.avatar.id }).map(({ id, content }) => ({ id, content }));
  const payload = JSON.stringify({ config: cfg, operation, avatar_id: state.avatar.id, index_path: MEMU_INDEX_PATH, notes, query });
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw new Error("Approved memory exceeds the current MemU projection limit; SQLite remains available");
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.python, ["-c", MEMU_BRIDGE_SOURCE], {
      windowsHide: true,
      env: { ...process.env, MEMU_EVENTS_BASE_URL: "", MEMU_CONFIG_ENV: path.join(NAAVOS_DIR, ".unused-memu-env"), PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("MemU timed out; local memory is preserved")); }, 20000);
    child.on("error", () => finish(new Error("MemU Python is unavailable; install memu-cli==0.11.0b3 in the configured Python environment")));
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 1024 * 1024) { child.kill(); finish(new Error("Invalid MemU response")); } });
    child.stderr.on("data", () => {}); // Never surface provider errors containing private content/keys.
    child.on("close", code => {
      let result;
      try { result = JSON.parse(output); } catch { return finish(new Error("MemU dependency failed; install memu-cli==0.11.0b3 in the configured Python environment")); }
      if (code !== 0 || result.error) return finish(new Error(result.error === "missing_credential" ? `Set the ${cfg.api_key_env} credential in the host environment` : `MemU backend failed (${String(result.error).replace(/[^A-Za-z_]/g, "").slice(0,50)}); local memory is preserved. Check its version, provider credentials and connectivity`));
      finish(null, result);
    });
    child.stdin.end(payload);
  });
}

export async function configureMemu(input, { confirm = false } = {}) {
  if (confirm !== true) throw new Error("MemU configuration requires confirm=true and explicit network consent");
  if (Object.hasOwn(input ?? {}, "ledger_id")) throw new Error("Memory ledger identity is managed by NAAvOS");
  const cfg = validate(input);
  return withLock(async () => {
    const state = requireActive();
    const previous = readConfig();
    if (previous?.mode === "cloud" && previous.ledger_id !== memoryLedgerId()) throw new Error("Restore the original memory database before reconfiguring its cloud projection");
    cfg.ledger_id = memoryLedgerId();
    if (!cfg.ledger_id) throw new Error("Save your local Avatar profile before configuring MemU");
    await bridge(cfg, "probe", state);
    const backup = createSnapshot({ paths: [MEMU_CONFIG_PATH], reason: "memu-configure" });
    writeConfig(cfg);
    const result = await bridge(cfg, "sync", state);
    return { ...result, backup_id: backup.id, mode: cfg.mode, authority: "local_sqlite", auto_capture: false };
  });
}

export async function syncMemu({ confirm = false } = {}) {
  if (confirm !== true) throw new Error("MemU sync requires confirm=true");
  return withLock(async () => {
    const state = requireActive(), cfg = readConfig();
    if (!cfg?.enabled) throw new Error("MemU is not enabled");
    return bridge(cfg, "sync", state);
  });
}

export async function disableMemu({ confirm = false } = {}) {
  if (confirm !== true) throw new Error("Disabling MemU requires confirm=true");
  return withLock(async () => { const cfg = readConfig(); if (cfg) { createSnapshot({ paths: [MEMU_CONFIG_PATH], reason: "memu-disable" }); writeConfig({ ...cfg, enabled: false }); } return { status: "disabled", existing_projection: "retained", authority: "local_sqlite" }; });
}

async function projectIfEnabled(state) {
  try { const cfg = readConfig(); if (!cfg?.enabled) return { status: "disabled" }; return await bridge(cfg, "sync", state); }
  catch (error) { return { status: "pending", error: error.message, retry: "avatar_memu_sync", projection_may_retain_deleted_data: true }; }
}

export async function rememberApprovedMemory({ content, confirm = false } = {}) {
  if (confirm !== true) throw new Error("Memory saving requires confirm=true");
  return withLock(async () => { const state = requireActive(); const saved = remember({ avatarId: state.avatar.id, content, approved: true }); return { ...saved, memu: await projectIfEnabled(state) }; });
}

export async function deleteApprovedMemory({ id, confirm = false } = {}) {
  if (confirm !== true) throw new Error("Memory deletion requires confirm=true");
  return withLock(async () => { const state = requireActive(); const deleted = forgetMemory({ avatarId: state.avatar.id, id, confirm }); return { ...deleted, memu: await projectIfEnabled(state) }; });
}

export async function searchApprovedMemory({ query } = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("Provide a query of 1-500 characters");
  return withLock(async () => {
    const state = requireActive();
    let cfg;
    try { cfg = readConfig(); }
    catch { return { engine: "sqlite_fts5", degraded: true, memu_error: "Invalid MemU configuration", items: searchMemory({ avatarId: state.avatar.id, query, limit: 20 }) }; }
    if (cfg?.enabled) {
      try {
        const result = await bridge(cfg, "retrieve", state, query);
        if (requireActive().avatar.id !== state.avatar.id) throw new Error("Active Avatar changed during retrieval");
        const active = new Map(listApprovedMemory({ avatarId: state.avatar.id }).map(note => [note.id, note]));
        return { engine: "memu", items: (result.hits ?? []).filter(hit => active.has(hit.id)).map(hit => ({ ...active.get(hit.id), score: hit.score })) };
      } catch (error) {
        requireActive();
        return { engine: "sqlite_fts5", degraded: true, memu_error: error.message, items: searchMemory({ avatarId: state.avatar.id, query, limit: 20 }) };
      }
    }
    return { engine: "sqlite_fts5", items: searchMemory({ avatarId: state.avatar.id, query, limit: 20 }) };
  });
}
