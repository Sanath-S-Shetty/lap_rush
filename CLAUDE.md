# Lap Rush: project context for Claude Code

A 3D multiplayer browser racing game (kart-style) for 1–4 friends plus AI racers. The owner is building it to
play with friends, and as a portfolio project. It was started in a Claude chat session; this file carries over
the context.

## Run / test
- `npm install` then `npm start` → http://localhost:3000 (server prints LAN URLs for friends on the same Wi-Fi).
- `npm run test:bots` (with the server running) → two scripted clients + AI racers run a race using items;
  prints every event. `LAPS=1 AI=5 npm run test:bots` to vary the grid. Use it after any physics/server change.
- To check physics quickly without a server, run `stepCar` in a Node loop (see `tools/bot-race.js` for the autopilot).
  A good sanity check: a tidy drifting lap should beat a flat-out lap by roughly 1.5s, and a sloppy drifting lap
  (one that clips walls) should be *slower* than flat out. If that ordering breaks, the drift tuning is wrong.
- In the browser console, `window.lapRushDebug()` returns `{ state, me, myId, view, off, keys }`; `view._debug`
  exposes the Three.js `{ scene, camera, renderer }`. Mutating `keys` drives the car, which makes it easy to
  script an autopilot for testing.

## Architecture (keep these rules)
- **Server-authoritative.** Clients send only inputs (`input` = `{seq,u,d,l,r,h}` at 60 Hz) and `useItem`. The server
  simulates at 60 Hz and broadcasts a `state` snapshot at 20 Hz. Never trust client positions. `h` = drift / stunt.
- **`shared/game.js` runs on both server and browser** (UMD). Car physics (`stepCar`) must stay deterministic and
  identical on both sides, because the client predicts its own car with it. No `Math.random()` in `stepCar`.
- **Client prediction + reconciliation:** on each snapshot the client resets its car to the server state, replays
  un-acked inputs (`lastSeq`), and eases the difference out via the `off` offset. Other cars are interpolated ~100 ms in the past.
- Car state fields are listed in `CAR_KEYS` (x, y, angle, speed, z, vz, air, boost, stun, drift, slip, charge, bt,
  trick, draft). If you add a field the server changes, add it to `CAR_KEYS` **and** to the snapshot in `server.js`,
  or prediction will drift.
- Game logic is 2D (x, y). The 3D renderer maps game (x, y) → Three.js (x, height, y). Positions along the track use
  `s` (distance along the lap) and `lat` (sideways; + = right of the centre line). Helpers: `trackPos`, `nearestOnTrack`.
- **AI racers run through the same `stepCar`** as humans — `bots.js` only produces key presses. Never give bots a
  physics shortcut; if they need to be faster or slower, change their target speed (`rubberBand` in `server.js`).

## Files
- `server.js`: rooms (4-letter codes), room settings (laps / AI count / AI skill), lobby/countdown/racing/finished
  phases, tick loop, laps/checkpoints, ranking, slipstream, style scoring, snapshots.
- `bots.js`: the AI drivers — racing line and apex seeking, corner braking, drifting, hazard dodging, item tactics.
- `hazards.js`: server-side pedestrians, item boxes, oil slicks, bombs, homing missiles, thunder, nitro, shields,
  penalties, and the `SCORE` table for style points.
- `shared/game.js`: CONFIG, PHYS, track definition (`TRACK_POINTS` Catmull-Rom loop), RAMPS, PADS, BOX_ROWS/LATS,
  CROSSINGS, walls, jumps, boost, stun, **drift/mini-turbo/air-stunt/slipstream physics**.
- `public/client.js`: networking, input, prediction, HUD/lobby/results UI, popups, events → sounds/banners, minimap.
- `public/scene3d.js`: Three.js world (track ribbons, walls, ramps, pads, crossings, trees, grandstand, mountains, sky),
  cars (spinning wheels, steering, drift lean, barrel rolls, tinted turbo flames, shield, spin-out), a two-system
  GPU particle engine (`makeParticles`: tyre smoke + additive sparks), missiles, thunder bolts, explosions, cameras.
