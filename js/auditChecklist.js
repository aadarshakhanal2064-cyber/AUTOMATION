// ════════════════════════════════════════════
//  AUDIT CHECKLIST
//  A per-client, per-fiscal-year QC sign-off sheet run before an audit
//  report is finalized (sidebar module, own top-level nav item, next to
//  Audit Report Finalization). Digitizes the paper checklist staff used to
//  fill by hand: a fixed list of items (P.Y figures tallied, bank balances,
//  annexures, etc.), each ticked off and attributed to whoever checked it,
//  plus any number of ad-hoc custom items.
//
//  ONE RECORD PER (client, fiscal year) — one QC pass per client per year,
//  unlike Audit Report Finalization's per-return-type split, because this is
//  a single pass rather than three independently-timed pieces of work. The
//  UNIQUE constraint enforces it, and achkMatchExistingRecord() routes the
//  form into editing a match the moment both client and year are picked, so
//  a save never collides with it in normal use.
//
//  items IS A JSONB ARRAY, not one column per checklist item — the fixed
//  list can grow without a migration, and user-added custom items are
//  inherently variable-shape. Every client gets the full fixed list, every
//  item unchecked, on a brand-new record — a VAT-only subset was tried and
//  dropped (see achkBuildFreshItems) since most clients aren't VAT-active
//  and would never have seen those two items at all.
//
//  Status (Not Started / In Progress / Complete) is DERIVED from items[]
//  in achkStatusKey() — never stored — so the table badge, the stat cards
//  and the export text can't drift apart from what was actually ticked.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'auditChecklist', group: 'main', buttonId: 'nav-auditChecklist', panelId: 'tab-auditChecklist-panel' });

const ACHK_STATUSES = {
  not_started: { label: 'Not Started', icon: '⬜', badgeClass: 'badge-neutral' },
  in_progress: { label: 'In Progress', icon: '🟡', badgeClass: 'badge-amber' },
  complete:    { label: 'Complete',    icon: '✅', badgeClass: 'badge-sent' },
};

const ACHK_FY_START = 2077;
const ACHK_FY_END = 2085;
// Reads window.FY_DEFAULT_START (config.js) — see that constant's comment.
const ACHK_FY_DEFAULT = achkFyLabel(window.FY_DEFAULT_START);

// Stat cards double as quick filters — same ARF/File Management idiom.
const ACHK_FILTERS = {
  all:        { label: 'Total Checklists', test: () => true },
  complete:   { label: 'Complete',         test: r => achkStatusKey(r) === 'complete' },
  inProgress: { label: 'In Progress',      test: r => achkStatusKey(r) === 'in_progress' },
  notStarted: { label: 'Not Started',      test: r => achkStatusKey(r) === 'not_started' },
};

const ACHK_FILTERS_EMPTY = { fiscalYear: '', status: '', from: '', to: '' };

let achkRecords = [];
let achkTable = null;
let achkSelectedClient = null;
let achkEditingId = null;
// The items[] array for whichever record is currently open in the drawer —
// the working state the item rows read from and write into.
let achkItems = [];
let achkCustomSeq = 0;
// True when achkEditingId came from the (client, FY) auto-match rather than
// the user pressing Edit — same ARF distinction: an auto-match is
// re-evaluated on every key-field change, an explicit edit is left alone.
let achkAutoMatched = false;
// Set while the drawer is being populated, so the key-field watcher doesn't
// fire on the writes that populating performs.
let achkSuppressKeyWatch = false;
let achkActiveFilter = 'all';
let achkInitDone = false;
let achkFilters = { ...ACHK_FILTERS_EMPTY };

function achkUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function achkStatusMsg(html, type) { showStatus(html, type, 'achk-status-area'); }
function achkToday() { return new Date().toISOString().slice(0, 10); }
function achkEl(id) { return document.getElementById(id); }

function achkFyLabel(startYear) { return startYear + '/' + String((startYear + 1) % 100).padStart(2, '0'); }
function achkFyOptions() {
  const opts = [];
  for (let y = ACHK_FY_END; y >= ACHK_FY_START; y--) opts.push(achkFyLabel(y));
  return opts;
}

