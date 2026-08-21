// ════════════════════════════════════════════
//  SERVICE MEMO
//  Internal service record + fee tracking — the firm's guarantee that no
//  professional work is completed without a recorded fee to collect. This is
//  deliberately NOT an accounting/tax invoice. Billing was the module that
//  issued those — bank details, a payment QR, a reconciled payments table —
//  and it was removed 2026-08-18 as unused, leaving this the firm's only
//  fee record. A memo is one lightweight row: who did what work for which
//  client, and the fee. No line-item or payments subtable, deliberately.
//
//  A memo records the work and the fee, NOT the collection. Money actually
//  received is entered once, as a Bank Entry "Fee Receipt", and the two sides
//  are netted per client by the Party Ledger (js/partyLedger.js). The memo used
//  to carry its own amount_received/payment_date/payment_status; those were
//  removed with the 2026-07-26 migration so there is exactly one place a
//  payment can be recorded and the two can never disagree.
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Financial Management" menu, not a sidebar button.
ModuleRegistry.register({ id: 'serviceMemo', group: 'main', buttonId: null, panelId: 'tab-serviceMemo-panel' });

const SM_FILTERS_EMPTY = { firm: '', category: '', fy: '', from: '', to: '' };

let smMemos = [];
let smTable = null;
let smSelectedClient = null;
let smEditingId = null;
let smEditingRow = null;
let smInitDone = false;
let smFilters = { ...SM_FILTERS_EMPTY };

// ── Fiscal-year defaults ──
// Fixed at the firm's current working year (mirrors Audit Report
// Finalization's own ARF_FY_DEFAULT) rather than derived from today's B.S.
// date — a memo written in Shrawan is routinely for the year just closed,
// not the one that just started. Statutory Audit is always for a completed
// year, so its own suggestion list never offers a year beyond this default.
// Reads window.FY_DEFAULT_START (config.js) — see that constant's comment.
// smFyLabel is a function declaration below, so it's hoisted and safe here.
const SM_FY_DEFAULT = smFyLabel(window.FY_DEFAULT_START);
const SM_FY_START = 2077;
const SM_FY_END = 2085;
const SM_FY_AUDIT_CAP = 2082;

