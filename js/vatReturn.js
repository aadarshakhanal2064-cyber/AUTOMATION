// ════════════════════════════════════════════
//  VAT RETURN AUTOMATION
//  Reads IRD VAT Return PDFs (अनुसुची-१०, one scanned page per month) and
//  fills the firm's standard "Detail of Sale & Purchase" Excel workbook —
//  fully client-side, deterministic, zero AI/API calls.
//
//  Pipeline: render each PDF page (pdf.js) -> crop known field regions ->
//  digit-only OCR (Tesseract.js) -> checksum against the form's own totals
//  -> human review/correction -> business rules -> Excel (ExcelJS).
//
//  Every page in this document type is a single full-width scanned image
//  placed inside a fixed-size PDF page with a page-specific vertical
//  margin (verified empirically — the margin is NOT constant across
//  pages). Field coordinates below are calibrated as fractions of the
//  scanned image itself; vatGetImagePlacement() corrects for each page's
//  own margin (read from the PDF content stream via pdf.js's operator
//  list) before cropping, so the same fractional coordinates apply to
//  every page regardless of its individual placement.
// ════════════════════════════════════════════

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

// IRD "अवधि" (period) -> fiscal month name + fiscal month index (1 = Shrawan .. 12 = Ashadh)
const VAT_PERIOD_TO_MONTH = {
  4: { name: 'Shrawan', idx: 1 }, 5: { name: 'Bhadra', idx: 2 }, 6: { name: 'Ashwin', idx: 3 },
  7: { name: 'Kartik', idx: 4 }, 8: { name: 'Mangshir', idx: 5 }, 9: { name: 'Poush', idx: 6 },
  10: { name: 'Magh', idx: 7 }, 11: { name: 'Falgun', idx: 8 }, 12: { name: 'Chaitra', idx: 9 },
  1: { name: 'Baishak', idx: 10 }, 2: { name: 'Jestha', idx: 11 }, 3: { name: 'Ashadh', idx: 12 },
};
const VAT_MONTH_ORDER = ['Shrawan','Bhadra','Ashwin','Kartik','Mangshir','Poush','Magh','Falgun','Chaitra','Baishak','Jestha','Ashadh'];

// Sanitized copy of the firm's real "Detail of Sale & Purchase" workbook
// (structure/styles/formulas verbatim, all client data blanked) — the
// generator fills this rather than rebuilding the sheet from scratch.
const VAT_EXCEL_TEMPLATE_URL = 'assets/templates/vat-detail.xlsx';

// Per-month "what was actually paid" overrides of the Vat Paid rule
// ({ monthIdx: number }) — reset on every fresh extraction.
window.vatPaidOverrides = {};

// PDF page = 595 x 842 pt (A4) for this document family.
const VAT_PDF_PAGE_W = 595, VAT_PDF_PAGE_H = 842;

// Fractions of the raw scanned image (0..1). One "col1/col2/col3" pattern
// mirrors the PDF's own 3-column table (कारोबार मूल्य / खरिदमा तिरेको कर
// क्रेडिट / बिक्रीमा संकलन गरेको कर डेबिट).
const VAT_FIELD_BOXES = {
  period:                    { left: 0.6900, top: 0.2280, width: 0.0550, height: 0.0330 },
  taxYear:                   { left: 0.1197, top: 0.2402, width: 0.0862, height: 0.0242 },
  taxableSalesValue:         { left: 0.3161, top: 0.4169, width: 0.2299, height: 0.0317 },
  taxableSalesVat:           { left: 0.7854, top: 0.4169, width: 0.2011, height: 0.0317 },
  taxFreeSales:              { left: 0.3161, top: 0.4698, width: 0.2299, height: 0.0257 },
  taxablePurchaseValue:      { left: 0.3161, top: 0.5159, width: 0.2299, height: 0.0287 },
  taxablePurchaseVat:        { left: 0.6226, top: 0.5159, width: 0.1724, height: 0.0287 },
  taxableImportValue:        { left: 0.3161, top: 0.5423, width: 0.2299, height: 0.0257 },
  taxableImportVat:          { left: 0.6226, top: 0.5423, width: 0.1724, height: 0.0257 },
  exemptPurchase:            { left: 0.3161, top: 0.5665, width: 0.2299, height: 0.0257 },
  exemptImport:              { left: 0.3161, top: 0.5915, width: 0.2299, height: 0.0257 },
  adjustmentSalesDebit:      { left: 0.7854, top: 0.6382, width: 0.2011, height: 0.0257 },
  adjustmentPurchaseCredit:  { left: 0.6226, top: 0.6382, width: 0.1724, height: 0.0257 },
  // प्यान नं. — same digits on every page of a legitimate filing; used to
  // auto-fill company name/address from the client directory (English names
  // can't come from the Nepali scan, but the PAN can). Calibrated on pages
  // 1/5/10, verified 92-96% confidence on all three.
  pan:                       { left: 0.1250, top: 0.2130, width: 0.1300, height: 0.0260 },
};
// items ५/६/७ (डेबिट-क्रेडिट / previous-month credit / कुल तिर्नु पर्ने कर)
// deliberately have NO fixed boxes: their rows sit below the table past
// variable print drift (measured ~0.025 of page height between pages of the
// same document — a page-1-calibrated box lands on the wrong row by page 5),
// so they're extracted by vatExtractItemsStrip() instead: find the table's
// bottom border per page, OCR the whole strip below it line-by-line, and
// pick the 3 consecutive lines satisfying IRD's own identity
// item7 = item5 - item6 (or 0 when the month closes in credit).

function vatStatus(html, type) {
  showStatus(html, type, 'vat-status');
}

// ── PDF rendering + page-specific margin correction ──
// Every page's embedded scan sits inside the fixed 595x842pt page with its
// own vertical offset/scale (confirmed empirically — not constant across
// pages of the same document), read from the operator list active at the
// image-paint call.
async function vatGetImagePlacement(page) {
  return PdfEngine.getImagePlacement(page, VAT_PDF_PAGE_W, VAT_PDF_PAGE_H);
}

async function vatRenderPageCanvas(pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const placement = await vatGetImagePlacement(page);
  const canvas = await PdfEngine.renderPageToCanvas(page, scale);
  return { canvas, placement };
}

// ── Structural validation (runs before any OCR) ──
// This PDF family has no embedded text, AcroForm, XFA, or metadata of any
// kind (confirmed by direct inspection of the raw PDF bytes) — OCR is the
// only extraction path available, which makes it essential to confirm the
// page actually looks like the expected अनुसुची-१० form *before* trusting
// anything OCR reports from it. Page size and image-structure checks are
// exact. The two dark-pixel-density "anchors" (title block, table header
// row, a table column divider) are calibrated against measurements taken
// from 3 real pages of a real filing — a blank page measures 0 in every
// anchor, a fully-dark/photographic page measures ~1 in every anchor, and
// the real form pages measured 0.035–0.039 / 0.090–0.119 / 0.073–0.100
// respectively across pages with materially different table data. The
// bounds below keep generous margin around those measured values.
const VAT_PAGE_SIZE_TOLERANCE_PT = 5;
const VAT_STRUCTURAL_ANCHORS = {
  titleBlock:          { left: 0.15, top: 0.02,  width: 0.70, height: 0.18, min: 0.015, max: 0.10 },
  tableHeaderRow:       { left: 0.05, top: 0.395, width: 0.90, height: 0.03, min: 0.05,  max: 0.25 },
  tableBorderVertical:  { left: 0.313, top: 0.40, width: 0.006, height: 0.30, min: 0.03,  max: 0.25 },
};

function vatDarkDensity(imageData, w, h, region) {
  const x0 = Math.max(0, Math.round(region.left * w)), y0 = Math.max(0, Math.round(region.top * h));
  const x1 = Math.min(w, Math.round((region.left + region.width) * w)), y1 = Math.min(h, Math.round((region.top + region.height) * h));
  const data = imageData.data;
  let dark = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * w + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (lum < 150) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}

