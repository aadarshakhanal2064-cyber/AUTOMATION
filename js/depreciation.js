// ════════════════════════════════════════════
//  DEPRECIATION — Income Tax pool depreciation schedule (two schemes)
//  Reproduces the firm's "Depreciation as per Income Tax" working: the user
//  enters each pool's opening value, additions (split into the three tax
//  timing buckets) and disposals; Total Value, Depreciation Base,
//  Depreciation and closing WDV auto-calculate, and the exact template is
//  generated as an .xlsx (ExcelJS — faithful merges/borders/number formats,
//  which the app's SheetJS import-only build can't write).
//
//  Two schemes share ONE engine — they differ only in the Pool A–D rates:
//    · normal  — standard Income Tax rates (A 5, B 25, C 20, D 15 %)
//    · special — Special Industries: each rate ×4/3 (the 1/3 additional
//                depreciation the Act grants), i.e. A 6.667, B 33.33,
//                C 26.667, D 20 %. Software/Leasehold years stay editable.
//
//  Formulas (verbatim from the reference sheet):
//    Total Value      I = Opening + (Add₁+Add₂+Add₃) − Disposal
//    Depreciation Base J = Opening + Add₁ − Disposal + Add₂·2/3 + Add₃·1/3
//    Depreciation     K = Base × rate      (Pools A–D, reducing balance)
//                       = Base ÷ years     (Software / Leasehold, editable SLM)
//                       = 0                (Land — never depreciated)
//    WDV Amount       L = Total Value − Depreciation   (→ next year's opening)
//
//  Additions absorb per the Income Tax Act timing rule: Shrawan–Poush 100%,
//  Magh–Chaitra ⅔, Baishakh–Ashadh ⅓ (the three "Addition" sub-columns).
//
//  Persistence & carry-forward: a saved schedule for (client, scheme, FY)
//  lets the NEXT year's sheet auto-fill each pool's Opening from this year's
//  closing WDV. Saving is MANUAL (Save button) — generating Excel never
//  writes, so testing is safe. Backed by `depreciation_schedules` (§6).
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Accounting" dropdown, not a sidebar button.
ModuleRegistry.register({ id: 'depreciation', group: 'main', buttonId: null, panelId: 'tab-depreciation-panel' });

// Special Industries get 1/3 additional depreciation on Pools A–D — the rate
// is the normal rate × 4/3. Kept as a factor (not four magic decimals) so the
// relationship is self-documenting.
const DEP_SPECIAL_FACTOR = 4 / 3;

// The seven pools, shared shape. `rate` is the NORMAL reducing-balance rate;
// the special scheme derives its A–D rates from it via DEP_SPECIAL_FACTOR.
// SLM pools carry a default `years` (editable in the grid).
const DEP_POOL_DEFS = [
  { key:'building',  pool:'A', name:'Building & Structure',                  mode:'wdv', rate:0.05, kw:['building','structure'] },
  { key:'furniture', pool:'B', name:'Furniture, Fixture & Office Equipment', mode:'wdv', rate:0.25, kw:['furniture','fixture','office equip'] },
  { key:'vehicle',   pool:'C', name:'Vehicles',                              mode:'wdv', rate:0.20, kw:['vehicle'] },
  { key:'plant',     pool:'D', name:'Plant & Machinery & Other Assets',      mode:'wdv', rate:0.15, kw:['plant','machinery','other asset'] },
  { key:'software',  pool:'E', name:'Software',                              mode:'slm', years:5,   kw:['software'] },
  { key:'leasehold', pool:'',  name:'Leasehold Assets',                      mode:'slm', years:5,   kw:['leasehold','leashold'] },
  { key:'land',      pool:'',  name:'Land',                                  mode:'none',           kw:['land'] },
];

function depBuildScheme(special) {
  return DEP_POOL_DEFS.map(p => {
    const q = Object.assign({}, p);
    if (special && p.mode === 'wdv') q.rate = p.rate * DEP_SPECIAL_FACTOR;
    return q;
  });
}

const DEP_SCHEMES = { normal: depBuildScheme(false), special: depBuildScheme(true) };

const DEP_INPUT_COLS = ['opening', 'add1', 'add2', 'add3', 'disposal'];

