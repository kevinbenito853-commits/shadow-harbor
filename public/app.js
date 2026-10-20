import * as THREE from 'three';

const $ = id => document.getElementById(id);
const TCOLOR = { walk: '#7f8aa6', bus: '#e8a33d', tram: '#3fbfae', ferry: '#6aa7ff', secret: '#c9a8ff' };
const TNAME = { walk: 'Walk', bus: 'Bus', tram: 'Tram', secret: 'Secret' };

let ws, session = null, MAPD = null, S = null;
let doubleArmed = false, pending = null, overShown = false, lastTurnId = null, sheetOpen = false;
try { session = JSON.parse(localStorage.getItem('sy_session') || 'null'); } catch {}
$('name').value = localStorage.getItem('sy_name') || '';

// ---------- networking ----------
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { if (session) ws.send(JSON.stringify({ type: 'rejoin', code: session.code, token: session.token })); };
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'joined') {
      session = { code: m.code, token: m.token, id: m.id };
      localStorage.setItem('sy_session', JSON.stringify(session));
      MAPD = m.map; buildBoard();
    } else if (m.type === 'state') { S = m; render(); }
    else if (m.type === 'error') { toast(m.msg); $('homeErr').textContent = m.msg; $('lobErr').textContent = m.msg; }
    else if (m.type === 'expired') { clearSession(); }
  };
}
function sendMsg(o) {
  if (!ws || ws.readyState !== 1) return toast('Connecting… try again in a moment.');
  ws.send(JSON.stringify(o));
}
function clearSession() {
  session = null; S = null; localStorage.removeItem('sy_session'); show('home');
}
function toast(t) {
  const el = $('toast'); el.textContent = t; el.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 2600);
}
function show(id) {
  ['home', 'lobby', 'game'].forEach(s => $(s).classList.toggle('on', s === id));
  if (id === 'game') onResize();
}

// ---------- home / lobby ----------
function myName() { const n = $('name').value.trim(); localStorage.setItem('sy_name', n); return n; }
$('btnCreate').onclick = () => { $('homeErr').textContent = ''; sendMsg({ type: 'create', name: myName() }); };
$('btnJoin').onclick = () => { $('homeErr').textContent = ''; sendMsg({ type: 'join', name: myName(), code: $('codeIn').value }); };
$('btnStart').onclick = () => { $('lobErr').textContent = ''; sendMsg({ type: 'start' }); };
$('btnLeave').onclick = () => { sendMsg({ type: 'leave' }); clearSession(); };
$('btnAddBot').onclick = () => { $('lobErr').textContent = ''; sendMsg({ type: 'addbot' }); };
$('lobPlayers').onclick = e => {
  const b = e.target.closest('[data-rm]');
  if (b) sendMsg({ type: 'removebot', id: b.dataset.rm });
};

