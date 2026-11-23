// Lap Rush game server: authoritative simulation + rooms.
// Clients only send their key presses; the server decides where every car is.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const S = require('./shared/game.js');
const H = require('./hazards.js');
const B = require('./bots.js');
const { CONFIG, PHYS } = S;

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));

// ---------- reaction video clips ----------
// Drop more .mp4/.webm files into happy/ or accident/ and they are picked up on restart;
// winning.mp4 in the project root is played to the top finishers.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|opus)$/i;
function listFiles(dir, match, urlBase) {
  try {
    return fs.readdirSync(path.join(__dirname, dir))
      .filter((f) => match.test(f)).sort()
      .map((f) => urlBase + encodeURIComponent(f));
  } catch (e) {
    return []; // folder missing: that kind of reaction just never plays
  }
}
const CLIPS = {
  happy: listFiles('happy', VIDEO_EXT, '/clips/happy/'),
  accident: listFiles('accident', VIDEO_EXT, '/clips/accident/'),
  mystery: listFiles('mystry', IMAGE_EXT, '/clips/mystery/'),
  sfx: listFiles('sound effect', AUDIO_EXT, '/clips/sfx/'),
  win: fs.existsSync(path.join(__dirname, 'winning.mp4')) ? ['/clips/winning.mp4'] : [],
};
app.use('/clips/happy', express.static(path.join(__dirname, 'happy')));
app.use('/clips/accident', express.static(path.join(__dirname, 'accident')));
app.use('/clips/mystery', express.static(path.join(__dirname, 'mystry')));
app.use('/clips/sfx', express.static(path.join(__dirname, 'sound effect')));
app.get('/clips/winning.mp4', (req, res) => res.sendFile(path.join(__dirname, 'winning.mp4')));
app.get('/clips.json', (req, res) => res.json(CLIPS));

const server = http.createServer(app);
// Be patient with flaky connections. The defaults (20s ping timeout) drop players for a
// brief Wi-Fi hiccup or a backgrounded tab, which throttles the browser's timers.
// connectionStateRecovery lets a short blip resume on the SAME socket id.
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 40000,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});
const DISCONNECT_GRACE = 90000; // ms we hold a dropped player's seat and race position
// A socket can stay open long after the player has effectively gone - a frozen tab, a
// lag spike, Wi-Fi that died without closing the connection. So autopilot is decided by
// whether INPUTS are arriving, not by whether the socket is up.
const INPUT_IDLE_MS = 1500;

const TRACK = S.buildTrack(S.TRACK_POINTS, CONFIG.TRACK_WIDTH);
const COLORS = ['#e63946', '#3a86ff', '#ffbe0b', '#06d6a0', '#b14aed', '#ff7d2e', '#19d3da', '#f45bb5'];
const MAX_INPUTS_PER_TICK = 3; // stops a client from "speed hacking" by spamming inputs
const LAP_CHOICES = [1, 2, 3, 5, 8];
const rooms = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- helpers ----------
function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike chars (0/O, 1/I/L)
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += A[Math.floor(Math.random() * A.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 14);
  return n || 'Racer';
}

const racers = (room) => [...room.players.values()];
const humans = (room) => racers(room).filter((p) => !p.bot);
// Players who dropped are still "here" until their grace period runs out, so their seat,
// lap count and car stay put while they reconnect.
const liveHumans = (room) => humans(room).filter((p) => p.online !== false);
const makeToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function freeSlot(room, limit) {
  const used = new Set(racers(room).map((p) => p.slot));
  for (let i = 0; i < limit; i++) if (!used.has(i)) return i;
  return -1;
}

function resetPlayer(p, laps) {
  p.car = S.gridPosition(TRACK, p.slot);
  p.s = S.nearestOnTrack(TRACK, p.car.x, p.car.y).s;
  p.inputs = [];
  p.lap = 0;
  p.nextCp = 1;     // grid is behind the line, so the first checkpoint to hit is #1
  p.cpCount = 0;
  p.finished = false;
  p.finishTime = null;
  p.place = null;
  p.lapStart = 0;
  p.bestLap = null;
  p.item = null;
  p.shield = 0;
  p.gun = 0;
  p.gunCool = 0;
  p.score = 0;
  p.draftFired = false;
  p.laps = laps;
  p.lastInput = null;
  p.lastInputAt = 0;
  p.autoDriving = false;
}

