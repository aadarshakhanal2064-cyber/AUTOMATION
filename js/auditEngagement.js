// ════════════════════════════════════════════
//  AUDIT ENGAGEMENT LETTER  (Automation Hub tab, `ae-` prefix)
//
//  The fourth HTML document builder, and deliberately the same shape as the
//  Audit Report Builder (js/report.js) and Notes to Accounts
//  (js/notesToAccounts.js): one flat edit form, an Edit/Preview toggle that
//  renders on demand, Save to database + a saved-letters drawer through
//  DocumentStore, and the same two exports (true .docx via html-docx-js, PDF
//  via a standalone print window).
//
//  Wording is tokenized from the firm's own `Audit Engagements.docx`. What
//  the source highlighted in yellow is what varies per letter, and that list
//  IS this module's form: the client, the engagement type, the fiscal years,
//  the firm and its signatory, the governing act, the fee per year, the
//  payment window and the acknowledgement signatory. Everything else in that
//  file is fixed NSA 210 boilerplate and is reproduced verbatim.
//
//  Two things the source document could not express and this module derives:
//
//    · The letter covers SEVERAL fiscal years. The source's fee table is one
//      row per year (five drawn, one filled) and §5 lists them, so the years
//      are a row editor here — one row carries both the year and its fee, and
//      that single list drives the Subject line, §5 Audit Period, the §6 fee
//      table and the acknowledgement. Typed in one place, printed in four.
//
//    · The addressee and the governing act follow the ENTITY TYPE. The source
//      is typed for a private company ("The Board of Directors", "Companies
//      Act, 2063"); on a proprietorship both are simply wrong. Both come from
//      REP_ENTITY_PROFILES / AE_ENTITY_ADDRESSEE, the same profiles the audit
//      report already maps a client's `entity_type` onto.
//
//  LOAD ORDER: after js/report.js — renderRepFirmHeader() and repAssetUrl()
//  are shared with it (rule 1: the letterhead is one implementation, not two),
//  and both are read at RENDER time, so the order is a convention rather than
//  strictly load-bearing. The `.rep-sheet` / `.rep-sig-block` / `.rep-title`
//  presentation classes are shared for the same reason.
// ════════════════════════════════════════════

ModuleRegistry.register({ id: 'auditEngagement', group: 'main', buttonId: null, panelId: 'tab-auditEngagement-panel' });

function $ae(id){ return document.getElementById(id); }

// ── Client selection ──────────────────────────────────────────────────────
// Same autocomplete pair the report builder uses (name + PAN), reading the
// same window.clientsList.
function aeSelectClient(c){
  $ae('ae-entityName').value = c.name || '';
  $ae('ae-entityAddress').value = c.address || '';
  $ae('ae-entityPan').value = c.pan || '';

  // Assign unconditionally (§9). `if (mapped)` would leave the PREVIOUS
  // client's entity type standing whenever this one's spelling isn't in the
  // map — which here decides both the addressee and the governing act.
  const mapped = window.CLIENT_ENTITY_TO_REP_PROFILE[(c.entity_type || '').trim().toLowerCase()];
  $ae('ae-entityType').value = mapped || 'private_company';

  aeForgetSavedId();   // a different client is a different letter
  aeRefresh();
}

SearchEngine.attachAutocomplete($ae('ae-entityName'), $ae('ae-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['name', 'email', 'pan'],
  renderItem: c => `
    <div class="ac-name">${escHtml(c.name)}</div>
    <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: aeSelectClient,
});

SearchEngine.attachAutocomplete($ae('ae-entityPan'), $ae('ae-pan-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['pan'],
  minChars: 2,
  renderItem: c => `
    <div class="ac-name">${escHtml(c.pan)}</div>
    <div class="ac-email">${escHtml(c.name)}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: aeSelectClient,
});

// ── Fiscal-year + fee rows ────────────────────────────────────────────────
// One row per engagement year. This list is the letter's spine: the Subject
// line, §5 Audit Period, the §6 fee table and the acknowledgement all read it,
// so a year added here appears in all four and can never disagree with itself.

