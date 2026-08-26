import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "desktop-setup");
const outputDir = path.join(sourceDir, ".build", "frontend");
const assets = ["index.html", "app.js", "styles.css", "favicon.svg"];

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(sourceDir, asset), path.join(outputDir, asset));
}
console.log(`Prepared ${assets.length} desktop frontend assets in ${path.relative(root, outputDir)}`);
