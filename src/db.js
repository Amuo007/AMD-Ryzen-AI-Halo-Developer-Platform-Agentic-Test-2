import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonl, firstUserTitle } from './jsonl.js';

/**
 * SQLite storage for forge: settings, conversations, messages.
 * One process-wide database at <dataDir>/forge.db
 * (dataDir = FORGE_DATA_DIR env or ~/.forge).
 */

let dbInstance = null;
let dbFile = null;

export function defaultDataDir() {
  return process.env.FORGE_DATA_DIR || path.join(os.homedir(), '.forge');
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'New conversation',
      mode       TEXT NOT NULL DEFAULT 'code',
      workspace  TEXT,
      reasoning  TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT,
      tool_calls      TEXT,
      tool_call_id    TEXT,
      name            TEXT,
      model           TEXT,
      prompt_tokens    INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      feedback        TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_conversations_ws ON conversations(workspace, updated_at);
    CREATE TABLE IF NOT EXISTS imported (
      path        TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
      conversation_id TEXT PRIMARY KEY,
      todos           TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT,
      source          TEXT NOT NULL DEFAULT 'user',
      mime            TEXT NOT NULL,
      path            TEXT NOT NULL,
      width           INTEGER NOT NULL DEFAULT 0,
      height          INTEGER NOT NULL DEFAULT 0,
      bytes           INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
  `);
  // migrations for databases created before a column existed
  const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!convCols.includes('reasoning')) db.exec("ALTER TABLE conversations ADD COLUMN reasoning TEXT NOT NULL DEFAULT 'auto'");
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!msgCols.includes('images')) db.exec('ALTER TABLE messages ADD COLUMN images TEXT');
  return db;
}

export function getDb() {
  if (!dbInstance) {
    const dir = defaultDataDir();
    fs.mkdirSync(dir, { recursive: true });
    dbFile = path.join(dir, 'forge.db');
    dbInstance = openDatabase(dbFile);
  }
  return dbInstance;
}

export function dbFilePath() {
  getDb();
  return dbFile;
}

/** Test helper: swap the process-wide instance. Pass a file path or null to forget. */
export function useDatabase(file) {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* already closed */
    }
  }
  dbInstance = null;
  dbFile = null;
  if (file) {
    dbFile = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    dbInstance = openDatabase(file);
  }
  return dbInstance;
}

/* ---------------- settings ---------------- */

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function setSettings(obj) {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v));
}

/* ---------------- todos ---------------- */

export function setTodos(conversationId, todos) {
  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO todos (conversation_id, todos, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET todos = excluded.todos, updated_at = excluded.updated_at')
    .run(String(conversationId), JSON.stringify(todos), now);
  return todos;
}

export function getTodos(conversationId) {
  const row = getDb().prepare('SELECT todos FROM todos WHERE conversation_id = ?').get(String(conversationId));
  if (!row) return [];
  try {
    return JSON.parse(row.todos);
  } catch {
    return [];
  }
}

/* ---------------- conversations ---------------- */

function rowToConversation(row) {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    workspace: row.workspace,
    reasoning: row.reasoning || 'auto',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConversation({ id, title = 'New conversation', mode = 'code', workspace = null, reasoning = 'auto', createdAt = null }) {
  const now = createdAt ?? new Date().toISOString();
  getDb()
    .prepare('INSERT INTO conversations (id, title, mode, workspace, reasoning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, mode === 'chat' ? 'chat' : 'code', workspace, reasoning, now, now);
  return { id, title, mode: mode === 'chat' ? 'chat' : 'code', workspace, reasoning, createdAt: now, updatedAt: now };
}

export function getConversation(id) {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(String(id));
  return row ? rowToConversation(row) : null;
}

export function conversationExists(id) {
  return Boolean(getDb().prepare('SELECT 1 AS x FROM conversations WHERE id = ?').get(String(id)));
}

export function renameConversation(id, title) {
  getDb().prepare('UPDATE conversations SET title = ? WHERE id = ?').run(String(title).slice(0, 200), String(id));
}

export function setConversationReasoning(id, reasoning) {
  getDb().prepare('UPDATE conversations SET reasoning = ? WHERE id = ?').run(String(reasoning), String(id));
}

export function touchConversation(id, { mode, workspace } = {}) {
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE conversations SET updated_at = ?, mode = COALESCE(?, mode), workspace = COALESCE(?, workspace) WHERE id = ?')
    .run(now, mode ?? null, workspace ?? null, String(id));
}

export function deleteConversation(id) {
  const changes = getDb().prepare('DELETE FROM conversations WHERE id = ?').run(String(id)).changes;
  getDb().prepare('DELETE FROM todos WHERE conversation_id = ?').run(String(id));
  return changes > 0;
}

/**
 * List conversations newest-first.
 *  - mode: 'chat' | 'code' | null (both)
 *  - workspace: restrict to this workspace (code conversations)
 *  - query: case-insensitive title filter
 */
export function listConversations({ mode = null, workspace = null, query = null, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (mode) {
    clauses.push('mode = ?');
    params.push(mode);
  }
  if (workspace) {
    clauses.push('workspace = ?');
    params.push(workspace);
  }
  if (query) {
    clauses.push("title LIKE ? ESCAPE '\\'");
    const q = String(query)
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    params.push(`%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM conversations ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, Number(limit));
  const counts = getDb().prepare('SELECT conversation_id, COUNT(*) AS n FROM messages WHERE role != ? GROUP BY conversation_id')
    .all('tool')
    .reduce((m, r) => (m.set(r.conversation_id, r.n), m), new Map());
  return rows.map((r) => ({ ...rowToConversation(r), messageCount: counts.get(r.id) ?? 0 }));
}

