import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, assembleToolCalls, ToolCallAssembler } from '../src/sse.js';
import { streamChatCompletion, LLMError } from '../src/llm.js';
import { startMockLLM, deltaChunk, usageChunk, textChunks, toolCallChunks } from './helpers/mock-llm.js';

function collectParser() {
  const got = [];
  return { got, parser: new SSEParser((d) => got.push(d)) };
}

test('SSEParser: single event', () => {
  const { got, parser } = collectParser();
  parser.feed('data: hello\n\n');
  assert.deepEqual(got, ['hello']);
});

test('SSEParser: events split across chunks', () => {
  const { got, parser } = collectParser();
  parser.feed('data: hel');
  parser.feed('lo\n\ndata: second eve');
  parser.feed('nt\n\ndata: ');
  parser.feed('third\n\n');
  assert.deepEqual(got, ['hello', 'second event', 'third']);
});

test('SSEParser: multi-line data joined with newline', () => {
  const { got, parser } = collectParser();
  parser.feed('data: line1\ndata: line2\n\n');
  assert.deepEqual(got, ['line1\nline2']);
});

test('SPEParser: \\r\\n line endings and comments ignored', () => {
  const { got, parser } = collectParser();
  parser.feed(': keep-alive\n\nevent: message\r\ndata: crlf\r\n\r\n');
  assert.deepEqual(got, ['crlf']);
});

test('SSEParser: data without space after colon', () => {
  const { got, parser } = collectParser();
  parser.feed('data:nospace\n\n');
  assert.deepEqual(got, ['nospace']);
});

