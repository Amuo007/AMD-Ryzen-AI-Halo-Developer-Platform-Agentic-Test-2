import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = (f) => fs.readFileSync(path.join(process.cwd(), 'public', f), 'utf8');

test('tool cards: collapsible card with name, args, status, result and red/green diff', () => {
  const html = pub('index.html');
  const app = pub('app.js');
  assert.match(app, /tool-card/);
  assert.match(app, /tool_status|tool-status/);
  // collapsible via <details>
  assert.match(app, /buildToolCard/);
  assert.match(app, /diff-line/);
  // diff colors come from CSS
  const css = pub('styles.css');
  assert.match(css, /\.diff-line\.add/);
  assert.match(css, /\.diff-line\.del/);
  assert.match(html, /id="messages"/);
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

test('status bar shows model, mode selector, tokens, error', () => {
  const html = pub('index.html');
  assert.match(html, /id="status-model"/);
  assert.match(html, /id="mode-select"/);
  assert.match(html, /value="ask"/);
  assert.match(html, /value="auto-edit"/);
  assert.match(html, /value="full"/);
  assert.match(html, /id="status-tokens"/);
  assert.match(html, /id="status-error"/);
});

test('dark and light themes defined, toggle wired', () => {
  const css = pub('styles.css');
  assert.match(css, /\[data-theme='dark'\]/);
  assert.match(css, /\[data-theme='light'\]/);
  const app = pub('app.js');
  assert.match(app, /applyTheme/);
  const html = pub('index.html');
  assert.match(html, /id="theme-toggle"/);
});

test('sidebar: new chat, sessions list, settings, workspace picker', () => {
  const html = pub('index.html');
  assert.match(html, /id="new-chat"/);
  assert.match(html, /id="session-list"/);
  assert.match(html, /id="settings-btn"/);
  assert.match(html, /id="workspace-input"/);
  assert.match(html, /id="browse-btn"/);
});
