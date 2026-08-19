// ════════════════════════════════════════════════════════════════════════
//  PROVISIONAL STATEMENT ENGINE
//
//  The Audited Statement engine lays out a year that has already happened:
//  you type this year's real figures and it arranges them. This one goes the
//  other way — you type a handful of figures and it DERIVES the rest from
//  last year by formula, exactly the way the firm's own provisional workbook
//  does it in Excel.
//
//  Every rule here is quoted from the firm's own REFERENCE PROVISIONAL
//  WORKBOOK, read cell-by-cell; the source formula sits in a comment beside
//  each one. (That workbook is a client's and is not in this repo — the
//  templates directory is gitignored, CLAUDE.md §1 rule 7.) `tools/psVerify.mjs`
//  replays that workbook's prior-year column through this engine and asserts
//  every derived figure back against the workbook's own cached results, so a
//  change that breaks a rule fails loudly instead of silently reprinting a
//  wrong statement. Run it before and after touching anything in this file.
//
//  NOTE THE SOLVE DIRECTION, which is the opposite of the audited engine's:
//  there, profit is the target and Purchases is the plug; here Purchases is
//  TYPED and profit falls out. That is what makes this a provisional rather
//  than a reconstruction, and it is why the two engines are separate files
//  rather than one with a flag.
// ════════════════════════════════════════════════════════════════════════

