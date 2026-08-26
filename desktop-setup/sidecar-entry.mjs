import { createSetupServer } from "../lib/setup-runtime.mjs";
import { runMcpStdio } from "../lib/mcp-orchestrator.mjs";
import indexHtml from "./index.html";
import appJs from "./app.js";
import stylesCss from "./styles.css";
import faviconSvg from "./favicon.svg";

if (process.argv.includes("--mcp-stdio")) {
  await runMcpStdio();
  process.exit(0);
}

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 49312;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid sidecar port");

const instance = await createSetupServer({
  port,
  open: false,
  embeddedAssets: {
    "index.html": indexHtml,
    "app.js": appJs,
    "styles.css": stylesCss,
    "favicon.svg": faviconSvg
  }
});
process.stdout.write(`radoss-setup-service ${instance.url}\n`);

let shuttingDown = false;
let parentMonitor;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentMonitor) clearInterval(parentMonitor);
  instance.server.close(() => process.exit(0));
};

// The Tauri shell owns this sidecar. If the shell is force-terminated, the
// normal Tauri Exit event cannot run, so terminate when the parent disappears.
const parentPid = process.ppid;
if (process.platform !== "win32" && Number.isInteger(parentPid) && parentPid > 1) {
  parentMonitor = setInterval(() => {
    if (process.ppid !== parentPid) shutdown();
  }, 250);
  parentMonitor.unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
