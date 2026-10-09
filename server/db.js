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
  kind TEXT NOT NULL,          -- duplicate_cross | duplicate_multi | imei_lock | no_serial_return | orphan_return | tac_conflict | luhn_invalid
  severity TEXT NOT NULL,      -- critical | high | medium | low  (computed)
  score INTEGER DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT,
  diagnosis TEXT,
  confidence TEXT,
  next_action TEXT,
  evidence TEXT,               -- JSON array of {label,detail,weight}
  serial TEXT,
  family TEXT,
  dealer TEXT,
  dealer_count INTEGER DEFAULT 0,
  gap_days INTEGER,
  cross_wing INTEGER DEFAULT 0,
  luhn INTEGER,
  amount REAL,
  value_at_risk REAL DEFAULT 0,
  owner TEXT DEFAULT '',
  status TEXT DEFAULT 'open',  -- open | investigating | resolved | dismissed
  resolution TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_f_kind ON findings(kind);
CREATE INDEX IF NOT EXISTS ix_f_status ON findings(status);
CREATE INDEX IF NOT EXISTS ix_f_sev ON findings(severity, score);
CREATE INDEX IF NOT EXISTS ix_f_owner ON findings(owner);

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
  migrate(db);
  return db;
}

/** Additive migrations. Existing databases gain new columns without losing
 *  the owner / status / resolution work already recorded against findings. */
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const want = {
    findings: {
      score:'INTEGER DEFAULT 0', diagnosis:'TEXT', confidence:'TEXT', next_action:'TEXT',
      evidence:'TEXT', next_actions:'TEXT', dealer_count:'INTEGER DEFAULT 0', gap_days:'INTEGER',
      cross_wing:'INTEGER DEFAULT 0', luhn:'INTEGER', value_at_risk:'REAL DEFAULT 0',
      value_basis:'TEXT'
    }
  };
  for (const [table, adds] of Object.entries(want)) {
    const have = new Set(cols(table));
    for (const [name, type] of Object.entries(adds)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
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

/** Regenerate findings from current data, with a reasoned diagnosis attached.
 *  Preserves owner / status / resolution for anything that survives regeneration. */
function rebuildFindings(db) {
  const now = new Date().toISOString();
  const R = require('./reason');
  const book = R.buildPriceBook(db);
  const priced = new Set([...book.keys()]);

  const existing = new Map();
  for (const f of db.prepare('SELECT * FROM findings').all())
    existing.set(f.kind + '|' + (f.serial || f.dealer || f.detail || ''), f);

  const out = [];

  function push(f) {
    const key = f.kind + '|' + (f.serial || f.dealer || f.detail || '');
    const prev = existing.get(key);
    const scored = R.scoreFinding(f);
    out.push({
      kind: f.kind, title: f.title, detail: f.detail || null,
      diagnosis: f.diagnosis || null, confidence: f.confidence || null,
      evidence: JSON.stringify(f.evidence || []),
      next_action: (f.nextActions && f.nextActions[0]) || null,
      next_actions: JSON.stringify(f.nextActions || []),
      score: scored.score, severity: scored.band,
      serial: f.serial || null, family: f.family || null, dealer: f.dealer || null,
      dealer_count: f.dealerCount || null,
      gap_days: (f.gapDays === undefined || f.gapDays === null) ? null : f.gapDays,
      cross_wing: f.crossWing ? 1 : 0,
      luhn: (f.luhn === undefined || f.luhn === null) ? null : (f.luhn ? 1 : 0),
      amount: f.amount || null, value_at_risk: f.valueAtRisk || 0,
      value_basis: (f.family && priced.has(f.family))
        ? 'median of logged returns for ' + f.family
        : (f.valueAtRisk ? 'from the return record' : 'no observed price for this model — exposure is real but unpriced'),
      owner: prev ? prev.owner : '', status: prev ? prev.status : 'open',
      resolution: prev ? prev.resolution : '',
      created_at: prev ? prev.created_at : now, updated_at: now
    });
  }

  // ---------- duplicate serials, diagnosed ----------
  const dup = db.prepare(`
    SELECT serial, COUNT(*) rows_n, COUNT(DISTINCT party_key) dealers,
           MIN(sku) sku, MIN(family) family
    FROM dispatches GROUP BY serial HAVING dealers > 1
    ORDER BY dealers DESC, rows_n DESC`).all();

  const dupRecs = db.prepare(`SELECT serial, party, wing, date, dt, family, sku
    FROM dispatches ORDER BY dt, id`).all();
  const bySerial = new Map();
  for (const r of dupRecs) {
    if (!bySerial.has(r.serial)) bySerial.set(r.serial, []);
    bySerial.get(r.serial).push(r);
  }

  const chainInput = [];
  for (const r of dup) {
    const recs = bySerial.get(r.serial) || [];
    const diag = R.diagnoseDuplicate(recs.map(x => ({
      serial: r.serial, party: x.party, wing: x.wing, date: x.date, dt: x.dt,
      family: x.family, sku: x.sku
    })), book);
    const crossWing = new Set(recs.map(x => (x.wing || '').trim())).size > 1;
    const kind = diag.dealers.length >= 3 ? 'duplicate_multi' : 'duplicate_cross';
    chainInput.push({ serial: r.serial, stops: recs.map(x => ({ party: x.party })), value: diag.valueAtRisk });

    push({
      kind,
      title: diag.dealers.length >= 3
        ? `Serial recorded across ${diag.dealers.length} dealers`
        : 'Serial recorded against two dealers',
      detail: `${diag.family} — ${diag.flow.map(f => `${f.date} ${f.party}`).join('  →  ')}`,
      diagnosis: diag.diagnosis,
      confidence: R.confidenceFor(diag, diag.evidence),
      evidence: diag.evidence,
      nextActions: diag.nextActions,
      serial: r.serial, family: diag.family, dealer: diag.dealers[0],
      dealerCount: diag.dealers.length, gapDays: diag.gapDays,
      crossWing, luhn: diag.luhn, valueAtRisk: diag.valueAtRisk
    });
  }

  // ---------- returns with no serial ----------
  for (const r of db.prepare(`SELECT * FROM returns WHERE serial IS NULL OR serial=''`).all()) {
    push({
      kind: 'no_serial_return',
      title: 'Return with no serial — cannot be located',
      detail: `${r.merchant} — ${r.model} — Tk ${Math.round(r.price || 0).toLocaleString()} — ${r.reason}`,
      diagnosis: 'A unit was returned but no serial was recorded, so there is no way to prove which handset it was or whether it re-entered stock.',
      confidence: 'high',
      evidence: [
        { label: 'Serial', detail: 'The serial field is empty on the return record.', weight: 'bad' },
        { label: 'Value', detail: 'Tk ' + Math.round(r.price || 0).toLocaleString() + ' of stock cannot be traced.', weight: 'bad' }
      ],
      nextActions: [
        'Ask the dealer which unit was returned — model and colour usually narrow it to one or two.',
        'Search dispatch records for that model to shortlist candidate serials.',
        'Adopt a written rule: no serial, no return accepted.'
      ],
      family: r.family, dealer: r.merchant, amount: r.price, valueAtRisk: r.price || 0
    });
  }

  // ---------- returns we have no dispatch record for ----------
  for (const r of db.prepare(`
    SELECT r.* FROM returns r LEFT JOIN dispatches d ON d.serial = r.serial
    WHERE r.serial <> '' AND d.id IS NULL`).all()) {
    push({
      kind: 'orphan_return',
      title: 'Returned a unit we never dispatched',
      detail: `${r.merchant} — ${r.model} — Tk ${Math.round(r.price || 0).toLocaleString()} — ${r.reason}`,
      diagnosis: 'A handset came back that does not appear anywhere in the dispatch ledger. Either it shipped before this ledger period, from the other warehouse, or the serial on the paperwork is wrong.',
      confidence: 'medium',
      evidence: [
        { label: 'Serial', detail: r.serial + ' — not found in any dispatch record.', weight: 'bad' },
        { label: 'Possible causes', detail: 'Outside the ledger period, wrong warehouse, or a transcription error.', weight: 'warn' }
      ],
      nextActions: [
        'Search the previous period and the other warehouse before treating this as a loss.',
        'Confirm the serial against the physical unit — it may simply be mistyped.',
        'If it cannot be placed, it is dead stock that will never sell.'
      ],
      serial: r.serial, family: r.family, dealer: r.merchant, amount: r.price, valueAtRisk: r.price || 0
    });
  }

  // ---------- IMEI problems ----------
  for (const r of db.prepare(`SELECT * FROM returns WHERE kind='IMEI'`).all()) {
    const lock = /lock/i.test(r.reason);
    push({
      kind: 'imei_lock',
      title: (lock ? 'IMEI locked: ' : 'IMEI does not match invoice: ') + (r.family || r.model),
      detail: `${r.merchant} — ${r.reason} — Tk ${Math.round(r.price || 0).toLocaleString()}`,
      diagnosis: lock
        ? 'The unit returned locked. Either a previous owner account is still attached (FRP), an operator network lock is active, or the mainboard was replaced and written with the wrong serial.'
        : 'The serial on the unit differs from the one on the paperwork, so it cannot be matched to an invoice and must not re-enter stock.',
      confidence: 'high',
      evidence: [
        { label: 'Logged reason', detail: r.reason, weight: 'bad' },
        { label: 'Consequence', detail: 'The unit cannot be sold as new until the serial is resolved.', weight: 'bad' },
        { label: 'Check for a pattern', detail: 'Counted alongside other IMEI issues on this model — if one model dominates it is a batch problem.', weight: 'warn' }
      ],
      nextActions: lock ? [
        'Dial *#06# on the unit and compare with the box and the invoice — all three must match.',
        'If it asks for a previous account, only the original owner can release it. Do not attempt a repair.',
        'Group by model: if one model dominates, raise a batch claim with the supplier.'
      ] : [
        'Photograph the unit and the box label side by side.',
        'Segregate permanently as bad-bin. A mismatched serial must never re-enter sellable stock.',
        'Raise a warranty claim with the supplier rather than writing the unit off.'
      ],
      serial: r.serial, family: r.family, dealer: r.merchant, amount: r.price, valueAtRisk: r.price || 0
    });
  }

  // ---------- serials failing their check digit ----------
  for (const r of db.prepare(`SELECT DISTINCT serial, family FROM dispatches WHERE LENGTH(serial)=15`).all()) {
    if (R.luhn(r.serial) !== false) continue;
    push({
      kind: 'luhn_invalid',
      title: 'Serial fails its check digit',
      detail: `${r.family} — ${r.serial}`,
      diagnosis: 'The serial is not a valid IMEI. Either it was mistyped on entry, or it is a cloned serial from an unofficial device.',
      confidence: 'high',
      evidence: [{ label: 'Check digit', detail: 'Fails the standard Luhn validation every IMEI must pass.', weight: 'bad' }],
      nextActions: [
        'Compare against the box label and correct the record if mistyped.',
        'If it matches the box, the unit is a clone — do not sell it and report the supplier.'
      ],
      serial: r.serial, family: r.family
    });
  }

  // ---------- one serial prefix recorded against several models ----------
  const tacRows = db.prepare(`SELECT SUBSTR(serial,1,8) t, family, COUNT(DISTINCT serial) n
    FROM dispatches WHERE LENGTH(serial)=15 GROUP BY t, family`).all();
  const tacMap = new Map();
  for (const r of tacRows) {
    if (!tacMap.has(r.t)) tacMap.set(r.t, new Map());
    tacMap.get(r.t).set(r.family, r.n);
  }
  for (const [t, fams] of tacMap) {
    if (fams.size < 2) continue;
    push({
      kind: 'tac_conflict',
      title: `Serial prefix ${t} recorded against ${fams.size} models`,
      detail: [...fams.keys()].join(' | '),
      diagnosis: 'One Type Allocation Code — which identifies a single model — is recorded against several different models. Either the catalogue mapping is wrong or serials were entered against the wrong product.',
      confidence: fams.size >= 4 ? 'high' : 'low',
      evidence: [
        { label: 'Prefix', detail: t + ' maps to a single model by industry standard.', weight: 'warn' },
        { label: 'Models seen', detail: [...fams.entries()].map(([k, v]) => `${k} (${v})`).join(', '), weight: 'warn' }
      ],
      nextActions: [
        'Confirm the model held by each dealer against the physical unit.',
        'Correct the SKU mapping so future dispatches land in the right family.'
      ],
      family: [...fams.keys()][0]
    });
  }

  db.prepare('DELETE FROM findings').run();
  const ins = db.prepare(`INSERT INTO findings
    (kind,severity,score,title,detail,diagnosis,confidence,next_action,evidence,next_actions,
     serial,family,dealer,dealer_count,gap_days,cross_wing,luhn,amount,value_at_risk,value_basis,
     owner,status,resolution,created_at,updated_at)
    VALUES (@kind,@severity,@score,@title,@detail,@diagnosis,@confidence,@next_action,@evidence,@next_actions,
     @serial,@family,@dealer,@dealer_count,@gap_days,@cross_wing,@luhn,@amount,@value_at_risk,@value_basis,
     @owner,@status,@resolution,@created_at,@updated_at)`);
  const tx = db.transaction(list => { for (const f of list) ins.run(f); });
  tx(out);

  // ---------- dealer-to-dealer flows ----------
  db.exec(`CREATE TABLE IF NOT EXISTS chains (
    pair TEXT PRIMARY KEY, from_party TEXT, to_party TEXT,
    count INTEGER, value REAL, sample TEXT, verdict TEXT)`);
  db.prepare('DELETE FROM chains').run();
  const ci = db.prepare(`INSERT INTO chains (pair,from_party,to_party,count,value,sample,verdict)
    VALUES (?,?,?,?,?,?,?)`);
  for (const c of R.buildChains(chainInput))
    ci.run(c.from + ' -> ' + c.to, c.from, c.to, c.count, c.value, JSON.stringify(c.sample), c.verdict);

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