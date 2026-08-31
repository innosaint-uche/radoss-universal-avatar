const PUBLIC_ENDPOINT_PROTOCOL = "https:";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const HOSTING_MODES = ["local", "user_hosted", "existing_endpoint", "managed_naas"];

export const HOSTING_PROVIDERS = {
  cloudflare: {
    id: "cloudflare",
    label: "My Cloudflare account",
    ownership: "user",
    authorization: "browser_provider_login",
    console_url: "https://dash.cloudflare.com/",
    next_step: "Authorize in Cloudflare, deploy the reviewed Worker template, then verify its endpoint."
  },
  coolify: {
    id: "coolify",
    label: "My VPS / Coolify account",
    ownership: "user",
    authorization: "provider_managed_or_instance_login",
    console_url: null,
    next_step: "Open your Coolify instance, deploy the reviewed container, then verify its HTTPS MCP endpoint."
  },
  existing: {
    id: "existing",
    label: "An endpoint I already own",
    ownership: "user",
    authorization: "endpoint_oauth",
    console_url: null,
    next_step: "Save the endpoint and complete its browser OAuth connection."
  },
  naas: {
    id: "naas",
    label: "Optional NAAvOS-managed service",
    ownership: "radoss",
    authorization: "host_managed",
    console_url: "https://naavos.radoss.agency",
    next_step: "Use only if you explicitly choose the optional managed service."
  }
};

export const DEFAULT_HOSTING = {
  mode: "local",
  provider: null,
  endpoint: null,
  status: "local_ready",
  ownership: "user",
  updated_at: null
};

function isLoopback(url) {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function normalizeEndpoint(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("Online endpoint must be a valid URL"); }
  if (url.protocol !== PUBLIC_ENDPOINT_PROTOCOL && !isLoopback(url)) {
    throw new Error("Online endpoint must use HTTPS (or HTTP only on loopback)");
  }
  if (url.username || url.password) throw new Error("Endpoint credentials must never be placed in the URL");
  if ([...url.searchParams.keys()].some((key) => /(token|secret|password|api[_-]?key|authorization)/i.test(key))) {
    throw new Error("Endpoint URLs must not contain credentials or access tokens");
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

export function normalizeHostingRequest({ mode = "local", provider = null, endpoint = null } = {}) {
  if (!HOSTING_MODES.includes(mode)) throw new Error(`Unsupported hosting mode: ${mode}`);
  if (mode === "local") return { ...DEFAULT_HOSTING, mode, updated_at: new Date().toISOString() };
  const resolvedProvider = provider || (mode === "existing_endpoint" ? "existing" : null);
  if (!resolvedProvider || !HOSTING_PROVIDERS[resolvedProvider]) throw new Error("Choose a supported hosting provider");
  if (mode === "user_hosted" && resolvedProvider === "naas") throw new Error("NAAvOS-managed hosting is not a user-owned hosting profile");
  if (mode === "existing_endpoint" && resolvedProvider !== "existing") throw new Error("An existing endpoint must use the existing-endpoint provider");
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (mode === "existing_endpoint" && !normalizedEndpoint) throw new Error("Enter the HTTPS endpoint you already own");
  const ownership = HOSTING_PROVIDERS[resolvedProvider].ownership;
  return {
    mode,
    provider: resolvedProvider,
    endpoint: normalizedEndpoint,
    status: normalizedEndpoint ? "endpoint_configured_unverified" : mode === "managed_naas" ? "managed_choice_unconfigured" : "awaiting_provider_deployment",
    ownership,
    updated_at: new Date().toISOString()
  };
}

export function hostingStatus(state) {
  const hosting = { ...DEFAULT_HOSTING, ...(state?.hosting ?? {}) };
  const provider = hosting.provider ? HOSTING_PROVIDERS[hosting.provider] : null;
  return {
    ...hosting,
    provider_label: provider?.label ?? "Local only",
    next_step: hosting.mode === "local" ? "Your Avatar stays on this device; no online service is required." : provider?.next_step ?? "Choose how your online Avatar should be hosted.",
    options: Object.values(HOSTING_PROVIDERS).map(({ id, label, ownership, authorization }) => ({ id, label, ownership, authorization }))
  };
}