// Checks one already-rendered page against the structural anchors. Requires
// at least 2 of the 3 anchors to fall in range — matches the empirical
// finding that an unrelated document can coincidentally satisfy one narrow
// anchor, but not multiple independent ones simultaneously.
function vatCheckPageAnchors(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let passed = 0;
  const results = {};
  for (const [name, region] of Object.entries(VAT_STRUCTURAL_ANCHORS)) {
    const density = vatDarkDensity(imageData, canvas.width, canvas.height, region);
    const ok = density >= region.min && density <= region.max;
    if (ok) passed++;
    results[name] = { density, ok };
  }
  return { passed, total: Object.keys(VAT_STRUCTURAL_ANCHORS).length, results };
}

// Runs every structural check before any OCR happens. Returns { valid,
// errors } — extraction must not proceed if valid is false.
async function vatValidatePdf(pdf) {
  const errors = [];

  if (pdf.numPages < 1 || pdf.numPages > 12) {
    errors.push(`PDF has ${pdf.numPages} page(s) — a VAT Return filing has at most 12 (one per month). This doesn't look like a VAT Return PDF.`);
    return { valid: false, errors };
  }

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const view = page.view; // [x0, y0, x1, y1] in points
    const pw = view[2] - view[0], ph = view[3] - view[1];
    if (Math.abs(pw - VAT_PDF_PAGE_W) > VAT_PAGE_SIZE_TOLERANCE_PT || Math.abs(ph - VAT_PDF_PAGE_H) > VAT_PAGE_SIZE_TOLERANCE_PT) {
      errors.push(`Page ${p} is ${Math.round(pw)}×${Math.round(ph)}pt — expected ~${VAT_PDF_PAGE_W}×${VAT_PDF_PAGE_H}pt (A4). This may not be a standard IRD VAT Return export.`);
      continue;
    }

    // Family B (digital-text PDFs — see vatExtractPageFromText): checked
    // structurally by its own row-anchor text, never by the image-based
    // checks below, since these pages carry no embedded scan image at all.
    // Every real Family B document checked (Sarso, Jay Nepal, Nawa Ashrya)
    // has a trailing signature/declaration page with ZERO table content —
    // a normal part of this document family, not a validation failure. A
    // page with no recognized anchors at all is silently not a data page
    // (skipped, not extracted); only a page with SOME anchors but not
    // enough of them (a genuinely malformed/mismatched table) is an error.
    if (await PdfEngine.hasTextLayer(page)) {
      const rows = await PdfEngine.getTextRows(page);
      const anchorCheck = await vatCheckTextLayerAnchors(rows);
      if (anchorCheck.found.length > 0 && anchorCheck.passed < 3) {
        errors.push(`Page ${p} doesn't match the expected VAT Return form layout (found ${anchorCheck.passed}/${anchorCheck.total} expected row markers in its text). This may not be an अनुसुची-१० VAT Return page.`);
      }
      continue;
    }

    const placement = await vatGetImagePlacement(page);
    if (placement.imageCount !== 1) {
      errors.push(`Page ${p} has ${placement.imageCount} embedded image(s) — expected exactly 1 scanned form page.`);
      continue;
    }
    if (!placement.ctm || Math.abs(placement.ctm[0] - VAT_PDF_PAGE_W) > VAT_PAGE_SIZE_TOLERANCE_PT || Math.abs(placement.ctm[4]) > VAT_PAGE_SIZE_TOLERANCE_PT) {
      errors.push(`Page ${p}'s scanned content isn't placed full-width as expected.`);
      continue;
    }

    const { canvas } = await vatRenderPageCanvas(pdf, p, 2);
    const anchorCheck = vatCheckPageAnchors(canvas);
    if (anchorCheck.passed < 2) {
      errors.push(`Page ${p} doesn't match the expected VAT Return form layout (title/table position not found — checked ${anchorCheck.passed}/${anchorCheck.total} anchors). This may not be an अनुसुची-१० VAT Return page.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Digital-text extraction (Family B) ──
// Some real IRD VAT PDFs (confirmed: Sarso Traders, Jay Nepal Khadyana,
// Nawa Ashrya — all three checked by direct font-dictionary inspection)
// are not scans at all: they embed a real text layer via subsetted Mangal/
// ArialUnicodeMS fonts. Every digit extracts perfectly; the Devanagari
// *labels* come out as wrong-but-still-Devanagari characters, because the
// font's ToUnicode CMap is broken specifically for complex-script glyph
// reordering (which digits never need). So: never try to read the label
// text. Instead, each table row's item-number prefix (e.g. "१.१.") is
// itself made of Devanagari *numerals*, which decode correctly on every
// sample checked — that's the anchor, exactly mirroring the scanned-image
// path's "trust structure/position, not label content" principle, just
// applied to reconstructed text rows instead of pixel boxes. No OCR runs
// for this family at all.
const VAT_DEVANAGARI_DIGITS = '०१२३४५६७८९';
function vatDevToInt(s) {
  if (!s) return null;
  let out = '';
  for (const ch of s) {
    const idx = VAT_DEVANAGARI_DIGITS.indexOf(ch);
    if (idx === -1) return null;
    out += String(idx);
  }
  return out === '' ? null : parseInt(out, 10);
}

const VAT_TEXT_ROW_ANCHOR_RE = /^([०-९]+)\.([०-९]*)\.?/;
function vatMatchRowAnchor(str) {
  const m = str.match(VAT_TEXT_ROW_ANCHOR_RE);
  if (!m) return null;
  const major = vatDevToInt(m[1]);
  if (major === null) return null;
  const minor = m[2] ? vatDevToInt(m[2]) : null;
  return minor !== null ? `${major}.${minor}` : `${major}`;
}

// Trailing Western-digit tokens across a row's items, in left-to-right
// (column) order — this alone already excludes the row's own Devanagari
// label/anchor text (it ends in Devanagari script, never a Western digit,
// on every sample checked), so no special-casing of "which item is the
// label" is needed. Dates (e.g. "2083.03.16") are excluded on purpose:
// this form never prints a genuine table value with a decimal point.
function vatRowNumericTokens(row) {
  const out = [];
  for (const item of row.items) {
    const m = item.str.match(/-?\d+$/);
    if (m) out.push(m[0]);
  }
  return out;
}

// anchor -> field name(s), in the same left-to-right column order the
// table itself prints them — mirrors VAT_FIELD_BOXES's field list exactly,
// just keyed by structural row-number instead of a pixel box, so every
// downstream consumer (ValidationEngine, vatBuildMonthRows, Excel
// generation) receives the identical {value, confidence} shape either way.
const VAT_TEXT_ROW_FIELDS = {
  '1.1': ['taxableSalesValue', 'taxableSalesVat'],
  '1.3': ['taxFreeSales'],
  '2.1': ['taxablePurchaseValue', 'taxablePurchaseVat'],
  '2.2': ['taxableImportValue', 'taxableImportVat'],
  '2.3': ['exemptPurchase'],
  '2.4': ['exemptImport'],
  '3.1': ['adjustmentPurchaseCredit', 'adjustmentSalesDebit'],
  '5': ['item5DebitCredit'],
  '6': ['item6PrevCredit'],
  '7': ['item7TotalPayable'],
};

function vatTextField(value) {
  return { value: value !== undefined && value !== null ? String(value) : '', confidence: 100, source: 'text' };
}

// PAN is always exactly 9 digits in Nepal — verified against every real
// digital-text PDF on hand — which tells it apart from the सब्मिसन नं.
// submission id (12 digits on every sample checked) and phone numbers (10
// digits) purely by length, with no need to read the unreliable label next
// to it. Tax year + period are printed on the same row, in that order, as
// two short non-decimal numbers — also verified on every sample, regardless
// of whether that row's label+value are one PDF text item or several.
function vatExtractHeaderFromRows(rows) {
  let pan = null, taxYear = null, period = null;
  for (const row of rows) {
    for (const item of row.items) {
      const digitsOnly = item.str.replace(/[^\d]/g, '');
      const trailing = (item.str.match(/(\d+)$/) || [])[1];
      if (!pan && trailing && digitsOnly === trailing && /^\d{9}$/.test(digitsOnly)) pan = digitsOnly;
    }
    if (!taxYear) {
      const tokens = vatRowNumericTokens(row);
      const yearTok = tokens.find(t => /^20\d{2}$/.test(t));
      if (yearTok) {
        taxYear = yearTok;
        const periodTok = tokens.slice(tokens.indexOf(yearTok) + 1).find(t => /^\d{1,2}$/.test(t) && +t >= 1 && +t <= 12);
        if (periodTok) period = periodTok;
      }
    }
  }
  return { pan, taxYear, period };
}

// Cheap structural check for a text-layer page — mirrors the scanned-image
// path's "at least 2 of 3 density anchors" gate, just counting recognized
// row anchors instead of pixel density regions.
const VAT_TEXT_REQUIRED_ANCHORS = ['1.1', '2.1', '5', '7'];
async function vatCheckTextLayerAnchors(rows) {
  const found = new Set();
  for (const row of rows) {
    if (!row.items.length) continue;
    const anchor = vatMatchRowAnchor(row.items[0].str);
    if (anchor && VAT_TEXT_ROW_FIELDS[anchor]) found.add(anchor);
  }
  const passed = VAT_TEXT_REQUIRED_ANCHORS.filter(a => found.has(a)).length;
  return { passed, total: VAT_TEXT_REQUIRED_ANCHORS.length, found: [...found] };
}

// Reads one page's fields straight from its text layer — no crop
// coordinates, no OCR. Confidence is always 100: these are the PDF's own
// embedded digit glyphs, not a recognizer's guess.
async function vatExtractPageFromText(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const rows = await PdfEngine.getTextRows(page);

  const fields = {};
  Object.keys(VAT_FIELD_BOXES).forEach(name => { fields[name] = vatTextField(''); });

  for (const row of rows) {
    if (!row.items.length) continue;
    const anchor = vatMatchRowAnchor(row.items[0].str);
    if (!anchor || !VAT_TEXT_ROW_FIELDS[anchor]) continue;
    const tokens = vatRowNumericTokens(row);
    VAT_TEXT_ROW_FIELDS[anchor].forEach((name, i) => { if (tokens[i] !== undefined) fields[name] = vatTextField(tokens[i]); });
  }

  const header = vatExtractHeaderFromRows(rows);
  if (header.pan) fields.pan = vatTextField(header.pan);
  if (header.taxYear) fields.taxYear = vatTextField(header.taxYear);
  if (header.period) fields.period = vatTextField(header.period);

  // item5/6/7 keep their real sign here (unlike the OCR path, which strips
  // it) — the identity can be checked exactly rather than by absolute value.
  const item5 = fields.item5DebitCredit.value !== '' ? parseInt(fields.item5DebitCredit.value, 10) : null;
  const item6 = fields.item6PrevCredit.value !== '' ? parseInt(fields.item6PrevCredit.value, 10) : null;
  const item7 = fields.item7TotalPayable.value !== '' ? parseInt(fields.item7TotalPayable.value, 10) : null;
  const itemsIdentityExact = item5 !== null && item6 !== null && item7 !== null && (item5 - item6) === item7;

  return { fields, itemsIdentityExact };
}

// ── Structural row alignment (fallback for scans the fixed boxes miss) ──
// VAT_FIELD_BOXES's top/height fractions were calibrated once against a
// clean, unrotated scan and don't survive a different scanner's rotation or
// vertical drift (confirmed: a real second-company PDF with ~2-3° of scan
// rotation mostly failed under fixed coordinates, while every value remained
// perfectly legible to the eye and to a human transcriber). The fix keeps
// those well-calibrated boxes and only re-registers them when they miss (see
// vatExtractPage's two-pass logic): the page's own table rule lines are
// detected and a single vertical offset+scale map is fit from the reference
// document's rule lines onto this page's, then each table box is carried
// through that map. The map is affine, so it preserves each field's
// within-cell placement (cropping the raw detected cell instead would clip
// digits that sit high or low in their cell), and it's fit robustly (RANSAC
// over anchor pairs) so it survives pages where only some rule lines are
// detected (real range seen: 7-17 lines on one document). This alignment is
// deliberately NOT applied to pages the fixed boxes already read correctly —
// there it can only pull a well-placed box off a digit (the rule lines drift
// slightly page-to-page even on a clean scan, but the digits don't drift with
// them), so those pages stay byte-identical to before.
const VAT_ROW_GRID_REGION = { left: 0.03, right: 0.97, top: 0.28, bottom: 0.70, densityThreshold: 0.55 };

// The reference document's detected rule lines, as fractions of the raw
// scanned image (page 1 of the calibration filing — clean, unrotated, all
// 17 lines detected). Same provenance and role as VAT_FIELD_BOXES: measured
// once, in the browser, via the exact runtime pipeline.
const VAT_REF_ROW_LINES = [
  0.31535, 0.33567, 0.34716, 0.37057, 0.39398, 0.41607, 0.44081, 0.46599,
  0.48984, 0.51369, 0.53843, 0.5645, 0.58923, 0.61309, 0.63871, 0.66256, 0.68818,
];

// Header fields sit above the table, so the table-line alignment doesn't
// apply to them — they keep their fixed boxes (unchanged pre-existing
// behavior). period only seeds month inference (which has a sequential
// fallback), taxYear/pan only drive auto-fill, so a small header misplacement
// degrades an aid, never a table value.
const VAT_HEADER_FIELDS = new Set(['period', 'taxYear', 'pan']);
const VAT_ROW_ALIGN_TOLERANCE = 0.01; // ~half the ~0.021 rule-line spacing

// Carries a calibrated box through the page's row-alignment map (offset+
// scale on top/height; left/width unchanged — horizontal placement is
// flush-left by assumption, unchanged from before). Returns the box
// untouched when there's no map (alignment failed) so the field falls back
// to its fixed position rather than crashing or fabricating.
function vatAlignBox(box, map) {
  if (!map) return box;
  return { top: map.a * box.top + map.b, height: map.a * box.height, left: box.left, width: box.width };
}

function vatCropField(canvas, placement, box) {
  return PdfEngine.cropCanvas(canvas, placement, box);
}

// ── Items strip (५/६/७) extraction ──
// Finds the main table's bottom border on this page: the last long
// horizontal line in the y-band where every measured page's table ends
// (0.688-0.701 across the reference document; the next section's box top
// is never before 0.76, so the band is unambiguous). Falls back to the
// measured median when no line is detected (extremely poor scans).
function vatFindTableBottom(canvas, placement) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const x0 = Math.round((placement.leftFraction + 0.15 * placement.widthFraction) * w);
  const x1 = Math.round((placement.leftFraction + 0.95 * placement.widthFraction) * w);
  const img = ctx.getImageData(x0, 0, x1 - x0, h);
  const rowDark = y => {
    let dark = 0; const base = y * (x1 - x0) * 4;
    for (let x = 0; x < x1 - x0; x++) {
      const i = base + x * 4;
      if (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < 150) dark++;
    }
    return dark / (x1 - x0);
  };
  const yStart = Math.round((placement.topFraction + 0.60 * placement.heightFraction) * h);
  const yEnd = Math.round((placement.topFraction + 0.72 * placement.heightFraction) * h);
  let lastLine = null, inLine = false;
  for (let y = yStart; y <= yEnd; y++) {
    const isLine = rowDark(y) > 0.5;
    if (isLine && !inLine) { inLine = true; lastLine = y; }
    else if (!isLine) inLine = false;
  }
  if (lastLine === null) return 0.695;
  return (lastLine / h - placement.topFraction) / placement.heightFraction;
}

// OCRs the strip below the table line-by-line and picks the 3 consecutive
// lines matching IRD's own identity, item7 = item5 - item6 — item7 is
// printed SIGNED on the form ("कुल तिर्नु पर्ने कर रू.(५.६)(+ बा -)",
// verified on a real credit month showing "-51369") and digit-only OCR
// strips the sign, so the check compares absolute values. An exact match
// is preferred, then a ±10 near-match (tolerates a misread trailing
// digit), then the first line (which IS item5 by construction, since the
// strip starts at the table's bottom border). The strip starts exactly at
// the border with no pad — the border line contains no digits, and on
// some pages item5 is printed nearly touching it (a +0.004 pad cut
// item5's line off entirely on one real page).
async function vatExtractItemsStrip(session, canvas, placement) {
  const tableBottom = vatFindTableBottom(canvas, placement);

  const bestWindow = lines => {
    const gapAt = i => {
      const a = parseInt(lines[i].value, 10), b = parseInt(lines[i + 1].value, 10), c = parseInt(lines[i + 2].value, 10);
      return Math.abs(Math.abs(a - b) - c);
    };
    let win = null, gap = Infinity;
    for (let i = 0; i + 2 < lines.length; i++) {
      const g = gapAt(i);
      if (g < gap) { gap = g; win = i; }
    }
    return { win, gap };
  };

  // The item5-to-border gap varies per page by more than any single crop
  // offset can absorb (one real page prints item5 nearly touching the
  // border; others leave ~0.01 clearance, and a wrong offset clips digit
  // tops). So: try the offset that works for most pages first, and retry
  // at alternates only while the identity doesn't check out exactly — the
  // identity itself judges which offset read the page correctly.
  let best = null;
  for (const offset of [0.004, -0.002, 0.010]) {
    const strip = vatCropField(canvas, placement, { left: 0.78, top: tableBottom + offset, width: 0.22, height: 0.105 });
    const lines = await session.recognizeDigitLines(strip);
    const { win, gap } = bestWindow(lines);
    if (win !== null && (best === null || gap < best.gap)) best = { lines, win, gap };
    if (best && best.gap === 0) break;
  }

  const empty = { value: '', confidence: 0 };
  // Even when no attempt checks out exactly, the minimum-gap window is the
  // most self-consistent read available (a near-miss usually means one
  // misread trailing digit); fields stay empty only when no attempt could
  // read 3 lines at all, and downstream checks surface any inconsistency.
  const pick = off => (best && best.lines[best.win + off]) ? { value: best.lines[best.win + off].value, confidence: best.lines[best.win + off].confidence } : empty;
  return {
    fields: { item5DebitCredit: pick(0), item6PrevCredit: pick(1), item7TotalPayable: pick(2) },
    // An exact identity means these three fields verifiably agree with the
    // form's own arithmetic — trustworthy enough to overrule the main
    // table when the two disagree (see the checksum rule).
    identityExact: !!(best && best.gap === 0),
  };
}

// ── One page's full extraction ──
// Reads every field from one prepared canvas. `map` (or null) carries the
// table fields onto the page's own detected rule lines; header fields always
// use their fixed boxes (they sit above the table, outside the alignment).
async function vatReadFields(session, canvas, placement, map) {
  const fields = {};
  for (const name of Object.keys(VAT_FIELD_BOXES)) {
    const box = (map && !VAT_HEADER_FIELDS.has(name)) ? vatAlignBox(VAT_FIELD_BOXES[name], map) : VAT_FIELD_BOXES[name];
    fields[name] = await session.recognizeDigits(vatCropField(canvas, placement, box));
  }
  return fields;
}

// A fixed-box read "looks right" when BOTH the sales and purchase value/VAT
// pairs are present and satisfy the 13% relationship — the same independent
// signal the review layer already trusts. When they don't, the fixed
// coordinates probably missed the table (a differently-positioned or rotated
// scan), so structural re-registration is worth attempting.
function vatCoreOk(fields) {
  const sv = vatNum(fields.taxableSalesValue), svat = vatNum(fields.taxableSalesVat);
  const pv = vatNum(fields.taxablePurchaseValue), pvat = vatNum(fields.taxablePurchaseVat);
  return sv > 1000 && vatRateCheck(sv, svat).ok && pv > 1000 && vatRateCheck(pv, pvat).ok;
}
function vatCoreFilled(fields) {
  return ['taxableSalesValue', 'taxableSalesVat', 'taxablePurchaseValue', 'taxablePurchaseVat']
    .filter(k => fields[k].value !== '').length;
}

async function vatExtractPage(session, pdf, pageNum) {
  const { canvas: rawCanvas, placement } = await vatRenderPageCanvas(pdf, pageNum, 3);

  // First pass: the original fixed-box calibration on the un-rotated canvas.
  // Fast, and byte-identical to the pre-vision behaviour on every page it
  // already handled — so a page that reads correctly here is never touched
  // by the structural code below.
  let fields = await vatReadFields(session, rawCanvas, placement, null);
  let strip = await vatExtractItemsStrip(session, rawCanvas, placement);

  // Second pass, only when the fixed read doesn't look like a valid VAT page:
  // deskew (if rotated) and carry the boxes onto the table's own detected rule
  // lines. Adopt that read only if it's actually better — verified-valid, or
  // recovering more fields — so a differently-positioned scan is rescued
  // without ever degrading a page the fixed boxes already read correctly (the
  // reason for trying fixed first: line-fit re-registration can pull a
  // well-placed box off a digit on a clean scan, observed directly).
  if (!vatCoreOk(fields)) {
    const angle = VisionEngine.detectSkewAngle(rawCanvas);
    const canvas = Math.abs(angle) > 0.5 ? VisionEngine.rotateCanvas(rawCanvas, angle) : rawCanvas;
    let lines = VisionEngine.repairLineGaps(VisionEngine.detectHorizontalLines(canvas, VAT_ROW_GRID_REGION));
    const linesRaw = lines.map(l => (l - placement.topFraction) / placement.heightFraction);
    const map = VisionEngine.alignLinear(VAT_REF_ROW_LINES, linesRaw, VAT_ROW_ALIGN_TOLERANCE);
    if (map) {
      const aligned = await vatReadFields(session, canvas, placement, map);
      if (vatCoreOk(aligned) || vatCoreFilled(aligned) > vatCoreFilled(fields)) {
        fields = aligned;
        strip = await vatExtractItemsStrip(session, canvas, placement);
      }
    }
  }

  Object.assign(fields, strip.fields);
  return { fields, itemsIdentityExact: strip.identityExact };
}

function vatNum(field) {
  const n = parseInt(field.value, 10);
  return isNaN(n) ? 0 : n;
}

// ── Main entry point: read the uploaded PDF, extract every page ──
async function vatExtractPdf() {
  const fileInput = document.getElementById('vat-pdfFile');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { vatStatus('कृपया पहिले PDF छान्नुहोस् (select a PDF file first).', 'info'); return; }

  try {
    vatStatus('<span class="spinner spinner-navy"></span> PDF पढ्दै (loading PDF)…', 'searching');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    vatStatus('<span class="spinner spinner-navy"></span> कागजात जाँच्दै (checking document format)…', 'searching');
    const validation = await vatValidatePdf(pdf);
    if (!validation.valid) {
      const list = validation.errors.slice(0, 5).map(e => `<li>${escHtml(e)}</li>`).join('');
      vatStatus(`❌ यो अनुसुची-१० VAT Return PDF जस्तो देखिँदैन (this doesn't look like an अनुसुची-१० VAT Return PDF) — extraction was not attempted:<ul style="margin:8px 0 0 18px;">${list}</ul>`, 'error');
      if (window.AuditLog) AuditLog.record('ocr_extraction', { module: 'vatReturn', status: 'error', stage: 'validation', errors: validation.errors, pageCount: pdf.numPages });
      return;
    }

    const pages = [];
    let lastGoodMonthIdx = null; // period OCR is the least reliable field — fall back to
                                  // "previous page's month + 1" (PDF pages are sequential
                                  // monthly filings) whenever the digit isn't recognized.

    // Decide per page, up front, whether it's Family B data (digital text,
    // no OCR needed), Family B non-data (a trailing signature/declaration
    // page — every real Family B document checked has one; carries no VAT
    // figures and must not be extracted as a blank/zero month), or Family A
    // (scanned image — needs OCR). A document that's entirely Family B
    // never needs a Tesseract worker started at all — a real, avoidable
    // cost (its own WASM engine startup) for a page type that will never
    // call it.
    const pageKind = { __proto__: null }; // p -> 'text' | 'text-skip' | 'ocr'
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      if (await PdfEngine.hasTextLayer(page)) {
        const rows = await PdfEngine.getTextRows(page);
        const anchorCheck = await vatCheckTextLayerAnchors(rows);
        pageKind[p] = anchorCheck.found.length > 0 ? 'text' : 'text-skip';
      } else {
        pageKind[p] = 'ocr';
      }
    }
    const needsOcr = Object.values(pageKind).some(k => k === 'ocr');

    let session = null;
    try {
      if (needsOcr) {
        vatStatus('<span class="spinner spinner-navy"></span> OCR इन्जिन तयार गर्दै (starting OCR engine)…', 'searching');
        session = await OcrEngine.createDigitSession();
      }

      for (let p = 1; p <= pdf.numPages; p++) {
        if (pageKind[p] === 'text-skip') continue; // e.g. a trailing signature/declaration page
        vatStatus(`<span class="spinner spinner-navy"></span> पृष्ठ ${p}/${pdf.numPages} पढ्दै (reading page ${p} of ${pdf.numPages})…`, 'searching');
        const { fields, itemsIdentityExact } = pageKind[p] === 'text'
          ? await vatExtractPageFromText(pdf, p)
          : await vatExtractPage(session, pdf, p);
        const period = vatNum(fields.period);
        let monthInfo = VAT_PERIOD_TO_MONTH[period];
        let monthGuessed = false;
        if (!monthInfo && lastGoodMonthIdx !== null && lastGoodMonthIdx < 12) {
          const idx = lastGoodMonthIdx + 1;
          monthInfo = { name: VAT_MONTH_ORDER[idx - 1], idx };
          monthGuessed = true;
        }
        if (monthInfo) lastGoodMonthIdx = monthInfo.idx;
        pages.push({ pageNum: p, period, fields, monthInfo, monthGuessed, itemsIdentityExact });
      }
    } finally {
      if (session) await session.terminate(); // always release the WASM worker, even if extraction threw
    }

    // period's OCR confidence has been observed unreliable in both directions
    // on real scans (0% on a correct read; no signal at all distinguishing a
    // wrong-but-plausible misread, e.g. "5" read as "9" — both real Nepali
    // calendar months, so VAT_PERIOD_TO_MONTH accepts either). Real filings
    // are sequential monthly pages, so (pageNum - monthIdx) should be one
    // constant offset across the whole document. Checking each page against
    // its immediate predecessor was tried first and rejected: one early
    // misread poisons the chain and drags every later page — including ones
    // that read correctly — onto the wrong trajectory. Checking each direct
    // (non-guessed, non-text) read against the DOCUMENT-WIDE consensus offset
    // instead is robust to any single bad page, including the very first one
    // (verified: catches a real page whose predecessor also failed, which
    // the chain-based check missed entirely). Flags only — never overrides —
    // so a genuine skipped-month document can't be silently mis-corrected.
    const directReads = pages.filter(pg => pg.monthInfo && !pg.monthGuessed && pg.fields.period.source !== 'text');
    if (directReads.length >= 2) {
      const offsetCounts = {};
      directReads.forEach(pg => {
        const off = pg.pageNum - pg.monthInfo.idx;
        offsetCounts[off] = (offsetCounts[off] || 0) + 1;
      });
      const consensusOffset = Object.keys(offsetCounts).reduce((best, off) =>
        offsetCounts[off] > (offsetCounts[best] ?? -1) ? off : best, null);
      directReads.forEach(pg => {
        pg.monthSequenceMismatch = (pg.pageNum - pg.monthInfo.idx) !== Number(consensusOffset);
      });
    }

    window.vatExtractedPages = pages;
    window.vatPaidOverrides = {}; // fresh extraction, no stale per-month payment overrides

    const fyField = document.getElementById('vat-fiscalYear');
    const firstMonthPage = pages.filter(pg => pg.monthInfo).sort((a, b) => a.monthInfo.idx - b.monthInfo.idx)[0];
    if (fyField && !fyField.value.trim()) {
      const taxYear = firstMonthPage ? vatNum(firstMonthPage.fields.taxYear) : 0;
      if (taxYear) fyField.value = `${taxYear}.0${(taxYear + 1) % 100}`;
    }

    // Opening balance rule (from the firm's manual workflow): the first
    // filed month's item ६ is the credit carried in from last year, entered
    // NEGATIVE in the workbook (credit); no credit -> opening 0. Only a
    // default: never overwrites something already typed in.
    const openingField = document.getElementById('vat-openingBalance');
    if (openingField && !openingField.value.trim() && firstMonthPage && firstMonthPage.fields.item6PrevCredit.value !== '') {
      const item6 = vatNum(firstMonthPage.fields.item6PrevCredit);
      openingField.value = String(item6 > 0 ? -item6 : 0);
    }

    // PAN -> client directory lookup: fills the English company name and
    // address the Excel needs (they can't be OCR'd from the Nepali scan).
    // Only confident reads participate — a garbage-quality page can return
    // a wrong PAN at 0% confidence (observed on the reference document),
    // and that noise must not abort the lookup or fake a "mixed filings"
    // alarm. Trusted only when every confident read agrees.
    const pans = [...new Set(pages
      .filter(pg => pg.fields.pan.confidence >= VAT_CONFIDENCE_MEDIUM)
      .map(pg => pg.fields.pan.value).filter(Boolean))];
    let panNote = '';
    if (pans.length === 1) {
      const client = (window.clientsList || []).find(c => NepaliLocale.toEnglishDigits(c.pan) === pans[0]);
      const nameField = document.getElementById('vat-companyName');
      const addrField = document.getElementById('vat-companyAddress');
      if (client) {
        if (nameField && !nameField.value.trim()) nameField.value = client.name || '';
        if (addrField && !addrField.value.trim()) addrField.value = client.address || '';
        panNote = ` PAN ${pans[0]} → ${escHtml(client.name)}.`;
      } else {
        panNote = ` PAN ${pans[0]} — no matching client in the directory, fill the company details manually.`;
      }
    } else if (pans.length > 1) {
      panNote = ` ⚠️ Pages disagree on the PAN (${pans.map(escHtml).join(', ')}) — this PDF may mix filings from different companies. Check before generating.`;
    }

    vatRenderReviewTable(pages);



    const unresolved = pages.filter(pg => !pg.monthInfo).length;
    const guessed = pages.filter(pg => pg.monthGuessed).length;
    const sequenceMismatch = pages.filter(pg => pg.monthSequenceMismatch).length;
    const note = unresolved > 0 ? `${unresolved} page(s) need a month picked manually`
      : guessed > 0 ? `${guessed} page(s)' month was inferred from sequence — please confirm`
      : sequenceMismatch > 0 ? `${sequenceMismatch} page(s)' month breaks the expected sequence — please confirm`
      : 'all months read correctly';
    vatStatus(`✅ ${pdf.numPages} पृष्ठ पढियो — ${note} (extracted ${pdf.numPages} pages — review below before generating).${panNote}`, unresolved > 0 || pans.length > 1 ? 'error' : 'success');
    if (window.AuditLog) AuditLog.record('ocr_extraction', { module: 'vatReturn', status: 'success', stage: 'extraction', pageCount: pdf.numPages, unresolvedMonths: unresolved, guessedMonths: guessed });
  } catch (err) {
    vatStatus('❌ ' + (err.message || 'Extraction failed'), 'error');
    if (window.AuditLog) AuditLog.record('ocr_extraction', { module: 'vatReturn', status: 'error', stage: 'extraction', error: err.message });
  }
}

