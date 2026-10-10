#!/usr/bin/env node
/**
 * v3 end-to-end smoke: boots the REAL bin/forge.js with a mock LLM and exercises
 * every phase-3 capability end to end. Run with: node scripts/smoke-v3.mjs
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

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'halo-smoke-'));
process.env.FORGE_DATA_DIR = path.join(tmp, 'data');
process.env.FORGE_CONFIG_DIR = path.join(tmp, 'config');
await fsp.mkdir(process.env.FORGE_CONFIG_DIR, { recursive: true });

let handler = () => ({ chunks: [...textChunks('ok'), deltaChunk({}, 'stop')] });
const mock = await startMockLLM((body, n) => handler(body, n));
process.env.FORGE_BASE_URL = mock.url;
process.env.FORGE_API_KEY = 'smoke-key';
process.env.FORGE_MODEL = 'mock-model';

// --- boot the real binary ---
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

function sseUntil(sessionId, until, timeoutMs = 20000) {
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
async function runTurn({ sessionId, ...post }, mockForTurn, extraUntil) {
  handler = mockForTurn;
  const pending = req('POST', '/api/chat', { sessionId, ...post });
  const events = await sseUntil(sessionId, (ev) => ev.type === 'turn_end' && (extraUntil ? extraUntil(ev) : true));
  await pending;
  return events;
}
const lastText = (events) => events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');

const ws = await fsp.mkdtemp(path.join(tmp, 'ws-'));
const U = (p, c = 10) => usageChunk({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });
const isDirective = (b) => typeof b.messages.at(-1).content === 'string' && b.messages.at(-1).content.startsWith('SYSTEM: Automatic context handoff');

console.log(`\nhalo smoke — server on :${port}, workspace ${ws}\n`);

// 1. boot + branding
const health = await req('GET', '/api/health');
check('bin boots, /api/health ok', health.status === 200 && health.data.ok === true);
const idx = await (await fetch(base + '/')).text();
check('index.html served with Halo AI Harness branding', idx.includes('<title>Halo AI Harness</title>') && idx.includes('id="ctx-meter"'));

// 2. edit_file multi-edit under an ask permission
await fsp.writeFile(path.join(ws, 'a.txt'), 'AAA BBB CCC\n');
handler = (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('edit_file', JSON.stringify({ path: 'a.txt', edits: [{ old_string: 'AAA', new_string: 'X' }, { old_string: 'CCC', new_string: 'Z' }] }), { id: 'e1' }), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('edited twice'), deltaChunk({}, 'stop')] };
};
await req('POST', '/api/chat', { sessionId: 'smoke-edit', workspace: ws, message: 'edit a.txt please' });
const permEvents = await sseUntil('smoke-edit', (ev) => ev.type === 'permission_request' && ev.toolName === 'edit_file');
const permReq = permEvents.find((e) => e.type === 'permission_request' && e.toolName === 'edit_file');
check('edit_file triggers a permission request in ask mode', Boolean(permReq));
if (permReq) {
  const allowed = await req('POST', '/api/permission', { requestId: permReq.requestId, decision: 'allow' });
  check('permission allow accepted', allowed.status === 200);
}
const finalEdit = await sseUntil('smoke-edit', (ev) => ev.type === 'turn_end');
await new Promise((r) => setTimeout(r, 200));
const edited = await fsp.readFile(path.join(ws, 'a.txt'), 'utf8');
check('edit_file applied both edits in order', edited === 'X BBB Z\n', JSON.stringify(edited));
const editEnd = finalEdit.find((e) => e.type === 'tool_end' && e.name === 'edit_file');
check('tool_end carries a diff for the edit', Array.isArray(editEnd?.diff) && editEnd.diff.length > 0);

// 3. glob_files
await fsp.mkdir(path.join(ws, 'sub'), { recursive: true });
await fsp.writeFile(path.join(ws, 'sub', 'deep.js'), 'x');
const globEvents = await runTurn({ sessionId: 'smoke-glob', workspace: ws, mode: 'full', message: 'find the js files' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('glob_files', JSON.stringify({ pattern: 'sub/**' })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
});
const globEnd = globEvents.find((e) => e.type === 'tool_end' && e.name === 'glob_files');
check('glob_files finds workspace files', globEnd?.status === 'ok' && String(globEnd.result).includes('deep.js'));

// 4. search with glob + ignore_case
const searchEvents = await runTurn({ sessionId: 'smoke-search', workspace: ws, mode: 'full', message: 'search deep' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('search', JSON.stringify({ query: 'deep', glob: '*.js', ignore_case: true })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
});
const searchEnd = searchEvents.find((e) => e.type === 'tool_end' && e.name === 'search');
check('search honors glob + ignore_case', searchEnd?.status === 'ok' && String(searchEnd.result).includes('deep.js'));

// 5. background shell: run_shell background → shell_jobs → kill_shell
const bgEvents = await runTurn({ sessionId: 'smoke-bg', workspace: ws, mode: 'full', message: 'run sleep in background' }, (body) => {
  const last = body.messages.at(-1);
  const text = typeof last.content === 'string' ? last.content : '';
  if (last.role === 'user') return { chunks: [...toolCallChunks('run_shell', JSON.stringify({ command: 'sleep 30', background: true })), deltaChunk({}, 'tool_calls')] };
  if (/Started background job/.test(text)) return { chunks: [...toolCallChunks('shell_jobs', JSON.stringify({}), { id: 'j1' }), deltaChunk({}, 'tool_calls')] };
  if (last.role === 'tool' && last.name === 'shell_jobs') return { chunks: [...textChunks('job runs'), deltaChunk({}, 'stop')] };
  return { chunks: [...textChunks('done'), deltaChunk({}, 'stop')] };
});
const bgStart = bgEvents.find((e) => e.type === 'tool_end' && e.name === 'run_shell');
const jobsEnd = bgEvents.find((e) => e.type === 'tool_end' && e.name === 'shell_jobs');
check('run_shell starts a background job', bgStart?.status === 'ok' && /Started background job/.test(String(bgStart.result)));
check('shell_jobs lists the running job', jobsEnd?.status === 'ok');
const jobId = (String(bgStart?.result || '').match(/Started background job (\S+)/) || [])[1];
if (jobsEnd) {
  const killEvents = await runTurn({ sessionId: 'smoke-bg', workspace: ws, mode: 'full', message: 'kill the job' }, (body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user') return { chunks: [...toolCallChunks('kill_shell', JSON.stringify({ job_id: jobId }), { id: 'k1' }), deltaChunk({}, 'tool_calls')] };
    return { chunks: [...textChunks('killed'), deltaChunk({}, 'stop')] };
  });
  const killEnd = killEvents.find((e) => e.type === 'tool_end' && e.name === 'kill_shell');
  check('kill_shell stops the job', killEnd?.status === 'ok', JSON.stringify(killEnd?.result));
}

// 6. todo tool + todo_update event + persisted
const todoEvents = await runTurn({ sessionId: 'smoke-todo', workspace: ws, mode: 'full', message: 'track my todos' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('todo', JSON.stringify({ todos: [{ content: 'step 1', status: 'in_progress' }] })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('tracked'), deltaChunk({}, 'stop')] };
});
check('todo tool emits todo_update', todoEvents.some((e) => e.type === 'todo_update' && e.todos?.[0]?.content === 'step 1'));
const todoSession = await req('GET', '/api/session?sessionId=smoke-todo');
check('todos persist on the session', todoSession.data.session.todos?.length === 1);

// 7. skills: workspace skill discovered + use_skill loads it
const skillDir = path.join(ws, '.forge', 'skills', 'demo');
await fsp.mkdir(skillDir, { recursive: true });
await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Demo\ndescription: A demo skill\n---\nDo the demo thing exactly.\n');
const skills = await req('GET', `/api/skills?workspace=${encodeURIComponent(ws)}`);
check('workspace skill discovered', skills.data.skills.some((s) => s.id === 'demo'));
const useEvents = await runTurn({ sessionId: 'smoke-skill', workspace: ws, mode: 'full', message: 'use the demo skill' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('use_skill', JSON.stringify({ skill: 'demo' })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('skill used'), deltaChunk({}, 'stop')] };
});
const useEnd = useEvents.find((e) => e.type === 'tool_end' && e.name === 'use_skill');
check('use_skill returns the skill instructions', useEnd?.status === 'ok' && String(useEnd.result).includes('Do the demo thing'));

// 8. tool policy: disable glob_files → defs drop it, calls rejected
await req('POST', '/api/tools/enabled', { name: 'glob_files', enabled: false });
const defs = await req('GET', '/api/tools');
check('disabled tool flagged in /api/tools', defs.data.tools.find((t) => t.name === 'glob_files')?.enabled === false);
const disabledEvents = await runTurn({ sessionId: 'smoke-policy', workspace: ws, mode: 'full', message: 'try the disabled tool' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('glob_files', JSON.stringify({ pattern: '*' })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('understood'), deltaChunk({}, 'stop')] };
});
const disabledEnd = disabledEvents.find((e) => e.type === 'tool_end' && e.name === 'glob_files');
check('disabled tool call gets the policy error', disabledEnd?.status === 'error' && /disabled/.test(String(disabledEnd.result)));
await req('POST', '/api/tools/enabled', { name: 'glob_files', enabled: true });

// 9. MCP: echo tool through the configured stdio server
await fsp.writeFile(
  path.join(process.env.FORGE_CONFIG_DIR, 'mcp.json'),
  JSON.stringify({ servers: { mock: { command: process.execPath, args: [path.join(ROOT, 'test', 'helpers', 'mock-mcp-server.js')] } } })
);
const mcpDefs = await req('GET', '/api/tools');
check('MCP server tools listed', mcpDefs.data.tools.some((t) => t.name === 'mcp__mock__echo'));
const mcpEvents = await runTurn({ sessionId: 'smoke-mcp', workspace: ws, mode: 'full', message: 'echo via mcp' }, (body) => {
  const last = body.messages.at(-1);
  if (last.role === 'user') return { chunks: [...toolCallChunks('mcp__mock__echo', JSON.stringify({ text: 'hello mcp' })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('mcp ok'), deltaChunk({}, 'stop')] };
});
const mcpEnd = mcpEvents.find((e) => e.type === 'tool_end' && e.name === 'mcp__mock__echo');
check('MCP tool call round-trips', mcpEnd?.status === 'ok' && String(mcpEnd.result).includes('echo: hello mcp'));

// 10. reasoning control reaches the API body
await runTurn({ sessionId: 'smoke-reason', workspace: ws, mode: 'full', reasoning: 'off', message: 'answer directly' }, () => ({ chunks: [...textChunks('no thinking'), deltaChunk({}, 'stop')] }));
const reasonReq = mock.requests.at(-1);
check('reasoning off → chat_template_kwargs.thinking=false', JSON.stringify(reasonReq.chat_template_kwargs) === '{"thinking":false}');

// 11. prompt file override per workspace
await fsp.writeFile(path.join(ws, '.forge', 'system.md'), 'You are HALO-SMOKE-PROMPT.\n');
const promptRes = await req('GET', `/api/prompt?workspace=${encodeURIComponent(ws)}`);
check('workspace .forge/system.md wins', promptRes.data.source === 'workspace' && promptRes.data.text.includes('HALO-SMOKE-PROMPT'));
await fsp.rm(path.join(ws, '.forge', 'system.md'));

// 12. context meter: breakdown + real usage as ground truth
handler = () => ({ chunks: [...textChunks('ctx check'), deltaChunk({}, 'stop'), U(2222, 7)] });
await req('POST', '/api/chat', { sessionId: 'smoke-ctx', workspace: ws, mode: 'full', message: 'meter me' });
await sseUntil('smoke-ctx', (ev) => ev.type === 'turn_end');
const ctx = await req('GET', '/api/context?sessionId=smoke-ctx');
check('context meter reports limit + parts + actual usage', ctx.status === 200 && ctx.data.limit === 140000 && ctx.data.parts.length >= 2 && ctx.data.actual === 2222 && ctx.data.used >= 2222);

// 13. automatic handoff at the threshold
await req('PUT', '/api/config', { contextLimit: 4000, handoffLimit: 2000 });
handler = (body) => {
  const last = body.messages.at(-1);
  if (isDirective(body)) return { chunks: [...textChunks('## Goal\nsmoke\n\n## Next steps\nnone'), deltaChunk({}, 'stop'), U(1800, 30)] };
  if (last.role === 'user') return { chunks: [...toolCallChunks('run_shell', JSON.stringify({ command: "printf 'x%.0s' $(seq 1 20000)" })), deltaChunk({}, 'tool_calls')] };
  return { chunks: [...textChunks('post-handoff ok'), deltaChunk({}, 'stop'), U(300, 5)] };
};
await req('POST', '/api/chat', { sessionId: 'smoke-handoff', workspace: ws, mode: 'full', message: 'overflow me' });
const handoffEvents = await sseUntil('smoke-handoff', (ev) => ev.type === 'turn_end');
check('automatic handoff fires in code mode', handoffEvents.some((e) => e.type === 'handoff' && String(e.summary).includes('## Goal')));
const handoffSession = await req('GET', '/api/session?sessionId=smoke-handoff');
check('earlier messages survive the handoff in the session', handoffSession.data.session.messages.some((m) => m.role === 'tool' && m.name === 'run_shell'));
await req('PUT', '/api/config', { contextLimit: 140000, handoffLimit: 128000 });

// 14. feedback + stats
const msgList = await req('GET', '/api/session?sessionId=smoke-ctx');
const asst = msgList.data.session.messages.find((m) => m.role === 'assistant' && m.id);
const fb = await req('POST', '/api/feedback', { messageId: asst.id, feedback: 'up' });
const stats = await req('GET', '/api/stats?range=all');
check('feedback stored + stats aggregate', fb.status === 200 && stats.data.messages > 5);

console.log(`\n${fail === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'} — ${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => ` - ${f}`).join('\n'));

child.kill('SIGTERM');
mock.server.close();
process.exit(fail === 0 ? 0 : 1);
