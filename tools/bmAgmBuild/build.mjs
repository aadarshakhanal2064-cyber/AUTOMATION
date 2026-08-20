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
//  What it does, in order:
//   1. Decodes every Preeti-fonted run to Unicode (preeti-to-unicode),
//      preserving cross-run word context via a private-use-area sentinel
//      standing in for <w:tab/> during decode (splitting text at tabs
//      before decoding breaks mid-word Preeti ligatures — found the hard
//      way; see the SENT constant below).
//   2. Applies CORRECTIONS (./corrections.mjs) — decode ambiguities the
//      library can't resolve on its own (Devanagari ब/व share Preeti key
//      sequences) plus a few genuine typos in the source file, found by
//      cross-referencing repeated boilerplate phrases against each other
//      and against real firm data (org_firms.auditor_name_np, etc. — see
//      the SQL checks in the session this was built in).
//   3. Swaps every Preeti font reference to Mangal (document.xml, styles.xml,
//      fontTable.xml, settings.xml) — CLAUDE.md §15's "Preeti → Mangal
//      (Unicode) template conversion" decision. Strips the yellow
//      highlighting the firm used to mark fields by hand; it has no place
//      in a generated document.
//   4. Runs targeted paragraph surgery (the CUSTOM catalog below) at every
//      spot that needs a real value: the ~50 paragraphs across BM minutes,
//      AGM minutes, the Section 51 capital report, the two registrar
//      letters, the Beneficiary Owner declaration, and the conditional
//      "Change of Board of Director" block (its own minutes + a Director's
//      Declaration page repeated once per attendee). Everything else is
//      kept as decoded, corrected, fixed boilerplate.
//   5. Zips the result into a real .docx (jszip) and writes it to
//      assets/templates/bm-agm-minutes.docx.
//
//  Requires npm packages this repo otherwise has none of (CLAUDE.md: "No
//  package.json, no npm at the app level") — a one-time build tool needs a
//  real Preeti decoder, and hand-rolling that mapping table is exactly what
//  went wrong last time (docs/history/HANDOFF.md §4-5, days of ligature/
//  reph-reordering bugs). This subfolder's package.json is the deliberate,
//  documented exception; nothing here ships to the browser.
//
//  Usage:
//    cd tools/bmAgmBuild && npm install
//    node build.mjs "<path to the firm's source .docx>"
//
//  The source file is the firm's real document (a real client's name/PAN/
//  registration number) and must NEVER be committed to this public repo —
//  pass its path from wherever it actually lives; nothing here reads a
//  path inside the repo.
// ════════════════════════════════════════════
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { convertFont } from 'preeti-to-unicode';
import JSZip from 'jszip';
import { applyCorrections } from './corrections.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const OUT_PATH = join(REPO_ROOT, 'assets', 'templates', 'bm-agm-minutes.docx');

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('Usage: node build.mjs "<path to source .docx>"');
  process.exit(1);
}

