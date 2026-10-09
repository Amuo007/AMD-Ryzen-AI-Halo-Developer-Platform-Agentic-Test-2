import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-skills-'));
process.env.FORGE_CONFIG_DIR = path.join(tmp, 'global');
process.env.FORGE_DATA_DIR = path.join(tmp, 'data');

const { parseFrontmatter, discoverSkills, setSkillEnabled, getDisabledSkills, skillsSectionText, useSkill } = await import('../src/skills.js');

async function mkws() {
  return await fs.mkdtemp(path.join(tmp, 'ws-'));
}
async function mkSkill(dir, { name, description, body, extra = {} }) {
  await fs.mkdir(dir, { recursive: true });
  const fm = description === undefined ? `---\nname: ${name}\n---\n` : `---\nname: ${name}\ndescription: ${description}\n---\n`;
  await fs.writeFile(path.join(dir, 'SKILL.md'), `${fm}${body}`);
  for (const [f, c] of Object.entries(extra)) await fs.writeFile(path.join(dir, f), c);
}

test('parseFrontmatter: plain, quoted, missing', () => {
  const { meta, body } = parseFrontmatter('---\nname: commit-helper\ndescription: "Writes commits"\n---\nDo the thing.\n');
  assert.equal(meta.name, 'commit-helper');
  assert.equal(meta.description, 'Writes commits');
  assert.equal(body, 'Do the thing.\n');
  const noFm = parseFrontmatter('# just markdown\ncontent');
  assert.deepEqual(noFm.meta, {});
  assert.equal(noFm.body, '# just markdown\ncontent');
  const sq = parseFrontmatter(`---\nname: 'a b'\ndescription: it: works\n---\nB`);
  assert.equal(sq.meta.name, 'a b');
  assert.equal(sq.meta.description, 'it: works');
});

test('discoverSkills: global + workspace override + enabled state', async () => {
  await mkSkill(path.join(process.env.FORGE_CONFIG_DIR, 'skills', 'g1'), { name: 'G1', description: 'global one', body: 'G body' });
  await mkSkill(path.join(process.env.FORGE_CONFIG_DIR, 'skills', 'both'), { name: 'Global Both', description: 'global', body: 'gb' });
  const ws = await mkws();
  await mkSkill(path.join(ws, '.forge', 'skills', 'both'), { name: 'Workspace Both', description: 'ws wins', body: 'wb' });
  await mkSkill(path.join(ws, '.forge', 'skills', 'w1'), { name: 'W1', description: 'ws one', body: 'W body' });
  const skills = await discoverSkills({ workspace: ws });
  const both = skills.find((s) => s.id === 'both');
  assert.equal(both.source, 'workspace');
  assert.equal(both.name, 'Workspace Both');
  assert.equal(skills.length, 3);
  assert.ok(skills.every((s) => s.enabled));
  // disabled list flows through
  setSkillEnabled('g1', false);
  const skills2 = await discoverSkills({ workspace: ws });
  assert.equal(skills2.find((s) => s.id === 'g1').enabled, false);
  assert.deepEqual(getDisabledSkills(), ['g1']);
  setSkillEnabled('g1', true);
  assert.deepEqual(getDisabledSkills(), []);
});

