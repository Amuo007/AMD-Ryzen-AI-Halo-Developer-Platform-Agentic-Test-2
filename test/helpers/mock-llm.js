import http from 'node:http';

export function startMockLLM(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const reply = handler(body, requests.length, { req, res });
        if (reply?.status) {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: reply.error ?? 'mock error' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const list = typeof reply.chunks === 'function' ? reply.chunks() : reply.chunks;
        for (const chunk of list) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export function deltaChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function usageChunk(usage) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [],
    usage,
  };
}

export function textChunks(text, per = 3) {
  const out = [];
  for (let i = 0; i < text.length; i += per) out.push(deltaChunk({ content: text.slice(i, i + per) }));
  return out;
}

export function toolCallChunks(name, argsString, { id = 'call_1', index = 0 } = {}) {
  const out = [];
  let first = { index };
  first = { index, id, type: 'function', function: { name, arguments: '' } };
  out.push(deltaChunk({ role: 'assistant' }));
  out.push(deltaChunk({ tool_calls: [first] }));
  for (let i = 0; i < argsString.length; i += 5) {
    out.push(deltaChunk({ tool_calls: [{ index, function: { arguments: argsString.slice(i, i + 5) } }] }));
  }
  return out;
}
