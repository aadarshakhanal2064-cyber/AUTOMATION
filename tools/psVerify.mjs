// ════════════════════════════════════════════════════════════════════════
//  PROVISIONAL STATEMENT — verification harness
//
//  Replays the prior-year column of the firm's REFERENCE PROVISIONAL
//  WORKBOOK through js/provisionalStatementEngine.js, and asserts every
//  derived figure back against that workbook's OWN cached results — the
//  numbers Excel itself computed and stored in the file.
//
//  The source workbook is a real client's and is NOT in this repo (the
//  templates directory is gitignored — CLAUDE.md §1 rule 7). Only the
//  arithmetic travels here, under a neutral handle: what these assertions
//  prove is that the engine reproduces Excel, and that holds whoever the
//  figures belong to.
//
//  This exists because "100% same output as the Excel file" is a claim that
//  has to be provable rather than eyeballed, and because the module's whole
//  value is that a formula cannot silently go missing. It is the same idea as
//  tools/spbVerify.mjs, and for the same reason (CLAUDE.md §12): a committed
//  harness beats an uncommitted one.
//
//  Run:  node tools/psVerify.mjs
//  Run it BEFORE and AFTER any change to the engine's rules.
// ════════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const Engine = require(path.join(here, '..', 'js', 'provisionalStatementEngine.js'));

// ── the workbook's prior-year (2081-82) column, read off Sch-PL col F,
//    Sch-BS col J, SOI col H and 3.1 PPE row 8 ──
const py = {
  sales:            79339341.649999976,   // Sch-PL F6
  otherIncome:       9135306.8000000007,  // Sch-PL F17
  interestIncome:          0,             // Sch-PL F16
  openingStock:      9117973.1999999993,  // Sch-PL F22
  purchases:        68169704.480000004,   // Sch-PL F24
  labour:             958982,             // Sch-PL F25
  freight:             19954.86,          // Sch-PL F26
  closingStock:     10932036.57,          // Sch-PL F28
  salary:            6786850.8399999999,  // Sch-PL F33
  otherContrib:            0,             // Sch-PL F34
  incentiveExpense:  7358346.666666667,   // SOI H23
  taxExpense:        1028126.6520984428,  // SOI H29 / Sch-PL F77
  advanceTax:        2209864.0300000003,  // Sch-BS J18
  otherExpenses: [
    { key: 'auditFee',     name: 'Audit Fee',                       amount:  75000 },       // F53
    { key: 'cleaning',     name: 'Cleaning Expenses',               amount:   9788 },       // F54
    { key: 'staffLunch',   name: 'Staff Lunch Expenses',            amount: 245788 },       // F55
    { key: 'courier',      name: 'Courier expenses',                amount:   2177 },       // F56
    { key: 'localTax',     name: 'Local Tax',                       amount:   6000 },       // F57
    { key: 'repairVehicle',name: 'Repair & Maintenances-Vehicle',   amount:  55677.880000000005 }, // F58
    { key: 'repairBuilding',name:'Repair & Maintenances-Building',  amount:      0 },       // F59
    { key: 'fuel',         name: 'Fuel Expenses',                   amount: 159721.54999999999 },  // F60
    { key: 'rent',         name: 'Rent expenses',                   amount: 840000 },       // F61
    { key: 'telephone',    name: 'Telephone & Internet expenses',   amount:  35154 },       // F62
    { key: 'insurance',    name: 'Insurance expenses',              amount:  43970.759999999995 }, // F63
    { key: 'electricity',  name: 'Electricity expenses',            amount:  41580 },       // F64
    { key: 'festival',     name: 'Festival Expenses',               amount:   9000 },       // F65
    { key: 'traveling',    name: 'Traveling expenses',              amount:  21477 },       // F66
    { key: 'misc',         name: 'Misc. Expenses',                  amount:  13587 },       // F67
    { key: 'hospitality',  name: 'Hospality Expenses',              amount:  29164.17 },    // F68
    { key: 'printing',     name: 'Printing & Stationery',           amount:  41587 },       // F69
    { key: 'registration', name: 'Registration & Renewal Expenses', amount:  12574 },       // F70
  ],
  // 3.1 PPE row 8 — the restated opening block IS last year's carrying amount.
  ppeClasses: [
    { key: 'land',     name: 'Land',                  carrying:       0 },
    { key: 'building', name: 'Building & Structures', carrying: 1117145.33 },
    { key: 'plant',    name: 'Plant and Machinery',   carrying:       0 },
    { key: 'vehicles', name: 'Vehicles',              carrying: 2402927.8895500796 },
    { key: 'office',   name: 'Office Equipment',      carrying:  249327.10452692903 },
    { key: 'software', name: 'Software',              carrying:   11333.33 },
  ],
  // balance-sheet carries used by the cash flow
  receivables:  21003397.991997935,   // Sch-BS J22
  inventories:  10932036.57,          // Sch-BS J30
  payables:      5417475.3813000005,  // Sch-BS J99
  cash:            42993.717323504388,// Sch-BS J39
  shareCapital: 10000000,             // SOCE F10
  reserves:      6288780.7400000002,  // SOCE I10
  loansNC:        7966020.5299999993, // Sch-BS J78
  loansC:         5058758.63,         // Sch-BS J81
  investmentsNC: 0, investmentsC: 0,
};

