// Load test: N simulated players join, steer and rejoin, like people on phones.
//   node scripts/loadtest.mjs ws://127.0.0.1:3000/ws 40 60 israel,tel-aviv    (url, players, seconds, maps)
// Players are spread over the maps given (default: the one the server suggests). Prints what each player receives
// per second and the server's tick time, rooms and memory from /healthz.
const [url = 'ws://127.0.0.1:3000/ws', nArg = '40', secsArg = '60', mapsArg = ''] = process.argv.slice(2);
const MAPS = mapsArg.split(',').filter(Boolean);
const N = Number(nArg);
const SECS = Number(secsArg);
const health = url.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz');
const NAMES = ['ניצוץ זריז', 'כוכב אמיץ', 'גל מהנגב', 'נר שקט', 'ברק מהעמק', 'פנס עליז'];
const totals = { bytes: 0, snaps: 0, deaths: 0, joins: 0, closed: 0, full: 0, busy: 0 };

function player(i) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let angle = Math.random() * Math.PI * 2;
  let alive = false;
  let timer = 0;
  let map = MAPS.length ? MAPS[i % MAPS.length] : '';
  const join = () => ws.send(JSON.stringify({ t: 'join', map, name: NAMES[i % NAMES.length], skin: `a${i % 16}`, vw: 420, vh: 860 }));
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      totals.bytes += e.data.length;
      const m = JSON.parse(e.data);
      if (m.t === 'hello') {
        map ||= m.home;
        join();
      } else if (m.t === 'full') totals.full++;
      else if (m.t === 'busy') totals.busy++;
      else if (m.t === 'joined') {
        alive = true;
        totals.joins++;
      } else if (m.t === 'dead') {
        alive = false;
        totals.deaths++;
        setTimeout(() => ws.readyState === 1 && join(), 1500 + Math.random() * 2000);
      }
    } else {
      totals.bytes += e.data.byteLength;
      totals.snaps++;
    }
  };
  ws.onopen = () => {
    timer = setInterval(() => {
      if (!alive) return;
      angle += (Math.random() - 0.5) * 0.6;
      ws.send(JSON.stringify({ t: 'in', a: Math.round(angle * 1000) / 1000, b: Math.random() < 0.1 ? 1 : 0, vw: 420, vh: 860 }));
      if (Math.random() < 0.01) ws.send(JSON.stringify({ t: 'hand' }));
    }, 100);
  };
  ws.onclose = () => {
    clearInterval(timer);
    totals.closed++;
  };
  return ws;
}

const sockets = [];
for (let i = 0; i < N; i++) {
  sockets.push(player(i));
  await new Promise((r) => setTimeout(r, 50));
}
const t0 = Date.now();
let last = { bytes: 0, snaps: 0, at: t0 };
const every = setInterval(async () => {
  const now = Date.now();
  const secs = (now - last.at) / 1000;
  let h = {};
  try {
    h = await (await fetch(health)).json();
  } catch {}
  console.log(
    `${Math.round((now - t0) / 1000)}s  per player ${((totals.bytes - last.bytes) / 1024 / secs / N).toFixed(1)} KB/s, ` +
      `${((totals.snaps - last.snaps) / secs / N).toFixed(1)} snapshots/s · server: ${h.online} online, ${h.rooms} rooms, ` +
      `tick ${h.tickMs} ms, ${h.rssMb} MB · joins ${totals.joins}, deaths ${totals.deaths}, closed ${totals.closed}, ` +
      `full ${totals.full}, busy ${totals.busy}`,
  );
  last = { bytes: totals.bytes, snaps: totals.snaps, at: now };
}, 10_000);
setTimeout(() => {
  clearInterval(every);
  for (const ws of sockets) ws.close();
  setTimeout(() => process.exit(0), 300);
}, SECS * 1000);
