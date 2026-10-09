/**
 * Minimal glob matcher shared by the glob_files tool and search filters.
 * Supports: `*` (within a path segment), `**` and double-star-slash (zero or
 * more directories), `?`, `[char...]` classes, `{a,b}` alternatives.
 * Paths use forward slashes. A bare pattern (no slash) matches file names in
 * any directory.
 */

function escapeRe(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Expand one glob string into regex source. Braces recurse (segment-local). */
function expand(glob, inBrace = false) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*' && !inBrace) {
        i++;
        if (glob[i + 1] === '/') {
          i++; // `**/` → zero or more directories
          re += '(?:[^/]*/)*';
        } else {
          re += '.*'; // trailing `**`
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (c === '{') {
      // find the matching '}' at this depth
      let depth = 0;
      let j = i;
      for (; j < glob.length; j++) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= glob.length) {
        re += '\\{';
      } else {
        const inner = glob.slice(i + 1, j);
        const alts = splitTop(inner, ',');
        re += `(?:${alts.map((a) => expand(a, true)).join('|')})`;
        i = j;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

/** Split on top-level commas (brace depth 0). */
function splitTop(src, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of src) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Compile a glob pattern to an anchored case-sensitive RegExp. */
export function globToRegExp(pattern) {
  const src = String(pattern).replace(/\\/g, '/');
  const body = expand(src);
  const prefixed = src.includes('/') ? body : `(?:[^/]*/)*${body}`;
  return new RegExp(`^${prefixed}$`);
}

/** True when `relPath` matches the glob `pattern`. */
export function globMatch(pattern, relPath) {
  try {
    return globToRegExp(pattern).test(relPath);
  } catch {
    return false;
  }
}
