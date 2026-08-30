// ════════════════════════════════════════════
//  COMPANY SECRETARY APPOINTMENT (Companies Act §84)
//
//  Two pages from one form: the board-meeting minutes appointing a company
//  secretary, and the notification letter to the Company Registrar's Office.
//  Fills assets/templates/company-secretary-appointment.docx through
//  DocumentEngine/docxtemplater, exactly as BM/AGM Minutes fills its own —
//  same {{token}} delimiters, same paragraphLoop, same live docx-preview, so
//  the preview is never a second representation of the document that could
//  drift from the Word file. It IS the Word file, displayed as HTML.
//
//  The template is built by tools/registrarDocx/buildCsAppoint.mjs from the
//  firm's own Preeti source document; read that script's header before
//  changing any wording, and docs/modules/registrar.md §5.11c for the
//  document's own conventions.
//
//  This module is deliberately much smaller than js/bmAgmMinutes.js. That
//  document is ten sub-documents with four conditional blocks and renumbering
//  agenda items; this one is two fixed pages, so there is nothing here to
//  gate, renumber or toggle — the only list is the attendees.
// ════════════════════════════════════════════

const CS_TEMPLATE_URL = 'assets/templates/company-secretary-appointment.docx';

// The preview chrome reuses the `bm-` CSS classes (summary card, preview
// toolbar, zoom controls, completion indicator). Those are the Registrar
// document-screen look rather than anything BM/AGM-specific — Auditor Change
// already shares them for the same reason (CLAUDE.md §9: reuse the design
// system, never introduce a second visual language).
//
// `bm-docx` as the docx-preview className is load-bearing, not cosmetic:
// docx-preview derives its generated class names from it, and
// `.bm-docx-tab-stop` in css/styles.css is what makes a <w:tab/> render
// correctly. This document's attendance rows are tab-aligned, so they depend
// on that rule directly.
const CS_DOCX_CLASS = 'bm-docx';

// Roles as the source document spells them. The chairman's row and every
// other director's row differ only by this word.
const CS_ROLE_CHAIR = 'संचालक अध्यक्ष';
const CS_ROLE_MEMBER = 'संचालक सदस्य';

// The source fixes the meeting at "बिहान १० बजे". Kept as an editable field
// rather than baked into the template (unlike BM/AGM's AGM time, which the
// user asked to fix) because a board meeting's hour is not conventional the
// way an AGM's is — but it is pre-filled, so the common case is still no
// typing at all.
const CS_DEFAULT_TIME = 'बिहान १० बजे';

// Searches the REGISTRAR COMPANY REGISTER, never window.clientsList — see the
// header of js/registrarCompanies.js. The digit-agnostic matching that used to
// be duplicated here (registration numbers are stored in Devanagari numerals
// while people type English digits) lives in attachCompanyPicker now.
RegistrarDirectory.attachCompanyPicker(
  document.getElementById('cs-regNo'),
  document.getElementById('cs-regNo-autocomplete-list'),
  {
    keys: ['registration_number', 'pan', 'name_english'],
    minChars: 2,
    renderItem: c => `
      <div class="ac-name">${escHtml(c.registration_number || c.pan)}</div>
      <div class="ac-email">${escHtml(c.name)}${c.name_english ? ' — ' + escHtml(c.name_english) : ''}${c.pan ? ' · PAN ' + escHtml(c.pan) : ''}</div>
    `,
    onSelect: selectCsClient,
  }
);

function selectCsClient(c) {
  // Always assign — never `if (value) el.value = value` — or a client whose
  // field is blank silently keeps the PREVIOUS client's value (CLAUDE.md §9).
  document.getElementById('cs-regNo').value        = c.registration_number || '';
  document.getElementById('cs-companyName').value  = c.name || '';
  document.getElementById('cs-pan').value          = c.pan || '';
  document.getElementById('cs-chairmanName').value = c.chairman_name || '';

  // Shareholders travel with the company (loaded at sign-in), so this is no
  // longer a Supabase round trip on every click.
  csClearDirectors();
  RegistrarDirectory.shareholders(c.id).forEach(row => csAddDirectorRow(row.name));
  // The fixed shareholder field on the company record is a director too, and
  // is not in registrar_shareholders.
  if (c.shareholder_name) csAddDirectorRow(c.shareholder_name);

  csRenderCompanySummary(c);
  csOnFormChanged();
}

