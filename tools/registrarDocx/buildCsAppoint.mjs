// ════════════════════════════════════════════
//  COMPANY SECRETARY APPOINTMENT — template build pipeline
//
//  Builds assets/templates/company-secretary-appointment.docx from the
//  firm's real Preeti-encoded source Word file ("Board of Minute.docx").
//  Two pages: the board-meeting minutes appointing a company secretary
//  under Companies Act §84, and the notification letter to the Company
//  Registrar's Office.
//
//  The heavy lifting — Preeti decode, run grouping, cross-run token
//  replacement, page-break style, font scaling — lives in core.mjs and is
//  shared with buildBmAgm.mjs. Read that file's header first; everything
//  here is what is specific to THIS document.
//
//  ── What this document needed that BM/AGM did not ──
//   * <w:proofErr> stripping (core.mjs). This source carries 506 of Word's
//     spell-check markers, 141 in one paragraph. They render nothing but
//     sit BETWEEN runs, so identically-formatted runs stopped being
//     adjacent and Preeti ligatures decoded across the split — 8 paragraphs
//     disagreed with their own whole-paragraph decode, producing real
//     misspellings (कम्फनी for कम्पनी, दफmा for दफा). Stripping them takes
//     that to one paragraph, which the boundary-nudge repair then handles.
//   * A `ाे`->`ो` normalisation (correctionsCs.mjs). This source was typed
//     with the ो vowel sign keyed as two glyphs, in 15 different words.
//   * The attendee list as a LOOP. The source hard-codes two people, one
//     paragraph each, aligned by hand-typed spaces (5 on one row, 9 on the
//     other). It is now one {{#attendees}} row with a real tab stop, so a
//     board of any size prints with the role column actually lined up.
//
//  Usage:
//    cd tools/registrarDocx && npm install
//    node buildCsAppoint.mjs "<path to the firm's source .docx>"
//
//  The source file names a real client, their chairman and the appointed
//  secretary's citizenship number, and must NEVER be committed to this
//  public repo (CLAUDE.md §1 rule 7) — pass its path from wherever it lives.
// ════════════════════════════════════════════
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CORRECTIONS } from './corrections.mjs';
import { CS_CORRECTIONS } from './correctionsCs.mjs';
import {
  readDocx, writeDocx, splitBody, stripProofErr, createTransformer, createPageBreakStyle,
  walkBody, swapFonts, stripHighlight, stripListBullet, mangalToNirmala, remapFontSizes,
  tightDocDefaults, assertTokenised, assertCount, swapExact, allText,
} from './core.mjs';

