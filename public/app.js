/* forge web UI — Chat + Code modes, SQLite-backed sessions, reference-inspired look */
const $ = (sel) => document.querySelector(sel);

const els = {
  messages: $('#messages'),
  input: $('#input'),
  send: $('#send-btn'),
  stop: $('#stop-btn'),
  sessionGroups: $('#session-groups'),
  search: $('#search'),
  newChat: $('#new-chat'),
  modeChatBtn: $('#mode-chat-btn'),
  modeCodeBtn: $('#mode-code-btn'),
  main: $('#main'),
  workspace: $('#workspace-input'),
  workspaceSection: $('#workspace-section'),
  workspaceError: $('#workspace-error'),
  browseBtn: $('#browse-btn'),
  themeToggle: $('#theme-toggle'),
  settingsBtn: $('#settings-btn'),
  settingsModal: $('#settings-modal'),
  settingsForm: $('#settings-form'),
  topTitle: $('#top-title'),
  topIcon: $('#top-icon'),
  topDot: $('#top-dot'),
  topCrumbs: $('#top-crumbs'),
  topModel: $('#top-model'),
  userName: $('#user-name'),
  userAvatar: $('#user-avatar'),
  modeWrap: $('#mode-wrap'),
  tokens: $('#status-tokens'),
  statusError: $('#status-error'),
  modeSelect: $('#mode-select'),
  scrollBtn: $('#scroll-bottom'),
  llmStatus: $('#status-llm'),
  browseModal: $('#browse-modal'),
  browseList: $('#browse-list'),
  browsePath: $('#browse-path'),
  browseUp: $('#browse-up'),
  browseClose: $('#browse-close'),
  browseChoose: $('#browse-choose'),
};

const SVG = {
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v11h4v-6h5.5a2 2 0 0 0 2-1.6l1-6A2 2 0 0 0 17.5 5H13c.5-2 .8-3.5.3-4.5C12.7-1 10.5.5 10 3c-.3 1.7-.8 3.7-1.5 5H7z"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 14V3h-4v6H7.5a2 2 0 0 0-2 1.6l-1 6A2 2 0 0 0 6.5 19H11c-.5 2-.8 3.5-.3 4.5.5 1.5 2.7 0 3.2-2.5.3-1.7.8-3.7 1.5-5H17z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

const state = {
  sessionId: null,
  agentMode: localStorage.getItem('forge-agent-mode') || 'chat',
  running: false,
  es: null,
  statsRange: 'all',
  statsTab: 'overview',
  lastUserMessage: '',
  lastAssistantBubble: null,
  assistantEl: null,
  thinkingEl: null,
  pendingToolCards: new Map(),
  cardsByCallId: new Map(),
  turnEdits: [],
  lastUsage: null,
  stats: null,
};

/* ---------------- helpers ---------------- */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `${method} ${path} failed (${res.status})`), { status: res.status });
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function scrollTop() {
  els.messages.scrollTop = els.messages.scrollHeight;
}
function isAtBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
}
function setStatusError(msg) {
  els.statusError.textContent = msg || '';
  els.statusError.classList.toggle('hidden', !msg);
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('forge-theme', t);
}
applyTheme(localStorage.getItem('forge-theme') || 'light');

/* ---------------- markdown (no deps) ---------------- */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineMd(s) {
  s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}
function renderMarkdown(text) {
  text = String(text).replace(/\r\n/g, '\n');
  const out = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text))) {
    if (m.index > last) out.push(renderText(text.slice(last, m.index)));
    out.push(`<pre class="block">${m[1] ? `<span class="lang">${esc(m[1])}</span>` : ''}${esc(m[2].replace(/\n$/, ''))}</pre>`);
    last = m.index + m[0].length;
  }
  out.push(renderText(text.slice(last)));
  return out.join('');
}
function renderText(text) {
  const lines = text.split('\n');
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inlineMd(esc(para.join(' ')))}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html += `<${list.tag}>` + list.items.map((i) => `<li>${inlineMd(esc(i))}</li>`).join('') + `</${list.tag}>`;
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      html += `<h${lvl}>${inlineMd(esc(h[2]))}</h${lvl}>`;
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      html += `<blockquote>${inlineMd(esc(bq[1]))}</blockquote>`;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return html;
}

/* ---------------- rendering: messages ---------------- */

