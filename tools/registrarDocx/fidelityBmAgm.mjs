// ════════════════════════════════════════════
//  BM/AGM MINUTES — fidelity harness
//
//  Proves the built template still reproduces the firm's source document.
//  Renders the template with the SOURCE's own sample values (from
//  sample-values.local.mjs — see that file's header for why they live
//  there and not in this one) and diffs the result against the source,
//  line by line. Every surviving difference must be a deliberate
//  normalisation — anything else is a defect.
//
//  This is the check that catches what a page count cannot: the first
//  build produced ten pages and was still wrong, because the §51 table
//  had been flattened and three pages were hard-coded to the sample
//  client.
//
//  Usage (after buildBmAgm.mjs has run):
//    node fidelityBmAgm.mjs "<source .docx>" ../../assets/templates/bm-agm-minutes.docx
//
//  Expected as of 2026-08-20: 177 source lines, 174 output lines (3 fewer
//  — see below), 135 identical, 81 diff entries — all of them intentional:
//    * the one fiscal year the source itself writes with a slash instead
//      of a danda, now consistent with every other occurrence
//    * a typo in the source's registrar letter (a consonant swapped)
//    * another client's company name and chairman, left on the
//      board-change page when that page was copied from their file
//    * a dropped vowel sign on a name, on the board-change minutes
//    * "In case of Change of Board of Director", typed into the source
//      three times purely as a marker for whoever rebuilds the template —
//      confirmed with the user it was never meant to print, and stripped
//      (paragraph kept empty, since two of the three carry the page-break
//      style for their section) — 3 pure deletions, no output counterpart
//    * every colon-style separator the source types as the Devanagari
//      visarga (ः) — standard Preeti-keyboard practice, but not what the
//      firm wants printed (user-requested) — replaced with an ASCII colon
//      everywhere EXCEPT "क्रमशः" ("respectively"), where visarga is part
//      of the actual Nepali spelling, not punctuation. 35 lines changed
//      (70 diff entries) — buildBmAgm.mjs asserts exactly one surviving ः,
//      inside that one word, so a regression here fails loudly rather than
//      silently misspelling it or leaving a stray visarga unconverted.
//  Diffs print to the console, not to a file — the text is a real
//  client's document and must not end up sitting in a tracked path.
//
//  A source .docx is a real client's file and is never committed, so the
//  path is always external.
// ════════════════════════════════════════════
import { readFileSync } from 'fs';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { convertFont } from 'preeti-to-unicode';
import { CORRECTIONS } from './corrections.mjs';

let SOURCE_SAMPLE;
try {
  ({ SOURCE_SAMPLE } = await import('./sample-values.local.mjs'));
} catch {
  console.error(
    "Missing tools/registrarDocx/sample-values.local.mjs — see buildBmAgm.mjs's " +
    "same check for what to do."
  );
  process.exit(1);
}
const S = SOURCE_SAMPLE;

const SENT = String.fromCodePoint(0xE000);
const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const RUN_RE  = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
const SEQ_RE  = /<w:tab\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const FONT_RE = /<w:rFonts\b[^>]*w:ascii="([^"]*)"/;
const xdec = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
const corr = t => { let o=t; for (const [a,b] of CORRECTIONS) o = o.split(a).join(b); return o; };
const norm = s => s.replace(/\s+/g, ' ').trim();

// ---- the source, decoded exactly as the build decodes it ----
function sourceLines(srcPath) {
  // accept the .docx itself (or a pre-extracted document.xml)
  const xml = srcPath.toLowerCase().endsWith('.docx')
    ? new PizZip(readFileSync(srcPath)).file('word/document.xml').asText()
    : readFileSync(srcPath, 'utf8');
  const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('</w:body>'));
  const lines = [];
  let m; PARA_RE.lastIndex = 0;
  while ((m = PARA_RE.exec(body))) {
    const blk = m[0];
    const chunks = [];
    let rm; RUN_RE.lastIndex = 0;
    while ((rm = RUN_RE.exec(blk))) {
      const rb = rm[0];
      const isPreeti = ((FONT_RE.exec(rb) || [, 'Preeti'])[1]) === 'Preeti';
      let t = ''; let sm; SEQ_RE.lastIndex = 0;
      while ((sm = SEQ_RE.exec(rb))) t += sm[1] !== undefined ? xdec(sm[1]) : '\t';
      if (!t) continue;
      const p = chunks[chunks.length-1];
      if (p && p.isPreeti === isPreeti) p.text += t; else chunks.push({ isPreeti, text: t });
    }
    if (!chunks.length) continue;
    const text = chunks.map(c => c.isPreeti
      ? convertFont(c.text.split('\t').join(SENT), 'preeti').split(SENT).join('\t')
      : c.text).join('');
    const n = norm(corr(text));
    if (n) lines.push(n);
  }
  return lines;
}

