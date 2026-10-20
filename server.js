const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { buildMap } = require('./map');

const PORT = process.env.PORT || 3000;
const MAP = buildMap();
const TOTAL_MOVES = 24;
const REVEALS = [3, 8, 13, 18, 24];
const COLORS = ['#e4572e', '#29a3a3', '#f2b134', '#7b6cf6', '#4caf6e', '#d6538f'];
const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 900; // pause before a computer player moves
const BOT_NAMES =['Ada', 'Bruno', 'Cleo', 'Dex', 'Eli', 'Faye'];
const rooms = new Map();

// hop distances between stations on foot/bus/tram routes (detectives never use ferries)
const DIST = (() => {
  const ids = MAP.nodes.map(n => n.id), out = {};
  for (const s of ids) {
    const d = { [s]: 0 }, q = [s];
    while (q.length) {
      const a = q.shift();
      for (const { to, t } of MAP.adj[a]) if (t !== 'ferry' && d[to] === undefined) { d[to] = d[a] + 1; q.push(to); }
    }
    out[s] = d;
  }
  return out;
})();

// ---------- static files ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

// ---------- helpers ----------
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const send = (p, obj) => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); };
function genCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = s => String(s || '').trim().slice(0, 14) || 'Player';
const shadowOf = r => r.players.find(p => p.role === 'shadow');
const dets = r => r.players.filter(p => p.role === 'detective');
const occupied = (r, exceptId) => new Set(dets(r).filter(d => d.id !== exceptId).map(d => d.pos));
function say(r, text) { r.events.push(text); if (r.events.length > 60) r.events.shift(); }

function detMoves(r, p) {
  const occ = occupied(r, p.id), out = [];
  for (const { to, t } of MAP.adj[p.pos]) {
    if (t === 'ferry' || p.tickets[t] <= 0 || occ.has(to)) continue;
    out.push({ to, ticket: t });
  }
  return out;
}
function shadowMovesFrom(r, pos, secretLeft) {
  const occ = occupied(r), out = [];
  for (const { to, t } of MAP.adj[pos]) {
    if (occ.has(to)) continue;
    if (t !== 'ferry') out.push({ to, ticket: t });
    if (secretLeft > 0) out.push({ to, ticket: 'secret' });
  }
  return out;
}

// ---------- views ----------
function view(r, me) {
  const over = r.phase === 'over';
  return {
    type: 'state',
    code: r.code, phase: r.phase, hostId: r.hostId, youId: me.id,
    players: r.players.map(q => ({
      id: q.id, name: q.name, color: q.color, role: q.role, connected: q.connected, bot: !!q.isBot,
      pos: q.role === 'detective' || q.id === me.id || over ? q.pos : null,
      tickets: q.role === 'detective' ? q.tickets : null,
    })),
    turnId: r.turnId, moveCount: r.moveCount, total: TOTAL_MOVES, reveals: REVEALS,
    log: r.log.map(l => ({ n: l.n, ticket: l.ticket, pos: l.pos != null && (l.revealed || over || me.role === 'shadow') ? l.pos : null, revealed: l.revealed })),
    lastKnown: r.lastKnown,
    secret: me.role === 'shadow' ? r.secret : null,
    doubles: me.role === 'shadow' ? r.doubles : null,
    winner: r.winner, reason: r.reason, events: r.events.slice(-30),
  };
}
function broadcast(r) { r.players.forEach(p => send(p, view(r, p))); r.touched = Date.now(); maybeBot(r); }