// ── what the preparer typed for 2082-83 (the yellow / green cells) ──
const cy = {
  sales:            101903888.59999999,   // Sch-PL D6  (=103825461.6-1921573)
  otherIncome:       11954000,            // Sch-PL D17
  interestIncome:           0,
  purchases:         92966615,            // Sch-PL D24 (green)
  closingStock:      18582170.93,         // Sch-PL D28 (yellow)
  interestOD:          459346.05,         // Sch-PL D46 (yellow)
  tradeReceivables:  12636126.249592833,  // Sch-BS H15 (green)
  cash:                269480.43861352652,// Sch-BS H38 (yellow)
  tradePayables:      6449739,            // Sch-BS H88 (yellow)
  loansNC: [{ amount: 467447.27 }],       // Sch-BS H76+H77
  loansC:  [{ amount: 4958763.97 }],      // Sch-BS H80
  taxPaid:           1028126.65,          // SOCF E23
};

const out = Engine.derive({ py, cy, options: { taxProfile: 'corporate' } });

// ── assertions: engine figure vs the workbook's own cached result ──
let pass = 0, fail = 0;
const results = [];
function eq(label, got, want, tol = 0.005) {
  const ok = Math.abs(got - want) <= tol;
  ok ? pass++ : fail++;
  results.push({ ok, label, got, want, diff: got - want });
}
const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(n));

// —— Sch-PL 3.12 Materials ——
const mat = out.income.materials;
eq('Sch-PL D22  Opening stock (= PY closing)', mat.opening, 10932036.57);
eq('Sch-PL D25  Labour Charges  =+F25/F6*D6',  mat.directItems[0].amount, 1231721.777179698);
eq('Sch-PL D26  Clearing&Freight =+F26/F6*D6', mat.directItems[1].amount, 25630.132393071057);
eq('Sch-PL D29  Materials Total  =SUM(D22:D26)-D28', mat.total, 86573832.549572766);

// —— Sch-PL 3.13 Employee ——
eq('Sch-PL D33  Salary  =ROUND(F33*1.05,-3)', out.income.employeeItems[0].amount, 7126000);
eq('Sch-PL D35  Employee Total',              out.income.employeeTotal, 7126000);

// —— Sch-PL 3.14 Finance ——
eq('Sch-PL D49  Finance Total', out.income.financeTotal, 459346.05);

