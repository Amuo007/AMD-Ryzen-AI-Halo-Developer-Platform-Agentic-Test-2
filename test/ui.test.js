import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = (f) => fs.readFileSync(path.join(process.cwd(), 'public', f), 'utf8');

test('tool cards: collapsible card with name, args, status, result and red/green diff', () => {
  const app = pub('app.js');
  assert.match(app, /buildToolCard/);
  assert.match(app, /tool-status/);
  assert.match(app, /diff-line/);
  const css = pub('styles.css');
  assert.match(css, /\.diff-line\.add/);
  assert.match(css, /\.diff-line\.del/);
  assert.match(pub('index.html'), /id="messages"/);
});

test('permission dialog: allow / deny / always-allow buttons exist', () => {
  const app = pub('app.js');
  assert.match(app, /renderPermission/);
  assert.match(app, /'Always allow this tool'/);
  assert.match(app, /'Allow'/);
  assert.match(app, /'Deny'/);
});

test('stop button + Esc shortcut exist and target /api/stop', () => {
  const html = pub('index.html');
  const app = pub('app.js');
  assert.match(html, /id="stop-btn"/);
  assert.match(app, /\/api\/stop/);
  assert.match(app, /Escape/);
});

test('permission mode selector with ask/auto-edit/full exists in composer', () => {
  const html = pub('index.html');
  assert.match(html, /id="mode-select"/);
  assert.match(html, /value="ask"/);
  assert.match(html, /value="auto-edit"/);
  assert.match(html, /value="full"/);
});

test('dark and light themes defined, light default, toggle wired', () => {
  const css = pub('styles.css');
  assert.match(css, /\[data-theme='dark'\]/);
  assert.match(css, /\[data-theme='light'\]/);
  const app = pub('app.js');
  assert.match(app, /applyTheme/);
  assert.match(pub('index.html'), /data-theme="light"/);
});

