import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HOME = process.env.RADOS_HOME ?? os.homedir();
export const MEMORY_DIR = path.join(HOME, ".naavos");
export const MEMORY_DB_PATH = process.env.RADOS_MEMORY_DB ?? path.join(MEMORY_DIR, "avatar.sqlite");

function ensureDirectory() {
  fs.mkdirSync(path.dirname(MEMORY_DB_PATH), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(MEMORY_DB_PATH), 0o700);
}

function openDatabase() {
  ensureDirectory();
  const database = new DatabaseSync(MEMORY_DB_PATH);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      avatar_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      avatar_id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);
  return database;
}

export function initializeMemory() {
  const database = openDatabase();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
  return memoryStatus();
}

export function memoryStatus() {
  if (!fs.existsSync(MEMORY_DB_PATH)) return { status: "not_initialized", path: MEMORY_DB_PATH, fts5: false, items: 0 };
  const database = openDatabase();
  const itemCount = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_items").get().count);
  const ftsCount = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_fts").get().count);
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
  return { status: "ready", path: MEMORY_DB_PATH, fts5: true, items: itemCount, indexed_items: ftsCount };
}

export function remember({ avatarId, content, kind = "note", source = "user", approved = false } = {}) {
  if (!avatarId) throw new Error("avatarId is required");
  const text = String(content ?? "").trim();
  if (!text) throw new Error("Memory content cannot be empty");
  if (!approved) return { status: "pending_approval", content: text };
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  const database = openDatabase();
  database.exec("BEGIN");
  try {
    database.prepare("INSERT INTO memory_items (id, avatar_id, kind, content, source, approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, avatarId, kind, text, source, timestamp, timestamp);
    database.prepare("INSERT INTO memory_fts (id, avatar_id, content) VALUES (?, ?, ?)").run(id, avatarId, text);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
  return { status: "stored", id, avatar_id: avatarId, created_at: timestamp };
}

export function searchMemory({ avatarId, query, limit = 20 } = {}) {
  if (!avatarId) throw new Error("avatarId is required");
  const terms = String(query ?? "").trim().split(/\s+/).map((term) => term.replace(/["*:^(){}]/g, "")).filter(Boolean);
  if (!terms.length) return [];
  const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
  const database = openDatabase();
  const results = database.prepare(`
    SELECT memory_items.id, memory_items.avatar_id, memory_items.kind, memory_items.content,
      memory_items.source, memory_items.created_at, memory_items.updated_at,
      bm25(memory_fts) AS rank
    FROM memory_fts JOIN memory_items ON memory_items.id = memory_fts.id
    WHERE memory_fts MATCH ? AND memory_items.avatar_id = ? AND memory_items.approved = 1
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, avatarId, Math.max(1, Math.min(100, Number(limit) || 20)));
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
  return results;
}

export function listApprovedMemory({ avatarId } = {}) {
  if (!avatarId) throw new Error("avatarId is required");
  const database = openDatabase();
  const results = database.prepare(`
    SELECT id, avatar_id, kind, content, source, created_at, updated_at
    FROM memory_items
    WHERE avatar_id = ? AND approved = 1
    ORDER BY updated_at ASC, id ASC
  `).all(avatarId);
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
  return results;
}

export function checkpointMemory() {
  if (!fs.existsSync(MEMORY_DB_PATH)) return;
  const database = openDatabase();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  database.close();
  fs.chmodSync(MEMORY_DB_PATH, 0o600);
}
