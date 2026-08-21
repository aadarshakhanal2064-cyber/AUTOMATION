// ════════════════════════════════════════════
//  COMPANY REGISTRATION — template build pipeline (both variants)
//
//  Builds the two Company Registration templates from the firm's real
//  Preeti-encoded source Word files:
//
//    node buildCompanyReg.mjs multi  "<path to the multi-shareholder .docx>"
//    node buildCompanyReg.mjs single "<path to the single-man source .docx>"
//
//  -> assets/templates/company-registration-multi.docx
//  -> assets/templates/company-registration-single.docx
//
//  Each source is FOUR sub-documents in one file: the Memorandum of
//  Association (प्रबन्ध पत्र), the Articles of Association (नियमावली), the
//  registrar application letter (निवेदन) and the power of attorney
//  (मन्जुरीनामा). The heavy lifting — Preeti decode, run grouping,
//  cross-run token replacement, page-break style, size remapping — lives in
//  core.mjs, shared with buildBmAgm.mjs / buildCsAppoint.mjs. Read that
//  file's header first; everything here is specific to THIS document pair.
//
//  ── What this document pair needed that the earlier two did not ──
//   * A TABLE-ROW loop. The founders' subscription table is one <w:tr> per
//     founder; {{#founders}} opens in the row's first cell and closes in its
//     last, which docxtemplater expands to repeat the whole row (verified
//     empirically before this was written). The multi source's second
//     hard-coded founder row is removed structurally — dropping only its
//     paragraphs would leave <w:tc> elements with no <w:p>, which is
//     invalid OOXML.
//   * Theme-font runs. The English company name is typed in runs carrying
//     w:asciiTheme (no w:ascii at all), which core's FONT_RE cannot see —
//     unhandled, those Latin runs default to "Preeti" and decode to
//     Devanagari garbage. They get an explicit Latin font up front.
//   * A per-variant token vocabulary over ONE shared shape: the single-man
//     variant has exactly one founder, so its table takes flat tokens and
//     its letter/POA blocks lose their second column; the multi variant
//     loops founders in the table and founder PAIRS (two names per row) in
//     the letter/POA signature blocks.
//   * The single source's letter + POA pages were copied from the multi
//     client's file and never updated — they still carried the OTHER
//     company's name, founders and advocate. Those stale values are sample
//     values like any others (tokenised), and the wording is switched to
//     the singular (म…छु/मेरो), per the user's 2026-08-20 decision.
//
//  The sources name real clients, founders, citizenship numbers and
//  addresses, and must NEVER be committed (CLAUDE.md §1 rule 7) — their
//  values live in the gitignored sample-values-cr.local.mjs.
// ════════════════════════════════════════════
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { CR_CORRECTIONS } from './correctionsCr.mjs';
import {
  readDocx, writeDocx, splitBody, stripProofErr, createTransformer, createPageBreakStyle,
  walkBody, swapFonts, stripHighlight, stripListBullet, mangalToNirmala, remapFontSizes,
  tightDocDefaults, assertTokenised, assertCount, swapExact, allText, paragraphText, PARA_RE,
} from './core.mjs';

