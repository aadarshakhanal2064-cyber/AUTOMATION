// ════════════════════════════════════════════════════════════════════════
//  TRIAL BALANCE READER — verification harness
//
//  Replays a real trial balance through js/core/trialBalanceReader.js and
//  asserts every figure it hands the statement modules.
//
//  The source file is a client's and is NOT in this repo (CLAUDE.md §1 rule
//  7 — the repo is public). Only the ARITHMETIC travels here, under neutral
//  handles: what these assertions prove is that the reader picks the right
//  rows out of the firm's own TB layout, and that holds whoever the figures
//  belong to. Point CORPUS at a real file to replay it:
//
//      node tools/tbVerify.mjs                     # built-in fixture
//      TB=path/to/TrialBalance.xlsx node tools/tbVerify.mjs
//
//  The built-in fixture reproduces the reference file's SHAPE exactly —
//  including the two traps that shape contains:
//
//    · the PPE subtotal sits on the row labelled "Land", not on the section
//      heading, so a label-for-label reader reports it as Land;
//    · the block letter "B" is used twice (Expenses and Equity and
//      Liabilities), so a reader keying on the letter mixes them.
//
//  Run it BEFORE and AFTER any change to the reader.
// ════════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const TB = require(path.join(here, '..', 'js', 'core', 'trialBalanceReader.js'));

// ── a 30-line SheetJS stand-in ──
// The reader only ever calls XLSX.utils.decode_range and encode_cell through
// WorkbookReader.grid(), so the harness supplies those rather than pulling a
// dependency into a repo that deliberately has none.
const XLSX = {
  utils: {
    decode_range(ref) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
      const col = s => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      return { s: { c: col(m[1]), r: +m[2] - 1 }, e: { c: col(m[3]), r: +m[4] - 1 } };
    },
    encode_cell({ r, c }) {
      let s = '', n = c + 1;
      while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = (n - k - 1) / 26; }
      return s + (r + 1);
    },
  },
};

// Build a {SheetNames, Sheets} workbook from rows of [label, detail, total].
function wbFrom(name, rows) {
  const cells = {};
  let maxC = 0;
  rows.forEach((row, r) => {
    (row || []).forEach((v, c) => {
      if (v === null || v === undefined || v === '') return;
      cells[XLSX.utils.encode_cell({ r, c })] = { v };
      if (c > maxC) maxC = c;
    });
  });
  cells['!ref'] = 'A1:' + XLSX.utils.encode_cell({ r: rows.length - 1, c: Math.max(maxC, 2) });
  return { SheetNames: [name], Sheets: { [name]: cells } };
}

