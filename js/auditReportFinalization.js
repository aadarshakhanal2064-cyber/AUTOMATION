// ════════════════════════════════════════════
//  AUDIT REPORT FINALIZATION
//  A shared status tracker (sidebar module, own top-level nav item) for
//  where a client's IT return / Estimate return submission and tax
//  clearance stand for a fiscal year. NOT tied to document generation —
//  pure task-status tracking used by multiple staff.
//
//  ONE EVOLVING RECORD per (client, fiscal year): staff edit the same row
//  over time as the picture changes, never a new row per edit. The
//  UNIQUE (client_id, fiscal_year) constraint enforces this in the
//  database; arfOnClientOrFyChange() detects an existing record the moment
//  both are picked in the form and routes into edit mode against it, so a
//  save never collides with the constraint in normal use.
//
//  IT/Estimate status is a DERIVED 4-key badge (not_submitted / submitted /
//  verified / not_verified), never a stored column — arfItStatusKey() /
//  arfEstimateStatusKey() compute it from the raw fields, and that same
//  function feeds the badge, the filter dropdown and the print/export
//  column text, so none of the three can ever disagree.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'auditReportFinalization', group: 'main', buttonId: 'nav-auditReportFinalization', panelId: 'tab-auditReportFinalization-panel' });

const ARF_IT_STATUSES = {
  not_submitted: { label: 'Not Submitted', icon: '⬜', badgeClass: 'badge-neutral' },
  submitted:     { label: 'Submitted',     icon: '📤', badgeClass: 'badge-amber' },
  verified:      { label: 'Verified',      icon: '✅', badgeClass: 'badge-sent' },
  not_verified:  { label: 'Not Verified',  icon: '❌', badgeClass: 'badge-error' },
};

const ARF_ESTIMATE_STATUSES = {
  not_submitted: { label: 'Not Submitted', icon: '⬜', badgeClass: 'badge-neutral' },
  submitted:     { label: 'Checked',       icon: '📤', badgeClass: 'badge-amber' },
  verified:      { label: 'Verified',      icon: '✅', badgeClass: 'badge-sent' },
  not_verified:  { label: 'Not Verified',  icon: '❌', badgeClass: 'badge-error' },
};

// Used only for their .badgeHtml() mapping — there's no button-driven
// .transition() here, status is derived from saved fields (same idea
// billing.js uses for its trigger-owned status badge).
const arfItFlow = WorkflowEngine.createStatusFlow({ statuses: ARF_IT_STATUSES, onTransition: r => r });
const arfEstimateFlow = WorkflowEngine.createStatusFlow({ statuses: ARF_ESTIMATE_STATUSES, onTransition: r => r });

const ARF_FY_START = 2077;
const ARF_FY_END = 2085;
const ARF_FY_DEFAULT = '2083/84';

const ARF_FILTERS = {
  all:              { label: 'Total Records',     test: () => true },
  itVerified:       { label: 'IT Verified',        test: r => arfItStatusKey(r) === 'verified' },
  estimateVerified: { label: 'Estimate Verified',  test: r => arfEstimateStatusKey(r) === 'verified' },
  taxCleared:       { label: 'Tax Cleared',        test: r => r.tax_clearance === true },
};

const ARF_FILTERS_EMPTY = { auditor: '', fiscalYear: '', itStatus: '', estStatus: '', taxClearance: '' };

let arfRecords = [];
let arfTable = null;
let arfSelectedClient = null;
let arfEditingId = null;
let arfActiveFilter = 'all';
let arfInitDone = false;
let arfFilters = { ...ARF_FILTERS_EMPTY };
let arfLastModel = null;

function arfUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function arfStatusMsg(html, type) { showStatus(html, type, 'arf-status-area'); }
function arfToday() { return new Date().toISOString().slice(0, 10); }

function arfFyLabel(startYear) { return startYear + '/' + String((startYear + 1) % 100).padStart(2, '0'); }
function arfFyOptions() {
  const opts = [];
  for (let y = ARF_FY_END; y >= ARF_FY_START; y--) opts.push(arfFyLabel(y));
  return opts;
}

// ── Derived status (never stored — see header note) ──
function arfItStatusKey(row) {
  if (row.it_verified === true) return 'verified';
  if (row.it_verified === false) return 'not_verified';
  if ((row.it_submission_no || '').trim() || (row.it_entered_by || '').trim()) return 'submitted';
  return 'not_submitted';
}
function arfEstimateStatusKey(row) {
  if (row.estimate_verified === true) return 'verified';
  if (row.estimate_verified === false) return 'not_verified';
  if ((row.estimate_checked_by || '').trim()) return 'submitted';
  return 'not_submitted';
}