// This module prints the slash form (`2082/83`), matching the source letter
// and the audit report's own dropdown labels. The KEY stays the dash form so
// it can be looked up in REP_FY_DATES and stored in `fiscal_year` like every
// other module's (CLAUDE.md §8 — the formats differ per module on purpose).
function aeFyLabel(key){
  const [a, b] = String(key || '').split('-');
  return b ? `${a}/${b}` : (a || '');
}

function aeFyOptionsHtml(selected){
  return Object.keys(window.REP_FY_DATES || {})
    .map(k => `<option value="${escHtml(k)}"${k === selected ? ' selected' : ''}>${escHtml(aeFyLabel(k))}</option>`)
    .join('');
}

function aeAddYearRow(fy, fee){
  const row = document.createElement('div');
  row.className = 'ae-row';
  row.innerHTML = `
    <select class="ae-y-fy">${aeFyOptionsHtml(fy || String(window.FY_DEFAULT_START) + '-' + String(window.FY_DEFAULT_START + 1).slice(-2))}</select>
    <input type="text" class="ae-y-fee" placeholder="Professional fee, e.g. 25,000.00" value="${escHtml(fee || '')}" />
    <button type="button" class="btn btn-outline btn-sm ae-row-rm" onclick="aeRemoveRow(this)">Remove</button>`;
  $ae('ae-year-rows').appendChild(row);
  return row;
}

function aeRemoveRow(btn){
  const host = $ae('ae-year-rows');
  // The letter has no meaning without at least one engagement year — every
  // year-driven section would render an empty list. Blank the last row
  // instead of removing it, so the form can never reach that state.
  if (host.children.length <= 1){
    const only = host.children[0];
    if (only) only.querySelector('.ae-y-fee').value = '';
  } else {
    btn.closest('.ae-row').remove();
  }
  aeForgetSavedId();   // the engagement's years are part of its identity
  aeRefresh();
}

function aeGetYearRows(){
  return Array.from($ae('ae-year-rows').children).map(r => ({
    fy: r.querySelector('.ae-y-fy').value,
    fee: r.querySelector('.ae-y-fee').value.trim(),
  }));
}

// A fee is TEXT, deliberately (§15 — the firm's own comma grouping is worth
// preserving, and "As mutually agreed" is a real answer). A bare number is
// still formatted, because typing 25000 and printing "NPR 25000" on a fee
// schedule reads as a draft; anything else prints exactly as typed.
function aeFeeText(raw){
  const v = String(raw || '').trim();
  if (!v) return '';
  const bare = v.replace(/,/g, '');
  if (/^\d+(\.\d+)?$/.test(bare)) return 'NPR ' + fmtAmount(bare);
  return /^(npr|rs)/i.test(v) ? v : 'NPR ' + v;
}

// The fee total prints only when every row carries a real figure — a schedule
// whose total silently omits an "As mutually agreed" line would understate
// what the client is signing for.
function aeFeeTotal(rows){
  let sum = 0;
  for (const r of rows){
    const bare = String(r.fee || '').replace(/,/g, '').trim();
    if (!/^\d+(\.\d+)?$/.test(bare)) return null;
    sum += Number(bare);
  }
  return rows.length ? sum : null;
}

