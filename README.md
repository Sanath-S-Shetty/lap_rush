# 🏁 Lap Rush: multiplayer browser racing

A 3D kart-style racing game with a chase camera behind your car and a cockpit view. Play solo against AI racers,
or create a room and let up to 3 friends join with a 4-letter code. Up to **8 cars on the grid**.

It is built around one idea: **drifting is the fast way round**. Grip washes out as you go faster, so you cannot
just hold the throttle through the corners — hold SHIFT, slide, bank the charge, and fire out of the corner on a
mini-turbo.

**Stack:** Node.js + Express + Socket.IO (server) · Three.js 3D graphics + plain JavaScript (client). No build step: Three.js is installed by `npm install` and served by the game server.

## Run it

You need **Node.js 18+** (https://nodejs.org).

```bash
cd lap-rush
npm install
npm start
```

Open http://localhost:3000, create a room and hit **Start race** — the AI racers will fill the grid, so it is
worth playing on your own. To test multiplayer alone, open a second browser tab and join your own room.

### Controls

| Key | Action |
|---|---|
| **W A S D** / **arrows** | Drive |
| **SHIFT** (or **X**) | **Drift** (hold + steer) · in the air, a **stunt** |
| **SPACE** | Use item (hold **S/Down** + SPACE to throw a bomb backwards) |
| **C** | Camera (Chase / Cockpit) |
| **M** | Sound on/off |

## Gameplay

### Driving

- **Drift for mini-turbos.** Hold **SHIFT** and steer to break traction. The longer you hold the slide, the more
  charge you bank — three tiers, shown by the colour of the sparks and the bar at the bottom of the screen:

  | Tier | Hold for | Reward |
  |---|---|---|
  | 🔵 Mini-turbo | 0.45 s | 0.8 s boost |
  | 🟠 Super turbo | 1.0 s | 1.35 s boost |
  | 🟣 Ultra turbo | 1.65 s | 2.1 s boost |

  Steer *into* the drift to tighten it, counter-steer to open it out. Clout a wall and you lose the slide and the
  whole charge — a tidy drifting lap is about 1.5 s faster than flat out, a messy one is *slower*.
- **Air stunts.** Hold **SHIFT** off a ramp for a barrel roll. Land it and you get a free boost.
- **Slipstream.** Sit right behind another car and the bar fills; at full charge you get a speed burst.
- **Style points** for mini-turbos, stunts, slipstreams and landing hits on other racers (and -120 for flattening a
  pedestrian). Live in the HUD, ranked on the results screen — so there is something to win besides the race.

### Race setup

The host picks **1 / 2 / 3 / 5 laps**, **0–5 AI racers** and **AI skill** (Easy / Normal / Hard) in the lobby and on
the results screen. The AI drives through exactly the same physics you do — it brakes, drifts, takes an apex, dodges
oil and uses items — and it rubber-bands gently so races stay close.

### Items

Item boxes are the rainbow **?** cubes. Drive through one, press **SPACE** to use it. Leaders tend to get defensive
items; drivers at the back get the attacking ones.

| Item | What it does |
|---|---|
| 🛢️ Oil slick | Dropped behind you. Anyone who drives over it spins out. |
| 💣 Bomb | Thrown ahead and auto-aims at the nearest car in front. The blast throws cars into the air and spins them out. |
| 🚀 Missile | Homing. It rides the centre line, so it follows the track round corners, locks onto the **nearest rival ahead** and leaves them crippled — half top speed for 3 seconds. |
| 🌩️ Thunder | Strikes **everyone ahead of you** at once. The comeback item. |
| ⚡ Nitro | Big speed boost for 2.6 s. |
| 🛡️ Shield | Blocks the next hit of any kind (lasts 8 s). |

### Item boxes are a gamble

Each row has **4 boxes but only 2 of them hold a power-up**. The other two are *mystery boxes*: they flash up
a picture and give you nothing. They look identical, and which two are live is reshuffled every time the row
respawns — so you can't learn the pattern, you just have to pick one and hope.

### Reactions

Your own videos and pictures take over the top of the screen on the big moments:

| Folder | When it shows |
|---|---|
| `happy/` | You pick up a strong item (nitro, missile, thunder, shield) |
| `accident/` | You flatten a pedestrian, or a missile catches you |
| `mystry/` | You open an empty mystery box — paired with a random meme sound |
| `sound effect/` | The `.mp3`s played with the mystery pictures |
| `winning.mp4` | Shown to the **top two finishers** at the end |

They are picked at random (never the same one twice in a row), play with sound and follow the **M** mute key,
and they sit top-centre where you can't miss them without covering the road ahead. A mystery picture gets a
random meme sound from `sound effect/`, and the picture stays on screen for as long as that sound runs — so
the image and the punchline always land together.

To add more, drop `.mp4`/`.webm` files into `happy/` or `accident/`, images into `mystry/`, or `.mp3`s into
`sound effect/`, and restart the server — no code to change.

### The circuit

- **Big, wide circuit** with walls on both sides: glancing hits slide you along, head-on crashes bounce you back.
  The whole thing is scaled by one number (`SCALE` in `shared/game.js`) if you want it bigger or smaller still.
- **3 jump ramps** (airborne cars fly over other cars), **7 boost pads** and **4 rows of item boxes**.
- **Pedestrians** cross the road at the zebra crossings (look for the yellow signs). **Hit one and you're penalised:**
  you spin out, stop dead and lose your item. (They fall over and get back up.)
- Overtake and position-change alerts, wrong-way warning, final-lap alert, best-lap times and style scores on the
  results screen.
- **Sound** is synthesized live with the Web Audio API (no audio files): an engine with gear shifts, tyre squeal that
  rises with your drift charge, mini-turbo chimes, crashes, jumps, item sounds, explosions, thunder and lap chimes.

## Playing with friends

Lap Rush needs a **live Node server** — it runs the physics for everyone. Static hosts
(GitHub Pages, Netlify, Vercel's static output) **cannot host it**. Pick one of these three:

### 1. Same Wi-Fi — nothing to set up

Run `npm start` and the server prints a line like `Friends on your Wi-Fi: http://192.168.1.23:3000`.
Friends on the same network open that address. On Windows click **Allow** if the firewall asks.
Some college/hostel networks block device-to-device traffic — if so, use option 2 or 3.

### 2. Play right now over the internet — a tunnel

Your PC stays the server; a tunnel gives it a public HTTPS address. Nothing to sign up for:

```bash
npm start
```

Then in a **second terminal**:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints a `https://something.trycloudflare.com` URL — send that to your friend. It works until you
close it, and your PC must stay on. (`npx localtunnel --port 3000` is an alternative.)

### 3. A permanent link — deploy to Render (free)

Best if you want a URL that keeps working. This repo has a `render.yaml`, so Render configures itself.

**Step 1 — put the project on GitHub** (from the project folder):

```bash
git init -b main
```

```bash
git add -A && git commit -m "Lap Rush"
```

Create an empty repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR-NAME/lap-rush.git && git push -u origin main
```

**Step 2 — deploy:** go to [render.com](https://render.com), sign in with GitHub, choose
**New → Blueprint**, pick the repo and confirm. Render reads `render.yaml`, runs `npm ci`, starts
`node server.js` and gives you a `https://lap-rush-xxxx.onrender.com` link. Share that.

Things worth knowing about the free plan:
- It **sleeps after ~15 minutes idle**, and the next visit takes ~50 seconds to wake up. Open the link
  yourself a minute before your friend joins and it will be warm.
- Make sure the `happy/`, `accident/`, `mystry/` and `sound effect/` folders are committed — the game
  reads them at startup. `git add -A` includes them; the `.gitignore` deliberately does not.
- Railway and Fly.io work too: both just need `npm start` and the `PORT` environment variable, which
  the server already uses.

### Will it keep up?

A full 8-car grid costs about **0.34 ms per 60 Hz tick** — roughly 2% of one CPU core, so even
Render's smallest free instance can run several rooms at once. Lag is handled by client-side
prediction, so a server in another country is still playable.

## Project structure

```
server.js          game server: rooms, settings, authoritative physics, laps, rankings, slipstream, scoring
bots.js            the AI drivers: racing line, braking, drifting, dodging, item tactics
hazards.js         server-side pedestrians, item boxes, oil, bombs, missiles, thunder, shields
shared/game.js     physics + track code used by BOTH server and browser (incl. drift / stunts / slipstream)
public/index.html  menu, lobby, HUD, results screens
public/style.css
public/client.js   input, prediction, interpolation, HUD, popups, minimap
public/scene3d.js  3D world: track, cars, particles, missiles, thunder, scenery, cameras
public/sound.js    synthesized sound effects (Web Audio API)
public/clips.js    the reaction-video overlay (random pick, cooldowns, prefetch)
happy/             reaction clips for picking up a strong item   (add your own .mp4 here)
accident/          reaction clips for crashes and missile hits   (add your own .mp4 here)
mystry/            pictures shown when you open an empty box     (add your own images here)
sound effect/      meme sounds played with those pictures        (add your own .mp3 here)
winning.mp4        played to the top two finishers
tools/bot-race.js  headless test: scripted clients + AI race each other and print every event
```

## How the networking works

1. **Authoritative server.** Browsers send only key presses (`{seq, u, d, l, r, h}`) 60×/sec.
   The server runs the physics, so nobody can cheat by sending fake positions.
   It also caps how many inputs it processes per tick, which blocks "speed hacks".
   The AI racers go through the same path — they produce key presses, nothing more.
2. **Snapshots.** The server simulates at 60 Hz and broadcasts the state of every car 20×/sec.
3. **Client-side prediction.** Your browser runs the same `stepCar()` from `shared/game.js`
   on your own inputs immediately, so steering and drifting feel instant even with lag.
4. **Reconciliation.** Each snapshot says which input `seq` the server last processed.
   The client resets to the server's position, replays the newer inputs, and eases out any difference.
5. **Interpolation.** Other cars are drawn ~100 ms in the past, blended between two snapshots, so they move smoothly.

## Testing

```bash
npm start              # in one terminal
npm run test:bots      # in another: two scripted clients + AI race and print every event
LAPS=1 AI=5 npm run test:bots   # one lap, a 7-car grid
```

## Easy things to tweak

| What | Where |
|---|---|
| Default laps, max players/racers, track width | `CONFIG` in `shared/game.js` |
| Car speed, acceleration, steering | `PHYS` in `shared/game.js` |
| **Drift feel** (slide angle, turn-in, charge tiers, boost per tier) | `DRIFT_*` and `MT_TIME` in `PHYS` |
| **How much grip you lose at speed** | `GRIP_FROM` / `GRIP_MIN` in `PHYS` |
| Slipstream range and payoff | `DRAFT_*` in `PHYS` |
| **Overall track size** (circuit + road width together) | `SCALE` in `shared/game.js` |
| **Track shape** | `TRACK_POINTS` in `shared/game.js` (point 0 = start line) |
| How many pedestrians per crossing | `PEDS_PER_CROSSING` in `shared/game.js` |
| Missile speed, slow duration | `MISSILE_*` in `hazards.js`, `SLOW_TIME` / `SLOW_MULT` in `PHYS` |
| Which items trigger a happy clip, clip cooldowns | `BIG_ITEMS` in `public/client.js`, `COOLDOWN` in `public/clips.js` |
| How many of the 4 boxes in a row hold a power-up | `ITEM_BOXES_PER_ROW` in `hazards.js` |
| How big the reaction videos/pictures are | `#clip video` / `#mystery img` in `public/style.css` |
| **Ramps & boost pads** (position, size, height) | `RAMPS` and `PADS` in `shared/game.js` |
| Item box rows, zebra crossings | `BOX_ROWS`, `BOX_LATS`, `CROSSINGS` in `shared/game.js` |
| Item odds, blast radius, oil lifetime, missile speed | top of `hazards.js` (and `pickItem()`) |
| Style point values | `SCORE` in `hazards.js` |
| AI skill levels and tactics | `LEVELS`, `think()` and `wantsItem()` in `bots.js` |
| How hard the AI rubber-bands | `rubberBand()` in `server.js` |
| Car colours | `COLORS` in `server.js` |
| Drift smoke / spark look | `makeParticles`, `TIER_COLOR` in `public/scene3d.js` |

## Ideas for next steps

- Touch controls for phones (on-screen buttons that set `keys.up/left/...`)
- Multiple tracks the host can choose in the lobby
- Collisions with trees (put the tree positions in `shared/game.js` so the server knows them)
- Ghost replays and a global leaderboard
- In-lobby chat
- A proper race series: points across several races