let CR_SAMPLE;
try {
  ({ CR_SAMPLE } = await import('./sample-values-cr.local.mjs'));
} catch {
  console.error(
    'Missing tools/registrarDocx/sample-values-cr.local.mjs.\n' +
    "This file holds the real clients' sample values from the two source documents " +
    'and is deliberately gitignored (CLAUDE.md §1 rule 7 — this repo is public). ' +
    'Recreate it from the shape documented at the top of that file, reading the values ' +
    'off the source documents (CR_DEBUG=1 dumps every decoded paragraph), and re-run.'
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2];
const srcPath = process.argv[3];
if (!['multi', 'single'].includes(variant) || !srcPath) {
  console.error('Usage: node buildCompanyReg.mjs multi|single "<path to source .docx>"');
  process.exit(1);
}
const OUT_PATH = join(__dirname, '..', '..', 'assets', 'templates', `company-registration-${variant}.docx`);
const S = CR_SAMPLE[variant];
const SP = n => ' '.repeat(n);
const TABS = n => '\t'.repeat(n);

// ════════════════════════════════════════════
//  TOKENISATION
// ════════════════════════════════════════════

// The three capital rows all carry the SAME sample figure in the multi
// source (authorized = issued = paid-up = 5 lakh), so figures are only ever
// tokenised per paragraph — a global rule could not tell them apart.
// Longest-first within each list so a shorter value can never match inside
// a longer one (the full प्राइभेट लिमिटेड form before the प्रा.लि. form,
// the dotted प्रा.लि. before the letter's dot-less प्रा.लि).
const GLOBAL_TOKENS = variant === 'multi' ? [
  [S.nameFull, '{{companyNameFull}}'],
  [S.nameEnglishHeader, '{{companyNameEnglish}}'],
  [S.nameEnglishBody, '{{companyNameEnglish}}'],
  [S.name, '{{companyName}}'],
  [S.nameNoDot, '{{companyName}}'],
  [S.address, '{{registeredAddress}}'],
] : [
  [S.name, '{{companyName}}'],
  [S.nameTight, '{{companyName}}'],
  [S.nameEnglish, '{{companyNameEnglish}}'],
  [S.address, '{{registeredAddress}}'],
  // the stale multi-client values on the letter/POA pages
  [S.stale.name, '{{companyName}}'],
  [S.stale.address, '{{registeredAddress}}'],
];

// The founder-pair signature block (letter + POA, multi only): two founders
// per row, second column conditional so an odd founder count renders a
// half-filled last row instead of a phantom name. The hand-counted tab/space
// runs between the columns become ONE tab against a real stop (installed
// post-walk), so the right column starts at the same x whatever the left
// name's length.
const PAIR_ROW = {
  heads: [
    '१.\tसंस्थापकको नाम, थरः–' + TABS(5) + '२.\tसंस्थापकको नाम, थरः–',
    '{{numLeft}}.\tसंस्थापकको नाम, थरः–\t{{#hasRight}}{{numRight}}.\tसंस्थापकको नाम, थरः–{{/hasRight}}',
  ],
  signs: [
    ' हस्ताक्षरः' + TABS(8) + 'हस्ताक्षरः',
    ' हस्ताक्षरः\t{{#hasRight}}हस्ताक्षरः{{/hasRight}}',
  ],
  thumbs: [
    'दा.' + SP(10) + 'बा.' + TABS(7) + 'दा.' + SP(10) + 'बा.',
    'दा.' + SP(10) + 'बा.\t{{#hasRight}}दा.' + SP(10) + 'बा.{{/hasRight}}',
  ],
};

const PARA_TOKENS = variant === 'multi' ? {
  // MOA §1 — collapse the 26 hand-typed alignment spaces before the English
  // name into a normal sentence space. (Runs after CR_CORRECTIONS, which has
  // already fixed अग्रेजीमा -> अंग्रेजीमा.)
  8: [['अंग्रेजीमा' + SP(26) + S.nameEnglishBody + ' भनिनेछ', 'अंग्रेजीमा {{companyNameEnglish}} भनिनेछ']],
  10: [[S.businessNature, '{{businessNature}}']],
  // The objectives loop body — the other eight objective paragraphs are
  // dropped; letters (क, ख, ग…) come from the module so the list renumbers
  // itself at any length.
  12: [['क)\t' + S.objective1, '{{letter}})\t{{text}}']],

  // The three capital rows. Words in brackets are DERIVED from the figures
  // by the module (user decision 2026-08-20) — the source's own bracket
  // words include a real mistake ("पाँच हजार" beside the 5-lakh issued
  // figure), which is exactly why they are never reproduced.
  42: [
    ['रु. ' + S.capFig, 'रु. {{authorizedCapitalFig}}'],
    [S.wordsAuthCap, '({{authorizedCapitalWords}} मात्र)'],
    ['दरका ' + S.sharesFig + ' ' + S.wordsShares + ' थान', 'दरका {{authorizedShares}} ({{authorizedSharesWords}}) थान'],
  ],
  // NOTE the order: the share phrase goes FIRST. This row's capital words
  // are the source's typo "(पाँच हजार रुपैया )" — the very same text as the
  // share-count words further along the sentence — and replaceAcross
  // replaces every occurrence, so the generic rule must only see the one
  // left after the specific "दरका … थान" phrase is done.
  43: [
    ['रु.' + S.capFig, 'रु. {{issuedCapitalFig}}'],
    ['दरका ' + S.sharesFig + ' ' + S.wordsShares + ' थान', 'दरका {{issuedShares}} ({{issuedSharesWords}}) थान'],
    [S.wordsWrongCap, '({{issuedCapitalWords}} मात्र)'],
  ],
  44: [
    ['रु.' + S.capFig, 'रु. {{paidupCapitalFig}}'],
    [S.wordsPlainCap, '({{paidupCapitalWords}} मात्र)'],
    ['दरका ' + S.sharesFig + ' ' + S.wordsShares + ' थान', 'दरका {{paidupShares}} ({{paidupSharesWords}}) थान'],
  ],

  // ── MOA founders table, data row 1 (the loop body) ──
  92: [[S.f1.name, '{{name}}']],
  93: [[S.f1.address, '{{address}}']],
  100: [[S.f1.father, '{{fatherName}}']],
  102: [[S.f1.cn, '{{citizenshipNo}}']],
  103: [[S.f1.cnDistrict, '{{citizenshipDistrict}}']],
  105: [[S.f1.shares, '{{shares}}']],
  109: [[S.f1.wName, '{{witnessName}}']],
  110: [[S.f1.wAddress, '{{witnessAddress}}']],
  114: [['ना.प्र.नं.' + S.f1.wCn, 'ना.प्र.नं. {{witnessCitizenshipNo}}']],
  116: [['जि.प्र.कां  ' + S.f1.wDistrict, 'जि.प्र.कां {{witnessDistrict}}']],

  162: [[S.advocate, '{{advocateName}}']],
  163: [[S.advocateLicense, '{{advocateLicense}}']],
  165: [[S.docDateLong, '{{docDateLong}}']],

  // AOA §3(ग) — the name runs straight into सम्झनु with no space.
  191: [['प्रा.लि.सम्झनु', 'प्रा.लि. सम्झनु']],
  184: [['articles of association', 'Articles of Association']],
  272: [['यस कम्पनीमा  ' + S.directorCount + ' जनाको', 'यस कम्पनीमा {{directorCount}} जनाको']],

  // ── AOA founders table, data row 1 — same tokens, second copy ──
  365: [[S.f1.name, '{{name}}']],
  366: [[S.f1.address, '{{address}}']],
  372: [[S.f1.father, '{{fatherName}}']],
  374: [[S.f1.cn, '{{citizenshipNo}}']],
  375: [[S.f1.cnDistrict, '{{citizenshipDistrict}}']],
  377: [[S.f1.shares, '{{shares}}']],
  381: [[S.f1.wName, '{{witnessName}}']],
  382: [[S.f1.wAddress, '{{witnessAddress}}']],
  386: [['ना.प्र.नं.' + S.f1.wCn, 'ना.प्र.नं. {{witnessCitizenshipNo}}']],
  388: [['जि.प्र.कां  ' + S.f1.wDistrict, 'जि.प्र.कां {{witnessDistrict}}']],

  429: [[S.advocate, '{{advocateName}}']],
  430: [[S.advocateLicense, '{{advocateLicense}}']],
  432: [[S.docDateLong, '{{docDateLong}}']],

  // The letter's date line: 28 hand-typed tabs pushed it right; the tabs go
  // and the paragraph is right-aligned post-walk instead.
  458: [['\t', ''], ['मितिः ' + S.letterDateNum, 'मितिः {{letterDateNum}}']],
  466: [['अधिवक्ता ' + S.advocate + 'लाई', 'अधिवक्ता {{advocateName}}लाई']],
  469: [['थान २', 'थान {{founderCount}}']],

  474: [PAIR_ROW.heads],
  475: [[S.pairNamesLine, SP(7) + 'नामः {{nameLeft}}\t{{#hasRight}}नामः {{nameRight}}{{/hasRight}}']],
  477: [PAIR_ROW.signs],
  478: [PAIR_ROW.thumbs],

  490: [PAIR_ROW.heads],
  491: [[S.pairNamesLine, SP(7) + 'नामः {{nameLeft}}\t{{#hasRight}}नामः {{nameRight}}{{/hasRight}}']],
  493: [PAIR_ROW.signs],
  494: [PAIR_ROW.thumbs],

  // The POA is executed the day the letter goes out, not the day the deeds
  // are dated — its ईति सम्वत line reads the letter date.
  497: [[S.docDateLong, '{{letterDateLong}}']],
} : {
  // ── SINGLE ──
  7: [['Ltd.  लेखिनेछ', 'Ltd. लेखिनेछ']],
  13: [[S.businessNature, '{{businessNature}}']],
  16: [['(क)   ' + S.objective1, '({{letter}})   {{text}}']],
  35: [
    ['रु ' + S.authCapFig, 'रु {{authorizedCapitalFig}}'],
    [S.authCapWords, '({{authorizedCapitalWords}} मात्र)'],
    ['दरका ' + S.authShares + ' थान', 'दरका {{authorizedShares}} थान'],
  ],
  36: [
    ['रु ' + S.issuedCapFig, 'रु {{issuedCapitalFig}}'],
    [S.issuedCapWords, '({{issuedCapitalWords}} मात्र)'],
    ['दरका ' + S.issuedShares + ' थान', 'दरका {{issuedShares}} थान'],
  ],
  37: [
    ['पूँजी ' + S.issuedCapFig, 'पूँजी रु {{paidupCapitalFig}}'],
    [S.issuedCapWords, '({{paidupCapitalWords}} मात्र)'],
  ],

  // ── MOA founders table (single data row — flat tokens, no loop) ──
  66: [[S.f1.name, '{{founderName}}']],
  67: [['ठेगाना ः' + S.f1.address, 'ठेगाना: {{founderAddress}}']],
  73: [[S.f1.fatherA, '{{fatherName}}']],       // name's second line ¶74 is dropped
  78: [[S.f1.cn, '{{citizenshipNo}}']],
  79: [[S.f1.cnDistrict, '{{citizenshipDistrict}}']],
  82: [[S.f1.shares, '{{founderShares}}']],
  86: [['नाम  ' + S.f1.wName, 'नाम: {{witnessName}}']],
  87: [['ठेगाना  ः  ः' + S.f1.wAddress, 'ठेगाना: {{witnessAddress}}']],
  95: [[S.f1.wCn, '{{witnessCitizenshipNo}}']],
  96: [[S.f1.wDistrict, '{{witnessDistrict}}']],

  100: [[S.drafter, '{{advocateName}}']],
  101: [[S.docDateNum, '{{docDateNum}}']],
  102: [[S.docDateLong, '{{docDateLong}}']],

  // AOA — tidy the hand-typed alignment spaces around the name.
  110: [['कम्पनीको नाम   शिखर', 'कम्पनीको नाम शिखर'], ['Ltd.  लेखिनेछ', 'Ltd. लेखिनेछ']],
  116: [['भन्नाले    शिखर', 'भन्नाले शिखर']],
  174: [['म   शिखर', 'म शिखर']],

  // ── AOA founders table — same flat tokens, second copy ──
  184: [[S.f1.name, '{{founderName}}']],
  185: [['ठेगाना ः' + S.f1.address, 'ठेगाना: {{founderAddress}}']],
  191: [[S.f1.fatherA, '{{fatherName}}']],
  196: [[S.f1.cn, '{{citizenshipNo}}']],
  197: [[S.f1.cnDistrict, '{{citizenshipDistrict}}']],
  200: [[S.f1.shares, '{{founderShares}}']],
  204: [['नाम  ' + S.f1.wName, 'नाम: {{witnessName}}']],
  205: [['ठेगाना  ः  ः' + S.f1.wAddress, 'ठेगाना: {{witnessAddress}}']],
  213: [[S.f1.wCn, '{{witnessCitizenshipNo}}']],
  214: [[S.f1.wDistrict, '{{witnessDistrict}}']],

  218: [[S.drafter, '{{advocateName}}']],
  219: [[S.docDateNum, '{{docDateNum}}']],
  220: [[S.docDateLong, '{{docDateLong}}']],

  226: [['\t', ''], ['मितिः ' + S.stale.letterDateNum, 'मितिः {{letterDateNum}}']],

  // The letter, singular (user decision 2026-08-20): one founder writes म…छु.
  234: [
    ['अधिवक्ता ' + S.stale.advocate + 'लाई', 'अधिवक्ता {{advocateName}}लाई'],
    ['पेश गरेको छौं', 'पेश गरेको छु'],
    ['जानकारी गराउँदछौं', 'जानकारी गराउँदछु'],
    ['अनुरोध गर्दछौं', 'अनुरोध गर्दछु'],
  ],
  237: [['थान २', 'थान {{founderCount}}']],

  // The letter's signature block has one founder — trim the trailing tabs
  // that used to reach toward a second column.
  241: [['१.\tसंस्थापकको नाम, थरः–' + TABS(6), '१.\tसंस्थापकको नाम, थरः–']],
  242: [[S.stale.letterNameLine, SP(7) + 'नामः {{founderName}}']],
  244: [['\t', '']],
  247: [['\t', '']],

  // The POA, singular, and its stale second-founder column removed.
  256: [
    ['पठाएका छौं', 'पठाएको छु'],
    ['हाम्रो  मञ्जुर छौं', 'मेरो मञ्जुर छ'],
    ['हाम्रो मञ्जुर छ', 'मेरो मञ्जुर छ'],
  ],
  259: [['१.\tसंस्थापकको नाम, थरः–' + TABS(5) + '२.\tसंस्थापकको नाम, थरः–', '१.\tसंस्थापकको नाम, थरः–']],
  260: [[S.stale.pairNamesLine, SP(7) + 'नामः {{founderName}}']],
  263: [['हस्ताक्षरः' + TABS(8) + 'हस्ताक्षरः', 'हस्ताक्षरः']],
  266: [['दा.' + SP(10) + 'बा.' + TABS(7) + 'दा.' + SP(10) + 'बा.', 'दा.' + SP(10) + 'बा.']],
};

// Objectives 2..n of each source are dropped — the loop body renders any
// count. डौं (multi ¶117/389) is a stray two-glyph fragment in the witness
// cell, confirmed meaningless; the single source's father-name second line
// (¶74/192) is folded into the {{fatherName}} token on the line above.
const DROP = variant === 'multi'
  ? new Set([13, 14, 15, 16, 17, 18, 19, 20, 117, 389])
  : new Set([17, 18, 19, 20, 21, 22, 23, 24, 25, 74, 192]);

const INSERT_BEFORE = variant === 'multi'
  ? { 12: ['{{#objectives}}'], 474: ['{{#founderPairs}}'], 490: ['{{#founderPairs}}'] }
  : { 16: ['{{#objectives}}'] };
const INSERT_AFTER = variant === 'multi'
  ? { 12: ['{{/objectives}}'], 478: ['{{/founderPairs}}'], 494: ['{{/founderPairs}}'] }
  : { 16: ['{{/objectives}}'] };

// Sub-document boundaries — AOA, application letter, POA each start a fresh
// sheet; the MOA/AOA bodies flow across sheets naturally (they are genuinely
// multi-page documents). Verified against the sources' own
// <w:lastRenderedPageBreak/> markers.
const SECTION_STARTS = variant === 'multi' ? [179, 458, 487] : [104, 226, 256];

// Header blocks are centred as real Word alignment instead of the sources'
// leading-space runs (4–49 spaces per line, tuned to one client's name).
const CENTER = variant === 'multi'
  ? new Set([1, 2, 3, 4, 5, 6, 179, 180, 181, 182, 183, 184])
  : new Set([3, 4, 5, 6, 104, 105, 106, 107, 108, 109]);

// ════════════════════════════════════════════
//  BUILD
// ════════════════════════════════════════════

const files = await readDocx(srcPath);
let xml = stripProofErr(files['word/document.xml'].toString('utf8'));

// Theme-font runs (w:asciiTheme, no w:ascii) hold the Latin English name;
// give them an explicit Latin font so the transformer's Preeti default
// cannot decode them into Devanagari garbage.
let themeRuns = 0;
xml = xml.replace(/<w:rFonts ([^>]*w:asciiTheme="[^"]*"[^>]*)\/>/g, (m, attrs) => {
  if (/w:ascii="/.test(attrs)) return m;
  themeRuns++;
  return '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>';
});
console.log('theme-font runs made explicit:', themeRuns);

const { head, body, tail } = splitBody(xml);
console.log('source: %d paragraph(s), %d table(s)',
  (body.match(/<w:p\b/g) || []).length, (body.match(/<w:tbl>/g) || []).length);

const { transformParagraph, mismatches, repaired, debugLines } = createTransformer({
  corrections: CR_CORRECTIONS,
  globalTokens: GLOBAL_TOKENS,
  paraTokens: PARA_TOKENS,
  debug: !!process.env.CR_DEBUG,
});

// Wraps the core transform to centre the header paragraphs — the alignment
// belongs to the paragraph, not to hand-counted spaces, so the leading
// space runs go and a real <w:jc> arrives.
function stripLeadingSpaces(pXml) {
  let done = false;
  return pXml.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (m, a, txt, b) => {
    if (done) return m;
    const t = txt.replace(/^ +/, '');
    if (t === '') return a + b;
    done = true;
    return a + t + b;
  });
}
function centerParagraph(pXml) {
  let out = stripLeadingSpaces(pXml);
  if (out.includes('<w:jc ')) return out;
  const JC = '<w:jc w:val="center"/>';
  if (/<w:pPr>/.test(out)) return out.replace(/(<w:pPr>)(<w:pStyle[^>]*\/>)?/, (m, a, st) => a + (st || '') + JC);
  if (/<w:pPr\/>/.test(out)) return out.replace('<w:pPr/>', '<w:pPr>' + JC + '</w:pPr>');
  return out.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr>' + JC + '</w:pPr>');
}
const transform = (pXml, idx) => {
  let out = transformParagraph(pXml, idx);
  // A section-start paragraph must not already carry a pStyle (the page
  // break arrives as one). Multi ¶179 has Word's stock "NoSpacing" — which
  // only re-states the spacing this build sets anyway — so it goes.
  if (SECTION_STARTS.includes(idx)) out = out.replace(/<w:pStyle w:val="NoSpacing"\/>/, '');
  return CENTER.has(idx) ? centerParagraph(out) : out;
};

