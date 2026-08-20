// ════════════════════════════════════════════
//  PREETI .docx -> TOKENISED TEMPLATE — shared core
//
//  The firm's registrar documents are all the same kind of artefact: a real
//  Word file, typed in Preeti (a byte encoding, not Unicode), carrying one
//  client's values as literal text. Turning one into a template means the
//  same five things every time — decode the Preeti, correct the decode's
//  known artefacts, swap sample values for {{tokens}}, force the page
//  breaks, and make it paginate in Word. This file is those five things;
//  each document's own build script supplies only what is specific to it.
//
//  Extracted from the BM/AGM build (2026-08-20) when the Company Secretary
//  Appointment document became the second consumer. The extraction was
//  verified the only way that means anything: rebuilding bm-agm-minutes.docx
//  through the extracted core and diffing it against the previously
//  committed template — every file inside the .docx byte-identical.
//
//  ── THE GOVERNING RULE: minimal touch ──
//  The firm's source document IS the format. Every <w:pPr>, every <w:rPr>,
//  every table wrapper, indent and tab stop is preserved BYTE FOR BYTE.
//  This code only ever rewrites the *text inside runs* and inserts tokens.
//  It never rebuilds a paragraph from a synthesized <w:pPr>.
//
//  That rule is not theoretical. The first version of the BM/AGM script
//  extracted every <w:p> and re-joined them as a flat list, which silently
//  discarded the <w:tbl>/<w:tr>/<w:tc> wrappers around the §51 capital
//  report — it rendered as loose unboxed paragraphs instead of the ruled
//  table the registrar expects. Anything that walks a document must keep
//  the gaps BETWEEN paragraph matches, because that is where table markup
//  lives. walkBody() below is the one place that walk happens.
// ════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import { convertFont } from 'preeti-to-unicode';
import JSZip from 'jszip';

// A self-closing empty paragraph (`<w:p .../>`) must match FIRST. A naive
// /<w:p\b[^>]*>[\s\S]*?<\/w:p>/ swallows the *following* real paragraph,
// shifting every index past that point and silently corrupting whatever
// the build anchors on paragraph numbers (loop markers, page breaks).
export const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

const RUN_RE = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
const SEQ_RE = /<w:tab\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const RPR_RE = /<w:rPr>[\s\S]*?<\/w:rPr>/;
const FONT_RE = /<w:rFonts\b[^>]*w:ascii="([^"]*)"/;

const SENT = String.fromCodePoint(0xE000);   // stands in for <w:tab/> across a Preeti decode

export const xdec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
export const xenc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function decodePreeti(text) {
  let d;
  try { d = convertFont(text.split('\t').join(SENT), 'preeti'); } catch { d = text; }
  return d.split(SENT).join('\t');
}

// ── ZIP I/O ──
// Both ends live here so a build script never imports JSZip itself, which
// keeps the npm dependency in exactly one place.
export async function readDocx(path) {
  const zip = await new JSZip().loadAsync(readFileSync(path));
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('nodebuffer');
  }
  return files;
}