// ── Review UI & validation ──
// Nothing extracted is trusted silently into the final workbook. Every
// field/row is checked by several independent signals, each surfaced with a
// specific, human-readable reason — not just a red border.

// Nepal's standard VAT rate is a fixed, well-known constant (13%). This is a
// far stronger validator than the item5 checksum below: it only depends on
// two fields (a value and its VAT) that this module already reads
// reliably, rather than a separate, harder-to-calibrate field. Verified
// against every correctly-read value/VAT pair captured during this
// project's testing — the rate held within +-1 rupee in all 14 real pairs
// checked (mostly exact). +-2 tolerance below keeps a safety margin for
// normal rounding.
const VAT_RATE = 0.13;
const VAT_RATE_TOLERANCE = 2;
function vatRateCheck(value, vat) {
  if (value === 0 && vat === 0) return { ok: true, expected: 0 };
  const expected = Math.round(value * VAT_RATE);
  return { ok: Math.abs(vat - expected) <= VAT_RATE_TOLERANCE, expected };
}

// item5 (५. डेबिट-क्रेडिट) cross-check against D-G-J+L-M. Kept as a
// *supplementary* signal only, never blocking — investigation found two
// root causes for its unreliability: (1) it can be legitimately negative,
// but digit-only OCR strips minus signs, so a signed computed value must be
// compared by absolute value; (2) Tesseract can report 0% confidence on a
// digit string it actually read correctly, so confidence is surfaced
// separately rather than gating the comparison itself.
function vatChecksum(fields) {
  const d = vatNum(fields.taxableSalesVat), g = vatNum(fields.taxablePurchaseVat),
        j = vatNum(fields.taxableImportVat), l = vatNum(fields.adjustmentSalesDebit),
        m = vatNum(fields.adjustmentPurchaseCredit);
  const computed = d - g - j + l - m;
  const printed = vatNum(fields.item5DebitCredit);
  const hasPrinted = fields.item5DebitCredit.value !== '';
  return { computed, printed, hasPrinted, ok: !hasPrinted || Math.abs(computed) === printed };
}

