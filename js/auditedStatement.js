// ════════════════════════════════════════════════════════════════════════
//  AUDITED STATEMENT  (`as-`)
//
//  Automation Hub → Audited Statement. A VERBATIM CLONE of the Provisional
//  Statement module (js/provisionalStatement.js, `ps-`), made 2026-08-22 on
//  the user's explicit ask: "copy that module to audited too — same working
//  features, everything the same; the differences we will fix later." Keep
//  the two files in step until those differences are actually specified —
//  a fix landing in one of them almost certainly belongs in both.
//
//  Only four things differ from the source module, all mechanical:
//    - every `ps` prefix is `as` (functions, `let` state, AS_ constants,
//      element ids) so the two modules can share one global scope and DOM;
//    - it registers as `finStatement` on the old Audited panel/menu slot
//      (js/finStatement.js, the previous audited UI, is no longer loaded —
//      recoverable from git history);
//    - saves land in `financial_statements` with basis 'audited' (the table
//      already had the identical column shape), not provisional_statements;
//    - audit events are audited_* (labels in config.js).
//
//  Everything else — engine (ProvisionalStatementEngine), sources (psrc*),
//  reconciliation (ProvisionalReconcile), output (fsxBuildReport /
//  fsxWriteWorkbook / fsxPreviewHtml) — is SHARED with the provisional
//  module, not copied. `node tools/psVerify.mjs` therefore covers this
//  module's derivations too.
// ════════════════════════════════════════════════════════════════════════

ModuleRegistry.register({ id: 'finStatement', group: 'main', buttonId: null, panelId: 'tab-finStatement-panel' });

let asSelectedClient = null;
let asPy = null;             // FinStatementEngine.parsePriorYear() output
let asPyIssues = [];
let asResult = null;         // ProvisionalStatementEngine.derive() output
let asReport = null;         // fsxBuildReport() output
let asCy = {};               // this year's typed figures
let asRules = {};            // per-line rule overrides
let asPpeInput = [];         // editable 3.1 PPE grid
// Four groups, matching Projection's Loans card (user ask 2026-08-21): the
// preparer thinks in facility types, not balance-sheet headings. Short Term /
// OD / CC is the current side; the other three are non-current — the collector
// folds them back into the engine's loansC / loansNC shape.
let asLoans = { st: [], lt: [], pwc: [], hp: [] };
let asCustom = [];           // other-expense lines the user added by hand
let asDirectCustom = [];     // direct-cost lines the user added by hand
let asTds = {};              // per-line TDS overrides; blank means "derive it"
// What the app could resolve for this client-year without anyone typing it:
// { revenue, purchases, vat, parties, months, source } from Autobooks, plus
// the Income-Tax depreciation the COI bridge needs. Null when there is no
// source, in which case every figure stays typed exactly as before.
let asSrc = null;
let asItDep = null;
// Figures the preparer has deliberately taken back off the source. A key in
// here means "I typed this, stop auto-filling it" — nothing is ever silently
// overwritten once it has been claimed.
let asTypedOver = {};
// Supporting schedules — detail that rolls up into the statements, so the
// figure is entered once as the working behind it rather than twice as a
// summary. Empty means "no schedule", and the plain typed box stands.
// (The advance-tax voucher schedule that used to sit beside it was removed
// 2026-08-21 by user decision — UI only; the engine still honours
// advanceTaxLines, so tools/psVerify.mjs keeps proving that path.)
let asStock = [];
let asReconcile = null;      // last ProvisionalReconcile.run() output
// Tax card accordion — one section open at a time (user ask 2026-08-21).
// Safe to re-render on toggle: every figure in the panel lives in asCy /
// asTds, not the DOM, so a collapsed section loses nothing.
let asTaxOpen = 'adv';       // 'adv' | 'tds' | 'vat' | 'coi' | ''
// Which side the VAT return leaves the client on. The two figures never
// coexist, so the UI shows ONE box and this picks which key it writes.
// null = follow whichever key holds a value, then the Autobooks sign.
let asVatSide = null;
// The preparer's explicit COI on/off. This must be module state, not a DOM
// dataset flag: the checkbox unrenders with its collapsed section, and an
// override stored on the element would silently revert to the automatic rule.
let asCoiTouched = null;
// Trade receivables absorbs the balance by default, the way the Audited engine
// already works (§15). Untick it to type receivables and have any residual
// reported instead of absorbed.
let asPlugReceivables = true;
let asSheetKey = 'SFP';
let asDepSource = '';        // where the PPE grid came from, for the caption
// provisional_statements row id once saved/loaded — the projection_reports
// idiom: Save UPDATEs this row rather than inserting a sibling, and any
// clear nulls it so a stale id can never update the wrong client's record.
let asSavedId = null;

function asStatus(html, type) { showStatus(html, type, 'as-status-area'); }
function asEl(id) { return document.getElementById(id); }
// The A.D. equivalent the firm prints in brackets ("(16th July 2026)").
// NepaliLocale owns every calendar conversion in this app but only carries
// adToBs — there is no B.S.-to-A.D. table — so this is TYPED rather than
// computed. Inventing a conversion would put a wrong date on a signed
// statement, which is exactly the error this module exists to prevent.
function asAdSuffix() {
  const v = ((asEl('as-ad-date') || {}).value || '').trim();
  return v ? ` (${v})` : '';
}

