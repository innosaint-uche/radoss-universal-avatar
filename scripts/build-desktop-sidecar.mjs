import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "desktop-setup", "sidecar-entry.mjs");
const buildDir = path.join(root, ".build", "desktop-sidecar");
const bundled = path.join(buildDir, "radoss-setup.mjs");
const seaConfig = path.join(buildDir, "sea-config.json");
const binariesDir = path.join(root, "desktop-setup", "src-tauri", "binaries");
const explicitTarget = process.env.RADOS_TAURI_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || process.env.TARGET;

function hostTarget() {
  if (explicitTarget) return explicitTarget;
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported sidecar host: ${platform}/${arch}`);
}

const target = hostTarget();
if (explicitTarget && explicitTarget !== target) {
  throw new Error(`Cross-target sidecar build is not supported by the local Node SEA toolchain: host=${target}, requested=${explicitTarget}. Build the sidecar on the target platform in CI.`);
}
const extension = process.platform === "win32" ? ".exe" : "";
const output = path.join(binariesDir, `radoss-setup-${target}${extension}`);
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(binariesDir, { recursive: true });

const esbuildBin = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
if (!fs.existsSync(esbuildBin)) throw new Error("esbuild is required; run npm install first");
const esbuildCommand = process.platform === "win32" ? process.execPath : esbuildBin;
const esbuildArgs = process.platform === "win32" ? [esbuildBin] : [];
execFileSync(esbuildCommand, [...esbuildArgs,
  source,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--loader:.html=text",
  "--loader:.js=text",
  "--loader:.css=text",
  "--loader:.svg=text",
  `--outfile=${bundled}`
], { stdio: "inherit" });

if (Number(process.versions.node.split(".")[0]) < 26) {
  throw new Error("Desktop sidecar builds require Node 26+ for the built-in --build-sea path");
}

fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundled,
  mainFormat: "module",
  output,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false
}, null, 2));
execFileSync(process.execPath, ["--build-sea", seaConfig], { cwd: root, stdio: "inherit" });
if (process.platform !== "win32") fs.chmodSync(output, 0o755);
if (process.platform === "darwin") execFileSync("/usr/bin/codesign", ["--sign", "-", "--force", output], { stdio: "inherit" });
console.log(`Built ${path.relative(root, output)} for ${target}`);
