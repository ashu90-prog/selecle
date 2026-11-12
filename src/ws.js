import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';

// A small WebSocket (RFC 6455) so a friend can join through any HTTPS address that
// forwards to the host: GitHub Codespaces' forwarded ports, ngrok, Cloudflare tunnels,
// VS Code dev tunnels. The Telnet bytes travel inside binary frames, so everything above
// this file (names, room codes, the whole app) is unchanged. No dependencies.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

const OP = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
// A shared file can be up to 1 MB, which is about 1.4 MB once encoded; leave room.
const MAX_PAYLOAD = 8 << 20;

// One frame. Browsers and clients must mask what they send; servers must not.
export function encodeFrame(payload, { mask = false, opcode = OP.binary } = {}) {
  const len = payload.length;
  const flag = mask ? 0x80 : 0;
  let size;
  if (len < 126) size = Buffer.from([flag | len]);
  else if (len < 65536) { size = Buffer.alloc(3); size[0] = flag | 126; size.writeUInt16BE(len, 1); }
  else { size = Buffer.alloc(9); size[0] = flag | 127; size.writeBigUInt64BE(BigInt(len), 1); }
  const head = Buffer.from([0x80 | opcode]);
  if (!mask) return Buffer.concat([head, size, payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([head, size, key, body]);
}

// Feed it bytes as they arrive; it calls onFrame(opcode, payload) for each whole message
// (control frames included). Throws on a frame that is too large.
export function createFrameParser({ onFrame, maxPayload = MAX_PAYLOAD }) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let first = 0;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) throw new Error('WebSocket frame too large');
        len = Number(big);
        at = 10;
      }
      if (len > maxPayload) throw new Error('WebSocket frame too large');
      const total = at + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      let payload = Buffer.from(buf.subarray(at + (masked ? 4 : 0), total));
      if (masked) {
        const key = buf.subarray(at, at + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      buf = buf.subarray(total);
      if (opcode >= 8) { onFrame(opcode, payload); continue; }
      if (opcode !== 0) { parts = [payload]; first = opcode; } else parts.push(payload);
      if (fin) {
        onFrame(first, Buffer.concat(parts));
        parts = [];
        first = 0;
      }
    }
  };
}

// Make a socket that has finished its WebSocket handshake look like a plain byte stream:
// what you write goes out as frames, what arrives is unwrapped. `client` masks outgoing frames.
export function wsStream(socket, { client = false, head = Buffer.alloc(0) } = {}) {
  let closing = false;
  const sendControl = (opcode, payload = Buffer.alloc(0)) => {
    if (!socket.destroyed) socket.write(encodeFrame(payload, { mask: client, opcode }));
  };
  const stream = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      if (socket.destroyed) return cb();
      socket.write(encodeFrame(Buffer.from(chunk), { mask: client }), cb);
    },
    final(cb) {
      if (!closing) { closing = true; sendControl(OP.close); }
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  });
  stream.setNoDelay = () => {};
  const parse = createFrameParser({
    onFrame(opcode, payload) {
      if (opcode === OP.binary || opcode === OP.text) stream.push(payload);
      else if (opcode === OP.ping) sendControl(OP.pong, payload);
      else if (opcode === OP.close) {
        if (!closing) { closing = true; sendControl(OP.close); }
        socket.end();
      }
    },
  });
  const feed = (chunk) => {
    try { parse(chunk); } catch { socket.destroy(); }
  };
  socket.on('data', feed);
  socket.on('close', () => stream.destroy());
  socket.on('error', () => stream.destroy());
  if (head.length) feed(head);
  return stream;
}

// ---- server side ---------------------------------------------------------

// Read an HTTP request head from `socket`. Calls back with { method, path, headers, rest }
// or null if it is not one (or never finishes).
export function readRequestHead(socket, first, done, { limit = 16 * 1024, waitMs = 3000 } = {}) {
  let seen = first;
  const timer = setTimeout(() => finish(null), waitMs);
  const finish = (value) => {
    clearTimeout(timer);
    socket.off('data', more);
    done(value);
  };
  const check = () => {
    const end = seen.indexOf('\r\n\r\n');
    if (end < 0) return seen.length > limit ? finish(null) : undefined;
    const lines = seen.subarray(0, end).toString('latin1').split('\r\n');
    const [method, path] = lines[0].split(' ');
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    finish({ method, path, headers, rest: seen.subarray(end + 4) });
  };
  const more = (chunk) => { seen = Buffer.concat([seen, chunk]); check(); };
  socket.on('data', more);
  check();
}

