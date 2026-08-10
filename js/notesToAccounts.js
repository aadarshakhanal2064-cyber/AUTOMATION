// ════════════════════════════════════════════
//  NOTES TO ACCOUNTS (standalone module)
//  Significant Accounting Policies & Notes to Financial Statements generator.
//  Mirrors js/report.js's Audit Report Builder 1:1 — same Edit/Preview toggle,
//  same on-demand HTML-templating into a preview root, same Save as Word
//  (html-docx-js) + Save as PDF/Print (print window) exports — under an
//  "nta" namespace so nothing collides with report.js's "rep". Most of the
//  document is fixed boilerplate accounting-policy text; the client details,
//  the accounting-standard wording, the depreciation method, the PPE
//  useful-life table and an optional Related Party section are the only
//  driven parts.
// ════════════════════════════════════════════

function $nta(id){ return document.getElementById(id); }

// No buttonId — launched from the topbar "Automation Hub" menu, not a sidebar button.
ModuleRegistry.register({ id: 'notesToAccounts', group: 'main', buttonId: null, panelId: 'tab-notesToAccounts-panel' });

// Reuses the SAME clientsList already loaded from Supabase (loadClients()),
// so client search here matches the Clients/Report tabs exactly.
// Every field this fills is assigned unconditionally: the `if (c.x)` guards
// this used to carry meant a client with no business nature, no address or an
// unmapped entity type simply inherited the previously selected client's.
function selectNtaClient(c){
  $nta('nta-entityName').value = c.name || '';
  $nta('nta-entityAddress').value = c.address || '';
  $nta('nta-entityPan').value = c.pan || '';
  $nta('nta-businessNature').value = c.business_nature || '';
  $nta('nta-place').value = c.address || '';

  const mapped = window.CLIENT_ENTITY_TO_REP_PROFILE[(c.entity_type || '').trim().toLowerCase()];
  $nta('nta-entityType').value = mapped || 'private_company';

  ntaForgetSavedId();   // different client => a different saved record
  ntaRefresh();
}

SearchEngine.attachAutocomplete($nta('nta-entityName'), $nta('nta-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['name', 'email', 'pan'],
  renderItem: c => `
    <div class="ac-name">${escHtml(c.name)}</div>
    <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectNtaClient,
});

SearchEngine.attachAutocomplete($nta('nta-entityPan'), $nta('nta-pan-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['pan'],
  minChars: 2,
  renderItem: c => `
    <div class="ac-name">${escHtml(c.pan)}</div>
    <div class="ac-email">${escHtml(c.name)}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectNtaClient,
});

// ════════════════════════════════════════════
//  In-form row editors: PPE useful-life + Related Party
//  Same repeating-row pattern as bmAgmMinutes.js's extra-shareholder rows.
// ════════════════════════════════════════════
function ntaAddPpeRow(type, life){
  const wrap = $nta('nta-ppe-rows');
  const row = document.createElement('div');
  row.className = 'nta-row';
  row.innerHTML = `
    <input type="text" class="nta-ppe-type" placeholder="Type of PPE" />
    <input type="text" class="nta-ppe-life" placeholder="Estimated useful life" />
    <button type="button" class="btn btn-danger btn-sm nta-row-rm" onclick="this.parentElement.remove(); ntaRefresh();">Remove</button>
  `;
  wrap.appendChild(row);
  if (type) row.querySelector('.nta-ppe-type').value = type;
  if (life) row.querySelector('.nta-ppe-life').value = life;
  ntaRefresh();
}

function ntaGetPpeRows(){
  return Array.from(document.querySelectorAll('#nta-ppe-rows .nta-row'))
    .map(r => ({ type: r.querySelector('.nta-ppe-type').value.trim(), life: r.querySelector('.nta-ppe-life').value.trim() }))
    .filter(r => r.type || r.life);
}

