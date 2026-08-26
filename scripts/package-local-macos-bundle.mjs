import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(root, "desktop-setup", "src-tauri", "target", "release", "bundle");
const app = path.join(bundleDir, "macos", "Radoss Universal Avatar.app");
const dmgDir = path.join(bundleDir, "dmg");
const dmg = process.env.RADOS_LOCAL_DMG
  ? path.resolve(process.env.RADOS_LOCAL_DMG)
  : path.join(dmgDir, fs.readdirSync(dmgDir).find((entry) => entry.endsWith(".dmg")) ?? "");

if (process.platform !== "darwin") throw new Error("Local macOS bundle packaging requires macOS");
if (!fs.existsSync(app)) throw new Error(`Missing built app: ${app}`);
if (!dmg || !dmg.endsWith(".dmg")) throw new Error(`Missing generated DMG in ${dmgDir}`);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-local-macos-dmg-"));
const tempDmg = path.join(tempDir, path.basename(dmg));
const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "radoss-local-macos-mount-"));
let mounted = false;
try {
  run("/usr/bin/hdiutil", ["create", "-volname", "Radoss Universal Avatar", "-srcfolder", app, "-ov", "-format", "UDZO", tempDmg]);
  fs.renameSync(tempDmg, dmg);
  run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountDir, dmg]);
  mounted = true;
  const embeddedApp = path.join(mountDir, "Radoss Universal Avatar.app");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", embeddedApp]);
  fs.accessSync(path.join(embeddedApp, "Contents", "MacOS", "radoss-setup"), fs.constants.X_OK);
  console.log(`Verified local macOS app and DMG: ${dmg}`);
} finally {
  if (mounted) {
    try { run("/usr/bin/hdiutil", ["detach", mountDir]); } catch { /* preserve the original packaging error */ }
  }
  fs.rmSync(mountDir, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
}
