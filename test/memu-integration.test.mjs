import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const python = process.env.NAAVOS_MEMU_TEST_PYTHON;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-memu-integration-"));
process.env.RADOS_HOME = home;
process.env.RADOSS_NO_OPEN = "1";
process.env.NAAVOS_TEST_EMBEDDING_KEY = "local-fixture-only";
const runtime = await import("../lib/setup-runtime.mjs");
const memory = await import("../lib/avatar-memory.mjs");
const memu = await import("../lib/memu-memory.mjs");
const profiles = await import("../lib/avatar-profile.mjs");

function tool(name, args = {}) {
  return new Promise((resolve, reject) => {
    const executable = process.env.NAAVOS_MEMU_TEST_EXECUTABLE || process.execPath;
    const launcherArgs = process.env.NAAVOS_MEMU_TEST_EXECUTABLE ? ["--mcp-stdio"] : ["bin/radoss-mcp.mjs"];
    const child = spawn(executable, launcherArgs, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", data => out += data);
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", code => {
      try { assert.equal(code, 0); const result = JSON.parse(out.trim()).result; resolve(result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text)); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

test("headless profile creation, confirmation, and pause work through actual MCP", async () => {
  const profile = { name: "MemU Test User", tone: "Direct", structure: "Paragraphs", verbosity: "Concise", rules: ["Ask before saving memory"] };
  assert.match((await tool("avatar_profile_save", { profile })).error, /confirm/);
  const saved = await tool("avatar_profile_save", { profile, confirm: true });
  assert.equal(saved.profile.identity.name, profile.name);
  assert.equal(profiles.getAvatarProfile().identity.name, profile.name);
  runtime.setPrivacyMode("paused");
  assert.match((await tool("avatar_profile_save", { profile, confirm: true })).error, /paused/);
  runtime.setPrivacyMode("local_only");
});

test("MemU configuration requires explicit data-sharing consent and never accepts raw secrets", async () => {
  await assert.rejects(memu.installMemu({}), /confirm/);
  await assert.rejects(memu.installMemu({ python: "python3 --unsafe", confirm: true }), /Python executable/);
  await assert.rejects(memu.configureMemu({ mode: "local" }), /confirm/);
  await assert.rejects(memu.configureMemu({ mode: "local", provider: "jina", api_key_env: "JINA_API_KEY" }, { confirm: true }), /allow_network/);
  await assert.rejects(memu.configureMemu({ mode: "local", provider: "jina", api_key_env: "JINA_API_KEY", api_key: "secret", allow_network: true }, { confirm: true }), /Unknown/);
  assert.equal(fs.existsSync(memu.MEMU_CONFIG_PATH), false);
});

test("real MemU + native SQLite + fixture embeddings: MCP semantic recall, deletion, outage fallback, pause and scope", { skip: !python, timeout: 120000 }, async t => {
  let requests = 0, down = false, payloads = [];
  const server = http.createServer(async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    payloads.push(JSON.stringify(body));
    if (down) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"fixture unavailable"}'); return; }
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const vector = text => /bicycle|cycle|bike/i.test(text) ? [1, 0, 0] : /guitar|music|instrument/i.test(text) ? [0, 1, 0] : [0, 0, 1];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map((text, index) => ({ object: "embedding", index, embedding: vector(text) })), model: "fixture", usage: { total_tokens: input.length, prompt_tokens: input.length } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const state = (await runtime.setupStatus()).avatar;
  memory.remember({ avatarId: "another-avatar", content: "OTHER OWNER PRIVATE MEMORY", approved: true });
  memory.remember({ avatarId: state.id, content: "UNAPPROVED PRIVATE MEMORY", approved: false });
  const note = await tool("avatar_remember", { content: "I commute by bicycle.", confirm: true });
  await tool("avatar_remember", { content: "I play guitar.", confirm: true });
  const configured = await tool("avatar_memu_configure", { confirm: true, config: { python, provider: "jina", mode: "local", api_key_env: "NAAVOS_TEST_EMBEDDING_KEY", model: "fixture", base_url: `http://127.0.0.1:${server.address().port}`, allow_network: true } });
  assert.equal(configured.status, "ready", JSON.stringify(configured));
  assert.equal(configured.indexed, 2);
  assert.ok(requests > 0);
  assert.ok(payloads.every(x => !/OTHER OWNER|UNAPPROVED/.test(x)));
  assert.ok(!fs.readFileSync(memu.MEMU_CONFIG_PATH, "utf8").includes("local-fixture-only"));

  const result = await tool("avatar_memory_search", { query: "How do I cycle to the office?" });
  assert.equal(result.engine, "memu", JSON.stringify(result));
  assert.equal(result.items[0].id, note.id);
  assert.equal(memory.searchMemory({ avatarId: state.id, query: "cycle" }).length, 0, "FTS cannot supply the semantic synonym match");

  const removed = await tool("avatar_memory_delete", { id: note.id, confirm: true });
  assert.equal(removed.deleted, true);
  assert.equal(removed.memu.status, "ready");
  assert.ok(!(await tool("avatar_memory_search", { query: "cycle" })).items.some(x => x.id === note.id));
  const db = new DatabaseSync(memu.MEMU_INDEX_PATH);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const contents = tables.flatMap(({ name }) => db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
  db.close();
  assert.ok(!JSON.stringify(contents).includes("I commute by bicycle"), "Deleted content must leave active MemU records and segments");

  runtime.setPrivacyMode("paused");
  const before = requests;
  assert.match((await tool("avatar_memory_search", { query: "guitar" })).error, /paused/);
  assert.match((await tool("avatar_memu_sync", { confirm: true })).error, /paused/);
  assert.equal(requests, before, "Pause blocks backend calls");
  runtime.setPrivacyMode("local_only");

  down = true;
  const fallback = await tool("avatar_memory_search", { query: "guitar" });
  assert.equal(fallback.engine, "sqlite_fts5");
  assert.equal(fallback.degraded, true);
  assert.equal(fallback.items[0].content, "I play guitar.");
  assert.ok(!JSON.stringify(fallback).includes("local-fixture-only"));
  down = false;
  const sync = await tool("avatar_memu_sync", { confirm: true });
  assert.equal(sync.status, "ready");
  const originalConfig = fs.readFileSync(memu.MEMU_CONFIG_PATH, "utf8");
  const cloudConfig = { ...JSON.parse(originalConfig), mode: "cloud", ledger_id: "lost-original-ledger" };
  delete cloudConfig.base_url;
  fs.writeFileSync(memu.MEMU_CONFIG_PATH, JSON.stringify(cloudConfig));
  runtime.setPrivacyMode("local_and_sync");
  const beforeGuard = requests;
  const guarded = await tool("avatar_memory_search", { query: "guitar" });
  assert.equal(guarded.engine, "sqlite_fts5");
  assert.match(guarded.memu_error, /replaced or lost/);
  assert.equal(requests, beforeGuard, "Lost local storage must not overwrite the cloud projection");
  runtime.setPrivacyMode("local_only");
  fs.writeFileSync(memu.MEMU_CONFIG_PATH, '{"accidental_private_value":"do-not-echo-this"');
  assert.equal(memu.memuStatus().status, "invalid_configuration");
  const invalid = await tool("avatar_memory_search", { query: "guitar" });
  assert.equal(invalid.engine, "sqlite_fts5");
  assert.ok(!JSON.stringify(invalid).includes("do-not-echo-this"));
  fs.writeFileSync(memu.MEMU_CONFIG_PATH, originalConfig);
  assert.equal((await tool("avatar_memu_disable", { confirm: true })).status, "disabled");
  const after = requests;
  assert.equal((await tool("avatar_memory_search", { query: "guitar" })).engine, "sqlite_fts5");
  assert.equal(requests, after);
});