function ntaAddRpRow(party, amount, txnType, relation){
  const wrap = $nta('nta-rp-rows');
  const row = document.createElement('div');
  row.className = 'nta-row';
  row.innerHTML = `
    <input type="text" class="nta-rp-party" placeholder="Related party" />
    <input type="text" class="nta-rp-amount" placeholder="Transaction amount" />
    <input type="text" class="nta-rp-type" placeholder="Transaction type" />
    <input type="text" class="nta-rp-relation" placeholder="Nature of relation" />
    <button type="button" class="btn btn-danger btn-sm nta-row-rm" onclick="this.parentElement.remove(); ntaRefresh();">Remove</button>
  `;
  wrap.appendChild(row);
  if (party) row.querySelector('.nta-rp-party').value = party;
  if (amount) row.querySelector('.nta-rp-amount').value = amount;
  if (txnType) row.querySelector('.nta-rp-type').value = txnType;
  if (relation) row.querySelector('.nta-rp-relation').value = relation;
  ntaRefresh();
}

function ntaGetRpRows(){
  return Array.from(document.querySelectorAll('#nta-rp-rows .nta-row'))
    .map(r => ({
      party: r.querySelector('.nta-rp-party').value.trim(),
      amount: r.querySelector('.nta-rp-amount').value.trim(),
      type: r.querySelector('.nta-rp-type').value.trim(),
      relation: r.querySelector('.nta-rp-relation').value.trim(),
    }))
    .filter(r => r.party || r.amount || r.type || r.relation);
}

function ntaToggleRelatedParty(){
  const on = $nta('nta-toggleRelatedParty').checked;
  $nta('nta-rp-editor').hidden = !on;
  if (on && !document.querySelector('#nta-rp-rows .nta-row')) ntaAddRpRow();
  ntaRefresh();
}

// ── Additional notes ──
// The firm's fixed notes end at 6 (7 with Related Party), but a real set
// regularly needs a few more, and sometimes a headed group of its own. Two
// row kinds cover both: a `note` continues the running number, a `title`
// renders as a bold heading and RESTARTS the numbering beneath it — which is
// why the fixed notes below are no longer written as literal "1."–"6." text.
// Deliberately Notes-only: the audit report's sections are prescribed by the
// NSAs and are not the auditor's to extend (CA instruction, 2026-08-02).
function ntaAddExtraRow(kind, text){
  const wrap = $nta('nta-extra-rows');
  const row = document.createElement('div');
  row.className = 'nta-row';
  row.innerHTML = `
    <select class="nta-x-kind" onchange="ntaRefresh()">
      <option value="note">Numbered note</option>
      <option value="title">Bold title</option>
    </select>
    <textarea class="nta-x-text" placeholder="Note text — or the heading, if this row is a bold title"></textarea>
    <button type="button" class="btn btn-danger btn-sm nta-row-rm" onclick="this.parentElement.remove(); ntaRefresh();">Remove</button>
  `;
  wrap.appendChild(row);
  if (kind) row.querySelector('.nta-x-kind').value = kind;
  if (text) row.querySelector('.nta-x-text').value = text;
  ntaRefresh();
}

function ntaGetExtraRows(){
  return Array.from(document.querySelectorAll('#nta-extra-rows .nta-row'))
    .map(r => ({ kind: r.querySelector('.nta-x-kind').value, text: r.querySelector('.nta-x-text').value.trim() }))
    .filter(r => r.text);
}

function ntaToggleExtraNotes(){
  const on = $nta('nta-toggleExtraNotes').checked;
  $nta('nta-extra-editor').hidden = !on;
  if (on && !document.querySelector('#nta-extra-rows .nta-row')) ntaAddExtraRow();
  ntaRefresh();
}

