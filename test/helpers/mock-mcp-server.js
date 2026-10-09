#!/usr/bin/env node
/**
 * Mock MCP (Model Context Protocol) server over stdio for tests.
 * Tools: echo (readOnlyHint), fail (isError), slow (delays).
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            annotations: { readOnlyHint: true },
          },
          { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
          { name: 'slow', description: 'Takes long', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${params?.arguments?.text ?? ''}` }] } });
    } else if (name === 'fail') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'this tool always fails' }], isError: true } });
    } else if (name === 'slow') {
      setTimeout(() => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'finally' }] } }), Number(params?.arguments?.ms ?? 1000));
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