test('assemble single tool call from fragments', () => {
  const calls = assembleToolCalls([
    { index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '' } },
    { index: 0, function: { arguments: '{"path":' } },
    { index: 0, function: { arguments: '"a.txt"}' } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'c1');
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.txt' });
});

test('assemble several tool calls in one turn', () => {
  const calls = assembleToolCalls([
    { index: 0, id: 'a', type: 'function', function: { name: 'write_file', arguments: '{"path":' } },
    { index: 1, id: 'b', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
    { index: 0, function: { arguments: '"x.txt",' } },
    { index: 0, function: { arguments: '"content":"hi"}' } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'x.txt', content: 'hi' });
  assert.equal(calls[1].id, 'b');
});

test('ToolCallAssembler: empty stream yields no calls', () => {
  assert.deepEqual(new ToolCallAssembler().calls(), []);
});

test('streamChatCompletion: streams text and usage', async () => {
  const mock = await startMockLLM(() => ({
    chunks: [deltaChunk({ role: 'assistant' }), ...textChunks('Hello world'), deltaChunk({}, 'stop'), usageChunk({ prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 })],
  }));
  try {
    const texts = [];
    const usages = [];
    const res = await streamChatCompletion({
      baseURL: mock.url, apiKey: 'test', model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      onText: (t) => texts.push(t),
      onUsage: (u) => usages.push(u),
    });
    assert.equal(res.message.content, 'Hello world');
    assert.equal(res.finishReason, 'stop');
    assert.equal(texts.join(''), 'Hello world');
    assert.equal(usages[0].total_tokens, 22);
    assert.equal(res.usage.total_tokens, 22);
    assert.equal(res.message.role, 'assistant');
    assert.equal(res.message.tool_calls, undefined);
  } finally {
    await mock.close();
  }
});

test('streamChatCompletion: assembles tool calls and reasoning deltas ignored gracefully', async () => {
  const args = JSON.stringify({ path: 'hello.txt', content: 'hello\n' });
  const mock = await startMockLLM(() => ({
    chunks: [
      deltaChunk({ role: 'assistant', reasoning_content: 'I will ' }),
      deltaChunk({ reasoning_content: 'write it' }),
      ...toolCallChunks('write_file', args),
      deltaChunk({}, 'tool_calls'),
      usageChunk({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }),
    ],
  }));
  try {
    const reasoning = [];
    const toolDeltas = [];
    const res = await streamChatCompletion({
      baseURL: mock.url, model: 'mock-model',
      messages: [{ role: 'user', content: 'write hello' }],
      tools: [{ type: 'function', function: { name: 'write_file' } }],
      onReasoning: (t) => reasoning.push(t),
      onToolCallDelta: (d) => toolDeltas.push(d),
    });
    assert.equal(reasoning.join(''), 'I will write it');
    assert.ok(toolDeltas.length > 1);
    assert.equal(res.message.tool_calls.length, 1);
    assert.equal(res.message.tool_calls[0].function.name, 'write_file');
    assert.deepEqual(JSON.parse(res.message.tool_calls[0].function.arguments), { path: 'hello.txt', content: 'hello\n' });
  } finally {
    await mock.close();
  }
});

test('streamChatCompletion: retries 5xx with backoff then succeeds', async () => {
  let calls = 0;
  const mock = await startMockLLM((body, n) => {
    calls = n;
    if (n < 3) return { status: 500 };
    return { chunks: [...textChunks('finally'), deltaChunk({}, 'stop')] };
  });
  try {
    const retries = [];
    const start = Date.now();
    const res = await streamChatCompletion({
      baseURL: mock.url, model: 'mock-model',
      messages: [{ role: 'user', content: 'go' }],
      onRetry: (r) => retries.push(r.attempt),
      baseDelayMs: 40,
    });
    assert.equal(res.message.content, 'finally');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
    assert.ok(Date.now() - start >= 120, 'exponential backoff waited (40 + 80)ms');
  } finally {
    await mock.close();
  }
});

test('streamChatCompletion: gives up after max retries on persistent 5xx', async () => {
  const mock = await startMockLLM(() => ({ status: 503 }));
  try {
    await assert.rejects(
      streamChatCompletion({ baseURL: mock.url, model: 'm', messages: [], baseDelayMs: 10 }),
      (err) => err instanceof LLMError && /503/.test(err.message)
    );
    assert.equal(mock.requests.length, 4); // 1 + 3 retries
  } finally {
    await mock.close();
  }
});

test('streamChatCompletion: 4xx is not retried', async () => {
  const mock = await startMockLLM(() => ({ status: 400, error: { message: 'bad request' } }));
  try {
    await assert.rejects(
      streamChatCompletion({ baseURL: mock.url, model: 'm', messages: [], baseDelayMs: 10 }),
      (err) => err instanceof LLMError && err.status === 400
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test('streamChatCompletion: network error is retried then surfaced', async () => {
  await assert.rejects(
    streamChatCompletion({ baseURL: 'http://127.0.0.1:9/v1', model: 'm', messages: [], baseDelayMs: 10, maxRetries: 1 }),
    (err) => err instanceof LLMError && /Cannot reach LLM server/.test(err.message)
  );
});

test('streamChatCompletion: abort signal stops the request', async () => {
  const mock = await startMockLLM(() => ({ chunks: [] }));
  const ac = new AbortController();
  ac.abort();
  try {
    await assert.rejects(
      streamChatCompletion({ baseURL: mock.url, model: 'm', messages: [], signal: ac.signal }),
      (err) => err.name === 'AbortError'
    );
  } finally {
    await mock.close();
  }
});

test('reasoning control maps to real request parameters', async () => {
  const mock = await startMockLLM(() => ({ chunks: [...textChunks('ok'), deltaChunk({}, 'stop')] }));
  try {
    const call = async (reasoning) => {
      const opts = { baseURL: mock.url, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] };
      if (reasoning !== undefined) opts.reasoning = reasoning;
      await streamChatCompletion(opts);
      return mock.requests.at(-1);
    };
    const auto = await call('auto');
    assert.ok(!('chat_template_kwargs' in auto), 'auto sends no thinking overrides');
    assert.ok(!('reasoning_effort' in auto));
    const off = await call('off');
    assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false, thinking: false }, 'off sends both thinking keys (Qwen reads enable_thinking, others read thinking)');
    assert.ok(!('reasoning_effort' in off));
    const low = await call('low');
    assert.deepEqual(low.chat_template_kwargs, { enable_thinking: true, thinking: true });
    assert.equal(low.reasoning_effort, 'low');
    const high = await call('high');
    assert.deepEqual(high.chat_template_kwargs, { enable_thinking: true, thinking: true });
    assert.ok(!('reasoning_effort' in high), 'high relies on the template default effort (templates define their own effort vocabularies)');
  } finally {
    await mock.close();
  }
});

test('a server error delivered as an SSE payload raises LLMError, not an empty completion', async () => {
  let n = 0;
  const mock = await startMockLLM(() => {
    n++;
    if (n === 1) return { chunks: [{ error: { code: 500, message: 'Unexpected reasoning effort high' } }] };
    return { chunks: [...textChunks('recovered'), deltaChunk({}, 'stop')] };
  });
  try {
    const res = await streamChatCompletion({ baseURL: mock.url, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }], maxRetries: 1, baseDelayMs: 10 });
    assert.equal(res.message.content, 'recovered');
    assert.equal(n, 2, 'retried after the error chunk');
  } finally {
    await mock.close();
  }
});
