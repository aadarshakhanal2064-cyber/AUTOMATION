// ════════════════════════════════════════════
//  VAT COMPLIANCE DASHBOARD
//  Portfolio-wide tracker for monthly VAT Return filing status — which
//  clients are filed / pending / overdue for any fiscal month. One row per
//  client per month in Supabase (vat_filings), created lazily on the first
//  real state change: a VAT-active client with no row simply displays as
//  Not Started, so months never need to be pre-created and history is
//  never overwritten (enforced by the table's unique constraint).
//  Separate concern from vatReturn.js, which reads ONE client's PDF —
//  this tracks the whole portfolio's filing state.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'vatCompliance', group: 'main', buttonId: 'nav-vatCompliance', panelId: 'tab-vatCompliance-panel' });

// IRD rule: a month's VAT return is due by the 25th of the FOLLOWING B.S. month.
const VATC_DEADLINE_DAY = 25;
const VATC_FILED_STATUSES = ['filed', 'filed_adjustments'];

const VATC_STATUSES = {
  not_started:       { label: 'Not Started',            icon: '⚪', badgeClass: 'badge-neutral' },
  waiting_docs:      { label: 'Waiting for Documents',  icon: '📄', badgeClass: 'badge-amber' },
  ocr_processing:    { label: 'OCR Processing',         icon: '⚙️', badgeClass: 'badge-blue' },
  under_review:      { label: 'Under Review',           icon: '👀', badgeClass: 'badge-purple' },
  ready_to_file:     { label: 'Ready to File',          icon: '📬', badgeClass: 'badge-blue' },
  filed:             { label: 'Filed',                  icon: '✅', badgeClass: 'badge-sent' },
  filed_adjustments: { label: 'Filed with Adjustments', icon: '✳️', badgeClass: 'badge-sent' },
  on_hold:           { label: 'On Hold',                icon: '⏸️', badgeClass: 'badge-yellow' },
  not_required:      { label: 'Not Required',           icon: '➖', badgeClass: 'badge-neutral' },
};

// Flag "waiting for documents" rows once they've sat that long.
const VATC_WAITING_ALERT_DAYS = 7;

// The stat cards double as quick filters — one definition drives both the
// card counts and the table filtering, so they can never disagree.
const VATC_FILTERS = {
  all:     { label: 'Total VAT Clients',     test: () => true },
  filed:   { label: 'Filed This Month',      test: r => VATC_FILED_STATUSES.includes(r.status) },
  pending: { label: 'Pending',               test: r => !VATC_FILED_STATUSES.includes(r.status) && r.status !== 'not_required' },
  overdue: { label: 'Overdue',               test: r => r.overdue },
  waiting: { label: 'Waiting for Documents', test: r => r.status === 'waiting_docs' },
  ready:   { label: 'Ready to File',         test: r => r.status === 'ready_to_file' },
  errors:  { label: 'Validation Errors',     test: r => vatcHasErrors(r) },
};

function vatcHasErrors(row) {
  const v = row.validation_summary;
  return !!(v && ((v.blocking || 0) > 0 || (v.warnings || 0) > 0));
}

let vatcTable = null;
let vatcRows = [];       // merged view (real + virtual rows) for the selected period
let vatcStaff = null;    // app_users, loaded once per session
let vatcInitDone = false;
let vatcDrawerRow = null;
let vatcActiveFilter = 'all';
let vatcCharts = { progress: null, completion: null, workload: null };

function vatcStatusMsg(html, type) {
  showStatus(html, type, 'vatc-status-area');
}

// Every status change — quick action, drawer save, later the automatic
// vatReturn.js hooks — goes through this one flow, which persists the row
// and writes the audit entry together.
const vatcFlow = WorkflowEngine.createStatusFlow({
  statuses: VATC_STATUSES,
  onTransition: async (row, from, to, ctx) => {
    const patch = Object.assign({ status: to, status_changed_at: new Date().toISOString() }, ctx.patch);
    if (VATC_FILED_STATUSES.includes(to)) {
      if (!patch.filed_at && !row.filed_at) patch.filed_at = new Date().toISOString();
      if (!patch.filed_date_bs && !row.filed_date_bs) {
        const bs = NepaliLocale.todayBs();
        if (bs) patch.filed_date_bs = bs.year + '/' + String(bs.month).padStart(2, '0') + '/' + String(bs.day).padStart(2, '0');
      }
    }
    await vatcSaveFiling(row, patch);
    AuditLog.record('vat_status_change', {
      module: 'vatCompliance', clientName: row.client_name, recordRef: row.id,
      oldStatus: from, newStatus: to, notes: ctx.note || null,
      fiscalYear: row.fiscal_year, month: row.month,
    });
    return row;
  },
});