// ---------- computer players ----------
// Bots only use what a human at the table could know: public positions of detectives,
// the Shadow's ticket trail and the stations where the Shadow surfaced (r.possible).
function narrowPossible(r, ticket, revealedPos) {
  const next = new Set();
  for (const pos of r.possible) {
    for (const { to, t } of MAP.adj[pos]) if (ticket === 'secret' || t === ticket) next.add(to);
  }
  if (revealedPos != null) { next.clear(); next.add(revealedPos); }
  for (const d of dets(r)) next.delete(d.pos);
  r.possible = next.size ? next : new Set(MAP.nodes.map(n => n.id));
}
function maybeBot(r) {
  if (r.phase !== 'playing' || r.botTimer) return;
  const p = r.players.find(x => x.id === r.turnId);
  if (!p || !p.isBot || !r.players.some(x => !x.isBot && x.connected)) return;
  r.botTimer = setTimeout(() => {
    r.botTimer = null;
    try { botAct(r); } catch (e) { console.error(e); }
  }, BOT_DELAY + Math.random() * BOT_DELAY * 0.9);
}
function botAct(r) {
  const p = r.players.find(x => x.id === r.turnId);
  if (r.phase !== 'playing' || !p || !p.isBot) return;
  const e = p.role === 'shadow' ? handleShadowMove(r, p, botShadowPlan(r, p)) : handleDetMove(r, p, botDetMove(r, p));
  if (e) console.error('Bot move rejected:', e);
}
function botDetMove(r, p) {
  const moves = detMoves(r, p), poss = [...r.possible];
  const others = dets(r).filter(d => d.id !== p.id).map(d => d.pos);
  const cost = { walk: 0, bus: 0.35, tram: 0.7 };
  let best = null;
  for (const m of moves) {
    const avg = poss.reduce((s, q) => s + DIST[m.to][q], 0) / poss.length;
    const spread = others.length ? Math.min(4, Math.min(...others.map(o => DIST[m.to][o]))) : 0;
    const score = avg + cost[m.ticket] * (1 + (10 - Math.min(10, p.tickets[m.ticket])) / 10) - 0.2 * spread + Math.random() * 0.15;
    if (!best || score < best.score) best = { to: m.to, score };
  }
  return best.to;
}
function botShadowPlan(r, p) {
  const dpos = dets(r).map(d => d.pos);
  const rate = pos => {
    const ds = dpos.map(d => DIST[pos][d]), near = Math.min(...ds);
    const free = MAP.adj[pos].filter(e => !dpos.includes(e.to)).length;
    return Math.min(near, 6) * 3 + ds.reduce((a, b) => a + b, 0) / ds.length * 0.4 + free * 0.5 - (near <= 1 ? 25 : 0) + Math.random() * 0.5;
  };
  const pickTicket = (opts, to, secretLeft, threat) => {
    const these = opts.filter(o => o.to === to);
    const plain = these.find(o => o.ticket !== 'secret'), secret = these.find(o => o.ticket === 'secret');
    if (!plain) return secret;
    return secret && secretLeft > 0 && threat && Math.random() < 0.7 ? secret : plain;
  };
  const here = Math.min(...dpos.map(d => DIST[p.pos][d]));
  const first = shadowMovesFrom(r, p.pos, r.secret);
  const wantDouble = r.doubles > 0 && r.moveCount + 2 <= TOTAL_MOVES && here <= 2 && Math.random() < 0.6;
  if (wantDouble) {
    let best = null;
    for (const a of first) {
      const left = r.secret - (a.ticket === 'secret' ? 1 : 0);
      for (const b of shadowMovesFrom(r, a.to, left)) {
        if (b.to === p.pos) continue;
        const sc = rate(b.to) + (a.ticket === 'secret' ? -1 : 0);
        if (!best || sc > best.sc) best = { sc, a, b };
      }
    }
    if (best) return [best.a, best.b];
  }
  let best = null;
  for (const o of first) {
    const sc = rate(o.to);
    if (!best || sc > best.sc) best = { sc, to: o.to };
  }
  return [pickTicket(first, best.to, r.secret, here <= 3)];
}