// —— Sch-PL 3.15 Other Expenses: every line's ROUND(F*1.05,) ——
const other = k => (out.income.otherItems.find(e => e.key === k) || {}).amount;
eq('Sch-PL D53  Audit Fee (flat)',      other('auditFee'),      75000);
eq('Sch-PL D54  Cleaning',              other('cleaning'),      10277);
eq('Sch-PL D55  Staff Lunch',           other('staffLunch'),   258077);
eq('Sch-PL D56  Courier',               other('courier'),        2286);
eq('Sch-PL D57  Local Tax',             other('localTax'),       6300);
eq('Sch-PL D58  Repair-Vehicle',        other('repairVehicle'), 58462);
eq('Sch-PL D59  Repair-Building',       other('repairBuilding'),    0);
eq('Sch-PL D60  Fuel',                  other('fuel'),         167708);
eq('Sch-PL D61  Rent (flat)',           other('rent'),         840000);
eq('Sch-PL D62  Telephone & Internet',  other('telephone'),     36912);
eq('Sch-PL D63  Insurance',             other('insurance'),     46169);
eq('Sch-PL D64  Electricity',           other('electricity'),   43659);
eq('Sch-PL D65  Festival',              other('festival'),       9450);
eq('Sch-PL D66  Traveling',             other('traveling'),     22551);
eq('Sch-PL D67  Misc.',                 other('misc'),          14266);
eq('Sch-PL D68  Hospality',             other('hospitality'),   30622);
eq('Sch-PL D69  Printing & Stationery', other('printing'),      43666);
eq('Sch-PL D70  Registration & Renewal',other('registration'),  13203);
eq('Sch-PL D71  Other Expenses Total',  out.income.otherTotal, 1678608);

// —— SOI ——
eq('SOI F16  Total Income',       out.income.totalIncome,  113857888.59999999);
eq('SOI F23  Incentive  =ROUND(H23/H15*F15,)', out.income.incentive, 9628760);
eq('SOI F25  Total Expenses',     out.income.totalExpenses, 106068154.55261451);
eq('SOI F27  Profit Before Tax',  out.income.pbt,             7789734.047385484);
eq('SOI F29  Income Tax Expense', out.income.tax,             1947433.511846371);
eq('SOI F31  Net Profit',         out.income.netProfit,       5842300.535539113);

// —— 3.1 PPE ——
const cls = k => out.ppe.classes.find(c => c.key === k) || {};
eq('3.1 PPE F16  Building  =+F11*5%',   cls('building').depCharge,  55857.266500000005);
eq('3.1 PPE J16  Vehicles  =+J11*20%',  cls('vehicles').depCharge, 480585.57791001594);
eq('3.1 PPE L16  Office Eq =+L11*25%',  cls('office').depCharge,    62331.776131732258);
eq('3.1 PPE N16  Software  =+N11*0.25', cls('software').depCharge,   2833.3325);
eq('3.1 PPE P16  Depreciation charged', out.income.depreciation,   601607.95304174826);
eq('3.1 PPE P25  Carrying at year end', out.balance.ppe,          3179125.7010352607);
eq('3.1 PPE F25  Building carrying',    cls('building').closeCarrying, 1061288.0635000002);
eq('3.1 PPE J25  Vehicles carrying',    cls('vehicles').closeCarrying, 1922342.3116400638);

// —— Sch-BS derived statutory lines ——
const recv = k => (out.balance.receivableLines.find(l => l.key === k) || {}).amount;
const pay  = k => (out.balance.payableLines.find(l => l.key === k) || {}).amount;
eq('Sch-BS H18  Advance Tax  =+J18-SOI!H29+SOI!F15*15%', recv('advanceTax'), 2974837.3779015574);
eq('Sch-BS H20  Total receivables', out.balance.receivables, 15610963.627494391);
eq('Sch-BS H30  Inventories',       out.balance.inventories, 18582170.93);
eq('Sch-BS H89  Audit Fee Payable  =D53-H97', pay('auditFeePayable'),   73875);
eq('Sch-BS H92  TDS-Salary  =+SOI!F20*1%',    pay('tdsSalary'),         71260);
eq('Sch-BS H93  TDS-Rent  =+D61*10%',         pay('tdsRent'),           84000);
eq('Sch-BS H94  TDS on Incentives  =+F23*15%',pay('tdsIncentive'),    1444314);
eq('Sch-BS H95  TDS-Wages  =+D25*1%',         pay('tdsWages'),      12317.217771796981);
eq('Sch-BS H97  TDS-Audit fee  =+D53*1.5%',   pay('tdsAuditFee'),        1125);
eq('Sch-BS H98  TDS-Clearing&Freight =+D26*1.5%', pay('tdsFreight'), 384.45198589606582);
eq('Sch-BS H99  Total payables',    out.balance.totalPayables, 8137014.6697576931);
eq('Sch-BS H103 Provision for tax', out.balance.provisionsC,   1947433.511846371);

