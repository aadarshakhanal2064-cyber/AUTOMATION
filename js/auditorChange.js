// ════════════════════════════════════════════
//  AUDITOR CHANGE — Company Registrar module
//  Two documents from one shared form: a Board Resolution (appointing the
//  new auditor, accepting the outgoing auditor's resignation) and a
//  notification letter to the Company Registrar's Office. Both templates are
//  filled from the SAME data object (auditor name, chairman name, etc. are
//  unified fields, not duplicated per document — see docs/plan history:
//  the firm's own source drafts had two different example names per
//  document, confirmed as an inconsistency to fix, not a deliberate design).
//  Mirrors js/bmAgmMinutes.js's DocumentEngine-based architecture (own
//  ac*-prefixed functions here, same shared engine calls) — trimmed for a
//  first working version: no autosave draft, no inline click-to-edit-in-
//  preview tokens yet (BM/AGM has both; can be added here the same way
//  later if useful).
// ════════════════════════════════════════════

SearchEngine.attachAutocomplete(document.getElementById('ac-companySearch'), document.getElementById('ac-company-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['registration_number', 'pan', 'name'],
  minChars: 2,
  normalizeQuery: v => NepaliLocale.toEnglishDigits(v),
  normalizeItem: c => ({ registration_number: NepaliLocale.toEnglishDigits(c.registration_number), pan: NepaliLocale.toEnglishDigits(c.pan) }),
  renderItem: c => `
    <div class="ac-name">${escHtml(c.name)}</div>
    <div class="ac-email">${escHtml(c.registration_number || c.pan || '')}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectAcClient,
});

function selectAcClient(c) {
  document.getElementById('ac-companySearch').value = c.name || '';
  document.getElementById('ac-companyName').value = c.name || '';
  // Unconditional: a company with no chairman on file used to keep the
  // previously selected company's chairman, and that name goes straight into
  // the signed resolution.
  document.getElementById('ac-chairmanName').value = c.chairman_name || '';
  acOnFormChanged();
}

// Picking one of the firm's own known audit firms (same window.REGD_AUDIT_FIRMS
// list BM/AGM Minutes' "Upcoming Auditor" field picks from) fills both the
// auditor's name and their firm — the two fields a real filing always needs
// together — instead of typing each separately. Still a plain text input
// underneath, so a new/unlisted auditor can just be typed in as before.
attachFirmPicker(document.getElementById('ac-newAuditorName'), document.getElementById('ac-newAuditorName-list'), {
  openOn: 'focus',
  getItems: () => window.REGD_AUDIT_FIRMS,
  renderItem: f => `<div class="ac-name">${escHtml(f.auditorName)}</div><div class="ac-email">${escHtml(f.title)} · ${escHtml(f.firmName)}</div>`,
  onSelect: firm => {
    document.getElementById('ac-newAuditorName').value = firm.auditorName;
    document.getElementById('ac-newAuditorFirm').value = firm.firmName;
    acOnFormChanged();
  },
});

// ════════════════════════════════════════════
//  Document generation — two templates, one shared data object
// ════════════════════════════════════════════
const AC_RESOLUTION_TEMPLATE_URL = 'assets/templates/auditor-change-resolution.docx';
const AC_LETTER_TEMPLATE_URL = 'assets/templates/auditor-change-registrar-letter.docx';

function acStatus(html, type) {
  showStatus(html, type, 'ac-status');
}

function acParseBsDate(str) {
  return NepaliLocale.parseBsDate(str);
}

function acBuildData() {
  const $ = id => document.getElementById(id).value.trim();
  const meeting = acParseBsDate($('ac-meetingDate'));
  const priorAgm = acParseBsDate($('ac-priorAgmDate'));
  const letter = acParseBsDate($('ac-letterDate'));
  const fy = NepaliLocale.fiscalParts(document.getElementById('ac-fiscalYear').value);

  const data = {
    companyName: $('ac-companyName'),
    meetingDate: meeting ? meeting.full : '',
    chairmanName: $('ac-chairmanName'),
    boardMemberName: $('ac-boardMemberName'),
    priorAgmDate: priorAgm ? priorAgm.full : '',
    fiscalYear: fy.fy,
    outgoingAuditorName: $('ac-outgoingAuditorName'),
    newAuditorName: $('ac-newAuditorName'),
    newAuditorFirm: $('ac-newAuditorFirm'),
    remuneration: NepaliLocale.formatAmount($('ac-remuneration')),
    letterDate: letter ? letter.full : '',
  };
  return { meeting, priorAgm, letter, data };
}

async function acRenderResolutionDocx(data) {
  const buffer = await DocumentEngine.getTemplate(AC_RESOLUTION_TEMPLATE_URL);
  return DocumentEngine.renderWord(buffer, data);
}
async function acRenderLetterDocx(data) {
  const buffer = await DocumentEngine.getTemplate(AC_LETTER_TEMPLATE_URL);
  return DocumentEngine.renderWord(buffer, data);
}

function acValidateBeforeGenerate() {
  const val = id => document.getElementById(id).value.trim();
  if (!val('ac-companyName')) { acStatus('कृपया पहिले कम्पनी छान्नुहोस् (select a company first).', 'info'); return null; }
  if (!val('ac-meetingDate')) { acStatus('बैठकको मिति भर्नुहोस् (enter the meeting date).', 'info'); return null; }
  const built = acBuildData();
  if (!built.meeting) { acStatus('बैठकको मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस्।', 'error'); return null; }
  return built;
}

async function generateAuditorChangeResolution() {
  const built = acValidateBeforeGenerate();
  if (!built) return;
  try {
    acStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await acRenderResolutionDocx(built.data);
    const fname = ('Auditor Change Resolution - ' + built.data.companyName).replace(/[\\/:*?"<>|]/g, '_') + '.docx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'auditorChange', clientName: built.data.companyName });
    acStatus('✅ Board Resolution तयार भयो — डाउनलोड भयो (generated & downloaded).', 'success');
  } catch (err) {
    acStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}

async function generateAuditorChangeLetter() {
  const built = acValidateBeforeGenerate();
  if (!built) return;
  if (!document.getElementById('ac-letterDate').value.trim()) { acStatus('पत्रको मिति भर्नुहोस् (enter the letter date).', 'info'); return; }
  if (!built.letter) { acStatus('पत्रको मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस्।', 'error'); return; }
  try {
    acStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await acRenderLetterDocx(built.data);
    const fname = ('Auditor Change Registrar Letter - ' + built.data.companyName).replace(/[\\/:*?"<>|]/g, '_') + '.docx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'auditorChange', clientName: built.data.companyName });
    acStatus('✅ Registrar Letter तयार भयो — डाउनलोड भयो (generated & downloaded).', 'success');
  } catch (err) {
    acStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}

// ════════════════════════════════════════════
//  Live preview — toggles between the two documents, same docx-preview
//  approach as BM/AGM: the preview IS the real generated file, never a
//  second hand-maintained representation.
// ════════════════════════════════════════════
let acCurrentPreviewDoc = 'resolution'; // 'resolution' | 'letter'

function acSetPreviewDoc(which) {
  acCurrentPreviewDoc = which;
  document.getElementById('ac-doc-tab-resolution').classList.toggle('active', which === 'resolution');
  document.getElementById('ac-doc-tab-letter').classList.toggle('active', which === 'letter');
  if (acIsPreviewOpen()) acSchedulePreviewRefresh();
}

function acPreviewReady() {
  const val = id => document.getElementById(id).value.trim();
  if (!val('ac-companyName') || !val('ac-meetingDate')) return false;
  if (acCurrentPreviewDoc === 'letter' && !val('ac-letterDate')) return false;
  return true;
}

function acShowPreviewPlaceholder() {
  const placeholder = document.getElementById('ac-preview-placeholder');
  const root = document.getElementById('ac-preview-root');
  if (placeholder) placeholder.style.display = 'flex';
  if (root) root.style.display = 'none';
}

async function acRefreshPreview(isCurrent) {
  const placeholder = document.getElementById('ac-preview-placeholder');
  const root = document.getElementById('ac-preview-root');
  if (!placeholder || !root || !window.docx) return;

  if (!acPreviewReady()) { acShowPreviewPlaceholder(); return; }

  const built = acBuildData();
  if (!built.meeting || (acCurrentPreviewDoc === 'letter' && !built.letter)) { acShowPreviewPlaceholder(); return; }

  try {
    const blob = acCurrentPreviewDoc === 'letter'
      ? await acRenderLetterDocx(built.data)
      : await acRenderResolutionDocx(built.data);
    if (!isCurrent()) return;

    await DocumentEngine.previewWordAsHtml(blob, root, document.getElementById('ac-preview-style'), {
      className: 'bm-docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    if (!isCurrent()) return;

    placeholder.style.display = 'none';
    root.style.display = 'block';
  } catch (err) {
    console.error('Auditor Change preview render failed:', err);
  }
}

const acPreviewRefreshCtl = WorkflowEngine.createDebouncedRefresh(acRefreshPreview, 500);
function acSchedulePreviewRefresh() {
  acPreviewRefreshCtl.schedule();
}

// ════════════════════════════════════════════
//  Edit/Preview view toggle — mirrors bmAgmMinutes.js's bmSetView. Save as
//  Word and Print never read the preview's DOM (they render fresh offscreen
//  from acBuildData() every time), so this toggle exists purely to keep the
//  heavier docx-preview render from firing on every keystroke.
// ════════════════════════════════════════════
function acIsPreviewOpen() {
  const pv = document.getElementById('ac-preview-view');
  return !!pv && !pv.hidden;
}

function acSetView(mode) {
  const preview = mode === 'preview';
  const pv = document.getElementById('ac-preview-view');
  const enteringPreview = preview && pv.hidden;
  document.getElementById('ac-edit-view').hidden = preview;
  pv.hidden = !preview;
  document.getElementById('ac-tab-edit').classList.toggle('active', !preview);
  document.getElementById('ac-tab-preview').classList.toggle('active', preview);
  if (enteringPreview) acRefreshPreview(acIsPreviewOpen);
}

document.addEventListener('DOMContentLoaded', function () {
  WorkflowEngine.attachFormWatcher(document.getElementById('regd-auditorChange-panel'), acOnFormChanged);
  acUpdateCompletionIndicator();
});

// ════════════════════════════════════════════
//  Print
// ════════════════════════════════════════════

// Renders a generated .docx offscreen WITHOUT docx-preview's page splitting
// (breakPages:false gives one continuous section), and measures it — so the
// print layout can decide whether it fits one A4 page as-is or needs to be
// scaled down a touch.
async function acRenderDocForPrint(blob) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute; left:-10000px; top:0;';
  const styleEl = document.createElement('div');
  const content = document.createElement('div');
  holder.appendChild(styleEl);
  holder.appendChild(content);
  document.body.appendChild(holder);
  try {
    await DocumentEngine.previewWordAsHtml(blob, content, styleEl, {
      className: 'bm-docx',
      inWrapper: true,
      breakPages: false,
      experimental: true,
    });
    const section = content.querySelector('section.bm-docx');
    const rect = section ? section.getBoundingClientRect() : { width: 0, height: 0 };
    return { html: content.innerHTML, css: styleEl.textContent, width: rect.width, height: rect.height };
  } finally {
    holder.remove();
  }
}

// One printed A4 page per document: if the rendered content runs slightly
// taller than a page (the usual "last line spills onto page 2" problem),
// shrink it just enough to fit rather than letting it break.
const AC_A4_W_PX = 794;  // 210mm at 96dpi
const AC_A4_H_PX = 1123; // 297mm at 96dpi
function acBuildPrintPage(doc) {
  const zoom = Math.min(1, (AC_A4_H_PX - 4) / doc.height, AC_A4_W_PX / doc.width);
  return `<div class="ac-print-page"${zoom < 1 ? ` style="zoom:${zoom.toFixed(4)};"` : ''}>${doc.html}</div>`;
}

// Prints BOTH documents in one job — Board Resolution as page 1, Registrar
// Letter as page 2 — always exactly two pages, regardless of which document
// the preview toggle is showing.
async function acPrintDocument() {
  const built = acValidateBeforeGenerate();
  if (!built) return;
  if (!document.getElementById('ac-letterDate').value.trim()) { acStatus('पत्रको मिति भर्नुहोस् (enter the letter date).', 'info'); return; }
  if (!built.letter) { acStatus('पत्रको मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस्।', 'error'); return; }

  try {
    acStatus('<span class="spinner spinner-navy"></span> प्रिन्टका लागि तयार गर्दै (preparing print)…', 'searching');
    const resolution = await acRenderDocForPrint(await acRenderResolutionDocx(built.data));
    const letter = await acRenderDocForPrint(await acRenderLetterDocx(built.data));

    // Both renders emit the same .bm-docx stylesheet — include it once. The
    // section's own docx page margins (rendered as padding) provide the print
    // margins, so @page margin stays 0 to keep the px-to-page fit math exact.
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auditor Change Documents</title><style>
    @page { size: A4; margin: 0; }
    html, body { margin:0; padding:0; background:#fff; }
    ${resolution.css}
    .bm-docx-wrapper { display:block !important; background:#fff !important; padding:0 !important; }
    .bm-docx-wrapper > section.bm-docx { box-shadow:none !important; margin:0 auto !important; }
    .ac-print-page { page-break-after: always; }
    .ac-print-page:last-child { page-break-after: auto; }
  </style></head><body>${acBuildPrintPage(resolution)}${acBuildPrintPage(letter)}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) { acStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस्।', 'error'); return; }
    acStatus('🖨️ प्रिन्ट विन्डो खुल्यो — दुई पृष्ठ (Board Resolution + Registrar Letter).', 'success');
  } catch (err) {
    acStatus('❌ ' + (err.message || 'Print failed'), 'error');
  }
}

function acResetForm() {
  const panel = document.getElementById('regd-auditorChange-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  document.getElementById('ac-fiscalYear').value = '2081-82';
  document.getElementById('ac-status').innerHTML = '';
  acSetPreviewDoc('resolution');
  acShowPreviewPlaceholder();
  acSetView('edit');
  acUpdateCompletionIndicator();
}

// ════════════════════════════════════════════
//  Polish: zoom, inline date validation, completion indicator
// ════════════════════════════════════════════
// Preview only re-renders while it's the visible view — never while the
// (hidden) edit form is being typed into.
function acOnFormChanged() {
  if (acIsPreviewOpen()) acSchedulePreviewRefresh();
  acUpdateCompletionIndicator();
}

const acZoom = WorkflowEngine.createZoomControl(document.getElementById('ac-preview-root'), document.getElementById('ac-zoom-level'));
function acSetZoom(level) { acZoom.set(level); }
function acZoomIn() { acZoom.zoomIn(); }
function acZoomOut() { acZoom.zoomOut(); }

function acValidateDateField(fieldId) {
  const input = document.getElementById(fieldId);
  const errorEl = document.getElementById(fieldId + '-error');
  if (!input || !errorEl) return;
  const val = input.value.trim();
  if (!val || acParseBsDate(val)) {
    errorEl.classList.remove('show');
    input.style.borderColor = '';
  } else {
    errorEl.textContent = 'ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस् (invalid format, use YYYY/MM/DD)';
    errorEl.classList.add('show');
    input.style.borderColor = 'var(--red)';
  }
}

function acUpdateCompletionIndicator() {
  WorkflowEngine.updateCompletionIndicator('ac-completion-indicator', ['ac-companyName', 'ac-meetingDate'], '✅ Ready to generate');
}
