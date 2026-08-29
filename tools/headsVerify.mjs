// ════════════════════════════════════════════════════════════════════════
//  ACCOUNT-HEAD RECOGNITION — verification harness
//
//  The firm's NFRS workbooks are hand-maintained and every engine that reads
//  them locates figures BY LABEL. That vocabulary lives in one place —
//  js/core/workbookReader.js `HEADS` — and this harness is what keeps it
//  honest. Three things are proved:
//
//   1. THE SPELLING MATRIX. Every wording the firm's real files use must
//      match its head, and the near-misses that must NOT match (a "Capital
//      Work in Progress" asset row, a "Permanent Working Capital Loan"
//      facility) must stay unmatched. A head regex that quietly widened is
//      how a parser starts reading the wrong row.
//
//   2. THE ROUND TRIP — the reason this file exists. The app WRITES these
//      statements and then READS them back the following year, so any
//      wording finStatementExport can print must be readable by every
//      parser. It has now failed twice in that exact shape: the Provisional
//      module began printing "Proprietors Capital" for a proprietorship
//      (2026-08-28) and Projection Report, still matching /share capital/
//      alone, read a nil capital off a file this app had generated itself
//      and refused the upload.
//
//   3. THE REAL CORPUS (optional). Point CORPUS at a directory of real
//      statement workbooks and every one is run through BOTH parsers, with
//      any head they cannot find reported. Client files are never in this
//      repo (CLAUDE.md §1 rule 7), so this half is skipped when the
//      directory is absent — the matrix above runs regardless.
//
//  Run:  node tools/headsVerify.mjs
//        CORPUS="G:/My Drive/2082.83/Bank/Provisional" node tools/headsVerify.mjs
//  Run it BEFORE and AFTER any change to HEADS or to either parser.
// ════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WR = require(path.join(ROOT, 'js', 'core', 'workbookReader.js'));
const Fin = require(path.join(ROOT, 'js', 'finStatementEngine.js'));
const Proj = require(path.join(ROOT, 'js', 'projectionEngine.js'));
const { HEADS, norm } = WR;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || detail == null ? '' : `   ${detail}`}`);
};

// ── 1. the spelling matrix ────────────────────────────────────────────────
// `yes` must match, `no` must not. The `no` column is not padding: each entry
// is a label that really appears in these workbooks somewhere else.
const MATRIX = [
  ['capital', {
    yes: [
      'Share Capital', 'share capital', 'Paid-Up Share Capital',
      'Proprietors Capital', "Proprietor's Capital", 'Proprietor Capital',
      'Partners Capital', "Partners' Capital", 'Partner Capital',
      'Promoters Capital', "Owner's Capital", 'Capital', 'Capital Account',
    ],
    no: [
      'Capital Work in Progress', 'Permanent Working Capital Loan',
      'Capital Introduced During the year', 'Additional Capital',
      'Capital Purchase', 'Working Capital',
    ],
  }],
  ['reserves', { yes: ['Reserves', 'Reserve & Surplus'], no: ['Total Equity', 'Provisions'] }],
  ['ppe', {
    yes: ['Property, Plant and Equipment', 'Property Plant & Equipment', 'Plant and Equipment'],
    no: ['Total Non-Current Assets', 'Investments'],
  }],
  ['inventories', { yes: ['Inventories', 'Inventory'], no: ['Trade and Other Receivables'] }],
  ['receivables', {
    yes: ['Trade and Other Receivables', 'Trade & Other Receivables'],
    no: ['Other Receivables', 'Trade & Other Payables'],
  }],
  ['payables', {
    yes: ['Trade and Other Payables', 'Trade & Other Payables'],
    no: ['Trade and Other Receivables', 'Audit Fee Payable'],
  }],
  ['cash', {
    yes: ['Cash and Cash Equivalents', 'Cash & Cash Equivalents'],
    no: ['Cash in Hand & Bank Balances', 'Cash & Bank Balance'],
  }],
  // Note: "Total loans and borrowings" DOES match, and must — every read of
  // this head is fenced to a section (the SFP's two liability headings, or
  // note 3.8's own window), so the total row is either outside the fence or
  // skipped by the caller's own /^total/ rule.
  ['loans', {
    yes: ['Loans and Borrowings', 'Loans & Borrowings', 'Loan and Borrowing'],
    no: ['Bank Overdrafts', 'Permanent Working Capital Loan', 'Vehicle Loan'],
  }],
  ['provisions', { yes: ['Provisions', 'Provision for Income Tax'], no: ['Total Current Liabilities'] }],
  ['investments', { yes: ['Investments', 'Investment'], no: ['Total Non-Current Assets'] }],
  ['distribution', {
    yes: ['Drawing', 'Drawings', 'Dividend Paid'],
    no: ['Capital Introduced During the year', 'Drawings Account Balance'],
  }],
];

console.log('\n  1. SPELLING MATRIX\n');
for (const [key, { yes, no }] of MATRIX) {
  const re = HEADS[key];
  if (!re) { ok(`HEADS.${key} exists`, false); continue; }
  for (const s of yes) ok(`${key.padEnd(18)} matches   "${s}"`, re.test(norm(s)));
  for (const s of no) ok(`${key.padEnd(18)} ignores   "${s}"`, !re.test(norm(s)));
}

// ── 2. the round trip: everything the app WRITES must be readable ─────────
// These are the exact strings finStatementExport prints, from meta.terms
// (js/provisionalStatement.js psToOut / js/auditedStatement.js asToOut).
console.log('\n  2. ROUND TRIP — wordings this app prints\n');
const WRITES = {
  capital: ['Share Capital', 'Proprietors Capital', 'Partners Capital'],
  distribution: ['Dividend Paid', 'Drawings'],
  ppe: ['Property, Plant and Equipment'],
  inventories: ['Inventories'],
  receivables: ['Trade and Other Receivables'],
  payables: ['Trade & Other Payables'],
  cash: ['Cash and Cash Equivalents'],
  loans: ['Loans and Borrowings'],
  provisions: ['Provisions'],
  reserves: ['Reserves'],
};
for (const [key, list] of Object.entries(WRITES)) {
  for (const s of list) {
    ok(`app prints "${s}" -> HEADS.${key} reads it`, HEADS[key].test(norm(s)));
  }
}
// The single-line capital note the statement modules emit for a non-company
// must also be readable — it is the SFP row on next year's upload.
ok('the 3.6 single-line capital row is readable',
  ["Proprietor's/Partner's Capital", 'Proprietors Capital', 'Partners Capital']
    .every(s => HEADS.capital.test(norm(s))));

// ── 2b. the entity a statement DECLARES through its capital wording ───────
// Only an unambiguous wording counts. "Share Capital" must stay null: the
// firm's older template printed it for proprietorships too, so treating it
// as a declaration would relabel a real company's report off a stale file.
console.log('\n  2b. ENTITY DECLARED BY THE CAPITAL LINE\n');
const ENTITY = [
  ['Proprietors Capital', 'proprietorship'],
  ["Proprietor's Capital", 'proprietorship'],
  ['Proprietor Capital', 'proprietorship'],
  ['Partners Capital', 'partnership'],
  ["Partners' Capital", 'partnership'],
  ['Partner Capital', 'partnership'],
  ['Share Capital', null],
  ['Paid-up Share Capital', null],
  ['Capital', null],
  ['', null],
  [null, null],
];
for (const [label, want] of ENTITY) {
  const got = WR.entityFromCapitalLabel(label);
  ok(`"${label == null ? '(none)' : label}" declares ${want === null ? 'nothing' : want}`,
    got === want, `got ${got}`);
}

// ── 2c. the wording the projection report then prints ─────────────────────
// A firm with no shares must not be handed a "Paid-up Share Capital" row or
// a "1. Share Capital" heading.
console.log('\n  2c. PROJECTION REPORT CAPITAL WORDING\n');
{
  const PX = fs.readFileSync(path.join(ROOT, 'js', 'projectionExport.js'), 'utf8');
  // pjxTerms is module-private; evaluate just that function against the file
  // so the harness proves the shipped source, not a copy of it.
  const src = PX.match(/function pjxTerms\(orgType\)[\s\S]*?\n}/);
  ok('pjxTerms() found in projectionExport.js', !!src);
  if (src) {
    // eslint-disable-next-line no-new-func
    const pjxTerms = new Function(`${src[0]}; return pjxTerms;`)();
    const prop = pjxTerms('proprietorship');
    const part = pjxTerms('partnership');
    const pvt = pjxTerms('private');
    ok('proprietorship capital row names the proprietor',
      /proprietor/i.test(prop.capRow) && !/share/i.test(prop.capRow), prop.capRow);
    ok('proprietorship heading drops "Share"', !/share/i.test(prop.capHead), prop.capHead);
    ok('proprietorship additional-capital row names the proprietor',
      /proprietor/i.test(prop.addlRow), prop.addlRow);
    ok('partnership capital row names the partner',
      /partner/i.test(part.capRow) && !/share/i.test(part.capRow), part.capRow);
    ok('partnership heading drops "Share"', !/share/i.test(part.capHead), part.capHead);
    ok('a company still reads "Paid-up Share Capital"',
      /paid-up share capital/i.test(pvt.capRow), pvt.capRow);
    ok('a company still heads the section "1. Share Capital"',
      /^1\. Share Capital$/.test(pvt.capHead), pvt.capHead);
    ok('a company still names the director', /director/i.test(pvt.addlRow), pvt.addlRow);
    // Round trip: whatever the projection prints as its capital row must
    // still be readable as a capital head next year.
    for (const t of [prop, part, pvt]) {
      ok(`"${t.capital}" is readable back by HEADS.capital`, HEADS.capital.test(norm(t.capital)));
    }
  }
}

// ── 3. the real corpus (skipped when absent) ──────────────────────────────
function unzip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip');
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
const colIdx = ref => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const colName = c => { let s = ''; c += 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - 1 - m) / 26; } return s; };

function readSheetXml(buf, shared) {
  if (!buf) return [];
  const xml = buf.toString();
  const cells = new Map();
  let maxRow = 0, maxCol = 0;
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
      cells.set(rn + ':' + colIdx(ref), value);
      maxRow = Math.max(maxRow, rn); maxCol = Math.max(maxCol, colIdx(ref));
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

// A SheetJS-shaped workbook, so the real parsers run unmodified.
function toWorkbook(file) {
  const z = unzip(file);
  const shared = [];
  const ssXml = (z('xl/sharedStrings.xml') || Buffer.alloc(0)).toString();
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(unesc(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')));
  }
  const rels = new Map();
  for (const m of (z('xl/_rels/workbook.xml.rels') || Buffer.alloc(0)).toString()
    .matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels.set(m[1], m[2]);
  const wb = { SheetNames: [], Sheets: {} };
  for (const m of z('xl/workbook.xml').toString().matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = (rels.get(m[2]) || '').replace(/^\/?xl\//, '');
    const rows = readSheetXml(z('xl/' + target), shared);
    const ws = {}; let maxR = 0, maxC = 0;
    rows.forEach((row, r) => row.forEach((v, c) => {
      if (v == null) return;
      ws[colName(c) + (r + 1)] = { v };
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
    }));
    ws['!ref'] = `A1:${colName(maxC)}${maxR + 1}`;
    wb.SheetNames.push(unesc(m[1]));
    wb.Sheets[unesc(m[1])] = ws;
  }
  return wb;
}
const XLSX = {
  utils: {
    decode_range(ref) {
      const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      const col = s => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
      return { s: { r: +m[2] - 1, c: col(m[1]) }, e: { r: +m[4] - 1, c: col(m[3]) } };
    },
    encode_cell({ r, c }) { return colName(c) + (r + 1); },
  },
};

const CORPUS = process.env.CORPUS;
console.log('\n  3. REAL CORPUS\n');
if (!CORPUS || !fs.existsSync(CORPUS)) {
  console.log(`  skipped — set CORPUS to a directory of statement workbooks to run it.`);
  console.log(`  (client files are deliberately not in this repo — CLAUDE.md §1 rule 7)`);
} else {
  const files = fs.readdirSync(CORPUS).filter(f => /\.xlsx$/i.test(f) && !/^~\$/.test(f))
    .map(f => path.join(CORPUS, f));
  let read = 0, skipped = 0;
  const capMissing = [], projErrors = [], finErrors = [];
  for (const f of files) {
    let wb;
    try { wb = toWorkbook(f); } catch { skipped++; continue; }
    // A statement workbook, not merely something with a balance sheet: the
    // Projection module's own OUTPUT files carry a "BS" sheet in a different
    // format entirely and are not an input to any parser.
    if (!wb.SheetNames.some(n => /^sfp$|financial position/i.test(n))) { skipped++; continue; }
    if (!wb.SheetNames.some(n => /sch.?-?\s?(bs|pl)/i.test(n))) { skipped++; continue; }
    read++;
    const base = path.basename(f);
    try {
      const { model, issues } = Proj.parseStatement(wb, XLSX);
      const errs = issues.filter(i => i.level === 'error');
      if (errs.length) projErrors.push(`${base}: ${errs.map(e => e.msg).join('; ')}`);
      // The capital is the head this harness exists for: never nil in a
      // finished statement, so a zero here means the label was not
      // recognised — UNLESS the whole current-year column is empty, which is
      // a half-entered draft (they exist in the wild), not a parsing miss.
      const hasCy = [model.ppeTotal, model.cash, model.inventory.closing,
        model.debtors, model.reserves].some(v => Math.abs(v || 0) > 0.005);
      if (hasCy && !model.shareCapital) capMissing.push(`${base} (projection)`);
    } catch (e) { projErrors.push(`${base}: threw ${e.message}`); }
    try {
      const { py, issues } = Fin.parsePriorYear(wb, XLSX);
      const errs = issues.filter(i => i.level === 'error');
      if (errs.length) finErrors.push(`${base}: ${errs.map(e => e.msg).join('; ')}`);
      const hasCy = [py.sfp.ppe, py.sfp.cash, py.sfp.inventories,
        py.sfp.receivables, py.sfp.reserves].some(v => Math.abs(v || 0) > 0.005);
      if (hasCy && !py.sfp.shareCapital) capMissing.push(`${base} (statement reader)`);
    } catch (e) { finErrors.push(`${base}: threw ${e.message}`); }
  }
  console.log(`  ${read} workbooks read, ${skipped} skipped (not statement files)\n`);
  ok(`every workbook yields a capital figure in BOTH parsers`, capMissing.length === 0,
    capMissing.slice(0, 8).join(' | '));
  ok(`Projection parses every workbook without error`, projErrors.length === 0,
    projErrors.slice(0, 5).join(' | '));
  ok(`the statement reader parses every workbook without error`, finErrors.length === 0,
    finErrors.slice(0, 5).join(' | '));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
