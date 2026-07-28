// ════════════════════════════════════════════════════════════════
//  FINANCIAL STATEMENT  (Automation Hub → Financial Statement)
//  Builds a client's full NFRS statement set from last year's statement
//  plus this year's summary figures A–N. Spec: "Work Performed (9).xlsx",
//  sheet `provisional.Audited`. See CLAUDE.md §5.18.
//
//  This file owns the UI only. All arithmetic is in finStatementEngine.js
//  (DOM-free, Node-verifiable) and all output in finStatementExport.js.
// ════════════════════════════════════════════════════════════════

ModuleRegistry.register({ id: 'finStatement', group: 'main', buttonId: null, panelId: 'tab-finStatement-panel' });

// ── state ──
let fsPy = null;             // parsed prior-year model
let fsPyIssues = [];
let fsResult = null;         // last FinStatementEngine.build() output
let fsReport = null;         // last fsxBuildReport() output
let fsSelectedClient = null;
let fsSheetView = 'SFP';
let fsInitDone = false;
let fsRecalcTimer = null;
let fsSavedId = null;
let fsDetails = { sales: null, purchase: null };
let fsPpeInput = [];         // per-class movement rows
let fsLevers = {};           // user overrides
let fsExpenseEdits = null;   // edited expense line arrays
let fsFigures = {};          // the current-year figures A–N

const fsEl = (id) => document.getElementById(id);
const fsStatus = (msg, type) => showStatus(msg, type, 'fs-status-area');
const fsNum = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };

