// ════════════════════════════════════════════
//  COMPANY REGISTRATION (Companies Act 2063 §4/§18/§20)
//
//  Generates a complete incorporation filing from one form: the Memorandum
//  of Association (प्रबन्ध पत्र), Articles of Association (नियमावली), the
//  application letter to the Company Registrar's Office and the power of
//  attorney (मन्जुरीनामा) — one Word file, Nepali, filled through
//  DocumentEngine/docxtemplater exactly as BM/AGM Minutes and Company
//  Secretary Appointment fill theirs. Live docx-preview, autosave draft,
//  completion indicator, zoom, B.S. date validation — the standard
//  Registrar document-screen kit.
//
//  TWO templates, selected automatically by founder count: the firm keeps
//  separate single-shareholder and multi-shareholder source documents whose
//  wording differs throughout (singular declarations, no साधारण सभा rules,
//  a chapter structure), so a toggle would only invite generating the wrong
//  one. One founder = the single-man set; two or more = the multi set. Both
//  are built by tools/registrarDocx/buildCompanyReg.mjs — read its header
//  before changing any wording — and docs/modules/registrar.md §5.11d holds
//  this document pair's own conventions.
//
//  Unlike every other registrar module, this one has NO company picker:
//  the company being registered does not exist yet, in the registrar's
//  records or in ours. The optional "Add to Company Register" button closes
//  that loop AFTER the firm actually files the documents.
// ════════════════════════════════════════════

const CR_TEMPLATE_URLS = {
  single: 'assets/templates/company-registration-single.docx',
  multi: 'assets/templates/company-registration-multi.docx',
};

// Shares the Registrar document-screen look (and docx-preview's tab-stop
// CSS) with BM/AGM, Auditor Change and Company Secretary — see the note on
// CS_DOCX_CLASS in js/companySecretary.js.
const CR_DOCX_CLASS = 'bm-docx';

// The manually-typed list letters the sources number their objectives with —
// the full Devanagari consonant वर्णमाला (velar/palatal/retroflex/dental/
// labial/semivowel/sibilant classes, 33 letters), not just the first 20
// (क..न). A company whose objectives clause ran to 21+ items used to fall
// off the end of a 20-letter array straight into the '?' fallback below —
// found live 2026-08-24 when a real filing's list reached द)/ध)/न) and then
// printed '?)' for what should have been प)/फ)/ब).
const CR_LETTERS = ['क', 'ख', 'ग', 'घ', 'ङ', 'च', 'छ', 'ज', 'झ', 'ञ', 'ट', 'ठ', 'ड', 'ढ', 'ण', 'त', 'थ', 'द', 'ध', 'न', 'प', 'फ', 'ब', 'भ', 'म', 'य', 'र', 'ल', 'व', 'श', 'ष', 'स', 'ह'];

// Each source states the company's nature of business in its own words;
// these seed the field per variant and stop the moment the user types.
const CR_NATURE_DEFAULTS = {
  single: 'उत्पादन तथा व्यापार मूलक',
  multi: 'व्यापार मूलक तथा सेवामूलक',
};

function crStatus(html, type) {
  showStatus(html, type, 'cr-status');
}

function crDev(s) { return NepaliLocale.toDevanagari(String(s)); }
function crPad2(n) { return String(n).padStart(2, '0'); }