- `public/sound.js`: all sound synthesized with Web Audio (engine with gear shifts, drift squeal, charge tone, effects).
- `public/clips.js`: the reaction-video overlay (picture-in-picture) with its cooldowns, randomising and prefetch.
- `happy/`, `accident/`, `mystry/`, `sound effect/`, `winning.mp4`: the owner's reaction media (`mystry` is
  their spelling and `sound effect` has a space - keep both folder names). The server scans the folders at
  startup and publishes the list at `/clips.json`; dropping more videos, images or `.mp3`s in needs no code
  change, just a restart. Filenames may contain spaces - they are URL-encoded in the manifest.
- Three.js is served from `node_modules/three/build` at `/vendor/three/` via an import map (no bundler).

## Gameplay as built
Host picks 1/2/3/5/8 laps, 0–7 AI racers and AI skill (easy/normal/hard). Up to **8 human players**
(`MAX_PLAYERS`) and 8 cars on the grid total (`MAX_RACERS`), so AI only fill the seats humans leave.

**Voice chat** (`public/voice.js`): a WebRTC mesh, `V` to join, `B` to mute your mic. The server only
relays offer/answer/ice between two players **in the same room** (`socket.on('voice')`) - audio never
touches it. `p.voice` rides in the snapshot so clients know who to connect to; the lower socket id makes
the offer so both sides don't call at once. **It needs a secure origin**: the Render https URL or
localhost. On a plain `http://192.168.x.x` LAN address the browser blocks the microphone, and `voice.js`
says so rather than failing silently. There is no TURN server, so a few strict NATs will not connect.

**Track size.** The circuit is drawn in design units and multiplied by `CONFIG.SCALE` (currently 1.3) in
`shared/game.js`: track points, world size, road width and every `s`/`lat` feature position scale together,
so changing that one number resizes everything. Lap length is ~15,500 and the road is 338 wide.

**Item boxes are a gamble.** Each row has `S.BOX_LATS.length` (4) boxes but only `ITEM_BOXES_PER_ROW` (2) of
them hold a power-up — see `rollRow()` in `hazards.js`. The rest are mystery boxes: they pop one of the
`mystry/` pictures on screen and give nothing. Which two are live is re-rolled every time the row respawns,
and it is **never sent to the client**, so the boxes look identical and you cannot learn the pattern.

**Reactions.** The owner's media plays on big moments, stacked top-centre in `#reactions` (deliberately large
and central — a corner box "isn't getting the attention"): `happy/` videos on picking up a strong item
(nitro / missile / thunder / shield), `accident/` videos when you hit a pedestrian or take a missile,
`mystry/` images on an empty box, and `winning.mp4` for the top two finishers. Randomised without repeating
the last one, with per-kind cooldowns, and they follow the `M` mute key. `body.reacting` pushes the race
banner clear while anything is on the stack.

A `mystry/` picture is paired with a random meme sound from `sound effect/` (`playSfx()` in `clips.js`), and
the picture **stays up for as long as its sound runs**, clamped to 2.8-6s. The two lists are independent, so
the pairing is different every time. With no sound files present it falls back to the synthesized
`sound.mystery()` wah-wah.

`RESERVED_SFX` in `clips.js` keeps named sounds out of that random pool so they only ever mean one thing:
**`aaagg.mp3` plays only when thunder strikes you** (`clips.playNamed('aaagg')`). Add to that list to
reserve more. The mystery picture sits down the **left-hand side** (`#mystery`, left 16px / top 96px), not
centred - centred it blocked the road ahead.

**Driving.** Grip washes out with speed (`GRIP_FROM`/`GRIP_MIN`), so you cannot just hold the throttle through
everything. Hold `SHIFT` + steer to **drift**: the car slides (`slip`), turns harder, and banks `charge`. Release
for a **mini-turbo** — three tiers (blue / orange / purple) worth 0.8 / 1.35 / 2.1s of boost. Hold `SHIFT` in the
air for a **stunt** (barrel roll) that pays a boost on landing. Tuck in behind a car for a **slipstream** that
charges to a speed burst. A wall hit above a glancing angle kills the drift and its charge.