// ---------- game flow ----------
function startGame(r) {
  const ps = shuffle(r.players);
  ps.forEach(p => { p.role = 'detective'; });
  ps[0].role = 'shadow';
  const spots = shuffle(MAP.starts);
  r.players.forEach(p => { p.pos = null; });
  ps.forEach((p, i) => {
    p.pos = spots[i];
    p.tickets = p.role === 'detective' ? { walk: 10, bus: 8, tram: 4 } : null;
  });
  let ci = 0;
  r.players.forEach(p => { p.color = COLORS[ci++ % COLORS.length]; });
  r.phase = 'playing';
  r.moveCount = 0; r.log = []; r.lastKnown = null; r.winner = null; r.reason = '';
  r.secret = Math.max(2, dets(r).length); r.doubles = 2; r.events = [];
  r.possible = new Set(MAP.nodes.map(n => n.id).filter(id => !dets(r).some(d => d.pos === id)));
  say(r, `Game on! ${shadowOf(r).name} is the Shadow — nobody knows who until the end of the chase.`);
  say(r, `Detectives: ${dets(r).map(d => d.name).join(', ')}`);
  beginShadowTurn(r);
}
function endGame(r, winner, reason) {
  r.phase = 'over'; r.winner = winner; r.reason = reason; r.turnId = null;
  say(r, reason);
  broadcast(r);
}
function beginShadowTurn(r) {
  const s = shadowOf(r);
  if (shadowMovesFrom(r, s.pos, r.secret).length === 0) return endGame(r, 'detectives', 'The Shadow was cornered with nowhere to go!');
  r.turnId = s.id; r.stage = 'shadow';
  say(r, `Move ${r.moveCount + 1} of ${TOTAL_MOVES}: the Shadow is on the move…`);
  broadcast(r);
}
function beginDetPhase(r) {
  r.detQueue = dets(r).filter(d => detMoves(r, d).length > 0).map(d => d.id);
  if (!r.detQueue.length) return endGame(r, 'shadow', 'The detectives are out of moves — the Shadow escapes!');
  nextDet(r);
}
function nextDet(r) {
  while (r.detQueue.length) {
    const d = r.players.find(p => p.id === r.detQueue[0]);
    if (d && detMoves(r, d).length) { r.turnId = d.id; r.stage = 'det'; return broadcast(r); }
    if (d) say(r, `${d.name} can't move and is skipped.`);
    r.detQueue.shift();
  }
  // round over
  if (r.moveCount >= TOTAL_MOVES) return endGame(r, 'shadow', `The Shadow survived all ${TOTAL_MOVES} moves and gets away!`);
  beginShadowTurn(r);
}

function handleShadowMove(r, p, moves) {
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > 2) return 'Bad move';
  if (moves.length === 2 && (r.doubles <= 0 || r.moveCount + 2 > TOTAL_MOVES)) return 'No double move available';
  let pos = p.pos, secret = r.secret;
  const plan = [];
  for (const m of moves) {
    const edge = MAP.adj[pos].find(e => e.to === m.to);
    if (!edge) return 'That station is not connected';
    if (occupied(r).has(m.to)) return 'A detective is there';
    if (m.ticket === 'secret') { if (secret <= 0) return 'No secret tickets left'; secret--; }
    else if (m.ticket !== edge.t || edge.t === 'ferry') return 'Wrong ticket for that route';
    plan.push({ to: m.to, ticket: m.ticket });
    pos = m.to;
  }
  if (moves.length === 2) { r.doubles--; say(r, 'The Shadow used a DOUBLE MOVE!'); }
  r.secret = secret;
  for (const m of plan) {
    p.pos = m.to; r.moveCount++;
    const revealed = REVEALS.includes(r.moveCount);
    r.log.push({ n: r.moveCount, ticket: m.ticket, pos: m.to, revealed });
    narrowPossible(r, m.ticket, revealed ? m.to : null);
    if (revealed) { r.lastKnown = { pos: m.to, n: r.moveCount }; say(r, `The Shadow surfaces at station ${m.to}!`); }
    say(r, `Shadow move ${r.moveCount}: ${m.ticket === 'secret' ? 'a SECRET ticket' : m.ticket}`);
  }
  beginDetPhase(r);
  return null;
}
function handleDetMove(r, p, to) {
  const opt = detMoves(r, p).find(m => m.to === to);
  if (!opt) return 'Illegal move';
  p.tickets[opt.ticket]--; p.pos = to;
  say(r, `${p.name} took the ${opt.ticket} to station ${to}.`);
  const s = shadowOf(r);
  if (s.pos === to) return endGame(r, 'detectives', `${p.name} caught the Shadow (${s.name}) at station ${to}!`) || null;
  r.possible.delete(to);
  r.detQueue.shift();
  nextDet(r);
  return null;
}

