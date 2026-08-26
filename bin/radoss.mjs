#!/usr/bin/env node

import { Command } from "commander";
import { ensureBuiltin, loadRegistry, REGISTRY_PATH, removeServer, upsertServer } from "../lib/mcp-registry.mjs";
import { syncLocalTarget, syncServer, syncTarget, targetPaths } from "../lib/mcp-adapters.mjs";
import { createSnapshot, setupPaths } from "../lib/setup-state.mjs";
import {
  connectProvider,
  createBackup,
  createSetupServer,
  disconnectProvider,
  doctor,
  projectReMe,
  rollbackBackup,
  retrySetup,
  runSetup,
  setPrivacyMode,
  setupReMe,
  setupStatus
} from "../lib/setup-runtime.mjs";
import { probeMcpProtocol, runMcpConformance } from "../lib/mcp-contract.mjs";
import { getStoredAccessToken } from "../lib/oauth.mjs";

const program = new Command();
program.name("radoss").description("Radoss universal control plane").version("0.2.0");

function printServer(name, server) {
  console.log(`${name}: ${server.endpoint}`);
  console.log(`  auth: ${server.auth}; targets: ${(server.targets ?? []).join(", ")}`);
}

const mcp = program.command("mcp").description("Manage the universal MCP registry and host adapters");

mcp.command("init")
  .description("Register the built-in Hugging Face MCP provider")
  .action(() => {
    const server = ensureBuiltin("huggingface");
    console.log(`Registered huggingface in ${REGISTRY_PATH}`);
    printServer("huggingface", server);
  });

mcp.command("add")
  .argument("<name>")
  .requiredOption("--url <endpoint>")
  .option("--oauth-url <endpoint>")
  .option("--auth <mode>", "none, optional, oauth, or bearer", "optional")
  .option("--targets <targets>", "comma-separated adapter names", "codex,antigravity,hermes")
  .description("Register any Streamable HTTP MCP provider")
  .action((name, options) => {
    const server = upsertServer({
      name,
      endpoint: options.url,
      oauthEndpoint: options.oauthUrl,
      auth: options.auth,
      targets: options.targets.split(",").map((value) => value.trim()).filter(Boolean)
    });
    console.log(`Registered ${name} in ${REGISTRY_PATH}`);
    printServer(name, server);
  });

mcp.command("list")
  .alias("status")
  .description("Show canonical providers and adapter locations")
  .action(() => {
    const registry = loadRegistry();
    console.log(`Registry: ${REGISTRY_PATH}`);
    const names = Object.keys(registry.servers);
    if (!names.length) console.log("No MCP providers registered. Run: radoss mcp init");
    for (const name of names) printServer(name, registry.servers[name]);
    console.log("Adapters:");
    for (const [target, targetPath] of Object.entries(targetPaths())) console.log(`  ${target}: ${targetPath}`);
  });

mcp.command("sync")
  .argument("[name]")
  .option("--target <target>", "sync only one adapter")
  .option("--dry-run", "show changes without writing")
  .description("Synchronize canonical providers into supported host adapters")
  .action((name, options) => {
    const registry = loadRegistry();
    const entries = name ? [[name, registry.servers[name]]] : Object.entries(registry.servers);
    if (!entries.length) throw new Error("No MCP providers registered. Run: radoss mcp init");
    if (!options.dryRun) {
      // setup runtime snapshots are encrypted; never create plaintext config copies.
      createSnapshot({ reason: "mcp-sync", paths: setupPaths({ registryPath: REGISTRY_PATH, targetPaths: targetPaths() }) });
    }
    for (const [serverName, server] of entries) {
      if (!server) throw new Error(`Unknown MCP provider: ${serverName}`);
      const results = options.target
        ? [syncTarget(options.target, server, options.dryRun), syncLocalTarget(options.target, options.dryRun)]
        : syncServer(server, { dryRun: options.dryRun });
      console.log(`${serverName}${options.dryRun ? " (dry run)" : ""}`);
      for (const result of results) console.log(`  ${result.target}: ${result.changed ? "change required" : "in sync"} — ${result.path}`);
    }
  });

mcp.command("doctor")
  .argument("[name]")
  .description("Verify canonical providers, adapter drift, and live MCP protocol health")
  .action(async (name) => {
    const registry = loadRegistry();
    const entries = name ? [[name, registry.servers[name]]] : Object.entries(registry.servers);
    if (!entries.length) throw new Error("No MCP providers registered. Run: radoss mcp init");
    let failures = 0;
    for (const [serverName, server] of entries) {
      if (!server) throw new Error(`Unknown MCP provider: ${serverName}`);
      console.log(serverName);
      const drift = syncServer(server, { dryRun: true });
      for (const result of drift) console.log(`  ${result.target}: ${result.changed ? "DRIFT" : "in sync"}`);
      const token = await getStoredAccessToken(server);
      const health = await probeMcpProtocol(server.endpoint, { token });
      const status = health.status === "healthy" ? "HEALTHY" : "FAIL";
      const httpStatus = health.http_status ?? "no response";
      const contentType = health.content_type ?? "no content-type";
      const tools = health.tools_count === undefined ? "" : `, ${health.tools_count} tools`;
      console.log(`  protocol: ${status} (${httpStatus}, ${contentType}${tools})`);
      if (health.status !== "healthy") {
        console.log(`  detail: ${health.error ?? "MCP protocol probe failed"}`);
        failures += 1;
      }
    }
    if (failures) process.exitCode = 1;
  });