function renderLobby() {
  const host = S.hostId === S.youId;
  $('lobCode').textContent = S.code;
  $('lobPlayers').innerHTML = S.players.map(p =>
    `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === S.youId ? ' (you)' : ''}` +
    `<span class="tag">${p.id === S.hostId ? 'host' : ''}${p.bot ? 'computer' : ''}${p.connected ? '' : ' · offline'}</span>` +
    (p.bot && host ? `<button class="rm" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : '') + `</li>`).join('');
  $('btnStart').style.display = host ? '' : 'none';
  $('btnAddBot').style.display = host ? '' : 'none';
  $('btnStart').disabled = S.players.length < 2;
  $('btnAddBot').disabled = S.players.length >= 6;
  $('lobHint').textContent = host
    ? (S.players.length < 2 ? 'Invite a friend with the code, or add a computer player.' : 'Roles are assigned randomly when you start.')
    : 'Waiting for the host to start…';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 3D board ----------
const canvas = $('map'), wrap = $('mapwrap');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b101d);
const camera = new THREE.PerspectiveCamera(45, 1, 5, 6000);
scene.add(new THREE.HemisphereLight(0xb5ccff, 0x1a2238, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(-350, 650, 250); scene.add(sun);

const raycaster = new THREE.Raycaster();
const matCache = new Map();
function mat(color, { opacity = 1, glow = 0.25, basic = false } = {}) {
  const k = `${color}|${opacity}|${glow}|${basic}`;
  if (!matCache.has(k)) {
    matCache.set(k, basic
      ? new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow, roughness: 0.6, metalness: 0.1, transparent: opacity < 1, opacity }));
  }
  return matCache.get(k);
}
const labelCache = new Map();
function label(text, { color = '#cfd7ea', size = 15, font = 44 } = {}) {
  const k = `${text}|${color}`;
  if (!labelCache.has(k)) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = `800 ${font}px system-ui, sans-serif`;
    const w = Math.ceil(g.measureText(text).width) + 24, h = font + 20;
    c.width = w; c.height = h;
    g.font = `800 ${font}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(8,12,22,.9)'; g.strokeText(text, w / 2, h / 2 + 2);
    g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 2);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    labelCache.set(k, { tex, aspect: w / h });
  }
  const { tex, aspect } = labelCache.get(k);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size * aspect, size, 1);
  return s;
}
const P3 = n => new THREE.Vector3(n.x - MAPD.width / 2, 0, n.y - MAPD.height / 2);

let boardGroup = null, markGroup = new THREE.Group(), tokenGroup = new THREE.Group();
const pickables = [], tokens = new Map(), pulses = [];
scene.add(markGroup, tokenGroup);