// Lazy-create-or-update in one code path: upsert on the (client, FY, month)
// uniqueness the schema guarantees, so the first real change to a virtual
// "Not Started" row creates it and every later change updates it.
async function vatcSaveFiling(row, patch) {
  const payload = Object.assign({
    client_id: row.client_id,
    fiscal_year: row.fiscal_year,
    month: row.month,
    updated_by: (window.currentUser && window.currentUser.email) || null,
  }, patch);
  const { data, error } = await window.sb.from('vat_filings')
    .upsert(payload, { onConflict: 'client_id,fiscal_year,month' })
    .select()
    .single();
  if (error) throw error;
  Object.assign(row, data);
  return row;
}

// ── Period helpers ──
function vatcFyLabel(startYear) {
  return startYear + '/' + String((startYear + 1) % 100).padStart(2, '0');
}

// Fiscal (FY, month idx) -> the B.S. calendar year/month it falls in,
// e.g. FY 2083/84 month 1 (Shrawan) -> { calYear: 2083, calMonth: 4 }.
function vatcPeriodCalendar(fy, monthIdx) {
  const startYear = parseInt(fy.slice(0, 4), 10);
  return {
    calYear: monthIdx <= 9 ? startYear : startYear + 1,
    calMonth: monthIdx <= 9 ? monthIdx + 3 : monthIdx - 9,
  };
}

// Default view: the month currently being filed. Month M is due by the 25th
// of month M+1, so during any month the firm is working on the previous one.
function vatcCurrentDefaults() {
  const bs = NepaliLocale.todayBs();
  if (!bs) return { fy: '2082/83', monthIdx: 12 };
  const fiscal = NepaliLocale.bsFiscal(bs);
  if (fiscal.monthIdx > 1) return { fy: fiscal.fy, monthIdx: fiscal.monthIdx - 1 };
  const prevStart = parseInt(fiscal.fy.slice(0, 4), 10) - 1;
  return { fy: vatcFyLabel(prevStart), monthIdx: 12 };
}

function vatcIsOverdue(row) {
  if (VATC_FILED_STATUSES.includes(row.status) || row.status === 'not_required') return false;
  const today = NepaliLocale.todayBs();
  if (!today) return false;
  const cal = vatcPeriodCalendar(row.fiscal_year, row.month);
  let dueYear = cal.calYear, dueMonth = cal.calMonth + 1;
  if (dueMonth > 12) { dueMonth = 1; dueYear++; }
  return (today.year * 10000 + today.month * 100 + today.day) > (dueYear * 10000 + dueMonth * 100 + VATC_DEADLINE_DAY);
}

// ── Loading & merging ──
async function loadVatCompliance() {
  if (!vatcInitDone) {
    vatcInitControls();
    vatcInitDone = true;
  }
  await vatcRefresh();
}

function vatcInitControls() {
  const def = vatcCurrentDefaults();
  const defStart = parseInt(def.fy.slice(0, 4), 10);
  const fySel = document.getElementById('vatc-fy');
  const opts = [];
  for (let y = defStart + 1; y >= 2080; y--) opts.push(`<option value="${vatcFyLabel(y)}">${vatcFyLabel(y)}</option>`);
  fySel.innerHTML = opts.join('');
  fySel.value = def.fy;

  const mSel = document.getElementById('vatc-month');
  mSel.innerHTML = VAT_MONTH_ORDER.map((name, i) => `<option value="${i + 1}">${name}</option>`).join('');
  mSel.value = String(def.monthIdx);
}