function addPlayer(room, socket, name) {
  // Any free grid slot, not just the first four: AI racers from the previous race
  // may still be holding low slots. The human limit is enforced by the caller.
  const slot = freeSlot(room, CONFIG.MAX_RACERS);
  const p = {
    id: socket.id, name: cleanName(name), slot, color: COLORS[slot], lastSeq: 0, bot: false,
    token: makeToken(), online: true,
  };
  resetPlayer(p, room.settings.laps);
  room.players.set(socket.id, p);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  return p;
}

// Put a returning player back in the seat they left, keeping their lap, car and score.
// Hand the car back from the stand-in AI to the player who just came back.
function resume(room, p) {
  p.online = true;
  p.offAt = 0;
  p.inputs = [];
  p.lastInput = null;
  // A reloaded page starts its input sequence at 0 again, so forget the old high-water
  // mark or every input they send would be ignored as "already processed".
  p.lastSeq = 0;
  // Autopilot stays on until their inputs actually start arriving again - the tick loop
  // hands the wheel back and announces it then, not here.
  return p;
}

function reattach(room, socket, p) {
  room.players.delete(p.id);
  const oldId = p.id;
  p.id = socket.id;
  room.players.set(socket.id, p);
  if (room.hostId === oldId) room.hostId = socket.id;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  return resume(room, p);
}

// AI racers are built fresh for every race, filling the grid behind the humans.
function rebuildBots(room) {
  for (const [id, p] of room.players) if (p.bot) room.players.delete(id);
  const free = CONFIG.MAX_RACERS - room.players.size;
  const n = clamp(room.settings.bots | 0, 0, free);
  const names = B.botNames(n, humans(room).map((p) => p.name));
  const skill = B.LEVELS[room.settings.level] || B.LEVELS.normal;
  for (let i = 0; i < n; i++) {
    const slot = freeSlot(room, CONFIG.MAX_RACERS);
    if (slot < 0) break;
    const id = 'bot' + (i + 1) + ':' + room.code;
    // spread their skill a little so the field is not a single wall of identical cars
    const sk = clamp(skill + ((i % 3) - 1) * 0.1, 0.15, 1);
    const p = {
      id, name: names[i], slot, color: COLORS[slot], lastSeq: 0, bot: true,
      brain: B.makeBrain(sk, i * 13 + 5),
    };
    resetPlayer(p, room.settings.laps);
    room.players.set(id, p);
  }
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.leave(code);
  socket.data.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (humans(room).length === 0) { rooms.delete(code); return; }
  if (room.hostId === socket.id) room.hostId = humans(room)[0].id; // pass host on
}

// Clear out players who never came back, and close rooms nobody is left in.
function reapDisconnected(room, now) {
  // While a race is on, an AI is driving their car - so hold the seat until the race
  // ends no matter how long they have been gone. They can always come back to it.
  const racing = room.phase === 'racing' || room.phase === 'countdown';
  for (const [id, p] of room.players) {
    if (p.bot || p.online !== false) continue;
    if (!racing && now - (p.offAt || now) > DISCONNECT_GRACE) {
      room.players.delete(id);
      if (room.hostId === id) {
        const other = humans(room)[0];
        if (other) room.hostId = other.id;
      }
    }
  }
  if (humans(room).length === 0) { rooms.delete(room.code); return false; }
  return true;
}

function sanitizeSettings(room, data) {
  const s = room.settings;
  if (!data) return;
  const laps = Number(data.laps);
  if (LAP_CHOICES.includes(laps)) s.laps = laps;
  const bots = Number(data.bots);
  if (Number.isInteger(bots)) s.bots = clamp(bots, 0, CONFIG.MAX_RACERS - 1);
  if (B.LEVELS[data.level]) s.level = data.level;
}

