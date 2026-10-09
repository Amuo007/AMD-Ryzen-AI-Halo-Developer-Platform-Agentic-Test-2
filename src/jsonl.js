/**
 * Legacy JSONL session parsing (pre-SQLite storage). Used by the db importer
 * to bring `<workspace>/.forge/sessions/*.jsonl` conversations into SQLite.
 */

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip corrupt lines rather than fail the whole session
    }
  }
  return out;
}

export function firstUserTitle(objs) {
  for (const o of objs) {
    if (o.type === 'meta' && o.title) return o.title;
  }
  for (const o of objs) {
    if (o.role === 'user' && typeof o.content === 'string' && o.content.trim()) {
      const t = o.content.trim().replace(/\s+/g, ' ');
      return t.length > 60 ? `${t.slice(0, 60)}…` : t;
    }
  }
  return 'Untitled session';
}
