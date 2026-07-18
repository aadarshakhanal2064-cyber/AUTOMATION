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
ModuleRegistry.register({ id: 'salesPurchaseBook', group: 'main', buttonId: 'nav-salesPurchaseBook', panelId: 'tab-salesPurchaseBook-panel' });

// A month "reconciles" only within this band. The IRD-filed figures are whole
// rupees produced by TRUNCATION, not rounding (reference file: book VAT
// 532,929.74 filed as 532,929) — so legitimate differences run up to 0.99,
// and only a full rupee or more is a real gap.
const SPB_ROUNDING_TOLERANCE = 0.999;

// Fiscal display order (index 0 = Shrawan) → B.S. calendar month number.
const SPB_BS_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

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

function spbBlankVr() {
  const sec = () => SPB_BS_MONTHS.map(() => ({ t: '', v: '', f: '' }));
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

function spbBuildFyOptions() {
  const sel = document.getElementById('spb-fy');
  if (!sel || sel.dataset.built) return;
  const bs = NepaliLocale.todayBs && NepaliLocale.todayBs();
  const cur = bs ? (bs.month >= 4 ? bs.year : bs.year - 1) : 2081;
  let html = '';
  // Books are compiled well after year-end — back years matter more than future.
  for (let y = cur - 4; y <= cur + 1; y++) {
    const label = y + '-' + String((y + 1) % 100).padStart(2, '0');
    html += `<option value="${label}"${y === cur ? ' selected' : ''}>${label}</option>`;
  }
  sel.innerHTML = html;
  sel.dataset.built = '1';
}

function spbInit() {
  spbBuildFyOptions();
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

function spbFindHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = (rows[i] || []).map(c => String(c == null ? '' : c).toLowerCase().trim());
    if (!cells.some(c => /^date/.test(c)) || !cells.some(c => /party/.test(c))) continue;
    const col = {};
    cells.forEach((c, j) => {
      if (/^date/.test(c)) col.date = j;
      else if (/bill/.test(c)) col.bill = j;
      else if (/party/.test(c)) col.party = j;
      else if (/pan/.test(c)) col.pan = j;
      else if (/tax\s*free/.test(c)) col.taxfree = j;
      else if (/taxable/.test(c)) col.taxable = j;
      else if (/^vat/.test(c)) col.vat = j;
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
  baishakh: 1, baisakh: 1, baishak: 1, baisake: 1,
  jestha: 2, jeth: 2,
  ashadh: 3, ashad: 3, asar: 3, ashar: 3,
  shrawan: 4, shrawn: 4, shravan: 4, saun: 4, srawan: 4,
  bhadra: 5, bhadau: 5, bhadrapad: 5,
  ashoj: 6, ashwin: 6, asoj: 6,
  kartik: 7, kartick: 7,
  mangsir: 8, mansir: 8, marga: 8, mangshir: 8, margashir: 8,
  poush: 9, paush: 9, push: 9,
  magh: 10, maagh: 10,
  falgun: 11, fagun: 11, phalgun: 11,
  chaitra: 12, chait: 12,
};

// Returns { year, mon, day, approxDay } or null. `fyStartYear` lets us infer
// a missing year from the month's position in the fiscal year (Shrawan–
// Chaitra = fyStartYear, Baishakh–Ashadh = fyStartYear + 1) when the cell
// only names the month — without a selected FY we refuse to guess the year.
function spbParseMonthNameDate(dateStr, fyStartYear) {
  const tokens = String(dateStr || '').toLowerCase().match(/[a-z]+|\d+/g);
  if (!tokens) return null;
  let mon = null, day = null, year = null;
  tokens.forEach(tok => {
    if (/^[a-z]+$/.test(tok)) {
      if (mon == null && SPB_MONTH_ALIASES[tok] != null) mon = SPB_MONTH_ALIASES[tok];
    } else {
      const n = parseInt(tok, 10);
      if (tok.length === 4 && n > 2000 && n < 2200) year = n;
      else if (n >= 1 && n <= 32 && day == null) day = n;
    }
  });
  if (mon == null) return null;
  if (year == null) {
    if (!fyStartYear) return null;
    year = mon >= 4 ? fyStartYear : fyStartYear + 1;
  }
  return { year, mon, day: day || 1, approxDay: day == null };
}

// Pure row-level parse (also exercised headlessly by the verification
// harness — keep it free of DOM access). Returns clean transactions plus
// everything worth reporting about what was skipped or looks wrong.
function spbParseRows(rows, headerInfo, fyStartYear) {
  const { row: hRow, col } = headerInfo;
  const txns = [];
  const stats = {
    rowsRead: 0, subtotalsStripped: 0, badDates: [], outsideFy: 0,
    missingPan: 0, creditRows: 0, vatOutliers: [], unnamed: 0,
    monthNameDates: 0, monthNameSamples: [],
  };
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some(c => c !== null && c !== '')) continue;
    stats.rowsRead++;
    const party = String(r[col.party] == null ? '' : r[col.party]).trim();
    const dateStr = String(r[col.date] == null ? '' : r[col.date]).trim();
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
      // lines — stripping them is what stops the double-count.
      if (/total/i.test(party)) { stats.subtotalsStripped++; continue; }
      stats.badDates.push({ excelRow: i + 1, date: dateStr, party });
      continue;
    }
    const fi = SPB_BS_MONTHS.indexOf(mon);
    if (fyStartYear) {
      const expected = mon >= 4 ? fyStartYear : fyStartYear + 1;
      if (year !== expected) stats.outsideFy++;
    }
    // Normalize month-name-only rows to a real date (day defaults to the
    // 1st) so the generated book sorts and displays consistently — the
    // original text is preserved in the reported sample, never silently lost.
    const normDate = m ? dateStr : `${year}.${String(mon).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
    if (!m) {
      stats.monthNameDates++;
      if (stats.monthNameSamples.length < 5) stats.monthNameSamples.push({ excelRow: i + 1, raw: dateStr, normalized: normDate, approxDay });
    }
    const taxfree = spbNum(col.taxfree != null ? r[col.taxfree] : 0);
    const taxable = spbNum(r[col.taxable]);
    const vat = spbNum(col.vat != null ? r[col.vat] : 0);
    const pan = spbNormPan(col.pan != null ? r[col.pan] : '');
    if (!pan) stats.missingPan++;
    if (!party) stats.unnamed++;
    if (taxable < 0 || vat < 0) stats.creditRows++;
    // VAT is a flat 13% — a row that strays by more than 1% (or Rs 1) is
    // either exempt-mixed or a typo; surfaced, never auto-corrected.
    if (taxable !== 0) {
      const expectedVat = taxable * 0.13;
      if (Math.abs(vat - expectedVat) > Math.max(1, Math.abs(expectedVat) * 0.01)) {
        stats.vatOutliers.push({ excelRow: i + 1, party, taxable, vat });
      }
    }
    txns.push({
      date: normDate, y: year, m: mon, d: day, fi,
      bill: r[col.bill] != null ? r[col.bill] : '',
      party: party || '(UNNAMED)',
      pan, taxfree, taxable, vat, src: txns.length,
    });
  }
  return { txns, stats };
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
    reader.onload = e => {
      try {
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
          if (!header) { notes.push(`"${sn}" in ${file.name} looks like a ${kind} sheet but has no Date/Party header row — skipped.`); return; }
          if (found[kind]) { notes.push(`Second ${kind} sheet ("${sn}" in ${file.name}) ignored — already loaded one.`); return; }
          found[kind] = { rows, header, source: file.name + ' → ' + sn };
          claimed = true;
        });
        if (!claimed && !wb.SheetNames.some(sn => spbClassifySheet(sn))) {
          notes.push(`${file.name}: no Sales or Purchase sheet recognized (sheets: ${wb.SheetNames.join(', ')}).`);
        }
      } catch (err) {
        notes.push(`${file.name}: could not read — ${err.message}`);
      }
      if (--pending === 0) spbAfterRead(found, notes);
    };
    reader.readAsArrayBuffer(file);
  });
  input.value = '';
}

function spbAfterRead(found, notes) {
  if (!found.sales && !found.purchase) {
    spbStatus('❌ ' + escHtml(notes.join(' ') || 'No usable sheets found.'), 'error');
    return;
  }
  const fyStart = spbFyStartYear();
  spbData = {
    sales: found.sales ? spbParseRows(found.sales.rows, found.sales.header, fyStart) : null,
    purchase: found.purchase ? spbParseRows(found.purchase.rows, found.purchase.header, fyStart) : null,
  };
  if (spbData.sales) spbData.sales.source = found.sales.source;
  if (spbData.purchase) spbData.purchase.source = found.purchase.source;
  spbMergeMap = {};
  spbBook = spbComputeBook();
  spbGroups = spbComputeGroups();
  spbSuggestions = spbBuildSuggestions();
  spbVr = spbBlankVr();
  spbVrLoadDraft();          // restore this client+FY's typed figures if drafted
  spbRenderImportSummary(notes);
  spbRenderSuggestions();
  spbRenderVrGrid();
  document.getElementById('spb-generate-btn').disabled = false;
  const parts = SPB_SECTIONS.filter(s => spbData[s.key])
    .map(s => `${s.label}: ${spbData[s.key].txns.length} transactions`);
  spbStatus('✅ Imported — ' + escHtml(parts.join(' · ')) +
    (found.sales && found.purchase ? '' : ' ⚠️ Only one of the two books was found.'), 'success');
}

function spbReset() {
  spbData = null; spbBook = null; spbGroups = null;
  spbSuggestions = []; spbMergeMap = {}; spbVr = null;
  ['spb-import-card', 'spb-merge-card', 'spb-vr-card'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('spb-generate-btn').disabled = true;
  spbStatus('', 'info');
}

// ════════════════════════════════════════════
//  DERIVED DATA — book totals per fiscal month, and party groups (with
//  approved merges applied). Both recompute from the clean transactions,
//  so book figures can never drift from what was imported.
// ════════════════════════════════════════════
function spbComputeBook() {
  const book = {};
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) { book[key] = null; return; }
    const months = SPB_BS_MONTHS.map(() => ({ t: 0, v: 0, f: 0 }));
    spbData[key].txns.forEach(x => {
      const o = months[x.fi];
      o.t += x.taxable; o.v += x.vat; o.f += x.taxfree;
    });
    book[key] = months;
  });
  return book;
}

function spbComputeGroups() {
  const out = {};
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) { out[key] = null; return; }
    const map = new Map();
    spbData[key].txns.forEach(x => {
      let k = spbSafeKey(x.party);
      k = spbMergeMap[k] || k;
      if (!map.has(k)) map.set(k, { key: k, names: new Map(), pans: new Map(), rows: [], taxfree: 0, taxable: 0, vat: 0 });
      const g = map.get(k);
      g.names.set(x.party, (g.names.get(x.party) || 0) + 1);
      if (x.pan) g.pans.set(x.pan, (g.pans.get(x.pan) || 0) + 1);
      g.rows.push(x);
      g.taxfree += x.taxfree; g.taxable += x.taxable; g.vat += x.vat;
    });
    const groups = Array.from(map.values());
    groups.forEach(g => {
      // Display name = the most frequent raw spelling (tie → longest).
      g.display = Array.from(g.names.entries())
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      // PAN shown on subtotal rows only when the group's rows agree on one.
      g.pan = g.pans.size === 1 ? Array.from(g.pans.keys())[0] : '';
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
function spbBuildSuggestions() {
  // Collect per-safeKey stats across BOTH sections (one decision, applied to both).
  const nodes = new Map();
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) return;
    spbData[key].txns.forEach(x => {
      const k = spbSafeKey(x.party);
      if (!nodes.has(k)) nodes.set(k, { key: k, fuzzy: spbFuzzyKey(x.party), names: new Map(), pans: new Set(), count: 0, taxable: 0 });
      const n = nodes.get(k);
      n.names.set(x.party, (n.names.get(x.party) || 0) + 1);
      if (x.pan) n.pans.add(x.pan);
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
    members.sort((a, b) => b.count - a.count);
    const anchorFuzzy = members[0].fuzzy;
    suggestions.push({
      members: members.map(n => ({
        key: n.key,
        display: Array.from(n.names.entries()).sort((a, b) => b[1] - a[1])[0][0],
        count: n.count,
        taxable: n.taxable,
        pans: Array.from(n.pans),
        checked: n.fuzzy === anchorFuzzy,
      })),
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
//  RENDER — import summary, duplicate review, reconciliation grid
// ════════════════════════════════════════════
function spbRenderImportSummary(notes) {
  const card = document.getElementById('spb-import-card');
  card.style.display = 'block';
  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    const d = spbData[key];
    if (!d) { html += `<div class="spb-import-sec"><strong>${label}:</strong> not uploaded.</div>`; return; }
    const s = d.stats;
    const total = d.txns.reduce((a, x) => a + x.taxable, 0);
    const warn = [];
    if (s.badDates.length) warn.push(`<span class="spb-warn">⚠ ${s.badDates.length} row(s) EXCLUDED — unreadable date (rows ${escHtml(s.badDates.slice(0, 5).map(b => b.excelRow).join(', '))}${s.badDates.length > 5 ? '…' : ''}). Fix in the source file and re-upload.</span>`);
    if (s.outsideFy) warn.push(`<span class="spb-warn">⚠ ${s.outsideFy} row(s) dated outside F.Y. ${escHtml(spbVal('spb-fy'))} — check the fiscal year selector.</span>`);
    if (s.vatOutliers.length) warn.push(`<span class="spb-warn">⚠ ${s.vatOutliers.length} row(s) where VAT ≠ 13% of taxable (e.g. row ${s.vatOutliers[0].excelRow}, ${escHtml(String(s.vatOutliers[0].party))}).</span>`);
    if (s.unnamed) warn.push(`<span class="spb-warn">⚠ ${s.unnamed} row(s) with no party name — grouped as “(UNNAMED)”.</span>`);
    if (s.monthNameDates) {
      const ex = s.monthNameSamples[0];
      warn.push(`<span class="spb-warn">ℹ ${s.monthNameDates} row(s) dated by MONTH NAME rather than a full date (e.g. row ${ex.excelRow}: "${escHtml(ex.raw)}" → ${escHtml(ex.normalized)}${ex.approxDay ? ', day assumed as the 1st' : ''}). Grouping by month is unaffected; only day-level ordering within the month is approximate.</span>`);
    }
    html += `<div class="spb-import-sec">
      <strong>${label}</strong> <span style="color:var(--text-muted);">(${escHtml(d.source || '')})</span><br>
      ${d.txns.length} transactions · ${spbGroups[key].length} parties · taxable ${spbFmt(total)}
      · ${s.subtotalsStripped} embedded subtotal row(s) stripped · ${s.missingPan} without PAN · ${s.creditRows} credit note(s)
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

function spbRenderVrGrid() {
  const card = document.getElementById('spb-vr-card');
  card.style.display = 'block';
  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    html += `<h4 class="spb-vr-title">${label} — book vs filed return</h4>
    <div class="table-wrap" style="padding:0; overflow-x:auto; box-shadow:none; border:1px solid var(--border);">
    <table class="client-table spb-table" style="min-width:1080px;">
      <thead>
        <tr><th rowspan="2">Month</th><th colspan="3" style="text-align:center;">As per Book</th><th colspan="3" style="text-align:center;">As Per VAT Return (type from the filed return)</th><th colspan="2" style="text-align:center;">Difference</th><th rowspan="2">Status</th></tr>
        <tr><th>Taxable</th><th>VAT</th><th>Taxfree</th><th>Taxable</th><th>VAT</th><th>Taxfree</th><th>Taxable</th><th>Taxfree</th></tr>
      </thead>
      <tbody>
        ${SPB_BS_MONTHS.map((_, fi) => {
          const b = spbBook[key][fi];
          const inp = f => `<td><input class="spb-in" id="spb-vr-${key}-${fi}-${f}" inputmode="decimal" placeholder="–" oninput="spbVrInput('${key}',${fi},'${f}',this.value)"></td>`;
          return `<tr>
            <td>${VAT_MONTH_ORDER[fi]}</td>
            <td class="spb-book">${spbFmt(b.t)}</td><td class="spb-book">${spbFmt(b.v)}</td><td class="spb-book">${spbFmt(b.f)}</td>
            ${inp('t')}${inp('v')}${inp('f')}
            <td id="spb-vrd-${key}-${fi}-t" class="spb-book">–</td>
            <td id="spb-vrd-${key}-${fi}-f" class="spb-book">–</td>
            <td id="spb-vrs-${key}-${fi}" class="spb-flag-na">not entered</td>
          </tr>`;
        }).join('')}
        <tr class="dep-total-row">
          <td>Total</td>
          <td id="spb-vrt-${key}-bt"></td><td id="spb-vrt-${key}-bv"></td><td id="spb-vrt-${key}-bf"></td>
          <td id="spb-vrt-${key}-rt"></td><td id="spb-vrt-${key}-rv"></td><td id="spb-vrt-${key}-rf"></td>
          <td id="spb-vrt-${key}-dt"></td><td id="spb-vrt-${key}-df"></td><td></td>
        </tr>
      </tbody>
    </table></div>`;
  });
  document.getElementById('spb-vr-body').innerHTML = html;
  // Re-apply any drafted figures into the fresh inputs.
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) return;
    SPB_BS_MONTHS.forEach((_, fi) => {
      ['t', 'v', 'f'].forEach(f => {
        const el = document.getElementById(`spb-vr-${key}-${fi}-${f}`);
        if (el) el.value = spbVr[key][fi][f];
      });
    });
  });
  spbRecalcVr();
}

