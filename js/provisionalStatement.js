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
// Four groups, matching Projection's Loans card (user ask 2026-08-21): the
// preparer thinks in facility types, not balance-sheet headings. Short Term /
// OD / CC is the current side; the other three are non-current — the collector
// folds them back into the engine's loansC / loansNC shape.
let psLoans = { st: [], lt: [], pwc: [], hp: [] };
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
// Supporting schedules — detail that rolls up into the statements, so the
// figure is entered once as the working behind it rather than twice as a
// summary. Empty means "no schedule", and the plain typed box stands.
// (The advance-tax voucher schedule that used to sit beside it was removed
// 2026-08-21 by user decision — UI only; the engine still honours
// advanceTaxLines, so tools/psVerify.mjs keeps proving that path.)
let psStock = [];
// Extra note-3.9 / note-3.3 lines (user ask 2026-08-28) — the lines last
// year's note carried beyond the standard set (Salary Payable, Advance to
// Suppliers…) plus any added by hand. {name, pyName, py, amount}: `pyName`
// keeps the prior-year spelling so the comparative column survives a rename,
// `amount` is this year's typed balance (blank = nil).
let psExtraPay = [];
let psExtraRecv = [];
let psReconcile = null;      // last ProvisionalReconcile.run() output
// Tax card accordion — one section open at a time (user ask 2026-08-21).
// Safe to re-render on toggle: every figure in the panel lives in psCy /
// psTds, not the DOM, so a collapsed section loses nothing.
let psTaxOpen = 'adv';       // 'adv' | 'tds' | 'vat' | 'coi' | ''
// Which side the VAT return leaves the client on. The two figures never
// coexist, so the UI shows ONE box and this picks which key it writes.
// null = follow whichever key holds a value, then the Autobooks sign.
let psVatSide = null;
// The preparer's explicit COI on/off. This must be module state, not a DOM
// dataset flag: the checkbox unrenders with its collapsed section, and an
// override stored on the element would silently revert to the automatic rule.
let psCoiTouched = null;
// Trade receivables absorbs the balance by default, the way the Audited engine
// already works (§15). Untick it to type receivables and have any residual
// reported instead of absorbed.
let psPlugReceivables = true;
let psSheetKey = 'SFP';
let psDepSource = '';        // where the PPE grid came from, for the caption
// provisional_statements row id once saved/loaded — the projection_reports
// idiom: Save UPDATEs this row rather than inserting a sibling, and any
// clear nulls it so a stale id can never update the wrong client's record.
let psSavedId = null;

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
    // The SearchEngine contract is getList/renderItem/onSelect — this was
    // wired with source/render/onPick, which the engine silently ignores,
    // so the picker never showed a single result (found 2026-08-22).
    SearchEngine.attachAutocomplete(psEl('ps-client-search'), psEl('ps-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: it => psScope.select(it),
    });
    // Typing over the picked name detaches the screen from that client
    // record, so a later Save can't attach to it — the Projection rule.
    psEl('ps-client-search').addEventListener('input', () => { psScope.invalidate(); psSelectedClient = null; });
    psEl('ps-client-search').dataset.wired = '1';
  }
  psRenderPySummary();
  psRenderFigures();
  // Show/hide the company-only capital boxes for whatever entity the select
  // is sitting on (a re-open keeps the previous selection).
  const isCompany = psEntity() === 'private';
  document.querySelectorAll('#tab-provisionalStatement-panel .ps-cap-only')
    .forEach(el => { el.style.display = isCompany ? '' : 'none'; });
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
    psLoans = { st: [], lt: [], pwc: [], hp: [] };
    psCustom = []; psDirectCustom = []; psTds = {};
    psSrc = null; psItDep = null; psTypedOver = {};
    psStock = [];
    psExtraPay = []; psExtraRecv = [];
    psTaxOpen = 'adv'; psVatSide = null; psCoiTouched = null;
    psSolveFor = 'purchases'; psPlugReceivables = true;
    psSavedId = null;
    const f = psEl('ps-py-file'); if (f) f.value = '';
    // The capital boxes are per-client figures — clear them with the rest so
    // the next client can't inherit this one's share capital (§9).
    ['ps-cap-auth', 'ps-cap-issued', 'ps-cap-paid'].forEach(id => { const e = psEl(id); if (e) e.value = ''; });
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
    psEl('ps-tax-profile').value = profile === 'proprietorship' ? 'proprietorship'
      : profile === 'partnership' ? 'partnership' : 'private';
    psOnEntityChange();

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

