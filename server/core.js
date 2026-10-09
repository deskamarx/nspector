/**
 * core.js — shared normalisation + analysis logic.
 * Used by the server, and mirrored to the web client so phone and desktop
 * compute identical results.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MONTH_IDX = { january:0, february:1, march:2, april:3, may:4, june:5, july:6,
                      august:7, september:8, october:9, november:10, december:11 };

  function parseDate(s) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\w+)\s+(\d{1,2})$/i);
    if (m && MONTH_IDX[m[1].toLowerCase()] !== undefined)
      return new Date(2026, MONTH_IDX[m[1].toLowerCase()], +m[2]);
    m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2]-1, +m[1]); }
    m = s.match(/^(\d{1,2})[-\/](\d{1,2})$/);
    if (m) return new Date(2026, +m[2]-1, +m[1]);
    m = s.match(/^([A-Za-z]{3})[-\/](\d{1,2})$/);
    if (m) { const k = Object.keys(MONTH_IDX).find(x => x.slice(0,3) === m[1].toLowerCase());
             if (k) return new Date(2026, MONTH_IDX[k], +m[2]); }
    m = s.match(/^(\d{1,2})-(\w{3})$/i);
    if (m) { const k = Object.keys(MONTH_IDX).find(x => x.slice(0,3) === m[2].toLowerCase());
             if (k) return new Date(2026, MONTH_IDX[k], +m[1]); }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  const nrm = s => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanParty = s => (s || '').toString().trim().replace(/^"+|"+$/g, '').replace(/,+$/, '').trim();

  function isSerial(s) {
    const t = (s || '').trim();
    if (!t) return false;
    if (/^\d{15}$/.test(t)) return true;
    if (/^\d{6,7}[\/\-][\w\-]{8,}$/i.test(t)) return true;
    if (/^A[\w]{10,}$/i.test(t)) return true;
    if (/^H\d{10,}[A-Z]{2,}$/i.test(t)) return true;
    return false;
  }

  function deviceClass(sku) {
    const s = (sku || '').toLowerCase();
    if (/tv box|tv stick/.test(s)) return 'TV';
    if (/pad|tab/.test(s)) return 'PAD';
    if (/iphone/.test(s)) return 'IPHONE';
    return 'PHONE';
  }

  // Collapse SKU spelling variants into a product family
  const SKU_RULES = [
    [/iphone\s*1[1-9]\s*pro\s*max/i, 'Apple iPhone Pro Max'],
    [/iphone\s*1[1-9]\s*pro/i,     'Apple iPhone Pro'],
    [/iphone/i,                     'Apple iPhone'],
    [/redmi\s*note\s*1[0-9].*pro\s*max/i,  'Redmi Note Pro Max'],
    [/redmi\s*note\s*1[0-9].*pro\s*plus/i, 'Redmi Note Pro Plus'],
    [/redmi\s*note\s*1[0-9]\s*pro/i, 'Redmi Note Pro'],
    [/redmi\s*note/i,               'Redmi Note'],
    [/redmi\s*1[0-9]c/i,            'Redmi C-series'],
    [/redmi\s*pad\s*2\s*pro/i,     'Redmi Pad 2 Pro'],
    [/redmi\s*pad\s*2\s*9\.7/i,    'Redmi Pad 2 9.7'],
    [/redmi\s*pad\s*2/i,            'Redmi Pad 2'],
    [/redmi\s*pad/i,                'Redmi Pad'],
    [/redmi/i,                      'Redmi'],
    [/xiaomi\s*\d+t/i,              'Xiaomi T-series'],
    [/xiaomi\s*pad/i,               'Xiaomi Pad'],
    [/honor\s*pad|honor\s*x9a|h\s*pad/i, 'HONOR Pad'],
    [/pad/i,                        'Tablet (unclassified)'],
    [/^x9c/i,                       'HONOR X9C'],
    [/x9d/i,                        'HONOR X9D'],
    [/x8/i,                         'HONOR X8'],
    [/x7/i,                         'HONOR X7'],
    [/400\s*pro/i,                  'HONOR 400 Pro'],
    [/400/i,                        'HONOR 400'],
    [/200/i,                        'HONOR 200'],
    [/tv\s*box/i,                   'TV Box'],
    [/tv\s*stick/i,                 'TV Stick'],
    [/tv/i,                         'TV (other)'],
    [/magic/i,                      'HONOR Magic'],
    [/poco/i,                       'POCO'],
  ];
  function baseSku(sku) {
    let s = (sku || '').trim();
    if (!s || /^undefined$/i.test(s)) return 'UNCLASSIFIED';
    if (/600\s*lite|600\s*\|\s*lite/i.test(s)) return 'HONOR 600 Lite';
    if (/600\s*pro|600\s*\|\s*pro/i.test(s))   return 'HONOR 600 Pro';
    if (/600/i.test(s))                        return 'HONOR 600';
    s = s.replace(/\s*-\s*(black|white|gold|blue|green|orange|purple|pink|grey|gray|silver|violet|sky teal|cloud blush|cyan|navy|midnight|titanium|brown|red|teal)\s*$/i, '').trim() || s;
    for (const [re, name] of SKU_RULES) if (re.test(s)) return name;
    return s;
  }

  /** Build indexes over dispatch records. Records: {serial, sku, party, wing, date, dt} */
  function analyse(records) {
    const imei = new Map();
    for (const r of records) {
      if (!r.serial) continue;
      if (!imei.has(r.serial)) imei.set(r.serial, []);
      imei.get(r.serial).push(r);
    }
    const dupCross = [], dupSame = [], dupMulti = [], dupCrossWing = [];
    for (const [serial, recs] of imei) {
      if (recs.length < 2) continue;
      const parties = new Set(recs.map(r => nrm(r.party)));
      const ds = recs.map(r => r.dt).filter(Boolean).map(d => d.getTime()).sort((a,b)=>a-b);
      const gap = ds.length < 2 ? 9999 : Math.round((ds[ds.length-1]-ds[0]) / 86400000);
      const item = { serial, sku: recs[0].sku, recs, partyCount: parties.size, gapDays: gap };
      if (recs.length > 2) dupMulti.push(item);
      if (parties.size > 1) {
        dupCross.push(item);
        if (new Set(recs.map(r => r.wing)).size > 1) dupCrossWing.push(item);
      } else dupSame.push(item);
    }
    dupCross.sort((a,b) => a.gapDays - b.gapDays);
    dupMulti.sort((a,b) => b.recs.length - a.recs.length);

    // dealer aggregation
    const dealers = new Map();
    const getD = name => {
      const k = nrm(name);
      if (!dealers.has(k)) dealers.set(k, { key:k, display:name, aliases:new Set([name]), units:0,
        serials:new Set(), crossDup:0, extraRows:0, skus:new Set(), wings:new Set(), first:null, last:null });
      return dealers.get(k);
    };
    for (const [serial, recs] of imei) {
      const isCross = recs.length > 1 && new Set(recs.map(r => nrm(r.party))).size > 1;
      for (const r of recs) {
        if (!r.party) continue;
        const d = getD(r.party);
        d.aliases.add(r.party); d.units++; d.serials.add(serial);
        if (r.sku) d.skus.add(r.sku);
        if (r.wing) d.wings.add(r.wing);
        if (r.dt) { if (!d.first || r.dt < d.first) d.first = r.dt; if (!d.last || r.dt > d.last) d.last = r.dt; }
        if (isCross) d.crossDup++;
      }
      if (recs.length > 1) for (const r of recs) if (r.party) getD(r.party).extraRows += recs.length - 1;
    }

    // SKU family risk
    const fam = new Map();
    for (const [serial, recs] of imei) {
      const base = baseSku(recs[0].sku);
      if (!fam.has(base)) fam.set(base, { sku:base, units:0, dupUnits:0, crossDup:0, dealers:new Set(), imeiLock:0, imeiDiff:0 });
      const f = fam.get(base);
      f.units += recs.length;
      if (recs.length > 1) f.dupUnits++;
      if (recs.length > 1 && new Set(recs.map(r => nrm(r.party))).size > 1) f.crossDup++;
      recs.forEach(r => f.dealers.add(r.party));
    }

    const stats = {
      totalRows: records.length,
      uniqueSerials: imei.size,
      duplicateSerials: dupCross.length + dupSame.length,
      crossDealer: dupCross.length,
      sameDealer: dupSame.length,
      multi: dupMulti.length,
      crossWing: dupCrossWing.length,
      dealers: dealers.size
    };
    return { imei, dupCross, dupSame, dupMulti, dupCrossWing, dealers, fam, stats };
  }

  function attachReturns(analysis, returns) {
    for (const r of returns) {
      const base = baseSku(r.model);
      if (!analysis.fam.has(base)) analysis.fam.set(base,
        { sku:base, units:0, dupUnits:0, crossDup:0, dealers:new Set(), imeiLock:0, imeiDiff:0 });
      const f = analysis.fam.get(base);
      if (/imei\s*lock/i.test(r.reason)) f.imeiLock++;
      if (/imei\s*different/i.test(r.reason)) f.imeiDiff++;
    }
    return analysis;
  }

  function skuRisk(analysis) {
    return [...analysis.fam.values()].filter(s => s.units >= 5).map(s => {
      const dupRate = s.units ? Math.round(s.dupUnits / s.units * 1000) / 10 : 0;
      const lockRate = s.units ? Math.round((s.imeiLock + s.imeiDiff) / s.units * 1000) / 10 : 0;
      return { sku:s.sku, units:s.units, dupUnits:s.dupUnits, crossDup:s.crossDup,
               imeiLock:s.imeiLock, imeiDiff:s.imeiDiff, dupRate, lockRate,
               risk: Math.round((dupRate + (s.imeiLock + s.imeiDiff) * 8 + lockRate * 10) * 10) / 10 };
    }).sort((a,b) => b.risk - a.risk);
  }

  return { MONTH_IDX, parseDate, nrm, cleanParty, isSerial, deviceClass, baseSku,
           analyse, attachReturns, skuRisk };
});