test('mode switch: chat and code buttons, per-conversation mode applied on open', () => {
  const html = pub('index.html');
  const app = pub('app.js');
  assert.match(html, /id="mode-chat-btn"/);
  assert.match(html, /id="mode-code-btn"/);
  assert.match(app, /setAgentMode/);
  // switching persists and passes agentMode to the API
  assert.match(app, /agentMode: state\.agentMode/);
  assert.match(app, /localStorage\.setItem\('forge-agent-mode'/);
  // opening a session adopts its stored mode
  assert.match(app, /setAgentMode\(session\.mode/);
});

test('greeting screens: chat "Good <time>" and code "What\'s up next"', () => {
  const app = pub('app.js');
  assert.match(app, /renderWelcome/);
  assert.match(app, /Good \$\{greetingWord\(\)\}/);
  assert.match(app, /What's up next\$\{name \? ', ' \+ name : ''\}\?/);
  assert.match(app, /displayName/);
  assert.match(app, /class: 'greeting'/);
});

test('runtime: app boots headlessly and chat welcome renders without throwing', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    assert.deepEqual(app.rejections.map((e) => String(e?.stack || e)), [], 'app.js must not throw during init');
    const texts = app.els.get('#messages').texts();
    assert.ok(texts.some((t) => /^Good (morning|afternoon|evening), /.test(t)), `chat welcome missing: ${JSON.stringify(texts)}`);
  } finally {
    app.done();
  }
});

test('mascot: SVG art in composer + CSS animations for all 5 states', () => {
  const html = pub('index.html');
  assert.match(html, /<svg id="mascot"/);
  assert.match(html, /data-state="idle"/);
  for (const part of ['m-halo', 'm-body', 'm-head', 'm-eyes', 'm-mouth', 'composer-row', 'composer-main'])
    assert.ok(html.includes(part), `mascot part missing: ${part}`);
  const css = pub('styles.css');
  for (const st of ['idle', 'typing', 'waiting', 'thinking', 'talking'])
    assert.match(css, new RegExp(`#mascot\\[data-state="${st}"\\]`));
  for (const kf of ['m-breathe', 'm-blink', 'm-trot', 'm-dart', 'm-think-tilt', 'm-talk', 'm-halo-throw', 'm-throw-arm'])
    assert.match(css, new RegExp(`@keyframes ${kf}`));
  assert.match(css, /prefers-reduced-motion/);
});

test('mascot frisbee: halo throws out + back on a loop while the answer generates, stops when idle', () => {
  const css = pub('styles.css');
  // throw loop on every generating state
  for (const st of ['waiting', 'thinking', 'talking']) {
    assert.match(css, new RegExp(`data-state="${st}"\\] \\.m-halo[^}]*\\{[^}]*m-halo-throw`));
    assert.match(css, new RegExp(`data-state="${st}"\\] \\.m-arm-r[^}]*\\{[^}]*m-throw-arm`));
  }
  // the throw leaves the head and comes back: starts/ends at the head, mid-flight translated out, scale-flipped (frisbee)
  const kf = css.match(/@keyframes m-halo-throw \{([\s\S]*?)\n\}/);
  assert.ok(kf, 'm-halo-throw keyframes missing');
  const body = kf[1];
  assert.match(body, /0%, 100% \{ transform: translate\(0, 0\)/, 'returns to the head');
  assert.match(body, /translate\(28px, -14px\)/, 'flies out');
  assert.match(body, /scale\(1, 0\.3\)/, 'flips edge-on mid-flight');
  // idle/typing keep calm halos (no throw) so the loop ends with the turn
  assert.ok(!/#mascot\[data-state="idle"\][^}]*m-halo-throw/.test(css));
  assert.ok(!/#mascot\[data-state="typing"\][^}]*m-halo-throw/.test(css));
  // arms pivot from the shoulder; reduced motion still kills everything
  assert.match(css, /#mascot \.m-halo, #mascot \.m-head[^{]*#mascot \.m-arm \{ transform-box: fill-box/);
  assert.match(css, /#mascot \.m-arm \{ transform-origin/);
});

test('runtime: mascot state machine switches with app events', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    const svg = app.els.get('#mascot');
    const st = () => svg.getAttribute('data-state') || app.api.mascot.state;
    assert.equal(app.api.mascot.state, 'idle');
    // typing
    app.els.get('#input').value = 'hello there';
    app.fire(app.els.get('#input'), 'input');
    assert.equal(st(), 'typing');
    // send -> waiting
    app.fire(app.els.get('#send-btn'), 'click');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(st(), 'waiting');
    assert.equal(app.api.state.running, true);
    // reasoning -> thinking
    app.api.renderEvent({ type: 'reasoning_delta', text: 'hmm ' });
    assert.equal(st(), 'thinking');
    // answer text -> talking
    app.api.renderEvent({ type: 'text_delta', text: 'hi!' });
    assert.equal(st(), 'talking');
    // done -> idle
    app.api.renderEvent({ type: 'turn_end' });
    assert.equal(st(), 'idle');
    // permission request -> waiting
    app.api.renderEvent({ type: 'permission_request', requestId: 'r1', toolName: 'run_shell', description: 'do a thing' });
    assert.equal(st(), 'waiting');
    app.api.renderEvent({ type: 'turn_end' });
    // typing calms back to idle after ~1.5 s of no keystrokes
    app.els.get('#input').value = 'typing again';
    app.fire(app.els.get('#input'), 'input');
    assert.equal(st(), 'typing');
    await new Promise((r) => setTimeout(r, 1650));
    assert.equal(st(), 'idle');
    assert.deepEqual(app.rejections.map((e) => String(e?.stack || e)), [], 'no unhandled rejections during state switches');
  } finally {
    app.done();
  }
});

test('stats dashboard: tabs, range selector, tiles and heatmap', () => {
  const app = pub('app.js');
  assert.match(app, /\/api\/stats/);
  assert.match(app, /Stats|stats-tab/);
  assert.match(app, /renderHeatmap/);
  assert.match(app, /heat-cell/);
  assert.match(app, /Favorite model/);
  assert.match(app, /Peak hour/);
  const css = pub('styles.css');
  assert.match(css, /\.stats-card/);
  assert.match(css, /\.heat-cell/);
});

test('markdown rendering: headings, lists, bold/italic, inline code, links, fences, escaping', () => {
  const app = pub('app.js');
  assert.match(app, /function renderMarkdown/);
  assert.match(app, /function renderText/);
  assert.match(app, /inlineMd/);
  assert.match(app, /function esc\(/);
});

test('assistant message actions: copy, thumbs up/down, and feedback posts', () => {
  const app = pub('app.js');
  assert.match(app, /msg-actions/);
  assert.match(app, /navigator\.clipboard/);
  assert.match(app, /\/api\/feedback/);
  assert.match(app, /function rate/);
});

test('aggregate edit summary card: edited N files with +add / -del per file', () => {
  const app = pub('app.js');
  assert.match(app, /renderEditsSummary/);
  assert.match(app, /edits-card/);
  assert.match(app, /Edited \$\{list\.length\}/);
  assert.match(app, /Show \$\{rest\.length\} more/);
  assert.match(app, /function langOf/);
  const css = pub('styles.css');
  assert.match(css, /\.edits-card/);
  assert.match(css, /\.edits-more/);
});

test('date-grouped session list: Today / Yesterday / dated groups with delete', () => {
  const app = pub('app.js');
  assert.match(app, /dateBucket/);
  assert.match(app, /'Today'/);
  assert.match(app, /'Yesterday'/);
  assert.match(app, /removeSession/);
  assert.match(app, /s-del/);
});

test('composer: textarea, send + stop, scroll-to-bottom button', () => {
  const html = pub('index.html');
  assert.match(html, /id="input"/);
  assert.match(html, /id="send-btn"/);
  assert.match(html, /id="scroll-bottom"/);
  const app = pub('app.js');
  assert.match(app, /autosize/);
});

test('todo panel: html container, renderTodos + todo_update event wired', () => {
  const html = pub('index.html');
  assert.match(html, /id="todo-panel"/);
  const app = pub('app.js');
  assert.match(app, /function renderTodos/);
  assert.match(app, /case 'todo_update'/);
  const css = pub('styles.css');
  assert.match(css, /\.todo-item\.completed/);
  assert.match(css, /\.todo-item\.in_progress/);
});

test('runtime: todo_update event renders a checklist into the panel', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    app.api.renderEvent({ type: 'todo_update', todos: [
      { id: '1', content: 'First step', status: 'completed' },
      { id: '2', content: 'Second step', status: 'in_progress' },
      { id: '3', content: 'Third step', status: 'pending' },
    ] });
    const panel = app.els.get('#todo-panel');
    const texts = panel.texts();
    assert.ok(texts.some((t) => t.includes('Tasks')), 'todo head missing');
    assert.ok(texts.some((t) => /1\/3/.test(t)), 'todo done count missing');
    assert.ok(texts.some((t) => t.includes('First step')), 'first todo missing');
    assert.ok(texts.some((t) => t.includes('Third step')), 'third todo missing');
    // clearing hides the list again
    app.api.renderEvent({ type: 'todo_update', todos: [] });
    assert.equal(app.els.get('#todo-panel').texts().length, 0);
  } finally {
    app.done();
  }
});

test('settings tabs + effective prompt preview exist', () => {
  const html = pub('index.html');
  assert.match(html, /class="settings-tabs"/);
  assert.match(html, /data-tab="general"/);
  assert.match(html, /data-tab="prompt"/);
  assert.match(html, /id="prompt-preview"/);
  assert.match(html, /id="prompt-mode"/);
  const app = pub('app.js');
  assert.match(app, /function openSettingsTab/);
  assert.match(app, /function renderPromptTab/);
  assert.match(app, /\/api\/prompt/);
  const css = pub('styles.css');
  assert.match(css, /\.settings-tab\.active/);
  assert.match(css, /\.prompt-preview/);
});

test('runtime: switching to the Prompt tab loads the effective prompt', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    await app.api.openSettingsTab('prompt');
    await new Promise((r) => setTimeout(r, 80));
    const preview = app.els.get('#prompt-preview');
    assert.ok(String(preview.textContent).includes('forge'), 'prompt text not shown in preview');
    const src = app.els.get('#prompt-source');
    assert.match(String(src.textContent), /default/);
  } finally {
    app.done();
  }
});

test('skills tab: html structure + runtime list render', () => {
  const html = pub('index.html');
  assert.match(html, /data-tab="skills"/);
  assert.match(html, /id="skills-list"/);
  const app = pub('app.js');
  assert.match(app, /async function renderSkillsTab/);
  const css = pub('styles.css');
  assert.match(css, /\.skill-row/);
  assert.match(css, /\.skill-toggle/);
});

test('runtime: skills tab lists skills from the API', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    await app.api.openSettingsTab('skills');
    await new Promise((r) => setTimeout(r, 80));
    const list = app.els.get('#skills-list');
    const texts = list.texts();
    assert.ok(texts.some((t) => t.includes('Demo')), `skill name missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => t.includes('demo skill')), 'skill description missing');
  } finally {
    app.done();
  }
});

test('tools tab: html structure + runtime list render', async () => {
  const html = pub('index.html');
  assert.match(html, /data-tab="tools"/);
  assert.match(html, /id="tools-list"/);
  assert.match(html, /mcp\.json/);
  const app = pub('app.js');
  assert.match(app, /async function renderToolsList/);
  const { bootApp } = await import('./helpers/domstub.mjs');
  const boot = await bootApp();
  try {
    await boot.api.openSettingsTab('tools');
    await new Promise((r) => setTimeout(r, 80));
    const texts = boot.els.get('#tools-list').texts();
    assert.ok(texts.some((t) => t.includes('read_file')), `tools list missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => t.includes('edit_file')));
  } finally {
    boot.done();
  }
});

