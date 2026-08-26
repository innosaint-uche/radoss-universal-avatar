const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;
const CREDENTIAL_PATTERN = /access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization/i;

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return "[invalid endpoint]";
  }
}

function safeFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS resolution failed (${code})`;
  if (code === "ECONNREFUSED") return "connection refused (ECONNREFUSED)";
  if (error?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return "request timed out";
  return error?.message ? String(error.message).replace(/https?:\/\/\S+/gi, "[endpoint]") : "request failed";
}

function contentType(response) {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  if (contentType(response).includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find(Boolean);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return { raw_event: true }; }
  }
  try { return JSON.parse(text); } catch { return { raw_text: true }; }
}

function assertJsonRpcEnvelope(body, label) {
  if (!body || body.jsonrpc !== "2.0") throw new Error(`${label} did not return a JSON-RPC 2.0 envelope`);
  if (!Object.hasOwn(body, "result") && !Object.hasOwn(body, "error")) throw new Error(`${label} returned neither result nor error`);
  return body;
}

function assertNoCredentialFields(body, label) {
  const hasCredentialKey = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasCredentialKey);
    return Object.entries(value).some(([key, nested]) => CREDENTIAL_PATTERN.test(key) || hasCredentialKey(nested));
  };
  if (hasCredentialKey(body)) {
    throw new Error(`${label} exposed a credential-shaped field`);
  }
}

function responseSessionId(response) {
  return response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? null;
}

async function postJsonRpc(endpoint, message, {
  token = null,
  sessionId = null,
  origin = null,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(origin ? { origin } : {})
  };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs)
  });
  return {
    response,
    body: await readResponseBody(response),
    sessionId: responseSessionId(response)
  };
}

function check(name, passed, detail = null) {
  return { name, passed: Boolean(passed), ...(detail ? { detail } : {}) };
}

function requireResult(envelope, label) {
  assertJsonRpcEnvelope(envelope, label);
  if (envelope.error) throw new Error(`${label} returned JSON-RPC error ${envelope.error.code ?? "unknown"}`);
  return envelope.result;
}

function validateTools(result, label = "tools/list") {
  const tools = Array.isArray(result?.tools) ? result.tools : null;
  if (!tools) throw new Error(`${label} did not return a tools array`);
  const names = tools.map((tool) => tool?.name).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error(`${label} returned duplicate tool names`);
  if (!tools.every((tool) => tool && typeof tool.name === "string" && tool.inputSchema && typeof tool.inputSchema === "object")) {
    throw new Error(`${label} returned a tool without a name or inputSchema`);
  }
  return tools;
}

/**
 * Run the minimum live protocol probe used by local setup and doctor commands.
 * This is intentionally smaller than the public release contract: it verifies
 * protocol behaviour and tool discovery without requiring a particular Avatar
 * tool or making a hostile-Origin assertion against a provider endpoint.
 */
export async function probeMcpProtocol(endpoint, {
  token = null,
  protocolVersion = "2025-03-26",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const startedAt = Date.now();
  let sessionId = null;
  let initializeResponse = null;
  try {
    initializeResponse = await postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "radoss-universal-cli", version: "0.2.0" }
      }
    }, { token, fetchImpl, timeoutMs });
    if (!initializeResponse.response.ok) throw new Error(`HTTP ${initializeResponse.response.status}`);
    const result = requireResult(initializeResponse.body, "initialize");
    if (!result.protocolVersion || !result.serverInfo) throw new Error("initialize omitted protocolVersion or serverInfo");
    sessionId = initializeResponse.sessionId;

    const initialized = await postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { token, sessionId, fetchImpl, timeoutMs });
    if (![200, 202, 204].includes(initialized.response.status)) throw new Error(`notifications/initialized HTTP ${initialized.response.status}`);

    const listed = await postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, { token, sessionId, fetchImpl, timeoutMs });
    const tools = validateTools(requireResult(listed.body, "tools/list"));
    return {
      status: "healthy",
      http_status: initializeResponse.response.status,
      content_type: contentType(initializeResponse.response) || null,
      response_ms: Date.now() - startedAt,
      authenticated: "unverified",
      jsonrpc_result: true,
      session: sessionId ? "negotiated" : "not_returned",
      tools_count: tools.length
    };
  } catch (error) {
    return {
      status: "failed",
      http_status: initializeResponse?.response?.status ?? null,
      content_type: initializeResponse ? contentType(initializeResponse.response) || null : null,
      response_ms: Date.now() - startedAt,
      authenticated: "unverified",
      jsonrpc_result: false,
      session: sessionId ? "negotiated" : "not_returned",
      error: safeFailure(error)
    };
  }
}

/**
 * Run the release-gate contract for an HTTPS or loopback Streamable HTTP MCP endpoint.
 * The returned evidence is deliberately token-free and does not include provider payloads.
 */
export async function runMcpConformance(endpoint, {
  token = null,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  origin = "https://evil.example",
  requireStrictOrigin = true,
  statusTool = "avatar_status",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const checks = [];
  let sessionId = null;
  const endpointLabel = safeUrl(endpoint);

  let initialize;
  try {
    initialize = await postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "radoss-mcp-contract", version: "0.2.0" }
      }
    }, { token, fetchImpl, timeoutMs });
    if (!initialize.response.ok) throw new Error(`HTTP ${initialize.response.status}`);
    const result = requireResult(initialize.body, "initialize");
    if (!result.protocolVersion || !result.serverInfo) throw new Error("initialize omitted protocolVersion or serverInfo");
    sessionId = initialize.sessionId;
    checks.push(check("initialize", true, `protocol=${result.protocolVersion}`));
  } catch (error) {
    checks.push(check("initialize", false, safeFailure(error)));
    return { endpoint: endpointLabel, status: "fail", checks };
  }

  try {
    const initialized = await postJsonRpc(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, { token, sessionId, fetchImpl, timeoutMs });
    if (![200, 202, 204].includes(initialized.response.status)) throw new Error(`HTTP ${initialized.response.status}`);
    checks.push(check("notifications/initialized", true));
  } catch (error) {
    checks.push(check("notifications/initialized", false, safeFailure(error)));
  }

  let tools = [];
  try {
    const listed = await postJsonRpc(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { token, sessionId, fetchImpl, timeoutMs });
    const result = requireResult(listed.body, "tools/list");
    tools = validateTools(result);
    checks.push(check("tools/list", true, `${tools.length} tools`));
  } catch (error) {
    checks.push(check("tools/list", false, safeFailure(error)));
  }

  if (tools.some((tool) => tool.name === statusTool)) {
    try {
      const called = await postJsonRpc(endpoint, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: statusTool, arguments: {} }
      }, { token, sessionId, fetchImpl, timeoutMs });
      const result = requireResult(called.body, `tools/call ${statusTool}`);
      assertNoCredentialFields(result, `tools/call ${statusTool}`);
      checks.push(check("tools/call", true, statusTool));
    } catch (error) {
      checks.push(check("tools/call", false, safeFailure(error)));
    }
  } else {
    checks.push(check("tools/call", false, `required read-only tool not found: ${statusTool}`));
  }

  try {
    const invalid = await postJsonRpc(endpoint, { jsonrpc: "2.0", id: 4, method: "method/does-not-exist" }, { token, sessionId, fetchImpl, timeoutMs });
    if (!invalid.body?.error || invalid.body.error.code !== -32601) throw new Error("expected JSON-RPC method-not-found error -32601");
    checks.push(check("invalid method", true));
  } catch (error) {
    checks.push(check("invalid method", false, safeFailure(error)));
  }

  if (requireStrictOrigin) {
    try {
      const hostile = await postJsonRpc(endpoint, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, { token, sessionId, origin, fetchImpl, timeoutMs });
      if (![400, 401, 403, 404].includes(hostile.response.status)) throw new Error(`hostile Origin was accepted with HTTP ${hostile.response.status}`);
      checks.push(check("strict Origin policy", true));
    } catch (error) {
      checks.push(check("strict Origin policy", false, safeFailure(error)));
    }
  }

  return {
    endpoint: endpointLabel,
    status: checks.every((item) => item.passed) ? "pass" : "fail",
    checks,
    session: sessionId ? "negotiated" : "not_returned"
  };
}
