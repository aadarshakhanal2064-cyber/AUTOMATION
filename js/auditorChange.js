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
  if (c.chairman_name) document.getElementById('ac-chairmanName').value = c.chairman_name;
  acOnFormChanged();
}

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
  acSchedulePreviewRefresh();
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

document.addEventListener('DOMContentLoaded', function () {
  WorkflowEngine.attachFormWatcher(document.getElementById('regd-auditorChange-panel'), acOnFormChanged);
  acUpdateCompletionIndicator();
});

// ════════════════════════════════════════════
//  Action bar: scroll-to-preview, print
// ════════════════════════════════════════════
function acScrollToPreview() {
  const right = document.querySelector('#regd-auditorChange-panel .bm-editor-right');
  if (right) right.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Mirrors bmBuildPrintableDoc()/report.js's print pattern: print whichever
// document is currently shown in the preview.
function acBuildPrintableDoc() {
  const root = document.getElementById('ac-preview-root');
  const styleEl = document.getElementById('ac-preview-style');
  if (!root || !root.innerHTML.trim()) return null;

  const docxCss = styleEl ? styleEl.textContent : '';
  const appCss = Array.from(document.styleSheets).map(sheet => {
    try { return Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); }
    catch (e) { return ''; }
  }).join('\n');

  const title = acCurrentPreviewDoc === 'letter' ? 'Registrar Letter' : 'Board Resolution';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>
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

function acPrintDocument() {
  const html = acBuildPrintableDoc();
  if (!html) { acStatus('कृपया पहिले फारम भर्नुहोस् (fill in the form to build a preview first).', 'info'); return; }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) { acStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस्।', 'error'); }
}

function acResetForm() {
  const panel = document.getElementById('regd-auditorChange-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  document.getElementById('ac-fiscalYear').value = '2081-82';
  document.getElementById('ac-status').innerHTML = '';
  acSetPreviewDoc('resolution');
  acShowPreviewPlaceholder();
  acUpdateCompletionIndicator();
}

// ════════════════════════════════════════════
//  Polish: zoom, inline date validation, completion indicator
// ════════════════════════════════════════════
function acOnFormChanged() {
  acSchedulePreviewRefresh();
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