// —— SFP totals ——
eq('SFP F16  Total Non-Current Assets', out.balance.totalNCA,   3179125.7010352607);
eq('SFP F23  Total Current Assets',     out.balance.totalCA,   34462614.996107914);
eq('SFP F25  Total Assets',             out.balance.totalAssets, 37641740.697143175);
eq('SFP F29  Share Capital',            out.balance.shareCapital, 10000000);
eq('SFP F30  Reserves  =+SOCE!I14',     out.balance.reserves,   12131081.275539113);
eq('SFP F31  Total Equity',             out.balance.totalEquity,22131081.275539115);
eq('SFP F36  Total Non-Current Liab',   out.balance.totalNCL,     467447.27);
eq('SFP F42  Total Current Liabilities',out.balance.totalCL,    15043212.151604064);
eq('SFP F44  Total Liabilities',        out.balance.totalLiabilities, 15510659.421604063);
eq('SFP F46  Total Equity & Liabilities',out.balance.totalEquityLiab, 37641740.697143182);
eq('SFP F52  Balance check (must be nil)', out.balance.balanceGap, 0, 0.01);

// —— SOCE ——
eq('SOCE I14  Retained earnings closing', out.soce.close, 12131081.275539113);

// —— SOCF ——
const cf = out.cashflow;
eq('SOCF E18  Δ Trade & Other Receivables', cf.dRecv,  5392434.3645035438);
eq('SOCF E19  Δ Inventories',               cf.dStock, -7650134.3599999994);
eq('SOCF E20  Δ Trade & Other Payables',    cf.dPay,    2719539.2884576926);
eq('SOCF E21  Cash Generated From Operations', cf.generated, 9312527.343388468);
eq('SOCF E24  Net Cash from Operating',     cf.netOperating, 7825054.6433884669);
eq('SOCF E30  Net Cash from Investing',     cf.netInvesting, 0);
eq('SOCF E33  Δ Non-Current Borrowings',    cf.ncBorrowMove, -7498573.2599999998);
eq('SOCF E34  Δ Current Borrowings',        cf.cBorrowMove,   -99994.660000000149);
eq('SOCF E36  Net Cash from Financing',     cf.netFinancing, -7598567.9199999999);
eq('SOCF E38  Net Increase in Cash',        cf.netIncrease,   226486.72338846698);
eq('SOCF E40  Opening cash',                cf.openingCash,    42993.717323504388);
// The workbook's own E44 carries a +0.01 hand plug (its proof row E47 reads
// 0.0121, not nil). We assert against the UNPLUGGED figure — the plug is
// deliberately not reproduced — and separately that our closing cash agrees
// with the balance sheet, which the workbook's does not.
eq('SOCF E44  Closing cash (unplugged)',    cf.closingCash,   269480.44071197138);
eq('SOCF       Closing cash ties to SFP cash', cf.cashProof, 0, 0.01);

// ── the purchases/PBT see-saw must be reversible ──
// Hold the profit the forward pass produced and the engine should hand back
// the very purchases figure it started from. If the two modes ever drift, this
// fails rather than quietly issuing a statement that does not foot.
const back = Engine.derive({
  py,
  cy: Object.assign({}, cy, { purchases: undefined, pbtTarget: out.income.pbt }),
  options: { taxProfile: 'corporate', solveFor: 'purchases' },
});
eq('see-saw  Purchases re-solved from PBT', back.income.materials.purchases, cy.purchases, 0.01);
eq('see-saw  PBT unchanged',                back.income.pbt,                 out.income.pbt, 0.01);
eq('see-saw  Materials unchanged',          back.income.materials.total,     out.income.materials.total, 0.01);
eq('see-saw  Total assets unchanged',       back.balance.totalAssets,        out.balance.totalAssets, 0.01);
eq('see-saw  Balance still nil',            back.balance.balanceGap,         0, 0.01);