test('reasoning control: select in composer, sent with chat, persisted choice', () => {
  const html = pub('index.html');
  assert.match(html, /id="reasoning-select"/);
  for (const v of ['auto', 'high', 'medium', 'low', 'off']) assert.ok(html.includes(`value="${v}"`), `missing option ${v}`);
  const app = pub('app.js');
  assert.match(app, /reasoning: els\.reasoning\.value/);
  assert.match(app, /forge-reasoning/);
  assert.match(app, /session\.reasoning/);
});

test('runtime: reasoning renders a collapsible thought block with duration', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  try {
    app.api.renderEvent({ type: 'reasoning_delta', text: 'pondering this ' });
    app.api.renderEvent({ type: 'reasoning_delta', text: 'and that' });
    const t = app.api.state.thinkingEl;
    assert.ok(t, 'thinking block created');
    assert.equal(t.details.tagName, 'details');
    assert.equal(t.details.open, true);
    assert.match(t.body.textContent, /pondering this and that/);
    // final answer collapses it with a duration
    await new Promise((r) => setTimeout(r, 1100));
    app.api.renderEvent({ type: 'text_delta', text: 'the answer' });
    assert.equal(app.api.state.thinkingEl, null);
    assert.match(t.label.textContent, /Thought for \d+s/);
    assert.equal(t.details.open, false);
  } finally {
    app.done();
  }
});

