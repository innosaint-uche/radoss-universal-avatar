import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-profile-"));
process.env.RADOS_HOME = home;
process.env.RADOSS_NO_OPEN = "1";
const runtime = await import("../lib/setup-runtime.mjs");
const profiles = await import("../lib/avatar-profile.mjs");
const memory = await import("../lib/avatar-memory.mjs");
const sample = {
  name: "Example User",
  description: "A writer",
  tone: "Gentle",
  structure: "Connected prose",
  verbosity: "Detailed",
  rules: ["Ask before publishing", "Use evidence"],
};

test("local setup works without calling a provider", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("No network allowed");
  };
  try {
    const result = await runtime.runSetup({
      provider: "local",
      openAuth: false,
    });
    assert.equal(result.auth.status, "not_required");
    assert.equal(result.status.setup.phase, "local_ready");
    assert.deepEqual(result.status.providers, {});
    for (const target of ["codex", "antigravity", "hermes"])
      assert.equal(result.status.agents[target].configured, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("profile persists in SQLite and exports the shared compiler schema with private permissions", () => {
  const saved = profiles.saveAvatarProfile(sample);
  assert.deepEqual(profiles.getAvatarProfile(), saved);
  const exported = JSON.parse(
    fs.readFileSync(profiles.AVATAR_SOURCE_PATH, "utf8"),
  );
  assert.deepEqual(exported, saved);
  assert.equal(exported.identity.name, sample.name);
  assert.equal(exported.communication.structure, "Connected prose");
  assert.equal(exported.operating_rules.length, 2);
  assert.equal(exported.privacy.consents["allow-cloud-sync"], false);
  assert.equal(fs.statSync(profiles.AVATAR_SOURCE_PATH).mode & 0o777, 0o600);
});

test("profile validation and external edits preserve the last valid source", () => {
  const before = fs.readFileSync(profiles.AVATAR_SOURCE_PATH, "utf8");
  assert.throws(
    () => profiles.saveAvatarProfile({ ...sample, name: "" }),
    /Name/,
  );
  assert.throws(
    () => profiles.saveAvatarProfile({ ...sample, rules: [] }),
    /rules/,
  );
  assert.throws(
    () => profiles.saveAvatarProfile({ ...sample, unexpected: true }),
    /Unknown/,
  );
  assert.equal(fs.readFileSync(profiles.AVATAR_SOURCE_PATH, "utf8"), before);
  const edited = JSON.parse(before);
  edited.identity.name = "Externally edited";
  fs.writeFileSync(profiles.AVATAR_SOURCE_PATH, JSON.stringify(edited));
  assert.throws(() => profiles.saveAvatarProfile(sample), /external edits/);
  fs.writeFileSync(profiles.AVATAR_SOURCE_PATH, before);
});

test("connected agents read saved preferences and approved memory, and pause blocks private context", () => {
  const profile = profiles.getAvatarProfile();
  memory.remember({
    avatarId: profile.metadata.owner_id,
    content: "Approved fact",
    approved: true,
  });
  memory.remember({
    avatarId: profile.metadata.owner_id,
    content: "Unapproved fact",
    approved: false,
  });
  function readTool(name) {
    const result = spawnSync(process.execPath, ["bin/radoss-mcp.mjs"], {
      env: { ...process.env },
      encoding: "utf8",
      input:
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()).result;
  }
  let result = readTool("avatar_get");
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.profile.communication.tone, "Gentle");
  assert.deepEqual(
    data.memories.map((item) => item.content),
    ["Approved fact"],
  );
  runtime.setPrivacyMode("paused");
  result = readTool("avatar_get");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /paused/);
  assert.doesNotMatch(
    JSON.stringify(readTool("avatar_status")),
    /Approved fact|Connected prose/,
  );
  assert.throws(() => profiles.saveAvatarProfile(sample), /paused/);
  runtime.setPrivacyMode("local_only");
});

test("local HTTP editor validates Host, Origin, JSON and reloads the saved profile", async () => {
  const instance = await runtime.createSetupServer({ open: false });
  try {
    function raw(headers, body = "{}") {
      return new Promise((resolve, reject) => {
        const request = http.request(
          instance.url + "api/avatar/profile",
          { method: "POST", headers },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    }
    assert.equal(
      await raw({
        host: "rebind.attacker.example",
        "content-type": "application/json",
      }),
      403,
    );
    assert.equal(await raw({ "content-type": "text/plain" }), 415);
    assert.equal(
      await raw({
        "content-type": "application/json",
        origin: "https://attacker.example",
      }),
      403,
    );
    assert.equal(await raw({ "content-type": "application/json" }, "[]"), 400);
    const response = await fetch(instance.url + "api/avatar/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sample, tone: "Friendly" }),
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.ok(saved.backup.id);
    const reload = await (
      await fetch(instance.url + "api/avatar/profile")
    ).json();
    assert.equal(reload.profile.communication.tone, "Friendly");
    runtime.rollbackBackup(saved.backup.id);
    assert.equal(profiles.getAvatarProfile().communication.tone, "Gentle");
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
  }
});

test("memory deletion requires confirmation and removes only the selected Avatar's active record and index", () => {
  const avatarId = profiles.getAvatarProfile().metadata.owner_id;
  const saved = memory.remember({
    avatarId,
    content: "Disposable journey note",
    approved: true,
  });
  const other = memory.remember({
    avatarId: "other-avatar",
    content: "Disposable journey note",
    approved: true,
  });
  assert.throws(
    () => memory.forgetMemory({ avatarId, id: saved.id }),
    /confirm/,
  );
  assert.equal(
    memory.forgetMemory({ avatarId, id: other.id, confirm: true }).deleted,
    false,
  );
  assert.equal(
    memory.forgetMemory({ avatarId, id: saved.id, confirm: true }).deleted,
    true,
  );
  assert.deepEqual(memory.searchMemory({ avatarId, query: "Disposable" }), []);
  assert.equal(
    memory.searchMemory({ avatarId: "other-avatar", query: "Disposable" })
      .length,
    1,
  );
  assert.throws(
    () => memory.remember({ avatarId, content: {}, approved: true }),
    /text/,
  );
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