**Items** (`? boxes`, weighted by position — leaders get defensive, the back of the field gets attacking).
Ten of them, listed in `S.ITEMS` and rolled by `pickItem()` in `hazards.js`:
- **oil**, **bomb**, **nitro**, **shield** — the originals.
- **missile**: rides the centre line so it follows the track round corners; locks the *nearest* rival ahead,
  falling back to the nearest car anywhere, and leaves the victim on `slow` for 3s at half top speed.
- **thunder**: strikes everyone ahead of you. Victims hear the reserved `aaagg.mp3`.
- **smoke**: a blinding cloud that **falls behind you** by default (`S+SPACE` lobs it forward instead) -
  it is a defensive item, meant to blind the chase. Anyone inside gets a white screen
  (`#smokefx`, scaled by how deep in they are); bots inside lose their line and ease off too. Flying over
  it only fogs you 15%.
- **fly**: `car.fly` seconds airborne at `FLY_HEIGHT`. Everything on the ground already checks the car's
  height, so being up there makes you immune to oil, pedestrians, bombs and boxes for free. You keep full
  steering while flying (not `AIR_STEER`).
- **gun**: sets `pl.gun` seconds of ammo; while it is live, SPACE **fires** instead of using an item
  (`fireGun()`), auto-aiming at the nearest car in a forward cone. Shots chip speed and apply `slow`
  rather than spinning anyone out, because it fires three times a second. **Hold** SPACE to keep
  shooting - `fixedStep` re-sends a fire request ~10x/s and the server's `gunCool` sets the real rate.
  The client's SPACE handler must check `mine.item || mine.gun`: it originally only sent `useItem`
  when an item was held, and since activating the gun clears your item, the gun loaded and then
  did nothing at all. Bots were unaffected (the server calls `fireGun` for them directly), which is
  exactly why bot tests missed it - **test items through the keyboard path, not just via bots**.
- **flip**: everyone within `FLIP_RADIUS` lands on their roof (`car.flip`), which the renderer shows by
  rolling the body to π.

**Style points** for mini-turbos, stunts, slipstreams and landing hits; -120 for hitting a pedestrian. Shown live
in the HUD and ranked on the results screen.

3 zebra crossings with 9 pedestrians (`PEDS_PER_CROSSING`; hitting one: spin-out, stop, lose your item), 3 jump
ramps, 7 boost pads, 4 rows of 4 item boxes (2 live, 2 mystery), walls both sides. Controls: WASD/arrows, `SHIFT` (or `X`) =
drift/stunt, `SPACE` = item (S+Space = bomb backwards), `C` = chase/cockpit camera, `M` = mute.

Clipping the *side* of a ramp shoves the car sideways off the edge rather than bouncing it straight back —
the old bounce let a car wedge against the edge and accelerate-bounce forever without ever getting free.

Controls: WASD/arrows, `SHIFT`/`X` drift & stunt, `SPACE` item (or shoot while the gun is loaded; `S+SPACE`
throws backwards), `C` camera, `M` mute, `V` voice chat, `B` mic mute.

## History of requests (in order)
1. Multiplayer browser game → racing for 2–3 friends. 2. Better graphics + a driver's-eye (chase) camera → Three.js 3D.
3. Sounds, can't leave the track, ramps, more fun → walls, jumps, boost pads. 4. "Sounds really bad", bigger/wider track,
pedestrians with a penalty, oil slicks, bombs and other powers. 5. "Too boring, make it more interesting and fun" →
drift + mini-turbo, air stunts, slipstream, AI opponents, missiles and thunder, style scoring, popups, particle FX,
race setup options. 6. "Screen hangs on special features, track too small, too many pedestrians, missiles should
hit the nearest opponent and slow them, add my reaction videos" → effect/light pooling (freeze fixed), 1.3x track
scale, fewer pedestrians, missile targeting + `slow`, and the happy/accident/winning clip overlay.
7. "Mystery images on 2 of the 4 boxes" and "put the videos and images at the top and bigger, the side one
isn't getting the attention" → mystery boxes + the large top-centre `#reactions` stack.
8. "Add the sound effects folder when photo memes appear" → a random `sound effect/` mp3 with every mystery
picture, with the picture held for the length of the sound.
9. Hosting → `render.yaml`, deploy guide, and the tick-cost optimisation.
10. "Mystery images block the sight; max 8 players; can't change AI racers after the room is created; let
players talk while racing; thunder should play aaagg; smoke bomb / flight / gun / flip power-ups; 8 laps"
→ picture moved left and shrunk, `MAX_PLAYERS` 8 and an 8-lap option, the `renderResults` guard bug above,
WebRTC voice chat, reserved sounds, and the four new items.

