import { SSEParser, assembleToolCalls } from './sse.js';

export class LLMError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_RETRY = { maxTries: 3, baseDelayMs: 500 };

/**
 * Stream a chat completion from an OpenAI-compatible API.
 *
 * Callbacks:
 *  - onText(textDelta)           content text as it arrives
 *  - onReasoning(textDelta)      reasoning_content deltas (thinking models)
 *  - onToolCallDelta(delta)      raw tool-call delta (for live arg streaming)
 *  - onRetry({attempt, error})   before a retry sleep
 *  - onUsage(usage)              usage object when the API sends one
 *
 * Retries network errors and 5xx responses with exponential backoff.
 * Returns { message: {role, content, tool_calls}, finishReason, usage }.
 */
export async function streamChatCompletion({
  baseURL,
  apiKey,
  model,
  messages,
  tools,
  reasoning = 'auto', // auto | high | medium | low | off (real behavior: chat_template_kwargs + reasoning_effort)
  signal,
  onText,
  onReasoning,
  onToolCallDelta,
  onRetry,
  onUsage,
  maxRetries = DEFAULT_RETRY.maxTries,
  baseDelayMs = DEFAULT_RETRY.baseDelayMs,
  fetchImpl = fetch,
}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) body.tools = tools;
  // Thinking on/off + reasoning effort. Different chat templates look at
  // different keys: Qwen/GLM-style templates read chat_template_kwargs.enable_thinking,
  // others read chat_template_kwargs.thinking. Templates ignore kwargs they don't
  // understand, so we send BOTH names and each model picks up the one it knows.
  // (`auto` sends nothing and lets the template decide.)
  if (reasoning === 'off') {
    body.chat_template_kwargs = { enable_thinking: false, thinking: false };
  } else if (reasoning === 'low') {
    body.chat_template_kwargs = { enable_thinking: true, thinking: true };
    body.reasoning_effort = 'low';
  } else if (reasoning === 'medium') {
    body.chat_template_kwargs = { enable_thinking: true, thinking: true };
    body.reasoning_effort = 'medium';
  } else if (reasoning === 'high') {
    // thinking on, effort left to the template default: reasoning templates
    // define their own effort vocabularies (e.g. xhigh/medium/low) and reject
    // the OpenAI-style "high" value outright.
    body.chat_template_kwargs = { enable_thinking: true, thinking: true };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = res.status >= 500;
        const err = new LLMError(`LLM API returned ${res.status}: ${text.slice(0, 400)}`, {
          status: res.status,
          retryable,
        });
        if (retryable && attempt < maxRetries) {
          lastError = err;
          onRetry?.({ attempt: attempt + 1, error: err });
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
      return await consumeStream(res, { signal, onText, onReasoning, onToolCallDelta, onUsage });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err instanceof LLMError && !err.retryable) throw err;
      if (err instanceof LLMError && err.retryable && attempt >= maxRetries) throw err;
      if (err instanceof LLMError && err.retryable) {
        lastError = err;
        onRetry?.({ attempt: attempt + 1, error: err });
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      // network-level failure
      if (attempt < maxRetries) {
        lastError = new LLMError(`Cannot reach LLM server: ${err.cause?.message ?? err.message}`, { retryable: true });
        onRetry?.({ attempt: attempt + 1, error: lastError });
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new LLMError(`Cannot reach LLM server after ${maxRetries + 1} tries: ${err.cause?.message ?? err.message}`, {
        retryable: true,
      });
    }
  }
  throw lastError ?? new LLMError('LLM request failed');
}

async function consumeStream(res, { signal, onText, onReasoning, onToolCallDelta, onUsage }) {
  const decoder = new TextDecoder();
  const toolDeltas = [];
  const textParts = [];
  let usage = null;
  let finishReason = null;
  const parser = new SSEParser((data) => {
    if (data.trim() === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // ignore malformed keep-alive chunks
    }
    if (chunk.error) {
      // some servers report failures as an SSE data payload, not an HTTP status
      const status = Number(chunk.error.status ?? chunk.error.code ?? 0) || null;
      throw new LLMError(`LLM API error: ${chunk.error.message ?? chunk.error.code ?? 'unknown'}`, { status, retryable: status === null || status >= 500 });
    }
    if (chunk.usage) {
      usage = chunk.usage;
      onUsage?.(usage);
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length) {
      textParts.push(delta.content);
      onText?.(delta.content);
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      onReasoning?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        toolDeltas.push(tc);
        onToolCallDelta?.(tc);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  const reader = res.body.getReader();
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (process.env.FORGE_DEBUG) console.error('CONSUME-RAW', JSON.stringify(decoder.decode(value, { stream: false }).slice(0, 400)));
    parser.feed(decoder.decode(value, { stream: true }));
  }

  const toolCalls = assembleToolCalls(toolDeltas);
  const content = textParts.join('') || null;
  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, finishReason, usage };
}