test('context meter: ring + popup in composer, Code-mode only, refresh + outside-close wired', () => {
  const html = pub('index.html');
  assert.match(html, /id="ctx-meter"/);
  assert.match(html, /id="ctx-ring"/);
  assert.match(html, /id="ctx-popup"/);
  const app = pub('app.js');
  assert.match(app, /\/api\/context\?sessionId=/);
  assert.match(app, /state\.agentMode !== 'code'/, 'meter hidden outside Code mode');
  // refresh after usage, turn end, session open and mode switch
  assert.match(app, /case 'usage':[\s\S]*?updateContextMeter\(\);/);
  assert.match(app, /case 'turn_end':[\s\S]*?updateContextMeter\(\);/);
  assert.match(app, /loadSessions\(\);\n  updateContextMeter\(\);\n  scrollTop/);
  assert.match(app, /loadSessions\(\);\n  updateContextMeter\(\);\n  if \(newSession\)/);
  // outside click closes the popup
  assert.match(app, /hideCtxPopup\(\);/);
  const css = pub('styles.css');
  assert.match(css, /\.ctx-meter/);
  assert.match(css, /\.ctx-popup/);
});

test('handoff UI: handoff/handoff_delta events render a card; handoff rows reopen as cards', () => {
  const app = pub('app.js');
  assert.match(app, /case 'handoff':/);
  assert.match(app, /case 'handoff_delta':/);
  assert.match(app, /newHandoffCard/);
  assert.match(app, /forge:handoff/, 'handoff rows recognized on session open');
  assert.match(app, /Writing context handoff/);
  const css = pub('styles.css');
  assert.match(css, /\.handoff-card/);
  assert.match(css, /\.halo-spin/);
});

