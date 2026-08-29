// ── FinStatementExport — one statement model, three outputs ──
// The Excel workbook (ExcelJS), the on-screen preview and the print/PDF
// document all render from the SAME model built by fsxBuildReport(), so they
// can never drift apart — the pattern projectionExport.js established.
//
// PDF comes from printing the HTML document rather than being drawn in PDF-Lib.
// That is the app's route for HTML-rendered statements (§9.2 — Audit Report and
// Notes to Accounts both do it): the browser owns pagination and repeating
// table headers, and it can render Devanagari, which PDF-Lib's WinAnsi standard
// fonts cannot. Projection uses PDF-Lib because a bank wants one fixed-layout
// file; a statement set is a document the firm prints and signs.
//
// The Excel output reproduces the firm's template geometry cell for cell: the
// label in column B, notes in D, current year in F and comparative in H on the
// statements; D/F on Sch-PL; H/J on Sch-BS. That is not decoration — it is what
// lets the cross-sheet formulas be literally the template's own
// ('SFP'!F13 = '3.1 PPE'!P25, 'Sch-BS'!H97 = 'Sch-PL'!D33*1%), so a partner
// opening the workbook sees the same wiring they built by hand.
//
// fsxBuildReport() is pure (no DOM, no vendor calls) so it can be verified in
// Node against the real sample workbooks.

// Amounts group lakh/crore, matching the app preview (user ask 2026-08-29:
// the workbook must look like the preview, not like the T3 template's
// western #,##0.00 — that template format is what this replaced).
//
// Excel's format language has no locale-aware grouping, so this is the
// standard conditional-section idiom: ≥1 crore and ≥1 lakh each get a
// pattern with literal commas at the Indian positions — safe because the
// condition guarantees the digits exist to fill every group — and below a
// lakh the two grouping systems are identical anyway. A custom format
// allows only the two conditions plus a catch-all, so negatives and zero
// share the third section: a negative prints with a minus and western
// grouping (rare on the face of these statements, and the preview prints
// its own minus), and zero prints 0.00 rather than the en-dash.
const FSX_NUMFMT = '[>=10000000]#\\,##\\,##\\,##0.00;[>=100000]#\\,##\\,##0.00;#,##0.00';
const FSX_NUMFMT0 = '[>=10000000]#\\,##\\,##\\,##0;[>=100000]#\\,##\\,##0;#,##0';

// Column geometry per sheet, taken from the template. `cy`/`py` are the current
// and comparative value columns; `cols` is used by the matrix sheets (SOCE,
// 3.1 PPE) whose columns are categories rather than years.
const FSX_GEOM = {
  COI:   { label: 'A', cy: 'F' },
  // The Trial Balance page: A label, then Detail / Total. A matrix geometry
  // because the two columns are a detail line and its section subtotal, not
  // two years.
  TB:    { label: 'A', first: 'C', step: 2 },
  SFP:   { label: 'B', note: 'D', cy: 'F', py: 'H' },
  SOI:   { label: 'B', note: 'D', cy: 'F', py: 'H' },
  SOCE:  { label: 'B', note: 'D', cols: ['F', 'H', 'J', 'L', 'N'] },
  SOCF:  { label: 'B', cy: 'E', py: 'G' },
  PPE:   { label: 'B', first: 'D', step: 2 },
  SchBS: { label: 'B', cy: 'H', py: 'J' },
  SchPL: { label: 'B', cy: 'D', py: 'F' },
};

const fsxColNum = (letters) => {
  let n = 0;
  for (const ch of String(letters)) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};
const fsxColLetter = (n) => {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
};

// ════════════════════════════════════════════════════════════════
//  THE SHARED MODEL
// ════════════════════════════════════════════════════════════════

// Row kinds drive styling in all three renderers:
//   head   section heading ("A. Assets:")      sub    indented sub-heading
//   item   ordinary line                       tot    subtotal (tinted, ruled above)
//   grand  headline total (double-ruled)       note   free text spanning the width
//   blank  spacer
// ════════════════════════════════════════════════════════════════
//  DERIVED-LINE FORMULAS
//
//  A provisional set is built by carrying last year forward, and the firm's
//  own workbook records that as a LIVE formula in the cell rather than a
//  pasted figure — `=ROUND(F55*1.05,)`, `=+F25/F6*D6`, `=+'Sch-PL'!D61*10%`.
//  Reproducing those matters beyond cosmetics: it is what lets the preparer
//  change one cell in Excel and watch the statement re-foot, which is the
//  whole reason the firm works this way.
//
//  A line only gets one when the engine attached a `derive` descriptor, so
//  audited statements — where every figure is a fact, not a projection —
//  keep their literal values and are unaffected.
//
//  Only the current-year column is wired. The comparative column holds a
//  signed year's reported figures and must never be restated by a formula
//  (the same rule `r.pyFooted` already enforces for sums).
// ════════════════════════════════════════════════════════════════
function fsxDeriveXf(d, anchors) {
  if (!d || !d.kind) return null;
  const a = anchors || {};
  return (ctx) => {
    if (ctx.ci !== 0) return null;                  // current-year column only
    const { c, pyc, rn, R } = ctx;
    if (!pyc) return null;
    const pct = (v) => `${+(v * 100).toFixed(6)}%`;
    switch (d.kind) {
      case 'flat':
        return `+${pyc}${rn}`;
      case 'growth': {
        const f = d.factor == null ? 1.05 : d.factor;
        return `ROUND(${pyc}${rn}*${f},${d.roundTo || 0})`;
      }
      case 'turnover': {
        const s = R[a.sales];
        if (!s) return null;
        return `+${pyc}${rn}/${pyc}${s}*${c}${s}`;
      }
      case 'driver': {
        const s = R[a.driver];
        if (!s) return null;
        return `ROUND(${pyc}${rn}/${pyc}${s}*${c}${s},0)`;
      }
      case 'pct': {
        // A statutory withholding: a percentage of another cell, which may
        // live on this sheet or another.
        const ref = d.sheet ? ctx.Xc(d.sheet, d.row) : (R[d.row] ? `${c}${R[d.row]}` : null);
        return ref ? `+${ref}*${pct(d.pct)}` : null;
      }
      case 'net': {
        // `Sch-BS H89 ='Sch-PL'!D53-H97` — a fee net of its own withholding.
        const gross = d.sheet ? ctx.Xc(d.sheet, d.row) : (R[d.row] ? `${c}${R[d.row]}` : null);
        const less = R[d.less] ? `${c}${R[d.less]}` : null;
        return gross && less ? `${gross}-${less}` : null;
      }
      case 'advanceTax': {
        // `Sch-BS H18 =+J18-SOI!H29+SOI!F15*15%`
        const pyTax = ctx.Xp('SOI', 'tax');
        const cyOth = ctx.Xc('SOI', 'othInc');
        if (!pyTax || !cyOth) return null;
        return `+${pyc}${rn}-${pyTax}+${cyOth}*${pct(d.pct == null ? 0.15 : d.pct)}`;
      }
      case 'taxOnProfit': {
        // `Sch-PL D75 =+SOI!F27*0.25`
        const pbt = ctx.Xc('SOI', 'pbt');
        return pbt ? `+${pbt}*${d.rate == null ? 0.25 : d.rate}` : null;
      }
      default:
        return null;
    }
  };
}

