/**
 * server.js — REST API + WebSocket live sync.
 * One process serves the desktop app, the Android app, and any browser.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const dbm = require('./db');
const sync = require('./sync');
const core = require('./core');

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = process.env.NSPECTOR_DATA || path.join(ROOT, 'data');
const DBFILE = process.env.NSPECTOR_DB || path.join(ROOT, 'nspector.db');

const db = dbm.open(DBFILE);
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(WEB));

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) { if (c.readyState === 1) { try { c.send(s); } catch (e) {} } }
}
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type:'hello', stats: dbm.stats(db), clients: clients.size }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', m => {
    try { const d = JSON.parse(m);
      if (d.type === 'ping') ws.send(JSON.stringify({ type:'pong', t: Date.now() }));
    } catch (e) {}
  });
});

// ---------- helpers ----------
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

// ---------- api ----------
app.get('/api/health', (req, res) => res.json({ ok:true, ts: Date.now() }));

app.get('/api/stats', (req, res) => {
  const s = dbm.stats(db);
  s.liveClients = clients.size;
  res.json(s);
});

app.get('/api/overview', (req, res) => {
  const stats = dbm.stats(db);
  const cod = q(`SELECT ym, COUNT(*) n, SUM(amount) amt,
      SUM(CASE WHEN is_cod=1 THEN amount ELSE 0 END) cod_amt,
      SUM(CASE WHEN is_cod=1 THEN 1 ELSE 0 END) cod_n
    FROM deposits WHERE ym IS NOT NULL GROUP BY ym ORDER BY ym`);
  const dispatch = q(`SELECT substr(dt,1,7) ym, COUNT(*) units
    FROM dispatches WHERE dt IS NOT NULL GROUP BY ym ORDER BY ym`);
  const dispatchByFamily = q(`SELECT family, COUNT(*) units, COUNT(DISTINCT serial) serials
    FROM dispatches GROUP BY family ORDER BY units DESC LIMIT 40`);
  const classes = q(`SELECT cls, COUNT(*) units FROM dispatches GROUP BY cls`);
  const dupTop = q(`
    SELECT d.party_key, d.name, d.units, d.cross_dup,
      (SELECT COUNT(DISTINCT serial) FROM dispatches x WHERE x.party_key=d.party_key) serials
    FROM dealers d WHERE d.cross_dup > 0 ORDER BY d.cross_dup DESC LIMIT 25`);
  res.json({ stats, cod, dispatch, dispatchByFamily, classes, dupTop });
});

/** duplicate serials with filtering + paging */
app.get('/api/duplicates', (req, res) => {
  const dealer = (req.query.dealer || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);
  const kind = (req.query.kind || 'cross').toString(); // cross | same | multi

  let sql = `
    SELECT serial, COUNT(*) n, COUNT(DISTINCT party_key) dealers,
           GROUP_CONCAT(DISTINCT party) parties, GROUP_CONCAT(DISTINCT wing) wings,
           MIN(sku) sku, MIN(family) family,
           MIN(dt) first_dt, MAX(dt) last_dt,
           COUNT(DISTINCT dt) dates
    FROM dispatches GROUP BY serial HAVING n > 1`;
  const params = [];
  if (kind === 'cross') sql += ' AND dealers > 1';
  if (kind === 'multi') sql += ' AND dealers >= 3';
  sql += ' ORDER BY dealers DESC, n DESC, last_dt DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  let rows = q(sql, ...params);

  if (dealer) {
    const k = core.nrm(dealer);
    const filt = rows.filter(r => String(r.parties).split(',').some(p => core.nrm(p) === k));
    const full = q(`SELECT serial, COUNT(*) n, COUNT(DISTINCT party_key) dealers,
        GROUP_CONCAT(DISTINCT party) parties, GROUP_CONCAT(DISTINCT wing) wings,
        MIN(sku) sku, MIN(family) family, MIN(dt) first_dt, MAX(dt) last_dt
      FROM dispatches GROUP BY serial HAVING n > 1 AND dealers > 1`);
    rows = filt;
    const totalForDealer = full.filter(r => String(r.parties).split(',').some(p => core.nrm(p) === k)).length;
    rows.totalForDealer = totalForDealer;
  }
  res.json({ rows, kind, dealer });
});

