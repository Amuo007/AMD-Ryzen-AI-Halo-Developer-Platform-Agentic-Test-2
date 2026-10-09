import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// isolated config + point the agent at a mock LLM
const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-api-'));
process.env.FORGE_DATA_DIR = tmpHome;

const { startServer } = await import('../src/server.js');
const { getSetting } = await import('../src/db.js');
const { startMockLLM, deltaChunk, textChunks, toolCallChunks, usageChunk } = await import('./helpers/mock-llm.js');

let forge;
let mock;

let mockHandler = () => ({ chunks: [...textChunks('ok'), deltaChunk({}, 'stop')] });

test('setup: forge + mock llm', async () => {
  mock = await startMockLLM((body, n) => mockHandler(body, n));
  process.env.FORGE_BASE_URL = mock.url;
  process.env.FORGE_API_KEY = 'local';
  process.env.FORGE_MODEL = 'mock-model';
  forge = await startServer({ port: 0, openBrowser: false });
  assert.ok(forge.port > 0);
});

const base = () => `http://127.0.0.1:${forge.port}`;

async function get(pathname) {
  const res = await fetch(base() + pathname);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}
async function req(method, pathname, body) {
  const res = await fetch(base() + pathname, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** SSE client over raw http: collects events until `until(ev)` returns true or timeout. */
function sseCollect({ sessionId, until, timeoutMs = 15000, onEvent }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const reqHeaders = {};
    if (until.__lastEventId) reqHeaders['Last-Event-ID'] = String(until.__lastEventId);
    const r = http.get(
      { host: '127.0.0.1', port: forge.port, path: `/api/events?sessionId=${encodeURIComponent(sessionId)}`, headers: reqHeaders },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const idMatch = block.match(/^id: (\d+)$/m);
            const dataMatch = block.match(/^data: (.*)$/m);
            if (!dataMatch) continue;
            let ev;
            try {
              ev = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }
            ev.__id = Number(idMatch?.[1] ?? 0);
            events.push(ev);
            onEvent?.(ev);
            if (until(ev)) {
              r.destroy();
              resolve(events);
            }
          }
        });
        res.on('close', () => {
          if (!until.__done) reject(new Error(`SSE closed before condition (${events.length} events: ${events.map((e) => e.type).join(',')})`));
        });
      }
    );
    r.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && !until.__done) reject(err);
    });
    setTimeout(() => {
      until.__done = true;
      r.destroy();
      reject(new Error(`SSE timeout after ${timeoutMs}ms, got ${events.map((e) => e.type).join(',')} `));
    }, timeoutMs);
  });
}

test('chat mode: no workspace, streams a plain answer, persists as chat conversation', async () => {
  const sessionId = 'apitest-chat';
  mockHandler = (body) => {
    const sys = body.messages.find((m) => m.role === 'system');
    assert.match(sys.content, /Chat mode/);
    assert.ok(!('tools' in body), 'chat requests send no tools array');
    return { chunks: [...textChunks('A plain chat answer.'), deltaChunk({}, 'stop'), usageChunk({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 })] };
  };
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  const chat = await req('POST', '/api/chat', { sessionId, agentMode: 'chat', message: 'hello there' });
  assert.equal(chat.status, 202);
  const events = await sseCollect({ sessionId, until: untilEnd });
  assert.ok(events.some((e) => e.type === 'user' && e.agentMode === 'chat'));
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  assert.equal(text, 'A plain chat answer.');
  assert.ok(!events.some((e) => e.type === 'tool_start' || e.type === 'permission_request'), 'chat runs no tools/permissions');
  const s = await req('GET', `/api/session?sessionId=${sessionId}`);
  assert.equal(s.status, 200);
  assert.equal(s.data.session.mode, 'chat');
  assert.equal(s.data.session.workspace, null);
  assert.equal(s.data.session.title, 'hello there');
  const chatList = await req('GET', '/api/sessions?mode=chat');
  assert.ok(chatList.data.sessions.some((x) => x.id === sessionId));
});

test('chat mode: a stray tool_call from the model is never executed', async () => {
  const sessionId = 'apitest-chat-tool';
  mockHandler = () => ({ chunks: [...toolCallChunks('write_file', JSON.stringify({ path: 'nope.txt', content: 'x' })), deltaChunk({}, 'tool_calls')] });
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  await req('POST', '/api/chat', { sessionId, agentMode: 'chat', message: 'make me a file' });
  const events = await sseCollect({ sessionId, until: untilEnd });
  assert.ok(!events.some((e) => e.type === 'tool_start'), 'chat must not run tool calls');
});