export async function writeDocx(path, files) {
  const zip = new JSZip();
  for (const [name, buf] of Object.entries(files)) zip.file(name, buf);
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// Word's spell/grammar-check annotations. They render nothing — they are
// where the squiggly underlines were when the file was last saved — but
// they sit BETWEEN runs, and that is enough to break this pipeline: two
// identically-formatted runs separated by a <w:proofErr/> stop being
// adjacent, so they land in different formatting groups and a Preeti
// ligature spanning them decodes wrong.
//
// Found on the Company Secretary source, which carries 506 of them — 141 in
// a single paragraph — and reported 8 paragraphs whose group-wise decode
// disagreed with their whole-paragraph decode. Stripping them removes the
// cause outright rather than asking the boundary-nudge repair to undo it,
// and costs nothing: Word regenerates proofErr markers the next time it
// checks spelling. MUST run before the body is walked.
//
// (The BM/AGM source carries none, which is why that pipeline never saw
// this — and why adding this step leaves its template byte-identical.)
export const stripProofErr = s => s.replace(/<w:proofErr\b[^>]*\/>/g, '');

export function splitBody(xml) {
  const bodyOpen = xml.indexOf('<w:body>') + '<w:body>'.length;
  const bodyClose = xml.indexOf('</w:body>');
  return { head: xml.slice(0, bodyOpen), body: xml.slice(bodyOpen, bodyClose), tail: xml.slice(bodyClose) };
}

export function paragraphText(pXml) {
  return (pXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
    .map(x => x.replace(/<[^>]*>/g, '')).join('');
}

// Which paragraphs (1-based) carry no text at all? A source paragraph used
// purely as vertical spacing before a section break is one of these.
export function blankParagraphMap(body) {
  const blank = new Map();
  let i = 0, m;
  const RE = new RegExp(PARA_RE.source, 'g');
  while ((m = RE.exec(body))) {
    i++;
    blank.set(i, paragraphText(m[0]).trim() === '');
  }
  return blank;
}

export function markerParagraph(tag) {
  return `<w:p><w:r><w:t>${tag}</w:t></w:r></w:p>`;
}

// ════════════════════════════════════════════
//  PARAGRAPH TRANSFORM
// ════════════════════════════════════════════

// Group adjacent runs by VISIBLE formatting only. Word litters a document
// with runs that differ solely in metadata — <w:szCs> present or absent, a
// complex-script font name, an eastAsia language tag — and splitting on
// those slices words apart: in the BM/AGM source `अनुमतिले` arrives as two
// such runs and decodes to the wrong vowel if handled separately, and a
// company title arrived as three runs that differed ONLY by an explicit
// black colour, so {{companyName}} could never match it and three pages
// stayed hard-coded to the sample client. Only the properties below change
// what a reader sees, so only they may start a new group. The first run's
// rPr is emitted verbatim for the whole group — nothing about the
// formatting is ever reconstructed or guessed.
const sigOf = (rPr, isPreeti) => JSON.stringify([
  isPreeti,
  /<w:b\/>/.test(rPr),
  /<w:i\/>/.test(rPr),
  (/<w:u\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
  (/<w:sz\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
  ((/<w:color\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1] || '').replace(/^(000000|auto)$/i, ''),
  (/<w:vertAlign\s+w:val="([^"]*)"/.exec(rPr) || [, ''])[1],
  /<w:strike\/>/.test(rPr),
  /<w:caps\/>/.test(rPr),
]);

// Builds the per-document paragraph transformer.
//
//   corrections  [[wrong, right], ...]  decode artefacts + source typos
//   globalTokens [[sampleValue, '{{token}}'], ...]  applied to every paragraph
//   paraTokens   { paraIndex: [[from, to], ...] }   applied to one paragraph only
//
// Order matters and is fixed: corrections first (so a token match is made
// against correctly-spelled text), then this paragraph's own tokens (more
// specific), then the global ones.
export function createTransformer({ corrections = [], globalTokens = [], paraTokens = {}, debug = false } = {}) {
  const mismatches = [];
  const repaired = [];
  const debugLines = [];

  function transformParagraph(pXml, idx) {
    if (!pXml.includes('</w:p>')) return pXml;             // self-closing empty paragraph

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

    const groups = [];
    for (const part of parts) {
      if (part.kind !== 'run') { groups.push({ kind: 'other', xml: part.xml }); continue; }
      const rPrRaw = (RPR_RE.exec(part.xml) || [''])[0];
      // the firm uses yellow purely to mark fill-in spots by hand; it must
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

    // A Preeti syllable can straddle a formatting boundary — in the BM/AGM
    // source the chairman's name ends bold while the "को" that follows has
    // its consonant still inside the bold run and its vowel sign in the
    // plain one, so decoding the groups independently produces different
    // (wrong) text than decoding the paragraph whole. Nudge the boundary a
    // few characters either way until the two agree. Whichever side the
    // shifted characters land on is the formatting they take, which is why
    // only tiny shifts are allowed.
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

    if (debug) debugLines.push(idx + '\t' + decoded.join(''));

    // ── Cross-group replacement ──
    // A value to be tokenised routinely spans several runs, and NOT because
    // of anything meaningful: a registration number's "।" separators are set
    // two points smaller than its digits, a company title has a half-size
    // space between its two halves, a placeholder puts its brackets in one
    // font and its words in another. Merging those runs would be wrong — a
    // paragraph can use differently-sized space runs as indentation, and
    // flattening it moves the text.
    //
    // So replacement works on the paragraph's text as one string while the
    // runs stay separate: the matched characters are cut from whichever runs
    // held them, and the replacement is inserted into the FIRST of them. The
    // token therefore inherits the formatting of wherever the value started
    // — a bold intro keeps a bold name, a plain signature line a plain one —
    // and every other run keeps its own size and spacing untouched.
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
      // (confirmed live: one signature label wrapped 49 times). Starting each
      // scan past the previous insertion point still finds every genuine
      // later occurrence; it just can't walk backwards into what it replaced.
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

    for (const [from, to] of corrections) replaceAcross(from, to);
    for (const [from, to] of (paraTokens[idx] || [])) replaceAcross(from, to);
    for (const [from, to] of globalTokens) replaceAcross(from, to);
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

  return { transformParagraph, mismatches, repaired, debugLines };
}

// ════════════════════════════════════════════
//  PAGE BREAKS
//
//  Done by applying a named style that carries <w:pageBreakBefore/>, NOT by
//  inserting a page-break paragraph and NOT by direct paragraph formatting.
//  Each of the three ways behaves differently and only this one satisfies
//  both consumers:
//    * A separate <w:p> holding <w:br w:type="page"/> is still a paragraph.
//      Its paragraph mark lands at the top of the new page and pushes all
//      content down a line — enough to spill the last line of a full page
//      onto the next one, which is exactly what went wrong first time.
//    * Direct <w:pageBreakBefore/> in the paragraph's own pPr is correct for
//      Word, but docx-preview only consults the property on a paragraph's
//      STYLE (splitBySection -> findStyle(elem.styleName)), so the app's
//      preview and print saw no breaks at all and rendered every section as
//      one giant page, which the page-fitting code then shrank to one sheet.
//    * A style carrying the property satisfies both, and adds no content.
//
//  The style is based on Normal and sets nothing else, so a paragraph's own
//  direct formatting (centring, size, weight) still wins over it.
// ════════════════════════════════════════════
export function createPageBreakStyle(styleId, styleName) {
  const styleXml =
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="' + styleId + '">' +
    '<w:name w:val="' + styleName + '"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:pageBreakBefore/></w:pPr></w:style>';

  function apply(pXml) {
    if (pXml.includes(styleId)) return pXml;
    const style = '<w:pStyle w:val="' + styleId + '"/>';
    const m = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    if (!m) {
      return pXml
        .replace(/<w:pPr\/>/, '<w:pPr>' + style + '</w:pPr>')
        .replace(/^(<w:p[^>]*>)(?!<w:pPr)/, '$1<w:pPr>' + style + '</w:pPr>');
    }
    if (/<w:pStyle/.test(m[1])) {
      throw new Error('section-start paragraph already carries a pStyle; ' +
        'derive ' + styleId + ' from it instead of overwriting');
    }
    return pXml.replace(m[0], '<w:pPr>' + style + m[1] + '</w:pPr>');   // pStyle must come first
  }

  function ensureDefined(stylesXml) {
    if (stylesXml.includes(styleId)) return stylesXml;
    return stylesXml.replace('</w:styles>', styleXml + '</w:styles>');
  }

  return { styleId, apply, ensureDefined };
}

// ════════════════════════════════════════════
//  BODY WALK
//
//  Transforms paragraphs while COPYING EVERY GAP verbatim — the gaps are
//  the <w:tbl>/<w:tr>/<w:tc> markup, and losing them is the single worst
//  failure this whole pipeline has had.
//
//  Also replaces each section's leading blank spacer paragraphs with one
//  real page break. A source separates its sub-documents with runs of empty
//  paragraphs and only lands correctly because the sample client's names and
//  figures happen to fill each page to the right height — a longer company
//  name or one more director silently pushes a signature block onto the next
//  sheet. Trailing blanks at the very end of the body are dropped for the
//  same reason (in the BM/AGM source they pushed the final page 0.8% over).
// ════════════════════════════════════════════
export function walkBody({ body, transformParagraph, sectionStarts = [], drop = new Set(), insertBefore = {}, insertAfter = {}, pageBreak, log = console.log }) {
  const blank = blankParagraphMap(body);
  const dropSet = new Set(drop);

  {
    let p = blank.size, dropped = 0;
    while (p >= 1 && blank.get(p)) { dropSet.add(p); p--; dropped++; }
    if (dropped) log('  trailing: %d blank paragraph(s) dropped', dropped);
  }
  for (const start of sectionStarts) {
    let p = start - 1, dropped = 0;
    while (p >= 1 && blank.get(p)) { dropSet.add(p); p--; dropped++; }
    log('  section @%d: %d spacer paragraph(s) -> page break', start, dropped);
  }

  const startSet = new Set(sectionStarts);
  let out = '', cursor = 0, idx = 0, m;
  const RE = new RegExp(PARA_RE.source, 'g');
  while ((m = RE.exec(body))) {
    out += body.slice(cursor, m.index);
    idx++;
    for (const tag of insertBefore[idx] || []) out += markerParagraph(tag);
    if (!dropSet.has(idx)) {
      const xmlOut = transformParagraph(m[0], idx);
      out += startSet.has(idx) && pageBreak ? pageBreak.apply(xmlOut) : xmlOut;
    }
    for (const tag of insertAfter[idx] || []) out += markerParagraph(tag);
    cursor = m.index + m[0].length;
  }
  out += body.slice(cursor);
  return { out, count: idx };
}

// ════════════════════════════════════════════
//  WHOLE-DOCUMENT REWRITES
// ════════════════════════════════════════════

// Preeti -> Mangal everywhere (CLAUDE.md §15: never revert to Preeti).
export const swapFonts = (s, from = 'Preeti', to = 'Mangal') => s
  .replace(new RegExp(`w:ascii="${from}"`, 'g'), `w:ascii="${to}"`)
  .replace(new RegExp(`w:hAnsi="${from}"`, 'g'), `w:hAnsi="${to}"`)
  .replace(new RegExp(`w:cs="${from}"`, 'g'), `w:cs="${to}"`)
  .replace(new RegExp(`w:eastAsia="${from}"`, 'g'), `w:eastAsia="${to}"`);

export const stripHighlight = s => s.replace(/<w:highlight\s+w:val="[^"]*"\/>/g, '');

// A stray auto-bullet from drafting (every real list in these documents is
// manually-typed numbering, "१)", "२)"…). Word renders the Symbol-font
// bullet fine, but docx-preview can't map that Private-Use-Area glyph and
// shows a broken placeholder box — which the app's Print/PDF path inherits,
// since it renders through the same library.
export const stripListBullet = s => s
  .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '')
  .replace(/<w:pStyle\s+w:val="ListParagraph"\/>/g, '');

// MANGAL IS NOT INSTALLED on the firm's machine (only Nirmala UI is), so
// Word silently substitutes a face with far taller metrics — worth 6 of 19
// pages on the BM/AGM document by itself. Naming the font that is actually
// present makes the layout deterministic instead of dependent on whatever
// Word picks. Not a return to Preeti (CLAUDE.md §15 forbids that); Nirmala
// UI is the modern Windows Devanagari font and ships with Windows 8+.
//
// MUST run last in any chain: alignment fixes routinely match on literal
// w:ascii="Mangal", and renaming the font first stops every one matching.
export const mangalToNirmala = s => swapFonts(s, 'Mangal', 'Nirmala UI');

// Scales every explicit size by ONE factor, so a source's own size
// hierarchy is preserved exactly in proportion — title, body, and the tiny
// spacer runs used as indentation all shrink together, and nothing else
// about the layout is touched.
//
// MUST run last, for the same reason as mangalToNirmala: fixes that match
// on exact w:sz values stop matching once the values move.
export const scaleFontSizes = (s, factor) => s.replace(
  /<w:(sz|szCs) w:val="(\d+)"\/>/g,
  (_, tag, val) => `<w:${tag} w:val="${Math.max(2, Math.round(Number(val) * factor))}"/>`
);

// Sets sizes from an explicit {sourceHalfPoints: targetHalfPoints} table
// instead of by ratio. Use this when the firm has asked for particular sizes
// rather than "smaller overall" — a single factor cannot express "make the
// body much smaller but the title only slightly smaller", and trying to
// approximate it with a factor plus per-element patches is how a size
// hierarchy drifts out of step with itself.
//
// Sizes absent from the map are left alone; `onUnmapped` is called with each
// one seen in the text so a build can fail rather than silently ship a run at
// its original size. Same "MUST run last" rule as scaleFontSizes.
export const remapFontSizes = (s, map, onUnmapped) => s.replace(
  /<w:(sz|szCs) w:val="(\d+)"\/>/g,
  (whole, tag, val) => {
    const to = map[Number(val)];
    if (to === undefined) { if (onUnmapped) onUnmapped(Number(val)); return whole; }
    return `<w:${tag} w:val="${to}"/>`;
  }
);

// Word's stock paragraph defaults are `after=200 line=276` — 10pt after
// EVERY paragraph plus 15% extra leading. A source that carries no explicit
// <w:spacing> inherits all of it; on the BM/AGM document that was ~100
// paragraphs and roughly 1000pt (~14in) of whitespace. The source got away
// with it because Preeti text is byte-narrow ASCII; real Unicode Devanagari
// wraps to more lines and stands taller, so the same defaults overflow.
//
// Only the `after` is dropped. The LINE height stays at 276 (1.15): taking
// it to 240 fixed Word and wrecked the preview, because Word derives
// "single" from the font's own metrics (leaving Devanagari matras room)
// whereas docx-preview maps it to a flat CSS line-height where 1.0 makes
// one line touch the next.
export const tightDocDefaults = (s, line = 276) => {
  const filled = s.replace(
    /<w:pPrDefault><w:pPr><w:spacing[^/]*\/><\/w:pPr><\/w:pPrDefault>/,
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault>`
  );
  if (filled !== s) return filled;
  // A source can also carry an EMPTY <w:pPrDefault/>, which inherits the
  // very same stock values — it just states them nowhere, so the regex
  // above finds nothing to rewrite and the whitespace silently survives.
  return s.replace(
    /<w:pPrDefault\s*\/>/,
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault>`
  );
};

// ════════════════════════════════════════════
//  CHECKS
// ════════════════════════════════════════════

export function allText(xml) {
  return (xml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
    .map(t => t.replace(/<[^>]*>/g, '')).join('');
}

// Every sample value MUST have become a token. A value that survives is a
// field silently hard-coded to the sample client — a company title did
// exactly that on three pages of the BM/AGM document, because its runs
// differed only by an explicit black colour and so never formed one
// matchable string. This check is what caught it.
export function assertTokenised(builtXml, globalTokens) {
  const text = allText(builtXml);
  const survived = globalTokens.filter(([from]) => from && text.includes(from)).map(([from]) => from);
  if (survived.length) throw new Error('sample value(s) left un-tokenised: ' + survived.join(' | '));
}

// Asserts a literal string appears exactly `n` times — the shape most of
// these builds' regression guards take.
export function assertCount(xml, needle, n, label) {
  const found = (xml.split(needle).length - 1);
  if (found !== n) throw new Error(`${label}: expected ${n} occurrence(s) of ${needle}, found ${found}`);
}

// Replaces `oldStr` with `newStr`, throwing if the source no longer contains
// it. Every alignment fix in these builds is an exact-string swap against a
// real document, so a source edit must fail loudly rather than silently
// leaving the old hand-typed spacing in place.
export function swapExact(xml, oldStr, newStr, label) {
  if (!xml.includes(oldStr)) throw new Error(`${label} not found — source changed, revisit this fix`);
  return xml.replace(oldStr, newStr);
}
