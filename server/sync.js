/**
 * sync.js — pulls source sheets, writes to SQLite, broadcasts to connected clients.
 *
 * Sheet access modes:
 *   - Sheet IDs exported as CSV into dataDir (offline / private sheets)
 *   - Direct Google Sheets CSV export over HTTPS when ids are configured
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dbm = require('./db');

const SHEETS = [
  { id:'1U1oAloFWrNMWpwe5KHcUDxGv8gTQyp8prAcMvyGq5yk', gid:'257611599', file:'s1_deposits.csv' },
  { id:'1Vy0LB_ROivQthO41x49ezzIi2xljesjdC59OlUSmG0E', gid:'1061898040', file:'s2_dispatch.csv' },
  { id:'1bqkVehJun-96yjFNrJRw9S89e3YSjt1pu8e6d0x07bk', gid:'941937340', file:'s3_dispatch_sep.csv' },
  { id:'1mop7ZAi0wxPjLmz-Fxc8u0vBKA9gtglrvO234QTEXDo', gid:'671067437', file:'s4_imei_master.csv' },
];

function fetchCsv(url, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchCsv(res.headers.location, timeout).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 60e6) req.destroy(); });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Download any configured sheets that are not already local. Never throws. */
async function fetchSheets(dataDir, ids) {
  const results = [];
  for (const s of SHEETS) {
    if (ids && !ids.includes(s.id)) continue;
    const dest = path.join(dataDir, s.file);
    if (fs.existsSync(dest)) continue;              // already have a local copy
    const url = `https://docs.google.com/spreadsheets/d/${s.id}/export?format=csv&gid=${s.gid}`;
    try {
      const body = await fetchCsv(url);
      if (body && !body.startsWith('<!DOCTYPE')) {
        fs.writeFileSync(dest, body, 'utf8');
        results.push({ file:s.file, ok:true, bytes:body.length });
      } else results.push({ file:s.file, ok:false, reason:'not public' });
    } catch (e) {
      results.push({ file:s.file, ok:false, reason:e.message });
    }
    await new Promise(r => setTimeout(r, 800));       // be polite
  }
  return results;
}

function runSync(db, dataDir, broadcast) {
  const t0 = Date.now();
  try {
    db.prepare('DELETE FROM dispatches').run();
    db.prepare('DELETE FROM deposits').run();
    db.prepare('DELETE FROM returns').run();
    const counts = dbm.ingest(db, dataDir);
    const findings = dbm.rebuildFindings(db);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO meta (k,v) VALUES ('synced_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(at);
    const stats = dbm.stats(db);
    if (broadcast) broadcast({ type:'synced', at, stats, counts, findings, ms: Date.now()-t0 });
    return { ok:true, at, stats, counts, findings, ms: Date.now()-t0 };
  } catch (e) {
    if (broadcast) broadcast({ type:'sync_error', error: e.message });
    return { ok:false, error: e.message };
  }
}

module.exports = { fetchSheets, runSync, SHEETS };