/* Halo AI Harness web UI — Chat + Code modes, SQLite-backed sessions, reference-inspired look */
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
  reasoning: $('#reasoning-select'),
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
  mascot: $('#mascot'),
  todoPanel: $('#todo-panel'),
  attachBtn: $('#attach-btn'),
  attachInput: $('#attach-input'),
  attachTray: $('#attach-tray'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightbox-img'),
  lightboxCaption: $('#lightbox-caption'),
  lightboxClose: $('#lightbox-close'),
  browserPanel: $('#browser-panel'),
  bpUrl: $('#bp-url'),
  bpStatus: $('#bp-status'),
  bpDot: $('#bp-dot'),
  bpClose: $('#bp-close'),
  bpImg: $('#bp-img'),
  bpEmpty: $('#bp-empty'),
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
  browserCard: null, // live browser card for the current turn (updated in place)
  panelOpen: false,
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

/* ---------------- mascot ---------------- */

const mascot = { state: 'idle', typingTimer: null };
function setMascotState(next) {
  if (!els.mascot || mascot.state === next) return;
  mascot.state = next;
  els.mascot.setAttribute('data-state', next);
}

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
  state.browserCard = null;
}

function appendUser(message, images = []) {
  finalizeThinking();
  state.assistantEl = null;
  const wrap = el('div', { class: 'msg msg-user' });
  if (message) wrap.appendChild(el('div', { class: 'bubble', text: message }));
  if (images.length) {
    const strip = el('div', { class: 'msg-images' });
    for (const id of images) {
      const pic = el('img', { class: 'msg-image', src: `/api/images/${encodeURIComponent(id)}`, alt: 'attached image', onclick: () => openLightbox(`/api/images/${encodeURIComponent(id)}`, 'Attached image') });
      strip.appendChild(pic);
    }
    wrap.appendChild(strip);
  }
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
    const details = el('details', { class: 'think-block' });
    details.open = true;
    const label = el('span', { class: 'think-label', text: 'Thinking…' });
    const summary = el('summary', { class: 'think-summary' }, [el('span', { class: 'think-ico', html: haloIconSvg('halo-spin') }), label]);
    const body = el('div', { class: 'think-body' });
    details.appendChild(summary);
    details.appendChild(body);
    bubble.appendChild(details);
    t = { details, summary, label, body, startedAt: Date.now() };
    t.timer = setInterval(() => {
      const secs = Math.max(1, Math.round((Date.now() - t.startedAt) / 1000));
      label.textContent = `Thinking… ${secs}s`;
    }, 1000);
    state.thinkingEl = t;
  }
  t.body.textContent += text;
  scrollTop();
}
function finalizeThinking() {
  const t = state.thinkingEl;
  if (!t) return;
  clearInterval(t.timer);
  const secs = Math.max(1, Math.round((Date.now() - t.startedAt) / 1000));
  t.label.textContent = `Thought for ${secs}s`;
  const ico = t.summary.querySelector('.think-ico');
  if (ico) ico.innerHTML = haloIconSvg('');
  t.details.open = false;
  state.thinkingEl = null;
}
function endAssistant(mid) {
  finalizeThinking();
  const bubble = state.assistantEl;
  if (bubble) {
    bubble.classList.remove('cursor');
    attachActions(bubble, mid);
    state.lastAssistantBubble = bubble;
  }
  state.assistantEl = null;
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
  card.appendChild(el('div', { class: 'perm-title', text: 'Halo AI Harness wants to:' }));
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
      appendUser(ev.message, ev.images || []);
      break;
    case 'reasoning_delta':
      setMascotState('thinking');
      appendReasoning(ev.text);
      break;
    case 'text_delta':
      setMascotState('talking');
      finalizeThinking();
      appendText(ev.text);
      break;
    case 'message_end':
      endAssistant(ev.messageId);
      break;
    case 'tool_args_delta': {
      finalizeThinking();
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
      finalizeThinking();
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
      setMascotState('waiting');
      renderPermission(ev);
      break;
    case 'usage':
      state.lastUsage = ev.total;
      renderUsage();
      updateContextMeter();
      break;
    case 'todo_update':
      renderTodos(ev.todos);
      break;
    case 'handoff_delta': {
      if (!state.handoffEl) state.handoffEl = newHandoffCard(true);
      state.handoffEl.raw += ev.text;
      state.handoffEl.body.innerHTML = renderMarkdown(state.handoffEl.raw);
      scrollTop();
      break;
    }
    case 'handoff': {
      if (state.handoffEl) {
        state.handoffEl.details.classList.remove('streaming');
        state.handoffEl.details.open = false;
        const t = state.handoffEl.details.querySelector('.handoff-title');
        if (t) t.textContent = 'Context handoff — continuing from this summary';
        const h = state.handoffEl.details.querySelector('.handoff-halo');
        if (h) h.innerHTML = haloIconSvg('');
        state.handoffEl.body.innerHTML = renderMarkdown(ev.summary || state.handoffEl.raw);
        state.handoffEl = null;
      } else {
        renderHandoff(ev.summary);
      }
      break;
    }
    case 'retry':
      setStatusError(`LLM hiccup (${ev.attempt}): ${ev.error} — retrying…`);
      break;
    case 'browser_page':
      showBrowserCard(ev);
      break;
    case 'browser_screenshot':
      appendShotFigure(ev);
      break;
    case 'turn_end':
      setMascotState('idle');
      endAssistant();
      renderEditsSummary();
      setRunning(false);
      if (ev.error) setStatusError(`LLM error: ${ev.error}`);
      else setStatusError('');
      if (ev.stopped) appendSystemNote('⏹ Stopped by user.');
      if (state.browserCard && !state.panelOpen) stopBrowserCast(); // frames only while the agent works
      updateContextMeter();
      break;
    case 'stream_end':
      if (!state.running) setMascotState('idle');
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

/* ---------------- todo panel ---------------- */

function renderTodos(todos) {
  const panel = els.todoPanel;
  if (!panel) return;
  panel.innerHTML = '';
  if (!todos || !todos.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const done = todos.filter((t) => t.status === 'completed').length;
  panel.appendChild(
    el('div', { class: 'todo-head' }, [
      el('span', { class: 't', text: 'Tasks' }),
      el('span', { class: 'n', text: `${done}/${todos.length}` }),
    ])
  );
  const list = el('div', { class: 'todo-list' });
  for (const t of todos) {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
    list.appendChild(
      el('div', { class: `todo-item ${t.status}` }, [el('span', { class: 'todo-ico', text: icon }), el('span', { class: 'todo-text', text: t.content })])
    );
  }
  panel.appendChild(list);
}

/* ---------------- context meter ---------------- */

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const CtxRingC = 56.5;
let ctxPopupOpen = false;

function hideCtxMeter() {
  $('#ctx-meter')?.classList.add('hidden');
  hideCtxPopup();
}

async function updateContextMeter() {
  if (state.agentMode !== 'code' || !state.sessionId) {
    hideCtxMeter();
    return;
  }
  try {
    const d = await api('GET', `/api/context?sessionId=${encodeURIComponent(state.sessionId)}`);
    renderCtxMeter(d);
    if (ctxPopupOpen) renderCtxPopup(d);
  } catch {
    /* keep previous reading */
  }
}

function renderCtxMeter(d) {
  const btn = $('#ctx-meter');
  if (!btn) return;
  btn.classList.remove('hidden');
  const frac = Math.max(0, Math.min(1, d.used / d.limit));
  const ring = $('#ctx-ring');
  if (ring) {
    ring.setAttribute('stroke-dashoffset', String((CtxRingC * (1 - frac)).toFixed(1)));
    const color = frac >= 0.9 ? 'var(--danger)' : frac >= 0.7 ? '#d97706' : 'var(--ok)';
    ring.setAttribute('stroke', color);
  }
  const pct = $('#ctx-pct');
  if (pct) {
    pct.textContent = `${Math.round(frac * 100)}%`;
    pct.style.color = frac >= 0.9 ? 'var(--danger)' : frac >= 0.7 ? '#d97706' : 'var(--text-dim)';
  }
}

function renderCtxPopup(d) {
  const parts = $('#ctx-parts');
  const total = $('#ctx-total');
  const note = $('#ctx-note');
  if (!parts) return;
  parts.innerHTML = '';
  const max = Math.max(1, ...d.parts.map((p) => p.tokens));
  for (const p of d.parts) {
    const row = el('div', { class: 'ctx-row' });
    row.appendChild(el('span', { class: 'ctx-k', text: p.label }));
    const barWrap = el('span', { class: 'ctx-bar' });
    const bar = el('span', { class: 'ctx-bar-fill' });
    bar.style.width = `${Math.max(1, Math.round((p.tokens / max) * 100))}%`;
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(el('span', { class: 'ctx-v', text: fmtTokens(p.tokens) }));
    parts.appendChild(row);
  }
  if (total) total.textContent = ` ${fmtTokens(d.used)} / ${fmtTokens(d.limit)} (${Math.round((d.used / d.limit) * 100)}%)`;
  if (note) note.textContent = d.actual ? 'Uses real token counts from the API where available.' : 'Estimated (no API usage reported yet).';
}

function hideCtxPopup() {
  ctxPopupOpen = false;
  $('#ctx-popup')?.classList.add('hidden');
}

function toggleCtxPopup(force) {  const popup = $('#ctx-popup');
  if (!popup) return;
  ctxPopupOpen = force !== undefined ? force : !ctxPopupOpen;
  popup.classList.toggle('hidden', !ctxPopupOpen);
  if (ctxPopupOpen) updateContextMeter();
}

/* ---------------- context handoff ---------------- */

function haloIconSvg(cls) {
  return `<svg class="${cls}" viewBox="0 0 36 22" width="18" height="11" aria-hidden="true"><ellipse cx="18" cy="11" rx="13.5" ry="6" fill="none" stroke="#e8542f" stroke-width="4.5"/><ellipse cx="18" cy="10" rx="13.5" ry="6" fill="none" stroke="#ff8a5c" stroke-width="2.2"/></svg>`;
}

function newHandoffCard(streaming) {
  const details = el('details', { class: 'handoff-card' + (streaming ? ' streaming' : '') });
  details.open = streaming;
  const head = el('summary', { class: 'handoff-head' });
  head.appendChild(el('span', { class: 'handoff-halo', html: haloIconSvg(streaming ? 'halo-spin' : '') }));
  head.appendChild(el('span', { class: 'handoff-title', text: streaming ? 'Writing context handoff…' : 'Context handoff — continuing from this summary' }));
  const body = el('div', { class: 'handoff-body md' });
  details.appendChild(head);
  details.appendChild(body);
  els.messages.appendChild(details);
  scrollTop();
  return { details, body, raw: '', streaming };
}

function renderHandoff(summary) {
  const card = newHandoffCard(false);
  card.body.innerHTML = renderMarkdown(summary || '');
  return card;
}

/* ---------------- browser card + inline screenshots ---------------- */

const BROWSER_CARD_NAME = 'forge:browser-card';
const SCREENSHOT_NAME = 'forge:screenshot';

const browserLive = { es: null, lastFrameAt: 0 };
const browserBusSubs = new Set(); // extra consumers (side panel, §6) subscribe here

function hostOf(url) {
  if (!url) return '(no url)';
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}

function onBrowserBus(ev) {
  for (const fn of browserBusSubs) {
    try {
      fn(ev);
    } catch {
      /* one bad subscriber never breaks the browser feed */
    }
  }
  const card = state.browserCard;
  if (ev.type === 'frame') {
    const now = Date.now();
    if (now - browserLive.lastFrameAt < 500) return; // ~2 fps for every consumer
    browserLive.lastFrameAt = now;
    if (card) card.__setPreview(ev.data);
    panelOnFrame(ev.data);
  } else if (ev.type === 'navigation' || ev.type === 'viewport') {
    if (card) card.__setMeta(ev);
    panelOnMeta(ev);
  } else if (ev.type === 'state') {
    if (card) {
      card.__setMeta(ev);
      card.__setStatus(ev.status === 'Closed' ? 'Closed' : 'Live');
    }
    panelOnMeta(ev);
    if (ev.status) panelOnStatus(ev.status === 'Closed' ? 'Closed' : 'Live');
  } else if (ev.type === 'closed') {
    if (card) card.__setStatus('Closed');
    panelOnStatus('Closed');
  }
}

function ensureBrowserLive() {
  if (!state.sessionId) return;
  api('POST', '/api/browser/screencast', { sessionId: state.sessionId }).catch(() => {});
  if (browserLive.es) return;
  const es = new EventSource(`/api/browser/events?sessionId=${encodeURIComponent(state.sessionId)}`);
  browserLive.es = es;
  es.onmessage = (msg) => {
    try {
      onBrowserBus(JSON.parse(msg.data));
    } catch {
      /* ignore */
    }
  };
}

function stopBrowserCast() {
  if (!state.sessionId) return;
  api('POST', '/api/browser/screencast', { sessionId: state.sessionId, start: false }).catch(() => {});
}

function closeBrowserLive() {
  if (browserLive.es) {
    try {
      browserLive.es.close();
    } catch {
      /* ignore */
    }
    browserLive.es = null;
  }
  browserLive.lastFrameAt = 0;
}

function showBrowserCard(ev) {
  ensureBrowserLive();
  if (!state.browserCard) {
    state.browserCard = buildBrowserCard({ url: ev.url || '', title: ev.title || '', viewport: ev.viewport || '', closed: false });
    els.messages.appendChild(state.browserCard);
  } else {
    state.browserCard.__setMeta(ev); // one card per turn, updated in place
  }
  scrollTop();
}

function buildBrowserCard({ url, title, viewport, imageId, closed }) {
  const card = el('div', { class: 'browser-card' + (closed ? ' closed' : '') });
  const data = { url, title, viewport, closed: Boolean(closed) };
  const preview = el('img', { class: 'browser-card-preview', alt: 'Page preview' });
  if (imageId) preview.src = `/api/images/${encodeURIComponent(imageId)}`;
  else preview.classList.add('empty');
  preview.addEventListener('click', () => {
    if (preview.src) openLightbox(preview.src, `${data.title || 'Page'} — ${data.url}`);
  });
  card.appendChild(preview);

  const titleEl = el('div', { class: 'browser-card-title', text: title || '(untitled page)' });
  const subEl = el('div', { class: 'browser-card-sub' });
  const openBtn = el('button', { class: 'browser-card-open', text: 'Open', title: 'Open the browser side panel' });
  openBtn.addEventListener('click', () => openBrowserPanel());
  const menuBtn = el('button', { class: 'browser-card-menu-btn', text: '⋮', title: 'More' });
  const menu = el('div', { class: 'browser-card-menu hidden' });
  const copyItem = el('button', { class: 'browser-card-item', text: 'Copy URL' });
  copyItem.addEventListener('click', () => {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(data.url);
    } catch {
      /* clipboard unavailable */
    }
    menu.classList.add('hidden');
  });
  const extItem = el('a', { class: 'browser-card-item', text: 'Open in my browser', target: '_blank', rel: 'noopener noreferrer', href: url || '#' });
  menu.appendChild(copyItem);
  menu.appendChild(extItem);
  menuBtn.addEventListener('click', () => menu.classList.toggle('hidden'));
  const menuWrap = el('div', { class: 'browser-card-menuwrap' }, [menuBtn, menu]);
  const actions = el('div', { class: 'browser-card-actions' }, [openBtn, menuWrap]);
  card.appendChild(el('div', { class: 'browser-card-meta' }, [titleEl, subEl, actions]));

  function render() {
    subEl.textContent = `${hostOf(data.url)} · ${data.closed ? 'Closed' : 'Live'}`;
    extItem.setAttribute('href', data.url || '#');
    card.classList.remove('closed');
    card.classList.add('live');
    if (data.closed) card.classList.add('closed');
  }
  render();
  card.__setPreview = (src) => {
    preview.src = src;
    preview.classList.remove('empty');
  };
  card.__setMeta = (patch) => {
    if (patch.url !== undefined && patch.url !== null) data.url = patch.url;
    if (patch.title !== undefined && patch.title !== null && patch.title !== '') data.title = patch.title;
    if (patch.viewport !== undefined && patch.viewport !== null) data.viewport = patch.viewport;
    titleEl.textContent = data.title || '(untitled page)';
    render();
  };
  card.__setStatus = (s) => {
    data.closed = s === 'Closed';
    render();
  };
  return card;
}

function renderStoredBrowserCard(m) {
  let d = null;
  try {
    d = JSON.parse(m.content) || null;
  } catch {
    return;
  }
  if (!d) return;
  const card = buildBrowserCard({ url: d.url || '', title: d.title || '', viewport: d.viewport || '', imageId: d.imageId || null, closed: true });
  els.messages.appendChild(card);
}

function appendShotFigure({ imageId, url = '', viewport = '', full = false, title = '' }) {
  if (!imageId) return null;
  const src = `/api/images/${encodeURIComponent(imageId)}`;
  const caption = `${url}${viewport ? ` · ${viewport}` : ''}${full ? ' · full page' : ''}`;
  const fig = el('figure', { class: 'shot-figure' });
  const img = el('img', { class: 'shot-img', src, alt: 'Screenshot' });
  img.addEventListener('click', () => openLightbox(src, caption));
  fig.appendChild(img);
  fig.appendChild(el('figcaption', { class: 'shot-caption', text: caption }));
  els.messages.appendChild(fig);
  scrollTop();
  return fig;
}

/** Parse a persisted screenshot message back into { imageId, url, viewport }. */
function shotFromMessage(m) {
  const first = typeof m.content === 'string' ? m.content.split('\n')[0] : '';
  const mm = /^\[screenshot\]\s*(.*)$/.exec(first);
  const line = mm ? mm[1] : '';
  const parts = line.split(' · ');
  return { imageId: (m.images || [])[0], url: parts[0] || '', viewport: parts[1] || '' };
}

/* ---------------- browser side panel ---------------- */

function openBrowserPanel() {
  if (!els.browserPanel) return;
  els.browserPanel.classList.remove('hidden');
  state.panelOpen = true;
  if (state.sessionId) {
    ensureBrowserLive();
  }
  refreshPanelState();
}

function closeBrowserPanel() {
  if (!els.browserPanel) return;
  els.browserPanel.classList.add('hidden');
  state.panelOpen = false;
  if (!state.running) stopBrowserCast();
}

async function refreshPanelState() {
  if (!state.sessionId) return;
  try {
    const st = await api('GET', `/api/browser/state?sessionId=${encodeURIComponent(state.sessionId)}`);
    panelOnMeta(st);
    if (st.status) panelOnStatus(st.status === 'Closed' ? 'Closed' : 'Live');
  } catch {
    /* keep whatever is shown */
  }
}

function panelOnFrame(dataUrl) {
  if (!state.panelOpen) return;
  els.bpImg.src = dataUrl;
  els.bpImg.classList.remove('hidden');
  els.bpEmpty.classList.add('hidden');
}

function panelOnMeta(ev) {
  if (!state.panelOpen) return;
  if (ev.url !== undefined) els.bpUrl.value = ev.url || '';
}

function panelOnStatus(status) {
  if (!state.panelOpen) return;
  els.bpStatus.textContent = status;
  els.bpDot.classList.remove('live', 'closed');
  els.bpDot.classList.add(status === 'Closed' ? 'closed' : 'live');
  if (status !== 'Closed') {
    els.bpEmpty.classList.add('hidden');
  } else {
    els.bpEmpty.classList.remove('hidden');
    els.bpImg.classList.add('hidden');
  }
}

/* ---------------- welcome screens ---------------- */

function greetingWord() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}
function displayName() {
  const n = (els.userName.textContent || '').trim();
  return n && n !== 'Halo AI Harness' ? n : '';
}
function renderWelcome() {
  els.messages.innerHTML = '';
  if (state.agentMode === 'chat') {
    const w = el('div', { class: 'welcome centered' }, [
      el('h1', { class: 'greeting' }, [el('span', { class: 'burst', text: '✳' }), el('span', { text: `Good ${greetingWord()}, ${els.userName.textContent || 'there'}` })]),
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
  closeBrowserLive();
  state.sessionId = id;
  setAgentMode(session.mode, false);
  if (session.reasoning !== undefined) els.reasoning.value = session.reasoning || 'auto';
  if (session.workspace) els.workspace.value = session.workspace;
  localStorage.setItem('forge-last-session-' + (session.workspace || 'chat'), id);
  clearMessages();
  renderTodos(session.todos);
  for (const m of session.messages) {
    if (m.role === 'user') {
      if (m.name === SCREENSHOT_NAME && (m.images || []).length) appendShotFigure(shotFromMessage(m));
      else appendUser(m.content || '', m.images || []);
    } else if (m.role === 'assistant') {
      if (m.name === 'forge:handoff') {
        renderHandoff(m.content);
        continue;
      }
      if (m.name === BROWSER_CARD_NAME) {
        renderStoredBrowserCard(m);
        continue;
      }
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
    setMascotState('waiting');
    connectEvents(id);
  } else {
    setMascotState('idle');
  }
  els.topTitle.textContent = session.title;
  if (session.mode === 'code' && session.workspace) {
    els.topCrumbs.textContent = session.workspace.split('/').filter(Boolean).pop() || session.workspace;
    els.topCrumbs.classList.remove('hidden');
  } else {
    els.topCrumbs.classList.add('hidden');
  }
  if (state.panelOpen) refreshPanelState();
  loadSessions();
  updateContextMeter();
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
  const pendingIds = state$.pending.map((i) => i.id);
  if (!message && !pendingIds.length) return;
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
  clearTimeout(mascot.typingTimer);
  setMascotState('waiting');
  state.lastUserMessage = message;
  const images = pendingIds;
  clearPendingImages();
  try {
    await api('POST', '/api/chat', {
      sessionId: state.sessionId,
      message,
      agentMode: state.agentMode,
      workspace: state.agentMode === 'code' ? els.workspace.value.trim() : undefined,
      mode: els.modeSelect.value,
      reasoning: els.reasoning.value,
      images,
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
  closeBrowserLive();
  closeBrowserPanel();
  state.sessionId = null;
  setRunning(false);
  setMascotState('idle');
  clearMessages();
  renderTodos([]);
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
  updateContextMeter();
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

function openSettingsTab(name) {
  state.settingsTab = name;
  for (const btn of document.querySelectorAll('.settings-tab')) btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
  for (const panel of document.querySelectorAll('.settings-panel')) panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== name);
  if (name === 'prompt') renderPromptTab();
  if (name === 'tools') renderToolsTab();
  if (name === 'skills') renderSkillsTab();
  if (name === 'context') renderContextSettingsTab();
}

function renderToolsTab() {
  renderToolsList();
}

async function renderToolsList() {
  const box = $('#tools-list');
  if (!box) return;
  box.innerHTML = '';
  let data;
  try {
    data = await api('GET', '/api/tools');
  } catch (err) {
    box.appendChild(el('div', { class: 'hint', text: `Failed to load tools: ${err.message}` }));
    return;
  }
  for (const t of data.tools) {
    box.appendChild(toolRow(t, () => renderToolsList()));
  }
  const servers = (data.mcp && data.mcp.servers) || [];
  if (servers.length) {
    box.appendChild(el('div', { class: 'group-label tools-mcp-head', text: 'MCP servers' }));
    for (const s of servers) {
      const tools = (data.mcp.tools || []).filter((t) => t.server === s.name);
      box.appendChild(
        el('div', { class: 'skill-row' }, [
          el('div', { class: 'skill-info' }, [
            el('div', { class: 'skill-name' }, [el('span', { class: 's-n', text: s.name }), el('span', { class: `mcp-status ${s.status}`, text: s.status })]),
            el('div', { class: 'skill-desc', text: s.error || `${tools.length} tool${tools.length === 1 ? '' : 's'}` }),
          ]),
        ])
      );
      for (const t of tools) box.appendChild(toolRow(t, () => renderToolsList()));
    }
  }
}

function toolRow(t, refresh) {
  return el('div', { class: 'skill-row' + (t.enabled ? '' : ' off') }, [
    el('div', { class: 'skill-info' }, [
      el('div', { class: 'skill-name' }, [el('span', { class: 's-n', text: t.name })]),
      el('div', { class: 'skill-desc', text: t.description }),
    ]),
    el('button', {
      class: 'skill-toggle' + (t.enabled ? ' on' : ''),
      title: t.enabled ? 'Disable this tool' : 'Enable this tool',
      text: t.enabled ? 'On' : 'Off',
      onclick: async () => {
        try {
          await api('POST', '/api/tools/enabled', { name: t.name, enabled: !t.enabled });
          refresh();
        } catch (err) {
          setStatusError(`Could not toggle tool: ${err.message}`);
        }
      },
    }),
  ]);
}

function renderContextSettingsTab() {}

async function renderSkillsTab() {
  const box = $('#skills-list');
  if (!box) return;
  box.innerHTML = '';
  const ws = els.workspace.value.trim();
  const wsq = ws ? `?workspace=${encodeURIComponent(ws)}` : '';
  let skills = [];
  try {
    skills = (await api('GET', `/api/skills${wsq}`)).skills;
  } catch (err) {
    box.appendChild(el('div', { class: 'hint', text: `Failed to load skills: ${err.message}` }));
    return;
  }
  if (!skills.length) {
    box.appendChild(el('div', { class: 'hint', text: 'No skills found. Create ~/.forge/skills/<name>/SKILL.md with name + description frontmatter to add one.' }));
    return;
  }
  for (const s of skills) {
    const row = el('div', { class: 'skill-row' + (s.enabled ? '' : ' off') });
    row.appendChild(
      el('div', { class: 'skill-info' }, [
        el('div', { class: 'skill-name' }, [
          el('span', { class: 's-n', text: s.name }),
          el('span', { class: `skill-src ${s.source}`, text: s.source }),
        ]),
        el('div', { class: 'skill-desc', text: s.description || '(no description)' }),
      ])
    );
    row.appendChild(
      el('button', {
        class: 'btn ghost skill-view',
        text: 'View',
        onclick: async () => {
          const existing = row.parentElement.querySelector('.skill-content');
          if (existing) existing.remove();
          if (row.__open) {
            row.__open = false;
            return;
          }
          row.__open = true;
          const pre = el('pre', { class: 'prompt-preview skill-content', text: 'loading…' });
          box.appendChild(pre);
          try {
            const data = await api('GET', `/api/skill?name=${encodeURIComponent(s.id)}${ws ? `&workspace=${encodeURIComponent(ws)}` : ''}`);
            pre.textContent = data.content || '(empty)';
          } catch (err) {
            pre.textContent = `failed: ${err.message}`;
          }
        },
      })
    );
    row.appendChild(
      el('button', {
        class: 'skill-toggle' + (s.enabled ? ' on' : ''),
        title: s.enabled ? 'Disable this skill' : 'Enable this skill',
        text: s.enabled ? 'On' : 'Off',
        onclick: async () => {
          try {
            await api('POST', '/api/skills/enabled', { id: s.id, enabled: !s.enabled });
            renderSkillsTab();
          } catch (err) {
            setStatusError(`Could not toggle skill: ${err.message}`);
          }
        },
      })
    );
    box.appendChild(row);
  }
}

async function renderPromptTab() {
  const modeEl = $('#prompt-mode');
  const mode = modeEl ? modeEl.value : 'code';
  const src = $('#prompt-source');
  const preview = $('#prompt-preview');
  try {
    const ws = state.agentMode === 'code' || mode === 'code' ? els.workspace.value.trim() : '';
    const data = await api('GET', `/api/prompt?mode=${mode}${ws ? `&workspace=${encodeURIComponent(ws)}` : ''}`);
    if (src) src.textContent = `source: ${data.source}${data.path ? ` — ${data.path}` : ''}`;
    if (preview) preview.textContent = data.text || '(empty)';
  } catch (err) {
    if (src) src.textContent = `failed to load: ${err.message}`;
  }
}

async function openSettings() {
  const cfg = await api('GET', '/api/config');
  $('#set-baseurl').value = cfg.baseURL;
  $('#set-model').value = cfg.model;
  $('#set-maxsteps').value = cfg.maxSteps;
  $('#set-contextlimit').value = cfg.contextLimit;
  $('#set-images').checked = cfg.modelSupportsImages !== false;
  $('#set-tokenbudget').value = cfg.sessionTokenBudget || 1000000;
  $('#set-browser-path').value = cfg.browserPath || '';
  $('#set-apikey').value = '';
  $('#set-apikey-hint').textContent = cfg.hasApiKey ? `current: ${cfg.apiKeyMasked} (leave empty to keep)` : 'no key set';
  $('#settings-msg').textContent = '';
  openSettingsTab('general');
  els.settingsModal.showModal();
}
async function saveSettings(e) {
  if (e.submitter && e.submitter.value !== 'save') return;
  e.preventDefault();
  const patch = { baseURL: $('#set-baseurl').value.trim(), model: $('#set-model').value.trim(), maxSteps: Number($('#set-maxsteps').value) || 50, contextLimit: Number($('#set-contextlimit').value) || 100000, modelSupportsImages: $('#set-images').checked === true, sessionTokenBudget: Number($('#set-tokenbudget').value) || 1000000, browserPath: $('#set-browser-path').value.trim() };
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
  applyVisionSetting(cfg);
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

/* ---------------- images ---------------- */

const MAX_IMAGES = 5;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_EDGE = 1568;
const state$ = { pending: [], visionOn: true };

/** Downscale a file with a canvas to MAX_EDGE long edge and return a data URL. */
async function downscaleToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const tw = Math.max(1, Math.round(bitmap.width * scale));
  const th = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, tw, th);
  if (bitmap.close) bitmap.close();
  const outType = file.type === 'image/png' || file.type === 'image/gif' ? 'image/png' : file.type;
  return { dataUrl: canvas.toDataURL(outType, 0.88), width: tw, height: th };
}

function imageTypeError(name) {
  setStatusError(`"${name}": only PNG, JPEG, WebP and GIF images can be attached.`);
}

/** Accept a File (browser) or a data-URL string (tests) into the pending tray. */
async function addImageFile(item, name = '') {
  if (!state$.visionOn) {
    setStatusError('Image support is off in Settings → enable “Model supports images”.');
    return;
  }
  if (state$.pending.length >= MAX_IMAGES) {
    setStatusError(`You can attach up to ${MAX_IMAGES} images per message.`);
    return;
  }
  let dataUrl = null;
  let width = 0;
  let height = 0;
  try {
    if (typeof item === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(item)) return imageTypeError(name || 'pasted file');
      dataUrl = item;
    } else {
      if (!ALLOWED_IMAGE_TYPES.includes(item.type)) return imageTypeError(item.name || name || 'file');
      ({ dataUrl, width, height } = await downscaleToDataUrl(item));
    }
  } catch (err) {
    setStatusError(`Could not read image: ${err.message}`);
    return;
  }
  setStatusError('');
  let uploaded;
  try {
    uploaded = await api('POST', '/api/images', { sessionId: state.sessionId, source: 'user', data: dataUrl, width, height });
  } catch (err) {
    setStatusError(`Upload failed: ${err.message}`);
    return;
  }
  state$.pending.push({ id: uploaded.id, url: uploaded.url, preview: dataUrl, width: uploaded.width || width, height: uploaded.height || height });
  renderAttachTray();
}

function renderAttachTray() {
  if (!els.attachTray) return;
  els.attachTray.innerHTML = '';
  for (const img of state$.pending) {
    const fig = el('div', { class: 'attach-thumb' });
    const pic = el('img', { class: 'attach-preview', src: img.preview, alt: '' });
    const rm = el('button', { class: 'attach-remove', title: 'Remove', 'aria-label': 'Remove image', text: '×', onclick: () => { state$.pending = state$.pending.filter((x) => x !== img); renderAttachTray(); } });
    fig.appendChild(pic);
    fig.appendChild(rm);
    els.attachTray.appendChild(fig);
  }
  els.attachTray.classList.toggle('hidden', !state$.pending.length);
}

function clearPendingImages() {
  state$.pending = [];
  renderAttachTray();
}

function openLightbox(src, caption = '') {
  if (!els.lightbox) return;
  els.lightboxImg.src = src;
  els.lightboxCaption.textContent = caption;
  els.lightbox.showModal();
}

function wireImageEvents() {
  els.attachBtn.addEventListener('click', () => els.attachInput.click());
  els.attachInput.addEventListener('change', () => {
    for (const f of [...(els.attachInput.files || [])]) addImageFile(f, f.name || '');
    els.attachInput.value = '';
  });
  els.input.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addImageFile(f, f.name || 'pasted image');
  });
  const dropTargets = [els.main, els.messages];
  for (const target of dropTargets) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.classList.add('drag-over');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drag-over'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('drag-over');
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      for (const f of files) addImageFile(f, f.name || 'dropped image');
    });
  }
  els.lightbox.addEventListener('click', (e) => {
    if (e.target === els.lightbox || e.target === els.lightboxClose) els.lightbox.close();
  });
}

function applyVisionSetting(cfg) {
  state$.visionOn = cfg.modelSupportsImages !== false;
  if (els.attachBtn) {
    els.attachBtn.disabled = !state$.visionOn;
    els.attachBtn.title = state$.visionOn ? 'Attach images (PNG/JPEG/WebP/GIF, max 5)' : 'Image support is off — enable it in Settings → General';
  }
}

function imageStripHtml(ids) {
  return (ids || []).map((id) => `<img src="/api/images/${encodeURIComponent(id)}" class="msg-image" alt="attached image" />`).join('');
}

/* ---------------- init ---------------- */

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}

