import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function localAvatarMcpCommand() {
  const configured = process.env.RADOS_AVATAR_MCP_COMMAND?.trim();
  if (configured) return { command: configured, args: [] };
  const executableName = path.basename(process.execPath).toLowerCase();
  const packagedSidecar = Boolean(process.versions.sea) || executableName === "radoss-setup" || executableName === "radoss-setup.exe";
  if (packagedSidecar || process.argv.includes("--mcp-stdio")) return { command: process.execPath, args: ["--mcp-stdio"] };
  return { command: process.execPath, args: [path.join(ROOT, "bin", "radoss-mcp.mjs")] };
}