let CS_SAMPLE;
try {
  ({ CS_SAMPLE } = await import('./sample-values-cs.local.mjs'));
} catch {
  console.error(
    "Missing tools/registrarDocx/sample-values-cs.local.mjs.\n" +
    "This file holds the real client's sample values from the source document " +
    "and is deliberately gitignored (CLAUDE.md §1 rule 7 — this repo is public). " +
    "Create it from the shape documented at the top of that file (read the values " +
    "off the source document you are building against) and re-run."
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', '..', 'assets', 'templates', 'company-secretary-appointment.docx');

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('Usage: node buildCsAppoint.mjs "<path to source .docx>"');
  process.exit(1);
}

const S = CS_SAMPLE;

// ════════════════════════════════════════════
//  TOKENISATION
//
//  Each entry swaps a decoded SAMPLE VALUE for a docxtemplater token.
//  Because the swap happens on decoded text inside an already-formatted
//  run, the run's bold/size/font is inherited automatically — the chairman's
//  name stays bold in the attendee row and in the signature block exactly as
//  the source has it, with no formatting decisions made here at all.
// ════════════════════════════════════════════

// Applied to every paragraph, longest-first so a shorter value can never
// match inside a longer one (the secretary's two spellings before anything
// that could sit inside them).
const GLOBAL_TOKENS = [
  [S.companyName, '{{companyName}}'],
  [S.secretaryName, '{{secretaryName}}'],
  [S.secretaryNameAlt, '{{secretaryName}}'],
  [S.secretaryAddress, '{{secretaryAddress}}'],
  [S.citizenshipNo, '{{citizenshipNo}}'],
  [S.chairmanName, '{{chairmanName}}'],
];

// Applied to a single paragraph BEFORE the global list, for values the
// global pass cannot disambiguate.
const PARA_TOKENS = {
  // Meeting line: the time is the one thing on this page the firm changes
  // per meeting that isn't a name or a date.
  4: [[S.meetingTime, '{{meetingTime}}'], [S.meetingDate, '{{meetingDate}}']],

  // ── The attendee row ──
  // Source rows 7 and 8 are one person each, the columns held apart by
  // literal spaces (five on row 7, nine on row 8 — they do not line up, and
  // could not for any other pair of names). Row 7 becomes the loop body and
  // row 8 is dropped; the spaces become a real <w:tab/> against the tab stop
  // fixAttendeeRow() installs below.
  //
  // Two separate replacements, not one covering the whole line, because the
  // name is BOLD and the role is not — replacing them together would put the
  // whole result in the first (bold) run and print the role bold too.
  7: [
    [S.chairmanName + '     ', '{{name}}\t'],
    ['संचालक अध्यक्ष', '{{role}}'],
  ],

  // The decision paragraph. The source opens a bracket before the secretary's
  // citizenship number and never closes it — the run reads
  // "(नागरिकता प्रमाणपत्र नं <no>, स्थायी ठेगाना: <address> लाई मिति <date>"
  // with no ")" anywhere. The closing bracket is added here rather than left
  // for every generated document to reproduce the typo. (The real values are
  // redacted from this comment — CLAUDE.md §1 rule 7, this repo is public;
  // they live in sample-values-cs.local.mjs, which is gitignored.)
  17: [
    [S.secretaryAddress + ' लाई मिति ' + S.meetingDate, '{{secretaryAddress}}) लाई मिति {{appointmentDate}}'],
  ],

  // The letterhead's registration-number blank.
  29: [[S.regNoPlaceholder, '{{registrationNumber}}']],

  // The letter's own date. Identical to the meeting date in this source, so
  // only a per-paragraph rule can tell the two apart — and they are genuinely
  // different fields (a letter is routinely written days after the meeting).
  32: [[S.meetingDate, '{{letterDate}}']],

  // The letter body writes the meeting date with a full stop where the rest
  // of the document uses a danda.
  45: [[S.meetingDateDot, '{{meetingDate}}']],
};

// 8  — the second hard-coded attendee, now produced by the loop.
// 51 — one of the THREE blank paragraphs the source puts between "निवेदक"
//      and the chairman's name. Three is a signing gap wide enough that the
//      label stops reading as part of the same block as the name below it
//      (user-reported, 2026-08-21 — measured at 35pt in Word while the name
//      and its title sat 21pt apart, so the block looked lopsided). Two
//      blanks leave ~23pt: still real room to sign above the printed name,
//      but tight enough that the four lines read as one signature block.
const DROP = new Set([8, 51]);

// paragraphLoop markers. The loop opens before row 7 and closes after it,
// so the break-free body is exactly one row per attendee.
const INSERT_BEFORE = { 7: ['{{#attendees}}'] };
const INSERT_AFTER = { 7: ['{{/attendees}}'] };

// Page 2 (the registrar letter) starts at the company name on paragraph 28 —
// verified against the source's own <w:lastRenderedPageBreak/>, which records
// where Word actually broke. The six blank spacer paragraphs above it are
// dropped by walkBody and replaced with this one real break, so a longer
// company name or a third director can never push the letter onto page 3.
const SECTION_STARTS = [28];

// ════════════════════════════════════════════

const files = await readDocx(srcPath);
const { head, body, tail } = splitBody(stripProofErr(files['word/document.xml'].toString('utf8')));

const srcTables = (body.match(/<w:tbl>/g) || []).length;
console.log('source: %d paragraph(s) of text, %d table(s)',
  (body.match(/<w:p\b/g) || []).length, srcTables);

const { transformParagraph, mismatches, repaired } = createTransformer({
  // CS-specific first: its normalisations must run before the shared word
  // list, which is written against already-normalised text.
  corrections: [...CS_CORRECTIONS, ...CORRECTIONS],
  globalTokens: GLOBAL_TOKENS,
  paraTokens: PARA_TOKENS,
});

const pageBreak = createPageBreakStyle('CsPageStart', 'CS Page Start');

const { out, count } = walkBody({
  body,
  transformParagraph,
  sectionStarts: SECTION_STARTS,
  drop: DROP,
  insertBefore: INSERT_BEFORE,
  insertAfter: INSERT_AFTER,
  pageBreak,
});
console.log('paragraphs walked:', count);
if (repaired.length) console.log('boundary repaired in paragraphs:', repaired.join(', '));

// Paragraph 41 (the letter's inner subject line) is a KNOWN, CHECKED
// disagreement, not an unreviewed warning. Its three runs decode correctly
// one by one — "विषयः– कम्पनी सचिवको नियुक्तिको जानकारी पेश गरेको बारे ।" —
// while decoding the paragraph whole produces "कम्फनी" (फ for प). The
// group-wise result is the RIGHT one here, so the mismatch is accepted and
// the run-by-run text is what ships; the stray "m" that group-wise decoding
// leaves at the run boundary is fixed by name in correctionsCs.mjs.
//
// Listing it rather than silencing the check means a NEW mismatch, in some
// other paragraph, still fails loudly.
const ACCEPTED_MISMATCHES = new Set([41]);
{
  const unexpected = mismatches.filter(i => !ACCEPTED_MISMATCHES.has(i));
  if (unexpected.length) {
    throw new Error('group-decode mismatch in unreviewed paragraph(s): ' + unexpected.join(', ') +
      ' — decode each run-by-run against the whole paragraph before accepting it');
  }
  console.log('group-decode check: OK (%d accepted mismatch, no unreviewed ones)', mismatches.length);
}

// ════════════════════════════════════════════
//  ALIGNMENT
//
//  Everything in this source is positioned with hand-typed spaces and tab
//  presses, which line up for exactly one set of values — the client it was
//  typed against. A longer company name, a different secretary, a third
//  director, and every one of these blocks drifts. Each fix below replaces
//  the hand-typed padding with a real Word alignment property, so the layout
//  is a function of the page rather than of the text length.
//
//  Every one is an exact-string swap that THROWS if the source changed, so a
//  re-typed source fails loudly instead of silently printing the old spacing.
// ════════════════════════════════════════════

// The signature column — a LEFT indent with no <w:jc>, so all three lines
// start at the same x.
//
// The source types them with 55, 54 and 54 leading spaces: near-identical
// counts, which is a left-alignment attempt that space-counting could not
// quite land, not a centring one. The first pass here centred them instead.
// That is mathematically "aligned" — Word reports the same indent and the
// same centre on all three — but centred lines of different widths each
// START at a different x, and since these three are deliberately different
// sizes (16pt underlined label, 18pt bold name, 18pt title) the result reads
// as crooked, which is exactly what the user saw (2026-08-21).
//
// Left-aligning reproduces what the source was reaching for, and is what
// makes the three read as one block. 4680 twips ≈ 3.25in, which is where
// the source's own ~54 Preeti spaces landed.
const SIG_IND = '<w:ind w:left="4680" w:right="0"/>';

// The attendee row's role column. A name longer than this simply pushes the
// tab to the next default stop rather than colliding with the role.
const ATTENDEE_TAB = '<w:tabs><w:tab w:val="left" w:pos="4320"/></w:tabs>';

// One shared run-properties string for everything in the two-line बोधार्थ
// block, so the label, the name and the address all print at one size and
// weight. The source has them at 16pt plain, 18pt plain and 18pt bold
// respectively, with a 20pt bold comma and danda — five combinations inside
// what reads as a single two-line address.
const RPR_18 = '<w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>';

// Installs the tab stop the {{name}}<tab>{{role}} row tabs against. The
// source paragraph has no <w:tabs> at all — it never needed one, because it
// was separating two fixed strings with a hand-counted run of spaces.
// Matched together with the {{name}} run that follows it: the bare pPr on
// its own is byte-identical to the signature-block title's, and a fix that
// silently lands on the wrong paragraph is worse than one that throws.
const fixAttendeeRow = s => swapExact(s,
  '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">{{name}}</w:t><w:tab/></w:r>',
  '<w:pPr>' + ATTENDEE_TAB + '<w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">{{name}}</w:t><w:tab/></w:r>',
  'attendee row tab stop');

// The letterhead's registration-number line ends with a stray <w:tab/> press
// against a tab stop at 7185 twips — a leftover from typing, which pushes an
// invisible cell most of the way across the page and can drag the line into
// a wrap once the blank becomes a real number.
const fixRegNoLine = s => swapExact(s,
  '<w:t xml:space="preserve">प्रा.लि.नं. {{registrationNumber}}</w:t><w:tab/></w:r>',
  '<w:t xml:space="preserve">प्रा.लि.नं. {{registrationNumber}}</w:t></w:r>',
  'registration-number line trailing tab');

// The letter's date line is pushed right by 53 literal spaces. Right-align
// it instead, so it sits against the margin whatever the date's width — and
// drop the two trailing spaces, which now push it back off that margin.
const fixLetterDateLine = s => swapExact(s,
  '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">                                                     मिति ः {{letterDate}}  </w:t></w:r>',
  '<w:pPr><w:jc w:val="right"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">मिति ः {{letterDate}}</w:t></w:r>',
  'letter date line');

// The inner subject line carries BOTH a real first-line indent (720 twips)
// and 16 literal spaces on top of it. Keep the indent, drop the spaces.
// (Matched on the visarga form — fixVisargaColon runs after this.)
const fixSubjectLine = s => swapExact(s,
  '<w:t xml:space="preserve">                विषयः– </w:t>',
  '<w:t xml:space="preserve">विषयः– </w:t>',
  'inner subject line');

// The signature block: निवेदक / {{chairmanName}} / संचालक अध्यक्ष. Three
// paragraphs, three different hand-typed space counts (55, 54, 54), and not
// one of them carries a <w:jc> — they were never even trying to share a
// centre, and the name line adds five trailing spaces on top. Same disease,
// and same fix, as all three signature blocks in the BM/AGM document: one
// shared indented column, centred, immune to name length.
const fixSignatureBlock = s => {
  const SP55 = ' '.repeat(55);
  const SP54 = ' '.repeat(54);
  let out = s;

  out = swapExact(out,
    '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1035"/></w:tabs><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">' + SP55 + '</w:t></w:r>',
    '<w:pPr>' + SIG_IND + '<w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:u w:val="single"/></w:rPr></w:pPr>',
    'signature block निवेदक line');

  out = swapExact(out,
    '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">' + SP54 + '{{chairmanName}}     </w:t></w:r>',
    '<w:pPr>' + SIG_IND + '<w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">{{chairmanName}}</w:t></w:r>',
    'signature block name line');

  out = swapExact(out,
    '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">' + SP54 + '</w:t></w:r>',
    '<w:pPr>' + SIG_IND + '<w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:pPr>',
    'signature block title line');

  return out;
};

// The बोधार्थ (cc) block runs over two paragraphs — label + secretary on the
// first, their address on the second — with the second indented by eight
// literal spaces to sit under the first's text. A real left indent puts it
// there regardless of how wide "बोधार्थ:" renders, and one shared size makes
// the two lines read as the single address block they are.
const fixBodharthaBlock = s => {
  let out = s;

  // label run: 16pt -> 18pt, matching the name beside it
  out = swapExact(out,
    '<w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">बोधार्थ ः </w:t></w:r>',
    '<w:r>' + RPR_18 + '<w:t xml:space="preserve">बोधार्थ ः </w:t></w:r>',
    'बोधार्थ label');

  // trailing "ज्यू ," run: 20pt bold -> 18pt plain
  out = swapExact(out,
    '<w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr><w:t xml:space="preserve"> ज्यू ,</w:t></w:r>',
    '<w:r>' + RPR_18 + '<w:t xml:space="preserve"> ज्यू ,</w:t></w:r>',
    'बोधार्थ line trailing "ज्यू ,"');

  // address line: real indent instead of 8 spaces, 18pt plain throughout
  out = swapExact(out,
    '<w:pPr><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">        {{secretaryAddress}}</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr><w:t xml:space="preserve"> ।</w:t></w:r>',
    '<w:pPr><w:ind w:left="1200"/>' + RPR_18 + '</w:pPr><w:r>' + RPR_18 + '<w:t xml:space="preserve">{{secretaryAddress}} ।</w:t></w:r>',
    'बोधार्थ address line');

  return out;
};

// The source types every colon-style separator ("मिति ः", "विषय ः–",
// "बोधार्थ ः", "ठेगानाः") as the Devanagari visarga rather than an ASCII
// colon — standard Preeti-keyboard practice (the ":" key produces that glyph
// in that font) but not what the firm wants printed. Same user decision as
// the BM/AGM template, applied the same way, including the guard for
// "क्रमशः", where the visarga is part of the word's actual spelling rather
// than punctuation. (That word does not appear in this document today; the
// guard costs nothing and protects a re-typed source that adds it.)
// The source is also inconsistent about the SPACE before that separator —
// six occurrences have one ("विषय ः–", "मिति ः", "बोधार्थ ः") and the seventh
// does not ("विषयः–"), which prints as two different styles of the same
// label on the same page. Closed up to the no-space form, which is both the
// standard Devanagari convention and what the source's own odd-one-out uses.
const fixVisargaColon = s => {
  const GUARD = '';
  return s
    .replace(/क्रमशः/g, 'क्रमश' + GUARD)
    .replace(/ः/g, ':')
    .replace(new RegExp(GUARD, 'g'), 'ः')
    .replace(/ +:/g, ':');
};

// ── EMPTY SPACER PARAGRAPHS ──
// The registrar letter is laid out with EMPTY paragraphs as vertical space:
// 17 of the 32 paragraphs on page 2 carry no text at all. In Preeti that is
// affordable, because each one is a narrow 16-20pt line; in real Devanagari
// at the same nominal size they add up to more than an inch and pushed the
// letter's own signature block onto a third sheet (measured in Word — the
// page break itself was correct throughout, page 3 held nothing but the
// overflow).
//
// Shrinking them keeps the letter's visual rhythm — every gap still exists,
// still in proportion to its neighbours — where deleting them would flatten
// the letter into a solid block, and where shrinking the TEXT instead would
// make a document the firm hands to the registrar smaller than it should be.
// Same idea as fitSection51() in buildBmAgm.mjs, applied document-wide here
// because this document's spacing is entirely empty paragraphs.
//
// A spacer's height must be PINNED, not merely sized. These paragraphs
// inherit the document's line height like any other, so raising that for the
// body's sake (LINE_HEIGHT below) silently multiplied all 17 of them too and
// pushed the letter's own बोधार्थ block onto the bottom margin — measured at
// 730pt into a 720pt page. Body leading and gap height are two different
// decisions and must not share one knob: each spacer gets its own single
// line spacing here, so its height is exactly SPACER_SZ whatever the body does.
const SPACER_SZ = 16;               // half-points, i.e. 8pt
const SPACER_SPACING = '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>';
const shrinkEmptyParagraphs = s => s.replace(
  /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,
  p => {
    if (/<w:t[ >]/.test(p)) return p;
    let out = p
      .replace(/<w:(sz|szCs) w:val="\d+"\/>/g, (_, tag) => `<w:${tag} w:val="${SPACER_SZ}"/>`)
      .replace(/<w:spacing\b[^/]*\/>/g, '');
    if (/<w:pPr>/.test(out)) {
      // w:spacing follows w:pStyle in the schema's element order
      out = /<w:pStyle [^>]*\/>/.test(out)
        ? out.replace(/(<w:pStyle [^>]*\/>)/, '$1' + SPACER_SPACING)
        : out.replace('<w:pPr>', '<w:pPr>' + SPACER_SPACING);
    } else {
      out = out
        .replace(/^(<w:p\b[^>]*)\/>$/, `$1><w:pPr>${SPACER_SPACING}</w:pPr></w:p>`)
        .replace(/^(<w:p\b[^>]*>)(?!<w:pPr)/, `$1<w:pPr>${SPACER_SPACING}</w:pPr>`);
    }
    return out;
  }
);

// ── PRINT SIZE ──
// The source sets 14-22pt throughout, which is legible in Preeti because that
// font's glyphs are byte-narrow ASCII; real Unicode Devanagari at the same
// nominal size is far wider and taller, so those numbers do not carry over.
//
// These are the sizes the FIRM asked for (2026-08-21), given as an explicit
// table rather than a scale factor, because a single factor cannot express
// them: the body drops by nearly half while the company name drops by only a
// quarter. Approximating that with a factor plus per-element patches is how a
// size hierarchy drifts out of step with itself, so the table is the whole
// specification and `remapFontSizes` applies it verbatim.
//
// Keys are the SOURCE's half-point values; values are the target half-points.
const CS_SIZES = {
  44: 32,   // 22pt -> 16pt   company name (both pages)
  40: 28,   // 20pt -> 14pt   letter subject line, "महोदय,"
  36: 22,   // 18pt -> 11pt   BODY — minutes, decisions, letter body, attendees
  32: 22,   // 16pt -> 11pt   प्रा.लि.नं., the letter's मिति, निवेदक
  28: 22,   // 14pt -> 11pt   "सञ्चालक समिति बैठक" subtitle
};
// A size in the source that nobody assigned a target would silently ship at
// its original Preeti-era value, which on this document would be 50% too big.
// Only the BODY is checked: styles.xml carries Word's built-in style sizes
// (Heading 1, footnotes, ...) which this document never uses and which have
// no business in a table describing this document's own hierarchy.
const unmappedSizes = new Set();
const scaleCs = s => remapFontSizes(s, CS_SIZES, v => unmappedSizes.add(v));
const scaleCsStyles = s => remapFontSizes(s, CS_SIZES);

// ── LINE HEIGHT ──
// Word's inherited default is 276 (1.15), and the first version of this
// template had to come DOWN to 264 to keep the minutes on one sheet.
//
// At the firm's requested sizes that constraint is gone — an 11pt body frees
// roughly a third of the page — and the firm's actual complaint was the
// opposite one: the body paragraphs read as cramped (2026-08-21, "everything
// feels so close"). Line height is what fixes that, not the point size: the
// long decision paragraphs are 8-11 wrapped lines each, and at 1.15 those
// lines sit close enough that Devanagari matras from one nearly meet the
// next.
//
// 336 (1.40) is generous rather than merely adequate, which is the right
// side to err on here — the page has the room, and this is a document
// somebody reads carefully rather than skims. Note this value is also a
// FLOOR in the app's preview, which maps it to a flat CSS line-height where
// too small a number makes lines touch (240 does exactly that — the BM/AGM
// template's own note records it).
const LINE_HEIGHT = Number(process.env.CS_LINE || 336);

// shrinkEmptyParagraphs runs AFTER scaleCs, so its size is absolute rather
// than scaled twice — a spacer is a fixed gap, not part of the size
// hierarchy the font scale preserves.
files['word/document.xml'] = Buffer.from(
  shrinkEmptyParagraphs(mangalToNirmala(scaleCs(fixVisargaColon(fixBodharthaBlock(fixSignatureBlock(fixSubjectLine(
    fixLetterDateLine(fixRegNoLine(fixAttendeeRow(stripListBullet(stripHighlight(
      swapFonts(head + out + tail))))))))))))),
  'utf8'
);
for (const name of ['word/styles.xml', 'word/fontTable.xml', 'word/settings.xml']) {
  if (files[name]) files[name] = Buffer.from(swapFonts(files[name].toString('utf8')), 'utf8');
}
// styles.xml carries the defaults any run without an explicit size inherits.
// This source's <w:pPrDefault/> is EMPTY, which inherits Word's stock
// `after=200 line=276` just as surely as spelling it out would — 10pt after
// every paragraph, and this document has ~25 of them per page.
files['word/styles.xml'] = Buffer.from(
  mangalToNirmala(scaleCsStyles(tightDocDefaults(files['word/styles.xml'].toString('utf8'), LINE_HEIGHT))),
  'utf8'
);
files['word/styles.xml'] = Buffer.from(
  pageBreak.ensureDefined(files['word/styles.xml'].toString('utf8')),
  'utf8'
);

// ════════════════════════════════════════════
//  REGRESSION CHECKS
// ════════════════════════════════════════════
{
  const built = files['word/document.xml'].toString('utf8');

  if (built.includes('Preeti')) throw new Error('a Preeti font reference survived');
  if (built.includes('w:highlight')) throw new Error('a highlight survived — the firm marks fill-in spots in yellow and none of it may print');
  if (built.includes('w:numPr') || built.includes('ListParagraph')) throw new Error('a stray list bullet survived');
  if (built.includes('<w:proofErr')) throw new Error('a proofErr marker survived — run stripProofErr before the body walk');

  // A source size with no entry in CS_SIZES would ship at its original
  // Preeti-era value — on this document that is 50% too big and sits right
  // next to correctly-sized text, so it reads as a mistake rather than a
  // size. Fail instead, naming the size to add.
  if (unmappedSizes.size) {
    throw new Error('font size(s) with no CS_SIZES entry: ' +
      [...unmappedSizes].sort((a, b) => a - b).map(v => `${v} (${v / 2}pt)`).join(', ') +
      ' — add a target for each, they would otherwise print at the source size');
  }
  // Every size that DID survive must be one of the targets.
  {
    const targets = new Set(Object.values(CS_SIZES).concat([SPACER_SZ]));
    const seen = [...built.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map(m => Number(m[1]));
    const stray = [...new Set(seen)].filter(v => !targets.has(v));
    if (stray.length) throw new Error('unexpected font size(s) in the built template: ' + stray.join(', '));
  }

  assertTokenised(built, GLOBAL_TOKENS);
  // The per-paragraph values are not in GLOBAL_TOKENS, so assertTokenised
  // cannot see them — and every one is either a real client's date or the
  // blank where their registration number goes.
  const text = allText(built);
  for (const [label, value] of [
    ['meeting date', S.meetingDate],
    ['meeting date (dotted form)', S.meetingDateDot],
    ['meeting time', S.meetingTime],
    ['registration-number blank', S.regNoPlaceholder],
    ['second director', S.director2],
  ]) {
    if (text.includes(value)) throw new Error(`sample ${label} left un-tokenised — it would print on every generated document`);
  }
  console.log('tokenisation check: OK (no sample value left in the template)');

  // Every token the module fills must actually exist in the template. This
  // is the check that would have caught a company name silently left
  // hard-coded on the letter's own header page.
  for (const tok of ['companyName', 'registrationNumber', 'chairmanName', 'secretaryName',
                     'secretaryAddress', 'citizenshipNo', 'meetingDate', 'meetingTime',
                     'appointmentDate', 'letterDate', 'name', 'role']) {
    if (!built.includes('{{' + tok + '}}')) throw new Error(`token {{${tok}}} is missing from the built template`);
  }
  // The company name appears twice — the minutes title and the letterhead.
  // The letterhead one was NOT highlighted in the firm's source, so it is
  // exactly the kind of field that gets left hard-coded to the sample client.
  assertCount(built, '{{companyName}}', 2, 'company name');
  assertCount(built, '{{chairmanName}}', 3, 'chairman name');   // meeting line, decision 1, signature
  assertCount(built, '{{secretaryName}}', 3, 'secretary name'); // decision 1, letter body, बोधार्थ
  assertCount(built, '{{#attendees}}', 1, 'attendee loop open');
  assertCount(built, '{{/attendees}}', 1, 'attendee loop close');

  if (!built.includes(ATTENDEE_TAB)) throw new Error('the attendee row lost its tab stop — the role column would fall back to a default stop');
  if ((built.match(/w:left="4680" w:right="0"/g) || []).length !== 3) {
    throw new Error('signature block indent did not apply to all 3 lines');
  }
  // The three signature lines must be LEFT-aligned on that shared indent, not
  // centred. Centring them is mathematically "aligned" — same indent, same
  // centre — but the three are deliberately different sizes, so centring
  // gives each a different left edge and the block reads as crooked. This
  // shipped once; the guard is here so it cannot come back unnoticed.
  if (/w:left="4680" w:right="0"\/><w:jc /.test(built)) {
    throw new Error('a signature line carries a <w:jc> — the block must be left-aligned on its shared indent, not centred');
  }
  {
    const visarga = (built.match(/ः/g) || []).length;
    if (visarga !== 0) throw new Error(`visarga->colon conversion is off — ${visarga} left, expected 0`);
  }

  const styleUses = (built.match(new RegExp('<w:pStyle w:val="' + pageBreak.styleId + '"/>', 'g')) || []).length;
  if (styleUses !== SECTION_STARTS.length) {
    throw new Error(`page-break style applied ${styleUses} times, expected ${SECTION_STARTS.length}`);
  }
  if (!files['word/styles.xml'].toString('utf8').includes(pageBreak.styleId)) {
    throw new Error('page-break style used but never defined in styles.xml');
  }
  console.log('pagination check: OK (%d section start carries the page-break style)', styleUses);
}

await writeDocx(OUT_PATH, files);
console.log('written:', OUT_PATH);

// ── WORD PAGINATION ──
// The .docx must open in WORD as 2 pages — minutes on sheet 1, registrar
// letter on sheet 2. Structural checks cannot see pagination: the BM/AGM
// template passed every one of them while opening as 19 pages instead of 10,
// because the app's preview scales each section to fit a sheet and Word does
// not. So every number below was MEASURED with Word itself (COM,
// ComputeStatistics) via wordPages.ps1, not reasoned about.
//
// Measured, as "2-director board / 5-director board with deliberately long
// names" (sampleCsAppoint.mjs renders exactly those two cases):
//
//   scale  line    pages
//   1.00   276      4 / 4     letter's signature block off the bottom
//   0.90   276      4 / 4
//   0.85   276      3 / 3     page 1 now the one spilling, by ~2 lines
//   0.82   264      2 / 3
//   0.85   252      2 / 3
//   0.82   252      2 / 2     fits, but on the tightest line height
//   0.80   264      2 / 2  <- chosen
//
// Two separate causes had to be fixed before any scale worked, and each was
// isolated by measurement rather than assumed:
//   * The 17 empty spacer paragraphs on page 2 (shrinkEmptyParagraphs above).
//     Until those came down, the LETTER was what overflowed and no font
//     scale down to 0.78 fixed it.
//   * Word's inherited 1.15 line height (LINE_HEIGHT above). On a page of
//     ~28 lines that is four lines of pure leading — which is what the
//     minutes' closing decision needed to stay on sheet 1.
//
// Headroom at the chosen setting, measured with the long-name stress values:
// 2 pages holds to a FIVE-director board and turns 3 at six. That is correct
// rather than a limit to design around — a larger board is genuinely more
// minutes — and the letter still starts on its own fresh sheet either way,
// because CsPageStart forces it regardless of what precedes it.
//
// Re-measure after any wording, spacing or size change:
//   node sampleCsAppoint.mjs
//   powershell -File wordPages.ps1 sample-cs.docx=2 sample-cs-five.docx=2