// ── the fixture: the reference file's shape, with neutral figures ──
// Section subtotals live in column C, detail lines in column B, and the PPE
// subtotal deliberately sits on the "Land" row exactly as the real file has it.
const N = null;
const FIXTURE = [
  ['Particular', 'Amount', 'Amount'],
  [],
  ['A. Assets:', N, 31966597.69],
  [],
  ['1.Property, Plant and Equipment'],
  ['    Land ', N, 2495620.89],          // ← the subtotal, on the "Land" row
  ['    Building', 2234585.67],
  ['    Office Equipments', 142917.04],
  ['    Vehicles', 118118.18],
  ['     Plant & Machinery'],
  [],
  ['2.Investments', 0, 0],
  ['3. Other Receivables', 0, 0],
  ['4.Inventories', N, 17791110.35],
  ['5. Trade Receivables', N, 7627950.61],
  ['Party One Pvt Ltd', 3508300.45],
  ['Party Two Pvt Ltd', 1844417.93],
  ['Other Receivable', 2275231.56],
  ['Party Three Pvt Ltd', 0.67],
  ['6. VAT Receivables', N, 1972527.10],
  ['7. Advance Tax & TDS Receivables', N, 140000],
  ['8. Prepayments', N, 7154],
  ['Prepaid Insurance', 7154],
  ['Advance to Suppliers', 0],
  ['Deposit ', 0],
  ['Margin', 0],
  ['9.Cash and Cash Equivalents', N, 1932234.74],
  ['A Bank Limited', 1017951.74],
  [' Cash Balance', 914283],
  [],
  ['B. Expenses', N, 97400039.12],
  ['1. Purchase', N, 93007515.84],
  ['Purchase of goods', 93007515.84],
  ['2. Direct Expenses', N, 572760.23],
  ['Clearing & Forwarding  Expenses', 462432.99],
  ['Parking Charge', 110327.24],
  ['3. Employee Benefits Expenses', N, 624800],
  ['Salary Expenses', 624800],
  ['Other Expenses', 0],
  ['4. Finance Cost', N, 2312444.01],
  ['Interest Expenses on OD/CC/Demand/ST', 2009445.99],
  ['Interest Expenses on HP/Term loan', 0],
  [' Lc Charge', 33031.30],
  ['Bank Charges', 35811.67],
  ['Swift Charge', 234155.05],
  ['5. Other Expenses', N, 882519.04],
  ['Audit Fee', 70000],
  ['Charity & Donations', 7000],
  ['Insurance Exp', 540433.71],
  ['Miscellaneous Expenses', 57097.33],
  ['Office Maintenance Expenses', 2000],
  ['Service Charges Paid', 14500],
  ['Software Expenses', 42600],
  ['Tax Expenses', 137713],
  ['Telephone Expenses', 9900],
  ['Transportation Expenses', 1275],
  [],
  ['C.Revenue ', N, 88618378.80],
  ['Sale of Goods', 88618378.80],
  ['Rendering of Services'],
  ['Commisions & Incentives'],
  ['Interest Income'],
  ['Other Income'],
  [],
  ['B. Equity and Liabilities:', N, 40748258.01],   // ← "B" reused
  ['1.Share Capital', N, 10000000],
  ['2.Reserves', N, 1081682.27],
  ['3.Loans and Borrowings', N, 25250000],
  ['HP Loan', 0],
  ['Term Loan', 0],
  ['PWC Loan ', 0],
  [' Working Capital Loan', 13000000],
  [' Demnad Loan', 12250000],
  ['4.Trade Payables', N, 4411127.74],
  ['Party Four Pvt Ltd', 107656.99],
  ['An Insurance Company Ltd', 18168.75],
  ['Party Five Trade Link', 3745950],
  ['Other Payable', 539352],
  ['5.Duties and taxes:', N, 5448],
  ['TDS on Salary', 5448],
  ['TDS on Rent'],
  ['TDS Payable-Audit fee'],
  [],
  // The sheet's own proof block. These carry values in the SUBTOTAL column,
  // so a reader that does not stop here folds them into Duties and taxes —
  // which is exactly what the real file did before TERMINATORS existed.
  ['Total of Assets & Expenses', N, 129366636.81],
  ['Total of Equity & Liabilities & Expenses', N, 129366636.81],
  ['Difference in Trial', N, 0],
];

