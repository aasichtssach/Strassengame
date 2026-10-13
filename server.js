'use strict';
/*
  Strassenjagd Basel: Live-Server
  - nimmt GPS-Positionen entgegen (Traccar Client, OwnTracks, Läufer-Webseite)
  - ordnet sie den Strassenabschnitten zu (Map Matching)
  - vergibt den Besitz (wer zuerst läuft, gewinnt)
  - schickt den Stand per WebSocket an die Live-Karte
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const NetBuild = require('./public/net.js');

/* ---------- Einstellungen (per Umgebungsvariable änderbar) ---------- */
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DELAY_S = process.env.DELAY_S !== undefined ? Number(process.env.DELAY_S) : 30; // Anzeige-Verzögerung
const MAX_SPEED = (Number(process.env.MAX_KMH) || 25) / 3.6;   // schneller als das zählt nicht
const MAX_ACCURACY = Number(process.env.MAX_ACCURACY) || 30;   // schlechtere Fixes werden verworfen (m)
const SNAP = Number(process.env.SNAP_M) || 15;                 // so nah muss man an der Strasse sein (m)
const MIN_BINS = 3;                                            // von 4 Teilstücken eines Abschnitts
const MAX_BACKLOG_MS = 6 * 3600 * 1000;                        // nachgesendete Fixes bis 6 h alt

/* ---------- Strassennetz laden ---------- */
const NET = JSON.parse(fs.readFileSync(path.join(__dirname, 'network.json'), 'utf8'));
const G = NetBuild.build(NET, 40);
const KX = 111320 * Math.cos(NET.origin[0] * Math.PI / 180);
const KY = 110540;
const proj = (lat, lon) => [(lon - NET.origin[1]) * KX, (lat - NET.origin[0]) * KY];

/* Raster-Index über alle Teilstrecken der Abschnitte */
const CELL = 40;
const seg = { ax: [], ay: [], bx: [], by: [], chunk: [], along: [], len: [] };
const grid = new Map();
const cellKey = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);
for (let c = 0; c < G.totalChunks; c++) {
  const o = G.chunkOff[c], end = G.chunkOff[c + 1];
  let along = 0;
  for (let j = o; j + 3 < end; j += 2) {
    const ax = G.chunkPts[j], ay = G.chunkPts[j + 1], bx = G.chunkPts[j + 2], by = G.chunkPts[j + 3];
    const l = Math.hypot(bx - ax, by - ay);
    const id = seg.ax.length;
    seg.ax.push(ax); seg.ay.push(ay); seg.bx.push(bx); seg.by.push(by);
    seg.chunk.push(c); seg.along.push(along); seg.len.push(l);
    along += l;
    const cx0 = Math.floor((Math.min(ax, bx) - SNAP) / CELL), cx1 = Math.floor((Math.max(ax, bx) + SNAP) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - SNAP) / CELL), cy1 = Math.floor((Math.max(ay, by) + SNAP) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = cellKey(cx, cy);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(id);
    }
  }
}

/* Alle Abschnitte im Umkreis SNAP um einen Punkt: [{c, d, a}] (a = Position im Abschnitt, 0..1) */
function matchSample(x, y) {
  const arr = grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!arr) return [];
  const best = new Map();
  for (const id of arr) {
    const dx = seg.bx[id] - seg.ax[id], dy = seg.by[id] - seg.ay[id];
    const l2 = dx * dx + dy * dy;
    let u = l2 ? ((x - seg.ax[id]) * dx + (y - seg.ay[id]) * dy) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(x - (seg.ax[id] + u * dx), y - (seg.ay[id] + u * dy));
    if (d > SNAP) continue;
    const c = seg.chunk[id];
    const prev = best.get(c);
    if (!prev || d < prev.d) {
      best.set(c, { c, d, a: Math.min(1, (seg.along[id] + u * seg.len[id]) / G.chunkLen[c]) });
    }
  }
  return Array.from(best.values());
}

