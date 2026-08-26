import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
for (const script of ["build-macos-keychain-helper.mjs", "prepare-desktop-frontend.mjs", "build-desktop-sidecar.mjs"]) {
  execFileSync(process.execPath, [path.join(scriptsDir, script)], { stdio: "inherit" });
}