// ── real-file mode ──
function loadReal(file) {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'tbv'));
  execFileSync('unzip', ['-o', file, '-d', tmp], { stdio: 'ignore' });
  const rd = f => (fs.existsSync(path.join(tmp, f)) ? fs.readFileSync(path.join(tmp, f), 'utf8') : '');
  const ss = [...rd('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  const wbx = rd('xl/workbook.xml');
  const relsRaw = rd('xl/_rels/workbook.xml.rels');
  const rel = {};
  for (const m of relsRaw.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rel[m[1]] = m[2].replace(/^\/?xl\//, '');
  const out = { SheetNames: [], Sheets: {} };
  for (const m of wbx.matchAll(/<sheet name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const x = rd('xl/' + rel[m[2]]);
    const cells = {};
    let maxR = 1, maxC = 0;
    for (const c of x.matchAll(/<c r="([A-Z]+)(\d+)"((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = (c[3].match(/t="([^"]+)"/) || [])[1];
      const inner = c[4] || '';
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v === undefined) continue;
      if (t === 's') v = ss[+v]; else if (t !== 'str' && t !== 'inlineStr') v = parseFloat(v);
      cells[c[1] + c[2]] = { v };
      maxR = Math.max(maxR, +c[2]);
      maxC = Math.max(maxC, [...c[1]].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0));
    }
    cells['!ref'] = 'A1:' + XLSX.utils.encode_cell({ r: maxR - 1, c: Math.max(maxC - 1, 2) });
    out.SheetNames.push(m[1]);
    out.Sheets[m[1]] = cells;
  }
  return out;
}

const real = process.env.TB;
const wb = real ? loadReal(real) : wbFrom('tb', FIXTURE);

let pass = 0, fail = 0;
const money = v => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function eq(label, got, want, tol = 0.005) {
  if (Math.abs(Number(got) - Number(want)) <= tol) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}\n          got  ${money(got)}\n          want ${money(want)}`);
}
function ok(label, cond) { if (cond) { pass++; return; } fail++; console.log(`  FAIL  ${label}`); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(real ? `\n  Replaying ${path.basename(real)}\n` : '\n  Replaying the built-in reference-shape fixture\n');

const parsed = TB.parse(wb, XLSX);
ok('parse succeeded', parsed.ok);
if (!parsed.ok) { console.log(parsed.issues); process.exit(1); }

section('The trial foots — recomputed from the sections, not read off the sheet');
eq('debits (assets + expenses)', parsed.check.debits, 31966597.69 + 97400039.12);
eq('credits (revenue + equity & liabilities)', parsed.check.credits, 88618378.80 + 40748258.01);
eq('difference', parsed.check.difference, 0, 0.51);
ok('foots', parsed.check.foots);

section('Sections are found by heading, and carry the C-column subtotal');
// The trap: this subtotal sits on the row LABELLED "Land". Reading labels
// row-for-row reports 2,495,620.89 as the cost of land.
eq('assets · PPE', parsed.amountOf('assets', 'ppe'), 2495620.89);
eq('assets · Inventories', parsed.amountOf('assets', 'inventories'), 17791110.35);
eq('assets · Trade Receivables', parsed.amountOf('assets', 'tradeReceivables'), 7627950.61);
eq('assets · VAT Receivable', parsed.amountOf('assets', 'vatReceivable'), 1972527.10);
eq('assets · Advance Tax & TDS', parsed.amountOf('assets', 'advanceTax'), 140000);
eq('assets · Prepayments', parsed.amountOf('assets', 'prepayments'), 7154);
eq('assets · Cash', parsed.amountOf('assets', 'cash'), 1932234.74);
eq('expenses · Purchase', parsed.amountOf('expenses', 'purchases'), 93007515.84);
eq('expenses · Direct', parsed.amountOf('expenses', 'directExpenses'), 572760.23);
eq('expenses · Employee Benefits', parsed.amountOf('expenses', 'employee'), 624800);
eq('expenses · Finance Cost', parsed.amountOf('expenses', 'financeCost'), 2312444.01);
eq('expenses · Other', parsed.amountOf('expenses', 'otherExpenses'), 882519.04);
eq('revenue', parsed.amountOf('revenue', 'revenue'), 88618378.80);
// The trap: "B." labels BOTH Expenses and Equity and Liabilities.
eq('equity · Share Capital', parsed.amountOf('equity', 'shareCapital'), 10000000);
eq('equity · Reserves', parsed.amountOf('equity', 'reserves'), 1081682.27);
eq('equity · Loans', parsed.amountOf('equity', 'loans'), 25250000);
eq('equity · Trade Payables', parsed.amountOf('equity', 'tradePayables'), 4411127.74);
eq('equity · Duties and taxes', parsed.amountOf('equity', 'dutiesTaxes'), 5448);

const f = TB.toFigures(parsed);
ok('toFigures returned', !!f);

section("Mapped onto the engine's own figures");
eq('cy.sales', f.cy.sales, 88618378.80);
eq('cy.purchases', f.cy.purchases, 93007515.84);
eq('cy.closingStock', f.cy.closingStock, 17791110.35);
eq('cy.tradeReceivables', f.cy.tradeReceivables, 7627950.61);
eq('cy.cash', f.cy.cash, 1932234.74);
eq('cy.tradePayables', f.cy.tradePayables, 4411127.74);
eq('cy.shareCapital', f.cy.shareCapital, 10000000);
eq('cy.salary', f.cy.salary, 624800);
eq('cy.freight (Clearing & Forwarding)', f.cy.freight, 462432.99);
eq('cy.advanceTax', f.cy.advanceTax, 140000);
eq('cy.vatReceivable', f.cy.vatReceivable, 1972527.10);
ok('a VAT balance switches the client to VAT-registered', f.cy.vatRegistered === true);
eq('reserves', f.reserves, 1081682.27);

section('Finance cost splits by facility, not by row order');
// "Interest Expenses on OD/CC/Demand/ST" and "…on HP/Term loan" differ only
// in their tail, so the term pattern is tested first.
eq('cy.interestOD', f.cy.interestOD, 2009445.99);
eq('cy.interestTerm', f.cy.interestTerm, 0);
eq('cy.bankCharges (LC + bank + swift)', f.cy.bankCharges, 33031.30 + 35811.67 + 234155.05);
eq('finance cost still foots', f.cy.interestOD + f.cy.interestTerm + f.cy.bankCharges, 2312444.01);

section('Loans land in the four facility groups');
// A nil facility is not a facility — HP, Term and PWC are all zero here.
ok('no empty HP facility carried', f.loans.hp.length === 0);
ok('no empty Term facility carried', f.loans.lt.length === 0);
ok('no empty PWC facility carried', f.loans.pwc.length === 0);
eq('short-term facilities counted', f.loans.st.length, 2);
eq('short-term total', f.loans.st.reduce((t, l) => t + l.amount, 0), 25250000);
// "Working Capital Loan" is NOT Permanent WC (CLAUDE.md §15).
ok('a plain Working Capital Loan is short-term, not PWC',
   f.loans.st.some(l => /working capital/i.test(l.name)));

section('PPE lands as depreciation classes');
const cls = Object.fromEntries(f.ppe.map(p => [p.type, p.opening]));
eq('building', cls.building, 2234585.67);
eq('office equipment', cls.office, 142917.04);
eq('vehicles', cls.vehicles, 118118.18);
ok('a class with no figure is not invented', cls.plant === undefined && cls.land === undefined);
eq('the classes add to the PPE subtotal', f.ppe.reduce((t, p) => t + p.opening, 0), 2495620.89);

section("Other expenses travel whole, in the firm's own spelling");
eq('other-expense lines', f.otherExpenses.length, 10);
eq('they add to the section total', f.otherExpenses.reduce((t, l) => t + l.amount, 0), 882519.04);
ok('Audit Fee is one of them', f.otherExpenses.some(l => /audit fee/i.test(l.name)));
// A direct-cost line that is neither freight nor labour is kept, not folded in.
ok('Parking Charge kept as its own direct cost',
   f.directExtra.some(l => /parking/i.test(l.name)) && f.directExtra.length === 1);

section('Detail lines that are notes, not figures');
eq('prepayment lines (nil ones dropped)', f.extraRecv.length, 1);
ok('the nil prepayments are not carried', !f.extraRecv.some(l => l.amount === 0));
eq('TDS on salary', f.tds.salary, 5448);
ok('a blank TDS row is not carried', f.tds.rent === undefined && f.tds.auditFee === undefined);

section('Everything written is reported');
ok('filled[] is non-empty', f.filled.length > 0);
ok('every filled entry names its figure', f.filled.every(x => x.label && typeof x.amount === 'number'));

section('Robustness');
// A sheet under any name, with the numeric columns shifted right, still reads.
const shifted = FIXTURE.map(r => (r && r.length ? [r[0], null, r[1], r[2]] : r));
const p2 = TB.parse(wbFrom('Trial Balance FY82-83', shifted), XLSX);
ok('a renamed sheet with shifted value columns still parses', p2.ok);
eq('…and finds the same purchases', p2.amountOf('expenses', 'purchases'), 93007515.84);
eq('…and still foots', p2.check.difference, 0, 0.51);
// A TB that does not foot warns rather than throwing.
const broken = FIXTURE.map(r => (r && r[0] === '4.Inventories' ? [r[0], N, 111] : r));
const p3 = TB.parse(wbFrom('tb', broken), XLSX);
ok('a TB that does not foot is reported, not thrown', p3.ok && !p3.check.foots
   && p3.issues.some(i => /does not foot/.test(i.msg)));
// The sheet's own proof block must not be read as data. Without the
// terminator the last section swallows all three rows.
ok("the sheet's own totals are not folded into the last section",
   parsed.amountOf('equity', 'dutiesTaxes') === 5448);

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
