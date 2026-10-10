import { streamChatCompletion } from './llm.js';
import { runTool, activeToolList } from './tools/index.js';
import { mcpIsReadOnly } from './mcp.js';
import { decidePermission, describeToolCall } from './permissions.js';
import { trimContext, contextTokens } from './context.js';
import { loadAgentsMd, buildSystemPrompt, buildChatSystemPrompt } from './memory.js';
import { discoverSkills, skillsSectionText } from './skills.js';
import { appendMessage, getConversation, loadMessages } from './db.js';
import { ensureConversation } from './conversations.js';
import { materializeForModel, SCREENSHOT_NAME } from './images.js';
import { loadConfig } from './config.js';

export const turns = new Map(); // sessionId -> active or last turn

/** Handoff messages carry this name; everything before the latest one leaves the model context. */
export const HANDOFF_NAME = 'forge:handoff';

export const HANDOFF_DIRECTIVE = `SYSTEM: Automatic context handoff. Your conversation history is about to be discarded from the context window.
Write a handoff summary for your future self, who will continue the task with no other memory of what happened so far.
Use exactly these markdown sections, filled in with specifics (exact paths, commands, statuses, numbers):

## Goal
## Done
## Current state
## Branches & files
## Next steps

Do not call tools. Do not ask questions. After the handoff, work resumes from "Next steps".`;

/** Model-visible history: everything from the latest handoff marker onward. */
export function historyFromRows(rows) {
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].name === HANDOFF_NAME) {
      start = i;
      break;
    }
  }
  return rows.slice(start).map(({ __meta, name, ...m }) => m);
}

export class Turn {
  constructor({ id, sessionId, workspace, mode, agentMode = 'code', maxSteps, reasoning = 'auto' }) {
    this.id = id;
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.mode = mode; // permission mode: ask | auto-edit | full
    this.agentMode = agentMode === 'chat' ? 'chat' : 'code'; // conversation kind
    this.reasoning = ['high', 'medium', 'low', 'off'].includes(reasoning) ? reasoning : 'auto';
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
    this.handoffSkipped = false;
    this.handoffs = 0;
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
export async function runTurn(turn, userMessage, images = []) {
  const config = loadConfig();
  const vision = config.modelSupportsImages === true;
  const signal = turn.abortController.signal;
  const isChat = turn.agentMode === 'chat';
  turn.emit({ type: 'user', message: userMessage, mode: turn.mode, agentMode: turn.agentMode, images });
  await appendMessage(turn.sessionId, { role: 'user', content: userMessage, images });
  // history: everything since the latest handoff marker (older rows stay in the session, readable)
  const messages = historyFromRows(loadMessages(turn.sessionId));

  const agentsMd = isChat ? null : await loadAgentsMd(turn.workspace);
  const skillsSection = isChat ? null : skillsSectionText(await discoverSkills({ workspace: turn.workspace }));
  const systemPrompt = isChat
    ? await buildChatSystemPrompt({ model: config.model })
    : await buildSystemPrompt({ workspace: turn.workspace, agentsMd, skillsSection, model: config.model });

  let stepUsage = null;
  let usageCorrection = 0; // real prompt tokens - estimate for the last request (usage is ground truth)
  try {
    for (let step = 0; step < turn.maxSteps; step++) {
      if (turn.stopped) break;
      stepUsage = null;
      if (!isChat && !turn.handoffSkipped) {
        const next = contextTokens([{ role: 'system', content: systemPrompt }, ...materializeForModel(messages, { vision })]) + usageCorrection;
        if (next >= config.handoffLimit) {
          const done = await performHandoff(turn, config, { systemPrompt, messages, signal });
          usageCorrection = 0;
          if (!done) turn.handoffSkipped = true;
          continue;
        }
      }
      const context = trimContext([{ role: 'system', content: systemPrompt }, ...materializeForModel(messages, { vision })], config.contextLimit);
      const sentEstimate = contextTokens(context);
      const result = await streamChatCompletion({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        messages: context,
        tools: isChat ? undefined : await activeToolList(turn.workspace),
        reasoning: turn.reasoning,
        signal,
        onText: (t) => turn.emit({ type: 'text_delta', text: t }),
        onReasoning: (t) => turn.emit({ type: 'reasoning_delta', text: t }),
        onToolCallDelta: (d) =>
          turn.emit({ type: 'tool_args_delta', callIndex: d.index ?? 0, id: d.id, argsFragment: d.function?.arguments ?? '', toolName: d.function?.name }),
        onRetry: (r) => turn.emit({ type: 'retry', attempt: r.attempt, error: String(r.error?.message ?? r.error) }),
        onUsage: (u) => {
          stepUsage = { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };
          turn.usage.promptTokens += u.prompt_tokens ?? 0;
          turn.usage.completionTokens += u.completion_tokens ?? 0;
          turn.usage.totalTokens += u.total_tokens ?? 0;
          turn.usage.requests += 1;
          turn.emit({ type: 'usage', usage: u, total: turn.usage });
        },
      });
      if (stepUsage) usageCorrection = stepUsage.promptTokens - sentEstimate;

      const asstMsg = { role: 'assistant', content: result.message.content ?? null };
      if (result.message.tool_calls?.length) {
        asstMsg.tool_calls = result.message.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        }));
      }
      messages.push(asstMsg);
      const mid = await appendMessage(turn.sessionId, asstMsg, { model: config.model, usage: stepUsage });
      turn.emit({ type: 'message_end', content: asstMsg.content, messageId: mid });

      if (!asstMsg.tool_calls?.length) break;
      if (isChat) break; // Chat mode never executes tools

      const deferredScreenshots = [];
      for (let i = 0; i < asstMsg.tool_calls.length; i++) {
        const call = asstMsg.tool_calls[i];
        const callId = call.id || `call-${step}-${i}`;
        const toolName = call.function.name;
        let pendingScreenshot = null;
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
          const decision = decidePermission({ mode: turn.mode, toolName, args: parsed, alwaysAllow: turn.alwaysAllow, readOnly: toolName.startsWith('mcp__') && mcpIsReadOnly(toolName) });
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
            const toolRes = await runTool(toolName, { workspace: turn.workspace, signal, sessionId: turn.sessionId, emit: (d) => turn.emit(d) }, parsed);
            resultText = toolRes.content;
            diff = toolRes.diff ?? null;
            if (!toolRes.ok) status = 'error';
            if (toolRes.timedOut) status = 'timeout';
            if (toolRes.aborted) status = 'stopped';
            pendingScreenshot = toolRes.screenshot ?? null;
          }
        }