// Two pages assigned to the same month is always a mistake (usually a
// misread period digit, e.g. "11" read as "1") — and left unresolved it
// would silently drop one month's real data when rows are merged by month
// index. Never generate while this is unresolved.
function vatDuplicateMonthIdxs(pages) {
  const seen = {}, dup = new Set();
  pages.forEach(pg => {
    if (!pg.monthInfo) return;
    if (seen[pg.monthInfo.idx]) dup.add(pg.monthInfo.idx);
    seen[pg.monthInfo.idx] = true;
  });
  return dup;
}

const VAT_CONFIDENCE_MEDIUM = 50;
function vatConfidenceTier(confidence) {
  return ValidationEngine.confidenceTier(confidence);
}

// Every reason a row might not be safe to generate from, in one place, each
// with a plain-language explanation — this is what both the review table
// and the generate-blocking check read from, so they can never disagree.
// Expressed as independent rules run through ValidationEngine so the
// "collect every triggered warning" plumbing isn't hand-rolled here.
function vatRowWarnings(pg, dupIdxs) {
  const rules = [
    (pg) => {
      const f = pg.fields;
      if (!pg.monthInfo) return { severity: 'block', message: `Month not recognized (OCR read period "${f.period.value || '(blank)'}") — pick one manually.` };
      if (dupIdxs.has(pg.monthInfo.idx)) return { severity: 'block', message: `Another page is also assigned to ${pg.monthInfo.name} — one of them is wrong and will silently overwrite the other.` };
      if (pg.monthGuessed) return { severity: 'warn', message: 'Month was inferred from page sequence, not read directly — please confirm.' };
      if (pg.monthSequenceMismatch) return { severity: 'warn', message: `Month read as ${pg.monthInfo.name}, which breaks the sequential order most other pages in this filing agree on — likely a misread digit (period OCR is the least reliable field). Please confirm.` };
      return null;
    },
    (pg) => {
      const f = pg.fields;
      const r = vatRateCheck(vatNum(f.taxableSalesValue), vatNum(f.taxableSalesVat));
      return r.ok ? null : { severity: 'block', message: `Sales VAT doesn't match 13% of taxable sales (expected ~${r.expected}, read ${vatNum(f.taxableSalesVat)}) — one of the two was likely misread.` };
    },
    (pg) => {
      const f = pg.fields;
      const r = vatRateCheck(vatNum(f.taxablePurchaseValue), vatNum(f.taxablePurchaseVat));
      return r.ok ? null : { severity: 'block', message: `Purchase VAT doesn't match 13% of taxable purchase (expected ~${r.expected}, read ${vatNum(f.taxablePurchaseVat)}) — one of the two was likely misread.` };
    },
    (pg) => {
      const f = pg.fields;
      const r = vatRateCheck(vatNum(f.taxableImportValue), vatNum(f.taxableImportVat));
      return r.ok ? null : { severity: 'warn', message: `Import VAT doesn't match 13% of taxable import (expected ~${r.expected}, read ${vatNum(f.taxableImportVat)}).` };
    },
    (pg) => {
      const f = pg.fields;
      return (f.taxableSalesValue.value === '' && f.taxablePurchaseValue.value === '')
        ? { severity: 'block', message: 'No sales or purchase figures were read at all on this page — check the upload or enter the values manually.' }
        : null;
    },
    (pg) => {
      // A page can also fail by reading "empty-ish" rather than empty —
      // observed on a real document from a different scanner profile,
      // where a page read zeros in the main table (passing the emptiness
      // and 13% checks) and would have silently written a zero month into
      // the workbook. If neither the main table nor the items strip
      // produced any nonzero figure, nothing meaningful was read.
      const f = pg.fields;
      // "< 10 in total" rather than exactly zero: a stray mark can read as
      // a single digit (observed: sales VAT "1" on an all-blank page), and
      // no genuine month has all four figures in single digits.
      const tableDead = ['taxableSalesValue','taxableSalesVat','taxablePurchaseValue','taxablePurchaseVat'].reduce((s, k) => s + vatNum(f[k]), 0) < 10;
      const stripDead = f.item5DebitCredit.value === '';
      return (tableDead && stripDead)
        ? { severity: 'block', message: 'This page read as all-zero and its डेबिट-क्रेडिट section was unreadable — the layout probably doesn\'t match the calibrated form. Enter the values manually.' }
        : null;
    },
    (pg) => {
      // Real figures in the wrong columns: observed on a foreign-profile
      // scan where the sales/purchase VALUE boxes read blank while other
      // boxes caught real numbers from an offset table — the totals can
      // even stay arithmetically consistent, so this shape needs its own
      // signal. No legitimate month has VAT/adjustment figures without any
      // sales or purchase value.
      const f = pg.fields;
      const noValues = vatNum(f.taxableSalesValue) === 0 && vatNum(f.taxablePurchaseValue) === 0;
      const otherFigures = ['taxableSalesVat','taxablePurchaseVat','taxableImportVat','adjustmentSalesDebit','adjustmentPurchaseCredit'].some(k => vatNum(f[k]) > 10);
      return (noValues && otherFigures)
        ? { severity: 'warn', message: 'Sales and purchase values read as blank while VAT/adjustment figures exist — check the figures landed in the right columns (the form layout may not match the calibration).' }
        : null;
    },
    (pg) => {
      const chk = vatChecksum(pg.fields);
      if (chk.ok) return null;
      // When items ५/६/७ verifiably agree with the form's own arithmetic
      // (exact identity), a nonzero item ५ that contradicts the computed
      // difference means the MAIN TABLE was misread — that must block, not
      // just warn (also observed on the foreign-profile document, where
      // the table read blanks but the strip read real figures).
      if (pg.itemsIdentityExact && chk.printed > 0) {
        return { severity: 'block', message: `The form's own डेबिट-क्रेडिट total (${chk.printed}, verified against items ६/७) doesn't match the difference computed from the table (${chk.computed}) — the table figures were probably misread. Correct them before generating.` };
      }
      return { severity: 'warn', message: `Form's own डेबिट-क्रेडिट total (${chk.printed || '(blank)'}) doesn't match the computed difference (${chk.computed}) — this field is the least reliable to OCR, treat as informational.` };
    },
    (pg) => {
      // Meta/supplementary fields excluded: taxYear and pan only inform
      // auto-fill, and items ६/७ only power cross-checks — their read
      // failures disable those aids rather than making a row unsafe.
      const metaFields = ['taxYear', 'pan', 'item6PrevCredit', 'item7TotalPayable'];
      const lowConfidenceFields = Object.entries(pg.fields)
        .filter(([name, field]) => !metaFields.includes(name) && field.confidence > 0 && field.confidence < VAT_CONFIDENCE_MEDIUM)
        .map(([name]) => name);
      return lowConfidenceFields.length ? { severity: 'warn', message: `Low OCR confidence on: ${lowConfidenceFields.join(', ')}.` } : null;
    },
  ];
  return ValidationEngine.run(rules, pg);
}