/* ---------- Zustand ---------- */
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const rid = () => crypto.randomBytes(6).toString('hex');
let state = {
  admin: process.env.ADMIN_KEY || rid() + rid(),
  runners: [0, 1, 2, 3].map(i => ({ id: i, name: 'Läufer ' + (i + 1), token: rid() })),
  game: { status: 'waiting', startedAt: null, endedAt: null },
  claims: {}
};
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved && saved.runners && saved.runners.length === 4) state = Object.assign(state, saved);
} catch (e) { /* erster Start */ }
if (process.env.ADMIN_KEY) state.admin = process.env.ADMIN_KEY;

const owner = new Int8Array(G.totalChunks).fill(-1);
const claimTs = new Float64Array(G.totalChunks);
Object.keys(state.claims).forEach(c => { owner[c] = state.claims[c][0]; claimTs[c] = state.claims[c][1]; });
const meters = [0, 0, 0, 0];
function recount() {
  meters.fill(0);
  for (let c = 0; c < G.totalChunks; c++) if (owner[c] >= 0) meters[owner[c]] += G.chunkLen[c];
}
recount();

const rt = state.runners.map(() => ({ last: null, masks: new Map(), fixes: 0, rejected: { accuracy: 0, speed: 0, old: 0 } }));
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); }
}
setInterval(save, 10000).unref();

/* ---------- Verzögerte Ausgabe an die Karten ---------- */
const visible = { owner: new Int8Array(G.totalChunks).fill(-1), pos: [null, null, null, null] };
owner.forEach((o, c) => { visible.owner[c] = o; });
const queue = [];
const clients = new Set();
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { clients.forEach(ws => send(ws, msg)); }
function enqueue(msg) { queue.push({ at: Date.now() + DELAY_S * 1000, msg }); }
function flush() {
  const now = Date.now();
  while (queue.length && queue[0].at <= now) {
    const { msg } = queue.shift();
    if (msg.type === 'claims') for (let i = 0; i < msg.list.length; i += 2) visible.owner[msg.list[i]] = msg.list[i + 1];
    if (msg.type === 'pos') visible.pos[msg.id] = { id: msg.id, x: msg.x, y: msg.y, t: msg.t };
    broadcast(msg);
  }
}
setInterval(flush, 500).unref();

function snapshot() {
  const claims = [];
  for (let c = 0; c < G.totalChunks; c++) if (visible.owner[c] >= 0) claims.push(c, visible.owner[c]);
  return {
    type: 'init', now: Date.now(), delay: DELAY_S, game: state.game,
    runners: state.runners.map(r => ({ id: r.id, name: r.name })),
    claims, pos: visible.pos.filter(Boolean), chunks: G.totalChunks
  };
}

/* ---------- Positionen verarbeiten ---------- */
const popcount = m => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
let pending = [];

function tryClaim(r, c, ts) {
  if (owner[c] === r) return;
  if (owner[c] === -1 || ts < claimTs[c]) {      // der frühere Zeitstempel gewinnt
    if (owner[c] >= 0) meters[owner[c]] -= G.chunkLen[c];
    owner[c] = r; claimTs[c] = ts; meters[r] += G.chunkLen[c];
    state.claims[c] = [r, ts]; dirty = true;
    pending.push(c, r);
  }
}

