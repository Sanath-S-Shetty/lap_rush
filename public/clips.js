// Reaction video clips: a small picture-in-picture that pops up on big moments.
// The server lists what is in happy/ and accident/ (plus winning.mp4) at /clips.json,
// so dropping more files in those folders is all it takes to add more reactions.

const COOLDOWN = { happy: 9000, accident: 7000, win: 0 };
const PRIORITY = { happy: 1, accident: 2, win: 3 };

// Sound effects reserved for one specific moment. They are kept out of the random
// mystery-box pool so they only ever mean the thing they are meant to mean.
const RESERVED_SFX = ['aaagg'];
const isReserved = (url) => RESERVED_SFX.some((n) => decodeURIComponent(url).toLowerCase().includes(n));

export function createClips(box, isMuted, imgBox) {
  const video = box.querySelector('video');
  const img = imgBox ? imgBox.querySelector('img') : null;
  let lists = { happy: [], accident: [], win: [], mystery: [], sfx: [] };
  let lastAt = { happy: 0, accident: 0, win: 0 };
  let lastUrl = { happy: '', accident: '', win: '', mystery: '', sfx: '' };
  const sfxByUrl = new Map();   // preloaded Audio elements, reused so nothing re-downloads
  let sfxNow = null;            // the meme sound currently playing
  let playing = null;      // kind currently on screen
  let hideTimer = 0;

  fetch('/clips.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return;
      lists = {
        happy: j.happy || [], accident: j.accident || [], win: j.win || [],
        mystery: j.mystery || [], sfx: j.sfx || [],
      };
      prefetch();
    })
    .catch(() => { /* no clips available: the game just carries on */ });

  // Pull every clip into the browser cache during the lobby. Without this the first
  // play of each one stalls the game while it is fetched and the decoder spins up.
  // The elements are kept alive and buffered - tearing them down again costs another
  // stall, and the clips are only a couple of MB in total.
  const warmed = [];
  function prefetch() {
    // One asset at a time, spaced out: decoding ten photos and seven videos in the same
    // frame stalls the game for seconds. Images decode off the main thread.
    const jobs = [];
    for (const url of lists.sfx) {
      jobs.push(() => {
        const a = new Audio();
        a.preload = 'auto';
        a.src = url;
        a.load();
        sfxByUrl.set(url, a);
      });
    }
    for (const url of lists.mystery) {
      jobs.push(() => {
        const i = new Image();
        i.decoding = 'async';
        i.src = url;
        warmed.push(i);
        if (i.decode) i.decode().catch(() => { /* fine, it decodes on first display */ });
      });
    }
    const all = [...lists.happy, ...lists.accident, ...lists.win];
    for (const url of all) {
      jobs.push(() => {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.muted = true;
        v.src = url;
        v.load();
        warmed.push(v);
      });
    }
    let n = 0;
    const step = () => {
      if (n >= jobs.length) return;
      jobs[n++]();
      setTimeout(step, 140);
    };
    step();
    // The element we actually play through needs its own decoder spun up, or the first
    // real clip of the race costs half a second. Run it silently while still hidden.
    if (all.length) {
      video.muted = true;
      video.src = all[0];
      const p = video.play();
      if (p && p.then) {
        p.then(() => {
          video.pause();
          video.currentTime = 0;
        }).catch(() => { /* autoplay blocked: it warms up on the first real clip instead */ });
      }
    }
  }

  // Pick at random, but never the same clip twice in a row.
  function pick(kind) {
    const list = kind === 'sfx' ? (lists.sfx || []).filter((u) => !isReserved(u)) : (lists[kind] || []);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    let url;
    do { url = list[Math.floor(Math.random() * list.length)]; } while (url === lastUrl[kind]);
    lastUrl[kind] = url;
    return url;
  }

  // the banner has to move out of the way while anything is on the reactions stack
  function syncStage() {
    const on = box.classList.contains('show') || !!(imgBox && imgBox.classList.contains('show'));
    document.body.classList.toggle('reacting', on);
  }

  function hide() {
    clearTimeout(hideTimer);
    playing = null;
    box.classList.remove('show');
    box.classList.remove('win');
    syncStage();
    try { video.pause(); } catch (e) { /* ignore */ }
    // drop the source so the clip does not keep buffering behind the scenes
    setTimeout(() => { if (!playing) { video.removeAttribute('src'); video.load(); } }, 400);
  }

  function play(kind) {
    const now = Date.now();
    // Decide whether we are playing at all BEFORE picking a clip - picking advances the
    // "don't repeat the last one" memory, so a rejected call must not consume a pick.
    if (!(lists[kind] || []).length) return false;
    // a more important clip interrupts a lesser one; otherwise respect the cooldown
    if (playing && PRIORITY[kind] <= PRIORITY[playing]) return false;
    if (!playing && now - lastAt[kind] < COOLDOWN[kind]) return false;

    const url = pick(kind);
    if (!url) return false;
    lastAt[kind] = now;
    playing = kind;
    clearTimeout(hideTimer);
    box.classList.toggle('win', kind === 'win');
    box.classList.add('show');
    syncStage();
    video.muted = !!(isMuted && isMuted());
    video.currentTime = 0;
    video.src = url;
    const started = video.play();
    if (started && started.catch) {
      started.catch(() => {
        // the browser blocked audio before any interaction: show it silently instead
        video.muted = true;
        video.play().catch(() => hide());
      });
    }
    // safety net in case 'ended' never fires (bad file, decode error)
    hideTimer = setTimeout(hide, 12000);
    return true;
  }

  video.addEventListener('ended', hide);
  video.addEventListener('error', hide);

  // ---- meme sound effects that go with the pictures ----
  function stopSfx() {
    if (!sfxNow) return;
    try { sfxNow.pause(); sfxNow.currentTime = 0; } catch (e) { /* ignore */ }
    sfxNow = null;
  }
  // Returns how long the effect runs for (seconds), so the picture can stay up with it.
  function playSfx() {
    if (!lists.sfx.length || (isMuted && isMuted())) return 0;
    const url = pick('sfx');
    if (!url) return 0;
    stopSfx();
    let a = sfxByUrl.get(url);
    if (!a) { a = new Audio(url); a.preload = 'auto'; sfxByUrl.set(url, a); }
    a.currentTime = 0;
    a.volume = 0.85;
    const p = a.play();
    if (p && p.catch) p.catch(() => { /* blocked before any interaction: no sound, no harm */ });
    sfxNow = a;
    return Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
  }

  // Play one specific effect by filename fragment, e.g. the "aaagg" scream when thunder
  // strikes you. Ignores the random pool entirely.
  function playNamed(fragment) {
    if (isMuted && isMuted()) return false;
    const url = (lists.sfx || []).find((u) => decodeURIComponent(u).toLowerCase().includes(fragment));
    if (!url) return false;
    stopSfx();
    let a = sfxByUrl.get(url);
    if (!a) { a = new Audio(url); a.preload = 'auto'; sfxByUrl.set(url, a); }
    a.currentTime = 0;
    a.volume = 0.9;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
    sfxNow = a;
    return true;
  }

  // ---- mystery box picture: a still at the top of the screen, never in the way ----
  let imgTimer = 0;
  function showImage(ms) {
    if (!img || !lists.mystery.length) return false;
    const url = pick('mystery');
    if (!url) return false;
    img.src = url;
    imgBox.classList.add('show');
    syncStage();
    // hold the picture for as long as its meme sound runs, within sensible limits
    const dur = playSfx();
    const hold = ms || Math.min(6000, Math.max(2800, dur * 1000 + 400));
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => {
      imgBox.classList.remove('show');
      stopSfx();
      syncStage();
    }, hold);
    return true;
  }
  function hideImage() {
    clearTimeout(imgTimer);
    if (imgBox) imgBox.classList.remove('show');
    stopSfx();
    syncStage();
  }

  return {
    play,
    hide,
    showImage,
    hideImage,
    playNamed,
    get busy() { return !!playing; },
    setMuted(m) {
      video.muted = !!m;
      if (m) stopSfx();           // the M key silences the meme sounds too
    },
    has(kind) { return (lists[kind] || []).length > 0; },
  };
}