// "5000000" / "50,00,000" / "५०,००,०००" -> 5000000 (or 0)
function crParseAmount(raw) {
  const n = parseInt(NepaliLocale.toEnglishDigits(String(raw || '')).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// Figure as the documents print it: Devanagari, lakh-grouped, with the
// trailing dash the sources put after every rupee amount ("५०,००,०००।–").
function crCapitalFig(raw) {
  const f = NepaliLocale.formatAmount(crParseAmount(raw));
  return f ? f + '।–' : '';
}
function crCapitalWords(raw) {
  const w = NepaliLocale.amountToWords(crParseAmount(raw));
  return w ? w + ' रुपैयाँ' : '';
}
// रु १००।– per share — the user's explicit rule (2026-08-20): a 5-lakh
// capital IS 5,000 shares, never typed separately.
function crShareCount(raw) { return Math.floor(crParseAmount(raw) / 100); }
function crSharesFig(raw) { return NepaliLocale.formatAmount(crShareCount(raw)); }
function crSharesWords(raw) { return NepaliLocale.amountToWords(crShareCount(raw)); }

// "2083/05/02" -> "२०८३ साल भदौ महिना ०२ गते रोज ०३" — the ईति सम्वत् line,
// month name and weekday both derived from the one typed date.
function crDocDateLong(str) {
  const p = NepaliLocale.bsPartsNum(str);
  if (!p) return '';
  const w = NepaliLocale.bsWeekday(str);
  return crDev(p.year) + ' साल ' + NepaliLocale.NEPALI_MONTHS[p.month - 1] + ' महिना ' +
    crDev(crPad2(p.day)) + ' गते' + (w ? ' रोज ' + crDev(crPad2(w)) : '');
}
// "2083/05/02" -> "२०८३।०५।०२" — danda separators, the registrar documents'
// own convention (same as BM/AGM's bmDandaDate; per-module formats differ by
// decision, CLAUDE.md §8).
function crDandaDate(str) {
  const p = NepaliLocale.bsPartsNum(str);
  return p ? crDev(p.year + '।' + crPad2(p.month) + '।' + crPad2(p.day)) : '';
}

// The MOA/AOA headers print the unabbreviated name ("… प्राइभेट लिमिटेड")
// where the body uses the प्रा.लि. form the user types — the inverse of
// bmShortCompanyName(). A name not ending in प्रा.लि. passes through.
function crFullCompanyName(name) {
  return name.replace(/प्रा\s*\.\s*लि\s*\.?\s*$/, 'प्राइभेट लिमिटेड');
}

// ════════════════════════════════════════════
//  FOUNDERS — dynamic rows
// ════════════════════════════════════════════

const CR_FOUNDER_FIELDS = [
  { key: 'name', label: 'Founder Name', ph: 'संस्थापकको नाम' },
  { key: 'address', label: 'Address', ph: 'ठेगाना — e.g. चितवन जिल्ला भरतपुर म.न.पा. वडा नं. १०' },
  { key: 'fatherName', label: "Father's / Husband's Name", ph: 'बाबु वा पतिको नाम' },
  { key: 'citizenshipNo', label: 'Citizenship No.', ph: 'ना.प्र.नं.' },
  { key: 'citizenshipDistrict', label: 'Citizenship District', ph: 'e.g. चितवन' },
  { key: 'shares', label: 'Shares Subscribed', ph: 'auto — equal split', auto: true },
  { key: 'witnessName', label: 'Witness Name', ph: 'साक्षीको नाम' },
  { key: 'witnessAddress', label: 'Witness Address', ph: 'साक्षीको ठेगाना' },
  { key: 'witnessCitizenshipNo', label: 'Witness Citizenship No.', ph: 'ना.प्र.नं.' },
  { key: 'witnessDistrict', label: 'Witness District', ph: 'e.g. चितवन' },
];

function crAddFounderRow(data) {
  const wrap = document.getElementById('cr-founders');
  const card = document.createElement('div');
  card.className = 'cr-founder-card';
  card.style.cssText = 'border:1px solid var(--border); border-radius:8px; padding:12px; margin-top:10px;';
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <strong class="cr-founder-title" style="color:var(--brand-navy); font-size:13px;"></strong>
      <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.cr-founder-card').remove(); crOnFoundersChanged();">Remove</button>
    </div>
    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px 12px;">
      ${CR_FOUNDER_FIELDS.map(f => `
        <div class="form-group" style="margin:0;">
          <label style="font-size:11.5px;">${f.label}</label>
          <input type="text" class="cr-founder-input" data-key="${f.key}" placeholder="${f.ph}"${f.auto ? ' data-auto="1"' : ''} />
        </div>
      `).join('')}
    </div>
  `;
  wrap.appendChild(card);
  if (data) {
    card.querySelectorAll('.cr-founder-input').forEach(inp => {
      // Always assign — a blank value must clear the field (CLAUDE.md §9).
      inp.value = data[inp.dataset.key] || '';
      if (inp.dataset.key === 'shares' && data.sharesManual) inp.dataset.auto = '0';
    });
  }
  // Typing a share count by hand takes that row out of the auto split for
  // good — an auto pass must never overwrite a judgement someone entered.
  const sharesInp = card.querySelector('.cr-founder-input[data-key="shares"]');
  sharesInp.addEventListener('input', () => { sharesInp.dataset.auto = '0'; crUpdateShareWarning(); });
  crOnFoundersChanged();
}

function crGetFounderCards() {
  return Array.from(document.querySelectorAll('#cr-founders .cr-founder-card'));
}

// Founders with at least a name — the row set the documents are built from.
function crGetFounders() {
  return crGetFounderCards().map(card => {
    const f = {};
    card.querySelectorAll('.cr-founder-input').forEach(inp => { f[inp.dataset.key] = inp.value.trim(); });
    f.sharesManual = card.querySelector('.cr-founder-input[data-key="shares"]').dataset.auto === '0';
    return f;
  }).filter(f => f.name);
}

function crVariant() {
  return crGetFounders().length <= 1 ? 'single' : 'multi';
}

// Equal split of the issued shares across founders (user decision
// 2026-08-20), touching only rows whose count the split itself wrote —
// never one someone typed. The remainder lands on the first auto row.
function crRecalcShares() {
  const total = crShareCount(document.getElementById('cr-issuedCapital').value);
  const cards = crGetFounderCards();
  const autoInputs = cards
    .map(c => c.querySelector('.cr-founder-input[data-key="shares"]'))
    .filter(inp => inp.dataset.auto !== '0');
  if (!total || !cards.length || !autoInputs.length) { crUpdateShareWarning(); return; }
  const manualSum = cards
    .map(c => c.querySelector('.cr-founder-input[data-key="shares"]'))
    .filter(inp => inp.dataset.auto === '0')
    .reduce((s, inp) => s + crParseAmount(inp.value), 0);
  const pool = Math.max(0, total - manualSum);
  const base = Math.floor(pool / autoInputs.length);
  autoInputs.forEach((inp, i) => { inp.value = String(base + (i === 0 ? pool - base * autoInputs.length : 0)); });
  crUpdateShareWarning();
}

function crUpdateShareWarning() {
  const el = document.getElementById('cr-share-warning');
  if (!el) return;
  const total = crShareCount(document.getElementById('cr-issuedCapital').value);
  const sum = crGetFounderCards()
    .reduce((s, c) => s + crParseAmount(c.querySelector('.cr-founder-input[data-key="shares"]').value), 0);
  if (total && sum !== total) {
    el.style.display = 'block';
    el.textContent = `⚠️ Founders' shares total ${sum.toLocaleString('en-IN')} but the issued capital is ${total.toLocaleString('en-IN')} shares (रु १०० each) — the subscription table will not foot.`;
  } else {
    el.style.display = 'none';
  }
}

function crUpdateFounderChrome() {
  crGetFounderCards().forEach((card, i) => {
    card.querySelector('.cr-founder-title').textContent = 'संस्थापक ' + crDev(i + 1);
  });
  const note = document.getElementById('cr-template-note');
  if (note) {
    const n = crGetFounders().length;
    note.textContent = n <= 1
      ? 'Single-shareholder document set (एकल शेयरधनी) — 1 founder'
      : `Multi-shareholder document set — ${n} founders`;
  }
  // The nature-of-business seed follows the variant until the user types.
  const nature = document.getElementById('cr-businessNature');
  if (nature && nature.dataset.auto !== '0') nature.value = CR_NATURE_DEFAULTS[crVariant()];
}

function crOnFoundersChanged() {
  crUpdateFounderChrome();
  crRecalcShares();
  crOnFormChanged();
}

// ════════════════════════════════════════════
//  OBJECTIVES — dynamic rows, letters renumber themselves
// ════════════════════════════════════════════

function crAddObjectiveRow(text) {
  const wrap = document.getElementById('cr-objectives');
  const row = document.createElement('div');
  row.className = 'cr-objective-row';
  row.style.cssText = 'display:flex; gap:8px; align-items:flex-start; margin-top:8px;';
  row.innerHTML = `
    <span class="cr-objective-letter" style="min-width:28px; padding-top:8px; font-weight:600; color:var(--brand-navy);"></span>
    <textarea class="cr-objective-input" rows="2" style="flex:1; resize:vertical;" placeholder="कम्पनीको उद्देश्य…"></textarea>
    <button type="button" class="btn btn-danger btn-sm" style="margin-top:4px;" onclick="this.parentElement.remove(); crRenumberObjectives(); crOnFormChanged();">Remove</button>
  `;
  wrap.appendChild(row);
  if (text) row.querySelector('textarea').value = text;
  crRenumberObjectives();
  crOnFormChanged();
}

function crRenumberObjectives() {
  const rows = document.querySelectorAll('#cr-objectives .cr-objective-letter');
  rows.forEach((el, i) => {
    el.textContent = (CR_LETTERS[i] || '?') + ')';
  });
  const warning = document.getElementById('cr-objectives-warning');
  if (warning) {
    warning.style.display = rows.length > CR_LETTERS.length
      ? (warning.textContent = `⚠️ ${rows.length} objectives typed, but only ${CR_LETTERS.length} letters (क..ह) are defined — items after ह) will print as "?)" in the document. Remove this warning by splitting the list.`, 'block')
      : 'none';
  }
}

function crGetObjectives() {
  return Array.from(document.querySelectorAll('#cr-objectives .cr-objective-input'))
    .map(t => t.value.trim()).filter(Boolean)
    .map((text, i) => ({ letter: CR_LETTERS[i] || '?', text }));
}

// ════════════════════════════════════════════
//  DERIVED FIGURES STRIP — the capital arithmetic, visible before generating
// ════════════════════════════════════════════
function crUpdateDerived() {
  const el = document.getElementById('cr-derived');
  if (!el) return;
  const rows = [
    ['अधिकृत पूँजी', 'cr-authCapital', true],
    ['जारी पूँजी', 'cr-issuedCapital', true],
    ['चुक्ता पूँजी', 'cr-paidupCapital', false],
  ].map(([label, id, showShares]) => {
    let raw = document.getElementById(id).value;
    if (id === 'cr-paidupCapital' && !raw.trim()) raw = document.getElementById('cr-issuedCapital').value;
    if (!crParseAmount(raw)) return '';
    return `<div style="font-size:12px; color:var(--text-muted, #64748b);">
      <strong>${label}</strong>: रु ${escHtml(crCapitalFig(raw))} (${escHtml(crCapitalWords(raw))} मात्र)` +
      (showShares ? ` = ${escHtml(crSharesFig(raw))} (${escHtml(crSharesWords(raw))}) थान शेयर` : '') +
      `</div>`;
  }).filter(Boolean);
  el.innerHTML = rows.join('');
  el.style.display = rows.length ? 'block' : 'none';
}

// ════════════════════════════════════════════
//  DOCUMENT DATA
// ════════════════════════════════════════════
function crBuildData() {
  const $ = id => document.getElementById(id).value.trim();

  const founders = crGetFounders();
  const variant = founders.length <= 1 ? 'single' : 'multi';

  const auth = $('cr-authCapital');
  const issued = $('cr-issuedCapital');
  // Both sources issue and pay up the same amount; a blank paid-up field
  // means exactly that, not a zero.
  const paidup = $('cr-paidupCapital') || issued;

  const docDate = $('cr-docDate');
  const letterDate = $('cr-letterDate') || docDate;

  const data = {
    companyName: $('cr-companyName'),
    companyNameFull: crFullCompanyName($('cr-companyName')),
    companyNameEnglish: $('cr-companyNameEnglish'),
    registeredAddress: $('cr-address'),
    businessNature: $('cr-businessNature'),
    objectives: crGetObjectives(),

    authorizedCapitalFig: crCapitalFig(auth),
    authorizedCapitalWords: crCapitalWords(auth),
    authorizedShares: crSharesFig(auth),
    authorizedSharesWords: crSharesWords(auth),
    issuedCapitalFig: crCapitalFig(issued),
    issuedCapitalWords: crCapitalWords(issued),
    issuedShares: crSharesFig(issued),
    issuedSharesWords: crSharesWords(issued),
    paidupCapitalFig: crCapitalFig(paidup),
    paidupCapitalWords: crCapitalWords(paidup),
    paidupShares: crSharesFig(paidup),
    paidupSharesWords: crSharesWords(paidup),

    founderCount: crDev(founders.length),
    docDateLong: crDocDateLong(docDate),
    docDateNum: crDandaDate(docDate),
    letterDateNum: crDandaDate(letterDate),
    letterDateLong: crDocDateLong(letterDate),
    advocateName: $('cr-advocateName'),
    advocateLicense: crDev($('cr-advocateLicense')),
  };

  if (variant === 'multi') {
    data.directorCount = crDev(founders.length);
    data.founders = founders.map(f => ({
      name: f.name, address: f.address, fatherName: f.fatherName,
      citizenshipNo: crDev(f.citizenshipNo), citizenshipDistrict: f.citizenshipDistrict,
      shares: NepaliLocale.formatAmount(crParseAmount(f.shares)) || crDev(f.shares),
      witnessName: f.witnessName, witnessAddress: f.witnessAddress,
      witnessCitizenshipNo: crDev(f.witnessCitizenshipNo), witnessDistrict: f.witnessDistrict,
    }));
    // The letter/POA signature blocks run two founders per row; an odd
    // count leaves the last row's right column empty via {{#hasRight}}.
    data.founderPairs = [];
    for (let i = 0; i < founders.length; i += 2) {
      data.founderPairs.push({
        numLeft: crDev(i + 1),
        nameLeft: founders[i].name,
        hasRight: !!founders[i + 1],
        numRight: founders[i + 1] ? crDev(i + 2) : '',
        nameRight: founders[i + 1] ? founders[i + 1].name : '',
      });
    }
  } else {
    const f = founders[0] || {};
    Object.assign(data, {
      founderName: f.name || '', founderAddress: f.address || '', fatherName: f.fatherName || '',
      citizenshipNo: crDev(f.citizenshipNo || ''), citizenshipDistrict: f.citizenshipDistrict || '',
      founderShares: NepaliLocale.formatAmount(crParseAmount(f.shares)) || crDev(f.shares || ''),
      witnessName: f.witnessName || '', witnessAddress: f.witnessAddress || '',
      witnessCitizenshipNo: crDev(f.witnessCitizenshipNo || ''), witnessDistrict: f.witnessDistrict || '',
    });
  }

  return { variant, founders, data };
}

function crValidate() {
  const $ = id => document.getElementById(id).value.trim();
  if (!$('cr-companyName')) return 'कम्पनीको नाम भर्नुहोस् (enter the company name).';
  if (!$('cr-address')) return 'रजिष्टर्ड ठेगाना भर्नुहोस् (enter the registered address).';
  if (!crGetObjectives().length) return 'कम्तीमा एउटा उद्देश्य भर्नुहोस् (enter at least one objective).';
  if (!crParseAmount($('cr-authCapital'))) return 'अधिकृत पूँजी भर्नुहोस् (enter the authorized capital).';
  if (!crParseAmount($('cr-issuedCapital'))) return 'जारी पूँजी भर्नुहोस् (enter the issued capital).';
  if (!crGetFounders().length) return 'कम्तीमा एक संस्थापक भर्नुहोस् (enter at least one founder).';
  if (!$('cr-docDate')) return 'कागजातको मिति भर्नुहोस् (enter the B.S. document date).';
  if (!NepaliLocale.bsPartsNum($('cr-docDate'))) return 'मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस् (invalid date format).';
  return null;
}

async function crRenderDocx(variant, data) {
  const buffer = await DocumentEngine.getTemplate(CR_TEMPLATE_URLS[variant]);
  return DocumentEngine.renderWord(buffer, data);
}

async function generateCompanyRegistrationDocs() {
  const problem = crValidate();
  if (problem) { crStatus(problem, 'info'); return; }
  const { variant, data } = crBuildData();
  try {
    crStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const blob = await crRenderDocx(variant, data);
    const fname = ('Company Registration ' + data.companyName + '.docx').replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'companyRegistration', clientName: data.companyName });
    crStatus('✅ दर्ता कागजात तयार भयो — डाउनलोड भयो (generated & downloaded — ' +
      (variant === 'single' ? 'single-shareholder set' : 'multi-shareholder set') + ').', 'success');
    crClearDraft();
  } catch (err) {
    crStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}