function asFmt(v) {
  const n = Number(v);
  if (!isFinite(n) || Math.abs(n) < 0.005) return '–';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function asNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

function asInit() {
  asPopulateFy();
  asPopulateStaff();
  if (!asEl('as-client-search').dataset.wired) {
    // The SearchEngine contract is getList/renderItem/onSelect — this was
    // wired with source/render/onPick, which the engine silently ignores,
    // so the picker never showed a single result (found 2026-08-22).
    SearchEngine.attachAutocomplete(asEl('as-client-search'), asEl('as-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: it => asScope.select(it),
    });
    // Typing over the picked name detaches the screen from that client
    // record, so a later Save can't attach to it — the Projection rule.
    asEl('as-client-search').addEventListener('input', () => { asScope.invalidate(); asSelectedClient = null; });
    asEl('as-client-search').dataset.wired = '1';
  }
  asRenderPySummary();
  asRenderFigures();
}

// Fiscal-year list, read through the shared default so every module rolls
// over together on Shrawan 1 (§15 — FY_DEFAULT_START).
function asPopulateFy() {
  const sel = asEl('as-fy');
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

function asPopulateStaff() {
  const sel = asEl('as-staff');
  if (!sel) return;
  const staff = window.ARF_STAFF || [];
  sel.innerHTML = staff.map(s => `<option>${escHtml(s)}</option>`).join('');
}

// Client switching goes through a scope, so `clear()` runs unconditionally
// before every `load()` and no path can leak the previous client's figures
// onto this one's statement (§9).
const asScope = WorkflowEngine.createClientScope({
  clear(reason) {
    if (reason === 'client') {
      asSelectedClient = null;
      ['as-company', 'as-pan', 'as-address'].forEach(id => { const e = asEl(id); if (e) e.value = ''; });
    }
    const had = !!asPy;
    asPy = null; asPyIssues = [];
    asResult = null; asReport = null;
    asCy = {}; asRules = {}; asPpeInput = []; asDepSource = '';
    asLoans = { st: [], lt: [], pwc: [], hp: [] };
    asCustom = []; asDirectCustom = []; asTds = {};
    asSrc = null; asItDep = null; asTypedOver = {};
    asStock = [];
    asTaxOpen = 'adv'; asVatSide = null; asCoiTouched = null;
    asSolveFor = 'purchases'; asPlugReceivables = true;
    asSavedId = null;
    const f = asEl('as-py-file'); if (f) f.value = '';
    asRenderPySummary();
    asRenderFigures();
    asRenderLoans();
    asShowSection('setup');
    asStatus(had
      ? "Cleared the previous client's prior-year statement and figures — upload this client's file to continue."
      : '', 'info');
  },
  load(it) {
    asSelectedClient = it;
    asEl('as-company').value = it.name || '';
    asEl('as-pan').value = NepaliLocale.toEnglishDigits(it.pan || '');
    asEl('as-address').value = it.address || '';
    asEl('as-client-search').value = it.name || '';

    // entity_type is free text; the shared map is the one authority (§16).
    // ASSIGN unconditionally — an `if (mapped)` leaves the previous client's
    // tax profile standing when this one has none on file.
    const profile = (window.CLIENT_ENTITY_TO_REP_PROFILE || {})[String(it.entity_type || '').toLowerCase().trim()];
    asEl('as-tax-profile').value = profile === 'proprietorship' ? 'progressive' : 'corporate';

    asLoadDepreciation();
    asLoadSources();
    asStatus(`Client loaded: ${it.name}`, 'success');
  },
});

function asOnFyChange() {
  asLoadDepreciation();
  asLoadSources();
  asRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  SOURCES — figures this app already holds for the client and year.
//  Read-only (js/provisionalSources.js); a missing source is not an error,
//  it just leaves the figure typed.
// ════════════════════════════════════════════════════════════════

// opts.keepTyped: resolve the sources for provenance badges, party detail
// and the reconcile checks WITHOUT writing a single figure — the restore
// path uses it, because a saved statement's own figures are the record and
// asApplySources would overwrite any of them the preparer never claimed.
async function asLoadSources(opts) {
  const keepTyped = !!(opts && opts.keepTyped);
  const fy = (asEl('as-fy') || {}).value;
  const name = (asEl('as-company') || {}).value;
  const id = asSelectedClient ? asSelectedClient.id : null;
  if (!fy) return;
  try {
    const [reg, itDep] = await Promise.all([
      psrcRegister(id, name, fy),
      psrcItDepreciation(id, fy),
    ]);
    asSrc = reg;
    asItDep = itDep;
    if (!keepTyped) asApplySources();
    asRenderFigures();
    asRun();
    if (keepTyped) return;

    const got = [];
    if (reg) got.push(`revenue and purchases from ${reg.source}`);
    if (reg && reg.vat) got.push('the VAT position');
    if (itDep) got.push(itDep.stale ? `Income-Tax depreciation (${itDep.fiscalYear} — no schedule for this year yet)` : 'Income-Tax depreciation');
    if (got.length) {
      asStatus(`Filled ${got.join(', ')}. Each one shows where it came from and can be typed over.`, 'success');
    }
  } catch (e) { /* a missing source must never block the module */ }
}

// Push resolved figures into the typed boxes, EXCEPT any the preparer has
// claimed by typing. Same contract as Autobooks' VAT upload: a figure someone
// entered is never replaced without saying so.
function asApplySources() {
  const set = (k, v) => { if (!asTypedOver[k] && v != null) asCy[k] = Math.round(v * 100) / 100; };
  if (asSrc) {
    set('sales', asSrc.revenue.value);
    set('purchases', asSrc.purchases.value);
    if (asSrc.vat) {
      if (!asTypedOver.vatRegistered) asCy.vatRegistered = true;
      set('vatPayable', asSrc.vat.payable || null);
      set('vatReceivable', asSrc.vat.receivable || null);
    }
    // Purchases came from the register, so the see-saw must hold THAT and let
    // profit fall out — otherwise the derived purchases figure is immediately
    // overwritten by the balancing solve.
    if (!asTypedOver.pbtTarget && asCy.purchases != null) asSolveFor = 'pbt';
  }
  if (asItDep && !asTypedOver.itDepreciation) asCy.itDepreciation = Math.round(asItDep.value * 100) / 100;
}

// Where a figure came from, for the caption under its box.
function asSourceOf(k) {
  if (asTypedOver[k]) return null;
  if (!asSrc && !asItDep) return null;
  if (k === 'sales' && asSrc) return asSrc.revenue;
  if (k === 'purchases' && asSrc) return asSrc.purchases;
  if ((k === 'vatPayable' || k === 'vatReceivable') && asSrc && asSrc.vat) return asSrc.vat;
  if (k === 'itDepreciation' && asItDep) return asItDep;
  return null;
}

// Typing into a sourced box claims it; the ↺ hands it back to the source.
function asClaimTyped(k) { asTypedOver[k] = true; }
function asReleaseTyped(k) {
  delete asTypedOver[k];
  delete asCy[k];
  asApplySources();
  asRenderFigures();
  asRun();
}

// ════════════════════════════════════════════════════════════════
//  STEP 1 — prior year
// ════════════════════════════════════════════════════════════════

// The prior-year reader is the Audited engine's, reused wholesale: it already
// knows this workbook family's layout, and a second parser would be a second
// thing to keep in step with the firm's sheets.
async function asHandlePyFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  asStatus('Reading the prior-year statement…', 'searching');
  try {
    await LibLoader.ensure('xlsx');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const { py, issues } = FinStatementEngine.parsePriorYear(wb, XLSX);
    asPy = py;
    asPyIssues = issues;
    asRules = {};
    asPpeInput = [];
    asCustom = []; asDirectCustom = []; asTds = {};

    if (!asEl('as-company').value && py.company.name) asEl('as-company').value = py.company.name;
    if (!asEl('as-address').value && py.company.address) asEl('as-address').value = py.company.address;

    asRenderPySummary();
    if (issues.some(i => i.level === 'error')) {
      asStatus('The prior-year file is missing figures the statement needs — see below.', 'error');
      return;
    }
    asSeedPpe();
    asSeedLoans();
    asSeedFigures();
    asRenderFigures();
    AuditLog.record('audited_py_parsed', {
      module: 'finStatement', clientName: asEl('as-company').value, status: 'success',
      detail: { otherExpenseLines: py.otherItems.length, ppeClasses: py.ppe.classes.length },
    });
    asStatus('Prior-year statement read. Every expense line below now has a rule you can change.', 'success');
  } catch (e) {
    asStatus('Could not read that workbook: ' + e.message, 'error');
  }
}

function asRenderPySummary() {
  const box = asEl('as-py-summary');
  if (!box) return;
  if (!asPy) { box.innerHTML = ''; return; }
  const p = asPy;
  const rows = [
    ['Company', escHtml(p.company.name || '—')],
    ['Sales (revenue from operations)', asFmt(p.soi.revenueOps)],
    ['Other income', asFmt(p.soi.otherIncome)],
    ['Closing stock → this year&rsquo;s opening', asFmt(p.materials.closing || p.sfp.inventories)],
    ['Salary', asFmt(p.salary)],
    ['Other expense lines found', String((p.otherItems || []).length)],
    ['PPE classes found', String((p.ppe.classes || []).length)],
    ['Profit before tax', asFmt(p.soi.pbt)],
  ];
  box.innerHTML = `
    <table class="client-table" style="margin-top:4px;">
      <tbody>${rows.map(([k, v]) => `<tr><td style="width:60%;">${k}</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${v}</td></tr>`).join('')}</tbody>
    </table>
    ${asIssuesHtml(asPyIssues)}`;
}

function asIssuesHtml(issues) {
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

async function asLoadDepreciation() {
  if (!asSelectedClient || !window.sb) return;
  const fy = asEl('as-fy').value;
  try {
    // Same fallback rule as depSlmFetchUsefulLives(): this year's schedule if
    // there is one, else the most recent earlier year — a provisional set is
    // routinely drawn before the year's own schedule has been saved.
    const base = () => window.sb.from('depreciation_schedules')
      .select('pools, fiscal_year').eq('client_id', asSelectedClient.id).eq('scheme', 'slm');
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
      b.carrying  += asNum(p.closingWDV != null ? p.closingWDV : p._closingWDV);
      b.additions += asNum(p.addition);
      b.disposals += asNum(p.delCost);
    });
    if (!Object.keys(by).length) return;

    asPpeInput = ProvisionalStatementEngine.PPE_RATES
      .filter(r => by[r.key])
      .map(r => Object.assign({ key: r.key, name: r.name, rate: r.rate }, by[r.key]));
    asDepSource = `saved SLM schedule (${hit.fiscal_year})`;
    asRenderPpe();
    asRecalcDebounced();
    asStatus(`Depreciation seeded from the ${asDepSource}. Every figure below is still editable.`, 'success');
  } catch (e) { /* auto-fill is a convenience; never block the module on it */ }
}

// Fallback: the prior-year file's own 3.1 PPE note, matched to the rate table
// by name. A class the file doesn't carry is simply absent — empty heads are
// dropped, the same way Projection prunes its schedule.
function asSeedPpe() {
  if (asPpeInput.length) return;          // a saved SLM schedule already won
  const classes = (asPy && asPy.ppe && asPy.ppe.classes) || [];
  const rates = ProvisionalStatementEngine.PPE_RATES;
  const match = (name) => {
    const n = String(name || '').toLowerCase();
    return rates.find(r => n.includes(r.key)
      || r.name.toLowerCase().split(/[^a-z]+/).some(w => w.length > 3 && n.includes(w)));
  };
  asPpeInput = classes.map(c => {
    const r = match(c.name) || {};
    return {
      key: r.key || c.name, name: c.name || r.name,
      rate: r.rate == null ? 0 : r.rate,
      carrying: asNum(c.carrying), additions: 0, disposals: 0,
    };
  }).filter(c => c.carrying || c.additions);
  if (asPpeInput.length) asDepSource = "the prior-year file's 3.1 PPE note";
  asRenderPpe();
}

function asRenderPpe() {
  const host = asEl('as-ppe');
  if (!host) return;
  if (!asPpeInput.length) {
    host.innerHTML = `<div style="color:var(--text-muted); font-size:13px; padding:8px 2px;">No fixed-asset classes yet — upload the prior-year statement, or add a class below.</div>${asPpeAddHtml()}`;
    return;
  }
  const rows = asPpeInput.map((c, i) => {
    const closeCost = asNum(c.carrying) + asNum(c.additions) - asNum(c.disposals);
    const charge = closeCost * asNum(c.rate);
    return `<tr>
      <td class="dep-particular">${escHtml(c.name)}</td>
      <td><input type="number" step="0.01" value="${asNum(c.rate) * 100}" onchange="asPpeEdit(${i},'ratePct',this.value)" style="width:76px;" /></td>
      <td><input type="number" step="0.01" value="${asNum(c.carrying)}" onchange="asPpeEdit(${i},'carrying',this.value)" style="width:140px;" /></td>
      <td><input type="number" step="0.01" value="${asNum(c.additions)}" onchange="asPpeEdit(${i},'additions',this.value)" style="width:130px;" /></td>
      <td><input type="number" step="0.01" value="${asNum(c.disposals)}" onchange="asPpeEdit(${i},'disposals',this.value)" style="width:130px;" /></td>
      <td><input type="number" step="0.01" value="${c.depChargeOverride == null || c.depChargeOverride === '' ? Number(charge).toFixed(2) : c.depChargeOverride}"
                 onchange="asPpeEdit(${i},'depChargeOverride',this.value)" style="width:140px; text-align:right;" /></td>
      <td><input type="number" step="0.01" value="${c.carryingOverride == null || c.carryingOverride === '' ? Number(closeCost - charge).toFixed(2) : c.carryingOverride}"
                 onchange="asPpeEdit(${i},'carryingOverride',this.value)" style="width:150px; text-align:right;" /></td>
      <td style="white-space:nowrap;">
        ${(c.depChargeOverride != null && c.depChargeOverride !== '') || (c.carryingOverride != null && c.carryingOverride !== '')
          ? `<button class="btn btn-outline btn-sm" title="Back to the rate" onclick="asPpeReset(${i})">↺</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="asPpeRemove(${i})">✕</button></td>
    </tr>`;
  }).join('');
  const chargeOf = (c) => (c.depChargeOverride != null && c.depChargeOverride !== '')
    ? asNum(c.depChargeOverride)
    : (asNum(c.carrying) + asNum(c.additions) - asNum(c.disposals)) * asNum(c.rate);
  const totCharge = asPpeInput.reduce((s, c) => s + chargeOf(c), 0);
  host.innerHTML = `
    ${asDepSource ? `<div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">Seeded from ${escHtml(asDepSource)} — every figure is editable.</div>` : ''}
    <div class="table-wrap"><table class="client-table dep-table">
      <thead><tr>
        <th class="dep-particular">Class</th><th>Rate %</th>
        <th>Opening (last year&rsquo;s carrying)</th><th>Additions</th><th>Disposals</th>
        <th>Depreciation</th><th>Carrying at year end</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="dep-slm-ppe-strong">
        <td class="dep-particular">Total</td><td></td><td></td><td></td><td></td>
        <td class="dep-calc">${asFmt(totCharge)}</td><td class="dep-calc"></td><td></td>
      </tr></tfoot>
    </table></div>
    ${asPpeAddHtml()}`;
}

function asPpeAddHtml() {
  const have = new Set(asPpeInput.map(c => c.key));
  const opts = ProvisionalStatementEngine.PPE_RATES.filter(r => !have.has(r.key));
  if (!opts.length) return '';
  return `<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
    <select id="as-ppe-add" style="max-width:260px;">${opts.map(o => `<option value="${o.key}">${escHtml(o.name)} — ${o.rate * 100}%</option>`).join('')}</select>
    <button class="btn btn-outline btn-sm" onclick="asPpeAdd()">+ Add class</button>
  </div>`;
}

function asPpeAdd() {
  const key = (asEl('as-ppe-add') || {}).value;
  const r = ProvisionalStatementEngine.PPE_RATES.find(x => x.key === key);
  if (!r) return;
  asPpeInput.push({ key: r.key, name: r.name, rate: r.rate, carrying: 0, additions: 0, disposals: 0 });
  asRenderPpe();
  asRecalcDebounced();
}

function asPpeRemove(i) { asPpeInput.splice(i, 1); asRenderPpe(); asRecalcDebounced(); }

function asPpeEdit(i, field, v) {
  const c = asPpeInput[i];
  if (!c) return;
  if (field === 'ratePct') c.rate = asNum(v) / 100;
  // An override is stored as typed, so clearing the box returns the cell to
  // the rate rather than pinning it at zero.
  else if (field === 'depChargeOverride' || field === 'carryingOverride') c[field] = v === '' ? null : asNum(v);
  else c[field] = asNum(v);
  asRenderPpe();
  asRecalcDebounced();
}

function asPpeReset(i) {
  const c = asPpeInput[i];
  if (!c) return;
  c.depChargeOverride = null;
  c.carryingOverride = null;
  asRenderPpe();
  asRecalcDebounced();
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
const AS_FIGURES = [
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
function asDistLabel() {
  return ((asEl('as-tax-profile') || {}).value === 'progressive') ? 'Drawings' : 'Dividend Paid';
}

// Which of the pair was typed last. Editing either one makes the other the
// balancing figure, so there is never a stale "mode" to remember — the last
// thing touched is by definition the one the preparer means to hold.
// Names the figure the ENGINE solves — i.e. the balancing one. Defaults to
// 'purchases', so a typed Profit Before Tax is what is held. Kept as one
// meaning end to end: an inversion between here and the collector is exactly
// how the see-saw silently stopped moving the first time.
let asSolveFor = 'purchases';

// Seed the current-year boxes from last year plus the default growth. Only
// fills a box the user has not already typed into.
function asSeedFigures() {
  if (!asPy) return;
  const g = 1 + asNum((asEl('as-growth') || {}).value || 5) / 100;
  const src = {
    sales: asPy.soi && asPy.soi.revenueOps,
    otherIncome: asPy.soi && asPy.soi.otherIncome,
    closingStock: (asPy.materials && asPy.materials.closing) || (asPy.sfp && asPy.sfp.inventories),
    tradeReceivables: asPy.sfp && asPy.sfp.receivables,
    cash: asPy.sfp && asPy.sfp.cash,
    tradePayables: asPy.sfp && asPy.sfp.payables,
  };
  AS_FIGURES.filter(f => f.grow).forEach(f => {
    if (asCy[f.k] != null) return;
    const v = asNum(src[f.k]);
    if (v) asCy[f.k] = Math.round(v * g * 100) / 100;
  });

  // Profit opens at LAST YEAR'S MARGIN carried onto this year's turnover —
  //   profit(CY) = profit(PY) / sales(PY) x sales(CY)
  // — which is the firm's own first guess at a provisional profit. It is a
  // seed, not a rule: the box is editable, and typing in it is what makes
  // Purchases balance to it.
  if (asCy.pbtTarget == null) {
    const seeded = ProvisionalStatementEngine.pbtFromMargin(
      asPy.soi && asPy.soi.pbt, asPy.soi && asPy.soi.revenueOps, asCy.sales);
    if (seeded) asCy.pbtTarget = Math.round(seeded * 100) / 100;
  }
}

function asRenderFigures() {
  const host = asEl('as-figures');
  if (!host) return;
  const derived = asResult ? asResult.income : null;
  // The held side shows what was typed; the derived side shows what solved.
  const pbtVal = asSolveFor === 'purchases'
    ? (asCy.pbtTarget == null ? (derived ? derived.pbt : '') : asCy.pbtTarget)
    : (derived ? derived.pbt : '');
  const purVal = asSolveFor === 'purchases'
    ? (derived ? derived.materials.purchases : '')
    : (asCy.purchases == null ? '' : asCy.purchases);
  const tag = (on) => on
    ? '<span class="log-badge badge-info" style="margin-left:6px; font-size:10px;">balancing</span>' : '';

  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">` +
    AS_FIGURES.map(f => {
      const plugged = f.plug && asPlugReceivables;
      // Closing Stock can be the derived end of the profit/purchases see-saw
      // — shown solved, still fully editable (typing claims it back).
      const derivedStock = f.k === 'closingStock' && asSolveFor === 'closingStock';
      const val = plugged
        ? (derived && asResult ? Number(asResult.balance.tradeReceivables).toFixed(2) : '')
        : derivedStock && asResult ? Number(asResult.income.materials.closing).toFixed(2)
        : (asCy[f.k] == null ? '' : asCy[f.k]);
      const src = asSourceOf(f.k);
      return `
      <div class="form-group" style="margin:0;">
        <label>${f.label === '@DIST@' ? escHtml(asDistLabel()) : f.label} ${plugged || derivedStock ? tag(true) : ''}${src ? asSrcBadge() : ''}</label>
        <input type="number" step="0.01" id="as-fig-${f.k}" value="${val}" ${plugged ? 'readonly style="background:var(--bg-subtle);"' : ''}
               oninput="asFigureInput('${f.k}', this.value)" />
        ${src ? asSrcNote(f.k, src) : (f.hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${f.hint}</div>` : '')}
      </div>`; }).join('') + `</div>

    <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin-top:12px; cursor:pointer;">
      <input type="checkbox" ${asPlugReceivables ? 'checked' : ''} style="width:auto;" onchange="asSetPlug(this.checked)" />
      Balance the sheet through Trade Receivables
    </label>

    <div style="margin-top:18px; padding-top:14px; border-top:1px solid var(--border);">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:4px;">Profit &amp; Purchases</div>
      <p style="font-size:11.5px; color:var(--text-muted); margin:0 0 10px;">One see-saw, three ends. Type the profit you need and Purchases balances to it; with a profit held, typing Purchases hands the balance to Closing Stock instead — and typing Closing Stock hands it back to Purchases. Whichever you touched last is held.</p>
      <div class="form-grid" style="grid-template-columns:repeat(2,1fr); gap:14px;">
        <div class="form-group" style="margin:0;">
          <label>Profit Before Tax ${tag(asSolveFor === 'pbt')}</label>
          <input type="number" step="0.01" id="as-fig-pbtTarget" value="${pbtVal === '' ? '' : Number(pbtVal).toFixed(2)}"
                 oninput="asSetSolve('pbt', this.value)" />
        </div>
        <div class="form-group" style="margin:0;">
          <label>Purchases of Goods ${tag(asSolveFor === 'purchases')}</label>
          <input type="number" step="0.01" id="as-fig-purchases" value="${purVal === '' ? '' : Number(purVal).toFixed(2)}"
                 oninput="asSetSolve('purchases', this.value)" />
        </div>
      </div>
    </div>`;
  asRenderRules();
  asRenderPpe();
  asRenderTax();
  asRenderStock();
  asRenderParties();
}

function asSrcBadge() {
  return '<span class="log-badge badge-info" style="margin-left:6px; font-size:10px;">from data</span>';
}

// Provenance under a sourced box: where the figure came from, and the way back
// to typing it. A figure whose origin is invisible is one nobody trusts.
function asSrcNote(k, src) {
  return `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
    ${escHtml(src.source || 'app data')}${src.detail ? ` — ${escHtml(src.detail)}` : ''}
  </div>`;
}

// Editing one end of the see-saw makes the OTHER the balancing figure.
function asSetPlug(on) {
  asPlugReceivables = !!on;
  asRun();
  asRenderFigures();
}

function asSetSolve(which, v) {
  if (which === 'pbt') {
    asCy.pbtTarget = v === '' ? null : asNum(v);
    if (asCy.pbtTarget == null) asSolveFor = 'pbt';
    else if (asSolveFor !== 'closingStock') asSolveFor = 'purchases';
  } else {
    asCy.purchases = v === '' ? null : asNum(v);
    // With a held profit, typing Purchases hands the balance to Closing
    // Stock (user ask 2026-08-22) — unless a stock schedule owns that
    // figure (§15), in which case the profit gives way, as before.
    asSolveFor = (asCy.pbtTarget != null && asCy.pbtTarget !== '' && !asStock.length)
      ? 'closingStock' : 'pbt';
  }
  asRecalcDebounced();
}

function asFigureInput(k, v) {
  asCy[k] = v === '' ? undefined : asNum(v);
  if (asSourceOf(k)) asClaimTyped(k);
  // Typing into a derived Closing Stock claims it — Purchases becomes the
  // balancer of the held profit again, so both stay fully editable.
  if (k === 'closingStock' && asSolveFor === 'closingStock') asSolveFor = 'purchases';
  asRecalcDebounced();
}

// The rules grid: one row per expense line, showing last year's figure, the
// rule that carries it forward, and the resulting figure. Changing a rule to
// "Typed this year" reveals a box — which is how any single line escapes the
// pattern without the pattern being abandoned.
function asRenderRules() {
  const host = asEl('as-rules');
  if (!host) return;
  if (!asPy) { host.innerHTML = `<div style="color:var(--text-muted); font-size:13px;">Upload the prior-year statement to see the expense lines.</div>`; return; }

  const res = asResult;
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
        <tbody>${lines.map(l => asRuleRowHtml(l, lineOf(l.key))).join('')}</tbody>
      </table></div></div>`;
  };

  // Rent and Audit Fee arrive at 0% — the firm renegotiates them rather than
  // indexing them — and everything else at the default growth. Both are just
  // starting rates the user can change on the row.
  const flat = ProvisionalStatementEngine.FLAT_LINES;
  const otherLines = (asPy.otherItems || []).map((e, i) => ({
    key: e.key || ('other' + i), name: e.name, py: e.amount,
    def: flat.indexOf(e.key) >= 0 ? 'flat' : 'growth',
  })).concat(asCustom.map(c => ({ key: c.key, name: c.name, py: 0, def: 'growth', custom: true })));

  host.innerHTML =
    group('Direct costs', [
      { key: 'labour',  name: 'Labour Charges',                 py: asPyDirect('labour'),  def: 'growth' },
      { key: 'freight', name: 'Clearing &amp; Freight Expenses', py: asPyDirect('freight'), def: 'growth' },
    ].concat(asDirectCustom.map(d => ({ key: d.key, name: d.name, py: 0, def: 'growth', custom: 'direct' })))) +
    `<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
       <input type="text" id="as-new-direct" placeholder="New direct cost — e.g. Packing Charges"
              style="max-width:320px;" onkeydown="if(event.key==='Enter'){event.preventDefault();asAddCustomDirect();}" />
       <button class="btn btn-outline btn-sm" onclick="asAddCustomDirect()">+ Add direct cost</button>
     </div>` +
    group('Employee benefits', [
      { key: 'salary', name: 'Salary Expenses', py: asPy.salary, def: 'growth' },
    ]) +
    group('Other expenses', otherLines) +
    `<div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
       <input type="text" id="as-new-expense" placeholder="New expense line — e.g. Security Charges"
              style="max-width:320px;" onkeydown="if(event.key==='Enter'){event.preventDefault();asAddCustomExpense();}" />
       <button class="btn btn-outline btn-sm" onclick="asAddCustomExpense()">+ Add expense line</button>
     </div>`;
}

function asPyDirect(which) {
  const items = (asPy && asPy.materials && asPy.materials.directItems) || [];
  const re = which === 'labour' ? /labour|labor|wage/i : /clear|freight|carriage/i;
  const hit = items.find(i => re.test(i.name || ''));
  return hit ? hit.amount : 0;
}
function asPyIncentive() {
  // The prior-year SOI carries it as its own expense row; the reader keeps
  // unmatched rows on otherItems, so look in both.
  if (asPy && asPy.soi && asPy.soi.incentive) return asPy.soi.incentive;
  const hit = (asPy && asPy.otherItems || []).find(i => /incentive/i.test(i.name || ''));
  return hit ? hit.amount : 0;
}

// One row, two editable numbers: the growth rate, and the resulting figure.
// There is deliberately NO rule dropdown — every line is "last year + growth %",
// and typing a figure into the right-hand box overrides that line outright
// (shown as 0% so the override is visible rather than hidden behind a mode).
// Rent and Audit Fee simply arrive with a 0% default, which is what "flat"
// meant before; nothing about them is special-cased any more.
function asRuleRowHtml(l, computed) {
  const ov = asRules[l.key] || {};
  const typed = ov.rule === 'typed';
  const defPct = l.def === 'flat' ? 0 : (asNum((asEl('as-growth') || {}).value) || 5);
  const growth = ov.growth == null ? defPct : (ov.growth - 1) * 100;
  const amount = typed ? (ov.typed == null ? '' : ov.typed) : (computed ? computed.amount : 0);
  return `<tr>
    <td>${l.name}</td>
    <td style="text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${asFmt(l.py)}</td>
    <td><input type="number" step="0.5" value="${typed ? '' : growth}" ${typed ? 'placeholder="—" disabled' : ''}
               onchange="asRuleSet('${l.key}','growthPct',this.value)" style="width:88px;" /></td>
    <td style="text-align:right;">
      <input type="number" step="0.01" value="${amount === '' ? '' : Number(amount).toFixed(2)}"
             onchange="asRuleSet('${l.key}','typed',this.value)"
             style="width:150px; text-align:right; font-variant-numeric:tabular-nums;" />
    </td>
    <td style="width:40px;">${typed
      ? `<button class="btn btn-outline btn-sm" title="Back to growth" onclick="asRuleSet('${l.key}','reset','')">↺</button>`
      : (l.custom ? `<button class="btn btn-outline btn-sm" title="Remove line" onclick="asRemoveCustom('${l.key}','${l.custom === 'direct' ? 'direct' : 'other'}')">✕</button>` : '')}</td>
  </tr>`;
}

function asRuleSet(key, field, v) {
  const ov = asRules[key] || (asRules[key] = {});
  if (field === 'growthPct') {
    const pct = asNum(v);
    ov.growth = 1 + pct / 100;
    ov.rule = pct === 0 ? 'flat' : 'growth';
    delete ov.typed;
  }
  else if (field === 'typed') { ov.rule = 'typed'; ov.typed = asNum(v); }
  else if (field === 'reset') { delete ov.rule; delete ov.typed; }
  asRun();
  asRenderRules();
}

// ── user-added expense lines ──
// A client's books carry heads this firm's template never listed. A line added
// here behaves exactly like one read off the prior-year file: same growth rule,
// same override, same place in note 3.15.
let asCustomSeq = 0;
function asAddCustomExpense() {
  const name = (asEl('as-new-expense') || {}).value.trim();
  if (!name) { asStatus('Give the expense line a name first.', 'error'); return; }
  asCustom.push({ key: 'custom' + (++asCustomSeq), name, amount: 0 });
  asEl('as-new-expense').value = '';
  asRun();
  asRenderRules();
  asStatus(`Added "${escHtml(name)}" to Other Expenses. Type its figure, or set a growth rate against last year.`, 'success');
}

function asAddCustomDirect() {
  const name = (asEl('as-new-direct') || {}).value.trim();
  if (!name) { asStatus('Give the direct cost line a name first.', 'error'); return; }
  asDirectCustom.push({ key: 'direct' + (++asCustomSeq), name });
  asEl('as-new-direct').value = '';
  asRun();
  asRenderRules();
  asStatus(`Added "${escHtml(name)}" to Direct costs — it lands in note 3.12, inside Materials Consumed.`, 'success');
}

function asRemoveCustom(key, where) {
  const list = where === 'direct' ? asDirectCustom : asCustom;
  const i = list.findIndex(c => c.key === key);
  if (i < 0) return;
  list.splice(i, 1);
  delete asRules[key];
  asRun();
  asRenderRules();
}

// ════════════════════════════════════════════════════════════════
//  TAX, TDS & VAT — every statutory figure derived by default, typed when the
//  preparer has the challan. A typed line loses its live Excel formula and
//  becomes a value, which is the honest representation of a figure that came
//  off a deposit slip rather than out of the accounts.
// ════════════════════════════════════════════════════════════════

const AS_TDS_LINES = [
  { k: 'salary',    label: 'TDS Payable-Salary (SST)',       of: '1% of Employee Benefits' },
  { k: 'rent',      label: 'TDS Payable-Rent',               of: '10% of Rent' },
  { k: 'incentive', label: 'TDS on Incentives',              of: '15% of Incentive Expenses' },
  { k: 'wages',     label: 'TDS Payable-Wages',              of: '1% of Labour Charges' },
  { k: 'auditFee',  label: 'TDS Payable-Audit fee',          of: '1.5% of Audit Fee' },
  { k: 'freight',   label: 'TDS Payable-Clearing & Freight', of: '1.5% of Clearing & Freight' },
];

function asTaxToggle(sec) {
  asTaxOpen = asTaxOpen === sec ? '' : sec;
  asRenderTax();
}

// Which side the return leaves the client on: an explicit pick wins, then
// whichever key already holds a figure, then the register's own sign.
function asVatSideNow() {
  if (asVatSide) return asVatSide;
  if (asCy.vatPayable != null) return 'payable';
  if (asCy.vatReceivable != null) return 'receivable';
  if (asSrc && asSrc.vat) return asSrc.vat.payable ? 'payable' : 'receivable';
  return 'payable';
}

// Switching sides MOVES the figure rather than leaving it stranded on the
// hidden key — the two can never coexist, which is what keeps the engine's
// "both sides carry a figure" warning unreachable from this UI.
function asSetVatSide(side) {
  asVatSide = side === 'receivable' ? 'receivable' : 'payable';
  const from = asVatSide === 'payable' ? 'vatReceivable' : 'vatPayable';
  const to = asVatSide === 'payable' ? 'vatPayable' : 'vatReceivable';
  if (asCy[from] != null && asCy[to] == null) asCy[to] = asCy[from];
  delete asCy[from];
  asRun();
  asRenderTax();
}

function asRenderTax() {
  const host = asEl('as-tax');
  if (!host) return;
  // Same caret rule as asRenderInterest: the Advance Tax and VAT boxes fire
  // oninput, so the debounced recalc must not rebuild this panel under the
  // preparer's fingers. Header summaries catch up on the next render after
  // blur; checkboxes and selects still re-render immediately.
  const focused = document.activeElement;
  if (host.contains(focused) && focused.tagName === 'INPUT' && focused.type !== 'checkbox') return;
  const r = asResult;
  const derivedAdv = r ? r.advanceTax.derived : 0;
  const vatOn = !!asCy.vatRegistered;

  const rows = AS_TDS_LINES.map(l => {
    const typed = asTds[l.k] != null && asTds[l.k] !== '';
    const shown = r ? r.tds[l.k] : 0;
    return `<tr>
      <td>${l.label}<div style="font-size:11px; color:var(--text-muted);">${l.of}</div></td>
      <td style="text-align:right;">
        <input type="number" step="0.01" value="${typed ? asTds[l.k] : (r ? Number(shown).toFixed(2) : '')}"
               onchange="asTdsSet('${l.k}', this.value)"
               style="width:150px; text-align:right; font-variant-numeric:tabular-nums;${typed ? '' : ' color:var(--text-muted);'}" />
      </td>
      <td style="width:40px;">${typed
        ? `<button class="btn btn-outline btn-sm" title="Back to the rate" onclick="asTdsSet('${l.k}','')">↺</button>` : ''}</td>
    </tr>`;
  }).join('');

  const advTyped = asCy.advanceTax != null && asCy.advanceTax !== '';
  const coiOn = asUseCoi();
  const itSrc = asSourceOf('itDepreciation');
  const c = r ? r.coi : null;
  const money = v => asFmt(v);

  // One collapsible section. The whole panel re-renders on toggle, which is
  // safe because every figure here lives in asCy/asTds, never only the DOM.
  const section = (key, title, summary, body) => {
    const open = asTaxOpen === key;
    return `
    <div style="border:1px solid var(--border); border-radius:var(--radius); margin-bottom:10px; overflow:hidden;">
      <div onclick="asTaxToggle('${key}')" style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 14px; cursor:pointer;${open ? ' background:var(--bg-subtle, #f7f9fc);' : ''}">
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
      <input type="number" step="0.01" id="as-adv-tax" value="${advTyped ? asCy.advanceTax : (r ? Number(r.advanceTax.amount).toFixed(2) : '')}"
             oninput="asFigureInput('advanceTax', this.value)" onchange="asRenderTax()" />
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
        Last year&rsquo;s advance tax less the provision it settled, plus TDS on this year&rsquo;s other income
        &mdash; ${asFmt(derivedAdv)}. Type over it if you have the challans.
      </div>
    </div>`;
  const advShown = advTyped ? asNum(asCy.advanceTax) : (r ? r.advanceTax.amount : 0);
  const advSummary = `${asFmt(advShown)} &middot; ${advTyped ? 'typed' : 'derived'}`;

  // ── TDS ──
  const tdsTyped = AS_TDS_LINES.filter(l => asTds[l.k] != null && asTds[l.k] !== '').length;
  const tdsTotal = r ? AS_TDS_LINES.reduce((s, l) => s + asNum(r.tds[l.k]), 0) : 0;
  const tdsBody = `
    <div class="table-wrap"><table class="client-table">
      <thead><tr><th style="width:55%;">Withholding</th><th style="text-align:right;">This year</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  const tdsSummary = `${asFmt(tdsTotal)}${tdsTyped ? ` &middot; ${tdsTyped} typed` : ''}`;

  // ── VAT — one side only ──
  const side = vatOn ? asVatSideNow() : null;
  const sideKey = side === 'receivable' ? 'vatReceivable' : 'vatPayable';
  const vSrc = vatOn ? asSourceOf(sideKey) : null;
  const vatBody = `
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
      <input type="checkbox" ${vatOn ? 'checked' : ''} style="width:auto;" onchange="asSetVat(this.checked)" />
      Client is registered for VAT
    </label>
    ${vatOn ? `
    <div class="form-grid" style="grid-template-columns:200px 1fr; gap:10px; margin-top:10px; max-width:440px;">
      <div class="form-group" style="margin:0;"><label>Position</label>
        <select onchange="asSetVatSide(this.value)">
          <option value="payable"${side === 'payable' ? ' selected' : ''}>VAT Payable</option>
          <option value="receivable"${side === 'receivable' ? ' selected' : ''}>VAT Receivable</option>
        </select></div>
      <div class="form-group" style="margin:0;"><label>Amount ${vSrc ? asSrcBadge() : ''}</label>
        <input type="number" step="0.01" value="${asCy[sideKey] == null ? '' : asCy[sideKey]}"
               oninput="asFigureInput('${sideKey}', this.value)" onchange="asRenderTax()" /></div>
    </div>
    ${vSrc ? asSrcNote(sideKey, vSrc) : `<div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">Payable when the return owes the office, Receivable when credit is carried &mdash; the other side prints nothing.</div>`}`
    : `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">A PAN-only client carries no VAT line, so none is printed.</div>`}`;
  const vatSummary = vatOn
    ? `${side === 'receivable' ? 'Receivable' : 'Payable'} ${asFmt(asNum(asCy[sideKey]))}`
    : 'Not registered';

  // ── COI — the bridge from accounting profit to taxable income, shown
  //    whenever it is on so the tax figure can be traced rather than trusted ──
  const coiBody = `
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:500;">
      <input type="checkbox" id="as-use-coi" ${coiOn ? 'checked' : ''} style="width:auto;" onchange="asSetUseCoi(this.checked)" />
      Compute tax through a Computation of Income (adds the COI sheet)
    </label>
    <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">
      ${itSrc ? escHtml(itSrc.source) + (itSrc.stale ? ' — no schedule for this year yet, so last year&rsquo;s is used' : '')
              : 'No Income-Tax depreciation schedule found for this client. Without one the bridge deducts nothing.'}
    </div>
    ${coiOn ? `
    <div class="form-grid" style="grid-template-columns:1fr 1fr; gap:14px; margin-top:12px;">
      <div class="form-group" style="margin:0;">
        <label>Depreciation per Income Tax Act ${itSrc ? asSrcBadge() : ''}</label>
        <input type="number" step="0.01" value="${asCy.itDepreciation == null ? '' : asCy.itDepreciation}"
               oninput="asFigureInput('itDepreciation', this.value)" />
      </div>
      <div class="form-group" style="margin:0;">
        <label>Brought-forward loss</label>
        <input type="number" step="0.01" value="${asCy.broughtForwardLoss == null ? '' : asCy.broughtForwardLoss}"
               oninput="asFigureInput('broughtForwardLoss', this.value)" />
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
      </tbody></table></div>` : ''}` : ''}`;
  const coiSummary = coiOn ? (c ? `Provision ${asFmt(c.tax)}` : 'On') : 'Off &mdash; flat rate';

  host.innerHTML =
    section('adv', 'Advance Tax', advSummary, advBody)
    + section('tds', 'TDS Withholdings', tdsSummary, tdsBody)
    + section('vat', 'VAT', vatSummary, vatBody)
    + section('coi', 'Computation of Income', coiSummary, coiBody);
}

// ════════════════════════════════════════════════════════════════
//  CLOSING STOCK — one amount per group line (user ask 2026-08-21, dropping
//  the qty × rate working). Each row's `amount` rides the engine's existing
//  amount-override, so the engine and note 3.4 grouping are unchanged: group
//  totals feed note 3.4, the grand total feeds Sch-PL's closing stock.
// ════════════════════════════════════════════════════════════════

const AS_STOCK_GROUPS = ['Raw Material', 'Work-in-progress', 'Finished Goods', 'Biological Assets', 'Consumables'];

function asRenderStock() {
  const host = asEl('as-stock');
  if (!host) return;
  const r = asResult;
  const rows = asStock.map((l, i) => `<tr>
      <td><select onchange="asStockSet(${i},'group',this.value)" style="max-width:180px;">
        ${AS_STOCK_GROUPS.map(g => `<option${g === l.group ? ' selected' : ''}>${escHtml(g)}</option>`).join('')}
      </select></td>
      <td><input type="number" step="0.01" value="${l.amount == null ? '' : l.amount}" onchange="asStockSet(${i},'amount',this.value)" style="width:160px; text-align:right;" /></td>
      <td style="width:36px;"><button class="btn btn-outline btn-sm" onclick="asStockRemove(${i})">✕</button></td>
    </tr>`).join('');

  const groups = (r && r.stock.fromSchedule) ? r.stock.groups : [];
  host.innerHTML = `
    ${asStock.length ? `<div class="table-wrap" style="max-width:480px;"><table class="client-table">
      <thead><tr><th style="width:200px;">Group</th><th style="text-align:right; width:180px;">Amount</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:600;">
        <td>Grand Total &mdash; Sch-PL &amp; note 3.4</td>
        <td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(r ? r.stock.total : 0)}</td><td></td>
      </tr></tfoot></table></div>
      ${groups.length ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">Note 3.4 will show: ${groups.map(g => escHtml(g.group) + ' ' + asFmt(g.amount)).join(' · ')}</div>` : ''}`
    : `<div style="color:var(--text-muted); font-size:13px; padding:4px 2px;">No stock schedule &mdash; Closing Stock is being taken from the typed figure above. Add lines here and the schedule becomes the figure.</div>`}
    <div style="margin-top:10px;"><button class="btn btn-outline btn-sm" onclick="asStockAdd()">+ Add stock line</button></div>`;
}

function asStockAdd() {
  // A stock schedule owns the closing-stock figure (§15) — it can no longer
  // be the see-saw's derived end.
  if (asSolveFor === 'closingStock') asSolveFor = 'purchases';
  asStock.push({ group: 'Finished Goods', amount: null });
  asRun(); asRenderStock(); asRenderFigures();
}
function asStockRemove(i) { asStock.splice(i, 1); asRun(); asRenderStock(); asRenderFigures(); }
function asStockSet(i, field, v) {
  const l = asStock[i];
  if (!l) return;
  l[field] = field === 'group' ? v : (v === '' ? null : asNum(v));
  asRun(); asRenderStock(); asRenderFigures();
}

// ════════════════════════════════════════════════════════════════
//  PARTY DETAIL — the firm's `p` and `s` sheets, built from the register
//  rather than re-typed, and carrying the CA's own "As per books /
//  Difference" line rather than a new invention.
// ════════════════════════════════════════════════════════════════

function asRenderParties() {
  const host = asEl('as-parties');
  if (!host) return;
  if (!asSrc) {
    host.innerHTML = `<div style="color:var(--text-muted); font-size:13px; padding:4px 2px;">No saved Autobooks book for this client and fiscal year, so there is no party detail to show.</div>`;
    return;
  }
  const r = asResult;
  const side = (key, title, booksFigure, booksLabel) => {
    const list = Object.values(asSrc.parties[key] || {})
      .filter(p => Math.abs(p.amount) > 0.005)
      .sort((a, b) => b.amount - a.amount);
    const total = list.reduce((s, p) => s + p.amount, 0);
    const diff = total - booksFigure;
    return `<div style="margin-top:14px;">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:6px;">${title} &mdash; ${list.length} parties</div>
      <div class="table-wrap"><table class="client-table">
        <thead><tr><th style="width:130px;">PAN</th><th>Party Name</th><th style="text-align:right; width:160px;">Amount</th></tr></thead>
        <tbody>${list.slice(0, 12).map(p => `<tr>
          <td>${escHtml(p.pan || '—')}</td><td>${escHtml(p.name || '—')}</td>
          <td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(p.amount)}</td></tr>`).join('')}
          ${list.length > 12 ? `<tr><td colspan="2" style="color:var(--text-muted);">&hellip; and ${list.length - 12} more</td><td style="text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${asFmt(list.slice(12).reduce((s, p) => s + p.amount, 0))}</td></tr>` : ''}
        </tbody>
        <tfoot>
          <tr style="font-weight:600;"><td colspan="2">Total per party detail</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(total)}</td></tr>
          <tr><td colspan="2">${booksLabel}</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(booksFigure)}</td></tr>
          <tr style="font-weight:600; color:${Math.abs(diff) < 0.5 ? 'var(--green-dk)' : 'var(--red-dk)'};">
            <td colspan="2">Difference</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(diff)}</td></tr>
        </tfoot>
      </table></div></div>`;
  };
  host.innerHTML =
    side('purchase', 'Purchase / creditor detail', r ? r.income.materials.purchases : 0, 'As per books &mdash; Purchases of goods') +
    side('sales', 'Sales / debtor detail', r ? r.income.revenueOps : 0, 'As per books &mdash; Revenue from operations');
}

function asTdsSet(k, v) {
  if (v === '') delete asTds[k]; else asTds[k] = asNum(v);
  asRun();
  asRenderTax();
}

function asSetVat(on) {
  asCy.vatRegistered = !!on;
  if (!on) { delete asCy.vatReceivable; delete asCy.vatPayable; asVatSide = null; }
  asRun();
  asRenderTax();
}

// ════════════════════════════════════════════════════════════════
//  LOANS — the Projection repeater, verbatim in shape, because the user
//  already knows it and asked for it explicitly.
// ════════════════════════════════════════════════════════════════

function asSeedLoans() {
  if (AS_LOAN_KINDS.some(([k]) => asLoans[k].length)) return;
  const items = (asPy && asPy.loanItems) || [];
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
    asLoans[bucket].push({ name: n || 'Loan', amount: asNum(l.amount), py: asNum(l.amount) });
  });
  if (!AS_LOAN_KINDS.some(([k]) => asLoans[k].length)) {
    asLoans.st.push({ name: 'Bank Overdrafts/Hypothecation', amount: 0, py: asNum(asPy && asPy.sfp && asPy.sfp.loansC) });
  }
  asRenderLoans();
}

// Interest belongs on the Loans card: it is what the facilities above it cost,
// and reading a balance without its interest is how a finance cost quietly goes
// missing from a statement.
function asRenderInterest() {
  const host = asEl('as-interest');
  if (!host) return;
  const total = asNum(asCy.interestTerm) + asNum(asCy.interestOD) + asNum(asCy.bankCharges);
  // These boxes fire oninput, and the debounced recalc re-renders this block
  // 220ms into a pause — which destroyed the input mid-typing and made the
  // fields impossible to type into (user report 2026-08-22). While one of
  // them holds the caret, only the running total is patched in place — the
  // Autobooks confirmation-grid rule.
  const focused = document.activeElement;
  if (host.contains(focused) && focused.tagName === 'INPUT') {
    const t = asEl('as-fin-total');
    if (t) t.textContent = asFmt(total);
    return;
  }
  const box = (k, label, hint) => `
    <div class="form-group" style="margin:0;">
      <label>${label}</label>
      <input type="number" step="0.01" id="as-fig-${k}" value="${asCy[k] == null ? '' : asCy[k]}"
             oninput="asFigureInput('${k}', this.value)" />
      ${hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${hint}</div>` : ''}
    </div>`;
  host.innerHTML = `
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">
      ${box('interestTerm', 'Interest on Term Loan', 'Against the Long Term / PWC / HP facilities above.')}
      ${box('interestOD', 'Interest on STL / CC / OD', 'Against the Short Term / OD / CC facilities above.')}
      ${box('bankCharges', 'Bank Charges', '')}
    </div>
    <div style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">
      Finance Cost (note 3.14): <strong id="as-fin-total" style="color:var(--brand-navy); font-variant-numeric:tabular-nums;">${asFmt(total)}</strong>
    </div>`;
}

