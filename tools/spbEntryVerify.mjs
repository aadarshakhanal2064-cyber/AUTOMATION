// ════════════════════════════════════════════
//  AUTOBOOKS DATA-ENTRY VERIFICATION HARNESS
//
//  Proves the in-app data-entry sheet (js/salesPurchaseBookEntry.js) feeds the
//  REAL parsing pipeline correctly: typed rows → spbEnSheet → spbParseRows →
//  spbComputeBook/spbComputeGroups, plus the pure smart-fill helpers (date
//  normalization, bill sequencing, the party directory and its ranking).
//
//  Committed for the same reason tools/spbVerify.mjs is (CLAUDE.md §12): the
//  uncommitted harness is the one whose helpers quietly go missing. Run it
//  before and after touching the entry sheet or anything it feeds:
//
//    node tools/spbEntryVerify.mjs
//
//  Dependency-free; vm-loads the real module files with stubbed engines, the
//  spbVerify.mjs pattern. The ledger file is loaded too because the entry
//  layer reads its state (spbBookId, spbLedgerParties, spbOmPlainName).
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadModules() {
  const utils = fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'js/salesPurchaseBook.js'), 'utf8')
    .replace(/^\/\/ ── Client search \+ FY change wiring[\s\S]*$/m, '');
  const ledger = fs.readFileSync(path.join(ROOT, 'js/salesPurchaseBookLedger.js'), 'utf8');
  const entry = fs.readFileSync(path.join(ROOT, 'js/salesPurchaseBookEntry.js'), 'utf8');

  const noop = () => {};
  const els = {
    'spb-regtype': { value: 'vat' },
    'spb-fy': { value: '2082-83' },
    'spb-company': { value: 'Harness Client' },
    'spb-pan': { value: '' },
  };
  const ctx = {
    console,
    ModuleRegistry: { register: noop },
    WorkflowEngine: { createClientScope: () => ({ select: noop, invalidate: noop, clear: noop }) },
    SearchEngine: { attachAutocomplete: noop },
    DocumentEngine: { downloadBlob: noop },
    DocumentStore: { openPicker: noop },
    AuditLog: { record: noop },
    NepaliLocale: {
      toEnglishDigits: s => String(s == null ? '' : s).replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966)),
      todayBs: () => ({ year: 2083, month: 4, day: 30 }),
    },
    showStatus: noop, friendlyDbError: e => String(e),
    document: { getElementById: id => els[id] || null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop, querySelectorAll: () => [], appendChild: noop, setAttribute: noop }), body: { appendChild: noop } },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    setTimeout, clearTimeout, confirm: () => true,
  };
  const driver = `
    globalThis.__en = {
      els: null,
      normDate: spbEnNormDate,
      nextBill: spbEnNextBill,
      sheet: spbEnSheet,
      usedKeys: spbEnUsedKeys,
      dirBuild: spbEnDirectoryBuild,
      suggest: spbEnSuggest,
      panMatches: spbEnPanMatches,
      blankRow: spbEnBlankRow,
      rowEmpty: spbEnRowEmpty,
      sectionAmountKeys: spbSectionAmountKeys,
      setRows(rows) { spbEnRows = rows; },
      rows() { return spbEnRows; },
      apply() { spbEnApplyBook(); return { data: spbData, book: spbBook, groups: spbGroups }; },
      seedFromBook() { spbEnRows = { sales: [], purchase: [] }; spbEnSeedFromBook(); return spbEnRows; },
      rowIssues(section, idx) { spbEnSection = section; return spbEnRowIssues(idx); },
      clearData() { spbData = null; spbBook = null; spbGroups = null; spbVr = null; },
    };
  `;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(utils + '\n' + core + '\n' + ledger + '\n' + entry + '\n' + driver,
    ctx, { filename: 'autobooks-entry-sandbox.js' });
  ctx.__en.els = els;
  return ctx.__en;
}

// ── Assertions ──────────────────────────────────────────────────────────────
let passed = 0; const failures = [];
function check(label, actual, expected, tol = 0) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const en = loadModules();
const FY = 2082;

