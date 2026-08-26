import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const original = {
  radosHome: process.env.RADOS_HOME,
  hermesRoot: process.env.RADOS_HERMES_ROOT,
  agentRoot: process.env.RADOS_HERMES_AGENT_ROOT
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-hermes-oauth-"));
const agentRoot = path.join(root, "hermes-agent");
fs.mkdirSync(agentRoot, { recursive: true });
delete process.env.RADOS_HOME;
process.env.RADOS_HERMES_ROOT = root;
process.env.RADOS_HERMES_AGENT_ROOT = agentRoot;

const { ensureHermesMcpOAuth } = await import("../lib/hermes-oauth.mjs");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stdin = {
      writable: true,
      write: (line) => {
        const request = JSON.parse(line);
        const result = request.method === "mcp.servers.list"
          ? { servers: [{ name: "hugging_face", auth: "oauth", oauth_tokens_present: false }] }
          : request.method === "mcp.servers.oauth.start"
            ? { ok: true, session_id: "session-without-token-output", auth_url: "https://provider.example/authorize", flow: "pkce" }
            : request.method === "mcp.servers.oauth.poll"
              ? { ok: true, status: "approved", tools: [{ name: "search" }] }
              : { ok: true };
        queueMicrotask(() => this.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)));
        return true;
      },
      end: () => {}
    };
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}

test("Hermes OAuth uses browser start/poll and returns token-free evidence", async () => {
  const opened = [];
  const result = await ensureHermesMcpOAuth("huggingface", {
    python: "fake-python",
    spawnImpl: () => new FakeChild(),
    openBrowser: async (url) => {
      opened.push(url);
      return { opened: true, url };
    },
    timeoutMs: 1000,
    pollIntervalMs: 1
  });

  assert.equal(result.status, "authenticated");
  assert.equal(result.verification, "hermes_mcp_oauth_approved");
  assert.deepEqual(opened, ["https://provider.example/authorize"]);
  assert.doesNotMatch(JSON.stringify(result), /access_token|refresh_token|session-without-token-output/);
});

test.after(() => {
  if (original.radosHome === undefined) delete process.env.RADOS_HOME;
  else process.env.RADOS_HOME = original.radosHome;
  if (original.hermesRoot === undefined) delete process.env.RADOS_HERMES_ROOT;
  else process.env.RADOS_HERMES_ROOT = original.hermesRoot;
  if (original.agentRoot === undefined) delete process.env.RADOS_HERMES_AGENT_ROOT;
  else process.env.RADOS_HERMES_AGENT_ROOT = original.agentRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
