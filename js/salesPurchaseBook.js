// ════════════════════════════════════════════
//  SALES & PURCHASE BOOK — automated reporting workbook
//  The user maintains only two raw sheets (Sales / Purchase: Date, Bill No.,
//  Party Name, Pan No., Tax Free, Taxable Amount, Vat — B.S. dates like
//  2081.04.01). Everything else is derived here and written back out as a
//  complete 7-sheet workbook (ExcelJS, live formulas):
//    Sales, Sales Summary (grouped by party, alphabetical, subtotal rows),
//    Sales Details (one "<Party> Total" row per party, taxable desc),
//    Purchase + its Summary/Details, and Monthly (fiscal-month totals with
//    the As-Per-VAT-Return reconciliation).
//
//  Three things the reference workbook proved that shape this module:
//  · The raw sheets carry 12 embedded month-subtotal rows that exactly
//    duplicate the transactions — a naive sum returns double. They are
//    stripped on import and regenerated in the output as live SUM formulas.
//  · "As Per VAT Return" is NOT derivable from the book (11 of 12 purchase
//    months in the reference file differ by real amounts, up to 555k). The
//    filed figures are typed by the user in the reconciliation grid; months
//    beyond ±SPB_ROUNDING_TOLERANCE are flagged, never shown as matched.
//  · Party spellings fragment ("SIPRADI AUTOPARTS PVT.LTD" vs
//    "Sipradi Autoparts Pvt.Ltd.", same PAN) but PAN alone is unsafe as a
//    merge key (one PAN in the file spans two unrelated companies, and 735
//    sales rows have no PAN). So: only trivially-safe normalization merges
//    automatically; everything else becomes a per-name-checkbox review list
//    the user approves per file. Nothing merges silently.
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Accounting" dropdown, not a sidebar button.
ModuleRegistry.register({ id: 'salesPurchaseBook', group: 'main', buttonId: null, panelId: 'tab-salesPurchaseBook-panel' });

// A month "reconciles" only within this band. The IRD-filed figures are whole
// rupees produced by TRUNCATION, not rounding (reference file: book VAT
// 532,929.74 filed as 532,929) — so legitimate differences run up to 0.99,
// and only a full rupee or more is a real gap.
const SPB_ROUNDING_TOLERANCE = 0.999;

// Fiscal display order (index 0 = Shrawan) → B.S. calendar month number.
const SPB_BS_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

// Month labels printed in the reconciliation grid and the workbook, in the
// same fiscal order. These spellings match the firm's own reconciled file
// ("Total of Ashwin", "Total of Mangshir") — don't "correct" them.
//
// This list used to be VAT_MONTH_ORDER in js/vatCompliance.js. That module was
// removed on 2026-08-10 and took the constant with it, leaving Autobooks
// calling an undefined global in three places — which threw on every import
// and every workbook generation. Autobooks is now its only consumer, so it
// lives here rather than becoming a cross-module global again.
const SPB_MONTH_NAMES = ['Shrawan', 'Bhadra', 'Ashwin', 'Kartik', 'Mangshir', 'Poush', 'Magh', 'Falgun', 'Chaitra', 'Baishak', 'Jestha', 'Ashadh'];

const SPB_SECTIONS = [
  { key: 'sales',    label: 'Sales' },
  { key: 'purchase', label: 'Purchase' },
];

// ── Module state ──
let spbClientId = null;
let spbData = null;          // { sales: {txns, stats} | null, purchase: ... }
let spbBook = null;          // { sales: [12 × {t,v,f}], purchase: ... } — "As per Book"
let spbGroups = null;        // { sales: [party groups], purchase: ... }
let spbSuggestions = [];     // duplicate-party review groups
let spbMergeMap = {};        // safeKey → canonical safeKey (approved merges only)
let spbVr = null;            // typed VAT-return figures { sales:[12×{t,v,f}], purchase:[...] }
// Data-Doctor state — the raw sheets are kept so corrections re-parse from
// source instead of mutating parsed rows (declarative, reproducible, and
// exportable as a Corrections sheet).
let spbRaw = null;           // { sales: {rows, header|null, source} | null, purchase: ... }
let spbOverrides = null;     // { sales: {excelRow: {date/vat/pan/exclude/..}}, purchase: {...} }
let spbCorrectionLog = [];   // [{section, excelRow, field, from, to, ts}] — feeds the Corrections sheet
let spbDismissed = null;     // Set of issue keys the user marked "keep as-is"
let spbIssues = [];          // current Data-Doctor findings
let spbChecksums = null;     // embedded-subtotal checksum comparison per section
let spbImportNotes = [];     // file-level notes, re-shown across reparses

function spbStatus(html, type) { showStatus(html, type, 'spb-status'); }

function spbNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function spbFmt(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function spbVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

// Whether this client is registered for PAN only, not VAT. Such a client
// charges no VAT on its SALES but still pays 13% on purchases from a
// registered vendor (2026-08-14, user) — so the two books are validated
// differently. Defaults from the client's own `tax_registration_type`, which
// is a property of the client and NOT the same field as `vat_status` (§15).
function spbIsPanOnly() {
  const el = document.getElementById('spb-regtype');
  return !!el && el.value === 'pan';
}

// Every month carries a slot for every comparable field, whether or not this
// client's book has that column — the grid decides what to SHOW (spbVrModel),
// and a fixed shape is what lets an older localStorage draft be topped up
// instead of thrown away.
const SPB_VR_FIELDS = ['t', 'v', 'f', 'imp', 'impVat'];

function spbBlankVr() {
  const sec = () => SPB_BS_MONTHS.map(() => SPB_VR_FIELDS.reduce((a, f) => (a[f] = '', a), {}));
  return { sales: sec(), purchase: sec() };
}

// ════════════════════════════════════════════
//  FISCAL YEAR — dash format (2081-82) in the UI like Depreciation; the
//  workbook itself titles years dot-style (2081.2082), matching the firm's
//  own file naming. Both derive from one start year.
// ════════════════════════════════════════════
function spbFyStartYear() {
  const m = spbVal('spb-fy').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function spbFyDot() {
  const y = spbFyStartYear();
  return y ? y + '.' + (y + 1) : '';
}

// The year a book is being compiled FOR, which is not the year we are in.
// Autobooks used to default to whatever fiscal year today's B.S. date fell in
// — so a book being written in Shrawan 2083 opened on F.Y. 2083-84 when every
// such book is for 2082-83. Matches ARF_FY_DEFAULT / SM_FY_DEFAULT, which
// settled the same argument for the same reason.
// Reads window.FY_DEFAULT_START (config.js) — see that constant's comment.
const SPB_FY_DEFAULT = window.FY_DEFAULT_START + '-' + String((window.FY_DEFAULT_START + 1) % 100).padStart(2, '0');

function spbBuildFyOptions() {
  const sel = document.getElementById('spb-fy');
  if (!sel || sel.dataset.built) return;
  const bs = NepaliLocale.todayBs && NepaliLocale.todayBs();
  const cur = bs ? (bs.month >= 4 ? bs.year : bs.year - 1) : 2082;
  const def = parseInt(SPB_FY_DEFAULT, 10);
  // Cover both the default and today, however far apart they drift.
  const from = Math.min(def, cur) - 4, to = Math.max(def, cur) + 1;
  let html = '';
  for (let y = from; y <= to; y++) {
    const label = y + '-' + String((y + 1) % 100).padStart(2, '0');
    html += `<option value="${label}"${label === SPB_FY_DEFAULT ? ' selected' : ''}>${label}</option>`;
  }
  sel.innerHTML = html;
  sel.dataset.built = '1';
}

function spbInit() {
  spbBuildFyOptions();
  // Building the FY options can change whether a book is saveable, and the
  // saved-book card was last drawn at page load when the selector was still
  // empty. Redraw it, or it sits on "choose a fiscal year" after one is set.
  if (typeof spbRenderBookCard === 'function') spbRenderBookCard();
}

// ════════════════════════════════════════════
//  PARTY NAME NORMALIZATION — two levels, deliberately separate:
//  · safeKey  — merges applied AUTOMATICALLY. Only differences that cannot
//    change identity: case, whitespace, trailing periods, and the
//    PVT.LTD / PVT LTD punctuation family.
//  · fuzzyKey — used only to SUGGEST merges for user review (all
//    punctuation stripped). Never applied without approval.
// ════════════════════════════════════════════
function spbSafeKey(name) {
  return String(name || '').toUpperCase()
    .replace(/PVT[.\s]*LTD[.\s]*/g, 'PVT LTD ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
}

function spbFuzzyKey(name) {
  return spbSafeKey(name).replace(/[.,&\-'()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// PANs may be stored in Devanagari numerals (§6.3) — normalize before comparing.
function spbNormPan(v) {
  return NepaliLocale.toEnglishDigits(String(v == null ? '' : v)).trim();
}

// A Nepal PAN is always exactly 9 digits. A value that isn't is far more
// likely a typo (one dropped/extra digit) than proof of a different real
// PAN, so it must not carry the weight of a genuine PAN when we decide
// whether an identical party name is actually two different companies —
// only a well-formed PAN is trustworthy enough to trigger that split.
function spbIsValidPan(pan) {
  return /^\d{9}$/.test(pan);
}

// ════════════════════════════════════════════
//  IMPORT — one workbook with both sheets, or two files. Sheet classification
//  is by name (Sales/Bikri vs Purchase/Kharid), skipping derived sheets so a
//  previously GENERATED workbook can be re-uploaded safely ("Sales Summary"
//  must not shadow "Sales").
// ════════════════════════════════════════════
function spbClassifySheet(sheetName) {
  const s = String(sheetName || '').trim().toLowerCase();
  if (/summary|detail|monthly/.test(s)) return null;
  if (/sales|bikri/.test(s)) return 'sales';
  if (/purchase|kharid/.test(s)) return 'purchase';
  return null;
}

// Some clients' books don't have a per-row date at all — the whole column is
// headed "Month"/"Months" and every cell just names the B.S. month
// (see spbParseMonthNameDate below, which already handles that content —
// this only widens which HEADER TEXT is recognized as that column).
// Nepali header spellings (मिति = date, महिना = month) are accepted too.
const SPB_DATE_HEADER_RE = /^(date|months?|miti|mahina|मिति|महिना)$/;

// ── Amount columns ──────────────────────────────────────────────────────────
// The four VAT-return boxes the firm enters separately. Taxable Import and
// Capital Purchase are PURCHASE-ONLY (2026-08-14, user decision) and each
// carries its own 13% VAT column. Capital is entered apart from taxable but
// JOINS taxable purchase in the filed return — see spbReturnTaxable().
//
// Every field is optional and defaults to 0, so the firm's existing 7-column
// books import byte-identically.
const SPB_AMOUNT_FIELDS = [
  { key: 'taxfree', label: 'Tax Free' },
  { key: 'taxable', label: 'Taxable Amount', vatKey: 'vat' },
  { key: 'vat', label: 'Vat' },
  { key: 'imp', label: 'Taxable Import', purchaseOnly: true, vatKey: 'impVat' },
  { key: 'impVat', label: 'Import VAT', purchaseOnly: true },
  { key: 'cap', label: 'Capital Purchase', purchaseOnly: true, vatKey: 'capVat' },
  { key: 'capVat', label: 'Capital VAT', purchaseOnly: true },
];
const SPB_AMOUNT_KEYS = SPB_AMOUNT_FIELDS.map(f => f.key);
// The amount pairs whose VAT is auto-filled at 13% when the cell is blank.
const SPB_VAT_PAIRS = SPB_AMOUNT_FIELDS.filter(f => f.vatKey).map(f => [f.key, f.vatKey]);

// Header matching, MOST SPECIFIC FIRST — the order is load-bearing.
// "Taxable Import" contains "taxable"; "Import VAT" and "Capital VAT" both
// contain "vat". Testing the compound spellings before the plain ones is what
// stops a new column being swallowed by an old rule.
const SPB_HEADER_RULES = [
  ['date', SPB_DATE_HEADER_RE],
  ['bill', /bill|invoice\s*no/],
  ['party', /party|supplier|customer/],
  ['pan', /\bpan\b|pan\s*no/],
  ['impVat', /(import|paithari).*vat|vat.*(import|paithari)/],
  ['capVat', /(capital|punjigat).*vat|vat.*(capital|punjigat)/],
  ['imp', /import|paithari/],
  ['cap', /capital|punjigat/],
  ['taxfree', /tax\s*free|kar\s*chhut/],
  ['taxable', /taxable|kar\s*yogya/],
  ['vat', /^vat|^tax$/],
];

function spbFindHeader(rows) {
  // Scan deep (25 rows): real files carry title rows, blank spacers and
  // merged-cell banners above the actual header.
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = (rows[i] || []).map(c => String(c == null ? '' : c).toLowerCase().replace(/\s+/g, ' ').trim());
    if (!cells.some(c => SPB_DATE_HEADER_RE.test(c)) || !cells.some(c => /party|supplier|customer/.test(c))) continue;
    const col = {};
    cells.forEach((c, j) => {
      if (!c) return;
      const hit = SPB_HEADER_RULES.find(([key, re]) => col[key] == null && re.test(c));
      if (hit) col[hit[0]] = j;
    });
    if (col.date != null && col.party != null && col.taxable != null) return { row: i, col };
  }
  return null;
}

const SPB_DATE_RE = /^(\d{4})[.\/\-](\d{1,2})[.\/\-](\d{1,2})$/;

// Fallback for rows dated by B.S. MONTH NAME instead of a full numeric date
// ("Baishakh", "15 Baishakh 2082", "Baishakh-2082" …) — some clients' books
// are kept that way rather than pure date-wise. Tried only after the strict
// numeric date fails, and always reported (never a silent guess) since the
// day and/or year may be inferred.
const SPB_MONTH_ALIASES = {
  baishakh: 1, baisakh: 1, baishak: 1, baisake: 1, baisak: 1, baiskah: 1, vaishakh: 1,
  jestha: 2, jeth: 2, jestta: 2, jesth: 2, jyestha: 2,
  ashadh: 3, ashad: 3, asar: 3, ashar: 3, asadh: 3, aasar: 3, ashadha: 3,
  shrawan: 4, sharawan: 4, shrawn: 4, shravan: 4, saun: 4, srawan: 4, sawan: 4, shrwan: 4,
  bhadra: 5, bhadau: 5, bhadrapad: 5, bhaddra: 5, bharda: 5, bhadro: 5,  // "BHARDA" observed in a real client book
  ashoj: 6, ashwin: 6, asoj: 6, ashwoj: 6, aswin: 6, ashvin: 6,
  kartik: 7, kartick: 7, katik: 7, karthik: 7,
  mangsir: 8, mansir: 8, marga: 8, mangshir: 8, margashir: 8, mangsire: 8, mangsheer: 8,
  poush: 9, paush: 9, push: 9, pous: 9, pausha: 9,
  magh: 10, maagh: 10, maag: 10, magha: 10,
  falgun: 11, fagun: 11, phalgun: 11, phagun: 11, falguna: 11,
  chaitra: 12, chait: 12, chaitraa: 12, chiatra: 12, chaitr: 12,  // "Chiatra" observed in a real client book

  // Devanagari spellings — some books are typed in Nepali.
  'बैशाख': 1, 'बैसाख': 1, 'वैशाख': 1,
  'जेठ': 2, 'जेष्ठ': 2,
  'असार': 3, 'आषाढ': 3, 'अषाढ': 3,
  'साउन': 4, 'श्रावण': 4, 'सावन': 4, 'साउँन': 4,
  'भदौ': 5, 'भाद्र': 5, 'भदौरा': 5,
  'असोज': 6, 'आश्विन': 6, 'अशोज': 6,
  'कार्तिक': 7, 'कात्तिक': 7, 'कातिक': 7,
  'मंसिर': 8, 'मार्ग': 8, 'मङ्सिर': 8, 'मङसिर': 8,
  'पौष': 9, 'पुस': 9, 'पुष': 9,
  'माघ': 10,
  'फागुन': 11, 'फाल्गुन': 11, 'फागुण': 11,
  'चैत': 12, 'चैत्र': 12,
};

// Extract just the B.S. month from any text ("Total Of Shrawan", "माघ",
// "Sharawan") — the shared core for date parsing AND for resolving which
// month an embedded subtotal row claims (the checksum layer). Devanagari
// digits are normalized first so mixed-script cells tokenize cleanly.
function spbMonthFromText(text) {
  const tokens = NepaliLocale.toEnglishDigits(String(text || '')).toLowerCase().match(/[a-zऀ-ॿ]+|\d+/g);
  if (!tokens) return null;
  for (const tok of tokens) {
    if (!/^[a-zऀ-ॿ]+$/.test(tok)) continue;
    if (SPB_MONTH_ALIASES[tok] != null) return SPB_MONTH_ALIASES[tok];
    if (/^[a-z]+$/.test(tok)) {
      const fuzzy = spbFuzzyMonthMatch(tok);
      if (fuzzy != null) return fuzzy;
    }
  }
  return null;
}

// One canonical spelling per month, used only as the target set for fuzzy
// matching below — the exhaustive alias list above already covers every
// commonly-seen variant we've observed; this is the safety net for the ones
// we haven't (a stray typo in some client's book).
const SPB_MONTH_CANONICAL = ['baishakh', 'jestha', 'ashadh', 'shrawan', 'bhadra', 'ashoj', 'kartik', 'mangsir', 'poush', 'magh', 'falgun', 'chaitra'];

// Last-resort fuzzy match for an alpha token that isn't in the alias table —
// e.g. an unanticipated misspelling. Requires a fairly close match (and a
// minimum length) so it can't mistake an unrelated word for a month name.
function spbFuzzyMonthMatch(tok) {
  if (tok.length < 4) return null;
  let best = 0, bestIdx = -1;
  SPB_MONTH_CANONICAL.forEach((name, i) => {
    const sim = stringSimilarity(tok, name);
    if (sim > best) { best = sim; bestIdx = i; }
  });
  return best >= 0.75 ? bestIdx + 1 : null;
}

// Returns { year, mon, day, approxDay } or null. `fyStartYear` lets us infer
// a missing year from the month's position in the fiscal year (Shrawan–
// Chaitra = fyStartYear, Baishakh–Ashadh = fyStartYear + 1) when the cell
// only names the month — without a selected FY we refuse to guess the year.
function spbParseMonthNameDate(dateStr, fyStartYear) {
  const mon = spbMonthFromText(dateStr);
  if (mon == null) return null;
  let day = null, year = null;
  const digits = NepaliLocale.toEnglishDigits(String(dateStr || '')).match(/\d+/g) || [];
  digits.forEach(tok => {
    const n = parseInt(tok, 10);
    if (tok.length === 4 && n > 2000 && n < 2200) year = n;
    else if (n >= 1 && n <= 32 && day == null) day = n;
  });
  if (year == null) {
    if (!fyStartYear) return null;
    year = mon >= 4 ? fyStartYear : fyStartYear + 1;
  }
  return { year, mon, day: day || 1, approxDay: day == null };
}

// Pure row-level parse (also exercised headlessly by the verification
// harness — keep it free of DOM access). Returns clean transactions plus
// everything worth reporting about what was skipped or looks wrong.
// `overrides` (optional) is the Data-Doctor correction map keyed by 1-based
// Excel row: {date, party, pan, vat, taxable, taxfree, exclude} — applied on
// top of the raw cells so every correction re-parses from source and stays
// reproducible.
function spbParseRows(rows, headerInfo, fyStartYear, overrides, opts) {
  const { row: hRow, col } = headerInfo;
  const o = opts || {};
  // Sales for a PAN-only (non-VAT-registered) client carry no VAT at all, so
  // the 13% expectation — and the blank-cell auto-fill — must not apply there.
  // Purchases still do: a PAN-only trader buying from a registered vendor pays
  // VAT like anyone else (2026-08-14, user).
  const vatExpected = !(o.section === 'sales' && o.panOnly);
  const amountCols = SPB_AMOUNT_KEYS.map(k => col[k]).filter(c => c != null);
  const txns = [];
  const stats = {
    rowsRead: 0, subtotalsStripped: 0, badDates: [], outsideFy: 0, outsideFyRows: [],
    missingPan: 0, creditRows: 0, vatOutliers: [], unnamed: 0,
    monthNameDates: 0, monthNameSamples: [],
    malformedPan: 0, malformedPanSamples: [],
    embeddedSubtotals: [],       // the stripped rows, kept as an independent checksum
    corrected: 0, excludedByUser: 0,
    blankRowsSkipped: 0,
    nonNumeric: [],              // text typed into an amount column
    vatFilled: [],               // blank VAT cells completed at 13%
    unexpectedVat: [],           // VAT on a PAN-only client's sales
  };
  // The fiscal index of the block of rows an embedded subtotal actually sums,
  // resolved from the transactions themselves rather than from its label — a
  // real client file mislabels one ("TOTAL OF SHRAWAN" over Bhadra's rows).
  let blockStart = 0;
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    // A row is real only if it names a date, party or bill, or carries a
    // non-zero amount. The old test (`any cell !== null && !== ''`) counted a
    // numeric ZERO as content, so the ~100 trailing rows Excel keeps alive
    // with a `=F59*13%` formula became "unreadable date" BLOCKERS — 270 of
    // them on one real client file, burying every genuine finding.
    if (!spbRowIsLive(r, col, amountCols)) { stats.blankRowsSkipped++; continue; }
    stats.rowsRead++;
    const ov = overrides && overrides[i + 1];
    if (ov && ov.exclude) { stats.excludedByUser++; continue; }
    if (ov && Object.keys(ov).length) stats.corrected++;
    let party = String(r[col.party] == null ? '' : r[col.party]).trim();
    if (ov && ov.party != null) party = String(ov.party).trim();
    // Devanagari digits in a numeric date ("२०८१.०४.०१") normalize first.
    let dateStr = NepaliLocale.toEnglishDigits(String(r[col.date] == null ? '' : r[col.date])).trim();
    if (ov && ov.date != null) dateStr = String(ov.date).trim();
    const m = SPB_DATE_RE.exec(dateStr);
    let year, mon, day, approxDay = false;
    if (m) {
      year = parseInt(m[1], 10); mon = parseInt(m[2], 10); day = parseInt(m[3], 10);
    } else {
      const alt = spbParseMonthNameDate(dateStr, fyStartYear);
      if (alt) { year = alt.year; mon = alt.mon; day = alt.day; approxDay = alt.approxDay; }
    }
    const valid = mon >= 1 && mon <= 12 && day >= 1 && day <= 32;
    if (!valid) {
      // The embedded month-subtotal rows are dateless "Total Of <Month>"
      // lines — stripping them is what stops the double-count. Their values
      // are captured, not discarded: the client's own subtotal is an
      // INDEPENDENT record of what the month should sum to, so it becomes a
      // free checksum against our computed totals (spbComputeChecksums).
      if (/total|जम्मा/i.test(party)) {
        stats.subtotalsStripped++;
        const block = txns.slice(blockStart);
        blockStart = txns.length;
        const subMon = spbMonthFromText(party);
        const labelFi = subMon != null ? SPB_BS_MONTHS.indexOf(subMon) : -1;
        // The block the row actually sums is the authority; the label is only
        // cross-checked against it (spbBuildIssues raises `subtotalLabel` when
        // they disagree). Keying off the label alone meant a mislabelled
        // subtotal checked one month twice and left another month unchecked.
        const blockFi = spbMajorityFi(block);
        const sums = {};
        SPB_AMOUNT_KEYS.forEach(k => { sums[k] = spbNum(col[k] != null ? r[col[k]] : 0); });
        stats.embeddedSubtotals.push({
          excelRow: i + 1, label: party,
          fi: blockFi >= 0 ? blockFi : labelFi,
          labelFi, blockFi, blockRows: block.length,
          block: spbSumAmounts(block),
          ...sums,
        });
        continue;
      }
      stats.badDates.push({ excelRow: i + 1, date: dateStr, party });
      continue;
    }
    const fi = SPB_BS_MONTHS.indexOf(mon);
    if (fyStartYear) {
      const expected = mon >= 4 ? fyStartYear : fyStartYear + 1;
      if (year !== expected) {
        stats.outsideFy++;
        if (stats.outsideFyRows.length < 100) stats.outsideFyRows.push({ excelRow: i + 1, date: dateStr, party, year, mon, day, expected });
      }
    }
    // Normalize month-name-only rows to a real date (day defaults to the
    // 1st) so the generated book sorts and displays consistently — the
    // original text is preserved in the reported sample, never silently lost.
    const normDate = m ? dateStr : `${year}.${String(mon).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
    if (!m) {
      stats.monthNameDates++;
      if (stats.monthNameSamples.length < 5) stats.monthNameSamples.push({ excelRow: i + 1, raw: dateStr, normalized: normDate, approxDay });
    }
    // ── Amounts ──
    // Every box is read the same way, so adding a VAT-return column is one
    // entry in SPB_AMOUNT_FIELDS rather than another hand-written pair here.
    const amt = {}, blank = {};
    SPB_AMOUNT_KEYS.forEach(k => {
      const raw = col[k] != null ? r[col[k]] : null;
      blank[k] = raw == null || String(raw).trim() === '';
      const cell = spbNumChecked(raw);
      // Text where an amount belongs ("here", "name M" — all seen in a real
      // client book) used to read as 0 in silence. It still reads as 0, but
      // the user is told which cell was ignored.
      if (cell.bad && stats.nonNumeric.length < 100) {
        stats.nonNumeric.push({ excelRow: i + 1, party, column: spbAmountLabel(k), text: String(raw).trim() });
      }
      amt[k] = cell.n;
      if (ov && ov[k] != null) { amt[k] = spbNum(ov[k]); blank[k] = false; }
    });
    // A blank VAT cell next to a taxable amount is completed at 13% and
    // reported (2026-08-14, user). A VAT that is PRESENT but wrong is never
    // touched — it goes to Data Doctor as `vatOutliers` with a one-click fix,
    // because a disagreeing VAT is often how an entry error is spotted.
    if (vatExpected) {
      SPB_VAT_PAIRS.forEach(([base, vk]) => {
        if (col[vk] == null || !blank[vk] || amt[base] === 0) return;
        amt[vk] = Math.round(amt[base] * 0.13 * 100) / 100;
        if (stats.vatFilled.length < 100) stats.vatFilled.push({ excelRow: i + 1, party, column: spbAmountLabel(vk), value: amt[vk] });
      });
    }
    const taxfree = amt.taxfree, taxable = amt.taxable, vat = amt.vat;
    let pan = spbNormPan(col.pan != null ? r[col.pan] : '');
    if (ov && ov.pan != null) pan = spbNormPan(ov.pan);
    if (!pan) stats.missingPan++;
    else if (!spbIsValidPan(pan)) {
      // Not 9 digits — almost certainly a typo, not a real PAN. Kept on the
      // row (still shown in the output), but excluded from the party-
      // duplicate-detection evidence (spbPansBySafeKey) so a mistyped PAN
      // can never wrongly split an otherwise-single party in two.
      stats.malformedPan++;
      if (stats.malformedPanSamples.length < 100) stats.malformedPanSamples.push({ excelRow: i + 1, party, pan });
    }
    if (!party) stats.unnamed++;
    if (taxable < 0 || vat < 0) stats.creditRows++;
    // VAT is a flat 13% — a row that strays by more than 1% (or Rs 1) is
    // either exempt-mixed or a typo; surfaced, never auto-corrected. Checked
    // for every taxable box (domestic, import, capital) the sheet carries.
    if (vatExpected) {
      SPB_VAT_PAIRS.forEach(([base, vk]) => {
        if (col[vk] == null || amt[base] === 0) return;
        const expectedVat = amt[base] * 0.13;
        if (Math.abs(amt[vk] - expectedVat) > Math.max(1, Math.abs(expectedVat) * 0.01)) {
          stats.vatOutliers.push({
            excelRow: i + 1, party, field: base, vatField: vk, column: spbAmountLabel(vk),
            taxable: amt[base], vat: amt[vk], expected: Math.round(expectedVat * 100) / 100,
          });
        }
      });
    } else if (amt.vat !== 0) {
      // PAN-only client: a VAT figure on a SALES row is a category error —
      // they are not registered to charge it.
      stats.unexpectedVat.push({ excelRow: i + 1, party, vat: amt.vat });
    }
    txns.push({
      date: normDate, y: year, m: mon, d: day, fi, xr: i + 1,
      bill: r[col.bill] != null ? r[col.bill] : '',
      party: party || '(UNNAMED)',
      pan, ...amt, src: txns.length,
    });
  }
  return { txns, stats };
}

// ── Row-level helpers, shared by the parser ──
// A row counts as real data if it identifies itself (date / party / bill) or
// carries money. Formula-only leftovers evaluating to 0 do neither.
function spbRowIsLive(r, col, amountCols) {
  const txt = idx => idx != null && r[idx] != null && String(r[idx]).trim() !== '';
  if (txt(col.date) || txt(col.party) || txt(col.bill)) return true;
  return amountCols.some(c => spbNum(r[c]) !== 0);
}

// spbNum's silent 0 is right for blanks and wrong for text — this variant
// keeps the 0 but says whether the cell held something unparseable.
function spbNumChecked(v) {
  if (v == null || String(v).trim() === '') return { n: 0, bad: false };
  if (typeof v === 'number') return { n: isNaN(v) ? 0 : v, bad: isNaN(v) };
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? { n: 0, bad: true } : { n, bad: false };
}

function spbAmountLabel(key) {
  const f = SPB_AMOUNT_FIELDS.find(x => x.key === key);
  return f ? f.label : key;
}

function spbSumAmounts(list) {
  const out = {};
  SPB_AMOUNT_KEYS.forEach(k => { out[k] = 0; });
  list.forEach(x => { SPB_AMOUNT_KEYS.forEach(k => { out[k] += x[k] || 0; }); });
  return out;
}

// Which fiscal month a block of rows belongs to, by row count (a stray
// mis-dated row inside a month's block must not rename the whole block).
function spbMajorityFi(list) {
  const counts = new Map();
  list.forEach(x => counts.set(x.fi, (counts.get(x.fi) || 0) + 1));
  let best = 0, fi = -1;
  counts.forEach((n, k) => { if (n > best) { best = n; fi = k; } });
  return fi;
}

// The figure that goes on the filed VAT return: capital purchase is entered in
// its own column but is REPORTED inside taxable purchase (2026-08-14, user).
function spbReturnTaxable(o) {
  return (o.taxable || 0) + (o.cap || 0);
}

function spbReturnVat(o) {
  return (o.vat || 0) + (o.capVat || 0);
}

// Called once per file as its read settles. The whole downstream pipeline —
// parsing, the Data Doctor, the reconciliation grid, the workbook preview —
// used to run OUTSIDE any try/catch, straight inside the FileReader callback,
// so anything it threw vanished into an unhandled error and left the user
// staring at "⏳ Reading…" with no explanation. A crash must always reach the
// status box.
function spbFinishRead(found, notes, remaining) {
  if (remaining > 0) return;
  try {
    spbAfterRead(found, notes);
  } catch (err) {
    console.error('[Autobooks] import pipeline failed', err);
    spbReset();
    spbStatus('❌ The import failed while processing the sheets — ' +
      escHtml(err && err.message ? err.message : String(err)) +
      '. Nothing was imported; the browser console has the details.', 'error');
  }
}

function spbHandleFiles(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  spbStatus('⏳ Reading ' + files.length + ' file(s)…', 'searching');
  const found = { sales: null, purchase: null };
  const notes = [];
  let pending = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        await LibLoader.ensure('xlsx');
        const wb = XLSX.read(e.target.result, { type: 'array' });
        let claimed = false;
        wb.SheetNames.forEach(sn => {
          let kind = spbClassifySheet(sn);
          // Single-sheet exports often carry a generic sheet name — fall back
          // to the file name (Bikri/Kharid appear in the firm's real files).
          if (!kind && wb.SheetNames.length === 1) kind = spbClassifySheet(file.name);
          if (!kind) return;
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
          const header = spbFindHeader(rows);
          if (found[kind]) { notes.push(`Second ${kind} sheet ("${sn}" in ${file.name}) ignored — already loaded one.`); return; }
          // No recognizable header is no longer a dead end: the sheet is kept
          // (header: null) and the column-mapping card lets the user assign
          // Date/Party/... columns by hand, then it parses like any other.
          if (!header) notes.push(`"${sn}" in ${file.name} looks like a ${kind} sheet but its columns weren't auto-recognized — use "Column mapping" below to assign them.`);
          found[kind] = { rows, header, source: file.name + ' → ' + sn };
          claimed = true;
        });
        if (!claimed && !wb.SheetNames.some(sn => spbClassifySheet(sn))) {
          notes.push(`${file.name}: no Sales or Purchase sheet recognized (sheets: ${wb.SheetNames.join(', ')}).`);
        }
      } catch (err) {
        notes.push(`${file.name}: could not read — ${err.message}`);
      }
      spbFinishRead(found, notes, --pending);
    };
    // Without this the counter never reaches zero on a read failure and the
    // status box sits on "⏳ Reading…" forever.
    reader.onerror = () => {
      notes.push(`${file.name}: the browser could not read the file.`);
      spbFinishRead(found, notes, --pending);
    };
    reader.readAsArrayBuffer(file);
  });
  input.value = '';
}