// ── keeping inputs alive across a re-render ──
// The debounced re-solve rebuilds the levers, fixed-asset and expense grids.
// That detaches whichever input the user is typing in and drops focus to
// <body>, so every keystroke after the first was lost and the fields read as
// uneditable. Each editable input carries a stable `data-fsk`; this restores
// focus, the caret, and the RAW in-progress text — a half-typed "1234." must
// not be normalised out from under the caret.
function fsPreserveFocus(render) {
  const el = document.activeElement;
  const key = el && el.dataset ? el.dataset.fsk : null;
  const raw = key ? el.value : null;
  let start = null, end = null;
  if (key) { try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { /* unsupported input type */ } }

  render();

  if (!key) return;
  const next = document.querySelector('[data-fsk="' + key.replace(/"/g, '\\"') + '"]');
  if (!next) return;
  if (raw != null) next.value = raw;
  next.focus();
  if (start != null) { try { next.setSelectionRange(start, end); } catch (e) { /* unsupported */ } }
}

// Money fields are text + inputmode="decimal" rather than type="number": it
// lets the caret be restored after a re-render (number inputs have no
// selection API), and lets the user paste a comma-grouped figure.
// `width` is a pixel number, or omit it for a full-width field in a form-grid.
function fsMoneyInput(key, value, handler, width) {
  const v = (value == null || value === '' || !isFinite(value)) ? '' : value;
  const w = (width == null) ? '100%' : width + 'px';
  return `<input type="text" inputmode="decimal" data-fsk="${escHtml(key)}"
    style="width:${w};text-align:right;" value="${escHtml(String(v))}"
    oninput="${handler}" />`;
}

// The figures A–N, in the order the spec lists them.
const FS_FIGURES = [
  { k: 'A',  label: 'Sales',                                     hint: 'Revenue from operations' },
  { k: 'B',  label: 'Closing Stock',                             hint: 'Becomes note 3.12 closing + Inventories' },
  { k: 'C',  label: 'Profit',                                    hint: 'Profit before tax — purchases solves to hit it' },
  { k: 'E1', label: 'Interest — Term / PWC / HP',                hint: 'Note 3.14' },
  { k: 'E2', label: 'Interest — OD / CC / STL / DL',             hint: 'Note 3.14' },
  { k: 'F',  label: 'Capital Addition during Year',              hint: 'Flows through the SOCE' },
  { k: 'G',  label: 'OD / CC / Short Term Loan',                 hint: 'Current borrowings' },
  { k: 'H',  label: 'Term Loan',                                 hint: 'Non-current' },
  { k: 'I',  label: 'Permanent WC Loan',                         hint: 'Non-current' },
  { k: 'J',  label: 'HP Loan',                                   hint: 'Non-current' },
  { k: 'K',  label: 'Advance Tax',                               hint: 'Note 3.3' },
  { k: 'L',  label: 'VAT Receivable / (Payable)',                hint: 'Negative means payable' },
  { k: 'M',  label: 'Depreciation as per SLM',                   hint: 'From the Depreciation module' },
  { k: 'N',  label: 'Depreciation as per Income Tax',            hint: 'From the Depreciation module' },
];

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

function fsInit() {
  if (fsInitDone) { fsRenderReturnTypes(); return; }
  fsInitDone = true;

  fsPopulateFy();
  fsRenderReturnTypes();

  // Reads the same window.clientsList the Clients directory loads. The config
  // keys are getList/renderItem/onSelect — see js/core/searchEngine.js.
  SearchEngine.attachAutocomplete(fsEl('fs-client-search'), fsEl('fs-client-autocomplete'), {
    getList: () => window.clientsList,
    keys: ['name', 'pan'],
    // Digit-agnostic: 45 client records carry Devanagari PANs, so both the
    // query and the indexed PAN are normalised before matching.
    normalizeQuery: (q) => NepaliLocale.toEnglishDigits(q || ''),
    normalizeItem: (c) => Object.assign({}, c, { pan: NepaliLocale.toEnglishDigits(c.pan || '') }),
    renderItem: c => `
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    `,
    onSelect: fsPickClient,
  });

  fsShowSection('setup');
}

function fsPopulateFy() {
  const sel = fsEl('fs-fy');
  if (!sel) return;
  const today = NepaliLocale.todayBs();
  const cur = today.year;
  const opts = [];
  for (let y = cur - 4; y <= cur + 2; y++) opts.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  sel.innerHTML = opts.map(o => `<option value="${o}">${o}</option>`).join('');
  // Default to the fiscal year just CLOSED — a statement is prepared after year
  // end. bsFyDash knows where the Shrawan boundary falls, so this is right in
  // Ashadh as well as in Shrawan.
  const curFy = NepaliLocale.bsFyDash(NepaliLocale.todayBsStr()) || opts[4];
  const y = parseInt(String(curFy).slice(0, 4), 10) - 1;
  const closed = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  sel.value = opts.includes(closed) ? closed : (opts[4] || opts[opts.length - 1]);
  sel.onchange = () => { fsLoadDepreciation(); fsRecalcDebounced(); };
}

// The return types on offer depend on entity and turnover (Work Performed
// rows 43–57): presumptive D1/D2 exist only for proprietorships, and only
// within their turnover bands.
function fsRenderReturnTypes() {
  const sel = fsEl('fs-return-type');
  if (!sel) return;
  const entity = (fsEl('fs-entity') || {}).value || 'private';
  const sales = fsNum(fsFigures.A);
  const allowed = FinStatementEngine.allowedReturnTypes(entity, sales);
  const LABEL = { D1: 'D1 — presumptive', D2: 'D2 — presumptive', D3: 'D3', D3V: 'D3 (Voluntary)' };
  const prev = sel.value;
  sel.innerHTML = allowed.map(a => `<option value="${a}">${LABEL[a] || a}</option>`).join('');
  if (allowed.includes(prev)) sel.value = prev;
  fsEl('fs-localbody-group').style.display = sel.value === 'D1' ? '' : 'none';
}

function fsOnEntityChange() {
  fsRenderReturnTypes();
  // "Non Sign" is for proprietorships only (spec note at F17).
  const aud = fsEl('fs-auditor');
  if (aud.value === 'nonsign' && fsEl('fs-entity').value !== 'proprietorship') aud.value = 'SA';
  fsRecalcDebounced();
}

function fsOnBasisChange() { fsRecalcDebounced(); }

function fsOnAuditorChange() {
  const v = fsEl('fs-auditor').value;
  fsEl('fs-auditor-other-group').style.display = v === 'other' ? '' : 'none';
  if (v === 'nonsign' && fsEl('fs-entity').value !== 'proprietorship') {
    fsStatus('“Non Sign” applies to proprietorship firms only.', 'error');
    fsEl('fs-auditor').value = 'SA';
    return;
  }
  fsRecalcDebounced();
}

// Everything on this screen — the uploaded prior year, the sales/purchase
// details, the A–N figures, the PPE movement rows and the lever overrides —
// belongs to the selected client. clear() runs before every load so none of
// it can survive into the next client's statement.
const fsScope = WorkflowEngine.createClientScope({
  clear(reason) {
    if (reason === 'client') {
      fsSelectedClient = null;
      ['fs-company', 'fs-pan', 'fs-address'].forEach(id => { fsEl(id).value = ''; });
    }
    const hadUpload = !!fsPy || !!fsDetails.sales || !!fsDetails.purchase;
    fsPy = null; fsPyIssues = [];
    fsResult = null; fsReport = null; fsSavedId = null;
    fsDetails = { sales: null, purchase: null };
    fsPpeInput = []; fsLevers = {}; fsExpenseEdits = null;
    fsFigures = {};
    ['fs-py-file', 'fs-sales-file', 'fs-purchase-file'].forEach(id => {
      const el = fsEl(id); if (el) el.value = '';
    });
    fsRenderPySummary();
    fsRenderFigures();
    fsShowSection('setup');
    fsStatus(hadUpload
      ? "Cleared the previous client's uploaded statement and figures — upload this client's files to continue."
      : '', 'info');
  },
  load(it) {
    fsSelectedClient = it;
    fsEl('fs-company').value = it.name || '';
    fsEl('fs-pan').value = NepaliLocale.toEnglishDigits(it.pan || '');
    fsEl('fs-address').value = it.address || '';
    fsEl('fs-client-search').value = it.name || '';

    // entity_type is free text; the shared map is the one authority (§16 — a new
    // spelling silently kills auto-fill in every module that reads it). Both of
    // these ASSIGN unconditionally: an `if (mapped)` would leave the previous
    // client's entity/return type standing when this one has none on file.
    const profile = (window.CLIENT_ENTITY_TO_REP_PROFILE || {})[String(it.entity_type || '').toLowerCase().trim()];
    const toEntity = {
      private_company: 'private', public_company: 'public',
      partnership: 'partnership', proprietorship: 'proprietorship',
    };
    fsEl('fs-entity').value = (profile && toEntity[profile]) || 'private';

    // The Type-of-Return options are rendered FROM the entity type, so the
    // entity has to be applied first — setting the return type before that
    // rebuild just gets discarded by it.
    fsRenderReturnTypes();

    // it_return_type carries the firm's own classification ('D1/D2', 'D-03', …).
    // An option the entity isn't allowed to file is silently ignored by the
    // select, leaving the allowed default — which is the right answer.
    const rt = String(it.it_return_type || '').toUpperCase().replace(/[^0-9D/]/g, '');
    const wanted = /^D0?2$/.test(rt) ? 'D2' : 'D1';
    if (Array.from(fsEl('fs-return-type').options).some(o => o.value === wanted)) {
      fsEl('fs-return-type').value = wanted;
    }

    fsOnEntityChange();
    fsLoadDepreciation();
    fsStatus(`Client loaded: ${it.name}`, 'success');
  },
});

function fsPickClient(it) { fsScope.select(it); }

// Fiscal year changed. Only M and N are read from the database, so only they
// are dropped — an upload the user just made is NOT discarded over a change
// of year. Dropping them first is what stops the old year's depreciation
// standing when the new year has no saved schedule (fsLoadDepreciation
// returns early in that case).
function fsOnFyChange() {
  delete fsFigures.M;
  delete fsFigures.N;
  fsSyncFigureInputs('M');
  fsSyncFigureInputs('N');
  fsLoadDepreciation();
  fsRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  STEP 1 — uploads
// ════════════════════════════════════════════════════════════════

async function fsHandlePyFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  fsStatus('Reading the prior-year statement…', 'searching');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const { py, issues } = FinStatementEngine.parsePriorYear(wb, XLSX);
    fsPy = py;
    fsPyIssues = issues;
    fsExpenseEdits = null;
    fsPpeInput = [];

    if (!fsEl('fs-company').value && py.company.name) fsEl('fs-company').value = py.company.name;
    if (!fsEl('fs-address').value && py.company.address) fsEl('fs-address').value = py.company.address;

    fsRenderPySummary();
    if (issues.some(i => i.level === 'error')) {
      fsStatus('The prior-year file is missing figures the statement needs — see below.', 'error');
      return;
    }
    fsSeedPpe();
    AuditLog.record('finstatement_py_parsed', {
      module: 'finStatement', clientName: fsEl('fs-company').value, status: 'success',
      detail: { otherExpenseLines: py.otherItems.length, ppeClasses: py.ppe.classes.length },
    });
    fsStatus('Prior-year statement read.', 'success');
  } catch (e) {
    fsStatus('Could not read that workbook: ' + e.message, 'error');
  }
}

function fsRenderPySummary() {
  const box = fsEl('fs-py-summary');
  if (!fsPy) { box.innerHTML = ''; return; }
  const p = fsPy;
  const f = (v) => fsFmt(v);
  const rows = [
    ['Company', escHtml(p.company.name || '—')],
    ['Sales (revenue from operations)', f(p.soi.revenueOps)],
    ['Closing stock → this year&rsquo;s opening', f(p.sfp.inventories)],
    ['Profit before tax', f(p.soi.pbt)],
    ['Share capital', f(p.sfp.shareCapital)],
    ['Reserves', f(p.sfp.reserves)],
    ['Cash &amp; bank', f(p.sfp.cash)],
    ['Trade &amp; other payables (settled in cash)', f(p.sfp.payables)],
    ['Fixed assets — carrying amount', f(p.sfp.ppe)],
    ['Salary (grows 5%)', f(p.salary)],
    ['Audit fee (held flat)', f(p.auditFee)],
    ['Rent (held flat)', f(p.rent)],
    ['Other-expense lines', String(p.otherItems.length)],
    ['Fixed-asset classes', String(p.ppe.classes.length)],
  ];
  let html = '<table class="app-table" style="width:100%;font-size:13px;"><tbody>';
  for (const [k, v] of rows) html += `<tr><td style="color:var(--text-muted);">${k}</td><td style="text-align:right;font-variant-numeric:tabular-nums;">${v}</td></tr>`;
  html += '</tbody></table>';
  if (fsPyIssues.length) html += fsIssuesHtml(fsPyIssues);
  box.innerHTML = html;
}

// The detail sheets are read as raw rows: the layout varies per client and the
// only figure the statements need is the purchase closing-balance total.
async function fsHandleDetailFile(input, which) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    fsDetails[which] = { name: file.name, rows };
    fsRenderDetailSummary();
    fsRecalcDebounced();
  } catch (e) {
    fsStatus(`Could not read the ${which} detail file: ` + e.message, 'error');
  }
}

