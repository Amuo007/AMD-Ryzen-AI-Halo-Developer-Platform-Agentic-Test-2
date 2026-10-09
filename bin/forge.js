#!/usr/bin/env node
import { startServer } from '../src/server.js';

const argv = process.argv.slice(2);
function flagVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const port = Number(flagVal('--port', process.env.FORGE_PORT || 4848));
const openBrowser = !argv.includes('--no-open');

try {
  const { url, close } = await startServer({ port, openBrowser });
  console.log(`forge running at ${url}`);
  console.log('(press Ctrl+C to stop)');
  const shutdown = () => {
    close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`forge: port ${port} is already in use. Try --port <other>`);
  } else {
    console.error('forge failed to start:', err.message);
  }
  process.exit(1);
}