// ── manual overrides ──
// Advance tax, every TDS line and the VAT position can each be typed instead of
// derived. These assert BOTH directions, because the failure mode is silent: a
// helper that resolves an override to 0 zeroes the whole statutory block, and
// the totals still add up — they are just wrong. (That is exactly what a local
// `pick` shadowing the override helper did the first time this was written.)
const ov = Engine.derive({
  py,
  cy: Object.assign({}, cy, {
    advanceTax: 1500000,
    tds: { salary: 50000, rent: 90000 },
    vatRegistered: true, vatPayable: 250000,
  }),
  options: { taxProfile: 'corporate' },
});
const ovRecv = k => (ov.balance.receivableLines.find(l => l.key === k) || {}).amount;
const ovPay  = k => (ov.balance.payableLines.find(l => l.key === k) || {}).amount;
eq('override  Advance Tax typed',        ovRecv('advanceTax'), 1500000);
eq('override  TDS-Salary typed',         ovPay('tdsSalary'),     50000);
eq('override  TDS-Rent typed',           ovPay('tdsRent'),       90000);
eq('override  TDS-Incentives still derived', ovPay('tdsIncentive'), 1444314);
eq('override  TDS-Wages still derived',  ovPay('tdsWages'),  12317.217771796981);
eq('override  VAT Payable appears',      ovPay('vatPayable'),   250000);
eq('override  balance still nil',        ov.balance.balanceGap,      0, 0.01);

// A PAN-only client carries no VAT row at all — a nil VAT line is a head with
// no value, which this module drops everywhere else.
const noVat = Engine.derive({ py, cy, options: { taxProfile: 'corporate' } });
eq('no VAT    VAT rows absent', noVat.balance.payableLines.filter(l => /^vat/i.test(l.key)).length
  + noVat.balance.receivableLines.filter(l => /^vat/i.test(l.key)).length, 0);

// ── profit seeded from last year's margin ──
// profit(CY) = profit(PY) / sales(PY) x sales(CY)
eq('margin    PBT from last year’s margin',
   Engine.pbtFromMargin(4249787.5983610004, 79339341.649999976, 101903888.59999999),
   4249787.5983610004 / 79339341.649999976 * 101903888.59999999, 0.01);

// ── the COI bridge ──
// Tax charged on accounting profit is only right while accounting and
// Income-Tax depreciation agree. These assert the bridge closes the gap and
// that turning it off leaves the old behaviour untouched.
const IT_DEP = 742110;
const coiOn = Engine.derive({
  py, cy: Object.assign({}, cy, { itDepreciation: IT_DEP, broughtForwardLoss: 0 }),
  options: { taxProfile: 'corporate', useCoi: true },
});
eq('COI  taxable = PBT + acct dep − IT dep',
   coiOn.coi.taxableProfit, coiOn.income.pbt + coiOn.income.depreciation - IT_DEP);
eq('COI  tax charged on taxable income',
   coiOn.tax.onProfits, Math.max(0, coiOn.coi.taxableProfit) * 0.25);
eq('COI  bridge foots', coiOn.coi.bridgeOk ? 0 : 1, 0);
eq('COI  balance still nil', coiOn.balance.balanceGap, 0, 0.01);

// A brought-forward loss REDUCES taxable income, though the firm's sheet
// labels the row "Add: Previous year Loss" and prints it negative.
const coiLoss = Engine.derive({
  py, cy: Object.assign({}, cy, { itDepreciation: IT_DEP, broughtForwardLoss: 500000 }),
  options: { taxProfile: 'corporate', useCoi: true },
});
eq('COI  b/f loss reduces taxable', coiLoss.coi.taxableProfit, coiOn.coi.taxableProfit - 500000);

// Off, the flat basis is byte-for-byte what it always was.
const coiOff = Engine.derive({
  py, cy: Object.assign({}, cy, { itDepreciation: IT_DEP }),
  options: { taxProfile: 'corporate', useCoi: false },
});
eq('COI  off → tax on accounting profit', coiOff.tax.onProfits, out.tax.onProfits);
eq('COI  off → taxable = PBT',            coiOff.coi.taxableProfit, coiOff.income.pbt);