// One month "reconciles" when every entered figure sits inside the rounding
// band; VAT participates in the verdict even though (matching the firm's
// layout) it has no printed Diff column.
function spbMonthVerdict(key, fi) {
  const b = spbBook[key][fi];
  const e = spbVr[key][fi];
  const entered = e.t !== '' || e.v !== '' || e.f !== '';
  if (!entered) return { entered: false };
  const dt = spbNum(e.t) - b.t, dv = spbNum(e.v) - b.v, df = spbNum(e.f) - b.f;
  const bad = [];
  if (Math.abs(dt) > SPB_ROUNDING_TOLERANCE) bad.push('Taxable');
  if (Math.abs(dv) > SPB_ROUNDING_TOLERANCE) bad.push('VAT');
  if (Math.abs(df) > SPB_ROUNDING_TOLERANCE) bad.push('Taxfree');
  return { entered: true, dt, dv, df, bad };
}

function spbVrInput(key, fi, field, value) {
  spbVr[key][fi][field] = value.trim();
  spbRecalcVr();
  spbVrScheduleDraft();
}

function spbRecalcVr() {
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key] || !spbBook[key]) return;
    const T = { bt: 0, bv: 0, bf: 0, rt: 0, rv: 0, rf: 0, dt: 0, df: 0 };
    SPB_BS_MONTHS.forEach((_, fi) => {
      const b = spbBook[key][fi];
      T.bt += b.t; T.bv += b.v; T.bf += b.f;
      const v = spbMonthVerdict(key, fi);
      const dEl = f => document.getElementById(`spb-vrd-${key}-${fi}-${f}`);
      const sEl = document.getElementById(`spb-vrs-${key}-${fi}`);
      if (!v.entered) {
        dEl('t').textContent = '–'; dEl('f').textContent = '–';
        sEl.textContent = 'not entered'; sEl.className = 'spb-flag-na';
        return;
      }
      const e = spbVr[key][fi];
      T.rt += spbNum(e.t); T.rv += spbNum(e.v); T.rf += spbNum(e.f);
      T.dt += v.dt; T.df += v.df;
      dEl('t').textContent = spbFmt(v.dt); dEl('f').textContent = spbFmt(v.df);
      if (v.bad.length) {
        sEl.textContent = '✗ gap: ' + v.bad.join(', ');
        sEl.className = 'spb-flag-gap';
      } else {
        sEl.textContent = '✓ matched';
        sEl.className = 'spb-flag-ok';
      }
    });
    const set = (suffix, val) => { document.getElementById(`spb-vrt-${key}-${suffix}`).textContent = spbFmt(val); };
    Object.keys(T).forEach(k => set(k, T[k]));
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
    if (d && d.vr && d.vr.sales && d.vr.purchase) spbVr = d.vr;
  } catch (e) { /* ignore a corrupt draft */ }
}

