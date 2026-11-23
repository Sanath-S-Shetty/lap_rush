// AI racers. They run on the server and are driven through exactly the same
// stepCar() physics as humans - they only ever produce key presses, so they
// drift, jump, crash and slip on oil just like a player does.
const S = require('./shared/game.js');
const { CONFIG, PHYS } = S;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const BOT_NAMES = ['Turbo Tina', 'Drift Dave', 'Nitro Nia', 'Wheelie Wes', 'Apex Ana', 'Boost Bo', 'Slick Sam'];

// skill 0..1 -> how fast and how tidily they drive
const LEVELS = {
  easy: 0.3,
  normal: 0.6,
  hard: 0.9,
};

function makeBrain(skill, seed) {
  return {
    skill,
    lane: ((seed % 5) - 2) * 26,   // preferred line, a bit off centre so they do not stack up
    jitter: (seed % 7) * 0.9,      // de-synchronises their decisions
    drifting: false,
    itemWait: 0.6 + (seed % 4) * 0.35,
    recover: 0,
  };
}

function botNames(n, taken) {
  const used = new Set([...taken].map((s) => String(s).toLowerCase()));
  const out = [];
  for (const name of BOT_NAMES) {
    if (out.length >= n) break;
    if (!used.has(name.toLowerCase())) out.push(name);
  }
  while (out.length < n) out.push('Racer ' + (out.length + 1));
  return out;
}

// How sharply the track bends over the next `span` pixels, signed (+ = turns right).
function bend(track, s, span) {
  const a = S.pointAtDistance(track, s + 30).angle;
  const b = S.pointAtDistance(track, s + span).angle;
  return S.wrapAngle(b - a);
}

// One tick of thinking. Returns the key presses this bot would make.
// `rubber` (0.9..1.1) nudges their pace so a race stays close.
function think(bot, track, world, players, rubber, dt) {
  const brain = bot.brain;
  const c = bot.car;
  const near = S.nearestOnTrack(track, c.x, c.y);
  const sk = brain.skill;

  if (c.stun > 0) { brain.drifting = false; return { u: false, d: false, l: false, r: false, h: false }; }

  // ---- where do we want to be, sideways on the track? ----
  const curveNow = bend(track, near.s, 300);
  const curveNext = bend(track, near.s + 260, 360);
  const sharp = Math.max(Math.abs(curveNow), Math.abs(curveNext));
  // aim for the inside of the bend (apex), better drivers hug it harder
  let wantLat = brain.lane - Math.sign(curveNow) * sharp * (60 + 70 * sk);

  // chase boost pads and item boxes that are nearly on our line
  let grab = null, grabD = 1e9;
  for (const p of S.PADS) {
    const d = S.alongDiff(track, p.s, near.s);
    if (d < 520 && d < grabD) { grabD = d; grab = (p.lat0 + p.lat1) / 2; }
  }
  if (!bot.item) {
    S.BOX_ROWS.forEach((s, row) => {
      const d = S.alongDiff(track, s, near.s);
      if (d >= 520 || d >= grabD) return;
      // nearest still-standing box in this row
      let best = null, bestD = 1e9;
      S.BOX_LATS.forEach((lat, i) => {
        const b = world.boxes[row * S.BOX_LATS.length + i];
        if (!b || !b.active) return;
        const dd = Math.abs(lat - near.lat);
        if (dd < bestD) { bestD = dd; best = lat; }
      });
      if (best !== null) { grabD = d; grab = best; }
    });
  }
  if (grab !== null && grabD < 420) wantLat = grab;

  // ---- dodge things that hurt ----
  // Everything here is dodged by its (s, lat) on the track. Hazards already know their
  // own track position, so we must never recompute it - nearestOnTrack is the most
  // expensive call in the game and this runs for every hazard, every bot, every tick.
  const look = 190 + Math.abs(c.speed) * 0.45;
  const avoidAt = (s, lat, radius) => {
    const d = S.alongDiff(track, s, near.s);
    if (d > look || d < -20) return;
    if (Math.abs(lat - wantLat) < radius) {
      wantLat = lat + (lat > near.lat ? -radius - 14 : radius + 14);
    }
  };
  const trackPosOf = (o, x, y) => {
    if (o && o.s !== undefined && o.lat !== undefined) return o;      // already known
    const n = S.nearestOnTrack(track, x, y);
    if (o) { o.s = n.s; o.lat = n.lat; }                              // cache it
    return n;
  };
  // driving blind in a smoke cloud: the AI loses the line, same as a player would
  let blinded = 0;
  for (const sm of world.smokes || []) {
    const d = Math.hypot(sm.x - c.x, sm.y - c.y);
    if (d < 280) blinded = Math.max(blinded, 1 - d / 280);
  }
  if (blinded > 0) wantLat += Math.sin((brain.jitter + c.x * 0.01)) * 70 * blinded;

  for (const o of world.oils) { const n = trackPosOf(o, o.x, o.y); avoidAt(n.s, n.lat, 58 + 30 * sk); }
  for (const p of world.peds) if (p.down <= 0) avoidAt(p.s, p.lat, 46 + 24 * sk);
  for (const b of world.bombs) { const n = S.nearestOnTrack(track, b.x, b.y); avoidAt(n.s, n.lat, 80); }
  for (const o of players) {
    if (o === bot || o.car.z > 25) continue;
    const dx = o.car.x - c.x, dy = o.car.y - c.y;
    if (Math.hypot(dx, dy) < 150 && (dx * Math.cos(c.angle) + dy * Math.sin(c.angle)) > 0) {
      // the server stashes each car's track position once per tick as p.near
      const n = o.near || S.nearestOnTrack(track, o.car.x, o.car.y);
      if (Math.abs(n.lat - wantLat) < 52) wantLat = n.lat + (n.lat > near.lat ? -56 : 56);
    }
  }
  const half = CONFIG.TRACK_WIDTH / 2 - 26;
  wantLat = clamp(wantLat, -half, half);

  // ---- steer toward that point ----
  const aim = S.trackPos(track, near.s + look, wantLat);
  let err = S.wrapAngle(Math.atan2(aim.y - c.y, aim.x - c.x) - c.angle);
  const dead = 0.05 - 0.02 * sk;

  // ---- how fast do we want to go? ----
  const corner = Math.max(Math.abs(bend(track, near.s, 420)), Math.abs(curveNext));
  const pace = (0.84 + 0.17 * sk) * rubber;
  let target = PHYS.MAX_SPEED * pace;
  if (corner > 0.35) target *= clamp(1 - (corner - 0.35) * (0.78 - 0.22 * sk), 0.5, 1);
  if (c.boost > 0) target *= PHYS.BOOST_MULT;
  if (blinded > 0) target *= 1 - 0.3 * blinded;   // ease off when you cannot see

  // too far off the track line? ease off so we can get back on it
  if (Math.abs(near.lat) > half - 6 && Math.abs(err) > 0.35) target *= 0.8;

  const speed = c.speed;
  let gas = speed < target;
  let brake = speed > target * 1.14 && corner > 0.3;
  if (speed < 60 && Math.abs(err) > 2.2) { brake = true; gas = false; } // facing a wall: back up
  if (brake) gas = false;

  // ---- drift through the corners (bots earn mini-turbos too) ----
  let h = false;
  if (sk > 0.35 && !c.air) {
    const want = corner > 0.34 && speed > PHYS.DRIFT_MIN_SPEED + 40 && Math.abs(near.lat) < half - 10;
    if (brain.drifting) {
      // hold the slide while the corner lasts, and long enough to bank a real charge
      brain.drifting = want || c.charge < PHYS.DRIFT_TIERS[0] + 0.05;
    } else {
      brain.drifting = want && c.charge === 0;
    }
    h = brain.drifting;
  } else {
    brain.drifting = false;
  }
  // stunt off every jump
  if (c.air) h = sk > 0.25;

  let steer = 0;
  if (err > dead) steer = 1;
  else if (err < -dead) steer = -1;
  if (h && !c.air) {
    // a drift needs a steering input to start and to stay tight
    if (steer === 0) steer = Math.sign(curveNow) || 1;
    if (c.drift && steer !== c.drift && Math.abs(err) < 0.25) steer = c.drift;
  }
  if (speed < 0) steer = -steer; // reversing: wheels the other way

  return { u: gas, d: brake, l: steer < 0, r: steer > 0, h };
}

