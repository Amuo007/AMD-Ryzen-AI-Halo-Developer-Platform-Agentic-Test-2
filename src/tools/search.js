import fs from 'node:fs';
import path from 'node:path';
import { assertInWorkspace } from '../sandbox.js';
import { globToRegExp } from '../glob.js';

export const MAX_MATCHES = 200;
export const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_CONTEXT = 3;
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, root, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), root, files);
    } else if (ent.isFile()) {
      files.push(path.join(dir, ent.name));
    }
  }
}

/**
 * Regex search across files in the workspace. Skips node_modules and .git.
 * Binary-ish or huge files are ignored.
 * Options: glob (path filter), ignore_case, context_lines (0-3 lines of
 * surrounding context per match).
 */
export function search({ workspace }, args = {}) {
  let root;
  try {
    root = assertInWorkspace(workspace, args.path ?? '.');
  } catch (err) {
    return { ok: false, content: `Error: ${err.message}` };
  }
  let re;
  try {
    re = new RegExp(String(args.pattern ?? ''), String(args.flags ?? 'g'));
  } catch (err) {
    return { ok: false, content: `Error: invalid regex pattern: ${err.message}` };
  }
  if (!re.global) re = new RegExp(re.source, re.flags + 'g');
  let globRe = null;
  if (args.glob) {
    try {
      globRe = globToRegExp(String(args.glob));
    } catch (err) {
      return { ok: false, content: `Error: invalid glob filter "${args.glob}": ${err.message}` };
    }
  }
  const ignoreCase = args.ignore_case === true && !re.flags.includes('i');
  if (ignoreCase) re = new RegExp(re.source, re.flags + 'i');
  const context = Math.max(0, Math.min(MAX_CONTEXT, Number(args.context_lines) || 0));

  const files = [];
  const wsReal = (() => {
    try {
      return fs.realpathSync(workspace);
    } catch {
      return workspace;
    }
  })();
  const st = (() => {
    try {
      return fs.statSync(root);
    } catch {
      return null;
    }
  })();
  if (!st) return { ok: false, content: `Error: path not found: ${args.path ?? '.'}` };
  if (st.isFile()) files.push(root);
  else walk(root, root, files);

  const matches = [];
  let truncated = false;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE) continue;
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (data.includes(0)) continue; // binary
    const rel = path.relative(wsReal, file) || file;
    if (globRe && !globRe.test(rel)) continue;
    const lines = data.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        if (context > 0) {
          for (let c = 1; c <= context; c++) {
            if (i + c < lines.length) matches.push(`${rel}:${i + c + 1}- ${lines[i + c].trim().slice(0, 240)}`);
          }
        }
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }
  if (matches.length === 0) return { ok: true, content: 'No matches found.', count: 0 };
  let content = matches.join('\n');
  if (truncated) content += `\n... truncated at ${MAX_MATCHES} matches; narrow the pattern, glob or path.`;
  return { ok: true, content, count: matches.length, truncated };
}
