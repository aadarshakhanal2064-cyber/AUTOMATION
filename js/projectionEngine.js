// ── ProjectionEngine — pure calculation core for the Projection Report module ──
// No DOM access anywhere in this file: it parses the firm's standard NFRS
// financial-statement workbook into a normalized InputModel, projects it
// forward N years under the master-workbook rules, and validates the result.
// js/projection.js owns all UI; this file must stay loadable in Node for
// engine verification against the real sample files (see the export guard at
// the bottom), which is why it takes a SheetJS workbook object rather than
// reading files itself.
//
// Source of truth: "overall important format that will be use in the app and
// ui and rules.xlsx" (File 3) — its BS/Pl/CF/Dep/IRD sheets define the output
// format and its NCA sheet defines the 10 business rules. See the plan doc
// and CLAUDE.md §5.15.

const ProjectionEngine = (() => {

  // ───────────────────────── shared helpers ─────────────────────────

  // The label-driven Excel locators live in js/core/workbookReader.js — the
  // Financial Statement module reads the same workbook family, so they are
  // shared rather than duplicated.
  const WR = (typeof module !== 'undefined' && module.exports)
    ? require('./core/workbookReader')
    : window.WorkbookReader;

  const { num, norm, grid, findSheet, findRowIdx, findHeader, labelValue } = WR;

  // ───────────────────────── the parser ─────────────────────────

  // Depreciation pools of the master Dep sheet (File 3), in display order.
  // Rates are WDV per the master; Land never depreciates. `kw` matches both
  // the 3.1 PPE column headers of the input file and free-text labels.
  const DEP_POOLS = [
    { key: 'land',      name: 'Land',                          rate: 0,    kw: ['land'] },
    { key: 'building',  name: 'Building & Structure',          rate: 0.05, kw: ['building', 'structure'] },
    // 'other ass' rather than 'other asset': real statements spell this column
    // "Other Assects" / "Other Assests" as often as correctly, and an unmatched
    // column is silently dropped from the schedule (see the residual
    // reconciliation below, which is the real guard).
    { key: 'plant',     name: 'Plant Machinery & other Assets',rate: 0.15, kw: ['plant', 'machin', 'other ass'] },
    { key: 'office',    name: 'Office Equipment',              rate: 0.25, kw: ['office', 'equipment', 'computer', 'furniture', 'fixture'] },
    { key: 'vehicle',   name: 'Vehicles',                      rate: 0.20, kw: ['vehicle'] },
    { key: 'software',  name: 'Software',                      rate: 0.15, kw: ['software'] },
    { key: 'leasehold', name: 'Leasehold',                     rate: 0.07, kw: ['leasehold', 'leashold', 'lease hold'] },
  ];

  function classifyPool(label) {
    const l = norm(label);
    if (!l) return null;
    for (const p of DEP_POOLS) if (p.kw.some(k => l.includes(k))) return p.key;
    return null;
  }

  // Parse the firm's standard NFRS statement workbook (File 1 shape) into a
  // normalized InputModel. `wb` is a SheetJS workbook; `XLSX` is the SheetJS
  // namespace (passed in so this file has zero direct vendor imports).
  // Returns { model, issues } — issues are parse warnings, each { level:
  // 'error'|'warn', msg }; an 'error' means a figure the projection cannot
  // proceed without.
  function parseStatement(wb, XLSX) {
    const issues = [];
    const err = (msg) => issues.push({ level: 'error', msg });
    const warn = (msg) => issues.push({ level: 'warn', msg });

    const model = {
      company: { name: '', address: '', bsYear: null },
      ppe: {},               // poolKey -> closing carrying amount
      ppeTotal: 0,
      investmentsNC: 0,
      otherReceivablesNC: 0,
      provisionsNC: 0,
      inventory: { opening: 0, closing: 0 },
      shareCapital: 0,
      reserves: 0,
      loans: { term: [], directorLoan: 0, overdraft: 0, nonCurrentTotal: 0, currentTotal: 0 },
      revenue: { operations: 0, nonOperations: 0 },
      materials: { opening: 0, purchases: 0, directCost: 0, directCostItems: [], closing: 0, total: 0 },
      salary: 0,
      financeCost: 0,
      otherExpenses: [],     // [{ name, amount }] from Note 3.15 (incl. audit fee)
      auditFee: 0,
      extraExpenses: [],     // SOI expense rows carrying no 3.12–3.15 note (e.g. Incentive)
      tax: 0,
      profitBeforeTax: 0,
      netProfit: 0,
      debtors: 0,
      cash: 0,
      creditors: 0,          // trade payables only (Sch-BS 3.9 first row)
      currentAssetsTotal: 0,
      currentLiabilitiesTotal: 0,
    };

    // ── SFP (Statement of Financial Position) — headline figures ──
    const sfp = findSheet(wb, ['SFP', 'Statement of Financial Position', 'Balance Sheet', 'BS']);
    if (!sfp) { err('Could not find the Balance Sheet sheet (SFP).'); return { model, issues }; }
    const gS = grid(sfp, XLSX);

    // Company name/address sit above the header; take the first two
    // non-empty text rows before the "Statement of ..." title.
    {
      const titleRow = findRowIdx(gS, /statement of financial|balance sheet/);
      const texts = [];
      for (let r = 0; r < (titleRow === -1 ? 6 : titleRow); r++) {
        const row = gS[r]; if (!row) continue;
        const cell = row.find(v => typeof v === 'string' && v.trim());
        if (cell) texts.push(cell.trim());
      }
      model.company.name = texts[0] || '';
      model.company.address = texts[1] || '';
      // B.S. year from the "As at 32nd Ashadh 2083" line
      const asAtRow = findRowIdx(gS, /as at .*(20[6-9]\d)/);
      if (asAtRow !== -1) {
        const cell = gS[asAtRow].find(v => typeof v === 'string' && /as at/i.test(v));
        const m = String(cell).match(/(20[6-9]\d)/);
        if (m) model.company.bsYear = parseInt(m[1], 10);
      }
    }

    const hS = findHeader(gS);
    if (!hS) { err('SFP sheet has no recognizable "Particulars" header row.'); return { model, issues }; }
    const sfpVal = (re, what, required) => {
      const hit = labelValue(gS, re, hS.labelCol, hS.valCol, hS.row + 1);
      if (!hit) { (required ? err : warn)(`SFP: could not find "${what}".`); return 0; }
      return hit.value;
    };

    model.ppeTotal            = sfpVal(/property.*plant|plant and equipment/, 'Property, Plant and Equipment', true);
    // Non-current side items — usually zero for these clients, but needed for
    // the year-1 cash-flow tie (the projected BS carries no such rows, so any
    // audited balance must be shown as liquidated in CF investing).
    model.investmentsNC       = sfpVal(/^investment/, 'Investments (non-current)', false);
    model.otherReceivablesNC  = sfpVal(/^other receivable/, 'Other Receivables (non-current)', false);
    model.inventory.closing   = sfpVal(/inventor/, 'Inventories', true);
    model.debtors             = sfpVal(/trade and other receivable|trade & other receivable/, 'Trade and Other Receivables', true);
    model.cash                = sfpVal(/cash and cash|cash & cash/, 'Cash and Cash Equivalents', true);
    model.currentAssetsTotal  = sfpVal(/total current assets/, 'Total Current Assets', true);
    model.shareCapital        = sfpVal(/share capital/, 'Share Capital', true);
    model.reserves            = sfpVal(/^reserve/, 'Reserves', true);
    // First "Provisions" row on the liabilities side = the non-current one.
    model.provisionsNC        = sfpVal(/^provision/, 'Provisions (non-current)', false);
    model.currentLiabilitiesTotal = sfpVal(/total current liabilit/, 'Total Current Liabilities', true);

    // ── SOI (Statement of Income) ──
    const soi = findSheet(wb, ['SOI', 'Statement of Income', 'Income Statement', 'Profit']);
    if (!soi) { err('Could not find the Income Statement sheet (SOI).'); return { model, issues }; }
    const gI = grid(soi, XLSX);
    const hI = findHeader(gI);
    if (!hI) { err('SOI sheet has no recognizable "Particulars" header row.'); return { model, issues }; }
    const soiVal = (re, what, required) => {
      const hit = labelValue(gI, re, hI.labelCol, hI.valCol, hI.row + 1);
      if (!hit) { (required ? err : warn)(`SOI: could not find "${what}".`); return 0; }
      return hit.value;
    };
    model.revenue.operations  = soiVal(/revenue from operation/, 'Revenue From Operations', true);
    model.profitBeforeTax     = soiVal(/profit before tax/, 'Profit Before Tax', true);
    model.tax                 = soiVal(/income tax expense/, 'Income Tax Expenses', false);
    model.netProfit           = soiVal(/net profit for/, 'Net Profit For the Year', false);
    {
      // Expense rows that belong to no detail note (e.g. "Incentive Expenses")
      // — everything between "B. EXPENSES" and "Total Expenses" whose label
      // isn't one of the noted categories.
      const start = findRowIdx(gI, /^b\.? expenses|^expenses$/, hI.row);
      const end   = findRowIdx(gI, /total expenses/, start + 1, hI.labelCol);
      const noted = /material|employee|finance|depreciation|other expense/;
      if (start !== -1 && end !== -1) {
        for (let r = start + 1; r < end; r++) {
          const label = gI[r] && gI[r][hI.labelCol];
          if (!label) continue;
          const clean = String(label).replace(/^[a-z]\)\s*/i, '').trim();
          if (!noted.test(norm(clean)) && num(gI[r][hI.valCol]) !== 0) {
            model.extraExpenses.push({ name: clean, amount: num(gI[r][hI.valCol]) });
          }
        }
      }
      // Non-operations revenue = Total Income − operations
      const totalIncome = soiVal(/total income/, 'Total Income', false);
      if (totalIncome) model.revenue.nonOperations = totalIncome - model.revenue.operations;
    }

    // ── Sch-PL — Notes 3.12 (materials), 3.13 (salary), 3.15 (other expenses) ──
    const schPl = findSheet(wb, ['Sch-PL', 'Sch PL', 'Schedule PL', 'Schedules-PL']);
    if (!schPl) { err('Could not find the P&L schedules sheet (Sch-PL).'); return { model, issues }; }
    const gP = grid(schPl, XLSX);

    const section = (titleRe) => WR.noteSection(gP, titleRe);

    // 3.12 Materials Consumed
    const s312 = section(/^3\.12/);
    if (s312) {
      const val = (re) => { const hit = labelValue(gP, re, s312.labelCol, s312.valCol, s312.titleRow, s312.endRow + 1); return hit ? hit.value : 0; };
      model.materials.opening   = val(/balance on beginning/);
      model.materials.purchases = val(/purchase/);
      model.materials.closing   = val(/balance as at end/);
      const hit = labelValue(gP, /^total$/, s312.labelCol, s312.valCol, s312.titleRow);
      model.materials.total = hit ? hit.value : 0;
      // Direct-cost items = everything between "Add:" and "Less:" that is
      // not the purchases row (master Pl!B13: "Sum of other item (except
      // Purchase of Goods, Balance on Beginning & Balance as at end)").
      const addRow  = findRowIdx(gP, /^add:?$/, s312.titleRow, s312.labelCol);
      const lessRow = findRowIdx(gP, /^less:?$/, addRow + 1, s312.labelCol);
      if (addRow !== -1 && lessRow !== -1) {
        for (let r = addRow + 1; r < lessRow; r++) {
          const label = gP[r] && gP[r][s312.labelCol];
          if (!label || /purchase/.test(norm(label))) continue;
          const amount = num(gP[r][s312.valCol]);
          model.materials.directCostItems.push({ name: String(label).trim(), amount });
          model.materials.directCost += amount;
        }
      }
    } else warn('Sch-PL: Note 3.12 (Materials Consumed) not found.');

    // 3.13 Employee Benefits
    const s313 = section(/^3\.13/);
    if (s313) {
      const hit = labelValue(gP, /^total$/, s313.labelCol, s313.valCol, s313.titleRow);
      model.salary = hit ? hit.value : 0;
    } else warn('Sch-PL: Note 3.13 (Employee Benefits) not found.');

    // 3.14 Finance Cost
    const s314 = section(/^3\.14/);
    if (s314) {
      const hit = labelValue(gP, /^total$/, s314.labelCol, s314.valCol, s314.titleRow);
      model.financeCost = hit ? hit.value : 0;
    }

    // 3.15 Other Expenses — every itemized row, in order
    const s315 = section(/^3\.15/);
    if (s315) {
      for (let r = s315.row + 1; r < s315.endRow; r++) {
        const label = gP[r] && gP[r][s315.labelCol];
        if (!label || /^total$/.test(norm(label))) continue;
        const amount = num(gP[r][s315.valCol]);
        const name = String(label).trim();
        model.otherExpenses.push({ name, amount });
        if (/audit fee/.test(norm(name))) model.auditFee = amount;
      }
    } else warn('Sch-PL: Note 3.15 (Other Expenses) not found.');

    // ── Sch-BS — Note 3.8 loan split (term / director / overdraft) + 3.9 creditors ──
    const schBs = findSheet(wb, ['Sch-BS', 'Sch BS', 'Schedule BS', 'Schedules-BS']);
    if (schBs) {
      const gB = grid(schBs, XLSX);
      const t38 = findRowIdx(gB, /^3\.8/);
      if (t38 !== -1) {
        const h = findHeader(gB, t38);
        if (h) {
          const end = findRowIdx(gB, /total loans and borrowing/, h.row + 1, h.labelCol);
          for (let r = h.row + 1; r < (end === -1 ? h.row + 25 : end); r++) {
            const label = gB[r] && gB[r][h.labelCol];
            if (!label) continue;
            const l = norm(label);
            if (/^total$|^non-current|^current\s*:?$/.test(l)) continue;
            const amount = num(gB[r][h.valCol]);
            if (amount === 0) continue;
            if (/director|proprietor|partner/.test(l)) model.loans.directorLoan += amount;
            else if (/overdraft|hypothec|\bod\b|\bcc\b|short/.test(l)) model.loans.overdraft += amount;
            else model.loans.term.push({ name: String(label).trim(), amount });
          }
          model.loans.nonCurrentTotal = model.loans.term.reduce((s, x) => s + x.amount, 0) + model.loans.directorLoan;
          model.loans.currentTotal = model.loans.overdraft;
        }
      } else warn('Sch-BS: Note 3.8 (Loans & Borrowings) not found — loan split unavailable.');
      const t39 = findRowIdx(gB, /^3\.9/);
      if (t39 !== -1) {
        const h = findHeader(gB, t39);
        if (h) {
          const hit = labelValue(gB, /trade payable/, h.labelCol, h.valCol, h.row + 1);
          if (hit) model.creditors = hit.value;
        }
      }
    } else warn('Sch-BS sheet not found — loan/creditor detail unavailable.');

    // ── 3.1 PPE — per-pool closing carrying amounts ──
    const ppe = findSheet(wb, ['3.1 PPE', 'PPE', 'Property']);
    if (ppe) {
      const gPP = grid(ppe, XLSX);
      const h = findHeader(gPP);
      if (h) {
        // Map header columns to pools by keyword (columns beyond the label col).
        const headerRow = gPP[h.row];
        const colPool = {};
        for (let c = h.labelCol + 1; c < headerRow.length; c++) {
          const pool = classifyPool(headerRow[c]);
          if (pool && !/total/.test(norm(headerRow[c]))) colPool[c] = pool;
        }
        // Closing carrying amount = the LAST "As at ..." row under "Carrying Amount:".
        const carry = findRowIdx(gPP, /^carrying amount/, h.row, h.labelCol);
        let closingRow = -1;
        for (let r = carry + 1; r < gPP.length; r++) {
          if (gPP[r] && /^as at/.test(norm(gPP[r][h.labelCol]))) closingRow = r;
        }
        if (closingRow !== -1) {
          for (const [c, pool] of Object.entries(colPool)) {
            model.ppe[pool] = (model.ppe[pool] || 0) + num(gPP[closingRow][c]);
          }
        } else warn('3.1 PPE: carrying-amount closing row not found.');
      } else warn('3.1 PPE: header row not found.');
    } else warn('3.1 PPE sheet not found — depreciation pools will start empty.');

    // The pools MUST sum to the SFP fixed-asset total. Working the year-1 cash
    // flow through algebraically, every term cancels except one:
    //     CF closing cash − BS cash  =  Σ(pools) − ppeTotal
    // so a single unrecognised column in Note 3.1 breaks the cash-flow tie by
    // exactly its carrying amount and nothing else in the report shows why.
    // (This shipped: a column headed "Other Assects" matched no pool keyword
    // and took 7,69,636 with it.) Booking the residual keeps the tie true for
    // any input file, however the note is spelled or laid out — the pool is
    // "Plant, Machinery & other Assets", which is also the correct Income Tax
    // Act 2058 block for assets the note does not otherwise classify.
    {
      const sum = Object.values(model.ppe).reduce((s, v) => s + v, 0);
      const residual = model.ppeTotal - sum;
      if (Math.abs(residual) > 1) {
        model.ppe.plant = (model.ppe.plant || 0) + residual;
        warn(`Note 3.1 accounts for ${sum.toFixed(2)} of the ${model.ppeTotal.toFixed(2)} fixed assets on the balance sheet; `
           + `the unmatched ${residual.toFixed(2)} has been booked to "Plant Machinery & other Assets" (15%) so the `
           + `depreciation schedule and cash flow still tie. Check the column headings in Note 3.1 if this looks wrong.`);
      }
    }

    // Cross-check: inventory in SFP vs Note 3.12 closing balance.
    if (model.materials.closing && model.inventory.closing &&
        Math.abs(model.materials.closing - model.inventory.closing) > 1) {
      warn('Closing stock differs between SFP Inventories and Note 3.12.');
    }
    model.inventory.opening = model.materials.opening;

    return { model, issues };
  }

  // ───────────────────────── projection helpers ─────────────────────────

  // Ratio thresholds + growth conventions from the master NCA sheet. These are
  // the bank-facing constraints every projected year must satisfy.
  const LIMITS = {
    maxDebtorDays: 90,     // rule 5/8: debtor turnover
    minDebtorDays: 30,     // CA rule (2026-07-22): a collection cycle under 30
                           // days reads as fabricated to a bank — flag + auto-lift
    minNca: 100000,        // <30-day step (a) won't push Net Current Assets below this
    minNcaHeadroom: 100000, // CA rule (2026-08-02): the NCA working's closing line
                           // H = F − G ("Difference (always positive)") must clear
                           // 1 lakh, not merely be positive — a drawing power that
                           // only just covers the facility leaves the bank no margin
    minCurrentRatio: 1.5,  // rule 4
    maxDebtEquity: 2.33,   // rule 3
    // Ratio tests are solved STRICTLY. This was ±0.005, which let a year settle
    // at a true current ratio of 1.4950 and print as "1.50 ≥ 1.5" — the export
    // shows two decimals, so the slack was invisible in the delivered report.
    ratioEps: 1e-6,
    ncaFactor: 0.70,       // bank drawing power = 70% of NCA (rule 2 / "Always Positive").
                           // DEFAULT ONLY — the user enters this per report (asm.ncaPct);
                           // it is never recalculated or overwritten by the engine.
    minCash: 100000,       // CA rule (2026-07-28): cash may be cut this low — but no lower —
                           // to buy the NCA room that lets owner capital be given back
    profitGrowth: 1.05,    // CA rule (2026-07-25): Gross Profit AND Net Profit must each
                           // rise ≥5%/yr — purchases is the balancing figure that forces it
    creditorRuleFloor: 1000000,  // rule 3: applies when provisional payable exceeds 10 lakh
    creditorLoPct: 0.75,   // …then projected creditors = provisional × [0.75, 0.80],
    creditorHiPct: 0.80,   //    seeded per client (unique, reproducible)
    expenseGrowth: 1.05,   // every admin line grows 5%/yr (master Pl "×1.05")
    stockBuffer: 1.05,     // rule 1 (CA, 2026-07-28): yr-1 closing stock =
                           // max(STL ÷ NCA% × 1.05, opening × 1.05)
    stockGrowth: 1.05,     // yr-2+ closing stock = opening × 1.05
    creditorDecay: 0.90,   // creditors shrink 10%/yr after yr 1
    minPurchasePct: 0.50,  // CA rule (2026-07-29): closing stock may be cut to avoid
                           // owner capital, but never so far that Goods Purchase falls
                           // below half the provisional year's — a trading company that
                           // appears to buy nothing would not survive a bank's reading
    maxStockCutPct: 0.25,  // CA rule (2026-08-02): and never more than a quarter below
                           // the figure the stock rules themselves produced. The
                           // purchases bound alone is not enough — on a file with low
                           // purchases relative to inventory it still allows a collapse
                           // in closing stock that no bank would read as genuine.
    cashGrowth: 1.10,      // cash grows 10%/yr after yr 1, rounded to nearest 10
  };

  // Rule 9 tax: corporates/partnerships flat 25%; proprietorships use the
  // progressive slabs from the master NCA sheet (amount-width, rate).
  const TAX_SLABS = [[1000000, 0], [500000, 0.10], [1000000, 0.20], [1500000, 0.27], [Infinity, 0.29]];

  function taxFor(pbt, profile) {
    if (!(pbt > 0)) return 0;
    if (profile !== 'progressive') return pbt * 0.25;
    let rem = pbt, tax = 0;
    for (const [width, rate] of TAX_SLABS) {
      const slice = Math.min(rem, width);
      tax += slice * rate; rem -= slice;
      if (rem <= 0) break;
    }
    return tax;
  }

  // Standard EMI amortization, reported per fiscal year. The master says
  // "use EMI Shedule and Calculate Closing Balance" for LT/PWC loans.
  function emiSchedule(principal, annualRatePct, tenorYears, nYears) {
    const r = annualRatePct / 100 / 12;
    const n = Math.max(1, Math.round(tenorYears * 12));
    const emi = r === 0 ? principal / n : principal * r / (1 - Math.pow(1 + r, -n));
    const years = [];
    let bal = principal, m = 0;
    for (let y = 1; y <= nYears; y++) {
      const opening = bal;
      let interest = 0, princ = 0;
      for (let i = 0; i < 12 && m < n && bal > 0.005; i++, m++) {
        const int_ = bal * r;
        let p = Math.min(emi - int_, bal);
        interest += int_; princ += p; bal -= p;
      }
      years.push({ opening, interest, principal: princ, closing: bal });
    }
    return years;
  }

  // Deterministic "unique-looking" figures (cash 5–9 lakh, creditors 2–8
  // lakh). The master asks for a different number "every time"; we seed from
  // client+FY instead of using Math.random so a re-run reproduces the same
  // report (auditability — a deliberate improvement over the workbook).
  // seededRng and the '000 rounding live in js/core/engineMath.js — the
  // Financial Statement engine seeds its cash the same way.
  const EM = (typeof module !== 'undefined' && module.exports)
    ? require('./core/engineMath')
    : window.EngineMath;

  const { seededRng, round1000Up, round1000Down } = EM;

  const round1000     = (v) => Math.round(v / 1000) * 1000;
  const round10       = (v) => Math.round(v / 10) * 10;

  // Rent & Audit Fee follow a stepped schedule (CA rule 2026-07-23) instead of
  // the 5%/yr admin growth: the audited/provisional base is rounded to '000 and
  // held flat, then stepped up 15% (re-rounded to '000) every 3rd projection
  // year — so years 1-2 sit at the base, years 3-5 at base×1.15, years 6-8 at
  // base×1.15², and so on (bumps land on years 3, 6, 9…).
  const STEP_FEE_RE = /\brent\b|audit fee/i;
  const steppedFee = (base, year) => round1000(round1000(base) * Math.pow(1.15, Math.floor(year / 3)));

  // Gross Profit needed to land a target Net-Profit-after-tax, given the
  // year's fixed deductions (admin + interest + depreciation).
  //   PBT = GP − deductions ;  NP = PBT − taxFor(PBT, profile)
  // NP rises monotonically with GP, but the proprietorship slabs make it
  // piecewise, so invert numerically rather than algebraically. Bisection on a
  // bracket grown from the flat-rate estimate; deterministic and quick.
  function gpForTargetNp(targetNp, deductions, profile) {
    const npAt = (gp) => { const pbt = gp - deductions; return pbt - taxFor(pbt, profile); };
    let lo = deductions, hi = deductions + Math.max(1000, targetNp * 2 + 1000);
    for (let i = 0; i < 60 && npAt(hi) < targetNp; i++) hi = deductions + (hi - deductions) * 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (npAt(mid) < targetNp) lo = mid; else hi = mid;
    }
    return hi;
  }

  // 7-pool WDV depreciation, N years. Additions/disposals apply in year 1
  // only (the master UI collects one Addition (O) and Sales (P) per pool).
  // Note: the master's own year-3 block wrongly re-adds the prior closing
  // balance as an Addition (Dep!D30={=+I18}) — a copy error we deliberately
  // do not reproduce.
  function projectDepreciation(openingPools, additions, disposals, nYears) {
    const years = [];
    let opening = { ...openingPools };
    for (let y = 1; y <= nYears; y++) {
      const rows = DEP_POOLS.map(p => {
        const o = opening[p.key] || 0;
        const add = y === 1 ? num(additions && additions[p.key]) : 0;
        const dis = y === 1 ? num(disposals && disposals[p.key]) : 0;
        const total = o + add - dis;
        const dep = Math.max(0, total) * p.rate;
        return { pool: p.key, name: p.name, opening: o, addition: add, disposal: dis, total, rate: p.rate, dep, closing: total - dep };
      });
      const T = f => rows.reduce((s, r) => s + f(r), 0);
      years.push({
        rows,
        opening: T(r => r.opening), addition: T(r => r.addition), disposal: T(r => r.disposal),
        total: T(r => r.total), dep: T(r => r.dep), closing: T(r => r.closing),
      });
      opening = {};
      rows.forEach(r => { opening[r.pool] = r.closing; });
    }
    return years;
  }

  // ───────────────────────── the projection ─────────────────────────

  // project(input, asm) → { years: [...], meta }
  //
  // input: the parsed InputModel. asm (assumptions):
  //   years        1–10
  //   growthY1Pct  sales growth % in year 1 (E)
  //   growthRestPct  sales growth % in later years (F)
  //   stLoans      [{ amount, ratePct }]           — constant balance (G,H)
  //   ltLoans      [{ amount, ratePct, years }]    — EMI amortized (I,J,M)
  //   pwcLoans     [{ amount, ratePct, years }]    — EMI amortized (K,L,M1)
  //   additions    { poolKey: amount }  (year 1)   — (N,O)
  //   disposals    { poolKey: amount }  (year 1)   — (N,P)
  //   taxProfile   'corporate' | 'progressive'     — rule 9
  //   seedKey      string for the deterministic figure generator
  //   autoSolve    apply rules 2–5 levers automatically (default true)
  //   overrides    { [year]: { cash, creditors, closingStock,
  //                            additionalCapital, dividend } } — review panel
  //
  // Per the master: Sundry Debtors is ALWAYS the balancing figure (rule 8 /
  // rule 10 — Sources must equal Uses), so it is never directly overridable;
  // every other lever is.
  function project(input, asm) {
    const N = Math.max(1, Math.min(10, Math.round(asm.years || 3)));
    const g1 = 1 + num(asm.growthY1Pct) / 100;
    const gR = 1 + num(asm.growthRestPct) / 100;
    const autoSolve = asm.autoSolve !== false;
    const overrides = asm.overrides || {};
    // Drawing-power percentage: entered by the user, defaulting to the master
    // sheet's 70%. Drives the "x% of NCA" test, the shortfall→capital
    // conversion AND the year-1 closing-stock floor, so one number means one
    // thing throughout the report.
    const ncaFactor = (num(asm.ncaPct) > 0 ? num(asm.ncaPct) / 100 : LIMITS.ncaFactor);

    // Term, Permanent-WC and Hire-Purchase loans all amortize on an EMI
    // schedule; only short-term OD/CC carries a flat rate on a constant
    // balance (CA rule 2026-07-25).
    const stLoans  = (asm.stLoans || []).filter(l => num(l.amount) > 0);
    const ltLoans  = (asm.ltLoans || []).filter(l => num(l.amount) > 0);
    const pwcLoans = (asm.pwcLoans || []).filter(l => num(l.amount) > 0);
    const hpLoans  = (asm.hpLoans || []).filter(l => num(l.amount) > 0);

    const stlTotal    = stLoans.reduce((s, l) => s + num(l.amount), 0);
    const interestST  = stLoans.reduce((s, l) => s + num(l.amount) * num(l.ratePct) / 100, 0);
    const ltScheds    = ltLoans.map(l => emiSchedule(num(l.amount), num(l.ratePct), num(l.years) || 1, N));
    const pwcScheds   = pwcLoans.map(l => emiSchedule(num(l.amount), num(l.ratePct), num(l.years) || 1, N));
    const hpScheds    = hpLoans.map(l => emiSchedule(num(l.amount), num(l.ratePct), num(l.years) || 1, N));
    const sumAt       = (scheds, y, f) => scheds.reduce((s, sc) => s + f(sc[y - 1]), 0);
    // Rule 1 debt service: the year's Term + Permanent-WC principal repayment.
    const principalAt = (y) => sumAt(ltScheds, y, s => s.principal) + sumAt(pwcScheds, y, s => s.principal);

    const depYears = projectDepreciation(input.ppe, asm.additions, asm.disposals, N);

    // Admin lines: salary first, then every Note 3.15 line, each ×1.05/yr.
    // Incentive/extra SOI expenses and non-operating income are deliberately
    // excluded — the CA's own delivered projection (File 2) drops both; the
    // target-PBT anchor absorbs them through the purchases balancing figure.
    const adminBase = [{ name: 'Salary & Wages Expenses', base: input.salary }]
      .concat(input.otherExpenses.map(e => ({ name: e.name, base: e.amount })));
    const auditFeeBase = input.auditFee;

    const salesBase = input.revenue.operations;
    const directRatio = salesBase > 0 ? input.materials.directCost / salesBase : 0;
    // Bottom-up baselines (CA method): year 1 grows the PROVISIONAL Gross
    // Margin and Net-Profit-after-tax, not the old PBT-anchor.
    const gpBase = input.revenue.operations - input.materials.total;
    const npBase = input.profitBeforeTax - input.tax;

    // Rule 3 (CA, 2026-07-25): when the provisional/audited trade payable
    // exceeds 10 lakh the projected Sundry Creditor must sit at 75–80% of it —
    // a seeded fraction, so it is unique per client yet reproducible on re-run
    // (and may legitimately repeat for the same client + FY). Smaller payables
    // keep the original 2–8 lakh seeded figure.
    const bigCreditor = input.creditors > LIMITS.creditorRuleFloor;
    // avoid suspiciously round seeded figures
    const deRound = EM.deRound;

    // ── Owner capital is a LAST RESORT, and one constant figure ──────────
    //  (CA rules, 2026-07-28.) `runAll` projects every year at a given level
    //  of Director/Partner/Proprietor Additional Capital:
    //    · pinnedCap === null → the old behaviour: each year injects whatever
    //      it needs. Used once, only to get an upper bound.
    //    · pinnedCap = a number → that same figure stands in EVERY year and
    //      may not be added to. A year that falls short must instead reduce
    //      cash (to `LIMITS.minCash`) and then closing stock; if it still
    //      cannot satisfy its tests the level is infeasible and the caller
    //      raises it.
    //  Every test capital can fix is monotone in it — more capital raises
    //  debtors, NCA, current ratio and debtor-days, and lowers debt-equity —
    //  so the smallest workable figure can be found by binary search.
    const runAll = (pinnedCap) => {
    // The seeded generator is created PER RUN. It used to live outside, so
    // every re-run drew further down the stream and produced different
    // creditor and cash figures — which both broke the "reproducible per
    // client" guarantee and made the search below compare unlike runs.
    const rng = seededRng(asm.seedKey || 'projection');
    const seedCash = Math.round(500000 + rng() * 400000);
    const seedCred = bigCreditor
      ? Math.round(input.creditors * (LIMITS.creditorLoPct + rng() * (LIMITS.creditorHiPct - LIMITS.creditorLoPct)))
      : Math.round(200000 + rng() * 600000);
    const years = [];
    let prev = null;

    for (let y = 1; y <= N; y++) {
      const ov = overrides[y] || {};
      const growth = y === 1 ? g1 : gR;
      const sales = Math.round((y === 1 ? salesBase : prev.pl.sales) * growth);

      // Rent & Audit Fee use the stepped '000 schedule; every other admin line
      // grows 5%/yr COMPOUNDED OFF THE PRIOR YEAR's rounded figure — matching
      // the firm's own projected workbooks, whose cells read
      // `=ROUND(<prior year cell>*1.05,0)`. (Computing base×1.05^y instead
      // drifts a rupee or two from that, which would leave the exported Excel
      // unable to carry the year-on-year growth formula.)
      const adminLines = adminBase.map((l, i) => ({
        name: l.name,
        amount: STEP_FEE_RE.test(l.name) ? steppedFee(l.base, y)
          : Math.round((y === 1 ? l.base : prev.pl.adminLines[i].amount) * LIMITS.expenseGrowth),
      }));
      const adminTotal = adminLines.reduce((s, l) => s + l.amount, 0);
      const auditFee = steppedFee(auditFeeBase, y);
      const salaryProj = adminLines[0].amount;

      const intLT = sumAt(ltScheds, y, s => s.interest) + sumAt(pwcScheds, y, s => s.interest)
                  + sumAt(hpScheds, y, s => s.interest);
      const closingLT = sumAt(ltScheds, y, s => s.closing) + sumAt(hpScheds, y, s => s.closing);
      const closingPWC = sumAt(pwcScheds, y, s => s.closing);
      const dep = depYears[y - 1];

      const openingStock = y === 1 ? input.inventory.closing : prev.pl.closingStock;
      const baseClosingStock = y === 1
        ? Math.max(stlTotal / ncaFactor * LIMITS.stockBuffer, openingStock * LIMITS.stockBuffer)
        : openingStock * LIMITS.stockGrowth;

      // The floor under every closing-stock reduction, shared by the
      // capital-avoidance lever and the 30-day debtor-floor step (a) so the two
      // can never disagree. Two independent believability tests, whichever
      // binds first: Goods Purchase may not fall below half the provisional
      // year's, and closing stock may not fall more than a quarter below the
      // figure the stock rules themselves produced (CA rule 2026-08-02).
      const stockFloorFor = (cogs, directCost) => Math.max(
        0,
        baseClosingStock * (1 - LIMITS.maxStockCutPct),
        openingStock + directCost - cogs + LIMITS.minPurchasePct * input.materials.purchases,
      );

      // ── Bottom-up profit (CA rule 2026-07-25) ──
      // Gross Profit and Net Profit must EACH rise ≥5% on the prior year
      // (provisional figures for year 1). Deductions are already fixed above,
      // so solve the GP that satisfies both, then let purchases balance COGS
      // to hit it. Profit is an output of the plug — never an anchor.
      const deductions = adminTotal + interestST + intLT + dep.dep;
      const prevGP = y === 1 ? gpBase : prev.pl.grossProfit;
      const prevNP = y === 1 ? npBase : prev.pl.pat;
      // Rule 1: PAT must also exceed the year's Term + Permanent-WC principal
      // repayment, else the projection can't service its debt. Solved through
      // the same GP target (a 5% cushion keeps it strictly greater).
      const debtService = principalAt(y);
      const gpTarget = Math.round(Math.max(
        prevGP * LIMITS.profitGrowth,
        gpForTargetNp(prevNP * LIMITS.profitGrowth, deductions, asm.taxProfile),
        debtService > 0 ? gpForTargetNp(debtService * LIMITS.profitGrowth, deductions, asm.taxProfile) : 0,
      ));
      const pbt = gpTarget - deductions;
      const tax = Math.round(taxFor(pbt, asm.taxProfile));
      const pat = pbt - tax;
      const retainedOpening = y === 1 ? input.reserves : prev.pl.retainedClosing;

      const cash = ov.cash != null ? num(ov.cash)
        : (y === 1 ? deRound(seedCash) : round10(prev.bs.cash * LIMITS.cashGrowth));
      // Rule 3 keeps EVERY projected year inside the 75–80% band of the
      // provisional payable (a 10%/yr decay would fall out of it); only the
      // small-payable case keeps the original decay.
      const baseCreditors = bigCreditor
        ? (y === 1 ? seedCred
                   : Math.round(input.creditors * (LIMITS.creditorLoPct + rng() * (LIMITS.creditorHiPct - LIMITS.creditorLoPct))))
        : (y === 1 ? deRound(seedCred) : Math.round(prev.bs.creditors * LIMITS.creditorDecay));
      const creditors = ov.creditors != null ? num(ov.creditors) : baseCreditors;

      const expPayable = Math.round(auditFee + salaryProj / 12);
      const tdsPayable = Math.round(salaryProj * 0.01 + auditFee * 0.015);

      // ── levers (rules 2–5) — iterate until stable or bounded out ──
      // A manual figure always wins. Otherwise the pinned level stands for
      // every year (one constant figure); only the unpinned bounding pass
      // carries the old "inherit from last year and add more" behaviour.
      const capPinned = ov.additionalCapital == null && pinnedCap != null;
      let addlCap = ov.additionalCapital != null ? num(ov.additionalCapital)
        : capPinned ? pinnedCap
        : (prev ? prev.bs.additionalCapital : 0);
      let dividend = ov.dividend != null ? num(ov.dividend) : 0;
      let stockShift = 0;
      let cashCut = 0;                               // cash released to raise NCA
      let dividendApplied = ov.dividend != null, stockApplied = ov.closingStock != null;
      let stockFloorHit = ov.closingStock != null;   // <30-day step (a) exhausted?
      let cashFloorHit = ov.cash != null;            // cash lever exhausted?
      let capExhausted = false;                      // current assets used up?
      const levers = [];
      let yearOk = true;
      let failed = [];               // which bank tests this year does not meet

      let state = null;
      for (let iter = 0; iter < 15; iter++) {
        const closingStock = ov.closingStock != null ? num(ov.closingStock) : baseClosingStock + stockShift;
        const gp = gpTarget;              // bottom-up target; purchases plugs COGS to it
        const cogs = sales - gp;
        const directCost = Math.round(directRatio * sales);
        const purchases = cogs - openingStock - directCost + closingStock;
        const retainedClosing = retainedOpening + pat - dividend;
        const provTax = tax;
        const cl = creditors + provTax + expPayable + tdsPayable + stlTotal;
        const sources = input.shareCapital + addlCap + retainedClosing + closingLT + closingPWC;
        const faNet = dep.closing;
        // Cash is the lever that moves Net Current Assets — NCA works out to
        // `sources − fixed assets − cash + short-term loan`, independent of
        // how the balance splits between stock and debtors. Releasing cash is
        // therefore what buys the room to avoid owner capital.
        const cashEff = ov.cash != null ? num(ov.cash) : Math.max(0, cash - cashCut);
        const debtors = sources - faNet - cashEff - closingStock + cl;
        const ca = cashEff + debtors + closingStock;
        const debt = closingLT + closingPWC + stlTotal;
        const equity = input.shareCapital + addlCap + retainedClosing;
        const days = sales > 0 ? debtors / sales * 365 : 0;
        const currentRatio = cl > 0 ? ca / cl : Infinity;
        const debtEquity = equity > 0 ? debt / equity : Infinity;
        const nca = (closingStock + debtors) - (cl - stlTotal);
        const nca70 = nca * ncaFactor;
        const ncaHeadroom = nca70 - (stlTotal + closingPWC);   // must stay positive

        state = { closingStock, gp, cogs, directCost, purchases, retainedClosing, provTax, cl, sources, faNet,
                  cash: cashEff, debtors, ca, debt, equity, days, currentRatio, debtEquity, nca, nca70, ncaHeadroom };

        // Does this year stand up at the capital level it has been given?
        // Only tests that MORE capital would fix count — a >90-day debtor
        // turnover is handled by dividend/stock and is made worse by capital.
        failed = [];
        if (!(debtors >= -0.5))                                          failed.push('debtors');
        if (!(nca >= LIMITS.minNca - 0.5))                               failed.push('ncaFloor');
        if (!(ncaHeadroom >= LIMITS.minNcaHeadroom - 0.5))               failed.push('ncaHeadroom');
        if (!(currentRatio >= LIMITS.minCurrentRatio - LIMITS.ratioEps)) failed.push('currentRatio');
        if (!(debtEquity <= LIMITS.maxDebtEquity + LIMITS.ratioEps))     failed.push('debtEquity');
        if (!(sales <= 0 || days >= LIMITS.minDebtorDays - 0.5))         failed.push('debtorDays');
        yearOk = failed.length === 0;

        if (!autoSolve) break;

        // Rules 2/3/4: shortfalls fixable by additional capital (round '000).
        // Injected capital flows into debtors (the balancing figure), raising
        // CA and NCA rupee-for-rupee and equity for debt-equity.
        const needDE  = debtEquity > LIMITS.maxDebtEquity ? debt / LIMITS.maxDebtEquity - equity : 0;
        const needCR  = currentRatio < LIMITS.minCurrentRatio ? LIMITS.minCurrentRatio * cl - ca : 0;
        const needNCA = ncaHeadroom < LIMITS.minNcaHeadroom
          ? (LIMITS.minNcaHeadroom - ncaHeadroom) / ncaFactor : 0;
        // Debtors can never be negative on a real balance sheet — when uses
        // fall short of sources even at zero debtors, capital must fill the
        // gap (the rule-2 mechanism, same lever).
        const needPos = debtors < 0 ? -debtors : 0;
        const needNcaFloor = nca < LIMITS.minNca ? LIMITS.minNca - nca : 0;
        const need = Math.max(needDE, needCR, needNCA, needPos, needNcaFloor);

        // CA rule (2026-07-28) — owner capital is the LAST resort. With the
        // figure pinned, a shortfall is met from current assets instead, in
        // the CA's order: cash down to ~1 lakh first (it raises NCA and
        // debtors), then closing stock (which raises debtors only). If both
        // are exhausted the year is left failing and the caller raises the
        // capital level.
        if (need > 0.5 && capPinned && !capExhausted) {
          if (!cashFloorHit) {
            const room = Math.max(0, cashEff - LIMITS.minCash);
            // Cash only helps the NCA-side tests and negative debtors.
            const wanted = Math.max(needNCA, needPos, needNcaFloor);
            const cut = Math.min(room, wanted);
            if (cut > 0.5) { cashCut += cut; levers.push({ rule: 'avoid', action: 'cash', amount: -cut }); continue; }
            cashFloorHit = true;
          }
          // Then closing stock, with purchases re-balancing so profit is held
          // (CA rule 2026-07-29). Every rupee taken out of stock lands in the
          // balancing debtors, so this covers BOTH a negative debtor balance
          // and the 30-day turnover floor — which is what lets the capital
          // level keep falling. Bounded so stock and purchases stay ≥ 0.
          if (!stockFloorHit) {
            const dTarget = sales > 0 ? sales * LIMITS.minDebtorDays / 365 : 0;
            const debtorShort = Math.max(needPos, dTarget - debtors);
            const room = Math.max(0, closingStock - stockFloorFor(cogs, directCost));
            const dec = Math.min(room, debtorShort);
            if (dec > 0.5) { stockShift -= dec; levers.push({ rule: 'avoid', action: 'closingStock', amount: -dec }); continue; }
            stockFloorHit = true;
          }
          // Current assets are exhausted. Fall through rather than break, so
          // the debtor-turnover rules below still run; `yearOk` already
          // records the shortfall and the caller raises the capital level.
          capExhausted = true;
        }
        // Only the unpinned bounding pass may inject — with a figure pinned,
        // the shortfall has already been met from current assets above (or
        // recorded as infeasible so the caller raises the level).
        if (need > 0.5 && ov.additionalCapital == null && !capPinned) {
          const add = round1000Up(need);
          addlCap += add;
          levers.push({ rule: needDE >= needCR && needDE >= needNCA ? 3 : (needCR >= needNCA ? 4 : 2), action: 'additionalCapital', amount: add });
          continue;
        }

        // Rule 5: debtor turnover above 90 days → dividend (strictly below
        // PAT, round '000); any remaining excess shifts into closing stock
        // (purchases balance, profit held — rules 3/4 secondary clause).
        if (days > LIMITS.maxDebtorDays + 0.01) {
          const target = sales * LIMITS.maxDebtorDays / 365;
          const excess = debtors - target;
          if (!dividendApplied) {
            dividendApplied = true;
            // A dividend leaves the company, so it also lowers equity — cap it
            // so it can never push debt-equity past its limit (it previously
            // could, which then blocked this very rule from finishing).
            const deRoom = debt > 0 ? Math.max(0, equity - debt / LIMITS.maxDebtEquity) : Infinity;
            const cap = Math.min(Math.max(0, round1000Down(pat) - 1000), round1000Down(deRoom));
            const d = Math.min(round1000Down(excess), cap);
            if (d >= 1000) { dividend += d; levers.push({ rule: 5, action: 'dividend', amount: d }); continue; }
          }
          if (!stockApplied) {
            stockApplied = true;
            stockShift += excess;
            levers.push({ rule: 3, action: 'closingStock', amount: excess });
            continue;
          }
        }

        // Floor (CA rule 2026-07-22): debtor turnover below 30 days reads as
        // fabricated to a bank → lift debtors (the balancing figure) to ≥30
        // days, in two ordered steps:
        //   (a) FIRST decrease closing stock (profit held → purchases re-plugs
        //       → debtors rises rupee-for-rupee), bounded so closing stock and
        //       purchases stay ≥ 0 and NCA stays ≥ 1 lakh.
        //   (b) only if (a) can't reach 30 days, raise debtors the rest of the
        //       way by injecting Director/Partner/Proprietor additional capital
        //       (rounded up to '000).
        // `days` can be negative when debtors are — the old `days > 0` guard
        // skipped the whole fix in exactly that case, leaving stock room
        // unused and forcing owner capital in instead.
        if (sales > 0 && days < LIMITS.minDebtorDays - 0.01) {
          const targetDebtors = sales * LIMITS.minDebtorDays / 365;
          const shortfall = targetDebtors - debtors;             // > 0
          // (a) closing-stock reduction. Under profit-held the NCA working
          //     total is invariant to a stock↔debtors shift, so the rule's
          //     "keep NCA ≥ 1 lakh" is a go/no-go guard (skip (a) if NCA is
          //     already under the floor — capital in (b) then lifts it). The
          //     amount is bounded by keeping closing stock and purchases
          //     (= cogs − opening − direct + closing) ≥ 0.
          if (!stockFloorHit) {
            if (nca >= LIMITS.minNca) {
              const room = Math.max(0, closingStock - stockFloorFor(cogs, directCost));
              const dec = Math.min(shortfall, room);
              if (dec > 0.5) { stockShift -= dec; levers.push({ rule: 'a', action: 'closingStock', amount: -dec }); continue; }
            }
            stockFloorHit = true;
          }
          // (b) cash next — releasing it raises debtors too, and unlike
          //     capital it costs the client nothing.
          if (capPinned) {
            if (!cashFloorHit) {
              const room = Math.max(0, cashEff - LIMITS.minCash);
              const cut = Math.min(room, shortfall);
              if (cut > 0.5) { cashCut += cut; levers.push({ rule: 'avoid', action: 'cash', amount: -cut }); continue; }
              cashFloorHit = true;
            }
            break;                   // capital may not be added — yearOk decides
          }
          // (c) only in the unpinned bounding pass: top up with capital.
          if (ov.additionalCapital == null) {
            const add = round1000Up(shortfall);
            addlCap += add;
            levers.push({ rule: 'b', action: 'additionalCapital', amount: add });
            continue;
          }
        }
        break;
      }

      const pl = {
        sales, openingStock, purchases: state.purchases, directCost: state.directCost,
        closingStock: state.closingStock, cogs: state.cogs, grossProfit: state.gp,
        adminLines, adminTotal, interestST, interestLT: intLT, dep: dep.dep,
        pbt, tax, pat, retainedOpening, dividend, retainedClosing: state.retainedClosing,
      };
      const bs = {
        shareCapital: input.shareCapital, additionalCapital: addlCap, reserves: state.retainedClosing,
        longTermLoan: closingLT, permanentWC: closingPWC, directorLending: 0,
        totalSources: state.sources,
        fixedAssetsGross: dep.total, depreciation: dep.dep, fixedAssetsNet: state.faNet,
        cash: state.cash, debtors: state.debtors, closingStock: state.closingStock,
        totalCurrentAssets: state.ca,
        creditors, provisionTax: state.provTax, expPayable, tdsPayable, shortTermLoan: stlTotal,
        totalCurrentLiabilities: state.cl,
        netCurrentAssets: state.ca - state.cl,
        totalUses: state.faNet + state.ca - state.cl,
      };
      const ratios = {
        debtorDays: state.days, currentRatio: state.currentRatio, debtEquity: state.debtEquity,
        nca: state.nca, nca70: state.nca70, ncaHeadroom: state.ncaHeadroom,
        grossMarginPct: sales ? state.gp / sales * 100 : 0,
        netMarginPct: sales ? pbt / sales * 100 : 0,
      };

      // Each bank test's slack, expressed in RUPEES OF OWNER CAPITAL so they
      // sit on one scale — capital moves every one of them roughly one-for-one
      // (it lands in the balancing debtors, so a rupee of capital is a rupee of
      // current assets, of net current assets and of equity).
      const slack = {
        currentRatio: state.ca - LIMITS.minCurrentRatio * state.cl,
        debtEquity:   state.equity - (state.debt > 0 ? state.debt / LIMITS.maxDebtEquity : 0),
        ncaHeadroom:  (state.ncaHeadroom - LIMITS.minNcaHeadroom) / ncaFactor,
        ncaFloor:     state.nca - LIMITS.minNca,
        debtors:      state.debtors,
        debtorDays:   sales > 0 ? state.debtors - sales * LIMITS.minDebtorDays / 365 : Infinity,
      };
      const tightest = (keys) => keys.reduce((a, b) => (slack[a] <= slack[b] ? a : b));

      // ── Cash flow (indirect). Ties to the BS by construction; year 1
      // liquidates any audited non-current investments/receivables (the
      // projected BS carries no such rows). ──
      const prevCAxc   = y === 1 ? input.currentAssetsTotal - input.cash : prev.bs.debtors + prev.bs.closingStock;
      const prevCL     = y === 1 ? input.currentLiabilitiesTotal : prev.bs.totalCurrentLiabilities;
      const prevCap    = y === 1 ? input.shareCapital : prev.bs.shareCapital + prev.bs.additionalCapital;
      const prevCash   = y === 1 ? input.cash : prev.bs.cash;
      // Year-1 opening debt is DERIVED from the audited balance-sheet identity
      //   cash + FA + (CA−cash) − CL − equity = interest-bearing debt outside CL
      // rather than summed from the Note 3.8 detail rows. Real statements
      // classify those loans inconsistently — on two of the four test files the
      // whole term loan sits inside Current Liabilities, so summing the note
      // double-counted it and blew the year-1 cash-flow tie by exactly that
      // amount. Deriving it keeps CF closing == BS cash true by construction
      // for any client, however messy the note.
      let prevLoans, prevDir;
      if (y === 1) {
        const prevFA = input.ppeTotal + input.investmentsNC + input.otherReceivablesNC;
        const prevEquity = input.shareCapital + input.reserves;
        const prevDebtAll = prevCash + prevFA + prevCAxc - prevCL - prevEquity;
        prevDir = Math.max(0, Math.min(input.loans.directorLoan, prevDebtAll));
        prevLoans = prevDebtAll - prevDir;
      } else {
        prevLoans = prev.bs.longTermLoan + prev.bs.permanentWC;
        prevDir = prev.bs.directorLending;
      }
      const additions  = dep.addition;
      const cf = {
        pbtPlusInterest: pbt + interestST + intLT,
        depreciation: dep.dep,
        incomeTax: -tax,
        deltaCurrentAssets: prevCAxc - (state.debtors + state.closingStock),
        deltaCurrentLiabilities: state.cl - prevCL,
        operating: 0,
        capex: -additions + (y === 1 ? dep.disposal : 0),
        liquidatedNC: y === 1 ? input.investmentsNC + input.otherReceivablesNC : 0,
        investing: 0,
        capitalIssued: (input.shareCapital + addlCap) - prevCap,
        dividend: -dividend,
        interestPaid: -(interestST + intLT),
        deltaDirector: 0 - prevDir,
        deltaLoans: (closingLT + closingPWC) - prevLoans,
        financing: 0,
        netChange: 0,
        openingCash: prevCash,
        closingCash: 0,
      };
      cf.operating = cf.pbtPlusInterest + cf.depreciation + cf.incomeTax + cf.deltaCurrentAssets + cf.deltaCurrentLiabilities;
      cf.investing = cf.capex + cf.liquidatedNC;
      cf.financing = cf.capitalIssued + cf.dividend + cf.interestPaid + cf.deltaDirector + cf.deltaLoans;
      cf.netChange = cf.operating + cf.investing + cf.financing;
      cf.closingCash = cf.openingCash + cf.netChange;

      const binding = failed.length ? tightest(failed) : tightest(Object.keys(slack));
      years.push({ year: y, pl, bs, cf, dep, ratios, levers, ok: yearOk, failed,
                   binding: { test: binding, slack: slack[binding], all: slack } });
      prev = years[y - 1];
    }
    return years;
    };

    // Pass 1 — let each year inject freely, purely to bound the search.
    const freeRun = runAll(null);
    const capCeiling = round1000Up(Math.max(0, ...freeRun.map(y => y.bs.additionalCapital)));

    // Pass 2 — the smallest single figure that works for every year. Zero is
    // tried first: the CA's objective is to avoid owner capital entirely.
    const allOk = ys => ys.every(y => y.ok);
    let years = runAll(0);
    if (!allOk(years) && capCeiling > 0) {
      let lo = 0, hi = capCeiling;
      if (!allOk(runAll(hi))) hi = round1000Up(capCeiling * 2 + 1000000);  // safety net
      while (hi - lo > 1000) {
        const mid = round1000Up((lo + hi) / 2);
        if (mid >= hi) break;
        if (allOk(runAll(mid))) hi = mid; else lo = mid;
      }
      years = runAll(hi);
      if (!allOk(years)) years = freeRun;      // nothing constant works — fall back
    }

    // If owner capital could not be avoided, say which test forced it — the
    // review panel otherwise shows a large figure with no way to tell whether
    // cash, closing stock or the loan structure caused it, and only the last of
    // those can be acted on.
    //
    // Determined EMPIRICALLY, by re-solving a notch below the answer and seeing
    // what breaks. Picking the tightest ratio at the solution instead gives the
    // wrong test: the cash and stock levers drive debtor-days and drawing power
    // to sit exactly on their limits, so they always look binding even when the
    // real wall is a current ratio those levers cannot touch at all.
    const addlCapFinal = years.length ? years[0].bs.additionalCapital : 0;
    const constant = years.every(y => y.bs.additionalCapital === addlCapFinal);
    let capitalDriver = null;
    if (addlCapFinal > 0 && constant) {
      const probe = runAll(Math.max(0, addlCapFinal - 1000)).find(y => !y.ok);
      const test = probe ? probe.binding.test : null;
      if (test) capitalDriver = { amount: addlCapFinal, year: probe.year, test, label: BINDING_LABELS[test] };
    }

    // IRD sheet data: audited column + projected year 1 (master layout).
    const ird = {
      audited: {
        grossIncome: input.revenue.operations - input.materials.total,
        pbt: input.profitBeforeTax,
        tax: input.tax,
        paidUpCapital: input.shareCapital,
        reserves: input.reserves,
        bankLoan: input.loans.term.reduce((s, l) => s + l.amount, 0) + input.loans.overdraft,
        currentLiabilities: input.currentLiabilitiesTotal,
        provision: input.tax,
        currentAssets: input.currentAssetsTotal,
        fixedAssets: input.ppeTotal,
      },
      projected: years[0] ? {
        grossIncome: years[0].pl.grossProfit,
        pbt: years[0].pl.pbt,
        tax: years[0].pl.tax,
        paidUpCapital: years[0].bs.shareCapital + years[0].bs.additionalCapital,
        reserves: years[0].bs.reserves,
        bankLoan: years[0].bs.permanentWC + years[0].bs.directorLending + years[0].bs.shortTermLoan,
        currentLiabilities: years[0].bs.totalCurrentLiabilities,
        provision: years[0].pl.tax,
        currentAssets: years[0].bs.totalCurrentAssets,
        fixedAssets: years[0].bs.fixedAssetsNet,
      } : null,
    };

    return { years, ird, capitalDriver,
             meta: { N, stlTotal, interestST, ltScheds, pwcScheds, hpScheds, principalAt, bigCreditor, ncaFactor } };
  }

  // Human labels for `year.binding.test` / `result.capitalDriver.test`. The
  // review panel and the exported Validation sheet both name the binding
  // constraint, so the wording lives here once.
  const BINDING_LABELS = {
    currentRatio: 'current ratio',
    debtEquity:   'debt-equity ratio',
    ncaHeadroom:  'drawing power (H = F − G)',
    ncaFloor:     'minimum net current assets',
    debtors:      'Sundry Debtors cannot be negative',
    debtorDays:   'minimum 30-day debtor turnover',
  };

  // What-if: how much of the short-term facility would have to be shown as a
  // TERM loan for owner capital to fall away entirely? Returns null when there
  // is nothing to recommend (capital is already nil, or there is no short-term
  // borrowing to move).
  //
  // Answered by RE-SOLVING rather than by algebra. A rupee moved out of current
  // liabilities relieves the current-ratio test by about 1.5 rupees of capital,
  // but the drawing-power test takes over partway down and relieves it by far
  // less — so a closed-form answer is wrong exactly at the crossover, which is
  // where the recommendation lands.
  //
  // The engine never applies this itself (CA decision, 2026-08-02): how a loan
  // is classified is a fact about the client, not a lever the report may pull.
  function suggestReclass(input, asm, opts) {
    const o = opts || {};
    const stl = (asm.stLoans || []).filter(l => num(l.amount) > 0);
    const total = stl.reduce((s, l) => s + num(l.amount), 0);
    if (!(total > 0)) return null;
    const ratePct = num(o.ratePct) > 0 ? num(o.ratePct)
      : stl.reduce((s, l) => s + num(l.amount) * num(l.ratePct), 0) / total;
    const tenor = Math.max(1, Math.round(num(o.years) || 5));
    // A pinned Additional Capital would make the search meaningless; every
    // other manual lever is kept so the what-if matches the report on screen.
    const overrides = {};
    Object.entries(asm.overrides || {}).forEach(([yr, v]) => {
      const rest = { ...v }; delete rest.additionalCapital; overrides[yr] = rest;
    });
    const asmWith = (x) => {
      let left = x;
      const rows = stl.slice().sort((a, b) => num(b.amount) - num(a.amount)).map(l => {
        const cut = Math.min(left, num(l.amount)); left -= cut;
        return { ...l, amount: num(l.amount) - cut };
      }).filter(l => l.amount > 0);
      return { ...asm, overrides, autoSolve: true, stLoans: rows,
               ltLoans: (asm.ltLoans || []).concat([{ amount: x, ratePct, years: tenor }]) };
    };
    const capAt = (x) => {
      const r = project(input, asmWith(x));
      return r.years.every(y => y.ok) ? Math.max(...r.years.map(y => y.bs.additionalCapital)) : Infinity;
    };
    if (capAt(0) === 0) return null;
    if (capAt(total) !== 0) return { feasible: false, ratePct, years: tenor };
    let lo = 0, hi = total;
    for (let i = 0; i < 24 && hi - lo > 10000; i++) {
      const mid = Math.round((lo + hi) / 2 / 10000) * 10000;
      if (mid <= lo || mid >= hi) break;
      if (capAt(mid) === 0) hi = mid; else lo = mid;
    }
    const amount = round1000Up(hi);
    return capAt(amount) === 0
      ? { feasible: true, amount, ratePct, years: tenor }
      : { feasible: false, ratePct, years: tenor };
  }

  // ───────────────────────── validation ─────────────────────────

  // Returns [{ level:'error'|'warn', year, code, msg }] — the review panel
  // renders these; export is blocked while any 'error' remains.
  function validate(input, result) {
    const issues = [];
    const push = (level, year, code, msg) => issues.push({ level, year, code, msg });
    const fmt = (v) => Math.round(v).toLocaleString('en-IN');

    result.years.forEach((yr, i) => {
      const y = yr.year;
      const tie = yr.bs.totalSources - yr.bs.totalUses;
      if (Math.abs(tie) > 1) push('error', y, 'balance', `Year ${y}: Balance sheet does not tie (difference ${fmt(tie)}).`);
      if (Math.abs(yr.cf.closingCash - yr.bs.cash) > 1) {
        push('error', y, 'cashflow', `Year ${y}: Cash flow closing (${fmt(yr.cf.closingCash)}) ≠ Balance Sheet cash (${fmt(yr.bs.cash)}).`);
      }
      if (yr.bs.debtors < 0) push('error', y, 'debtors', `Year ${y}: Sundry Debtors is negative (${fmt(yr.bs.debtors)}) — sources exceed uses; reduce capital/loans or raise stock.`);
      if (yr.pl.purchases < 0) push('error', y, 'purchases', `Year ${y}: Purchases is negative (${fmt(yr.pl.purchases)}) — the profit target is not achievable with these growth assumptions.`);
      if (yr.pl.grossProfit < 0) push('error', y, 'grossprofit', `Year ${y}: Gross profit is negative.`);
      if (yr.ratios.debtorDays > LIMITS.maxDebtorDays + 0.5) {
        push('warn', y, 'days', `Year ${y}: Debtor turnover ${yr.ratios.debtorDays.toFixed(0)} days exceeds ${LIMITS.maxDebtorDays} (rule 5).`);
      }
      if (yr.ratios.debtorDays < LIMITS.minDebtorDays - 0.5) {
        push('warn', y, 'days', `Year ${y}: Debtor turnover ${yr.ratios.debtorDays.toFixed(0)} days is below ${LIMITS.minDebtorDays} — raise Sundry Debtors (reduce cash/creditors or stock) so the collection cycle stays believable.`);
      }
      if (yr.ratios.currentRatio < LIMITS.minCurrentRatio - LIMITS.ratioEps) {
        push('warn', y, 'current', `Year ${y}: Current ratio ${yr.ratios.currentRatio.toFixed(3)} is below ${LIMITS.minCurrentRatio} (rule 4).`);
      }
      if (yr.ratios.debtEquity > LIMITS.maxDebtEquity + LIMITS.ratioEps) {
        push('warn', y, 'de', `Year ${y}: Debt-equity ${yr.ratios.debtEquity.toFixed(3)} exceeds ${LIMITS.maxDebtEquity} (rule 3).`);
      }
      if (yr.ratios.ncaHeadroom < LIMITS.minNcaHeadroom - 0.5) {
        push('warn', y, 'nca', `Year ${y}: the NCA working's H = F − G is ${fmt(yr.ratios.ncaHeadroom)} — it must clear ${fmt(LIMITS.minNcaHeadroom)} above total working-capital loans (rule 2).`);
      }
      // Rule 1 (CA, 2026-07-25): profit after tax must cover the year's term +
      // permanent-WC loan repayment, or the projection can't service its debt.
      const debtService = (result.meta && result.meta.principalAt ? result.meta.principalAt(y) : 0);
      if (debtService > 0 && yr.pl.pat <= debtService) {
        push('warn', y, 'debtservice', `Year ${y}: Net profit after tax (${fmt(yr.pl.pat)}) does not exceed the Term + Permanent-WC repayment (${fmt(debtService)}) — the projection cannot service its debt (rule 1).`);
      }
      if (i > 0) {
        const prevYr = result.years[i - 1];
        const gpFloor = prevYr.pl.grossProfit * LIMITS.profitGrowth;
        const npFloor = prevYr.pl.pat * LIMITS.profitGrowth;
        if (yr.pl.grossProfit < gpFloor - 1) push('warn', y, 'gptrend', `Year ${y}: Gross profit ${fmt(yr.pl.grossProfit)} is below the required +5% on last year (${fmt(gpFloor)}) — rule 6.`);
        if (yr.pl.pat < npFloor - 1) push('warn', y, 'nptrend', `Year ${y}: Net profit after tax ${fmt(yr.pl.pat)} is below the required +5% on last year (${fmt(npFloor)}) — rule 7.`);
      }
    });
    return issues;
  }

  // ───────────────────────── public surface ─────────────────────────

  return {
    DEP_POOLS,
    LIMITS,
    TAX_SLABS,
    BINDING_LABELS,
    parseStatement,
    project,
    suggestReclass,
    validate,
    emiSchedule,
    taxFor,
    projectDepreciation,
    // internals exposed for testing
    _test: { num, norm, findHeader, classifyPool, seededRng },
  };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// for engine verification scripts.
if (typeof module !== 'undefined' && module.exports) module.exports = ProjectionEngine;
else window.ProjectionEngine = ProjectionEngine;
