// Headless test: two scripted clients + AI racers run a race, drifting and using
// items, and every event is printed.
// Usage: start the server (npm start), then in another terminal: npm run test:bots
const { io } = require('socket.io-client');
const S = require('../shared/game.js');
const T = S.buildTrack(S.TRACK_POINTS, S.CONFIG.TRACK_WIDTH);
const LAPS = Number(process.env.LAPS || 2);
const AI = Number(process.env.AI === undefined ? 2 : process.env.AI);
const counts = {};

function bend(s, span) {
  return Math.abs(S.wrapAngle(S.pointAtDistance(T, s + span).angle - S.pointAtDistance(T, s + 30).angle));
}

function bot(laneOffset) {
  const s = io(process.env.URL || 'http://localhost:3000');
  let st = null, seq = 0, id, drifting = false;
  s.on('state', (m) => {
    st = m;
    for (const e of m.world.events) {
      if (e.id === undefined || e.id === id) {
        const k = e.t + (e.item ? ':' + e.item : '');
        counts[k] = (counts[k] || 0) + (e.id === undefined ? 0.5 : 1);
      }
    }
  });
  setInterval(() => {
    if (!st || st.phase !== 'racing') return;
    const me = st.players.find((p) => p.id === id);
    if (!me) return;
    if (me.item) s.emit('useItem', { back: me.item === 'bomb' && me.pos === 1 });
    const near = S.nearestOnTrack(T, me.x, me.y);
    const tgt = S.trackPos(T, near.s + 170 + Math.abs(me.speed) * 0.35, laneOffset);
    const d = S.wrapAngle(Math.atan2(tgt.y - me.y, tgt.x - me.x) - me.angle);
    const corner = bend(near.s, 400);
    // drift the corners, stunt off the jumps
    if (me.air) drifting = true;
    else if (drifting) drifting = corner > 0.3 || me.charge < 0.55;
    else drifting = corner > 0.34 && me.speed > 250;
    let steer = d < -0.05 ? -1 : d > 0.05 ? 1 : 0;
    if (drifting && !me.air && steer === 0) steer = me.drift || 1;
    s.emit('input', { seq: ++seq, u: true, d: false, l: steer < 0, r: steer > 0, h: drifting });
  }, 1000 / 60);
  return { s, setId: (v) => { id = v; }, get st() { return st; } };
}

(async () => {
  const a = bot(-35), b = bot(40);
  const res = await new Promise((r) => a.s.emit('createRoom', { name: 'A' }, r));
  a.setId(res.id);
  const j = await new Promise((r) => b.s.emit('joinRoom', { name: 'B', code: res.code }, r));
  b.setId(j.id);
  a.s.emit('settings', { laps: LAPS, bots: AI, level: 'hard' });
  await new Promise((r) => setTimeout(r, 300));
  a.s.emit('startRace');
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < 200000) {
    await new Promise((r) => setTimeout(r, 500));
    const st = a.st;
    if (!st) continue;
    if (Date.now() - last > 12000) {
      last = Date.now();
      console.log(
        ((Date.now() - t0) / 1000 | 0) + 's', st.phase,
        st.players.map((p) => `${p.name} lap${p.lap} p${p.pos} ${p.item || '-'} dr=${p.drift} ch=${p.charge.toFixed(1)} bo=${p.boost.toFixed(1)} df=${p.draft.toFixed(1)} sc=${p.score}`).join(' | '),
        'oils', st.world.oils.length, 'msl', st.world.missiles.length,
      );
    }
    if (st.phase === 'finished') break;
  }
  const st = a.st;
  console.log('FINAL', st.players.map((p) => `${p.name}${p.bot ? '(AI)' : ''} place=${p.place} time=${p.finishTime} best=${p.bestLap} score=${p.score}`));
  console.log('events', counts);
  process.exit(0);
})();
