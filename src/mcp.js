import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './prompt.js';

/**
 * MCP (Model Context Protocol) client — stdio transport only (the shape
 * every MCP server implements): newline-delimited JSON-RPC 2.0.
 *
 * Servers are configured in <globalDir>/mcp.json and <workspace>/.forge/mcp.json:
 * { "servers": { "name": { "command": "…", "args": ["…"], "env": {"K":"V"}, "disabled": false } } }
 *
 * MCP tools appear to the model as `mcp__<server>__<tool>`. One set of
 * client processes per forge process; config changes rebuild them.
 */

export const PROTOCOL_VERSION = '2025-03-26';
export const INIT_TIMEOUT_MS = 10_000;
export const RPC_TIMEOUT_MS = 30_000;
export const MCP_RESULT_CAP = 60_000;

export function mcpConfigPath(workspace = null) {
  return { global: path.join(configDir(), 'mcp.json'), workspace: workspace ? path.join(workspace, '.forge', 'mcp.json') : null };
}

/** Merge global + workspace mcp.json (workspace wins on name). */
export function loadMcpConfig(workspace = null) {
  const out = {};
  const files = [mcpConfigPath(workspace).global, mcpConfigPath(workspace).workspace];
  for (const file of files) {
    if (!file) continue;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      out.__error__ = `Invalid JSON in ${file}: ${err.message}`;
      continue;
    }
    const servers = parsed && typeof parsed.servers === 'object' && parsed.servers ? parsed.servers : {};
    for (const [name, def] of Object.entries(servers)) {
      if (!def || typeof def.command !== 'string' || !def.command) {
        out.__error__ = out.__error__ || `MCP server "${name}" has no command in ${file}`;
        continue;
      }
      out[name] = {
        command: def.command,
        args: Array.isArray(def.args) ? def.args.map(String) : [],
        env: def.env && typeof def.env === 'object' ? def.env : {},
        disabled: def.disabled === true,
      };
    }
  }
  return out;
}

class McpClient {
  constructor(name, def, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
    this.name = name;
    this.def = def;
    this.timeoutMs = timeoutMs;
    this.status = 'stopped'; // stopped | starting | running | failed
    this.error = null;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buf = '';
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.status === 'running') return resolve();
      this.status = 'starting';
      this.error = null;
      let child;
      try {
        child = spawn(this.def.command, this.def.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.def.env },
        });
      } catch (err) {
        this.status = 'failed';
        this.error = `failed to spawn: ${err.message}`;
        return reject(new Error(this.error));
      }
      this.child = child;
      let started = false;
      const fail = (msg) => {
        if (started) return;
        started = true;
        this.status = 'failed';
        this.error = msg;
        this._rejectAll(new Error(msg));
        reject(new Error(msg));
      };
      const startupTimer = setTimeout(() => fail(`MCP server ${this.name} did not finish initialize within ${INIT_TIMEOUT_MS}ms`), INIT_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(startupTimer);
        fail(err.message);
      });
      child.on('close', (code, sig) => {
        clearTimeout(startupTimer);
        this._rejectAll(new Error(`MCP server ${this.name} exited (${sig || code})`));
        if (!started) fail(`exited during startup (${sig || code})`);
        else {
          this.status = this.status === 'running' ? 'stopped' : this.status;
        }
      });
      child.stderr.on('data', (d) => {
        if (process.env.FORGE_DEBUG) console.error(`[mcp:${this.name}]`, String(d).trim());
      });
      child.stdout.on('data', (d) => this._onData(String(d)));
      // MCP handshake
      this.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'forge', version: '3.0.0' },
      })
        .then((result) => {
          if (!started) {
            started = true;
            clearTimeout(startupTimer);
            this.status = 'running';
            this.notify('notifications/initialized', {});
            resolve(result);
          }
        })
        .catch((err) => fail(err.message));
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON-RPC (some servers log to stdout)
      }
      if (msg.method && msg.id === undefined) continue; // server notification
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
      else p.resolve(msg.result);
    }
  }

  rpc(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) return reject(new Error(`MCP server ${this.name} is not running`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} to ${this.name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.child || this.child.killed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      /* ignore */
    }
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* gone */
    }
    this.child = null;
    this.status = 'stopped';
  }
}

/* ---------------- manager ---------------- */

const manager = {
  clients: new Map(), // server name -> McpClient
  configHash: null,
  tools: [], // { name (qualified), server, description, inputSchema, readOnly }
  configError: null,
};

function configHash(cfg) {
  return JSON.stringify(cfg);
}

