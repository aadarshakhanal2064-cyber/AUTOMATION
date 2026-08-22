// ════════════════════════════════════════════
//  VAT REGISTER
//  The firm's OWN VAT book. Both audit practices are VAT-registered, and
//  until now their register lived in a spreadsheet ("VAT Registar.ods") that
//  was re-typed from data this app already holds. A CLIENT's VAT book is
//  Autobooks (js/salesPurchaseBook.js) — nothing here touches client VAT.
//
//  FOUR VIEWS, but only three of them store anything:
//
//    Sales Register  — DERIVED from service_memos where apply_vat. The spec
//      sheet says so outright ("If we add Tick VAT in Service memo then this
//      sheet will be auto generated"), and it is the whole reason the module
//      exists. Same rule as Work Done's Pending List over document_register
//      and Service Memo's Pending Memos over audit_report_finalization: read
//      the source table, store nothing twice, and it can never go stale.
//
//    Purchase Register — the one genuinely typed page (vat_purchases).
//    Masebari          — computed live; only its two adjustments and the
//                        opening credit are stored (vat_returns).
//    VAT Collected     — VAT received from a client (vat_collections). The
//                        sheet states twice that this page has no link with
//                        the other three, so it is standalone.
//
//  ── THE SCOPE RULE, and it is not obvious ──
//  A VAT return is about the date a bill was ISSUED, never about the fiscal
//  year the work relates to. A memo dated Bhadra 2083 for FY 2081-82 audit
//  work is a Bhadra 2083 VAT sale. So every view scopes on the DATE's fiscal
//  year (memo_date / bill_date / payment_date), and the sheet's "F.Y" column
//  prints the memo's own fiscal_year as a work reference, which is a
//  different thing that happens to share a name. Scoping on the memo's
//  fiscal_year would silently file a sale in the wrong year.
//
//  vat_purchases.fiscal_year and vat_collections.fiscal_year are therefore
//  DERIVED FROM THE DATE on save, never typed — a stored denormalisation
//  that exists for the index, and can't disagree with the date it came from.
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Financial Management" menu.
ModuleRegistry.register({ id: 'vatRegister', group: 'main', buttonId: null, panelId: 'tab-vatRegister-panel' });

// ── Views ──
// id → { title, pane, onShow }. The header's Print/PDF/Excel buttons act on
// whichever view is showing, via vrLastModel — the Work Done / Service Memo
// idiom, so the export always matches what's on screen.
const VR_VIEWS = [
  { id: 'sales',       label: 'Sales Register',    title: 'VAT Sales Register' },
  { id: 'purchase',    label: 'Purchase Register', title: 'VAT Purchase Register' },
  { id: 'masebari',    label: 'Masebari',          title: 'VAT Return (Masebari)' },
  { id: 'collections', label: 'VAT Collected',     title: 'VAT Collected from Clients' },
];

let vrView = 'sales';
let vrMemos = [];           // all service memos (shared DataCache read)
let vrPurchases = [];       // vat_purchases for the selected firm + F.Y.
let vrCollections = [];     // vat_collections for the selected firm + F.Y.
let vrReturn = null;        // vat_returns row for firm + F.Y. + period
let vrPurchaseTable = null;
let vrLastModel = null;
let vrInitDone = false;
let vrLoaded = false;       // has the module ever loaded? gates vrOnMemosChanged
let vrEditingPurchaseId = null;
let vrEditingCollectionId = null;
let vrCollectingMemo = null; // the memo a new collection is being recorded against

// ── Fiscal-year default ──
// Dash format ('2083-84'), matching Service Memo and Party Ledger, from the
// one shared constant (CLAUDE.md §15 — never a todayBs()-derived year, which
// flips to the new year on Shrawan 1 while the firm is still mid-year).
const VR_FY_DEFAULT = vrFyLabel(window.FY_DEFAULT_START);
const VR_FY_START = 2078;
const VR_FY_END = 2085;

