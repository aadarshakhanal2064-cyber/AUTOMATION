// ════════════════════════════════════════════
//  AUDIT REPORT GENERATOR (integrated tab)
//  Namespaced with "rep" / "Rep" prefixes throughout to avoid
//  any collision with the Send/Clients/Logs code above.
// ════════════════════════════════════════════

function $rep(id){ return document.getElementById(id); }

// Reuses the SAME clientsList already loaded from Supabase by the existing app
// (populated in loadClients()), so client search here matches the Clients tab exactly.
function selectRepClient(c){
  $rep('rep-entityName').value = c.name || '';
  $rep('rep-entityAddress').value = c.address || '';
  $rep('rep-entityPan').value = c.pan || '';

  const mapped = window.CLIENT_ENTITY_TO_REP_PROFILE[(c.entity_type || '').trim().toLowerCase()];
  if (mapped) $rep('rep-entityType').value = mapped;

  renderRepAll();
}

SearchEngine.attachAutocomplete($rep('rep-entityName'), $rep('rep-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['name', 'email', 'pan'],
  renderItem: c => `
    <div class="ac-name">${escHtml(c.name)}</div>
    <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectRepClient,
});

SearchEngine.attachAutocomplete($rep('rep-entityPan'), $rep('rep-pan-autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['pan'],
  minChars: 2,
  renderItem: c => `
    <div class="ac-name">${escHtml(c.pan)}</div>
    <div class="ac-email">${escHtml(c.name)}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
  `,
  onSelect: selectRepClient,
});

function getRepState(){
  return {
    firm: window.REP_FIRMS[$rep('rep-firm').value],
    // Only 'unqualified' has real wording today — the other 4 options are
    // disabled in the dropdown until their report bodies are built, so
    // renderRepReport() doesn't need to branch on this yet.
    reportType: $rep('rep-reportType').value,
    entityName: $rep('rep-entityName').value.trim() || "[ENTITY NAME]",
    entityType: window.REP_ENTITY_PROFILES[$rep('rep-entityType').value],
    entityAddress: $rep('rep-entityAddress').value.trim() || "[ADDRESS]",
    entityPan: $rep('rep-entityPan').value.trim() || "[PAN]",
    fy: window.REP_FY_DATES[$rep('rep-fy').value],
    reportDate: $rep('rep-reportDate').value.trim() || "[DATE]",
    reportPlace: $rep('rep-reportPlace').value.trim() || "[PLACE]",
    udin: $rep('rep-udin').value.trim(),
    includeEOM: $rep('rep-toggleEOM').checked,
    includeKAM: $rep('rep-toggleKAM').checked
  };
}

// Matches the firm's own filed cover-page layout: bordered frame, title
// block up top, a large blank gap with three decorative rules, then the
// "Audited By" block — rather than the earlier certificate-stamp design.
function renderRepCoverPage(s){
  const f = s.firm;
  return `
  <div class="rep-sheet rep-cover" contenteditable="true" spellcheck="false">
    <div class="rep-cover-frame">
      <div class="rep-cover-title">Audit Report</div>
      <div class="rep-cover-of">Of</div>
      <div class="rep-cover-entity">${s.entityName}</div>
      <div class="rep-cover-address">${s.entityAddress}</div>
      <div class="rep-cover-fy">For the Year Ending ${s.fy.bs}</div>

      <div class="rep-cover-lines" aria-hidden="true">
        <span class="rep-cover-line rep-cover-line--sm"></span>
        <span class="rep-cover-line rep-cover-line--lg"></span>
        <span class="rep-cover-line rep-cover-line--md"></span>
      </div>

      <div class="rep-cover-auditedby">Audited By:</div>
      <div class="rep-cover-firm">${f.name}</div>
      <div class="rep-cover-firmtitle">${f.title}</div>
    </div>
  </div>`;
}

// Resolves an asset's own relative path to an absolute URL — needed because
// printAuditReport() opens the report in a separate blob: document, where a
// plain relative "assets/logo-lockup.png" src won't resolve against the app's origin.
function repAssetUrl(path){
  return new URL(path, document.baseURI).href;
}

function renderRepFirmHeader(f){
  // Firms with a letterhead logo (a lockup of the firm name + title) show the
  // image in place of those two text lines; firms without one keep plain text.
  const identity = f.logo
    ? `<img class="rep-header-logo" src="${repAssetUrl(f.logo)}" alt="${f.name} - ${f.title}" onerror="this.outerHTML='<div class=&quot;rfname&quot;>${f.name}</div><div class=&quot;rftitle&quot;>${f.title}</div>'">`
    : `<div class="rfname">${f.name}</div><div class="rftitle">${f.title}</div>`;

  return `
    <div class="rep-firm-header">
      ${identity}
      <div class="rfaddr">${f.address}</div>
    </div>
    <div class="rep-contact-row">
      <div class="rep-contact-col">
        <p>Email:- ${f.email}</p>
        <p>Phone no:- ${f.phone}</p>
        <p>Firm Registration No. ${f.regNo}</p>
      </div>
      <div class="rep-contact-col">
        <p>M.No. ${f.mNo}</p>
        <p>PAN:- ${f.pan}</p>
        <p>COP No. ${f.copNo}</p>
      </div>
    </div>`;
}

function renderRepSigBlock(s, f){
  return `
    <div class="rep-sig-block">
      <div class="rep-sig-left">
        <p>Date: ${s.reportDate}</p>
        <p>Place: ${s.reportPlace}</p>
        ${s.udin ? `<p class="rep-udin">UDIN: ${s.udin}</p>` : `<p class="rep-udin">UDIN:</p>`}
      </div>
      <div class="rep-sig-right">
        <p>${f.name}</p>
        <p>Firm Registration No. ${f.regNo}</p>
        <p>${f.title}</p>
        <p class="rname">${f.signatoryName}</p>
        <p>${f.signatoryTitle}</p>
        <p>M.No. ${f.mNo}</p>
        <p>PAN:- ${f.pan}</p>
        <p>COP No. ${f.copNo}</p>
      </div>
    </div>`;
}

function renderRepFyDate(){
  const d = window.REP_FY_DATES[$rep('rep-fy').value];
  $rep('rep-fyDateDisplay').innerHTML = `Financial position as at <strong>${d.bs}</strong> (<strong>${d.ad}</strong>)`;
}

function renderRepReport(){
  const s = getRepState();
  const f = s.firm;
  const e = s.entityType;

  const n1 = "1.1";
  // Key Audit Matters (1.2) now always renders — the checkbox only toggles
  // the details table below it — so the following section numbers are fixed.
  const nKAM = "1.2";
  const n2 = "1.3";
  const n3 = "1.4";
  const n4 = "1.5";

  const html = `
  ${renderRepCoverPage(s)}

  <div class="rep-sheet" contenteditable="true" spellcheck="false">
    ${renderRepFirmHeader(f)}

    <div class="rep-title">Independent Auditor's Report</div>
    <p class="rep-salutation">To ${e.salutationTo} <strong>${s.entityName}</strong></p>

    <h3 class="rep-sec"><span class="rep-section-num">${n1}</span> Report on the Audit of Financial Statement:</h3>
    <p><strong>Opinion:</strong></p>
    <p>We have audited the accompanying financial statements of ${s.entityName}, which comprises the Statement of Financial Position as at ${s.fy.bs} (${s.fy.ad}) and the Statement of Income for the year then ended, Statements of Change in Equity and Statement of Cash Flow and a Summary of Significant Accounting Policies and Other Explanatory Information.</p>
    <p>In our opinion, the accompanying financial statements present fairly in material respect. The financial position of the ${e.entityNoun} as at ${s.fy.bs} (${s.fy.ad}), its financial performance and its cash flows for the year then ended has been prepared in accordance with Nepal Accounting Standard.</p>

    <p><strong>Basis of Opinion:</strong></p>
    <p>We conducted our audit in accordance with Nepal Standards on Auditing (NSAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${e.entityNoun} in according to ICAN's Handbook of Code of Ethics for Professional Accountants. We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our opinion.</p>

    ${s.includeEOM ? `
    <div class="rep-optional-block">
      <p><strong>Emphasis of Matter:</strong></p>
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Type the Emphasis of Matter paragraph here&hellip;"></div>
    </div>` : ``}

    <div class="rep-optional-block">
      <h3 class="rep-sec"><span class="rep-section-num">${nKAM}</span> Key Audit Matters:</h3>
      <p contenteditable="true">Key audit matters are those matters that, in our professional judgment, were of most significance in our audit of the financial statements of the current period. These matters were addressed in the context of our audit of the financial statements as a whole, and in forming our opinion thereon, and we do not provide a separate opinion on these matters. We have determined that, there are no other key audit matters to communicate in our report.</p>
      ${s.includeKAM ? `
      <table class="rep-kam-table">
        <tr>
          <th style="width:6%">S.N.</th>
          <th style="width:44%">Details of Key Audit Matters</th>
          <th style="width:50%">How the matters were addressed in our audit</th>
        </tr>
        <tr>
          <td class="rep-sn-col">1</td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Heading + reference note&hellip;"></td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Audit procedures&hellip;"></td>
        </tr>
        <tr>
          <td class="rep-sn-col"></td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Description of the matter&hellip;"></td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="How addressed&hellip;"></td>
        </tr>
      </table>` : ``}
    </div>

    <h3 class="rep-sec"><span class="rep-section-num">${n2}</span> Responsibilities of the Management and Those Charged with Governance for the Financial Statements:</h3>
    <p>The ${e.entityNounCap}'s management is responsible for the preparation and fair presentation of these financial statements in accordance with Nepal Accounting Standard and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatements, whether due to fraud or error.</p>
    <p>In preparing the financial statements, management is responsible for assessing the ${e.entityNoun}'s ability to continue as going concern, disclosing, as applicable, matters related to going concern basis of accounting unless management either intends to liquidate the ${e.entityNoun} or to cease operations, or has no realistic alternative but to do to so. Those charged with governance are responsible for overseeing the ${e.entityNoun}'s financial reporting process.</p>

    <h3 class="rep-sec"><span class="rep-section-num">${n3}</span> Auditor's Responsibility for Audit of the Financial Statements:</h3>
    <p>Our objective is to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatements, whether due to fraud or error, and to issue an Auditor's Report that includes our opinion. Reasonable assurance is high level of assurance; but is not guarantee that an audit conducted in accordance with Nepal Standards on Auditing (NSAs) will always detect a material misstatements when it exists. Misstatements can arise from fraud or error, and are considered material if, individually or taken together, they could reasonably be expected to influence the economic decisions of users taken on the basis these financial statements.</p>
    <p>As part of an audit in accordance with Nepal Standards on Auditing (NSAs), we exercise professional judgement and maintain professional scepticism throughout the audit. We also;</p>
    <ul class="rep-audit-points">
      <li>Identify and assess the risk of material misstatements of the financial statements, whether due to fraud or error, design and perform audit procedures responsive to those risks, and obtain audit evidence that is sufficient and appropriate to provide a basis for our opinion. The risk of not detecting a material misstatement resulting from fraud is higher that for one resulting from error, as fraud may involve collusion, forgery, intentional omissions, misrepresentations, or override of internal control.</li>
      <li>Obtain an understanding of internal control relevant to the audit in order to design audit procedures that are appropriate in the circumstances, but not for expressing an opinion on the effectiveness of the ${e.entityNoun}'s internal control.</li>
      <li>Evaluate the appropriateness of accounting policies used and the reasonableness of accounting estimates and related disclosure made by the management.</li>
      <li>Conclude on the appropriateness of management's use of the going concern basis of accounting and, based on the audit evidence obtained, whether a material uncertainty exists, we are required to draw attention in our auditor's report to the related disclosures in the financial statements, or if such disclosures are inadequate, to modify our opinion. Our conclusions are based on the audit evidence obtained up to date of our auditor's report. However, further events or conditions may cause the ${e.entityNoun} to cease to continue as a going concern.</li>
    </ul>
    <p>We communicate with Those Charged with Governance regarding among other matters, the planned scope and timing of the audit and significant audit finding including any significant deficiencies in internal control that are identify during our audit.</p>

    <h3 class="rep-sec"><span class="rep-section-num">${n4}</span> Report on Other Legal and Regulatory Requirements:</h3>
    <p>We have obtained information and explanation asked for, which, to the best of our knowledge and belief, were necessary for the purpose of our audit. In our opinion, Statement of Financial Position, Statement of Income, Statement of Change in Equity and Statement of Cash Flows, have been prepared in accordance with the requirement of ${e.act} and are in agreement with the books of accounts maintained by the ${e.entityNoun} and proper books of account as required by the law maintained by the ${e.entityNoun} have been kept so far as it appears form our examination of those books and records of the ${e.entityNoun}.</p>
    <p>In our opinion, so far as it appeared from our examination of the books, the ${e.entityNoun} has maintained adequate capital funds and adequate provisions for possible impairment of assets in accordance with the applicable laws.</p>
    <p>To the best of our information and according to explanation given to us and so far spread from our examination of the books of accounts of the ${e.entityNoun}, we have not come across cases where ${e.governingBodyShort} or any employee of the ${e.entityNoun} have acted contrary to the provisions of the laws relating to accounts, or committed any misappropriation or caused loss or damage to the ${e.entityNoun} and violated any directives issued by the regulatory authorities or acted in a manner to jeopardise the interest and security of the ${e.entityNoun}, its creditors and ${e.entityNoun === 'company' ? 'shareholders' : 'stakeholders'}.</p>

    ${renderRepSigBlock(s, f)}
  </div>
  `;

  $rep('rep-previewRoot').innerHTML = html;
}

function renderRepAll(){
  renderRepFyDate();
  renderRepReport();
}

// Need to run initialization logic on window load to ensure DOM is ready
window.addEventListener('load', () => {
  ['rep-firm','rep-reportType','rep-entityName','rep-entityType','rep-entityAddress','rep-entityPan',
   'rep-fy','rep-reportDate','rep-reportPlace','rep-udin','rep-toggleEOM','rep-toggleKAM'].forEach(id=>{
    const el = document.getElementById(id);
    if (el){
      el.addEventListener('input', renderRepAll);
      el.addEventListener('change', renderRepAll);
    }
  });

  renderRepAll();
});

function buildRepPrintableDoc(){
  const reportHTML = document.getElementById('rep-previewRoot').innerHTML;
  // Pull only the .rep- prefixed CSS rules so the standalone print tab is self-contained
  const allCss = Array.from(document.styleSheets).map(sheet => {
    try { return Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); }
    catch(e){ return ''; }
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Audit Report</title><style>
    body{ margin:0; background:#fff; font-family:Arial,sans-serif; padding:24px; }
    ${allCss}
    /* Single source of truth for the printed page's physical margins — the
       .rep-sheet padding below is screen-only so the two never stack. */
    @page{ size:A4; margin: 12mm 16mm; }
    @media print{
      body{ padding:0; }
      .rep-sheet{ box-shadow:none; border:none; padding:0; max-width:none; page-break-after:always; }
      .rep-sheet:last-child{ page-break-after:auto; }
    }
  </style></head><body>${reportHTML}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
}

function printAuditReport(){
  const docContent = buildRepPrintableDoc();
  const blob = new Blob([docContent], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win){
    alert('Pop-up blocked — please allow pop-ups for this site, then click Print again.');
  }
}