function clearMessages() {
  els.messages.innerHTML = '';
  state.assistantEl = null;
  state.thinkingEl = null;
  state.lastAssistantBubble = null;
  state.turnEdits = [];
  state.pendingToolCards.clear();
  state.cardsByCallId.clear();
}

function appendUser(message) {
  state.assistantEl = null;
  state.thinkingEl = null;
  const wrap = el('div', { class: 'msg msg-user' }, [el('div', { class: 'bubble', text: message })]);
  els.messages.appendChild(wrap);
  scrollTop();
}

function ensureAssistant() {
  if (state.assistantEl) return state.assistantEl;
  const wrap = el('div', { class: 'msg msg-assistant' });
  const bubble = el('div', { class: 'bubble md cursor' });
  bubble.__raw = '';
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  state.assistantEl = bubble;
  return bubble;
}
function renderAssistantText(bubble, text) {
  bubble.innerHTML = renderMarkdown(text);
  scrollTop();
}
function appendText(text) {
  const bubble = ensureAssistant();
  bubble.__raw += text;
  renderAssistantText(bubble, bubble.__raw);
}
function appendReasoning(text) {
  let t = state.thinkingEl;
  if (!t) {
    const bubble = ensureAssistant();
    t = el('div', { class: 'thinking' });
    bubble.appendChild(t);
    state.thinkingEl = t;
  }
  t.textContent += text;
  scrollTop();
}
function endAssistant(mid) {
  const bubble = state.assistantEl;
  if (bubble) {
    bubble.classList.remove('cursor');
    attachActions(bubble, mid);
    state.lastAssistantBubble = bubble;
  }
  state.assistantEl = null;
  state.thinkingEl = null;
}
function attachActions(bubble, mid) {
  const wrap = bubble.parentElement;
  const prev = wrap.querySelector('.msg-actions');
  if (prev) prev.remove();
  const row = el('div', { class: 'msg-actions' });
  row.appendChild(
    el('button', {
      title: 'Copy',
      html: SVG.copy,
      onclick: () => {
        navigator.clipboard?.writeText(bubble.__raw || bubble.textContent).catch(() => {});
      },
    })
  );
  if (mid) {
    const fb = bubble.dataset.feedback || null;
    const upBtn = el('button', { title: 'Good response', html: SVG.up, class: fb === 'up' ? 'on' : '', onclick: () => rate(mid, 'up', bubble) });
    const downBtn = el('button', { title: 'Bad response', html: SVG.down, class: fb === 'down' ? 'on' : '', onclick: () => rate(mid, 'down', bubble) });
    row.appendChild(upBtn);
    row.appendChild(downBtn);
  }
  wrap.appendChild(row);
}
async function rate(mid, feedback, bubble) {
  const next = (bubble.dataset.feedback || null) === feedback ? null : feedback;
  bubble.dataset.feedback = next || '';
  try {
    await api('POST', '/api/feedback', { messageId: mid, feedback: next });
    const row = bubble.parentElement.querySelector('.msg-actions');
    const [copyB, upB, downB] = row.querySelectorAll('button');
    if (upB) upB.classList.toggle('on', next === 'up');
    if (downB) downB.classList.toggle('on', next === 'down');
  } catch {
    /* ignore */
  }
}

function statusLabel(s) {
  return { ok: 'done', error: 'error', denied: 'denied', timeout: 'timeout', running: 'running…', stopped: 'stopped' }[s] || s;
}