/** every record for one serial */
app.get('/api/imei/:serial', (req, res) => {
  const s = req.params.serial.trim();
  const recs = q(`SELECT * FROM dispatches WHERE serial=? ORDER BY dt, id`, s);
  const ret = q(`SELECT * FROM returns WHERE serial=?`, s);
  const finding = q(`SELECT * FROM findings WHERE serial=?`, s);
  res.json({ serial:s, found: recs.length > 0, dispatches: recs, returns: ret, findings: finding });
});

app.get('/api/dealers', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 2000);
  const search = (req.query.q || '').toString().trim();
  let rows = q(`
    SELECT d.*,
      COALESCE((SELECT SUM(amount) FROM deposits p WHERE p.store_key IN
        (SELECT party_key FROM dealers z WHERE z.name=d.name)),0) paid
    FROM dealers d ORDER BY d.units DESC LIMIT ?`, limit);
  if (search) {
    const k = core.nrm(search);
    rows = rows.filter(r => core.nrm(r.name).includes(k) || core.nrm(r.aliases || '').includes(k));
  }
  res.json({ rows, total: one('SELECT COUNT(*) c FROM dealers').c });
});

app.get('/api/dealers/:key', (req, res) => {
  const k = req.params.key;
  const d = one('SELECT * FROM dealers WHERE party_key=?', k);
  if (!d) return res.status(404).json({ error:'not found' });
  const serials = q(`SELECT serial, sku, family, date, dt, wing, party FROM dispatches
    WHERE party_key=? ORDER BY dt DESC LIMIT 500`, k);
  const dups = q(`SELECT serial, COUNT(*) n, GROUP_CONCAT(DISTINCT party) parties,
      MIN(sku) sku, MIN(family) family
    FROM dispatches WHERE serial IN (SELECT serial FROM dispatches WHERE party_key=?)
    GROUP BY serial HAVING n > 1`, k);
  const rets = q(`SELECT * FROM returns WHERE merchant_key=? ORDER BY rdate DESC`, k);
  const dep = q(`SELECT COUNT(*) n, SUM(amount) amt FROM deposits WHERE store_key=?`, k);
  const findings = q(`SELECT * FROM findings WHERE dealer LIKE ?`, `%${d.name}%`);
  res.json({ dealer:{ ...d, aliases: JSON.parse(d.aliases || '[]') },
             serials, duplicates: dups, returns: rets,
             deposits: dep[0] || { n:0, amt:0 }, findings });
});

app.get('/api/returns', (req, res) => {
  const family = (req.query.family || '').toString().trim();
  const kind = (req.query.kind || '').toString().trim();
  let rows = q(`SELECT * FROM returns ORDER BY rdate DESC`);
  if (family) rows = rows.filter(r => core.nrm(r.family).includes(core.nrm(family)));
  if (kind === 'imei') rows = rows.filter(r => r.kind === 'IMEI');
  res.json({ rows, total: rows.length });
});

/** model risk ranking */
app.get('/api/risk', (req, res) => {
  const rows = q(`SELECT family,
      SUM(1) units,
      COUNT(DISTINCT serial) serials,
      COUNT(DISTINCT CASE WHEN serial IN (SELECT serial FROM dispatches GROUP BY serial HAVING COUNT(*)>1) THEN serial END) dup_serials
    FROM dispatches GROUP BY family`);
  const dupCross = q(`SELECT family, COUNT(DISTINCT serial) n FROM dispatches
    WHERE serial IN (SELECT serial FROM dispatches GROUP BY serial HAVING COUNT(DISTINCT party_key)>1)
    GROUP BY family`);
  const crossMap = Object.fromEntries(dupCross.map(r => [r.family, r.n]));
  const locks = q(`SELECT family, COUNT(*) n FROM returns WHERE kind='IMEI' GROUP BY family`);
  const lockMap = Object.fromEntries(locks.map(r => [r.family, r.n]));

  const out = rows.map(r => {
    const dupUnits = r.units - r.serials;
    const dupRate = r.units ? Math.round(dupUnits / r.units * 1000)/10 : 0;
    const lock = lockMap[r.family] || 0;
    const lockRate = r.units ? Math.round(lock / r.units * 1000)/10 : 0;
    return { family:r.family, units:r.units, serials:r.serials, dupUnits,
             crossDup: crossMap[r.family] || 0, dupRate,
             imeiLock: lock, lockRate,
             risk: Math.round((dupRate + lock*8 + lockRate*10)*10)/10 };
  }).filter(r => r.units >= 5).sort((a,b) => b.risk - a.risk);
  res.json({ rows: out });
});

