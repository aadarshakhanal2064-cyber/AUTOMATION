// ════════════════════════════════════════════
//  COMPANY REGISTRATION — fidelity harness
//
//  Renders each built template with its own source's REAL sample values and
//  diffs the text, line by line, against the source document's decoded text.
//  This is the check a page count cannot do: the first BM/AGM build produced
//  the right number of pages while a table lay flattened and three pages
//  stayed hard-coded to the sample client.
//
//  Usage:
//    node fidelityCompanyReg.mjs multi  "<path to the multi source .docx>"
//    node fidelityCompanyReg.mjs single "<path to the single source .docx>"
//
//  The BASELINE is the source walked through the same corrections the build
//  applies (so a spelling fix never reads as a regression), minus the
//  paragraphs the template legitimately no longer renders: objectives 2..n
//  (loop body covers any count), the multi source's second founder row
//  (rendered by the row loop instead), and the stray fragments the build
//  drops. Lines are normalised on both sides — tabs to spaces, space runs
//  collapsed, visarga colons unified, blanks dropped — because spacing is
//  exactly what the build deliberately reworks into real Word properties.
//
//  Every surviving difference must appear in EXPECTED_DIFFS below with a
//  reason. A new difference — or a documented one disappearing — fails the
//  run. Diffs print to the console only, never to a file: the text is a
//  real client's document (CLAUDE.md §1 rule 7).
//
//  Baseline as of 2026-08-20 (this comment is the record if they drift):
//    multi : 327 baseline lines = 327 rendered, 26 diff entries
//    single: 180 baseline lines = 180 rendered, 40 diff entries
// ════════════════════════════════════════════
import { CR_CORRECTIONS } from './correctionsCr.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import {
  readDocx, splitBody, stripProofErr, createTransformer, walkBody, PARA_RE, paragraphText,
} from './core.mjs';