async function vatcRefresh() {
  const fy = document.getElementById('vatc-fy').value;
  const month = parseInt(document.getElementById('vatc-month').value, 10);
  vatcStatusMsg('<span class="spinner spinner-navy"></span> Loading filings…', 'searching');

  try {
    if (!vatcStaff) {
      const { data, error } = await window.sb.from('app_users').select('id, email').order('email');
      if (error) throw error;
      vatcStaff = data || [];
    }
    const filings = await sbFetchAll(() => window.sb.from('vat_filings')
      .select('*, clients(name, pan, vat_status)')
      .eq('fiscal_year', fy).eq('month', month).order('id'));

    const staffById = new Map(vatcStaff.map(s => [s.id, s.email]));
    const byClient = new Map(filings.map(f => [f.client_id, f]));
    const rows = [];
    (window.clientsList || []).forEach(c => {
      const filing = byClient.get(c.id);
      // Only VAT-active clients get a virtual Not Started row; a real filing
      // row always shows regardless (history survives a client going inactive).
      if (!filing && c.vat_status !== 'active') return;
      byClient.delete(c.id);
      rows.push(vatcMakeRow(c, filing, fy, month, staffById));
    });
    // Filings whose client wasn't in the loaded directory (defensive)
    byClient.forEach(f => rows.push(vatcMakeRow({ id: f.client_id, name: f.clients && f.clients.name, pan: f.clients && f.clients.pan, vat_status: f.clients && f.clients.vat_status }, f, fy, month, staffById)));

    vatcRows = rows;
    const search = document.getElementById('vatc-search');
    if (search) search.value = '';
    if (vatcDrawerRow) vatcCloseDrawer(); // a period change makes the open drawer's row stale
    vatcRenderTable(rows);
    vatcApplyFilters();
    vatcRenderStats(rows);
    vatcRenderMonthCharts(rows);
    vatcRenderPeriodLabel(fy, month, rows);
    document.getElementById('vatc-status-area').innerHTML = '';
    await vatcRenderFyChart(fy);
  } catch (e) {
    vatcStatusMsg('❌ Failed to load filings: ' + escHtml(e.message || String(e)), 'error');
  }
}

function vatcMakeRow(client, filing, fy, month, staffById) {
  const row = {
    id: filing ? filing.id : null,
    client_id: client.id,
    client_name: client.name || '—',
    pan: client.pan || '',
    client_vat_status: client.vat_status || 'active',
    fiscal_year: fy,
    month,
    status: filing ? filing.status : 'not_started',
    status_changed_at: filing ? filing.status_changed_at : null,
    assigned_staff_id: filing ? filing.assigned_staff_id : null,
    assigned_email: (filing && filing.assigned_staff_id && staffById.get(filing.assigned_staff_id)) || '',
    notes: (filing && filing.notes) || '',
    filed_date_bs: filing ? filing.filed_date_bs : null,
    filed_at: filing ? filing.filed_at : null,
    workbook_filename: filing ? filing.workbook_filename : null,
    pdf_filename: filing ? filing.pdf_filename : null,
    validation_summary: filing ? filing.validation_summary : null,
    updated_at: filing ? filing.updated_at : null,
    updated_by: filing ? filing.updated_by : null,
  };
  row.overdue = vatcIsOverdue(row);
  return row;
}

function vatcRenderPeriodLabel(fy, month, rows) {
  const el = document.getElementById('vatc-period-label');
  if (!el) return;
  const cal = vatcPeriodCalendar(fy, month);
  let dueYear = cal.calYear, dueMonth = cal.calMonth + 1;
  if (dueMonth > 12) { dueMonth = 1; dueYear++; }
  const filed = rows.filter(r => VATC_FILED_STATUSES.includes(r.status)).length;
  const overdue = rows.filter(r => r.overdue).length;
  el.textContent = `${VAT_MONTH_ORDER[month - 1]} ${cal.calYear}/${String(cal.calMonth).padStart(2, '0')} · due ${dueYear}/${String(dueMonth).padStart(2, '0')}/${VATC_DEADLINE_DAY} — ${rows.length} clients, ${filed} filed, ${overdue} overdue`;
}

