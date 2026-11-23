// Server-side "world" stuff: pedestrians, item boxes, oil slicks, bombs,
// homing missiles, thunder and shields.
// Everything here is decided by the server so nobody can cheat.
const S = require('./shared/game.js');
const { CONFIG, PHYS } = S;

const HALF = CONFIG.TRACK_WIDTH / 2;
const WALL_LIMIT = HALF + CONFIG.CURB - CONFIG.CAR_RADIUS * 0.75;
const PED_EDGE = HALF + 6;          // pedestrians wait on the kerb
const PED_HIT_DIST = 26;
const BOX_HIT_DIST = 34;
const OIL_RADIUS = 38;
const OIL_LIFETIME = 30000;         // ms
const MAX_OILS = 14;
const BLAST_RADIUS = 105;
const BOX_RESPAWN = 5000;           // ms
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SHIELD_TIME = 8;              // s
const NITRO_TIME = 2.6;             // s
const MISSILE_SPEED = 980;          // px/s along the track (must outrun a boosting car)
const MISSILE_LIFE = 6;             // s
const MISSILE_HIT = 48;
const THUNDER_SLOW = 0.45;          // speed left after a thunder strike

// ---- smoke bomb ----
const SMOKE_RADIUS = 280;           // how far the cloud blinds
const SMOKE_TIME = 7000;            // ms before it clears
const MAX_SMOKES = 8;
const SMOKE_THROW = 460;            // how far ahead it lands

// ---- machine gun ----
const GUN_TIME = 5;                 // seconds of ammo
const GUN_COOLDOWN = 0.3;           // seconds between shots
const GUN_RANGE = 560;
const GUN_CONE = 0.4;               // how wide the aim is (cosine)
const GUN_SLOW = 1.0;               // seconds each hit drags you down for

// ---- flip bomb ----
const FLIP_RADIUS = 300;            // everyone this close goes on their roof

// Points for the style score shown on the results screen.
const SCORE = { hit: 180, mt: [0, 60, 130, 240], trick: 160, draft: 70, ped: -120, shot: 45, flip: 150 };

// Each row across the track holds S.BOX_LATS.length boxes, but only this many of them
// actually contain a power-up. The rest are mystery boxes: they pop a picture on screen
// and nothing else. They look identical, so picking a box is a gamble.
const ITEM_BOXES_PER_ROW = 2;

// Decide which boxes in one row hold the power-ups. Re-rolled every time they respawn,
// so nobody can learn "the left one is always good".
function rollRow(world, row) {
  const lats = S.BOX_LATS.length;
  const idx = [];
  for (let i = 0; i < lats; i++) idx.push(row * lats + i);
  for (let i = idx.length - 1; i > 0; i--) {         // shuffle
    const j = Math.floor(Math.random() * (i + 1));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  idx.forEach((bi, k) => {
    if (world.boxes[bi]) world.boxes[bi].prize = k < ITEM_BOXES_PER_ROW ? 'item' : 'mystery';
  });
}

function rollAllRows(world) {
  const rows = S.BOX_ROWS.length;
  for (let r = 0; r < rows; r++) rollRow(world, r);
}

function createWorld(track) {
  const lats = S.BOX_LATS.length;
  const world = {
    track,
    boxes: S.boxPositions(track).map((p, i) => ({
      x: p.x, y: p.y, active: true, respawn: 0, row: Math.floor(i / lats), prize: 'item',
    })),
    oils: [],
    bombs: [],
    missiles: [],
    smokes: [],
    peds: [],
    events: [],
    nextId: 1,
  };
  let k = 0;
  const n = S.PEDS_PER_CROSSING;
  for (const s of S.CROSSINGS) {
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      world.peds.push({
        id: k, s: s + (i - (n - 1) / 2) * 20, lat: side * PED_EDGE, dir: -side,
        speed: 36 + ((k * 37) % 22), wait: 1.5 + i * 2.2 + (k % 3), down: 0,
        x: 0, y: 0, h: 0, walking: false,
      });
      k++;
    }
  }
  rollAllRows(world);
  updatePeds(world, 0);
  return world;
}

