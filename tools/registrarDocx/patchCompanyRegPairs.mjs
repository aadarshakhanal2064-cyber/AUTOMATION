// ════════════════════════════════════════════
//  COMPANY REGISTRATION — founder-pair signature block alignment patch
//
//    node patchCompanyRegPairs.mjs [--check]
//
//  Applies to assets/templates/company-registration-multi.docx exactly the
//  founder-pair geometry buildCompanyReg.mjs now produces, so the shipped
//  template matches the build script without a rebuild.
//
//  ── Why this exists rather than a rebuild ──
//  The two Company Registration templates are built from the firm's real
//  Preeti source documents, which name real clients and are deliberately not
//  in this repo (CLAUDE.md §1 rule 7). Those sources were not on the machine
//  when this fix was made, so the built artifact is patched in place instead.
//  buildCompanyReg.mjs carries the SAME change, so the next rebuild from
//  source produces this file and running this script over it is a no-op.
//  If the sources ever come back: rebuild, and delete this script.
//
//  ── What was wrong (measured in Word, never reasoned about — CLAUDE.md §2)
//  The letter and POA each close with a four-row founder-pair block:
//
//      १.  संस्थापकको नाम, थर:–      २.  संस्थापकको नाम, थर:–
//          नाम: <founder 1>              नाम: <founder 2>
//          हस्ताक्षर:                     हस्ताक्षर:
//          दा.      बा.                  दा.      बा.
//
//  The four right-hand columns started at four DIFFERENT x positions —
//  306.2 / 288.0 / 251.7 / 251.7pt — so founder 2's block read as ragged
//  text beside founder 1 rather than its own column (user report,
//  2026-08-24: "both are in same place"). Two independent causes:
//
//    · the हस्ताक्षर and दा./बा. rows carried <w:ind w:firstLine="720"/>, and
//      Word resolves a tab stop on a first-line-indented line at
//      (pos − firstLine) — their shared 4680 stop fired at 3960 → 251.7pt;
//    · the heading row's own left label ENDS at 4686 twips, six twips past
//      the 4680 stop, so its second tab could not use that stop and fell
//      through to the next default one → 306.2pt.
//
//  Both are fixed by giving all four rows ONE geometry: no indent at all,
//  a leading tab against a shared stop, and a right-column stop at 5040
//  (3.5") that the left label cannot overshoot. A third stop at 5760 carries
//  the right column's own label past its number.
//
//  Idempotent and assertion-heavy: every paragraph count is checked, and a
//  file already in the target state exits 0 having written nothing.
// ════════════════════════════════════════════
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readDocx, writeDocx, PARA_RE } from './core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC = join(__dirname, '..', '..', 'assets', 'templates', 'company-registration-multi.docx');
const CHECK_ONLY = process.argv.includes('--check');

const OLD_TABS = '<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="4680"/></w:tabs>';
const NEW_TABS = '<w:tabs><w:tab w:val="left" w:pos="720"/>'
  + '<w:tab w:val="left" w:pos="5040"/><w:tab w:val="left" w:pos="5760"/></w:tabs>';

// The four row kinds, by a needle unique to each. `lead` marks the rows whose
// left column is indented by hand today (a space run, or nothing at all where
// firstLine did the work) and must instead open with a real tab.
const ROWS = [
  { needle: '{{numLeft}}',                 lead: false, label: 'heading' },
  { needle: 'नाम: {{nameLeft}}',           lead: true,  label: 'name' },
  { needle: '{{#hasRight}}हस्ताक्षर:',      lead: true,  label: 'signature' },
  { needle: '{{#hasRight}}दा.',            lead: true,  label: 'thumbprint' },
];
const EXPECT = 2;   // one block on the letter page, one on the POA page

// Inserts a real <w:tab/> at the head of a paragraph's first text run and
// drops the hand-typed spaces it replaces.
//
// The whole row is ONE run — cross-run token replacement collapsed it — and
// that run already contains the <w:tab/> that SEPARATES the two columns, so
// the "is it already patched?" test has to look only at what precedes the
// run's first <w:t>. Testing the run as a whole reports every unpatched row
// as done, which is exactly what it did the first time round.
function leadWithTab(p) {
  const firstRun = p.match(/<w:r(?: [^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/);
  if (!firstRun) throw new Error('no text run found in paragraph');
  const run = firstRun[0];
  const head = run.slice(0, run.search(/<w:t(?: [^>]*)?>/));
  if (/<w:tab\/>/.test(head)) return p;                      // already patched
  const patched = run
    .replace(/(<w:t(?: [^>]*)?>)[ ]+/, '$1')                 // drop the space padding
    .replace(/(<w:r(?: [^>]*)?>)((?:<w:rPr>[\s\S]*?<\/w:rPr>)?)/, '$1$2<w:tab/>');
  return p.replace(run, patched);
}

const files = await readDocx(DOC);
let out = files['word/document.xml'].toString('utf8');
let touched = 0;

for (const { needle, lead, label } of ROWS) {
  let seen = 0;
  const RE = new RegExp(PARA_RE.source, 'g');
  out = out.replace(RE, p => {
    if (!p.includes(needle)) return p;
    seen++;
    let q = p;
    if (q.includes(OLD_TABS)) { q = q.replace(OLD_TABS, NEW_TABS); touched++; }
    // firstLine silently moves this row's stops; every other indent attribute
    // stays (w:right="-810" is what widens the block's column).
    if (/<w:ind [^>]*w:firstLine="[^"]*"/.test(q)) {
      q = q.replace(/(<w:ind [^>]*?)\s*w:firstLine="[^"]*"/, '$1');
      touched++;
    }
    if (lead) {
      const before = q;
      q = leadWithTab(q);
      if (q !== before) touched++;
    }
    return q;
  });
  if (seen !== EXPECT) throw new Error(`${label} row: matched ${seen} paragraph(s), expected ${EXPECT}`);
}

// Post-conditions — the whole point of the patch, asserted rather than assumed.
const paras = out.match(new RegExp(PARA_RE.source, 'g')) || [];
for (const { needle, label } of ROWS) {
  for (const p of paras.filter(x => x.includes(needle))) {
    if (!p.includes(NEW_TABS)) throw new Error(`${label} row: expected tab stops missing after patch`);
    if (/w:firstLine=/.test(p)) throw new Error(`${label} row: a firstLine indent survived the patch`);
  }
}
if (out.includes(OLD_TABS)) throw new Error('an old 720/4680 pair stop survived the patch');

if (touched === 0) {
  console.log('company-registration-multi.docx: already patched — nothing written.');
  process.exit(0);
}
if (CHECK_ONLY) {
  console.error(`company-registration-multi.docx: ${touched} change(s) NEEDED (run without --check to apply).`);
  process.exit(1);
}
files['word/document.xml'] = Buffer.from(out, 'utf8');
await writeDocx(DOC, files);
console.log(`company-registration-multi.docx: patched (${touched} change(s)).`);