// ── Table ──
function vatcRenderTable(rows) {
  const wrap = document.getElementById('vatc-table-wrap');
  if (vatcTable) { vatcTable.destroy(); vatcTable = null; }

  if (!rows.length) {
    wrap.innerHTML = '<div class="log-empty">No VAT clients yet. Click <strong>Manage VAT Clients</strong> (top right) to search your directory and add the clients whose VAT you handle — they will then appear here automatically every month.</div>';
    return;
  }

  wrap.innerHTML = '';
  vatcTable = TableEngine.createTable(wrap, {
    data: rows,
    index: 'client_id', // virtual rows have no id yet — client_id is unique within one period view
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    selectableRows: true,
    initialSort: [{ column: 'client_name', dir: 'asc' }],
    rowFormatter: row => row.getElement().classList.toggle('vatc-row-overdue', !!row.getData().overdue),
    columns: [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', hozAlign: 'center', headerSort: false, width: 44, download: false, print: false },
      { title: 'Client', field: 'client_name', minWidth: 200, formatter: cell => {
          const d = cell.getRow().getData();
          const inactiveTag = d.client_vat_status === 'inactive' ? ' <span class="entity-badge">VAT inactive</span>' : '';
          return `<span style="font-weight:600;">${escHtml(d.client_name)}</span>${inactiveTag}`;
        } },
      { title: 'PAN', field: 'pan', width: 115, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Status', field: 'status', minWidth: 200, formatter: cell => {
          const d = cell.getRow().getData();
          let extra = '';
          if (d.overdue) extra += ' <span class="log-badge badge-error">⏰ Overdue</span>';
          if (d.status === 'waiting_docs' && d.status_changed_at) {
            const days = Math.floor((Date.now() - new Date(d.status_changed_at).getTime()) / 86400000);
            if (days >= VATC_WAITING_ALERT_DAYS) extra += ` <span class="log-badge badge-amber" title="Waiting for documents for ${days} days">⏳ ${days}d</span>`;
          }
          if (vatcHasErrors(d)) extra += ' <span class="log-badge badge-error" title="The last OCR extraction reported validation issues — open the VAT Return review screen">🔴 Errors</span>';
          return vatcFlow.badgeHtml(d.status) + extra;
        },
        accessorDownload: value => vatcFlow.meta(value).label },
      { title: 'Assigned To', field: 'assigned_email', minWidth: 140, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Updated', field: 'updated_at', width: 145, formatter: cell => {
          const d = cell.getRow().getData();
          if (!d.updated_at) return '<span style="color:var(--text-faint);">—</span>';
          const t = new Date(d.updated_at);
          return `<div>${isNaN(t) ? '—' : t.toLocaleDateString()}</div><div style="font-size:11px; color:var(--text-faint);">${escHtml((d.updated_by || '').split('@')[0])}</div>`;
        } },
      { title: 'Notes', field: 'notes', minWidth: 140, formatter: cell => {
          const v = cell.getValue() || '';
          if (!v) return '—';
          return `<span title="${escHtml(v)}">${escHtml(v.length > 40 ? v.slice(0, 40) + '…' : v)}</span>`;
        } },
      { title: 'Actions', field: 'client_id', headerSort: false, minWidth: 210, download: false, print: false, formatter: () => `
          <div class="client-actions">
            <button class="btn btn-outline btn-sm" data-action="open">Open</button>
            <button class="btn btn-outline btn-sm" data-action="filed" title="Mark Filed">✓ Filed</button>
            <button class="btn btn-outline btn-sm" data-action="waiting" title="Mark Waiting for Documents">⏳</button>
          </div>`,
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'open') vatcOpenDrawer(row);
          else if (btn.dataset.action === 'filed') vatcQuickStatus(row, 'filed');
          else if (btn.dataset.action === 'waiting') vatcQuickStatus(row, 'waiting_docs');
        } },
    ],
  });
  vatcTable.on('rowSelectionChanged', vatcUpdateBulkBar);
}

// ── Bulk actions ──
function vatcSelectedRows() {
  return vatcTable ? vatcTable.getSelectedData() : [];
}

function vatcUpdateBulkBar() {
  const bar = document.getElementById('vatc-bulk-bar');
  if (!bar) return;
  const n = vatcSelectedRows().length;
  bar.style.display = n ? 'flex' : 'none';
  document.getElementById('vatc-bulk-count').textContent = `${n} selected`;
  if (n && !document.getElementById('vatc-bulk-status').options.length) {
    document.getElementById('vatc-bulk-status').innerHTML = vatcFlow.statusKeys.map(k =>
      `<option value="${k}">${VATC_STATUSES[k].icon} ${VATC_STATUSES[k].label}</option>`).join('');
    document.getElementById('vatc-bulk-staff').innerHTML = '<option value="">— Unassigned —</option>' +
      (vatcStaff || []).map(s => `<option value="${s.id}">${escHtml(s.email)}</option>`).join('');
  }
}

