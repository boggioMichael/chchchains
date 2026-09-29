// The real server over real sockets: the page, the health check, a full round, and everything it must refuse.
import './quiet.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

process.env.TRUST_PROXY = '1';
process.env.MAX_PER_IP = '4';
process.env.MAX_CLIENTS = '12';
process.env.ALLOWED_ORIGINS = 'https://game.example,https://chains*.example.org';
process.env.MAX_ROOMS = '6';
process.env.BOT_FILL = '0'; // most tests want people only; the bot test turns them on
const { start, stop, _internals } = await import('../server.mjs');
const { decodeSnapshot, FLAG_FULL } = await import('../src/protocol.js');

const server = await start(0, '127.0.0.1');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const open = new Set();
test.after(async () => {
  for (const c of open) c.sock.destroy();
  await stop();
});

/** A bare-bones WebSocket client that can also misbehave on purpose. */
function connect({ path = '/ws', origin, ip } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const c = { sock, status: 0, texts: [], snaps: [], closeCode: null, ended: false };
    open.add(c);
    let buf = Buffer.alloc(0);
    const key = randomBytes(16).toString('base64');
    const head = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (origin) head.push(`Origin: ${origin}`);
    if (ip) head.push(`X-Forwarded-For: ${ip}`);
    sock.on('connect', () => sock.write(`${head.join('\r\n')}\r\n\r\n`));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!c.status) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const response = buf.subarray(0, end).toString();
        c.status = Number(response.split(' ')[1]);
        if (c.status === 101) {
          // RFC 6455 §4.2.2: the accept value proves the server understood the handshake.
          const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          c.acceptOk = response.includes(`Sec-WebSocket-Accept: ${expected}\r\n`) || response.endsWith(`Sec-WebSocket-Accept: ${expected}`);
        }
        buf = buf.subarray(end + 4);
        resolve(c);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let p = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          p = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          p = 10;
        }
        if (buf.length < p + len) return;
        const payload = buf.subarray(p, p + len);
        buf = buf.subarray(p + len);
        if (op === 1) c.texts.push(JSON.parse(payload.toString('utf8')));
        else if (op === 2) c.snaps.push(decodeSnapshot(payload.buffer.slice(payload.byteOffset, payload.byteOffset + len)));
        else if (op === 8) c.closeCode = len >= 2 ? payload.readUInt16BE(0) : 1005;
        else if (op === 9) c.frame(0xa, payload);
      }
    });
    sock.on('close', () => {
      c.ended = true;
      open.delete(c);
      if (!c.status) resolve(c);
    });
    sock.on('error', () => {});
    c.frame = (op, payload, { mask = true, fin = true, len } = {}) => {
      const n = len ?? payload.length;
      const parts = [];
      if (n < 126) parts.push(Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | n]));
      else {
        const h = Buffer.alloc(4);
        h[0] = (fin ? 0x80 : 0) | op;
        h[1] = (mask ? 0x80 : 0) | 126;
        h.writeUInt16BE(n, 2);
        parts.push(h);
      }
      if (mask) {
        const key = randomBytes(4);
        parts.push(key, Buffer.from(payload.map((b, i) => b ^ key[i & 3])));
      } else parts.push(payload);
      if (!sock.destroyed) sock.write(Buffer.concat(parts));
    };
    c.send = (obj) => c.frame(1, Buffer.from(JSON.stringify(obj)));
    c.wait = (pred, ms = 4000) => waitFor(() => pred(c), ms);
    c.text = (t, ms) => c.wait(() => c.texts.find((m) => m.t === t), ms);
  });
}

