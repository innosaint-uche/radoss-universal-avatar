import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { localAvatarMcpCommand } from "./mcp-local-command.mjs";

const HOME = process.env.RADOS_HOME ?? os.homedir();

const TARGETS = {
  codex: {
    label: "Codex",
    path: path.join(HOME, ".codex", "config.toml"),
    endpoint: (server) => server.oauth_endpoint ?? server.endpoint
  },
  antigravity: {
    label: "Antigravity",
    path: path.join(HOME, ".gemini", "config", "mcp_config.json"),
    endpoint: (server) => server.oauth_endpoint ?? server.endpoint
  },
  hermes: {
    label: "Hermes",
    path: path.join(HOME, ".hermes", "profiles", "avatar", "config.yaml"),
    profile: "avatar",
    // Hugging Face exposes an explicit login variant. Hermes must use it so
    // its own OAuth provider is challenged instead of accepting the server's
    // anonymous initialize response and concluding that no token is needed.
    endpoint: (server) => server.oauth_endpoint ?? server.endpoint
  }
};

const SECRET_KEY_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|personal[_-]?access[_-]?token|password|secret|authorization|bearer|private[_-]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bhf_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
];

function isPlaceholder(value) {
  const normalized = String(value ?? "").trim();
  return !normalized || /^(\$\{|\$[A-Z_][A-Z0-9_]*$|env:|doppler:|secret:|<|YOUR_|REPLACE_|CHANGE_ME|EXAMPLE_|TEST_|dummy|redacted|placeholder)/i.test(normalized);
}

function addSecurityWarning(warnings, target, field, kind) {
  const key = `${target}:${field}:${kind}`;
  if (warnings.some((warning) => warning.key === key)) return;
  warnings.push({
    key,
    target,
    path: TARGETS[target].path,
    field,
    kind,
    action: "Rotate the credential, then replace it with an environment or OS credential-store reference."
  });
}

function inspectValue(target, field, value, warnings) {
  if (typeof value !== "string" || isPlaceholder(value)) return;
  if (/(?:^|[_-])env(?:ironment)?[_-]?var$/i.test(field) || /^(process\.env\.|\$[A-Z_])/i.test(value.trim())) return;
  if (SECRET_KEY_PATTERN.test(field) || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    addSecurityWarning(warnings, target, field, "embedded_credential");
  }
}

function scanObject(target, value, field = "", warnings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanObject(target, item, `${field}[${index}]`, warnings));
    return warnings;
  }
  if (!value || typeof value !== "object") {
    inspectValue(target, field, value, warnings);
    return warnings;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextField = field ? `${field}.${key}` : key;
    inspectValue(target, nextField, item, warnings);
    if (item && typeof item === "object") scanObject(target, item, nextField, warnings);
  }
  return warnings;
}

function scanText(target, text, warnings = []) {
  for (const line of String(text).split("\n")) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|BEARER|PRIVATE)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^"'\s#]+)["']?/i);
    if (match) inspectValue(target, match[1], match[2], warnings);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(line)) addSecurityWarning(warnings, target, "embedded_value", "embedded_credential");
    }
  }
  return warnings;
}

export function inspectTargetSecurity() {
  const warnings = [];
  for (const [target, metadata] of Object.entries(TARGETS)) {
    if (!fs.existsSync(metadata.path)) continue;
    const text = fs.readFileSync(metadata.path, "utf8");
    if (metadata.path.endsWith(".json")) {
      try { scanObject(target, JSON.parse(text), "", warnings); }
      catch { scanText(target, text, warnings); }
    } else scanText(target, text, warnings);
  }
  return warnings.map(({ key, ...warning }) => warning);
}

function quoteToml(value) {
  return JSON.stringify(value);
}

function yamlScalar(value) {
  return value;
}

function secureFile(filePath) {
  if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
}

