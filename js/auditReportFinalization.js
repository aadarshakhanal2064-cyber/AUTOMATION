// ════════════════════════════════════════════
//  AUDIT REPORT FINALIZATION
//  A shared status tracker (sidebar module, own top-level nav item) for
//  where a client's IT return, estimate return and tax clearance stand for
//  a fiscal year. NOT tied to document generation — pure task tracking.
//
//  ONE RECORD PER (client, fiscal year, RETURN TYPE). The three tracks are
//  separate pieces of work entered by different staff at different times,
//  so each gets its own row and its own independent status; a client can
//  hold an IT Return record, an Estimate Return record and a Tax Clearance
//  record for the same year. The UNIQUE constraint enforces the triple, and
//  arfFindExisting() routes the form into editing a match rather than
//  letting a save collide with it.
//
//  Status is DERIVED, never stored — arfStatusKey() reads the raw columns
//  of whichever track the row belongs to, and that one function feeds the
//  badge, the filters, the chart and the export text, so none of them can
//  drift apart from what was actually saved.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'auditReportFinalization', group: 'main', buttonId: 'nav-auditReportFinalization', panelId: 'tab-auditReportFinalization-panel' });

const ARF_STATUSES = {
  not_submitted: { label: 'Not Submitted', icon: '⬜', badgeClass: 'badge-neutral' },
  submitted:     { label: 'Submitted',     icon: '📤', badgeClass: 'badge-amber' },
  verified:      { label: 'Verified',      icon: '✅', badgeClass: 'badge-sent' },
  not_verified:  { label: 'Not Verified',  icon: '❌', badgeClass: 'badge-error' },
};

// Tax clearance is obtained or not — "verified" reads wrong for it, so that
// track relabels the same two keys it can reach.
const ARF_TAX_LABELS = { verified: 'Cleared', not_verified: 'Not Cleared', not_submitted: 'Not Recorded' };

const arfFlow = WorkflowEngine.createStatusFlow({ statuses: ARF_STATUSES, onTransition: r => r });

const ARF_TYPE_BADGES = {
  it_return:       'badge-blue',
  estimate_return: 'badge-purple',
  tax_clearance:   'badge-yellow',
};

const ARF_FY_START = 2077;
const ARF_FY_END = 2085;
const ARF_FY_DEFAULT = '2082/83';
const ARF_SUBMISSION_DIGITS = 12;

// Stat cards double as quick filters. Each one clears the dropdown filters
// before applying, so a card always shows the count it advertises.
const ARF_FILTERS = {
  all:         { label: 'Total Records',          test: () => true },
  itVerified:  { label: 'IT Verified',            test: r => r.return_type === 'it_return' && arfStatusKey(r) === 'verified' },
  itNotVer:    { label: 'IT Not Verified',        test: r => r.return_type === 'it_return' && arfStatusKey(r) === 'not_verified' },
  estVerified: { label: 'Estimate Verified',      test: r => r.return_type === 'estimate_return' && arfStatusKey(r) === 'verified' },
  estNotVer:   { label: 'Estimate Not Verified',  test: r => r.return_type === 'estimate_return' && arfStatusKey(r) === 'not_verified' },
  taxCleared:  { label: 'Tax Cleared',            test: r => r.return_type === 'tax_clearance' && r.tax_clearance === true },
  taxNotClear: { label: 'Tax Not Cleared',        test: r => r.return_type === 'tax_clearance' && r.tax_clearance !== true },
};

const ARF_FILTERS_EMPTY = { auditor: '', fiscalYear: '', returnType: '', status: '', from: '', to: '' };

let arfRecords = [];
let arfTable = null;
let arfChart = null;
let arfSelectedClient = null;
let arfEditingId = null;
// True when arfEditingId came from the (client, FY, type) auto-match rather
// than the user pressing Edit. An auto-match must be re-evaluated whenever a
// key field changes; an explicit edit must not be pulled out from under them.
let arfAutoMatched = false;
// Set while the drawer is being populated, so the key-field watcher doesn't
// fire on the writes that populating performs.
let arfSuppressKeyWatch = false;
let arfActiveFilter = 'all';
let arfInitDone = false;
let arfFilters = { ...ARF_FILTERS_EMPTY };

function arfUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function arfStatusMsg(html, type) { showStatus(html, type, 'arf-status-area'); }
function arfToday() { return new Date().toISOString().slice(0, 10); }
function arfEl(id) { return document.getElementById(id); }

function arfFyLabel(startYear) { return startYear + '/' + String((startYear + 1) % 100).padStart(2, '0'); }
function arfFyOptions() {
  const opts = [];
  for (let y = ARF_FY_END; y >= ARF_FY_START; y--) opts.push(arfFyLabel(y));
  return opts;
}

function arfTypeLabel(key) {
  const t = (window.ARF_RETURN_TYPES || []).find(x => x.key === key);
  return t ? t.label : (key || '—');
}