test('rebrand: Halo AI Harness name everywhere users see it', () => {
  const html = pub('index.html');
  assert.match(html, /<title>Halo AI Harness<\/title>/);
  assert.match(html, /brand-mini[\s\S]*Halo AI Harness/);
  assert.match(html, /Halo AI Harness can make mistakes/);
  assert.ok(!/>forge</.test(html) && !/forge mascot/.test(html));
  const app = pub('app.js');
  assert.match(app, /Halo AI Harness wants to:/);
});

test('thinking loader: halo SVG spins while reasoning, static when done', () => {
  const app = pub('app.js');
  assert.match(app, /haloIconSvg\('halo-spin'\)/, 'spinner halo while thinking');
  assert.match(app, /think-ico[\s\S]{0,80}haloIconSvg/);
});

/* ---------------- image input (section 1) ---------------- */

test('image input UI: attach button, file input, tray, lightbox in markup', () => {
  const html = pub('index.html');
  assert.match(html, /id="attach-btn"/);
  assert.match(html, /id="attach-input"[^>]*multiple/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.match(html, /id="attach-tray"/);
  assert.match(html, /id="lightbox"/);
});

test('paste / attach-change / drop enqueue uploaded images into the tray', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const uploads = [];
  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/images')) {
      const b = JSON.parse(opts.body);
      const id = `img-${uploads.length}`;
      uploads.push({ id, data: b.data, source: b.source });
      return { ok: true, status: 201, json: async () => ({ id, url: `/api/images/${id}`, mime: 'image/png', width: 0, height: 0 }) };
    }
    return null;
  };
  const app = await bootApp({ fetchStub });
  try {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgZmQAAAMAAOZ9A5cAAAAASUVORK5CYII=';
    // paste
    app.fire(app.els.get('#input'), 'paste', { clipboardData: { files: [png] } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.api.state$.pending.length, 1, 'paste added one');
    // attach input change
    const fileInput = app.els.get('#attach-input');
    fileInput.files = [png];
    app.fire(fileInput, 'change');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.api.state$.pending.length, 2, 'attach change added one');
    // drop on the chat
    app.fire(app.els.get('#messages'), 'drop', { dataTransfer: { files: [png] } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.api.state$.pending.length, 3, 'drop added one');
    // an unsupported type is rejected
    const before = uploads.length;
    await app.api.addImageFile('data:application/pdf;base64,AAAA', 'doc.pdf');
    assert.equal(app.api.state$.pending.length, 3, 'bad type rejected');
    assert.equal(uploads.length, before, 'bad type never uploaded');
    // max 5 enforced
    for (let i = 0; i < 4; i++) await app.api.addImageFile(png);
    assert.equal(app.api.state$.pending.length, 5, 'capped at 5');
    await app.api.addImageFile(png);
    assert.equal(app.api.state$.pending.length, 5, 'still capped at 5');
    assert.ok(uploads.length >= 5);
    // send includes the ids, then clears the tray
    app.els.get('#input').value = 'look at these';
    let chatBody = null;
    const inner = app.sandbox.fetch;
    app.sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/chat')) chatBody = JSON.parse(opts.body);
      return inner(url, opts);
    };
    await app.api.send();
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(chatBody, 'chat sent');
    assert.equal(chatBody.images.length, 5);
    assert.equal(app.api.state$.pending.length, 0, 'tray cleared after send');
  } finally {
    app.done();
  }
});