// ════════════════════════════════════════════
//  EXCEL GENERATION — the complete 7-sheet workbook. All derived figures are
//  written as live SUM / cross-sheet formulas so the output stays auditable
//  in Excel; only the raw transaction values are literals.
// ════════════════════════════════════════════
const SPB_MONEY = '#,##0.00';

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

function spbTxnCells(ws, r, x) {
  ws.getCell(`A${r}`).value = x.date;
  ws.getCell(`B${r}`).value = x.bill;
  ws.getCell(`C${r}`).value = x.party;
  ws.getCell(`D${r}`).value = x.pan || null;
  [['E', x.taxfree], ['F', x.taxable], ['G', x.vat]].forEach(([col, v]) => {
    const c = ws.getCell(`${col}${r}`);
    c.value = v; c.numFmt = SPB_MONEY;
  });
}

// `res` caches the computed {f,t,v} sums alongside the formula — without a
// cached result some Excel builds show 0 until a manual recalc.
function spbSubtotalRow(ws, r, label, from, to, pan, res) {
  ws.getCell(`C${r}`).value = label;
  if (pan) ws.getCell(`D${r}`).value = pan;
  [['E', res.f], ['F', res.t], ['G', res.v]].forEach(([col, val]) => {
    const c = ws.getCell(`${col}${r}`);
    c.value = { formula: `SUM(${col}${from}:${col}${to})`, result: val || 0 };
    c.numFmt = SPB_MONEY;
  });
  ws.getRow(r).font = { bold: true };
}