// Runs one persistence call per selected row through the SAME single-row
// path (status flow / save + audit), so bulk changes are audited identically
// to individual ones — just sequenced with a progress message.
async function vatcBulkRun(selected, label, fn) {
  let done = 0, failed = 0;
  for (const data of selected) {
    const row = vatcRows.find(r => r.client_id === data.client_id);
    if (!row) continue;
    vatcStatusMsg(`<span class="spinner spinner-navy"></span> ${label} ${done + failed + 1}/${selected.length}…`, 'searching');
    try { await fn(row); done++; }
    catch (e) { failed++; console.error('vatCompliance bulk:', row.client_name, e); }
  }
  vatcRows.forEach(r => { r.overdue = vatcIsOverdue(r); });
  vatcRenderStats(vatcRows);
  vatcRenderMonthCharts(vatcRows);
  vatcApplyFilters(); // replaceData also clears the selection
  const fy = document.getElementById('vatc-fy').value;
  vatcRenderPeriodLabel(fy, parseInt(document.getElementById('vatc-month').value, 10), vatcRows);
  vatcRenderFyChart(fy);
  vatcStatusMsg(failed ? `⚠️ ${label}: ${done} updated, ${failed} failed — see the browser console.`
                       : `✅ ${label}: ${done} client${done === 1 ? '' : 's'} updated.`, failed ? 'error' : 'success');
}

async function vatcBulkStatus(to) {
  const selected = vatcSelectedRows();
  if (!selected.length || !VATC_STATUSES[to]) return;
  await vatcBulkRun(selected, `Setting ${vatcFlow.meta(to).label}`, row => vatcFlow.transition(row, to));
}

async function vatcBulkAssign() {
  const selected = vatcSelectedRows();
  if (!selected.length) return;
  const val = document.getElementById('vatc-bulk-staff').value;
  const staffId = val ? parseInt(val, 10) : null;
  const email = (staffId && vatcStaff && (vatcStaff.find(s => s.id === staffId) || {}).email) || '';
  await vatcBulkRun(selected, email ? `Assigning to ${email}` : 'Unassigning', async row => {
    await vatcSaveFiling(row, { assigned_staff_id: staffId });
    row.assigned_email = email;
    AuditLog.record('vat_filing_update', {
      module: 'vatCompliance', clientName: row.client_name, recordRef: row.id,
      changed: ['assigned_staff_id'], assignedTo: email || null,
      fiscalYear: row.fiscal_year, month: row.month,
    });
  });
}

function vatcExportCsv() {
  if (!vatcTable) return;
  const range = vatcSelectedRows().length ? 'selected' : 'active';
  const fy = document.getElementById('vatc-fy').value.replace('/', '-');
  const month = VAT_MONTH_ORDER[parseInt(document.getElementById('vatc-month').value, 10) - 1];
  vatcTable.download('csv', `vat-compliance-${fy}-${month}.csv`, {}, range);
}

function vatcPrint() {
  if (!vatcTable) return;
  vatcTable.print(vatcSelectedRows().length ? 'selected' : 'active', true);
}

// Active stat-card filter + live search, applied together.
function vatcApplyFilters() {
  if (!vatcTable) return;
  const test = (VATC_FILTERS[vatcActiveFilter] || VATC_FILTERS.all).test;
  let rows = vatcRows.filter(test);
  const q = (document.getElementById('vatc-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['client_name', 'pan', 'assigned_email', 'notes']);
    rows = fuse.search(q).map(r => r.item);
  }
  vatcTable.replaceData(rows);
}

function vatcFilterTable() {
  vatcApplyFilters();
}

function vatcSetFilter(key) {
  vatcActiveFilter = vatcActiveFilter === key ? 'all' : key; // click again to clear
  vatcRenderStats(vatcRows);
  vatcApplyFilters();
}

// ── Stat cards & charts ──
function vatcRenderStats(rows) {
  const grid = document.getElementById('vatc-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(VATC_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${vatcActiveFilter === key ? 'active-filter' : ''}" onclick="vatcSetFilter('${key}')" title="Click to filter the table below">
      <div class="stat-num">${rows.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

function vatcDestroyChart(key) {
  if (vatcCharts[key]) { vatcCharts[key].destroy(); vatcCharts[key] = null; }
}

// Completion doughnut + pending-workload-by-staff, both derived from the
// already-loaded month rows — same source as the cards, no extra queries.
function vatcRenderMonthCharts(rows) {
  if (!window.Chart) return;

  const filed = rows.filter(VATC_FILTERS.filed.test).length;
  const notRequired = rows.filter(r => r.status === 'not_required').length;
  const open = rows.length - filed - notRequired;
  vatcDestroyChart('completion');
  const cEl = document.getElementById('vatc-chart-completion');
  if (cEl) {
    vatcCharts.completion = new Chart(cEl.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Filed', 'Open', 'Not Required'],
        datasets: [{ data: [filed, open, notRequired], backgroundColor: ['#10b981', '#f59e0b', '#cbd5e1'] }],
      },
      options: { plugins: { legend: { position: 'bottom' } } },
    });
  }

  const counts = {};
  rows.filter(VATC_FILTERS.pending.test).forEach(r => {
    const k = r.assigned_email ? r.assigned_email.split('@')[0] : 'Unassigned';
    counts[k] = (counts[k] || 0) + 1;
  });
  vatcDestroyChart('workload');
  const wEl = document.getElementById('vatc-chart-workload');
  if (wEl) {
    const hasData = Object.keys(counts).length > 0;
    vatcCharts.workload = new Chart(wEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: hasData ? Object.keys(counts) : ['No pending work'],
        datasets: [{ label: 'Pending', data: hasData ? Object.values(counts) : [0], backgroundColor: '#205493' }],
      },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { precision: 0 } } } },
    });
  }
}

