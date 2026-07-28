// ════════════════════════════════════════════
//  DEPRECIATION — Accounting-Standard (SLM) method   ·   "Dep as Books" + 3.1 PPE
//  Sibling of depreciation.js (Income-Tax pools). Lives in the SAME panel, shown
//  by the method toggle (depMethod === 'slm'); shares the client / PAN / Fiscal-
//  Year selectors, Save/Delete buttons and the dep-status box. All ids/functions
//  use the `dep-slm-` / `depSlm*` sub-namespace inside the module's `dep-` prefix.
//
//  MODEL (reverse-engineered from the firm's Book1.xlsx, verified against its own
//  "Check" column — the source's other formula variants are hand-built errors):
//
//    Balance (E)        = OpeningWDV(B) + Addition(C) − (DelCost − DelDep)
//    Depreciation (G)   = Balance × DaysInYear ÷ RemainingLifeDays
//                         (capped at Balance in the final year; 0 for Land)
//    Total Dep (I)      = OpeningDep(F) + Depreciation(G) + Impairment − DelDep(H)
//    Closing WDV (J)    = Balance − Depreciation − Impairment
//    Check              : (OrigCost − DelCost) − TotalDep  ==  Closing WDV   (always)
//
//  Balance × Days ÷ RemainingDays reduces to true straight-line (Cost ÷ Life) for
//  whole years, prorates partial (acquisition/disposal) years by actual B.S. days,
//  and writes the asset to exactly 0 at end of life. Proven for multi-year runs.
//
//  Addition(C) is AUTO = Original Cost in the acquisition year (date-of-use falls in
//  the selected F.Y.), else 0. Carry-forward: OpeningWDV ← prior Closing WDV,
//  OpeningDep ← prior Total Dep, RemainingLife ← prior remaining − prior days used,
//  Original Cost constant. Persisted (manual Save) to depreciation_schedules with
//  scheme='slm'; Sheet 2 (PPE note) is a class rollup of Sheet 1 and always ties out.
// ════════════════════════════════════════════

// ── State ──
let depSlmRows = [];    // array of asset-line objects (the single source of truth)
let depSlmSeq  = 0;     // uid generator (stable element ids across add/remove)

function depSlmClasses() { return window.DEP_SLM_CLASSES || []; }
function depSlmClass(key) { return depSlmClasses().find(c => c.key === key) || null; }
function depSlmRow(uid) { return depSlmRows.find(r => r.uid === uid) || null; }
function depSlmCid(uid, field) { return 'depslm-' + uid + '-' + field; }

// Current F.Y. start year from the shared dropdown (depFyStartYear lives in depreciation.js).
function depSlmFyStart() { return depFyStartYear(document.getElementById('dep-fy').value); }

// Acquired in the SELECTED fiscal year? (date-of-use's fiscal year == current) →
// drives Addition = Original Cost and Remaining Life = full life.
function depSlmAcquiredThisFy(dateOfUse, fyStart) {
  const p = dateOfUse ? NepaliLocale.bsPartsNum(dateOfUse) : null;
  if (!p || fyStart == null) return false;
  const startYear = p.month >= 4 ? p.year : p.year - 1;  // Shrawan–Ashadh fiscal year
  return startYear === fyStart;
}

// The one formula (see header). Returns every derived figure + the Check flag.
function depSlmComputeLine(r, fyStart) {
  const cls = depSlmClass(r.classKey);
  const depreciable = cls ? cls.depreciable : true;
  const acq = depSlmAcquiredThisFy(r.dateOfUse, fyStart);
  const origCost = depParse(r.origCost);
  const life     = depParse(r.life);
  const addition = acq ? origCost : 0;
  const openWDV  = acq ? 0 : depParse(r.openWDV);
  const openDep  = acq ? 0 : depParse(r.openDep);
  const delCost  = depParse(r.delCost);
  const delDep   = depParse(r.delDep);
  const impair   = depParse(r.impairment);
  const days = NepaliLocale.daysInServiceThisFy(r.dateOfUse || null, fyStart, r.disposalDate || null);
  const remainDays = acq ? life * 365 : (depParse(r.remainDays) || life * 365);

  const balance = openWDV + addition - (delCost - delDep);
  let charge = 0;
  if (depreciable && remainDays > 0) {
    charge = balance * days / remainDays;
    if (charge > balance) charge = balance;   // final year / over-life cap
    if (charge < 0) charge = 0;
  }
  const costHeldClosing = origCost - delCost;
  const totalDep   = openDep + charge + impair - delDep;
  const closingWDV = balance - charge - impair;
  const checkOk = Math.abs((costHeldClosing - totalDep) - closingWDV) < 0.02;

  return { acq, depreciable, origCost, life, addition, openWDV, openDep, delCost, delDep, impair,
           days, remainDays, balance, charge, costHeldClosing, totalDep, closingWDV, checkOk };
}

// ════════════════════════════════════════════
//  GRID
// ════════════════════════════════════════════
function depSlmInit() { depSlmRender(); }

// Full rebuild of the asset grid (used on load / carry-forward / reset / add / remove).
function depSlmRender() {
  const tbody = document.getElementById('dep-slm-tbody');
  if (!tbody) return;
  if (!depSlmRows.length) {
    tbody.innerHTML = `<tr class="dep-slm-empty"><td colspan="20" style="text-align:center; color:var(--text-muted); padding:22px;">No assets yet — click <strong>＋ Add asset</strong> to begin, or Import from Excel.</td></tr>`;
  } else {
    tbody.innerHTML = depSlmRows.map(depSlmRowHtml).join('');
  }
  depSlmRecalc();
}

