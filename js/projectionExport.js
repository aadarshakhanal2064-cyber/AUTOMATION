// ════════════════════════════════════════════
//  PROJECTION REPORT — EXPORTS
//  Excel (ExcelJS, live formulas + cached results, master-workbook layout:
//  Pl · BS · CF · Dep · IRD · NCA) and PDF (PDF-Lib, A4 portrait) for the
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
      ['S.N.', 'Particulars', 'Opening', 'Additional', 'Sales', 'Total', 'Dep Rate %', 'Depreciation', 'Balance Amount'].forEach((h, i) => {
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
    pl.getCell(R.sales, 1).value = 'Income from Sales/Service';
    pl.getCell(R.cogsLabel, 1).value = 'Cost of Goods Sold';
    pl.getCell(R.opening, 1).value = 'Opening Stock';
    pl.getCell(R.purchase, 1).value = 'Goods Purchase';
    pl.getCell(R.direct, 1).value = 'Direct Cost';
    pl.getCell(R.closing, 1).value = '(-) Closing Stock';
    pl.getCell(R.gp, 1).value = 'Gross Profit';
    pl.getCell(R.adminLabel, 1).value = 'Adminstrative Expenses';
    Y[0].pl.adminLines.forEach((l, i) => { pl.getCell(R.adminStart + i, 1).value = l.name; });
    pl.getCell(R.pbid, 1).value = 'Profit before interest/Deprecation';
    pl.getCell(R.intST, 1).value = 'Bank Interest on Short term/OD';
    pl.getCell(R.intLT, 1).value = 'Bank Interest on Term';
    pl.getCell(R.dep, 1).value = 'Depreciation';
    pl.getCell(R.pbt, 1).value = 'Net Profit before tax';
    pl.getCell(R.tax, 1).value = 'Provision for tax';
    pl.getCell(R.pat, 1).value = 'Net Profit after tax for the year';
    pl.getCell(R.upto, 1).value = 'Profit/loss upto last year';
    pl.getCell(R.div, 1).value = 'Dividend/Withdrawal';
    pl.getCell(R.transfer, 1).value = 'Transferred to Balance Sheet';
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
    const bsLabels = {
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
    Object.entries(bsLabels).forEach(([k, label]) => {
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
    const cfLabels = {
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
    Object.entries(cfLabels).forEach(([k, label]) => {
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
    const irdRows = [
      ['कुल आम्दानी (Gross Income)', 'grossIncome', `+Pl!${plCol(1)}${R.gp}`],
      ['कर अगाडिको खुद मुनाफा/नोक्सानी (Net Profit/Loss Before Tax)', 'pbt', `+Pl!${plCol(1)}${R.pbt}`],
      ['आयकर दायित्व (Tax Liability)', 'tax', `+Pl!${plCol(1)}${R.tax}`],
      ['चुक्ता पुँजी (Paid up Capital)', 'paidUpCapital', `+BS!${bsCol(1)}${BR.cap}+BS!${bsCol(1)}${BR.addl}`],
      ['जगेडा (सञ्चित नाफा सहित) (Reserve)', 'reserves', `+BS!${bsCol(1)}${BR.reserve}`],
      ['ऋण (Loan from Bank and Financial Institution)', 'bankLoan', `+BS!${bsCol(1)}${BR.pwc}+BS!${bsCol(1)}${BR.director}+BS!${bsCol(1)}${BR.stl}`],
      ['चालु दायित्व (Current Liabilities)', 'currentLiabilities', `+BS!${bsCol(1)}${BR.clTotal}`],
      ['व्यवस्था (Provision)', 'provision', `+Pl!${plCol(1)}${R.tax}`],
      ['चालु सम्पत्ति (Current Assets)', 'currentAssets', `+BS!${bsCol(1)}${BR.caTotal}`],
      ['स्थिर सम्पत्ति (Fixed Assets)', 'fixedAssets', `+BS!${bsCol(1)}${BR.faTotal}`],
    ];
    irdRows.forEach(([label, key, formula], i) => {
      const r = 5 + i;
      const vals = [i + 1, label, pjResult.ird.audited[key], { formula, result: pjResult.ird.projected[key] }];
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

async function pjDownloadPdf() {
  if (!pjResult || !pjModel) return;
  try {
    pjStatus('Building PDF…', 'searching');
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const navy = PDFLib.rgb(0.043, 0.122, 0.239);
    const muted = PDFLib.rgb(0.392, 0.455, 0.545);
    const black = PDFLib.rgb(0.1, 0.12, 0.16);
    const company = pjEl('pj-company').value || pjModel.company.name;
    const address = pjModel.company.address;
    const Y = pjResult.years;
    const N = Y.length;
    const W = 595, H = 842, mL = 40, mR = W - 40;
    const labelW = 210;
    const colW = Math.min(90, (mR - mL - labelW) / N);
    const amt = v => (v == null || isNaN(v) || Math.round(v) === 0) ? '–'
      : (v < 0 ? `(${Math.abs(Math.round(v)).toLocaleString('en-IN')})` : Math.round(v).toLocaleString('en-IN'));

    let page, y;
    const newPage = (title) => {
      page = doc.addPage([W, H]);
      y = H - 50;
      page.drawText(company, { x: mL, y, size: 14, font: bold, color: navy }); y -= 16;
      if (address) { page.drawText(address, { x: mL, y, size: 9.5, font, color: muted }); y -= 14; }
      page.drawText(title, { x: mL, y, size: 11.5, font: bold, color: black }); y -= 18;
      // year headers
      page.drawText('Particulars', { x: mL, y, size: 8.5, font: bold, color: navy });
      Y.forEach(yr => {
        const label = `F.Y. ${pjFyDot(yr.year)}`;
        const tw = bold.widthOfTextAtSize(label, 8.5);
        page.drawText(label, { x: mL + labelW + colW * yr.year - tw, y, size: 8.5, font: bold, color: navy });
      });
      y -= 6;
      page.drawLine({ start: { x: mL, y }, end: { x: mR, y }, thickness: 0.8, color: navy });
      y -= 12;
    };
    const row = (label, vals, opts = {}) => {
      if (y < 60) newPage('(continued)');
      const f = opts.bold ? bold : font;
      let s = label;
      while (s && f.widthOfTextAtSize(s, 8.5) > labelW - 6) s = s.slice(0, -1);
      page.drawText(s, { x: mL + (opts.indent ? 12 : 0), y, size: 8.5, font: f, color: black });
      (vals || []).forEach((v, i) => {
        const t = typeof v === 'string' ? v : amt(v);
        const tw = f.widthOfTextAtSize(t, 8.5);
        page.drawText(t, { x: mL + labelW + colW * (i + 1) - tw, y, size: 8.5, font: f, color: black });
      });
      if (opts.rule) { page.drawLine({ start: { x: mL, y: y - 3 }, end: { x: mR, y: y - 3 }, thickness: 0.5, color: PDFLib.rgb(0.8, 0.82, 0.88) }); }
      y -= opts.gap ? 18 : 13;
    };
    const v = f => Y.map(f);

    // Page 1: P&L
    newPage('Projected Profit & Loss A/C');
    row('Income from Sales/Service', v(x => x.pl.sales), { bold: true, rule: true });
    row('Opening Stock', v(x => x.pl.openingStock), { indent: true });
    row('Goods Purchase', v(x => x.pl.purchases), { indent: true });
    row('Direct Cost', v(x => x.pl.directCost), { indent: true });
    row('(-) Closing Stock', v(x => -x.pl.closingStock), { indent: true });
    row('Cost of Goods Sold', v(x => x.pl.cogs), { bold: true, rule: true });
    row('Gross Profit', v(x => x.pl.grossProfit), { bold: true, gap: true });
    Y[0].pl.adminLines.forEach((_, i) => row(Y[0].pl.adminLines[i].name, v(x => x.pl.adminLines[i].amount), { indent: true }));
    row('Administrative Expenses', v(x => x.pl.adminTotal), { bold: true, rule: true });
    row('Profit before interest/Depreciation', v(x => x.pl.grossProfit - x.pl.adminTotal), { bold: true });
    row('Bank Interest on Short term/OD', v(x => x.pl.interestST));
    row('Bank Interest on Term', v(x => x.pl.interestLT));
    row('Depreciation', v(x => x.pl.dep));
    row('Net Profit before tax', v(x => x.pl.pbt), { bold: true, rule: true });
    row('Provision for tax', v(x => x.pl.tax));
    row('Net Profit after tax for the year', v(x => x.pl.pat), { bold: true });
    row('Profit/loss upto last year', v(x => x.pl.retainedOpening));
    row('Dividend/Withdrawal', v(x => x.pl.dividend));
    row('Transferred to Balance Sheet', v(x => x.pl.retainedClosing), { bold: true, rule: true });

    // Page 2: Balance Sheet
    newPage('Projected Balance Sheet');
    row('Sources of Funds:', [], { bold: true });
    row('a. Registered/Paid up Share Capital', v(x => x.bs.shareCapital), { indent: true });
    row('b. Additional Capital', v(x => x.bs.additionalCapital), { indent: true });
    row('c. Reserve & Surplus', v(x => x.bs.reserves), { indent: true });
    row('2. Long Term Loan', v(x => x.bs.longTermLoan), { indent: true });
    row('3. Permanent Working Capital', v(x => x.bs.permanentWC), { indent: true });
    row('4. Director/Proprietor Lending', v(x => x.bs.directorLending), { indent: true });
    row('Total Sources of Funds', v(x => x.bs.totalSources), { bold: true, rule: true, gap: true });
    row('Uses of Funds:', [], { bold: true });
    row('Total Fixed Assets (net)', v(x => x.bs.fixedAssetsNet), { indent: true });
    row('a. Cash at Hand & Bank', v(x => x.bs.cash), { indent: true });
    row('b. Sundry Debtors', v(x => x.bs.debtors), { indent: true });
    row('c. Closing Stock', v(x => x.bs.closingStock), { indent: true });
    row('Total Current Assets', v(x => x.bs.totalCurrentAssets), { bold: true });
    row('a. Sundry Creditors', v(x => x.bs.creditors), { indent: true });
    row('b. Provision for tax', v(x => x.bs.provisionTax), { indent: true });
    row('c. Expenses Payable', v(x => x.bs.expPayable), { indent: true });
    row('d. TDS Payables', v(x => x.bs.tdsPayable), { indent: true });
    row('e. Short Term Loan /OD/CC', v(x => x.bs.shortTermLoan), { indent: true });
    row('Total Current Liabilities', v(x => x.bs.totalCurrentLiabilities), { bold: true });
    row('Net Current Assets', v(x => x.bs.netCurrentAssets), { bold: true });
    row('Total Uses of Funds', v(x => x.bs.totalUses), { bold: true, rule: true });

    // Page 3: Cash Flow
    newPage('Projected Cash Flow Statements');
    row('A. Cash flow from Operating Activities', [], { bold: true });
    row('Net Profit before interest & income tax', v(x => x.cf.pbtPlusInterest), { indent: true });
    row('Depreciation', v(x => x.cf.depreciation), { indent: true });
    row('Income tax', v(x => x.cf.incomeTax), { indent: true });
    row('Increase/(Decrease) in Current Assets', v(x => x.cf.deltaCurrentAssets), { indent: true });
    row('Increase/(Decrease) in Current Liabilities', v(x => x.cf.deltaCurrentLiabilities), { indent: true });
    row('Net cash flow from Operating Activities', v(x => x.cf.operating), { bold: true, rule: true });
    row('B. Cash flow from Investing Activities', [], { bold: true });
    row('Sale/(Purchase) of Fixed Assets', v(x => x.cf.capex), { indent: true });
    row('Sale of (investment in) Securities', v(x => x.cf.liquidatedNC), { indent: true });
    row('Net cash flow from Investing Activities', v(x => x.cf.investing), { bold: true, rule: true });
    row('C. Cash flow from Financing Activities', [], { bold: true });
    row('Issuance of Share Capital (Additional Capital)', v(x => x.cf.capitalIssued), { indent: true });
    row('Drawing/Dividend', v(x => x.cf.dividend), { indent: true });
    row('Payment of Interest', v(x => x.cf.interestPaid), { indent: true });
    row('Increase/(decrease) in Director Lending', v(x => x.cf.deltaDirector), { indent: true });
    row('Increase/(decrease) in Bank Loans', v(x => x.cf.deltaLoans), { indent: true });
    row('Net cash flow from Financing Activities', v(x => x.cf.financing), { bold: true, rule: true });
    row('Increase/(Decrease) in cash (A+B+C)', v(x => x.cf.netChange), { bold: true });
    row('Opening balances of cash & bank', v(x => x.cf.openingCash));
    row('Closing balances of cash & bank', v(x => x.cf.closingCash), { bold: true, rule: true });

    // Page 4: Depreciation — each year is its own block with fixed columns
    // (Opening · Addition · Total · Dep · Balance), independent of N.
    newPage('Depreciation Details');
    const depCols = [['Opening', 250], ['Addition', 320], ['Total', 390], ['Depreciation', 460], ['Balance', 530]];
    const depRow = (label, vals, opts = {}) => {
      if (y < 60) newPage('Depreciation Details (continued)');
      const f = opts.bold ? bold : font;
      let s = label;
      while (s && f.widthOfTextAtSize(s, 8.5) > 200) s = s.slice(0, -1);
      page.drawText(s, { x: mL, y, size: 8.5, font: f, color: black });
      vals.forEach((val, i) => {
        const t = typeof val === 'string' ? val : amt(val);
        const cx = depCols[i][1] + 25;
        const tw = f.widthOfTextAtSize(t, 8.5);
        page.drawText(t, { x: cx - tw, y, size: 8.5, font: f, color: black });
      });
      y -= 13;
    };
    Y.forEach(yr => {
      if (y < 180) newPage('Depreciation Details (continued)');
      y -= 4;
      depRow(`Fiscal year ${pjFyDot(yr.year)}`, depCols.map(c => c[0]), { bold: true });
      page.drawLine({ start: { x: mL, y: y + 9 }, end: { x: mR, y: y + 9 }, thickness: 0.5, color: PDFLib.rgb(0.8, 0.82, 0.88) });
      yr.dep.rows.forEach(r => {
        if (r.total === 0 && r.opening === 0 && r.addition === 0) return;
        depRow(`${r.name} @ ${(r.rate * 100).toFixed(r.rate * 100 % 1 ? 1 : 0)}%`, [r.opening, r.addition, r.total, r.dep, r.closing]);
      });
      depRow('Total', [yr.dep.opening, yr.dep.addition, yr.dep.total, yr.dep.dep, yr.dep.closing], { bold: true });
      y -= 6;
    });

    // Page 5: IRD summary + ratios
    newPage('IRD Summary & Ratio Analysis');
    const ird = pjResult.ird;
    [['Gross Income', 'grossIncome'], ['Net Profit/Loss Before Tax', 'pbt'], ['Tax Liability', 'tax'],
     ['Paid up Capital', 'paidUpCapital'], ['Reserve', 'reserves'], ['Loan from Bank & Financial Institution', 'bankLoan'],
     ['Current Liabilities', 'currentLiabilities'], ['Provision', 'provision'], ['Current Assets', 'currentAssets'],
     ['Fixed Assets', 'fixedAssets']].forEach(([label, k]) => {
      row(label, [ird.audited[k], ird.projected ? ird.projected[k] : null].concat(Y.slice(2).map(() => '')));
    });
    y -= 8;
    row('Ratios', [], { bold: true });
    row('Debtor Turnover (days) — limit 90', v(x => x.ratios.debtorDays.toFixed(0)));
    row('Current Ratio — min 1.5', v(x => x.ratios.currentRatio.toFixed(2)));
    row('Debt-Equity — max 2.33', v(x => x.ratios.debtEquity.toFixed(2)));
    row('70% NCA less WC loans (always positive)', v(x => x.ratios.ncaHeadroom), { rule: true });

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
