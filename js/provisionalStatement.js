// ════════════════════════════════════════════════════════════════════════
//  PROVISIONAL STATEMENT  (`ps-`)
//
//  Automation Hub → Provisional Statement. Sibling of Audited Statement
//  (`finStatement`, `fs-`): same three-step shape, same output layer, and
//  deliberately the same form idiom as Projection Report, which is what the
//  firm already knows.
//
//  The difference is the direction of travel. Audited lays out a finished
//  year. This one takes LAST year's statement plus a handful of this year's
//  real figures and derives the rest by formula —
//  js/provisionalStatementEngine.js holds those rules, each quoted from the
//  firm's own workbook and proved by `node tools/psVerify.mjs`.
//
//  Nothing here re-implements the output: the report is built by
//  `fsxBuildReport()` and rendered by `fsxWriteWorkbook()` / `fsxPreviewHtml()`
//  in js/finStatementExport.js, which was already written cell-by-cell against
//  a workbook of exactly this family.
// ════════════════════════════════════════════════════════════════════════

ModuleRegistry.register({ id: 'provisionalStatement', group: 'main', buttonId: null, panelId: 'tab-provisionalStatement-panel' });

let psSelectedClient = null;
let psPy = null;             // FinStatementEngine.parsePriorYear() output
let psPyIssues = [];
let psResult = null;         // ProvisionalStatementEngine.derive() output
let psReport = null;         // fsxBuildReport() output
let psCy = {};               // this year's typed figures
let psRules = {};            // per-line rule overrides
let psPpeInput = [];         // editable 3.1 PPE grid
let psLoans = { nc: [], c: [] };
let psCustom = [];           // other-expense lines the user added by hand
let psDirectCustom = [];     // direct-cost lines the user added by hand
let psTds = {};              // per-line TDS overrides; blank means "derive it"
// What the app could resolve for this client-year without anyone typing it:
// { revenue, purchases, vat, parties, months, source } from Autobooks, plus
// the Income-Tax depreciation the COI bridge needs. Null when there is no
// source, in which case every figure stays typed exactly as before.
let psSrc = null;
let psItDep = null;
// Figures the preparer has deliberately taken back off the source. A key in
// here means "I typed this, stop auto-filling it" — nothing is ever silently
// overwritten once it has been claimed.
let psTypedOver = {};
// Trade receivables absorbs the balance by default, the way the Audited engine
// already works (§15). Untick it to type receivables and have any residual
// reported instead of absorbed.
let psPlugReceivables = true;
let psSheetKey = 'SFP';
let psDepSource = '';        // where the PPE grid came from, for the caption

function psStatus(html, type) { showStatus(html, type, 'ps-status-area'); }
function psEl(id) { return document.getElementById(id); }
// The A.D. equivalent the firm prints in brackets ("(16th July 2026)").
// NepaliLocale owns every calendar conversion in this app but only carries
// adToBs — there is no B.S.-to-A.D. table — so this is TYPED rather than
// computed. Inventing a conversion would put a wrong date on a signed
// statement, which is exactly the error this module exists to prevent.
function psAdSuffix() {
  const v = ((psEl('ps-ad-date') || {}).value || '').trim();
  return v ? ` (${v})` : '';
}

function psFmt(v) {
  const n = Number(v);
  if (!isFinite(n) || Math.abs(n) < 0.005) return '–';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function psNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

function psInit() {
  psPopulateFy();
  psPopulateStaff();
  if (!psEl('ps-client-search').dataset.wired) {
    SearchEngine.attachAutocomplete(psEl('ps-client-search'), psEl('ps-client-autocomplete'), {
      source: () => window.clientsList || [],
      keys: ['name', 'pan'],
      render: it => `${escHtml(it.name)}${it.pan ? ` <span style="color:var(--text-muted)">· ${escHtml(it.pan)}</span>` : ''}`,
      onPick: it => psScope.select(it),
    });
    psEl('ps-client-search').dataset.wired = '1';
  }
  psRenderPySummary();
  psRenderFigures();
}

// Fiscal-year list, read through the shared default so every module rolls
// over together on Shrawan 1 (§15 — FY_DEFAULT_START).
function psPopulateFy() {
  const sel = psEl('ps-fy');
  if (!sel || sel.options.length) return;
  const base = window.FY_DEFAULT_START || 2082;
  for (let y = base - 3; y <= base + 3; y++) {
    const o = document.createElement('option');
    o.value = `${y}-${String(y + 1).slice(2)}`;
    o.textContent = o.value;
    if (y === base) o.selected = true;
    sel.appendChild(o);
  }
}

function psPopulateStaff() {
  const sel = psEl('ps-staff');
  if (!sel) return;
  const staff = window.ARF_STAFF || [];
  sel.innerHTML = staff.map(s => `<option>${escHtml(s)}</option>`).join('');
}

// Client switching goes through a scope, so `clear()` runs unconditionally
// before every `load()` and no path can leak the previous client's figures
// onto this one's statement (§9).
const psScope = WorkflowEngine.createClientScope({
  clear(reason) {
    if (reason === 'client') {
      psSelectedClient = null;
      ['ps-company', 'ps-pan', 'ps-address'].forEach(id => { const e = psEl(id); if (e) e.value = ''; });
    }
    const had = !!psPy;
    psPy = null; psPyIssues = [];
    psResult = null; psReport = null;
    psCy = {}; psRules = {}; psPpeInput = []; psDepSource = '';
    psLoans = { nc: [], c: [] };
    psCustom = []; psDirectCustom = []; psTds = {};
    psSrc = null; psItDep = null; psTypedOver = {};
    psSolveFor = 'purchases'; psPlugReceivables = true;
    const f = psEl('ps-py-file'); if (f) f.value = '';
    psRenderPySummary();
    psRenderFigures();
    psRenderLoans();
    psShowSection('setup');
    psStatus(had
      ? "Cleared the previous client's prior-year statement and figures — upload this client's file to continue."
      : '', 'info');
  },
  load(it) {
    psSelectedClient = it;
    psEl('ps-company').value = it.name || '';
    psEl('ps-pan').value = NepaliLocale.toEnglishDigits(it.pan || '');
    psEl('ps-address').value = it.address || '';
    psEl('ps-client-search').value = it.name || '';

    // entity_type is free text; the shared map is the one authority (§16).
    // ASSIGN unconditionally — an `if (mapped)` leaves the previous client's
    // tax profile standing when this one has none on file.
    const profile = (window.CLIENT_ENTITY_TO_REP_PROFILE || {})[String(it.entity_type || '').toLowerCase().trim()];
    psEl('ps-tax-profile').value = profile === 'proprietorship' ? 'progressive' : 'corporate';

    psLoadDepreciation();
    psLoadSources();
    psStatus(`Client loaded: ${it.name}`, 'success');
  },
});

function psOnFyChange() {
  psLoadDepreciation();
  psLoadSources();
  psRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  SOURCES — figures this app already holds for the client and year.
//  Read-only (js/provisionalSources.js); a missing source is not an error,
//  it just leaves the figure typed.
// ════════════════════════════════════════════════════════════════

async function psLoadSources() {
  const fy = (psEl('ps-fy') || {}).value;
  const name = (psEl('ps-company') || {}).value;
  const id = psSelectedClient ? psSelectedClient.id : null;
  if (!fy) return;
  try {
    const [reg, itDep] = await Promise.all([
      psrcRegister(id, name, fy),
      psrcItDepreciation(id, fy),
    ]);
    psSrc = reg;
    psItDep = itDep;
    psApplySources();
    psRenderFigures();
    psRun();

    const got = [];
    if (reg) got.push(`revenue and purchases from ${reg.source}`);
    if (reg && reg.vat) got.push('the VAT position');
    if (itDep) got.push(itDep.stale ? `Income-Tax depreciation (${itDep.fiscalYear} — no schedule for this year yet)` : 'Income-Tax depreciation');
    if (got.length) {
      psStatus(`Filled ${got.join(', ')}. Each one shows where it came from and can be typed over.`, 'success');
    }
  } catch (e) { /* a missing source must never block the module */ }
}

// Push resolved figures into the typed boxes, EXCEPT any the preparer has
// claimed by typing. Same contract as Autobooks' VAT upload: a figure someone
// entered is never replaced without saying so.
function psApplySources() {
  const set = (k, v) => { if (!psTypedOver[k] && v != null) psCy[k] = Math.round(v * 100) / 100; };
  if (psSrc) {
    set('sales', psSrc.revenue.value);
    set('purchases', psSrc.purchases.value);
    if (psSrc.vat) {
      if (!psTypedOver.vatRegistered) psCy.vatRegistered = true;
      set('vatPayable', psSrc.vat.payable || null);
      set('vatReceivable', psSrc.vat.receivable || null);
    }
    // Purchases came from the register, so the see-saw must hold THAT and let
    // profit fall out — otherwise the derived purchases figure is immediately
    // overwritten by the balancing solve.
    if (!psTypedOver.pbtTarget && psCy.purchases != null) psSolveFor = 'pbt';
  }
  if (psItDep && !psTypedOver.itDepreciation) psCy.itDepreciation = Math.round(psItDep.value * 100) / 100;
}

// Where a figure came from, for the caption under its box.
function psSourceOf(k) {
  if (psTypedOver[k]) return null;
  if (!psSrc && !psItDep) return null;
  if (k === 'sales' && psSrc) return psSrc.revenue;
  if (k === 'purchases' && psSrc) return psSrc.purchases;
  if ((k === 'vatPayable' || k === 'vatReceivable') && psSrc && psSrc.vat) return psSrc.vat;
  if (k === 'itDepreciation' && psItDep) return psItDep;
  return null;
}

// Typing into a sourced box claims it; the ↺ hands it back to the source.
function psClaimTyped(k) { psTypedOver[k] = true; }
function psReleaseTyped(k) {
  delete psTypedOver[k];
  delete psCy[k];
  psApplySources();
  psRenderFigures();
  psRun();
}

// ════════════════════════════════════════════════════════════════
//  STEP 1 — prior year
// ════════════════════════════════════════════════════════════════

// The prior-year reader is the Audited engine's, reused wholesale: it already
// knows this workbook family's layout, and a second parser would be a second
// thing to keep in step with the firm's sheets.
async function psHandlePyFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  psStatus('Reading the prior-year statement…', 'searching');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const { py, issues } = FinStatementEngine.parsePriorYear(wb, XLSX);
    psPy = py;
    psPyIssues = issues;
    psRules = {};
    psPpeInput = [];
    psCustom = []; psDirectCustom = []; psTds = {};

    if (!psEl('ps-company').value && py.company.name) psEl('ps-company').value = py.company.name;
    if (!psEl('ps-address').value && py.company.address) psEl('ps-address').value = py.company.address;

    psRenderPySummary();
    if (issues.some(i => i.level === 'error')) {
      psStatus('The prior-year file is missing figures the statement needs — see below.', 'error');
      return;
    }
    psSeedPpe();
    psSeedLoans();
    psSeedFigures();
    psRenderFigures();
    AuditLog.record('provisional_py_parsed', {
      module: 'provisionalStatement', clientName: psEl('ps-company').value, status: 'success',
      detail: { otherExpenseLines: py.otherItems.length, ppeClasses: py.ppe.classes.length },
    });
    psStatus('Prior-year statement read. Every expense line below now has a rule you can change.', 'success');
  } catch (e) {
    psStatus('Could not read that workbook: ' + e.message, 'error');
  }
}

