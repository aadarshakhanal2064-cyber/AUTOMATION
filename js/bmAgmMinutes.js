// ════════════════════════════════════════════
//  BM/AGM MINUTES — Company Registration Number search
//  Reuses window.clientsList (already loaded by clients.js) — no
//  extra Supabase queries. Mirrors report.js's PAN-search pattern
//  (search by an alternate identifier, not the primary name field)
//  combined with clients.js's keyboard navigation, since report.js's
//  own PAN search doesn't have keyboard nav to copy directly.
// ════════════════════════════════════════════
// Client data stores registration numbers (and sometimes PAN) in Devanagari
// numerals, but people naturally type English digits on a keyboard. Normalize
// both the typed value and the stored value to plain English digits before
// comparing, so either digit system matches regardless of which was used to
// store or search.
function bmToEnglishDigits(s) {
  return NepaliLocale.toEnglishDigits(s);
}

function handleBmRegNoSearch(val) {
  window.bmSelectedIdx = -1;
  const list = document.getElementById('bm-regNo-autocomplete-list');
  if (!val || val.length < 2 || !Array.isArray(window.clientsList)) { list.style.display = 'none'; return; }

  const v = bmToEnglishDigits(val).toLowerCase();
  const matches = window.clientsList.filter(c =>
    bmToEnglishDigits(c.registration_number).toLowerCase().includes(v) ||
    bmToEnglishDigits(c.pan).toLowerCase().includes(v)
  ).slice(0, 8);

  if (matches.length === 0) { list.style.display = 'none'; return; }

  list.innerHTML = matches.map((c, i) => `
    <div class="autocomplete-item" data-idx="${i}" onmousedown="selectBmClient('${c.id}')">
      <div class="ac-name">${escHtml(c.registration_number || c.pan)}</div>
      <div class="ac-email">${escHtml(c.name)}${c.pan ? ' · PAN ' + escHtml(c.pan) : ''}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    </div>
  `).join('');
  list.style.display = 'block';
}