function buildToolCard({ callId, name, argsText, status, result, diff }) {
  const card = el('details', { class: 'tool-card' });
  const statusEl = el('span', { class: `tool-status ${status || 'running'}`, text: statusLabel(status) });
  card.appendChild(
    el('summary', {}, [el('span', { class: 'tool-name', text: name || '…' }), el('span', { class: 'tool-args-summary', text: (argsText || '').slice(0, 120) }), statusEl])
  );
  const body = el('div', { class: 'tool-body' });
  card.appendChild(body);
  card.__apply = (patch) => applyToolUpdate(card, patch);
  applyToolUpdate(card, { name, argsText, status, result, diff });
  return card;
}
function prettyJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
function applyToolUpdate(card, { name, argsText, status, result, diff }) {
  const summary = card.querySelector('summary');
  const statusEl = card.querySelector('.tool-status');
  const body = card.querySelector('.tool-body');
  if (name) summary.querySelector('.tool-name').textContent = name;
  if (status) {
    statusEl.textContent = statusLabel(status);
    statusEl.className = `tool-status ${status}`;
  }
  if (argsText !== undefined && argsText !== null) summary.querySelector('.tool-args-summary').textContent = argsText.slice(0, 120);
  body.innerHTML = '';
  if (argsText) body.appendChild(el('h4', { text: 'arguments' }), el('pre', { class: 'args', text: prettyJson(argsText) }));
  if (diff && diff.length) {
    body.appendChild(el('h4', { text: 'diff' }));
    const diffBox = el('div', { class: 'diff' });
    for (const line of diff) diffBox.appendChild(el('span', { class: `diff-line ${line.type}`, text: `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'ctx' ? ' ' : ''} ${line.text}` }));
    body.appendChild(diffBox);
  }
  if (result !== undefined && result !== null) body.appendChild(el('h4', { text: 'result' }), el('pre', { class: 'result', text: String(result) }));
  if (status === 'error' || status === 'denied' || status === 'timeout') card.open = true;
}

function renderPermission({ requestId, toolName, description }) {
  endAssistant();
  const card = el('div', { class: 'perm-card' });
  card.appendChild(el('div', { class: 'perm-title', text: 'forge wants to:' }));
  card.appendChild(el('div', { class: 'perm-desc', text: description }));
  const actions = el('div', { class: 'perm-actions' });
  const answer = async (decision) => {
    actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api('POST', '/api/permission', { requestId, decision });
      card.querySelector('.perm-actions').replaceWith(el('div', { class: 'perm-answered', text: `${decision} ✓` }));
    } catch (err) {
      setStatusError(err.message);
      actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };
  actions.appendChild(
    el('button', { class: 'btn primary', onclick: () => answer('allow'), text: 'Allow' }),
    el('button', { class: 'btn', onclick: () => answer('always'), text: 'Always allow this tool' }),
    el('button', { class: 'btn danger', onclick: () => answer('deny'), text: 'Deny' })
  );
  card.appendChild(actions);
  els.messages.appendChild(card);
  scrollTop();
}