// ---------- socket events ----------
io.on('connection', (socket) => {
  socket.on('createRoom', (data, ack) => {
    if (typeof ack !== 'function') return;
    leaveRoom(socket);
    const room = {
      code: makeCode(), hostId: socket.id, players: new Map(), phase: 'lobby',
      countdownEnd: 0, raceStart: 0, finishCount: 0, firstFinishAt: null, tick: 0,
      settings: { laps: CONFIG.LAPS, bots: 3, level: 'normal' },
      world: H.createWorld(TRACK),
    };
    rooms.set(room.code, room);
    const host = addPlayer(room, socket, data && data.name);
    ack({ ok: true, code: room.code, id: socket.id, token: host.token });
  });

  socket.on('joinRoom', (data, ack) => {
    if (typeof ack !== 'function') return;
    const code = String((data && data.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Room not found. Check the code.' });
    // socket.io may recover the SAME id after a blip, so this path has to do the same
    // handback work as a token rejoin - it is how most reconnections actually arrive.
    if (room.players.has(socket.id)) {
      const self = resume(room, room.players.get(socket.id));
      socket.join(room.code);
      socket.data.roomCode = room.code;
      return ack({ ok: true, code, id: socket.id, token: self.token, rejoined: true });
    }
    // Coming back after a drop? The token proves it is the same player, so give them
    // their seat back - even in the middle of a race.
    const token = data && typeof data.token === 'string' ? data.token : null;
    if (token) {
      const mine = humans(room).find((p) => p.token === token);
      if (mine) {
        leaveRoom(socket);
        reattach(room, socket, mine);
        return ack({ ok: true, code, id: socket.id, token: mine.token, rejoined: true });
      }
    }
    // Dropped players still hold their grid slot, so check for a real free seat too -
    // otherwise a newcomer could take the room past MAX_RACERS and get slot -1.
    if (liveHumans(room).length >= CONFIG.MAX_PLAYERS || freeSlot(room, CONFIG.MAX_RACERS) < 0) {
      return ack({ ok: false, error: 'That room is full.' });
    }
    if (room.phase === 'countdown' || room.phase === 'racing') {
      return ack({ ok: false, error: 'A race is in progress. Try again when it ends.' });
    }
    leaveRoom(socket);
    const p = addPlayer(room, socket, data && data.name);
    ack({ ok: true, code, id: socket.id, token: p.token });
  });

  socket.on('settings', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'finished') return;
    sanitizeSettings(room, data);
  });

  socket.on('startRace', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'finished') return;
    room.finishCount = 0;
    room.firstFinishAt = null;
    rebuildBots(room);
    for (const p of room.players.values()) resetPlayer(p, room.settings.laps);
    H.resetWorld(room.world);
    room.phase = 'countdown';
    room.countdownEnd = Date.now() + CONFIG.COUNTDOWN_MS;
  });

  socket.on('input', (msg) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'racing' || !msg) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const seq = Number(msg.seq);
    if (!Number.isFinite(seq) || seq <= p.lastSeq) return;
    p.lastInputAt = Date.now();   // proof the player is still actually there
    p.inputs.push({ seq, u: !!msg.u, d: !!msg.d, l: !!msg.l, r: !!msg.r, h: !!msg.h });
    if (p.inputs.length > 30) p.inputs.splice(0, p.inputs.length - 30);
  });

  socket.on('useItem', (msg) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'racing') return;
    const p = room.players.get(socket.id);
    if (!p || p.car.stun > 0 || p.car.flip > 0) return;
    if (p.item) H.useItem(room.world, p, !!(msg && msg.back), Date.now(), racers(room));
    else if (p.gun > 0) H.fireGun(room.world, p, racers(room));   // gun active: SPACE shoots
  });

  // ---- voice chat signalling ----
  // The server only forwards handshake messages between two players in the same room.
  // The audio itself goes peer to peer and never passes through here.
  socket.on('voiceOn', (on) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room && room.players.get(socket.id);
    if (p) p.voice = !!on;
  });

  socket.on('voice', (msg) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !msg || typeof msg.to !== 'string') return;
    const target = room.players.get(msg.to);
    if (!target || target.bot) return;                 // same room, real players only
    if (!['offer', 'answer', 'ice'].includes(msg.kind)) return;
    io.to(msg.to).emit('voice', { from: socket.id, kind: msg.kind, data: msg.data });
  });

  // A dropped player keeps their seat, car and lap count for DISCONNECT_GRACE so a
  // brief hiccup does not end their race. Only an explicit "leave" removes them at once.
  socket.on('disconnect', (reason) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room && room.players.get(socket.id);
    // Logged so you can tell WHY people drop when it happens for real:
    //   "ping timeout"    -> the server or the player's machine stalled (check LAG lines below)
    //   "transport close" -> their network went away, or they closed/backgrounded the tab
    //   "transport error" -> a proxy or connection broke mid-stream
    if (p) console.log(`[drop] ${p.name} (${socket.data.roomCode}) - ${reason}`);
    if (!p) { leaveRoom(socket); return; }
    p.online = false;
    p.offAt = Date.now();
    p.inputs = [];   // the tick loop notices the silence and hands the car to an AI
    // hand the host role to someone who is actually here, so the room is not stuck
    if (room.hostId === socket.id) {
      const other = liveHumans(room)[0];
      if (other) room.hostId = other.id;
    }
  });

  socket.on('leaveRoom', () => leaveRoom(socket));
});