function handleBmRegNoKey(e) {
  const list = document.getElementById('bm-regNo-autocomplete-list');
  const items = list.querySelectorAll('.autocomplete-item');
  if (!items.length || list.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    window.bmSelectedIdx = Math.min(window.bmSelectedIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    window.bmSelectedIdx = Math.max(window.bmSelectedIdx - 1, 0);
  } else if (e.key === 'Enter' && window.bmSelectedIdx >= 0) {
    e.preventDefault();
    items[window.bmSelectedIdx].dispatchEvent(new Event('mousedown'));
    return;
  } else if (e.key === 'Escape') {
    list.style.display = 'none'; return;
  }
  items.forEach((el, i) => el.classList.toggle('selected', i === window.bmSelectedIdx));
}

async function selectBmClient(id) {
  const c = window.clientsList.find(x => String(x.id) === String(id));
  if (!c) return;
  document.getElementById('bm-regNo').value           = c.registration_number || '';
  document.getElementById('bm-companyName').value     = c.name || '';
  document.getElementById('bm-pan').value              = c.pan || '';
  document.getElementById('bm-address').value          = c.address || '';
  document.getElementById('bm-chairmanName').value     = c.chairman_name || '';
  document.getElementById('bm-shareholderName').value  = c.shareholder_name || '';
  document.getElementById('bm-authCapital').value      = c.authorized_capital || '';
  document.getElementById('bm-issuedCapital').value    = c.issued_capital || '';
  document.getElementById('bm-paidUpCapital').value    = c.paid_up_capital || '';
  document.getElementById('bm-regNo-autocomplete-list').style.display = 'none';

  bmClearExtraShareholders();
  const { data, error } = await window.sb
    .from('client_shareholders')
    .select('name')
    .eq('client_id', c.id)
    .order('sort_order');
  if (!error && data) data.forEach(row => bmAddShareholderRow(row.name));

  bmRenderCompanySummary(c);
  bmOnFormChanged();
}

// ── Compact company summary card ──
// Once a company is selected, its rarely-re-edited fields (name, PAN,
// address, etc.) collapse into this summary instead of permanently
// occupying form space — "Edit Company Details" re-reveals the raw inputs.
function bmRenderCompanySummary(c) {
  const wrap = document.getElementById('bm-company-summary');
  const grid = document.getElementById('bm-summary-grid');
  const editFields = document.getElementById('bm-company-edit-fields');
  const toggleBtn = document.getElementById('bm-edit-toggle-btn');
  if (!wrap || !grid || !editFields) return;

  const rows = [
    ['Company', c.name],
    ['Registration', c.registration_number],
    ['Chairman', c.chairman_name],
    ['Shareholders', String(bmGetAllShareholderNames().length)],
    ['PAN', c.pan],
    ['Address', c.address],
  ];
  grid.innerHTML = rows.map(([label, value]) => `
    <div class="bm-summary-row">
      <div class="bm-summary-label">${escHtml(label)}</div>
      <div class="bm-summary-value">${escHtml(value || '—')}</div>
    </div>
  `).join('');

  wrap.style.display = 'block';
  editFields.style.display = 'none';
  if (toggleBtn) toggleBtn.textContent = 'Edit Company Details';
}

function bmToggleCompanyEdit() {
  const editFields = document.getElementById('bm-company-edit-fields');
  const toggleBtn = document.getElementById('bm-edit-toggle-btn');
  if (!editFields) return;
  const willOpen = editFields.style.display === 'none';
  editFields.style.display = willOpen ? 'block' : 'none';
  if (toggleBtn) toggleBtn.textContent = willOpen ? 'Hide Company Details' : 'Edit Company Details';
}

// ── Dynamic "additional shareholder" rows ──
// bm-shareholderName (fixed field) is always shareholder #2 in the attendee
// list (chairman is #1); every row added here is #3 onward, in order.
function bmAddShareholderRow(name) {
  const wrap = document.getElementById('bm-extra-shareholders');
  const row = document.createElement('div');
  row.className = 'bm-shareholder-row';
  row.style.cssText = 'display:flex; gap:8px; margin-top:8px;';
  row.innerHTML = `
    <input type="text" class="bm-extra-shareholder-input" placeholder="Additional shareholder name" style="flex:1;" />
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); bmOnFormChanged();">Remove</button>
  `;
  wrap.appendChild(row);
  if (name) row.querySelector('input').value = name;
  bmOnFormChanged();
}

function bmClearExtraShareholders() {
  document.getElementById('bm-extra-shareholders').innerHTML = '';
}

// Full attendee list in order: chairman, then every shareholder name (fixed
// field + any additional rows), skipping blanks.
function bmGetAllShareholderNames() {
  const names = [document.getElementById('bm-shareholderName').value.trim()];
  document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input').forEach(inp => {
    names.push(inp.value.trim());
  });
  return names.filter(Boolean);
}

// Close autocomplete on outside click — mirrors report.js's PAN-search listener
document.addEventListener('click', function (e) {
  const list = document.getElementById('bm-regNo-autocomplete-list');
  if (list && !e.target.closest('#bm-regNo') && e.target.id !== 'bm-regNo') {
    list.style.display = 'none';
  }
});

// ════════════════════════════════════════════
//  BM/AGM MINUTES — document generation
//  Fills the Unicode/Mangal .docx template (assets/templates) with form
//  values via docxtemplater. Client data is already Unicode Nepali; only
//  numbers and B.S. dates need conversion to Devanagari here.
// ════════════════════════════════════════════
const BM_TEMPLATE_URL = 'assets/templates/bm-agm-minutes.docx';

// Pre-configured audit firms - selecting one in the dropdown fills in the
// firm name, auditor's full name, and the correct professional title (CA
// vs RA use different Nepali phrasing throughout the letters).
const BM_AUDIT_FIRMS = [
  { firmName: 'शैलेश एण्ड एसोसिएट्स', auditorName: 'शैलेश डल्लाकोटी', title: 'सीए' },
  { firmName: 'डल्लाकोटी एण्ड कम्पनी', auditorName: 'देवी प्रसाद डल्लाकोटी', title: 'आर.ए.' },
];

function bmToDevanagari(s) {
  return NepaliLocale.toDevanagari(s);
}

// "30,000,000.00" -> "३,००,००,०००" (Nepali lakh/crore grouping, Devanagari, no decimals)
function bmFormatAmount(raw) {
  return NepaliLocale.formatAmount(raw);
}

// "2079/09/15" -> { year:२०७९, monthName:पौष, day:१५, full:२०७९/०९/१५ }
function bmParseBsDate(str) {
  return NepaliLocale.parseBsDate(str);
}