function vatRowStatusHtml(warnings) {
  return ValidationEngine.statusHtml(warnings);
}

function vatRenderReviewTable(pages) {
  const card = document.getElementById('vat-review-card');
  const tbody = document.getElementById('vat-review-tbody');
  if (!card || !tbody) return;
  const dupIdxs = vatDuplicateMonthIdxs(pages);

  const cols = ['taxableSalesValue','taxableSalesVat','taxFreeSales','taxablePurchaseValue','taxablePurchaseVat',
    'exemptPurchase','taxableImportValue','taxableImportVat','exemptImport','adjustmentSalesDebit','adjustmentPurchaseCredit'];

  tbody.innerHTML = pages.map((pg, i) => {
    const warnings = vatRowWarnings(pg, dupIdxs);
    const needsAttention = warnings.some(w => w.severity === 'block') || pg.monthGuessed || pg.monthSequenceMismatch;
    const monthOptions = VAT_MONTH_ORDER.map((name, mi) =>
      `<option value="${mi + 1}" ${pg.monthInfo && pg.monthInfo.idx === mi + 1 ? 'selected' : ''}>${name}</option>`
    ).join('');
    const monthSelect = `<select data-page="${i}" onchange="vatOnMonthEdit(this)"
      style="${needsAttention ? 'border-color:var(--red); background:var(--red-bg);' : ''}"
      title="OCR read period '${escHtml(pg.fields.period.value || '?')}' — confirm or correct the month">
      <option value="">— pick month —</option>${monthOptions}
    </select>`;
    const cells = cols.map(c => {
      const f = pg.fields[c];
      const tier = vatConfidenceTier(f.confidence);
      return `<td><div style="display:flex; align-items:center; gap:3px;">
        <span title="${tier.icon} ${tier.label} OCR confidence (${Math.round(f.confidence)}%)">${tier.icon}</span>
        <input type="text" data-page="${i}" data-field="${c}" value="${escHtml(f.value)}"
          style="width:80px; ${tier.tier !== 'high' ? 'border-color:var(--red); background:var(--red-bg);' : ''}"
          oninput="vatOnFieldEdit(this)" />
      </div></td>`;
    }).join('');
    return `<tr data-page-idx="${i}">
      <td>PDF p.${pg.pageNum}<br/>${monthSelect}</td>
      ${cells}
      <td>${vatRowStatusHtml(warnings)}</td>
    </tr>`;
  }).join('');

  card.style.display = 'block';
  // Every data change that re-renders the review table also changes the
  // computed workbook — keep the preview grid in lockstep.
  vatRenderWorkbookPreview();
}

