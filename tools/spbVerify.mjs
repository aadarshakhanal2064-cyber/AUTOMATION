// ════════════════════════════════════════════
//  AUTOBOOKS VERIFICATION HARNESS
//
//  Runs the REAL js/salesPurchaseBook.js parsing pipeline headlessly against a
//  client workbook and asserts the figures it produces.
//
//  Why this file exists: the module's own comments referred to "the
//  verification harness" that exercised spbParseRows headlessly — but that
//  harness was never committed. It defined a `stringSimilarity` helper the
//  browser never had, so the module shipped calling an undefined global and
//  threw on the first "TOTAL OF <MONTH>" row of every import. Committing the
//  harness is the fix for the root cause, not just for the symptom.
//
//  Dependency-free on purpose (the app has no package.json): the XLSX reader
//  below is a minimal zip + SpreadsheetML parser, enough for the raw books
//  this module consumes.
//
//  Usage:
//    node tools/spbVerify.mjs                      # run the built-in cases
//    node tools/spbVerify.mjs "path/to/book.xlsx"  # inspect any workbook
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Minimal .xlsx reader ────────────────────────────────────────────────────
function unzip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error(`${file} is not a zip/xlsx`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      lho: buf.readUInt32LE(p + 42), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return name => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    const data = buf.subarray(start, start + e.csize);
    return e.method === 0 ? data : zlib.inflateRawSync(data);
  };
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Returns { sheets: [{ name, rows }] } where rows mirrors what SheetJS's
// sheet_to_json({ header: 1, defval: null }) hands the module in the browser.
export function readWorkbook(file) {
  const z = unzip(file);
  const shared = [];
  const ssXml = (z('xl/sharedStrings.xml') || Buffer.alloc(0)).toString();
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(unesc(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')));
  }
  const relTargets = new Map();
  for (const m of (z('xl/_rels/workbook.xml.rels') || Buffer.alloc(0)).toString()
    .matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relTargets.set(m[1], m[2]);

  const sheets = [];
  for (const m of z('xl/workbook.xml').toString().matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = (relTargets.get(m[2]) || '').replace(/^\/?xl\//, '');
    sheets.push({ name: unesc(m[1]), rows: readSheet(z('xl/' + target), shared) });
  }
  return { sheets };
}

function readSheet(buf, shared) {
  if (!buf) return [];
  const xml = buf.toString();
  const cells = new Map();
  let maxRow = 0, maxCol = 0;
  // Cells and rows may be self-closing, so each pattern needs both forms.
  for (const rowXml of xml.match(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g) || []) {
    const rn = Number((rowXml.match(/^<row[^>]*\sr="(\d+)"/) || [])[1]);
    if (!rn) continue;
    for (const cellXml of rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (cellXml.match(/\sr="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const t = (cellXml.match(/\st="(\w+)"/) || [])[1];
      const raw = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value;
      if (t === 'inlineStr') value = unesc((cellXml.match(/<is>([\s\S]*?)<\/is>/) || [''])[1].replace(/<[^>]+>/g, ''));
      else if (raw === undefined) continue;
      else if (t === 's') value = shared[+raw];
      else if (t === 'str' || t === 'e') value = unesc(raw);
      else value = parseFloat(raw);
      const c = colIndex(ref);
      cells.set(rn + ':' + c, value);
      maxRow = Math.max(maxRow, rn); maxCol = Math.max(maxCol, c);
    }
  }
  const out = [];
  for (let r = 1; r <= maxRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) { const v = cells.get(r + ':' + c); row.push(v === undefined ? null : v); }
    out.push(row);
  }
  return out;
}
// ── Load the real module into a sandbox ─────────────────────────────────────
export function loadModule() {
  const utils = fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8');
  // The client-scope wiring at the bottom touches DOM/engines at load time and
  // has nothing to do with parsing; everything above it is what we exercise.
  const spb = fs.readFileSync(path.join(ROOT, 'js/salesPurchaseBook.js'), 'utf8')
    .replace(/^\/\/ ── Client search \+ FY change wiring[\s\S]*$/m, '');

  const noop = () => {};
  // Only the form fields the parsing path reads. Exposed so a case can flip
  // the client's registration type the way the select on the page does.
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
    AuditLog: { record: noop },
    NepaliLocale: {
      // Only the two members the parsing path uses.
      toEnglishDigits: s => String(s == null ? '' : s).replace(/[\u0966-\u096F]/g, d => String(d.charCodeAt(0) - 0x0966)),
      todayBs: () => ({ year: 2083, month: 4, day: 30 }),
    },
    showStatus: noop,
    document: { getElementById: id => els[id] || null, addEventListener: noop },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    setTimeout, clearTimeout,
  };
  // The module's state lives in top-level `let` bindings, which a separately
  // evaluated script cannot reach. Appending the driver to the same source is
  // what puts it inside that scope — and it means the harness runs the REAL
  // spbReparse sequence rather than a re-implementation of it. Everything
  // below the parse (rendering) is DOM work and is deliberately skipped.
  const driver = `
    globalThis.__spb = {
      findHeader: spbFindHeader,
      parseRows: spbParseRows,
      vrModel: spbVrModel,
      returnTaxable: spbReturnTaxable,
      bookLayout: spbBookLayout,
      runImport(raw, fyStart) {
        spbRaw = raw;
        spbOverrides = { sales: {}, purchase: {} };
        spbCorrectionLog = []; spbDismissed = new Set(); spbAutoUndone = new Set();
        spbMergeMap = {}; spbVr = spbBlankVr();
        spbParseAll(fyStart);
        const auto = spbAutoFix();
        if (auto) spbParseAll(fyStart);
        spbBook = spbComputeBook();
        spbChecksums = spbComputeChecksums();
        spbGroups = spbComputeGroups();
        spbSuggestions = spbBuildSuggestions();
        spbBuildIssues();
        return {
          data: spbData, book: spbBook, checksums: spbChecksums, groups: spbGroups,
          autoApplied: auto, corrections: spbCorrectionLog, issues: spbIssues, tie: spbTieOut(),
        };
      },
    };
  `;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(utils + '\n' + spb + '\n' + driver, ctx, { filename: 'autobooks-sandbox.js' });
  ctx.__spb.els = els;
  return ctx.__spb;
}

// ── Assertions ──────────────────────────────────────────────────────────────
let passed = 0; const failures = [];
function check(label, actual, expected, tol = 0) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}\n      expected ${expected}\n      actual   ${actual}`); }
}

// Mirrors spbClassifySheet: derived sheet names are skipped so a generated
// workbook can be re-fed to the harness the way the app allows re-upload.
function sheetsByKind(wbFile) {
  const out = {};
  for (const s of readWorkbook(wbFile).sheets) {
    if (/summary|detail|monthly|correction/i.test(s.name)) continue;
    const kind = /sales|bikri/i.test(s.name) ? 'sales' : /purchase|kharid/i.test(s.name) ? 'purchase' : null;
    if (kind && !out[kind]) out[kind] = s;
  }
  return out;
}

// ── The case: the client book that exposed every one of these bugs ──────────
const CASE_FILE = process.argv[2]
  || 'G:/My Drive/Aadarsha/Jaya Shree Mahalaxmi Traders 2082.83/Data entry.xlsx';

function run() {
  if (!fs.existsSync(CASE_FILE)) {
    console.log(`SKIP — client file not available on this machine:\n  ${CASE_FILE}`);
    return 0;
  }
  const spb = loadModule();
  console.log(`Autobooks harness — ${path.basename(CASE_FILE)}\n`);

  const sheets = sheetsByKind(CASE_FILE);
  const raw = {};
  for (const kind of ['sales', 'purchase']) {
    if (!sheets[kind]) { failures.push(`${kind}: sheet not found`); continue; }
    const header = spb.findHeader(sheets[kind].rows);
    if (!header) { failures.push(`${kind}: header not recognized`); continue; }
    raw[kind] = { rows: sheets[kind].rows, header, source: path.basename(CASE_FILE) + ' → ' + sheets[kind].name };
  }
  const out = spb.runImport({ sales: raw.sales || null, purchase: raw.purchase || null }, 2082);
  const p = out.data.purchase, s = out.data.sales;
  const sum = (r, k) => Math.round(r.txns.reduce((a, x) => a + (x[k] || 0), 0) * 100) / 100;

  console.log('Purchase');
  check('45 transactions (the BHARDA row is recovered)', p.txns.length, 45);
  check('taxable ties to the firm\'s reconciled Grand Total', sum(p, 'taxable'), 66791457, 0.01);
  check('no phantom bad-date rows', p.stats.badDates.length, 0);
  check('12 embedded subtotals stripped', p.stats.subtotalsStripped, 12);
  check('all 12 purchase checksums match the client\'s own subtotals',
    out.checksums.purchase.mismatches, 0);

  console.log('\nSales');
  check('264 transactions', s.txns.length, 264);
  check('taxable unchanged', sum(s, 'taxable'), 73802436.6, 0.01);
  check('VAT unchanged', sum(s, 'vat'), 9594316.76, 0.01);
  check('no phantom bad-date rows', s.stats.badDates.length, 0);
  check('non-numeric amount cells reported', s.stats.nonNumeric.length >= 3, true);
  check('12 subtotals resolve to 12 DISTINCT months',
    new Set(s.stats.embeddedSubtotals.map(x => x.fi)).size, 12);
  check('the mislabelled row 31 is detected',
    s.stats.embeddedSubtotals.some(x => x.labelFi >= 0 && x.blockFi >= 0 && x.labelFi !== x.blockFi), true);

  console.log('\nParty identity');
  const names = k => (out.groups[k] || []).map(g => g.display);
  check('Dipika Trade link is ONE party, not split by a mistyped PAN',
    names('sales').filter(n => /dipika/i.test(n)).length, 1);
  check('Arpit Traders / Arpit Trades collapse to one',
    names('sales').filter(n => /^arpit/i.test(n)).length, 1);
  check('Shreeganga And Sons Trader(s) collapse to one',
    names('sales').filter(n => /shreeganga/i.test(n)).length, 1);
  check('every auto-correction is in the log for the Corrections sheet',
    out.corrections.filter(c => c.auto).length, out.autoApplied);
  check('an autoFix card is shown so nothing is corrected invisibly',
    out.issues.some(i => i.type === 'autoFix'), true);

  console.log('\nInternal tie-out');
  check('transactions, groups and monthly totals agree across every column',
    out.tie.ok ? 'ok' : out.tie.problems.join(' | '), 'ok');

  runTemplateShapeCase(spb);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

// ── The data-entry format, round-tripped ────────────────────────────────────
// The template's own column set, filled the way a staff member would, fed
// straight back through the importer. ExcelJS can't run here (no npm at the
// app level), so this exercises the shape rather than the generated file; the
// generated .xlsx itself is checked in the browser.
function runTemplateShapeCase(spb) {
  console.log('\nData-entry format round-trip');
  const purchase = [
    ['Date', 'Bill No.', 'Party Name', 'Pan No.', 'Tax Free', 'Taxable Amount', 'Vat', 'Taxable Import', 'Import VAT', 'Capital Purchase', 'Capital VAT'],
    ['Shrawan', 1, 'Domestic Supplier Pvt.Ltd.', '610402311', 0, 100000, null, 0, 0, 0, 0],   // blank VAT → filled at 13%
    ['Shrawan', 2, 'Unregistered Vendor', '303364692', 50000, 0, 0, 0, 0, 0, 0],
    ['Bhadra', 3, 'Overseas Importer Pvt.Ltd.', '609804104', 0, 0, 0, 200000, 26000, 0, 0],
    ['Bhadra', 4, 'Machinery House Pvt.Ltd.', '620436511', 0, 0, 0, 0, 0, 400000, 52000],
    [null, null, null, null, null, null, 0, null, 0, null, 0],                                // the template's trailing formula rows
    [null, null, null, null, null, null, 0, null, 0, null, 0],
  ];
  const sales = [
    ['Date', 'Bill No.', 'Party Name', 'Pan No.', 'Tax Free', 'Taxable Amount', 'Vat'],
    ['Shrawan', 1, 'Retail Buyer', '121504845', 0, 300000, 0],
    ['Bhadra', 2, 'Retail Buyer', '121504845', 0, 150000, 0],
  ];
  const hp = spb.findHeader(purchase), hs = spb.findHeader(sales);
  check('every template column is recognized',
    hp && ['date', 'bill', 'party', 'pan', 'taxfree', 'taxable', 'vat', 'imp', 'impVat', 'cap', 'capVat']
      .every(k => hp.col[k] != null), true);

  // A PAN-only client: no VAT on sales, 13% on purchases.
  spb.els['spb-regtype'].value = 'pan';
  const out = spb.runImport({
    sales: { rows: sales, header: hs, source: 'template → Sales' },
    purchase: { rows: purchase, header: hp, source: 'template → Purchase' },
  }, 2082);
  const p = out.data.purchase;
  check('the template\'s trailing formula rows are not imported', p.txns.length, 4);
  check('blank VAT filled at 13%', p.txns[0].vat, 13000, 0.001);
  check('the fill is reported, not silent', p.stats.vatFilled.length, 1);
  check('tax free stays out of taxable', p.txns[1].taxfree, 50000);
  check('taxable import lands in its own box', p.txns[2].imp, 200000);
  check('capital purchase lands in its own box', p.txns[3].cap, 400000);

  const shrawan = out.book.purchase[0], bhadra = out.book.purchase[1];
  check('Shrawan book taxable is the domestic figure alone', shrawan.t, 100000);
  check('Bhadra book keeps capital separate at entry', bhadra.cap, 400000);
  check('capital is ADDED to taxable for the filed return', spb.returnTaxable(bhadra), 400000);
  check('import is NOT folded into taxable', spb.returnTaxable(bhadra) - bhadra.cap, 0);

  const M = spb.vrModel('purchase');
  check('the purchase reconciliation compares Taxable Import as its own box',
    M.cols.some(c => c.id === 'imp'), true);
  check('capital is shown as a memo column, never compared twice',
    M.memo.map(c => c.id).join(',') + '|' + M.cols.some(c => c.id === 'cap'), 'cap,capVat|false');
  check('sales keeps the firm\'s original three columns',
    spb.vrModel('sales').cols.map(c => c.id).join(','), 't,v,f');
  check('the purchase book sheet carries all eleven columns',
    spb.bookLayout('purchase').headers.length, 11);
  check('the sales book sheet is unchanged at seven',
    spb.bookLayout('sales').headers.length, 7);
  check('a PAN-only client\'s sales VAT is not auto-filled', out.data.sales.stats.vatFilled.length, 0);
  check('tie-out holds with the new columns populated',
    out.tie.ok ? 'ok' : out.tie.problems.join(' | '), 'ok');
  spb.els['spb-regtype'].value = 'vat';
}

process.exit(run());
