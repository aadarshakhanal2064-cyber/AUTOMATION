// ════════════════════════════════════════════════════════════════════════
//  TRIAL BALANCE MODULE — verification harness
//
//      node tools/tbsVerify.mjs
//
//  Replays the firm's own trial balance format through js/core/trialBalanceModel.js
//  and asserts the balance sheet and income statement it draws, then drives the
//  two-way binding: every editable statement row is typed into, and the trial
//  balance is re-read to prove the figure came back.
//
//  The figures are the reference file's, with the party and bank names
//  replaced — the repo is public (CLAUDE.md §1 rule 7). The ARITHMETIC is
//  real, which is the part that has to be proven: the file foots at
//  1,29,36,66,636.81 on both sides and the balance sheet balances only because
//  the loss of 87,81,660.32 lands in Reserves.
//
//  The properties it exists to hold:
//
//    1. Balance sheet difference == trial balance difference, always. They are
//       the same number rearranged, and if a section stops reaching the
//       balance sheet this is the only place it shows.
//    2. Every write-back round-trips: type X on the statement, read X back.
//    3. A write-back to an aggregated row never touches a typed detail line —
//       it adds one named adjustment, and typing the original figure again
//       REMOVES it rather than leaving a nil row behind.
//    4. The identity survives every edit. Editing an asset breaks the trial
//       by exactly the amount typed; editing nothing leaves it footing.
// ════════════════════════════════════════════════════════════════════════

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TBM = require(path.join(root, 'js/core/trialBalanceModel.js'));
const FSX = require(path.join(root, 'js/finStatementExport.js'));