// Bare month-name dates (no year in the cell) borrow the SELECTED fiscal
// year to fill in a calendar year — so if that selector doesn't match the
// file, every such row gets tagged with the wrong year (grouping by month is
// still correct; only the printed date is wrong). Filenames commonly carry
// the real F.Y. ("...2081.082...", "...2081-82...") — a cheap cross-check.
function spbGuessFyFromText(text) {
  const m = String(text || '').match(/20[7-9]\d/);
  return m ? parseInt(m[0], 10) : null;
}

function spbAfterRead(found, notes) {
  if (!found.sales && !found.purchase) {
    spbStatus('❌ ' + escHtml(notes.join(' ') || 'No usable sheets found.'), 'error');
    return;
  }
  const fyStart = spbFyStartYear();
  if (fyStart) {
    const guessed = [found.sales && found.sales.source, found.purchase && found.purchase.source]
      .map(spbGuessFyFromText).find(y => y != null);
    if (guessed != null && guessed !== fyStart) {
      notes.push(`⚠ The uploaded file name suggests F.Y. ${guessed}-${String((guessed + 1) % 100).padStart(2, '0')}, but F.Y. ${spbVal('spb-fy')} is selected above. Rows dated by month name only (no year in the cell) use the SELECTED fiscal year to fill in the year — double-check the selector before generating, or those rows' printed dates will land in the wrong calendar year.`);
    }
  }
  // Fresh import — reset every decision layer.
  spbRaw = found;
  spbOverrides = { sales: {}, purchase: {} };
  spbCorrectionLog = [];
  spbDismissed = new Set();
  spbAutoUndone = new Set();
  spbMergeMap = {};
  spbImportNotes = notes;
  spbVr = spbBlankVr();
  spbVrLoadDraft();          // restore this client+FY's typed figures if drafted
  spbReparse();
  const parts = SPB_SECTIONS.filter(s => spbData[s.key])
    .map(s => `${s.label}: ${spbData[s.key].txns.length} transactions`);
  document.getElementById('spb-generate-btn').disabled = parts.length === 0;
  if (!parts.length) {
    spbStatus('⚠️ Sheets loaded, but no columns were recognized — assign them in "Column mapping" below.', 'info');
  } else {
    spbStatus('✅ Imported — ' + escHtml(parts.join(' · ')) +
      (found.sales && found.purchase ? '' : ' ⚠️ Only one of the two books was found.'), 'success');
  }
}

function spbParseAll(fyStartYear) {
  spbData = { sales: null, purchase: null };
  SPB_SECTIONS.forEach(({ key }) => {
    const raw = spbRaw && spbRaw[key];
    if (!raw || !raw.header) return;          // header may be null until mapped by hand
    spbData[key] = spbParseRows(raw.rows, raw.header, fyStartYear, spbOverrides[key],
      { section: key, panOnly: spbIsPanOnly() });
    spbData[key].source = raw.source;
  });
}

// Everything downstream of the raw sheets, re-runnable: called on first
// import, after every Data-Doctor correction, after a column-mapping change,
// and on FY change. Corrections NEVER mutate parsed rows — they re-parse
// from source with the overrides applied, so state can't drift.
function spbReparse() {
  const fyStart = spbFyStartYear();
  spbParseAll(fyStart);
  // Obvious typos are corrected on the spot, then everything is re-derived
  // from the corrected rows — a mistyped PAN otherwise splits one party into
  // two on every sheet downstream. One extra pass, never a loop: the second
  // parse already has the overrides applied, so spbAutoFix finds nothing new.
  if (spbAutoFix()) spbParseAll(fyStart);
  spbBook = spbComputeBook();
  spbChecksums = spbComputeChecksums();
  spbGroups = spbComputeGroups();
  spbSuggestions = spbBuildSuggestions();     // rebuilt from corrected data; merge ticks re-default
  spbBuildIssues();
  spbRenderImportSummary(spbImportNotes);
  spbRenderMapping();
  spbRenderDoctor();
  spbRenderSuggestions();
  spbRenderVrGrid();
  // Everything downstream of the raw sheets has just changed, so the register
  // and the saved-book card have to follow. Guarded because the ledger layer is
  // a separate file loaded after this one.
  if (typeof spbLedgerAfterReparse === 'function') spbLedgerAfterReparse();
}

function spbReset() {
  spbData = null; spbBook = null; spbGroups = null;
  spbSuggestions = []; spbMergeMap = {}; spbVr = null;
  spbRaw = null; spbOverrides = null; spbCorrectionLog = [];
  spbDismissed = null; spbIssues = []; spbChecksums = null; spbImportNotes = [];
  spbAutoUndone = new Set();
  ['spb-import-card', 'spb-map-card', 'spb-doctor-card', 'spb-merge-card', 'spb-vr-card'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById('spb-generate-btn').disabled = true;
  spbStatus('', 'info');
  // The ledger layer (js/salesPurchaseBookLedger.js) holds the saved-book id
  // and the confirmation figures. A client switch must clear those too, or the
  // next client's screen would still point at the previous client's book.
  if (typeof spbLedgerReset === 'function') spbLedgerReset();
  // Same for the data-entry sheet (js/salesPurchaseBookEntry.js) — its rows
  // belong to the client they were typed under; the draft survives per key.
  if (typeof spbEntryReset === 'function') spbEntryReset();
}

// ════════════════════════════════════════════
//  DERIVED DATA — book totals per fiscal month, and party groups (with
//  approved merges applied). Both recompute from the clean transactions,
//  so book figures can never drift from what was imported.
// ════════════════════════════════════════════
// A month's book figures. `t/v/f` are the original three (taxable / VAT /
// taxfree) and are kept under those short names because the reconciliation
// grid, the drafts in localStorage and the Monthly sheet all key off them.
// The import/capital boxes join them under their own keys rather than
// renaming everything.
function spbBlankMonth() {
  return { t: 0, v: 0, f: 0, imp: 0, impVat: 0, cap: 0, capVat: 0 };
}

function spbComputeBook() {
  const book = {};
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) { book[key] = null; return; }
    const months = SPB_BS_MONTHS.map(spbBlankMonth);
    spbData[key].txns.forEach(x => {
      const o = months[x.fi];
      o.t += x.taxable; o.v += x.vat; o.f += x.taxfree;
      o.imp += x.imp || 0; o.impVat += x.impVat || 0;
      o.cap += x.cap || 0; o.capVat += x.capVat || 0;
    });
    book[key] = months;
  });
  return book;
}

// ════════════════════════════════════════════
//  CHECKSUMS — the embedded month-subtotal rows we strip are the CLIENT'S
//  OWN independent record of each month's total. Comparing them against our
//  computed sums audits every import for free: a disagreement means the
//  client's file itself is internally inconsistent (rows added/deleted/
//  edited after their subtotal was written) — pointed at the exact month.
// ════════════════════════════════════════════
const SPB_CHECKSUM_TOL = 0.015;   // float-dust guard; a real gap is rupees, not paisa

function spbComputeChecksums() {
  const out = {};
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key] || !spbBook[key]) { out[key] = null; return; }
    const res = { rows: [], mismatches: 0, unresolved: 0 };
    spbData[key].stats.embeddedSubtotals.forEach(sub => {
      if (sub.fi < 0 || !sub.blockRows) { res.unresolved++; return; }   // nothing identifiable to compare against
      // Compared against the BLOCK the subtotal actually sums, not the whole
      // fiscal month. Same independence (their figure vs our transactions),
      // but exact when a month is written as more than one block, and immune
      // to a mislabelled heading.
      const b = sub.block;
      const diffs = { t: sub.taxable - b.taxable, v: sub.vat - b.vat, f: sub.taxfree - b.taxfree };
      const ok = SPB_AMOUNT_KEYS.every(k => Math.abs((sub[k] || 0) - (b[k] || 0)) <= SPB_CHECKSUM_TOL);
      if (!ok) res.mismatches++;
      res.rows.push({ label: sub.label, excelRow: sub.excelRow, fi: sub.fi, ok, diffs, embedded: { t: sub.taxable, v: sub.vat, f: sub.taxfree } });
    });
    out[key] = res;
  });
  return out;
}

// Internal tie-out, run immediately before generating: the transactions,
// the party groups, and the monthly book must all sum to the same figures.
// They're computed from the same txns so they can only disagree if a bug
// (or an unforeseen edge case) crept in — in which case the workbook must
// refuse to generate rather than write a wrong file.
function spbTieOut() {
  const problems = [];
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    // Every amount column is tied out, not just the original three — a new
    // VAT-return box that silently failed to reach the party groups or the
    // monthly totals would otherwise print a wrong workbook without a word.
    const MONTH_ALIAS = { taxable: 't', vat: 'v', taxfree: 'f' };
    const sumBy = (arr, pick) => arr.reduce((a, x) => {
      SPB_AMOUNT_KEYS.forEach(k => { a[k] += x[pick(k)] || 0; });
      return a;
    }, SPB_AMOUNT_KEYS.reduce((a, k) => (a[k] = 0, a), {}));
    const fromTxns = sumBy(spbData[key].txns, k => k);
    const fromGroups = sumBy(spbGroups[key], k => k);
    const fromMonthly = sumBy(spbBook[key], k => MONTH_ALIAS[k] || k);
    [['party groups', fromGroups], ['monthly totals', fromMonthly]].forEach(([what, sums]) => {
      SPB_AMOUNT_KEYS.forEach(fld => {
        if (Math.abs(sums[fld] - fromTxns[fld]) > 0.01) {
          problems.push(`${label}: ${what} ${spbAmountLabel(fld)} ${spbFmt(sums[fld])} ≠ transactions ${spbFmt(fromTxns[fld])}`);
        }
      });
    });
  });
  return { ok: problems.length === 0, problems };
}

// Byte-identical (post-normalization) names are NOT proof of one entity —
// two unrelated companies can share a name (the reference file proved it:
// "Muktinath Food Products" appears against two different PANs). So before
// grouping, find every safeKey that carries more than one distinct PAN —
// those get split into one group PER PAN (plus a shared bucket for any
// blank-PAN rows under that name), instead of silently merging. A name that
// agrees on a single PAN (or has none at all) groups exactly as before.
function spbPansBySafeKey(txns) {
  const map = new Map();
  txns.forEach(x => {
    if (!spbIsValidPan(x.pan)) return;
    const sk = spbSafeKey(x.party);
    if (!map.has(sk)) map.set(sk, new Set());
    map.get(sk).add(x.pan);
  });
  return map;
}

// NUL joins the safeKey to the PAN — a normalized name legitimately contains
// spaces, so a plain separator couldn't be split back apart safely.
function spbGroupKey(x, pansBySafeKey) {
  const sk = spbSafeKey(x.party);
  const pans = pansBySafeKey.get(sk);
  return (pans && pans.size > 1 && spbIsValidPan(x.pan)) ? sk + ' ' + x.pan : sk;
}

// Concatenated Sales + Purchase transactions — the PAN-conflict split (and
// the merge decisions built on it) must be computed from the SAME evidence
// in both books, or a party could split in one book but not the other and
// a ticked merge in the review UI would silently fail to apply to one side.
function spbAllTxns() {
  return SPB_SECTIONS.reduce((acc, { key }) => spbData[key] ? acc.concat(spbData[key].txns) : acc, []);
}

// ════════════════════════════════════════════
//  AUTO-CORRECTION — the two mistakes the firm makes most often, and the only
//  two safe enough to apply without asking (2026-08-14, user decision):
//
//   · panOutlier — a party whose rows overwhelmingly carry one PAN, with a
//     single row one digit out. Today that row is a WELL-FORMED 9-digit PAN,
//     so spbIsValidPan accepts it and spbPansBySafeKey splits the party in
//     two ("Dipika Trade link (PAN 602359285)" + "(PAN 602389285)").
//   · nameTypo — one PAN carrying two spellings that are all but identical
//     ("Arpit Traders" / "Arpit Trades").
//
//  This NARROWS the §15 rule "Autobooks never auto-merges parties on PAN"; it
//  does not reverse it. The two cases that rule protects are untouched: one
//  PAN spanning two UNRELATED companies fails the name-similarity gate, and
//  one NAME spanning two real entities is a PAN split, which neither detector
//  performs. Everything looser still goes to the review list, unticked.
//
//  Every auto-fix goes through spbSetOverride, so it is logged, listed in the
//  Data Doctor with an Undo, written into the Corrections sheet, and cleared
//  by "Reset corrections". Nothing is corrected invisibly.
// ════════════════════════════════════════════
const SPB_AUTOFIX_NAME_SIM = 0.90;   // same PAN + this similar ⇒ one party, typed twice
const SPB_AUTOFIX_PAN_DIST = 1;      // a single wrong/dropped digit
const SPB_AUTOFIX_PAN_RATIO = 5;     // the majority must outweigh the outlier this heavily
const SPB_AUTOFIX_MIN_NAME_LEN = 6;  // short names are all similar to each other

// Undone auto-fixes, so a reparse can't silently reapply what the user rejected.
let spbAutoUndone = new Set();

function spbAutoKey(section, excelRow, field) { return section + '|' + excelRow + '|' + field; }

function spbAutoApply(section, excelRow, field, from, to) {
  if (spbAutoUndone.has(spbAutoKey(section, excelRow, field))) return false;
  const existing = spbOverrides[section][excelRow];
  if (existing && existing[field] != null) return false;   // a manual fix always wins
  spbSetOverride(section, excelRow, field, from, to, true);
  return true;
}