// ── Step 0: unzip the source .docx into a scratch dir ──
const work = mkdtempSync(join(tmpdir(), 'bmagm-build-'));
try {
  const srcZip = new JSZip();
  await srcZip.loadAsync(readFileSync(srcPath));
  const files = {};
  for (const [name, entry] of Object.entries(srcZip.files)) {
    if (entry.dir) continue;
    files[name] = await entry.async('nodebuffer');
  }

  const docXmlBuf = files['word/document.xml'];
  if (!docXmlBuf) throw new Error('word/document.xml not found in source .docx');
  let xml = docXmlBuf.toString('utf8');

  // ── Step 1+2: decode Preeti runs (preserving tab-crossing word context) + corrections ──
  const SENT = String.fromCodePoint(0xE000);
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  const seqRe = /<w:tab\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const fontRe = /<w:rFonts\b[^>]*w:ascii="([^"]*)"/;

  function xmlEntityDecode(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }
  function xmlEntityEncode(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Decodes every paragraph's PLAIN TEXT (used for the "plain, unmodified"
  // fallback paragraphs below) — decode is done once per contiguous
  // same-font run of text, not per individual <w:r>, so a word split across
  // two runs purely for highlighting purposes still decodes as one word.
  const correctedByPara = new Map();
  {
    let m;
    let pIdx = 0;
    paraRe.lastIndex = 0;
    while ((m = paraRe.exec(xml))) {
      pIdx++;
      const pBlock = m[1];
      let chunks = [];
      let rm;
      runRe.lastIndex = 0;
      while ((rm = runRe.exec(pBlock))) {
        const rBlock = rm[1];
        const fontM = fontRe.exec(rBlock);
        const isPreeti = (fontM ? fontM[1] : 'Preeti') === 'Preeti';
        let text = '';
        let sm; seqRe.lastIndex = 0;
        while ((sm = seqRe.exec(rBlock))) text += sm[1] !== undefined ? xmlEntityDecode(sm[1]) : '\t';
        if (!text) continue;
        const last = chunks[chunks.length - 1];
        if (last && last.isPreeti === isPreeti) last.text += text; else chunks.push({ isPreeti, text });
      }
      if (!chunks.length) continue;
      const unicode = chunks.map(c => {
        if (!c.isPreeti) return c.text;
        const withSentinel = c.text.split('\t').join(SENT);
        let decoded;
        try { decoded = convertFont(withSentinel, 'preeti'); } catch { decoded = c.text; }
        return decoded.split(SENT).join('\t');
      }).join('');
      correctedByPara.set(pIdx, applyCorrections(unicode));
    }
  }

  // ── Step 3: font swap + strip highlighting on the raw XML (applies to
  //    EVERY run, including the ones step 4 is about to fully replace —
  //    harmless, since those get overwritten wholesale anyway) ──
  xml = xml.replace(/w:ascii="Preeti"/g, 'w:ascii="Mangal"')
           .replace(/w:hAnsi="Preeti"/g, 'w:hAnsi="Mangal"')
           .replace(/w:cs="Preeti"/g, 'w:cs="Mangal"')
           .replace(/<w:highlight\s+w:val="[^"]*"\/>/g, '');

  const bodyStart = xml.indexOf('<w:body>') + '<w:body>'.length;
  const bodyEnd = xml.indexOf('</w:body>');
  const preamble = xml.slice(0, bodyStart);
  const postBody = xml.slice(bodyEnd);
  let bodyXml = xml.slice(bodyStart, bodyEnd);

  const sectPrM = bodyXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/);
  const sectPr = sectPrM ? sectPrM[0] : '';
  if (sectPrM) bodyXml = bodyXml.slice(0, sectPrM.index);

  const paraBlocks = bodyXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g);
  if (!paraBlocks) throw new Error('no paragraphs found in word/document.xml');
  console.log('source paragraphs:', paraBlocks.length);

  // ── Step 4: targeted paragraph surgery ──
  function getPPr(block) { const m = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(block); return m ? m[0] : '<w:pPr/>'; }
  function getBaseRPr(pPr) { const m = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(pPr); return m ? m[0] : '<w:rPr/>'; }
  function withBold(rPr, bold) {
    const hasB = /<w:b\/>/.test(rPr);
    if (bold && !hasB) return rPr.replace('<w:rPr>', '<w:rPr><w:b/><w:bCs/>');
    if (!bold && hasB) return rPr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '');
    return rPr;
  }
  function withMangalToken(rPr) {
    return rPr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '').replace(/<w:u\s+w:val="[^"]*"\/>/g, '');
  }
  function runFromText(text, rPr) {
    const parts = text.split('\t');
    let inner = '';
    parts.forEach((p, i) => {
      if (i > 0) inner += '<w:tab/>';
      if (p) inner += `<w:t xml:space="preserve">${xmlEntityEncode(p)}</w:t>`;
    });
    return `<w:r>${rPr}${inner}</w:r>`;
  }
  function paraWithRuns(pPr, runsXml) { return `<w:p>${pPr}${runsXml}</w:p>`; }
  function markerPara(tag, baseRPr) {
    return `<w:p><w:pPr><w:rPr></w:rPr></w:pPr><w:r>${baseRPr}<w:t>${tag}</w:t></w:r></w:p>`;
  }
  function pageBreakPara(rPr) { return `<w:p><w:pPr/><w:r>${rPr}<w:br w:type="page"/></w:r></w:p>`; }
  function paraFromSegments(pPr, segments) {
    const baseRPr = getBaseRPr(pPr);
    let runs = '';
    for (const seg of segments) {
      runs += seg.token
        ? runFromText('{{' + seg.token + '}}', withBold(withMangalToken(baseRPr), !!seg.bold))
        : runFromText(seg.text, withBold(baseRPr, !!seg.bold));
    }
    return paraWithRuns(pPr, runs);
  }

  // the attendee loop body (one line: "num) name <tab> role"), reused at
  // every point the source repeats the उपस्थित list
  const ATTENDEE_LINE_PPR = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="360"/><w:tab w:val="left" w:pos="3600"/></w:tabs><w:spacing w:after="0"/><w:ind w:left="360"/><w:jc w:val="both"/><w:rPr><w:rFonts w:ascii="Mangal" w:hAnsi="Mangal"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr>';
  function attendeeLoopParas() {
    const rPr = getBaseRPr(ATTENDEE_LINE_PPR);
    return [
      markerPara('{{#attendees}}', rPr),
      paraFromSegments(ATTENDEE_LINE_PPR, [{ token: 'num' }, { text: ') ' }, { token: 'name' }, { text: '\t' }, { token: 'role' }]),
      markerPara('{{/attendees}}', rPr),
    ].join('');
  }
  function attendeeLoopParasNoRole() {
    const rPr = getBaseRPr(ATTENDEE_LINE_PPR);
    return [
      markerPara('{{#attendees}}', rPr),
      paraFromSegments(ATTENDEE_LINE_PPR, [{ token: 'num' }, { text: ') ' }, { token: 'name' }]),
      markerPara('{{/attendees}}', rPr),
    ].join('');
  }

  // paragraph index (1-based, source numbering) -> handler; DROP removes a
  // paragraph outright (the pre-loop duplicate rows the loops above replace)
  const CUSTOM = {};
  const DROP = new Set();

  // Page 1: Board Meeting minutes
  CUSTOM[2] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[6] = (b) => paraFromSegments(getPPr(b), [
    { text: 'आज मिति ' }, { token: 'bmDate' }, { text: ' गते यस कम्पनी को संचालक समितिको बैठक श्री ' },
    { token: 'chairmanName', bold: true }, { text: ' को अध्यक्षतामा कम्पनीको रजिष्टर्ड कार्यालयमा निम्नलिखित बमोजिमको उपस्थितिमा बसी निम्नानुसारका प्रस्तावहरु छलफलका लागि प्रस्तुत गरिएकोमा निम्नानुसार निर्णय गरियो ः' },
  ]);
  CUSTOM[9] = () => attendeeLoopParas();
  DROP.add(10);
  CUSTOM[14] = (b) => paraFromSegments(getPPr(b), [{ text: '२) ' }, { token: 'bmExtraProposalTitle' }]);
  CUSTOM[18] = (b) => paraFromSegments(getPPr(b), [
    { text: 'प्रस्ताव नं. १ मा बैठकमा छलफलगर्दा यस कम्पनीको आ. ब. ' }, { token: 'fiscalYear' },
    { text: ' को वार्षिक साधारण सभा यहि मिति ' }, { token: 'agmDate' },
    { text: ' बिहान ०९.०० बजे कम्पनीकै रजिष्टर्ड कार्यालयमा बस्ने भएकाले र सम्पूर्ण शेयर सदस्यहरु यसै बैठकमा उपस्थित रहेकाले यसैलाई सूचना मानी उपस्थित रहने प्रस्ताव पारित गर्ने निर्णय गरियो ।' },
  ]);
  CUSTOM[21] = (b) => paraFromSegments(getPPr(b), [{ token: 'bmExtraProposalDecision' }]);
  CUSTOM[24] = (b) => paraFromSegments(getPPr(b), [
    { text: 'विविध प्रस्ताव उपर छलफल गर्न विषय बाँकी नरहेको हुँदा आजको बैठक अध्यक्षज्युको अनुमतिले समापन गरियो ।' },
  ]);

  // Page 2: AGM minutes
  CUSTOM[34] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[37] = (b) => paraFromSegments(getPPr(b), [
    { text: 'आज मिति ' }, { token: 'agmDate' }, { text: ' गते विहान ०९.०० बजे यस कम्पनीको वार्षिक साधारण सभा संचालक समितिका अध्यक्ष श्री ' },
    { token: 'chairmanName', bold: true }, { text: ' को अध्यक्षतामा कम्पनीको रजिष्टर्ड कार्यालयमा निम्नलिखित बमोजिमको उपस्थितिमा बसी निम्नानुसारका प्रस्तावहरु छलफलका लागि प्रस्तुत गरिएकोमा निम्नानुसार निर्णय गरियो ः' },
  ]);
  CUSTOM[40] = () => attendeeLoopParas();
  DROP.add(41);
  CUSTOM[46] = (b) => paraFromSegments(getPPr(b), [{ text: '१) आ.ब. ' }, { token: 'fiscalYear' }, { text: ' को वार्षिक लेखापरीक्षण प्रतिवेदन सम्बन्धमा ।' }]);
  CUSTOM[48] = (b) => paraFromSegments(getPPr(b), [{ text: '३) आ. ब. ' }, { token: 'nextFiscalYear' }, { text: ' को लेखापरीक्षकको नियुक्ति सम्बन्धमा ।' }]);
  CUSTOM[50] = (b) => paraFromSegments(getPPr(b), [{ text: '५) ' }, { token: 'agmExtraProposalTitle' }]);
  CUSTOM[55] = (b) => paraFromSegments(getPPr(b), [
    { text: 'प्रस्ताव नं. १ माथि छलफल गर्दा आ. व. ' }, { token: 'fiscalYear' },
    { text: ' को लेखापरीक्षण प्रतिवेदनले कम्पनीको वास्तविक आर्थिक अवस्थाको चित्रण गरेको हुँदा उक्त प्रतिवेदनलाई अनुमोदन गर्ने निर्णय गरियो ।' },
  ]);

  // Page 3: remaining AGM decisions
  CUSTOM[61] = (b) => paraFromSegments(getPPr(b), [
    { text: 'प्रस्ताव नं. ३, उपर छलफल हुँदा यस प्रा. लि. को आ. ब. ' }, { token: 'nextFiscalYear' },
    { text: ' को लेखापरीक्षण कार्य गर्नका लागि श्री ' }, { token: 'auditorName', bold: true },
    { text: ' लाई नियुक्ति गर्ने सर्वसम्मत निर्णय गरियो र लेखापरीक्षण शुल्क संचालक समिति र लेखापरीक्षकको आपसी सहमतीमा निर्धारण गर्ने निर्णय गरियो ।' },
  ]);
  CUSTOM[64] = (b) => paraFromSegments(getPPr(b), [
    { text: 'प्रस्ताव नं. ४ उपर छलफल हुँदा यस प्रा. लिका संचालकहरु ' }, { token: 'attendeeNamesJoined' },
    { text: 'को कार्यकाल समाप्त भएकाले ' }, { token: 'directorTermYears' },
    { text: ' वर्षका लागि पुनर्नियुक्ति गर्ने निर्णय गरियो ।' },
  ]);
  CUSTOM[67] = (b) => paraFromSegments(getPPr(b), [{ text: 'निर्णय नं. ५ ः ' }, { token: 'agmExtraProposalDecision' }]);
  CUSTOM[71] = (b) => paraFromSegments(getPPr(b), [
    { text: 'विविध प्रस्ताव उपर बैठकमा छलफलगर्न अन्य प्रस्तावहरु बाँकी नरहेकाले आजको बैठक अध्यक्षको अनुमतिले समापन गर्ने निर्णय गरियो ।' },
  ]);

  // Page 4: Companies Act §51 capital-structure report
  CUSTOM[84] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[85] = (b) => paraFromSegments(getPPr(b), [{ text: 'कम्पनी ऐन, २०६३ को दफा ५१ बमोजिम पेश गरेको प्रतिवेदन' }]);
  CUSTOM[91] = (b) => paraFromSegments(getPPr(b), [{ text: 'रु ' }, { token: 'authorizedCapital' }, { text: ' र शेयर संख्या २५,००० थान' }]);
  CUSTOM[96] = (b) => paraFromSegments(getPPr(b), [{ text: 'रु ' }, { token: 'issuedCapital' }, { text: ' र शेयर संख्या २५,००० थान' }]);
  CUSTOM[101] = (b) => paraFromSegments(getPPr(b), [{ text: 'रु ' }, { token: 'paidUpCapital' }, { text: ' र शेयर संख्या २५,००० थान' }]);
  CUSTOM[111] = (b) => paraFromSegments(getPPr(b), [{ text: 'रु ' }, { token: 'paidUpCapital' }]);
  CUSTOM[145] = (b) => paraFromSegments(getPPr(b), [{ token: 'chairmanName' }]);

  // Page 5: registrar letter — auditor appointment notice
  CUSTOM[150] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[151] = (b) => paraFromSegments(getPPr(b), [{ token: 'registrationNumber' }]);
  CUSTOM[153] = (b) => paraFromSegments(getPPr(b), [{ text: 'मितिः– ' }, { token: 'letterDate' }]);
  CUSTOM[159] = (b) => paraFromSegments(getPPr(b), [
    { text: 'उपरोक्त सम्बन्धमा यस प्रा. लि. को आ. ब. ' }, { token: 'nextFiscalYear' },
    { text: ' को लेखापरीक्षण कार्यका निमित्त ' }, { token: 'auditorName' },
    { text: ' लाई नियुक्ति गरिएको र पारिश्रमिक संचालक समिति र लेखापरीक्षकको आपसी सहमतीबाट कायम हुनेगरी पारिश्रमिक निर्धारण गरिएको यस पत्रका साथ निवेदन गर्न चाहान्छु ।' },
  ]);
  CUSTOM[162] = (b) => paraFromSegments(getPPr(b), [{ token: 'chairmanName' }]);
  CUSTOM[168] = (b) => paraFromSegments(getPPr(b), [{ text: 'बोधार्थ ः ' }, { token: 'auditorName' }, { text: ', ' }, { token: 'auditorAddress' }]);

  // Page 6: registrar letter — annual statement submission
  CUSTOM[170] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[171] = (b) => paraFromSegments(getPPr(b), [{ token: 'registrationNumber' }]);
  CUSTOM[173] = (b) => paraFromSegments(getPPr(b), [{ text: 'मितिः– ' }, { token: 'letterDate' }]);
  CUSTOM[179] = (b) => paraFromSegments(getPPr(b), [
    { text: 'उपरोक्त सम्बन्धमा यस प्रा.लि.को आ.ब. ' }, { token: 'fiscalYear' },
    { text: ' सालको त्यस कार्यालयमा पेश गर्नुपर्ने तपसिलका विवरणहरु पेश दाखिला गरेको छु, सो विवरण पेश दाखिला गरिपाउँ ।' },
  ]);
  CUSTOM[181] = (b) => paraFromSegments(getPPr(b), [{ text: '१. आ.ब. ' }, { token: 'fiscalYear' }, { text: ' को लेखापरीक्षण प्रतिवेदन ।' }]);
  CUSTOM[182] = (b) => paraFromSegments(getPPr(b), [{ text: '२. आ.ब. ' }, { token: 'fiscalYear' }, { text: ' को वार्षिक साधारण सभाको निर्णयको प्रतिलिपि ।' }]);
  CUSTOM[184] = (b) => paraFromSegments(getPPr(b), [{ text: '४. आ.ब. ' }, { token: 'nextFiscalYear' }, { text: ' को लेखापरीक्षक नियुक्ति ।' }]);
  CUSTOM[185] = (b) => {
    const rPr = getBaseRPr(getPPr(b));
    return markerPara('{{#boardChanged}}', rPr) +
      paraFromSegments(getPPr(b), [{ text: '५. संचालकको पुनर्नियुक्ति सम्बन्धमा' }]) +
      markerPara('{{/boardChanged}}', rPr);
  };
  CUSTOM[189] = (b) => paraFromSegments(getPPr(b), [{ token: 'chairmanName' }]);

  // Page 7: Beneficiary Owner declaration
  CUSTOM[193] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[194] = (b) => paraFromSegments(getPPr(b), [{ token: 'registrationNumber' }]);
  CUSTOM[201] = () => attendeeLoopParasNoRole();
  DROP.add(202); DROP.add(203);

  // Page 8: "Change of Board of Director" minutes — the whole block is
  // conditional (see INSERT_BEFORE[214]/INSERT_AFTER[252] below)
  CUSTOM[215] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[219] = (b) => paraFromSegments(getPPr(b), [
    { text: 'आज मिति ' }, { token: 'boardChangeDate' }, { text: ' गते बिहान ९ः३० बजे यस ' },
    { token: 'companyName' }, { text: 'को संचालक समितिको बैठक श्री ' }, { token: 'chairmanName' },
    { text: ' को अध्यक्षतामा कम्पनीको रजिष्टर्ड कार्यालयमा निम्नलिखित बमोजिमको उपस्थितिमा बसी निम्नानुसारका प्रस्तावहरु छलफलका लागि प्रस्तुत गरिएकोमा निम्नानुसार निर्णय गरियो ः' },
  ]);
  CUSTOM[222] = () => attendeeLoopParas();
  DROP.add(223);
  CUSTOM[230] = (b) => paraFromSegments(getPPr(b), [
    { text: 'प्रस्ताव नं. १ मा बैठकमा छलफल गर्दा कम्पनीका संचालकहरु क्रमशः संचालकहरु ' }, { token: 'attendeeNamesJoined' },
    { text: 'हरुको कार्यकाल समाप्त भई मिति आज बिहान ०९.०० बजे बसेको वार्षिक साधारण सभाको बैठकमा निजहरु पुन संचालक पदमा नयाँ कार्यकालको लागि पुनर्नियुक्ति हुनुभएको र संचालक ' },
    { token: 'chairmanName' }, { text: ' पुन अध्यक्ष संचालक भई कार्य गर्न इच्छुक हुनुभएको हुँदा निजलाई अध्यक्ष संचालक चयन गर्ने सर्वसम्मतिले निर्णय गरियो ।' },
  ]);
  CUSTOM[231] = (b) => paraFromSegments(getPPr(b), [
    { text: '२) विविध प्रस्ताव उपर बैठकमा छलफलगर्न अन्य प्रस्तावहरु बाँकी नरहेकाले आजको बैठक अध्यक्षको अनुमतिले विसर्जन गर्ने निर्णय गरियो ।' },
  ]);

  // Pages 9-10: Director's Declaration (Companies Act §92(1)) — the source
  // has two near-identical pages, one per attendee (chairman, then the
  // first shareholder). Collapsed into ONE loop body over `attendees` so it
  // works for any attendee count, not just two; the second page is dropped.
  CUSTOM[239] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyName', bold: true }]);
  CUSTOM[240] = (b) => paraFromSegments(getPPr(b), [{ token: 'registrationNumber' }]);
  CUSTOM[241] = (b) => paraFromSegments(getPPr(b), [{ token: 'companyAddress', bold: true }]);
  CUSTOM[250] = (b) => {
    const pPr = getPPr(b); const rPr = getBaseRPr(pPr);
    return paraWithRuns(pPr,
      `<w:r>${rPr}<w:t>{{#isChairman}}</w:t></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">अध्यक्षको सही</w:t></w:r>` +
      `<w:r>${rPr}<w:t>{{/isChairman}}{{^isChairman}}</w:t></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">संचालक/ सही</w:t></w:r>` +
      `<w:r>${rPr}<w:t>{{/isChairman}}</w:t></w:r>`);
  };
  CUSTOM[251] = (b) => paraFromSegments(getPPr(b), [{ text: 'नाम ः– ' }, { token: 'name' }]);
  CUSTOM[252] = (b) => {
    const pPr = getPPr(b); const rPr = getBaseRPr(pPr);
    return paraWithRuns(pPr,
      `<w:r>${rPr}<w:t xml:space="preserve">पद ः– </w:t></w:r>` +
      `<w:r>${rPr}<w:t>{{#isChairman}}</w:t></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">संचालक अध्यक्ष</w:t></w:r>` +
      `<w:r>${rPr}<w:t>{{/isChairman}}{{^isChairman}}</w:t></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">संचालक सदस्य</w:t></w:r>` +
      `<w:r>${rPr}<w:t>{{/isChairman}}</w:t></w:r>`);
  };
  for (let i = 256; i <= 271; i++) DROP.add(i); // the source's second (duplicate) declaration page

  const INSERT_BEFORE = {};
  const INSERT_AFTER = {};
  INSERT_BEFORE[214] = () => markerPara('{{#boardChanged}}', getBaseRPr(getPPr(paraBlocks[213])));
  INSERT_BEFORE[238] = () => {
    // page break INSIDE the {{#attendees}} loop (repeated per iteration) so
    // a second/third director's declaration always starts its own fresh
    // page — putting it before the loop-open marker fires it only once,
    // which was a real bug caught by rendering a 3-attendee test case.
    const rPr = getBaseRPr(getPPr(paraBlocks[237]));
    return markerPara('{{#attendees}}', rPr) + pageBreakPara(rPr);
  };
  INSERT_AFTER[252] = () => {
    const rPr = getBaseRPr(getPPr(paraBlocks[251]));
    return markerPara('{{/attendees}}', rPr) + markerPara('{{/boardChanged}}', rPr);
  };

  let result = [];
  for (let idx = 1; idx <= paraBlocks.length; idx++) {
    if (DROP.has(idx)) continue;
    const block = paraBlocks[idx - 1];
    if (INSERT_BEFORE[idx]) result.push(INSERT_BEFORE[idx]());
    if (CUSTOM[idx]) {
      result.push(CUSTOM[idx](block));
    } else if (correctedByPara.has(idx)) {
      const pPr = getPPr(block);
      result.push(paraWithRuns(pPr, runFromText(correctedByPara.get(idx), getBaseRPr(pPr))));
    } else {
      result.push(block); // blank/structural spacer paragraph, kept as-is (already font-swapped)
    }
    if (INSERT_AFTER[idx]) result.push(INSERT_AFTER[idx]());
  }

  files['word/document.xml'] = Buffer.from(preamble + result.join('') + sectPr + postBody, 'utf8');
  console.log('output paragraphs:', result.length);

  // ── the rest of the font swap (styles/fontTable/settings) ──
  for (const name of ['word/styles.xml', 'word/fontTable.xml', 'word/settings.xml']) {
    if (!files[name]) continue;
    let s = files[name].toString('utf8');
    s = s.replace(/w:ascii="Preeti"/g, 'w:ascii="Mangal"')
         .replace(/w:hAnsi="Preeti"/g, 'w:hAnsi="Mangal"')
         .replace(/w:cs="Preeti"/g, 'w:cs="Mangal"')
         .replace(/w:eastAsia="Preeti"/g, 'w:eastAsia="Mangal"');
    files[name] = Buffer.from(s, 'utf8');
  }

  // ── Step 5: zip and write ──
  const outZip = new JSZip();
  for (const [name, buf] of Object.entries(files)) outZip.file(name, buf);
  const outBuf = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(OUT_PATH, outBuf);
  console.log('written:', OUT_PATH, outBuf.length, 'bytes');
} finally {
  rmSync(work, { recursive: true, force: true });
}
