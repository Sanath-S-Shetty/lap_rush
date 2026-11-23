// Lap Rush browser client (3D rendering lives in scene3d.js).
// - Sends key presses to the server 60 times a second.
// - Predicts its OWN car locally (so steering and drifting feel instant), then
//   corrects against the server ("reconciliation").
// - Draws OTHER cars ~100ms in the past, smoothly blending between server
//   updates ("interpolation").
import { createScene } from './scene3d.js';
import { createSound } from './sound.js';
import { createClips } from './clips.js';
import { createVoice } from './voice.js';

(() => {
  'use strict';
  const S = window.Shared;
  const { CONFIG, DT, PHYS } = S;
  const TRACK = S.buildTrack(S.TRACK_POINTS, CONFIG.TRACK_WIDTH);
  const INTERP_DELAY = 100; // ms
  const SMOKE_RADIUS = 280; // must match hazards.js

  const socket = io();
  const $ = (id) => document.getElementById(id);
  let camMode = 'chase'; // 'chase' (behind the car) or 'hood' (cockpit view)
  const sound = createSound();
  const clips = createClips($('clip'), () => sound.muted, $('mystery'));
  const voice = createVoice(socket, () => myId, () => updateVoiceUi());
  $('muteName').textContent = sound.muted ? 'Off' : 'On';
  let lastWallSound = 0, scrapeUntil = 0, lastCount = 0, myPrevLap = 0, wrongWaySince = 0;
  let myPrevPos = 0, rollUntil = 0, stormUntil = 0;

  // ---------- state ----------
  let myId = null;
  let state = null;       // latest server snapshot
  let stateAt = 0;        // when it arrived (performance.now)
  const snaps = [];       // recent snapshots for interpolation
  let me = null;          // my predicted car
  let pending = [];       // inputs sent but not yet confirmed by server
  let seq = 0;
  const off = { x: 0, y: 0, a: 0 }; // visual smoothing after corrections
  let prevPhase = null;
  let goUntil = 0;
  let lobbyKey = '', resultsKey = '', setupKey = '';

  // ---------- input ----------
  const keys = { up: false, down: false, left: false, right: false, drift: false, fire: false };
  let lastShotAt = 0;
  const ITEM_ICON = {
    oil: '🛢️', bomb: '💣', nitro: '⚡', shield: '🛡️', missile: '🚀', thunder: '🌩️',
    smoke: '💨', fly: '✈️', gun: '🔫', flip: '🙃',
  };
  const ITEM_NAME = {
    oil: 'Oil slick', bomb: 'Bomb', nitro: 'Nitro', shield: 'Shield',
    missile: 'Homing missile', thunder: 'Thunder',
    smoke: 'Smoke bomb', fly: 'Wings', gun: 'Machine gun', flip: 'Flip bomb',
  };
  const ITEM_HINT = {
    oil: 'SPACE to drop it behind you',
    bomb: 'SPACE to lob it · S+SPACE backwards',
    nitro: 'SPACE on a straight',
    shield: 'SPACE to armour up',
    missile: 'SPACE to lock on to the car ahead',
    thunder: 'SPACE to zap everyone ahead',
    smoke: 'SPACE drops it behind you · S+SPACE throws it ahead',
    fly: 'SPACE to take off and fly over everything',
    gun: 'SPACE to load, then SPACE to shoot',
    flip: 'SPACE to flip everyone near you',
  };
  const ROLL_ICONS = Object.values(ITEM_ICON);
  // the items worth a celebration clip when you pick them up
  const BIG_ITEMS = new Set(['nitro', 'missile', 'thunder', 'shield', 'fly', 'gun', 'flip']);
  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ShiftLeft: 'drift', ShiftRight: 'drift', KeyX: 'drift',
  };
  addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    sound.init(); // browsers need a key press / click before audio can play
    if (e.code === 'Space') {
      e.preventDefault();
      keys.fire = true;   // held down: keeps the machine gun shooting (see fixedStep)
      if (!e.repeat && state && state.phase === 'racing') {
        const mine = state.players.find((p) => p.id === myId);
        if (mine && mine.item) socket.emit('useItem', { back: keys.down }); // hold S/Down to throw backwards
      }
    }
    if (e.code === 'KeyM' && !e.repeat) {
      const m = sound.toggleMute();
      $('muteName').textContent = m ? 'Off' : 'On';
      clips.setMuted(m); // the reaction clips follow the same mute key
    }
    if (e.code === 'KeyC' && !e.repeat) {
      camMode = camMode === 'chase' ? 'hood' : 'chase';
      $('camName').textContent = camMode === 'chase' ? 'Chase' : 'Cockpit';
    }
    if (e.code === 'KeyV' && !e.repeat) voice.toggle();            // join / leave voice chat
    if (e.code === 'KeyB' && !e.repeat && voice.on) voice.setTalking(!voice.talking); // mic mute
    const k = KEYMAP[e.code];
    if (k) { keys[k] = true; e.preventDefault(); }
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'Space') keys.fire = false;
    const k = KEYMAP[e.code];
    if (k) keys[k] = false;
  });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // ---------- menu ----------
  const nameInput = $('name'), codeInput = $('code');
  try { nameInput.value = localStorage.getItem('lapRushName') || ''; } catch (e) { /* storage unavailable */ }
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) codeInput.value = urlRoom.toUpperCase().slice(0, 4);

  function saveName() { try { localStorage.setItem('lapRushName', nameInput.value.trim()); } catch (e) { /* ignore */ } }
  function showError(msg) { $('error').textContent = msg; }
  function onJoined(res) {
    if (!res || !res.ok) return showError((res && res.error) || 'Could not join.');
    myId = res.id;
    session = { code: res.code, token: res.token || null };
    saveSession();
    showError('');
    setLink('');
    history.replaceState(null, '', '?room=' + res.code);
    if (document.activeElement) document.activeElement.blur();
  }

  addEventListener('pointerdown', () => sound.init());
  $('createBtn').onclick = () => { saveName(); socket.emit('createRoom', { name: nameInput.value }, onJoined); };
  $('joinBtn').onclick = () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) return showError('Enter the 4-character room code.');
    saveName();
    socket.emit('joinRoom', { name: nameInput.value, code }, onJoined);
  };
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('startBtn').onclick = () => socket.emit('startRace');
  $('againBtn').onclick = () => socket.emit('startRace');
  $('copyBtn').onclick = () => {
    const link = $('roomLink').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(() => {
        $('copyBtn').textContent = 'Copied!';
        setTimeout(() => { $('copyBtn').textContent = 'Copy invite link'; }, 1500);
      }).catch(() => {});
    }
  };

  // ---------- staying connected ----------
  // A dropped connection used to throw you back to the menu for good. Now we keep the
  // last known state on screen, and socket.io's own reconnection plus the seat the
  // server holds for us means a hiccup just costs a couple of seconds.
  let session = { code: null, token: null };
  try {
    const saved = JSON.parse(localStorage.getItem('lapRushSession') || 'null');
    if (saved && saved.code && saved.token) session = saved;
  } catch (e) { /* no stored session */ }
  function saveSession() {
    try { localStorage.setItem('lapRushSession', JSON.stringify(session)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    session = { code: null, token: null };
    try { localStorage.removeItem('lapRushSession'); } catch (e) { /* ignore */ }
  }

  function setLink(msg, bad) {
    const el = $('linkState');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('bad', !!bad);
  }

  socket.on('disconnect', () => {
    pending = [];
    setLink('Connection lost — reconnecting…', true);
  });

  socket.on('connect', () => {
    // every reconnect gets a NEW socket id, so claim our old seat with the token
    if (!session.code || !session.token) return;
    setLink('Reconnecting…', true);
    socket.emit('joinRoom', { name: nameInput.value, code: session.code, token: session.token }, (res) => {
      if (res && res.ok) {
        myId = res.id;
        if (res.token) { session.token = res.token; saveSession(); }
        // Throw away the prediction we had before the drop. While we were away an AI
        // drove our car, so anything we still had queued is meaningless - let the next
        // snapshot reset us cleanly instead of replaying stale inputs.
        me = null;
        pending = [];
        snaps.length = 0;
        off.x = off.y = off.a = 0;
        setLink('');
        showError('');
      } else {
        // the room is gone or our seat expired: back to the menu with a reason
        clearSession();
        myId = null; state = null; me = null; snaps.length = 0; prevPhase = null;
        setLink('');
        updateUI();
        showError((res && res.error) || 'Lost the room. Join again with the code.');
      }
    });
  });

  // ---------- networking ----------
  socket.on('state', (msg) => {
    if (!myId) return;
    const now = performance.now();
    state = msg;
    stateAt = now;
    snaps.push({ t: now, players: msg.players });
    while (snaps.length > 40) snaps.shift();

    const mine = msg.players.find((p) => p.id === myId);
    if (mine) reconcile(mine, msg.phase);

    if (msg.phase !== prevPhase) {
      if (msg.phase === 'racing') { goUntil = now + 900; sound.go(); }
      if (msg.phase === 'countdown') { lastCount = 0; myPrevLap = 0; myPrevPos = 0; clearPopups(); clips.hide(); clips.hideImage(); }
      // the victory clip is the top two's reward
      if (msg.phase === 'finished') {
        if (mine && mine.finished && mine.place <= 2) clips.play('win');
        else clips.hide();
      }
      prevPhase = msg.phase;
    }
    if (mine && msg.phase === 'racing' && mine.lap > myPrevLap) {
      if (mine.finished) sound.finish();
      else if (mine.lap === msg.laps - 1) sound.finalLap();
      else sound.lap();
    }
    if (mine) myPrevLap = mine.lap;
    // overtakes
    if (mine && msg.phase === 'racing' && !mine.finished && myPrevPos && mine.pos !== myPrevPos) {
      if (mine.pos < myPrevPos) { popup('OVERTAKE!', ordinal(mine.pos), 'good'); sound.overtake(); }
      else popup('PASSED', ordinal(mine.pos), 'bad');
    }
    if (mine) myPrevPos = mine.pos;
    voice.sync(msg.players);       // connect to anyone who has voice chat switched on
    if (msg.world) for (const e of msg.world.events) worldEvent(e);
    updateUI();
  });

  function reconcile(server, phase) {
    if (phase !== 'racing' || !me) {
      me = S.copyCar({}, server);
      pending = [];
      off.x = off.y = off.a = 0;
      return;
    }
    const bx = me.x, by = me.y, ba = me.angle;
    // Start from the server's truth, then replay inputs it hasn't processed yet.
    me = S.copyCar({}, server);
    pending = pending.filter((i) => i.seq > server.lastSeq);
    for (const i of pending) S.stepCar(me, i, DT, TRACK);
    // Hide the correction by easing it out over a few frames.
    off.x += bx - me.x;
    off.y += by - me.y;
    off.a += S.wrapAngle(ba - me.angle);
    if (Math.hypot(off.x, off.y) > 200) off.x = off.y = off.a = 0; // big jump: just snap
  }

  function fixedStep() {
    if (!state || state.phase !== 'racing' || !me) return;
    // Hold SPACE to keep the machine gun firing. The server enforces the real rate of
    // fire, so asking ~10x a second is plenty and costs almost nothing.
    if (keys.fire) {
      const now = performance.now();
      const mine = state.players.find((p) => p.id === myId);
      if (mine && !mine.item && mine.gun && now - lastShotAt > 100) {
        lastShotAt = now;
        socket.emit('useItem', {});
      }
    }
    const inp = { seq: ++seq, u: keys.up, d: keys.down, l: keys.left, r: keys.right, h: keys.drift };
    socket.emit('input', inp);
    pending.push(inp);
    if (pending.length > 120) pending.shift();
    handleEvents(S.stepCar(me, inp, DT, TRACK));
  }

  // ---------- popups (the "nice shot!" feedback) ----------
  const popLayer = $('popups');
  function popup(text, sub, cls) {
    const d = document.createElement('div');
    d.className = 'pop' + (cls ? ' ' + cls : '');
    d.append(el('b', '', text));
    if (sub) d.append(el('span', '', sub));
    popLayer.append(d);
    while (popLayer.children.length > 4) popLayer.firstChild.remove();
    setTimeout(() => d.remove(), 1700);
  }
  function clearPopups() { popLayer.replaceChildren(); }

  // ---------- voice chat UI ----------
  function updateVoiceUi() {
    const btn = $('voiceBtn');
    const n = voice.connected;
    btn.classList.toggle('on', voice.on);
    btn.classList.toggle('muted', voice.on && !voice.talking);
    btn.textContent = voice.on
      ? (voice.talking ? `🎙 Voice on${n ? ' · ' + n : ''}` : `🔇 Mic off${n ? ' · ' + n : ''}`)
      : '🎙 Voice off';
    $('voiceErr').textContent = voice.error || '';
    $('voiceErr').hidden = !voice.error;
  }
  $('voiceBtn').onclick = () => { if (voice.on) voice.setTalking(!voice.talking); else voice.toggle(); };
  $('voiceBtn').oncontextmenu = (e) => { e.preventDefault(); voice.stop(); };
  updateVoiceUi();

  const MT_NAME = ['', 'MINI-TURBO', 'SUPER TURBO', 'ULTRA TURBO'];

  // ---- things that happen in the world (sent by the server) ----
  let flashText = '', flashUntil = 0, flashCls = '';
  function flash(text, ms = 2200, cls = '') { flashText = text; flashUntil = performance.now() + ms; flashCls = cls; }
  function nearness(x, y) { // 1 = right here, fades with distance
    if (!me) return 0.5;
    return Math.max(0, Math.min(1, 1 - Math.hypot(x - me.x, y - me.y) / 2600));
  }
  function playerNear(id) {
    const p = state && state.players.find((q) => q.id === id);
    return p ? nearness(p.x, p.y) : 0;
  }
  function nameOf(id) {
    const p = state && state.players.find((q) => q.id === id);
    return p ? p.name : 'someone';
  }
  const ITEM_SOUND = {
    oil: 'oilDrop', bomb: 'throwBomb', nitro: 'nitro', shield: 'shield',
    missile: 'launchMissile', thunder: 'thunder',
    smoke: 'smokePop', fly: 'takeoff', gun: 'gunLoad', flip: 'shockwave',
  };
  // these already make their own noise from a world event, so don't double up
  const SILENT_ON_USE = new Set(['thunder', 'flip']);
  function worldEvent(e) {
    const mine = e.id === myId;
    const byMe = e.by === myId;
    switch (e.t) {
      case 'boom': {
        view.explode(e.x, e.y);
        const k = nearness(e.x, e.y);
        sound.boom(Math.max(0.15, k));
        view.shake(9 * k);
        break;
      }
      case 'bomb':
        if (mine) { flash('💥 BOMBED! You got blown up', 2200, 'warn'); }
        else if (byMe) popup('DIRECT HIT!', nameOf(e.id), 'good');
        break;
      case 'missile':
        if (mine) {
          flash('🚀 MISSILE! Hit and slowed right down', 2400, 'warn');
          view.shake(6);
          clips.play('accident');
        } else if (byMe) popup('MISSILE HIT!', nameOf(e.id), 'good');
        break;
      case 'thunder':
        if (mine) {
          flash('🌩️ ZAPPED! Thunder struck you', 2200, 'warn');
          view.shake(7);
          clips.playNamed('aaagg');   // the scream is reserved for exactly this
        } else if (byMe) popup('ZAPPED THEM!', nameOf(e.id), 'good');
        break;
      case 'shot':
        if (mine) { flash('🔫 Taking fire!', 1200, 'warn'); view.shake(2.5); }
        else if (byMe) popup('HIT!', nameOf(e.id), 'good');
        break;
      case 'gunfire':
        view.tracer(e.x, e.y, e.tx, e.ty);
        sound.gunshot(e.id === myId ? 1 : playerNear(e.id) * 0.7);
        break;
      case 'shockwave': {
        view.shockwave(e.x, e.y);
        const k = e.id === myId ? 1 : nearness(e.x, e.y);
        sound.shockwave(Math.max(0.2, k));
        view.shake(8 * k);
        if (mine) popup('FLIP BOMB!', (e.hits || []).length + ' flipped', 'good');
        break;
      }
      case 'flip':
        if (mine) { flash('🙃 FLIPPED! You landed on your roof', 2600, 'warn'); clips.play('accident'); }
        break;
      case 'storm': {
        const hits = (e.hits || []).length;
        sound.thunder();
        for (const id of e.hits || []) {
          const p = state && state.players.find((q) => q.id === id);
          if (p) view.bolt(p.x, p.y);
        }
        stormUntil = performance.now() + 400;
        if (mine) popup('⚡ THUNDER', hits ? 'struck ' + hits : 'nobody ahead', 'good');
        break;
      }
      case 'oil':
        if (mine) { flash('🛢️ You slipped on oil!', 2000, 'warn'); sound.slip(1); }
        else { sound.slip(playerNear(e.id) * 0.6); if (byMe) popup('OIL SLICK!', nameOf(e.id), 'good'); }
        break;
      case 'ped':
        if (mine) {
          flash('🚶 You hit a pedestrian! Penalty: stopped & item lost', 2800, 'warn');
          sound.pedHit(); sound.penalty(); view.shake(5);
          popup('PEDESTRIAN!', '-120', 'bad');
          clips.play('accident');
        }
        break;
      case 'pedfall': if (!me || nearness(e.x, e.y) > 0.8) sound.pedHit(); break;
      case 'block':
        if (mine) { flash('🛡️ Your shield blocked it!', 1800); popup('BLOCKED!', 'shield used up', 'good'); }
        sound.block();
        break;
      case 'pickup':
        if (mine) {
          sound.pickup();
          rollUntil = performance.now() + 450;
          flash(`${ITEM_ICON[e.item]} ${ITEM_NAME[e.item]} — ${ITEM_HINT[e.item]}`, 2000);
          // celebrate the powerful ones (the clip has its own cooldown)
          if (BIG_ITEMS.has(e.item)) clips.play('happy');
        }
        break;
      case 'mystery':
        // an empty box: you get a meme at the top of the screen and nothing else
        if (mine) {
          clips.showImage();                        // plays one of the meme sound effects
          if (!clips.has('sfx')) sound.mystery();   // fall back to the synth wah-wah
          popup('MYSTERY BOX', 'no power-up', 'bad');
        }
        break;
      case 'autopilot':
        // somebody dropped: an AI is driving their car until they get back
        if (!mine) popup('AI TOOK OVER', e.name + ' dropped', 'bad');
        break;
      case 'resumed':
        if (mine) flash('🎮 You are back — you have the wheel again', 2600);
        else popup('BACK IN', e.name + ' reconnected', 'good');
        break;
      case 'lock': if (mine && e.on) popup('LOCKED ON', nameOf(e.on), 'good'); break;
      case 'draft': if (mine) { popup('SLIPSTREAM!', '+70', 'good'); sound.draft(); } break;
      case 'fizzle': if (nearness(e.x, e.y) > 0.4) sound.fizzle(); break;
      case 'use':
        if (mine && !SILENT_ON_USE.has(e.item)) sound[ITEM_SOUND[e.item]]();
        else if (e.item === 'bomb' && playerNear(e.id) > 0.3) sound.throwBomb();
        else if (e.item === 'missile' && playerNear(e.id) > 0.2) sound.launchMissile();
        else if (e.item === 'smoke' && playerNear(e.id) > 0.3) sound.smokePop();
        break;
      default: break;
    }
  }

  // Sound + camera shake + popups for things that happen to MY car.
  // These come from local prediction, so the feedback is instant.
  function handleEvents(ev) {
    const now = performance.now();
    if (ev.wall > 60) {
      scrapeUntil = now + 150;
      if (ev.wall > 140 && now - lastWallSound > 250) {
        lastWallSound = now;
        sound.wall(ev.wall);
        view.shake(Math.min(7, ev.wall / 70));
      }
    }
    if (ev.launch) sound.launch();
    if (ev.land > 40) { sound.land(ev.land); view.shake(Math.min(9, ev.land / 25)); }
    if (ev.boost) sound.boost();
    if (ev.driftStart) sound.driftStart();
    if (ev.mt) {
      sound.miniTurbo(ev.mt);
      view.shake(2 + ev.mt);
      popup(MT_NAME[ev.mt] + '!', '+' + [0, 60, 130, 240][ev.mt], 'tier' + ev.mt);
    }
    if (ev.trick) {
      sound.trick();
      popup('STUNT!', '+160', 'good');
    }
  }

  // ---------- UI ----------
  function ordinal(n) {
    if (!n) return '-';
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function fmtTime(ms) {
    ms = Math.max(0, Math.floor(ms));
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    return `${m}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function dot(color) { const d = el('span', 'dot'); d.style.background = color; return d; }

  function updateUI() {
    const phase = state ? state.phase : null;
    $('menu').hidden = !!state;
    $('lobby').hidden = phase !== 'lobby';
    $('hud').hidden = !(phase === 'countdown' || phase === 'racing');
    $('results').hidden = phase !== 'finished';
    if (phase !== 'countdown' && phase !== 'racing') { $('countdown').hidden = true; $('banner').hidden = true; }
    if (phase === 'lobby') renderLobby();
    if (phase === 'finished') renderResults();
  }

  // ---- race setup (host picks laps / AI racers / AI skill) ----
  const SETUP = [
    { key: 'laps', label: 'Laps', values: [1, 2, 3, 5, 8], text: (v) => v },
    { key: 'bots', label: 'AI racers', values: [0, 1, 2, 3, 4, 5, 6, 7], text: (v) => v },
    { key: 'level', label: 'AI skill', values: ['easy', 'normal', 'hard'], text: (v) => v[0].toUpperCase() + v.slice(1) },
  ];
  function renderSetup(where, isHost) {
    const s = state.settings || {};
    const key = JSON.stringify([where, isHost, s]);
    if (key === setupKey) return;
    setupKey = key;
    const box = $(where);
    box.replaceChildren();
    for (const row of SETUP) {
      const line = el('div', 'opt');
      line.append(el('span', 'optName', row.label));
      const seg = el('div', 'seg');
      for (const v of row.values) {
        const b = el('button', 'segBtn' + (s[row.key] === v ? ' on' : ''), String(row.text(v)));
        b.disabled = !isHost;
        b.onclick = () => socket.emit('settings', { [row.key]: v });
        seg.append(b);
      }
      line.append(seg);
      box.append(line);
    }
  }

  function renderLobby() {
    const isHost = state.hostId === myId;
    const key = JSON.stringify([state.code, state.hostId, state.players.map((p) => [p.id, p.name, p.voice, p.online]), state.settings]);
    if (key !== lobbyKey) {
      lobbyKey = key;
      $('roomCode').textContent = state.code;
      $('roomLink').textContent = `${location.origin}/?room=${state.code}`;
      $('slots').textContent = `${state.players.filter((p) => !p.bot).length} / ${CONFIG.MAX_PLAYERS} racers`;
      const ul = $('playerList');
      ul.replaceChildren();
      for (const p of state.players) {
        const li = el('li');
        li.append(dot(p.color), el('span', '', p.name + (p.id === myId ? ' (you)' : '')));
        if (p.online === false) li.append(el('span', 'offTag', 'AI driving'));
        if (p.voice) li.append(el('span', 'micTag', '🎙'));
        if (p.id === state.hostId) li.append(el('span', 'tag', 'HOST'));
        ul.append(li);
      }
      $('startBtn').hidden = !isHost;
      $('startBtn').textContent = 'Start race';
      $('waitHost').hidden = isHost;
    }
    renderSetup('setup', isHost);
  }

  function renderResults() {
    const sorted = state.players.slice().sort((a, b) => a.pos - b.pos);
    // The race setup must redraw whenever the settings change, so it lives OUTSIDE the
    // "nothing changed" guard below - that guard only covers the finishing times, and
    // keeping the setup inside it made the buttons look dead between races.
    renderSetup('setup2', state.hostId === myId);
    const key = JSON.stringify([state.hostId, sorted.map((p) => [p.id, p.name, p.finishTime, p.bestLap, p.score])]);
    if (key === resultsKey) return;
    resultsKey = key;
    const body = $('resultRows');
    body.replaceChildren();
    for (const p of sorted) {
      const tr = el('tr');
      if (p.id === myId) tr.className = 'mine';
      const nameTd = el('td');
      nameTd.append(dot(p.color), document.createTextNode(p.name + (p.id === myId ? ' (you)' : '')));
      if (p.bot) nameTd.append(el('span', 'tag', 'AI'));
      tr.append(
        el('td', 'place', p.finished ? ordinal(p.place) : '-'),
        nameTd,
        el('td', 'time', p.finished ? fmtTime(p.finishTime) : 'DNF'),
        el('td', 'time best', p.bestLap ? 'best ' + fmtTime(p.bestLap) : ''),
        el('td', 'score', (p.score || 0) + ' pts'),
      );
      body.append(tr);
    }
    const best = sorted.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    $('styleKing').textContent = best && best.score ? `✨ Most stylish: ${best.name} (${best.score} pts)` : '';
    const isHost = state.hostId === myId;
    $('againBtn').hidden = !isHost;
    $('waitHost2').hidden = isHost;
  }

  function updateHud(now) {
    if (!state || !(state.phase === 'countdown' || state.phase === 'racing')) return;
    const mine = state.players.find((p) => p.id === myId);
    if (!mine) return;
    $('hudLap').textContent = `${Math.min(mine.lap + 1, state.laps)}/${state.laps}`;
    $('hudPos').textContent = `${ordinal(mine.pos)}/${state.players.length}`;
    let t = 0;
    if (state.phase === 'racing') t = mine.finished ? mine.finishTime : state.raceTime + (now - stateAt);
    $('hudTime').textContent = fmtTime(t);
    $('hudSpeed').textContent = Math.round(Math.abs(me ? me.speed : 0) * 0.36);
    $('hudScore').textContent = mine.score || 0;
    const boosting = !!(me && me.boost > 0);
    $('speedStat').classList.toggle('boosting', boosting);

    // drift charge meter
    const charge = me ? me.charge || 0 : 0;
    const tier = S.driftTier(charge);
    const full = PHYS.DRIFT_TIERS[PHYS.DRIFT_TIERS.length - 1];
    const bar = $('driftBar');
    const on = !!(me && (me.drift || charge > 0 || (me.trick || 0) > 0));
    const cls = 'meter' + (on ? ' on' : '') + ' t' + tier;
    if (bar.className !== cls) bar.className = cls;
    $('driftFill').style.width = Math.min(100, (charge / full) * 100) + '%';
    $('driftLabel').textContent = me && me.air
      ? (me.trick > 0 ? 'STUNT!' : 'SHIFT = stunt')
      : tier > 0 ? MT_NAME[tier] + ' ready' : me && me.drift ? 'Charging…' : 'SHIFT = drift';

    // caught in a smoke cloud: the screen fogs over the deeper in you are
    let fog = 0;
    if (me && state.world && state.world.smokes) {
      for (const [, sx, sy, age] of state.world.smokes) {
        const d = Math.hypot(sx - me.x, sy - me.y);
        if (d > SMOKE_RADIUS) continue;
        const fade = age > 0.8 ? (1 - age) / 0.2 : 1;           // thins out as it clears
        fog = Math.max(fog, (1 - d / SMOKE_RADIUS) * fade);
      }
      if (me.fly > 0) fog *= 0.15;                              // you are above it
    }
    $('smokefx').style.opacity = (Math.min(1, fog * 1.5)).toFixed(2);

    // speed streaks + boost glow
    const sp = me ? Math.abs(me.speed) / PHYS.MAX_SPEED : 0;
    const fx = Math.max(0, Math.min(1, (sp - 0.72) / 0.45)) * (boosting ? 1 : 0.5);
    const fxEl = $('speedfx');
    fxEl.style.opacity = fx.toFixed(2);
    fxEl.classList.toggle('boost', boosting);
    $('stormfx').style.opacity = now < stormUntil ? '1' : '0';

    const cd = $('countdown'), banner = $('banner');
    if (state.phase === 'countdown') {
      cd.hidden = false;
      const n = Math.max(1, Math.ceil((state.countdownMs - (now - stateAt)) / 1000));
      if (n !== lastCount) { lastCount = n; sound.beep(); }
      cd.textContent = n;
    } else if (now < goUntil) {
      cd.hidden = false;
      cd.textContent = 'GO!';
    } else {
      cd.hidden = true;
    }
    // wrong-way detection
    let wrongWay = false;
    if (state.phase === 'racing' && me && !mine.finished && Math.abs(me.speed) > 60) {
      const near = S.nearestOnTrack(TRACK, me.x, me.y);
      const dir = me.speed > 0 ? 1 : -1;
      const dot = (Math.cos(me.angle) * near.tx + Math.sin(me.angle) * near.ty) * dir;
      if (dot < -0.4) { if (!wrongWaySince) wrongWaySince = now; } else wrongWaySince = 0;
      wrongWay = wrongWaySince && now - wrongWaySince > 800;
    } else wrongWaySince = 0;

    const flashing = now < flashUntil;
    banner.classList.toggle('warn', flashing ? flashCls === 'warn' : !!wrongWay);
    // item slot (the gun takes it over while you still have ammo)
    const slot = $('itemSlot');
    const item = mine.item;
    const rolling = now < rollUntil;
    const armed = !item && mine.gun;
    slot.classList.toggle('empty', !item && !armed);
    slot.classList.toggle('armed', !!armed);
    slot.classList.toggle('rolling', rolling);
    $('itemIcon').textContent = rolling
      ? ROLL_ICONS[Math.floor(now / 60) % ROLL_ICONS.length]
      : item ? ITEM_ICON[item] : armed ? '🔫' : '';
    $('itemName').textContent = item ? ITEM_NAME[item] : armed ? 'SHOOT!' : 'No item';
    if (mine.finished) {
      banner.hidden = false;
      banner.textContent = `🏁 You finished ${ordinal(mine.place)}! Waiting for the others…`;
    } else if (flashing) {
      banner.hidden = false;
      banner.textContent = flashText;
    } else if (wrongWay) {
      banner.hidden = false;
      banner.textContent = '⚠ WRONG WAY! Turn around';
    } else if (state.phase === 'racing' && mine.lap === state.laps - 1 && state.laps > 1) {
      banner.hidden = false;
      banner.textContent = 'Final lap!';
    } else {
      banner.hidden = true;
    }
  }

  // ---------- rendering (3D view + 2D minimap) ----------
  const view = createScene($('game'), S, TRACK);
  const mm = $('minimap');
  const mmCtx = mm.getContext('2d');
  const trackPath = new Path2D();
  TRACK.points.forEach((p, i) => (i ? trackPath.lineTo(p.x, p.y) : trackPath.moveTo(p.x, p.y)));
  trackPath.closePath();

  let lastW = 0, lastH = 0;
  function handleResize() {
    if (innerWidth === lastW && innerHeight === lastH) return;
    lastW = innerWidth; lastH = innerHeight;
    view.resize(lastW, lastH);
  }

  function interpolatedPlayers(now) {
    if (!snaps.length) return [];
    const rt = now - INTERP_DELAY;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
    }
    if (!a) return snaps[0].players;
    const t = b === a ? 0 : Math.min(1, (rt - a.t) / (b.t - a.t));
    return b.players.map((pb) => {
      const pa = a.players.find((p) => p.id === pb.id);
      if (!pa || Math.hypot(pb.x - pa.x, pb.y - pa.y) > 300) return pb; // new player or teleport
      return {
        ...pb,
        x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: pa.z + (pb.z - pa.z) * t,
        angle: S.angleLerp(pa.angle, pb.angle, t),
      };
    });
  }

  function drawMinimap(list) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = mm.clientWidth, cssH = mm.clientHeight;
    if (mm.width !== Math.round(cssW * dpr)) { mm.width = Math.round(cssW * dpr); mm.height = Math.round(cssH * dpr); }
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mmCtx.clearRect(0, 0, cssW, cssH);
    const pad = 10;
    const scale = Math.min((cssW - pad * 2) / CONFIG.WORLD_W, (cssH - pad * 2) / CONFIG.WORLD_H);
    mmCtx.save();
    mmCtx.translate(pad, pad);
    mmCtx.scale(scale, scale);
    mmCtx.lineJoin = 'round';
    mmCtx.lineWidth = 90;
    mmCtx.strokeStyle = 'rgba(220,226,234,0.9)';
    mmCtx.stroke(trackPath);
    // live missiles show up as orange darts so you know to look behind you
    if (state && state.world) {
      mmCtx.fillStyle = '#ff7d2e';
      for (const [, x, y] of state.world.missiles || []) {
        mmCtx.beginPath(); mmCtx.arc(x, y, 50, 0, Math.PI * 2); mmCtx.fill();
      }
    }
    for (const p of list) {
      const isMe = p.id === myId;
      mmCtx.beginPath();
      mmCtx.arc(p.x, p.y, isMe ? 80 : 60, 0, Math.PI * 2);
      mmCtx.fillStyle = p.color;
      mmCtx.fill();
      if (isMe) { mmCtx.lineWidth = 28; mmCtx.strokeStyle = '#fff'; mmCtx.stroke(); }
    }
    mmCtx.restore();
  }

  function render(now, dt) {
    handleResize();
    const racingView = !!(state && state.phase !== 'lobby' && me);
    const list = interpolatedPlayers(now).map((p) =>
      p.id === myId && me ? { ...p, ...me, x: me.x + off.x, y: me.y + off.y, angle: me.angle + off.a } : p);

    view.render({
      list,
      myId,
      mode: racingView ? camMode : 'overview',
      focus: racingView ? {
        x: me.x + off.x, y: me.y + off.y, z: me.z, angle: me.angle + off.a,
        speed: me.speed, boost: me.boost, drift: me.drift,
      } : null,
      dt,
      now,
      world: state && state.world,
    });

    mm.hidden = !racingView;
    $('camHint').hidden = !racingView;
    $('itemSlot').hidden = !(racingView && state.phase === 'racing');
    $('driftBar').hidden = !(racingView && state.phase === 'racing');
    if (!racingView) { $('speedfx').style.opacity = '0'; $('stormfx').style.opacity = '0'; }
    const driving = !!(racingView && state.phase === 'racing');
    sound.update({
      active: racingView,
      speed: me ? me.speed : 0,
      maxSpeed: S.PHYS.MAX_SPEED,
      throttle: driving && keys.up,
      boost: !!(me && me.boost > 0),
      air: !!(me && me.air),
      sliding: now < scrapeUntil || !!(me && (me.stun > 0 || me.drift)),
      drifting: !!(me && me.drift && !me.air),
      charge: me ? S.driftTier(me.charge || 0) : 0,
    });
    if (voice.on) {
      const bar = $('voiceMeter').firstElementChild;
      bar.style.width = Math.min(100, voice.micLevel() * 220) + '%';
    }
    if (racingView) drawMinimap(list);
    updateHud(now);
  }

  // read-only peek at game state from the browser console (handy for debugging)
  // `socket` is here so you can simulate a dropped connection while testing:
  //   lapRushDebug().socket.io.engine.close()
  window.lapRushDebug = () => ({ state, me, myId, view, off, keys, clips, sound, voice, socket, session });

  // ---------- main loop ----------
  let last = performance.now(), acc = 0;
  function frame(now) {
    const frameDt = Math.min(0.25, (now - last) / 1000);
    last = now;
    acc += frameDt;
    while (acc >= DT) { acc -= DT; fixedStep(); }
    const decay = Math.exp(-frameDt * 12);
    off.x *= decay; off.y *= decay; off.a *= decay;
    render(now, frameDt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
