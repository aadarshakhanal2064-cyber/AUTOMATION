// ════════════════════════════════════════════
//  CONFIRMATION LETTERS
//  Bulk-generates "Confirmation of Account Balance & Transaction" letters —
//  one per customer/supplier of an audit client — from an already-generated
//  Sales & Purchase Book workbook (js/salesPurchaseBook.js). Reads that
//  workbook's "Sales Details"/"Purchase Details" sheets (own file format,
//  not third-party data — see spbSheetDetails() for the exact column
//  layout this parses back), finds every party whose Taxable Sales or
//  Purchase crosses a threshold (default 1 lakh), and lets the user pick
//  exactly which ones to generate before anything is produced.
//
//  Standalone tab (not fed by a live SPB session) — the user uploads the
//  generated workbook each time, independent of any Sales & Purchase Book
//  session. Same DocumentEngine template architecture as bmAgmMinutes.js /
//  auditorChange.js: one tokenized .docx template, filled per letter and
//  looped via docxtemplater's paragraphLoop (the whole per-party block,
//  including the table, repeats — not just a list of items).
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Accounting" dropdown, not a sidebar button.
ModuleRegistry.register({ id: 'confirmationLetters', group: 'main', buttonId: null, panelId: 'tab-confirmationLetters-panel' });

const CL_TEMPLATE_URL = 'assets/templates/confirmation-letter.docx';
const CL_DEFAULT_THRESHOLD = 100000;

// ── Module state ──
let clClientId = null;      // set only when the company search matched a real clients row
let clCandidates = [];      // [{ key, name, pan, salesTaxable, salesVat, purchaseTaxable, purchaseVat,
                             //    include, openingBalance, closingBalance }]
let clShowBelowThreshold = false;

function clStatus(html, type) { showStatus(html, type, 'cl-status'); }

function clNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function clFmt(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Accounting-style: a zero/blank amount prints as "-" on the letter (matches
// the firm's format), a real amount prints comma-grouped with 2 decimals.
function clDash(n) {
  const v = clNum(n);
  return v === 0 ? '-' : clFmt(v);
}

function clVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

// ════════════════════════════════════════════
//  INIT — fiscal year dropdown + company search, once.
// ════════════════════════════════════════════
function clInit() {
  clBuildFyOptions();
  clAttachCompanySearch();
  // Default the letter date to today's B.S. date (YYYY.MM.DD), editable.
  const dateEl = document.getElementById('cl-date');
  if (dateEl && !dateEl.value) {
    const bs = NepaliLocale.todayBs && NepaliLocale.todayBs();
    if (bs) dateEl.value = `${bs.year}.${String(bs.month).padStart(2, '0')}.${String(bs.day).padStart(2, '0')}`;
  }
}

function clBuildFyOptions() {
  const sel = document.getElementById('cl-fy');
  if (!sel || sel.dataset.built) return;
  const bs = NepaliLocale.todayBs && NepaliLocale.todayBs();
  const cur = bs ? (bs.month >= 4 ? bs.year : bs.year - 1) : 2081;
  let html = '';
  for (let y = cur - 4; y <= cur + 1; y++) {
    const label = y + '-' + String((y + 1) % 100).padStart(2, '0');
    html += `<option value="${label}"${y === cur ? ' selected' : ''}>${label}</option>`;
  }
  sel.innerHTML = html;
  sel.dataset.built = '1';
}

// Letters write FY as "2081/082" — slash, but the second year keeps its
// leading zero and only drops the millennium digit. A 4th documented FY
// string format alongside the three in CLAUDE.md §9.5 (dash/slash/dot).
function clFyLabel() {
  const m = clVal('cl-fy').match(/(\d{4})/);
  if (!m) return '';
  const y = parseInt(m[1], 10);
  return `${y}/${String(y + 1).slice(1)}`;
}

function clAttachCompanySearch() {
  const input = document.getElementById('cl-company');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  SearchEngine.attachAutocomplete(input, document.getElementById('cl-company-autocomplete-list'), {
    getList: () => window.clientsList,
    keys: ['name', 'pan'],
    minChars: 2,
    normalizeQuery: v => NepaliLocale.toEnglishDigits(v),
    normalizeItem: c => ({ name: c.name, pan: NepaliLocale.toEnglishDigits(c.pan) }),
    renderItem: c => `
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.pan || '')}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    `,
    onSelect: c => {
      clClientId = c.id != null ? c.id : null;
      input.value = c.name || '';
      document.getElementById('cl-firm-name').value = c.name || '';
      document.getElementById('cl-firm-address').value = c.address || '';
      document.getElementById('cl-firm-pan').value = c.pan || '';
      document.getElementById('cl-firm-phone').value = c.phone || '';
    },
  });
  input.addEventListener('input', () => { clClientId = null; });
}

// ════════════════════════════════════════════
//  UPLOAD + PARSE — reads the SPB workbook's own output format back.
// ════════════════════════════════════════════
function clHandleUpload(fileInput) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  clStatus('<span class="spinner spinner-navy"></span> Reading workbook…', 'searching');

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const salesSheet = wb.Sheets['Sales Details'];
      const purchaseSheet = wb.Sheets['Purchase Details'];
      if (!salesSheet && !purchaseSheet) {
        throw new Error('Neither "Sales Details" nor "Purchase Details" sheet was found — is this a Sales & Purchase Book workbook generated by this app?');
      }
      const salesRows = salesSheet ? clParseDetailsSheet(salesSheet) : [];
      const purchaseRows = purchaseSheet ? clParseDetailsSheet(purchaseSheet) : [];
      clCandidates = clBuildCandidates(salesRows, purchaseRows);

      const missing = [];
      if (!salesSheet) missing.push('"Sales Details" sheet not found');
      if (!purchaseSheet) missing.push('"Purchase Details" sheet not found');
      const crossing = clCandidates.filter(c => clCrossesThreshold(c)).length;
      clStatus(
        `✅ Sales Details: <strong>${salesRows.length}</strong> parties · Purchase Details: <strong>${purchaseRows.length}</strong> parties · ` +
        `<strong>${crossing}</strong> cross the threshold.` +
        (missing.length ? `<br>⚠ ${missing.join(', ')}.` : ''),
        'success'
      );
      clRenderTable();
    } catch (err) {
      clCandidates = [];
      clRenderTable();
      clStatus('❌ ' + (err.message || 'Could not read the workbook.'), 'error');
    }
  };
  reader.onerror = () => clStatus('❌ Failed to read the file.', 'error');
  reader.readAsBinaryString(file);
}

