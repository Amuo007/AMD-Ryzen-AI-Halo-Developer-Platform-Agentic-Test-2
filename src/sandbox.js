import fs from 'node:fs';
import path from 'node:path';

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function contains(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * POSIX-style deep resolution: walk each path component, following every
 * symlink encountered. Components that do not exist yet are kept as-is.
 * Guards against symlink loops.
 */
export function deepResolve(p) {
  const rel = path.resolve(p);
  let cur = path.sep;
  for (const part of rel.slice(1).split(path.sep)) {
    cur = cur === path.sep ? path.sep + part : cur + path.sep + part;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue; // component does not exist yet
    }
    let hops = 0;
    while (st.isSymbolicLink()) {
      if (++hops > 40) throw new Error(`Too many symlink levels at ${cur}`);
      const target = fs.readlinkSync(cur);
      cur = path.isAbsolute(target) ? target : path.resolve(path.dirname(cur), target);
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // dangling symlink: keep resolved target
      }
    }
  }
  return cur;
}

/**
 * Resolve `target` relative to `workspace` and verify it stays inside the
 * workspace. Resolves `..` segments and symlinks (including symlinks that
 * point outside the workspace, and paths that do not exist yet).
 * Returns { ok, resolved, error }.
 */
export function resolveInWorkspace(workspace, target) {
  if (typeof target !== 'string') {
    return { ok: false, resolved: null, error: 'Path must be a string' };
  }
  const ws = path.resolve(workspace);
  const wsReal = realpathOrNull(ws) ?? ws;
  const logical = path.resolve(ws, target);
  if (!contains(ws, logical)) {
    return { ok: false, resolved: logical, error: `Path escapes workspace: ${target}` };
  }

  let real;
  try {
    real = deepResolve(logical);
  } catch (err) {
    return { ok: false, resolved: null, error: `Cannot resolve path ${target}: ${err.message}` };
  }

  if (!contains(wsReal, real)) {
    return { ok: false, resolved: real, error: `Path escapes workspace (via symlink or traversal): ${target}` };
  }
  return { ok: true, resolved: real };
}

export function assertInWorkspace(workspace, target) {
  const r = resolveInWorkspace(workspace, target);
  if (!r.ok) throw new Error(r.error);
  return r.resolved;
}
