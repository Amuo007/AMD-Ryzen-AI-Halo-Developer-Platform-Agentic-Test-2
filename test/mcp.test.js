import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, 'helpers', 'mock-mcp-server.js');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-'));
process.env.FORGE_CONFIG_DIR = path.join(tmp, 'global');
process.env.FORGE_DATA_DIR = path.join(tmp, 'data');
await fs.mkdir(process.env.FORGE_CONFIG_DIR, { recursive: true });

const { loadMcpConfig, mcpEnsure, mcpIsReadOnly, runMcpTool, resetMcp } = await import('../src/mcp.js');

async function writeMcpConfig(cfg) {
  await fs.writeFile(path.join(process.env.FORGE_CONFIG_DIR, 'mcp.json'), JSON.stringify(cfg, null, 2));
}

test('loadMcpConfig: global servers + workspace override + malformed entries', async () => {
  await writeMcpConfig({
    servers: {
      mock: { command: process.execPath, args: [MOCK_SERVER] },
      broken: { args: [] },
    },
  });
  const cfg = loadMcpConfig(null);
  assert.ok(cfg.mock);
  assert.equal(cfg.mock.command, process.execPath);
  assert.ok(cfg.__error__); // "broken" has no command

  const ws = await fs.mkdtemp(path.join(tmp, 'ws-'));
  await fs.mkdir(path.join(ws, '.forge'), { recursive: true });
  await fs.writeFile(path.join(ws, '.forge', 'mcp.json'), JSON.stringify({ servers: { mock: { command: 'ws-cmd' } } }));
  const merged = loadMcpConfig(ws);
  assert.equal(merged.mock.command, 'ws-cmd');
});

test('mcpEnsure connects and lists tools; runMcpTool calls them', async () => {
  await writeMcpConfig({ servers: { mock: { command: process.execPath, args: [MOCK_SERVER] } } });
  resetMcp();
  const r = await mcpEnsure(null);
  assert.equal(r.servers[0].name, 'mock');
  assert.equal(r.servers[0].status, 'running', `server status: ${r.servers[0].error}`);
  const names = r.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp__mock__echo', 'mcp__mock__fail', 'mcp__mock__slow']);
  assert.equal(mcpIsReadOnly('mcp__mock__echo'), true);
  assert.equal(mcpIsReadOnly('mcp__mock__fail'), false);
  const echo = await runMcpTool('mcp__mock__echo', { text: 'hello-mcp' });
  assert.equal(echo.ok, true);
  assert.match(echo.content, /echo: hello-mcp/);
  const fail = await runMcpTool('mcp__mock__fail', {});
  assert.equal(fail.ok, false);
  assert.match(fail.content, /always fails/);
  const bad = await runMcpTool('notmcp__x', {});
  assert.equal(bad.ok, false);
  const missing = await runMcpTool('mcp__noserver__echo', {});
  assert.equal(missing.ok, false);
  assert.match(missing.content, /not running/);
  resetMcp();
});

test('mcpEnsure: failed servers are reported and don’t break the manager', async () => {
  await writeMcpConfig({ servers: { nope: { command: '/nonexistent/binary/xyz' } } });
  resetMcp();
  const r = await mcpEnsure(null);
  assert.equal(r.tools.length, 0);
  assert.equal(r.servers[0].status, 'failed');
  assert.ok(r.servers[0].error);
  resetMcp();
});

test('mcpEnsure: disabled servers never start', async () => {
  await writeMcpConfig({ servers: { mock: { command: process.execPath, args: [MOCK_SERVER], disabled: true } } });
  resetMcp();
  const r = await mcpEnsure(null);
  assert.equal(r.tools.length, 0);
  assert.equal(r.servers.length, 0);
  resetMcp();
});

test('e2e: agent uses an MCP tool through the loop', async () => {
  await writeMcpConfig({ servers: { mock: { command: process.execPath, args: [MOCK_SERVER] } } });
  resetMcp();
  const { startMockLLM, deltaChunk, textChunks, toolCallChunks } = await import('./helpers/mock-llm.js');
  const mock = await startMockLLM((body) => {
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length === 0) {
      const names = (body.tools || []).map((t) => t.function.name);
      assert.ok(names.includes('mcp__mock__echo'), 'mcp tool offered to model');
      return { chunks: [...toolCallChunks('mcp__mock__echo', JSON.stringify({ text: 'via-agent' }), { id: 'call_mcp' }), deltaChunk({}, 'tool_calls')] };
    }
    assert.match(toolMsgs[0].content, /echo: via-agent/);
    return { chunks: [...textChunks('mcp worked'), deltaChunk({}, 'stop')] };
  });
  process.env.FORGE_BASE_URL = mock.url;
  const { startServer } = await import('../src/server.js');
  const server = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'mcp-e2e';
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: null, sessionId, agentMode: 'code', message: 'echo please', mode: 'full' }),
    });
    // code mode requires a workspace; use a tmp one
    assert.equal(res.status, 400);
    const ws = await fs.mkdtemp(path.join(tmp, 'ws-'));
    const eventsP = new Promise((resolve, reject) => {
      const events = [];
      const r = http.get({ host: '127.0.0.1', port: server.port, path: `/api/events?sessionId=${sessionId}` }, (resp) => {
        let buf = '';
        resp.setEncoding('utf8');
        resp.on('data', (d) => {
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
            if (ev.type === 'turn_end') resolve(events);
          }
        });
      });
      r.on('error', () => reject(new Error('sse error')));
      setTimeout(() => reject(new Error(`timeout; got ${events.map((e) => e.type).join(', ')}`)), 20000);
    });
    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'echo please', mode: 'full' }),
    });
    assert.equal(res2.status, 202);
    const events = await eventsP;
    const toolEnd = events.find((e) => e.type === 'tool_end' && e.name === 'mcp__mock__echo');
    assert.ok(toolEnd, 'mcp tool ran');
    assert.equal(toolEnd.status, 'ok');
  } finally {
    await server.close();
    await mock.close();
    resetMcp();
  }
});