function replaceNamedTomlTable(content, tableName, lines) {
  const header = `[${tableName}]`;
  const start = content.indexOf(header);
  if (start < 0) return `${content.trimEnd()}\n\n${lines.join("\n")}\n`;

  const afterHeader = content.indexOf("\n", start);
  const endMatch = content.slice(afterHeader < 0 ? content.length : afterHeader + 1).search(/^\[/m);
  const end = endMatch < 0
    ? content.length
    : (afterHeader < 0 ? content.length : afterHeader + 1 + endMatch);
  return `${content.slice(0, start)}${lines.join("\n")}\n${content.slice(end)}`;
}

function removeNamedTomlTable(content, tableName) {
  const header = `[${tableName}]`;
  const start = content.indexOf(header);
  if (start < 0) return content;

  const afterHeader = content.indexOf("\n", start);
  const endMatch = content.slice(afterHeader < 0 ? content.length : afterHeader + 1).search(/^\[/m);
  const end = endMatch < 0
    ? content.length
    : (afterHeader < 0 ? content.length : afterHeader + 1 + endMatch);
  return `${content.slice(0, start)}${content.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

function syncCodex(server, dryRun) {
  const target = TARGETS.codex;
  const tableName = `mcp_servers.${server.id}`;
  const expectedUrl = `url = ${quoteToml(target.endpoint(server))}`;
  const lines = [
    `[${tableName}]`,
    expectedUrl
  ];
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  if (!dryRun) secureFile(target.path);
  if (current.includes(`[${tableName}]`) && current.includes(expectedUrl)) {
    return { target: "codex", path: target.path, changed: false, expected: target.endpoint(server) };
  }
  const next = replaceNamedTomlTable(current, tableName, lines);
  if (!dryRun && next !== current) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "codex", path: target.path, changed: next !== current, expected: target.endpoint(server) };
}

function syncAntigravity(server, dryRun) {
  const target = TARGETS.antigravity;
  const current = fs.existsSync(target.path)
    ? JSON.parse(fs.readFileSync(target.path, "utf8"))
    : { mcpServers: {} };
  if (!dryRun) secureFile(target.path);
  const next = structuredClone(current);
  next.mcpServers ??= {};
  next.mcpServers[server.id] = { serverUrl: target.endpoint(server) };
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (!dryRun && nextText !== currentText) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, nextText, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "antigravity", path: target.path, changed: nextText !== currentText, expected: target.endpoint(server) };
}

function syncCodexOrchestrator(dryRun) {
  const target = TARGETS.codex;
  const command = localAvatarMcpCommand();
  const tableName = "mcp_servers.radoss_avatar";
  const lines = [
    `[${tableName}]`,
    `command = ${quoteToml(command.command)}`,
    `args = ${JSON.stringify(command.args)}`
  ];
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  if (!dryRun) secureFile(target.path);
  const next = replaceNamedTomlTable(current, tableName, lines);
  if (!dryRun && next !== current) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "codex", server: "radoss_avatar", path: target.path, changed: next !== current, command };
}

function syncAntigravityOrchestrator(dryRun) {
  const target = TARGETS.antigravity;
  const command = localAvatarMcpCommand();
  const current = fs.existsSync(target.path)
    ? JSON.parse(fs.readFileSync(target.path, "utf8"))
    : { mcpServers: {} };
  if (!dryRun) secureFile(target.path);
  const next = structuredClone(current);
  next.mcpServers ??= {};
  next.mcpServers.radoss_avatar = { command: command.command, args: command.args };
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (!dryRun && nextText !== currentText) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, nextText, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "antigravity", server: "radoss_avatar", path: target.path, changed: nextText !== currentText, command };
}

function findYamlServerBlock(content, name) {
  const lines = content.split("\n");
  const marker = `  ${name}:`;
  const start = lines.findIndex((line) => line === marker);
  if (start < 0) return { lines, start: -1, end: -1 };
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith("    ") || lines[end].trim() === "")) end += 1;
  return { lines, start, end };
}

function syncHermes(server, dryRun) {
  const target = TARGETS.hermes;
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  if (!dryRun) secureFile(target.path);
  const configName = server.id === "huggingface" ? "hugging_face" : server.id;
  const block = findYamlServerBlock(current, configName);
  // Hermes' published Client-ID Metadata Document only declares a small,
  // fixed callback-port set. The no-code setup uses Hermes' session-backed
  // browser bridge, whose callback is ephemeral. Hugging Face supports RFC
  // 7591 dynamic registration, so force Hermes onto that path instead of
  // allowing CIMD to advertise a callback the desktop bridge is not serving.
  const oauthOptions = server.id === "huggingface" ? [
    "    oauth:",
    "      cimd: false"
  ] : [];
  const desired = [
    `  ${configName}:`,
    `    url: ${yamlScalar(target.endpoint(server))}`,
    ...(server.auth === "oauth" ? ["    auth: oauth"] : []),
    ...oauthOptions,
    "    enabled: true"
  ];
  const providerInSync = (
    block.start >= 0 &&
    block.lines.slice(block.start, block.end).includes(`    url: ${target.endpoint(server)}`) &&
    (server.auth !== "oauth" || block.lines.slice(block.start, block.end).includes("    auth: oauth")) &&
    (!oauthOptions.length || oauthOptions.every((line) => block.lines.slice(block.start, block.end).includes(line))) &&
    block.lines.slice(block.start, block.end).includes("    enabled: true")
  );
  let next;
  if (providerInSync) {
    next = current;
  } else if (block.start >= 0) {
    next = [...block.lines.slice(0, block.start), ...desired, ...block.lines.slice(block.end)].join("\n");
  } else if (current.includes("mcp_servers:")) {
    const lines = current.split("\n");
    const marker = lines.findIndex((line) => line === "mcp_servers:");
    lines.splice(marker + 1, 0, ...desired);
    next = lines.join("\n");
  } else {
    next = `${current.trimEnd()}\n\nmcp_servers:\n${desired.join("\n")}\n`;
  }
  if (!dryRun && next !== current) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  const orchestrator = syncHermesOrchestrator(dryRun);
  return {
    target: "hermes",
    path: target.path,
    changed: next !== current || orchestrator.changed,
    expected: target.endpoint(server),
    orchestrator: orchestrator.changed ? "configured" : "in_sync"
  };
}

function syncHermesOrchestrator(dryRun) {
  const target = TARGETS.hermes;
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  const command = localAvatarMcpCommand();
  const desired = [
    "  radoss_avatar:",
    `    command: ${JSON.stringify(command.command)}`,
    `    args: [${command.args.map((value) => JSON.stringify(value)).join(", ")}]`,
    "    enabled: true",
    "    timeout: 120",
    "    connect_timeout: 10"
  ];
  const block = findYamlServerBlock(current, "radoss_avatar");
  const expected = desired.slice(1).every((line) => block.start >= 0 && block.lines.slice(block.start, block.end).includes(line));
  if (expected) return { changed: false, path: target.path, command };
  let next;
  if (block.start >= 0) {
    next = [...block.lines.slice(0, block.start), ...desired, ...block.lines.slice(block.end)].join("\n");
  } else if (current.includes("mcp_servers:")) {
    const lines = current.split("\n");
    const marker = lines.findIndex((line) => line === "mcp_servers:");
    lines.splice(marker + 1, 0, ...desired);
    next = lines.join("\n");
  } else {
    next = `${current.trimEnd()}\n\nmcp_servers:\n${desired.join("\n")}\n`;
  }
  if (!dryRun && next !== current) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { changed: next !== current, path: target.path, command };
}

export function syncLocalTarget(targetName, dryRun = false) {
  if (!TARGETS[targetName]) throw new Error(`Unsupported target: ${targetName}`);
  if (targetName === "codex") return syncCodexOrchestrator(dryRun);
  if (targetName === "antigravity") return syncAntigravityOrchestrator(dryRun);
  const result = syncHermesOrchestrator(dryRun);
  return { ...result, target: "hermes", server: "radoss_avatar" };
}

export function syncTarget(targetName, server, dryRun = false) {
  if (!TARGETS[targetName]) throw new Error(`Unsupported target: ${targetName}`);
  if (targetName === "codex") return syncCodex(server, dryRun);
  if (targetName === "antigravity") return syncAntigravity(server, dryRun);
  return syncHermes(server, dryRun);
}

export function syncServer(server, { dryRun = false } = {}) {
  return (server.targets ?? Object.keys(TARGETS))
    .filter((target) => TARGETS[target])
    .flatMap((target) => [syncTarget(target, server, dryRun), syncLocalTarget(target, dryRun)]);
}

function disconnectCodex(server, dryRun) {
  const target = TARGETS.codex;
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  if (!dryRun) secureFile(target.path);
  const next = removeNamedTomlTable(current, `mcp_servers.${server.id}`);
  if (!dryRun && next !== current) {
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "codex", path: target.path, changed: next !== current };
}

function disconnectAntigravity(server, dryRun) {
  const target = TARGETS.antigravity;
  if (!fs.existsSync(target.path)) return { target: "antigravity", path: target.path, changed: false };
  if (!dryRun) secureFile(target.path);
  const current = JSON.parse(fs.readFileSync(target.path, "utf8"));
  const next = structuredClone(current);
  if (next.mcpServers && Object.hasOwn(next.mcpServers, server.id)) delete next.mcpServers[server.id];
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (!dryRun && nextText !== currentText) {
    fs.writeFileSync(target.path, nextText, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "antigravity", path: target.path, changed: nextText !== currentText };
}

function disconnectHermes(server, dryRun) {
  const target = TARGETS.hermes;
  const current = fs.existsSync(target.path) ? fs.readFileSync(target.path, "utf8") : "";
  if (!dryRun) secureFile(target.path);
  const configName = server.id === "huggingface" ? "hugging_face" : server.id;
  const block = findYamlServerBlock(current, configName);
  if (block.start < 0) return { target: "hermes", path: target.path, changed: false };
  const next = [...block.lines.slice(0, block.start), ...block.lines.slice(block.end)].join("\n");
  if (!dryRun && next !== current) {
    fs.writeFileSync(target.path, next, { mode: 0o600 });
    fs.chmodSync(target.path, 0o600);
  }
  return { target: "hermes", path: target.path, changed: next !== current };
}

export function disconnectTarget(targetName, server, dryRun = false) {
  if (!TARGETS[targetName]) throw new Error(`Unsupported target: ${targetName}`);
  if (targetName === "codex") return disconnectCodex(server, dryRun);
  if (targetName === "antigravity") return disconnectAntigravity(server, dryRun);
  return disconnectHermes(server, dryRun);
}

export function disconnectServer(server, { dryRun = false } = {}) {
  return (server.targets ?? Object.keys(TARGETS))
    .filter((target) => TARGETS[target])
    .map((target) => disconnectTarget(target, server, dryRun));
}

export function targetPaths() {
  return Object.fromEntries(Object.entries(TARGETS).map(([name, target]) => [name, target.path]));
}

export function targetMetadata() {
  return Object.fromEntries(Object.entries(TARGETS).map(([name, target]) => [name, {
    label: target.label,
    path: target.path,
    ...(target.profile ? { profile: target.profile } : {})
  }]));
}
