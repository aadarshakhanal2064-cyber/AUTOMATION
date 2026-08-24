// ════════════════════════════════════════════
//  BM/AGM MINUTES — Company Registration Number search
//
//  Searches the REGISTRAR COMPANY REGISTER (window.registrarCompanies), never
//  window.clientsList. Since 2026-08-20 those are two separate directories:
//  the audit-client list this screen used to read cannot produce a set of
//  minutes, and the companies that can are no longer visible to any
//  non-registrar screen. See js/registrarCompanies.js for why.
//
//  The digit-agnostic matching that used to live here — registration numbers
//  and PANs are stored in Devanagari numerals while people type English digits
//  on a keyboard — is now inside RegistrarDirectory.attachCompanyPicker, which
//  every registrar screen shares rather than each keeping its own copy.
// ════════════════════════════════════════════

RegistrarDirectory.attachCompanyPicker(
  document.getElementById('bm-regNo'),
  document.getElementById('bm-regNo-autocomplete-list'),
  {
    keys: ['registration_number', 'pan'],
    minChars: 2,
    renderItem: c => `
      <div class="ac-name">${escHtml(c.registration_number || c.pan)}</div>
      <div class="ac-email">${escHtml(c.name)}${c.pan ? ' · PAN ' + escHtml(c.pan) : ''}</div>
    `,
    onSelect: selectBmClient,
  }
);

function selectBmClient(c) {
  document.getElementById('bm-regNo').value           = c.registration_number || '';
  document.getElementById('bm-companyName').value     = c.name || '';
  document.getElementById('bm-pan').value              = c.pan || '';
  document.getElementById('bm-address').value          = c.address || '';
  document.getElementById('bm-chairmanName').value     = c.chairman_name || '';
  document.getElementById('bm-shareholderName').value  = c.shareholder_name || '';
  document.getElementById('bm-authCapital').value      = c.authorized_capital || '';
  document.getElementById('bm-issuedCapital').value    = c.issued_capital || '';
  document.getElementById('bm-paidUpCapital').value    = c.paid_up_capital || '';

  // Shareholders come with the company — RegistrarDirectory loads them
  // alongside it at sign-in, so this is no longer a Supabase round trip fired
  // on every click (Company Secretary ran the identical query).
  bmClearExtraShareholders();
  RegistrarDirectory.shareholders(c.id).forEach(row => bmAddShareholderRow(row.name));

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
  // 'contents' (not 'block') so its child .form-groups flatten straight into
  // the parent .rep-form-grid — this div is a toggle unit, not a layout box.
  editFields.style.display = willOpen ? 'contents' : 'none';
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

// Shows/hides the board-change meeting date field alongside the "board was
// reappointed" checkbox — the whole "Change of Board of Director" block
// (its own minutes page, the tapsil item in the registrar letter, and one
// Director's Declaration page per attendee) is gated on this single flag in
// the template (`{{#boardChanged}}`), so the date only matters when it's on.
function bmToggleBoardChangedFields() {
  bmSyncBoardChangedAvailability();
  bmOnFormChanged();
}

// Full attendee list in order: chairman, then every shareholder name (fixed
// field + any additional rows), skipping blanks. The chairman IS one of the
// company's shareholders, and the register sometimes lists them again
// alongside the others — left in, that prints the same person twice in the
// attendee list (once as अध्यक्ष, once as संचालक), so an entry matching the
// chairman's own name is dropped here rather than at every call site.
function bmGetAllShareholderNames() {
  const chairman = document.getElementById('bm-chairmanName').value.trim();
  const names = [document.getElementById('bm-shareholderName').value.trim()];
  document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input').forEach(inp => {
    names.push(inp.value.trim());
  });
  return names.filter(n => n && n !== chairman);
}

// A single-shareholder company has nobody to reappoint the board FROM — the
// chairman-only attendee list already IS the whole board — so "Change of
// Board of Director" never applies to it, regardless of what's checked.
function bmIsSingleShareholder() {
  return bmGetAllShareholderNames().length === 0;
}

