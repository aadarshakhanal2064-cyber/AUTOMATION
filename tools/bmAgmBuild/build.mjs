// ════════════════════════════════════════════
//  BM/AGM MINUTES — template build pipeline
//
//  Rebuilds assets/templates/bm-agm-minutes.docx from the firm's real
//  Preeti-encoded source Word file. This is the tooling the OLD template's
//  build pipeline never had committed (docs/history/HANDOFF.md §4 — "the
//  build tooling was never committed... a future session will need to
//  recreate this from scratch"). Don't repeat that mistake: if the template
//  ever needs a fresh rebuild (new source document, wording change, new
//  token), this file is where that work happens, and it must stay committed.
//
//  ── THE GOVERNING RULE: minimal touch ──
//  The firm's source document IS the format. Everything about it — the §51
//  report's bordered table, every cell width, indent, tab stop, alignment,
//  spacing and the blank-paragraph runs that drive pagination — is preserved
//  BYTE FOR BYTE. This script only ever rewrites the *text inside runs*
//  (Preeti bytes -> Unicode) and swaps sample values for {{tokens}}. It
//  never rebuilds a paragraph from a synthesized <w:pPr>.
//
//  That rule is not theoretical. The first version of this script extracted
//  every <w:p> and re-joined them as a flat list, which silently discarded
//  the <w:tbl>/<w:tr>/<w:tc> wrappers around paragraphs 87-139 — the §51
//  capital report rendered as loose unboxed paragraphs instead of the ruled
//  table the registrar expects. Anything that walks this document must keep
//  the gaps BETWEEN paragraph matches, because that is where table markup
//  lives.
//
//  Two more traps this file is shaped around:
//   * Three EMPTY paragraphs are self-closing (`<w:p .../>`). A naive
//     /<w:p\b[^>]*>[\s\S]*?<\/w:p>/ swallows the following real paragraph,
//     shifting every index after ~195 and corrupting the loop anchors.
//     PARA_RE therefore matches the self-closing form FIRST.
//   * Preeti is a byte encoding, so decoding must happen over the largest
//     contiguous run of same-formatted text available, or a ligature that
//     straddles a run boundary decodes wrong. Runs are merged into
//     "formatting groups" (adjacent runs whose <w:rPr> match once the
//     yellow highlight is stripped) and decoded per group — the same idea
//     the old pipeline documented. verifyGroupDecode() below asserts that
//     group-wise decoding equals whole-paragraph decoding, which is the
//     check that proves no ligature was split.
//
//  Usage:
//    cd tools/bmAgmBuild && npm install
//    node build.mjs "<path to the firm's source .docx>"
//
//  The source file is the firm's real document (a real client's name/PAN/
//  registration number) and must NEVER be committed to this public repo
//  (CLAUDE.md §1 rule 7) — pass its path from wherever it actually lives.
// ════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertFont } from 'preeti-to-unicode';
import JSZip from 'jszip';
import { CORRECTIONS } from './corrections.mjs';

let SOURCE_SAMPLE;
try {
  ({ SOURCE_SAMPLE } = await import('./sample-values.local.mjs'));
} catch {
  console.error(
    "Missing tools/bmAgmBuild/sample-values.local.mjs.\n" +
    "This file holds the real client's sample values from the source document " +
    "and is deliberately gitignored (CLAUDE.md §1 rule 7 — this repo is public). " +
    "Create it from the shape documented at the top of sample-values.local.mjs " +
    "(read the values off the source document you are rebuilding against) and re-run."
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', '..', 'assets', 'templates', 'bm-agm-minutes.docx');

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('Usage: node build.mjs "<path to source .docx>"');
  process.exit(1);
}

const SENT = String.fromCodePoint(0xE000);          // stands in for <w:tab/> across a Preeti decode
const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const RUN_RE  = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
const SEQ_RE  = /<w:tab\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const RPR_RE  = /<w:rPr>[\s\S]*?<\/w:rPr>/;
const FONT_RE = /<w:rFonts\b[^>]*w:ascii="([^"]*)"/;

const xdec = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
const xenc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function decodePreeti(text) {
  let d;
  try { d = convertFont(text.split('\t').join(SENT), 'preeti'); } catch { d = text; }
  return d.split(SENT).join('\t');
}

// ════════════════════════════════════════════
//  TOKENISATION
//
//  Every entry replaces a decoded SAMPLE VALUE from the firm's document
//  with a docxtemplater token. Because replacement happens on decoded text
//  inside an already-formatted run, the run's bold/size/font is inherited
//  automatically — the chairman's name stays bold in the intro paragraph
//  and plain in the signature block, exactly as the source has it, with no
//  formatting decisions made here at all.
// ════════════════════════════════════════════

