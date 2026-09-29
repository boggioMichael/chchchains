// The server sends each chain's body once, then only the path points it laid since the last snapshot. These tests
// run a real server room by hand and check that the client's copy stays identical to the server's chains.
import './quiet.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSnapshot, FLAG_FULL } from '../src/protocol.js';
import { RemoteWorld } from '../src/net.js';
import { angleDiff, botName } from '../src/sim.js';

process.env.MAPS = 'off'; // rooms here are plain circles, driven tick by tick
const { _internals } = await import('../server.mjs');
const { Room, Client, rooms } = _internals;

function manualRoom(t) {
  for (const r of [...rooms]) r.close();
  const room = new Room();
  t.after(() => room.close());
  clearTimeout(room.timer);
  room.loop = () => {}; // ticks are driven by the test
  return room;
}

function fakeClient(onText, onBinary) {
  const ws = {
    socket: { writableLength: 0 },
    sendText: (t) => onText(JSON.parse(t)),
    sendBinary: (b) => onBinary(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
    close() {},
    frame() {},
  };
  return new Client(ws, '127.0.0.1');
}

test('the client rebuilds every chain it sees exactly, from full bodies and small updates', (t) => {
  const room = manualRoom(t);
  let remote = null;
  const sparks = new Set(); // what the client knows, applied straight from each snapshot
  const stats = { snaps: 0, bytes: 0, full: 0, delta: 0, checkedPoints: 0, maxHeadGap: 0, deaths: 0, sparksChecked: 0 };
  const client = fakeClient(
    (m) => {
      if (m.t === 'room') remote = new RemoteWorld(m.R);
      else if (m.t === 'names') remote.setNames(m.list);
      else if (m.t === 'dead') stats.deaths++;
    },
    (buf) => {
      stats.snaps++;
      stats.bytes += buf.byteLength;
      const snap = decodeSnapshot(buf);
      assert.ok(snap, 'snapshot decodes');
      remote.receive(snap);
      for (const id of snap.goneSparks) sparks.delete(id);
      for (const sp of snap.newSparks) {
        assert.ok(!sparks.has(sp.id), 'a spark is announced once');
        sparks.add(sp.id);
      }
      // Nothing stale, and everything on screen is there.
      for (const id of sparks) assert.ok(room.world.sparks.has(id), `spark ${id} is gone on the server`);
      for (const sp of room.world.sparks.values()) {
        if (Math.abs(sp.x - client.lastX) < client.vw && Math.abs(sp.y - client.lastY) < client.vh) {
          assert.ok(sparks.has(sp.id), `visible spark ${sp.id} missing`);
          stats.sparksChecked++;
        }
      }
      for (const d of snap.snakes) {
        if (d.flags & FLAG_FULL) stats.full++;
        else stats.delta++;
        const truth = room.world.snakes.get(d.id);
        const copy = remote.snakes.get(d.id);
        assert.equal(copy.seq, truth.seq, 'same newest path point');
        assert.equal(d.len, truth.px.length);
        assert.ok(copy.bx.length >= d.len, 'the copy holds the whole body');
        for (let k = 0; k < d.len; k++) {
          if (copy.bx[k] !== Math.round(truth.px[k]) || copy.by[k] !== Math.round(truth.py[k])) {
            assert.fail(`chain ${d.id} point ${k}: copy ${copy.bx[k]},${copy.by[k]} vs ${truth.px[k]},${truth.py[k]}`);
          }
        }
        stats.checkedPoints += d.len;
        assert.equal(copy.name, truth.name, 'names arrive before the chain');
      }
    },
  );
  // Other chains to come and go from the view (the game has no bots; the simulation's are handy here).
  for (let i = 0; i < 18; i++) room.world.addSnake({ bot: true, name: botName(), mass: 12 + Math.random() * 60 });
  client.onMessage(JSON.stringify({ t: 'join', name: 'ניצוץ זריז', vw: 320, vh: 320 }));
  assert.ok(remote, 'the room was announced');
  let angle = 0;
  for (let tick = 0; tick < 1800; tick++) {
    if (!client.snakeId && tick % 30 === 0) client.onMessage(JSON.stringify({ t: 'join', name: 'ניצוץ זריז', vw: 320, vh: 320 }));
    if (tick % 20 === 0) {
      const me = room.world.snakes.get(client.snakeId);
      // Wander, turning back toward the middle near the edge; boost now and then.
      angle = me && Math.hypot(me.x, me.y) > 2400 ? Math.atan2(-me.y, -me.x) : angle + (Math.random() - 0.5) * 2;
      client.tokens = 80;
      client.onMessage(JSON.stringify({ t: 'in', a: angle, b: tick % 200 < 40 ? 1 : 0 }));
    }
    room.tick();
    remote.update(1000 / 30);
    remote.events.length = 0;
    // The drawn head sits on its own body: the first visible path point is right behind it.
    for (const s of remote.snakes.values()) {
      const h = s.hist;
      if (!s.px.length || h.length < 2 || remote.rt > h[h.length - 1].t) continue; // extrapolating: allowed to drift
      stats.maxHeadGap = Math.max(stats.maxHeadGap, Math.hypot(s.x - s.px[0], s.y - s.py[0]));
    }
  }
  room.close();
  const perSecond = stats.bytes / (1800 / 30);
  console.log(
    `  ${stats.snaps} snapshots, ${(stats.bytes / stats.snaps).toFixed(0)} B average, ${(perSecond / 1024).toFixed(1)} KB/s ` +
      `(${stats.full} full bodies, ${stats.delta} updates, ${stats.checkedPoints} points and ${stats.sparksChecked} sparks checked, ${stats.deaths} deaths, ` +
      `head gap ≤ ${stats.maxHeadGap.toFixed(1)})`,
  );
  assert.ok(stats.snaps >= 890, `snapshots sent: ${stats.snaps}`);
  // How many chains come into view depends on the random walk (4 to a dozen); either way, updates are mostly small.
  assert.ok(stats.full >= 3 && stats.delta > stats.full * 5, `mostly small updates: ${stats.full} full, ${stats.delta} delta`);
  assert.ok(stats.checkedPoints > 30_000, `points compared: ${stats.checkedPoints}`);
  assert.ok(stats.maxHeadGap < 24, `head to body gap ${stats.maxHeadGap.toFixed(1)}`);
  assert.ok(perSecond < 12 * 1024, `bandwidth per player ${(perSecond / 1024).toFixed(1)} KB/s`);
});

test('offers, links and breaks reach the right people, and play on the drawn clock', (t) => {
  const room = manualRoom(t);
  const inbox = { a: [], b: [] };
  let worldA = null;
  const a = fakeClient(
    (m) => {
      inbox.a.push(m);
      if (m.t === 'room') worldA = new RemoteWorld(m.R);
      else if (m.t === 'names') worldA.setNames(m.list);
    },
    (buf) => worldA.receive(decodeSnapshot(buf)),
  );
  const b = fakeClient((m) => inbox.b.push(m), () => {});
  a.onMessage(JSON.stringify({ t: 'join', name: 'כוכב אמיץ' }));
  b.onMessage(JSON.stringify({ t: 'join', name: 'גל מהנגב' }));
  const w = room.world;
  const sa = w.snakes.get(a.snakeId);
  const sb = w.snakes.get(b.snakeId);
  // Park both, side by side and facing the same way, in an empty corner of the arena.
  for (const s of w.snakes.values()) if (s.bot) w.removeSnake(s.id);
  place(sa, 0, 0, 0);
  place(sb, 0, 90, 0);
  room.tick();
  a.onMessage(JSON.stringify({ t: 'hand' }));
  room.tick();
  const offered = inbox.a.find((m) => m.t === 'ev' && m.k === 'offered');
  const offer = inbox.b.find((m) => m.t === 'ev' && m.k === 'offer');
  assert.ok(offered && offered.id === sb.id && offered.name === 'גל מהנגב', 'A hears its offer went out');
  assert.ok(offer && offer.id === sa.id && offer.name === 'כוכב אמיץ', 'B is offered a hand');
  b.onMessage(JSON.stringify({ t: 'hand' }));
  room.tick();
  assert.ok(inbox.a.some((m) => m.t === 'ev' && m.k === 'link' && m.id === sb.id), 'A linked');
  assert.ok(inbox.b.some((m) => m.t === 'ev' && m.k === 'link' && m.id === sa.id), 'B linked');
  assert.ok(sa.team && sa.team === sb.team, 'one team');
  // Events wait for the drawn moment before the client acts on them.
  for (let i = 0; i < 12; i++) {
    room.tick();
    worldA.update(1000 / 30);
    if (worldA.events.length) break;
  }
  const t0 = worldA.events.map((e) => e.t);
  assert.ok(!t0.includes('link') || worldA.rt >= inbox.a.find((m) => m.k === 'link').at, 'not before its time');
  for (const m of inbox.a) {
    if (m.t === 'ev') worldA.queue({ at: m.at, event: { t: m.k } });
  }
  for (let i = 0; i < 30; i++) worldA.update(1000 / 30);
  assert.ok(worldA.events.some((e) => e.t === 'link'), 'the link plays out');
  // Steer A out of the arena: it breaks at the edge and hears so.
  place(sa, room.world.R - 30, 0, 0);
  for (let i = 0; i < 10 && a.snakeId; i++) room.tick();
  const dead = inbox.a.find((m) => m.t === 'dead');
  assert.ok(dead && dead.edge === true && Number.isFinite(dead.at), 'A broke at the edge');
  assert.equal(a.snakeId, 0);
  room.close();
});

test('a player who leaves breaks into sparks and frees the room', (t) => {
  const room = manualRoom(t);
  const c = fakeClient(() => {}, () => {});
  c.onMessage(JSON.stringify({ t: 'join', name: 'נר שקט' }));
  const id = c.snakeId;
  assert.ok(room.world.snakes.get(id)?.alive);
  const sparks = room.world.sparks.size;
  c.leaveRoom();
  assert.equal(room.world.snakes.get(id)?.alive, false);
  assert.ok(room.world.sparks.size > sparks, 'its chain turned into sparks');
  assert.equal(room.clients.size, 0);
  room.close();
  assert.equal(rooms.size, 0);
});

test('names: one of your own when it is clean, else a generated one', () => {
  const { cleanName, VALID_NAMES } = _internals;
  assert.equal(cleanName('ניצוץ זריז'), 'ניצוץ זריז');
  assert.equal(cleanName('  מיכאל  '), 'מיכאל');
  assert.equal(cleanName('Иван 7'), 'Иван 7');
  for (const bad of ['<script>', '', null, 42, 'ניצוץ זריז '.repeat(3), 'www.spam.com', 'fuuuck', 'ז ו נ ה', '😀😀😀']) {
    assert.ok(VALID_NAMES.has(cleanName(bad)), String(bad));
  }
});

function place(s, x, y, a) {
  s.x = x;
  s.y = y;
  s.a = a;
  s.ta = a;
  for (let i = 0; i < s.px.length; i++) {
    s.px[i] = x - Math.cos(a) * i * 7;
    s.py[i] = y - Math.sin(a) * i * 7;
  }
  assert.ok(Math.abs(angleDiff(s.a, a)) < 1e-9);
}
