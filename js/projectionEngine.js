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

  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/,/g, ''));
      if (isFinite(n)) return n;
    }
    return 0;
  };

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  // Convert a SheetJS worksheet into a dense 2D array of cell values
  // (computed/cached values — SheetJS resolves formula caches into .v).
  function grid(ws, XLSX) {
    if (!ws || !ws['!ref']) return [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        row[c] = cell ? cell.v : undefined;
      }
      rows[r] = row;
    }
    return rows;
  }

  // Tolerant sheet-name lookup: exact (case/space-insensitive) first, then
  // substring — real client files vary ("Sch-PL" vs "Sch PL" vs "Schedule-PL").
  function findSheet(wb, keys) {
    const names = wb.SheetNames;
    for (const key of keys) {
      const k = norm(key);
      let hit = names.find(n => norm(n) === k);
      if (!hit) hit = names.find(n => norm(n).includes(k));
      if (hit) return wb.Sheets[hit];
    }
    return null;
  }

  // Find the row index whose label-column cell matches `re` (searching every
  // column when labelCol is null). Search starts at `from`.
  function findRowIdx(g, re, from = 0, labelCol = null) {
    for (let r = from; r < g.length; r++) {
      const row = g[r]; if (!row) continue;
      if (labelCol != null) {
        if (re.test(norm(row[labelCol]))) return r;
      } else {
        for (let c = 0; c < row.length; c++) if (re.test(norm(row[c]))) return r;
      }
    }
    return -1;
  }

  // Locate a statement header: the row containing "Particulars", the column
  // it sits in (label column), and the first non-empty column to its right
  // (the current-year value column). Each sheet in the firm template uses a
  // DIFFERENT value column (SFP→F, SOI→F, Sch-PL→D, Sch-BS→H), so this must
  // be detected per section, never hardcoded.
  function findHeader(g, from = 0) {
    for (let r = from; r < g.length; r++) {
      const row = g[r]; if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (norm(row[c]) === 'particulars') {
          let valCol = -1, prevCol = -1;
          for (let cc = c + 1; cc < row.length; cc++) {
            if (row[cc] !== undefined && norm(row[cc]) !== '' && norm(row[cc]) !== 'notes') {
              if (valCol === -1) valCol = cc;
              else { prevCol = cc; break; }
            }
          }
          if (valCol !== -1) return { row: r, labelCol: c, valCol, prevCol };
        }
      }
    }
    return null;
  }

  // Read the value on the first row at/after `from` whose label matches `re`.
  function labelValue(g, re, labelCol, valCol, from = 0, until = Infinity) {
    for (let r = from; r < Math.min(g.length, until); r++) {
      const row = g[r]; if (!row) continue;
      if (re.test(norm(row[labelCol]))) return { row: r, value: num(row[valCol]) };
    }
    return null;
  }

  // ───────────────────────── the parser ─────────────────────────

  // Depreciation pools of the master Dep sheet (File 3), in display order.
  // Rates are WDV per the master; Land never depreciates. `kw` matches both
  // the 3.1 PPE column headers of the input file and free-text labels.
  const DEP_POOLS = [
    { key: 'land',      name: 'Land',                          rate: 0,    kw: ['land'] },
    { key: 'building',  name: 'Building & Structure',          rate: 0.05, kw: ['building', 'structure'] },
    { key: 'plant',     name: 'Plant Machinery & other Assets',rate: 0.15, kw: ['plant', 'machin', 'other asset'] },
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

    function section(titleRe) {
      const t = findRowIdx(gP, titleRe);
      if (t === -1) return null;
      const h = findHeader(gP, t);
      if (!h) return null;
      const end = findRowIdx(gP, /^total$/, h.row + 1, h.labelCol);
      return { ...h, titleRow: t, endRow: end === -1 ? h.row + 30 : end };
    }

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
          const sum = Object.values(model.ppe).reduce((s, v) => s + v, 0);
          if (model.ppeTotal && Math.abs(sum - model.ppeTotal) > 1) {
            warn(`PPE pools (${sum.toFixed(2)}) do not sum to the SFP PPE total (${model.ppeTotal.toFixed(2)}).`);
          }
        } else warn('3.1 PPE: carrying-amount closing row not found.');
      } else warn('3.1 PPE: header row not found.');
    } else warn('3.1 PPE sheet not found — depreciation pools will start empty.');

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
    minCurrentRatio: 1.5,  // rule 4
    maxDebtEquity: 2.33,   // rule 3
    ncaFactor: 0.70,       // bank drawing power = 70% of NCA (rule 2 / "Always Positive")
    expenseGrowth: 1.05,   // every admin line grows 5%/yr (master Pl "×1.05")
    stockBuffer: 1.15,     // rule 1: yr-1 closing stock ≥ max(STL/0.7×1.15, opening×1.15)
    stockGrowth: 1.05,     // yr-2+ closing stock = opening × 1.05
    creditorDecay: 0.90,   // creditors shrink 10%/yr after yr 1
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
  function seededRng(key) {
    let h = 1779033703 ^ String(key).length;
    for (let i = 0; i < String(key).length; i++) {
      h = Math.imul(h ^ String(key).charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }

  const round1000Up   = (v) => Math.ceil(v / 1000) * 1000;
  const round1000Down = (v) => Math.floor(v / 1000) * 1000;
  const round10       = (v) => Math.round(v / 10) * 10;

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

    const stLoans  = (asm.stLoans || []).filter(l => num(l.amount) > 0);
    const ltLoans  = (asm.ltLoans || []).filter(l => num(l.amount) > 0);
    const pwcLoans = (asm.pwcLoans || []).filter(l => num(l.amount) > 0);

    const stlTotal    = stLoans.reduce((s, l) => s + num(l.amount), 0);
    const interestST  = stLoans.reduce((s, l) => s + num(l.amount) * num(l.ratePct) / 100, 0);
    const ltScheds    = ltLoans.map(l => emiSchedule(num(l.amount), num(l.ratePct), num(l.years) || 1, N));
    const pwcScheds   = pwcLoans.map(l => emiSchedule(num(l.amount), num(l.ratePct), num(l.years) || 1, N));
    const sumAt       = (scheds, y, f) => scheds.reduce((s, sc) => s + f(sc[y - 1]), 0);

    const depYears = projectDepreciation(input.ppe, asm.additions, asm.disposals, N);

    // Admin lines: salary first, then every Note 3.15 line, each ×1.05/yr.
    // Incentive/extra SOI expenses and non-operating income are deliberately
    // excluded — the CA's own delivered projection (File 2) drops both; the
    // target-PBT anchor absorbs them through the purchases balancing figure.
    const adminBase = [{ name: 'Salary & Wages Expenses', base: input.salary }]
      .concat(input.otherExpenses.map(e => ({ name: e.name, base: e.amount })));
    const auditFeeBase = input.auditFee;

    const salesBase = input.revenue.operations;
    const pbtBase = input.profitBeforeTax;
    const directRatio = salesBase > 0 ? input.materials.directCost / salesBase : 0;

    const rng = seededRng(asm.seedKey || 'projection');
    const seedCash = Math.round(500000 + rng() * 400000);
    const seedCred = Math.round(200000 + rng() * 600000);
    // avoid suspiciously round seeded figures
    const deRound = (v) => (v % 1000 === 0 ? v + 137 : v);

    const years = [];
    let prev = null;

    for (let y = 1; y <= N; y++) {
      const ov = overrides[y] || {};
      const growth = y === 1 ? g1 : gR;
      const sales = Math.round((y === 1 ? salesBase : prev.pl.sales) * growth);
      const pbt = Math.round((y === 1 ? pbtBase : prev.pl.pbt) * growth);

      const factor = Math.pow(LIMITS.expenseGrowth, y);
      const adminLines = adminBase.map(l => ({ name: l.name, amount: Math.round(l.base * factor) }));
      const adminTotal = adminLines.reduce((s, l) => s + l.amount, 0);
      const auditFee = Math.round(auditFeeBase * factor);
      const salaryProj = adminLines[0].amount;

      const intLT = sumAt(ltScheds, y, s => s.interest) + sumAt(pwcScheds, y, s => s.interest);
      const closingLT = sumAt(ltScheds, y, s => s.closing);
      const closingPWC = sumAt(pwcScheds, y, s => s.closing);
      const dep = depYears[y - 1];

      const openingStock = y === 1 ? input.inventory.closing : prev.pl.closingStock;
      const baseClosingStock = y === 1
        ? Math.max(stlTotal / LIMITS.ncaFactor * LIMITS.stockBuffer, openingStock * LIMITS.stockBuffer)
        : openingStock * LIMITS.stockGrowth;

      const tax = Math.round(taxFor(pbt, asm.taxProfile));
      const pat = pbt - tax;
      const retainedOpening = y === 1 ? input.reserves : prev.pl.retainedClosing;

      const cash = ov.cash != null ? num(ov.cash)
        : (y === 1 ? deRound(seedCash) : round10(prev.bs.cash * LIMITS.cashGrowth));
      const baseCreditors = y === 1 ? deRound(seedCred) : Math.round(prev.bs.creditors * LIMITS.creditorDecay);
      const creditors = ov.creditors != null ? num(ov.creditors) : baseCreditors;

      const expPayable = Math.round(auditFee + salaryProj / 12);
      const tdsPayable = Math.round(salaryProj * 0.01 + auditFee * 0.015);

      // ── levers (rules 2–5) — iterate until stable or bounded out ──
      // Additional capital persists (an injection stays on the balance
      // sheet), so each year starts from the prior year's level.
      let addlCap = ov.additionalCapital != null ? num(ov.additionalCapital) : (prev ? prev.bs.additionalCapital : 0);
      let dividend = ov.dividend != null ? num(ov.dividend) : 0;
      let stockShift = 0;
      let dividendApplied = ov.dividend != null, stockApplied = ov.closingStock != null;
      let stockFloorHit = ov.closingStock != null;   // <30-day step (a) exhausted?
      const levers = [];

      let state = null;
      for (let iter = 0; iter < 15; iter++) {
        const closingStock = ov.closingStock != null ? num(ov.closingStock) : baseClosingStock + stockShift;
        const gp = pbt + adminTotal + interestST + intLT + dep.dep;
        const cogs = sales - gp;
        const directCost = Math.round(directRatio * sales);
        const purchases = cogs - openingStock - directCost + closingStock;
        const retainedClosing = retainedOpening + pat - dividend;
        const provTax = tax;
        const cl = creditors + provTax + expPayable + tdsPayable + stlTotal;
        const sources = input.shareCapital + addlCap + retainedClosing + closingLT + closingPWC;
        const faNet = dep.closing;
        const debtors = sources - faNet - cash - closingStock + cl;
        const ca = cash + debtors + closingStock;
        const debt = closingLT + closingPWC + stlTotal;
        const equity = input.shareCapital + addlCap + retainedClosing;
        const days = sales > 0 ? debtors / sales * 365 : 0;
        const currentRatio = cl > 0 ? ca / cl : Infinity;
        const debtEquity = equity > 0 ? debt / equity : Infinity;
        const nca = (closingStock + debtors) - (cl - stlTotal);
        const nca70 = nca * LIMITS.ncaFactor;
        const ncaHeadroom = nca70 - (stlTotal + closingPWC);   // must stay positive

        state = { closingStock, gp, cogs, directCost, purchases, retainedClosing, provTax, cl, sources, faNet,
                  cash, debtors, ca, debt, equity, days, currentRatio, debtEquity, nca, nca70, ncaHeadroom };

        if (!autoSolve) break;

        // Rules 2/3/4: shortfalls fixable by additional capital (round '000).
        // Injected capital flows into debtors (the balancing figure), raising
        // CA and NCA rupee-for-rupee and equity for debt-equity.
        const needDE  = debtEquity > LIMITS.maxDebtEquity ? debt / LIMITS.maxDebtEquity - equity : 0;
        const needCR  = currentRatio < LIMITS.minCurrentRatio ? LIMITS.minCurrentRatio * cl - ca : 0;
        const needNCA = ncaHeadroom < 0 ? -ncaHeadroom / LIMITS.ncaFactor : 0;
        // Debtors can never be negative on a real balance sheet — when uses
        // fall short of sources even at zero debtors, capital must fill the
        // gap (the rule-2 mechanism, same lever).
        const needPos = debtors < 0 ? -debtors : 0;
        const need = Math.max(needDE, needCR, needNCA, needPos);
        if (need > 0.5 && ov.additionalCapital == null) {
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
            const cap = Math.max(0, round1000Down(pat) - 1000);
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
        if (days > 0 && days < LIMITS.minDebtorDays - 0.01) {
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
              const stockFloor = Math.max(0, openingStock + directCost - cogs);
              const room = Math.max(0, closingStock - stockFloor);
              const dec = Math.min(shortfall, room);
              if (dec > 0.5) { stockShift -= dec; levers.push({ rule: 'a', action: 'closingStock', amount: -dec }); continue; }
            }
            stockFloorHit = true;
          }
          // (b) additional capital to cover the remaining shortfall.
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

      // ── Cash flow (indirect). Ties to the BS by construction; year 1
      // liquidates any audited non-current investments/receivables (the
      // projected BS carries no such rows). ──
      const prevCAxc   = y === 1 ? input.currentAssetsTotal - input.cash : prev.bs.debtors + prev.bs.closingStock;
      const prevCL     = y === 1 ? input.currentLiabilitiesTotal : prev.bs.totalCurrentLiabilities;
      const prevCap    = y === 1 ? input.shareCapital : prev.bs.shareCapital + prev.bs.additionalCapital;
      const prevLoans  = y === 1 ? input.loans.term.reduce((s, l) => s + l.amount, 0) : prev.bs.longTermLoan + prev.bs.permanentWC;
      const prevDir    = y === 1 ? input.loans.directorLoan : prev.bs.directorLending;
      const prevCash   = y === 1 ? input.cash : prev.bs.cash;
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

      years.push({ year: y, pl, bs, cf, dep, ratios, levers });
      prev = years[y - 1];
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

    return { years, ird, meta: { N, stlTotal, interestST, ltScheds, pwcScheds, seedCash, seedCred } };
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
      if (yr.ratios.currentRatio < LIMITS.minCurrentRatio - 0.005) {
        push('warn', y, 'current', `Year ${y}: Current ratio ${yr.ratios.currentRatio.toFixed(2)} is below ${LIMITS.minCurrentRatio} (rule 4).`);
      }
      if (yr.ratios.debtEquity > LIMITS.maxDebtEquity + 0.005) {
        push('warn', y, 'de', `Year ${y}: Debt-equity ${yr.ratios.debtEquity.toFixed(2)} exceeds ${LIMITS.maxDebtEquity} (rule 3).`);
      }
      if (yr.ratios.ncaHeadroom < -0.5) {
        push('warn', y, 'nca', `Year ${y}: 70% of Net Current Assets is below total working-capital loans (rule 2) by ${fmt(-yr.ratios.ncaHeadroom)}.`);
      }
      if (i > 0) {
        if (yr.pl.grossProfit <= result.years[i - 1].pl.grossProfit) push('warn', y, 'gptrend', `Year ${y}: Gross profit is not increasing (rule 6).`);
        if (yr.pl.pbt <= result.years[i - 1].pl.pbt) push('warn', y, 'pbttrend', `Year ${y}: Net profit before tax is not increasing (rule 7).`);
      }
    });
    return issues;
  }

  // ───────────────────────── public surface ─────────────────────────

  return {
    DEP_POOLS,
    LIMITS,
    TAX_SLABS,
    parseStatement,
    project,
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
