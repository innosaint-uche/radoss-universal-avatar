import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureBuiltin, loadRegistry, saveRegistry, REGISTRY_PATH } from "./mcp-registry.mjs";
import { disconnectServer, inspectTargetSecurity, syncLocalTarget, syncServer, targetMetadata, targetPaths } from "./mcp-adapters.mjs";
import {
  BACKUPS_DIR,
  createSnapshot,
  listSnapshots,
  loadSetupState,
  recordAudit,
  restoreSnapshot,
  saveSetupState,
  setupPaths,
  SETUP_STATE_PATH
} from "./setup-state.mjs";
import { deleteStoredToken, getStoredAccessToken, getStoredToken, openExternal, openLocal, startBrowserLogin, tokenStorageStatus } from "./oauth.mjs";
import { checkpointMemory, initializeMemory, MEMORY_DB_PATH, memoryStatus } from "./avatar-memory.mjs";
import { inspectReMe, installReMe, projectApprovedMemory } from "./reme.mjs";
import { disconnectHermesMcpOAuth, ensureHermesMcpOAuth, hermesOAuthRuntimeStatus } from "./hermes-oauth.mjs";
import { probeMcpProtocol } from "./mcp-contract.mjs";
import { evaluateReleaseGate } from "./release-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = path.join(ROOT, "desktop-setup");
const execFileAsync = promisify(execFile);
const HERMES_PROFILE = "avatar";
export const DEFAULT_PROVIDER = "huggingface";
export const DEFAULT_TARGETS = ["codex", "antigravity", "hermes"];

const AGENT_CATALOG = {
  codex: { label: "Codex", mode: "automatic" },
  antigravity: { label: "Antigravity", mode: "automatic" },
  hermes: { label: "Hermes", mode: "automatic", role: "visible_orchestrator" },
  chatgpt: { label: "ChatGPT", mode: "account_ui", host_url: "https://chatgpt.com/", note: "Open ChatGPT Settings → Apps/Connectors to connect; Radoss cannot edit account settings." },
  claude: { label: "Claude", mode: "account_ui", host_url: "https://claude.ai/", note: "Open Claude Settings → Integrations to connect; Radoss cannot edit account settings." }
};

function now() {
  return new Date().toISOString();
}

function normalizeTargets(targets) {
  const values = [...new Set((Array.isArray(targets) ? targets : []).map((value) => String(value).trim()).filter(Boolean))];
  if (!values.length) throw new Error("Select at least one supported agent");
  const unsupported = values.filter((value) => !Object.hasOwn(AGENT_CATALOG, value) || AGENT_CATALOG[value].mode !== "automatic");
  if (unsupported.length) throw new Error(`Unsupported automatic target: ${unsupported.join(", ")}`);
  return values;
}

function normalizeRequest({ providerName = DEFAULT_PROVIDER, provider, targets = DEFAULT_TARGETS, openAuth = true, avatarName = "My Avatar" } = {}) {
  const resolvedAvatarName = String(avatarName || "My Avatar").trim();
  if (!resolvedAvatarName) throw new Error("Avatar name cannot be empty");
  if (resolvedAvatarName.length > 80) throw new Error("Avatar name must be 80 characters or fewer");
  return {
    provider: provider ?? providerName,
    targets: normalizeTargets(targets),
    openAuth: Boolean(openAuth),
    avatarName: resolvedAvatarName
  };
}

function ensureAvatar(state, name) {
  const timestamp = now();
  state.avatar ??= {};
  state.avatar.id ??= crypto.randomUUID();
  state.avatar.name = name;
  state.avatar.created_at ??= timestamp;
  state.avatar.updated_at = timestamp;
  return state.avatar;
}