console.log('\n── Date normalization ──');
check('full numeric date pads to canonical form', en.normDate('2082.4.1', FY).value, '2082.04.01');
check('slash and dash separators are accepted', en.normDate('2082/04-15', FY).value, '2082.04.15');
check('month.day borrows the year from the F.Y. (Shrawan side)', en.normDate('4.15', FY).value, '2082.04.15');
check('month.day borrows the year from the F.Y. (Chaitra→Ashadh side)', en.normDate('1.10', FY).value, '2083.01.10');
check('a bare day continues the row above', en.normDate('15', FY, '2082.05.02').value, '2082.05.15');
check('a bare day with no row above stays unread', en.normDate('15', FY).error, 'bad');
check('a month name resolves via the importer\'s own alias table', en.normDate('magh', FY).value, '2082.10.01');
check('a misspelled month still resolves ("Sharawan")', en.normDate('Sharawan', FY).value, '2082.04.01');
check('Devanagari month names resolve', en.normDate('भदौ', FY).value, '2082.05.01');
check('day + month name keeps the day', en.normDate('15 Baishakh', FY).value, '2083.01.15');
check('month name day is flagged approximate', en.normDate('magh', FY).approx, true);
check('fiscal index follows the B.S. month (Shrawan = 0)', en.normDate('2082.04.10', FY).fi, 0);
check('fiscal index follows the B.S. month (Ashadh = 11)', en.normDate('2083.03.30', FY).fi, 11);
check('nonsense is reported, never guessed', en.normDate('hello', FY).error, 'bad');
check('a month of 13 is rejected', en.normDate('2082.13.01', FY).error, 'bad');
check('blank stays blank', en.normDate('', FY).value, '');

console.log('\n── Bill sequencing (sales) ──');
check('a plain number counts on', en.nextBill('107'), '108');
check('zero-padding survives', en.nextBill('0012'), '0013');
check('a prefixed number keeps its prefix', en.nextBill('INV-45'), 'INV-46');
check('a non-numeric bill suggests nothing', en.nextBill('ABC'), '');
check('blank suggests nothing', en.nextBill(''), '');

console.log('\n── Synthetic sheet ──');
const rows = {
  sales: [
    { date: '2082.04.01', bill: '101', party: 'KOTHESWORI SUPPLIERS', pan: '123456789', taxfree: '', taxable: '10000', vat: '1300', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '2082.04.02', bill: '102', party: 'Kotheswori suppliers.', pan: '123456789', taxfree: '500', taxable: '20000', vat: '', imp: '', impVat: '', cap: '', capVat: '' },
    { date: 'bhadra', bill: '103', party: 'ARPIT TRADERS', pan: '222222222', taxfree: '', taxable: '5000', vat: '650', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '', bill: '', party: '', pan: '', taxfree: '', taxable: '', vat: '', imp: '', impVat: '', cap: '', capVat: '' },
  ],
  purchase: [
    { date: '2082.05.10', bill: 'P-9', party: 'GANGA TRADE LINK', pan: '333333333', taxfree: '', taxable: '40000', vat: '5200', imp: '', impVat: '', cap: '15000', capVat: '1950' },
  ],
};
const salesSheet = en.sheet(rows.sales, 'sales');
check('sales sheet carries the firm\'s seven columns', Object.keys(salesSheet.header.col).length, 7);
check('empty rows are excluded from the sheet', salesSheet.rows.length - 1, 3);
const purSheet = en.sheet(rows.purchase, 'purchase');
check('purchase sheet includes Capital columns when used', purSheet.header.col.cap != null && purSheet.header.col.capVat != null, true);
check('purchase sheet omits Import columns when unused', purSheet.header.col.imp == null && purSheet.header.col.impVat == null, true);
const purNoCap = en.sheet([{ ...rows.purchase[0], cap: '', capVat: '' }], 'purchase');
check('an all-zero Capital column is never invented', purNoCap.header.col.cap == null, true);

console.log('\n── Party directory ──');
const dir = en.dirBuild([
  { name: 'KOTHESWORI SUPPLIERS', pan: '123456789', weight: 3 },
  { name: 'Kotheswori suppliers.', pan: '123456789', weight: 1 },
  { name: 'KOTHESWORI SUPPLIERS', pan: '123456780', weight: 1 },   // one-row typo PAN
  { name: 'KRISHNA STORES', pan: '444444444', weight: 1 },
  { name: 'ARPIT TRADERS', pan: '222222222', weight: 2 },
  { name: 'ARPIT TRADERS', pan: '12345', weight: 5 },              // malformed PAN never counts
]);
check('same safeKey folds to one directory entry', dir.filter(e => e.safe.startsWith('KOTHESWORI')).length, 1);
const kot = dir.find(e => e.safe.startsWith('KOTHESWORI'));
check('the majority PAN wins over a one-row typo', kot.pan, '123456789');
check('the heavier spelling is the display spelling', kot.name, 'KOTHESWORI SUPPLIERS');
check('a malformed PAN never becomes the party\'s PAN', dir.find(e => e.safe.startsWith('ARPIT')).pan, '222222222');
const sug = en.suggest(dir, 'k', 8);
check('a single letter suggests by prefix', sug.length >= 2 && sug.every(e => e.name[0] === 'K'), true);
check('prefix ranking puts the heavier party first', en.suggest(dir, 'kot', 8)[0].name, 'KOTHESWORI SUPPLIERS');
check('word-start matches rank behind name-start ("sup")', en.suggest(dir, 'sup', 8)[0].safe.startsWith('KOTHESWORI'), true);
check('a full PAN resolves its party', en.panMatches(dir, '444444444', false)[0].name, 'KRISHNA STORES');
check('a PAN prefix offers candidates', en.panMatches(dir, '1234', true)[0].pan, '123456789');
check('a two-digit PAN prefix offers nothing (too little to mean anything)', en.panMatches(dir, '12', true).length, 0);

