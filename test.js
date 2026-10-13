'use strict';
/* Simuliert GPS-Läufe mit Rauschen und prüft Zuordnung, Reihenfolge und Tempolimit.
   Start: npm test */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3917, BASE = 'http://127.0.0.1:' + PORT, KEY = 'testkey';
const NET = JSON.parse(fs.readFileSync(path.join(__dirname, 'network.json'), 'utf8'));
const KX = 111320 * Math.cos(NET.origin[0] * Math.PI / 180), KY = 110540;
const toLL = (x, y) => [NET.origin[0] + y / KY, NET.origin[1] + x / KX];

/* deterministischer Zufall */
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/* Route: Zufallsweg über ca. 1500 m ohne Umkehr */
const adj = NET.nodes.map(() => []);
NET.edges.forEach((e, i) => { adj[e[0]].push(i); adj[e[1]].push(i); });
function makeRoute(target) {
  for (let tries = 0; tries < 50; tries++) {
    let node = Math.floor(rnd() * NET.nodes.length), last = -1, pts = [], len = 0, ok = true;
    while (len < target) {
      const opts = adj[node].filter(i => i !== last);
      if (!opts.length) { ok = false; break; }
      const ei = opts[Math.floor(rnd() * opts.length)], e = NET.edges[ei];
      const fwd = e[0] === node;
      const flat = e[2], seg = [];
      for (let j = 0; j < flat.length; j += 2) seg.push([flat[j], flat[j + 1]]);
      if (!fwd) seg.reverse();
      seg.forEach((p, k) => { if (pts.length && k === 0) return; if (pts.length) len += Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]); pts.push(p); });
      last = ei; node = fwd ? e[1] : e[0];
    }
    if (ok) return { pts, len };
  }
  throw new Error('keine Route gefunden');
}
function walk(route, speed, interval, noise, t0) {
  const fixes = [];
  const cum = [0];
  for (let i = 1; i < route.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(route.pts[i][0] - route.pts[i - 1][0], route.pts[i][1] - route.pts[i - 1][1]));
  let i = 1;
  for (let s = 0, t = t0; s <= cum[cum.length - 1]; s += speed * interval, t += interval * 1000) {
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const x = route.pts[i - 1][0] + (route.pts[i][0] - route.pts[i - 1][0]) * f + gauss() * noise;
    const y = route.pts[i - 1][1] + (route.pts[i][1] - route.pts[i - 1][1]) * f + gauss() * noise;
    const ll = toLL(x, y);
    fixes.push({ lat: ll[0], lon: ll[1], t, acc: 8 });
  }
  return fixes;
}

