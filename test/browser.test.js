import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP client vs fake CDP WebSocket server ---------------- */

test('cdp client: request/response matched by id, events, error replies, timeouts, close', async () => {
  const { startFakeCDP } = await import('./helpers/fake-cdp.mjs');
  const { CDPClient } = await import('../src/browser/cdp.js');
  const fake = await startFakeCDP({
    handle: (msg) => {
      if (msg.method === 'Echo.params') return { id: msg.id, result: { echo: msg.params, id: msg.id } };
      if (msg.method === 'Bad.method') return { id: msg.id, error: { code: -32601, message: 'no such method' } };
      if (msg.method === 'Never.replies') return null;
      return { id: msg.id, result: { ok: true } };
    },
  });
  const c = new CDPClient(fake.wsUrl, { timeout: 3000 });
  await c.connect();

  const r = await c.send('Echo.params', { a: 1, b: 'x' });
  assert.deepEqual(r.echo, { a: 1, b: 'x' });
  assert.ok(r.id >= 1, 'response matched by request id');
  // ids increase, sessions pass through
  const s = await c.send('Echo.params', {}, { sessionId: 'SID-9' });
  const sent = fake.requests.at(-1);
  assert.equal(sent.sessionId, 'SID-9');
  assert.equal(sent.id, s.id);

  // events: subscribe / unsubscribe
  const got = [];
  const off = c.on('Page.someEvent', (p, sid) => got.push([p.n, sid]));
  fake.broadcast({ method: 'Page.someEvent', params: { n: 7 }, sessionId: 'SID-9' });
  await sleep(80);
  assert.deepEqual(got, [[7, 'SID-9']]);
  off();
  fake.broadcast({ method: 'Page.someEvent', params: { n: 8 }, sessionId: 'SID-9' });
  await sleep(80);
  assert.equal(got.length, 1, 'unsubscribed listener is not called');
  // wildcard
  const all = [];
  c.on('*', (obj) => all.push(obj.method));
  fake.broadcast({ method: 'Runtime.anything', params: {} });
  await sleep(80);
  assert.ok(all.includes('Runtime.anything'));

  // error response rejects
  await assert.rejects(() => c.send('Bad.method'), /no such method/);
  // timeout rejects with the method name
  await assert.rejects(() => c.send('Never.replies', {}, { timeout: 150 }), /CDP timeout after 150ms waiting for Never\.replies/);

  // server-side disconnect: pending request rejects, onClose fires
  let closeFired = 0;
  c.onClose(() => closeFired++);
  const never = c.send('Never.replies', {}, { timeout: 5000 });
  fake.disconnectAll();
  await assert.rejects(never, /closed/i);
  await sleep(120);
  assert.ok(closeFired >= 1, 'onClose handler ran');
  await assert.rejects(() => c.send('Echo.params'), /not open|closed/i);

  // connect to a dead port fails cleanly
  const dead = new CDPClient('ws://127.0.0.1:1/cdp', { timeout: 400 });
  await assert.rejects(() => dead.connect());
  await fake.close();
});

/* ---------------- local-only guard (unit) ---------------- */

