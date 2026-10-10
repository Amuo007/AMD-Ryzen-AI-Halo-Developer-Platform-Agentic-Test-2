/**
 * Minimal Chrome DevTools Protocol client over the global WebSocket.
 * - request/response matched by id
 * - event subscription by method (and '*' for everything)
 * - per-request timeout + a clear error when the socket is unusable
 */
export class CDPClient {
  constructor(wsUrl, { timeout = 30000 } = {}) {
    this.wsUrl = String(wsUrl);
    this.timeout = timeout;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, method }
    this.listeners = new Map(); // event -> Set(cb)
    this.closed = false;
    this.closeHandlers = new Set();
  }

  connect({ timeout = this.timeout } = {}) {
    if (typeof WebSocket !== 'function') return Promise.reject(new Error('No WebSocket available (Node >= 22 required)'));
    return new Promise((resolve, reject) => {
      let opened = false;
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        return reject(new Error(`Cannot open CDP socket: ${err.message}`));
      }
      this.ws = ws;
      const fail = (msg) => {
        if (opened) return;
        opened = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(msg));
      };
      ws.addEventListener('open', () => { opened = true; resolve(); });
      ws.addEventListener('error', () => fail('CDP socket error'));
      ws.addEventListener('close', () => this._onClose());
      ws.addEventListener('message', (e) => {
        try {
          this._onMessage(typeof e.data === 'string' ? e.data : String(e.data));
        } catch {
          /* ignore malformed frame */
        }
      });
      setTimeout(() => fail('CDP connect timeout'), timeout);
    });
  }

  _onMessage(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (obj.id != null && this.pending.has(obj.id)) {
      const { resolve, reject, timer } = this.pending.get(obj.id);
      clearTimeout(timer);
      this.pending.delete(obj.id);
      if (obj.error) reject(new Error(obj.error.message || 'CDP command failed'));
      else resolve(obj.result);
    } else if (obj.method) {
      const set = this.listeners.get(obj.method);
      if (set) for (const cb of set) {
        try {
          cb(obj.params || {}, obj.sessionId);
        } catch {
          /* listener errors never break the transport */
        }
      }
      const any = this.listeners.get('*');
      if (any) for (const cb of any) {
        try {
          cb(obj);
        } catch {
          /* ignore */
        }
      }
    }
  }

  send(method, params = {}, { sessionId = null, timeout = this.timeout } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP socket is not open'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout after ${timeout}ms waiting for ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  off(event, cb) {
    this.listeners.get(event)?.delete(cb);
  }

  _onClose() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP socket closed before the response arrived'));
    }
    this.pending.clear();
    for (const cb of this.closeHandlers) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  onClose(cb) {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP client closed'));
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