function road(parent, A, B, width, height, material, y) {
  const a = P3(A), b = P3(B), len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, height, width), material);
  m.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2);
  m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  parent.add(m);
  return m;
}
function segDist(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
  return Math.hypot(p.x - (a.x + t * abx), p.z - (a.z + t * abz));
}
function buildBoard() {
  if (boardGroup) { scene.remove(boardGroup); boardGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  boardGroup = new THREE.Group(); scene.add(boardGroup);
  pickables.length = 0;
  const W = MAPD.width, H = MAPD.height;

  const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0x0a1c33, roughness: 0.35, metalness: 0.3 }));
  water.rotation.x = -Math.PI / 2; water.position.y = -14; boardGroup.add(water);
  const land = new THREE.Mesh(new THREE.BoxGeometry(W + 90, 12, H + 90), new THREE.MeshStandardMaterial({ color: 0x172036, roughness: 0.9 }));
  land.position.y = -6; boardGroup.add(land);
  const grid = new THREE.GridHelper(Math.max(W, H) + 90, 40, 0x24304d, 0x1b2540);
  grid.position.y = 0.2; grid.scale.set((W + 90) / (Math.max(W, H) + 90), 1, (H + 90) / (Math.max(W, H) + 90)); boardGroup.add(grid);

  // city blocks (decoration only), kept clear of stations and streets
  const nodes3 = MAPD.nodes.map(P3);
  const segs = MAPD.edges.map(e => [nodes3[e.a - 1], nodes3[e.b - 1]]);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blocks = [];
  for (let i = 0; i < 2200 && blocks.length < 230; i++) {
    const p = new THREE.Vector3((rnd() - 0.5) * (W + 40), 0, (rnd() - 0.5) * (H + 40));
    const w = 10 + rnd() * 16, d = 10 + rnd() * 16, reach = Math.max(w, d) * 0.75 + 4;
    if (nodes3.some(n => n.distanceTo(p) < reach + 20)) continue;
    if (segs.some(([a, b]) => segDist(p, a, b) < reach + 4)) continue;
    if (blocks.some(q => Math.hypot(q.p.x - p.x, q.p.z - p.z) < (q.r + reach))) continue;
    blocks.push({ p, w, d, h: 5 + Math.pow(rnd(), 2) * 38, r: reach });
  }
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 }), blocks.length);
  const tmp = new THREE.Object3D(), col = new THREE.Color();
  blocks.forEach((b, i) => {
    tmp.position.set(b.p.x, b.h / 2, b.p.z); tmp.scale.set(b.w, b.h, b.d); tmp.rotation.y = rnd() * 0.3; tmp.updateMatrix();
    inst.setMatrixAt(i, tmp.matrix);
    inst.setColorAt(i, col.setHSL(0.6 + rnd() * 0.06, 0.25, 0.14 + rnd() * 0.12));
  });
  boardGroup.add(inst);

  // routes
  const order = { ferry: 0, tram: 1, bus: 2, walk: 3 };
  [...MAPD.edges].sort((a, b) => order[a.t] - order[b.t]).forEach(e => {
    const A = MAPD.nodes[e.a - 1], B = MAPD.nodes[e.b - 1], c = TCOLOR[e.t];
    if (e.t === 'walk') road(boardGroup, A, B, 3.2, 0.8, mat(c, { glow: 0.2 }), 0.7);
    else if (e.t === 'bus') road(boardGroup, A, B, 5.5, 1, mat(c, { opacity: 0.9, glow: 0.35 }), 1.2);
    else if (e.t === 'tram') road(boardGroup, A, B, 10, 0.6, mat(c, { opacity: 0.5, glow: 0.45 }), 0.4);
    else {
      const a = P3(A), b = P3(B), n = Math.ceil(a.distanceTo(b) / 14);
      for (let i = 0; i <= n; i++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(2, 10, 8), mat(c, { glow: 0.6 }));
        d.position.lerpVectors(a, b, i / n); d.position.y = 1.5; boardGroup.add(d);
      }
    }
  });

  // stations
  const baseGeo = new THREE.CylinderGeometry(11, 12, 3, 28), ringGeo = new THREE.TorusGeometry(11.5, 1.1, 8, 36);
  const pickGeo = new THREE.CylinderGeometry(19, 19, 2, 20);
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  MAPD.nodes.forEach(n => {
    const p = P3(n);
    const base = new THREE.Mesh(baseGeo, mat(0x101728, { glow: 0 })); base.position.set(p.x, 1.5, p.z); boardGroup.add(base);
    if (n.tram || n.bus) {
      const ring = new THREE.Mesh(ringGeo, mat(n.tram ? TCOLOR.tram : TCOLOR.bus, { glow: 0.7 }));
      ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 3.2, p.z); boardGroup.add(ring);
    }
    if (n.tram && n.bus) {
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(7.6, 0.9, 8, 30), mat(TCOLOR.bus, { glow: 0.7 }));
      ring2.rotation.x = Math.PI / 2; ring2.position.set(p.x, 3.2, p.z); boardGroup.add(ring2);
    }
    const num = label(String(n.id), { size: 13 }); num.position.set(p.x, 9, p.z); boardGroup.add(num);
    const pick = new THREE.Mesh(pickGeo, pickMat); pick.position.set(p.x, 2, p.z); pick.userData.id = n.id;
    boardGroup.add(pick); pickables.push(pick);
  });
  placeCamera();
}

// ---------- camera (fixed: the whole map is always in view) ----------
// Steep tilt so it reads as a top-down map but buildings and tokens still show depth.
// On a tall (portrait) screen the board is turned 90° so its long side runs up the screen.
function placeCamera() {
  if (!MAPD) return;
  const portrait = camera.aspect < 1 && MAPD.width > MAPD.height;
  const sw = portrait ? MAPD.height : MAPD.width, sh = portrait ? MAPD.width : MAPD.height;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(sh * 0.66 / t, sw * 0.58 / (t * camera.aspect));
  const dir = portrait ? new THREE.Vector3(-0.42, 0.9, 0) : new THREE.Vector3(0, 0.9, 0.42);
  camera.position.copy(dir.normalize().multiplyScalar(dist));
  camera.lookAt(0, 0, 0);
}