function psRenderPySummary() {
  const box = psEl('ps-py-summary');
  if (!box) return;
  if (!psPy) { box.innerHTML = ''; return; }
  const p = psPy;
  const rows = [
    ['Company', escHtml(p.company.name || '—')],
    ['Sales (revenue from operations)', psFmt(p.soi.revenueOps)],
    ['Other income', psFmt(p.soi.otherIncome)],
    ['Closing stock → this year&rsquo;s opening', psFmt(p.materials.closing || p.sfp.inventories)],
    ['Salary', psFmt(p.salary)],
    ['Other expense lines found', String((p.otherItems || []).length)],
    ['PPE classes found', String((p.ppe.classes || []).length)],
    ['Profit before tax', psFmt(p.soi.pbt)],
  ];
  box.innerHTML = `
    <table class="client-table" style="margin-top:4px;">
      <tbody>${rows.map(([k, v]) => `<tr><td style="width:60%;">${k}</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${v}</td></tr>`).join('')}</tbody>
    </table>
    ${psIssuesHtml(psPyIssues)}`;
}

function psIssuesHtml(issues) {
  if (!issues || !issues.length) return '';
  return `<div style="margin-top:12px; display:grid; gap:6px;">` + issues.map(i =>
    `<div class="status-box ${i.level === 'error' ? 'status-error' : 'status-info'}" style="margin:0;">${escHtml(i.msg)}</div>`
  ).join('') + `</div>`;
}

// ════════════════════════════════════════════════════════════════
//  DEPRECIATION — a saved SLM schedule is the preferred source; the built-in
//  rate table is the fallback. Either way the grid stays editable, which is
//  what the Projection module does and what the user asked for.
// ════════════════════════════════════════════════════════════════

async function psLoadDepreciation() {
  if (!psSelectedClient || !window.sb) return;
  const fy = psEl('ps-fy').value;
  try {
    // Same fallback rule as depSlmFetchUsefulLives(): this year's schedule if
    // there is one, else the most recent earlier year — a provisional set is
    // routinely drawn before the year's own schedule has been saved.
    const base = () => window.sb.from('depreciation_schedules')
      .select('pools, fiscal_year').eq('client_id', psSelectedClient.id).eq('scheme', 'slm');
    const { data: cur } = await base().eq('fiscal_year', fy).maybeSingle();
    let hit = cur;
    if (!hit) {
      const { data: prev } = await base().lt('fiscal_year', fy)
        .order('fiscal_year', { ascending: false }).limit(1);
      hit = (prev && prev[0]) || null;
    }
    if (!hit || !hit.pools || !hit.pools.length) return;

    // Roll the saved per-asset rows up to the class columns the 3.1 PPE note
    // draws. Carrying is what the note's opening block needs, because the
    // workbook restates each year (see the engine's PPE comment).
    const by = {};
    hit.pools.forEach(p => {
      const k = p.classKey || p.key;
      if (!k) return;
      const b = by[k] || (by[k] = { carrying: 0, additions: 0, disposals: 0 });
      b.carrying  += psNum(p.closingWDV != null ? p.closingWDV : p._closingWDV);
      b.additions += psNum(p.addition);
      b.disposals += psNum(p.delCost);
    });
    if (!Object.keys(by).length) return;

    psPpeInput = ProvisionalStatementEngine.PPE_RATES
      .filter(r => by[r.key])
      .map(r => Object.assign({ key: r.key, name: r.name, rate: r.rate }, by[r.key]));
    psDepSource = `saved SLM schedule (${hit.fiscal_year})`;
    psRenderPpe();
    psRecalcDebounced();
    psStatus(`Depreciation seeded from the ${psDepSource}. Every figure below is still editable.`, 'success');
  } catch (e) { /* auto-fill is a convenience; never block the module on it */ }
}