function recordSetupFailure(backup, error, attemptedState) {
  const attemptedSetup = { ...(attemptedState?.setup ?? {}) };
  const attemptedAvatar = { ...(attemptedState?.avatar ?? {}) };
  try { restoreSnapshot(backup.id); } catch { /* preserve the original setup error */ }
  const failedState = loadSetupState();
  failedState.setup = {
    ...failedState.setup,
    ...attemptedSetup,
    status: "failed",
    phase: "error",
    last_error: error.message,
    last_failed_at: now(),
    last_backup_id: backup.id
  };
  failedState.avatar = { ...failedState.avatar, ...attemptedAvatar };
  recordAudit(failedState, "setup.failed", { backup_id: backup.id, error: error.message });
  saveSetupState(failedState);
}

function updateSetupProgress(state, phase, extra = {}) {
  state.setup = { ...state.setup, phase, ...extra };
  saveSetupState(state);
}

function getServer(providerName) {
  const registry = loadRegistry();
  const server = registry.servers[providerName];
  if (!server) throw new Error(`Unknown provider: ${providerName}`);
  return { registry, server };
}

async function cachedProviderAuth(state, server) {
  try {
    const accessToken = await getStoredAccessToken(server);
    if (!accessToken) return null;
    const previous = state.providers?.[server.id] ?? {};
    return {
      provider: server.id,
      mode: "secure_store_cached",
      status: "authenticated",
      verification: previous.auth_verification === "provider_userinfo_verified"
        ? "provider_userinfo_verified_cached"
        : "secure_store_credential_verified",
      account: previous.account ?? null,
      token_storage: tokenStorageStatus(),
      client_id_source: previous.client_id_source ?? server.oauth?.client_id_source ?? null
    };
  } catch {
    // An expired or unusable credential must fall through to browser OAuth.
    // The subsequent protocol probe remains the final health authority.
    return null;
  }
}

function snapshot(reason) {
  checkpointMemory();
  return createSnapshot({
    reason,
    paths: setupPaths({ registryPath: REGISTRY_PATH, targetPaths: targetPaths(), extraPaths: [MEMORY_DB_PATH, `${MEMORY_DB_PATH}-wal`, `${MEMORY_DB_PATH}-shm`] })
  });
}

function publicAgentStatus(state) {
  const paths = targetPaths();
  const metadata = targetMetadata();
  const result = {};
  for (const [id, meta] of Object.entries(AGENT_CATALOG)) {
    result[id] = {
      ...meta,
      path: paths[id] ?? null,
      ...(metadata[id]?.profile ? { profile: metadata[id].profile } : {}),
      installed: Boolean(paths[id] && fs.existsSync(paths[id])),
      configured: Boolean(state.agents?.[id]?.configured)
    };
  }
  return result;
}

function hostedGatewayServer() {
  return loadRegistry().servers?.naavos_gateway ?? null;
}

function hostedGatewayUrl() {
  return process.env.RADOS_NAAS_GATEWAY_URL ?? hostedGatewayServer()?.endpoint ?? null;
}

function authorityStatus(state = null) {
  const gatewayUrl = hostedGatewayUrl();
  return {
    name: "NAAS",
    role: "canonical_avatar_authority",
    local_control_plane: {
      status: "available",
      transport: "local_stdio_mcp",
      visible_orchestrator: "hermes"
    },
    hosted_gateway: {
      status: gatewayUrl ? "configured_unverified" : "not_configured",
      ...(gatewayUrl ? { endpoint: safePublicUrl(gatewayUrl) } : {}),
      ...(gatewayUrl && !process.env.RADOS_NAAS_GATEWAY_URL ? { source: "canonical_registry" } : {}),
      ...(state?.setup?.last_hosted_gateway_check ? { last_check: state.setup.last_hosted_gateway_check } : {}),
      required_for: ["chatgpt", "claude"],
      release_gate: "individual_local_or_public_hosted_profile"
    }
  };
}

function safePublicUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid gateway URL]";
  }
}