function onResize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix(); placeCamera();
}
new ResizeObserver(onResize).observe(wrap);
window.addEventListener('resize', onResize);

// ---------- picking ----------
let down = null, multi = false, active = 0;
canvas.addEventListener('pointerdown', e => {
  active++;
  if (active > 1) multi = true;
  else { multi = false; down = { x: e.clientX, y: e.clientY, t: performance.now() }; }
});
window.addEventListener('pointercancel', () => { active = 0; down = null; });
window.addEventListener('pointerup', e => {
  active = Math.max(0, active - 1);
  if (active > 0) return;
  const d = down; down = null;
  if (!d || multi) return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 700) return;
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (hit) onNode(hit.object.userData.id);
});

// ---------- tokens + marks ----------
function makeToken(p) {
  const g = new THREE.Group();
  if (p.role === 'shadow') {
    const body = new THREE.Mesh(new THREE.ConeGeometry(8, 24, 20), mat(0x1a1026, { glow: 0.5 })); body.position.y = 13;
    const head = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 16), mat(0x2a1a44, { glow: 0.9 })); head.position.y = 29;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 1.4, 8, 36), mat(0xc9a8ff, { glow: 1.2 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 3; g.add(body, head, ring);
  } else {
    const c = new THREE.Color(p.color);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 3, 24), mat(0xffffff, { glow: 0.3 })); base.position.y = 4;
    const body = new THREE.Mesh(new THREE.ConeGeometry(7.5, 20, 20), mat(c.getHex(), { glow: 0.45 })); body.position.y = 15;
    const head = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 16), mat(c.getHex(), { glow: 0.55 })); head.position.y = 29;
    g.add(base, body, head);
  }
  const tag = label(p.role === 'shadow' ? '🌑 ' + p.name : p.name, { color: p.role === 'shadow' ? '#e4d5ff' : '#ffffff', size: 12, font: 40 });
  tag.position.y = 46; g.add(tag);
  const turn = new THREE.Mesh(new THREE.TorusGeometry(17, 1.6, 8, 40), mat(p.role === 'shadow' ? 0xc9a8ff : new THREE.Color(p.color).getHex(), { opacity: 0.8, glow: 1 }));
  turn.rotation.x = Math.PI / 2; turn.position.y = 2; g.add(turn);
  tokenGroup.add(g);
  return { g, turn, role: p.role, color: p.color, over: false, target: new THREE.Vector3() };
}
function clearGroup(grp) { while (grp.children.length) grp.remove(grp.children[0]); }

