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

const PJX_NUMFMT = '#,##0.00;(#,##0.00);"–"';

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

// ── Excel ──────────────────────────────────────────────────────────

async function pjDownloadExcel() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building Excel workbook…', 'searching');
    const wbOut = new ExcelJS.Workbook();
    const Y = pjResult.years;
    const N = Y.length;
    const company = pjEl('pj-company').value || pjModel.company.name;
    const address = pjModel.company.address;
    const T = pjxTerms((pjEl('pj-org-type') || {}).value);
    const stmtType = (pjEl('pj-statement-type') || {}).value === 'provisional' ? 'Provisional' : 'Audited';
    const bsL = { ...PJX_BS_L, cap: T.capRow, addl: T.addlRow, director: T.lendRow };
    const cfL = { ...PJX_CF_L, dDir: T.dDirRow };

    // Column of year y on Pl/CF (labels in A): B, C, …  On BS/IRD-style
    // sheets (labels in B): C, D, …
    const plCol = y => pjxCol(1 + y);
    const bsCol = y => pjxCol(2 + y);

    // ── Dep sheet first (Pl/BS reference it by address) ──
    const dep = wbOut.addWorksheet('Dep');
    dep.getColumn(1).width = 5; dep.getColumn(2).width = 34;
    for (let c = 3; c <= 9; c++) dep.getColumn(c).width = 15;
    const depTotalRow = y => 13 + 12 * (y - 1);        // master block geometry
    Y.forEach(yr => {
      const y = yr.year;
      const base = 12 * (y - 1);                        // rows shift 12 per block
      if (y === 1) {
        dep.getCell('A1').value = company; dep.mergeCells('A1:I1');
        dep.getCell('A2').value = address; dep.mergeCells('A2:I2');
        [1, 2].forEach(r => { dep.getCell(r, 1).font = { bold: r === 1, size: r === 1 ? 13 : 11 }; dep.getCell(r, 1).alignment = { horizontal: 'center' }; });
      }
      const titleRow = y === 1 ? 3 : base + 3;
      dep.getCell(titleRow, 1).value = `Depreciation Details for the fiscal year ${pjFyDot(y)}`;
      dep.mergeCells(titleRow, 1, titleRow, 9);
      dep.getCell(titleRow, 1).font = { bold: true };
      dep.getCell(titleRow, 1).alignment = { horizontal: 'center' };
      const head = base + 5;
      ['S.N.', 'Particulars', ...PJX_DEP_COLS].forEach((h, i) => {
        const c = dep.getCell(head, i + 1); c.value = h; c.font = { bold: true }; pjxBorder(c);
      });
      yr.dep.rows.forEach((r, i) => {
        const row = head + 1 + i;
        const prevBalRow = depTotalRow(y - 1) - 7 + i;  // same pool row in prior block
        const cells = [
          i + 1, r.name,
          y === 1 ? r.opening : { formula: `+I${prevBalRow}`, result: r.opening },
          r.addition, r.disposal,
          { formula: `+C${row}+D${row}-E${row}`, result: r.total },
          r.rate,
          { formula: `+F${row}*G${row}`, result: r.dep },
          { formula: `+F${row}-H${row}`, result: r.closing },
        ];
        cells.forEach((v, ci) => {
          const c = dep.getCell(row, ci + 1); c.value = v; pjxBorder(c);
          if (ci >= 2 && ci !== 6) c.numFmt = PJX_NUMFMT;
          if (ci === 6) c.numFmt = '0.00%';
        });
      });
      const tot = depTotalRow(y);
      const totCells = ['', 'Total'];
      ['C', 'D', 'E', 'F', '', 'H', 'I'].forEach((col, i) => {
        totCells.push(col ? { formula: `SUM(${col}${head + 1}:${col}${tot - 1})`, result: [yr.dep.opening, yr.dep.addition, yr.dep.disposal, yr.dep.total, 0, yr.dep.dep, yr.dep.closing][i] } : '');
      });
      totCells.forEach((v, ci) => {
        const c = dep.getCell(tot, ci + 1); c.value = v; c.font = { bold: true }; pjxBorder(c);
        if (ci >= 2) c.numFmt = PJX_NUMFMT;
      });
    });

    // ── Pl sheet ──
    const pl = wbOut.addWorksheet('Pl');
    pl.getColumn(1).width = 40;
    for (let y = 1; y <= N; y++) pl.getColumn(1 + y).width = 16;
    pl.getCell('A1').value = company; pl.mergeCells(1, 1, 1, 1 + N);
    pl.getCell('A2').value = address; pl.mergeCells(2, 1, 2, 1 + N);
    pl.getCell('A3').value = 'Projected Profit & Loss A/C for fiscal year'; pl.mergeCells(3, 1, 3, 1 + N);
    [1, 2, 3].forEach(r => { pl.getCell(r, 1).font = { bold: r !== 2 }; pl.getCell(r, 1).alignment = { horizontal: 'center' }; });
    pl.getCell('A5').value = 'Particulars';
    Y.forEach(yr => {
      pl.getCell(5, 1 + yr.year).value = pjFyDot(yr.year);
      pl.getCell(6, 1 + yr.year).value = `Year ${yr.year}`;
      pl.getCell(7, 1 + yr.year).value = 'Amount';
      [5, 6, 7].forEach(r => { const c = pl.getCell(r, 1 + yr.year); c.font = { bold: true }; c.alignment = { horizontal: 'right' }; });
    });
    pl.getCell('A5').font = { bold: true };

    const L = Y[0].pl.adminLines.length;
    const R = {                                  // Pl row registry
      sales: 8, cogsLabel: 10, opening: 11, purchase: 12, direct: 13, closing: 14, cogs: 15,
      gp: 17, adminLabel: 19, adminStart: 20,
      adminSum: 20 + L, pbid: 21 + L, intST: 22 + L, intLT: 23 + L, dep: 24 + L,
      pbt: 26 + L, tax: 27 + L, pat: 28 + L, upto: 29 + L, div: 30 + L, transfer: 31 + L,
      sig: 34 + L,
    };
    pl.getCell(R.sales, 1).value = PJX_PL_L.sales;
    pl.getCell(R.cogsLabel, 1).value = PJX_PL_L.cogsHead;
    pl.getCell(R.opening, 1).value = PJX_PL_L.opening;
    pl.getCell(R.purchase, 1).value = PJX_PL_L.purchase;
    pl.getCell(R.direct, 1).value = PJX_PL_L.direct;
    pl.getCell(R.closing, 1).value = PJX_PL_L.closing;
    pl.getCell(R.cogs, 1).value = PJX_PL_L.cogsTotal;
    pl.getCell(R.gp, 1).value = PJX_PL_L.gp;
    pl.getCell(R.adminLabel, 1).value = PJX_PL_L.adminHead;
    Y[0].pl.adminLines.forEach((l, i) => { pl.getCell(R.adminStart + i, 1).value = l.name; });
    pl.getCell(R.adminSum, 1).value = PJX_PL_L.adminTotal;
    pl.getCell(R.pbid, 1).value = PJX_PL_L.pbid;
    pl.getCell(R.intST, 1).value = PJX_PL_L.intST;
    pl.getCell(R.intLT, 1).value = PJX_PL_L.intLT;
    pl.getCell(R.dep, 1).value = PJX_PL_L.dep;
    pl.getCell(R.pbt, 1).value = PJX_PL_L.pbt;
    pl.getCell(R.tax, 1).value = PJX_PL_L.tax;
    pl.getCell(R.pat, 1).value = PJX_PL_L.pat;
    pl.getCell(R.upto, 1).value = PJX_PL_L.upto;
    pl.getCell(R.div, 1).value = PJX_PL_L.div;
    pl.getCell(R.transfer, 1).value = PJX_PL_L.transfer;
    pl.getCell(R.sig, 1).value = 'Accountant';
    pl.getCell(R.sig, 1 + N).value = T.person;

    Y.forEach(yr => {
      const c = plCol(yr.year), p = yr.pl, y = yr.year;
      const set = (row, v, bold) => {
        const cell = pl.getCell(row, 1 + y); cell.value = v; cell.numFmt = PJX_NUMFMT;
        if (bold) cell.font = { bold: true };
      };
      set(R.sales, p.sales, true);
      set(R.opening, y === 1 ? p.openingStock : { formula: `-${plCol(y - 1)}${R.closing}`, result: p.openingStock });
      set(R.purchase, p.purchases);
      set(R.direct, p.directCost);
      set(R.closing, -p.closingStock);
      set(R.cogs, { formula: `SUM(${c}${R.opening}:${c}${R.closing})`, result: p.cogs }, true);
      set(R.gp, { formula: `+${c}${R.sales}-${c}${R.cogs}`, result: p.grossProfit }, true);
      p.adminLines.forEach((l, i) => set(R.adminStart + i, l.amount));
      set(R.adminSum, { formula: `SUM(${c}${R.adminStart}:${c}${R.adminSum - 1})`, result: p.adminTotal }, true);
      set(R.pbid, { formula: `${c}${R.gp}-${c}${R.adminSum}`, result: p.grossProfit - p.adminTotal }, true);
      set(R.intST, p.interestST);
      set(R.intLT, p.interestLT);
      set(R.dep, { formula: `+Dep!H${depTotalRow(y)}`, result: p.dep });
      set(R.pbt, { formula: `+${c}${R.pbid}-SUM(${c}${R.intST}:${c}${R.dep})`, result: p.pbt }, true);
      set(R.tax, p.tax);
      set(R.pat, { formula: `${c}${R.pbt}-${c}${R.tax}`, result: p.pat }, true);
      set(R.upto, y === 1 ? p.retainedOpening : { formula: `+${plCol(y - 1)}${R.transfer}`, result: p.retainedOpening });
      set(R.div, p.dividend);
      set(R.transfer, { formula: `${c}${R.pat}+${c}${R.upto}-${c}${R.div}`, result: p.retainedClosing }, true);
    });

    // ── BS sheet ──
    const bs = wbOut.addWorksheet('BS');
    bs.getColumn(1).width = 4; bs.getColumn(2).width = 42;
    for (let y = 1; y <= N; y++) bs.getColumn(2 + y).width = 16;
    bs.getCell('B1').value = { formula: 'Pl!A1', result: company }; bs.mergeCells(1, 2, 1, 2 + N);
    bs.getCell('B2').value = { formula: 'Pl!A2', result: address }; bs.mergeCells(2, 2, 2, 2 + N);
    bs.getCell('B3').value = 'Projected Balance Sheet'; bs.mergeCells(3, 2, 3, 2 + N);
    [1, 2, 3].forEach(r => { bs.getCell(r, 2).font = { bold: r !== 2 }; bs.getCell(r, 2).alignment = { horizontal: 'center' }; });
    bs.getCell('B5').value = 'Particulars'; bs.getCell('B5').font = { bold: true };
    Y.forEach(yr => {
      bs.getCell(5, 2 + yr.year).value = pjAsAt(yr.year);
      bs.getCell(6, 2 + yr.year).value = `Year ${yr.year}`;
      [5, 6].forEach(r => { const cc = bs.getCell(r, 2 + yr.year); cc.font = { bold: true }; cc.alignment = { horizontal: 'right' }; });
    });
    const BR = { srcLabel: 7, capLabel: 8, cap: 9, addl: 10, reserve: 11, lt: 13, pwc: 14, director: 15,
      totalSrc: 17, usesLabel: 18, faLabel: 19, wdv: 20, depRow: 21, faTotal: 22, caLabel: 23,
      cash: 24, debtors: 25, stock: 26, caTotal: 27, clLabel: 28, creditors: 29, provTax: 30,
      expPay: 31, tds: 32, stl: 33, clTotal: 34, nca: 36, totalUses: 39, check: 42, sig: 46 };
    Object.entries(bsL).forEach(([k, label]) => {
      const cell = bs.getCell(BR[k], 2); cell.value = label;
      if (/Label$|^totalSrc$|^totalUses$|^faTotal$|^caTotal$|^clTotal$|^nca$/.test(k)) cell.font = { bold: true };
    });
    bs.getCell(BR.sig, 2).value = 'Accountant';
    bs.getCell(BR.sig, 2 + N).value = T.person;
    Y.forEach(yr => {
      const c = bsCol(yr.year), y = yr.year, b = yr.bs;
      const set = (row, v, bold) => {
        const cell = bs.getCell(row, 2 + y); cell.value = v; cell.numFmt = PJX_NUMFMT;
        if (bold) cell.font = { bold: true };
      };
      set(BR.cap, b.shareCapital);
      set(BR.addl, b.additionalCapital);
      set(BR.reserve, { formula: `Pl!${plCol(y)}${R.transfer}`, result: b.reserves });
      set(BR.lt, b.longTermLoan);
      set(BR.pwc, b.permanentWC);
      set(BR.director, b.directorLending);
      set(BR.totalSrc, { formula: `SUM(${c}${BR.cap}:${c}${BR.director + 1})`, result: b.totalSources }, true);
      set(BR.wdv, { formula: `+Dep!F${depTotalRow(y)}`, result: yr.dep.total });
      set(BR.depRow, { formula: `+Dep!H${depTotalRow(y)}`, result: yr.dep.dep });
      set(BR.faTotal, { formula: `${c}${BR.wdv}-${c}${BR.depRow}`, result: b.fixedAssetsNet }, true);
      set(BR.cash, b.cash);
      set(BR.debtors, b.debtors);
      set(BR.stock, { formula: `-Pl!${plCol(y)}${R.closing}`, result: b.closingStock });
      set(BR.caTotal, { formula: `SUM(${c}${BR.cash}:${c}${BR.stock})`, result: b.totalCurrentAssets }, true);
      set(BR.creditors, b.creditors);
      set(BR.provTax, { formula: `Pl!${plCol(y)}${R.tax}`, result: b.provisionTax });
      set(BR.expPay, b.expPayable);
      set(BR.tds, b.tdsPayable);
      set(BR.stl, b.shortTermLoan);
      set(BR.clTotal, { formula: `SUM(${c}${BR.creditors}:${c}${BR.stl})`, result: b.totalCurrentLiabilities }, true);
      set(BR.nca, { formula: `${c}${BR.caTotal}-${c}${BR.clTotal}`, result: b.netCurrentAssets }, true);
      set(BR.totalUses, { formula: `${c}${BR.faTotal}+${c}${BR.caTotal}-${c}${BR.clTotal}`, result: b.totalUses }, true);
      set(BR.check, { formula: `+${c}${BR.totalSrc}-${c}${BR.totalUses}`, result: 0 });
    });

    // ── CF sheet ──
    const cf = wbOut.addWorksheet('CF');
    cf.getColumn(1).width = 4; cf.getColumn(2).width = 48;
    for (let y = 1; y <= N; y++) cf.getColumn(2 + y).width = 16;
    cf.getCell('B1').value = { formula: 'Pl!A1', result: company }; cf.mergeCells(1, 2, 1, 2 + N);
    cf.getCell('B2').value = { formula: 'Pl!A2', result: address }; cf.mergeCells(2, 2, 2, 2 + N);
    cf.getCell('B3').value = 'Projected Cash Flow Statements'; cf.mergeCells(3, 2, 3, 2 + N);
    [1, 2, 3].forEach(r => { cf.getCell(r, 2).font = { bold: r !== 2 }; cf.getCell(r, 2).alignment = { horizontal: 'center' }; });
    cf.getCell('B5').value = 'Particulars'; cf.getCell('B5').font = { bold: true };
    Y.forEach(yr => {
      const cc = cf.getCell(5, 2 + yr.year); cc.value = pjFyDot(yr.year); cc.font = { bold: true }; cc.alignment = { horizontal: 'right' };
      cf.getCell(6, 2 + yr.year).value = 'Amount';
    });
    const CR = { aLabel: 7, npbit: 8, dep: 9, tax: 10, opSub: 12, dCA: 15, dCL: 16, wcSub: 17,
      netOp: 19, bLabel: 21, capex: 22, liqNC: 23, netInv: 24, cLabel: 26, issue: 27, div: 28,
      intPaid: 29, dDir: 30, dLoans: 31, netFin: 32, netChange: 34, openCash: 35, closeCash: 36, check: 38 };
    Object.entries(cfL).forEach(([k, label]) => {
      const cell = cf.getCell(CR[k], 2); cell.value = label;
      if (/Label$|^net|^opSub$|^netChange$|^closeCash$/.test(k)) cell.font = { bold: true };
    });
    Y.forEach(yr => {
      const c = bsCol(yr.year), y = yr.year, F = yr.cf;
      const set = (row, v, bold) => {
        const cell = cf.getCell(row, 2 + y); cell.value = v; cell.numFmt = PJX_NUMFMT;
        if (bold) cell.font = { bold: true };
      };
      set(CR.npbit, { formula: `Pl!${plCol(y)}${R.pbt}+Pl!${plCol(y)}${R.intST}+Pl!${plCol(y)}${R.intLT}`, result: F.pbtPlusInterest });
      set(CR.dep, { formula: `Pl!${plCol(y)}${R.dep}`, result: F.depreciation });
      set(CR.tax, { formula: `-Pl!${plCol(y)}${R.tax}`, result: F.incomeTax });
      set(CR.opSub, { formula: `SUM(${c}${CR.npbit}:${c}${CR.tax})`, result: F.pbtPlusInterest + F.depreciation + F.incomeTax }, true);
      set(CR.dCA, F.deltaCurrentAssets);
      set(CR.dCL, F.deltaCurrentLiabilities);
      set(CR.wcSub, { formula: `SUM(${c}${CR.dCA}:${c}${CR.dCL})`, result: F.deltaCurrentAssets + F.deltaCurrentLiabilities }, true);
      set(CR.netOp, { formula: `${c}${CR.opSub}+${c}${CR.wcSub}`, result: F.operating }, true);
      set(CR.capex, F.capex);
      set(CR.liqNC, F.liquidatedNC);
      set(CR.netInv, { formula: `SUM(${c}${CR.capex}:${c}${CR.liqNC})`, result: F.investing }, true);
      set(CR.issue, F.capitalIssued);
      set(CR.div, F.dividend);
      set(CR.intPaid, { formula: `-Pl!${plCol(y)}${R.intST}-Pl!${plCol(y)}${R.intLT}`, result: F.interestPaid });
      set(CR.dDir, F.deltaDirector);
      set(CR.dLoans, F.deltaLoans);
      set(CR.netFin, { formula: `SUM(${c}${CR.issue}:${c}${CR.dLoans})`, result: F.financing }, true);
      set(CR.netChange, { formula: `${c}${CR.netOp}+${c}${CR.netInv}+${c}${CR.netFin}`, result: F.netChange }, true);
      set(CR.openCash, y === 1 ? F.openingCash : { formula: `${bsCol(y - 1)}${CR.closeCash}`, result: F.openingCash });
      set(CR.closeCash, { formula: `${c}${CR.netChange}+${c}${CR.openCash}`, result: F.closingCash }, true);
      set(CR.check, { formula: `+${c}${CR.closeCash}-BS!${c}${BR.cash}`, result: 0 });
    });

    // ── IRD sheet (year 1 vs audited, master layout) ──
    const ird = wbOut.addWorksheet('IRD');
    ird.getColumn(1).width = 6; ird.getColumn(2).width = 52; ird.getColumn(3).width = 22; ird.getColumn(4).width = 22;
    ird.getCell('A1').value = company; ird.mergeCells('A1:D1');
    ird.getCell('A2').value = address; ird.mergeCells('A2:D2');
    [1, 2].forEach(r => { ird.getCell(r, 1).font = { bold: r === 1 }; ird.getCell(r, 1).alignment = { horizontal: 'center' }; });
    const irdHead = ['क्र.सं.', 'विवरण', `आ.व. ${pjFyLabel(0)} (${stmtType})`, `आ.व. ${pjFyLabel(1)} (Projected)`];
    irdHead.forEach((h, i) => { const c = ird.getCell(4, i + 1); c.value = h; c.font = { bold: true }; pjxBorder(c); });
    const irdFormula = {
      grossIncome: `+Pl!${plCol(1)}${R.gp}`,
      pbt: `+Pl!${plCol(1)}${R.pbt}`,
      tax: `+Pl!${plCol(1)}${R.tax}`,
      paidUpCapital: `+BS!${bsCol(1)}${BR.cap}+BS!${bsCol(1)}${BR.addl}`,
      reserves: `+BS!${bsCol(1)}${BR.reserve}`,
      bankLoan: `+BS!${bsCol(1)}${BR.pwc}+BS!${bsCol(1)}${BR.director}+BS!${bsCol(1)}${BR.stl}`,
      currentLiabilities: `+BS!${bsCol(1)}${BR.clTotal}`,
      provision: `+Pl!${plCol(1)}${R.tax}`,
      currentAssets: `+BS!${bsCol(1)}${BR.caTotal}`,
      fixedAssets: `+BS!${bsCol(1)}${BR.faTotal}`,
    };
    PJX_IRD_ROWS.forEach(({ key, np }, i) => {
      const r = 5 + i;
      const vals = [i + 1, np, pjResult.ird.audited[key], { formula: irdFormula[key], result: pjResult.ird.projected[key] }];
      vals.forEach((v, ci) => {
        const c = ird.getCell(r, ci + 1); c.value = v; pjxBorder(c);
        if (ci >= 2) c.numFmt = PJX_NUMFMT;
      });
    });

    // ── NCA working sheet ──
    const nca = wbOut.addWorksheet('NCA');
    nca.getColumn(1).width = 4; nca.getColumn(2).width = 30; nca.getColumn(3).width = 8; nca.getColumn(4).width = 36;
    for (let y = 1; y <= N; y++) nca.getColumn(4 + y).width = 16;
    const ncaCol = y => pjxCol(4 + y);
    nca.getCell('D4').value = 'Particular'; nca.getCell('D4').font = { bold: true };
    Y.forEach(yr => {
      const c = nca.getCell(4, 4 + yr.year); c.value = pjFyDot(yr.year); c.font = { bold: true }; c.alignment = { horizontal: 'right' };
    });
    const ncaRows = [
      ['A', 'Stock', y => ({ formula: `+BS!${bsCol(y)}${BR.stock}`, result: Y[y - 1].bs.closingStock })],
      ['B', 'Debtor', y => ({ formula: `+BS!${bsCol(y)}${BR.debtors}`, result: Y[y - 1].bs.debtors })],
      ['C=A+B', 'Total', y => ({ formula: `SUM(${ncaCol(y)}5:${ncaCol(y)}6)`, result: Y[y - 1].bs.closingStock + Y[y - 1].bs.debtors })],
      ['D', 'Current Liabilities except Short term loan', y => ({ formula: `+BS!${bsCol(y)}${BR.clTotal}-BS!${bsCol(y)}${BR.stl}`, result: Y[y - 1].bs.totalCurrentLiabilities - Y[y - 1].bs.shortTermLoan })],
      ['E=C-D', 'NCA', y => ({ formula: `+${ncaCol(y)}7-${ncaCol(y)}8`, result: Y[y - 1].ratios.nca })],
      ['F=70%*E', '70% of NCA', y => ({ formula: `+${ncaCol(y)}9*70%`, result: Y[y - 1].ratios.nca70 })],
      ['', 'Short Term Loan /OD/CC', y => ({ formula: `+BS!${bsCol(y)}${BR.stl}`, result: Y[y - 1].bs.shortTermLoan })],
      ['', 'Permanent WC', y => ({ formula: `+BS!${bsCol(y)}${BR.pwc}`, result: Y[y - 1].bs.permanentWC })],
      ['G', 'Total Loan', y => ({ formula: `SUM(${ncaCol(y)}11:${ncaCol(y)}12)`, result: Y[y - 1].bs.shortTermLoan + Y[y - 1].bs.permanentWC })],
      ['H=F-G', 'Difference (Always Positive)', y => ({ formula: `+${ncaCol(y)}10-${ncaCol(y)}13`, result: Y[y - 1].ratios.ncaHeadroom })],
    ];
    ncaRows.forEach(([code, label, fv], i) => {
      const r = 5 + i;
      nca.getCell(r, 4 - 2).value = code;                 // column B
      nca.getCell(r, 4).value = label;
      Y.forEach(yr => { const c = nca.getCell(r, 4 + yr.year); c.value = fv(yr.year); c.numFmt = PJX_NUMFMT; });
    });
    const ratioRows = [
      ['Debtor Turover ratio (days)', 'between 30 and 90 days', y => ({ formula: `+BS!${bsCol(y)}${BR.debtors}/Pl!${plCol(y)}${R.sales}*365`, result: Y[y - 1].ratios.debtorDays })],
      ['Current Ratio', 'always More than 1.5', y => ({ formula: `+BS!${bsCol(y)}${BR.caTotal}/BS!${bsCol(y)}${BR.clTotal}`, result: Y[y - 1].ratios.currentRatio })],
      ['Debt Equity ratio', 'always Less than 2.33', y => ({ formula: `+(BS!${bsCol(y)}${BR.lt}+BS!${bsCol(y)}${BR.pwc}+BS!${bsCol(y)}${BR.stl})/(BS!${bsCol(y)}${BR.cap}+BS!${bsCol(y)}${BR.reserve}+BS!${bsCol(y)}${BR.addl})`, result: Y[y - 1].ratios.debtEquity })],
      ['Gross Profit Margin', 'increasing trend (rule 6)', y => ({ formula: `+Pl!${plCol(y)}${R.gp}/Pl!${plCol(y)}${R.sales}`, result: Y[y - 1].pl.grossProfit / Y[y - 1].pl.sales }), '0.00%'],
      ['Net Profit Margin', 'increasing trend (rule 7)', y => ({ formula: `+Pl!${plCol(y)}${R.pat}/Pl!${plCol(y)}${R.sales}`, result: Y[y - 1].pl.pat / Y[y - 1].pl.sales }), '0.00%'],
    ];
    ratioRows.forEach(([label, note, fv, fmt], i) => {
      const r = 17 + i * 3;
      nca.getCell(r, 2).value = label; nca.getCell(r, 2).font = { bold: true };
      nca.getCell(r, 4).value = note;
      Y.forEach(yr => { const c = nca.getCell(r, 4 + yr.year); c.value = fv(yr.year); c.numFmt = fmt || '0.00'; });
    });

    const buf = await wbOut.xlsx.writeBuffer();
    const fname = `Projection Report ${company} ${pjFyLabel(1)}.xlsx`;
    DocumentEngine.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname,
      { eventType: 'projection_excel_downloaded', module: 'projection', clientName: company });
    pjStatus('Excel workbook downloaded — live formulas with cached results, recalculates in Excel.', 'success');
  } catch (e) {
    console.error(e);
    pjStatus('Excel generation failed: ' + escHtml(e.message), 'error');
  }
}