// Returns how many corrections were applied — non-zero means the caller must
// re-parse so everything downstream sees the corrected rows.
function spbAutoFix() {
  if (!spbData) return 0;
  let applied = 0;
  const rowsOf = key => (spbData[key] ? spbData[key].txns : []);

  // ── Pass 1: PAN outliers, keyed on the party name ──
  const bySafeKey = new Map();
  SPB_SECTIONS.forEach(({ key }) => rowsOf(key).forEach(x => {
    const sk = spbSafeKey(x.party);
    if (!bySafeKey.has(sk)) bySafeKey.set(sk, []);
    bySafeKey.get(sk).push({ section: key, x });
  }));
  // The PAN each row should carry once pass 1 has run — pass 2 needs the
  // corrected value, and re-parsing between the two passes would cost a
  // second full parse for nothing.
  const fixedPan = new Map();
  bySafeKey.forEach(list => {
    const counts = new Map();
    list.forEach(({ x }) => { if (spbIsValidPan(x.pan)) counts.set(x.pan, (counts.get(x.pan) || 0) + 1); });
    if (counts.size < 2) return;
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const [majorPan, majorCount] = ranked[0];
    ranked.slice(1).forEach(([pan, count]) => {
      if (majorCount < count * SPB_AUTOFIX_PAN_RATIO) return;
      if (damerauLevenshtein(pan, majorPan) > SPB_AUTOFIX_PAN_DIST) return;
      list.forEach(({ section, x }) => {
        if (x.pan !== pan) return;
        if (spbAutoApply(section, x.xr, 'pan', pan, majorPan)) applied++;
        fixedPan.set(section + '|' + x.xr, majorPan);
      });
    });
  });

  // ── Pass 2: name spellings under one PAN ──
  const byPan = new Map();
  SPB_SECTIONS.forEach(({ key }) => rowsOf(key).forEach(x => {
    const pan = fixedPan.get(key + '|' + x.xr) || x.pan;
    if (!spbIsValidPan(pan)) return;
    if (!byPan.has(pan)) byPan.set(pan, []);
    byPan.get(pan).push({ section: key, x });
  }));
  byPan.forEach(list => {
    const counts = new Map();
    list.forEach(({ x }) => counts.set(x.party, (counts.get(x.party) || 0) + 1));
    if (counts.size < 2) return;
    // Dominant spelling = most rows, ties broken by length (the fuller name is
    // more often the correct one — "Traders" vs a truncated "Trader").
    const dominant = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    const domFuzzy = spbFuzzyKey(dominant);
    if (domFuzzy.length < SPB_AUTOFIX_MIN_NAME_LEN) return;
    counts.forEach((_, name) => {
      if (name === dominant) return;
      const f = spbFuzzyKey(name);
      if (f.length < SPB_AUTOFIX_MIN_NAME_LEN) return;
      if (stringSimilarity(f, domFuzzy) < SPB_AUTOFIX_NAME_SIM) return;
      list.forEach(({ section, x }) => {
        if (x.party !== name) return;
        if (spbAutoApply(section, x.xr, 'party', name, dominant)) applied++;
      });
    });
  });

  if (applied) {
    AuditLog.record('spb_autofix', {
      module: 'salesPurchaseBook',
      clientName: spbVal('spb-company'),
      detail: { corrections: applied },
    });
  }
  return applied;
}

function spbUndoAutoFix(idx) {
  const iss = spbIssues[idx];
  if (!iss || iss.type !== 'autoFix') return;
  iss.entries.forEach(e => {
    spbAutoUndone.add(spbAutoKey(e.section, e.excelRow, e.field));
    const o = spbOverrides[e.section][e.excelRow];
    if (o) {
      delete o[e.field];
      if (!Object.keys(o).length) delete spbOverrides[e.section][e.excelRow];
    }
    spbCorrectionLog = spbCorrectionLog.filter(l => !(l.section === e.section && l.excelRow === e.excelRow && l.field === e.field));
  });
  spbReparse();
  spbStatus('↩️ Auto-correction undone — the rows are back exactly as typed in the file.', 'info');
}

function spbComputeGroups() {
  const out = {};
  const pansBySafeKey = spbPansBySafeKey(spbAllTxns());
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) { out[key] = null; return; }
    const map = new Map();
    spbData[key].txns.forEach(x => {
      let k = spbGroupKey(x, pansBySafeKey);
      k = spbMergeMap[k] || k;
      if (!map.has(k)) {
        map.set(k, { key: k, names: new Map(), pans: new Map(), rows: [], ...SPB_AMOUNT_KEYS.reduce((a, f) => (a[f] = 0, a), {}) });
      }
      const g = map.get(k);
      g.names.set(x.party, (g.names.get(x.party) || 0) + 1);
      // Only a well-formed PAN counts toward "does this group agree on one
      // PAN" — a malformed outlier (typo) shouldn't blank out an otherwise-
      // unanimous subtotal PAN.
      if (spbIsValidPan(x.pan)) g.pans.set(x.pan, (g.pans.get(x.pan) || 0) + 1);
      g.rows.push(x);
      SPB_AMOUNT_KEYS.forEach(f => { g[f] += x[f] || 0; });
    });
    const groups = Array.from(map.values());
    groups.forEach(g => {
      // Display name = the most frequent raw spelling (tie → longest).
      g.display = Array.from(g.names.entries())
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      // PAN shown on subtotal rows only when the group's rows agree on one.
      g.pan = g.pans.size === 1 ? Array.from(g.pans.keys())[0] : '';
      // A same-name/different-PAN split leaves two rows both labeled e.g.
      // "Muktinath Food Products Total" unless disambiguated — tag which
      // PAN (or "no PAN") each one is, so it reads as separate parties
      // rather than as a duplicate-looking bug, until the user merges them.
      // Skipped once a group has genuinely absorbed 2+ PANs (g.pans.size >
      // 1) — that only happens after the user ticks a merge in the review
      // list, at which point it's a deliberate single entity, not a
      // still-open conflict, and the suffix would misleadingly suggest one.
      const baseSafeKey = g.key.split(' ')[0];
      if (g.pans.size <= 1 && pansBySafeKey.get(baseSafeKey) && pansBySafeKey.get(baseSafeKey).size > 1) {
        g.display += g.pan ? ` (PAN ${g.pan})` : ' (PAN not specified)';
      }
      g.rows.sort((a, b) => a.fi - b.fi || a.d - b.d || a.src - b.src);
    });
    groups.sort((a, b) => a.display.toUpperCase() < b.display.toUpperCase() ? -1 : 1);
    out[key] = groups;
  });
  return out;
}

// ════════════════════════════════════════════
//  DUPLICATE-PARTY REVIEW — union-find over safeKeys linked by identical
//  fuzzyKey, shared PAN, or high string similarity (bucketed so the O(n²)
//  Levenshtein never runs across all ~900 parties). PAN-only and
//  similarity-only members default UNCHECKED: a shared PAN in the reference
//  file spanned two unrelated companies, so PAN suggests but never decides.
// ════════════════════════════════════════════
// True only when BOTH sides carry a PAN and share none of them — a real
// conflict. Either side having no PAN can't rule out being the same entity.
function spbPansConflict(a, b) {
  return a.length > 0 && b.length > 0 && !a.some(p => b.includes(p));
}

function spbBuildSuggestions() {
  // Collect per GROUP KEY (post PAN-split, §spbComputeGroups) stats across
  // BOTH sections (one decision, applied to both) — using the same key
  // space spbComputeGroups uses is what lets a same-name/different-PAN
  // split (e.g. two "Muktinath Food Products") surface here as its own
  // review entry instead of never being considered for merging at all.
  const pansBySafeKey = spbPansBySafeKey(spbAllTxns());
  const nodes = new Map();
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) return;
    spbData[key].txns.forEach(x => {
      const k = spbGroupKey(x, pansBySafeKey);
      if (!nodes.has(k)) nodes.set(k, { key: k, fuzzy: spbFuzzyKey(x.party), names: new Map(), pans: new Set(), count: 0, taxable: 0 });
      const n = nodes.get(k);
      n.names.set(x.party, (n.names.get(x.party) || 0) + 1);
      if (spbIsValidPan(x.pan)) n.pans.add(x.pan);
      n.count++; n.taxable += x.taxable;
    });
  });
  const keys = Array.from(nodes.keys());
  const parent = {};
  keys.forEach(k => { parent[k] = k; });
  const find = k => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const byFuzzy = new Map(), byPan = new Map(), byBucket = new Map();
  keys.forEach(k => {
    const n = nodes.get(k);
    if (n.fuzzy) (byFuzzy.get(n.fuzzy) || byFuzzy.set(n.fuzzy, []).get(n.fuzzy)).push(k);
    n.pans.forEach(p => (byPan.get(p) || byPan.set(p, []).get(p)).push(k));
    const bucket = n.fuzzy.slice(0, 3);
    if (bucket) (byBucket.get(bucket) || byBucket.set(bucket, []).get(bucket)).push(k);
  });
  byFuzzy.forEach(list => { for (let i = 1; i < list.length; i++) union(list[0], list[i]); });
  byPan.forEach(list => { for (let i = 1; i < list.length; i++) union(list[0], list[i]); });
  byBucket.forEach(list => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const fa = nodes.get(list[i]).fuzzy, fb = nodes.get(list[j]).fuzzy;
        if (fa === fb) continue;
        if (Math.abs(fa.length - fb.length) > 6) continue;
        if (stringSimilarity(fa, fb) >= 0.88) union(list[i], list[j]);
      }
    }
  });

  const comps = new Map();
  keys.forEach(k => {
    const r = find(k);
    (comps.get(r) || comps.set(r, []).get(r)).push(k);
  });
  const suggestions = [];
  comps.forEach(memberKeys => {
    if (memberKeys.length < 2) return;
    const members = memberKeys.map(k => nodes.get(k));
    // Anchor = highest-volume member; punctuation-level variants of it start
    // checked, everything looser starts unchecked for the user to decide.
    // "Variant of the anchor" must be judged against the WHOLE identical-
    // fuzzy-text cluster, not the anchor alone — if the anchor itself
    // happens to be one half of a genuine same-name/different-PAN conflict
    // (its row count says nothing about which of two real companies is
    // "correct"), comparing only to the anchor would default IT to checked
    // by definition (nothing conflicts with itself) while leaving its
    // conflicting twin unchecked, which is an arbitrary, misleading split.
    // So: if ANY pair within the identical-name cluster has a real PAN
    // conflict, NONE of that cluster defaults checked.
    members.sort((a, b) => b.count - a.count);
    const anchorFuzzy = members[0].fuzzy;
    const sameFuzzy = members.filter(n => n.fuzzy === anchorFuzzy);
    const clusterHasConflict = sameFuzzy.some((a, i) =>
      sameFuzzy.some((b, j) => i < j && spbPansConflict(Array.from(a.pans), Array.from(b.pans))));
    suggestions.push({
      members: members.map(n => {
        const pans = Array.from(n.pans);
        return {
          key: n.key,
          display: Array.from(n.names.entries()).sort((a, b) => b[1] - a[1])[0][0],
          count: n.count,
          taxable: n.taxable,
          pans,
          checked: n.fuzzy === anchorFuzzy && !clusterHasConflict,
        };
      }),
      panConflict: new Set(members.flatMap(n => Array.from(n.pans))).size > 1,
    });
  });
  suggestions.sort((a, b) => b.members[0].taxable - a.members[0].taxable);
  return suggestions;
}

function spbToggleMember(gi, mi, checked) {
  if (spbSuggestions[gi] && spbSuggestions[gi].members[mi]) spbSuggestions[gi].members[mi].checked = checked;
}

function spbApplyMerges() {
  spbMergeMap = {};
  let applied = 0;
  spbSuggestions.forEach(g => {
    const on = g.members.filter(m => m.checked);
    if (on.length < 2) return;
    const canon = on.reduce((a, b) => (b.count > a.count ? b : a));
    on.forEach(m => { if (m.key !== canon.key) { spbMergeMap[m.key] = canon.key; applied++; } });
  });
  spbGroups = spbComputeGroups();
  spbRenderImportSummary();
  spbStatus(applied
    ? `✅ Merged ${applied} spelling variant(s). Summary/Details sheets will group them as one party.`
    : 'ℹ️ No merges selected — parties stay exactly as typed.', applied ? 'success' : 'info');
}

// ════════════════════════════════════════════
//  DATA DOCTOR — every problem the import can detect, each with an inline
//  correction the user applies (or explicitly keeps as-is). Corrections are
//  stored as row-level overrides and re-parsed from source (spbReparse), so
//  they're reproducible, loggable, and exportable as a Corrections sheet.
//
//  Two narrow classes ARE applied automatically (spbAutoFix) — single-digit
//  PAN typos and near-identical name spellings under one PAN. They appear
//  here as an `autoFix` card with an Undo, so "automatic" never means
//  "invisible". Everything else still waits for the user.
// ════════════════════════════════════════════
function spbIssueKey(iss) {
  return iss.type + '|' + (iss.section || '') + '|' + (iss.excelRow != null ? iss.excelRow : (iss.refKey || ''));
}

function spbBuildIssues() {
  const issues = [];
  // Auto-corrections first — the user should see what the importer did to
  // their file before they see what it wants them to decide. Grouped by the
  // change made, not one card per row: a single-digit PAN fix can touch
  // thirty rows and is one decision.
  const autoGroups = new Map();
  spbCorrectionLog.filter(l => l.auto).forEach(l => {
    const k = l.section + '|' + l.field + '|' + l.from + '|' + l.to;
    if (!autoGroups.has(k)) autoGroups.set(k, { ...l, entries: [] });
    autoGroups.get(k).entries.push(l);
  });
  autoGroups.forEach((g, k) => {
    const sec = SPB_SECTIONS.find(s => s.key === g.section);
    issues.push({
      type: 'autoFix', sev: 'info', section: g.section, sectionLabel: sec ? sec.label : g.section,
      refKey: k, field: g.field, from: g.from, to: g.to, entries: g.entries,
    });
  });
  SPB_SECTIONS.forEach(({ key, label }) => {
    const d = spbData[key];
    if (!d) return;
    const s = d.stats;
    // Blockers: rows excluded because their date can't be read.
    s.badDates.forEach(b => issues.push({ type: 'badDate', sev: 'red', section: key, sectionLabel: label, excelRow: b.excelRow, date: b.date, party: b.party }));
    // The client's own subtotal disagreeing with its transactions.
    const cs = spbChecksums && spbChecksums[key];
    if (cs) cs.rows.filter(r => !r.ok).forEach(r => issues.push({ type: 'checksum', sev: 'amber', section: key, sectionLabel: label, excelRow: r.excelRow, refKey: r.label, label: r.label, diffs: r.diffs }));
    // A subtotal whose LABEL names a different month from the rows it sums.
    s.embeddedSubtotals.forEach(sub => {
      if (sub.labelFi < 0 || sub.blockFi < 0 || sub.labelFi === sub.blockFi) return;
      issues.push({
        type: 'subtotalLabel', sev: 'amber', section: key, sectionLabel: label, excelRow: sub.excelRow,
        label: sub.label, labelMonth: SPB_MONTH_NAMES[sub.labelFi], blockMonth: SPB_MONTH_NAMES[sub.blockFi], rows: sub.blockRows,
      });
    });
    // When practically EVERY row is outside the selected fiscal year and they
    // all point at the same one, the selector is wrong, not the book — say so
    // once instead of raising one card per row (a 300-row book would otherwise
    // bury every other finding under 300 identical warnings).
    const impliedYears = new Set(s.outsideFyRows.map(b => (b.mon >= 4 ? b.year : b.year - 1)));
    if (d.txns.length && s.outsideFy >= d.txns.length * 0.8 && impliedYears.size === 1) {
      const implied = Array.from(impliedYears)[0];
      issues.push({
        type: 'fySelector', sev: 'amber', section: key, sectionLabel: label, refKey: 'fySelector',
        implied, impliedLabel: implied + '-' + String((implied + 1) % 100).padStart(2, '0'),
        selected: spbVal('spb-fy'), count: s.outsideFy,
      });
    } else {
      s.outsideFyRows.forEach(b => issues.push({ type: 'fy', sev: 'amber', section: key, sectionLabel: label, excelRow: b.excelRow, date: b.date, party: b.party, year: b.year, expected: b.expected, mon: b.mon, day: b.day }));
    }
    s.vatOutliers.forEach(b => issues.push({ type: 'vat', sev: 'amber', section: key, sectionLabel: label, excelRow: b.excelRow, party: b.party, field: b.field, vatField: b.vatField, column: b.column, taxable: b.taxable, vat: b.vat, expected: b.expected }));
    s.unexpectedVat.forEach(b => issues.push({ type: 'panOnlyVat', sev: 'amber', section: key, sectionLabel: label, excelRow: b.excelRow, party: b.party, vat: b.vat }));
    if (s.nonNumeric.length) {
      issues.push({
        type: 'nonNumeric', sev: 'info', section: key, sectionLabel: label, refKey: 'nonNumeric',
        cells: s.nonNumeric,
      });
    }
    // Possible double entries: same party + same bill + same amounts.
    const dupMap = new Map();
    d.txns.forEach(x => {
      const bill = String(x.bill == null ? '' : x.bill).trim().toLowerCase();
      if (!bill || (!x.taxable && !x.vat && !x.taxfree)) return;
      const k = spbSafeKey(x.party) + '|' + bill + '|' + x.taxable + '|' + x.vat;
      (dupMap.get(k) || dupMap.set(k, []).get(k)).push(x);
    });
    dupMap.forEach(list => {
      if (list.length < 2) return;
      issues.push({ type: 'dup', sev: 'amber', section: key, sectionLabel: label, refKey: list.map(x => x.xr).join(','), rows: list.map(x => ({ excelRow: x.xr, date: x.date, party: x.party, bill: String(x.bill), taxable: x.taxable })) });
    });
    // Malformed PANs, with the party's own valid PAN suggested where one exists.
    const validPanBySafeKey = new Map();
    d.txns.forEach(x => {
      if (!spbIsValidPan(x.pan)) return;
      const sk = spbSafeKey(x.party);
      if (!validPanBySafeKey.has(sk)) validPanBySafeKey.set(sk, new Set());
      validPanBySafeKey.get(sk).add(x.pan);
    });
    s.malformedPanSamples.forEach(b => {
      let suggestion = null, best = 0;
      (validPanBySafeKey.get(spbSafeKey(b.party)) || []).forEach(p => {
        const sim = stringSimilarity(p, String(b.pan));
        if (sim > best) { best = sim; suggestion = p; }
      });
      issues.push({ type: 'pan', sev: 'amber', section: key, sectionLabel: label, excelRow: b.excelRow, party: b.party, pan: b.pan, suggestion });
    });
    // Blank PANs fillable from the same party's rows — only when unambiguous.
    const blankBySafeKey = new Map();
    d.txns.forEach(x => {
      if (x.pan) return;
      const sk = spbSafeKey(x.party);
      (blankBySafeKey.get(sk) || blankBySafeKey.set(sk, []).get(sk)).push(x);
    });
    blankBySafeKey.forEach((list, sk) => {
      const pans = Array.from(validPanBySafeKey.get(sk) || []);
      if (pans.length !== 1) return;
      issues.push({ type: 'panFill', sev: 'info', section: key, sectionLabel: label, refKey: sk, party: list[0].party, pan: pans[0], rows: list.map(x => x.xr) });
    });
    // Sales invoice continuity — missing numbers in a bill series are an IRD
    // audit point. Series = everything before the trailing digits; only
    // series with real volume are checked, so odd one-off bills don't spam.
    if (key === 'sales') {
      const series = new Map();
      d.txns.forEach(x => {
        const m2 = String(x.bill == null ? '' : x.bill).trim().match(/^(.*?)(\d+)$/);
        if (!m2) return;
        (series.get(m2[1]) || series.set(m2[1], []).get(m2[1])).push(parseInt(m2[2], 10));
      });
      series.forEach((nums, pre) => {
        if (nums.length < 10) return;
        const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
        const missing = [];
        for (let i = 1; i < uniq.length && missing.length <= 200; i++) {
          for (let n = uniq[i - 1] + 1; n < uniq[i] && missing.length <= 200; n++) missing.push(n);
        }
        if (!missing.length) return;
        issues.push({ type: 'billGap', sev: 'info', section: key, sectionLabel: label, refKey: pre || '(no prefix)', series: pre, count: uniq.length, min: uniq[0], max: uniq[uniq.length - 1], missing });
      });
    }
  });
  const sevRank = { red: 0, amber: 1, info: 2 };
  issues.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);
  issues.forEach(iss => { iss.dismissed = spbDismissed.has(spbIssueKey(iss)); });
  spbIssues = issues;
}

