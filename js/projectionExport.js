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
    pl.getCell(R.sig, 1 + N).value = 'Director';

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
    Object.entries(PJX_BS_L).forEach(([k, label]) => {
      const cell = bs.getCell(BR[k], 2); cell.value = label;
      if (/Label$|^totalSrc$|^totalUses$|^faTotal$|^caTotal$|^clTotal$|^nca$/.test(k)) cell.font = { bold: true };
    });
    bs.getCell(BR.sig, 2).value = 'Accountant';
    bs.getCell(BR.sig, 2 + N).value = 'Director';
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
    Object.entries(PJX_CF_L).forEach(([k, label]) => {
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
    const irdHead = ['क्र.सं.', 'विवरण', `आ.व. ${pjFyLabel(0)} (Audited/Provisional)`, `आ.व. ${pjFyLabel(1)} (Projected)`];
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
      ['Debtor Turover ratio (days)', 'always Less than 90 days', y => ({ formula: `+BS!${bsCol(y)}${BR.debtors}/Pl!${plCol(y)}${R.sales}*365`, result: Y[y - 1].ratios.debtorDays })],
      ['Current Ratio', 'always More than 1.5', y => ({ formula: `+BS!${bsCol(y)}${BR.caTotal}/BS!${bsCol(y)}${BR.clTotal}`, result: Y[y - 1].ratios.currentRatio })],
      ['Debt Equity ratio', 'always Less than 2.33', y => ({ formula: `+(BS!${bsCol(y)}${BR.lt}+BS!${bsCol(y)}${BR.pwc}+BS!${bsCol(y)}${BR.stl})/(BS!${bsCol(y)}${BR.cap}+BS!${bsCol(y)}${BR.reserve}+BS!${bsCol(y)}${BR.addl})`, result: Y[y - 1].ratios.debtEquity })],
    ];
    ratioRows.forEach(([label, note, fv], i) => {
      const r = 17 + i * 3;
      nca.getCell(r, 2).value = label; nca.getCell(r, 2).font = { bold: true };
      nca.getCell(r, 4).value = note;
      Y.forEach(yr => { const c = nca.getCell(r, 4 + yr.year); c.value = fv(yr.year); c.numFmt = '0.00'; });
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
//  A4 landscape, one statement per section, mirroring the Excel sheets
//  row-for-row via the shared PJX_* label consts above. Rendered as a real
//  table: navy header band, vertical separators between the year columns,
//  light row grid, tinted total rows, double-ruled grand totals, dotted
//  signature footer. Column widths and font sizes scale with the year count
//  so 3–10-year projections all lay out cleanly on the same geometry.

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
    const C = {};
    Object.entries(PJX_PDF).forEach(([k, val]) => { if (Array.isArray(val)) C[k] = PDFLib.rgb(val[0], val[1], val[2]); });
    const { W, H, mX, mB } = PJX_PDF;
    const company = pjEl('pj-company').value || pjModel.company.name;
    const address = pjModel.company.address;
    const Y = pjResult.years;
    const amt = v => (v == null || isNaN(v) || Math.round(v) === 0) ? '–'
      : (v < 0 ? `(${Math.abs(Math.round(v)).toLocaleString('en-IN')})` : Math.round(v).toLocaleString('en-IN'));

    // Row style presets — every statement uses the same five looks.
    const S = {
      sec:   { bold: true, labelColor: C.navy, pre: 3 },              // section heading
      item:  { indent: true, grid: true },                            // detail line
      plain: { grid: true },                                          // un-indented line
      tot:   { bold: true, fill: C.totalFill, top: true },            // sub-total band
      grand: { bold: true, fill: C.grandFill, top: true, dbl: true, gap: 3 }, // grand total
    };

    // One statement = one table. cols: [{h1, h2?}] numeric column headers.
    const mkSheet = (title, cols, o = {}) => {
      const usable = W - 2 * mX;
      const nC = cols.length;
      const labelW = o.labelW || Math.max(180, Math.min(270, usable - nC * 112));
      const colW = Math.min(112, (usable - labelW) / nC);
      const tableW = labelW + colW * nC;
      const x0 = (W - tableW) / 2;
      const nfs = colW >= 95 ? 9 : colW >= 78 ? 8.4 : colW >= 62 ? 7.8 : colW >= 52 ? 7.1 : colW >= 45 ? 6.6 : 6.1;
      const lfs = Math.min(9.4, nfs + 0.6);
      const rowH = Math.max(12, nfs * 1.52);
      const twoLine = cols.some(c => c.h2);
      const bandH = twoLine ? 27 : 17;
      const sigSpace = o.sig ? 50 : 14;
      let page = null, yTop = 0, bandTop = 0, banners = [];

      const closeGrid = () => {
        if (!page) return;
        // vertical separators, drawn in segments that skip banner rows
        const stops = [...banners].sort((a, b) => b.top - a.top);
        for (let i = 0; i <= nC; i++) {
          const x = x0 + labelW + colW * i;
          let from = bandTop - bandH;
          stops.forEach(bn => {
            if (bn.top < from) { page.drawLine({ start: { x, y: from }, end: { x, y: bn.top }, thickness: 0.5, color: C.gridLight }); }
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
      // keep-together: start a fresh page unless `need` points of rows fit
      const ensure = need => { if (!page || yTop - need < mB + sigSpace) openPage(!!page); };
      const row = (label, vals, st = {}) => {
        if (st.pre && page && yTop < bandTop - bandH) yTop -= st.pre;
        ensure(rowH);
        const f = st.bold ? bold : font;
        if (st.fill) page.drawRectangle({ x: x0, y: yTop - rowH, width: tableW, height: rowH, color: st.fill });
        if (st.top) page.drawLine({ start: { x: x0, y: yTop }, end: { x: x0 + tableW, y: yTop }, thickness: 0.6, color: C.gridDark });
        const bl = yTop - rowH + (rowH - nfs) * 0.5 + 1;
        if (st.span) {                       // centered banner across the table (Dep year titles)
          banners.push({ top: yTop, bot: yTop - rowH });   // grid verticals skip this row
          const tw = bold.widthOfTextAtSize(label, lfs);
          page.drawText(label, { x: x0 + (tableW - tw) / 2, y: bl, size: lfs, font: bold, color: C.navy });
        } else if (label) {
          let ls = lfs;                      // shrink-to-fit, never truncate
          const maxW = labelW - 10 - (st.indent ? 10 : 0);
          while (ls > 5.4 && f.widthOfTextAtSize(label, ls) > maxW) ls -= 0.2;
          page.drawText(label, { x: x0 + 5 + (st.indent ? 10 : 0), y: bl, size: ls, font: f, color: st.labelColor || C.black });
        }
        (vals || []).forEach((v, i) => {
          if (v == null || v === '') return;
          const isO = typeof v === 'object';
          const t = typeof v === 'number' ? amt(v) : (isO ? v.t : v);
          const cw = f.widthOfTextAtSize(t, nfs);
          page.drawText(t, { x: x0 + labelW + colW * (i + 1) - 6 - cw, y: bl, size: nfs, font: f, color: (isO && v.color) || C.black });
        });
        if (st.grid) page.drawLine({ start: { x: x0, y: yTop - rowH }, end: { x: x0 + tableW, y: yTop - rowH }, thickness: 0.4, color: C.gridLight });
        if (st.dbl) [1, 2.6].forEach(off =>
          page.drawLine({ start: { x: x0 + labelW, y: yTop - rowH + off }, end: { x: x0 + tableW, y: yTop - rowH + off }, thickness: 0.5, color: C.navy }));
        yTop -= rowH + (st.gap || 0);
      };
      const sig = () => {
        const sy = mB + 6;
        const dash = { thickness: 0.7, color: C.black, dashArray: [2, 2] };
        page.drawLine({ start: { x: x0, y: sy + 12 }, end: { x: x0 + 130, y: sy + 12 }, ...dash });
        page.drawText('Accountant', { x: x0, y: sy, size: 9, font, color: C.black });
        page.drawLine({ start: { x: x0 + tableW - 130, y: sy + 12 }, end: { x: x0 + tableW, y: sy + 12 }, ...dash });
        const dw = font.widthOfTextAtSize('Director', 9);
        page.drawText('Director', { x: x0 + tableW - dw, y: sy, size: 9, font, color: C.black });
      };
      const finish = () => { closeGrid(); if (o.sig) sig(); };
      openPage(false);
      return { row, finish, ensure, rowH: () => rowH };
    };

    const yearCols = h1 => Y.map(yr => ({ h1: h1(yr.year), h2: `Year ${yr.year}` }));
    const v = f => Y.map(f);

    // ── Projected Profit & Loss (mirrors Excel Pl row-for-row) ──
    let sh = mkSheet('Projected Profit & Loss A/C', yearCols(y => pjFyDot(y)), { sig: true });
    sh.row(PJX_PL_L.sales, v(x => x.pl.sales), { bold: true, grid: true });
    sh.row(PJX_PL_L.cogsHead, [], S.sec);
    sh.row(PJX_PL_L.opening, v(x => x.pl.openingStock), S.item);
    sh.row(PJX_PL_L.purchase, v(x => x.pl.purchases), S.item);
    sh.row(PJX_PL_L.direct, v(x => x.pl.directCost), S.item);
    sh.row(PJX_PL_L.closing, v(x => -x.pl.closingStock), S.item);
    sh.row(PJX_PL_L.cogsTotal, v(x => x.pl.cogs), S.tot);
    sh.row(PJX_PL_L.gp, v(x => x.pl.grossProfit), S.grand);
    sh.row(PJX_PL_L.adminHead, [], S.sec);
    Y[0].pl.adminLines.forEach((_, i) => sh.row(Y[0].pl.adminLines[i].name, v(x => x.pl.adminLines[i].amount), S.item));
    sh.row(PJX_PL_L.adminTotal, v(x => x.pl.adminTotal), S.tot);
    sh.row(PJX_PL_L.pbid, v(x => x.pl.grossProfit - x.pl.adminTotal), S.tot);
    sh.row(PJX_PL_L.intST, v(x => x.pl.interestST), S.plain);
    sh.row(PJX_PL_L.intLT, v(x => x.pl.interestLT), S.plain);
    sh.row(PJX_PL_L.dep, v(x => x.pl.dep), S.plain);
    sh.row(PJX_PL_L.pbt, v(x => x.pl.pbt), S.grand);
    sh.row(PJX_PL_L.tax, v(x => x.pl.tax), S.plain);
    sh.row(PJX_PL_L.pat, v(x => x.pl.pat), S.tot);
    sh.row(PJX_PL_L.upto, v(x => x.pl.retainedOpening), S.plain);
    sh.row(PJX_PL_L.div, v(x => x.pl.dividend), S.plain);
    sh.row(PJX_PL_L.transfer, v(x => x.pl.retainedClosing), S.grand);
    sh.finish();

    // ── Projected Balance Sheet (mirrors Excel BS row-for-row) ──
    sh = mkSheet('Projected Balance Sheet', yearCols(y => pjAsAt(y)), { sig: true });
    sh.row(PJX_BS_L.srcLabel, [], S.sec);
    sh.row(PJX_BS_L.capLabel, [], S.sec);
    sh.row(PJX_BS_L.cap, v(x => x.bs.shareCapital), S.item);
    sh.row(PJX_BS_L.addl, v(x => x.bs.additionalCapital), S.item);
    sh.row(PJX_BS_L.reserve, v(x => x.bs.reserves), S.item);
    sh.row(PJX_BS_L.lt, v(x => x.bs.longTermLoan), S.plain);
    sh.row(PJX_BS_L.pwc, v(x => x.bs.permanentWC), S.plain);
    sh.row(PJX_BS_L.director, v(x => x.bs.directorLending), S.plain);
    sh.row(PJX_BS_L.totalSrc, v(x => x.bs.totalSources), S.grand);
    sh.row(PJX_BS_L.usesLabel, [], S.sec);
    sh.row(PJX_BS_L.faLabel, [], S.sec);
    sh.row(PJX_BS_L.wdv, v(x => x.dep.total), S.item);
    sh.row(PJX_BS_L.depRow, v(x => x.dep.dep), S.item);
    sh.row(PJX_BS_L.faTotal, v(x => x.bs.fixedAssetsNet), S.tot);
    sh.row(PJX_BS_L.caLabel, [], S.sec);
    sh.row(PJX_BS_L.cash, v(x => x.bs.cash), S.item);
    sh.row(PJX_BS_L.debtors, v(x => x.bs.debtors), S.item);
    sh.row(PJX_BS_L.stock, v(x => x.bs.closingStock), S.item);
    sh.row(PJX_BS_L.caTotal, v(x => x.bs.totalCurrentAssets), S.tot);
    sh.row(PJX_BS_L.clLabel, [], S.sec);
    sh.row(PJX_BS_L.creditors, v(x => x.bs.creditors), S.item);
    sh.row(PJX_BS_L.provTax, v(x => x.bs.provisionTax), S.item);
    sh.row(PJX_BS_L.expPay, v(x => x.bs.expPayable), S.item);
    sh.row(PJX_BS_L.tds, v(x => x.bs.tdsPayable), S.item);
    sh.row(PJX_BS_L.stl, v(x => x.bs.shortTermLoan), S.item);
    sh.row(PJX_BS_L.clTotal, v(x => x.bs.totalCurrentLiabilities), S.tot);
    sh.row(PJX_BS_L.nca, v(x => x.bs.netCurrentAssets), S.tot);
    sh.row(PJX_BS_L.totalUses, v(x => x.bs.totalUses), S.grand);
    sh.finish();

    // ── Projected Cash Flow (mirrors Excel CF row-for-row) ──
    sh = mkSheet('Projected Cash Flow Statements', yearCols(y => pjFyDot(y)), { sig: true });
    sh.row(PJX_CF_L.aLabel, [], S.sec);
    sh.row(PJX_CF_L.npbit, v(x => x.cf.pbtPlusInterest), S.item);
    sh.row(PJX_CF_L.dep, v(x => x.cf.depreciation), S.item);
    sh.row(PJX_CF_L.tax, v(x => x.cf.incomeTax), S.item);
    sh.row(PJX_CF_L.opSub, v(x => x.cf.pbtPlusInterest + x.cf.depreciation + x.cf.incomeTax), S.tot);
    sh.row(PJX_CF_L.dCA, v(x => x.cf.deltaCurrentAssets), S.item);
    sh.row(PJX_CF_L.dCL, v(x => x.cf.deltaCurrentLiabilities), S.item);
    sh.row(PJX_CF_L.wcSub, v(x => x.cf.deltaCurrentAssets + x.cf.deltaCurrentLiabilities), S.tot);
    sh.row(PJX_CF_L.netOp, v(x => x.cf.operating), S.grand);
    sh.row(PJX_CF_L.bLabel, [], S.sec);
    sh.row(PJX_CF_L.capex, v(x => x.cf.capex), S.item);
    sh.row(PJX_CF_L.liqNC, v(x => x.cf.liquidatedNC), S.item);
    sh.row(PJX_CF_L.netInv, v(x => x.cf.investing), S.grand);
    sh.row(PJX_CF_L.cLabel, [], S.sec);
    sh.row(PJX_CF_L.issue, v(x => x.cf.capitalIssued), S.item);
    sh.row(PJX_CF_L.div, v(x => x.cf.dividend), S.item);
    sh.row(PJX_CF_L.intPaid, v(x => x.cf.interestPaid), S.item);
    sh.row(PJX_CF_L.dDir, v(x => x.cf.deltaDirector), S.item);
    sh.row(PJX_CF_L.dLoans, v(x => x.cf.deltaLoans), S.item);
    sh.row(PJX_CF_L.netFin, v(x => x.cf.financing), S.grand);
    sh.row(PJX_CF_L.netChange, v(x => x.cf.netChange), S.tot);
    sh.row(PJX_CF_L.openCash, v(x => x.cf.openingCash), S.plain);
    sh.row(PJX_CF_L.closeCash, v(x => x.cf.closingCash), S.grand);
    sh.finish();

    // ── Depreciation — one block per year, all 7 pools (Excel Dep layout) ──
    sh = mkSheet('Depreciation Details', PJX_DEP_COLS.map(h => ({ h1: h })), { sig: true, labelW: 200 });
    Y.forEach(yr => {
      sh.ensure(sh.rowH() * 10.5);           // keep each year's block together
      sh.row(`Depreciation Details for the fiscal year ${pjFyDot(yr.year)}`, [], { span: true, pre: 6 });
      yr.dep.rows.forEach(r => sh.row(r.name,
        [r.opening, r.addition, r.disposal, r.total, `${+(r.rate * 100).toFixed(2)}%`, r.dep, r.closing], S.item));
      sh.row('Total', [yr.dep.opening, yr.dep.addition, yr.dep.disposal, yr.dep.total, '', yr.dep.dep, yr.dep.closing], S.tot);
    });
    sh.finish();

    // ── IRD summary — year 1 vs audited (English labels; standard PDF
    //    fonts can't render the master's Devanagari) ──
    sh = mkSheet('IRD Summary', [
      { h1: `F.Y. ${pjFyLabel(0)}`, h2: 'Audited/Provisional' },
      { h1: `F.Y. ${pjFyLabel(1)}`, h2: 'Projected' },
    ], { labelW: 420 });
    const ird = pjResult.ird;
    PJX_IRD_ROWS.forEach((r, i) =>
      sh.row(`${i + 1}.  ${r.en}`, [ird.audited[r.key], ird.projected[r.key]], S.plain));
    sh.finish();

    // ── NCA working & ratio analysis (Excel NCA sheet, with pass/fail colour) ──
    sh = mkSheet('Net Current Assets Working & Ratio Analysis', yearCols(y => pjFyDot(y)));
    sh.row('A.  Stock', v(x => x.bs.closingStock), S.item);
    sh.row('B.  Debtor', v(x => x.bs.debtors), S.item);
    sh.row('C = A+B   Total', v(x => x.bs.closingStock + x.bs.debtors), S.tot);
    sh.row('D.  Current Liabilities except Short Term Loan', v(x => x.bs.totalCurrentLiabilities - x.bs.shortTermLoan), S.item);
    sh.row('E = C-D   Net Current Assets', v(x => x.ratios.nca), S.tot);
    sh.row('F = 70% × E', v(x => x.ratios.nca70), S.item);
    sh.row('Short Term Loan /OD/CC', v(x => x.bs.shortTermLoan), S.item);
    sh.row('Permanent WC', v(x => x.bs.permanentWC), S.item);
    sh.row('G.  Total Loan', v(x => x.bs.shortTermLoan + x.bs.permanentWC), S.tot);
    sh.row('H = F-G   Difference (always positive)',
      v(x => ({ t: amt(x.ratios.ncaHeadroom), color: x.ratios.ncaHeadroom >= 0 ? C.pass : C.fail })), S.grand);
    sh.row('Ratios', [], S.sec);
    sh.row('Debtor Turnover (days) — always less than 90',
      v(x => ({ t: x.ratios.debtorDays.toFixed(0), color: x.ratios.debtorDays <= 90 ? C.pass : C.fail })), S.plain);
    sh.row('Current Ratio — always more than 1.5',
      v(x => ({ t: x.ratios.currentRatio.toFixed(2), color: x.ratios.currentRatio >= 1.5 ? C.pass : C.fail })), S.plain);
    sh.row('Debt-Equity Ratio — always less than 2.33',
      v(x => ({ t: x.ratios.debtEquity.toFixed(2), color: x.ratios.debtEquity <= 2.33 ? C.pass : C.fail })), S.plain);
    sh.finish();

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