console.log('\n── Typed rows through the real pipeline ──');
en.clearData();
en.setRows(rows);
const out = en.apply();
check('sales rows parse to transactions', out.data.sales.txns.length, 3);
check('the section is marked as manually entered', out.data.sales.source, 'Manual entry');
check('a month-name date lands in its fiscal month', out.data.sales.txns[2].date, '2082.05.01');
check('a blank sales VAT fills at 13%', out.data.sales.txns[1].vat, 2600, 0.001);
check('a typed VAT is never touched', out.data.sales.txns[0].vat, 1300, 0.001);
check('Shrawan book taxable foots', out.book.sales[0].t, 30000, 0.001);
check('Bhadra book taxable foots', out.book.sales[1].t, 5000, 0.001);
check('two spellings of one party group together (safeKey)', out.groups.sales.length, 2);
const kotGroup = out.groups.sales.find(g => g.key.startsWith('KOTHESWORI'));
check('the merged group carries both bills', kotGroup.taxable, 30000, 0.001);
check('purchase capital stays a slice of its own column at entry', out.book.purchase[1].cap, 15000, 0.001);
check('the filed-return figure adds capital back', out.book.purchase[1].t + out.book.purchase[1].cap, 55000, 0.001);
check('value-driven workbook columns include Capital for this book', en.sectionAmountKeys('purchase').includes('cap'), true);
check('value-driven workbook columns exclude unused Import', en.sectionAmountKeys('purchase').includes('imp'), false);

console.log('\n── Round trip: book → sheet → book ──');
const reseeded = en.seedFromBook();
check('seeding recreates one row per transaction', reseeded.sales.length, 3);
check('seeded amounts render blank for zero', reseeded.sales[0].taxfree, '');
en.setRows(reseeded);
const out2 = en.apply();
check('figures survive the round trip (sales taxable)', out2.book.sales.reduce((a, m) => a + m.t, 0), 35000, 0.001);
check('figures survive the round trip (purchase VAT)', out2.book.purchase.reduce((a, m) => a + m.v, 0), 5200, 0.001);
check('figures survive the round trip (capital VAT)', out2.book.purchase.reduce((a, m) => a + m.capVat, 0), 1950, 0.001);

console.log('\n── Row validation ──');
en.setRows({
  sales: [
    { date: '2082.04.01', bill: '1', party: 'KOTHESWORI SUPPLIERS', pan: '123456789', taxfree: '', taxable: '1000', vat: '130', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '2082.04.02', bill: '2', party: 'KOTHESWORI SUPPLIERS', pan: '987654321', taxfree: '', taxable: '1000', vat: '130', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '2082.04.03', bill: '3', party: 'NEW PARTY', pan: '12345678', taxfree: '', taxable: '1000', vat: '999', imp: '', impVat: '', cap: '', capVat: '' },
    { date: 'garbage', bill: '4', party: 'X', pan: '', taxfree: '', taxable: '1000', vat: '130', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '2081.04.01', bill: '5', party: 'Y', pan: '', taxfree: '', taxable: '1000', vat: '130', imp: '', impVat: '', cap: '', capVat: '' },
  ], purchase: [],
});
check('a PAN contradicting the party\'s established PAN is an error',
  en.rowIssues('sales', 1).some(x => x.level === 'err' && x.k === 'pan'), true);
check('an 8-digit PAN warns', en.rowIssues('sales', 2).some(x => x.k === 'pan' && x.level === 'warn'), true);
check('a VAT off 13% warns with the expected figure',
  en.rowIssues('sales', 2).some(x => x.k === 'vat' && /expected 130\.00/.test(x.msg)), true);
check('an unreadable date is an error', en.rowIssues('sales', 3).some(x => x.k === 'date' && x.level === 'err'), true);
check('a date outside the F.Y. warns', en.rowIssues('sales', 4).some(x => x.k === 'date' && x.level === 'warn'), true);
check('a clean row raises nothing', en.rowIssues('sales', 0).length, 0);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