// ════════════════════════════════════════════
//  LIVE PREVIEW  (the js/companySecretary.js pattern, unchanged)
// ════════════════════════════════════════════
function crPreviewReady() { return !crValidate(); }

function crShowPreviewPlaceholder() {
  const placeholder = document.getElementById('cr-preview-placeholder');
  const root = document.getElementById('cr-preview-root');
  if (placeholder) placeholder.style.display = 'flex';
  if (root) root.style.display = 'none';
}

async function crRefreshPreview(isCurrent) {
  const placeholder = document.getElementById('cr-preview-placeholder');
  const root = document.getElementById('cr-preview-root');
  if (!placeholder || !root) return;
  // See the note in js/bmAgmMinutes.js bmRefreshPreview: bailing out on
  // `!window.docx` is a silent no-op that leaves the preview blank or stale
  // until a page reload, because nothing re-schedules the render. Fixed
  // 2026-08-29 across all four registrar preview modules.
  try { await LibLoader.ensure('docxpreview'); }
  catch (err) { console.error('Company Registration preview: docx-preview failed to load:', err); return; }
  if (!isCurrent()) return;
  if (!crPreviewReady()) { crShowPreviewPlaceholder(); return; }

  const { variant, data } = crBuildData();
  try {
    const blob = await crRenderDocx(variant, data);
    if (!isCurrent()) return;
    await DocumentEngine.previewWordAsHtml(blob, root, document.getElementById('cr-preview-style'), {
      className: CR_DOCX_CLASS,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    if (!isCurrent()) return;
    placeholder.style.display = 'none';
    root.style.display = 'block';
    // flow, not fit: the MOA and AOA legitimately span several sheets, and
    // one-sheet fitting would shrink-and-clip them (see fitPagesToSheet).
    // The paginator then splits each flow section into A4 sheets by the
    // keep rules the blob itself carries, so the preview shows the same
    // page-break behaviour the Word file has.
    DocumentEngine.fitPagesToSheet(root, CR_DOCX_CLASS, { flow: true });
    await DocumentEngine.paginateFlowSections(root, CR_DOCX_CLASS, blob);
    if (!isCurrent()) return;
  } catch (err) {
    console.error('Company Registration preview render failed:', err);
  }
}

const crPreviewRefreshCtl = WorkflowEngine.createDebouncedRefresh(crRefreshPreview, 500);
function crSchedulePreviewRefresh() { crPreviewRefreshCtl.schedule(); }

function crIsPreviewOpen() {
  const pv = document.getElementById('cr-preview-view');
  return !!pv && !pv.hidden;
}

function crSetView(mode) {
  const preview = mode === 'preview';
  const pv = document.getElementById('cr-preview-view');
  const enteringPreview = preview && pv.hidden;
  document.getElementById('cr-edit-view').hidden = preview;
  pv.hidden = !preview;
  document.getElementById('cr-tab-edit').classList.toggle('active', !preview);
  document.getElementById('cr-tab-preview').classList.toggle('active', preview);
  if (enteringPreview) crSchedulePreviewRefresh();
}

// ════════════════════════════════════════════
//  PRINT / SAVE AS PDF
// ════════════════════════════════════════════
async function crPrintDocument() {
  if (!crPreviewReady()) {
    crStatus(crValidate(), 'info');
    return;
  }
  crStatus('<span class="spinner spinner-navy"></span> प्रिन्टका लागि तयार गर्दै (preparing print)…', 'searching');
  try {
    const { variant, data } = crBuildData();
    const blob = await crRenderDocx(variant, data);
    const html = await DocumentEngine.buildPrintableHtml(blob, { className: CR_DOCX_CLASS, title: 'Company Registration', flow: true });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win = window.open(url, '_blank');
    if (!win) { crStatus('❌ पप-अप रोकियो — कृपया पप-अपलाई अनुमति दिनुहोस् (pop-up blocked — allow pop-ups and retry).', 'error'); return; }
    crStatus('🖨️ प्रिन्ट विन्डो खुल्यो — प्रिन्ट गर्नुहोस् वा "Save as PDF" रोज्नुहोस्।', 'success');
  } catch (err) {
    crStatus('❌ ' + (err.message || 'Print failed'), 'error');
  }
}

// ════════════════════════════════════════════
//  SAVE TO DATABASE / SAVED REGISTRATIONS
//
//  The same pair BM/AGM Minutes, Generate Report and Notes to Accounts have,
//  over the shared saved_documents table and the one shared picker drawer
//  (CLAUDE.md §15: saved documents are ONE table with a `module`
//  discriminator, so this is a CHECK value —
//  db/2026-08-21_saved_documents_registrar_docs.sql — not a new table).
//  client_id stays NULL here for an even stronger reason than BM/AGM's: the
//  company being registered exists in NO directory yet. No doc_html — the
//  Word file regenerates from `state` byte for byte.
//
//  Re-saving in the same session amends the same row, matching the others.
// ════════════════════════════════════════════
let crSavedId = null;

async function crSaveToDb() {
  const companyName = (document.getElementById('cr-companyName').value || '').trim();
  if (!companyName) {
    crStatus('कम्पनीको नाम भर्नुहोस् (enter the company name before saving).', 'error');
    return;
  }
  try {
    crStatus('<span class="spinner spinner-navy"></span> सुरक्षित गर्दै (saving)…', 'searching');
    crSavedId = await DocumentStore.save(crSavedId, {
      module: 'companyRegistration',
      client_id: null,
      client_name: companyName,
      pan: null,
      fiscal_year: null,
      doc_type: crVariant() === 'single'
        ? 'Company Registration (single-shareholder)' : 'Company Registration (multi-shareholder)',
      title: 'Company Registration — ' + companyName,
      state: crFormState(),
    });
    crStatus(`✅ सुरक्षित भयो (saved as record #${crSavedId}) — <strong>Saved registrations</strong> बाट पुन: खोल्न सकिन्छ.`, 'success');
    AuditLog.record('company_registration_saved', {
      module: 'companyRegistration', clientName: companyName, status: 'success', recordRef: crSavedId,
    });
  } catch (e) {
    console.error(e);
    crStatus('❌ सुरक्षित हुन सकेन (save failed): ' + escHtml(e.message), 'error');
  }
}

function crOpenSaved() {
  DocumentStore.openPicker({
    module: 'companyRegistration',
    label: 'Saved registration filings',
    searchPlaceholder: 'Search by company…',
    onOpen: row => {
      if (!crApplyState(row.state)) {
        crStatus('यो रेकर्डमा फारम विवरण छैन (this record has no form state saved).', 'error');
        return;
      }
      crSavedId = row.id;
      crUpdateDerived();
      crUpdateShareWarning();
      crUpdateCompletionIndicator();
      if (crIsPreviewOpen()) crSchedulePreviewRefresh();
      crStatus(`📂 सुरक्षित रेकर्ड #${row.id} खोलियो — Save to database फेरि थिच्दा यही रेकर्ड अद्यावधिक हुन्छ (opened; saving again updates this same record).`, 'info');
    },
  });
}

// ════════════════════════════════════════════
//  ADD TO COMPANY REGISTER  (optional, explicit, admin-only)
//
//  The registration module deliberately reads nothing from the register —
//  the company does not exist yet. Once the registrar actually accepts the
//  filing, this one button carries the company across into Company
//  Registrar → Company Profile so BM/AGM, Company Secretary and Auditor
//  Change can pick it without re-typing. It is never automatic (a generated
//  draft is not a registered company), and Company Profile remains the only
//  screen that EDITS a register row. Adding is admin-only at the database
//  (same RLS rule as Company Profile's own add).
// ════════════════════════════════════════════

// English-digit lakh grouping ("2500000" -> "25,00,000") — the format the
// register's existing capital text uses; NepaliLocale.formatAmount would
// hand back Devanagari digits, which is the documents' convention, not the
// directory's.
function crLakhEn(raw) {
  let s = String(crParseAmount(raw) || '');
  if (!s || s === '0') return '';
  let last3 = s.slice(-3), rest = s.slice(0, -3), grouped = last3;
  while (rest.length) { grouped = rest.slice(-2) + ',' + grouped; rest = rest.slice(0, -2); }
  return grouped;
}

async function crAddToRegister() {
  const role = window.currentUser && window.currentUser.role;
  if (role !== 'admin' && role !== 'owner') {
    crStatus('Adding a company to the register is admin-only — ask an admin to press this after the registration goes through.', 'info');
    return;
  }
  const problem = crValidate();
  if (problem) { crStatus(problem, 'info'); return; }

  const { founders, data } = crBuildData();
  const name = data.companyName;
  if (window.RegistrarDirectory && RegistrarDirectory.list().some(c => (c.name || '').trim() === name)) {
    crStatus('⚠️ "' + escHtml(name) + '" is already in the company register — edit it in Company Profile instead.', 'error');
    return;
  }

  const $ = id => document.getElementById(id).value.trim();
  const payload = {
    name,
    registration_number: null,   // the registrar assigns it — filled in Company Profile later
    pan: null,
    chairman_name: founders[0].name,
    shareholder_name: founders[1] ? founders[1].name : null,
    authorized_capital: crLakhEn($('cr-authCapital')) || null,
    issued_capital: crLakhEn($('cr-issuedCapital')) || null,
    paid_up_capital: crLakhEn($('cr-paidupCapital') || $('cr-issuedCapital')) || null,
    address: data.registeredAddress || null,
    country: 'Nepal',
    notes: 'Added from Company Registration (' + ($('cr-docDate') || '') + ')',
  };

  try {
    crStatus('<span class="spinner spinner-navy"></span> Adding to the company register…', 'searching');
    const { data: row, error } = await window.sb.from('registrar_companies').insert(payload).select('id').single();
    if (error) throw error;
    const extras = founders.slice(2).map((f, i) => ({ company_id: row.id, name: f.name, sort_order: i }));
    if (extras.length) {
      const { error: shErr } = await window.sb.from('registrar_shareholders').insert(extras);
      if (shErr) { crStatus('Company added, but its extra founders did not save: ' + shErr.message, 'error'); return; }
    }
    if (window.RegistrarDirectory) await RegistrarDirectory.reload();
    AuditLog.record('registrar_company_added', { module: 'companyRegistration', clientName: name, recordRef: row.id });
    crStatus('✅ "' + escHtml(name) + '" added to the company register — set its registration number in Company Profile once the registrar assigns it.', 'success');
  } catch (err) {
    crStatus('❌ Could not add to the register: ' + escHtml(friendlyDbError(err)) +
      (String(err.message || '').includes('policy') ? ' (adding a company is admin-only)' : ''), 'error');
  }
}

// ════════════════════════════════════════════
//  POLISH: form change plumbing, zoom, dates, autosave, completion
// ════════════════════════════════════════════
function crOnFormChanged() {
  crUpdateDerived();
  crUpdateShareWarning();
  if (crIsPreviewOpen()) crSchedulePreviewRefresh();
  crScheduleAutosave();
  crUpdateCompletionIndicator();
}

const crZoom = WorkflowEngine.createZoomControl(document.getElementById('cr-preview-root'), document.getElementById('cr-zoom-level'));
function crZoomIn() { crZoom.zoomIn(); }
function crZoomOut() { crZoom.zoomOut(); }

function crValidateDateField(fieldId) {
  const input = document.getElementById(fieldId);
  const errorEl = document.getElementById(fieldId + '-error');
  if (!input || !errorEl) return;
  const val = input.value.trim();
  if (!val || NepaliLocale.bsPartsNum(val)) {
    errorEl.classList.remove('show');
    input.style.borderColor = '';
  } else {
    errorEl.textContent = 'ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस् (invalid format, use YYYY/MM/DD)';
    errorEl.classList.add('show');
    input.style.borderColor = 'var(--red)';
  }
}

// ONE serialisation of the form, shared by the localStorage autosave and the
// Save-to-database record — the bmFormState()/bmApplyState() rule: keeping
// them separate is how a field added to the form ends up captured by one and
// silently missed by the other.
function crFormState() {
  const values = {};
  document.querySelectorAll('#regd-companyRegistration-panel input[id^="cr-"]').forEach(el => { values[el.id] = el.value; });
  return {
    values,
    natureManual: document.getElementById('cr-businessNature').dataset.auto === '0',
    objectives: Array.from(document.querySelectorAll('#cr-objectives .cr-objective-input')).map(t => t.value),
    founders: crGetFounderCards().map(card => {
      const f = {};
      card.querySelectorAll('.cr-founder-input').forEach(inp => { f[inp.dataset.key] = inp.value; });
      f.sharesManual = card.querySelector('.cr-founder-input[data-key="shares"]').dataset.auto === '0';
      return f;
    }),
  };
}

// Clears the objective/founder rows before re-adding them — otherwise opening
// a second saved record stacks its rows under the previous one's (CLAUDE.md §9).
function crApplyState(state) {
  if (!state || !state.values) return false;
  Object.entries(state.values).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  // Always assign (§9): a record whose nature was the auto seed must not
  // inherit a previous record's manual flag, and vice versa.
  document.getElementById('cr-businessNature').dataset.auto = state.natureManual ? '0' : '1';
  document.getElementById('cr-objectives').innerHTML = '';
  (state.objectives || []).forEach(t => { if (t) crAddObjectiveRow(t); });
  document.getElementById('cr-founders').innerHTML = '';
  (state.founders || []).forEach(f => crAddFounderRow(f));
  return true;
}

const crAutosave = WorkflowEngine.createAutosave('companyRegistrationDraft', {
  collect: crFormState,
  restore: (draft) => {
    const any = (draft.values && Object.values(draft.values).some(v => v)) ||
      (draft.founders || []).length || (draft.objectives || []).some(v => v);
    if (!any) return;
    crApplyState(draft);
    crStatus('📝 अघिल्लो अपूर्ण फारम पुन: लोड गरियो (restored your unsaved draft from last time).', 'info');
  },
  debounceMs: 600,
});
function crScheduleAutosave() { crAutosave.scheduleSave(); }
function crClearDraft() { crAutosave.clear(); }

function crUpdateCompletionIndicator() {
  WorkflowEngine.updateCompletionIndicator(
    'cr-completion-indicator',
    ['cr-companyName', 'cr-address', 'cr-authCapital', 'cr-issuedCapital', 'cr-docDate'],
    '✅ Ready to generate'
  );
}

function crResetForm() {
  const panel = document.getElementById('regd-companyRegistration-panel');
  if (!panel) return;
  // drop the link to any opened record, or the next Save silently overwrites
  // the document that was just cleared off the screen
  crSavedId = null;
  panel.querySelectorAll('input[type="text"]').forEach(el => { el.value = ''; });
  const nature = document.getElementById('cr-businessNature');
  nature.dataset.auto = '1';
  document.getElementById('cr-founders').innerHTML = '';
  document.getElementById('cr-objectives').innerHTML = '';
  crAddObjectiveRow();
  crAddFounderRow();
  document.getElementById('cr-status').innerHTML = '';
  crShowPreviewPlaceholder();
  crSetView('edit');
  crClearDraft();
  crUpdateDerived();
  crUpdateCompletionIndicator();
}

document.addEventListener('DOMContentLoaded', function () {
  const panel = document.getElementById('regd-companyRegistration-panel');
  if (!panel) return;
  WorkflowEngine.attachFormWatcher(panel, crOnFormChanged);
  const nature = document.getElementById('cr-businessNature');
  if (nature) nature.addEventListener('input', () => { nature.dataset.auto = '0'; });
  const issued = document.getElementById('cr-issuedCapital');
  if (issued) issued.addEventListener('input', crRecalcShares);
  // No crAutosave.load() here (2026-08-28) — REGD_INITS (js/tabs.js) now
  // resets this form to blank on every open, so restoring a draft here
  // would just be immediately wiped the moment the user actually looks at
  // the tab. crAutosave/crClearDraft are left in place (crResetForm still
  // calls crClearDraft) rather than torn out, in case a future explicit
  // "Restore last draft" affordance wants them.
  // A fresh form still needs one objective and one founder to type into.
  if (!crGetFounderCards().length) crAddFounderRow();
  if (!document.querySelector('#cr-objectives .cr-objective-input')) crAddObjectiveRow();
  crUpdateDerived();
  crUpdateCompletionIndicator();
});
