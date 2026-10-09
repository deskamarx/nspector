/* NSpector client — one UI, served to desktop and phone from the same server. */
(function () {
  'use strict';
  const API = location.origin;
  let ws = null, retry = 0;
  let queueLimit = 40, queueOffset = 0, lastFilter = '';

  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const money = n => 'Tk ' + Math.round(n || 0).toLocaleString('en-IN');
  const short = n => (n || 0).toLocaleString();
  const tb = n => { // compact taka
    n = n || 0;
    if (n >= 10000000) return 'Tk ' + (n/10000000).toFixed(2) + ' Cr';
    if (n >= 100000)   return 'Tk ' + (n/100000).toFixed(2) + ' L';
    if (n >= 1000)     return 'Tk ' + (n/1000).toFixed(0) + 'k';
    return 'Tk ' + n.toLocaleString();
  };
  const KIND = {
    duplicate_cross:'two dealers', duplicate_multi:'3+ dealers', orphan_return:'never dispatched',
    imei_lock:'IMEI problem', no_serial_return:'untraceable', luhn_invalid:'invalid serial',
    tac_conflict:'prefix conflict'
  };
  const STATUS = ['open','investigating','resolved','dismissed'];

  function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');
    clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2600);}
  async function api(p,o){const r=await fetch(API+p,o);if(!r.ok)throw new Error(r.statusText);return r.json();}
  const val = f => f.value_at_risk > 0
    ? `<span class="tag val">${money(f.value_at_risk)}</span>`
    : (f.kind === 'duplicate_cross' || f.kind === 'duplicate_multi'
        ? `<span class="tag" title="${esc(f.value_basis||'')}">unpriced</span>` : '');

  // ------------------------------------------------ live connection
  function connect(){
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch(e){ return retryConnect(); }
    ws.onopen = () => { retry = 0; syncState('live','live sync'); };
    ws.onclose = () => { syncState('off','reconnecting…'); retryConnect(); };
    ws.onerror = () => { try { ws.close(); } catch(e){} };
    ws.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch(x){ return; }
      if (d.type === 'synced') { toast('Synced · ' + short(d.stats.dispatches) + ' records'); refreshAll(); }
      else if (d.type === 'finding_updated') {
        const t = currentTab();
        if (t === 'queue') loadQueue(true);
        if (t === 'ownership') loadOwnership();
        if (t === 'exposure') loadExposure();
      }
    };
  }
  function retryConnect(){ retry = Math.min(retry+1,6); setTimeout(connect, 500*Math.pow(2,retry)); }
  function syncState(cls,txt){const el=$('#syncstate');el.textContent=txt;el.className=cls;}
  function currentTab(){ const b=$('#tabs button.active'); return b ? b.dataset.tab : 'queue'; }

  // ------------------------------------------------ work queue
  function fCard(f){
    const opts = STATUS.map(s=>`<option value="${s}"${f.status===s?' selected':''}>${s}</option>`).join('');
    const conf = f.confidence
      ? `<span class="tag ${f.confidence==='high'?'ok':f.confidence==='medium'?'med':''}">${f.confidence} confidence</span>` : '';
    return `<div class="card sev-${esc(f.severity)}" data-id="${f.id}">
      <div class="crow"><div>
        <h4 class="ctitle">${esc(f.title)}</h4>
        ${f.diagnosis ? `<p class="cdiag">${esc(f.diagnosis)}</p>` : ''}
        <div class="cdetail">${esc(f.detail||'')}</div>
        <div class="cmeta">
          <span class="tag ${f.severity==='critical'?'crit':f.severity==='high'?'high':f.severity==='medium'?'med':'low'}">${esc(f.severity)}</span>
          <span class="tag">${esc(KIND[f.kind]||f.kind)}</span>
          ${conf}
          ${val(f)}
          ${f.serial?`<span class="tag mono">${esc(f.serial)}</span>`:''}
          ${f.gap_days!==null&&f.gap_days!==undefined?`<span class="tag">${f.gap_days}d apart</span>`:''}
          ${f.owner?`<span class="tag acc">${esc(f.owner)}</span>`:'<span class="tag">unassigned</span>'}
        </div>
      </div>
      <div style="text-align:right;flex:none">
        <div class="score"><div class="n">${f.score}</div><div class="l">score</div></div>
        <select class="sel" data-role="status" data-id="${f.id}" style="margin-top:8px">${opts}</select>
      </div></div>
    </div>`;
  }

  async function loadQueue(reset){
    if (reset) queueOffset = 0;
    const p = new URLSearchParams({ limit: queueLimit, offset: queueOffset });
    const st=$('#fq-status').value, sv=$('#fq-sev').value, kd=$('#fq-kind').value;
    const ow=$('#fq-owner').value.trim(), mv=$('#fq-min').value;
    if(st)p.set('status',st); if(sv)p.set('severity',sv); if(kd)p.set('kind',kd);
    if(ow)p.set('owner',ow); if(mv)p.set('minValue',mv);
    let d;
    try { d = await api('/api/findings?' + p); }
    catch(e){ toast('Could not load the queue'); return; }
    const c = d.counts || {};
    $('#queue-stats').innerHTML = `
      <span class="pill crit">Open <b>${short(c.open||0)}</b></span>
      <span class="pill">Investigating <b>${short(c.investigating||0)}</b></span>
      <span class="pill ok">Resolved <b>${short(c.resolved||0)}</b></span>
      <span class="pill">Dismissed <b>${short(c.dismissed||0)}</b></span>
      <span class="pill">Total <b>${short(c.total||0)}</b></span>
      <span class="pill crit">Open value <b>${tb(c.open_value||0)}</b></span>`;
    const rows = d.rows || [];
    const html = rows.map(fCard).join('');
    if (reset) $('#queue-list').innerHTML = html;
    else $('#queue-list').insertAdjacentHTML('beforeend', html);
    $('#q-more').style.display = rows.length < queueLimit ? 'none' : 'block';
  }

  document.addEventListener('change', async e => {
    const el = e.target.closest('[data-role="status"]');
    if (!el) return;
    try {
      await api('/api/findings/'+el.dataset.id, { method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ status: el.value, actor:'client' }) });
      toast('Marked ' + el.value);
      loadQueue(true); loadOwnership(); loadTopExposure();
    } catch(err){ toast('Update failed'); }
  });
  document.addEventListener('click', async e => {
    const c = e.target.closest('.card[data-id]');
    if (!c || e.target.tagName === 'SELECT') return;
    openFinding(+c.dataset.id);
  });

  async function openFinding(id){
    const d = await api('/api/findings?limit=1000');
    const f = d.rows.find(x => x.id === id);
    if (!f) { toast('Finding not found'); return; }

    let trail = '';
    if (f.serial) {
      const im = await api('/api/inspect/' + encodeURIComponent(f.serial));
      if (im.dispatches.length > 1) {
        trail = `<h4 style="margin:18px 0 8px;font-size:12px;letter-spacing:.5em;
          text-transform:uppercase;color:var(--dim2)">Chain of custody</h4>
          <div class="flow">${im.dispatches.map(x => `<div class="flowstep">
            <span class="when">${esc(x.date||'-')}</span>
            <span><span class="who">${esc(x.party)}</span>
            <span class="sub"> · ${esc(x.wing||'-')} · ${esc(x.family||x.sku||'')} · ${esc(x.source||'')}</span></span>
          </div>`).join('')}</div>`;
      }
      if (im.returns.length) trail += `<h4 style="margin:18px 0 8px;font-size:12px;letter-spacing:.5em;
        text-transform:uppercase;color:var(--dim2)">Returns</h4>
        <div class="flow">${im.returns.map(r => `<div class="flowstep">
          <span class="when">${esc(r.rdate)}</span>
          <span><span class="who">${esc(r.reason)}</span>
          <span class="sub"> — ${esc(r.merchant)} · ${money(r.price)}</span></span>
        </div>`).join('')}</div>`;
    }

    const ev = (f.evidence||[]).map(e => `<div class="evrow ${esc(e.weight)}">
      <span class="k">${esc(e.label)}</span><span class="d">${esc(e.detail)}</span></div>`).join('');
    const acts = f.next_actions || (f.next_action ? [f.next_action] : []);

    $('#sh-title').textContent = f.title;
    $('#sh-body').innerHTML = `
      <div class="callout ${f.severity==='critical'?'bad':f.severity==='high'?'warn':'dx'}">
        <b>Diagnosis${f.confidence?' · '+f.confidence+' confidence':''}</b>
        ${esc(f.diagnosis||'No diagnosis recorded for this finding.')}
      </div>

      <dl class="kv">
        <dt>Severity</dt><dd>${esc(f.severity)} <span style="color:var(--dim2)">(score ${f.score})</span></dd>
        <dt>Type</dt><dd>${esc(KIND[f.kind]||f.kind)}</dd>
        ${f.serial?`<dt>Serial</dt><dd class="mono">${esc(f.serial)}</dd>`:''}
        ${f.family?`<dt>Model</dt><dd>${esc(f.family)}</dd>`:''}
        ${f.dealer?`<dt>Dealer</dt><dd>${esc(f.dealer)}</dd>`:''}
        ${f.dealer_count?`<dt>Dealers</dt><dd>${f.dealer_count}</dd>`:''}
        ${f.gap_days!==null&&f.gap_days!==undefined?`<dt>Gap</dt><dd>${f.gap_days} days between dispatches</dd>`:''}
        ${f.cross_wing?`<dt>Warehouse</dt><dd style="color:var(--crit)">claimed by both wings</dd>`:''}
        ${f.luhn===1?`<dt>Check digit</dt><dd style="color:var(--ok)">valid — not a clone or corruption</dd>`
          : f.luhn===0?`<dt>Check digit</dt><dd style="color:var(--crit)">invalid</dd>`:''}
        <dt>Value at risk</dt><dd>${f.value_at_risk>0?money(f.value_at_risk)
          : '<span style="color:var(--dim2)">not priced</span>'}</dd>
        ${f.value_at_risk>0?`<dt>Basis</dt><dd style="color:var(--dim);font-size:12px">${esc(f.value_basis||'')}</dd>`:''}
        <dt>Status</dt><dd>${esc(f.status)}</dd>
        <dt>Owner</dt><dd>${f.owner?esc(f.owner):'<span style="color:var(--dim2)">unassigned</span>'}</dd>
      </dl>

      ${f.detail?`<div class="cdetail" style="margin-bottom:16px">${esc(f.detail)}</div>`:''}

      ${ev?`<h4 style="margin:0 0 8px;font-size:12px;letter-spacing:.5em;
        text-transform:uppercase;color:var(--dim2)">Evidence</h4><div class="ev">${ev}</div>`:''}

      ${trail}

      ${acts.length?`<h4 style="margin:18px 0 4px;font-size:12px;letter-spacing:.5em;
        text-transform:uppercase;color:var(--dim2)">Do this next</h4>
        <ol class="actionlist">${acts.map(a=>`<li>${esc(a)}</li>`).join('')}</ol>`:''}

      <h4 style="margin:18px 0 8px;font-size:12px;letter-spacing:.5em;
        text-transform:uppercase;color:var(--dim2)">Assign and record</h4>
      <input id="f-owner" class="sel" style="width:100%;padding:9px 11px;margin-bottom:8px"
        placeholder="Who is responsible for closing this?" value="${esc(f.owner||'')}">
      <textarea id="f-note" class="note-in"
        placeholder="What was found, what was done">${esc(f.resolution||'')}</textarea>
      <div class="sheet-actions">
        ${STATUS.map(s=>`<button class="${s===f.status?'primary':''}" data-set="${s}">${s}</button>`).join('')}
      </div>`;
    $('#sheet').classList.add('open');
    $('#sh-body').querySelectorAll('[data-set]').forEach(b =>
      b.addEventListener('click', () => saveFinding(id,{status:b.dataset.set})));
  }

  async function saveFinding(id, patch){
    patch.owner   = $('#f-owner') ? $('#f-owner').value.trim() : undefined;
    patch.resolution = $('#f-note') ? $('#f-note').value.trim() : undefined;
    try{
      await api('/api/findings/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(patch)});
      $('#sheet').classList.remove('open');
      toast('Saved'); loadQueue(true); loadOwnership(); loadTopExposure();
    }catch(e){ toast('Save failed'); }
  }
  $('#sh-close').addEventListener('click', ()=>$('#sheet').classList.remove('open'));
  $('#sheet').addEventListener('click', e=>{ if(e.target.id==='sheet') $('#sheet').classList.remove('open'); });

  // ------------------------------------------------ inspector
  async function inspect(serial){
    const out = $('#ins-out');
    out.innerHTML = '<div class="panel"><p class="hint">Inspecting…</p></div>';
    let d;
    try { d = await api('/api/inspect/' + encodeURIComponent(serial)); }
    catch(e){ out.innerHTML = '<div class="panel"><p class="hint">Could not reach the server.</p></div>'; return; }

    if (!d.dispatches.length && !d.returns.length) {
      out.innerHTML = `<div class="panel"><h3>Not found</h3>
        <p class="hint">${esc(serial)} does not appear in any dispatch record or return.
        Check for a typo, or note that the unit may predate this ledger.</p></div>`;
      return;
    }

    const f0 = d.dispatches[0];
    const chips = [
      `<span class="tag acc">${esc(d.serialKind)}</span>`,
      d.luhn === true  ? '<span class="tag ok">check digit valid</span>' :
      d.luhn === false ? '<span class="tag crit">check digit invalid</span>' :
      '<span class="tag">check digit not applicable</span>',
      d.tac ? `<span class="tag mono">TAC ${esc(d.tac)}</span>` : '',
      f0 ? `<span class="tag">${esc(f0.family||f0.sku)}</span>` : ''
    ].join('');

    let diagHtml = '';
    if (d.diagnosis) {
      const dx = d.diagnosis;
      diagHtml = `<div class="panel">
        <h3>Reasoning</h3>
        <div class="callout bad"><b>Diagnosis · ${esc(dx.confidence)} confidence</b>${esc(dx.diagnosis)}</div>
        <h4 style="margin:0 0 8px;font-size:12px;letter-spacing:.5em;text-transform:uppercase;
          color:var(--dim2)">Evidence</h4>
        <div class="ev">${dx.evidence.map(e=>`<div class="evrow ${esc(e.weight)}">
          <span class="k">${esc(e.label)}</span><span class="d">${esc(e.detail)}</span></div>`).join('')}</div>
        <h4 style="margin:18px 0 4px;font-size:12px;letter-spacing:.5em;text-transform:uppercase;
          color:var(--dim2)">Do this next</h4>
        <ol class="actionlist">${dx.nextActions.map(a=>`<li>${esc(a)}</li>`).join('')}</ol>
      </div>`;
    }

    const tacHtml = d.tacFamilies.length > 1 ? `<div class="panel">
      <h3>Prefix analysis</h3>
      <p class="hint">Prefix ${esc(d.tac)} appears against ${d.tacFamilies.length} models.
      A Type Allocation Code identifies one model, so this is a mapping problem or a
      mis-entry.</p>
      ${d.tacFamilies.map(f=>`<div class="bar"><span class="lab">${esc(f.family)}</span>
        <span class="track"><span class="fill" style="width:${(f.n/Math.max(...d.tacFamilies.map(x=>x.n))*100).toFixed(0)}%"></span></span>
        <span class="num">${short(f.n)}</span></div>`).join('')}
    </div>` : '';

    out.innerHTML = `
      <div class="panel">
        <h3 class="mono" style="font-size:16px">${esc(d.serial)}</h3>
        <div class="cmeta" style="margin-top:8px">${chips}</div>
        ${d.price?`<p class="hint" style="margin:12px 0 0">Observed price for this model:
          <b style="color:var(--fg)">${money(d.price.typical)}</b>
          (range ${money(d.price.min)}–${money(d.price.max)}, ${d.price.samples} logged returns)</p>`:''}
      </div>
      <div class="panel">
        <h3>Dispatch trail</h3>
        <div class="flow">${d.dispatches.map(x=>`<div class="flowstep">
          <span class="when">${esc(x.date||'-')}</span>
          <span><span class="who">${esc(x.party)}</span>
          <span class="sub"> · ${esc(x.wing||'-')} wing · ${esc(x.family||x.sku||'')} · ${esc(x.source||'')}</span></span>
        </div>`).join('')}</div>
        ${d.relatedCount?`<p class="hint" style="margin:14px 0 0">
          ${short(d.relatedCount)} other serials moved through the same dealer(s) as this one.</p>`:''}
      </div>
      ${diagHtml}
      ${d.returns.length?`<div class="panel"><h3>Returns</h3>
        <div class="flow">${d.returns.map(r=>`<div class="flowstep">
          <span class="when">${esc(r.rdate)}</span>
          <span><span class="who">${esc(r.reason)}</span>
          <span class="sub"> — ${esc(r.merchant)} · ${money(r.price)}</span></span>
        </div>`).join('')}</div></div>`:''}
      ${tacHtml}
      ${d.findings.length?`<div class="panel"><h3>Open findings on this serial</h3>
        ${d.findings.map(f=>`<div class="card sev-${esc(f.severity)} static" style="margin-bottom:8px">
          <h4 class="ctitle">${esc(f.title)}</h4>
          <p class="cdiag">${esc(f.diagnosis||'')}</p>
          <div class="cmeta"><span class="tag ${f.severity==='critical'?'crit':'high'}">${esc(f.severity)}</span>
          <span class="tag">${esc(f.status)}</span>${val(f)}</div></div>`).join('')}</div>`:''}`;
  }

  $('#ins-go').addEventListener('click', ()=>{ const s=$('#ins-q').value.trim(); if(s) inspect(s); });
  $('#ins-q').addEventListener('keydown', e=>{ if(e.key==='Enter'){ const s=$('#ins-q').value.trim(); if(s) inspect(s); }});
  $$('.chipbtn').forEach(b=>b.addEventListener('click',()=>{ $('#ins-q').value=b.dataset.s; inspect(b.dataset.s); }));

  // ------------------------------------------------ exposure
  async function loadTopExposure(){
    try{
      const s = await api('/api/stats');
      const p = await api('/api/portfolio');
      $('#top-exposure-val').textContent = tb(p.exposure.open_total||0);
      lastFilter = String(s.openFindings||0);
    }catch(e){ $('#top-exposure-val').textContent = '—'; }
  }

  async function loadExposure(){
    let d; try { d = await api('/api/portfolio'); } catch(e){ return; }
    const e = d.exposure, st = d.stats;
    $('#exp-cards').innerHTML = [
      ['Open exposure', tb(e.open_total), 'valued at observed prices', 'crit'],
      ['Critical', short((d.bySeverity.find(s=>s.severity==='critical')||{}).n||0),
        tb((d.bySeverity.find(s=>s.severity==='critical')||{}).value||0)+' at risk','crit'],
      ['Duplicate findings', short(st.crossDup), 'serials in 2+ dealers','warn'],
      ['Items with a price', short(e.priced_items), 'rest are real but unpriced',''],
      ['Findings', short(st.findings), short(st.openFindings)+' still open',''],
      ['Unique serials', short(st.uniqueSerials), 'physical units tracked','acc']
    ].map(([k,v,s,c])=>`<div class="stat ${c}"><div class="k">${k}</div>
      <div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

    const sevOrder=['critical','high','medium','low'];
    const mx=Math.max(1,...d.bySeverity.map(x=>x.value||0));
    $('#exp-sev').innerHTML = sevOrder.map(k=>{
      const r = d.bySeverity.find(x=>x.severity===k);
      return `<div class="bar"><span class="lab">${k}</span>
        <span class="track"><span class="fill ${k==='critical'?'crit':k==='high'?'high':k==='medium'?'med':'low'}"
        style="width:${((r&&r.value||0)/mx*100).toFixed(1)}%"></span></span>
        <span class="num">${short((r&&r.n)||0)} · ${tb((r&&r.value)||0)}</span></div>`;
    }).join('');

    const md=Math.max(1,...d.byDiagnosis.map(x=>x.n||0));
    $('#exp-diag').innerHTML = d.byDiagnosis.map(x=>`<div class="bar">
      <span class="lab" title="${esc(x.diagnosis)}">${esc(x.diagnosis.slice(0,58))}</span>
      <span class="track"><span class="fill" style="width:${((x.n/md)*100).toFixed(1)}%"></span></span>
      <span class="num">${short(x.n)}${x.value?' · '+tb(x.value):''}</span></div>`).join('');

    $('#exp-top').innerHTML = d.topValue.map(t=>`<div class="card sev-high static">
      <div class="crow"><div>
        <h4 class="ctitle mono">${esc(t.serial)}</h4>
        <p class="cdiag">${esc(t.diagnosis||'')}</p>
        <div class="cmeta"><span class="tag high">score ${t.score}</span>
          <span class="tag">${esc(t.family||'')}</span>
          ${t.dealer?`<span class="tag">${esc(t.dealer)}</span>`:''}
          <span class="tag val">${money(t.value)}</span></div>
      </div></div></div>`).join('');

    const mb=Math.max(1,...d.priceBook.map(x=>x.typical||0));
    $('#exp-book').innerHTML = d.priceBook.map(p=>`<div class="bar">
      <span class="lab">${esc(p.family)}</span>
      <span class="track"><span class="fill low" style="width:${((p.typical/mb)*100).toFixed(1)}%"></span></span>
      <span class="num">${money(p.typical)} · ${p.samples}×</span></div>`).join('');
  }

  // ------------------------------------------------ flows
  async function loadChains(){
    let d; try { d = await api('/api/chains'); } catch(e){ return; }
    const rows = d.rows || [];
    $('#chain-list').innerHTML = rows.length ? rows.map(c=>`<div class="chainbox">
      <div class="chainflow">${esc(c.from_party)}<span class="arrow">→</span>${esc(c.to_party)}</div>
      <div class="cmeta">
        <span class="tag crit">${short(c.count)} serials</span>
        ${c.value>0?`<span class="tag val">${tb(c.value)}</span>`:'<span class="tag">unpriced</span>'}
      </div>
      <p class="hint" style="margin:9px 0 6px">${esc(c.verdict)}</p>
      <div class="serials">${c.sample.map(s=>esc(s)).join('<br>')}</div>
    </div>`).join('') : '<p class="hint">No repeated flows detected.</p>';
  }

  // ------------------------------------------------ dealers
  async function loadDealers(){
    const s = $('#dl-search').value.trim();
    let d; try { d = await api('/api/dealers?limit=200' + (s?'&q='+encodeURIComponent(s):'')); }
    catch(e){ return; }
    $('#dealer-list').innerHTML = (d.rows||[]).map(x=>{
      const al = JSON.parse(x.aliases||'[]');
      const rate = x.serials ? (x.cross_dup/x.serials*100) : 0;
      return `<div class="card ${x.cross_dup?'sev-high':'sev-low'} static">
        <h4 class="ctitle">${esc(x.name)}</h4>
        <div class="cdetail">${al.length>1?esc(al.join(' · ')):'—'}</div>
        <div class="cmeta">
          <span class="tag">${short(x.units)} units</span>
          <span class="tag">${short(x.serials)} serials</span>
          ${x.cross_dup?`<span class="tag crit">${short(x.cross_dup)} in 2+ dealers</span>`:''}
          ${x.cross_dup?`<span class="tag high">${rate.toFixed(1)}% of their stock</span>`:''}
          ${x.first?`<span class="tag">${esc(String(x.first).slice(0,10))} → ${esc(String(x.last).slice(0,10))}</span>`:''}
        </div></div>`;
    }).join('');
  }

  // ------------------------------------------------ ownership
  async function loadOwnership(){
    let d; try { d = await api('/api/ownership'); } catch(e){ return; }
    $('#own-cards').innerHTML = [
      ['Unassigned', short(d.unassigned.c), tb(d.unassigned.amt)+' of open value','crit'],
      ['People involved', String(d.people.filter(p=>p.owner).length),'','acc'],
      ['Total findings', short(d.byKind.reduce((a,b)=>a+b.n,0)),'','ok']
    ].map(([k,v,s,c])=>`<div class="stat ${c}"><div class="k">${k}</div>
      <div class="v">${v}</div><div class="s">${s}</div></div>`).join('') +
      d.people.filter(p=>p.owner).map(p=>`<div class="stat">
        <div class="k">${esc(p.owner)}</div>
        <div class="v">${short(p.open)}</div>
        <div class="s">open of ${short(p.total)} · ${short(p.resolved)} resolved</div></div>`).join('');

    const mx=Math.max(1,...d.byKind.map(x=>x.n));
    $('#own-kinds').innerHTML = d.byKind.map(x=>`<div class="bar">
      <span class="lab">${esc(KIND[x.kind]||x.kind)}</span>
      <span class="track"><span class="fill ${x.severity==='critical'?'crit':x.severity==='high'?'high':x.severity==='medium'?'med':'low'}"
        style="width:${(x.n/mx*100).toFixed(1)}%"></span></span>
      <span class="num">${short(x.n)}${x.amt?' · '+tb(x.amt):''}</span></div>`).join('');
  }

  // ------------------------------------------------ wiring
  const LOADERS = { queue:loadQueue, inspect:()=>{}, exposure:loadExposure,
                    chains:loadChains, dealers:loadDealers, ownership:loadOwnership };
  $$('#tabs button').forEach(b => b.addEventListener('click', ()=>{
    $$('#tabs button').forEach(x=>x.classList.remove('active'));
    $$('.view').forEach(v=>v.classList.remove('active'));
    b.classList.add('active');
    $('#'+b.dataset.tab).classList.add('active');
    LOADERS[b.dataset.tab]();
  }));

  ['#fq-status','#fq-sev','#fq-kind'].forEach(s=>$(s).addEventListener('change',()=>loadQueue(true)));
  let deb;
  const debounce = fn => { clearTimeout(deb); deb = setTimeout(fn, 340); };
  $('#fq-owner').addEventListener('input', ()=>debounce(()=>loadQueue(true)));
  $('#fq-min').addEventListener('input', ()=>debounce(()=>loadQueue(true)));
  $('#fq-clear').addEventListener('click', ()=>{
    ['#fq-status','#fq-sev','#fq-kind','#fq-owner','#fq-min'].forEach(s=>$(s).value='');
    loadQueue(true); });
  $('#q-more').addEventListener('click', ()=>{ queueOffset+=queueLimit; loadQueue(); });
  $('#dl-search').addEventListener('input', ()=>debounce(loadDealers));

  $('#syncbtn').addEventListener('click', async ()=>{
    const b=$('#syncbtn'); b.textContent='Syncing…'; b.disabled=true;
    try{ await api('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      toast('Sync complete'); refreshAll(); }
    catch(e){ toast('Sync failed'); }
    b.textContent='Sync'; b.disabled=false;
  });

  function refreshAll(){
    const t = currentTab();
    (LOADERS[t]||loadQueue)();
    loadTopExposure();
  }

  connect(); loadQueue(true); loadTopExposure();
})();