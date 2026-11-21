// 3D renderer for Lap Rush (Three.js).
// The game logic is still 2D (x, y on a flat plane). Here we map
// game (x, y) -> 3D (x, 0, y) and draw everything in 3D.
import * as THREE from 'three';

// ---------- small helpers ----------
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createScene(canvas, S, TRACK) {
  const { CONFIG, PHYS } = S;
  const WW = CONFIG.WORLD_W, WH = CONFIG.WORLD_H;
  const CX = WW / 2, CZ = WH / 2;
  const TW = TRACK.width;
  const CURB = CONFIG.CURB;
  const WALL_OFF = TW / 2 + CURB + 4;

  // ---------- renderer / scene / camera ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const HORIZON = 0xc9def0;
  scene.fog = new THREE.Fog(HORIZON, 2200, 11500);
  const camera = new THREE.PerspectiveCamera(70, 1, 3, 30000);

  // ---------- lighting ----------
  scene.add(new THREE.HemisphereLight(0xe3f0ff, 0x4a6b35, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -650, right: 650, top: 650, bottom: -650, near: 10, far: 4000 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const SUN_DIR = new THREE.Vector3(-0.55, 1, 0.4).normalize();

  // ---------- sky dome (gradient) ----------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(18000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
      uniforms: { top: { value: new THREE.Color(0x2f6fd0) }, bottom: { value: new THREE.Color(HORIZON) } },
      vertexShader: `varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y * 2.2, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottom, top, pow(h, 0.6)), 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // ---------- ground ----------
  const GROUND = 40000;
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#4c8a3a'; g.fillRect(0, 0, w, h);
    const r = rng(7);
    for (let i = 0; i < 6000; i++) {
      g.fillStyle = r() < 0.5 ? `rgba(35,85,28,${0.2 + r() * 0.3})` : `rgba(130,180,85,${0.12 + r() * 0.2})`;
      g.fillRect(r() * w, r() * h, 1 + r() * 2, 2 + r() * 4);
    }
  });
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(GROUND / 260, GROUND / 260);
  grassTex.anisotropy = maxAniso;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND, GROUND, 64, 64),
    new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(CX, 0, CZ);
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- track ----------
  const P = TRACK.points, N = P.length;
  const normals = P.map((p, i) => {
    const a = P[(i - 1 + N) % N], b = P[(i + 1) % N];
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
    return { x: -ty / l, y: tx / l };
  });

  // A flat strip following the centerline, from offset o1 to o2 (sideways).
  function ribbon(o1, o2, y, vLen, material) {
    const pos = [], uv = [], nor = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const p = P[i % N], n = normals[i % N];
      const v = (i === N ? TRACK.length : TRACK.cum[i]) / vLen;
      pos.push(p.x + n.x * o1, y, p.y + n.y * o1, p.x + n.x * o2, y, p.y + n.y * o2);
      uv.push(0, v, 1, v);
      nor.push(0, 1, 0, 0, 1, 0);
      if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    // make sure triangles face upward
    const A = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const B = new THREE.Vector3(pos[3], pos[4], pos[5]);
    const C = new THREE.Vector3(pos[6], pos[7], pos[8]);
    if (B.sub(A).cross(C.sub(A)).y < 0) {
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  // road surfaces sit slightly above the grass; polygon offset avoids flicker between them
  const roadMat = (opts, bias) => new THREE.MeshStandardMaterial({ ...opts, polygonOffset: true, polygonOffsetFactor: -bias, polygonOffsetUnits: -bias * 2 });

  const asphaltTex = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#3c3d43'; g.fillRect(0, 0, w, h);
    const r = rng(3);
    for (let i = 0; i < 12000; i++) {
      const c = r() < 0.5 ? 0 : 255;
      g.fillStyle = `rgba(${c},${c},${c},${0.03 + r() * 0.07})`;
      g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
    }
    g.fillStyle = 'rgba(0,0,0,0.13)';                // racing-line rubber
    g.fillRect(w * 0.28, 0, w * 0.1, h); g.fillRect(w * 0.62, 0, w * 0.1, h);
    g.fillStyle = '#ececec';                          // edge lines
    g.fillRect(7, 0, 5, h); g.fillRect(w - 12, 0, 5, h);
    g.fillStyle = 'rgba(245,245,245,0.85)';           // centre dashes
    g.fillRect(w / 2 - 3, 0, 6, h * 0.42);
  });
  asphaltTex.wrapT = THREE.RepeatWrapping;
  asphaltTex.anisotropy = maxAniso;
  ribbon(-TW / 2, TW / 2, 1.0, 420, roadMat({ map: asphaltTex, roughness: 0.92 }, 2));

  const curbTex = canvasTex(16, 64, (g, w, h) => {
    g.fillStyle = '#d42a2a'; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f4f4f4'; g.fillRect(0, h / 2, w, h / 2);
  });
  curbTex.wrapT = THREE.RepeatWrapping;
  curbTex.anisotropy = maxAniso;
  const curbMat = roadMat({ map: curbTex, roughness: 0.7 }, 3);
  ribbon(-TW / 2 - CURB, -TW / 2, 1.3, 60, curbMat);
  ribbon(TW / 2, TW / 2 + CURB, 1.3, 60, curbMat);

  // ---------- track walls (tyre barriers) ----------
  function wall(o, h, vLen, material) {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const p = P[i % N], n = normals[i % N];
      const u = (i === N ? TRACK.length : TRACK.cum[i]) / vLen;
      pos.push(p.x + n.x * o, 0, p.y + n.y * o, p.x + n.x * o, h, p.y + n.y * o);
      uv.push(u, 0, u, 1);
      if (i < N) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const tyreTex = canvasTex(128, 32, (g, w, h) => {
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#f2f2f2' : '#d42a2a';
      g.fillRect(i * 32, 0, 32, h);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(i * 32, 0, 2, h); g.fillRect(i * 32, h / 2 - 1, 32, 2);
    }
  });
  tyreTex.wrapS = THREE.RepeatWrapping;
  tyreTex.anisotropy = maxAniso;
  const wallMat = new THREE.MeshStandardMaterial({ map: tyreTex, roughness: 0.8, side: THREE.DoubleSide });
  wall(-WALL_OFF, 16, 80, wallMat);
  wall(WALL_OFF, 16, 80, wallMat);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.7 });
  ribbon(-WALL_OFF - 3, -WALL_OFF + 3, 16, 100, capMat);
  ribbon(WALL_OFF - 3, WALL_OFF + 3, 16, 100, capMat);

  // Helper: a group placed on the track at distance s, with
  // local +X = driving direction and local +Z = right-hand side.
  function trackFrame(s) {
    const p = S.pointAtDistance(TRACK, s);
    const grp = new THREE.Group();
    grp.position.set(p.x, 0, p.y);
    grp.rotation.y = -p.angle;
    scene.add(grp);
    return grp;
  }
  function box(w, h, d, mat, x, y, z, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  // start/finish line + gantry
  const start = trackFrame(0);
  const checkTex = canvasTex(32, 256, (g) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#fafafa';
      g.fillRect(j * 16, i * 16, 16, 16);
    }
  });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(20, TW), roadMat({ map: checkTex, roughness: 0.8 }, 4));
  line.rotation.x = -Math.PI / 2;
  line.position.y = 1.6;
  line.receiveShadow = true;
  start.add(line);

  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 });
  const postZ = WALL_OFF + 16;
  box(8, 130, 8, steel, 0, 65, -postZ, start);
  box(8, 130, 8, steel, 0, 65, postZ, start);
  box(10, 26, postZ * 2 + 8, steel, 0, 126, 0, start);
  const bannerTex = canvasTex(1024, 96, (g, w, h) => {
    g.fillStyle = '#111318'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {     // checkered ends
      g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      g.fillRect(i * 16, j * 24, 16, 24); g.fillRect(w - 96 + i * 16, j * 24, 16, 24);
    }
    g.font = 'italic 900 64px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.fillText('LAP', w / 2 - 95, h / 2 + 3);
    g.fillStyle = '#ffbe0b'; g.fillText('RUSH', w / 2 + 75, h / 2 + 3);
  });
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(postZ * 2 - 6, 22), new THREE.MeshBasicMaterial({ map: bannerTex }));
    b.rotation.y = side * Math.PI / 2;
    b.position.set(side * 5.2, 126, 0);
    start.add(b);
  }

  // grandstand next to the start straight
  const crowdTex = canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#5b6370'; g.fillRect(0, 0, w, h);
    const r = rng(11);
    const cols = ['#e63946', '#3a86ff', '#ffbe0b', '#06d6a0', '#ffffff', '#f77f00', '#9b5de5', '#222'];
    for (let i = 0; i < 700; i++) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.beginPath(); g.arc(r() * w, r() * h, 2 + r() * 1.5, 0, Math.PI * 2); g.fill();
    }
  });
  crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping;
  crowdTex.repeat.set(6, 1);
  const crowdMat = new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.9 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.85 });
  const stand = trackFrame(560);
  const z0 = WALL_OFF + 40;
  for (let k = 0; k < 6; k++) box(700, 10 + k * 11, 18, crowdMat, 0, (10 + k * 11) / 2, z0 + k * 18, stand);
  box(720, 4, 130, concrete, 0, 96, z0 + 50, stand);
  for (const x of [-340, -110, 110, 340]) box(6, 96, 6, steel, x, 48, z0 + 112, stand);
  box(710, 9, 4, new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.6 }), 0, 4.5, z0 - 14, stand); // advert board

  // ---------- jump ramps ----------
  const chevronTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#ffc400'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#16181c';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(24, 0); g.lineTo(56, h / 2); g.lineTo(24, h); g.lineTo(0, h); g.lineTo(32, h / 2); g.closePath(); g.fill();
  });
  chevronTex.wrapS = chevronTex.wrapT = THREE.RepeatWrapping;
  chevronTex.repeat.set(1 / 40, 1 / 40);
  const rampTop = new THREE.MeshStandardMaterial({ map: chevronTex, roughness: 0.6 });
  const rampSide = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.8 });
  for (const r of S.RAMPS) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(r.len, r.h); shape.lineTo(r.len, 0); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: r.lat1 - r.lat0, bevelEnabled: false });
    geo.translate(0, 0, r.lat0);
    const mesh = new THREE.Mesh(geo, [rampSide, rampTop]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    trackFrame(r.s).add(mesh);
  }

  // ---------- boost pads ----------
  const padTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#063a4a'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3df2ff'; g.lineWidth = 9; g.lineJoin = 'miter';
    g.beginPath(); g.moveTo(14, 8); g.lineTo(42, h / 2); g.lineTo(14, h - 8); g.stroke();
  });
  padTex.wrapS = THREE.RepeatWrapping;
  padTex.repeat.set(2, 1);
  const padMat = new THREE.MeshBasicMaterial({ map: padTex, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  // A soft additive halo instead of a real light per pad: same glow, and it keeps the
  // scene's light count low (every extra light costs every material, everywhere).
  const padGlowTex = canvasTex(64, 64, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(90,240,255,0.55)');
    grad.addColorStop(0.5, 'rgba(60,200,255,0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  const padGlowMat = new THREE.MeshBasicMaterial({ map: padGlowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const p of S.PADS) {
    const w = p.lat1 - p.lat0;
    const mid = (p.lat0 + p.lat1) / 2;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(p.len, w), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(p.len / 2, 1.7, mid);
    trackFrame(p.s).add(pad);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(p.len * 2.4, w * 2.4), padGlowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(p.len / 2, 2.1, mid);
    trackFrame(p.s).add(glow);
  }

  // ---------- trees ----------
  {
    const r = rng(42);
    const spots = [];
    let tries = 0;
    while (spots.length < 1000 && tries < 20000) {
      tries++;
      const x = -900 + r() * (WW + 1800), z = -900 + r() * (WH + 1800);
      const near = S.nearestOnTrack(TRACK, x, z);
      const startArea = near.s < 1400 || near.s > TRACK.length - 500;
      if (near.dist < WALL_OFF + (startArea ? 300 : 45)) continue;
      spots.push({ x, z, s: 0.75 + r() * 0.9, rot: r() * 6.28, pine: r() < 0.55, hue: r() });
    }
    const trunkGeo = new THREE.CylinderGeometry(2.5, 3.6, 24, 6); trunkGeo.translate(0, 12, 0);
    const pineGeo = new THREE.ConeGeometry(17, 50, 7); pineGeo.translate(0, 42, 0);
    const roundGeo = new THREE.IcosahedronGeometry(20, 0); roundGeo.translate(0, 36, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const pines = spots.filter((t) => t.pine), rounds = spots.filter((t) => !t.pine);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const pineMesh = new THREE.InstancedMesh(pineGeo, leafMat, pines.length);
    const roundMesh = new THREE.InstancedMesh(roundGeo, leafMat, rounds.length);
    const d = new THREE.Object3D(), col = new THREE.Color();
    spots.forEach((t, i) => {
      d.position.set(t.x, 0, t.z); d.rotation.set(0, t.rot, 0); d.scale.setScalar(t.s); d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
    });
    pines.forEach((t, i) => {
      d.position.set(t.x, 0, t.z); d.rotation.set(0, t.rot, 0); d.scale.setScalar(t.s); d.updateMatrix();
      pineMesh.setMatrixAt(i, d.matrix);
      pineMesh.setColorAt(i, col.setHSL(0.33 + t.hue * 0.06, 0.45, 0.22 + t.hue * 0.08));
    });
    rounds.forEach((t, i) => {
      d.position.set(t.x, 0, t.z); d.rotation.set(0, t.rot, 0); d.scale.setScalar(t.s); d.updateMatrix();
      roundMesh.setMatrixAt(i, d.matrix);
      roundMesh.setColorAt(i, col.setHSL(0.22 + t.hue * 0.1, 0.5, 0.3 + t.hue * 0.1));
    });
    for (const m of [trunks, pineMesh, roundMesh]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
  }

  // ---------- distant mountains ----------
  {
    const r = rng(99);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6d8399, roughness: 1, flatShading: true });
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + r() * 0.1;
      const dist = 8800 + r() * 2200;
      const h = 900 + r() * 1700;
      const m = new THREE.Mesh(new THREE.ConeGeometry(h * (0.9 + r() * 0.5), h, 5 + Math.floor(r() * 3)), mat);
      m.position.set(CX + Math.cos(a) * dist, h / 2 - 20, CZ + Math.sin(a) * dist);
      m.rotation.y = r() * 6;
      scene.add(m);
    }
  }

  // ---------- zebra crossings + signs ----------
  const zebraTex = canvasTex(64, 256, (g, w, h) => {
    g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, w, h);
    g.fillStyle = '#f4f4f4';
    for (let i = 0; i < 8; i++) g.fillRect(0, i * 32 + 6, w, 20);
  });
  const signTex = canvasTex(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
    g.fillStyle = '#111'; g.fillRect(-46, -46, 92, 92);
    g.fillStyle = '#ffd21f'; g.fillRect(-40, -40, 80, 80);
    g.rotate(-Math.PI / 4);
    g.strokeStyle = '#111'; g.lineWidth = 7; g.lineCap = 'round';
    g.beginPath(); g.arc(2, -24, 7, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
    g.beginPath(); g.moveTo(0, -14); g.lineTo(-4, 8); g.lineTo(-14, 28); g.moveTo(-4, 8); g.lineTo(10, 26);
    g.moveTo(-2, -8); g.lineTo(-16, 2); g.moveTo(-2, -8); g.lineTo(14, -2); g.stroke();
  });
  const zebraMat = roadMat({ map: zebraTex, transparent: true, roughness: 0.8, depthWrite: false }, 4);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, transparent: true, roughness: 0.6, side: THREE.DoubleSide });
  for (const cs of S.CROSSINGS) {
    const f = trackFrame(cs);
    const z = new THREE.Mesh(new THREE.PlaneGeometry(70, TW), zebraMat);
    z.rotation.x = -Math.PI / 2; z.position.y = 1.6; z.receiveShadow = true;
    f.add(z);
    for (const side of [-1, 1]) {
      box(3, 60, 3, steel, -60, 30, side * (WALL_OFF + 14), f);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(34, 34), signMat);
      sign.position.set(-60, 66, side * (WALL_OFF + 14));
      sign.rotation.y = -Math.PI / 2;
      f.add(sign);
    }
  }

  // ---------- item boxes ----------
  const qTex = canvasTex(128, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#d9d9d9');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.font = '900 92px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillText('?', w / 2 + 4, h / 2 + 8);
    g.fillStyle = '#ffffff'; g.fillText('?', w / 2, h / 2 + 4);
  });
  const boxGeo = new THREE.BoxGeometry(24, 24, 24);
  const itemBoxes = S.boxPositions(TRACK).map((p, i) => {
    const mat = new THREE.MeshStandardMaterial({ map: qTex, transparent: true, opacity: 0.92, roughness: 0.25, metalness: 0.1, emissive: 0x222222 });
    const m = new THREE.Mesh(boxGeo, mat);
    m.position.set(p.x, 20, p.y);
    m.castShadow = true;
    scene.add(m);
    return { mesh: m, mat, phase: i * 0.7, scale: 1 };
  });

  // ---------- oil slicks ----------
  const oilTex = canvasTex(128, 128, (g, w, h) => {
    const r = rng(5);
    g.fillStyle = 'rgba(8,8,10,0.92)';
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(w / 2 + (r() - 0.5) * 50, h / 2 + (r() - 0.5) * 50, 18 + r() * 22, 0, Math.PI * 2);
      g.fill();
    }
    const sheen = g.createRadialGradient(w * 0.4, h * 0.4, 2, w * 0.4, h * 0.4, 40);
    sheen.addColorStop(0, 'rgba(120,90,200,0.35)'); sheen.addColorStop(0.5, 'rgba(60,160,140,0.15)'); sheen.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = sheen; g.fillRect(0, 0, w, h);
  });
  const oilMat = roadMat({ map: oilTex, transparent: true, roughness: 0.08, metalness: 0.7, depthWrite: false }, 5);
  const oilGeo = new THREE.PlaneGeometry(88, 88);
  const oils = new Map();

  // ---------- bombs ----------
  const bombGeo = new THREE.SphereGeometry(8, 16, 12);
  const bombMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.25, metalness: 0.6 });
  const fuseMat = new THREE.MeshBasicMaterial({ color: 0xffd36b });
  const bombs = new Map();
  function makeBomb() {
    const grp = new THREE.Group();
    const ball = new THREE.Mesh(bombGeo, bombMat); ball.castShadow = true; grp.add(ball);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 3, 8), steel); cap.position.y = 8.5; grp.add(cap);
    const spark = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), fuseMat); spark.position.y = 11.5; grp.add(spark);
    scene.add(grp);
    return { grp, spark };
  }

  // ---------- effect light pool ----------
  // IMPORTANT: adding or removing a light makes three.js rebuild the shader program for
  // EVERY material in the scene, which freezes the game for a moment. So all effect lights
  // are created once, stay in the scene forever, and are just switched on and off.
  // They must stay VISIBLE with intensity 0 when idle: three.js only counts visible
  // lights, so hiding one changes the light count and triggers the same recompile.
  const FX_LIGHTS = 5;
  const fxLights = [];
  for (let i = 0; i < FX_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 600, 1.6);
    l.position.set(0, -5000, 0); // parked far below the world while idle
    scene.add(l);
    fxLights.push({ light: l, busy: false });
  }
  function takeLight(color, dist) {
    const slot = fxLights.find((s) => !s.busy);
    if (!slot) return null;            // all busy: the effect simply goes unlit
    slot.busy = true;
    slot.light.color.set(color);
    slot.light.distance = dist;
    return slot;
  }
  function freeLight(slot) {
    if (!slot) return;
    slot.light.intensity = 0;
    slot.light.position.set(0, -5000, 0);
    slot.busy = false;
  }

  // ---------- explosions (pooled: nothing is allocated mid-race) ----------
  const fireGeo = new THREE.SphereGeometry(1, 20, 14);
  const puffGeo = new THREE.IcosahedronGeometry(1, 1);
  const debrisGeo = new THREE.BoxGeometry(4, 4, 4);
  const explosions = [];
  const explosionPool = [];
  const MAX_EXPLOSIONS = 6;

  function buildExplosion() {
    const mk = (m) => { m.visible = false; scene.add(m); return m; };
    const fire = mk(new THREE.Mesh(fireGeo, new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    const core = mk(new THREE.Mesh(fireGeo, new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    const puffs = [];
    for (let i = 0; i < 7; i++) {
      puffs.push({ m: mk(new THREE.Mesh(puffGeo, new THREE.MeshStandardMaterial({ color: 0x77777c, roughness: 1, flatShading: true, transparent: true, depthWrite: false }))), dx: 0, dz: 0, rise: 0, size: 0 });
    }
    const debris = [];
    for (let i = 0; i < 8; i++) debris.push({ m: mk(new THREE.Mesh(debrisGeo, steel)), vx: 0, vz: 0, vy: 0 });
    return { fire, core, puffs, debris, x: 0, y: 0, t: 0, light: null, live: false };
  }

  function explode(x, y) {
    let e = explosionPool.find((p) => !p.live);
    if (!e) {
      if (explosionPool.length >= MAX_EXPLOSIONS) e = explosionPool[0]; // recycle the oldest
      else { e = buildExplosion(); explosionPool.push(e); }
    }
    if (e.live) freeLight(e.light);
    e.x = x; e.y = y; e.t = 0; e.live = true;
    e.light = takeLight(0xffaa44, 600);
    if (e.light) e.light.light.position.set(x, 14, y);
    for (const m of [e.fire, e.core]) { m.visible = true; m.position.set(x, 14, y); }
    e.puffs.forEach((p, i) => {
      const a = (i / 7) * Math.PI * 2;
      p.dx = Math.cos(a) * (15 + Math.random() * 25);
      p.dz = Math.sin(a) * (15 + Math.random() * 25);
      p.rise = 30 + Math.random() * 40;
      p.size = 18 + Math.random() * 16;
      p.m.visible = true;
      p.m.position.set(x, 14, y);
    });
    for (const d of e.debris) {
      const a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 160;
      d.vx = Math.cos(a) * sp; d.vz = Math.sin(a) * sp; d.vy = 160 + Math.random() * 160;
      d.m.visible = true;
      d.m.position.set(x, 14, y);
    }
    if (!explosions.includes(e)) explosions.push(e);
  }

  function updateExplosions(dt) {
    for (let i = explosions.length - 1; i >= 0; i--) {
      const e = explosions[i];
      if (!e.live) { explosions.splice(i, 1); continue; }
      e.t += dt;
      const t = e.t;
      e.fire.scale.setScalar(15 + 70 * Math.min(1, t / 0.3));
      e.fire.material.opacity = Math.max(0, 0.95 - t / 0.45);
      e.core.scale.setScalar(10 + 40 * Math.min(1, t / 0.15));
      e.core.material.opacity = Math.max(0, 1 - t / 0.25);
      if (e.light) e.light.light.intensity = Math.max(0, 40 * (1 - t / 0.45));
      for (const p of e.puffs) {
        const k = Math.min(1, t / 1.2);
        p.m.position.set(e.x + p.dx * (0.4 + k), 14 + p.rise * k * 1.5, e.y + p.dz * (0.4 + k));
        p.m.scale.setScalar(p.size * (0.4 + 0.9 * Math.sqrt(k)));
        p.m.material.opacity = t < 0.15 ? t / 0.15 * 0.7 : Math.max(0, 0.7 * (1 - (t - 0.15) / 1.45));
      }
      for (const d of e.debris) {
        d.vy -= 600 * dt;
        d.m.position.x += d.vx * dt; d.m.position.z += d.vz * dt;
        d.m.position.y = Math.max(2, d.m.position.y + d.vy * dt);
        d.m.rotation.x += dt * 8; d.m.rotation.y += dt * 6;
      }
      if (t > 1.6) {
        freeLight(e.light);
        e.light = null;
        e.live = false;
        e.fire.visible = e.core.visible = false;
        for (const p of e.puffs) p.m.visible = false;
        for (const d of e.debris) d.m.visible = false;
        explosions.splice(i, 1);
      }
    }
  }

  // ---------- particles (drift smoke, sparks, boost trails, dust) ----------
  // One draw call per system: positions/colours/sizes live in buffer attributes.
  const dotTex = canvasTex(64, 64, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });

  function makeParticles(max, blending) {
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const size = new Float32Array(max);
    const alpha = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(alpha, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: dotTex } },
      vertexShader: `
        attribute vec3 pcolor; attribute float psize; attribute float palpha;
        varying vec3 vCol; varying float vAlpha;
        void main() {
          vCol = pcolor; vAlpha = palpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * 420.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D tex; varying vec3 vCol; varying float vAlpha;
        void main() {
          vec4 t = texture2D(tex, gl_PointCoord);
          if (t.a * vAlpha < 0.01) discard;
          gl_FragColor = vec4(vCol, t.a * vAlpha);
        }`,
      transparent: true, depthWrite: false, blending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    const live = [];
    return {
      max, live, geo, pos, col, size, alpha,
      spawn(x, y, z, o) {
        if (live.length >= max) live.shift();
        live.push({
          x, y, z,
          vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
          life: 0, max: o.life, size: o.size, grow: o.grow || 0,
          r: o.r, g: o.g, b: o.b, drag: o.drag === undefined ? 1.4 : o.drag,
          gravity: o.gravity || 0, fade: o.fade || 1,
        });
      },
      update(dt) {
        let n = 0;
        for (let i = live.length - 1; i >= 0; i--) {
          const p = live[i];
          p.life += dt;
          if (p.life >= p.max) { live.splice(i, 1); continue; }
          const d = Math.exp(-p.drag * dt);
          p.vx *= d; p.vz *= d;
          p.vy = p.vy * d - p.gravity * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.y < 1) { p.y = 1; p.vy = 0; }
        }
        for (const p of live) {
          const k = p.life / p.max;
          pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
          col[n * 3] = p.r; col[n * 3 + 1] = p.g; col[n * 3 + 2] = p.b;
          size[n] = p.size * (1 + p.grow * k);
          alpha[n] = Math.max(0, (1 - k) * p.fade);
          n++;
        }
        geo.setDrawRange(0, n);
        geo.attributes.position.needsUpdate = true;
        geo.attributes.pcolor.needsUpdate = true;
        geo.attributes.psize.needsUpdate = true;
        geo.attributes.palpha.needsUpdate = true;
      },
    };
  }
  const smokeFx = makeParticles(420, THREE.NormalBlending);
  const sparkFx = makeParticles(420, THREE.AdditiveBlending);

  // Drift charge tiers: the sparks change colour as the mini-turbo grows.
  const TIER_COLOR = [
    { r: 1.0, g: 0.95, b: 0.75 },  // not charged yet: warm dust
    { r: 0.35, g: 0.8, b: 1.0 },   // tier 1: blue
    { r: 1.0, g: 0.6, b: 0.15 },   // tier 2: orange
    { r: 0.85, g: 0.35, b: 1.0 },  // tier 3: purple
  ];

  // ---------- thunder bolt (the storm item), pooled like the explosions ----------
  const BOLT_SEGS = 7;
  const boltSegGeo = new THREE.BoxGeometry(7, 86, 7);
  const boltFlashGeo = new THREE.SphereGeometry(44, 12, 8);
  const boltMat = new THREE.MeshBasicMaterial({ color: 0xdff3ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const bolts = [];
  const boltPool = [];
  const MAX_BOLTS = 8;

  function buildBolt() {
    const grp = new THREE.Group();
    const segs = [];
    for (let i = 0; i < BOLT_SEGS; i++) {
      const seg = new THREE.Mesh(boltSegGeo, boltMat);
      grp.add(seg);
      segs.push(seg);
    }
    const flash = new THREE.Mesh(boltFlashGeo, boltMat.clone());
    grp.add(flash);
    grp.visible = false;
    scene.add(grp);
    return { grp, segs, flash, t: 0, light: null, live: false };
  }

  function bolt(x, y) {
    let b = boltPool.find((p) => !p.live);
    if (!b) {
      if (boltPool.length >= MAX_BOLTS) b = boltPool[0];
      else { b = buildBolt(); boltPool.push(b); }
    }
    if (b.live) freeLight(b.light);
    // re-jag the chain of segments from the sky down to the car
    let px = 0, pz = 0;
    b.segs.forEach((seg, i) => {
      const nx = (Math.random() - 0.5) * 34, nz = (Math.random() - 0.5) * 34;
      seg.position.set((px + nx) / 2, 600 - i * 86, (pz + nz) / 2);
      seg.rotation.set((nz - pz) / 120, 0, -(nx - px) / 120);
      seg.scale.set(1, 1, 1);
      px = nx; pz = nz;
    });
    b.flash.scale.setScalar(1);
    b.flash.material.opacity = 1;
    b.grp.position.set(x, 0, y);
    b.grp.visible = true;
    b.t = 0;
    b.live = true;
    b.light = takeLight(0xcfe9ff, 900);
    if (b.light) b.light.light.position.set(x, 90, y);
    if (!bolts.includes(b)) bolts.push(b);
  }

  function updateBolts(dt) {
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      if (!b.live) { bolts.splice(i, 1); continue; }
      b.t += dt;
      const k = b.t / 0.55;
      for (const seg of b.segs) {
        seg.visible = Math.random() > 0.15 && k < 1;   // flicker
        seg.scale.x = seg.scale.z = 1 + Math.random() * 0.5;
      }
      b.flash.scale.setScalar(1 + k * 2.5);
      b.flash.material.opacity = Math.max(0, 1 - k);
      if (b.light) b.light.light.intensity = Math.max(0, 60 * (1 - k * 1.4));
      if (k >= 1) {
        freeLight(b.light);
        b.light = null;
        b.live = false;
        b.grp.visible = false;
        bolts.splice(i, 1);
      }
    }
  }

  // ---------- homing missiles ----------
  const missileMat = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, metalness: 0.7, roughness: 0.3 });
  const missileFin = new THREE.MeshStandardMaterial({ color: 0xff3b30, roughness: 0.5 });
  const missiles = new Map();
  const missilePool = [];
  const tmpVec = new THREE.Vector3();
  // geometries built once at load, shared by every missile
  const missileBodyGeo = new THREE.CapsuleGeometry(4.6, 14, 6, 12); missileBodyGeo.rotateZ(-Math.PI / 2);
  const missileNoseGeo = new THREE.ConeGeometry(4.6, 10, 12);
  const missileFinGeo = new THREE.BoxGeometry(7, 1.2, 7);

  function makeMissile() {
    const spare = missilePool.pop();
    if (spare) { spare.grp.visible = true; spare.placed = false; return spare; }
    const grp = new THREE.Group();
    const m = new THREE.Mesh(missileBodyGeo, missileMat); m.castShadow = true; grp.add(m);
    const nose = new THREE.Mesh(missileNoseGeo, missileFin);
    nose.rotation.z = -Math.PI / 2; nose.position.x = 14; grp.add(nose);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fin = new THREE.Mesh(missileFinGeo, missileFin);
      fin.position.set(-11, Math.sin(a) * 4.5, Math.cos(a) * 4.5);
      fin.rotation.x = a;
      grp.add(fin);
    }
    scene.add(grp);
    return { grp, placed: false };
  }
  function recycleMissile(m) {
    m.grp.visible = false;      // kept in the scene and reused, never removed
    m.placed = false;
    if (missilePool.length < 6) missilePool.push(m);
  }

  // ---------- pedestrians ----------
  const skinTones = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
  const shirts = [0xe76f51, 0x2a9d8f, 0x264653, 0xf4a261, 0x8338ec, 0xff006e, 0x3a86ff, 0xffbe0b, 0x06d6a0];
  const pants = [0x22333b, 0x3d405b, 0x5e503f, 0x1d3557, 0x2b2d42];
  const peds = [];
  function makePed(i) {
    const r = rng(100 + i);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const skin = new THREE.MeshStandardMaterial({ color: pick(skinTones), roughness: 0.8 });
    const shirt = new THREE.MeshStandardMaterial({ color: pick(shirts), roughness: 0.8 });
    const pant = new THREE.MeshStandardMaterial({ color: pick(pants), roughness: 0.9 });
    const grp = new THREE.Group();
    const body = new THREE.Group(); grp.add(body);       // tips over when knocked down
    const limb = (w, h, d, mat, px, py, pz) => {
      const pivot = new THREE.Group(); pivot.position.set(px, py, pz);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.y = -h / 2; m.castShadow = true;
      pivot.add(m); body.add(pivot); return pivot;
    };
    const legL = limb(4.5, 17, 4.5, pant, 0, 17, -3);
    const legR = limb(4.5, 17, 4.5, pant, 0, 17, 3);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(7, 15, 11), shirt); torso.position.y = 24.5; torso.castShadow = true; body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(4.6, 12, 10), skin); head.position.y = 36.5; head.castShadow = true; body.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(4.8, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: pick([0x1b1b1b, 0x4a2c17, 0x8b5a2b, 0xd9b26f]), roughness: 0.9 }));
    hair.position.y = 37; body.add(hair);
    const armL = limb(3.5, 14, 3.5, shirt, 0, 31, -7.2);
    const armR = limb(3.5, 14, 3.5, shirt, 0, 31, 7.2);
    scene.add(grp);
    return { grp, body, legL, legR, armL, armR, phase: r() * 6, x: null, y: 0, h: 0 };
  }
  function updatePeds(list, dt) {
    if (!list) return;
    while (peds.length < list.length) peds.push(makePed(peds.length));
    list.forEach(([x, y, h, walking, down], i) => {
      const p = peds[i];
      if (p.x === null || Math.hypot(x - p.x, y - p.y) > 200) { p.x = x; p.y = y; }
      const k = Math.min(1, dt * 10);
      p.x += (x - p.x) * k; p.y += (y - p.y) * k;
      p.h = S.angleLerp(p.h, h, Math.min(1, dt * 8));
      p.grp.position.set(p.x, 0, p.y);
      p.grp.rotation.y = -p.h;
      if (walking) p.phase += dt * 7;
      const swing = walking ? Math.sin(p.phase) * 0.55 : 0;
      p.legL.rotation.z = swing; p.legR.rotation.z = -swing;
      p.armL.rotation.z = -swing * 0.8; p.armR.rotation.z = swing * 0.8;
      // knocked over: fall onto their side, lie there, then get back up (down counts 3.5 -> 0)
      let fall = 0;
      if (down > 3.2) fall = (3.5 - down) / 0.3;
      else if (down > 0.8) fall = 1;
      else if (down > 0) fall = down / 0.8;
      p.body.rotation.x = fall * (Math.PI / 2 - 0.05);
      p.body.position.y = fall * 3;
    });
  }

  // ---------- cars ----------
  const tireGeo = new THREE.CylinderGeometry(5.3, 5.3, 4.6, 18); tireGeo.rotateX(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(3, 3, 4.9, 10); hubGeo.rotateX(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.85, roughness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x15222f, metalness: 0.6, roughness: 0.12 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1f2125, roughness: 0.55, metalness: 0.2 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.4 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 1.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2222, emissiveIntensity: 1.0 });
  const flameGeo = new THREE.ConeGeometry(3.2, 16, 10); flameGeo.rotateZ(Math.PI / 2); flameGeo.translate(-8, 0, 0);
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const flameCore = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });

  function makeLabel(text, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 30px system-ui, sans-serif';
    const tw = Math.min(248, g.measureText(text).width + 52);
    const x0 = (256 - tw) / 2;
    g.fillStyle = 'rgba(10,14,20,0.72)'; rr(g, x0, 10, tw, 44, 14); g.fill();
    g.fillStyle = color; g.beginPath(); g.arc(x0 + 22, 32, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, x0 + 38, 33, tw - 46);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
    s.scale.set(64, 16, 1);
    s.position.y = 44;
    s.renderOrder = 10;
    return s;
  }

  const shieldGeo = new THREE.SphereGeometry(34, 24, 16);
  const shieldMat = new THREE.MeshBasicMaterial({ color: 0x5ee7ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });

  function makeCar(color, name) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.3 });
    box(46, 3, 23, darkMat, 0, 5.5, 0, body);       // skirt / bumpers
    box(44, 8, 22, paint, 0, 9.5, 0, body);         // main body
    box(15, 3, 20, paint, 13, 14.5, 0, body);       // hood
    box(15.2, 3.1, 3, stripeMat, 13, 14.5, 0, body); // racing stripe
    box(18, 8, 19, glassMat, -3, 17.5, 0, body);    // cabin glass
    box(14, 1.6, 18, paint, -4, 22.2, 0, body);     // roof
    box(14.2, 1.7, 3, stripeMat, -4, 22.2, 0, body);
    box(2, 6, 2, darkMat, -19, 16, -7, body);       // spoiler
    box(2, 6, 2, darkMat, -19, 16, 7, body);
    box(5, 1.4, 24, darkMat, -20, 19.6, 0, body);
    box(1, 2.6, 5, headMat, 22.1, 10.5, -7.5, body); // headlights
    box(1, 2.6, 5, headMat, 22.1, 10.5, 7.5, body);
    box(1, 2.6, 6, tailMat, -22.1, 10.5, -7, body);  // tail lights
    box(1, 2.6, 6, tailMat, -22.1, 10.5, 7, body);

    const front = [], spins = [];
    for (const [x, z] of [[14, -11.6], [14, 11.6], [-14, -11.6], [-14, 11.6]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 5.3, z);
      const spin = new THREE.Group();
      pivot.add(spin);
      for (const [geo, mat] of [[tireGeo, tireMat], [hubGeo, hubMat]]) {
        const m = new THREE.Mesh(geo, mat); m.castShadow = true; spin.add(m);
      }
      group.add(pivot);
      spins.push(spin);
      if (x > 0) front.push(pivot);
    }
    const flames = new THREE.Group();
    const flameSkin = flameMat.clone(), coreSkin = flameCore.clone(); // per car, so we can tint by boost tier
    for (const z of [-6, 6]) {
      const f = new THREE.Mesh(flameGeo, flameSkin); f.position.set(-22, 7.5, z); flames.add(f);
      const c = new THREE.Mesh(flameGeo, coreSkin); c.position.set(-22, 7.5, z); c.scale.set(0.55, 0.5, 0.5); flames.add(c);
    }
    flames.visible = false;
    body.add(flames);
    const shield = new THREE.Mesh(shieldGeo, shieldMat);
    shield.position.y = 12; shield.visible = false;
    group.add(shield);
    const label = makeLabel(name, color);
    group.add(label);
    scene.add(group);
    return {
      group, body, front, spins, label, flames, shield, flameSkin, coreSkin,
      prev: null, steer: 0, spin: 0, pitch: 0, roll: 0, trickRoll: 0,
      emit: 0, wasAir: false, spinDir: Math.random() < 0.5 ? -1 : 1,
    };
  }

  const cars = new Map();

  function syncCars(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      if (!cars.has(p.id)) cars.set(p.id, makeCar(p.color, p.name));
    }
    for (const [id, car] of cars) {
      if (!seen.has(id)) { scene.remove(car.group); cars.delete(id); }
    }
  }

  function updateCar(car, p, dt, now) {
    car.group.position.set(p.x, p.z || 0, p.y);
    const wantPitch = clamp(Math.atan2(p.vz || 0, Math.max(Math.abs(p.speed || 0), 60)), -0.5, 0.5);
    car.pitch += (wantPitch - car.pitch) * Math.min(1, dt * 12);
    // spin-out animation: two full turns that slow down, ending facing forward again
    let spinOff = 0;
    if ((p.stun || 0) > 0) {
      const f = 1 - p.stun / CONFIG.STUN_TIME;
      spinOff = car.spinDir * 4 * Math.PI * (1 - (1 - f) * (1 - f));
    }
    car.group.rotation.set(0, -(p.angle + spinOff), car.pitch);
    car.shield.visible = !!p.shield;
    if (p.shield) car.shield.scale.setScalar(1 + Math.sin(now / 120) * 0.04);

    // ---- boost flames, tinted by what earned the boost ----
    const tier = clamp(p.bt || 0, 0, 3);
    car.flames.visible = (p.boost || 0) > 0;
    if (car.flames.visible) {
      car.flames.scale.set(0.8 + Math.random() * 0.5 + tier * 0.12, 1, 1);
      const c = TIER_COLOR[tier];
      if (tier === 0) car.flameSkin.color.setRGB(1, 0.54, 0.12);
      else car.flameSkin.color.setRGB(c.r, c.g, c.b);
      car.coreSkin.color.setRGB(1, 0.95, 0.72);
    }

    // ---- drift lean + mid-air barrel roll ----
    const drift = p.drift || 0;
    const wantRoll = drift ? drift * 0.17 : 0;
    car.roll += (wantRoll - car.roll) * Math.min(1, dt * 9);
    car.trickRoll = (p.trick || 0) > 0 ? (p.trick || 0) * 9.5 : 0;

    // ---- tyre smoke and charge sparks ----
    const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
    const at = (lx, lz) => [p.x + lx * ca - lz * sa, (p.z || 0) + 4, p.y + lx * sa + lz * ca];
    car.emit += dt;
    const step = 1 / 45;
    const chargeTier = S.driftTier(p.charge || 0);
    while (car.emit > step) {
      car.emit -= step;
      if (drift && !p.air) {
        for (const side of [-11.6, 11.6]) {
          const [x, y, z] = at(-14, side);
          const grey = 0.72 + Math.random() * 0.2;
          smokeFx.spawn(x, y, z, {
            vx: -ca * 30 + (Math.random() - 0.5) * 50, vy: 16 + Math.random() * 20, vz: -sa * 30 + (Math.random() - 0.5) * 50,
            life: 0.45 + Math.random() * 0.3, size: 7 + Math.random() * 5, grow: 1.6,
            r: grey, g: grey, b: grey * 1.02, fade: 0.5,
          });
          if (chargeTier > 0) {
            const col = TIER_COLOR[chargeTier];
            for (let i = 0; i < 2; i++) {
              sparkFx.spawn(x, y, z, {
                vx: -ca * 120 + (Math.random() - 0.5) * 160, vy: 40 + Math.random() * 90, vz: -sa * 120 + (Math.random() - 0.5) * 160,
                life: 0.22 + Math.random() * 0.18, size: 2.6 + Math.random() * 2.4, grow: -0.5,
                r: col.r, g: col.g, b: col.b, gravity: 260, drag: 0.6,
              });
            }
          }
        }
      }
      if ((p.boost || 0) > 0) {
        const [x, y, z] = at(-26, (Math.random() - 0.5) * 12);
        const col = TIER_COLOR[tier];
        sparkFx.spawn(x, y + 3, z, {
          vx: -ca * 90, vy: 20 + Math.random() * 30, vz: -sa * 90,
          life: 0.22 + Math.random() * 0.14, size: 4 + Math.random() * 4, grow: 1.2,
          r: tier ? col.r : 1, g: tier ? col.g : 0.6, b: tier ? col.b : 0.2, drag: 2.2,
        });
      }
    }
    // dust kicked up on landing
    if (car.wasAir && !p.air) {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 130;
        smokeFx.spawn(p.x, 3, p.y, {
          vx: Math.cos(a) * sp, vy: 20 + Math.random() * 40, vz: Math.sin(a) * sp,
          life: 0.6 + Math.random() * 0.4, size: 9 + Math.random() * 7, grow: 1.8,
          r: 0.78, g: 0.74, b: 0.66, fade: 0.55,
        });
      }
    }
    car.wasAir = !!p.air;

    if (car.prev && dt > 0) {
      const dist = Math.hypot(p.x - car.prev.x, p.y - car.prev.y);
      if (dist < 100) car.spin -= ((p.speed || 0) < 0 ? -1 : 1) * dist / 5.3;
      const turn = S.wrapAngle(p.angle - car.prev.angle) / dt / PHYS.TURN_RATE;
      car.steer += (clamp(turn, -1, 1) * 0.5 - car.steer) * Math.min(1, dt * 10);
    }
    car.prev = { x: p.x, y: p.y, angle: p.angle };
    for (const s of car.spins) s.rotation.z = car.spin;
    for (const f of car.front) f.rotation.y = -car.steer - (p.drift || 0) * 0.35;
    // body roll in corners, leaning into a drift, spinning through an air stunt
    car.body.rotation.x = -car.steer * 0.07 + car.roll + car.trickRoll;
  }

  // ---------- camera ----------
  const cam = {
    pos: new THREE.Vector3(CX + 2300, 1100, CZ),
    look: new THREE.Vector3(CX, 0, CZ),
    heading: 0,
    fov: 70,
  };
  const tPos = new THREE.Vector3(), tLook = new THREE.Vector3();
  let shakeAmt = 0;

  function updateCamera(mode, focus, dt, now) {
    let k;
    if (mode === 'overview' || !focus) {
      const t = now * 0.00004;
      const orbit = Math.max(WW, WH) * 0.74; // keep the whole circuit in shot on any track size
      tPos.set(CX + Math.cos(t) * orbit, orbit * 0.49, CZ + Math.sin(t) * orbit);
      tLook.set(CX, 0, CZ);
      k = 1 - Math.exp(-dt * 2);
    } else if (mode === 'hood') {
      const hx = Math.cos(focus.angle), hz = Math.sin(focus.angle);
      const fz = focus.z || 0;
      tPos.set(focus.x + hx * 4, 24.5 + fz, focus.y + hz * 4);
      tLook.set(focus.x + hx * 260, 17 + fz, focus.y + hz * 260);
      cam.heading = focus.angle;
      k = 1;
    } else { // chase
      // while drifting, let the camera trail the car's heading a little more loosely:
      // you see the car slide sideways instead of it staying glued to the screen centre
      const slide = (focus.drift || 0) * 0.3;
      cam.heading = S.angleLerp(cam.heading, focus.angle - slide, 1 - Math.exp(-dt * (focus.drift ? 4 : 6)));
      const hx = Math.cos(cam.heading), hz = Math.sin(cam.heading);
      const fz = focus.z || 0;
      const back = 80 + ((focus.boost || 0) > 0 ? 12 : 0); // pull back under power
      tPos.set(focus.x - hx * back, 32 + fz * 0.8, focus.y - hz * back);
      tLook.set(focus.x + hx * 45, 12 + fz, focus.y + hz * 45);
      k = 1 - Math.exp(-dt * 12);
    }
    cam.pos.lerp(tPos, k);
    cam.look.lerp(tLook, k);
    camera.position.copy(cam.pos);
    camera.lookAt(cam.look);
    if (shakeAmt > 0.05) {
      camera.position.x += (Math.random() - 0.5) * shakeAmt;
      camera.position.y += (Math.random() - 0.5) * shakeAmt;
      camera.position.z += (Math.random() - 0.5) * shakeAmt;
      shakeAmt *= Math.exp(-dt * 7);
    }

    const speedFrac = focus ? clamp(Math.abs(focus.speed || 0) / PHYS.MAX_SPEED, 0, 1.45) : 0;
    const kick = focus && (focus.boost || 0) > 0 ? 7 : 0; // boost punches the view wide open
    const wantFov = mode === 'overview' ? 55 : (mode === 'hood' ? 72 : 66) + speedFrac * 14 + kick;
    cam.fov += (wantFov - cam.fov) * Math.min(1, dt * 4);
    if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  }

  // ---------- public API ----------
  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function updateWorld(world, dt, now) {
    if (!world) return;
    // item boxes: spin, bob, pop in/out
    itemBoxes.forEach((b, i) => {
      const active = world.boxes[i] === '1';
      b.scale += ((active ? 1 : 0) - b.scale) * Math.min(1, dt * 10);
      b.mesh.visible = b.scale > 0.02;
      b.mesh.scale.setScalar(b.scale);
      b.mesh.rotation.set(now / 900 + b.phase, now / 700 + b.phase, 0);
      b.mesh.position.y = 20 + Math.sin(now / 300 + b.phase) * 3;
      b.mat.color.setHSL(((now / 3000) + i * 0.08) % 1, 0.75, 0.6);
    });
    // oil slicks
    const oilIds = new Set();
    for (const [id, x, y] of world.oils) {
      oilIds.add(id);
      if (!oils.has(id)) {
        const m = new THREE.Mesh(oilGeo, oilMat);
        m.rotation.set(-Math.PI / 2, 0, Math.random() * 6.28);
        m.position.set(x, 1.8, y);
        m.receiveShadow = true;
        m.scale.setScalar(0.2);
        scene.add(m);
        oils.set(id, m);
      }
      const m = oils.get(id);
      m.scale.setScalar(Math.min(1, m.scale.x + dt * 4)); // spreads out
    }
    for (const [id, m] of oils) if (!oilIds.has(id)) { scene.remove(m); oils.delete(id); }
    // bombs
    const bombIds = new Set();
    for (const [id, x, y, z] of world.bombs) {
      bombIds.add(id);
      if (!bombs.has(id)) bombs.set(id, makeBomb());
      const b = bombs.get(id);
      b.grp.position.lerp(new THREE.Vector3(x, Math.max(6, z), y), b.placed ? Math.min(1, dt * 18) : 1);
      b.placed = true;
      b.grp.rotation.x += dt * 9;
      b.spark.scale.setScalar(0.7 + Math.random() * 0.8);
    }
    for (const [id, b] of bombs) if (!bombIds.has(id)) { scene.remove(b.grp); bombs.delete(id); }
    // homing missiles, with a smoke trail
    const msIds = new Set();
    for (const [id, x, y, ang] of world.missiles || []) {
      msIds.add(id);
      if (!missiles.has(id)) missiles.set(id, makeMissile());
      const m = missiles.get(id);
      if (m.placed) m.grp.position.lerp(tmpVec.set(x, 21, y), Math.min(1, dt * 22));
      else m.grp.position.set(x, 21, y);
      m.placed = true;
      m.grp.rotation.set(0, -ang, Math.sin(now / 90) * 0.12);
      const tx = m.grp.position.x - Math.cos(ang) * 16, tz = m.grp.position.z - Math.sin(ang) * 16;
      smokeFx.spawn(tx, 21, tz, {
        vx: (Math.random() - 0.5) * 30, vy: 8, vz: (Math.random() - 0.5) * 30,
        life: 0.5, size: 5 + Math.random() * 4, grow: 2.2, r: 0.85, g: 0.85, b: 0.88, fade: 0.5, drag: 1.8,
      });
      sparkFx.spawn(tx, 21, tz, {
        vx: 0, vy: 0, vz: 0, life: 0.14, size: 5, grow: 0.6, r: 1, g: 0.62, b: 0.2,
      });
    }
    for (const [id, m] of missiles) if (!msIds.has(id)) { recycleMissile(m); missiles.delete(id); }
    updatePeds(world.peds, dt);
  }

  function render({ list, myId, mode, focus, dt, now, world }) {
    updateWorld(world, dt, now);
    updateExplosions(dt);
    updateBolts(dt);
    syncCars(list);
    for (const p of list) {
      const car = cars.get(p.id);
      updateCar(car, p, dt, now);
      car.label.visible = !(p.id === myId && mode !== 'overview');
    }
    updateCamera(mode, focus, dt, now);

    const fx = focus && mode !== 'overview' ? focus.x : CX;
    const fz = focus && mode !== 'overview' ? focus.y : CZ;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + SUN_DIR.x * 1600, SUN_DIR.y * 1600, fz + SUN_DIR.z * 1600);
    sky.position.copy(camera.position);
    padTex.offset.x = -(now / 1000) * 1.5; // arrows scroll forward
    smokeFx.update(dt);
    sparkFx.update(dt);

    renderer.render(scene, camera);
  }

  function shake(amount) { shakeAmt = Math.max(shakeAmt, amount); }

  // Build the effect pools and compile their shaders during loading. three.js only
  // compiles a material the first time it is actually drawn, so without this the first
  // explosion / bolt / missile of the race costs a long stutter.
  function prewarm() {
    for (let i = 0; i < 3; i++) explosionPool.push(buildExplosion());
    for (let i = 0; i < 4; i++) boltPool.push(buildBolt());
    const warm = [makeMissile(), makeMissile()];
    const show = (v) => {
      for (const e of explosionPool) {
        e.fire.visible = v; e.core.visible = v;
        for (const p of e.puffs) p.m.visible = v;
        for (const d of e.debris) d.m.visible = v;
      }
      for (const b of boltPool) b.grp.visible = v;
      for (const m of warm) m.grp.visible = v;
    };
    show(true);
    try { renderer.compile(scene, camera); } catch (e) { /* not fatal, just slower first use */ }
    show(false);
    for (const m of warm) recycleMissile(m);
  }
  prewarm();

  return { resize, render, shake, explode, bolt, _debug: { scene, camera, renderer } };
}
