import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, publicConfig } from './config.js';
import { getConversation, deleteConversation, listConversations, listWorkspaces, importWorkspace, loadMessages, getStats, setFeedback, getTodos, conversationInputTokens } from './db.js';
import { getTurn, startTurn, turns as turnsMap } from './agent.js';
import { killAllJobs } from './tools/jobs.js';
import { resolvePrompt, promptLocations } from './prompt.js';
import { discoverSkills, setSkillEnabled, useSkill, skillsSectionText } from './skills.js';
import { mcpEnsure, stopAllMcp } from './mcp.js';
import { contextBreakdown } from './context.js';
import { buildSystemPrompt, buildChatSystemPrompt, loadAgentsMd } from './memory.js';
import { toolDefs, activeToolList, getDisabledTools, setToolEnabled } from './tools/index.js';
import { saveImage, imageExists, MAX_IMAGES_PER_MESSAGE } from './images.js';
import * as browser from './browser/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  rel = path.normalize(rel);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, 'Forbidden');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (stat.isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function isValidWorkspace(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'workspace must be an absolute path' };
  try {
    const st = fs.statSync(fs.realpathSync(p));
    if (!st.isDirectory()) return { ok: false, error: 'workspace is not a directory' };
    return { ok: true, resolved: fs.realpathSync(p) };
  } catch {
    return { ok: false, error: `workspace does not exist: ${p}` };
  }
}