// ════════════════════════════════════════════
//  State + rendering
// ════════════════════════════════════════════
function getNtaState(){
  return {
    entityName: $nta('nta-entityName').value.trim() || "[ENTITY NAME]",
    entityType: window.REP_ENTITY_PROFILES[$nta('nta-entityType').value],
    entityAddress: $nta('nta-entityAddress').value.trim() || "[ADDRESS]",
    entityPan: $nta('nta-entityPan').value.trim() || "[PAN]",
    place: $nta('nta-place').value.trim() || $nta('nta-entityAddress').value.trim() || "[PLACE OF INCORPORATION]",
    businessNature: $nta('nta-businessNature').value.trim() || "[nature of business]",
    fy: window.REP_FY_DATES[$nta('nta-fy').value],
    standard: window.NTA_ACCOUNTING_STANDARDS[$nta('nta-standard').value],
    depMethod: window.NTA_DEPRECIATION_METHODS[$nta('nta-depMethod').value],
    ppe: ntaGetPpeRows(),
    includeRP: $nta('nta-toggleRelatedParty').checked,
    relatedParties: ntaGetRpRows(),
    includeExtra: $nta('nta-toggleExtraNotes').checked,
    extraNotes: ntaGetExtraRows(),
  };
}

// Form-textarea text -> document HTML: escaped, line breaks preserved.
function ntaMultiline(text){
  return escHtml(text).replace(/\n/g, '<br>');
}

function ntaRenderPpeTable(ppe){
  const rows = ppe.length ? ppe : [{ type: '', life: '' }];
  return `
    <table class="nta-table">
      <thead><tr><th style="width:55%">Type of PPE</th><th style="width:45%">Estimated Useful Life</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${escHtml(r.type)}</td><td>${escHtml(r.life)}</td></tr>`).join('')}</tbody>
    </table>`;
}

function ntaRenderRpTable(list){
  const rows = list.length ? list : [{ party: '', amount: '', type: '', relation: '' }];
  return `
    <table class="nta-table">
      <thead><tr><th>Related Party</th><th>Transaction Amount</th><th>Transaction Type</th><th>Nature of Relation</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${escHtml(r.party)}</td><td>${escHtml(r.amount)}</td><td>${escHtml(r.type)}</td><td>${escHtml(r.relation)}</td></tr>`).join('')}</tbody>
    </table>`;
}

// Section B's notes, numbered by a running counter rather than by literal
// "1."–"6." text. Everything after the six fixed notes — Related Party, then
// any additional rows — takes the next number automatically, and a bold
// title row resets the count to 1 so its own notes read 1, 2, 3 beneath it.
function ntaRenderNotesSection(s, e){
  const out = [];
  let n = 0;
  const note = html => { n++; out.push(`<p>${n}. ${html}</p>`); };

  note('Cash &amp; Cash equivalents for the purpose of Cash Flow Statement comprise of Cash in hand and balances held in current bank accounts.');
  note('Balances shown under trade receivables, trade payables, loans &amp; advances, deposits are subject to confirmation, reconciliation &amp; consequential adjustment, if any. The re-conciliation is carried out on ongoing basis &amp; provisions wherever considered necessary have been made in line with the guidelines. Request for confirmations of balances were sent and reconciliations with the parties are carried out as an ongoing process.');
  note('In the absence of confirmation from all the parties, balances of various parties included under Sundry Debtors/Trade Payables in the Balance Sheet are as per ledger, trial balance and therefore the resultant effect of difference, if any of the same on financial statements is unascertainable. However, the management is of the opinion that these are fully recoverable and payable as applicable.');
  note(`All the expenses, income, assets and Liabilities have been accounted for, ascertained with reasonable certainty and accuracy. They have been measured and presented with reasonable certainty, accuracy, completeness, and consistency in accordance with the applicable accounting principles and on the basis of supporting documents and internal records maintained by the ${e.entityNounCap}.`);
  note("To facilitate better understanding and comparability of financial statements, the previous year's figures have been regrouped, rearranged, and reclassified wherever considered necessary and practicable in accordance with applicable accounting principles.");
  note('Schedules referred above form part of the Financial Statements and have been duly authenticated.');

  if (s.includeRP){
    note('<strong>Related Party Transaction</strong>');
    out.push('<p>Following are the related party transactions:</p>');
    out.push(ntaRenderRpTable(s.relatedParties));
  }

  if (s.includeExtra){
    s.extraNotes.forEach(r => {
      if (r.kind === 'title'){
        out.push(`<p class="nta-note-title">${ntaMultiline(r.text)}</p>`);
        n = 0;                       // a headed group starts its own 1, 2, 3
      } else {
        note(ntaMultiline(r.text));
      }
    });
  }

  return out.join('\n    ');
}