async function waitFor(pred, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${pred}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const settle = () => waitFor(() => _internals.clients.size === 0, 4000);

test('serves the page with a CSP that matches its inline code, and a health check', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const csp = res.headers.get('content-security-policy');
  const html = await res.text();
  assert.match(html, /"sameOrigin":true/);
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const hash = createHash('sha256').update(m[1], 'utf8').digest('base64');
    assert.ok(csp.includes(`'sha256-${hash}'`), 'every inline script is allowed by hash');
  }
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/ws/);
  const map = await fetch(`${base}/maps/index.json`);
  assert.equal(map.status, 200);
  assert.ok((await map.json()).cities.length >= 3, 'the city maps are served too');
  assert.equal((await fetch(`${base}/maps/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  const headRes = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
});

test('a whole round over a real socket: an empty map, join, steer, break, leave', async () => {
  const c = await connect({ ip: '10.0.0.1' });
  assert.equal(c.status, 101);
  assert.ok(c.acceptOk, 'correct Sec-WebSocket-Accept');
  const hello = await c.text('hello');
  assert.equal(hello.v, 3);
  const map = hello.home;
  assert.ok(_internals.MAPS.has(map), 'a newcomer is pointed at a real map');
  c.send({ t: 'watch', map, vw: 500, vh: 900 });
  assert.equal((await c.text('noroom')).map, map, 'nobody plays there yet: nothing to watch');
  c.send({ t: 'join', map, name: 'מגדלור שובב', skin: 'a3', vw: 500, vh: 900 });
  const room = await c.text('room');
  assert.ok(room.R > 500 && room.map === map && room.cap >= 2);
  const joined = await c.text('joined');
  assert.equal(joined.name, 'מגדלור שובב');
  assert.equal(joined.skin, 'a3');
  const first = await c.wait(() => c.snaps.find((s) => s.me === joined.id));
  const mine = first.snakes.find((d) => d.id === joined.id);
  assert.ok(mine && mine.flags & FLAG_FULL && mine.count === mine.len, 'my whole body arrives first');
  const later = await c.wait(() => c.snaps.filter((s) => s.me === joined.id)[3]);
  assert.ok(later.snakes.find((d) => d.id === joined.id).count < 10, 'then only what is new');
  assert.ok(c.texts.some((m) => m.t === 'names' && m.list.some(([id, name, , skin]) => id === joined.id && name === 'מגדלור שובב' && skin === 'a3')));
  const board = await c.text('lb', 2500);
  assert.equal(board.rank, 1);
  assert.equal(board.total, 1, 'no bots: alone on the map');
  assert.equal(board.here, 1);
  const radar = await c.wait(() => c.texts.find((m) => m.t === 'lb' && m.radar), 3500);
  assert.deepEqual(radar.radar.map((r) => r[0]), [joined.id], 'the minimap shows everyone');
  c.send({ t: 'lobby' });
  assert.equal((await c.text('lobby')).maps[map], 1);
  assert.equal((await (await fetch(`${base}/lobby`)).json()).maps[map], 1);
  const srvRoom = [..._internals.rooms].find((r) => r.world.snakes.has(joined.id));
  const snake = srvRoom.world.snakes.get(joined.id);
  c.send({ t: 'in', a: 1.25, b: 0 });
  await waitFor(() => Math.abs(snake.ta - 1.25) < 1e-9);
  c.send({ t: 'in', a: 'x', b: 'y', vw: 1e9 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(Number.isFinite(snake.ta), 'junk input is ignored');
  // Out of the map: the chain breaks and the player hears so.
  snake.x = srvRoom.world.R + 50;
  const dead = await c.text('dead');
  assert.equal(dead.edge, true);
  // Someone else can now watch that map.
  const w = await connect({ ip: '10.0.0.2' });
  await w.text('hello');
  w.send({ t: 'watch', map });
  assert.equal((await w.text('room')).map, map);
  c.send({ t: 'idle' });
  await new Promise((r) => setTimeout(r, 150));
  const n = c.snaps.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.snaps.length, n, 'idle: nothing more is sent');
  c.sock.destroy();
  w.sock.destroy();
  await settle();
});

test('while few people play, bots named for the rival parties fill the room, marked as bots, and one goes hunting', async () => {
  _internals.config.botFill = 5;
  let c = null;
  try {
    c = await connect({ ip: '10.0.3.1' });
    const map = (await c.text('hello')).home;
    c.send({ t: 'join', map, name: 'שחקנית אמיתית', vw: 500, vh: 900 });
    const joined = await c.text('joined');
    const room = [..._internals.rooms].find((r) => r.world.snakes.has(joined.id));
    const bots = () => [...room.world.snakes.values()].filter((s) => s.bot && s.alive);
    await waitFor(() => bots().length >= 4, 15000);
    const names = bots().map((b) => b.name);
    assert.ok(names.includes('ישר') && names.includes('הליכוד'), names.join(', '));
    assert.equal(new Set(names).size, names.length, 'each party once');
    const board = await c.wait(() => c.texts.find((m) => m.t === 'lb' && m.total >= 4), 4000);
    assert.ok(board.top.some((row) => row[4] === 1), 'the board marks bots');
    // A rival next to someone who has played a while goes after them, and they are told.
    const me = room.world.snakes.get(joined.id);
    me.born = room.world.time - 100;
    const hunter = bots().find((b) => b.ai?.role);
    let spot = { x: 0, y: 0 };
    for (let k = 0; k < 200 && !room.world.roomy(spot.x, spot.y, 500); k++) spot = room.world.somewhere(0.3);
    place(me, spot.x, spot.y, 0);
    place(hunter, spot.x - 300, spot.y + 250, 0);
    const warn = await c.wait(() => c.texts.find((m) => m.t === 'ev' && m.k === 'hunt'), 8000);
    assert.ok(bots().some((b) => b.id === warn.id && b.ai.hunting && b.ai.target === joined.id));
    // With more people here than bots are wanted for, they leave (one at a time, the smallest first).
    const before = bots().length;
    _internals.config.botFill = 1;
    await waitFor(() => bots().length < before, 12000);
  } finally {
    // Whatever happened, nothing of this test is left behind for the next ones: no socket, no room full of bots.
    _internals.config.botFill = 0;
    c?.sock.destroy();
    await settle();
    for (const r of [..._internals.rooms]) r.close();
  }
});

test('two people hold hands over the network', async () => {
  const a = await connect({ ip: '10.0.1.1' });
  const b = await connect({ ip: '10.0.1.2' });
  const map = (await a.text('hello')).home;
  a.send({ t: 'join', map, name: 'כוכב אמיץ' });
  b.send({ t: 'join', map, name: 'גל מהנגב' });
  const ja = await a.text('joined');
  const jb = await b.text('joined');
  const room = [..._internals.rooms].find((r) => r.world.snakes.has(ja.id));
  assert.ok(room.world.snakes.has(jb.id), 'same room');
  const sa = room.world.snakes.get(ja.id);
  const sb = room.world.snakes.get(jb.id);
  // Side by side somewhere well inside the map, both heading the same way.
  let spot = { x: 0, y: 0 };
  for (let k = 0; k < 200 && !room.world.roomy(spot.x, spot.y, 400); k++) spot = room.world.somewhere(0.3);
  place(sa, spot.x, spot.y, 0);
  place(sb, spot.x, spot.y + 60, 0);
  a.send({ t: 'hand' });
  const offer = await b.wait(() => b.texts.find((m) => m.t === 'ev' && m.k === 'offer'));
  assert.equal(offer.id, ja.id);
  const flagged = await b.wait(() => b.snaps.find((s) => s.snakes.some((d) => d.id === ja.id && d.flags & 4)));
  assert.ok(flagged, 'B sees A offering a hand');
  b.send({ t: 'hand' });
  await a.wait(() => a.texts.find((m) => m.t === 'ev' && m.k === 'link' && m.id === jb.id));
  await b.wait(() => b.texts.find((m) => m.t === 'ev' && m.k === 'link' && m.id === ja.id));
  assert.ok(sa.team && sa.team === sb.team);
  const board = await a.wait(() => a.texts.find((m) => m.t === 'lb' && m.hands === 1));
  assert.equal(board.hands, 1);
  a.sock.destroy();
  b.sock.destroy();
  await settle();
});

test('a map holds as many people as it says, then opens another room; too many rooms is "busy"', async () => {
  const ids = [..._internals.MAPS.keys()];
  const map = _internals.MAPS.get(ids[0]);
  const cap = map.capacity;
  map.capacity = 2;
  for (const r of [..._internals.rooms]) r.close(); // rooms stay open a minute after the last person leaves
  try {
    const people = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect({ ip: `10.0.5.${i}` });
      await c.text('hello');
      c.send({ t: 'join', map: map.id, name: `שחקן ${i}`, skin: 'no-such-skin' });
      const j = await c.text('joined');
      assert.equal(j.skin, '', 'unknown skins are dropped');
      people.push(c);
    }
    const onMap = [..._internals.rooms].filter((r) => r.map?.id === map.id);
    assert.deepEqual(onMap.map((r) => r.playing()).sort(), [1, 2], 'two in the first room, the third in a second one');
    assert.equal(_internals.lobby()[map.id], 3);
    for (const c of people) c.sock.destroy();
    await settle();
    for (const r of [..._internals.rooms]) r.close();
    // Six rooms at most (MAX_ROOMS in this test): the seventh map to open is refused politely.
    const more = [];
    for (let i = 0; i < 7 && i < ids.length; i++) {
      const c = await connect({ ip: `10.0.6.${i}` });
      await c.text('hello');
      c.send({ t: 'join', map: ids[i] });
      more.push(c);
    }
    if (ids.length >= 7) await more[6].text('busy');
    for (const c of more) c.sock.destroy();
    await settle();
  } finally {
    map.capacity = cap;
    for (const r of [..._internals.rooms]) r.close();
  }
});

test('refuses other paths, other websites, crowds from one address, and a full house', async () => {
  assert.equal((await connect({ path: '/other' })).status, 400);
  assert.equal((await connect({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await connect({ origin: 'https://game.example' })).status, 101);
  assert.equal((await connect({ origin: 'https://chains-x7k2.example.org' })).status, 101, 'wildcard origins');
  assert.equal((await connect({ origin: 'https://chains.evil.org' })).status, 403);
  assert.equal((await connect({ origin: 'https://chains.x.example.org' })).status, 403, 'a wildcard never spans dots');
  assert.equal((await connect({ origin: `http://127.0.0.1:${port}` })).status, 101);
  assert.equal((await connect({})).status, 101, 'apps without an Origin');
  for (const c of [...open]) c.sock.destroy();
  await settle();
  const same = [];
  for (let i = 0; i < 4; i++) same.push(await connect({ ip: '10.0.2.1' }));
  assert.ok(same.every((c) => c.status === 101));
  assert.equal((await connect({ ip: '10.0.2.1' })).status, 429);
  for (const c of same) c.sock.destroy();
  await settle();
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push(await connect({ ip: `10.0.3.${i}` }));
  await waitFor(() => _internals.clients.size === 12);
  const extra = await connect({ ip: '10.0.3.200' });
  assert.equal(extra.status, 101);
  await extra.wait(() => extra.texts.find((m) => m.t === 'full') && extra.closeCode === 1013);
  for (const c of crowd) c.sock.destroy();
  await settle();
});

test('drops connections that break the protocol or flood', async () => {
  const unmasked = await connect({ ip: '10.0.4.1' });
  unmasked.frame(1, Buffer.from('{"t":"hb"}'), { mask: false });
  await unmasked.wait(() => unmasked.closeCode === 1002 || unmasked.ended);
  const big = await connect({ ip: '10.0.4.2' });
  big.frame(1, Buffer.alloc(5000, 32));
  await big.wait(() => big.closeCode === 1009 || big.ended);
  const fragmented = await connect({ ip: '10.0.4.3' });
  fragmented.frame(1, Buffer.from('{"t":'), { fin: false });
  await fragmented.wait(() => fragmented.closeCode === 1003 || fragmented.ended);
  const flood = await connect({ ip: '10.0.4.4' });
  for (let i = 0; i < 400; i++) flood.send({ t: 'hb' });
  await flood.wait(() => flood.closeCode === 1008 || flood.ended);
  const junk = await connect({ ip: '10.0.4.5' });
  junk.frame(1, Buffer.from('not json'));
  junk.frame(1, Buffer.from('[1,2,3]'));
  junk.frame(1, Buffer.from('null'));
  junk.send({ t: 'join', name: '<img src=x onerror=alert(1)>' });
  const joined = await junk.text('joined');
  assert.ok(_internals.VALID_NAMES.has(joined.name), 'names that are not clean are replaced by generated ones');
  for (const c of [...open]) c.sock.destroy();
  await settle();
});

function place(s, x, y, a) {
  s.x = x;
  s.y = y;
  s.a = s.ta = a;
  for (let i = 0; i < s.px.length; i++) {
    s.px[i] = x - Math.cos(a) * i * 7;
    s.py[i] = y - Math.sin(a) * i * 7;
  }
}