export function createRequestHandler() {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (!p.startsWith('/api/')) return serveStatic(res, p);

      if (req.method === 'GET' && p === '/api/health') {
        return sendJson(res, 200, { ok: true, name: 'forge', version: '1.0.0', model: loadConfig().model });
      }

      if (req.method === 'GET' && p === '/api/config') {
        return sendJson(res, 200, publicConfig(loadConfig()));
      }
      if (req.method === 'PUT' && p === '/api/config') {
        const body = await readBody(req);
        const saved = await saveConfig(body);
        return sendJson(res, 200, publicConfig(loadConfig()));
      }

      if (req.method === 'GET' && p === '/api/sessions') {
        const mode = url.searchParams.get('mode');
        const query = url.searchParams.get('query');
        if (mode === 'chat') {
          return sendJson(res, 200, { sessions: listConversations({ mode: 'chat', query }) });
        }
        const ws = isValidWorkspace(url.searchParams.get('workspace'));
        if (!ws.ok) return sendJson(res, 400, { error: ws.error });
        importWorkspace(ws.resolved);
        return sendJson(res, 200, { sessions: listConversations({ mode: 'code', workspace: ws.resolved, query }) });
      }
      if (req.method === 'GET' && p === '/api/session') {
        const id = url.searchParams.get('sessionId') ?? '';
        const conv = getConversation(id);
        if (!conv) return sendJson(res, 404, { error: 'session not found' });
        const messages = loadMessages(id);
        const turn = getTurn(id);
        return sendJson(res, 200, {
          session: {
            ...conv,
            messageCount: messages.filter((m) => m.role !== 'tool').length,
            todos: getTodos(id),
            messages: messages.map(({ __meta, ...m }) => (m.role === 'assistant' ? { ...m, id: __meta.id, feedback: __meta.feedback } : m)),
          },
          active: Boolean(turn && !turn.finished),
        });
      }
      if (req.method === 'DELETE' && p === '/api/session') {
        const id = url.searchParams.get('sessionId') ?? '';
        const turn = getTurn(id);
        if (turn && !turn.finished) turn.stop();
        browser.closeConversation(id).catch(() => {});
        const ok = deleteConversation(id);
        return sendJson(res, ok ? 200 : 404, { deleted: ok });
      }

      if (req.method === 'POST' && p === '/api/chat') {
        const body = await readBody(req);
        const rawImages = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
        if (rawImages.length > MAX_IMAGES_PER_MESSAGE) return sendJson(res, 400, { error: `max ${MAX_IMAGES_PER_MESSAGE} images per message` });
        const images = rawImages;
        if ((typeof body.message !== 'string' || !body.message.trim()) && !images.length) return sendJson(res, 400, { error: 'message is required' });
        const agentMode = body.agentMode === 'chat' ? 'chat' : 'code';
        let workspace = null;
        if (agentMode === 'code') {
          const ws = isValidWorkspace(body.workspace);
          if (!ws.ok) return sendJson(res, 400, { error: ws.error });
          workspace = ws.resolved;
        }
        const mode = ['ask', 'auto-edit', 'full'].includes(body.mode) ? body.mode : 'ask';
        const reasoning = ['auto', 'high', 'medium', 'low', 'off'].includes(body.reasoning) ? body.reasoning : null;
        const sessionId = body.sessionId ? String(body.sessionId) : null;
        if (sessionId && getTurn(sessionId) && !getTurn(sessionId).finished) {
          return sendJson(res, 409, { error: 'a turn is already running for this session' });
        }
        const sid = sessionId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        let turn;
        try {
          turn = await startTurn({ sessionId: sid, workspace, message: (body.message ?? '').trim(), mode, agentMode, reasoning: reasoning ?? undefined, images });
        } catch (err) {
          return sendJson(res, err.status ?? 500, { error: err.message });
        }
        return sendJson(res, 202, { sessionId: sid, turnId: turn.id, reasoning: turn.reasoning });
      }

      if (req.method === 'GET' && p === '/api/events') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        const keepAlive = setInterval(() => {
          try {
            res.write(': ka\n\n');
          } catch {
            /* ignore */
          }
        }, 15000);
        const cleanup = () => {
          clearInterval(keepAlive);
          const t = getTurn(sessionId);
          if (t) t.detach(res);
        };
        req.on('close', cleanup);
        const turn = getTurn(sessionId);
        if (turn) {
          const lastEventId = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? 0);
          turn.attach(res, lastEventId);
        } else {
          res.write(`data: ${JSON.stringify({ type: 'stream_end', active: false })}\n\n`);
          res.end();
          cleanup();
        }
        return;
      }

      if (req.method === 'POST' && p === '/api/permission') {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? '');
        const decision = String(body.decision ?? '');
        if (!['allow', 'deny', 'always'].includes(decision)) return sendJson(res, 400, { error: 'decision must be allow, deny or always' });
        for (const turn of turnsMap.values()) {
          if (turn.answerPermission(requestId, decision)) {
            return sendJson(res, 200, { ok: true });
          }
        }
        return sendJson(res, 404, { error: 'no pending permission with that requestId' });
      }

      if (req.method === 'POST' && p === '/api/feedback') {
        const body = await readBody(req);
        const id = Number(body.messageId);
        if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'messageId is required' });
        const feedback = body.feedback === null ? null : ['up', 'down'].includes(body.feedback) ? body.feedback : null;
        setFeedback(id, feedback);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/stop') {
        const body = await readBody(req);
        const turn = getTurn(body.sessionId);
        if (!turn || turn.finished) return sendJson(res, 404, { error: 'no running turn for that session' });
        turn.stop();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/prompt') {
        const mode = url.searchParams.get('mode') === 'chat' ? 'chat' : 'code';
        const workspace = url.searchParams.get('workspace');
        const ws = workspace ? isValidWorkspace(workspace) : { ok: true, resolved: null };
        if (!ws.ok) return sendJson(res, 400, { error: ws.error });
        const resolved = await resolvePrompt({ mode, workspace: ws.resolved });
        return sendJson(res, 200, { mode, ...resolved, locations: promptLocations(ws.resolved) });
      }

      if (req.method === 'GET' && p === '/api/tools') {
        const disabled = new Set(getDisabledTools());
        const tools = toolDefs.map((d) => ({ name: d.function.name, description: d.function.description, enabled: !disabled.has(d.function.name) }));
        const ws = url.searchParams.get('workspace');
        const mcp = await mcpEnsure(ws);
        for (const t of mcp.tools) {
          tools.push({ name: t.name, description: `[MCP ${t.server}] ${t.description}`, enabled: !disabled.has(t.name), server: t.server, readOnly: t.readOnly });
        }
        return sendJson(res, 200, { tools, mcp });
      }
      if (req.method === 'POST' && p === '/api/tools/enabled') {
        const body = await readBody(req);
        const name = String(body.name ?? '');
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        const disabled = setToolEnabled(name, body.enabled === true);
        return sendJson(res, 200, { ok: true, disabled });
      }

      if (req.method === 'GET' && p === '/api/context') {
        const id = url.searchParams.get('sessionId');
        if (!id) return sendJson(res, 400, { error: 'sessionId is required' });
        const conv = getConversation(id);
        if (!conv) return sendJson(res, 404, { error: 'session not found' });
        const cfg = loadConfig();
        const isChat = conv.mode === 'chat';
        const rows = loadMessages(id);
        const messages = rows.map(({ __meta, ...m }) => m);
        let actual = null;
        let actualIdx = -1;
        rows.forEach((m, i) => {
          if (m.role === 'assistant' && m.__meta?.promptTokens > 0) {
            actual = m.__meta.promptTokens;
            actualIdx = i;
          }
        });
        const sinceActual = actualIdx >= 0 ? rows.slice(actualIdx + 1).map(({ __meta, ...m }) => m) : [];
        let systemPrompt = '';
        let skillsSection = null;
        let defs = [];
        try {
          if (isChat) {
            systemPrompt = await buildChatSystemPrompt({ model: cfg.model });
          } else {
            const agentsMd = conv.workspace ? await loadAgentsMd(conv.workspace) : null;
            skillsSection = skillsSectionText(await discoverSkills({ workspace: conv.workspace }));
            systemPrompt = await buildSystemPrompt({ workspace: conv.workspace, agentsMd, skillsSection, model: cfg.model });
            defs = await activeToolList(conv.workspace);
          }
        } catch {
          /* meter stays approximate if prompt files are unreadable */
        }
        const bd = contextBreakdown({ systemPrompt, skillsSection, toolDefs: defs, messages, actualPromptTokens: actual, sinceActual });
        const inputTokens = conversationInputTokens(id);
        return sendJson(res, 200, { limit: cfg.contextLimit, handoffAt: cfg.handoffLimit, budget: cfg.sessionTokenBudget, inputTokens, overBudget: inputTokens > cfg.sessionTokenBudget, mode: conv.mode, ...bd });
      }

      if (req.method === 'GET' && p === '/api/skills') {
        const workspace = url.searchParams.get('workspace');
        const ws = workspace ? isValidWorkspace(workspace) : { ok: true, resolved: null };
        if (!ws.ok) return sendJson(res, 400, { error: ws.error });
        return sendJson(res, 200, { skills: await discoverSkills({ workspace: ws.resolved }) });
      }
      if (req.method === 'POST' && p === '/api/skills/enabled') {
        const body = await readBody(req);
        const id = String(body.id ?? '');
        if (!id) return sendJson(res, 400, { error: 'id is required' });
        const disabled = setSkillEnabled(id, body.enabled === true);
        return sendJson(res, 200, { ok: true, disabled });
      }
      if (req.method === 'GET' && p === '/api/skill') {
        const name = url.searchParams.get('name') ?? '';
        const workspace = url.searchParams.get('workspace');
        const file = url.searchParams.get('file');
        const ws = workspace ? isValidWorkspace(workspace) : { ok: true, resolved: null };
        if (!ws.ok) return sendJson(res, 400, { error: ws.error });
        const result = await useSkill({ workspace: ws.resolved }, { skill: name, file: file || undefined });
        return sendJson(res, result.ok ? 200 : 404, result);
      }

      if (req.method === 'GET' && p === '/api/browse') {
        let start = url.searchParams.get('path') || os.homedir();
        const home = os.homedir();
        let real;
        try {
          real = fs.realpathSync(start);
        } catch {
          real = home;
        }
        let entries = [];
        try {
          const dirents = await fsp.readdir(real, { withFileTypes: true });
          entries = dirents
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort((a, b) => a.localeCompare(b));
        } catch {
          /* unreadable dir → empty list */
        }
        const parent = path.dirname(real);
        return sendJson(res, 200, { path: real, parent: parent === real ? null : parent, home, dirs: entries });
      }

      if (req.method === 'GET' && p === '/api/llm-status') {
        const cfg = loadConfig();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const lres = await fetch(`${String(cfg.baseURL).replace(/\/+$/, '')}/models`, {
            signal: controller.signal,
            headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
          });
          return sendJson(res, 200, { ok: lres.ok, status: lres.status, baseURL: cfg.baseURL });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: `Cannot reach LLM server at ${cfg.baseURL}: ${err.cause?.code ?? err.message}`, baseURL: cfg.baseURL });
        } finally {
          clearTimeout(timer);
        }
      }

      if (req.method === 'POST' && p === '/api/images') {
        const body = await readBody(req, 24 * 1024 * 1024);
        const sessionId = body.sessionId != null ? String(body.sessionId) : null;
        const source = ['user', 'screenshot'].includes(body.source) ? body.source : 'user';
        const img = saveImage({ dataUrl: body.data, conversationId: sessionId, source, width: body.width ?? 0, height: body.height ?? 0 });
        return sendJson(res, 201, { id: img.id, url: `/api/images/${img.id}`, mime: img.mime, width: img.width, height: img.height, bytes: img.bytes, source: img.source });
      }
      if (req.method === 'GET' && p.startsWith('/api/images/')) {
        const id = decodeURIComponent(p.slice('/api/images/'.length));
        const img = imageExists(id);
        if (!img) return sendJson(res, 404, { error: 'image not found' });
        const stat = fs.statSync(img.path);
        res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
        fs.createReadStream(img.path).pipe(res);
        return;
      }

      if (req.method === 'GET' && p === '/api/browser/state') {
        const id = url.searchParams.get('sessionId');
        if (!id) return sendJson(res, 400, { error: 'sessionId is required' });
        return sendJson(res, 200, browser.getState(id));
      }
      if (req.method === 'POST' && p === '/api/browser/screencast') {
        const body = await readBody(req);
        const id = String(body.sessionId ?? '');
        if (body.start === false) {
          const page = browser.getPage(id);
          if (page) await page.stopScreencast();
          return sendJson(res, 200, { ok: true, streaming: false });
        }
        const page = await browser.ensurePage(id, {});
        await page.startScreencast({ everyNthFrame: Number(body.everyNthFrame) || 1 });
        return sendJson(res, 200, { ok: true, streaming: true });
      }
      if (req.method === 'POST' && p === '/api/browser/viewport') {
        const body = await readBody(req);
        const id = String(body.sessionId ?? '');
        const size = String(body.size ?? '');
        const vp = browser.VIEWPORTS[size];
        if (!vp) return sendJson(res, 400, { error: `unknown viewport "${size}" (use desktop, tablet or mobile)` });
        const page = browser.getPage(id);
        if (!page || page.closed) return sendJson(res, 409, { error: 'no page is open in the browser' });
        await page.applyViewport(vp);
        return sendJson(res, 200, { ok: true, viewport: { ...vp } });
      }
      if (req.method === 'GET' && p === '/api/browser/events') {
        const id = url.searchParams.get('sessionId');
        if (!id) return sendJson(res, 400, { error: 'sessionId is required' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        const keepAlive = setInterval(() => {
          try {
            res.write(': ka\n\n');
          } catch {
            /* ignore */
          }
        }, 15000);
        const send = (ev) => {
          try {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch {
            /* ignore */
          }
        };
        const state = browser.getState(id);
        send({ type: 'state', ...state });
        if (state.url) send({ type: 'navigation', url: state.url, title: state.title });
        const off = browser.subscribe(id, send);
        req.on('close', () => {
          clearInterval(keepAlive);
          off();
        });
        return;
      }

      if (req.method === 'GET' && p === '/api/stats') {
        const range = ['all', '30d', '7d'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'all';
        // make sure any legacy sessions in known workspaces are present before counting
        for (const w of listWorkspaces()) importWorkspace(w.workspace);
        const stats = getStats({ range });
        let user = 'there';
        try {
          user = os.userInfo().username || 'there';
        } catch {
          /* keep default */
        }
        return sendJson(res, 200, { ...stats, user });
      }

      return sendJson(res, 404, { error: `No route: ${req.method} ${p}` });
    } catch (err) {
      const status = err.status ?? 500;
      try {
        sendJson(res, status, { error: err.message ?? String(err) });
      } catch {
        /* already sent */
      }
    }
  };
}

export async function startServer({ port = 4848, host = '127.0.0.1', openBrowser = false } = {}) {
  const server = http.createServer(createRequestHandler());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  if (openBrowser) openBrowserTo(`http://${host}:${actualPort}/`);
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    close: () =>
      new Promise((resolve) => {
        for (const turn of turnsMap.values()) if (!turn.finished) turn.stop();
        killAllJobs();
        stopAllMcp();
        browser.shutdownAll().catch(() => {});
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export function openBrowserTo(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(opener, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* headless environment, just print the URL */
  }
}