export async function inspectHostedGateway({ fetchImpl = fetch } = {}) {
  const configured = hostedGatewayUrl();
  if (!configured) return { status: "not_configured", required_for: ["chatgpt", "claude"] };
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    return { status: "invalid_endpoint", endpoint: "[invalid gateway URL]", error: "Gateway URL is invalid" };
  }
  const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    return { status: "invalid_endpoint", endpoint: safePublicUrl(configured), error: "Gateway must use HTTPS or loopback HTTP" };
  }
  const server = hostedGatewayServer();
  const token = server ? await getStoredAccessToken(server, { fetchImpl }) : null;
  const protocol = await probeMcpProtocol(configured, { fetchImpl, token });
  return {
    status: protocol.status === "healthy" ? "protocol_healthy" : "configured_unverified",
    endpoint: safePublicUrl(configured),
    protocol,
    authentication: token ? "secure_store_credential_used" : "not_available",
    note: protocol.status === "healthy" ? "MCP protocol reachable; OAuth and tenant isolation remain unverified" : "Hosted gateway protocol check failed or requires account connection"
  };
}

function hermesExecutableCandidates() {
  const candidates = [
    process.env.RADOS_HERMES_BIN,
    "hermes",
    path.join(os.homedir(), ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes"
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function hermesCheckSkipped(reason) {
  return {
    status: "not_checked",
    profile: HERMES_PROFILE,
    path: targetMetadata().hermes.path,
    reason
  };
}

export async function inspectHermesProfile(server) {
  const target = targetMetadata().hermes;
  if (process.env.RADOS_HOME) return hermesCheckSkipped("isolated_test_home");
  if (!fs.existsSync(target.path)) {
    return { status: "missing_config", profile: HERMES_PROFILE, path: target.path };
  }

  let lastError = null;
  for (const executable of hermesExecutableCandidates()) {
    try {
      await execFileAsync(executable, ["-p", HERMES_PROFILE, "mcp", "list"], {
        timeout: 8000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
      });
      const expectedEndpoint = server.oauth_endpoint ?? server.endpoint;
      const lines = fs.readFileSync(target.path, "utf8").split(/\r?\n/);
      const start = lines.findIndex((line) => line === "  hugging_face:");
      let end = start < 0 ? -1 : start + 1;
      while (end >= 0 && end < lines.length && (lines[end].startsWith("    ") || lines[end].trim() === "")) end += 1;
      const providerBlock = start < 0 ? [] : lines.slice(start, end);
      const hasProvider = providerBlock.includes(`    url: ${expectedEndpoint}`);
      return {
        status: hasProvider ? "configured" : "drift",
        profile: HERMES_PROFILE,
        path: target.path,
        executable,
        provider: "hugging_face",
        endpoint: expectedEndpoint,
        detail: hasProvider ? null : "Hermes Avatar profile does not list the registered provider"
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    status: "not_available",
    profile: HERMES_PROFILE,
    path: target.path,
    error: lastError?.message ?? "Hermes executable not found"
  };
}

async function inspectHermesProviderAuth(server) {
  if (process.env.RADOS_HOME) return hermesOAuthRuntimeStatus();
  const runtime = hermesOAuthRuntimeStatus();
  if (runtime.status !== "ready") return runtime;
  let lastError = null;
  for (const executable of hermesExecutableCandidates()) {
    try {
      const { stdout, stderr } = await execFileAsync(executable, ["-p", HERMES_PROFILE, "mcp", "test", "hugging_face"], {
        timeout: 30000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
      });
      const output = `${stdout}\n${stderr}`;
      if (/no cached tokens|authorization required|oauth authentication required|failed|error/i.test(output)) {
        return {
          ...runtime,
          status: "pending_provider_confirmation",
          verification: "hermes_oauth_required",
          executable,
          detail: "Hermes does not have a verified cached provider session"
        };
      }
      return {
        ...runtime,
        status: "authenticated",
        verification: "hermes_mcp_probe_with_cached_oauth",
        executable
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ...runtime,
    status: "pending_provider_confirmation",
    verification: "hermes_oauth_required",
    error: lastError?.message ?? "Hermes provider session is not verified"
  };
}

export async function setupStatus() {
  const state = loadSetupState();
  const registry = loadRegistry();
  const providers = {};
  const hermesRuntime = registry.servers[DEFAULT_PROVIDER]
    ? await inspectHermesProfile(registry.servers[DEFAULT_PROVIDER])
    : hermesCheckSkipped("provider_not_registered");
  const hermesProviderAuth = registry.servers[DEFAULT_PROVIDER]
    ? await inspectHermesProviderAuth(registry.servers[DEFAULT_PROVIDER])
    : hermesCheckSkipped("provider_not_registered");
  for (const [id, server] of Object.entries(registry.servers)) {
    let drift = [];
    try { drift = syncServer(server, { dryRun: true }); } catch (error) { drift = [{ status: "error", error: error.message }]; }
    providers[id] = {
      id,
      label: server.label,
      endpoint: server.endpoint,
      auth: server.auth,
      configured: Boolean(state.providers?.[id]?.configured),
      auth_status: state.providers?.[id]?.auth_status ?? "not_started",
      auth_verification: state.providers?.[id]?.auth_verification ?? "not_started",
      account: state.providers?.[id]?.account ?? null,
      token_storage: state.providers?.[id]?.token_storage ?? tokenStorageStatus(),
      adapter_drift: drift,
      ...(id === DEFAULT_PROVIDER ? { hermes_runtime: hermesRuntime } : {})
    };
  }
  const agents = publicAgentStatus(state);
  if (agents.hermes) {
    agents.hermes.runtime = hermesRuntime;
    agents.hermes.provider_auth = hermesProviderAuth;
  }
  const reme = await inspectReMe();
  const release = evaluateReleaseGate();
  return {
    product: "Radoss Universal Avatar",
    authority: authorityStatus(state),
    release: {
      ...release,
      label: release.public_release
        ? "Public hosted release"
        : release.release_verified && release.channel === "individual_local"
          ? "Verified individual handoff"
          : "Local validation build"
    },
    registry_path: REGISTRY_PATH,
    setup_state_path: SETUP_STATE_PATH,
    avatar: state.avatar,
    memory: { ...memoryStatus(), projection: reme },
    privacy: state.privacy,
    setup: state.setup,
    providers,
    security_warnings: inspectTargetSecurity(),
    agents,
    backups: listSnapshots().map(({ id, reason, created_at }) => ({ id, reason, created_at })),
    capabilities: {
      local_avatar: "available",
      local_memory: "sqlite_fts5",
      memory_projection: reme.status === "healthy" ? "reme_available" : "reme_optional",
      memory_projection_status: reme.status,
      orchestrator: "hermes_visible_naas_control_plane",
      browser_oauth: "pkce_loopback_or_provider_managed",
      cloud_sync: state.privacy.cloud_sync ? "not_configured" : "disabled",
      notebooklm_import: "manual_review_required",
      ollama: "excluded"
    }
  };
}

export async function runSetup({ providerName = DEFAULT_PROVIDER, provider, targets = DEFAULT_TARGETS, openAuth = true, avatarName = "My Avatar" } = {}) {
  const request = normalizeRequest({ providerName, provider, targets, openAuth, avatarName });
  const state = loadSetupState();
  if (state.privacy.mode === "paused") throw new Error("Setup is paused by the privacy control");
  const backup = snapshot("setup-run");
  state.setup = {
    ...state.setup,
    status: "running",
    phase: "configuring",
    last_request: request,
    last_error: null,
    last_backup_id: backup.id
  };
  ensureAvatar(state, request.avatarName);
  recordAudit(state, "setup.started", { provider: request.provider, targets: request.targets, backup_id: backup.id });
  saveSetupState(state);
  try {
    const server = request.provider === "huggingface"
      ? ensureBuiltin(request.provider)
      : getServer(request.provider).server;
    const registry = loadRegistry();
    initializeMemory();
    registry.servers[request.provider] = { ...server, targets: request.targets };
    saveRegistry(registry);
    let configuredServer = loadRegistry().servers[request.provider];
    const syncResults = syncServer(configuredServer);
    if (request.openAuth) updateSetupProgress(state, "awaiting_browser_oauth");
    const cachedAuth = request.openAuth ? await cachedProviderAuth(state, configuredServer) : null;
    const auth = request.openAuth
      ? cachedAuth ?? await startBrowserLogin(configuredServer)
      : { status: "not_opened", verification: "pending_provider_confirmation", token_storage: tokenStorageStatus() };
    if (auth.client_id && !configuredServer.oauth?.client_id) {
      const latestRegistry = loadRegistry();
      configuredServer = {
        ...configuredServer,
        oauth: { ...(configuredServer.oauth ?? {}), client_id: auth.client_id, client_id_source: auth.client_id_source }
      };
      latestRegistry.servers[request.provider] = configuredServer;
      saveRegistry(latestRegistry);
    }
    if (request.openAuth) updateSetupProgress(state, "configuring_orchestrator");
    const hermesAuth = request.targets.includes("hermes") && request.openAuth && configuredServer.auth === "oauth"
      ? await ensureHermesMcpOAuth(request.provider)
      : { status: "not_started", verification: "pending_provider_confirmation" };
    if (request.targets.includes("hermes") && request.openAuth && hermesAuth.status !== "authenticated" && hermesAuth.status !== "not_checked") {
      throw new Error("Hermes provider OAuth was not completed");
    }
    updateSetupProgress(state, "running_health_checks");
    const accessToken = await getStoredAccessToken(configuredServer);
    const health = await probeMcpProtocol(configuredServer.endpoint, { token: accessToken });
    const hermesRuntime = request.targets.includes("hermes")
      ? await inspectHermesProfile(configuredServer)
      : hermesCheckSkipped("target_not_selected");
    if (hermesRuntime.status === "drift") throw new Error("Hermes Avatar profile is not configured for the registered MCP provider");
    if (health.status !== "healthy") {
      throw new Error(`MCP health check failed for ${request.provider}`);
    }
    state.setup = {
      ...state.setup,
      status: "configured",
      phase: "connected",
      last_run_at: now(),
      last_backup_id: backup.id,
      last_error: null,
      last_failed_at: null
    };
    state.providers[request.provider] = {
      ...(state.providers[request.provider] ?? {}),
      configured: true,
      configured_at: now(),
      auth_status: auth.status,
      auth_verification: auth.verification,
      account: auth.account ?? null,
      token_storage: auth.token_storage ?? tokenStorageStatus(),
      client_id_source: auth.client_id_source ?? configuredServer.oauth?.client_id_source ?? null,
      last_protocol_health: health.status,
      hermes_runtime: hermesRuntime,
      hermes_auth: hermesAuth,
      targets: request.targets
    };
    for (const result of syncResults) {
      state.agents[result.target] = { configured: true, path: result.path, last_sync_at: now() };
    }
    recordAudit(state, "setup.run", { provider: request.provider, targets: request.targets, backup_id: backup.id, health_status: health.status });
    saveSetupState(state);
    return { backup, provider: configuredServer, sync: syncResults, auth, health, hermes: hermesRuntime, hermes_auth: hermesAuth, status: await setupStatus() };
  } catch (error) {
    recordSetupFailure(backup, error, state);
    throw error;
  }
}

export async function retrySetup(overrides = {}) {
  const state = loadSetupState();
  const request = { ...(state.setup.last_request ?? {}), ...overrides };
  return runSetup({
    provider: request.provider ?? DEFAULT_PROVIDER,
    targets: request.targets ?? DEFAULT_TARGETS,
    openAuth: request.openAuth ?? true,
    avatarName: request.avatarName ?? state.avatar?.name ?? "My Avatar"
  });
}

export async function connectProvider(providerName = DEFAULT_PROVIDER, { tokenStore } = {}) {
  const state = loadSetupState();
  const backup = snapshot("connect-provider");
  const hadStoredCredential = Boolean(getStoredToken(providerName, tokenStore ? { tokenStore } : {}));
  let server;
  try {
    server = providerName === DEFAULT_PROVIDER
      ? ensureBuiltin(providerName)
      : getServer(providerName).server;
    state.providers[providerName] = {
      ...(state.providers[providerName] ?? {}),
      auth_status: "awaiting_browser_oauth",
      last_auth_started_at: now()
    };
    state.setup = { ...state.setup, status: "running", phase: "awaiting_browser_oauth", last_backup_id: backup.id, last_error: null };
    recordAudit(state, "auth.connect.started", { provider: providerName, backup_id: backup.id });
    saveSetupState(state);

    const auth = await startBrowserLogin(server, tokenStore ? { tokenStore } : {});
    if (auth.client_id && !server.oauth?.client_id) {
      const registry = loadRegistry();
      server = {
        ...server,
        oauth: { ...(server.oauth ?? {}), client_id: auth.client_id, client_id_source: auth.client_id_source }
      };
      registry.servers[providerName] = server;
      saveRegistry(registry);
    }
    updateSetupProgress(state, "configuring_orchestrator");
    const hermesTarget = (server.targets ?? []).includes("hermes");
    const hermesAuth = server.auth === "oauth" && hermesTarget
      ? await ensureHermesMcpOAuth(providerName)
      : { status: "not_required", verification: "not_required" };
    if (server.auth === "oauth" && hermesAuth.status !== "authenticated" && hermesAuth.status !== "not_checked") {
      throw new Error("Hermes provider OAuth was not completed");
    }

    const sync = syncServer(server);
    updateSetupProgress(state, "running_health_checks");
    const accessToken = await getStoredAccessToken(server, tokenStore ? { tokenStore } : {});
    const health = await probeMcpProtocol(server.endpoint, { token: accessToken });
    if (health.status !== "healthy") throw new Error(`MCP health check failed for ${providerName}`);

    state.setup = {
      ...state.setup,
      status: "configured",
      phase: "connected",
      last_run_at: now(),
      last_backup_id: backup.id,
      last_error: null,
      last_failed_at: null
    };
    state.providers[providerName] = {
      ...(state.providers[providerName] ?? {}),
      configured: true,
      auth_status: auth.status,
      auth_verification: auth.verification,
      account: auth.account ?? null,
      token_storage: auth.token_storage ?? tokenStorageStatus(),
      client_id_source: auth.client_id_source ?? server.oauth?.client_id_source ?? null,
      hermes_auth: hermesAuth,
      last_protocol_health: health.status,
      last_auth_started_at: now()
    };
    for (const result of sync) {
      state.agents[result.target] = { configured: true, path: result.path, last_sync_at: now() };
    }
    recordAudit(state, "auth.connect.completed", { provider: providerName, status: auth.status, health_status: health.status, backup_id: backup.id });
    saveSetupState(state);
    return { ...auth, backup, sync, health, hermes_auth: hermesAuth, setup_status: await setupStatus() };
  } catch (error) {
    // A failed reconnect must not leave a newly-created credential orphaned in
    // the OS store or leave the UI claiming that a restored account is live.
    if (!hadStoredCredential && getStoredToken(providerName, tokenStore ? { tokenStore } : {})) {
      deleteStoredToken(providerName, tokenStore ? { tokenStore } : {});
    }
    recordSetupFailure(backup, error, state);
    throw error;
  }
}

export function openHostConnection(agentId) {
  const agent = AGENT_CATALOG[agentId];
  if (!agent || agent.mode !== "account_ui" || !agent.host_url) throw new Error(`Unsupported host connection: ${agentId}`);
  const opened = openExternal(agent.host_url);
  const state = loadSetupState();
  recordAudit(state, "host.connection.opened", { agent: agentId, status: opened.skipped ? "browser_open_skipped" : "browser_opened" });
  saveSetupState(state);
  return { agent: agentId, label: agent.label, status: opened.skipped ? "browser_open_skipped" : "browser_opened", url: agent.host_url };
}

export async function setupReMe() {
  return installReMe();
}

export async function projectReMe() {
  const state = loadSetupState();
  if (state.privacy.mode === "paused") throw new Error("Memory projection is paused by the privacy control");
  const result = await projectApprovedMemory({ avatarId: state.avatar?.id });
  recordAudit(state, "memory.reme.project", { count: result.count, reindex: result.reindex.status });
  saveSetupState(state);
  return result;
}

export function createBackup(reason = "manual") {
  const state = loadSetupState();
  const backup = snapshot(reason);
  state.setup.last_backup_id = backup.id;
  recordAudit(state, "backup.created", { backup_id: backup.id, reason });
  saveSetupState(state);
  return backup;
}

export function rollbackBackup(id) {
  const manifest = restoreSnapshot(id);
  const state = loadSetupState();
  for (const [providerId, providerState] of Object.entries(state.providers ?? {})) {
    if (providerState.auth_status !== "authenticated") continue;
    if (getStoredToken(providerId)) continue;
    state.providers[providerId] = {
      ...providerState,
      auth_status: "pending_provider_confirmation",
      auth_verification: "credential_removed",
      account: null
    };
  }
  state.setup.last_backup_id = id;
  state.setup.phase = "rolled_back";
  recordAudit(state, "backup.restored", { backup_id: id });
  saveSetupState(state);
  return manifest;
}

export function setPrivacyMode(mode) {
  const allowed = new Set(["local_only", "local_and_sync", "paused"]);
  if (!allowed.has(mode)) throw new Error(`Unsupported privacy mode: ${mode}`);
  const state = loadSetupState();
  state.privacy = {
    ...state.privacy,
    mode,
    cloud_sync: mode === "local_and_sync",
    telemetry: false
  };
  recordAudit(state, "privacy.updated", { mode });
  saveSetupState(state);
  return state.privacy;
}

export async function disconnectProvider(providerName = DEFAULT_PROVIDER, { tokenStore } = {}) {
  const state = loadSetupState();
  const { server } = getServer(providerName);
  const backup = snapshot("disconnect-provider");
  try {
    const adapterResults = disconnectServer(server);
    const registry = loadRegistry();
    delete registry.servers[providerName];
    saveRegistry(registry);
    for (const result of adapterResults) {
      const localAvatar = syncLocalTarget(result.target, true);
      state.agents[result.target] = {
        ...(state.agents[result.target] ?? {}),
        configured: !localAvatar.changed,
        disconnected_at: now()
      };
    }
    const hermesAuth = await disconnectHermesMcpOAuth(providerName);
    // Remove the Universal credential only after Hermes confirms that its own
    // provider session is gone. If Hermes cleanup is unavailable, the catch
    // path restores the adapter snapshot and leaves the user credential in
    // place for a safe retry.
    const credential = deleteStoredToken(providerName, tokenStore ? { tokenStore } : {});
    state.setup.phase = "disconnected";
    state.providers[providerName] = {
      ...(state.providers[providerName] ?? {}),
      configured: false,
      auth_status: "disconnected",
      disconnected_at: now()
    };
    recordAudit(state, "provider.disconnected", {
      provider: providerName,
      backup_id: backup.id,
      credential_status: credential.status,
      hermes_oauth_status: hermesAuth.status
    });
    saveSetupState(state);
    return { backup, provider: providerName, credential, hermes_auth: hermesAuth, adapters: adapterResults };
  } catch (error) {
    recordSetupFailure(backup, error, state);
    throw error;
  }
}

export async function doctor() {
  const registry = loadRegistry();
  const results = {};
  for (const [id, server] of Object.entries(registry.servers)) {
    const drift = syncServer(server, { dryRun: true });
    const accessToken = await getStoredAccessToken(server);
    results[id] = {
      drift,
      health: await probeMcpProtocol(server.endpoint, { token: accessToken }),
      ...(id === DEFAULT_PROVIDER ? {
        hermes: await inspectHermesProfile(server),
        hermes_auth: await inspectHermesProviderAuth(server)
      } : {})
    };
  }
  const hostedGateway = await inspectHostedGateway();
  const state = loadSetupState();
  state.setup.last_hosted_gateway_check = hostedGateway;
  recordAudit(state, "doctor.run", { providers: Object.keys(results), hosted_gateway_status: hostedGateway.status });
  saveSetupState(state);
  return { authority: { hosted_gateway: hostedGateway }, providers: results, security_warnings: inspectTargetSecurity() };
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }));
  response.end(`${JSON.stringify(body)}\n`);
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function isTrustedBrowserOrigin(origin, server) {
  if (!origin) return true;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost") return true;
  try {
    const parsed = new URL(origin);
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : null;
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(parsed.hostname)
      && Number(parsed.port || 80) === port;
  } catch {
    return false;
  }
}

function securityHeaders(headers = {}) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("Request body too large"));
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON body")); }
    });
    request.on("error", reject);
  });
}