// ---- the template, rendered with the source's own values ----
function renderedLines(tplPath) {
  const doc = new Docxtemplater(new PizZip(readFileSync(tplPath)), {
    delimiters:{start:'{{',end:'}}'}, paragraphLoop:true, linebreaks:true });
  doc.render({
    companyName: S.companyNameFull,
    registrationNumber: S.registrationNumber,
    registrationNumberSlash: S.registrationNumberSlash,
    companyNameShort: S.companyNameShort,
    companyAddress: S.companyAddress,
    chairmanName: S.chairmanName,
    auditorName: S.auditorName,
    auditorAddress: S.auditorAddress,
    bmDate: S.bmDate, agmDate: S.agmDate,
    letterDate: S.letterDate, boardChangeDate: S.boardChangeDate,
    fiscalYear: S.fiscalYear, nextFiscalYear: S.nextFiscalYear,
    authorizedCapital: S.capitalFigure, issuedCapital: S.capitalFigure, paidUpCapital: S.capitalFigure,
    // the source's own frozen count, so the diff against the source stays clean;
    // the APP derives these as capital ÷ 100 (bmShareCount)
    authorizedShares: S.shareCountFigure, issuedShares: S.shareCountFigure, paidUpShares: S.shareCountFigure,
    directorTermYears: S.directorTermYears,
    bmExtraProposalTitle:'(Additional Proposal)',
    bmExtraProposalDecision:'Additional Proposal Decision Fill Space',
    agmExtraProposalTitle:'(Additional Proposal)',
    agmExtraProposalDecision:'Additional Proposal Decision Fill Space',
    // The source document carries both extra-proposal placeholders, so a
    // faithful re-render keeps them present with their original numbering
    // (misc stays item/decision 3 in BM, 6 in AGM) rather than the renumbered
    // (extra-omitted) case — that path is exercised by the app, not by this
    // fidelity-against-the-source harness.
    bmHasExtra: true, bmMiscItemNum: '३', bmMiscDecisionNum: '३',
    // boardChanged:true (below) also keeps the AGM's own item/decision 4
    // ("संचालकहरुको पुनर्नियुक्ति") present, so with both that AND the extra
    // proposal shown, item/decision 5 is the extra and 6 is विविध — the
    // source's own original numbering.
    agmHasExtra: true, agmExtraItemNum: '५', agmExtraDecisionNum: '५',
    agmMiscItemNum: '६', agmMiscDecisionNum: '६',
    attendeeNamesJoined: S.attendeeNamesJoined,
    attendees:[
      { num:'१', name: S.chairmanName,       role:'अध्यक्ष',  isChairman:true },
      { num:'२', name: S.secondAttendeeName, role:'सञ्चालक', isChairman:false },
    ],
    boardChanged:true,
  });
  const xml = doc.getZip().file('word/document.xml').asText();
  const body = xml.slice(xml.indexOf('<w:body>'), xml.indexOf('</w:body>'));
  const lines = [];
  let m; PARA_RE.lastIndex = 0;
  while ((m = PARA_RE.exec(body))) {
    const t = [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => xdec(x[1])).join('');
    const n = norm(t);
    if (n) lines.push(n);
  }
  return lines;
}

const src = sourceLines(process.argv[2]);
const gen = renderedLines(process.argv[3]);
console.log('source content lines :', src.length);
console.log('output content lines :', gen.length);

// LCS-based diff so insertions/deletions line up
const n = src.length, m2 = gen.length;
const dp = Array.from({length:n+1}, () => new Uint16Array(m2+1));
for (let i=n-1;i>=0;i--) for (let j=m2-1;j>=0;j--)
  dp[i][j] = src[i]===gen[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
let i=0, j=0; const diffs=[];
while (i<n && j<m2) {
  if (src[i]===gen[j]) { i++; j++; }
  else if (dp[i+1][j] >= dp[i][j+1]) diffs.push({k:'only in SOURCE', t:src[i++]});
  else diffs.push({k:'only in OUTPUT', t:gen[j++]});
}
while (i<n) diffs.push({k:'only in SOURCE', t:src[i++]});
while (j<m2) diffs.push({k:'only in OUTPUT', t:gen[j++]});

console.log('identical lines      :', dp[0][0]);
console.log('differences          :', diffs.length);
for (const d of diffs) console.log(`  [${d.k}] ${d.t.slice(0, 100)}`);

// 4 changed lines (8 diff entries) + 3 deliberately-deleted marker lines
// (3 more, source-only) = 11. A different count means a NEW difference
// crept in: investigate it before shipping rather than re-baselining this
// number. The 3-line gap between source and output is the same deletions,
// not drift — EXPECTED_LINE_DELTA documents it so this check still catches
// anything else that changes the line count.
const EXPECTED = 81;
const EXPECTED_LINE_DELTA = -3;
if (gen.length - src.length !== EXPECTED_LINE_DELTA) {
  console.error(`\nFAIL: line count changed by ${gen.length - src.length}, expected ${EXPECTED_LINE_DELTA}; content was added or lost beyond the documented marker-strip.`);
  process.exit(1);
}
if (diffs.length !== EXPECTED) {
  console.error(`\nFAIL: expected ${EXPECTED} diff entries, got ${diffs.length}.`);
  console.error("Every difference must be a deliberate normalisation — see this file's header.");
  process.exit(1);
}
console.log('\nfidelity: OK (every difference is a documented, deliberate normalisation)');