// Keeps the "board was reappointed" checkbox itself disabled (and
// force-unchecked) for a single-shareholder company, rather than letting the
// user check a box the template will end up ignoring (bmBuildData applies
// the same guard again — this is the UI-visible half of it, not the only
// one). Re-run on every form change, not just at company-select time: adding
// or removing a shareholder row can flip single-shareholder status
// mid-session.
function bmSyncBoardChangedAvailability() {
  const checkbox = document.getElementById('bm-boardChanged');
  const hint = document.getElementById('bm-boardChanged-hint');
  if (!checkbox) return;
  const single = bmIsSingleShareholder();
  checkbox.disabled = single;
  if (single && checkbox.checked) checkbox.checked = false;
  document.getElementById('bm-boardChangeDate-group').style.display = (checkbox.checked && !single) ? '' : 'none';
  if (hint) hint.style.display = single ? '' : 'none';
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — document generation
//  Fills the Unicode/Mangal .docx template (assets/templates) with form
//  values via docxtemplater. Client data is already Unicode Nepali; only
//  numbers and B.S. dates need conversion to Devanagari here.
// ════════════════════════════════════════════
const BM_TEMPLATE_URL = 'assets/templates/bm-agm-minutes.docx';

// Pre-configured audit firms (window.REGD_AUDIT_FIRMS, config.js) - picking
// one fills in the firm name, auditor's full name, and the correct
// professional title (CA vs RA use different Nepali phrasing throughout the
// letters). Same list Auditor Change's new-auditor field picks from.
const BM_AUDIT_FIRMS = window.REGD_AUDIT_FIRMS;

function bmRenderFirmTrigger() {
  const idx = document.getElementById('bm-auditorFirm').value;
  const firm = idx !== '' ? BM_AUDIT_FIRMS[idx] : null;
  document.getElementById('bm-auditorFirm-value').innerHTML = firm
    ? `<div class="ac-name">${escHtml(firm.firmName)}</div><div class="ac-email">${escHtml(firm.title)} ${escHtml(firm.auditorName)}</div>`
    : `<span class="regd-select-placeholder">— Select Auditor —</span>`;
}

attachFirmPicker(document.getElementById('bm-auditorFirm-trigger'), document.getElementById('bm-auditorFirm-list'), {
  getItems: () => BM_AUDIT_FIRMS,
  renderItem: f => `<div class="ac-name">${escHtml(f.firmName)}</div><div class="ac-email">${escHtml(f.title)} ${escHtml(f.auditorName)}</div>`,
  onSelect: (firm, idx) => {
    const hidden = document.getElementById('bm-auditorFirm');
    hidden.value = String(idx);
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    bmRenderFirmTrigger();
  },
});

function bmToDevanagari(s) {
  return NepaliLocale.toDevanagari(s);
}

// "30,000,000.00" -> "३,००,००,०००" (Nepali lakh/crore grouping, Devanagari, no decimals)
function bmFormatAmount(raw) {
  return NepaliLocale.formatAmount(raw);
}

// The §51 capital report states, beside each capital figure, how many shares
// it represents — and row (घ) of that same table fixes the face value at
// रु १००।– per share. So the share count is not an input: it is
// capital ÷ 100, and it must move when the capital does.
//
// It didn't. The count was left as the source client's literal २५,००० on all
// three rows, which is only right because THAT company's capital happened to
// be २५,००,०००. Every other client printed 25,000 shares regardless — a
// रु १,००,००,००० authorised capital reported 25,000 shares instead of
// १,००,०००, on a filing that goes to the Company Registrar.
const BM_FACE_VALUE = 100;   // रु per share, exactly as §51 row (घ) prints it

// "1,00,00,000" -> "१,००,०००"   (whatever the capital, ÷ face value)
function bmShareCount(capitalRaw) {
  const digits = String(capitalRaw || '').split('.')[0].replace(/[^0-9]/g, '');
  if (!digits) return '';
  // floor, not round: a share count is a whole number of shares, and a
  // capital that isn't a multiple of the face value cannot buy a part share
  return bmFormatAmount(String(Math.floor(Number(digits) / BM_FACE_VALUE)));
}

// "2079/09/15" -> { year:२०७९, monthName:पौष, day:१५, full:२०७९/०९/१५ }
function bmParseBsDate(str) {
  return NepaliLocale.parseBsDate(str);
}

// The firm's source document writes both dates and fiscal years with the
// Nepali danda as separator — २०८३।०४।२० and २०८१।८२ — and the fiscal year
// in full four digits, not the ०८१/८२ short form NepaliLocale.fiscalParts
// returns. Fiscal-year formats differ per module BY DECISION (CLAUDE.md
// §8); this is BM/AGM's, taken from the document this module reproduces.
function bmDandaDate(parsed) {
  return parsed ? parsed.full.replace(/\//g, '।') : '';
}

// The §92 Director's Declaration pages carry the company name in its
// ABBREVIATED form (…प्रा. लि.) and the registration number with slashes,
// where every other page uses the full name and dandas. That is the firm's
// own convention on that form — the template keeps separate tokens for it,
// and these two derive the short forms so nobody has to type the name twice.
function bmShortCompanyName(name) {
  return String(name || '')
    .replace(/प्रा(?:इ|ई)भेट\s*लिमिटेड/g, 'प्रा. लि.')
    .replace(/प्रा\.?\s*लि\.?/g, 'प्रा. लि.')
    .trim();
}

// "2081-82" -> { fy:"२०८१।८२", next:"२०८२।८३" }
function bmFiscalDanda(fyValue) {
  const m = String(fyValue || '').match(/(\d{4})\D+(\d{2})/);
  if (!m) return { fy: '', next: '' };
  const y = parseInt(m[1], 10);
  const fmt = a => bmToDevanagari(String(a) + '।' + String(a + 1).slice(-2));
  return { fy: fmt(y), next: fmt(y + 1) };
}

function bmStatus(html, type) {
  showStatus(html, type, 'bm-status');
}

// The attendee list is ONE numbered loop covering the chairman AND every
// shareholder (chairman first, role अध्यक्ष; the rest, role संचालक) — unlike
// the old template, this document numbers the chairman too, so there is no
// separate "unnumbered chairman + numbered shareholders" split. `isChairman`
// drives the two role-conditionals in the per-attendee declaration pages
// (§ Declaration to be submitted by the Director) further down the template.
function bmBuildAttendees() {
  const chairman = document.getElementById('bm-chairmanName').value.trim();
  const list = [];
  if (chairman) list.push({ name: chairman, role: 'अध्यक्ष', isChairman: true });
  bmGetAllShareholderNames().forEach(name => list.push({ name, role: 'संचालक', isChairman: false }));
  return list.map((a, i) => Object.assign(a, { num: bmToDevanagari(String(i + 1)) }));
}

function bmBuildData() {
  const $ = id => document.getElementById(id).value.trim();
  const bm = bmParseBsDate($('bm-bmDate'));
  const agm = bmParseBsDate($('bm-agmDate'));
  const letter = bmParseBsDate($('bm-letterDate'));
  // A single-shareholder company has nobody to reappoint the board FROM —
  // the "Change of Board of Director" block never applies, regardless of
  // the checkbox (bmSyncBoardChangedAvailability keeps the checkbox itself
  // disabled/unchecked for this case; this is the defence-in-depth mirror
  // of that, so a stale checked state can never reach the template).
  const boardChanged = document.getElementById('bm-boardChanged').checked && !bmIsSingleShareholder();
  const boardChangeDateVal = $('bm-boardChangeDate');
  const boardChangeParsed = boardChanged && boardChangeDateVal ? bmParseBsDate(boardChangeDateVal) : null;
  const fy = bmFiscalDanda(document.getElementById('bm-fiscalYear').value);
  const firmIdx = document.getElementById('bm-auditorFirm').value;
  const firm = firmIdx !== '' ? BM_AUDIT_FIRMS[firmIdx] : null;
  const attendees = bmBuildAttendees();

  // The "additional proposal" item (source's own "(Additional Proposal)"
  // placeholder) is only a real agenda item when the user actually typed
  // one — an empty field used to still print as its own numbered item
  // ("२) थप प्रस्ताव छैन"). Left blank, the whole item AND its matching
  // decision are omitted from the template ({{#bmHasExtra}}/
  // {{#agmHasExtra}}), and "विविध" (always the last item/decision in its
  // list) shifts up one number to take its place.
  const bmExtraTitle = $('bm-bmExtraTitle');
  const bmExtraDecision = $('bm-bmExtraDecision');
  const agmExtraTitle = $('bm-agmExtraTitle');
  const agmExtraDecision = $('bm-agmExtraDecision');
  const bmHasExtra = !!(bmExtraTitle || bmExtraDecision);
  const agmHasExtra = !!(agmExtraTitle || agmExtraDecision);

  return { bm, agm, letter, boardChanged, boardChangeParsed, data: {
    companyName:        $('bm-companyName'),
    companyNameShort:   bmShortCompanyName($('bm-companyName')),
    registrationNumber: $('bm-regNo'),
    registrationNumberSlash: $('bm-regNo').replace(/।/g, '/'),
    companyAddress:     $('bm-address'),
    chairmanName:        $('bm-chairmanName'),
    attendees,
    attendeeNamesJoined: attendees.map(a => a.name).join(', '),
    auditorName:        firm ? firm.auditorName : '',
    auditorAddress:     firm ? firm.address : '',
    authorizedCapital:  bmFormatAmount($('bm-authCapital')),
    issuedCapital:      bmFormatAmount($('bm-issuedCapital')),
    paidUpCapital:      bmFormatAmount($('bm-paidUpCapital')),
    // derived from the capitals above at रु १०० face value — never typed
    authorizedShares:   bmShareCount($('bm-authCapital')),
    issuedShares:       bmShareCount($('bm-issuedCapital')),
    paidUpShares:       bmShareCount($('bm-paidUpCapital')),
    fiscalYear:         fy.fy,
    nextFiscalYear:     fy.next,
    bmDate:             bmDandaDate(bm),
    agmDate:            bmDandaDate(agm),
    letterDate:         bmDandaDate(letter),
    boardChangeDate:    bmDandaDate(boardChangeParsed),
    directorTermYears:  bmToDevanagari($('bm-termYears') || '4'),
    bmHasExtra,
    bmExtraProposalTitle:     bmExtraTitle,
    bmExtraProposalDecision:  bmExtraDecision,
    // "विविध" is always item/decision 3 in the BM section, 6 in the AGM
    // section — unless the extra proposal ahead of it was omitted, in
    // which case it moves up to 2 / 5.
    bmMiscItemNum:      bmToDevanagari(bmHasExtra ? '3' : '2'),
    bmMiscDecisionNum:  bmToDevanagari(bmHasExtra ? '3' : '2'),
    agmHasExtra,
    agmExtraProposalTitle:    agmExtraTitle,
    agmExtraProposalDecision: agmExtraDecision,
    // The AGM's own item/decision 4 ("संचालकहरुको पुनर्नियुक्ति" — directors'
    // term ending, reappointed for a new one) restates exactly what the
    // separate "Change of Board of Director" set formalises, so it only
    // belongs on the agenda the year that set is actually generated — gated
    // on the same `boardChanged` flag, not a flag of its own. That makes
    // items/decisions 4 (reappointment, conditional), 5 (extra proposal,
    // conditional) and 6 (विविध, always last) all shift depending on which
    // of the first two are present, so their own numbers are tokens too —
    // not just विविध's, as when only the extra proposal was optional.
    agmExtraItemNum:     bmToDevanagari(boardChanged ? '5' : '4'),
    agmExtraDecisionNum: bmToDevanagari(boardChanged ? '5' : '4'),
    agmMiscItemNum:     bmToDevanagari(String(4 + (boardChanged ? 1 : 0) + (agmHasExtra ? 1 : 0))),
    agmMiscDecisionNum: bmToDevanagari(String(4 + (boardChanged ? 1 : 0) + (agmHasExtra ? 1 : 0))),
    boardChanged,
  }};
}

// Fills the template with `data` (the shape produced by bmBuildData().data) and
// returns the resulting .docx as a Blob. Shared by the Word download and the
// live preview so there is exactly one place that drives document generation.
async function bmRenderDocx(data) {
  const buffer = await DocumentEngine.getTemplate(BM_TEMPLATE_URL);
  return DocumentEngine.renderWord(buffer, data);
}

// Deliberately generates from whatever is on the form — an incomplete
// company/dates just prints blank in the template rather than blocking the
// download, so staff can pull a document to see its shape before the client
// file is fully typed up. bmBuildData() already falls back every field to
// '' and every date to null -> '' (bmDandaDate), so nothing here can throw.
async function generateBmAgmMinutes() {
  const { data } = bmBuildData();

  try {
    bmStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await bmRenderDocx(data);
    const fname = bmOutputName(data) + '.docx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'bmAgmMinutes', clientName: data.companyName });
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
// Deliberately unconditional (2026-08-23, user ask) — preview and print/
// download must work from a blank or partial form, not just a complete one,
// so staff can see the template's shape before every field is typed up.
// bmRefreshPreview's own `!window.docx` guard is what covers "not ready yet".
function bmPreviewReady() {
  return true;
}

function bmShowPreviewPlaceholder() {
  const placeholder = document.getElementById('bm-preview-placeholder');
  const root = document.getElementById('bm-preview-root');
  if (placeholder) placeholder.style.display = 'flex';
  if (root) root.style.display = 'none';
}

// Pagination and sheet-fitting are DocumentEngine's (§4) — the same code
// backs the Company Secretary module's preview and print. This wrapper
// exists only so the call sites below keep reading in this file's own
// vocabulary; the class name is what docx-preview tags each section with.
function bmFitPagesToSheet(container) {
  return DocumentEngine.fitPagesToSheet(container, 'bm-docx');
}

// `isCurrent()` guards against an older, slower render (e.g. the template's
// first-ever fetch) overwriting a newer one that started after further
// typing — the last input always wins. See WorkflowEngine.createDebouncedRefresh.
async function bmRefreshPreview(isCurrent) {
  const placeholder = document.getElementById('bm-preview-placeholder');
  const root = document.getElementById('bm-preview-root');
  if (!placeholder || !root || !window.docx) return;

  const { data } = bmBuildData();

  try {
    const blob = await bmRenderDocx(data);
    if (!isCurrent()) return;

    // ignoreLastRenderedPageBreak:true — split pages ONLY at the template's
    // explicit page breaks (one page per document); Word's recorded soft
    // breaks would scatter each document across half-empty extra pages.
    // bmFitPagesToSheet then compresses any over-tall document onto its
    // single sheet.
    await DocumentEngine.previewWordAsHtml(blob, root, document.getElementById('bm-preview-style'), {
      className: 'bm-docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    if (!isCurrent()) return;

    placeholder.style.display = 'none';
    root.style.display = 'block';
    bmFitPagesToSheet(root);
    bmWireEditableTokens(data);
  } catch (err) {
    console.error('BM/AGM preview render failed:', err);
  }
}

const bmPreviewRefreshCtl = WorkflowEngine.createDebouncedRefresh(bmRefreshPreview, 500);
function bmSchedulePreviewRefresh() {
  bmPreviewRefreshCtl.schedule();
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — Edit/Preview view toggle
//  Mirrors js/report.js's repSetView pattern: a wide edit form and a wide
//  preview, one visible at a time. Unlike Report Builder, Save as Word and
//  Print never read the preview's DOM — they call bmRenderDocx(bmBuildData())
//  fresh from the form fields every time — so switching views never risks an
//  export seeing empty/stale content; this toggle exists purely so preview
//  rendering (a real docx-preview render, heavier than Report Builder's HTML
//  string interpolation) only happens on demand instead of on every keystroke.
// ════════════════════════════════════════════
function bmIsPreviewOpen() {
  const pv = document.getElementById('bm-preview-view');
  return !!pv && !pv.hidden;
}

function bmSetView(mode) {
  const preview = mode === 'preview';
  const pv = document.getElementById('bm-preview-view');
  // Render only when entering preview from the edit view — not when Preview
  // is already open — so a click-to-edit token commit (which itself re-opens
  // this same code path via bmOnFormChanged) isn't wiped by a redundant
  // second render racing the first.
  const enteringPreview = preview && pv.hidden;
  document.getElementById('bm-edit-view').hidden = preview;
  pv.hidden = !preview;
  document.getElementById('bm-tab-edit').classList.toggle('active', !preview);
  document.getElementById('bm-tab-preview').classList.toggle('active', preview);
  if (enteringPreview) bmRefreshPreview(bmIsPreviewOpen);
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
    { field: 'bm-address', value: data.companyAddress },
    { field: 'bm-chairmanName', value: data.chairmanName },
  ];
  const extraInputs = document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input');
  const shareholders = (data.attendees || []).filter(a => !a.isChairman);
  shareholders.forEach((sh, i) => {
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
  WorkflowEngine.attachFormWatcher(document.getElementById('regd-bmAgmMinutes-panel'), bmOnFormChanged);
  bmSyncBoardChangedAvailability();
  bmLoadDraft();
  bmRenderFirmTrigger();
  bmUpdateCompletionIndicator();
});

// ════════════════════════════════════════════
//  BM/AGM MINUTES — export
// ════════════════════════════════════════════

// ── Save to database / Saved minutes ──
//
// The same pair Generate Report and Notes to Accounts have, over the shared
// saved_documents table and the one shared picker drawer (CLAUDE.md §15:
// saved documents are ONE table with a `module` discriminator, so this is a
// CHECK value — db/2026-08-21_saved_documents_bmagm.sql — not a new table).
//
// Re-saving in the same session amends the same row, matching the other two.
let bmSavedId = null;

async function bmSaveToDb() {
  const companyName = (document.getElementById('bm-companyName').value || '').trim();
  if (!companyName) {
    bmStatus('कम्पनीको नाम भर्नुहोस् (enter the company name before saving).', 'error');
    return;
  }
  const fy = document.getElementById('bm-fiscalYear').value;
  try {
    bmStatus('<span class="spinner spinner-navy"></span> सुरक्षित गर्दै (saving)…', 'searching');
    bmSavedId = await DocumentStore.save(bmSavedId, {
      module: 'bmAgmMinutes',
      // client_id stays NULL on purpose: it is FK'd to clients(id), and a
      // BM/AGM company is a registrar_companies row. The two directories are
      // separate by design (CLAUDE.md §15), and an id from one would either
      // break the FK or point at an unrelated client in the other.
      client_id: null,
      client_name: companyName,
      pan: (document.getElementById('bm-regNo').value || '').trim() || null,
      fiscal_year: fy,
      doc_type: document.getElementById('bm-boardChanged').checked
        ? 'BM/AGM + Change of Board' : 'BM/AGM',
      title: bmOutputName(bmBuildData().data) || ('BM-AGM — ' + companyName),
      state: bmFormState(),
      // no doc_html: unlike Report/Notes there is no hand-edited preview to
      // preserve — the Word file regenerates from `state` byte for byte
    });
    bmStatus(`✅ सुरक्षित भयो (saved as record #${bmSavedId}) — <strong>Saved minutes</strong> बाट पुन: खोल्न सकिन्छ.`, 'success');
    AuditLog.record('bm_agm_saved', {
      module: 'bmAgmMinutes', clientName: companyName, status: 'success', recordRef: bmSavedId,
    });
  } catch (e) {
    console.error(e);
    bmStatus('❌ सुरक्षित हुन सकेन (save failed): ' + escHtml(e.message), 'error');
  }
}

function bmOpenSaved() {
  DocumentStore.openPicker({
    module: 'bmAgmMinutes',
    label: 'Saved BM/AGM minutes',
    searchPlaceholder: 'Search by company, fiscal year…',
    onOpen: row => {
      if (!bmApplyState(row.state)) {
        bmStatus('यो रेकर्डमा फारम विवरण छैन (this record has no form state saved).', 'error');
        return;
      }
      bmSavedId = row.id;
      bmUpdateCompletionIndicator();
      if (bmIsPreviewOpen()) bmSchedulePreviewRefresh();
      bmStatus(`📂 सुरक्षित माइन्युट #${row.id} खोलियो — Save to database फेरि थिच्दा यही रेकर्ड अद्यावधिक हुन्छ (opened; saving again updates this same record).`, 'info');
    },
  });
}

// The one place the output name is built. BOTH the .docx download and the
// print window use it — the print window's <title> is what the browser
// offers as the filename under "Save as PDF", so naming them separately is
// how the two silently drift apart.
//
// Fiscal year first (user request, 2026-08-21): a client's documents then
// sort by year in a folder listing instead of by the constant "BM-AGM".
// The label is BM-AGM, not BM/AGM, because "/" is illegal in a filename on
// every platform — the browser would substitute something anyway, so choose
// the substitution rather than inherit it.
function bmOutputName(data) {
  const fy = (document.getElementById('bm-fiscalYear') || {}).value || '';
  return [fy, 'BM-AGM', (data && data.companyName) || '']
    .filter(Boolean).join(' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// Builds print HTML from a FRESH offscreen render (not the preview pane's
// DOM): one section.bm-docx per document, each fitted onto its own printed
// sheet by bmFitPagesToSheet and forced onto its own page via
// page-break-after with @page margins at 0 (the docx page margins are
// already inside each section as padding).
async function bmBuildPrintableDoc() {
  const { data } = bmBuildData();
  const blob = await bmRenderDocx(data);
  // the title is the filename the browser proposes for "Save as PDF"
  return DocumentEngine.buildPrintableHtml(blob, { className: 'bm-docx', title: bmOutputName(data) });
}

async function bmOpenPrintWindow(successMessage) {
  bmStatus('<span class="spinner spinner-navy"></span> प्रिन्टका लागि तयार गर्दै (preparing print)…', 'searching');
  let html = null;
  try { html = await bmBuildPrintableDoc(); }
  catch (err) { bmStatus('❌ ' + (err.message || 'Print failed'), 'error'); return; }
  if (!html) { bmStatus('कृपया पहिले कम्पनी र मितिहरू भर्नुहोस् (fill in the company and dates to build a preview first).', 'info'); return; }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) { bmStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस् (pop-up blocked — please allow pop-ups for this site, then try again).', 'error'); return; }
  bmStatus(successMessage || '🖨️ प्रिन्ट विन्डो खुल्यो (print window opened).', 'success');
}

// One button covers both Print and Save-as-PDF (the browser's print dialog
// itself offers "Save as PDF" as a destination) — matching Report Builder's
// single "Save as PDF / Print" action instead of two separate buttons.
function bmPrintDocument() {
  bmOpenPrintWindow('🖨️ प्रिन्ट विन्डो खुल्यो — प्रिन्ट गर्नुहोस् वा गन्तव्यमा "Save as PDF" रोज्नुहोस् (a print window opened — print, or choose "Save as PDF" as the destination).');
}

function bmResetForm() {
  const panel = document.getElementById('regd-bmAgmMinutes-panel');
  if (!panel) return;
  // drop the link to any opened record, or the next Save silently overwrites
  // the document that was just cleared off the screen
  bmSavedId = null;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  // A cleared form derives again from the next board-meeting date typed.
  Object.keys(BM_DERIVED_DATE_OFFSETS).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.dataset.auto = '1';
  });
  document.getElementById('bm-termYears').value = '4';
  document.getElementById('bm-fiscalYear').value = window.FY_DEFAULT_START + '-' + String((window.FY_DEFAULT_START + 1) % 100).padStart(2, '0');
  document.getElementById('bm-auditorFirm').value = '';
  bmRenderFirmTrigger();
  bmClearExtraShareholders();
  document.getElementById('bm-boardChanged').checked = false;
  bmToggleBoardChangedFields();

  document.getElementById('bm-company-summary').style.display = 'none';
  document.getElementById('bm-company-edit-fields').style.display = 'contents';
  const toggleBtn = document.getElementById('bm-edit-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = 'Edit Company Details';

  document.getElementById('bm-status').innerHTML = '';
  bmShowPreviewPlaceholder();
  bmSetView('edit');
  bmClearDraft();
  bmUpdateCompletionIndicator();
}

// ════════════════════════════════════════════
//  BM/AGM MINUTES — polish: zoom, inline date validation, autosave,
//  completion indicator
// ════════════════════════════════════════════

// Single entry point for "something in the form changed" — keeps the three
// independent side effects (preview, draft, completion status) from being
// wired up separately at every call site. Preview only re-renders while it's
// the visible view — e.g. a click-to-edit token commit — never while the
// (hidden) edit form is being typed into.
function bmOnFormChanged(e) {
  // Date derivation runs BEFORE the side effects below, so the preview,
  // draft and completion indicator all see the filled dates in the same
  // pass rather than one keystroke behind.
  const id = e && e.target && e.target.id;
  if (id === 'bm-bmDate') bmApplyDerivedDates();
  // Editing a derived field hands it to the user for good. Any event landing
  // here IS a user edit: the two places that write these fields
  // (bmApplyDerivedDates, bmApplyState) assign .value directly, which fires
  // nothing — so a field only un-owns itself when somebody types in it. A
  // future programmatic writer must keep to that rule or set data-auto itself.
  else if (id in BM_DERIVED_DATE_OFFSETS) {
    const el = document.getElementById(id);
    if (el) el.dataset.auto = '0';
  }
  bmSyncBoardChangedAvailability();
  if (bmIsPreviewOpen()) bmSchedulePreviewRefresh();
  bmScheduleAutosave();
  bmUpdateCompletionIndicator();
}

// ── Zoom ──
const bmZoom = WorkflowEngine.createZoomControl(document.getElementById('bm-preview-root'), document.getElementById('bm-zoom-level'));
function bmSetZoom(level) { bmZoom.set(level); }
function bmZoomIn() { bmZoom.zoomIn(); }
function bmZoomOut() { bmZoom.zoomOut(); }

// ── Dates derived from the board-meeting date (user ask, 2026-08-24) ──
//
// The Date of Board Meeting is the ONE date typed by hand; the AGM, the
// registrar letters and the board-change meeting follow from it at a fixed
// offset the firm always uses. Each stays a normal editable field — this
// fills a default, it does not own the value.
//
// Offsets in days from the board-meeting date. Kept as one table rather than
// three literals so the convention is stated in a single place and changing
// it is a one-line edit rather than a hunt through the fill logic.
const BM_DERIVED_DATE_OFFSETS = {
  'bm-agmDate': 1,
  'bm-letterDate': 1,
  'bm-boardChangeDate': 0,
};

// A derived field carries data-auto="1" while it still holds a generated
// value, and drops to "0" the moment the user edits it themselves — the
// `data-auto` idiom Company Registration's founder-share split already uses.
// Without it, re-dating the board meeting would silently overwrite a date
// somebody had deliberately typed, which on a registrar filing is the same
// class of bug as the client-switch "always assign" rule (CLAUDE.md §9).
function bmMarkDerivedDatesManual() {
  Object.keys(BM_DERIVED_DATE_OFFSETS).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.dataset.auto = '0';
  });
}

// Called when the board-meeting date changes. Fills every derived date that
// is still auto-owned, in the SAME separator the user typed (the field
// accepts / - and . alike, and echoing their own style back is less
// surprising than normalising it under them).
function bmApplyDerivedDates() {
  const src = document.getElementById('bm-bmDate');
  if (!src) return;
  const raw = src.value.trim();
  const sep = (raw.match(/[\/\-.]/) || ['/'])[0];
  Object.entries(BM_DERIVED_DATE_OFFSETS).forEach(([id, offset]) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.auto === '0') return;
    // An unparseable or out-of-calendar board date clears the derived
    // fields rather than leaving a stale date from the previous entry
    // standing under a new one.
    const parts = raw ? NepaliLocale.bsAddDays(raw, offset) : null;
    el.value = parts
      ? [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join(sep)
      : '';
    el.dataset.auto = '1';
    bmValidateDateField(id);
  });
}

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
// ONE serialisation of the form, shared by the localStorage autosave and the
// Save-to-database record. Keeping them separate is how a field added to the
// form ends up captured by one and silently missed by the other.
function bmFormState() {
  const panel = document.getElementById('regd-bmAgmMinutes-panel');
  const values = {};
  panel.querySelectorAll('input[id^="bm-"], select[id^="bm-"]').forEach(el => {
    values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const extraShareholders = Array.from(document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input')).map(i => i.value);
  // Which derived dates are still auto-owned travels WITH the record. A date
  // this form generated is not the same fact as one somebody typed, and
  // without carrying the distinction every restore would have to assume the
  // cautious answer ("all typed") — which quietly stops the board-meeting
  // date from driving the others again for the rest of that record's life.
  const derivedAuto = {};
  Object.keys(BM_DERIVED_DATE_OFFSETS).forEach(id => {
    const el = document.getElementById(id);
    if (el) derivedAuto[id] = el.dataset.auto === '0' ? '0' : '1';
  });
  return { values, extraShareholders, derivedAuto };
}

// Clears BEFORE it can return early, and clears the shareholder rows before
// re-adding them — otherwise opening a second saved record stacks its
// directors underneath the previous one's (CLAUDE.md §9).
function bmApplyState(state) {
  if (!state || !state.values) return false;
  bmClearExtraShareholders();
  Object.entries(state.values).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
  });
  (state.extraShareholders || []).forEach(name => { if (name) bmAddShareholderRow(name); });
  // Restore which derived dates the user had claimed. A record saved before
  // this existed carries no flags, and those load as MANUAL on purpose: its
  // dates were all typed by hand, so re-dating the board meeting must not
  // rewrite the dates a filing already went out with.
  if (state.derivedAuto) {
    Object.entries(state.derivedAuto).forEach(([id, flag]) => {
      const el = document.getElementById(id);
      if (el) el.dataset.auto = flag === '0' ? '0' : '1';
    });
  } else {
    bmMarkDerivedDatesManual();
  }
  bmToggleBoardChangedFields();
  return true;
}

const bmAutosave = WorkflowEngine.createAutosave('bmAgmDraft', {
  collect: bmFormState,
  restore: (draft) => {
    if (!draft.values || !Object.values(draft.values).some(v => v)) return;
    bmApplyState(draft);
    if (bmIsPreviewOpen()) bmSchedulePreviewRefresh();
    bmStatus('📝 अघिल्लो अपूर्ण फारम पुन: लोड गरियो (restored your unsaved draft from last time).', 'info');
  },
  debounceMs: 600,
});
function bmScheduleAutosave() { bmAutosave.scheduleSave(); }
function bmClearDraft() { bmAutosave.clear(); }
function bmLoadDraft() { bmAutosave.load(); }

// ── Completion indicator ──
function bmUpdateCompletionIndicator() {
  WorkflowEngine.updateCompletionIndicator('bm-completion-indicator', ['bm-companyName', 'bm-bmDate', 'bm-agmDate'], '✅ Ready to generate');
}
