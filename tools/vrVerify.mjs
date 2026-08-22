// ════════════════════════════════════════════════════════════════════════
//  VAT REGISTER VERIFICATION HARNESS
//
//      node tools/vrVerify.mjs
//
//  Run this before and after ANY change to the period-bucketing or Masebari
//  arithmetic in js/vatRegister.js.
//
//  WHY IT EXISTS
//  A VAT return is filed per trimester, and which trimester a bill lands in
//  is decided by arithmetic nobody can eyeball: B.S. months, a fiscal year
//  that starts in Shrawan and wraps mid-B.S.-year, and month lengths that
//  vary per year (Ashadh runs 31 or 32 days). The firm's own spec sheet got
//  this wrong — it wrote its periods as literal date spans ending 07.30 /
//  11.30 / 03.31, which silently drop any bill dated after those days in a
//  longer month. A dropped bill is a misfiled return, and nothing on screen
//  would say so.
//
//  So this asserts the real thing: it loads js/core/nepaliLocale.js and
//  js/vatRegister.js themselves (shimmed, not copied) and drives their own
//  functions. A copy of the logic here would prove only that the copy works
//  — the same reason tools/spbVerify.mjs exists (CLAUDE.md §12).
//
//  DEPENDENCY-FREE and OFFLINE: no database, no network, no npm. The only
//  inputs are the B.S. calendar table and figures made up in this file.
// ════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── A DOM stub just wide enough for the module's vrVal()/getElementById ──
// Every control the module reads is a value box, so one id→value map covers
// the lot. Anything it tries to render into gets a scratch object.
const fields = new Map();
const sinks = new Map();
function el(id) {
  if (fields.has(id)) return { get value() { return fields.get(id); }, set value(v) { fields.set(id, String(v)); }, dataset: {}, style: {} };
  if (!sinks.has(id)) sinks.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } });
  return sinks.get(id);
}