// Total of the closing-balance column. The header row is found by label so a
// shifted layout still resolves, and the total row the client may already
// carry is skipped so it isn't counted twice.
function fsDetailTotal(det) {
  if (!det || !det.rows) return 0;
  let hdr = -1, balCol = -1;
  for (let r = 0; r < Math.min(det.rows.length, 30); r++) {
    const row = det.rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (/cl\.?\s*balance|closing\s*balance/i.test(String(row[c] || ''))) { hdr = r; balCol = c; break; }
    }
    if (hdr !== -1) break;
  }
  if (hdr === -1) return 0;
  let total = 0;
  for (let r = hdr + 1; r < det.rows.length; r++) {
    const row = det.rows[r] || [];
    const label = String(row.find(v => typeof v === 'string') || '');
    if (/^\s*(grand\s*)?total/i.test(label)) continue;
    const v = parseFloat(String(row[balCol] == null ? '' : row[balCol]).replace(/,/g, ''));
    if (isFinite(v)) total += v;
  }
  return Math.round(total * 100) / 100;
}

function fsRenderDetailSummary() {
  const parts = [];
  for (const w of ['sales', 'purchase']) {
    const d = fsDetails[w];
    if (!d) continue;
    const t = fsDetailTotal(d);
    parts.push(`<div style="font-size:13px;"><b>${w === 'sales' ? 'Sales' : 'Purchase'}</b> — ${escHtml(d.name)} · ${d.rows.length} rows · closing balance total ${fsFmt(t)}${w === 'purchase' ? ' <span style="color:var(--text-muted);">→ Trade Payables</span>' : ''}</div>`);
  }
  fsEl('fs-detail-summary').innerHTML = parts.join('');
}

