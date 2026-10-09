/* NSpector client — talks to the same API from desktop, phone, or browser. */
(function () {
  'use strict';
  const API = location.origin;
  let ws = null, retry = 0;
  let queueLimit = 60, dupOffset = 0, queueOffset = 0;

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const money = n => 'Tk ' + Math.round(n || 0).toLocaleString('en-IN');
  const short = n => (n || 0).toLocaleString();

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  }

  // ---------------- live connection ----------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; setSync('live', 'live sync'); };
    ws.onclose = () => { setSync('off', 'reconnecting…');
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * Math.pow(2, retry)); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch (err) { return; }
      if (d.type === 'synced') {
        toast('Synced · ' + short(d.stats.dispatches) + ' records');
        refreshAll();
      } else if (d.type === 'finding_updated') {
        if (currentTab() === 'queue') loadQueue(true);
        if (currentTab() === 'ownership') loadOwnership();
      }
    };
  }
  function setSync(cls, txt) {
    const el = $('#syncstate'); el.textContent = txt; el.className = cls;
  }

  // ---------------- tabs ----------------
  function currentTab() { return ($('#tabs button.active') || {}).dataset?.tab; }
  $$('#tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#tabs button').forEach(x => x.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    b.classList.add('active');
    $('#' + b.dataset.tab).classList.add('active');
    ({ queue: loadQueue, overview: loadOverview, duplicates: loadDuplicates,
       dealers: loadDealers, risk: loadRisk, ownership: loadOwnership }[b.dataset.tab])();
  }));

  // ---------------- work queue ----------------
  const KIND_LABEL = {
    duplicate_cross:'two dealers', duplicate_multi:'3+ dealers',
    imei_lock:'IMEI problem', no_serial_return:'untraceable return'
  };
  const STATUS_OPTS = ['open','investigating','resolved','dismissed'];

  async function loadQueue(reset) {
    if (reset) queueOffset = 0;
    const st = $('#fq-status').value, kd = $('#fq-kind').value, ow = $('#fq-owner').value.trim();
    const p = new URLSearchParams({ limit: queueLimit, offset: queueOffset });
    if (st) p.set('status', st); if (kd) p.set('kind', kd); if (ow) p.set('owner', ow);
    const d = await api('/api/findings?' + p);
    const c = d.counts || {};
    $('#queue-stats').innerHTML = `
      <span class="pill crit">Open <b>${short(c.open||0)}</b></span>
      <span class="pill">Investigating <b>${short(c.investigating||0)}</b></span>
      <span class="pill ok">Resolved <b>${short(c.resolved||0)}</b></span>
      <span class="pill">Dismissed <b>${short(c.dismissed||0)}</b></span>
      <span class="pill">Total <b>${short(c.total||0)}</b></span>`;

    const html = (d.rows || []).map(f => card(f)).join('');
    if (reset) $('#queue-list').innerHTML = html; else $('#queue-list').insertAdjacentHTML('beforeend', html);
    $('#q-more').style.display = (d.rows || []).length < queueLimit ? 'none' : 'block';
  }

  function card(f) {
    const sel = STATUS_OPTS.map(s =>
      `<option value="${s}"${f.status===s?' selected':''}>${s}</option>`).join('');
    const own = f.owner ? esc(f.owner) : '<span style="color:var(--dim)">unassigned</span>';
    return `<div class="card sev-${esc(f.sev||f.severity)}" data-id="${f.id}">
      <div class="cardrow">
        <div>
          <h4>${esc(f.title)}</h4>
          <div class="detail">${esc(f.detail||'')}</div>
          <div class="meta">
            <span class="tag ${f.severity==='critical'?'crit':f.severity==='high'?'high':''}">${esc(f.severity)}</span>
            <span class="tag">${esc(KIND_LABEL[f.kind]||f.kind)}</span>
            ${f.serial?`<span class="tag acc mono">${esc(f.serial)}</span>`:''}
            ${f.amount?`<span class="tag amount">${money(f.amount)}</span>`:''}
            <span class="tag">${own}</span>
          </div>
        </div>
        <select class="sel" data-role="status" data-id="${f.id}">${sel}</select>
      </div>
    </div>`;
  }

  document.addEventListener('change', async e => {
    const el = e.target.closest('[data-role="status"]');
    if (!el) return;
    try {
      await api('/api/findings/' + el.dataset.id, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ status: el.value, actor:'client' })
      });
      toast('Marked ' + el.value);
      loadQueue(true); loadOwnership();
    } catch (err) { toast('Update failed'); }
  });

  document.addEventListener('click', async e => {
    const c = e.target.closest('.card[data-id]');
    if (!c || e.target.tagName === 'SELECT') return;
    openFinding(+c.dataset.id);
  });

  async function openFinding(id) {
    const d = await api('/api/findings?limit=1');
    const f = (await api('/api/findings?limit=500')).rows.find(x => x.id === id);
    if (!f) return;
    let imeiHtml = '';
    if (f.serial) {
      const im = await api('/api/imei/' + encodeURIComponent(f.serial));
      imeiHtml = im.found ? `
        <h4 style="margin:16px 0 8px;font-size:13px">Dispatch trail — ${im.dispatches.length} record(s)</h4>
        <div class="timeline">${im.dispatches.map(r => `
          <div class="tl"><span class="when">${esc(r.date||'-')}</span>
          <span><b>${esc(r.party)}</b> · ${esc(r.wing||'-')} · ${esc(r.sku)}<br>
          <span class="mono" style="color:var(--dim)">${esc(r.serial)}</span></span></div>`).join('')}
        </div>` : `<p class="hint">No dispatch record found for this serial.</p>`;
      if (im.returns.length) imeiHtml += `
        <h4 style="margin:16px 0 8px;font-size:13px">Returns</h4>
        <div class="timeline">${im.returns.map(r => `
          <div class="tl"><span class="when">${esc(r.rdate)}</span>
          <span><b>${esc(r.reason)}</b> — ${esc(r.merchant)} · ${money(r.price)}</span></div>`).join('')}</div>`;
    }
    $('#sh-title').textContent = f.title;
    $('#sh-body').innerHTML = `
      <dl class="kv">
        <dt>Type</dt><dd>${esc(KIND_LABEL[f.kind]||f.kind)}</dd>
        <dt>Severity</dt><dd>${esc(f.severity)}</dd>
        <dt>Serial</dt><dd class="mono">${f.serial?esc(f.serial):'—'}</dd>
        <dt>Model</dt><dd>${esc(f.family||'—')}</dd>
        <dt>Dealer</dt><dd>${esc(f.dealer||'—')}</dd>
        <dt>Value</dt><dd>${f.amount?money(f.amount):'—'}</dd>
        <dt>Status</dt><dd>${esc(f.status)}</dd>
        <dt>Owner</dt><dd>${esc(f.owner||'unassigned')}</dd>
      </dl>
      ${imeiHtml}
      <h4 style="margin:16px 0 8px;font-size:13px">Owner</h4>
      <input id="f-owner" class="sel" style="width:100%" placeholder="Who is responsible for closing this?"
             value="${esc(f.owner||'')}">
      <h4 style="margin:16px 0 8px;font-size:13px">Resolution note</h4>
      <textarea id="f-note" class="note-in" placeholder="What was found, what was done">${esc(f.resolution||'')}</textarea>
      <div class="sheet-actions">
        ${STATUS_OPTS.map(s=>`<button class="${s===f.status?'primary':''}" data-set="${s}">${s}</button>`).join('')}
      </div>`;
    $('#sheet').classList.add('open');
    $('#sh-body').querySelectorAll('[data-set]').forEach(b =>
      b.addEventListener('click', () => saveFinding(id, { status:b.dataset.set })));
  }

  async function saveFinding(id, patch) {
    patch.owner = $('#f-owner') ? $('#f-owner').value.trim() : undefined;
    patch.resolution = $('#f-note') ? $('#f-note').value.trim() : undefined;
    try {
      await api('/api/findings/' + id, {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(patch)
      });
      $('#sheet').classList.remove('open');
      toast('Saved'); loadQueue(true); loadOwnership();
    } catch (e) { toast('Save failed'); }
  }
  $('#sh-close').addEventListener('click', () => $('#sheet').classList.remove('open'));
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#sheet').classList.remove('open'); });

  // ---------------- overview ----------------
  async function loadOverview() {
    const d = await api('/api/overview');
    const s = d.stats;
    $('#ov-cards').innerHTML = [
      ['Dispatch records', short(s.dispatches), 'sheets 3 + 4', ''],
      ['Unique serials', short(s.uniqueSerials), 'physical units', 'ok'],
      ['Duplicates (2+ dealers)', short(s.crossDup), 'device in two shops', 'crit'],
      ['Open findings', short(s.openFindings), 'need an owner', 'warn'],
      ['Dealer names', short(s.dealers), 'should be far fewer', 'warn'],
      ['Product families', short(s.families), 'normalised SKUs', ''],
      ['Deposits', short(s.deposits), money(s.depositValue), ''],
      ['Returns', short(s.returns), money(s.returnValue), '']
    ].map(([k,v,sub,cls]) => `<div class="stat ${cls}"><div class="k">${k}</div>
      <div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

    const dm = Object.fromEntries(d.dispatch.map(x => [x.ym, x.units]));
    const maxC = Math.max(1, ...d.cod.map(x => x.amt || 0));
    $('#ov-cod').innerHTML = d.cod.map(c => {
      const p = c.amt ? Math.round(c.cod_amt / c.amt * 1000)/10 : 0;
      const cls = p > 40 ? 'crit' : p > 25 ? 'high' : '';
      return `<div class="bar">
        <span class="lab">${esc(c.ym)}${dm[c.ym]?` · ${short(dm[c.ym])} units`:''}</span>
        <span class="track"><span class="fill ${cls}" style="width:${(c.amt/maxC*100).toFixed(1)}%"></span></span>
        <span class="num">COD ${p}%</span></div>`;
    }).join('');

    const mf = d.dispatchByFamily.slice(0, 14);
    const mx = Math.max(1, ...mf.map(x => x.units));
    $('#ov-fam').innerHTML = mf.map(x => `<div class="bar">
      <span class="lab">${esc(x.family)}</span>
      <span class="track"><span class="fill" style="width:${(x.units/mx*100).toFixed(1)}%"></span></span>
      <span class="num">${short(x.units)}</span></div>`).join('');

    const mx2 = Math.max(1, ...d.dupTop.map(x => x.cross_dup));
    $('#ov-dup').innerHTML = d.dupTop.map(x => `<div class="bar">
      <span class="lab">${esc(x.name)}</span>
      <span class="track"><span class="fill crit" style="width:${(x.cross_dup/mx2*100).toFixed(1)}%"></span></span>
      <span class="num">${short(x.cross_dup)} · ${short(x.units)} units</span></div>`).join('');
  }

  // ---------------- duplicates ----------------
  async function loadDuplicates(reset) {
    if (reset) dupOffset = 0;
    const kind = $('#dup-kind').value, dealer = $('#dup-dealer').value.trim();
    const p = new URLSearchParams({ kind, limit: 60, offset: dupOffset });
    if (dealer) p.set('dealer', dealer);
    const d = await api('/api/duplicates?' + p);
    const rows = d.rows || [];
    const html = rows.map(r => `<div class="card sev-${r.dealers>=3?'critical':'high'}">
      <div class="cardrow"><div>
        <h4 class="mono">${esc(r.serial)}</h4>
        <div class="detail">${esc(r.sku)} — ${esc(String(r.parties).split(',').join('  ·  '))}</div>
        <div class="meta">
          <span class="tag ${r.dealers>=3?'crit':'high'}">${r.dealers} dealer(s)</span>
          <span class="tag">${r.n} record(s)</span>
          <span class="tag">${esc(String(r.wings).replace(/,/g,' / '))}</span>
          ${r.first_dt?`<span class="tag">${esc(String(r.first_dt).slice(0,10))} → ${esc(String(r.last_dt).slice(0,10))}</span>`:''}
        </div></div></div></div>`).join('');
    if (reset) $('#dup-list').innerHTML = html; else $('#dup-list').insertAdjacentHTML('beforeend', html);
    $('#d-more').style.display = rows.length < 60 ? 'none' : 'block';
  }

  // ---------------- dealers ----------------
  async function loadDealers() {
    const s = $('#dl-search').value.trim();
    const d = await api('/api/dealers?limit=200' + (s ? '&q=' + encodeURIComponent(s) : ''));
    $('#dealer-list').innerHTML = (d.rows || []).map(x => {
      const al = JSON.parse(x.aliases || '[]');
      return `<div class="card sev-${x.cross_dup>0?'high':'low'}">
        <div class="cardrow"><div>
          <h4>${esc(x.name)}</h4>
          <div class="detail">${al.length>1?esc(al.join(' · ')):'—'}</div>
          <div class="meta">
            <span class="tag">${short(x.units)} units</span>
            <span class="tag">${short(x.serials)} serials</span>
            ${x.cross_dup?`<span class="tag crit">${short(x.cross_dup)} dup</span>`:''}
            ${x.first?`<span class="tag">${esc(String(x.first).slice(0,10))} → ${esc(String(x.last).slice(0,10))}</span>`:''}
          </div></div></div></div>`;
    }).join('');
  }

  // ---------------- risk ----------------
  async function loadRisk() {
    const d = await api('/api/risk');
    const rows = d.rows.slice(0, 30);
    const mx = Math.max(1, ...rows.map(r => r.risk));
    $('#risk-list').innerHTML = `<div class="bar" style="color:var(--dim);font-size:11px">
        <span class="lab">Model family</span><span>Risk</span><span class="num">Units · dup · IMEI</span></div>` +
      rows.map(r => `<div class="bar">
        <span class="lab">${esc(r.family)}</span>
        <span class="track"><span class="fill ${r.risk>=25?'crit':r.risk>=8?'high':''}" style="width:${(r.risk/mx*100).toFixed(1)}%"></span></span>
        <span class="num">${short(r.units)} · ${r.dupRate}% · ${r.imeiLock}</span></div>`).join('');
  }

  // ---------------- ownership ----------------
  async function loadOwnership() {
    const d = await api('/api/ownership');
    $('#own-cards').innerHTML = [
      ['Unassigned', short(d.unassigned.c), d.unassigned.amt?money(d.unassigned.amt):'no value', 'crit'],
      ['People involved', String(d.people.length), '', ''],
      ['Total findings', short(d.byKind.reduce((a,b)=>a+b.n,0)), '', '']
    ].map(([k,v,sub,cls]) => `<div class="stat ${cls}"><div class="k">${k}</div>
      <div class="v">${v}</div><div class="s">${sub}</div></div>`).join('') +
      (d.people.filter(p=>p.owner).map(p => `<div class="stat">
        <div class="k">${esc(p.owner||'unassigned')}</div>
        <div class="v">${short(p.open)}</div>
        <div class="s">open of ${short(p.total)} · ${short(p.resolved)} resolved</div></div>`).join(''));

    const mx = Math.max(1, ...d.byKind.map(x => x.n));
    $('#own-kinds').innerHTML = d.byKind.map(x => `<div class="bar">
      <span class="lab">${esc(x.kind)} · ${esc(x.severity)}</span>
      <span class="track"><span class="fill ${x.severity==='critical'?'crit':'high'}" style="width:${(x.n/mx*100).toFixed(1)}%"></span></span>
      <span class="num">${short(x.n)}${x.amt?` · ${money(x.amt)}`:''}</span></div>`).join('');
  }

  // ---------------- controls ----------------
  ['#fq-status','#fq-kind'].forEach(s => $(s).addEventListener('change', () => loadQueue(true)));
  $('#fq-owner').addEventListener('input', () => { clearTimeout(window._o);
    window._o = setTimeout(() => loadQueue(true), 320); });
  $('#fq-clear').addEventListener('click', () => {
    $('#fq-status').value=''; $('#fq-kind').value=''; $('#fq-owner').value=''; loadQueue(true); });
  $('#q-more').addEventListener('click', () => { queueOffset += queueLimit; loadQueue(); });
  $('#dup-kind').addEventListener('change', () => loadDuplicates(true));
  $('#dup-dealer').addEventListener('input', () => { clearTimeout(window._d);
    window._d = setTimeout(() => loadDuplicates(true), 320); });
  $('#d-more').addEventListener('click', () => { dupOffset += 60; loadDuplicates(); });
  $('#dl-search').addEventListener('input', () => { clearTimeout(window._l);
    window._l = setTimeout(loadDealers, 320); });

  $('#syncbtn').addEventListener('click', async () => {
    $('#syncbtn').textContent = 'Syncing…';
    try { await api('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      toast('Sync complete'); refreshAll(); }
    catch (e) { toast('Sync failed'); }
    $('#syncbtn').textContent = 'Sync';
  });

  async function refreshAll() {
    const t = currentTab();
    if (t === 'queue') loadQueue(true);
    else if (t === 'overview') loadOverview();
    else if (t === 'duplicates') loadDuplicates(true);
    else if (t === 'ownership') loadOwnership();
    else if (t === 'risk') loadRisk();
  }

  connect(); loadQueue(true);
})();