// ---------- simulation ----------
function collideCars(room) {
  const list = racers(room);
  const minD = CONFIG.CAR_RADIUS * 2;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].car, b = list[j].car;
      if (Math.abs(a.z - b.z) > 14) continue; // one car is flying over the other
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < minD) {
        const push = (minD - d) / 2, nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        a.speed *= 0.92; b.speed *= 0.92;
        // a solid side-swipe knocks a drift loose
        if (Math.abs(a.speed - b.speed) > 240) { a.charge *= 0.5; b.charge *= 0.5; }
      }
    }
  }
}

// Tuck in behind someone and you get pulled along in their slipstream.
function updateDraft(room) {
  const list = racers(room);
  for (const p of list) {
    const c = p.car;
    if (p.finished || c.air || c.stun > 0 || c.speed < 200) { p.draftFired = false; continue; }
    const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
    let tucked = false;
    for (const o of list) {
      if (o === p) continue;
      const dx = o.car.x - c.x, dy = o.car.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 36 || d > PHYS.DRAFT_RANGE) continue;
      if (Math.abs(o.car.z - c.z) > 30) continue;
      if ((dx * hx + dy * hy) / d < PHYS.DRAFT_CONE) continue;   // must be right behind them
      tucked = true;
      break;
    }
    if (!tucked) { if (c.draft < 0.98) p.draftFired = false; continue; }
    // stepCar discharges every tick, so add the decay back on top of the gain
    c.draft = Math.min(1, c.draft + (PHYS.DRAFT_GAIN + PHYS.DRAFT_DECAY) * S.DT);
    if (c.draft >= 1 && !p.draftFired) {
      p.draftFired = true;
      c.boost = Math.max(c.boost, PHYS.DRAFT_BURST);
      c.bt = 1;
      p.score = (p.score || 0) + H.SCORE.draft;
      room.world.events.push({ t: 'draft', id: p.id });
    }
  }
}

// Style points for driving well (the server simulates everyone, so this covers bots too).
function scoreDriving(p, ev) {
  if (ev.mt) p.score = (p.score || 0) + H.SCORE.mt[ev.mt];
  if (ev.trick) p.score = (p.score || 0) + H.SCORE.trick;
}