const sandbox = {
  console,
  document: { getElementById: (id) => el(id), createElement: () => ({ style: {}, classList: { add() {} } }), body: { appendChild() {} } },
  // config.js constructs a Supabase client at load; it is never called here.
  supabase: { createClient: () => ({ from: () => ({}) }) },
  setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('offline harness')),
  URL, URLSearchParams,
  // config.js reads the URL fragment at load (the recovery/invite links).
  location: { hash: '', search: '', href: 'http://localhost/' },
  history: { replaceState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  // vatRegister.js self-registers at load, like every module in this app.
  ModuleRegistry: { register() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}

load('js/core/nepaliLocale.js');
load('js/config.js');
load('js/vatRegister.js');

const NL = sandbox.NepaliLocale;
const run = (expr) => vm.runInContext(expr, sandbox);
const call = (fn, ...args) => {
  sandbox.__args = args;
  return run(`${fn}(...__args)`);
};
// The module's state is declared with `let` at script top level, which in a vm
// context lives in the global LEXICAL scope and is NOT a property of the
// sandbox object — assigning sandbox.vrMemos would silently create a shadow
// global while the module kept reading its own empty array. Assign through
// evaluated code instead. (This harness found that the hard way.)
const setVar = (name, value) => { sandbox.__v = value; run(`${name} = __v;`); };

console.log('VAT Register verification\n');

// ════════════════════════════════════════════════════════════════════════
//  1. NepaliLocale.bsMonthEnd — the calendar helper the labels depend on
// ════════════════════════════════════════════════════════════════════════
// Spot-checked against the same BS_MONTH_LENGTHS table the whole app uses.
// The point is not the individual numbers but that the function reads the
// table rather than assuming 30.
checkTrue('bsMonthEnd returns a real month length for every 2080–2090 month', (() => {
  for (let y = 2080; y <= 2090; y++) {
    for (let m = 1; m <= 12; m++) {
      const d = NL.bsMonthEnd(y, m);
      if (!(d >= 29 && d <= 32)) return false;
    }
  }
  return true;
})());
check('bsMonthEnd is null outside the table (2079)', NL.bsMonthEnd(2079, 1), null);
check('bsMonthEnd is null outside the table (2091)', NL.bsMonthEnd(2091, 1), null);
check('bsMonthEnd rejects month 0',  NL.bsMonthEnd(2083, 0), null);
check('bsMonthEnd rejects month 13', NL.bsMonthEnd(2083, 13), null);

// THE case the spec sheet gets wrong. If any tabulated year has a 32-day
// Ashadh, a hardcoded "03.31" period end would drop that day's bills.
const longAshadhYears = [];
for (let y = 2080; y <= 2090; y++) if (NL.bsMonthEnd(y, 3) > 31) longAshadhYears.push(y);
checkTrue('at least one tabulated year has a 32-day Ashadh (the sheet\'s 03.31 would drop it)', longAshadhYears.length > 0);
console.log(`  · years with a 32-day Ashadh: ${longAshadhYears.join(', ') || 'none'}`);

// ════════════════════════════════════════════════════════════════════════
//  2. Fiscal-year and trimester bucketing
// ════════════════════════════════════════════════════════════════════════
const P = (year, month, day) => ({ year, month, day });

// Shrawan (4) opens the fiscal year; Baishakh–Ashadh belong to the year that
// began the previous Shrawan.
check('Shrawan 1 2083 → F.Y. start 2083', call('vrFyStartOfBs', P(2083, 4, 1)), 2083);
check('Ashadh 31 2084 → F.Y. start 2083', call('vrFyStartOfBs', P(2084, 3, 31)), 2083);
check('Ashadh 1 2083  → F.Y. start 2082', call('vrFyStartOfBs', P(2083, 3, 1)), 2082);
check('Chaitra 2083   → F.Y. start 2083', call('vrFyStartOfBs', P(2083, 12, 5)), 2083);

// Fiscal month index: 1 = Shrawan … 12 = Ashadh (CLAUDE.md §8).
check('fiscal month index — Shrawan (4)', call('vrFiscalMonthIndex', 4), 1);
check('fiscal month index — Ashadh (3)',  call('vrFiscalMonthIndex', 3), 12);
check('fiscal month index — Chaitra (12)', call('vrFiscalMonthIndex', 12), 9);

// Every B.S. month lands in exactly one trimester.
const expected = { 4: 'T1', 5: 'T1', 6: 'T1', 7: 'T1', 8: 'T2', 9: 'T2', 10: 'T2', 11: 'T2', 12: 'T3', 1: 'T3', 2: 'T3', 3: 'T3' };
for (const m of Object.keys(expected)) {
  check(`month ${m} → ${expected[m]}`, call('vrPeriodOfBs', P(2083, Number(m), 1)), expected[m]);
}

// THE REGRESSION GUARD. Walk every single day of F.Y. 2083-84 and assert
// each one buckets into exactly one period and stays inside the year. This
// is what a hardcoded period end date fails: the sheet's 07.30 / 11.30 /
// 03.31 would leave the 31st/32nd of those months belonging to no period.
(() => {
  const fyStart = 2083;
  const counts = { T1: 0, T2: 0, T3: 0 };
  let orphans = 0, strayYear = 0, days = 0;
  for (const [year, month] of monthsOfFy(fyStart)) {
    const end = NL.bsMonthEnd(year, month);
    for (let d = 1; d <= end; d++) {
      days++;
      const parts = P(year, month, d);
      const per = call('vrPeriodOfBs', parts);
      if (!per) { orphans++; continue; }
      counts[per]++;
      if (call('vrFyStartOfBs', parts) !== fyStart) strayYear++;
    }
  }
  check('every day of F.Y. 2083-84 buckets into a period (no orphans)', orphans, 0);
  check('every day of F.Y. 2083-84 resolves to that fiscal year', strayYear, 0);
  check('the three periods account for every day of the year', counts.T1 + counts.T2 + counts.T3, days);
  console.log(`  · F.Y. 2083-84 = ${days} days — T1 ${counts.T1}, T2 ${counts.T2}, T3 ${counts.T3}`);
})();

function monthsOfFy(fyStart) {
  const out = [];
  for (let m = 4; m <= 12; m++) out.push([fyStart, m]);
  for (let m = 1; m <= 3; m++) out.push([fyStart + 1, m]);
  return out;
}

// Period spans are rebuilt from the calendar, not hardcoded.
(() => {
  const s1 = call('vrPeriodSpan', 'T1', 2083);
  const s2 = call('vrPeriodSpan', 'T2', 2083);
  const s3 = call('vrPeriodSpan', 'T3', 2083);
  check('T1 starts on Shrawan 1',   s1.from, '2083.04.01');
  check('T2 starts on Mangsir 1',   s2.from, '2083.08.01');
  check('T3 starts on Chaitra 1',   s3.from, '2083.12.01');
  check('T3 ends in the NEXT B.S. year', s3.to.slice(0, 4), '2084');
  // Each period's end day must equal that month's real length, whatever it is.
  check('T1 ends on the real last day of Kartik', s1.to, `2083.07.${String(NL.bsMonthEnd(2083, 7)).padStart(2, '0')}`);
  check('T2 ends on the real last day of Falgun', s2.to, `2083.11.${String(NL.bsMonthEnd(2083, 11)).padStart(2, '0')}`);
  check('T3 ends on the real last day of Ashadh', s3.to, `2084.03.${String(NL.bsMonthEnd(2084, 3)).padStart(2, '0')}`);
  console.log(`  · F.Y. 2083-84 spans — T1 ${s1.from}–${s1.to} · T2 ${s2.from}–${s2.to} · T3 ${s3.from}–${s3.to}`);
})();

// A span outside the calendar table degrades to null rather than lying.
check('period span is null outside the calendar table', call('vrPeriodSpan', 'T1', 2099), null);
check('period span label is blank outside the table', call('vrPeriodSpanLabel', 'T1', 2099), '');

// ════════════════════════════════════════════════════════════════════════
//  3. Masebari arithmetic, against figures worked by hand
// ════════════════════════════════════════════════════════════════════════
//
// Two sales memos and two purchase bills inside T1 of F.Y. 2083-84, plus one
// of each OUTSIDE it, so the period filter has something to exclude.
(() => {
  fields.set('vr-firm', 'shailesh');
  fields.set('vr-fy', '2083-84');
  fields.set('vr-period', 'T1');

  // AD dates chosen by converting the B.S. dates we want through the app's
  // own table, so the fixture can't disagree with the code under test.
  const ad = (bsY, bsM, bsD) => adForBs(bsY, bsM, bsD);

  setVar('vrMemos', [
    // In T1 (Shrawan / Kartik 2083)
    { id: 1, apply_vat: true,  firm_key: 'shailesh', memo_date: ad(2083, 4, 10), professional_fee: 100000, vat_amount: 13000, total_amount: 113000, fiscal_year: '2082-83', client_name: 'A', memo_number: 'SM-SA-00001' },
    { id: 2, apply_vat: true,  firm_key: 'shailesh', memo_date: ad(2083, 7, NL.bsMonthEnd(2083, 7)), professional_fee: 50000, vat_amount: 6500, total_amount: 56500, fiscal_year: '2082-83', client_name: 'B', memo_number: 'SM-SA-00002' },
    // In T2 — must NOT reach the T1 return
    { id: 3, apply_vat: true,  firm_key: 'shailesh', memo_date: ad(2083, 8, 1), professional_fee: 999999, vat_amount: 129999.87, total_amount: 1129998.87, fiscal_year: '2082-83', client_name: 'C', memo_number: 'SM-SA-00003' },
    // VAT not applied — never a VAT sale at all
    { id: 4, apply_vat: false, firm_key: 'shailesh', memo_date: ad(2083, 4, 12), professional_fee: 77000, vat_amount: 0, total_amount: 77000, fiscal_year: '2082-83', client_name: 'D', memo_number: 'SM-SA-00004' },
    // Another firm — out of scope
    { id: 5, apply_vat: true,  firm_key: 'dallakoti', memo_date: ad(2083, 4, 12), professional_fee: 40000, vat_amount: 5200, total_amount: 45200, fiscal_year: '2082-83', client_name: 'E', memo_number: 'SM-DC-00001' },
  ]);
  setVar('vrPurchases', [
    { id: 11, bill_date: ad(2083, 5, 3),  tax_free: 2000, taxable: 20000, vat: 2600 },
    { id: 12, bill_date: ad(2083, 6, 18), tax_free: 0,    taxable: 10000, vat: 1300 },
    { id: 13, bill_date: ad(2083, 9, 4),  tax_free: 500,  taxable: 90000, vat: 11700 },  // T2 — excluded
  ]);
  setVar('vrCollections', []);
  setVar('vrReturn', {
    sales_adj_amount: 5000, sales_adj_vat: 650,
    purchase_adj_amount: 1000, purchase_adj_vat: 130,
    opening_credit: 400, sales_adj_note: '', purchase_adj_note: '', remarks: '',
  });

  const f = run('vrMasebariFigures()');

  check('sales rows in T1 (VAT memos, this firm, this year only)', f.sales.length, 2);
  check('purchase rows in T1', f.purch.length, 2);

  // Worked by hand:
  //   sales      100,000 + 50,000            = 150,000   VAT 13,000 + 6,500 = 19,500
  //   tax free   2,000 + 0                   =   2,000
  //   taxable    20,000 + 10,000             =  30,000   VAT 2,600 + 1,300  =  3,900
  //   output     150,000 + 5,000             = 155,000   VAT 19,500 + 650   = 20,150
  //   input       30,000 + 1,000             =  31,000   VAT 3,900 + 130    =  4,030
  //   difference                                          20,150 − 4,030    = 16,120
  //   net                                                 16,120 − 400      = 15,720
  check('sales amount',        f.salesAmt, 150000);
  check('sales VAT',           f.salesVat, 19500);
  check('tax free purchase',   f.taxFree, 2000);
  check('taxable purchase',    f.taxable, 30000);
  check('purchase VAT',        f.purchVat, 3900);
  check('output total amount', f.outAmt, 155000);
  check('output VAT',          f.outVat, 20150);
  check('input total amount',  f.inAmt, 31000);
  check('input VAT',           f.inVat, 4030);
  check('difference = output VAT − input VAT', f.diff, 16120);
  check('net payable = difference − opening',  f.net, 15720);

  // The two identities the return has to satisfy, however the figures change.
  check('output total foots to its components', f.outVat, f.salesVat + f.sAdjVat);
  check('input total foots to its components',  f.inVat, f.purchVat + f.pAdjVat);
  check('tax-free purchase is excluded from the input total', f.inAmt, f.taxable + f.pAdjAmt);

  // A receivable position (input exceeding output) must come out negative,
  // which is what "Receivable if (−)" on the printed return means.
  setVar('vrReturn', { sales_adj_amount: 0, sales_adj_vat: 0, purchase_adj_amount: 0, purchase_adj_vat: 0, opening_credit: 100000 });
  const g = run('vrMasebariFigures()');
  checkTrue('a big opening credit produces a NEGATIVE (receivable) position', g.net < 0);
  check('receivable position value', g.net, 19500 - 3900 - 100000);

  // Switching period re-scopes everything, with no leakage from T1.
  fields.set('vr-period', 'T2');
  setVar('vrReturn', null);   // no adjustments saved for T2
  const t2 = run('vrMasebariFigures()');
  check('T2 picks up only its own sales', t2.salesAmt, 999999);
  check('T2 picks up only its own purchases', t2.taxable, 90000);
  check('a period with no saved return row reads its adjustments as nil', t2.sAdjVat, 0);
})();

// Convert a B.S. date to the AD string the fixtures need, by walking the
// app's own adToBs until it matches — slow but honest, and it means the
// fixture dates are produced by the same table the code reads.
function adForBs(y, m, d) {
  // Anchor: 2083.04.01 is on or about 2026-07-17; scan a wide window.
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 1200; i++) {
    const dt = new Date(start + i * 86400000);
    const iso = dt.toISOString().slice(0, 10);
    const bs = NL.adToBs(iso);
    if (bs && bs.year === y && bs.month === m && bs.day === d) return iso;
  }
  throw new Error(`no AD date found for B.S. ${y}.${m}.${d}`);
}

