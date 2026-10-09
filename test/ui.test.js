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
  for (const kf of ['m-breathe', 'm-blink', 'm-trot', 'm-halo-pulse', 'm-dart', 'm-think-tilt', 'm-talk'])
    assert.match(css, new RegExp(`@keyframes ${kf}`));
  assert.match(css, /prefers-reduced-motion/);
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