function updateProgress(room, p, now) {
  const near = S.nearestOnTrack(TRACK, p.car.x, p.car.y);
  p.near = near;   // reused by the AI next tick instead of recomputing it per bot
  p.s = near.s;
  const L = TRACK.length;
  const diff = (near.s - TRACK.checkpoints[p.nextCp] + L) % L;
  if (diff < 120) { // just crossed the next checkpoint
    p.cpCount++;
    if (p.nextCp === 0) {
      p.lap++;
      const lapTime = now - p.lapStart;
      p.lapStart = now;
      if (p.bestLap === null || lapTime < p.bestLap) p.bestLap = lapTime;
      if (p.lap >= room.settings.laps) {
        p.finished = true;
        p.finishTime = now - room.raceStart;
        p.place = ++room.finishCount;
        if (!room.firstFinishAt) room.firstFinishAt = now;
      }
    }
    p.nextCp = (p.nextCp + 1) % 4;
  }
}

// Higher = further ahead in the race.
function raceProgress(p) {
  const L = TRACK.length;
  const lastCp = (p.nextCp + 3) % 4;
  let d = (p.s - TRACK.checkpoints[lastCp] + L) % L;
  if (d > L / 2) d -= L; // slightly behind the checkpoint (e.g. on the starting grid)
  return p.cpCount * (L / 4) + d;
}

// Keep the field together: a bot way out front eases off, a bot way behind pushes on.
// Human players are never slowed down - only the AI pace moves.
function rubberBand(room, bot, lead, trail) {
  const mine = raceProgress(bot);
  const gapToLead = lead - mine;
  const gapToTrail = mine - trail;
  let r = 1;
  if (gapToLead > 700) r += Math.min(0.09, (gapToLead - 700) / 9000);   // falling behind: push
  if (gapToTrail > 900) r -= Math.min(0.11, (gapToTrail - 900) / 7000); // miles ahead: ease off
  return r;
}

function broadcast(room, now) {
  const list = racers(room);
  const ranked = list.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.place - b.place;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return raceProgress(b) - raceProgress(a);
  });
  ranked.forEach((p, i) => { p.pos = i + 1; });

  io.to(room.code).emit('state', {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    laps: room.settings.laps,
    settings: room.settings,
    countdownMs: room.phase === 'countdown' ? Math.max(0, room.countdownEnd - now) : 0,
    raceTime: room.phase === 'racing' ? now - room.raceStart : 0,
    players: list.map((p) => ({
      id: p.id, name: p.name, color: p.color, bot: p.bot,
      x: p.car.x, y: p.car.y, angle: p.car.angle, speed: p.car.speed,
      z: p.car.z, vz: p.car.vz, air: p.car.air, boost: p.car.boost, stun: p.car.stun,
      drift: p.car.drift, slip: p.car.slip, charge: p.car.charge, bt: p.car.bt,
      trick: p.car.trick, draft: p.car.draft, slow: p.car.slow,
      fly: p.car.fly, flip: p.car.flip,
      item: p.item, shield: p.shield > 0, gun: p.gun > 0, score: p.score || 0,
      voice: !!p.voice, online: p.bot ? true : p.online !== false,
      lap: p.lap, pos: p.pos, finished: p.finished, finishTime: p.finishTime, place: p.place, bestLap: p.bestLap,
      lastSeq: p.lastSeq,
    })),
    world: H.snapshotWorld(room.world),
  });
}