// Column layout written by spbSheetDetails(): A S.No., B "<Party> Total",
// C Pan No., D Tax Free, E Taxable Amount, F Vat. Stops at the bold
// "Grand Total" row. (The firm's newer letter format shows Tax Free too,
// so it's no longer discarded.)
function clParseDetailsSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = String(r[1] || '').trim();
    if (!rawName || rawName === 'Grand Total') break;
    out.push({
      name: rawName.replace(/\s+Total$/i, ''),
      pan: String(r[2] || '').trim(),
      taxfree: clNum(r[3]),
      taxable: clNum(r[4]),
      vat: clNum(r[5]),
    });
  }
  return out;
}

function clBuildCandidates(salesRows, purchaseRows) {
  const map = new Map();
  const norm = s => s.trim().toUpperCase();
  const get = key => {
    if (!map.has(key)) map.set(key, {
      key, name: '', pan: '',
      salesTaxfree: 0, salesTaxable: 0, salesVat: 0,
      purchaseTaxfree: 0, purchaseTaxable: 0, purchaseVat: 0,
      include: false, openingBalance: '', closingBalance: '',
    });
    return map.get(key);
  };
  salesRows.forEach(r => {
    const c = get(norm(r.name));
    c.name = r.name; if (r.pan) c.pan = r.pan;
    c.salesTaxfree = r.taxfree; c.salesTaxable = r.taxable; c.salesVat = r.vat;
  });
  purchaseRows.forEach(r => {
    const c = get(norm(r.name));
    c.name = c.name || r.name; if (r.pan && !c.pan) c.pan = r.pan;
    c.purchaseTaxfree = r.taxfree; c.purchaseTaxable = r.taxable; c.purchaseVat = r.vat;
  });
  const list = Array.from(map.values());
  list.forEach(c => { c.include = clCrossesThreshold(c); });
  list.sort((a, b) => Math.max(b.salesTaxable, b.purchaseTaxable) - Math.max(a.salesTaxable, a.purchaseTaxable));
  return list;
}