// ── Compact company summary card ──
// Once a company is selected its rarely-re-edited fields collapse into this
// summary instead of permanently occupying form space — the same trade the
// BM/AGM screen makes, and the same "Edit Company Details" escape hatch.
function csRenderCompanySummary(c) {
  const wrap = document.getElementById('cs-company-summary');
  const grid = document.getElementById('cs-summary-grid');
  const editFields = document.getElementById('cs-company-edit-fields');
  const toggleBtn = document.getElementById('cs-edit-toggle-btn');
  if (!wrap || !grid || !editFields) return;

  const rows = [
    ['Company', c.name],
    ['Registration', c.registration_number],
    ['Chairman', c.chairman_name],
    ['Directors', String(csGetDirectorNames().length)],
    ['PAN', c.pan],
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

function csToggleCompanyEdit() {
  const editFields = document.getElementById('cs-company-edit-fields');
  const toggleBtn = document.getElementById('cs-edit-toggle-btn');
  if (!editFields) return;
  const willOpen = editFields.style.display === 'none';
  // 'contents' (not 'block') so its child .form-groups flatten straight into
  // the parent .rep-form-grid — this div is a toggle unit, not a layout box.
  editFields.style.display = willOpen ? 'contents' : 'none';
  if (toggleBtn) toggleBtn.textContent = willOpen ? 'Hide Company Details' : 'Edit Company Details';
}

// ── Attending directors ──
// The chairman is always attendee #1 and is taken from cs-chairmanName; every
// row here is a further director, in order.
function csAddDirectorRow(name) {
  const wrap = document.getElementById('cs-directors');
  const row = document.createElement('div');
  row.className = 'cs-director-row';
  row.style.cssText = 'display:flex; gap:8px; margin-top:8px;';
  row.innerHTML = `
    <input type="text" class="cs-director-input" placeholder="Director name" style="flex:1;" />
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); csOnFormChanged();">Remove</button>
  `;
  wrap.appendChild(row);
  if (name) row.querySelector('input').value = name;
  csOnFormChanged();
}

function csClearDirectors() {
  document.getElementById('cs-directors').innerHTML = '';
}

// Every director name except the chairman's own. The chairman IS one of the
// company's shareholders and the register sometimes lists them again
// alongside the others — left in, that prints the same person twice in the
// attendance list, once as अध्यक्ष and once as सदस्य. Same dedup, for the same
// reason, as bmGetAllShareholderNames().
function csGetDirectorNames() {
  const chairman = document.getElementById('cs-chairmanName').value.trim();
  const names = [];
  document.querySelectorAll('#cs-directors .cs-director-input').forEach(inp => {
    names.push(inp.value.trim());
  });
  // A company can legitimately list the same director twice across the
  // shareholder field and registrar_shareholders; the attendance list is a
  // register of people in the room, so each appears once.
  const seen = new Set();
  return names.filter(n => {
    if (!n || n === chairman || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function csStatus(html, type) {
  showStatus(html, type, 'cs-status');
}

function csToDevanagari(s) {
  return NepaliLocale.toDevanagari(s);
}

function csParseBsDate(str) {
  return NepaliLocale.parseBsDate(str);
}

// The source document writes dates with the Nepali danda as separator —
// २०८३।०४।०४ — not the slash NepaliLocale returns. Per-module date formats
// differ BY DECISION (CLAUDE.md §8); this matches BM/AGM's, because both
// documents come from the same firm's same house style.
function csDandaDate(parsed) {
  return parsed ? parsed.full.replace(/\//g, '।') : '';
}

// Chairman first (as अध्यक्ष), then every other director. The template's
// {{#attendees}} loop prints one tab-aligned row per entry, so this list is
// the only thing that decides how long the attendance block runs.
function csBuildAttendees() {
  const chairman = document.getElementById('cs-chairmanName').value.trim();
  const list = [];
  if (chairman) list.push({ name: chairman, role: CS_ROLE_CHAIR });
  csGetDirectorNames().forEach(name => list.push({ name, role: CS_ROLE_MEMBER }));
  return list;
}

function csBuildData() {
  const $ = id => document.getElementById(id).value.trim();

  const meeting = csParseBsDate($('cs-meetingDate'));
  // The appointment normally takes effect from the meeting, and the letter
  // normally goes out the same day — but not always, so both are their own
  // field and simply FALL BACK to the meeting date when left blank. That is
  // what keeps the common case to one date instead of three.
  const appointment = csParseBsDate($('cs-appointmentDate')) || meeting;
  const letter = csParseBsDate($('cs-letterDate')) || meeting;

  return { meeting, appointment, letter, data: {
    companyName:        $('cs-companyName'),
    registrationNumber: $('cs-registrationNumber'),
    chairmanName:       $('cs-chairmanName'),
    secretaryName:      $('cs-secretaryName'),
    secretaryAddress:   $('cs-secretaryAddress'),
    citizenshipNo:      csToDevanagari($('cs-citizenshipNo')),
    meetingDate:        csDandaDate(meeting),
    meetingTime:        $('cs-meetingTime') || CS_DEFAULT_TIME,
    appointmentDate:    csDandaDate(appointment),
    letterDate:         csDandaDate(letter),
    attendees:          csBuildAttendees(),
  }};
}

// Fills the template with `data` and returns the .docx as a Blob. Shared by
// the Word download, the live preview and the print window, so there is
// exactly one place that drives document generation.
async function csRenderDocx(data) {
  const buffer = await DocumentEngine.getTemplate(CS_TEMPLATE_URL);
  return DocumentEngine.renderWord(buffer, data);
}

// Deliberately no required-field gate (2026-08-23, user ask) — generates
// from whatever is on the form, blank fields printing blank in the template,
// so staff can pull a document to see its shape before the client file is
// fully typed up. csBuildData() already falls back every field to '' and
// every date to null -> '' (csDandaDate), so nothing here can throw.
async function generateCompanySecretaryDocs() {
  const { data } = csBuildData();

  try {
    csStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await csRenderDocx(data);
    const fname = ('Company Secretary Appointment ' + data.companyName + '.docx').replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'companySecretary', clientName: data.companyName });
    csStatus('✅ कागजात तयार भयो — डाउनलोड भयो (generated & downloaded).', 'success');
    csClearDraft();
  } catch (err) {
    csStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}

// ── Save to database / Saved appointments ──
//
// The same pair BM/AGM Minutes, Generate Report and Notes to Accounts have,
// over the shared saved_documents table and the one shared picker drawer
// (CLAUDE.md §15: saved documents are ONE table with a `module` discriminator,
// so this is a CHECK value — db/2026-08-21_saved_documents_registrar_docs.sql
// — not a new table). Like BM/AGM: client_id stays NULL (a registrar company
// is not a clients row) and no doc_html (the Word file regenerates from
// `state` byte for byte).
//
// Re-saving in the same session amends the same row, matching the others.
let csSavedId = null;

async function csSaveToDb() {
  const companyName = (document.getElementById('cs-companyName').value || '').trim();
  if (!companyName) {
    csStatus('कम्पनीको नाम भर्नुहोस् (enter the company name before saving).', 'error');
    return;
  }
  try {
    csStatus('<span class="spinner spinner-navy"></span> सुरक्षित गर्दै (saving)…', 'searching');
    csSavedId = await DocumentStore.save(csSavedId, {
      module: 'companySecretary',
      client_id: null,
      client_name: companyName,
      pan: (document.getElementById('cs-registrationNumber').value || '').trim()
        || (document.getElementById('cs-pan').value || '').trim() || null,
      fiscal_year: null,
      doc_type: 'Company Secretary Appointment',
      title: 'Company Secretary Appointment — ' + companyName,
      state: csFormState(),
    });
    csStatus(`✅ सुरक्षित भयो (saved as record #${csSavedId}) — <strong>Saved appointments</strong> बाट पुन: खोल्न सकिन्छ.`, 'success');
    AuditLog.record('company_secretary_saved', {
      module: 'companySecretary', clientName: companyName, status: 'success', recordRef: csSavedId,
    });
  } catch (e) {
    console.error(e);
    csStatus('❌ सुरक्षित हुन सकेन (save failed): ' + escHtml(e.message), 'error');
  }
}

function csOpenSaved() {
  DocumentStore.openPicker({
    module: 'companySecretary',
    label: 'Saved secretary appointments',
    searchPlaceholder: 'Search by company, secretary…',
    onOpen: row => {
      if (!csApplyState(row.state)) {
        csStatus('यो रेकर्डमा फारम विवरण छैन (this record has no form state saved).', 'error');
        return;
      }
      csSavedId = row.id;
      csUpdateCompletionIndicator();
      if (csIsPreviewOpen()) csSchedulePreviewRefresh();
      csStatus(`📂 सुरक्षित रेकर्ड #${row.id} खोलियो — Save to database फेरि थिच्दा यही रेकर्ड अद्यावधिक हुन्छ (opened; saving again updates this same record).`, 'info');
    },
  });
}

// ════════════════════════════════════════════
//  LIVE PREVIEW
// ════════════════════════════════════════════
// Deliberately unconditional (2026-08-23, user ask) — same reasoning as
// generateCompanySecretaryDocs above. csRefreshPreview's own `!window.docx`
// guard is what covers "not ready yet".
function csPreviewReady() {
  return true;
}

function csShowPreviewPlaceholder() {
  const placeholder = document.getElementById('cs-preview-placeholder');
  const root = document.getElementById('cs-preview-root');
  if (placeholder) placeholder.style.display = 'flex';
  if (root) root.style.display = 'none';
}

// `isCurrent()` guards against an older, slower render (e.g. the template's
// first-ever fetch) overwriting a newer one that started after further
// typing — the last input always wins.
async function csRefreshPreview(isCurrent) {
  const placeholder = document.getElementById('cs-preview-placeholder');
  const root = document.getElementById('cs-preview-root');
  if (!placeholder || !root) return;
  // See the note in js/bmAgmMinutes.js bmRefreshPreview: bailing out on
  // `!window.docx` is a silent no-op that leaves the preview blank or stale
  // until a page reload, because nothing re-schedules the render. Fixed
  // 2026-08-29 across all four registrar preview modules.
  try { await LibLoader.ensure('docxpreview'); }
  catch (err) { console.error('Company Secretary preview: docx-preview failed to load:', err); return; }
  if (!isCurrent()) return;

  const { data } = csBuildData();

  try {
    const blob = await csRenderDocx(data);
    if (!isCurrent()) return;

    // ignoreLastRenderedPageBreak:true — split pages ONLY at the template's
    // own explicit break (minutes | letter); Word's recorded soft breaks
    // would scatter the two pages across half-empty extra ones.
    await DocumentEngine.previewWordAsHtml(blob, root, document.getElementById('cs-preview-style'), {
      className: CS_DOCX_CLASS,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    if (!isCurrent()) return;

    placeholder.style.display = 'none';
    root.style.display = 'block';
    DocumentEngine.fitPagesToSheet(root, CS_DOCX_CLASS);
  } catch (err) {
    console.error('Company Secretary preview render failed:', err);
  }
}

const csPreviewRefreshCtl = WorkflowEngine.createDebouncedRefresh(csRefreshPreview, 500);
function csSchedulePreviewRefresh() {
  csPreviewRefreshCtl.schedule();
}

// ════════════════════════════════════════════
//  EDIT / PREVIEW TOGGLE
//  Save as Word and Print never read the preview's DOM — they call
//  csRenderDocx(csBuildData()) fresh from the form every time — so switching
//  views can never let an export see stale content. This toggle exists purely
//  so a real docx-preview render happens on demand rather than per keystroke.
// ════════════════════════════════════════════
function csIsPreviewOpen() {
  const pv = document.getElementById('cs-preview-view');
  return !!pv && !pv.hidden;
}

function csSetView(mode) {
  const preview = mode === 'preview';
  const pv = document.getElementById('cs-preview-view');
  const enteringPreview = preview && pv.hidden;
  document.getElementById('cs-edit-view').hidden = preview;
  pv.hidden = !preview;
  document.getElementById('cs-tab-edit').classList.toggle('active', !preview);
  document.getElementById('cs-tab-preview').classList.toggle('active', preview);
  if (enteringPreview) csSchedulePreviewRefresh();
}

// ════════════════════════════════════════════
//  PRINT / SAVE AS PDF
// ════════════════════════════════════════════
async function csBuildPrintableDoc() {
  const { data } = csBuildData();
  const blob = await csRenderDocx(data);
  return DocumentEngine.buildPrintableHtml(blob, { className: CS_DOCX_CLASS, title: 'Company Secretary Appointment' });
}

// One button covers both Print and Save-as-PDF — the browser's own print
// dialog offers "Save as PDF" as a destination.
async function csPrintDocument() {
  csStatus('<span class="spinner spinner-navy"></span> प्रिन्टका लागि तयार गर्दै (preparing print)…', 'searching');
  let html = null;
  try { html = await csBuildPrintableDoc(); }
  catch (err) { csStatus('❌ ' + (err.message || 'Print failed'), 'error'); return; }
  if (!html) { csStatus('कृपया पहिले कम्पनी, सचिव र मिति भर्नुहोस् (fill in the company, secretary and meeting date first).', 'info'); return; }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) { csStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस् (pop-up blocked — please allow pop-ups for this site, then try again).', 'error'); return; }
  csStatus('🖨️ प्रिन्ट विन्डो खुल्यो — प्रिन्ट गर्नुहोस् वा गन्तव्यमा "Save as PDF" रोज्नुहोस् (a print window opened — print, or choose "Save as PDF" as the destination).', 'success');
}

function csResetForm() {
  const panel = document.getElementById('regd-companySecretary-panel');
  if (!panel) return;
  // drop the link to any opened record, or the next Save silently overwrites
  // the document that was just cleared off the screen
  csSavedId = null;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  document.getElementById('cs-meetingTime').value = CS_DEFAULT_TIME;
  csClearDirectors();

  document.getElementById('cs-company-summary').style.display = 'none';
  document.getElementById('cs-company-edit-fields').style.display = 'contents';
  const toggleBtn = document.getElementById('cs-edit-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = 'Edit Company Details';

  document.getElementById('cs-status').innerHTML = '';
  csShowPreviewPlaceholder();
  csSetView('edit');
  csClearDraft();
  csUpdateCompletionIndicator();
}

// ════════════════════════════════════════════
//  POLISH: zoom, date validation, autosave, completion
// ════════════════════════════════════════════

// Single entry point for "something in the form changed", so the three
// independent side effects never get wired up separately at each call site.
// The preview only re-renders while it is the visible view — never while the
// hidden edit form is being typed into.
function csOnFormChanged() {
  if (csIsPreviewOpen()) csSchedulePreviewRefresh();
  csScheduleAutosave();
  csUpdateCompletionIndicator();
}

const csZoom = WorkflowEngine.createZoomControl(document.getElementById('cs-preview-root'), document.getElementById('cs-zoom-level'));
function csZoomIn() { csZoom.zoomIn(); }
function csZoomOut() { csZoom.zoomOut(); }

function csValidateDateField(fieldId) {
  const input = document.getElementById(fieldId);
  const errorEl = document.getElementById(fieldId + '-error');
  if (!input || !errorEl) return;
  const val = input.value.trim();
  if (!val || csParseBsDate(val)) {
    errorEl.classList.remove('show');
    input.style.borderColor = '';
  } else {
    errorEl.textContent = 'ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस् (invalid format, use YYYY/MM/DD)';
    errorEl.classList.add('show');
    input.style.borderColor = 'var(--red)';
  }
}

// ── Autosave (session-local draft, never sent to Supabase) ──
// ONE serialisation of the form, shared by the localStorage autosave and the
// Save-to-database record — the bmFormState()/bmApplyState() rule: keeping
// them separate is how a field added to the form ends up captured by one and
// silently missed by the other.
function csFormState() {
  const panel = document.getElementById('regd-companySecretary-panel');
  const values = {};
  panel.querySelectorAll('input[id^="cs-"]').forEach(el => { values[el.id] = el.value; });
  const directors = Array.from(document.querySelectorAll('#cs-directors .cs-director-input')).map(i => i.value);
  return { values, directors };
}

// Clears the director rows before re-adding them — otherwise opening a second
// saved record stacks its directors underneath the previous one's (CLAUDE.md §9).
function csApplyState(state) {
  if (!state || !state.values) return false;
  csClearDirectors();
  Object.entries(state.values).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  (state.directors || []).forEach(name => { if (name) csAddDirectorRow(name); });
  return true;
}

const csAutosave = WorkflowEngine.createAutosave('companySecretaryDraft', {
  collect: csFormState,
  restore: (draft) => {
    if (!draft.values || !Object.values(draft.values).some(v => v)) return;
    csApplyState(draft);
    if (csIsPreviewOpen()) csSchedulePreviewRefresh();
    csStatus('📝 अघिल्लो अपूर्ण फारम पुन: लोड गरियो (restored your unsaved draft from last time).', 'info');
  },
  debounceMs: 600,
});
function csScheduleAutosave() { csAutosave.scheduleSave(); }
function csClearDraft() { csAutosave.clear(); }
function csLoadDraft() { csAutosave.load(); }

function csUpdateCompletionIndicator() {
  WorkflowEngine.updateCompletionIndicator(
    'cs-completion-indicator',
    ['cs-companyName', 'cs-secretaryName', 'cs-meetingDate'],
    '✅ Ready to generate'
  );
}

document.addEventListener('DOMContentLoaded', function () {
  WorkflowEngine.attachFormWatcher(document.getElementById('regd-companySecretary-panel'), csOnFormChanged);
  const t = document.getElementById('cs-meetingTime');
  if (t && !t.value) t.value = CS_DEFAULT_TIME;
  // No csLoadDraft() here (2026-08-28) — REGD_INITS (js/tabs.js) now resets
  // this form to blank on every open, so restoring a draft here would just
  // be immediately wiped the moment the user actually looks at the tab.
  // csLoadDraft/csAutosave/csClearDraft are left in place (csResetForm still
  // calls csClearDraft) rather than torn out, in case a future explicit
  // "Restore last draft" affordance wants them.
  csUpdateCompletionIndicator();
});
