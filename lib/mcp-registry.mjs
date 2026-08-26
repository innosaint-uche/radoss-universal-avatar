import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.RADOS_HOME ?? os.homedir();
export const NAAVOS_DIR = path.join(HOME, ".naavos");
export const REGISTRY_PATH = path.join(NAAVOS_DIR, "mcp.json");

export const DEFAULT_TARGETS = ["codex", "antigravity", "hermes"];

export const BUILTIN_SERVERS = {
  huggingface: {
    id: "huggingface",
    label: "Hugging Face MCP",
    transport: "streamable_http",
    endpoint: "https://huggingface.co/mcp",
    oauth_endpoint: "https://huggingface.co/mcp?login",
    auth: "oauth",
    oauth_discovery_url: "https://huggingface.co/.well-known/oauth-authorization-server",
    oauth: {
      resource: "https://huggingface.co/mcp",
      scopes: ["openid", "profile", "read-mcp", "read-repos"],
      client_id_env: "RADOS_HF_CLIENT_ID",
      dynamic_registration: true
    },
    enabled: true,
    targets: DEFAULT_TARGETS
  }
};

function ensureDirectory() {
  fs.mkdirSync(NAAVOS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(NAAVOS_DIR, 0o700);
}

export function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { schema_version: 1, servers: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.servers !== "object") {
    throw new Error(`Invalid MCP registry: ${REGISTRY_PATH}`);
  }
  return parsed;
}

export function saveRegistry(registry) {
  ensureDirectory();
  const tempPath = `${REGISTRY_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, REGISTRY_PATH);
}

export function ensureBuiltin(name) {
  const registry = loadRegistry();
  const builtin = BUILTIN_SERVERS[name];
  if (!builtin) throw new Error(`Unknown built-in MCP server: ${name}`);
  registry.schema_version = 1;
  const existing = registry.servers[name] ?? {};
  registry.servers[name] = {
    ...builtin,
    ...existing,
    auth: builtin.auth,
    oauth_discovery_url: builtin.oauth_discovery_url,
    oauth: { ...builtin.oauth, ...(existing.oauth ?? {}), scopes: builtin.oauth.scopes }
  };
  saveRegistry(registry);
  return registry.servers[name];
}

export function upsertServer({ name, endpoint, oauthEndpoint, auth = "optional", targets = DEFAULT_TARGETS }) {
  const registry = loadRegistry();
  registry.schema_version = 1;
  registry.servers[name] = {
    id: name,
    label: name,
    transport: "streamable_http",
    endpoint,
    ...(oauthEndpoint ? { oauth_endpoint: oauthEndpoint } : {}),
    auth,
    enabled: true,
    targets
  };
  saveRegistry(registry);
  return registry.servers[name];
}

export function removeServer(name) {
  const registry = loadRegistry();
  if (!registry.servers[name]) return false;
  delete registry.servers[name];
  saveRegistry(registry);
  return true;
}
