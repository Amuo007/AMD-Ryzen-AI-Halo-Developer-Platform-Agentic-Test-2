import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findNode, nodeMajor, MIN_NODE } from '../src/runtime.js';

// npm test bootstrap: run the *.test.js suite under a Node that has node:sqlite.
const node = findNode();
if (!node) {
  console.error(`forge tests require Node.js >= ${MIN_NODE} (node:sqlite). Running ${process.version}.`);
  process.exit(1);
}
if (nodeMajor() < MIN_NODE) console.log(`running tests under ${node} (current ${process.version} lacks node:sqlite)`);

const testDir = path.join(process.cwd(), 'test');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f)).sort();
const res = spawnSync(node, ['--test', ...files, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
process.exit(res.status ?? 1);