## Hosting
- `render.yaml` makes Render a Blueprint deploy (`npm ci` + `node server.js`, free plan). Railway and
  Fly.io need no config beyond `npm start`; the server already honours `process.env.PORT`. Static hosts
  cannot run it. The README has the full guide, including a `npx cloudflared tunnel` option for playing
  immediately without deploying.
- **The media folders must be committed** - the server scans them at startup. `.gitignore` deliberately
  only ignores `node_modules/` and editor cruft.
- Server cost is about **0.34 ms per tick** for a full 8-car grid (~2% of a core), measured with all
  eight cars on AI, 14 oil slicks down and items firing. Re-measure if you touch `bots.js` or `stepCar`.
- `nearestOnTrack` is the most expensive call in the game (it scans every track segment). Never call it
  for something that already knows its own `s`/`lat`: pedestrians and oil slicks store theirs, and the
  server stashes each car's as `p.near` once per tick for the AI to reuse. Doing this halved the tick cost.

## Performance rules (learned the hard way - the game used to freeze on every item)
- **Never add or remove a light during play.** three.js rebuilds the shader program for *every*
  material in the scene when the light count changes, which froze the game for up to 1.7s each time a
  bomb, thunder bolt or missile appeared. All effect lights live in the `fxLights` pool in `scene3d.js`,
  created once at startup. **Setting `visible = false` on a light counts as removing it** - idle pool
  lights stay visible with `intensity = 0` and are parked below the world.
- **Don't allocate geometry or materials mid-race.** Explosions, bolts and missiles come from pools
  (`explosionPool`, `boltPool`, `missilePool`); they are hidden and reused, never created and disposed.
- **`prewarm()` in `scene3d.js`** builds those pools and calls `renderer.compile()` during loading,
  because three.js only compiles a material the first time it is actually drawn.
- **Reaction clips are prefetched in the lobby** (`prefetch()` in `clips.js`) and the real `<video>`
  element is primed by playing it once, silently - the first play on a cold video element costs ~500ms.
- Clip/image **prefetch is staggered** (one asset every 140ms, images with `decoding="async"` + `.decode()`).
  Kicking off ten JPEG decodes and seven video loads in one frame stalled the game for seconds.
- Measured with a `requestAnimationFrame` delta log while an autopilot drove and fired every item:
  before, 6 hitches over 250ms (worst 1718ms); after, median 16.6ms and p99 28.8ms with no real stalls.
- **Measurement trap:** the Claude browser pane flips `document.hidden` on and off about every 2 seconds,
  which throttles `requestAnimationFrame` and shows up as fake ~2000ms "hitches". Always log
  `document.visibilityState` next to frame deltas, or you will chase a stall that is not there.

## Staying connected (players used to get dropped for good)
A brief hiccup - Wi-Fi blip, backgrounded tab (browsers throttle timers), a stall on a small
free-tier instance - used to **end a player's race permanently**, because three things compounded:
`leaveRoom` deleted them from `room.players` the instant the socket closed, the room itself was
deleted if they were the last human, and `joinRoom` refused re-entry while a race was running - and
the client never tried to rejoin, it just showed "Disconnected from the server".

How it works now:
- `io` is created with `pingTimeout: 40000` and `connectionStateRecovery`, so a short blip resumes on
  the **same socket id** with no rejoin at all.