function depSlmRowHtml(r) {
  const uid = r.uid;
  const opts = depSlmClasses().map(c => `<option value="${c.key}"${c.key === r.classKey ? ' selected' : ''}>${escHtml(c.name)}</option>`).join('');
  const inp = (field, ph, cls) => `<input class="dep-in ${cls || ''}" value="${escHtml(r[field] == null ? '' : String(r[field]))}" placeholder="${ph}" oninput="depSlmSet(${uid},'${field}',this.value)">`;
  const calc = (field) => `<td class="dep-calc" id="${depSlmCid(uid, field)}">–</td>`;
  return `<tr data-uid="${uid}">
    <td class="dep-slm-cls"><select class="dep-in" onchange="depSlmSet(${uid},'classKey',this.value)">${opts}</select></td>
    <td class="dep-particular">${inp('particular', 'Asset description', 'dep-slm-particular')}</td>
    <td>${inp('dateOfUse', '2081/09/15', 'dep-slm-date')}</td>
    <td class="dep-calc" id="${depSlmCid(uid, 'days')}">–</td>
    <td>${inp('life', 'yrs', 'dep-slm-life')}</td>
    <td>${inp('remainDays', 'auto', 'dep-slm-rem')}</td>
    <td>${inp('origCost', '0', 'dep-slm-num')}</td>
    <td>${inp('openWDV', '0', 'dep-slm-num')}</td>
    ${calc('addition')}
    <td>${inp('delCost', '0', 'dep-slm-num')}</td>
    ${calc('balance')}
    <td>${inp('openDep', '0', 'dep-slm-num')}</td>
    ${calc('charge')}
    <td>${inp('delDep', '0', 'dep-slm-num')}</td>
    <td>${inp('impairment', '0', 'dep-slm-num')}</td>
    ${calc('total')}
    ${calc('wdv')}
    <td class="dep-slm-check" id="${depSlmCid(uid, 'check')}">–</td>
    <td><button class="btn btn-danger btn-sm" onclick="depSlmRemove(${uid})" title="Remove asset">✕</button></td>
  </tr>`;
}

// One asset-line shape, used by every builder (manual add, addition helper, load).
// `fromAdd` links a row back to the Addition-details line that created it, so
// re-applying that helper updates the row instead of appending a duplicate.
function depSlmNewRow(data) {
  const first = depSlmClasses().find(c => c.depreciable) || depSlmClasses()[0] || {};
  const row = Object.assign({
    uid: 0, classKey: first.key || '', particular: '', dateOfUse: '', disposalDate: '',
    life: first.life || '', remainDays: '', origCost: '', openWDV: '', openDep: '',
    delCost: '', delDep: '', impairment: '', fromAdd: '',
  }, data || {});
  row.uid = row.uid || ++depSlmSeq;
  return row;
}

function depSlmAdd(data) {
  depSlmRows.push(depSlmNewRow(data));
  depSlmRender();
}

function depSlmRemove(uid) {
  depSlmRows = depSlmRows.filter(r => r.uid !== uid);
  depSlmRender();
}

// Update the backing object, then recompute (no rebuild — keeps input focus).
function depSlmSet(uid, field, value) {
  const r = depSlmRow(uid);
  if (!r) return;
  r[field] = value;
  // Class change with a blank useful life → seed the class default.
  if (field === 'classKey') {
    const cls = depSlmClass(value);
    if (cls && !depParse(r.life)) { r.life = cls.life || ''; const el = depSlmRowInput(uid, 'life'); if (el) el.value = r.life; }
  }
  // Life change on a not-yet-carried row → keep Remaining Life = life × 365 (editable after).
  if (field === 'life') {
    const fyStart = depSlmFyStart();
    const acq = depSlmAcquiredThisFy(r.dateOfUse, fyStart);
    if (acq || !depParse(r.remainDays)) { r.remainDays = depParse(r.life) * 365 || ''; const el = depSlmRowInput(uid, 'remainDays'); if (el) el.value = r.remainDays; }
  }
  depSlmRecalc();
}

// Find a specific input inside a row without a full rebuild (for the two auto-fills above).
function depSlmRowInput(uid, field) {
  const tr = document.querySelector(`#dep-slm-tbody tr[data-uid="${uid}"]`);
  if (!tr) return null;
  return tr.querySelector(`.dep-slm-${field === 'remainDays' ? 'rem' : field}`) ||
         Array.from(tr.querySelectorAll('input')).find(i => i.getAttribute('oninput') && i.getAttribute('oninput').includes(`'${field}'`));
}

// Recompute every derived cell + the grand total + the PPE note preview.
function depSlmRecalc() {
  const fyStart = depSlmFyStart();
  const T = { addition: 0, balance: 0, charge: 0, total: 0, wdv: 0, origCost: 0, openWDV: 0, openDep: 0 };
  depSlmRows.forEach(r => {
    const c = depSlmComputeLine(r, fyStart);
    r._c = c;
    const set = (field, val) => { const el = document.getElementById(depSlmCid(r.uid, field)); if (el) el.textContent = val; };
    set('days', c.days ? String(c.days) : '–');
    set('addition', depFmt(c.addition));
    set('balance', depFmt(c.balance));
    set('charge', depFmt(c.charge));
    set('total', depFmt(c.totalDep));
    set('wdv', depFmt(c.closingWDV));
    const chk = document.getElementById(depSlmCid(r.uid, 'check'));
    if (chk) {
      const has = c.origCost || c.openWDV || c.addition;
      chk.textContent = !has ? '–' : (c.checkOk ? '✓' : '✕');
      chk.className = 'dep-slm-check' + (!has ? '' : (c.checkOk ? ' ok' : ' bad'));
    }
    T.addition += c.addition; T.balance += c.balance; T.charge += c.charge;
    T.total += c.totalDep; T.wdv += c.closingWDV;
    T.origCost += c.origCost; T.openWDV += c.openWDV; T.openDep += c.openDep;
  });
  const tot = (field, val) => { const el = document.getElementById('dep-slm-tot-' + field); if (el) el.textContent = val; };
  tot('origCost', depFmt(T.origCost)); tot('openWDV', depFmt(T.openWDV)); tot('addition', depFmt(T.addition));
  tot('balance', depFmt(T.balance)); tot('openDep', depFmt(T.openDep)); tot('charge', depFmt(T.charge));
  tot('total', depFmt(T.total)); tot('wdv', depFmt(T.wdv));
  window._depSlmTotals = T;
  depSlmRenderPpe();
}

