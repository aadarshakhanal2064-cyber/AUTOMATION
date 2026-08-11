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

// The firm's own accounting format (lifted from the T3 template): negatives
// carry a leading minus, never parentheses; zero renders as an en-dash.
const FSX_NUMFMT = '_ * #,##0.00_ ;_ * -#,##0.00_ ;_ * "-"??_ ;_ @_ ';
const FSX_NUMFMT0 = '_ * #,##0_ ;_ * -#,##0_ ;_ * "-"??_ ;_ @_ ';

// Column geometry per sheet, taken from the template. `cy`/`py` are the current
// and comparative value columns; `cols` is used by the matrix sheets (SOCE,
// 3.1 PPE) whose columns are categories rather than years.
const FSX_GEOM = {
  COI:   { label: 'A', cy: 'F' },
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
  const R = (label, vals, kind, extra) => Object.assign({ label, vals: vals || [], kind: kind || 'item' }, extra || {});
  const B = () => ({ label: '', vals: [], kind: 'blank' });

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
  const coi = out.coi || {};
  sheets.push({
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
      R('Add: Depreciation as per Accounting Standard', [coi.depSlm], 'item', { k: 'depSlm' }),
      R('Less: Depreciation as per Income tax Act,2058', [-Math.abs(coi.depIncomeTax || 0)], 'item', { k: 'depIt' }),
      R('Total Taxable income', [coi.taxableProfit], 'tot', { k: 'taxable', xsum: ['pbt', 'depSlm', 'depIt'] }),
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
    cols: [{ h1: 'As at', h2: cyHead }, { h1: 'As at', h2: pyHead, restated: true }],
    rows: [
      R('A. Assets:', [], 'head'),
      R('I. Non-Current Assets', [], 'sub'),
      R('Property, Plant and Equipment', [bal.ppe, pySfp.ppe], 'item', { note: '3.1', k: 'ppe', xf: ({ X }) => X('PPE', 'carryClose', ppeTotalIdx) }),
      R('Investments', [bal.investmentsNC, pySfp.investmentsNC], 'item', { note: '3.2', k: 'invNC' }),
      R('Other Receivables', [bal.otherReceivablesNC, pySfp.otherReceivablesNC], 'item', { note: '3.3', k: 'othRecNC' }),
      R('Total Non-Current Assets', [bal.totalNCA, pySfp.totalNCA], 'tot', { k: 'totalNCA', xsum: ['ppe', 'invNC', 'othRecNC'] }),
      B(),
      R('II. Current Assets', [], 'sub'),
      R('Investments', [bal.investmentsC, pySfp.investmentsC], 'item', { note: '3.2', k: 'invC' }),
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
      R('Reserves', [bal.reserves, pySfp.reserves], 'item', { note: '3.7', k: 'reserves' }),
      R('Total Equity', [bal.totalEquity, pySfp.totalEquity], 'tot', { k: 'totalEquity', xsum: ['capital', 'reserves'] }),
      B(),
      R('II. Non-Current Liabilities', [], 'sub'),
      R('Loans and Borrowings', [bal.loansNonCurrent, pySfp.loansNC], 'item', { note: '3.8', k: 'loanNC', xf: ({ X }) => X('SchBS', 'loanNCTotal') }),
      R('Provisions', [bal.provisionsNC, pySfp.provisionsNC], 'item', { note: '3.10', k: 'provNC' }),
      R('Total Non-Current Liabilities', [bal.totalNCL, (pySfp.loansNC || 0) + (pySfp.provisionsNC || 0)], 'tot', { k: 'totalNCL', xsum: ['loanNC', 'provNC'] }),
      B(),
      R('III. Current Liabilities', [], 'sub'),
      R('Loans and Borrowings', [bal.loansCurrent, pySfp.loansC], 'item', { note: '3.8', k: 'loanC', xf: ({ X }) => X('SchBS', 'loanCTotal') }),
      R('Trade & Other Payables', [bal.totalPayables, pySfp.payables], 'item', { note: '3.9', k: 'pay', xf: ({ X }) => X('SchBS', 'payTotal') }),
      R('Provisions', [bal.provisionsC, pySfp.provisionsC], 'item', { note: '3.10', k: 'provC', xf: ({ X }) => X('SchBS', 'provCurrent') }),
      R('Total Current Liabilities', [bal.totalCL, pySfp.totalCL], 'tot', { k: 'totalCL', xsum: ['loanC', 'pay', 'provC'] }),
      B(),
      R('Total Liabilities', [bal.totalLiabilities, (pySfp.totalCL || 0) + (pySfp.loansNC || 0) + (pySfp.provisionsNC || 0)], 'tot', { k: 'totalLiab', xsum: ['totalNCL', 'totalCL'] }),
      R('Total Equity and Liabilities', [bal.totalEquityLiab, pySfp.totalAssets], 'grand', { k: 'totalEL', xsum: ['totalLiab', 'totalEquity'] }),
      B(),
      R('The notes are an integral part of these financial statements.', [], 'note'),
      R('This is the statement of position referred to in our report of even date.', [], 'note'),
    ],
  });

  // ── SOI: Statement of Income ──
  const mat = inc.materials || {};
  sheets.push({
    key: 'SOI', name: 'SOI', geom: FSX_GEOM.SOI,
    title: m.titles && m.titles.soi, subtitle: m.forYearLine, sig: true,
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
      R('a) Materials/Services Consumed Expenses', [mat.total, pySoi.materials], 'item', { note: '3.12', k: 'materials', xf: ({ X }) => X('SchPL', 'matTotal') }),
      R('b) Employee Benefit Expenses', [inc.employeeTotal, pySoi.employee], 'item', { note: '3.13', k: 'employee', xf: ({ X }) => X('SchPL', 'empTotal') }),
      R('c) Finance Cost', [inc.financeTotal, pySoi.financeCost], 'item', { note: '3.14', k: 'finance', xf: ({ X }) => X('SchPL', 'finTotal') }),
      R('d) Depreciation Expenses', [inc.depreciation, pySoi.depreciation], 'item', { note: '3.1', k: 'dep', xf: ({ X }) => X('PPE', 'depCharge', ppeTotalIdx) }),
      R('e) Other Expenses', [inc.otherTotal, pySoi.otherExpenses], 'item', { note: '3.15', k: 'other', xf: ({ X }) => X('SchPL', 'othTotal') }),
      R('Total Expenses', [inc.totalExpenses, pySoi.totalExpenses], 'tot', { k: 'totalExpenses', xsum: ['materials', 'employee', 'finance', 'dep', 'other'] }),
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
      B(),
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
    cols: [{ h1: T.capital }, { h1: 'Share Premium' }, { h1: 'Retained Earnings' }, { h1: 'Other Reserves' }, { h1: 'Total' }],
    rows: [
      R(m.socOpenLabel || 'Balance at beginning of the year', [...openArr, sum4(openArr)], 'item', { k: 'open', rowTotal: true }),
      R('Profit for the Year', [...rowProfit, sum4(rowProfit)], 'item', { k: 'profit', rowTotal: true }),
      R('Capital Introduced During the year', [...rowCapital, sum4(rowCapital)], 'item', { k: 'capital', rowTotal: true }),
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
  sheets.push({
    key: 'SOCF', name: 'SOCF', geom: FSX_GEOM.SOCF,
    title: m.titles && m.titles.socf, subtitle: m.forYearLine, sig: true,
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
      R('Increase/Decrease in Trade & Other Receivables', [op.dRecv, pc2.dRecv], 'item', { k: 'cfRecv' }),
      R('Increase/Decrease in Inventories', [op.dStock, pc2.dStock], 'item', { k: 'cfStock' }),
      R('Increase/Decrease in Trade & Other Payables', [op.dPay, pc2.dPay], 'item', { k: 'cfPay' }),
      R('Cash Generated From Operations.', [cf.generated, pc2.generated], 'tot', {
        k: 'cfGen',
        xf: ({ R: r, c }) => (r.cfProfit && r.cfPay)
          ? `${c}${r.cfProfit}+${c}${r.cfDep}-${c}${r.cfIntInc}+${c}${r.cfFin}+SUM(${c}${r.cfPpeLoss}:${c}${r.cfPay})` : null,
      }),
      R('Interest Paid', [cf.interestPaid, pc2.interestPaid], 'item', { k: 'cfIntPaid', xf: ({ R: r, c }) => r.cfFin ? `${c}${r.cfFin}` : null }),
      R('Income Tax Paid', [cf.taxPaid, pc2.taxPaid], 'item', { k: 'cfTaxPaid' }),
      R('Net Cash Flows from Operating Activities', [cf.netOperating, pc2.netOperating], 'tot', {
        k: 'cfOper', xf: ({ R: r, c }) => `${c}${r.cfGen}-${c}${r.cfIntPaid}-${c}${r.cfTaxPaid}`,
      }),
      R('Cash Flow from Investing Activities :', [], 'head'),
      R('Acquisition of Property, Plant and Equipment', [iv.ppeAcquired, pc2.ppeAcquired], 'item', { k: 'cfPpeAcq', xf: ({ X }) => { const x = X('PPE', 'additions', ppeTotalIdx); return x ? `-${x}` : null; } }),
      R('Investments', [iv.investments, pc2.investments], 'item', { k: 'cfInv' }),
      R('Interest/Dividend Received', [iv.interestReceived, pc2.interestReceived], 'item', { k: 'cfIntRec', xf: ({ R: r, c }) => r.cfIntInc ? `${c}${r.cfIntInc}` : null }),
      R('Proceeds from Sale of PPE, Investments/Financial Assets', [iv.ppeProceeds, pc2.ppeProceeds], 'item', { k: 'cfPpeSale' }),
      R('Net Cash Flows from Investing Activities', [cf.netInvesting, pc2.netInvesting], 'tot', {
        k: 'cfInvest', xf: ({ R: r, c }) => `SUM(${c}${r.cfPpeAcq}:${c}${r.cfPpeSale})`,
      }),
      R('Cash Flows from Financing Activities :', [], 'head'),
      R('Proceeds from Capital introduced during the year', [fi.capital, pc2.capital], 'item', { k: 'cfCap' }),
      R('Proceeds/ (Repayment) from Non-Current Borrowings', [fi.nonCurrentBorrowings, pc2.nonCurrentBorrowings], 'item', { k: 'cfNCB' }),
      R('Proceeds/ (Repayment) from Current Borrowings', [fi.currentBorrowings, pc2.currentBorrowings], 'item', { k: 'cfCB' }),
      R(T.distribution === 'Drawing' ? 'Drawing' : 'Dividend Paid', [fi.drawing, pc2.drawing], 'item', { k: 'cfDraw' }),
      R('Net Cash Flows from Financing Activities', [cf.netFinancing, pc2.netFinancing], 'tot', {
        k: 'cfFinance', xf: ({ R: r, c }) => `SUM(${c}${r.cfCap}:${c}${r.cfDraw})`,
      }),
      B(),
      R('Net Increase in Cash & Cash Equivalents', [cf.netIncrease, pc2.netIncrease], 'tot', {
        k: 'cfNet', xf: ({ R: r, c }) => `${c}${r.cfOper}+${c}${r.cfInvest}+${c}${r.cfFinance}`,
      }),
      R('Cash & Cash Equivalents at the Beginning of the year', [cf.openingCash, pc2.openingCash], 'item', { k: 'cfOpen' }),
      R('Exchanges (Losses)/Gains on Cash & Cash Equivalents', [0, 0], 'item', { k: 'cfFx' }),
      R('Cash & Cash Equivalents at the end of the year', [cf.closingCash, pc2.closingCash], 'grand', {
        k: 'cfClose', xf: ({ R: r, c }) => `${c}${r.cfNet}+${c}${r.cfOpen}+${c}${r.cfFx}`,
      }),
      B(),
      R('The notes are an integral part of these financial statements.', [], 'note'),
      R('This is the cash flow statement referred to in our report of even date.', [], 'note'),
    ],
  });

  // ── 3.1 PPE: the fixed-asset matrix ──
  const pt = (out.ppe && out.ppe.totals) || {};
  const across = (get) => [...pc.map(get), pc.reduce((s, c) => s + (get(c) || 0), 0)];
  sheets.push({
    key: 'PPE', name: '3.1 PPE', geom: FSX_GEOM.PPE, matrix: true,
    title: '3.1 Property, Plant and Equipment', subtitle: 'Figures in NPR',
    heading: '3. Other Explanatory Notes',
    cols: [...pc.map(c => ({ h1: c.name })), { h1: 'Total' }],
    rows: [
      R(m.socOpenLabel || 'Balance as at beginning of the year', across(c => c.openCost), 'item', { k: 'costOpen', rowTotal: true }),
      R('Additions', across(c => c.additions), 'item', { k: 'additions', rowTotal: true }),
      R('Disposals', across(c => c.disposals), 'item', { k: 'disposals', rowTotal: true }),
      R(m.socCloseLabel || 'Balance at end of the year', across(c => c.closeCost), 'tot', {
        k: 'costClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costOpen}+${c}${r.additions}-${c}${r.disposals}`,
      }),
      B(),
      R('Depreciation and Impairment Losses: ', [], 'head'),
      R(m.socOpenLabel || 'Balance as at beginning of the year', across(c => c.openDep), 'item', { k: 'depOpen', rowTotal: true }),
      R('Depreciation Charged for the Year', across(c => c.depCharge), 'item', { k: 'depCharge', rowTotal: true }),
      R('Adjustment due to Impairment Losses', across(c => c.impairment), 'item', { k: 'impair', rowTotal: true }),
      R('Disposals', across(c => c.disposalDep), 'item', { k: 'depDisposal', rowTotal: true }),
      R(m.socCloseLabel || 'Balance at end of the year', across(c => c.closeDep), 'tot', {
        k: 'depClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.depOpen}+${c}${r.depCharge}+${c}${r.impair}-${c}${r.depDisposal}`,
      }),
      B(),
      R('Carrying Amount:', [], 'head'),
      R('As at beginning of the year', across(c => c.openCarrying), 'item', {
        k: 'carryOpen', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costOpen}-${c}${r.depOpen}`,
      }),
      R('As at end of the year', across(c => c.closeCarrying), 'grand', {
        k: 'carryClose', rowTotal: true, xf: ({ R: r, c }) => `${c}${r.costClose}-${c}${r.depClose}`,
      }),
    ],
  });

  // ── Sch-BS: balance-sheet notes 3.2–3.10 ──
  const recvLines = bal.receivableLines || [];
  const payLines = bal.payableLines || [];
  const pyPayByName = {};
  for (const p of (py.payableItems || [])) pyPayByName[String(p.name).toLowerCase()] = p.amount;
  const pyPay = (name) => {
    const n = String(name).toLowerCase();
    for (const k of Object.keys(pyPayByName)) if (k.includes(n) || n.includes(k)) return pyPayByName[k];
    return 0;
  };
  // Prior-year figures for the notes whose comparative column would otherwise
  // be blank. Matched by label against the client's own 3.8 lines rather than
  // splitting the SFP total, which would be inventing a breakdown.
  const pyFind = (list, re) => {
    const hit = (list || []).find(it => re.test(String(it.name)));
    return hit ? hit.amount : 0;
  };
  const pyLoan = (re) => pyFind(py.loanItems, re);

  const schBsRows = [
    R('3.2 Investment', [], 'head'),
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
    B(),
    R('3.3 Trade & Other Receivables', [], 'head'),
  ];
  recvLines.forEach((l, i) => {
    schBsRows.push(R(l.name, [l.amount, i === 0 ? pySfp.receivables : 0], 'item', {
      k: 'recv' + i, balancing: !!l.balancing,
    }));
  });
  schBsRows.push(
    R('Total trade and other receivables', [bal.receivables, pySfp.receivables], 'tot', {
      k: 'recvTotal', xsum: recvLines.map((_, i) => 'recv' + i),
    }),
    R('Less: Non-current portion', [0, 0], 'item', { k: 'recvNC' }),
    R('Current portion', [bal.receivables, pySfp.receivables], 'tot', {
      k: 'recvCurrent', xf: ({ R: r, c }) => `${c}${r.recvTotal}-${c}${r.recvNC}`,
    }),
    B(),
    R('3.4 Inventories', [], 'head'),
    R('Raw materials and consumables', [0, 0], 'item', { k: 'invRaw' }),
    R('Work-in-progress', [0, 0], 'item', { k: 'invWip' }),
    R('Finished Goods', [bal.inventories, pySfp.inventories], 'item', { k: 'invFg', xf: ({ X }) => X('SchPL', 'matClosing') }),
    R('Total', [bal.inventories, pySfp.inventories], 'tot', { k: 'invTotal', xsum: ['invRaw', 'invWip', 'invFg'] }),
    B(),
    R('3.5 Cash & Cash Equivalents', [], 'head'),
    R('Cash & Bank Balance', [bal.cash, pySfp.cash], 'item', { k: 'cashBank' }),
    R('Total', [bal.cash, pySfp.cash], 'tot', { k: 'cashTotal', xsum: ['cashBank'] }),
    B(),
    R('3.6 ' + T.capital, [], 'head'),
    R('At the beginning of the year', [(bal.shareCapital || 0) - ((out.soce || {}).capital || 0), pyFind(py.capitalItems, /beginning/i) || pySfp.shareCapital], 'item', { k: 'capOpen' }),
    R('Addition During the Year', [(out.soce || {}).capital || 0, pyFind(py.capitalItems, /addition|issue|call money/i)], 'item', { k: 'capAdd' }),
    R('Total', [bal.shareCapital, pySfp.shareCapital], 'tot', { k: 'capTotal', xsum: ['capOpen', 'capAdd'] }),
    B(),
    R('3.7 Reserves', [], 'head'),
    // The prior year's own opening is its closing less its result for that
    // year — the only way to state it without a second comparative file.
    R('Opening', [(out.soce || {}).open && (out.soce.open.retained || 0),
                  pyFind(py.reserveItems, /opening/i) || r2((pySfp.reserves || 0) - (pySoi.netProfit || 0))], 'item', { k: 'resOpen' }),
    R('Add: Profit for the year', [inc.netProfit, pySoi.netProfit], 'item', { k: 'resProfit', xf: ({ X }) => X('SOI', 'np') }),
    R('Less: ' + T.distribution, [-((out.soce || {}).dividend || 0), -Math.abs(pyFind(py.reserveItems, /drawing|dividend/i))], 'item', { k: 'resDist' }),
    R('Total', [bal.reserves, pySfp.reserves], 'tot', { k: 'resTotal', xsum: ['resOpen', 'resProfit', 'resDist'] }),
    B(),
    R('3.8 Loans Borrowings', [], 'head'),
    R('Non-Current :', [], 'sub'),
    R('Term Loan', [(out.rawFigures || {}).H || 0, pyLoan(/term/i)], 'item', { k: 'loanTerm' }),
    R('PWC Loan', [(out.rawFigures || {}).I || 0, pyLoan(/pwc|permanent/i)], 'item', { k: 'loanPwc' }),
    R('HP Loan', [(out.rawFigures || {}).J || 0, pyLoan(/\bhp\b|hire/i)], 'item', { k: 'loanHp' }),
    R(T.person + ' Loan', [(out.levers || {}).directorLoan || 0, pyLoan(/director|proprietor|partner/i)], 'item', { k: 'loanDir' }),
    R('Total', [bal.loansNonCurrent, pySfp.loansNC], 'tot', { k: 'loanNCTotal', xsum: ['loanTerm', 'loanPwc', 'loanHp', 'loanDir'] }),
    R('Current :', [], 'sub'),
    R('Bank Overdrafts', [bal.loansCurrent, pySfp.loansC], 'item', { k: 'loanOd' }),
    R('Total', [bal.loansCurrent, pySfp.loansC], 'tot', { k: 'loanCTotal', xsum: ['loanOd'] }),
    R('Total loans and borrowings', [(bal.loansNonCurrent || 0) + (bal.loansCurrent || 0), (pySfp.loansNC || 0) + (pySfp.loansC || 0)], 'tot', {
      k: 'loanAll', xsum: ['loanNCTotal', 'loanCTotal'],
    }),
    B(),
    R('3.9 Trade and Other Payables', [], 'head'),
  );
  payLines.forEach((l, i) => {
    const extra = { k: 'pay' + i };
    if (/tds on salary/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'empTotal'); return x ? `${x}*1%` : null; };
    else if (/tds on rent/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'rent'); return x ? `${x}*10%` : null; };
    else if (/tds payable-audit/i.test(l.name)) extra.xf = ({ X }) => { const x = X('SchPL', 'auditFee'); return x ? `${x}*1.5%` : null; };
    schBsRows.push(R(l.name, [l.amount, pyPay(l.name)], 'item', extra));
  });
  schBsRows.push(
    R('Total', [bal.totalPayables, pySfp.payables], 'tot', { k: 'payTotal', xsum: payLines.map((_, i) => 'pay' + i) }),
    B(),
    R('3.10 Provisions', [], 'head'),
    R('Provision for Income Tax', [inc.tax, pySoi.tax], 'item', { k: 'provTax', xf: ({ X }) => X('SOI', 'tax') }),
    R('Total', [inc.tax, pySoi.tax], 'tot', { k: 'provTotal', xsum: ['provTax'] }),
    R('Non-Current Portion', [bal.provisionsNC, pySfp.provisionsNC], 'item', { k: 'provNCPortion' }),
    R('Current Portion', [bal.provisionsC, pySfp.provisionsC], 'tot', {
      k: 'provCurrent', xf: ({ R: r, c }) => `${c}${r.provTotal}-${c}${r.provNCPortion}`,
    }),
  );
  sheets.push({
    key: 'SchBS', name: 'Sch-BS', geom: FSX_GEOM.SchBS,
    title: 'Schedules to the Statement of Financial Position', subtitle: 'Figures in NPR',
    cols: [{ h1: 'As at', h2: cyHead }, { h1: 'As at', h2: pyHead }],
    rows: schBsRows,
  });

  // ── Sch-PL: income-statement notes 3.11–3.16 ──
  const pyMat = py.materials || {};
  const schPlRows = [
    R('3.11 Revenue from Operations', [], 'head'),
    R('Revenue From Operations:', [], 'sub'),
    R('Sale of Goods', [m.serviceIndustry ? 0 : inc.revenueOps, pySoi.revenueOps], 'item', { k: 'saleGoods' }),
    R('Rendering of Services', [m.serviceIndustry ? inc.revenueOps : 0, 0], 'item', { k: 'saleServices' }),
    R('Sub-Total', [inc.revenueOps, pySoi.revenueOps], 'tot', { k: 'revOpsSub', xsum: ['saleGoods', 'saleServices'] }),
    R('Revenue From Other Operations:', [], 'sub'),
    R('Commisions & Incentives', [inc.revenueOther, 0], 'item', { k: 'revComm' }),
    R('Sub-Total', [inc.revenueOther, 0], 'tot', { k: 'revOtherSub', xsum: ['revComm'] }),
    R('Total', [(inc.revenueOps || 0) + (inc.revenueOther || 0), pySoi.revenueOps], 'tot', { k: 'revTotal', xsum: ['revOpsSub', 'revOtherSub'] }),
    B(),
    R('Revenue From Non-Operations:', [], 'sub'),
    R('Interest Income', [inc.interestIncome, pySoi.interestIncome], 'item', { k: 'intIncome' }),
    R('Other Income', [inc.otherIncome, pySoi.otherIncome], 'item', { k: 'othIncome' }),
    R('Total', [(inc.interestIncome || 0) + (inc.otherIncome || 0), (pySoi.interestIncome || 0) + (pySoi.otherIncome || 0)], 'tot', { k: 'nonOpTotal', xsum: ['intIncome', 'othIncome'] }),
    B(),
    R('3.12 Material Consumed Expenses', [], 'head'),
    R('Balance on beginning of the year', [mat.opening, pyMat.opening], 'item', { k: 'matOpening' }),
    R('Add:  ', [], 'sub'),
    R('Purchase of goods', [mat.purchases, pyMat.purchases], 'item', { k: 'matPurchase', balancing: true }),
  ];
  (mat.directItems || []).forEach((it, i) => {
    schPlRows.push(R(it.name, [it.amount, ((pyMat.directItems || [])[i] || {}).amount || 0], 'item', { k: 'matDirect' + i }));
  });
  schPlRows.push(
    R('Less:', [], 'sub'),
    R('Balance as at end of the year', [mat.closing, pyMat.closing], 'item', { k: 'matClosing' }),
    R('Total', [mat.total, pySoi.materials], 'tot', {
      k: 'matTotal',
      xf: ({ R: r, c }) => {
        const adds = ['matOpening', 'matPurchase', ...(mat.directItems || []).map((_, i) => 'matDirect' + i)]
          .filter(k => r[k]).map(k => `${c}${r[k]}`).join('+');
        return adds ? `${adds}-${c}${r.matClosing}` : null;
      },
    }),
    B(),
    R('3.13 Employee Benefits Expenses', [], 'head'),
  );
  (inc.employeeItems || []).forEach((it, i) => {
    schPlRows.push(R(it.name, [it.amount, ((py.employeeItems || [])[i] || {}).amount || 0], 'item', { k: 'emp' + i }));
  });
  schPlRows.push(
    R('Total', [inc.employeeTotal, pySoi.employee], 'tot', { k: 'empTotal', xsum: (inc.employeeItems || []).map((_, i) => 'emp' + i) }),
    B(),
    R('3.14 Finance Cost', [], 'head'),
  );
  (inc.financeItems || []).forEach((it, i) => {
    schPlRows.push(R(it.name, [it.amount, ((py.financeItems || [])[i] || {}).amount || 0], 'item', { k: 'fin' + i }));
  });
  schPlRows.push(
    R('Total', [inc.financeTotal, pySoi.financeCost], 'tot', { k: 'finTotal', xsum: (inc.financeItems || []).map((_, i) => 'fin' + i) }),
    B(),
    R('3.15 Other Expenses', [], 'head'),
  );
  const pyOtherByName = {};
  for (const it of (py.otherItems || [])) pyOtherByName[String(it.name).toLowerCase().trim()] = it.amount;
  (inc.otherItems || []).forEach((it, i) => {
    const key = /audit\s*fee/i.test(it.name) ? 'auditFee' : (/\brent\b/i.test(it.name) ? 'rent' : 'oth' + i);
    schPlRows.push(R(it.name, [it.amount, pyOtherByName[String(it.name).toLowerCase().trim()] || 0], 'item', { k: key, oi: i }));
  });
  schPlRows.push(
    R('Total', [inc.otherTotal, pySoi.otherExpenses], 'tot', {
      k: 'othTotal',
      xsum: (inc.otherItems || []).map((it, i) => /audit\s*fee/i.test(it.name) ? 'auditFee' : (/\brent\b/i.test(it.name) ? 'rent' : 'oth' + i)),
    }),
    B(),
    R('3.16 Tax Expenses ', [], 'head'),
    R('Tax on profits for the year', [inc.tax, pySoi.tax], 'item', { k: 'taxYear', xf: ({ X }) => X('COI', 'tax') }),
    R('Adjustments for under provision in prior periods', [0, 0], 'item', { k: 'taxAdj' }),
    R('Total', [inc.tax, pySoi.tax], 'tot', { k: 'taxTotal', xsum: ['taxYear', 'taxAdj'] }),
  );
  sheets.push({
    key: 'SchPL', name: 'Sch-PL', geom: FSX_GEOM.SchPL,
    title: 'Schedules to the Statement of Income', subtitle: 'Figure in NPR',
    cols: [{ h1: 'Year Ended', h2: yrHead }, { h1: 'Year Ended', h2: yrHeadPy }],
    rows: schPlRows,
  });

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

  return { meta: m, sheets, proofs: out.proofs || {}, issues: out.issues || [] };
}

// ════════════════════════════════════════════════════════════════
//  SHARED CELL FORMATTING
// ════════════════════════════════════════════════════════════════

const fsxIsNum = (v) => typeof v === 'number' && isFinite(v);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Accounting presentation: brackets for negatives, en-dash for nil.
function fsxAmt(v) {
  if (v == null || v === '') return '';
  if (!fsxIsNum(v)) return String(v);
  if (Math.abs(v) < 0.005) return '–';
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
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

// Where each sheet's title block ends and its data rows begin. Pure and
// data-driven (not sheet-key special-cased) so pass 1 and pass 2 agree:
// the header band sits one row later than usual only when a column is
// actually marked `restated` — exactly the SFP/SOI vs SOCE/SOCF split
// observed in the template, which turns out to be driven by that flag
// rather than by which sheet it is.
function fsxLayout(sh) {
  if (sh.noHeaderBand) return { bandRow: null, firstDataRow: 2 };
  if (FSX_SCHEDULE_KEYS[sh.key]) {
    // row1 (optional) heading, then title+"Figures in NPR" together, then a
    // short blank spacer, then the header band.
    const titleRow = sh.heading ? 2 : 1;
    const bandRow = titleRow + 2;
    return { bandRow, firstDataRow: bandRow + 1, titleRow, hasCompany: false };
  }
  // Statement sheets: rows 2-6 company/address/title/period/"Figures in
  // NPR", row 7 a short blank spacer, row 8 the "Restated" tag ONLY when a
  // column needs it (pushing the band to row 9), else the band is row 8.
  const hasRestated = (sh.cols || []).some(c => c.restated);
  const bandRow = hasRestated ? 9 : 8;
  return { bandRow, firstDataRow: bandRow + 1, hasCompany: true };
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
  let lastCol = labelCol;
  for (const c of valueCols) lastCol = Math.max(lastCol, c);
  if (noteCol) lastCol = Math.max(lastCol, noteCol);
  for (let c = 1; c <= lastCol; c++) {
    let w;
    if (c === labelCol) w = sh.key === 'COI' ? 52 : 42;
    else if (c === noteCol) w = 16;
    else if (valueCols.has(c)) w = sh.matrix ? 16 : 22.5;
    else if (c === 1 && labelCol !== 1) w = 9;
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
    if (!sh.noHeaderBand) {
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
        ws.getRow(7).height = 5;
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
      (sh.cols || []).forEach((col, i) => {
        const cn = fsxColNum(fsxSheetCol(geom, i, !!sh.matrix));
        if (!cn) return;
        const cell = ws.getCell(bandRow, cn);
        cell.value = col.h2 ? `${col.h1}\n${col.h2}` : col.h1;
        cell.font = font({ bold: true, size: 12 });
        cell.alignment = { horizontal: 'right', wrapText: true, vertical: 'bottom' };
        cell.border = { bottom: medium };
      });
      ws.getRow(bandRow).height = 30;
    }

    // ── pass 2: the rows ──
    const rowsMap = reg[sh.key].rows;
    let rn = layout.firstDataRow;
    for (const r of sh.rows) {
      const rowNo = rn++;
      if (r.kind === 'blank') { ws.getRow(rowNo).height = 6; continue; }

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

        // A blank current-year cell stays genuinely empty — no formula, no
        // zero. Writing a formula whose result is null would make Excel show
        // 0 the moment it recalculated, which is not the same claim as "not
        // entered yet".
        if (v === null) { cell.value = null; cell.numFmt = FSX_NUMFMT; return; }
        if (!fsxIsNum(v)) { cell.value = v == null ? '' : String(v); cell.font = font({ size: 14 }); cell.alignment = { horizontal: 'left' }; return; }

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
          try { formula = r.xf({ R: rowsMap, c: colLetter, ci: i, X: mkX(i), rn: rowNo }) || null; }
          catch (e) { formula = null; }
        }

        // Only the current-year column carries formulas: the comparative column
        // holds the prior year's reported figures, which need not foot from the
        // lines this sheet breaks out.
        if (formula && i > 0 && !sh.matrix) formula = null;

        cell.value = formula ? { formula, result: v } : v;
        cell.numFmt = FSX_NUMFMT;
        cell.alignment = { horizontal: 'right' };
        cell.font = font({ bold: r.kind === 'tot' || r.kind === 'grand', size: 14 });

        // Borders live on the value cell only — never the label/note cell,
        // and never on a plain item row: confirmed cell-by-cell against the
        // template (an ordinary line carries no border at all; a subtotal's
        // value cells carry top-thin/bottom-double; a grand total's carry
        // bottom-double only, since a blank spacer row already separates it).
        if (r.kind === 'tot') cell.border = { top: thin, bottom: double };
        else if (r.kind === 'grand') cell.border = { bottom: double };
      });

      if (r.balancing) {
        const cn = fsxColNum(fsxSheetCol(geom, 0, !!sh.matrix));
        if (cn) ws.getCell(rowNo, cn).note = 'Balancing figure';
      }
    }

    // ── signature block (prompt §9: notes 12pt bold, signature/date 13pt regular) ──
    if (sh.sig) {
      const T = report.meta.terms || {};
      let sr = rn + 3;
      const sigCols = [labelCol, geom.note ? fsxColNum(geom.note) : labelCol + 2, lastCol];
      const names = [T.person || 'Director', 'Accountant',
        report.meta.auditor && report.meta.auditor.name ? 'Registered Auditor' : ''];
      sigCols.forEach((c, i) => {
        if (!names[i]) return;
        ws.getCell(sr, c).value = '…………………………';
        ws.getCell(sr, c).font = font({ size: 13 });
        ws.getCell(sr + 2, c).value = names[i];
        ws.getCell(sr + 2, c).font = font({ size: 13 });
      });
      if (report.meta.auditor && report.meta.auditor.name) {
        ws.getCell(sr + 3, lastCol).value = report.meta.auditor.name;
        ws.getCell(sr + 3, lastCol).font = font({ size: 13 });
      }
      ws.getCell(sr + 4, labelCol).value = 'Date: ' + (report.meta.dateBs || '');
      ws.getCell(sr + 5, labelCol).value = 'Place: ' + (report.meta.place || 'Chitwan');
      ws.getCell(sr + 4, labelCol).font = font({ size: 13 });
      ws.getCell(sr + 5, labelCol).font = font({ size: 13 });
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

const FSX_PRINT_CSS = `
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #111; background: #fff;
         margin: 0; font-size: 11px; }
  .fsp-sheet { page-break-after: always; padding-bottom: 6mm; }
  .fsp-sheet:last-child { page-break-after: auto; }
  .fsp-co { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
  .fsp-addr { text-align: center; font-size: 11px; color: #333; margin-top: 2px; }
  .fsp-title { text-align: center; font-size: 13px; font-weight: 700; margin-top: 10px; }
  .fsp-sub { text-align: center; font-size: 10.5px; margin-top: 2px; }
  .fsp-fig { text-align: center; font-size: 9.5px; font-style: italic; color: #555; margin-top: 2px; }
  .fsp-restated { text-align: right; font-size: 9px; font-style: italic; color: #555; margin: 8px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  thead th { background: #0B1F3D; color: #fff; font-size: 10px; font-weight: 700;
             padding: 6px 7px; text-align: right; vertical-align: bottom; }
  thead th.fsp-lab { text-align: left; }
  thead th.fsp-note { text-align: center; width: 42px; }
  td { padding: 3.5px 7px; border-bottom: 1px solid #E4E8F0; }
  td.fsp-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 118px; }
  td.fsp-note { text-align: center; color: #444; width: 42px; }
  tr.fsp-head td { font-weight: 700; color: #0B1F3D; padding-top: 9px; border-bottom: none; }
  tr.fsp-sub td { font-weight: 700; border-bottom: none; }
  tr.fsp-item td.fsp-lab { padding-left: 18px; }
  tr.fsp-tot td { font-weight: 700; background: #EBEFF6; border-top: 1px solid #8593A6; }
  tr.fsp-grand td { font-weight: 700; background: #D8E2ED; border-top: 1px solid #0B1F3D;
                    border-bottom: 3px double #0B1F3D; }
  tr.fsp-note-row td { font-style: italic; font-size: 9.5px; color: #444; border-bottom: none; padding-top: 8px; }
  tr.fsp-kv td { border-bottom: 1px dotted #D8DEE8; }
  tr.fsp-blank td { height: 7px; border-bottom: none; padding: 0; }
  .fsp-sig { margin-top: 16mm; width: 100%; }
  .fsp-sig td { border: none; font-size: 10.5px; padding: 2px 7px; }
  .fsp-sig .fsp-line { padding-bottom: 2px; letter-spacing: 1px; }
  .fsp-sig .fsp-role { font-weight: 700; }
  .fsp-meta { margin-top: 6mm; font-size: 10.5px; }
  .fsp-proof { margin-top: 6mm; font-size: 10px; border: 1px solid #E4E8F0; padding: 6px 8px; }
  .fsp-proof b { color: #0B1F3D; }
  .fsp-ok { color: #1A8040; font-weight: 700; }
  .fsp-bad { color: #BF2929; font-weight: 700; }
  @media print { .fsp-noprint { display: none !important; } }
`;

function fsxEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One sheet as an HTML table. Used by the preview pane and the print document.
function fsxSheetHtml(sh, meta) {
  const nCols = (sh.cols || []).length || 1;
  const hasNote = !!(sh.geom && sh.geom.note);
  const out = [];
  out.push('<div class="fsp-sheet">');
  if (!sh.noHeaderBand) {
    out.push(`<div class="fsp-co">${fsxEsc((meta.company || {}).name)}</div>`);
    out.push(`<div class="fsp-addr">${fsxEsc((meta.company || {}).address)}</div>`);
  }
  if (sh.heading) out.push(`<div class="fsp-title">${fsxEsc(sh.heading)}</div>`);
  out.push(`<div class="fsp-title">${fsxEsc(sh.title || '')}</div>`);
  if (sh.subtitle) out.push(`<div class="fsp-sub">${fsxEsc(sh.subtitle)}</div>`);
  out.push('<div class="fsp-fig">Figures in NPR</div>');
  if ((sh.cols || []).some(c => c.restated)) out.push('<div class="fsp-restated">Restated</div>');

  out.push('<table>');
  if (!sh.noHeaderBand) {
    out.push('<thead><tr>');
    out.push('<th class="fsp-lab">Particulars</th>');
    if (hasNote) out.push('<th class="fsp-note">Notes</th>');
    for (const c of (sh.cols || [])) {
      out.push(`<th>${fsxEsc(c.h1)}${c.h2 ? '<br>' + fsxEsc(c.h2) : ''}</th>`);
    }
    out.push('</tr></thead>');
  }
  out.push('<tbody>');
  const span = 1 + (hasNote ? 1 : 0) + nCols;
  for (const r of sh.rows) {
    if (r.kind === 'blank') { out.push(`<tr class="fsp-blank"><td colspan="${span}"></td></tr>`); continue; }
    if (r.kind === 'note') {
      if (!r.label) continue;
      out.push(`<tr class="fsp-note-row"><td colspan="${span}">${fsxEsc(r.label)}</td></tr>`);
      continue;
    }
    const cls = 'fsp-' + (r.kind === 'kv' ? 'kv' : r.kind);
    out.push(`<tr class="${cls}">`);
    out.push(`<td class="fsp-lab">${fsxEsc(r.label)}</td>`);
    if (hasNote) out.push(`<td class="fsp-note">${fsxEsc(r.note || '')}</td>`);
    for (let i = 0; i < nCols; i++) {
      const v = (r.vals || [])[i];
      if (r.kind === 'head' || r.kind === 'sub') { out.push('<td class="fsp-num"></td>'); continue; }
      out.push(`<td class="fsp-num">${fsxEsc(fsxIsNum(v) ? fsxAmt(v) : (v == null ? '' : v))}</td>`);
    }
    out.push('</tr>');
  }
  out.push('</tbody></table>');

  if (sh.sig) {
    const T = meta.terms || {};
    const showAuditor = !!(meta.auditor && meta.auditor.name);
    out.push('<table class="fsp-sig"><tr>');
    out.push('<td class="fsp-line">…………………………</td><td class="fsp-line">………………….</td>');
    out.push(`<td class="fsp-line" style="text-align:right">${showAuditor ? '……………………………….' : ''}</td>`);
    out.push('</tr><tr>');
    out.push(`<td class="fsp-role">${fsxEsc(T.person || 'Director')}</td><td class="fsp-role">Accountant</td>`);
    out.push(`<td class="fsp-role" style="text-align:right">${showAuditor ? 'Registered Auditor' : ''}</td>`);
    out.push('</tr>');
    if (showAuditor) out.push(`<tr><td></td><td></td><td style="text-align:right">${fsxEsc(meta.auditor.name)}</td></tr>`);
    out.push('</table>');
    out.push(`<div class="fsp-meta">Date: ${fsxEsc(meta.dateBs || '')}<br>Place: ${fsxEsc(meta.place || 'Chitwan')}</div>`);
  }
  out.push('</div>');
  return out.join('');
}

// The full statement set as a standalone document.
function fsxReportHtmlDoc(report, opts) {
  const o = opts || {};
  const body = report.sheets.map(sh => fsxSheetHtml(sh, report.meta)).join('\n');
  const auto = o.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},300);});<\/script>'
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${fsxEsc(((report.meta.company || {}).name || 'Financial Statement') + ' — ' + (report.meta.fy || ''))}</title>
<style>${FSX_PRINT_CSS}</style></head><body>${body}${auto}</body></html>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fsxBuildReport, fsxWriteWorkbook, fsxSheetCol, fsxAmt, fsxPdfSafe,
    fsxSheetHtml, fsxReportHtmlDoc, FSX_PRINT_CSS,
    FSX_GEOM, FSX_NUMFMT, FSX_NUMFMT0, fsxColNum, fsxColLetter,
  };
}