/** Distinct workspaces that have conversations (for a projects list). */
export function listWorkspaces() {
  const rows = getDb()
    .prepare("SELECT workspace, COUNT(*) AS n FROM conversations WHERE workspace IS NOT NULL AND mode = 'code' GROUP BY workspace ORDER BY MAX(updated_at) DESC")
    .all();
  return rows.map((r) => ({ workspace: r.workspace, conversations: r.n }));
}

/* ---------------- messages ---------------- */

export function appendMessage(conversationId, message, { model = null, usage = null, createdAt = null } = {}) {
  const db = getDb();
  const now = createdAt ?? new Date().toISOString();
  const res = db
    .prepare(
      'INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, name, model, prompt_tokens, completion_tokens, images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(conversationId),
      String(message.role),
      message.content == null ? null : String(message.content),
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id ?? null,
      message.name ?? null,
      model,
      usage?.promptTokens ?? 0,
      usage?.completionTokens ?? 0,
      Array.isArray(message.images) && message.images.length ? JSON.stringify(message.images.map(String)) : null,
      now
    );
  touchConversation(conversationId);
  if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
    const conv = getConversation(conversationId);
    if (conv && (!conv.title || conv.title === 'New conversation')) {
      const t = message.content.trim().replace(/\s+/g, ' ');
      renameConversation(conversationId, t.length > 60 ? `${t.slice(0, 60)}…` : t);
    }
  }
  return Number(res.lastInsertRowid);
}

function rowToMessage(row) {
  const m = { role: row.role };
  if (row.content !== null) m.content = row.content;
  else if (row.role === 'assistant') m.content = null;
  if (row.tool_calls) m.tool_calls = JSON.parse(row.tool_calls);
  if (row.tool_call_id) m.tool_call_id = row.tool_call_id;
  if (row.name) m.name = row.name;
  if (row.images) {
    try {
      const ids = JSON.parse(row.images);
      if (Array.isArray(ids) && ids.length) m.images = ids.map(String);
    } catch {
      /* corrupt images column → treated as none */
    }
  }
  return m;
}

/** Full stored history for a conversation (all rows, in insertion order). */
export function loadMessages(conversationId) {
  const rows = getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(String(conversationId));
  return rows.map((r) => ({ ...rowToMessage(r), __meta: { id: r.id, model: r.model, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, feedback: r.feedback, createdAt: r.created_at } }));
}

/** OpenAI-shaped message list for the LLM (no meta fields). */
export function loadChatMessages(conversationId) {
  return loadMessages(conversationId).map(({ __meta, ...m }) => m);
}

export function setFeedback(messageRowId, feedback) {
  getDb().prepare('UPDATE messages SET feedback = ? WHERE id = ?').run(feedback, Number(messageRowId));
}