// ── the Autobooks summariser ──
// Three of Autobooks' own rules, which this must never drift from: a return
// carries the opposite sign, Taxable Import is its own box, and Capital
// Purchase is a slice of taxable rather than an addition to it.
const Src = require(path.join(here, '..', 'js', 'provisionalSources.js'));
const sum = Src.psrcSummarise([
  { section: 'sales',    kind: 'regular', taxable: 100000, tax_free: 5000, vat: 13000, fiscal_month: 1, party_key: 'a', pan: '111111111' },
  { section: 'sales',    kind: 'omitted', bill_type: 'sales_return', taxable: 10000, vat: 1300, fiscal_month: 2, party_key: 'a', pan: '111111111' },
  { section: 'purchase', kind: 'regular', taxable: 60000, tax_free: 2000, vat: 7800, taxable_import: 15000, import_vat: 1950, capital: 20000, fiscal_month: 1, party_key: 'b', pan: '222222222' },
  { section: 'purchase', kind: 'omitted', bill_type: 'purchase_return', taxable: 5000, vat: 650, fiscal_month: 3, party_key: 'b', pan: '222222222' },
]);
eq('source  a sales return reduces revenue',   sum.sales.taxable,      90000);
eq('source  a purchase return reduces purch',  sum.purchase.taxable,   55000);
eq('source  import kept out of taxable',       sum.purchase.imports,   15000);
eq('source  capital is a memo, not additive',  sum.purchase.capital,   20000);
eq('source  party totals accumulate',          sum.parties.sales.a.amount, 95000);
const vatPos = Src.psrcVatPosition({ reg_type: 'vat' }, sum, 't');
eq('source  VAT payable = output − input',     vatPos.payable, sum.sales.vat - (sum.purchase.vat + sum.purchase.importVat));
eq('source  PAN-only client carries no VAT',   Src.psrcVatPosition({ reg_type: 'pan' }, sum, 't') === null ? 0 : 1, 0);

// ── supporting schedules roll up ──
// The point of a schedule is that the figure is entered once, as the working
// behind it. These assert the working IS the figure, in both directions.
const sched = Engine.derive({
  py,
  cy: Object.assign({}, cy, {
    closingStock: 999,                       // must be ignored once detail exists
    stockLines: [
      { group: 'Raw Material',      particular: 'Dana',  qty: 100, rate: 250 },
      { group: 'Raw Material',      particular: 'Maize', qty: 200, rate: 150 },
      { group: 'Finished Goods',    particular: 'Fish',  amount: 500000 },
    ],
    advanceTaxLines: [{ amount: 300000 }, { amount: 250000 }],
    advanceTaxOpening: 100000,
  }),
  options: { taxProfile: 'corporate' },
});
eq('stock  qty x rate line',        sched.stock.lines[0].amount, 25000);
eq('stock  typed amount wins',      sched.stock.lines[2].amount, 500000);
eq('stock  group total',            sched.stock.groups[0].amount, 55000);
eq('stock  grand total',            sched.stock.total, 555000);
eq('stock  schedule IS the figure', sched.income.materials.closing, 555000);
eq('stock  and the balance sheet',  sched.balance.inventories, 555000);
eq('stock  note 3.4 shows groups',  sched.balance.inventoryLines.length, 2);
eq('advtax deposited',              sched.advanceTax.deposited, 550000);
eq('advtax + opening credit',       sched.advanceTax.amount, 650000);
eq('advtax reaches the note',       (sched.balance.receivableLines.find(l => l.key === 'advanceTax') || {}).amount, 650000);
eq('sched  balance still nil',      sched.balance.balanceGap, 0, 0.01);

// ── reconciliation ──
const Rec = require(path.join(here, '..', 'js', 'provisionalReconcile.js'));
const clean = Rec.run(out, { priorYear: null });
eq('recon  balance sheet ties',   clean.checks.find(c => c.id === 'balance').ok ? 0 : 1, 0);
eq('recon  cash flow ties',       clean.checks.find(c => c.id === 'cash').ok ? 0 : 1, 0);
eq('recon  note 3.3 foots',       clean.checks.find(c => c.id === 'note-recv').ok ? 0 : 1, 0);
eq('recon  note 3.9 foots',       clean.checks.find(c => c.id === 'note-pay').ok ? 0 : 1, 0);
eq('recon  note 3.1 PPE foots',   clean.checks.find(c => c.id === 'note-ppe').ok ? 0 : 1, 0);
eq('recon  profit reaches equity',clean.checks.find(c => c.id === 'equity').ok ? 0 : 1, 0);
eq('recon  nothing failing',      clean.failing.length, 0);