// ── PDF ────────────────────────────────────────────────────────────
//  Bank-submission report: cover page, then one statement per page in the
//  order BS · P&L · CF · Dep · IRD · Ratio Analysis, mirroring the Excel
//  sheets through the shared PJX_* label consts. Each statement is built as
//  a row list first, pruned of all-zero lines (business exceptions kept),
//  then auto-scaled so it always fits its own page — only the Depreciation
//  schedule may span pages (whole year-blocks, never split). Terminology
//  (Director/Partner/Proprietor, Paid-up vs Registered Capital) follows the
//  organization type; an optional Audited/Provisional comparison column can
//  lead the BS and P&L. Signature footer carries the auto B.S. date + place.

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

async function pjDownloadPdf() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building PDF…', 'searching');
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const times = await doc.embedFont(PDFLib.StandardFonts.TimesRoman);
    const timesB = await doc.embedFont(PDFLib.StandardFonts.TimesRomanBold);
    const C = {};
    Object.entries(PJX_PDF).forEach(([k, val]) => { if (Array.isArray(val)) C[k] = PDFLib.rgb(val[0], val[1], val[2]); });
    const { W, H, mX, mB } = PJX_PDF;
    const m = pjModel;
    const company = pjEl('pj-company').value || m.company.name;
    const address = m.company.address;
    const T = pjxTerms((pjEl('pj-org-type') || {}).value);
    const incAud = !!(pjEl('pj-include-audited') || {}).checked;
    // Statement type — the report names the single uploaded statement
    // (Audited OR Provisional), never both.
    const stmtType = (pjEl('pj-statement-type') || {}).value === 'provisional' ? 'Provisional' : 'Audited';
    const Y = pjResult.years;
    const N = Y.length;
    const amt = v => (v == null || isNaN(v) || Math.round(v) === 0) ? '–'
      : (v < 0 ? `(${Math.abs(Math.round(v)).toLocaleString('en-IN')})` : Math.round(v).toLocaleString('en-IN'));

    // Report date (B.S., auto) + place derived from the client address
    const tb = (typeof NepaliLocale !== 'undefined' && NepaliLocale.todayBs()) || null;
    const p2 = n => String(n).padStart(2, '0');
    const bsDate = tb ? `${tb.year}/${p2(tb.month)}/${p2(tb.day)}` : '';
    const place = (address || '').split(',').map(s => s.trim())
      .filter(s => s && !/nepal/i.test(s)).pop() || 'Chitwan';

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
      // Three vertical lines of different heights at the middle (inspired by
      // the firm's audit-report cover), the centre tallest.
      const baseY = 250, heights = [58, 84, 58], gap = 22;
      const centres = [cx - gap, cx, cx + gap];
      centres.forEach((x, i) => {
        pg.drawLine({ start: { x, y: baseY }, end: { x, y: baseY + heights[i] }, thickness: 1.4, color: C.navy });
      });
      const fyText = N === 1 ? `For the Fiscal Year ${pjFyLabel(1)}`
        : `For the Fiscal Years ${pjFyLabel(1)} to ${pjFyLabel(N)}`;
      ctr(fyText, 196, 13.5, bold, C.black);
      ctr(`(${N}-Year Financial Projection)`, 177, 10.5, font, C.muted);
      if (bsDate) ctr(`Date of Report : ${bsDate} B.S.`, 84, 10.5, font, C.black);
    }

    // ── Row builders ──
    const S = {
      sec:   { bold: true, labelColor: C.navy, pre: 3 },
      item:  { indent: true, grid: true },
      plain: { grid: true },
      tot:   { bold: true, fill: C.totalFill, top: true },
      grand: { bold: true, fill: C.grandFill, top: true, dbl: true, gap: 4.5 },
    };
    const v = f => Y.map(f);
    const withAud = (aud, arr) => incAud ? [aud, ...arr] : arr;
    const yearCols = h1 => Y.map(yr => ({ h1: h1(yr.year), h2: `Year ${yr.year}` }));
    const audCol = { h1: `F.Y. ${pjFyLabel(0)}`, h2: stmtType };
    // Zero-pruning: a detail row whose every numeric cell rounds to 0 is
    // dropped unless flagged `keep` (business exceptions). Heads/totals stay.
    const zeroRow = vals => (vals || []).every(x => x == null || x === '' || (typeof x === 'number' && Math.round(x) === 0));
    const prune = rows => rows.filter(r => !r.zeroable || r.keep || !zeroRow(r.vals));
    // After pruning, re-letter/renumber ordinal prefixes so removed rows never
    // leave gaps (a., b., c. … / 1., 2., 3. …). Top-level heads (Sources/Uses,
    // A./B./C.) reset the number run; numbered rows reset the letter run.
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

    // ── One statement = one auto-fitted table ──
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
      let rowH = Math.max(12, nfs * 1.52);
      if (!multiPage) {                      // scale to always fit one page
        const extras = rows.reduce((s, r) => s + (r.st.pre || 0) + (r.st.gap || 0), 0);
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
        const st = r.st;
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
          if (x == null || x === '') return;
          const isO = typeof x === 'object';
          const t = typeof x === 'number' ? amt(x) : (isO ? x.t : x);
          const cw = f.widthOfTextAtSize(t, nfs);
          page.drawText(t, { x: x0 + labelW + colW * (i + 1) - 6 - cw, y: bl, size: nfs, font: f, color: (isO && x.color) || C.black });
        });
        if (st.grid) page.drawLine({ start: { x: x0, y: yTop - rowH }, end: { x: x0 + tableW, y: yTop - rowH }, thickness: 0.4, color: C.gridLight });
        // Double rule sits BELOW the row's bottom edge (in the gap) so it can
        // never cross the figures — on auto-compressed pages the old in-row
        // offset landed on the digits and hid the grand-total amount.
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
          let gh = rowH + (r.st.pre || 0);          // keep the whole block together
          for (let j = i + 1; j < rows.length && !rows[j].group; j++) gh += rowH + (rows[j].st.pre || 0) + (rows[j].st.gap || 0);
          if (yTop - gh < mB + sigSpace) openPage(true);
        }
        drawRow(r);
      });
      closeGrid();
      if (sig) sigBlock();
    };

    // ── Audited/Provisional figures for the comparison column ──
    const termSum = m.loans.term.reduce((s, l) => s + l.amount, 0);
    const audAdminLine = i => i === 0 ? m.salary : ((m.otherExpenses[i - 1] || {}).amount ?? null);
    const audAdminTotal = m.salary + m.otherExpenses.reduce((s, e) => s + e.amount, 0);
    const audGP = m.revenue.operations - m.materials.total;
    const audNCA = m.currentAssetsTotal - m.currentLiabilitiesTotal;

    // ── Page 2: Projected Balance Sheet ──
    drawSheet({
      title: 'Projected Balance Sheet', sig: true,
      cols: withAud(audCol, yearCols(y => pjAsAt(y))),
      rows: renumber(prune([
        { label: PJX_BS_L.srcLabel, vals: [], st: S.sec },
        { label: PJX_BS_L.capLabel, vals: [], st: S.sec },
        { label: T.capRow, vals: withAud(m.shareCapital, v(x => x.bs.shareCapital)), st: S.item },
        { label: T.addlRow, vals: withAud(null, v(x => x.bs.additionalCapital)), st: S.item, zeroable: true },
        { label: PJX_BS_L.reserve, vals: withAud(m.reserves, v(x => x.bs.reserves)), st: S.item },
        { label: PJX_BS_L.lt, vals: withAud(termSum, v(x => x.bs.longTermLoan)), st: S.plain, zeroable: true },
        { label: PJX_BS_L.pwc, vals: withAud(null, v(x => x.bs.permanentWC)), st: S.plain, zeroable: true },
        { label: T.lendRow, vals: withAud(m.loans.directorLoan, v(x => x.bs.directorLending)), st: S.plain, zeroable: true },
        { label: PJX_BS_L.totalSrc, vals: withAud(m.shareCapital + m.reserves + termSum + m.loans.directorLoan, v(x => x.bs.totalSources)), st: S.grand },
        { label: PJX_BS_L.usesLabel, vals: [], st: S.sec },
        { label: PJX_BS_L.faLabel, vals: [], st: S.sec },
        { label: PJX_BS_L.wdv, vals: withAud(null, v(x => x.dep.total)), st: S.item, zeroable: true, keep: true },
        { label: PJX_BS_L.depRow, vals: withAud(null, v(x => x.dep.dep)), st: S.item, zeroable: true, keep: true },
        { label: PJX_BS_L.faTotal, vals: withAud(m.ppeTotal, v(x => x.bs.fixedAssetsNet)), st: S.tot },
        { label: PJX_BS_L.caLabel, vals: [], st: S.sec },
        { label: PJX_BS_L.cash, vals: withAud(m.cash, v(x => x.bs.cash)), st: S.item },
        { label: PJX_BS_L.debtors, vals: withAud(m.debtors, v(x => x.bs.debtors)), st: S.item },
        { label: PJX_BS_L.stock, vals: withAud(m.inventory.closing, v(x => x.bs.closingStock)), st: S.item, zeroable: true },
        { label: PJX_BS_L.caTotal, vals: withAud(m.currentAssetsTotal, v(x => x.bs.totalCurrentAssets)), st: S.tot },
        { label: PJX_BS_L.clLabel, vals: [], st: S.sec },
        { label: PJX_BS_L.creditors, vals: withAud(m.creditors, v(x => x.bs.creditors)), st: S.item, zeroable: true },
        { label: PJX_BS_L.provTax, vals: withAud(m.tax, v(x => x.bs.provisionTax)), st: S.item, zeroable: true },
        { label: PJX_BS_L.expPay, vals: withAud(null, v(x => x.bs.expPayable)), st: S.item, zeroable: true },
        { label: PJX_BS_L.tds, vals: withAud(null, v(x => x.bs.tdsPayable)), st: S.item, zeroable: true },
        { label: PJX_BS_L.stl, vals: withAud(m.loans.overdraft, v(x => x.bs.shortTermLoan)), st: S.item, zeroable: true },
        { label: PJX_BS_L.clTotal, vals: withAud(m.currentLiabilitiesTotal, v(x => x.bs.totalCurrentLiabilities)), st: S.tot },
        { label: PJX_BS_L.nca, vals: withAud(audNCA, v(x => x.bs.netCurrentAssets)), st: S.tot },
        { label: PJX_BS_L.totalUses, vals: withAud(m.ppeTotal + audNCA, v(x => x.bs.totalUses)), st: S.grand },
      ])),
    });

    // ── Page 3: Projected Profit & Loss ──
    drawSheet({
      title: 'Projected Profit & Loss A/C', sig: true,
      cols: withAud(audCol, yearCols(y => pjFyDot(y))),
      rows: prune([
        { label: PJX_PL_L.sales, vals: withAud(m.revenue.operations, v(x => x.pl.sales)), st: { bold: true, grid: true } },
        { label: PJX_PL_L.cogsHead, vals: [], st: S.sec },
        { label: PJX_PL_L.opening, vals: withAud(m.materials.opening, v(x => x.pl.openingStock)), st: S.item, zeroable: true },
        { label: PJX_PL_L.purchase, vals: withAud(m.materials.purchases, v(x => x.pl.purchases)), st: S.item, zeroable: true },
        { label: PJX_PL_L.direct, vals: withAud(m.materials.directCost, v(x => x.pl.directCost)), st: S.item, zeroable: true },
        { label: PJX_PL_L.closing, vals: withAud(-m.materials.closing, v(x => -x.pl.closingStock)), st: S.item, zeroable: true },
        { label: PJX_PL_L.cogsTotal, vals: withAud(m.materials.total, v(x => x.pl.cogs)), st: S.tot },
        { label: PJX_PL_L.gp, vals: withAud(audGP, v(x => x.pl.grossProfit)), st: S.grand },
        { label: PJX_PL_L.adminHead, vals: [], st: S.sec },
        ...Y[0].pl.adminLines.map((l, i) => (
          { label: l.name, vals: withAud(audAdminLine(i), v(x => x.pl.adminLines[i].amount)), st: S.item, zeroable: true }
        )),
        { label: PJX_PL_L.adminTotal, vals: withAud(audAdminTotal, v(x => x.pl.adminTotal)), st: S.tot },
        { label: PJX_PL_L.pbid, vals: withAud(audGP - audAdminTotal, v(x => x.pl.grossProfit - x.pl.adminTotal)), st: S.tot },
        { label: PJX_PL_L.intST, vals: withAud(m.financeCost, v(x => x.pl.interestST)), st: S.plain, zeroable: true },
        { label: PJX_PL_L.intLT, vals: withAud(null, v(x => x.pl.interestLT)), st: S.plain, zeroable: true },
        { label: PJX_PL_L.dep, vals: withAud(null, v(x => x.pl.dep)), st: S.plain, zeroable: true, keep: true },
        { label: PJX_PL_L.pbt, vals: withAud(m.profitBeforeTax, v(x => x.pl.pbt)), st: S.grand },
        { label: PJX_PL_L.tax, vals: withAud(m.tax, v(x => x.pl.tax)), st: S.plain, zeroable: true },
        { label: PJX_PL_L.pat, vals: withAud(m.profitBeforeTax - m.tax, v(x => x.pl.pat)), st: S.tot },
        { label: PJX_PL_L.upto, vals: withAud(null, v(x => x.pl.retainedOpening)), st: S.plain, zeroable: true },
        { label: PJX_PL_L.div, vals: withAud(null, v(x => x.pl.dividend)), st: S.plain, zeroable: true, keep: true },
        { label: PJX_PL_L.transfer, vals: withAud(m.reserves, v(x => x.pl.retainedClosing)), st: S.grand },
      ]),
    });

    // ── Page 4: Projected Cash Flow (projection-only — audited deltas
    //    don't exist for a single audited year) ──
    drawSheet({
      title: 'Projected Cash Flow Statements', sig: true,
      cols: yearCols(y => pjFyDot(y)),
      rows: renumber(prune([
        { label: PJX_CF_L.aLabel, vals: [], st: S.sec },
        { label: PJX_CF_L.npbit, vals: v(x => x.cf.pbtPlusInterest), st: S.item },
        { label: PJX_CF_L.dep, vals: v(x => x.cf.depreciation), st: S.item, zeroable: true, keep: true },
        { label: PJX_CF_L.tax, vals: v(x => x.cf.incomeTax), st: S.item },
        { label: PJX_CF_L.opSub, vals: v(x => x.cf.pbtPlusInterest + x.cf.depreciation + x.cf.incomeTax), st: S.tot },
        { label: PJX_CF_L.dCA, vals: v(x => x.cf.deltaCurrentAssets), st: S.item },
        { label: PJX_CF_L.dCL, vals: v(x => x.cf.deltaCurrentLiabilities), st: S.item },
        { label: PJX_CF_L.wcSub, vals: v(x => x.cf.deltaCurrentAssets + x.cf.deltaCurrentLiabilities), st: S.tot },
        { label: PJX_CF_L.netOp, vals: v(x => x.cf.operating), st: S.grand },
        { label: PJX_CF_L.bLabel, vals: [], st: S.sec },
        { label: PJX_CF_L.capex, vals: v(x => x.cf.capex), st: S.item, zeroable: true },
        { label: PJX_CF_L.liqNC, vals: v(x => x.cf.liquidatedNC), st: S.item, zeroable: true },
        { label: PJX_CF_L.netInv, vals: v(x => x.cf.investing), st: S.grand },
        { label: PJX_CF_L.cLabel, vals: [], st: S.sec },
        { label: PJX_CF_L.issue, vals: v(x => x.cf.capitalIssued), st: S.item, zeroable: true },
        { label: PJX_CF_L.div, vals: v(x => x.cf.dividend), st: S.item, zeroable: true },
        { label: PJX_CF_L.intPaid, vals: v(x => x.cf.interestPaid), st: S.item, zeroable: true },
        { label: T.dDirRow, vals: v(x => x.cf.deltaDirector), st: S.item, zeroable: true },
        { label: PJX_CF_L.dLoans, vals: v(x => x.cf.deltaLoans), st: S.item, zeroable: true },
        { label: PJX_CF_L.netFin, vals: v(x => x.cf.financing), st: S.grand },
        { label: PJX_CF_L.netChange, vals: v(x => x.cf.netChange), st: S.tot },
        { label: PJX_CF_L.openCash, vals: v(x => x.cf.openingCash), st: S.plain },
        { label: PJX_CF_L.closeCash, vals: v(x => x.cf.closingCash), st: S.grand },
      ])),
    });

    // ── Page 5+: Depreciation — only asset classes that carry any value
    //    across the projection appear; each year-block stays together ──
    const depActive = Y[0].dep.rows.map((_, i) => Y.some(yr => {
      const r = yr.dep.rows[i];
      return Math.abs(r.opening) + Math.abs(r.addition) + Math.abs(r.disposal) + Math.abs(r.total) + Math.abs(r.closing) > 0.005;
    }));
    const depRows = [];
    Y.forEach(yr => {
      depRows.push({ label: `Depreciation Details for the fiscal year ${pjFyDot(yr.year)}`, vals: [], st: { span: true, pre: 6 }, group: true });
      yr.dep.rows.forEach((r, i) => {
        if (!depActive[i]) return;
        depRows.push({ label: r.name, vals: [r.opening, r.addition, r.disposal, r.total, `${+(r.rate * 100).toFixed(2)}%`, r.dep, r.closing], st: S.item });
      });
      depRows.push({ label: 'Total', vals: [yr.dep.opening, yr.dep.addition, yr.dep.disposal, yr.dep.total, '', yr.dep.dep, yr.dep.closing], st: S.tot });
    });
    drawSheet({
      title: 'Depreciation Schedule', sig: true, multiPage: true, labelW: 200,
      cols: PJX_DEP_COLS.map(h => ({ h1: h })),
      rows: depRows,
    });

    // ── Page 6: IRD summary (English labels; standard PDF fonts can't
    //    render the master's Devanagari) ──
    const ird = pjResult.ird;
    drawSheet({
      title: 'IRD Summary', labelW: 420,
      cols: [
        { h1: `F.Y. ${pjFyLabel(0)}`, h2: stmtType },
        { h1: `F.Y. ${pjFyLabel(1)}`, h2: 'Projected' },
      ],
      rows: PJX_IRD_ROWS.map((r, i) => (
        { label: `${i + 1}.  ${r.en}`, vals: [ird.audited[r.key], ird.projected[r.key]], st: S.plain }
      )),
    });

    // ── Page 7: NCA working & Ratio Analysis ──
    const pct = x => `${(x * 100).toFixed(2)}%`;
    drawSheet({
      title: 'Net Current Assets Working & Ratio Analysis',
      cols: yearCols(y => pjFyDot(y)),
      rows: [
        { label: 'A.  Stock', vals: v(x => x.bs.closingStock), st: S.item },
        { label: 'B.  Debtor', vals: v(x => x.bs.debtors), st: S.item },
        { label: 'C = A+B   Total', vals: v(x => x.bs.closingStock + x.bs.debtors), st: S.tot },
        { label: 'D.  Current Liabilities except Short Term Loan', vals: v(x => x.bs.totalCurrentLiabilities - x.bs.shortTermLoan), st: S.item },
        { label: 'E = C-D   Net Current Assets', vals: v(x => x.ratios.nca), st: S.tot },
        { label: 'F = 70% × E', vals: v(x => x.ratios.nca70), st: S.item },
        { label: 'Short Term Loan /OD/CC', vals: v(x => x.bs.shortTermLoan), st: S.item },
        { label: 'Permanent WC', vals: v(x => x.bs.permanentWC), st: S.item },
        { label: 'G.  Total Loan', vals: v(x => x.bs.shortTermLoan + x.bs.permanentWC), st: S.tot },
        { label: 'H = F-G   Difference (always positive)', vals: v(x => ({ t: amt(x.ratios.ncaHeadroom), color: x.ratios.ncaHeadroom >= 0 ? C.pass : C.fail })), st: S.grand },
        { label: 'Ratio Analysis', vals: [], st: S.sec },
        { label: 'Debtor Turnover (days) — between 30 and 90 days', vals: v(x => {
          const d = Math.round(x.ratios.debtorDays);
          return { t: x.ratios.debtorDays.toFixed(0), color: d >= 30 && d <= 90 ? C.pass : C.fail };
        }), st: S.plain },
        { label: 'Current Ratio — always more than 1.5', vals: v(x => ({ t: x.ratios.currentRatio.toFixed(2), color: x.ratios.currentRatio >= 1.5 ? C.pass : C.fail })), st: S.plain },
        { label: 'Debt-Equity Ratio — always less than 2.33', vals: v(x => ({ t: x.ratios.debtEquity.toFixed(2), color: x.ratios.debtEquity <= 2.33 ? C.pass : C.fail })), st: S.plain },
        { label: 'Gross Profit Margin', vals: v(x => pct(x.pl.grossProfit / x.pl.sales)), st: S.plain },
        { label: 'Net Profit Margin', vals: v(x => pct(x.pl.pat / x.pl.sales)), st: S.plain },
      ],
    });

    const bytes = await doc.save();
    const fname = `Projection Report ${company} ${pjFyLabel(1)}.pdf`;
    DocumentEngine.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fname,
      { eventType: 'projection_pdf_downloaded', module: 'projection', clientName: company });
    pjStatus('PDF downloaded.', 'success');
  } catch (e) {
    console.error(e);
    pjStatus('PDF generation failed: ' + escHtml(e.message), 'error');
  }
}