function vrFyLabel(startYear) { return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0'); }
function vrPeriods() { return window.VR_PERIODS || []; }

// ── Small helpers ──
function vrStatus(html, type) { showStatus(html, type, 'vr-status-area'); }
function vrUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function vrNum(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function vrAmt(v) { return fmtAmount(vrNum(v)); }
function vrVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function vrFirmKey() { return vrVal('vr-firm'); }
function vrFirmName(key) { const f = window.SERVICE_MEMO_FIRMS[key]; return (f && f.name) || key || '—'; }
// Short per-firm code for the VAT serial display ('SA', 'DC', …) — derived
// from the memo_prefix org_firms already carries (e.g. 'SM-SA'), so a new
// firm needs no separate config; adding one is still just a data change.
function vrFirmCode(firmKey) {
  const f = window.SERVICE_MEMO_FIRMS[firmKey];
  const prefix = (f && f.prefix) || '';
  const code = prefix.replace(/^SM-/, '');
  return code || (firmKey || '').slice(0, 2).toUpperCase();
}
// 'VAT-SA-0001' — the firm's own running VAT count, separate from the memo's
// own memo_number (SM-SA-00007 etc.). Assigned once per memo by the
// set_vat_serial() trigger the moment Apply VAT is first ticked; see
// db/2026-08-22_vat_serial.sql.
function vrVatSerialLabel(m) {
  if (!m || m.vat_serial == null) return '—';
  return 'VAT-' + vrFirmCode(m.firm_key) + '-' + String(m.vat_serial).padStart(4, '0');
}
function vrFy() { return vrVal('vr-fy') || VR_FY_DEFAULT; }
function vrFyStart() { return NepaliLocale.fyStartYear(vrFy()); }
function vrPeriodKeySelected() { return vrVal('vr-period') || 'T1'; }
function vrViewDef(id) { return VR_VIEWS.find(v => v.id === (id || vrView)) || VR_VIEWS[0]; }

// B.S. parts of an AD date string ('YYYY-MM-DD'), or null.
function vrBsOf(adDate) { return adDate ? NepaliLocale.adToBs(adDate) : null; }
function vrBsStr(adDate) { const p = vrBsOf(adDate); return p ? NepaliLocale.bsToStr(p) : '—'; }

// Fiscal-year START year of a B.S. date. Shrawan (month 4) opens the year, so
// anything before it belongs to the year that began the previous Baishakh.
function vrFyStartOfBs(p) { return p ? (p.month >= 4 ? p.year : p.year - 1) : null; }
function vrFyStartOfAd(adDate) { return vrFyStartOfBs(vrBsOf(adDate)); }

// Fiscal month index, 1 = Shrawan … 12 = Ashadh (CLAUDE.md §8 — NOT the B.S.
// calendar month number).
function vrFiscalMonthIndex(month) { return month >= 4 ? month - 3 : month + 9; }

// Which trimester a B.S. date falls in. Bucketing is by MONTH, never by day
// arithmetic against a period end date — the spec sheet wrote its periods as
// literal spans ending 07.30 / 11.30 / 03.31, and those days are wrong for
// any year whose Kartik, Falgun or Ashadh runs longer. An Ashadh 32 bill
// would fall outside every one of them and vanish from the return.
function vrPeriodOfBs(p) {
  if (!p) return null;
  const i = vrFiscalMonthIndex(p.month);
  return i <= 4 ? 'T1' : i <= 8 ? 'T2' : 'T3';
}

// The printed date span for a period — labels only. Rebuilt from the calendar
// table (NepaliLocale.bsMonthEnd) rather than hardcoded, for the reason above.
// Returns null outside the tabulated years, so a missing label degrades to a
// blank rather than a wrong one; bucketing never depends on this.
function vrPeriodSpan(key, fyStart) {
  const p = vrPeriods().find(x => x.key === key);
  if (!p || fyStart == null) return null;
  const m0 = p.months[0], m1 = p.months[p.months.length - 1];
  const y0 = m0 >= 4 ? fyStart : fyStart + 1;
  const y1 = m1 >= 4 ? fyStart : fyStart + 1;
  const end = NepaliLocale.bsMonthEnd(y1, m1);
  if (end == null) return null;
  return {
    from: NepaliLocale.bsToStr({ year: y0, month: m0, day: 1 }),
    to:   NepaliLocale.bsToStr({ year: y1, month: m1, day: end }),
  };
}
function vrPeriodSpanLabel(key, fyStart) {
  const s = vrPeriodSpan(key, fyStart);
  return s ? `${s.from} – ${s.to}` : '';
}

// ════════════════════════════════════════════
//  INIT & LOAD
// ════════════════════════════════════════════
async function vrInit() {
  if (!vrInitDone) {
    vrPopulateFirms();
    vrPopulateFy();
    vrPopulatePeriods();
    vrRenderViewToggle();
    vrInitDone = true;
  }
  await vrRefresh();
}

// The two audit practices only (user decision 2026-08-22). Reuses
// FINAL_ACCOUNT_FIRM_KEYS — the same set Final Account draws a Balance Sheet
// for — rather than a second list that could drift from it. The sister
// concerns and Service Memo's typed "Other" firm are deliberately absent.
// Read inside a function, never at file load: OrgIdentity fills these after
// sign-in (CLAUDE.md §6).
function vrFirmKeys() {
  return (window.FINAL_ACCOUNT_FIRM_KEYS || []).filter(k => window.SERVICE_MEMO_FIRMS[k]);
}

function vrPopulateFirms() {
  const sel = document.getElementById('vr-firm');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = vrFirmKeys()
    .map(k => `<option value="${escHtml(k)}">${escHtml(window.SERVICE_MEMO_FIRMS[k].name)}</option>`).join('');
  if (keep && vrFirmKeys().includes(keep)) sel.value = keep;
}

function vrPopulateFy() {
  const sel = document.getElementById('vr-fy');
  if (!sel) return;
  const opts = [];
  for (let y = VR_FY_END; y >= VR_FY_START; y--) opts.push(vrFyLabel(y));
  sel.innerHTML = opts.map(fy => `<option value="${fy}">${fy}</option>`).join('');
  sel.value = VR_FY_DEFAULT;
}

function vrPopulatePeriods() {
  const sel = document.getElementById('vr-period');
  if (!sel) return;
  sel.innerHTML = vrPeriods().map(p => `<option value="${p.key}">${escHtml(p.label)}</option>`).join('');
}

function vrRenderViewToggle() {
  const el = document.getElementById('vr-view-toggle');
  if (!el) return;
  el.innerHTML = VR_VIEWS.map(v =>
    `<button id="vr-tab-${v.id}" class="rep-view-btn${v.id === vrView ? ' active' : ''}" onclick="vrShowView('${v.id}')">${escHtml(v.label)}</button>`
  ).join('');
}

// Everything the module reads, for the current firm + F.Y.
// Memos come through the SHARED cache key with the byte-identical loader
// Service Memo uses (js/serviceMemo.js), so opening both tabs is one
// round-trip and a memo write already invalidates it for us.
async function vrRefresh() {
  const firm = vrFirmKey();
  if (!firm) { vrStatus('No VAT-registered firm is configured. Add one in Firm Setup.', 'info'); return; }
  vrStatus('<span class="spinner spinner-navy"></span> Loading VAT register…', 'searching');
  try {
    const [memos, purchases, collections, ret] = await Promise.all([
      DataCache.get(window.LEDGER_KEYS.memosSm, () => sbFetchAll(() => window.sb.from('service_memos')
        .select('*, clients(name, email, pan, address)').order('created_at', { ascending: false }))),
      sbFetchAll(() => window.sb.from('vat_purchases').select('*')
        .eq('firm_key', firm).eq('fiscal_year', vrFy()).order('bill_date', { ascending: true }).order('id', { ascending: true })),
      sbFetchAll(() => window.sb.from('vat_collections').select('*')
        .eq('firm_key', firm).eq('fiscal_year', vrFy()).order('payment_date', { ascending: true }).order('id', { ascending: true })),
      vrFetchReturn(firm, vrFy(), vrPeriodKeySelected()),
    ]);
    vrMemos = memos || [];
    vrPurchases = purchases || [];
    vrCollections = collections || [];
    vrReturn = ret;
    vrLoaded = true;
    document.getElementById('vr-status-area').innerHTML = '';
    vrRender();
  } catch (e) {
    vrStatus('❌ Failed to load the VAT register: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

async function vrFetchReturn(firm, fy, period) {
  const { data, error } = await window.sb.from('vat_returns').select('*')
    .eq('firm_key', firm).eq('fiscal_year', fy).eq('period', period).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Called from smReload() in js/serviceMemo.js — a memo write anywhere (including
// the Edit button on our own sales register) has to reach this module, because
// the sales register IS those rows. Guarded there with `typeof`, the same way
// salesPurchaseBookConfirm.js and workDoneTodo.js register onto an earlier file.
function vrOnMemosChanged() {
  if (!vrLoaded) return;   // never loaded — nothing on screen to correct
  vrRefresh().catch(() => { /* vrRefresh reports its own failures */ });
}

// Firm / F.Y. / period changed — every view depends on the first two.
async function vrOnContextChange() {
  await vrRefresh();
}

function vrShowView(id) {
  vrView = id;
  VR_VIEWS.forEach(v => {
    const btn = document.getElementById('vr-tab-' + v.id);
    const pane = document.getElementById('vr-pane-' + v.id);
    if (btn) btn.classList.toggle('active', v.id === id);
    if (pane) pane.style.display = v.id === id ? '' : 'none';
  });
  // The period picker only means anything on the return itself.
  const pw = document.getElementById('vr-period-wrap');
  if (pw) pw.style.display = id === 'masebari' ? '' : 'none';
  vrRender();
}

function vrRender() {
  if (vrView === 'sales') vrRenderSales();
  else if (vrView === 'purchase') vrRenderPurchase();
  else if (vrView === 'masebari') vrRenderMasebari();
  else vrRenderCollections();
}

// ════════════════════════════════════════════
//  1. SALES REGISTER — derived from service_memos
// ════════════════════════════════════════════
//
// Scoped by the memo DATE's fiscal year, not the memo's fiscal_year field —
// see the scope rule in the file header. The F.Y column still prints the
// memo's own fiscal_year, because that is what the spec sheet asks for and
// it answers a different question (which year's work this fee was for).
function vrSalesMemos() {
  const firm = vrFirmKey(), fyStart = vrFyStart();
  return (vrMemos || [])
    .filter(m => m.apply_vat && m.firm_key === firm && vrFyStartOfAd(m.memo_date) === fyStart)
    .slice()
    .sort((a, b) => String(a.memo_date).localeCompare(String(b.memo_date)) || (a.id - b.id));
}

// Sales rows inside one trimester (used by the Masebari).
function vrSalesMemosInPeriod(period) {
  return vrSalesMemos().filter(m => vrPeriodOfBs(vrBsOf(m.memo_date)) === period);
}

function vrRenderSales() {
  const rows = vrSalesMemos();
  const model = vrSalesModel(rows);
  vrLastModel = model;
  const el = document.getElementById('vr-sales-output');
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = `<div class="log-empty">No VAT sales for ${escHtml(vrFirmName(vrFirmKey()))} in F.Y. ${escHtml(vrFy())}.<br />
      A service memo appears here the moment its <strong>Apply VAT</strong> box is ticked — nothing is entered on this page.</div>`;
    vrSetExportEnabled(false);
    return;
  }

  // ReportExport draws the figures; the Edit column is ours, so it is appended
  // to the rendered table rather than being a model column (a model column
  // would end up in the PDF and the Excel, where a button means nothing).
  el.innerHTML = ReportExport.toHtml(model);
  vrAppendEditColumn(el, rows);
  vrSetExportEnabled(true);
}

// Adds an "Edit" header + one button per data row to a ReportExport table.
// Total rows get an empty cell. Keyed by array index against the same rows
// the model was built from, so nothing free-text ever reaches an onclick
// (CLAUDE.md §10 rule 13).
function vrAppendEditColumn(container, rows) {
  const table = container.querySelector('table');
  if (!table) return;
  const headRow = table.querySelector('thead tr');
  if (headRow) {
    const th = document.createElement('th');
    th.style.textAlign = 'left';
    th.textContent = 'Edit';
    headRow.appendChild(th);
  }
  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  bodyRows.forEach((tr, i) => {
    const td = document.createElement('td');
    if (i < rows.length) {
      td.innerHTML = `<button class="btn btn-outline btn-sm" data-vr-memo="${i}">Edit</button>`;
    } else {
      // A total row — widen it rather than leaving a stray empty cell.
      const first = tr.querySelector('td');
      if (first && first.colSpan > 1) { first.colSpan += 1; return; }
    }
    tr.appendChild(td);
  });
  container.onclick = (e) => {
    const b = e.target.closest('[data-vr-memo]');
    if (!b) return;
    const m = rows[parseInt(b.dataset.vrMemo, 10)];
    // The memo drawer lives at body level, outside every tab panel, so it
    // opens over this one correctly. Saving there calls smReload(), which
    // calls vrOnMemosChanged() and brings the corrected figure back here.
    if (m && typeof smOpenCreate === 'function') smOpenCreate(m);
  };
}

function vrSalesModel(rows) {
  const cells = rows.map(m => [
    vrVatSerialLabel(m),
    m.memo_date || '—',
    vrBsStr(m.memo_date),
    m.memo_number || '—',
    m.client_name || '—',
    m.client_pan || '—',
    vrNum(m.professional_fee),
    vrNum(m.vat_amount),
    vrNum(m.total_amount),
    typeof smNatureText === 'function' ? smNatureText(m) : (m.nature_category || '—'),
    m.fiscal_year || '—',
  ]);
  const sum = i => rows.reduce((t, m) => t + vrNum([null, null, null, null, null, null, m.professional_fee, m.vat_amount, m.total_amount][i]), 0);
  return {
    title: 'VAT Sales Register',
    subtitleLines: [vrFirmName(vrFirmKey()), `F.Y. ${vrFy()}`, `${rows.length} bill${rows.length === 1 ? '' : 's'}`],
    landscape: true,
    columns: [
      { label: 'VAT Serial No.', align: 'l', w: 13 },
      { label: 'Date (English)', align: 'l', w: 12 },
      { label: 'Date (Nepali)', align: 'l', w: 12 },
      { label: 'Bill No.', align: 'l', w: 13 },
      { label: 'Party Name', align: 'l', w: 22 },
      { label: 'PAN', align: 'l', w: 11 },
      { label: 'Taxable Amount', align: 'r', num: true, w: 14 },
      { label: 'VAT', align: 'r', num: true, w: 12 },
      { label: 'Total', align: 'r', num: true, w: 14 },
      { label: 'Nature of Work', align: 'l', w: 22 },
      { label: 'F.Y.', align: 'l', w: 10 },
    ],
    rows: cells.map(c => ({ cells: c })).concat([{
      style: 'grand',
      cells: ['Total', '', '', '', '', '', sum(6), sum(7), sum(8), '', ''],
    }]),
    note: "Derived from Service Memo — every memo with VAT applied. Edit a bill in Service Memo; nothing is entered on this page. VAT Serial No. is this firm's own running VAT count, separate from the memo number.",
  };
}

// ════════════════════════════════════════════
//  2. PURCHASE REGISTER — vat_purchases
// ════════════════════════════════════════════
function vrPurchaseTotal(r) { return vrNum(r.tax_free) + vrNum(r.taxable) + vrNum(r.vat); }

function vrPurchasesInPeriod(period) {
  return (vrPurchases || []).filter(r => vrPeriodOfBs(vrBsOf(r.bill_date)) === period);
}

// The head vocabulary. Assets read DEP_SLM_CLASSES (depreciable only — land
// is not depreciable and a land purchase is not a VAT purchase), so a firm
// asset bought here and the schedule that writes it off name it identically,
// and a class added to that config list reaches this picker for free.
function vrAssetHeads() {
  return (window.DEP_SLM_CLASSES || []).filter(c => c.depreciable).map(c => c.name);
}

// Expense heads: the sheet's own seed list, plus every head already typed
// here, plus every expense name already used in Bank Entry. The third source
// is the user's decision (2026-08-22) that the two modules share the
// VOCABULARY and deliberately not the figures — no purchase recorded here
// ever reaches Final Account. bbPopulateExpenseNames idiom: a field that
// accepts anything, seeded so it can't fragment on near-duplicate spellings.
function vrExpenseHeads() {
  const seen = new Map();   // lower-cased → first spelling seen
  const add = v => {
    const s = String(v || '').trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  };
  (window.VR_EXPENSE_HEADS || []).forEach(add);
  (vrPurchases || []).forEach(r => { if (r.nature === 'expenses') add(r.head); });
  vrBankExpenseNames().forEach(add);
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

// Expense names already used in Bank Entry, if that module has loaded its
// transactions. Read-only and best-effort: this is a vocabulary hint, so a
// module that hasn't been opened yet simply contributes nothing rather than
// forcing a fetch of a table we otherwise have no reason to read.
function vrBankExpenseNames() {
  const txns = (typeof bbTxns !== 'undefined' && Array.isArray(bbTxns)) ? bbTxns : [];
  return txns.filter(t => t.particular === 'expenses' && t.party_name).map(t => t.party_name);
}

// Party names already used, so a supplier typed last month comes back the
// same way. There is no supplier master and this is not one.
function vrPartyNames() {
  const seen = new Map();
  (vrPurchases || []).forEach(r => {
    const s = String(r.party_name || '').trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

function vrRenderPurchase() {
  const model = vrPurchaseModel(vrPurchases);
  vrLastModel = model;
  vrSetExportEnabled(vrPurchases.length > 0);

  const wrap = document.getElementById('vr-purchase-table');
  if (!wrap) return;
  if (vrPurchaseTable) { try { vrPurchaseTable.destroy(); } catch (e) { /* already gone */ } vrPurchaseTable = null; }

  if (!vrPurchases.length) {
    wrap.innerHTML = `<div class="log-empty">No purchase bills for ${escHtml(vrFirmName(vrFirmKey()))} in F.Y. ${escHtml(vrFy())}.<br />
      Click <strong>Add Purchase Bill</strong> to record one.</div>`;
    vrRenderPurchaseSummary();
    return;
  }

  wrap.innerHTML = '';
  const rows = vrPurchases.map(r => ({ ...r, _total: vrPurchaseTotal(r), _bs: vrBsStr(r.bill_date) }));
  vrPurchaseTable = TableEngine.createTable(wrap, {
    data: rows,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    columns: [
      { title: 'Date (English)', field: 'bill_date', width: 125, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Date (Nepali)', field: '_bs', width: 120, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Bill No.', field: 'bill_no', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Party Name', field: 'party_name', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'PAN', field: 'party_pan', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Tax Free', field: 'tax_free', width: 110, hozAlign: 'right', formatter: c => vrAmt(c.getValue()) },
      { title: 'Taxable', field: 'taxable', width: 120, hozAlign: 'right', formatter: c => vrAmt(c.getValue()) },
      { title: 'VAT', field: 'vat', width: 110, hozAlign: 'right', formatter: c => vrAmt(c.getValue()) },
      { title: 'Total', field: '_total', width: 125, hozAlign: 'right',
        formatter: c => `<span style="font-weight:600;">${vrAmt(c.getValue())}</span>` },
      { title: 'Nature', field: 'nature', width: 100, formatter: c => c.getValue() === 'assets'
          ? '<span class="log-badge badge-neutral">Assets</span>'
          : '<span class="log-badge badge-sent">Expenses</span>' },
      { title: 'Head', field: 'head', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Remarks', field: 'remarks', minWidth: 140, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 150, formatter: () => {
          const btn = (a, l) => `<button class="btn btn-outline btn-sm" data-action="${a}">${l}</button>`;
          return `<div class="client-actions">${btn('edit', 'Edit')}${btn('delete', 'Delete')}</div>`;
        },
        cellClick: (e, cell) => {
          const b = e.target.closest('[data-action]'); if (!b) return;
          const row = cell.getRow().getData();
          if (b.dataset.action === 'edit') vrOpenPurchase(vrPurchases.find(p => p.id === row.id));
          else if (b.dataset.action === 'delete') vrDeletePurchase(vrPurchases.find(p => p.id === row.id));
        } },
    ],
  });
  vrRenderPurchaseSummary();
}

function vrRenderPurchaseSummary() {
  const el = document.getElementById('vr-purchase-summary');
  if (!el) return;
  const t = vrPurchases.reduce((a, r) => ({
    free: a.free + vrNum(r.tax_free), tax: a.tax + vrNum(r.taxable),
    vat: a.vat + vrNum(r.vat), total: a.total + vrPurchaseTotal(r),
  }), { free: 0, tax: 0, vat: 0, total: 0 });
  const cell = (l, v, strong) =>
    `<div><div style="font-size:var(--fs-xs); color:var(--text-muted);">${escHtml(l)}</div>
     <div style="font-variant-numeric:tabular-nums; font-weight:${strong ? 700 : 600}; font-size:var(--fs-lg);${strong ? ' color:var(--brand-navy);' : ''}">${vrAmt(v)}</div></div>`;
  el.innerHTML = `<div style="display:flex; gap:34px; flex-wrap:wrap;">
    ${cell('Tax Free', t.free)}${cell('Taxable', t.tax)}${cell('VAT', t.vat)}${cell('Total', t.total, true)}
  </div>`;
}

function vrPurchaseModel(rows) {
  const sum = f => rows.reduce((t, r) => t + vrNum(r[f]), 0);
  const totals = rows.reduce((t, r) => t + vrPurchaseTotal(r), 0);
  return {
    title: 'VAT Purchase Register',
    subtitleLines: [vrFirmName(vrFirmKey()), `F.Y. ${vrFy()}`, `${rows.length} bill${rows.length === 1 ? '' : 's'}`],
    landscape: true,
    columns: [
      { label: 'Date (English)', align: 'l', w: 12 },
      { label: 'Date (Nepali)', align: 'l', w: 12 },
      { label: 'Bill No.', align: 'l', w: 11 },
      { label: 'Party Name', align: 'l', w: 22 },
      { label: 'PAN', align: 'l', w: 11 },
      { label: 'Tax Free', align: 'r', num: true, w: 12 },
      { label: 'Taxable Amount', align: 'r', num: true, w: 13 },
      { label: 'VAT', align: 'r', num: true, w: 11 },
      { label: 'Total Amount', align: 'r', num: true, w: 13 },
      { label: 'Nature', align: 'l', w: 10 },
      { label: 'Head of Expenses / Assets', align: 'l', w: 22 },
      { label: 'Remarks', align: 'l', w: 16 },
    ],
    rows: rows.map(r => ({ cells: [
      r.bill_date || '—', vrBsStr(r.bill_date), r.bill_no || '—', r.party_name || '—', r.party_pan || '—',
      vrNum(r.tax_free), vrNum(r.taxable), vrNum(r.vat), vrPurchaseTotal(r),
      r.nature === 'assets' ? 'Assets' : 'Expenses', r.head || '—', r.remarks || '—',
    ] })).concat([{
      style: 'grand',
      cells: ['Total', '', '', '', '', sum('tax_free'), sum('taxable'), sum('vat'), totals, '', '', ''],
    }]),
  };
}

// ── Purchase drawer ──
function vrOpenPurchase(existing) {
  vrEditingPurchaseId = existing ? existing.id : null;
  document.getElementById('vr-p-drawer-title').textContent = existing ? 'Edit Purchase Bill' : 'Add Purchase Bill';
  document.getElementById('vr-p-drawer-status').innerHTML = '';
  document.getElementById('vr-p-delete-btn').style.display = existing ? '' : 'none';

  // Always assign — never `if (v) el.value = v`, which leaves the previous
  // record's value standing whenever the new one's field is blank (CLAUDE.md §9).
  document.getElementById('vr-p-date').value = existing ? (existing.bill_date || '') : NepaliLocale.todayISO();
  document.getElementById('vr-p-billno').value = existing ? (existing.bill_no || '') : '';
  document.getElementById('vr-p-party').value = existing ? (existing.party_name || '') : '';
  document.getElementById('vr-p-pan').value = existing ? (existing.party_pan || '') : '';
  document.getElementById('vr-p-taxfree').value = existing ? (vrNum(existing.tax_free) || '') : '';
  document.getElementById('vr-p-taxable').value = existing ? (vrNum(existing.taxable) || '') : '';
  document.getElementById('vr-p-vat').value = existing ? (vrNum(existing.vat) || '') : '';
  document.getElementById('vr-p-nature').value = existing ? (existing.nature || 'expenses') : 'expenses';
  document.getElementById('vr-p-remarks').value = existing ? (existing.remarks || '') : '';

  vrFillDatalist('vr-p-parties', vrPartyNames());
  vrOnNatureChange();
  document.getElementById('vr-p-head').value = existing ? (existing.head || '') : '';

  vrRenderPurchaseTotal();
  vrRenderBillPeriodHint();
  document.getElementById('vr-p-drawer').classList.add('open');
}
function vrClosePurchase() { document.getElementById('vr-p-drawer').classList.remove('open'); }

function vrFillDatalist(id, values) {
  const dl = document.getElementById(id);
  if (dl) dl.innerHTML = values.map(v => `<option value="${escHtml(v)}"></option>`).join('');
}

// Expenses → the open datalist. Assets → the depreciation classes, offered as
// a closed <select>: an asset class is a fixed accounting vocabulary shared
// with the depreciation schedule, and a free-typed one would never match it.
function vrOnNatureChange() {
  const nature = vrVal('vr-p-nature');
  const label = document.getElementById('vr-p-head-label');
  const input = document.getElementById('vr-p-head');
  const select = document.getElementById('vr-p-head-select');
  const isAsset = nature === 'assets';
  if (label) label.textContent = isAsset ? 'Asset Class' : 'Head of Expenses';
  if (input) input.style.display = isAsset ? 'none' : '';
  if (select) {
    select.style.display = isAsset ? '' : 'none';
    if (isAsset) {
      const keep = select.value;
      select.innerHTML = '<option value="">— select —</option>' +
        vrAssetHeads().map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
      if (keep) select.value = keep;
    }
  }
  if (!isAsset) vrFillDatalist('vr-p-heads', vrExpenseHeads());
}

// VAT seeds at the standard rate but stays editable — a supplier bill rounds
// its own way, and the register has to print the bill, not a recomputation.
// Only ever fills a BLANK box, so a figure already typed is never rewritten.
function vrOnTaxableInput() {
  const vatEl = document.getElementById('vr-p-vat');
  if (!vatEl) return;
  const taxable = vrNum(vrVal('vr-p-taxable'));
  if (!vatEl.value.trim() || vatEl.dataset.auto === '1') {
    vatEl.value = taxable ? (Math.round(taxable * window.VAT_STANDARD_RATE * 100) / 100) : '';
    vatEl.dataset.auto = '1';
  }
  vrRenderPurchaseTotal();
}
function vrOnVatInput() {
  const vatEl = document.getElementById('vr-p-vat');
  if (vatEl) vatEl.dataset.auto = '';   // touched by hand — stop auto-filling it
  vrRenderPurchaseTotal();
}

function vrRenderPurchaseTotal() {
  const el = document.getElementById('vr-p-total');
  if (!el) return;
  const t = vrNum(vrVal('vr-p-taxfree')) + vrNum(vrVal('vr-p-taxable')) + vrNum(vrVal('vr-p-vat'));
  el.textContent = fmtAmount(t);
}

// Names the fiscal year and trimester the typed date actually lands in — the
// bill is filed by its DATE, and a date outside the selected year is a real
// mistake worth showing before the save rather than after it.
function vrRenderBillPeriodHint() {
  const el = document.getElementById('vr-p-period-hint');
  if (!el) return;
  const ad = vrVal('vr-p-date');
  const bs = vrBsOf(ad);
  if (!bs) { el.innerHTML = ''; return; }
  const fyStart = vrFyStartOfBs(bs);
  const period = vrPeriodOfBs(bs);
  const mismatch = fyStart !== vrFyStart();
  el.innerHTML = `<span style="color:${mismatch ? 'var(--red)' : 'var(--text-muted)'};">
    ${escHtml(NepaliLocale.bsToStr(bs))} — F.Y. ${escHtml(vrFyLabel(fyStart))}, ${escHtml(period)}
    ${mismatch ? ' · this bill will be filed under a different fiscal year than the one selected' : ''}</span>`;
}

async function vrSavePurchase(btn) {
  const errEl = 'vr-p-drawer-status';
  const billDate = vrVal('vr-p-date');
  const party = vrVal('vr-p-party');
  if (!billDate) { showStatus('Enter the bill date.', 'info', errEl); return; }
  if (!party) { showStatus('Enter the party name.', 'info', errEl); return; }

  const bs = vrBsOf(billDate);
  if (!bs) { showStatus('That bill date could not be converted to B.S. — check it.', 'info', errEl); return; }
  // fiscal_year is DERIVED from the date, never typed (see the file header).
  const fy = vrFyLabel(vrFyStartOfBs(bs));

  const nature = vrVal('vr-p-nature');
  const head = nature === 'assets' ? vrVal('vr-p-head-select') : vrVal('vr-p-head');

  // Duplicate guard — a warn-and-confirm naming the existing bill, NOT a block
  // (CLAUDE.md §15): two suppliers legitimately issue the same bill number, and
  // one supplier can issue a credit note carrying the original's number.
  const dup = vrFindDuplicateBill(billDate, party, vrVal('vr-p-pan'), vrVal('vr-p-billno'), fy);
  if (dup && !confirm(
    `A bill numbered "${dup.bill_no || '—'}" from ${dup.party_name} dated ${dup.bill_date} `
    + `(Rs. ${vrAmt(vrPurchaseTotal(dup))}) is already recorded for F.Y. ${fy}.\n\n`
    + 'Save this one as well?')) {
    showStatus('Not saved — the existing bill is already in the register.', 'info', errEl);
    return;
  }

  const payload = {
    firm_key: vrFirmKey(),
    fiscal_year: fy,
    bill_date: billDate,
    bill_no: vrVal('vr-p-billno') || null,
    party_name: party,
    party_pan: vrVal('vr-p-pan') || null,
    tax_free: vrNum(vrVal('vr-p-taxfree')),
    taxable: vrNum(vrVal('vr-p-taxable')),
    vat: vrNum(vrVal('vr-p-vat')),
    nature,
    head: head || null,
    remarks: vrVal('vr-p-remarks') || null,
    updated_by: vrUserEmail(),
  };
  if (!vrEditingPurchaseId) payload.created_by = vrUserEmail();

  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      let id = vrEditingPurchaseId;
      if (id) {
        const { error } = await window.sb.from('vat_purchases').update(payload).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await window.sb.from('vat_purchases').insert(payload).select('id').single();
        if (error) throw error;
        id = data.id;
      }
      AuditLog.record(vrEditingPurchaseId ? 'vat_purchase_updated' : 'vat_purchase_created', {
        module: 'vatRegister', recordRef: id,
        firmKey: payload.firm_key, fiscalYear: fy, partyName: party, amount: vrPurchaseTotal(payload),
      });
      vrClosePurchase();
      showToast(`✅ Purchase bill from <strong>${escHtml(party)}</strong> saved.`, 'success');
      // Refresh in the background — the drawer is already closed and the
      // toast has confirmed the write (CLAUDE.md §4 save contract).
      vrRefresh().catch(e => showToast('❌ Saved, but the register failed to refresh: ' + escHtml(friendlyDbError(e)), 'error'));
    } catch (e) {
      showStatus('❌ Could not save the bill: ' + escHtml(friendlyDbError(e)), 'error', errEl);
    }
  });
}

// A same-year bill with the same number from the same party. PANs are
// normalised through toEnglishDigits first — a Devanagari-numeral PAN and its
// English twin are the same tax ID and would otherwise never match (CLAUDE.md §6).
function vrFindDuplicateBill(billDate, party, pan, billNo, fy) {
  if (!billNo) return null;   // no number to collide on
  const norm = v => NepaliLocale.toEnglishDigits(String(v || '')).trim().toLowerCase();
  const nBill = norm(billNo), nPan = norm(pan), nParty = norm(party);
  return (vrPurchases || []).find(r =>
    r.id !== vrEditingPurchaseId
    && r.fiscal_year === fy
    && norm(r.bill_no) === nBill
    && (nPan ? norm(r.party_pan) === nPan : norm(r.party_name) === nParty)
  ) || null;
}

async function vrDeletePurchase(row) {
  if (!row) return;
  if (!confirm(`Delete the bill from ${row.party_name} dated ${row.bill_date} (Rs. ${vrAmt(vrPurchaseTotal(row))})?\n\nThis cannot be undone.`)) return;
  try {
    const { error } = await window.sb.from('vat_purchases').delete().eq('id', row.id);
    if (error) throw error;
    AuditLog.record('vat_purchase_deleted', {
      module: 'vatRegister', recordRef: row.id,
      firmKey: row.firm_key, fiscalYear: row.fiscal_year, partyName: row.party_name,
    });
    vrClosePurchase();
    showToast('✅ Purchase bill deleted.', 'success');
    await vrRefresh();
  } catch (e) {
    vrStatus('❌ Could not delete the bill: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// ════════════════════════════════════════════
//  3. MASEBARI — the trimester return
// ════════════════════════════════════════════
//
// Everything except the two adjustments and the opening credit recomputes on
// every open. There is deliberately no filed flag and no snapshot (user
// decision 2026-08-22) — the return is always live, exactly as the
// spreadsheet is.
function vrMasebariFigures() {
  const period = vrPeriodKeySelected();
  const sales = vrSalesMemosInPeriod(period);
  const purch = vrPurchasesInPeriod(period);
  const r = vrReturn || {};

  const salesAmt = sales.reduce((t, m) => t + vrNum(m.professional_fee), 0);
  const salesVat = sales.reduce((t, m) => t + vrNum(m.vat_amount), 0);
  const taxFree  = purch.reduce((t, p) => t + vrNum(p.tax_free), 0);
  const taxable  = purch.reduce((t, p) => t + vrNum(p.taxable), 0);
  const purchVat = purch.reduce((t, p) => t + vrNum(p.vat), 0);

  const sAdjAmt = vrNum(r.sales_adj_amount), sAdjVat = vrNum(r.sales_adj_vat);
  const pAdjAmt = vrNum(r.purchase_adj_amount), pAdjVat = vrNum(r.purchase_adj_vat);
  const opening = vrNum(r.opening_credit);

  // Tax-free purchase is shown on its own line and is NOT part of the input
  // total — there is no VAT on it to claim. The spec sheet's own Total
  // formula excludes it the same way.
  const outAmt = salesAmt + sAdjAmt, outVat = salesVat + sAdjVat;
  const inAmt = taxable + pAdjAmt,   inVat = purchVat + pAdjVat;
  const diff = outVat - inVat;
  const net = diff - opening;

  return { period, sales, purch, salesAmt, salesVat, taxFree, taxable, purchVat,
           sAdjAmt, sAdjVat, pAdjAmt, pAdjVat, opening, outAmt, outVat, inAmt, inVat, diff, net,
           sAdjNote: r.sales_adj_note || '', pAdjNote: r.purchase_adj_note || '', remarks: r.remarks || '' };
}

function vrRenderMasebari() {
  const f = vrMasebariFigures();
  const model = vrMasebariModel(f);
  vrLastModel = model;
  vrSetExportEnabled(true);

  // The typed boxes reflect the loaded return row.
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('vr-m-sadj-amt', f.sAdjAmt || '');
  set('vr-m-sadj-vat', f.sAdjVat || '');
  set('vr-m-sadj-note', f.sAdjNote);
  set('vr-m-padj-amt', f.pAdjAmt || '');
  set('vr-m-padj-vat', f.pAdjVat || '');
  set('vr-m-padj-note', f.pAdjNote);
  set('vr-m-opening', f.opening || '');
  set('vr-m-remarks', f.remarks);

  const span = document.getElementById('vr-m-span');
  if (span) {
    const label = vrPeriodSpanLabel(f.period, vrFyStart());
    span.textContent = label ? `${f.period} · ${label}` : f.period;
  }
  const counts = document.getElementById('vr-m-counts');
  if (counts) {
    counts.innerHTML = `${f.sales.length} sales bill${f.sales.length === 1 ? '' : 's'} · `
      + `${f.purch.length} purchase bill${f.purch.length === 1 ? '' : 's'} in this period`;
  }

  const out = document.getElementById('vr-masebari-output');
  if (out) out.innerHTML = ReportExport.toHtml(model);
}

function vrMasebariModel(f) {
  const span = vrPeriodSpanLabel(f.period, vrFyStart());
  // Two total rows, not the spec sheet's single mixed one — its two formulas
  // add a purchase amount and a sales VAT into one line, which cannot be read.
  // Split, the Difference is visibly Output VAT − Input VAT. Same answer.
  const rows = [
    { style: 'section', cells: ['Sales'] },
    { cells: ['Sales', f.salesAmt, f.salesVat] },
    { cells: [`Sales Adjustment${f.sAdjNote ? ' — ' + f.sAdjNote : ''}`, f.sAdjAmt, f.sAdjVat] },
    { style: 'total', cells: ['Total Sales / Output VAT', f.outAmt, f.outVat] },
    { style: 'section', cells: ['Purchase'] },
    { cells: ['Tax Free Purchase', f.taxFree, null] },
    { cells: ['Taxable Purchase', f.taxable, f.purchVat] },
    { cells: [`Purchase Adjustment${f.pAdjNote ? ' — ' + f.pAdjNote : ''}`, f.pAdjAmt, f.pAdjVat] },
    { style: 'total', cells: ['Total Taxable Purchase / Input VAT', f.inAmt, f.inVat] },
    { style: 'section', cells: ['Position'] },
    { style: 'total', cells: ['Difference (Output VAT − Input VAT)', null, f.diff] },
    { cells: ['Less: Opening credit carried forward', null, f.opening] },
    { style: 'grand', cells: ['Payable if (+), Receivable if (−)', null, f.net] },
  ];
  return {
    title: 'VAT Return — Masebari',
    subtitleLines: [
      vrFirmName(vrFirmKey()),
      `F.Y. ${vrFy()} · ${f.period}${span ? ' (' + span + ')' : ''}`,
    ].concat(f.remarks ? [f.remarks] : []),
    landscape: false,
    columns: [
      { label: 'Particulars', align: 'l', w: 46 },
      { label: 'Amount', align: 'r', num: true, w: 18 },
      { label: 'VAT', align: 'r', num: true, w: 18 },
    ],
    rows,
    note: 'Sales are derived from Service Memo and purchases from the purchase register; only the two adjustments and the opening credit are entered. Tax-free purchase carries no VAT and is excluded from the input total.',
  };
}

async function vrSaveReturn(btn) {
  const errEl = 'vr-m-status';
  const payload = {
    firm_key: vrFirmKey(),
    fiscal_year: vrFy(),
    period: vrPeriodKeySelected(),
    sales_adj_amount: vrNum(vrVal('vr-m-sadj-amt')),
    sales_adj_vat: vrNum(vrVal('vr-m-sadj-vat')),
    sales_adj_note: vrVal('vr-m-sadj-note') || null,
    purchase_adj_amount: vrNum(vrVal('vr-m-padj-amt')),
    purchase_adj_vat: vrNum(vrVal('vr-m-padj-vat')),
    purchase_adj_note: vrVal('vr-m-padj-note') || null,
    opening_credit: vrNum(vrVal('vr-m-opening')),
    remarks: vrVal('vr-m-remarks') || null,
    updated_by: vrUserEmail(),
  };
  if (!vrReturn) payload.created_by = vrUserEmail();

  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      let id = vrReturn && vrReturn.id;
      if (id) {
        const { error } = await window.sb.from('vat_returns').update(payload).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await window.sb.from('vat_returns').insert(payload).select('id').single();
        if (error) throw error;
        id = data.id;
      }
      AuditLog.record('vat_return_saved', {
        module: 'vatRegister', recordRef: id,
        firmKey: payload.firm_key, fiscalYear: payload.fiscal_year, period: payload.period,
      });
      showToast(`✅ ${escHtml(payload.period)} return figures saved.`, 'success');
      vrReturn = await vrFetchReturn(payload.firm_key, payload.fiscal_year, payload.period);
      vrRenderMasebari();
      showStatus('', 'info', errEl);
    } catch (e) {
      showStatus('❌ Could not save the return figures: ' + escHtml(friendlyDbError(e)), 'error', errEl);
    }
  });
}

// ════════════════════════════════════════════
//  4. VAT COLLECTED — vat_collections
// ════════════════════════════════════════════
//
// Two halves. "Outstanding" is DERIVED — every VAT memo with no collection
// row against it — so it can no more go stale than the sales register can.
// "Collected" is the stored rows.
// Looked up against the full unfiltered load (vrMemos), not vrSalesMemos()'s
// firm+F.Y.-scoped view — a collection row must always resolve its memo's
// serial regardless of which firm/year is currently selected on screen.
function vrMemoById(id) {
  return id == null ? null : (vrMemos || []).find(m => m.id === id) || null;
}

function vrCollectedMemoIds() {
  return new Set((vrCollections || []).map(c => c.service_memo_id).filter(v => v != null));
}

function vrOutstandingMemos() {
  const done = vrCollectedMemoIds();
  return vrSalesMemos().filter(m => !done.has(m.id));
}

function vrRenderCollections() {
  const outstanding = vrOutstandingMemos();
  const model = vrCollectionsModel();
  vrLastModel = model;
  vrSetExportEnabled(true);

  const oEl = document.getElementById('vr-out-output');
  if (oEl) {
    if (!outstanding.length) {
      oEl.innerHTML = `<div class="log-empty">Nothing outstanding — every VAT memo for ${escHtml(vrFirmName(vrFirmKey()))} in F.Y. ${escHtml(vrFy())} has been collected.</div>`;
      oEl.onclick = null;
    } else {
      const head = `<tr><th>VAT Serial No.</th><th>Date</th><th>Bill No.</th><th>Name of Client</th><th>PAN</th>
        <th style="text-align:right;">VAT Amount</th><th>Nature of Work</th><th></th></tr>`;
      const body = outstanding.map((m, i) => `<tr>
        <td>${escHtml(vrVatSerialLabel(m))}</td>
        <td>${escHtml(m.memo_date || '—')}</td>
        <td>${escHtml(m.memo_number || '—')}</td>
        <td>${escHtml(m.client_name || '—')}</td>
        <td>${escHtml(m.client_pan || '—')}</td>
        <td style="text-align:right; font-variant-numeric:tabular-nums;">${vrAmt(m.vat_amount)}</td>
        <td>${escHtml(typeof smNatureText === 'function' ? smNatureText(m) : (m.nature_category || '—'))}</td>
        <td><button class="btn btn-outline btn-sm" data-vr-collect="${i}">Record collection</button></td>
      </tr>`).join('');
      const total = outstanding.reduce((t, m) => t + vrNum(m.vat_amount), 0);
      oEl.innerHTML = `<table class="client-table"><thead>${head}</thead><tbody>${body}
        <tr style="font-weight:700; background:var(--bg-page-alt); color:var(--brand-navy);">
          <td colspan="5">Total outstanding (${outstanding.length})</td>
          <td style="text-align:right; font-variant-numeric:tabular-nums;">${vrAmt(total)}</td><td></td><td></td>
        </tr></tbody></table>`;
      oEl.onclick = (e) => {
        const b = e.target.closest('[data-vr-collect]');
        if (!b) return;
        vrOpenCollection(null, outstanding[parseInt(b.dataset.vrCollect, 10)]);
      };
    }
  }

  const cEl = document.getElementById('vr-coll-output');
  if (cEl) {
    if (!vrCollections.length) {
      cEl.innerHTML = '<div class="log-empty">No collections recorded yet for this firm and year.</div>';
      cEl.onclick = null;
    } else {
      const head = `<tr><th>VAT Serial No.</th><th>Date of Payment</th><th>Name of Client</th><th>PAN</th>
        <th style="text-align:right;">Amount</th><th>Voucher Name</th><th>Name of Bank</th><th>Nature of Work</th><th></th></tr>`;
      const body = vrCollections.map((c, i) => `<tr>
        <td>${escHtml(vrVatSerialLabel(vrMemoById(c.service_memo_id)))}</td>
        <td>${escHtml(c.payment_date || '—')}</td>
        <td>${escHtml(c.client_name || '—')}</td>
        <td>${escHtml(c.client_pan || '—')}</td>
        <td style="text-align:right; font-variant-numeric:tabular-nums;">${vrAmt(c.amount)}</td>
        <td>${escHtml(c.voucher_name || '—')}</td>
        <td>${escHtml(c.bank_name || '—')}</td>
        <td>${escHtml(c.nature_of_work || '—')}</td>
        <td><div class="client-actions">
          <button class="btn btn-outline btn-sm" data-vr-coll-edit="${i}">Edit</button>
          <button class="btn btn-outline btn-sm" data-vr-coll-del="${i}">Delete</button>
        </div></td>
      </tr>`).join('');
      const total = vrCollections.reduce((t, c) => t + vrNum(c.amount), 0);
      cEl.innerHTML = `<table class="client-table"><thead>${head}</thead><tbody>${body}
        <tr style="font-weight:700; background:var(--bg-page-alt); color:var(--brand-navy);">
          <td colspan="4">Total collected (${vrCollections.length})</td>
          <td style="text-align:right; font-variant-numeric:tabular-nums;">${vrAmt(total)}</td>
          <td></td><td></td><td></td><td></td>
        </tr></tbody></table>`;
      cEl.onclick = (e) => {
        const ed = e.target.closest('[data-vr-coll-edit]');
        const de = e.target.closest('[data-vr-coll-del]');
        if (ed) vrOpenCollection(vrCollections[parseInt(ed.dataset.vrCollEdit, 10)], null);
        else if (de) vrDeleteCollection(vrCollections[parseInt(de.dataset.vrCollDel, 10)]);
      };
    }
  }
}

function vrCollectionsModel() {
  const rows = vrCollections || [];
  const total = rows.reduce((t, c) => t + vrNum(c.amount), 0);
  return {
    title: 'VAT Collected from Clients',
    subtitleLines: [vrFirmName(vrFirmKey()), `F.Y. ${vrFy()}`,
      `${rows.length} collection${rows.length === 1 ? '' : 's'} · ${vrOutstandingMemos().length} outstanding`],
    landscape: true,
    columns: [
      { label: 'VAT Serial No.', align: 'l', w: 13 },
      { label: 'Date of Payment', align: 'l', w: 14 },
      { label: 'Name of Client', align: 'l', w: 26 },
      { label: 'PAN', align: 'l', w: 12 },
      { label: 'Amount', align: 'r', num: true, w: 14 },
      { label: 'Voucher Name', align: 'l', w: 16 },
      { label: 'Name of Bank', align: 'l', w: 18 },
      { label: 'Nature of Work', align: 'l', w: 22 },
    ],
    // Same lookup the on-screen Collected table uses — the export must match
    // what's on screen (the Service Memo idiom: one shared source, never a
    // second copy that can drift).
    rows: rows.map(c => ({ cells: [
      vrVatSerialLabel(vrMemoById(c.service_memo_id)),
      c.payment_date || '—', c.client_name || '—', c.client_pan || '—',
      vrNum(c.amount), c.voucher_name || '—', c.bank_name || '—', c.nature_of_work || '—',
    ] })).concat([{ style: 'grand', cells: ['Total', '', '', '', total, '', '', ''] }]),
  };
}

// `memo` is set when collecting against an outstanding memo (the client half
// is then read-only — it is the memo's, not something to retype);
// `existing` when editing a stored row.
function vrOpenCollection(existing, memo) {
  vrEditingCollectionId = existing ? existing.id : null;
  vrCollectingMemo = memo || null;

  document.getElementById('vr-c-drawer-title').textContent = existing ? 'Edit Collection' : 'Record VAT Collection';
  document.getElementById('vr-c-drawer-status').innerHTML = '';
  document.getElementById('vr-c-delete-btn').style.display = existing ? '' : 'none';

  const src = existing || {};
  document.getElementById('vr-c-client').value = existing ? (existing.client_name || '')
    : (memo ? (memo.client_name || '') : '');
  document.getElementById('vr-c-pan').value = existing ? (existing.client_pan || '')
    : (memo ? (memo.client_pan || '') : '');
  document.getElementById('vr-c-nature').value = existing ? (existing.nature_of_work || '')
    : (memo ? (typeof smNatureText === 'function' ? smNatureText(memo) : (memo.nature_category || '')) : '');
  document.getElementById('vr-c-amount').value = existing ? (vrNum(existing.amount) || '')
    : (memo ? (vrNum(memo.vat_amount) || '') : '');
  document.getElementById('vr-c-date').value = src.payment_date || NepaliLocale.todayISO();
  document.getElementById('vr-c-voucher').value = src.voucher_name || '';
  document.getElementById('vr-c-bank').value = src.bank_name || '';
  document.getElementById('vr-c-remarks').value = src.remarks || '';

  vrFillDatalist('vr-c-banks', vrBankNames());
  document.getElementById('vr-c-drawer').classList.add('open');
}
function vrCloseCollection() { document.getElementById('vr-c-drawer').classList.remove('open'); }

// Bank names the firm already uses — its own configured accounts (if Bank
// Entry has loaded them) plus every bank already typed here. NOT a closed
// list and not an FK: this page records the bank a voucher was deposited at,
// which need not be one of the firm's own accounts.
function vrBankNames() {
  const seen = new Map();
  const add = v => {
    const s = String(v || '').trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  };
  if (typeof bbAccounts !== 'undefined' && Array.isArray(bbAccounts)) bbAccounts.forEach(a => add(a.bank_name));
  (vrCollections || []).forEach(c => add(c.bank_name));
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

async function vrSaveCollection(btn) {
  const errEl = 'vr-c-drawer-status';
  const client = vrVal('vr-c-client');
  const payDate = vrVal('vr-c-date');
  if (!client) { showStatus('Enter the client name.', 'info', errEl); return; }
  if (!payDate) { showStatus('Enter the date of payment.', 'info', errEl); return; }

  const bs = vrBsOf(payDate);
  if (!bs) { showStatus('That payment date could not be converted to B.S. — check it.', 'info', errEl); return; }

  const existing = vrEditingCollectionId
    ? (vrCollections || []).find(c => c.id === vrEditingCollectionId) : null;
  const memo = vrCollectingMemo;

  const payload = {
    firm_key: vrFirmKey(),
    // Derived from the payment date, never typed — same rule as the purchase
    // register, so a collection is always filed in the year it was received.
    fiscal_year: vrFyLabel(vrFyStartOfBs(bs)),
    service_memo_id: existing ? (existing.service_memo_id || null) : (memo ? memo.id : null),
    client_id: existing ? (existing.client_id || null) : (memo ? (memo.client_id || null) : null),
    client_name: client,
    client_pan: vrVal('vr-c-pan') || null,
    nature_of_work: vrVal('vr-c-nature') || null,
    amount: vrNum(vrVal('vr-c-amount')),
    payment_date: payDate,
    voucher_name: vrVal('vr-c-voucher') || null,
    bank_name: vrVal('vr-c-bank') || null,
    remarks: vrVal('vr-c-remarks') || null,
    updated_by: vrUserEmail(),
  };
  if (!vrEditingCollectionId) payload.created_by = vrUserEmail();

  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      let id = vrEditingCollectionId;
      if (id) {
        const { error } = await window.sb.from('vat_collections').update(payload).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await window.sb.from('vat_collections').insert(payload).select('id').single();
        if (error) throw error;
        id = data.id;
      }
      AuditLog.record(vrEditingCollectionId ? 'vat_collection_updated' : 'vat_collection_created', {
        module: 'vatRegister', recordRef: id, clientName: client,
        firmKey: payload.firm_key, fiscalYear: payload.fiscal_year, amount: payload.amount,
      });
      vrCloseCollection();
      showToast(`✅ VAT collection from <strong>${escHtml(client)}</strong> saved.`, 'success');
      vrRefresh().catch(e => showToast('❌ Saved, but the list failed to refresh: ' + escHtml(friendlyDbError(e)), 'error'));
    } catch (e) {
      showStatus('❌ Could not save the collection: ' + escHtml(friendlyDbError(e)), 'error', errEl);
    }
  });
}

async function vrDeleteCollection(row) {
  if (!row) return;
  if (!confirm(`Delete the VAT collection of Rs. ${vrAmt(row.amount)} from ${row.client_name} dated ${row.payment_date}?\n\nThe memo will return to the outstanding list.`)) return;
  try {
    const { error } = await window.sb.from('vat_collections').delete().eq('id', row.id);
    if (error) throw error;
    AuditLog.record('vat_collection_deleted', {
      module: 'vatRegister', recordRef: row.id, clientName: row.client_name,
      firmKey: row.firm_key, fiscalYear: row.fiscal_year, amount: vrNum(row.amount),
    });
    vrCloseCollection();
    showToast('✅ VAT collection deleted.', 'success');
    await vrRefresh();
  } catch (e) {
    vrStatus('❌ Could not delete the collection: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// ════════════════════════════════════════════
//  OUTPUT — Print / PDF / Excel
// ════════════════════════════════════════════
// All three act on vrLastModel, which every render sets, so the export always
// matches whichever view is on screen (the Work Done / Service Memo idiom).
function vrSetExportEnabled(on) {
  ['vr-print-btn', 'vr-pdf-btn', 'vr-excel-btn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !on;
  });
}

function vrPrint() {
  if (!vrLastModel) return;
  const w = window.open('', '_blank');
  if (!w) { vrStatus('Allow pop-ups to print this register.', 'info'); return; }
  // The print window is standalone and does NOT load css/styles.css, so every
  // colour here is a literal — a var() would resolve to nothing and the
  // totals would print unstyled (the .rep-blank-fill lesson, CLAUDE.md §15).
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(vrLastModel.title)}</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 26px; color: #1a202c; }
      table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
      th, td { border: 1px solid #d9dce5; padding: 5px 8px; font-variant-numeric: tabular-nums; }
      th { background: #f3f5fb; color: #0b1f3d; }
      @page { size: ${vrLastModel.landscape ? 'A4 landscape' : 'A4'}; margin: 12mm; }
    </style></head><body>${ReportExport.toHtml(vrLastModel)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('vat_register_printed', {
    module: 'vatRegister', firmKey: vrFirmKey(), fiscalYear: vrFy(), view: vrView,
  });
}

async function vrExport(kind) {
  if (!vrLastModel) return;
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    const name = `${vrViewDef().title} - ${vrFirmName(vrFirmKey())} - ${vrFy()}.${ext}`;
    await ReportExport.download(vrLastModel, kind, name, {
      module: 'vatRegister', sheetName: vrViewDef().label,
    });
  } catch (e) {
    vrStatus('❌ Failed to export: ' + escHtml(friendlyDbError(e)), 'error');
  }
}