function ntaDocHeader(s){
  return `
    <div style="text-align:center; border-bottom:3px double #000; padding-bottom:8px; margin-bottom:22px;">
      <div style="font-size:16px; font-weight:700;">${s.entityName}</div>
      <div style="font-size:12.5px;">${s.entityAddress}</div>
      <div style="font-size:14px; font-weight:700; text-decoration:underline; margin-top:6px;">Notes to Financial Statements</div>
      <div style="font-size:12px; font-style:italic;">Figures in NPR</div>
    </div>`;
}

function renderNtaReport(){
  const s = getNtaState();
  const e = s.entityType;
  const std = s.standard.full;

  const html = `
  <div class="rep-sheet" contenteditable="true" spellcheck="false">
    ${ntaDocHeader(s)}
    <div class="rep-title">Significant Accounting Policies and Notes to Accounts</div>

    <h3 class="rep-sec"><span class="rep-section-num">1.</span> General information</h3>
    <p>M/S ${s.entityName} was incorporated in ${s.place}. The main objective of the ${e.entityNoun} is to carry on the business of ${s.businessNature} in Nepal. The ${e.entityNounCap} is registered under Inland Revenue Department (IRD) with PAN number of ${s.entityPan}.</p>

    <h3 class="rep-sec"><span class="rep-section-num">2.</span> Significant Accounting Policies</h3>
    <p><strong>2.1 Basis of preparation and accounting policies</strong></p>

    <p><strong>2.1.1 Statement of Compliance</strong></p>
    <p>These financial statements have been prepared in accordance with ${std}.</p>

    <p><strong>2.1.2 Basis of Measurement</strong></p>
    <p>The financial statements have been prepared on the historical cost basis.</p>

    <p><strong>2.1.3 Critical Accounting Estimates</strong></p>
    <p>The preparation of the financial statements in conformity with ${std} requires the use of certain critical accounting estimates and judgements. The company makes certain estimates and assumptions regarding the future events. In the future, actual result may differ from these estimates and assumptions. The estimates and assumptions that have a significant risk of causing a material adjustment to the carrying amounts of assets and liabilities within the next financial year are to be disclosed.</p>

    <p><strong>2.1.4 Functional and Presentation Currency</strong></p>
    <p>The financial statements are prepared in Nepalese Rupees, which is the Company's functional currency. All the financial information presented in Nepalese Rupees has been rounded to the nearest rupee, except otherwise indicated.</p>

    <p><strong>2.2 Accounting Policies</strong></p>
    <p>The principal accounting policies adopted in the preparation of the financial statements are set out below. The policies have been consistently applied to all the years presented, unless otherwise stated.</p>

    <p><strong>2.2.1 Impairment of non-financial assets (excluding inventories)</strong></p>
    <p>Non-financial assets are subject to impairment tests whenever events or changes in circumstances indicate that their carrying amount may not be recoverable. Where the carrying value of an asset exceeds its recoverable amount, the asset is written down accordingly. Impairment charges are included in profit or loss.</p>

    <p><strong>2.2.2 Property, plant and equipment</strong></p>
    <p>Items of property, plant and equipment are initially recognized at cost. Cost includes the purchase price and other directly attributable costs. Subsequently, items of property, plant and equipment are measured at cost less depreciation less impairment.</p>

    <p><strong>2.2.3 Depreciation</strong></p>
    <p>Freehold land is not depreciated. Depreciation on assets under construction does not commence until they are complete and available for use. Depreciation is provided on all other items of property, plant and equipment so as to write-off their carrying value over the expected useful economic lives.</p>
    <p>Depreciation has been computed on ${s.depMethod.name} as per estimated useful rates adopted by management.</p>
    ${ntaRenderPpeTable(s.ppe)}

    <p><strong>2.2.4 Leased Assets</strong></p>
    <p>When all the risks and rewards incidental to the ownership are not transferred to the company (an operating lease), the total rentals payable under the lease are charged to the statement of income over the lease term.</p>

    <p><strong>2.2.5 Trade and other receivables</strong></p>
    <p>Trade and other receivables are stated at their cost less provision for impairment. The amount of the provision is recognized in the income statement.</p>

    <p><strong>2.2.6 Inventories</strong></p>
    <p>Inventories are initially recognized at cost, and subsequently at the lower of cost and net realisable value. The cost is determined on first-out-first (FIFO) method or weighted average method and included expenditure incurred in acquiring the inventories and bringing them to their present location and condition. In the case of manufactured inventories and work-in-progress, cost includes direct material and labour cost and it does not include overheads which is charged to the statement of income in the period in which it is incurred.</p>

    <p><strong>2.2.7 Cash and cash equivalents</strong></p>
    <p>Cash and cash equivalents comprises cash balances, call deposits and other short term highly liquid investments. Bank overdrafts that are repayable on demand and form an integral part of the company's cash management are included within borrowings in current liabilities on the balance sheet.</p>

    <p><strong>2.2.8 Share capital</strong></p>
    <p>Financial instruments issued by the company are classified as equity only to the extent that they do not meet the definition of a financial liability or financial asset. The company's equity shares are classified as equity instruments.</p>

    <p><strong>2.2.9 Borrowing costs</strong></p>
    <p>Interest bearing borrowings are recognized initially at cost, net of attributable transaction costs. Subsequent to initial recognition, interest bearing borrowings are stated at amortized cost. Borrowing costs are charged to the income statement in the period in which it is incurred.</p>

    <p><strong>2.2.10 Taxation</strong></p>
    <p>Income tax is the expected tax payable on the taxable income for the year using tax rate at the balance sheet date and any adjustment to tax payable in respect of previous years.</p>

    <p><strong>2.2.11 Trade and other payables</strong></p>
    <p>Trade and other payables are stated at their cost.</p>

    <p><strong>2.2.12 Income</strong></p>
    <p><em>Revenue</em></p>
    <p>Revenue for the sale of goods or services is recognized when the company has transferred the significant risks and rewards of ownership to the buyer and it is probable that the company will receive the previously agreed upon payment.</p>
    <p><em>Interest income</em></p>
    <p>Interest income are recognized in the statement of income using the effective interest method.</p>
    <p><em>Dividend income</em></p>
    <p>Dividend income is recognized in the income statement when the right to receive payment is established.</p>

    <p><strong>2.2.13 Expenses</strong></p>
    <p><em>Operating lease payments</em></p>
    <p>Payments made under operating lease are recognized in the income statement on a straight-line basis over the term of the lease.</p>
    <p><em>Interest</em></p>
    <p>Interest expenses are recognized in the statement of income using accrual method.</p>

    <h3 class="rep-sec">B. Notes to Accounts</h3>
    ${ntaRenderNotesSection(s, e)}
  </div>`;

  $nta('nta-previewRoot').innerHTML = html;
}