function fsxBuildReport(out) {
  const m = out.meta || {};
  const inc = out.income || {};
  const bal = out.balance || {};
  const cf = out.cashflow || {};
  const py = (out.priorYear || {});
  const pySfp = py.sfp || {};
  const pySoi = py.soi || {};
  const T = m.terms || { person: 'Director', distribution: 'Dividend Paid' };

  const sheets = [];
  // Row keys the derived-line formulas scale against: turnover-scaled
  // lines divide by last year's sales and multiply by this year's;
  // driver-scaled lines do the same against other income.
  const ANCHORS = { sales: 'saleGoods', driver: 'othIncome' };
  // Copied rather than mutated: the caller's array belongs to the solver, and
  // the comparative-column check below appends findings of its own.
  const issues = (out.issues || []).slice();
  const R = (label, vals, kind, extra) => Object.assign({ label, vals: vals || [], kind: kind || 'item' }, extra || {});
  const B = () => ({ label: '', vals: [], kind: 'blank' });
  // A note's own header band. Schedules repeat this under every 3.x heading,
  // which is what makes each note read as a table in its own right.
  const BAND = (label) => ({ label: label || 'Particulars', vals: [], kind: 'band' });
  // The share-capital note is the one table on Sch-BS that splits each year
  // into Number and NPR, so it needs its own two-deep header and a four-cell
  // row. Its columns are D/F (this year) and H/J (last), which is why they are
  // named on the sheet rather than derived from the sheet's own two-column
  // geometry.
  const QHEAD = (label) => ({ label: label || 'Type of Shares', vals: [], kind: 'quadhead' });
  const QSUB = () => ({ label: '', vals: [], kind: 'quadsub' });
  const Q = (label, vals, kind) => ({ label, vals: vals || [], kind: kind || 'quad' });

  // Fixed-asset classes are resolved first because the statements reference the
  // 3.1 PPE note's TOTAL column, whose index depends on how many classes
  // survive pruning. Classes with nothing in them at all are dropped so the
  // note shows the columns actually in use, the way the firm's own sheets do
  // (and the way the projection's depreciation schedule already prunes).
  const ppeAll = (out.ppe && out.ppe.classes) || [];
  const pc = ppeAll.filter(c =>
    Math.abs(c.openCost || 0) > 0.005 || Math.abs(c.additions || 0) > 0.005 ||
    Math.abs(c.disposals || 0) > 0.005 || Math.abs(c.openDep || 0) > 0.005 ||
    Math.abs(c.depCharge || 0) > 0.005 || Math.abs(c.closeCarrying || 0) > 0.005);
  const ppeTotalIdx = pc.length;   // the Total column sits after the classes

  const cyHead = m.asAtCy || 'Current Year';
  const pyHead = m.asAtPy || 'Comparative';
  const yrHead = m.yearEndedCy || cyHead;
  const yrHeadPy = m.yearEndedPy || pyHead;

  // ── COI: Return of Income (the tax computation) ──
  // A provisional set is seven sheets — SFP, SOI, SOCE, SOCF, 3.1 PPE, Sch-BS,
  // Sch-PL — and carries no tax-computation page: that working belongs to the
  // return, not to the statements. Audited sets keep it, so it is opted out of
  // rather than deleted.
  const coi = out.coi || {};
  // Keyed once so the row and the total's xsum cannot drift apart.
  const coiAdds = (coi.disallowed || []).map((l, i) => ({ k: 'coiAdd' + i, label: l.name || 'Disallowed expense', amount: l.amount }));
  const coiLess = (coi.nonTaxable || []).map((l, i) => ({ k: 'coiLess' + i, label: l.name || 'Income not taxable', amount: l.amount }));
  if (!m.omitCoi) sheets.push({
    key: 'COI', name: 'COI', geom: FSX_GEOM.COI,
    title: 'RETURN OF INCOME', noHeaderBand: true,
    rows: [
      R('Name Of Assesse', [m.company && m.company.name], 'kv'),
      R('Address', [m.company && m.company.address], 'kv'),
      R('Type of Entity', [T.entity], 'kv'),
      R('PAN', [m.company && m.company.pan], 'kv'),
      R('Tax Rate', [m.specialIndustry ? 'Special Industries' : 'Normal'], 'kv'),
      R('Fiscal Year', [m.fy], 'kv'),
      R('Submission No:', [''], 'kv'),
      B(),
      R('Computation of Total Income', [], 'head'),
      B(),
      R('Income From Business', [], 'sub'),
      R('Net Profit as per Income Statement', [coi.pbt], 'item', { k: 'pbt', xf: ({ X }) => X('SOI', 'pbt') }),
      // The two hand-entered blocks, each printed only when it carries a line
      // — the firm's own sheet has no empty "Add:" heading standing over
      // nothing, and an empty block would read as a claim that nothing was
      // disallowed rather than that nobody looked.
      ...(coiAdds.length ? [R('Add: Expenses Disallowed', [], 'sub')] : []),
      ...coiAdds.map(l => R(l.label, [l.amount], 'item', { k: l.k })),
      R('Add: Depreciation as per Accounting Standard', [coi.depSlm], 'item', { k: 'depSlm' }),
      ...(coiLess.length ? [R('Less: Income not Taxable', [], 'sub')] : []),
      // Held as a negative so the column adds straight down, the same way the
      // brought-forward loss row below does.
      ...coiLess.map(l => R(l.label, [-Math.abs(l.amount)], 'item', { k: l.k })),
      R('Less: Depreciation as per Income tax Act,2058', [-Math.abs(coi.depIncomeTax || 0)], 'item', { k: 'depIt' }),
      // The firm's own COI carries this row and ours did not. Their label says
      // "Add" and the cell holds a negative, because a brought-forward loss
      // reduces taxable income — kept exactly that way so the printed sheet
      // reads like theirs.
      R('Add: Previous year Loss', [-Math.abs(coi.bfLoss || 0)], 'item', { k: 'bfLoss' }),
      R('Total Taxable income', [coi.taxableProfit], 'tot', { k: 'taxable',
        // Every row above is signed to add straight down, so the total is a
        // plain sum of them — which is what makes the exported sheet re-foot
        // in Excel when a figure is edited there.
        xsum: ['pbt', ...coiAdds.map(l => l.k), 'depSlm', ...coiLess.map(l => l.k), 'depIt', 'bfLoss'] }),
      B(),
      R('Provision for Tax', [coi.tax], 'grand', { k: 'tax' }),
      B(),
      R(coi.rule ? 'Basis: ' + coi.rule : '', [], 'note'),
    ],
  });

  // ── SFP: Statement of Financial Position ──
  sheets.push({
    key: 'SFP', name: 'SFP', geom: FSX_GEOM.SFP,
    title: m.titles && m.titles.sfp, subtitle: m.asAtLine, sig: true,
    sigRows: { line: 57, role: 59, date: 61, place: 62 },
    cols: [{ h1: 'As at', h2: cyHead }, { h1: 'As at', h2: pyHead, restated: true }],
    rows: [
      R('A. Assets:', [], 'head'),
      R('I. Non-Current Assets', [], 'sub'),
      R('Property, Plant and Equipment', [bal.ppe, pySfp.ppe], 'item', { note: '3.1', k: 'ppe', xf: ({ X }) => X('PPE', 'carryClose', ppeTotalIdx) }),
      R('Investments', [bal.investmentsNC, pySfp.investmentsNC], 'item', { note: '3.2', k: 'invNC', xf: ({ X }) => X('SchBS', 'invNCPortion') }),
      R('Other Receivables', [bal.otherReceivablesNC, pySfp.otherReceivablesNC], 'item', { note: '3.3', k: 'othRecNC' }),
      R('Total Non-Current Assets', [bal.totalNCA, pySfp.totalNCA], 'tot', { k: 'totalNCA', xsum: ['ppe', 'invNC', 'othRecNC'] }),
      B(),
      R('II. Current Assets', [], 'sub'),
      R('Investments', [bal.investmentsC, pySfp.investmentsC], 'item', { note: '3.2', k: 'invC', xf: ({ X }) => X('SchBS', 'invCurrent') }),
      R('Inventories', [bal.inventories, pySfp.inventories], 'item', { note: '3.4', k: 'stock', xf: ({ X }) => X('SchBS', 'invTotal') }),
      R('Trade and Other Receivables', [bal.receivables, pySfp.receivables], 'item', { note: '3.3', k: 'recv', xf: ({ X }) => X('SchBS', 'recvCurrent') }),
      R('Cash and Cash Equivalents', [bal.cash, pySfp.cash], 'item', { note: '3.5', k: 'cash', xf: ({ X }) => X('SchBS', 'cashTotal') }),
      R('Total Current Assets', [bal.totalCA, pySfp.totalCA], 'tot', { k: 'totalCA', xsum: ['invC', 'stock', 'recv', 'cash'] }),
      B(),
      R('Total Assets', [bal.totalAssets, pySfp.totalAssets], 'grand', { k: 'totalAssets', xsum: ['totalNCA', 'totalCA'] }),
      B(),
      R('B. Equity and Liabilities:', [], 'head'),
      R('I. Equity', [], 'sub'),
      R(T.capital, [bal.shareCapital, pySfp.shareCapital], 'item', { note: '3.6', k: 'capital', xf: ({ X }) => X('SOCE', 'close', 0) }),
      // Everything in the equity matrix except share capital, which has its own
      // line above — the template's =SOCE!H14+SOCE!J14+SOCE!L14.
      R('Reserves', [bal.reserves, pySfp.reserves], 'item', {
        note: '3.7', k: 'reserves',
        xf: ({ X }) => {
          const parts = [1, 2, 3].map(ci => X('SOCE', 'close', ci)).filter(Boolean);
          return parts.length === 3 ? parts.join('+') : null;
        },
      }),
      R('Total Equity', [bal.totalEquity, pySfp.totalEquity], 'tot', { k: 'totalEquity', xsum: ['capital', 'reserves'] }),
      B(),
      R('II. Non-Current Liabilities', [], 'sub'),
      R('Loans and Borrowings', [bal.loansNonCurrent, pySfp.loansNC], 'item', { note: '3.8', k: 'loanNC', xf: ({ X }) => X('SchBS', 'loanNCTotal') }),
      R('Provisions', [bal.provisionsNC, pySfp.provisionsNC], 'item', { note: '3.10', k: 'provNC', xf: ({ X }) => X('SchBS', 'provNCPortion') }),
      R('Total Non-Current Liabilities', [bal.totalNCL, (pySfp.loansNC || 0) + (pySfp.provisionsNC || 0)], 'tot', { k: 'totalNCL', xsum: ['loanNC', 'provNC'] }),
      B(),
      R('III. Current Liabilities', [], 'sub'),
      R('Loans and Borrowings', [bal.loansCurrent, pySfp.loansC], 'item', { note: '3.8', k: 'loanC', xf: ({ X }) => X('SchBS', 'loanCTotal') }),
      R('Trade & Other Payables', [bal.totalPayables, pySfp.payables], 'item', { note: '3.9', k: 'pay', xf: ({ X }) => X('SchBS', 'payTotal') }),
      R('Provisions', [bal.provisionsC, pySfp.provisionsC], 'item', { note: '3.10', k: 'provC', xf: ({ X }) => X('SchBS', 'provCurrent') }),
      R('Total Current Liabilities', [bal.totalCL, pySfp.totalCL], 'tot', { k: 'totalCL', xsum: ['loanC', 'pay', 'provC'] }),
      B(),
      // These two are the only totals the template draws with a bottom rule
      // alone — a blank spacer row already separates them from what they sum.
      R('Total Liabilities', [bal.totalLiabilities, (pySfp.totalCL || 0) + (pySfp.loansNC || 0) + (pySfp.provisionsNC || 0)], 'tot', { k: 'totalLiab', xsum: ['totalNCL', 'totalCL'], noTopRule: true }),
      B(),
      R('Total Equity and Liabilities', [bal.totalEquityLiab, pySfp.totalAssets], 'grand', { k: 'totalEL', xsum: ['totalLiab', 'totalEquity'], noTopRule: true }),
      B(), B(),
      R('The notes are an integral part of these financial statements.', [], 'note'),
      R('This is the statement of position referred to in our report of even date.', [], 'note'),
    ],
  });

  // ── SOI: Statement of Income ──
  const mat = inc.materials || {};

  // The expense block is built rather than literal because a provisional set
  // carries an Incentive Expenses line the audited one does not (the firm's
  // own workbook runs a-f, with Incentive at e). The row is emitted only when
  // there is an incentive to report, and the a)/b)/c)… lettering is applied
  // afterwards, so an audited statement still renders exactly a-e as before.
  // The Total's xsum is derived from the same list, which is what stops the
  // sum and the rows above it disagreeing when one is edited.
  const hasIncentive = Math.abs(inc.incentive || 0) > 0.005
    || Math.abs((pySoi && pySoi.incentive) || 0) > 0.005;
  const expenseSpec = [
    { label: 'Materials/Services Consumed Expenses', vals: [mat.total, pySoi.materials], note: '3.12', k: 'materials', xf: ({ X }) => X('SchPL', 'matTotal') },
    { label: 'Employee Benefit Expenses', vals: [inc.employeeTotal, pySoi.employee], note: '3.13', k: 'employee', xf: ({ X }) => X('SchPL', 'empTotal') },
    { label: 'Finance Cost', vals: [inc.financeTotal, pySoi.financeCost], note: '3.14', k: 'finance', xf: ({ X }) => X('SchPL', 'finTotal') },
    { label: 'Depreciation Expenses', vals: [inc.depreciation, pySoi.depreciation], note: '3.1', k: 'dep', xf: ({ X }) => X('PPE', 'depCharge', ppeTotalIdx) },
    // No note reference: the firm's workbook leaves SOI's incentive row's
    // Notes cell blank, because there is no 3.x schedule behind it.
    ...(hasIncentive ? [{ label: 'Incentive Expenses', vals: [inc.incentive, pySoi.incentive], k: 'incentive' }] : []),
    { label: 'Other Expenses', vals: [inc.otherTotal, pySoi.otherExpenses], note: '3.15', k: 'other', xf: ({ X }) => X('SchPL', 'othTotal') },
  ];
  const expenseKeys = expenseSpec.map(e => e.k);
  const expenseRows = expenseSpec.map((e, i) =>
    R(`${String.fromCharCode(97 + i)}) ${e.label}`, e.vals, 'item',
      Object.assign({ k: e.k }, e.note ? { note: e.note } : {}, e.xf ? { xf: e.xf } : {})));
  sheets.push({
    key: 'SOI', name: 'SOI', geom: FSX_GEOM.SOI,
    title: m.titles && m.titles.soi, subtitle: m.forYearLine, sig: true,
    sigRows: { line: 51, role: 53, date: 56, place: 57 },
    cols: [{ h1: 'Year Ended', h2: yrHead }, { h1: 'Year Ended', h2: yrHeadPy, restated: true }],
    rows: [
      R('A. INCOMES:', [], 'head'),
      R('I. Revenue From Operations', [inc.revenueOps, pySoi.revenueOps], 'item', { note: '3.11', k: 'rev', xf: ({ X }) => X('SchPL', 'revTotal') }),
      R('II. Revenue From Non-Operations', [], 'sub'),
      R('a) Interest Income', [inc.interestIncome, pySoi.interestIncome], 'item', { note: '3.11', k: 'intInc', xf: ({ X }) => X('SchPL', 'intIncome') }),
      R('b) Other Income', [inc.otherIncome, pySoi.otherIncome], 'item', { note: '3.11', k: 'othInc', xf: ({ X }) => X('SchPL', 'othIncome') }),
      R('Total Income', [inc.totalIncome, pySoi.totalIncome], 'tot', { k: 'totalIncome', xsum: ['rev', 'intInc', 'othInc'] }),
      B(),
      R('B. EXPENSES', [], 'head'),
      ...expenseRows,
      R('Total Expenses', [inc.totalExpenses, pySoi.totalExpenses], 'tot', { k: 'totalExpenses', xsum: expenseKeys }),
      B(),
      R('Profit Before Tax', [inc.pbt, pySoi.pbt], 'tot', {
        k: 'pbt', xf: ({ R: r, c }) => (r.totalIncome && r.totalExpenses) ? `${c}${r.totalIncome}-${c}${r.totalExpenses}` : null,
      }),
      B(),
      R('Income Tax Expenses', [inc.tax, pySoi.tax], 'item', { note: '3.16', k: 'tax', xf: ({ X }) => X('SchPL', 'taxTotal') }),
      B(),
      R('Net Profit For the Year', [inc.netProfit, pySoi.netProfit], 'grand', {
        k: 'np', xf: ({ R: r, c }) => (r.pbt && r.tax) ? `${c}${r.pbt}-${c}${r.tax}` : null,
      }),
      B(), B(), B(),
      R('The notes are an integral part of these financial statements.', [], 'note'),
      R('This is the statement of income referred to in our report of even date.', [], 'note'),
    ],
  });

  // ── SOCE: Statement of Changes in Equity (a matrix, not a two-year table) ──
  const so = out.soce || { open: {}, close: {} };
  const eq = (o) => [o.shareCapital || 0, o.sharePremium || 0, o.retained || 0, o.otherReserves || 0];
  const sum4 = (a) => a.reduce((s, x) => s + x, 0);
  const openArr = eq(so.open), closeArr = eq(so.close);
  const rowProfit = [0, 0, so.profit || 0, 0];
  const rowCapital = [so.capital || 0, 0, 0, 0];
  const rowDist = [0, 0, -(so.dividend || 0), 0];
  sheets.push({
    key: 'SOCE', name: 'SOCE', geom: FSX_GEOM.SOCE, matrix: true,
    title: m.titles && m.titles.soce, subtitle: m.forYearLine, sig: true,
    sigRows: { line: 22, role: 24, date: 29, place: 30 },
    cols: [{ h1: T.capital }, { h1: 'Share Premium' }, { h1: 'Retained Earnings' }, { h1: 'Other Reserves' }, { h1: 'Total' }],
    rows: [
      // A matrix sheet carries formulas in every column, so each of these
      // targets one column by index and leaves the rest as typed figures.
      R(m.socOpenLabel || 'Balance at beginning of the year', [...openArr, sum4(openArr)], 'item', {
        k: 'open', rowTotal: true,
        // Opening capital IS note 3.6's prior-year paid-up cell — a live
        // fetch the one-box 3.6 made possible (its quad predecessor's rows
        // never registered keys, so this lookup used to resolve to nothing
        // and the cell fell back to a written value).
        xf: ({ X, ci }) => (ci === 0 ? X('SchBS', 'capPaid', 1) : (ci === 2 ? X('SchBS', 'resOpen', 0) : null)),
      }),
      R('Profit for the Year', [...rowProfit, sum4(rowProfit)], 'item', {
        k: 'profit', rowTotal: true,
        xf: ({ X, ci }) => (ci === 2 ? X('SOI', 'np', 0) : null),
      }),
      R('Capital Introduced During the year', [...rowCapital, sum4(rowCapital)], 'item', {
        k: 'capital', rowTotal: true,
        xf: ({ X, ci }) => (ci === 0 ? X('SchBS', 'capAdd', 0) : null),
      }),
      R(T.distribution, [...rowDist, sum4(rowDist)], 'item', { k: 'dist', rowTotal: true }),
      R(m.socCloseLabel || 'Balance at end of the year', [...closeArr, sum4(closeArr)], 'grand', {
        k: 'close', colSum: ['open', 'profit', 'capital', 'dist'], rowTotal: true,
      }),
    ],
  });

  // ── SOCF: Statement of Cash Flows ──
  const op = cf.operating || {}, iv = cf.investing || {}, fi = cf.financing || {};
  // The prior year is READ from the uploaded statement, not re-derived: a cash
  // flow needs two balance sheets and the year before last is not in the file.
  const pc2 = py.socf || {};

  // Nothing on the firm's cash flow is typed — every line is derived from the
  // two balance-sheet columns, so editing a schedule moves the cash flow too.
  // An asset movement is a cash inflow when the asset FALLS (prior − current);
  // a liability or equity movement is an inflow when it RISES (current − prior).
  const dAsset = (rowKey) => ({ X }) => {
    const cy = X('SFP', rowKey, 0), pyc = X('SFP', rowKey, 1);
    return (cy && pyc) ? `${pyc}-${cy}` : null;
  };
  const dFunding = (rowKey) => ({ X }) => {
    const cy = X('SFP', rowKey, 0), pyc = X('SFP', rowKey, 1);
    return (cy && pyc) ? `${cy}-${pyc}` : null;
  };
  sheets.push({
    key: 'SOCF', name: 'SOCF', geom: FSX_GEOM.SOCF,
    title: m.titles && m.titles.socf, subtitle: m.forYearLine, sig: true,
    sigRows: { line: 55, role: 57, date: 59, place: 60 },
    cols: [{ h1: 'Year Ended', h2: yrHead }, { h1: 'Year Ended', h2: yrHeadPy }],
    rows: [
      R('Cash Flows From Operating Activities', [], 'head'),
      R('Profit For the Year', [op.profit, pc2.profit], 'item', { k: 'cfProfit', xf: ({ X }) => X('SOI', 'np') }),
      R('Adjustment for :', [], 'sub'),
      R('Depreciation/Impairment on Property, Plant & Equipment', [op.depreciation, pc2.depreciation], 'item', { k: 'cfDep', xf: ({ X }) => X('SOI', 'dep') }),
      R('Interest Income', [op.interestIncome, pc2.interestIncome], 'item', { k: 'cfIntInc', xf: ({ X }) => X('SOI', 'intInc') }),
      R('Interest Expenses/ Finance Cost', [op.financeCost, pc2.financeCost], 'item', { k: 'cfFin', xf: ({ X }) => X('SOI', 'finance') }),
      R('Loss/(gain) On Sale of Property, Plant & Equipment', [op.ppeLoss, pc2.ppeLoss], 'item', { k: 'cfPpeLoss' }),
      R('Income Tax Expenses Charged to Profit or Loss Statements', [op.taxExpense, pc2.taxExpense], 'item', { k: 'cfTax', xf: ({ X }) => X('SOI', 'tax') }),
      R('Increase/Decrease in Trade & Other Receivables', [op.dRecv, pc2.dRecv], 'item', { k: 'cfRecv', xf: dAsset('recv') }),
      R('Increase/Decrease in Inventories', [op.dStock, pc2.dStock], 'item', { k: 'cfStock', xf: dAsset('stock') }),
      R('Increase/Decrease in Trade & Other Payables', [op.dPay, pc2.dPay], 'item', { k: 'cfPay', xf: dFunding('pay') }),
      R('Cash Generated From Operations.', [cf.generated, pc2.generated], 'tot', {
        k: 'cfGen',
        xf: ({ R: r, c }) => (r.cfProfit && r.cfPay)
          ? `${c}${r.cfProfit}+${c}${r.cfDep}-${c}${r.cfIntInc}+${c}${r.cfFin}+SUM(${c}${r.cfPpeLoss}:${c}${r.cfPay})` : null,
      }),
      R('Interest Paid', [cf.interestPaid, pc2.interestPaid], 'item', { k: 'cfIntPaid', xf: ({ R: r, c }) => r.cfFin ? `${c}${r.cfFin}` : null }),
      // Deliberately the prior year's balance-sheet PROVISION, not its tax
      // expense as the template writes it: the same figure whenever provisions
      // carry current tax only, but it is the provision that actually leaves,
      // and using it is what holds the cash-flow tie.
      R('Income Tax Paid', [cf.taxPaid, pc2.taxPaid], 'item', { k: 'cfTaxPaid', xf: ({ X }) => X('SFP', 'provC', 1) }),
      R('Net Cash Flows from Operating Activities', [cf.netOperating, pc2.netOperating], 'tot', {
        k: 'cfOper', xf: ({ R: r, c }) => `${c}${r.cfGen}-${c}${r.cfIntPaid}-${c}${r.cfTaxPaid}`,
      }),
      R('Cash Flow from Investing Activities :', [], 'head'),
      R('Acquisition of Property, Plant and Equipment', [iv.ppeAcquired, pc2.ppeAcquired], 'item', { k: 'cfPpeAcq', xf: ({ X }) => { const x = X('PPE', 'additions', ppeTotalIdx); return x ? `-${x}` : null; } }),
      // Investments sit on the balance sheet twice — non-current then current —
      // so the movement has to net both, exactly as the template's
      // =SFP!H14+SFP!H19-SFP!F14-SFP!F19 does.
      R('Investments', [iv.investments, pc2.investments], 'item', {
        k: 'cfInv',
        xf: ({ X }) => {
          const a = X('SFP', 'invNC', 1), b = X('SFP', 'invC', 1);
          const c1 = X('SFP', 'invNC', 0), d = X('SFP', 'invC', 0);
          return (a && b && c1 && d) ? `${a}+${b}-${c1}-${d}` : null;
        },
      }),
      R('Interest/Dividend Received', [iv.interestReceived, pc2.interestReceived], 'item', { k: 'cfIntRec', xf: ({ R: r, c }) => r.cfIntInc ? `${c}${r.cfIntInc}` : null }),
      R('Proceeds from Sale of PPE, Investments/Financial Assets', [iv.ppeProceeds, pc2.ppeProceeds], 'item', { k: 'cfPpeSale', xf: ({ X }) => X('PPE', 'disposals', ppeTotalIdx) }),
      R('Net Cash Flows from Investing Activities', [cf.netInvesting, pc2.netInvesting], 'tot', {
        k: 'cfInvest', xf: ({ R: r, c }) => `SUM(${c}${r.cfPpeAcq}:${c}${r.cfPpeSale})`,
      }),
      R('Cash Flows from Financing Activities :', [], 'head'),
      R('Proceeds from Capital introduced during the year', [fi.capital, pc2.capital], 'item', { k: 'cfCap', xf: dFunding('capital') }),
      R('Proceeds/ (Repayment) from Non-Current Borrowings', [fi.nonCurrentBorrowings, pc2.nonCurrentBorrowings], 'item', { k: 'cfNCB', xf: dFunding('loanNC') }),
      R('Proceeds/ (Repayment) from Current Borrowings', [fi.currentBorrowings, pc2.currentBorrowings], 'item', { k: 'cfCB', xf: dFunding('loanC') }),
      // Use the entity's own word verbatim — matching on 'Drawing' missed
      // 'Drawings', so a proprietorship's cash flow said "Dividend Paid".
      R(T.distribution || 'Dividend Paid', [fi.drawing, pc2.drawing], 'item', { k: 'cfDraw' }),
      R('Net Cash Flows from Financing Activities', [cf.netFinancing, pc2.netFinancing], 'tot', {
        k: 'cfFinance', xf: ({ R: r, c }) => `SUM(${c}${r.cfCap}:${c}${r.cfDraw})`,
      }),
      B(),
      R('Net Increase in Cash & Cash Equivalents', [cf.netIncrease, pc2.netIncrease], 'tot', {
        k: 'cfNet', xf: ({ R: r, c }) => `${c}${r.cfOper}+${c}${r.cfInvest}+${c}${r.cfFinance}`,
      }),
      B(),
      R('Cash & Cash Equivalents at the Beginning of the year', [cf.openingCash, pc2.openingCash], 'item', { k: 'cfOpen', xf: ({ X }) => X('SFP', 'cash', 1) }),
      B(),
      R('Exchanges (Losses)/Gains on Cash & Cash Equivalents', [0, 0], 'item', { k: 'cfFx' }),
      B(),
      R('Cash & Cash Equivalents at the end of the year', [cf.closingCash, pc2.closingCash], 'grand', {
        k: 'cfClose', xf: ({ R: r, c }) => `${c}${r.cfNet}+${c}${r.cfOpen}+${c}${r.cfFx}`,
      }),
      B(), B(),
      R('The notes are an integral part of these financial statements.', [], 'note'),
      R('This is the cash flow statement referred to in our report of even date.', [], 'note'),
    ],
  });
  // A provisional cash flow reports the latest year alone (user decision
  // 2026-08-21) — the reference workbook's own prior-year column was a broken
  // `=+#REF!`, so there is nothing real to print there. The audited set keeps
  // both years. Sliced here so preview, print and Excel all agree.
  if (m.basis === 'provisional') {
    const socf = sheets[sheets.length - 1];
    socf.cols = socf.cols.slice(0, 1);
    socf.rows.forEach(rw => { if (rw.vals && rw.vals.length > 1) rw.vals = rw.vals.slice(0, 1); });
  }

  // ── 3.1 PPE: the fixed-asset matrix ──
  const pt = (out.ppe && out.ppe.totals) || {};
  const across = (get) => [...pc.map(get), pc.reduce((s, c) => s + (get(c) || 0), 0)];
  sheets.push({
    key: 'PPE', name: '3.1 PPE', geom: FSX_GEOM.PPE, matrix: true, firstRow: 2,
    title: '3.1 Property, Plant and Equipment', subtitle: 'Figures in NPR',
    heading: '3. Other Explanatory Notes',
    cols: [...pc.map(c => ({ h1: c.name })), { h1: 'Total' }],
    rows: [
      // The note heads itself: '3. Other Explanatory Notes' on row 2, the note
      // title on 3, 'Figures in NPR' on 4, then the class band on 6 with a
      // blank either side — the firm's own 3.1 PPE, row for row.
      R('3. Other Explanatory Notes', [], 'head'),
      R('3.1 Property, Plant and Equipment', [], 'sub'),
      R('Figures in NPR', [], 'fignpr'),
      B(),
      BAND(),
      B(),
      R(m.ppeOpenLabel || m.socOpenLabel || 'Balance as at beginning of the year', across(c => c.openCost), 'item', { k: 'costOpen', rowTotal: true }),
      R('Additions', across(c => c.additions), 'item', { k: 'additions', rowTotal: true }),
      R('Disposals', across(c => c.disposals), 'item', { k: 'disposals', rowTotal: true }),
      R(m.ppeCloseLabel || m.socCloseLabel || 'Balance at end of the year', across(c => c.closeCost), 'tot', {
        k: 'costClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costOpen}+${c}${r.additions}-${c}${r.disposals}`,
      }),
      B(),
      R('Depreciation and Impairment Losses: ', [], 'head'),
      B(),
      R(m.ppeOpenLabel || m.socOpenLabel || 'Balance as at beginning of the year', across(c => c.openDep), 'item', { k: 'depOpen', rowTotal: true }),
      R(m.depChargeLabel || 'Depreciation Charged for the Year', across(c => c.depCharge), 'item', { k: 'depCharge', rowTotal: true }),
      R('Adjustment due to Impairment Losses', across(c => c.impairment), 'item', { k: 'impair', rowTotal: true }),
      R('Disposals', across(c => c.disposalDep), 'item', { k: 'depDisposal', rowTotal: true }),
      R(m.ppeCloseLabel || m.socCloseLabel || 'Balance at end of the year', across(c => c.closeDep), 'tot', {
        k: 'depClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.depOpen}+${c}${r.depCharge}+${c}${r.impair}-${c}${r.depDisposal}`,
      }),
      B(),
      R('Carrying Amount:', [], 'head'),
      B(),
      R(m.carryOpenLabel || 'As at beginning of the year', across(c => c.openCarrying), 'item', {
        k: 'carryOpen', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costOpen}-${c}${r.depOpen}`,
      }),
      B(),
      R(m.carryCloseLabel || 'As at end of the year', across(c => c.closeCarrying), 'grand', {
        k: 'carryClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costClose}-${c}${r.depClose}`,
      }),
    ],
  });

  // ── Sch-BS: balance-sheet notes 3.2–3.10 ──
  // ── zero-line suppression, provisional sets only (user ask 2026-08-22) ──
  // Every note stays visible, but DETAIL lines that are nil in BOTH years
  // drop: 3.3's extra receivables (advance tax etc. — trade receivables and
  // the impairment provision always print), 3.8's non-current facilities
  // (the current OD/CC side always prints), 3.9's duties-and-taxes block,
  // 3.12's direct-cost lines (opening, purchases and closing always print),
  // and 3.15's expense heads. A line nil this year but real last year keeps
  // its comparative. The audited set is untouched.
  const nil = (v) => Math.abs(v || 0) < 0.005;
  const skipNil = m.basis === 'provisional';

  // ── 3.3's comparative column: the prior-year note's own split ──
  // The parser keeps only the lines beneath the trade block (advance tax,
  // VAT, deposits…), so the trade line's comparative is the SFP total less
  // those — exactly the figure the prior-year note itself printed. A line the
  // current year no longer carries is appended with a nil CY rather than
  // dropped, or the comparative column stops footing to its own total.
  const recvNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const pyRecvPool = (py.receivableItems || []).map(p => ({ norm: recvNorm(p.name), name: p.name, amount: p.amount, used: false }));
  const pyRecvOthers = pyRecvPool.reduce((s, p) => s + (p.amount || 0), 0);
  const recvAll = (bal.receivableLines || []).map((l, i) => {
    if (i === 0) return { ...l, pyAmount: (pySfp.receivables || 0) - pyRecvOthers };
    if (l.key === 'impairment' || /impair/i.test(l.name || '')) return { ...l, pyAmount: 0 };
    // Claim on `pyName` (the prior-year spelling an extra line was seeded
    // from) so a renamed line keeps its comparative; the engine's own `py`
    // stands in when the claim finds nothing.
    const n = recvNorm(l.pyName || l.name);
    let hit = pyRecvPool.find(p => !p.used && p.norm && p.norm === n);
    if (!hit) hit = pyRecvPool.find(p => !p.used && p.norm && n && (p.norm.includes(n) || n.includes(p.norm)));
    if (!hit) return { ...l, pyAmount: l.py || 0 };
    hit.used = true;
    return { ...l, pyAmount: hit.amount };
  });
  recvAll.push(...pyRecvPool.filter(p => !p.used && !nil(p.amount))
    .map(p => ({ name: p.name, amount: 0, pyAmount: p.amount })));
  const recvLines = skipNil
    ? recvAll.filter((l, i) => i === 0 || l.key === 'impairment' || /impair/i.test(l.name || '') || !nil(l.amount) || !nil(l.pyAmount))
    : recvAll;
  // ── 3.9's comparative column, matched by NORMALISED name ──
  // The firm spells the same head differently across years ("TDS on Wages" vs
  // "TDS Payable-Wages"), so raw substring matching silently dropped real
  // figures; "payable"/"on" are filler, not meaning. Exact match wins before
  // inclusion is tried, or "TDS Payable-Audit fee" would swallow "Audit Fee
  // Payable"'s figure. Each prior-year line is claimed once — the engine
  // carries a spare nil "TDS Payable-Wages" row that must not double-count
  // the real one — and unclaimed prior-year lines are appended with a nil CY:
  // trading ones with the trading payables, TDS/VAT ones in the duties block.
  const payNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(payables?|on)\b/g, '').replace(/\s+/g, '');
  const pyPayPool = (py.payableItems || []).map(p => ({ norm: payNorm(p.name), name: p.name, amount: p.amount, used: false }));
  const pyPayClaim = (name) => {
    const n = payNorm(name);
    if (!n) return null;
    let hit = pyPayPool.find(p => !p.used && p.norm === n);
    if (!hit) hit = pyPayPool.find(p => !p.used && p.norm && (p.norm.includes(n) || n.includes(p.norm)));
    if (!hit) return null;
    hit.used = true;
    return hit.amount;
  };
  // Claim on `pyName` (the prior-year spelling an extra line was seeded
  // from) so a renamed line keeps its comparative; the engine's own `py`
  // stands in when the claim finds nothing.
  const payLines = (bal.payableLines || []).map(l => {
    const claimed = pyPayClaim(l.pyName || l.name);
    return { ...l, pyAmount: claimed != null ? claimed : (l.py || 0) };
  });
  {
    const isDuty = (nm) => /^tds|^vat/i.test(String(nm || '').trim());
    const before = [], after = [];
    for (const p of pyPayPool) {
      if (p.used || nil(p.amount)) continue;
      (isDuty(p.name) ? after : before).push({ name: p.name, amount: 0, pyAmount: p.amount });
    }
    const splitAt = payLines.findIndex(l => /^tds/i.test(l.name || ''));
    if (splitAt > 0) payLines.splice(splitAt, 0, ...before);
    else payLines.push(...before);
    payLines.push(...after);
  }
  // Prior-year figures for the notes whose comparative column would otherwise
  // be blank. Matched by label against the client's own 3.8 lines rather than
  // splitting the SFP total, which would be inventing a breakdown.
  const pyFind = (list, re) => {
    const hit = (list || []).find(it => re.test(String(it.name)));
    return hit ? hit.amount : 0;
  };
  const pyLoan = (re) => pyFind(py.loanItems, re);

  // ── 3.8 loan lines ──
  // A provisional set names the client's real facilities ("Vehicle Loan(EBL)",
  // "Director Loan"), which is what the firm's own note lists. The audited
  // engine has no such list, so it keeps the four standing categories it
  // solves for — hence the fallback rather than a rewrite.
  const mkLoanRows = (list, prefix, fallback) => {
    const rows = [], keys = [];
    if (list && list.length) {
      list.forEach((l, i) => {
        const k = prefix + i;
        keys.push(k);
        rows.push(R(l.name || 'Loan', [l.amount || 0, l.py || 0], 'item', { k }));
      });
    } else {
      fallback.forEach((f) => { keys.push(f.k); rows.push(R(f.label, f.vals, 'item', { k: f.k })); });
    }
    return { rows, keys };
  };
  // A nil non-current facility drops from 3.8 (provisional); when every one
  // is nil the whole Non-Current block goes with them — but the current side
  // (bank loan / OD) always prints, even at nil.
  const ncLines = skipNil && bal.loanNCLines
    ? bal.loanNCLines.filter(l => !nil(l.amount) || !nil(l.py))
    : bal.loanNCLines;
  const ncSpec = (ncLines && !ncLines.length)
    ? { rows: [], keys: [] }
    : mkLoanRows(ncLines, 'loanNC', [
      { k: 'loanTerm', label: 'Term Loan', vals: [(out.rawFigures || {}).H || 0, pyLoan(/term/i)] },
      { k: 'loanPwc', label: 'PWC Loan', vals: [(out.rawFigures || {}).I || 0, pyLoan(/pwc|permanent/i)] },
      { k: 'loanHp', label: 'HP Loan', vals: [(out.rawFigures || {}).J || 0, pyLoan(/\bhp\b|hire/i)] },
      { k: 'loanDir', label: T.person + ' Loan', vals: [(out.levers || {}).directorLoan || 0, pyLoan(/director|proprietor|partner/i)] },
    ]);
  const cSpec = mkLoanRows(bal.loanCLines, 'loanC', [
    { k: 'loanOd', label: 'Bank Overdrafts', vals: [bal.loansCurrent, pySfp.loansC] },
  ]);
  const loanNCRows = ncSpec.rows, loanNCKeys = ncSpec.keys;
  const loanCRows = cSpec.rows, loanCKeys = cSpec.keys;
  const showLoanNC = loanNCRows.length > 0;

  // ── note 3.4's rows: the stock schedule's groups, or the standard three ──
  const invLines = bal.inventoryLines;
  const invRows = [], invKeys = [];
  if (invLines && invLines.length) {
    invLines.forEach((l, i) => {
      const k = 'inv' + i;
      invKeys.push(k);
      // The grand total still reaches Sch-PL's closing stock, so the two
      // sheets cannot disagree about what the stock is worth.
      invRows.push(R(l.name, [l.amount, 0], 'item', { k }));
    });
  } else {
    invKeys.push('invRaw', 'invWip', 'invFg');
    invRows.push(
      R('Raw materials and consumables', [0, 0], 'item', { k: 'invRaw' }),
      R('Work-in-progress', [0, 0], 'item', { k: 'invWip' }),
      R('Finished Goods', [bal.inventories, pySfp.inventories], 'item', { k: 'invFg', xf: ({ X }) => X('SchPL', 'matClosing') }),
    );
  }

  // ── 3.6 Share Capital — ONE box, matching the firm's own reference note
  // (user ask 2026-08-21, replacing the three Number×NPR quad sub-tables):
  // an italic sub-heading and a single "{count} Equity Shares @ Rs. {face}
  // each" line per section, both years side by side, one Total. Share COUNTS
  // are the face value divided into the capital, so the note cannot disagree
  // with the balance sheet; authorised is a constitutional figure the
  // preparer states and defaults to the issued count when nothing is on
  // file. A proprietorship/partnership carries one capital line instead.
  const capFace = fsxIsNum(m.shareFace) && m.shareFace > 0 ? m.shareFace : 100;
  const capCy = bal.shareCapital || 0;
  const capPy = pySfp.shareCapital || 0;
  const nShares = (v) => (capFace ? v / capFace : 0);
  // Authorized and Issued are typed AMOUNTS (user ask 2026-08-28 — prefilled
  // editable boxes), each falling back down the ladder: issued → paid-up,
  // authorized → issued. A pre-2026-08-28 save carries an authorised share
  // COUNT instead, still honoured.
  const capIssuedAmt = fsxIsNum(m.issuedCapital) && m.issuedCapital > 0 ? m.issuedCapital : capCy;
  const capAuthAmt = fsxIsNum(m.authorisedCapital) && m.authorisedCapital > 0 ? m.authorisedCapital
    : (fsxIsNum(m.authorisedShares) && m.authorisedShares > 0 ? m.authorisedShares * capFace
      : Math.max(capIssuedAmt, capCy, capPy));
  const shareLine = (n) => `${Math.round(n)} Equity Shares @ Rs. ${capFace} each`;
  // A proprietorship or partnership carries ONE capital line, worded by the
  // entity ("Proprietors Capital" / "Partners Capital" — T.capital, which
  // also heads the note); the three share-capital sections are a company's.
  const capProp = /proprietor|partner/i.test(`${T.entity || ''} ${T.capital || ''}`);
  const capitalBlock = capProp
    ? [
      BAND(),
      R(/capital/i.test(T.capital || '') ? T.capital : "Proprietor's/Partner's Capital", [capCy, capPy], 'item', { k: 'capPaid' }),
      R('Total', [capCy, capPy], 'tot', { k: 'capTotal', xsum: ['capPaid'] }),
      B(),
    ]
    : [
      BAND(),
      R('Authorized Share Capital', [], 'sub', { italic: true }),
      R(shareLine(nShares(capAuthAmt)), [capAuthAmt, capAuthAmt], 'item', { k: 'capAuth' }),
      B(),
      R('Issued Share Capital', [], 'sub', { italic: true }),
      R(shareLine(nShares(capIssuedAmt)), [capIssuedAmt, capPy], 'item', { k: 'capIssued' }),
      B(),
      R('Paid-Up Share Capital', [], 'sub', { italic: true }),
      R(shareLine(nShares(capCy)), [capCy, capPy], 'item', { k: 'capPaid' }),
      R('Total', [capCy, capPy], 'tot', { k: 'capTotal', xsum: ['capPaid'] }),
      B(),
    ];

  const schBsRows = [
    R('3.2 Investment', [], 'head', { figNpr: true }),
    B(),
    BAND(),
    R('Balance as at beginning of the year', [bal.investmentsNC + bal.investmentsC, (pySfp.investmentsNC || 0) + (pySfp.investmentsC || 0)], 'item', { k: 'invOpen' }),
    R('Additions', [0, 0], 'item', { k: 'invAdd' }),
    R('Disposals', [0, 0], 'item', { k: 'invDis' }),
    R('Balance as at Ashadh End', [bal.investmentsNC + bal.investmentsC, (pySfp.investmentsNC || 0) + (pySfp.investmentsC || 0)], 'tot', {
      k: 'invClose', xf: ({ R: r, c }) => `${c}${r.invOpen}+${c}${r.invAdd}-${c}${r.invDis}`,
    }),
    R('Less: non-current portion', [bal.investmentsNC, pySfp.investmentsNC], 'item', { k: 'invNCPortion' }),
    R('Current portion', [bal.investmentsC, pySfp.investmentsC], 'tot', {
      k: 'invCurrent', xf: ({ R: r, c }) => `${c}${r.invClose}-${c}${r.invNCPortion}`,
    }),
    B(), B(),
    R('3.3 Trade & Other Receivables', [], 'head', { figNpr: true }),
    BAND(),
  ];
  // The firm's 3.3 strikes a "Trade receivables-net" subtotal immediately
  // after the impairment provision, and the note's Total then adds the other
  // receivables to THAT rather than to the gross figure. Emitted only when an
  // impairment line exists, so a client without one keeps the flat list.
  const recvImpIdx = recvLines.findIndex(l => l.key === 'impairment' || /impair/i.test(l.name || ''));
  const recvSumKeys = [];
  recvLines.forEach((l, i) => {
    schBsRows.push(R(l.name, [l.amount, l.pyAmount || 0], 'item', {
      k: 'recv' + i, balancing: !!l.balancing,
      xf: l.derive ? fsxDeriveXf(l.derive, ANCHORS) : undefined,
    }));
    if (i === recvImpIdx && recvImpIdx > 0) {
      const gross = (recvLines[recvImpIdx - 1] || {}).amount || 0;
      const pyGross = (recvLines[recvImpIdx - 1] || {}).pyAmount || 0;
      schBsRows.push(R('Trade receivables-net', [gross - (l.amount || 0), pyGross - (l.pyAmount || 0)], 'tot', {
        k: 'recvNet',
        xf: ({ R: r, c }) => `${c}${r['recv' + (recvImpIdx - 1)]}-${c}${r['recv' + recvImpIdx]}`,
      }));
      recvSumKeys.length = 0;            // the net subsumes the two above it
      recvSumKeys.push('recvNet');
    } else {
      recvSumKeys.push('recv' + i);
    }
  });
  schBsRows.push(
    R('Total trade and other receivables', [bal.receivables, pySfp.receivables], 'tot', {
      k: 'recvTotal', xsum: recvSumKeys,
    }),
    R('Less: Non-current portion', [0, 0], 'item', { k: 'recvNC' }),
    R('Current portion', [bal.receivables, pySfp.receivables], 'tot', {
      k: 'recvCurrent', xf: ({ R: r, c }) => `${c}${r.recvTotal}-${c}${r.recvNC}`,
    }),
    B(), B(),
    R('3.4 Inventories', [], 'head', { figNpr: true }),
    BAND(),
    // When a closing-stock schedule was entered, note 3.4 shows ITS groups —
    // the firm's own sheet lands `stock!E11` and `stock!E19` on separate rows
    // for exactly that reason. Without one, the three standard heads stand and
    // the whole figure sits on Finished Goods, as before.
    ...invRows,
    R('Total', [bal.inventories, pySfp.inventories], 'tot', { k: 'invTotal', xsum: invKeys }),
    B(),
    R('3.5 Cash & Cash Equivalents', [], 'head', { figNpr: true }),
    R('Cash and cash equivalents for purposes of the statement of cash follows comprises :', [], 'note'),
    B(),
    BAND(),
    R('Cash in Hand & Bank Balances', [bal.cash, pySfp.cash], 'item', { k: 'cashBank' }),
    R('Total', [bal.cash, pySfp.cash], 'tot', { k: 'cashTotal', xsum: ['cashBank'] }),
    B(),
    R('3.6 ' + T.capital, [], 'head', { figNpr: true }),
    B(),
    ...capitalBlock,
    R('3.7 Reserves', [], 'head'),
    R('The reserves to be included within the Equity are share premium, retained earnings and other reserves', [], 'note'),
    B(), B(),
    R('3.8 Loans Borrowings', [], 'head', { figNpr: true }),
    R('The details of value of loans and borrowings are as follows:', [], 'sub'),
    BAND(),
    ...(showLoanNC ? [
      R('Non-Current :', [], 'sub'),
      ...loanNCRows,
      R('Total', [bal.loansNonCurrent, pySfp.loansNC], 'tot', { k: 'loanNCTotal', xsum: loanNCKeys }),
    ] : []),
    R('Current :', [], 'sub'),
    ...loanCRows,
    R('Total', [bal.loansCurrent, pySfp.loansC], 'tot', { k: 'loanCTotal', xsum: loanCKeys }),
    B(),
    R('Total loans and borrowings', [(bal.loansNonCurrent || 0) + (bal.loansCurrent || 0), (pySfp.loansNC || 0) + (pySfp.loansC || 0)], 'tot', {
      k: 'loanAll', xsum: showLoanNC ? ['loanNCTotal', 'loanCTotal'] : ['loanCTotal'],
    }),
    B(), B(),
    R('3.9 Trade and Other Payables', [], 'head', { figNpr: true }),
    BAND(),
  );
  // The firm's 3.9 separates the two trading payables from the statutory
  // withholdings with a blank and a "Duties and taxes:" sub-heading. On a
  // provisional set a nil duty drops; the trading payables above the split
  // always print. Filter first, then find the split again — if no duty
  // survives, the sub-heading goes with them.
  const dutiesStart = payLines.findIndex(l => /^tds/i.test(l.name || ''));
  // Extra lines ('xpay…') are nil-suppressed wherever they sit — they live
  // ABOVE the duties split, where structural rows are otherwise always kept.
  const payKeep = (skipNil && dutiesStart > 0)
    ? payLines.filter((l, i) => (i < dutiesStart && !/^xpay/.test(l.key || '')) || !nil(l.amount) || !nil(l.pyAmount))
    : payLines;
  const payDutiesIdx = payKeep.findIndex(l => /^tds/i.test(l.name || ''));
  // Rows register under the ENGINE's stable key when one exists ('pay'+i for
  // the appended prior-year-only rows) — a positional key renumbers whenever
  // zero-suppression drops a row or an extra line splices in, and the
  // fee-net-of-TDS formula would then subtract whatever landed seventh.
  const payRowKeys = [];
  payKeep.forEach((l, i) => {
    if (i === payDutiesIdx && payDutiesIdx > 0) {
      schBsRows.push(B());
      schBsRows.push(R('Duties and taxes:', [], 'sub', { italic: true }));
    }
    const extra = { k: l.key || ('pay' + i) };
    payRowKeys.push(extra.k);
    // An explicit descriptor from the engine wins: it knows which figure the
    // line withholds from, where name-matching only guesses. The regex arm
    // stays for the audited module, which attaches none.
    if (l.derive) extra.xf = fsxDeriveXf(l.derive, ANCHORS);
    else if (/tds on salary/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'empTotal'); return x ? `${x}*1%` : null; };
    else if (/tds on rent/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'rent'); return x ? `${x}*10%` : null; };
    else if (/tds payable-audit/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'auditFee'); return x ? `${x}*1.5%` : null; };
    schBsRows.push(R(l.name, [l.amount, l.pyAmount || 0], 'item', extra));
  });
  schBsRows.push(
    R('Total', [bal.totalPayables, pySfp.payables], 'tot', { k: 'payTotal', xsum: payRowKeys }),
    R('3.10 Provisions', [], 'head', { figNpr: true }),
    BAND(),
    R('Provision for Income Tax', [inc.tax, pySoi.tax], 'item', { k: 'provTax', xf: ({ X }) => X('SOI', 'tax') }),
    R('Total', [inc.tax, pySoi.tax], 'tot', { k: 'provTotal', xsum: ['provTax'] }),
    R('Non-Current Portion', [bal.provisionsNC, pySfp.provisionsNC], 'item', { k: 'provNCPortion' }),
    R('Current Portion', [bal.provisionsC, pySfp.provisionsC], 'tot', {
      k: 'provCurrent', xf: ({ R: r, c }) => `${c}${r.provTotal}-${c}${r.provNCPortion}`,
    }),
  );
  sheets.push({
    key: 'SchBS', name: 'Sch-BS', geom: FSX_GEOM.SchBS, firstRow: 2, quadCols: ['D', 'F', 'H', 'J'],
    title: 'Schedules to the Statement of Financial Position', subtitle: 'Figures in NPR',
    cols: [{ h1: 'As at', h2: cyHead }, { h1: 'As at', h2: pyHead }],
    rows: schBsRows,
  });

  // ── Sch-PL: income-statement notes 3.11–3.16 ──
  const pyMat = py.materials || {};
  const schPlRows = [
    R('3.11 Revenue from Operations', [], 'head', { figNpr: true }),
    BAND(),
    R('Revenue From Operations:', [], 'sub'),
    R('Sale of Goods', [m.serviceIndustry ? 0 : inc.revenueOps, pySoi.revenueOps], 'item', { k: 'saleGoods' }),
    R('Rendering of Services', [m.serviceIndustry ? inc.revenueOps : 0, 0], 'item', { k: 'saleServices' }),
    R('Sub-Total', [inc.revenueOps, pySoi.revenueOps], 'tot', { k: 'revOpsSub', xsum: ['saleGoods', 'saleServices'] }),
    R('Revenue From Other Operations:', [], 'sub'),
    R('Commisions & Incentives', [inc.revenueOther, 0], 'item', { k: 'revComm' }),
    R('Sub-Total', [inc.revenueOther, 0], 'tot', { k: 'revOtherSub', xsum: ['revComm'] }),
    B(),
    R('Total', [(inc.revenueOps || 0) + (inc.revenueOther || 0), pySoi.revenueOps], 'tot', { k: 'revTotal', xsum: ['revOpsSub', 'revOtherSub'] }),
    B(),
    R('Revenue From Non-Operations:', [], 'sub'),
    R('Interest Income', [inc.interestIncome, pySoi.interestIncome], 'item', { k: 'intIncome' }),
    R('Commisions & Incentives', [inc.otherIncome, pySoi.otherIncome], 'item', { k: 'othIncome' }),
    R('Total', [(inc.interestIncome || 0) + (inc.otherIncome || 0), (pySoi.interestIncome || 0) + (pySoi.otherIncome || 0)], 'tot', { k: 'nonOpTotal', xsum: ['intIncome', 'othIncome'] }),
    B(),
    R('3.12 Materials Consumed Expenses', [], 'head', { figNpr: true }),
    BAND(),
    // This year's opening stock IS last year's closing — the template's =+F33,
    // reaching across to the comparative column of the row below.
    R('Balance on beginning of the year', [mat.opening, pyMat.opening], 'item', {
      k: 'matOpening', xf: ({ X }) => X('SchPL', 'matClosing', 1),
    }),
    R('Add:  ', [], 'sub'),
    R('Purchases of goods', [mat.purchases, pyMat.purchases], 'item', { k: 'matPurchase', balancing: true }),
  ];
  // 3.12's direct-cost lines (Labour, Clearing & Freight, extras) pair with
  // their prior-year figure BY INDEX, so the nil test runs on the pair before
  // anything renumbers. Opening, purchases and closing always print.
  // The engine's own py (matched by keyword — "Wages Expenses" IS Labour
  // Charges) wins over blind index pairing, which mispairs when the two
  // years carry different line sets.
  const directPairs = (mat.directItems || []).map((it, i) => ({ it, py: it.py != null ? it.py : (((pyMat.directItems || [])[i] || {}).amount || 0) }));
  const directKeep = skipNil ? directPairs.filter(p => !nil(p.it.amount) || !nil(p.py)) : directPairs;
  directKeep.forEach((p, i) => {
    schPlRows.push(R(p.it.name, [p.it.amount, p.py], 'item',
      { k: 'matDirect' + i, xf: fsxDeriveXf(p.it.derive, ANCHORS) }));
  });
  schPlRows.push(
    R('Less:', [], 'sub'),
    R('Balance as at end of the year', [mat.closing, pyMat.closing], 'item', { k: 'matClosing' }),
    R('Total', [mat.total, pySoi.materials], 'tot', {
      k: 'matTotal',
      xf: ({ R: r, c }) => {
        const adds = ['matOpening', 'matPurchase', ...directKeep.map((_, i) => 'matDirect' + i)]
          .filter(k => r[k]).map(k => `${c}${r[k]}`).join('+');
        return adds ? `${adds}-${c}${r.matClosing}` : null;
      },
    }),
    B(),
    R('3.13 Employee Benefits Expenses', [], 'head', { figNpr: true }),
    BAND(),
  );
  (inc.employeeItems || []).forEach((it, i) => {
    const pyEmp = it.py != null ? it.py : (((py.employeeItems || [])[i] || {}).amount || 0);
    schPlRows.push(R(it.name, [it.amount, pyEmp], 'item', { k: 'emp' + i, xf: fsxDeriveXf(it.derive, ANCHORS) }));
  });
  schPlRows.push(
    R('Total', [inc.employeeTotal, pySoi.employee], 'tot', { k: 'empTotal', xsum: (inc.employeeItems || []).map((_, i) => 'emp' + i) }),
    B(),
    // The related-party disclosure the firm's own 3.13 carries. Nil unless a
    // director's remuneration is entered, but the note is a disclosure: it has
    // to appear and say nil rather than be absent.
    R('Key management personnel compensation:', [], 'sub'),
    R('Key management personnel are those persons having authority and responsibility for planning, directing and controlling the activities of the entity, including the director.', [], 'note'),
    BAND(),
    R('Salary', [inc.kmpSalary || 0, (py.kmpSalary || 0)], 'item', { k: 'kmpSalary' }),
    R('Total', [inc.kmpSalary || 0, (py.kmpSalary || 0)], 'tot', { k: 'kmpTotal', xsum: ['kmpSalary'] }),
    B(), B(),
    R('3.14 Finance Cost', [], 'head', { figNpr: true }),
    BAND(),
  );
  // 3.14's comparative is matched by KEYWORD, never index: the prior year's
  // note orders its lines differently per client ("Interest Expenses on
  // OD/CC/STL" then "Bank comission…"), so index pairing put the commission
  // figure on the Term row. Each prior-year line is claimed once; unclaimed
  // ones with a figure are appended with a nil CY so the column still foots.
  const pyFinPool = (py.financeItems || []).map(p => ({ name: p.name, amount: p.amount, used: false }));
  const pyFinClaim = (it) => {
    if (it.py != null) return it.py;
    const re = it.key === 'interestOD' ? /\bod\b|\bcc\b|\bstl\b|overdraft|short/i
      : it.key === 'interestTerm' ? /term/i
        : it.key === 'bankCharges' ? /charge|com+ission/i : null;
    const hit = re && pyFinPool.find(p => !p.used && re.test(p.name || ''));
    if (!hit) return 0;
    hit.used = true;
    return hit.amount;
  };
  const finKeys = [];
  (inc.financeItems || []).forEach((it, i) => {
    finKeys.push('fin' + i);
    schPlRows.push(R(it.name, [it.amount, pyFinClaim(it)], 'item', { k: 'fin' + i }));
  });
  pyFinPool.filter(p => !p.used && !nil(p.amount)).forEach((p, j) => {
    finKeys.push('finPy' + j);
    schPlRows.push(R(p.name, [0, p.amount], 'item', { k: 'finPy' + j }));
  });
  schPlRows.push(
    R('Total', [inc.financeTotal, pySoi.financeCost], 'tot', { k: 'finTotal', xsum: finKeys }),
    B(),
    R('3.15 Other Expenses', [], 'head', { figNpr: true }),
    BAND(),
  );
  const pyOtherByName = {};
  for (const it of (py.otherItems || [])) pyOtherByName[String(it.name).toLowerCase().trim()] = it.amount;
  // A 3.15 head nil in both years drops (provisional) — a client's note
  // otherwise lists every head the firm has ever used at "–". The engine's
  // own py (alias-merged when the head was read) wins over the name map.
  const pyOther = (it) => (it.py != null ? it.py : (pyOtherByName[String(it.name).toLowerCase().trim()] || 0));
  const otherKeep = skipNil
    ? (inc.otherItems || []).filter(it => !nil(it.amount) || !nil(pyOther(it)))
    : (inc.otherItems || []);
  otherKeep.forEach((it, i) => {
    const key = /audit\s*fee/i.test(it.name) ? 'auditFee' : (/\brent\b/i.test(it.name) ? 'rent' : 'oth' + i);
    schPlRows.push(R(it.name, [it.amount, pyOther(it)], 'item',
      { k: key, oi: i, xf: fsxDeriveXf(it.derive, ANCHORS) }));
  });
  schPlRows.push(
    R('Total', [inc.otherTotal, pySoi.otherExpenses], 'tot', {
      k: 'othTotal',
      xsum: otherKeep.map((it, i) => /audit\s*fee/i.test(it.name) ? 'auditFee' : (/\brent\b/i.test(it.name) ? 'rent' : 'oth' + i)),
    }),
    B(),
    R('3.16 Tax Expenses ', [], 'head', { figNpr: true }),
    BAND(),
    R('Tax on profits for the year', [inc.tax, pySoi.tax], 'item', {
      k: 'taxYear',
      // Provisional sets carry the rate live off PBT (the workbook's
      // `=+SOI!F27*0.25`); audited sets keep pointing at the COI computation,
      // which is where an audited year's tax is actually settled.
      // With no COI sheet the fallback reference would be dead, so a
      // provisional set must carry its own rate formula (inc.taxDerive).
      xf: inc.taxDerive ? fsxDeriveXf(inc.taxDerive, ANCHORS) : (m.omitCoi ? null : ({ X }) => X('COI', 'tax')),
    }),
    R('Adjustments for under provision in prior periods', [0, 0], 'item', { k: 'taxAdj' }),
    R('Total', [inc.tax, pySoi.tax], 'tot', { k: 'taxTotal', xsum: ['taxYear', 'taxAdj'] }),
  );
  sheets.push({
    key: 'SchPL', name: 'Sch-PL', geom: FSX_GEOM.SchPL, firstRow: 3,
    title: 'Schedules to the Statement of Income', subtitle: 'Figure in NPR',
    cols: [{ h1: 'Year Ended', h2: yrHead }, { h1: 'Year Ended', h2: yrHeadPy }],
    rows: schPlRows,
  });

  // ── Trial Balance: the ledger the statements were built from ──
  //
  //  LAST in the set, after Sch-PL (user ask 2026-08-30) — it is the working
  //  behind the statements, not a preface to them.
  //
  //  The firm's own TB sheet has section subtotals but no block totals and no
  //  grand total, so those are added here. What makes the page an audit trail
  //  is not a description column (there was one, removed the same day) but the
  //  fact that the OTHER SHEETS POINT AT IT: once this sheet exists, every
  //  statement cell holding a figure this trial balance supplied is written as
  //  `='Trial Balance'!E11` rather than as a literal. See the linking pass
  //  below fsxBuildReport's sheet list.
  //
  //  Printed only when a trial balance was actually imported.
  const tb = out.tb;
  if (tb && tb.blocks && tb.blocks.length) {
    const tbRows = [];
    let grandDr = 0, grandCr = 0;
    for (const blk of tb.blocks) {
      tbRows.push(R(blk.title, [], 'head'));
      let blockTotal = 0;
      for (const sec of blk.sections) {
        // Keys are stable and derived from the reader's own ids, so the
        // linking pass can address any row here by name OR by section.
        const secKey = 'sec_' + blk.id + '_' + sec.id;
        tbRows.push(R(sec.title, [null, sec.total], sec.lines.length ? 'sub' : 'item', { k: secKey }));
        sec.lines.forEach((l, i) => {
          tbRows.push(R('    ' + l.name, [l.amount, null], 'item', { k: 'ln_' + blk.id + '_' + sec.id + '_' + i }));
        });
        if (sec.lines.length) {
          tbRows.push(R('    Total ' + sec.shortTitle, [null, sec.total], 'tot', { k: secKey + '_tot' }));
        }
        blockTotal += sec.total;
      }
      tbRows.push(R('Total ' + blk.title, [null, blockTotal], 'tot'));
      tbRows.push(B());
      if (blk.side === 'dr') grandDr += blockTotal; else grandCr += blockTotal;
    }
    tbRows.push(R('Total of Assets & Expenses', [null, grandDr], 'grand'));
    tbRows.push(R('Total of Revenue, Equity & Liabilities', [null, grandCr], 'grand'));
    tbRows.push(R('Difference in Trial', [null, grandDr - grandCr], 'grand'));
    tbRows.push(B());
    tbRows.push(R(Math.abs(grandDr - grandCr) <= 0.5
      ? 'The trial balance foots. Every statement figure taken from it is a live reference to this sheet.'
      : 'THE TRIAL BALANCE DOES NOT FOOT — the difference above is unexplained. The figures have still been carried through.', [], 'note'));

    sheets.push({
      key: 'TB', name: 'Trial Balance', geom: FSX_GEOM.TB, matrix: true,
      title: 'TRIAL BALANCE', subtitle: m.asAtLine,
      cols: [{ h1: '', h2: 'Detail' }, { h1: '', h2: 'Total' }],
      rows: tbRows,
    });

    // ── the linking pass: point every statement cell at this sheet ──
    //
    //  A cell is linked when its LABEL matches a trial-balance row AND its
    //  current-year VALUE still equals that row's figure. Both conditions
    //  matter:
    //
    //   · the label alone would link "Other Expenses" in three different
    //     sections to whichever it met first;
    //   · the value is what makes a figure the preparer has TYPED OVER stay a
    //     literal. It no longer equals the ledger, so it must not claim to
    //     come from it — which is the same contract the on-screen provenance
    //     badge follows.
    //
    //  Matching on the pair rather than on a hand-kept table of row keys is
    //  also what lets a client's own expense heads link without anyone
    //  maintaining a list of them.
    const tbByLabel = {};
    for (const r of tbRows) {
      if (!r.k || r.kind === 'tot' || r.kind === 'grand') continue;
      const lbl = fsxLinkKey(r.label);
      if (!lbl) continue;
      // WHICH column holds the figure matters: a detail line carries it in
      // Detail (index 0) and a section row in Total (index 1). Linking every
      // row to index 0 produced `='Trial Balance'!C40` against an empty cell
      // for every section — a reference that reads fine and resolves to nil.
      const ci = (r.vals || []).findIndex(x => fsxIsNum(x));
      if (ci < 0) continue;
      const v = r.vals[ci];
      // A nil needs no reference, and zero matches far too many rows.
      if (Math.abs(v) < 0.005) continue;
      // First writer wins, so a section subtotal is not displaced by a line
      // that happens to repeat its wording.
      if (!tbByLabel[lbl]) tbByLabel[lbl] = { k: r.k, v, ci };
    }
    // The handful whose statement wording differs from the ledger's. Keyed by
    // the STATEMENT label, valued by the trial-balance section id.
    const TB_ALIAS = {
      'cash in hand bank balances': 'sec_assets_cash',
      'cash and cash equivalents': 'sec_assets_cash',
      'purchases of goods': 'sec_expenses_purchases',
      'sale of goods': 'sec_revenue_revenue',
      'balance on end of the year': 'sec_assets_inventories',
      'closing stock': 'sec_assets_inventories',
    };
    for (const [lbl, key] of Object.entries(TB_ALIAS)) {
      const row = tbRows.find(r => r.k === key);
      if (!row || tbByLabel[lbl]) continue;
      const ci = (row.vals || []).findIndex(x => fsxIsNum(x));
      if (ci >= 0 && Math.abs(row.vals[ci]) >= 0.005) tbByLabel[lbl] = { k: key, v: row.vals[ci], ci };
    }

    let linked = 0;
    for (const sh of sheets) {
      if (sh.key === 'TB') continue;
      for (const r of sh.rows) {
        if (!r.k || r.xf || r.xsum || r.colSum) continue;   // never displace a real formula
        const hit = tbByLabel[fsxLinkKey(r.label)];
        if (!hit) continue;
        const cy = (r.vals || [])[0];
        if (!fsxIsNum(cy) || Math.abs(cy - hit.v) > 0.005) continue;
        r.xf = ({ X }) => X('TB', hit.k, hit.ci);
        linked++;
      }
    }
    if (linked) issues.push({ level: 'info', msg: `${linked} statement figures are written as live references to the Trial Balance sheet.` });
  }

  // ── which comparative-column aggregations may carry a formula ──
  // The firm's own workbook wires BOTH columns with formulas. We follow it, but
  // only where the sum provably reproduces the figure the prior-year statement
  // actually reported: a client's reported total need not foot from the lines a
  // sheet breaks out (note 3.12 disagreeing with the SFP is a documented real
  // case), and a SUM there would silently restate a signed year. Where it does
  // not foot we keep the literal and report it — shown, never forced, the same
  // idiom as the three proofs.
  for (const sh of sheets) {
    if (sh.matrix) continue;                       // matrix sheets sum across, not down
    const byKey = {};
    for (const r of sh.rows) if (r.k) byKey[r.k] = r;
    for (const r of sh.rows) {
      const keys = r.xsum || r.colSum;
      if (!keys || !keys.length) continue;
      const reported = (r.vals || [])[1];
      if (!fsxIsNum(reported)) continue;
      let sum = 0, seen = 0;
      for (const k of keys) {
        const src = byKey[k];
        if (!src) continue;
        const v = (src.vals || [])[1];
        if (fsxIsNum(v)) { sum += v; seen++; }
      }
      if (!seen) continue;
      if (Math.abs(r2(sum) - r2(reported)) < 0.5) r.pyFooted = true;
      else {
        issues.push({
          level: 'warn',
          msg: `${sh.name} — "${r.label}" comparative column: the lines add to ${fsxAmt(sum)} but the statement reported ${fsxAmt(reported)} (difference ${fsxAmt(r2(reported - sum))}). The reported figure is kept and that cell is left as a typed value, not a formula.`,
        });
      }
    }
  }

  // ── blank current year ──
  // The firm may want the statement set laid out before any current-year
  // figure exists: the comparative column carries last year in full and the
  // current-year column is left empty, to be filled in as figures arrive.
  // Rows whose current-year value is genuinely KNOWN from the prior year — the
  // SOCE opening balance and the 3.1 PPE opening cost/depreciation/carrying —
  // keep their figures, because those are last year's closing by definition.
  if (m.blankCurrentYear) {
    const KEEP = { SOCE: ['open'], PPE: ['costOpen', 'depOpen', 'carryOpen'] };
    for (const sh of sheets) {
      const keep = KEEP[sh.key] || [];
      for (const r of sh.rows) {
        if (keep.includes(r.k)) continue;
        if (sh.matrix) r.vals = (r.vals || []).map(v => (fsxIsNum(v) ? null : v));
        else r.vals = (r.vals || []).map((v, i) => (i === 0 && fsxIsNum(v) ? null : v));
      }
    }
  }

  return { meta: m, sheets, proofs: out.proofs || {}, issues };
}