// FY-wide stacked bar via the get_vat_fy_stats RPC — per-month counts in one
// round trip instead of fetching every filing row of the year. Counts only
// tracked filings (a month nobody has touched yet has no rows to count).
async function vatcRenderFyChart(fy) {
  const el = document.getElementById('vatc-chart-progress');
  if (!el || !window.Chart) return;
  const { data, error } = await window.sb.rpc('get_vat_fy_stats', { p_fiscal_year: fy });
  vatcDestroyChart('progress');
  const filedPerMonth = new Array(12).fill(0);
  const openPerMonth = new Array(12).fill(0);
  (error ? [] : (data || [])).forEach(s => {
    if (VATC_FILED_STATUSES.includes(s.status)) filedPerMonth[s.month - 1] += Number(s.cnt);
    else if (s.status !== 'not_required') openPerMonth[s.month - 1] += Number(s.cnt);
  });
  vatcCharts.progress = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: VAT_MONTH_ORDER,
      datasets: [
        { label: 'Filed', data: filedPerMonth, backgroundColor: '#10b981' },
        { label: 'In progress', data: openPerMonth, backgroundColor: '#f59e0b' },
      ],
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'bottom' } } },
  });
}

// Everything that must stay in sync after one row changes (quick action or
// drawer save): overdue flag, cards, charts, filtered table, summary line.
function vatcAfterRowChange(row) {
  row.overdue = vatcIsOverdue(row);
  vatcRenderStats(vatcRows);
  vatcRenderMonthCharts(vatcRows);
  vatcApplyFilters();
  vatcRenderPeriodLabel(row.fiscal_year, row.month, vatcRows);
  vatcRenderFyChart(row.fiscal_year);
}