function langOf(p) {
  const ext = String(p).includes('.') ? String(p).split('.').pop().toLowerCase() : '';
  const map = { js: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX', py: 'PY', json: 'JSON', md: 'MD', html: 'HTML', css: 'CSS', go: 'GO', rs: 'RS', sh: 'SH' };
  return map[ext] || (ext ? ext.toUpperCase().slice(0, 4) : 'FILE');
}
function renderEditsSummary() {
  const edits = state.turnEdits.filter((e) => e.diff && e.diff.length);
  if (!edits.length) return;
  const files = new Map();
  for (const e of edits) {
    const key = e.path || e.name;
    const cur = files.get(key) || { path: e.path || e.name, add: 0, del: 0, diffs: [] };
    for (const l of e.diff) {
      if (l.type === 'add') cur.add++;
      if (l.type === 'del') cur.del++;
    }
    cur.diffs.push({ name: e.name, diff: e.diff });
    files.set(key, cur);
  }
  const list = [...files.values()];
  const totalAdd = list.reduce((n, f) => n + f.add, 0);
  const totalDel = list.reduce((n, f) => n + f.del, 0);
  const card = el('div', { class: 'edits-card' });
  card.appendChild(
    el('div', { class: 'edits-head' }, [
      el('span', { class: 't', text: `Edited ${list.length} file${list.length === 1 ? '' : 's'}` }),
      el('span', { class: 'edits-stat', html: `<span class="add">+${totalAdd}</span> <span class="del">-${totalDel}</span>` }),
    ])
  );
  const MAX_ROWS = 4;
  const rowFor = (f) =>
    el('div', { class: 'edits-row', onclick: () => openFileDiff(f) }, [
      el('span', { class: 'f-lang', text: langOf(f.path) }),
      el('span', { class: 'f-name', text: f.path }),
      el('span', { class: 'edits-stat', html: `<span class="add">+${f.add}</span> <span class="del">-${f.del}</span>` }),
    ]);
  for (const f of list.slice(0, MAX_ROWS)) card.appendChild(rowFor(f));
  if (list.length > MAX_ROWS) {
    const rest = list.slice(MAX_ROWS);
    const more = el('button', {
      class: 'edits-more',
      text: `Show ${rest.length} more`,
      onclick: () => {
        more.remove();
        for (const f of rest) card.insertBefore(rowFor(f), more);
      },
    });
    card.appendChild(more);
  }
  els.messages.appendChild(card);
  scrollTop();
}
function openFileDiff(f) {
  let card = buildToolCard({ name: f.path, argsText: '', status: 'ok', diff: [] });
  const merged = [];
  for (const d of f.diffs) merged.push(...d.diff);
  card.__apply({ name: f.path, status: 'ok', diff: merged });
  card.open = true;
  els.messages.appendChild(card);
  scrollTop();
}

function renderEvent(ev) {
  switch (ev.type) {
    case 'user':
      appendUser(ev.message);
      break;
    case 'reasoning_delta':
      appendReasoning(ev.text);
      break;
    case 'text_delta':
      state.thinkingEl = null;
      appendText(ev.text);
      break;
    case 'message_end':
      endAssistant(ev.messageId);
      break;
    case 'tool_args_delta': {
      const idx = ev.callIndex ?? 0;
      let card = state.pendingToolCards.get(idx);
      if (!card) {
        card = buildToolCard({ callIndex: idx, name: ev.toolName || 'tool', argsText: ev.argsFragment || '', status: 'running' });
        state.pendingToolCards.set(idx, card);
        els.messages.appendChild(card);
      } else if (ev.argsFragment) {
        card.__apply({ argsText: (card.__args || '') + ev.argsFragment, name: ev.toolName || undefined });
      }
      if (ev.id) {
        card.__callId = ev.id;
        state.cardsByCallId.set(ev.id, card);
      }
      card.__args = (card.__args || '') + (ev.argsFragment || '');
      if (ev.toolName) card.__name = ev.toolName;
      break;
    }
    case 'tool_start': {
      let card = state.cardsByCallId.get(ev.callId) || state.pendingToolCards.get(0);
      if (!card || card.__callId !== ev.callId) {
        card = null;
        for (const [, c] of state.pendingToolCards) {
          if (!c.__done && (c.__callId === ev.callId || c.__callId === undefined)) {
            card = c;
            state.pendingToolCards.delete(card.__idx ?? 0);
            break;
          }
        }
      }
      if (!card) card = buildToolCard({ callId: ev.callId, name: ev.name, argsText: ev.argsText, status: 'running' });
      else {
        card.__callId = ev.callId;
        card.__apply({ name: ev.name, argsText: ev.argsText, status: 'running' });
      }
      state.cardsByCallId.set(ev.callId, card);
      scrollTop();
      break;
    }
    case 'tool_end': {
      let card = state.cardsByCallId.get(ev.callId);
      if (card) {
        card.__done = true;
        card.__apply({ name: ev.name, status: ev.status, result: ev.result, diff: ev.diff });
      } else {
        card = buildToolCard({ callId: ev.callId, name: ev.name, argsText: '', status: ev.status, result: ev.result, diff: ev.diff });
        card.__done = true;
        els.messages.appendChild(card);
      }
      if (ev.diff && ev.diff.length) state.turnEdits.push({ name: ev.name, path: pathFromArgs(card), diff: ev.diff });
      scrollTop();
      break;
    }
    case 'permission_request':
      renderPermission(ev);
      break;
    case 'usage':
      state.lastUsage = ev.total;
      renderUsage();
      break;
    case 'retry':
      setStatusError(`LLM hiccup (${ev.attempt}): ${ev.error} — retrying…`);
      break;
    case 'turn_end':
      endAssistant();
      renderEditsSummary();
      setRunning(false);
      if (ev.error) setStatusError(`LLM error: ${ev.error}`);
      else setStatusError('');
      if (ev.stopped) appendSystemNote('⏹ Stopped by user.');
      break;
    case 'stream_end':
      endAssistant();
      setRunning(false);
      break;
    default:
      break;
  }
}
function pathFromArgs(card) {
  try {
    const a = JSON.parse(card.__args || '{}');
    return a.path || a.new_path || card.__name || 'file';
  } catch {
    return card.__name || 'file';
  }
}
function appendSystemNote(text) {
  els.messages.appendChild(el('div', { class: 'msg', html: `<div class="hint">${text}</div>` }));
  scrollTop();
}
function renderUsage() {
  const u = state.lastUsage;
  if (!u) {
    els.tokens.classList.add('hidden');
    return;
  }
  els.tokens.classList.remove('hidden');
  els.tokens.textContent = `${u.promptTokens}↑ ${u.completionTokens}↓ ${u.totalTokens} Σ`;
}

/* ---------------- welcome screens ---------------- */

function greetingWord() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}
function displayName() {
  const n = (els.userName.textContent || '').trim();
  return n && n !== 'forge' ? n : '';
}
function renderWelcome() {
  els.messages.innerHTML = '';
  if (state.agentMode === 'chat') {
    const w = el('div', { class: 'welcome centered' }, [
      el('h1', { class: 'greeting' }, [el('span', { class: 'burst', text: '✳' }), el('span', { text: `Good ${greetingWord()}, ${state.userName.textContent || 'there'}` })]),
    ]);
    els.messages.appendChild(w);
    return;
  }
  const name = displayName();
  const w = el('div', { class: 'welcome' });
  w.appendChild(el('h1', { class: 'greeting' }, [el('span', { class: 'burst', text: '✳' }), el('span', { text: `What's up next${name ? ', ' + name : ''}?` })]));
  const card = el('div', { class: 'stats-card' });
  const tabs = el('div', { class: 'stats-tabs' }, [
    el('button', { class: 'stats-tab' + (state.statsTab === 'overview' ? ' active' : ''), text: 'Overview', onclick: () => setStatsTab('overview') }),
    el('button', { class: 'stats-tab' + (state.statsTab === 'models' ? ' active' : ''), text: 'Models', onclick: () => setStatsTab('models') }),
    el('div', { class: 'range-tabs' }, ['all', '30d', '7d'].map((r) => el('button', { class: 'range-tab' + (state.statsRange === r ? ' active' : ''), text: r === 'all' ? 'All' : r, onclick: () => setStatsRange(r) }))),
  ]);
  card.appendChild(tabs);
  card.appendChild(el('div', { id: 'stats-body', text: '…' }));
  w.appendChild(card);
  els.messages.appendChild(w);
  loadStats();
}
async function loadStats() {
  try {
    const s = await api('GET', `/api/stats?range=${state.statsRange}`);
    state.stats = s;
    renderStats();
  } catch {
    /* ignore */
  }
}
function renderStats() {
  const body = $('#stats-body');
  if (!body || !state.stats) return;
  const s = state.stats;
  body.innerHTML = '';
  if (state.statsTab === 'overview') {
    const tiles = el('div', { class: 'stats-grid' });
    const grid = [
      ['Sessions', fmt(s.sessions)],
      ['Messages', fmt(s.messages)],
      ['Total tokens', fmtTokens(s.totalTokens)],
      ['Active days', fmt(s.activeDays)],
      ['Peak hour', fmtHour(s.peakHour)],
      ['Favorite model', s.favoriteModel || '—'],
    ];
    for (const [k, v] of grid) tiles.appendChild(el('div', { class: 'stat-tile' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: String(v) })]));
    body.appendChild(tiles);
    body.appendChild(renderHeatmap(s.heatmap));
    body.appendChild(el('div', { class: 'stats-foot', text: `You've used ${fmtTokens(s.totalTokens)} tokens across ${s.sessions} sessions.` }));
  } else {
    const list = el('div', { class: 'model-list' });
    if (!s.models || !s.models.length) list.appendChild(el('div', { class: 'stats-foot', text: 'No model usage yet.' }));
    for (const m of s.models) list.appendChild(el('div', { class: 'model-row' }, [el('span', { class: 'm', text: m.model }), el('span', { class: 'n', text: `${fmt(m.messages)} msgs · ${fmtTokens(m.tokens)} tokens` })]));
    body.appendChild(list);
  }
}
function renderHeatmap(heatmap) {
  const box = el('div', { class: 'heatmap' });
  const map = new Map((heatmap || []).map((d) => [d.date, d.messages]));
  const max = Math.max(1, ...[...map.values()]);
  const days = 91;
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const n = map.get(key) || 0;
    box.appendChild(el('div', { class: 'heat-cell', title: `${key}: ${n}`, style: heatStyle(n, max) }));
  }
  return box;
}
function heatStyle(n, max) {
  if (!n) return '';
  const t = Math.min(1, n / max);
  const alpha = 0.2 + 0.8 * t;
  return `background: rgba(217,119,87,${alpha.toFixed(2)})`;
}
function setStatsTab(t) {
  state.statsTab = t;
  renderWelcome();
}
function setStatsRange(r) {
  state.statsRange = r;
  renderWelcome();
}
function fmt(n) {
  return (n || 0).toLocaleString();
}
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtHour(h) {
  if (h == null) return '—';
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

/* ---------------- sessions ---------------- */

async function loadSessions() {
  const q = els.search.value.trim();
  const mode = state.agentMode;
  let sessions = [];
  try {
    if (mode === 'chat') {
      sessions = (await api('GET', `/api/sessions?mode=chat${q ? `&query=${encodeURIComponent(q)}` : ''}`)).sessions;
    } else {
      const ws = els.workspace.value.trim();
      if (!ws) return renderGroups([], true);
      sessions = (await api('GET', `/api/sessions?workspace=${encodeURIComponent(ws)}${q ? `&query=${encodeURIComponent(q)}` : ''}`)).sessions;
    }
  } catch (err) {
    return renderGroups([], false, err.message);
  }
  renderGroups(sessions);
}

function dateBucket(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yday = new Date();
  yday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yday)) return 'Yesterday';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function renderGroups(sessions, empty = false, error = '') {
  els.sessionGroups.innerHTML = '';
  if (error) return els.sessionGroups.appendChild(el('div', { class: 'hint', text: error }));
  if (empty && state.agentMode === 'code' && !els.workspace.value.trim()) return;
  if (!sessions.length) return els.sessionGroups.appendChild(el('div', { class: 'hint', text: 'No conversations yet.' }));
  const groups = new Map();
  for (const s of sessions) {
    const b = dateBucket(s.updatedAt);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(s);
  }
  for (const [label, items] of groups) {
    els.sessionGroups.appendChild(el('div', { class: 'group-label', text: label }));
    for (const s of items) {
      const item = el('button', { class: 'session-item' + (s.id === state.sessionId ? ' active' : ''), onclick: () => openSession(s.id) }, [
        el('span', { class: 's-ico', html: s.mode === 'chat' ? SVG.chat : SVG.code }),
        el('span', { class: 's-title', text: s.title }),
        el('span', {
          class: 's-del',
          html: '✕',
          title: 'Delete',
          onclick: (e) => {
            e.stopPropagation();
            removeSession(s.id);
          },
        }),
      ]);
      els.sessionGroups.appendChild(item);
    }
  }
}