// ── Module state ──
let depMethod   = 'incometax';// active method: 'incometax' (this file) | 'slm' (depreciationSlm.js)
let depScheme   = 'normal';   // active Income-Tax scheme ('normal' | 'special')
let depClientId = null;       // selected client id (required to save/carry-forward)

function depPools() { return DEP_SCHEMES[depScheme]; }

function depStatus(html, type) { showStatus(html, type, 'dep-status'); }

function depParse(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Zero (or empty) renders as an en-dash — "no such asset for this company".
function depFmt(n) {
  if (!n) return '–';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Reducing-balance rate as a clean percentage (6.667%, not 6.667000001%).
function depRatePct(rate) {
  return String(parseFloat((rate * 100).toFixed(3))) + '%';
}

// Live-read the editable SLM years for a pool (falls back to its default).
function depYears(p) {
  const el = document.getElementById('dep-' + p.key + '-years');
  const v = el ? depParse(el.value) : 0;
  return v > 0 ? v : (p.years || 0);
}

function depCompute(p, inp) {
  const active = !!(inp.opening || inp.add1 || inp.add2 || inp.add3 || inp.disposal);
  if (!active) return { active: false };
  const total = inp.opening + (inp.add1 + inp.add2 + inp.add3) - inp.disposal;
  const base  = inp.opening + inp.add1 - inp.disposal + inp.add2 / 3 * 2 + inp.add3 / 3;
  let dep = 0;
  if (p.mode === 'wdv') dep = base * p.rate;
  else if (p.mode === 'slm') { const y = inp.years || 0; dep = y > 0 ? base / y : 0; }
  const wdv = total - dep;
  return { active: true, total, base, dep, wdv };
}

// ── Build the editable grid for the active scheme ──
function depInit() {
  depBuildGrid();
  depBuildFyOptions();
  if (typeof depSlmInit === 'function') depSlmInit();
}

// ── Method toggle (Income Tax pools ⇄ Accounting-Standard SLM) ──
// Swaps the whole working shown in the panel. The Client/PAN/Fiscal-Year
// selectors, Save/Delete buttons and the carry-forward banner are SHARED; the
// header Import/Generate buttons and depReloadForContext/depSave/depDelete
// branch on depMethod and delegate to the depSlm* engine when method === 'slm'.
function depSetMethod(m) {
  if (m !== 'incometax' && m !== 'slm') return;
  depMethod = m;
  document.getElementById('dep-method-incometax').classList.toggle('active', m === 'incometax');
  document.getElementById('dep-method-slm').classList.toggle('active', m === 'slm');
  const it = document.getElementById('dep-incometax-ui'), slm = document.getElementById('dep-slm-ui');
  if (it) it.style.display = m === 'incometax' ? '' : 'none';
  if (slm) slm.style.display = m === 'slm' ? '' : 'none';
  const sub = document.getElementById('dep-page-subtitle');
  if (sub) sub.textContent = m === 'slm'
    ? 'Depreciation as per Accounting Standard (SLM) — per-asset, day-accurate straight-line with the 3.1 PPE note and year-over-year carry-forward.'
    : "Depreciation as per Income Tax — pool depreciation (reducing balance). Enter each pool's opening value, additions and disposals; totals calculate automatically.";
  depStatus('', 'info');
  depReloadForContext();
}

function depBuildGrid() {
  const tbody = document.getElementById('dep-tbody');
  if (!tbody) return;
  tbody.innerHTML = depPools().map(p => {
    const inCell = f => `<td><input class="dep-in" id="dep-${p.key}-${f}" inputmode="decimal" placeholder="–" oninput="depRecalc()"></td>`;
    // SLM pools expose an editable "years" input; WDV pools show a static %.
    const rateCell = p.mode === 'slm'
      ? `<td class="dep-rate"><input class="dep-in dep-years" id="dep-${p.key}-years" inputmode="numeric" placeholder="${p.years}" value="${p.years}" oninput="depRecalc()"> yrs</td>`
      : `<td class="dep-rate">${p.mode === 'wdv' ? depRatePct(p.rate) : '–'}</td>`;
    return `<tr>
      <td class="dep-pool">${p.pool || '—'}</td>
      <td class="dep-particular">${escHtml(p.name)}</td>
      ${rateCell}
      ${inCell('opening')}
      ${inCell('add1')}${inCell('add2')}${inCell('add3')}
      ${inCell('disposal')}
      <td class="dep-calc" id="dep-${p.key}-total">–</td>
      <td class="dep-calc" id="dep-${p.key}-base">–</td>
      <td class="dep-calc" id="dep-${p.key}-dep">–</td>
      <td class="dep-calc" id="dep-${p.key}-wdv">–</td>
    </tr>`;
  }).join('');
  tbody.dataset.scheme = depScheme;
  depRecalc();
}

function depRecalc() {
  const T = { opening:0, add1:0, add2:0, add3:0, disposal:0, total:0, base:0, dep:0, wdv:0 };
  depPools().forEach(p => {
    const g = f => depParse(document.getElementById('dep-' + p.key + '-' + f).value);
    const inp = { opening:g('opening'), add1:g('add1'), add2:g('add2'), add3:g('add3'), disposal:g('disposal') };
    if (p.mode === 'slm') inp.years = depYears(p);
    const c = depCompute(p, inp);
    const set = (f, v) => { document.getElementById('dep-' + p.key + '-' + f).textContent = v; };
    if (c.active) {
      set('total', depFmt(c.total)); set('base', depFmt(c.base)); set('dep', depFmt(c.dep)); set('wdv', depFmt(c.wdv));
      T.total += c.total; T.base += c.base; T.dep += c.dep; T.wdv += c.wdv;
    } else {
      ['total','base','dep','wdv'].forEach(f => set(f, '–'));
    }
    DEP_INPUT_COLS.forEach(f => { T[f] += inp[f]; });
    p._inp = inp; p._c = c;
  });
  ['opening','add1','add2','add3','disposal','total','base','dep','wdv']
    .forEach(f => { document.getElementById('dep-tot-' + f).textContent = depFmt(T[f]); });
  window._depTotals = T;
}

// ── Scheme toggle (segmented control) ──
function depSetScheme(scheme) {
  if (scheme !== 'normal' && scheme !== 'special') return;
  depScheme = scheme;
  document.getElementById('dep-scheme-normal').classList.toggle('active', scheme === 'normal');
  document.getElementById('dep-scheme-special').classList.toggle('active', scheme === 'special');
  const sub = document.getElementById('dep-scheme-sub');
  if (sub) sub.textContent = scheme === 'special'
    ? 'Special Industries — Pools A–D depreciate at the accelerated rate (1/3 additional).'
    : 'Depreciation as per Income Tax — standard reducing-balance rates.';
  depBuildGrid();
  // Scheme is part of the sheet identity (like client + FY) — reload its data.
  depReloadForContext();
}

function depReset() {
  depPools().forEach(p => {
    DEP_INPUT_COLS.forEach(f => { document.getElementById('dep-' + p.key + '-' + f).value = ''; });
    if (p.mode === 'slm') { const y = document.getElementById('dep-' + p.key + '-years'); if (y) y.value = p.years; }
  });
  document.getElementById('dep-add-tbody').innerHTML = '';
  depCarryBanner('');
  depRecalc();
  depStatus('', 'info');
}

// ════════════════════════════════════════════
//  FISCAL YEAR — dropdown covering a few back years through current + 6,
//  so the carry-forward chain (opening = last year's WDV) can be built out
//  ahead of time. Dash format (2081-82) is the Depreciation convention.
// ════════════════════════════════════════════
function depFyStartYear(fy) {
  const m = String(fy || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function depFyLabel(startYear) {
  return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0');
}

function depCurrentFyStart() {
  const bs = NepaliLocale.todayBs && NepaliLocale.todayBs();
  if (bs) return bs.month >= 4 ? bs.year : bs.year - 1;  // Shrawan–Ashadh fiscal year
  return 2081;  // graceful fallback once the B.S. table runs out
}

function depBuildFyOptions() {
  const sel = document.getElementById('dep-fy');
  if (!sel || sel.dataset.built) return;
  const cur = depCurrentFyStart();
  let html = '';
  for (let y = cur - 3; y <= cur + 6; y++) {
    html += `<option value="${depFyLabel(y)}"${y === cur ? ' selected' : ''}>${depFyLabel(y)}</option>`;
  }
  sel.innerHTML = html;
  sel.dataset.built = '1';
}

// ════════════════════════════════════════════
//  CLIENT SEARCH — reuses the shared clientsList (loaded by loadClients()),
//  so search here matches the Clients tab exactly. Selecting a client fills
//  company + PAN and triggers the carry-forward fetch.
// ════════════════════════════════════════════
function depSelectClient(c) {
  depClientId = c.id != null ? c.id : null;
  document.getElementById('dep-company').value = c.name || '';
  document.getElementById('dep-pan').value = c.pan || '';
  depUpdateSaveState();
  depReloadForContext();
}

// Fires on any context change (client / FY / scheme). Kept as a hook so the
// three selectors stay consistent.
function depOnFyChange() { depReloadForContext(); }

// ════════════════════════════════════════════
//  ADDITION DETAILS — itemize each purchase; auto-bucket into the three tax
//  timing columns by its B.S. date, the classification the user does by hand.
// ════════════════════════════════════════════
function depBsMonth(dateStr) {
  const parts = String(dateStr || '').split(/[\/\-.]/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  const m = parts.length >= 2 ? parts[1] : null;
  return (m >= 1 && m <= 12) ? m : null;
}

function depAddLine() {
  const tbody = document.getElementById('dep-add-tbody');
  const opts = depPools().map(p => `<option value="${p.key}">${(p.pool ? p.pool + ' — ' : '') + escHtml(p.name)}</option>`).join('');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="dep-in dep-add-date" placeholder="e.g. 2081/09/15" /></td>
    <td><select class="dep-add-pool">${opts}</select></td>
    <td><input class="dep-in dep-add-particular" placeholder="Asset description" style="text-align:left;" /></td>
    <td><input class="dep-in dep-add-amount" inputmode="decimal" placeholder="0" /></td>
    <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
}

function depApplyAdditions() {
  const buckets = {};
  let skipped = 0;
  document.querySelectorAll('#dep-add-tbody tr').forEach(tr => {
    const date = tr.querySelector('.dep-add-date').value;
    const key  = tr.querySelector('.dep-add-pool').value;
    const amt  = depParse(tr.querySelector('.dep-add-amount').value);
    if (!amt) return;
    const m = depBsMonth(date);
    if (!m) { skipped++; return; }
    const b = (m >= 4 && m <= 9) ? 'add1' : (m >= 10) ? 'add2' : 'add3';
    (buckets[key] = buckets[key] || { add1:0, add2:0, add3:0 })[b] += amt;
  });
  depPools().forEach(p => {
    const b = buckets[p.key];
    if (!b) return;
    ['add1','add2','add3'].forEach(f => { document.getElementById('dep-' + p.key + '-' + f).value = b[f] || ''; });
  });
  depRecalc();
  depStatus(
    (Object.keys(buckets).length ? '✅ Additions bucketed by date and applied to the schedule.' : '⚠️ No additions with an amount to apply.')
    + (skipped ? ` (${skipped} line(s) skipped — missing or invalid B.S. date.)` : ''),
    Object.keys(buckets).length ? 'success' : 'info'
  );
}

// ════════════════════════════════════════════
//  IMPORT — pre-fill the schedule from an uploaded template (.xlsx/.ods),
//  matching each pool by its Particular text (any row order tolerated).
// ════════════════════════════════════════════
function depImportExcel(input) {
  if (depMethod === 'slm') return depSlmImport(input);
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      let matched = 0;
      depPools().forEach(p => {
        const row = rows.find(r => {
          const txt = (String(r[1] || '') + ' ' + String(r[0] || '')).toLowerCase();
          return p.kw.some(k => txt.includes(k));
        });
        if (!row) return;
        matched++;
        const put = (f, colIdx) => {
          const n = depParse(row[colIdx]);
          document.getElementById('dep-' + p.key + '-' + f).value = n ? n : '';
        };
        put('opening', 3); put('add1', 4); put('add2', 5); put('add3', 6); put('disposal', 7);
      });
      depRecalc();
      depStatus(matched
        ? `✅ Imported ${matched} pool(s) from ${escHtml(file.name)}. Review the values, then generate.`
        : `⚠️ Couldn't recognize any depreciation pools in ${escHtml(file.name)}. Check it matches the standard template.`,
        matched ? 'success' : 'info');
    } catch (err) {
      depStatus('❌ Could not read that file: ' + escHtml(err.message), 'error');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

// ════════════════════════════════════════════
//  PERSISTENCE & CARRY-FORWARD
//  Manual save/delete against `depreciation_schedules`. On client/FY/scheme
//  change: load this year's saved sheet, else carry each pool's Opening from
//  last year's closing WDV, else leave blank. Generating Excel never saves.
// ════════════════════════════════════════════
function depCarryBanner(html, type) {
  const el = document.getElementById('dep-carry-banner');
  if (!el) return;
  el.innerHTML = html || '';
  el.style.display = html ? 'block' : 'none';
  el.className = 'dep-carry-banner' + (type ? ' ' + type : '');
}

function depUpdateSaveState() {
  const save = document.getElementById('dep-save-btn');
  const del  = document.getElementById('dep-delete-btn');
  const hint = document.getElementById('dep-save-hint');
  const has = depClientId != null;
  if (save) save.disabled = !has;
  if (del)  del.disabled = !has;
  if (hint) hint.style.display = has ? 'none' : 'inline';
}

// Serialize the current grid into the pools payload (inputs + closing WDV).
function depCollectPools() {
  return depPools().map(p => {
    const inp = p._inp || {};
    const c = p._c || {};
    const row = {
      key: p.key,
      opening: depParse(document.getElementById('dep-' + p.key + '-opening').value),
      add1: depParse(document.getElementById('dep-' + p.key + '-add1').value),
      add2: depParse(document.getElementById('dep-' + p.key + '-add2').value),
      add3: depParse(document.getElementById('dep-' + p.key + '-add3').value),
      disposal: depParse(document.getElementById('dep-' + p.key + '-disposal').value),
      wdv: c.active ? c.wdv : 0,
    };
    if (p.mode === 'slm') row.years = depYears(p);
    return row;
  });
}

function depCollectAdditions() {
  const lines = [];
  document.querySelectorAll('#dep-add-tbody tr').forEach(tr => {
    const amt = depParse(tr.querySelector('.dep-add-amount').value);
    if (!amt) return;
    lines.push({
      date: tr.querySelector('.dep-add-date').value.trim(),
      key: tr.querySelector('.dep-add-pool').value,
      particular: tr.querySelector('.dep-add-particular').value.trim(),
      amount: amt,
    });
  });
  return lines;
}

// Write saved pool values back into the grid (used on load).
function depApplyPools(pools) {
  const byKey = {};
  (pools || []).forEach(r => { byKey[r.key] = r; });
  depPools().forEach(p => {
    const r = byKey[p.key] || {};
    DEP_INPUT_COLS.forEach(f => {
      const el = document.getElementById('dep-' + p.key + '-' + f);
      el.value = r[f] ? r[f] : '';
    });
    if (p.mode === 'slm') {
      const y = document.getElementById('dep-' + p.key + '-years');
      if (y) y.value = r.years || p.years;
    }
  });
}

// Carry each pool's Opening from last year's stored closing WDV; wipe the
// rest (a fresh year starts from the brought-forward balance).
function depApplyCarryForward(pools) {
  const byKey = {};
  (pools || []).forEach(r => { byKey[r.key] = r; });
  depPools().forEach(p => {
    const r = byKey[p.key] || {};
    document.getElementById('dep-' + p.key + '-opening').value = r.wdv ? r.wdv : '';
    ['add1','add2','add3','disposal'].forEach(f => { document.getElementById('dep-' + p.key + '-' + f).value = ''; });
    if (p.mode === 'slm') {
      const y = document.getElementById('dep-' + p.key + '-years');
      if (y) y.value = r.years || p.years;
    }
  });
}

function depApplyAdditionLines(lines) {
  const tbody = document.getElementById('dep-add-tbody');
  tbody.innerHTML = '';
  (lines || []).forEach(l => {
    depAddLine();
    const tr = tbody.lastElementChild;
    tr.querySelector('.dep-add-date').value = l.date || '';
    tr.querySelector('.dep-add-pool').value = l.key || '';
    tr.querySelector('.dep-add-particular').value = l.particular || '';
    tr.querySelector('.dep-add-amount').value = l.amount || '';
  });
}

async function depReloadForContext() {
  if (depMethod === 'slm') return depSlmReload();
  if (depClientId == null) { depCarryBanner(''); return; }
  const fy = document.getElementById('dep-fy').value;
  const startYear = depFyStartYear(fy);
  try {
    // 1) A saved sheet for THIS year → resume editing it.
    const { data: cur, error: e1 } = await window.sb.from('depreciation_schedules')
      .select('pools, addition_details').eq('client_id', depClientId).eq('scheme', depScheme).eq('fiscal_year', fy).maybeSingle();
    if (e1) throw e1;
    if (cur) {
      depApplyPools(cur.pools);
      depApplyAdditionLines(cur.addition_details);
      depRecalc();
      depCarryBanner(`📂 Loaded your saved schedule for F.Y. ${escHtml(fy)}. Edit and re-save to update it.`, 'saved');
      return;
    }
    // 2) Else last year's sheet → carry its closing WDV into Opening.
    if (startYear != null) {
      const prevFy = depFyLabel(startYear - 1);
      const { data: prev, error: e2 } = await window.sb.from('depreciation_schedules')
        .select('pools').eq('client_id', depClientId).eq('scheme', depScheme).eq('fiscal_year', prevFy).maybeSingle();
      if (e2) throw e2;
      if (prev) {
        depApplyCarryForward(prev.pools);
        document.getElementById('dep-add-tbody').innerHTML = '';
        depRecalc();
        depCarryBanner(`↪️ Opening balances carried forward from F.Y. ${escHtml(prevFy)} (last year's closing WDV). Nothing saved yet for ${escHtml(fy)}.`, 'carry');
        return;
      }
    }
    // 3) Nothing on record.
    depCarryBanner(`ℹ️ No saved schedule for this client in F.Y. ${escHtml(fy)}, and none last year to carry forward. Starting blank.`, '');
  } catch (err) {
    depCarryBanner('⚠️ Could not check saved schedules: ' + escHtml(err.message), 'error');
  }
}

async function depSave() {
  if (depMethod === 'slm') return depSlmSave();
  if (depClientId == null) { depStatus('❌ Select a client first — saving needs a client to carry the balances forward.', 'error'); return; }
  depRecalc();
  const fy = document.getElementById('dep-fy').value;
  const payload = {
    client_id: depClientId,
    scheme: depScheme,
    fiscal_year: fy,
    company_name: document.getElementById('dep-company').value.trim() || null,
    pan: document.getElementById('dep-pan').value.trim() || null,
    pools: depCollectPools(),
    addition_details: depCollectAdditions(),
    created_by: (window.currentUser && window.currentUser.email) || null,
  };
  const btn = document.getElementById('dep-save-btn');
  if (btn) btn.disabled = true;
  try {
    const { error } = await window.sb.from('depreciation_schedules')
      .upsert(payload, { onConflict: 'client_id,scheme,fiscal_year' });
    if (error) throw error;
    AuditLog.record('depreciation_saved', { module: 'depreciation', client_name: payload.company_name, detail: { scheme: depScheme, fiscal_year: fy } });
    depCarryBanner(`💾 Saved for F.Y. ${escHtml(fy)}. Next year's sheet will carry these closing balances into Opening.`, 'saved');
    depStatus('✅ Schedule saved to the database.', 'success');
  } catch (err) {
    depStatus('❌ Could not save: ' + escHtml(err.message), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function depDelete() {
  if (depMethod === 'slm') return depSlmDelete();
  if (depClientId == null) { depStatus('❌ No client selected.', 'error'); return; }
  const fy = document.getElementById('dep-fy').value;
  if (!confirm(`Delete the saved ${depScheme === 'special' ? 'Special Industries' : 'Income Tax'} depreciation schedule for F.Y. ${fy}? This only removes the saved copy — the grid on screen stays.`)) return;
  try {
    const { error } = await window.sb.from('depreciation_schedules')
      .delete().eq('client_id', depClientId).eq('scheme', depScheme).eq('fiscal_year', fy);
    if (error) throw error;
    AuditLog.record('depreciation_deleted', { module: 'depreciation', client_name: document.getElementById('dep-company').value.trim() || null, detail: { scheme: depScheme, fiscal_year: fy } });
    depCarryBanner(`🗑️ Saved schedule for F.Y. ${escHtml(fy)} deleted.`, '');
    depStatus('✅ Saved schedule deleted.', 'success');
  } catch (err) {
    depStatus('❌ Could not delete: ' + escHtml(err.message), 'error');
  }
}

// ════════════════════════════════════════════
//  EXCEL GENERATION — reproduces the reference template exactly (merged
//  headers, thin borders, accounting number format, live formulas). Land's
//  Total-Value formula is written correctly here (the source sheet had it
//  pointing at the Leasehold row — a genuine error, not replicated).
//  This never saves to the database (§ persistence) — save is a separate,
//  explicit action so testing/generating a throwaway copy is safe.
// ════════════════════════════════════════════
async function depGenerateExcel() {
  if (depMethod === 'slm') return depSlmGenerateExcel();
  if (!window.ExcelJS) { depStatus('❌ Excel engine not loaded — reload the page and try again.', 'error'); return; }
  depRecalc();

  const company = document.getElementById('dep-company').value.trim();
  const fy = document.getElementById('dep-fy').value.trim();
  const pools = depPools();
  const schemeTitle = depScheme === 'special'
    ? 'Depreciation as per Income Tax (Special Industries)'
    : 'Depreciation as per Income Tax';

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Depreciation');
  const MONEY = '#,##0.00;(#,##0.00);"–"';
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
  const NAVY = 'FF0B1F3D';

  ws.columns = [
    { width: 6 }, { width: 34 }, { width: 12 }, { width: 15 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 13 },
    { width: 16 }, { width: 17 }, { width: 15 }, { width: 15 },
  ];

  // Title block
  ws.mergeCells('A1:L1');
  ws.getCell('A1').value = company || 'Depreciation Schedule';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:L2');
  ws.getCell('A2').value = schemeTitle + (fy ? '   |   F.Y. ' + fy : '');
  ws.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(1).height = 20;

  // Header rows (4 & 5)
  const H = 4, SUB = 5;
  const setHead = (cell, text) => {
    const c = ws.getCell(cell);
    c.value = text;
    c.font = { bold: true, size: 10, color: { argb: NAVY } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
    c.border = allBorders;
  };
  [['A','Pool'],['B','Particular'],['C','Depreciation Rate'],['D','Opening Value'],
   ['H','Disposal'],['I','Total Value'],['J','Depreciation Base'],['K','Depreciation'],['L','WDV Amount']]
    .forEach(([col, txt]) => { ws.mergeCells(`${col}${H}:${col}${SUB}`); setHead(`${col}${H}`, txt); });
  ws.mergeCells(`E${H}:G${H}`); setHead(`E${H}`, 'Addition');
  setHead(`E${SUB}`, 'Up to Paush'); setHead(`F${SUB}`, 'Magh–Chaitra'); setHead(`G${SUB}`, 'Baishakh–Ashadh');

  // Pool rows
  const first = 6;
  pools.forEach((p, i) => {
    const r = first + i;
    const inp = p._inp || { opening:0, add1:0, add2:0, add3:0, disposal:0 };
    ws.getCell(`A${r}`).value = p.pool || '';
    ws.getCell(`B${r}`).value = p.name;
    // Rate cell — percentage for reducing-balance pools, "n yrs" for SLM
    const rc = ws.getCell(`C${r}`);
    const years = p.mode === 'slm' ? (inp.years || depYears(p)) : 0;
    if (p.mode === 'wdv') { rc.value = p.rate; rc.numFmt = '0.###%'; }
    else if (p.mode === 'slm') { rc.value = years; rc.numFmt = '0" yrs"'; }
    rc.alignment = { horizontal: 'center' };
    // Inputs (0 shows as dash via the accounting format)
    [['D', inp.opening], ['E', inp.add1], ['F', inp.add2], ['G', inp.add3], ['H', inp.disposal]]
      .forEach(([col, v]) => { const c = ws.getCell(`${col}${r}`); c.value = v; c.numFmt = MONEY; });
    // Computed columns — live formulas matching the reference sheet
    const c = p._c && p._c.active ? p._c : depCompute(p, inp);
    const setF = (col, formula, result) => {
      const cell = ws.getCell(`${col}${r}`);
      cell.value = { formula, result: result || 0 };
      cell.numFmt = MONEY;
    };
    setF('I', `D${r}+SUM(E${r}:G${r})-H${r}`, c.total);
    setF('J', `D${r}+E${r}-H${r}+F${r}/3*2+G${r}/3`, c.base);
    if (p.mode === 'wdv') setF('K', `J${r}*C${r}`, c.dep);
    else if (p.mode === 'slm' && years > 0) setF('K', `J${r}/C${r}`, c.dep);
    else { ws.getCell(`K${r}`).value = 0; ws.getCell(`K${r}`).numFmt = MONEY; }
    setF('L', `I${r}-K${r}`, c.wdv);
    ws.getCell(`B${r}`).alignment = { horizontal: 'left' };
  });

  // Total row
  const totR = first + pools.length;
  ws.getCell(`B${totR}`).value = 'Total';
  ['D','E','F','G','H','I','J','K','L'].forEach(col => {
    const cell = ws.getCell(`${col}${totR}`);
    cell.value = { formula: `SUM(${col}${first}:${col}${totR - 1})` };
    cell.numFmt = MONEY;
  });

  // Borders + fonts across the whole grid
  for (let r = H; r <= totR; r++) {
    for (let col = 1; col <= 12; col++) {
      const cell = ws.getRow(r).getCell(col);
      cell.border = allBorders;
      if (r === totR) cell.font = { bold: true, color: { argb: NAVY } };
      if (r >= first && r < totR && col >= 3) cell.alignment = cell.alignment || { horizontal: 'right' };
    }
  }
  ws.getRow(totR).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1FA' } }; });

  // Optional Addition-details block (only if the helper table has lines)
  const addLines = [];
  document.querySelectorAll('#dep-add-tbody tr').forEach(tr => {
    const amt = depParse(tr.querySelector('.dep-add-amount').value);
    if (!amt) return;
    const key = tr.querySelector('.dep-add-pool').value;
    const p = pools.find(x => x.key === key);
    addLines.push({
      date: tr.querySelector('.dep-add-date').value.trim(),
      pool: p ? (p.pool || p.name) : '',
      particular: tr.querySelector('.dep-add-particular').value.trim(),
      amount: amt,
    });
  });
  if (addLines.length) {
    let r = totR + 2;
    ws.mergeCells(`B${r}:E${r}`);
    ws.getCell(`B${r}`).value = 'Addition';
    ws.getCell(`B${r}`).font = { bold: true, color: { argb: NAVY } };
    r++;
    ['Date', 'Pool', 'Particular', 'Amount'].forEach((t, i) => {
      const cell = ws.getRow(r).getCell(2 + i);
      cell.value = t; cell.font = { bold: true }; cell.border = allBorders;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
    });
    addLines.forEach(l => {
      r++;
      const cells = [l.date, l.pool, l.particular, l.amount];
      cells.forEach((v, i) => {
        const cell = ws.getRow(r).getCell(2 + i);
        cell.value = v; cell.border = allBorders;
        if (i === 3) cell.numFmt = MONEY;
      });
    });
  }

  try {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = (schemeTitle + ' ' + (company ? company + ' ' : '') + (fy || '')).trim() + '.xlsx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'depreciation', clientName: company || null });
    depStatus('✅ Excel generated and downloaded.', 'success');
  } catch (err) {
    depStatus('❌ Could not generate the file: ' + escHtml(err.message), 'error');
  }
}

// ── Wire client search once the DOM is ready (module loads before auth) ──
(function depWireSearch() {
  const input = document.getElementById('dep-company');
  const list = document.getElementById('dep-autocomplete-list');
  if (!input || !list) return;
  SearchEngine.attachAutocomplete(input, list, {
    getList: () => window.clientsList,
    keys: ['name', 'email', 'pan'],
    renderItem: c => `
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    `,
    onSelect: depSelectClient,
  });
  // Typing freely (not picking a result) invalidates the selected client, so
  // Save/carry-forward don't silently attach to a stale id.
  input.addEventListener('input', () => { depClientId = null; depUpdateSaveState(); });
})();