const SPB_BOOK_COLS = [{ width: 12 }, { width: 22 }, { width: 44 }, { width: 14 }, { width: 12 }, { width: 15 }, { width: 13 }];
const SPB_BOOK_HEADERS = ['Date', 'Bill No.', 'Party Name', 'Pan No.', 'Tax Free', 'Taxable Amount', 'Vat'];

// Sales / Purchase sheets: cleaned transactions in date order with the month
// subtotal rows regenerated as live formulas (the input's embedded copies
// were stripped — these can't double-count because they're SUMs over blocks).
function spbSheetBook(wb, name, txns) {
  const ws = wb.addWorksheet(name);
  ws.columns = SPB_BOOK_COLS;
  spbHeaderRow(ws, 1, SPB_BOOK_HEADERS);
  const sorted = txns.slice().sort((a, b) => a.fi - b.fi || a.d - b.d || a.src - b.src);
  let r = 2;
  SPB_BS_MONTHS.forEach((_, fi) => {
    const monthRows = sorted.filter(x => x.fi === fi);
    if (!monthRows.length) return;
    const from = r;
    const res = { f: 0, t: 0, v: 0 };
    monthRows.forEach(x => {
      spbTxnCells(ws, r, x); r++;
      res.f += x.taxfree; res.t += x.taxable; res.v += x.vat;
    });
    spbSubtotalRow(ws, r, 'Total Of ' + VAT_MONTH_ORDER[fi], from, r - 1, null, res);
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

// Summary sheets: same columns, grouped by party (alphabetical), each group
// followed by its "<Party> Total" SUM row. Returns each group's subtotal row
// index so the Details sheet can reference it by formula.
function spbSheetSummary(wb, name, groups) {
  const ws = wb.addWorksheet(name);
  ws.columns = SPB_BOOK_COLS;
  spbHeaderRow(ws, 1, SPB_BOOK_HEADERS);
  const subRow = {};
  let r = 2;
  groups.forEach(g => {
    const from = r;
    g.rows.forEach(x => { spbTxnCells(ws, r, x); r++; });
    spbSubtotalRow(ws, r, g.display + ' Total', from, r - 1, g.pan, { f: g.taxfree, t: g.taxable, v: g.vat });
    subRow[g.key] = r;
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return subRow;
}

// Details sheets: one row per party, taxable descending, each cell a live
// reference to that party's subtotal row on the Summary sheet — plus a Grand
// Total row that must tie back to the book total (a built-in self-check the
// firm's hand-maintained file never had).
function spbSheetDetails(wb, name, groups, summaryName, subRow) {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 7 }, { width: 52 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 14 }];
  spbHeaderRow(ws, 1, ['S.No.', 'Party Name', 'Pan No.', 'Tax Free', 'Taxable Amount', 'Vat']);
  const ordered = groups.slice().sort((a, b) => b.taxable - a.taxable || b.vat - a.vat);
  const q = `'${summaryName}'`;
  ordered.forEach((g, i) => {
    const r = i + 2, sr = subRow[g.key];
    ws.getCell(`A${r}`).value = i + 1;
    ws.getCell(`B${r}`).value = g.display + ' Total';
    if (g.pan) ws.getCell(`C${r}`).value = g.pan;
    [['D', 'E', g.taxfree], ['E', 'F', g.taxable], ['F', 'G', g.vat]].forEach(([col, srcCol, val]) => {
      const c = ws.getCell(`${col}${r}`);
      c.value = { formula: `${q}!${srcCol}${sr}`, result: val };
      c.numFmt = SPB_MONEY;
    });
  });
  const tr = ordered.length + 2;
  ws.getCell(`B${tr}`).value = 'Grand Total';
  const grand = ordered.reduce((a, g) => ({ f: a.f + g.taxfree, t: a.t + g.taxable, v: a.v + g.vat }), { f: 0, t: 0, v: 0 });
  [['D', grand.f], ['E', grand.t], ['F', grand.v]].forEach(([col, val]) => {
    const c = ws.getCell(`${col}${tr}`);
    c.value = { formula: `SUM(${col}2:${col}${tr - 1})`, result: val };
    c.numFmt = SPB_MONEY;
  });
  ws.getRow(tr).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// Monthly sheet: same geometry as the firm's file (Sales block rows 4–18,
// Purchase block rows 24–38) plus a Remarks column. Two deliberate fixes vs
// the reference: the Difference sign is Return − Book in BOTH sections (the
// old file flipped Taxfree Diff between them), and the Total row sums every
// column (the old Sales total left As-per-Book blank).
function spbSheetMonthly(wb) {
  const ws = wb.addWorksheet('Monthly');
  ws.columns = [{ width: 20 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 15 }, { width: 13 }, { width: 30 }];
  const fyDot = spbFyDot();
  let base = 0;
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    const titleR = base + 1, headR = base + 4, subR = base + 5, firstR = base + 6, totR = firstR + 12;
    ws.mergeCells(`A${titleR}:J${titleR}`);
    ws.getCell(`A${titleR}`).value = `${label} Book ${fyDot}`;
    ws.getCell(`A${titleR}`).font = { bold: true, size: 13, color: { argb: 'FF0B1F3D' } };
    ws.mergeCells(`A${headR}:A${subR}`);
    ws.mergeCells(`B${headR}:D${headR}`); ws.mergeCells(`E${headR}:G${headR}`); ws.mergeCells(`H${headR}:I${headR}`);
    ws.mergeCells(`J${headR}:J${subR}`);
    [['A' + headR, 'Months'], ['B' + headR, 'As per Book'], ['E' + headR, 'As Per VAT Return'], ['H' + headR, 'Difference'], ['J' + headR, 'Remarks']]
      .forEach(([cell, txt]) => {
        const c = ws.getCell(cell);
        c.value = txt;
        c.font = { bold: true, color: { argb: 'FF0B1F3D' } };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    ['Taxable Amount', 'VAT Amount', 'Taxfree', 'Taxable Amount', 'VAT Amount', 'Taxfree', 'Taxable Diff', 'Taxfree Diff.'].forEach((txt, i) => {
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
      ws.getCell(`A${r}`).value = 'Total of ' + VAT_MONTH_ORDER[fi];
      [['B', b.t], ['C', b.v], ['D', b.f]].forEach(([col, val]) => {
        const c = ws.getCell(`${col}${r}`); c.value = val; c.numFmt = SPB_MONEY;
      });
      [['E', e.t], ['F', e.v], ['G', e.f]].forEach(([col, val]) => {
        const c = ws.getCell(`${col}${r}`);
        if (val !== '') { c.value = spbNum(val); c.numFmt = '#,##0'; }
      });
      if (v.entered) {
        ws.getCell(`H${r}`).value = { formula: `E${r}-B${r}`, result: v.dt };
        ws.getCell(`I${r}`).value = { formula: `G${r}-D${r}`, result: v.df };
        ws.getCell(`H${r}`).numFmt = SPB_MONEY; ws.getCell(`I${r}`).numFmt = SPB_MONEY;
        const remark = ws.getCell(`J${r}`);
        if (v.bad.length) {
          remark.value = 'MISMATCH — ' + v.bad.join(', ') + ' beyond rounding';
          remark.font = { bold: true, color: { argb: 'FFB42318' } };
        } else {
          remark.value = 'Matched';
          remark.font = { color: { argb: 'FF067647' } };
        }
      } else {
        ws.getCell(`J${r}`).value = 'Return not entered';
        ws.getCell(`J${r}`).font = { color: { argb: 'FF64748B' } };
      }
    });
    ws.getCell(`A${totR}`).value = 'Total';
    const colSum = {};
    SPB_BS_MONTHS.forEach((_, fi) => {
      const b = spbBook[key][fi], e = spbVr[key][fi], v = spbMonthVerdict(key, fi);
      colSum.B = (colSum.B || 0) + b.t; colSum.C = (colSum.C || 0) + b.v; colSum.D = (colSum.D || 0) + b.f;
      if (v.entered) {
        colSum.E = (colSum.E || 0) + spbNum(e.t); colSum.F = (colSum.F || 0) + spbNum(e.v); colSum.G = (colSum.G || 0) + spbNum(e.f);
        colSum.H = (colSum.H || 0) + v.dt; colSum.I = (colSum.I || 0) + v.df;
      }
    });
    ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach(col => {
      const c = ws.getCell(`${col}${totR}`);
      c.value = { formula: `SUM(${col}${firstR}:${col}${totR - 1})`, result: colSum[col] || 0 };
      c.numFmt = SPB_MONEY;
    });
    ws.getRow(totR).font = { bold: true };
    base = 20;   // Purchase block starts at row 21, matching the firm's layout
  });
}

function spbBuildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;   // recalc formulas the moment Excel opens the file
  SPB_SECTIONS.forEach(({ key, label }) => {
    if (!spbData[key]) return;
    spbSheetBook(wb, label, spbData[key].txns);
    const subRow = spbSheetSummary(wb, label + ' Summary', spbGroups[key]);
    spbSheetDetails(wb, label + ' Details', spbGroups[key], label + ' Summary', subRow);
  });
  spbSheetMonthly(wb);
  return wb;
}

async function spbGenerateExcel() {
  if (!spbData) { spbStatus('❌ Upload the Sales/Purchase file first.', 'error'); return; }
  if (!window.ExcelJS) { spbStatus('❌ Excel engine not loaded — reload the page and try again.', 'error'); return; }
  // Not a blocker — the reconciliation columns simply stay blank — but say so.
  const missing = SPB_SECTIONS.filter(s => spbData[s.key] &&
    SPB_BS_MONTHS.some((_, fi) => !spbMonthVerdict(s.key, fi).entered)).map(s => s.label);
  try {
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
function spbOnContextChange() {
  if (!spbData) return;
  spbVr = spbBlankVr();
  spbVrLoadDraft();
  spbRenderVrGrid();
}

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
    onSelect: c => {
      spbClientId = c.id != null ? c.id : null;
      input.value = c.name || '';
      document.getElementById('spb-pan').value = c.pan || '';
      spbOnContextChange();
    },
  });
  input.addEventListener('input', () => { spbClientId = null; });
  input.addEventListener('change', spbOnContextChange);
})();
