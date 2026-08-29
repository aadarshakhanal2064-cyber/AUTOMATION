// ════════════════════════════════════════════════════════════════════════
//  TRIAL BALANCE MODEL — a typed trial balance and the statements it makes
//
//  The statement modules take a FINISHED year apart: last year from the prior
//  year's workbook, this year figure by figure, and a solver plugs whatever is
//  left over. This engine does the opposite and much smaller thing: it holds a
//  trial balance the preparer TYPES, in the firm's own layout, and draws the
//  balance sheet and income statement straight off it — no solver, no plug, no
//  prior year. Every figure on the statements is a figure on the trial balance
//  or a sum of them.
//
//  Which is what makes the binding work in BOTH directions. There is one set
//  of numbers here, viewed two ways; typing into either view writes into the
//  same numbers.
//
//  ── THE IDENTITY EVERYTHING RESTS ON ──────────────────────────────────
//
//  A trial balance foots when
//
//      Assets + Expenses  =  Revenue + Equity and Liabilities
//
//  and a balance sheet balances when
//
//      Assets  =  Equity and Liabilities + (Revenue − Expenses)
//
//  Those are the same statement rearranged. So the balance sheet balances if
//  and only if the trial balance foots, and the difference is the SAME NUMBER
//  on both screens — which is why this engine reports one figure and both
//  views show it. The reference file the format came from proves it:
//
//      31,966,597.69 = 40,748,258.01 + (88,618,378.80 − 97,400,039.12)
//
//  The consequence worth stating plainly: the year's profit is not a figure
//  anyone types. It is Revenue less Expenses, and it lands in Reserves. That
//  is the ONLY place equity gets it from, and it is why editing Reserves on
//  the balance sheet writes `value − profit` back to the ledger rather than
//  the value itself (see APPLY, below).
//
//  ── WHAT IS NOT HERE, AND WHY ─────────────────────────────────────────
//
//  · No opening stock. This trial balance is post-closing: inventories is a
//    balance-sheet asset and purchases is the expense, so profit really is
//    Revenue − Expenses. An opening-stock box would break the identity above
//    unless it were also a trial-balance row, and it is not one.
//  · No depreciation line on the income statement. The trial balance decides
//    the expense heads; whatever the client charged sits inside one of its own
//    five expense sections, and inventing a sixth would print a head their
//    ledger does not carry.
//  · No income tax charge unless the preparer NAMES the ledger line that is
//    one. Nothing here can tell an income-tax provision from a road tax, and
//    guessing would misstate profit before tax on a statement someone signs.
//
//  ── SHARED, NOT COPIED ────────────────────────────────────────────────
//
//  The section vocabulary, the revenue split and the loan facility groups are
//  TrialBalanceReader's (js/core/trialBalanceReader.js) — a typed trial
//  balance and an imported one are the same document, so they are recognised
//  by one set of spellings. The Trial Balance PAGE and the pass that turns
//  statement cells into live `='Trial Balance'!E11` references belong to the
//  export layer (fsxTbSheet / fsxLinkToTb); this engine hands it a report
//  shape and lets it draw.
//
//  No DOM and no export-layer import: the column geometry arrives as an
//  argument, so the whole engine stays loadable in Node and
//  tools/tbsVerify.mjs can replay a trial balance through it.
//
//  Run:  node tools/tbsVerify.mjs   — before and after touching this file.
// ════════════════════════════════════════════════════════════════════════