function clThreshold() {
  const n = clNum(clVal('cl-threshold'));
  return n > 0 ? n : CL_DEFAULT_THRESHOLD;
}

function clCrossesThreshold(c) {
  const t = clThreshold();
  return c.salesTaxable > t || c.purchaseTaxable > t;
}

// ════════════════════════════════════════════
//  REVIEW & SELECT grid
// ════════════════════════════════════════════
function clOnThresholdChange() {
  clRenderTable();
}

function clToggleShowBelowThreshold(checked) {
  clShowBelowThreshold = checked;
  clRenderTable();
}

function clVisibleRows() {
  return clCandidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => clCrossesThreshold(c) || c.include || clShowBelowThreshold);
}

function clSelectAll(checked) {
  clVisibleRows().forEach(({ i }) => { clCandidates[i].include = checked; });
  clRenderTable();
}

function clToggleInclude(i, checked) {
  clCandidates[i].include = checked;
}

function clFieldInput(i, field, value) {
  const textFields = ['openingBalance', 'closingBalance'];
  clCandidates[i][field] = textFields.includes(field) ? value : clNum(value);
}

function clRenderTable() {
  const card = document.getElementById('cl-review-card');
  if (!clCandidates.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const rows = clVisibleRows();
  const inp = (i, field, val, placeholder) =>
    `<td><input class="cl-in" inputmode="decimal" placeholder="${placeholder || ''}" value="${val === '' || val == null ? '' : val}" oninput="clFieldInput(${i}, '${field}', this.value)"></td>`;

  document.getElementById('cl-review-body').innerHTML = rows.map(({ c, i }) => `
    <tr>
      <td><input type="checkbox" ${c.include ? 'checked' : ''} onchange="clToggleInclude(${i}, this.checked)"></td>
      <td>${escHtml(c.name)}</td>
      <td>${escHtml(c.pan || '—')}</td>
      ${inp(i, 'salesTaxfree', c.salesTaxfree || '')}
      ${inp(i, 'salesTaxable', c.salesTaxable || '')}
      ${inp(i, 'salesVat', c.salesVat || '')}
      ${inp(i, 'purchaseTaxfree', c.purchaseTaxfree || '')}
      ${inp(i, 'purchaseTaxable', c.purchaseTaxable || '')}
      ${inp(i, 'purchaseVat', c.purchaseVat || '')}
      ${inp(i, 'openingBalance', c.openingBalance, '–')}
      ${inp(i, 'closingBalance', c.closingBalance, '–')}
      <td><button class="btn btn-outline btn-sm" onclick="clPreviewOne(${i})">Preview</button></td>
    </tr>`).join('');

  document.getElementById('cl-review-count').textContent =
    `${rows.filter(({ c }) => c.include).length} of ${rows.length} selected`;
}

// ════════════════════════════════════════════
//  DOCUMENT GENERATION — one render function reused for both the combined
//  doc and every individual letter (§11.1 — never duplicate the render
//  logic). The template loops {{#letters}}...{{/letters}} over whatever
//  array is passed in.
// ════════════════════════════════════════════
function clFirmData() {
  return {
    firmName: clVal('cl-firm-name'),
    firmAddress: clVal('cl-firm-address'),
    firmPan: clVal('cl-firm-pan'),
    firmPhone: clVal('cl-firm-phone'),
    letterDate: clVal('cl-date'),
  };
}

// Row total = Tax Free + Taxable + Vat (the firm's newer format sums all
// three). A side with nothing on it prints "-" across, matching the samples.
function clBuildLetterData(c) {
  const firm = clFirmData();
  const salesSum = clNum(c.salesTaxfree) + clNum(c.salesTaxable) + clNum(c.salesVat);
  const purchaseSum = clNum(c.purchaseTaxfree) + clNum(c.purchaseTaxable) + clNum(c.purchaseVat);
  return {
    partyName: c.name,
    partyPan: c.pan || '',
    fyLabel: clFyLabel(),
    // Opening/Closing carry no ledger data from the workbook — "-" unless the
    // user types a balance in the grid (kept editable per the original design).
    openingTaxfree: '-', openingTaxable: '-', openingVat: '-',
    openingBalance: c.openingBalance ? clFmt(c.openingBalance) : '-',
    salesTaxfree: clDash(c.salesTaxfree),
    salesTaxable: clDash(c.salesTaxable),
    salesVat: clDash(c.salesVat),
    salesTotal: salesSum === 0 ? '-' : clFmt(salesSum),
    purchaseTaxfree: clDash(c.purchaseTaxfree),
    purchaseTaxable: clDash(c.purchaseTaxable),
    purchaseVat: clDash(c.purchaseVat),
    purchaseTotal: purchaseSum === 0 ? '-' : clFmt(purchaseSum),
    closingTaxfree: '-', closingTaxable: '-', closingVat: '-',
    closingBalance: c.closingBalance ? clFmt(c.closingBalance) : '-',
    contactPhone: firm.firmPhone,
  };
}

async function clRenderLetters(items) {
  const buffer = await DocumentEngine.getTemplate(CL_TEMPLATE_URL);
  const firm = clFirmData();
  const letters = items.map((it, i) => Object.assign({}, it, { last: i === items.length - 1 }));
  return DocumentEngine.renderWord(buffer, Object.assign({}, firm, { letters }));
}

function clSelectedCandidates() {
  return clVisibleRows().map(({ c }) => c).filter(c => c.include);
}

function clSafeFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_');
}