// ════════════════════════════════════════════════════════════════════════
//  4. Purchase total and the duplicate guard
// ════════════════════════════════════════════════════════════════════════
check('purchase total = tax free + taxable + VAT',
  call('vrPurchaseTotal', { tax_free: 2000, taxable: 20000, vat: 2600 }), 24600);
check('purchase total treats blanks as nil',
  call('vrPurchaseTotal', { taxable: 100 }), 100);

(() => {
  setVar('vrEditingPurchaseId', null);
  setVar('vrPurchases', [
    { id: 21, fiscal_year: '2083-84', bill_no: '1042', party_name: 'Alpha Traders', party_pan: '301234567', tax_free: 0, taxable: 1000, vat: 130 },
  ]);
  checkTrue('same bill no + same PAN in the same year is flagged',
    call('vrFindDuplicateBill', '2026-08-01', 'Alpha Traders', '301234567', '1042', '2083-84') != null);
  checkTrue('same bill no from a DIFFERENT party is not flagged',
    call('vrFindDuplicateBill', '2026-08-01', 'Beta Supply', '309999999', '1042', '2083-84') == null);
  checkTrue('same bill no in a different fiscal year is not flagged',
    call('vrFindDuplicateBill', '2026-08-01', 'Alpha Traders', '301234567', '1042', '2084-85') == null);
  checkTrue('a bill with no number never collides',
    call('vrFindDuplicateBill', '2026-08-01', 'Alpha Traders', '301234567', '', '2083-84') == null);
  // A Devanagari-numeral PAN is the SAME tax id as its English twin — the
  // normalisation CLAUDE.md §6 requires. Without it this returns no match.
  checkTrue('a Devanagari-numeral PAN matches its English twin',
    call('vrFindDuplicateBill', '2026-08-01', 'Alpha Traders', '३०१२३४५६७', '1042', '2083-84') != null);
  // Editing a bill must not flag the bill being edited.
  setVar('vrEditingPurchaseId', 21);
  checkTrue('editing a bill does not flag itself',
    call('vrFindDuplicateBill', '2026-08-01', 'Alpha Traders', '301234567', '1042', '2083-84') == null);
  setVar('vrEditingPurchaseId', null);
})();