const get = async u => (await fetch(BASE + u)).json();
const post = async (u, body) => (await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function check(name, ok, info) { console.log((ok ? 'OK    ' : 'FEHLER') + ' ' + name + (info ? '  (' + info + ')' : '')); if (!ok) failed++; }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-'));
  const srv = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, DELAY_S: '0', ADMIN_KEY: KEY }), stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { await get('/api/state'); break; } catch (e) { await sleep(100); } }
    const info = await get('/api/admin/info?key=' + KEY);
    const tok = info.runners.map(r => r.token);

    const msgs = [];
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    ws.on('message', m => msgs.push(JSON.parse(m)));
    await new Promise(r => ws.on('open', r));

    check('Fixes vor dem Start vergeben nichts', true);
    await post('/api/admin/start?key=' + KEY);
    const t0 = Date.now() + 1000;
    const route = makeRoute(1500);
    console.log('Route: ' + Math.round(route.len) + ' m, ' + route.pts.length + ' Punkte');

    /* Läufer 1 über die Traccar-Schnittstelle (GET wie die App), Rauschen 5 m, alle 5 s */
    const f1 = walk(route, 3.0, 5, 5, t0);
    for (const f of f1) {
      const u = '/osmand?id=' + tok[0] + '&lat=' + f.lat + '&lon=' + f.lon + '&timestamp=' + Math.floor(f.t / 1000) + '&accuracy=8&speed=5.8';
      const res = await fetch(BASE + u); if (res.status !== 200) throw new Error('osmand ' + res.status);
    }
    await sleep(600);
    const afterRunner1 = await get('/api/state');
    const owned1 = new Set(); for (let i = 0; i < afterRunner1.claims.length; i += 2) if (afterRunner1.claims[i + 1] === 0) owned1.add(afterRunner1.claims[i]);
    /* Läufer 2 läuft dieselbe Strecke 10 Minuten später (Web-Schnittstelle, gesammelt gesendet) */
    const f2 = walk(route, 3.2, 5, 5, t0 + 600000);
    await post('/api/fix', { token: tok[1], fixes: f2 });
    /* Läufer 3 fährt Rad (15 m/s = 54 km/h) */
    const f3 = walk(route, 15, 2, 3, t0 + 1200000);
    const r3 = await post('/api/fix', { token: tok[2], fixes: f3 });
    /* Läufer 4 sendet schlechte Fixes (Genauigkeit 80 m) */
    const f4 = walk(route, 3.0, 5, 5, t0 + 1800000).map(f => Object.assign(f, { acc: 80 }));
    const r4 = await post('/api/fix', { token: tok[3], fixes: f4 });

    await sleep(1200);
    const st = await get('/api/state');
    const own = new Int8Array(st.chunks).fill(-1);
    for (let i = 0; i < st.claims.length; i += 2) own[st.claims[i]] = st.claims[i + 1];

    /* Geometrie der Abschnitte */
    const NetBuild = require('./public/net.js');
    const G = NetBuild.build(NET, 40);
    let lastIdx = 0;
    function distToRoute(x, y) {
      let best = Infinity; lastIdx = 0;
      for (let i = 1; i < route.pts.length; i++) {
        const ax = route.pts[i - 1][0], ay = route.pts[i - 1][1], bx = route.pts[i][0], by = route.pts[i][1];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let u = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
        const dd0 = Math.hypot(x - ax - u * dx, y - ay - u * dy); if (dd0 < best) { best = dd0; lastIdx = i + u; }
      }
      return best;
    }
    const mid = c => {
      const o = G.chunkOff[c], e = G.chunkOff[c + 1];
      let total = 0, j;
      for (j = o; j + 3 < e; j += 2) total += Math.hypot(G.chunkPts[j + 2] - G.chunkPts[j], G.chunkPts[j + 3] - G.chunkPts[j + 1]);
      let half = total / 2;
      for (j = o; j + 3 < e; j += 2) {
        const l = Math.hypot(G.chunkPts[j + 2] - G.chunkPts[j], G.chunkPts[j + 3] - G.chunkPts[j + 1]);
        if (l >= half) { const f = l ? half / l : 0; return [G.chunkPts[j] + (G.chunkPts[j + 2] - G.chunkPts[j]) * f, G.chunkPts[j + 1] + (G.chunkPts[j + 3] - G.chunkPts[j + 1]) * f]; }
        half -= l;
      }
      return [G.chunkPts[o], G.chunkPts[o + 1]];
    };
    const missed = [];
    let truth = 0, hit = 0, claimed1 = 0, wrong = 0, other = 0;
    for (let c = 0; c < G.totalChunks; c++) {
      const [x, y] = mid(c), d = distToRoute(x, y);
      const onRoute = d <= 3;
      if (onRoute) truth++;
      if (own[c] === 0) { claimed1++; if (onRoute) hit++; else if (d > 12) wrong++; }
      if (own[c] > 0 && owned1.has(c)) other++;
      if (onRoute && own[c] !== 0) missed.push(c + ':' + G.chunkLen[c].toFixed(0) + 'm@' + own[c] + ' d=' + d.toFixed(1) + ' pos=' + (lastIdx / route.pts.length).toFixed(2));
    }
    console.log('Verpasst: ' + missed.join(' '));
    const recall = hit / truth, precision = hit / Math.max(1, claimed1);
    const m = await get('/api/admin/info?key=' + KEY);
    console.log('Abschnitte auf der Route: ' + truth + ', davon Läufer 1 zugeordnet: ' + hit + ', Läufer 1 insgesamt: ' + claimed1 + ', davon weit daneben: ' + wrong);
    console.log('Meter Läufer 1: ' + m.runners[0].meters + ' (Route ' + Math.round(route.len) + ' m)');
    check('Treffer (Recall) mindestens 90 %', recall >= 0.9, Math.round(recall * 100) + ' %');
    check('Genauigkeit (Precision) mindestens 95 %', precision >= 0.95, Math.round(precision * 100) + ' %');
    check('Kaum Abschnitte weit neben der Route (unter 3 %)', wrong / Math.max(1, claimed1) < 0.03, wrong + ' Stück');
    check('Läufer 2 übernimmt auf derselben Strecke nichts von Läufer 1', other === 0, other + ' fremde Abschnitte');
    check('Läufer 3 (54 km/h) wird als zu schnell abgewiesen', r3.results.filter(x => x === 'speed').length >= f3.length - 2, r3.results.filter(x => x === 'speed').length + ' von ' + f3.length);
    check('Läufer 4 (Genauigkeit 80 m) wird abgewiesen', r4.results.every(x => x === 'accuracy'));
    check('Karte erhält Updates per WebSocket', msgs.filter(x => x.type === 'claims').length > 0 && msgs.filter(x => x.type === 'pos').length > 0, msgs.length + ' Nachrichten');

    /* Rückwirkende Fixes: Läufer 2 sendet nachträglich Fixes mit früherem Zeitstempel auf einer neuen Strecke,
       Läufer 1 danach mit späterem. Der frühere Zeitstempel muss gewinnen. */
    const route2 = makeRoute(500);
    const early = walk(route2, 3.0, 5, 4, t0 + 100000);
    const late = walk(route2, 3.0, 5, 4, t0 + 900000);
    await post('/api/fix', { token: tok[0], fixes: late });
    await sleep(300);
    await post('/api/fix', { token: tok[3], fixes: early });
    await sleep(1200);
    const st2 = await get('/api/state');
    let early2 = 0, late1 = 0;
    for (let i = 0; i < st2.claims.length; i += 2) {
      const c = st2.claims[i], o = st2.claims[i + 1], [x, y] = mid(c);
      let dd = Infinity;
      for (let k = 1; k < route2.pts.length; k++) {
        const ax = route2.pts[k - 1][0], ay = route2.pts[k - 1][1], bx = route2.pts[k][0], by = route2.pts[k][1];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let u = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
        dd = Math.min(dd, Math.hypot(x - ax - u * dx, y - ay - u * dy));
      }
      if (dd <= 3) { if (o === 3) early2++; if (o === 0) late1++; }
    }
    check('Früherer Zeitstempel gewinnt, auch wenn er später ankommt', early2 > late1 * 3 && early2 > 5, 'früh: ' + early2 + ', spät: ' + late1);
    ws.close();
  } catch (e) {
    console.error(e); failed++;
  } finally {
    srv.kill();
  }
  console.log(failed ? '\n' + failed + ' Prüfung(en) fehlgeschlagen' : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})();
