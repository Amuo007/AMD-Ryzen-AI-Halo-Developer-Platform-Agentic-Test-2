const MAX_DP_CELLS = 1_000_000;

export const DIFF_MAX_LINES = 4000;

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: 'add', text }));
  if (m === 0) return a.map((text) => ({ type: 'del', text }));
  if (n * m > MAX_DP_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/**
 * Line diff of two texts. Returns [{type:'add'|'del'|'ctx', text}].
 * Common prefix/suffix are kept as context. Very large inputs fall back to a
 * full replace so the UI diff stays cheap.
 */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '') === '' ? [] : String(oldText).split('\n');
  const b = String(newText ?? '') === '' ? [] : String(newText).split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [
      { type: 'meta', text: `[diff too large: ${a.length} -> ${b.length} lines, showing as full replacement]` },
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ae = a.length;
  let be = b.length;
  while (ae > start && be > start && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ type: 'ctx', text: a[i] });
  out.push(...lcsDiff(a.slice(start, ae), b.slice(start, be)));
  for (let i = ae; i < a.length; i++) out.push({ type: 'ctx', text: a[i] });
  return out;
}