function vatOnMonthEdit(select) {
  const i = parseInt(select.dataset.page, 10);
  if (!window.vatExtractedPages || !window.vatExtractedPages[i]) return;
  const idx = parseInt(select.value, 10);
  window.vatExtractedPages[i].monthInfo = idx ? { name: VAT_MONTH_ORDER[idx - 1], idx } : null;
  window.vatExtractedPages[i].monthGuessed = false;
  vatRenderReviewTable(window.vatExtractedPages); // re-check duplicate-month flags across all rows
}

function vatOnFieldEdit(input) {
  const i = parseInt(input.dataset.page, 10), field = input.dataset.field;
  if (!window.vatExtractedPages || !window.vatExtractedPages[i]) return;
  window.vatExtractedPages[i].fields[field] = { value: input.value.replace(/\D/g, ''), confidence: 100 };
  // Full re-render, not a single-cell patch: a VAT-rate warning depends on
  // a *pair* of fields (e.g. editing the value cell also changes whether
  // the VAT cell's rate check passes), so every row-level signal needs to
  // be recomputed, not just the one cell that changed.
  vatRenderReviewTable(window.vatExtractedPages);
}

// ── Workbook preview grid ──
// Mirrors the Excel's formula chain (Opening row, 12 fiscal months, Total
// row) so what will actually be generated is visible and correctable before
// download. Vat Paid is the one editable column: its rule-derived value is
// only a default (see vatBuildMonthRows).
function vatFmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '';
}

