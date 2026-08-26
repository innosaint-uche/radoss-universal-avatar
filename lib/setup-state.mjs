import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const HOME = process.env.RADOS_HOME ?? os.homedir();
export const NAAVOS_DIR = path.join(HOME, ".naavos");
export const SETUP_STATE_PATH = path.join(NAAVOS_DIR, "setup.json");
export const BACKUPS_DIR = path.join(NAAVOS_DIR, "backups");
const SNAPSHOT_KEY_PATH = path.join(NAAVOS_DIR, ".snapshot-key");
const SNAPSHOT_FORMAT = Buffer.from("RAV1");

const DEFAULT_STATE = {
  schema_version: 1,
  product: "radoss-universal-avatar",
  setup: {
    status: "not_started",
    phase: "welcome",
    last_run_at: null,
    last_backup_id: null,
    last_request: null,
    last_error: null
  },
  avatar: {
    id: null,
    name: null,
    created_at: null,
    updated_at: null
  },
  privacy: {
    mode: "local_only",
    telemetry: false,
    memory_capture: "approval_required",
    cloud_sync: false
  },
  providers: {},
  agents: {},
  audit: []
};

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeAtomic(filePath, value, mode = 0o600) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tempPath, filePath);
}

function snapshotKey() {
  ensureDirectory(NAAVOS_DIR);
  if (!fs.existsSync(SNAPSHOT_KEY_PATH)) {
    fs.writeFileSync(SNAPSHOT_KEY_PATH, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  fs.chmodSync(SNAPSHOT_KEY_PATH, 0o600);
  const key = fs.readFileSync(SNAPSHOT_KEY_PATH);
  if (key.length !== 32) throw new Error(`Invalid local snapshot key: ${SNAPSHOT_KEY_PATH}`);
  return key;
}

function encryptSnapshot(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([SNAPSHOT_FORMAT, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptSnapshot(value, key) {
  if (value.subarray(0, SNAPSHOT_FORMAT.length).compare(SNAPSHOT_FORMAT) !== 0) {
    throw new Error("Invalid encrypted snapshot format");
  }
  const ivStart = SNAPSHOT_FORMAT.length;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(ivStart, tagStart));
  decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
  return Buffer.concat([decipher.update(value.subarray(ciphertextStart)), decipher.final()]);
}

function snapshotFilePath(snapshotRoot, relativeName) {
  const resolvedRoot = path.resolve(snapshotRoot);
  const resolved = path.resolve(snapshotRoot, relativeName);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Invalid snapshot file path");
  }
  return resolved;
}

function migrateLegacySnapshots() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const key = snapshotKey();
  for (const entry of fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const snapshotRoot = path.join(BACKUPS_DIR, entry.name);
    const manifestPath = path.join(snapshotRoot, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { continue; }
    if (manifest.encrypted || manifest.schema_version >= 2) continue;

    const migratedFiles = (manifest.files ?? []).map((file) => {
      if (!file.exists || file.encrypted) return { ...file, encrypted: Boolean(file.encrypted) };
      const oldPath = snapshotFilePath(snapshotRoot, file.relative);
      if (!fs.existsSync(oldPath)) return { ...file, encrypted: false };
      const nextRelative = `${file.relative}.enc`;
      const nextPath = snapshotFilePath(snapshotRoot, nextRelative);
      fs.writeFileSync(nextPath, encryptSnapshot(fs.readFileSync(oldPath), key), { mode: 0o600 });
      return { ...file, relative: nextRelative, encrypted: true };
    });
    const migrated = { ...manifest, schema_version: 2, encrypted: true, files: migratedFiles };
    writeAtomic(manifestPath, migrated);
    for (const file of manifest.files ?? []) {
      if (!file.exists || file.encrypted) continue;
      const oldPath = snapshotFilePath(snapshotRoot, file.relative);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
}

export function loadSetupState() {
  if (!fs.existsSync(SETUP_STATE_PATH)) return clone(DEFAULT_STATE);
  const parsed = JSON.parse(fs.readFileSync(SETUP_STATE_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.schema_version !== 1) {
    throw new Error(`Invalid setup state: ${SETUP_STATE_PATH}`);
  }
  return {
    ...clone(DEFAULT_STATE),
    ...parsed,
    setup: { ...DEFAULT_STATE.setup, ...(parsed.setup ?? {}) },
    avatar: { ...DEFAULT_STATE.avatar, ...(parsed.avatar ?? {}) },
    privacy: { ...DEFAULT_STATE.privacy, ...(parsed.privacy ?? {}) },
    providers: parsed.providers ?? {},
    agents: parsed.agents ?? {},
    audit: Array.isArray(parsed.audit) ? parsed.audit : []
  };
}

export function saveSetupState(state) {
  writeAtomic(SETUP_STATE_PATH, state);
  return state;
}

export function recordAudit(state, action, details = {}) {
  state.audit ??= [];
  state.audit.push({
    id: crypto.randomUUID(),
    action,
    at: new Date().toISOString(),
    details
  });
  if (state.audit.length > 100) state.audit = state.audit.slice(-100);
  return state;
}

function copySnapshotFile(sourcePath, snapshotRoot, relativeName, key) {
  const exists = fs.existsSync(sourcePath);
  const destination = path.join(snapshotRoot, relativeName);
  if (exists) {
    ensureDirectory(path.dirname(destination));
    fs.writeFileSync(destination, encryptSnapshot(fs.readFileSync(sourcePath), key), { mode: 0o600 });
  }
  return { source: sourcePath, relative: relativeName, exists, encrypted: exists };
}

export function createSnapshot({ paths, reason = "manual" }) {
  migrateLegacySnapshots();
  const id = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const snapshotRoot = path.join(BACKUPS_DIR, id);
  ensureDirectory(snapshotRoot);
  const key = snapshotKey();
  const files = paths.map((sourcePath, index) => copySnapshotFile(
    sourcePath,
    snapshotRoot,
    `${String(index).padStart(2, "0")}-${path.basename(sourcePath)}`,
    key
  ));
  const manifest = {
    schema_version: 2,
    id,
    reason,
    created_at: new Date().toISOString(),
    encrypted: true,
    files
  };
  writeAtomic(path.join(snapshotRoot, "manifest.json"), manifest);
  return manifest;
}

export function listSnapshots() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(BACKUPS_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) return null;
      try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function restoreSnapshot(id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("Invalid backup id");
  const snapshotRoot = path.join(BACKUPS_DIR, id);
  const manifestPath = path.join(snapshotRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Backup not found: ${id}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const key = manifest.encrypted ? snapshotKey() : null;
  for (const file of manifest.files) {
    const source = snapshotFilePath(snapshotRoot, file.relative);
    if (file.exists) {
      ensureDirectory(path.dirname(file.source));
      const content = file.encrypted ? decryptSnapshot(fs.readFileSync(source), key) : fs.readFileSync(source);
      fs.writeFileSync(file.source, content, { mode: 0o600 });
      fs.chmodSync(file.source, 0o600);
    } else if (fs.existsSync(file.source)) {
      fs.unlinkSync(file.source);
    }
  }
  return manifest;
}

export function setupPaths({ registryPath, targetPaths, extraPaths = [] }) {
  return [
    registryPath,
    ...Object.values(targetPaths),
    SETUP_STATE_PATH,
    ...extraPaths
  ];
}
