// ════════════════════════════════════════════════════════════════════════
//  TRIAL BALANCE READER — this year's figures, off the firm's own TB sheet
//
//  The statement modules take LAST year from the prior-year statement
//  workbook and this year by hand. This engine reads this year instead, from
//  the trial balance the firm already prepares — which is not a generic TB
//  at all: it is laid out in the statements' own vocabulary, section for
//  section, because it exists to feed them.
//
//      A. Assets:              1..9   PPE, Investments, Other Receivables,
//                                     Inventories, Trade Receivables, VAT,
//                                     Advance Tax & TDS, Prepayments, Cash
//      B. Expenses:            1..5   Purchase, Direct, Employee Benefits,
//                                     Finance Cost, Other Expenses
//      C. Revenue                     Sale of Goods, Services, Commissions,
//                                     Interest Income, Other Income
//      B. Equity and Liabilities: 1..5 Share Capital, Reserves, Loans,
//                                     Trade Payables, Duties and taxes
//
//  GEOMETRY, and why it is read the way it is.  Column A is the label,
//  column B a detail line, column C the section's own subtotal. The subtotal
//  does NOT sit on the heading row — it sits on the first row beneath it, and
//  in the reference file that row is labelled "Land" while holding the whole
//  PPE figure. So a reader that trusted labels row-for-row would report the
//  PPE total as Land. Sections are therefore found by their NUMBERED HEADING,
//  and a section's amount is the first C value inside its row span, falling
//  back to the sum of the B values there. Detail lines are the B rows.
//
//  Nothing is positional beyond "A is the label" — the section numbers, the
//  row gaps and the sheet name all vary, and the file is hand-maintained.
//
//  IT PROVES ITSELF.  A trial balance foots by construction: assets plus
//  expenses equal revenue plus equity and liabilities. `check` reports that
//  from the parsed figures rather than reading the sheet's own "Difference in
//  Trial" cell — reading their total back would only prove Excel can add.
//
//  No DOM, SheetJS passed in: stays loadable in Node so tools/tbVerify.mjs
//  can replay a real trial balance through it.
//
//  Run:  node tools/tbVerify.mjs   — before and after touching this file.
// ════════════════════════════════════════════════════════════════════════

