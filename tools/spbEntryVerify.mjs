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
      setRows(rows) { spbEnRows = rows; spbEnInvalidate(); },
      rows() { return spbEnRows; },
      apply() { spbEnApplyBook(); return { data: spbData, book: spbBook, groups: spbGroups }; },
      seedFromBook() { spbEnRows = { sales: [], purchase: [] }; spbEnSeedFromBook(); return spbEnRows; },
      rowIssues(section, idx) { spbEnSection = section; return spbEnRowIssues(idx); },
      billKey: spbEnBillKey,
      rowsFromSheet: spbEnRowsFromSheet,
      atStart: spbEnCaretAtStart,
      atEnd: spbEnCaretAtEnd,
      dupMap: spbEnDupMap,
      dupFindings: spbEnDupFindings,
      rowLabel: spbEnRowLabel,
      tsv: spbEnTsv,
      parseTsv: spbEnParseTsv,
      headerRow: spbEnTsvHeaderRow,
      fillValue: spbEnFillValue,
      writeCell(rows, idx, k, v) { spbEnRows = rows; spbEnSection = 'sales'; spbEnWriteCell(idx, k, v); return spbEnRows; },
      snap: (s) => spbEnSnap(s),
      pushUndo: (b) => spbEnPushUndo(b),
      undo: () => spbEnUndo(),
      redo: () => spbEnRedo(),
      clearUndo: () => spbEnClearUndo(),
      stacks: () => ({ undo: spbEnUndoStack.length, redo: spbEnRedoStack.length }),
      section(s) { if (s) spbEnSection = s; return spbEnSection; },
      autofillPairs: (idxs) => spbEnAutofillPairs(idxs),
      wakeSpare: (idx, k) => spbEnWakeSpare(idx, k),
      rowInert: (r) => spbEnRowInert(r),
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

console.log('\n── Duplicate bill numbers — opposite rules per register ──');
// The firm's own rule: a SALES bill number is the firm's invoice number and
// runs once for the whole year, whoever the customer is; a PURCHASE bill
// number is written by the supplier, so two suppliers sharing one is normal.
const mk = (date, bill, party, taxable) => ({
  ...en.blankRow(), date, bill, party, pan: '', taxable: String(taxable), vat: '',
});
const dupRows = [
  mk('2082.04.01', '1', 'Hanuman Supplier', 1000),
  mk('2082.04.02', '2', 'Hanuman Supplier', 2000),
  mk('2082.05.01', '1', 'Lateswori Supplier', 3000),   // sales: clash · purchase: fine
  mk('2082.05.02', '3', 'Hanuman Supplier', 4000),
];
const salesDup = en.dupFindings(dupRows, 'sales', FY);
const purDup = en.dupFindings(dupRows, 'purchase', FY);
check('SALES: one bill no. on two parties is flagged', salesDup.size, 2);
check('SALES: the flag is an error, not a hint', salesDup.get(0).level, 'err');
check('SALES: the message names the other party', /Lateswori Supplier/.test(salesDup.get(0).msg), true);
check('SALES: the message names the month and row', /Bhadra, row 1/.test(salesDup.get(0).msg), true);
check('PURCHASE: two suppliers sharing bill no. 1 is NOT flagged', purDup.size, 0);

const sameSupplier = [
  mk('2082.04.01', '7', 'Hanuman Supplier', 1000),
  mk('2082.04.09', '7', 'Hanuman Supplier', 5000),
];
check('PURCHASE: the SAME supplier billing 7 twice is flagged', en.dupFindings(sameSupplier, 'purchase', FY).size, 2);
check('PURCHASE: same-supplier repeat warns rather than errors',
  en.dupFindings(sameSupplier, 'purchase', FY).get(0).level, 'warn');
check('SALES: same party, same bill, same amount reads as entered twice',
  /entered twice/.test(en.dupFindings([mk('2082.04.01', '9', 'A', 500), mk('2082.04.02', '9', 'A', 500)], 'sales', FY).get(0).msg), true);
check('SALES: same bill, different amount is named as a reused number',
  /used again/.test(en.dupFindings([mk('2082.04.01', '9', 'A', 500), mk('2082.04.02', '9', 'A', 700)], 'sales', FY).get(0).msg), true);
check('a differing amount no longer hides a clash (the old key included it)',
  en.dupFindings([mk('2082.04.01', '4', 'A', 100), mk('2082.04.02', '4', 'B', 999)], 'sales', FY).size, 2);
