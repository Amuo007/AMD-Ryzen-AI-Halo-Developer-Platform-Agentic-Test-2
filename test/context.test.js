import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, messageTokens, contextTokens, trimContext, contextBreakdown } from '../src/context.js';
import { loadAgentsMd, buildSystemPrompt } from '../src/memory.js';

test('token estimation is chars/4 rounded up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('message and context tokens', () => {
  assert.equal(messageTokens({ role: 'user', content: 'a'.repeat(40) }), 10);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(400) },
  ];
  assert.equal(contextTokens(msgs), 1 + 100);
});

test('under the limit: no change', () => {
  const msgs = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'hello' },
  ];
  const out = trimContext(msgs, 100000);
  assert.deepEqual(out, msgs);
});

test('old tool outputs shrink first', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(8000) },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'next task' },
  ];
  const out = trimContext(msgs, 600);
  assert.equal(out.length, msgs.length, 'no messages should be dropped');
  assert.ok(out[3].content.length <= 880);
  assert.match(out[3].content, /shrunk/);
});

test('drops oldest turns when shrinking is not enough, keeping system + last user message', () => {
  const msgs = [
    { role: 'system', content: 'system prompt here' },
    { role: 'user', content: 'first question with a fair bit of text to make it heavy' },
    { role: 'assistant', content: 'first answer with a fair bit of text to make it heavy too' },
    { role: 'user', content: 'second question with a fair bit of text to make it heavier' },
    { role: 'assistant', content: 'second answer with a fair bit of text to make it heavier' },
    { role: 'user', content: 'latest user message' },
  ];
  const out = trimContext(msgs, 12);
  assert.equal(out[0].role, 'system');
  assert.equal(out.at(-1).content, 'latest user message');
  assert.ok(!out.some((m) => m.content === 'first question with a fair bit of text to make it heavy'));
  assert.ok(contextTokens(out) <= 12 + estimateTokens(out[0].content)); // only protected messages left
});

test('dropping an assistant with tool_calls drops its tool results too', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ra' },
    { role: 'tool', tool_call_id: 'b', content: 'rb' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'q2 keep me please' },
  ];
  const out = trimContext(msgs, 5);
  const roles = out.map((m) => m.role);
  assert.ok(!roles.includes('tool'), 'tool results dropped with their assistant turn');
  assert.deepEqual(out.map((m) => m.content), ['s', 'q2 keep me please']);
});

test('trimContext does not mutate input', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'tool', tool_call_id: 'c', content: 'x'.repeat(5000) },
  ];
  const before = JSON.stringify(msgs);
  trimContext(msgs, 10);
  assert.equal(JSON.stringify(msgs), before);
});

test('loadAgentsMd returns null without file, text with file', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mem-'));
  assert.equal(await loadAgentsMd(ws), null);
  await fs.writeFile(path.join(ws, 'AGENTS.md'), '# Rules\nUse tabs.\n');
  assert.equal(await loadAgentsMd(ws), '# Rules\nUse tabs.\n');
});

test('loadAgentsMd truncates huge files', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mem-'));
  await fs.writeFile(path.join(ws, 'AGENTS.md'), 'x'.repeat(40000));
  const text = await loadAgentsMd(ws);
  assert.ok(text.length <= 32100);
  assert.match(text, /truncated/);
});

test('buildSystemPrompt includes workspace and AGENTS.md section', async () => {
  const p = await buildSystemPrompt({ workspace: '/tmp/ws', agentsMd: 'Use tabs.' });
  assert.match(p, /forge/);
  assert.match(p, /\/tmp\/ws/);
  assert.match(p, /AGENTS\.md/);
  assert.match(p, /Use tabs\./);
  const p2 = await buildSystemPrompt({ workspace: '/tmp/ws', agentsMd: null });
  assert.doesNotMatch(p2, /Project instructions/);
});

test('contextBreakdown: parts, estimate and real-usage ground truth', () => {
  const sys = 'S'.repeat(400); // 100 tokens
  const skills = 'K'.repeat(80); // 20 tokens
  const defs = [{ type: 'function', function: { name: 'read_file', description: 'reads' } }];
  const messages = [
    { role: 'system', content: 'should be skipped' },
    { role: 'user', content: 'u'.repeat(400) },
    { role: 'assistant', content: 'a'.repeat(200) },
    { role: 'tool', tool_call_id: 'c', content: 't'.repeat(400) },
  ];
  const bd = contextBreakdown({ systemPrompt: sys, skillsSection: skills, toolDefs: defs, messages });
  const byLabel = Object.fromEntries(bd.parts.map((p) => [p.label, p.tokens]));
  assert.equal(byLabel['System prompt'], 100, 'skills text is subtracted from the system prompt part');
  assert.equal(byLabel['Skills (names + descriptions)'], 20);
  assert.ok(byLabel['Tool definitions'] > 0);
  assert.equal(byLabel['Your messages'], 100);
  assert.equal(byLabel['Model replies'], 50);
  assert.equal(byLabel['Tool results'], 100);
  assert.equal(bd.actual, null);
  assert.equal(bd.estimate, bd.parts.reduce((n, p) => n + p.tokens, 0));
  assert.equal(bd.used, bd.estimate, 'without usage the estimate is used');

  const withActual = contextBreakdown({
    systemPrompt: sys, skillsSection: skills, toolDefs: defs, messages,
    actualPromptTokens: 5000, sinceActual: [{ role: 'user', content: 'n'.repeat(40) }],
  });
  assert.equal(withActual.actual, 5000);
  assert.equal(withActual.used, 5010, 'actual usage + estimate of anything appended after it');
});

test('contextBreakdown: null skills, empty everything', () => {
  const bd = contextBreakdown({ systemPrompt: '', skillsSection: null, toolDefs: [], messages: [] });
  assert.deepEqual(bd.parts, []);
  assert.equal(bd.used, 0);
});