// A check that fails must say WHERE — a difference nobody can locate is a
// difference nobody fixes, which is the whole point of this layer.
const broken = JSON.parse(JSON.stringify(out));
broken.balance.balanceGap = 125000;
broken.balance.plugReceivables = false;
const bad = Rec.run(broken, { priorYear: null });
const bsCheck = bad.checks.find(c => c.id === 'balance');
eq('recon  a gap is NOT reconciled', bsCheck.ok ? 1 : 0, 0);
eq('recon  and it says where',     bsCheck.where.length > 0 ? 1 : 0, 1);

// The register comparison is a REVIEW, never an automatic correction: a
// provisional set may deliberately differ from the filed register.
const withReg = Rec.run(out, {
  priorYear: null,
  register: {
    revenue: { value: out.income.revenueOps + 50000, detail: 'test' },
    purchases: { value: out.income.materials.purchases, detail: 'test' },
    parties: { sales: {}, purchase: {} },
  },
});
const revCheck = withReg.checks.find(c => c.id === 'reg-revenue');
eq('recon  register gap is for review', revCheck.level === 'review' ? 0 : 1, 0);
eq('recon  and not counted as failing', withReg.failing.filter(c => c.id === 'reg-revenue').length, 0);

// ── account-head spelling ──
// The firm writes the same head several ways across clients. Left alone they
// are two heads: one grows and the other sits at nil, and note 3.15 prints
// both. The map lives on window in the browser, so the harness supplies it.
globalThis.window = globalThis.window || {};
globalThis.window.PS_HEAD_ALIASES = {
  'printing and stationeries': 'Printing & Stationery',
  'printing & stationery':     'Printing & Stationery',
  'travelling expenses':       'Traveling expenses',
  'traveling expenses':        'Traveling expenses',
  'miscellaneous expenses':    'Misc. Expenses',
  'misc. expenses':            'Misc. Expenses',
  'salary':                    'Salary Expenses',
  'salary expenses':           'Salary Expenses',
};
const canon = (a, b2) => eq(`head   "${a}"`, Engine.canonicalHead(a) === b2 ? 0 : 1, 0);
canon('Printing and Stationeries', 'Printing & Stationery');
canon('printing & stationery',     'Printing & Stationery');
canon('Travelling Expenses',       'Traveling expenses');
canon('Miscellaneous Expenses',    'Misc. Expenses');
// A head the map has never seen must survive untouched — the rule is to
// canonicalise spellings, never to invent meanings.
canon('Some Unique Client Head',   'Some Unique Client Head');

// Two spellings of one head become ONE line carrying both years, rather than
// two lines each missing one.
const merged = Engine.derive({
  py: {
    sales: 1000000, otherIncome: 0, closingStock: 0, salary: 0, ppeClasses: [],
    otherExpenses: [
      { key: 'p1', name: 'Printing & Stationery',     amount: 40000 },
      { key: 'p2', name: 'Printing and Stationeries', amount: 10000 },
      { key: 'r',  name: 'Rent expenses',             amount: 100000 },
    ],
  },
  cy: { sales: 1000000, purchases: 0, closingStock: 0 },
  options: { taxProfile: 'corporate' },
});
eq('head   two spellings collapse to one line', merged.income.otherItems.length, 2);
eq('head   and carry both years',               merged.income.otherItems[0].amount, 52500);

// ── report ──
const W = 56;
console.log('\n  PROVISIONAL STATEMENT ENGINE — replay of');
console.log('  reference provisional workbook, F.Y. 2081-82 → 2082-83\n');
let section = '';
for (const r of results) {
  const sec = r.label.split(/\s{2,}/)[0].split(' ')[0];
  if (sec !== section) { section = sec; console.log(''); }
  const mark = r.ok ? '  ok  ' : '  FAIL';
  console.log(`${mark} ${r.label.padEnd(W)} ${fmt(r.got).padStart(20)}`
    + (r.ok ? '' : `   want ${fmt(r.want)}  (off by ${fmt(r.diff)})`));
}
console.log(`\n  ${pass} passed, ${fail} failed, ${results.length} assertions\n`);

if (out.issues.length) {
  console.log('  engine findings:');
  out.issues.forEach(i => console.log(`    [${i.level}] ${i.msg}`));
  console.log('');
}

process.exit(fail ? 1 : 0);
