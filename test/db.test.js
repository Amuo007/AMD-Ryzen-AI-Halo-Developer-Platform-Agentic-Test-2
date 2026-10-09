import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  useDatabase,
  createConversation,
  getConversation,
  conversationExists,
  renameConversation,
  touchConversation,
  deleteConversation,
  listConversations,
  listWorkspaces,
  appendMessage,
  loadMessages,
  loadChatMessages,
  setFeedback,
  deleteLastAssistantMessages,
  getStats,
  importWorkspace,
} from '../src/db.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-db-'));
  return useDatabase(path.join(dir, 'forge.db'));
}

test('conversation create / get / exists / rename / touch / delete', async () => {
  freshDb();
  createConversation({ id: 'conv-a', title: 'Task one', mode: 'code', workspace: '/tmp/ws-a' });
  const c = getConversation('conv-a');
  assert.equal(c.title, 'Task one');
  assert.equal(c.mode, 'code');
  assert.equal(c.workspace, '/tmp/ws-a');
  assert.ok(c.createdAt);
  assert.equal(conversationExists('conv-a'), true);
  assert.equal(conversationExists('nope'), false);
  renameConversation('conv-a', 'Renamed');
  assert.equal(getConversation('conv-a').title, 'Renamed');
  await new Promise((r) => setTimeout(r, 1100));
  touchConversation('conv-a');
  assert.ok(new Date(getConversation('conv-a').updatedAt) > new Date(c.updatedAt));
  assert.equal(deleteConversation('conv-a'), true);
  assert.equal(deleteConversation('conv-a'), false);
});

test('chat conversations have no workspace, unknown modes normalize to code', () => {
  freshDb();
  createConversation({ id: 'chat-1', mode: 'chat' });
  assert.equal(getConversation('chat-1').workspace, null);
  createConversation({ id: 'weird-1', mode: 'banana' });
  assert.equal(getConversation('weird-1').mode, 'code');
  const chatList = listConversations({ mode: 'chat' });
  assert.equal(chatList.length, 1);
  assert.equal(chatList[0].id, 'chat-1');
});

test('messages append, tool_calls JSON round-trip, ordering, chat shape', () => {
  freshDb();
  createConversation({ id: 'c1', mode: 'code', workspace: '/tmp/x' });
  appendMessage('c1', { role: 'user', content: 'hello' });
  appendMessage('c1', { role: 'assistant', content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"ls"}' } }] }, { model: 'm1', usage: { promptTokens: 10, completionTokens: 4 } });
  appendMessage('c1', { role: 'tool', tool_call_id: 'k1', name: 'run_shell', content: 'a b c' });
  const msgs = loadMessages('c1');
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].tool_calls[0].function.name, 'run_shell');
  assert.equal(msgs[1].__meta.model, 'm1');
  assert.equal(msgs[1].__meta.promptTokens, 10);
  assert.equal(msgs[2].tool_call_id, 'k1');
  const chat = loadChatMessages('c1');
  assert.equal(chat[1].tool_calls[0].id, 'k1');
  assert.equal(chat[0].__meta, undefined);
});

test('appendMessage auto-titles a fresh conversation from the first user message', () => {
  freshDb();
  createConversation({ id: 'c2' });
  appendMessage('c2', { role: 'user', content: '  please refactor\n  the thing  ' });
  assert.equal(getConversation('c2').title, 'please refactor the thing');
  appendMessage('c2', { role: 'user', content: 'second question that should never change the title at all because it is way too long to fit' });
  assert.equal(getConversation('c2').title, 'please refactor the thing');
  const longId = 'c3';
  createConversation({ id: longId });
  appendMessage(longId, { role: 'user', content: 'x'.repeat(200) });
  assert.ok(getConversation(longId).title.length <= 61);
});

test('appendMessage bumps conversation updated_at', async () => {
  freshDb();
  createConversation({ id: 'c4' });
  const before = getConversation('c4').updatedAt;
  await new Promise((r) => setTimeout(r, 1100));
  appendMessage('c4', { role: 'user', content: 'hi' });
  assert.ok(new Date(getConversation('c4').updatedAt) > new Date(before));
});