function serveAsset(response, pathname, embeddedAssets = null) {
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml; charset=utf-8"]
  };
  const asset = assets[pathname];
  if (!asset) return false;
  if (embeddedAssets?.[asset[0]] !== undefined) {
    response.writeHead(200, securityHeaders({ "content-type": asset[1], "cache-control": "no-store" }));
    response.end(embeddedAssets[asset[0]]);
    return true;
  }
  const filePath = path.join(DESKTOP_DIR, asset[0]);
  if (!fs.existsSync(filePath)) return false;
  response.writeHead(200, securityHeaders({ "content-type": asset[1], "cache-control": "no-store" }));
  response.end(fs.readFileSync(filePath));
  return true;
}

export async function createSetupServer({ port = 0, open = true, embeddedAssets = null } = {}) {
  const server = http.createServer(async (request, response) => {
    const requestUrl = String(request.url ?? "/").replace(/^\/+/, "/");
    const url = new URL(requestUrl, "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/") && !isTrustedBrowserOrigin(request.headers.origin, server)) {
        throw forbidden("Untrusted browser origin");
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/status") return sendJson(response, 200, await setupStatus());
        if (url.pathname === "/api/backups") return sendJson(response, 200, listSnapshots());
        return sendJson(response, 404, { error: "Not found" });
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        if (url.pathname === "/api/setup/run") return sendJson(response, 200, await runSetup(body));
        if (url.pathname === "/api/setup/retry") {
          try {
            return sendJson(response, 200, await retrySetup(body));
          } catch (error) {
            if (/paused by the privacy control/i.test(error.message)) return sendJson(response, 200, { status: "blocked", error: error.message });
            throw error;
          }
        }
        if (url.pathname === "/api/auth/connect") return sendJson(response, 200, await connectProvider(body.provider));
        if (url.pathname === "/api/host/open") return sendJson(response, 200, openHostConnection(body.agent));
        if (url.pathname === "/api/backup") return sendJson(response, 200, createBackup(body.reason));
        if (url.pathname === "/api/rollback") return sendJson(response, 200, rollbackBackup(body.id));
        if (url.pathname === "/api/privacy") return sendJson(response, 200, setPrivacyMode(body.mode));
        if (url.pathname === "/api/disconnect") return sendJson(response, 200, await disconnectProvider(body.provider));
        if (url.pathname === "/api/doctor") return sendJson(response, 200, await doctor());
        if (url.pathname === "/api/memory/reme/setup") {
          if (body.confirm !== true) throw new Error("Explicit confirmation is required for ReMe setup");
          const result = await installReMe();
          const state = loadSetupState();
          recordAudit(state, "memory.reme.setup", { status: result.status, endpoint: result.endpoint });
          saveSetupState(state);
          return sendJson(response, 200, result);
        }
        if (url.pathname === "/api/memory/reme/project") {
          if (body.confirm !== true) throw new Error("Explicit confirmation is required before projecting approved memory");
          return sendJson(response, 200, await projectReMe());
        }
        return sendJson(response, 404, { error: "Not found" });
      }
      if (request.method === "GET" && serveAsset(response, url.pathname, embeddedAssets)) return;
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(Number(port), "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  if (open) openLocal(url);
  return { server, url, port: address.port, backups_dir: BACKUPS_DIR };
}