function renderMarks() {
  clearGroup(markGroup); pulses.length = 0;
  const gold = 0xf2b134, purple = 0xc9a8ff;
  if (S.lastKnown) {
    const p = P3(MAPD.nodes[S.lastKnown.pos - 1]);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(18, 1.5, 8, 40), mat(gold, { glow: 1 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 4, p.z); markGroup.add(ring);
    const t = label(`seen at move ${S.lastKnown.n}`, { color: '#f2b134', size: 12, font: 40 }); t.position.set(p.x, 62, p.z); markGroup.add(t);
  }
  if (S.phase === 'over' && S.log.length) {
    const pts = S.log.filter(l => l.pos);
    for (let i = 1; i < pts.length; i++) road(markGroup, MAPD.nodes[pts[i - 1].pos - 1], MAPD.nodes[pts[i].pos - 1], 3.4, 1.2, mat(purple, { opacity: 0.85, glow: 1 }), 5);
    pts.forEach(l => {
      const p = P3(MAPD.nodes[l.pos - 1]), t = label(String(l.n), { color: '#c9a8ff', size: 11, font: 40 });
      t.position.set(p.x + 12, 24, p.z - 12); markGroup.add(t);
    });
  }
  const seen = new Set();
  optionsNow().forEach(o => {
    if (seen.has(o.to)) return; seen.add(o.to);
    const p = P3(MAPD.nodes[o.to - 1]), c = new THREE.Color(TCOLOR[o.t]).getHex();
    const ring = new THREE.Mesh(new THREE.RingGeometry(14, 19.5, 40), new THREE.MeshBasicMaterial({ color: c, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 5, p.z); markGroup.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 30, 10), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45, depthWrite: false }));
    beam.position.set(p.x, 20, p.z); markGroup.add(beam);
    pulses.push(ring.material, beam.material);
  });
  if (pending) {
    const p = P3(MAPD.nodes[pending.to - 1]);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(15, 1.8, 8, 36), mat(purple, { glow: 1.2 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 5, p.z); markGroup.add(ring);
    const t = label('1', { color: '#ffffff', size: 16, font: 48 }); t.position.set(p.x, 30, p.z); markGroup.add(t);
  }
  syncTokens();
}
function syncTokens() {
  const alive = new Set();
  S.players.forEach(p => {
    if (!p.pos) return;
    alive.add(p.id);
    let tk = tokens.get(p.id);
    if (tk && (tk.role !== p.role || tk.color !== p.color)) { tokenGroup.remove(tk.g); tokens.delete(p.id); tk = null; }
    if (!tk) { tk = makeToken(p); tokens.set(p.id, tk); tk.g.position.copy(P3(MAPD.nodes[p.pos - 1])); }
    tk.target.copy(P3(MAPD.nodes[p.pos - 1]));
    tk.turn.visible = S.phase === 'playing' && p.id === S.turnId;
    tk.g.scale.setScalar(p.role === 'shadow' && S.phase === 'over' ? 1.3 : 1);
  });
  for (const [id, tk] of tokens) if (!alive.has(id)) { tokenGroup.remove(tk.g); tokens.delete(id); }
}

const clock = new THREE.Clock();
(function tick() {
  requestAnimationFrame(tick);
  if (!MAPD || !$('game').classList.contains('on')) return;
  const t = clock.getElapsedTime();
  tokens.forEach(tk => {
    const g = tk.g.position, dx = tk.target.x - g.x, dz = tk.target.z - g.z, dist = Math.hypot(dx, dz);
    g.x += dx * 0.11; g.z += dz * 0.11;
    g.y = Math.min(dist * 0.35, 28) + (tk.turn.visible ? Math.sin(t * 3) * 1.6 + 1.6 : 0);
    tk.turn.scale.setScalar(1 + Math.sin(t * 4) * 0.06);
  });
  const o = 0.55 + Math.sin(t * 5) * 0.4;
  pulses.forEach((m, i) => { m.opacity = i % 2 ? o * 0.5 : o; });
  renderer.render(scene, camera);
})();

