import readline from "node:readline";
import {
  connectProvider,
  createBackup,
  disconnectProvider,
  doctor,
  projectReMe,
  retrySetup,
  rollbackBackup,
  runSetup,
  setPrivacyMode,
  setupReMe,
  setupStatus
} from "./setup-runtime.mjs";

import { getAvatarProfile } from "./avatar-profile.mjs";
import { listApprovedMemory, remember, searchMemory, forgetMemory } from "./avatar-memory.mjs";
import { loadSetupState } from "./setup-state.mjs";

const SERVER_INFO = { name: "naavos-avatar", version: "0.2.0" };

const TOOLS = [
  { name: "avatar_remember", description: "Store a local memory only after the user explicitly approves the content. Requires confirm=true.", inputSchema: { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 10000 }, confirm: { type: "boolean", const: true } }, required: ["content", "confirm"], additionalProperties: false }, annotations: { destructiveHint: false } },
  { name: "avatar_memory_search", description: "Search approved memories in the local Avatar ledger.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "avatar_memory_delete", description: "Delete a memory from the active local ledger after confirmation. Historical backups may retain a copy.", inputSchema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean", const: true } }, required: ["id", "confirm"], additionalProperties: false }, annotations: { destructiveHint: true } },
  {
    name: "avatar_get",
    description: "Read the locally saved identity, communication preferences, operating rules and approved memories. Private data stays on this device until the connected host calls this tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: "avatar_status",
    description: "Read the current NAAvOS Avatar, privacy, memory, agent, provider, and security status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: "avatar_health",
    description: "Run live MCP protocol, adapter drift, and Hermes profile checks.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: "avatar_setup",
    description: "Create the Avatar and configure supported local agents. Requires confirm=true; ask the user before opening browser OAuth.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean" },
        avatarName: { type: "string", maxLength: 80 },
        openAuth: { type: "boolean" }
      },
      required: ["confirm"],
      additionalProperties: false
    },
    annotations: { destructiveHint: false, idempotentHint: true }
  },
  {
    name: "avatar_connect",
    description: "Open the provider browser OAuth flow. Requires confirm=true and the user must approve in the browser.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, provider: { type: "string" } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: false }
  },
  {
    name: "avatar_retry",
    description: "Retry the last guarded setup request after the user confirms.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, openAuth: { type: "boolean" }, avatarName: { type: "string", maxLength: 80 } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: false, idempotentHint: true }
  },
  {
    name: "avatar_backup",
    description: "Create an encrypted local setup backup after user confirmation.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, reason: { type: "string", maxLength: 120 } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: false, idempotentHint: true }
  },
  {
    name: "avatar_privacy",
    description: "Set local_only, local_and_sync, or paused privacy mode after user confirmation.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, mode: { type: "string", enum: ["local_only", "local_and_sync", "paused"] } }, required: ["confirm", "mode"], additionalProperties: false },
    annotations: { destructiveHint: false, idempotentHint: true }
  },
  {
    name: "avatar_disconnect",
    description: "Back up first, then disconnect the selected provider and remove only its registered adapter entries.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, provider: { type: "string" } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: true }
  },
  {
    name: "avatar_rollback",
    description: "Restore a named encrypted setup backup after user confirmation.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, backupId: { type: "string" } }, required: ["confirm", "backupId"], additionalProperties: false },
    annotations: { destructiveHint: true }
  },
  {
    name: "reme_install",
    description: "Install the optional local ReMe memory service after user confirmation; no Avatar memory is copied.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: false }
  },
  {
    name: "reme_project_approved",
    description: "Project only already-approved SQLite memories into readable ReMe Markdown after user confirmation.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false },
    annotations: { destructiveHint: false }
  }
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function requireConfirmation(args) {
  if (args?.confirm !== true) throw new Error("This NAAvOS action requires explicit confirm=true");
}

async function callTool(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  const schema = TOOLS.find((tool) => tool.name === name)?.inputSchema;
  if (schema && Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Unknown tool argument");
  switch (name) {
    case "avatar_remember":
    case "avatar_memory_search":
    case "avatar_memory_delete": {
      const state = loadSetupState();
      if (state.privacy.mode === "paused") throw new Error("Memory access is paused by the privacy control");
      if (!state.avatar.id) throw new Error("Create your local Avatar first");
      if (name === "avatar_memory_search") {
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("Provide a query of 1-500 characters");
        return { items: searchMemory({ avatarId: state.avatar.id, query: args.query, limit: 20 }) };
      }
      requireConfirmation(args);
      if (name === "avatar_remember") return remember({ avatarId: state.avatar.id, content: args.content, approved: true });
      return forgetMemory({ avatarId: state.avatar.id, id: args.id, confirm: true });
    }
    case "avatar_get": {
      const state = loadSetupState();
      if (state.privacy.mode === "paused") throw new Error("Avatar access is paused by the privacy control");
      const profile = getAvatarProfile();
      if (!profile) throw new Error("Save your Avatar profile in the local editor first");
      return { profile, memories: listApprovedMemory({ avatarId: state.avatar.id, limit: 50 }), authority: "local_sqlite", cloud_sync: false };
    }
    case "avatar_status": return setupStatus();
    case "avatar_health": return doctor();
    case "avatar_setup":
      requireConfirmation(args);
      return runSetup({ avatarName: args.avatarName ?? "My Avatar", openAuth: Boolean(args.openAuth), targets: ["codex", "antigravity", "hermes"] });
    case "avatar_connect":
      requireConfirmation(args);
      return connectProvider(args.provider ?? "huggingface");
    case "avatar_retry":
      requireConfirmation(args);
      return retrySetup({ openAuth: Boolean(args.openAuth), ...(args.avatarName ? { avatarName: args.avatarName } : {}) });
    case "avatar_backup":
      requireConfirmation(args);
      return createBackup(args.reason ?? "hermes-requested");
    case "avatar_privacy":
      requireConfirmation(args);
      return setPrivacyMode(args.mode);
    case "avatar_disconnect":
      requireConfirmation(args);
      return disconnectProvider(args.provider ?? "huggingface");
    case "avatar_rollback":
      requireConfirmation(args);
      return rollbackBackup(args.backupId);
    case "reme_install":
      requireConfirmation(args);
      return setupReMe();
    case "reme_project_approved":
      requireConfirmation(args);
      return projectReMe();
    default: throw new Error(`Unknown NAAvOS tool: ${name}`);
  }
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function failure(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method?.startsWith("notifications/")) return;
  if (message.method === "initialize") {
    return response(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "NAAvOS is the Avatar authority. Radoss Agency maintains the open-source product. Hermes is the visible orchestrator. Mutating tools require confirm=true."
    });
  }
  if (message.method === "ping") return response(message.id, {});
  if (message.method === "tools/list") return response(message.id, { tools: TOOLS });
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      return response(message.id, textResult(result));
    } catch (error) {
      return response(message.id, textResult(error.message, true));
    }
  }
  return failure(message.id, -32601, `Method not found: ${message.method}`);
}

export async function runMcpStdio() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try { await handle(JSON.parse(line)); }
    catch (error) { failure(null, -32700, `Invalid MCP message: ${error.message}`); }
  }
}