const AS_LOAN_KINDS = [
  ['st', 'Short Term Loan / OD / CC'],
  ['lt', 'Long Term Loan'],
  ['pwc', 'Permanent Working Capital Loan'],
  ['hp', 'Hire Purchase (HP) Loan'],
];

function asRenderLoans() {
  asRenderInterest();
  AS_LOAN_KINDS.forEach(([kind, label]) => {
    const host = asEl('as-loans-' + kind);
    if (!host) return;
    host.innerHTML = asLoans[kind].map((l, i) => `
      <div class="pj-loan-row" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:8px; flex-wrap:wrap;">
        <div class="form-group" style="margin:0;"><label>Facility</label>
          <input type="text" value="${escHtml(l.name || '')}" onchange="asLoanEdit('${kind}',${i},'name',this.value)" style="width:260px;" /></div>
        <div class="form-group" style="margin:0;"><label>Balance (Rs)</label>
          <input type="number" step="0.01" value="${asNum(l.amount)}" onchange="asLoanEdit('${kind}',${i},'amount',this.value)" style="width:160px;" /></div>
        <button class="btn btn-outline btn-sm" onclick="asLoanRemove('${kind}',${i})">Remove</button>
      </div>`).join('');
  });
}

function asAddLoanRow(kind) { asLoans[kind].push({ name: '', amount: 0 }); asRenderLoans(); asRecalcDebounced(); }
function asLoanRemove(kind, i) { asLoans[kind].splice(i, 1); asRenderLoans(); asRecalcDebounced(); }
function asLoanEdit(kind, i, field, v) {
  const l = asLoans[kind][i];
  if (!l) return;
  l[field] = field === 'amount' ? asNum(v) : v;
  asRecalcDebounced();
}

