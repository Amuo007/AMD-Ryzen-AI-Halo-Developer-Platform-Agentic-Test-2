/* Fake Chrome DevTools Protocol endpoint: a minimal WebSocket server on
   node:http upgrade (no deps). Requests are answered by `handle(msg)`;
   returning undefined sends no response (for timeout tests). */
import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export async function startFakeCDP({ handle } = {}) {
  const conns = new Set();
  const requests = [];
  const server = http.createServer((req, res) => {
    res.writeHead(426).end();
  });
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const conn = {
      socket,
      closed: false,
      send: (obj) => {
        if (conn.closed) return;
        socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj)));
      },
      close: () => {
        if (conn.closed) return;
        conn.closed = true;
        try {
          socket.write(encodeFrame('', 8));
        } catch {
          /* ignore */
        }
        socket.end();
      },
    };
    conns.add(conn);
    socket.on('close', () => {
      conn.closed = true;
      conns.delete(conn);
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (opcode === 8) {
          conn.close();
          return;
        }
        if (opcode === 9) {
          conn.socket.write(encodeFrame(payload.toString('utf8'), 10));
          continue;
        }
        if (opcode !== 1) continue;
        const text = payload.toString('utf8');
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        requests.push(msg);
        const reply = handle ? handle(msg, conn) : { id: msg.id, result: {} };
        if (reply !== undefined && reply !== null) conn.send(reply);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/devtools/fake`,
    requests,
    broadcast: (event) => {
      for (const c of [...conns]) c.send(event);
    },
    disconnectAll: () => {
      for (const c of [...conns]) c.close();
    },
    close: () =>
      new Promise((resolve) => {
        for (const c of [...conns]) c.close();
        server.close(resolve);
      }),
  };
}