// ════════════════════════════════════════════
//  PPE NOTE (Sheet 2) — class rollup of the grid, classes as columns. Rebuilt on
//  every recalc (read-only, no inputs → safe to fully re-render). Always ties out:
//  each class's closing carrying amount == Σ of its assets' closing WDV.
// ════════════════════════════════════════════
function depSlmPpeAggregate(fyStart) {
  const by = {};
  depSlmClasses().forEach(c => { by[c.key] = { cls: c, costOpen: 0, add: 0, dispCost: 0, depOpen: 0, charge: 0, impair: 0, dispDep: 0, closeWDV: 0 }; });
  depSlmRows.forEach(r => {
    const c = r._c || depSlmComputeLine(r, fyStart);
    const b = by[r.classKey]; if (!b) return;
    b.costOpen += c.origCost - c.addition;   // gross cost held at open (this-year adds excluded)
    b.add      += c.addition;
    b.dispCost += c.delCost;
    b.depOpen  += c.openDep;
    b.charge   += c.charge;
    b.impair   += c.impair;
    b.dispDep  += c.delDep;
    b.closeWDV += c.closingWDV;
  });
  return by;
}

function depSlmRenderPpe() {
  const host = document.getElementById('dep-slm-ppe');
  if (!host) return;
  const fyStart = depSlmFyStart();
  const by = depSlmPpeAggregate(fyStart);
  // Only classes that actually have assets (keeps the note compact); Total always shown.
  const cols = depSlmClasses().filter(c => {
    const b = by[c.key];
    return b.costOpen || b.add || b.dispCost || b.depOpen || b.charge || b.closeWDV;
  });
  if (!cols.length) { host.innerHTML = `<div style="color:var(--text-muted); font-size:13px; padding:8px 2px;">The PPE note builds here automatically once you add assets above.</div>`; return; }

  const fyLbl = document.getElementById('dep-fy').value || '';
  const startYear = depFyStartYear(fyLbl);
  const openLbl = startYear != null ? `1st Shrawan, ${startYear}` : 'Opening';
  const closeLbl = startYear != null ? `End Ashadh, ${startYear + 1}` : 'Closing';

  // Per-class derived closings + a Total column.
  const tot = { costOpen: 0, add: 0, dispCost: 0, depOpen: 0, charge: 0, impair: 0, dispDep: 0 };
  cols.forEach(c => { const b = by[c.key]; Object.keys(tot).forEach(k => tot[k] += b[k]); });
  const derive = b => {
    const costClose = b.costOpen + b.add - b.dispCost;
    const depClose = b.depOpen + b.charge + b.impair - b.dispDep;
    return { costClose, depClose, carryOpen: b.costOpen - b.depOpen, carryClose: costClose - depClose };
  };
  const cells = pick => cols.map(c => `<td class="dep-calc">${depFmt(pick(by[c.key], derive(by[c.key])))}</td>`).join('')
    + `<td class="dep-calc dep-slm-ppe-tot">${depFmt(pick(tot, derive(tot)))}</td>`;

  const section = (label) => `<tr class="dep-slm-ppe-section"><td>${label}</td>${cols.map(() => '<td></td>').join('')}<td></td></tr>`;
  const row = (label, pick, strong) => `<tr${strong ? ' class="dep-slm-ppe-strong"' : ''}><td class="dep-particular">${label}</td>${cells(pick)}</tr>`;

  host.innerHTML = `
    <table class="client-table dep-table dep-slm-ppe-table" style="min-width:${180 + (cols.length + 1) * 120}px;">
      <thead><tr>
        <th class="dep-particular">Particulars</th>
        ${cols.map(c => `<th>${escHtml(c.name)}</th>`).join('')}
        <th class="dep-slm-ppe-tot">Total</th>
      </tr></thead>
      <tbody>
        ${section('Cost')}
        ${row(`Balance as at ${openLbl}`, b => b.costOpen)}
        ${row('Additions', b => b.add)}
        ${row('Disposals', b => b.dispCost)}
        ${row(`Balance at ${closeLbl}`, (b, d) => d.costClose, true)}
        ${section('Depreciation &amp; Impairment')}
        ${row(`Balance as at ${openLbl}`, b => b.depOpen)}
        ${row('Depreciation charged for the year', b => b.charge)}
        ${row('Impairment adjustment', b => b.impair)}
        ${row('Disposals', b => b.dispDep)}
        ${row(`Balance at ${closeLbl}`, (b, d) => d.depClose, true)}
        ${section('Carrying Amount')}
        ${row(`As at ${openLbl}`, (b, d) => d.carryOpen, true)}
        ${row(`As at ${closeLbl}`, (b, d) => d.carryClose, true)}
      </tbody>
    </table>`;
}

// ════════════════════════════════════════════
//  ADDITION DETAILS — itemize this year's purchases. The Income-Tax sibling
//  buckets amounts into three timing columns on a permanent pool row; SLM has no
//  pools, so here an addition IS an asset line: "Apply" creates a row whose Date
//  of Use drives Addition = cost, a full useful life and the day proration.
//
//  Apply is a SYNC, not an append — each line carries a stable `aid` stamped onto
//  the row it created (`fromAdd`), so re-applying edits that row. Deleting a line
//  deliberately leaves its asset alone; removal is the grid's ✕ button.
// ════════════════════════════════════════════
let depSlmAddSeq = 0;   // uid generator for addition-detail lines