function smFyLabel(startYear) { return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0'); }
function smFyOptions(capped) {
  const end = capped ? SM_FY_AUDIT_CAP : SM_FY_END;
  const opts = [];
  for (let y = end; y >= SM_FY_START; y--) opts.push(smFyLabel(y));
  return opts;
}
// The field stays free-typeable (a memo can still span years, e.g.
// "2080-81/2081-82") — the datalist only adds suggestions, never forces a
// closed list.
function smPopulateFyDatalist(capped) {
  const dl = document.getElementById('sm-fy-datalist');
  if (dl) dl.innerHTML = smFyOptions(capped).map(fy => `<option value="${fy}"></option>`).join('');
}

function smUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function smMoney(n) { return 'Rs. ' + fmtAmount(n); }
function smNum(n) { return fmtAmount(n); }
function smNatureText(m) {
  const sub = (m.nature_subcategory === 'Others' || m.nature_category === 'Others') && m.nature_other
    ? m.nature_other
    : m.nature_subcategory;
  return sub ? `${m.nature_category} — ${sub}` : (m.nature_category || '—');
}
// Display name of the memo's firm — the typed one for the "other--Specify"
// option, otherwise the configured name.
function smFirmName(m) {
  const f = window.SERVICE_MEMO_FIRMS[m.firm_key];
  if (f && f.typed) return m.firm_other || f.name;
  return (f && f.name) || m.firm_key || '—';
}
function smStatusMsg(html, type) { showStatus(html, type, 'sm-status-area'); }

// ── Load & refresh ──
async function loadServiceMemo() {
  if (!smInitDone) {
    SearchEngine.attachAutocomplete(document.getElementById('sm-client-search'), document.getElementById('sm-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: smSelectClient,
    });
    smPopulateFilterOptions();
    smInitDone = true;
  }
  await smRefresh();
}

// Write paths call smReload(); smRefresh() only reads, so opening the tab
// doesn't throw away a cache it could have used. Party Ledger and Final Account
// read service_memos too — under a different key, since this query joins
// clients and orders by created_at — so a memo write has to drop theirs as
// well, or a new memo wouldn't appear on the ledger.
async function smReload() {
  DataCache.invalidate(window.LEDGER_KEYS.memosSm, window.LEDGER_KEYS.memosPl);
  await smRefresh();
}

async function smRefresh() {
  smStatusMsg('<span class="spinner spinner-navy"></span> Loading service memos…', 'searching');
  try {
    smMemos = await DataCache.get(window.LEDGER_KEYS.memosSm, () => sbFetchAll(() => window.sb.from('service_memos')
      .select('*, clients(name, email, pan, address)').order('created_at', { ascending: false })));
    await Promise.all([smLoadArfVerified(), smLoadProjections(), smLoadFeeSkips()]);
    smRenderRecent();
    smRenderTable();
    smRenderPending();
    document.getElementById('sm-status-area').innerHTML = '';
  } catch (e) {
    smStatusMsg('❌ Failed to load service memos: ' + escHtml(e.message || String(e)), 'error');
  }
}

function smRenderRecent() {
  const el = document.getElementById('sm-recent-list');
  if (!el) return;
  const rows = smMemos.slice(0, 8);
  if (!rows.length) { el.innerHTML = '<div class="log-empty">No memos yet.</div>'; return; }
  el.innerHTML = rows.map(m => `
    <div class="log-item">
      <div class="log-details">
        <div class="log-client">${escHtml(m.memo_number || '—')} — ${escHtml(m.client_name || '—')}</div>
        <div class="log-sub">${escHtml(smNatureText(m))}</div>
      </div>
      <div class="log-time">${smMoney(m.total_amount)}</div>
    </div>`).join('');
}

// ── List table ──
function smRenderTable() {
  const wrap = document.getElementById('sm-table-wrap');
  if (smTable) { smTable.destroy(); smTable = null; }
  if (!smMemos.length) {
    wrap.innerHTML = '<div class="log-empty">No service memos yet. Click <strong>New Service Memo</strong> to record work performed and the fee to collect.</div>';
    return;
  }
  wrap.innerHTML = '';
  smTable = TableEngine.createTable(wrap, {
    data: smMemos,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    columns: [
      { title: 'Memo #', field: 'memo_number', width: 130, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Date', field: 'memo_date', width: 110 },
      { title: 'Client', field: 'client_name', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Firm', field: 'firm_key', width: 110, formatter: c => escHtml(smFirmName(c.getRow().getData())) },
      { title: 'Nature', field: 'nature_category', minWidth: 180, formatter: c => escHtml(smNatureText(c.getRow().getData())) },
      { title: 'F.Y.', field: 'fiscal_year', width: 90, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Fee', field: 'professional_fee', width: 110, hozAlign: 'right', formatter: c => smNum(c.getValue()) },
      { title: 'Total', field: 'total_amount', width: 110, hozAlign: 'right', formatter: c => smNum(c.getValue()) },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 210, formatter: () => smRowActions(),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') smOpenCreate(row);
          else if (btn.dataset.action === 'pdf') smDownloadPdf(row);
          else if (btn.dataset.action === 'delete') smDeleteMemo(row);
        } },
    ],
  });
}

function smRowActions() {
  const btn = (a, label, title) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${title || label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('pdf', 'PDF', 'Download Service Memo PDF')}${btn('delete', 'Delete')}</div>`;
}

// ── Pending Audit Fees — derived from Audit Report Finalization, never
// stored twice ──
// The firm's real workflow: the moment a client's IT Return or Tax Clearance
// track is verified for a fiscal year, that year's statutory audit fee is due
// to be memoed — regardless of which of the two got there first. Estimate
// Return is deliberately NOT a trigger and never appears here, verified or
// not (user decision 2026-08-21) — it is interim work inside the same
// engagement, not separately billable. This reads audit_report_finalization
// directly, the same idiom Work Done uses for its own Pending List over
// document_register, rather than caching a second copy of the same fact.
// Once a Statutory Audit memo exists for that client+FY, the row drops off
// on its own — nothing here is ever marked "done" by hand.
let smArfRows = [];
let smPendingTable = null;
let smView = 'memos';

const SM_ARF_TRACK_LABELS = { it_return: 'IT Return', estimate_return: 'Estimate Return', tax_clearance: 'Tax Clearance' };
const SM_ARF_TRACK_BADGES = { it_return: 'badge-blue', estimate_return: 'badge-purple', tax_clearance: 'badge-yellow' };

function smArfTrackVerified(row) {
  if (row.return_type === 'tax_clearance') return row.tax_clearance === true;
  if (row.return_type === 'estimate_return') return row.estimate_verified === true;
  return row.it_verified === true;
}

async function smLoadArfVerified() {
  try {
    smArfRows = await sbFetchAll(() => window.sb.from('audit_report_finalization')
      .select('client_id, client_name, client_pan, fiscal_year, return_type, it_verified, estimate_verified, tax_clearance, auditor')
      .order('fiscal_year', { ascending: false }));
  } catch (e) {
    smArfRows = [];
  }
}

// A dismissed (client, fiscal year, kind) reminder — see db/2026-08-15_service_memo_fee_skips.sql
// for why this exists (the Pending Memos list is derived, so "Delete" has
// nothing to delete without this table).
let smFeeSkips = [];

async function smLoadFeeSkips() {
  try {
    smFeeSkips = await sbFetchAll(() => window.sb.from('service_memo_fee_skips')
      .select('client_id, client_name, fy_start_year, kind'));
  } catch (e) {
    smFeeSkips = [];
  }
}

// Saved Projection Reports are the second source for the Audit Fees list
// (2026-08-15) — a saved report is by itself "billable work done", the same
// idea as a verified ARF track. Updating an existing report (Projection's own
// Updation mode) writes to the SAME projection_reports row, so deriving this
// list straight from the table — rather than storing anything about save
// events — is what keeps a re-run from ever appearing twice.
let smProjectionRows = [];

async function smLoadProjections() {
  try {
    smProjectionRows = await sbFetchAll(() => window.sb.from('projection_reports')
      .select('id, client_id, company_name, pan, fiscal_year_base, years, performed_by')
      .order('fiscal_year_base', { ascending: false }));
  } catch (e) {
    smProjectionRows = [];
  }
}

// ARF's slash short-year format ('2082/83') -> Service Memo's own dash
// format ('2082-83'). Same digits, different separator only.
function smFyFromArf(slash) { return String(slash || '').replace('/', '-'); }

// PROJECTION_MEMO_CAT/SUB — which SERVICE_MEMO_TASKS slot a projection-report
// fee lands in. User decision 2026-08-15: Bank Loan Related / Provisional/
// Projected already exists in the picklist and matches what this work is for.
const PROJECTION_MEMO_CAT = 'Bank Loan Related';
const PROJECTION_MEMO_SUB = 'Provisional/Projected';

function smHasAuditMemo(clientId, fyStart) {
  return smMemos.some(m => m.nature_category === 'Audit' && m.nature_subcategory === 'Statutory Audit' &&
    m.client_id === clientId && NepaliLocale.fyStartYear(m.fiscal_year) === fyStart);
}

function smHasProjectionMemo(clientId, clientNameLower, fyStart) {
  return smMemos.some(m => {
    if (m.nature_category !== PROJECTION_MEMO_CAT || m.nature_subcategory !== PROJECTION_MEMO_SUB) return false;
    if (NepaliLocale.fyStartYear(m.fiscal_year) !== fyStart) return false;
    return clientId != null ? m.client_id === clientId : String(m.client_name || '').trim().toLowerCase() === clientNameLower;
  });
}

// A dismissed reminder (§ smFeeSkips above) never comes back on its own —
// it's excluded the same way "already has a memo" is, right next to it, so
// there's exactly one place a group can be dropped from the list.
function smIsFeeSkipped(g, fyStart) {
  const nameLower = String(g.clientName || '').trim().toLowerCase();
  return smFeeSkips.some(s => s.kind === g.kind && s.fy_start_year === fyStart &&
    (g.clientId != null ? s.client_id === g.clientId : String(s.client_name || '').trim().toLowerCase() === nameLower));
}

// Both fee sources — verified ARF tracks and saved Projection Reports — feed
// one list, tagged by `kind` so the table and the prefill can tell them apart.
function smFeeDueRows() {
  const groups = new Map();
  smArfRows.forEach(r => {
    // Estimate Return never reaches this list — neither as a trigger nor as
    // a Detail badge, whatever its verification status (see the header
    // comment above).
    if (r.return_type === 'estimate_return') return;
    // ARF's client_id is NOT NULL (directory clients only), but guard anyway
    // — a row this module can't attribute to a client can't be memoed either.
    if (r.client_id == null || !smArfTrackVerified(r)) return;
    const key = 'audit::' + r.client_id + '::' + r.fiscal_year;
    let g = groups.get(key);
    if (!g) {
      g = { kind: 'audit', clientId: r.client_id, clientName: r.client_name, clientPan: r.client_pan,
        fiscalYear: r.fiscal_year, tracks: [], auditor: r.auditor || '' };
      groups.set(key, g);
    }
    if (!g.tracks.includes(r.return_type)) g.tracks.push(r.return_type);
    if (!g.auditor && r.auditor) g.auditor = r.auditor;
  });

  smProjectionRows.forEach(r => {
    const fy = r.fiscal_year_base;
    if (!fy) return;
    // A typed-only projection (no directory client) is grouped by its trimmed,
    // lower-cased company name instead — the same fallback smOpenCreateFromPending
    // already uses for the ARF side's missing-from-directory case.
    const nameLower = String(r.company_name || '').trim().toLowerCase();
    const key = 'projection::' + (r.client_id != null ? r.client_id : 'name:' + nameLower) + '::' + fy;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'projection', clientId: r.client_id, clientName: r.company_name, clientPan: r.pan || '',
        fiscalYear: fy, years: r.years, performedBy: r.performed_by || '',
      });
    }
  });

  return Array.from(groups.values())
    .filter(g => {
      const fyStart = NepaliLocale.fyStartYear(g.fiscalYear);
      if (smIsFeeSkipped(g, fyStart)) return false;
      if (g.kind === 'audit') return !smHasAuditMemo(g.clientId, fyStart);
      return !smHasProjectionMemo(g.clientId, String(g.clientName || '').trim().toLowerCase(), fyStart);
    })
    .sort((a, b) => (NepaliLocale.fyStartYear(b.fiscalYear) || 0) - (NepaliLocale.fyStartYear(a.fiscalYear) || 0)
      || String(a.clientName || '').localeCompare(String(b.clientName || '')));
}

function smUpdatePendingBadge(count) {
  const el = document.getElementById('sm-pending-count');
  if (el) el.textContent = count ? ` (${count})` : '';
}

function smSetView(view) {
  smView = view;
  document.getElementById('sm-view-memos').classList.toggle('active', view === 'memos');
  document.getElementById('sm-view-pending').classList.toggle('active', view === 'pending');
  document.getElementById('sm-memos-view').style.display = view === 'memos' ? '' : 'none';
  document.getElementById('sm-pending-view').style.display = view === 'pending' ? '' : 'none';
  // Tabulator lays out to zero width while its container is display:none —
  // the newly-shown table needs a redraw once it actually has a box to measure.
  if (view === 'pending' && smPendingTable) setTimeout(() => smPendingTable.redraw(true), 0);
}

const SM_KIND_LABELS = { audit: 'Statutory Audit', projection: 'Projection Report' };

function smRenderPending() {
  const rows = smFeeDueRows();
  smUpdatePendingBadge(rows.length);

  const wrap = document.getElementById('sm-pending-wrap');
  if (!wrap) return;
  if (smPendingTable) { smPendingTable.destroy(); smPendingTable = null; }
  if (!rows.length) {
    wrap.innerHTML = '<div class="log-empty">Nothing pending — every client with a verified IT Return, Tax Clearance or a saved Projection Report already has a matching fee memo.</div>';
    return;
  }
  wrap.innerHTML = '';
  smPendingTable = TableEngine.createTable(wrap, {
    data: rows,
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    columns: [
      { title: 'Client', field: 'clientName', minWidth: 180, formatter: c => {
          const r = c.getRow().getData();
          return `${escHtml(r.clientName || '—')}<div class="log-sub">PAN ${escHtml(r.clientPan || '—')}</div>`;
        } },
      { title: 'F.Y.', field: 'fiscalYear', width: 90, formatter: c => escHtml(smFyFromArf(c.getValue())) },
      { title: 'Work', field: 'kind', width: 130, formatter: c => escHtml(SM_KIND_LABELS[c.getValue()] || c.getValue()) },
      { title: 'Detail', field: 'tracks', minWidth: 260, headerSort: false, formatter: c => {
          const r = c.getRow().getData();
          if (r.kind === 'audit') {
            return (r.tracks || []).map(t => `<span class="log-badge ${SM_ARF_TRACK_BADGES[t] || 'badge-neutral'}">${escHtml(SM_ARF_TRACK_LABELS[t] || t)}</span>`).join(' ');
          }
          const fy = smFyFromArf(r.fiscalYear);
          return escHtml(`${r.years || '?'}-year Projected Financial Statements, based on F.Y. ${fy}`);
        } },
      { title: 'Done By', field: 'auditor', width: 160, formatter: c => {
          const r = c.getRow().getData();
          return escHtml((r.kind === 'audit' ? r.auditor : r.performedBy) || '—');
        } },
      { title: '', field: 'clientId', headerSort: false, width: 180,
        formatter: () => '<div class="client-actions">'
          + '<button class="btn btn-outline btn-sm" data-action="add-fee">Add Fee</button>'
          + '<button class="btn btn-outline btn-sm" data-action="dismiss" title="Remove this reminder — it will not come back on its own">Delete</button>'
          + '</div>',
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'add-fee') smOpenCreateFromPending(row);
          else if (btn.dataset.action === 'dismiss') smDismissFeeDue(row);
        } },
    ],
  });
}

// Deletes the REMINDER, not a record — there is no service_memos row for a
// pending item yet. Recorded in service_memo_fee_skips (db/2026-08-15_…sql)
// so it stays gone across refreshes and for every staff member, not just
// this browser tab.
async function smDismissFeeDue(row) {
  const label = SM_KIND_LABELS[row.kind] || row.kind;
  if (!confirm(`Remove this ${label} reminder for ${row.clientName || 'this client'} (F.Y. ${smFyFromArf(row.fiscalYear)})? It will not reappear unless the underlying record changes.`)) return;
  const fyStart = NepaliLocale.fyStartYear(row.fiscalYear);
  const { error } = await window.sb.from('service_memo_fee_skips').insert({
    client_id: row.clientId,
    client_name: row.clientName,
    fy_start_year: fyStart,
    kind: row.kind,
    dismissed_by: smUserEmail(),
  });
  if (error) { smStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('service_memo_fee_skip_created', {
    module: 'serviceMemo', clientName: row.clientName,
    detail: { kind: row.kind, fiscalYear: row.fiscalYear },
  });
  await smLoadFeeSkips();
  smRenderPending();
}

// One click from "billable work done, no fee memo yet" to a prefilled memo —
// client, Nature of Task, fiscal year and a description are already set; the
// user only has to type the Professional Fee. Handles both fee sources.
function smOpenCreateFromPending(p) {
  const client = (window.clientsList || []).find(c => c.id === p.clientId)
    || { id: p.clientId, name: p.clientName, pan: p.clientPan };
  const fy = smFyFromArf(p.fiscalYear);
  if (p.kind === 'projection') {
    smOpenCreate(null, {
      client, category: PROJECTION_MEMO_CAT, subcategory: PROJECTION_MEMO_SUB, fiscalYear: fy,
      description: `Preparation of Projected Financial Statements${p.years ? ` for ${p.years} years` : ''}, based on F.Y. ${fy}.`,
    });
    return;
  }
  smOpenCreate(null, {
    client, category: 'Audit', subcategory: 'Statutory Audit', fiscalYear: fy,
    description: `Statutory Audit of the Financial Statements for F.Y. ${fy}.`,
  });
}

// ── Filters ──
function smPopulateFilterOptions() {
  const firmSel = document.getElementById('sm-filter-firm');
  firmSel.innerHTML = '<option value="">All firms</option>' +
    Object.values(window.SERVICE_MEMO_FIRMS).map(f => `<option value="${escHtml(f.key)}">${escHtml(f.name)}</option>`).join('');
  const catSel = document.getElementById('sm-filter-category');
  catSel.innerHTML = '<option value="">All categories</option>' +
    window.SERVICE_MEMO_TASKS.map(t => `<option value="${escHtml(t.category)}">${escHtml(t.category)}</option>`).join('');
}

function smReadFilters() {
  smFilters = {
    firm: document.getElementById('sm-filter-firm').value,
    category: document.getElementById('sm-filter-category').value,
    fy: document.getElementById('sm-filter-fy').value.trim(),
    from: document.getElementById('sm-filter-from').value,
    to: document.getElementById('sm-filter-to').value,
  };
}

// Shared by the table AND the exports, so what's on screen and what leaves
// the app can never disagree (the ARF / Work Done idiom).
function smCurrentFilteredRows() {
  let rows = smMemos.filter(m => {
    if (smFilters.firm && m.firm_key !== smFilters.firm) return false;
    if (smFilters.category && m.nature_category !== smFilters.category) return false;
    if (smFilters.fy && (m.fiscal_year || '') !== smFilters.fy) return false;
    if (smFilters.from && (m.memo_date || '') < smFilters.from) return false;
    if (smFilters.to && (m.memo_date || '') > smFilters.to) return false;
    return true;
  });
  const q = (document.getElementById('sm-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['memo_number', 'client_name', 'client_pan', 'nature_category', 'nature_subcategory', 'nature_other', 'description']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function smApplyFilters() {
  if (!smTable) return;
  smTable.replaceData(smCurrentFilteredRows());
}
function smOnFilterChange() { smReadFilters(); smApplyFilters(); }
function smClearFilters() {
  ['sm-filter-firm', 'sm-filter-category', 'sm-filter-fy', 'sm-filter-from', 'sm-filter-to', 'sm-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  smFilters = { ...SM_FILTERS_EMPTY };
  smApplyFilters();
}

// ── Print / Preview / Export — acts on whichever view is showing (Memos or
// Pending Memos), the ARF / Work Done idiom, so what prints or exports
// always matches what's on screen. ──
function smBuildMemosModel(rows) {
  const subtitles = [`Generated ${NepaliLocale.todayISO()}`];
  if (smFilters.from || smFilters.to) subtitles.push(`${smFilters.from || 'the beginning'} to ${smFilters.to || 'today'}`);
  return {
    title: 'Service Memos',
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'Memo #', w: 1 }, { label: 'Date', w: 0.9 }, { label: 'Client', w: 1.8 },
      { label: 'Firm', w: 1.1 }, { label: 'Nature', w: 1.6 }, { label: 'F.Y.', w: 0.7 },
      { label: 'Fee', align: 'r', num: true, w: 0.9 }, { label: 'Total', align: 'r', num: true, w: 0.9 },
    ],
    rows: rows.map(m => ({ cells: [
      m.memo_number, m.memo_date, m.client_name, smFirmName(m), smNatureText(m), m.fiscal_year,
      Number(m.professional_fee) || 0, Number(m.total_amount) || 0,
    ] })),
    _filename: 'Service Memos',
  };
}

function smBuildPendingModel(rows) {
  return {
    title: 'Service Memo — Pending Memos',
    subtitleLines: [`Generated ${NepaliLocale.todayISO()}`,
      'Verified Audit Report Finalization tracks and saved Projection Reports without a matching fee memo yet.'],
    landscape: true,
    columns: [
      { label: 'Client', w: 1.8 }, { label: 'PAN', w: 1.0 }, { label: 'F.Y.', w: 0.7 },
      { label: 'Work', w: 1.1 }, { label: 'Detail', w: 2.2 }, { label: 'Done By', w: 1.2 },
    ],
    rows: rows.map(r => ({ cells: [
      r.clientName, r.clientPan, smFyFromArf(r.fiscalYear), SM_KIND_LABELS[r.kind] || r.kind,
      r.kind === 'audit'
        ? (r.tracks || []).map(t => SM_ARF_TRACK_LABELS[t] || t).join(', ')
        : `${r.years || '?'}-year Projected Financial Statements, based on F.Y. ${smFyFromArf(r.fiscalYear)}`,
      (r.kind === 'audit' ? r.auditor : r.performedBy) || '—',
    ] })),
    _filename: 'Service Memo - Pending Memos',
  };
}

function smActiveModel() {
  if (smView === 'pending') {
    const rows = smFeeDueRows();
    return rows.length ? smBuildPendingModel(rows) : null;
  }
  const rows = smCurrentFilteredRows();
  return rows.length ? smBuildMemosModel(rows) : null;
}

async function smExport(kind) {
  const model = smActiveModel();
  if (!model) { smStatusMsg('Nothing to export for the current view.', 'info'); return; }
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'serviceMemo',
      clientName: smView === 'pending' ? 'Pending Memos' : 'Filtered Memos',
      sheetName: smView === 'pending' ? 'Pending Memos' : 'Service Memos',
    });
  } catch (e) {
    smStatusMsg('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}

// Opens a plain print window over the same model the Excel/PDF export uses
// (ReportExport.toHtml), so Preview and an exported file can never disagree.
function smOpenPrintWindow(model) {
  const w = window.open('', '_blank');
  if (!w) { smStatusMsg('Allow pop-ups to print.', 'info'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(model.title)}</title>
    <style>body{font-family:Inter,Arial,sans-serif;margin:28px;color:#1a202c;}
    table{border-collapse:collapse;width:100%;font-size:11px;}
    th,td{border:1px solid #d9dce5;padding:5px 8px;}
    th{background:#f3f5fb;color:#0b1f3d;}
    @page{size:A4 landscape;margin:12mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('service_memo_printed', { module: 'serviceMemo' });
}

function smPreviewAll() {
  const model = smActiveModel();
  if (!model) { smStatusMsg('Nothing to preview for the current view.', 'info'); return; }
  smOpenPrintWindow(model);
}

// ── Create / Edit drawer ──
function smSelectClient(c) {
  smSelectedClient = c;
  document.getElementById('sm-client-search').value = c.name;
  document.getElementById('sm-client-pan').value = c.pan || '';
  document.getElementById('sm-client-address').value = c.address || '';
}

function smPopulateCategorySelect() {
  const cat = document.getElementById('sm-nature-category');
  cat.innerHTML = '<option value="">Select category…</option>' +
    window.SERVICE_MEMO_TASKS.map(t => `<option value="${escHtml(t.category)}">${escHtml(t.category)}</option>`).join('');
}
function smOnCategoryChange() {
  const catVal = document.getElementById('sm-nature-category').value;
  const sub = document.getElementById('sm-nature-subcategory');
  const found = window.SERVICE_MEMO_TASKS.find(t => t.category === catVal);
  const subs = found ? found.subs : [];
  sub.innerHTML = '<option value="">Select sub-category…</option>' +
    subs.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  smOnSubcategoryChange();
}
function smOnSubcategoryChange() {
  const cat = document.getElementById('sm-nature-category').value;
  const sub = document.getElementById('sm-nature-subcategory').value;
  const showOther = cat === 'Others' || sub === 'Others';
  document.getElementById('sm-nature-other-group').style.display = showOther ? '' : 'none';

  // Statutory Audit is always for a completed fiscal year — cap the
  // suggestion list at the firm's current default, and fill the field only
  // when it's still blank, so a value the user already typed (or one
  // prefilled from the Pending Audit Fees list) is never clobbered.
  const isStatutoryAudit = cat === 'Audit' && sub === 'Statutory Audit';
  smPopulateFyDatalist(isStatutoryAudit);
  if (isStatutoryAudit) {
    const fyEl = document.getElementById('sm-fiscal-year');
    if (fyEl && !fyEl.value.trim()) fyEl.value = SM_FY_DEFAULT;
  }
}

function smComputeTotals() {
  const fee = parseFloat(document.getElementById('sm-fee').value) || 0;
  const applyVat = document.getElementById('sm-apply-vat').checked;
  const vat = applyVat ? fee * window.VAT_STANDARD_RATE : 0;
  return { fee, vat, total: fee + vat };
}
function smRenderTotals() {
  const t = smComputeTotals();
  document.getElementById('sm-total-vat').textContent = smNum(t.vat);
  document.getElementById('sm-total-amount').textContent = smNum(t.total);
}

// The "other--Specify" firm types its name per memo; every other firm is
// configured. Mirrors the nature-of-task "Others" show/hide.
function smOnFirmChange() {
  const f = window.SERVICE_MEMO_FIRMS[document.getElementById('sm-firm-key').value];
  document.getElementById('sm-firm-other-group').style.display = (f && f.typed) ? '' : 'none';
}

// `prefill` seeds a brand-new memo from another module's record — currently
// only the Pending Audit Fees list: { client, category, subcategory,
// fiscalYear }. Ignored whenever `existing` is set; an edit always wins.
function smOpenCreate(existing, prefill) {
  smEditingId = existing ? existing.id : null;
  smEditingRow = existing || null;
  smSelectedClient = null;
  document.getElementById('sm-delete-btn').style.display = existing ? '' : 'none';
  document.getElementById('sm-drawer-title').textContent = existing
    ? `Edit ${existing.memo_number || 'Service Memo'}`
    : (prefill ? `New Service Memo — ${prefill.subcategory}` : 'New Service Memo');
  document.getElementById('sm-drawer-status').innerHTML = '';

  smPopulateCategorySelect();
  smPopulateFyDatalist(false);

  document.getElementById('sm-firm-key').value = existing ? existing.firm_key : 'shailesh';
  document.getElementById('sm-firm-other').value = existing ? (existing.firm_other || '') : '';
  smOnFirmChange();
  document.getElementById('sm-memo-date').value = existing ? existing.memo_date : NepaliLocale.todayISO();
  document.getElementById('sm-client-search').value = existing ? (existing.client_name || '') : (prefill ? (prefill.client.name || '') : '');
  document.getElementById('sm-client-pan').value = existing ? (existing.client_pan || '') : (prefill ? (prefill.client.pan || '') : '');
  document.getElementById('sm-client-address').value = existing ? (existing.client_address || '') : (prefill ? (prefill.client.address || '') : '');
  document.getElementById('sm-nature-category').value = existing ? (existing.nature_category || '') : (prefill ? prefill.category : '');
  smOnCategoryChange();
  document.getElementById('sm-nature-subcategory').value = existing ? (existing.nature_subcategory || '') : (prefill ? prefill.subcategory : '');
  smOnSubcategoryChange();
  document.getElementById('sm-nature-other').value = existing ? (existing.nature_other || '') : '';
  document.getElementById('sm-description').value = existing ? (existing.description || '') : (prefill ? (prefill.description || '') : '');
  document.getElementById('sm-fee').value = existing ? existing.professional_fee : '';
  document.getElementById('sm-apply-vat').checked = existing ? !!existing.apply_vat : false;
  document.getElementById('sm-remarks').value = existing ? (existing.remarks || '') : '';

  document.getElementById('sm-fiscal-year').value = existing ? (existing.fiscal_year || '') : (prefill ? prefill.fiscalYear : SM_FY_DEFAULT);

  if (existing && existing.client_id) {
    const c = (window.clientsList || []).find(x => x.id === existing.client_id);
    if (c) smSelectedClient = c;
  } else if (prefill && prefill.client && prefill.client.id) {
    smSelectedClient = prefill.client;
  }

  smRenderTotals();
  document.getElementById('sm-memo-drawer').classList.add('open');
}
function smCloseCreate() { document.getElementById('sm-memo-drawer').classList.remove('open'); }

async function smDeleteFromDrawer() {
  if (!smEditingRow) return;
  await smDeleteMemo(smEditingRow);
  // smDeleteMemo no-ops (keeps the drawer open) if the user cancels the
  // confirm() prompt — only close once the row is actually gone.
  const stillExists = smMemos.some(m => m.id === smEditingRow.id);
  if (!stillExists) smCloseCreate();
}

function smDrawerErr(msg) { showStatus(escHtml(msg), 'info', 'sm-drawer-status'); }

async function smSaveMemo() {
  const clientName = document.getElementById('sm-client-search').value.trim();
  if (!clientName) { smDrawerErr('Enter or select a client.'); return; }
  const firmKey = document.getElementById('sm-firm-key').value;
  const firm = window.SERVICE_MEMO_FIRMS[firmKey];
  if (!firm) { smDrawerErr('Select a firm.'); return; }
  const firmOther = document.getElementById('sm-firm-other').value.trim();
  if (firm.typed && !firmOther) { smDrawerErr('Enter the firm name.'); return; }
  const category = document.getElementById('sm-nature-category').value;
  if (!category) { smDrawerErr('Select the nature of task.'); return; }

  const t = smComputeTotals();
  // Keep client_id only while the name still matches the picked client — a
  // hand-edited name becomes a typed-only (nullable) client.
  const clientId = (smSelectedClient && smSelectedClient.name === clientName) ? smSelectedClient.id : null;

  // Duplicate guard (2026-08-21, user ask): a NEW memo for the same client +
  // fiscal year + same nature of task almost always means the fee is being
  // recorded twice. A confirm rather than a hard block, because a second memo
  // for the same nature can be genuine (e.g. two phases of the same work) —
  // but it must never happen silently. Edits of an existing memo are exempt.
  if (!smEditingId) {
    const fyRaw = document.getElementById('sm-fiscal-year').value.trim();
    const fyStart = NepaliLocale.fyStartYear(fyRaw);
    const subcat = document.getElementById('sm-nature-subcategory').value || null;
    const nameLower = clientName.toLowerCase();
    const dup = fyStart != null && smMemos.find(m => {
      if (m.nature_category !== category || (m.nature_subcategory || null) !== subcat) return false;
      if (NepaliLocale.fyStartYear(m.fiscal_year) !== fyStart) return false;
      return clientId != null ? m.client_id === clientId
        : String(m.client_name || '').trim().toLowerCase() === nameLower;
    });
    if (dup) {
      const natureLabel = subcat ? `${category} / ${subcat}` : category;
      const ok = confirm(`⚠ ${clientName} already has memo ${dup.memo_number || '(unnumbered)'} for F.Y. ${fyRaw} — ${natureLabel}, Rs ${dup.total_amount || dup.professional_fee || 0}.\n\nSaving this would record the same work twice. Create a second memo anyway?`);
      if (!ok) { smDrawerErr(`Not saved — edit memo ${dup.memo_number || ''} from the Memos list instead.`); return; }
    }
  }

  const payload = {
    memo_prefix: firm.prefix,
    firm_key: firmKey,
    firm_other: firm.typed ? firmOther : null,
    memo_date: document.getElementById('sm-memo-date').value || NepaliLocale.todayISO(),
    client_id: clientId,
    client_name: clientName,
    client_pan: document.getElementById('sm-client-pan').value.trim() || null,
    client_address: document.getElementById('sm-client-address').value.trim() || null,
    nature_category: category,
    nature_subcategory: document.getElementById('sm-nature-subcategory').value || null,
    nature_other: document.getElementById('sm-nature-other').value.trim() || null,
    description: document.getElementById('sm-description').value.trim() || null,
    fiscal_year: document.getElementById('sm-fiscal-year').value.trim() || null,
    professional_fee: t.fee,
    apply_vat: document.getElementById('sm-apply-vat').checked,
    vat_amount: t.vat,
    total_amount: t.total,
    remarks: document.getElementById('sm-remarks').value.trim() || null,
    updated_by: smUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'sm-drawer-status');
  try {
    if (smEditingId) {
      const { error } = await window.sb.from('service_memos').update(payload).eq('id', smEditingId);
      if (error) throw error;
      AuditLog.record('service_memo_updated', { module: 'serviceMemo', clientName, recordRef: smEditingId });
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('service_memos').insert(payload).select('id').single();
      if (error) throw error;
      // memo_number is filled by an AFTER INSERT trigger, so it isn't in this
      // returned row — smRefresh() below reloads it. (Same gotcha as invoices.)
      AuditLog.record('service_memo_created', { module: 'serviceMemo', clientName, recordRef: data.id });
    }
    smCloseCreate();
    await smReload();
    smStatusMsg('✅ Service memo saved.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'sm-drawer-status');
  }
}

async function smDeleteMemo(row) {
  if (!confirm(`Delete service memo ${row.memo_number || ''} for ${row.client_name || 'this client'}? This cannot be undone.`)) return;
  const { error } = await window.sb.from('service_memos').delete().eq('id', row.id);
  if (error) { smStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('service_memo_deleted', { module: 'serviceMemo', clientName: row.client_name, recordRef: row.id });
  await smReload();
}

// ── PDF (formal Service Memo, drawn with PDF-Lib) ──
// The approach came from the old billing.js invoice builder (removed
// 2026-08-18); this is now the app's only PDF-Lib caller, so the WinAnsi
// fold-to-ASCII rule lives or dies here — standard fonts THROW on Devanagari.
function smFirmIdentity(memo) {
  const f = window.SERVICE_MEMO_FIRMS[memo.firm_key] || window.SERVICE_MEMO_FIRMS.shailesh;
  const base = f.ref ? window.REP_FIRMS[f.ref] : null;
  return {
    name: smFirmName(memo),
    title: base ? base.title : '',
    address: (base ? base.address : f.address) || '',
    phone: (base ? base.phone : f.phone) || '',
    email: (base ? base.email : f.email) || '',
    pan: (base ? base.pan : f.pan) || '',
    signatoryName: base ? base.signatoryName : '',
    signatoryTitle: base ? base.signatoryTitle : '',
  };
}

function smWrapText(font, size, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach(w => {
    const test = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  });
  if (line) lines.push(line);
  return lines;
}

async function smBuildMemoPdf(memo) {
  const firm = smFirmIdentity(memo);
  const doc = await PDFLib.PDFDocument.create();
  let page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const navy = PDFLib.rgb(0.043, 0.122, 0.239);
  const muted = PDFLib.rgb(0.392, 0.455, 0.545);
  const black = PDFLib.rgb(0.1, 0.12, 0.16);
  const line = PDFLib.rgb(0.9, 0.91, 0.95);
  const marginL = 50, marginR = 545;
  let y = 792;
  const draw = (text, x, size, f, color) => page.drawText(String(text), { x, y, size, font: f || font, color: color || black });
  const drawRight = (text, xEnd, size, f, color) => {
    const w = (f || font).widthOfTextAtSize(String(text), size);
    page.drawText(String(text), { x: xEnd - w, y, size, font: f || font, color: color || black });
  };
  const dash = v => (v == null || v === '' ? '—' : v);

  // Letterhead (left)
  draw(firm.name, marginL, 16, bold, navy); y -= 15;
  if (firm.title) { draw(firm.title, marginL, 9.5, font, muted); y -= 12; }
  draw(dash(firm.address), marginL, 9, font, muted); y -= 12;
  if (firm.phone || firm.email) { draw(`${firm.phone ? 'Phone: ' + firm.phone : ''}${firm.phone && firm.email ? '  ·  ' : ''}${firm.email ? 'Email: ' + firm.email : ''}`, marginL, 9, font, muted); y -= 12; }
  draw(`PAN: ${dash(firm.pan)}`, marginL, 9, font, muted);

  // Title block (right)
  y = 792;
  drawRight('SERVICE MEMO', marginR, 19, bold, navy); y -= 19;
  drawRight(memo.memo_number || '(pending)', marginR, 11, bold); y -= 14;
  drawRight(`Date: ${dash(memo.memo_date)}`, marginR, 9.5, font, muted); y -= 12;
  if (memo.fiscal_year) drawRight(`F.Y. ${memo.fiscal_year}`, marginR, 9.5, font, muted);

  // Client block
  y = 700;
  draw('Client:', marginL, 10, bold, navy); y -= 14;
  draw(dash(memo.client_name), marginL, 11, bold); y -= 13;
  if (memo.client_address) { draw(memo.client_address, marginL, 9.5, font, muted); y -= 12; }
  if (memo.client_pan) { draw(`PAN: ${memo.client_pan}`, marginL, 9.5, font, muted); y -= 12; }

  // Nature + description
  y -= 8;
  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line }); y -= 16;
  draw('Nature of Task', marginL, 9.5, bold, muted); y -= 13;
  draw(smNatureText(memo), marginL, 11, font, black); y -= 18;
  if (memo.description) {
    draw('Description', marginL, 9.5, bold, muted); y -= 13;
    smWrapText(font, 10, memo.description, marginR - marginL).forEach(ln => { draw(ln, marginL, 10, font, black); y -= 13; });
    y -= 4;
  }

  // Fee table
  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line }); y -= 16;
  draw('Professional Fee', marginL, 10, font, black); drawRight(smNum(memo.professional_fee), marginR, 10, font, black); y -= 14;
  if (Number(memo.vat_amount) > 0) { draw('VAT (13%)', marginL, 10, font, muted); drawRight(smNum(memo.vat_amount), marginR, 10, font, muted); y -= 14; }
  page.drawLine({ start: { x: marginL, y: y + 3 }, end: { x: marginR, y: y + 3 }, thickness: 1, color: line }); y -= 3;
  draw('Total', marginL, 12, bold, navy); drawRight(smNum(memo.total_amount), marginR, 12, bold, navy); y -= 24;

  if (memo.remarks) {
    y -= 4; draw('Remarks', marginL, 9.5, bold, muted); y -= 12;
    smWrapText(font, 9, memo.remarks, marginR - marginL).forEach(ln => { draw(ln, marginL, 9, font, black); y -= 11; });
  }

  // Footer — this is the whole point: NOT a tax invoice.
  page.drawLine({ start: { x: marginL, y: 92 }, end: { x: marginR, y: 92 }, thickness: 1, color: line });
  page.drawText('Internal service record — not a tax invoice.', { x: marginL, y: 78, size: 8.5, font, color: muted });
  if (firm.signatoryName) {
    page.drawText(firm.signatoryName, { x: marginR - bold.widthOfTextAtSize(firm.signatoryName, 9.5), y: 74, size: 9.5, font: bold, color: black });
    page.drawText(firm.signatoryTitle, { x: marginR - font.widthOfTextAtSize(firm.signatoryTitle, 8.5), y: 62, size: 8.5, font, color: muted });
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function smDownloadPdf(row) {
  try {
    const blob = await smBuildMemoPdf(row);
    const fname = `Service Memo ${row.memo_number || row.id} - ${row.client_name || 'Client'}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'serviceMemo', clientName: row.client_name });
  } catch (e) {
    smStatusMsg('❌ Failed to generate PDF: ' + escHtml(e.message || String(e)), 'error');
  }
}
