import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCAL-ONLY guard. The browser may open only:
 *   - http(s)://localhost:<port>, 127.0.0.1, [::1] or *.localhost (any port)
 *   - file:// paths inside the workspace
 * Everything else is refused. Returns { ok, resolved } or { ok:false, error }.
 */
export function isLocalUrl(raw, { workspace = null } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  if (url.protocol === 'file:') {
    if (!workspace) return { ok: false, error: 'file:// URLs need a workspace to be set' };
    let file;
    try {
      file = decodeURIComponent(url.pathname);
    } catch {
      file = url.pathname;
    }
    const real = safeReal(path.resolve(file));
    const realWs = safeReal(path.resolve(workspace));
    if (!real || !realWs) return { ok: false, error: 'file:// path does not exist' };
    if (real !== realWs && !real.startsWith(realWs + path.sep)) return { ok: false, error: 'file:// URL is outside the workspace' };
    return { ok: true, resolved: url.href };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `Refusing non-local URL (only localhost / 127.0.0.1 / *.localhost / file-in-workspace are allowed): ${raw}` };
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { ok: true, resolved: url.href };
  if (host.endsWith('.localhost')) return { ok: true, resolved: url.href };
  return { ok: false, error: `Refusing non-local host "${host}" — the browser is restricted to localhost and workspace files. (${raw})` };
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