function updateRoom(room, now) {
  if (room.phase === 'countdown' && now >= room.countdownEnd) {
    room.phase = 'racing';
    room.raceStart = now;
    // give everyone the benefit of the doubt at the green light, so nobody is put on
    // autopilot before their very first input has had time to arrive
    for (const p of room.players.values()) {
      p.inputs = [];
      p.lapStart = now;
      p.lastInput = null;
      p.autoDriving = false;
      if (!p.bot && p.online !== false) p.lastInputAt = now;
    }
  }

  H.updatePeds(room.world, S.DT); // pedestrians walk around in every phase

  if (room.phase === 'racing') {
    const list = racers(room);
    const running = list.filter((p) => !p.finished);
    let lead = -Infinity, trail = Infinity;
    for (const p of running) {
      const prog = raceProgress(p);
      if (prog > lead) lead = prog;
      if (prog < trail) trail = prog;
    }
    for (const p of list) {
      p.prevX = p.car.x; p.prevY = p.car.y;
      // An AI stands in for anyone who is not actually driving - dropped, frozen, or
      // lagging so badly no inputs are arriving. They take the wheel straight back the
      // moment their inputs resume. This is the ONLY place that decides autopilot.
      const silent = !p.bot && now - (p.lastInputAt || 0) > INPUT_IDLE_MS;
      const autopilot = p.bot || p.online === false || silent;
      if (!p.bot && !p.finished && !!p.autoDriving !== autopilot) {
        p.autoDriving = autopilot;
        room.world.events.push({ t: autopilot ? 'autopilot' : 'resumed', id: p.id, name: p.name });
      }
      if (autopilot) {
        if (p.finished) continue;
        if (!p.brain) p.brain = B.makeBrain(B.LEVELS[room.settings.level] || B.LEVELS.normal, p.slot * 13 + 5);
        const r = rubberBand(room, p, lead, trail);
        const inp = B.think(p, TRACK, room.world, list, r, S.DT);
        scoreDriving(p, S.stepCar(p.car, inp, S.DT, TRACK));
        const fire = B.wantsItem(p, TRACK, list, S.DT);
        if (fire) H.useItem(room.world, p, fire.back, now, list);
        if (p.gun > 0) H.fireGun(room.world, p, list);   // keep shooting while loaded
      } else {
        let n = 0;
        while (p.inputs.length && n < MAX_INPUTS_PER_TICK) {
          const inp = p.inputs.shift();
          scoreDriving(p, S.stepCar(p.car, inp, S.DT, TRACK));
          p.lastSeq = inp.seq;
          p.lastInput = inp;
          n++;
        }
        // Nothing arrived this tick (a dropped packet, a stutter). Keep simulating with
        // what they were last doing - otherwise the car freezes solid instead of driving.
        if (n === 0 && p.lastInput) scoreDriving(p, S.stepCar(p.car, p.lastInput, S.DT, TRACK));
      }
    }
    collideCars(room);
    updateDraft(room);
    H.updateWorld(room.world, list, now, S.DT);
    for (const p of list) if (!p.finished) updateProgress(room, p, now);

    const everyoneDone = list.every((p) => p.finished);
    const graceOver = room.firstFinishAt && now - room.firstFinishAt > CONFIG.FINISH_GRACE_MS;
    if (everyoneDone || graceOver) room.phase = 'finished';
  }

  room.tick++;
  if (room.tick % CONFIG.SNAPSHOT_EVERY === 0) broadcast(room, now);
}

// Event-loop lag watch. On a small instance (Render's free plan gives 0.1 CPU) the whole
// process can be starved, the 60Hz tick slips, heartbeats are missed and everyone drops.
// If you see LAG lines in the Render log at the same moment people disconnect, the host
// is the problem and a paid instance fixes it. Silence here means it is not the server.
let lagLast = Date.now();
let lagWorst = 0;
setInterval(() => {
  const now = Date.now();
  const lag = now - lagLast - 500;
  lagLast = now;
  if (lag > 400) {
    lagWorst = Math.max(lagWorst, lag);
    console.log(`[LAG] event loop stalled ${lag}ms (worst ${lagWorst}ms) - rooms: ${rooms.size}`);
  }
}, 500);

let reapTick = 0;
setInterval(() => {
  const now = Date.now();
  // sweep for players who never came back about once a second, not every tick
  const sweep = (reapTick = (reapTick + 1) % CONFIG.TICK_RATE) === 0;
  for (const room of [...rooms.values()]) {
    if (sweep && !reapDisconnected(room, now)) continue; // room closed, nobody left
    updateRoom(room, now);
  }
}, 1000 / CONFIG.TICK_RATE);

server.listen(PORT, () => {
  console.log('\n🏁 Lap Rush running!\n');
  console.log(`   On this computer:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`   Friends on your Wi-Fi: http://${a.address}:${PORT}`);
    }
  }
  console.log('');
});
