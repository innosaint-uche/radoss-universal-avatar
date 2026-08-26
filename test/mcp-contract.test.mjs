import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeMcpProtocol, runMcpConformance } from "../lib/mcp-contract.mjs";

function createFixture({ compliant = true } = {}) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    if (request.headers.origin === "https://evil.example") {
      response.writeHead(403).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    let message;
    try { message = JSON.parse(body); } catch {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    if (!compliant) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ service: "legacy-rest" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("mcp-session-id", "fixture-session");
    if (message.method === "initialize") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (message.method === "tools/list") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "avatar_status", inputSchema: { type: "object" } }] } }));
      return;
    }
    if (message.method === "tools/call") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Avatar is ready" }] } }));
      return;
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test("MCP conformance harness passes lifecycle, tools, errors, session, and Origin gates", async () => {
  const server = createFixture();
  const endpoint = await listen(server);
  try {
    const evidence = await runMcpConformance(endpoint);
    assert.equal(evidence.status, "pass");
    assert.equal(evidence.session, "negotiated");
    assert.ok(evidence.checks.every((item) => item.passed));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local protocol probe validates lifecycle and tool discovery", async () => {
  const server = createFixture();
  const endpoint = await listen(server);
  try {
    const evidence = await probeMcpProtocol(endpoint);
    assert.equal(evidence.status, "healthy");
    assert.equal(evidence.session, "negotiated");
    assert.equal(evidence.tools_count, 1);
    assert.equal(evidence.authenticated, "unverified");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local protocol probe rejects a REST-like endpoint", async () => {
  const server = createFixture({ compliant: false });
  const endpoint = await listen(server);
  try {
    const evidence = await probeMcpProtocol(endpoint);
    assert.equal(evidence.status, "failed");
    assert.match(evidence.error, /JSON-RPC|result|envelope/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP conformance harness rejects a REST-like endpoint", async () => {
  const server = createFixture({ compliant: false });
  const endpoint = await listen(server);
  try {
    const evidence = await runMcpConformance(endpoint);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.checks[0].name, "initialize");
    assert.equal(evidence.checks[0].passed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