// The figure boxes on the Loans card write into the same asCy the main grid
// does, so a redraw of one must not blank the other.
function asInterestInput(k, v) { asFigureInput(k, v); }

// ════════════════════════════════════════════════════════════════
//  SOLVE
// ════════════════════════════════════════════════════════════════

// COI is on when there is an Income-Tax depreciation schedule to bridge to.
// The checkbox overrides in either direction once the preparer touches it —
// held in asCoiTouched, not on the element: the checkbox unrenders with its
// collapsed accordion section, and a DOM flag would silently revert the
// preparer's choice to the automatic rule.
function asUseCoi() {
  if (asCoiTouched != null) return asCoiTouched;
  return !!(asItDep || asNum(asCy.itDepreciation));
}

function asSetUseCoi(on) {
  asCoiTouched = !!on;
  asRun();
  asRenderFigures();
  asRenderTax();
}

function asCollectInput() {
  const p = asPy || {};
  const flat = ProvisionalStatementEngine.FLAT_LINES;
  return {
    py: {
      sales: p.soi && p.soi.revenueOps, otherIncome: p.soi && p.soi.otherIncome,
      interestIncome: p.soi && p.soi.interestIncome,
      closingStock: (p.materials && p.materials.closing) || (p.sfp && p.sfp.inventories),
      labour: asPyDirect('labour'), freight: asPyDirect('freight'),
      salary: p.salary, otherContrib: 0,
      incentiveExpense: 0,   // the dedicated row is retired; add one as an Other Expense
      taxExpense: p.soi && p.soi.tax,
      advanceTax: (p.receivableItems || []).reduce((s, r) => s + (/advance|tds/i.test(r.name || '') ? asNum(r.amount) : 0), 0),
      otherExpenses: (p.otherItems || []).map((e, i) => ({
        key: e.key || ('other' + i), name: e.name, amount: e.amount,
        flat: flat.indexOf(e.key) >= 0,
      })).concat(asCustom.map(c => ({ key: c.key, name: c.name, amount: 0 }))),
      directExtra: asDirectCustom.map(d => ({ key: d.key, name: d.name, amount: 0 })),
      ppeClasses: asPpeInput,
      receivables: p.sfp && p.sfp.receivables, inventories: p.sfp && p.sfp.inventories,
      payables: p.sfp && p.sfp.payables, cash: p.sfp && p.sfp.cash,
      shareCapital: p.sfp && p.sfp.shareCapital, reserves: p.sfp && p.sfp.reserves,
      loansNC: p.sfp && p.sfp.loansNC, loansC: p.sfp && p.sfp.loansC,
      investmentsNC: p.sfp && p.sfp.investmentsNC, investmentsC: p.sfp && p.sfp.investmentsC,
    },
    cy: Object.assign({}, asCy, {
      // The engine keeps its balance-sheet shape: Short Term / OD / CC is the
      // current side, the other three groups are non-current.
      loansNC: [...asLoans.lt, ...asLoans.pwc, ...asLoans.hp],
      loansC: asLoans.st,
      tds: asTds,
      stockLines: asStock,
    }),
    rules: asRules,
    options: {
      growth: 1 + asNum((asEl('as-growth') || {}).value || 5) / 100,
      taxProfile: (asEl('as-tax-profile') || {}).value || 'corporate',
      balanceVia: asPlugReceivables ? 'receivables' : 'none',
      // The Computation of Income runs when the client has an Income-Tax
      // depreciation schedule, unless the preparer says otherwise.
      useCoi: asUseCoi(),
      // 'purchases' means the typed PBT is held and purchases balances to it.
      solveFor: asSolveFor,
    },
  };
}

