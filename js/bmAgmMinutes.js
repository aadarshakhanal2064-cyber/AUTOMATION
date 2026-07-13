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

SearchEngine.attachAutocomplete(document.getElementById('bm-regNo'), document.getElementById('bm-regNo-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['registration_number', 'pan'],
  minChars: 2,
  normalizeQuery: v => bmToEnglishDigits(v),
  normalizeItem: c => ({ registration_number: bmToEnglishDigits(c.registration_number), pan: bmToEnglishDigits(c.pan) }),
  renderItem: c => `
    <div class="ac-name">${escHtml(c.registration_number || c.pan)}</div>
    <div class="ac-email">${escHtml(c.name)}${c.pan ? ' · PAN ' + escHtml(c.pan) : ''}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectBmClient,
});

async function selectBmClient(c) {
  document.getElementById('bm-regNo').value           = c.registration_number || '';
  document.getElementById('bm-companyName').value     = c.name || '';
  document.getElementById('bm-pan').value              = c.pan || '';
  document.getElementById('bm-address').value          = c.address || '';
  document.getElementById('bm-chairmanName').value     = c.chairman_name || '';
  document.getElementById('bm-shareholderName').value  = c.shareholder_name || '';
  document.getElementById('bm-authCapital').value      = c.authorized_capital || '';
  document.getElementById('bm-issuedCapital').value    = c.issued_capital || '';
  document.getElementById('bm-paidUpCapital').value    = c.paid_up_capital || '';

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

// Fills the template with `data` (the shape produced by bmBuildData().data) and
// returns the resulting .docx as a Blob. Shared by the Word download and the
// live preview so there is exactly one place that drives document generation.
async function bmRenderDocx(data) {
  const buffer = await DocumentEngine.getTemplate(BM_TEMPLATE_URL);
  return DocumentEngine.renderWord(buffer, data);
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

// Fits each rendered page-section onto exactly one sheet. Pages are split
// only at the template's explicit page breaks — one page per document, so
// the company-name header always tops its sheet and the signature block
// stays with its document. A document that runs taller than the sheet has
// its FONT SIZES genuinely reduced (every inline font-size/min-height/
// line-height the docx renderer emitted, scaled from stashed originals)
// until the content fits — a real layout change, deliberately NOT a visual
// trick: CSS zoom paginates print from the pre-zoom layout box (phantom
// blank page), and transform:scale is skipped outright by Chrome's print
// engine (content clipped at the paper edge at unscaled size). Font scaling
// is the one approach where screen and print cannot disagree, because the
// laid-out geometry IS the shrunk geometry. The section box itself is
// locked to the sheet's exact pixel size with overflow:hidden as the final
// guarantee that no page can ever spill. Shared by the live preview and the
// print window so both paginate identically.
function bmFitPagesToSheet(container) {
  const sections = container.querySelectorAll('section.bm-docx');
  if (!sections.length) return null;

  // Hidden container (e.g. preview refreshed before the tab was opened, such
  // as a draft restore at load): everything measures 0 in place, so measure
  // an offscreen clone instead (the docx stylesheet is a global <style>, so
  // the clone renders identically) and copy the fitted result back.
  const hidden = !sections[0].getBoundingClientRect().height;
  let measureSections = sections;
  let holder = null;
  if (hidden) {
    const wrapper = container.querySelector('.bm-docx-wrapper') || container;
    holder = document.createElement('div');
    holder.style.cssText = 'position:absolute; left:-10000px; top:0;';
    holder.appendChild(wrapper.cloneNode(true));
    document.body.appendChild(holder);
    measureSections = holder.querySelectorAll('section.bm-docx');
  }

  // Scale one stashed inline value (e.g. "37pt", "16px"), preserving its unit.
  const scaleLen = (orig, z) => (parseFloat(orig) * z) + (orig.replace(/[\d. ]/g, '') || 'px');

  try {
    const pageW = Math.round(parseFloat(getComputedStyle(measureSections[0]).width));
    const pageH = Math.round(parseFloat(getComputedStyle(measureSections[0]).minHeight));

    measureSections.forEach((m, i) => {
      m.style.width = pageW + 'px';
      m.style.minHeight = pageH + 'px';
      m.style.height = pageH + 'px';
      m.style.overflow = 'hidden';

      // Stash every inline length the docx renderer emitted, once per
      // element, so each fit attempt scales from the true originals instead
      // of compounding on a previous attempt.
      let els = Array.from(m.querySelectorAll('[data-bm-fs]'));
      if (!els.length) {
        els = Array.from(m.querySelectorAll('*')).filter(el => el.style && (el.style.fontSize || el.style.minHeight));
        els.forEach(el => {
          el.dataset.bmFs = el.style.fontSize || '';
          el.dataset.bmMh = el.style.minHeight || '';
          el.dataset.bmLh = el.style.lineHeight || '';
          el.dataset.bmMb = el.style.marginBottom || '';
        });
      }
      const applyScale = z => els.forEach(el => {
        if (el.dataset.bmFs) el.style.fontSize = scaleLen(el.dataset.bmFs, z);
        if (el.dataset.bmMh) el.style.minHeight = scaleLen(el.dataset.bmMh, z);
        if (el.dataset.bmLh && parseFloat(el.dataset.bmLh)) el.style.lineHeight = scaleLen(el.dataset.bmLh, z);
        if (el.dataset.bmMb) el.style.marginBottom = scaleLen(el.dataset.bmMb, z);
      });

      // Bisect for the largest scale that fits (each probe forces a full
      // reflow, so ~6 probes beats a ~25-step linear walk on preview-refresh
      // latency). Fitting is monotonic in z: smaller text never gets taller.
      applyScale(1);
      if (m.scrollHeight > m.clientHeight + 1) {
        let lo = 0.5, hi = 1;
        while (hi - lo > 0.01) {
          const z = (lo + hi) / 2;
          applyScale(z);
          if (m.scrollHeight <= m.clientHeight + 1) lo = z; else hi = z;
        }
        applyScale(lo);
      }

      if (hidden && sections[i]) {
        sections[i].innerHTML = m.innerHTML;
        sections[i].style.cssText = m.style.cssText;
      }
    });
    return { pageW, pageH };
  } finally {
    if (holder) holder.remove();
  }
}

// `isCurrent()` guards against an older, slower render (e.g. the template's
// first-ever fetch) overwriting a newer one that started after further
// typing — the last input always wins. See WorkflowEngine.createDebouncedRefresh.
async function bmRefreshPreview(isCurrent) {
  const placeholder = document.getElementById('bm-preview-placeholder');
  const root = document.getElementById('bm-preview-root');
  if (!placeholder || !root || !window.docx) return;

  if (!bmPreviewReady()) { bmShowPreviewPlaceholder(); return; }

  const { bm, agm, data } = bmBuildData();
  if (!bm || !agm) { bmShowPreviewPlaceholder(); return; }

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
  WorkflowEngine.attachFormWatcher(document.getElementById('regd-bmAgmMinutes-panel'), bmOnFormChanged);
  bmLoadDraft();
  bmRenderFirmTrigger();
  bmUpdateCompletionIndicator();
});

// ════════════════════════════════════════════
//  BM/AGM MINUTES — export
// ════════════════════════════════════════════

// Builds print HTML from a FRESH offscreen render (not the preview pane's
// DOM): one section.bm-docx per document, each fitted onto its own printed
// sheet by bmFitPagesToSheet and forced onto its own page via
// page-break-after with @page margins at 0 (the docx page margins are
// already inside each section as padding).
async function bmBuildPrintableDoc() {
  if (!bmPreviewReady()) return null;
  const { bm, agm, data } = bmBuildData();
  if (!bm || !agm) return null;

  const blob = await bmRenderDocx(data);
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
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });

    const fit = bmFitPagesToSheet(content);
    if (!fit) return null;
    const { pageW, pageH } = fit;

    // textContent, not innerHTML — docx-preview injects its CSS as a real
    // nested <style> element, and innerHTML would serialize that tag
    // literally, closing our own wrapping <style> block early.
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BM/AGM Minutes</title><style>
    @page { size: ${pageW}px ${pageH}px; margin: 0; }
    html, body { margin:0; padding:0; background:#fff; }
    ${styleEl.textContent}
    .bm-docx-wrapper { display:block !important; background:#fff !important; padding:0 !important; }
    .bm-docx-wrapper > section.bm-docx { box-shadow:none !important; margin:0 auto !important; page-break-after: always; }
    .bm-docx-wrapper > section.bm-docx:last-child { page-break-after: auto; }
  </style></head><body>${content.innerHTML}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
  } finally {
    holder.remove();
  }
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
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  document.getElementById('bm-agmTime').value = '11:00';
  document.getElementById('bm-fiscalYear').value = '2081-82';
  document.getElementById('bm-auditorFirm').value = '';
  bmRenderFirmTrigger();
  bmClearExtraShareholders();

  document.getElementById('bm-company-summary').style.display = 'none';
  document.getElementById('bm-company-edit-fields').style.display = 'block';
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
function bmOnFormChanged() {
  if (bmIsPreviewOpen()) bmSchedulePreviewRefresh();
  bmScheduleAutosave();
  bmUpdateCompletionIndicator();
}

// ── Zoom ──
const bmZoom = WorkflowEngine.createZoomControl(document.getElementById('bm-preview-root'), document.getElementById('bm-zoom-level'));
function bmSetZoom(level) { bmZoom.set(level); }
function bmZoomIn() { bmZoom.zoomIn(); }
function bmZoomOut() { bmZoom.zoomOut(); }

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
const bmAutosave = WorkflowEngine.createAutosave('bmAgmDraft', {
  collect: () => {
    const panel = document.getElementById('regd-bmAgmMinutes-panel');
    const values = {};
    panel.querySelectorAll('input[id^="bm-"], select[id^="bm-"]').forEach(el => { values[el.id] = el.value; });
    const extraShareholders = Array.from(document.querySelectorAll('#bm-extra-shareholders .bm-extra-shareholder-input')).map(i => i.value);
    return { values, extraShareholders };
  },
  restore: (draft) => {
    if (!draft.values || !Object.values(draft.values).some(v => v)) return;
    Object.entries(draft.values).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    });
    (draft.extraShareholders || []).forEach(name => { if (name) bmAddShareholderRow(name); });
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