/** findings / work queue with ownership */
app.get('/api/findings', (req, res) => {
  const status = (req.query.status || '').toString().trim();
  const kind = (req.query.kind || '').toString().trim();
  const owner = (req.query.owner || '').toString().trim();
  let sql = 'SELECT * FROM findings WHERE 1=1';
  const p = [];
  if (status) { sql += ' AND status=?'; p.push(status); }
  if (kind) { sql += ' AND kind=?'; p.push(kind); }
  if (owner) { sql += ' AND owner=?'; p.push(owner); }
  sql += ` ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
            WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC`;
  const rows = db.prepare(sql).all(...p);
  const counts = one(`SELECT
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status='investigating' THEN 1 ELSE 0 END) investigating,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved,
      SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) dismissed,
      COUNT(*) total FROM findings`);
  const byOwner = q(`SELECT owner, status, COUNT(*) n FROM findings
    GROUP BY owner, status ORDER BY n DESC`);
  res.json({ rows, counts, byOwner });
});

app.patch('/api/findings/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, owner, resolution } = req.body || {};
  const cur = one('SELECT * FROM findings WHERE id=?', id);
  if (!cur) return res.status(404).json({ error:'not found' });
  const n = { status: status || cur.status, owner: owner !== undefined ? owner : cur.owner,
              resolution: resolution !== undefined ? resolution : cur.resolution,
              updated_at: new Date().toISOString() };
  db.prepare(`UPDATE findings SET status=?, owner=?, resolution=?, updated_at=? WHERE id=?`)
    .run(n.status, n.owner, n.resolution, n.updated_at, id);
  const row = one('SELECT * FROM findings WHERE id=?', id);
  broadcast({ type:'finding_updated', finding: row, by: req.body && req.body.actor || null });
  res.json({ ok:true, finding: row });
});

/** ownership + progress rollup */
app.get('/api/ownership', (req, res) => {
  const people = q(`SELECT owner,
      COUNT(*) total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status='investigating' THEN 1 ELSE 0 END) investigating,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved,
      SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) dismissed,
      SUM(CASE WHEN status='open' THEN amount ELSE 0 END) open_amount
    FROM findings GROUP BY owner ORDER BY total DESC`);
  const unassigned = one(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt
    FROM findings WHERE owner='' OR owner IS NULL`);
  const byKind = q(`SELECT kind, severity, COUNT(*) n, COALESCE(SUM(amount),0) amt
    FROM findings GROUP BY kind, severity ORDER BY n DESC`);
  res.json({ people, unassigned, byKind });
});

app.post('/api/sync', async (req, res) => {
  const ids = (req.body && req.body.sheetIds) || null;
  const fetched = await sync.fetchSheets(DATA, ids);
  const r = sync.runSync(db, DATA, broadcast);
  res.json({ fetched, ...r });
});

app.get('/api/sync/status', (req, res) => {
  res.json({ syncedAt: (one("SELECT v FROM meta WHERE k='synced_at'")||{}).v || null,
             dataDir: DATA, dbFile: DBFILE, clients: clients.size });
});

app.get('/api/clients', (req, res) => res.json({ live: clients.size }));

// first run
if (!dbm.stats(db).dispatches) {
  console.log('[nspector] first run — ingesting from', DATA);
  const r = sync.runSync(db, DATA, null);
  if (r.ok) console.log('[nspector] loaded', r.stats.dispatches, 'dispatch records,', r.findings, 'findings');
  else console.log('[nspector] initial ingest failed:', r.error, '— drop CSVs into', DATA);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NSpector running`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  data: ${DATA}`);
  console.log(`  live clients: ${clients.size}\n`);
});

module.exports = { app, server, db, broadcast };