function asCalculate() {
  if (!asPy) { asStatus('Upload the prior-year statement first.', 'error'); return; }
  asRun();
  asShowSection('review');
}

function asRun() {
  if (!asPy) return;
  asResult = ProvisionalStatementEngine.derive(asCollectInput());
  asReport = fsxBuildReport(asToOut(asResult));
  asRenderReview();
}

let asRecalcTimer = null;
function asRecalcDebounced() {
  clearTimeout(asRecalcTimer);
  asRecalcTimer = setTimeout(() => {
    asRun();
    asRenderRules();
    asRenderInterest();
    asRenderTax();
    asRenderStock();
    asRenderParties();
    asSyncSeesaw();
  }, 220);
}

// Refresh only the derived half of the see-saw. A full re-render would throw
// away the caret of whichever box the user is typing in — the same rule the
// Autobooks confirmation grid follows.
function asSyncSeesaw() {
  if (!asResult) return;
  const seesaw = {
    purchases: ['as-fig-purchases', asResult.income.materials.purchases],
    pbt: ['as-fig-pbtTarget', asResult.income.pbt],
    closingStock: ['as-fig-closingStock', asResult.income.materials.closing],
  }[asSolveFor];
  if (seesaw) {
    const el = asEl(seesaw[0]);
    if (el && el !== document.activeElement) el.value = Number(seesaw[1]).toFixed(2);
  }
  const rec = asEl('as-fig-tradeReceivables');
  if (asPlugReceivables && rec && rec !== document.activeElement) {
    rec.value = Number(asResult.balance.tradeReceivables).toFixed(2);
  }
}

