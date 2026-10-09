import { streamChatCompletion } from './llm.js';
import { runTool, toolDefs } from './tools/index.js';
import { decidePermission, describeToolCall } from './permissions.js';
import { trimContext } from './context.js';
import { loadAgentsMd, buildSystemPrompt } from './memory.js';
import { appendMessage } from './sessions.js';
import { loadConfig } from './config.js';

export const turns = new Map(); // sessionId -> active or last turn

export class Turn {
  constructor({ id, sessionId, workspace, mode, maxSteps }) {
    this.id = id;
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.mode = mode;
    this.maxSteps = maxSteps;
    this.events = [];
    this.nextEventId = 1;
    this.clients = new Set();
    this.pendingPermissions = new Map(); // requestId -> resolve
    this.permissionTools = new Map(); // requestId -> toolName
    this.permSeq = 0;
    this.abortController = new AbortController();
    this.alwaysAllow = new Set();
    this.finished = false;
    this.stopped = false;
    this.lastError = null;
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  }

  write(res, entry) {
    try {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    } catch {
      /* response already closed */
    }
  }

  emit(data) {
    const entry = { id: this.nextEventId++, data };
    this.events.push(entry);
    for (const res of this.clients) this.write(res, entry);
    return entry;
  }

  attach(res, lastEventId = 0) {
    this.clients.add(res);
    for (const e of this.events) {
      if (e.id > lastEventId) this.write(res, e);
    }
    if (this.finished) this.endClients();
  }

  detach(res) {
    this.clients.delete(res);
  }