// Fallback: the prior-year file's own 3.1 PPE note, matched to the rate table
// by name. A class the file doesn't carry is simply absent — empty heads are
// dropped, the same way Projection prunes its schedule.
function psSeedPpe() {
  if (psPpeInput.length) return;          // a saved SLM schedule already won
  const classes = (psPy && psPy.ppe && psPy.ppe.classes) || [];
  const rates = ProvisionalStatementEngine.PPE_RATES;
  const match = (name) => {
    const n = String(name || '').toLowerCase();
    return rates.find(r => n.includes(r.key)
      || r.name.toLowerCase().split(/[^a-z]+/).some(w => w.length > 3 && n.includes(w)));
  };
  psPpeInput = classes.map(c => {
    const r = match(c.name) || {};
    return {
      key: r.key || c.name, name: c.name || r.name,
      rate: r.rate == null ? 0 : r.rate,
      carrying: psNum(c.carrying), additions: 0, disposals: 0,
    };
  }).filter(c => c.carrying || c.additions);
  if (psPpeInput.length) psDepSource = "the prior-year file's 3.1 PPE note";
  psRenderPpe();
}

function psRenderPpe() {
  const host = psEl('ps-ppe');
  if (!host) return;
  if (!psPpeInput.length) {
    host.innerHTML = `<div style="color:var(--text-muted); font-size:13px; padding:8px 2px;">No fixed-asset classes yet — upload the prior-year statement, or add a class below.</div>${psPpeAddHtml()}`;
    return;
  }
  const rows = psPpeInput.map((c, i) => {
    const closeCost = psNum(c.carrying) + psNum(c.additions) - psNum(c.disposals);
    const charge = closeCost * psNum(c.rate);
    return `<tr>
      <td class="dep-particular">${escHtml(c.name)}</td>
      <td><input type="number" step="0.01" value="${psNum(c.rate) * 100}" onchange="psPpeEdit(${i},'ratePct',this.value)" style="width:76px;" /></td>
      <td><input type="number" step="0.01" value="${psNum(c.carrying)}" onchange="psPpeEdit(${i},'carrying',this.value)" style="width:140px;" /></td>
      <td><input type="number" step="0.01" value="${psNum(c.additions)}" onchange="psPpeEdit(${i},'additions',this.value)" style="width:130px;" /></td>
      <td><input type="number" step="0.01" value="${psNum(c.disposals)}" onchange="psPpeEdit(${i},'disposals',this.value)" style="width:130px;" /></td>
      <td><input type="number" step="0.01" value="${c.depChargeOverride == null || c.depChargeOverride === '' ? Number(charge).toFixed(2) : c.depChargeOverride}"
                 onchange="psPpeEdit(${i},'depChargeOverride',this.value)" style="width:140px; text-align:right;" /></td>
      <td><input type="number" step="0.01" value="${c.carryingOverride == null || c.carryingOverride === '' ? Number(closeCost - charge).toFixed(2) : c.carryingOverride}"
                 onchange="psPpeEdit(${i},'carryingOverride',this.value)" style="width:150px; text-align:right;" /></td>
      <td style="white-space:nowrap;">
        ${(c.depChargeOverride != null && c.depChargeOverride !== '') || (c.carryingOverride != null && c.carryingOverride !== '')
          ? `<button class="btn btn-outline btn-sm" title="Back to the rate" onclick="psPpeReset(${i})">↺</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="psPpeRemove(${i})">✕</button></td>
    </tr>`;
  }).join('');
  const chargeOf = (c) => (c.depChargeOverride != null && c.depChargeOverride !== '')
    ? psNum(c.depChargeOverride)
    : (psNum(c.carrying) + psNum(c.additions) - psNum(c.disposals)) * psNum(c.rate);
  const totCharge = psPpeInput.reduce((s, c) => s + chargeOf(c), 0);
  host.innerHTML = `
    ${psDepSource ? `<div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">Seeded from ${escHtml(psDepSource)} — every figure is editable.</div>` : ''}
    <div class="table-wrap"><table class="client-table dep-table">
      <thead><tr>
        <th class="dep-particular">Class</th><th>Rate %</th>
        <th>Opening (last year&rsquo;s carrying)</th><th>Additions</th><th>Disposals</th>
        <th>Depreciation</th><th>Carrying at year end</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="dep-slm-ppe-strong">
        <td class="dep-particular">Total</td><td></td><td></td><td></td><td></td>
        <td class="dep-calc">${psFmt(totCharge)}</td><td class="dep-calc"></td><td></td>
      </tr></tfoot>
    </table></div>
    ${psPpeAddHtml()}`;
}

function psPpeAddHtml() {
  const have = new Set(psPpeInput.map(c => c.key));
  const opts = ProvisionalStatementEngine.PPE_RATES.filter(r => !have.has(r.key));
  if (!opts.length) return '';
  return `<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
    <select id="ps-ppe-add" style="max-width:260px;">${opts.map(o => `<option value="${o.key}">${escHtml(o.name)} — ${o.rate * 100}%</option>`).join('')}</select>
    <button class="btn btn-outline btn-sm" onclick="psPpeAdd()">+ Add class</button>
  </div>`;
}

function psPpeAdd() {
  const key = (psEl('ps-ppe-add') || {}).value;
  const r = ProvisionalStatementEngine.PPE_RATES.find(x => x.key === key);
  if (!r) return;
  psPpeInput.push({ key: r.key, name: r.name, rate: r.rate, carrying: 0, additions: 0, disposals: 0 });
  psRenderPpe();
  psRecalcDebounced();
}

function psPpeRemove(i) { psPpeInput.splice(i, 1); psRenderPpe(); psRecalcDebounced(); }

function psPpeEdit(i, field, v) {
  const c = psPpeInput[i];
  if (!c) return;
  if (field === 'ratePct') c.rate = psNum(v) / 100;
  // An override is stored as typed, so clearing the box returns the cell to
  // the rate rather than pinning it at zero.
  else if (field === 'depChargeOverride' || field === 'carryingOverride') c[field] = v === '' ? null : psNum(v);
  else c[field] = psNum(v);
  psRenderPpe();
  psRecalcDebounced();
}

function psPpeReset(i) {
  const c = psPpeInput[i];
  if (!c) return;
  c.depChargeOverride = null;
  c.carryingOverride = null;
  psRenderPpe();
  psRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  STEP 2 — this year's typed figures, and the rule behind every other line
// ════════════════════════════════════════════════════════════════

// The figures the preparer actually types. Everything else is derived —
// this list IS the module's input surface.
// Figures typed for the current year. `grow: true` means the box is SEEDED at
// last year + the default growth when the prior-year file is read — a starting
// point, not a rule: every one is overwritten by typing.
//
// Interest lives on the Loans card instead of here, because interest is a fact
// about a facility and belongs beside the balance that produced it.
const PS_FIGURES = [
  { k: 'sales',            label: 'Sale of Goods',                grow: true,  hint: 'Seeded at last year + growth. Type over it.' },
  { k: 'otherIncome',      label: 'Commissions &amp; Incentives', grow: true,  hint: 'Other income.' },
  { k: 'interestIncome',   label: 'Interest Income',              grow: false, hint: '' },
  { k: 'closingStock',     label: 'Closing Stock',                grow: true,  hint: 'Becomes next year&rsquo;s opening stock.' },
  { k: 'tradeReceivables', label: 'Trade Receivables',            grow: true,  plug: true,
    hint: 'Balances the sheet by default &mdash; untick below to type it and see any gap instead.' },
  { k: 'cash',             label: 'Cash &amp; Bank Balances',     grow: true,  hint: '' },
  { k: 'tradePayables',    label: 'Trade Payables',               grow: true,  hint: '' },
  { k: 'taxPaid',          label: 'Income Tax Paid',              grow: false, hint: 'Cash-flow only. Blank uses last year&rsquo;s provision.' },
  { k: 'capitalIntroduced',label: 'Capital Introduced',           grow: false, hint: 'Shown on the Statement of Changes in Equity.' },
  { k: 'dividend',         label: '@DIST@',                       grow: false, hint: 'Reduces retained earnings on the SOCE. Enter as a positive figure.' },
];

// A company pays a dividend; a firm or proprietor takes drawings. Same row on
// the SOCE either way — only the word changes, and it is the word the audit
// report and the projection already use for that entity.
function psDistLabel() {
  return ((psEl('ps-tax-profile') || {}).value === 'progressive') ? 'Drawings' : 'Dividend Paid';
}

// Which of the pair was typed last. Editing either one makes the other the
// balancing figure, so there is never a stale "mode" to remember — the last
// thing touched is by definition the one the preparer means to hold.
// Names the figure the ENGINE solves — i.e. the balancing one. Defaults to
// 'purchases', so a typed Profit Before Tax is what is held. Kept as one
// meaning end to end: an inversion between here and the collector is exactly
// how the see-saw silently stopped moving the first time.
let psSolveFor = 'purchases';

// Seed the current-year boxes from last year plus the default growth. Only
// fills a box the user has not already typed into.
function psSeedFigures() {
  if (!psPy) return;
  const g = 1 + psNum((psEl('ps-growth') || {}).value || 5) / 100;
  const src = {
    sales: psPy.soi && psPy.soi.revenueOps,
    otherIncome: psPy.soi && psPy.soi.otherIncome,
    closingStock: (psPy.materials && psPy.materials.closing) || (psPy.sfp && psPy.sfp.inventories),
    tradeReceivables: psPy.sfp && psPy.sfp.receivables,
    cash: psPy.sfp && psPy.sfp.cash,
    tradePayables: psPy.sfp && psPy.sfp.payables,
  };
  PS_FIGURES.filter(f => f.grow).forEach(f => {
    if (psCy[f.k] != null) return;
    const v = psNum(src[f.k]);
    if (v) psCy[f.k] = Math.round(v * g * 100) / 100;
  });

  // Profit opens at LAST YEAR'S MARGIN carried onto this year's turnover —
  //   profit(CY) = profit(PY) / sales(PY) x sales(CY)
  // — which is the firm's own first guess at a provisional profit. It is a
  // seed, not a rule: the box is editable, and typing in it is what makes
  // Purchases balance to it.
  if (psCy.pbtTarget == null) {
    const seeded = ProvisionalStatementEngine.pbtFromMargin(
      psPy.soi && psPy.soi.pbt, psPy.soi && psPy.soi.revenueOps, psCy.sales);
    if (seeded) psCy.pbtTarget = Math.round(seeded * 100) / 100;
  }
}

function psRenderFigures() {
  const host = psEl('ps-figures');
  if (!host) return;
  const derived = psResult ? psResult.income : null;
  // The held side shows what was typed; the derived side shows what solved.
  const pbtVal = psSolveFor === 'purchases'
    ? (psCy.pbtTarget == null ? (derived ? derived.pbt : '') : psCy.pbtTarget)
    : (derived ? derived.pbt : '');
  const purVal = psSolveFor === 'purchases'
    ? (derived ? derived.materials.purchases : '')
    : (psCy.purchases == null ? '' : psCy.purchases);
  const tag = (on) => on
    ? '<span class="log-badge badge-info" style="margin-left:6px; font-size:10px;">balancing</span>' : '';

  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">` +
    PS_FIGURES.map(f => {
      const plugged = f.plug && psPlugReceivables;
      const val = plugged
        ? (derived && psResult ? Number(psResult.balance.tradeReceivables).toFixed(2) : '')
        : (psCy[f.k] == null ? '' : psCy[f.k]);
      const src = psSourceOf(f.k);
      return `
      <div class="form-group" style="margin:0;">
        <label>${f.label === '@DIST@' ? escHtml(psDistLabel()) : f.label} ${plugged ? tag(true) : ''}${src ? psSrcBadge() : ''}</label>
        <input type="number" step="0.01" id="ps-fig-${f.k}" value="${val}" ${plugged ? 'readonly style="background:var(--bg-subtle);"' : ''}
               oninput="psFigureInput('${f.k}', this.value)" />
        ${src ? psSrcNote(f.k, src) : (f.hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${f.hint}</div>` : '')}
      </div>`; }).join('') + `</div>

    <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin-top:12px; cursor:pointer;">
      <input type="checkbox" ${psPlugReceivables ? 'checked' : ''} style="width:auto;" onchange="psSetPlug(this.checked)" />
      Balance the sheet through Trade Receivables
    </label>

    <div style="margin-top:18px; padding-top:14px; border-top:1px solid var(--border);">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:4px;">Profit &amp; Purchases</div>
      <p style="font-size:11.5px; color:var(--text-muted); margin:0 0 10px;">Two ends of one see-saw. Type the profit you need and Purchases balances to it; type Purchases and the profit follows. Whichever you touched last is the one held.</p>
      <div class="form-grid" style="grid-template-columns:repeat(2,1fr); gap:14px;">
        <div class="form-group" style="margin:0;">
          <label>Profit Before Tax ${tag(psSolveFor === 'pbt')}</label>
          <input type="number" step="0.01" id="ps-fig-pbtTarget" value="${pbtVal === '' ? '' : Number(pbtVal).toFixed(2)}"
                 oninput="psSetSolve('pbt', this.value)" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Purchases of Goods ${tag(psSolveFor === 'purchases')}</label>
          <input type="number" step="0.01" id="ps-fig-purchases" value="${purVal === '' ? '' : Number(purVal).toFixed(2)}"
                 oninput="psSetSolve('purchases', this.value)" />
        </div>
      </div>
    </div>`;
  psRenderRules();
  psRenderPpe();
  psRenderTax();
}

function psSrcBadge() {
  return '<span class="log-badge badge-info" style="margin-left:6px; font-size:10px;">from data</span>';
}

// Provenance under a sourced box: where the figure came from, and the way back
// to typing it. A figure whose origin is invisible is one nobody trusts.
function psSrcNote(k, src) {
  return `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
    ${escHtml(src.source || 'app data')}${src.detail ? ` — ${escHtml(src.detail)}` : ''}
  </div>`;
}

// Editing one end of the see-saw makes the OTHER the balancing figure.
function psSetPlug(on) {
  psPlugReceivables = !!on;
  psRun();
  psRenderFigures();
}

function psSetSolve(which, v) {
  if (which === 'pbt') { psSolveFor = 'purchases'; psCy.pbtTarget = v === '' ? null : psNum(v); }
  else { psSolveFor = 'pbt'; psCy.purchases = v === '' ? null : psNum(v); }
  psRecalcDebounced();
}

function psFigureInput(k, v) {
  psCy[k] = v === '' ? undefined : psNum(v);
  if (psSourceOf(k)) psClaimTyped(k);
  psRecalcDebounced();
}

// The rules grid: one row per expense line, showing last year's figure, the
// rule that carries it forward, and the resulting figure. Changing a rule to
// "Typed this year" reveals a box — which is how any single line escapes the
// pattern without the pattern being abandoned.
function psRenderRules() {
  const host = psEl('ps-rules');
  if (!host) return;
  if (!psPy) { host.innerHTML = `<div style="color:var(--text-muted); font-size:13px;">Upload the prior-year statement to see the expense lines.</div>`; return; }

  const res = psResult;
  const lineOf = (key) => {
    if (!res) return null;
    const all = [].concat(
      res.income.materials.directItems, res.income.employeeItems, res.income.otherItems);
    return all.find(l => l.key === key) || null;
  };

  const group = (title, lines) => {
    if (!lines.length) return '';
    return `<div style="margin-top:14px;">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:6px;">${title}</div>
      <div class="table-wrap"><table class="client-table">
        <thead><tr>
          <th style="width:38%;">Line</th><th style="text-align:right;">Last year</th>
          <th style="width:110px;">Growth %</th>
          <th style="text-align:right; width:170px;">This year</th>
          <th style="width:40px;"></th>
        </tr></thead>
        <tbody>${lines.map(l => psRuleRowHtml(l, lineOf(l.key))).join('')}</tbody>
      </table></div></div>`;
  };

  // Rent and Audit Fee arrive at 0% — the firm renegotiates them rather than
  // indexing them — and everything else at the default growth. Both are just
  // starting rates the user can change on the row.
  const flat = ProvisionalStatementEngine.FLAT_LINES;
  const otherLines = (psPy.otherItems || []).map((e, i) => ({
    key: e.key || ('other' + i), name: e.name, py: e.amount,
    def: flat.indexOf(e.key) >= 0 ? 'flat' : 'growth',
  })).concat(psCustom.map(c => ({ key: c.key, name: c.name, py: 0, def: 'growth', custom: true })));

  host.innerHTML =
    group('Direct costs', [
      { key: 'labour',  name: 'Labour Charges',                 py: psPyDirect('labour'),  def: 'growth' },
      { key: 'freight', name: 'Clearing &amp; Freight Expenses', py: psPyDirect('freight'), def: 'growth' },
    ].concat(psDirectCustom.map(d => ({ key: d.key, name: d.name, py: 0, def: 'growth', custom: 'direct' })))) +
    `<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
       <input type="text" id="ps-new-direct" placeholder="New direct cost — e.g. Packing Charges"
              style="max-width:320px;" onkeydown="if(event.key==='Enter'){event.preventDefault();psAddCustomDirect();}" />
       <button class="btn btn-outline btn-sm" onclick="psAddCustomDirect()">+ Add direct cost</button>
     </div>` +
    group('Employee benefits', [
      { key: 'salary', name: 'Salary Expenses', py: psPy.salary, def: 'growth' },
    ]) +
    group('Other expenses', otherLines) +
    `<div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
       <input type="text" id="ps-new-expense" placeholder="New expense line — e.g. Security Charges"
              style="max-width:320px;" onkeydown="if(event.key==='Enter'){event.preventDefault();psAddCustomExpense();}" />
       <button class="btn btn-outline btn-sm" onclick="psAddCustomExpense()">+ Add expense line</button>
     </div>`;
}

function psPyDirect(which) {
  const items = (psPy && psPy.materials && psPy.materials.directItems) || [];
  const re = which === 'labour' ? /labour|labor|wage/i : /clear|freight|carriage/i;
  const hit = items.find(i => re.test(i.name || ''));
  return hit ? hit.amount : 0;
}
function psPyIncentive() {
  // The prior-year SOI carries it as its own expense row; the reader keeps
  // unmatched rows on otherItems, so look in both.
  if (psPy && psPy.soi && psPy.soi.incentive) return psPy.soi.incentive;
  const hit = (psPy && psPy.otherItems || []).find(i => /incentive/i.test(i.name || ''));
  return hit ? hit.amount : 0;
}

// One row, two editable numbers: the growth rate, and the resulting figure.
// There is deliberately NO rule dropdown — every line is "last year + growth %",
// and typing a figure into the right-hand box overrides that line outright
// (shown as 0% so the override is visible rather than hidden behind a mode).
// Rent and Audit Fee simply arrive with a 0% default, which is what "flat"
// meant before; nothing about them is special-cased any more.
function psRuleRowHtml(l, computed) {
  const ov = psRules[l.key] || {};
  const typed = ov.rule === 'typed';
  const defPct = l.def === 'flat' ? 0 : (psNum((psEl('ps-growth') || {}).value) || 5);
  const growth = ov.growth == null ? defPct : (ov.growth - 1) * 100;
  const amount = typed ? (ov.typed == null ? '' : ov.typed) : (computed ? computed.amount : 0);
  return `<tr>
    <td>${l.name}</td>
    <td style="text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${psFmt(l.py)}</td>
    <td><input type="number" step="0.5" value="${typed ? '' : growth}" ${typed ? 'placeholder="—" disabled' : ''}
               onchange="psRuleSet('${l.key}','growthPct',this.value)" style="width:88px;" /></td>
    <td style="text-align:right;">
      <input type="number" step="0.01" value="${amount === '' ? '' : Number(amount).toFixed(2)}"
             onchange="psRuleSet('${l.key}','typed',this.value)"
             style="width:150px; text-align:right; font-variant-numeric:tabular-nums;" />
    </td>
    <td style="width:40px;">${typed
      ? `<button class="btn btn-outline btn-sm" title="Back to growth" onclick="psRuleSet('${l.key}','reset','')">↺</button>`
      : (l.custom ? `<button class="btn btn-outline btn-sm" title="Remove line" onclick="psRemoveCustom('${l.key}','${l.custom === 'direct' ? 'direct' : 'other'}')">✕</button>` : '')}</td>
  </tr>`;
}

function psRuleSet(key, field, v) {
  const ov = psRules[key] || (psRules[key] = {});
  if (field === 'growthPct') {
    const pct = psNum(v);
    ov.growth = 1 + pct / 100;
    ov.rule = pct === 0 ? 'flat' : 'growth';
    delete ov.typed;
  }
  else if (field === 'typed') { ov.rule = 'typed'; ov.typed = psNum(v); }
  else if (field === 'reset') { delete ov.rule; delete ov.typed; }
  psRun();
  psRenderRules();
}

// ── user-added expense lines ──
// A client's books carry heads this firm's template never listed. A line added
// here behaves exactly like one read off the prior-year file: same growth rule,
// same override, same place in note 3.15.
let psCustomSeq = 0;
function psAddCustomExpense() {
  const name = (psEl('ps-new-expense') || {}).value.trim();
  if (!name) { psStatus('Give the expense line a name first.', 'error'); return; }
  psCustom.push({ key: 'custom' + (++psCustomSeq), name, amount: 0 });
  psEl('ps-new-expense').value = '';
  psRun();
  psRenderRules();
  psStatus(`Added "${escHtml(name)}" to Other Expenses. Type its figure, or set a growth rate against last year.`, 'success');
}

function psAddCustomDirect() {
  const name = (psEl('ps-new-direct') || {}).value.trim();
  if (!name) { psStatus('Give the direct cost line a name first.', 'error'); return; }
  psDirectCustom.push({ key: 'direct' + (++psCustomSeq), name });
  psEl('ps-new-direct').value = '';
  psRun();
  psRenderRules();
  psStatus(`Added "${escHtml(name)}" to Direct costs — it lands in note 3.12, inside Materials Consumed.`, 'success');
}

function psRemoveCustom(key, where) {
  const list = where === 'direct' ? psDirectCustom : psCustom;
  const i = list.findIndex(c => c.key === key);
  if (i < 0) return;
  list.splice(i, 1);
  delete psRules[key];
  psRun();
  psRenderRules();
}

// ════════════════════════════════════════════════════════════════
//  TAX, TDS & VAT — every statutory figure derived by default, typed when the
//  preparer has the challan. A typed line loses its live Excel formula and
//  becomes a value, which is the honest representation of a figure that came
//  off a deposit slip rather than out of the accounts.
// ════════════════════════════════════════════════════════════════

const PS_TDS_LINES = [
  { k: 'salary',    label: 'TDS Payable-Salary (SST)',       of: '1% of Employee Benefits' },
  { k: 'rent',      label: 'TDS Payable-Rent',               of: '10% of Rent' },
  { k: 'incentive', label: 'TDS on Incentives',              of: '15% of Incentive Expenses' },
  { k: 'wages',     label: 'TDS Payable-Wages',              of: '1% of Labour Charges' },
  { k: 'auditFee',  label: 'TDS Payable-Audit fee',          of: '1.5% of Audit Fee' },
  { k: 'freight',   label: 'TDS Payable-Clearing & Freight', of: '1.5% of Clearing & Freight' },
];

function psRenderTax() {
  const host = psEl('ps-tax');
  if (!host) return;
  const r = psResult;
  const derivedAdv = r ? r.advanceTax.derived : 0;
  const vatOn = !!psCy.vatRegistered;

  const rows = PS_TDS_LINES.map(l => {
    const typed = psTds[l.k] != null && psTds[l.k] !== '';
    const shown = r ? r.tds[l.k] : 0;
    return `<tr>
      <td>${l.label}<div style="font-size:11px; color:var(--text-muted);">${l.of}</div></td>
      <td style="text-align:right;">
        <input type="number" step="0.01" value="${typed ? psTds[l.k] : (r ? Number(shown).toFixed(2) : '')}"
               onchange="psTdsSet('${l.k}', this.value)"
               style="width:150px; text-align:right; font-variant-numeric:tabular-nums;${typed ? '' : ' color:var(--text-muted);'}" />
      </td>
      <td style="width:40px;">${typed
        ? `<button class="btn btn-outline btn-sm" title="Back to the rate" onclick="psTdsSet('${l.k}','')">↺</button>` : ''}</td>
    </tr>`;
  }).join('');

  const advTyped = psCy.advanceTax != null && psCy.advanceTax !== '';
  const coiOn = psUseCoi();
  const itSrc = psSourceOf('itDepreciation');
  const c = r ? r.coi : null;
  const money = v => psFmt(v);

  // The Computation of Income — the bridge from accounting profit to taxable
  // income. Shown whenever it is on, so the tax figure on the statements can
  // be traced rather than taken on trust.
  const coiBlock = `
    <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:500;">
        <input type="checkbox" id="ps-use-coi" ${coiOn ? 'checked' : ''} style="width:auto;" onchange="psSetUseCoi(this.checked)" />
        Compute tax through a Computation of Income (adds the COI sheet)
      </label>
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">
        ${itSrc ? escHtml(itSrc.source) + (itSrc.stale ? ' — no schedule for this year yet, so last year&rsquo;s is used' : '')
                : 'No Income-Tax depreciation schedule found for this client. Without one the bridge deducts nothing.'}
      </div>
      ${coiOn ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr; gap:14px; margin-top:12px;">
        <div class="form-group" style="margin:0;">
          <label>Depreciation per Income Tax Act ${itSrc ? psSrcBadge() : ''}</label>
          <input type="number" step="0.01" value="${psCy.itDepreciation == null ? '' : psCy.itDepreciation}"
                 oninput="psFigureInput('itDepreciation', this.value)" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Brought-forward loss</label>
          <input type="number" step="0.01" value="${psCy.broughtForwardLoss == null ? '' : psCy.broughtForwardLoss}"
                 oninput="psFigureInput('broughtForwardLoss', this.value)" />
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">Enter as a positive figure; it reduces taxable income.</div>
        </div>
      </div>
      ${c ? `<div class="table-wrap" style="margin-top:12px;"><table class="client-table">
        <tbody>
          <tr><td>Net profit as per Income Statement</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(c.pbt)}</td></tr>
          <tr><td>Add: Depreciation per Accounting Standard</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(c.accountingDep)}</td></tr>
          <tr><td>Less: Depreciation per Income Tax Act</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(-c.itDep)}</td></tr>
          <tr><td>Add: Previous year Loss</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(-c.bfLoss)}</td></tr>
          <tr style="font-weight:600;"><td>Total taxable income</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(c.taxableProfit)}</td></tr>
          <tr style="font-weight:600;"><td>Provision for tax</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${money(c.tax)}</td></tr>
        </tbody></table></div>` : ''}` : ''}
    </div>`;

  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(2,1fr); gap:14px; align-items:start;">
      <div class="form-group" style="margin:0;">
        <label>Advance Tax ${advTyped ? '' : '<span class="log-badge badge-info" style="font-size:10px;">derived</span>'}</label>
        <input type="number" step="0.01" id="ps-adv-tax" value="${advTyped ? psCy.advanceTax : (r ? Number(r.advanceTax.amount).toFixed(2) : '')}"
               oninput="psFigureInput('advanceTax', this.value)" />
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
          Last year&rsquo;s advance tax less the provision it settled, plus TDS on this year&rsquo;s other income
          &mdash; ${psFmt(derivedAdv)}. Type over it if you have the challans.
        </div>
      </div>
      <div class="form-group" style="margin:0;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" ${vatOn ? 'checked' : ''} style="width:auto;" onchange="psSetVat(this.checked)" />
          Client is registered for VAT
        </label>
        ${vatOn ? `
        <div class="form-grid" style="grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
          <div class="form-group" style="margin:0;"><label>VAT Receivable</label>
            <input type="number" step="0.01" value="${psCy.vatReceivable == null ? '' : psCy.vatReceivable}"
                   oninput="psFigureInput('vatReceivable', this.value)" /></div>
          <div class="form-group" style="margin:0;"><label>VAT Payable</label>
            <input type="number" step="0.01" value="${psCy.vatPayable == null ? '' : psCy.vatPayable}"
                   oninput="psFigureInput('vatPayable', this.value)" /></div>
        </div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">Whichever side the return leaves the client on. The other stays blank and prints nothing.</div>`
        : `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">A PAN-only client carries no VAT line, so none is printed.</div>`}
      </div>
    </div>
    <div class="table-wrap" style="margin-top:16px;"><table class="client-table">
      <thead><tr><th style="width:55%;">Withholding</th><th style="text-align:right;">This year</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${coiBlock}`;
}

function psTdsSet(k, v) {
  if (v === '') delete psTds[k]; else psTds[k] = psNum(v);
  psRun();
  psRenderTax();
}

function psSetVat(on) {
  psCy.vatRegistered = !!on;
  if (!on) { delete psCy.vatReceivable; delete psCy.vatPayable; }
  psRun();
  psRenderTax();
}

// ════════════════════════════════════════════════════════════════
//  LOANS — the Projection repeater, verbatim in shape, because the user
//  already knows it and asked for it explicitly.
// ════════════════════════════════════════════════════════════════

function psSeedLoans() {
  if (psLoans.nc.length || psLoans.c.length) return;
  const items = (psPy && psPy.loanItems) || [];
  items.forEach(l => {
    const bucket = /current|overdraft|od|cc|hypo/i.test(l.name || '') && !/non.?current/i.test(l.name || '') ? 'c' : 'nc';
    psLoans[bucket].push({ name: l.name || 'Loan', amount: psNum(l.amount) });
  });
  if (!psLoans.nc.length) psLoans.nc.push({ name: 'Vehicle Loan', amount: 0 });
  if (!psLoans.c.length) psLoans.c.push({ name: 'Bank Overdrafts/Hypothecation', amount: 0 });
  psRenderLoans();
}

// Interest belongs on the Loans card: it is what the facilities above it cost,
// and reading a balance without its interest is how a finance cost quietly goes
// missing from a statement.
function psRenderInterest() {
  const host = psEl('ps-interest');
  if (!host) return;
  const box = (k, label, hint) => `
    <div class="form-group" style="margin:0;">
      <label>${label}</label>
      <input type="number" step="0.01" id="ps-fig-${k}" value="${psCy[k] == null ? '' : psCy[k]}"
             oninput="psFigureInput('${k}', this.value)" />
      ${hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${hint}</div>` : ''}
    </div>`;
  const total = psNum(psCy.interestTerm) + psNum(psCy.interestOD) + psNum(psCy.bankCharges);
  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">
      ${box('interestTerm', 'Interest on Term Loan', 'Against the non-current facilities above.')}
      ${box('interestOD', 'Interest on STL / CC / OD', 'Against the current facilities above.')}
      ${box('bankCharges', 'Bank Charges', '')}
    </div>
    <div style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">
      Finance Cost (note 3.14): <strong style="color:var(--brand-navy); font-variant-numeric:tabular-nums;">${psFmt(total)}</strong>
    </div>`;
}

function psRenderLoans() {
  psRenderInterest();
  [['nc', 'Non-Current'], ['c', 'Current']].forEach(([kind, label]) => {
    const host = psEl('ps-loans-' + kind);
    if (!host) return;
    host.innerHTML = psLoans[kind].map((l, i) => `
      <div class="pj-loan-row" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:8px; flex-wrap:wrap;">
        <div class="form-group" style="margin:0;"><label>Facility</label>
          <input type="text" value="${escHtml(l.name || '')}" onchange="psLoanEdit('${kind}',${i},'name',this.value)" style="width:260px;" /></div>
        <div class="form-group" style="margin:0;"><label>Balance (Rs)</label>
          <input type="number" step="0.01" value="${psNum(l.amount)}" onchange="psLoanEdit('${kind}',${i},'amount',this.value)" style="width:160px;" /></div>
        <button class="btn btn-outline btn-sm" onclick="psLoanRemove('${kind}',${i})">Remove</button>
      </div>`).join('');
  });
}

function psAddLoanRow(kind) { psLoans[kind].push({ name: '', amount: 0 }); psRenderLoans(); psRecalcDebounced(); }
function psLoanRemove(kind, i) { psLoans[kind].splice(i, 1); psRenderLoans(); psRecalcDebounced(); }
function psLoanEdit(kind, i, field, v) {
  const l = psLoans[kind][i];
  if (!l) return;
  l[field] = field === 'amount' ? psNum(v) : v;
  psRecalcDebounced();
}

// The figure boxes on the Loans card write into the same psCy the main grid
// does, so a redraw of one must not blank the other.
function psInterestInput(k, v) { psFigureInput(k, v); }

// ════════════════════════════════════════════════════════════════
//  SOLVE
// ════════════════════════════════════════════════════════════════

// COI is on when there is an Income-Tax depreciation schedule to bridge to.
// The checkbox overrides in either direction once the preparer touches it.
function psUseCoi() {
  const el = psEl('ps-use-coi');
  if (el && el.dataset.touched === '1') return el.checked;
  return !!(psItDep || psNum(psCy.itDepreciation));
}

function psSetUseCoi(on) {
  const el = psEl('ps-use-coi');
  if (el) el.dataset.touched = '1';
  psRun();
  psRenderFigures();
  psRenderTax();
}

function psCollectInput() {
  const p = psPy || {};
  const flat = ProvisionalStatementEngine.FLAT_LINES;
  return {
    py: {
      sales: p.soi && p.soi.revenueOps, otherIncome: p.soi && p.soi.otherIncome,
      interestIncome: p.soi && p.soi.interestIncome,
      closingStock: (p.materials && p.materials.closing) || (p.sfp && p.sfp.inventories),
      labour: psPyDirect('labour'), freight: psPyDirect('freight'),
      salary: p.salary, otherContrib: 0,
      incentiveExpense: 0,   // the dedicated row is retired; add one as an Other Expense
      taxExpense: p.soi && p.soi.tax,
      advanceTax: (p.receivableItems || []).reduce((s, r) => s + (/advance|tds/i.test(r.name || '') ? psNum(r.amount) : 0), 0),
      otherExpenses: (p.otherItems || []).map((e, i) => ({
        key: e.key || ('other' + i), name: e.name, amount: e.amount,
        flat: flat.indexOf(e.key) >= 0,
      })).concat(psCustom.map(c => ({ key: c.key, name: c.name, amount: 0 }))),
      directExtra: psDirectCustom.map(d => ({ key: d.key, name: d.name, amount: 0 })),
      ppeClasses: psPpeInput,
      receivables: p.sfp && p.sfp.receivables, inventories: p.sfp && p.sfp.inventories,
      payables: p.sfp && p.sfp.payables, cash: p.sfp && p.sfp.cash,
      shareCapital: p.sfp && p.sfp.shareCapital, reserves: p.sfp && p.sfp.reserves,
      loansNC: p.sfp && p.sfp.loansNC, loansC: p.sfp && p.sfp.loansC,
      investmentsNC: p.sfp && p.sfp.investmentsNC, investmentsC: p.sfp && p.sfp.investmentsC,
    },
    cy: Object.assign({}, psCy, {
      loansNC: psLoans.nc, loansC: psLoans.c,
      tds: psTds,
    }),
    rules: psRules,
    options: {
      growth: 1 + psNum((psEl('ps-growth') || {}).value || 5) / 100,
      taxProfile: (psEl('ps-tax-profile') || {}).value || 'corporate',
      balanceVia: psPlugReceivables ? 'receivables' : 'none',
      // The Computation of Income runs when the client has an Income-Tax
      // depreciation schedule, unless the preparer says otherwise.
      useCoi: psUseCoi(),
      // 'purchases' means the typed PBT is held and purchases balances to it.
      solveFor: psSolveFor,
    },
  };
}

function psCalculate() {
  if (!psPy) { psStatus('Upload the prior-year statement first.', 'error'); return; }
  psRun();
  psShowSection('review');
}

function psRun() {
  if (!psPy) return;
  psResult = ProvisionalStatementEngine.derive(psCollectInput());
  psReport = fsxBuildReport(psToOut(psResult));
  psRenderReview();
}

let psRecalcTimer = null;
function psRecalcDebounced() {
  clearTimeout(psRecalcTimer);
  psRecalcTimer = setTimeout(() => {
    psRun();
    psRenderRules();
    psRenderInterest();
    psRenderTax();
    psSyncSeesaw();
  }, 220);
}

// Refresh only the derived half of the see-saw. A full re-render would throw
// away the caret of whichever box the user is typing in — the same rule the
// Autobooks confirmation grid follows.
function psSyncSeesaw() {
  if (!psResult) return;
  const el = psEl(psSolveFor === 'purchases' ? 'ps-fig-purchases' : 'ps-fig-pbtTarget');
  if (el && el !== document.activeElement) {
    const v = psSolveFor === 'purchases' ? psResult.income.materials.purchases : psResult.income.pbt;
    el.value = Number(v).toFixed(2);
  }
  const rec = psEl('ps-fig-tradeReceivables');
  if (psPlugReceivables && rec && rec !== document.activeElement) {
    rec.value = Number(psResult.balance.tradeReceivables).toFixed(2);
  }
}

// Map the engine's output onto the shape fsxBuildReport() consumes. The
// export layer is shared with Audited Statement, so this is the one place
// the two modules have to agree.
function psToOut(r) {
  const fy = (psEl('ps-fy') || {}).value || '';
  const startY = parseInt(String(fy).slice(0, 4), 10);
  const cyEnd = isFinite(startY) ? startY + 1 : null;
  const asAt = y => {
    if (!y) return '';
    const end = NepaliLocale.fyEndBs(y - 1);
    const d = (end && end.day) || 31;
    const sfx = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th';
    return `${d}${sfx} Ashadh ${y}`;
  };
  const p = psPy || {};

  return {
    meta: {
      company: {
        name: (psEl('ps-company') || {}).value || '',
        address: (psEl('ps-address') || {}).value || '',
        pan: (psEl('ps-pan') || {}).value || '',
      },
      fy, fyPrev: isFinite(startY) ? `${startY - 1}-${String(startY).slice(2)}` : '',
      // A provisional set is seven sheets. The Computation of Income is the
      // eighth, and only for engagements that bridge accounting and Income-Tax
      // depreciation — see docs/modules/provisional-statement.md §2.3.
      omitCoi: !psUseCoi(),
      // 3.6 Share Capital states share COUNTS, which the note derives by
      // dividing the face value into the capital — so it can never disagree
      // with the balance sheet. Authorised is constitutional, not derivable,
      // so it is asked for and falls back to the issued count.
      shareFace: psNum((psEl('ps-face-value') || {}).value) || 100,
      authorisedShares: psNum((psEl('ps-auth-shares') || {}).value) || 0,
      basis: 'provisional',
      // The SOCE and the cash flow print whatever word this entity uses, so it
      // has to follow the tax profile rather than be fixed at the company one.
      terms: (() => {
        const prop = (psEl('ps-tax-profile') || {}).value === 'progressive';
        return {
          person: prop ? 'Proprietor' : 'Director/Chairman',
          distribution: psDistLabel(),
          capital: prop ? 'Capital Account' : 'Share Capital',
          entity: prop ? 'Proprietorship' : 'Private Limited Company',
        };
      })(),
      titles: (() => {
        // The Statement of Changes in Equity is NEVER titled "Provisional",
        // even on a provisional set — §15. Of the other three, whether the
        // word is printed is a house choice: the firm's T3 file prints it and
        // its second reference file does not, so it is offered as a switch.
        const pfx = (psEl('ps-title-provisional') || {}).checked === false ? '' : 'Provisional ';
        return {
          sfp: pfx + 'Statement of Financial Position',
          soi: pfx + 'Statement of Income',
          soce: 'Statement of Changes in Equity',
          socf: pfx + 'Statement of Cash Flows',
        };
      })(),
      asAtCy: asAt(cyEnd), asAtPy: asAt(startY),
      yearEndedCy: asAt(cyEnd), yearEndedPy: asAt(startY),
      // The period line carries the A.D. equivalent in brackets, the way every
      // statement the firm issues does.
      asAtLine: `As at ${asAt(cyEnd)}${psAdSuffix()}`,
      forYearLine: `For the year ended ${asAt(cyEnd)}${psAdSuffix()}`,
      // The 3.1 PPE note and the SOCE date their own rows rather than saying
      // "the year", so both ends of every movement are unambiguous.
      socOpenLabel: `Balance at 1st Shrawan, ${startY}`,
      socCloseLabel: `Balance at ${asAt(cyEnd).replace(/ Ashadh /, " Ashadh, ")}`,
      ppeOpenLabel: `Balance as at 1st Shrawan, ${startY}`,
      ppeCloseLabel: `Balance at ${asAt(cyEnd).replace(/ Ashadh /, ' Ashadh, ')}`,
      carryOpenLabel: `As at 1st Shrawan, ${startY}`,
      carryCloseLabel: `As at ${asAt(cyEnd).replace(/ Ashadh /, ' Ashadh, ')}`,
      depChargeLabel: `Depreciation Charged for the Year(${String(startY).slice(2)}/${String(cyEnd).slice(2)})`,
      place: 'Chitwan',
    },
    income: r.income,
    balance: r.balance,
    cashflow: r.cashflow,
    soce: {
      open:  { shareCapital: psNum(p.sfp && p.sfp.shareCapital), sharePremium: 0, retained: r.soce.open, otherReserves: 0 },
      close: { shareCapital: r.balance.shareCapital, sharePremium: 0, retained: r.soce.close, otherReserves: 0 },
      profit: r.soce.profit, capital: r.soce.capital, dividend: r.soce.dividend,
    },
    ppe: r.ppe,
    coi: {
      pbt: r.coi.pbt, depSlm: r.coi.accountingDep, depIncomeTax: r.coi.itDep,
      bfLoss: r.coi.bfLoss, taxableProfit: r.coi.taxableProfit,
      tax: r.tax.total, rule: r.tax.rule,
    },
    priorYear: {
      sfp: (p.sfp || {}),
      soi: Object.assign({}, p.soi || {}, { incentive: psPyIncentive() }),
    },
    issues: (r.issues || []).concat(psPyIssues),
  };
}

// ════════════════════════════════════════════════════════════════
//  STEP 3 — review, preview, export
// ════════════════════════════════════════════════════════════════

function psRenderReview() {
  const host = psEl('ps-review');
  if (!host || !psResult) return;
  const r = psResult;
  const row = (l, v, strong) => `<tr${strong ? ' style="font-weight:600;"' : ''}><td>${l}</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${psFmt(v)}</td></tr>`;
  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:1fr 1fr; gap:20px;">
      <div><table class="client-table"><tbody>
        ${row('Total Income', r.income.totalIncome, true)}
        ${row('Materials Consumed', r.income.materials.total)}
        ${row('Employee Benefits', r.income.employeeTotal)}
        ${row('Finance Cost', r.income.financeTotal)}
        ${row('Depreciation', r.income.depreciation)}
        ${row('Incentive Expenses', r.income.incentive)}
        ${row('Other Expenses', r.income.otherTotal)}
        ${row('Total Expenses', r.income.totalExpenses, true)}
        ${row('Profit Before Tax', r.income.pbt, true)}
        ${row(`Income Tax (${escHtml(r.tax.rule)})`, r.tax.total)}
        ${row('Net Profit', r.income.netProfit, true)}
      </tbody></table></div>
      <div><table class="client-table"><tbody>
        ${row('Total Assets', r.balance.totalAssets, true)}
        ${row('Total Equity', r.balance.totalEquity)}
        ${row('Total Liabilities', r.balance.totalLiabilities)}
        ${row('Total Equity &amp; Liabilities', r.balance.totalEquityLiab, true)}
        ${row('Balance check (should be nil)', r.balance.balanceGap, true)}
        ${row('Cash per balance sheet', r.balance.cash)}
        ${row('Cash per cash-flow statement', r.cashflow.closingCash)}
        ${row('Cash-flow check (should be nil)', r.cashflow.cashProof, true)}
      </tbody></table></div>
    </div>
    ${psIssuesHtml(r.issues)}`;
  psRenderPreview();
}

function psShowSheet(key) {
  psSheetKey = key;
  document.querySelectorAll('#ps-sheet-tabs .rep-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sheet === key));
  psRenderPreview();
}

function psRenderPreview() {
  const host = psEl('ps-preview');
  if (!host || !psReport) return;
  const sh = psReport.sheets.find(s => s.key === psSheetKey) || psReport.sheets[0];
  host.innerHTML = fsxPreviewHtml(sh, psReport.meta);
}

async function psDownloadExcel() {
  if (!psReport) { psStatus('Nothing to export yet.', 'error'); return; }
  try {
    const wb = fsxWriteWorkbook(psReport, ExcelJS);
    const buf = await wb.xlsx.writeBuffer();
    const name = `${(psEl('ps-company').value || 'Statement').replace(/[\\/:*?"<>|]/g, '')} ${(psEl('ps-fy').value || '')} Provisional.xlsx`;
    DocumentEngine.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    AuditLog.record('provisional_excel_generated', {
      module: 'provisionalStatement', clientName: psEl('ps-company').value, status: 'success',
      detail: { fiscalYear: psEl('ps-fy').value, sheets: psReport.sheets.length },
    });
    psStatus('Excel workbook generated.', 'success');
  } catch (e) {
    psStatus('Could not build the workbook: ' + e.message, 'error');
  }
}

function psPrint() {
  if (!psReport) { psStatus('Nothing to print yet.', 'error'); return; }
  const w = window.open('', '_blank');
  w.document.write(fsxReportHtmlDoc(psReport, { title: psEl('ps-company').value || 'Provisional Statement' }));
  w.document.close();
  w.focus();
}

function psShowSection(which) {
  ['setup', 'figures', 'review'].forEach(s => {
    const sec = psEl('ps-section-' + s);
    if (sec) sec.style.display = s === which ? '' : 'none';
    const btn = psEl('ps-step-' + s);
    if (btn) btn.classList.toggle('active', s === which);
  });
  if (which === 'review') psRun();
}