test('code mode still requires a valid workspace', async () => {
  const missing = await req('POST', '/api/chat', { sessionId: 'apitest-code-nows', agentMode: 'code', message: 'hi', workspace: '/does/not/exist-xyz' });
  assert.equal(missing.status, 400);
  const noWs = await req('POST', '/api/chat', { sessionId: 'apitest-code-none', message: 'hi' });
  assert.equal(noWs.status, 400);
});

test('stats endpoint aggregates sessions/messages/tokens', async () => {
  const st = await req('GET', '/api/stats?range=all');
  assert.equal(st.status, 200);
  assert.equal(typeof st.data.sessions, 'number');
  assert.equal(typeof st.data.messages, 'number');
  assert.equal(typeof st.data.totalTokens, 'number');
  assert.ok(Array.isArray(st.data.heatmap));
  assert.ok(typeof st.data.user === 'string' && st.data.user.length > 0);
  // we have run chat + full tool sessions already, so counts are > 0
  assert.ok(st.data.sessions >= 2, `sessions=${st.data.sessions}`);
  assert.ok(st.data.messages >= 2);
  assert.ok(st.data.totalTokens >= 11);
  const bad = await req('GET', '/api/stats?range=bogus');
  assert.equal(bad.data.range, 'all');
});

test('feedback: thumbs up/down stored on a message id', async () => {
  const sessionId = 'apitest-feedback';
  mockHandler = () => ({ chunks: [...textChunks('an answer to rate'), deltaChunk({}, 'stop')] });
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  await req('POST', '/api/chat', { sessionId, agentMode: 'chat', message: 'rate me' });
  const events = await sseCollect({ sessionId, until: untilEnd });
  const mid = events.find((e) => e.type === 'message_end')?.messageId;
  assert.ok(mid, 'assistant message has an id');
  const up = await req('POST', '/api/feedback', { messageId: mid, feedback: 'up' });
  assert.equal(up.status, 200);
  let s = await req('GET', `/api/session?sessionId=${sessionId}`);
  const asst = s.data.session.messages.find((m) => m.role === 'assistant');
  assert.equal(asst.feedback, 'up');
  await req('POST', '/api/feedback', { messageId: mid, feedback: 'down' });
  s = await req('GET', `/api/session?sessionId=${sessionId}`);
  assert.equal(s.data.session.messages.find((m) => m.role === 'assistant').feedback, 'down');
  await req('POST', '/api/feedback', { messageId: mid, feedback: null });
  s = await req('GET', `/api/session?sessionId=${sessionId}`);
  assert.equal(s.data.session.messages.find((m) => m.role === 'assistant').feedback, null);
});

test.after(async () => {
  await forge?.close();
  await mock?.close();
});

test('static: index, css, js served', async () => {
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.type, /text\/html/);
  assert.match(idx.body, /forge/);
  assert.match(idx.body, /id="messages"/);
  assert.match(idx.body, /id="new-chat"/);
  assert.match(idx.body, /id="settings-btn"/);
  assert.match(idx.body, /id="mode-select"/);
  assert.match(idx.body, /id="stop-btn"/);
  assert.match(idx.body, /id="theme-toggle"/);
  const css = await get('/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
});

test('static: unknown file 404, traversal blocked', async () => {
  assert.equal((await get('/nope.txt')).status, 404);
  const trav = await get('/../package.json');
  assert.ok(trav.status === 403 || trav.status === 404);
});

