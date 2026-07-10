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
  if (c.business_nature) $rep('rep-entityBusiness').value = c.business_nature;

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

// The report's wording/markup lives in assets/templates/audit-report.html
// (same {{token}} convention as the firm's Word templates) so the firm can
// edit it directly without touching this file — see the comment at the top
// of that file for what's safe to change there. Fetched once and cached,
// same pattern as vatReturn.js / bmAgmMinutes.js via DocumentEngine.
const AUDIT_REPORT_TEMPLATE_URL = 'assets/templates/audit-report.html';
let auditReportTemplates = null; // { cover, report } markup strings, once loaded

async function loadAuditReportTemplates(){
  if (auditReportTemplates) return auditReportTemplates;
  const buffer = await DocumentEngine.getTemplate(AUDIT_REPORT_TEMPLATE_URL);
  const html = new TextDecoder('utf-8').decode(buffer);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cover = doc.getElementById('tpl-cover');
  const report = doc.getElementById('tpl-report');
  if (!cover || !report) throw new Error('audit-report.html is missing #tpl-cover or #tpl-report');
  auditReportTemplates = { cover: cover.innerHTML, report: report.innerHTML };
  return auditReportTemplates;
}

function fillTemplate(str, data){
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (data[key] ?? ''));
}

// Strips the <!--MARKER:START-->/<!--MARKER:END--> comments themselves, and
// either keeps or drops everything between them, per the EOM/KAM toggles.
function applyConditionalBlock(html, marker, keep){
  const re = new RegExp(`<!--${marker}:START-->([\\s\\S]*?)<!--${marker}:END-->`, 'g');
  return html.replace(re, (_, inner) => keep ? inner : '');
}

function getRepState(){
  return {
    firm: window.REP_FIRMS[$rep('rep-firm').value],
    entityName: $rep('rep-entityName').value.trim() || "[ENTITY NAME]",
    entityType: window.REP_ENTITY_PROFILES[$rep('rep-entityType').value],
    entityAddress: $rep('rep-entityAddress').value.trim() || "[ADDRESS]",
    entityPan: $rep('rep-entityPan').value.trim() || "[PAN]",
    entityBusiness: $rep('rep-entityBusiness').value.trim() || "[NATURE OF BUSINESS]",
    nas: window.REP_NAS_LABEL[$rep('rep-nasType').value],
    fy: window.REP_FY_DATES[$rep('rep-fy').value],
    reportDate: $rep('rep-reportDate').value.trim() || "[DATE]",
    reportPlace: $rep('rep-reportPlace').value.trim() || "[PLACE]",
    udin: $rep('rep-udin').value.trim(),
    includeEOM: $rep('rep-toggleEOM').checked,
    includeKAM: $rep('rep-toggleKAM').checked
  };
}

// Resolves an asset's own relative path to an absolute URL — needed because
// printAuditReport() opens the report in a separate blob: document, where a
// plain relative "assets/logo-lockup.png" src won't resolve against the app's origin.
function repAssetUrl(path){
  return new URL(path, document.baseURI).href;
}

// Firms with a letterhead logo (a lockup of the firm name + title) show the
// image in place of those two text lines; firms without one keep plain text.
// This one piece stays JS-computed (rather than living in the template)
// since which markup to use depends on data (does this firm have a logo).
function renderFirmIdentityHtml(f){
  return f.logo
    ? `<img class="rep-header-logo" src="${repAssetUrl(f.logo)}" alt="${f.name} - ${f.title}" onerror="this.outerHTML='<div class=&quot;rfname&quot;>${f.name}</div><div class=&quot;rftitle&quot;>${f.title}</div>'">`
    : `<div class="rfname">${f.name}</div><div class="rftitle">${f.title}</div>`;
}

function renderRepFyDate(){
  const d = window.REP_FY_DATES[$rep('rep-fy').value];
  $rep('rep-fyDateDisplay').innerHTML = `Financial position as at <strong>${d.bs}</strong> (<strong>${d.ad}</strong>)`;
}

async function renderRepReport(){
  const s = getRepState();
  const f = s.firm;
  const e = s.entityType;

  const n1 = "1.1";
  const nKAM = "1.2";
  const n2 = s.includeKAM ? "1.3" : "1.2";
  const n3 = s.includeKAM ? "1.4" : "1.3";
  const n4 = s.includeKAM ? "1.5" : "1.4";

  let templates;
  try {
    templates = await loadAuditReportTemplates();
  } catch (err) {
    $rep('rep-previewRoot').innerHTML = `<p style="padding:24px; color:var(--red-dk);">Couldn't load the report template (${err.message}). Check that assets/templates/audit-report.html exists.</p>`;
    return;
  }

  const data = {
    entityName: s.entityName, entityAddress: s.entityAddress, entityPan: s.entityPan, entityBusiness: s.entityBusiness,
    fyBs: s.fy.bs, fyAd: s.fy.ad, nas: s.nas,
    reportDate: s.reportDate, reportPlace: s.reportPlace,
    udinLine: s.udin ? `UDIN: ${s.udin}` : `UDIN:`,
    salutationTo: e.salutationTo, entityNoun: e.entityNoun, entityNounCap: e.entityNounCap,
    act: e.act, governingBodyShort: e.governingBodyShort,
    creditorsAndWord: e.entityNoun === 'company' ? 'shareholders' : 'stakeholders',
    firmName: f.name, firmTitle: f.title, firmAddress: f.address, firmEmail: f.email, firmPhone: f.phone,
    firmRegNo: f.regNo, firmMNo: f.mNo, firmPan: f.pan, firmCopNo: f.copNo,
    signatoryName: f.signatoryName, signatoryTitle: f.signatoryTitle,
    firmIdentityHtml: renderFirmIdentityHtml(f),
    n1, nKAM, n2, n3, n4
  };

  const coverHtml = fillTemplate(templates.cover, data);
  let reportHtml = fillTemplate(templates.report, data);
  reportHtml = applyConditionalBlock(reportHtml, 'EOM', s.includeEOM);
  reportHtml = applyConditionalBlock(reportHtml, 'KAM', s.includeKAM);

  $rep('rep-previewRoot').innerHTML = coverHtml + reportHtml;
}

async function renderRepAll(){
  renderRepFyDate();
  await renderRepReport();
}

// Need to run initialization logic on window load to ensure DOM is ready
window.addEventListener('load', () => {
  ['rep-firm','rep-entityName','rep-entityType','rep-entityAddress','rep-entityPan','rep-entityBusiness',
   'rep-nasType','rep-fy','rep-reportDate','rep-reportPlace','rep-udin','rep-toggleEOM','rep-toggleKAM'].forEach(id=>{
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
