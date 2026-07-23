// ════════════════════════════════════════════
//  PROJECTION REPORT — EXPORTS
//  Excel (ExcelJS, live formulas + cached results, master-workbook layout:
//  Pl · BS · CF · Dep · IRD · NCA) and PDF (PDF-Lib, A4 landscape table
//  layout mirroring the Excel sheets row-for-row) for the
//  Projection Report module. Split from js/projection.js so the UI file
//  stays readable (§11 rule 5); same pattern as depreciation.js ↔
//  depreciationSlm.js.
//
//  Layout authority is File 3 ("overall important format…xlsx"): row
//  positions of the Dep blocks (total row = 13 + 12·(year−1)) are load-
//  bearing — Pl/BS reference them by address. The master's own known cell
//  errors (year-3 Dep double-addition, CF omitting the ΔCA row from the
//  operating total, BS year-1 WDV pointing at the net instead of gross
//  total) are deliberately corrected here.
// ════════════════════════════════════════════


// ── Shared row labels — the single source for BOTH the Excel and the PDF
//  generators, so the two outputs can never drift apart (the first PDF
//  paraphrased these and shipped with different text than the workbook).
//  "Adminstrative" from the master is deliberately spelled correctly here. ──
const PJX_PL_L = {
  sales: 'Income from Sales/Service', cogsHead: 'Cost of Goods Sold',
  opening: 'Opening Stock', purchase: 'Goods Purchase', direct: 'Direct Cost',
  closing: '(-) Closing Stock', cogsTotal: 'Total Cost of Goods Sold',
  gp: 'Gross Profit', adminHead: 'Administrative Expenses', adminTotal: 'Total Administrative Expenses',
  pbid: 'Profit before interest/Depreciation', intST: 'Bank Interest on Short term/OD',
  intLT: 'Bank Interest on Term', dep: 'Depreciation', pbt: 'Net Profit before tax',
  tax: 'Provision for tax', pat: 'Net Profit after tax for the year',
  upto: 'Profit/loss upto last year', div: 'Dividend/Withdrawal',
  transfer: 'Transferred to Balance Sheet',
};
const PJX_BS_L = {
  srcLabel: 'Sources of Funds:', capLabel: '1. Share Capital',
  cap: 'a. Registered/Paid up Share Capital', addl: 'b. Director/Partner/Proprietor Additional Capital',
  reserve: 'c. Reserve & Surplus', lt: '2. Long Term Loan', pwc: '3. Permanent Working Capital',
  director: '4. Director/Proprietor/Partner Lending', totalSrc: 'Total Sources of Funds',
  usesLabel: 'Uses of Funds:', faLabel: '1. Fixed Assets', wdv: 'a. Written down Book Value',
  depRow: 'b. Depreciation', faTotal: 'Total Fixed Assets', caLabel: '2. Current Assets',
  cash: 'a. Cash at Hand & Bank', debtors: 'b. Sundry Debtors', stock: 'c. Closing Stock',
  caTotal: 'Total Current Assets', clLabel: '3. Current Liabilities', creditors: 'a. Sundry Creditors',
  provTax: 'b. Provision for tax', expPay: 'c. Expenses Payable', tds: 'd. TDS Payables',
  stl: 'e. Short Term Loan /OD/CC', clTotal: 'Total Current Liabilities',
  nca: 'Net Current Assets (2-3)', totalUses: 'Total Uses of Funds',
};
const PJX_CF_L = {
  aLabel: 'A. Cash flow from Operating Activities',
  npbit: 'Net Profit/Loss before interest & income tax', dep: '1. Depreciation', tax: '2. Income tax',
  opSub: 'Operating profit before working capital changes',
  dCA: '1. Increase/(Decrease) in Current Assets', dCL: '2. Increase/(Decrease) in Current Liabilities',
  wcSub: 'Change in Working Capital', netOp: 'Net cash flow from Operating Activities',
  bLabel: 'B. Cash flow from Investing Activities',
  capex: '1. Sale/(Purchase) of Fixed Assets', liqNC: '2. Sale of (investment in) Securities',
  netInv: 'Net cash flow from Investing Activities',
  cLabel: 'C. Cash flow from Financing Activities',
  issue: '1. Issuance of Share Capital (Additional Capital)', div: '2. Drawing/Dividend',
  intPaid: '3. Payment of Interest', dDir: '4. Increase/(decrease) in Director/Partner/Proprietor',
  dLoans: '5. Increase/(decrease) in Bank Loans', netFin: 'Net cash flow from Financing Activities',
  netChange: 'Increase/(Decrease) in cash (A+B+C)', openCash: 'Opening balances of cash & bank',
  closeCash: 'Closing balances of cash & bank',
};
// IRD rows: `np` is the master's combined Nepali+English label (Excel);
// `en` the English-only form (PDF — standard fonts can't render Devanagari).
const PJX_IRD_ROWS = [
  { key: 'grossIncome',        np: 'कुल आम्दानी (Gross Income)',                                en: 'Gross Income' },
  { key: 'pbt',                np: 'कर अगाडिको खुद मुनाफा/नोक्सानी (Net Profit/Loss Before Tax)', en: 'Net Profit/Loss Before Tax' },
  { key: 'tax',                np: 'आयकर दायित्व (Tax Liability)',                              en: 'Tax Liability' },
  { key: 'paidUpCapital',      np: 'चुक्ता पुँजी (Paid up Capital)',                             en: 'Paid up Capital' },
  { key: 'reserves',           np: 'जगेडा (सञ्चित नाफा सहित) (Reserve)',                        en: 'Reserve (incl. accumulated profit)' },
  { key: 'bankLoan',           np: 'ऋण (Loan from Bank and Financial Institution)',            en: 'Loan from Bank and Financial Institution' },
  { key: 'currentLiabilities', np: 'चालु दायित्व (Current Liabilities)',                        en: 'Current Liabilities' },
  { key: 'provision',          np: 'व्यवस्था (Provision)',                                     en: 'Provision' },
  { key: 'currentAssets',      np: 'चालु सम्पत्ति (Current Assets)',                            en: 'Current Assets' },
  { key: 'fixedAssets',        np: 'स्थिर सम्पत्ति (Fixed Assets)',                             en: 'Fixed Assets' },
];
const PJX_DEP_COLS = ['Opening', 'Additional', 'Sales', 'Total', 'Dep Rate %', 'Depreciation', 'Balance Amount'];

// Organization-specific terminology (master BS F-column rules): a report
// never shows "Director/Partner/Proprietor" together — only the term for
// the client's own organization type.
function pjxTerms(orgType) {
  const t = orgType === 'partnership' ? { capital: 'Registered Capital', person: 'Partner' }
    : orgType === 'proprietorship' ? { capital: 'Registered Capital', person: 'Proprietor' }
    : { capital: 'Paid-up Share Capital', person: 'Director' };
  return {
    ...t,
    capRow: `a. ${t.capital}`,
    addlRow: `b. ${t.person} Additional Capital`,
    lendRow: `4. ${t.person} Lending`,
    dDirRow: `4. Increase/(decrease) in ${t.person}`,
  };
}

