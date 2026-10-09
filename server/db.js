/**
 * db.js — SQLite persistence. Shared by desktop and server.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const core = require('./core');

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL,
  sku TEXT,
  family TEXT,
  cls TEXT,
  party TEXT,
  party_key TEXT,
  wing TEXT,
  date TEXT,
  dt TEXT,
  month TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS ix_d_serial ON dispatches(serial);
CREATE INDEX IF NOT EXISTS ix_d_party ON dispatches(party_key);
CREATE INDEX IF NOT EXISTS ix_d_dt ON dispatches(dt);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer TEXT, store TEXT, store_key TEXT, amount REAL,
  payment TEXT, is_cod INTEGER, employee TEXT, note TEXT,
  ts TEXT, dt TEXT, ym TEXT
);
CREATE INDEX IF NOT EXISTS ix_p_store ON deposits(store_key);
CREATE INDEX IF NOT EXISTS ix_p_ym ON deposits(ym);

CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rdate TEXT, merchant TEXT, merchant_key TEXT, brand TEXT,
  model TEXT, family TEXT, serial TEXT, qty TEXT,
  price REAL, reason TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS ix_r_serial ON returns(serial);
CREATE INDEX IF NOT EXISTS ix_r_reason ON returns(reason);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- duplicate_cross | duplicate_multi | imei_lock | no_serial_return | unmatched_payment
  severity TEXT NOT NULL,      -- critical | high | medium | low
  title TEXT NOT NULL,
  detail TEXT,
  serial TEXT,
  family TEXT,
  dealer TEXT,
  amount REAL,
  owner TEXT DEFAULT '',
  status TEXT DEFAULT 'open',  -- open | investigating | resolved | dismissed
  resolution TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_f_kind ON findings(kind);
CREATE INDEX IF NOT EXISTS ix_f_status ON findings(status);

CREATE TABLE IF NOT EXISTS dealers (
  party_key TEXT PRIMARY KEY,
  name TEXT,
  aliases TEXT,
  units INTEGER DEFAULT 0,
  serials INTEGER DEFAULT 0,
  cross_dup INTEGER DEFAULT 0,
  first TEXT, last TEXT
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') {}
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

/** Load every CSV/JSON source into the database. Returns counts. */
function ingest(db, dataDir) {
  const counts = { dispatches:0, deposits:0, returns:0 };

  const s4 = path.join(dataDir, 's4_imei_master.csv');
  if (fs.existsSync(s4)) {
    const rows = parseCSV(fs.readFileSync(s4, 'utf8')).slice(1);
    const ins = db.prepare(`INSERT INTO dispatches
      (serial,sku,family,cls,party,party_key,wing,date,dt,month,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(list => {
      for (const r of list) {
        const serial = (r[5] || r[r.length-1] || '').trim();
        if (!core.isSerial(serial)) continue;
        const sku = (r[4] || '').trim();
        const dt = core.parseDate(r[1]);
        ins.run(serial, sku, core.baseSku(sku), core.deviceClass(sku),
          core.cleanParty(r[3]), core.nrm(r[3]), (r[2]||'').trim(), (r[1]||'').trim(),
          dt ? dt.toISOString() : null, (r[0]||'').trim(), 'S4');
        counts.dispatches++;
      }
    });
    tx(rows);
  }

  for (const [file, label] of [['s3_dispatch_sep.csv','S3-SEP'], ['s3_dispatch_oct.csv','S3-OCT']]) {
    const f = path.join(dataDir, file);
    if (!fs.existsSync(f)) continue;
    const rows = parseCSV(fs.readFileSync(f, 'utf8'));
    const ins = db.prepare(`INSERT INTO dispatches
      (serial,sku,family,cls,party,party_key,wing,date,dt,month,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      const serial = (r[4] || '').trim();
      if (!core.isSerial(serial)) continue;
      const sku = (r[3] || '').trim();
      const dt = core.parseDate(r[0]);
      ins.run(serial, sku, core.baseSku(sku), core.deviceClass(sku),
        core.cleanParty(r[2]), core.nrm(r[2]), (r[1]||'').trim(), (r[0]||'').trim(),
        dt ? dt.toISOString() : null, '', label);
      counts.dispatches++;
    }
  }

  const s1 = path.join(dataDir, 's1_deposits.csv');
  if (fs.existsSync(s1)) {
    const rows = parseCSV(fs.readFileSync(s1, 'utf8')).slice(1);
    const ins = db.prepare(`INSERT INTO deposits
      (dealer,store,store_key,amount,payment,is_cod,employee,note,ts,dt,ym)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      if (!r[2] || !r[2].trim()) continue;
      const amt = parseFloat(String(r[6]||'').replace(/[,\s]/g,'')) || 0;
      const dt = core.parseDate(r[2]);
      ins.run((r[1]||'').trim(), (r[5]||'').trim(), core.nrm(r[5]), amt, (r[7]||'').trim(),
        /cod/i.test(r[7]||'') ? 1 : 0, (r[4]||'').trim(), (r[10]||'').trim(),
        (r[2]||'').trim(), dt ? dt.toISOString() : null, dt ? dt.toISOString().slice(0,7) : null);
      counts.deposits++;
    }
  }

  const s4all = path.join(dataDir, 's4_all.txt');
  if (fs.existsSync(s4all)) {
    try {
      const obj = JSON.parse(fs.readFileSync(s4all, 'utf8'));
      const rows = parseCSV(obj.returns || '').slice(1);
      const ins = db.prepare(`INSERT INTO returns
        (rdate,merchant,merchant_key,brand,model,family,serial,qty,price,reason,kind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const reason = (r[8] || '').trim();
        if (!reason) continue;
        const model = (r[4] || '').trim();
        ins.run((r[1]||'').trim(), core.cleanParty(r[2]), core.nrm(r[2]), (r[3]||'').trim(),
          model, core.baseSku(model), (r[5]||'').trim(), (r[6]||'').trim(),
          parseFloat(String(r[7]||'').replace(/[,"]/g,'')) || 0, reason,
          /imei/i.test(reason) ? 'IMEI' : 'DEFECT');
        counts.returns++;
      }
    } catch (e) { /* file may be absent */ }
  }

  rebuildDealers(db);
  return counts;
}

function rebuildDealers(db) {
  const rows = db.prepare(`
    SELECT party_key, party, COUNT(*) AS units, COUNT(DISTINCT serial) AS serials,
           MIN(dt) AS first, MAX(dt) AS last
    FROM dispatches WHERE party IS NOT NULL AND party <> ''
    GROUP BY party_key`).all();
  const dup = db.prepare(`
    SELECT d.party_key, COUNT(*) AS cross_dup FROM (
      SELECT serial FROM dispatches WHERE party IS NOT NULL
      GROUP BY serial HAVING COUNT(DISTINCT party_key) > 1
    ) x JOIN dispatches d ON d.serial = x.serial
    GROUP BY d.party_key`).all();
  const dupMap = Object.fromEntries(dup.map(r => [r.party_key, r.cross_dup]));

  db.prepare('DELETE FROM dealers').run();
  const ins = db.prepare(`INSERT INTO dealers
    (party_key,name,aliases,units,serials,cross_dup,first,last) VALUES (?,?,?,?,?,?,?,?)`);
  const aliasRows = db.prepare(`SELECT DISTINCT party_key, party FROM dispatches
    WHERE party IS NOT NULL AND party <> ''`).all();
  const aliasMap = {};
  for (const a of aliasRows) (aliasMap[a.party_key] = aliasMap[a.party_key] || []).push(a.party);

  const tx = db.transaction(() => {
    for (const r of rows) {
      const al = aliasMap[r.party_key] || [r.party];
      ins.run(r.party_key, r.party, JSON.stringify(al), r.units, r.serials,
        dupMap[r.party_key] || 0, r.first, r.last);
    }
  });
  tx();
}

/** Regenerate findings from current data. Preserves owner/status for existing keys. */
function rebuildFindings(db) {
  const now = new Date().toISOString();
  const existing = new Map();
  for (const f of db.prepare('SELECT * FROM findings').all())
    existing.set(f.kind + '|' + (f.serial || f.dealer || f.detail || ''), f);

  const out = [];
  const push = (kind, severity, title, detail, serial, family, dealer, amount) => {
    const key = kind + '|' + (serial || dealer || detail || '');
    const prev = existing.get(key);
    out.push({ kind, severity, title, detail, serial: serial||null, family: family||null,
      dealer: dealer||null, amount: amount||null,
      owner: prev ? prev.owner : '', status: prev ? prev.status : 'open',
      resolution: prev ? prev.resolution : '',
      created_at: prev ? prev.created_at : now, updated_at: now });
  };

  // cross-dealer duplicate serials
  const cross = db.prepare(`
    SELECT serial, COUNT(DISTINCT party_key) AS n, GROUP_CONCAT(DISTINCT party) AS parties,
           MIN(sku) AS sku, MIN(family) AS family
    FROM dispatches GROUP BY serial HAVING n > 1`).all();
  for (const r of cross) {
    const ev = r.parties.split(',').slice(0, 6).join(' | ');
    push('duplicate_cross', 'critical',
      `Serial in ${r.n} dealers`,
      `${r.sku} — dispatched to: ${ev}`,
      r.serial, r.family, r.parties.split(',')[0], null);
  }

  // three-way or worse
  const multi = cross.filter(r => r.n >= 3);
  for (const r of multi) {
    push('duplicate_multi', 'critical',
      `Serial in ${r.n} dealers (worst case)`,
      `${r.sku} — ${r.parties.split(',').join(' | ')}`,
      r.serial, r.family, r.parties.split(',')[0], null);
  }

  // IMEI problems on returns
  const imeiRet = db.prepare(`SELECT * FROM returns WHERE kind='IMEI'`).all();
  for (const r of imeiRet) {
    push('imei_lock', 'high',
      `IMEI ${/lock/i.test(r.reason) ? 'lock' : 'mismatch'}: ${r.model}`,
      `${r.merchant} — ${r.reason} — Tk ${Math.round(r.price||0).toLocaleString()}`,
      r.serial, r.family, r.merchant, r.price);
  }

  // returns with no serial — untraceable
  const noSer = db.prepare(`SELECT * FROM returns WHERE serial IS NULL OR serial=''`).all();
  for (const r of noSer) {
    push('no_serial_return', 'high',
      `Return with no IMEI — untraceable`,
      `${r.merchant} — ${r.model} — Tk ${Math.round(r.price||0).toLocaleString()} — ${r.reason}`,
      null, r.family, r.merchant, r.price);
  }

  db.prepare('DELETE FROM findings').run();
  const ins = db.prepare(`INSERT INTO findings
    (kind,severity,title,detail,serial,family,dealer,amount,owner,status,resolution,created_at,updated_at)
    VALUES (@kind,@severity,@title,@detail,@serial,@family,@dealer,@amount,@owner,@status,@resolution,@created_at,@updated_at)`);
  const tx = db.transaction(list => { for (const f of list) ins.run(f); });
  tx(out);
  return out.length;
}

function stats(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    dispatches: one('SELECT COUNT(*) c FROM dispatches').c,
    uniqueSerials: one('SELECT COUNT(DISTINCT serial) c FROM dispatches').c,
    dealers: one('SELECT COUNT(*) c FROM dealers').c,
    families: one('SELECT COUNT(DISTINCT family) c FROM dispatches').c,
    deposits: one('SELECT COUNT(*) c FROM deposits').c,
    depositValue: one('SELECT COALESCE(SUM(amount),0) c FROM deposits').c,
    returns: one('SELECT COUNT(*) c FROM returns').c,
    returnValue: one('SELECT COALESCE(SUM(price),0) c FROM returns').c,
    crossDup: one('SELECT COUNT(*) c FROM (SELECT serial FROM dispatches GROUP BY serial HAVING COUNT(DISTINCT party_key)>1)').c,
    findings: one('SELECT COUNT(*) c FROM findings').c,
    openFindings: one("SELECT COUNT(*) c FROM findings WHERE status='open'").c,
    syncedAt: (db.prepare("SELECT v FROM meta WHERE k='synced_at'").get() || {}).v || null
  };
}

module.exports = { open, ingest, rebuildFindings, rebuildDealers, stats, parseCSV };