// ════════════════════════════════════════════
//  Edit / Preview view switching (mirrors report.js's repSetView).
//  The document is only rendered on demand — opening Preview, or exporting —
//  so the default view is a wide editing form, not a constant preview.
// ════════════════════════════════════════════
function ntaIsPreviewOpen(){
  const pv = $nta('nta-preview-view');
  return pv && !pv.hidden;
}
function ntaRefresh(){
  if (ntaIsPreviewOpen()) renderNtaReport();
}
function ntaSetView(mode){
  const preview = mode === 'preview';
  const pv = $nta('nta-preview-view');
  // Render only when entering preview from edit — not when already in preview —
  // so hand-edits to the contenteditable sheet aren't wiped by a re-render.
  if (preview && pv.hidden) renderNtaReport();
  $nta('nta-edit-view').hidden = preview;
  pv.hidden = !preview;
  $nta('nta-tab-edit').classList.toggle('active', !preview);
  $nta('nta-tab-preview').classList.toggle('active', preview);
}
// Before exporting: if on the edit view the preview may be empty/stale, so
// render fresh; if already in preview keep the DOM (manual edits survive).
function ntaEnsureRendered(){
  if (!ntaIsPreviewOpen()) renderNtaReport();
}

window.addEventListener('load', () => {
  // Pre-fill the PPE table with the standard default rows.
  (window.NTA_PPE_DEFAULTS || []).forEach(r => ntaAddPpeRow(r.type, r.life));

  $nta('nta-toggleRelatedParty').addEventListener('change', ntaToggleRelatedParty);
  $nta('nta-toggleExtraNotes').addEventListener('change', ntaToggleExtraNotes);

  // Delegated watcher covers every field including the dynamically-added PPE /
  // Related Party row inputs — re-renders only while Preview is open.
  const editView = $nta('nta-edit-view');
  editView.addEventListener('input', ntaRefresh);
  editView.addEventListener('change', ntaRefresh);

  // Programmatic assignment (ntaApplyState) fires no change event, so
  // restoring a saved set can't trip this.
  $nta('nta-fy').addEventListener('change', ntaForgetSavedId);
});