function pjxCol(i) {           // 1 → A, 2 → B …
  let s = '';
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - 1 - m) / 26; }
  return s;
}

function pjxBorder(cell) {
  cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
}
// ── Shared report model ────────────────────────────────────────────
//  ONE description of the whole report — section order, columns, rows,
//  labels, pruning and org terminology — consumed by BOTH the PDF and the
//  Excel writer, so the two outputs are the same document in two formats
//  (they previously had independent layouts and drifted).
//
//  Row kinds: 'sec' (section heading) · 'item' (indented detail) · 'plain'
//  (un-indented detail) · 'tot' (subtotal band) · 'grand' (grand total,
//  double-ruled) · 'span' (centred banner, Dep year titles).
//  Value cells: number (amount) | string (literal) | { t, n, fmt, tone } —
//  `t` display text, `n` raw number + `fmt` for Excel, `tone` pass/fail.
//  Excel formulas: `xsum` (list of row keys to add) or `xexpr` (builder);
//  both resolve against the row map so pruning can never mis-reference.

const PJX_NUMFMT  = '#,##0.00;(#,##0.00);"–"';   // legacy 2-dp (unused by the mirrored sheets)
const PJX_NUMFMT0 = '#,##0;(#,##0);"–"';         // whole rupees — matches the PDF exactly