- **Disconnect no longer removes anyone.** The player is marked `online = false` with `offAt`, keeping
  their seat, slot, car, lap and score. `reapDisconnected()` (swept about once a second from the tick
  loop) clears them after `DISCONNECT_GRACE` (90s) and only then closes an empty room. **While a race
  is running nobody is reaped at all**, so a dropped player can always return to that race.
- **An AI drives for them while they are away**, at the room's AI skill (a `brain` is made on demand).
  Measured against real bots over 2 laps it covers the same distance and finishes alongside them.
- **Autopilot is decided by whether INPUTS are arriving, not by the socket.** A socket can stay open
  long after the player has effectively gone - a frozen tab, a lag spike, Wi-Fi that died without
  closing the connection. The tick loop switches to the AI after `INPUT_IDLE_MS` (1.5s) of silence
  and hands the wheel back the moment inputs resume. The **tick loop is the only place** that decides
  this and the only place that emits the `autopilot` / `resumed` events; `resume()` and the disconnect
  handler deliberately do not, or they would double-fire.
- **A human with an empty input queue is still simulated** by repeating `p.lastInput`. Without that,
  `stepCar` simply was not called for them: the car froze solid on the track - mid-air, at speed,
  forever - while the snapshot still reported its old speed. That was the real "AI takeover is not
  working" bug, and no socket-level timeout would ever have caught it.
- Both reconnect paths must call `resume()`: the token rejoin **and** the `room.players.has(socket.id)`
  path, because socket.io's recovery often restores the same id and that is how most reconnections
  actually arrive. Missing it there meant no handback event and a stale `lastSeq`.
- World events `autopilot` / `resumed` tell everyone who dropped and who came back.
- Every player gets a `token` at join, returned in the ack and kept in `localStorage` by the client.
  `joinRoom` with a matching token **reattaches them to their existing seat, even mid-race**
  (`reattach()` re-keys the player map to the new socket id and moves `hostId` with it).
- Host migrates to an online human the moment the host drops, so the room is never stuck, and the
  original is just a normal player if they come back.
- The client auto-rejoins from its `connect` handler (which fires on every reconnect) and shows
  `#linkState` instead of dumping you back to the menu; the last state keeps rendering meanwhile.
- `online` rides in the snapshot so the lobby can show "reconnecting…" next to a dropped player.
- Capacity checks use `liveHumans()`, **and** `joinRoom` checks `freeSlot(...) >= 0` - held seats still
  occupy grid slots, and without that check a newcomer could be handed slot -1.

## UI gotcha that already bit once
`renderLobby` / `renderResults` skip their work when a JSON "nothing changed" key matches. **Anything whose
state is not in that key must be rendered OUTSIDE the guard.** The race-setup buttons were inside
`renderResults`'s guard, whose key only covers finishing times - so between races the host could click
Laps/AI and the server would apply it, but no button ever re-highlighted. It looked completely broken
("I am not able to change the AI racers"). `renderSetup('setup2', …)` now runs before the early return.

## Open items / gotchas
- **Sound quality is unconfirmed:** the user said the earlier sounds were bad; they were rewritten but not yet heard by
  the user. Ask for feedback on specific sounds before changing them wholesale.
- **`sound-preview.wav` is out of date** — it predates the drift squeal, charge tone, mini-turbo, stunt, slipstream,
  missile and thunder sounds. There is no longer a script that renders it.
- The ground plane is subdivided, and road surfaces use `polygonOffset` + small heights (asphalt 1.0, kerbs 1.3,
  decals 1.6–1.8). Don't switch back to `logarithmicDepthBuffer`: it caused the road to vanish at some camera angles.
- Headless Chrome (SwiftShader) renders at about 2–3 fps, so in-browser tests run in slow motion. Use synchronous
  `renderer.render` + `toDataURL` for exact frames.
- Drift tuning is sensitive: `DRIFT_DRAG`, `MT_TIME` and `GRIP_MIN` together decide whether drifting is worth it.
  Re-run the lap comparison above after touching any of them.
- Ideas not done yet: touch/mobile controls, tree collisions, track selection, chat.