// M and N come from the Depreciation module's saved schedules — the template
// annotates both rows "As per SLM Module" / "As Per Depreciation for Income Tax
// Module". Auto-filled when a schedule exists, editable when it doesn't.
async function fsLoadDepreciation() {
  if (!fsSelectedClient || !window.sb) return;
  const fy = fsEl('fs-fy').value;
  try {
    const { data, error } = await window.sb.from('depreciation_schedules')
      .select('scheme, pools').eq('client_id', fsSelectedClient.id).eq('fiscal_year', fy);
    if (error || !data || !data.length) return;
    const sum = (pools, keys) => {
      if (!Array.isArray(pools)) return 0;
      return pools.reduce((s, p) => {
        for (const k of keys) if (p && typeof p[k] === 'number') return s + p[k];
        return s;
      }, 0);
    };
    const slm = data.find(d => d.scheme === 'slm');
    const it = data.find(d => d.scheme === 'normal' || d.scheme === 'special');
    let filled = [];
    if (slm) {
      const v = sum(slm.pools, ['_depreciation', 'depreciation']);
      if (v) { fsSetFigure('M', v); filled.push('M (SLM)'); }
    }
    if (it) {
      const v = sum(it.pools, ['depreciation', '_depreciation']);
      if (v) { fsSetFigure('N', v); filled.push('N (Income Tax)'); }
    }
    if (filled.length) fsStatus(`Depreciation auto-filled from the saved schedule: ${filled.join(', ')}.`, 'success');
  } catch (e) { /* auto-fill is a convenience; never block the module on it */ }
}

function fsSetFigure(k, v) {
  fsFigures[k] = Math.round(v * 100) / 100;
  fsSyncFigureInputs(k);
}

// ════════════════════════════════════════════════════════════════
//  STEP 2 — figures, PPE movement, expense lines
// ════════════════════════════════════════════════════════════════

// The figures live in `fsFigures`, not in the DOM, because they are edited from
// two places — step 2 and the Levers panel — and two inputs bound to one value
// would drift apart.
function fsRenderFigures() {
  const grid = fsEl('fs-figures-grid');
  if (!grid) return;
  let html = '<div class="form-grid" style="grid-template-columns:repeat(3, 1fr); gap:14px;">';
  for (const f of FS_FIGURES) {
    html += `<div class="form-group">
      <label>${f.k}. ${escHtml(f.label)}</label>
      ${fsMoneyInput('fig2-' + f.k, fsFigures[f.k], `fsOnFigureInput('${f.k}', this.value)`)}
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${escHtml(f.hint)}</div>
    </div>`;
  }
  html += '</div>';
  html += `<div style="margin-top:12px;font-size:12px;color:var(--text-muted);">
    D. Tax is computed from the return type — see the Return of Income sheet in step 3.
    Leave every figure blank to lay out the statements with the comparative year only.</div>`;
  grid.innerHTML = html;
}

function fsOnFigureInput(k, v) {
  fsFigures[k] = (String(v).trim() === '') ? '' : fsNum(v);
  if (k === 'A') fsRenderReturnTypes();   // turnover changes which returns qualify
  fsSyncFigureInputs(k);
  fsRecalcDebounced();
}

// Mirror a figure into the other panel's input without touching the one being
// typed in (that would move the caret).
function fsSyncFigureInputs(k) {
  const active = document.activeElement;
  const v = fsFigures[k];
  const text = (v == null || v === '') ? '' : String(v);
  document.querySelectorAll(`[data-fsk="fig2-${k}"], [data-fsk="figL-${k}"]`).forEach(el => {
    if (el !== active) el.value = text;
  });
}

function fsSeedPpe() {
  const classes = window.DEP_SLM_CLASSES || [];
  const byKey = {};
  for (const c of ((fsPy && fsPy.ppe.classes) || [])) {
    const l = String(c.name).toLowerCase();
    const hit = classes.find(x => (x.kw || []).some(k => l.includes(k)));
    const key = hit ? hit.key : 'py:' + l.replace(/\s+/g, ' ').trim();
    byKey[key] = byKey[key] || { additions: 0, disposals: 0, depCharge: 0 };
    byKey[key].additions += c.additions || 0;
    byKey[key].disposals += c.disposals || 0;
  }
  // Movements start at zero — last year's additions are not this year's. Only
  // the class list is seeded.
  fsPpeInput = Object.keys(byKey).map(key => ({ key, additions: 0, disposals: 0, disposalDep: 0, depCharge: 0, impairment: 0 }));
  for (const c of classes) if (!fsPpeInput.some(p => p.key === c.key)) fsPpeInput.push({ key: c.key, additions: 0, disposals: 0, disposalDep: 0, depCharge: 0, impairment: 0 });
  fsRenderPpe();
}

function fsPpeClassName(key) {
  const c = (window.DEP_SLM_CLASSES || []).find(x => x.key === key);
  if (c) return c.name;
  return key.replace(/^py:/, '').replace(/\b\w/g, ch => ch.toUpperCase());
}

function fsRenderPpe() {
  const grid = fsEl('fs-ppe-grid');
  if (!grid) return;
  if (!fsPy) { grid.innerHTML = '<p style="font-size:13px;color:var(--text-muted);margin:0;">Upload the prior-year statement first.</p>'; return; }

  const pyByKey = {};
  for (const c of (fsPy.ppe.classes || [])) {
    const l = String(c.name).toLowerCase();
    const hit = (window.DEP_SLM_CLASSES || []).find(x => (x.kw || []).some(k => l.includes(k)));
    const key = hit ? hit.key : 'py:' + l.replace(/\s+/g, ' ').trim();
    pyByKey[key] = (pyByKey[key] || 0) + (c.carrying || 0);
  }

  let html = '<div class="table-wrap"><table class="app-table" style="font-size:13px;"><thead><tr>'
    + '<th>Class</th><th style="text-align:right;">Opening carrying</th><th style="text-align:right;">Additions</th>'
    + '<th style="text-align:right;">Disposals (cost)</th><th style="text-align:right;">Disposals (dep)</th>'
    + '<th style="text-align:right;">Depreciation charged</th></tr></thead><tbody>';
  fsPpeInput.forEach((p, i) => {
    const opening = pyByKey[p.key] || 0;
    html += `<tr><td>${escHtml(fsPpeClassName(p.key))}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${fsFmt(opening)}</td>
      ${['additions', 'disposals', 'disposalDep', 'depCharge'].map(fld =>
        `<td style="text-align:right;">${fsMoneyInput('ppe-' + p.key + '-' + fld, p[fld] || '', `fsPpeEdit(${i},'${fld}',this.value)`, 118)}</td>`).join('')}
      </tr>`;
  });
  html += '</tbody></table></div>';
  const charged = fsPpeInput.reduce((s, p) => s + fsNum(p.depCharge), 0);
  const M = fsNum(fsFigures.M);
  const ok = Math.abs(charged - M) < 0.5;
  html += `<div style="margin-top:10px;font-size:12.5px;">Depreciation charged: <b style="font-variant-numeric:tabular-nums;">${fsFmt(charged)}</b>
     &nbsp;·&nbsp; figure M: <b style="font-variant-numeric:tabular-nums;">${fsFmt(M)}</b>
     &nbsp;<span style="color:${ok ? 'var(--green-dk)' : 'var(--red-dk)'};font-weight:700;">${ok ? 'ties' : 'does not tie'}</span>
     <button class="btn btn-outline" style="margin-left:10px;padding:3px 10px;font-size:12px;" onclick="fsSpreadDepreciation()">Allocate M by opening balance</button></div>`;
  grid.innerHTML = html;
}