function processFix(r, f) {
  const R = rt[r];
  if (!isFinite(f.lat) || !isFinite(f.lon) || Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180) return 'invalid';
  const now = Date.now();
  let t = Number(f.t);
  if (!t || Math.abs(t - now) > MAX_BACKLOG_MS) t = now;
  if (f.acc && f.acc > MAX_ACCURACY) { R.rejected.accuracy++; return 'accuracy'; }
  const [x, y] = proj(f.lat, f.lon);
  const prev = R.last;
  if (prev && t <= prev.t) { R.rejected.old++; return 'old'; }
  R.last = { x, y, t };
  R.fixes++;
  enqueue({ type: 'pos', id: r, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t });

  if (state.game.status !== 'running') return 'waiting';
  if (t < state.game.startedAt) return 'before-start';

  let samples = [[x, y, t]];
  if (prev) {
    const dt = (t - prev.t) / 1000, dist = Math.hypot(x - prev.x, y - prev.y);
    if (dist / dt > MAX_SPEED) { R.rejected.speed++; return 'speed'; }
    if (dt <= 60 && dist > 1) {                  // Weg zwischen zwei Fixes in 8-m-Schritten abtasten
      const n = Math.ceil(dist / 8);
      samples = [];
      for (let i = 1; i <= n; i++) {
        const k = i / n;
        samples.push([prev.x + (x - prev.x) * k, prev.y + (y - prev.y) * k, prev.t + (t - prev.t) * k]);
      }
    }
  }
  for (const s of samples) {
    const hits = matchSample(s[0], s[1]);
    if (!hits.length) continue;
    let best = Infinity;
    for (const h of hits) if (h.d < best) best = h.d;
    for (const h of hits) {
      if (h.d > best + 4) continue;              // nur die nächste Strasse, parallele Nachbarn nicht
      const bin = Math.min(3, Math.floor(h.a * 4));
      const m = (R.masks.get(h.c) || 0) | (1 << bin);
      R.masks.set(h.c, m);
      if (popcount(m) >= MIN_BINS) tryClaim(r, h.c, s[2]);
    }
  }
  return 'ok';
}

function handleFixes(r, fixes) {
  const results = fixes.map(f => processFix(r, f));
  if (pending.length) {
    enqueue({ type: 'claims', list: pending });
    pending = [];
  }
  return results;
}

/* ---------- HTTP ---------- */
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const files = {
  '/': path.join(PUBLIC, 'index.html'),
  '/run': path.join(PUBLIC, 'run.html'),
  '/admin': path.join(PUBLIC, 'admin.html'),
  '/net.js': path.join(PUBLIC, 'net.js'),
  '/network.json': path.join(__dirname, 'network.json')
};
const networkGz = zlib.gzipSync(fs.readFileSync(files['/network.json']));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', d => { n += d.length; if (n > 262144) { reject(new Error('zu gross')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function parseTime(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (/^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); return n > 1e11 ? n : n * 1000; }
  const p = Date.parse(v);
  return isNaN(p) ? 0 : p;
}
const byToken = tok => state.runners.find(r => tok && r.token === tok);
const isAdmin = key => key && key === state.admin;