const pageBreak = createPageBreakStyle('CrPageStart', 'CR Page Start');

let { out, count } = walkBody({
  body, transformParagraph: transform,
  sectionStarts: SECTION_STARTS, drop: DROP,
  insertBefore: INSERT_BEFORE, insertAfter: INSERT_AFTER,
  pageBreak,
});
console.log('paragraphs walked:', count);
if (repaired.length) console.log('boundary repaired in %d paragraph(s)', repaired.length);
if (process.env.CR_DEBUG) {
  writeFileSync(join(__dirname, `debug-cr-${variant}.local.txt`), debugLines.join('\n'), 'utf8');
  console.log('decoded dump -> debug-cr-%s.local.txt', variant);
}
if (mismatches.length) {
  throw new Error('group-decode mismatch in unreviewed paragraph(s): ' + mismatches.join(', ') +
    ' — decode each run-by-run against the whole paragraph before accepting it');
}

// ════════════════════════════════════════════
//  FOUNDERS TABLES — structural pass
//
//  Runs AFTER the walk (so paragraph indices above match the source) and
//  operates on whole <w:tr> elements, because a table row is the unit here:
//  a cell must hold at least one <w:p>, so "drop the second founder's
//  paragraphs" would produce invalid OOXML — the row goes as one piece.
// ════════════════════════════════════════════
{
  let tables = 0, removedRows = 0, loopsInstalled = 0, floatsRemoved = 0;
  out = out.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, tbl => {
    if (!tbl.includes('संस्थापकको नाम')) return tbl;
    tables++;
    if ((tbl.match(/<w:tbl>/g) || []).length !== 1) throw new Error('nested table inside a founders table — the row splitter cannot handle that');

    // The single source's tables are FLOATING (text-anchored <w:tblpPr>,
    // found 2026-08-21) — and a floating table ignores every pagination
    // keep rule, which is how a header row printed at the foot of one page
    // with its founder row on the next while Word reported cantSplit and
    // keepNext as set. Inline the table; its centred position survives as
    // a real <w:jc>.
    tbl = tbl.replace(/<w:tblpPr[^/]*\/>/g, () => { floatsRemoved++; return ''; });
    if (floatsRemoved && !/<w:tblPr>[\s\S]*?<w:jc /.test(tbl)) {
      tbl = tbl.replace(/(<w:tblW[^/]*\/>)/, '$1<w:jc w:val="center"/>');
    }

    let rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
    if (variant === 'multi') {
      const before = rows.length;
      rows = rows.filter(r => !r.includes(S.f2Name));
      removedRows += before - rows.length;
    }
    if (rows.length !== 2) throw new Error(`founders table should be header + one data row, found ${rows.length} rows`);

    if (variant === 'multi') {
      // {{#founders}} opens in the data row's first cell, {{/founders}}
      // closes in its last — docxtemplater expands that to the whole <w:tr>.
      let row = rows[1];
      if (!row.includes('{{name}}')) throw new Error('the data row lost its {{name}} token');
      const openMarker = '<w:p><w:r><w:t>{{#founders}}</w:t></w:r></w:p>';
      const closeMarker = '<w:p><w:r><w:t>{{/founders}}</w:t></w:r></w:p>';
      const firstCell = row.match(/<w:tc>(?:<w:tcPr>[\s\S]*?<\/w:tcPr>)?/);
      if (!firstCell) throw new Error('data row has no first cell');
      row = row.replace(firstCell[0], firstCell[0] + openMarker);
      const lastClose = row.lastIndexOf('</w:tc>');
      row = row.slice(0, lastClose) + closeMarker + row.slice(lastClose);
      rows[1] = row;
      loopsInstalled++;
    }

    // Keep the table together across page breaks (user-reported 2026-08-21:
    // the header row printed at the foot of one page with the founder row on
    // the next). Two real Word properties, not spacing tricks:
    //   * <w:cantSplit/> on every row — a row is never cut mid-way, so a row
    //     that doesn't fit moves whole to the next sheet. A many-founder
    //     table may still break BETWEEN rows, which is correct.
    //   * <w:keepNext/> on every paragraph of EVERY row — the header binds
    //     to the first founder row, each founder row binds to the next
    //     (the loop copies the data row's properties), and the last row
    //     binds onward into the मस्यौदाकार block below, so the whole
    //     signature unit — declaration, table, drafter, date — travels as
    //     one (user-reported 2026-08-21: with two founders the table broke
    //     between the founder rows, and the declaration got separated from
    //     its own table). When the unit outgrows a page — a many-founder
    //     board — Word breaks the chain between rows, which is the same
    //     "genuinely too long" exception the numbered points follow.
    rows = rows.map(r => {
      // The single source's rows already carry cantSplit (in a trPr after
      // tblPrEx); only the multi source's need it added. In the OOXML
      // schema trPr follows tblPrEx inside <w:tr>, so a fresh trPr goes
      // after that element when present.
      let withSplit = r;
      if (!/<w:cantSplit\/>/.test(r)) {
        withSplit = /<w:trPr>/.test(r)
          ? r.replace('<w:trPr>', '<w:trPr><w:cantSplit/>')
          : /<w:tblPrEx>[\s\S]*?<\/w:tblPrEx>/.test(r)
            ? r.replace(/(<\/w:tblPrEx>)/, '$1<w:trPr><w:cantSplit/></w:trPr>')
            : r.replace(/^(<w:tr\b[^>]*>)/, '$1<w:trPr><w:cantSplit/></w:trPr>');
      }
      // Skip self-closing empty paragraphs, and keep keepNext after any
      // pStyle (schema order: pStyle comes first in pPr).
      return withSplit
        .replace(/<w:keepNext\/>/g, '')
        .replace(/<w:p(?:\s[^>]*[^/])?>(?:<w:pPr>)?/g, m =>
          m.endsWith('<w:pPr>')
            ? m.replace(/<w:pPr>$/, '<w:pPr><w:keepNext/>')
            : m + '<w:pPr><w:keepNext/></w:pPr>')
        .replace(/<w:pPr><w:keepNext\/>(<w:pStyle[^>]*\/>)/g, '<w:pPr>$1<w:keepNext/>');
    });
    if (!rows.every(r => r.includes('<w:cantSplit/>'))) {
      throw new Error('cantSplit did not reach every founders-table row');
    }
    if (!rows.every(r => r.includes('<w:keepNext/>'))) throw new Error('a founders-table row got no keepNext');

    // reassemble: everything before the first row + rows + everything after the last
    const headEnd = tbl.indexOf('<w:tr');
    const tailStart = tbl.lastIndexOf('</w:tr>') + '</w:tr>'.length;
    return tbl.slice(0, headEnd) + rows.join('') + tbl.slice(tailStart);
  });
  if (tables !== 2) throw new Error(`expected 2 founders tables, found ${tables}`);
  console.log('floating-table anchors removed:', floatsRemoved);
  if (variant === 'multi') {
    if (removedRows !== 2) throw new Error(`expected to remove 2 second-founder rows, removed ${removedRows}`);
    if (loopsInstalled !== 2) throw new Error(`founders row loop installed ${loopsInstalled} times, expected 2`);
  }
  console.log('founders tables: %d processed, %d row(s) removed, %d loop(s) installed', tables, removedRows, loopsInstalled);
}