function pjxBuildReport() {
  const m = pjModel;
  const Y = pjResult.years;
  const N = Y.length;
  const company = pjEl('pj-company').value || m.company.name;
  const address = m.company.address;
  const T = pjxTerms((pjEl('pj-org-type') || {}).value);
  const incAud = !!(pjEl('pj-include-audited') || {}).checked;
  // The report names the single uploaded statement (Audited OR Provisional).
  const stmtType = (pjEl('pj-statement-type') || {}).value === 'provisional' ? 'Provisional' : 'Audited';

  const tb = (typeof NepaliLocale !== 'undefined' && NepaliLocale.todayBs()) || null;
  const p2 = n => String(n).padStart(2, '0');
  const bsDate = tb ? `${tb.year}/${p2(tb.month)}/${p2(tb.day)}` : '';
  const place = (address || '').split(',').map(s => s.trim())
    .filter(s => s && !/nepal/i.test(s)).pop() || 'Chitwan';

  const v = f => Y.map(f);
  const withAud = (aud, arr) => incAud ? [aud, ...arr] : arr;
  const yearCols = h1 => Y.map(yr => ({ h1: h1(yr.year), h2: `Year ${yr.year}` }));
  const audCol = { h1: `F.Y. ${pjFyLabel(0)}`, h2: stmtType };

  const zeroRow = vals => (vals || []).every(x => x == null || x === '' ||
    (typeof x === 'number' && Math.round(x) === 0) ||
    (typeof x === 'object' && x.n != null && Math.round(x.n) === 0));
  const prune = rows => rows.filter(r => !r.zeroable || r.keep || !zeroRow(r.vals));
  // After pruning, re-letter/renumber ordinals so removed rows leave no gaps.
  const renumber = rows => {
    let num = 0, letter = 0;
    rows.forEach(r => {
      const l = r.label || '';
      if (/^(sources|uses) of funds/i.test(l) || /^[A-C]\.\s/.test(l)) { num = 0; letter = 0; return; }
      if (/^\d+\.\s/.test(l)) { num++; letter = 0; r.label = l.replace(/^\d+\./, `${num}.`); return; }
      if (/^[a-z]\.\s/.test(l)) { letter++; r.label = l.replace(/^[a-z]\./, `${String.fromCharCode(96 + letter)}.`); }
    });
    return rows;
  };

  // Audited/Provisional comparison figures
  const termSum = m.loans.term.reduce((s, l) => s + l.amount, 0);
  const audAdminLine = i => i === 0 ? m.salary : ((m.otherExpenses[i - 1] || {}).amount ?? null);
  const audAdminTotal = m.salary + m.otherExpenses.reduce((s, e) => s + e.amount, 0);
  const audGP = m.revenue.operations - m.materials.total;
  const audNCA = m.currentAssetsTotal - m.currentLiabilitiesTotal;

  const sections = [];

  // ── Balance Sheet ──
  sections.push({
    key: 'BS', title: 'Projected Balance Sheet', sheet: 'Balance Sheet', sig: true, aud: incAud,
    cols: withAud(audCol, yearCols(y => pjAsAt(y))),
    rows: renumber(prune([
      { k: 'srcLabel', label: PJX_BS_L.srcLabel, vals: [], kind: 'sec' },
      { k: 'capLabel', label: PJX_BS_L.capLabel, vals: [], kind: 'sec' },
      { k: 'cap', label: T.capRow, vals: withAud(m.shareCapital, v(x => x.bs.shareCapital)), kind: 'item' },
      { k: 'addl', label: T.addlRow, vals: withAud(null, v(x => x.bs.additionalCapital)), kind: 'item', zeroable: true },
      { k: 'reserve', label: PJX_BS_L.reserve, vals: withAud(m.reserves, v(x => x.bs.reserves)), kind: 'item' },
      { k: 'lt', label: PJX_BS_L.lt, vals: withAud(termSum, v(x => x.bs.longTermLoan)), kind: 'plain', zeroable: true },
      { k: 'pwc', label: PJX_BS_L.pwc, vals: withAud(null, v(x => x.bs.permanentWC)), kind: 'plain', zeroable: true },
      { k: 'lend', label: T.lendRow, vals: withAud(m.loans.directorLoan, v(x => x.bs.directorLending)), kind: 'plain', zeroable: true },
      { k: 'totalSrc', label: PJX_BS_L.totalSrc, kind: 'grand',
        vals: withAud(m.shareCapital + m.reserves + termSum + m.loans.directorLoan, v(x => x.bs.totalSources)),
        xsum: ['cap', 'addl', 'reserve', 'lt', 'pwc', 'lend'] },
      { k: 'usesLabel', label: PJX_BS_L.usesLabel, vals: [], kind: 'sec' },
      { k: 'faLabel', label: PJX_BS_L.faLabel, vals: [], kind: 'sec' },
      { k: 'wdv', label: PJX_BS_L.wdv, vals: withAud(null, v(x => x.dep.total)), kind: 'item', zeroable: true, keep: true },
      { k: 'depRow', label: PJX_BS_L.depRow, vals: withAud(null, v(x => x.dep.dep)), kind: 'item', zeroable: true, keep: true },
      { k: 'faTotal', label: PJX_BS_L.faTotal, vals: withAud(m.ppeTotal, v(x => x.bs.fixedAssetsNet)), kind: 'tot',
        xexpr: (R, c) => `${c}${R.wdv}-${c}${R.depRow}` },
      { k: 'caLabel', label: PJX_BS_L.caLabel, vals: [], kind: 'sec' },
      { k: 'cash', label: PJX_BS_L.cash, vals: withAud(m.cash, v(x => x.bs.cash)), kind: 'item' },
      { k: 'debtors', label: PJX_BS_L.debtors, vals: withAud(m.debtors, v(x => x.bs.debtors)), kind: 'item' },
      { k: 'stock', label: PJX_BS_L.stock, vals: withAud(m.inventory.closing, v(x => x.bs.closingStock)), kind: 'item', zeroable: true },
      { k: 'caTotal', label: PJX_BS_L.caTotal, vals: withAud(m.currentAssetsTotal, v(x => x.bs.totalCurrentAssets)), kind: 'tot',
        xsum: ['cash', 'debtors', 'stock'] },
      { k: 'clLabel', label: PJX_BS_L.clLabel, vals: [], kind: 'sec' },
      { k: 'creditors', label: PJX_BS_L.creditors, vals: withAud(m.creditors, v(x => x.bs.creditors)), kind: 'item', zeroable: true },
      { k: 'provTax', label: PJX_BS_L.provTax, vals: withAud(m.tax, v(x => x.bs.provisionTax)), kind: 'item', zeroable: true },
      { k: 'expPay', label: PJX_BS_L.expPay, vals: withAud(null, v(x => x.bs.expPayable)), kind: 'item', zeroable: true },
      { k: 'tds', label: PJX_BS_L.tds, vals: withAud(null, v(x => x.bs.tdsPayable)), kind: 'item', zeroable: true },
      { k: 'stl', label: PJX_BS_L.stl, vals: withAud(m.loans.overdraft, v(x => x.bs.shortTermLoan)), kind: 'item', zeroable: true },
      { k: 'clTotal', label: PJX_BS_L.clTotal, vals: withAud(m.currentLiabilitiesTotal, v(x => x.bs.totalCurrentLiabilities)), kind: 'tot',
        xsum: ['creditors', 'provTax', 'expPay', 'tds', 'stl'] },
      { k: 'nca', label: PJX_BS_L.nca, vals: withAud(audNCA, v(x => x.bs.netCurrentAssets)), kind: 'tot',
        xexpr: (R, c) => `${c}${R.caTotal}-${c}${R.clTotal}` },
      { k: 'totalUses', label: PJX_BS_L.totalUses, vals: withAud(m.ppeTotal + audNCA, v(x => x.bs.totalUses)), kind: 'grand',
        xexpr: (R, c) => `${c}${R.faTotal}+${c}${R.caTotal}-${c}${R.clTotal}` },
    ])),
  });

  // ── Profit & Loss ──
  sections.push({
    key: 'PL', title: 'Projected Profit & Loss A/C', sheet: 'Profit & Loss', sig: true, aud: incAud,
    cols: withAud(audCol, yearCols(y => pjFyDot(y))),
    rows: prune([
      { k: 'sales', label: PJX_PL_L.sales, vals: withAud(m.revenue.operations, v(x => x.pl.sales)), kind: 'plain', bold: true },
      { k: 'cogsHead', label: PJX_PL_L.cogsHead, vals: [], kind: 'sec' },
      { k: 'opening', label: PJX_PL_L.opening, vals: withAud(m.materials.opening, v(x => x.pl.openingStock)), kind: 'item', zeroable: true },
      { k: 'purchase', label: PJX_PL_L.purchase, vals: withAud(m.materials.purchases, v(x => x.pl.purchases)), kind: 'item', zeroable: true },
      { k: 'direct', label: PJX_PL_L.direct, vals: withAud(m.materials.directCost, v(x => x.pl.directCost)), kind: 'item', zeroable: true },
      { k: 'closing', label: PJX_PL_L.closing, vals: withAud(-m.materials.closing, v(x => -x.pl.closingStock)), kind: 'item', zeroable: true },
      { k: 'cogsTotal', label: PJX_PL_L.cogsTotal, vals: withAud(m.materials.total, v(x => x.pl.cogs)), kind: 'tot',
        xsum: ['opening', 'purchase', 'direct', 'closing'] },
      { k: 'gp', label: PJX_PL_L.gp, vals: withAud(audGP, v(x => x.pl.grossProfit)), kind: 'grand',
        xexpr: (R, c) => `${c}${R.sales}-${c}${R.cogsTotal}` },
      { k: 'adminHead', label: PJX_PL_L.adminHead, vals: [], kind: 'sec' },
      ...Y[0].pl.adminLines.map((l, i) => (
        { k: 'adm' + i, label: l.name, vals: withAud(audAdminLine(i), v(x => x.pl.adminLines[i].amount)), kind: 'item', zeroable: true }
      )),
      { k: 'adminTotal', label: PJX_PL_L.adminTotal, vals: withAud(audAdminTotal, v(x => x.pl.adminTotal)), kind: 'tot',
        xsum: Y[0].pl.adminLines.map((_, i) => 'adm' + i) },
      { k: 'pbid', label: PJX_PL_L.pbid, vals: withAud(audGP - audAdminTotal, v(x => x.pl.grossProfit - x.pl.adminTotal)), kind: 'tot',
        xexpr: (R, c) => `${c}${R.gp}-${c}${R.adminTotal}` },
      { k: 'intST', label: PJX_PL_L.intST, vals: withAud(m.financeCost, v(x => x.pl.interestST)), kind: 'plain', zeroable: true },
      { k: 'intLT', label: PJX_PL_L.intLT, vals: withAud(null, v(x => x.pl.interestLT)), kind: 'plain', zeroable: true },
      { k: 'dep', label: PJX_PL_L.dep, vals: withAud(null, v(x => x.pl.dep)), kind: 'plain', zeroable: true, keep: true },
      { k: 'pbt', label: PJX_PL_L.pbt, vals: withAud(m.profitBeforeTax, v(x => x.pl.pbt)), kind: 'grand',
        xexpr: (R, c) => `${c}${R.pbid}-` + ['intST', 'intLT', 'dep'].filter(k => R[k]).map(k => `${c}${R[k]}`).join('-') },
      { k: 'tax', label: PJX_PL_L.tax, vals: withAud(m.tax, v(x => x.pl.tax)), kind: 'plain', zeroable: true },
      { k: 'pat', label: PJX_PL_L.pat, vals: withAud(m.profitBeforeTax - m.tax, v(x => x.pl.pat)), kind: 'tot',
        xexpr: (R, c) => R.tax ? `${c}${R.pbt}-${c}${R.tax}` : `${c}${R.pbt}` },
      { k: 'upto', label: PJX_PL_L.upto, vals: withAud(null, v(x => x.pl.retainedOpening)), kind: 'plain', zeroable: true },
      { k: 'div', label: PJX_PL_L.div, vals: withAud(null, v(x => x.pl.dividend)), kind: 'plain', zeroable: true, keep: true },
      { k: 'transfer', label: PJX_PL_L.transfer, vals: withAud(m.reserves, v(x => x.pl.retainedClosing)), kind: 'grand',
        xexpr: (R, c) => `${c}${R.pat}` + (R.upto ? `+${c}${R.upto}` : '') + (R.div ? `-${c}${R.div}` : '') },
    ]),
  });

  // ── Cash Flow (projection-only — a single audited year has no deltas) ──
  sections.push({
    key: 'CF', title: 'Projected Cash Flow Statements', sheet: 'Cash Flow', sig: true,
    cols: yearCols(y => pjFyDot(y)),
    rows: renumber(prune([
      { k: 'aLabel', label: PJX_CF_L.aLabel, vals: [], kind: 'sec' },
      { k: 'npbit', label: PJX_CF_L.npbit, vals: v(x => x.cf.pbtPlusInterest), kind: 'item' },
      { k: 'cfdep', label: PJX_CF_L.dep, vals: v(x => x.cf.depreciation), kind: 'item', zeroable: true, keep: true },
      { k: 'cftax', label: PJX_CF_L.tax, vals: v(x => x.cf.incomeTax), kind: 'item' },
      { k: 'opSub', label: PJX_CF_L.opSub, vals: v(x => x.cf.pbtPlusInterest + x.cf.depreciation + x.cf.incomeTax), kind: 'tot',
        xsum: ['npbit', 'cfdep', 'cftax'] },
      { k: 'dCA', label: PJX_CF_L.dCA, vals: v(x => x.cf.deltaCurrentAssets), kind: 'item' },
      { k: 'dCL', label: PJX_CF_L.dCL, vals: v(x => x.cf.deltaCurrentLiabilities), kind: 'item' },
      { k: 'wcSub', label: PJX_CF_L.wcSub, vals: v(x => x.cf.deltaCurrentAssets + x.cf.deltaCurrentLiabilities), kind: 'tot',
        xsum: ['dCA', 'dCL'] },
      { k: 'netOp', label: PJX_CF_L.netOp, vals: v(x => x.cf.operating), kind: 'grand',
        xexpr: (R, c) => `${c}${R.opSub}+${c}${R.wcSub}` },
      { k: 'bLabel', label: PJX_CF_L.bLabel, vals: [], kind: 'sec' },
      { k: 'capex', label: PJX_CF_L.capex, vals: v(x => x.cf.capex), kind: 'item', zeroable: true },
      { k: 'liqNC', label: PJX_CF_L.liqNC, vals: v(x => x.cf.liquidatedNC), kind: 'item', zeroable: true },
      { k: 'netInv', label: PJX_CF_L.netInv, vals: v(x => x.cf.investing), kind: 'grand', xsum: ['capex', 'liqNC'] },
      { k: 'cLabel', label: PJX_CF_L.cLabel, vals: [], kind: 'sec' },
      { k: 'issue', label: PJX_CF_L.issue, vals: v(x => x.cf.capitalIssued), kind: 'item', zeroable: true },
      { k: 'cfdiv', label: PJX_CF_L.div, vals: v(x => x.cf.dividend), kind: 'item', zeroable: true },
      { k: 'intPaid', label: PJX_CF_L.intPaid, vals: v(x => x.cf.interestPaid), kind: 'item', zeroable: true },
      { k: 'dDir', label: T.dDirRow, vals: v(x => x.cf.deltaDirector), kind: 'item', zeroable: true },
      { k: 'dLoans', label: PJX_CF_L.dLoans, vals: v(x => x.cf.deltaLoans), kind: 'item', zeroable: true },
      { k: 'netFin', label: PJX_CF_L.netFin, vals: v(x => x.cf.financing), kind: 'grand',
        xsum: ['issue', 'cfdiv', 'intPaid', 'dDir', 'dLoans'] },
      { k: 'netChange', label: PJX_CF_L.netChange, vals: v(x => x.cf.netChange), kind: 'tot',
        xexpr: (R, c) => `${c}${R.netOp}+${c}${R.netInv}+${c}${R.netFin}` },
      { k: 'openCash', label: PJX_CF_L.openCash, vals: v(x => x.cf.openingCash), kind: 'plain' },
      { k: 'closeCash', label: PJX_CF_L.closeCash, vals: v(x => x.cf.closingCash), kind: 'grand',
        xexpr: (R, c) => `${c}${R.netChange}+${c}${R.openCash}` },
    ])),
  });

  // ── Depreciation — only asset classes carrying value anywhere appear ──
  const depActive = Y[0].dep.rows.map((_, i) => Y.some(yr => {
    const r = yr.dep.rows[i];
    return Math.abs(r.opening) + Math.abs(r.addition) + Math.abs(r.disposal) + Math.abs(r.total) + Math.abs(r.closing) > 0.005;
  }));
  const depRows = [];
  Y.forEach(yr => {
    const keys = [];
    depRows.push({ k: `dh${yr.year}`, label: `Depreciation Details for the fiscal year ${pjFyDot(yr.year)}`, vals: [], kind: 'span', group: true });
    yr.dep.rows.forEach((r, i) => {
      if (!depActive[i]) return;
      const k = `d${yr.year}_${i}`;
      keys.push(k);
      depRows.push({ k, label: r.name, kind: 'item',
        vals: [r.opening, r.addition, r.disposal, r.total,
               { t: `${+(r.rate * 100).toFixed(2)}%`, n: r.rate, fmt: '0.00%' }, r.dep, r.closing] });
    });
    depRows.push({ k: `dt${yr.year}`, label: 'Total', kind: 'tot',
      vals: [yr.dep.opening, yr.dep.addition, yr.dep.disposal, yr.dep.total, '', yr.dep.dep, yr.dep.closing],
      xsum: keys, xskip: [4] });   // skip the rate column when summing
  });
  sections.push({
    key: 'DEP', title: 'Depreciation Schedule', sheet: 'Depreciation', sig: true, multiPage: true, labelW: 200,
    cols: PJX_DEP_COLS.map(h => ({ h1: h })),
    rows: depRows,
  });

  // ── IRD summary (English labels — standard PDF fonts can't render Devanagari) ──
  const ird = pjResult.ird;
  sections.push({
    key: 'IRD', title: 'IRD Summary', sheet: 'IRD', labelW: 420,
    cols: [{ h1: `F.Y. ${pjFyLabel(0)}`, h2: stmtType }, { h1: `F.Y. ${pjFyLabel(1)}`, h2: 'Projected' }],
    rows: PJX_IRD_ROWS.map((r, i) => (
      { k: 'ird' + i, label: `${i + 1}.  ${r.en}`, vals: [ird.audited[r.key], ird.projected[r.key]], kind: 'plain' }
    )),
  });

  // ── NCA working & Ratio Analysis ──
  const L = ProjectionEngine.LIMITS;
  const tone = ok => ok ? 'pass' : 'fail';
  sections.push({
    key: 'NCA', title: 'Net Current Assets Working & Ratio Analysis', sheet: 'Ratio Analysis',
    cols: yearCols(y => pjFyDot(y)),
    rows: [
      { k: 'nStock', label: 'A.  Stock', vals: v(x => x.bs.closingStock), kind: 'item' },
      { k: 'nDebt', label: 'B.  Debtor', vals: v(x => x.bs.debtors), kind: 'item' },
      { k: 'nTot', label: 'C = A+B   Total', vals: v(x => x.bs.closingStock + x.bs.debtors), kind: 'tot', xsum: ['nStock', 'nDebt'] },
      { k: 'nCL', label: 'D.  Current Liabilities except Short Term Loan', vals: v(x => x.bs.totalCurrentLiabilities - x.bs.shortTermLoan), kind: 'item' },
      { k: 'nNCA', label: 'E = C-D   Net Current Assets', vals: v(x => x.ratios.nca), kind: 'tot',
        xexpr: (R, c) => `${c}${R.nTot}-${c}${R.nCL}` },
      { k: 'n70', label: 'F = 70% × E', vals: v(x => x.ratios.nca70), kind: 'item',
        xexpr: (R, c) => `${c}${R.nNCA}*0.7` },
      { k: 'nSTL', label: 'Short Term Loan /OD/CC', vals: v(x => x.bs.shortTermLoan), kind: 'item' },
      { k: 'nPWC', label: 'Permanent WC', vals: v(x => x.bs.permanentWC), kind: 'item' },
      { k: 'nLoan', label: 'G.  Total Loan', vals: v(x => x.bs.shortTermLoan + x.bs.permanentWC), kind: 'tot', xsum: ['nSTL', 'nPWC'] },
      { k: 'nDiff', label: 'H = F-G   Difference (always positive)', kind: 'grand',
        vals: v(x => ({ t: null, n: x.ratios.ncaHeadroom, tone: tone(x.ratios.ncaHeadroom >= 0) })),
        xexpr: (R, c) => `${c}${R.n70}-${c}${R.nLoan}` },
      { k: 'ratioHead', label: 'Ratio Analysis', vals: [], kind: 'sec' },
      { k: 'rDays', label: `Debtor Turnover (days) — between ${L.minDebtorDays} and ${L.maxDebtorDays} days`, kind: 'plain',
        vals: v(x => { const d = Math.round(x.ratios.debtorDays);
          return { t: x.ratios.debtorDays.toFixed(0), n: x.ratios.debtorDays, fmt: '0', tone: tone(d >= L.minDebtorDays && d <= L.maxDebtorDays) }; }) },
      { k: 'rCur', label: `Current Ratio — always more than ${L.minCurrentRatio}`, kind: 'plain',
        vals: v(x => ({ t: x.ratios.currentRatio.toFixed(2), n: x.ratios.currentRatio, fmt: '0.00', tone: tone(x.ratios.currentRatio >= L.minCurrentRatio) })) },
      { k: 'rDE', label: `Debt-Equity Ratio — always less than ${L.maxDebtEquity}`, kind: 'plain',
        vals: v(x => ({ t: x.ratios.debtEquity.toFixed(2), n: x.ratios.debtEquity, fmt: '0.00', tone: tone(x.ratios.debtEquity <= L.maxDebtEquity) })) },
      { k: 'rGPM', label: 'Gross Profit Margin', kind: 'plain',
        vals: v(x => ({ t: `${(x.pl.grossProfit / x.pl.sales * 100).toFixed(2)}%`, n: x.pl.grossProfit / x.pl.sales, fmt: '0.00%' })) },
      { k: 'rNPM', label: 'Net Profit Margin', kind: 'plain',
        vals: v(x => ({ t: `${(x.pl.pat / x.pl.sales * 100).toFixed(2)}%`, n: x.pl.pat / x.pl.sales, fmt: '0.00%' })) },
    ],
  });

  const fyText = N === 1 ? `For the Fiscal Year ${pjFyLabel(1)}`
    : `For the Fiscal Years ${pjFyLabel(1)} to ${pjFyLabel(N)}`;

  return { meta: { company, address, T, incAud, stmtType, bsDate, place, N, fyText }, sections };
}

