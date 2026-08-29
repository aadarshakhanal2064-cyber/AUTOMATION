// ── FinStatementEngine — pure calculation core for the Financial Statement module ──
// No DOM access anywhere in this file: it parses the client's prior-year NFRS
// statement into a comparative model, then constructs the current year from the
// summary figures A–N and returns the five statements plus the tax computation.
// js/finStatement.js owns all UI; this file must stay loadable in Node so the
// solver can be verified against the firm's real sample workbooks (see the
// export guard at the bottom).
//
// Source of truth: "Work Performed (9).xlsx", sheet `provisional.Audited` — the
// department head's spec (inputs A–N, the tax logic per return type, the two
// naming rules). The output format is the yellow-tabbed sheets of the sample
// workbooks, several of which carry the spec inline: "Fill (A)" on Sale of
// Goods, "Balance Fig " on Purchases and on Trade Receivables, "Fill H/I/J/G"
// on the loan rows, "As per SLM Module" on depreciation. See CLAUDE.md §5.18.
//
// This module is the inverse of Projection Report: rather than projecting an
// audited statement forward, it builds the current year from summary figures
// and uses the prior year only as the comparative column.

const FinStatementEngine = (() => {

  const WR = (typeof module !== 'undefined' && module.exports)
    ? require('./core/workbookReader')
    : window.WorkbookReader;
  const EM = (typeof module !== 'undefined' && module.exports)
    ? require('./core/engineMath')
    : window.EngineMath;

  const { num, norm, grid, findSheet, findRowIdx, findHeader, labelValue, noteSection, HEADS } = WR;

  // ───────────────────────── constants ─────────────────────────

  const LAKH = 100000;

  // Presumptive-tax thresholds and rates (Work Performed rows 43–51).
  const TAX = {
    d1Municipality: 4000,
    d1Metropolitan: 7500,
    d1SalesCeiling: 30 * LAKH,      // D1 applies up to 30 lakh turnover
    d2SalesCeiling: 100 * LAKH,     // D2 applies 30–100 lakh
    d2MidPoint: 50 * LAKH,
    d2LowRate: 0.01,                // (Sales − 30L) × 1% + 4,000
    d2HighRate: 0.008,              // (Sales − 50L) × 0.8% + 24,000
    d2HighBase: 24000,
    companyRate: 0.25,              // partnership + private limited
    specialIndustryRate: 0.20,
  };

  // D3 slabs as [bandWidth, rate], progressive. Work Performed lists 6L @ 0%,
  // 2L @ 10%, 3L @ 20%, 9L @ 30% — i.e. only the first 20 lakh. Per the user
  // (2026-07-26) the 30% band is open-ended, so everything above 11 lakh is
  // 30%. Deliberately NOT projectionEngine's TAX_SLABS, which encode a
  // different (0/10/20/27/29) schedule for a different purpose.
  const D3_SLABS = [[600000, 0], [200000, 0.10], [300000, 0.20], [Infinity, 0.30]];

  const RULES = {
    expenseGrowth: 1.05,   // every P&L expense line grows 5% year on year…
    flatExpense: /\brent\b|audit\s*fee/i,  // …except Rent and Audit Fee (rule 1)
    tdsSalary: 0.01,
    tdsRent: 0.10,
    tdsAuditFee: 0.015,
    salaryPayableMonths: 1, // one month accrued — verified against real files:
                            // T3 salary 30,416 → salary payable 2,534.67 = /12
    cashLo: 2 * LAKH,       // Sch-BS 3.5: "Between 2 -9 lakh but unique on Each case"
    cashHi: 9 * LAKH,
  };

  // Statement titles. Audited takes the plain title; Provisional prefixes
  // "Provisional" — except the Statement of Changes in Equity, which the spec
  // (Work Performed rows 66–69) leaves unprefixed in BOTH columns.
  const TITLES = {
    sfp:  { audited: 'Statement of Financial Position', provisional: 'Provisional Statement of Financial Position' },
    soi:  { audited: 'Statement of Income',             provisional: 'Provisional Statement of Income' },
    soce: { audited: 'Statement of Changes in Equity',  provisional: 'Statement of Changes in Equity' },
    socf: { audited: 'Statement of Cash Flows',         provisional: 'Provisional Statement of Cash Flows' },
  };

  // Per-entity terminology. The sample workbooks differ exactly here: a Pvt Ltd
  // SOCE row 13 reads "Dividend Paid", a proprietorship's reads "Drawing".
  const TERMS = {
    private:        { entity: 'Pvt Ltd Company',    person: 'Director',    capital: 'Share Capital',      distribution: 'Dividend Paid' },
    public:         { entity: 'Public Ltd Company', person: 'Director',    capital: 'Share Capital',      distribution: 'Dividend Paid' },
    partnership:    { entity: 'Partnership Firm',   person: 'Partner',     capital: 'Partners’ Capital', distribution: 'Drawing' },
    proprietorship: { entity: 'Proprietorship Firm', person: 'Proprietor', capital: 'Capital',            distribution: 'Drawing' },
  };

  const termsFor = (entity) => TERMS[entity] || TERMS.private;

  const r2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
  const r0 = (v) => Math.round(num(v));

  // ───────────────────────── tax ─────────────────────────

  function progressiveTax(base, slabs) {
    let left = Math.max(0, num(base)), tax = 0;
    for (const [width, rate] of slabs) {
      if (left <= 0) break;
      const slice = Math.min(left, width);
      tax += slice * rate;
      left -= slice;
    }
    return tax;
  }

  // Work Performed rows 41–60. `basis` decides WHAT is taxed: audited returns
  // tax the taxable profit (PBT adjusted for the two depreciation figures),
  // provisional returns tax the profit before tax as reported.
  function taxFor(opts) {
    const {
      returnType = 'D3', entity = 'private', specialIndustry = false,
      sales = 0, pbt = 0, taxableProfit = 0, basis = 'provisional',
      localBody = 'municipality',
    } = opts || {};

    const base = basis === 'audited' ? num(taxableProfit) : num(pbt);
    const isProprietor = entity === 'proprietorship';

    // D1 and D2 are presumptive turnover taxes and exist only for
    // proprietorships; partnerships and companies are always D3 (rows 56–57).
    if (isProprietor && returnType === 'D1') {
      return {
        amount: localBody === 'metropolitan' ? TAX.d1Metropolitan : TAX.d1Municipality,
        basis: 'presumptive', on: num(sales),
        note: `D1 presumptive tax — ${localBody === 'metropolitan' ? 'Metropolitan City' : 'Municipality'}`,
      };
    }

    if (isProprietor && returnType === 'D2') {
      const s = num(sales);
      const amount = s <= TAX.d2MidPoint
        ? (s - TAX.d1SalesCeiling) * TAX.d2LowRate + TAX.d1Municipality
        : (s - TAX.d2MidPoint) * TAX.d2HighRate + TAX.d2HighBase;
      // The two formulas meet at exactly 50 lakh (both give 24,000), which is
      // what confirms the first reads off Sales rather than the constant 50−30.
      return {
        amount: Math.max(0, r2(amount)), basis: 'presumptive', on: s,
        note: s <= TAX.d2MidPoint
          ? 'D2 presumptive tax — (Sales − 30 lakh) × 1% + 4,000'
          : 'D2 presumptive tax — (Sales − 50 lakh) × 0.8% + 24,000',
      };
    }

    if (isProprietor) {
      return {
        amount: r2(progressiveTax(base, D3_SLABS)), basis: 'progressive', on: base,
        note: 'D3 — progressive slabs on ' + (basis === 'audited' ? 'taxable profit' : 'profit before tax'),
      };
    }

    const rate = specialIndustry ? TAX.specialIndustryRate : TAX.companyRate;
    return {
      amount: r2(Math.max(0, base) * rate), basis: 'flat', on: base, rate,
      note: `${(rate * 100).toFixed(0)}% of ` + (basis === 'audited' ? 'taxable profit' : 'profit before tax')
        + (specialIndustry ? ' (Special Industry)' : ''),
    };
  }

  // Which return types the firm may legitimately pick, given the entity and
  // turnover. Surfaced in the UI so an impossible combination is caught before
  // it reaches a filed statement rather than after.
  function allowedReturnTypes(entity, sales) {
    if (entity !== 'proprietorship') return ['D3'];
    const s = num(sales);
    const out = [];
    if (s <= TAX.d1SalesCeiling) out.push('D1');
    if (s > TAX.d1SalesCeiling && s < TAX.d2SalesCeiling) out.push('D2');
    out.push(s < TAX.d2SalesCeiling ? 'D3V' : 'D3');
    return out;
  }

  // ───────────────────────── prior-year parse ─────────────────────────

  // The uploaded file is last year's finished statement, so ITS current-year
  // column is OUR comparative column. Everything is read by label, never by
  // position — see js/core/workbookReader.js for why.
  //
  // `opts.column` picks which of the two columns a statement sheet carries:
  // 'current' (the default) or 'comparative'. Reading the comparative column
  // lets one workbook be checked against itself — its own prior-year column as
  // the input, its current-year column as the expected output — which is how
  // the solver is verified without needing consecutive years of a client.
  function parsePriorYear(wb, XLSX, opts) {
    const useComparative = !!(opts && opts.column === 'comparative');
    const pickCol = (h) => (useComparative && h.prevCol >= 0 ? h.prevCol : h.valCol);
    const secCol = (s) => (useComparative && s.prevCol >= 0 ? s.prevCol : s.valCol);
    const issues = [];
    const err = (msg) => issues.push({ level: 'error', msg });
    const warn = (msg) => issues.push({ level: 'warn', msg });

    const py = {
      company: { name: '', address: '', bsYear: null },
      sfp: {},
      soi: {},
      materials: { opening: 0, purchases: 0, closing: 0, total: 0, directItems: [] },
      employeeItems: [], employeeTotal: 0,
      financeItems: [], financeTotal: 0,
      otherItems: [], otherTotal: 0,
      auditFee: 0, rent: 0, salary: 0,
      receivableItems: [], payableItems: [], loanItems: [], capitalItems: [], reserveItems: [],
      socf: {},
      ppe: { classes: [], totalCost: 0, totalDep: 0, totalCarrying: 0 },
      equity: { shareCapital: 0, sharePremium: 0, retained: 0, otherReserves: 0 },
    };

    // ── SFP: the comparative balance sheet ──
    const sfp = findSheet(wb, ['SFP', 'Statement of Financial Position', 'Balance Sheet']);
    if (!sfp) { err('Could not find the balance-sheet sheet (SFP) in the prior-year file.'); return { py, issues }; }
    const gS = grid(sfp, XLSX);
    const hS = findHeader(gS);
    if (!hS) { err('Could not find the "Particulars" header row on SFP.'); return { py, issues }; }

    // Company identity: the two text rows above the statement title.
    const titleRow = findRowIdx(gS, /statement of financial position|balance sheet/);
    if (titleRow > 0) {
      const texts = [];
      for (let r = 0; r < titleRow; r++) {
        const row = gS[r]; if (!row) continue;
        const t = row.find(v => typeof v === 'string' && v.trim());
        if (t) texts.push(String(t).trim());
      }
      py.company.name = texts[0] || '';
      py.company.address = texts[1] || '';
    }
    const asAt = findRowIdx(gS, /^as at .*20[6-9]\d/);
    if (asAt !== -1) {
      const row = gS[asAt].find(v => /as at/i.test(String(v)));
      const m = /(20[6-9]\d)/.exec(String(row));
      if (m) py.company.bsYear = parseInt(m[1], 10);
    }

    const colS = pickCol(hS);
    const sVal = (re, required, label) => {
      const hit = labelValue(gS, re, hS.labelCol, colS, hS.row + 1);
      if (!hit) { if (required) err(`SFP is missing "${label}".`); return 0; }
      return hit.value;
    };

    // Heads come from the SHARED vocabulary (js/core/workbookReader.js) so
    // this reader and Projection Report's cannot drift apart — including on
    // the entity-worded capital line ("Proprietors Capital" / "Partners
    // Capital"), which the statement modules have printed since 2026-08-28
    // and which next year's preparer uploads straight back in.
    py.sfp.ppe                  = sVal(HEADS.ppe, true, 'Property, Plant and Equipment');
    py.sfp.otherReceivablesNC   = sVal(HEADS.otherReceivablesNC, false);
    py.sfp.totalNCA             = sVal(HEADS.totalNCA, false);
    py.sfp.inventories          = sVal(HEADS.inventories, true, 'Inventories');
    py.sfp.receivables          = sVal(HEADS.receivables, true, 'Trade & Other Receivables');
    py.sfp.cash                 = sVal(HEADS.cash, true, 'Cash and Cash Equivalents');
    py.sfp.totalCA              = sVal(HEADS.totalCA, false);
    py.sfp.totalAssets          = sVal(HEADS.totalAssets, false);
    py.sfp.shareCapital         = sVal(HEADS.capital, true, 'Share Capital');
    py.sfp.reserves             = sVal(HEADS.reserves, true, 'Reserves');
    py.sfp.totalEquity          = sVal(HEADS.totalEquity, false);
    py.sfp.payables             = sVal(HEADS.payables, false);
    py.sfp.totalCL              = sVal(HEADS.totalCL, false);

    // Investments, Loans and Borrowings and Provisions each appear TWICE — once
    // under non-current, once under current — so they are taken in document
    // order. Reading them by label alone would silently drop the second.
    const loanRows = [], provRows = [], investRows = [];
    for (let r = hS.row + 1; r < gS.length; r++) {
      const lab = norm((gS[r] || [])[hS.labelCol]);
      if (HEADS.loans.test(lab)) loanRows.push(num(gS[r][colS]));
      if (HEADS.provisions.test(lab)) provRows.push(num(gS[r][colS]));
      if (HEADS.investments.test(lab)) investRows.push(num(gS[r][colS]));
    }
    py.sfp.investmentsNC = investRows[0] || 0;
    py.sfp.investmentsC  = investRows[1] || 0;
    py.sfp.loansNC = loanRows[0] || 0;
    py.sfp.loansC  = loanRows[1] || 0;
    py.sfp.provisionsNC = provRows[0] || 0;
    py.sfp.provisionsC  = provRows[1] || 0;

    // ── SOI: the comparative income statement ──
    const soi = findSheet(wb, ['SOI', 'Statement of Income', 'Income Statement', 'Profit']);
    if (soi) {
      const gI = grid(soi, XLSX);
      const hI = findHeader(gI);
      if (hI) {
        const colI = pickCol(hI);
        const iVal = (re) => { const h = labelValue(gI, re, hI.labelCol, colI, hI.row + 1); return h ? h.value : 0; };
        py.soi.revenueOps     = iVal(/revenue from operation/);
        py.soi.interestIncome = iVal(/interest income/);
        py.soi.otherIncome    = iVal(/other income/);
        py.soi.totalIncome    = iVal(/total income/);
        py.soi.materials      = iVal(/material|service.*consumed/);
        py.soi.employee       = iVal(/employee benefit/);
        py.soi.financeCost    = iVal(/finance cost/);
        py.soi.depreciation   = iVal(/depreciation/);
        py.soi.otherExpenses  = iVal(/other expense/);
        py.soi.totalExpenses  = iVal(/total expense/);
        py.soi.pbt            = iVal(/profit before tax/);
        py.soi.tax            = iVal(/income tax expense/);
        py.soi.netProfit      = iVal(/net profit for/);
      } else warn('Could not read the prior-year income statement header; comparative income figures may be blank.');
    } else warn('No income-statement sheet (SOI) found in the prior-year file.');

    // ── Sch-PL: the notes that drive next year's expense lines ──
    const schPl = findSheet(wb, ['Sch-PL', 'Sch PL', 'Schedule PL']);
    if (!schPl) { warn('No P&L schedule sheet (Sch-PL) found — expense lines cannot be grown from the prior year.'); }
    else {
      const gP = grid(schPl, XLSX);
      const rows = (sec) => {
        const out = [];
        if (!sec) return out;
        const col = secCol(sec);
        for (let r = sec.titleRow + 1; r < Math.min(sec.endRow, gP.length); r++) {
          const row = gP[r]; if (!row) continue;
          const lab = String(row[sec.labelCol] == null ? '' : row[sec.labelCol]).trim();
          if (!lab) continue;
          const l = norm(lab);
          // Skip the note's own header and its structural sub-headings.
          if (l === 'particulars' || /:$/.test(lab) || /^add:?$|^less:?$/.test(l)) continue;
          if (/^sub-?total$|^total$/.test(l)) continue;
          out.push({ name: lab, amount: num(row[col]) });
        }
        return out;
      };

      // 3.12 Materials — opening/purchases/closing plus any direct-cost lines
      // the client carries between "Add:" and "Less:" (Labour, Freight-Direct).
      const s312 = noteSection(gP, /^3\.12/);
      if (s312) {
        const c312 = secCol(s312);
        const v = (re) => { const h = labelValue(gP, re, s312.labelCol, c312, s312.titleRow, s312.endRow + 1); return h ? h.value : 0; };
        py.materials.opening   = v(/balance on beginning/);
        py.materials.purchases = v(/purchase/);
        py.materials.closing   = v(/balance as at end/);
        const tot = labelValue(gP, /^total$/, s312.labelCol, c312, s312.titleRow);
        py.materials.total = tot ? tot.value : 0;
        py.materials.directItems = rows(s312).filter(it =>
          !/purchase|balance on beginning|balance as at end/i.test(it.name));
      }

      const s313 = noteSection(gP, /^3\.13/);
      if (s313) {
        py.employeeItems = rows(s313);
        const tot = labelValue(gP, /^total$/, s313.labelCol, secCol(s313), s313.titleRow);
        py.employeeTotal = tot ? tot.value : 0;
        const sal = py.employeeItems.find(it => /salary/i.test(it.name));
        py.salary = sal ? sal.amount : py.employeeTotal;
      }

      const s314 = noteSection(gP, /^3\.14/);
      if (s314) {
        py.financeItems = rows(s314);
        const tot = labelValue(gP, /^total$/, s314.labelCol, secCol(s314), s314.titleRow);
        py.financeTotal = tot ? tot.value : 0;
      }

      // 3.15 Other Expenses — the growth base. Real files carry anything from
      // 6 to 13 lines and the set differs per client, so whatever is there is
      // what gets grown.
      const s315 = noteSection(gP, /^3\.15/);
      if (s315) {
        py.otherItems = rows(s315);
        const tot = labelValue(gP, /^total$/, s315.labelCol, secCol(s315), s315.titleRow);
        py.otherTotal = tot ? tot.value : 0;
        const af = py.otherItems.find(it => /audit\s*fee/i.test(it.name));
        const rt = py.otherItems.find(it => /\brent\b/i.test(it.name));
        py.auditFee = af ? af.amount : 0;
        py.rent = rt ? rt.amount : 0;
      }

      // Note 3.12's closing stock must equal the balance sheet's Inventories.
      // Where it doesn't, the file itself is inconsistent — flag it, because
      // the opening stock of the new year rides on this figure.
      if (py.materials.closing && py.sfp.inventories
          && Math.abs(py.materials.closing - py.sfp.inventories) > 1) {
        warn(`Note 3.12 closing stock (${r2(py.materials.closing)}) does not equal the balance sheet's Inventories (${r2(py.sfp.inventories)}) in the prior-year file. The balance-sheet figure is used as this year's opening stock.`);
      }
    }

    // ── SOCF: the prior year's own cash flow ──
    // Read rather than re-derived: a cash flow needs TWO balance sheets, and
    // the year before last isn't in this file. The uploaded statement already
    // contains the finished figures, so they become the comparative column
    // directly.
    const socf = findSheet(wb, ['SOCF', 'Statement of Cash Flow', 'Cash Flow']);
    if (socf) {
      const gC = grid(socf, XLSX);
      const hC = findHeader(gC);
      if (hC) {
        const colC = pickCol(hC);
        const cVal = (re) => { const h = labelValue(gC, re, hC.labelCol, colC, hC.row + 1); return h ? h.value : 0; };
        py.socf = {
          profit: cVal(/^profit for the year/),
          depreciation: cVal(/depreciation.*impairment|depreciation\/impairment/),
          interestIncome: cVal(/^interest income/),
          financeCost: cVal(/interest expenses|finance cost/),
          ppeLoss: cVal(/loss.*gain.*sale/),
          taxExpense: cVal(/income tax expenses charged/),
          dRecv: cVal(/increase\/decrease in trade & other receivable|increase\/decrease in trade and other receivable/),
          dStock: cVal(/increase\/decrease in inventor/),
          dPay: cVal(/increase\/decrease in trade & other payable|increase\/decrease in trade and other payable/),
          generated: cVal(/cash generated from operation/),
          interestPaid: cVal(/^interest paid/),
          taxPaid: cVal(/^income tax paid/),
          netOperating: cVal(/net cash flows? from operating/),
          ppeAcquired: cVal(/acquisition of property/),
          investments: cVal(/^investments$/),
          interestReceived: cVal(/interest\/dividend received/),
          ppeProceeds: cVal(/proceeds from sale of ppe/),
          netInvesting: cVal(/net cash flows? from investing/),
          capital: cVal(/proceeds from capital introduced/),
          nonCurrentBorrowings: cVal(/non-current borrowing/),
          currentBorrowings: cVal(/from current borrowing/),
          drawing: cVal(HEADS.distribution),
          netFinancing: cVal(/net cash flows? from financing/),
          netIncrease: cVal(/net increase in cash/),
          openingCash: cVal(/cash & cash equivalents at the beginning|cash and cash equivalents at the beginning/),
          closingCash: cVal(/cash & cash equivalents at the end|cash and cash equivalents at the end/),
        };
      }
    }

    // ── Sch-BS: receivable and payable detail ──
    const schBs = findSheet(wb, ['Sch-BS', 'Sch BS', 'Schedule BS']);
    if (schBs) {
      const gB = grid(schBs, XLSX);
      const pick = (titleRe, skipRe, endRe) => {
        const sec = noteSection(gB, titleRe, endRe);
        if (!sec) return [];
        const col = secCol(sec);
        const out = [];
        for (let r = sec.titleRow + 1; r < Math.min(sec.endRow, gB.length); r++) {
          const row = gB[r]; if (!row) continue;
          const lab = String(row[sec.labelCol] == null ? '' : row[sec.labelCol]).trim();
          if (!lab) continue;
          const l = norm(lab);
          if (l === 'particulars' || /:$/.test(lab) || /^total/.test(l)) continue;
          if (skipRe && skipRe.test(l)) continue;
          out.push({ name: lab, amount: num(row[col]) });
        }
        return out;
      };
      // 3.3 — keep only the "other receivables" beneath the trade-receivable
      // block; the trade figure itself is a balancing figure next year.
      py.receivableItems = pick(/^3\.3\b/, /trade receivable|provisions for impairment|non-current portion|current portion/);
      py.payableItems = pick(/^3\.9\b/, null);
      // 3.8 loan lines, so the comparative column of that note shows the
      // client's own prior-year split rather than a fabricated one. The note
      // holds a "Total" after EACH of its two blocks, so the default fence
      // stopped at the non-current one and silently dropped the whole current
      // side (Bank Overdrafts) — fence on the note's own grand total instead;
      // the internal Total rows are already skipped by the /^total/ rule.
      py.loanItems = pick(/^3\.8\b/, /^non-current|^current\s*:?$|^bank loans?$|total loans/, /^total loans and borrowing/);
      // 3.6 / 3.7 give the equity notes their comparative figures.
      py.capitalItems = pick(/^3\.6\b/, /^type of shares|^number$|^npr$/);
      py.reserveItems = pick(/^3\.7\b/, /^retained earnings/);
    }

    // ── 3.1 PPE: closing carrying per class becomes next year's opening ──
    const ppe = findSheet(wb, ['3.1 PPE', 'PPE', 'Property']);
    if (ppe) {
      const gPP = grid(ppe, XLSX);
      const hdr = findRowIdx(gPP, /^particulars$/);
      if (hdr !== -1) {
        const labelCol = gPP[hdr].findIndex(v => norm(v) === 'particulars');
        const cols = [];
        gPP[hdr].forEach((v, c) => {
          const t = String(v == null ? '' : v).trim();
          if (c > labelCol && t && !/^total$/i.test(t)) cols.push({ col: c, name: t });
        });
        // Cost / accumulated depreciation / carrying amount blocks. Each opens
        // on a "Balance as at 1st Shrawan" row and closes on "Balance at 32nd
        // Ashadh" — note the opening row says "as at" and the closing one does
        // not, so the pattern has to allow both or the opening block is missed
        // and cost−dep silently yields the CLOSING carrying amount.
        const balanceRe = /^balance\s+(as\s+)?at|^as\s+at/;
        const costRows = [], depRows = [], carryRows = [];
        const depHdr = findRowIdx(gPP, /depreciation and impairment/, hdr, labelCol);
        const carryHdr = findRowIdx(gPP, /^carrying amount/, hdr, labelCol);
        for (let r = hdr + 1; r < gPP.length; r++) {
          const lab = norm((gPP[r] || [])[labelCol]);
          if (!balanceRe.test(lab)) continue;
          if (carryHdr !== -1 && r > carryHdr) carryRows.push(r);
          else if (depHdr !== -1 && r > depHdr) depRows.push(r);
          else costRows.push(r);
        }
        // 3.1 PPE has no comparative column — the two years sit as the opening
        // and closing rows of each block, so comparative mode takes the
        // opening row instead of the closing one.
        const at = (arr) => (useComparative ? arr[0] : arr[arr.length - 1]);
        const rowCost = at(costRows), rowDep = at(depRows), rowCarry = at(carryRows);

        // The movement rows, so the UI can seed this year's additions/disposals
        // from what the client last reported rather than starting blank.
        const mv = (re, from, to) => {
          const r = findRowIdx(gPP, re, from, labelCol);
          return (r === -1 || (to != null && r > to)) ? null : r;
        };
        const rAdd = mv(/^additions?$/, hdr, depHdr === -1 ? undefined : depHdr);
        const rDis = mv(/^disposals?$/, hdr, depHdr === -1 ? undefined : depHdr);
        const rChg = depHdr === -1 ? null : mv(/^depreciation charged/, depHdr, carryHdr === -1 ? undefined : carryHdr);
        const rImp = depHdr === -1 ? null : mv(/impairment loss/, depHdr, carryHdr === -1 ? undefined : carryHdr);
        const rDisDep = depHdr === -1 ? null : mv(/^disposals?$/, depHdr, carryHdr === -1 ? undefined : carryHdr);
        const cell = (r, c) => (r == null ? 0 : num(gPP[r][c]));

        for (const c of cols) {
          const cost = cell(rowCost, c.col);
          const dep = cell(rowDep, c.col);
          const carrying = rowCarry != null ? num(gPP[rowCarry][c.col]) : cost - dep;
          py.ppe.classes.push({
            name: c.name, cost, dep, carrying,
            additions: cell(rAdd, c.col), disposals: cell(rDis, c.col),
            depCharge: cell(rChg, c.col), impairment: cell(rImp, c.col),
            disposalDep: cell(rDisDep, c.col),
          });
        }
        py.ppe.totalCost = py.ppe.classes.reduce((s, x) => s + x.cost, 0);
        py.ppe.totalDep = py.ppe.classes.reduce((s, x) => s + x.dep, 0);
        py.ppe.totalCarrying = py.ppe.classes.reduce((s, x) => s + x.carrying, 0);
        if (Math.abs((py.ppe.totalCost - py.ppe.totalDep) - py.ppe.totalCarrying) > 1) {
          warn(`3.1 PPE cost less accumulated depreciation (${r2(py.ppe.totalCost - py.ppe.totalDep)}) does not equal the stated carrying amount (${r2(py.ppe.totalCarrying)}) in the prior-year file.`);
        }
      }
    }
    if (!py.ppe.classes.length) {
      warn('No 3.1 PPE note found in the prior-year file; opening fixed-asset balances will need entering by hand.');
      py.ppe.totalCarrying = py.sfp.ppe;
    } else if (Math.abs(py.ppe.totalCarrying - py.sfp.ppe) > 1) {
      warn(`3.1 PPE closing carrying (${r2(py.ppe.totalCarrying)}) does not tie to the SFP figure (${r2(py.sfp.ppe)}) in the prior-year file.`);
    }

    // ── SOCE: opening equity split across the four reserve columns ──
    const soce = findSheet(wb, ['SOCE', 'Statement of Changes in Equity']);
    if (soce) {
      const gE = grid(soce, XLSX);
      const hdr = findRowIdx(gE, /^particulars$/);
      // Like 3.1 PPE, SOCE holds both years as rows: the opening balance at
      // 1st Shrawan and the closing balance at Ashadh end.
      const closing = useComparative
        ? findRowIdx(gE, /^balance at .*shrawan/, hdr === -1 ? 0 : hdr)
        : findRowIdx(gE, /^balance at .*ashadh/, hdr === -1 ? 0 : hdr);
      if (hdr !== -1 && closing !== -1) {
        const labelCol = gE[hdr].findIndex(v => norm(v) === 'particulars');
        const colFor = (re) => gE[hdr].findIndex((v, c) => c > labelCol && re.test(norm(v)));
        const g = (re) => { const c = colFor(re); return c === -1 ? 0 : num(gE[closing][c]); };
        py.equity.shareCapital  = g(HEADS.capital);
        py.equity.sharePremium  = g(/premium/);
        py.equity.retained      = g(/retained/);
        py.equity.otherReserves = g(/other reserve/);
      }
    }
    // The SFP is authoritative; SOCE only supplies the split between columns.
    if (!py.equity.retained && !py.equity.sharePremium && !py.equity.otherReserves) {
      py.equity.retained = py.sfp.reserves;
    }
    if (!py.equity.shareCapital) py.equity.shareCapital = py.sfp.shareCapital;

    // The prior-year balance sheet must itself balance. The cash-flow statement
    // ties this year's balance sheet to last year's, so an out-of-balance
    // comparative surfaces later as a cash-flow difference of exactly that
    // amount — far from where the problem actually is. Catch it here instead.
    const pyAssets = r2(num(py.sfp.ppe) + num(py.sfp.investmentsNC) + num(py.sfp.otherReceivablesNC)
      + num(py.sfp.investmentsC) + num(py.sfp.inventories) + num(py.sfp.receivables) + num(py.sfp.cash));
    const pyEquityLiab = r2(num(py.sfp.shareCapital) + num(py.sfp.reserves) + num(py.sfp.loansNC)
      + num(py.sfp.provisionsNC) + num(py.sfp.loansC) + num(py.sfp.payables) + num(py.sfp.provisionsC));
    if (Math.abs(pyAssets - pyEquityLiab) > 1) {
      warn(`The prior-year balance sheet does not balance: assets ${r2(pyAssets)} against equity and liabilities ${r2(pyEquityLiab)}, a difference of ${r2(pyAssets - pyEquityLiab)}. This will show up as a cash-flow difference of the same amount.`);
    }

    return { py, issues };
  }

  // ───────────────────────── the current-year build ─────────────────────────

  // `input` shape:
  //   company   { name, address, pan, place }
  //   fy        '2082-83'          fyPrev '2081-82'
  //   basis     'provisional' | 'audited'
  //   returnType'D1'|'D2'|'D3'|'D3V'   entity 'proprietorship'|…
  //   specialIndustry bool         localBody 'municipality'|'metropolitan'
  //   serviceIndustry bool         (revenue lands on Rendering of Services)
  //   figures   { A,B,C,E1,E2,F,G,H,I,J,K,L,M,N }
  //   ppeClasses[{ key, name, kw }]   — window.DEP_SLM_CLASSES, injected so
  //                                     config.js stays the one authority
  //   ppe       [{ key, additions, disposals, disposalDep, depCharge, impairment }]
  //   levers    { cash, dividend, directorLoan, auditFee, rent, expensesPayable,
  //               interestIncome, otherIncome, salary, directItems, otherItems }
  //   py        parsePriorYear() output
  //   purchaseTotal / salesTotal   — closing balances off the uploaded details
  function build(input) {
    const issues = [];
    const warn = (msg) => issues.push({ level: 'warn', msg });
    const err = (msg) => issues.push({ level: 'error', msg });

    const py = input.py || { sfp: {}, soi: {}, materials: {}, ppe: { classes: [] }, equity: {} };
    const f = input.figures || {};
    const lv = input.levers || {};
    const T = termsFor(input.entity);
    const basis = input.basis === 'audited' ? 'audited' : 'provisional';

    // A statement set can legitimately be produced before any current-year
    // figure exists: the firm wants the prior year laid out as the comparative
    // column and the current-year column left blank, to be filled in as the
    // year's figures come in. Everything below still computes (so the shape of
    // the statements is real) but the export blanks the current-year column and
    // the proofs are suppressed — there is nothing yet to prove.
    const blankCurrentYear = input.blankCurrentYear != null
      ? !!input.blankCurrentYear
      : !['A', 'B', 'C', 'E1', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N']
          .some(k => num(f[k]) !== 0);

    const A = num(f.A), B = num(f.B), C = num(f.C);
    const E1 = num(f.E1), E2 = num(f.E2), F = num(f.F);
    const G = num(f.G), H = num(f.H), I = num(f.I), J = num(f.J);
    const K = num(f.K), L = num(f.L), M = num(f.M), N = num(f.N);

    // ── Income ──
    const interestIncome = lv.interestIncome != null ? num(lv.interestIncome) : num(py.soi.interestIncome);
    const otherIncome    = lv.otherIncome != null ? num(lv.otherIncome) : num(py.soi.otherIncome);
    const revenueOther   = 0;   // Commissions & Incentives — not an A–N input
    const totalIncome    = A + revenueOther + interestIncome + otherIncome;

    // ── Expenses. Every line grows 5% off the prior year except Rent and
    //    Audit Fee, which rule 1 holds flat. Purchases is the balancing figure.
    const grow = (v) => r0(num(v) * RULES.expenseGrowth);
    const growLine = (it) => ({
      name: it.name,
      amount: RULES.flatExpense.test(it.name) ? num(it.amount) : grow(it.amount),
    });

    const employeeItems = (lv.employeeItems || (py.employeeItems || []).map(growLine));
    const employeeTotal = employeeItems.reduce((s, x) => s + num(x.amount), 0);
    const salary = lv.salary != null ? num(lv.salary)
      : (employeeItems.find(x => /salary/i.test(x.name)) || {}).amount || employeeTotal;

    const otherItemsBase = (py.otherItems || []).map(growLine);
    const otherItems = lv.otherItems || otherItemsBase;
    // Rule 1 overrides, surfaced as levers so the firm can still override a
    // year the fee genuinely changed.
    const auditFee = lv.auditFee != null ? num(lv.auditFee) : num(py.auditFee);
    const rent     = lv.rent != null ? num(lv.rent) : num(py.rent);
    for (const it of otherItems) {
      if (/audit\s*fee/i.test(it.name)) it.amount = auditFee;
      else if (/\brent\b/i.test(it.name)) it.amount = rent;
    }
    const otherTotal = otherItems.reduce((s, x) => s + num(x.amount), 0);

    const directItems = lv.directItems || (py.materials.directItems || []).map(growLine);
    const directTotal = directItems.reduce((s, x) => s + num(x.amount), 0);

    const financeItems = [
      { name: 'Interest Expenses on Term/HP/PWC', amount: E1 },
      { name: 'Interest Expenses OD/CC/DL/STL', amount: E2 },
    ];
    const financeTotal = E1 + E2;

    const depreciation = M;
    // Opening stock is last year's closing. The SFP is the authority: it is the
    // statement, whereas note 3.12 is its breakdown, and real files do get the
    // note wrong — one sample's 3.12 comparative column repeats the current
    // year, disagreeing with its own SFP by 25,98,270. parsePriorYear reports
    // the disagreement; the balance-sheet figure is what gets used.
    const openingStock = num(py.sfp.inventories) || num(py.materials.closing);
    const closingStock = B;

    // Profit before tax must come out at C (Sch-PL D24 "Balance Fig "), so
    // purchases absorbs the difference.
    const nonMaterialExpenses = employeeTotal + financeTotal + depreciation + otherTotal;
    const purchases = r2(totalIncome - C - openingStock - directTotal + closingStock - nonMaterialExpenses);
    const materialsTotal = r2(openingStock + purchases + directTotal - closingStock);
    const totalExpenses = r2(materialsTotal + nonMaterialExpenses);
    const pbt = r2(totalIncome - totalExpenses);

    if (purchases < 0 && !blankCurrentYear) {
      warn(`Goods Purchase solves to a negative figure (${r2(purchases)}). Check Sales (A), Closing Stock (B) and Profit (C) — the profit target may be unreachable at this sales level.`);
    }

    // ── Tax (COI) ──
    const taxableProfit = r2(pbt + M - N);
    const taxRes = taxFor({
      returnType: input.returnType, entity: input.entity,
      specialIndustry: !!input.specialIndustry, sales: A,
      pbt, taxableProfit, basis, localBody: input.localBody,
    });
    const tax = r2(taxRes.amount);
    const netProfit = r2(pbt - tax);

    const allowed = allowedReturnTypes(input.entity, A);
    if (input.returnType && !allowed.includes(input.returnType) && !blankCurrentYear) {
      warn(`Return type ${input.returnType} does not match the turnover: ${T.entity} with sales of ${r0(A).toLocaleString('en-IN')} qualifies for ${allowed.join(' or ')}.`);
    }

    // ── Fixed assets: 3.1 PPE rolls the prior-year carrying forward ──
    const baseClasses = (input.ppeClasses && input.ppeClasses.length)
      ? input.ppeClasses.slice()
      : (py.ppe.classes || []).map((c, i) => ({ key: 'c' + i, name: c.name, kw: [] }));

    const classify = (label) => {
      const l = norm(label);
      for (const c of baseClasses) if ((c.kw || []).some(k => l.includes(k))) return c.key;
      return null;
    };

    // A prior-year column whose heading matches none of the standard classes
    // becomes a class of its own rather than being dropped: losing it would
    // quietly shrink opening PPE and break the cash-flow tie by that amount.
    const classes = baseClasses.slice();
    const pyByKey = {};
    for (const c of (py.ppe.classes || [])) {
      let key = classify(c.name);
      if (!key) {
        key = 'py:' + norm(c.name);
        if (!classes.some(x => x.key === key)) {
          classes.push({ key, name: c.name, kw: [] });
          warn(`Fixed-asset class "${c.name}" in the prior-year 3.1 PPE note matches none of the standard classes, so it is carried through as its own column.`);
        }
      }
      pyByKey[key] = pyByKey[key] || { cost: 0, dep: 0, carrying: 0 };
      pyByKey[key].cost += c.cost;
      pyByKey[key].dep += c.dep;
      pyByKey[key].carrying += c.carrying;
    }
    const ppeIn = {};
    for (const p of (input.ppe || [])) ppeIn[p.key] = p;

    const ppeClasses = classes.map(c => {
      const prior = pyByKey[c.key] || { cost: 0, dep: 0, carrying: 0 };
      const p = ppeIn[c.key] || {};
      const additions = num(p.additions), disposals = num(p.disposals);
      const disposalDep = num(p.disposalDep), impairment = num(p.impairment);
      const depCharge = num(p.depCharge);
      const openCost = prior.cost, openDep = prior.dep;
      const closeCost = r2(openCost + additions - disposals);
      const closeDep = r2(openDep + depCharge + impairment - disposalDep);
      return {
        key: c.key, name: c.name,
        openCost, additions, disposals, closeCost,
        openDep, depCharge, impairment, disposalDep, closeDep,
        openCarrying: r2(openCost - openDep),
        closeCarrying: r2(closeCost - closeDep),
      };
    });
    const ppeTotals = ppeClasses.reduce((t, c) => ({
      openCost: t.openCost + c.openCost, additions: t.additions + c.additions,
      disposals: t.disposals + c.disposals, closeCost: t.closeCost + c.closeCost,
      openDep: t.openDep + c.openDep, depCharge: t.depCharge + c.depCharge,
      impairment: t.impairment + c.impairment, disposalDep: t.disposalDep + c.disposalDep,
      closeDep: t.closeDep + c.closeDep,
      openCarrying: t.openCarrying + c.openCarrying, closeCarrying: t.closeCarrying + c.closeCarrying,
    }), { openCost: 0, additions: 0, disposals: 0, closeCost: 0, openDep: 0, depCharge: 0, impairment: 0, disposalDep: 0, closeDep: 0, openCarrying: 0, closeCarrying: 0 });

    // The depreciation charged in 3.1 PPE and the SLM figure on the income
    // statement are the same number, so a mismatch is a real inconsistency —
    // reported, never quietly reconciled.
    if (Math.abs(ppeTotals.depCharge - M) > 0.5) {
      warn(`Depreciation as per SLM (M = ${r2(M)}) does not equal the total charged across the 3.1 PPE classes (${r2(ppeTotals.depCharge)}).`);
    }

    // ── Balance sheet ──
    const investmentsNC      = num(py.sfp.investmentsNC);
    const otherReceivablesNC = num(py.sfp.otherReceivablesNC);
    const ppeClosing         = ppeClasses.length ? ppeTotals.closeCarrying : r2(num(py.sfp.ppe) + ppeTotals.additions - ppeTotals.disposals - M);
    const totalNCA           = r2(ppeClosing + investmentsNC + otherReceivablesNC);

    const investmentsC = 0;
    const inventories  = closingStock;
    const vatReceivable = Math.max(0, L);
    const vatPayable    = Math.max(0, -L);
    const advanceTds    = K;
    const prepayments   = 0;

    // Cash is seeded, not derived: the spec asks for 2–9 lakh "unique on Each
    // case", and seeding from client identity keeps it reproducible across
    // re-runs (auditability) instead of moving every time.
    const seedKey = input.seedKey || `${(input.company || {}).pan || ''}|${(input.company || {}).name || ''}|${input.fy || ''}`;
    const rng = EM.seededRng(seedKey);
    const cash = lv.cash != null ? num(lv.cash)
      : EM.deRound(Math.round(RULES.cashLo + rng() * (RULES.cashHi - RULES.cashLo)));

    // ── Equity ──
    const dividend = num(lv.dividend);
    const soceOpen = {
      shareCapital: num(py.equity.shareCapital),
      sharePremium: num(py.equity.sharePremium),
      retained: num(py.equity.retained),
      otherReserves: num(py.equity.otherReserves),
    };
    const soceClose = {
      shareCapital: r2(soceOpen.shareCapital + F),
      sharePremium: soceOpen.sharePremium,
      retained: r2(soceOpen.retained + netProfit - dividend),
      otherReserves: soceOpen.otherReserves,
    };
    const shareCapital = soceClose.shareCapital;
    const reserves = r2(soceClose.sharePremium + soceClose.retained + soceClose.otherReserves);
    const totalEquity = r2(shareCapital + reserves);

    // ── Liabilities. Prior-year payables are settled in cash ("Pay All P/Y
    //    Payable thorough cash"), so current-year accruals stand alone. ──
    const tdsAuditFee = r2(auditFee * RULES.tdsAuditFee);
    const auditFeePayable = r2(auditFee - tdsAuditFee);
    const tdsSalary = r2(salary * RULES.tdsSalary);
    const tdsRent = r2(rent * RULES.tdsRent);
    const salaryPayable = r2(salary / 12 * RULES.salaryPayableMonths);
    const expensesPayable = num(lv.expensesPayable);
    // Trade Payables defaults to the uploaded purchase detail's closing-balance
    // total (Sch-BS H91 = +p!D12 in the template) but is overridable, because
    // the detail file is optional and the figure is often known before it. It
    // drives note 3.9, the SFP line, the cash-flow payables movement and — via
    // the balance sheet — the balancing receivable.
    const tradePayables = lv.tradePayables != null ? num(lv.tradePayables) : num(input.purchaseTotal);

    const payableLines = [
      { name: 'Trade Payables', amount: tradePayables },
      { name: 'Audit Fee Payable', amount: auditFeePayable },
      { name: 'Expenses Payable', amount: expensesPayable },
      { name: 'Salary Payable', amount: salaryPayable },
      { name: 'TDS on Salary', amount: tdsSalary },
      { name: 'TDS on Rent', amount: tdsRent },
      { name: 'TDS Payable-Audit fee', amount: tdsAuditFee },
      { name: 'VAT Payable', amount: vatPayable },
    ];
    const totalPayables = r2(payableLines.reduce((s, x) => s + x.amount, 0));

    const provisionTax = tax;
    const provisionsNC = 0;
    const provisionsC = r2(provisionTax - provisionsNC);

    // Director/proprietor loan is a lever of last resort: it only appears when
    // the balancing receivable would otherwise be negative (Work Performed
    // G31 — "If Cash is Negative then Increase Director loan").
    let directorLoan = num(lv.directorLoan);
    const loansCurrent = G;

    const solveReceivable = (dirLoan) => {
      const loansNonCurrent = r2(H + I + J + dirLoan);
      const totalNCL = r2(loansNonCurrent + provisionsNC);
      const totalCL = r2(loansCurrent + totalPayables + provisionsC);
      const totalLiabilities = r2(totalNCL + totalCL);
      const totalEquityLiab = r2(totalEquity + totalLiabilities);
      const otherAssets = r2(totalNCA + investmentsC + inventories + prepayments + vatReceivable + advanceTds + cash);
      return {
        loansNonCurrent, totalNCL, totalCL, totalLiabilities, totalEquityLiab, otherAssets,
        tradeReceivables: r2(totalEquityLiab - otherAssets),
      };
    };

    let bs = solveReceivable(directorLoan);
    if (bs.tradeReceivables < 0 && lv.directorLoan == null && !blankCurrentYear) {
      directorLoan = EM.round1000Up(directorLoan - bs.tradeReceivables);
      bs = solveReceivable(directorLoan);
      warn(`Trade Receivables solved negative, so ${T.person} loan was raised to ${r0(directorLoan).toLocaleString('en-IN')} to bring it back to zero or above.`);
    }
    if (bs.tradeReceivables < 0 && !blankCurrentYear) {
      err(`Trade Receivables is negative (${r2(bs.tradeReceivables)}). Raise the ${T.person} loan or revisit the loan and capital figures.`);
    }

    const receivableLines = [
      { name: 'Trade Receivables', amount: bs.tradeReceivables, balancing: true },
      { name: 'Prepayments', amount: prepayments },
      { name: 'Vat Receivables', amount: vatReceivable },
      { name: 'Advance & TDS Receivables', amount: advanceTds },
    ];
    const receivables = r2(bs.tradeReceivables + prepayments + vatReceivable + advanceTds);
    const totalCA = r2(investmentsC + inventories + receivables + cash);
    const totalAssets = r2(totalNCA + totalCA);

    // ── Cash flow. Every figure is a delta of the two balance sheets or a
    //    line of the income statement — exactly the template's own formulas,
    //    which expand to the balance-sheet identity, so the closing cash ties
    //    to the seeded figure by construction rather than by adjustment. ──
    const dRecv  = r2(num(py.sfp.receivables) - receivables);
    const dStock = r2(num(py.sfp.inventories) - inventories);
    const dPay   = r2(totalPayables - num(py.sfp.payables));
    const dInv   = r2((num(py.sfp.investmentsNC) + num(py.sfp.investmentsC)) - (investmentsNC + investmentsC));
    // Income Tax Paid is last year's provision being settled. The template
    // writes it as the prior year's tax EXPENSE, which is the same figure
    // whenever provisions carry current tax only — but the balance-sheet
    // provision is what actually leaves, and using it is what keeps the
    // closing cash tied.
    const priorProvision = r2(num(py.sfp.provisionsNC) + num(py.sfp.provisionsC));
    const taxPaid = priorProvision || num(py.soi.tax);

    const cfOperating = {
      profit: netProfit,
      depreciation: r2(depreciation + ppeTotals.impairment),
      interestIncome, financeCost: financeTotal,
      ppeLoss: 0, taxExpense: tax,
      dRecv, dStock, dPay,
    };
    const generated = r2(cfOperating.profit + cfOperating.depreciation - interestIncome
      + financeTotal + cfOperating.ppeLoss + tax + dRecv + dStock + dPay);
    const interestPaid = financeTotal;
    const netOperating = r2(generated - interestPaid - taxPaid);

    const cfInvesting = {
      ppeAcquired: r2(-ppeTotals.additions),
      investments: dInv,
      interestReceived: interestIncome,
      ppeProceeds: r2(ppeTotals.disposals - ppeTotals.disposalDep),
    };
    const netInvesting = r2(cfInvesting.ppeAcquired + cfInvesting.investments
      + cfInvesting.interestReceived + cfInvesting.ppeProceeds);

    const cfFinancing = {
      capital: r2(shareCapital - num(py.sfp.shareCapital)),
      nonCurrentBorrowings: r2(bs.loansNonCurrent - num(py.sfp.loansNC)),
      currentBorrowings: r2(loansCurrent - num(py.sfp.loansC)),
      drawing: r2(-dividend),
    };
    const netFinancing = r2(cfFinancing.capital + cfFinancing.nonCurrentBorrowings
      + cfFinancing.currentBorrowings + cfFinancing.drawing);

    const netIncrease = r2(netOperating + netInvesting + netFinancing);
    const openingCash = num(py.sfp.cash);
    const closingCash = r2(netIncrease + openingCash);

    // ── The two proof rows. Shown, never forced (the Final Account precedent):
    //    a non-zero figure is a real finding about the inputs. ──
    const proofs = blankCurrentYear
      ? { balanceSheet: null, cashFlow: null, profit: null, blank: true }
      : {
        balanceSheet: r2(totalAssets - bs.totalEquityLiab),
        cashFlow: r2(closingCash - cash),
        profit: r2(pbt - C),
      };
    if (!blankCurrentYear) {
      if (Math.abs(proofs.balanceSheet) > 0.5) err(`Balance sheet is out by ${r2(proofs.balanceSheet)}.`);
      if (Math.abs(proofs.cashFlow) > 0.5) warn(`Cash flow closing cash is out by ${r2(proofs.cashFlow)} against the balance-sheet cash.`);
    }

    return {
      meta: {
        company: input.company || {}, fy: input.fy, fyPrev: input.fyPrev,
        basis, returnType: input.returnType, entity: input.entity,
        specialIndustry: !!input.specialIndustry,
        auditor: input.auditor || {}, terms: T,
        titles: {
          sfp: TITLES.sfp[basis], soi: TITLES.soi[basis],
          soce: TITLES.soce[basis], socf: TITLES.socf[basis],
        },
        allowedReturnTypes: allowed,
        blankCurrentYear,
        serviceIndustry: !!input.serviceIndustry,
        // B.S. date wording ("As at 32nd Ashadh 2082 (16th July 2025)") is
        // built by the UI through NepaliLocale and passed straight through, so
        // the engine stays free of calendar concerns.
        ...(input.labels || {}),
      },
      income: {
        revenueOps: A, revenueOther, interestIncome, otherIncome, totalIncome,
        materials: {
          opening: openingStock, purchases, directItems, directTotal,
          closing: closingStock, total: materialsTotal,
        },
        employeeItems, employeeTotal, salary,
        financeItems, financeTotal,
        depreciation, otherItems, otherTotal,
        totalExpenses, pbt, tax, netProfit,
      },
      coi: {
        pbt, depSlm: M, depIncomeTax: N, taxableProfit,
        taxBase: taxRes.on, tax, rule: taxRes.note, basis,
      },
      balance: {
        ppe: ppeClosing, investmentsNC, otherReceivablesNC, totalNCA,
        investmentsC, inventories, receivableLines, receivables, cash, totalCA,
        totalAssets,
        shareCapital, reserves, totalEquity,
        loansNonCurrent: bs.loansNonCurrent, provisionsNC, totalNCL: bs.totalNCL,
        loansCurrent, payableLines, totalPayables, provisionsC, totalCL: bs.totalCL,
        totalLiabilities: bs.totalLiabilities, totalEquityLiab: bs.totalEquityLiab,
      },
      soce: { open: soceOpen, close: soceClose, profit: netProfit, capital: F, dividend },
      ppe: { classes: ppeClasses, totals: ppeTotals },
      cashflow: {
        operating: cfOperating, generated, interestPaid, taxPaid, netOperating,
        investing: cfInvesting, netInvesting,
        financing: cfFinancing, netFinancing,
        netIncrease, openingCash, closingCash,
      },
      levers: { cash, dividend, directorLoan, auditFee, rent, expensesPayable, tradePayables, purchases },
      // Carried through for the export layer: the comparative column comes
      // straight off the prior-year model, and Sch-BS 3.8 shows the loan inputs
      // broken out as Term / PWC / HP rather than only as their total.
      priorYear: py,
      rawFigures: { A, B, C, E1, E2, F, G, H, I, J, K, L, M, N },
      proofs,
      issues,
    };
  }

  return {
    TAX, D3_SLABS, RULES, TITLES, TERMS, termsFor,
    taxFor, progressiveTax, allowedReturnTypes,
    parsePriorYear, build,
  };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// for engine verification scripts.
if (typeof module !== 'undefined' && module.exports) module.exports = FinStatementEngine;
else window.FinStatementEngine = FinStatementEngine;