mcp.command("conformance")
  .argument("<endpoint>", "HTTPS or loopback Streamable HTTP MCP endpoint")
  .option("--bearer-env <name>", "read a bearer token from this environment variable")
  .option("--status-tool <name>", "read-only tool to call after tools/list", "avatar_status")
  .option("--allow-origin", "skip the hostile-Origin rejection gate", false)
  .description("Run the remote MCP lifecycle, tool, error, session, and security contract")
  .action(async (endpoint, options) => {
    const token = options.bearerEnv ? process.env[options.bearerEnv] ?? null : null;
    const evidence = await runMcpConformance(endpoint, {
      token,
      statusTool: options.statusTool,
      requireStrictOrigin: !options.allowOrigin
    });
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.status !== "pass") process.exitCode = 1;
  });

mcp.command("remove")
  .argument("<name>")
  .description("Remove a provider from the canonical registry only")
  .action((name) => {
    console.log(removeServer(name) ? `Removed ${name} from ${REGISTRY_PATH}` : `${name} was not registered`);
  });

const setup = program.command("setup")
  .description("Open the no-code Avatar setup wizard")
  .option("--port <port>", "local setup service port", "0")
  .option("--no-open", "do not open the browser automatically")
  .action(async (options) => {
    const result = await createSetupServer({ port: Number(options.port), open: !process.argv.includes("--no-open") });
    console.log(`NAAS setup wizard: ${result.url}`);
    console.log(`Backups: ${result.backups_dir}`);
  });

setup.command("status")
  .description("Show setup, privacy, provider, agent, and backup state")
  .action(async () => console.log(JSON.stringify(await setupStatus(), null, 2)));

setup.command("run")
  .description("Run the guarded local setup flow")
  .option("--provider <provider>", "registered provider", "huggingface")
  .option("--targets <targets>", "comma-separated automatic targets", "codex,antigravity,hermes")
  .option("--avatar-name <name>", "display name for the local Avatar", "My Avatar")
  .option("--open-auth", "open the provider browser login", false)
  .action(async (options) => {
    const result = await runSetup({
      providerName: options.provider,
      targets: options.targets.split(",").map((value) => value.trim()).filter(Boolean),
      openAuth: options.openAuth,
      avatarName: options.avatarName
    });
    console.log(JSON.stringify({ backup: result.backup, sync: result.sync, auth: result.auth, health: result.health, hermes: result.hermes }, null, 2));
  });

setup.command("retry")
  .description("Retry the last setup request")
  .option("--no-open-auth", "retry without opening the provider browser login")
  .action(async (options) => {
    const result = await retrySetup({ openAuth: options.openAuth });
    console.log(JSON.stringify({ backup: result.backup, sync: result.sync, auth: result.auth, health: result.health, hermes: result.hermes }, null, 2));
  });

setup.command("backup")
  .description("Create a recoverable snapshot of registry and agent configuration")
  .option("--reason <reason>", "backup reason", "manual")
  .action((options) => console.log(JSON.stringify(createBackup(options.reason), null, 2)));

setup.command("rollback")
  .argument("<backup-id>")
  .description("Restore a named setup snapshot")
  .action((id) => console.log(JSON.stringify(rollbackBackup(id), null, 2)));

setup.command("privacy")
  .argument("<mode>", "local_only, local_and_sync, or paused")
  .description("Set the user-controlled privacy mode")
  .action((mode) => console.log(JSON.stringify(setPrivacyMode(mode), null, 2)));

setup.command("connect")
  .argument("[provider]", "registered provider", "huggingface")
  .description("Connect the provider through browser OAuth")
  .action(async (provider) => console.log(JSON.stringify(await connectProvider(provider), null, 2)));

setup.command("disconnect")
  .argument("[provider]", "registered provider", "huggingface")
  .description("Back up, remove provider entries, and disconnect supported agents")
  .action(async (provider) => console.log(JSON.stringify(await disconnectProvider(provider), null, 2)));

const memory = setup.command("memory").description("Manage the optional user-owned ReMe projection");

memory.command("status")
  .description("Show canonical memory and ReMe projection status")
  .action(async () => {
    const status = await setupStatus();
    console.log(JSON.stringify(status.memory, null, 2));
  });

memory.command("install")
  .description("Explicitly install ReMe into the isolated NAAS environment")
  .action(async () => console.log(JSON.stringify(await setupReMe(), null, 2)));

memory.command("project")
  .requiredOption("--confirm", "confirm projection of already-approved SQLite memories")
  .description("Project already-approved SQLite memories into ReMe Markdown")
  .action(async () => console.log(JSON.stringify(await projectReMe(), null, 2)));

program.command("doctor")
  .description("Run live protocol, adapter drift, and setup health checks")
  .action(async () => console.log(JSON.stringify(await doctor(), null, 2)));

program.parseAsync().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