check('blank bill numbers are never duplicates of each other',
  en.dupFindings([mk('2082.04.01', '', 'A', 100), mk('2082.04.02', '', 'B', 100)], 'sales', FY).size, 0);
check('"0012" and "12" are read as one bill number', en.billKey('0012'), en.billKey('12'));
check('a prefix keeps two series apart', en.billKey('A/1') === en.billKey('B/1'), false);
check('inert rows (date/bill only) never raise a duplicate',
  en.dupFindings([mk('2082.04.01', '5', 'A', 100), { ...en.blankRow(), date: '2082.04.02', bill: '5' }], 'sales', FY).size, 0);

console.log('\n── Row labels (what the finding points at) ──');
const lblRows = [
  mk('2082.04.01', '1', 'A', 1), mk('2082.05.01', '2', 'B', 1),
  mk('2082.05.02', '3', 'C', 1), mk('2082.04.02', '4', 'D', 1),
];
check('a row is labelled by its own month', en.rowLabel(lblRows, 1, FY).month, 'Bhadra');
check('the row number counts within that month', en.rowLabel(lblRows, 2, FY).n, 2);
check('a second Shrawan row is Shrawan row 2', en.rowLabel(lblRows, 3, FY).n, 2);
check('an undated row is labelled as such', en.rowLabel([mk('', '1', 'A', 1)], 0, FY).month, 'no date');

console.log('\n── Duplicates reach the row itself ──');
en.setRows({ sales: dupRows, purchase: dupRows });
check('the Bill cell carries the duplicate finding',
  en.rowIssues('sales', 0).some(x => x.k === 'bill' && x.level === 'err'), true);
// The regression that matters: the sales findings were just cached, and the
// purchase sheet must not be handed them — the two rules are opposites, so a
// stale cache would flag every supplier who shares a bill number.
check('switching to Purchase does not inherit the Sales duplicate ruling',
  en.rowIssues('purchase', 0).some(x => x.k === 'bill'), false);
check('and switching back still flags Sales',
  en.rowIssues('sales', 0).some(x => x.k === 'bill'), true);

console.log('\n── Excel file → grid rows (the mistake-hunting import) ──');
// Deliberately NOT spbParseRows: the parser excludes what it cannot read,
// and those rows are exactly what this import exists to show.
const sheetHeader = { row: 1, col: { date: 0, bill: 1, party: 2, pan: 3, taxfree: 4, taxable: 5, vat: 6 } };
const sheetRows = [
  ['Some Client Pvt. Ltd.', null, null, null, null, null, null],       // title line above the header
  ['Date', 'Bill No.', 'Party Name', 'Pan No.', 'Tax Free', 'Taxable Amount', 'Vat'],
  ['2082.4.1', '1', 'Khudra Sales', null, 0, 15300, 1989],
  ['garbage-date', '2', 'Khudra Sales', null, 0, 10200, 1326],         // must SURVIVE, raw
  [null, null, 'Total Of Shrawan', null, 0, 25500, 3315],              // embedded subtotal — skipped
  ['bhadra', '3', 'Om Fiber Glass', '६०८८६९३४२', 0, 5000, null],       // month name + Devanagari PAN
  [null, null, null, null, 0, 0, 0],                                   // formula leftover — skipped
  ['2082.05.09', '4', 'Shrestha Hardware', '30185437', 0, 'here', 650], // 8-digit PAN + text amount
];
const imp = en.rowsFromSheet(sheetRows, sheetHeader, FY);
check('every live data row lands in the grid', imp.rows.length, 4);
check('the embedded month subtotal is skipped and counted', imp.subtotals, 1);
check('the formula leftover is skipped as blank', imp.blanks, 1);
check('a readable date is normalized', imp.rows[0].date, '2082.04.01');
check('an unreadable date is kept RAW for the grid to flag', imp.rows[1].date, 'garbage-date');
check('a month-name date resolves with the year from the F.Y.', imp.rows[2].date, '2082.05.01');
check('a Devanagari PAN is normalized to digits', imp.rows[2].pan, '608869342');
check('a malformed PAN is kept for the grid to flag', imp.rows[3].pan, '30185437');
check('text typed into an amount column is kept visible', imp.rows[3].taxable, 'here');
check('a genuine zero renders blank, the seeding rule', imp.rows[0].taxfree, '');
check('amounts keep their figures as strings', imp.rows[0].taxable, '15300');
check('a blank VAT stays blank (the apply pass fills it)', imp.rows[2].vat, '');

