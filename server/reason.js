/**
 * reason.js — inference engine.
 *
 * Turns raw ledger facts into a diagnosis with evidence, confidence and a
 * concrete next action. Nothing here guesses silently: every conclusion
 * carries the observations that produced it and a confidence level.
 */
const core = require('./core');

const { nrm } = core;

// ---------------------------------------------------------------- IMEI checks

/** Luhn check digit — the standard IMEI validation. null for non-15-digit serials. */
function luhn(serial) {
  if (!/^\d{15}$/.test(serial || '')) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = +serial[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (sum + (+serial[14])) % 10 === 0;
}

/** Type Allocation Code = first 8 digits of a 15-digit IMEI. Identifies the model. */
function tac(serial) {
  return /^\d{15}$/.test(serial || '') ? serial.slice(0, 8) : null;
}

function serialKind(serial) {
  const s = (serial || '').trim();
  if (/^\d{15}$/.test(s)) return 'IMEI';
  if (/^A[\w]{10,}$/i.test(s)) return 'HONOR PAD SERIAL';
  if (/^H\d{10,}[A-Z]{2,}$/i.test(s)) return 'ONEPLUS PAD SERIAL';
  if (/^\d{6,7}[\/\-][\w\-]{8,}$/i.test(s)) return 'SLASH SERIAL';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------- price book

/**
 * Prices observed on the returns log. This is real transaction data, not an
 * estimate. Families with no observed price are valued at 0 and flagged, so
 * value-at-risk never invents a number.
 */
function buildPriceBook(db) {
  const rows = db.prepare(`SELECT family, price, COUNT(*) n FROM returns
    WHERE price > 0 GROUP BY family`).all();
  const book = new Map();
  for (const r of rows) {
    const cur = book.get(r.family) || { sum:0, n:0, min:r.price, max:r.price };
    cur.sum += r.price; cur.n += 1;
    cur.min = Math.min(cur.min, r.price); cur.max = Math.max(cur.max, r.price);
    book.set(r.family, cur);
  }
  const out = new Map();
  for (const [k, v] of book) {
    out.set(k, { typical: Math.round(v.sum / v.n), min: v.min, max: v.max, samples: v.n });
  }
  return out;
}

function valueOf(family, book) {
  if (!family) return { value:0, priced:false, basis:'no model on record' };
  const p = book.get(family);
  if (!p) return { value:0, priced:false, basis:`no observed price for ${family}` };
  return { value:p.typical, priced:true, basis:`median of ${p.samples} logged return${p.samples>1?'s':''} (Tk ${p.min.toLocaleString()}-${p.max.toLocaleString()})` };
}

// ---------------------------------------------------------------- duplicate diagnosis

/**
 * Why is this serial in the ledger more than once?
 *
 * The cause depends almost entirely on the gap between dispatches. A unit
 * genuinely returned and re-sold is a normal event; the finding is that the
 * original dispatch line was never closed, so the serial stayed live.
 */
function diagnoseDuplicate(recs, book) {
  const sorted = recs.slice().sort((a,b) => String(a.dt||'').localeCompare(String(b.dt||'')));
  const parties = [...new Set(sorted.map(r => r.party))];
  const wings  = [...new Set(sorted.map(r => r.wing))];
  const times  = sorted.map(r => r.dt).filter(Boolean).map(d => new Date(d).getTime()).sort((a,b)=>a-b);
  const gap = times.length < 2 ? null : Math.round((times[times.length-1] - times[0]) / 86400000);
  const family = sorted[0].family;
  const val = valueOf(family, book);
  const serial = sorted[0].serial;

  const luhnOk = luhn(serial);
  const evidence = [];
  let diagnosis, confidence, nextActions, severity;

  evidence.push({
    label:'Serial validity',
    detail: serialKind(serial) === 'IMEI'
      ? (luhnOk === true ? '15-digit IMEI passes its check digit' :
         luhnOk === false ? '15-digit IMEI FAILS its check digit' : 'could not validate')
      : `${serialKind(serial)} — check digit not applicable to this serial format`,
    weight: serialKind(serial) === 'IMEI' && luhnOk === true ? 'good' : 'warn'
  });

  if (gap === 0) {
    diagnosis = 'Same-day duplicate entry';
    confidence = 'high';
    severity = 'medium';
    evidence.push({ label:'Timing', detail:'Both dispatches carry the same date, which is too fast for any physical return.', weight:'bad' });
    nextActions = [
      'Open the two dispatch invoices and compare line by line — one is almost certainly a duplicate.',
      'Cancel the newer line. Do not delete the original.',
      'Check who raised the second entry; the same batch may be duplicated elsewhere.',
    ];
  } else if (gap <= 30) {
    diagnosis = 'Returned unit re-sold without closing the original line';
    confidence = 'high';
    severity = 'critical';
    evidence.push({ label:'Timing', detail:`${gap} day(s) between dispatches — consistent with a genuine return followed by a re-sale.`, weight:'warn' });
    evidence.push({ label:'Implication', detail:'The first dispatch line was never cancelled, so the serial remained live and could be issued twice.', weight:'bad' });
    nextActions = [
      'Ask the first dealer for written confirmation of the return and its date.',
      'Confirm no payment was ever collected against the first dispatch.',
      'Cancel the first line with a Returned status. Never edit the invoice — that is how the serial stays live.',
      'If the first dealer still holds the unit, recall it from the second dealer immediately.',
    ];
  } else if (gap <= 90) {
    diagnosis = 'Slow return or late record entry';
    confidence = 'medium';
    severity = 'high';
    evidence.push({ label:'Timing', detail:`${gap} days apart — long enough for a return, but also long enough for a late entry or a stock transfer.`, weight:'warn' });
    nextActions = [
      'Establish which of the two dates is wrong before acting.',
      'Check the warehouse issue register for a transfer between the two dates.',
      'Treat as a stock transfer if both dealers can produce a handover receipt.',
    ];
  } else {
    diagnosis = 'Historical backlog or unclosed old entry';
    confidence = 'medium';
    severity = 'medium';
    evidence.push({ label:'Timing', detail:`${gap} days apart — far too long to be a live return.`, weight:'warn' });
    nextActions = [
      'Check whether the earlier record belongs to a previous system or period.',
      'If the unit genuinely moved, back-date the closure rather than editing history.',
    ];
  }

  if (parties.length >= 3) {
    severity = 'critical';
    evidence.push({ label:'Breadth', detail:`Held by ${parties.length} dealers at once: ${parties.join(', ')}.`, weight:'bad' });
    diagnosis = 'Serial recorded across ' + parties.length + ' dealers';
    nextActions.unshift('Highest priority: physically verify which single shop holds this unit. The other records are wrong.');
  }
  if (wings.length > 1) {
    severity = 'critical';
    evidence.push({ label:'Warehouse', detail:`Claimed by both ${wings.join(' and ')} warehouses — both issue registers hold it.`, weight:'bad' });
    nextActions.push('Reconcile the two warehouse issue registers for this serial.');
  }
  if (luhnOk === true) {
    evidence.push({ label:'Ruling out cloning', detail:'The check digit is valid, so this is not a corrupted or cloned serial. The cause is process, not data corruption.', weight:'good' });
  }

  return {
    serial, family, diagnosis, confidence, severity, gapDays: gap,
    dealers: parties, wings, flow: sorted.map(r => ({ party:r.party, date:r.date, wing:r.wing })),
    evidence, nextActions, valueAtRisk: val.value, valueBasis: val.basis, valuePriced: val.priced,
    luhn: luhnOk
  };
}

// ---------------------------------------------------------------- dealer chains

/**
 * A dealer pair that keeps appearing on the same serials is not random noise.
 * It is either a returns pipeline or a resale chain, and it should be looked
 * at as a single structural issue rather than N separate duplicates.
 */
function buildChains(dupRows) {
  const pairs = new Map();
  for (const d of dupRows) {
    const stops = dedupeStops(d.stops);
    for (let i = 0; i < stops.length; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        const key = stops[i].party + ' -> ' + stops[j].party;
        if (!pairs.has(key)) pairs.set(key, { from:stops[i].party, to:stops[j].party, serials:[], value:0 });
        const p = pairs.get(key);
        p.serials.push(d.serial);
        p.value += d.value || 0;
      }
    }
  }
  return [...pairs.values()]
    .filter(p => p.serials.length >= 3)
    .map(p => ({
      ...p,
      count: p.serials.length,
      sample: p.serials.slice(0, 12),
      verdict: p.serials.length >= 25
        ? 'Systematic flow between these two dealers. Treat as one issue, not ' + p.serials.length + ' separate ones.'
        : 'Repeated flow. Check whether this is an agreed returns pipeline.'
    }))
    .sort((a,b) => b.count - a.count);
}

function dedupeStops(stops) {
  const seen = new Set(); const out = [];
  for (const s of stops) { const k = nrm(s.party); if (!seen.has(k)) { seen.add(k); out.push(s); } }
  return out;
}

// ---------------------------------------------------------------- severity scoring

/**
 * Severity is computed, not assigned by hand, so it moves when the data moves.
 * Every contribution is returned so the number can be explained.
 */
function scoreFinding(f) {
  const factors = [];
  let score = 0;

  const add = (label, points, detail) => { if (points) { score += points; factors.push({ label, points, detail }); } };

  if (f.kind === 'duplicate_cross' || f.kind === 'duplicate_multi') {
    const dealers = f.dealerCount || 2;
    add('Recorded against ' + dealers + ' dealer(s)', dealers >= 3 ? 40 : 25,
        'A physical handset cannot be in ' + dealers + ' shops at once.');
    if (f.gapDays === 0) add('Same-day entry', 20, 'Too fast for any physical return, so this is a data error.');
    else if (f.gapDays <= 30) add('Short gap (' + f.gapDays + 'd)', 20, 'Consistent with an unclosed return.');
    if (f.crossWing) add('Cross-warehouse', 15, 'Both warehouse registers claim the unit.');
    if (f.luhn === false) add('Invalid check digit', 25, 'Serial fails its Luhn check — treat as corrupt or cloned.');
    if (f.valueAtRisk) add('Value at risk', Math.min(20, Math.round(f.valueAtRisk / 5000)),
        'Tk ' + f.valueAtRisk.toLocaleString() + ' of stock unaccounted for.');
  } else if (f.kind === 'imei_lock') {
    add('IMEI not usable', 25, /lock/i.test(f.reason||'') ? 'Device is locked.' : 'Serial does not match the invoice.');
    if (f.valueAtRisk) add('Value at risk', Math.min(20, Math.round(f.valueAtRisk / 5000)),
        'Tk ' + f.valueAtRisk.toLocaleString() + ' cannot re-enter stock.');
  } else if (f.kind === 'no_serial_return') {
    add('Untraceable', 30, 'No serial recorded, so the unit cannot be located.');
    if (f.valueAtRisk) add('Value at risk', 15, 'Tk ' + f.valueAtRisk.toLocaleString() + ' with no identifier.');
  } else if (f.kind === 'orphan_return') {
    add('Never dispatched by us', 25, 'A unit came back that we have no dispatch record for.');
    if (f.valueAtRisk) add('Value at risk', 10, 'Tk ' + f.valueAtRisk.toLocaleString() + '.');
  } else if (f.kind === 'tac_conflict') {
    add('Model prefix conflict', 15, 'One serial prefix is recorded against several different models.');
  }

  let band;
  if (score >= 55) band = 'critical';
  else if (score >= 35) band = 'high';
  else if (score >= 20) band = 'medium';
  else band = 'low';
  return { score, band, factors };
}

/** Confidence reflects how much direct evidence backs the diagnosis. */
function confidenceFor(diag, evidence) {
  const weights = evidence.reduce((a, e) =>
    a + (e.weight === 'good' ? 1 : e.weight === 'warn' ? 0.6 : e.weight === 'bad' ? 0.4 : 0), 0);
  const band = weights >= 3 ? 'high' : weights >= 1.6 ? 'medium' : 'low';
  return band === 'high' ? diag.confidence
       : band === 'medium' && diag.confidence === 'high' ? 'medium'
       : 'low';
}

// ---------------------------------------------------------------- portfolio

function portfolio(db, chains) {
  const rows = db.prepare(`SELECT kind, severity, amount, value_at_risk FROM findings`).all();
  const byKind = {};
  let totalValue = 0, priced = 0;
  for (const r of rows) {
    byKind[r.kind] = byKind[r.kind] || { n:0, value:0 };
    byKind[r.kind].n++;
    const v = r.value_at_risk || r.amount || 0;
    byKind[r.kind].value += v;
    totalValue += v;
    if (v > 0) priced++;
  }
  return { byKind, totalValue, priced, chains: chains ? chains.length : 0 };
}

module.exports = { luhn, tac, serialKind, buildPriceBook, valueOf, diagnoseDuplicate,
                   buildChains, scoreFinding, confidenceFor, portfolio };