// ════════════════════════════════════════════════════════════════════════
//  5. Head vocabulary
// ════════════════════════════════════════════════════════════════════════
(() => {
  // Asset classes come from DEP_SLM_CLASSES, so the register and the
  // depreciation schedule can never name a class differently.
  const assets = run('vrAssetHeads()');
  const cfg = sandbox.window.DEP_SLM_CLASSES.filter(c => c.depreciable).map(c => c.name);
  check('asset heads are exactly the depreciable DEP_SLM_CLASSES', assets, cfg);
  checkTrue('Land is not offered as a VAT asset purchase', !assets.includes('Land'));

  // Expense heads merge the seed list with what has already been typed, and
  // must not fragment on casing.
  setVar('vrPurchases', [
    { nature: 'expenses', head: 'printing & stationery' },   // same head, different case
    { nature: 'expenses', head: 'Bank Charges' },            // genuinely new
    { nature: 'assets',   head: 'Vehicles' },                // must not leak into expenses
  ]);
  const heads = run('vrExpenseHeads()');
  const lower = heads.map(h => h.toLowerCase());
  check('the seed head appears exactly once despite a differently-cased duplicate',
    lower.filter(h => h === 'printing & stationery').length, 1);
  checkTrue('a newly typed head is offered', heads.includes('Bank Charges'));
  checkTrue('an asset class does not leak into the expense list', !heads.includes('Vehicles'));
  checkTrue('every seeded head survives',
    sandbox.window.VR_EXPENSE_HEADS.every(h => lower.includes(h.toLowerCase())));
})();