async function removeSession(id) {
  try {
    await api('DELETE', `/api/session?sessionId=${encodeURIComponent(id)}`);
    if (id === state.sessionId) newChat();
    loadSessions();
  } catch {
    /* ignore */
  }
}

async function openSession(id) {
  const { session, active } = await api('GET', `/api/session?sessionId=${encodeURIComponent(id)}`);
  disconnectEvents();
  state.sessionId = id;
  setAgentMode(session.mode, false);
  if (session.workspace) els.workspace.value = session.workspace;
  localStorage.setItem('forge-last-session-' + (session.workspace || 'chat'), id);
  clearMessages();
  for (const m of session.messages) {
    if (m.role === 'user') appendUser(m.content);
    else if (m.role === 'assistant') {
      if (m.content) {
        const bubble = ensureAssistant();
        bubble.__raw = m.content;
        renderAssistantText(bubble, m.content);
        if (m.feedback) bubble.dataset.feedback = m.feedback;
        endAssistant(m.id);
      }
      for (const tc of m.tool_calls || []) {
        const card = buildToolCard({ callId: tc.id, name: tc.function.name, argsText: tc.function.arguments, status: 'ok' });
        state.cardsByCallId.set(tc.id, card);
        els.messages.appendChild(card);
      }
    } else if (m.role === 'tool') {
      const card = state.cardsByCallId.get(m.tool_call_id);
      if (card) card.__apply({ status: /^Error|Blocked|denied/i.test(m.content) ? 'error' : 'ok', result: m.content });
    }
  }
  if (active) {
    setRunning(true);
    connectEvents(id);
  }
  els.topTitle.textContent = session.title;
  if (session.mode === 'code' && session.workspace) {
    els.topCrumbs.textContent = session.workspace.split('/').filter(Boolean).pop() || session.workspace;
    els.topCrumbs.classList.remove('hidden');
  } else {
    els.topCrumbs.classList.add('hidden');
  }
  loadSessions();
  scrollTop();
}