async function vatcQuickStatus(row, to) {
  const fromLabel = vatcFlow.meta(row.status).label;
  try {
    await vatcFlow.transition(row, to);
    vatcAfterRowChange(row);
    vatcStatusMsg(`✅ ${escHtml(row.client_name)}: ${escHtml(fromLabel)} → ${escHtml(vatcFlow.meta(to).label)}.`, 'success');
  } catch (e) {
    vatcStatusMsg('❌ Could not update status: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Side panel (drawer) ──
function vatcOpenDrawer(row) {
  vatcDrawerRow = row;
  const cal = vatcPeriodCalendar(row.fiscal_year, row.month);
  document.getElementById('vatc-drawer-title').textContent = row.client_name;
  document.getElementById('vatc-drawer-sub').textContent =
    `PAN ${row.pan || '—'} · ${VAT_MONTH_ORDER[row.month - 1]} · FY ${row.fiscal_year} (${cal.calYear}/${String(cal.calMonth).padStart(2, '0')})`;

  document.getElementById('vatc-d-status').innerHTML = vatcFlow.statusKeys.map(k =>
    `<option value="${k}" ${k === row.status ? 'selected' : ''}>${VATC_STATUSES[k].icon} ${VATC_STATUSES[k].label}</option>`).join('');
  document.getElementById('vatc-d-staff').innerHTML = '<option value="">— Unassigned —</option>' +
    (vatcStaff || []).map(s => `<option value="${s.id}" ${row.assigned_staff_id === s.id ? 'selected' : ''}>${escHtml(s.email)}</option>`).join('');
  document.getElementById('vatc-d-filed').value = row.filed_date_bs || '';
  document.getElementById('vatc-d-workbook').value = row.workbook_filename || '';
  document.getElementById('vatc-d-notes').value = row.notes || '';
  document.getElementById('vatc-drawer-status').innerHTML = '';

  document.getElementById('vatc-drawer').classList.add('open');
  vatcRenderHistory(row);
}

function vatcCloseDrawer() {
  document.getElementById('vatc-drawer').classList.remove('open');
  vatcDrawerRow = null;
}

async function vatcSaveDrawer() {
  const row = vatcDrawerRow;
  if (!row) return;

  const newStatus = document.getElementById('vatc-d-status').value;
  const staffVal = document.getElementById('vatc-d-staff').value;
  const patch = {};
  const staffId = staffVal ? parseInt(staffVal, 10) : null;
  if (staffId !== (row.assigned_staff_id || null)) patch.assigned_staff_id = staffId;
  const filedDate = document.getElementById('vatc-d-filed').value.trim() || null;
  if (filedDate !== (row.filed_date_bs || null)) patch.filed_date_bs = filedDate;
  const notes = document.getElementById('vatc-d-notes').value.trim() || null;
  if (notes !== (row.notes || null)) patch.notes = notes;

  const statusChanged = newStatus !== row.status;
  if (!statusChanged && !Object.keys(patch).length) { vatcCloseDrawer(); return; }

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'vatc-drawer-status');
  try {
    if (statusChanged) {
      await vatcFlow.transition(row, newStatus, { patch, note: notes });
    } else {
      await vatcSaveFiling(row, patch);
      AuditLog.record('vat_filing_update', {
        module: 'vatCompliance', clientName: row.client_name, recordRef: row.id,
        changed: Object.keys(patch), fiscalYear: row.fiscal_year, month: row.month,
      });
    }
    row.notes = row.notes || '';
    row.assigned_email = (row.assigned_staff_id && vatcStaff && (vatcStaff.find(s => s.id === row.assigned_staff_id) || {}).email) || '';
    vatcAfterRowChange(row);
    showStatus('✅ Saved.', 'success', 'vatc-drawer-status');
    vatcRenderHistory(row);
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'vatc-drawer-status');
  }
}

// ── Manage VAT Clients picker ──
// Only a subset of the client directory files VAT with the firm, so
// membership is chosen by hand here: search the directory, Add / Remove.
// With no search query the list shows the current VAT clients.
let vatcPickerQuery = '';

function vatcOpenPicker() {
  vatcPickerQuery = '';
  document.getElementById('vatc-picker-search').value = '';
  document.getElementById('vatc-picker-status').innerHTML = '';
  vatcRenderPickerList();
  document.getElementById('vatc-picker').classList.add('open');
  document.getElementById('vatc-picker-search').focus();
}

function vatcClosePicker() {
  document.getElementById('vatc-picker').classList.remove('open');
  vatcRefresh(); // reflect membership changes in the dashboard
}

function vatcPickerSearch(q) {
  vatcPickerQuery = (q || '').trim();
  vatcRenderPickerList();
}

function vatcRenderPickerList() {
  const el = document.getElementById('vatc-picker-list');
  const all = window.clientsList || [];
  let list;
  if (vatcPickerQuery) {
    const fuse = SearchEngine.buildIndex(all, ['name', 'pan']);
    list = fuse.search(vatcPickerQuery).map(r => r.item).slice(0, 30);
  } else {
    list = all.filter(c => c.vat_status === 'active');
  }

  const activeCount = all.filter(c => c.vat_status === 'active').length;
  document.getElementById('vatc-picker-count').textContent =
    `${activeCount} VAT client${activeCount === 1 ? '' : 's'} on the dashboard`;

  if (!list.length) {
    el.innerHTML = `<div class="log-empty">${vatcPickerQuery
      ? 'No clients match your search.'
      : 'No VAT clients yet — search your directory above and click Add.'}</div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const isActive = c.vat_status === 'active';
    return `<div class="log-item">
      <div class="log-details">
        <div class="log-client">${escHtml(c.name)}</div>
        <div class="log-sub">PAN ${escHtml(c.pan || '—')}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
      </div>
      ${isActive ? '<span class="log-badge badge-sent">VAT Active</span>' : ''}
      <button class="btn ${isActive ? 'btn-outline' : 'btn-primary'} btn-sm" onclick="vatcPickerToggle(${c.id}, ${!isActive})">${isActive ? 'Remove' : '+ Add'}</button>
    </div>`;
  }).join('');
}

async function vatcPickerToggle(clientId, makeActive) {
  const client = (window.clientsList || []).find(c => c.id === clientId);
  if (!client) return;

  let newStatus = 'active';
  if (!makeActive) {
    // A client with filing history becomes Inactive (their history keeps
    // showing on past months); one that never filed goes back to plain
    // Not VAT Registered.
    const { count } = await window.sb.from('vat_filings')
      .select('id', { count: 'exact', head: true }).eq('client_id', clientId);
    newStatus = (count || 0) > 0 ? 'inactive' : 'not_registered';
  }

  const { error } = await window.sb.from('clients').update({ vat_status: newStatus }).eq('id', clientId);
  if (error) {
    showStatus('❌ ' + escHtml(error.message), 'error', 'vatc-picker-status');
    return;
  }
  client.vat_status = newStatus;
  AuditLog.record('vat_client_change', {
    module: 'vatCompliance', clientName: client.name, vatStatus: newStatus,
  });
  document.getElementById('vatc-picker-status').innerHTML = '';
  vatcRenderPickerList();
}

// ── Integration API (called from vatReturn.js) ──
// Progresses a client's months automatically when the OCR module extracts
// or generates for them. Works directly against vat_filings (the tab need
// not be open), through the SAME status flow as manual changes, and only
// ever moves FORWARD along this chain — a month a human already moved
// further (or set Filed / On Hold / Not Required) is never downgraded.
const VATC_AUTO_ORDER = ['not_started', 'waiting_docs', 'ocr_processing', 'under_review', 'ready_to_file'];

async function vatcAutoProgress({ clientId, clientName, fiscalYear, months, toStatus, patchByMonth }) {
  const { data: existing, error } = await window.sb.from('vat_filings')
    .select('*').eq('client_id', clientId).eq('fiscal_year', fiscalYear).in('month', months);
  if (error) throw error;
  const byMonth = new Map((existing || []).map(f => [f.month, f]));
  const toIdx = VATC_AUTO_ORDER.indexOf(toStatus);

  for (const m of months) {
    const f = byMonth.get(m);
    const row = f
      ? Object.assign({ client_name: clientName }, f)
      : { id: null, client_id: clientId, client_name: clientName, fiscal_year: fiscalYear, month: m, status: 'not_started', filed_at: null, filed_date_bs: null };
    const curIdx = VATC_AUTO_ORDER.indexOf(row.status);
    if (curIdx === -1) continue; // filed / on hold / not required — hands off
    const patch = (patchByMonth && patchByMonth[m]) || {};
    if (curIdx < toIdx) {
      await vatcFlow.transition(row, toStatus, { patch, note: 'Automatic (VAT Return module)' });
    } else if (Object.keys(patch).length) {
      // Same or later stage: don't move it, but refresh what the OCR run
      // learned (validation summary, workbook filename).
      await vatcSaveFiling(row, patch);
    }
  }

  // If the user is looking at an affected period right now, reflect it.
  if (vatcInitDone && document.getElementById('vatc-fy').value === fiscalYear
      && months.includes(parseInt(document.getElementById('vatc-month').value, 10))) {
    vatcRefresh();
  }
}

async function vatcRenderHistory(row) {
  const el = document.getElementById('vatc-drawer-history');
  if (!row.id) { el.innerHTML = '<div class="log-empty">No history yet — nothing has been recorded for this month.</div>'; return; }
  el.innerHTML = '<div class="log-empty">Loading…</div>';
  const { data, error } = await window.sb.from('audit_log').select('*')
    .eq('record_ref', row.id).order('created_at', { ascending: false }).limit(25);
  if (error || !data || !data.length) { el.innerHTML = '<div class="log-empty">No history yet.</div>'; return; }
  el.innerHTML = data.map(e => {
    const t = new Date(e.created_at);
    const det = e.detail || {};
    const what = e.event_type === 'vat_status_change'
      ? `${vatcFlow.meta(det.oldStatus).label} → ${vatcFlow.meta(det.newStatus).label}`
      : 'Details updated';
    return `<div class="log-item">
      <div class="log-details">
        <div class="log-client">${escHtml(what)}</div>
        <div class="log-sub">${escHtml(e.user_email || '—')}${det.notes ? ' — ' + escHtml(det.notes) : ''}</div>
      </div>
      <div class="log-time">${isNaN(t) ? '—' : t.toLocaleString()}</div>
    </div>`;
  }).join('');
}