test('vision-off: attach button disabled + tooltip, paste rejected', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const fetchStub = async (url) => (String(url).includes('/api/config') ? { ok: true, status: 200, json: async () => ({ baseURL: 'x', model: 'm', maxSteps: 50, contextLimit: 100000, modelSupportsImages: false, hasApiKey: false }) } : null);
  const app = await bootApp({ fetchStub });
  try {
    const btn = app.els.get('#attach-btn');
    assert.equal(btn.disabled, true, 'attach disabled');
    assert.match(btn.title, /Settings/);
    const png = 'data:image/png;base64,AAAA';
    await app.api.addImageFile(png);
    assert.equal(app.api.state$.pending.length, 0, 'vision off: nothing enqueued');
  } finally {
    app.done();
  }
});

/* ---------------- browser card + inline screenshots (section 4) ---------------- */

test('browser card + screenshots + side panel: markup, events and CSS wired', () => {
  const html = pub('index.html');
  assert.match(html, /id="browser-panel"/);
  assert.match(html, /id="bp-url"/);
  assert.match(html, /id="bp-close"/);
  const app = pub('app.js');
  assert.match(app, /buildBrowserCard/);
  assert.match(app, /browser-card-preview/);
  assert.match(app, /browser-card-open/);
  assert.match(app, /'Copy URL'/);
  assert.match(app, /'Open in my browser'/);
  assert.match(app, /forge:browser-card/);
  assert.match(app, /forge:screenshot/);
  assert.match(app, /appendShotFigure/);
  assert.match(app, /shot-caption/);
  assert.match(app, /case 'browser_page':/);
  assert.match(app, /case 'browser_screenshot':/);
  assert.match(app, /\/api\/browser\/events/);
  assert.match(app, /\/api\/browser\/screencast/);
  const css = pub('styles.css');
  assert.match(css, /\.browser-card \{/);
  assert.match(css, /\.shot-figure/);
  assert.match(css, /\.browser-panel/);
  // narration instruction in the code-mode prompt
  assert.match(fs.readFileSync(path.join(process.cwd(), 'prompt', 'system.md'), 'utf8'), /1–2 short lines|1-2 short lines/);
});

test('runtime: browser card appears once per turn and updates in place; screenshots inline; Open opens panel', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const app = await bootApp();
  const findAll = (node, cls, out = []) => {
    if (node.className && String(node.className).split(' ').includes(cls)) out.push(node);
    for (const c of node.children || []) findAll(c, cls, out);
    return out;
  };
  try {
    app.api.state.sessionId = 'live1';
    const msgs = app.els.get('#messages');
    app.api.renderEvent({ type: 'browser_page', url: 'http://localhost:3000/app', title: 'My App', viewport: '1280x900' });
    let cards = findAll(msgs, 'browser-card');
    assert.equal(cards.length, 1, 'card created');
    assert.ok(cards[0].texts().some((t) => /localhost:3000 · Live/.test(t)), 'subtitle host · Live');
    // second page event updates the same card (no new card per action)
    app.api.renderEvent({ type: 'browser_page', url: 'http://localhost:3000/app', title: 'Renamed', viewport: '390x844' });
    cards = findAll(msgs, 'browser-card');
    assert.equal(cards.length, 1, 'still one card');
    assert.ok(cards[0].texts().some((t) => /Renamed/.test(t)), 'title updated in place');
    // menu items
    assert.ok(cards[0].texts().some((t) => t === 'Copy URL'));
    assert.ok(cards[0].texts().some((t) => t === 'Open in my browser'));
    // inline screenshot
    app.api.renderEvent({ type: 'browser_screenshot', imageId: 'img-s1', url: 'http://localhost:3000/app', viewport: '1280x900' });
    const figs = findAll(msgs, 'shot-figure');
    assert.equal(figs.length, 1, 'screenshot inline');
    assert.ok(figs[0].texts().some((t) => /http:\/\/localhost:3000\/app · 1280x900/.test(t)), 'caption url + viewport');
    // Open button opens the side panel
    const openBtn = findAll(cards[0], 'browser-card-open')[0];
    assert.ok(openBtn, 'Open button exists');
    app.fire(openBtn, 'click');
    assert.equal(app.api.state.panelOpen, true, 'panel opened from card');
    // new chat resets the card
    app.api.newChat();
    assert.equal(app.api.state.browserCard, null, 'card state reset');
    assert.equal(app.api.state.panelOpen, false, 'panel closed on new chat');
  } finally {
    app.done();
  }
});