/* ---------------- SSE ---------------- */

function connectEvents(sessionId) {
  disconnectEvents();
  const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
  state.es = es;
  es.onmessage = (msg) => {
    try {
      renderEvent(JSON.parse(msg.data));
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && state.running) setTimeout(() => state.running && connectEvents(sessionId), 1000);
  };
}
function disconnectEvents() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

/* ---------------- actions ---------------- */

function setRunning(running) {
  state.running = running;
  els.stop.classList.toggle('hidden', !running);
  els.send.classList.toggle('hidden', running);
  els.send.disabled = running;
}

async function send() {
  const message = els.input.value.trim();
  if (!message) return;
  if (state.agentMode === 'code') {
    const ws = els.workspace.value.trim();
    if (!ws) {
      els.workspaceError.textContent = 'Enter a workspace folder first.';
      els.workspace.focus();
      return;
    }
  }
  els.workspaceError.textContent = '';
  if (!state.sessionId) state.sessionId = newSessionId();
  clearMessagesIfWelcome();
  connectEvents(state.sessionId);
  setRunning(true);
  els.input.value = '';
  autosize();
  state.lastUserMessage = message;
  try {
    await api('POST', '/api/chat', {
      sessionId: state.sessionId,
      message,
      agentMode: state.agentMode,
      workspace: state.agentMode === 'code' ? els.workspace.value.trim() : undefined,
      mode: els.modeSelect.value,
    });
    setStatusError('');
  } catch (err) {
    setRunning(false);
    setStatusError(err.message);
  }
  loadSessions();
}
function clearMessagesIfWelcome() {
  if (els.messages.querySelector('.welcome')) els.messages.innerHTML = '';
}
function newSessionId() {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function stop() {
  if (!state.sessionId || !state.running) return;
  els.stop.disabled = true;
  try {
    await api('POST', '/api/stop', { sessionId: state.sessionId });
  } catch {
    /* maybe already finished */
  }
}

function newChat() {
  disconnectEvents();
  state.sessionId = null;
  setRunning(false);
  clearMessages();
  renderWelcome();
  updateTopbar();
  els.input.focus();
}

/* ---------------- mode switching ---------------- */

function setAgentMode(mode, newSession = true) {
  state.agentMode = mode;
  localStorage.setItem('forge-agent-mode', mode);
  els.main.classList.toggle('mode-chat', mode === 'chat');
  els.main.classList.toggle('mode-code', mode === 'code');
  els.modeChatBtn.classList.toggle('active', mode === 'chat');
  els.modeCodeBtn.classList.toggle('active', mode === 'code');
  els.workspaceSection.classList.toggle('hidden', mode === 'chat');
  els.modeWrap.classList.toggle('hidden', mode === 'chat');
  els.input.placeholder = mode === 'chat' ? 'How can I help you today?' : 'Describe a task or ask a question…';
  updateTopIcon();
  loadSessions();
  if (newSession) newChat();
}
function updateTopIcon() {
  els.topIcon.innerHTML = state.agentMode === 'chat' ? SVG.chat : SVG.code;
}

function updateTopbar() {
  if (state.sessionId) {
    // title set elsewhere when loaded
  } else {
    els.topTitle.textContent = state.agentMode === 'chat' ? 'New chat' : 'New task';
    els.topCrumbs.classList.add('hidden');
  }
  els.topModel.textContent = state.modelName || '';
}

/* ---------------- workspace / browse ---------------- */

async function browse(path) {
  const data = await api('GET', `/api/browse?path=${encodeURIComponent(path || '')}`);
  els.browsePath.textContent = data.path;
  els.browseList.innerHTML = '';
  for (const d of data.dirs) els.browseList.appendChild(el('button', { class: 'browse-dir', text: `📁 ${d}`, onclick: () => browse(`${data.path.replace(/\/$/, '')}/${d}`) }));
  els.browseUp.onclick = () => data.parent && browse(data.parent);
}

/* ---------------- settings ---------------- */

async function openSettings() {
  const cfg = await api('GET', '/api/config');
  $('#set-baseurl').value = cfg.baseURL;
  $('#set-model').value = cfg.model;
  $('#set-maxsteps').value = cfg.maxSteps;
  $('#set-contextlimit').value = cfg.contextLimit;
  $('#set-apikey').value = '';
  $('#set-apikey-hint').textContent = cfg.hasApiKey ? `current: ${cfg.apiKeyMasked} (leave empty to keep)` : 'no key set';
  $('#settings-msg').textContent = '';
  els.settingsModal.showModal();
}
async function saveSettings(e) {
  if (e.submitter && e.submitter.value !== 'save') return;
  e.preventDefault();
  const patch = { baseURL: $('#set-baseurl').value.trim(), model: $('#set-model').value.trim(), maxSteps: Number($('#set-maxsteps').value) || 50, contextLimit: Number($('#set-contextlimit').value) || 100000 };
  const key = $('#set-apikey').value;
  if (key) patch.apiKey = key;
  try {
    await api('PUT', '/api/config', patch);
    setStatusModel();
    checkLlm();
    els.settingsModal.close();
  } catch (err) {
    $('#settings-msg').textContent = `Failed: ${err.message}`;
  }
}
async function setStatusModel() {
  const cfg = await api('GET', '/api/config');
  state.modelName = cfg.model;
  els.topModel.textContent = cfg.model;
}
async function checkLlm() {
  const dot = els.llmStatus;
  try {
    const s = await api('GET', '/api/llm-status');
    if (s.ok) {
      els.topDot.className = 'dot llm-ok';
      els.topDot.title = 'LLM reachable';
      dot.textContent = '●';
      dot.className = 'status-llm llm-ok';
    } else {
      els.topDot.className = 'dot llm-bad';
      els.topDot.title = s.error || 'LLM unreachable';
      dot.textContent = '●';
      dot.className = 'status-llm llm-bad';
    }
  } catch {
    els.topDot.className = 'dot llm-bad';
    dot.textContent = '●';
    dot.className = 'status-llm llm-bad';
  }
}

/* ---------------- init ---------------- */

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}