// ════════════════════════════════════════════════════════════════════════
//  6. Outstanding / collected split
// ════════════════════════════════════════════════════════════════════════
(() => {
  fields.set('vr-firm', 'shailesh');
  fields.set('vr-fy', '2083-84');
  const d = adForBs(2083, 5, 5);
  setVar('vrMemos', [
    { id: 101, apply_vat: true,  firm_key: 'shailesh', memo_date: d, vat_amount: 1300, professional_fee: 10000, total_amount: 11300, client_name: 'A' },
    { id: 102, apply_vat: true,  firm_key: 'shailesh', memo_date: d, vat_amount: 2600, professional_fee: 20000, total_amount: 22600, client_name: 'B' },
    { id: 103, apply_vat: false, firm_key: 'shailesh', memo_date: d, vat_amount: 0,    professional_fee: 5000,  total_amount: 5000,  client_name: 'C' },
  ]);
  setVar('vrCollections', []);
  check('both VAT memos start outstanding', run('vrOutstandingMemos()').length, 2);
  checkTrue('a non-VAT memo is never outstanding',
    run('vrOutstandingMemos()').every(m => m.id !== 103));

  setVar('vrCollections', [{ id: 1, service_memo_id: 101, amount: 1300 }]);
  check('collecting one memo leaves one outstanding', run('vrOutstandingMemos()').length, 1);
  check('the remaining outstanding memo is the uncollected one', run('vrOutstandingMemos()')[0].id, 102);

  setVar('vrCollections', []);
  check('deleting the collection returns the memo to outstanding', run('vrOutstandingMemos()').length, 2);
})();

