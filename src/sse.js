/**
 * Incremental Server-Sent Events parser. Feed it raw text chunks; it calls
 * onData(dataString) for every complete `data:` payload (multiple `data:`
 * lines in one event are joined with \n). Handles \n, \r\n and \r line
 * endings and payloads split across chunks.
 */
export class SSEParser {
  constructor(onData) {
    this.onData = onData;
    this.buf = '';
  }

  feed(chunk) {
    this.buf += chunk;
    let sep;
    while ((sep = this.findEventEnd()) !== null) {
      const raw = this.buf.slice(0, sep.index);
      this.buf = this.buf.slice(sep.index + sep.len);
      this.dispatchEvent(raw);
    }
  }

  findEventEnd() {
    const text = this.buf;
    let best = null;
    for (const nl of ['\n\n', '\r\n\r\n', '\r\r']) {
      const i = text.indexOf(nl);
      if (i !== -1 && (best === null || i < best.index)) best = { index: i, len: nl.length };
    }
    return best;
  }

  dispatchEvent(raw) {
    const dataLines = [];
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (line.startsWith('data:')) {
        let d = line.slice(5);
        if (d.startsWith(' ')) d = d.slice(1);
        dataLines.push(d);
      }
      // `event:`, `id:`, `retry:` and comments are ignored
    }
    if (dataLines.length > 0) this.onData(dataLines.join('\n'));
  }
}

/**
 * Assembles OpenAI streaming tool-call deltas into complete tool calls.
 * Handles several tool calls arriving in one turn and arguments split
 * across many chunks.
 */
export class ToolCallAssembler {
  constructor() {
    this.byIndex = new Map();
  }

  addDeltas(deltas) {
    for (const d of deltas) this.addDelta(d);
  }

  addDelta(delta) {
    const idx = delta.index ?? 0;
    let cur = this.byIndex.get(idx);
    if (!cur) {
      cur = { id: '', type: 'function', function: { name: '', arguments: '' } };
      this.byIndex.set(idx, cur);
    }
    if (delta.id) cur.id = delta.id;
    if (delta.type) cur.type = delta.type;
    if (delta.function?.name != null) cur.function.name += delta.function.name;
    if (delta.function?.arguments != null) cur.function.arguments += delta.function.arguments;
  }

  calls() {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]) => ({ ...c, index: idx }));
  }

  get size() {
    return this.byIndex.size;
  }
}

/** Convenience: assemble from a list of delta objects. */
export function assembleToolCalls(deltas) {
  const a = new ToolCallAssembler();
  a.addDeltas(deltas);
  return a.calls().map(({ index, ...call }) => call);
}
