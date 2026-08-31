import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageScript = path.join(root, "scripts", "package-sample-macos.mjs");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const output = process.env.NAAVOS_SAMPLE_ZIP_OUTPUT
  ? path.resolve(process.env.NAAVOS_SAMPLE_ZIP_OUTPUT)
  : path.join(os.homedir(), "Downloads", `NAAvOS-Sample-Test-macOS-${timestamp}.zip`);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-sample-zip-"));
const tempDmg = path.join(tempRoot, "NAAvOS-Sample-Test-macOS.dmg");
const packageDir = path.join(tempRoot, "NAAvOS-Sample-Test-macOS");

try {
  execFileSync(process.execPath, [packageScript], {
    cwd: root,
    env: { ...process.env, NAAVOS_SAMPLE_OUTPUT: tempDmg },
    stdio: "inherit"
  });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(tempDmg, path.join(packageDir, path.basename(tempDmg)));
  fs.copyFileSync(path.join(root, "docs", "SAMPLE_TESTER.md"), path.join(packageDir, "README.txt"));
  const dmgName = path.basename(tempDmg);
  const digest = execFileSync("/usr/bin/shasum", ["-a", "256", dmgName], { cwd: packageDir, encoding: "utf8" });
  fs.writeFileSync(path.join(packageDir, "SHA256SUMS.txt"), digest);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", packageDir, output], { stdio: "inherit" });
  console.log(`Verified sendable NAAvOS sample bundle: ${output}`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