const ProvisionalStatementEngine = (() => {

  // ── rounding ──
  // Excel's ROUND is half-away-from-zero; JS Math.round is half-up, which
  // disagrees on negatives. The workbook only ever rounds positives, but the
  // engine is fed user figures, so match Excel rather than hope.
  function xlRound(v, digits) {
    if (!isFinite(v)) return 0;
    const f = Math.pow(10, digits || 0);
    const x = v * f;
    const r = x < 0 ? -Math.round(-x) : Math.round(x);
    return r / f;
  }
  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  };
  const safeRatio = (a, b) => (Math.abs(b) < 1e-9 ? 0 : a / b);

  // ════════════════════════════════════════════════════════════════
  //  DEFAULTS — every one of these is an editable default, never a
  //  hardcoded truth. They are what the firm's workbook actually does.
  // ════════════════════════════════════════════════════════════════

  // `Sch-PL D33 =ROUND(F33*1.05,-3)` and the shared `D55:D70 =ROUND(F55*1.05,)`.
  const GROWTH = 1.05;

  // The two lines the firm types flat rather than indexing: a rent and an
  // audit fee are renegotiated, not inflated. In the source workbook both
  // carry the prior year's figure unchanged (`D53`=75,000, `D61`=840,000)
  // while every neighbouring line runs through the 1.05 formula.
  const FLAT_LINES = ['auditFee', 'rent'];

  // `3.1 PPE` reads its rates straight off the sheet's own formulas —
  // `=+F11*5%`, `=+J11*20%`, `=+L11*25%`, `=+N11*0.25`.
  const PPE_RATES = [
    { key: 'land',      name: 'Land',                  rate: 0    },
    { key: 'building',  name: 'Building & Structures', rate: 0.05 },
    { key: 'plant',     name: 'Plant and Machinery',   rate: 0.15 },
    { key: 'vehicles',  name: 'Vehicles',              rate: 0.20 },
    { key: 'office',    name: 'Office Equipment',      rate: 0.25 },
    { key: 'software',  name: 'Software',              rate: 0.25 },
  ];

  // Statutory rates, each one read off a Sch-BS formula. Kept as data so a
  // rate change is one edit rather than a hunt through the arithmetic.
  const TDS = {
    salary:   0.01,   // `H92 =+SOI!F20*1%`
    rent:     0.10,   // `H93 =+'Sch-PL'!D61*10%`
    incentive:0.15,   // `H94 =+SOI!F23*15%`
    wages:    0.01,   // `H95 =+'Sch-PL'!D25*1%`
    auditFee: 0.015,  // `H97 =+'Sch-PL'!D53*1.5%`
    freight:  0.015,  // `H98 =+'Sch-PL'!D26*1.5%`
  };

  const CORPORATE_TAX = 0.25;   // `Sch-PL D75 =+SOI!F27*0.25`

  // Proprietorship slabs, carried from Projection. Deliberately NOT unified
  // with the Audited engine's D3 slabs — two schedules for two purposes (§15).
  const TAX_SLABS = [
    { upto: 500000,  rate: 0    },
    { upto: 700000,  rate: 0.10 },
    { upto: 1000000, rate: 0.20 },
    { upto: 2000000, rate: 0.30 },
    { upto: Infinity, rate: 0.36 },
  ];

  function progressiveTax(income) {
    let last = 0, tax = 0;
    for (const s of TAX_SLABS) {
      if (income <= last) break;
      tax += (Math.min(income, s.upto) - last) * s.rate;
      last = s.upto;
    }
    return tax;
  }

  // ════════════════════════════════════════════════════════════════
  //  LINE RULES — how one expense line gets from last year to this one.
  //  A line's rule is data, so the UI can offer it as a dropdown and the
  //  user can override any single line without leaving the pattern.
  // ════════════════════════════════════════════════════════════════

  const RULES = {
    flat:     { id: 'flat',     label: 'Same as last year' },
    growth:   { id: 'growth',   label: 'Last year + growth %' },
    turnover: { id: 'turnover', label: 'Scaled by turnover' },
    driver:   { id: 'driver',   label: 'Scaled by other income' },
    typed:    { id: 'typed',    label: 'Typed this year' },
  };

  // One line's current-year figure.
  //   py      prior-year amount
  //   rule    one of RULES
  //   opts    { growth, roundTo, salesRatio, driverRatio, typed }
  function applyRule(py, rule, opts) {
    const o = opts || {};
    switch (rule) {
      case 'typed':
        return num(o.typed);
      case 'flat':
        return py;
      case 'turnover':
        // `Sch-PL D25 =+F25/F6*D6` — labour and freight move with turnover,
        // not with inflation.
        return py * o.salesRatio;
      case 'driver':
        // `SOI F23 =+ROUND(H23/H15*F15,)` — the incentive expense tracks the
        // incentive INCOME that earns it.
        return xlRound(py * o.driverRatio, 0);
      case 'growth':
      default: {
        const g = o.growth == null ? GROWTH : o.growth;
        // Salary rounds to the nearest thousand (`,-3`), everything else to
        // the rupee (`,`). Both are the workbook's own choices.
        return xlRound(py * g, o.roundTo == null ? 0 : o.roundTo);
      }
    }
  }

  // The Excel-side twin of applyRule: the same rule expressed as a live
  // formula descriptor, which finStatementExport turns into the cell formula
  // the firm's own workbook carries. Kept beside applyRule on purpose — if one
  // gains a rule and the other does not, the exported sheet stops agreeing
  // with the screen, which is the exact failure this module exists to prevent.
  function ruleDescriptor(rule, opts) {
    const o = opts || {};
    switch (rule) {
      case 'flat':     return { kind: 'flat' };
      case 'turnover': return { kind: 'turnover' };
      case 'driver':   return { kind: 'driver' };
      case 'growth':   return { kind: 'growth', factor: o.growth == null ? GROWTH : o.growth, roundTo: o.roundTo || 0 };
      case 'typed':
      default:         return null;   // a typed figure is a figure, not a formula
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  DERIVE — the whole current-year column, from the prior year plus the
  //  figures the preparer actually types.
  // ════════════════════════════════════════════════════════════════
  //
  //  input = {
  //    py:      { sales, otherIncome, interestIncome, openingStock, purchases,
  //               labour, freight, closingStock, salary, otherContrib,
  //               interestOD, interestTerm, bankCharges, incentiveExpense,
  //               depreciation, taxExpense, advanceTax, otherExpenses[],
  //               ppeClasses[], ... balance-sheet carries }
  //    cy:      { sales, otherIncome, purchases, closingStock, tradeReceivables,
  //               cash, tradePayables, interestOD, ... }
  //    rules:   { <lineKey>: { rule, growth, roundTo, typed } }
  //    options: { growth, taxProfile: 'corporate'|'progressive', ppeRates }
  //  }
  function derive(input) {
    const py = input.py || {};
    const cy = input.cy || {};
    const rulesIn = input.rules || {};
    const opt = input.options || {};
    const issues = [];
    const warn = msg => issues.push({ level: 'warn', msg });
    const err = msg => issues.push({ level: 'error', msg });

    const growth = opt.growth == null ? GROWTH : num(opt.growth);

    // ── the two scaling ratios every derived line keys off ──
    const pySales = num(py.sales);
    const cySales = num(cy.sales);
    const pyOther = num(py.otherIncome);
    const cyOther = num(cy.otherIncome);

    if (!pySales) warn('Prior-year sales is nil, so turnover-scaled lines (Labour Charges, Clearing & Freight) fall to zero. Check the prior-year figures.');
    if (!cySales) err('This year’s Sale of Goods has not been entered — every turnover-scaled line and the whole Income Statement depend on it.');

    const salesRatio  = safeRatio(cySales, pySales);
    const driverRatio = safeRatio(cyOther, pyOther);

    // Resolve one line through its rule, honouring a per-line override.
    const line = (key, pyAmount, defRule, defOpts) => {
      const ov = rulesIn[key] || {};
      const rule = ov.rule || defRule;
      const o = Object.assign({ growth, salesRatio, driverRatio }, defOpts || {}, ov);
      const amount = applyRule(num(pyAmount), rule, o);
      return { key, py: num(pyAmount), amount, rule, growth: o.growth, roundTo: o.roundTo,
               derive: ruleDescriptor(rule, o) };
    };

    // ════════════════════════════════════════════════
    //  INCOME  (SOI / Sch-PL 3.11)
    // ════════════════════════════════════════════════
    const revenueOps     = cySales;
    const interestIncome = num(cy.interestIncome);
    const otherIncome    = cyOther;
    const totalIncome    = revenueOps + interestIncome + otherIncome;   // `SOI F16 =SUM(F12:F15)`

    // ════════════════════════════════════════════════
    //  MATERIALS CONSUMED  (Sch-PL 3.12)
    //  `D29 =SUM(D22:D26)-D28`
    //  Opening stock is `D22 =+F28` — last year's closing, never typed.
    // ════════════════════════════════════════════════
    const openingStock = num(py.closingStock);
    const purchases    = num(cy.purchases);
    const labour  = line('labour',  py.labour,  'turnover');   // `D25 =+F25/F6*D6`
    const freight = line('freight', py.freight, 'turnover');   // `D26 =+F26/F6*D6`
    const closingStock = num(cy.closingStock);
    const materialsTotal = openingStock + purchases + labour.amount + freight.amount - closingStock;

    if (purchases < 0) err('Purchases of goods is negative.');
    if (closingStock < 0) err('Closing stock is negative.');

    // ════════════════════════════════════════════════
    //  EMPLOYEE BENEFITS  (Sch-PL 3.13)
    //  `D33 =ROUND(F33*1.05,-3)` — nearest thousand.
    // ════════════════════════════════════════════════
    const salary = line('salary', py.salary, 'growth', { roundTo: -3 });
    const otherContrib = line('otherContrib', py.otherContrib, 'growth', { roundTo: 0 });
    const employeeTotal = salary.amount + otherContrib.amount;

    // ════════════════════════════════════════════════
    //  FINANCE COST  (Sch-PL 3.14) — typed, because interest follows the
    //  actual facility rather than any growth pattern.
    // ════════════════════════════════════════════════
    const interestOD   = num(cy.interestOD);
    const interestTerm = num(cy.interestTerm);
    const bankCharges  = num(cy.bankCharges);
    const financeTotal = interestOD + interestTerm + bankCharges;

    // ════════════════════════════════════════════════
    //  OTHER EXPENSES  (Sch-PL 3.15)
    //  Every line runs `=ROUND(F*1.05,)` EXCEPT Audit Fee and Rent, which the
    //  firm types flat. Both remain fully editable.
    // ════════════════════════════════════════════════
    const otherExpenses = (py.otherExpenses || []).map(e => {
      const key = e.key || e.name;
      const isFlat = FLAT_LINES.indexOf(e.key) >= 0;
      const l = line(key, e.amount, isFlat ? 'flat' : 'growth', { roundTo: 0 });
      return { key, name: e.name, py: l.py, amount: l.amount, rule: l.rule, growth: l.growth, derive: l.derive };
    });
    const otherTotal = otherExpenses.reduce((s, e) => s + e.amount, 0);
    const pick = k => { const e = otherExpenses.find(x => x.key === k); return e ? e.amount : 0; };
    const auditFee = pick('auditFee');
    const rent     = pick('rent');

    // ════════════════════════════════════════════════
    //  INCENTIVE EXPENSE  (SOI row e)
    //  `F23 =+ROUND(H23/H15*F15,)` — tracks the incentive income, so it sits
    //  on the other-income ratio rather than the turnover one.
    // ════════════════════════════════════════════════
    const incentive = line('incentiveExpense', py.incentiveExpense, 'driver');
    if (py.incentiveExpense && !pyOther) {
      warn('Prior-year Other Income is nil while an incentive expense exists, so the incentive cannot be scaled. It has been carried at zero — set the line to "Typed this year" if that is wrong.');
    }

    // ════════════════════════════════════════════════
    //  DEPRECIATION  (3.1 PPE)
    //  The workbook RESTATES every year: opening gross cost is last year's
    //  CARRYING amount and opening accumulated depreciation is nil, so
    //  `carrying = gross - this year's charge`. That is a reducing-balance
    //  schedule written as a fresh block per year, and it is what makes
    //  `3.1 PPE!P25` tie back to `SFP!F13`.
    // ════════════════════════════════════════════════
    const rateTable = opt.ppeRates || PPE_RATES;
    const ppeClasses = (py.ppeClasses || []).map(c => {
      const def = rateTable.find(r => r.key === c.key) || {};
      const rate = c.rate == null ? (def.rate == null ? 0 : def.rate) : num(c.rate);
      const openCost  = num(c.carrying);              // restated: last year's WDV
      const additions = num(c.additions);
      const disposals = num(c.disposals);
      const closeCost = openCost + additions - disposals;   // `=D8+D9-D10`
      const depCharge = xlRound(closeCost * rate, 10);      // `=+F11*5%`
      const closeCarrying = closeCost - depCharge;          // `=+F11-F19`
      return {
        key: c.key, name: c.name || (def.name || c.key), rate,
        openCost, additions, disposals, closeCost,
        openDep: 0, depCharge, impairment: 0, dispDep: 0,
        closeDep: depCharge, openCarrying: openCost, closeCarrying,
      };
    });
    const ppeTotals = ppeClasses.reduce((t, c) => {
      ['openCost','additions','disposals','closeCost','depCharge','closeDep','openCarrying','closeCarrying']
        .forEach(k => { t[k] = (t[k] || 0) + c[k]; });
      return t;
    }, {});
    const depreciation = ppeTotals.depCharge || 0;

    // ════════════════════════════════════════════════
    //  PROFIT AND TAX
    // ════════════════════════════════════════════════
    const totalExpenses = materialsTotal + employeeTotal + financeTotal
                        + depreciation + incentive.amount + otherTotal;   // `SOI F25`
    const pbt = totalIncome - totalExpenses;                              // `SOI F27 =F16-F25`

    const profile = opt.taxProfile || 'corporate';
    let tax, taxRule;
    if (profile === 'progressive') {
      tax = progressiveTax(Math.max(0, pbt));
      taxRule = 'Proprietorship — progressive slabs';
    } else {
      tax = Math.max(0, pbt) * CORPORATE_TAX;    // `Sch-PL D75 =+SOI!F27*0.25`
      taxRule = 'Pvt. Ltd. / Partnership — 25% flat';
    }
    const priorPeriodTax = num(cy.priorPeriodTax);
    const taxExpense = tax + priorPeriodTax;     // `D77 =SUM(D75:D76)`
    const netProfit = pbt - taxExpense;          // `SOI F31 =F27-F29`

    if (pbt < 0) warn('Profit Before Tax is negative, so no tax has been provided. Check Purchases and Closing Stock.');

    // ════════════════════════════════════════════════
    //  BALANCE SHEET — derived statutory lines (Sch-BS)
    // ════════════════════════════════════════════════

    // `H18 =+J18-SOI!H29+SOI!F15*15%` — last year's advance tax, less the tax
    // that year's provision settled, plus this year's TDS on incentive income.
    const advanceTax = num(py.advanceTax) - num(py.taxExpense) + otherIncome * TDS.incentive;

    const tdsSalary    = employeeTotal    * TDS.salary;     // `H92`
    const tdsRent      = rent             * TDS.rent;       // `H93`
    const tdsIncentive = incentive.amount * TDS.incentive;  // `H94`
    const tdsWages     = labour.amount    * TDS.wages;      // `H95`
    const tdsAuditFee  = auditFee         * TDS.auditFee;   // `H97`
    const tdsFreight   = freight.amount   * TDS.freight;    // `H98`

    // `H89 ='Sch-PL'!D53-H97` — the fee payable is net of its own TDS.
    const auditFeePayable = auditFee - tdsAuditFee;

    const tradePayables = num(cy.tradePayables);
    // Each statutory line names the cell it withholds from, so the exported
    // workbook carries the firm's own =+'Sch-PL'!D61*10% rather than a pasted
    // figure. The fee-payable line subtracts the audit-fee TDS row by KEY
    // (pay6, its position in this list), never by a literal cell address.
    const payableLines = [
      { key: 'tradePayables',  name: 'Trade Payables',                 amount: tradePayables },
      { key: 'auditFeePayable',name: 'Audit Fee Payable',              amount: auditFeePayable,
        derive: { kind: 'net', sheet: 'SchPL', row: 'auditFee', less: 'pay7' } },
      { key: 'tdsSalary',      name: 'TDS Payable-Salary(SST)',        amount: tdsSalary,
        derive: { kind: 'pct', sheet: 'SchPL', row: 'empTotal', pct: TDS.salary } },
      { key: 'tdsRent',        name: 'TDS Payable-Rent',               amount: tdsRent,
        derive: { kind: 'pct', sheet: 'SchPL', row: 'rent', pct: TDS.rent } },
      { key: 'tdsIncentive',   name: 'TDS on Incentives',              amount: tdsIncentive,
        derive: { kind: 'pct', sheet: 'SOI', row: 'incentive', pct: TDS.incentive } },
      { key: 'tdsWages',       name: 'TDS Payable-Wages',              amount: tdsWages,
        derive: { kind: 'pct', sheet: 'SchPL', row: 'matDirect0', pct: TDS.wages } },
      // The firm's own 3.9 carries a SECOND wages line, left at nil — a spare
      // slot in their template for a further withholding of the same kind.
      // Reproduced because it sets where 3.10 Provisions starts, and it is
      // layout only: nil changes no total. (Unlike the workbook's +0.01 cash
      // plug, which moves a figure and is deliberately NOT reproduced.)
      { key: 'tdsWagesSpare',  name: 'TDS Payable-Wages',              amount: 0 },
      { key: 'tdsAuditFee',    name: 'TDS Payable-Audit fee',          amount: tdsAuditFee,
        derive: { kind: 'pct', sheet: 'SchPL', row: 'auditFee', pct: TDS.auditFee } },
      { key: 'tdsFreight',     name: 'TDS Payable-Clearing & Freight', amount: tdsFreight,
        derive: { kind: 'pct', sheet: 'SchPL', row: 'matDirect1', pct: TDS.freight } },
    ];
    const totalPayables = payableLines.reduce((s, l) => s + l.amount, 0);   // `H99`

    // Receivables (3.3) — trade receivables typed, advance tax derived.
    const tradeReceivables = num(cy.tradeReceivables);
    const impairment = num(cy.receivableImpairment);
    const vatReceivable = num(cy.vatReceivable);
    const tradeReceivablesNet = tradeReceivables - impairment;             // `H17 =H15-H16`
    const receivables = tradeReceivablesNet + advanceTax + vatReceivable;  // `H20`

    const cash = num(cy.cash);
    const inventories = closingStock;                    // `Sch-BS H29 ='Sch-PL'!D28`
    const investmentsNC = num(cy.investmentsNC);
    const investmentsC  = num(cy.investmentsC);
    const otherReceivablesNC = num(cy.otherReceivablesNC);

    const ppeClosing = ppeTotals.closeCarrying || 0;
    const totalNCA = ppeClosing + investmentsNC + otherReceivablesNC;
    const totalCA  = investmentsC + inventories + receivables + cash;
    const totalAssets = totalNCA + totalCA;

    // Provision for income tax is the year's own charge (`H102 =SOI!F29`).
    const provisionsC  = taxExpense;
    const provisionsNC = num(cy.provisionsNC);

    // Kept as LINES, not just totals: note 3.8 lists the client's own
    // facilities by name ("Vehicle Loan(EBL)", "Director Loan"), which is what
    // the firm's note shows and what makes it checkable against the sanction.
    const loanNCLines = (cy.loansNC || []).map(l => ({ name: l.name, amount: num(l.amount), py: num(l.py) }));
    const loanCLines  = (cy.loansC  || []).map(l => ({ name: l.name, amount: num(l.amount), py: num(l.py) }));
    const loansNonCurrent = loanNCLines.reduce((s, l) => s + l.amount, 0);
    const loansCurrent    = loanCLines.reduce((s, l) => s + l.amount, 0);

    const totalNCL = loansNonCurrent + provisionsNC;
    const totalCL  = loansCurrent + totalPayables + provisionsC;
    const totalLiabilities = totalNCL + totalCL;

    // Equity: capital carried, reserves rolled forward through the SOCE.
    const shareCapital   = cy.shareCapital == null ? num(py.shareCapital) : num(cy.shareCapital);
    const capitalIntro   = num(cy.capitalIntroduced);
    const dividend       = num(cy.dividend);
    const reservesOpen   = num(py.reserves);
    const reserves       = reservesOpen + netProfit - dividend;   // `SOCE I14 =SUM(I10:I13)`
    const totalEquity    = shareCapital + capitalIntro + reserves;
    const totalEquityLiab = totalLiabilities + totalEquity;

    // The balance check is SHOWN, never forced — a gap is a finding about the
    // inputs, the same rule Final Account and Audited Statement already follow.
    const balanceGap = totalEquityLiab - totalAssets;
    if (Math.abs(balanceGap) > 0.5) {
      warn(`Total Assets and Total Equity & Liabilities differ by ${balanceGap.toFixed(2)}. Nothing has been plugged — check Trade Receivables, Trade Payables, Cash and the loan balances.`);
    }

    // ════════════════════════════════════════════════
    //  CASH FLOW  (SOCF) — every line references SFP/SOI, so it is pure
    //  arithmetic over what is already solved above.
    // ════════════════════════════════════════════════
    const dRecv  = num(py.receivables) - receivables;      // `E18 =+SFP!H21-SFP!F21`
    const dStock = num(py.inventories) - inventories;      // `E19 =+SFP!H20-SFP!F20`
    const dPay   = totalPayables - num(py.payables);       // `E20 =+SFP!F40-SFP!H40`
    const lossOnSale = num(cy.lossOnSalePpe);              // `E16`
    // `E21 =E11+E13-E14+E15+SUM(E16:E20)` — note the SUM reaches E16:E20, so
    // it sweeps in row 17, the income-tax charge ADDED BACK. It is then paid
    // out again below as `E23`. Leaving the add-back out silently understates
    // operating cash by exactly one year's tax, which is what the harness
    // caught the first time this was written.
    const generated = netProfit + depreciation - interestIncome + financeTotal
                    + lossOnSale + taxExpense + dRecv + dStock + dPay;   // `E21`
    const interestPaid = financeTotal;                     // `E22 =+E15`
    const taxPaid = cy.taxPaid == null ? num(py.taxExpense) : num(cy.taxPaid);
    const netOperating = generated - interestPaid - taxPaid;

    const acquisitions = -(ppeTotals.additions || 0);      // `E26 =-'3.1 PPE'!P9`
    const disposalsProceeds = ppeTotals.disposals || 0;    // `E29`
    const investingMove = (num(py.investmentsNC) + num(py.investmentsC)) - (investmentsNC + investmentsC);
    const netInvesting = acquisitions + investingMove + interestIncome + disposalsProceeds;

    const capitalProceeds = shareCapital + capitalIntro - num(py.shareCapital);
    const ncBorrowMove = loansNonCurrent - num(py.loansNC);
    const cBorrowMove  = loansCurrent - num(py.loansC);
    const netFinancing = capitalProceeds + ncBorrowMove + cBorrowMove - dividend;

    const netIncrease = netOperating + netInvesting + netFinancing;
    const openingCash = num(py.cash);
    // NOTE: the source workbook writes `E44 =E38+E40+E42+0.01` — a hand-typed
    // one-paisa plug, which is why its own proof row reads 0.0121 rather than
    // nil. That plug is deliberately NOT reproduced; the residual is reported
    // as a finding instead (§4 of the module doc).
    const closingCash = netIncrease + openingCash;
    const cashProof = closingCash - cash;
    if (Math.abs(cashProof) > 0.5) {
      warn(`The cash flow closes at ${closingCash.toFixed(2)} against ${cash.toFixed(2)} on the balance sheet — a gap of ${cashProof.toFixed(2)}. Nothing has been plugged.`);
    }

    return {
      ratios: { salesRatio, driverRatio, growth },
      income: {
        revenueOps, interestIncome, otherIncome, totalIncome,
        materials: {
          opening: openingStock, purchases,
          directItems: [
            { key: 'labour',  name: 'Labour Charges',              amount: labour.amount,  py: labour.py,  rule: labour.rule,  derive: labour.derive },
            { key: 'freight', name: 'Clearing  & Freight Expenses', amount: freight.amount, py: freight.py, rule: freight.rule, derive: freight.derive },
          ],
          closing: closingStock, total: materialsTotal,
        },
        employeeItems: [
          { key: 'salary',       name: 'Salary Expenses',     amount: salary.amount,       py: salary.py,       rule: salary.rule,       derive: salary.derive },
          { key: 'otherContrib', name: 'Other Contributions', amount: otherContrib.amount, py: otherContrib.py, rule: otherContrib.rule, derive: otherContrib.derive },
        ],
        employeeTotal, salary: salary.amount,
        financeItems: [
          { key: 'interestOD',   name: 'Interest Expenses on STL/CC/OD', amount: interestOD },
          { key: 'interestTerm', name: 'Interest Expenses on Term ',     amount: interestTerm },
          { key: 'bankCharges',  name: 'Bank Charges',                   amount: bankCharges },
        ],
        financeTotal,
        depreciation,
        incentive: incentive.amount,
        otherItems: otherExpenses,
        otherTotal,
        totalExpenses, pbt, tax: taxExpense, netProfit,
        // Only the flat corporate rate is expressible as one cell formula;
        // progressive slabs are a schedule, so those export as a figure and
        // the COI sheet carries the working.
        taxDerive: profile === 'corporate' ? { kind: 'taxOnProfit', rate: CORPORATE_TAX } : null,
      },
      balance: {
        ppe: ppeClosing, investmentsNC, otherReceivablesNC, totalNCA,
        investmentsC, inventories,
        receivableLines: [
          { key: 'tradeReceivables', name: 'Trade Receivables', amount: tradeReceivables },
          { key: 'impairment',       name: 'Less: Provisions for impairment of trade receivables', amount: impairment },
          { key: 'advanceTax',       name: 'Advance Tax',       amount: advanceTax,
            derive: { kind: 'advanceTax', pct: TDS.incentive } },
          { key: 'vatReceivable',    name: 'VAT Receivables',   amount: vatReceivable },
        ],
        receivables, cash, totalCA, totalAssets,
        shareCapital, reserves, totalEquity,
        loansNonCurrent, provisionsNC, totalNCL, loanNCLines, loanCLines,
        loansCurrent, payableLines, totalPayables, provisionsC, totalCL,
        totalLiabilities, totalEquityLiab,
        balanceGap,
      },
      soce: { open: reservesOpen, close: reserves, profit: netProfit, capital: capitalIntro, dividend },
      ppe: { classes: ppeClasses, totals: ppeTotals },
      cashflow: {
        profit: netProfit, depreciation, interestIncome, financeCost: financeTotal,
        lossOnSale, taxAddBack: taxExpense,
        dRecv, dStock, dPay, generated, interestPaid, taxPaid, netOperating,
        acquisitions, investingMove, disposalsProceeds, netInvesting,
        capitalProceeds, ncBorrowMove, cBorrowMove, dividend, netFinancing,
        netIncrease, openingCash, closingCash, cashProof,
      },
      tax: { rule: taxRule, base: Math.max(0, pbt), onProfits: tax, priorPeriod: priorPeriodTax, total: taxExpense },
      tds: { salary: tdsSalary, rent: tdsRent, incentive: tdsIncentive, wages: tdsWages, auditFee: tdsAuditFee, freight: tdsFreight },
      issues,
    };
  }

  return {
    GROWTH, FLAT_LINES, PPE_RATES, TDS, CORPORATE_TAX, TAX_SLABS, RULES,
    xlRound, progressiveTax, applyRule, derive,
  };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// so tools/psVerify.mjs can replay the firm's own workbook through it.
if (typeof module !== 'undefined' && module.exports) module.exports = ProvisionalStatementEngine;
else window.ProvisionalStatementEngine = ProvisionalStatementEngine;