function runnerInfo(r) {
  return { id: r.id, name: r.name, meters: Math.round(meters[r.id]), game: state.game, fixes: rt[r.id].fixes, rejected: rt[r.id].rejected };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'GET' && files[p]) {
    const f = files[p];
    const headers = { 'Content-Type': MIME[path.extname(f)] || 'text/plain' };
    if (p === '/network.json') {
      headers['Cache-Control'] = 'public, max-age=3600';
      if (/gzip/.test(req.headers['accept-encoding'] || '')) { headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); return res.end(networkGz); }
    } else headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    return fs.createReadStream(f).pipe(res);
  }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());

  /* Traccar Client (OsmAnd-Protokoll): GET oder POST mit Parametern in der URL oder im Formular */
  if (p === '/osmand') {
    let params = q;
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body && !q.get('id')) params = new URLSearchParams(body);
    }
    const r = byToken(params.get('id') || params.get('deviceid'));
    if (!r) { res.writeHead(401); return res.end('unbekannte Geraete-ID'); }
    const acc = params.get('accuracy') ? Number(params.get('accuracy')) : (params.get('hdop') ? Number(params.get('hdop')) * 5 : 0);
    handleFixes(r.id, [{ lat: Number(params.get('lat')), lon: Number(params.get('lon')), t: parseTime(params.get('timestamp')), acc }]);
    res.writeHead(200); return res.end('OK');
  }

  /* OwnTracks (HTTP-Modus) */
  if (p === '/owntracks' && req.method === 'POST') {
    const r = byToken(q.get('token'));
    if (!r) { res.writeHead(401); return res.end('[]'); }
    let msg = {};
    try { msg = JSON.parse(await readBody(req)); } catch (e) { /* ignorieren */ }
    if (msg._type === 'location') {
      handleFixes(r.id, [{ lat: Number(msg.lat), lon: Number(msg.lon), t: msg.tst ? Number(msg.tst) * 1000 : 0, acc: Number(msg.acc) || 0 }]);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]');
  }

  /* Läufer-Webseite */
  if (p === '/api/fix' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'ungültiges JSON' }); }
    const r = byToken(body.token);
    if (!r) return json(res, 401, { error: 'unbekannter Token' });
    const list = (Array.isArray(body.fixes) ? body.fixes : [body]).slice(0, 200)
      .map(f => ({ lat: Number(f.lat), lon: Number(f.lon), t: Number(f.t) || 0, acc: Number(f.acc) || 0 }));
    return json(res, 200, { ok: true, results: handleFixes(r.id, list), me: runnerInfo(r) });
  }
  if (p === '/api/me' && req.method === 'GET') {
    const r = byToken(q.get('token'));
    return r ? json(res, 200, runnerInfo(r)) : json(res, 401, { error: 'unbekannter Token' });
  }

  /* Verwaltung */
  if (p.startsWith('/api/admin/')) {
    const key = q.get('key');
    if (!isAdmin(key)) return json(res, 401, { error: 'falscher Schlüssel' });
    if (p === '/api/admin/info' && req.method === 'GET') {
      return json(res, 200, { game: state.game, delay: DELAY_S, runners: state.runners.map(r => Object.assign({ token: r.token }, runnerInfo(r))) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'nur POST' });
    if (p === '/api/admin/start') {
      if (state.game.status !== 'waiting') return json(res, 409, { error: 'Spiel läuft schon oder ist beendet, erst zurücksetzen' });
      state.game = { status: 'running', startedAt: Date.now(), endedAt: null };
    } else if (p === '/api/admin/end') {
      if (state.game.status !== 'running') return json(res, 409, { error: 'Spiel läuft nicht' });
      state.game.status = 'ended'; state.game.endedAt = Date.now();
    } else if (p === '/api/admin/reset') {
      state.game = { status: 'waiting', startedAt: null, endedAt: null };
      state.claims = {}; owner.fill(-1); claimTs.fill(0); visible.owner.fill(-1); visible.pos = [null, null, null, null];
      queue.length = 0; pending = []; recount();
      rt.forEach(R => { R.last = null; R.masks.clear(); R.fixes = 0; R.rejected = { accuracy: 0, speed: 0, old: 0 }; });
    } else if (p === '/api/admin/names') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'ungültiges JSON' }); }
      (body.names || []).slice(0, 4).forEach((n, i) => { if (typeof n === 'string' && n.trim()) state.runners[i].name = n.trim().slice(0, 18); });
    } else return json(res, 404, { error: 'unbekannt' });
    dirty = true; save();
    clients.forEach(ws => send(ws, snapshot()));
    return json(res, 200, { ok: true, game: state.game });
  }

  res.writeHead(404); res.end('nicht gefunden');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Serverfehler' }); else res.end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    send(ws, snapshot());
  });
});
setInterval(() => {
  clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000).unref();

function shutdown() { save(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main !== module) {
  module.exports = { processFix, matchSample, state, owner, G, proj, rt };
} else server.listen(PORT, () => {
  console.log('Strassenjagd läuft auf Port ' + PORT + ' (' + G.totalChunks + ' Abschnitte, ' + (G.totalLen / 1000).toFixed(1) + ' km, Verzögerung ' + DELAY_S + ' s)');
  console.log('Verwaltung:  /admin?key=' + state.admin);
  state.runners.forEach(r => console.log('  ' + r.name + ': Token ' + r.token));
  dirty = true; save();
});
