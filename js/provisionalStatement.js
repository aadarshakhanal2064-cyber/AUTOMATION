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
let psSheetKey = 'SFP';
let psDepSource = '';        // where the PPE grid came from, for the caption

function psStatus(html, type) { showStatus(html, type, 'ps-status-area'); }
function psEl(id) { return document.getElementById(id); }
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
    psStatus(`Client loaded: ${it.name}`, 'success');
  },
});

function psOnFyChange() {
  psLoadDepreciation();
  psRecalcDebounced();
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

    if (!psEl('ps-company').value && py.company.name) psEl('ps-company').value = py.company.name;
    if (!psEl('ps-address').value && py.company.address) psEl('ps-address').value = py.company.address;

    psRenderPySummary();
    if (issues.some(i => i.level === 'error')) {
      psStatus('The prior-year file is missing figures the statement needs — see below.', 'error');
      return;
    }
    psSeedPpe();
    psSeedLoans();
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
      <td class="dep-calc">${psFmt(charge)}</td>
      <td class="dep-calc">${psFmt(closeCost - charge)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="psPpeRemove(${i})">✕</button></td>
    </tr>`;
  }).join('');
  const totCharge = psPpeInput.reduce((s, c) => s + (psNum(c.carrying) + psNum(c.additions) - psNum(c.disposals)) * psNum(c.rate), 0);
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
  else c[field] = psNum(v);
  psRenderPpe();
  psRecalcDebounced();
}

// ════════════════════════════════════════════════════════════════
//  STEP 2 — this year's typed figures, and the rule behind every other line
// ════════════════════════════════════════════════════════════════

// The figures the preparer actually types. Everything else is derived —
// this list IS the module's input surface.
const PS_FIGURES = [
  { k: 'sales',            label: 'Sale of Goods',                     hint: 'This year&rsquo;s turnover. Labour and freight scale off it.' },
  { k: 'otherIncome',      label: 'Commissions &amp; Incentives',      hint: 'Other income. The incentive expense scales off it.' },
  { k: 'interestIncome',   label: 'Interest Income',                   hint: '' },
  { k: 'purchases',        label: 'Purchases of Goods',                hint: 'Typed, not solved — profit falls out of it.' },
  { k: 'closingStock',     label: 'Closing Stock',                     hint: 'Becomes next year&rsquo;s opening.' },
  { k: 'tradeReceivables', label: 'Trade Receivables',                 hint: '' },
  { k: 'cash',             label: 'Cash &amp; Bank Balances',          hint: '' },
  { k: 'tradePayables',    label: 'Trade Payables',                    hint: '' },
  { k: 'interestOD',       label: 'Interest on STL / CC / OD',         hint: '' },
  { k: 'interestTerm',     label: 'Interest on Term Loan',             hint: '' },
  { k: 'bankCharges',      label: 'Bank Charges',                      hint: '' },
  { k: 'taxPaid',          label: 'Income Tax Paid',                   hint: 'Cash-flow only. Blank uses last year&rsquo;s provision.' },
];

function psRenderFigures() {
  const host = psEl('ps-figures');
  if (!host) return;
  host.innerHTML = `<div class="form-grid" style="grid-template-columns:repeat(3,1fr); gap:14px;">` +
    PS_FIGURES.map(f => `
      <div class="form-group" style="margin:0;">
        <label>${f.label}</label>
        <input type="number" step="0.01" id="ps-fig-${f.k}" value="${psCy[f.k] == null ? '' : psCy[f.k]}"
               oninput="psFigureInput('${f.k}', this.value)" />
        ${f.hint ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${f.hint}</div>` : ''}
      </div>`).join('') + `</div>`;
  psRenderRules();
  psRenderPpe();
}

function psFigureInput(k, v) {
  psCy[k] = v === '' ? undefined : psNum(v);
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
      res.income.materials.directItems, res.income.employeeItems,
      res.income.otherItems, [{ key: 'incentiveExpense', amount: res.income.incentive }]);
    return all.find(l => l.key === key) || null;
  };

  const group = (title, lines) => {
    if (!lines.length) return '';
    return `<div style="margin-top:14px;">
      <div style="font-size:12.5px; font-weight:600; color:var(--brand-navy); margin-bottom:6px;">${title}</div>
      <div class="table-wrap"><table class="client-table">
        <thead><tr>
          <th style="width:34%;">Line</th><th style="text-align:right;">Last year</th>
          <th style="width:190px;">Rule</th><th style="width:110px;">Growth %</th>
          <th style="text-align:right;">This year</th>
        </tr></thead>
        <tbody>${lines.map(l => psRuleRowHtml(l, lineOf(l.key))).join('')}</tbody>
      </table></div></div>`;
  };

  const flat = ProvisionalStatementEngine.FLAT_LINES;
  const otherLines = (psPy.otherItems || []).map((e, i) => ({
    key: e.key || ('other' + i), name: e.name, py: e.amount,
    def: flat.indexOf(e.key) >= 0 ? 'flat' : 'growth',
  }));

  host.innerHTML =
    group('Direct costs — scaled by turnover', [
      { key: 'labour',  name: 'Labour Charges',               py: psPyDirect('labour'),  def: 'turnover' },
      { key: 'freight', name: 'Clearing &amp; Freight Expenses', py: psPyDirect('freight'), def: 'turnover' },
    ]) +
    group('Employee benefits', [
      { key: 'salary',       name: 'Salary Expenses',     py: psPy.salary, def: 'growth' },
      { key: 'otherContrib', name: 'Other Contributions', py: 0,           def: 'growth' },
    ]) +
    group('Incentive — scaled by other income', [
      { key: 'incentiveExpense', name: 'Incentive Expenses', py: psPyIncentive(), def: 'driver' },
    ]) +
    group('Other expenses', otherLines);
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