export function deleteLastAssistantMessages(conversationId) {
  const db = getDb();
  const last = db.prepare('SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(String(conversationId));
  if (!last || last.role !== 'assistant') return false;
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(String(conversationId), last.id);
  return true;
}

/* ---------------- images ---------------- */

export function addImage({ id, conversationId = null, source = 'user', mime, path: file, width = 0, height = 0, bytes = 0, createdAt = null }) {
  const now = createdAt ?? new Date().toISOString();
  getDb()
    .prepare('INSERT INTO images (id, conversation_id, source, mime, path, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(id), conversationId == null ? null : String(conversationId), String(source), String(mime), String(file), Number(width) || 0, Number(height) || 0, Number(bytes) || 0, now);
  return { id: String(id), conversationId: conversationId == null ? null : String(conversationId), source, mime, path: file, width: Number(width) || 0, height: Number(height) || 0, bytes: Number(bytes) || 0, createdAt: now };
}

export function getImage(id) {
  const row = getDb().prepare('SELECT * FROM images WHERE id = ?').get(String(id));
  if (!row) return null;
  return { id: row.id, conversationId: row.conversation_id, source: row.source, mime: row.mime, path: row.path, width: row.width, height: row.height, bytes: row.bytes, createdAt: row.created_at };
}

export function listConversationImages(conversationId) {
  const rows = getDb().prepare('SELECT * FROM images WHERE conversation_id = ? ORDER BY id').all(String(conversationId));
  return rows.map((row) => ({ id: row.id, source: row.source, mime: row.mime, width: row.width, height: row.height, bytes: row.bytes }));
}

/* ---------------- stats ---------------- */

const RANGE_DAYS = { all: null, '30d': 30, '7d': 7 };

export function getStats({ range = 'all' } = {}) {
  const db = getDb();
  const days = RANGE_DAYS[range] ?? null;
  const where = days ? `WHERE created_at >= datetime('now', ?)` : '';
  const args = days ? [`-${days} days`] : [];
  const msgAgg = db
    .prepare(`SELECT COUNT(*) AS messages, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens FROM messages ${where}`)
    .get(...args);
  const convWhere = days ? `WHERE updated_at >= datetime('now', ?)` : '';
  const convAgg = db.prepare(`SELECT COUNT(*) AS sessions FROM conversations ${convWhere}`).get(...convWhere ? args : []);
  const activeDays = db
    .prepare(`SELECT COUNT(DISTINCT substr(created_at, 1, 10)) AS n FROM messages ${where}`)
    .get(...args).n;
  const peakRow = db
    .prepare(`SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n FROM messages ${where} GROUP BY hour ORDER BY n DESC LIMIT 1`)
    .get(...args);
  const modelWhere = days ? "WHERE model IS NOT NULL AND created_at >= datetime('now', ?)" : 'WHERE model IS NOT NULL';
  const fav = db
    .prepare(`SELECT model, COUNT(*) AS messages, SUM(prompt_tokens + completion_tokens) AS tokens FROM messages ${modelWhere} GROUP BY model ORDER BY tokens DESC LIMIT 1`)
    .get(...(days ? [args[0]] : []));
  const models = db
    .prepare(`SELECT model, COUNT(*) AS messages, SUM(prompt_tokens + completion_tokens) AS tokens FROM messages ${modelWhere} GROUP BY model ORDER BY tokens DESC LIMIT 10`)
    .all(...(days ? [args[0]] : []));
  const heatWhere = days ? `WHERE created_at >= datetime('now', ?)` : '';
  const heatmap = db
    .prepare(`SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS messages, SUM(prompt_tokens + completion_tokens) AS tokens FROM messages ${heatWhere} GROUP BY date ORDER BY date`)
    .all(...args);
  return {
    range,
    sessions: convAgg.sessions,
    messages: msgAgg.messages,
    totalTokens: msgAgg.tokens,
    activeDays,
    peakHour: peakRow ? peakRow.hour : null,
    favoriteModel: fav?.model ?? null,
    models: models.map((m) => ({ model: m.model, messages: m.messages, tokens: m.tokens })),
    heatmap,
  };
}

/* ---------------- JSONL import ---------------- */

/**
 * Import legacy <workspace>/.forge/sessions/*.jsonl into the database.
 * Each path is imported at most once (tracked in the `imported` table).
 * Returns the number of conversations imported.
 */
export function importWorkspace(workspace, { remove = false } = {}) {
  const dir = path.join(workspace, '.forge', 'sessions');
  const db = getDb();
  const done = db.prepare('SELECT 1 AS x FROM imported WHERE path = ?').get(workspace);
  if (done && !remove) return 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    db.prepare('INSERT INTO imported (path, imported_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET imported_at = excluded.imported_at').run(workspace, new Date().toISOString());
    return 0;
  }
  let imported = 0;
  for (const name of names) {
    const id = name.slice(0, -'.jsonl'.length);
    if (!id) continue;
    if (conversationExists(id)) continue;
    const file = path.join(dir, name);
    let objs;
    try {
      objs = parseJsonl(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const meta = objs.find((o) => o.type === 'meta');
    const messages = objs.filter((o) => typeof o.role === 'string');
    createConversation({ id, title: firstUserTitle(objs), mode: 'code', workspace, createdAt: meta?.createdAt });
    for (const m of messages) appendMessage(id, m, { createdAt: meta?.createdAt });
    imported++;
  }
  db.prepare('INSERT INTO imported (path, imported_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET imported_at = excluded.imported_at').run(workspace, new Date().toISOString());
  return imported;
}