// Small per-month indicator comparing the computed Total against IRD's own
// item ७ read from that month's page (blank when item ७ wasn't read).
function vatIrdBadge(row) {
  if (row.missing || row.item7 === null) return '';
  if (!row.irdMismatch) return ` <span title="Matches IRD's own कुल तिर्नु पर्ने कर (item ७ = ${vatFmt(row.item7)}, sign not visible to OCR)">✓</span>`;
  return ` <span title="IRD's own कुल तिर्नु पर्ने कर reads ${vatFmt(row.item7)} (sign not visible to OCR), but the computed Total says ${vatFmt(row.total)} — the Vat Paid default may not reflect what was actually paid, or a field above was misread. Check and edit if needed.">⚠️</span>`;
}

function vatReadOpeningBalance() {
  return parseInt(document.getElementById('vat-openingBalance').value.replace(/[^\-0-9]/g, ''), 10) || 0;
}

function vatRenderWorkbookPreview() {
  const card = document.getElementById('vat-workbook-card');
  const tbody = document.getElementById('vat-workbook-tbody');
  if (!card || !tbody) return;
  const pages = window.vatExtractedPages;
  if (!pages || !pages.length) { card.style.display = 'none'; return; }

  const opening = vatReadOpeningBalance();
  const rows = vatBuildMonthRows(pages, opening, window.vatPaidOverrides);

  const openingRow = `<tr>
    <td style="font-weight:600;">Opening</td>
    <td colspan="9" style="color:var(--text-faint);">last year's closing Total</td>
    <td style="text-align:right;"><span data-wb="total-0">${vatFmt(opening)}</span></td>
  </tr>`;

  const monthRows = rows.map(row => {
    if (row.missing) {
      return `<tr data-midx="${row.idx}">
        <td style="font-weight:600;">${escHtml(row.name)}</td>
        <td colspan="9" style="color:var(--text-faint);">— not in the uploaded PDF; left blank, Total carries forward —</td>
        <td style="text-align:right;"><span data-wb="total-${row.idx}"></span></td>
      </tr>`;
    }
    const num = v => `<td style="text-align:right;">${vatFmt(v)}</td>`;
    return `<tr data-midx="${row.idx}">
      <td style="font-weight:600;">${escHtml(row.name)}</td>
      ${num(row.c)}${num(row.d)}${num(row.f)}${num(row.g)}${num(row.j)}${num(row.l)}${num(row.m)}
      <td><input type="text" data-midx="${row.idx}" value="${row.vatPaid}"
        style="width:100px; text-align:right; ${row.vatPaidOverridden ? 'border-color:var(--accent-blue); font-weight:600;' : ''}"
        title="Rule default: ${vatFmt(row.vatPaidDefault)}${row.vatPaidOverridden ? ' (overridden — clear the field to restore)' : ''}"
        oninput="vatOnVatPaidEdit(this)" onchange="vatRenderWorkbookPreview()" /></td>
      <td style="text-align:right;"><span data-wb="diff-${row.idx}">${vatFmt(row.difference)}</span></td>
      <td style="text-align:right; font-weight:600;"><span data-wb="total-${row.idx}">${vatFmt(row.total)}</span><span data-wb="ird-${row.idx}">${vatIrdBadge(row)}</span></td>
    </tr>`;
  }).join('');

  const present = rows.filter(r => !r.missing);
  const sum = key => present.reduce((a, r) => a + r[key], 0);
  const totalRow = `<tr style="background:#f8fafc;">
    <td style="font-weight:700;">Total</td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-c">${vatFmt(sum('c'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-d">${vatFmt(sum('d'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-f">${vatFmt(sum('f'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-g">${vatFmt(sum('g'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-j">${vatFmt(sum('j'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-l">${vatFmt(sum('l'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-m">${vatFmt(sum('m'))}</span></td>
    <td style="text-align:right; font-weight:600;"><span data-wb="sum-vatPaid">${vatFmt(sum('vatPaid'))}</span></td>
    <td></td><td></td>
  </tr>`;

  tbody.innerHTML = openingRow + monthRows + totalRow;
  card.style.display = 'block';
}