test('runtime: reopening a session shows the stored card (Closed) + screenshots in place', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const session = {
    session: {
      id: 'r1',
      title: 't',
      mode: 'code',
      workspace: '/ws',
      todos: [],
      messages: [
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: 'done!' },
        { role: 'assistant', name: 'forge:browser-card', content: JSON.stringify({ url: 'http://localhost:3000/app', title: 'My App', viewport: '1280x900', imageId: 'img-frame' }) },
        { role: 'user', name: 'forge:screenshot', content: '[screenshot] http://localhost:3000/app · 1280x900', images: ['img-shot1'] },
      ],
    },
    active: false,
  };
  const fetchStub = async (url) => (String(url).includes('/api/session?') ? { ok: true, status: 200, json: async () => session } : null);
  const app = await bootApp({ fetchStub });
  const findAll = (node, cls, out = []) => {
    if (node.className && String(node.className).split(' ').includes(cls)) out.push(node);
    for (const c of node.children || []) findAll(c, cls, out);
    return out;
  };
  try {
    await app.api.openSession('r1');
    await new Promise((r) => setTimeout(r, 120));
    const msgs = app.els.get('#messages');
    const cards = findAll(msgs, 'browser-card');
    assert.equal(cards.length, 1, 'stored card rendered');
    assert.ok(cards[0].texts().some((t) => /localhost:3000 · Closed/.test(t)), 'card shows Closed');
    assert.ok(cards[0].texts().some((t) => /My App/.test(t)), 'card title');
    const figs = findAll(msgs, 'shot-figure');
    assert.equal(figs.length, 1, 'screenshot rendered from stored message');
    assert.ok(figs[0].texts().some((t) => /http:\/\/localhost:3000\/app · 1280x900/.test(t)), 'caption in place');
  } finally {
    app.done();
  }
});

/* ---------------- browser side panel (section 6) ---------------- */

test('side panel: header button, resize handle, viewport switch and error badge — markup + CSS', () => {
  const html = pub('index.html');
  assert.match(html, /id="browser-btn"/);
  assert.match(html, /id="bp-resize"/);
  assert.match(html, /id="bp-errors"/);
  assert.match(html, /id="bp-viewports"/);
  for (const size of ['desktop', 'tablet', 'mobile']) assert.match(html, new RegExp(`data-size="${size}"`));
  // hidden by default
  assert.match(html, /<aside id="browser-panel" class="browser-panel hidden"/);
  const app = pub('app.js');
  assert.match(app, /wirePanelResize/);
  assert.match(app, /wirePanelViewports/);
  assert.match(app, /forge-bp-width/);
  assert.match(app, /\/api\/browser\/viewport/);
  assert.match(app, /refreshBrowserPolicy/);
  const css = pub('styles.css');
  assert.match(css, /\.bp-resize/);
  assert.match(css, /\.bp-viewports/);
  assert.match(css, /\.bp-errors/);
  assert.match(css, /\.browser-btn/);
});