// ---------- game logic (client side helpers) ----------
const me = () => S.players.find(p => p.id === S.youId);
const myTurn = () => S.phase === 'playing' && S.turnId === S.youId;
function detPositions(exceptId) { return new Set(S.players.filter(p => p.role === 'detective' && p.id !== exceptId && p.pos).map(p => p.pos)); }
function optionsNow() {
  if (!S || !MAPD || !myTurn()) return [];
  const m = me(), out = [];
  if (m.role === 'detective') {
    const occ = detPositions(m.id);
    for (const { to, t } of MAPD.adj[m.pos]) if (t !== 'ferry' && m.tickets[t] > 0 && !occ.has(to)) out.push({ to, ticket: t, t });
  } else {
    const from = pending ? pending.to : m.pos;
    let secret = S.secret - (pending && pending.ticket === 'secret' ? 1 : 0);
    const occ = detPositions();
    for (const { to, t } of MAPD.adj[from]) {
      if (occ.has(to)) continue;
      if (t !== 'ferry') out.push({ to, ticket: t, t });
      if (secret > 0) out.push({ to, ticket: 'secret', t });
    }
  }
  return out;
}
function onNode(id) {
  if (!S || S.phase !== 'playing') return;
  if (!myTurn()) return toast(`Waiting for ${S.players.find(p => p.id === S.turnId)?.name || 'someone'}…`);
  const opts = optionsNow().filter(o => o.to === id);
  if (!opts.length) return toast('You can’t get there from here.');
  const m = me();
  if (m.role === 'detective') return sendMsg({ type: 'move', to: id });
  if (opts.length === 1) return shadowPick(opts[0]);
  $('modalBox').innerHTML = `<h3>Station ${id}</h3><div class="sub">Which ticket?</div>` +
    opts.map(o => `<button class="btn ${o.ticket === 'secret' ? 'gold' : 'ghost'}" data-t="${o.ticket}">${o.ticket === 'secret' ? 'Secret ticket (hides how you travelled)' : TNAME[o.ticket] + ' ticket'}</button>`).join('') +
    `<button class="btn ghost" id="mcancel">Cancel</button>`;
  $('modal').classList.add('on');
  $('modalBox').querySelectorAll('[data-t]').forEach(b => (b.onclick = () => { closeModal(); shadowPick(opts.find(o => o.ticket === b.dataset.t)); }));
  $('mcancel').onclick = closeModal;
}
function shadowPick(o) {
  const choice = { to: o.to, ticket: o.ticket };
  if (doubleArmed && !pending) { pending = choice; toast('Now pick your second move.'); return render(); }
  if (doubleArmed && pending) { const moves = [pending, choice]; pending = null; doubleArmed = false; return sendMsg({ type: 'move', moves }); }
  sendMsg({ type: 'move', moves: [choice] });
}
function closeModal() { $('modal').classList.remove('on'); }