// Display text for a cell value (shared by both writers).
function pjxCellText(x) {
  if (x == null || x === '') return '';
  if (typeof x === 'number') return pjxAmt(x);
  if (typeof x === 'object') return x.t != null ? x.t : pjxAmt(x.n);
  return String(x);
}
function pjxAmt(v) {
  if (v == null || isNaN(v) || Math.round(v) === 0) return '–';
  return v < 0 ? `(${Math.abs(Math.round(v)).toLocaleString('en-IN')})` : Math.round(v).toLocaleString('en-IN');
}

// ── PDF ────────────────────────────────────────────────────────────
//  Bank-submission report: cover page, then one statement per page in the
//  order BS · P&L · CF · Dep · IRD · Ratio Analysis, rendered from
//  pjxBuildReport(). Each statement auto-scales to fit its own page; only
//  the Depreciation schedule may span pages (whole year-blocks, never split).

const PJX_PDF = {
  W: 842, H: 595, mX: 36, mB: 40,
  navy:      [0.043, 0.122, 0.239],
  muted:     [0.392, 0.455, 0.545],
  black:     [0.1, 0.12, 0.16],
  bandText:  [1, 1, 1],
  gridLight: [0.78, 0.82, 0.87],
  gridDark:  [0.52, 0.58, 0.66],
  totalFill: [0.92, 0.94, 0.965],
  grandFill: [0.845, 0.885, 0.93],
  pass:      [0.1, 0.5, 0.24],
  fail:      [0.75, 0.16, 0.16],
};