// ── Derived status (never stored — see header note) ──
function arfStatusKey(row) {
  if (row.return_type === 'tax_clearance') {
    return row.tax_clearance === true ? 'verified' : 'not_verified';
  }
  if (row.return_type === 'estimate_return') {
    if (row.estimate_verified === true) return 'verified';
    if (row.estimate_verified === false) return 'not_verified';
    if ((row.estimate_submission_no || '').trim() || (row.estimate_entered_by || '').trim()) return 'submitted';
    return 'not_submitted';
  }
  if (row.it_verified === true) return 'verified';
  if (row.it_verified === false) return 'not_verified';
  if ((row.it_submission_no || '').trim() || (row.it_entered_by || '').trim()) return 'submitted';
  return 'not_submitted';
}

function arfStatusLabel(row) {
  const key = arfStatusKey(row);
  if (row.return_type === 'tax_clearance') return ARF_TAX_LABELS[key] || ARF_STATUSES[key].label;
  return ARF_STATUSES[key].label;
}

function arfStatusBadge(row) {
  const key = arfStatusKey(row);
  const meta = ARF_STATUSES[key];
  return `<span class="log-badge ${meta.badgeClass}">${meta.icon} ${escHtml(arfStatusLabel(row))}</span>`;
}

// Whichever of the two staff columns applies to this row's track.
function arfRowEnteredBy(row) {
  return row.return_type === 'estimate_return' ? row.estimate_entered_by : row.it_entered_by;
}
function arfRowSubmissionNo(row) {
  return row.return_type === 'estimate_return' ? row.estimate_submission_no : row.it_submission_no;
}

// ── Init & load ──
function arfInit() {
  if (!arfInitDone) {
    SearchEngine.attachAutocomplete(arfEl('arf-client-search'), arfEl('arf-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: arfSelectClient,
    });
    arfPopulateStaticDropdowns();
    arfAttachDigitGuards();
    arfInitDone = true;
  }
  arfRefresh();
}

function arfPopulateStaticDropdowns() {
  const auditors = window.ARF_AUDITORS.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');
  arfEl('arf-auditor').innerHTML = '<option value="">Select…</option>' + auditors;
  arfEl('arf-filter-auditor').innerHTML = '<option value="">All Auditors</option>' +
    window.ARF_AUDITORS.filter(a => a !== 'Other').map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');

  const staff = window.ARF_STAFF.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  ['arf-it-entered-by', 'arf-it-checked-by', 'arf-estimate-entered-by'].forEach(id => {
    arfEl(id).innerHTML = '<option value="">Select…</option>' + staff;
  });

  arfEl('arf-it-return-type').innerHTML = '<option value="">Select…</option>' +
    window.ARF_IT_RETURN_TYPES.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');

  const fyOpts = arfFyOptions().map(fy => `<option value="${fy}">${fy}</option>`).join('');
  arfEl('arf-fiscal-year').innerHTML = fyOpts;
  arfEl('arf-fiscal-year').value = ARF_FY_DEFAULT;
  arfEl('arf-filter-fy').innerHTML = '<option value="">All Years</option>' + fyOpts;

  arfEl('arf-filter-type').innerHTML = '<option value="">All Types</option>' +
    window.ARF_RETURN_TYPES.map(t => `<option value="${t.key}">${escHtml(t.label)}</option>`).join('');
  arfEl('arf-filter-status').innerHTML = '<option value="">All Statuses</option>' +
    Object.entries(ARF_STATUSES).map(([k, m]) => `<option value="${k}">${escHtml(m.label)}</option>`).join('');
}

// Submission numbers are exactly 12 digits — strip anything else as it's
// typed rather than letting a bad value reach the DB CHECK and surface as a
// raw Postgres error.
function arfAttachDigitGuards() {
  ['arf-it-submission-no', 'arf-estimate-submission-no'].forEach(id => {
    arfEl(id).addEventListener('input', e => {
      const cleaned = e.target.value.replace(/\D/g, '').slice(0, ARF_SUBMISSION_DIGITS);
      if (e.target.value !== cleaned) e.target.value = cleaned;
      arfUpdateDigitHint(id);
    });
  });
}

function arfUpdateDigitHint(inputId) {
  const el = arfEl(inputId);
  const hint = arfEl(inputId + '-hint');
  if (!hint) return;
  const len = (el.value || '').length;
  if (!len) { hint.textContent = `${ARF_SUBMISSION_DIGITS} digits`; hint.style.color = 'var(--text-faint)'; return; }
  const ok = len === ARF_SUBMISSION_DIGITS;
  hint.textContent = ok ? `✓ ${len}/${ARF_SUBMISSION_DIGITS}` : `${len}/${ARF_SUBMISSION_DIGITS} digits`;
  hint.style.color = ok ? 'var(--green-dk)' : 'var(--red-dk)';
}

