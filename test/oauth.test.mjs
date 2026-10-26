import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.RADOS_TOKEN_STORE = "memory";
delete process.env.RADOSS_NO_OPEN;

const oauth = await import("../lib/oauth.mjs");

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("PKCE loopback OAuth exchanges a code, verifies userinfo, and stores no token in the result", async () => {
  let tokenRequest;
  const provider = http.createServer(async (request, response) => {
    if (request.url === "/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      tokenRequest = new URLSearchParams(body);
      return json(response, 200, { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600, token_type: "Bearer" });
    }
    if (request.url === "/userinfo") {
      assert.equal(request.headers.authorization, "Bearer fixture-access-token");
      return json(response, 200, { sub: "fixture-subject", preferred_username: "fixture-user", name: "Fixture User" });
    }
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = provider.address().port;
  const tokenStore = oauth.createMemoryTokenStore();
  const server = {
    id: "fixture",
    endpoint: `http://127.0.0.1:${port}/mcp`,
    oauth: { resource: `http://127.0.0.1:${port}/mcp`, scopes: ["openid", "profile", "read-mcp"] }
  };
  const metadata = {
    authorization_endpoint: "https://provider.example/authorize",
    token_endpoint: `http://127.0.0.1:${port}/token`,
    userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    code_challenge_methods_supported: ["S256"]
  };

  try {
    const result = await oauth.startPkceOAuth(server, {
      metadata,
      clientId: "fixture-client",
      tokenStore,
      timeoutMs: 2000,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
        assert.match(authorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]+$/);
        const callback = new URL(authorize.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", authorize.searchParams.get("state"));
        const callbackResponse = await fetch(callback);
        assert.equal(callbackResponse.status, 200);
        return { opened: true, url };
      }
    });

    assert.equal(result.status, "authenticated");
    assert.equal(result.verification, "provider_userinfo_verified");
    assert.equal(result.account.username, "fixture-user");
    assert.equal(result.token_storage.backend, "memory");
    assert.equal("access_token" in result, false);
    assert.equal(tokenRequest.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest.get("client_id"), "fixture-client");
    assert.equal(tokenRequest.get("resource"), server.oauth.resource);
    assert.ok(tokenRequest.get("code_verifier"));
    assert.equal(await oauth.getStoredAccessToken(server, { tokenStore }), "fixture-access-token");
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("OAuth discovery requires advertised S256 PKCE", async () => {
  await assert.rejects(
    oauth.discoverOAuth({ id: "fixture", endpoint: "https://example.com/mcp", oauth_discovery_url: "https://example.com/.well-known/oauth-authorization-server" }, {
      fetchImpl: async () => new Response(JSON.stringify({ authorization_endpoint: "https://example.com/authorize", token_endpoint: "https://example.com/token", code_challenge_methods_supported: ["plain"] }), { status: 200, headers: { "content-type": "application/json" } })
    }),
    /S256 PKCE/
  );
});

test("browser login can dynamically register a public client without exposing credentials", async () => {
  let registrationBody;
  const provider = http.createServer(async (request, response) => {
    if (request.url === "/register") {
      let body = "";
      for await (const chunk of request) body += chunk;
      registrationBody = JSON.parse(body);
      return json(response, 201, { client_id: "dynamic-client" });
    }
    if (request.url === "/token") return json(response, 200, { access_token: "dynamic-access", expires_in: 3600 });
    if (request.url === "/userinfo") return json(response, 200, { sub: "dynamic-sub", preferred_username: "dynamic-user" });
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = provider.address().port;
  const tokenStore = oauth.createMemoryTokenStore();
  const server = {
    id: "dynamic",
    endpoint: `http://127.0.0.1:${port}/mcp`,
    oauth: { resource: `http://127.0.0.1:${port}/mcp`, scopes: ["openid", "profile", "read-mcp"], dynamic_registration: true }
  };
  const metadata = {
    authorization_endpoint: "https://provider.example/authorize",
    token_endpoint: `http://127.0.0.1:${port}/token`,
    userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    registration_endpoint: `http://127.0.0.1:${port}/register`,
    code_challenge_methods_supported: ["S256"]
  };
  try {
    const result = await oauth.startBrowserLogin(server, {
      metadata,
      tokenStore,
      timeoutMs: 2000,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", "dynamic-code");
        callback.searchParams.set("state", authorize.searchParams.get("state"));
        assert.equal((await fetch(callback)).status, 200);
        return { opened: true, url };
      }
    });
    assert.equal(result.status, "authenticated");
    assert.equal(result.client_id_source, "dynamic_registration");
    assert.equal(registrationBody.token_endpoint_auth_method, "none");
    assert.deepEqual(registrationBody.redirect_uris, ["http://127.0.0.1/callback"]);
    assert.equal("access_token" in result, false);
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("browser login fails before opening OAuth when secure storage is unavailable", async () => {
  const unavailableStore = {
    describe: () => ({ backend: "unavailable", available: false, persistent: false })
  };
  await assert.rejects(
    oauth.startBrowserLogin({ id: "fixture", endpoint: "https://provider.example/mcp" }, {
      tokenStore: unavailableStore,
      metadata: {
        authorization_endpoint: "https://provider.example/authorize",
        token_endpoint: "https://provider.example/token",
        code_challenge_methods_supported: ["S256"]
      },
      openBrowser: async () => { throw new Error("browser must not open"); }
    }),
    /Secure OS credential storage is unavailable/
  );
});

test("expired cached tokens are not returned when refresh discovery is unavailable", async () => {
  const tokenStore = oauth.createMemoryTokenStore();
  tokenStore.set("oauth:expired", { access_token: "expired-fixture", expires_at: Date.now() - 1000 });
  const token = await oauth.getStoredAccessToken({ id: "expired", endpoint: "https://provider.example/mcp" }, {
    tokenStore, fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(token, null);
});

test("refresh responses require a new valid token and cannot turn an expired token into an unbounded session", async () => {
  const tokenStore = oauth.createMemoryTokenStore();
  tokenStore.set("oauth:refresh", { access_token: "expired-fixture", refresh_token: "refresh-fixture", client_id: "client", expires_at: Date.now() - 1000 });
  const stored = structuredClone(tokenStore.get("oauth:refresh"));
  const server = { id: "refresh", endpoint: "https://provider.example/mcp" };
  const metadata = { token_endpoint: "https://provider.example/token" };
  await assert.rejects(oauth.getStoredAccessToken(server, { tokenStore, metadata, fetchImpl: async () => Response.json({}) }), /no valid access_token/);
  assert.deepEqual(tokenStore.get("oauth:refresh"), stored);
  await assert.rejects(oauth.getStoredAccessToken(server, { tokenStore, metadata, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return Response.json({ access_token: "new-fixture", expires_in: "forever" });
  } }), /invalid expires_in/);
  assert.deepEqual(tokenStore.get("oauth:refresh"), stored);
  assert.equal(await oauth.getStoredAccessToken(server, { tokenStore, metadata, fetchImpl: async () => Response.json({ access_token: "new-fixture", expires_in: 3600 }) }), "new-fixture");
});

test("OAuth rejects insecure userinfo before opening the browser or sending a bearer token", async () => {
  await assert.rejects(oauth.startPkceOAuth({ id: "insecure", endpoint: "https://provider.example/mcp" }, {
    metadata: { authorization_endpoint: "https://provider.example/authorize", token_endpoint: "https://provider.example/token", userinfo_endpoint: "http://public.example/userinfo" },
    clientId: "fixture", tokenStore: oauth.createMemoryTokenStore(),
    openBrowser: async () => { throw new Error("must not open"); }
  }), /insecure OAuth/);
});