let pass = 0, fail = 0;
const money = v => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function eq(label, got, want, tol = 0.005) {
  if (Math.abs(Number(got) - Number(want)) <= tol) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}\n          got  ${money(got)}\n          want ${money(want)}`);
}
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}${detail ? '\n          ' + detail : ''}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

// ── the reference trial balance, typed ──
const S = (amount, lines) => ({ amount: amount || 0, lines: lines || [] });
const L = (name, amount) => ({ name, amount });

const REF = {
  version: 1,
  taxLine: null,
  loanSide: {},
  sections: {
    ppe: S(0, [L('Building', 2234585.67), L('Office Equipments', 142917.04), L('Vehicles', 118118.18)]),
    investments: S(0),
    otherReceivables: S(0),
    inventories: S(17791110.35),
    tradeReceivables: S(0, [
      L('Party One Pvt Ltd', 3508300.45),
      L('Party Two Homes Pvt Ltd', 1844417.93),
      L('Other Receivable', 2275231.56),
      L('Party Three Medico Pvt Ltd', 0.67),
    ]),
    vatReceivable: S(1972527.10),
    advanceTax: S(140000),
    prepayments: S(0, [L('Prepaid Insurance', 7154), L('Advance to Suppliers', 0), L('Deposit', 0), L('Margin', 0)]),
    cash: S(0, [L('A Bank Limited', 1017951.74), L('Cash Balance', 914283)]),

    purchases: S(0, [L('Purchase of goods', 93007515.84)]),
    directExpenses: S(0, [L('Clearing & Forwarding Expenses', 462432.99), L('Parking Charge', 110327.24)]),
    employee: S(0, [L('Salary Expenses', 624800), L('Other Expenses', 0)]),
    financeCost: S(0, [
      L('Interest Expenses on OD/CC/Demand/ST', 2009445.99),
      L('Interest Expenses on HP/Term loan', 0),
      L('Lc Charge', 33031.30),
      L('Bank Charges', 35811.67),
      L('Swift Charge', 234155.05),
    ]),
    otherExpenses: S(0, [
      L('Audit Fee', 70000), L('Charity & Donations', 7000), L('Insurance Exp', 540433.71),
      L('Miscellaneous Expenses', 57097.33), L('Office Maintenance Expenses', 2000),
      L('Service Charges Paid', 14500), L('Software Expenses', 42600),
      L('Tax Expenses', 137713), L('Telephone Expenses', 9900), L('Transportation Expenses', 1275),
    ]),

    revenue: S(0, [L('Sale of Goods', 88618378.80)]),

    shareCapital: S(10000000),
    reserves: S(1081682.27),
    loans: S(0, [
      L('HP Loan', 0), L('Term Loan', 0), L('PWC Loan', 0),
      L('Working Capital Loan', 13000000), L('Demand Loan', 12250000),
    ]),
    tradePayables: S(0, [
      L('Party Four Pvt Ltd', 107656.99), L('An Insurance Company Ltd', 18168.75),
      L('Party Five Trade Link', 3745950), L('Other Payable', 539352),
    ]),
    dutiesTaxes: S(0, [L('TDS on Salary', 5448)]),
  },
};

const clone = s => JSON.parse(JSON.stringify(s));

console.log('\n  Replaying the reference trial balance format\n');

// ════════════════════════════════════════════════════════════════
section('The trial balance foots, exactly as the source file does');
const t0 = TBM.totals(REF);
eq('Total A. Assets', t0.blocks.assets, 31966597.69);
eq('Total B. Expenses', t0.blocks.expenses, 97400039.12);
eq('Total C. Revenue', t0.blocks.revenue, 88618378.80);
eq('Total D. Equity and Liabilities', t0.blocks.equity, 40748258.01);
eq('Total of Assets & Expenses', t0.debits, 129366636.81);
eq('Total of Revenue, Equity & Liabilities', t0.credits, 129366636.81);
eq('Difference in Trial', t0.difference, 0);
ok('foots', t0.foots);

// A section with detail sums its lines; one without carries its own amount.
eq('PPE sums its three classes', t0.sec.ppe, 2495620.89);
eq('Trade Receivables sums its four parties', t0.sec.tradeReceivables, 7627950.61);
eq('Inventories is a bare figure', t0.sec.inventories, 17791110.35);
eq('Prepayments ignores its three nil lines', t0.sec.prepayments, 7154);

// ════════════════════════════════════════════════════════════════
section('The balance sheet, drawn off it');
const d0 = TBM.derive(REF, {});
const v0 = d0.values;
eq('Profit/(loss) for the year = revenue − expenses', d0.profit, -8781660.32);
eq('PPE', v0.ppe, 2495620.89);
eq('Investments (non-current)', v0.invNC, 0);
eq('Total Non-Current Assets', v0.totalNCA, 2495620.89);
eq('Inventories', v0.stock, 17791110.35);
// The one aggregated asset row: parties + VAT + advance tax + prepayments.
eq('Trade and Other Receivables', v0.recv, 7627950.61 + 1972527.10 + 140000 + 7154);
eq('Cash and Cash Equivalents', v0.cash, 1932234.74);
eq('Total Current Assets', v0.totalCA, 29470976.80);
eq('Total Assets', v0.totalAssets, 31966597.69);

eq('Share Capital', v0.capital, 10000000);
eq('Reserves = brought forward + the year\'s result', v0.reserves, 1081682.27 - 8781660.32);
eq('Total Equity', v0.totalEquity, 2300021.95);
// Working Capital Loan is NOT Permanent WC (CLAUDE.md §15), so it is current
// alongside the Demand Loan; the three nil facilities carry nothing either way.
eq('Loans — non-current', v0.loanNC, 0);
eq('Loans — current', v0.loanC, 25250000);
eq('Trade & Other Payables (payables + duties)', v0.pay, 4411127.74 + 5448);
eq('Total Current Liabilities', v0.totalCL, 29666575.74);
eq('Total Liabilities', v0.totalLiab, 29666575.74);
eq('Total Equity and Liabilities', v0.totalEL, 31966597.69);

ok('the balance sheet balances', Math.abs(v0.totalAssets - v0.totalEL) < 0.005,
   `assets ${money(v0.totalAssets)} vs equity+liabilities ${money(v0.totalEL)}`);
ok('nothing is raised as an error', !d0.issues.some(i => i.level === 'error'),
   JSON.stringify(d0.issues.filter(i => i.level === 'error')));

// ════════════════════════════════════════════════════════════════
section('The income statement');
eq('Revenue From Operations', v0.rev, 88618378.80);
eq('Interest Income', v0.intInc, 0);
eq('Other Income', v0.othInc, 0);
eq('Total Income', v0.totalIncome, 88618378.80);
eq('a) Purchase', v0.purchases, 93007515.84);
eq('b) Direct Expenses', v0.direct, 572760.23);
eq('c) Employee Benefit Expenses', v0.employee, 624800);
eq('d) Finance Cost', v0.finance, 2312444.01);
eq('e) Other Expenses', v0.other, 882519.04);
eq('Total Expenses', v0.totalExpenses, 97400039.12);
eq('Profit Before Tax', v0.pbt, -8781660.32);
eq('No tax charged until a line is named', v0.tax, 0);
eq('Profit / (Loss) For the Year', v0.np, -8781660.32);
ok('net profit IS what lands in reserves', Math.abs(v0.np - d0.profit) < 0.005);

// ── naming a ledger line as the tax charge lifts it out of Other Expenses ──
const withTax = clone(REF); withTax.taxLine = 'Tax Expenses';
const dT = TBM.derive(withTax, {});
eq('Other Expenses drops the tax line', dT.values.other, 882519.04 - 137713);
eq('Income Tax Expenses carries it', dT.values.tax, 137713);
eq('Profit Before Tax rises by the tax', dT.values.pbt, -8781660.32 + 137713);
eq('...and Net Profit is unchanged — the identity holds', dT.values.np, -8781660.32);
eq('...so Reserves is unchanged too', dT.values.reserves, v0.reserves);
eq('...and the trial still foots', TBM.totals(withTax).difference, 0);

const badTax = clone(REF); badTax.taxLine = 'A Line That Was Deleted';
ok('a tax line that no longer exists warns rather than charging nil silently',
   TBM.derive(badTax, {}).issues.some(i => i.level === 'warn' && /named as the income tax charge/.test(i.msg)));

// ════════════════════════════════════════════════════════════════
section('The identity: the two differences are ONE number');
{
  // Break the trial deliberately and prove both sides move together.
  const broken = clone(REF);
  broken.sections.inventories.amount = 17791110.35 + 250000;
  const tB = TBM.totals(broken), dB = TBM.derive(broken, {});
  eq('trial difference', tB.difference, 250000);
  eq('balance sheet gap', dB.values.totalAssets - dB.values.totalEL, 250000);
  ok('they agree', Math.abs((dB.values.totalAssets - dB.values.totalEL) - tB.difference) < 0.005);
  ok('a trial that does not foot warns, and is not forced',
     dB.issues.some(i => i.level === 'warn' && /does not foot/.test(i.msg)));
  ok('...and is NOT raised as an error — the figures still print',
     !dB.issues.some(i => i.level === 'error'));
}

// ════════════════════════════════════════════════════════════════
section('Two-way binding: every editable row round-trips');
{
  // A row's value after typing X into it must read back as X, and nothing
  // else on the statement may move except what arithmetically follows.
  const CASES = [
    ['ppe', 3000000], ['invNC', 125000], ['othRecNC', 40000],
    ['stock', 18000000], ['recv', 10000000], ['cash', 2500000],
    ['capital', 12000000], ['reserves', -5000000],
    ['loanNC', 4000000], ['loanC', 21000000], ['pay', 5000000],
    ['rev', 90000000], ['intInc', 12000], ['othInc', 33000],
    ['purchases', 94000000], ['direct', 600000], ['employee', 700000],
    ['finance', 2400000], ['other', 900000],
  ];
  for (const [k, want] of CASES) {
    const res = TBM.applyEdit(REF, k, want);
    ok(`${k}: the edit is accepted`, res.ok, res.message);
    const back = TBM.derive(res.state, {}).values[k];
    eq(`${k}: reads back`, back, want);
    ok(`${k}: says what it did`, !!res.message);
    // The trial balance must move by exactly what was typed, on the side the
    // row sits on — that is what proves it went to the ledger and not into a
    // display-only override.
    const dt = TBM.totals(res.state).difference - t0.difference;
    const expected = ({
      ppe: 1, invNC: 1, othRecNC: 1, stock: 1, recv: 1, cash: 1,      // debit side, +
      capital: -1, reserves: -1, loanNC: -1, loanC: -1, pay: -1,      // credit side, −
      rev: -1, intInc: -1, othInc: -1,
      purchases: 1, direct: 1, employee: 1, finance: 1, other: 1,
    })[k];
    // Reserves is the exception: typing it sets the brought-forward balance
    // under an unchanged profit, so the credit side moves by the same amount.
    eq(`${k}: the trial moves by exactly the amount typed`, dt, expected * (want - v0[k]));
  }
}

// ════════════════════════════════════════════════════════════════
section('An aggregated row never rewrites a typed detail line');
{
  const res = TBM.applyEdit(REF, 'recv', 10000000);
  const st = res.state;
  const parties = st.sections.tradeReceivables.lines;
  eq('Party One is untouched', parties.find(l => l.name === 'Party One Pvt Ltd').amount, 3508300.45);
  eq('Party Two is untouched', parties.find(l => l.name === 'Party Two Homes Pvt Ltd').amount, 1844417.93);
  eq('VAT Receivable is untouched', TBM.sectionTotal(st.sections.vatReceivable), 1972527.10);
  eq('Advance Tax is untouched', TBM.sectionTotal(st.sections.advanceTax), 140000);
  const adj = parties.filter(l => l.adj);
  ok('exactly one adjustment line was added', adj.length === 1, JSON.stringify(adj));
  ok('it is named for the statement it came from', adj[0] && /Balance Sheet/.test(adj[0].name), adj[0] && adj[0].name);
  eq('it carries the whole difference', adj[0].amount, 10000000 - (1972527.10 + 140000 + 7154) - 7627950.61);
  eq('the section now foots to the statement figure',
     TBM.sectionTotal(st.sections.tradeReceivables) + 1972527.10 + 140000 + 7154, 10000000);

  // Editing again UPDATES the same line rather than stacking a second.
  const res2 = TBM.applyEdit(st, 'recv', 11000000);
  const adj2 = res2.state.sections.tradeReceivables.lines.filter(l => l.adj);
  ok('a second edit updates the same adjustment', adj2.length === 1, JSON.stringify(adj2));
  eq('...to the new difference', adj2[0].amount, 11000000 - (1972527.10 + 140000 + 7154) - 7627950.61);

  // Typing the ORIGINAL figure back removes it — no nil row is left behind.
  const res3 = TBM.applyEdit(res2.state, 'recv', v0.recv);
  ok('typing the original figure removes the adjustment',
     res3.state.sections.tradeReceivables.lines.filter(l => l.adj).length === 0);
  eq('...and the trial foots again', TBM.totals(res3.state).difference, 0);
  eq('...and every party line is exactly as typed',
     TBM.sectionTotal(res3.state.sections.tradeReceivables), 7627950.61);
}

// ── a section with NO detail is simply set; nothing is invented ──
{
  const res = TBM.applyEdit(REF, 'stock', 18000000);
  eq('a bare section takes the figure directly', res.state.sections.inventories.amount, 18000000);
  ok('...with no adjustment line', res.state.sections.inventories.lines.length === 0);
}

// ── a section WITH detail gets an adjustment even though it maps 1:1 ──
{
  const res = TBM.applyEdit(REF, 'ppe', 3000000);
  const lines = res.state.sections.ppe.lines;
  eq('Building is untouched', lines.find(l => l.name === 'Building').amount, 2234585.67);
  eq('the adjustment carries the difference', lines.find(l => l.adj).amount, 3000000 - 2495620.89);
}

// ════════════════════════════════════════════════════════════════
section('Reserves writes the brought-forward balance, never the profit');
{
  const res = TBM.applyEdit(REF, 'reserves', 2000000);
  const d = TBM.derive(res.state, {});
  eq('Reserves reads back as typed', d.values.reserves, 2000000);
  eq('the year\'s result is untouched', d.profit, -8781660.32);
  eq('...so the ledger reserve is the difference', TBM.sectionTotal(res.state.sections.reserves), 2000000 + 8781660.32);
  ok('the message says so', /brought forward/.test(res.message), res.message);
}

// ════════════════════════════════════════════════════════════════
section('Loans split by facility, and each side moves alone');
{
  const split = TBM.loanSplit(REF);
  eq('nothing is non-current', split.nc, 0);
  eq('working capital + demand are current', split.c, 25250000);

  // A term loan is non-current by name, through the reader's own table.
  const withTerm = clone(REF);
  withTerm.sections.loans.lines.find(l => l.name === 'Term Loan').amount = 5000000;
  const s2 = TBM.loanSplit(withTerm);
  eq('a term loan lands non-current', s2.nc, 5000000);
  eq('...and the current side is unchanged', s2.c, 25250000);

  // A per-line override beats the name — the sanction letter is the fact.
  const overridden = clone(withTerm);
  overridden.loanSide['Term Loan'] = 'c';
  eq('an override moves it', TBM.loanSplit(overridden).c, 30250000);
  eq('...leaving nothing non-current', TBM.loanSplit(overridden).nc, 0);

  // Typing the non-current side must not disturb the current one.
  const res = TBM.applyEdit(REF, 'loanNC', 4000000);
  const d = TBM.derive(res.state, {});
  eq('non-current reads back', d.values.loanNC, 4000000);
  eq('current is untouched', d.values.loanC, 25250000);
  eq('Working Capital Loan is untouched',
     res.state.sections.loans.lines.find(l => l.name === 'Working Capital Loan').amount, 13000000);
}

// ════════════════════════════════════════════════════════════════
section('Revenue splits three ways and each part moves alone');
{
  const withOther = clone(REF);
  withOther.sections.revenue.lines.push(L('Interest Income', 45000), L('Commission Received', 12000));
  const r = TBM.revenueSplit(withOther);
  eq('sales', r.sales, 88618378.80);
  eq('interest income', r.interestIncome, 45000);
  eq('other income', r.otherIncome, 12000);
  eq('and they sum to the section', r.sales + r.interestIncome + r.otherIncome, r.total);

  const res = TBM.applyEdit(withOther, 'othInc', 50000);
  const d = TBM.derive(res.state, {});
  eq('other income reads back', d.values.othInc, 50000);
  eq('turnover is untouched', d.values.rev, 88618378.80);
  eq('interest is untouched', d.values.intInc, 45000);
}

// ════════════════════════════════════════════════════════════════
section('Derived rows refuse to be typed into');
{
  for (const k of ['totalAssets', 'totalEL', 'totalIncome', 'pbt', 'np', 'totalCA']) {
    const res = TBM.applyEdit(REF, k, 1);
    ok(`${k} is not editable`, !res.ok, res.message);
  }
  ok('an unknown row is refused', !TBM.applyEdit(REF, 'nope', 1).ok);
  ok('a tax figure with no named line is refused', !TBM.applyEdit(REF, 'tax', 1000).ok);
  const res = TBM.applyEdit(withTax, 'tax', 200000);
  ok('...and accepted once a line is named', res.ok, res.message);
  eq('...writing to that ledger line', TBM.derive(res.state, {}).values.tax, 200000);
}

// ════════════════════════════════════════════════════════════════
section('The pages the export layer draws');
{
  const rep = TBM.toReport(REF, {});
  eq('the report carries all four blocks', rep.blocks.length, 4);
  eq('assets has nine sections', rep.blocks[0].sections.length, 9);
  eq('the trial check travels with it', rep.check.difference, 0);
  ok('a section title carries its number', rep.blocks[0].sections[4].title === '5. Trade Receivables',
     rep.blocks[0].sections[4].title);
  ok('the short title drops it', rep.blocks[0].sections[4].shortTitle === 'Trade Receivables');

  // The capital head follows the entity (CLAUDE.md §15).
  const prop = TBM.toReport(REF, { capitalLabel: 'Proprietors Capital' });
  ok('a proprietorship\'s capital head follows the entity',
     prop.blocks[3].sections[0].title === '1. Proprietors Capital', prop.blocks[3].sections[0].title);

  const tbSheet = FSX.fsxTbSheet(rep, { subtitle: 'As at 32nd Ashadh 2083' });
  ok('the export layer draws it', tbSheet.key === 'TB' && tbSheet.rows.length > 40);
  ok('and reports it foots', tbSheet.foots);
  eq('grand debits', tbSheet.grandDr, 129366636.81);
  eq('grand credits', tbSheet.grandCr, 129366636.81);

  const sheets = TBM.buildSheets(REF, {
    capitalLabel: 'Share Capital', asAtCy: '32nd Ashadh 2083',
    asAtLine: 'As at 32nd Ashadh 2083', forYearLine: 'For the year ended 32nd Ashadh 2083',
    titles: { sfp: 'Statement of Financial Position', soi: 'Statement of Income' },
  }, FSX.FSX_GEOM);
  eq('two statement sheets', sheets.length, 2);
  ok('SFP first', sheets[0].key === 'SFP');
  ok('SOI second', sheets[1].key === 'SOI');
  ok('each has one value column', sheets[0].cols.length === 1 && sheets[1].cols.length === 1);
  ok('the tax row is absent until a line is named',
     !sheets[1].rows.some(r => r.k === 'tax'));
  ok('...and the Net Profit sum does not reference it',
     !(sheets[1].rows.find(r => r.k === 'np') || {}).xsum);

  const taxed = TBM.buildSheets(withTax, {}, FSX.FSX_GEOM);
  ok('naming a line brings the tax row back', taxed[1].rows.some(r => r.k === 'tax'));

  // Every row's colspan arithmetic must work in the HTML renderer — the same
  // structural check vrVerify applies to its own models.
  for (const sh of sheets.concat([tbSheet])) {
    const html = FSX.fsxSheetHtml(sh, { company: { name: 'Test', address: 'Chitwan' }, asAtCy: '', asAtPy: '' });
    ok(`${sh.key} renders`, html.length > 200 && html.indexOf('<table') > 0);
  }

  // The linking pass: statement cells whose figure still equals a ledger row
  // become live references to the Trial Balance sheet.
  const linked = FSX.fsxLinkToTb(sheets, tbSheet.rows);
  ok('statement figures are linked to the trial balance', linked > 0, `linked ${linked}`);
  ok('PPE is linked', !!(sheets[0].rows.find(r => r.k === 'ppe') || {}).xf);
  ok('an aggregated row is NOT linked — it equals no single ledger row',
     !(sheets[0].rows.find(r => r.k === 'recv') || {}).xf);
  // Both loan rows carry the same label; the value test is what stops the
  // wrong one claiming the ledger's figure.
  ok('the current loan row is linked', !!(sheets[0].rows.find(r => r.k === 'loanC') || {}).xf);
  ok('the nil non-current loan row is not', !(sheets[0].rows.find(r => r.k === 'loanNC') || {}).xf);
}

// ════════════════════════════════════════════════════════════════
section('State handling');
{
  const b = TBM.blank();
  eq('a blank sheet has every section', Object.keys(b.sections).length, TBM.SECTION_IDS.length);
  eq('...and foots at nil', TBM.totals(b).difference, 0);
  ok('...and says nothing is typed yet',
     TBM.derive(b, {}).issues.some(i => i.level === 'info' && /Nothing typed yet/.test(i.msg)));

  // A stored row missing a section must still open — a save written before a
  // section existed cannot be allowed to break the screen.
  const partial = TBM.normalize({ sections: { cash: { amount: 500 } } });
  eq('a partial state fills in', Object.keys(partial.sections).length, TBM.SECTION_IDS.length);
  eq('...keeping what it had', TBM.sectionTotal(partial.sections.cash), 500);

  const junk = TBM.normalize({ sections: { cash: { lines: [{ name: '', amount: '' }, { name: 'Bank', amount: '1,234.50' }] } } });
  eq('an abandoned blank row is dropped', junk.sections.cash.lines.length, 1);
  eq('...and a typed figure survives its commas', junk.sections.cash.lines[0].amount, 1234.50);
  ok('normalize is not destructive', TBM.totals(REF).difference === 0);
}

// ════════════════════════════════════════════════════════════════
console.log(`\n  ${pass} passed, ${fail} failed, ${pass + fail} assertions\n`);
process.exit(fail ? 1 : 0);