test('listConversations filters by workspace/mode/query, sorts newest first, counts messages', () => {
  freshDb();
  createConversation({ id: 'a', title: 'Build widget', workspace: '/tmp/w1', mode: 'code', createdAt: '2026-01-01T00:00:00.000Z' });
  createConversation({ id: 'b', title: 'Other thing', workspace: '/tmp/w1', mode: 'code', createdAt: '2026-01-02T00:00:00.000Z' });
  createConversation({ id: 'c', title: 'Chat 100% question?', workspace: null, mode: 'chat', createdAt: '2026-01-03T00:00:00.000Z' });
  touchConversation('a'); // bump a to now → newest
  appendMessage('a', { role: 'user', content: 'go', createdAt: '2026-01-01T00:00:00.000Z' });
  appendMessage('a', { role: 'tool', tool_call_id: 't', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
  const w1 = listConversations({ workspace: '/tmp/w1' });
  assert.equal(w1.length, 2);
  assert.equal(w1[0].id, 'a'); // most recently touched
  assert.equal(w1[1].id, 'b');
  assert.equal(w1.find((s) => s.id === 'a').messageCount, 1); // tool msgs excluded
  const q = listConversations({ query: 'widget' });
  assert.deepEqual(q.map((s) => s.id), ['a']);
  const q2 = listConversations({ query: '100%' }); // LIKE wildcard must be escaped
  assert.deepEqual(q2.map((s) => s.id), ['c']);
  const q3 = listConversations({ query: '100x' });
  assert.deepEqual(q3.map((s) => s.id), []);
});

test('listWorkspaces groups code conversations by workspace', () => {
  freshDb();
  createConversation({ id: 'w1', workspace: '/tmp/wa', mode: 'code' });
  createConversation({ id: 'w2', workspace: '/tmp/wa', mode: 'code' });
  createConversation({ id: 'w3', workspace: '/tmp/wb', mode: 'code' });
  createConversation({ id: 'w4', mode: 'chat' });
  const ws = listWorkspaces();
  assert.equal(ws.find((w) => w.workspace === '/tmp/wa').conversations, 2);
  assert.equal(ws.find((w) => w.workspace === '/tmp/wb').conversations, 1);
  assert.equal(ws.find((w) => w.workspace === null), undefined);
});

test('deleteConversation cascades messages', () => {
  freshDb();
  createConversation({ id: 'dc' });
  appendMessage('dc', { role: 'user', content: 'hi' });
  deleteConversation('dc');
  assert.equal(loadMessages('dc').length, 0);
});

test('feedback + deleteLastAssistantMessages', () => {
  freshDb();
  createConversation({ id: 'fb' });
  appendMessage('fb', { role: 'user', content: 'q' });
  const rowId = appendMessage('fb', { role: 'assistant', content: 'a' });
  setFeedback(rowId, 'up');
  assert.equal(loadMessages('fb').at(-1).__meta.feedback, 'up');
  assert.equal(deleteLastAssistantMessages('fb'), true);
  assert.equal(loadMessages('fb').length, 1);
  assert.equal(deleteLastAssistantMessages('fb'), false);
});

test('getStats counts sessions/messages/tokens/days/peak hour/favorite model/heatmap', () => {
  freshDb();
  createConversation({ id: 's1', mode: 'code', workspace: '/tmp/s' });
  createConversation({ id: 's2', mode: 'chat' });
  appendMessage('s1', { role: 'user', content: 'hi' }, { model: 'm-a', usage: { promptTokens: 100, completionTokens: 10 } });
  appendMessage('s1', { role: 'assistant', content: 'ok' }, { model: 'm-a', usage: { promptTokens: 50, completionTokens: 20 } });
  appendMessage('s2', { role: 'user', content: 'hello' }, { model: 'm-b', usage: { promptTokens: 10, completionTokens: 1 } });
  const st = getStats({ range: 'all' });
  assert.equal(st.sessions, 2);
  assert.equal(st.messages, 3);
  assert.equal(st.totalTokens, 191);
  assert.equal(st.activeDays >= 1, true);
  assert.equal(st.favoriteModel, 'm-a');
  assert.equal(st.models.length, 2);
  assert.equal(st.heatmap.length >= 1, true);
  assert.equal(typeof st.heatmap[0].date, 'string');
  const empty = getStats({ range: '7d' });
  assert.equal(empty.sessions, 2);
});

test('importWorkspace imports legacy JSONL sessions once, skipping corrupt lines', async () => {
  freshDb();
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-import-'));
  const ws = fs.realpathSync(raw);
  const dir = path.join(ws, '.forge', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'meta', id: 'old-1', createdAt: '2026-01-02T03:04:05.000Z' }),
    JSON.stringify({ role: 'user', content: 'old task' }),
    'CORRUPT{{{',
    JSON.stringify({ role: 'assistant', content: 'old answer' }),
  ];
  await fsp.writeFile(path.join(dir, 'old-1.jsonl'), lines.join('\n') + '\n');
  const n = importWorkspace(ws);
  assert.equal(n, 1);
  const conv = getConversation('old-1');
  assert.equal(conv.mode, 'code');
  assert.equal(conv.workspace, fs.realpathSync(ws));
  assert.equal(conv.createdAt, '2026-01-02T03:04:05.000Z');
  const msgs = loadMessages('old-1');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, 'old task');
  assert.equal(importWorkspace(ws), 0, 'second import is a no-op');
  assert.equal(importWorkspace('/definitely/not/here-xyz'), 0);
  const list = listConversations({ mode: 'code', workspace: conv.workspace });
  assert.equal(list[0].id, 'old-1');
});
