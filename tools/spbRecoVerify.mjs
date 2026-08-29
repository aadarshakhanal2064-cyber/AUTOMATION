// ════════════════════════════════════════════
//  AUTOBOOKS RECONCILIATION HARNESS
//
//  Replays the CA's own reference reconciliation through the REAL
//  js/salesPurchaseBookReco.js and asserts every figure on it.
//
//  The reconciliation was rebuilt 2026-08-29 to that CA's format, in which
//  nothing is typed: each adjustment is derived from the monthly book-versus-
//  return gaps and the omitted bills. "Derived" is only trustworthy if it
//  reproduces the accountant's own arithmetic, so this pins all three
//  statements to his figures — including the −0.30 rounding line, which the
//  app must reach by routing a sub-rupee gap to rounding rather than naming
//  the month.
//
//  The client's identity is deliberately absent (CLAUDE.md §1 rule 7 — this
//  repo is public): the figures are carried, the name, PAN and address are not.
//  Same treatment tools/psVerify.mjs gives its reference workbook.
//
//    node tools/spbRecoVerify.mjs
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const core = read('js/salesPurchaseBook.js')
    .replace(/^\/\/ ── Client search \+ FY change wiring[\s\S]*$/m, '');
  const noop = () => {};
  const els = {
    'spb-regtype': { value: 'vat' }, 'spb-fy': { value: '2082-83' },
    'spb-company': { value: 'Harness Client' }, 'spb-pan': { value: '' },
  };
  const ctx = {
    console,
    ModuleRegistry: { register: noop },
    WorkflowEngine: { createClientScope: () => ({ select: noop, invalidate: noop, clear: noop }) },
    SearchEngine: { attachAutocomplete: noop },
    DocumentEngine: { downloadBlob: noop },
    DocumentStore: { openPicker: noop },
    ReportExport: { download: noop },
    AuditLog: { record: noop },
    NepaliLocale: {
      toEnglishDigits: s => String(s == null ? '' : s).replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966)),
      todayBs: () => ({ year: 2083, month: 4, day: 30 }),
      bsMonthEnd: () => 32,
    },
    showStatus: noop, friendlyDbError: e => String(e), escHtml: s => String(s == null ? '' : s),
    document: {
      getElementById: id => els[id] || null, addEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop, querySelectorAll: () => [], appendChild: noop }),
      body: { appendChild: noop },
    },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    setTimeout, clearTimeout, confirm: () => true, URL: { createObjectURL: () => '' },
  };
  const driver = `
    globalThis.__reco = {
      setBook(sales, purchase) {
        spbData = { sales: null, purchase: null };
        const mk = (fi, taxable, taxfree) => ({ date:'2082.04.01', y:2082, m:4, d:1, fi, xr:1,
          bill:'1', party:'P', pan:'111111111', taxfree, taxable, vat: taxable*0.13,
          imp:0, impVat:0, cap:0, capVat:0, src:fi });
        if (sales) spbData.sales = { txns: sales.map((r,i) => mk(i, r[0], r[1])), stats:{}, source:'t' };
        if (purchase) spbData.purchase = { txns: purchase.map((r,i) => mk(i, r[0], r[1])), stats:{}, source:'t' };
        spbBook = spbComputeBook();
        spbGroups = spbComputeGroups();
      },
      setReturn(section, months) {
        if (!spbVr) spbVr = spbBlankVr();
        months.forEach((m, i) => { spbVr[section][i].t = String(m[0]); spbVr[section][i].f = String(m[1]); });
      },
      blankReturn() { spbVr = spbBlankVr(); },
      setOmitted(list) {
        spbOmitted = list.map(o => Object.assign({ section:'sales', taxable:0, taxfree:0, vat:0,
          cap:0, capVat:0, imp:0, impVat:0, groupKey:'X', party:'Om', kind:'omitted', billType:'bill' }, o));
      },
      setMeta(k, v) { spbRecoMeta()[k] = v; },
      model(i) { return spbRecoModel(SPB_RECO_STATEMENTS[i]); },
      vat() { return spbRecoVatModel(); },
      period() { return spbRecoPeriod(); },
    };
  `;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext([
    read('js/utils.js'), core,
    read('js/salesPurchaseBookLedger.js'),
    read('js/salesPurchaseBookReco.js'),
    driver,
  ].join('\n'), ctx, { filename: 'autobooks-reco-sandbox.js' });
  return ctx.__reco;
}

let passed = 0; const failures = [];
function check(label, actual, expected, tol = 0.005) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol : actual === expected;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const R = load();

// ── The CA's reference year ─────────────────────────────────────────────────
// Book months, Shrawan → Ashadh: [taxable, taxfree].
const SALES_BOOK = [[422960, 0], [0, 0], [74690, 0], [630939.95, 0], [636977, 0], [710700, 0],
  [2124049.70, 0], [713501, 0], [649697, 0], [1010960, 0], [39897, 0], [32276, 13000]];
const SALES_RETURN = [[450000, 0], [0, 0], [50000, 0], [650000, 0], [600000, 0], [710700, 0],
  [2124050, 0], [713501, 0], [649697, 0], [1010960, 0], [39897, 15000], [32276, 0]];
const PUR_BOOK = [[34227.68, 0], [0, 0], [71147.95, 0], [638682, 0], [637378.96, 0], [711115, 0],
  [2124904.88, 0], [714000, 0], [650265, 0], [1008367.92, 0], [146160.10, 15000], [97167.25, 0]];
const PUR_RETURN = [[34227, 0], [0, 0], [71148, 0], [638682, 0], [637379, 0], [711115, 0],
  [2124905, 0], [714000, 0], [650265, 0], [1008368, 0], [215000, 0], [50000, 90000]];