function clValidateFirm() {
  if (!clVal('cl-firm-name')) { clStatus('Enter or select the issuing company first.', 'info'); return false; }
  if (!clVal('cl-fy')) { clStatus('Select a fiscal year.', 'info'); return false; }
  return true;
}

async function clGenerateAll() {
  if (!clValidateFirm()) return;
  const selected = clSelectedCandidates();
  if (!selected.length) { clStatus('Tick at least one party to generate.', 'info'); return; }

  try {
    clStatus(`<span class="spinner spinner-navy"></span> Generating ${selected.length} letter(s)…`, 'searching');
    const firmName = clVal('cl-firm-name');
    const fyTag = clVal('cl-fy');
    const items = selected.map(clBuildLetterData);

    const combinedBlob = await clRenderLetters(items);
    const combinedName = clSafeFilename(`Confirmation Letters - ${firmName} - ${fyTag}`) + '.docx';
    DocumentEngine.downloadBlob(combinedBlob, combinedName, { module: 'confirmationLetters', clientName: firmName });

    const zip = new JSZip();
    for (let i = 0; i < items.length; i++) {
      const blob = await clRenderLetters([items[i]]);
      zip.file(clSafeFilename(`Confirmation Letter - ${selected[i].name}`) + '.docx', blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipName = clSafeFilename(`Confirmation Letters - ${firmName} - ${fyTag}`) + '.zip';
    DocumentEngine.downloadBlob(zipBlob, zipName, { module: 'confirmationLetters', clientName: firmName });

    clStatus(`✅ Generated ${selected.length} letter(s) — combined document and ZIP downloaded.`, 'success');
  } catch (err) {
    clStatus('❌ ' + (err.message || 'Generation failed.'), 'error');
  }
}

// ════════════════════════════════════════════
//  PREVIEW — the preview IS the real generated docx (docx-preview), never a
//  separately maintained HTML mockup. Same mechanism as BM/AGM/Auditor Change.
// ════════════════════════════════════════════
async function clShowPreview(blob) {
  const placeholder = document.getElementById('cl-preview-placeholder');
  const root = document.getElementById('cl-preview-root');
  const card = document.getElementById('cl-preview-card');
  card.style.display = 'block';
  try {
    await DocumentEngine.previewWordAsHtml(blob, root, document.getElementById('cl-preview-style'), {
      className: 'bm-docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true,
    });
    placeholder.style.display = 'none';
    root.style.display = 'block';
  } catch (err) {
    console.error('Confirmation Letters preview render failed:', err);
  }
}

async function clPreviewOne(i) {
  if (!clValidateFirm()) return;
  const c = clCandidates[i];
  const blob = await clRenderLetters([clBuildLetterData(c)]);
  await clShowPreview(blob);
}

async function clPreviewCombined() {
  if (!clValidateFirm()) return;
  const selected = clSelectedCandidates();
  if (!selected.length) { clStatus('Tick at least one party to preview.', 'info'); return; }
  const blob = await clRenderLetters(selected.map(clBuildLetterData));
  await clShowPreview(blob);
}
