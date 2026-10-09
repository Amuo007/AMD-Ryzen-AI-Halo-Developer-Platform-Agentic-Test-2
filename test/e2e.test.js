import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-e2e-'));
process.env.FORGE_CONFIG = path.join(tmpHome, 'config.json');

const { startServer } = await import('../src/server.js');
const { startMockLLM, deltaChunk, textChunks, toolCallChunks, usageChunk } = await import('./helpers/mock-llm.js');

async function tmpws() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-e2e-ws-'));
}

/** Open an SSE connection and collect events until the predicate matches. */
function collectUntil(port, sessionId, until, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.get(
      { host: '127.0.0.1', port, path: `/api/events?sessionId=${encodeURIComponent(sessionId)}` },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m = block.match(/^data: (.*)$/m);
            if (!m) continue;
            let ev;
            try {
              ev = JSON.parse(m[1]);
            } catch {
              continue;
            }
            events.push(ev);
            if (until(ev)) {
              clearTimeout(timer);
              r.destroy();
              resolve(events);
            }
          }
        });
      }
    );
    const timer = setTimeout(() => {
      r.destroy();
      reject(new Error(`timeout waiting; events: ${events.map((e) => e.type).join(', ')}`));
    }, timeoutMs);
    r.on('error', () => {});
  });
}

test('e2e: create hello.txt then read it back (full access)', async () => {
  const ws = await tmpws();
  const mock = await startMockLLM((body) => {
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length === 0) {
      // turn 1: create the file
      return { chunks: [...toolCallChunks('write_file', JSON.stringify({ path: 'hello.txt', content: 'hello\n' }), { id: 'call_write' }), deltaChunk({}, 'tool_calls')] };
    }
    if (toolMsgs.length === 1) {
      // turn 2: read it back
      assert.match(toolMsgs[0].content, /Created hello.txt/);
      return { chunks: [...toolCallChunks('read_file', JSON.stringify({ path: 'hello.txt' }), { id: 'call_read' }), deltaChunk({}, 'tool_calls')] };
    }
    // turn 3: summarize
    assert.match(toolMsgs[1].content, /^1: hello/m);
    return { chunks: [...textChunks('Created hello.txt containing the word hello and verified its content.'), deltaChunk({}, 'stop'), usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })] };
  });
  process.env.FORGE_BASE_URL = mock.url;
  process.env.FORGE_API_KEY = 'local';
  process.env.FORGE_MODEL = 'Qwen3.8-Flash-Next-GGUF-IQ3_M';

  const { port, close } = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'e2e-hello';
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'Create hello.txt containing the word hello, then read it back', mode: 'full' }),
    });
    const eventsP = collectUntil(port, sessionId, (ev) => ev.type === 'turn_end');
    assert.equal(res.status, 202);
    const events = await eventsP;

    // the file really exists on disk with the right content
    const content = await fsp.readFile(path.join(ws, 'hello.txt'), 'utf8');
    assert.equal(content, 'hello\n');

    // the agent streamed a write, a read, and a final message
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    assert.deepEqual(toolEnds.map((e) => e.name), ['write_file', 'read_file']);
    assert.ok(toolEnds.every((e) => e.status === 'ok'));
    assert.ok(toolEnds[0].diff.some((l) => l.type === 'add' && l.text === 'hello'));
    const end = events.at(-1);
    assert.equal(end.stopped, false);
    assert.equal(end.usage.totalTokens, 120);

    // session persisted end-to-end
    const s = await fetch(`http://127.0.0.1:${port}/api/session?workspace=${encodeURIComponent(ws)}&sessionId=${sessionId}`);
    const { session } = await s.json();
    assert.equal(session.messages.length, 6); // user, asst, tool, asst, tool, asst final
    assert.equal(session.messages[0].content, 'Create hello.txt containing the word hello, then read it back');
  } finally {
    await close();
    await mock.close();
  }
});

test('e2e: max steps limit is enforced', async () => {
  await fsp.writeFile(process.env.FORGE_CONFIG, JSON.stringify({ maxSteps: 3 }));
  const ws = await tmpws();
  const mock = await startMockLLM((body) => {
    // never stop calling tools
    return { chunks: [...toolCallChunks('list_dir', JSON.stringify({ path: '.' }), { id: `call_${body.messages.filter((m) => m.role === 'assistant').length}` }), deltaChunk({}, 'tool_calls')] };
  });
  process.env.FORGE_BASE_URL = mock.url;
  const { port, close } = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'e2e-maxsteps';
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'loop forever please', mode: 'full' }),
    });
    const events = await collectUntil(port, sessionId, (ev) => ev.type === 'turn_end');
    const llmRequests = mock.requests.length;
    assert.equal(llmRequests, 3, 'exactly maxSteps LLM calls happened');
    const end = events.at(-1);
    assert.equal(end.type, 'turn_end');
    assert.equal(end.stopped, false);
  } finally {
    await close();
    await mock.close();
    await fsp.writeFile(process.env.FORGE_CONFIG, JSON.stringify({}));
  }
});

test('e2e: workspace outside check via symlink', async () => {
  const ws = await tmpws();
  const outside = await tmpws();
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'nope');
  await fsp.symlink(outside, path.join(ws, 'outlink'));
  const mock = await startMockLLM((body) => {
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length === 0) {
      return { chunks: [...toolCallChunks('read_file', JSON.stringify({ path: 'outlink/secret.txt' }), { id: 'symlink_read' }), deltaChunk({}, 'tool_calls')] };
    }
    return { chunks: [...textChunks('blocked it'), deltaChunk({}, 'stop')] };
  });
  process.env.FORGE_BASE_URL = mock.url;
  const { port, close } = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'e2e-symlink';
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'read the secret via symlink', mode: 'full' }),
    });
    const events = await collectUntil(port, sessionId, (ev) => ev.type === 'turn_end');
    const toolEnd = events.find((e) => e.type === 'tool_end');
    assert.equal(toolEnd.status, 'error');
    assert.match(toolEnd.result, /escapes workspace/);
  } finally {
    await close();
    await mock.close();
  }
});

test('e2e: AGENTS.md memory reaches the model', async () => {
  const ws = await tmpws();
  await fsp.writeFile(path.join(ws, 'AGENTS.md'), 'Always answer with the word FORGED.');
  const mock = await startMockLLM(() => ({ chunks: [...textChunks('FORGED'), deltaChunk({}, 'stop')] }));
  process.env.FORGE_BASE_URL = mock.url;
  const { port, close } = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'e2e-memory';
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'hello', mode: 'full' }),
    });
    await collectUntil(port, sessionId, (ev) => ev.type === 'turn_end');
    const firstReq = mock.requests[0];
    const systemPrompt = firstReq.messages[0];
    assert.equal(systemPrompt.role, 'system');
    assert.match(systemPrompt.content, /AGENTS\.md/);
    assert.match(systemPrompt.content, /Always answer with the word FORGED\./);
    assert.ok(firstReq.messages.some((m) => m.role === 'user' && m.content === 'hello'), 'user message reaches the model');
  } finally {
    await close();
    await mock.close();
  }
});