// Should this bot fire its item right now?
function wantsItem(bot, track, players, dt) {
  const brain = bot.brain;
  if (!bot.item || bot.car.stun > 0) return null;
  brain.itemWait -= dt;
  if (brain.itemWait > 0) return null;
  brain.itemWait = 0.5 + (1 - brain.skill) * 1.6;

  const c = bot.car;
  const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
  let ahead = null, behind = null;
  for (const o of players) {
    if (o === bot || o.finished) continue;
    const dx = o.car.x - c.x, dy = o.car.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const front = (dx * hx + dy * hy) / d;
    if (d < 1500 && front > 0.4) ahead = Math.min(ahead === null ? d : ahead, d);
    if (d < 700 && front < -0.3) behind = Math.min(behind === null ? d : behind, d);
  }
  const near = S.nearestOnTrack(track, c.x, c.y);
  const straight = Math.abs(bend(track, near.s, 520)) < 0.3;

  switch (bot.item) {
    case 'nitro':
      // save it for a straight
      return straight && c.boost <= 0 ? { back: false } : null;
    case 'shield':
      return behind !== null || Math.random() < 0.15 * brain.skill ? { back: false } : null;
    case 'oil':
      // drop it when someone is on your tail
      return behind !== null && behind < 520 ? { back: true } : null;
    case 'bomb':
      if (ahead !== null && ahead < 900) return { back: false };
      if (behind !== null && behind < 420) return { back: true };
      return null;
    case 'missile':
      return ahead !== null ? { back: false } : null;
    case 'thunder':
      return (bot.pos || 1) > 1 ? { back: false } : null;
    case 'smoke':
      // blind whoever is chasing you, or the pack in front if nobody is
      if (behind !== null) return { back: true };
      return ahead !== null && ahead < 900 ? { back: false } : null;
    case 'fly':
      // worth most on a straight, or to escape when you are bogged down
      return straight || c.speed < PHYS.MAX_SPEED * 0.5 ? { back: false } : null;
    case 'gun':
      return ahead !== null && ahead < 620 ? { back: false } : null;
    case 'flip':
      return (ahead !== null && ahead < 300) || (behind !== null && behind < 300) ? { back: false } : null;
    default:
      return { back: false };
  }
}

module.exports = { makeBrain, botNames, think, wantsItem, LEVELS, BOT_NAMES };