async function pjBuildPdfBytes() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const times = await doc.embedFont(PDFLib.StandardFonts.TimesRoman);
  const timesB = await doc.embedFont(PDFLib.StandardFonts.TimesRomanBold);
  const C = {};
  Object.entries(PJX_PDF).forEach(([k, val]) => { if (Array.isArray(val)) C[k] = PDFLib.rgb(val[0], val[1], val[2]); });
  const { W, H, mX, mB } = PJX_PDF;

  const { meta, sections } = pjxBuildReport();
  const { company, address, T, bsDate, place, N, fyText } = meta;

  // ── Cover page ──
  {
    const pg = doc.addPage([W, H]);
    const cx = W / 2;
    pg.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderWidth: 1.6, borderColor: C.navy });
    pg.drawRectangle({ x: 30, y: 30, width: W - 60, height: H - 60, borderWidth: 0.6, borderColor: C.gridDark });
    const ctr = (t, y, size, f, color) => { const tw = f.widthOfTextAtSize(t, size); pg.drawText(t, { x: cx - tw / 2, y, size, font: f, color }); };
    ctr('PROJECTED FINANCIAL REPORT', 468, 30, timesB, C.navy);
    pg.drawLine({ start: { x: cx - 150, y: 455 }, end: { x: cx + 150, y: 455 }, thickness: 1.1, color: C.navy });
    ctr('OF', 430, 11, times, C.muted);
    ctr(company.toUpperCase(), 396, 20, timesB, C.black);
    if (address) ctr(address, 374, 11, font, C.muted);
    // Three vertical rules of differing heights, centre tallest.
    const baseY = 250, heights = [58, 84, 58], gap = 22;
    [cx - gap, cx, cx + gap].forEach((x, i) =>
      pg.drawLine({ start: { x, y: baseY }, end: { x, y: baseY + heights[i] }, thickness: 1.4, color: C.navy }));
    ctr(fyText, 196, 13.5, bold, C.black);
    ctr(`(${N}-Year Financial Projection)`, 177, 10.5, font, C.muted);
    if (bsDate) ctr(`Date of Report : ${bsDate} B.S.`, 84, 10.5, font, C.black);
  }

  const S = {
    sec:   { bold: true, labelColor: C.navy, pre: 3 },
    item:  { indent: true, grid: true },
    plain: { grid: true },
    tot:   { bold: true, fill: C.totalFill, top: true },
    grand: { bold: true, fill: C.grandFill, top: true, dbl: true, gap: 4.5 },
    span:  { span: true, pre: 6 },
  };

  const drawSheet = ({ title, cols, rows, sig, multiPage, labelW: lwOpt }) => {
    const usable = W - 2 * mX;
    const nC = cols.length;
    const labelW = lwOpt || Math.max(180, Math.min(270, usable - nC * 112));
    const colW = Math.min(112, (usable - labelW) / nC);
    const tableW = labelW + colW * nC;
    const x0 = (W - tableW) / 2;
    let nfs = colW >= 95 ? 9 : colW >= 78 ? 8.4 : colW >= 62 ? 7.8 : colW >= 52 ? 7.1 : colW >= 45 ? 6.6 : 6.1;
    const twoLine = cols.some(c => c.h2);
    const bandH = twoLine ? 27 : 17;
    const sigSpace = sig ? 68 : 14;
    const headerH = 63 + (address ? 12 : 0) + bandH;
    const avail = H - headerH - mB - sigSpace;
    const stOf = r => Object.assign({}, S[r.kind] || S.plain, r.bold ? { bold: true } : null);
    let rowH = Math.max(12, nfs * 1.52);
    if (!multiPage) {
      const extras = rows.reduce((s, r) => { const st = stOf(r); return s + (st.pre || 0) + (st.gap || 0); }, 0);
      const fit = (avail - extras) / Math.max(1, rows.length);
      if (fit < rowH) { rowH = Math.max(9.2, fit); nfs = Math.min(nfs, Math.max(5.9, rowH / 1.45)); }
    }
    const lfs = Math.min(9.4, nfs + 0.6);
    let page = null, yTop = 0, bandTop = 0, banners = [];

    const closeGrid = () => {
      if (!page) return;
      const stops = [...banners].sort((a, b) => b.top - a.top);
      for (let i = 0; i <= nC; i++) {
        const x = x0 + labelW + colW * i;
        let from = bandTop - bandH;
        stops.forEach(bn => {
          if (bn.top < from) page.drawLine({ start: { x, y: from }, end: { x, y: bn.top }, thickness: 0.5, color: C.gridLight });
          from = Math.min(from, bn.bot);
        });
        if (from > yTop) page.drawLine({ start: { x, y: from }, end: { x, y: yTop }, thickness: 0.5, color: C.gridLight });
      }
      page.drawRectangle({ x: x0, y: yTop, width: tableW, height: bandTop - yTop, borderWidth: 0.9, borderColor: C.navy });
    };
    const openPage = cont => {
      if (page) closeGrid();
      page = doc.addPage([W, H]);
      banners = [];
      let hy = H - 38;
      const ctr = (t, size, f, color) => { const tw = f.widthOfTextAtSize(t, size); page.drawText(t, { x: (W - tw) / 2, y: hy, size, font: f, color }); };
      ctr(company, 13, bold, C.navy); hy -= 14;
      if (address) { ctr(address, 9, font, C.muted); hy -= 12; }
      ctr(title + (cont ? ' (contd.)' : ''), 10.8, bold, C.black); hy -= 16;
      bandTop = hy + 5;
      page.drawRectangle({ x: x0, y: bandTop - bandH, width: tableW, height: bandH, color: C.navy });
      page.drawText('Particulars', { x: x0 + 6, y: bandTop - bandH / 2 - lfs / 2 + 1.5, size: lfs, font: bold, color: C.bandText });
      cols.forEach((cl, i) => {
        const right = x0 + labelW + colW * (i + 1) - 6;
        const y1 = twoLine ? bandTop - 11.5 : bandTop - bandH / 2 - nfs / 2 + 1.5;
        const w1 = bold.widthOfTextAtSize(cl.h1, nfs);
        page.drawText(cl.h1, { x: right - w1, y: y1, size: nfs, font: bold, color: C.bandText });
        if (cl.h2) {
          const w2 = font.widthOfTextAtSize(cl.h2, nfs - 0.8);
          page.drawText(cl.h2, { x: right - w2, y: bandTop - 22, size: nfs - 0.8, font, color: C.bandText });
        }
      });
      yTop = bandTop - bandH;
    };
    const drawRow = r => {
      const st = stOf(r);
      if (st.pre && yTop < bandTop - bandH) yTop -= st.pre;
      if (!page || yTop - rowH < mB + sigSpace) openPage(!!page);
      const f = st.bold ? bold : font;
      if (st.fill) page.drawRectangle({ x: x0, y: yTop - rowH, width: tableW, height: rowH, color: st.fill });
      if (st.top) page.drawLine({ start: { x: x0, y: yTop }, end: { x: x0 + tableW, y: yTop }, thickness: 0.6, color: C.gridDark });
      const bl = yTop - rowH + (rowH - nfs) * 0.5 + 1;
      if (st.span) {
        banners.push({ top: yTop, bot: yTop - rowH });
        const tw = bold.widthOfTextAtSize(r.label, lfs);
        page.drawText(r.label, { x: x0 + (tableW - tw) / 2, y: bl, size: lfs, font: bold, color: C.navy });
      } else if (r.label) {
        let ls = lfs;
        const maxW = labelW - 10 - (st.indent ? 10 : 0);
        while (ls > 5.4 && f.widthOfTextAtSize(r.label, ls) > maxW) ls -= 0.2;
        page.drawText(r.label, { x: x0 + 5 + (st.indent ? 10 : 0), y: bl, size: ls, font: f, color: st.labelColor || C.black });
      }
      (r.vals || []).forEach((x, i) => {
        const t = pjxCellText(x);
        if (!t) return;
        const col = (typeof x === 'object' && x.tone) ? (x.tone === 'pass' ? C.pass : C.fail) : C.black;
        const cw = f.widthOfTextAtSize(t, nfs);
        page.drawText(t, { x: x0 + labelW + colW * (i + 1) - 6 - cw, y: bl, size: nfs, font: f, color: col });
      });
      if (st.grid) page.drawLine({ start: { x: x0, y: yTop - rowH }, end: { x: x0 + tableW, y: yTop - rowH }, thickness: 0.4, color: C.gridLight });
      // Double rule sits BELOW the row's bottom edge so it never crosses the figures.
      if (st.dbl) [1.2, 2.7].forEach(off =>
        page.drawLine({ start: { x: x0 + labelW, y: yTop - rowH - off }, end: { x: x0 + tableW, y: yTop - rowH - off }, thickness: 0.5, color: C.navy }));
      yTop -= rowH + (st.gap || 0);
    };
    const sigBlock = () => {
      const dash = { thickness: 0.7, color: C.black, dashArray: [2, 2] };
      const lineY = mB + 42, roleY = mB + 30, dateY = mB + 14, placeY = mB + 2;
      page.drawLine({ start: { x: x0, y: lineY }, end: { x: x0 + 140, y: lineY }, ...dash });
      page.drawText('Accountant', { x: x0, y: roleY, size: 9, font, color: C.black });
      page.drawText(`Date : ${bsDate} B.S.`, { x: x0, y: dateY, size: 8.5, font, color: C.black });
      page.drawText(`Place : ${place}`, { x: x0, y: placeY, size: 8.5, font, color: C.black });
      page.drawLine({ start: { x: x0 + tableW - 140, y: lineY }, end: { x: x0 + tableW, y: lineY }, ...dash });
      const dw = font.widthOfTextAtSize(T.person, 9);
      page.drawText(T.person, { x: x0 + tableW - dw, y: roleY, size: 9, font, color: C.black });
    };

    openPage(false);
    rows.forEach((r, i) => {
      if (multiPage && r.group && yTop < bandTop - bandH) {
        let gh = rowH + (stOf(r).pre || 0);
        for (let j = i + 1; j < rows.length && !rows[j].group; j++) {
          const stj = stOf(rows[j]);
          gh += rowH + (stj.pre || 0) + (stj.gap || 0);
        }
        if (yTop - gh < mB + sigSpace) openPage(true);
      }
      drawRow(r);
    });
    closeGrid();
    if (sig) sigBlock();
  };

  sections.forEach(drawSheet);
  return { bytes: await doc.save(), company };
}

