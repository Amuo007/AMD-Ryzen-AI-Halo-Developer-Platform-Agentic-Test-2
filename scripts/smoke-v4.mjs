#!/usr/bin/env node
/**
 * v4 end-to-end smoke: boots the REAL bin/forge.js with a mock LLM and exercises
 * every phase-4 capability end to end: identity, reasoning, images, the browser
 * (with real Chrome when present), the card + inline screenshots, local-only
 * rule, handoff v2 (rolling memory) and the session budget.
 * Run with: node scripts/smoke-v4.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLLM, deltaChunk, textChunks, toolCallChunks, usageChunk } from '../test/helpers/mock-llm.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
function skip(name, why) {
  console.log(`  SKIP  ${name} — ${why}`);
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'halo-smoke-v4-'));
process.env.FORGE_DATA_DIR = path.join(tmp, 'data');
process.env.FORGE_CONFIG_DIR = path.join(tmp, 'config');
await fsp.mkdir(process.env.FORGE_CONFIG_DIR, { recursive: true });

let handler = () => ({ chunks: [...textChunks('ok'), deltaChunk({}, 'stop')] });
const mock = await startMockLLM((body, n) => handler(body, n));
process.env.FORGE_BASE_URL = mock.url;
process.env.FORGE_API_KEY = 'smoke-key';
process.env.FORGE_MODEL = 'mock-model';

const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'forge.js'), '--port', '0', '--no-open'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: process.env,
});
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('bin did not report a port')), 15000);
  child.stdout.on('data', (d) => {
    const m = String(d).match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  });
  child.on('exit', (c) => reject(new Error(`bin exited early (${c})`)));
});
const base = `http://127.0.0.1:${port}`;

async function req(method, pathname, body) {
  const res = await fetch(base + pathname, {
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

function sseUntil(sessionId, until, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error(`SSE timeout after ${events.length} events`)), timeoutMs);
    const r = http.get(`${base}/api/events?sessionId=${encodeURIComponent(sessionId)}`, (res) => {
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
          if (until(ev, events)) {
            clearTimeout(timer);
            r.destroy();
            resolve(events);
          }
        }
      });
    });
    r.on('error', () => {});
  });
}
async function runTurn({ sessionId, ...post }, mockForTurn) {
  if (mockForTurn) handler = mockForTurn;
  const pending = req('POST', '/api/chat', { sessionId, ...post });
  const events = await sseUntil(sessionId, (ev) => ev.type === 'turn_end');
  await pending;
  return events;
}
const U = (p, c = 10) => usageChunk({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });
const isDirective = (b) => typeof b.messages.at(-1).content === 'string' && b.messages.at(-1).content.startsWith('SYSTEM: Automatic context handoff');

const ws = await fsp.mkdtemp(path.join(tmp, 'ws-'));
console.log(`\nhalo smoke v4 — server on :${port}, workspace ${ws}\n`);

// 1. boot + branding + Halo identity
const health = await req('GET', '/api/health');
check('bin boots, /api/health ok', health.status === 200 && health.data.ok === true);
const idx = await (await fetch(base + '/')).text();
check('index.html served with Halo AI Harness branding', idx.includes('<title>Halo AI Harness</title>') && idx.includes('id="budget-banner"'));
const chatPrompt = await req('GET', '/api/prompt?mode=chat');
check('chat system prompt carries the Halo identity', /Halo/.test(chatPrompt.data.text));

// 2. reasoning medium reaches the API body
handler = () => ({ chunks: [...textChunks('medium answer'), deltaChunk({}, 'stop')] });
await runTurn({ sessionId: 's4-medium', workspace: ws, mode: 'full', reasoning: 'medium', message: 'think medium' });
const medReq = mock.requests.at(-1);
check('reasoning medium → enable_thinking + reasoning_effort=medium', JSON.stringify(medReq.chat_template_kwargs) === JSON.stringify({ enable_thinking: true, thinking: true }) && medReq.reasoning_effort === 'medium');

// 3. images: upload, attach to a chat message, stored + served
const PNG1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const up = await req('POST', '/api/images', { sessionId: 's4-img', data: PNG1, source: 'user' });
check('image upload stored', up.status === 201 && Boolean(up.data.id));
const served = await fetch(`${base}/api/images/${up.data.id}`);
check('stored image served back', served.status === 200 && (await served.arrayBuffer()).byteLength > 0);
handler = () => ({ chunks: [...textChunks('I can see the image'), deltaChunk({}, 'stop')] });
await runTurn({ sessionId: 's4-img', agentMode: 'chat', message: 'what is in this image?', images: [up.data.id] });
const s4imgSession = await req('GET', '/api/session?sessionId=s4-img');
check('message with image persisted', s4imgSession.data.session.messages.some((m) => m.role === 'user' && (m.images || []).includes(up.data.id)));
check('Chat mode sends no tools at all', mock.requests.at(-1).tools === undefined);

// 4. browser (real Chrome when available)
const { detectBrowser } = await import('../src/browser/detect.js');
const chrome = detectBrowser();
if (!chrome) {
  skip('browser loop (open/screenshot/snapshot/console/card)', 'no Chrome on this machine');
  skip('local-only rule (external refused)', 'no Chrome');
  skip('no browser tool in Chat mode', 'no Chrome (engine part)');
  skip('chrome process cleanup', 'no Chrome');
} else {
  const PAGE = `<!doctype html><html><head><title>Smoke app</title></head><body><h1>Smoke app</h1>
<button id="b" onclick="document.querySelector('h1').textContent='Clicked!'">Press</button>
<a class="ext" href="https://example.com/">out</a>
<script>console.error('broken: missing handler for demo')</script></body></html>`;
  const psrv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    s.end(PAGE);
  });
  await new Promise((r) => psrv.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${psrv.address().port}/`;
  handler = (body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user' && String(last.content).includes('check my page'))
      return { chunks: [...toolCallChunks('browser', JSON.stringify({ action: 'open', url: pageUrl })), deltaChunk({}, 'tool_calls')] };
    if (last.role === 'tool' && /Opened/.test(String(last.content)))
      return { chunks: [...toolCallChunks('browser', JSON.stringify({ action: 'screenshot' }), { id: 'sh1' }), deltaChunk({}, 'tool_calls')] };
    if (last.role === 'tool' && /Screenshot taken/.test(String(last.content)))
      return { chunks: [...textChunks('I see the page, it has one console error.'), deltaChunk({}, 'stop')] };
    return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
  };
  await req('POST', '/api/chat', { sessionId: 's4-browser', workspace: ws, mode: 'full', message: 'check my page' });
  const bev = await sseUntil('s4-browser', (ev) => ev.type === 'turn_end');
  const opens = bev.filter((e) => e.type === 'tool_end' && e.name === 'browser');
  check('browser open + screenshot tool runs', opens.length >= 2 && opens.every((e) => e.status === 'ok'), JSON.stringify(opens.map((o) => o.result)));
  check('browser_page event → card data (url/title/live)', bev.some((e) => e.type === 'browser_page' && e.url === pageUrl && e.title === 'Smoke app'));
  check('browser_screenshot event fires (inline figure)', bev.some((e) => e.type === 'browser_screenshot' && e.imageId));
  const bsession = await req('GET', '/api/session?sessionId=s4-browser');
  const msgs = bsession.data.session.messages;
  check('screenshot attached as follow-up image message', msgs.some((m) => m.name === 'forge:screenshot' && (m.images || []).length));
  check('browser card persisted for reload', msgs.some((m) => m.name === 'forge:browser-card' && /"imageId"/.test(m.content)));
  const bstate = await req('GET', '/api/browser/state?sessionId=s4-browser');
  check('panel state Live with the console error badge', bstate.data.status === 'Live' && bstate.data.consoleErrors >= 1);

  // local-only rule through the tool
  handler = () => ({ chunks: [...toolCallChunks('browser', JSON.stringify({ action: 'open', url: 'https://example.com/' }), { id: 'bad1' }), deltaChunk({}, 'tool_calls')], });
  await req('POST', '/api/chat', { sessionId: 's4-browser', workspace: ws, mode: 'full', message: 'open example.com' });
  const refused = await sseUntil('s4-browser', (ev) => ev.type === 'turn_end');
  const refusedEnd = refused.filter((e) => e.type === 'tool_end' && e.name === 'browser').at(-1);
  check('external URL refused by the local-only rule', refusedEnd?.status === 'error' && /Refusing non-local host/.test(String(refusedEnd.result)));

  // screenshot pruning in the model context: 3 shots → oldest marked removed
  handler = (body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user') return { chunks: [...toolCallChunks('browser', JSON.stringify({ action: 'screenshot' })), deltaChunk({}, 'tool_calls')] };
    if (last.role === 'tool') return { chunks: [...toolCallChunks('browser', JSON.stringify({ action: 'screenshot' }), { id: `sh${body.messages.length}` }), deltaChunk({}, 'tool_calls')] };
    return { chunks: [...textChunks('enough shots'), deltaChunk({}, 'stop')] };
  };
  await req('POST', '/api/chat', { sessionId: 's4-prune', workspace: ws, mode: 'full', message: 'take many screenshots' });
  await sseUntil('s4-prune', (ev) => ev.type === 'turn_end');
  const reqs = mock.requests.slice(-6);
  const marked = reqs.filter((b) => JSON.stringify(b.messages).includes('earlier screenshot removed'));
  check('older screenshots pruned from model context', marked.length >= 1);
  psrv.close();
}

// 5. handoff v2: rolling memory + budget
const TASK = 'Build a tiny tracker.';
let hoffN = 0;
handler = (body) => {
  const last = body.messages.at(-1);
  if (isDirective(body)) {
    hoffN += 1;
    const prev = [...body.messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('## Original task'));
    const origOf = (c) => String(c).split('## Original task\n')[1].split('\n')[0];
    const secOf = (c, t) => { const parts = String(c).split(`## ${t}\n`); return parts.length < 2 ? 'none' : parts[1].split('\n## ')[0].trim(); };
    const sum = `## Original task\n${prev ? origOf(prev.content) : TASK}\n\n## Goal\ntracker\n\n## Done\n- H${hoffN}\n\n## Earlier work (condensed)\n${prev ? `${secOf(prev.content, 'Done')} ${secOf(prev.content, 'Earlier work (condensed)')}` : 'none'}\n\n## Current state\n${hoffN}\n\n## Branches & files\n- none\n\n## Next steps\nmore\n\n## Plan / remaining todos\n- [ ] next`;
    if (hoffN < 3) return { chunks: [...textChunks(sum), deltaChunk({}, 'stop'), U(1800, 20)] };
    return { chunks: [...textChunks(sum), deltaChunk({}, 'stop'), U(1800, 20)] };
  }
  if (last.role === 'user') return { chunks: [...toolCallChunks('run_shell', JSON.stringify({ command: "printf 'y%.0s' $(seq 1 20000)" })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('ok'), deltaChunk({}, 'stop'), U(900, 5)] };
};
await req('PUT', '/api/config', { contextLimit: 8000, handoffLimit: 2000 });
for (const m of [TASK, 'go2', 'go3']) {
  await req('POST', '/api/chat', { sessionId: 's4-hoff', workspace: ws, mode: 'full', message: m });
  await sseUntil('s4-hoff', (ev) => ev.type === 'turn_end');
}
const hoffSession = await req('GET', '/api/session?sessionId=s4-hoff');
const hoffs = hoffSession.data.session.messages.filter((m) => m.name === 'forge:handoff').map((m) => m.content);
check('3 handoffs occurred', hoffs.length === 3);
check('original task survives 3 handoffs verbatim', hoffs[2]?.startsWith(`## Original task\n${TASK}`));

check('earlier work carried forward', hoffs[2]?.includes('H1') && hoffs[2]?.includes('H2'));
await req('PUT', '/api/config', { contextLimit: 140000, handoffLimit: 128000, sessionTokenBudget: 3000 });
const ctx = await req('GET', '/api/context?sessionId=s4-hoff');
check('session budget: input tokens tracked + over-budget flag', ctx.data.inputTokens > 3000 && ctx.data.budget === 3000 && ctx.data.overBudget === true);
await req('PUT', '/api/config', { sessionTokenBudget: 1000000 });

console.log(`\n${fail === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'} — ${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => ` - ${f}`).join('\n'));

child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
// after the bin exits: no Chrome may remain behind
if (chrome) {
  await new Promise((r) => setTimeout(r, 600));
  const { spawnSync } = await import('node:child_process');
  const ps = spawnSync('ps', ['axww', '-o', 'command='], { encoding: 'utf8' });
  const strays = (ps.stdout || '').split('\n').filter((l) => l.includes('forge-chrome-'));
  check('no Chrome left after the bin exits', strays.length === 0, strays.join(' | '));
}
mock.server.close();
await fsp.rm(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