// ════════════════════════════════════════════════════════════════
//  SHARED CELL FORMATTING
// ════════════════════════════════════════════════════════════════

const fsxIsNum = (v) => typeof v === 'number' && isFinite(v);

// Label key for the Trial Balance linking pass: case-, punctuation- and
// numbering-insensitive on trimmed word content — the same conservative rule
// wdWorkTypesForLabel() follows, so it can never invent a match.
const fsxLinkKey = (s) => String(s == null ? '' : s)
  .replace(/^[A-Za-z]?\s*\d*\s*[.)]\s*/, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Accounting presentation, matching the Excel number format literally: a
// leading minus for negatives (never parentheses), en-dash for nil — so the
// preview, print and Excel all read the same figure the same way.
function fsxAmt(v) {
  if (v == null || v === '') return '';
  if (!fsxIsNum(v)) return String(v);
  if (Math.abs(v) < 0.005) return '–';
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${s}` : s;
}

// PDF-Lib's standard fonts are WinAnsi and THROW on anything they can't encode
// (a true en-dash, curly quotes, Devanagari), so every string is folded to
// Latin-1 on the way into the PDF. Same hazard ReportExport.pdfSafe() guards.
function fsxPdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/₹/g, 'Rs.')
    .replace(/[^\x00-\xFF]/g, '');
}

// ════════════════════════════════════════════════════════════════
//  EXCEL — the template's geometry AND its literal styling, with live
//  cross-sheet formulas. Verified cell-by-cell against the firm's own
//  T3 Pvt.Ltd 2081.082 Provisional.xlsx (assets/templates/): Book Antiqua
//  throughout, zero fills, borders on value cells only (never the label or
//  note cell, never on a plain item row), medium-rule header band, thin+
//  double subtotal rule, double-only grand-total rule.
// ════════════════════════════════════════════════════════════════

const FSX_FONT = 'Book Antiqua';
// Schedule sheets (3.1 PPE, Sch-BS, Sch-PL) are the note workings: no
// company/address block, matching the template exactly (`Sch-BS!B2` is
// literally "3.2 Investment" — nothing above it).
const FSX_SCHEDULE_KEYS = { PPE: true, SchBS: true, SchPL: true };

// Which statement each schedule takes its period captions from. 3.1 PPE is
// absent on purpose — its columns are asset classes, not periods.
const FSX_HEADER_SOURCE = { SchBS: 'SFP', SchPL: 'SOI' };

// Where each sheet's title block ends and its data rows begin. Pure and
// data-driven (not sheet-key special-cased) so pass 1 and pass 2 agree:
// the header band sits one row later than usual only when a column is
// actually marked `restated` — exactly the SFP/SOI vs SOCE/SOCF split
// observed in the template, which turns out to be driven by that flag
// rather than by which sheet it is.
function fsxLayout(sh) {
  if (sh.noHeaderBand) return { bandRow: null, firstDataRow: 2 };
  if (FSX_SCHEDULE_KEYS[sh.key]) {
    // A schedule carries a header band under EVERY note, not one for the whole
    // sheet — `Sch-PL` bands at rows 4, 21, 32, 39, 45, 52 and 74, one per
    // 3.x note. So the sheet writes no title block of its own: the row list
    // holds the headings and the bands, and `firstRow` is simply where the
    // firm's own file starts (row 3 on Sch-PL, row 2 on Sch-BS and 3.1 PPE).
    return { bandRow: null, firstDataRow: sh.firstRow || 2, hasCompany: false, selfBanded: true };
  }
  // Statement sheets: rows 2-6 company/address/title/period/"Figures in
  // NPR", row 7 a short blank spacer, row 8 the "Restated" tag ONLY when a
  // column needs it (pushing the band to row 9), else the band is row 8.
  //
  // A blank spacer sits BETWEEN the band and the first data row — the firm's
  // workbooks draw it as a merged empty row (`SFP!B10:H10`), which is why the
  // first heading lands on row 11 rather than 10. Both reference files agree
  // on this (T3 Pvt.Ltd 2081.082 and the second reference file), so it is the
  // layout rather than one workbook's quirk; it was missed when this was
  // first written and every data row below it was one row high.
  const hasRestated = (sh.cols || []).some(c => c.restated);
  const bandRow = hasRestated ? 9 : 8;
  return { bandRow, firstDataRow: bandRow + 2, hasCompany: true };
}

// Label ~42 wide, the note column ~16, each value column ~22-23, a single
// narrow "margin" column at A, and a narrow spacer between every other pair
// of columns — the template's own proportions (§8 of the formatting spec),
// generalized across sheets whose value-column letters differ.
function fsxSetColumnWidths(ws, sh) {
  const geom = sh.geom;
  const labelCol = fsxColNum(geom.label);
  const noteCol = geom.note ? fsxColNum(geom.note) : null;
  const nCols = (sh.cols || []).length || 1;
  const valueCols = new Set();
  for (let i = 0; i < nCols; i++) {
    const letter = fsxSheetCol(geom, i, !!sh.matrix);
    if (letter) valueCols.add(fsxColNum(letter));
  }
  // The share-capital note borrows two columns the sheet otherwise uses as
  // narrow spacers; they carry figures, so they get figure widths.
  for (const q of (sh.quadCols || [])) valueCols.add(fsxColNum(q));
  let lastCol = labelCol;
  for (const c of valueCols) lastCol = Math.max(lastCol, c);
  if (noteCol) lastCol = Math.max(lastCol, noteCol);
  for (let c = 1; c <= lastCol; c++) {
    let w;
    if (c === labelCol) w = sh.key === 'COI' ? 52 : 42.1;
    else if (c === noteCol) w = 16;
    else if (valueCols.has(c)) {
      // The template's own widths: the comparative column is a shade wider
      // than the current-year one (23.7 / 25.1), which is what stops a header
      // like "32nd Ashadh 2083" wrapping to a third line.
      const idx = [...valueCols].sort((a, b) => a - b).indexOf(c);
      w = sh.matrix ? 16 : (idx === 0 ? 23.7 : 25.1);
    } else if (c === 1 && labelCol !== 1) w = 9.1;
    else w = 3;
    ws.getColumn(c).width = w;
  }
  return lastCol;
}

// Pass 1 fixes every sheet's row numbers before any formula is written, so a
// reference can never point at the wrong row. Pass 2 writes the cells and
// resolves formulas against that registry. Every formula ships with its cached
// result, so the workbook reads correctly before Excel recalculates.
function fsxWriteWorkbook(report, ExcelJSNs) {
  const wb = new ExcelJSNs.Workbook();
  wb.creator = 'Shailesh & Associates';

  const thin = { style: 'thin' };
  const double = { style: 'double' };
  const medium = { style: 'medium' };
  const font = (opts) => Object.assign({ name: FSX_FONT }, opts || {});

  // ── pass 1: row registry ──
  const reg = {};
  const layouts = {};
  for (const sh of report.sheets) {
    const layout = fsxLayout(sh);
    layouts[sh.key] = layout;
    const rows = {};
    let rn = layout.firstDataRow;
    for (const r of sh.rows) {
      if (r.k) rows[r.k] = rn;
      rn++;
    }
    reg[sh.key] = { sheet: sh.name, rows, geom: sh.geom, matrix: !!sh.matrix };
  }

  // Resolve a cross-sheet reference by row KEY and column index — never by a
  // literal column letter, because each sheet uses a different value column.
  const mkX = (colIdx) => (sheetKey, rowKey, forceIdx) => {
    const t = reg[sheetKey];
    if (!t) return null;
    const rowNo = t.rows[rowKey];
    if (!rowNo) return null;
    const idx = forceIdx != null ? forceIdx : colIdx;
    const letter = fsxSheetCol(t.geom, idx, t.matrix);
    if (!letter) return null;
    return `'${t.sheet}'!${letter}${rowNo}`;
  };

  for (const sh of report.sheets) {
    const ws = wb.addWorksheet(sh.name, { views: [{ showGridLines: false }] });
    ws.pageSetup = {
      orientation: 'portrait',
      margins: { left: 0.71, right: 0.71, top: 0.58, bottom: 0.58, header: 0.31, footer: 0.31 },
    };
    const geom = sh.geom;
    const nCols = (sh.cols || []).length || 1;
    const labelCol = fsxColNum(geom.label);
    const layout = layouts[sh.key];
    const lastCol = Math.max(fsxSetColumnWidths(ws, sh), labelCol);

    // ── title block ──
    if (!sh.noHeaderBand && !layout.selfBanded) {
      const put = (rowNo, col, text, opts, align) => {
        const cell = ws.getCell(rowNo, col);
        cell.value = text || '';
        cell.font = font(opts);
        cell.alignment = Object.assign({ horizontal: 'center', wrapText: true }, align || {});
      };
      const merge = (rowNo, toCol) => { if ((toCol || lastCol) > labelCol) ws.mergeCells(rowNo, labelCol, rowNo, toCol || lastCol); };

      if (layout.hasCompany) {
        put(2, labelCol, (report.meta.company || {}).name, { bold: true, size: 18 }); merge(2);
        put(3, labelCol, (report.meta.company || {}).address, { bold: true, size: 18 }); merge(3);
        put(4, labelCol, sh.title || '', { bold: true, size: 16 }); merge(4);
        put(5, labelCol, sh.subtitle || '', { bold: true, size: 14 }); merge(5);
        put(6, labelCol, 'Figures in NPR', { bold: true, size: 11 }, { horizontal: 'right' }); merge(6);
        // Title-block row heights, read off the template.
        ws.getRow(2).height = 23.4; ws.getRow(3).height = 23.4;
        ws.getRow(4).height = 20.4; ws.getRow(5).height = 18; ws.getRow(6).height = 13.35;
        ws.getRow(7).height = 4.5;
        if (layout.bandRow === 9) {
          const restCell = ws.getCell(8, fsxSheetCol(geom, 1, !!sh.matrix) ? fsxColNum(fsxSheetCol(geom, 1, !!sh.matrix)) : lastCol);
          restCell.value = 'Restated';
          restCell.font = font({ bold: true, italic: true, size: 11 });
          restCell.alignment = { horizontal: 'right', vertical: 'center' };
        }
      } else {
        // Schedule sheet: optional heading line, then title + "Figures in
        // NPR" sharing one row (title left, figures right — the template's
        // own Sch-BS layout), then a short spacer before the band.
        if (sh.heading) { put(1, labelCol, sh.heading, { bold: true, size: 16 }, { horizontal: 'left' }); }
        put(layout.titleRow, labelCol, sh.title || '', { bold: true, size: sh.heading ? 14 : 16 }, { horizontal: 'left' });
        const figCell = ws.getCell(layout.titleRow, lastCol);
        figCell.value = 'Figures in NPR';
        figCell.font = font({ bold: true, size: 11 });
        figCell.alignment = { horizontal: 'right' };
        ws.getRow(layout.titleRow + 1).height = 5;
      }

      // ── header band: bold, wrapped, medium bottom rule only, no fill ──
      const bandRow = layout.bandRow;
      const lc = ws.getCell(bandRow, labelCol);
      lc.value = 'Particulars';
      lc.font = font({ bold: true, size: 12 });
      lc.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
      lc.border = { bottom: medium };
      if (geom.note) {
        const nc = ws.getCell(bandRow, fsxColNum(geom.note));
        nc.value = 'Notes';
        nc.font = font({ bold: true, size: 12 });
        nc.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
        nc.border = { bottom: medium };
      }
      // A schedule's period headers REFERENCE the statement they support
      // (the template's =SFP!F9 / =SOI!F9) rather than re-printing the text,
      // so a change of year-end can never leave a schedule captioned with the
      // old period. §10 of the firm's formatting spec.
      const srcKey = FSX_HEADER_SOURCE[sh.key];
      const src = srcKey && reg[srcKey] && layouts[srcKey];
      (sh.cols || []).forEach((col, i) => {
        const cn = fsxColNum(fsxSheetCol(geom, i, !!sh.matrix));
        if (!cn) return;
        const cell = ws.getCell(bandRow, cn);
        const srcCol = src && fsxSheetCol(reg[srcKey].geom, i, reg[srcKey].matrix);
        const text = col.h2 ? `${col.h1}\n${col.h2}` : col.h1;
        cell.value = srcCol
          ? { formula: `'${reg[srcKey].sheet}'!${srcCol}${src.bandRow}`, result: text }
          : text;
        cell.font = font({ bold: true, size: 12 });
        cell.alignment = { horizontal: 'right', wrapText: true, vertical: 'bottom' };
        cell.border = { bottom: medium };
      });
      ws.getRow(bandRow).height = 36;
    }

    // ── pass 2: the rows ──
    const rowsMap = reg[sh.key].rows;
    let rn = layout.firstDataRow;
    for (const r of sh.rows) {
      const rowNo = rn++;
      if (r.kind === 'blank') { ws.getRow(rowNo).height = 6; continue; }

      // A note's own header band: "Particulars" plus the period captions,
      // medium rule underneath — the same furniture the statement sheets get
      // once, repeated per note on a schedule.
      if (r.kind === 'band') {
        const bc = ws.getCell(rowNo, labelCol);
        bc.value = r.label || 'Particulars';
        bc.font = font({ bold: true, size: 12 });
        bc.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
        bc.border = { bottom: medium };
        if (geom.note) {
          const nc2 = ws.getCell(rowNo, fsxColNum(geom.note));
          nc2.value = 'Notes';
          nc2.font = font({ bold: true, size: 12 });
          nc2.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
          nc2.border = { bottom: medium };
        }
        (sh.cols || []).forEach((col, i) => {
          const cn2 = fsxColNum(fsxSheetCol(geom, i, !!sh.matrix) || '');
          if (!cn2) return;
          const cell2 = ws.getCell(rowNo, cn2);
          cell2.value = col.h2 ? `${col.h1}\n${col.h2}` : col.h1;
          cell2.font = font({ bold: true, size: 12 });
          cell2.alignment = { horizontal: 'right', wrapText: true, vertical: 'bottom' };
          cell2.border = { bottom: medium };
        });
        ws.getRow(rowNo).height = r.tall === false ? 20 : 36;
        continue;
      }

      // ── the share-capital note's two-deep header and four-cell rows ──
      const qc = sh.quadCols;
      if (qc && (r.kind === 'quadhead' || r.kind === 'quadsub' || r.kind === 'quad' || r.kind === 'quadtot')) {
        const qn = qc.map(fsxColNum);
        if (r.kind === 'quadhead') {
          const hc = ws.getCell(rowNo, labelCol);
          hc.value = r.label || 'Type of Shares';
          hc.font = font({ bold: true, size: 12 });
          hc.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
          hc.border = { top: thin };
          [[0, 1, report.meta.asAtCy || ''], [2, 3, report.meta.asAtPy || '']].forEach(([a2, b2, txt]) => {
            const cell3 = ws.getCell(rowNo, qn[a2]);
            cell3.value = `As at 
${txt}`;
            cell3.font = font({ bold: true, size: 12 });
            cell3.alignment = { horizontal: 'center', wrapText: true };
            cell3.border = { top: thin };
            ws.mergeCells(rowNo, qn[a2], rowNo, qn[b2]);
          });
          ws.getRow(rowNo).height = 36;
          continue;
        }
        if (r.kind === 'quadsub') {
          ['Number', 'NPR', 'Number', 'NPR'].forEach((t, i2) => {
            const cell3 = ws.getCell(rowNo, qn[i2]);
            cell3.value = t;
            cell3.font = font({ size: 12 });
            cell3.alignment = { horizontal: 'center' };
            cell3.border = { bottom: medium };
          });
          ws.getRow(rowNo).height = 18;
          continue;
        }
        const ql = ws.getCell(rowNo, labelCol);
        ql.value = r.label || '';
        ql.font = font({ bold: r.kind === 'quadtot', size: 14 });
        (r.vals || []).forEach((v, i2) => {
          if (i2 >= qn.length) return;
          const cell3 = ws.getCell(rowNo, qn[i2]);
          cell3.value = fsxIsNum(v) ? v : null;
          cell3.numFmt = FSX_NUMFMT;
          cell3.alignment = { horizontal: 'right' };
          cell3.font = font({ bold: r.kind === 'quadtot', size: 14 });
          if (r.kind === 'quadtot') cell3.border = { top: thin, bottom: double };
        });
        ws.getRow(rowNo).height = 18;
        continue;
      }

      // A standalone "Figures in NPR" line — 3.1 PPE puts it on its own row
      // rather than beside the heading, because its heading is two lines.
      if (r.kind === 'fignpr') {
        const fc2 = ws.getCell(rowNo, labelCol);
        fc2.value = 'Figures in NPR';
        fc2.font = font({ bold: true, size: 11 });
        fc2.alignment = { horizontal: 'right' };
        if (lastCol > labelCol) ws.mergeCells(rowNo, labelCol, rowNo, lastCol);
        ws.getRow(rowNo).height = 13.35;
        continue;
      }

      ws.getRow(rowNo).height = 18;   // the template's data-row rhythm

      // A note heading carries "Figures in NPR" at the far right of its own
      // row, the way every 3.x note on Sch-BS and Sch-PL does.
      if (r.figNpr && lastCol > labelCol) {
        const fc = ws.getCell(rowNo, lastCol);
        fc.value = 'Figures in NPR';
        fc.font = font({ bold: true, size: 11 });
        fc.alignment = { horizontal: 'right' };
      }

      const lab = ws.getCell(rowNo, labelCol);
      lab.value = r.label || '';
      lab.alignment = { wrapText: false };
      if (r.kind === 'head' || r.kind === 'sub') lab.font = font({ bold: true, size: 14 });
      else if (r.kind === 'tot' || r.kind === 'grand') lab.font = font({ bold: true, size: 14 });
      else if (r.kind === 'note') {
        lab.font = font({ bold: true, size: 12 });
        if (lastCol > labelCol) ws.mergeCells(rowNo, labelCol, rowNo, lastCol);
      }
      else if (r.kind === 'kv') lab.font = font({ size: 10 });
      else lab.font = font({ size: 14 });

      if (r.note && geom.note) {
        const nc = ws.getCell(rowNo, fsxColNum(geom.note));
        nc.value = r.note;
        nc.alignment = { horizontal: 'center' };
        nc.font = font({ size: 14 });
      }

      (r.vals || []).forEach((v, i) => {
        const colLetter = fsxSheetCol(geom, i, !!sh.matrix);
        if (!colLetter) return;
        const cell = ws.getCell(rowNo, fsxColNum(colLetter));

        // A text cell (the COI key/value block) carries no accounting format.
        // Note null, undefined and '' all mean "no figure" and must NOT land
        // here — treating them as text is what silently turned every blank
        // current-year cell into an empty string with no rule and no formula.
        const blank = !fsxIsNum(v);
        if (blank && v !== null && v !== undefined && v !== '') {
          cell.value = String(v);
          cell.font = font({ size: 14 });
          cell.alignment = { horizontal: 'left' };
          return;
        }

        // A row total across a matrix sheet sums its own row rather than
        // fetching anything.
        let formula = null;
        const isRowTotalCell = r.rowTotal && i === (r.vals.length - 1);
        if (isRowTotalCell && sh.matrix) {
          const a = fsxSheetCol(geom, 0, true), b = fsxSheetCol(geom, r.vals.length - 2, true);
          if (a && b) formula = `SUM(${a}${rowNo}:${b}${rowNo})`;
        } else if (r.colSum) {
          const terms = r.colSum.filter(k => rowsMap[k]).map(k => `${colLetter}${rowsMap[k]}`);
          if (terms.length) formula = terms.join('+');
        } else if (r.xsum) {
          const terms = r.xsum.filter(k => rowsMap[k]).map(k => `${colLetter}${rowsMap[k]}`);
          if (terms.length) formula = terms.join('+');
        } else if (r.xf) {
          // `pyc` is the comparative column's letter on THIS sheet. A derived
          // line's formula reaches sideways into it (`=ROUND(F55*1.05,0)`),
          // which is how the firm's own workbook grows a line forward, so the
          // resolver has to hand it over rather than let callers guess a
          // letter that differs per sheet.
          const pyLetter = fsxSheetCol(geom, 1, !!sh.matrix);
          try { formula = r.xf({ R: rowsMap, c: colLetter, ci: i, X: mkX(i), rn: rowNo, pyc: pyLetter, Xc: mkX(0), Xp: mkX(1) }) || null; }
          catch (e) { formula = null; }
        }

        // The comparative column holds the prior year's REPORTED figures, which
        // need not foot from the lines a sheet breaks out. So it only carries a
        // formula where the sum was verified against the reported figure in
        // fsxBuildReport (r.pyFooted) — otherwise a SUM here would silently
        // restate a year the client has already signed. Cross-sheet mirrors are
        // single reported figures we cannot verify, so they stay literal.
        if (formula && i > 0 && !sh.matrix && !r.pyFooted) formula = null;

        // A DERIVED cell stays live even with nothing in it yet: the blank
        // shell is exactly the file the firm fills in, and a formula written
        // without a cached result is computed by Excel the moment it opens.
        // An INPUT cell stays genuinely empty — no formula, no zero, since
        // "not entered yet" is a different claim from "nil".
        if (blank) cell.value = formula ? { formula } : null;
        else cell.value = formula ? { formula, result: v } : v;

        cell.numFmt = FSX_NUMFMT;
        cell.alignment = { horizontal: 'right' };
        cell.font = font({ bold: r.kind === 'tot' || r.kind === 'grand', size: 14 });

        // Borders live on the value cell only — never the label/note cell, and
        // never on a plain item row: confirmed cell-by-cell against the
        // template, where every subtotal and total carries top-thin/
        // bottom-double. They are drawn whether or not there is a figure, so a
        // blank current-year column still reads as a ruled statement rather
        // than an empty page.
        if (r.kind === 'tot' || r.kind === 'grand') {
          cell.border = r.noTopRule ? { bottom: double } : { top: thin, bottom: double };
        }
      });

      if (r.balancing) {
        const cn = fsxColNum(fsxSheetCol(geom, 0, !!sh.matrix));
        if (cn) ws.getCell(rowNo, cn).note = 'Balancing figure';
      }
    }

    // ── the preview's ruled grid, drawn onto the sheet ──
    //
    // The on-screen preview draws a bordered table — outer box, a hairline
    // under every item row, vertical hairlines left of each value and note
    // column — and the user asked for the workbook to look the same
    // (2026-08-29), superseding the T3 template's borders-on-value-cells-only
    // styling this replaced. Everything here MERGES onto what the row loop
    // already drew: the band's medium underline and the thin+double total
    // rules stay exactly as they were, this pass only fills in the grid
    // around them.
    //
    // Same exceptions as the preview's CSS: the PPE sheet drops the vertical
    // lines (fsp-novlines — too many columns), and a schedule's note/fignpr
    // rows sit outside the grid.
    {
      const hair = { style: 'hair' };
      const boxThin = { style: 'thin' };
      const noteColN = geom.note ? fsxColNum(geom.note) : null;
      // The real (bordered) columns: label, note, every value column.
      const realCols = new Set([labelCol]);
      if (noteColN) realCols.add(noteColN);
      for (let i = 0; i < ((sh.cols || []).length || 1); i++) {
        const L = fsxSheetCol(geom, i, !!sh.matrix);
        if (L) realCols.add(fsxColNum(L));
      }
      for (const q of (sh.quadCols || [])) realCols.add(fsxColNum(q));
      // A self-banded schedule (Sch-BS/Sch-PL/PPE) has no single band row —
      // its notes carry their own — so its grid starts at the first data row.
      const firstRow = layout.bandRow || layout.firstDataRow;
      const lastRow = layout.firstDataRow + sh.rows.length - 1;
      const merge = (rowNo, colNo, add) => {
        const cell = ws.getCell(rowNo, colNo);
        cell.border = Object.assign({}, cell.border, add);
      };
      let rowNo = layout.firstDataRow;
      const kinds = {};
      for (const r of sh.rows) { kinds[rowNo] = r.kind || 'item'; rowNo++; }
      for (let rNo = firstRow; rNo <= lastRow; rNo++) {
        const k = kinds[rNo] || 'band';
        const outside = k === 'note' || k === 'fignpr';
        for (let c = labelCol; c <= lastCol; c++) {
          const add = {};
          // Vertical rules: left of every real column past the label, so the
          // rules run unbroken from the band to the foot — blank spacer rows
          // included, exactly as the preview draws them.
          if (!outside && sh.key !== 'PPE' && c > labelCol && realCols.has(c)) add.left = hair;
          // A hairline under every ordinary row; head/sub/blank rows and the
          // ruled kinds (band/tot/grand keep their own) stay as drawn.
          if (k === 'item') {
            const has = ws.getCell(rNo, c).border || {};
            if (!has.bottom) add.bottom = hair;
          }
          // The outer box.
          if (!outside) {
            if (c === labelCol) add.left = boxThin;
            if (c === lastCol) add.right = boxThin;
            if (rNo === firstRow) add.top = boxThin;
            if (rNo === lastRow) { const has = ws.getCell(rNo, c).border || {}; if (!has.bottom || has.bottom.style === 'hair') add.bottom = boxThin; }
          }
          if (Object.keys(add).length) merge(rNo, c, add);
        }
      }
    }

    // ── signature block (prompt §9: notes 12pt bold, signature/date 13pt regular) ──
    if (sh.sig) {
      const T = report.meta.terms || {};
      const sg = sh.sigRows;
      let sr = sg ? sg.line : rn + 3;
      const sigCols = [labelCol, geom.note ? fsxColNum(geom.note) : labelCol + 2, lastCol];
      const names = [T.person || 'Director', 'Accountant',
        report.meta.auditor && report.meta.auditor.name ? 'Registered Auditor' : ''];
      sigCols.forEach((c, i) => {
        if (!names[i]) return;
        ws.getCell(sr, c).value = '…………………………';
        ws.getCell(sr, c).font = font({ size: 13 });
        const roleRow = sg ? sg.role : sr + 2;
        ws.getCell(roleRow, c).value = names[i];
        ws.getCell(roleRow, c).font = font({ size: 13 });
      });
      if (report.meta.auditor && report.meta.auditor.name) {
        ws.getCell(sr + 3, lastCol).value = report.meta.auditor.name;
        ws.getCell(sr + 3, lastCol).font = font({ size: 13 });
      }
      const dateRow = sg ? sg.date : sr + 4;
      const placeRow = sg ? sg.place : sr + 5;
      ws.getCell(dateRow, labelCol).value = report.meta.dateBs ? ('Date: ' + report.meta.dateBs) : 'Date';
      ws.getCell(placeRow, labelCol).value = 'Place :' + (report.meta.place || 'Chitwan');
      ws.getCell(dateRow, labelCol).font = font({ size: 13 });
      ws.getCell(placeRow, labelCol).font = font({ size: 13 });
    }

    if (!sh.noHeaderBand) ws.views = [{ state: 'frozen', ySplit: layout.bandRow, showGridLines: false }];
  }

  return wb;
}

// Which spreadsheet column holds value #i on a given sheet. Two-year statements
// name their columns explicitly (cy/py); matrix sheets step across at a fixed
// stride from `first`.
function fsxSheetCol(geom, i, matrix) {
  if (!geom) return null;
  if (geom.cols) return geom.cols[i] || null;
  if (matrix || geom.first) {
    const start = fsxColNum(geom.first || 'D');
    return fsxColLetter(start + i * (geom.step || 2));
  }
  if (i === 0) return geom.cy || null;
  if (i === 1) return geom.py || null;
  return null;
}

// ════════════════════════════════════════════════════════════════
//  HTML — the preview iframe and the print/PDF document
// ════════════════════════════════════════════════════════════════
//
// The PDF is produced by printing this same document rather than being drawn
// separately in PDF-Lib. That is the app's established route for HTML-rendered
// statements (§9.2 — Audit Report and Notes to Accounts do the same): the
// browser handles pagination, repeating table headers and Devanagari, none of
// which a WinAnsi standard font can. It also guarantees what is previewed is
// exactly what prints, since both load the identical document.

// Same rules as the Excel sheet (see FSX_SCHEDULE_KEYS / the border notes
// above fsxWriteWorkbook): Book Antiqua, zero colour, borders on the value
// cell only and never on a plain item row, medium rule under the header
// band, no indent on item labels. The preview pane and the print/PDF
// document both load this exact stylesheet, so they can't drift from each
// other or from the Excel output.
// EVERY selector is scoped to .fsp-root. The in-app preview injects this
// stylesheet with innerHTML, which applies it to the WHOLE document — bare
// `body`/`table`/`td`/`thead th` rules here silently restyled every other
// module's tables the moment the Review step was opened. The wrapper is what
// keeps one stylesheet serving both the preview and the print document
// without leaking out of either.
// Monochrome cousin of Projection's PJX_PRINT_CSS (user ask 2026-08-21:
// "just like the projection report format, but no colours"): same centred
// header hierarchy, same bordered-table body, same foot-of-page signature
// band — every rule in black, white and hairline grey only.
const FSX_PRINT_CSS = `
  .fsp-root { font-family: 'Book Antiqua', 'Palatino Linotype', Georgia, 'Times New Roman', serif;
              color: #000; background: #fff; margin: 0; font-size: 11.5px;
              -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .fsp-root * { box-sizing: border-box; }
  .fsp-root .fsp-sheet { page-break-after: always; break-after: page; }
  .fsp-root .fsp-sheet:last-child { page-break-after: auto; break-after: auto; }
  /* The statement header must never sit alone at the foot of a page. */
  .fsp-root .fsp-head { text-align: center; margin-bottom: 8px; break-inside: avoid; page-break-inside: avoid; }
  .fsp-root .fsp-co { font-size: 14pt; font-weight: 700; letter-spacing: .2px; }
  .fsp-root .fsp-addr { font-size: 9.5pt; margin-top: 2px; }
  .fsp-root .fsp-title { font-size: 11pt; font-weight: 700; margin-top: 5px; }
  .fsp-root .fsp-sub { font-size: 9.5pt; font-weight: 700; margin-top: 2px; }
  .fsp-root .fsp-fig { text-align: right; font-size: 8pt; font-weight: 700; margin-top: 3px; }
  .fsp-root .fsp-restated { text-align: right; font-size: 9.5pt; font-weight: 700; font-style: italic; margin: 6px 0 0; }
  .fsp-root .fsp-heading { text-align: left; font-size: 13pt; font-weight: 700; margin-bottom: 4px; }
  .fsp-root .fsp-sched-row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 6px; }
  .fsp-root .fsp-sched-row .fsp-title-sched { font-size: 11pt; font-weight: 700; }
  .fsp-root .fsp-sched-row .fsp-fig { margin-top: 0; }
  .fsp-root table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 1px solid #000; }
  /* A schedule is a RUN of short 3.x notes, each rendered as its own table
     inside a keep-together block — a note either fits where it is or moves
     WHOLE to the next page, never half-and-half (user ask 2026-08-21). */
  .fsp-root .fsp-note-block { break-inside: avoid; page-break-inside: avoid; margin-bottom: 12px; }
  .fsp-root thead th { font-size: 1em; font-weight: 700; padding: 4px 6px; text-align: right;
                       vertical-align: bottom; border-bottom: 1.5px solid #000; }
  .fsp-root thead th.fsp-lab { text-align: left; vertical-align: middle; }
  .fsp-root thead th.fsp-note { text-align: center; vertical-align: middle; width: 40px; }
  .fsp-root .fsp-hdr-date { display: block; white-space: nowrap; font-weight: 400; font-size: .92em; }
  .fsp-root td { padding: 2.5px 6px; border-bottom: 1px solid #cfcfcf; vertical-align: baseline; }
  .fsp-root td.fsp-lab { text-align: left; word-break: normal; overflow-wrap: break-word; }
  .fsp-root td.fsp-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .fsp-root td.fsp-note { text-align: center; width: 40px; }
  /* The straight vertical rules between the year columns (user ask
     2026-08-21) — on every value and note cell, never the label. Blank
     spacer rows render per-column cells so the rules run unbroken from the
     band to the foot of the table. */
  .fsp-root th:not(.fsp-lab), .fsp-root td.fsp-num, .fsp-root td.fsp-note { border-left: 1px solid #c0c0c0; }
  .fsp-root tr.fsp-note-row td, .fsp-root tr.fsp-fignpr td { border-left: none; }
  /* Value-column widths are computed per sheet in fsxSheetHtml and emitted
     inline on the <col>s — a flat width here cannot know how many columns a
     matrix sheet carries, and 142px × SOCE's five columns is wider than an
     A4 page. Only the note column keeps a fixed width. */
  .fsp-root col.fsp-c-note { width: 40px; }
  /* Sheets whose budgeted column width runs narrow (SOCE's five columns, a
     PPE with many asset classes, the quad share-capital note) drop the font
     a step or two so figures never collide across the column rules. */
  .fsp-root table.fsp-mid { font-size: 11px; }
  .fsp-root table.fsp-tight { font-size: 10.5px; }
  .fsp-root table.fsp-mid td, .fsp-root table.fsp-tight td { padding-left: 5px; padding-right: 5px; }
  /* 3.1 PPE: no rules through the body — only the header band is boxed
     (its own top rule closes the box the outer border and band underline
     start). */
  .fsp-root table.fsp-novlines td { border-left: none; }
  .fsp-root table.fsp-novlines tr.fsp-band th { border-top: 1px solid #000; }
  /* A note's heading, caption and closing note print ABOVE and BELOW its
     box, never inside it. */
  .fsp-root .fsp-note-head { display: flex; justify-content: space-between; align-items: baseline;
                             font-weight: 700; margin: 0 0 3px; }
  .fsp-root .fsp-note-head .fsp-fig { margin: 0; }
  .fsp-root .fsp-note-caption { font-size: .9em; margin: 0 0 3px; }
  .fsp-root .fsp-note-sub { font-weight: 700; margin: 8px 0 3px; }
  .fsp-root .fsp-footnote { font-weight: 700; font-size: .85em; margin-top: 6px; }
  .fsp-root tr.fsp-head td, .fsp-root tr.fsp-sub td { font-weight: 700; padding-top: 8px; border-bottom: none; }
  .fsp-root tr.fsp-italic td { font-style: italic; }
  .fsp-root tr.fsp-head td.fsp-fignpr-cell { text-align: right; font-size: 9pt; vertical-align: bottom; }
  .fsp-root tr.fsp-tot td, .fsp-root tr.fsp-grand td { font-weight: 700; border-bottom: none; }
  .fsp-root tr.fsp-tot td.fsp-num { border-top: 1px solid #000; border-bottom: 3px double #000; }
  .fsp-root tr.fsp-grand td.fsp-num { border-top: 1px solid #000; border-bottom: 3px double #000; }
  .fsp-root tr.fsp-grand.fsp-notop td.fsp-num { border-top: none; }
  .fsp-root tr.fsp-tot.fsp-notop td.fsp-num { border-top: none; }
  .fsp-root tr.fsp-note-row td { font-weight: 700; font-size: .9em; padding-top: 8px; border-bottom: none; }
  .fsp-root tr.fsp-blank td { height: 6px; padding: 0; border-bottom: none; }
  /* A note's own band, repeated per 3.x note on a schedule. */
  .fsp-root tr.fsp-band th { font-size: 1em; font-weight: 700; padding: 6px 7px 4px;
                             text-align: right; vertical-align: bottom; border-bottom: 1.5px solid #000; }
  .fsp-root tr.fsp-band th.fsp-lab { text-align: left; vertical-align: middle; }
  .fsp-root tr.fsp-band th.fsp-note { text-align: center; }
  .fsp-root tr.fsp-quadhead th { border-bottom: none; border-top: 1px solid #000; text-align: center; }
  .fsp-root tr.fsp-quadsub th { text-align: center; font-weight: 400; }
  .fsp-root tr.fsp-fignpr td { text-align: right; font-size: 9pt; font-weight: 700; padding-top: 2px; border-bottom: none; }
  /* Keep a note's heading with the band and first rows beneath it, and never
     split a total off the lines it sums — the two ways a printed schedule
     comes out looking broken. */
  .fsp-root tr.fsp-head td, .fsp-root tr.fsp-sub td { break-after: avoid; page-break-after: avoid; }
  .fsp-root tr.fsp-band th { break-after: avoid; page-break-after: avoid; }
  .fsp-root tr.fsp-tot td, .fsp-root tr.fsp-grand td { break-before: avoid; page-break-before: avoid; }
  .fsp-root tr { break-inside: avoid; page-break-inside: avoid; }
  /* The signature band: pinned to the foot of the page by the flex sheet in
     the print document (margin-top:auto), directly under the table in the
     in-app preview, and never split from its Date/Place lines. */
  .fsp-root .fsp-sig { display: flex; justify-content: space-between; margin-top: auto;
                       padding-top: 8mm; font-size: 9.5pt;
                       break-inside: avoid; page-break-inside: avoid; }
  .fsp-root .fsp-sig-line { border-top: 1px dotted #000; width: 150px; margin-bottom: 5px; }
  .fsp-root .fsp-sig-r { text-align: right; }
  .fsp-root .fsp-sig-r .fsp-sig-line { margin-left: auto; }
  .fsp-root .fsp-sig-meta { margin-top: 3px; }
  @media print { .fsp-root .fsp-noprint { display: none !important; } }
`;

// Page chrome: only meaningful in the standalone print document, and
// deliberately kept out of FSX_PRINT_CSS so the preview cannot change how the
// app itself prints. On screen the print window shows white A4 "paper" cards
// on a grey ground, the Projection treatment; in print each statement sheet is
// a flex column with a page-height minimum, which is what pushes the signature
// band to the physical foot of its page instead of letting the date and place
// spill onto the next one. Schedule sheets stay block display — flex
// containers fragment poorly across pages, and a schedule legitimately runs
// past one page.
const FSX_PAGE_CSS = `
  @page { size: A4 portrait; margin: 12mm; }
  body { margin: 0; background: #eef1f5; }
  .fsp-root { background: transparent; }
  .fsp-root .fsp-sheet { background: #fff; width: 210mm; min-height: 297mm; margin: 0 auto 18px;
                         padding: 14mm 12mm; box-shadow: 0 2px 14px rgba(15,23,42,.18);
                         display: flex; flex-direction: column; }
  .fsp-root .fsp-sheet.fsp-sched { display: block; min-height: 0; }
  @media print {
    body { background: #fff; }
    .fsp-root .fsp-sheet { width: auto; min-height: 262mm; margin: 0; padding: 0; box-shadow: none; }
    .fsp-root .fsp-sheet.fsp-sched { min-height: 0; }
  }`;

function fsxEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One sheet as an HTML table. Used by the preview pane and the print document.
function fsxSheetHtml(sh, meta) {
  const nCols = (sh.cols || []).length || 1;
  // A matrix sheet never carries row notes (SOCE's geom.note is Excel column
  // geometry, not a promise of a Notes column), and on the print page it is
  // the sheet that can least afford the 46px — so the HTML path drops it.
  const hasNote = !!(sh.geom && sh.geom.note) && !sh.matrix;
  // 3.6 Share Capital splits each year into Number and NPR. When a sheet
  // carries those rows the whole table is widened to label + 4, and every
  // ordinary value cell spans the pair it sits above — otherwise the quad rows
  // run past the end of the table and the columns stop lining up.
  const hasQuad = (sh.rows || []).some(r => r.kind && r.kind.indexOf('quad') === 0);
  const unit = hasQuad ? 2 : 1;
  const valueCells = hasQuad ? 4 : nCols;
  // A self-banded schedule heads each of its own notes ("3.2 Investment",
  // each with its own band), so a sheet-wide "Particulars" header above them
  // would put furniture on the page that the Excel does not have — the Excel
  // writer skips the sheet band for exactly these sheets (layout.selfBanded).
  const selfBanded = !!(FSX_SCHEDULE_KEYS[sh.key] && sh.firstRow);
  const out = [];
  // data-matrix lets the print window's fit pass know this sheet's columns
  // are already at their width budget — it may shrink such a sheet to fit
  // but must never scale it up into its own column rules.
  out.push(`<div class="fsp-sheet${FSX_SCHEDULE_KEYS[sh.key] ? ' fsp-sched' : ''}"${sh.matrix || hasQuad ? ' data-matrix="1"' : ''}>`);
  if (!sh.noHeaderBand) {
    if (!FSX_SCHEDULE_KEYS[sh.key]) {
      // Statement sheets carry the company header; schedule sheets never
      // repeat it — confirmed against the template, whose Sch-BS starts
      // straight at "3.2 Investment" with nothing above it. The block is one
      // keep-together unit so a page break can never strand it.
      out.push('<div class="fsp-head">');
      out.push(`<div class="fsp-co">${fsxEsc((meta.company || {}).name)}</div>`);
      out.push(`<div class="fsp-addr">${fsxEsc((meta.company || {}).address)}</div>`);
      out.push(`<div class="fsp-title">${fsxEsc(sh.title || '')}</div>`);
      if (sh.subtitle) out.push(`<div class="fsp-sub">${fsxEsc(sh.subtitle)}</div>`);
      out.push('<div class="fsp-fig">Figures in NPR</div>');
      if ((sh.cols || []).some(c => c.restated)) out.push('<div class="fsp-restated">Restated</div>');
      out.push('</div>');
    } else if (!sh.firstRow) {
      if (sh.heading) out.push(`<div class="fsp-heading">${fsxEsc(sh.heading)}</div>`);
      out.push(`<div class="fsp-sched-row"><span class="fsp-title-sched">${fsxEsc(sh.title || '')}</span><span class="fsp-fig">Figures in NPR</span></div>`);
      if ((sh.cols || []).some(c => c.restated)) out.push('<div class="fsp-restated">Restated</div>');
    }
  }

  // Fixed layout + an explicit colgroup: without it the value columns get
  // squeezed and a header like "32nd Ashadh 2083" wraps onto a third line
  // while its sibling wraps onto two. But the width cannot be a flat 142px:
  // the print page is A4 with 12mm side margins (~703 CSS px) and under
  // `table-layout: fixed` the unclassed label <col> gets only what the fixed
  // columns leave over — SOCE's five columns at 142px overran the page and
  // the label column collapsed to zero, printing one letter per line. So the
  // width is budgeted: never wider than 142px, never so wide the label drops
  // under its floor. A quad sheet's half-columns are half a pair's width, so
  // the budget is computed per header-level column, then split.
  const A4_CONTENT = 700;
  const LABEL_MIN = 170;
  // A quad sheet's four half-columns each carry a full "1,00,00,000.00", so
  // 71px halves collided across the rules — they get the width the label can
  // spare (a 240px label floor) rather than half of the ordinary 142px pair.
  const colW = hasQuad
    ? Math.floor((A4_CONTENT - (hasNote ? 40 : 0) - 240) / 4)
    : Math.min(142, Math.floor((A4_CONTENT - (hasNote ? 40 : 0) - LABEL_MIN) / valueCells));
  // A noted statement (SFP/SOI) fixes every column and lets the table hug
  // its content instead of stretching to the page width — the note number
  // sits right beside the account head and the year columns carry no dead
  // space (user ask 2026-08-21, fourth round: "consume less of the page").
  const labelW = hasNote && !FSX_SCHEDULE_KEYS[sh.key] ? 270 : 0;
  const fixedColW = 150;
  const tblCls = [colW < 100 ? 'fsp-tight' : colW < 125 ? 'fsp-mid' : '', sh.key === 'PPE' ? 'fsp-novlines' : '']
    .filter(Boolean).join(' ');
  const sizeCls = tblCls ? ` class="${tblCls}"` : '';
  const span = 1 + (hasNote ? 1 : 0) + valueCells;

  const rowHtml = (r) => {
    const o = [];
    // Blank spacers render one cell per column, not one wide colspan — the
    // vertical year rules must run unbroken through them.
    if (r.kind === 'blank') {
      return `<tr class="fsp-blank"><td class="fsp-lab"></td>${hasNote ? '<td class="fsp-note"></td>' : ''}`
        + Array.from({ length: valueCells }, () => '<td class="fsp-num"></td>').join('') + '</tr>';
    }
    if (r.kind === 'note') {
      return r.label ? `<tr class="fsp-note-row"><td colspan="${span}">${fsxEsc(r.label)}</td></tr>` : '';
    }
    // A note's own header band — schedules repeat it under every 3.x heading.
    if (r.kind === 'band') {
      o.push('<tr class="fsp-band">');
      o.push(`<th class="fsp-lab">${fsxEsc(r.label || 'Particulars')}</th>`);
      if (hasNote) o.push('<th class="fsp-note">Notes</th>');
      for (const c of (sh.cols || [])) {
        o.push(`<th colspan="${unit}">${fsxEsc(c.h1)}${c.h2 ? `<span class="fsp-hdr-date">${fsxEsc(c.h2)}</span>` : ''}</th>`);
      }
      o.push('</tr>');
      return o.join('');
    }
    // A standalone "Figures in NPR" line (3.1 PPE puts it on its own row).
    if (r.kind === 'fignpr') return `<tr class="fsp-fignpr"><td colspan="${span}">Figures in NPR</td></tr>`;
    // The share-capital note splits each year into Number and NPR, so its rows
    // carry four values across a table sized for two. They are rendered with
    // their own colspans rather than dropped.
    if (r.kind === 'quadhead' || r.kind === 'quadsub' || r.kind === 'quad' || r.kind === 'quadtot') {
      if (r.kind === 'quadhead') {
        o.push('<tr class="fsp-band fsp-quadhead">');
        o.push(`<th class="fsp-lab">${fsxEsc(r.label || 'Type of Shares')}</th>`);
        if (hasNote) o.push('<th class="fsp-note"></th>');
        o.push(`<th colspan="2">As at<span class="fsp-hdr-date">${fsxEsc(meta.asAtCy || '')}</span></th>`);
        o.push(`<th colspan="2">As at<span class="fsp-hdr-date">${fsxEsc(meta.asAtPy || '')}</span></th>`);
        o.push('</tr>');
        return o.join('');
      }
      if (r.kind === 'quadsub') {
        o.push('<tr class="fsp-band fsp-quadsub"><th class="fsp-lab"></th>');
        if (hasNote) o.push('<th class="fsp-note"></th>');
        ['Number', 'NPR', 'Number', 'NPR'].forEach(t => o.push(`<th>${t}</th>`));
        o.push('</tr>');
        return o.join('');
      }
      o.push(`<tr class="${r.kind === 'quadtot' ? 'fsp-tot' : 'fsp-item'}">`);
      o.push(`<td class="fsp-lab">${fsxEsc(r.label || '')}</td>`);
      if (hasNote) o.push('<td class="fsp-note"></td>');
      [0, 1, 2, 3].forEach(i => {
        const v = (r.vals || [])[i];
        o.push(`<td class="fsp-num">${fsxEsc(fsxIsNum(v) ? fsxAmt(v) : '')}</td>`);
      });
      o.push('</tr>');
      return o.join('');
    }

    const cls = 'fsp-' + (r.kind === 'kv' ? 'kv' : r.kind) + (r.noTopRule ? ' fsp-notop' : '') + (r.italic ? ' fsp-italic' : '');
    o.push(`<tr class="${cls}">`);
    o.push(`<td class="fsp-lab">${fsxEsc(r.label)}</td>`);
    if (hasNote) o.push(`<td class="fsp-note">${fsxEsc(r.note || '')}</td>`);
    for (let i = 0; i < nCols; i++) {
      const v = (r.vals || [])[i];
      if (r.kind === 'head' || r.kind === 'sub') {
        // A note heading carries "Figures in NPR" at the far right of its own
        // row, the way the Excel writes every 3.x head on Sch-BS and Sch-PL.
        o.push(r.figNpr && i === nCols - 1
          ? `<td class="fsp-num fsp-fignpr-cell" colspan="${unit}">Figures in NPR</td>`
          : `<td class="fsp-num" colspan="${unit}"></td>`);
        continue;
      }
      o.push(`<td class="fsp-num" colspan="${unit}">${fsxEsc(fsxIsNum(v) ? fsxAmt(v) : (v == null ? '' : v))}</td>`);
    }
    o.push('</tr>');
    return o.join('');
  };

  const tableHtml = (rows, withThead) => {
    // Fully-fixed statements get an explicit table width (the sum of their
    // columns), centred — width:100% would hand the slack back to a column
    // and reopen the gap this exists to close.
    const tw = labelW ? ` style="width:${labelW + (hasNote ? 40 : 0) + valueCells * fixedColW}px; margin:0 auto;"` : '';
    const t = [`<table${sizeCls}${tw}>`, `<colgroup>${labelW ? `<col style="width:${labelW}px">` : '<col>'}`];
    if (hasNote) t.push('<col class="fsp-c-note">');
    for (let i = 0; i < valueCells; i++) t.push(`<col style="width:${labelW ? fixedColW : colW}px">`);
    t.push('</colgroup>');
    if (withThead) {
      t.push('<thead><tr>');
      t.push('<th class="fsp-lab">Particulars</th>');
      if (hasNote) t.push('<th class="fsp-note">Notes</th>');
      for (const c of (sh.cols || [])) {
        t.push(`<th colspan="${unit}">${fsxEsc(c.h1)}${c.h2 ? `<span class="fsp-hdr-date">${fsxEsc(c.h2)}</span>` : ''}</th>`);
      }
      t.push('</tr></thead>');
    }
    t.push('<tbody>', rows.map(rowHtml).join(''), '</tbody></table>');
    return t.join('');
  };

  const trimBlanks = (rows) => {
    let a = 0, b = rows.length;
    while (a < b && rows[a].kind === 'blank') a++;
    while (b > a && rows[b - 1].kind === 'blank') b--;
    return rows.slice(a, b);
  };

  // A note's heading rows ('3.2 Investment', a caption, 'Figures in NPR')
  // print ABOVE its box, and its closing note lines print BELOW it — putting
  // them inside the bordered table drew the box (and the year rules) around
  // text that is not columnar (user feedback 2026-08-21).
  const shiftHeadings = (rows) => {
    const parts = [];
    while (rows.length && ['head', 'sub', 'fignpr', 'note', 'blank'].indexOf(rows[0].kind) >= 0) {
      if (rows[0].kind === 'sub') {
        // A sub that heads a quad section ("Authorised Share Capital:") is
        // the section splitter's to render, so all three sections match.
        const nxt = rows.slice(1).find(x => x.kind !== 'blank');
        if (nxt && nxt.kind === 'quadhead') break;
      }
      const r = rows.shift();
      if (r.kind === 'head' || r.kind === 'sub') {
        parts.push(`<div class="fsp-note-head"><span>${fsxEsc(r.label)}</span>${r.figNpr ? '<span class="fsp-fig">Figures in NPR</span>' : ''}</div>`);
      } else if (r.kind === 'fignpr') {
        parts.push('<div class="fsp-fig">Figures in NPR</div>');
      } else if (r.kind === 'note' && r.label) {
        parts.push(`<div class="fsp-note-caption">${fsxEsc(r.label)}</div>`);
      }
    }
    return parts;
  };
  const popFootnotes = (rows) => {
    const foot = [];
    while (rows.length && (rows[rows.length - 1].kind === 'note' || rows[rows.length - 1].kind === 'blank')) {
      const r = rows.pop();
      if (r.kind === 'note' && r.label) foot.unshift(`<div class="fsp-footnote">${fsxEsc(r.label)}</div>`);
    }
    return foot;
  };

  if (selfBanded && !sh.matrix) {
    // Sch-BS / Sch-PL: one table per 3.x note, each in a keep-together block,
    // split at the note's own 'head' row. A note that would straddle a page
    // boundary moves whole to the next page instead. No sheet-level thead —
    // the Excel these sheets mirror has none.
    const chunks = [];
    let cur = [];
    for (const r of sh.rows) {
      if (r.kind === 'head' && cur.some(x => x.kind !== 'blank')) { chunks.push(cur); cur = []; }
      cur.push(r);
    }
    if (cur.length) chunks.push(cur);
    for (const chunk of chunks) {
      let rows = trimBlanks(chunk);
      if (!rows.length) continue;
      const block = [`<div class="fsp-note-block">`, ...shiftHeadings(rows)];
      const foot = popFootnotes(rows);
      // 3.6 Capital Account: each share-capital section (a 'sub' heading
      // followed by the quad band) becomes its own sub-heading + box, so
      // "Authorised Share Capital:" is a heading between boxes, not a row
      // trapped inside one.
      const seg = [];
      const flushSeg = () => {
        const body = trimBlanks(seg.splice(0));
        if (body.length) block.push(tableHtml(body, false));
      };
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const nxt = rows.slice(i + 1).find(x => x.kind !== 'blank');
        if (r.kind === 'sub' && nxt && nxt.kind === 'quadhead') {
          flushSeg();
          block.push(`<div class="fsp-note-sub">${fsxEsc(r.label)}</div>`);
          continue;
        }
        seg.push(r);
      }
      flushSeg();
      block.push(...foot, '</div>');
      out.push(block.join(''));
    }
  } else if (selfBanded) {
    // 3.1 PPE: headings above, then one matrix table kept whole — it either
    // fits the page it is on or starts fresh on the next.
    const rows = trimBlanks(sh.rows.slice());
    const heads = shiftHeadings(rows);
    const foot = popFootnotes(rows);
    out.push(`<div class="fsp-note-block">${heads.join('')}${tableHtml(trimBlanks(rows), false)}${foot.join('')}</div>`);
  } else {
    // Statements: the closing note lines ("The notes are an integral part…")
    // sit under the table, outside the box — so the outer border and the
    // year rules stop exactly at the last total row. A hugging table takes
    // its footnotes into its centred wrapper so they stay flush with it.
    const rows = sh.rows.slice();
    const foot = popFootnotes(rows);
    const totalW = labelW ? labelW + (hasNote ? 40 : 0) + valueCells * fixedColW : 0;
    if (totalW) {
      out.push(`<div style="width:${totalW}px; margin:0 auto;">${tableHtml(rows, !sh.noHeaderBand)}${foot.join('')}</div>`);
    } else {
      out.push(tableHtml(rows, !sh.noHeaderBand));
      out.push(...foot);
    }
  }

  if (sh.sig) {
    const T = meta.terms || {};
    const showAuditor = !!(meta.auditor && meta.auditor.name);
    out.push('<div class="fsp-sig">');
    out.push(`<div><div class="fsp-sig-line"></div><div>${fsxEsc(T.person || 'Director')}</div>`
      + `<div class="fsp-sig-meta">Date : ${fsxEsc(meta.dateBs || '')}</div>`
      + `<div class="fsp-sig-meta">Place : ${fsxEsc(meta.place || 'Chitwan')}</div></div>`);
    out.push('<div><div class="fsp-sig-line"></div><div>Accountant</div></div>');
    if (showAuditor) {
      out.push('<div class="fsp-sig-r"><div class="fsp-sig-line"></div><div>Registered Auditor</div>'
        + `<div class="fsp-sig-meta">${fsxEsc(meta.auditor.name)}</div></div>`);
    }
    out.push('</div>');
  }
  out.push('</div>');
  return out.join('');
}

// The page-fit pass, run inside the standalone print window (the same idea as
// DocumentEngine.fitPagesToSheet, standalone because this document loads no
// app code): each STATEMENT sheet is measured against the printable A4 height
// and its real font sizes are scaled — down when the statement would spill its
// signature onto the next page, up when it would leave half the page empty —
// so every statement fills exactly one page (user ask 2026-08-21). Schedule
// sheets are excluded (they legitimately flow over pages, note by note), and
// a matrix/quad sheet may shrink but never grows into its own column rules.
// Scaling sets computed font sizes element by element, never CSS zoom or
// transform — both of those break printing (the fitPagesToSheet rule).
const FSX_FIT_JS = `<script>
(function () {
  function mmToPx(mm) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;visibility:hidden;height:' + mm + 'mm;width:1mm;';
    document.body.appendChild(d);
    var h = d.getBoundingClientRect().height;
    d.remove();
    return h;
  }
  function contentHeight(s) {
    var oldMin = s.style.minHeight;
    s.style.minHeight = '0';
    var cs = getComputedStyle(s);
    var h = s.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    s.style.minHeight = oldMin;
    return h;
  }
  function applyScale(s, k) {
    var els = [s].concat([].slice.call(s.querySelectorAll('*')));
    var sizes = els.map(function (el) { return parseFloat(getComputedStyle(el).fontSize) || 0; });
    els.forEach(function (el, i) { if (sizes[i]) el.style.fontSize = (sizes[i] * k).toFixed(2) + 'px'; });
  }
  function fit() {
    var target = mmToPx(268); // A4 inside 12mm margins, less a safety band
    var sheets = document.querySelectorAll('.fsp-root .fsp-sheet:not(.fsp-sched)');
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      var h = contentHeight(s);
      if (!h) continue;
      // Never scale UP — the compact natural size is the look (fourth-round
      // user ask); the pass now only shrinks a statement that would spill.
      var maxUp = 1;
      var k = Math.max(0.72, Math.min(maxUp, target / h));
      if (Math.abs(k - 1) > 0.02) applyScale(s, k);
      var h2 = contentHeight(s);
      if (h2 > target) applyScale(s, Math.max(0.72, target / h2));
    }
  }
  window.addEventListener('load', fit);
})();
<\/script>`;

// The full statement set as a standalone document.
function fsxReportHtmlDoc(report, opts) {
  const o = opts || {};
  const body = report.sheets.map(sh => fsxSheetHtml(sh, report.meta)).join('\n');
  const auto = o.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},350);});<\/script>'
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${fsxEsc(((report.meta.company || {}).name || 'Financial Statement') + ' — ' + (report.meta.fy || ''))}</title>
<style>${FSX_PAGE_CSS}${FSX_PRINT_CSS}</style></head><body><div class="fsp-root">${body}</div>${FSX_FIT_JS}${auto}</body></html>`;
}

// The preview pane renders the SAME markup and the SAME stylesheet as the
// print document — one call site for both, so they cannot drift.
function fsxPreviewHtml(sheetOrSheets, meta) {
  const list = Array.isArray(sheetOrSheets) ? sheetOrSheets : [sheetOrSheets];
  return `<style>${FSX_PRINT_CSS}</style><div class="fsp-root">`
    + list.map(sh => fsxSheetHtml(sh, meta)).join('\n') + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fsxBuildReport, fsxWriteWorkbook, fsxSheetCol, fsxAmt, fsxPdfSafe,
    fsxSheetHtml, fsxReportHtmlDoc, fsxPreviewHtml, FSX_PRINT_CSS, FSX_PAGE_CSS,
    FSX_GEOM, FSX_NUMFMT, FSX_NUMFMT0, fsxColNum, fsxColLetter,
  };
}