// ---------- connections ----------
wss.on('connection', ws => {
  let me = null, room = null;
  const err = msg => ws.send(JSON.stringify({ type: 'error', msg }));
  const attach = (r, p) => {
    room = r; me = p; p.ws = ws; p.connected = true;
    ws.send(JSON.stringify({ type: 'joined', code: r.code, token: p.token, id: p.id, map: MAP }));
    broadcast(r);
  };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.type === 'create') {
        const r = { code: genCode(), phase: 'lobby', players: [], events: [], log: [], touched: Date.now() };
        rooms.set(r.code, r);
        const p = { id: crypto.randomUUID(), token: crypto.randomUUID(), name: cleanName(m.name), role: null, connected: true, color: COLORS[0] };
        r.players.push(p); r.hostId = p.id; attach(r, p);
      } else if (m.type === 'join') {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return err('Room not found. Check the code.');
        if (r.phase !== 'lobby') return err('That game has already started.');
        if (r.players.length >= 6) return err('Room is full (6 players max).');
        const p = { id: crypto.randomUUID(), token: crypto.randomUUID(), name: cleanName(m.name), role: null, connected: true, color: COLORS[r.players.length % COLORS.length] };
        r.players.push(p); attach(r, p);
      } else if (m.type === 'rejoin') {
        const r = rooms.get(String(m.code || '').toUpperCase());
        const p = r && m.token && r.players.find(x => x.token === m.token);
        if (!p) return ws.send(JSON.stringify({ type: 'expired' }));
        attach(r, p);
      } else if (!room || !me) {
        return;
      } else if (m.type === 'addbot') {
        if (me.id !== room.hostId || room.phase !== 'lobby') return;
        if (room.players.length >= 6) return err('Room is full (6 players max).');
        const taken = new Set(room.players.map(p => p.name));
        const name = 'Bot ' + (BOT_NAMES.find(n => !taken.has('Bot ' + n)) || room.players.length);
        room.players.push({ id: crypto.randomUUID(), token: null, name, isBot: true, role: null, connected: true, color: COLORS[room.players.length % COLORS.length] });
        broadcast(room);
      } else if (m.type === 'removebot') {
        if (me.id !== room.hostId || room.phase !== 'lobby') return;
        room.players = room.players.filter(p => !(p.isBot && p.id === m.id));
        broadcast(room);
      } else if (m.type === 'start') {
        if (me.id !== room.hostId || room.phase !== 'lobby') return;
        if (room.players.length < 2) return err('You need at least 2 players.');
        startGame(room);
      } else if (m.type === 'move') {
        if (room.phase !== 'playing' || room.turnId !== me.id) return err("It's not your turn.");
        const e = me.role === 'shadow' ? handleShadowMove(room, me, m.moves) : handleDetMove(room, me, m.to);
        if (e) err(e); else if (room.phase === 'playing') { /* broadcast already sent by flow */ }
      } else if (m.type === 'finish') {
        if (room.phase !== 'playing') return;
        clearTimeout(room.botTimer); room.botTimer = null;
        endGame(room, 'ended', `${me.name} finished the game early.`);
      } else if (m.type === 'again') {
        if (me.id !== room.hostId || room.phase !== 'over') return;
        room.phase = 'lobby'; room.players.forEach(p => { p.role = null; p.pos = null; p.tickets = null; });
        room.log = []; room.lastKnown = null; room.winner = null; room.turnId = null; room.events = [];
        broadcast(room);
      } else if (m.type === 'leave') {
        if (room.phase === 'lobby') {
          room.players = room.players.filter(p => p.id !== me.id);
          const humans = room.players.filter(p => !p.isBot);
          if (!humans.length) rooms.delete(room.code);
          else { if (room.hostId === me.id) room.hostId = humans[0].id; broadcast(room); }
        }
        me.ws = null; room = null; me = null;
      }
    } catch (e) { console.error(e); err('Something went wrong on the server.'); }
  });
  ws.on('close', () => { if (me) { me.connected = false; me.ws = null; if (room) broadcast(room); } });
});

setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [c, r] of rooms) if (r.touched < cutoff) rooms.delete(c);
}, 600000);

server.listen(PORT, () => console.log(`Shadow Harbor running on http://localhost:${PORT}`));