console.log('\n── Imported rows through the real pipeline ──');
en.clearData();
en.setRows({ sales: imp.rows, purchase: [] });
const impOut = en.apply();
// The parser drops the garbage-date row and reads 'here' as 0 — the BOOK is
// clean while the GRID still shows both mistakes. That split is the design.
check('the clean book excludes only the unreadable-date row', impOut.data.sales.txns.length, 3);
check('…and reports it', impOut.data.sales.stats.badDates.length, 1);
check('the text amount reads as 0 in the book and is reported', impOut.data.sales.stats.nonNumeric.length, 1);
check('the grid still holds all 4 rows for fixing', en.rows().sales.length, 4);

console.log('\n── Arrow keys: navigate vs edit text ──');
// ← and → move a cell only when the caret has nowhere left to travel — or
// when the whole value is selected, which is how a cell just arrowed into
// sits (Excel moves straight out of such a cell).
const cell = (value, ss, se) => ({ value, selectionStart: ss, selectionEnd: se });
check('caret at the very start navigates left', en.atStart(cell('12345', 0, 0)), true);
check('caret mid-text does NOT navigate left', en.atStart(cell('12345', 2, 2)), false);
check('caret at the very end navigates right', en.atEnd(cell('12345', 5, 5)), true);
check('caret mid-text does NOT navigate right', en.atEnd(cell('12345', 3, 3)), false);
check('a fully-selected cell navigates left', en.atStart(cell('12345', 0, 5)), true);
check('a fully-selected cell navigates right', en.atEnd(cell('12345', 0, 5)), true);
check('a partial selection does not navigate', en.atEnd(cell('12345', 1, 3)), false);
check('an empty cell navigates either way',
  en.atStart(cell('', 0, 0)) && en.atEnd(cell('', 0, 0)), true);

console.log('\n── Excel interchange: TSV both ways ──');
// Copy writes the tab-separated form Excel itself uses; paste reads the same
// form back, including Excel's \r\n line ends and its one trailing newline.
check('a rectangle round-trips through TSV',
  JSON.stringify(en.parseTsv(en.tsv([['2082.04.01', '1', 'HANUMAN'], ['2082.04.02', '2', 'LATESWORI']]))),
  JSON.stringify([['2082.04.01', '1', 'HANUMAN'], ['2082.04.02', '2', 'LATESWORI']]));
check('Excel\'s \\r\\n line ends parse', en.parseTsv('a\tb\r\nc\td').length, 2);
check('Excel\'s trailing newline is framing, not a row', en.parseTsv('a\tb\nc\td\n').length, 2);
check('a plain single value is NOT a block (native paste keeps it)', en.parseTsv('HANUMAN'), null);
check('a single column of lines IS a block', en.parseTsv('100\n200\n300').length, 3);
check('empty text is not a block', en.parseTsv(''), null);
check('cells keep embedded spaces', en.parseTsv('a b\tc d')[0][1], 'c d');
check('the Copy-view header row is recognized…', en.headerRow(['Date', 'Bill No.', 'Party Name']), true);
check('…case-insensitively', en.headerRow(['date', 'bill no.']), true);
check('a data row is not mistaken for a header', en.headerRow(['2082.04.01', '107']), false);
check('an amount-first row is not a header', en.headerRow(['Date of supply', 'x']), false);

console.log('\n── Fill values: bills count on, everything else copies ──');
check('a bill number steps once per row', en.fillValue('107', 'bill', 3), '110');
check('zero-padding survives the series', en.fillValue('0098', 'bill', 5), '0103');
check('a prefixed bill keeps its prefix', en.fillValue('INV-45', 'bill', 2), 'INV-47');
check('a non-numeric bill copies verbatim', en.fillValue('ABC', 'bill', 4), 'ABC');
check('a date copies, never day-steps', en.fillValue('2082.04.15', 'date', 3), '2082.04.15');
check('a party copies verbatim', en.fillValue('HANUMAN SUPPLIER', 'party', 2), 'HANUMAN SUPPLIER');
check('an amount copies verbatim', en.fillValue('1,500.50', 'taxable', 9), '1,500.50');
check('step 0 is the value itself', en.fillValue('107', 'bill', 0), '107');