  endClients() {
    for (const res of this.clients) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'stream_end', turnId: this.id })}\n\n`);
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  requestPermission(toolName, args) {
    const requestId = `${this.id}-p${++this.permSeq}`;
    this.emit({
      type: 'permission_request',
      requestId,
      toolName,
      args,
      description: describeToolCall(toolName, args),
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      this.permissionTools.set(requestId, toolName);
    });
  }

  answerPermission(requestId, decision) {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    const toolName = this.permissionTools.get(requestId);
    if (decision === 'always' && toolName) this.alwaysAllow.add(toolName);
    resolve(decision === 'always' ? 'allow' : decision);
    return true;
  }

  stop() {
    this.stopped = true;
    for (const [, resolve] of this.pendingPermissions) resolve('deny');
    this.pendingPermissions.clear();
    this.abortController.abort();
  }

  finish({ error = null } = {}) {
    this.finished = true;
    this.lastError = error;
    this.endClients();
  }
}

export function getTurn(sessionId) {
  return turns.get(String(sessionId)) ?? null;
}

/**
 * Run one full agent turn: stream from the LLM, execute tool calls, append
 * results, repeat until the model stops calling tools, the step budget is
 * exhausted, the user stops it, or a hard error occurs.
 */
export async function runTurn(turn, userMessage) {
  const config = loadConfig();
  const messages = [];
  const signal = turn.abortController.signal;
  turn.emit({ type: 'user', message: userMessage, mode: turn.mode });
  await appendMessage(turn.workspace, turn.sessionId, { role: 'user', content: userMessage });
  messages.push({ role: 'user', content: userMessage });

  const agentsMd = await loadAgentsMd(turn.workspace);
  const systemPrompt = buildSystemPrompt({ workspace: turn.workspace, agentsMd });

  try {
    for (let step = 0; step < turn.maxSteps; step++) {
      if (turn.stopped) break;
      const context = trimContext([{ role: 'system', content: systemPrompt }, ...messages], config.contextLimit);
      const result = await streamChatCompletion({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        messages: context,
        tools: toolDefs,
        signal,
        onText: (t) => turn.emit({ type: 'text_delta', text: t }),
        onReasoning: (t) => turn.emit({ type: 'reasoning_delta', text: t }),
        onToolCallDelta: (d) =>
          turn.emit({ type: 'tool_args_delta', callIndex: d.index ?? 0, id: d.id, argsFragment: d.function?.arguments ?? '', toolName: d.function?.name }),
        onRetry: (r) => turn.emit({ type: 'retry', attempt: r.attempt, error: String(r.error?.message ?? r.error) }),
        onUsage: (u) => {
          turn.usage.promptTokens += u.prompt_tokens ?? 0;
          turn.usage.completionTokens += u.completion_tokens ?? 0;
          turn.usage.totalTokens += u.total_tokens ?? 0;
          turn.usage.requests += 1;
          turn.emit({ type: 'usage', usage: u, total: turn.usage });
        },
      });

      const asstMsg = { role: 'assistant', content: result.message.content ?? null };
      if (result.message.tool_calls?.length) {
        asstMsg.tool_calls = result.message.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        }));
      }
      messages.push(asstMsg);
      await appendMessage(turn.workspace, turn.sessionId, asstMsg);
      turn.emit({ type: 'message_end', content: asstMsg.content });

      if (!asstMsg.tool_calls?.length) break;

      for (let i = 0; i < asstMsg.tool_calls.length; i++) {
        const call = asstMsg.tool_calls[i];
        const callId = call.id || `call-${step}-${i}`;
        const toolName = call.function.name;
        turn.emit({ type: 'tool_start', callId, name: toolName, argsText: call.function.arguments ?? '' });

        let status = 'ok';
        let resultText = '';
        let diff = null;
        let parsed = null;
        try {
          parsed = JSON.parse(call.function.arguments || '{}');
          if (parsed === null || typeof parsed !== 'object') throw new Error('arguments must be a JSON object');
        } catch (err) {
          status = 'error';
          resultText = `Error: invalid tool-call JSON arguments (${err.message}). Call ${toolName} again with valid JSON.`;
        }

        if (status !== 'error') {
          const decision = decidePermission({ mode: turn.mode, toolName, args: parsed, alwaysAllow: turn.alwaysAllow });
          if (decision.action === 'deny') {
            status = 'denied';
            resultText = `Blocked by deny-list: ${decision.reason}. This command is forbidden in every permission mode; do not retry it.`;
          } else if (decision.action === 'ask') {
            const answer = await turn.requestPermission(toolName, parsed);
            if (answer === 'deny') {
              status = 'denied';
              resultText = 'The user denied this action. Consider a different approach or ask the user what they want.';
            }
          }
          if (status !== 'denied') {
            const toolRes = await runTool(toolName, { workspace: turn.workspace, signal }, parsed);
            resultText = toolRes.content;
            diff = toolRes.diff ?? null;
            if (!toolRes.ok) status = 'error';
            if (toolRes.timedOut) status = 'timeout';
            if (toolRes.aborted) status = 'stopped';
          }
        }

        turn.emit({ type: 'tool_end', callId, name: toolName, status, result: resultText, diff });
        const toolMsg = { role: 'tool', tool_call_id: callId, name: toolName, content: resultText };
        messages.push(toolMsg);
        await appendMessage(turn.workspace, turn.sessionId, toolMsg);
      }
    }
    turn.emit({ type: 'turn_end', stopped: turn.stopped, usage: turn.usage });
    turn.finish();
  } catch (err) {
    if (err.name === 'AbortError') {
      turn.emit({ type: 'turn_end', stopped: true, usage: turn.usage });
      turn.finish();
    } else {
      turn.emit({ type: 'turn_end', error: String(err?.message ?? err), usage: turn.usage });
      turn.finish({ error: String(err?.message ?? err) });
    }
  }
}

export async function startTurn({ sessionId, workspace, message, mode }) {
  if (turns.has(String(sessionId))) {
    const existing = turns.get(String(sessionId));
    if (!existing.finished) throw Object.assign(new Error('A turn is already running for this session'), { status: 409 });
  }
  const config = loadConfig();
  const turn = new Turn({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: String(sessionId),
    workspace,
    mode: mode ?? 'ask',
    maxSteps: config.maxSteps,
  });
  turns.set(turn.sessionId, turn);
  // run detached
  runTurn(turn, message);
  return turn;
}