const TrialBalanceModel = (() => {

  const TBR = (typeof module !== 'undefined' && module.exports)
    ? require('./trialBalanceReader.js')
    : (typeof window !== 'undefined' ? window.TrialBalanceReader : null);

  const VERSION = 1;
  const EPS = 0.005;
  const num = v => {
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  };
  const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
  const nil = v => Math.abs(Number(v) || 0) < EPS;

  // ════════════════════════════════════════════════════════════════
  //  THE SKELETON
  //
  //  Exactly the sections the firm's own trial balance draws, in its order,
  //  with its numbering. `id` is TrialBalanceReader's id for the same section,
  //  so an imported trial balance and a typed one land on the same keys — and
  //  so the export layer's `sec_<block>_<id>` row keys match either way.
  //
  //  Sections are FIXED. They are the statements' own vocabulary: a head that
  //  does not fit one of them does not have a place on the balance sheet
  //  either. Detail LINES inside a section are entirely the preparer's.
  // ════════════════════════════════════════════════════════════════

  const SKELETON = [
    { block: 'assets', title: 'A. Assets', side: 'dr', sections: [
      { id: 'ppe',              n: 1, title: 'Property, Plant and Equipment' },
      { id: 'investments',      n: 2, title: 'Investments' },
      { id: 'otherReceivables', n: 3, title: 'Other Receivables' },
      { id: 'inventories',      n: 4, title: 'Inventories' },
      { id: 'tradeReceivables', n: 5, title: 'Trade Receivables' },
      { id: 'vatReceivable',    n: 6, title: 'VAT Receivables' },
      { id: 'advanceTax',       n: 7, title: 'Advance Tax & TDS Receivables' },
      { id: 'prepayments',      n: 8, title: 'Prepayments' },
      { id: 'cash',             n: 9, title: 'Cash and Cash Equivalents' },
    ] },
    { block: 'expenses', title: 'B. Expenses', side: 'dr', sections: [
      { id: 'purchases',      n: 1, title: 'Purchase' },
      { id: 'directExpenses', n: 2, title: 'Direct Expenses' },
      { id: 'employee',       n: 3, title: 'Employee Benefits Expenses' },
      { id: 'financeCost',    n: 4, title: 'Finance Cost' },
      { id: 'otherExpenses',  n: 5, title: 'Other Expenses' },
    ] },
    // The reference file heads this block "C. Revenue" and then repeats
    // "C.Revenue" as its single section — kept, so the printed page reads like
    // the firm's own sheet rather than like our tidier version of it.
    { block: 'revenue', title: 'C. Revenue', side: 'cr', sections: [
      { id: 'revenue', n: 0, title: 'Revenue' },
    ] },
    { block: 'equity', title: 'D. Equity and Liabilities', side: 'cr', sections: [
      { id: 'shareCapital',  n: 1, title: 'Share Capital', capital: true },
      { id: 'reserves',      n: 2, title: 'Reserves' },
      { id: 'loans',         n: 3, title: 'Loans and Borrowings' },
      { id: 'tradePayables', n: 4, title: 'Trade Payables' },
      { id: 'dutiesTaxes',   n: 5, title: 'Duties and taxes' },
    ] },
  ];

  const SECTION_SPEC = {};
  const SECTION_BLOCK = {};
  for (const b of SKELETON) {
    for (const s of b.sections) { SECTION_SPEC[s.id] = s; SECTION_BLOCK[s.id] = b.block; }
  }
  const SECTION_IDS = Object.keys(SECTION_SPEC);

  // The section title as the trial balance prints it: "5. Trade Receivables".
  // `capitalLabel` overrides the equity capital head, because a proprietorship's
  // ledger says "Proprietors Capital" and its balance sheet has to agree
  // (CLAUDE.md §15 — the capital heading follows the entity).
  function sectionTitle(spec, opts) {
    const label = (spec.capital && opts && opts.capitalLabel) ? opts.capitalLabel : spec.title;
    return spec.n ? `${spec.n}. ${label}` : label;
  }

  // ════════════════════════════════════════════════════════════════
  //  STATE
  //
  //  { version, sections: { <id>: { amount, lines: [{name, amount, adj, side}] } },
  //    taxLine, loanSide: { <lineName>: 'nc'|'c' } }
  //
  //  A section's TOTAL is the sum of its lines when it has any, and its own
  //  `amount` when it has none. Both shapes exist in the firm's own file —
  //  Inventories is a bare figure, Trade Receivables is four party lines — so
  //  both are typeable rather than one being forced into the other.
  // ════════════════════════════════════════════════════════════════

  function blank() {
    const sections = {};
    for (const id of SECTION_IDS) sections[id] = { amount: 0, lines: [] };
    return { version: VERSION, sections, taxLine: null, loanSide: {} };
  }

  // Fills in whatever a stored state is missing rather than rejecting it — a
  // row saved before a section existed must still open.
  function normalize(state) {
    const s = state && typeof state === 'object' ? state : {};
    const out = { version: VERSION, sections: {}, taxLine: s.taxLine || null, loanSide: {} };
    const src = s.sections || {};
    for (const id of SECTION_IDS) {
      const sec = src[id] || {};
      out.sections[id] = {
        amount: r2(num(sec.amount)),
        lines: (Array.isArray(sec.lines) ? sec.lines : [])
          .map(l => ({
            name: String((l && l.name) || '').trim(),
            amount: r2(num(l && l.amount)),
            adj: !!(l && l.adj),
            // The statement an adjustment came from, so the two never collide
            // in one section and each can be found again to be updated.
            from: (l && l.from) || null,
            side: (l && l.side) || null,
          }))
          // A line with neither a name nor a figure is a row someone started
          // and abandoned; it is not a ledger balance.
          .filter(l => l.name || !nil(l.amount)),
      };
    }
    const ls = s.loanSide || {};
    for (const k of Object.keys(ls)) if (ls[k] === 'nc' || ls[k] === 'c') out.loanSide[k] = ls[k];
    return out;
  }

  const sectionTotal = sec =>
    r2(sec && sec.lines && sec.lines.length
      ? sec.lines.reduce((t, l) => t + num(l.amount), 0)
      : num(sec && sec.amount));

  function totals(state) {
    const st = state.sections ? state : normalize(state);
    const sec = {}, blocks = {};
    for (const b of SKELETON) {
      let bt = 0;
      for (const s of b.sections) { sec[s.id] = sectionTotal(st.sections[s.id]); bt += sec[s.id]; }
      blocks[b.block] = r2(bt);
    }
    const debits = r2(blocks.assets + blocks.expenses);
    const credits = r2(blocks.revenue + blocks.equity);
    const difference = r2(debits - credits);
    return { sec, blocks, debits, credits, difference, foots: Math.abs(difference) <= 0.5 };
  }

  // ════════════════════════════════════════════════════════════════
  //  toReport — the reader's own report shape, so the export layer's
  //  fsxTbSheet() draws a typed trial balance and an imported one from
  //  exactly the same code.
  // ════════════════════════════════════════════════════════════════

  function toReport(state, opts) {
    const st = normalize(state);
    const t = totals(st);
    const blocks = SKELETON.map(b => ({
      id: b.block, title: b.title, side: b.side,
      sections: b.sections.map(s => {
        const full = sectionTitle(s, opts);
        return {
          id: s.id,
          title: full,
          // Numbering stripped, for the "Total Trade Receivables" line the
          // page draws under a section that has detail.
          shortTitle: full.replace(/^\s*\d+\.\s*/, ''),
          total: t.sec[s.id],
          lines: st.sections[s.id].lines.map(l => ({ name: l.name || '(unnamed)', amount: l.amount })),
        };
      }),
    }));
    return {
      blocks,
      check: { debits: t.debits, credits: t.credits, difference: t.difference, foots: t.foots },
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  LOANS — which facilities are non-current
  //
  //  Read from the facility NAME through TrialBalanceReader.LOAN_GROUPS, the
  //  same table the imported path uses: term / PWC / hire-purchase are
  //  non-current, everything else (overdraft, CC, demand, working capital) is
  //  current. `state.loanSide` overrides per line, because whether a facility
  //  is current is a fact about the sanction letter, not about its name.
  //
  //  A section with no lines at all cannot be split, so its whole balance is
  //  reported as current — a loan nobody has broken out is far more often an
  //  overdraft than a term loan, and the figure is visible either way.
  // ════════════════════════════════════════════════════════════════

  function loanSideOf(state, line) {
    const st = state.sections ? state : normalize(state);
    if (line.side === 'nc' || line.side === 'c') return line.side;
    const override = st.loanSide[line.name];
    if (override) return override;
    const grp = TBR ? TBR.classify(TBR.LOAN_GROUPS, line.name || '') : 'st';
    return (grp === 'lt' || grp === 'pwc' || grp === 'hp') ? 'nc' : 'c';
  }

  function loanSplit(state) {
    const st = state.sections ? state : normalize(state);
    const sec = st.sections.loans;
    const out = { nc: 0, c: 0, lines: [] };
    if (!sec.lines.length) { out.c = sectionTotal(sec); return out; }
    for (const l of sec.lines) {
      const side = loanSideOf(st, l);
      out[side] = r2(out[side] + num(l.amount));
      out.lines.push({ name: l.name, amount: l.amount, side });
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════
  //  REVENUE — operations / interest / other
  //
  //  Split by TrialBalanceReader.REVENUE_LINES. A revenue section with no
  //  detail lines, or whose lines match nothing, is ALL revenue from
  //  operations: turnover is the one figure nothing else can stand in for,
  //  and reporting it as "other income" because a spelling was unfamiliar
  //  would move it off the face of the statement.
  // ════════════════════════════════════════════════════════════════

  function revenueSplit(state) {
    const st = state.sections ? state : normalize(state);
    const sec = st.sections.revenue;
    const total = sectionTotal(sec);
    const out = { sales: 0, interestIncome: 0, otherIncome: 0, total };
    if (!sec.lines.length) { out.sales = total; return out; }
    for (const l of sec.lines) {
      const id = (TBR ? TBR.classify(TBR.REVENUE_LINES, l.name || '') : null) || 'sales';
      out[id] = r2(out[id] + num(l.amount));
    }
    return out;
  }

  // The ledger line the preparer has named as the income tax charge, if any.
  // Always looked up inside Other Expenses: a tax provision is an expense, and
  // letting it be any line anywhere would let the same figure be lifted out of
  // a section that is not on the income statement's expense side at all.
  function taxCharge(state) {
    const st = state.sections ? state : normalize(state);
    if (!st.taxLine) return { amount: 0, name: null };
    const hit = st.sections.otherExpenses.lines.find(l => l.name === st.taxLine);
    return hit ? { amount: r2(num(hit.amount)), name: hit.name } : { amount: 0, name: null };
  }

  // ════════════════════════════════════════════════════════════════
  //  THE STATEMENT ROWS
  //
  //  ONE table drives the printed sheet, the on-screen editor and the
  //  write-back. A row's `src` says where its figure comes from, and that is
  //  the same description `applyEdit` reverses — so a row can never be
  //  displayed from one place and written back to another.
  //
  //  src kinds:
  //    section   one trial-balance section, 1:1
  //    sum       several sections; `primary` takes any adjustment
  //    reserves  the reserves section PLUS the year's profit
  //    loans     the loans section, one side of the current/non-current split
  //    expenses  a section less the line named as the income tax charge
  //    calc      derived from other rows; never editable
  // ════════════════════════════════════════════════════════════════

  const SFP_ROWS = [
    { kind: 'head', label: 'A. Assets:' },
    { kind: 'sub',  label: 'I. Non-Current Assets' },
    { kind: 'item', k: 'ppe',       label: 'Property, Plant and Equipment', note: '3.1', src: { kind: 'section', id: 'ppe' } },
    // The trial balance carries ONE investments head, so it is reported
    // non-current — the conventional reading, and the only one the ledger
    // supports. A client holding current investments breaks them out as their
    // own line and the preparer moves the figure; the statement never guesses
    // a split the ledger does not state.
    { kind: 'item', k: 'invNC',     label: 'Investments', note: '3.2', src: { kind: 'section', id: 'investments' } },
    { kind: 'item', k: 'othRecNC',  label: 'Other Receivables', note: '3.3', src: { kind: 'section', id: 'otherReceivables' } },
    { kind: 'tot',  k: 'totalNCA',  label: 'Total Non-Current Assets', xsum: ['ppe', 'invNC', 'othRecNC'] },
    { kind: 'blank' },
    { kind: 'sub',  label: 'II. Current Assets' },
    { kind: 'item', k: 'stock',     label: 'Inventories', note: '3.4', src: { kind: 'section', id: 'inventories' } },
    { kind: 'item', k: 'recv',      label: 'Trade and Other Receivables', note: '3.3',
      src: { kind: 'sum', ids: ['tradeReceivables', 'vatReceivable', 'advanceTax', 'prepayments'], primary: 'tradeReceivables' } },
    { kind: 'item', k: 'cash',      label: 'Cash and Cash Equivalents', note: '3.5', src: { kind: 'section', id: 'cash' } },
    { kind: 'tot',  k: 'totalCA',   label: 'Total Current Assets', xsum: ['stock', 'recv', 'cash'] },
    { kind: 'blank' },
    { kind: 'grand', k: 'totalAssets', label: 'Total Assets', xsum: ['totalNCA', 'totalCA'] },
    { kind: 'blank' },
    { kind: 'head', label: 'B. Equity and Liabilities:' },
    { kind: 'sub',  label: 'I. Equity' },
    { kind: 'item', k: 'capital',   label: 'Share Capital', capital: true, note: '3.6', src: { kind: 'section', id: 'shareCapital' } },
    { kind: 'item', k: 'reserves',  label: 'Reserves', note: '3.7', src: { kind: 'reserves' } },
    { kind: 'tot',  k: 'totalEquity', label: 'Total Equity', xsum: ['capital', 'reserves'] },
    { kind: 'blank' },
    { kind: 'sub',  label: 'II. Non-Current Liabilities' },
    { kind: 'item', k: 'loanNC',    label: 'Loans and Borrowings', note: '3.8', src: { kind: 'loans', side: 'nc' } },
    { kind: 'tot',  k: 'totalNCL',  label: 'Total Non-Current Liabilities', xsum: ['loanNC'] },
    { kind: 'blank' },
    { kind: 'sub',  label: 'III. Current Liabilities' },
    { kind: 'item', k: 'loanC',     label: 'Loans and Borrowings', note: '3.8', src: { kind: 'loans', side: 'c' } },
    { kind: 'item', k: 'pay',       label: 'Trade & Other Payables', note: '3.9',
      src: { kind: 'sum', ids: ['tradePayables', 'dutiesTaxes'], primary: 'tradePayables' } },
    { kind: 'tot',  k: 'totalCL',   label: 'Total Current Liabilities', xsum: ['loanC', 'pay'] },
    { kind: 'blank' },
    { kind: 'tot',  k: 'totalLiab', label: 'Total Liabilities', xsum: ['totalNCL', 'totalCL'], noTopRule: true },
    { kind: 'blank' },
    { kind: 'grand', k: 'totalEL',  label: 'Total Equity and Liabilities', xsum: ['totalLiab', 'totalEquity'], noTopRule: true },
  ];

  // The expense side is lettered a)–e) in the audited statement's style, but
  // the LINES are the trial balance's own five sections rather than the
  // audited set. That is not a shortcut: it makes every expense row map 1:1 to
  // one ledger section, which is what lets the preparer type into either view
  // and have the other agree without anything being apportioned.
  const SOI_ROWS = [
    { kind: 'head', label: 'A. INCOMES:' },
    { kind: 'item', k: 'rev',      label: 'I. Revenue From Operations', note: '3.11', src: { kind: 'revenue', part: 'sales' } },
    { kind: 'sub',  label: 'II. Revenue From Non-Operations' },
    { kind: 'item', k: 'intInc',   label: 'a) Interest Income', note: '3.11', src: { kind: 'revenue', part: 'interestIncome' } },
    { kind: 'item', k: 'othInc',   label: 'b) Other Income', note: '3.11', src: { kind: 'revenue', part: 'otherIncome' } },
    { kind: 'tot',  k: 'totalIncome', label: 'Total Income', xsum: ['rev', 'intInc', 'othInc'] },
    { kind: 'blank' },
    { kind: 'head', label: 'B. EXPENSES' },
    { kind: 'item', k: 'purchases', label: 'a) Purchase', note: '3.12', src: { kind: 'section', id: 'purchases' } },
    { kind: 'item', k: 'direct',    label: 'b) Direct Expenses', note: '3.12', src: { kind: 'section', id: 'directExpenses' } },
    { kind: 'item', k: 'employee',  label: 'c) Employee Benefit Expenses', note: '3.13', src: { kind: 'section', id: 'employee' } },
    { kind: 'item', k: 'finance',   label: 'd) Finance Cost', note: '3.14', src: { kind: 'section', id: 'financeCost' } },
    { kind: 'item', k: 'other',     label: 'e) Other Expenses', note: '3.15', src: { kind: 'expenses', id: 'otherExpenses' } },
    { kind: 'tot',  k: 'totalExpenses', label: 'Total Expenses', xsum: ['purchases', 'direct', 'employee', 'finance', 'other'] },
    { kind: 'blank' },
    { kind: 'tot',  k: 'pbt',      label: 'Profit Before Tax', src: { kind: 'calc' } },
    { kind: 'blank' },
    // Printed only when a ledger line has been named as the charge. An
    // "Income Tax Expenses — nil" row on a statement that in fact charges tax
    // inside Other Expenses is worse than no row at all.
    { kind: 'item', k: 'tax',      label: 'Income Tax Expenses', note: '3.16', taxRow: true, src: { kind: 'taxLine' } },
    { kind: 'blank', taxRow: true },
    { kind: 'grand', k: 'np',      label: 'Profit / (Loss) For the Year', src: { kind: 'calc' } },
  ];

  const ROW_BY_KEY = {};
  for (const r of SFP_ROWS) if (r.k) ROW_BY_KEY[r.k] = { sheet: 'SFP', row: r };
  for (const r of SOI_ROWS) if (r.k) ROW_BY_KEY[r.k] = { sheet: 'SOI', row: r };

  // ════════════════════════════════════════════════════════════════
  //  DERIVE — the two statements, from the trial balance alone
  // ════════════════════════════════════════════════════════════════

  function derive(state, opts) {
    const o = opts || {};
    const st = normalize(state);
    const t = totals(st);
    const rev = revenueSplit(st);
    const loans = loanSplit(st);
    const tax = taxCharge(st);
    const issues = [];

    // The whole engine in one line: what the ledger has left over after the
    // year's expenses is the year's profit, and it belongs to the owners.
    const profit = r2(t.blocks.revenue - t.blocks.expenses);

    const v = {};
    v.ppe = t.sec.ppe;
    v.invNC = t.sec.investments;
    v.othRecNC = t.sec.otherReceivables;
    v.totalNCA = r2(v.ppe + v.invNC + v.othRecNC);
    v.stock = t.sec.inventories;
    v.recv = r2(t.sec.tradeReceivables + t.sec.vatReceivable + t.sec.advanceTax + t.sec.prepayments);
    v.cash = t.sec.cash;
    v.totalCA = r2(v.stock + v.recv + v.cash);
    v.totalAssets = r2(v.totalNCA + v.totalCA);
    v.capital = t.sec.shareCapital;
    v.reserves = r2(t.sec.reserves + profit);
    v.totalEquity = r2(v.capital + v.reserves);
    v.loanNC = loans.nc;
    v.totalNCL = v.loanNC;
    v.loanC = loans.c;
    v.pay = r2(t.sec.tradePayables + t.sec.dutiesTaxes);
    v.totalCL = r2(v.loanC + v.pay);
    v.totalLiab = r2(v.totalNCL + v.totalCL);
    v.totalEL = r2(v.totalLiab + v.totalEquity);

    v.rev = rev.sales;
    v.intInc = rev.interestIncome;
    v.othInc = rev.otherIncome;
    v.totalIncome = rev.total;
    v.purchases = t.sec.purchases;
    v.direct = t.sec.directExpenses;
    v.employee = t.sec.employee;
    v.finance = t.sec.financeCost;
    v.other = r2(t.sec.otherExpenses - tax.amount);
    v.totalExpenses = r2(v.purchases + v.direct + v.employee + v.finance + v.other);
    v.pbt = r2(v.totalIncome - v.totalExpenses);
    v.tax = tax.amount;
    v.np = r2(v.pbt - v.tax);

    // ── the one check, stated from both sides ──
    // These are arithmetically the same number (see the header). Computing the
    // balance-sheet gap independently rather than copying the trial difference
    // is what would catch a mapping mistake in this function — a section left
    // out of the balance sheet shows up here and nowhere else.
    const bsGap = r2(v.totalAssets - v.totalEL);
    if (Math.abs(bsGap - t.difference) > 0.05) {
      issues.push({ level: 'error', msg:
        `The balance sheet is out by ${Math.abs(bsGap).toFixed(2)} while the trial balance is out by ${Math.abs(t.difference).toFixed(2)}. Those must agree — a trial-balance section is not reaching the balance sheet.` });
    } else if (!t.foots) {
      issues.push({ level: 'warn', msg:
        `The trial balance does not foot: assets and expenses come to ${t.difference > 0 ? 'more' : 'less'} than revenue, equity and liabilities by ${Math.abs(t.difference).toFixed(2)}. The balance sheet is out by the same amount, and both are shown rather than forced.` });
    }
    if (nil(t.blocks.revenue) && nil(t.blocks.expenses) && nil(t.blocks.assets) && nil(t.blocks.equity)) {
      issues.push({ level: 'info', msg: 'Nothing typed yet — the statements fill in as the trial balance does.' });
    }
    if (profit < 0 && !nil(profit)) {
      issues.push({ level: 'info', msg:
        `The year is a loss of ${Math.abs(profit).toFixed(2)}, so Reserves carries ${v.reserves.toFixed(2)} after it — ${t.sec.reserves.toFixed(2)} brought forward less the loss.` });
    }
    if (st.taxLine && !tax.name) {
      issues.push({ level: 'warn', msg:
        `"${st.taxLine}" was named as the income tax charge but is no longer a line in Other Expenses, so no tax is charged. Pick the line again.` });
    }

    return { values: v, profit, totals: t, revenue: rev, loans, tax, check: t, issues };
  }

  // ════════════════════════════════════════════════════════════════
  //  BUILD SHEETS — the two statements as export-layer sheet models
  //
  //  GEOM is passed in (the export layer's FSX_GEOM) rather than imported, so
  //  this file keeps no dependency on the feature layer and stays loadable in
  //  Node. The caller assembles the Trial Balance page beside these two with
  //  fsxTbSheet(), so all three pages come out of one renderer.
  // ════════════════════════════════════════════════════════════════

  function buildSheets(state, opts, GEOM) {
    const o = opts || {};
    const d = derive(state, o);
    const v = d.values;
    const showTax = !!d.tax.name;

    const toRows = (spec) => {
      const out = [];
      for (const r of spec) {
        if (r.taxRow && !showTax) continue;
        if (r.kind === 'blank') { out.push({ label: '', vals: [], kind: 'blank' }); continue; }
        const label = (r.capital && o.capitalLabel) ? o.capitalLabel : r.label;
        const row = { label, vals: r.k ? [v[r.k]] : [], kind: r.kind };
        if (r.k) row.k = r.k;
        if (r.note) row.note = r.note;
        if (r.xsum) row.xsum = r.xsum.filter(k => showTax || k !== 'tax');
        if (r.noTopRule) row.noTopRule = true;
        out.push(row);
      }
      return out;
    };

    const sfpRows = toRows(SFP_ROWS);
    const soiRows = toRows(SOI_ROWS);
    // Two rows the sums cannot express, written as real formulas so the
    // exported workbook re-foots when a figure is edited in Excel.
    const wire = (rows, k, fn) => { const r = rows.find(x => x.k === k); if (r) r.xf = fn; };
    wire(soiRows, 'pbt', ({ R: rr, c }) =>
      (rr.totalIncome && rr.totalExpenses) ? `${c}${rr.totalIncome}-${c}${rr.totalExpenses}` : null);
    wire(soiRows, 'np', ({ R: rr, c }) => {
      if (!rr.pbt) return null;
      return showTax && rr.tax ? `${c}${rr.pbt}-${c}${rr.tax}` : `+${c}${rr.pbt}`;
    });
    // Reserves is brought-forward plus the year's result, and saying so in the
    // cell is what stops a reader hunting for where the profit went.
    wire(sfpRows, 'reserves', ({ Xc }) => {
      const np = Xc('SOI', 'np');
      return np ? `${r2(d.totals.sec.reserves)}+${np}` : null;
    });

    const cols = [{ h1: 'As at', h2: o.asAtCy || '' }];
    const yrCols = [{ h1: 'Year Ended', h2: o.yearEndedCy || o.asAtCy || '' }];

    return [
      {
        key: 'SFP', name: 'SFP', geom: GEOM.SFP,
        title: (o.titles && o.titles.sfp) || 'Statement of Financial Position',
        subtitle: o.asAtLine, sig: true,
        sigRows: { line: 57, role: 59, date: 61, place: 62 },
        cols, rows: sfpRows.concat([
          { label: '', vals: [], kind: 'blank' }, { label: '', vals: [], kind: 'blank' },
          { label: 'Drawn directly from the trial balance on the last sheet of this workbook.', vals: [], kind: 'note' },
        ]),
      },
      {
        key: 'SOI', name: 'SOI', geom: GEOM.SOI,
        title: (o.titles && o.titles.soi) || 'Statement of Income',
        subtitle: o.forYearLine, sig: true,
        sigRows: { line: 51, role: 53, date: 56, place: 57 },
        cols: yrCols, rows: soiRows.concat([
          { label: '', vals: [], kind: 'blank' }, { label: '', vals: [], kind: 'blank' },
          { label: showTax
            ? `Income tax is the trial balance's "${d.tax.name}" line, lifted out of Other Expenses.`
            : 'No ledger line has been named as the income tax charge, so the result is shown before tax.',
            vals: [], kind: 'note' },
        ]),
      },
    ];
  }

  // ════════════════════════════════════════════════════════════════
  //  APPLY — typing on a statement, written back to the ledger
  //
  //  The rule (user decision 2026-08-30): a statement figure that is the SUM
  //  of several typed ledger lines never rewrites those lines. The difference
  //  goes to a named adjustment line inside the section, so the section still
  //  foots to the figure on the statement and NOTHING anyone typed off a
  //  ledger is silently changed. The alternative — apportioning the difference
  //  pro-rata across the detail — was offered and declined for exactly that
  //  reason.
  //
  //  A section with no detail lines has nothing to protect, so its bare
  //  amount is simply set.
  //
  //  An adjustment is UPDATED in place and removed when it reaches nil, or
  //  every edit would stack another row.
  // ════════════════════════════════════════════════════════════════

  const ADJ_LABEL = {
    SFP: '(Adjustment from Balance Sheet)',
    SOI: '(Adjustment from Income Statement)',
  };
  const adjName = (from, side) =>
    ADJ_LABEL[from] + (side === 'nc' ? ' — non-current' : side === 'c' ? ' — current' : '');

  // Move a section's total to `target`, protecting whatever detail it holds.
  function setSectionTotal(st, id, target, from, side) {
    const sec = st.sections[id];
    const want = r2(target);
    if (!sec.lines.length && !side) { sec.amount = want; return { adjusted: false }; }
    const name = adjName(from, side);
    const existing = sec.lines.find(l => l.adj && l.from === from && (l.side || null) === (side || null));
    const others = sec.lines.reduce((t, l) => t + (l === existing ? 0 : num(l.amount)), 0);
    const delta = r2(want - others);
    if (nil(delta)) {
      if (existing) sec.lines.splice(sec.lines.indexOf(existing), 1);
      // Removing the last line would turn the section back into a bare amount
      // carrying whatever stale figure it held before detail was typed.
      if (!sec.lines.length) sec.amount = want;
      return { adjusted: false };
    }
    if (existing) existing.amount = delta;
    else sec.lines.push({ name, amount: delta, adj: true, from, side: side || null });
    return { adjusted: true, name, amount: delta };
  }

  // Move ONE side of the loans split, leaving the other side's lines alone.
  function setLoanSide(st, side, target) {
    const sec = st.sections.loans;
    const want = r2(target);
    const existing = sec.lines.find(l => l.adj && l.from === 'SFP' && l.side === side);
    let others = 0;
    for (const l of sec.lines) {
      if (l === existing) continue;
      if (loanSideOf(st, l) === side) others += num(l.amount);
    }
    // With no detail at all, the whole balance is current (loanSplit's rule),
    // so a non-current figure has to become a real line rather than a bare
    // amount — otherwise it would immediately read back as current.
    if (!sec.lines.length && side === 'c') { sec.amount = want; return { adjusted: false }; }
    const delta = r2(want - others);
    if (nil(delta)) {
      if (existing) sec.lines.splice(sec.lines.indexOf(existing), 1);
      return { adjusted: false };
    }
    if (existing) existing.amount = delta;
    else {
      // Moving from a bare amount to lines: the amount that was there is the
      // current side, so it is written out as a line before the split can mean
      // anything.
      if (!sec.lines.length && !nil(sec.amount)) {
        sec.lines.push({ name: 'Loans and Borrowings', amount: r2(sec.amount), adj: false, from: null, side: 'c' });
        sec.amount = 0;
      }
      sec.lines.push({ name: adjName('SFP', side), amount: delta, adj: true, from: 'SFP', side });
    }
    return { adjusted: true, name: adjName('SFP', side), amount: delta };
  }

  // `k` is a row key from SFP_ROWS / SOI_ROWS. Returns the state to keep plus a
  // sentence describing what it did, which the screen shows — an adjustment
  // that appears without being announced is the thing this design exists to
  // avoid.
  function applyEdit(state, k, value) {
    const st = normalize(state);
    const entry = ROW_BY_KEY[k];
    if (!entry) return { ok: false, state: st, message: `No statement row "${k}".` };
    const src = entry.row.src;
    if (!src || src.kind === 'calc') {
      return { ok: false, state: st, message: `${entry.row.label} is derived from the rows above it and cannot be typed into.` };
    }
    const want = r2(num(value));
    const from = entry.sheet;
    const before = derive(st, {}).values[k];
    if (r2(before) === want) return { ok: true, state: st, message: '', changed: false };

    let note = '';
    switch (src.kind) {
      case 'section': {
        const res = setSectionTotal(st, src.id, want, from);
        note = res.adjusted
          ? `${entry.row.label} set to ${want.toFixed(2)} — the difference is on the trial balance as "${res.name}".`
          : `${entry.row.label} set to ${want.toFixed(2)} on the trial balance.`;
        break;
      }
      case 'sum': {
        // Only the primary section moves; the others keep the figures they
        // were given, so a VAT receivable typed off a return stays exactly
        // what the return said.
        const others = src.ids.reduce((t, id) => t + (id === src.primary ? 0 : sectionTotal(st.sections[id])), 0);
        const res = setSectionTotal(st, src.primary, r2(want - others), from);
        note = `${entry.row.label} set to ${want.toFixed(2)} through ${SECTION_SPEC[src.primary].title}`
          + (res.adjusted ? `, as "${res.name}".` : '.');
        break;
      }
      case 'reserves': {
        // The year's profit is not the preparer's to change from here — it is
        // Revenue less Expenses. So the figure typed is the CLOSING reserve
        // and what is written back is the brought-forward balance under it.
        const profit = derive(st, {}).profit;
        const res = setSectionTotal(st, 'reserves', r2(want - profit), from);
        note = `Reserves set to ${want.toFixed(2)} — ${r2(want - profit).toFixed(2)} brought forward plus this year's `
          + `${profit < 0 ? 'loss of ' + Math.abs(profit).toFixed(2) : 'profit of ' + profit.toFixed(2)}`
          + (res.adjusted ? `, as "${res.name}".` : '.');
        break;
      }
      case 'loans': {
        const res = setLoanSide(st, src.side, want);
        note = `${src.side === 'nc' ? 'Non-current' : 'Current'} loans set to ${want.toFixed(2)}`
          + (res.adjusted ? ` — the difference is on the trial balance as "${res.name}".` : ' on the trial balance.');
        break;
      }
      case 'expenses': {
        // Other Expenses on the statement is the section LESS the tax line, so
        // the tax charge is added back before the section is set — otherwise
        // typing the statement figure would quietly delete the tax.
        const tax = taxCharge(st).amount;
        const res = setSectionTotal(st, src.id, r2(want + tax), from);
        note = `${entry.row.label} set to ${want.toFixed(2)}`
          + (tax ? ` (${r2(want + tax).toFixed(2)} on the trial balance, including the tax line)` : '')
          + (res.adjusted ? `, as "${res.name}".` : '.');
        break;
      }
      case 'revenue': {
        // A revenue part is a bucket of lines matched by name, so there is no
        // single section to set. The adjustment line is named after the part,
        // which is also what makes it fall back into the same bucket when it
        // is read again.
        const cur = revenueSplit(st)[src.part];
        const delta = r2(want - cur);
        const label = REVENUE_ADJ[src.part];
        const sec = st.sections.revenue;
        // Revenue with no detail is all operations, so a bare amount can only
        // be set directly when that is the part being typed.
        if (!sec.lines.length && src.part === 'sales') { sec.amount = want; note = `Revenue set to ${want.toFixed(2)} on the trial balance.`; break; }
        const existing = sec.lines.find(l => l.adj && l.from === 'SOI' && l.name === label);
        const now = r2((existing ? num(existing.amount) : 0) + delta);
        if (nil(now)) { if (existing) sec.lines.splice(sec.lines.indexOf(existing), 1); }
        else if (existing) existing.amount = now;
        else {
          if (!sec.lines.length && !nil(sec.amount)) {
            sec.lines.push({ name: 'Sale of Goods', amount: r2(sec.amount), adj: false, from: null, side: null });
            sec.amount = 0;
          }
          sec.lines.push({ name: label, amount: now, adj: true, from: 'SOI', side: null });
        }
        note = `${entry.row.label} set to ${want.toFixed(2)} — the difference is on the trial balance as "${label}".`;
        break;
      }
      case 'taxLine': {
        const st2 = st.sections.otherExpenses;
        const hit = st2.lines.find(l => l.name === st.taxLine);
        if (!hit) return { ok: false, state: st, message: 'Name a ledger line as the income tax charge before typing a figure here.' };
        hit.amount = want;
        note = `Income tax set to ${want.toFixed(2)} on the trial balance's "${hit.name}" line.`;
        break;
      }
      default:
        return { ok: false, state: st, message: `${entry.row.label} cannot be typed into.` };
    }
    return { ok: true, state: st, message: note, changed: true };
  }

  // Named after the part they feed, so an adjustment reads back into the same
  // bucket it was written for — TrialBalanceReader.REVENUE_LINES matches
  // "Interest Income" to interestIncome and "Other Income" to otherIncome.
  const REVENUE_ADJ = {
    sales: 'Sale of Goods (adjusted from Income Statement)',
    interestIncome: 'Interest Income (adjusted from Income Statement)',
    otherIncome: 'Other Income (adjusted from Income Statement)',
  };

  return {
    VERSION, SKELETON, SECTION_SPEC, SECTION_BLOCK, SECTION_IDS,
    SFP_ROWS, SOI_ROWS, ROW_BY_KEY, ADJ_LABEL, REVENUE_ADJ,
    blank, normalize, sectionTitle, sectionTotal, totals,
    toReport, derive, buildSheets, applyEdit,
    loanSideOf, loanSplit, revenueSplit, taxCharge,
    num, r2,
  };
})();

// Browser: global (the app's no-module architecture). Node: export so
// tools/tbsVerify.mjs can replay a trial balance through it.
if (typeof module !== 'undefined' && module.exports) module.exports = TrialBalanceModel;
else window.TrialBalanceModel = TrialBalanceModel;
