import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_SERVICE = "radoss-universal-avatar";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function openCommand(url) {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function assertSecureUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url)) throw new Error(`Refusing an insecure OAuth ${label}`);
  return url;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function openExternal(url) {
  assertSecureUrl(url, "URL");
  if (process.env.RADOSS_NO_OPEN === "1") return { opened: false, skipped: true, url };
  const { command, args } = openCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: true, url, platform: os.platform() };
}

export function openLocal(url) {
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//i.test(url)) throw new Error("Refusing to open a non-local setup URL");
  if (process.env.RADOSS_NO_OPEN === "1") return { opened: false, skipped: true, url };
  const { command, args } = openCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: true, url, platform: os.platform() };
}

function randomVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function challengeFor(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function readJsonResponse(response, label) {
  return response.text().then((text) => {
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`${label} returned invalid JSON`); }
    if (!response.ok) {
      const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
      throw new Error(`${label} failed: ${detail}`);
    }
    return body;
  });
}

function discoveryUrlFor(server) {
  if (server.oauth_discovery_url) return server.oauth_discovery_url;
  const endpoint = new URL(server.endpoint);
  return new URL("/.well-known/oauth-authorization-server", endpoint.origin).toString();
}

export async function discoverOAuth(server, { fetchImpl = fetch } = {}) {
  const discoveryUrl = discoveryUrlFor(server);
  assertSecureUrl(discoveryUrl, "discovery URL");
  const response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
  const metadata = await readJsonResponse(response, "OAuth discovery");
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (!metadata[key]) throw new Error(`OAuth discovery did not provide ${key}`);
    assertSecureUrl(metadata[key], `${key}`);
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OAuth provider does not advertise S256 PKCE support");
  }
  return { ...metadata, discovery_url: discoveryUrl };
}

function configuredClientId(server) {
  const config = server.oauth ?? {};
  const envName = config.client_id_env ?? `RADOS_${String(server.id ?? "provider").toUpperCase()}_CLIENT_ID`;
  const value = config.client_id ?? process.env[envName];
  return value ? { clientId: String(value), clientIdSource: config.client_id ? "registry" : "environment", envName } : null;
}

function redirectRegistrationUri(callbackPath) {
  return `http://127.0.0.1${callbackPath}`;
}

async function dynamicallyRegister(metadata, server, callbackPath, scopes, fetchImpl) {
  if (!metadata.registration_endpoint || server.oauth?.dynamic_registration === false) return null;
  assertSecureUrl(metadata.registration_endpoint, "registration URL");
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Radoss Universal Avatar",
      ...(server.oauth?.client_uri ? { client_uri: server.oauth.client_uri } : {}),
      redirect_uris: [redirectRegistrationUri(callbackPath)],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: scopes.join(" ")
    })
  });
  const result = await readJsonResponse(response, "OAuth client registration");
  if (!result.client_id) throw new Error("OAuth client registration returned no client_id");
  return { clientId: String(result.client_id), clientIdSource: "dynamic_registration", registration: result };
}

function tokenKey(providerId) {
  return `oauth:${providerId}`;
}

class MemoryTokenStore {
  constructor() { this.values = new Map(); }
  get(key) { return this.values.get(key) ?? null; }
  set(key, value) { this.values.set(key, value); }
  delete(key) { return this.values.delete(key); }
  describe() { return { backend: "memory", available: true, persistent: false }; }
}

class NullTokenStore {
  get() { return null; }
  set() { throw new Error("No secure OS credential store is available"); }
  delete() { return false; }
  describe() { return { backend: "unavailable", available: false, persistent: false }; }
}

class MacKeychainTokenStore {
  constructor() { this.service = TOKEN_SERVICE; }

  targetTriple() {
    if (process.arch === "arm64") return "aarch64-apple-darwin";
    if (process.arch === "x64") return "x86_64-apple-darwin";
    return null;
  }