// ════════════════════════════════════════════
//  ALIGNMENT — real Word properties for what the sources spaced by hand
// ════════════════════════════════════════════

// Injects into the pPr of every paragraph containing `needle`; throws if the
// count of such paragraphs is not exactly `expect` — a fix that lands on the
// wrong number of paragraphs is worse than one that fails the build. When
// the injection is an alignment, any alignment/indent the paragraph already
// carries is stripped first — the multi source's letter-date line has its
// own <w:jc w:val="both"/> AND a negative right indent, and a second <w:jc>
// merely loses to them.
function injectPPr(s, needle, inject, expect, label) {
  let n = 0;
  const isAlignment = inject.includes('<w:jc');
  const RE = new RegExp(PARA_RE.source, 'g');
  const result = s.replace(RE, p => {
    if (!p.includes(needle)) return p;
    n++;
    if (isAlignment) p = p.replace(/<w:jc [^>]*\/>/g, '').replace(/<w:ind [^>]*\/>/g, '');
    if (/<w:pPr>/.test(p)) return p.replace(/(<w:pPr>)(<w:pStyle[^>]*\/>)?/, (m, a, st) => a + (st || '') + inject);
    if (/<w:pPr\/>/.test(p)) return p.replace('<w:pPr/>', '<w:pPr>' + inject + '</w:pPr>');
    return p.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr>' + inject + '</w:pPr>');
  });
  if (n !== expect) throw new Error(`${label}: matched ${n} paragraph(s), expected ${expect}`);
  return result;
}