// opts.keepTyped: resolve the sources for provenance badges, party detail
// and the reconcile checks WITHOUT writing a single figure — the restore
// path uses it, because a saved statement's own figures are the record and
// psApplySources would overwrite any of them the preparer never claimed.
async function psLoadSources(opts) {
  const keepTyped = !!(opts && opts.keepTyped);
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
    if (!keepTyped) psApplySources();
    psRenderFigures();
    psRun();
    if (keepTyped) return;

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
    await LibLoader.ensure('xlsx');
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
    psSeedExtraLines();
    psPrefillCapital();
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

// ── entity ──
// One select carries both the entity and the tax rule (user ask 2026-08-28,
// splitting the old corporate/progressive pair three ways): a partnership
// taxes like a company but its note 3.6 reads "Partners Capital", not three
// share-capital sections. The two legacy values map so saved records restore.
function psEntity() {
  const v = (psEl('ps-tax-profile') || {}).value || 'private';
  if (v === 'corporate') return 'private';
  if (v === 'progressive') return 'proprietorship';
  return v;
}

// The Authorized/Issued/Paid-Up boxes (and the face value) are meaningless
// off a company, so they show only there; a proprietorship or partnership
// carries one capital line the balance sheet already holds.
function psOnEntityChange() {
  const isCompany = psEntity() === 'private';
  document.querySelectorAll('#tab-provisionalStatement-panel .ps-cap-only')
    .forEach(el => { el.style.display = isCompany ? '' : 'none'; });
  psPrefillCapital();
  psRenderFigures();
  psRecalcDebounced();
}

// Prefill the three capital boxes from the prior-year statement — by default
// all three ARE the paid-up figure, which is what the firm's own notes print
// (user ask 2026-08-28: "pre filled by default which I should be able to
// change"). Only ever fills a blank box; a typed figure is never overwritten.
function psPrefillCapital() {
  if (psEntity() !== 'private' || !psPy) return;
  const paid = psNum(psCy.shareCapital != null ? psCy.shareCapital : (psPy.sfp && psPy.sfp.shareCapital));
  if (!paid) return;
  ['ps-cap-paid', 'ps-cap-issued', 'ps-cap-auth'].forEach(id => {
    const el = psEl(id);
    if (el && el.value === '') el.value = paid;
  });
}

// Paid-up IS the balance sheet's Share Capital — editing it moves both, so
// the note can never disagree with the face (the rule note 3.6 already keeps
// by deriving share counts from the capital).
function psCapPaidInput(v) {
  if (v === '') delete psCy.shareCapital; else psCy.shareCapital = psNum(v);
  psRecalcDebounced();
}

// A company pays a dividend; a proprietor takes drawings. Same row on the
// SOCE either way — only the word changes. A partnership says Dividend too
// (user decision 2026-08-28).
function psDistLabel() {
  return psEntity() === 'proprietorship' ? 'Drawings' : 'Dividend Paid';
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
      // Closing Stock can be the derived end of the profit/purchases see-saw
      // — shown solved, still fully editable (typing claims it back).
      const derivedStock = f.k === 'closingStock' && psSolveFor === 'closingStock';
      const val = plugged
        ? (derived && psResult ? Number(psResult.balance.tradeReceivables).toFixed(2) : '')
        : derivedStock && psResult ? Number(psResult.income.materials.closing).toFixed(2)
        : (psCy[f.k] == null ? '' : psCy[f.k]);
      const src = psSourceOf(f.k);
      return `
      <div class="form-group" style="margin:0;">
        <label>${f.label === '@DIST@' ? escHtml(psDistLabel()) : f.label} ${plugged || derivedStock ? tag(true) : ''}${src ? psSrcBadge() : ''}</label>
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
      <p style="font-size:11.5px; color:var(--text-muted); margin:0 0 10px;">One see-saw, three ends. Type the profit you need and Purchases balances to it; with a profit held, typing Purchases hands the balance to Closing Stock instead — and typing Closing Stock hands it back to Purchases. Whichever you touched last is held.</p>
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
  psRenderStock();
  psRenderExtras();
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
  if (which === 'pbt') {
    psCy.pbtTarget = v === '' ? null : psNum(v);
    if (psCy.pbtTarget == null) psSolveFor = 'pbt';
    else if (psSolveFor !== 'closingStock') psSolveFor = 'purchases';
  } else {
    psCy.purchases = v === '' ? null : psNum(v);
    // With a held profit, typing Purchases hands the balance to Closing
    // Stock (user ask 2026-08-22) — unless a stock schedule owns that
    // figure (§15), in which case the profit gives way, as before.
    psSolveFor = (psCy.pbtTarget != null && psCy.pbtTarget !== '' && !psStock.length)
      ? 'closingStock' : 'pbt';
  }
  psRecalcDebounced();
}

function psFigureInput(k, v) {
  psCy[k] = v === '' ? undefined : psNum(v);
  if (psSourceOf(k)) psClaimTyped(k);
  // Typing into a derived Closing Stock claims it — Purchases becomes the
  // balancer of the held profit again, so both stay fully editable.
  if (k === 'closingStock' && psSolveFor === 'closingStock') psSolveFor = 'purchases';
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

function psTaxToggle(sec) {
  psTaxOpen = psTaxOpen === sec ? '' : sec;
  psRenderTax();
}

// Which side the return leaves the client on: an explicit pick wins, then
// whichever key already holds a figure, then the register's own sign.
function psVatSideNow() {
  if (psVatSide) return psVatSide;
  if (psCy.vatPayable != null) return 'payable';
  if (psCy.vatReceivable != null) return 'receivable';
  if (psSrc && psSrc.vat) return psSrc.vat.payable ? 'payable' : 'receivable';
  return 'payable';
}

// Switching sides MOVES the figure rather than leaving it stranded on the
// hidden key — the two can never coexist, which is what keeps the engine's
// "both sides carry a figure" warning unreachable from this UI.
function psSetVatSide(side) {
  psVatSide = side === 'receivable' ? 'receivable' : 'payable';
  const from = psVatSide === 'payable' ? 'vatReceivable' : 'vatPayable';
  const to = psVatSide === 'payable' ? 'vatPayable' : 'vatReceivable';
  if (psCy[from] != null && psCy[to] == null) psCy[to] = psCy[from];
  delete psCy[from];
  psRun();
  psRenderTax();
}

function psRenderTax() {
  const host = psEl('ps-tax');
  if (!host) return;
  // Same caret rule as psRenderInterest: the Advance Tax and VAT boxes fire
  // oninput, so the debounced recalc must not rebuild this panel under the
  // preparer's fingers. Header summaries catch up on the next render after
  // blur; checkboxes and selects still re-render immediately.
  const focused = document.activeElement;
  if (host.contains(focused) && focused.tagName === 'INPUT' && focused.type !== 'checkbox') return;
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

  // One collapsible section. The whole panel re-renders on toggle, which is
  // safe because every figure here lives in psCy/psTds, never only the DOM.
  const section = (key, title, summary, body) => {
    const open = psTaxOpen === key;
    return `
    <div style="border:1px solid var(--border); border-radius:var(--radius); margin-bottom:10px; overflow:hidden;">
      <div onclick="psTaxToggle('${key}')" style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 14px; cursor:pointer;${open ? ' background:var(--bg-subtle, #f7f9fc);' : ''}">
        <div style="display:flex; align-items:center; gap:9px;">
          <span style="font-size:10px; color:var(--text-muted); display:inline-block; transform:rotate(${open ? '90deg' : '0deg'}); transition:transform .15s;">&#9654;</span>
          <strong style="font-size:13px; color:var(--brand-navy);">${title}</strong>
        </div>
        <div style="font-size:12px; color:var(--text-muted); font-variant-numeric:tabular-nums; text-align:right;">${summary}</div>
      </div>
      ${open ? `<div style="padding:12px 14px 14px; border-top:1px solid var(--border);">${body}</div>` : ''}
    </div>`;
  };

  // ── Advance Tax ──
  const advBody = `
    <div class="form-group" style="margin:0; max-width:340px;">
      <label>Advance Tax ${advTyped ? '' : '<span class="log-badge badge-info" style="font-size:10px;">derived</span>'}</label>
      <input type="number" step="0.01" id="ps-adv-tax" value="${advTyped ? psCy.advanceTax : (r ? Number(r.advanceTax.amount).toFixed(2) : '')}"
             oninput="psFigureInput('advanceTax', this.value)" onchange="psRenderTax()" />
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
        Last year&rsquo;s advance tax less the provision it settled, plus TDS on this year&rsquo;s other income
        &mdash; ${psFmt(derivedAdv)}. Type over it if you have the challans.
      </div>
    </div>`;
  const advShown = advTyped ? psNum(psCy.advanceTax) : (r ? r.advanceTax.amount : 0);
  const advSummary = `${psFmt(advShown)} &middot; ${advTyped ? 'typed' : 'derived'}`;

  // ── TDS ──
  const tdsTyped = PS_TDS_LINES.filter(l => psTds[l.k] != null && psTds[l.k] !== '').length;
  const tdsTotal = r ? PS_TDS_LINES.reduce((s, l) => s + psNum(r.tds[l.k]), 0) : 0;
  const tdsBody = `
    <div class="table-wrap"><table class="client-table">
      <thead><tr><th style="width:55%;">Withholding</th><th style="text-align:right;">This year</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  const tdsSummary = `${psFmt(tdsTotal)}${tdsTyped ? ` &middot; ${tdsTyped} typed` : ''}`;

  // ── VAT — one side only ──
  const side = vatOn ? psVatSideNow() : null;
  const sideKey = side === 'receivable' ? 'vatReceivable' : 'vatPayable';
  const vSrc = vatOn ? psSourceOf(sideKey) : null;
  const vatBody = `
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
      <input type="checkbox" ${vatOn ? 'checked' : ''} style="width:auto;" onchange="psSetVat(this.checked)" />
      Client is registered for VAT
    </label>
    ${vatOn ? `
    <div class="form-grid" style="grid-template-columns:200px 1fr; gap:10px; margin-top:10px; max-width:440px;">
      <div class="form-group" style="margin:0;"><label>Position</label>
        <select onchange="psSetVatSide(this.value)">
          <option value="payable"${side === 'payable' ? ' selected' : ''}>VAT Payable</option>
          <option value="receivable"${side === 'receivable' ? ' selected' : ''}>VAT Receivable</option>
        </select></div>
      <div class="form-group" style="margin:0;"><label>Amount ${vSrc ? psSrcBadge() : ''}</label>
        <input type="number" step="0.01" value="${psCy[sideKey] == null ? '' : psCy[sideKey]}"
               oninput="psFigureInput('${sideKey}', this.value)" onchange="psRenderTax()" /></div>
    </div>
    ${vSrc ? psSrcNote(sideKey, vSrc) : `<div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">Payable when the return owes the office, Receivable when credit is carried &mdash; the other side prints nothing.</div>`}`
    : `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">A PAN-only client carries no VAT line, so none is printed.</div>`}`;
  const vatSummary = vatOn
    ? `${side === 'receivable' ? 'Receivable' : 'Payable'} ${psFmt(psNum(psCy[sideKey]))}`
    : 'Not registered';

  // (The Computation of Income section was removed 2026-08-28 by user
  // decision — tax always charges straight off accounting profit. The engine
  // still implements the COI bridge and tools/psVerify.mjs still proves it,
  // so restoring the section is a UI change only.)
  host.innerHTML =
    section('adv', 'Advance Tax', advSummary, advBody)
    + section('tds', 'TDS Withholdings', tdsSummary, tdsBody)
    + section('vat', 'VAT', vatSummary, vatBody);
}

// ════════════════════════════════════════════════════════════════
//  CLOSING STOCK — one amount per group line (user ask 2026-08-21, dropping
//  the qty × rate working). Each row's `amount` rides the engine's existing
//  amount-override, so the engine and note 3.4 grouping are unchanged: group
//  totals feed note 3.4, the grand total feeds Sch-PL's closing stock.
// ════════════════════════════════════════════════════════════════

const PS_STOCK_GROUPS = ['Raw Material', 'Work-in-progress', 'Finished Goods', 'Biological Assets', 'Consumables'];

function psRenderStock() {
  const host = psEl('ps-stock');
  if (!host) return;
  const r = psResult;
  const rows = psStock.map((l, i) => `<tr>
      <td><select onchange="psStockSet(${i},'group',this.value)" style="max-width:180px;">
        ${PS_STOCK_GROUPS.map(g => `<option${g === l.group ? ' selected' : ''}>${escHtml(g)}</option>`).join('')}
      </select></td>
      <td><input type="number" step="0.01" value="${l.amount == null ? '' : l.amount}" onchange="psStockSet(${i},'amount',this.value)" style="width:160px; text-align:right;" /></td>
      <td style="width:36px;"><button class="btn btn-outline btn-sm" onclick="psStockRemove(${i})">✕</button></td>
    </tr>`).join('');

  const groups = (r && r.stock.fromSchedule) ? r.stock.groups : [];
  host.innerHTML = `
    ${psStock.length ? `<div class="table-wrap" style="max-width:480px;"><table class="client-table">
      <thead><tr><th style="width:200px;">Group</th><th style="text-align:right; width:180px;">Amount</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:600;">
        <td>Grand Total &mdash; Sch-PL &amp; note 3.4</td>
        <td style="text-align:right; font-variant-numeric:tabular-nums;">${psFmt(r ? r.stock.total : 0)}</td><td></td>
      </tr></tfoot></table></div>
      ${groups.length ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">Note 3.4 will show: ${groups.map(g => escHtml(g.group) + ' ' + psFmt(g.amount)).join(' · ')}</div>` : ''}`
    : `<div style="color:var(--text-muted); font-size:13px; padding:4px 2px;">No stock schedule &mdash; Closing Stock is being taken from the typed figure above. Add lines here and the schedule becomes the figure.</div>`}
    <div style="margin-top:10px;"><button class="btn btn-outline btn-sm" onclick="psStockAdd()">+ Add stock line</button></div>`;
}

function psStockAdd() {
  // A stock schedule owns the closing-stock figure (§15) — it can no longer
  // be the see-saw's derived end.
  if (psSolveFor === 'closingStock') psSolveFor = 'purchases';
  psStock.push({ group: 'Finished Goods', amount: null });
  psRun(); psRenderStock(); psRenderFigures();
}
function psStockRemove(i) { psStock.splice(i, 1); psRun(); psRenderStock(); psRenderFigures(); }
function psStockSet(i, field, v) {
  const l = psStock[i];
  if (!l) return;
  l[field] = field === 'group' ? v : (v === '' ? null : psNum(v));
  psRun(); psRenderStock(); psRenderFigures();
}

// ════════════════════════════════════════════════════════════════
//  EXTRA PAYABLE / RECEIVABLE LINES — notes 3.9 and 3.3 beyond the standard
//  set (user ask 2026-08-28, the other-expenses idiom: editable lines plus
//  add-line). Seeded from whatever last year's note carried that the engine
//  doesn't already own (Salary Payable, Advance to Suppliers…); this year's
//  balance is typed. Trade Payables / Trade Receivables stay in the figures
//  card, Audit Fee Payable and the TDS lines stay derived.
//  (This card replaced the read-only Party Detail & Reconciliation panel,
//  removed the same day by user decision.)
// ════════════════════════════════════════════════════════════════

// The engine's own 3.9 / 3.3 lines. A prior-year line matching one of these
// must NOT be seeded as an extra, or it would print twice.
function psIsStandardPayable(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(payables?|on)\b/g, '').replace(/\s+/g, '');
  return !n || n === 'trade' || n === 'auditfee' || /^tds|^vat/.test(n);
}
function psIsStandardReceivable(name) {
  const n = String(name || '').toLowerCase();
  return !String(name || '').trim() || /advance tax|^vat|trade receivable|impair/.test(n);
}

function psSeedExtraLines() {
  if (!psPy) return;
  if (!psExtraPay.length) {
    psExtraPay = (psPy.payableItems || [])
      .filter(l => !psIsStandardPayable(l.name))
      .map(l => ({ name: l.name, pyName: l.name, py: psNum(l.amount), amount: null }));
  }
  if (!psExtraRecv.length) {
    psExtraRecv = (psPy.receivableItems || [])
      .filter(l => !psIsStandardReceivable(l.name))
      .map(l => ({ name: l.name, pyName: l.name, py: psNum(l.amount), amount: null }));
  }
}

function psRenderExtras() {
  const host = psEl('ps-extras');
  if (!host) return;
  // Same caret rule as the tax panel: these boxes fire onchange, but a
  // debounced re-render mid-typing would still throw the caret away.
  const focused = document.activeElement;
  if (host.contains(focused) && focused.tagName === 'INPUT') return;
  const block = (title, list, kind, addLabel) => `
    <div style="margin-top:${title.startsWith('3.9') ? '0' : '16px'};">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:6px;">${title}</div>
      ${list.length ? `<div class="table-wrap"><table class="client-table">
        <thead><tr><th>Line</th><th style="text-align:right; width:160px;">Last year</th><th style="text-align:right; width:180px;">This year</th><th style="width:36px;"></th></tr></thead>
        <tbody>${list.map((l, i) => `<tr>
          <td><input type="text" value="${escHtml(l.name || '')}" onchange="psExtraSet('${kind}',${i},'name',this.value)" style="width:100%; min-width:180px;" /></td>
          <td style="text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${psFmt(psNum(l.py))}</td>
          <td style="text-align:right;"><input type="number" step="0.01" value="${l.amount == null ? '' : l.amount}" placeholder="0.00"
                 onchange="psExtraSet('${kind}',${i},'amount',this.value)" style="width:160px; text-align:right; font-variant-numeric:tabular-nums;" /></td>
          <td><button class="btn btn-outline btn-sm" onclick="psExtraRemove('${kind}',${i})">✕</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`
      : `<div style="color:var(--text-muted); font-size:12.5px; padding:2px 2px 6px;">No extra lines — the note carries only its standard rows.</div>`}
      <div style="margin-top:8px;"><button class="btn btn-outline btn-sm" onclick="psExtraAdd('${kind}')">${addLabel}</button></div>
    </div>`;
  host.innerHTML =
    block('3.9 Trade &amp; Other Payables — extra lines', psExtraPay, 'pay', '+ Add payable line')
    + block('3.3 Trade &amp; Other Receivables — extra lines', psExtraRecv, 'recv', '+ Add receivable line');
}

function psExtraList(kind) { return kind === 'pay' ? psExtraPay : psExtraRecv; }
function psExtraAdd(kind) {
  psExtraList(kind).push({ name: '', pyName: '', py: 0, amount: null });
  psRun(); psRenderExtras();
}
function psExtraRemove(kind, i) {
  psExtraList(kind).splice(i, 1);
  psRun(); psRenderExtras();
}
function psExtraSet(kind, i, field, v) {
  const l = psExtraList(kind)[i];
  if (!l) return;
  l[field] = field === 'amount' ? (v === '' ? null : psNum(v)) : v;
  psRun(); psRenderExtras();
}

function psTdsSet(k, v) {
  if (v === '') delete psTds[k]; else psTds[k] = psNum(v);
  psRun();
  psRenderTax();
}

function psSetVat(on) {
  psCy.vatRegistered = !!on;
  if (!on) { delete psCy.vatReceivable; delete psCy.vatPayable; psVatSide = null; }
  psRun();
  psRenderTax();
}

// ════════════════════════════════════════════════════════════════
//  LOANS — the Projection repeater, verbatim in shape, because the user
//  already knows it and asked for it explicitly.
// ════════════════════════════════════════════════════════════════

function psSeedLoans() {
  if (PS_LOAN_KINDS.some(([k]) => psLoans[k].length)) return;
  const items = (psPy && psPy.loanItems) || [];
  items.forEach(l => {
    const n = l.name || '';
    // Most-specific first, the Projection rule: plain "WC Loan" is NOT
    // Permanent WC, and a vehicle/auto loan counts as Hire Purchase.
    let bucket = 'lt';
    if (/hire|\bhp\b|vehicle|auto/i.test(n)) bucket = 'hp';
    else if (/permanent|pwc/i.test(n)) bucket = 'pwc';
    else if (/current|overdraft|od|cc|hypo/i.test(n) && !/non.?current/i.test(n)) bucket = 'st';
    // `py` is what note 3.8's comparative column prints for the facility; the
    // amount box starts at the same figure and is edited to this year's.
    psLoans[bucket].push({ name: n || 'Loan', amount: psNum(l.amount), py: psNum(l.amount) });
  });
  if (!PS_LOAN_KINDS.some(([k]) => psLoans[k].length)) {
    psLoans.st.push({ name: 'Bank Overdrafts/Hypothecation', amount: 0, py: psNum(psPy && psPy.sfp && psPy.sfp.loansC) });
  }
  psRenderLoans();
}

// Interest belongs on the Loans card: it is what the facilities above it cost,
// and reading a balance without its interest is how a finance cost quietly goes
// missing from a statement.
function psRenderInterest() {
  const host = psEl('ps-interest');
  if (!host) return;
  const total = psNum(psCy.interestTerm) + psNum(psCy.interestOD) + psNum(psCy.bankCharges);
  // These boxes fire oninput, and the debounced recalc re-renders this block
  // 220ms into a pause — which destroyed the input mid-typing and made the
  // fields impossible to type into (user report 2026-08-22). While one of
  // them holds the caret, only the running total is patched in place — the
  // Autobooks confirmation-grid rule.
  const focused = document.activeElement;
  if (host.contains(focused) && focused.tagName === 'INPUT') {
    const t = psEl('ps-fin-total');
    if (t) t.textContent = psFmt(total);
    return;
  }
  const box = (k, label, hint) => `
    <div class="form-group" style="margin:0;">
      <label>${label}</label>
      <input type="number" step="0.01" id="ps-fig-${k}" value="${psCy[k] == null ? '' : psCy[k]}"
             oninput="psFigureInput('${k}', this.value)" />
      ${hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${hint}</div>` : ''}
    </div>`;
  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">
      ${box('interestTerm', 'Interest on Term Loan', 'Against the Long Term / PWC / HP facilities above.')}
      ${box('interestOD', 'Interest on STL / CC / OD', 'Against the Short Term / OD / CC facilities above.')}
      ${box('bankCharges', 'Bank Charges', '')}
    </div>
    <div style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">
      Finance Cost (note 3.14): <strong id="ps-fin-total" style="color:var(--brand-navy); font-variant-numeric:tabular-nums;">${psFmt(total)}</strong>
    </div>`;
}

const PS_LOAN_KINDS = [
  ['st', 'Short Term Loan / OD / CC'],
  ['lt', 'Long Term Loan'],
  ['pwc', 'Permanent Working Capital Loan'],
  ['hp', 'Hire Purchase (HP) Loan'],
];

function psRenderLoans() {
  psRenderInterest();
  PS_LOAN_KINDS.forEach(([kind, label]) => {
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
// The checkbox overrides in either direction once the preparer touches it —
// held in psCoiTouched, not on the element: the checkbox unrenders with its
// collapsed accordion section, and a DOM flag would silently revert the
// preparer's choice to the automatic rule.
function psUseCoi() {
  // The Computation of Income was removed 2026-08-28 by user decision — tax
  // always charges straight off accounting profit and no COI sheet prints.
  // The engine keeps the bridge (psVerify proves it); flipping this back on
  // is the whole restore.
  return false;
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
      otherExpenses: (p.otherItems || []).map((e, i) => {
        // Audit Fee and Rent are keyed by NAME so the engine's pick() and
        // FLAT_LINES find them — a positional 'other3' reached the engine
        // and Audit Fee Payable / TDS-Audit fee / TDS-Rent all derived to 0.
        const key = e.key || ProvisionalStatementEngine.headKeyFor(e.name) || ('other' + i);
        return { key, name: e.name, amount: e.amount, flat: flat.indexOf(key) >= 0 };
      }).concat(psCustom.map(c => ({ key: c.key, name: c.name, amount: 0 }))),
      directExtra: psDirectCustom.map(d => ({ key: d.key, name: d.name, amount: 0 })),
      ppeClasses: psPpeInput,
      receivables: p.sfp && p.sfp.receivables, inventories: p.sfp && p.sfp.inventories,
      payables: p.sfp && p.sfp.payables, cash: p.sfp && p.sfp.cash,
      shareCapital: p.sfp && p.sfp.shareCapital, reserves: p.sfp && p.sfp.reserves,
      loansNC: p.sfp && p.sfp.loansNC, loansC: p.sfp && p.sfp.loansC,
      investmentsNC: p.sfp && p.sfp.investmentsNC, investmentsC: p.sfp && p.sfp.investmentsC,
    },
    cy: Object.assign({}, psCy, {
      // The engine keeps its balance-sheet shape: Short Term / OD / CC is the
      // current side, the other three groups are non-current.
      loansNC: [...psLoans.lt, ...psLoans.pwc, ...psLoans.hp],
      loansC: psLoans.st,
      tds: psTds,
      stockLines: psStock,
      extraPayables: psExtraPay.map((l, i) => ({
        key: 'xpay' + i, name: l.name, pyName: l.pyName, py: psNum(l.py), amount: psNum(l.amount),
      })),
      extraReceivables: psExtraRecv.map((l, i) => ({
        key: 'xrecv' + i, name: l.name, pyName: l.pyName, py: psNum(l.py), amount: psNum(l.amount),
      })),
    }),
    rules: psRules,
    options: {
      growth: 1 + psNum((psEl('ps-growth') || {}).value || 5) / 100,
      taxProfile: psEntity() === 'proprietorship' ? 'progressive' : 'corporate',
      balanceVia: psPlugReceivables ? 'receivables' : 'none',
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
    psRenderStock();
    psRenderExtras();
    psSyncSeesaw();
  }, 220);
}

// Refresh only the derived half of the see-saw. A full re-render would throw
// away the caret of whichever box the user is typing in — the same rule the
// Autobooks confirmation grid follows.
function psSyncSeesaw() {
  if (!psResult) return;
  const seesaw = {
    purchases: ['ps-fig-purchases', psResult.income.materials.purchases],
    pbt: ['ps-fig-pbtTarget', psResult.income.pbt],
    closingStock: ['ps-fig-closingStock', psResult.income.materials.closing],
  }[psSolveFor];
  if (seesaw) {
    const el = psEl(seesaw[0]);
    if (el && el !== document.activeElement) el.value = Number(seesaw[1]).toFixed(2);
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
      // Note 3.6's three sections carry AMOUNTS the preparer can edit
      // (prefilled to the paid-up figure); blank falls back in the renderer.
      authorisedCapital: psNum((psEl('ps-cap-auth') || {}).value) || 0,
      issuedCapital: psNum((psEl('ps-cap-issued') || {}).value) || 0,
      basis: 'provisional',
      // The SOCE and the cash flow print whatever word this entity uses, so it
      // has to follow the entity select rather than be fixed at the company
      // one. The capital HEADING follows the entity too (user decision
      // 2026-08-28, reversing 2026-08-22's always-"Share Capital"): a
      // proprietorship's note 3.6 reads "Proprietors Capital", a
      // partnership's "Partners Capital" — the spellings the firm's own
      // statements use.
      terms: (() => {
        const ent = psEntity();
        return {
          person: ent === 'proprietorship' ? 'Proprietor' : ent === 'partnership' ? 'Partner' : 'Director/Chairman',
          distribution: psDistLabel(),
          capital: ent === 'proprietorship' ? 'Proprietors Capital'
            : ent === 'partnership' ? 'Partners Capital' : 'Share Capital',
          entity: ent === 'proprietorship' ? 'Proprietorship'
            : ent === 'partnership' ? 'Partnership Firm' : 'Private Limited Company',
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
    // The WHOLE parsePriorYear output travels to the export layer, not just
    // the two statement summaries: fsxBuildReport fills the comparative
    // detail of notes 3.3/3.9/3.12–3.15 (and the audited clone's cash flow)
    // from payableItems / receivableItems / materials / financeItems / socf.
    // Passing only { sfp, soi } is what left every prior-year note line
    // printing "–" under a filled total (user report 2026-08-28).
    priorYear: Object.assign({}, p, {
      sfp: (p.sfp || {}),
      soi: Object.assign({}, p.soi || {}, { incentive: psPyIncentive() }),
    }),
    issues: (r.issues || []).concat(psPyIssues),
  };
}

// ════════════════════════════════════════════════════════════════
//  SAVE / LOAD — provisional_statements, the projection_reports pattern:
//  identity snapshot columns for the picker, one `inputs` jsonb carrying
//  everything needed to rehydrate the screen, and the engine re-deriving
//  the statements on load — figures are never read back from a stored
//  total that could have drifted. Saving updates the SAME row for a
//  (company, fiscal year) rather than inserting a sibling.
// ════════════════════════════════════════════════════════════════

function psCollectSaveState() {
  const val = (id) => { const e = psEl(id); return e ? e.value : ''; };
  return {
    py: psPy, pyIssues: psPyIssues,
    cy: psCy, rules: psRules, ppe: psPpeInput, loans: psLoans,
    custom: psCustom, directCustom: psDirectCustom, tds: psTds,
    stock: psStock, extraPay: psExtraPay, extraRecv: psExtraRecv,
    typedOver: psTypedOver,
    vatSide: psVatSide, coiTouched: psCoiTouched,
    solveFor: psSolveFor, plugReceivables: psPlugReceivables,
    depSource: psDepSource,
    ui: {
      address: val('ps-address'), growth: val('ps-growth'),
      taxProfile: val('ps-tax-profile'), staff: val('ps-staff'),
      faceValue: val('ps-face-value'),
      capAuth: val('ps-cap-auth'), capIssued: val('ps-cap-issued'), capPaid: val('ps-cap-paid'),
      titleProvisional: (psEl('ps-title-provisional') || {}).checked !== false,
    },
  };
}

async function psSaveToDb(btn) {
  if (!psPy) {
    psStatus('Nothing to save yet — upload the prior-year statement first.', 'error');
    return;
  }
  const company = ((psEl('ps-company') || {}).value || '').trim();
  const fy = (psEl('ps-fy') || {}).value || '';
  if (!company || !fy) {
    psStatus('A company name and fiscal year are needed to save.', 'error');
    return;
  }
  const row = {
    client_id: psSelectedClient && psSelectedClient.id != null ? psSelectedClient.id : null,
    company_name: company,
    pan: (psEl('ps-pan') || {}).value || null,
    fiscal_year: fy,
    inputs: psCollectSaveState(),
  };
  // Busy-button contract (Stage 3) — the Save button itself carries the
  // in-flight state; the status line keeps the durable outcome message.
  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      psStatus('Saving to the database…', 'searching');
      // One row per (company, fiscal year): a save with no loaded row first
      // adopts an existing match, so a re-open-and-save can never duplicate.
      if (!psSavedId) {
        const { data, error } = await window.sb.from('provisional_statements')
          .select('id').ilike('company_name', company).eq('fiscal_year', fy).limit(1);
        if (error) throw error;
        if (data && data.length) psSavedId = data[0].id;
      }
      if (psSavedId) {
        // An update deliberately does not resend created_by — the projection idiom.
        const { error } = await window.sb.from('provisional_statements')
          .update(row).eq('id', psSavedId);
        if (error) throw error;
      } else {
        row.created_by = (window.currentUser || {}).email || null;
        const { data, error } = await window.sb.from('provisional_statements')
          .insert(row).select('id').single();
        if (error) throw error;
        psSavedId = data.id;
      }
      psStatus(`Saved provisional statement #${psSavedId} for ${escHtml(company)} (${escHtml(fy)}). Saving again updates this record.`, 'success');
      showToast(`✅ Provisional statement saved for <strong>${escHtml(company)}</strong> (${escHtml(fy)}).`, 'success');
      AuditLog.record('provisional_saved', {
        module: 'provisionalStatement', clientName: company, status: 'success',
        recordRef: psSavedId, detail: { fiscalYear: fy },
      });
    } catch (e) {
      console.error(e);
      psStatus('Could not save: ' + escHtml(friendlyDbError(e)), 'error');
    }
  });
}

// The shared saved-documents drawer (js/core/documentStore.js), the same
// {fetchRows, describe, onChoose, onDelete} shape Projection passes.
const PS_SAVED_COLS = 'id, client_id, company_name, pan, fiscal_year, created_by, created_at, updated_at';

function psOpenSavedDrawer() {
  DocumentStore.openPicker({
    label: 'Saved provisional statements',
    empty: 'Nothing saved yet. Use <strong>Save to Database</strong> on a statement and it will be listed here.',
    fetchRows: async () => {
      const { data, error } = await window.sb.from('provisional_statements')
        .select(PS_SAVED_COLS).order('updated_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    },
    describe: r => {
      const when = r.updated_at || r.created_at;
      const d = when ? new Date(when) : null;
      const stamp = d && !isNaN(d)
        ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      return {
        title: `${r.company_name || '—'} (F.Y. ${r.fiscal_year || '—'})`,
        meta: (stamp ? `saved ${stamp}` : '') + ` · ${r.created_by || 'not recorded'}`,
      };
    },
    onChoose: id => psLoadSaved(id),
    onDelete: async id => {
      const { error } = await window.sb.from('provisional_statements').delete().eq('id', id);
      if (error) throw error;
      // Orphan guard: a stale psSavedId would make the next Save issue an
      // UPDATE that silently matches nothing.
      if (psSavedId === id) psSavedId = null;
      AuditLog.record('provisional_deleted', {
        module: 'provisionalStatement', clientName: (psEl('ps-company') || {}).value || '',
        status: 'success', recordRef: id,
      });
    },
  });
}

// A saved statement may carry a fiscal year the select no longer offers —
// `sel.value = fy` on a missing option silently loads a DIFFERENT year than
// the one clicked (the depSetFyOption lesson).
function psSetFyOption(fy) {
  const sel = psEl('ps-fy');
  if (!sel || !fy) return;
  if (![...sel.options].some(o => o.value === fy)) {
    const o = document.createElement('option');
    o.value = o.textContent = fy;
    sel.appendChild(o);
  }
  sel.value = fy;
}

async function psLoadSaved(id) {
  psStatus('Loading saved provisional statement…', 'searching');
  try {
    const { data, error } = await window.sb.from('provisional_statements').select('*').eq('id', id).single();
    if (error) throw error;
    const inp = data.inputs || {};
    if (!inp.py) {
      psStatus('That saved record does not carry its prior-year statement, so it cannot be re-opened. Upload the workbook and save it again.', 'error');
      return;
    }
    // Clear through the scope so no path can leak the previous client's
    // figures under this record (§9), then rebuild the exact state saved.
    psScope.reset();
    psInit();
    psSavedId = data.id;
    psSelectedClient = (window.clientsList || []).find(c => c.id === data.client_id) || null;
    psEl('ps-company').value = data.company_name || '';
    psEl('ps-pan').value = data.pan || '';
    psEl('ps-client-search').value = data.company_name || '';
    psSetFyOption(data.fiscal_year);
    const ui = inp.ui || {};
    const set = (elId, v) => { const e = psEl(elId); if (e) e.value = v == null ? '' : v; };
    set('ps-address', ui.address);
    set('ps-growth', ui.growth);
    // Records saved before the 3-way entity select stored 'corporate' /
    // 'progressive'; psEntity() maps those, so setting the raw value on a
    // select that no longer carries it must not silently land on option one.
    const legacyTp = { corporate: 'private', progressive: 'proprietorship' };
    set('ps-tax-profile', legacyTp[ui.taxProfile] || ui.taxProfile || 'private');
    if (ui.staff) set('ps-staff', ui.staff);
    set('ps-face-value', ui.faceValue);
    set('ps-cap-auth', ui.capAuth);
    set('ps-cap-issued', ui.capIssued);
    set('ps-cap-paid', ui.capPaid);
    // A pre-2026-08-28 record stored an authorised SHARE COUNT instead.
    if (ui.capAuth == null && psNum(ui.authShares)) {
      set('ps-cap-auth', psNum(ui.authShares) * (psNum(ui.faceValue) || 100));
    }
    const tp = psEl('ps-title-provisional');
    if (tp) tp.checked = ui.titleProvisional !== false;

    psPy = inp.py; psPyIssues = inp.pyIssues || [];
    psCy = inp.cy || {}; psRules = inp.rules || {}; psPpeInput = inp.ppe || [];
    psLoans = inp.loans && inp.loans.st ? inp.loans : { st: [], lt: [], pwc: [], hp: [] };
    psCustom = inp.custom || []; psDirectCustom = inp.directCustom || [];
    psTds = inp.tds || {}; psStock = inp.stock || [];
    psExtraPay = inp.extraPay || []; psExtraRecv = inp.extraRecv || [];
    // A record saved before the extras existed still carries its prior-year
    // note lines — seed them so nothing silently drops off the comparative.
    psSeedExtraLines();
    psTypedOver = inp.typedOver || {};
    psVatSide = inp.vatSide || null; psCoiTouched = inp.coiTouched != null ? inp.coiTouched : null;
    psSolveFor = inp.solveFor || 'purchases';
    psPlugReceivables = inp.plugReceivables !== false;
    psDepSource = inp.depSource || '';

    // Sync the entity-dependent UI (capital boxes shown/hidden + prefilled)
    // now that both the select and psPy are restored.
    psOnEntityChange();
    psRenderPySummary();
    psRenderFigures();
    psRenderLoans();
    psShowSection('figures');
    // The derive runs in its own guard: the state above is already restored,
    // and a record that cannot derive should land the user on the figures
    // step with a message, not strand them on setup looking un-loaded.
    let derived = true;
    try { psRun(); } catch (e2) { console.error(e2); derived = false; }
    // Provenance, party detail and the register reconciliation come back
    // from live app data — but never overwrite the saved figures.
    psLoadSources({ keepTyped: true });
    psStatus(derived
      ? `Loaded saved provisional statement #${data.id} — change any figure and Save to update this record.`
      : `Loaded saved provisional statement #${data.id}, but the statements could not be re-derived from it — check the figures on this screen.`,
      derived ? 'success' : 'error');
  } catch (e) {
    console.error(e);
    psStatus('Could not load that statement: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  STEP 3 — review, preview, export
// ════════════════════════════════════════════════════════════════

// The reconciliation panel. Every check that fails says WHERE, because a
// difference nobody can locate is a difference nobody fixes.
function psRenderReconcile() {
  const host = psEl('ps-reconcile');
  if (!host) return;
  if (!psResult) { host.innerHTML = ''; return; }
  const rec = ProvisionalReconcile.run(psResult, { register: psSrc, priorYear: psPy });
  psReconcile = rec;

  const badge = c => c.ok
    ? '<span class="log-badge badge-success" style="font-size:10px;">reconciled</span>'
    : (c.level === 'review'
      ? '<span class="log-badge badge-warning" style="font-size:10px;">for review</span>'
      : '<span class="log-badge badge-error" style="font-size:10px;">not balancing</span>');

  const row = c => `<tr>
      <td>${escHtml(c.label)}</td>
      <td style="text-align:right; font-variant-numeric:tabular-nums; ${c.ok ? 'color:var(--text-muted);' : 'font-weight:600;'}">${psFmt(c.diff)}</td>
      <td style="width:120px;">${badge(c)}</td>
    </tr>${(!c.ok && c.where.length) ? `<tr><td colspan="3" style="padding-top:0; font-size:11.5px; color:var(--text-muted);">
      ${c.where.map(w => `<div style="margin:2px 0 0 12px;">&bull; ${escHtml(w)}</div>`).join('')}</td></tr>` : ''}`;

  host.innerHTML = `
    <div style="font-size:12.5px; margin-bottom:10px; color:${rec.allOk ? 'var(--green-dk)' : 'var(--text-muted)'};">
      ${escHtml(rec.summary)}${rec.allOk ? ' — everything ties.' : ''}
    </div>
    <div class="table-wrap"><table class="client-table">
      <thead><tr><th>Check</th><th style="text-align:right; width:170px;">Difference</th><th>Status</th></tr></thead>
      <tbody>${rec.checks.map(row).join('')}</tbody>
    </table></div>
    ${rec.reviewing.length ? `<div class="status-box status-info" style="margin-top:12px;">
      ${rec.reviewing.length} item${rec.reviewing.length > 1 ? 's need' : ' needs'} a person: the engine can say two figures disagree, not which one is right.
    </div>` : ''}`;
}

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
  psRenderReconcile();
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
    await LibLoader.ensure('exceljs');
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