function psRuleRowHtml(l, computed) {
  const ov = psRules[l.key] || {};
  const rule = ov.rule || l.def;
  const RULES = ProvisionalStatementEngine.RULES;
  const opts = Object.keys(RULES).map(r =>
    `<option value="${r}"${r === rule ? ' selected' : ''}>${escHtml(RULES[r].label)}</option>`).join('');
  const growth = ov.growth == null ? (psNum(psEl('ps-growth') && psEl('ps-growth').value) || 5) : (ov.growth - 1) * 100;
  return `<tr>
    <td>${l.name}</td>
    <td style="text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${psFmt(l.py)}</td>
    <td><select onchange="psRuleSet('${l.key}','rule',this.value)">${opts}</select></td>
    <td>${rule === 'growth'
      ? `<input type="number" step="0.5" value="${growth}" onchange="psRuleSet('${l.key}','growthPct',this.value)" style="width:88px;" />`
      : '<span style="color:var(--text-muted);">—</span>'}</td>
    <td style="text-align:right; font-variant-numeric:tabular-nums;">${rule === 'typed'
      ? `<input type="number" step="0.01" value="${ov.typed == null ? '' : ov.typed}" onchange="psRuleSet('${l.key}','typed',this.value)" style="width:140px; text-align:right;" />`
      : `<strong>${psFmt(computed ? computed.amount : 0)}</strong>`}</td>
  </tr>`;
}

function psRuleSet(key, field, v) {
  const ov = psRules[key] || (psRules[key] = {});
  if (field === 'rule') ov.rule = v;
  else if (field === 'growthPct') ov.growth = 1 + psNum(v) / 100;
  else if (field === 'typed') ov.typed = psNum(v);
  psRun();
  psRenderRules();
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

function psRenderLoans() {
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

// ════════════════════════════════════════════════════════════════
//  SOLVE
// ════════════════════════════════════════════════════════════════

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
      incentiveExpense: psPyIncentive(),
      taxExpense: p.soi && p.soi.tax,
      advanceTax: (p.receivableItems || []).reduce((s, r) => s + (/advance|tds/i.test(r.name || '') ? psNum(r.amount) : 0), 0),
      otherExpenses: (p.otherItems || []).map((e, i) => ({
        key: e.key || ('other' + i), name: e.name, amount: e.amount,
        flat: flat.indexOf(e.key) >= 0,
      })),
      ppeClasses: psPpeInput,
      receivables: p.sfp && p.sfp.receivables, inventories: p.sfp && p.sfp.inventories,
      payables: p.sfp && p.sfp.payables, cash: p.sfp && p.sfp.cash,
      shareCapital: p.sfp && p.sfp.shareCapital, reserves: p.sfp && p.sfp.reserves,
      loansNC: p.sfp && p.sfp.loansNC, loansC: p.sfp && p.sfp.loansC,
      investmentsNC: p.sfp && p.sfp.investmentsNC, investmentsC: p.sfp && p.sfp.investmentsC,
    },
    cy: Object.assign({}, psCy, {
      loansNC: psLoans.nc, loansC: psLoans.c,
    }),
    rules: psRules,
    options: {
      growth: 1 + psNum((psEl('ps-growth') || {}).value || 5) / 100,
      taxProfile: (psEl('ps-tax-profile') || {}).value || 'corporate',
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
  psRecalcTimer = setTimeout(() => { psRun(); psRenderRules(); }, 220);
}

// Map the engine's output onto the shape fsxBuildReport() consumes. The
// export layer is shared with Audited Statement, so this is the one place
// the two modules have to agree.
function psToOut(r) {
  const fy = (psEl('ps-fy') || {}).value || '';
  const startY = parseInt(String(fy).slice(0, 4), 10);
  const cyEnd = isFinite(startY) ? startY + 1 : null;
  const asAt = y => (y ? `32nd Ashadh ${y}` : '');
  const p = psPy || {};

  return {
    meta: {
      company: {
        name: (psEl('ps-company') || {}).value || '',
        address: (psEl('ps-address') || {}).value || '',
        pan: (psEl('ps-pan') || {}).value || '',
      },
      fy, fyPrev: isFinite(startY) ? `${startY - 1}-${String(startY).slice(2)}` : '',
      basis: 'provisional',
      terms: { person: 'Director', distribution: 'Dividend Paid', capital: 'Share Capital', entity: 'Private Limited Company' },
      titles: {
        sfp: 'Provisional Statement of Financial Position',
        soi: 'Provisional Statement of Income',
        // The Statement of Changes in Equity is NEVER titled "Provisional",
        // even on a provisional set — §15. The other three are.
        soce: 'Statement of Changes in Equity',
        socf: 'Provisional Statement of Cash Flows',
      },
      asAtCy: asAt(cyEnd), asAtPy: asAt(startY),
      yearEndedCy: asAt(cyEnd), yearEndedPy: asAt(startY),
      asAtLine: `As at ${asAt(cyEnd)}`,
      forYearLine: `For the year ended ${asAt(cyEnd)}`,
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
    coi: { pbt: r.income.pbt, depSlm: 0, depIncomeTax: 0, taxableProfit: r.tax.base, tax: r.tax.total, rule: r.tax.rule },
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
