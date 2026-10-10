import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CDPClient } from './cdp.js';
import { detectBrowser } from './detect.js';
import { isLocalUrl } from './local.js';

const IDLE_MS = 10 * 60 * 1000; // close the browser 10 minutes after last use
const LAUNCH_TIMEOUT_MS = 25000;

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const KEY_CODES = {
  Enter: { keyCode: 13, code: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  ' ': { keyCode: 32, code: 'Space' },
};

let browser = null; // { child, port, client, userDataDir, closing }
let idleTimer = null;
let hooksInstalled = false;
const pages = new Map(); // conversationId -> PageSession
const bus = new Map(); // conversationId -> Set(cb)

function publish(sessionId, event) {
  const set = bus.get(String(sessionId));
  if (!set) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch {
      /* subscriber errors never break the browser */
    }
  }
}

export function subscribe(sessionId, cb) {
  const key = String(sessionId);
  if (!bus.has(key)) bus.set(key, new Set());
  bus.get(key).add(cb);
  return () => bus.get(key)?.delete(cb);
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (browser && !browser.closing) {
    idleTimer = setTimeout(() => {
      shutdownAll().catch(() => {});
    }, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }
}

function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const bye = () => {
    try {
      if (browser?.child) killTree(browser.child);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', bye);
  process.on('SIGINT', () => {
    bye();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    bye();
    process.exit(143);
  });
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGKILL'); // whole process group
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function httpJson(url, timeout = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Launch the shared headless browser (or return the running one). */
async function ensureBrowser() {
  if (browser && !browser.closing) return browser;
  if (browser?.closing) await shutdownAll();
  installExitHooks();
  const bin = detectBrowser();
  if (!bin) throw Object.assign(new Error('Chrome not found — set the path in Settings → General (or FORGE_BROWSER_PATH).'), { status: 400, chromeMissing: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate',
    '--window-size=1280,900',
  ];
  const child = spawn(bin, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  const port = await waitForPort(userDataDir, LAUNCH_TIMEOUT_MS);
  const version = await httpJson(`http://127.0.0.1:${port}/json/version`);
  const client = new CDPClient(version.webSocketDebuggerUrl, { timeout: 60000 });
  await client.connect();
  browser = { child, port, client, userDataDir, closing: false };
  child.on('exit', () => {
    // browser died on its own: clean up its profile dir + mark pages closed
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  client.onClose(() => {
    // browser died unexpectedly: mark all pages closed
    for (const [, p] of pages) p.markClosed();
  });
  touchIdle();
  return browser;
}

async function waitForPort(userDataDir, timeoutMs) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      const port = Number(text.split('\n')[0]);
      if (port > 0) return port;
    } catch {
      /* not written yet */
    }
    await sleep(120);
  }
  throw Object.assign(new Error('Chrome did not start a debugging port in time'), { status: 502 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PageSession {
  constructor({ conversationId, client, browserContextId, targetId, sessionId, workspace }) {
    this.conversationId = String(conversationId);
    this.client = client;
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.url = 'about:blank';
    this.title = '';
    this.viewport = { ...VIEWPORTS.desktop };
    this.console = [];
    this.consoleRead = 0;
    this.refCounter = 0;
    this.lastScreenshot = null; // { imageId, url, width, height }
    this.closed = false;
    this.navigationsBlocked = [];
    this._wire();
  }

  call(method, params = {}, timeout) {
    return this.client.send(method, params, { sessionId: this.sessionId, timeout });
  }

  _wire() {
    this.off = [];
    this.off.push(
      this.client.on('Page.frameStartedLoading', (p, sid) => {
        if (sid !== this.sessionId) return;
        this._checkNav(p.url);
      })
    );
    this.off.push(
      this.client.on('Page.javascriptDialogOpening', (p, sid) => {
        if (sid !== this.sessionId) return;
        // auto-dismiss dialogs so the agent never hangs; report them as console
        this._pushConsole('log', `[${p.type} dialog] ${p.message || ''}`);
        this.client.send('Page.handleJavaScriptDialog', { accept: true }, { sessionId: this.sessionId }).catch(() => {});
      })
    );
    this.off.push(
      this.client.on('Runtime.consoleAPICalled', (p, sid) => {
        if (sid !== this.sessionId) return;
        const kind = p.type === 'error' ? 'error' : p.type === 'warning' ? 'warn' : 'log';
        const text = (p.args || []).map((a) => a.description ?? a.value ?? a.subtype ?? '').join(' ');
        this._pushConsole(kind, text);
      })
    );
    this.off.push(
      this.client.on('Runtime.exceptionThrown', (p, sid) => {
        if (sid !== this.sessionId) return;
        const d = p.exceptionDetails || {};
        const text = d.exception?.description || d.text || 'Uncaught error';
        this._pushConsole('exception', text);
      })
    );
    this.off.push(
      this.client.on('Log.entryAdded', (p, sid) => {
        if (sid !== this.sessionId) return;
        const e = p.entry || {};
        if (e.source === 'network') this._pushConsole('request', `${e.level} ${e.url || ''} ${e.text || ''}`.trim());
      })
    );
    this.off.push(
      this.client.on('Network.loadingFailed', (p, sid) => {
        if (sid !== this.sessionId) return;
        this._pushConsole('request', `failed: ${p.type || ''} ${p.errorText || ''} ${p.request ? '' : ''}`.trim());
      })
    );
  }

  _pushConsole(kind, text) {
    this.console.push({ at: Date.now(), kind, text: String(text).slice(0, 500) });
    if (this.console.length > 500) this.console.shift();
    publish(this.conversationId, { type: 'console', kind, text });
  }

  errorCount() {
    return this.console.filter((e) => e.kind === 'error' || e.kind === 'exception').length;
  }

  _checkNav(url) {
    if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-untrusted://') || url.startsWith('devtools://')) return;
    const check = isLocalUrl(url, { workspace: this.workspace });
    if (!check.ok) {
      this.navigationsBlocked.push(url);
      this.call('Page.stopLoading', {}).catch(() => {});
      this._pushConsole('error', `BLOCKED navigation off localhost: ${url}`);
      publish(this.conversationId, { type: 'navigation-blocked', url });
    }
  }

  async init() {
    await this.call('Page.enable');
    await this.call('Runtime.enable');
    await this.call('Network.enable');
    await this.call('Log.enable');
    await this.applyViewport(this.viewport);
    await this.call('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }

  async applyViewport(vp) {
    this.viewport = { ...vp };
    await this.call('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile,
    });
    publish(this.conversationId, { type: 'viewport', ...vp });
  }

  async goto(url, { timeout = 20000 } = {}) {
    const check = isLocalUrl(url, { workspace: this.workspace });
    if (!check.ok) throw Object.assign(new Error(check.error), { status: 400, localOnly: true });
    const before = this.url;
    await this.call('Page.navigate', { url: check.resolved });
    const loaded = await this._waitForReady(timeout);
    this.url = await this._eval('document.location.href', 'about:blank');
    this.title = await this._eval('document.title', '');
    publish(this.conversationId, { type: 'navigation', url: this.url, title: this.title, from: before });
    return { url: this.url, title: this.title, loaded };
  }

  async _waitForReady(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const state = await this._eval('document.readyState', null);
      if (state === 'complete' || state === 'interactive') return true;
      await sleep(150);
    }
    return false;
  }

  async _eval(expression, fallback = null) {
    try {
      const res = await this.call('Runtime.evaluate', { expression, returnByValue: true }, 10000);
      return res && res.result ? res.result.value : fallback;
    } catch {
      return fallback;
    }
  }

  async screenshot({ full = false } = {}) {
    const params = { format: 'jpeg', quality: 72 };
    if (full) {
      const metrics = await this.call('Page.getLayoutMetrics', {});
      const size = metrics.cssContentSize || metrics.contentSize || { width: this.viewport.width, height: this.viewport.height };
      params.clip = { x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const res = await this.call('Page.captureScreenshot', params, 30000);
    if (res && res.data) this.lastScreenshot = { base64: res.data };
    return res; // { data: base64 }
  }

  async snapshot() {
    const script = `(() => {
      const out = [];
      let ref = ${this.refCounter};
      const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [onclick], [tabindex]:not([tabindex="-1"]), summary';
      const seen = new Set();
      document.querySelectorAll(sel).forEach((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const hidden = rect.width < 1 && rect.height < 1 || style.visibility === 'hidden' || style.display === 'none';
        if (hidden) return;
        ref += 1;
        el.setAttribute('data-halo-ref', String(ref));
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        out.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.getAttribute('role') || '', text, href: (el.getAttribute && el.getAttribute('href')) || '', disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
        seen.add(el);
      });
      this.refCounter = ref;
      const headings = [];
      document.querySelectorAll('h1,h2,h3').forEach((h) => { const t = (h.innerText||'').trim().replace(/\\s+/g,' ').slice(0,80); if (t) headings.push(h.tagName + ' ' + t); });
      return JSON.stringify({ url: document.location.href, title: document.title, headings: headings.slice(0, 20), count: out.length, elements: out.slice(0, 200) });
    })()`;
    const raw = await this._eval(script, null);
    this.refCounter = Math.max(this.refCounter, 0);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { url: this.url, title: this.title, headings: [], elements: [], count: 0 };
    }
    this.url = parsed.url || this.url;
    this.title = parsed.title || this.title;
    return parsed;
  }

  async _elementPoint(ref) {
    const script = `(() => { const el = document.querySelector('[data-halo-ref="${ref}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, found: true }); })()`;
    const raw = await this._eval(script, null);
    if (!raw) throw new Error(`No element with ref ${ref} — run a snapshot first`);
    return JSON.parse(raw);
  }

  async click({ ref, selector, x, y }) {
    let cx = x;
    let cy = y;
    if (ref != null) {
      const pt = await this._elementPoint(ref);
      cx = pt.x;
      cy = pt.y;
    } else if (selector) {
      const raw = await this._eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`, null);
      if (!raw) throw new Error(`No element matches selector: ${selector}`);
      const pt = JSON.parse(raw);
      cx = pt.x;
      cy = pt.y;
    }
    if (cx == null || cy == null) throw new Error('click needs ref, selector or x,y');
    const base = { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 };
    await this.call('Input.dispatchMouseEvent', base);
    await this.call('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
    await this._waitForReady(4000).catch(() => {});
    this.url = await this._eval('document.location.href', this.url);
    this.title = await this._eval('document.title', this.title);
    publish(this.conversationId, { type: 'navigation', url: this.url, title: this.title, action: 'click' });
    return { x: cx, y: cy, url: this.url };
  }

  async typeText({ ref, selector, text }) {
    const focusSel = ref != null ? `[data-halo-ref="${ref}"]` : selector;
    if (!focusSel) throw new Error('type needs ref or selector');
    const ok = await this._eval(`(() => { const el = document.querySelector(${JSON.stringify(focusSel)}); if (!el) return false; el.focus(); if (el.setSelectionRange) { try { el.focus(); } catch(e){} } return document.activeElement === el; })()`, false);
    if (!ok) throw new Error(`Could not focus element: ${focusSel}`);
    await this.call('Input.insertText', { text: String(text) });
    return { typed: String(text).length };
  }

  async pressKey(name) {
    const kc = KEY_CODES[name] || {};
    const keyCode = kc.keyCode ?? name.charCodeAt(0);
    const code = kc.code || name;
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    return { key: name };
  }

  async hover({ ref, selector, x, y }) {
    let cx = x;
    let cy = y;
    if (ref != null) ({ x: cx, y: cy } = await this._elementPoint(ref));
    else if (selector) {
      const raw = await this._eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`, null);
      if (!raw) throw new Error(`No element matches: ${selector}`);
      ({ x: cx, y: cy } = JSON.parse(raw));
    }
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    return { x: cx, y: cy };
  }

  async scroll({ x = 0, y = 0, toRef = null }) {
    if (toRef != null) {
      await this._eval(`(() => { const el = document.querySelector('[data-halo-ref="${toRef}"]'); if (el) el.scrollIntoView(); return true; })()`, true);
      return { scrolledTo: toRef };
    }
    await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(this.viewport.width / 2), y: Math.round(this.viewport.height / 2), deltaX: x, deltaY: y });
    return { deltaX: x, deltaY: y };
  }

  async back() {
    const hist = await this.call('Page.getNavigationHistory', {});
    const idx = hist.currentIndex ?? 0;
    if (idx <= 0) return { url: this.url, note: 'no previous page' };
    const entry = hist.entries[idx - 1];
    await this.call('Page.navigateToHistoryEntry', { entryId: entry.id });
    await this._waitForReady(15000);
    this.url = await this._eval('document.location.href', this.url);
    this.title = await this._eval('document.title', this.title);
    publish(this.conversationId, { type: 'navigation', url: this.url, title: this.title, action: 'back' });
    return { url: this.url };
  }

  async reload() {
    await this.call('Page.reload', {});
    await this._waitForReady(20000);
    this.url = await this._eval('document.location.href', this.url);
    this.title = await this._eval('document.title', this.title);
    publish(this.conversationId, { type: 'navigation', url: this.url, title: this.title, action: 'reload' });
    return { url: this.url };
  }

  async waitFor({ text = null, selector = null, timeout = 10000 } = {}) {
    const start = Date.now();
    const expr = text ? `(() => { try { return document.body.innerText.includes(${JSON.stringify(text)}); } catch(e){ return false; } })()` : `(() => !!document.querySelector(${JSON.stringify(selector)}))()`;
    while (Date.now() - start < timeout) {
      const found = await this._eval(expr, false);
      if (found) return { found: true, waitedMs: Date.now() - start };
      await sleep(200);
    }
    return { found: false, waitedMs: timeout };
  }

  startScreencast({ everyNthFrame = 1 } = {}) {
    if (this._screencastOff) return { started: true };
    this._screencastOff = this.client.on('Page.screencastFrame', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.client.send('Page.screencastFrameAck', { sessionId: p.sessionId }, { sessionId: this.sessionId }).catch(() => {});
      this.lastFrame = `data:image/jpeg;base64,${p.data}`;
      publish(this.conversationId, { type: 'frame', data: this.lastFrame, metadata: p.metadata });
    });
    return this.call('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 960, maxHeight: 960, everyNthFrame });
  }
  stopScreencast() {
    if (this._screencastOff) {
      this._screencastOff();
      this._screencastOff = null;
    }
    return this.call('Page.stopScreencast', {}).catch(() => {});
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.off || []) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    publish(this.conversationId, { type: 'closed', url: this.url, title: this.title });
  }

  dispose() {
    this.markClosed();
    if (this.browserContextId) this.client.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }).catch(() => {});
    if (this.targetId) this.client.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

/** Get (creating if needed) the isolated page for a conversation. */
async function ensurePage(conversationId, { workspace = null } = {}) {
  const key = String(conversationId);
  const existing = pages.get(key);
  if (existing && !existing.closed) {
    touchIdle();
    return existing;
  }
  const b = await ensureBrowser();
  const ctx = await b.client.send('Target.createBrowserContext', { disposeOnDetach: false });
  const target = await b.client.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.browserContextId });
  const attach = await b.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new PageSession({ conversationId: key, client: b.client, browserContextId: ctx.browserContextId, targetId: target.targetId, sessionId: attach.sessionId, workspace });
  await page.init();
  pages.set(key, page);
  publish(key, { type: 'open', url: page.url, title: '' });
  touchIdle();
  return page;
}

export function getPage(sessionId) {
  return pages.get(String(sessionId)) || null;
}

export function hasOpenSession(sessionId) {
  const p = pages.get(String(sessionId));
  return Boolean(p && !p.closed);
}

/** The browser-side state used by the panel + card. */
export function getState(sessionId) {
  const p = pages.get(String(sessionId));
  if (!p) return { running: Boolean(browser), active: false, status: browser ? 'Idle' : 'Closed', url: null, title: null, viewport: null, consoleErrors: 0, blocked: [] };
  return {
    running: Boolean(browser),
    active: !p.closed,
    status: p.closed ? 'Closed' : 'Live',
    url: p.url,
    title: p.title,
    viewport: p.viewport,
    consoleErrors: p.errorCount(),
    blocked: p.navigationsBlocked.slice(-5),
  };
}

export { ensurePage };

/** Close a single conversation's browser context. */
export async function closeConversation(sessionId) {
  const p = pages.get(String(sessionId));
  if (p) {
    p.dispose();
    pages.delete(String(sessionId));
  }
}

/** Shut the whole browser down (server exit / idle). No orphans left. */
export async function shutdownAll() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  for (const [, p] of pages) {
    try {
      p.stopScreencast();
      p.dispose();
    } catch {
      /* ignore */
    }
  }
  pages.clear();
  const b = browser;
  if (!b) return;
  b.closing = true;
  try {
    b.client.close();
  } catch {
    /* ignore */
  }
  if (b.child) killTree(b.child);
  browser = null;
  try {
    fs.rmSync(b.userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function isRunning() {
  return Boolean(browser && !browser.closing);
}

export { publish };