function fsPpeEdit(i, field, v) {
  if (!fsPpeInput[i]) return;
  fsPpeInput[i][field] = fsNum(v);
  fsRecalcDebounced();
}

// Convenience only, and it says so: splitting one total across classes by
// opening balance is an allocation, not the SLM module's own per-asset answer.
function fsSpreadDepreciation() {
  const M = fsNum(fsFigures.M);
  if (!M || !fsPy) { fsStatus('Enter figure M first.', 'error'); return; }
  const pyByKey = {};
  for (const c of (fsPy.ppe.classes || [])) {
    const l = String(c.name).toLowerCase();
    const hit = (window.DEP_SLM_CLASSES || []).find(x => (x.kw || []).some(k => l.includes(k)));
    const key = hit ? hit.key : 'py:' + l.replace(/\s+/g, ' ').trim();
    if (hit && hit.depreciable === false) continue;   // Land never depreciates
    pyByKey[key] = (pyByKey[key] || 0) + (c.carrying || 0);
  }
  const total = Object.values(pyByKey).reduce((s, v) => s + v, 0);
  if (!total) { fsStatus('The prior-year note carries no depreciable opening balance to allocate against.', 'error'); return; }
  let assigned = 0;
  const keys = Object.keys(pyByKey);
  fsPpeInput.forEach(p => { p.depCharge = 0; });
  keys.forEach((key, idx) => {
    const row = fsPpeInput.find(p => p.key === key);
    if (!row) return;
    const share = idx === keys.length - 1 ? M - assigned : Math.round(M * pyByKey[key] / total * 100) / 100;
    row.depCharge = share;
    assigned += share;
  });
  fsRenderPpe();
  fsRecalcDebounced();
  fsStatus('Allocated M across classes by opening balance — adjust any line to match the SLM schedule.', 'info');
}

function fsRenderExpenses() {
  const grid = fsEl('fs-expense-grid');
  if (!grid) return;
  if (!fsResult) { grid.innerHTML = '<p style="font-size:13px;color:var(--text-muted);margin:0;">Build the statements to see the expense lines.</p>'; return; }
  const inc = fsResult.income;
  const py = fsResult.priorYear || {};
  const pyBy = {};
  for (const it of (py.otherItems || [])) pyBy[String(it.name).toLowerCase().trim()] = it.amount;

  const block = (title, items, kind, pyItems) => {
    let h = `<div style="font-weight:700;font-size:13px;margin:14px 0 6px;">${escHtml(title)}</div>`;
    h += '<div class="table-wrap"><table class="app-table" style="font-size:13px;"><thead><tr><th>Particulars</th><th style="text-align:right;">Prior year</th><th style="text-align:right;">This year</th></tr></thead><tbody>';
    items.forEach((it, i) => {
      const prior = kind === 'other'
        ? (pyBy[String(it.name).toLowerCase().trim()] || 0)
        : (((pyItems || [])[i] || {}).amount || 0);
      const flat = /\brent\b|audit\s*fee/i.test(it.name);
      h += `<tr><td>${escHtml(it.name)}${flat ? ' <span style="font-size:11px;color:var(--text-muted);">held flat</span>' : ''}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--text-muted);">${fsFmt(prior)}</td>
        <td style="text-align:right;">${fsMoneyInput(`exp-${kind}-${i}`, it.amount, `fsExpenseEdit('${kind}',${i},this.value)`, 130)}</td></tr>`;
    });
    h += '</tbody></table></div>';
    return h;
  };

  grid.innerHTML =
    block('3.13 Employee Benefits', inc.employeeItems || [], 'employee', py.employeeItems)
    + block('3.15 Other Expenses', inc.otherItems || [], 'other', py.otherItems)
    + ((inc.materials.directItems || []).length
      ? block('3.12 Direct Costs', inc.materials.directItems, 'direct', (py.materials || {}).directItems) : '');
}