// "2082/83" · "2082/83 and 2083/84" · "2082/83, 2083/84 and 2084/85"
function aeJoinList(items){
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function aeAddressee(key){
  return (window.AE_ENTITY_ADDRESSEE || {})[key] || 'The Management';
}

// ── State ─────────────────────────────────────────────────────────────────
function getAeState(){
  const rows = aeGetYearRows();
  const years = rows.map(r => aeFyLabel(r.fy));
  return {
    firm: window.REP_FIRMS[$ae('ae-firm').value] || {},
    engagement: window.AE_ENGAGEMENT_TYPES[$ae('ae-engagementType').value] || { label: 'Audit', auditorRole: 'auditor' },
    entityName: $ae('ae-entityName').value.trim() || '[ENTITY NAME]',
    entityTypeKey: $ae('ae-entityType').value,
    entityType: window.REP_ENTITY_PROFILES[$ae('ae-entityType').value] || {},
    entityAddress: $ae('ae-entityAddress').value.trim(),
    entityPan: $ae('ae-entityPan').value.trim(),
    rows,
    years,
    yearsText: aeJoinList(years) || '[FISCAL YEAR]',
    letterDate: $ae('ae-letterDate').value.trim(),
    payDays: $ae('ae-payDays').value.trim() || '2',
    ackSignatory: $ae('ae-ackSignatory').value.trim() || 'Authorized Director',
    includeLetterhead: $ae('ae-toggleLetterhead').checked,
    includeAck: $ae('ae-toggleAck').checked,
    includeExtra: $ae('ae-toggleExtra').checked,
    extraHeading: $ae('ae-extraHeading').value.trim(),
    extraText: $ae('ae-extraText').value.trim(),
  };
}

// Form-textarea text -> letter HTML: escaped, line breaks preserved.
function aeMultiline(text){
  return escHtml(text).replace(/\n/g, '<br>');
}

// ── Rendering ─────────────────────────────────────────────────────────────
//
// Section numbers run off a counter rather than being written into the
// strings, so the optional clause can be inserted before Acceptance without
// renumbering anything by hand — the same lesson notesToAccounts.js's
// ntaRenderNotesSection() records.
function aeRenderSections(s){
  const e = s.entityType;
  const act = e.act || 'the applicable law';
  const noun = e.entityNoun || 'company';
  const nounCap = e.entityNounCap || 'Company';
  let n = 0;
  const sec = (title) => `<h3 class="rep-sec"><span class="rep-section-num">${++n}.</span> ${title}</h3>`;

  const out = [];

  out.push(`${sec('Objective of the Audit')}
    <p>The objective of our audit is to express an independent opinion as to whether the financial statements of the ${nounCap} for ${s.years.length > 1 ? 'each of the above fiscal years' : 'the above fiscal year'} present fairly, in all material respects, the financial position, financial performance and cash flows of the ${nounCap} in accordance with the applicable Nepal Financial Reporting Standards (NFRS/NFRS for SMEs) and the requirements of the ${act}.</p>`);

  out.push(`${sec('Scope of the Audit')}
    <p>Our audit will be conducted in accordance with Nepal Standards on Auditing (NSAs). These standards require that we:</p>
    <ul class="rep-audit-points">
      <li>Perform audit procedures considered necessary based on our professional judgment.</li>
      <li>Evaluate accounting policies, accounting estimates and financial statement disclosures.</li>
      <li>Evaluate the overall presentation of the financial statements.</li>
      <li>Communicate significant audit findings to management and those charged with governance.</li>
    </ul>
    <p>Because of the inherent limitations of an audit and internal controls, there is an unavoidable risk that some material misstatements may not be detected.</p>`);

  out.push(`${sec('Responsibilities of Management')}
    <p>Management is responsible for:</p>
    <ul class="rep-audit-points">
      <li>Preparing financial statements in accordance with the applicable financial reporting framework.</li>
      <li>Maintaining proper books of account and supporting records.</li>
      <li>Designing, implementing and maintaining adequate internal controls.</li>
      <li>Preventing and detecting fraud and error.</li>
      <li>Complying with applicable laws and regulations.</li>
      <li>Providing unrestricted access to all financial records, books, vouchers, agreements, legal documents, minutes and any other information requested during the audit.</li>
      <li>Providing written management representations at the conclusion of the audit.</li>
    </ul>`);

  out.push(`${sec('Responsibilities of the Auditor')}
    <p>Our responsibility is to conduct the audit in accordance with Nepal Standards on Auditing and issue an Independent Auditor's Report.</p>
    <p>During the audit we shall:</p>
    <ul class="rep-audit-points">
      <li>Maintain professional independence.</li>
      <li>Exercise professional skepticism and professional judgment.</li>
      <li>Maintain confidentiality of information obtained during the audit except where disclosure is required by law or professional standards.</li>
    </ul>`);

  out.push(`${sec('Audit Period')}
    <p>This engagement covers the ${s.engagement.label.toLowerCase()} of the financial statements for:</p>
    <ul class="rep-audit-points">
      ${s.years.map(y => `<li>Fiscal Year ${escHtml(y)}</li>`).join('\n      ')}
    </ul>
    ${s.years.length > 1 ? `<p>A separate audit report will be issued for each fiscal year.</p>` : ''}`);

  out.push(`${sec('Audit Fees')}
    <p>Our professional fees for conducting the ${s.engagement.label.toLowerCase()} shall be as follows:</p>
    ${aeRenderFeeTable(s)}
    <p>In addition:</p>
    <ul class="rep-audit-points">
      <li>VAT shall be charged at the prevailing rate, where applicable.</li>
      <li>Actual out-of-pocket expenses, including travel, accommodation, courier charges and other incidental expenses incurred in connection with the audit, shall be reimbursed by the ${nounCap}.</li>
      <li>The audit fee shall become payable within ${escHtml(s.payDays)} day${s.payDays === '1' ? '' : 's'} of submission of the respective audit report.</li>
    </ul>`);

  out.push(`${sec('Access to Information')}
    <p>The ${nounCap} agrees to provide us with timely access to:</p>
    <ul class="rep-audit-points">
      <li>Books of accounts.</li>
      <li>Financial statements.</li>
      <li>Bank confirmations.</li>
      <li>Statutory registers.</li>
      <li>Inventory records.</li>
      <li>Fixed asset records.</li>
      <li>Legal correspondence.</li>
      <li>Any other information necessary for the audit.</li>
    </ul>`);

  out.push(`${sec('Confidentiality')}
    <p>All information obtained during the course of our engagement shall be treated as confidential except where disclosure is required by law, regulatory authorities or professional standards.</p>`);

  out.push(`${sec('Ownership of Working Papers')}
    <p>All audit documentation and working papers prepared during the engagement shall remain the sole property of ${escHtml(s.firm.name || '[FIRM]')}.</p>`);

  out.push(`${sec('Limitation of the Audit')}
    <p>Our audit is not designed to identify every weakness in internal control or every instance of fraud. However, any significant matters identified during the audit will be communicated to management.</p>`);

  out.push(`${sec('Applicable Law')}
    <p>This engagement shall be governed by:</p>
    <ul class="rep-audit-points">
      <li>${escHtml(act)}</li>
      <li>Nepal Standards on Auditing (NSAs)</li>
      <li>Nepal Financial Reporting Standards (NFRS/NFRS for SMEs), where applicable</li>
      <li>Code of Ethics issued by the Institute of Chartered Accountants of Nepal</li>
      <li>Other applicable laws and regulations of Nepal</li>
    </ul>`);

  // The optional clause is inserted here — before Acceptance, which must stay
  // the last numbered section because it is what the client signs against.
  if (s.includeExtra){
    out.push(`${sec(s.extraHeading || 'Additional Terms')}
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Type the additional terms here&hellip;">${aeMultiline(s.extraText)}</div>`);
  }

  out.push(`${sec('Acceptance')}
    <p>Please indicate your acknowledgement and acceptance of the terms of this engagement by signing below and returning a copy of this letter. We appreciate the opportunity to serve ${escHtml(s.entityName)} and look forward to a successful professional relationship.</p>`);

  return out.join('\n\n    ');
}

function aeRenderFeeTable(s){
  const total = aeFeeTotal(s.rows);
  return `
    <table class="ae-fee-table">
      <thead>
        <tr><th style="width:40%">Fiscal Year</th><th>Professional Fee (NPR)</th></tr>
      </thead>
      <tbody>
        ${s.rows.map(r => `<tr><td>${escHtml(aeFyLabel(r.fy))}</td><td class="ae-fee-amt">${escHtml(aeFeeText(r.fee)) || '<span class="ae-fee-blank">—</span>'}</td></tr>`).join('\n        ')}
        ${total != null && s.rows.length > 1
          ? `<tr class="ae-fee-total"><td>Total</td><td class="ae-fee-amt">NPR ${escHtml(fmtAmount(total))}</td></tr>`
          : ''}
      </tbody>
    </table>`;
}

function aeRenderAcknowledgement(s){
  if (!s.includeAck) return '';
  const role = s.engagement.auditorRole;
  const firmLine = s.firm.name ? `${s.firm.name}${s.firm.title ? ', ' + s.firm.title : ''}` : '[FIRM]';
  return `
    <div class="ae-ack">
      <div class="rep-title ae-ack-title">Acknowledgement</div>
      <p>We acknowledge that we have read, understood and agreed to the terms and conditions set out in this Audit Engagement Letter and hereby appoint ${escHtml(firmLine)} as the ${escHtml(role)} of ${escHtml(s.entityName)} for the fiscal year${s.years.length > 1 ? 's' : ''} ${escHtml(s.yearsText)}.</p>
      <div class="ae-ack-sign">
        <p>For <strong>${escHtml(s.entityName)}</strong></p>
        <p class="ae-ack-rule">${escHtml(s.ackSignatory)}</p>
        <p>Name: ______________________________</p>
        <p>Date: ______________________________</p>
        <p>Company Seal</p>
      </div>
    </div>`;
}

function renderAeLetter(){
  const s = getAeState();
  const f = s.firm;
  const act = s.entityType.act || 'the applicable law';

  const html = `
  <div class="rep-sheet ae-sheet" contenteditable="true" spellcheck="false">
    ${s.includeLetterhead ? renderRepFirmHeader(f) : ''}

    <div class="ae-to">
      <p>To</p>
      <p>${escHtml(aeAddressee(s.entityTypeKey))}</p>
      <p><strong>${escHtml(s.entityName)}</strong></p>
      ${s.entityAddress ? `<p>${escHtml(s.entityAddress)}</p>` : ''}
      ${s.entityPan ? `<p>PAN: ${escHtml(s.entityPan)}</p>` : ''}
    </div>

    <p class="ae-subject"><strong>Subject: Audit Engagement Letter for the ${escHtml(s.engagement.label)} of Financial Statements for Fiscal Year${s.years.length > 1 ? 's' : ''} ${escHtml(s.yearsText)}</strong></p>

    <p>Dear Sir/Madam,</p>

    <p>We thank you for appointing ${escHtml(f.name || '[FIRM]')}${f.title ? ', ' + escHtml(f.title) : ''}, as the ${escHtml(s.engagement.auditorRole)} of ${escHtml(s.entityName)} for the fiscal year${s.years.length > 1 ? 's' : ''} ${escHtml(s.yearsText)}.</p>

    <p>This letter confirms our understanding of the terms and conditions of our engagement in accordance with Nepal Standards on Auditing (NSA 210), the ${escHtml(act)}, and other applicable laws and regulations of Nepal.</p>

    ${aeRenderSections(s)}

    <div class="ae-signoff">
      <p>Yours faithfully,</p>
      <p><strong>For ${escHtml(f.name || '[FIRM]')}</strong></p>
      <p>${escHtml(f.title || '')}</p>
      <p class="rname">${escHtml(f.signatoryName || '')}</p>
      <p>${escHtml(f.signatoryTitle || '')}</p>
      ${f.mNo ? `<p>M.No. ${escHtml(f.mNo)}</p>` : ''}
      <p>Date: ${escHtml(s.letterDate)}</p>
    </div>

    ${aeRenderAcknowledgement(s)}
  </div>`;

  $ae('ae-previewRoot').innerHTML = html;
}

// ── Edit / Preview view switching (report.js's repSetView pattern) ────────
function aeIsPreviewOpen(){
  const pv = $ae('ae-preview-view');
  return pv && !pv.hidden;
}
function aeRefresh(){
  aeUpdateOptionalVisibility();
  if (aeIsPreviewOpen()) renderAeLetter();
}
function aeSetView(mode){
  const preview = mode === 'preview';
  const pv = $ae('ae-preview-view');
  // Render only when ENTERING preview from the edit view — re-rendering while
  // preview is already open would wipe hand-edits made in the sheet.
  if (preview && pv.hidden) renderAeLetter();
  $ae('ae-edit-view').hidden = preview;
  pv.hidden = !preview;
  $ae('ae-tab-edit').classList.toggle('active', !preview);
  $ae('ae-tab-preview').classList.toggle('active', preview);
}
// Before exporting: render fresh from the edit view, keep the DOM if already
// in preview so manual edits survive into the export.
function aeEnsureRendered(){
  if (!aeIsPreviewOpen()) renderAeLetter();
}

function aeUpdateOptionalVisibility(){
  $ae('ae-extra-input-wrap').hidden = !$ae('ae-toggleExtra').checked;
  $ae('ae-ack-signatory-wrap').hidden = !$ae('ae-toggleAck').checked;
}

// Every plain field of a letter. One list, used to wire the watchers AND to
// persist/restore — a field added to only one of the two is this pattern's
// whole failure mode (see REP_FIELDS).
const AE_FIELDS = ['ae-firm','ae-engagementType','ae-entityName','ae-entityType','ae-entityAddress',
  'ae-entityPan','ae-letterDate','ae-payDays','ae-ackSignatory','ae-toggleLetterhead','ae-toggleAck',
  'ae-toggleExtra','ae-extraHeading','ae-extraText'];

window.addEventListener('load', () => {
  // Datalist for the acknowledgement signatory — a picklist that still
  // accepts anything typed (§15, the bbPopulateExpenseNames idiom).
  const dl = $ae('ae-ackSignatory-list');
  if (dl) dl.innerHTML = (window.AE_ACK_SIGNATORIES || [])
    .map(v => `<option value="${escHtml(v)}"></option>`).join('');

  // One engagement year to start on, defaulting to the app-wide fiscal year
  // (window.FY_DEFAULT_START — §15: every module rolls over together).
  if (!$ae('ae-year-rows').children.length) aeAddYearRow(aeDefaultFyKey(), '');

  // Delegated watchers cover the dynamically-added year rows too, and only
  // re-render while Preview is open.
  const editView = $ae('ae-edit-view');
  editView.addEventListener('input', aeRefresh);
  editView.addEventListener('change', aeRefresh);

  // Programmatic assignment (aeApplyState) fires no change event, so
  // restoring a saved letter can't trip this.
  $ae('ae-year-rows').addEventListener('change', aeForgetSavedId);

  aeUpdateOptionalVisibility();
});

// The dash-form key matching window.FY_DEFAULT_START, e.g. 2082 -> "2082-83".
function aeDefaultFyKey(){
  const y = window.FY_DEFAULT_START;
  return `${y}-${String(y + 1).slice(-2)}`;
}

// ════════════════════════════════════════════
//  Export — Save as PDF/Print (print window) + Save as Word (html-docx-js).
//  Identical mechanism to report.js / notesToAccounts.js, so all four
//  outputs of all three builders stay visually consistent.
// ════════════════════════════════════════════

// The letter as it should LEAVE the app: an unfilled optional-terms block
// carries an authoring prompt on screen and must not print. CSS alone can't
// cover the Word path (html-docx-js honours neither :empty nor @media print),
// so the cleanup happens in the markup — the same rule repExportHtml() follows.
function aeExportHtml(){
  const clone = $ae('ae-previewRoot').cloneNode(true);
  clone.querySelectorAll('.rep-blank-fill').forEach(el => {
    if (!el.textContent.trim()) el.remove();
  });
  return clone.innerHTML;
}

function buildAePrintableDoc(){
  const inner = aeExportHtml();
  const allCss = Array.from(document.styleSheets).map(sheet => {
    try { return Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); }
    catch(e){ return ''; }
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Audit Engagement Letter</title><style>
    body{ margin:0; background:#fff; font-family:Arial,sans-serif; padding:24px; }
    ${allCss}
    @page{ size:A4; margin: 12mm 16mm; }
    @media print{
      /* Repeated from the copied stylesheet on purpose — see the same block
         in report.js's buildRepPrintableDoc(). */
      html, body{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      body{ padding:0; }
      .rep-sheet{ box-shadow:none; border:none; padding:0; max-width:none; color:#000; }
    }
  </style></head><body>${inner}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
}

function printAeLetter(){
  aeEnsureRendered();   // works straight from the edit view
  const blob = new Blob([buildAePrintableDoc()], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win){
    alert('Pop-up blocked — please allow pop-ups for this site, then click Save as PDF / Print again.');
  }
}

// The same .rep-* / .ae-* rules the preview uses, with the CSS custom
// properties resolved to concrete values (Word cannot read var()).
function getAeExportCss(){
  const sheetEl = document.querySelector('#ae-previewRoot .rep-sheet');
  const rootCs  = getComputedStyle(document.documentElement);
  const sheetCs = sheetEl ? getComputedStyle(sheetEl) : rootCs;
  const val = (cs, name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const vars = {
    '--rep-space-xs':   val(sheetCs, '--rep-space-xs', '4px'),
    '--rep-space-sm':   val(sheetCs, '--rep-space-sm', '8px'),
    '--rep-space-md':   val(sheetCs, '--rep-space-md', '14px'),
    '--rep-space-lg':   val(sheetCs, '--rep-space-lg', '22px'),
    '--rep-space-xl':   val(sheetCs, '--rep-space-xl', '36px'),
    '--rep-line-height':val(sheetCs, '--rep-line-height', '1.28'),
    '--rep-muted':      val(sheetCs, '--rep-muted', '#333'),
    '--brand-navy':     val(rootCs,  '--brand-navy', '#0b1f3d'),
    '--radius':         val(rootCs,  '--radius', '10px'),
    '--border':         val(rootCs,  '--border', '#e6e9f2'),
  };
  let css = '';
  for (const sheet of document.styleSheets){
    let rules;
    try { rules = sheet.cssRules; } catch(e){ continue; }   // cross-origin sheets throw
    for (const r of rules){
      if (r.selectorText && /\.rep|\.rname|\.ae-/.test(r.selectorText)) css += r.cssText + '\n';
    }
  }
  Object.entries(vars).forEach(([k, v]) => { css = css.split('var(' + k + ')').join(v); });
  css = css.replace(/var\([^)]+\)/g, '');
  return css;
}

function buildAeWordHtml(){
  return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Audit Engagement Letter</title><style>" +
    "body{ margin:0; font-family:'Georgia','Times New Roman',serif; color:#111; font-size:12.5px; line-height:1.28; }" +
    getAeExportCss() +
    ".rep-sheet{ box-shadow:none; border:none; padding:0; max-width:none; }" +
    "</style></head><body>" + aeExportHtml() + "</body></html>";
}

async function saveAeAsWord(){
  aeEnsureRendered();
  try { await LibLoader.ensure('htmldocx'); } catch (e) { /* .doc fallback below */ }
  const html = buildAeWordHtml();
  const clientName = $ae('ae-entityName').value.trim() || 'Engagement Letter';
  const base = ('Audit Engagement Letter - ' + clientName).replace(/[\\/:*?"<>|]/g, '_');

  if (window.htmlDocx && typeof window.htmlDocx.asBlob === 'function'){
    // margins in twips (1440 = 1 inch) ≈ the 12mm/16mm print margins
    const blob = window.htmlDocx.asBlob(html, { margins: { top: 680, bottom: 680, left: 907, right: 907 } });
    DocumentEngine.downloadBlob(blob, base + '.docx', { module: 'auditEngagement', clientName });
    return;
  }
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  DocumentEngine.downloadBlob(blob, base + '.doc', { module: 'auditEngagement', clientName });
}

// ════════════════════════════════════════════
//  PERSISTENCE — saved_documents via DocumentStore (js/core/documentStore.js).
//
//  Same contract as report.js and notesToAccounts.js: the form state makes a
//  saved letter re-editable, the rendered document makes it reprintable
//  exactly as issued. That second half matters more here than anywhere else —
//  an engagement letter is countersigned, so "reprint what they signed" has to
//  be literally true. The year/fee rows are part of the state, so a restored
//  letter comes back with its fee schedule intact.
// ════════════════════════════════════════════
let aeSavedId = null;

function aeStatus(html, type){ showStatus(html, type, 'ae-status'); }

function aeFormState(){
  const state = { rows: { years: aeGetYearRows() } };
  AE_FIELDS.forEach(id => {
    const el = $ae(id);
    if (!el) return;
    state[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return state;
}

function aeApplyState(state){
  AE_FIELDS.forEach(id => {
    const el = $ae(id);
    if (!el) return;
    const v = state ? state[id] : undefined;
    // Assign unconditionally (§9) — an `if (v)` guard would leave the
    // PREVIOUS letter's text standing wherever the saved one was blank.
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v == null ? '' : v;
  });
  // The row editor is rebuilt from scratch — clearing FIRST is what stops the
  // previous letter's fee schedule surviving into a restored one (§9).
  const years = ((state && state.rows) || {}).years || [];
  $ae('ae-year-rows').innerHTML = '';
  years.forEach(r => aeAddYearRow(r.fy, r.fee));
  if (!$ae('ae-year-rows').children.length) aeAddYearRow(aeDefaultFyKey(), '');
  aeUpdateOptionalVisibility();
}

async function aeSaveToDb(){
  aeEnsureRendered();
  const clientName = $ae('ae-entityName').value.trim();
  if (!clientName){ aeStatus('Enter a client name before saving.', 'error'); return; }
  const rows = aeGetYearRows();
  const matched = (window.clientsList || []).find(c => (c.name || '').trim() === clientName);
  const typeLabel = (window.AE_ENGAGEMENT_TYPES[$ae('ae-engagementType').value] || {}).label || 'Audit';
  const yearsText = aeJoinList(rows.map(r => aeFyLabel(r.fy)));
  try {
    aeStatus('Saving engagement letter…', 'searching');
    aeSavedId = await DocumentStore.save(aeSavedId, {
      module: 'auditEngagement',
      client_id: matched ? matched.id : null,
      client_name: clientName,
      pan: $ae('ae-entityPan').value.trim() || null,
      // The FIRST engagement year — a letter can cover several, and the full
      // list is in `state`. This column is the picker's handle and has to
      // stay in the dash form every other module's `fiscal_year` uses.
      fiscal_year: rows[0] ? rows[0].fy : null,
      doc_type: $ae('ae-engagementType').value,
      title: `${typeLabel} Engagement Letter — ${clientName} (F.Y. ${yearsText})`,
      state: aeFormState(),
      doc_html: $ae('ae-previewRoot').innerHTML,
    });
    aeStatus(`Engagement letter saved (record #${aeSavedId}). Reopen it any time from <strong>Saved letters</strong>.`, 'success');
    AuditLog.record('audit_engagement_saved', {
      module: 'auditEngagement', clientName, status: 'success', recordRef: aeSavedId,
      detail: { engagementType: $ae('ae-engagementType').value, fiscalYears: yearsText },
    });
  } catch (e){
    console.error(e);
    aeStatus('Save failed: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

function aeOpenSaved(){
  DocumentStore.openPicker({
    module: 'auditEngagement',
    label: 'Saved engagement letters',
    onOpen: row => {
      aeApplyState(row.state);
      aeSavedId = row.id;            // further saves amend this record
      aeRefresh();
      // The STORED document, not a re-render: hand-edits made before saving
      // are part of the letter that was actually issued and countersigned.
      if (row.doc_html) $ae('ae-previewRoot').innerHTML = row.doc_html;
      else renderAeLetter();
      aeSetViewRestored();
      aeStatus(`Opened saved letter #${row.id}. Editing the form re-renders it; Save to database updates the same record.`, 'info');
    },
  });
}

// Switch to Preview WITHOUT re-rendering — aeSetView('preview') renders on
// entry, which would immediately overwrite the document just restored.
function aeSetViewRestored(){
  $ae('ae-edit-view').hidden = true;
  $ae('ae-preview-view').hidden = false;
  $ae('ae-tab-edit').classList.remove('active');
  $ae('ae-tab-preview').classList.add('active');
}

// Client + engagement years ARE the letter's identity, so changing either
// means the next save creates a new record rather than overwriting the one
// that was open — the same rule repForgetSavedId() records, and the same
// bug (a stale saved id rewriting the PREVIOUS client's row) it prevents.
function aeForgetSavedId(){ aeSavedId = null; }