async function pjDownloadPdf() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building PDF…', 'searching');
    const { bytes, company } = await pjBuildPdfBytes();
    DocumentEngine.downloadBlob(new Blob([bytes], { type: 'application/pdf' }),
      `Projection Report ${company} ${pjFyLabel(1)}.pdf`,
      { eventType: 'projection_pdf_downloaded', module: 'projection', clientName: company });
    pjStatus('PDF downloaded.', 'success');
  } catch (e) {
    console.error(e);
    pjStatus('PDF generation failed: ' + escHtml(e.message), 'error');
  }
}

// In-app preview — renders the very same bytes the download produces into a
// modal iframe, so what you check is exactly what you send.
let pjPreviewUrl = null;

async function pjPreviewPdf() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building preview…', 'searching');
    const { bytes } = await pjBuildPdfBytes();
    if (pjPreviewUrl) URL.revokeObjectURL(pjPreviewUrl);
    pjPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    pjEl('pj-preview-frame').src = pjPreviewUrl;
    pjEl('pj-preview-modal').classList.add('open');
    pjStatus('Preview ready.', 'success');
  } catch (e) {
    console.error(e);
    pjStatus('Preview failed: ' + escHtml(e.message), 'error');
  }
}

function pjClosePreview() {
  pjEl('pj-preview-modal').classList.remove('open');
  pjEl('pj-preview-frame').src = 'about:blank';
  if (pjPreviewUrl) { URL.revokeObjectURL(pjPreviewUrl); pjPreviewUrl = null; }
}