function resetWorld(world) {
  for (const b of world.boxes) { b.active = true; b.respawn = 0; }
  rollAllRows(world);
  world.oils = [];
  world.bombs = [];
  world.missiles = [];
  world.smokes = [];
  world.events = [];
  for (const p of world.peds) p.down = 0;
}

// Pedestrians walk back and forth across the zebra crossings, pausing on the kerb.
function updatePeds(world, dt) {
  for (const p of world.peds) {
    if (p.down > 0) {
      p.down = Math.max(0, p.down - dt); // knocked over, getting back up
      p.walking = false;
    } else if (p.wait > 0) {
      p.wait -= dt;
      p.walking = false;
    } else {
      p.lat += p.dir * p.speed * dt;
      p.walking = true;
      if (Math.abs(p.lat) >= PED_EDGE) {
        p.lat = Math.sign(p.lat) * PED_EDGE;
        p.dir *= -1;
        p.wait = 3.5 + Math.random() * 6; // long waits on the kerb: the road stays clearer
      }
    }
    const q = S.trackPos(world.track, p.s, p.lat);
    p.x = q.x; p.y = q.y;
    p.h = q.angle + (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}

function pickItem(pos, count) {
  // Leaders get defensive items, people at the back get attacking/catch-up items.
  let table;
  if (count > 1 && pos === 1) {
    // out front: defend yourself and block the chase
    table = { oil: 4, shield: 4, smoke: 3, bomb: 2, nitro: 1, missile: 1, flip: 1 };
  } else if (count > 2 && pos >= count - 1) {
    table = { missile: 4, thunder: 3, nitro: 3, fly: 3, gun: 3, flip: 2, bomb: 2, oil: 1, shield: 1 };
  } else if (count > 1 && pos === count) {
    table = { missile: 4, thunder: 2, nitro: 3, fly: 3, gun: 3, flip: 2, bomb: 2, oil: 1, shield: 1 };
  } else {
    table = { oil: 3, bomb: 3, nitro: 3, shield: 2, missile: 2, smoke: 2, gun: 2, fly: 2, flip: 2, thunder: 1 };
  }
  const total = Object.values(table).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [item, w] of Object.entries(table)) { r -= w; if (r < 0) return item; }
  return 'oil';
}

function award(players, id, points) {
  if (!id || !points) return;
  const pl = players && players.find((p) => p.id === id);
  if (pl) pl.score = (pl.score || 0) + points;
}

// Something bad happens to a player. Returns false if their shield blocked it.
function hit(world, pl, kind, by, players) {
  if (pl.shield > 0) {
    pl.shield = 0;
    world.events.push({ t: 'block', id: pl.id });
    return false;
  }
  const c = pl.car;
  c.stun = CONFIG.STUN_TIME;
  c.boost = 0;
  c.bt = 0;
  c.drift = 0;
  c.charge = 0;
  c.draft = 0;
  if (kind === 'ped') { c.speed *= 0.1; pl.item = null; }  // penalty: stop dead + lose your item
  if (kind === 'oil') c.speed *= 0.8;
  if (kind === 'bomb') { c.speed *= 0.25; c.vz = 230; c.air = true; c.z = Math.max(c.z, 1); }
  if (kind === 'missile') {
    // knocked sideways AND crippled: the slow is what the victim really feels
    c.speed *= 0.2;
    c.vz = 150; c.air = true; c.z = Math.max(c.z, 1);
    c.slow = PHYS.SLOW_TIME;
  }
  if (kind === 'thunder') c.speed *= THUNDER_SLOW;
  if (kind === 'flip') { c.flip = PHYS.FLIP_TIME; c.speed *= 0.3; c.fly = 0; }
  world.events.push({ t: kind, id: pl.id, by: by || undefined });
  if (by && by !== pl.id) award(players, by, SCORE.hit);
  return true;
}

function explode(world, players, x, y, by) {
  world.events.push({ t: 'boom', x: Math.round(x), y: Math.round(y) });
  for (const pl of players) {
    if (Math.hypot(pl.car.x - x, pl.car.y - y) < BLAST_RADIUS) hit(world, pl, 'bomb', by, players);
  }
}

// One server tick of hazards. Each player must have prevX/prevY (position before this tick's movement).
function updateWorld(world, players, now, dt) {
  // boxes respawn, and the row reshuffles which ones are worth having
  for (const b of world.boxes) if (!b.active && now >= b.respawn) { b.active = true; rollRow(world, b.row); }
  // old oil dries up and smoke clears
  world.oils = world.oils.filter((o) => now - o.born < OIL_LIFETIME);
  world.smokes = world.smokes.filter((s) => now - s.born < SMOKE_TIME);

  for (const pl of players) {
    if (pl.shield > 0) pl.shield = Math.max(0, pl.shield - dt);
    if (pl.gun > 0) pl.gun = Math.max(0, pl.gun - dt);
    if (pl.gunCool > 0) pl.gunCool = Math.max(0, pl.gunCool - dt);
    const c = pl.car;
    const ax = pl.prevX, ay = pl.prevY;

    // pedestrians
    if (c.z < 14) {
      for (const ped of world.peds) {
        if (ped.down > 0) continue;
        if (S.segDist(ped.x, ped.y, ax, ay, c.x, c.y) < PED_HIT_DIST) {
          ped.down = 3.5;
          world.events.push({ t: 'pedfall', x: Math.round(ped.x), y: Math.round(ped.y) });
          if (c.stun <= 0) {
            if (hit(world, pl, 'ped', null, players)) pl.score = Math.max(0, (pl.score || 0) + SCORE.ped);
          }
        }
      }
    }

    // item boxes
    if (c.z < 30) {
      for (const b of world.boxes) {
        if (!b.active || S.segDist(b.x, b.y, ax, ay, c.x, c.y) > BOX_HIT_DIST) continue;
        b.active = false;
        b.respawn = now + BOX_RESPAWN;
        if (b.prize === 'mystery') {
          world.events.push({ t: 'mystery', id: pl.id });   // a picture, and nothing else
        } else if (!pl.item) {
          pl.item = pickItem(pl.pos || 1, players.length);
          world.events.push({ t: 'pickup', id: pl.id, item: pl.item });
        }
      }
    }

    // oil slicks
    if (c.z < 6 && c.stun <= 0) {
      for (const o of world.oils) {
        if (o.owner === pl.id && now - o.born < 1200) continue; // do not slip on your own fresh oil
        if (S.segDist(o.x, o.y, ax, ay, c.x, c.y) < OIL_RADIUS) { hit(world, pl, 'oil', o.owner, players); break; }
      }
    }
  }

  // bombs fly in an arc and explode on landing or when they touch a car
  const keep = [];
  for (const b of world.bombs) {
    b.age += dt;
    b.vz -= PHYS.GRAVITY * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    let boom = b.z <= 0 || b.age > 3;
    if (!boom && S.nearestOnTrack(world.track, b.x, b.y).dist > WALL_LIMIT + 25) boom = true; // hit a wall
    if (!boom) {
      for (const pl of players) {
        if (pl.id === b.owner && b.age < 0.4) continue;
        const c = pl.car;
        if (Math.hypot(c.x - b.x, c.y - b.y) < 34 && Math.abs(c.z + 10 - b.z) < 30) { boom = true; break; }
      }
    }
    if (boom) explode(world, players, b.x, b.y, b.owner);
    else keep.push(b);
  }
  world.bombs = keep;

  // homing missiles ride the centre line, so they follow the track round corners
  const live = [];
  for (const m of world.missiles) {
    m.age += dt;
    m.s += MISSILE_SPEED * dt;
    const target = m.target ? players.find((p) => p.id === m.target && !p.finished) : null;
    if (target) {
      const tn = S.nearestOnTrack(world.track, target.car.x, target.car.y);
      m.lat += clamp(tn.lat - m.lat, -340 * dt, 340 * dt);   // slide across to line up
    }
    const p = S.trackPos(world.track, m.s, m.lat);
    m.x = p.x; m.y = p.y; m.angle = p.angle;
    let done = m.age > MISSILE_LIFE;
    if (!done) {
      for (const pl of players) {
        if (pl.id === m.owner && m.age < 0.3) continue;
        if (pl.car.z > 46) continue;                          // flew under a jumping car
        if (Math.hypot(pl.car.x - m.x, pl.car.y - m.y) < MISSILE_HIT) {
          world.events.push({ t: 'boom', x: Math.round(m.x), y: Math.round(m.y) });
          hit(world, pl, 'missile', m.owner, players);
          done = true;
          break;
        }
      }
    }
    if (done) {
      if (m.age > MISSILE_LIFE) world.events.push({ t: 'fizzle', x: Math.round(m.x), y: Math.round(m.y) });
    } else live.push(m);
  }
  world.missiles = live;
}

function useItem(world, pl, back, now, players) {
  const item = pl.item;
  if (!item) return;
  pl.item = null;
  const c = pl.car;
  const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
  if (item === 'oil') {
    const ox = c.x - hx * 44, oy = c.y - hy * 44;
    // remember where it sits on the track so the AI does not have to work it out every tick
    const on = S.nearestOnTrack(world.track, ox, oy);
    world.oils.push({ id: world.nextId++, x: ox, y: oy, s: on.s, lat: on.lat, owner: pl.id, born: now });
    if (world.oils.length > MAX_OILS) world.oils.shift();
  } else if (item === 'bomb') {
    const x0 = c.x + hx * (back ? -30 : 30), y0 = c.y + hy * (back ? -30 : 30), z0 = c.z + 22;
    let vx, vy, vz;
    // aim at the closest car in front of us (within range), leading the target
    let target = null, bestD = 1400;
    if (!back) {
      for (const o of players) {
        if (o === pl) continue;
        const dx = o.car.x - c.x, dy = o.car.y - c.y, d = Math.hypot(dx, dy);
        if (d < bestD && d > 40 && (dx * hx + dy * hy) / d > 0.5) { bestD = d; target = o.car; }
      }
    }
    if (target) {
      const T = clamp(bestD / 900, 0.45, 1.1);                 // flight time
      const tx = target.x + Math.cos(target.angle) * target.speed * T;
      const ty = target.y + Math.sin(target.angle) * target.speed * T;
      vx = (tx - x0) / T; vy = (ty - y0) / T;
      vz = (PHYS.GRAVITY * T * T / 2 - z0) / T;                // lands right at the target
    } else {
      const sp = back ? -160 : Math.max(0, c.speed) + 480;
      vx = hx * sp; vy = hy * sp; vz = back ? 120 : 170;
    }
    world.bombs.push({ id: world.nextId++, owner: pl.id, age: 0, x: x0, y: y0, z: z0, vx, vy, vz });
  } else if (item === 'missile') {
    // lock onto the nearest rival ahead on the track; if nobody is ahead (you are
    // leading), take the nearest car anywhere so the missile never goes to waste
    const near = S.nearestOnTrack(world.track, c.x, c.y);
    let target = null, bestGap = Infinity;
    let fallback = null, bestDist = Infinity;
    for (const o of players) {
      if (o === pl || o.finished) continue;
      const gap = S.alongDiff(world.track, S.nearestOnTrack(world.track, o.car.x, o.car.y).s, near.s);
      if (gap > 20 && gap < bestGap) { bestGap = gap; target = o; }
      const d = Math.hypot(o.car.x - c.x, o.car.y - c.y);
      if (d < bestDist) { bestDist = d; fallback = o; }
    }
    if (!target) target = fallback;
    world.missiles.push({
      id: world.nextId++, owner: pl.id, target: target ? target.id : null,
      age: 0, s: near.s + 46, lat: near.lat, x: c.x, y: c.y, angle: c.angle,
    });
    world.events.push({ t: 'lock', id: pl.id, on: target ? target.id : undefined });
  } else if (item === 'thunder') {
    // strikes everyone ahead of you: the classic comeback item
    const mine = pl.pos || 1;
    const struck = [];
    for (const o of players) {
      if (o === pl || o.finished) continue;
      if ((o.pos || 1) < mine) { if (hit(world, o, 'thunder', pl.id, players)) struck.push(o.id); }
    }
    world.events.push({ t: 'storm', id: pl.id, hits: struck });
  } else if (item === 'smoke') {
    // a blinding cloud: thrown ahead by default, dropped behind with S+SPACE
    const near = S.nearestOnTrack(world.track, c.x, c.y);
    const q = back
      ? { x: c.x - hx * 60, y: c.y - hy * 60 }
      : S.trackPos(world.track, near.s + SMOKE_THROW, near.lat);
    world.smokes.push({ id: world.nextId++, x: q.x, y: q.y, owner: pl.id, born: now });
    if (world.smokes.length > MAX_SMOKES) world.smokes.shift();
  } else if (item === 'fly') {
    c.fly = PHYS.FLY_TIME;              // up and over everything on the ground
    c.stun = 0;
    c.flip = 0;
  } else if (item === 'gun') {
    pl.gun = GUN_TIME;                  // SPACE now fires instead of using an item
    pl.gunCool = 0;
  } else if (item === 'flip') {
    // everyone close by lands on their roof
    const hitIds = [];
    for (const o of players) {
      if (o === pl || o.finished) continue;
      if (Math.hypot(o.car.x - c.x, o.car.y - c.y) > FLIP_RADIUS) continue;
      if (Math.abs(o.car.z - c.z) > 120) continue;
      if (hit(world, o, 'flip', pl.id, players)) hitIds.push(o.id);
    }
    if (hitIds.length) award(players, pl.id, SCORE.flip * hitIds.length);
    world.events.push({ t: 'shockwave', x: Math.round(c.x), y: Math.round(c.y), id: pl.id, hits: hitIds });
  } else if (item === 'nitro') {
    c.boost = Math.max(c.boost, NITRO_TIME);
    c.bt = 0;
  } else if (item === 'shield') {
    pl.shield = SHIELD_TIME;
  }
  world.events.push({ t: 'use', id: pl.id, item });
}

// While the gun power-up is live, SPACE fires at the nearest car in front of you.
function fireGun(world, pl, players) {
  if (!(pl.gun > 0) || (pl.gunCool || 0) > 0 || pl.car.stun > 0 || pl.car.flip > 0) return;
  pl.gunCool = GUN_COOLDOWN;
  const c = pl.car;
  const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
  let target = null, bestD = GUN_RANGE;
  for (const o of players) {
    if (o === pl || o.finished) continue;
    const dx = o.car.x - c.x, dy = o.car.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > bestD) continue;
    if ((dx * hx + dy * hy) / d < GUN_CONE) continue;   // must be roughly in front
    bestD = d; target = o;
  }
  world.events.push({
    t: 'gunfire', id: pl.id,
    x: Math.round(c.x + hx * 28), y: Math.round(c.y + hy * 28),
    tx: target ? Math.round(target.car.x) : Math.round(c.x + hx * GUN_RANGE),
    ty: target ? Math.round(target.car.y) : Math.round(c.y + hy * GUN_RANGE),
  });
  if (!target) return;
  if (target.shield > 0) {
    target.shield = 0;
    world.events.push({ t: 'block', id: target.id });
    return;
  }
  // bullets chip away rather than spinning you out - the gun fires three times a second
  const tc = target.car;
  tc.speed *= 0.86;
  tc.slow = Math.max(tc.slow || 0, GUN_SLOW);
  tc.drift = 0; tc.charge = 0;
  world.events.push({ t: 'shot', id: target.id, by: pl.id });
  award(players, pl.id, SCORE.shot);
}

// Compact data for the snapshot sent to browsers.
function snapshotWorld(world) {
  const r = Math.round;
  const snap = {
    boxes: world.boxes.map((b) => (b.active ? 1 : 0)).join(''),
    oils: world.oils.map((o) => [o.id, r(o.x), r(o.y)]),
    bombs: world.bombs.map((b) => [b.id, r(b.x), r(b.y), r(b.z)]),
    missiles: world.missiles.map((m) => [m.id, r(m.x), r(m.y), +m.angle.toFixed(2)]),
    smokes: world.smokes.map((s) => [s.id, r(s.x), r(s.y), +((Date.now() - s.born) / SMOKE_TIME).toFixed(2)]),
    peds: world.peds.map((p) => [r(p.x), r(p.y), +p.h.toFixed(2), p.walking ? 1 : 0, +p.down.toFixed(2)]),
    events: world.events,
  };
  world.events = [];
  return snap;
}

module.exports = {
  createWorld, resetWorld, updatePeds, updateWorld, useItem, fireGun, snapshotWorld,
  SCORE, SMOKE_RADIUS, GUN_TIME,
};
