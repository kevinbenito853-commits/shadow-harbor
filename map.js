// Original, procedurally generated city map for Shadow Harbor.
// Deterministic (seeded), so every server start gives the same board.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildMap(seed = 20261018) {
  const rnd = mulberry32(seed);
  const W = 1000, H = 700, N = 90, MIN_D = 64;
  const pts = [];
  for (let tries = 0; tries < 20000 && pts.length < N; tries++) {
    const x = 40 + rnd() * (W - 80), y = 40 + rnd() * (H - 80);
    if (pts.every(p => Math.hypot(p.x - x, p.y - y) >= MIN_D)) pts.push({ x, y });
  }
  const n = pts.length;
  const d = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
  const linked = new Set();
  const key = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const edges = [];
  const deg = { walk: Array(n).fill(0), bus: Array(n).fill(0), tram: Array(n).fill(0) };
  const addEdge = (a, b, t) => {
    if (a === b || linked.has(key(a, b))) return false;
    linked.add(key(a, b));
    edges.push({ a, b, t });
    if (deg[t]) { deg[t][a]++; deg[t][b]++; }
    return true;
  };

  // Walking streets: a spanning tree (everything reachable) plus nearby shortcuts.
  const inTree = new Set([0]);
  while (inTree.size < n) {
    let best = null;
    for (const a of inTree) for (let b = 0; b < n; b++) {
      if (inTree.has(b)) continue;
      const dd = d(a, b);
      if (!best || dd < best.dd) best = { a, b, dd };
    }
    addEdge(best.a, best.b, 'walk');
    inTree.add(best.b);
  }
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()].filter(b => b !== a).sort((x, y) => d(a, x) - d(a, y));
    let added = 0;
    for (const b of near) {
      if (added >= 2) break;
      if (d(a, b) > 135) break;
      if (deg.walk[a] >= 5 || deg.walk[b] >= 5) continue;
      if (addEdge(a, b, 'walk')) added++;
    }
  }

  // Bus stops
  const order = [...Array(n).keys()].sort(() => rnd() - 0.5);
  const busStops = order.slice(0, 30);
  for (const a of busStops) {
    const near = busStops.filter(b => b !== a).sort((x, y) => d(a, x) - d(a, y));
    let added = 0;
    for (const b of near) {
      if (added >= 1 + (deg.bus[a] === 0 ? 1 : 0)) break;
      const dd = d(a, b);
      if (dd < 110 || dd > 330) continue;
      if (deg.bus[a] >= 3 || deg.bus[b] >= 3) continue;
      if (addEdge(a, b, 'bus')) added++;
    }
  }

  // Tram hubs (spread out)
  const hubs = [];
  for (const a of busStops) {
    if (hubs.every(h => d(a, h) >= 210)) hubs.push(a);
    if (hubs.length >= 12) break;
  }
  const hubIn = new Set([hubs[0]]);
  while (hubIn.size < hubs.length) {
    let best = null;
    for (const a of hubIn) for (const b of hubs) {
      if (hubIn.has(b)) continue;
      const dd = d(a, b);
      if (!best || dd < best.dd) best = { a, b, dd };
    }
    if (!addEdge(best.a, best.b, 'tram')) {
      // already linked another way; still treat as connected for the tree
    }
    hubIn.add(best.b);
  }
  for (const a of hubs) {
    const near = hubs.filter(b => b !== a).sort((x, y) => d(a, x) - d(a, y));
    if (near[0] !== undefined && deg.tram[a] < 3) addEdge(a, near[0], 'tram');
  }

  // Ferries: long links usable only with a secret ticket
  const ferryPairs = [];
  for (let tries = 0; tries < 4000 && ferryPairs.length < 4; tries++) {
    const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
    const dd = d(a, b);
    if (a === b || dd < 260 || dd > 460 || linked.has(key(a, b))) continue;
    if (ferryPairs.some(([x, y]) => x === a || y === a || x === b || y === b)) continue;
    ferryPairs.push([a, b]);
    addEdge(a, b, 'ferry');
  }

  // Start positions, spread out
  const starts = [];
  for (const a of order) {
    if (starts.every(s => d(a, s) >= 150)) starts.push(a);
    if (starts.length >= 14) break;
  }

  const tramSet = new Set(), busSet = new Set(), ferrySet = new Set();
  edges.forEach(e => {
    const s = e.t === 'tram' ? tramSet : e.t === 'bus' ? busSet : e.t === 'ferry' ? ferrySet : null;
    if (s) { s.add(e.a); s.add(e.b); }
  });
  const nodes = pts.map((p, i) => ({
    id: i + 1, x: Math.round(p.x), y: Math.round(p.y),
    bus: busSet.has(i), tram: tramSet.has(i), ferry: ferrySet.has(i),
  }));
  const E = edges.map(e => ({ a: e.a + 1, b: e.b + 1, t: e.t }));
  const adj = {};
  nodes.forEach(nd => (adj[nd.id] = []));
  E.forEach(e => { adj[e.a].push({ to: e.b, t: e.t }); adj[e.b].push({ to: e.a, t: e.t }); });
  return { width: W, height: H, nodes, edges: E, adj, starts: starts.map(s => s + 1) };
}

module.exports = { buildMap };
