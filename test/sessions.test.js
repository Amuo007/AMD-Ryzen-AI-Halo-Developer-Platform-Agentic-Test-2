import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newSessionId, sessionsDir, createSession, appendMessage, loadSession, listSessions, deleteSession } from '../src/sessions.js';

async function tmpws() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-sess-'));
}

test('session id is safe', () => {
  const id = newSessionId();
  assert.match(id, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(id, newSessionId());
});

test('invalid session ids are rejected', () => {
  const ws = process.cwd();
  return assert.rejects(
    (async () => {
      await createSession(ws, '../../evil');
    })(),
    /Invalid session id/
  );
});

test('create, append and load a session', async () => {
  const ws = await tmpws();
  const id = newSessionId();
  await createSession(ws, id, { title: 'My task' });
  await appendMessage(ws, id, { role: 'user', content: 'do it' });
  await appendMessage(ws, id, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] });
  await appendMessage(ws, id, { role: 'tool', tool_call_id: 'c1', content: 'ok' });
  const s = await loadSession(ws, id);
  assert.equal(s.id, id);
  assert.equal(s.title, 'My task');
  assert.equal(s.messages.length, 3);
  assert.equal(s.messages[1].tool_calls[0].function.name, 'write_file');
});

test('title falls back to first user message', async () => {
  const ws = await tmpws();
  const id = newSessionId();
  await appendMessage(ws, id, { role: 'user', content: '  please refactor\nthe thing  ' });
  const s = await loadSession(ws, id);
  assert.equal(s.title, 'please refactor the thing');
});

test('long titles are shortened', async () => {
  const ws = await tmpws();
  const id = newSessionId();
  await appendMessage(ws, id, { role: 'user', content: 'x'.repeat(200) });
  const s = await loadSession(ws, id);
  assert.ok(s.title.length <= 61);
});

test('listSessions returns sessions sorted newest first with counts', async () => {
  const ws = await tmpws();
  const a = newSessionId();
  const b = newSessionId();
  await createSession(ws, a);
  await appendMessage(ws, a, { role: 'user', content: 'first' });
  await new Promise((r) => setTimeout(r, 30));
  await createSession(ws, b);
  await appendMessage(ws, b, { role: 'user', content: 'second' });
  const list = await listSessions(ws);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b);
  assert.equal(list[0].messageCount, 1);
  assert.equal(list[1].id, a);
});

test('listSessions on missing dir returns []', async () => {
  const ws = await tmpws();
  assert.deepEqual(await listSessions(ws), []);
});

test('corrupt JSONL lines are skipped, not fatal', async () => {
  const ws = await tmpws();
  const id = newSessionId();
  await createSession(ws, id);
  await appendMessage(ws, id, { role: 'user', content: 'fine' });
  await fsp.appendFile(path.join(sessionsDir(ws), `${id}.jsonl`), 'NOT JSON {{{\n');
  const s = await loadSession(ws, id);
  assert.equal(s.messages.length, 1);
});

test('deleteSession removes the file', async () => {
  const ws = await tmpws();
  const id = newSessionId();
  await createSession(ws, id);
  assert.equal(await deleteSession(ws, id), true);
  assert.equal(await loadSession(ws, id), null);
  assert.equal(await deleteSession(ws, id), false);
});