// ════════════════════════════════════════════════════════════════════════
//  7. Report models — colspan arithmetic
// ════════════════════════════════════════════════════════════════════════
// fsxSheetHtml's lesson (CLAUDE.md §15): a model whose total row carries a
// different number of cells than the header has columns lays out wrong in
// one renderer and fine in another. Assert it rather than eyeball it.
(() => {
  fields.set('vr-firm', 'shailesh');
  fields.set('vr-fy', '2083-84');
  fields.set('vr-period', 'T1');
  setVar('vrPurchases', [{ id: 1, bill_date: adForBs(2083, 5, 3), tax_free: 1, taxable: 2, vat: 3, nature: 'expenses', head: 'X', party_name: 'P' }]);
  setVar('vrCollections', [{ id: 1, payment_date: adForBs(2083, 5, 4), client_name: 'A', amount: 5 }]);
  setVar('vrReturn', null);

  for (const [name, expr] of [
    ['sales', 'vrSalesModel(vrSalesMemos())'],
    ['purchase', 'vrPurchaseModel(vrPurchases)'],
    ['masebari', 'vrMasebariModel(vrMasebariFigures())'],
    ['collections', 'vrCollectionsModel()'],
  ]) {
    const m = run(expr);
    const n = m.columns.length;
    const bad = m.rows.filter(r => r.style !== 'section' && r.cells.length !== n);
    check(`${name} model — every row has ${n} cells`, bad.length, 0);
    checkTrue(`${name} model has a title`, !!m.title);
  }
})();

// ════════════════════════════════════════════════════════════════════════
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ all ${passed} checks passed`);
