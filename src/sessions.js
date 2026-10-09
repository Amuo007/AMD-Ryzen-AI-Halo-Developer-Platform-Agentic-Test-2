import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function sessionsDir(workspace) {
  return path.join(workspace, '.forge', 'sessions');
}

export function sessionFile(workspace, id) {
  if (!SESSION_ID_RE.test(String(id))) throw new Error(`Invalid session id: ${id}`);
  return path.join(sessionsDir(workspace), `${id}.jsonl`);
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip corrupt lines rather than fail the whole session
    }
  }
  return out;
}

function firstUserTitle(objs) {
  for (const o of objs) {
    if (o.type === 'meta' && o.title) return o.title;
  }
  for (const o of objs) {
    if (o.role === 'user' && typeof o.content === 'string' && o.content.trim()) {
      const t = o.content.trim().replace(/\s+/g, ' ');
      return t.length > 60 ? `${t.slice(0, 60)}…` : t;
    }
  }
  return 'Untitled session';
}

export async function createSession(workspace, id, { title } = {}) {
  const file = sessionFile(workspace, id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify({ type: 'meta', id, createdAt: new Date().toISOString(), ...(title ? { title } : {}) })}\n`, 'utf8');
  return file;
}

export async function appendMessage(workspace, id, message) {
  const file = sessionFile(workspace, id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(message)}\n`, 'utf8');
}

export async function loadSession(workspace, id) {
  const file = sessionFile(workspace, id);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const objs = parseJsonl(text);
  return {
    id,
    title: firstUserTitle(objs),
    createdAt: objs.find((o) => o.type === 'meta')?.createdAt ?? null,
    messages: objs.filter((o) => typeof o.role === 'string'),
  };
}

export async function listSessions(workspace) {
  const dir = sessionsDir(workspace);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    const full = path.join(dir, name);
    const s = await loadSession(workspace, id);
    if (!s) continue;
    const stat = await fsp.stat(full);
    out.push({ id, title: s.title, createdAt: s.createdAt, updatedAt: stat.mtime.toISOString(), messageCount: s.messages.filter((m) => m.role !== 'tool').length });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export async function deleteSession(workspace, id) {
  try {
    await fsp.unlink(sessionFile(workspace, id));
    return true;
  } catch {
    return false;
  }
}