const { CR_SAMPLE } = await import('./sample-values-cr.local.mjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2];
const srcPath = process.argv[3];
if (!['multi', 'single'].includes(variant) || !srcPath) {
  console.error('Usage: node fidelityCompanyReg.mjs multi|single "<path to source .docx>"');
  process.exit(1);
}
const S = CR_SAMPLE[variant];

// Paragraphs (1-based source indices) the template legitimately does not
// render — mirrors buildCompanyReg.mjs's DROP sets plus the multi source's
// second founder table rows, which the {{#founders}} row loop replaces.
const EXCLUDE = variant === 'multi'
  ? new Set([
      ...[13, 14, 15, 16, 17, 18, 19, 20, 117, 389],
      ...Array.from({ length: 155 - 118 + 1 }, (_, i) => 118 + i),
      ...Array.from({ length: 427 - 390 + 1 }, (_, i) => 390 + i),
    ])
  : new Set([17, 18, 19, 20, 21, 22, 23, 24, 25, 74, 192]);

// ── The baseline: decoded + corrected source text ──
const files = await readDocx(srcPath);
let xml = stripProofErr(files['word/document.xml'].toString('utf8'));
xml = xml.replace(/<w:rFonts ([^>]*w:asciiTheme="[^"]*"[^>]*)\/>/g,
  (m, attrs) => /w:ascii="/.test(attrs) ? m : '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>');
const { body } = splitBody(xml);
const { transformParagraph, debugLines } = createTransformer({ corrections: CR_CORRECTIONS, debug: true });
walkBody({ body, transformParagraph, log: () => {} });

const norm = s => s
  .replace(/क्रमशः/g, 'क्रमश')
  .replace(/ः/g, ':')
  .replace(//g, 'ः')
  .replace(/ +:/g, ':')
  .replace(/\t/g, ' ')
  .replace(/ {2,}/g, ' ')
  .trim();

const baseline = [];
for (const line of debugLines) {
  const m = line.match(/^(\d+)\t([\s\S]*)$/);
  if (!m || EXCLUDE.has(Number(m[1]))) continue;
  // The transformer's debug dump is taken BEFORE its replacement pass, so
  // the corrections are applied here — a spelling the build fixes must not
  // read as a difference.
  let t = m[2];
  for (const [from, to] of CR_CORRECTIONS) t = t.split(from).join(to);
  t = norm(t);
  if (t) baseline.push(t);
}

// ── The render: the template filled with the source's own values ──
const F1 = S.f1;
const data = variant === 'multi' ? {
  companyName: S.name,
  companyNameFull: S.nameFull,
  companyNameEnglish: S.nameEnglishHeader,
  registeredAddress: S.address,
  businessNature: S.businessNature,
  objectives: [{ letter: 'क', text: S.objective1 }],
  authorizedCapitalFig: S.capFig, authorizedCapitalWords: 'पाँच लाख रुपैयाँ',
  authorizedShares: S.sharesFig, authorizedSharesWords: 'पाँच हजार',
  issuedCapitalFig: S.capFig, issuedCapitalWords: 'पाँच लाख रुपैयाँ',
  issuedShares: S.sharesFig, issuedSharesWords: 'पाँच हजार',
  paidupCapitalFig: S.capFig, paidupCapitalWords: 'पाँच लाख रुपैयाँ',
  paidupShares: S.sharesFig, paidupSharesWords: 'पाँच हजार',
  directorCount: S.directorCount, founderCount: '२',
  docDateLong: S.docDateLongNorm, letterDateNum: S.letterDateNum, letterDateLong: S.docDateLongNorm,
  advocateName: S.advocate, advocateLicense: S.advocateLicense,
  founders: [{
    name: F1.name, address: F1.address, fatherName: F1.father,
    citizenshipNo: F1.cn, citizenshipDistrict: F1.cnDistrict, shares: F1.shares,
    witnessName: F1.wName, witnessAddress: F1.wAddress,
    witnessCitizenshipNo: F1.wCn, witnessDistrict: F1.wDistrict,
  }],
  founderPairs: [{ numLeft: '१', nameLeft: F1.name, hasRight: true, numRight: '२', nameRight: S.f2Name }],
} : {
  companyName: S.name,
  companyNameEnglish: S.nameEnglish,
  registeredAddress: S.address,
  businessNature: S.businessNature,
  objectives: [{ letter: 'क', text: S.objective1 }],
  authorizedCapitalFig: S.authCapFig, authorizedCapitalWords: 'एक करोड रुपैयाँ', authorizedShares: S.authShares,
  issuedCapitalFig: S.issuedCapFig, issuedCapitalWords: 'पचास लाख रुपैयाँ', issuedShares: S.issuedShares,
  paidupCapitalFig: S.issuedCapFig, paidupCapitalWords: 'पचास लाख रुपैयाँ',
  founderCount: '१',
  docDateLong: S.docDateLong, docDateNum: S.docDateNum, letterDateNum: S.stale.letterDateNum,
  advocateName: S.drafter,
  founderName: F1.name, founderAddress: F1.address, fatherName: F1.fatherA + ' ' + F1.fatherB,
  citizenshipNo: F1.cn, citizenshipDistrict: F1.cnDistrict, founderShares: F1.shares,
  witnessName: F1.wName, witnessAddress: F1.wAddress,
  witnessCitizenshipNo: F1.wCn, witnessDistrict: F1.wDistrict,
};

const tplPath = join(__dirname, '..', '..', 'assets', 'templates', `company-registration-${variant}.docx`);
const doc = new Docxtemplater(new PizZip(readFileSync(tplPath)), {
  delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true,
});
doc.render(data);
const outXml = doc.getZip().file('word/document.xml').asText();

const rendered = [];
{
  const RE = new RegExp(PARA_RE.source, 'g');
  let m;
  while ((m = RE.exec(outXml))) {
    // <w:tab/> reads as a space, matching how the baseline treats \t —
    // paragraphText alone would run "१." straight into the word after it.
    const t = norm(paragraphText(m[0].replace(/<w:tab\/>/g, '<w:t> </w:t>'))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
    if (t) rendered.push(t);
  }
}

// ── LCS diff ──
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

const diffs = diffLines(baseline, rendered);

// Every surviving difference, matched by substring against the diff line —
// a '-' entry is source-only text, a '+' entry is render-only text. The
// lists live in the GITIGNORED sample-values file, because the substrings
// quote the sources: founder and witness names, a citizenship number, the
// real company names (CLAUDE.md §1 rule 7 — the first draft of this file
// held them as literals right here, which is exactly the leak-through-docs
// door the playbook's Phase 6 warns about). The CATEGORIES they document:
//   * derived capital/share words replacing the sources' hand-typed
//     brackets (incl. the multi issued-row typo)
//   * one company-name / English-name spelling throughout a render, where
//     each source spells its own name two or three ways
//   * label spacing (नामः / ठेगानाः / ना.प्र.नं.) and title-case fixes
//   * single only: the stale letter/POA values replaced, the singular
//     rewrite, the second-founder column removed, थान following the real
//     founder count, the father name folded onto one line
const EXPECTED_DIFFS = CR_SAMPLE.expectedDiffs[variant];

let unexpected = 0;
for (const [sign, line] of diffs) {
  const known = EXPECTED_DIFFS.find(([s, sub]) => s === sign && line.includes(sub));
  if (!known) {
    unexpected++;
    console.log('UNEXPECTED', sign, line.slice(0, 160));
  }
}
const unused = EXPECTED_DIFFS.filter(([s, sub]) => !diffs.some(([ds, dl]) => ds === s && dl.includes(sub)));

console.log('%s: %d baseline line(s), %d rendered line(s), %d diff entr(ies)',
  variant, baseline.length, rendered.length, diffs.length);
if (unexpected) {
  console.error(unexpected + ' UNEXPECTED difference(s) — review each against the source before accepting it here');
  process.exit(1);
}
if (unused.length) {
  console.error('documented difference(s) no longer occur — remove them or find what changed: ' +
    unused.map(([s, sub]) => s + sub).join(' | '));
  process.exit(1);
}
console.log('fidelity: OK — every difference is documented and every documented difference occurs');
