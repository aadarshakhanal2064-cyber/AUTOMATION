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

  // The income-tax rule set (js/core/nepalTax.js). Browser: already a global,
  // because js/core/* loads before every feature module. Node: required, so
  // tools/psVerify.mjs keeps working by requiring this file alone.
  const Tax = (typeof module !== 'undefined' && module.exports)
    ? require('./core/nepalTax.js')
    : (typeof window !== 'undefined' ? window.NepalTax : null);

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
  // An override that distinguishes "not entered" from "entered as nil". null,
  // undefined and '' all mean derive it; 0 means the preparer really does mean
  // zero. Getting this wrong turns every blank box into a forced nil.
  const has = v => v !== null && v !== undefined && v !== '';
  // NOT named `pick` — derive() already has a local `pick(key)` for
  // other-expense lookup, and the shadowing turned every override into 0.
  const orDerived = (override, derived) => (has(override) ? num(override) : derived);

  // ── account-head spelling ──
  // The firm writes the same head several ways across clients ("Printing &
  // Stationery" / "Printing and Stationeries"). Left alone they are two heads:
  // one grows and the other sits at nil, and note 3.15 prints both.
  //
  // The key is case- and punctuation-insensitive on trimmed word content, the
  // same conservative rule wdWorkTypesForLabel() follows. It must never invent
  // a meaning — two heads collapse only when they are the same head spelled
  // differently, which is why the map is an explicit list rather than a
  // fuzzy match.
  const headKey = name => String(name == null ? '' : name)
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // The map's KEYS are normalised on read, so an author can write them the way
  // the head is actually spelled ("Printing & Stationery") instead of having to
  // pre-strip punctuation. Writing keys by hand in headKey form is how half the
  // aliases silently never matched the first time this was written.
  let _headMap = null, _headMapSrc = null;
  function headMap() {
    const raw = (typeof window !== 'undefined' && window.PS_HEAD_ALIASES) || {};
    if (_headMapSrc !== raw) {
      _headMapSrc = raw;
      _headMap = {};
      for (const k of Object.keys(raw)) _headMap[headKey(k)] = raw[k];
    }
    return _headMap;
  }

  function canonicalHead(name) {
    return headMap()[headKey(name)] || name;
  }

  // The two SPECIAL heads are recognised by NAME, never by a caller-supplied
  // key: the prior-year reader hands lines over as {name, amount} with no
  // keys, so a positional 'other3' used to reach the engine and pick() found
  // no 'auditFee' — Audit Fee Payable, TDS-Audit fee and TDS-Rent all derived
  // to 0 and the flat rule never applied (found 2026-08-28, via a real
  // upload; tools/psVerify.mjs never saw it because it supplies keys). Used
  // by the engine AND the module's rules grid, so override keys can't drift.
  function headKeyFor(name) {
    const n = headKey(canonicalHead(name));
    if (/\baudit fees?\b/.test(n)) return 'auditFee';
    if (/\brent\b/.test(n) && !/income/.test(n)) return 'rent';
    return null;
  }

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

  // ── the fallback tax basis ──
  //
  //  These two are what the engine charges when the caller supplies no
  //  `options.taxRule`. That is still every Provisional Statement and every
  //  Audited record saved before 2026-08-29, so they stay exactly as they
  //  were: a flat 25%, or one hardcoded ladder. Where a rule IS supplied,
  //  NepalTax answers instead and neither of these is consulted — see the
  //  tax block in derive().
  const CORPORATE_TAX = 0.25;   // `Sch-PL D75 =+SOI!F27*0.25`

  // Proprietorship slabs, carried from Projection. Deliberately NOT unified
  // with NepalTax's D-3 ladder — that one is the CA's own current-year rule
  // set and this one is the historical fallback, so unifying them would
  // silently restate every statement saved before the rule set existed.
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
  // Last year's profit margin carried onto this year's turnover — the firm's
  // own first guess at a provisional profit, and the default the PBT box opens
  // at. Exposed so the UI can seed the box without duplicating the arithmetic.
  //    profit(CY) = profit(PY) / sales(PY) x sales(CY)
  function pbtFromMargin(pyPbt, pySales, cySales) {
    return safeRatio(num(pyPbt), num(pySales)) * num(cySales);
  }

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
    //
    //  Purchases and Profit Before Tax are the two ends of one see-saw: fix
    //  either and the other follows. `solveFor` says which end is held, so a
    //  preparer can work from a purchase figure they have, or from a profit
    //  they need. The totals are identical either way — only which number is
    //  typed changes. The actual solve happens further down, once every other
    //  expense is known, because purchases is the residual of all of them.
    // ════════════════════════════════════════════════
    const openingStock = num(py.closingStock);
    const labour  = line('labour',  py.labour,  'turnover');   // `D25 =+F25/F6*D6`
    const freight = line('freight', py.freight, 'turnover');   // `D26 =+F26/F6*D6`
    // Closing stock: the detail schedule when there is one, else a typed
    // figure. Lines carry qty x rate so the sheet foots to its own arithmetic
    // rather than to a number someone re-keyed.
    const stockLines = (cy.stockLines || []).map(l => ({
      group: l.group || 'Finished Goods',
      particular: l.particular || '',
      qty: num(l.qty),
      rate: num(l.rate),
      // An amount typed directly wins over qty x rate — some lines are valued
      // in the round with no meaningful quantity.
      amount: has(l.amount) ? num(l.amount) : num(l.qty) * num(l.rate),
    }));
    const stockGroups = [];
    stockLines.forEach(l => {
      let g = stockGroups.find(x => x.group === l.group);
      if (!g) stockGroups.push(g = { group: l.group, amount: 0, lines: 0 });
      g.amount += l.amount;
      g.lines++;
    });
    const stockTotal = stockGroups.reduce((sum, g) => sum + g.amount, 0);
    const stockFromSchedule = stockLines.length > 0;
    // `let`, not `const`: the solveFor 'closingStock' mode below derives it
    // as the residual of the see-saw. A stock SCHEDULE always wins — the
    // schedule IS the figure (§15) and is never solved over.
    let closingStock = stockFromSchedule ? stockTotal : num(cy.closingStock);
    // A client's cost of sales carries heads beyond labour and freight —
    // packing, loading, commission on purchase. Each behaves exactly like the
    // two named ones: same rules, same override, same place in note 3.12.
    const directExtra = (py.directExtra || []).map((d, i) => {
      const key = d.key || ('direct' + i);
      const l = line(key, d.amount, 'growth', { roundTo: 0 });
      return { key, name: d.name, py: l.py, amount: l.amount, rule: l.rule, derive: l.derive };
    });
    const directExtraTotal = directExtra.reduce((sum, d) => sum + d.amount, 0);

    if (closingStock < 0) err('Closing stock is negative.');

    // ════════════════════════════════════════════════
    //  EMPLOYEE BENEFITS  (Sch-PL 3.13)
    //  `D33 =ROUND(F33*1.05,-3)` — nearest thousand.
    // ════════════════════════════════════════════════
    const salary = line('salary', py.salary, 'growth', { roundTo: -3 });
    // Other Contributions is emitted only when there is one. An always-present
    // nil row is a head with no value, which this module drops everywhere else.
    const otherContrib = line('otherContrib', py.otherContrib, 'growth', { roundTo: 0 });
    const hasOtherContrib = Math.abs(otherContrib.amount) > 0.005 || Math.abs(otherContrib.py) > 0.005;
    const employeeTotal = salary.amount + (hasOtherContrib ? otherContrib.amount : 0);

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
    // Merge duplicate spellings BEFORE the lines become rows, so a head the
    // firm writes two ways is one line carrying both years rather than two
    // lines each missing one.
    const mergedOther = [];
    (py.otherExpenses || []).forEach(e => {
      const name = canonicalHead(e.name);
      const hit = mergedOther.find(x => headKey(x.name) === headKey(name));
      if (hit) { hit.amount = num(hit.amount) + num(e.amount); hit.merged = (hit.merged || 1) + 1; }
      else mergedOther.push(Object.assign({}, e, { name }));
    });

    const otherExpenses = mergedOther.map(e => {
      // A positional key ('other3') yields to the name-recognised one, so
      // Audit Fee and Rent are found however the caller keyed them.
      const named = headKeyFor(e.name);
      const key = (e.key && !/^other\d+$/.test(e.key)) ? e.key : (named || e.key || e.name);
      const isFlat = FLAT_LINES.indexOf(key) >= 0;
      const l = line(key, e.amount, isFlat ? 'flat' : 'growth', { roundTo: 0 });
      return { key, name: e.name, py: l.py, amount: l.amount, rule: l.rule, growth: l.growth, derive: l.derive, merged: e.merged };
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
    // The dedicated incentive-expense row exists only for books that carry one;
    // otherwise it is a head with no value and is dropped. A client who needs
    // it can add it as an ordinary Other Expense line.
    const hasIncentive = Math.abs(num(py.incentiveExpense)) > 0.005;
    const incentive = line('incentiveExpense', py.incentiveExpense, 'driver');
    if (!hasIncentive) incentive.amount = 0;
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
      // Both computed columns accept an override. A schedule is a working, and
      // a preparer occasionally has to force a class to a figure the rate does
      // not produce — a part-year asset, or a carrying amount agreed with the
      // client. An override is remembered per class; clearing it returns to
      // the rate.
      const depCharge = c.depChargeOverride != null && c.depChargeOverride !== ''
        ? num(c.depChargeOverride) : xlRound(closeCost * rate, 10);   // `=+F11*5%`
      const closeCarrying = c.carryingOverride != null && c.carryingOverride !== ''
        ? num(c.carryingOverride) : closeCost - depCharge;            // `=+F11-F19`
      return {
        key: c.key, name: c.name || (def.name || c.key), rate,
        openCost, additions, disposals, closeCost,
        openDep: 0, depCharge, impairment: 0, dispDep: 0,
        closeDep: depCharge, openCarrying: openCost, closeCarrying,
        depChargeOverridden: c.depChargeOverride != null && c.depChargeOverride !== '',
        carryingOverridden: c.carryingOverride != null && c.carryingOverride !== '',
      };
    });
    const ppeTotals = ppeClasses.reduce((t, c) => {
      ['openCost','additions','disposals','closeCost','depCharge','closeDep','openCarrying','closeCarrying']
        .forEach(k => { t[k] = (t[k] || 0) + c[k]; });
      return t;
    }, {});
    const depreciation = ppeTotals.depCharge || 0;

    // ════════════════════════════════════════════════
    //  PROFIT AND TAX — and the purchases/PBT see-saw
    // ════════════════════════════════════════════════
    // Everything except materials is now known, so the two can be solved
    // against each other. Holding PBT makes purchases the residual, which is
    // the same arithmetic read backwards — no separate model, so the two modes
    // cannot drift apart.
    const nonMaterialExpenses = employeeTotal + financeTotal + depreciation
                              + incentive.amount + otherTotal;
    // The additive side of 3.12; closing stock subtracts from it per branch,
    // because in the third mode closing stock is what the branch derives.
    const stockCharge = openingStock + labour.amount + freight.amount + directExtraTotal;
    const pbtHeld = cy.pbtTarget != null && cy.pbtTarget !== '';

    let purchases, materialsTotal, pbt, solvedFor;
    if (opt.solveFor === 'purchases' && pbtHeld) {
      pbt = num(cy.pbtTarget);
      materialsTotal = totalIncome - pbt - nonMaterialExpenses;
      purchases = materialsTotal - (stockCharge - closingStock);
      solvedFor = 'purchases';
      // BLOCKING, not a warning (user decision 2026-08-29). A business cannot
      // have bought a negative quantity of goods, so a statement carrying one
      // is not a statement that can be issued — `level: 'error'` is what the
      // modules refuse to generate output on.
      if (purchases < 0) {
        err(`Purchases solves to a negative figure (${purchases.toFixed(2)}) at that profit. The target is unreachable with this year's sales, stock and expenses — lower the profit, or check Closing Stock.`);
      }
    } else if (opt.solveFor === 'closingStock' && pbtHeld && !stockFromSchedule) {
      // Third end of the same equation (user ask 2026-08-22): hold the
      // profit AND the typed purchases, and closing stock is the residual —
      // 3.12 read backwards once more, never a separate model. Guarded off
      // when a stock schedule exists: the schedule IS the figure (§15).
      pbt = num(cy.pbtTarget);
      purchases = num(cy.purchases);
      materialsTotal = totalIncome - pbt - nonMaterialExpenses;
      closingStock = stockCharge + purchases - materialsTotal;
      solvedFor = 'closingStock';
      if (closingStock < 0) {
        warn(`Closing Stock solves to a negative figure (${closingStock.toFixed(2)}) at that profit and purchases. The pair is unreachable with this year's sales and expenses — adjust one of them.`);
      }
    } else {
      purchases = num(cy.purchases);
      materialsTotal = (stockCharge - closingStock) + purchases;
      pbt = totalIncome - (materialsTotal + nonMaterialExpenses);
      solvedFor = 'pbt';
      if (purchases < 0) err('Purchases of goods is negative.');
    }
    const totalExpenses = materialsTotal + nonMaterialExpenses;   // `SOI F25`

    // ── the tax base: accounting profit, or a proper Computation of Income ──
    // Tier A of the firm's practice charges tax straight off accounting profit
    // (`Sch-PL D75 =+SOI!F27*0.25`). That is only right while accounting and
    // Income-Tax depreciation agree. The fuller engagements bridge them:
    //
    //    net profit  + depreciation per Accounting Standard
    //                − depreciation per Income Tax Act
    //                + brought-forward loss          = taxable income
    //
    // COI runs whenever an Income-Tax depreciation schedule was found (or the
    // preparer asks for it); otherwise the flat basis stands, so nothing an
    // existing simple engagement prints changes.
    const itDep = num(cy.itDepreciation);
    const bfLoss = num(cy.broughtForwardLoss);
    const useCoi = !!opt.useCoi;
    const taxableProfit = useCoi
      ? pbt + depreciation - itDep - bfLoss
      : pbt;
    if (useCoi && !itDep) {
      warn('The Computation of Income is on but no Income-Tax depreciation was found, so the bridge adds back accounting depreciation and deducts nothing. Check the client has a saved Income-Tax depreciation schedule.');
    }

    // ── the charge itself ──
    //
    //  With a rule set (`options.taxRule`) the charge comes from NepalTax,
    //  which is the firm's CA's own D-1 / D-2 / D-3 sheet as data. Two of
    //  those three do not read profit at all — a D-1 charge is a flat figure
    //  and a D-2 charge is a percentage of TURNOVER — which is why the rule
    //  is handed the revenue line as well, and why the result carries the
    //  workings rather than just a number.
    //
    //  Without one, the two-way fallback above stands. That is deliberate
    //  rather than a migration: a saved statement must reprint the figure it
    //  was issued with, and the Provisional module has not been given the
    //  rule picker.
    const profile = opt.taxProfile || 'corporate';
    let tax, taxRule, taxDetail = null;
    if (opt.taxRule && Tax) {
      taxDetail = Tax.compute(Object.assign(
        { entity: profile === 'progressive' ? 'proprietorship' : 'private' },
        opt.taxRule,
        { turnover: revenueOps, taxableProfit }
      ));
      tax = taxDetail.tax;
      taxRule = taxDetail.label;
      // A rule that disagrees with the figures is a finding about the inputs,
      // shown and never silently corrected (§15, the proof-row rule).
      taxDetail.warnings.forEach(w => warn(w));
      // A BREACH of the chosen return type's own eligibility band is not a
      // note -- the return cannot carry these figures at all, so it blocks
      // output exactly as a negative balancing figure does.
      (taxDetail.blocking || []).forEach(m => err(m));
    } else if (profile === 'progressive') {
      tax = progressiveTax(Math.max(0, taxableProfit));
      taxRule = 'Proprietorship — progressive slabs';
    } else {
      tax = Math.max(0, taxableProfit) * CORPORATE_TAX;
      taxRule = 'Pvt. Ltd. / Partnership — 25% flat';
    }
    if (useCoi) taxRule += ' on taxable income per COI';
    const priorPeriodTax = num(cy.priorPeriodTax);
    const taxExpense = tax + priorPeriodTax;     // `D77 =SUM(D75:D76)`
    const netProfit = pbt - taxExpense;          // `SOI F31 =F27-F29`

    // A turnover-based charge is still owed on a loss-making year, so this
    // sentence is only true where tax is charged on profit.
    if (pbt < 0 && (!taxDetail || taxDetail.base === 'profit')) {
      warn('Profit Before Tax is negative, so no tax has been provided. Check Purchases and Closing Stock.');
    } else if (pbt < 0) {
      warn(`Profit Before Tax is negative, but ${taxDetail.returnType} charges tax on turnover, so ${taxRule.split(' — ')[0]} is still provided. Check Purchases and Closing Stock.`);
    }

    // ════════════════════════════════════════════════
    //  BALANCE SHEET — derived statutory lines (Sch-BS)
    // ════════════════════════════════════════════════

    // `H18 =+J18-SOI!H29+SOI!F15*15%` — last year's advance tax, less the tax
    // that year's provision settled, plus this year's TDS on incentive income.
    // A typed figure wins: the formula is a good estimate, but the real advance
    // tax is whatever the client actually deposited and the preparer has the
    // challans.
    const advanceTaxDerived = num(py.advanceTax) - num(py.taxExpense) + otherIncome * TDS.incentive;
    // Advance tax has three possible sources, most specific first: the voucher
    // schedule (what the client actually deposited, with the challans behind
    // it), a typed figure, or the formula above. The schedule wins because it
    // is the only one that can be checked against a receipt.
    const advTaxLines = (cy.advanceTaxLines || []).map(l => ({
      office: l.office || '', voucherNo: l.voucherNo || '', date: l.date || '',
      name: l.name || '', pan: l.pan || '', amount: num(l.amount),
    }));
    const advTaxOpening = num(cy.advanceTaxOpening);
    const advTaxDeposited = advTaxLines.reduce((sum, l) => sum + l.amount, 0);
    const advTaxFromSchedule = advTaxLines.length > 0 || has(cy.advanceTaxOpening);
    const advanceTax = advTaxFromSchedule
      ? advTaxDeposited + advTaxOpening
      : orDerived(cy.advanceTax, advanceTaxDerived);
    const advanceTaxTyped = has(cy.advanceTax) && !advTaxFromSchedule;

    // A VAT-registered client sits on one side or the other at year end; a
    // PAN-only client on neither. Both are typed, because the position comes
    // off the return rather than out of the accounts.
    const vatRegistered = !!cy.vatRegistered;
    const vatReceivable = vatRegistered ? num(cy.vatReceivable) : 0;
    const vatPayable    = vatRegistered ? num(cy.vatPayable) : 0;
    if (vatRegistered && vatReceivable > 0.005 && vatPayable > 0.005) {
      warn('Both VAT Receivable and VAT Payable carry a figure. A return normally leaves the client on one side or the other — check which one this year actually is.');
    }

    // Each withholding is a percentage of the figure it is deducted from, and
    // each accepts a typed figure instead — a month's TDS is often paid on a
    // different base than the year's accounts show, and the preparer has the
    // deposit slips. A typed line loses its live Excel formula and becomes a
    // value, which is the honest representation of a figure that came from a
    // challan rather than from the accounts.
    const t = cy.tds || {};
    const tdsSalary    = orDerived(t.salary,    employeeTotal    * TDS.salary);     // `H92`
    const tdsRent      = orDerived(t.rent,      rent             * TDS.rent);       // `H93`
    const tdsIncentive = orDerived(t.incentive, incentive.amount * TDS.incentive);  // `H94`
    const tdsWages     = orDerived(t.wages,     labour.amount    * TDS.wages);      // `H95`
    const tdsAuditFee  = orDerived(t.auditFee,  auditFee         * TDS.auditFee);   // `H97`
    const tdsFreight   = orDerived(t.freight,   freight.amount   * TDS.freight);    // `H98`
    const tdsTyped = k => has(t[k]);

    // `H89 ='Sch-PL'!D53-H97` — the fee payable is net of its own TDS.
    const auditFeePayable = auditFee - tdsAuditFee;

    const tradePayables = num(cy.tradePayables);
    // Extra trading payables (Salary Payable, Expenses Payable…) — the lines
    // last year's note carried beyond the standard set, plus any the preparer
    // adds (user ask 2026-08-28: note 3.9 editable with add-line, the
    // other-expenses idiom). Typed balances, sitting between the trading
    // payables and the duties block; `pyName` keeps the prior-year spelling
    // so the comparative matcher still finds its figure after a rename.
    const extraPayables = (cy.extraPayables || []).map((l, i) => ({
      key: l.key || ('xpay' + i), name: l.name || 'Payable',
      amount: num(l.amount), py: num(l.py), pyName: l.pyName || l.name || '',
    }));
    // Each statutory line names the cell it withholds from, so the exported
    // workbook carries the firm's own =+'Sch-PL'!D61*10% rather than a pasted
    // figure. The fee-payable line subtracts the audit-fee TDS row by its
    // STABLE key ('tdsAuditFee'), never by list position — extras splice in
    // and zero-suppression drops rows, so a positional 'pay7' pointed at
    // whatever line happened to land seventh.
    const payableLines = [
      { key: 'tradePayables',  name: 'Trade Payables',                 amount: tradePayables },
      { key: 'auditFeePayable',name: 'Audit Fee Payable',              amount: auditFeePayable,
        derive: tdsTyped('auditFee') ? null : { kind: 'net', sheet: 'SchPL', row: 'auditFee', less: 'tdsAuditFee' } },
      ...extraPayables,
      { key: 'tdsSalary',      name: 'TDS Payable-Salary(SST)',        amount: tdsSalary,
        derive: tdsTyped('salary') ? null : { kind: 'pct', sheet: 'SchPL', row: 'empTotal', pct: TDS.salary } },
      { key: 'tdsRent',        name: 'TDS Payable-Rent',               amount: tdsRent,
        derive: tdsTyped('rent') ? null : { kind: 'pct', sheet: 'SchPL', row: 'rent', pct: TDS.rent } },
      { key: 'tdsIncentive',   name: 'TDS on Incentives',              amount: tdsIncentive,
        derive: tdsTyped('incentive') ? null : { kind: 'pct', sheet: 'SOI', row: 'incentive', pct: TDS.incentive } },
      { key: 'tdsWages',       name: 'TDS Payable-Wages',              amount: tdsWages,
        derive: tdsTyped('wages') ? null : { kind: 'pct', sheet: 'SchPL', row: 'matDirect0', pct: TDS.wages } },
      // The firm's own 3.9 carries a SECOND wages line, left at nil — a spare
      // slot in their template for a further withholding of the same kind.
      // Reproduced because it sets where 3.10 Provisions starts, and it is
      // layout only: nil changes no total. (Unlike the workbook's +0.01 cash
      // plug, which moves a figure and is deliberately NOT reproduced.)
      { key: 'tdsWagesSpare',  name: 'TDS Payable-Wages',              amount: 0 },
      { key: 'tdsAuditFee',    name: 'TDS Payable-Audit fee',          amount: tdsAuditFee,
        derive: tdsTyped('auditFee') ? null : { kind: 'pct', sheet: 'SchPL', row: 'auditFee', pct: TDS.auditFee } },
      { key: 'tdsFreight',     name: 'TDS Payable-Clearing & Freight', amount: tdsFreight,
        derive: tdsTyped('freight') ? null : { kind: 'pct', sheet: 'SchPL', row: 'matDirect1', pct: TDS.freight } },
      // VAT sits on whichever side the client's return leaves it. Only shown
      // for a VAT-registered client, and only the side that carries a figure —
      // a nil VAT row on a PAN-only client is a head with no value.
      ...(vatRegistered && Math.abs(vatPayable) > 0.005
        ? [{ key: 'vatPayable', name: 'VAT Payable', amount: vatPayable }] : []),
    ];
    const totalPayables = payableLines.reduce((s, l) => s + l.amount, 0);   // `H99`

    // Receivables (3.3) — advance tax derived; trade receivables either typed
    // or, by default, the figure that makes the sheet foot. Same choice the
    // Audited engine makes (§15: cash is seeded, receivables is the plug), and
    // for the same reason: profit lands in equity, so SOMETHING on the asset
    // side has to absorb it, and unbilled trade is the honest place. Turn the
    // plug off and the residual is reported instead of absorbed — shown, never
    // forced. Solved below, once equity and liabilities are known.
    const impairment = num(cy.receivableImpairment);

    const cash = num(cy.cash);
    const inventories = closingStock;                    // `Sch-BS H29 ='Sch-PL'!D28`
    // Note 3.4 shows the stock schedule's own groups rather than dropping the
    // whole figure onto Finished Goods — the firm's `stock!E11`/`E19` land on
    // separate Sch-BS rows for exactly this reason.
    const inventoryLines = stockFromSchedule
      ? stockGroups.map(g => ({ name: g.group, amount: g.amount }))
      : null;
    const investmentsNC = num(cy.investmentsNC);
    const investmentsC  = num(cy.investmentsC);
    const otherReceivablesNC = num(cy.otherReceivablesNC);
    const ppeClosing = ppeTotals.closeCarrying || 0;

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

    // ── the receivables plug ──
    // Everything else on the asset side is now fixed, so trade receivables is
    // whatever makes the two sides meet. `totalEquityLiab` does not depend on
    // it, so this is a direct solve rather than an iteration.
    // Extra receivable lines (Advance to Suppliers, Deposits…) — last year's
    // note beyond the standard set, plus preparer-added lines (user ask
    // 2026-08-28: note 3.3 editable with add-line). Typed balances inside the
    // note's total, so with the plug on they reduce the trade line, and with
    // it off they add to the total — exactly like Advance Tax and VAT.
    const extraReceivables = (cy.extraReceivables || []).map((l, i) => ({
      key: l.key || ('xrecv' + i), name: l.name || 'Receivable',
      amount: num(l.amount), py: num(l.py), pyName: l.pyName || l.name || '',
    }));
    const extraRecvTotal = extraReceivables.reduce((s, l) => s + l.amount, 0);
    const otherAssets = ppeClosing + investmentsNC + otherReceivablesNC
                      + investmentsC + inventories + cash;
    const plugReceivables = opt.balanceVia !== 'none';
    const receivables = plugReceivables
      ? totalEquityLiab - otherAssets
      : (num(cy.tradeReceivables) - impairment) + advanceTax + vatReceivable + extraRecvTotal;   // `H20`
    const tradeReceivablesNet = receivables - advanceTax - vatReceivable - extraRecvTotal;
    const tradeReceivables = tradeReceivablesNet + impairment;                  // `H17 =H15-H16`

    const totalNCA = ppeClosing + investmentsNC + otherReceivablesNC;
    const totalCA  = investmentsC + inventories + receivables + cash;
    const totalAssets = totalNCA + totalCA;

    // Shown, never forced. With the plug on this is nil by construction; with
    // it off a gap is a finding about the inputs, the same rule Final Account
    // and Audited Statement already follow.
    const balanceGap = totalEquityLiab - totalAssets;
    if (Math.abs(balanceGap) > 0.5) {
      warn(`Total Assets and Total Equity & Liabilities differ by ${balanceGap.toFixed(2)}. Nothing has been plugged — check Trade Receivables, Trade Payables, Cash and the loan balances.`);
    }
    // BLOCKING for the same reason as negative purchases: a negative debtor
    // balance is a creditor, so the plug has stopped meaning what the line
    // says it means and the balance sheet is not issuable as drawn.
    if (plugReceivables && tradeReceivables < 0) {
      err(`Trade Receivables balances to a negative figure (${tradeReceivables.toFixed(2)}). The profit is higher than the assets can carry — check Cash, Closing Stock and the loan balances, or lower the profit.`);
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
            ...directExtra,
          ],
          closing: closingStock, total: materialsTotal,
        },
        employeeItems: [
          { key: 'salary', name: 'Salary Expenses', amount: salary.amount, py: salary.py, rule: salary.rule, derive: salary.derive },
          ...(hasOtherContrib ? [{ key: 'otherContrib', name: 'Other Contributions', amount: otherContrib.amount, py: otherContrib.py, rule: otherContrib.rule, derive: otherContrib.derive }] : []),
        ],
        employeeTotal, salary: salary.amount,
        financeItems: [
          { key: 'interestOD',   name: 'Interest Expenses on STL/CC/OD', amount: interestOD },
          { key: 'interestTerm', name: 'Interest Expenses on Term ',     amount: interestTerm },
          { key: 'bankCharges',  name: 'Bank Charges',                   amount: bankCharges },
        ],
        financeTotal,
        depreciation,
        incentive: hasIncentive ? incentive.amount : 0,
        solvedFor,
        otherItems: otherExpenses,
        otherTotal,
        totalExpenses, pbt, tax: taxExpense, netProfit,
        // With COI on, Sch-PL's tax row points at the COI sheet — that is
        // where the figure is actually computed, and the workbook's own
        // `Sch-PL D62 =ROUND(COI!F18,)` does the same. Without it, and only on
        // the flat corporate rate, the rate is expressible as one cell formula;
        // progressive slabs are a schedule and export as a figure.
        // A rule set answers this itself: only D-3 on a company or a
        // partnership is a single rate on profit and so expressible as one
        // cell formula. A D-1 or D-2 charge reads turnover, and a
        // proprietor's ladder is a schedule — both export as a figure, the
        // same treatment a typed number gets.
        taxDerive: useCoi ? null
          : taxDetail ? (taxDetail.rate ? { kind: 'taxOnProfit', rate: taxDetail.rate } : null)
          : (profile === 'corporate' ? { kind: 'taxOnProfit', rate: CORPORATE_TAX } : null),
      },
      balance: {
        ppe: ppeClosing, investmentsNC, otherReceivablesNC, totalNCA,
        investmentsC, inventories,
        receivableLines: [
          { key: 'tradeReceivables', name: 'Trade Receivables', amount: tradeReceivables },
          { key: 'impairment',       name: 'Less: Provisions for impairment of trade receivables', amount: impairment },
          ...extraReceivables,
          { key: 'advanceTax',       name: 'Advance Tax',       amount: advanceTax,
            derive: advanceTaxTyped ? null : { kind: 'advanceTax', pct: TDS.incentive } },
          ...(vatRegistered && Math.abs(vatReceivable) > 0.005
            ? [{ key: 'vatReceivable', name: 'VAT Receivables', amount: vatReceivable }] : []),
        ],
        receivables, cash, totalCA, totalAssets, plugReceivables, tradeReceivables,
        inventoryLines,
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
      // `detail` is the NepalTax result when a rule set was supplied — the
      // return type, the workings behind the charge and any warnings — so the
      // screen can show the arithmetic instead of asserting a figure. Null on
      // the fallback basis.
      tax: { rule: taxRule, base: Math.max(0, taxableProfit), onProfits: tax, priorPeriod: priorPeriodTax, total: taxExpense, detail: taxDetail },
      // The COI bridge, whether or not it is printed — the reconciliation
      // panel checks it foots even on a Tier A set.
      coi: {
        active: useCoi,
        pbt,
        accountingDep: depreciation,
        itDep,
        bfLoss,
        taxableProfit,
        tax,
        rule: taxRule,
        // The bridge must reproduce the taxable figure the tax was charged on.
        bridgeOk: !useCoi || Math.abs((pbt + depreciation - itDep - bfLoss) - taxableProfit) < 0.005,
      },
      tds: { salary: tdsSalary, rent: tdsRent, incentive: tdsIncentive, wages: tdsWages, auditFee: tdsAuditFee, freight: tdsFreight },
      vat: { registered: vatRegistered, receivable: vatReceivable, payable: vatPayable },
      advanceTax: {
        amount: advanceTax, typed: advanceTaxTyped, derived: advanceTaxDerived,
        fromSchedule: advTaxFromSchedule, opening: advTaxOpening,
        deposited: advTaxDeposited, lines: advTaxLines,
      },
      stock: {
        fromSchedule: stockFromSchedule, total: stockTotal,
        groups: stockGroups, lines: stockLines,
      },
      issues,
    };
  }

  return {
    GROWTH, FLAT_LINES, PPE_RATES, TDS, CORPORATE_TAX, TAX_SLABS, RULES,
    xlRound, progressiveTax, applyRule, derive, pbtFromMargin,
    canonicalHead, headKey, headKeyFor,
  };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// so tools/psVerify.mjs can replay the firm's own workbook through it.
if (typeof module !== 'undefined' && module.exports) module.exports = ProvisionalStatementEngine;
else window.ProvisionalStatementEngine = ProvisionalStatementEngine;