// Map the engine's output onto the shape fsxBuildReport() consumes. The
// export layer is shared with Audited Statement, so this is the one place
// the two modules have to agree.
function asToOut(r) {
  const fy = (asEl('as-fy') || {}).value || '';
  const startY = parseInt(String(fy).slice(0, 4), 10);
  const cyEnd = isFinite(startY) ? startY + 1 : null;
  const asAt = y => {
    if (!y) return '';
    const end = NepaliLocale.fyEndBs(y - 1);
    const d = (end && end.day) || 31;
    const sfx = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th';
    return `${d}${sfx} Ashadh ${y}`;
  };
  const p = asPy || {};

  return {
    meta: {
      company: {
        name: (asEl('as-company') || {}).value || '',
        address: (asEl('as-address') || {}).value || '',
        pan: (asEl('as-pan') || {}).value || '',
      },
      fy, fyPrev: isFinite(startY) ? `${startY - 1}-${String(startY).slice(2)}` : '',
      // A provisional set is seven sheets. The Computation of Income is the
      // eighth, and only for engagements that bridge accounting and Income-Tax
      // depreciation — see docs/modules/provisional-statement.md §2.3.
      omitCoi: !asUseCoi(),
      // 3.6 Share Capital states share COUNTS, which the note derives by
      // dividing the face value into the capital — so it can never disagree
      // with the balance sheet. Authorised is constitutional, not derivable,
      // so it is asked for and falls back to the issued count.
      shareFace: asNum((asEl('as-face-value') || {}).value) || 100,
      authorisedShares: asNum((asEl('as-auth-shares') || {}).value) || 0,
      basis: 'provisional',
      // The SOCE and the cash flow print whatever word this entity uses, so it
      // has to follow the tax profile rather than be fixed at the company one.
      terms: (() => {
        const prop = (asEl('as-tax-profile') || {}).value === 'progressive';
        return {
          person: prop ? 'Proprietor' : 'Director/Chairman',
          distribution: asDistLabel(),
          // Always "Share Capital", even for a proprietorship (user decision
          // 2026-08-22) — the entity word still drives the note's LAYOUT
          // (single Proprietor's/Partner's Capital line), only the heading
          // stays put.
          capital: 'Share Capital',
          entity: prop ? 'Proprietorship' : 'Private Limited Company',
        };
      })(),
      titles: (() => {
        // The Statement of Changes in Equity is NEVER titled "Provisional",
        // even on a provisional set — §15. Of the other three, whether the
        // word is printed is a house choice: the firm's T3 file prints it and
        // its second reference file does not, so it is offered as a switch.
        const pfx = (asEl('as-title-provisional') || {}).checked === false ? '' : 'Provisional ';
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
      asAtLine: `As at ${asAt(cyEnd)}${asAdSuffix()}`,
      forYearLine: `For the year ended ${asAt(cyEnd)}${asAdSuffix()}`,
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
      open:  { shareCapital: asNum(p.sfp && p.sfp.shareCapital), sharePremium: 0, retained: r.soce.open, otherReserves: 0 },
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
    // detail of notes 3.3/3.9/3.12–3.15 and the cash flow's comparative
    // column from payableItems / receivableItems / materials / financeItems /
    // socf. Passing only { sfp, soi } is what left every prior-year note line
    // printing "–" under a filled total (user report 2026-08-28).
    priorYear: Object.assign({}, p, {
      sfp: (p.sfp || {}),
      soi: Object.assign({}, p.soi || {}, { incentive: asPyIncentive() }),
    }),
    issues: (r.issues || []).concat(asPyIssues),
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

function asCollectSaveState() {
  const val = (id) => { const e = asEl(id); return e ? e.value : ''; };
  return {
    py: asPy, pyIssues: asPyIssues,
    cy: asCy, rules: asRules, ppe: asPpeInput, loans: asLoans,
    custom: asCustom, directCustom: asDirectCustom, tds: asTds,
    stock: asStock, typedOver: asTypedOver,
    vatSide: asVatSide, coiTouched: asCoiTouched,
    solveFor: asSolveFor, plugReceivables: asPlugReceivables,
    depSource: asDepSource,
    ui: {
      address: val('as-address'), growth: val('as-growth'),
      taxProfile: val('as-tax-profile'), staff: val('as-staff'),
      faceValue: val('as-face-value'), authShares: val('as-auth-shares'),
      titleProvisional: (asEl('as-title-provisional') || {}).checked !== false,
    },
  };
}

async function asSaveToDb(btn) {
  if (!asPy) {
    asStatus('Nothing to save yet — upload the prior-year statement first.', 'error');
    return;
  }
  const company = ((asEl('as-company') || {}).value || '').trim();
  const fy = (asEl('as-fy') || {}).value || '';
  if (!company || !fy) {
    asStatus('A company name and fiscal year are needed to save.', 'error');
    return;
  }
  const row = {
    client_id: asSelectedClient && asSelectedClient.id != null ? asSelectedClient.id : null,
    company_name: company,
    pan: (asEl('as-pan') || {}).value || null,
    fiscal_year: fy,
    // financial_statements also holds the OLD audited module's rows and any
    // future provisional-basis ones; this module owns only basis 'audited'.
    basis: 'audited',
    inputs: asCollectSaveState(),
  };
  // Busy-button contract (Stage 3) — kept byte-parallel with psSaveToDb,
  // per the clone rule (§15: a fix in either clone belongs in both).
  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      asStatus('Saving to the database…', 'searching');
      // One row per (company, fiscal year): a save with no loaded row first
      // adopts an existing match, so a re-open-and-save can never duplicate.
      // Adopt by client_id when there is one — the table carries a unique index
      // on (client_id, fiscal_year, basis), so an ilike miss on a respelt
      // company name would otherwise make the insert collide with it.
      if (!asSavedId) {
        let q = window.sb.from('financial_statements')
          .select('id').eq('fiscal_year', fy).eq('basis', 'audited').limit(1);
        q = row.client_id != null ? q.eq('client_id', row.client_id) : q.ilike('company_name', company);
        const { data, error } = await q;
        if (error) throw error;
        if (data && data.length) asSavedId = data[0].id;
      }
      if (asSavedId) {
        // An update deliberately does not resend created_by — the projection idiom.
        const { error } = await window.sb.from('financial_statements')
          .update(row).eq('id', asSavedId);
        if (error) throw error;
      } else {
        row.created_by = (window.currentUser || {}).email || null;
        const { data, error } = await window.sb.from('financial_statements')
          .insert(row).select('id').single();
        if (error) throw error;
        asSavedId = data.id;
      }
      asStatus(`Saved audited statement #${asSavedId} for ${escHtml(company)} (${escHtml(fy)}). Saving again updates this record.`, 'success');
      showToast(`✅ Audited statement saved for <strong>${escHtml(company)}</strong> (${escHtml(fy)}).`, 'success');
      AuditLog.record('audited_saved', {
        module: 'finStatement', clientName: company, status: 'success',
        recordRef: asSavedId, detail: { fiscalYear: fy },
      });
    } catch (e) {
      console.error(e);
      asStatus('Could not save: ' + escHtml(friendlyDbError(e)), 'error');
    }
  });
}

// The shared saved-documents drawer (js/core/documentStore.js), the same
// {fetchRows, describe, onChoose, onDelete} shape Projection passes.
const AS_SAVED_COLS = 'id, client_id, company_name, pan, fiscal_year, created_by, created_at, updated_at';

function asOpenSavedDrawer() {
  DocumentStore.openPicker({
    label: 'Saved audited statements',
    empty: 'Nothing saved yet. Use <strong>Save to Database</strong> on a statement and it will be listed here.',
    fetchRows: async () => {
      const { data, error } = await window.sb.from('financial_statements')
        .select(AS_SAVED_COLS).eq('basis', 'audited')
        .order('updated_at', { ascending: false }).limit(200);
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
    onChoose: id => asLoadSaved(id),
    onDelete: async id => {
      const { error } = await window.sb.from('financial_statements').delete().eq('id', id);
      if (error) throw error;
      // Orphan guard: a stale asSavedId would make the next Save issue an
      // UPDATE that silently matches nothing.
      if (asSavedId === id) asSavedId = null;
      AuditLog.record('audited_deleted', {
        module: 'finStatement', clientName: (asEl('as-company') || {}).value || '',
        status: 'success', recordRef: id,
      });
    },
  });
}

// A saved statement may carry a fiscal year the select no longer offers —
// `sel.value = fy` on a missing option silently loads a DIFFERENT year than
// the one clicked (the depSetFyOption lesson).
function asSetFyOption(fy) {
  const sel = asEl('as-fy');
  if (!sel || !fy) return;
  if (![...sel.options].some(o => o.value === fy)) {
    const o = document.createElement('option');
    o.value = o.textContent = fy;
    sel.appendChild(o);
  }
  sel.value = fy;
}

async function asLoadSaved(id) {
  asStatus('Loading saved audited statement…', 'searching');
  try {
    const { data, error } = await window.sb.from('financial_statements').select('*').eq('id', id).single();
    if (error) throw error;
    const inp = data.inputs || {};
    if (!inp.py) {
      asStatus('That saved record does not carry its prior-year statement, so it cannot be re-opened. Upload the workbook and save it again.', 'error');
      return;
    }
    // Clear through the scope so no path can leak the previous client's
    // figures under this record (§9), then rebuild the exact state saved.
    asScope.reset();
    asInit();
    asSavedId = data.id;
    asSelectedClient = (window.clientsList || []).find(c => c.id === data.client_id) || null;
    asEl('as-company').value = data.company_name || '';
    asEl('as-pan').value = data.pan || '';
    asEl('as-client-search').value = data.company_name || '';
    asSetFyOption(data.fiscal_year);
    const ui = inp.ui || {};
    const set = (elId, v) => { const e = asEl(elId); if (e) e.value = v == null ? '' : v; };
    set('as-address', ui.address);
    set('as-growth', ui.growth);
    set('as-tax-profile', ui.taxProfile || 'corporate');
    if (ui.staff) set('as-staff', ui.staff);
    set('as-face-value', ui.faceValue);
    set('as-auth-shares', ui.authShares);
    const tp = asEl('as-title-provisional');
    if (tp) tp.checked = ui.titleProvisional !== false;

    asPy = inp.py; asPyIssues = inp.pyIssues || [];
    asCy = inp.cy || {}; asRules = inp.rules || {}; asPpeInput = inp.ppe || [];
    asLoans = inp.loans && inp.loans.st ? inp.loans : { st: [], lt: [], pwc: [], hp: [] };
    asCustom = inp.custom || []; asDirectCustom = inp.directCustom || [];
    asTds = inp.tds || {}; asStock = inp.stock || [];
    asTypedOver = inp.typedOver || {};
    asVatSide = inp.vatSide || null; asCoiTouched = inp.coiTouched != null ? inp.coiTouched : null;
    asSolveFor = inp.solveFor || 'purchases';
    asPlugReceivables = inp.plugReceivables !== false;
    asDepSource = inp.depSource || '';

    asRenderPySummary();
    asRenderFigures();
    asRenderLoans();
    asShowSection('figures');
    // The derive runs in its own guard: the state above is already restored,
    // and a record that cannot derive should land the user on the figures
    // step with a message, not strand them on setup looking un-loaded.
    let derived = true;
    try { asRun(); } catch (e2) { console.error(e2); derived = false; }
    // Provenance, party detail and the register reconciliation come back
    // from live app data — but never overwrite the saved figures.
    asLoadSources({ keepTyped: true });
    asStatus(derived
      ? `Loaded saved audited statement #${data.id} — change any figure and Save to update this record.`
      : `Loaded saved audited statement #${data.id}, but the statements could not be re-derived from it — check the figures on this screen.`,
      derived ? 'success' : 'error');
  } catch (e) {
    console.error(e);
    asStatus('Could not load that statement: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  STEP 3 — review, preview, export
// ════════════════════════════════════════════════════════════════

// The reconciliation panel. Every check that fails says WHERE, because a
// difference nobody can locate is a difference nobody fixes.
function asRenderReconcile() {
  const host = asEl('as-reconcile');
  if (!host) return;
  if (!asResult) { host.innerHTML = ''; return; }
  const rec = ProvisionalReconcile.run(asResult, { register: asSrc, priorYear: asPy });
  asReconcile = rec;

  const badge = c => c.ok
    ? '<span class="log-badge badge-success" style="font-size:10px;">reconciled</span>'
    : (c.level === 'review'
      ? '<span class="log-badge badge-warning" style="font-size:10px;">for review</span>'
      : '<span class="log-badge badge-error" style="font-size:10px;">not balancing</span>');

  const row = c => `<tr>
      <td>${escHtml(c.label)}</td>
      <td style="text-align:right; font-variant-numeric:tabular-nums; ${c.ok ? 'color:var(--text-muted);' : 'font-weight:600;'}">${asFmt(c.diff)}</td>
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

function asRenderReview() {
  const host = asEl('as-review');
  if (!host || !asResult) return;
  const r = asResult;
  const row = (l, v, strong) => `<tr${strong ? ' style="font-weight:600;"' : ''}><td>${l}</td><td style="text-align:right; font-variant-numeric:tabular-nums;">${asFmt(v)}</td></tr>`;
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
    ${asIssuesHtml(r.issues)}`;
  asRenderReconcile();
  asRenderPreview();
}

function asShowSheet(key) {
  asSheetKey = key;
  document.querySelectorAll('#as-sheet-tabs .rep-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sheet === key));
  asRenderPreview();
}

function asRenderPreview() {
  const host = asEl('as-preview');
  if (!host || !asReport) return;
  const sh = asReport.sheets.find(s => s.key === asSheetKey) || asReport.sheets[0];
  host.innerHTML = fsxPreviewHtml(sh, asReport.meta);
}

async function asDownloadExcel() {
  if (!asReport) { asStatus('Nothing to export yet.', 'error'); return; }
  try {
    await LibLoader.ensure('exceljs');
    const wb = fsxWriteWorkbook(asReport, ExcelJS);
    const buf = await wb.xlsx.writeBuffer();
    const name = `${(asEl('as-company').value || 'Statement').replace(/[\\/:*?"<>|]/g, '')} ${(asEl('as-fy').value || '')} Audited.xlsx`;
    DocumentEngine.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    AuditLog.record('audited_excel_generated', {
      module: 'finStatement', clientName: asEl('as-company').value, status: 'success',
      detail: { fiscalYear: asEl('as-fy').value, sheets: asReport.sheets.length },
    });
    asStatus('Excel workbook generated.', 'success');
  } catch (e) {
    asStatus('Could not build the workbook: ' + e.message, 'error');
  }
}

function asPrint() {
  if (!asReport) { asStatus('Nothing to print yet.', 'error'); return; }
  const w = window.open('', '_blank');
  w.document.write(fsxReportHtmlDoc(asReport, { title: asEl('as-company').value || 'Audited Statement' }));
  w.document.close();
  w.focus();
}

function asShowSection(which) {
  ['setup', 'figures', 'review'].forEach(s => {
    const sec = asEl('as-section-' + s);
    if (sec) sec.style.display = s === which ? '' : 'none';
    const btn = asEl('as-step-' + s);
    if (btn) btn.classList.toggle('active', s === which);
  });
  if (which === 'review') asRun();
}
