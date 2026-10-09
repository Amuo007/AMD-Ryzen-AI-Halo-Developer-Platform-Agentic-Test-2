/* forge web UI */
const $ = (sel) => document.querySelector(sel);

const els = {
  messages: $('#messages'),
  input: $('#input'),
  send: $('#send-btn'),
  stop: $('#stop-btn'),
  sessionList: $('#session-list'),
  newChat: $('#new-chat'),
  workspace: $('#workspace-input'),
  workspaceError: $('#workspace-error'),
  browseBtn: $('#browse-btn'),
  themeToggle: $('#theme-toggle'),
  settingsBtn: $('#settings-btn'),
  settingsModal: $('#settings-modal'),
  settingsForm: $('#settings-form'),
  statusModel: $('#status-model'),
  statusTokens: $('#status-tokens'),
  statusError: $('#status-error'),
  modeSelect: $('#mode-select'),
  browseModal: $('#browse-modal'),
  browseList: $('#browse-list'),
  browsePath: $('#browse-path'),
  browseUp: $('#browse-up'),
  browseClose: $('#browse-close'),
  browseChoose: $('#browse-choose'),
};

const state = {
  sessionId: null,
  running: false,
  es: null,
  assistantEl: null, // current streaming assistant bubble
  thinkingEl: null,
  pendingToolCards: new Map(), // callIndex -> card
  cardsByCallId: new Map(),
  lastUsage: null,
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

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setStatusError(msg) {
  els.statusError.textContent = msg || '';
  els.statusError.classList.toggle('hidden', !msg);
}

function setRunning(running) {
  state.running = running;
  els.stop.classList.toggle('hidden', !running);
  els.send.disabled = running;
  els.stop.disabled = false;
  els.stop.textContent = '■ Stop';
}

function theme() {
  return localStorage.getItem('forge-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('forge-theme', t);
}
applyTheme(theme());

/* ---------------- rendering ---------------- */

function clearMessages() {
  els.messages.innerHTML = '';
  state.assistantEl = null;
  state.thinkingEl = null;
  state.pendingToolCards.clear();
  state.cardsByCallId.clear();
}

function showEmptyNote() {
  els.messages.appendChild(
    el('div', { class: 'empty-note' }, [
      el('h3', { text: 'forge' }),
      el('p', { text: 'Pick a workspace, choose a permission mode, and describe a task.' }),
    ])
  );
}

function appendUser(message) {
  state.assistantEl = null;
  els.messages.appendChild(
    el('div', { class: 'msg msg-user' }, [
      el('div', { class: 'role', text: 'YOU' }),
      el('div', { class: 'bubble', text: message }),
    ])
  );
  scrollBottom();
}

function ensureAssistant() {
  if (state.assistantEl) return state.assistantEl;
  const wrap = el('div', { class: 'msg msg-assistant' }, [el('div', { class: 'role', text: 'FORGE' })]);
  const bubble = el('div', { class: 'bubble cursor' });
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  state.assistantEl = bubble;
  return bubble;
}

function appendText(text) {
  const bubble = ensureAssistant();
  bubble.appendChild(document.createTextNode(text));
  scrollBottom();
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
  scrollBottom();
}

function endAssistant() {
  if (state.assistantEl) state.assistantEl.classList.remove('cursor');
  state.assistantEl = null;
  state.thinkingEl = null;
}

function statusLabel(s) {
  return { ok: 'done', error: 'error', denied: 'denied', timeout: 'timeout', running: 'running…', stopped: 'stopped' }[s] || s;
}

function buildToolCard({ callId, name, argsText, status, result, diff }) {
  const card = el('details', { class: 'tool-card' });
  const statusEl = el('span', { class: `tool-status ${status || 'running'}`, text: statusLabel(status) });
  const summary = el('summary', {}, [
    el('span', { class: 'tool-name', text: name || '…' }),
    el('span', { class: 'tool-args-summary', text: (argsText || '').slice(0, 120) }),
    statusEl,
  ]);
  card.appendChild(summary);
  const body = el('div', { class: 'tool-body' });
  if (argsText) body.appendChild(el('h4', { text: 'arguments' }), el('pre', { class: 'args', text: prettyJson(argsText) }));
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
  if (argsText !== undefined && argsText !== null) {
    summary.querySelector('.tool-args-summary').textContent = argsText.slice(0, 120);
  }
  body.innerHTML = '';
  if (argsText) body.appendChild(el('h4', { text: 'arguments' }), el('pre', { class: 'args', text: prettyJson(argsText) }));
  if (diff && diff.length) {
    body.appendChild(el('h4', { text: 'diff' }));
    const diffBox = el('div', { class: 'diff' });
    for (const line of diff) {
      diffBox.appendChild(el('span', { class: `diff-line ${line.type}`, text: `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'ctx' ? ' ' : ''} ${line.text}` }));
    }
    body.appendChild(diffBox);
  }
  if (result !== undefined && result !== null) {
    body.appendChild(el('h4', { text: 'result' }), el('pre', { class: 'result', text: String(result) }));
  }
  if (status === 'error' || status === 'denied' || status === 'timeout') card.open = true;
}

function renderPermission({ requestId, toolName, description }) {
  endAssistant();
  const card = el('div', { class: 'perm-card' });
  card.appendChild(el('div', { class: 'perm-title', text: 'forge wants to:' }));
  card.appendChild(el('div', { class: 'perm-desc', text: description }));
  const actions = el('div', { class: 'perm-actions' });
  const answer = async (decision, btn) => {
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
    el('button', { class: 'btn primary', onclick: (e) => answer('allow', e.target), text: 'Allow' }),
    el('button', { class: 'btn', onclick: (e) => answer('always', e.target), text: 'Always allow this tool' }),
    el('button', { class: 'btn danger', onclick: (e) => answer('deny', e.target), text: 'Deny' })
  );
  card.appendChild(actions);
  els.messages.appendChild(card);
  scrollBottom();
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
      endAssistant();
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
      // pick the first pending card without a callId if ids are absent
      if (!card || card.__callId !== ev.callId) {
        card = null;
        for (const [idx, c] of state.pendingToolCards) {
          if (!c.__done && (c.__callId === ev.callId || c.__callId === undefined)) {
            card = c;
            state.pendingToolCards.delete(idx);
            break;
          }
        }
      }
      if (!card) {
        card = buildToolCard({ callId: ev.callId, name: ev.name, argsText: ev.argsText, status: 'running' });
        els.messages.appendChild(card);
      } else {
        card.__callId = ev.callId;
        card.__apply({ name: ev.name, argsText: ev.argsText, status: 'running' });
      }
      state.cardsByCallId.set(ev.callId, card);
      scrollBottom();
      break;
    }
    case 'tool_end': {
      const card = state.cardsByCallId.get(ev.callId);
      if (card) {
        card.__done = true;
        card.__apply({ name: ev.name, status: ev.status, result: ev.result, diff: ev.diff });
      } else {
        const c = buildToolCard({ callId: ev.callId, name: ev.name, argsText: '', status: ev.status, result: ev.result, diff: ev.diff });
        c.__done = true;
        els.messages.appendChild(c);
      }
      scrollBottom();
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

function appendSystemNote(text) {
  els.messages.appendChild(el('div', { class: 'msg', html: `<div class="hint">${text}</div>` }));
  scrollBottom();
}

function renderUsage() {
  const u = state.lastUsage;
  if (!u) {
    els.statusTokens.textContent = 'tokens: —';
    return;
  }
  els.statusTokens.textContent = `tokens: in ${u.promptTokens} · out ${u.completionTokens} · total ${u.totalTokens}`;
}

/* ---------------- sessions ---------------- */

async function loadSessions() {
  const ws = els.workspace.value.trim();
  els.sessionList.innerHTML = '';
  if (!ws) return;
  try {
    const { sessions } = await api('GET', `/api/sessions?workspace=${encodeURIComponent(ws)}`);
    for (const s of sessions) {
      const item = el('button', { class: 'session-item' + (s.id === state.sessionId ? ' active' : ''), onclick: () => openSession(s.id) }, [
        el('span', { class: 's-title', text: s.title }),
        el('span', { class: 's-meta', text: `${s.messageCount} msgs · ${new Date(s.updatedAt).toLocaleString()}` }),
      ]);
      els.sessionList.appendChild(item);
    }
  } catch (err) {
    els.sessionList.appendChild(el('div', { class: 'hint', text: err.message }));
  }
}

async function openSession(id) {
  const ws = els.workspace.value.trim();
  const { session, active } = await api('GET', `/api/session?workspace=${encodeURIComponent(ws)}&sessionId=${encodeURIComponent(id)}`);
  disconnectEvents();
  state.sessionId = id;
  localStorage.setItem('forge-last-session-' + ws, id);
  clearMessages();
  for (const m of session.messages) {
    if (m.role === 'user') appendUser(m.content);
    else if (m.role === 'assistant') {
      if (m.content) {
        appendText(m.content);
        endAssistant();
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
  loadSessions();
  scrollBottom();
}

/* ---------------- events (SSE) ---------------- */

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
    if (es.readyState === EventSource.CLOSED && state.running) {
      setTimeout(() => {
        if (state.running) connectEvents(sessionId);
      }, 1000);
    }
  };
}

function disconnectEvents() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

/* ---------------- actions ---------------- */

async function send() {
  const message = els.input.value.trim();
  const ws = els.workspace.value.trim();
  if (!message) return;
  if (!ws) {
    els.workspaceError.textContent = 'Enter a workspace folder first (top-left).';
    els.workspace.focus();
    return;
  }
  els.workspaceError.textContent = '';
  if (!state.sessionId) state.sessionId = newSessionId();
  localStorage.setItem('forge-last-session-' + ws, state.sessionId);
  connectEvents(state.sessionId);
  setRunning(true);
  els.input.value = '';
  autosize();
  try {
    await api('POST', '/api/chat', { workspace: ws, sessionId: state.sessionId, message, mode: els.modeSelect.value });
    setStatusError('');
  } catch (err) {
    setRunning(false);
    setStatusError(err.message);
  }
  loadSessions();
}

function newSessionId() {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function stop() {
  if (!state.sessionId || !state.running) return;
  els.stop.disabled = true;
  els.stop.textContent = '■ Stopping…';
  try {
    await api('POST', '/api/stop', { sessionId: state.sessionId });
  } catch (err) {
    /* maybe already finished */
  }
}

function newChat() {
  disconnectEvents();
  state.sessionId = null;
  setRunning(false);
  clearMessages();
  showEmptyNote();
  els.workspace.value && loadSessions();
  els.input.focus();
}

/* ---------------- workspace / browse ---------------- */

async function browse(path) {
  const data = await api('GET', `/api/browse?path=${encodeURIComponent(path || '')}`);
  els.browsePath.textContent = data.path;
  els.browseList.innerHTML = '';
  for (const d of data.dirs) {
    els.browseList.appendChild(
      el('button', { class: 'browse-dir', text: `📁 ${d}`, onclick: () => browse(`${data.path.replace(/\/$/, '')}/${d}`) })
    );
  }
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
  const patch = {
    baseURL: $('#set-baseurl').value.trim(),
    model: $('#set-model').value.trim(),
    maxSteps: Number($('#set-maxsteps').value) || 50,
    contextLimit: Number($('#set-contextlimit').value) || 100000,
  };
  const key = $('#set-apikey').value;
  if (key) patch.apiKey = key;
  try {
    await api('PUT', '/api/config', patch);
    setStatusModel();
    els.settingsModal.close();
  } catch (err) {
    $('#settings-msg').textContent = `Failed: ${err.message}`;
  }
}

async function setStatusModel() {
  const cfg = await api('GET', '/api/config');
  els.statusModel.textContent = cfg.model;
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

  await setStatusModel();
  const ws = els.workspace.value.trim();
  if (ws) {
    await loadSessions();
    const last = localStorage.getItem('forge-last-session-' + ws);
    if (last) {
      try {
        await openSession(last);
        return;
      } catch {
        /* fall through */
      }
    }
  }
  showEmptyNote();
  els.input.focus();
}

init();