test('health + config endpoints', async () => {
  const h = await req('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  const c = await req('GET', '/api/config');
  assert.equal(c.status, 200);
  assert.equal(c.data.baseURL, mock.url);
  assert.equal(c.data.model, 'mock-model');
  assert.equal(c.data.apiKey, undefined, 'raw key must not be in the response');
  assert.equal(c.data.apiKeyMasked, '••••••••'); // short keys mask fully
  assert.equal(c.data.hasApiKey, true);
  const u = await req('PUT', '/api/config', { model: 'mock-model-2', maxSteps: 7 });
  assert.equal(u.status, 200);
  assert.equal(u.data.model, 'mock-model', 'env FORGE_MODEL keeps overriding the saved model');
  assert.equal(u.data.maxSteps, 7);
  assert.equal(getSetting('model'), 'mock-model-2', 'saved model persists in the database');
});

test('sessions endpoints on empty workspace', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-apisess-'));
  const list = await req('GET', `/api/sessions?workspace=${encodeURIComponent(ws)}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.sessions, []);
  const missing = await req('GET', `/api/session?workspace=${encodeURIComponent(ws)}&sessionId=nope`);
  assert.equal(missing.status, 404);
  const badWs = await req('GET', `/api/sessions?workspace=${encodeURIComponent('/does/not/exist-xyz')}`);
  assert.equal(badWs.status, 400);
});

test('browse lists directories', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-browse-'));
  await fsp.mkdir(path.join(ws, 'sub-dir'));
  const b = await req('GET', `/api/browse?path=${encodeURIComponent(ws)}`);
  assert.equal(b.status, 200);
  assert.ok(b.data.dirs.includes('sub-dir'));
  assert.ok(b.data.home.length > 1);
});

test('chat full access: mock tool call creates a file, session persisted', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-chat-'));
  const sessionId = 'apitest-full';
  mockHandler = (body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      return { chunks: [...toolCallChunks('write_file', JSON.stringify({ path: 'made-by-agent.txt', content: 'hi from agent\n' })), deltaChunk({}, 'tool_calls'), usageChunk({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })] };
    }
    return { chunks: [...textChunks('I created the file.'), deltaChunk({}, 'stop'), usageChunk({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 })] };
  };
  const untilEnd = (ev) => {
    if (ev.type === 'turn_end') {
      untilEnd.__done = true;
      return true;
    }
    return false;
  };
  const chat = await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'create the file', mode: 'full' });
  assert.equal(chat.status, 202);
  const events = await sseCollect({ sessionId, until: untilEnd });
  assert.ok(events.some((e) => e.type === 'user'));
  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.equal(toolEnd.name, 'write_file');
  assert.equal(toolEnd.status, 'ok');
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.usage.total_tokens, 7);
  const content = await fsp.readFile(path.join(ws, 'made-by-agent.txt'), 'utf8');
  assert.equal(content, 'hi from agent\n');
  // session persisted in the database
  const s = await req('GET', `/api/session?sessionId=${sessionId}`);
  assert.equal(s.status, 200);
  assert.equal(s.data.session.messages.length, 4); // user, assistant+tool_call, tool, assistant final
  assert.equal(s.data.session.workspace, await fsp.realpath(ws));
  assert.equal(s.data.session.mode, 'code');
  const listed = await req('GET', `/api/sessions?workspace=${encodeURIComponent(ws)}`);
  assert.equal(listed.data.sessions.length, 1);
  assert.equal(listed.data.sessions[0].id, sessionId);
});


test('chat ask mode: permission request blocks until allowed', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-ask-'));
  const sessionId = 'apitest-ask';
  mockHandler = (body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return { chunks: toolCallChunks('write_file', JSON.stringify({ path: 'allowed.txt', content: 'x' })) };
    return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
  };
  let permEvent = null;
  const untilPerm = (ev) => {
    if (ev.type === 'permission_request') {
      permEvent = ev;
      untilPerm.__done = true;
      return true;
    }
    return false;
  };
  const chatRes = await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'write allowed.txt', mode: 'ask' });
  assert.equal(chatRes.status, 202);
  const permP = sseCollect({ sessionId, until: untilPerm });
  await permP;
  assert.equal(permEvent.toolName, 'write_file');
  await new Promise((r) => setTimeout(r, 150));
  await fsp.access(path.join(ws, 'allowed.txt')).then(
    () => assert.fail('file should not exist before permission is granted'),
    () => {}
  );
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  const endP = sseCollect({ sessionId, until: untilEnd });
  const ans = await req('POST', '/api/permission', { requestId: permEvent.requestId, decision: 'allow' });
  assert.equal(ans.status, 200);
  await endP;
  assert.ok(await fsp.readFile(path.join(ws, 'allowed.txt'), 'utf8').catch(() => null));
});

test('chat deny: file not created, status denied, deny-list blocked in full mode', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-deny-'));
  const sessionId = 'apitest-deny';
  mockHandler = (body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return { chunks: toolCallChunks('write_file', JSON.stringify({ path: 'denied.txt', content: 'x' })) };
    return { chunks: [...textChunks('ok i will not'), deltaChunk({}, 'stop')] };
  };
  let perm = null;
  const untilPerm = (ev) => ev.type === 'permission_request' && ((perm = ev), (untilPerm.__done = true), true);
  const denyChat = await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'write denied.txt', mode: 'ask' });
  assert.equal(denyChat.status, 202);
  const permP = sseCollect({ sessionId, until: untilPerm });
  await permP;
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  const endP = sseCollect({ sessionId, until: untilEnd });
  await req('POST', '/api/permission', { requestId: perm.requestId, decision: 'deny' });
  const events = await endP;
  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.equal(toolEnd.status, 'denied');
  await assert.rejects(fsp.access(path.join(ws, 'denied.txt')));
});

test('invalid tool-call JSON is returned to the model, agent keeps going', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-badjson-'));
  const sessionId = 'apitest-badjson';
  mockHandler = (body) => {
    const toolResults = body.messages.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) {
      return { chunks: [{ ...deltaChunk({ tool_calls: [{ index: 0, id: 'bad1', type: 'function', function: { name: 'write_file', arguments: '{"path": broken' } }] }, 'tool_calls') } ] };
    }
    if (toolResults.length === 1) {
      assert.match(toolResults[0].content, /invalid tool-call JSON/);
      return { chunks: [...toolCallChunks('write_file', JSON.stringify({ path: 'fixed.txt', content: 'ok' })), deltaChunk({}, 'tool_calls')] };
    }
    return { chunks: [...textChunks('all good'), deltaChunk({}, 'stop')] };
  };
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'go', mode: 'full' });
  const endP = sseCollect({ sessionId, until: untilEnd });
  const events = await endP;
  const bad = events.find((e) => e.type === 'tool_end' && e.callId === 'bad1');
  assert.equal(bad.status, 'error');
  assert.ok(await fsp.readFile(path.join(ws, 'fixed.txt'), 'utf8').catch(() => null));
});

test('stop: cancels a running shell command', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-stop-'));
  const sessionId = 'apitest-stop';
  mockHandler = (body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return { chunks: toolCallChunks('run_shell', JSON.stringify({ command: 'sleep 30', timeout_ms: 25000 })) };
    return { chunks: [...textChunks('should not get here before stop'), deltaChunk({}, 'stop')] };
  };
  const untilTool = (ev) => ev.type === 'tool_start' && ev.name === 'run_shell' && ((untilTool.__done = true), true);
  await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'run sleep', mode: 'full' });
  const toolP = sseCollect({ sessionId, until: untilTool });
  await toolP;
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  const endP = sseCollect({ sessionId, until: untilEnd });
  const stopRes = await req('POST', '/api/stop', { sessionId });
  assert.equal(stopRes.status, 200);
  const events = await endP;
  const end = events.at(-1);
  assert.equal(end.stopped, true);
  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.ok(toolEnd);
});

test('concurrent chat on same session gets 409', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-409-'));
  const sessionId = 'apitest-409';
  mockHandler = (body) => {
    const hasText = body.messages.some((m) => m.role === 'assistant' && m.content);
    if (!hasText) return { chunks: [{ delay: 1500, ...deltaChunk({ role: 'assistant' }) }, ...textChunks('slow answer', 1), deltaChunk({}, 'stop')] };
    return { chunks: [...textChunks('second'), deltaChunk({}, 'stop')] };
  };
  const untilEnd = (ev) => ev.type === 'turn_end' && ((untilEnd.__done = true), true);
  await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'slow one', mode: 'full' });
  const endP = sseCollect({ sessionId, until: untilEnd, timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 300));
  const second = await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'while busy', mode: 'full' });
  assert.equal(second.status, 409);
  await endP;
});

test('reconnect replays missed events (Last-Event-ID)', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-recon-'));
  const sessionId = 'apitest-recon';
  mockHandler = (body) => {
    const hasText = body.messages.some((m) => m.role === 'assistant' && m.content);
    if (!hasText) return { chunks: [...textChunks('streaming slowly', 4), { delay: 800, ...deltaChunk({}, 'stop') }] };
    return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
  };
  // first connection: read a few events then disconnect
  const firstIds = [];
  const untilThree = (ev) => {
    firstIds.push(ev.__id);
    if (firstIds.length >= 3) {
      untilThree.__done = true;
      return true;
    }
    return false;
  };
  await req('POST', '/api/chat', { workspace: ws, sessionId, message: 'stream please', mode: 'full' });
  await sseCollect({ sessionId, until: untilThree, timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 500)); // more events arrive while disconnected
  // reconnect from where we left off
  const lastId = firstIds.at(-1);
  const untilEndRecon = (ev) => {
    if (ev.type === 'turn_end') {
      untilEndRecon.__done = true;
      return true;
    }
    return false;
  };
  untilEndRecon.__lastEventId = lastId;
  const replayed = await sseCollect({ sessionId, until: untilEndRecon, timeoutMs: 12000 });
  assert.ok(replayed.length > 0, 'replayed some events');
  const firstReplayed = replayed[0].__id;
  assert.ok(firstReplayed > lastId, `first replayed id ${firstReplayed} should be after ${lastId}`);
});
