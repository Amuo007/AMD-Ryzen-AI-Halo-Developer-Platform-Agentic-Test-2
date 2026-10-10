export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function messageTokens(msg) {
  let chars = 0;
  if (typeof msg.content === 'string') chars += msg.content.length;
  else if (msg.content != null) chars += JSON.stringify(msg.content).length;
  if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
  return Math.ceil(chars / 4);
}

export function contextTokens(messages) {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/**
 * Human-readable breakdown of what fills the context window.
 * `actualPromptTokens` (from the API's usage for the last request) is used as
 * ground truth for `used` when provided: real count for everything that was
 * in that request plus the estimate for anything appended after it.
 */
export function contextBreakdown({ systemPrompt, skillsSection = null, toolDefs = [], messages = [], actualPromptTokens = null, sinceActual = [] }) {
  const skillsTokens = skillsSection ? estimateTokens(skillsSection) : 0;
  const baseSystemTokens = estimateTokens(String(systemPrompt || '').replace(String(skillsSection || ''), ''));
  const parts = [
    { label: 'System prompt', tokens: baseSystemTokens },
    { label: 'Skills (names + descriptions)', tokens: skillsTokens },
    { label: 'Tool definitions', tokens: toolDefs.reduce((n, d) => n + estimateTokens(JSON.stringify(d)), 0) },
  ];
  const cats = { user: 0, assistant: 0, tool: 0 };
  for (const m of messages) {
    if (m.role === 'system') continue;
    const t = messageTokens(m);
    if (cats[m.role] !== undefined) cats[m.role] += t;
    else cats.tool += 0;
  }
  parts.push({ label: 'Your messages', tokens: cats.user });
  parts.push({ label: 'Model replies', tokens: cats.assistant });
  parts.push({ label: 'Tool results', tokens: cats.tool });
  const estimate = parts.reduce((n, p) => n + p.tokens, 0);
  const used = actualPromptTokens > 0 ? actualPromptTokens + contextTokens(sinceActual) : estimate;
  return { parts: parts.filter((p) => p.tokens > 0), estimate, used, actual: actualPromptTokens > 0 ? actualPromptTokens : null };
}

function shrinkText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  return `${head}\n[… output shrunk from ${text.length} to ${maxChars} chars by context management]`;
}

/**
 * Keep the message list under `limit` tokens (characters / 4).
 *  1. Shrink old tool outputs first (most recent `keepRecentToolMsgs`
 *     untouched, then progressively smaller).
 *  2. If still over, drop the oldest turns.
 * Never drops the system prompt (index 0) or the latest user message.
 * Returns a new array; does not mutate the input.
 */
export function trimContext(messages, limit, { shrinkTo = 800, keepRecentToolMsgs = 2 } = {}) {
  let msgs = messages.map((m) => ({ ...m }));
  if (contextTokens(msgs) <= limit) return msgs;

  // Phase 1: shrink tool results, oldest first. The most recent
  // `keepRecentToolMsgs` tool messages are only shrunk if shrinking the
  // older ones was not enough.
  const toolIdx = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === 'tool') toolIdx.push(i);
  }
  const cut = Math.max(0, toolIdx.length - keepRecentToolMsgs);
  const shrinkOrder = [...toolIdx.slice(0, cut), ...toolIdx.slice(cut)];
  for (const i of shrinkOrder) {
    if (contextTokens(msgs) <= limit) break;
    msgs[i] = { ...msgs[i], content: shrinkText(msgs[i].content, shrinkTo) };
  }

  // Phase 2: drop oldest turns while still over the limit.
  while (contextTokens(msgs) > limit && msgs.length > 1) {
    const lastUserIdx = msgs.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
    let target = -1;
    for (let i = 1; i < msgs.length; i++) {
      if (i !== lastUserIdx) {
        target = i;
        break;
      }
    }
    if (target === -1) break; // only protected messages remain
    const victim = msgs[target];
    if (victim.role === 'assistant' && Array.isArray(victim.tool_calls) && victim.tool_calls.length > 0) {
      const ids = new Set(victim.tool_calls.map((tc) => tc.id));
      let end = target + 1;
      while (end < msgs.length && msgs[end].role === 'tool' && ids.has(msgs[end].tool_call_id)) end++;
      msgs.splice(target, end - target);
    } else {
      msgs.splice(target, 1);
    }
  }
  return msgs;
}
