import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(root, "desktop-setup", "src-tauri", "target", "release", "bundle");
const builtApp = path.join(bundleDir, "macos", "NAAvOS Avatar OS.app");
const output = process.env.NAAVOS_SAMPLE_OUTPUT
  ? path.resolve(process.env.NAAVOS_SAMPLE_OUTPUT)
  : path.join(os.homedir(), "Downloads", "NAAvOS-Sample-Test-macOS.dmg");

if (process.platform !== "darwin") throw new Error("The NAAvOS macOS sample requires macOS");
if (!fs.existsSync(builtApp)) throw new Error(`Missing current Tauri app: ${builtApp}. Run the Tauri build first.`);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-sample-"));
const sampleApp = path.join(staging, "NAAvOS Avatar OS Sample.app");
const readme = path.join(staging, "README.txt");
const sampleDmg = path.join(os.tmpdir(), `NAAvOS-Sample-Test-${process.pid}.dmg`);
const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "naavos-sample-mount-"));
let mounted = false;
try {
  fs.cpSync(builtApp, sampleApp, { recursive: true });
  const samplePlist = path.join(sampleApp, "Contents", "Info.plist");
  run("/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", "com.radoss.naavos.sample", samplePlist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleName", "-string", "NAAvOS Avatar OS Sample", samplePlist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleDisplayName", "-string", "NAAvOS Avatar OS Sample", samplePlist]);
  fs.writeFileSync(path.join(sampleApp, "Contents", "Resources", "NAAVOS_SAMPLE_MODE"), "isolated\n", { mode: 0o644 });
  fs.copyFileSync(path.join(root, "docs", "SAMPLE_TESTER.md"), readme);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", sampleApp]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", sampleApp]);
  run("/usr/bin/hdiutil", ["create", "-volname", "NAAvOS Sample Test", "-srcfolder", staging, "-ov", "-format", "UDZO", sampleDmg]);
  run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountDir, sampleDmg]);
  mounted = true;
  const mountedApp = path.join(mountDir, "NAAvOS Avatar OS Sample.app");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp]);
  fs.accessSync(path.join(mountedApp, "Contents", "Resources", "NAAVOS_SAMPLE_MODE"));
  const mountedIdentifier = execFileSync("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-",
    path.join(mountedApp, "Contents", "Info.plist")
  ], { encoding: "utf8" }).trim();
  if (mountedIdentifier !== "com.radoss.naavos.sample") {
    throw new Error(`Sample bundle identifier is not isolated: ${mountedIdentifier}`);
  }
  fs.copyFileSync(sampleDmg, output);
  console.log(`Verified isolated NAAvOS sample DMG: ${output}`);
} finally {
  if (mounted) {
    try { run("/usr/bin/hdiutil", ["detach", mountDir]); } catch { /* preserve the original packaging error */ }
  }
  fs.rmSync(mountDir, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(sampleDmg, { force: true });
}