R.setBook(SALES_BOOK, PUR_BOOK);
R.blankReturn();
R.setReturn('sales', SALES_RETURN);
R.setReturn('purchase', PUR_RETURN);
R.setOmitted([
  { section: 'sales', taxable: 145731, taxfree: -2482, vat: 145731 * 0.13 },
  { section: 'purchase', taxable: 55433.04, taxfree: 50000, vat: 55433.04 * 0.13 },
]);

console.log('\n── Sales Reconciliation Statement ──');
let m = R.model(0);
check('Sales as Per Maskebari', m.ret, 7046081);
check('Add: Calculation Mistake of Taxable Sales', m.rows[3].amount, 61667);
check('Add: Calculation Mistake of Tax free Sales', m.rows[4].amount, 13000);
check('Less: Calculation Mistake of Taxable Sales', m.rows[6].amount, -46100.05);
check('Less: Calculation Mistake of Tax free Sales', m.rows[7].amount, -15000);
check('Add: Taxable Sales Omiited in Maskebari', m.rows[10].amount, 145731);
check('Less: Tax Free Sales Excess in Maskebari', m.rows[14].amount, -2482);
// The month gap of −0.30 is sub-rupee, so it must NOT be named as a
// calculation mistake — it is the filed return's whole-rupee truncation.
check('Less: Rounding Effect (derived from the sub-rupee gap)', m.rounding, -0.30);
check('Sales as Per Maskebari After Adjustment', m.after, 7202896.65);
check('Sales as Per Accounts', m.books, 7202896.65);
check('Net Difference', m.net, 0);

console.log('\n── Purchase Reconciliation Statement ──');
m = R.model(1);
check('Purchase as Per Maskebari', m.ret, 6945089);
check('Add: Calculation Mistake of Taxable Purchase', m.rows[3].amount, 47167.25);
check('Add: Calculation Mistake of Tax free Purchase', m.rows[4].amount, 15000);
check('Less: Calculation Mistake of Taxable Purchase', m.rows[6].amount, -68839.90);
check('Less: Calculation Mistake of Tax free Purchase', m.rows[7].amount, -90000);
check('Add: Taxable Purchase Omiited in Maskebari', m.rows[10].amount, 55433.04);
check('Add: Tax Free Purchase Omiited in Maskebari', m.rows[11].amount, 50000);
check('Purchase as Per Maskebari After Adjustment', m.after, 6953849.78);
check('Purchase as Per Accounts', m.books, 6953849.78);
check('Net Difference', m.net, 0);

console.log('\n── VAT Reconciliation Statement ──');
R.setMeta('openingVat', '-125100');
const v = R.vat();
check('VAT Payables (Receivables) as per Return', v.asPerReturn, -102221.04);
check('Sales Adjustment is 13% of the TAXABLE sales adjustments', v.salesAdj, 20968.7335);
check('Purchase Adjustment is 13% of the taxable purchase adjustments, negated', v.purAdj, -4388.8507);
check('VAT Payables (Receivables) as Per Books', v.closing, -85641.2469);
check('the statement clears to nil after rounding', Math.abs(v.net) < 0.005, true);
// Tax-free adjustments carry no VAT — folding them in would overstate the
// adjustment by 13% of every exempt rupee.
check('tax-free adjustments are excluded from the VAT adjustment',
  Math.abs(v.salesAdj - (61667 - 46100.05 + 145731) * 0.13) < 0.005, true);

console.log('\n── Cross check of VAT ──');
check('Opening is the typed figure', v.crossRows[0].amount, -125100);
check('Add: VAT on Purchase is negative (an input credit is receivable)', v.crossRows[1].amount < 0, true);
check('Less: VAT on Sales is positive (output VAT is payable)', v.crossRows[2].amount > 0, true);
check('Closing = opening − purchase VAT + sales VAT', v.crossRows[4].amount, -85641.2469);

console.log('\n── Structure ──');
m = R.model(0);
check('the statement carries both numbered headings',
  m.rows.filter(r => r.kind === 'heading').length, 2);
check('each heading has its own Add: and Less:',
  m.rows.filter(r => r.kind === 'sub').length, 4);
check('nothing is unexplained on a reconciled year', m.unexplained, false);

// The sales and purchase statements foot BY CONSTRUCTION: every month's gap is
// captured under heading 1 and every late bill under heading 2, so the two
// anchors cannot disagree whatever the inputs are. That is the property worth
// pinning — it is the reason the format needs no hand-typed adjustment lines.
R.setOmitted([]);
check('still foots with no omitted bills at all', R.model(0).net, 0);
R.setOmitted([{ section: 'sales', taxable: 999999, taxfree: -12345, vat: 129999.87 }]);
check('still foots with an arbitrary omitted bill', R.model(0).net, 0);
R.blankReturn();
check('still foots when no return has been filed at all', R.model(0).net, 0);
check('…and that case is called out rather than read as a clean reconciliation',
  R.model(0).retTyped, false);

console.log('\n── A difference the VAT statement CANNOT absorb ──');
// Unlike the other two, the VAT statement's ends are built differently — the
// return side from filed figures, the books side from the ledger — so a real
// divergence is possible and must be reported rather than rounded away.
R.setReturn('sales', SALES_RETURN);
R.setReturn('purchase', PUR_RETURN);
R.setOmitted([
  { section: 'sales', taxable: 145731, taxfree: -2482, vat: 145731 * 0.13 },
  { section: 'purchase', taxable: 55433.04, taxfree: 50000, vat: 55433.04 * 0.13 },
]);
R.setMeta('pyPurchaseAdj', '5000');
check('a prior-year adjustment the return never carried is left unexplained', R.vat().unexplained, true);
R.setMeta('pyPurchaseAdj', '500');
check('…while under Rs 1,000 it is absorbed as rounding', R.vat().unexplained, false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
