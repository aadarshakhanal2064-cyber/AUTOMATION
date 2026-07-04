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
  // Widened vs. the original calibration — investigation for Phase 3 found this
  // row's exact vertical position drifts more than the main table's rows (it
  // sits below the table, past variable-height instructional text), so a
  // tightly-calibrated box that worked on page 1 sometimes lands on the
  // जम्मा (Total) row instead on other pages. This field is a soft,
  // non-blocking cross-check (see vatRateCheck below for the primary one),
  // so a taller, more tolerant box is the right trade-off.
  item5DebitCredit:          { left: 0.8142, top: 0.6820, width: 0.1820, height: 0.0350 },
};

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

function vatCropField(canvas, placement, box) {
  return PdfEngine.cropCanvas(canvas, placement, box);
}

// `session` is an OcrEngine digit-recognition session created once per
// vatExtractPdf() run and reused for every field on every page (~140
// recognitions for a 10-page filing) — see js/core/ocrEngine.js for why
// this is session-based rather than a one-shot call.
async function vatExtractField(session, canvas, placement, boxName) {
  const crop = vatCropField(canvas, placement, VAT_FIELD_BOXES[boxName]);
  return session.recognizeDigits(crop);
}

// ── One page's full extraction ──
async function vatExtractPage(session, pdf, pageNum) {
  const { canvas, placement } = await vatRenderPageCanvas(pdf, pageNum, 3);
  const fields = {};
  const boxNames = Object.keys(VAT_FIELD_BOXES);
  for (let i = 0; i < boxNames.length; i++) {
    fields[boxNames[i]] = await vatExtractField(session, canvas, placement, boxNames[i]);
  }
  return fields;
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
      return;
    }

    const pages = [];
    let lastGoodMonthIdx = null; // period OCR is the least reliable field — fall back to
                                  // "previous page's month + 1" (PDF pages are sequential
                                  // monthly filings) whenever the digit isn't recognized.
    let session = null;
    try {
      vatStatus('<span class="spinner spinner-navy"></span> OCR इन्जिन तयार गर्दै (starting OCR engine)…', 'searching');
      session = await OcrEngine.createDigitSession();

      for (let p = 1; p <= pdf.numPages; p++) {
        vatStatus(`<span class="spinner spinner-navy"></span> पृष्ठ ${p}/${pdf.numPages} पढ्दै (reading page ${p} of ${pdf.numPages})…`, 'searching');
        const fields = await vatExtractPage(session, pdf, p);
        const period = vatNum(fields.period);
        let monthInfo = VAT_PERIOD_TO_MONTH[period];
        let monthGuessed = false;
        if (!monthInfo && lastGoodMonthIdx !== null && lastGoodMonthIdx < 12) {
          const idx = lastGoodMonthIdx + 1;
          monthInfo = { name: VAT_MONTH_ORDER[idx - 1], idx };
          monthGuessed = true;
        }
        if (monthInfo) lastGoodMonthIdx = monthInfo.idx;
        pages.push({ pageNum: p, period, fields, monthInfo, monthGuessed });
      }
    } finally {
      if (session) await session.terminate(); // always release the WASM worker, even if extraction threw
    }

    window.vatExtractedPages = pages;
    vatRenderReviewTable(pages);

    const fyField = document.getElementById('vat-fiscalYear');
    if (fyField && !fyField.value.trim()) {
      const firstYearPage = pages.filter(pg => pg.monthInfo).sort((a, b) => a.monthInfo.idx - b.monthInfo.idx)[0];
      const taxYear = firstYearPage ? vatNum(firstYearPage.fields.taxYear) : 0;
      if (taxYear) fyField.value = `${taxYear}.0${(taxYear + 1) % 100}`;
    }

    const unresolved = pages.filter(pg => !pg.monthInfo).length;
    const guessed = pages.filter(pg => pg.monthGuessed).length;
    const note = unresolved > 0 ? `${unresolved} page(s) need a month picked manually` : guessed > 0 ? `${guessed} page(s)' month was inferred from sequence — please confirm` : 'all months read correctly';
    vatStatus(`✅ ${pdf.numPages} पृष्ठ पढियो — ${note} (extracted ${pdf.numPages} pages — review below before generating).`, unresolved > 0 ? 'error' : 'success');
  } catch (err) {
    vatStatus('❌ ' + (err.message || 'Extraction failed'), 'error');
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

const VAT_CONFIDENCE_HIGH = 80, VAT_CONFIDENCE_MEDIUM = 50;
function vatConfidenceTier(confidence) {
  if (confidence >= VAT_CONFIDENCE_HIGH) return { tier: 'high', icon: '🟢', label: 'High' };
  if (confidence >= VAT_CONFIDENCE_MEDIUM) return { tier: 'medium', icon: '🟡', label: 'Medium' };
  return { tier: 'low', icon: '🔴', label: 'Low' };
}

// Every reason a row might not be safe to generate from, in one place, each
// with a plain-language explanation — this is what both the review table
// and the generate-blocking check read from, so they can never disagree.
function vatRowWarnings(pg, dupIdxs) {
  const warnings = [];
  const f = pg.fields;

  if (!pg.monthInfo) {
    warnings.push({ severity: 'block', message: `Month not recognized (OCR read period "${f.period.value || '(blank)'}") — pick one manually.` });
  } else if (dupIdxs.has(pg.monthInfo.idx)) {
    warnings.push({ severity: 'block', message: `Another page is also assigned to ${pg.monthInfo.name} — one of them is wrong and will silently overwrite the other.` });
  } else if (pg.monthGuessed) {
    warnings.push({ severity: 'warn', message: 'Month was inferred from page sequence, not read directly — please confirm.' });
  }

  const salesRate = vatRateCheck(vatNum(f.taxableSalesValue), vatNum(f.taxableSalesVat));
  if (!salesRate.ok) warnings.push({ severity: 'block', message: `Sales VAT doesn't match 13% of taxable sales (expected ~${salesRate.expected}, read ${vatNum(f.taxableSalesVat)}) — one of the two was likely misread.` });

  const purchaseRate = vatRateCheck(vatNum(f.taxablePurchaseValue), vatNum(f.taxablePurchaseVat));
  if (!purchaseRate.ok) warnings.push({ severity: 'block', message: `Purchase VAT doesn't match 13% of taxable purchase (expected ~${purchaseRate.expected}, read ${vatNum(f.taxablePurchaseVat)}) — one of the two was likely misread.` });

  const importRate = vatRateCheck(vatNum(f.taxableImportValue), vatNum(f.taxableImportVat));
  if (!importRate.ok) warnings.push({ severity: 'warn', message: `Import VAT doesn't match 13% of taxable import (expected ~${importRate.expected}, read ${vatNum(f.taxableImportVat)}).` });

  if (f.taxableSalesValue.value === '' && f.taxablePurchaseValue.value === '') {
    warnings.push({ severity: 'block', message: 'No sales or purchase figures were read at all on this page — check the upload or enter the values manually.' });
  }

  const chk = vatChecksum(f);
  if (!chk.ok) warnings.push({ severity: 'warn', message: `Form's own डेबिट-क्रेडिट total (${chk.printed || '(blank)'}) doesn't match the computed difference (${chk.computed}) — this field is the least reliable to OCR, treat as informational.` });

  const lowConfidenceFields = Object.entries(f)
    .filter(([name, field]) => name !== 'taxYear' && field.confidence > 0 && field.confidence < VAT_CONFIDENCE_MEDIUM)
    .map(([name]) => name);
  if (lowConfidenceFields.length) warnings.push({ severity: 'warn', message: `Low OCR confidence on: ${lowConfidenceFields.join(', ')}.` });

  return warnings;
}

function vatRowStatusHtml(warnings) {
  if (!warnings.length) return '<span title="No issues found">✅</span>';
  const blocking = warnings.filter(w => w.severity === 'block');
  const icon = blocking.length ? '🔴' : '🟡';
  const tooltip = warnings.map(w => (w.severity === 'block' ? '[blocking] ' : '') + w.message).join('\n');
  return `<span title="${escHtml(tooltip)}">${icon} ${warnings.length} issue${warnings.length > 1 ? 's' : ''}</span>`;
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
    const needsAttention = warnings.some(w => w.severity === 'block') || pg.monthGuessed;
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

// ── Business rules (verbatim from the reverse-engineered template) ──
// Difference = D-G-J+L-M ; Total = prevTotal + Difference - VatPaid ;
// VatPaid[this month] = prevTotal if prevTotal > 0 else 0.
function vatBuildMonthRows(pages, openingBalance) {
  const byMonthIdx = {};
  pages.forEach(pg => { if (pg.monthInfo) byMonthIdx[pg.monthInfo.idx] = pg; });

  let prevTotal = openingBalance;
  return VAT_MONTH_ORDER.map((name, i) => {
    const idx = i + 1;
    const pg = byMonthIdx[idx];
    if (!pg) return { name, missing: true };

    const f = pg.fields;
    const c = vatNum(f.taxableSalesValue), d = vatNum(f.taxableSalesVat), e = vatNum(f.taxFreeSales);
    const fF = vatNum(f.taxablePurchaseValue), g = vatNum(f.taxablePurchaseVat), h = vatNum(f.exemptPurchase);
    const iVal = vatNum(f.taxableImportValue), j = vatNum(f.taxableImportVat), k = vatNum(f.exemptImport);
    const l = vatNum(f.adjustmentSalesDebit), m = vatNum(f.adjustmentPurchaseCredit);

    const vatPaid = prevTotal > 0 ? prevTotal : 0;
    const difference = d - g - j + l - m;
    const total = prevTotal + difference - vatPaid;
    prevTotal = total;

    return { name, missing: false, c, d, e, f: fF, g, h, i: iVal, j, k, l, m, vatPaid, difference, total };
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
  const openingBalance = parseInt(document.getElementById('vat-openingBalance').value.replace(/[^\-0-9]/g, ''), 10) || 0;

  const fyLabel = document.getElementById('vat-fiscalYear').value.trim();
  if (!fyLabel) { vatStatus('कृपया Fiscal Year भर्नुहोस् (fill in the Fiscal Year field before generating).', 'info'); return; }

  const rows = vatBuildMonthRows(pages, openingBalance);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.columns = [5.33,11.1,19.1,17.9,17.9,20.9,17.9,21.4,28.6,17.9,29,20,24.9,16.4,17.6,17.6,12.3].map(w => ({ width: w }));

  const numFmt = '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)';
  ws.mergeCells('A1:P1'); ws.getCell('A1').value = companyName;
  ws.getCell('A1').font = { bold: true, size: 19, name: 'Arial' };
  ws.mergeCells('A2:P2'); ws.getCell('A2').value = companyAddress;
  ws.getCell('A2').font = { bold: true, size: 11, name: 'Arial' };
  ws.mergeCells('A3:P3'); ws.getCell('A3').value = `                  Detail of Sale & Purchase as per VAT Return for F.Y ${fyLabel}`;
  ws.getCell('A3').font = { size: 14, name: 'Arial' };

  const headers = ['S.no','Month','Taxable Sales','VAT','Tax Free Sales','Taxable Purchase','VAT','Tax Free Purchase',
    'Taxable Import Purchase','Vat','Tax Free Import Purchase','Adjustment Sales','Adjustment purchase','Vat Paid','Difference','Total'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(5, i + 1);
    cell.value = h;
    cell.font = { size: 11, name: 'Century Gothic' };
    if (i >= 2) cell.numFmt = numFmt;
  });

  ws.getCell('A6').value = 1;
  ws.getCell('A6').font = { size: 12, name: 'Century Gothic' };
  ws.getCell('B6').value = 'Opening';
  ws.getCell('B6').font = { size: 12, name: 'Century Gothic' };
  ws.getCell('P6').value = openingBalance;
  ws.getCell('P6').numFmt = numFmt;
  ws.getCell('P6').font = { size: 12, name: 'Century Gothic' };

  const dataFont = { size: 12, name: 'Century Gothic' };
  rows.forEach((row, i) => {
    const r = 7 + i;
    ws.getCell(r, 1).value = i + 2;
    ws.getCell(r, 1).font = dataFont;
    ws.getCell(r, 2).value = row.name;
    ws.getCell(r, 2).font = { size: 11, name: 'Century Gothic' };

    if (row.missing) {
      ws.getCell(r, 2).note = 'Month not found in the uploaded PDF — left blank so the Total formula chain treats it as zero.';
    } else {
      const vals = [row.c, row.d, row.e, row.f, row.g, row.h, row.i, row.j, row.k, row.l, row.m, row.vatPaid];
      vals.forEach((v, ci) => {
        const cell = ws.getCell(r, 3 + ci);
        cell.value = v;
        cell.numFmt = numFmt;
        cell.font = dataFont;
      });
    }
    const oCell = ws.getCell(r, 15);
    oCell.value = { formula: `D${r}-G${r}-J${r}+L${r}-M${r}` };
    oCell.numFmt = numFmt; oCell.font = dataFont;
    const pCell = ws.getCell(r, 16);
    pCell.value = { formula: `P${r - 1}+O${r}-N${r}` };
    pCell.numFmt = numFmt; pCell.font = dataFont;
  });

  const totalRow = 7 + rows.length;
  ws.getCell(totalRow, 2).value = 'Total';
  ws.getCell(totalRow, 2).font = { size: 11, name: 'Century Gothic' };
  [3,4,5,6,7,8,9,10,11,12,13,14].forEach(col => {
    const colLetter = ws.getColumn(col).letter;
    const cell = ws.getCell(totalRow, col);
    cell.value = { formula: `SUM(${colLetter}7:${colLetter}${totalRow - 1})` };
    cell.numFmt = numFmt; cell.font = dataFont;
  });

  const blob = await DocumentEngine.workbookToBlob(wb);
  const fname = `VAT Return ${companyName} ${fyLabel}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
  DocumentEngine.downloadBlob(blob, fname);
  vatStatus('✅ Excel तयार भयो — डाउनलोड भयो (workbook generated & downloaded).', 'success');
}