// Applied to every paragraph. Longest-first where one value could be a
// substring of another (the four full dates before the two fiscal years).
// Built from SOURCE_SAMPLE (sample-values.local.mjs) rather than holding any
// value as a string literal here — see that file's header comment for why.
const S = SOURCE_SAMPLE;
const GLOBAL_TOKENS = [
  // company identity — the source carries three spellings, incl. one page
  // pasted from a different client's file that was never updated
  [S.companyNameFull, '{{companyName}}'],
  [S.companyNameOther, '{{companyName}}'],
  // The §92 Director's Declaration pages deliberately use the ABBREVIATED
  // company form and slash-separated registration number, where every other
  // page uses the full name and dandas. That is the firm's own convention on
  // that form, not an inconsistency, so it keeps its own tokens rather than
  // being flattened into {{companyName}}/{{registrationNumber}} — doing that
  // silently printed the long name on those pages. (The source ALSO spells
  // the name differently there — a typo, normalised away by both spellings
  // mapping to a token.)
  [S.companyNameShort, '{{companyNameShort}}'],
  [S.companyAddress, '{{companyAddress}}'],
  [S.registrationNumber, '{{registrationNumber}}'],
  [S.registrationNumberSlash, '{{registrationNumberSlash}}'],
  // people
  [S.chairmanName, '{{chairmanName}}'],
  [S.chairmanNameOther, '{{chairmanName}}'],   // leftover sample on the board-change page
  [S.auditorName, '{{auditorName}}'],
  [S.auditorNameTypo, '{{auditorName}}'],
  [S.auditorAddress, '{{auditorAddress}}'],
  // dates — full dates first, so a fiscal-year pattern can't match inside one
  [S.bmDate, '{{bmDate}}'],
  [S.agmDate, '{{agmDate}}'],
  [S.letterDate, '{{letterDate}}'],
  [S.boardChangeDate, '{{boardChangeDate}}'],
  [S.fiscalYear, '{{fiscalYear}}'],
  [S.fiscalYearSlash, '{{fiscalYear}}'],
  [S.nextFiscalYear, '{{nextFiscalYear}}'],
];

// Applied to a single paragraph BEFORE the global list, for values the
// global pass can't disambiguate: the three capital figures are the same
// number in the source, and the joined attendee names would otherwise be
// eaten by the chairman-name rule.
const PARA_TOKENS = {
  14:  [['(Additional Proposal)', '{{bmExtraProposalTitle}}']],   // brackets are Preeti, words are Arial
  21:  [['Additional Proposal Decision Fill Space', '{{bmExtraProposalDecision}}']],
  50:  [['(Additional Proposal)', '{{agmExtraProposalTitle}}']],
  67:  [['Additional Proposal Decision Fill Space', '{{agmExtraProposalDecision}}']],
  64:  [[S.attendeeNamesJoined, '{{attendeeNamesJoined}}'], [S.directorTermYears + ' वर्षका', '{{directorTermYears}} वर्षका']],
  91:  [[S.capitalFigure, '{{authorizedCapital}}']],
  96:  [[S.capitalFigure, '{{issuedCapital}}']],
  101: [[S.capitalFigure, '{{paidUpCapital}}']],
  111: [[S.capitalFigure, '{{paidUpCapital}}']],
  // the board-change minutes: source misspells the second name (घिमिर, no े)
  233: [[S.attendeeNamesJoinedTypo, '{{attendeeNamesJoined}}']],
  // Director's Declaration — one page per attendee, so the role wording
  // becomes an inline conditional on the loop item
  253: [[' अध्यक्षको सहि', '{{#isChairman}} अध्यक्षको सहि{{/isChairman}}{{^isChairman}}संचालक/  सहि{{/isChairman}}']],
  254: [[S.chairmanName, '{{name}}']],
  255: [['पद ः– संचालक अध्यक्ष', 'पद ः– {{#isChairman}}संचालक अध्यक्ष{{/isChairman}}{{^isChairman}}संचालक सदस्य{{/isChairman}}']],
  // the four attendee-list lines become the body of an {{#attendees}} loop.
  // Transforming the EXISTING paragraph (rather than synthesising one) is
  // what keeps each list's own indents and tab stops.
  9:   [['१)', '{{num}})'], [S.chairmanName, '{{name}}'], ['अध्यक्ष', '{{role}}']],
  40:  [['१)', '{{num}})'], [S.chairmanName, '{{name}}'], ['अध्यक्ष', '{{role}}']],
  225: [['१)', '{{num}})'], [S.chairmanName, '{{name}}'], ['अध्यक्ष', '{{role}}']],
  204: [['१)', '{{num}})'], [S.chairmanName, '{{name}}']],   // Beneficiary Owner list carries no role column
};

// Paragraphs removed outright: the second row of each attendee list (the
// loop now produces every row) and the source's duplicate second copy of
// the Director's Declaration page (the loop produces one per attendee).
const DROP = new Set([10, 41, 205, 206, 226, ...range(256, 274)]);
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }



// Loop / conditional markers, each on its own paragraph so docxtemplater's
// paragraphLoop consumes the marker paragraph itself.
const INSERT_BEFORE = {
  9:   ['{{#attendees}}'],
  40:  ['{{#attendees}}'],
  204: ['{{#attendees}}'],
  217: ['{{#boardChanged}}'],   // opens the whole Change-of-Board section
  225: ['{{#attendees}}'],
  241: ['{{#attendees}}'],      // Director's Declaration: one page per attendee
  185: ['{{#boardChanged}}'],   // the matching tapsil line in registrar letter 2
};
const INSERT_AFTER = {
  9:   ['{{/attendees}}'],
  40:  ['{{/attendees}}'],
  204: ['{{/attendees}}'],
  225: ['{{/attendees}}'],
  185: ['{{/boardChanged}}'],
  255: ['{{/attendees}}', '{{/boardChanged}}'],
};

// The first paragraph of each self-contained document in the bundle. The
// source separates these with RUNS OF BLANK PARAGRAPHS rather than real
// page breaks — it only lands correctly because the sample client's names
// and figures happen to fill each page to the right height. That is not
// something a generated document can rely on: a longer company name or a
// fourth director silently pushes a signature block onto the next sheet.
//
// Each boundary below therefore becomes a REAL page break, and the blank
// spacers that used to do the job are dropped (see markBlankSpacers) so
// they cannot add an empty page. This also restores pagination in the
// app's own preview/print, which splits on explicit breaks only
// (ignoreLastRenderedPageBreak — js/bmAgmMinutes.js).
//
// Deliberately NOT a boundary: the AGM minutes run from paragraph 34 to 71
// and legitimately flow across two sheets, exactly as the source does.
// Verified against the source's own <w:lastRenderedPageBreak/> markers,
// which record where Word actually broke: paragraphs 57, 217, 241 and 259.
// 57 is the AGM's internal break (निर्णय नं. २ starts a fresh sheet, leaving
// white space under decision 1 — exactly as the firm's file prints), and 259
// is the second Director's Declaration, now produced by the loop instead.
const SECTION_STARTS = [34, 57, 84, 150, 170, 193, 217, 241];