async function arfRefresh() {
  arfStatusMsg('<span class="spinner spinner-navy"></span> Loading records…', 'searching');
  try {
    // Newest work first — the date filter's whole point is "what did we get
    // through recently", so the default order should already answer that.
    arfRecords = await sbFetchAll(() => window.sb.from('audit_report_finalization')
      .select('*').order('recorded_date', { ascending: false }).order('client_name', { ascending: true }));
    arfRenderStats();
    arfRenderTable();
    arfEl('arf-status-area').innerHTML = '';
  } catch (e) {
    arfStatusMsg('❌ Failed to load records: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Stat cards (also the quick filters) ──
function arfRenderStats() {
  const grid = arfEl('arf-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(ARF_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${arfActiveFilter === key ? 'active-filter' : ''}" onclick="arfSetFilter('${key}')" title="Show only these — clears the filters below">
      <div class="stat-num">${arfRecords.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

// A card is a fresh start: its number counts the whole portfolio, so leaving
// stale dropdown filters applied would show fewer rows than the card claims.
function arfSetFilter(key) {
  arfActiveFilter = key;
  arfResetFilterInputs();
  arfRenderStats();
  arfApplyFilters();
}

function arfResetFilterInputs() {
  ['arf-filter-auditor', 'arf-filter-fy', 'arf-filter-type', 'arf-filter-status',
   'arf-filter-from', 'arf-filter-to', 'arf-search'].forEach(id => {
    const el = arfEl(id); if (el) el.value = '';
  });
  arfFilters = { ...ARF_FILTERS_EMPTY };
}

// ── Overview chart ──
function arfRenderChart(rows) {
  const el = arfEl('arf-chart');
  if (!el || !window.Chart) return;
  if (arfChart) { arfChart.destroy(); arfChart = null; }

  const bucket = (type, key) => rows.filter(r => r.return_type === type && arfStatusKey(r) === key).length;
  const pending = type => rows.filter(r => r.return_type === type && ['not_submitted', 'submitted'].includes(arfStatusKey(r))).length;

  arfChart = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['IT Return', 'Estimate Return', 'Tax Clearance'],
      datasets: [
        { label: 'Verified / Cleared', backgroundColor: '#10b981',
          data: [bucket('it_return', 'verified'), bucket('estimate_return', 'verified'), bucket('tax_clearance', 'verified')] },
        { label: 'Not Verified / Not Cleared', backgroundColor: '#ef4444',
          data: [bucket('it_return', 'not_verified'), bucket('estimate_return', 'not_verified'), bucket('tax_clearance', 'not_verified')] },
        { label: 'Pending', backgroundColor: '#f59e0b',
          data: [pending('it_return'), pending('estimate_return'), 0] },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

// ── List table ──
function arfRenderTable() {
  const wrap = arfEl('arf-table-wrap');
  if (arfTable) { arfTable.destroy(); arfTable = null; }
  if (!arfRecords.length) {
    wrap.innerHTML = '<div class="log-empty">No records yet. Click <strong>New Record</strong> to track a client\'s finalization status.</div>';
    arfRenderChart([]);
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
      { title: 'Client', field: 'client_name', minWidth: 180, formatter: c => {
          const r = c.getRow().getData();
          return escHtml(r.client_name || '—') + (r.client_pan ? `<br><span style="color:var(--text-faint); font-size:12px;">PAN ${escHtml(r.client_pan)}</span>` : '');
        } },
      { title: 'Type', field: 'return_type', width: 145, formatter: c => {
          const r = c.getRow().getData();
          const extra = r.return_type === 'it_return' && r.it_return_type ? ` ${escHtml(r.it_return_type)}` : '';
          return `<span class="log-badge ${ARF_TYPE_BADGES[r.return_type] || 'badge-neutral'}">${escHtml(arfTypeLabel(r.return_type))}${extra}</span>`;
        } },
      { title: 'Auditor', field: 'auditor', minWidth: 160, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Entered By', field: 'it_entered_by', minWidth: 120, headerSort: false, formatter: c => escHtml(arfRowEnteredBy(c.getRow().getData()) || '—') },
      { title: 'Checked By', field: 'it_checked_by', minWidth: 120, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Submission No.', field: 'it_submission_no', minWidth: 140, headerSort: false, formatter: c => escHtml(arfRowSubmissionNo(c.getRow().getData()) || '—') },
      { title: 'Status', field: 'id', width: 140, headerSort: false, formatter: c => arfStatusBadge(c.getRow().getData()) },
      { title: 'Recorded', field: 'recorded_date', width: 115, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 190, formatter: c => arfRowActions(),
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

function arfRowActions() {
  const btn = (a, label) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('print', 'Print')}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function arfReadFilters() {
  arfFilters = {
    auditor: arfEl('arf-filter-auditor').value,
    fiscalYear: arfEl('arf-filter-fy').value,
    returnType: arfEl('arf-filter-type').value,
    status: arfEl('arf-filter-status').value,
    from: arfEl('arf-filter-from').value,
    to: arfEl('arf-filter-to').value,
  };
}

function arfCurrentFilteredRows() {
  const cardTest = ARF_FILTERS[arfActiveFilter].test;
  let rows = arfRecords.filter(r => {
    if (!cardTest(r)) return false;
    if (arfFilters.auditor && r.auditor !== arfFilters.auditor) return false;
    if (arfFilters.fiscalYear && r.fiscal_year !== arfFilters.fiscalYear) return false;
    if (arfFilters.returnType && r.return_type !== arfFilters.returnType) return false;
    if (arfFilters.status && arfStatusKey(r) !== arfFilters.status) return false;
    // ISO dates compare correctly as strings, so no Date parsing needed.
    if (arfFilters.from && (r.recorded_date || '') < arfFilters.from) return false;
    if (arfFilters.to && (r.recorded_date || '') > arfFilters.to) return false;
    return true;
  });
  const q = (arfEl('arf-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['client_name', 'client_pan', 'it_submission_no', 'estimate_submission_no', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function arfApplyFilters() {
  const rows = arfCurrentFilteredRows();
  arfRenderChart(rows);
  if (arfTable) arfTable.replaceData(rows);
}

function arfOnFilterChange() { arfReadFilters(); arfApplyFilters(); }

function arfClearFilters() {
  arfResetFilterInputs();
  arfActiveFilter = 'all';
  arfRenderStats();
  arfApplyFilters();
}

// ── Entry drawer ──
function arfSelectClient(c) {
  arfSelectedClient = c;
  arfEl('arf-client-search').value = c.name;
  arfEl('arf-client-pan').value = c.pan || '';
  arfOnKeyFieldChange();
}

function arfCurrentType() {
  const checked = document.querySelector('input[name="arf-return-type"]:checked');
  return checked ? checked.value : 'it_return';
}

function arfOnTypeChange() {
  const type = arfCurrentType();
  arfEl('arf-section-it').style.display = type === 'it_return' ? '' : 'none';
  arfEl('arf-section-estimate').style.display = type === 'estimate_return' ? '' : 'none';
  arfEl('arf-section-tax').style.display = type === 'tax_clearance' ? '' : 'none';
  document.querySelectorAll('.arf-type-option').forEach(el => {
    el.classList.toggle('active', el.dataset.type === type);
  });
  arfOnKeyFieldChange();
}

// One record per (client, fiscal year, return type): as soon as all three are
// known, load a matching record for editing rather than letting a save
// collide with the UNIQUE constraint.
function arfFindExisting(clientId, fy, type) {
  return arfRecords.find(r => r.client_id === clientId && r.fiscal_year === fy && r.return_type === type);
}

// Any key field changing means both "which record am I on?" and "what does
// this client's chain look like?" need recomputing. The banner renders even
// while the matcher is suppressed, since it only reads state.
function arfOnKeyFieldChange() {
  arfMatchExistingRecord();
  arfRenderChainBanner();
}

// Re-evaluated on every key-field change (client, fiscal year, return type),
// because changing any of the three changes WHICH record you are on. An
// auto-matched record that no longer matches is released back to a new one,
// otherwise switching return type would keep editing the previous track's row.
function arfMatchExistingRecord() {
  if (arfSuppressKeyWatch) return;
  if (arfEditingId && !arfAutoMatched) return;   // explicit Edit — leave it alone

  const fy = arfEl('arf-fiscal-year').value;
  const existing = (arfSelectedClient && fy)
    ? arfFindExisting(arfSelectedClient.id, fy, arfCurrentType())
    : null;

  if (existing) {
    if (existing.id === arfEditingId) return;
    arfLoadIntoDrawer(existing, true);
    arfAutoMatched = true;
    showStatus('Editing this client\'s existing record for that year and return type.', 'info', 'arf-drawer-status');
  } else if (arfAutoMatched) {
    arfClearTrackFields();
    arfEditingId = null;
    arfAutoMatched = false;
    arfEl('arf-drawer-title').textContent = 'New Record';
    arfEl('arf-drawer-status').innerHTML = '';
  }
}

// The per-track fields plus remarks — everything that belongs to the record
// rather than to the client/year/auditor selection above it.
function arfClearTrackFields() {
  arfSuppressKeyWatch = true;
  arfEl('arf-it-return-type').value = '';
  arfEl('arf-it-submission-no').value = '';
  arfEl('arf-it-verified').value = '';
  arfEl('arf-estimate-submission-no').value = '';
  arfEl('arf-estimate-verified').value = '';
  ['arf-it-entered-by', 'arf-it-checked-by', 'arf-estimate-entered-by'].forEach(id => {
    arfEl(id).value = '';
    arfEl(id + '-other').value = '';
    arfEl(id + '-other-group').style.display = 'none';
  });
  arfEl('arf-tax-clearance').value = 'false';
  arfOnTaxClearanceChange();
  arfEl('arf-tax-reason').value = '';
  arfEl('arf-remarks').value = '';
  arfUpdateDigitHint('arf-it-submission-no');
  arfUpdateDigitHint('arf-estimate-submission-no');
  arfSuppressKeyWatch = false;
}

function arfResolveStaffField(selectId, otherId) {
  const sel = arfEl(selectId).value;
  if (sel === 'Other') return arfEl(otherId).value.trim() || null;
  return sel || null;
}

function arfOnStaffChange(selectId, otherGroupId) {
  arfEl(otherGroupId).style.display = arfEl(selectId).value === 'Other' ? '' : 'none';
}

function arfOnTaxClearanceChange() {
  const cleared = arfEl('arf-tax-clearance').value === 'true';
  arfEl('arf-tax-clearance-date-group').style.display = cleared ? '' : 'none';
  arfEl('arf-tax-reason-group').style.display = cleared ? 'none' : '';
  if (cleared) {
    arfEl('arf-tax-reason').value = '';
    if (!arfEl('arf-tax-clearance-date').value) arfEl('arf-tax-clearance-date').value = arfToday();
  } else {
    arfEl('arf-tax-clearance-date').value = '';
  }
}

// Re-show a saved name that isn't one of the fixed options in its "Other" box.
function arfFillStaffField(selectId, otherId, otherGroupId, value, list) {
  const fixed = list.filter(x => x !== 'Other');
  const isOther = !!value && !fixed.includes(value);
  arfEl(selectId).value = isOther ? 'Other' : (value || '');
  arfEl(otherId).value = isOther ? value : '';
  arfEl(otherGroupId).style.display = isOther ? '' : 'none';
}

function arfSetType(type) {
  const radio = document.querySelector(`input[name="arf-return-type"][value="${type}"]`);
  if (radio) radio.checked = true;
  arfOnTypeChange();
}

// Where this client stands across all three tracks for the chosen year — so
// the person filling the form can see what is already done and what is still
// outstanding without leaving the drawer.
function arfRenderChainBanner() {
  const el = arfEl('arf-chain-banner');
  if (!el) return;
  const fy = arfEl('arf-fiscal-year').value;
  if (!arfSelectedClient || !fy) { el.style.display = 'none'; el.innerHTML = ''; return; }

  const current = arfCurrentType();
  el.innerHTML = window.ARF_RETURN_TYPES.map(t => {
    const rec = arfFindExisting(arfSelectedClient.id, fy, t.key);
    const badge = rec
      ? `<span class="log-badge ${ARF_STATUSES[arfStatusKey(rec)].badgeClass}">${ARF_STATUSES[arfStatusKey(rec)].icon} ${escHtml(arfStatusLabel(rec))}</span>`
      : '<span class="log-badge badge-neutral">⬜ Not recorded</span>';
    return `<div class="arf-chain-item${t.key === current ? ' current' : ''}">
        <span class="arf-chain-label">${escHtml(t.label)}</span>${badge}
      </div>`;
  }).join('');
  el.style.display = '';
}

function arfLoadIntoDrawer(existing, keepClientTyped) {
  arfSuppressKeyWatch = true;
  arfEditingId = existing.id;
  arfEl('arf-drawer-title').textContent = `Edit — ${existing.client_name}`;

  if (!keepClientTyped) {
    arfEl('arf-client-search').value = existing.client_name || '';
    arfEl('arf-client-pan').value = existing.client_pan || '';
    arfSelectedClient = (window.clientsList || []).find(c => c.id === existing.client_id) || null;
  }
  arfEl('arf-fiscal-year').value = existing.fiscal_year || ARF_FY_DEFAULT;
  arfEl('arf-recorded-date').value = existing.recorded_date || arfToday();
  arfFillStaffField('arf-auditor', 'arf-auditor-other', 'arf-auditor-other-group', existing.auditor, window.ARF_AUDITORS);
  arfSetType(existing.return_type || 'it_return');

  arfEl('arf-it-return-type').value = existing.it_return_type || '';
  arfEl('arf-it-submission-no').value = existing.it_submission_no || '';
  arfFillStaffField('arf-it-entered-by', 'arf-it-entered-by-other', 'arf-it-entered-by-other-group', existing.it_entered_by, window.ARF_STAFF);
  arfFillStaffField('arf-it-checked-by', 'arf-it-checked-by-other', 'arf-it-checked-by-other-group', existing.it_checked_by, window.ARF_STAFF);
  arfEl('arf-it-verified').value = existing.it_verified === true ? 'true' : existing.it_verified === false ? 'false' : '';

  arfEl('arf-estimate-submission-no').value = existing.estimate_submission_no || '';
  arfFillStaffField('arf-estimate-entered-by', 'arf-estimate-entered-by-other', 'arf-estimate-entered-by-other-group', existing.estimate_entered_by, window.ARF_STAFF);
  arfEl('arf-estimate-verified').value = existing.estimate_verified === true ? 'true' : existing.estimate_verified === false ? 'false' : '';

  arfEl('arf-tax-clearance').value = existing.tax_clearance ? 'true' : 'false';
  arfOnTaxClearanceChange();
  arfEl('arf-tax-clearance-date').value = existing.tax_clearance_date || '';
  arfEl('arf-tax-reason').value = existing.tax_clearance_remarks || '';

  arfEl('arf-remarks').value = existing.remarks || '';
  arfUpdateDigitHint('arf-it-submission-no');
  arfUpdateDigitHint('arf-estimate-submission-no');
  arfSuppressKeyWatch = false;
  arfRenderChainBanner();
}

function arfOpenEntry(existing) {
  arfSuppressKeyWatch = true;
  arfEditingId = null;
  arfAutoMatched = false;
  arfSelectedClient = null;
  arfEl('arf-drawer-title').textContent = existing ? `Edit — ${existing.client_name}` : 'New Record';
  arfEl('arf-drawer-status').innerHTML = '';

  arfEl('arf-client-search').value = '';
  arfEl('arf-client-pan').value = '';
  arfEl('arf-fiscal-year').value = ARF_FY_DEFAULT;
  arfEl('arf-recorded-date').value = arfToday();
  arfEl('arf-auditor').value = '';
  arfEl('arf-auditor-other').value = '';
  arfEl('arf-auditor-other-group').style.display = 'none';
  arfSetType('it_return');

  arfEl('arf-it-return-type').value = '';
  arfEl('arf-it-submission-no').value = '';
  arfEl('arf-it-verified').value = '';
  arfEl('arf-estimate-submission-no').value = '';
  arfEl('arf-estimate-verified').value = '';
  ['arf-it-entered-by', 'arf-it-checked-by', 'arf-estimate-entered-by'].forEach(id => {
    arfEl(id).value = '';
    arfEl(id + '-other').value = '';
    arfEl(id + '-other-group').style.display = 'none';
  });
  arfEl('arf-tax-clearance').value = 'false';
  arfOnTaxClearanceChange();
  arfEl('arf-tax-reason').value = '';
  arfEl('arf-remarks').value = '';
  arfUpdateDigitHint('arf-it-submission-no');
  arfUpdateDigitHint('arf-estimate-submission-no');
  arfSuppressKeyWatch = false;

  // An explicit Edit is never auto-matched, so switching return type inside it
  // edits THIS record rather than jumping to another one.
  if (existing) arfLoadIntoDrawer(existing, false);
  else arfRenderChainBanner();

  arfEl('arf-entry-drawer').classList.add('open');
}

function arfCloseEntry() { arfEl('arf-entry-drawer').classList.remove('open'); }

async function arfSaveEntry() {
  const drawerErr = msg => showStatus(escHtml(msg), 'info', 'arf-drawer-status');
  const clientName = arfEl('arf-client-search').value.trim();
  if (!clientName) { drawerErr('Enter or select a client.'); return; }
  // Keep client_id only while the typed name still matches the picked client
  // — a hand-edited name means no client_id, and this table requires one.
  const clientId = (arfSelectedClient && arfSelectedClient.name === clientName) ? arfSelectedClient.id : null;
  if (!clientId) { drawerErr('Pick a client from the list — this module only tracks directory clients.'); return; }
  const fiscalYear = arfEl('arf-fiscal-year').value;
  if (!fiscalYear) { drawerErr('Choose a fiscal year.'); return; }
  const auditor = arfResolveStaffField('arf-auditor', 'arf-auditor-other');
  if (!auditor) { drawerErr('Choose an auditor.'); return; }

  const type = arfCurrentType();
  // Catches every path into a UNIQUE (client, fiscal year, return type)
  // collision — including changing the type while editing an existing record —
  // so the user sees this instead of a raw Postgres constraint error.
  const clash = arfFindExisting(clientId, fiscalYear, type);
  if (clash && clash.id !== arfEditingId) {
    drawerErr(`${clientName} already has an existing ${arfTypeLabel(type)} record for ${fiscalYear}. Open that record to edit it.`);
    return;
  }

  const itNo = arfEl('arf-it-submission-no').value.trim();
  const estNo = arfEl('arf-estimate-submission-no').value.trim();
  if (type === 'it_return' && itNo && itNo.length !== ARF_SUBMISSION_DIGITS) {
    drawerErr(`IT Submission No. must be exactly ${ARF_SUBMISSION_DIGITS} digits.`); return;
  }
  if (type === 'estimate_return' && estNo && estNo.length !== ARF_SUBMISSION_DIGITS) {
    drawerErr(`Estimate Submission No. must be exactly ${ARF_SUBMISSION_DIGITS} digits.`); return;
  }

  const cleared = arfEl('arf-tax-clearance').value === 'true';
  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: arfEl('arf-client-pan').value.trim() || null,
    fiscal_year: fiscalYear,
    recorded_date: arfEl('arf-recorded-date').value || arfToday(),
    return_type: type,
    auditor,
    it_return_type: type === 'it_return' ? (arfEl('arf-it-return-type').value || null) : null,
    it_submission_no: type === 'it_return' ? (itNo || null) : null,
    it_entered_by: type === 'it_return' ? arfResolveStaffField('arf-it-entered-by', 'arf-it-entered-by-other') : null,
    it_checked_by: type === 'it_return' ? arfResolveStaffField('arf-it-checked-by', 'arf-it-checked-by-other') : null,
    it_verified: type === 'it_return' ? arfReadTriState('arf-it-verified') : null,
    estimate_submission_no: type === 'estimate_return' ? (estNo || null) : null,
    estimate_entered_by: type === 'estimate_return' ? arfResolveStaffField('arf-estimate-entered-by', 'arf-estimate-entered-by-other') : null,
    estimate_verified: type === 'estimate_return' ? arfReadTriState('arf-estimate-verified') : null,
    tax_clearance: type === 'tax_clearance' ? cleared : false,
    tax_clearance_date: type === 'tax_clearance' && cleared ? (arfEl('arf-tax-clearance-date').value || null) : null,
    tax_clearance_remarks: type === 'tax_clearance' && !cleared ? (arfEl('arf-tax-reason').value.trim() || null) : null,
    remarks: arfEl('arf-remarks').value.trim() || null,
    updated_by: arfUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'arf-drawer-status');
  try {
    if (arfEditingId) {
      const { error } = await window.sb.from('audit_report_finalization').update(payload).eq('id', arfEditingId);
      if (error) throw error;
      AuditLog.record('arf_updated', { module: 'auditReportFinalization', clientName, recordRef: arfEditingId, detail: { fiscalYear, returnType: type } });
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('audit_report_finalization').insert(payload).select('id').single();
      if (error) throw error;
      AuditLog.record('arf_created', { module: 'auditReportFinalization', clientName, recordRef: data.id, detail: { fiscalYear, returnType: type } });
    }

    // The IT return's state decides what follow-on work is due — in both
    // directions, so this runs whether it was verified or un-verified.
    let sync = { created: [], removed: [], kept: [] };
    if (type === 'it_return') sync = await arfSyncFollowOns(payload);

    arfCloseEntry();
    await arfRefresh();
    arfStatusMsg(arfChainMessage(sync, clientName), 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'arf-drawer-status');
  }
}

function arfReadTriState(selectId) {
  const v = arfEl(selectId).value;
  return v === 'true' ? true : v === 'false' ? false : null;
}

// ── The finalization chain ──
// The three tracks are sequential in the firm's real workflow: the estimate
// return is only verified AFTER the IT return is, and a D-3 filing additionally
// needs a tax clearance. So the IT return's own state decides what follow-on
// work is DUE, and this keeps the follow-on records in step with it — in both
// directions.
//
// Due rows are created as explicitly NOT verified / NOT cleared (not merely
// blank), because that is the honest state: the work is now outstanding.
//
// The reverse matters just as much. Un-verifying an IT return, or switching it
// from D-3 to D-2, means that follow-on work was never actually due — leaving
// the row behind would report outstanding work the firm doesn't owe. So a row
// for a no-longer-due track is removed and the chain reads "Not recorded"
// again.
//
// The one thing that is never removed is a follow-on somebody has already
// worked on: arfIsUntouchedFollowOn() gates every delete, so a submission
// number, a name, a date or a remark is enough to keep the row. It is then
// reported back as kept rather than silently ignored.
function arfFollowOnTypes(itReturnType) {
  const due = ['estimate_return'];
  if (itReturnType === 'D-3') due.push('tax_clearance');
  return due;
}

// Still exactly as the chain created it — no work has been entered, so the row
// carries no information and is safe to withdraw.
function arfIsUntouchedFollowOn(row) {
  if (row.remarks) return false;
  if (row.return_type === 'estimate_return') {
    return !row.estimate_submission_no && !row.estimate_entered_by && row.estimate_verified === false;
  }
  if (row.return_type === 'tax_clearance') {
    return row.tax_clearance === false && !row.tax_clearance_date && !row.tax_clearance_remarks;
  }
  return false;
}

async function arfSyncFollowOns(base) {
  const due = base.it_verified === true ? arfFollowOnTypes(base.it_return_type) : [];
  const created = [], removed = [], kept = [];

  for (const type of ['estimate_return', 'tax_clearance']) {
    const existing = arfFindExisting(base.client_id, base.fiscal_year, type);

    if (due.includes(type)) {
      if (existing) continue;                       // already open — idempotent
      const payload = {
        client_id: base.client_id,
        client_name: base.client_name,
        client_pan: base.client_pan,
        fiscal_year: base.fiscal_year,
        // The follow-on becomes due today, whatever date the IT return carries.
        recorded_date: arfToday(),
        return_type: type,
        auditor: base.auditor,
        // Outstanding, not merely unfilled — see the note above.
        estimate_verified: type === 'estimate_return' ? false : null,
        tax_clearance: false,
        created_by: arfUserEmail(),
        updated_by: arfUserEmail(),
      };
      const { data, error } = await window.sb.from('audit_report_finalization')
        .insert(payload).select('id').single();
      // 23505 = another staff member created it between our check and this insert.
      if (error) { if (error.code === '23505') continue; throw error; }
      created.push(arfTypeLabel(type));
      AuditLog.record('arf_created', {
        module: 'auditReportFinalization', clientName: base.client_name, recordRef: data.id,
        detail: { fiscalYear: base.fiscal_year, returnType: type, autoCreated: true },
      });

    } else if (existing) {
      if (!arfIsUntouchedFollowOn(existing)) { kept.push(arfTypeLabel(type)); continue; }
      const { error } = await window.sb.from('audit_report_finalization')
        .delete().eq('id', existing.id);
      if (error) throw error;
      removed.push(arfTypeLabel(type));
      AuditLog.record('arf_deleted', {
        module: 'auditReportFinalization', clientName: base.client_name, recordRef: existing.id,
        detail: { fiscalYear: base.fiscal_year, returnType: type, autoRemoved: true },
      });
    }
  }
  return { created, removed, kept };
}

// One sentence describing whatever the chain just did, so the outcome is never
// silent — especially a follow-on kept back because it already holds work.
function arfChainMessage(sync, clientName) {
  const parts = [];
  if (sync.created.length) parts.push(`${sync.created.join(' and ')} now outstanding`);
  if (sync.removed.length) parts.push(`${sync.removed.join(' and ')} no longer outstanding`);
  if (sync.kept.length) parts.push(`${sync.kept.join(' and ')} kept, already has work recorded`);
  if (!parts.length) return '✅ Record saved.';
  // Client name leads: appending it would attach to whichever clause happens to
  // land last, which reads as nonsense once two clauses combine.
  return `✅ Saved — ${escHtml(clientName)}: ${escHtml(parts.join('; '))}`;
}

async function arfDeleteEntry(row) {
  if (!confirm(`Delete the ${arfTypeLabel(row.return_type)} record for ${row.client_name || 'this client'} (${row.fiscal_year})? This cannot be undone.`)) return;
  const { error } = await window.sb.from('audit_report_finalization').delete().eq('id', row.id);
  if (error) { arfStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('arf_deleted', { module: 'auditReportFinalization', clientName: row.client_name, recordRef: row.id });
  await arfRefresh();
}

// ── Print / Export ──
function arfBuildModel(rows, titleSuffix) {
  const subtitles = [`Generated ${arfToday()}`];
  // A printed sheet should say what period it covers, or it's unreadable a
  // month later.
  if (arfFilters.from || arfFilters.to) {
    subtitles.push(`Recorded ${arfFilters.from || 'the beginning'} to ${arfFilters.to || 'today'}`);
  }
  return {
    title: 'Audit Report Finalization' + (titleSuffix ? ' — ' + titleSuffix : ''),
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'Recorded', w: 1 }, { label: 'FY', w: 0.8 }, { label: 'Client', w: 1.9 }, { label: 'PAN', w: 0.95 },
      { label: 'Type', w: 1.15 }, { label: 'IT Form', w: 0.65 }, { label: 'Auditor', w: 1.4 },
      { label: 'Entered By', w: 1.05 }, { label: 'Checked By', w: 1.05 }, { label: 'Submission No.', w: 1.25 },
      { label: 'Status', w: 1.05 }, { label: 'Clearance Date', w: 1.05 }, { label: 'Remarks', w: 1.6 },
    ],
    rows: rows.map(r => ({ cells: [
      r.recorded_date, r.fiscal_year, r.client_name, r.client_pan,
      arfTypeLabel(r.return_type), r.it_return_type, r.auditor,
      arfRowEnteredBy(r), r.it_checked_by, arfRowSubmissionNo(r),
      arfStatusLabel(r), r.tax_clearance_date,
      r.tax_clearance_remarks || r.remarks,
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
    @page{size:A4 landscape;margin:12mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('arf_printed', { module: 'auditReportFinalization' });
}

function arfPreviewAll() {
  arfReadFilters();
  arfOpenPrintWindow(arfBuildModel(arfCurrentFilteredRows()));
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
      module: 'auditReportFinalization', clientName: 'Filtered Records', sheetName: 'Finalization',
    });
  } catch (e) {
    arfStatusMsg('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}