test('skillsSectionText lists only enabled skills with descriptions', async () => {
  assert.equal(skillsSectionText([]), null);
  assert.equal(skillsSectionText([{ id: 'a', description: 'desc', enabled: false }]), null);
  const t = skillsSectionText([
    { id: 'a', description: 'first desc', enabled: true },
    { id: 'b', description: 'second desc', enabled: true },
  ]);
  assert.match(t, /## Available skills/);
  assert.match(t, /`a`: first desc/);
  assert.match(t, /use_skill/);
});

test('useSkill loads body, files and refuses bad input', async () => {
  await mkSkill(path.join(process.env.FORGE_CONFIG_DIR, 'skills', 'helper'), {
    name: 'Helper',
    description: 'helps',
    body: 'STEP ONE do it.\nSTEP TWO verify.\n',
    extra: { 'template.txt': 'TEMPLATE CONTENT' },
  });
  const r = await useSkill({}, { skill: 'helper' });
  assert.equal(r.ok, true);
  assert.match(r.content, /STEP ONE do it/);
  assert.match(r.content, /template\.txt/);
  assert.ok(!r.content.includes('name: Helper'), 'frontmatter not part of body');
  const file = await useSkill({}, { skill: 'helper', file: 'template.txt' });
  assert.equal(file.ok, true);
  assert.match(file.content, /TEMPLATE CONTENT/);
  const escape = await useSkill({}, { skill: 'helper', file: '../../../../etc/passwd' });
  assert.equal(escape.ok, false);
  assert.match(escape.content, /inside the skill folder/);
  const unknown = await useSkill({}, { skill: 'nope' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /no such skill/);
  const noId = await useSkill({}, {});
  assert.equal(noId.ok, false);
  setSkillEnabled('helper', false);
  const off = await useSkill({}, { skill: 'helper' });
  assert.equal(off.ok, false);
  assert.match(off.content, /disabled/);
  setSkillEnabled('helper', true);
});

/* ---------------- API ---------------- */

const { startServer } = await import('../src/server.js');

test('skills API: list, toggle, view', async () => {
  const server = await startServer({ port: 0, openBrowser: false });
  const base = () => `http://127.0.0.1:${server.port}`;
  try {
    let r = await fetch(`${base()}/api/skills`);
    let data = await r.json();
    assert.equal(r.status, 200);
    const helper = data.skills.find((s) => s.id === 'helper');
    assert.ok(helper);
    assert.equal(helper.description, 'helps');

    r = await fetch(`${base()}/api/skills/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'helper', enabled: false }),
    });
    assert.equal(r.status, 200);

    r = await fetch(`${base()}/api/skill?name=helper`);
    assert.equal(r.status, 404);
    data = await r.json();
    assert.match(data.content, /disabled/);

    r = await fetch(`${base()}/api/skills/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'helper', enabled: true }),
    });
    assert.equal(r.status, 200);
    r = await fetch(`${base()}/api/skill?name=helper`);
    data = await r.json();
    assert.equal(r.status, 200);
    assert.match(data.content, /STEP ONE/);

    r = await fetch(`${base()}/api/skills/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(r.status, 400);
  } finally {
    await server.close();
  }
});

/* ---------------- agent loop ---------------- */

const { startMockLLM, deltaChunk, textChunks, toolCallChunks } = await import('./helpers/mock-llm.js');

function collectUntil(port, sessionId, until, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.get({ host: '127.0.0.1', port, path: `/api/events?sessionId=${encodeURIComponent(sessionId)}` }, (res) => {
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
    });
    const timer = setTimeout(() => {
      r.destroy();
      reject(new Error(`timeout; got ${events.map((e) => e.type).join(', ')}`));
    }, timeoutMs);
    r.on('error', () => {});
  });
}

test('e2e: skills section reaches the model and use_skill loads through the loop', async () => {
  const ws = await mkws();
  await mkSkill(path.join(ws, '.forge', 'skills', 'deploy'), { name: 'Deploy', description: 'deploys the app', body: 'DEPLOY STEPS:\n1. build\n2. push\n' });
  const mock = await startMockLLM((body) => {
    const sys = body.messages.find((m) => m.role === 'system');
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length === 0) {
      assert.match(sys.content, /## Available skills/);
      assert.match(sys.content, /`deploy`: deploys the app/);
      return { chunks: [...toolCallChunks('use_skill', JSON.stringify({ skill: 'deploy' }), { id: 'call_skill' }), deltaChunk({}, 'tool_calls')] };
    }
    assert.match(toolMsgs[0].content, /DEPLOY STEPS/);
    return { chunks: [...textChunks('Following deploy steps now.'), deltaChunk({}, 'stop')] };
  });
  process.env.FORGE_BASE_URL = mock.url;
  const server = await startServer({ port: 0, openBrowser: false });
  try {
    const sessionId = 'skills-e2e';
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws, sessionId, message: 'deploy the app', mode: 'full' }),
    });
    assert.equal(res.status, 202);
    const events = await collectUntil(server.port, sessionId, (ev) => ev.type === 'turn_end');
    const toolEnd = events.find((e) => e.type === 'tool_end' && e.name === 'use_skill');
    assert.ok(toolEnd, 'use_skill executed');
    assert.equal(toolEnd.status, 'ok');
  } finally {
    await server.close();
    await mock.close();
  }
});
