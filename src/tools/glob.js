import fs from 'node:fs';
import path from 'node:path';
import { assertInWorkspace } from '../sandbox.js';
import { globToRegExp } from '../glob.js';

export const MAX_RESULTS = 300;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * List files in the workspace whose relative path matches a glob pattern.
 * Newest first (mtime). Skips node_modules/.git; caps at MAX_RESULTS.
 */
export function globFiles({ workspace }, args = {}) {
  let root;
  try {
    root = assertInWorkspace(workspace, args.path ?? '.');
  } catch (err) {
    return { ok: false, content: `Error: ${err.message}` };
  }
  const pattern = String(args.pattern ?? '').trim();
  if (!pattern) return { ok: false, content: 'Error: pattern is required, e.g. "src/**/*.js" or "*.{ts,tsx}".' };
  let re;
  try {
    re = globToRegExp(pattern);
  } catch (err) {
    return { ok: false, content: `Error: invalid glob pattern "${pattern}": ${err.message}` };
  }
  const wsReal = (() => {
    try {
      return fs.realpathSync(workspace);
    } catch {
      return workspace;
    }
  })();

  const hits = [];
  let scanned = 0;
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        scanned++;
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        const rel = path.relative(wsReal, full) || full;
        if (re.test(rel)) {
          hits.push({ rel, mtime });
          if (hits.length >= MAX_RESULTS) truncated = true;
        }
      }
    }
  };
  walk(root, 0);

  hits.sort((a, b) => b.mtime - a.mtime);
  if (hits.length === 0) {
    return { ok: true, content: `No files match "${pattern}" (${scanned} files scanned). Try a broader pattern or check the path.`, count: 0 };
  }
  let content = hits.map((h) => h.rel).join('\n');
  if (truncated) content += `\n… truncated at ${MAX_RESULTS} files; narrow the pattern.`;
  return { ok: true, content, count: hits.length, truncated };
}
