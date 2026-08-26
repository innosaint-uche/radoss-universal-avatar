import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  console.log("Skipping macOS Keychain helper on non-macOS host");
  process.exit(0);
}

const source = path.join(root, "scripts", "macos-keychain-helper.m");
const binariesDir = path.join(root, "desktop-setup", "src-tauri", "binaries");
function hostTarget() {
  if (process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`Unsupported macOS helper architecture: ${process.arch}`);
}

const target = hostTarget();
const output = path.join(binariesDir, `radoss-keychain-helper-${target}`);
fs.mkdirSync(binariesDir, { recursive: true });
const clang = "/usr/bin/clang";
execFileSync(clang, ["-O2", "-fobjc-arc", source, "-framework", "Foundation", "-framework", "Security", "-o", output], { stdio: "inherit" });
fs.chmodSync(output, 0o755);
console.log(`Built ${path.relative(root, output)} for ${target} (${os.arch()})`);