function fsExpenseEdit(kind, i, v) {
  if (!fsResult) return;
  fsExpenseEdits = fsExpenseEdits || {};
  const src = kind === 'employee' ? fsResult.income.employeeItems
    : kind === 'other' ? fsResult.income.otherItems
    : fsResult.income.materials.directItems;
  const key = kind === 'employee' ? 'employeeItems' : kind === 'other' ? 'otherItems' : 'directItems';
  fsExpenseEdits[key] = (fsExpenseEdits[key] || src.map(x => ({ ...x })));
  if (fsExpenseEdits[key][i]) fsExpenseEdits[key][i].amount = fsNum(v);
  fsRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  BUILD & REVIEW
// ════════════════════════════════════════════════════════════════

function fsCollectInput() {
  const figures = {};
  FS_FIGURES.forEach(f => { figures[f.k] = fsNum(fsFigures[f.k]); });
  // Nothing entered yet = lay the statements out with the comparative column
  // only, rather than refusing to build.
  const blankCurrentYear = !FS_FIGURES.some(f => fsNum(fsFigures[f.k]) !== 0);

  const fy = fsEl('fs-fy').value;
  const [y1] = fy.split('-');
  const cyYear = parseInt(y1, 10) + 1;          // FY 2082-83 closes in 2083
  const pyYear = cyYear - 1;
  const asAt = (y) => `${NepaliLocale.bsOrdinal ? '' : ''}${fsAshadhEnd(y)}`;

  // REP_FIRMS is keyed 'shailesh' / 'dallakoti' — it is the one source for both
  // firms' letterhead details across the app, so the name comes from there
  // rather than being repeated here.
  const auditorKey = fsEl('fs-auditor').value;
  const FIRM_KEY = { SA: 'shailesh', DC: 'dallakoti' };
  const firm = (window.REP_FIRMS || {})[FIRM_KEY[auditorKey]];
  const auditorName = firm ? firm.name
    : auditorKey === 'other' ? fsEl('fs-auditor-other').value.trim()
    : '';

  const address = fsEl('fs-address').value || '';
  const place = (address.split(',').map(s => s.trim()).find(s => /chitwan|kathmandu|pokhara|bharatpur|ratnanagar|khairahani/i.test(s)) || 'Chitwan')
    .replace(/\s*(municipality|metropolitan city|ward no\.?\s*\d+)\s*/gi, '').trim() || 'Chitwan';

  const today = NepaliLocale.todayBs();

  return {
    company: { name: fsEl('fs-company').value, address, pan: fsEl('fs-pan').value },
    fy, fyPrev: `${parseInt(y1, 10) - 1}-${String(parseInt(y1, 10) % 100).padStart(2, '0')}`,
    basis: fsEl('fs-basis').value,
    returnType: fsEl('fs-return-type').value,
    entity: fsEl('fs-entity').value,
    specialIndustry: fsEl('fs-special').checked,
    serviceIndustry: fsEl('fs-service').checked,
    localBody: fsEl('fs-localbody').value,
    auditor: { key: auditorKey, name: auditorName },
    labels: {
      asAtLine: `As at ${asAt(cyYear)}`,
      forYearLine: `For the year ended ${asAt(cyYear)}`,
      asAtCy: asAt(cyYear), asAtPy: asAt(pyYear),
      yearEndedCy: asAt(cyYear), yearEndedPy: asAt(pyYear),
      socOpenLabel: `Balance at 1st Shrawan, ${pyYear + 1}`,
      socCloseLabel: `Balance at ${asAt(cyYear)}`,
      dateBs: `${today.year}.${String(today.month).padStart(2, '0')}.${String(today.day).padStart(2, '0')}`,
      place,
    },
    figures, blankCurrentYear,
    ppeClasses: window.DEP_SLM_CLASSES || [],
    ppe: fsPpeInput,
    levers: Object.assign({}, fsLevers, fsExpenseEdits || {}),
    py: fsPy,
    purchaseTotal: fsDetailTotal(fsDetails.purchase),
    salesTotal: fsDetailTotal(fsDetails.sales),
    seedKey: `${fsEl('fs-pan').value}|${fsEl('fs-company').value}|${fy}`,
  };
}

// Ashadh is the last B.S. month and its length varies (31 or 32 days), so the
// year-end wording comes from the calendar table rather than being hardcoded —
// the sample statements read "32nd Ashadh 2082". fyEndBs(startYear) returns the
// fiscal year's closing date, which IS Ashadh end; the raw BS_MONTH_LENGTHS
// table is private to NepaliLocale, so this is the supported way to reach it.
function fsAshadhEnd(bsYear) {
  const end = NepaliLocale.fyEndBs(bsYear - 1);
  const len = (end && end.day) || 31;
  const suffix = (n) => (n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd' : (n % 10 === 3 && n !== 13) ? 'rd' : 'th';
  return `${len}${suffix(len)} Ashadh ${bsYear}`;
}

function fsCalculate() {
  if (!fsPy) { fsStatus('Upload the prior-year statement first (step 1).', 'error'); return; }
  if (fsPyIssues.some(i => i.level === 'error')) { fsStatus('The prior-year file is missing required figures — fix it and re-upload.', 'error'); return; }
  fsRun();
  fsShowSection('review');
  if (fsResult && fsResult.meta.blankCurrentYear) {
    fsStatus('Statements laid out with the comparative year only — enter any figure to start filling the current-year column.', 'info');
  }
  AuditLog.record('finstatement_generated', {
    module: 'finStatement', clientName: fsEl('fs-company').value, status: 'success',
    detail: { fy: fsEl('fs-fy').value, basis: fsEl('fs-basis').value, returnType: fsEl('fs-return-type').value },
  });
}

function fsRun() {
  const input = fsCollectInput();
  fsResult = FinStatementEngine.build(input);
  fsReport = fsxBuildReport(fsResult);
  fsSavedId = null;
  // All three of these rebuild grids that hold live inputs, so the field the
  // user is typing in has to survive the rebuild.
  fsPreserveFocus(() => {
    fsRenderReview();
    fsRenderPpe();
    fsRenderExpenses();
  });
}

function fsRecalcDebounced() {
  clearTimeout(fsRecalcTimer);
  fsRecalcTimer = setTimeout(() => { if (fsResult) fsRun(); }, 350);
}

function fsFmt(v) {
  if (v == null || v === '' || !isFinite(v)) return '–';
  if (Math.abs(v) < 0.005) return '–';
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
}

function fsIssuesHtml(issues) {
  if (!issues || !issues.length) return '';
  const errs = issues.filter(i => i.level === 'error');
  const warns = issues.filter(i => i.level !== 'error');
  let h = '';
  if (errs.length) h += `<div class="status-box status-error" style="margin-top:12px;"><b>Blocking</b><ul style="margin:6px 0 0 18px;padding:0;">${errs.map(i => `<li>${escHtml(i.msg)}</li>`).join('')}</ul></div>`;
  if (warns.length) h += `<div class="status-box status-info" style="margin-top:12px;"><b>Worth checking</b><ul style="margin:6px 0 0 18px;padding:0;">${warns.map(i => `<li>${escHtml(i.msg)}</li>`).join('')}</ul></div>`;
  return h;
}

function fsRenderReview() {
  if (!fsResult) return;
  const p = fsResult.proofs;

  // The three proofs. Shown, never forced — a non-zero figure is a real
  // finding about the inputs (§16, following Final Account).
  const proof = (label, v, note) => {
    const blank = v == null;
    const ok = !blank && Math.abs(v) < 0.5;
    const colour = blank ? 'var(--text-muted)' : (ok ? 'var(--green-dk)' : 'var(--red-dk)');
    return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-bottom:1px solid var(--border);">
      <div><b style="font-size:13px;">${label}</b><div style="font-size:11.5px;color:var(--text-muted);">${note}</div></div>
      <div style="font-variant-numeric:tabular-nums;font-weight:700;color:${colour};">${blank ? '—' : fsFmt(v)}</div>
    </div>`;
  };
  fsEl('fs-proofs').innerHTML =
    (p.blank ? `<div class="status-box status-info" style="margin-bottom:10px;">No current-year figures entered — the statements are laid out with the comparative year only, and the current-year column is left blank. The proofs apply once figures are entered.</div>` : '')
    + proof('Balance Sheet', p.balanceSheet, 'Total Assets less Total Equity and Liabilities — always zero')
    + proof('Cash Flow', p.cashFlow, 'Closing cash per the cash-flow statement less the balance-sheet cash')
    + proof('Profit', p.profit, 'Solved profit before tax less figure C')
    + (p.blank ? '' : `<div style="margin-top:12px;font-size:12.5px;color:var(--text-muted);">
        Goods Purchase solved to <b style="font-variant-numeric:tabular-nums;color:var(--text);">${fsFmt(fsResult.income.materials.purchases)}</b>
        &nbsp;·&nbsp; Trade Receivables solved to <b style="font-variant-numeric:tabular-nums;color:var(--text);">${fsFmt((fsResult.balance.receivableLines[0] || {}).amount)}</b>
        &nbsp;·&nbsp; Tax <b style="font-variant-numeric:tabular-nums;color:var(--text);">${fsFmt(fsResult.coi.tax)}</b>
        <span style="color:var(--text-muted);">(${escHtml(fsResult.coi.rule || '')})</span></div>`);

  const issues = fsResult.issues || [];
  fsEl('fs-issues-card').style.display = issues.length ? '' : 'none';
  fsEl('fs-issues').innerHTML = fsIssuesHtml(issues);

  // ── Levers. Every current-year figure is editable here as well as in step 2,
  //    so the whole statement can be driven from the review screen. ──
  const lv = fsResult.levers;
  const field = (key, label, val, note, handler) => `<div class="form-group">
      <label>${escHtml(label)}</label>
      ${fsMoneyInput(key, val, handler)}
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${escHtml(note)}</div>
    </div>`;
  const lever = (key, label, val, note) =>
    field('lev-' + key, label, val, note, `fsLeverEdit('${key}', this.value)`);

  const figuresHtml = FS_FIGURES.map(f =>
    field('figL-' + f.k, `${f.k}. ${f.label}`, fsFigures[f.k], f.hint,
      `fsOnFigureInput('${f.k}', this.value)`)).join('');

  fsEl('fs-levers').innerHTML =
    '<div style="font-weight:700;font-size:13px;margin:0 0 8px;">Current-year figures</div>'
    + '<div class="form-grid" style="grid-template-columns:repeat(3,1fr);gap:14px;">' + figuresHtml + '</div>'
    + '<div style="font-weight:700;font-size:13px;margin:18px 0 8px;">Balancing levers &amp; accruals</div>'
    + '<div class="form-grid" style="grid-template-columns:repeat(3,1fr);gap:14px;">'
    + lever('cash', 'Cash & Bank', lv.cash, 'Seeded 2–9 lakh, reproducible per client')
    + lever('tradePayables', 'Trade & Other Payables', lv.tradePayables, 'Note 3.9 Trade Payables — flows to the SFP and the cash flow')
    + lever('dividend', fsResult.meta.terms.distribution, lv.dividend, 'Reduces retained earnings')
    + lever('directorLoan', fsResult.meta.terms.person + ' Loan', lv.directorLoan, 'Raised automatically if receivables solve negative')
    + lever('auditFee', 'Audit Fee', lv.auditFee, 'Held flat at the prior year (rule 1)')
    + lever('rent', 'Rent', lv.rent, 'Held flat at the prior year (rule 1)')
    + lever('expensesPayable', 'Expenses Payable', lv.expensesPayable, 'Accrual in note 3.9')
    + '</div>'
    + `<div style="margin-top:10px;"><button class="btn btn-outline" style="padding:4px 12px;font-size:12px;" onclick="fsResetLevers()">Reset to computed</button></div>`;

  // Sheet tabs + preview
  fsEl('fs-sheet-tabs').innerHTML = fsReport.sheets.map(s =>
    `<button class="rep-view-btn${s.key === fsSheetView ? ' active' : ''}" onclick="fsShowSheet('${s.key}')">${escHtml(s.name)}</button>`).join('');
  fsRenderPreview();
}

function fsLeverEdit(key, v) {
  fsLevers[key] = fsNum(v);
  fsRecalcDebounced();
}

function fsResetLevers() {
  fsLevers = {};
  fsExpenseEdits = null;
  fsRun();
  fsStatus('Levers reset to the computed figures.', 'info');
}

function fsShowSheet(key) {
  fsSheetView = key;
  fsEl('fs-sheet-tabs').querySelectorAll('.rep-view-btn').forEach(b => b.classList.remove('active'));
  const tabs = Array.from(fsEl('fs-sheet-tabs').querySelectorAll('.rep-view-btn'));
  const idx = fsReport.sheets.findIndex(s => s.key === key);
  if (tabs[idx]) tabs[idx].classList.add('active');
  fsRenderPreview();
}

function fsRenderPreview() {
  if (!fsReport) return;
  const sh = fsReport.sheets.find(s => s.key === fsSheetView) || fsReport.sheets[0];
  fsEl('fs-preview').innerHTML = `<style>${FSX_PRINT_CSS}</style>` + fsxSheetHtml(sh, fsReport.meta);
}

// ════════════════════════════════════════════════════════════════
//  OUTPUTS
// ════════════════════════════════════════════════════════════════

function fsPrint() {
  if (!fsReport) { fsStatus('Build the statements first.', 'error'); return; }
  const html = fsxReportHtmlDoc(fsReport, { autoPrint: true });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) { fsStatus('The print window was blocked — allow pop-ups for this site.', 'error'); URL.revokeObjectURL(url); return; }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  AuditLog.record('finstatement_printed', {
    module: 'finStatement', clientName: fsEl('fs-company').value, status: 'success',
    detail: { fy: fsEl('fs-fy').value, basis: fsEl('fs-basis').value },
  });
}

async function fsDownloadExcel() {
  if (!fsReport) { fsStatus('Build the statements first.', 'error'); return; }
  fsStatus('Building the workbook…', 'searching');
  try {
    const wb = fsxWriteWorkbook(fsReport, ExcelJS);
    fsxAppendDetailSheets(wb, fsDetails);
    const buf = await wb.xlsx.writeBuffer();
    const basis = fsEl('fs-basis').value === 'audited' ? 'Audited' : 'Provisional';
    const name = `${basis} Financial Statement ${fsEl('fs-company').value || 'Client'} ${fsEl('fs-fy').value}.xlsx`;
    DocumentEngine.downloadBlob(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      name,
      { eventType: 'finstatement_excel_downloaded', module: 'finStatement', clientName: fsEl('fs-company').value });
    fsStatus('Workbook downloaded.', 'success');
  } catch (e) {
    fsStatus('Could not build the workbook: ' + e.message, 'error');
  }
}

// The uploaded detail sheets ride along as `p` and `s`, matching the template.
function fsxAppendDetailSheets(wb, details) {
  const add = (name, det) => {
    if (!det || !det.rows || !det.rows.length) return;
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    det.rows.forEach((row, r) => {
      (row || []).forEach((v, c) => {
        const cell = ws.getCell(r + 1, c + 1);
        cell.value = v == null ? '' : v;
        if (typeof v === 'number') { cell.numFmt = FSX_NUMFMT; cell.alignment = { horizontal: 'right' }; }
      });
    });
    ws.getColumn(1).width = 16;
    ws.getColumn(2).width = 38;
    for (let c = 3; c <= 8; c++) ws.getColumn(c).width = 16;
  };
  add('p', details.purchase);
  add('s', details.sales);
}

async function fsSave() {
  if (!fsResult) { fsStatus('Build the statements first.', 'error'); return; }
  if (!fsSelectedClient) { fsStatus('Pick a client from the directory to save — a typed-only company can still be exported, but has no stable key to save against.', 'error'); return; }
  const errs = (fsResult.issues || []).filter(i => i.level === 'error');
  if (errs.length) { fsStatus('Resolve the blocking findings before saving.', 'error'); return; }

  fsStatus('Saving…', 'searching');
  const input = fsCollectInput();
  const row = {
    client_id: fsSelectedClient.id,
    company_name: input.company.name,
    pan: input.company.pan,
    fiscal_year: input.fy,
    basis: input.basis,
    return_type: input.returnType,
    entity_type: input.entity,
    inputs: {
      figures: input.figures, levers: input.levers, ppe: input.ppe,
      identity: { basis: input.basis, returnType: input.returnType, entity: input.entity,
                  specialIndustry: input.specialIndustry, serviceIndustry: input.serviceIndustry,
                  localBody: input.localBody, auditor: input.auditor, labels: input.labels },
      py: input.py, purchaseTotal: input.purchaseTotal, salesTotal: input.salesTotal,
      seedKey: input.seedKey,
    },
    computed: fsResult,
    created_by: (window.currentUser || {}).email || null,
  };
  try {
    const { data, error } = await window.sb.from('financial_statements')
      .upsert(row, { onConflict: 'client_id,fiscal_year,basis' }).select('id').single();
    if (error) throw error;
    fsSavedId = data.id;
    AuditLog.record('finstatement_saved', {
      module: 'finStatement', clientName: input.company.name, status: 'success',
      recordRef: data.id, detail: { fy: input.fy, basis: input.basis },
    });
    fsStatus(`Saved (${input.basis}, ${input.fy}).`, 'success');
  } catch (e) {
    fsStatus('Could not save: ' + e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  STEPPER
// ════════════════════════════════════════════════════════════════

function fsShowSection(which) {
  ['setup', 'figures', 'review'].forEach(s => {
    const sec = fsEl('fs-section-' + s);
    if (sec) sec.style.display = s === which ? '' : 'none';
    const btn = fsEl('fs-step-' + s);
    if (btn) btn.classList.toggle('active', s === which);
  });
  if (which === 'figures') {
    fsRenderFigures();
    fsRenderPpe();
    fsRenderExpenses();
  }
}
