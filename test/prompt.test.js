import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// isolated global config dir + data dir for this file
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-prompt-'));
process.env.FORGE_CONFIG_DIR = path.join(tmp, 'global');
process.env.FORGE_DATA_DIR = path.join(tmp, 'data');

const { resolvePrompt, promptLocations, globalAppend } = await import('../src/prompt.js');
const { buildSystemPrompt, buildChatSystemPrompt, fillIdentity } = await import('../src/memory.js');

async function mkws() {
  const dir = await fs.mkdtemp(path.join(tmp, 'ws-'));
  return dir;
}

test('default prompt comes from the repo prompt/ directory', async () => {
  const ws = await mkws();
  const r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'default');
  assert.match(r.path, /prompt[/\\]system\.md$/);
  assert.match(r.text, /Halo AI Harness/);
  assert.match(r.text, /todo/); // mentions the todo workflow
  assert.match(r.text, /background/); // mentions background shells
  const c = await resolvePrompt({ mode: 'chat' });
  assert.equal(c.source, 'default');
  assert.match(c.text, /Chat mode/);
});

test('global file overrides the default; workspace overrides global', async () => {
  const ws = await mkws();
  await fs.mkdir(process.env.FORGE_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.FORGE_CONFIG_DIR, 'system.md'), 'GLOBAL PROMPT');
  let r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'global');
  assert.equal(r.text, 'GLOBAL PROMPT');
  await fs.mkdir(path.join(ws, '.forge'), { recursive: true });
  await fs.writeFile(path.join(ws, '.forge', 'system.md'), 'WORKSPACE PROMPT');
  r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'workspace');
  assert.equal(r.text, 'WORKSPACE PROMPT');
  // chat still resolves independently
  const c = await resolvePrompt({ mode: 'chat', workspace: ws });
  assert.equal(c.source, 'default');
  await fs.writeFile(path.join(ws, '.forge', 'chat.md'), 'WORKSPACE CHAT');
  const c2 = await resolvePrompt({ mode: 'chat', workspace: ws });
  assert.equal(c2.source, 'workspace');
});

test('empty override files are skipped (fall through)', async () => {
  const ws = await mkws();
  await fs.mkdir(process.env.FORGE_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.FORGE_CONFIG_DIR, 'system.md'), 'GG');
  let r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'global');
  await fs.mkdir(path.join(ws, '.forge'), { recursive: true });
  await fs.writeFile(path.join(ws, '.forge', 'system.md'), '   \n');
  r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'global');
  await fs.rm(path.join(process.env.FORGE_CONFIG_DIR, 'system.md'));
  r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.equal(r.source, 'default');
});

test('long prompts are capped', async () => {
  const ws = await mkws();
  await fs.mkdir(path.join(ws, '.forge'), { recursive: true });
  await fs.writeFile(path.join(ws, '.forge', 'system.md'), 'x'.repeat(40000));
  const r = await resolvePrompt({ mode: 'code', workspace: ws, cap: 1000 });
  assert.ok(r.text.length < 1100);
  assert.match(r.text, /truncated/);
});

test('buildSystemPrompt appends global append.md and AGENTS.md', async () => {
  const ws = await mkws();
  await fs.writeFile(path.join(process.env.FORGE_CONFIG_DIR, 'append.md'), 'GLOBAL APPEND TEXT');
  const append = await globalAppend();
  assert.match(append, /GLOBAL APPEND TEXT/);
  const p = await buildSystemPrompt({ workspace: ws, agentsMd: 'PROJECT NOTES' });
  const appendAt = p.indexOf('GLOBAL APPEND TEXT');
  const agentsAt = p.indexOf('PROJECT NOTES');
  assert.ok(appendAt >= 0 && agentsAt >= 0);
  assert.ok(appendAt < agentsAt, 'global append before AGENTS.md');
  assert.ok(p.indexOf('GLOBAL APPEND TEXT') > p.indexOf('Halo AI Harness'), 'base first');
  const chat = await buildChatSystemPrompt();
  assert.match(chat, /GLOBAL APPEND TEXT/);
  await fs.rm(path.join(process.env.FORGE_CONFIG_DIR, 'append.md'));
});

test('promptLocations points at workspace/.forge, global dir and repo default', () => {
  const locs = promptLocations('/some/ws');
  assert.equal(locs.workspace, path.join('/some/ws', '.forge'));
  assert.equal(locs.global, process.env.FORGE_CONFIG_DIR);
  assert.match(locs.default, /prompt$/);
});

test('built prompts carry the Identity section with the real model id', async () => {
  const ws = await mkws();
  const p = await buildSystemPrompt({ workspace: ws, agentsMd: null, model: 'TestModel-42' });
  assert.match(p, /## Identity/);
  assert.match(p, /Your name is \*\*Halo\*\*/);
  assert.match(p, /Never introduce yourself as Qwen, ChatGPT, Claude/);
  assert.match(p, /run on `TestModel-42` on the\s+user's local server/, 'model id filled at build time');
  assert.ok(!p.includes('{{model}}'), 'placeholder always resolved');
  assert.match(p, /You are \*\*Halo\*\*, an autonomous coding agent/);
  const c = await buildChatSystemPrompt({ model: 'TestModel-42' });
  assert.match(c, /## Identity/);
  assert.match(c, /run on `TestModel-42` on the\s+user's local server/);
  assert.ok(!c.includes('{{model}}'));
  // default: fills from the configured model (env override)
  process.env.FORGE_MODEL = 'CfgModel-7';
  const d = await buildChatSystemPrompt();
  assert.match(d, /run on `CfgModel-7`/);
  delete process.env.FORGE_MODEL;
  // fillIdentity leaves custom prompts without the placeholder untouched
  assert.equal(fillIdentity('no placeholder here', 'M'), 'no placeholder here');
});

test('visual check loop: default Code prompt carries the verify loop, polish pass and review flow', async () => {
  const ws = await mkws();
  const r = await resolvePrompt({ mode: 'code', workspace: ws });
  assert.match(r.text, /Visual check loop/);
  assert.match(r.text, /run_shell \{ background: true \}/, 'starts the app as a background shell');
  assert.match(r.text, /browser \{ action: "open"/, 'opens the page in the browser');
  assert.match(r.text, /screenshot/);
  assert.match(r.text, /console/);
  assert.match(r.text, /reference\/mockup/, 'compares against user reference images');
  assert.match(r.text, /reload/);
  assert.match(r.text, /never say "done" on a screen you never saw/i);
  assert.match(r.text, /1–2 short lines|1-2 short lines/, 'narrates after every screenshot');
  assert.match(r.text, /Polish pass/);
  for (const item of [/overlapping or\s+cut-off text/, /spacing/, /low contrast/, /broken images/, /dead buttons/, /console errors/, /mobile/]) {
    assert.match(r.text, item);
  }
  assert.match(r.text, /instead of guessing/, 'lists remaining ideas instead of guessing');
  assert.match(r.text, /Review requests/);
  assert.match(r.text, /open localhost:3000 and\s+tell me what can be improved/);
  assert.match(r.text, /Do not\s+apply the fixes unless the user asked/, 'review-only by default');
  // the loop instruction is NOT in the chat prompt (no browser there)
  const c = await resolvePrompt({ mode: 'chat' });
  assert.ok(!/Visual check loop/.test(c.text), 'chat prompt unchanged');
});