// ── Derived status & progress (never stored — see header note) ──
function achkProgress(row) {
  const items = row.items || [];
  return { checked: items.filter(i => i.checked).length, total: items.length };
}

function achkStatusKey(row) {
  const { checked, total } = achkProgress(row);
  if (!total || checked === 0) return 'not_started';
  if (checked === total) return 'complete';
  return 'in_progress';
}

function achkStatusBadge(row) {
  const meta = ACHK_STATUSES[achkStatusKey(row)];
  return `<span class="log-badge ${meta.badgeClass}">${meta.icon} ${escHtml(meta.label)}</span>`;
}

// ── Init & load ──
function achkInit() {
  if (!achkInitDone) {
    SearchEngine.attachAutocomplete(achkEl('achk-client-search'), achkEl('achk-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: achkSelectClient,
    });
    achkPopulateStaticDropdowns();
    achkInitDone = true;
  }
  achkRefresh();
}

function achkPopulateStaticDropdowns() {
  const fyOpts = achkFyOptions().map(fy => `<option value="${fy}">${fy}</option>`).join('');
  achkEl('achk-fiscal-year').innerHTML = fyOpts;
  achkEl('achk-fiscal-year').value = ACHK_FY_DEFAULT;
  achkEl('achk-filter-fy').innerHTML = '<option value="">All Years</option>' + fyOpts;
  achkEl('achk-filter-status').innerHTML = '<option value="">All Statuses</option>' +
    Object.entries(ACHK_STATUSES).map(([k, m]) => `<option value="${k}">${escHtml(m.label)}</option>`).join('');
}