// ---------- render ----------
function render() {
  if (!S) return;
  if (S.phase === 'lobby') {
    overShown = false; closeModal(); renderLobby();
    tokens.forEach(tk => tokenGroup.remove(tk.g)); tokens.clear(); clearGroup(markGroup);
    lastTurnId = null;
    return show('lobby');
  }
  const first = !$('game').classList.contains('on');
  if (first) show('game');
  const m = me();
  $('game').classList.toggle('fs', myTurn());
  if (!myTurn()) { doubleArmed = false; pending = null; }
  if (myTurn() && lastTurnId !== S.youId) {
    if (navigator.vibrate) navigator.vibrate(120);
  }
  lastTurnId = S.turnId;

  // banner + role
  const b = $('banner'); b.className = 'banner';
  if (S.phase === 'over') {
    const won = (S.winner === 'shadow') === (m.role === 'shadow');
    b.innerHTML = `${S.winner === 'shadow' ? 'The Shadow escapes!' : 'Detectives win!'}<small>${won ? 'You won — ' : ''}tap for results</small>`;
  } else if (myTurn()) {
    b.classList.add('me');
    b.innerHTML = `Your move${pending ? ' (2nd of double)' : ''}<small>Tap a glowing station</small>`;
  } else {
    const who = S.players.find(p => p.id === S.turnId);
    b.innerHTML = `Waiting for ${esc(who ? who.name : '…')}<small>${nextRevealText()}</small>`;
  }
  b.onclick = () => { if (S.phase === 'over') showResults(true); };
  const rl = $('role'); rl.className = 'role ' + m.role;
  rl.textContent = m.role === 'shadow' ? '🌑 Shadow' : '🔍 Detective';

  renderMarks(); renderBar(); if (sheetOpen) renderSheet();
  if (S.phase === 'over') { if (!overShown) { overShown = true; showResults(); } } else overShown = false;
}
function nextRevealText() {
  const nxt = S.reveals.find(r => r > S.moveCount);
  return `Shadow moves: ${S.moveCount}/${S.total}` + (nxt ? ` · surfaces at move ${nxt}` : '');
}
function renderBar() {
  const m = me(), bar = $('bar');
  const chip = (c, label, n) => `<span class="chip"><i style="background:${c}"></i>${label} ${n}</span>`;
  if (m.role === 'detective') {
    bar.innerHTML = chip(TCOLOR.walk, 'Walk', m.tickets.walk) + chip(TCOLOR.bus, 'Bus', m.tickets.bus) + chip(TCOLOR.tram, 'Tram', m.tickets.tram) +
      `<span class="chip" style="margin-left:auto">Station ${m.pos}</span>`;
  } else {
    const canDouble = myTurn() && S.doubles > 0 && S.moveCount + 2 <= S.total;
    bar.innerHTML = chip(TCOLOR.secret, 'Secret', S.secret) +
      `<span class="chip dbl ${doubleArmed ? 'on' : ''}" id="dbl" style="${canDouble ? '' : 'opacity:.5'}">Double ×${S.doubles}${doubleArmed ? ' — armed' : ''}</span>` +
      `<span class="chip" style="margin-left:auto">You: station ${m.pos}</span>`;
    $('dbl').onclick = () => {
      if (!canDouble) return toast(myTurn() ? 'No double moves available.' : 'Wait for your turn.');
      doubleArmed = !doubleArmed; pending = null; render();
    };
  }
}
function renderSheet() {
  const cells = [];
  for (let n = 1; n <= S.total; n++) {
    const l = S.log.find(x => x.n === n), rev = S.reveals.includes(n);
    cells.push(`<div class="cell ${l ? l.ticket : ''} ${rev ? 'rev' : ''}"><b>${n}${rev ? ' ★' : ''}</b>` +
      (l ? `<div class="t">${TNAME[l.ticket]}</div>${l.pos ? `<div class="p">#${l.pos}</div>` : ''}` : '') + `</div>`);
  }
  const dets = S.players.filter(p => p.role === 'detective').map(p =>
    `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}<span class="tag">W ${p.tickets.walk} · B ${p.tickets.bus} · T ${p.tickets.tram}</span></li>`).join('');
  $('sheetInner').innerHTML = `<h3>Shadow's trail</h3><div class="track">${cells.join('')}</div>
    <h3>Detectives</h3><ul class="plist" style="margin-bottom:14px">${dets}</ul>
    <h3>What happened</h3><ul class="events">${[...S.events].reverse().map(e => `<li>• ${esc(e)}</li>`).join('')}</ul>
    <button class="btn ghost" id="closeSheet" style="width:100%;margin-top:14px">Close</button>`;
  $('closeSheet').onclick = () => toggleSheet(false);
}
function toggleSheet(on) { sheetOpen = on; $('sheet').classList.toggle('on', on); if (on && S) renderSheet(); }
$('btnLog').onclick = () => toggleSheet(true);
$('sheet').onclick = e => { if (e.target === $('sheet')) toggleSheet(false); };

function showResults() {
  const m = me(), host = S.hostId === S.youId;
  const shadow = S.players.find(p => p.role === 'shadow');
  const won = (S.winner === 'shadow') === (m.role === 'shadow');
  $('modalBox').innerHTML = `<div class="win">${S.winner === 'shadow' ? '🌑 The Shadow escapes!' : '🔍 Detectives win!'}</div>
    <div class="sub" style="text-align:center">${esc(S.reason)}</div>
    <div class="sub" style="text-align:center">The Shadow was <b style="color:#c9a8ff">${esc(shadow.name)}</b>. ${won ? 'Nice work — you won!' : 'Better luck next time!'}</div>
    <div class="sub" style="text-align:center">The purple trail on the map shows where they went.</div>
    ${host ? '<button class="btn gold" id="again">Play again</button>' : '<div class="sub" style="text-align:center">Waiting for the host to start a rematch…</div>'}
    <button class="btn ghost" id="viewmap">View the map</button>`;
  $('modal').classList.add('on');
  $('viewmap').onclick = closeModal;
  if (host) $('again').onclick = () => { closeModal(); sendMsg({ type: 'again' }); };
}

if (location.search.includes('debug')) window.__sh = { THREE, camera, P3, state: () => S, map: () => MAPD, optionsNow };
connect();