console.log('\n── Bulk writes go through the same normalization as typing ──');
{
  const rows = { sales: [
    { date: '2082.04.10', bill: '1', party: 'A', pan: '', taxfree: '', taxable: '100', vat: '', imp: '', impVat: '', cap: '', capVat: '' },
    { date: '', bill: '', party: '', pan: '', taxfree: '', taxable: '', vat: '', imp: '', impVat: '', cap: '', capVat: '' },
  ], purchase: [] };
  en.writeCell(rows, 1, 'date', '15');
  check('a pasted bare day continues the row above', rows.sales[1].date, '2082.04.15');
  en.writeCell(rows, 1, 'pan', ' ६०१२३४५६७ ');
  check('a pasted PAN is normalized (Devanagari, whitespace)', rows.sales[1].pan, '601234567');
  en.writeCell(rows, 1, 'date', 'garbage!!');
  check('an unreadable pasted date is kept raw for the red flag', rows.sales[1].date, 'garbage!!');
  en.writeCell(rows, 1, 'party', '  Hanuman ');
  check('a pasted party is stored as given (trim is the parser\'s job)', rows.sales[1].party, '  Hanuman ');
}

console.log('\n── Bulk writes behave like typing (2026-08-31 adversarial pass) ──');
{
  const mk = (over) => Object.assign(en.blankRow(), over);
  en.section('sales');
  let rows = { sales: [mk({})], purchase: [] };
  en.writeCell(rows, 0, 'taxable', '१२३४');
  check('a Devanagari amount folds to English on a bulk write', rows.sales[0].taxable, '1234');
  en.writeCell(rows, 0, 'bill', '४५');
  check('a Devanagari bill number folds too', rows.sales[0].bill, '45');
  en.writeCell(rows, 0, 'party', 'श्री ट्रेडर्स १');
  check('a party NAME keeps its script', rows.sales[0].party, 'श्री ट्रेडर्स १');
  en.setRows({ sales: [
    mk({ date: '2082.04.01', bill: '1', party: 'A', taxable: '5000' }),
    mk({ date: '2082.04.02', bill: '2', party: 'B', taxable: '6000', vat: '111' }),
    mk({ date: '2082.04.03', bill: '3', party: 'C', cap: '1000' }),
    mk({}),
  ], purchase: [] });
  en.autofillPairs([0, 1, 2, 3]);
  const s2 = en.rows().sales;
  check('a blank VAT beside a pasted taxable completes at 13%', s2[0].vat, '650');
  check('…stamped auto so a later base correction carries it', !!(s2[0]._auto && s2[0]._auto.vat), true);
  check('a VAT the paste itself carried stays untouched', s2[1].vat, '111');
  check('a capital purchase completes its own VAT column', s2[2].capVat, '130');
  check('an inert row is not woken by the autofill', en.rowInert(s2[3]), true);
  en.setRows({ sales: [
    mk({ date: '2082.04.10', bill: '7', party: 'A', taxable: '100' }),
    mk({ party: 'PICKED PARTY' }),
  ], purchase: [] });
  en.wakeSpare(1, 'party');
  check('picking a party on a blank row carries the date in', en.rows().sales[1].date, '2082.04.10');
  check('…and counts the sales bill on', en.rows().sales[1].bill, '8');
}

console.log('\n── Undo / redo: snapshots restore, redo forks correctly ──');
{
  const mk = (bill, taxable) => ({ ...en.blankRow(), date: '2082.04.01', bill, party: 'P', taxable });
  en.clearUndo();
  en.section('sales');
  en.setRows({ sales: [mk('1', '100')], purchase: [] });
  // edit 1: change the amount (snapshot before, mutate, push)
  let before = en.snap('sales');
  en.rows().sales[0].taxable = '999';
  en.pushUndo(before);
  // edit 2: add a row
  before = en.snap('sales');
  en.rows().sales.push(mk('2', '200'));
  en.pushUndo(before);
  check('two edits stack two undo steps', en.stacks().undo, 2);
  en.undo();
  check('undo removes the added row', en.rows().sales.length, 1);
  check('…and keeps the earlier edit', en.rows().sales[0].taxable, '999');
  en.undo();
  check('a second undo restores the original amount', en.rows().sales[0].taxable, '100');
  check('both steps now sit on the redo side', en.stacks().redo, 2);
  en.redo();
  check('redo re-applies the amount edit', en.rows().sales[0].taxable, '999');
  en.redo();
  check('redo re-adds the row', en.rows().sales.length, 2);
  en.undo();
  before = en.snap('sales');
  en.rows().sales[0].party = 'Q';
  en.pushUndo(before);
  check('a fresh edit after undo forks history (redo cleared)', en.stacks().redo, 0);
  check('undo on an empty stack is a safe no-op', (en.clearUndo(), en.undo(), en.rows().sales.length), 1);
  check('history clones are independent of the live rows',
    (() => { before = en.snap('sales'); en.rows().sales[0].party = 'MUTATED'; return before.rows[0].party; })(), 'Q');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
