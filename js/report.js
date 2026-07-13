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

  repRefresh();
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
    includeKAM: $rep('rep-toggleKAM').checked,
    includeBasisExample: $rep('rep-toggleBasisExample').checked,
    // Inline writing boxes (shown under each ticked Include checkbox) — their
    // text flows into the report's corresponding fill-in blanks on render.
    eomText: $rep('rep-eomText').value.trim(),
    kamHeading: $rep('rep-kamHeading').value.trim(),
    kamProcedures: $rep('rep-kamProcedures').value.trim(),
    kamDescription: $rep('rep-kamDescription').value.trim(),
    kamAddressed: $rep('rep-kamAddressed').value.trim(),
    basisText: $rep('rep-basisText').value.trim()
  };
}

// Form-textarea text -> report HTML: escaped, with line breaks preserved.
// Empty text stays empty so the .rep-blank-fill :empty placeholder shows.
function repMultiline(text){
  return escHtml(text).replace(/\n/g, '<br>');
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

// assets/logo-lockup.png has a lot of blank transparent space baked in
// above/below the actual lockup content, so at the letterhead's rendered
// width it reads as a big gap before the firm name/address start. Crop it
// down client-side to just the visible content (same-origin canvas draw, no
// CORS taint) rather than re-exporting the source file.
function cropReportLetterheadLogo(img){
  img.onload = null; // clear first: setting img.src below re-fires 'load'
  const sx = 130, sy = 255, sw = 1640, sh = 355;
  const scale = 2; // render 2x for crisp display/print
  const canvas = document.createElement('canvas');
  canvas.width = sw * scale;
  canvas.height = sh * scale;
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  img.src = canvas.toDataURL('image/png');
}

function renderRepFirmHeader(f){
  // Firms with a letterhead logo (a lockup of the firm name + title) show the
  // image in place of those two text lines; firms without one keep plain text.
  const identity = f.logo
    ? `<img class="rep-header-logo" src="${repAssetUrl(f.logo)}" alt="${f.name} - ${f.title}" onerror="this.outerHTML='<div class=&quot;rfname&quot;>${f.name}</div><div class=&quot;rftitle&quot;>${f.title}</div>'" onload="cropReportLetterheadLogo(this)">`
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

// Orchestrator: the cover page, letterhead, title, salutation and signature
// block are identical for every report type — only the numbered body sections
// (1.1 onward) differ, so each type supplies its own body renderer.
function renderRepReport(){
  const s = getRepState();
  const f = s.firm;
  const e = s.entityType;

  const bodyRenderers = {
    unqualified: renderRepBodyUnqualified,
    adverse:     renderRepBodyAdverse,
    disclaimer:  renderRepBodyDisclaimer,
    qualified:   renderRepBodyQualified,
    review:      renderRepBodyReview,
  };
  const renderBody = bodyRenderers[s.reportType] || renderRepBodyUnqualified;

  const html = `
  ${renderRepCoverPage(s)}

  <div class="rep-sheet" contenteditable="true" spellcheck="false">
    ${renderRepFirmHeader(f)}

    <div class="rep-title">${s.reportType === 'review' ? 'Report on the Financial Statement' : "Independent Auditor's Report"}</div>
    <p class="rep-salutation">To ${e.salutationTo} <strong>${s.entityName}</strong></p>

    ${renderBody(s, e)}

    ${renderRepSigBlock(s, f)}
  </div>
  `;

  $rep('rep-previewRoot').innerHTML = html;
}

function renderRepBodyUnqualified(s, e){
  const n1 = "1.1";
  // Key Audit Matters (1.2) now always renders — the checkbox only toggles
  // the details table below it — so the following section numbers are fixed.
  const nKAM = "1.2";
  const n2 = "1.3";
  const n3 = "1.4";
  const n4 = "1.5";

  return `
    <h3 class="rep-sec"><span class="rep-section-num">${n1}</span> Report on the Audit of Financial Statement:</h3>
    <p><strong>Opinion:</strong></p>
    <p>We have audited the accompanying financial statements of ${s.entityName}, which comprises the Statement of Financial Position as at ${s.fy.bs} (${s.fy.ad}) and the Statement of Income for the year then ended, Statements of Change in Equity and Statement of Cash Flow and a Summary of Significant Accounting Policies and Other Explanatory Information.</p>
    <p>In our opinion, the accompanying financial statements present fairly in material respect. The financial position of the ${e.entityNoun} as at ${s.fy.bs} (${s.fy.ad}), its financial performance and its cash flows for the year then ended has been prepared in accordance with Nepal Accounting Standard.</p>

    <p><strong>Basis of Opinion:</strong></p>
    <p>We conducted our audit in accordance with Nepal Standards on Auditing (NSAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${e.entityNoun} in according to ICAN's Handbook of Code of Ethics for Professional Accountants. We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our opinion.</p>

    ${s.includeEOM ? `
    <div class="rep-optional-block">
      <p><strong>Emphasis of Matter:</strong></p>
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Type the Emphasis of Matter paragraph here&hellip;">${repMultiline(s.eomText)}</div>
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
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Heading + reference note&hellip;">${repMultiline(s.kamHeading)}</td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Audit procedures&hellip;">${repMultiline(s.kamProcedures)}</td>
        </tr>
        <tr>
          <td class="rep-sn-col"></td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="Description of the matter&hellip;">${repMultiline(s.kamDescription)}</td>
          <td class="rep-blank-fill" contenteditable="true" data-placeholder="How addressed&hellip;">${repMultiline(s.kamAddressed)}</td>
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
    <p>We have obtained information and explanation asked for, which, to the best of our knowledge and belief, were necessary for the purpose of our audit. In our opinion, Statement of Financial Position, Statement of Income, Statement of Change in Equity and Statement of Cash Flows, have been prepared in accordance with the requirement of ${e.citeSpecificAct ? e.act : 'the applicable law'} and are in agreement with the books of accounts maintained by the ${e.entityNoun} and proper books of account as required by the law maintained by the ${e.entityNoun} have been kept so far as it appears form our examination of those books and records of the ${e.entityNoun}.</p>
    <p>In our opinion, so far as it appeared from our examination of the books, the ${e.entityNoun} has maintained adequate capital funds and adequate provisions for possible impairment of assets in accordance with the applicable laws.</p>
    <p>To the best of our information and according to explanation given to us and so far observed from our examination of the books of accounts of the ${e.entityNoun}, we have not come across cases where ${e.governingBodyShort} or any employee of the ${e.entityNoun} have acted contrary to the provisions of the laws relating to accounts, or committed any misappropriation or caused loss or damage to the ${e.entityNoun} and violated any directives issued by the regulatory authorities or acted in a manner to jeopardise the interest and security of the ${e.entityNoun}, its creditors and ${e.entityNoun === 'company' ? 'shareholders' : 'stakeholders'}.</p>`;
}

// Adverse Opinion and Disclaimer of Opinion have no Key Audit Matters slot, so
// their sections are numbered straight through 1.1–1.4. Both reproduce the
// firm's own draft wording; the "Basis" paragraph is a genuinely empty
// contenteditable block (shown only when its checkbox is ticked, same
// .rep-blank-fill + data-placeholder mechanism Unqualified's EOM uses) — never
// pre-filled with sample text, since the auditor writes the real finding.
function renderRepBodyAdverse(s, e){
  const act = e.citeSpecificAct ? e.act : 'the applicable law';
  return `
    <h3 class="rep-sec"><span class="rep-section-num">1.1</span> Report on the Audit of Financial Statement:</h3>
    <p><strong>Adverse Opinion:</strong></p>
    <p>We have audited the accompanying financial statements of ${s.entityName}, which comprise the Statement of Financial Position as at ${s.fy.bs} (${s.fy.ad}), the Statement of Income, Statement of Changes in Equity and Statement of Cash Flows for the year then ended, and a summary of significant accounting policies and other explanatory information.</p>
    <p>In our opinion, because of the significance and pervasiveness of the matters described in the Basis for Adverse Opinion section of our report, the accompanying financial statements do not present fairly the financial position of the ${e.entityNounCap} as at ${s.fy.bs} (${s.fy.ad}), nor its financial performance and cash flows for the year then ended in accordance with Nepal Accounting Standards.</p>

    <p><strong>Basis of Adverse Opinion:</strong></p>
    ${s.includeBasisExample ? `
    <div class="rep-optional-block">
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Describe the matter(s) causing the financial statements not to present fairly, and why their effect is both material and pervasive…">${repMultiline(s.basisText)}</div>
    </div>` : ``}
    <p>We conducted our audit in accordance with Nepal Standards on Auditing (NSAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${e.entityNoun} in accordance with the ICAN Handbook of Code of Ethics for Professional Accountants and have fulfilled our other ethical responsibilities in accordance with these requirements.</p>
    <p>We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our Adverse opinion.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.2</span> Responsibilities of the Management and Those Charged with Governance for the Financial Statements:</h3>
    <p>The ${e.entityNounCap}'s management is responsible for the preparation and fair presentation of these financial statements in accordance with Nepal Accounting Standards and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatements, whether due to fraud or error.</p>
    <p>In preparing the financial statements, management is responsible for assessing the ${e.entityNoun}'s ability to continue as going concern, disclosing, as applicable, matters related to going concern basis of accounting unless management either intends to liquidate the ${e.entityNoun} or to cease operations, or has no realistic alternative but to do to so. Those charged with governance are responsible for overseeing the ${e.entityNoun}'s financial reporting process.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.3</span> Auditor's Responsibility for Audit of the Financial Statements:</h3>
    <p>Our objective is to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatements, whether due to fraud or error, and to issue an Auditor's Report that includes our opinion. Reasonable assurance is high level of assurance; but is not guarantee that an audit conducted in accordance with Nepal Accounting Standard will always detect a material misstatements when it exists. Misstatements can arise from fraud or error, and are considered material if, individually or taken together, they could reasonably be expected to influence the economic decisions of users taken on the basis these financial statements.</p>
    <p>As part of the audit accordance with NAS, we exercise professional judgement and maintain professional scepticism throughout the audit. We also;</p>
    <ul class="rep-audit-points">
      <li>Identify and assess the risk of material misstatements of the financial statements, whether due to fraud or error, design and perform audit procedures responsive to those risks, and obtain audit evidence that is sufficient and appropriate to provide a basis for our opinion. The risk of not detecting a material misstatement resulting from fraud is higher that for one resulting from error, as fraud may involve collusion, forgery, intentional omissions, misrepresentations, or override of internal control.</li>
      <li>Obtain an understanding of internal control relevant to the audit in order to design audit procedures that are appropriate in the circumstances, but not for expressing an opinion on the effectiveness of the ${e.entityNoun}'s internal control.</li>
      <li>Evaluate the appropriateness of accounting policies used and the reasonableness of accounting estimates and related disclosure made by the management.</li>
      <li>Conclude on the appropriateness of management's use of the going concern basis of accounting and, based on the audit evidence obtained, whether a material uncertainty exists, we are required to draw attention in our auditor's report to the related disclosures in the financial statements, or if such disclosures are inadequate, to modify our opinion. Our conclusions are based on the audit evidence obtained up to date of our auditor's report. However, further events or conditions may cause the ${e.entityNoun} to cease to continue as a going concern.</li>
    </ul>
    <p>We communicate with Those Charged with Governance regarding among other matters, the planned scope and timing of the audit and significant audit finding including any significant deficiencies in internal control that are identify during our audit.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.4</span> Report on Other Legal and Regulatory Requirements:</h3>
    <p>We have obtained all information and explanations which, to the best of our knowledge and belief, were necessary for the purposes of our audit.</p>
    <p>However, because of the matters described in the Basis for Adverse Opinion section of our report, the financial statements have not been prepared in accordance with the requirements of Nepal Accounting Standards and do not appropriately reflect the financial position, financial performance and cash flows of the ${e.entityNounCap}.</p>
    <p>Furthermore, due to the material and pervasive effects of the matters described above:</p>
    <ul class="rep-audit-points">
      <li>The financial statements are not fully compliant with the financial reporting requirements of the ${act}.</li>
      <li>The Statement of Financial Position, Statement of Income, Statement of Changes in Equity and Statement of Cash Flows contain material misstatements.</li>
      <li>Assets, liabilities, income, expenses and equity are materially misstated.</li>
      <li>Users of the financial statements should not rely on the financial statements without considering the matters described in the Basis for Adverse Opinion section.</li>
    </ul>
    <p>To the best of our knowledge and based on the audit evidence obtained, except for the matters giving rise to the adverse opinion, we have not identified any material instances of fraud or misappropriation by management or employees that require separate reporting under applicable laws and regulations.</p>`;
}

function renderRepBodyDisclaimer(s, e){
  const act = e.citeSpecificAct ? e.act : 'the applicable law';
  return `
    <h3 class="rep-sec"><span class="rep-section-num">1.1</span> Report on the Audit of Financial Statement:</h3>
    <p><strong>Disclaimer of Opinion:</strong></p>
    <p>We were engaged to audit the accompanying financial statements of ${s.entityName}, which comprise the Statement of Financial Position as at ${s.fy.bs} (${s.fy.ad}), the Statement of Income, Statement of Changes in Equity and Statement of Cash Flows for the year then ended, and a summary of significant accounting policies and other explanatory information.</p>
    <p>Because of the significance of the matters described in the Basis for Disclaimer of Opinion section of our report, we have not been able to obtain sufficient appropriate audit evidence to provide a basis for an audit opinion on these financial statements. Accordingly, we do not express an opinion on the accompanying financial statements.</p>

    <p><strong>Basis for Disclaimer of Opinion:</strong></p>
    ${s.includeBasisExample ? `
    <div class="rep-optional-block">
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Describe why sufficient appropriate audit evidence could not be obtained — records unavailable, procedures unable to be performed, etc…">${repMultiline(s.basisText)}</div>
    </div>` : ``}
    <p>As a result, we were unable to perform alternative audit procedures to satisfy ourselves regarding the completeness, accuracy and existence of these balances and transactions. Consequently, we could not determine whether any adjustments might have been necessary in respect of the reported assets, liabilities, income, expenses, equity and related disclosures in the financial statements.</p>
    <p>We conducted our audit in accordance with Nepal Standards on Auditing (NSAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${e.entityNoun} in accordance with the ICAN Handbook of Code of Ethics for Professional Accountants and have fulfilled our other ethical responsibilities in accordance with these requirements.</p>
    <p>Because of the matters described above, we were unable to obtain sufficient appropriate audit evidence to provide a basis for an audit opinion on the financial statements.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.2</span> Responsibilities of the Management and Those Charged with Governance for the Financial Statements:</h3>
    <p>The ${e.entityNounCap}'s management is responsible for the preparation and fair presentation of these financial statements in accordance with Nepal Accounting Standards and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatements, whether due to fraud or error.</p>
    <p>In preparing the financial statements, management is responsible for assessing the ${e.entityNoun}'s ability to continue as going concern, disclosing, as applicable, matters related to going concern basis of accounting unless management either intends to liquidate the ${e.entityNoun} or to cease operations, or has no realistic alternative but to do to so. Those charged with governance are responsible for overseeing the ${e.entityNoun}'s financial reporting process.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.3</span> Auditor's Responsibility for Audit of the Financial Statements:</h3>
    <p>Our responsibility is to conduct an audit of the ${e.entityNoun}'s financial statements in accordance with Nepal Standards on Auditing and to issue an auditor's report. However, because of the matters described in the Basis for Disclaimer of Opinion section of our report, we were unable to obtain sufficient appropriate audit evidence to provide a basis for an audit opinion on these financial statements.</p>
    <p>We are independent of the ${e.entityNoun} in accordance with the ethical requirements relevant to our audit of the financial statements in Nepal and have fulfilled our other ethical responsibilities in accordance with these requirements.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.4</span> Report on Other Legal and Regulatory Requirements:</h3>
    <p>Because of the significance of the matters described in the Basis for Disclaimer of Opinion section, we were unable to obtain sufficient appropriate audit evidence regarding the accounting records and financial information of the ${e.entityNoun}. Accordingly, we are unable to determine whether:</p>
    <ul class="rep-audit-points">
      <li>Proper books of account as required by ${act} have been maintained by the ${e.entityNoun}.</li>
      <li>The Statement of Financial Position, Statement of Income, Statement of Changes in Equity and Statement of Cash Flows are in agreement with the books and records of the ${e.entityNoun}.</li>
      <li>Adequate provisions have been made for impairment of assets and other potential liabilities in accordance with applicable laws and accounting standards.</li>
      <li>Any instances of non-compliance with applicable laws and regulations, misappropriation of assets, fraud, or actions prejudicial to the interests of the ${e.entityNoun}, its creditors and ${e.entityNoun === 'company' ? 'shareholders' : 'stakeholders'} have occurred.</li>
    </ul>
    <p>Accordingly, we do not express an opinion on these matters.</p>`;
}

// Qualified Opinion — same 1.1-1.4 shape as Adverse/Disclaimer, no KAM slot.
// The source draft had a verbatim duplicated paragraph in 1.1 (fixed — kept
// once, not twice) and a couple of dropped-word/typo slips (fixed as hygiene,
// same category as Adverse/Disclaimer's fixes) — otherwise reproduces the
// firm's own wording as-is, including its own "Basis of X Opinion:" (heading)
// vs "Basis for X Opinion section" (inline reference) wording, matching the
// same pattern Adverse/Disclaimer already use.
function renderRepBodyQualified(s, e){
  const act = e.citeSpecificAct ? e.act : 'the applicable law';
  return `
    <h3 class="rep-sec"><span class="rep-section-num">1.1</span> Report on the Audit of Financial Statement:</h3>
    <p><strong>Qualified Opinion:</strong></p>
    <p>We have audited the accompanying financial statements of ${s.entityName}, which comprise the Statement of Financial Position as at ${s.fy.bs} (${s.fy.ad}), the Statement of Income, Statement of Changes in Equity and Statement of Cash Flows for the year then ended, and a summary of significant accounting policies and other explanatory information.</p>
    <p>In our opinion, except for the effects of the matter described in the Basis for Qualified Opinion section of our report, the accompanying financial statements present fairly, in all material respects, the financial position of the ${e.entityNounCap} as at ${s.fy.bs} (${s.fy.ad}), and its financial performance and cash flows for the year then ended in accordance with Nepal Accounting Standards.</p>

    <p><strong>Basis of Qualified Opinion:</strong></p>
    ${s.includeBasisExample ? `
    <div class="rep-optional-block">
      <div class="rep-blank-fill" contenteditable="true" data-placeholder="Describe the specific matter causing the qualification, its estimated financial effect, and why it is material but not pervasive…">${repMultiline(s.basisText)}</div>
    </div>` : ``}
    <p>We conducted our audit in accordance with Nepal Standards on Auditing (NSAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${e.entityNoun} in accordance with the ICAN Handbook of Code of Ethics for Professional Accountants and have fulfilled our other ethical responsibilities in accordance with these requirements.</p>
    <p>We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our qualified opinion.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.2</span> Responsibilities of the Management and Those Charged with Governance for the Financial Statements:</h3>
    <p>The ${e.entityNounCap}'s management is responsible for the preparation and fair presentation of these financial statements in accordance with Nepal Accounting Standards and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatements, whether due to fraud or error.</p>
    <p>In preparing the financial statements, management is responsible for assessing the ${e.entityNoun}'s ability to continue as going concern, disclosing, as applicable, matters related to going concern basis of accounting unless management either intends to liquidate the ${e.entityNoun} or to cease operations, or has no realistic alternative but to do to so. Those charged with governance are responsible for overseeing the ${e.entityNoun}'s financial reporting process.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.3</span> Auditor's Responsibility for Audit of the Financial Statements:</h3>
    <p>Our objective is to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatements, whether due to fraud or error, and to issue an Auditor's Report that includes our opinion. Reasonable assurance is high level of assurance; but is not guarantee that an audit conducted in accordance with Nepal Accounting Standard will always detect a material misstatements when it exists. Misstatements can arise from fraud or error, and are considered material if, individually or taken together, they could reasonably be expected to influence the economic decisions of users taken on the basis these financial statements.</p>
    <p>As part of the audit in accordance with NAS, we exercise professional judgement and maintain professional scepticism throughout the audit. We also;</p>
    <ul class="rep-audit-points">
      <li>Identify and assess the risk of material misstatements of the financial statements, whether due to fraud or error, design and perform audit procedures responsive to those risks, and obtain audit evidence that is sufficient and appropriate to provide a basis for our opinion. The risk of not detecting a material misstatement resulting from fraud is higher that for one resulting from error, as fraud may involve collusion, forgery, intentional omissions, misrepresentations, or override of internal control.</li>
      <li>Obtain an understanding of internal control relevant to the audit in order to design audit procedures that are appropriate in the circumstances, but not for expressing an opinion on the effectiveness of the ${e.entityNoun}'s internal control.</li>
      <li>Evaluate the appropriateness of accounting policies used and the reasonableness of accounting estimates and related disclosure made by the management.</li>
      <li>Conclude on the appropriateness of management's use of the going concern basis of accounting and, based on the audit evidence obtained, whether a material uncertainty exists, we are required to draw attention in our auditor's report to the related disclosures in the financial statements, or if such disclosures are inadequate, to modify our opinion. Our conclusions are based on the audit evidence obtained up to date of our auditor's report. However, further events or conditions may cause the ${e.entityNoun} to cease to continue as a going concern.</li>
    </ul>
    <p>We communicate with Those Charged with Governance regarding among other matters, the planned scope and timing of the audit and significant audit finding including any significant deficiencies in internal control that are identify during our audit.</p>

    <h3 class="rep-sec"><span class="rep-section-num">1.4</span> Report on Other Legal and Regulatory Requirements:</h3>
    <p>We have obtained all information and explanations which, to the best of our knowledge and belief, were necessary for the purposes of our audit.</p>
    <p>Except for the effects of the matter described in the Basis for Qualified Opinion section of our report, in our opinion:</p>
    <ul class="rep-audit-points">
      <li>Proper books of account as required by ${act} have been maintained by the ${e.entityNounCap}.</li>
      <li>The financial statements are in agreement with the books and records maintained by the ${e.entityNounCap}.</li>
      <li>The ${e.entityNounCap} has generally complied with applicable laws and regulations relating to accounting and financial reporting.</li>
      <li>We have not identified any material instances of fraud or misappropriation affecting the financial statements.</li>
    </ul>`;
}

// Review Engagement Report — a fundamentally different engagement type from
// the 4 audit opinions above (NSRE 2400 limited-assurance review, not an
// audit), so it has no numbered 1.1-style sections at all — matches its own
// source document's flat bold-labeled-paragraph structure instead. No EOM/KAM/
// Basis-example content exists for this type (repUpdateCheckboxVisibility's
// existing conditions already evaluate false for 'review', hiding all three
// automatically — no change needed there). Cover page, letterhead, and
// signature block are still fully shared via the orchestrator.
function renderRepBodyReview(s, e){
  // Nepali fiscal years always start 1 Shrawan of the FY key's first year
  // (e.g. "2081-82" -> starts 1 Shrawan 2081) — computed rather than a new
  // form field, since it's a fixed rule, not a per-report choice.
  const startYear = $rep('rep-fy').value.split('-')[0];
  const periodStart = `1st Shrawan, ${startYear}`;
  return `
    <p>We have reviewed the accompanying financial statements of ${s.entityName}, which comprise the statement of financial position as at ${s.fy.bs} (${s.fy.ad}), and the statement of profit or loss, and statement of cash flows for the period ${periodStart} to ${s.fy.bs} (${s.fy.ad}), and a summary of significant accounting policies and other explanatory information.</p>

    <h3 class="rep-sec">Management Responsibility for the Financial Statement</h3>
    <p>Management is responsible for the preparation and fair presentation of these financial statements in accordance with the Nepal Financial Reporting Standard, and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatement, whether due to fraud or error.</p>

    <h3 class="rep-sec">Practitioner's Responsibility</h3>
    <p>Our responsibility is to express a conclusion on the accompanying financial statements. We conducted our review in accordance with Nepal Standard on Review Engagement (NSRE) 2400, Engagement to Review Historical Financial Statements. NSRE 2400 requires us to conclude whether anything has come to our attention that causes us to believe that the financial statements, taken as a whole, are not prepared in all material respects in accordance with the applicable financial reporting framework. This standard also requires us to comply with relevant ethical requirements.</p>
    <p>A review of financial statements in accordance with NSRE 2400 is a limited assurance engagement. The practitioner performs procedures, primarily consisting of making inquiries of management and others within the entity, as appropriate, and analytical procedures, and evaluates the evidence obtained.</p>
    <p>The procedures performed in a review are substantially less than those performed in an audit conducted in accordance with Nepal Standards on Auditing. <strong>Accordingly, we do not express an audit opinion on these financial statements.</strong></p>

    <h3 class="rep-sec">Conclusion</h3>
    <p>Based on our review, nothing has come to our attention that causes us to believe that these financial statements do not present fairly, in all material respects, the financial position of ${s.entityName} as at ${s.fy.bs} (${s.fy.ad}) and its financial performance and cash flows for the period then ended in accordance with Nepal Financial Reporting Standard as well as the Income Tax Act, 2058.</p>`;
}

// Each report type exposes only the optional-content checkboxes that exist in
// its template: EOM/KAM belong to Unqualified; the example-Basis paragraph
// belongs to Adverse, Disclaimer, and Qualified.
function repUpdateCheckboxVisibility(){
  const type = $rep('rep-reportType').value;
  const isUnqualified = type === 'unqualified';
  const hasBasisExample = type === 'adverse' || type === 'disclaimer' || type === 'qualified';
  $rep('rep-label-EOM').hidden = !isUnqualified;
  $rep('rep-label-KAM').hidden = !isUnqualified;
  $rep('rep-label-BasisExample').hidden = !hasBasisExample;

  // Each Include checkbox, when ticked, reveals its inline writing box below
  // the checkbox strip — content is written in the form and flows into the
  // report, instead of having to be typed into the Preview.
  $rep('rep-eom-input-wrap').hidden = !(isUnqualified && $rep('rep-toggleEOM').checked);
  $rep('rep-kam-input-wrap').hidden = !(isUnqualified && $rep('rep-toggleKAM').checked);
  $rep('rep-basis-input-wrap').hidden = !(hasBasisExample && $rep('rep-toggleBasisExample').checked);

  const basisLabels = {
    adverse: 'Basis of Adverse Opinion',
    disclaimer: 'Basis of Disclaimer of Opinion',
    qualified: 'Basis of Qualified Opinion',
  };
  if (basisLabels[type]) $rep('rep-basis-input-label').textContent = basisLabels[type];
}

// ── Edit / Preview view switching ──
// The full document is only rendered on demand (opening Preview, or exporting)
// rather than live on every keystroke — that's what lets the default view be a
// wide editing form instead of a constant preview. Only the small F.Y. date
// box updates live while editing.
function repIsPreviewOpen(){
  const pv = document.getElementById('rep-preview-view');
  return pv && !pv.hidden;
}
function repRefresh(){
  renderRepFyDate();
  repUpdateCheckboxVisibility();
  if (repIsPreviewOpen()) renderRepReport();
}
function repSetView(mode){
  const preview = mode === 'preview';
  const pv = document.getElementById('rep-preview-view');
  // Render only when entering preview from the edit view — not when Preview is
  // already open — so manual edits to the document's fill-in blanks (EOM / KAM)
  // aren't wiped by a re-render.
  if (preview && pv.hidden) renderRepReport();
  document.getElementById('rep-edit-view').hidden = preview;
  pv.hidden = !preview;
  document.getElementById('rep-tab-edit').classList.toggle('active', !preview);
  document.getElementById('rep-tab-preview').classList.toggle('active', preview);
}

// Before exporting: if the user is on the edit view the preview may be empty or
// stale, so render fresh. If they're already in preview, keep the current DOM
// as-is so any manual edits to the fill-in blanks survive into the export.
function repEnsureRendered(){
  if (!repIsPreviewOpen()) renderRepReport();
}

// Need to run initialization logic on window load to ensure DOM is ready
window.addEventListener('load', () => {
  ['rep-firm','rep-reportType','rep-entityName','rep-entityType','rep-entityAddress','rep-entityPan',
   'rep-fy','rep-reportDate','rep-reportPlace','rep-udin','rep-toggleEOM','rep-toggleKAM','rep-toggleBasisExample',
   'rep-eomText','rep-kamHeading','rep-kamProcedures','rep-kamDescription','rep-kamAddressed','rep-basisText'].forEach(id=>{
    const el = document.getElementById(id);
    if (el){
      el.addEventListener('input', repRefresh);
      el.addEventListener('change', repRefresh);
    }
  });

  renderRepFyDate();
  repUpdateCheckboxVisibility();
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
  repEnsureRendered(); // works straight from the edit view — no need to open Preview first
  const docContent = buildRepPrintableDoc();
  const blob = new Blob([docContent], {type:'text/html'});
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win){
    alert('Pop-up blocked — please allow pop-ups for this site, then click Print again.');
  }
}

// Builds a self-contained stylesheet for the Word export from the same .rep-*
// rules the on-screen preview and PDF use — so all four outputs stay visually
// consistent. Word can't read CSS custom properties (var()), so the handful
// the report styles rely on are resolved to concrete values first.
function getRepExportCss(){
  const sheetEl = document.querySelector('.rep-sheet');
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
    try { rules = sheet.cssRules; } catch(e){ continue; } // cross-origin sheets throw
    for (const r of rules){
      if (r.selectorText && /\.rep|\.rname/.test(r.selectorText)) css += r.cssText + '\n';
    }
  }
  Object.entries(vars).forEach(([k, v]) => { css = css.split('var(' + k + ')').join(v); });
  css = css.replace(/var\([^)]+\)/g, ''); // strip any leftover vars (e.g. shadows, overridden below)
  return css;
}

// Builds the full export HTML (document + resolved CSS + Word overrides) that
// both the .docx and the .doc-fallback paths share, so their formatting is
// identical to the preview/PDF.
function buildRepWordHtml(){
  const inner = document.getElementById('rep-previewRoot').innerHTML;
  const css = getRepExportCss();
  return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Audit Report</title><style>" +
    "body{ margin:0; font-family:'Georgia','Times New Roman',serif; color:#111; font-size:12.5px; line-height:1.28; }" +
    css +
    // Word can't do flexbox — lay the signature block out as a table so it
    // stays side-by-side — and drop the screen-only sheet chrome.
    ".rep-sheet{ box-shadow:none; border:none; padding:0; max-width:none; }" +
    ".rep-sig-block{ display:table; width:100%; }" +
    ".rep-sig-left,.rep-sig-right{ display:table-cell; width:50%; vertical-align:top; }" +
    "</style></head><body>" + inner + "</body></html>";
}

// Exports the report as a true .docx (OOXML) via html-docx-js, from the same
// document HTML the preview and PDF use so formatting stays consistent. If the
// library failed to load, falls back to a Word-openable .doc (HTML) so the
// button never silently breaks.
function saveRepAsWord(){
  repEnsureRendered();
  const html = buildRepWordHtml();
  const clientName = $rep('rep-entityName').value.trim() || 'Report';
  const base = ('Audit Report - ' + clientName).replace(/[\\/:*?"<>|]/g, '_');

  if (window.htmlDocx && typeof window.htmlDocx.asBlob === 'function'){
    // margins in twips (1440 = 1 inch) ≈ the 12mm/16mm print margins
    const blob = window.htmlDocx.asBlob(html, { margins: { top: 680, bottom: 680, left: 907, right: 907 } });
    DocumentEngine.downloadBlob(blob, base + '.docx', { module: 'report', clientName });
    return;
  }

  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  DocumentEngine.downloadBlob(blob, base + '.doc', { module: 'report', clientName });
}
