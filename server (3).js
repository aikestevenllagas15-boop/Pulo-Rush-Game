/* Pulo Rush online server - no dependencies (plain Node.js 14+).
   Run:  node server.js        then open http://localhost:3000
   It serves the game page and relays messages between the players of a room.
   The room creator (host) runs the game; everyone else sends inputs and receives the state. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const HTML = ['index.html', 'pulorush-online.html'].map(f => path.join(__dirname, f)).find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');
const MAX_PLAYERS = 8;
const MODES = ['classic', 'coconut', 'pearl', 'king', 'team'];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(HTML, (e, d) => {
      if (e) { res.writeHead(500); res.end('pulorush-online.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

const rooms = new Map();
let nid = 0;

/* ---------- minimal WebSocket (RFC 6455) ---------- */
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: 'p' + (++nid), sock, room: null, name: 'Player', buf: Buffer.alloc(0) };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 1 << 20) { sock.destroy(); return; }
    parse(c);
  });
  sock.on('close', () => drop(c));
  sock.on('error', () => sock.destroy());
});

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 15, masked = !!(b[1] & 128);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 262144) { c.sock.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let payload = b.slice(off + (masked ? 4 : 0), need);
    if (masked) {
      const mk = b.slice(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
    }
    c.buf = b.slice(need);
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { frame(c, payload, 10); continue; }
    if (op === 1) {
      let m;
      try { m = JSON.parse(payload.toString()); } catch (e) { continue; }
      handle(c, m);
    }
  }
}
function frame(c, data, op) {
  if (c.sock.destroyed || !c.sock.writable) return;
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([128 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  c.sock.write(Buffer.concat([h, p]));
}
const send = (c, o) => frame(c, JSON.stringify(o), 1);

/* ---------- rooms ---------- */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() { let s = ''; for (let i = 0; i < 4; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)]; return s; }
function cleanName(n) { return String(n || '').replace(/[^\w \-.!]/g, '').trim().slice(0, 12) || 'Player'; }
function lobby(r) {
  const m = { t: 'lobby', code: r.code, hostId: r.host.id, members: r.members.map(x => ({ id: x.id, name: x.name })), md: r.md, bots: r.bots, playing: r.playing };
  r.members.forEach(x => send(x, m));
}
function handle(c, m) {
  if (!m || typeof m.t !== 'string') return;
  const r = c.room;
  if (m.t === 'create' && !r) {
    c.name = cleanName(m.name);
    let code;
    do code = genCode(); while (rooms.has(code));
    const room = { code, host: c, members: [c], md: 'classic', bots: 3, playing: false };
    rooms.set(code, room); c.room = room;
    send(c, { t: 'room', code, id: c.id, host: true });
    lobby(room);
  } else if (m.t === 'join' && !r) {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return send(c, { t: 'err', msg: 'Room not found. Check the code.' });
    if (room.playing) return send(c, { t: 'err', msg: 'That match already started. Try again after it ends.' });
    if (room.members.length >= MAX_PLAYERS) return send(c, { t: 'err', msg: 'Room is full.' });
    let nm = cleanName(m.name), k = 1;
    const base = nm;
    while (room.members.some(x => x.name === nm)) nm = base.slice(0, 10) + ' ' + (++k);
    c.name = nm; room.members.push(c); c.room = room;
    send(c, { t: 'room', code: room.code, id: c.id, host: false });
    lobby(room);
  } else if (r && c === r.host) {
    if (m.t === 'cfg') {
      if (MODES.includes(m.md)) r.md = m.md;
      if (Number.isInteger(m.bots) && m.bots >= 0 && m.bots <= 9) r.bots = m.bots;
      r.playing = !!m.playing;
      lobby(r);
    } else if (m.t === 'round' || m.t === 'st') {
      r.members.forEach(x => { if (x !== c) send(x, m); });
    }
  } else if (r && (m.t === 'in' || m.t === 'act')) {
    m.from = c.id;
    send(r.host, m);
  }
}
function drop(c) {
  const r = c.room;
  if (!r) return;
  c.room = null;
  if (c === r.host) {
    r.members.forEach(x => { if (x !== c) { x.room = null; send(x, { t: 'closed' }); } });
    rooms.delete(r.code);
  } else {
    r.members = r.members.filter(x => x !== c);
    send(r.host, { t: 'left', id: c.id });
    lobby(r);
  }
}

server.listen(PORT, () => console.log('Pulo Rush online server running on http://localhost:' + PORT));