function depSlmAddLine(data) {
  const tbody = document.getElementById('dep-slm-add-tbody');
  if (!tbody) return;
  const d = data || {};
  const aid = depParse(d.aid) || ++depSlmAddSeq;
  if (aid > depSlmAddSeq) depSlmAddSeq = aid;   // keep the seq clear of restored ids
  const opts = depSlmClasses().map(c => `<option value="${c.key}"${c.key === d.classKey ? ' selected' : ''}>${escHtml(c.name)}</option>`).join('');
  const val = v => escHtml(v == null || v === '' ? '' : String(v));
  const tr = document.createElement('tr');
  tr.dataset.aid = aid;
  tr.innerHTML = `
    <td><input class="dep-in dep-slm-add-date" placeholder="e.g. 2081/09/15" value="${val(d.date)}" /></td>
    <td><select class="dep-slm-add-class" onchange="depSlmAddLineClass(this)">${opts}</select></td>
    <td><input class="dep-in dep-slm-add-particular" placeholder="Asset description" value="${val(d.particular)}" /></td>
    <td><input class="dep-in dep-slm-add-life" inputmode="decimal" placeholder="auto" value="${val(d.life)}" /></td>
    <td><input class="dep-in dep-slm-add-amount" inputmode="decimal" placeholder="0" value="${val(d.amount)}" /></td>
    <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
  if (!data) depSlmAddLineClass(tr.querySelector('.dep-slm-add-class'));   // seed the class's default life
}

// Blank life follows the class default (same rule as the grid's class picker).
function depSlmAddLineClass(sel) {
  const life = sel.closest('tr').querySelector('.dep-slm-add-life');
  const cls = depSlmClass(sel.value);
  if (life && !depParse(life.value)) life.value = cls && cls.life ? cls.life : '';
}

function depSlmApplyAdditions() {
  const fyStart = depSlmFyStart();
  const fyLbl = document.getElementById('dep-fy').value || '';
  let created = 0, updated = 0, noDate = 0, offYear = 0;
  document.querySelectorAll('#dep-slm-add-tbody tr').forEach(tr => {
    const amount = depParse(tr.querySelector('.dep-slm-add-amount').value);
    if (!amount) return;
    const date = tr.querySelector('.dep-slm-add-date').value.trim();
    if (!NepaliLocale.bsPartsNum(date)) { noDate++; return; }
    if (!depSlmAcquiredThisFy(date, fyStart)) offYear++;
    const classKey = tr.querySelector('.dep-slm-add-class').value;
    const cls = depSlmClass(classKey);
    const life = depParse(tr.querySelector('.dep-slm-add-life').value) || (cls && cls.life) || '';
    const fields = {
      classKey,
      particular: tr.querySelector('.dep-slm-add-particular').value.trim() || (cls ? cls.name : ''),
      dateOfUse: date, life, remainDays: life ? life * 365 : '', origCost: amount,
    };
    const aid = depParse(tr.dataset.aid);
    const existing = depSlmRows.find(r => r.fromAdd === aid);
    if (existing) { Object.assign(existing, fields); updated++; }
    else { depSlmRows.push(depSlmNewRow(Object.assign({ fromAdd: aid }, fields))); created++; }
  });
  depSlmRender();

  const done = [];
  if (created) done.push(`${created} asset line(s) added`);
  if (updated) done.push(`${updated} updated`);
  let msg = done.length
    ? `✅ ${done.join(', ')} in the schedule above.`
    : '⚠️ No addition lines with both a B.S. date and an amount to apply.';
  if (noDate) msg += ` (${noDate} line(s) skipped — missing or invalid B.S. date.)`;
  if (offYear) msg += ` ⚠️ ${offYear} line(s) fall outside F.Y. ${escHtml(fyLbl)} — added, but they won't count as this year's addition until the date or the fiscal year is corrected.`;
  depStatus(msg, done.length ? 'success' : 'info');
}

function depSlmCollectAdditions() {
  const lines = [];
  document.querySelectorAll('#dep-slm-add-tbody tr').forEach(tr => {
    const amount = depParse(tr.querySelector('.dep-slm-add-amount').value);
    if (!amount) return;
    lines.push({
      aid: depParse(tr.dataset.aid) || null,
      date: tr.querySelector('.dep-slm-add-date').value.trim(),
      classKey: tr.querySelector('.dep-slm-add-class').value,
      particular: tr.querySelector('.dep-slm-add-particular').value.trim(),
      life: depParse(tr.querySelector('.dep-slm-add-life').value) || null,
      amount,
    });
  });
  return lines;
}

function depSlmApplyAdditionLines(lines) {
  const tbody = document.getElementById('dep-slm-add-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  depSlmAddSeq = 0;
  (lines || []).forEach(l => depSlmAddLine(l));
}

// ════════════════════════════════════════════
//  PERSISTENCE & CARRY-FORWARD  (scheme = 'slm' in depreciation_schedules)
// ════════════════════════════════════════════
// Serialize the grid: editable inputs + a snapshot of the computed closings that
// next year's carry-forward reads (closing WDV, total dep, remaining life, days).
function depSlmCollectRows() {
  const fyStart = depSlmFyStart();
  return depSlmRows.map(r => {
    const c = r._c || depSlmComputeLine(r, fyStart);
    return {
      classKey: r.classKey, particular: (r.particular || '').trim(), dateOfUse: (r.dateOfUse || '').trim(),
      disposalDate: (r.disposalDate || '').trim(), life: depParse(r.life), fromAdd: r.fromAdd || null,
      origCost: depParse(r.origCost), openWDV: depParse(r.openWDV), openDep: depParse(r.openDep),
      delCost: depParse(r.delCost), delDep: depParse(r.delDep), impairment: depParse(r.impairment),
      remainDays: depParse(r.remainDays) || (depParse(r.life) * 365),
      _closingWDV: c.closingWDV, _totalDep: c.totalDep, _remainDays: c.remainDays, _days: c.days,
      _costHeldClosing: c.costHeldClosing,
    };
  });
}

// Re-hydrate the grid from a saved row set (resume this year's sheet).
function depSlmApplyRows(rows) {
  depSlmRows = (rows || []).map(s => depSlmNewRow({
    classKey: s.classKey, particular: s.particular || '', dateOfUse: s.dateOfUse || '',
    disposalDate: s.disposalDate || '', life: s.life || '', remainDays: s.remainDays || '',
    origCost: s.origCost || '', openWDV: s.openWDV || '', openDep: s.openDep || '',
    delCost: s.delCost || '', delDep: s.delDep || '', impairment: s.impairment || '',
    fromAdd: s.fromAdd || '',
  }));
  depSlmRender();
}

// Carry each asset into the next year: Opening WDV ← closing WDV, Opening Dep ←
// total dep, cost constant (net of disposal), remaining life ← prior − days used.
// Fully-disposed assets (nothing left on the books) drop off.
function depSlmApplyCarryForward(rows) {
  depSlmRows = (rows || [])
    .filter(s => (s._costHeldClosing || 0) > 0.005)
    .map(s => depSlmNewRow({
      classKey: s.classKey, particular: s.particular || '', dateOfUse: s.dateOfUse || '',
      disposalDate: '', life: s.life || '',
      remainDays: Math.max(0, (s._remainDays || 0) - (s._days || 0)),
      origCost: s._costHeldClosing || s.origCost || '',
      openWDV: s._closingWDV || 0, openDep: s._totalDep || 0,
      delCost: '', delDep: '', impairment: '',
      // No fromAdd — a carried asset is no longer this year's addition.
    }));
  depSlmRender();
}

async function depSlmReload() {
  if (typeof depClientId === 'undefined' || depClientId == null) { depCarryBanner(''); return; }
  const fy = document.getElementById('dep-fy').value;
  const startYear = depFyStartYear(fy);
  try {
    const { data: cur, error: e1 } = await window.sb.from('depreciation_schedules')
      .select('pools, addition_details').eq('client_id', depClientId).eq('scheme', 'slm').eq('fiscal_year', fy).maybeSingle();
    if (e1) throw e1;
    if (cur) {
      depSlmApplyRows(cur.pools);
      depSlmApplyAdditionLines(cur.addition_details);
      depCarryBanner(`📂 Loaded your saved SLM schedule for F.Y. ${escHtml(fy)}. Edit and re-save to update it.`, 'saved');
      return;
    }
    if (startYear != null) {
      const prevFy = depFyLabel(startYear - 1);
      const { data: prev, error: e2 } = await window.sb.from('depreciation_schedules')
        .select('pools').eq('client_id', depClientId).eq('scheme', 'slm').eq('fiscal_year', prevFy).maybeSingle();
      if (e2) throw e2;
      if (prev && prev.pools && prev.pools.length) {
        depSlmApplyCarryForward(prev.pools);
        depSlmApplyAdditionLines([]);   // last year's purchases aren't this year's additions
        depCarryBanner(`↪️ Assets carried forward from F.Y. ${escHtml(prevFy)} — opening WDV, accumulated depreciation and remaining life brought forward. Nothing saved yet for ${escHtml(fy)}.`, 'carry');
        return;
      }
    }
    depCarryBanner(`ℹ️ No saved SLM schedule for this client in F.Y. ${escHtml(fy)}, and none last year to carry forward. Add assets to begin.`, '');
  } catch (err) {
    depCarryBanner('⚠️ Could not check saved schedules: ' + escHtml(err.message), 'error');
  }
}

async function depSlmSave() {
  if (typeof depClientId === 'undefined' || depClientId == null) { depStatus('❌ Select a client first — saving needs a client to carry the balances forward.', 'error'); return; }
  depSlmRecalc();
  const fy = document.getElementById('dep-fy').value;
  const payload = {
    client_id: depClientId, scheme: 'slm', fiscal_year: fy,
    company_name: document.getElementById('dep-company').value.trim() || null,
    pan: document.getElementById('dep-pan').value.trim() || null,
    pools: depSlmCollectRows(),
    addition_details: depSlmCollectAdditions(),
    created_by: (window.currentUser && window.currentUser.email) || null,
  };
  const btn = document.getElementById('dep-save-btn');
  if (btn) btn.disabled = true;
  try {
    const { error } = await window.sb.from('depreciation_schedules')
      .upsert(payload, { onConflict: 'client_id,scheme,fiscal_year' });
    if (error) throw error;
    AuditLog.record('depreciation_saved', { module: 'depreciation', client_name: payload.company_name, detail: { scheme: 'slm', fiscal_year: fy } });
    depCarryBanner(`💾 Saved (SLM) for F.Y. ${escHtml(fy)}. Next year's sheet will carry these closing balances forward.`, 'saved');
    depStatus('✅ SLM schedule saved to the database.', 'success');
  } catch (err) {
    depStatus('❌ Could not save: ' + escHtml(err.message), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function depSlmDelete() {
  if (typeof depClientId === 'undefined' || depClientId == null) { depStatus('❌ No client selected.', 'error'); return; }
  const fy = document.getElementById('dep-fy').value;
  if (!confirm(`Delete the saved SLM (accounting-standard) depreciation schedule for F.Y. ${fy}? This only removes the saved copy — the grid on screen stays.`)) return;
  try {
    const { error } = await window.sb.from('depreciation_schedules')
      .delete().eq('client_id', depClientId).eq('scheme', 'slm').eq('fiscal_year', fy);
    if (error) throw error;
    AuditLog.record('depreciation_deleted', { module: 'depreciation', client_name: document.getElementById('dep-company').value.trim() || null, detail: { scheme: 'slm', fiscal_year: fy } });
    depCarryBanner(`🗑️ Saved SLM schedule for F.Y. ${escHtml(fy)} deleted.`, '');
    depStatus('✅ Saved schedule deleted.', 'success');
  } catch (err) {
    depStatus('❌ Could not delete: ' + escHtml(err.message), 'error');
  }
}

function depSlmReset() {
  depSlmRows = [];
  depSlmApplyAdditionLines([]);
  depSlmRender();
  depCarryBanner('');
  depStatus('', 'info');
}

// ════════════════════════════════════════════
//  IMPORT — seed the grid from an uploaded "Dep as Books" sheet. Header-mapped by
//  keyword (tolerant of the firm's inconsistent layouts); rows matched to classes
//  by particular text. Best-effort: whatever it can read, it fills for review.
// ════════════════════════════════════════════
function depSlmImport(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      // Prefer a sheet named like "dep as books"; else the first.
      const name = wb.SheetNames.find(n => /dep.*book|book.*dep|as book/i.test(n)) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      const norm = s => String(s || '').toLowerCase().replace(/[\s\r\n]+/g, ' ').trim();
      // Locate header row (has "particular" and something cost/wdv-ish).
      let hIdx = -1;
      for (let i = 0; i < Math.min(rows.length, 12); i++) {
        const joined = rows[i].map(norm).join('|');
        if (/particular/.test(joined) && /(cost|written down|wdv|opening)/.test(joined)) { hIdx = i; break; }
      }
      if (hIdx < 0) { depStatus(`⚠️ Couldn't find a recognizable header row in ${escHtml(file.name)}. Expected a "Dep as Books" sheet.`, 'info'); input.value = ''; return; }
      const hdr = rows[hIdx].map(norm);
      const col = (...keys) => hdr.findIndex(h => keys.some(k => h.includes(k)));
      const cParticular = col('particular');
      const cDate = col('date of use', 'date');
      const cLife = col('useful life', 'life');
      const cCost = col('original cost', 'orginal cost', 'cost');
      const cOpenWdv = col('opening written down', 'opening wdv', 'written down');
      const cOpenDep = col('opening dep');
      const cDelDep = col('deletion of dep');
      const cDel = col('deletion');

      const imported = [];
      for (let i = hIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const particular = cParticular >= 0 ? String(row[cParticular] || '').trim() : '';
        const clsText = norm((row[0] || '') + ' ' + particular);
        if (!particular && !clsText) continue;
        if (/^total|grand total/.test(clsText)) continue;         // skip subtotal / grand-total rows
        const cls = depSlmClasses().find(c => c.key !== 'land' ? c.kw.some(k => clsText.includes(k)) : false)
                 || depSlmClasses().find(c => c.kw.some(k => clsText.includes(k)));
        const origCost = cCost >= 0 ? depParse(row[cCost]) : 0;
        const openWdv = cOpenWdv >= 0 ? depParse(row[cOpenWdv]) : 0;
        if (!cls && !origCost && !openWdv) continue;               // nothing usable
        imported.push({
          uid: ++depSlmSeq,
          classKey: (cls || depSlmClasses()[1] || {}).key || '',
          particular: particular || (cls ? cls.name : ''),
          dateOfUse: cDate >= 0 ? depSlmCleanDate(row[cDate]) : '',
          disposalDate: '',
          life: cLife >= 0 ? (depParse(row[cLife]) || '') : '',
          remainDays: '',
          origCost: origCost || '',
          openWDV: openWdv || '',
          openDep: cOpenDep >= 0 ? (depParse(row[cOpenDep]) || '') : '',
          delCost: cDel >= 0 ? (depParse(row[cDel]) || '') : '',
          delDep: cDelDep >= 0 ? (depParse(row[cDelDep]) || '') : '',
          impairment: '',
        });
      }
      if (!imported.length) { depStatus(`⚠️ Read ${escHtml(file.name)} but found no asset rows to import.`, 'info'); input.value = ''; return; }
      depSlmRows = imported;
      depSlmRender();
      depStatus(`✅ Imported ${imported.length} asset line(s) from ${escHtml(file.name)}. Review classes, dates and useful lives, then Save or Generate.`, 'success');
    } catch (err) {
      depStatus('❌ Could not read that file: ' + escHtml(err.message), 'error');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

// Excel date cells arrive as serials or strings; keep B.S. strings as-is, ignore serials.
function depSlmCleanDate(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  return /[\/\-.]/.test(s) && /\d{4}/.test(s) ? s : '';
}

// ════════════════════════════════════════════
//  EXCEL GENERATION — one workbook, two sheets ("Dep as Books" grouped by class
//  with subtotals + a Grand Total, and "3.1 PPE" the class-column note). Faithful
//  merges / borders / accounting format, LIVE formulas, an internal Check column,
//  and the PPE↔Grand-Total tie-out.
// ════════════════════════════════════════════
async function depSlmGenerateExcel() {
  if (!window.ExcelJS) { depStatus('❌ Excel engine not loaded — reload the page and try again.', 'error'); return; }
  if (!depSlmRows.length) { depStatus('⚠️ Add at least one asset before generating.', 'info'); return; }
  depSlmRecalc();
  const company = document.getElementById('dep-company').value.trim();
  const fyLbl = document.getElementById('dep-fy').value.trim();
  const fyStart = depFyStartYear(fyLbl);
  const openLbl = fyStart != null ? `1st Shrawan, ${fyStart}` : 'Opening';
  const closeLbl = fyStart != null ? `End Ashadh, ${fyStart + 1}` : 'Closing';

  const wb = new ExcelJS.Workbook();
  const MONEY = '#,##0.00;(#,##0.00);"–"';
  const NAVY = 'FF0B1F3D';
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const HEADFILL = 'FFF3F5FB';
  const TOTFILL = 'FFEEF1FA';

  // ───────────── Sheet 1: Dep as Books ─────────────
  const ws = wb.addWorksheet('Dep as Books');
  ws.columns = [
    { width: 20 }, { width: 26 }, { width: 12 }, { width: 8 }, { width: 8 }, { width: 12 },
    { width: 15 }, { width: 15 }, { width: 13 }, { width: 12 }, { width: 15 },
    { width: 14 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 15 }, { width: 15 }, { width: 8 },
  ];
  // Columns: A class B particular C dateUse D days E life F remDays
  //   G OrigCost H OpenWDV I Addition J DelCost K Balance
  //   L OpenDep M Charge N DelDep O Impair P TotalDep Q ClosingWDV R Check
  ws.mergeCells('A1:R1');
  ws.getCell('A1').value = company || 'Depreciation as per Books (SLM)';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:R2');
  ws.getCell('A2').value = 'Statement of PPE and Depreciation — As per Books (SLM)' + (fyLbl ? '   |   F.Y. ' + fyLbl : '');
  ws.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };

  const H = 4;
  const heads = ['Pool / Class', 'Particulars', 'Date of Use', 'Days', 'Life (yr)', 'Rem. Life (days)',
    'Original Cost (A)', 'Opening WDV (B)', 'Addition (C)', 'Deletion Cost (D)', 'Balance (B+C−D)',
    'Opening Dep (F)', 'Depreciation (G)', 'Deletion Dep (H)', 'Impairment', 'Total Dep (I)', 'Closing WDV (J)', 'Check'];
  heads.forEach((t, i) => {
    const c = ws.getRow(H).getCell(i + 1);
    c.value = t; c.font = { bold: true, size: 9.5, color: { argb: NAVY } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADFILL } };
    c.border = box;
  });
  ws.getRow(H).height = 30;

  const money = (cell, formula, result) => { cell.value = formula != null ? { formula, result: result || 0 } : (result || 0); cell.numFmt = MONEY; };
  // Total-row columns → the computed field each SUMs (so cached results match the formulas).
  const SUMCOLS = { G: 'origCost', H: 'openWDV', I: 'addition', J: 'delCost', K: 'balance', L: 'openDep', M: 'charge', N: 'delDep', O: 'impair', P: 'totalDep', Q: 'closingWDV' };
  let r = H + 1;
  const classTotalRows = [];
  const grand = {}; Object.values(SUMCOLS).forEach(f => grand[f] = 0);

  depSlmClasses().forEach(cls => {
    const rowsOfCls = depSlmRows.filter(x => x.classKey === cls.key);
    if (!rowsOfCls.length) return;
    const firstDataRow = r;
    const clsSum = {}; Object.values(SUMCOLS).forEach(f => clsSum[f] = 0);
    rowsOfCls.forEach(x => {
      const c = x._c || depSlmComputeLine(x, fyStart);
      ws.getCell(`A${r}`).value = cls.name;
      ws.getCell(`B${r}`).value = x.particular || '';
      ws.getCell(`C${r}`).value = x.dateOfUse || '';
      ws.getCell(`D${r}`).value = c.days || 0;
      ws.getCell(`E${r}`).value = c.life || 0;
      ws.getCell(`F${r}`).value = c.remainDays || 0;
      money(ws.getCell(`G${r}`), null, c.origCost);
      money(ws.getCell(`H${r}`), null, c.openWDV);
      money(ws.getCell(`I${r}`), null, c.addition);
      money(ws.getCell(`J${r}`), null, c.delCost);
      money(ws.getCell(`K${r}`), `H${r}+I${r}-(J${r}-N${r})`, c.balance);
      money(ws.getCell(`L${r}`), null, c.openDep);
      // Depreciation: live formula for depreciable classes, hard 0 for Land.
      if (c.depreciable) money(ws.getCell(`M${r}`), `IF(F${r}>0,MIN(K${r},K${r}*D${r}/F${r}),0)`, c.charge);
      else money(ws.getCell(`M${r}`), null, 0);
      money(ws.getCell(`N${r}`), null, c.delDep);
      money(ws.getCell(`O${r}`), null, c.impair);
      money(ws.getCell(`P${r}`), `L${r}+M${r}+O${r}-N${r}`, c.totalDep);
      money(ws.getCell(`Q${r}`), `K${r}-M${r}-O${r}`, c.closingWDV);
      // Check: (OrigCost − DelCost) − TotalDep should equal Closing WDV.
      ws.getCell(`R${r}`).value = { formula: `IF(ABS((G${r}-J${r})-P${r}-Q${r})<0.02,"OK","CHK")`, result: c.checkOk ? 'OK' : 'CHK' };
      ws.getCell(`R${r}`).alignment = { horizontal: 'center' };
      ['C', 'D', 'E', 'F'].forEach(cl => ws.getCell(`${cl}${r}`).alignment = { horizontal: 'center' });
      ws.getCell(`B${r}`).alignment = { horizontal: 'left' };
      Object.values(SUMCOLS).forEach(f => { clsSum[f] += c[f] || 0; });
      r++;
    });
    // Class subtotal
    const lastDataRow = r - 1;
    ws.getCell(`B${r}`).value = cls.name + ' — Total';
    ws.getCell(`B${r}`).font = { bold: true, color: { argb: NAVY } };
    Object.entries(SUMCOLS).forEach(([cl, f]) => {
      const cell = ws.getCell(`${cl}${r}`);
      cell.value = { formula: `SUM(${cl}${firstDataRow}:${cl}${lastDataRow})`, result: clsSum[f] };
      cell.numFmt = MONEY; cell.font = { bold: true, color: { argb: NAVY } };
      grand[f] += clsSum[f];
    });
    ws.getRow(r).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTFILL } }; });
    classTotalRows.push(r);
    r++;
  });

  // Grand Total (sum of class-total rows)
  const gtRow = r;
  ws.getCell(`B${gtRow}`).value = 'Grand Total';
  ws.getCell(`B${gtRow}`).font = { bold: true, size: 11, color: { argb: NAVY } };
  Object.entries(SUMCOLS).forEach(([cl, f]) => {
    const cell = ws.getCell(`${cl}${gtRow}`);
    cell.value = { formula: classTotalRows.length ? classTotalRows.map(tr => `${cl}${tr}`).join('+') : '0', result: grand[f] };
    cell.numFmt = MONEY; cell.font = { bold: true, size: 11, color: { argb: NAVY } };
  });
  ws.getRow(gtRow).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE3F2' } }; });

  // Borders across the whole grid
  for (let rr = H; rr <= gtRow; rr++) for (let cc = 1; cc <= 18; cc++) ws.getRow(rr).getCell(cc).border = box;

  // Optional Addition-details block below the grid (mirrors the Income-Tax sheet) —
  // the schedule already itemizes assets, but the working paper wants the year's
  // purchases listed and footed on their own. Only lines dated INSIDE the selected
  // F.Y. are listed: they are exactly the ones the schedule counts as an addition,
  // so this block's total always equals the grid's Addition grand total.
  const addLines = depSlmCollectAdditions().filter(l => depSlmAcquiredThisFy(l.date, fyStart));
  if (addLines.length) {
    let ar = gtRow + 2;
    ws.mergeCells(`B${ar}:E${ar}`);
    ws.getCell(`B${ar}`).value = 'Addition details';
    ws.getCell(`B${ar}`).font = { bold: true, color: { argb: NAVY } };
    ar++;
    ['Date (B.S.)', 'Class', 'Particular', 'Amount'].forEach((t, i) => {
      const cell = ws.getRow(ar).getCell(2 + i);
      cell.value = t; cell.font = { bold: true }; cell.border = box;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADFILL } };
    });
    const firstAdd = ar + 1;
    addLines.forEach(l => {
      ar++;
      const cls = depSlmClass(l.classKey);
      [l.date, cls ? cls.name : '', l.particular, l.amount].forEach((v, i) => {
        const cell = ws.getRow(ar).getCell(2 + i);
        cell.value = v; cell.border = box;
        if (i === 3) cell.numFmt = MONEY;
      });
    });
    ar++;
    ws.getCell(`D${ar}`).value = 'Total';
    const totCell = ws.getCell(`E${ar}`);
    totCell.value = { formula: `SUM(E${firstAdd}:E${ar - 1})`, result: addLines.reduce((a, l) => a + l.amount, 0) };
    totCell.numFmt = MONEY;
    ['B', 'C', 'D', 'E'].forEach(cl => {
      const cell = ws.getCell(`${cl}${ar}`);
      cell.border = box; cell.font = { bold: true, color: { argb: NAVY } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTFILL } };
    });
  }

  // ───────────── Sheet 2: 3.1 PPE note ─────────────
  const ps = wb.addWorksheet('3.1 PPE');
  const by = depSlmPpeAggregate(fyStart);
  const cols = depSlmClasses().filter(c => { const b = by[c.key]; return b.costOpen || b.add || b.dispCost || b.depOpen || b.charge || b.closeWDV; });
  const nCols = cols.length;
  ps.columns = [{ width: 40 }].concat(Array.from({ length: nCols + 1 }, () => ({ width: 16 })));
  const lastCol = nCols + 2; // 1 label + nCols classes + 1 total
  const L = n => { let s = ''; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };

  ps.mergeCells(1, 1, 1, lastCol);
  ps.getCell('A1').value = '3.1  Property, Plant and Equipment' + (fyLbl ? '   |   F.Y. ' + fyLbl : '') + '   (Figures in NPR)';
  ps.getCell('A1').font = { bold: true, size: 12, color: { argb: NAVY } };

  // Header
  const PH = 3;
  ps.getCell(PH, 1).value = 'Particulars';
  cols.forEach((c, i) => ps.getCell(PH, 2 + i).value = c.name);
  ps.getCell(PH, 2 + nCols).value = 'Total';
  for (let cc = 1; cc <= lastCol; cc++) {
    const c = ps.getCell(PH, cc);
    c.font = { bold: true, size: 10, color: { argb: NAVY } };
    c.alignment = { horizontal: cc === 1 ? 'left' : 'center', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADFILL } };
    c.border = box;
  }

  let pr = PH + 1;
  const sectionRow = (label) => { ps.mergeCells(pr, 1, pr, lastCol); const c = ps.getCell(pr, 1); c.value = label; c.font = { bold: true, italic: true, color: { argb: NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FE' } }; for (let cc = 1; cc <= lastCol; cc++) ps.getCell(pr, cc).border = box; pr++; };
  const valueRow = (label, pick, strong) => {
    ps.getCell(pr, 1).value = label;
    ps.getCell(pr, 1).font = strong ? { bold: true } : {};
    let sum = 0;
    cols.forEach((c, i) => { const v = pick(by[c.key]); const cell = ps.getCell(pr, 2 + i); cell.value = v; cell.numFmt = MONEY; if (strong) cell.font = { bold: true }; sum += v; });
    const totCell = ps.getCell(pr, 2 + nCols);
    totCell.value = { formula: `SUM(${L(2)}${pr}:${L(1 + nCols)}${pr})`, result: sum };
    totCell.numFmt = MONEY; totCell.font = strong ? { bold: true, color: { argb: NAVY } } : { color: { argb: NAVY } };
    for (let cc = 1; cc <= lastCol; cc++) ps.getCell(pr, cc).border = box;
    pr++;
  };
  // Formula rows reference the leaf rows in the same sheet by row number; `resultFor`
  // caches the computed value per class so the file reads correctly before recalc.
  const formulaRow = (label, fn, resultFor, strong) => {
    ps.getCell(pr, 1).value = label;
    ps.getCell(pr, 1).font = strong ? { bold: true } : {};
    const results = cols.map(c => resultFor(by[c.key]));
    const vals = results.concat([results.reduce((a, b) => a + b, 0)]);
    for (let i = 0; i < nCols + 1; i++) {
      const cell = ps.getCell(pr, 2 + i);
      cell.value = { formula: fn(L(2 + i)), result: vals[i] };
      cell.numFmt = MONEY; if (strong) cell.font = { bold: true, color: { argb: NAVY } };
    }
    for (let cc = 1; cc <= lastCol; cc++) ps.getCell(pr, cc).border = box;
    pr++;
  };

  sectionRow('Cost');
  const rCostOpen = pr; valueRow(`Balance as at ${openLbl}`, b => b.costOpen);
  const rAdd = pr; valueRow('Additions', b => b.add);
  const rDisp = pr; valueRow('Disposals', b => b.dispCost);
  const rCostClose = pr; formulaRow(`Balance at ${closeLbl}`, c => `${c}${rCostOpen}+${c}${rAdd}-${c}${rDisp}`, b => b.costOpen + b.add - b.dispCost, true);
  sectionRow('Depreciation & Impairment');
  const rDepOpen = pr; valueRow(`Balance as at ${openLbl}`, b => b.depOpen);
  const rCharge = pr; valueRow('Depreciation charged for the year', b => b.charge);
  const rImp = pr; valueRow('Impairment adjustment', b => b.impair);
  const rDispDep = pr; valueRow('Disposals', b => b.dispDep);
  const rDepClose = pr; formulaRow(`Balance at ${closeLbl}`, c => `${c}${rDepOpen}+${c}${rCharge}+${c}${rImp}-${c}${rDispDep}`, b => b.depOpen + b.charge + b.impair - b.dispDep, true);
  sectionRow('Carrying Amount');
  formulaRow(`As at ${openLbl}`, c => `${c}${rCostOpen}-${c}${rDepOpen}`, b => b.costOpen - b.depOpen, true);
  formulaRow(`As at ${closeLbl}`, c => `${c}${rCostClose}-${c}${rDepClose}`, b => (b.costOpen + b.add - b.dispCost) - (b.depOpen + b.charge + b.impair - b.dispDep), true);

  try {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = ('Depreciation as per Books (SLM) ' + (company ? company + ' ' : '') + (fyLbl || '')).trim() + '.xlsx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'depreciation', clientName: company || null });
    depStatus('✅ Excel generated (Dep as Books + 3.1 PPE) and downloaded.', 'success');
  } catch (err) {
    depStatus('❌ Could not generate the file: ' + escHtml(err.message), 'error');
  }
}