// "2078-79" -> { fy:"०७८/७९", next:"०७९/८०" }
function bmFiscalParts(fyValue) {
  return NepaliLocale.fiscalParts(fyValue);
}

function bmStatus(html, type) {
  showStatus(html, type, 'bm-status');
}

// Chairman is listed unnumbered; shareholders (the fixed field plus any added
// rows) get their own independent numbering starting at 1, in Devanagari, for
// the template's {{#shareholders}} loop.
function bmBuildShareholderList() {
  return bmGetAllShareholderNames().map((name, i) => ({ num: bmToDevanagari(String(i + 1)), name }));
}

function bmBuildData() {
  const $ = id => document.getElementById(id).value.trim();
  const bm = bmParseBsDate($('bm-bmDate'));
  const agm = bmParseBsDate($('bm-agmDate'));
  const fy = bmFiscalParts(document.getElementById('bm-fiscalYear').value);
  const firmIdx = document.getElementById('bm-auditorFirm').value;
  const firm = firmIdx !== '' ? BM_AUDIT_FIRMS[firmIdx] : null;
  return { bm, agm, data: {
    companyName:        $('bm-companyName'),
    registrationNumber: $('bm-regNo'),
    chairmanName:       $('bm-chairmanName'),
    shareholders:       bmBuildShareholderList(),
    auditFirmName:      firm ? firm.firmName : '',
    auditorName:        firm ? firm.auditorName : '',
    auditorTitle:       firm ? firm.title : '',
    auditFee:           bmFormatAmount($('bm-auditFee')),
    authorizedCapital:  bmFormatAmount($('bm-authCapital')),
    issuedCapital:      bmFormatAmount($('bm-issuedCapital')),
    paidUpCapital:      bmFormatAmount($('bm-paidUpCapital')),
    fiscalYear:         fy.fy,
    nextFiscalYear:     fy.next,
    bmYear:   bm ? bm.year : '', bmMonthName: bm ? bm.monthName : '', bmDay: bm ? bm.day : '',
    agmDateFull: agm ? agm.full : '', agmMonthName: agm ? agm.monthName : '', agmDay: agm ? agm.day : '',
    agmTime:  bmToDevanagari($('bm-agmTime') || '11:00'),
    letterDate: agm ? agm.full : '',
  }};
}

// Template bytes never change at runtime — fetch once, reuse the ArrayBuffer
// for every render (preview re-renders happen far more often than downloads).
let bmTemplateBufferPromise = null;
function bmGetTemplateBuffer() {
  if (!bmTemplateBufferPromise) {
    bmTemplateBufferPromise = fetch(BM_TEMPLATE_URL).then(resp => {
      if (!resp.ok) throw new Error('Template file not found at ' + BM_TEMPLATE_URL);
      return resp.arrayBuffer();
    }).catch(err => { bmTemplateBufferPromise = null; throw err; });
  }
  return bmTemplateBufferPromise;
}

// Fills the template with `data` (the shape produced by bmBuildData().data) and
// returns the resulting .docx as a Blob. Shared by the Word download and the
// live preview so there is exactly one place that drives document generation.
async function bmRenderDocx(data) {
  const buffer = await bmGetTemplateBuffer();
  const zip = new PizZip(buffer.slice(0));
  const doc = new window.docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true });
  doc.render(data);
  return doc.getZip().generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