/** Ensure clients exist for the current config; returns { tools, servers, error }. */
export async function mcpEnsure(workspace = null) {
  const cfg = loadMcpConfig(workspace);
  const hash = configHash(cfg);
  if (manager.configHash === hash) {
    // restart failed servers opportunistically (max one retry per config version)
    for (const [name, def] of Object.entries(cfg)) {
      if (def.disabled) continue;
      const c = manager.clients.get(name);
      if (!c) ensureStarted(name, def);
      else if (c.status === 'failed' && !c.__retried) ensureStarted(name, def, { retry: true });
    }
  } else {
    manager.configHash = hash;
    manager.configError = cfg.__error__ || null;
    stopAllMcp();
    manager.clients = new Map();
    manager.tools = [];
    for (const [name, def] of Object.entries(cfg)) {
      if (def.disabled) continue;
      ensureStarted(name, def);
    }
  }
  // wait for all pending starts before listing
  for (const c of manager.clients.values()) {
    if (c.__start) await Promise.resolve(c.__start).catch(() => {});
  }
  // gather tool lists from running clients
  const servers = [];
  for (const [name, def] of Object.entries(cfg)) {
    if (def.disabled) continue;
    const c = manager.clients.get(name);
    if (!c) continue;
    if (c.status === 'running') {
      try {
        const res = await c.rpc('tools/list', {}, INIT_TIMEOUT_MS);
        const list = Array.isArray(res?.tools) ? res.tools : [];
        manager.tools = manager.tools.filter((t) => t.server !== name).concat(
          list.map((t) => ({
            name: `mcp__${name}__${t.name}`,
            server: name,
            tool: t.name,
            description: t.description || t.title || '',
            inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
            readOnly: Boolean(t.annotations && t.annotations.readOnlyHint === true),
          }))
        );
      } catch (err) {
        c.status = 'failed';
        c.error = err.message;
      }
    }
    servers.push({ name, status: c.status, error: c.error });
  }
  manager.tools = manager.tools.filter((t) => {
    const c = manager.clients.get(t.server);
    return c && c.status === 'running';
  });
  return { tools: manager.tools, servers, error: manager.configError };
}

/** Create a client and kick off its start (idempotent, remembers the promise). */
function ensureStarted(name, def, { retry = false } = {}) {
  let c = manager.clients.get(name);
  if (!c) {
    c = new McpClient(name, def);
    manager.clients.set(name, c);
  } else if (!retry) {
    return c;
  }
  if (c.__start) return c;
  c.__start = c.start().catch((err) => {
    if (c.status !== 'running') {
      c.status = 'failed';
      c.error = err.message;
    }
  });
  return c;
}

/** Tool defs (OpenAI function-calling shape) for all running MCP tools. */
export async function mcpToolDefs(workspace = null) {
  try {
    const { tools } = await mcpEnsure(workspace);
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: `[MCP ${t.server}] ${t.description}`.slice(0, 1000),
        parameters: t.inputSchema,
      },
    }));
  } catch {
    return [];
  }
}

export function mcpIsReadOnly(qualifiedName) {
  return manager.tools.some((t) => t.name === qualifiedName && t.readOnly);
}

/** Run a tool call against the owning MCP server; returns a tool result. */
export async function runMcpTool(qualifiedName, args) {
  const parts = String(qualifiedName).split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    return { ok: false, content: `Error: malformed MCP tool name "${qualifiedName}" (expected mcp__<server>__<tool>).` };
  }
  const server = parts[1];
  const tool = parts.slice(2).join('__');
  const c = manager.clients.get(server);
  if (!c || c.status !== 'running') {
    return { ok: false, content: `Error: MCP server "${server}" is not running (${c ? c.status : 'unknown'}). Check Settings → Tools.` };
  }
  try {
    const res = await c.rpc('tools/call', { name: tool, arguments: args ?? {} });
    const parts = Array.isArray(res?.content) ? res.content : [];
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : p.type === 'resource' ? '[resource]' : `[${p.type}]`))
      .join('\n');
    const truncated = text.length > MCP_RESULT_CAP ? `${text.slice(0, MCP_RESULT_CAP)}\n[MCP result truncated]` : text;
    return { ok: !res?.isError, content: truncated || '(empty result)', isError: Boolean(res?.isError) };
  } catch (err) {
    return { ok: false, content: `Error from MCP server ${server}: ${err.message}` };
  }
}

/** Current status for the Settings UI (no side effects if never started). */
export function mcpStatus(workspace = null) {
  const cfg = workspace ? loadMcpConfig(workspace) : loadMcpConfig(null);
  const servers = [];
  for (const [name, def] of Object.entries(cfg)) {
    if (def.disabled) {
      servers.push({ name, status: 'disabled', error: null });
      continue;
    }
    const c = manager.clients.get(name);
    servers.push({ name, status: c ? c.status : 'stopped', error: c ? c.error : null });
  }
  return { servers, tools: manager.tools.map(({ name, server, description, readOnly }) => ({ name, server, description, readOnly })) };
}

export function stopAllMcp() {
  for (const c of manager.clients.values()) c.stop();
}

/** Test helper: reset the manager. */
export function resetMcp() {
  stopAllMcp();
  manager.clients = new Map();
  manager.configHash = null;
  manager.tools = [];
  manager.configError = null;
}
