/* Minimal DOM/vm harness: boots public/app.js headlessly and lets tests fire events. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

class StubEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    this.className = '';
    this.textContent = '';
    this.__html = '';
    // innerHTML = '' must clear children like the real DOM (assignment to
    // non-empty strings just stores the string; tests inspect via texts())
    Object.defineProperty(this, 'innerHTML', {
      get() {
        return this.__html;
      },
      set(v) {
        this.__html = String(v);
        if (v === '') this.children = [];
      },
    });
    this.value = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.disabled = false;
    this.open = false;
    this.__on = {};
    this.__handlers = (ev) => this.__on[ev] || [];
  }
  appendChild(c) { this.children.push(c); if (c instanceof StubEl) c.parentElement = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  replaceWith(c) {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(ev, fn) { (this.__on[ev] = this.__on[ev] || []).push(fn); }
  querySelector() { return new StubEl('div'); }
  querySelectorAll() { return []; }
  showModal() {}
  close() {}
  focus() {}
  click() {
    // dispatch a synthetic click to click handlers (used by attach button tests)
    for (const fn of this.__handlers('click')) fn({ preventDefault() {}, stopPropagation() {}, target: this });
  }
  texts(out = []) {
    if (this.textContent) out.push(this.textContent);
    for (const c of this.children) if (c instanceof StubEl) c.texts(out);
    return out;
  }
}

const DEFAULT_ROUTES = [
  ['/api/config', { baseURL: 'http://mock/v1', model: 'mock-model', maxSteps: 50, contextLimit: 100000, hasApiKey: false }],
  ['/api/llm-status', { ok: true, status: 200 }],
  ['/api/stats', { user: 'amrinder', sessions: 0, messages: 0, totalTokens: 0, activeDays: 0, peakHour: null, favoriteModel: null, models: [], heatmap: [] }],
  ['/api/sessions', { sessions: [] }],
  ['/api/prompt', { mode: 'code', source: 'default', path: '/repo/prompt/system.md', text: '# forge — Code mode system prompt\n\nYou are forge.', locations: { default: '/repo/prompt', global: '/home/.forge', workspace: '/ws/.forge' } }],
  ['/api/skills', { skills: [{ id: 'demo', name: 'Demo', description: 'demo skill', source: 'global', enabled: true }] }],
  ['/api/tools', { tools: [
    { name: 'read_file', description: 'read a file', enabled: true },
    { name: 'edit_file', description: 'edit a file', enabled: true },
  ], mcp: { servers: [], tools: [] } }],
];

export async function bootApp({ storage = {}, fetchStub } = {}) {
  const defFetch = async (url) => {
    const u = String(url);
    const route = DEFAULT_ROUTES.find(([p]) => u.includes(p));
    return { ok: true, status: 200, json: async () => (route ? route[1] : {}) };
  };
  const fetchImpl = fetchStub
    ? async (url, opts) => {
        const r = await fetchStub(url, opts);
        return r === undefined || r === null ? defFetch(url, opts) : r;
      }
    : defFetch;
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  const els = new Map();
  const document = {
    documentElement: new StubEl('html'),
    querySelector(sel) {
      if (!els.has(sel)) els.set(sel, new StubEl('div'));
      return els.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    createElement: (tag) => new StubEl(tag),
    addEventListener() {},
  };
  const sandbox = {
    document,
    navigator: { clipboard: null },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
    },
    fetch: fetchImpl,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    EventSource: class ES {
      constructor() {}
      static CLOSED = 2;
      close() {}
    },
    console,
  };
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  vm.runInNewContext(src, sandbox, { timeout: 5000 });
  const flush = () => new Promise((r) => setTimeout(r, 50));
  await flush();
  return {
    sandbox,
    els,
    get api() { return sandbox.__forge; },
    rejections,
    fire(el, ev, e = {}) {
      const evt = { preventDefault() {}, stopPropagation() {}, target: el, ...e };
      for (const fn of el.__handlers(ev)) fn(evt);
    },
    done() {
      process.off('unhandledRejection', onRej);
    },
  };
}
