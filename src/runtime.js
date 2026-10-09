import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * forge requires Node >= 22 (native `node:sqlite`). Many machines still default
 * to Node 20; if so, locate a local Node 22 (FORGE_NODE, or the highest
 * nvm-installed 22.x) and re-exec the current command under it so `npm start`
 * and `npm test` work out of the box. No-op when the current Node is fine.
 */
export const MIN_NODE = 22;

export function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

export function findNode(minMajor = MIN_NODE) {
  if (nodeMajor() >= minMajor) return process.execPath;
  if (process.env.FORGE_NODE && fs.existsSync(process.env.FORGE_NODE)) return process.env.FORGE_NODE;
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    const best = fs
      .readdirSync(versionsDir)
      .map((name) => ({ name, major: Number(name.replace(/^v/, '').split('.')[0]), path: path.join(versionsDir, name, 'bin', 'node') }))
      .filter((v) => v.major >= minMajor && fs.existsSync(v.path))
      .sort((a, b) => (a.name < b.name ? 1 : -1))[0];
    if (best) return best.path;
  } catch {
    /* no nvm */
  }
  return null;
}

/**
 * If the current Node is too old, run `argv` under a suitable Node and exit with
 * its status. Returns nothing when the current Node already qualifies.
 */
export function ensureNode22OrExit(argv, { label = 'forge' } = {}) {
  if (nodeMajor() >= MIN_NODE) return;
  const node = findNode();
  if (!node) {
    console.error(`${label} requires Node.js >= ${MIN_NODE} (for built-in node:sqlite). Running ${process.version}. Please install Node 22.`);
    process.exit(1);
  }
  if (node === process.execPath) return;
  const res = spawnSync(node, argv, { stdio: 'inherit', env: { ...process.env, FORGE_NODE: '' } });
  process.exit(res.status ?? 1);
}