// The letter's date sits against the right margin whatever the date's width.
out = injectPPr(out, 'मितिः {{letterDateNum}}', '<w:jc w:val="right"/>', 1, 'letter date right-align');

if (variant === 'multi') {
  // The founder-pair rows: first stop indents the "१." label, second starts
  // the right-hand column at mid-page.
  const PAIR_TABS = '<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="4680"/></w:tabs>';
  out = injectPPr(out, '{{numLeft}}', PAIR_TABS, 2, 'pair heading tab stops');
  out = injectPPr(out, 'नामः {{nameLeft}}', PAIR_TABS, 2, 'pair name tab stops');
  out = injectPPr(out, '{{#hasRight}}हस्ताक्षरः', PAIR_TABS, 2, 'pair sign tab stops');
  out = injectPPr(out, '{{#hasRight}}दा.', PAIR_TABS, 2, 'pair thumb tab stops');
}

// ════════════════════════════════════════════
//  KEEP EACH NUMBERED POINT TOGETHER  (user ask, 2026-08-21)
//
//  A दफा/नियम must not split across a page: its own lines stay together
//  (<w:keepLines/> — Word still splits a paragraph genuinely taller than a
//  page, which is the user's stated exception), and its sub-paragraphs
//  chain to it (<w:keepNext/> on every paragraph whose successor belongs to
//  the same point), so a point that doesn't fit moves whole to the next
//  sheet.
//
//  Telling a NEW top-level point from a sub-item is the subtle part — both
//  can be numbered "१." in these sources (दफा २६'s sub-items are dotted,
//  and दफा ५'s sub-list uses "१)" while some run to "६)"). The rule that
//  holds for both documents: a top-level point is DOT-numbered AND
//  continues the running sequence (topCounter + 1); paren forms and
//  out-of-sequence numbers are content of the current point. The counter
//  resets at every CrPageStart, because each sub-document restarts at १.
//  Blank spacers and loop-marker paragraphs break a chain (so rendered
//  loop iterations — objectives, founder pairs — never chain to each
//  other), and nothing binds INTO a page-break paragraph.
// ════════════════════════════════════════════
function keepPointsTogether(xml) {
  const DEV = '०१२३४५६७८९';
  const devInt = s => parseInt(s.replace(/[०-९]/g, d => DEV.indexOf(d)), 10);
  let keepLines = 0, keepNexts = 0;

  const chunks = xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/);
  let topCounter = 0;
  const processed = chunks.map((chunk, ci) => {
    if (chunk.startsWith('<w:tbl>')) return chunk;
    // A founders table follows this chunk: its declaration paragraph (the
    // chunk's last content paragraph — दफा १६/५३/&c.) binds INTO the table,
    // so the declaration, the table and the drafter block behind it travel
    // as one signature unit (user-reported 2026-08-21).
    const tableFollows = !!(chunks[ci + 1] && chunks[ci + 1].startsWith('<w:tbl>') && chunks[ci + 1].includes('संस्थापकको नाम'));

    const paras = [];
    const RE = new RegExp(PARA_RE.source, 'g');
    let m;
    while ((m = RE.exec(chunk))) paras.push({ xml: m[0], start: m.index, end: m.index + m[0].length });
    const texts = paras.map(p => paragraphText(p.xml).trim());

    const isBlank = t => t === '';
    const isMarker = t => /^\{\{[#/][^}]*\}\}$/.test(t);
    const classify = (t, pXml) => {
      if (pXml.includes('CrPageStart')) topCounter = 0;
      const dm = t.match(/^([०-९]+)\./);
      if (dm && devInt(dm[1]) === topCounter + 1) { topCounter++; return 'point'; }
      if (/^परिच्छेद/.test(t)) return 'point';   // chapter headings start a fresh block
      return 'body';
    };

    const kinds = paras.map((p, i) => isBlank(texts[i]) ? 'blank' : isMarker(texts[i]) ? 'marker' : classify(texts[i], p.xml));

    let outChunk = '', cursor = 0;
    paras.forEach((p, i) => {
      outChunk += chunk.slice(cursor, p.start);
      cursor = p.end;
      if (kinds[i] === 'blank' || kinds[i] === 'marker') { outChunk += p.xml; return; }
      const next = kinds[i + 1];
      const isLastContent = kinds.slice(i + 1).every(k => k === 'blank' || k === 'marker');
      const bindNext = (next === 'body' && !paras[i + 1].xml.includes('CrPageStart')) ||
        (tableFollows && isLastContent);
      let props = '<w:keepLines/>';
      keepLines++;
      if (bindNext) { props = '<w:keepNext/>' + props; keepNexts++; }
      let px = p.xml.replace(/<w:keepNext\/>|<w:keepLines\/>/g, '');
      if (/<w:pPr>/.test(px)) px = px.replace(/(<w:pPr>)(<w:pStyle[^>]*\/>)?/, (mm, a, st) => a + (st || '') + props);
      else if (/<w:pPr\/>/.test(px)) px = px.replace('<w:pPr/>', '<w:pPr>' + props + '</w:pPr>');
      else px = px.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr>' + props + '</w:pPr>');
      outChunk += px;
    });
    outChunk += chunk.slice(cursor);
    return outChunk;
  });
  console.log('point keep-together: %d keepLines, %d keepNext chains', keepLines, keepNexts);
  if (!keepLines) throw new Error('keepPointsTogether matched no paragraphs — the walk changed shape');
  return processed.join('');
}
out = keepPointsTogether(out);

// The source types every colon as the Devanagari visarga (Preeti keyboard
// habit) and is inconsistent about the space before it — same normalisation,
// same क्रमशः guard, as the BM/AGM and Company Secretary templates.
const fixVisargaColon = s => {
  const GUARD = '';
  return s
    .replace(/क्रमशः/g, 'क्रमश' + GUARD)
    .replace(/ः/g, ':')
    .replace(new RegExp(GUARD, 'g'), 'ः')
    .replace(/ +:/g, ':');
};

// ── PRINT SIZES ──
// Explicit tables (the CS_SIZES idiom), not scale factors: the body drops to
// 11pt while the company name only comes down to 16pt, and a factor cannot
// express that. Keys are each SOURCE's half-point values.
const CR_SIZES = variant === 'multi' ? {
  26: 24,   // 13pt -> 12pt   "Pvt.Ltd" runs
  28: 24,   // 14pt -> 12pt   English name lines, "Memorandum of Association"
  30: 22,   // 15pt -> 11pt   header small line + founders table
  32: 22,   // 16pt -> 11pt   BODY
  34: 22,   // 17pt -> 11pt   body variant
  36: 24,   // 18pt -> 12pt   titles + letter/POA text
  38: 28,   // 19pt -> 14pt   letter subject line
  52: 32,   // 26pt -> 16pt   company name (headers)
} : {
  28: 24,   // 14pt -> 12pt   English name, परिच्छेद headings
  32: 22,   // 16pt -> 11pt   BODY
  34: 22,   // 17pt -> 11pt   the Normal default (appears in the body as szCs)
  36: 24,   // 18pt -> 12pt   headers + letter/POA text
  38: 28,   // 19pt -> 14pt   letter subject line
  44: 32,   // 22pt -> 16pt   company name (headers)
};
// styles.xml additionally carries each source's Normal-style default size.
const CR_STYLE_SIZES = variant === 'multi' ? { ...CR_SIZES, 24: 22 } : { ...CR_SIZES, 34: 22 };

const unmappedSizes = new Set();
const scaleCr = s => remapFontSizes(s, CR_SIZES, v => unmappedSizes.add(v));

// The प्रबन्ध पत्र / नियमावली titles share their source size with ordinary
// letter text, so the global remap alone would leave them body-sized; each
// title paragraph is bumped to 14pt by name.
function bumpTitle(s, title, sz, expect, label) {
  let n = 0;
  const RE = new RegExp(PARA_RE.source, 'g');
  const result = s.replace(RE, p => {
    if (paragraphText(p).trim() !== title) return p;
    n++;
    return p.replace(/<w:(sz|szCs) w:val="\d+"\/>/g, (_, tag) => `<w:${tag} w:val="${sz}"/>`);
  });
  if (n !== expect) throw new Error(`${label}: matched ${n} paragraph(s), expected ${expect}`);
  return result;
}

// ── EMPTY SPACER PARAGRAPHS — same treatment as the CS template ──
// Empty paragraphs are these documents' vertical spacing; each is pinned to
// its own small fixed height so the body line height (LINE_HEIGHT below)
// can breathe without multiplying every gap with it.
const SPACER_SZ = 16;
const SPACER_SPACING = '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>';
const shrinkEmptyParagraphs = s => s.replace(
  /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,
  p => {
    if (/<w:t[ >]/.test(p)) return p;
    let o = p
      .replace(/<w:(sz|szCs) w:val="\d+"\/>/g, (_, tag) => `<w:${tag} w:val="${SPACER_SZ}"/>`)
      .replace(/<w:spacing\b[^/]*\/>/g, '');
    if (/<w:pPr>/.test(o)) {
      o = /<w:pStyle [^>]*\/>/.test(o)
        ? o.replace(/(<w:pStyle [^>]*\/>)/, '$1' + SPACER_SPACING)
        : o.replace('<w:pPr>', '<w:pPr>' + SPACER_SPACING);
    } else {
      o = o
        .replace(/^(<w:p\b[^>]*)\/>$/, `$1><w:pPr>${SPACER_SPACING}</w:pPr></w:p>`)
        .replace(/^(<w:p\b[^>]*>)(?!<w:pPr)/, `$1<w:pPr>${SPACER_SPACING}</w:pPr>`);
    }
    return o;
  }
);

// Body line height — 1.30. Chosen from a measured grid (see the footer):
// 1.40 (the CS template's value) costs two extra sheets on the 5-founder
// multi set for no legibility gain a 17-page statutory filing needs, and
// 1.20 saves two more but is the "everything feels so close" territory the
// firm already rejected once on the CS template. Also a floor for the app's
// preview, which maps it to flat CSS line-height.
const LINE_HEIGHT = Number(process.env.CR_LINE || 312);

// ── ASSEMBLE ──
let built = head + out + tail;
built = fixVisargaColon(built);
built = scaleCr(built);
built = bumpTitle(built, variant === 'multi' ? 'प्रवन्ध पत्र' : 'प्रबन्ध–पत्र', 28, 1, 'MOA title size');
built = bumpTitle(built, 'नियमावली', 28, 1, 'AOA title size');
built = shrinkEmptyParagraphs(built);
built = stripListBullet(stripHighlight(swapFonts(built)));
built = mangalToNirmala(built);

// Both templates print on A4 — the multi source was set up for US Letter,
// which no Nepali registrar uses.
if (variant === 'multi') {
  built = swapExact(built, '<w:pgSz w:w="12240" w:h="15840"/>', '<w:pgSz w:w="11906" w:h="16838"/>', 'A4 page size');
}

files['word/document.xml'] = Buffer.from(built, 'utf8');
for (const name of ['word/fontTable.xml', 'word/settings.xml']) {
  if (files[name]) files[name] = Buffer.from(mangalToNirmala(swapFonts(files[name].toString('utf8'))), 'utf8');
}
{
  let styles = files['word/styles.xml'].toString('utf8');
  styles = tightDocDefaults(styles, LINE_HEIGHT);
  // The multi source's Normal style carries its own <w:spacing line="240">,
  // which would override the document default line height for every body
  // paragraph — the reading leading has to land on Normal itself.
  styles = styles.replace(
    /(<w:style w:type="paragraph" w:default="1" w:styleId="Normal">[\s\S]*?)<w:spacing[^/]*\/>/,
    `$1<w:spacing w:after="0" w:line="${LINE_HEIGHT}" w:lineRule="auto"/>`
  );
  styles = remapFontSizes(styles, CR_STYLE_SIZES);
  styles = mangalToNirmala(swapFonts(styles));
  styles = pageBreak.ensureDefined(styles);
  files['word/styles.xml'] = Buffer.from(styles, 'utf8');
}

// ════════════════════════════════════════════
//  REGRESSION CHECKS
// ════════════════════════════════════════════
{
  const doc = files['word/document.xml'].toString('utf8');

  if (doc.includes('Preeti')) throw new Error('a Preeti font reference survived');
  if (doc.includes('<w:tblpPr')) throw new Error('a floating-table anchor survived — a positioned table ignores cantSplit/keepNext and the founders table splits again');
  if (doc.includes('w:highlight')) throw new Error('a highlight survived — the firm marks fill-in spots in colour and none of it may print');
  if (doc.includes('<w:proofErr')) throw new Error('a proofErr marker survived');
  if (doc.includes('w:numPr') || doc.includes('ListParagraph')) throw new Error('a stray list bullet survived');

  if (unmappedSizes.size) {
    throw new Error('font size(s) with no CR_SIZES entry: ' +
      [...unmappedSizes].sort((a, b) => a - b).map(v => `${v} (${v / 2}pt)`).join(', '));
  }
  {
    const targets = new Set(Object.values(CR_SIZES).concat([SPACER_SZ, 28]));
    const stray = [...new Set([...doc.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map(m => Number(m[1])))].filter(v => !targets.has(v));
    if (stray.length) throw new Error('unexpected font size(s) in the built template: ' + stray.join(', '));
  }

  assertTokenised(doc, GLOBAL_TOKENS);
  const text = allText(doc);
  const sampleChecks = variant === 'multi' ? [
    ['founder 1 name', S.f1.name], ['founder 2 name', S.f2Name],
    ['founder 1 witness', S.f1.wName], ['founder 1 citizenship no', S.f1.cn],
    ['capital figure', S.capFig], ['share count', S.sharesFig],
    ['document date', S.docDateLong], ['letter date', S.letterDateNum],
    ['advocate', S.advocate], ['advocate license', S.advocateLicense],
    ['business nature', S.businessNature], ['objective 1', S.objective1],
    ['director count phrase', 'यस कम्पनीमा  ' + S.directorCount + ' जनाको'],
  ] : [
    ['founder name', S.f1.name], ['founder father', S.f1.fatherA],
    ['witness name', S.f1.wName], ['founder citizenship no', S.f1.cn],
    ['authorized capital', S.authCapFig], ['issued capital', S.issuedCapFig],
    ['authorized shares', S.authShares], ['issued shares', S.issuedShares],
    ['document date', S.docDateLong], ['document date (numeric)', S.docDateNum],
    ['stale company', S.stale.name], ['stale advocate', S.stale.advocate],
    ['stale founder 1', S.stale.founder1], ['stale founder 2', S.stale.founder2],
    ['business nature', S.businessNature], ['objective 1', S.objective1],
  ];
  for (const [label, value] of sampleChecks) {
    if (value && text.includes(value)) throw new Error(`sample ${label} left un-tokenised — it would print on every generated document`);
  }
  console.log('tokenisation check: OK (no sample value left in the template)');

  const TOKENS = variant === 'multi' ? [
    'companyName', 'companyNameFull', 'companyNameEnglish', 'registeredAddress', 'businessNature',
    'letter', 'text', 'authorizedCapitalFig', 'authorizedCapitalWords', 'authorizedShares', 'authorizedSharesWords',
    'issuedCapitalFig', 'issuedCapitalWords', 'issuedShares', 'issuedSharesWords',
    'paidupCapitalFig', 'paidupCapitalWords', 'paidupShares', 'paidupSharesWords',
    'directorCount', 'founderCount', 'docDateLong', 'letterDateNum', 'letterDateLong',
    'advocateName', 'advocateLicense',
    'name', 'address', 'fatherName', 'citizenshipNo', 'citizenshipDistrict', 'shares',
    'witnessName', 'witnessAddress', 'witnessCitizenshipNo', 'witnessDistrict',
    'numLeft', 'nameLeft', 'numRight', 'nameRight',
  ] : [
    'companyName', 'companyNameEnglish', 'registeredAddress', 'businessNature',
    'letter', 'text', 'authorizedCapitalFig', 'authorizedCapitalWords', 'authorizedShares',
    'issuedCapitalFig', 'issuedCapitalWords', 'issuedShares',
    'paidupCapitalFig', 'paidupCapitalWords',
    'founderCount', 'docDateLong', 'docDateNum', 'letterDateNum',
    'advocateName',
    'founderName', 'founderAddress', 'fatherName', 'citizenshipNo', 'citizenshipDistrict', 'founderShares',
    'witnessName', 'witnessAddress', 'witnessCitizenshipNo', 'witnessDistrict',
  ];
  for (const tok of TOKENS) {
    if (!doc.includes('{{' + tok + '}}')) throw new Error(`token {{${tok}}} is missing from the built template`);
  }

  assertCount(doc, '{{#objectives}}', 1, 'objectives loop open');
  assertCount(doc, '{{/objectives}}', 1, 'objectives loop close');
  if (variant === 'multi') {
    assertCount(doc, '{{#founders}}', 2, 'founders row loop open');       // MOA + AOA tables
    assertCount(doc, '{{/founders}}', 2, 'founders row loop close');
    assertCount(doc, '{{#founderPairs}}', 2, 'founder pairs loop open');  // letter + POA
    assertCount(doc, '{{/founderPairs}}', 2, 'founder pairs loop close');
    assertCount(doc, '{{companyNameFull}}', 2, 'company name (full form)');
    // headers of MOA + AOA, plus §1 of each (the AOA restates the name clause)
    assertCount(doc, '{{companyNameEnglish}}', 4, 'company name (English)');
  } else {
    assertCount(doc, '{{#founders}}', 0, 'founders row loop (single has none)');
    assertCount(doc, '{{founderName}}', 4, 'founder name');               // 2 tables + letter + POA
    assertCount(doc, '{{companyNameEnglish}}', 2, 'company name (English)');
  }

  const styleUses = (doc.match(new RegExp('<w:pStyle w:val="' + pageBreak.styleId + '"/>', 'g')) || []).length;
  if (styleUses !== SECTION_STARTS.length) {
    throw new Error(`page-break style applied ${styleUses} times, expected ${SECTION_STARTS.length}`);
  }
  if (!files['word/styles.xml'].toString('utf8').includes(pageBreak.styleId)) {
    throw new Error('page-break style used but never defined in styles.xml');
  }
  const trCount = (doc.match(/<w:tr[ >]/g) || []).length;
  if (trCount !== 4) throw new Error(`expected 4 table rows (2 tables × header + data), found ${trCount}`);
  console.log('structure check: OK (%d section starts, %d table rows)', styleUses, trCount);
}

await writeDocx(OUT_PATH, files);
console.log('written:', OUT_PATH);

// ── WORD PAGINATION ──
// Measured, never assumed (CLAUDE.md §2/§12). After building BOTH variants:
//   node sampleCompanyReg.mjs
//   powershell -File wordPages.ps1 sample-cr-single.docx=9 sample-cr-multi-2.docx=18 sample-cr-multi-5.docx=22
//
// The line-height grid, measured 2026-08-20 (single / multi-2 / multi-5):
//   336 (1.40)   9 / 17 / 19
//   312 (1.30)   9 / 17 / 17   <- chosen
//   288 (1.20)   9 / 15 / 17
// keepPointsTogether (2026-08-21) then moved the multi counts to 18 / 22 —
// whole दफा now step to a fresh sheet instead of splitting, and the whole
// signature unit (declaration + founders table + drafter block) travels as
// one, which is the user's explicit trade. Verified the same day: ZERO
// paragraphs span a page boundary, every multi content page begins with a
// numbered point heading, and the signature units sit on ONE page in the
// single and 2-founder samples (a 5-founder unit legitimately spans — the
// same "genuinely too long" exception the numbered points follow).
// Unlike BM/AGM there is no one-sheet-per-section constraint here — the MOA
// and AOA are genuinely multi-page — so the counts above are a regression
// baseline, not a design target. The sources' own Preeti pages were denser
// (16pt, single-spaced, byte-narrow glyphs); real Unicode Devanagari at a
// readable size simply takes more sheets, and that is accepted.