// ── Excel ──────────────────────────────────────────────────────────
//  The same report, sheet-for-sheet: a Cover sheet then one sheet per PDF
//  section in the same order, with the same columns, labels, pruning and
//  totals. Total rows carry live formulas resolved against the written row
//  numbers (so pruning can never mis-reference), with the computed value as
//  the cached result. A Validation sheet is appended whenever the review
//  flagged anything, so a flagged projection can still be exported and
//  corrected in Excel.

async function pjDownloadExcel() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building Excel workbook…', 'searching');
    const wb = new ExcelJS.Workbook();
    const { meta, sections } = pjxBuildReport();
    const { company, address, T, bsDate, place, N, fyText } = meta;

    const NAVY = 'FF0B1F3D', BAND_TXT = 'FFFFFFFF';
    const TOT_FILL = 'FFEBEFF6', GRAND_FILL = 'FFD8E2ED';
    const PASS = 'FF1A8040', FAIL = 'FFBF2929';
    const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const thin = { style: 'thin', color: { argb: 'FFC7CEDB' } };

    // ── Cover sheet ──
    {
      const cv = wb.addWorksheet('Cover');
      cv.getColumn(1).width = 4;
      for (let c = 2; c <= 8; c++) cv.getColumn(c).width = 14;
      const put = (row, text, opts = {}) => {
        cv.mergeCells(row, 2, row, 8);
        const c = cv.getCell(row, 2);
        c.value = text;
        c.font = { name: opts.serif ? 'Times New Roman' : 'Calibri', size: opts.size || 11, bold: !!opts.bold,
                   color: { argb: opts.color || 'FF1A1E29' } };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        cv.getRow(row).height = opts.height || 18;
      };
      put(4, 'PROJECTED FINANCIAL REPORT', { serif: true, bold: true, size: 26, color: NAVY, height: 40 });
      put(6, 'OF', { size: 10, color: 'FF64748B' });
      put(8, company.toUpperCase(), { serif: true, bold: true, size: 17, height: 26 });
      if (address) put(9, address, { size: 10, color: 'FF64748B' });
      put(13, fyText, { bold: true, size: 12 });
      put(14, `(${N}-Year Financial Projection)`, { size: 10, color: 'FF64748B' });
      if (bsDate) put(18, `Date of Report : ${bsDate} B.S.`, { size: 10 });
      // frame
      for (let r = 2; r <= 20; r++) {
        for (let c = 2; c <= 8; c++) {
          const cell = cv.getCell(r, c);
          const b = {};
          if (r === 2) b.top = { style: 'medium', color: { argb: NAVY } };
          if (r === 20) b.bottom = { style: 'medium', color: { argb: NAVY } };
          if (c === 2) b.left = { style: 'medium', color: { argb: NAVY } };
          if (c === 8) b.right = { style: 'medium', color: { argb: NAVY } };
          if (Object.keys(b).length) cell.border = Object.assign(cell.border || {}, b);
        }
      }
    }

    // ── One worksheet per section ──
    sections.forEach(sec => {
      const ws = wb.addWorksheet(sec.sheet);
      const nC = sec.cols.length;
      ws.getColumn(1).width = sec.key === 'IRD' ? 58 : 46;
      for (let i = 0; i < nC; i++) ws.getColumn(2 + i).width = 17;
      const colLetter = i => pjxCol(2 + i);
      const twoLine = sec.cols.some(c => c.h2);

      // title block
      const put = (row, text, opts = {}) => {
        ws.mergeCells(row, 1, row, 1 + nC);
        const c = ws.getCell(row, 1);
        c.value = text;
        c.font = { size: opts.size || 11, bold: !!opts.bold, color: { argb: opts.color || 'FF1A1E29' } };
        c.alignment = { horizontal: 'center' };
      };
      put(1, company, { bold: true, size: 13, color: NAVY });
      if (address) put(2, address, { size: 9.5, color: 'FF64748B' });
      put(3, sec.title, { bold: true, size: 11 });

      // header band
      const headRow = 5;
      const bandRows = twoLine ? [headRow, headRow + 1] : [headRow];
      const hc = ws.getCell(headRow, 1);
      hc.value = 'Particulars';
      if (twoLine) ws.mergeCells(headRow, 1, headRow + 1, 1);
      hc.font = { bold: true, color: { argb: BAND_TXT } };
      hc.fill = fill(NAVY);
      hc.alignment = { vertical: 'middle' };
      sec.cols.forEach((cl, i) => {
        const c1 = ws.getCell(headRow, 2 + i);
        c1.value = cl.h1; c1.font = { bold: true, color: { argb: BAND_TXT } };
        c1.fill = fill(NAVY); c1.alignment = { horizontal: 'right' };
        if (twoLine) {
          const c2 = ws.getCell(headRow + 1, 2 + i);
          c2.value = cl.h2 || ''; c2.font = { size: 9, color: { argb: BAND_TXT } };
          c2.fill = fill(NAVY); c2.alignment = { horizontal: 'right' };
        }
      });

      // rows — first pass assigns row numbers so formulas can resolve keys
      const first = bandRows[bandRows.length - 1] + 1;
      const R = {};
      sec.rows.forEach((r, i) => { if (r.k) R[r.k] = first + i; });

      sec.rows.forEach((r, i) => {
        const rowNo = first + i;
        const row = ws.getRow(rowNo);
        const isTot = r.kind === 'tot', isGrand = r.kind === 'grand';
        const isSec = r.kind === 'sec', isSpan = r.kind === 'span';
        const lc = ws.getCell(rowNo, 1);
        lc.value = (r.kind === 'item' ? '    ' : '') + (r.label || '');
        lc.font = { bold: isSec || isSpan || isTot || isGrand || !!r.bold,
                    color: { argb: isSec || isSpan ? NAVY : 'FF1A1E29' } };
        if (isSpan) { ws.mergeCells(rowNo, 1, rowNo, 1 + nC); lc.alignment = { horizontal: 'center' }; }

        if (!isSpan) {
          (r.vals || []).forEach((x, ci) => {
            if (x == null || x === '') return;
            const cell = ws.getCell(rowNo, 2 + ci);
            const c = colLetter(ci);
            const isNum = typeof x === 'number';
            const obj = typeof x === 'object' ? x : null;
            const numFmt = obj && obj.fmt ? obj.fmt : PJX_NUMFMT0;
            // Live formula for total rows, cached result alongside. The
            // Audited/Provisional lead column is excluded: those are the
            // client's actual reported totals, which need not foot from the
            // broken-out lines (audited WDV/TDS/expenses payable aren't
            // itemised in the source statement), so it keeps its own figure.
            let formula = null;
            if (!(r.xskip || []).includes(ci) && !(sec.aud && ci === 0)) {
              if (r.xsum) {
                const terms = r.xsum.filter(k => R[k]).map(k => `${c}${R[k]}`);
                if (terms.length) formula = terms.join('+');
              } else if (r.xexpr) {
                try { formula = r.xexpr(R, c); } catch (e) { formula = null; }
              }
            }
            const raw = isNum ? x : (obj && obj.n != null ? obj.n : null);
            if (formula && raw != null) cell.value = { formula, result: raw };
            else if (raw != null) cell.value = raw;
            else cell.value = obj ? (obj.t || '') : String(x);
            if (raw != null) cell.numFmt = numFmt;
            cell.alignment = { horizontal: 'right' };
            cell.font = { bold: isTot || isGrand || !!r.bold,
                          color: { argb: obj && obj.tone ? (obj.tone === 'pass' ? PASS : FAIL) : 'FF1A1E29' } };
          });
        }

        // banding + rules
        for (let c = 1; c <= 1 + nC; c++) {
          const cell = ws.getCell(rowNo, c);
          if (isTot) cell.fill = fill(TOT_FILL);
          if (isGrand) cell.fill = fill(GRAND_FILL);
          const b = {};
          if (r.kind === 'item' || r.kind === 'plain') b.bottom = thin;
          if (isTot || isGrand) { b.top = { style: 'thin', color: { argb: 'FF8593A6' } }; }
          if (isGrand) b.bottom = { style: 'double', color: { argb: NAVY } };
          if (Object.keys(b).length) cell.border = Object.assign(cell.border || {}, b);
        }
        row.commit && row.commit();
      });

      // signature block
      if (sec.sig) {
        const sr = first + sec.rows.length + 2;
        const dotted = { style: 'dotted', color: { argb: 'FF1A1E29' } };
        ws.getCell(sr, 1).border = { bottom: dotted };
        ws.getCell(sr, 1 + nC).border = { bottom: dotted };
        ws.getCell(sr + 1, 1).value = 'Accountant';
        const rc = ws.getCell(sr + 1, 1 + nC);
        rc.value = T.person; rc.alignment = { horizontal: 'right' };
        ws.getCell(sr + 2, 1).value = `Date : ${bsDate} B.S.`;
        ws.getCell(sr + 3, 1).value = `Place : ${place}`;
      }

      ws.views = [{ state: 'frozen', xSplit: 1, ySplit: bandRows[bandRows.length - 1] }];
    });

    // ── Validation sheet (only when the review flagged something) ──
    if (typeof pjIssues !== 'undefined' && pjIssues.length) {
      const vs = wb.addWorksheet('Validation');
      vs.getColumn(1).width = 10; vs.getColumn(2).width = 8; vs.getColumn(3).width = 120;
      vs.getCell(1, 1).value = 'Validation findings — correct these figures and re-check';
      vs.getCell(1, 1).font = { bold: true, size: 12, color: { argb: NAVY } };
      ['Level', 'Year', 'Message'].forEach((h, i) => {
        const c = vs.getCell(3, i + 1);
        c.value = h; c.font = { bold: true, color: { argb: BAND_TXT } }; c.fill = fill(NAVY);
      });
      pjIssues.forEach((iss, i) => {
        const r = 4 + i;
        vs.getCell(r, 1).value = iss.level === 'error' ? 'ERROR' : 'Warning';
        vs.getCell(r, 1).font = { bold: true, color: { argb: iss.level === 'error' ? FAIL : 'FFA36A00' } };
        vs.getCell(r, 2).value = iss.year != null ? iss.year : '';
        vs.getCell(r, 3).value = iss.msg;
        vs.getCell(r, 3).alignment = { wrapText: true };
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = `Projection Report ${company} ${pjFyLabel(1)}.xlsx`;
    DocumentEngine.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname,
      { eventType: 'projection_excel_downloaded', module: 'projection', clientName: company });
    pjStatus('Excel workbook downloaded — same layout as the PDF, with live formulas on the total rows.', 'success');
  } catch (e) {
    console.error(e);
    pjStatus('Excel generation failed: ' + escHtml(e.message), 'error');
  }
}