// One override = one logged, auditable decision. `auto` marks a correction the
// importer made itself (spbAutoFix): it still lands in the log and the
// Corrections sheet, but it doesn't write one AuditLog event per row — a
// single-digit PAN fix can touch thirty rows, and spbAutoFix records one
// summary event instead.
function spbSetOverride(section, excelRow, field, from, to, auto) {
  const o = spbOverrides[section][excelRow] = spbOverrides[section][excelRow] || {};
  o[field] = to;
  spbCorrectionLog = spbCorrectionLog.filter(l => !(l.section === section && l.excelRow === excelRow && l.field === field));
  spbCorrectionLog.push({ section, excelRow, field, from: String(from == null ? '' : from), to: String(to == null ? '' : to), ts: Date.now(), auto: !!auto });
  if (!auto) AuditLog.record('spb_correction', { module: 'salesPurchaseBook', clientName: spbVal('spb-company'), detail: { section, excelRow, field, to: String(to == null ? '' : to) } });
}

function spbDoctorAction(idx, action) {
  const iss = spbIssues[idx];
  if (!iss) return;
  if (action === 'dismiss') {
    spbDismissed.add(spbIssueKey(iss));
    spbBuildIssues();
    spbRenderDoctor();
    return;
  }
  if (action === 'fixDate') {
    const el = document.getElementById('spb-fix-' + idx);
    const vRaw = el ? el.value.trim() : '';
    if (!vRaw) { spbStatus('❌ Type the corrected date first.', 'error'); return; }
    const norm = NepaliLocale.toEnglishDigits(vRaw);
    if (!SPB_DATE_RE.test(norm) && !spbParseMonthNameDate(norm, spbFyStartYear())) {
      spbStatus('❌ "' + escHtml(vRaw) + '" is not a readable B.S. date — try 2081.04.01 or "15 Shrawan".', 'error');
      return;
    }
    spbSetOverride(iss.section, iss.excelRow, 'date', iss.date, norm);
  } else if (action === 'exclude') {
    spbSetOverride(iss.section, iss.excelRow, 'exclude', '', true);
  } else if (action === 'fixVat') {
    spbSetOverride(iss.section, iss.excelRow, iss.vatField || 'vat', iss.vat, iss.expected);
  } else if (action === 'fixPan') {
    if (!iss.suggestion) return;
    spbSetOverride(iss.section, iss.excelRow, 'pan', iss.pan, iss.suggestion);
  } else if (action === 'fillPan') {
    iss.rows.forEach(xr => spbSetOverride(iss.section, xr, 'pan', '', iss.pan));
  } else if (action === 'fixYear') {
    const to = `${iss.expected}.${String(iss.mon).padStart(2, '0')}.${String(iss.day).padStart(2, '0')}`;
    spbSetOverride(iss.section, iss.excelRow, 'date', iss.date, to);
  } else {
    return;
  }
  spbReparse();
  spbStatus('✅ Correction applied — everything recomputed from the source rows.', 'success');
}

// Duplicate-entry card: exclusion is per specific row, not per issue.
function spbDoctorExcludeRow(idx, excelRow) {
  const iss = spbIssues[idx];
  if (!iss) return;
  spbSetOverride(iss.section, excelRow, 'exclude', '', true);
  spbReparse();
  spbStatus('✅ Row ' + excelRow + ' excluded as a duplicate — recomputed.', 'success');
}

function spbSwitchFy(label) {
  const sel = document.getElementById('spb-fy');
  if (!sel) return;
  sel.value = label;
  spbOnContextChange();
  spbStatus('📆 Fiscal year set to ' + escHtml(label) + ' — the book was re-read against it.', 'success');
}

function spbResetCorrections() {
  if (!spbRaw) return;
  if (!confirm('Remove ALL corrections and "keep as-is" decisions for this import, and re-read the file exactly as uploaded?')) return;
  spbOverrides = { sales: {}, purchase: {} };
  spbCorrectionLog = [];
  spbDismissed = new Set();
  // Auto-corrections are re-derived by the reparse below; clearing the
  // undo list is what makes "reset" mean the file's own state, not the
  // file plus whichever auto-fixes happened to be rejected earlier.
  spbAutoUndone = new Set();
  spbReparse();
  spbStatus('↩️ All corrections cleared — back to the file exactly as uploaded.', 'info');
}