export const isWebSocketRequest = (req) => /upgrade/i.test(req.headers.connection ?? '') && /websocket/i.test(req.headers.upgrade ?? '') && Boolean(req.headers['sec-websocket-key']);

// Complete the handshake and return a byte stream for the rest of the connection.
export function acceptWebSocket(socket, req) {
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
    '', '',
  ].join('\r\n'));
  return wsStream(socket, { head: req.rest });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// What a browser sees if someone opens the address: how to join, never the room code.
export function landingPage(host) {
  const body = `<!doctype html><meta charset="utf-8"><title>selecle</title>
<body style="font-family:monospace;background:#100d0a;color:#eae2d0;padding:2em;max-width:42em">
<h1 style="color:#f07a1a">☠ a selecle crypt is open here</h1>
<p>This address is a door, not a web page. To come in, install selecle and run:</p>
<pre style="color:#76e23c">npm install -g selecle-cli
selecle join https://${escapeHtml(host || 'this-address')}/ROOMCODE</pre>
<p>The host gives you the room code.</p>`;
  return `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

// ---- client side ---------------------------------------------------------

// Connect to ws:// or wss:// (https:// and http:// are accepted too). Returns a stream that
// emits 'connect' once the handshake is done, like a net socket.
export function connectWs(address) {
  const url = new URL(String(address).replace(/^http/i, 'ws'));
  const secure = url.protocol === 'wss:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const raw = secure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
    : net.connect(port, url.hostname);
  const key = crypto.randomBytes(16).toString('base64');
  const outbox = [];
  let stream = null;
  let failed = false;
  const proxy = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      if (stream) stream.write(chunk, enc, cb);
      else outbox.push([chunk, enc, cb]);
    },
    final(cb) { if (stream) stream.end(); else raw.end(); cb(); },
    destroy(err, cb) { raw.destroy(); stream?.destroy(); cb(err); },
  });
  proxy.setNoDelay = () => {};
  const fail = (e) => {
    if (failed) return;
    failed = true;
    proxy.destroy(e);
  };
  raw.on('error', fail);
  raw.on(secure ? 'secureConnect' : 'connect', () => {
    raw.write([
      `GET ${url.pathname || '/'}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'User-Agent: selecle',
      '', '',
    ].join('\r\n'));
  });
  let seen = Buffer.alloc(0);
  const onReply = (chunk) => {
    seen = Buffer.concat([seen, chunk]);
    const end = seen.indexOf('\r\n\r\n');
    if (end < 0) {
      if (seen.length > 16 * 1024) fail(Object.assign(new Error('The address did not answer like a selecle door.'), { code: 'EHANDSHAKE' }));
      return;
    }
    raw.off('data', onReply);
    const head = seen.subarray(0, end).toString('latin1');
    const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
    const accept = head.match(/sec-websocket-accept:\s*(\S+)/i)?.[1];
    if (status !== 101 || accept !== acceptKey(key)) {
      const why = status === 401 || status === 403 || status === 302
        ? 'The address refused the connection. If this is a GitHub Codespace, set the port to Public (Ports tab, right-click the port, Port Visibility).'
        : status === 404 || status === 502 || status === 503
          ? 'Nothing is answering there. Is the host\'s door open (/invite) and the Codespace awake?'
          : 'That address did not answer like a selecle door.';
      return fail(Object.assign(new Error(`${why} (HTTP ${status || 'unknown'})`), { code: 'EHANDSHAKE' }));
    }
    stream = wsStream(raw, { client: true, head: seen.subarray(end + 4) });
    stream.on('data', (d) => proxy.push(d));
    stream.on('close', () => proxy.destroy());
    for (const [chunk, enc, cb] of outbox.splice(0)) stream.write(chunk, enc, cb);
    proxy.emit('connect');
  };
  raw.on('data', onReply);
  return proxy;
}