  helperPath() {
    const siblingDir = path.dirname(process.execPath);
    const sibling = fs.existsSync(siblingDir)
      ? fs.readdirSync(siblingDir).filter((name) => name.startsWith("radoss-keychain-helper"))
          .map((name) => path.join(siblingDir, name))
      : [];
    const candidates = [
      process.env.RADOS_KEYCHAIN_HELPER,
      ...sibling,
      path.join(PROJECT_ROOT, "desktop-setup", "src-tauri", "binaries", "radoss-keychain-helper"),
      ...(this.targetTriple() ? [path.join(PROJECT_ROOT, "desktop-setup", "src-tauri", "binaries", `radoss-keychain-helper-${this.targetTriple()}`)] : [])
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  invoke(request) {
    const helper = this.helperPath();
    if (!helper) throw new Error("Native macOS Keychain helper is not installed");
    let response;
    try {
      response = JSON.parse(execFileSync(helper, [], {
        input: `${JSON.stringify({ service: this.service, ...request })}\n`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      }).trim());
    } catch (error) {
      throw new Error(`macOS Keychain helper failed: ${safeError(error)}`);
    }
    if (!response.ok) throw new Error(`macOS Keychain operation failed${response.status ? ` (${response.status})` : ""}`);
    return response;
  }

  get(key) {
    try {
      const response = this.invoke({ op: "get", account: key });
      return response.found ? JSON.parse(response.value) : null;
    } catch {
      return null;
    }
  }

  set(key, value) {
    const serialized = JSON.stringify(value);
    if (/\r|\n/.test(serialized)) throw new Error("Refusing malformed credential data");
    this.invoke({ op: "set", account: key, value: serialized });
  }

  delete(key) {
    this.invoke({ op: "delete", account: key });
    return true;
  }

  describe() { return { backend: "macos_keychain", available: Boolean(this.helperPath()), persistent: true, token_values: "native_helper_only" }; }
}

class SecretToolTokenStore {
  constructor() { this.service = TOKEN_SERVICE; }

  get(key) {
    try {
      const output = execFileSync("secret-tool", ["lookup", "service", this.service, "provider", key], { encoding: "utf8" });
      return JSON.parse(output.trim());
    } catch {
      return null;
    }
  }

  set(key, value) {
    execFileSync("secret-tool", ["store", "--label", "Radoss Universal Avatar OAuth", "service", this.service, "provider", key], {
      input: `${JSON.stringify(value)}\n`,
      stdio: ["pipe", "ignore", "pipe"]
    });
  }

  delete(key) {
    execFileSync("secret-tool", ["clear", "service", this.service, "provider", key], { stdio: "ignore" });
    return true;
  }

  describe() { return { backend: "libsecret", available: true, persistent: true }; }
}

let defaultTokenStore;

export function createMemoryTokenStore() { return new MemoryTokenStore(); }

export function getTokenStore() {
  if (defaultTokenStore) return defaultTokenStore;
  if (process.env.RADOS_TOKEN_STORE === "memory") defaultTokenStore = new MemoryTokenStore();
  else if (process.env.RADOS_TOKEN_STORE === "none") defaultTokenStore = new NullTokenStore();
  else if (process.platform === "darwin") defaultTokenStore = new MacKeychainTokenStore();
  else if (process.platform === "linux") {
    try { execFileSync("secret-tool", ["--version"], { stdio: "ignore" }); defaultTokenStore = new SecretToolTokenStore(); }
    catch { defaultTokenStore = new NullTokenStore(); }
  } else defaultTokenStore = new NullTokenStore();
  return defaultTokenStore;
}

export function tokenStorageStatus() { return getTokenStore().describe(); }

export function deleteStoredToken(providerId, { tokenStore = getTokenStore() } = {}) {
  const key = tokenKey(providerId);
  if (!tokenStore.get(key)) return { status: "absent", deleted: false };
  tokenStore.delete(key);
  if (tokenStore.get(key)) throw new Error("Credential store did not remove the provider credential");
  return { status: "deleted", deleted: true };
}

export function getStoredToken(providerId, { tokenStore = getTokenStore() } = {}) { return tokenStore.get(tokenKey(providerId)); }

async function refreshToken(server, stored, { metadata, tokenStore, fetchImpl }) {
  if (!stored?.refresh_token || !metadata) return stored;
  if (stored.expires_at && stored.expires_at > Date.now() + 60_000) return stored;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: stored.client_id,
    resource: server.oauth?.resource ?? server.endpoint
  });
  const response = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const tokens = await readJsonResponse(response, "OAuth token refresh");
  const next = { ...stored, ...tokens, expires_at: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : null };
  tokenStore.set(tokenKey(server.id), next);
  return next;
}

export async function getStoredAccessToken(server, { metadata, fetchImpl = fetch, tokenStore = getTokenStore() } = {}) {
  let stored = tokenStore.get(tokenKey(server.id));
  if (!stored) return null;
  if (stored.expires_at && stored.expires_at <= Date.now() + 60_000) {
    let resolvedMetadata = metadata;
    if (!resolvedMetadata) {
      try { resolvedMetadata = await discoverOAuth(server, { fetchImpl }); } catch { resolvedMetadata = null; }
    }
    if (resolvedMetadata) stored = await refreshToken(server, stored, { metadata: resolvedMetadata, tokenStore, fetchImpl });
  }
  return stored?.access_token ?? null;
}

function callbackPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><p>${message}</p><p>You can close this window.</p>`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

export async function startPkceOAuth(server, {
  metadata,
  clientId,
  clientIdSource = "configured",
  scopes = server.oauth?.scopes ?? ["openid", "profile", "read-mcp"],
  callbackPath = "/callback",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  tokenStore = getTokenStore(),
  openBrowser = openExternal
} = {}) {
  if (!metadata) throw new Error("OAuth metadata is required");
  if (!clientId) throw new Error("OAuth client_id is required");
  const verifier = randomVerifier();
  const challenge = challengeFor(verifier);
  const state = crypto.randomBytes(32).toString("base64url");
  let callbackServer;
  let timeout;

  try {
    const result = await new Promise(async (resolve, reject) => {
    callbackServer = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackPage("Not found", "This OAuth callback is not valid."));
        return;
      }
      if (requestUrl.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackPage("Sign-in failed", "The security state did not match. Return to the setup window and retry."));
        reject(new Error("OAuth state mismatch"));
        return;
      }
      const providerError = requestUrl.searchParams.get("error");
      if (providerError) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackPage("Sign-in not completed", "The provider did not complete account connection."));
        reject(new Error(`OAuth authorization failed: ${providerError}`));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackPage("Sign-in failed", "No authorization code was returned."));
        reject(new Error("OAuth callback did not contain a code"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${callbackServer.address().port}${callbackPath}`;
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: server.oauth?.resource ?? server.endpoint
        });
        const tokenResponse = await fetchImpl(metadata.token_endpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body
        });
        const tokens = await readJsonResponse(tokenResponse, "OAuth token exchange");
        if (!tokens.access_token) throw new Error("OAuth token exchange returned no access_token");
        let account = null;
        if (metadata.userinfo_endpoint) {
          const userinfoResponse = await fetchImpl(metadata.userinfo_endpoint, {
            headers: { accept: "application/json", authorization: `Bearer ${tokens.access_token}` }
          });
          account = await readJsonResponse(userinfoResponse, "OAuth userinfo");
        }
        const stored = {
          ...tokens,
          client_id: clientId,
          provider: server.id,
          resource: server.oauth?.resource ?? server.endpoint,
          obtained_at: new Date().toISOString(),
          expires_at: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : null
        };
        tokenStore.set(tokenKey(server.id), stored);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(callbackPage("Connected", "Your account is connected to Radoss Universal Avatar."));
        resolve({
          provider: server.id,
          mode: "pkce_loopback",
          status: "authenticated",
          verification: account ? "provider_userinfo_verified" : "token_received",
          client_id: clientId,
          account: account ? {
            subject: account.sub ?? account.id ?? null,
            username: account.preferred_username ?? account.username ?? account.name ?? null,
            name: account.name ?? null
          } : null,
          token_storage: tokenStore.describe(),
          token_reference: `${tokenStore.describe().backend}:${TOKEN_SERVICE}/${server.id}`,
          client_id_source: clientIdSource,
          redirect_uri: redirectUri
        });
      } catch (error) {
        response.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(callbackPage("Sign-in failed", "Radoss could not verify the provider response. Return to setup and retry."));
        reject(new Error(safeError(error)));
      }
    });

    try {
      const address = await listen(callbackServer);
      const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
      const authorizeUrl = new URL(metadata.authorization_endpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("resource", server.oauth?.resource ?? server.endpoint);
      authorizeUrl.searchParams.set("scope", scopes.join(" "));
      const opened = await openBrowser(authorizeUrl.toString());
      if (opened?.skipped) {
        resolve({
          provider: server.id,
          mode: "pkce_loopback",
          status: "browser_open_skipped",
          verification: "pending_provider_confirmation",
          client_id: clientId,
          client_id_source: clientIdSource,
          redirect_uri: redirectUri,
          token_storage: tokenStore.describe()
        });
        return;
      }
      timeout = setTimeout(() => reject(new Error("OAuth callback timed out")), timeoutMs);
    } catch (error) {
      reject(error);
    }
    });
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    await closeServer(callbackServer);
  }
}

export async function startBrowserLogin(server, { forcePkce = false, ...options } = {}) {
  const tokenStore = options.tokenStore ?? getTokenStore();
  const storage = tokenStore.describe();
  if (!storage.available) {
    throw new Error(`Secure OS credential storage is unavailable (${storage.backend}); configure the platform credential store before connecting an account`);
  }
  if (!forcePkce && process.env.RADOSS_NO_OPEN === "1") {
    return {
      provider: server.id,
      mode: "provider_managed",
      status: "browser_open_skipped",
      url: server.oauth_endpoint ?? server.endpoint,
      verification: "pending_provider_confirmation",
      token_storage: tokenStorageStatus()
    };
  }

  let metadata;
  let client;
  let scopes;
  try {
    metadata = options.metadata ?? await discoverOAuth(server, options);
    scopes = options.scopes ?? server.oauth?.scopes ?? ["openid", "profile", "read-mcp"];
    client = configuredClientId(server);
    if (!client) client = await dynamicallyRegister(metadata, server, options.callbackPath ?? "/callback", scopes, options.fetchImpl ?? fetch);
    if (!client) throw new Error("No public OAuth client is configured and dynamic registration is unavailable");
  } catch (error) {
    if (options.allowProviderFallback === false) throw error;
    const url = server.oauth_endpoint ?? server.endpoint;
    const opened = openExternal(url);
    return {
      provider: server.id,
      mode: "provider_managed_fallback",
      status: opened.opened ? "browser_opened" : "browser_open_skipped",
      url,
      verification: "pending_provider_confirmation",
      oauth_error: safeError(error),
      token_storage: tokenStorageStatus()
    };
  }
  return startPkceOAuth(server, { ...options, metadata, scopes, tokenStore, ...client });
}