async function init() {
  els.modeSelect.value = localStorage.getItem('forge-mode') || 'ask';
  els.workspace.value = localStorage.getItem('forge-workspace') || '';

  els.themeToggle.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  els.send.addEventListener('click', send);
  els.stop.addEventListener('click', stop);
  els.newChat.addEventListener('click', newChat);
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsForm.addEventListener('submit', saveSettings);
  els.modeChatBtn.addEventListener('click', () => setAgentMode('chat'));
  els.modeCodeBtn.addEventListener('click', () => setAgentMode('code'));
  els.search.addEventListener('input', () => loadSessions());
  els.browseBtn.addEventListener('click', () => {
    els.browseModal.showModal();
    browse(els.workspace.value || '');
  });
  els.browseClose.addEventListener('click', () => els.browseModal.close());
  els.browseChoose.addEventListener('click', () => {
    els.workspace.value = els.browsePath.textContent;
    localStorage.setItem('forge-workspace', els.workspace.value);
    els.browseModal.close();
    loadSessions();
  });
  els.workspace.addEventListener('change', () => {
    localStorage.setItem('forge-workspace', els.workspace.value.trim());
    loadSessions();
  });
  els.modeSelect.addEventListener('change', () => localStorage.setItem('forge-mode', els.modeSelect.value));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.running) stop();
  });
  els.input.addEventListener('input', autosize);
  els.messages.addEventListener('scroll', () => els.scrollBtn.classList.toggle('hidden', isAtBottom()));
  els.scrollBtn.addEventListener('click', scrollTop);

  await setStatusModel();
  await checkLlm();
  setInterval(checkLlm, 20000);

  // user identity
  try {
    const s = await api('GET', '/api/stats?range=all');
    if (s.user) {
      els.userName.textContent = s.user;
      els.userAvatar.textContent = s.user.slice(0, 1).toUpperCase();
    }
  } catch {
    /* ignore */
  }

  setAgentMode(state.agentMode, false);

  if (state.agentMode === 'code' && els.workspace.value.trim()) {
    const last = localStorage.getItem('forge-last-session-' + els.workspace.value.trim());
    if (last) {
      try {
        await openSession(last);
        return;
      } catch {
        /* fall through */
      }
    }
  }
  renderWelcome();
  els.input.focus();
}

init();