// ════════════════════════════════════════════
//  Export — Save as PDF/Print (print window) + Save as Word (html-docx-js),
//  identical mechanism to report.js's printAuditReport / saveRepAsWord.
// ════════════════════════════════════════════
function buildNtaPrintableDoc(){
  const inner = $nta('nta-previewRoot').innerHTML;
  const allCss = Array.from(document.styleSheets).map(sheet => {
    try { return Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); }
    catch(e){ return ''; }
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Notes to Accounts</title><style>
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

function printNta(){
  ntaEnsureRendered();
  const blob = new Blob([buildNtaPrintableDoc()], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win){
    alert('Pop-up blocked — please allow pop-ups for this site, then click Save as PDF / Print again.');
  }
}

// Same .rep-* / .nta-* CSS the on-screen preview uses, with the CSS custom
// properties resolved to concrete values (Word can't read var()).
function getNtaExportCss(){
  const sheetEl = document.querySelector('#nta-previewRoot .rep-sheet');
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
    try { rules = sheet.cssRules; } catch(e){ continue; }
    for (const r of rules){
      if (r.selectorText && /\.rep|\.rname|\.nta/.test(r.selectorText)) css += r.cssText + '\n';
    }
  }
  Object.entries(vars).forEach(([k, v]) => { css = css.split('var(' + k + ')').join(v); });
  css = css.replace(/var\([^)]+\)/g, '');
  return css;
}

function buildNtaWordHtml(){
  const inner = $nta('nta-previewRoot').innerHTML;
  const css = getNtaExportCss();
  return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Notes to Accounts</title><style>" +
    "body{ margin:0; font-family:'Georgia','Times New Roman',serif; color:#111; font-size:12.5px; line-height:1.28; }" +
    css +
    ".rep-sheet{ box-shadow:none; border:none; padding:0; max-width:none; }" +
    "</style></head><body>" + inner + "</body></html>";
}

// ════════════════════════════════════════════
//  PERSISTENCE — saved_documents via DocumentStore (js/core/documentStore.js).
//  Same contract as report.js: the form state makes a saved set re-editable,
//  the rendered document makes it reprintable exactly as issued. The two row
//  editors (PPE useful life, Related Party) and the additional notes are part
//  of the state, so a restored set comes back with its rows intact.
// ════════════════════════════════════════════
let ntaSavedId = null;

const NTA_FIELDS = ['nta-entityName','nta-entityType','nta-entityAddress','nta-entityPan','nta-place',
  'nta-businessNature','nta-fy','nta-standard','nta-depMethod','nta-toggleRelatedParty','nta-toggleExtraNotes'];

function ntaStatus(html, type){ showStatus(html, type, 'nta-status'); }

