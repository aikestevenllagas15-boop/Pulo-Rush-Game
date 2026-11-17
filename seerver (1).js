/* Pulo Rush online server - no npm dependencies (plain Node.js 14+).
   Run:  node server.js        then open http://localhost:3000
   The GAME RUNS ON THIS SERVER: every room gets its own copy of the game rules
   (taken from the sim section of index.html, so there is only one version of the rules).
   Players just send their joystick/buttons and receive the state, so nobody's phone is the host. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MODES = ['classic', 'coconut', 'pearl', 'king', 'team'];
const TICK_MS = 1000 / 30;

const pickHtml = () => {
  const want = ['index.html', 'pulorush-online.html'];
  let list = []; try { list = fs.readdirSync(__dirname); } catch (e) {}
  const f = want.find(w => list.includes(w)) || list.find(n => /\.html?$/i.test(n)) || 'index.html';
  return path.join(__dirname, f);
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(pickHtml(), (e, d) => {
      if (e) { res.writeHead(500); res.end('No .html game file found next to server.js - upload index.html to the repo'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
  } else if (url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end('Not found'); }
});

/* ---------- the game, running headless inside a vm sandbox ---------- */
const PRELUDE = `
const $ = () => ({ style: {}, textContent: '', className: '', dataset: {}, append() {} });
const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;
const NET_SND = ['count', 'go', 'warn', 'sink', 'boom', 'tick'];
const meshes = {};
let yaw = 0, scoreKey = '', islandObjs = [];
function renderScore() {}
const mkObj = () => ({ dispose() {}, carry() {}, home() {}, drop() {}, g: { position: { set() {} } } });
const Gfx = {
  buildIslands: l => l.map(() => ({})), makeFlag: mkObj, makePowerup: mkObj, makeShot: mkObj, makePearl: mkObj, makeBeacon: mkObj, sparkle() {},
  burst(x, y, z, h) { evq.push(['b', r2(x), r2(y), r2(z), h]); },
  explode(x, y, z) { evq.push(['x', r2(x), r2(y), r2(z)]); },
  POWERS: { speed: { color: 0xffd400 }, jump: { color: 0x43e05a }, shield: { color: 0x3aa0ff }, mega: { color: 0xff4a2a }, coco: { color: 0xc98a3a } },
};
const Sfx = { play(n, v) { if (NET_SND.includes(n)) evq.push(['snd', n, v || 1]); } };
`;
const GLUE = `
function ev(a) { evq.push(a); }
function tw(pre, p, verb, post, t) { toast(pre + p.name + ' ' + verb + post, t, true); ev(['tw', pre, p.id, p.name, verb, post, t]); }
function resText() { return ''; }
function sendRound() {
  __out({ t: 'round', md: mode, isl: islands, pl: players.map(p => ({ id: p.id, name: p.name, color: p.color, team: p.team, bot: p.bot })) });
}
function netState() {
  const s = {
    t: 'st', st: state, tm: r2(timer), go: goT > 0 ? 1 : 0, rt: r1(roundT), ct: r1(crownT), tp: teamPts, tw: teamWins, res: res,
    p: players.map(p => [r2(p.x), r2(p.y), r2(p.z), p.alive ? 1 : 0, p.wins, p.pw || '', r1(p.pwT), p.pwMax, r1(p.pts || 0), r1(p.cocoT), r1(p.dodgeCd), p.grounded ? 1 : 0]),
    isl: islands.map(i => i.s),
    pu: powerups.map(u => [u.type, r2(u.x), r2(u.z)]),
    sh: shots.map(u => [r2(u.x), r2(u.y), r2(u.z)]),
    pe: pearls.map(o => [r2(o.x), r2(o.z), o.gold ? 1 : 0]),
    ci: crown ? islands.indexOf(crown) : -1,
    fl: flags.map(f => [f.carrier ? f.carrier.id : '', f.dropped ? 1 : 0, r2(f.dx), r2(f.dz)]),
    bh: bomb.h ? bomb.h.id : '', bf: r2(bomb.fuse), ev: evq,
  };
  evq = [];
  return s;
}
function hostIn(m) {
  const p = players.find(q => q.id === m.from && !q.bot);
  let x = +m.x, z = +m.z;
  if (!p || !isFinite(x) || !isFinite(z)) return;
  const l = Math.hypot(x, z); if (l > 1) { x /= l; z /= l; }
  p.in = { x: x, z: z };
}
function hostAct(m) {
  const p = players.find(q => q.id === m.from && !q.bot);
  if (!p || state === 'menu') return;
  if (m.a === 'j') p.jumpReq = true;
  else if (m.a === 's') shove(p);
  else if (m.a === 'd') dodge(p);
  else if (m.a === 'e' && EMOTES.includes(m.e)) emote(p, m.e);
}
globalThis.__api = {
  start(md, bots, members) { mode = md; botCount = bots; net = { host: true, members: members }; newPlayers(); startRound(); },
  tick() { step(); },
  send() { __out(netState()); },
  state() { return state; },
  hostIn: hostIn, hostAct: hostAct,
  left(id) { const p = players.find(q => q.id === id); if (p && !p.bot) { p.bot = true; p.in = { x: 0, z: 0 }; } },
};
`;
function simSource() {
  const html = fs.readFileSync(pickHtml(), 'utf8');
  const a = html.indexOf('/* ================= GAME SIM'), b = html.indexOf('/* ================= GRAPHICS');
  if (a < 0 || b < a) throw new Error('game html has no sim section');
  return html.slice(a, b);
}
function createSim(out) {
  const ctx = { console, performance: { now: () => Date.now() }, __out: out };
  vm.createContext(ctx);
  vm.runInContext(PRELUDE + '\n' + simSource() + '\n' + GLUE, ctx, { filename: 'sim.js' });
  return ctx.__api;
}

