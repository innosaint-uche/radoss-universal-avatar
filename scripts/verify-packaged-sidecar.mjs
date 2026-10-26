import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const triples = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const suffix = process.platform === "win32" ? ".exe" : "";
const executable = path.resolve(
  process.argv[2] ||
    `desktop-setup/src-tauri/binaries/radoss-setup-${triples[`${process.platform}-${process.arch}`]}${suffix}`,
);
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-packaged-"));
const env = { ...process.env, RADOS_HOME: isolatedHome, RADOSS_NO_OPEN: "1" };
const child = spawn(executable, ["--port", "0"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Packaged sidecar did not become ready")),
      10000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Packaged sidecar exited early: ${code}`));
    });
    lines.on("line", (line) => {
      if (line.startsWith("radoss-setup-service ")) {
        clearTimeout(timer);
        resolve(line.slice("radoss-setup-service ".length));
      }
    });
  });
  const post = async (route, body) => {
    const response = await fetch(url + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const asset = await fetch(url);
  assert.match(await asset.text(), /Save my Avatar profile/);
  await post("api/setup/run", { provider: "local", openAuth: false });
  await post("api/avatar/profile", {
    name: "Packaged fixture",
    tone: "Direct",
    structure: "Bulleted",
    verbosity: "Concise",
    rules: ["Show evidence"],
  });
  assert.match(
    fs.readFileSync(path.join(isolatedHome, ".codex/config.toml"), "utf8"),
    /--mcp-stdio/,
  );
  const mcp = spawnSync(executable, ["--mcp-stdio"], {
    env,
    encoding: "utf8",
    timeout: 10000,
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "avatar_get", arguments: {} },
      }) + "\n",
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const profile = JSON.parse(
    JSON.parse(mcp.stdout.trim()).result.content[0].text,
  );
  assert.equal(profile.profile.identity.name, "Packaged fixture");
  console.log(
    "Packaged sidecar: embedded UI, offline setup, SQLite profile, agent command and stdio MCP passed",
  );
} finally {
  lines.close();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await stopped;
  }
  fs.rmSync(isolatedHome, { recursive: true, force: true });
}
