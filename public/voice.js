// In-race voice chat: a small WebRTC mesh between everyone in the room.
//
// The game server only passes the handshake messages along ("signalling") - the audio
// itself goes straight between players, so it never touches the server.
//
// Mesh means every player connects to every other player. That is fine for a room of
// 8 (7 connections each) and keeps the server free of audio handling entirely.

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function createVoice(socket, getMyId, onChange) {
  let stream = null;          // our microphone
  let on = false;             // is voice chat switched on for us
  let talking = false;        // is our mic currently open (push to talk off = always)
  let error = '';
  const peers = new Map();    // playerId -> { pc, audio, stream }
  let analyser = null, levelData = null, level = 0;

  const notify = () => { if (onChange) onChange(); };

  // getUserMedia only works on a secure origin: https, or localhost while developing.
  // On a plain http://192.168.x.x LAN address the browser refuses, which is worth
  // saying out loud rather than failing silently.
  const secure = window.isSecureContext;

  async function start() {
    if (on) return true;
    if (!secure) {
      error = 'Voice needs a secure (https) address. Use the hosted link, not a LAN IP.';
      notify();
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      error = 'This browser has no microphone support.';
      notify();
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      error = e && e.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it in the browser address bar.'
        : 'Could not open the microphone.';
      notify();
      return false;
    }
    error = '';
    on = true;
    talking = true;
    meterUp();
    socket.emit('voiceOn', true);
    notify();
    return true;
  }

  function stop() {
    on = false;
    talking = false;
    socket.emit('voiceOn', false);
    for (const id of [...peers.keys()]) drop(id);
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    meterDown();
    notify();
  }

  function toggle() { return on ? (stop(), false) : start(); }

  // mute our own mic without tearing the connections down
  function setTalking(v) {
    talking = !!v;
    if (stream) for (const t of stream.getAudioTracks()) t.enabled = talking;
    notify();
  }

  // ---- a little level meter so you can see your own mic is live ----
  function meterUp() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      levelData = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
    } catch (e) { analyser = null; }
  }
  function meterDown() { analyser = null; levelData = null; level = 0; }
  function micLevel() {
    if (!analyser || !talking) return 0;
    analyser.getByteFrequencyData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) sum += levelData[i];
    const now = sum / levelData.length / 255;
    level += (now - level) * 0.3;
    return level;
  }

  // ---- peer plumbing ----
  function makePeer(id) {
    const pc = new RTCPeerConnection(ICE);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.appendChild(audio);
    const peer = { pc, audio, ready: false };
    peers.set(id, peer);

    if (stream) for (const t of stream.getTracks()) pc.addTrack(t, stream);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice', { to: id, kind: 'ice', data: e.candidate });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => { /* resumes on the next user gesture */ });
      peer.ready = true;
      notify();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) drop(id);
    };
    return peer;
  }

  function drop(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* ignore */ }
    if (p.audio.parentNode) p.audio.parentNode.removeChild(p.audio);
    peers.delete(id);
    notify();
  }

  async function callPeer(id) {
    const peer = peers.get(id) || makePeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('voice', { to: id, kind: 'offer', data: offer });
  }

  socket.on('voice', async (msg) => {
    if (!msg || !msg.from) return;
    const id = msg.from;
    try {
      if (msg.kind === 'offer') {
        if (!on) return;                       // we are not in the call
        const peer = peers.get(id) || makePeer(id);
        await peer.pc.setRemoteDescription(msg.data);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('voice', { to: id, kind: 'answer', data: answer });
      } else if (msg.kind === 'answer') {
        const peer = peers.get(id);
        if (peer) await peer.pc.setRemoteDescription(msg.data);
      } else if (msg.kind === 'ice') {
        const peer = peers.get(id);
        if (peer) await peer.pc.addIceCandidate(msg.data).catch(() => {});
      }
    } catch (e) { /* a failed handshake just means no audio with that one player */ }
  });

  // Called with every server snapshot: connect to anyone new who has voice on, and
  // drop anyone who left or switched it off. Only ONE side of each pair makes the
  // offer (the lower id), otherwise both would call at once and collide.
  function sync(players) {
    const myId = getMyId();
    if (!on || !myId) {
      if (!on) for (const id of [...peers.keys()]) drop(id);
      return;
    }
    const want = new Set((players || []).filter((p) => p.voice && !p.bot && p.id !== myId).map((p) => p.id));
    for (const id of want) {
      if (peers.has(id)) continue;
      if (myId < id) callPeer(id).catch(() => {});   // we call, they answer
      else makePeer(id);                             // wait for their offer
    }
    for (const id of [...peers.keys()]) if (!want.has(id)) drop(id);
  }

  return {
    toggle, start, stop, sync, setTalking, micLevel,
    get on() { return on; },
    get talking() { return talking; },
    get error() { return error; },
    get connected() { return [...peers.values()].filter((p) => p.ready).length; },
    get secure() { return secure; },
  };
}