async function generateBmAgmMinutes() {
  const val = id => document.getElementById(id).value.trim();
  if (!val('bm-companyName')) { bmStatus('कृपया पहिले कम्पनी छान्नुहोस् (select a company first).', 'info'); return; }
  if (!val('bm-bmDate') || !val('bm-agmDate')) { bmStatus('बैठक र सभाको मिति भर्नुहोस् (enter the B.S. meeting dates).', 'info'); return; }

  const { bm, agm, data } = bmBuildData();
  if (!bm || !agm) { bmStatus('मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस्।', 'error'); return; }

  try {
    bmStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await bmRenderDocx(data);
    const fname = ('BM-AGM ' + data.companyName + ' ' + document.getElementById('bm-fiscalYear').value + '.docx').replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname);
    bmStatus('✅ कागजात तयार भयो — डाउनलोड भयो (generated & downloaded).', 'success');
    bmClearDraft();
  } catch (err) {
    bmStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — live preview
//  Renders the SAME .docx produced by bmRenderDocx() into the preview pane
//  via docx-preview, so the preview is never a second, independently-
//  maintained representation of the document that could drift from the real
//  Word file — it IS the Word file, just displayed as HTML.
// ════════════════════════════════════════════
let bmPreviewDebounceTimer = null;
let bmPreviewRenderToken = 0;

function bmSchedulePreviewRefresh() {
  clearTimeout(bmPreviewDebounceTimer);
  bmPreviewDebounceTimer = setTimeout(bmRefreshPreview, 500);
}

function bmPreviewReady() {
  const val = id => document.getElementById(id).value.trim();
  return !!(val('bm-companyName') && val('bm-bmDate') && val('bm-agmDate'));
}

function bmShowPreviewPlaceholder() {
  const placeholder = document.getElementById('bm-preview-placeholder');
  const root = document.getElementById('bm-preview-root');
  if (placeholder) placeholder.style.display = 'flex';
  if (root) root.style.display = 'none';
}

// A monotonically increasing token guards against an older, slower render
// (e.g. the template's first-ever fetch) overwriting a newer one that
// started after further typing — the last input always wins.
async function bmRefreshPreview() {
  const placeholder = document.getElementById('bm-preview-placeholder');
  const root = document.getElementById('bm-preview-root');
  if (!placeholder || !root || !window.docx) return;

  if (!bmPreviewReady()) { bmShowPreviewPlaceholder(); return; }

  const { bm, agm, data } = bmBuildData();
  if (!bm || !agm) { bmShowPreviewPlaceholder(); return; }

  const myToken = ++bmPreviewRenderToken;
  try {
    const blob = await bmRenderDocx(data);
    if (myToken !== bmPreviewRenderToken) return;
    const buffer = await blob.arrayBuffer();
    if (myToken !== bmPreviewRenderToken) return;

    root.innerHTML = '';
    await window.docx.renderAsync(buffer, root, document.getElementById('bm-preview-style'), {
      className: 'bm-docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    if (myToken !== bmPreviewRenderToken) return;

    placeholder.style.display = 'none';
    root.style.display = 'block';
    bmWireEditableTokens(data);
  } catch (err) {
    console.error('BM/AGM preview render failed:', err);
  }
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — inline click-to-edit in the preview
//  Only wraps values that flow into the template completely unchanged
//  (company name, chairman name, shareholder names, registration number).
//  Capital figures, the audit fee, and dates are converted (Devanagari
//  digits, comma grouping, B.S. date parsing) before they reach the
//  template, so their rendered text can't be written straight back to the
//  raw form value without reversing that conversion — those stay
//  read-only in the preview and are edited via the form instead.
// ════════════════════════════════════════════
function bmEditableTokenTargets(data) {
  const targets = [
    { field: 'bm-companyName', value: data.companyName },
    { field: 'bm-regNo', value: data.registrationNumber },
    { field: 'bm-chairmanName', value: data.chairmanName },
  ];
  const extraInputs = document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input');
  (data.shareholders || []).forEach((sh, i) => {
    if (i === 0) targets.push({ field: 'bm-shareholderName', value: sh.name });
    else if (extraInputs[i - 1]) targets.push({ el: extraInputs[i - 1], value: sh.name });
  });
  return targets.filter(t => t.value);
}

// Walks the rendered preview's text nodes in document order and wraps the
// first occurrence of each target value in a clickable span. This only
// touches the preview's own DOM after rendering — it can never affect the
// actual generated document, since that always comes from bmBuildData().
function bmWireEditableTokens(data) {
  const root = document.getElementById('bm-preview-root');
  if (!root) return;

  const remaining = bmEditableTokenTargets(data);
  if (!remaining.length) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    if (!remaining.length) break;
    const text = node.nodeValue;
    for (let i = 0; i < remaining.length; i++) {
      const idx = text.indexOf(remaining[i].value);
      if (idx === -1) continue;
      bmWrapTextRange(node, idx, remaining[i].value.length, remaining[i]);
      remaining.splice(i, 1);
      break;
    }
  }
}

function bmWrapTextRange(node, start, len, target) {
  const parent = node.parentNode;
  if (!parent) return;
  const after = node.splitText(start);
  after.splitText(len);
  const span = document.createElement('span');
  span.className = 'bm-token-editable';
  span.title = 'Click to edit';
  span.textContent = after.nodeValue;
  parent.replaceChild(span, after);
  span.addEventListener('click', () => bmActivateTokenEdit(span, target));
}

function bmActivateTokenEdit(span, target) {
  if (span.classList.contains('editing')) return;
  span.classList.add('editing');
  span.contentEditable = 'true';
  span.focus();
  document.getSelection().selectAllChildren(span);

  // If this value lives inside the collapsed company-edit section, open it
  // so the underlying field is visible while the user edits.
  const editFields = document.getElementById('bm-company-edit-fields');
  const companyFields = ['bm-companyName', 'bm-pan', 'bm-address', 'bm-chairmanName', 'bm-shareholderName'];
  if (editFields && (companyFields.includes(target.field) || target.el) && editFields.style.display === 'none') {
    bmToggleCompanyEdit();
  }

  const onKeydown = e => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); span.blur(); }
  };
  const commit = () => {
    span.classList.remove('editing');
    span.contentEditable = 'false';
    span.removeEventListener('keydown', onKeydown);
    const newValue = span.textContent.trim();
    const input = target.field ? document.getElementById(target.field) : target.el;
    if (input && newValue) {
      input.value = newValue;
      bmOnFormChanged();
    }
  };
  span.addEventListener('blur', commit, { once: true });
  span.addEventListener('keydown', onKeydown);
}