// ── Init & load ──
function arfInit() {
  if (!arfInitDone) {
    SearchEngine.attachAutocomplete(document.getElementById('arf-client-search'), document.getElementById('arf-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: arfSelectClient,
    });
    arfPopulateStaticDropdowns();
    arfInitDone = true;
  }
  arfRefresh();
}

function arfPopulateStaticDropdowns() {
  const auditorOpts = '<option value="">Select…</option>' + window.ARF_AUDITORS.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');
  document.getElementById('arf-auditor').innerHTML = auditorOpts;
  document.getElementById('arf-filter-auditor').innerHTML = '<option value="">All Auditors</option>' + window.ARF_AUDITORS.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');

  const staffOpts = window.ARF_STAFF.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  document.getElementById('arf-it-entered-by').innerHTML = '<option value="">Select…</option>' + staffOpts;
  document.getElementById('arf-estimate-checked-by').innerHTML = '<option value="">Select…</option>' + staffOpts;

  const fyOpts = arfFyOptions().map(fy => `<option value="${fy}">${fy}</option>`).join('');
  document.getElementById('arf-fiscal-year').innerHTML = fyOpts;
  document.getElementById('arf-fiscal-year').value = ARF_FY_DEFAULT;
  document.getElementById('arf-filter-fy').innerHTML = '<option value="">All Years</option>' + fyOpts;

  const itStatusOpts = Object.entries(ARF_IT_STATUSES).map(([k, m]) => `<option value="${k}">${escHtml(m.label)}</option>`).join('');
  document.getElementById('arf-filter-it-status').innerHTML = '<option value="">All IT Status</option>' + itStatusOpts;
  const estStatusOpts = Object.entries(ARF_ESTIMATE_STATUSES).map(([k, m]) => `<option value="${k}">${escHtml(m.label)}</option>`).join('');
  document.getElementById('arf-filter-est-status').innerHTML = '<option value="">All Estimate Status</option>' + estStatusOpts;
}