// Recomputes the chain and patches only the computed cells (and other rows'
// non-focused Vat Paid inputs, whose rule default shifts when an earlier
// month's Total changes) — never the input being typed in, so focus and
// cursor position survive every keystroke.
function vatRefreshComputedCells() {
  const opening = vatReadOpeningBalance();
  const rows = vatBuildMonthRows(window.vatExtractedPages, opening, window.vatPaidOverrides);
  const setWb = (key, val) => {
    const el = document.querySelector(`#vat-workbook-tbody [data-wb="${key}"]`);
    if (el) el.textContent = vatFmt(val);
  };
  setWb('total-0', opening);
  rows.forEach(row => {
    if (row.missing) return;
    setWb(`diff-${row.idx}`, row.difference);
    setWb(`total-${row.idx}`, row.total);
    const badge = document.querySelector(`#vat-workbook-tbody [data-wb="ird-${row.idx}"]`);
    if (badge) badge.innerHTML = vatIrdBadge(row);
    const input = document.querySelector(`#vat-workbook-tbody input[data-midx="${row.idx}"]`);
    if (input && input !== document.activeElement) input.value = row.vatPaid;
  });
  const present = rows.filter(r => !r.missing);
  ['c','d','f','g','j','l','m','vatPaid'].forEach(key => setWb(`sum-${key}`, present.reduce((a, r) => a + r[key], 0)));
}

function vatOnVatPaidEdit(input) {
  const idx = parseInt(input.dataset.midx, 10);
  const raw = input.value.replace(/[^\-0-9]/g, '');
  if (raw === '' || raw === '-') delete window.vatPaidOverrides[idx];
  else window.vatPaidOverrides[idx] = parseInt(raw, 10);
  vatRefreshComputedCells();
}

// ── Business rules (verbatim from the reverse-engineered template) ──
// Difference = D-G-J+L-M ; Total = prevTotal + Difference - VatPaid ;
// VatPaid[this month] defaults to prevTotal if positive, else 0 — but the
// firm's real workbooks deviate from that rule when actual payments
// differed (verified against the reference workbook: 3 of 12 months there
// don't follow it), so `vatPaidOverrides` ({ monthIdx: number }) lets the
// review UI record what was really paid; the rule is only the default.
function vatBuildMonthRows(pages, openingBalance, vatPaidOverrides) {
  const byMonthIdx = {};
  pages.forEach(pg => { if (pg.monthInfo) byMonthIdx[pg.monthInfo.idx] = pg; });

  let prevTotal = openingBalance;
  return VAT_MONTH_ORDER.map((name, i) => {
    const idx = i + 1;
    const pg = byMonthIdx[idx];
    if (!pg) return { name, idx, missing: true };

    const f = pg.fields;
    const c = vatNum(f.taxableSalesValue), d = vatNum(f.taxableSalesVat), e = vatNum(f.taxFreeSales);
    const fF = vatNum(f.taxablePurchaseValue), g = vatNum(f.taxablePurchaseVat), h = vatNum(f.exemptPurchase);
    const iVal = vatNum(f.taxableImportValue), j = vatNum(f.taxableImportVat), k = vatNum(f.exemptImport);
    const l = vatNum(f.adjustmentSalesDebit), m = vatNum(f.adjustmentPurchaseCredit);

    const vatPaidDefault = prevTotal > 0 ? prevTotal : 0;
    const hasOverride = vatPaidOverrides && vatPaidOverrides[idx] !== undefined;
    const vatPaid = hasOverride ? vatPaidOverrides[idx] : vatPaidDefault;
    const difference = d - g - j + l - m;
    const total = prevTotal + difference - vatPaid;
    prevTotal = total;

    // IRD's own कुल तिर्नु पर्ने कर (item ७) is item5 - item6 printed
    // SIGNED — mathematically the same as this row's Total whenever Vat
    // Paid reflects the real payments. OCR strips the sign, so compare
    // absolute values. A mismatch usually means the Vat Paid default
    // doesn't match what was actually paid that month.
    const item7Read = f.item7TotalPayable && f.item7TotalPayable.value !== '';
    const item7 = item7Read ? vatNum(f.item7TotalPayable) : null;
    const irdMismatch = item7Read && Math.abs(total) !== item7;

    return { name, idx, missing: false, c, d, e, f: fF, g, h, i: iVal, j, k, l, m, vatPaid, vatPaidDefault, vatPaidOverridden: hasOverride, difference, total, item7, irdMismatch };
  });
}

// ── Excel generation (ExcelJS) — matches the firm's template exactly:
// same headers, fonts, number format, Difference/Total formulas, Total row.
async function vatGenerateExcel() {
  const pages = window.vatExtractedPages;
  if (!pages || !pages.length) { vatStatus('कृपया पहिले PDF निकाल्नुहोस् (extract a PDF first).', 'info'); return; }

  // One source of truth for "is this safe to generate from" — the same
  // vatRowWarnings() the review table renders, so the block reasons shown
  // here are always exactly what's visible (as 🔴) in the table above.
  const dupIdxs = vatDuplicateMonthIdxs(pages);
  const blockingByPage = pages
    .map(pg => ({ pg, warnings: vatRowWarnings(pg, dupIdxs).filter(w => w.severity === 'block') }))
    .filter(x => x.warnings.length);
  if (blockingByPage.length) {
    const items = blockingByPage.slice(0, 6).map(x =>
      `<li>PDF p.${x.pg.pageNum}${x.pg.monthInfo ? ' (' + escHtml(x.pg.monthInfo.name) + ')' : ''}: ${x.warnings.map(w => escHtml(w.message)).join(' ')}</li>`
    ).join('');
    vatStatus(`❌ माथिको तालिकामा 🔴 चिन्ह लागेका समस्या सच्याउनुहोस् (unresolved blocking issues — fix the 🔴 rows in the table above before generating):<ul style="margin:8px 0 0 18px;">${items}</ul>`, 'error');
    return;
  }

  const companyName = document.getElementById('vat-companyName').value.trim() || 'Company Name';
  const companyAddress = document.getElementById('vat-companyAddress').value.trim();
  const openingBalance = vatReadOpeningBalance();

  const fyLabel = document.getElementById('vat-fiscalYear').value.trim();
  if (!fyLabel) { vatStatus('कृपया Fiscal Year भर्नुहोस् (fill in the Fiscal Year field before generating).', 'info'); return; }

  const rows = vatBuildMonthRows(pages, openingBalance, window.vatPaidOverrides);

  // The workbook is the firm's real template (sanitized copy committed as an
  // asset — see assets/templates/vat-detail.xlsx), loaded and filled rather
  // than rebuilt from scratch: every font/border/width/row-height/formula/
  // header quirk (including intentional ones like the missing K19 SUM) comes
  // from the real file, so fidelity is structural, not approximated.
  const buffer = await DocumentEngine.getTemplate(VAT_EXCEL_TEMPLATE_URL);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer.slice(0));
  const ws = wb.worksheets[0];

  ws.getCell('A1').value = companyName;
  ws.getCell('A2').value = companyAddress;
  ws.getCell('A3').value = `                  Detail of Sale & Purchase as per VAT Return for F.Y ${fyLabel}`;
  ws.getCell('P6').value = openingBalance;

  rows.forEach((row, i) => {
    const r = 7 + i;
    if (row.missing) {
      // Data cells are already blank in the template; blank C-N stays blank,
      // and Excel's arithmetic treats blanks as 0 so the O/P chain carries
      // the running Total forward unchanged across the gap.
      ws.getCell(r, 2).note = 'Month not found in the uploaded PDF — left blank so the Total formula chain treats it as zero.';
      return;
    }
    const vals = [row.c, row.d, row.e, row.f, row.g, row.h, row.i, row.j, row.k, row.l, row.m, row.vatPaid];
    vals.forEach((v, ci) => { ws.getCell(r, 3 + ci).value = v; });
  });

  // C21/C22 tie-out (reverse-engineered from the real workbook): C21 is a
  // static copy of the taxable-sales total and C22's "+C21-C19" formula
  // (already in the template) surfaces any later hand-edit as a non-zero
  // difference.
  ws.getCell('C21').value = rows.reduce((sum, row) => sum + (row.missing ? 0 : row.c), 0);

  // The template ships with formula results stripped — make Excel compute
  // them on first open instead of showing blank formula cells.
  wb.calcProperties = wb.calcProperties || {};
  wb.calcProperties.fullCalcOnLoad = true;

  const blob = await DocumentEngine.workbookToBlob(wb);
  const fname = `${companyName} ${fyLabel}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
  DocumentEngine.downloadBlob(blob, fname, { module: 'vatReturn', clientName: companyName });
  vatStatus('✅ Excel तयार भयो — डाउनलोड भयो (workbook generated & downloaded).', 'success');
}