document.addEventListener('DOMContentLoaded', function () {
  const panel = document.getElementById('regd-bmAgmMinutes-panel');
  if (!panel) return;
  panel.addEventListener('input', e => { if (e.target.matches('input, select, textarea')) bmOnFormChanged(); });
  panel.addEventListener('change', e => { if (e.target.matches('input, select, textarea')) bmOnFormChanged(); });
  bmLoadDraft();
  bmUpdateCompletionIndicator();
});

// ════════════════════════════════════════════
//  BM/AGM MINUTES — sticky action bar
// ════════════════════════════════════════════
function bmScrollToPreview() {
  const right = document.querySelector('.bm-editor-right');
  if (right) right.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Mirrors report.js's buildRepPrintableDoc()/printAuditReport() pattern:
// open the rendered preview in its own tab and let the browser handle
// print/PDF. "Download PDF" reuses the exact same window — the user picks
// "Save as PDF" as the print destination — so print and PDF are always
// byte-for-byte the same rendering as the preview, with no separate
// PDF-generation dependency whose Devanagari/Mangal font support would need
// its own validation.
function bmBuildPrintableDoc() {
  const root = document.getElementById('bm-preview-root');
  const styleEl = document.getElementById('bm-preview-style');
  if (!root || !root.innerHTML.trim()) return null;

  // textContent, not innerHTML — docx-preview injects its CSS as a real
  // nested <style> element, and innerHTML would serialize that tag literally,
  // closing our own wrapping <style> block early.
  const docxCss = styleEl ? styleEl.textContent : '';
  const appCss = Array.from(document.styleSheets).map(sheet => {
    try { return Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); }
    catch (e) { return ''; }
  }).join('\n');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BM/AGM Minutes</title><style>
    body { margin:0; background:#fff; padding:24px; }
    ${appCss}
    ${docxCss}
    @media print {
      body { padding:0; background:#fff; }
      .bm-docx-wrapper { background:#fff !important; padding:0 !important; }
      .bm-docx-wrapper > section.bm-docx { box-shadow:none !important; }
    }
  </style></head><body>${root.innerHTML}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
}

function bmOpenPrintWindow(successMessage) {
  const html = bmBuildPrintableDoc();
  if (!html) { bmStatus('कृपया पहिले कम्पनी र मितिहरू भर्नुहोस् (fill in the company and dates to build a preview first).', 'info'); return; }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) { bmStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस् (pop-up blocked — please allow pop-ups for this site, then try again).', 'error'); return; }
  if (successMessage) bmStatus(successMessage, 'success');
}

function bmPrintDocument() {
  bmOpenPrintWindow();
}

function bmDownloadPdf() {
  bmOpenPrintWindow('📄 प्रिन्ट विन्डो खुल्यो — गन्तव्यको रूपमा "Save as PDF" रोज्नुहोस् (a print window opened — choose "Save as PDF" as the destination).');
}

function bmResetForm() {
  const panel = document.getElementById('regd-bmAgmMinutes-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  document.getElementById('bm-agmTime').value = '11:00';
  document.getElementById('bm-fiscalYear').value = '2081-82';
  document.getElementById('bm-auditorFirm').value = '';
  bmClearExtraShareholders();

  document.getElementById('bm-company-summary').style.display = 'none';
  document.getElementById('bm-company-edit-fields').style.display = 'block';
  const toggleBtn = document.getElementById('bm-edit-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = 'Edit Company Details';

  document.getElementById('bm-status').innerHTML = '';
  bmShowPreviewPlaceholder();
  bmClearDraft();
  bmUpdateCompletionIndicator();
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — polish: zoom, inline date validation, autosave,
//  completion indicator
// ════════════════════════════════════════════

// Single entry point for "something in the form changed" — keeps the three
// independent side effects (preview, draft, completion status) from being
// wired up separately at every call site.
function bmOnFormChanged() {
  bmSchedulePreviewRefresh();
  bmScheduleAutosave();
  bmUpdateCompletionIndicator();
}

// ── Zoom ──
let bmZoomLevel = 100;
function bmSetZoom(level) {
  bmZoomLevel = Math.max(50, Math.min(150, level));
  const root = document.getElementById('bm-preview-root');
  if (root) root.style.transform = 'scale(' + (bmZoomLevel / 100) + ')';
  const label = document.getElementById('bm-zoom-level');
  if (label) label.textContent = bmZoomLevel + '%';
}
function bmZoomIn() { bmSetZoom(bmZoomLevel + 10); }
function bmZoomOut() { bmSetZoom(bmZoomLevel - 10); }

// ── Inline date validation ──
function bmValidateDateField(fieldId) {
  const input = document.getElementById(fieldId);
  const errorEl = document.getElementById(fieldId + '-error');
  if (!input || !errorEl) return;
  const val = input.value.trim();
  if (!val || bmParseBsDate(val)) {
    errorEl.classList.remove('show');
    input.style.borderColor = '';
  } else {
    errorEl.textContent = 'ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस् (invalid format, use YYYY/MM/DD)';
    errorEl.classList.add('show');
    input.style.borderColor = 'var(--red)';
  }
}

// ── Autosave (session-local draft, never sent to Supabase) ──
const BM_DRAFT_KEY = 'bmAgmDraft';
let bmAutosaveTimer = null;

function bmScheduleAutosave() {
  clearTimeout(bmAutosaveTimer);
  bmAutosaveTimer = setTimeout(bmSaveDraft, 600);
}

function bmSaveDraft() {
  const panel = document.getElementById('regd-bmAgmMinutes-panel');
  if (!panel) return;
  const values = {};
  panel.querySelectorAll('input[id^="bm-"], select[id^="bm-"]').forEach(el => { values[el.id] = el.value; });
  const extraShareholders = Array.from(document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input')).map(i => i.value);
  try {
    localStorage.setItem(BM_DRAFT_KEY, JSON.stringify({ values, extraShareholders }));
  } catch (e) { /* best-effort only — a full/unavailable localStorage shouldn't break the form */ }
}

function bmClearDraft() {
  try { localStorage.removeItem(BM_DRAFT_KEY); } catch (e) { /* ignore */ }
}

function bmLoadDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(BM_DRAFT_KEY) || 'null'); } catch (e) { return; }
  if (!draft || !draft.values || !Object.values(draft.values).some(v => v)) return;

  Object.entries(draft.values).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  (draft.extraShareholders || []).forEach(name => { if (name) bmAddShareholderRow(name); });
  bmSchedulePreviewRefresh();
  bmStatus('📝 अघिल्लो अपूर्ण फारम पुन: लोड गरियो (restored your unsaved draft from last time).', 'info');
}

// ── Completion indicator ──
function bmUpdateCompletionIndicator() {
  const el = document.getElementById('bm-completion-indicator');
  if (!el) return;
  const required = ['bm-companyName', 'bm-bmDate', 'bm-agmDate'];
  const done = required.filter(id => document.getElementById(id).value.trim()).length;
  el.textContent = done === required.length
    ? '✅ Ready to generate'
    : done + ' of ' + required.length + ' required fields set';
}