async function init() {
  els.modeSelect.value = localStorage.getItem('forge-mode') || 'ask';
  els.reasoning.value = localStorage.getItem('forge-reasoning') || 'auto';
  els.workspace.value = localStorage.getItem('forge-workspace') || '';

  els.themeToggle.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  els.send.addEventListener('click', send);
  els.stop.addEventListener('click', stop);
  els.newChat.addEventListener('click', newChat);
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsForm.addEventListener('submit', saveSettings);
  for (const btn of document.querySelectorAll('.settings-tab')) btn.addEventListener('click', () => openSettingsTab(btn.getAttribute('data-tab')));
  $('#settings-close').addEventListener('click', () => els.settingsModal.close());
  $('#prompt-mode').addEventListener('change', () => renderPromptTab());
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
  els.reasoning.addEventListener('change', () => localStorage.setItem('forge-reasoning', els.reasoning.value));
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
  els.input.addEventListener('input', () => {
    if (state.running) return;
    setMascotState('typing');
    clearTimeout(mascot.typingTimer);
    mascot.typingTimer = setTimeout(() => {
      if (!state.running) setMascotState('idle');
    }, 1500);
  });
  els.messages.addEventListener('scroll', () => els.scrollBtn.classList.toggle('hidden', isAtBottom()));
  els.scrollBtn.addEventListener('click', scrollTop);
  els.bpClose.addEventListener('click', () => closeBrowserPanel());
  wireImageEvents();
  $('#ctx-meter')?.addEventListener('click', () => toggleCtxPopup());
  document.addEventListener('click', (e) => {
    if (!ctxPopupOpen) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('#ctx-meter, #ctx-popup')) return;
    hideCtxPopup();
  });

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

/* test handle — used by the headless UI tests (test/helpers/domstub.mjs) */
globalThis.__forge = { state, state$, els, renderEvent, send, newChat, openSession, setMascotState, mascot, openSettingsTab, renderTodos, addImageFile, renderAttachTray, openLightbox, applyVisionSetting, openBrowserPanel, closeBrowserPanel, buildBrowserCard, appendShotFigure, showBrowserCard };