test('runtime: side panel opens with remembered width, drag resizes, viewport switch posts, error badge from state', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const posts = [];
  const fetchStub = async (url, opts) => {
    if (String(url).includes('/api/browser/state')) return { ok: true, status: 200, json: async () => ({ running: true, active: true, status: 'Live', url: 'http://localhost:3000/a', title: 'A', viewport: { width: 390, height: 844 }, consoleErrors: 3, blocked: [] }) };
    if (String(url).includes('/api/browser/viewport')) {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return null;
  };
  const storage = {};
  const app = await bootApp({ storage, fetchStub });
  try {
    app.api.state.sessionId = 'p1';
    app.api.openBrowserPanel();
    assert.equal(app.api.state.panelOpen, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(app.els.get('#browser-panel').style.width, '460px', 'default width applied');
    assert.equal(app.els.get('#bp-status').textContent, 'Live');
    assert.equal(app.els.get('#bp-url').value, 'http://localhost:3000/a', 'read-only URL bar fed');
    assert.equal(app.els.get('#bp-errors-n').textContent, '3', 'console-error badge');
    // drag resize (pointer events on the handle)
    const handle = app.els.get('#bp-resize');
    app.fire(handle, 'pointerdown', { clientX: 500 });
    app.fire(handle, 'pointermove', { clientX: 460 }); // 40 px wider
    app.fire(handle, 'pointerup', {});
    assert.equal(app.api.state.browserPanelWidth, 500);
    assert.equal(storage['forge-bp-width'], '500', 'width remembered');
    // viewport size switch
    await app.api.setPanelViewport('mobile');
    assert.deepEqual(posts[posts.length - 1], { sessionId: 'p1', size: 'mobile' });
    // close button
    app.fire(app.els.get('#bp-close'), 'click');
    assert.equal(app.api.state.panelOpen, false);
    assert.ok(!app.rejections.length, 'no unhandled rejections');
  } finally {
    app.done();
  }
});

test('runtime: browser tool policy — panel closes + button disabled when the browser tool is off', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  const fetchStub = async (url) => {
    if (String(url).includes('/api/tools')) return { ok: true, status: 200, json: async () => ({ tools: [{ name: 'read_file', enabled: true }, { name: 'browser', enabled: false }], mcp: { servers: [], tools: [] } }) };
    return null;
  };
  const app = await bootApp({ fetchStub });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(app.api.state.browserToolEnabled, false, 'policy read from /api/tools');
    // opening while disabled immediately closes the panel
    app.api.state.sessionId = 'p2';
    app.api.openBrowserPanel();
    await app.api.refreshBrowserPolicy();
    assert.equal(app.api.state.panelOpen, false, 'panel not shown while the browser tool is disabled');
  } finally {
    app.done();
  }
});

test('session budget banner: markup + CSS exist', () => {
  const html = pub('index.html');
  assert.match(html, /<div id="budget-banner" class="budget-banner hidden"/);
  assert.match(html, /id="budget-new-chat"/);
  assert.match(html, /id="budget-dismiss"/);
  const css = pub('styles.css');
  assert.match(css, /\.budget-banner \{/);
  assert.match(css, /\.budget-btn \{/);
});

test('runtime: session-budget banner appears past the limit; button opens a fresh Code chat prefilled with the latest handoff summary; dismiss hides', async () => {
  const { bootApp } = await import('./helpers/domstub.mjs');
  let over = false;
  const fetchStub = async (url) => {
    if (String(url).includes('/api/context'))
      return { ok: true, status: 200, json: async () => ({ used: 100, limit: 1000, parts: [], budget: 1000, inputTokens: over ? 1200 : 500, overBudget: over }) };
    return null;
  };
  const app = await bootApp({ storage: { 'forge-agent-mode': 'code' }, fetchStub });
  try {
    const banner = app.els.get('#budget-banner');
    app.api.state.sessionId = 'sb-1';
    await app.api.updateContextMeter();
    assert.equal(banner.getAttribute('data-over'), '0', 'no banner under the budget');

    over = true;
    await app.api.updateContextMeter();
    assert.equal(banner.getAttribute('data-over'), '1', 'banner appears after crossing the limit');
    assert.match(app.els.get('#budget-text').__html, /session budget/);

    // the button starts a new chat in the same workspace prefilled with the latest handoff summary
    app.api.state.lastHandoffSummary = '## Original task\nmake the thing\n\n## Next steps\nverify';
    app.fire(app.els.get('#budget-new-chat'), 'click');
    assert.equal(app.api.state.sessionId, null, 'fresh chat opened');
    assert.match(app.els.get('#input').value, /## Original task\nmake the thing/);

    // dismiss hides the banner even while still over budget
    await app.api.updateContextMeter();
    app.fire(app.els.get('#budget-dismiss'), 'click');
    assert.equal(banner.getAttribute('data-over'), '0');
    assert.equal(app.api.state.budgetDismissed, true);
    assert.ok(!app.rejections.length, 'no unhandled rejections');
  } finally {
    app.done();
  }
});