/* ---------- minimal WebSocket (RFC 6455) ---------- */
const rooms = new Map();
let nid = 0;
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
      try { handle(c, m); } catch (e) { console.error('handle error', e); }
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
function broadcast(r, o) { const s = JSON.stringify(o); r.members.forEach(x => frame(x, s, 1)); }

/* ---------- rooms ---------- */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() { let s = ''; for (let i = 0; i < 4; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)]; return s; }
function cleanName(n) { return String(n || '').replace(/[^\w \-.!]/g, '').trim().slice(0, 12) || 'Player'; }
function lobby(r) {
  broadcast(r, { t: 'lobby', code: r.code, hostId: r.host.id, members: r.members.map(x => ({ id: x.id, name: x.name })), md: r.md, bots: r.bots, playing: r.playing });
}
function startGame(r) {
  if (r.playing) return;
  r.sim = createSim(msg => broadcast(r, msg));
  r.sim.start(r.md, r.bots, r.members.map(x => ({ id: x.id, name: x.name })));
  r.playing = true; r.last = Date.now(); r.acc = 0;
  r.timer = setInterval(() => tickRoom(r), 16);
  lobby(r);
}
function stopGame(r) {
  if (r.timer) clearInterval(r.timer);
  r.timer = null; r.sim = null; r.playing = false;
}
function tickRoom(r) {
  if (!r.sim) return;
  try {
    const now = Date.now();
    r.acc += now - r.last; r.last = now;
    if (r.acc > 250) r.acc = 250;
    let stepped = false;
    while (r.acc >= TICK_MS) {
      r.acc -= TICK_MS; r.sim.tick(); stepped = true;
      if (r.sim.state() === 'menu') break;
    }
    if (stepped) r.sim.send();
    if (r.sim.state() === 'menu') { stopGame(r); lobby(r); }
  } catch (e) { console.error('room error', e); stopGame(r); lobby(r); }
}
function handle(c, m) {
  if (!m || typeof m.t !== 'string') return;
  const r = c.room;
  if (m.t === 'create' && !r) {
    c.name = cleanName(m.name);
    let code;
    do code = genCode(); while (rooms.has(code));
    const room = { code, host: c, members: [c], md: 'classic', bots: 3, playing: false, sim: null, timer: null };
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
  } else if (r && m.t === 'cfg' && c === r.host && !r.playing) {
    if (MODES.includes(m.md)) r.md = m.md;
    if (Number.isInteger(m.bots) && m.bots >= 0 && m.bots <= 9) r.bots = m.bots;
    lobby(r);
  } else if (r && m.t === 'start' && c === r.host) {
    startGame(r);
  } else if (r && r.sim && m.t === 'in') {
    r.sim.hostIn({ from: c.id, x: m.x, z: m.z });
  } else if (r && r.sim && m.t === 'act') {
    r.sim.hostAct({ from: c.id, a: m.a, e: m.e });
  }
}
function drop(c) {
  const r = c.room;
  if (!r) return;
  c.room = null;
  r.members = r.members.filter(x => x !== c);
  if (!r.members.length) { stopGame(r); rooms.delete(r.code); return; }
  if (r.host === c) r.host = r.members[0];
  if (r.sim) { try { r.sim.left(c.id); } catch (e) {} }
  lobby(r);
}

server.listen(PORT, () => console.log('Pulo Rush online server running on http://localhost:' + PORT));
