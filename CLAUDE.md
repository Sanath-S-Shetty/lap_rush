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
Host picks 1/2/3/5 laps, 0–5 AI racers and AI skill (easy/normal/hard); up to 8 cars on the grid.

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

**Driving.** Grip washes out with speed (`GRIP_FROM`/`GRIP_MIN`), so you cannot just hold the throttle through
everything. Hold `SHIFT` + steer to **drift**: the car slides (`slip`), turns harder, and banks `charge`. Release
for a **mini-turbo** — three tiers (blue / orange / purple) worth 0.8 / 1.35 / 2.1s of boost. Hold `SHIFT` in the
air for a **stunt** (barrel roll) that pays a boost on landing. Tuck in behind a car for a **slipstream** that
charges to a speed burst. A wall hit above a glancing angle kills the drift and its charge.

**Items** (`? boxes`, weighted by position — leaders get defensive, the back of the field gets attacking):
oil, bomb, nitro, shield, homing **missile** (rides the centre line so it follows the track round corners;
locks the *nearest* rival ahead, falling back to the nearest car anywhere, and leaves the victim on `slow`
for 3s at half top speed) and **thunder** (strikes everyone ahead of you).

**Style points** for mini-turbos, stunts, slipstreams and landing hits; -120 for hitting a pedestrian. Shown live
in the HUD and ranked on the results screen.

3 zebra crossings with 9 pedestrians (`PEDS_PER_CROSSING`; hitting one: spin-out, stop, lose your item), 3 jump
ramps, 7 boost pads, 4 rows of 4 item boxes (2 live, 2 mystery), walls both sides. Controls: WASD/arrows, `SHIFT` (or `X`) =
drift/stunt, `SPACE` = item (S+Space = bomb backwards), `C` = chase/cockpit camera, `M` = mute.

Clipping the *side* of a ramp shoves the car sideways off the edge rather than bouncing it straight back —
the old bounce let a car wedge against the edge and accelerate-bounce forever without ever getting free.

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