async function achkRefresh() {
  achkStatusMsg('<span class="spinner spinner-navy"></span> Loading checklists…', 'searching');
  try {
    // Newest work first — same rationale as ARF: the date filter's whole
    // point is "what did we get through recently".
    achkRecords = await sbFetchAll(() => window.sb.from('audit_checklists')
      .select('*').order('recorded_date', { ascending: false }).order('client_name', { ascending: true }));
    achkRenderStats();
    achkRenderTable();
    achkEl('achk-status-area').innerHTML = '';
  } catch (e) {
    achkStatusMsg('❌ Failed to load checklists: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Stat cards (also the quick filters) ──
function achkRenderStats() {
  const grid = achkEl('achk-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(ACHK_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${achkActiveFilter === key ? 'active-filter' : ''}" onclick="achkSetFilter('${key}')" title="Show only these — clears the filters below">
      <div class="stat-num">${achkRecords.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

// A card is a fresh start: its number counts the whole portfolio, so leaving
// stale dropdown filters applied would show fewer rows than the card claims.
function achkSetFilter(key) {
  achkActiveFilter = key;
  achkResetFilterInputs();
  achkRenderStats();
  achkApplyFilters();
}

function achkResetFilterInputs() {
  ['achk-filter-fy', 'achk-filter-status', 'achk-filter-from', 'achk-filter-to', 'achk-search'].forEach(id => {
    const el = achkEl(id); if (el) el.value = '';
  });
  achkFilters = { ...ACHK_FILTERS_EMPTY };
}

// ── List table ──
function achkRenderTable() {
  const wrap = achkEl('achk-table-wrap');
  if (achkTable) { achkTable.destroy(); achkTable = null; }
  if (!achkRecords.length) {
    wrap.innerHTML = '<div class="log-empty">No checklists yet. Click <strong>New Checklist</strong> to start one.</div>';
    return;
  }
  wrap.innerHTML = '';
  achkTable = TableEngine.createTable(wrap, {
    data: achkRecords,
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
      { title: 'Progress', field: 'id', width: 100, headerSort: false, formatter: c => {
          const { checked, total } = achkProgress(c.getRow().getData());
          return `<strong>${checked}/${total}</strong>`;
        } },
      { title: 'Status', field: 'id', width: 140, headerSort: false, formatter: c => achkStatusBadge(c.getRow().getData()) },
      { title: 'Recorded', field: 'recorded_date', width: 115, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 190, formatter: () => achkRowActions(),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') achkOpenEntry(row);
          else if (btn.dataset.action === 'print') achkPrintOne(row);
          else if (btn.dataset.action === 'delete') achkDeleteEntry(row);
        } },
    ],
  });
  achkApplyFilters();
}

function achkRowActions() {
  const btn = (a, label) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('print', 'Print')}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function achkReadFilters() {
  achkFilters = {
    fiscalYear: achkEl('achk-filter-fy').value,
    status: achkEl('achk-filter-status').value,
    from: achkEl('achk-filter-from').value,
    to: achkEl('achk-filter-to').value,
  };
}

function achkCurrentFilteredRows() {
  const cardTest = ACHK_FILTERS[achkActiveFilter].test;
  let rows = achkRecords.filter(r => {
    if (!cardTest(r)) return false;
    if (achkFilters.fiscalYear && r.fiscal_year !== achkFilters.fiscalYear) return false;
    if (achkFilters.status && achkStatusKey(r) !== achkFilters.status) return false;
    // ISO dates compare correctly as strings, so no Date parsing needed.
    if (achkFilters.from && (r.recorded_date || '') < achkFilters.from) return false;
    if (achkFilters.to && (r.recorded_date || '') > achkFilters.to) return false;
    return true;
  });
  const q = (achkEl('achk-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['client_name', 'client_pan', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function achkApplyFilters() {
  const rows = achkCurrentFilteredRows();
  if (achkTable) achkTable.replaceData(rows);
}

function achkOnFilterChange() { achkReadFilters(); achkApplyFilters(); }

function achkClearFilters() {
  achkResetFilterInputs();
  achkActiveFilter = 'all';
  achkRenderStats();
  achkApplyFilters();
}

// ── Entry drawer ──
function achkSelectClient(c) {
  achkSelectedClient = c;
  achkEl('achk-client-search').value = c.name;
  achkEl('achk-client-pan').value = c.pan || '';
  achkOnKeyFieldChange();
}

function achkFindExisting(clientId, fy) {
  return achkRecords.find(r => r.client_id === clientId && r.fiscal_year === fy);
}

// Every client gets the full fixed template, every item explicitly
// unchecked — a brand-new checklist never starts with anything pre-ticked.
function achkBuildFreshItems() {
  return window.AQC_CHECKLIST_ITEMS
    .map(t => ({ key: t.key, label: t.label, checked: false, checked_by: '', custom: false }));
}

// Client or fiscal year changing means "which record am I on?" needs
// recomputing — same ARF idea, minus the return-type dimension.
function achkOnKeyFieldChange() { achkMatchExistingRecord(); }

function achkMatchExistingRecord() {
  if (achkSuppressKeyWatch) return;
  if (achkEditingId && !achkAutoMatched) return;   // explicit Edit — leave it alone

  const fy = achkEl('achk-fiscal-year').value;
  const existing = (achkSelectedClient && fy) ? achkFindExisting(achkSelectedClient.id, fy) : null;

  if (existing) {
    if (existing.id === achkEditingId) return;
    achkLoadIntoDrawer(existing, true);
    achkAutoMatched = true;
    showStatus('Editing this client’s existing checklist for that year.', 'info', 'achk-drawer-status');
  } else if (achkSelectedClient) {
    achkEditingId = null;
    achkAutoMatched = false;
    achkItems = achkBuildFreshItems();
    achkRenderItems();
    achkEl('achk-drawer-title').textContent = 'New Checklist';
    achkEl('achk-drawer-status').innerHTML = '';
  }
}

// ── Checklist item rows ──
function achkItemIndex(key) { return achkItems.findIndex(i => i.key === key); }

function achkItemRowHtml(item) {
  const fixedStaff = window.AQC_STAFF.filter(s => s !== 'Other');
  // item._other is a transient UI flag (never saved — see achkSaveEntry's
  // explicit field list): selecting "Other" clears checked_by to let the
  // person type a name, so isOther can't be inferred from checked_by alone
  // right after that change — it would read as "not Other" the instant the
  // box that types the name would otherwise appear.
  const isOther = !!item._other || (!!item.checked_by && !fixedStaff.includes(item.checked_by));
  const staffOptions = ['<option value="">Select…</option>'].concat(
    window.AQC_STAFF.map(s => {
      const selected = isOther ? (s === 'Other') : (s === item.checked_by);
      return `<option value="${escHtml(s)}" ${selected ? 'selected' : ''}>${escHtml(s)}</option>`;
    })
  ).join('');

  const labelHtml = item.custom
    ? `<input type="text" class="achk-item-label-input" value="${escHtml(item.label)}" placeholder="Describe this item" oninput="achkOnCustomLabelChange('${item.key}', this.value)" />`
    : `<span class="achk-item-label">${escHtml(item.label)}</span>`;

  const removeBtn = item.custom
    ? `<button type="button" class="btn btn-outline btn-sm achk-item-remove" onclick="achkRemoveCustomItem('${item.key}')" title="Remove item">🗑</button>`
    : '';

  return `
    <div class="achk-item-row${item.checked ? ' checked' : ''}" data-key="${escHtml(item.key)}">
      <label class="checkbox-label achk-item-check">
        <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="achkOnItemToggle('${item.key}', this.checked)" />
      </label>
      ${labelHtml}
      <div class="achk-item-staff">
        <select onchange="achkOnItemStaffChange('${item.key}', this)">${staffOptions}</select>
        <input type="text" class="achk-item-staff-other" style="display:${isOther ? '' : 'none'};" value="${isOther ? escHtml(item.checked_by) : ''}" placeholder="Type name" oninput="achkOnItemStaffOtherChange('${item.key}', this.value)" />
      </div>
      ${removeBtn}
    </div>`;
}

function achkRenderItems() {
  const wrap = achkEl('achk-items-list');
  if (!wrap) return;
  if (!achkItems.length) {
    wrap.innerHTML = '<div class="log-empty" style="padding:14px;">Pick a client above to load its checklist.</div>';
    return;
  }
  wrap.innerHTML = achkItems.map(achkItemRowHtml).join('');
}

function achkOnItemToggle(key, checked) {
  const i = achkItemIndex(key); if (i < 0) return;
  achkItems[i].checked = checked;
  achkRenderItems();
}

function achkOnCustomLabelChange(key, value) {
  const i = achkItemIndex(key); if (i < 0) return;
  achkItems[i].label = value;
}

function achkOnItemStaffChange(key, selectEl) {
  const i = achkItemIndex(key); if (i < 0) return;
  const val = selectEl.value;
  achkItems[i]._other = val === 'Other';
  achkItems[i].checked_by = val === 'Other' ? '' : val;
  achkRenderItems();
}

function achkOnItemStaffOtherChange(key, value) {
  const i = achkItemIndex(key); if (i < 0) return;
  achkItems[i].checked_by = value;
}

// Fully open-ended — no cap, replaces the paper form's bare "Others" tick
// and its two hardcoded blank "Specify others" slots with one mechanism.
function achkAddCustomItem() {
  achkCustomSeq += 1;
  achkItems.push({ key: 'custom-' + Date.now() + '-' + achkCustomSeq, label: '', checked: false, checked_by: '', custom: true });
  achkRenderItems();
  const inputs = achkEl('achk-items-list').querySelectorAll('.achk-item-label-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function achkRemoveCustomItem(key) {
  achkItems = achkItems.filter(i => i.key !== key);
  achkRenderItems();
}

// ── Drawer open/close/load ──
function achkLoadIntoDrawer(existing, keepClientTyped) {
  achkSuppressKeyWatch = true;
  achkEditingId = existing.id;
  achkEl('achk-drawer-title').textContent = `Edit — ${existing.client_name}`;

  if (!keepClientTyped) {
    achkEl('achk-client-search').value = existing.client_name || '';
    achkEl('achk-client-pan').value = existing.client_pan || '';
    achkSelectedClient = (window.clientsList || []).find(c => c.id === existing.client_id) || null;
  }
  achkEl('achk-fiscal-year').value = existing.fiscal_year || ACHK_FY_DEFAULT;
  achkEl('achk-recorded-date').value = existing.recorded_date || achkToday();
  achkEl('achk-remarks').value = existing.remarks || '';

  achkItems = (existing.items || []).map(i => ({ ...i }));
  achkRenderItems();
  achkSuppressKeyWatch = false;
}

function achkOpenEntry(existing) {
  achkSuppressKeyWatch = true;
  achkEditingId = null;
  achkAutoMatched = false;
  achkSelectedClient = null;
  achkItems = [];
  achkEl('achk-drawer-title').textContent = existing ? `Edit — ${existing.client_name}` : 'New Checklist';
  achkEl('achk-drawer-status').innerHTML = '';

  achkEl('achk-client-search').value = '';
  achkEl('achk-client-pan').value = '';
  achkEl('achk-fiscal-year').value = ACHK_FY_DEFAULT;
  achkEl('achk-recorded-date').value = achkToday();
  achkEl('achk-remarks').value = '';
  achkRenderItems();
  achkSuppressKeyWatch = false;

  // An explicit Edit is never auto-matched, so changing the fiscal year
  // inside it edits THIS record rather than jumping to another one.
  if (existing) achkLoadIntoDrawer(existing, false);

  achkEl('achk-entry-drawer').classList.add('open');
}

function achkCloseEntry() { achkEl('achk-entry-drawer').classList.remove('open'); }

async function achkSaveEntry() {
  const drawerErr = msg => showStatus(escHtml(msg), 'info', 'achk-drawer-status');
  const clientName = achkEl('achk-client-search').value.trim();
  if (!clientName) { drawerErr('Enter or select a client.'); return; }
  // Keep client_id only while the typed name still matches the picked client
  // — a hand-edited name means no client_id, and this table requires one.
  const clientId = (achkSelectedClient && achkSelectedClient.name === clientName) ? achkSelectedClient.id : null;
  if (!clientId) { drawerErr('Pick a client from the list — this module only tracks directory clients.'); return; }
  const fiscalYear = achkEl('achk-fiscal-year').value;
  if (!fiscalYear) { drawerErr('Choose a fiscal year.'); return; }

  // Catches every path into a UNIQUE (client, fiscal year) collision so the
  // user sees this instead of a raw Postgres constraint error.
  const clash = achkFindExisting(clientId, fiscalYear);
  if (clash && clash.id !== achkEditingId) {
    drawerErr(`${clientName} already has a checklist for ${fiscalYear}. Open that record to edit it.`);
    return;
  }

  if (!achkItems.length) { drawerErr('Nothing to save — pick a client to load the checklist items.'); return; }
  const blankCustom = achkItems.find(i => i.custom && !i.label.trim());
  if (blankCustom) { drawerErr('Give each custom item a name, or remove it.'); return; }

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: achkEl('achk-client-pan').value.trim() || null,
    fiscal_year: fiscalYear,
    recorded_date: achkEl('achk-recorded-date').value || achkToday(),
    items: achkItems.map(i => ({ key: i.key, label: i.label.trim(), checked: !!i.checked, checked_by: (i.checked_by || '').trim(), custom: !!i.custom })),
    remarks: achkEl('achk-remarks').value.trim() || null,
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'achk-drawer-status');
  try {
    if (achkEditingId) {
      // Explicit insert-or-update, not upsert — an upsert would silently
      // overwrite created_by on every edit.
      const { error } = await window.sb.from('audit_checklists').update(payload).eq('id', achkEditingId);
      if (error) throw error;
      AuditLog.record('achk_updated', { module: 'auditChecklist', clientName, recordRef: achkEditingId, detail: { fiscalYear } });
    } else {
      payload.created_by = achkUserEmail();
      const { data, error } = await window.sb.from('audit_checklists').insert(payload).select('id').single();
      if (error) throw error;
      AuditLog.record('achk_created', { module: 'auditChecklist', clientName, recordRef: data.id, detail: { fiscalYear } });
    }
    achkCloseEntry();
    await achkRefresh();
    achkStatusMsg(`✅ Checklist saved for ${escHtml(clientName)}.`, 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'achk-drawer-status');
  }
}

async function achkDeleteEntry(row) {
  if (!confirm(`Delete the checklist for ${row.client_name || 'this client'} (${row.fiscal_year})? This cannot be undone.`)) return;
  const { error } = await window.sb.from('audit_checklists').delete().eq('id', row.id);
  if (error) { achkStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('achk_deleted', { module: 'auditChecklist', clientName: row.client_name, recordRef: row.id });
  await achkRefresh();
}

// ── Export ──
// Items vary in count/shape per record, so the export flattens each row's
// checklist into two readable text cells rather than one column per item.
function achkItemsSummary(row, wantChecked) {
  const items = row.items || [];
  const matched = items.filter(i => !!i.checked === wantChecked);
  if (!matched.length) return '—';
  return matched.map(i => wantChecked && i.checked_by ? `${i.label} (${i.checked_by})` : i.label).join('; ');
}

function achkBuildModel(rows, titleSuffix) {
  const subtitles = [`Generated ${achkToday()}`];
  if (achkFilters.from || achkFilters.to) {
    subtitles.push(`Recorded ${achkFilters.from || 'the beginning'} to ${achkFilters.to || 'today'}`);
  }
  return {
    title: 'Audit Checklist' + (titleSuffix ? ' — ' + titleSuffix : ''),
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'Recorded', w: 1 }, { label: 'FY', w: 0.8 }, { label: 'Client', w: 1.9 }, { label: 'PAN', w: 0.95 },
      { label: 'Progress', w: 0.7 }, { label: 'Status', w: 1.05 },
      { label: 'Completed Items', w: 2.6 }, { label: 'Pending Items', w: 2.0 }, { label: 'Remarks', w: 1.6 },
    ],
    rows: rows.map(r => {
      const { checked, total } = achkProgress(r);
      return { cells: [
        r.recorded_date, r.fiscal_year, r.client_name, r.client_pan,
        `${checked}/${total}`, ACHK_STATUSES[achkStatusKey(r)].label,
        achkItemsSummary(r, true), achkItemsSummary(r, false), r.remarks,
      ] };
    }),
    _filename: 'Audit Checklist' + (titleSuffix ? ' - ' + titleSuffix : ''),
  };
}

async function achkExport(kind) {
  achkReadFilters();
  const rows = achkCurrentFilteredRows();
  if (!rows.length) { achkStatusMsg('Nothing to export for the current filters.', 'info'); return; }
  const model = achkBuildModel(rows);
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'auditChecklist', clientName: 'Filtered Records', sheetName: 'Checklists',
    });
  } catch (e) {
    achkStatusMsg('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Print / Preview ──
// Opens a plain print window over the same model the Excel/PDF export uses
// (ReportExport.toHtml), so what you see in Preview and what a PDF export
// contains can't disagree — same idiom as Audit Report Finalization.
function achkOpenPrintWindow(model) {
  const w = window.open('', '_blank');
  if (!w) { achkStatusMsg('Allow pop-ups to print.', 'info'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(model.title)}</title>
    <style>body{font-family:Inter,Arial,sans-serif;margin:28px;color:#1a202c;}
    table{border-collapse:collapse;width:100%;font-size:11px;}
    th,td{border:1px solid #d9dce5;padding:5px 8px;}
    th{background:#f3f5fb;color:#0b1f3d;}
    @page{size:A4 landscape;margin:12mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  // The browser's own print dialog offers "Save as PDF" — this is the
  // preview's actual save-to-PDF path, not a separate feature to build.
  setTimeout(() => w.print(), 300);
  AuditLog.record('achk_printed', { module: 'auditChecklist' });
}

function achkPreviewAll() {
  achkReadFilters();
  const rows = achkCurrentFilteredRows();
  if (!rows.length) { achkStatusMsg('Nothing to preview for the current filters.', 'info'); return; }
  achkOpenPrintWindow(achkBuildModel(rows));
}

function achkPrintOne(row) {
  achkOpenPrintWindow(achkBuildModel([row], row.client_name));
}