const TrialBalanceReader = (() => {

  const WR = (typeof module !== 'undefined' && module.exports)
    ? require('./workbookReader.js')
    : (typeof window !== 'undefined' ? window.WorkbookReader : null);

  const num = v => (WR ? WR.num(v) : (typeof v === 'number' && isFinite(v) ? v : 0));
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  // Label matching drops leading numbering ("1.Purchase", "5. Trade
  // Receivables") and punctuation, so a section is recognised by its words.
  const key = s => norm(s).replace(/^[a-z]?\s*\d*\s*[.)]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();

  // ── the four top-level blocks ──
  // Matched on the letter-prefixed heading. Equity and Liabilities reuses the
  // letter "B" in the reference file (so does Expenses), which is exactly why
  // these match on the WORDS and not on the letter.
  const BLOCKS = [
    { id: 'assets',   re: /^assets\b/ },
    { id: 'expenses', re: /^expenses\b/ },
    { id: 'revenue',  re: /^revenue\b/ },
    { id: 'equity',   re: /^equity and liabilities\b|^equity liabilities\b/ },
  ];

  // ── the sections inside each block ──
  // `id` is what callers read; `re` is matched against key()'d labels. Order
  // matters only where one pattern could shadow another, so the specific ones
  // come first — the SPB_HEADER_RULES idiom.
  const SECTIONS = {
    assets: [
      { id: 'ppe',              re: /property plant|plant and equipment/ },
      { id: 'investments',      re: /^investment/ },
      { id: 'otherReceivables', re: /^other receivable/ },
      { id: 'inventories',      re: /inventor|closing stock|stock in trade/ },
      { id: 'tradeReceivables', re: /trade receivable|sundry debtor/ },
      { id: 'vatReceivable',    re: /vat receivable/ },
      { id: 'advanceTax',       re: /advance tax|tds receivable/ },
      { id: 'prepayments',      re: /prepayment|prepaid/ },
      { id: 'cash',             re: /cash and cash|cash bank|bank balance/ },
    ],
    expenses: [
      { id: 'purchases',      re: /^purchase/ },
      { id: 'directExpenses', re: /direct expense/ },
      { id: 'employee',       re: /employee benefit|salary expense/ },
      { id: 'financeCost',    re: /finance cost|interest expense/ },
      { id: 'otherExpenses',  re: /other expense|administrative expense/ },
    ],
    revenue: [
      { id: 'revenue', re: /.*/ },   // the whole block is one section
    ],
    equity: [
      { id: 'shareCapital',  re: /capital/ },
      { id: 'reserves',      re: /^reserve|retained earning|surplus/ },
      { id: 'loans',         re: /loan|borrowing/ },
      { id: 'tradePayables', re: /trade payable|sundry creditor/ },
      { id: 'dutiesTaxes',   re: /duties and taxes|duties taxes|tds payable|statutory/ },
    ],
  };

  // ── detail-line vocabularies ──
  // Where a section's DETAIL lines carry meaning the statement needs, they are
  // matched here. Anything unmatched is kept as a named line rather than
  // dropped — an unrecognised head is the firm's business, not an error.
  const REVENUE_LINES = [
    { id: 'sales',          re: /sale of goods|sales|rendering of service|service income/ },
    { id: 'otherIncome',    re: /commission|incentive|other income|discount received/ },
    { id: 'interestIncome', re: /interest income|interest received/ },
  ];
  const FINANCE_LINES = [
    // Long/term first: "Interest Expenses on OD/CC/Demand/ST" and
    // "…on HP/Term loan" both contain "interest expenses on".
    { id: 'interestTerm', re: /\bhp\b|hire purchase|term loan|\bpwc\b|permanent working/ },
    { id: 'interestOD',   re: /\bod\b|\bcc\b|overdraft|demand|short term|\bst\b|working capital/ },
    { id: 'bankCharges',  re: /charge|commission|swift|\blc\b/ },
  ];
  // Loan facility groups, in the four the statement modules already offer.
  // "Working Capital Loan" is NOT Permanent WC (CLAUDE.md §15) — the specific
  // pattern is tested first so it cannot be swallowed.
  const LOAN_GROUPS = [
    { id: 'pwc', re: /permanent working|^pwc\b|\bpwc\b/ },
    { id: 'hp',  re: /\bhp\b|hire purchase|vehicle loan|auto loan/ },
    { id: 'lt',  re: /term loan|long term/ },
    { id: 'st',  re: /.*/ },    // overdraft, CC, demand, working capital
  ];
  const PPE_CLASSES = [
    { id: 'land',     re: /^land/ },
    { id: 'building',  re: /building|structure/ },
    { id: 'plant',     re: /plant|machinery/ },
    { id: 'vehicles',  re: /vehicle|motor/ },
    { id: 'office',    re: /office equip|furniture|fixture|equipment/ },
    { id: 'software',  re: /software|computer/ },
  ];
  const TDS_LINES = [
    { id: 'salary',   re: /salary|sst|social security/ },
    { id: 'rent',     re: /rent/ },
    { id: 'auditFee', re: /audit/ },
    { id: 'freight',  re: /freight|transport|clearing/ },
    { id: 'wages',    re: /wage|labour|labor/ },
    { id: 'incentive',re: /incentive|commission/ },
  ];

  // ── where the TB stops ──
  // The sheet ends with its own proof block ("Total of Assets & Expenses",
  // "Difference in Trial"). Those carry values in the SUBTOTAL column, so
  // without this they are swallowed by whatever section was open last — in
  // the reference file that is Duties and taxes, which read as Rs 25.87
  // CRORE instead of Rs 5,448 and took the trial check down with it. Found
  // by replaying the real file after a fixture that omitted these rows.
  const TERMINATORS = /^total of|^grand total|^difference in trial|^total debit|^total credit/;

  const firstMatch = (list, label) => {
    const k = key(label);
    for (const e of list) if (e.re.test(k)) return e.id;
    return null;
  };

  // ── locate the sheet ──
  // The reference file names it "tb". Anything else is accepted too: a
  // one-sheet workbook is unambiguous, and otherwise the sheet whose column A
  // carries the block headings wins. Refusing on a name would fail on the
  // first client who called it "Trial Balance".
  function findSheet(wb, XLSX) {
    const names = wb.SheetNames || [];
    if (!names.length) return null;
    const named = names.find(n => /^(tb|trial\s*balance|trialbalance)$/i.test(String(n).trim()));
    if (named) return named;
    if (names.length === 1) return names[0];
    let best = null, bestScore = 0;
    for (const n of names) {
      const g = WR.grid(wb.Sheets[n], XLSX);
      let score = 0;
      for (const row of g) {
        if (!row) continue;
        for (const b of BLOCKS) if (b.re.test(key(row[0]))) { score++; break; }
      }
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return bestScore >= 2 ? best : names[0];
  }

  // ── parse ──
  function parse(wb, XLSX) {
    const issues = [];
    const warn = msg => issues.push({ level: 'warn', msg });
    const err = msg => issues.push({ level: 'error', msg });

    const sheetName = findSheet(wb, XLSX);
    if (!sheetName) { err('The workbook has no sheets.'); return { ok: false, issues }; }
    const g = WR.grid(wb.Sheets[sheetName], XLSX);
    if (!g.length) { err(`Sheet "${sheetName}" is empty.`); return { ok: false, issues }; }

    // Column A is the label. The value columns are whichever two columns to
    // its right actually carry numbers — read rather than assumed, because a
    // file with an extra leading column would otherwise silently read zeros.
    let detailCol = 1, totalCol = 2;
    {
      const counts = [];
      for (const row of g) {
        if (!row) continue;
        for (let c = 1; c < Math.min(row.length, 12); c++) {
          if (typeof row[c] === 'number' && isFinite(row[c])) counts[c] = (counts[c] || 0) + 1;
        }
      }
      const used = counts.map((n, c) => ({ c, n })).filter(x => x && x.n > 0).sort((a, b) => a.c - b.c);
      if (used.length >= 2) { detailCol = used[0].c; totalCol = used[1].c; }
      else if (used.length === 1) { detailCol = totalCol = used[0].c; }
      else { err('No numeric columns found beside the labels.'); return { ok: false, issues }; }
    }

    // Walk once: every row is either a block heading, a section heading, or a
    // detail line belonging to the section above it.
    const blocks = {};
    let curBlock = null, curSection = null;
    const startSection = (id, label, row) => {
      curSection = { id, label, row, total: null, lines: [] };
      if (curBlock) curBlock.sections.push(curSection);
    };

    for (let r = 0; r < g.length; r++) {
      const row = g[r] || [];
      const label = row[0];
      if (label == null || String(label).trim() === '') continue;
      const k = key(label);
      const detail = row[detailCol], total = row[totalCol];

      // The sheet's own proof block closes the walk.
      if (TERMINATORS.test(k)) break;

      // A block heading resets the section context.
      const blk = BLOCKS.find(b => b.re.test(k));
      if (blk) {
        curBlock = blocks[blk.id] || (blocks[blk.id] = { id: blk.id, sections: [], total: null, row: r });
        curBlock.total = total != null ? num(total) : (detail != null ? num(detail) : null);
        curSection = null;
        // Revenue carries no numbered sections in the reference file — its
        // lines hang straight off the block, so open one implicitly.
        if (blk.id === 'revenue') startSection('revenue', String(label), r);
        continue;
      }
      if (!curBlock) continue;   // anything above the first heading is a title

      // A section heading inside this block.
      const secId = firstMatch(SECTIONS[curBlock.id] || [], label);
      const numbered = /^\s*\d+\s*[.)]/.test(String(label));
      if (secId && (numbered || !curSection) && curBlock.id !== 'revenue') {
        startSection(secId, String(label), r);
        if (total != null) curSection.total = num(total);
        else if (detail != null) curSection.total = num(detail);
        continue;
      }

      if (!curSection) continue;
      // The subtotal row: a value in the TOTAL column, on a row that is not a
      // section heading. This is the "Land"-labelled PPE total in the
      // reference file — claimed by the section, never by the label.
      if (total != null && String(total).trim() !== '') {
        if (curSection.total == null) curSection.total = num(total);
        else curSection.total += num(total);
      }
      // A detail line.
      if (detail != null && String(detail).trim() !== '') {
        curSection.lines.push({ name: String(label).trim(), amount: num(detail) });
      }
    }

    // Fill any section whose subtotal never appeared, from its own lines.
    for (const b of Object.values(blocks)) {
      for (const sec of b.sections) {
        if (sec.total == null) sec.total = sec.lines.reduce((t, l) => t + l.amount, 0);
      }
      if (b.total == null) b.total = b.sections.reduce((t, s) => t + s.total, 0);
    }

    const sectionOf = (blockId, secId) => {
      const b = blocks[blockId];
      if (!b) return null;
      return b.sections.find(s => s.id === secId) || null;
    };
    const amountOf = (blockId, secId) => { const s = sectionOf(blockId, secId); return s ? s.total : 0; };

    for (const b of BLOCKS) {
      if (!blocks[b.id]) warn(`No "${b.id}" block found on sheet "${sheetName}" — every figure it would carry is nil.`);
    }

    // ── the trial has to foot ──
    // Recomputed from the sections rather than read off the sheet's own
    // "Difference in Trial" cell: reading their figure back would prove only
    // that Excel can add, not that this parser read the same rows they did.
    const sumBlock = id => (blocks[id] ? blocks[id].sections.reduce((t, s) => t + s.total, 0) : 0);
    const debits = sumBlock('assets') + sumBlock('expenses');
    const credits = sumBlock('revenue') + sumBlock('equity');
    const difference = debits - credits;
    if (Math.abs(difference) > 0.5) {
      warn(`The trial balance does not foot: assets and expenses come to ${difference > 0 ? 'more' : 'less'} than revenue, equity and liabilities by ${Math.abs(difference).toFixed(2)}. Figures have still been read; check the sheet before relying on them.`);
    }

    return {
      ok: true, sheetName, blocks, issues,
      check: { debits, credits, difference, foots: Math.abs(difference) <= 0.5 },
      sectionOf, amountOf,
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  toFigures — the parse, mapped onto what the statement engine reads
  //
  //  Returns the module's own shapes (`cy`, `loans`, `ppe`, `tds`, extra
  //  note lines) so the caller assigns rather than translates. Every figure
  //  is reported in `filled` so the screen can say what it took and from
  //  where — nothing is written silently.
  // ════════════════════════════════════════════════════════════════

  function toFigures(parsed) {
    if (!parsed || !parsed.ok) return null;
    const A = (b, s) => parsed.amountOf(b, s);
    const S = (b, s) => parsed.sectionOf(b, s);
    const filled = [];
    const note = (label, amount) => { filled.push({ label, amount }); return amount; };

    const cy = {};
    const bucket = (list, lines) => {
      const out = {};
      for (const l of lines) {
        const id = firstMatch(list, l.name);
        if (id) out[id] = (out[id] || 0) + l.amount;
      }
      return out;
    };

    // ── revenue ──
    const revSec = S('revenue', 'revenue');
    const rev = revSec ? bucket(REVENUE_LINES, revSec.lines) : {};
    // A revenue block with no recognised lines still has its total, and
    // turnover is the one figure nothing else can stand in for.
    cy.sales = note('Sale of Goods', rev.sales != null ? rev.sales : A('revenue', 'revenue'));
    if (rev.otherIncome) cy.otherIncome = note('Commissions & Incentives', rev.otherIncome);
    if (rev.interestIncome) cy.interestIncome = note('Interest Income', rev.interestIncome);

    // ── cost and expenses ──
    cy.purchases = note('Purchases', A('expenses', 'purchases'));

    const dirSec = S('expenses', 'directExpenses');
    const directLines = dirSec ? dirSec.lines.slice() : [];
    // Clearing & freight is a named line on the statement; anything else in
    // the block is carried as its own direct-cost line rather than folded in.
    const freightIdx = directLines.findIndex(l => /clear|freight|forward/.test(key(l.name)));
    if (freightIdx >= 0) cy.freight = note('Clearing & Freight', directLines.splice(freightIdx, 1)[0].amount);
    const labourIdx = directLines.findIndex(l => /labour|labor|wage/.test(key(l.name)));
    if (labourIdx >= 0) cy.labour = note('Labour Charges', directLines.splice(labourIdx, 1)[0].amount);
    const directExtra = directLines.map(l => ({ name: l.name, amount: l.amount }));

    const empSec = S('expenses', 'employee');
    if (empSec) {
      const sal = empSec.lines.find(l => /salary|wage|remuneration/.test(key(l.name)));
      cy.salary = note('Salary Expenses', sal ? sal.amount : empSec.total);
      const other = empSec.lines.filter(l => l !== sal).reduce((t, l) => t + l.amount, 0);
      if (other) cy.otherContrib = note('Other Contributions', other);
    }

    const finSec = S('expenses', 'financeCost');
    const fin = finSec ? bucket(FINANCE_LINES, finSec.lines) : {};
    if (finSec) {
      cy.interestOD = note('Interest on OD/CC/Short term', fin.interestOD || 0);
      cy.interestTerm = note('Interest on Term/HP/PWC', fin.interestTerm || 0);
      cy.bankCharges = note('Bank Charges', fin.bankCharges || 0);
    }

    // Other expenses stay as the firm spelled them — the statement's note
    // 3.15 is built from the client's own heads (§15), so they travel whole.
    const othSec = S('expenses', 'otherExpenses');
    const otherExpenses = othSec ? othSec.lines.map(l => ({ name: l.name, amount: l.amount })) : [];

    // ── balance sheet ──
    cy.closingStock = note('Closing Stock / Inventories', A('assets', 'inventories'));
    cy.tradeReceivables = note('Trade Receivables', A('assets', 'tradeReceivables'));
    cy.cash = note('Cash & Bank Balances', A('assets', 'cash'));
    cy.tradePayables = note('Trade Payables', A('equity', 'tradePayables'));
    const vatR = A('assets', 'vatReceivable');
    if (vatR) { cy.vatRegistered = true; cy.vatReceivable = note('VAT Receivable', vatR); }
    const advTax = A('assets', 'advanceTax');
    if (advTax) cy.advanceTax = note('Advance Tax & TDS', advTax);
    const invest = A('assets', 'investments');
    if (invest) cy.investmentsC = note('Investments', invest);
    const othRec = A('assets', 'otherReceivables');
    if (othRec) cy.otherReceivablesNC = note('Other Receivables', othRec);
    cy.shareCapital = note('Share Capital', A('equity', 'shareCapital'));

    // ── PPE, by class, for the 3.1 grid ──
    const ppeSec = S('assets', 'ppe');
    const ppe = [];
    if (ppeSec) {
      const byClass = {};
      for (const l of ppeSec.lines) {
        const id = firstMatch(PPE_CLASSES, l.name);
        if (id) byClass[id] = (byClass[id] || 0) + l.amount;
      }
      for (const k2 of Object.keys(byClass)) ppe.push({ type: k2, opening: byClass[k2] });
      if (ppe.length) note('Property, Plant & Equipment (' + ppe.length + ' classes)', ppeSec.total);
      else if (ppeSec.total) note('Property, Plant & Equipment', ppeSec.total);
    }

    // ── loans, into the four facility groups ──
    const loanSec = S('equity', 'loans');
    const loans = { st: [], lt: [], pwc: [], hp: [] };
    if (loanSec) {
      for (const l of loanSec.lines) {
        if (!l.amount) continue;           // a nil facility is not a facility
        const grp = firstMatch(LOAN_GROUPS, l.name) || 'st';
        loans[grp].push({ name: l.name, amount: l.amount, interest: null });
      }
      if (loanSec.total) note('Loans & Borrowings', loanSec.total);
    }

    // ── TDS / duties, into the engine's six withholding keys ──
    const dutySec = S('equity', 'dutiesTaxes');
    const tds = {};
    if (dutySec) {
      for (const l of dutySec.lines) {
        if (!l.amount) continue;
        const id = firstMatch(TDS_LINES, l.name);
        if (id) tds[id] = (tds[id] || 0) + l.amount;
      }
      if (Object.keys(tds).length) note('Duties & taxes payable', dutySec.total);
    }

    // ── prepayments become note-3.3 lines rather than a lump ──
    const preSec = S('assets', 'prepayments');
    const extraRecv = preSec ? preSec.lines.filter(l => l.amount).map(l => ({ name: l.name, amount: l.amount })) : [];
    if (extraRecv.length) note('Prepayments (' + extraRecv.length + ' lines)', preSec.total);

    return {
      cy, loans, ppe, tds, otherExpenses, directExtra, extraRecv, filled,
      reserves: A('equity', 'reserves'),
      check: parsed.check,
      issues: parsed.issues,
    };
  }

  return { parse, toFigures, findSheet, BLOCKS, SECTIONS, LOAN_GROUPS, PPE_CLASSES, key };
})();

// Browser: global (matches the app's no-module architecture). Node: export so
// tools/tbVerify.mjs can replay a real trial balance through it.
if (typeof module !== 'undefined' && module.exports) module.exports = TrialBalanceReader;
else window.TrialBalanceReader = TrialBalanceReader;