async function arfRefresh() {
  arfStatusMsg('<span class="spinner spinner-navy"></span> Loading records…', 'searching');
  try {
    arfRecords = await sbFetchAll(() => window.sb.from('audit_report_finalization')
      .select('*').order('fiscal_year', { ascending: false }).order('client_name', { ascending: true }));
    arfRenderStats();
    arfRenderTable();
    document.getElementById('arf-status-area').innerHTML = '';
  } catch (e) {
    arfStatusMsg('❌ Failed to load records: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Stat cards (also the quick filters) ──
function arfRenderStats() {
  const grid = document.getElementById('arf-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(ARF_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${arfActiveFilter === key ? 'active-filter' : ''}" onclick="arfSetFilter('${key}')" title="Click to filter the table below">
      <div class="stat-num">${arfRecords.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

function arfSetFilter(key) {
  arfActiveFilter = key;
  arfRenderStats();
  arfApplyFilters();
}

// ── List table ──
function arfRenderTable() {
  const wrap = document.getElementById('arf-table-wrap');
  if (arfTable) { arfTable.destroy(); arfTable = null; }
  if (!arfRecords.length) {
    wrap.innerHTML = '<div class="log-empty">No records yet. Click <strong>New Record</strong> to track a client\'s finalization status.</div>';
    return;
  }
  wrap.innerHTML = '';
  arfTable = TableEngine.createTable(wrap, {
    data: arfRecords,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    columns: [
      { title: 'FY', field: 'fiscal_year', width: 90 },
      { title: 'Client', field: 'client_name', minWidth: 170, formatter: c => {
          const r = c.getRow().getData();
          return escHtml(r.client_name || '—') + (r.client_pan ? `<br><span style="color:var(--text-faint); font-size:12px;">PAN ${escHtml(r.client_pan)}</span>` : '');
        } },
      { title: 'Auditor', field: 'auditor', minWidth: 160, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'IT Entered By', field: 'it_entered_by', minWidth: 130, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'IT Status', field: 'it_verified', width: 130, headerSort: false, formatter: c => arfItFlow.badgeHtml(arfItStatusKey(c.getRow().getData())) },
      { title: 'Estimate Checked By', field: 'estimate_checked_by', minWidth: 150, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Estimate Status', field: 'estimate_verified', width: 130, headerSort: false, formatter: c => arfEstimateFlow.badgeHtml(arfEstimateStatusKey(c.getRow().getData())) },
      { title: 'Tax Clearance', field: 'tax_clearance', width: 120, formatter: c => c.getValue()
          ? `<span class="log-badge badge-sent">✅ Yes</span>` : `<span class="log-badge badge-neutral">— No</span>` },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 190, formatter: c => arfRowActions(c.getRow().getData()),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') arfOpenEntry(row);
          else if (btn.dataset.action === 'print') arfPrintOne(row);
          else if (btn.dataset.action === 'delete') arfDeleteEntry(row);
        } },
    ],
  });
  arfApplyFilters();
}

function arfRowActions(row) {
  const btn = (a, label, title) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${title || label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('print', 'Print')}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function arfReadFilters() {
  arfFilters = {
    auditor: document.getElementById('arf-filter-auditor').value,
    fiscalYear: document.getElementById('arf-filter-fy').value,
    itStatus: document.getElementById('arf-filter-it-status').value,
    estStatus: document.getElementById('arf-filter-est-status').value,
    taxClearance: document.getElementById('arf-filter-tax-clearance').value,
  };
}

function arfCurrentFilteredRows() {
  const cardTest = ARF_FILTERS[arfActiveFilter].test;
  let rows = arfRecords.filter(r => {
    if (!cardTest(r)) return false;
    if (arfFilters.auditor && r.auditor !== arfFilters.auditor) return false;
    if (arfFilters.fiscalYear && r.fiscal_year !== arfFilters.fiscalYear) return false;
    if (arfFilters.itStatus && arfItStatusKey(r) !== arfFilters.itStatus) return false;
    if (arfFilters.estStatus && arfEstimateStatusKey(r) !== arfFilters.estStatus) return false;
    if (arfFilters.taxClearance === 'yes' && r.tax_clearance !== true) return false;
    if (arfFilters.taxClearance === 'no' && r.tax_clearance === true) return false;
    return true;
  });
  const q = (document.getElementById('arf-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['client_name', 'client_pan', 'it_submission_no', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function arfApplyFilters() {
  if (!arfTable) return;
  arfTable.replaceData(arfCurrentFilteredRows());
}

function arfOnFilterChange() { arfReadFilters(); arfApplyFilters(); }

function arfClearFilters() {
  ['arf-filter-auditor', 'arf-filter-fy', 'arf-filter-it-status', 'arf-filter-est-status', 'arf-filter-tax-clearance', 'arf-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  arfFilters = { ...ARF_FILTERS_EMPTY };
  arfActiveFilter = 'all';
  arfRenderStats();
  arfApplyFilters();
}

// ── Entry drawer (create / edit) ──
function arfSelectClient(c) {
  arfSelectedClient = c;
  document.getElementById('arf-client-search').value = c.name;
  document.getElementById('arf-client-pan').value = c.pan || '';
  arfOnClientOrFyChange();
}

// One evolving record per (client, fiscal year): the moment both are known,
// look for an existing row and switch into editing it instead of letting a
// second save collide with the UNIQUE constraint.
function arfOnClientOrFyChange() {
  const fy = document.getElementById('arf-fiscal-year').value;
  if (!arfSelectedClient || !fy || arfEditingId) return;
  const existing = arfRecords.find(r => r.client_id === arfSelectedClient.id && r.fiscal_year === fy);
  if (existing) {
    arfLoadIntoDrawer(existing, true);
    showStatus('Editing the existing record for this client and fiscal year.', 'info', 'arf-drawer-status');
  }
}

function arfResolveStaffField(selectId, otherId) {
  const sel = document.getElementById(selectId).value;
  if (sel === 'Other') return document.getElementById(otherId).value.trim() || null;
  return sel || null;
}

function arfOnStaffChange(selectId, otherGroupId) {
  const sel = document.getElementById(selectId);
  document.getElementById(otherGroupId).style.display = sel.value === 'Other' ? '' : 'none';
}

function arfOnTaxClearanceChange() {
  const on = document.getElementById('arf-tax-clearance').checked;
  document.getElementById('arf-tax-clearance-date-group').style.display = on ? '' : 'none';
  const dateEl = document.getElementById('arf-tax-clearance-date');
  if (on && !dateEl.value) dateEl.value = arfToday();
  if (!on) dateEl.value = '';
}

function arfLoadIntoDrawer(existing, keepClientTyped) {
  arfEditingId = existing.id;
  document.getElementById('arf-drawer-title').textContent = `Edit Record — ${existing.client_name}`;

  if (!keepClientTyped) {
    document.getElementById('arf-client-search').value = existing.client_name || '';
    document.getElementById('arf-client-pan').value = existing.client_pan || '';
    arfSelectedClient = (window.clientsList || []).find(c => c.id === existing.client_id) || null;
  }
  document.getElementById('arf-fiscal-year').value = existing.fiscal_year || ARF_FY_DEFAULT;
  document.getElementById('arf-auditor').value = existing.auditor || '';

  const itIsOther = existing.it_entered_by && !window.ARF_STAFF.slice(0, -1).includes(existing.it_entered_by);
  document.getElementById('arf-it-entered-by').value = itIsOther ? 'Other' : (existing.it_entered_by || '');
  document.getElementById('arf-it-entered-by-other').value = itIsOther ? existing.it_entered_by : '';
  arfOnStaffChange('arf-it-entered-by', 'arf-it-entered-by-other-group');
  document.getElementById('arf-it-submission-no').value = existing.it_submission_no || '';
  document.getElementById('arf-it-verified').value = existing.it_verified === true ? 'true' : existing.it_verified === false ? 'false' : '';

  const estIsOther = existing.estimate_checked_by && !window.ARF_STAFF.slice(0, -1).includes(existing.estimate_checked_by);
  document.getElementById('arf-estimate-checked-by').value = estIsOther ? 'Other' : (existing.estimate_checked_by || '');
  document.getElementById('arf-estimate-checked-by-other').value = estIsOther ? existing.estimate_checked_by : '';
  arfOnStaffChange('arf-estimate-checked-by', 'arf-estimate-checked-by-other-group');
  document.getElementById('arf-estimate-verified').value = existing.estimate_verified === true ? 'true' : existing.estimate_verified === false ? 'false' : '';

  document.getElementById('arf-tax-clearance').checked = !!existing.tax_clearance;
  document.getElementById('arf-tax-clearance-date').value = existing.tax_clearance_date || '';
  arfOnTaxClearanceChange();

  document.getElementById('arf-remarks').value = existing.remarks || '';
}

function arfOpenEntry(existing) {
  arfEditingId = null;
  arfSelectedClient = null;
  document.getElementById('arf-drawer-title').textContent = existing ? `Edit Record — ${existing.client_name}` : 'New Record';
  document.getElementById('arf-drawer-status').innerHTML = '';

  document.getElementById('arf-client-search').value = '';
  document.getElementById('arf-client-pan').value = '';
  document.getElementById('arf-fiscal-year').value = ARF_FY_DEFAULT;
  document.getElementById('arf-auditor').value = '';
  document.getElementById('arf-it-entered-by').value = '';
  document.getElementById('arf-it-entered-by-other').value = '';
  document.getElementById('arf-it-entered-by-other-group').style.display = 'none';
  document.getElementById('arf-it-submission-no').value = '';
  document.getElementById('arf-it-verified').value = '';
  document.getElementById('arf-estimate-checked-by').value = '';
  document.getElementById('arf-estimate-checked-by-other').value = '';
  document.getElementById('arf-estimate-checked-by-other-group').style.display = 'none';
  document.getElementById('arf-estimate-verified').value = '';
  document.getElementById('arf-tax-clearance').checked = false;
  document.getElementById('arf-tax-clearance-date').value = '';
  document.getElementById('arf-tax-clearance-date-group').style.display = 'none';
  document.getElementById('arf-remarks').value = '';

  if (existing) arfLoadIntoDrawer(existing, false);

  document.getElementById('arf-entry-drawer').classList.add('open');
}

function arfCloseEntry() { document.getElementById('arf-entry-drawer').classList.remove('open'); }

async function arfSaveEntry() {
  const drawerErr = msg => showStatus(escHtml(msg), 'info', 'arf-drawer-status');
  const clientName = document.getElementById('arf-client-search').value.trim();
  if (!clientName) { drawerErr('Enter or select a client.'); return; }
  // Keep client_id only while the typed name still matches the picked client
  // — a hand-edited name means no client_id, and this table requires one.
  const clientId = (arfSelectedClient && arfSelectedClient.name === clientName) ? arfSelectedClient.id : null;
  if (!clientId) { drawerErr('Pick a client from the list — this module only tracks directory clients.'); return; }
  const fiscalYear = document.getElementById('arf-fiscal-year').value;
  if (!fiscalYear) { drawerErr('Choose a fiscal year.'); return; }
  const auditor = document.getElementById('arf-auditor').value;
  if (!auditor) { drawerErr('Choose an auditor.'); return; }

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: document.getElementById('arf-client-pan').value.trim() || null,
    fiscal_year: fiscalYear,
    auditor,
    it_entered_by: arfResolveStaffField('arf-it-entered-by', 'arf-it-entered-by-other'),
    it_submission_no: document.getElementById('arf-it-submission-no').value.trim() || null,
    it_verified: arfReadTriState('arf-it-verified'),
    estimate_checked_by: arfResolveStaffField('arf-estimate-checked-by', 'arf-estimate-checked-by-other'),
    estimate_verified: arfReadTriState('arf-estimate-verified'),
    tax_clearance: document.getElementById('arf-tax-clearance').checked,
    tax_clearance_date: document.getElementById('arf-tax-clearance').checked
      ? (document.getElementById('arf-tax-clearance-date').value || null) : null,
    remarks: document.getElementById('arf-remarks').value.trim() || null,
    updated_by: arfUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'arf-drawer-status');
  try {
    if (arfEditingId) {
      const { error } = await window.sb.from('audit_report_finalization').update(payload).eq('id', arfEditingId);
      if (error) throw error;
      AuditLog.record('arf_updated', { module: 'auditReportFinalization', clientName, recordRef: arfEditingId, detail: { fiscalYear } });
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('audit_report_finalization').insert(payload).select('id').single();
      if (error) throw error;
      AuditLog.record('arf_created', { module: 'auditReportFinalization', clientName, recordRef: data.id, detail: { fiscalYear } });
    }
    arfCloseEntry();
    await arfRefresh();
    arfStatusMsg('✅ Record saved.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'arf-drawer-status');
  }
}

function arfReadTriState(selectId) {
  const v = document.getElementById(selectId).value;
  return v === 'true' ? true : v === 'false' ? false : null;
}

async function arfDeleteEntry(row) {
  if (!confirm(`Delete the ${row.fiscal_year} record for ${row.client_name || 'this client'}? This cannot be undone.`)) return;
  const { error } = await window.sb.from('audit_report_finalization').delete().eq('id', row.id);
  if (error) { arfStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('arf_deleted', { module: 'auditReportFinalization', clientName: row.client_name, recordRef: row.id });
  await arfRefresh();
}

// ── Print / Export ──
function arfBuildModel(rows, titleSuffix) {
  return {
    title: 'Audit Report Finalization' + (titleSuffix ? ' — ' + titleSuffix : ''),
    subtitleLines: [`Generated ${arfToday()}`],
    columns: [
      { label: 'FY', w: 0.9 }, { label: 'Client', w: 2 }, { label: 'PAN', w: 1 },
      { label: 'Auditor', w: 1.6 }, { label: 'IT Entered By', w: 1.3 }, { label: 'IT Submission No.', w: 1.3 },
      { label: 'IT Status', w: 1.2 }, { label: 'Estimate Checked By', w: 1.3 }, { label: 'Estimate Status', w: 1.2 },
      { label: 'Tax Clearance', w: 1 }, { label: 'Tax Clearance Date', w: 1.1 }, { label: 'Remarks', w: 1.8 },
    ],
    rows: rows.map(r => ({ cells: [
      r.fiscal_year, r.client_name, r.client_pan,
      r.auditor, r.it_entered_by, r.it_submission_no,
      ARF_IT_STATUSES[arfItStatusKey(r)].label,
      r.estimate_checked_by, ARF_ESTIMATE_STATUSES[arfEstimateStatusKey(r)].label,
      r.tax_clearance ? 'Yes' : 'No', r.tax_clearance_date,
      r.remarks,
    ] })),
    _filename: 'Audit Report Finalization' + (titleSuffix ? ' - ' + titleSuffix : ''),
  };
}

function arfOpenPrintWindow(model) {
  const w = window.open('', '_blank');
  if (!w) { arfStatusMsg('Allow pop-ups to print.', 'info'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(model.title)}</title>
    <style>body{font-family:Inter,Arial,sans-serif;margin:28px;color:#1a202c;}
    table{border-collapse:collapse;width:100%;font-size:11px;}
    th,td{border:1px solid #d9dce5;padding:5px 8px;}
    th{background:#f3f5fb;color:#0b1f3d;}
    @page{size:A4 landscape;margin:14mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('arf_printed', { module: 'auditReportFinalization' });
}

function arfPreviewAll() {
  arfReadFilters();
  arfLastModel = arfBuildModel(arfCurrentFilteredRows());
  arfOpenPrintWindow(arfLastModel);
}

function arfPrintOne(row) {
  arfOpenPrintWindow(arfBuildModel([row], row.client_name));
}

async function arfExport(kind) {
  arfReadFilters();
  const rows = arfCurrentFilteredRows();
  if (!rows.length) { arfStatusMsg('Nothing to export for the current filters.', 'info'); return; }
  const model = arfBuildModel(rows);
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'auditReportFinalization', clientName: 'Filtered Records', sheetName: model.title,
    });
  } catch (e) {
    arfStatusMsg('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}