test('local-only guard: external URLs refused, localhost + workspace files allowed', async () => {
  const { isLocalUrl } = await import('../src/browser/local.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-'));
  const inside = path.join(ws, 'page.html');
  fs.writeFileSync(inside, '<html></html>');
  assert.equal(isLocalUrl('http://localhost:3000/').ok, true);
  assert.equal(isLocalUrl('http://127.0.0.1:8080/app/index.html').ok, true);
  assert.equal(isLocalUrl('http://[::1]:5173/').ok, true);
  assert.equal(isLocalUrl('http://myapp.localhost:3000/').ok, true);
  assert.equal(isLocalUrl(`file://${inside}`, { workspace: ws }).ok, true);

  assert.equal(isLocalUrl('https://example.com/').ok, false);
  assert.match(isLocalUrl('https://example.com/').error, /non-local host "example\.com"/);
  assert.equal(isLocalUrl('http://192.168.1.10:8080/').ok, false);
  assert.equal(isLocalUrl('ftp://files.example.com/').ok, false);
  assert.equal(isLocalUrl('not a url').ok, false);
  assert.equal(isLocalUrl(`file://${inside}`, { workspace: null }).ok, false);
  const outside = path.join(os.tmpdir(), 'forge-guard-outside.html');
  fs.writeFileSync(outside, '<html></html>');
  assert.equal(isLocalUrl(`file://${outside}`, { workspace: ws }).ok, false);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

/* ---------------- real-Chrome integration (auto-skip when Chrome missing) ---------------- */

const PAGE = `<!doctype html><html><head><title>Broken demo</title></head><body>
<h1>Broken demo page</h1>
<button id="broken" onclick="throw new Error('kaboom from button')">Break it</button>
<a class="ext" href="https://example.com/">Leave localhost</a>
<input id="name" placeholder="name" />
<script>console.error('console says: button has no handler');</script>
</body></html>`;

test('integration: real headless Chrome — open, screenshot, snapshot, click, console, resize, navigation guard, no orphans', async (t) => {
  const { detectBrowser } = await import('../src/browser/detect.js');
  const chrome = detectBrowser();
  if (!chrome) {
    t.skip('Chrome/Chromium/Edge not found — integration test skipped');
    return;
  }
  const b = await import('../src/browser/index.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-it-'));
  fs.writeFileSync(path.join(ws, 'index.html'), PAGE);
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const page = await b.ensurePage('it-1', { workspace: ws });
    assert.ok(b.isRunning(), 'browser reports running');

    const nav = await page.goto(pageUrl);
    assert.equal(nav.title, 'Broken demo');
    assert.ok(nav.url.startsWith(pageUrl));

    // screenshot: real JPEG bytes
    const shot = await page.screenshot();
    assert.ok(shot.data && shot.data.length > 1000, 'screenshot returned image data');

    // snapshot: numbered refs for the visible controls
    const snap = await page.snapshot();
    assert.equal(snap.title, 'Broken demo');
    const btn = snap.elements.find((e) => e.tag === 'button');
    assert.ok(btn && /Break it/.test(btn.text), 'broken button found in snapshot');
    assert.ok(btn.ref >= 1);

    // console: the page's console.error was captured
    assert.ok(page.console.some((e) => e.kind === 'error' && /console says/.test(e.text)), 'console error read');
    assert.ok(page.errorCount() >= 1);

    // click the broken button → the thrown handler shows up as an exception
    await page.click({ ref: btn.ref });
    await sleep(400);
    assert.ok(page.errorCount() >= 2, 'click exception recorded');
    assert.ok(page.console.some((e) => /kaboom from button/.test(e.text)));

    // resize
    await page.applyViewport(b.VIEWPORTS.mobile);
    assert.equal(page.viewport.width, 390);
    const shot2 = await page.screenshot();
    assert.ok(shot2.data.length > 1000, 'screenshot after resize');

    // local-only guard: external navigation refused before it starts
    await assert.rejects(() => page.goto('https://example.com/'), /Refusing non-local host/);
    // and stopped while in flight: clicking the external link blocks the navigation
    await page.click({ selector: 'a.ext' }).catch(() => {});
    await sleep(600);
    assert.ok(page.navigationsBlocked.some((u) => u.includes('example.com')), 'off-localhost navigation stopped');
    assert.ok(page.console.some((e) => /BLOCKED navigation/.test(e.text)));
    assert.equal(b.getState('it-1').status, 'Live');

    // file:// pages inside the workspace open; outside are refused
    await page.goto(`file://${path.join(ws, 'index.html')}`);
    assert.ok(page.url.startsWith('file://'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
    const outFile = path.join(outDir, 'secret.html');
    fs.writeFileSync(outFile, '<html>outside</html>');
    await assert.rejects(() => page.goto(`file://${outFile}`), /outside the workspace|Refusing/);
    fs.rmSync(outDir, { recursive: true, force: true });
  } finally {
    await b.shutdownAll();
    srv.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // process cleanup: no Chrome left behind, profile dirs removed
  assert.equal(b.isRunning(), false, 'browser shut down');
  assert.equal(b.getState('it-1').status, 'Closed');
  await sleep(400);
  const ps = spawnSync('ps', ['axww', '-o', 'command='], { encoding: 'utf8' });
  const strays = (ps.stdout || '').split('\n').filter((line) => line.includes('forge-chrome-'));
  assert.deepEqual(strays, [], `no stray Chrome processes: ${strays.join(' | ')}`);
  const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('forge-chrome-'));
  assert.deepEqual(dirs, [], 'chrome profile dirs cleaned up');
});
