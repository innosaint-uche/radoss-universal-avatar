import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

if (manifest.private === true)
  throw new Error("Public npm package must not be private");
if (manifest.publishConfig?.access !== "public")
  throw new Error("Public npm package must set publishConfig.access=public");

const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:ghp|github_pat|sk-proj|sk-ant)-[A-Za-z0-9_\-]{12,}/i,
];
const roots = [
  "bin",
  "lib",
  "desktop-setup",
  "docs",
  "scripts",
  "README.md",
  "package.json",
];
const files = [];

function walk(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    files.push(absolute);
    return;
  }
  for (const entry of fs.readdirSync(absolute)) {
    if (["node_modules", "target", ".build", "binaries"].includes(entry))
      continue;
    walk(path.join(relative, entry));
  }
}

for (const relative of roots) walk(relative);
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const pattern = forbidden.find((candidate) => candidate.test(content));
  if (pattern)
    throw new Error(
      `Public package check rejected ${path.relative(root, file)} (${pattern})`,
    );
}

const executableFiles = files.filter(
  (file) => !path.relative(root, file).startsWith("docs/"),
);
for (const file of executableFiles) {
  if (/api\.naavos\.io/i.test(fs.readFileSync(file, "utf8"))) {
    throw new Error(
      `Public package check rejected retired route in ${path.relative(root, file)}`,
    );
  }
}

console.log(`Public package preflight passed (${files.length} files scanned)`);