function spbIssueHtml(iss, idx) {
  const head = (icon, title) => `<div class="spb-issue-head">${icon} <strong>${escHtml(iss.sectionLabel)}</strong> — ${title}</div>`;
  const dismissBtn = label => `<button class="btn btn-outline btn-sm" onclick="spbDoctorAction(${idx},'dismiss')">${label || 'Keep as-is'}</button>`;
  let inner = '';
  if (iss.type === 'badDate') {
    inner = head('⛔', `row ${iss.excelRow}: unreadable date "${escHtml(iss.date)}" (${escHtml(iss.party)}) — row is EXCLUDED from the book until fixed`) +
      `<div class="spb-issue-actions">
        <input class="spb-in" id="spb-fix-${idx}" placeholder="e.g. 2081.04.01 or 15 Shrawan" style="width:190px; text-align:left;">
        <button class="btn btn-primary btn-sm" onclick="spbDoctorAction(${idx},'fixDate')">Fix date</button>
        <button class="btn btn-outline btn-sm" onclick="spbDoctorAction(${idx},'exclude')">Exclude permanently</button>
      </div>`;
  } else if (iss.type === 'checksum') {
    const worst = ['t', 'v', 'f'].map(f => ({ f, d: iss.diffs[f] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    const fName = worst.f === 't' ? 'Taxable' : worst.f === 'v' ? 'VAT' : 'Tax Free';
    inner = head('🔎', `the file's own "${escHtml(iss.label)}" (row ${iss.excelRow}) disagrees with its transactions by ${spbFmt(worst.d)} on ${fName} — rows were likely added, deleted or edited after that subtotal was written. The generated workbook uses the TRANSACTIONS (recomputed live), but check the source.`) +
      `<div class="spb-issue-actions">${dismissBtn('Understood — use transactions')}</div>`;
  } else if (iss.type === 'fy') {
    inner = head('📅', `row ${iss.excelRow}: dated ${escHtml(iss.date)} (${escHtml(iss.party)}) — year ${iss.year} is outside the selected fiscal year (expected ${iss.expected} for that month)`) +
      `<div class="spb-issue-actions">
        <button class="btn btn-primary btn-sm" onclick="spbDoctorAction(${idx},'fixYear')">Change year to ${iss.expected}</button>
        <button class="btn btn-outline btn-sm" onclick="spbDoctorAction(${idx},'exclude')">Exclude row</button>
        ${dismissBtn()}
      </div>`;
  } else if (iss.type === 'vat') {
    inner = head('🧮', `row ${iss.excelRow}: ${escHtml(iss.party)} — ${escHtml(iss.column || 'VAT')} ${spbFmt(iss.vat)} but 13% of ${spbFmt(iss.taxable)} is ${spbFmt(iss.expected)}`) +
      `<div class="spb-issue-actions">
        <button class="btn btn-primary btn-sm" onclick="spbDoctorAction(${idx},'fixVat')">Set to ${spbFmt(iss.expected)}</button>
        ${dismissBtn('Keep — exempt/mixed supply')}
      </div>`;
  } else if (iss.type === 'autoFix') {
    const what = iss.field === 'pan' ? 'PAN' : iss.field === 'party' ? 'party name' : iss.field;
    inner = head('🪄', `auto-corrected ${escHtml(what)} on ${iss.entries.length} row(s): "${escHtml(iss.from)}" → "${escHtml(iss.to)}" — the rest of the book agrees on the second spelling, so the two were being treated as different parties`) +
      `<div class="spb-issue-sub">rows ${escHtml(iss.entries.map(e => e.excelRow).slice(0, 20).join(', '))}${iss.entries.length > 20 ? '…' : ''}</div>
      <div class="spb-issue-actions">
        <button class="btn btn-outline btn-sm" onclick="spbUndoAutoFix(${idx})">Undo — keep the file's own value</button>
        ${dismissBtn('Correct — hide this')}
      </div>`;
  } else if (iss.type === 'subtotalLabel') {
    inner = head('🏷️', `row ${iss.excelRow} is labelled "${escHtml(iss.label)}" but the ${iss.rows} row(s) it sums are ${escHtml(iss.blockMonth)}, not ${escHtml(iss.labelMonth)} — the generated book uses the ROWS, so the figures are right; the label in your source file is wrong`) +
      `<div class="spb-issue-actions">${dismissBtn('Understood — use the rows')}</div>`;
  } else if (iss.type === 'fySelector') {
    inner = head('📆', `${iss.count} row(s) — practically the whole book — are dated F.Y. ${escHtml(iss.impliedLabel)}, but F.Y. ${escHtml(iss.selected)} is selected above. The fiscal year runs 1 Shrawan to the last day of Ashadh, so 2082.04.01–2083.03.32 is ONE year.`) +
      `<div class="spb-issue-actions">
        <button class="btn btn-primary btn-sm" onclick="spbSwitchFy('${escHtml(iss.impliedLabel)}')">Switch to F.Y. ${escHtml(iss.impliedLabel)}</button>
        ${dismissBtn('Keep the selected year')}
      </div>`;
  } else if (iss.type === 'panOnlyVat') {
    inner = head('🚫', `row ${iss.excelRow}: ${escHtml(iss.party)} carries VAT ${spbFmt(iss.vat)} on a SALE, but this client is registered for PAN only and cannot charge VAT — check the entry, or switch the client to "VAT registered" above`) +
      `<div class="spb-issue-actions">${dismissBtn()}</div>`;
  } else if (iss.type === 'nonNumeric') {
    inner = head('🔤', `${iss.cells.length} amount cell(s) hold text instead of a number — read as 0:`) +
      iss.cells.slice(0, 15).map(c => `<div class="spb-issue-sub">row ${c.excelRow} · ${escHtml(c.column)} · "${escHtml(c.text)}"${c.party ? ' · ' + escHtml(c.party) : ''}</div>`).join('') +
      (iss.cells.length > 15 ? `<div class="spb-issue-sub">…and ${iss.cells.length - 15} more</div>` : '') +
      `<div class="spb-issue-actions">${dismissBtn('Noted — they are notes, not amounts')}</div>`;
  } else if (iss.type === 'dup') {
    inner = head('👯', `possible double entry — same party, bill no. and amount:`) +
      iss.rows.map(r => `<div class="spb-issue-sub">row ${r.excelRow}: ${escHtml(r.date)} · bill ${escHtml(r.bill)} · ${escHtml(r.party)} · ${spbFmt(r.taxable)}
        <button class="btn btn-outline btn-sm" onclick="spbDoctorExcludeRow(${idx},${r.excelRow})">Exclude this row</button></div>`).join('') +
      `<div class="spb-issue-actions">${dismissBtn('Keep all — genuinely separate')}</div>`;
  } else if (iss.type === 'pan') {
    inner = head('🆔', `row ${iss.excelRow}: ${escHtml(iss.party)} — PAN "${escHtml(iss.pan)}" isn't 9 digits (likely a typo)`) +
      `<div class="spb-issue-actions">
        ${iss.suggestion ? `<button class="btn btn-primary btn-sm" onclick="spbDoctorAction(${idx},'fixPan')">Change to ${escHtml(iss.suggestion)} (this party's PAN elsewhere)</button>` : '<span style="color:var(--text-muted); font-size:12.5px;">No valid PAN found for this party elsewhere in the book.</span>'}
        ${dismissBtn()}
      </div>`;
  } else if (iss.type === 'panFill') {
    inner = head('🪪', `${escHtml(iss.party)} — ${iss.rows.length} row(s) have no PAN, but this party's other rows all use ${escHtml(iss.pan)}`) +
      `<div class="spb-issue-actions">
        <button class="btn btn-primary btn-sm" onclick="spbDoctorAction(${idx},'fillPan')">Fill ${escHtml(iss.pan)} on all ${iss.rows.length} row(s)</button>
        ${dismissBtn('Leave blank')}
      </div>`;
  } else if (iss.type === 'billGap') {
    const shown = iss.missing.slice(0, 12).join(', ');
    inner = head('🔢', `sales bill series ${iss.series ? '"' + escHtml(iss.series) + '"' : '(plain numbers)'} runs ${iss.min}–${iss.max} but ${iss.missing.length >= 200 ? '200+' : iss.missing.length} number(s) are missing (${escHtml(shown)}${iss.missing.length > 12 ? '…' : ''}) — invoice continuity is an IRD audit point; check for unrecorded/cancelled bills`) +
      `<div class="spb-issue-actions">${dismissBtn('Noted')}</div>`;
  }
  return `<div class="spb-issue spb-issue-${iss.sev}">${inner}</div>`;
}

function spbRenderDoctor() {
  const card = document.getElementById('spb-doctor-card');
  if (!card) return;
  if (!spbData || (!spbData.sales && !spbData.purchase)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const open = spbIssues.filter(i => !i.dismissed);
  const reds = open.filter(i => i.sev === 'red').length;
  const ambers = open.filter(i => i.sev === 'amber').length;
  const infos = open.filter(i => i.sev === 'info').length;
  let ready;
  if (reds) ready = `<div class="spb-ready spb-ready-red">⛔ ${reds} blocking issue(s) — those rows are EXCLUDED from the book until fixed below.</div>`;
  else if (ambers) ready = `<div class="spb-ready spb-ready-amber">⚠️ ${ambers} warning(s) to review — you can generate, but look at them first.</div>`;
  else ready = `<div class="spb-ready spb-ready-ok">✅ All checks passed${infos ? ` (${infos} informational note(s) below)` : ''} — ready to generate.</div>`;
  const csBits = SPB_SECTIONS.map(({ key, label }) => {
    const cs = spbChecksums && spbChecksums[key];
    if (!cs || !cs.rows.length) return null;
    return `${label} ${cs.rows.filter(r => r.ok).length}/${cs.rows.length} month checksums matched`;
  }).filter(Boolean).join(' · ');
  const meta = `<div style="color:var(--text-muted); font-size:12.5px; margin-bottom:4px;">${spbCorrectionLog.length ? spbCorrectionLog.length + ' correction(s) applied · ' : ''}${spbDismissed.size ? spbDismissed.size + ' kept as-is · ' : ''}${csBits || 'no embedded subtotals to checksum against'}</div>`;
  const body = spbIssues.map((iss, idx) => iss.dismissed ? '' : spbIssueHtml(iss, idx)).join('');
  document.getElementById('spb-doctor-body').innerHTML = ready + meta + body;
}

// ════════════════════════════════════════════
//  COLUMN MAPPING — manual assignment when a sheet's headers weren't
//  auto-recognized (or the user wants to override the detection). Makes
//  virtually any column layout importable.
// ════════════════════════════════════════════
function spbColLetter(n) {
  let s = ''; n++;
  while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// [field, label, required, purchaseOnly]. The amount half is derived from
// SPB_AMOUNT_FIELDS so a new VAT-return box appears in the mapping UI without
// being listed twice.
const SPB_MAP_FIELDS = [
  ['date', 'Date / Month', true], ['bill', 'Bill No.', false], ['party', 'Party Name', true], ['pan', 'PAN', false],
  ...SPB_AMOUNT_FIELDS.map(f => [f.key, f.label, f.key === 'taxable', !!f.purchaseOnly]),
];

function spbMapFieldsFor(section) {
  return SPB_MAP_FIELDS.filter(([, , , purchaseOnly]) => !purchaseOnly || section === 'purchase');
}

function spbRenderMapping() {
  const card = document.getElementById('spb-map-card');
  if (!card) return;
  if (!spbRaw || (!spbRaw.sales && !spbRaw.purchase)) { card.style.display = 'none'; return; }
  const unmapped = SPB_SECTIONS.some(({ key }) => spbRaw[key] && !spbRaw[key].header);
  const show = unmapped || card.dataset.forced === '1';
  card.style.display = show ? 'block' : 'none';
  if (!show) return;
  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    const raw = spbRaw[key];
    if (!raw) return;
    const guessRow = raw.header ? raw.header.row
      : Math.max(0, raw.rows.findIndex(r => (r || []).filter(c => c != null && c !== '').length >= 3));
    const headerCells = raw.rows[guessRow] || [];
    const maxCols = Math.max(1, ...raw.rows.slice(0, 30).map(r => (r || []).length));
    const cur = raw.header ? raw.header.col : {};
    html += `<div class="spb-map-sec">
      <div style="font-weight:600; margin-bottom:8px;">${label} <span style="color:var(--text-muted); font-weight:400;">(${escHtml(raw.source)})</span>
      ${raw.header ? '' : ' — <span class="spb-warn">columns not auto-recognized, assign them:</span>'}</div>
      <div class="spb-map-grid">
        <label>Header row<input class="spb-in" id="spb-map-${key}-row" value="${guessRow + 1}" style="width:56px;"></label>
        ${spbMapFieldsFor(key).map(([f, lab, req]) => `
          <label>${lab}${req ? ' *' : ''}
            <select id="spb-map-${key}-${f}">
              <option value="">—</option>
              ${Array.from({ length: maxCols }, (_, j) =>
                `<option value="${j}"${cur[f] === j ? ' selected' : ''}>${spbColLetter(j)}${headerCells[j] != null && headerCells[j] !== '' ? ' · ' + escHtml(String(headerCells[j]).slice(0, 16)) : ''}</option>`).join('')}
            </select>
          </label>`).join('')}
        <button class="btn btn-primary btn-sm" onclick="spbApplyMapping('${key}')">Apply</button>
      </div>
    </div>`;
  });
  document.getElementById('spb-map-body').innerHTML = html;
}

function spbToggleMapping() {
  const card = document.getElementById('spb-map-card');
  if (!card) return;
  card.dataset.forced = card.dataset.forced === '1' ? '' : '1';
  spbRenderMapping();
}

function spbApplyMapping(key) {
  const raw = spbRaw && spbRaw[key];
  if (!raw) return;
  const rowNum = parseInt(spbVal(`spb-map-${key}-row`), 10);
  const col = {};
  spbMapFieldsFor(key).forEach(([f]) => {
    const v = spbVal(`spb-map-${key}-${f}`);
    if (v !== '') col[f] = parseInt(v, 10);
  });
  if (!(rowNum >= 1) || col.date == null || col.party == null || col.taxable == null) {
    spbStatus('❌ Mapping needs at least the header row plus Date/Month, Party Name and Taxable Amount columns.', 'error');
    return;
  }
  raw.header = { row: rowNum - 1, col };
  spbReparse();
  document.getElementById('spb-generate-btn').disabled = !(spbData.sales || spbData.purchase);
  spbStatus(`✅ ${key === 'sales' ? 'Sales' : 'Purchase'} columns mapped — sheet imported.`, 'success');
}

// ════════════════════════════════════════════
//  RENDER — import summary, duplicate review, reconciliation grid
// ════════════════════════════════════════════
function spbRenderImportSummary(notes) {
  const card = document.getElementById('spb-import-card');
  card.style.display = 'block';
  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    const d = spbData[key];
    if (!d) {
      const pendingMap = spbRaw && spbRaw[key] && !spbRaw[key].header;
      html += `<div class="spb-import-sec"><strong>${label}:</strong> ${pendingMap ? '<span class="spb-warn">sheet loaded, columns not recognized — assign them in Column mapping.</span>' : 'not uploaded.'}</div>`;
      return;
    }
    const s = d.stats;
    const sums = spbSumAmounts(d.txns);
    const total = sums.taxable;
    // Only the boxes this book actually carries get a figure, so an ordinary
    // 7-column book reads exactly as it always did.
    const extra = spbSectionAmountKeys(key)
      .filter(k => k === 'imp' || k === 'cap')
      .map(k => ` · ${spbAmountLabel(k)} ${spbFmt(sums[k])}`).join('');
    const warn = [];
    if (s.badDates.length) warn.push(`<span class="spb-warn">⚠ ${s.badDates.length} row(s) EXCLUDED — unreadable date (rows ${escHtml(s.badDates.slice(0, 5).map(b => b.excelRow).join(', '))}${s.badDates.length > 5 ? '…' : ''}). Fix in the source file and re-upload.</span>`);
    if (s.outsideFy) warn.push(`<span class="spb-warn">⚠ ${s.outsideFy} row(s) dated outside F.Y. ${escHtml(spbVal('spb-fy'))} — check the fiscal year selector.</span>`);
    if (s.vatOutliers.length) warn.push(`<span class="spb-warn">⚠ ${s.vatOutliers.length} row(s) where VAT ≠ 13% of taxable (e.g. row ${s.vatOutliers[0].excelRow}, ${escHtml(String(s.vatOutliers[0].party))}).</span>`);
    if (s.unnamed) warn.push(`<span class="spb-warn">⚠ ${s.unnamed} row(s) with no party name — grouped as “(UNNAMED)”.</span>`);
    if (s.unexpectedVat.length) warn.push(`<span class="spb-warn">⚠ ${s.unexpectedVat.length} sales row(s) carry VAT, but this client is registered for PAN only — see Data Doctor below.</span>`);
    // Auto-filled VAT is a real change to the figures, so it is stated on the
    // face of the summary rather than only in the Data Doctor.
    if (s.vatFilled.length) {
      const ex = s.vatFilled[0];
      warn.push(`<span class="spb-ok">✓ ${s.vatFilled.length} blank VAT cell(s) filled at 13% (e.g. row ${ex.excelRow}, ${escHtml(String(ex.party))} → ${spbFmt(ex.value)}). A VAT that was typed but disagrees is never changed — it is flagged instead.</span>`);
    }
    if (s.nonNumeric.length) {
      const ex = s.nonNumeric[0];
      warn.push(`<span class="spb-warn">ℹ ${s.nonNumeric.length} amount cell(s) hold text and were read as 0 (e.g. row ${ex.excelRow}, ${escHtml(ex.column)}: "${escHtml(ex.text)}").</span>`);
    }
    if (s.monthNameDates) {
      const ex = s.monthNameSamples[0];
      warn.push(`<span class="spb-warn">ℹ ${s.monthNameDates} row(s) dated by MONTH NAME rather than a full date (e.g. row ${ex.excelRow}: "${escHtml(ex.raw)}" → ${escHtml(ex.normalized)}${ex.approxDay ? ', day assumed as the 1st' : ''}). Grouping by month is unaffected; only day-level ordering within the month is approximate.</span>`);
    }
    if (s.malformedPan) {
      const ex = s.malformedPanSamples[0];
      warn.push(`<span class="spb-warn">ℹ ${s.malformedPan} row(s) have a PAN that isn't 9 digits (e.g. row ${ex.excelRow}, ${escHtml(String(ex.party))}: "${escHtml(ex.pan)}") — likely a typo. Kept on the row, but not used to tell two same-named parties apart.</span>`);
    }
    // The embedded-subtotal checksum verdict — the one line that says
    // whether the client's file is internally consistent.
    const cs = spbChecksums && spbChecksums[key];
    let csLine = '';
    if (cs && cs.rows.length) {
      csLine = cs.mismatches
        ? `<br><span class="spb-warn">⚠ Checksum: ${cs.mismatches} of ${cs.rows.length} embedded month subtotal(s) DISAGREE with their own transactions — see Data Doctor below.</span>`
        : `<br><span class="spb-ok">✓ Checksum: all ${cs.rows.length} embedded month subtotals agree with the transactions to the paisa.</span>`;
    }
    const fixedBits = [];
    if (s.corrected) fixedBits.push(`${s.corrected} row(s) corrected`);
    if (s.excludedByUser) fixedBits.push(`${s.excludedByUser} row(s) excluded by you`);
    html += `<div class="spb-import-sec">
      <strong>${label}</strong> <span style="color:var(--text-muted);">(${escHtml(d.source || '')})</span><br>
      ${d.txns.length} transactions · ${spbGroups[key].length} parties · taxable ${spbFmt(total)}${extra}
      · ${s.subtotalsStripped} embedded subtotal row(s) stripped · ${s.missingPan} without PAN · ${s.creditRows} credit note(s)
      ${fixedBits.length ? ' · <span class="spb-ok">' + fixedBits.join(' · ') + '</span>' : ''}${csLine}
      ${warn.length ? '<br>' + warn.join('<br>') : ''}
    </div>`;
  });
  if (notes && notes.length) html += `<div class="spb-import-sec"><span class="spb-warn">${notes.map(escHtml).join('<br>')}</span></div>`;
  document.getElementById('spb-import-body').innerHTML = html;
}

function spbRenderSuggestions() {
  const card = document.getElementById('spb-merge-card');
  if (!spbSuggestions.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('spb-merge-body').innerHTML = spbSuggestions.map((g, gi) => `
    <div class="spb-merge-group">
      ${g.panConflict ? '<div class="spb-warn" style="margin-bottom:6px;">⚠ These names carry different PANs — some may be genuinely different companies. Tick only the ones that are the same party.</div>' : ''}
      ${g.members.map((m, mi) => `
        <label class="spb-merge-item">
          <input type="checkbox" ${m.checked ? 'checked' : ''} onchange="spbToggleMember(${gi},${mi},this.checked)">
          <span style="flex:1;">${escHtml(m.display)}</span>
          <span style="color:var(--text-muted);">${m.pans.length ? 'PAN ' + escHtml(m.pans.join(', ')) : 'no PAN'} · ${m.count} row(s) · ${spbFmt(m.taxable)}</span>
        </label>`).join('')}
    </div>`).join('');
}

// ════════════════════════════════════════════
//  RECONCILIATION MODEL — which figures a section compares against its filed
//  return, described once and consumed by the on-screen grid AND the Monthly
//  sheet, so the two can never show different columns.
//
//  The load-bearing rule: CAPITAL PURCHASE is entered in its own column but
//  filed INSIDE taxable purchase, so the compared "Taxable" figure is
//  taxable + capital (spbReturnTaxable). Capital is still shown, as a memo
//  column, because the staff member needs to see what went into the total.
// ════════════════════════════════════════════
function spbVrModel(key) {
  const keys = spbSectionAmountKeys(key);
  const hasCap = keys.includes('cap');
  const cols = [
    { id: 't', label: hasCap ? 'Taxable (incl. Capital)' : 'Taxable', book: m => spbReturnTaxable(m), diff: true },
    { id: 'v', label: hasCap ? 'VAT (incl. Capital)' : 'VAT', book: m => spbReturnVat(m) },
    { id: 'f', label: 'Taxfree', book: m => m.f, diff: true },
  ];
  if (keys.includes('imp')) {
    cols.push(
      { id: 'imp', label: 'Taxable Import', book: m => m.imp, diff: true },
      { id: 'impVat', label: 'Import VAT', book: m => m.impVat });
  }
  const memo = hasCap
    ? [{ id: 'cap', label: 'of which Capital', book: m => m.cap },
       { id: 'capVat', label: 'of which Capital VAT', book: m => m.capVat }]
    : [];
  return { cols, memo, diffs: cols.filter(c => c.diff) };
}

// The figures that go on the filed VAT return. Capital purchase is entered in
// its own column but REPORTED inside taxable purchase (2026-08-14, user), so
// every comparison against the return has to add it back.
function spbReturnTaxable(m) { return (m.t || 0) + (m.cap || 0); }
function spbReturnVat(m) { return (m.v || 0) + (m.capVat || 0); }

function spbRenderVrGrid() {
  const card = document.getElementById('spb-vr-card');
  if (!card) return;
  card.style.display = 'block';
  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    const M = spbVrModel(key);
    const width = 420 + (M.cols.length * 2 + M.memo.length + M.diffs.length) * 96;
    html += `<h4 class="spb-vr-title">${label} — book vs filed return</h4>
    <div class="table-wrap" style="padding:0; overflow-x:auto; box-shadow:none; border:1px solid var(--border);">
    <table class="client-table spb-table" style="min-width:${width}px;">
      <thead>
        <tr>
          <th rowspan="2">Month</th>
          <th colspan="${M.cols.length + M.memo.length}" style="text-align:center;">As per Book</th>
          <th colspan="${M.cols.length}" style="text-align:center;">As Per VAT Return (type from the filed return)</th>
          <th colspan="${M.diffs.length}" style="text-align:center;">Difference</th>
          <th rowspan="2">Status</th>
        </tr>
        <tr>
          ${M.cols.concat(M.memo).map(c => `<th>${escHtml(c.label)}</th>`).join('')}
          ${M.cols.map(c => `<th>${escHtml(c.label)}</th>`).join('')}
          ${M.diffs.map(c => `<th>${escHtml(c.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${SPB_BS_MONTHS.map((_, fi) => {
          const b = spbBook[key][fi];
          return `<tr>
            <td>${SPB_MONTH_NAMES[fi]}</td>
            ${M.cols.concat(M.memo).map(c => `<td class="spb-book">${spbFmt(c.book(b))}</td>`).join('')}
            ${M.cols.map(c => `<td><input class="spb-in" id="spb-vr-${key}-${fi}-${c.id}" inputmode="decimal" placeholder="–" oninput="spbVrInput('${key}',${fi},'${c.id}',this.value)"></td>`).join('')}
            ${M.diffs.map(c => `<td id="spb-vrd-${key}-${fi}-${c.id}" class="spb-book">–</td>`).join('')}
            <td id="spb-vrs-${key}-${fi}" class="spb-flag-na">not entered</td>
          </tr>`;
        }).join('')}
        <tr class="dep-total-row">
          <td>Total</td>
          ${M.cols.concat(M.memo).map(c => `<td id="spb-vrt-${key}-b${c.id}"></td>`).join('')}
          ${M.cols.map(c => `<td id="spb-vrt-${key}-r${c.id}"></td>`).join('')}
          ${M.diffs.map(c => `<td id="spb-vrt-${key}-d${c.id}"></td>`).join('')}
          <td></td>
        </tr>
      </tbody>
    </table></div>`;
  });
  document.getElementById('spb-vr-body').innerHTML = html;
  // Re-apply any drafted figures into the fresh inputs.
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) return;
    SPB_BS_MONTHS.forEach((_, fi) => {
      spbVrModel(key).cols.forEach(c => {
        const el = document.getElementById(`spb-vr-${key}-${fi}-${c.id}`);
        if (el) el.value = spbVr[key][fi][c.id] || '';
      });
    });
  });
  spbRecalcVr();
}

// One month "reconciles" when every entered figure sits inside the rounding
// band. VAT participates in the verdict even though (matching the firm's
// layout) it has no printed Diff column.
function spbMonthVerdict(key, fi) {
  const b = spbBook[key][fi];
  const e = spbVr[key][fi];
  const cols = spbVrModel(key).cols;
  if (!cols.some(c => e[c.id] !== '' && e[c.id] != null)) return { entered: false };
  const d = {}, bad = [];
  cols.forEach(c => {
    d[c.id] = spbNum(e[c.id]) - c.book(b);
    if (Math.abs(d[c.id]) > SPB_ROUNDING_TOLERANCE) bad.push(c.label);
  });
  // dt/df stay named for the Monthly sheet's two printed Diff columns.
  return { entered: true, d, dt: d.t, dv: d.v, df: d.f, bad };
}

function spbVrInput(key, fi, field, value) {
  spbVr[key][fi][field] = value.trim();
  spbRecalcVr();
  spbVrScheduleDraft();
}

function spbRecalcVr() {
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key] || !spbBook[key]) return;
    const M = spbVrModel(key);
    const T = {};
    const add = (id, n) => { T[id] = (T[id] || 0) + n; };
    SPB_BS_MONTHS.forEach((_, fi) => {
      const b = spbBook[key][fi];
      M.cols.concat(M.memo).forEach(c => add('b' + c.id, c.book(b)));
      const v = spbMonthVerdict(key, fi);
      const sEl = document.getElementById(`spb-vrs-${key}-${fi}`);
      if (!sEl) return;
      if (!v.entered) {
        M.diffs.forEach(c => {
          const el = document.getElementById(`spb-vrd-${key}-${fi}-${c.id}`);
          if (el) el.textContent = '–';
        });
        sEl.textContent = 'not entered'; sEl.className = 'spb-flag-na';
        return;
      }
      const e = spbVr[key][fi];
      M.cols.forEach(c => add('r' + c.id, spbNum(e[c.id])));
      M.diffs.forEach(c => {
        add('d' + c.id, v.d[c.id]);
        const el = document.getElementById(`spb-vrd-${key}-${fi}-${c.id}`);
        if (el) el.textContent = spbFmt(v.d[c.id]);
      });
      sEl.textContent = v.bad.length ? '✗ gap: ' + v.bad.join(', ') : '✓ matched';
      sEl.className = v.bad.length ? 'spb-flag-gap' : 'spb-flag-ok';
    });
    Object.keys(T).forEach(id => {
      const el = document.getElementById(`spb-vrt-${key}-${id}`);
      if (el) el.textContent = spbFmt(T[id]);
    });
  });
}

// ════════════════════════════════════════════
//  DRAFTS — typed return figures autosave to localStorage, keyed by
//  (company, FY) so alternating between clients never cross-pollinates.
//  WorkflowEngine.createAutosave assumes one fixed storage key per module,
//  which doesn't fit a keyed multi-draft store — hence this small purpose-
//  built version (same debounce/best-effort semantics).
// ════════════════════════════════════════════
const SPB_DRAFT_KEY = 'spbVatReturnDrafts';
let spbDraftTimer = null;

function spbDraftId() {
  return (spbVal('spb-company').toUpperCase() || '(NO CLIENT)') + '|' + spbVal('spb-fy');
}

function spbVrScheduleDraft() {
  clearTimeout(spbDraftTimer);
  spbDraftTimer = setTimeout(() => {
    try {
      const map = JSON.parse(localStorage.getItem(SPB_DRAFT_KEY) || '{}');
      map[spbDraftId()] = { vr: spbVr, ts: Date.now() };
      const ids = Object.keys(map).sort((a, b) => map[b].ts - map[a].ts);
      ids.slice(20).forEach(id => delete map[id]);   // keep the 20 newest
      localStorage.setItem(SPB_DRAFT_KEY, JSON.stringify(map));
    } catch (e) { /* best-effort only */ }
  }, 600);
}

function spbVrLoadDraft() {
  try {
    const map = JSON.parse(localStorage.getItem(SPB_DRAFT_KEY) || '{}');
    const d = map[spbDraftId()];
    if (!d || !d.vr || !d.vr.sales || !d.vr.purchase) return;
    // Drafts written before the import/capital columns existed hold only
    // {t,v,f}. Top them up rather than discarding them — a staff member who
    // typed twelve months of a filed return should not lose it to an upgrade.
    const vr = spbBlankVr();
    SPB_SECTIONS.forEach(({ key }) => {
      (d.vr[key] || []).forEach((m, fi) => {
        if (!vr[key][fi] || !m) return;
        SPB_VR_FIELDS.forEach(f => { if (m[f] != null) vr[key][fi][f] = String(m[f]); });
      });
    });
    spbVr = vr;
  } catch (e) { /* ignore a corrupt draft */ }
}

// ════════════════════════════════════════════
//  EXCEL GENERATION — the complete 7-sheet workbook. All derived figures are
//  written as live SUM / cross-sheet formulas so the output stays auditable
//  in Excel; only the raw transaction values are literals.
// ════════════════════════════════════════════
const SPB_MONEY = '#,##0.00';

// Highlight fills — yellow makes every total row findable at a scroll
// (user-requested), amber marks grand totals as a higher level, light red
// flags reconciliation gaps. Classic Excel palette so prints stay familiar.
const SPB_FILL_YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const SPB_FILL_AMBER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
const SPB_FILL_BAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const SPB_NEG_FONT = { color: { argb: 'FF9C0006' } };

function spbFillRow(ws, r, fromCol, toCol, fill) {
  for (let c = fromCol; c <= toCol; c++) ws.getRow(r).getCell(c).fill = fill;
}

function spbHeaderRow(ws, rowIdx, labels) {
  labels.forEach((txt, i) => {
    const c = ws.getRow(rowIdx).getCell(i + 1);
    c.value = txt;
    c.font = { bold: true, size: 10, color: { argb: 'FF0B1F3D' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });
}

// ── Sheet layout ────────────────────────────────────────────────────────────
// Sales books carry the firm's original three amount columns. Purchase books
// additionally carry Taxable Import and Capital Purchase — but only if the
// uploaded sheet actually HAD those columns. Printing an all-zero "Capital
// Purchase" column on every book would be noise for the many clients who
// never buy capital goods, and inventing a column the source never had is
// exactly the sort of silent difference this module exists to avoid.
function spbSectionAmountKeys(key) {
  const col = spbRaw && spbRaw[key] && spbRaw[key].header ? spbRaw[key].header.col : null;
  return SPB_AMOUNT_FIELDS
    .filter(f => !f.purchaseOnly || key === 'purchase')
    .filter(f => {
      if (!f.purchaseOnly) return true;
      if (col) return col[f.key] != null;
      // No uploaded sheet behind this book (loaded from the database, or typed
      // in Data Entry) — decide by VALUE, the spbLedgerCols idiom: the column
      // appears when any bill line actually carries a figure in it. The old
      // `col = {}` fallback silently DROPPED Import/Capital columns (and their
      // figures) from a workbook generated off a loaded book.
      const txns = spbData && spbData[key] ? spbData[key].txns : [];
      return txns.some(x => (x[f.key] || 0) !== 0);
    })
    .map(f => f.key);
}

// One description of a book sheet's geometry, shared by the Book, Summary and
// Details writers so their columns can't drift apart.
function spbBookLayout(key) {
  const amounts = spbSectionAmountKeys(key);
  return {
    amounts,
    // Date / Bill / Party / PAN occupy A–D; amounts start at E.
    firstAmount: 4,
    lastCol: 4 + amounts.length,
    headers: ['Date', 'Bill No.', 'Party Name', 'Pan No.', ...amounts.map(spbAmountLabel)],
    widths: [{ width: 12 }, { width: 22 }, { width: 44 }, { width: 14 }, ...amounts.map(() => ({ width: 16 }))],
    letter: i => spbColLetter(4 + i),
  };
}

function spbTxnCells(ws, r, x, L) {
  ws.getCell(`A${r}`).value = x.date;
  ws.getCell(`B${r}`).value = x.bill;
  ws.getCell(`C${r}`).value = x.party;
  ws.getCell(`D${r}`).value = x.pan || null;
  L.amounts.forEach((k, i) => {
    const v = x[k] || 0;
    const c = ws.getCell(`${L.letter(i)}${r}`);
    c.value = v; c.numFmt = SPB_MONEY;
    if (v < 0) c.font = SPB_NEG_FONT;   // credit notes readable at a glance
  });
}

// `res` caches the computed sums alongside the formula — without a cached
// result some Excel builds show 0 until a manual recalc.
function spbSubtotalRow(ws, r, label, from, to, pan, res, L) {
  ws.getCell(`C${r}`).value = label;
  if (pan) ws.getCell(`D${r}`).value = pan;
  L.amounts.forEach((k, i) => {
    const col = L.letter(i);
    const c = ws.getCell(`${col}${r}`);
    c.value = { formula: `SUM(${col}${from}:${col}${to})`, result: res[k] || 0 };
    c.numFmt = SPB_MONEY;
  });
  ws.getRow(r).font = { bold: true };
  spbFillRow(ws, r, 1, L.lastCol, SPB_FILL_YELLOW);
}

// Sales / Purchase sheets: cleaned transactions in month-then-date order with
// the month subtotal rows regenerated as live formulas. They are ALWAYS
// regenerated, whether or not the uploaded book had any — the input's
// embedded copies are stripped on import, and these can't double-count
// because they're SUMs over blocks rather than duplicated figures.
function spbSheetBook(wb, name, txns, L) {
  const ws = wb.addWorksheet(name);
  ws.columns = L.widths;
  spbHeaderRow(ws, 1, L.headers);
  const sorted = txns.slice().sort((a, b) => a.fi - b.fi || a.d - b.d || a.src - b.src);
  let r = 2;
  SPB_BS_MONTHS.forEach((_, fi) => {
    const monthRows = sorted.filter(x => x.fi === fi);
    if (!monthRows.length) return;
    const from = r;
    monthRows.forEach(x => { spbTxnCells(ws, r, x, L); r++; });
    spbSubtotalRow(ws, r, 'Total Of ' + SPB_MONTH_NAMES[fi], from, r - 1, null, spbSumAmounts(monthRows), L);
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = `A1:${spbColLetter(L.lastCol - 1)}1`;
  return ws;
}

// Summary sheets: same columns, grouped by party (alphabetical), each group
// followed by its "<Party> Total" SUM row. Returns each group's subtotal row
// index so the Details sheet can reference it by formula.
function spbSheetSummary(wb, name, groups, L) {
  const ws = wb.addWorksheet(name);
  ws.columns = L.widths;
  spbHeaderRow(ws, 1, L.headers);
  const subRow = {};
  let r = 2;
  groups.forEach(g => {
    const from = r;
    g.rows.forEach(x => { spbTxnCells(ws, r, x, L); r++; });
    spbSubtotalRow(ws, r, g.display + ' Total', from, r - 1, g.pan, g, L);
    subRow[g.key] = r;
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = `A1:${spbColLetter(L.lastCol - 1)}1`;
  return subRow;
}

// Details sheets: one row per party, taxable descending, each cell a live
// reference to that party's subtotal row on the Summary sheet — plus a Grand
// Total row that must tie back to the book total (a built-in self-check the
// firm's hand-maintained file never had).
function spbSheetDetails(wb, name, groups, summaryName, subRow, L) {
  const ws = wb.addWorksheet(name);
  // S.No. / Party / PAN occupy A–C here, so an amount sits one column left of
  // where it sits on the Summary sheet it references.
  const letter = i => spbColLetter(3 + i);
  ws.columns = [{ width: 7 }, { width: 52 }, { width: 14 }, ...L.amounts.map(() => ({ width: 16 }))];
  spbHeaderRow(ws, 1, ['S.No.', 'Party Name', 'Pan No.', ...L.amounts.map(spbAmountLabel)]);
  const ordered = groups.slice().sort((a, b) => b.taxable - a.taxable || b.vat - a.vat);
  const q = `'${summaryName}'`;
  ordered.forEach((g, i) => {
    const r = i + 2, sr = subRow[g.key];
    ws.getCell(`A${r}`).value = i + 1;
    ws.getCell(`B${r}`).value = g.display + ' Total';
    if (g.pan) ws.getCell(`C${r}`).value = g.pan;
    L.amounts.forEach((k, j) => {
      const c = ws.getCell(`${letter(j)}${r}`);
      c.value = { formula: `${q}!${L.letter(j)}${sr}`, result: g[k] || 0 };
      c.numFmt = SPB_MONEY;
    });
  });
  const tr = ordered.length + 2;
  ws.getCell(`B${tr}`).value = 'Grand Total';
  const grand = spbSumAmounts(ordered);
  L.amounts.forEach((k, j) => {
    const col = letter(j);
    const c = ws.getCell(`${col}${tr}`);
    c.value = { formula: `SUM(${col}2:${col}${tr - 1})`, result: grand[k] || 0 };
    c.numFmt = SPB_MONEY;
  });
  ws.getRow(tr).font = { bold: true };
  spbFillRow(ws, tr, 1, 3 + L.amounts.length, SPB_FILL_AMBER);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = `A1:${spbColLetter(2 + L.amounts.length)}1`;
}

// Monthly sheet: same geometry as the firm's file (Sales block rows 4–18,
// Purchase block rows 24–38) plus a Remarks column. Two deliberate fixes vs
// the reference: the Difference sign is Return − Book in BOTH sections (the
// old file flipped Taxfree Diff between them), and the Total row sums every
// column (the old Sales total left As-per-Book blank).
function spbSheetMonthly(wb) {
  const ws = wb.addWorksheet('Monthly');
  const fyDot = spbFyDot();
  const blocks = SPB_SECTIONS.filter(s => spbData[s.key]).map(s => ({ ...s, M: spbVrModel(s.key) }));
  // Widths first: ExcelJS wants column definitions before the cells land.
  const widest = Math.max(4, ...blocks.map(({ M }) => 2 + M.cols.length * 2 + M.memo.length + M.diffs.length));
  ws.columns = [{ width: 20 }, ...Array.from({ length: widest - 2 }, () => ({ width: 15 })), { width: 34 }];
  let base = 0;
  blocks.forEach(({ key, label, M }) => {
    // Column plan: A = Months, then Book (compared + memo), Return, Diff, Remarks.
    const bookCols = M.cols.concat(M.memo);
    const bookAt = i => 2 + i;
    const retAt = i => 2 + bookCols.length + i;
    const diffAt = i => 2 + bookCols.length + M.cols.length + i;
    const remarkAt = 2 + bookCols.length + M.cols.length + M.diffs.length;
    const L = n => spbColLetter(n - 1);   // 1-based column number → letter

    const titleR = base + 1, headR = base + 4, subR = base + 5, firstR = base + 6, totR = firstR + 12;
    ws.mergeCells(`A${titleR}:${L(remarkAt)}${titleR}`);
    ws.getCell(`A${titleR}`).value = `${label} Book ${fyDot}`;
    ws.getCell(`A${titleR}`).font = { bold: true, size: 13, color: { argb: 'FF0B1F3D' } };
    ws.mergeCells(`A${headR}:A${subR}`);
    ws.mergeCells(`${L(bookAt(0))}${headR}:${L(bookAt(bookCols.length - 1))}${headR}`);
    ws.mergeCells(`${L(retAt(0))}${headR}:${L(retAt(M.cols.length - 1))}${headR}`);
    if (M.diffs.length > 1) ws.mergeCells(`${L(diffAt(0))}${headR}:${L(diffAt(M.diffs.length - 1))}${headR}`);
    ws.mergeCells(`${L(remarkAt)}${headR}:${L(remarkAt)}${subR}`);
    [['A', 'Months'], [L(bookAt(0)), 'As per Book'], [L(retAt(0)), 'As Per VAT Return'],
     [L(diffAt(0)), 'Difference'], [L(remarkAt), 'Remarks']].forEach(([col, txt]) => {
      const c = ws.getCell(`${col}${headR}`);
      c.value = txt;
      c.font = { bold: true, color: { argb: 'FF0B1F3D' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    bookCols.map(c => c.label)
      .concat(M.cols.map(c => c.label))
      .concat(M.diffs.map(c => c.label + ' Diff'))
      .forEach((txt, i) => {
        const c = ws.getRow(subR).getCell(2 + i);
        c.value = txt;
        c.font = { bold: true, size: 10 };
        c.alignment = { horizontal: 'center', wrapText: true };
      });

    SPB_BS_MONTHS.forEach((_, fi) => {
      const r = firstR + fi;
      const b = spbBook[key][fi];
      const e = spbVr[key][fi];
      const v = spbMonthVerdict(key, fi);
      ws.getCell(`A${r}`).value = 'Total of ' + SPB_MONTH_NAMES[fi];
      bookCols.forEach((c, i) => {
        const cell = ws.getRow(r).getCell(bookAt(i));
        cell.value = c.book(b); cell.numFmt = SPB_MONEY;
      });
      M.cols.forEach((c, i) => {
        if (e[c.id] === '' || e[c.id] == null) return;
        const cell = ws.getRow(r).getCell(retAt(i));
        cell.value = spbNum(e[c.id]); cell.numFmt = '#,##0';   // filed figures are whole rupees
      });
      const remark = ws.getRow(r).getCell(remarkAt);
      if (v.entered) {
        M.diffs.forEach((c, i) => {
          // Difference is Return − Book in BOTH sections (the firm's own file
          // flipped the sign between them — a deliberate correction).
          const bookIdx = bookCols.findIndex(x => x.id === c.id);
          const retIdx = M.cols.findIndex(x => x.id === c.id);
          const cell = ws.getRow(r).getCell(diffAt(i));
          cell.value = { formula: `${L(retAt(retIdx))}${r}-${L(bookAt(bookIdx))}${r}`, result: v.d[c.id] };
          cell.numFmt = SPB_MONEY;
        });
        if (v.bad.length) {
          remark.value = 'MISMATCH — ' + v.bad.join(', ') + ' beyond rounding';
          remark.font = { bold: true, color: { argb: 'FFB42318' } };
          spbFillRow(ws, r, 1, remarkAt, SPB_FILL_BAD);   // the whole month row reads as a gap
        } else {
          remark.value = 'Matched';
          remark.font = { color: { argb: 'FF067647' } };
        }
      } else {
        remark.value = 'Return not entered';
        remark.font = { color: { argb: 'FF64748B' } };
      }
    });

    ws.getCell(`A${totR}`).value = 'Total';
    const totals = new Array(remarkAt + 1).fill(0);
    SPB_BS_MONTHS.forEach((_, fi) => {
      const b = spbBook[key][fi], e = spbVr[key][fi], v = spbMonthVerdict(key, fi);
      bookCols.forEach((c, i) => { totals[bookAt(i)] += c.book(b); });
      if (!v.entered) return;
      M.cols.forEach((c, i) => { totals[retAt(i)] += spbNum(e[c.id]); });
      M.diffs.forEach((c, i) => { totals[diffAt(i)] += v.d[c.id]; });
    });
    for (let n = 2; n < remarkAt; n++) {
      const col = L(n);
      const c = ws.getRow(totR).getCell(n);
      c.value = { formula: `SUM(${col}${firstR}:${col}${totR - 1})`, result: totals[n] || 0 };
      c.numFmt = SPB_MONEY;
    }
    ws.getRow(totR).font = { bold: true };
    spbFillRow(ws, totR, 1, remarkAt, SPB_FILL_YELLOW);
    base = totR + 2;   // next block starts two rows below this one's total
  });
}

// Every Data-Doctor decision travels WITH the workbook — an auditor opening
// the file can see exactly what was adjusted from the client's raw book.
function spbSheetCorrections(wb) {
  if (!spbCorrectionLog.length) return;
  const ws = wb.addWorksheet('Corrections');
  ws.columns = [{ width: 10 }, { width: 8 }, { width: 10 }, { width: 28 }, { width: 28 }, { width: 20 }];
  spbHeaderRow(ws, 1, ['Book', 'Row', 'Field', 'Original', 'Corrected', 'Applied']);
  spbCorrectionLog.forEach((l, i) => {
    const r = i + 2;
    ws.getCell(`A${r}`).value = l.section === 'sales' ? 'Sales' : 'Purchase';
    ws.getCell(`B${r}`).value = l.excelRow;
    ws.getCell(`C${r}`).value = l.field;
    ws.getCell(`D${r}`).value = l.from;
    ws.getCell(`E${r}`).value = l.field === 'exclude' ? 'row excluded' : l.to;
    ws.getCell(`F${r}`).value = new Date(l.ts).toLocaleString();
  });
}

function spbBuildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;   // recalc formulas the moment Excel opens the file
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    const L = spbBookLayout(key);
    spbSheetBook(wb, label, spbData[key].txns, L);
    const subRow = spbSheetSummary(wb, label + ' Summary', spbGroups[key], L);
    spbSheetDetails(wb, label + ' Details', spbGroups[key], label + ' Summary', subRow, L);
  });
  spbSheetMonthly(wb);
  spbSheetCorrections(wb);
  return wb;
}

// ════════════════════════════════════════════
//  DATA-ENTRY TEMPLATE — the format this module reads, handed back as a blank
//  workbook so staff can type into it directly instead of the importer having
//  to guess at a layout it has never seen (2026-08-14, user request).
//
//  Everything the template does is a shape the importer already understands:
//  month names in the Date column, the seven original columns for Sales, and
//  the four extra VAT-return boxes for Purchase. The VAT formulas are a
//  convenience — they evaluate to 0 on unused rows, which the importer's row
//  liveness test (spbRowIsLive) correctly reads as empty.
// ════════════════════════════════════════════
const SPB_TEMPLATE_ROWS = 300;

function spbTemplateSheet(wb, section) {
  const fields = SPB_AMOUNT_FIELDS.filter(f => !f.purchaseOnly || section === 'purchase');
  const headers = ['Date', 'Bill No.', 'Party Name', 'Pan No.', ...fields.map(f => f.label)];
  const ws = wb.addWorksheet(section === 'sales' ? 'Sales' : 'Purchase');
  ws.columns = [{ width: 14 }, { width: 14 }, { width: 40 }, { width: 14 }, ...fields.map(() => ({ width: 18 }))];
  spbHeaderRow(ws, 1, headers);
  const letterOf = key => spbColLetter(4 + fields.findIndex(f => f.key === key));
  for (let r = 2; r <= SPB_TEMPLATE_ROWS + 1; r++) {
    ws.getCell(`A${r}`).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: [`"${SPB_MONTH_NAMES.join(',')}"`],
      showErrorMessage: false,   // a full B.S. date (2082.04.01) is equally valid
    };
    fields.forEach(f => {
      const c = ws.getCell(`${letterOf(f.key)}${r}`);
      c.numFmt = SPB_MONEY;
      // VAT is a flat 13% in every case — pre-wire it so nobody has to compute it.
      if (f.vatKey) ws.getCell(`${letterOf(f.vatKey)}${r}`).value = { formula: `${letterOf(f.key)}${r}*13%`, result: 0 };
    });
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = `A1:${spbColLetter(3 + fields.length)}1`;
  return ws;
}

const SPB_TEMPLATE_NOTES = [
  ['How to fill this workbook', ''],
  ['', ''],
  ['Date column', 'A full B.S. date (2082.04.01) or just the month name (Shrawan, Bhadra, …). Both are accepted, and Nepali spellings and common misspellings are recognised. If you type only the month, the day is taken as the 1st and reported in the import summary.'],
  ['Fiscal year', 'One fiscal year runs 1 Shrawan to the last day of Ashadh — 2082.04.01 to 2083.03.32 is the SAME year, F.Y. 2082-83. Select that year in Autobooks before uploading. A date is only flagged if it falls outside the year you selected.'],
  ['Month totals', 'Optional. Leave them out and Autobooks generates them. If you do include "Total Of Shrawan" rows, they are removed from the transactions and used as a free cross-check against the computed figures.'],
  ['Tax Free', 'Purchases from a supplier who is registered for PAN only, not VAT — there is no VAT on the bill, so leave the Vat column at 0.'],
  ['Taxable Amount / Vat', 'Ordinary domestic taxable purchases and sales. VAT is always 13%. Leave the Vat cell blank and Autobooks fills it at 13%; type a different figure and it is flagged for you to confirm rather than changed.'],
  ['Taxable Import (Purchase only)', 'Goods imported through customs. Also 13% VAT, entered in the Import VAT column.'],
  ['Capital Purchase (Purchase only)', 'Capital goods, also 13% VAT. Entered here separately, but Autobooks ADDS it into Taxable Purchase when comparing against the filed VAT return — which is how the return itself reports it.'],
  ['PAN-only clients', 'If the client is registered for PAN and not VAT, they charge no VAT on sales: leave the Sales Vat column empty. Purchases from a VAT-registered supplier still carry 13% and belong in Taxable Amount / Vat as usual. Set "Registration" to "PAN only" in Autobooks.'],
  ['Credit notes', 'Enter as negative amounts on their own row.'],
  ['Party Name and Pan No.', 'Type both. Autobooks corrects a single mistyped digit in a PAN, and a near-identical spelling of a name under the same PAN, automatically — and shows you exactly what it changed, with an Undo.'],
];

function spbTemplateNotesSheet(wb) {
  const ws = wb.addWorksheet('How to fill');
  ws.columns = [{ width: 34 }, { width: 110 }];
  SPB_TEMPLATE_NOTES.forEach(([a, b], i) => {
    const r = i + 1;
    ws.getCell(`A${r}`).value = a;
    ws.getCell(`B${r}`).value = b;
    ws.getCell(`A${r}`).font = { bold: true, color: { argb: 'FF0B1F3D' }, size: i === 0 ? 14 : 11 };
    ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
  });
}

async function spbDownloadTemplate() {
  try {
    await LibLoader.ensure('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true;
    spbTemplateSheet(wb, 'sales');
    spbTemplateSheet(wb, 'purchase');
    spbTemplateNotesSheet(wb);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const company = spbVal('spb-company');
    const fname = ((company ? company + ' ' : '') + 'Autobooks data entry ' + (spbFyDot() || '')).trim() + '.xlsx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'salesPurchaseBook', clientName: company || null });
    spbStatus('✅ Data-entry format downloaded — fill the Sales and Purchase sheets and upload it back here. The "How to fill" sheet explains every column.', 'success');
  } catch (err) {
    spbStatus('❌ Could not build the template: ' + escHtml(err.message), 'error');
  }
}

async function spbGenerateExcel() {
  if (!spbData || (!spbData.sales && !spbData.purchase)) { spbStatus('❌ Upload the Sales/Purchase file first (and map its columns if prompted).', 'error'); return; }
  if (!window.ExcelJS) { spbStatus('❌ Excel engine not loaded — reload the page and try again.', 'error'); return; }
  // Refuse to write a workbook whose own layers disagree — transactions,
  // party groups and monthly totals must tie to the paisa first.
  const tie = spbTieOut();
  if (!tie.ok) {
    spbStatus('❌ Internal tie-out FAILED — not generating a possibly wrong workbook: ' + escHtml(tie.problems.join(' · ')), 'error');
    return;
  }
  // Not a blocker — the reconciliation columns simply stay blank — but say so.
  const missing = SPB_SECTIONS.filter(s => spbData[s.key] &&
    SPB_BS_MONTHS.some((_, fi) => !spbMonthVerdict(s.key, fi).entered)).map(s => s.label);
  try {
    await LibLoader.ensure('exceljs');
    const wb = spbBuildWorkbook();
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const company = spbVal('spb-company');
    const fname = ((company ? company + ' ' : '') + 'Sales & Purchase ' + spbFyDot()).trim() + '.xlsx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'salesPurchaseBook', clientName: company || null });
    spbStatus('✅ Workbook generated and downloaded.' +
      (missing.length ? ` ⚠️ Some ${missing.join(' & ')} months have no VAT-return figures — their reconciliation is marked "Return not entered".` : ''), 'success');
  } catch (err) {
    spbStatus('❌ Could not generate the file: ' + escHtml(err.message), 'error');
  }
}

// ── Client search + FY change wiring (module loads before auth) ──
// FY drives year inference for month-name dates and the outside-FY check,
// so changing it re-parses from source, not just the reconciliation grid.
function spbOnContextChange() {
  // With no uploaded sheet in hand there is nothing to re-parse — but there may
  // well be a SAVED book for the client and year now selected, so the ledger
  // layer still gets a look.
  if (!spbRaw) {
    if (typeof spbLedgerOnContext === 'function') spbLedgerOnContext();
  } else {
    spbVr = spbBlankVr();
    spbVrLoadDraft();
    spbReparse();
  }
  // The data-entry sheet keys its rows and drafts on (client, FY) — a changed
  // selection must swap them. Guarded: separate file, loaded after this one.
  if (typeof spbEntryOnContext === 'function') spbEntryOnContext();
}

// The imported transactions belong to whoever was selected when the files
// were dropped, so switching client discards them rather than re-parsing one
// client's book under another's name and PAN into the generated workbook.
const spbScope = WorkflowEngine.createClientScope({
  clear(reason) {
    const hadImport = !!spbRaw;
    if (reason === 'client') {
      spbClientId = null;
      document.getElementById('spb-company').value = '';
      document.getElementById('spb-pan').value = '';
    }
    const fileEl = document.getElementById('spb-file');
    if (fileEl) fileEl.value = '';
    spbReset();
    if (hadImport) spbStatus("ℹ️ Cleared the previous client's imported transactions — drop this client's files to continue.", 'info');
  },
  load(c, reason) {
    if (reason === 'client') {
      spbClientId = c.id != null ? c.id : null;
      document.getElementById('spb-company').value = c.name || '';
      document.getElementById('spb-pan').value = c.pan || '';
      // `tax_registration_type` is whether the client is registered for VAT or
      // for PAN alone — a property of the client. It is NOT `vat_status`,
      // which is whether the firm files that client's monthly return (§15).
      // Always assigned, never conditionally, so a client with the field
      // blank can't inherit the previous client's setting.
      const reg = document.getElementById('spb-regtype');
      if (reg) reg.value = /vat/i.test(String(c.tax_registration_type || '')) ? 'vat' : (c.tax_registration_type ? 'pan' : 'vat');
    }
    spbOnContextChange();
  },
});

(function spbWireSearch() {
  const input = document.getElementById('spb-company');
  const list = document.getElementById('spb-autocomplete-list');
  if (!input || !list) return;
  SearchEngine.attachAutocomplete(input, list, {
    getList: () => window.clientsList,
    keys: ['name', 'email', 'pan'],
    renderItem: c => `
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.pan ? 'PAN: ' + c.pan : (c.email || 'No details on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    `,
    onSelect: c => spbScope.select(c),
  });
  input.addEventListener('input', () => { spbScope.invalidate(); spbClientId = null; });
  input.addEventListener('change', spbOnContextChange);
})();