function ntaFormState(){
  const state = { rows: { ppe: ntaGetPpeRows(), rp: ntaGetRpRows(), extra: ntaGetExtraRows() } };
  NTA_FIELDS.forEach(id => {
    const el = $nta(id);
    if (!el) return;
    state[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return state;
}

function ntaApplyState(state){
  NTA_FIELDS.forEach(id => {
    const el = $nta(id);
    if (!el) return;
    const v = state ? state[id] : undefined;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v == null ? '' : v;
  });
  // Row editors are rebuilt from scratch — clearing FIRST is what stops the
  // previous set's rows surviving into a restored one that has none (§9).
  const rows = (state && state.rows) || {};
  $nta('nta-ppe-rows').innerHTML = '';
  $nta('nta-rp-rows').innerHTML = '';
  $nta('nta-extra-rows').innerHTML = '';
  (rows.ppe || []).forEach(r => ntaAddPpeRow(r.type, r.life));
  (rows.rp || []).forEach(r => ntaAddRpRow(r.party, r.amount, r.type, r.relation));
  (rows.extra || []).forEach(r => ntaAddExtraRow(r.kind, r.text));
  $nta('nta-rp-editor').hidden = !$nta('nta-toggleRelatedParty').checked;
  $nta('nta-extra-editor').hidden = !$nta('nta-toggleExtraNotes').checked;
}

async function ntaSaveToDb(){
  ntaEnsureRendered();
  const clientName = $nta('nta-entityName').value.trim();
  if (!clientName){ ntaStatus('Enter a client name before saving.', 'error'); return; }
  const matched = (window.clientsList || []).find(c => (c.name || '').trim() === clientName);
  try {
    ntaStatus('Saving notes…', 'searching');
    ntaSavedId = await DocumentStore.save(ntaSavedId, {
      module: 'notesToAccounts',
      client_id: matched ? matched.id : null,
      client_name: clientName,
      pan: $nta('nta-entityPan').value.trim() || null,
      fiscal_year: $nta('nta-fy').value,
      doc_type: $nta('nta-standard').value,
      title: `Notes to Accounts — ${clientName} (F.Y. ${$nta('nta-fy').value})`,
      state: ntaFormState(),
      doc_html: $nta('nta-previewRoot').innerHTML,
    });
    ntaStatus(`Notes saved (record #${ntaSavedId}). Reopen them any time from <strong>Saved notes</strong>.`, 'success');
    AuditLog.record('notes_to_accounts_saved', { module: 'notesToAccounts', clientName, status: 'success', recordRef: ntaSavedId });
  } catch (e){
    console.error(e);
    ntaStatus('Save failed: ' + escHtml(e.message), 'error');
  }
}

function ntaOpenSaved(){
  DocumentStore.openPicker({
    module: 'notesToAccounts',
    label: 'Saved notes to accounts',
    onOpen: row => {
      ntaApplyState(row.state);
      ntaSavedId = row.id;
      if (row.doc_html) $nta('nta-previewRoot').innerHTML = row.doc_html;
      else renderNtaReport();
      ntaSetViewRestored();
      ntaStatus(`Opened saved notes #${row.id}. Editing the form re-renders them; Save to database updates the same record.`, 'info');
    },
  });
}

// Show Preview without re-rendering — ntaSetView('preview') renders on entry
// and would overwrite the document just restored.
function ntaSetViewRestored(){
  $nta('nta-edit-view').hidden = true;
  $nta('nta-preview-view').hidden = false;
  $nta('nta-tab-edit').classList.remove('active');
  $nta('nta-tab-preview').classList.add('active');
}

// Client + fiscal year are the document's identity — see the same note in
// report.js. Changing either means the next save creates a new record.
function ntaForgetSavedId(){ ntaSavedId = null; }

function saveNtaAsWord(){
  ntaEnsureRendered();
  const html = buildNtaWordHtml();
  const clientName = $nta('nta-entityName').value.trim() || 'Notes to Accounts';
  const base = ('Notes to Accounts - ' + clientName).replace(/[\\/:*?"<>|]/g, '_');

  if (window.htmlDocx && typeof window.htmlDocx.asBlob === 'function'){
    const blob = window.htmlDocx.asBlob(html, { margins: { top: 680, bottom: 680, left: 907, right: 907 } });
    DocumentEngine.downloadBlob(blob, base + '.docx', { module: 'notesToAccounts', clientName });
    return;
  }
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  DocumentEngine.downloadBlob(blob, base + '.doc', { module: 'notesToAccounts', clientName });
}
