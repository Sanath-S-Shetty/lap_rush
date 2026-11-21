// Shared game code: runs on BOTH the server (Node) and the browser.
// Keeping physics in one place means the client can predict its own car
// using exactly the same rules the server uses.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The whole circuit is laid out in "design units" below and then scaled up by this.
  // Bump it to make the playfield bigger without redrawing anything: the track points,
  // the world, the road width and every feature position scale together.
  const SCALE = 1.3;
  const sc = (v) => Math.round(v * SCALE);

  const CONFIG = {
    TICK_RATE: 60,          // server simulation steps per second
    SNAPSHOT_EVERY: 3,      // send state every 3 ticks -> 20 updates/sec
    LAPS: 3,                // default; the host can pick 2/3/5 in the lobby
    MAX_PLAYERS: 4,         // human players per room
    MAX_RACERS: 8,          // humans + AI bots on the grid
    SCALE,
    WORLD_W: sc(5300),
    WORLD_H: sc(3400),
    TRACK_WIDTH: sc(260),
    CURB: 14,               // red/white kerb width (drivable); walls are just outside it
    CAR_RADIUS: 20,         // used for car-vs-car collisions
    COUNTDOWN_MS: 3000,
    FINISH_GRACE_MS: 25000, // after the winner finishes, others get 25s
    STUN_TIME: 1.5,         // seconds you spin out (oil, bomb, pedestrian)
  };
  const DT = 1 / CONFIG.TICK_RATE;

  // Tweak these to change how the cars feel.
  const PHYS = {
    ACCEL: 520,          // px/s^2 when holding gas
    BRAKE: 1000,         // px/s^2 when braking
    REVERSE_ACCEL: 300,
    REVERSE_MAX: -180,
    MAX_SPEED: 580,      // top speed on asphalt (px/s)
    GRASS_MAX: 200,      // top speed on grass
    COAST: 160,          // slowdown when no pedal is pressed
    TURN_RATE: 2.9,      // radians/s at full grip
    // Grip washes out as you go faster: flat out you simply cannot make the tight
    // corners, so every bend is a real decision - lift off, or drift through it.
    GRIP_FROM: 300,      // speed where the front end starts to run wide
    GRIP_MIN: 0.56,      // steering left at top speed
    DRIFT_GRIP_KEEP: 0.5, // a drift gives back half of what speed takes away
    BOOST_MULT: 1.5,     // top speed multiplier while boosting
    BOOST_ACCEL: 1000,
    BOOST_TIME: 1.6,     // seconds of boost from one pad
    GRAVITY: 360,        // px/s^2 pulling airborne cars down
    AIR_STEER: 0.35,     // fraction of steering you keep in the air

    // ---- drifting (hold SHIFT + steer) ----
    DRIFT_MIN_SPEED: 200,   // you need this much speed to break traction
    DRIFT_TURN_IN: 1.7,     // turn-rate multiplier when steering into the drift
    DRIFT_TURN_MID: 1.15,   // ... with no steering input
    DRIFT_TURN_OUT: 0.45,   // ... when counter-steering (opens the drift out)
    DRIFT_SLIP: 0.44,       // radians the car slides sideways at full drift
    DRIFT_SLIP_RATE: 6,     // how quickly the slide eases in and out
    DRIFT_DRAG: 0.94,       // top-speed factor while sliding (a drift costs a little speed)
    DRIFT_TIERS: [0.45, 1.0, 1.65],  // seconds of drift needed for charge tier 1 / 2 / 3
    MT_TIME: [0, 0.8, 1.35, 2.1],    // mini-turbo seconds awarded per tier

    // ---- air stunts (hold SHIFT while flying) ----
    TRICK_MIN: 0.28,     // airtime with SHIFT held that counts as a stunt
    TRICK_BOOST: 1.0,    // boost seconds for landing one

    // ---- slipstream (tuck in behind someone) ----
    DRAFT_RANGE: 240,    // how far back the slipstream reaches
    DRAFT_CONE: 0.72,    // how directly behind them you must be (cosine)
    DRAFT_GAIN: 0.8,     // charge per second while tucked in
    DRAFT_DECAY: 1.1,    // discharge per second once you leave it
    DRAFT_MULT: 0.14,    // top-speed bonus at full charge
    DRAFT_BURST: 1.0,    // boost seconds when the slipstream maxes out

    // ---- being hit by a missile ----
    SLOW_TIME: 3.0,      // seconds you are dragged down for
    SLOW_MULT: 0.5,      // top speed while slowed
  };

  // Ramps and boost pads, placed by distance along the lap (s) and
  // sideways position (lat: negative = left, positive = right of centre).
  // `s` (distance along the lap) and `lat` (sideways) are in design units and scaled;
  // `len` and `h` are car-sized, so they stay as they are.
  const RAMPS = [
    { s: 1190, len: 200, h: 36, lat0: -150, lat1: 150 },  // big jump on the start straight
    { s: 6760, len: 165, h: 30, lat0: -150, lat1: -10 },  // launch out of the hairpin
    { s: 9980, len: 185, h: 34, lat0: -30, lat1: 150 },   // back-straight flyer
  ].map((r) => ({ ...r, s: sc(r.s), lat0: sc(r.lat0), lat1: sc(r.lat1) }));

  const PADS = [
    { s: 884, len: 70, lat0: -120, lat1: -20 },
    { s: 3330, len: 70, lat0: 10, lat1: 120 },     // rewards the outside line in the sweeper
    { s: 5661, len: 70, lat0: -60, lat1: 60 },
    { s: 7089, len: 70, lat0: -20, lat1: 100 },
    { s: 8740, len: 70, lat0: -120, lat1: -10 },   // corner exit
    { s: 10350, len: 70, lat0: -40, lat1: 70 },
    { s: 11560, len: 70, lat0: -130, lat1: 0 },
  ].map((p) => ({ ...p, s: sc(p.s), lat0: sc(p.lat0), lat1: sc(p.lat1) }));

  // Item boxes (rows across the track) and pedestrian zebra crossings
  const BOX_ROWS = [2700, 4620, 6300, 10300].map(sc);
  const BOX_LATS = [-90, -30, 30, 90].map(sc);
  const CROSSINGS = [4200, 8300, 10900].map(sc);
  const PEDS_PER_CROSSING = 3;   // how many people wait at each zebra crossing
  const ITEMS = ['oil', 'bomb', 'nitro', 'shield', 'missile', 'thunder'];

  // Control points of the circuit. A smooth closed curve is fitted through them.
  // Point 0 is the start/finish line. Edit these to design your own track!
  const TRACK_POINTS = [
    [1870, 2890], [3060, 2924], [4165, 2754], [4760, 2210], [4794, 1530],
    [4335, 1020], [3570, 952], [2975, 1445], [2380, 1190], [1955, 595],
    [1190, 476], [646, 850], [510, 1615], [714, 2380], [1190, 2805],
  ].map(([x, y]) => [sc(x), sc(y)]);

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) =>
      0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return { x: f(p0[0], p1[0], p2[0], p3[0]), y: f(p0[1], p1[1], p2[1], p3[1]) };
  }

  function buildTrack(ctrl, width) {
    const SAMPLES = 16;
    const n = ctrl.length;
    const points = [];
    for (let i = 0; i < n; i++) {
      const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
      for (let s = 0; s < SAMPLES; s++) points.push(catmullRom(p0, p1, p2, p3, s / SAMPLES));
    }
    const N = points.length;
    const cum = new Array(N), segLen = new Array(N);
    let length = 0;
    for (let i = 0; i < N; i++) {
      const a = points[i], b = points[(i + 1) % N];
      cum[i] = length;
      segLen[i] = Math.hypot(b.x - a.x, b.y - a.y);
      length += segLen[i];
    }
    // 4 invisible checkpoints, evenly spaced. You must pass them in order to count a lap.
    const checkpoints = [0, length / 4, length / 2, (3 * length) / 4];
    return { points, cum, segLen, length, width, checkpoints };
  }

  // Closest point on the track centerline: distance from it and how far along the lap it is (s).
  function nearestOnTrack(track, x, y) {
    const P = track.points, N = P.length;
    let best = Infinity, bi = 0, bt = 0;
    for (let i = 0; i < N; i++) {
      const a = P[i], b = P[(i + 1) % N];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * t - x, py = a.y + dy * t - y;
      const d2 = px * px + py * py;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    const a = P[bi], b = P[(bi + 1) % N];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const px = a.x + dx * bt, py = a.y + dy * bt;
    const dist = Math.sqrt(best);
    // signed sideways offset: + means right of centre (normal = (-dy, dx))
    const lat = ((x - px) * -dy + (y - py) * dx) / len;
    return { index: bi, dist, lat, px, py, s: track.cum[bi] + bt * track.segLen[bi], tx: dx / len, ty: dy / len };
  }

  function pointAtDistance(track, s) {
    const L = track.length, N = track.points.length;
    s = ((s % L) + L) % L;
    let i = N - 1;
    while (i > 0 && track.cum[i] > s) i--;
    const a = track.points[i], b = track.points[(i + 1) % N];
    const t = track.segLen[i] > 0 ? (s - track.cum[i]) / track.segLen[i] : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  // Starting grid: two columns, staggered, behind the start line.
  function gridPosition(track, slot) {
    const row = Math.floor(slot / 2), col = slot % 2;
    const p = pointAtDistance(track, -80 - row * 100 - col * 50);
    const off = track.width * 0.22 * (col === 0 ? -1 : 1);
    return newCar(p.x - Math.sin(p.angle) * off, p.y + Math.cos(p.angle) * off, p.angle);
  }

  function wrapAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function angleLerp(a, b, t) { return a + wrapAngle(b - a) * t; }

  function newCar(x, y, angle) {
    return {
      x, y, angle, speed: 0, z: 0, vz: 0, air: false, boost: 0, stun: 0,
      drift: 0,    // 0 = gripping, -1 / +1 = sliding left / right
      slip: 0,     // radians between where the car points and where it travels
      charge: 0,   // seconds of drift banked, cashed in as a mini-turbo
      bt: 0,       // boost tier (0 = pad/nitro, 1-3 = mini-turbo strength) for flames + sound
      trick: 0,    // airtime with the stunt key held
      draft: 0,    // slipstream charge, 0..1
      slow: 0,     // seconds of being dragged down (missile hit)
    };
  }
  const CAR_KEYS = ['x', 'y', 'angle', 'speed', 'z', 'vz', 'air', 'boost', 'stun',
    'drift', 'slip', 'charge', 'bt', 'trick', 'draft', 'slow'];

  // A point on the track: distance s along the lap, lat sideways (+ = right).
  function trackPos(track, s, lat) {
    const p = pointAtDistance(track, s);
    return { x: p.x - Math.sin(p.angle) * lat, y: p.y + Math.cos(p.angle) * lat, angle: p.angle };
  }
  function boxPositions(track) {
    const out = [];
    for (const s of BOX_ROWS) for (const lat of BOX_LATS) out.push(trackPos(track, s, lat));
    return out;
  }
  // distance from point P to segment AB (used so fast cars cannot "skip over" things)
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  }
  const NO_INPUT = { u: false, d: false, l: false, r: false, h: false };
  function copyCar(dst, src) { for (const k of CAR_KEYS) dst[k] = src[k]; return dst; }

  function alongDiff(track, s, s0) { const L = track.length; return ((s - s0) % L + L) % L; }

  // The ramp covering a point on the track, if any.
  function rampAt(track, near) {
    for (const r of RAMPS) {
      const d = alongDiff(track, near.s, r.s);
      if (d < r.len && near.lat >= r.lat0 && near.lat <= r.lat1) return r;
    }
    return null;
  }
  // Height of the ground (ramp surface) at a point on the track.
  function groundHeight(track, near) {
    const r = rampAt(track, near);
    return r ? (alongDiff(track, near.s, r.s) / r.len) * r.h : 0;
  }
  function onPad(track, near) {
    for (const p of PADS) {
      if (alongDiff(track, near.s, p.s) < p.len && near.lat >= p.lat0 && near.lat <= p.lat1) return true;
    }
    return false;
  }

  // Which charge tier a given amount of banked drift is worth (0 = not enough).
  function driftTier(charge) {
    const t = PHYS.DRIFT_TIERS;
    let tier = 0;
    for (let i = 0; i < t.length; i++) if (charge >= t[i]) tier = i + 1;
    return tier;
  }

  // Advance one car by one fixed step. input = { u, d, l, r, h } booleans (h = drift / stunt).
  // Returns events (used for sound effects, particles and camera shake).
  function stepCar(car, input, dt, track) {
    const ev = { wall: 0, land: 0, launch: false, boost: false, mt: 0, trick: 0, driftStart: false };
    // spun out: no control, the car slides and slows down
    const stunned = car.stun > 0;
    if (stunned) {
      car.stun = Math.max(0, car.stun - dt);
      input = NO_INPUT;
      if (!car.air) car.speed *= Math.max(0, 1 - 1.6 * dt);
      car.drift = 0; car.charge = 0; car.trick = 0;
    }
    const before = onPad(track, nearestOnTrack(track, car.x, car.y));

    // boost pads (only when touching the ground)
    if (!car.air && before) {
      if (car.boost < PHYS.BOOST_TIME - 0.25) ev.boost = true;
      car.boost = Math.max(car.boost, PHYS.BOOST_TIME);
      car.bt = 0;
    }

    // ---- drifting on the ground, stunts in the air ----
    const steer = (input.r ? 1 : 0) - (input.l ? 1 : 0);
    const holding = !!input.h && !stunned;
    if (car.air) {
      car.drift = 0;
      if (holding) car.trick += dt;      // spinning the kart for a landing boost
    } else if (car.drift) {
      if (!holding || car.speed < PHYS.DRIFT_MIN_SPEED * 0.55) {
        const tier = driftTier(car.charge);   // release: cash in the charge
        if (tier > 0) {
          car.boost = Math.max(car.boost, PHYS.MT_TIME[tier]);
          car.bt = tier;
          ev.mt = tier;
        }
        car.drift = 0;
        car.charge = 0;
      } else {
        car.charge += dt;
      }
    } else if (holding && steer && car.speed > PHYS.DRIFT_MIN_SPEED) {
      car.drift = steer;
      car.charge = 0;
      ev.driftStart = true;
    }
    const drifting = car.drift !== 0;

    // a missile hit leaves you crippled for a few seconds: no boost, much lower top speed
    const crippled = (car.slow || 0) > 0;
    if (crippled) {
      car.slow = Math.max(0, car.slow - dt);
      car.boost = 0;
      car.bt = 0;
    }
    const boosting = car.boost > 0 && !stunned;
    const max = PHYS.MAX_SPEED
      * (boosting ? PHYS.BOOST_MULT : 1)
      * (1 + PHYS.DRAFT_MULT * (car.draft || 0))
      * (drifting ? PHYS.DRIFT_DRAG : 1)
      * (crippled ? PHYS.SLOW_MULT : 1);

    if (!car.air && !stunned) {
      if (input.u && !input.d) {
        if (car.speed < 0) car.speed += PHYS.BRAKE * dt;
        else if (car.speed < max) car.speed = Math.min(max, car.speed + (boosting ? PHYS.BOOST_ACCEL : PHYS.ACCEL) * dt);
      } else if (input.d && !input.u) {
        car.speed -= (car.speed > 0 ? PHYS.BRAKE : PHYS.REVERSE_ACCEL) * dt;
      } else if (boosting && car.speed >= 0) {
        car.speed = Math.min(max, car.speed + PHYS.BOOST_ACCEL * dt);
      } else {
        const c = PHYS.COAST * dt;
        car.speed = Math.abs(car.speed) <= c ? 0 : car.speed - Math.sign(car.speed) * c;
      }
      if (car.speed > max) car.speed += (max - car.speed) * Math.min(1, 3 * dt);
      if (car.speed < PHYS.REVERSE_MAX) car.speed = PHYS.REVERSE_MAX;
    }
    if (car.boost > 0) {
      car.boost = Math.max(0, car.boost - dt);
      if (car.boost === 0) car.bt = 0;
    }
    if (car.draft > 0) car.draft = Math.max(0, car.draft - PHYS.DRAFT_DECAY * dt);

    // a little steering even when slow, so you can always turn away from a wall
    const pedal = input.u || input.d;
    const v = Math.abs(car.speed);
    let grip = Math.min(1, (v + (pedal ? 45 : 0)) / 140) * (car.air ? PHYS.AIR_STEER : 1);
    // ...but the faster you go, the wider the front end runs
    const wash = 1 - (1 - PHYS.GRIP_MIN)
      * Math.min(1, Math.max(0, (v - PHYS.GRIP_FROM) / (PHYS.MAX_SPEED - PHYS.GRIP_FROM)));
    grip *= drifting ? wash + (1 - wash) * PHYS.DRIFT_GRIP_KEEP : wash;
    if (drifting) {
      // while sliding you always turn into the drift; steering only tightens or opens it
      const mul = steer === car.drift ? PHYS.DRIFT_TURN_IN
        : steer === -car.drift ? PHYS.DRIFT_TURN_OUT : PHYS.DRIFT_TURN_MID;
      car.angle = wrapAngle(car.angle + car.drift * PHYS.TURN_RATE * mul * grip * dt);
    } else if (steer) {
      car.angle = wrapAngle(car.angle + steer * PHYS.TURN_RATE * grip * dt * (car.speed < 0 ? -1 : 1));
    }
    // the car points further into the corner than it actually travels
    const wantSlip = drifting ? -car.drift * PHYS.DRIFT_SLIP : 0;
    car.slip += (wantSlip - car.slip) * Math.min(1, PHYS.DRIFT_SLIP_RATE * dt);
    const vel = car.angle + car.slip;   // direction of travel

    const ox = car.x, oy = car.y;
    car.x += Math.cos(vel) * car.speed * dt;
    car.y += Math.sin(vel) * car.speed * dt;

    // ---- track walls: you cannot leave the track ----
    let near = nearestOnTrack(track, car.x, car.y);
    const limit = track.width / 2 + CONFIG.CURB - CONFIG.CAR_RADIUS * 0.75;
    if (near.dist > limit) {
      const outX = (car.x - near.px) / near.dist, outY = (car.y - near.py) / near.dist;
      car.x = near.px + outX * limit;
      car.y = near.py + outY * limit;
      const dir = car.speed < 0 ? -1 : 1;
      const impact = Math.max(0, (Math.cos(vel) * outX + Math.sin(vel) * outY) * dir);
      ev.wall = impact * Math.abs(car.speed);
      if (impact > 0.8 && Math.abs(car.speed) > 150) {
        car.speed = -car.speed * 0.25; // head-on crash: bounce back
      } else {
        // glancing hit: lose the speed going INTO the wall and slide along it
        car.speed *= Math.sqrt(1 - impact * impact);
        if (Math.abs(car.speed) > 220) car.speed -= Math.sign(car.speed) * 380 * dt; // scraping friction
        let tAng = Math.atan2(near.ty, near.tx);
        if (Math.cos(tAng - car.angle) < 0) tAng += Math.PI;
        if (dir > 0) car.angle = angleLerp(car.angle, wrapAngle(tAng), 0.6);
      }
      if (impact > 0.35) { car.drift = 0; car.charge = 0; car.slip *= 0.3; } // a real hit kills the drift
      near = nearestOnTrack(track, car.x, car.y);
    }

    // ---- ramps / jumping ----
    const gh = groundHeight(track, near);
    if (!car.air && gh > car.z + 6) {
      // Clipped the tall side or back of a ramp. Don't just bounce straight back:
      // that wedges the car against the edge forever (accelerate, bounce, repeat).
      // Shove it sideways off the nearest edge so it slides past instead.
      const r = rampAt(track, near);
      car.x = ox; car.y = oy;
      ev.wall = Math.abs(car.speed) * 0.6;
      if (r) {
        const out = Math.abs(near.lat - r.lat0) < Math.abs(near.lat - r.lat1) ? -1 : 1;
        const shove = (40 + Math.abs(car.speed) * 0.35) * dt * out;
        car.x += -near.ty * shove;
        car.y += near.tx * shove;
        car.speed *= 0.82;              // scrub some speed, but keep rolling
      } else {
        car.speed = -car.speed * 0.3;
      }
      car.drift = 0; car.charge = 0;
    } else if (car.air) {
      car.vz -= PHYS.GRAVITY * dt;
      car.z += car.vz * dt;
      if (car.z <= gh) {
        ev.land = -car.vz;
        car.z = gh; car.vz = 0; car.air = false;
        if (car.trick >= PHYS.TRICK_MIN) {         // stuck the landing: free boost
          ev.trick = car.trick;
          car.boost = Math.max(car.boost, PHYS.TRICK_BOOST + Math.min(0.9, car.trick * 0.5));
          car.bt = car.trick > 0.75 ? 3 : 2;
        }
        car.trick = 0;
      }
    } else if (gh < car.z - 2) {
      // ground fell away under us (end of ramp): we are flying!
      car.air = true;
      ev.launch = true;
      car.drift = 0; car.charge = 0;
      car.vz -= PHYS.GRAVITY * dt;
      car.z += car.vz * dt;
    } else {
      car.vz = (gh - car.z) / dt; // climbing the ramp gives upward speed
      car.z = gh;
    }

    // world edges (safety net)
    const r = CONFIG.CAR_RADIUS;
    car.x = Math.max(r, Math.min(CONFIG.WORLD_W - r, car.x));
    car.y = Math.max(r, Math.min(CONFIG.WORLD_H - r, car.y));
    return ev;
  }

  return {
    CONFIG, PHYS, DT, TRACK_POINTS, RAMPS, PADS, CAR_KEYS, BOX_ROWS, BOX_LATS, CROSSINGS, ITEMS,
    PEDS_PER_CROSSING,
    buildTrack, nearestOnTrack, pointAtDistance, gridPosition, groundHeight, driftTier,
    trackPos, boxPositions, segDist, alongDiff,
    newCar, copyCar, stepCar, wrapAngle, angleLerp,
  };
});