        turn.emit({ type: 'tool_end', callId, name: toolName, status, result: resultText, diff });
        const toolMsg = { role: 'tool', tool_call_id: callId, name: toolName, content: resultText };
        messages.push(toolMsg);
        await appendMessage(turn.sessionId, toolMsg);
        // OpenAI-compatible servers reject images inside tool messages, so a browser
        // screenshot is attached as a follow-up user message — but only after every
        // tool result of this assistant turn, to keep the tool-call order valid.
        if (pendingScreenshot) deferredScreenshots.push(pendingScreenshot);
      }
      for (const shotId of deferredScreenshots) {
        const shotMsg = { role: 'user', content: '[screenshot]', name: SCREENSHOT_NAME, images: [shotId] };
        messages.push(shotMsg);
        await appendMessage(turn.sessionId, shotMsg);
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

/**
 * Automatic context handoff (Code mode): ask the model to summarize the session,
 * persist it as a named handoff message and reset the working context to it.
 * Older messages stay in the session (still readable in the UI).
 */
async function performHandoff(turn, config, { systemPrompt, messages, signal }) {
  const directive = { role: 'user', content: HANDOFF_DIRECTIVE };
  const ctx = trimContext([{ role: 'system', content: systemPrompt }, ...messages, directive], config.contextLimit);
  let usage = null;
  const result = await streamChatCompletion({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    messages: ctx,
    reasoning: turn.reasoning,
    signal,
    onText: (t) => turn.emit({ type: 'handoff_delta', text: t }),
    onRetry: (r) => turn.emit({ type: 'retry', attempt: r.attempt, error: String(r.error?.message ?? r.error) }),
    onUsage: (u) => {
      usage = u;
      turn.usage.promptTokens += u.prompt_tokens ?? 0;
      turn.usage.completionTokens += u.completion_tokens ?? 0;
      turn.usage.totalTokens += u.total_tokens ?? 0;
      turn.usage.requests += 1;
      turn.emit({ type: 'usage', usage: u, total: turn.usage });
    },
  });
  const summary = String(result.message.content ?? '').trim();
  if (!summary) return false;
  const msg = { role: 'assistant', content: summary, name: HANDOFF_NAME };
  const mid = await appendMessage(turn.sessionId, msg, {
    model: config.model,
    usage: usage ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 } : null,
  });
  turn.handoffs += 1;
  messages.length = 0;
  messages.push({ role: 'assistant', content: summary });
  turn.emit({ type: 'handoff', messageId: mid, summary, count: turn.handoffs });
  return true;
}

export async function startTurn({ sessionId, workspace, message, mode, agentMode = 'code', reasoning, images = [] }) {
  if (turns.has(String(sessionId))) {
    const existing = turns.get(String(sessionId));
    if (!existing.finished) throw Object.assign(new Error('A turn is already running for this session'), { status: 409 });
  }
  const config = loadConfig();
  // a conversation keeps the mode it was created with
  const stored = getConversation(sessionId);
  const convMode = stored ? stored.mode : agentMode === 'chat' ? 'chat' : 'code';
  const isChat = convMode === 'chat';
  const convReasoning = reasoning && ['auto', 'high', 'medium', 'low', 'off'].includes(reasoning) ? reasoning : stored?.reasoning ?? 'auto';
  ensureConversation(sessionId, { workspace: isChat ? null : workspace, mode: convMode, reasoning: convReasoning });
  const turn = new Turn({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: String(sessionId),
    workspace: isChat ? null : workspace,
    mode: mode ?? 'ask',
    agentMode: convMode,
    maxSteps: isChat ? 1 : config.maxSteps,
    reasoning: convReasoning,
  });
  turns.set(turn.sessionId, turn);
  // run detached
  runTurn(turn, message, images);
  return turn;
}