// ════════════════════════════════════════════

const zip = await new JSZip().loadAsync(readFileSync(srcPath));
const files = {};
for (const [name, entry] of Object.entries(zip.files)) {
  if (!entry.dir) files[name] = await entry.async('nodebuffer');
}
let xml = files['word/document.xml'].toString('utf8');

const bodyOpen = xml.indexOf('<w:body>') + '<w:body>'.length;
const bodyClose = xml.indexOf('</w:body>');
const head = xml.slice(0, bodyOpen);
const tail = xml.slice(bodyClose);
const body = xml.slice(bodyOpen, bodyClose);

const SECTION_START_SET = new Set(SECTION_STARTS);
const tableSpans = [...body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map(m => [m.index, m.index + m[0].length]);
console.log('source: %d table(s), %d cells', tableSpans.length, (body.match(/<w:tc>/g) || []).length);

let mismatches = [];
let repaired = [];

// Splits one paragraph's runs into formatting groups, decodes each, applies
// tokens, and re-emits — pPr and every rPr copied through verbatim.
function transformParagraph(pXml, idx) {
  if (!pXml.includes('</w:p>')) return pXml;               // self-closing empty paragraph

  const openTag = pXml.match(/^<w:p\b[^>]*>/)[0];
  let rest = pXml.slice(openTag.length, -'</w:p>'.length);

  let pPr = '';
  const pPrM = rest.match(/^<w:pPr>[\s\S]*?<\/w:pPr>/);
  if (pPrM) { pPr = pPrM[0]; rest = rest.slice(pPr.length); }

  // collect runs, keeping any non-run markup in document order
  const parts = [];
  let last = 0, m;
  RUN_RE.lastIndex = 0;
  while ((m = RUN_RE.exec(rest))) {
    if (m.index > last) parts.push({ kind: 'other', xml: rest.slice(last, m.index) });
    parts.push({ kind: 'run', xml: m[0] });
    last = m.index + m[0].length;
  }
  if (last < rest.length) parts.push({ kind: 'other', xml: rest.slice(last) });

  // Group adjacent runs by VISIBLE formatting only. Word litters a document
  // with runs that differ solely in metadata — <w:szCs> present or absent,
  // a complex-script font name, an eastAsia language tag — and splitting on
  // those would slice words apart: `अनुमतिले` arrives as "cg" + "'dtLn]"
  // across two such runs and decodes to the wrong vowel if handled
  // separately, and `२०८१/८२` arrives in three pieces so no token could
  // ever match it. Only the properties below change what a reader sees, so
  // only they may start a new group. The first run's rPr is emitted
  // verbatim for the whole group, so nothing about the formatting is
  // reconstructed or guessed.
  const sigOf = (rPr, isPreeti) => JSON.stringify([
    isPreeti,
    /<w:b\/>/.test(rPr),
    /<w:i\/>/.test(rPr),
    (/<w:u\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
    (/<w:sz\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
    // explicit black and "auto" render identically to no colour at all, and
    // the company title is written as three runs that differ ONLY by that —
    // treating them as different groups split the title so {{companyName}}
    // could never match it
    ((/<w:color\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1] || '').replace(/^(000000|auto)$/i, ''),
    (/<w:vertAlign\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
    /<w:strike\/>/.test(rPr),
    /<w:caps\/>/.test(rPr),
  ]);
  const groups = [];
  for (const part of parts) {
    if (part.kind !== 'run') { groups.push({ kind: 'other', xml: part.xml }); continue; }
    const rPrRaw = (RPR_RE.exec(part.xml) || [''])[0];
    // the firm used yellow purely to mark fill-in spots by hand; it must
    // never survive into a generated document
    const rPr = rPrRaw.replace(/<w:highlight\s+w:val="[^"]*"\/>/g, '');
    const isPreeti = ((FONT_RE.exec(part.xml) || [, 'Preeti'])[1]) === 'Preeti';
    const sig = sigOf(rPr, isPreeti);
    let text = '';
    let sm; SEQ_RE.lastIndex = 0;
    while ((sm = SEQ_RE.exec(part.xml))) text += sm[1] !== undefined ? xdec(sm[1]) : '\t';
    const prev = groups[groups.length - 1];
    if (prev && prev.kind === 'group' && prev.sig === sig) prev.text += text;
    else groups.push({ kind: 'group', sig, rPr, isPreeti, text });
  }

  // A Preeti syllable can straddle a formatting boundary — in this source
  // the chairman's name ends bold while the "को" that follows starts with
  // its consonant still inside the bold run and its vowel sign in the plain
  // one, so decoding the groups independently produces different (wrong)
  // text than decoding the paragraph whole. Nudge the boundary a few
  // characters either way until the two agree, exactly as the old pipeline
  // documented doing. Whichever side the shifted characters land on is the
  // formatting they take, which is why only tiny shifts are allowed.
  const textGroups = groups.filter(g => g.kind === 'group');
  const allPreeti = textGroups.every(g => g.isPreeti);
  const decodeAll = () => groups.map(g => g.kind === 'group'
    ? (g.isPreeti ? decodePreeti(g.text) : g.text)
    : '');
  if (allPreeti && textGroups.length > 1) {
    const whole = decodePreeti(textGroups.map(g => g.text).join(''));
    const joined = () => decodeAll().join('');
    if (joined() !== whole) {
      for (let b = 0; b < textGroups.length - 1 && joined() !== whole; b++) {
        const L = textGroups[b], R = textGroups[b + 1];
        const L0 = L.text, R0 = R.text;
        for (let k = 1; k <= 3; k++) {
          if (L0.length >= k) {                       // shift boundary left
            L.text = L0.slice(0, -k); R.text = L0.slice(-k) + R0;
            if (joined() === whole) break;
          }
          if (R0.length >= k) {                       // shift boundary right
            L.text = L0 + R0.slice(0, k); R.text = R0.slice(k);
            if (joined() === whole) break;
          }
          L.text = L0; R.text = R0;
        }
      }
      if (joined() !== whole) mismatches.push(idx);
      else if (!repaired.includes(idx)) repaired.push(idx);
    }
  }
  const decoded = decodeAll();

  // ── Cross-group replacement ──
  // A value to be tokenised routinely spans several runs, and NOT because
  // of anything meaningful: the registration number's "।" separators are
  // set two points smaller than its digits, the company title has a
  // half-size space between its two halves, and the "(Additional Proposal)"
  // placeholder puts its brackets in Preeti and its words in Arial. Merging
  // those runs would be wrong — a paragraph like the declaration address
  // uses differently-sized space runs as indentation, and flattening it
  // moves the text.
  //
  // So replacement works on the paragraph's text as one string while the
  // runs stay separate: the matched characters are cut from whichever runs
  // held them, and the replacement is inserted into the FIRST of them. The
  // token therefore inherits the formatting of wherever the value started
  // — the bold intro keeps a bold name, the plain signature line a plain
  // one — and every other run keeps its own size and spacing untouched.
  const gIdx = [];
  const texts = [];
  groups.forEach((g, i) => { if (g.kind === 'group') { gIdx.push(i); texts.push(decoded[i]); } });

  const replaceAcross = (from, to) => {
    if (!from) return;
    // searchFrom tracks how far into the (repeatedly re-joined) text we've
    // already resolved, so a replacement is never rescanned. Without this,
    // a `to` that itself contains `from` as a substring — e.g. wrapping a
    // label in {{#cond}}label{{/cond}} — matches its own freshly-inserted
    // output every pass and re-wraps it, compounding until the guard limit
    // (confirmed live: the §92 Declaration page's signature label wrapped
    // 49 times). Starting each scan past the previous insertion point still
    // finds every genuine additional occurrence later in the paragraph;
    // it just can't walk backwards into what it already replaced.
    let searchFrom = 0;
    for (let guard = 0; guard < 50; guard++) {
      const at = texts.join('').indexOf(from, searchFrom);
      if (at === -1) return;
      const end = at + from.length;
      let pos = 0, firstAt = -1, insertOffset = 0;
      for (let i = 0; i < texts.length; i++) {
        const gs = pos, ge = pos + texts[i].length;
        pos = ge;
        const os = Math.max(at, gs), oe = Math.min(end, ge);
        if (os >= oe) continue;
        if (firstAt === -1) { firstAt = i; insertOffset = os - gs; }
        texts[i] = texts[i].slice(0, os - gs) + texts[i].slice(oe - gs);
      }
      if (firstAt === -1) return;
      texts[firstAt] = texts[firstAt].slice(0, insertOffset) + to + texts[firstAt].slice(insertOffset);
      searchFrom = at + to.length;
    }
  };

  for (const [from, to] of CORRECTIONS) replaceAcross(from, to);
  for (const [from, to] of (PARA_TOKENS[idx] || [])) replaceAcross(from, to);
  for (const [from, to] of GLOBAL_TOKENS) replaceAcross(from, to);
  texts.forEach((t, k) => { decoded[gIdx[k]] = t; });

  let out = openTag + pPr;
  groups.forEach((g, i) => {
    if (g.kind === 'other') { out += g.xml; return; }
    const text = decoded[i];
    if (!text) return;
    let inner = '';
    text.split('\t').forEach((piece, j) => {
      if (j > 0) inner += '<w:tab/>';
      if (piece) inner += `<w:t xml:space="preserve">${xenc(piece)}</w:t>`;
    });
    out += `<w:r>${g.rPr}${inner}</w:r>`;
  });
  return out + '</w:p>';
}

function markerParagraph(tag) {
  return `<w:p><w:r><w:t>${tag}</w:t></w:r></w:p>`;
}

// Starts this paragraph on a new page.
//
// Done by applying a named style that carries <w:pageBreakBefore/>, NOT by
// inserting a page-break paragraph and NOT by direct paragraph formatting.
// Each of the three ways behaves differently and only this one satisfies
// both consumers:
//   * A separate <w:p> holding <w:br w:type="page"/> is still a paragraph.
//     Its paragraph mark lands at the top of the new page and pushes all
//     content down a line — enough to spill the last line of a full page
//     onto the next one, which is exactly what went wrong first time.
//   * Direct <w:pageBreakBefore/> in the paragraph's own pPr is correct for
//     Word, but docx-preview only consults the property on a paragraph's
//     STYLE (splitBySection -> findStyle(elem.styleName)), so the app's
//     preview and print saw no breaks at all and rendered ten pages as one
//     giant section, which the page-fitting code then shrank to a single
//     sheet.
//   * A style carrying the property satisfies both, and adds no content.
//
// BM_PAGE_STYLE is based on Normal and sets nothing else, so a paragraph's
// own direct formatting (centring, size, weight) still wins over it.
const BM_PAGE_STYLE_ID = 'BmPageStart';
const BM_PAGE_STYLE_XML =
  '<w:style w:type="paragraph" w:customStyle="1" w:styleId="' + BM_PAGE_STYLE_ID + '">' +
  '<w:name w:val="BM Page Start"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:pageBreakBefore/></w:pPr></w:style>';

function withPageBreakBefore(pXml) {
  if (pXml.includes(BM_PAGE_STYLE_ID)) return pXml;
  const style = '<w:pStyle w:val="' + BM_PAGE_STYLE_ID + '"/>';
  const m = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
  if (!m) {
    return pXml
      .replace(/<w:pPr\/>/, '<w:pPr>' + style + '</w:pPr>')
      .replace(/^(<w:p[^>]*>)(?!<w:pPr)/, '$1<w:pPr>' + style + '</w:pPr>');
  }
  if (/<w:pStyle/.test(m[1])) {
    throw new Error('section-start paragraph already carries a pStyle; ' +
      'derive BmPageStart from it instead of overwriting');
  }
  return pXml.replace(m[0], '<w:pPr>' + style + m[1] + '</w:pPr>');   // pStyle must come first
}

// Pre-pass: which paragraphs carry no text at all? A source paragraph used
// purely as vertical spacing before a section break is one of these.
const blank = new Map();
{
  let i = 0, mm;
  const RE = new RegExp(PARA_RE.source, 'g');
  while ((mm = RE.exec(body))) {
    i++;
    const t = (mm[0].match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
      .map(x => x.replace(/<[^>]*>/g, '')).join('');
    blank.set(i, t.trim() === '');
  }
}
// Trailing blank paragraphs at the very end of the body. In the source they
// padded out the final Director's Declaration page; with the declaration now
// a loop, they land after the LAST iteration and push that page 0.8% over a
// sheet — invisible in a preview that scales to fit, a spilled line in Word.
{
  let p = blank.size;
  let dropped = 0;
  while (p >= 1 && blank.get(p)) { DROP.add(p); p--; dropped++; }
  if (dropped) console.log('  trailing: %d blank paragraph(s) dropped', dropped);
}

// Replace each section's leading blank spacers with one real page break.
for (const start of SECTION_STARTS) {
  let p = start - 1;
  let dropped = 0;
  while (p >= 1 && blank.get(p)) { DROP.add(p); p--; dropped++; }
  console.log('  section @%d: %d spacer paragraph(s) -> page break', start, dropped);
}

// Walk the body, transforming paragraphs but COPYING EVERY GAP verbatim —
// the gaps are the <w:tbl>/<w:tr>/<w:tc> markup.
let out = '';
let cursor = 0, idx = 0, m;
PARA_RE.lastIndex = 0;
while ((m = PARA_RE.exec(body))) {
  out += body.slice(cursor, m.index);
  idx++;
  for (const tag of INSERT_BEFORE[idx] || []) out += markerParagraph(tag);
  if (!DROP.has(idx)) {
    const xmlOut = transformParagraph(m[0], idx);
    out += SECTION_START_SET.has(idx) ? withPageBreakBefore(xmlOut) : xmlOut;
  }
  for (const tag of INSERT_AFTER[idx] || []) out += markerParagraph(tag);
  cursor = m.index + m[0].length;
}
out += body.slice(cursor);
console.log('paragraphs walked:', idx);
if (repaired.length) console.log('boundary repaired in paragraphs:', repaired.join(', '));
if (mismatches.length) console.warn('!! group-decode mismatch in paragraphs:', mismatches.join(', '));
else console.log('group-decode check: OK (no ligature split across a formatting boundary)');

// Preeti -> Mangal everywhere (CLAUDE.md §15: never revert to Preeti)
const stripHighlight = s => s.replace(/<w:highlight\s+w:val="[^"]*"\/>/g, '');
// The source has exactly one paragraph (the §92 Declaration page's "no other
// beneficial owner" self-declaration line) formatted as a real Word bulleted
// list item — a stray auto-bullet from drafting, not a deliberate list; every
// other list in this template is manually-typed numbering ("१)", "२)" …).
// Word itself renders the Symbol-font bullet character fine, but docx-preview
// can't map that Private-Use-Area glyph and shows a broken placeholder box
// instead — which the app's Print/PDF path inherits too, since it renders
// through the same library. Stripping the numPr/ListParagraph formatting
// removes the bullet outright rather than trying to fix its glyph.
const stripListBullet = s => s
  .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '')
  .replace(/<w:pStyle\s+w:val="ListParagraph"\/>/g, '');
// The source's two "no additional proposal" decision lines (bm/agmExtra-
// ProposalDecision, default "छैन ।") sit on runs the source itself styled
// Arial instead of Mangal — every neighbouring line, including this same
// paragraph's own mark, is Mangal. Arial has no real Devanagari glyphs, so
// the default value visibly mismatches the rest of the page. The template's
// only other Arial runs are the (genuinely English) "In case of Change of
// Board of Director" headings, so this is scoped to just these two tokens.
const fixExtraProposalFont = s => s.replace(
  /<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"\/>(?=<w:sz w:val="30"\/><w:szCs w:val="30"\/><\/w:rPr><w:t[^>]*>\s*\{\{(?:bm|agm)ExtraProposalDecision\}\})/g,
  '<w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/>'
);
const swapFonts = s => s
  .replace(/w:ascii="Preeti"/g, 'w:ascii="Mangal"')
  .replace(/w:hAnsi="Preeti"/g, 'w:hAnsi="Mangal"')
  .replace(/w:cs="Preeti"/g, 'w:cs="Mangal"')
  .replace(/w:eastAsia="Preeti"/g, 'w:eastAsia="Mangal"');

// The §51 table has no <w:tblCellMar>, so cell text sits flush against the
// borders — Word quietly applies its own built-in default margin (~108
// twips left/right) when none is specified, but docx-preview does not, so
// the app's own preview/print renders it cramped even though Word itself
// looks fine. Made explicit so both agree, rather than relying on an
// invisible default. There is exactly one <w:tbl> in this document
// (build.mjs's own structural check above proves it), so this is unambiguous.
const fixTablePadding = s => {
  const CELL_MAR = '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>';
  const marker = '<w:tblLook w:val="01E0" w:firstRow="1" w:lastRow="1" w:firstColumn="1" w:lastColumn="1" w:noHBand="0" w:noVBand="0"/>';
  if (!s.includes(marker)) throw new Error('§51 table tblLook marker not found — table structure changed, revisit fixTablePadding');
  return s.replace(marker, CELL_MAR + marker);
};

// The chairman-signature block on the §51 page (dots / name / title) mixes
// two alignment mechanisms: the dots and title lines are center-jc'd, but
// the middle name line has NO w:jc at all, so {{chairmanName}} — a token
// whose width varies by client — sits off-center from its neighbours. All
// three also bake literal leading/trailing spaces into the run text as a
// hand-typed "push right" hack, which centering only makes worse (the same
// space count reads differently once the visible content's width differs).
// Fixed by stripping the literal spaces and centering all three within one
// shared, indented column instead — immune to name length, unlike spaces.
const fixSignatureAlign = s => {
  const IND = '<w:ind w:left="5400" w:right="0"/>';
  let out = s;
  const dotsOld = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="30"/><w:szCs w:val="30"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="PMingLiU" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="30"/><w:szCs w:val="30"/><w:lang w:eastAsia="zh-HK"/></w:rPr><w:t xml:space="preserve">                                                             ..............................</w:t>';
  const dotsNew = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="30"/><w:szCs w:val="30"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="PMingLiU" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="30"/><w:szCs w:val="30"/><w:lang w:eastAsia="zh-HK"/></w:rPr><w:t xml:space="preserve">..............................</w:t>';
  const nameOld = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">                                                                        {{chairmanName}}                          </w:t>';
  const nameNew = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">{{chairmanName}}</w:t>';
  const titleOld = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr><w:t xml:space="preserve">                                                             अध्यक्ष</w:t>';
  const titleNew = '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:eastAsia="SimSun" w:hAnsi="Mangal" w:cs="Times New Roman"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:eastAsia="zh-CN"/></w:rPr><w:t xml:space="preserve">अध्यक्ष</w:t>';
  for (const [oldStr, label] of [[dotsOld, 'dots'], [nameOld, 'name'], [titleOld, 'title']]) {
    if (!out.includes(oldStr)) throw new Error(`signature block ${label} line not found — source changed, revisit fixSignatureAlign`);
  }
  out = out.replace(dotsOld, dotsNew).replace(nameOld, nameNew).replace(titleOld, titleNew);
  return out;
};

// The registrar-notification letter's signature block (निवेदक / name /
// "अध्यक्ष सञ्चालक") has the identical disease as the §51 page's block above,
// just with different hand-typed padding per line — spaces on two lines, ten
// literal <w:tab/> presses on the third — and none of the three paragraphs
// has ANY w:jc at all, so they were never even trying to share a center.
// Same fix, same shared column (same w:ind so every signature block in the
// document lines up at one consistent right-of-page position).
const fixSignatureAlign2 = s => {
  const IND = '<w:ind w:left="5400" w:right="0"/>';
  let out = s;
  const nivedakOld = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1035"/></w:tabs><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">                                                                       </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">निवेदक</w:t>';
  const nivedakNew = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">निवेदक</w:t>';
  const name2Old = '<w:pPr><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">                                                           {{chairmanName}}                          </w:t>';
  const name2New = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">{{chairmanName}}</w:t>';
  const title2Old = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1035"/></w:tabs><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">अध्यक्ष सञ्चालक  </w:t>';
  const title2New = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">अध्यक्ष सञ्चालक</w:t>';
  for (const [oldStr, label] of [[nivedakOld, 'निवेदक'], [name2Old, 'name'], [title2Old, 'title']]) {
    if (!out.includes(oldStr)) throw new Error(`registrar-letter signature block ${label} line not found — source changed, revisit fixSignatureAlign2`);
  }
  out = out.replace(nivedakOld, nivedakNew).replace(name2Old, name2New).replace(title2Old, title2New);
  return out;
};

// The annual-report submission letter's own signature block ("निवेदक" / name
// / "अध्यक्ष") — the third occurrence of this exact disease, found while
// fixing page 5's letter. Same fix, same shared column.
const fixSignatureAlign3 = s => {
  const IND = '<w:ind w:left="5400" w:right="0"/>';
  let out = s;
  const niv3Old = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1035"/></w:tabs><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve"> </w:t><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/></w:r><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">निवेदक</w:t>';
  const niv3New = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">निवेदक</w:t>';
  const name3Old = '<w:pPr><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">     {{chairmanName}}                                                                                  </w:t>';
  const name3New = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">{{chairmanName}}</w:t>';
  const title3Old = '<w:pPr><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">अध्यक्ष </w:t>';
  const title3New = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">अध्यक्ष</w:t>';
  for (const [oldStr, label] of [[niv3Old, 'निवेदक'], [name3Old, 'name'], [title3Old, 'title']]) {
    if (!out.includes(oldStr)) throw new Error(`annual-report-letter signature block ${label} line not found — source changed, revisit fixSignatureAlign3`);
  }
  out = out.replace(niv3Old, niv3New).replace(name3Old, name3New).replace(title3Old, title3New);
  return out;
};

// The registrar-letter date line ("मितिः– {{letterDate}}") presses <w:tab/>
// FOUR times against a single defined tab stop (7035 twips) — the first tab
// lands there, the other three fall through to Word's default tab-stop grid
// beyond it, pushing the line so far right it doesn't fit and wraps (the
// date drops to its own line, flush left — confirmed in real Word, not just
// the preview). A second, near-identical date line elsewhere in the document
// presses the SAME tab exactly once and sits fine on its one stop — so this
// is a stray extra key-presses typo in the source, not a deliberate design;
// matching that already-working convention is the minimal fix.
// The §92(1) Director's Declaration page's header block (registration
// number, address, the two "कम्पनी ऐन…"/"संचालकले पेश…" heading lines) used
// four different hand-typed leading-space counts instead of real centering
// — the address line even had a whole separate 6pt-font run of nothing but
// spaces as a fine-tuning hack. None of the four agreed with each other.
// Centered all four for real instead.
const fixDeclarationHeaderAlign = s => {
  let out = s;
  const regOld = '<w:pPr><w:ind w:left="2160" w:hanging="1080"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">                    {{registrationNumberSlash}}</w:t>';
  const regNew = '<w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">{{registrationNumberSlash}}</w:t>';
  const addrOld = '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr><w:t xml:space="preserve">                            </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">      {{companyAddress}}</w:t>';
  const addrNew = '<w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">{{companyAddress}}</w:t>';
  const actOld = '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">          </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:lang w:val="es-CO"/></w:rPr><w:t xml:space="preserve">कम्पनी ऐन , २०६३ को दफा ९२(१) बमोजिमको</w:t>';
  const actNew = '<w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:lang w:val="es-CO"/></w:rPr><w:t xml:space="preserve">कम्पनी ऐन , २०६३ को दफा ९२(१) बमोजिमको</w:t>';
  const titleOld = '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:lang w:val="es-CO"/></w:rPr><w:t xml:space="preserve">                      संचालकले पेश गर्नु पर्ने विवरण</w:t>';
  const titleNew = '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:lang w:val="es-CO"/></w:rPr><w:t xml:space="preserve">संचालकले पेश गर्नु पर्ने विवरण</w:t>';
  for (const [oldStr, label] of [[regOld, 'reg-no'], [addrOld, 'address'], [actOld, 'act line'], [titleOld, 'title line']]) {
    if (!out.includes(oldStr)) throw new Error(`declaration header ${label} not found — source changed, revisit fixDeclarationHeaderAlign`);
  }
  out = out.replace(regOld, regNew).replace(addrOld, addrNew).replace(actOld, actNew).replace(titleOld, titleNew);
  return out;
};

// The declaration page's own signature label ("अध्यक्षको सहि" / "संचालक/ सहि")
// used a real indent+jc, but नाम/पद below it used 9 literal tabs each with
// no jc at all — a third alignment mechanism disagreeing with the other two
// on the very same page. Shared indent + center for all three.
const fixDeclarationSignatureAlign = s => {
  const IND = '<w:ind w:left="6480" w:right="0"/>';
  let out = s;
  const labelOld = '<w:pPr><w:ind w:left="6480" w:hanging="720"/><w:jc w:val="both"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr>';
  const labelNew = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr>';
  const naamOld = '<w:pPr><w:spacing w:line="362" w:lineRule="auto"/><w:ind w:left="-18"/><w:jc w:val="both"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">नाम ः– </w:t>';
  const naamNew = '<w:pPr><w:spacing w:line="362" w:lineRule="auto"/>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">नाम ः– </w:t>';
  const padOld = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="680"/></w:tabs><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">पद ः– ';
  const padNew = '<w:pPr>' + IND + '<w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">पद ः– ';
  for (const [oldStr, label] of [[labelOld, 'label'], [naamOld, 'नाम'], [padOld, 'पद']]) {
    if (!out.includes(oldStr)) throw new Error(`declaration signature ${label} not found — source changed, revisit fixDeclarationSignatureAlign`);
  }
  out = out.replace(labelOld, labelNew).replace(naamOld, naamNew).replace(padOld, padNew);
  return out;
};

// "In case of Change of Board of Director" is a marker the firm typed into
// the source purely to mark the conditional block's boundary for whoever's
// rebuilding the template — it was never meant to print (confirmed by the
// user). Both occurrences happen to carry the BmPageStart style (the
// page-break trigger for their section), so the paragraphs can't just be
// deleted outright — that would drop the page break too. Strip the runs,
// keep the empty paragraph.
const stripBoardChangeMarker = s => {
  const marker1Old = '<w:p w14:paraId="752D0F38" w14:textId="009825D8" w:rsidR="006D783B" w:rsidRPr="006D783B" w:rsidRDefault="006D783B" w:rsidP="00D55E09"><w:pPr><w:pStyle w:val="BmPageStart"/><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">In case of Change of Board of Director</w:t></w:r></w:p>';
  const marker1New = '<w:p w14:paraId="752D0F38" w14:textId="009825D8" w:rsidR="006D783B" w:rsidRPr="006D783B" w:rsidRDefault="006D783B" w:rsidP="00D55E09"><w:pPr><w:pStyle w:val="BmPageStart"/><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr></w:p>';
  const marker2Old = '<w:p w14:paraId="6BC83456" w14:textId="67C6B2B0" w:rsidR="000B30C7" w:rsidRPr="000B30C7" w:rsidRDefault="000B30C7" w:rsidP="000B30C7"><w:pPr><w:pStyle w:val="BmPageStart"/><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:bCs/><w:sz w:val="68"/><w:szCs w:val="68"/></w:rPr><w:t xml:space="preserve">       </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">In case of Change of Board of Director</w:t></w:r></w:p>';
  const marker2New = '<w:p w14:paraId="6BC83456" w14:textId="67C6B2B0" w:rsidR="000B30C7" w:rsidRPr="000B30C7" w:rsidRDefault="000B30C7" w:rsidP="000B30C7"><w:pPr><w:pStyle w:val="BmPageStart"/><w:ind w:firstLine="720"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr></w:p>';
  if (!s.includes(marker1Old)) throw new Error('board-change marker 1 not found — source changed, revisit stripBoardChangeMarker');
  if (!s.includes(marker2Old)) throw new Error('board-change marker 2 not found — source changed, revisit stripBoardChangeMarker');
  return s.replace(marker1Old, marker1New).replace(marker2Old, marker2New);
};

const fixDateLineTabs = s => {
  const old4Tab = '<w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">मितिः– {{letterDate}}</w:t>';
  const new1Tab = '<w:tab/><w:t xml:space="preserve">मितिः– {{letterDate}}</w:t>';
  if (!s.includes(old4Tab)) throw new Error('registrar-letter date line (4-tab form) not found — source changed, revisit fixDateLineTabs');
  return s.replace(old4Tab, new1Tab);
};

files['word/document.xml'] = Buffer.from(
  fixDeclarationSignatureAlign(fixDeclarationHeaderAlign(stripBoardChangeMarker(fixDateLineTabs(fixSignatureAlign3(fixSignatureAlign2(fixSignatureAlign(fixTablePadding(stripListBullet(stripHighlight(fixExtraProposalFont(swapFonts(head + out + tail)))))))))))),
  'utf8'
);
for (const name of ['word/styles.xml', 'word/fontTable.xml', 'word/settings.xml']) {
  if (files[name]) files[name] = Buffer.from(swapFonts(files[name].toString('utf8')), 'utf8');
}
{
  let styles = files['word/styles.xml'].toString('utf8');
  if (!styles.includes(BM_PAGE_STYLE_ID)) {
    styles = styles.replace('</w:styles>', BM_PAGE_STYLE_XML + '</w:styles>');
    files['word/styles.xml'] = Buffer.from(styles, 'utf8');
  }
}

// structural regression check — the whole reason this rewrite exists
{
  const built = files['word/document.xml'].toString('utf8');
  const srcTbl = (body.match(/<w:tbl>/g) || []).length;
  const outTbl = (built.match(/<w:tbl>/g) || []).length;
  const srcCells = (body.match(/<w:tc>/g) || []).length;
  const outCells = (built.match(/<w:tc>/g) || []).length;
  if (srcTbl !== outTbl || srcCells !== outCells) {
    throw new Error(`table structure lost: ${srcTbl} tables/${srcCells} cells in, ${outTbl}/${outCells} out`);
  }
  console.log('table structure preserved: %d table(s), %d cells', outTbl, outCells);
  if (built.includes('Preeti')) throw new Error('a Preeti font reference survived');
  if (built.includes('w:highlight')) throw new Error('a highlight survived');
  if (built.includes('w:numPr') || built.includes('ListParagraph')) throw new Error('a stray list bullet survived');
  if (/w:ascii="Arial"\/><w:sz w:val="30"\/><w:szCs w:val="30"\/><\/w:rPr><w:t[^>]*>\s*\{\{(?:bm|agm)ExtraProposalDecision\}\}/.test(built)) {
    throw new Error('the extra-proposal decision run is still Arial');
  }
  if (!built.includes('<w:tblCellMar>')) throw new Error('§51 table cell padding did not survive');
  if ((built.match(/w:left="5400" w:right="0"/g) || []).length !== 9) {
    throw new Error('signature block indent did not apply to all 9 lines (3 blocks x 3 lines)');
  }
  if (built.includes('<w:tab/><w:tab/><w:tab/><w:tab/><w:t xml:space="preserve">मितिः– {{letterDate}}</w:t>')) {
    throw new Error('registrar-letter date line still presses tab 4 times');
  }
  if (built.includes('In case of Change of Board of Director')) throw new Error('board-change marker text survived — it should never print');
  if ((built.match(/isChairman/g) || []).length !== 8) {
    throw new Error('isChairman conditional count is off — the replaceAcross self-match bug may have regressed');
  }
  if ((built.match(/w:left="6480" w:right="0"/g) || []).length !== 3) {
    throw new Error('declaration-page signature block indent did not apply to all 3 lines');
  }

  // Every sample value MUST have become a token. A value that survives is a
  // field silently hard-coded to the sample client — the company title did
  // exactly that on three pages, because its runs differed only by an
  // explicit black colour and so never formed one matchable string.
  const builtText = (built.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
    .map(t => t.replace(/<[^>]*>/g, '')).join('');
  const survived = GLOBAL_TOKENS.filter(([from]) => builtText.includes(from)).map(([from]) => from);
  if (survived.length) {
    throw new Error('sample value(s) left un-tokenised: ' + survived.join(' | '));
  }
  console.log('tokenisation check: OK (no sample value left in the template)');

  const styleUses = (built.match(new RegExp('<w:pStyle w:val="' + BM_PAGE_STYLE_ID + '"/>', 'g')) || []).length;
  if (styleUses !== SECTION_STARTS.length) {
    throw new Error(`page-break style applied ${styleUses} times, expected ${SECTION_STARTS.length}`);
  }
  if (!files['word/styles.xml'].toString('utf8').includes(BM_PAGE_STYLE_ID)) {
    throw new Error('page-break style used but never defined in styles.xml');
  }
  console.log('pagination check: OK (%d section starts carry the page-break style)', styleUses);
}

const outZip = new JSZip();
for (const [name, buf] of Object.entries(files)) outZip.file(name, buf);
writeFileSync(OUT_PATH, await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('written:', OUT_PATH);
