// ════════════════════════════════════════════
//  WORK DONE
//  What work has actually been finished, per client per fiscal year
//  (sidebar module, own top-level nav item, after Audit Checklist).
//  Digitizes the paper "Work done Module" sheet: one page per client per
//  year, a fixed list of work types (Sales Register, VAT Reco, Ann-13,
//  Financial Statement, VAT Return, ETDS, IRD Submission, ...), each with
//  who did it, what state it's in, and remarks.
//
//  It exists because the firm's work happens in pieces, by several people,
//  over several days, and nothing recorded which pieces were finished — so
//  work got forgotten, redone, or started twice.
//
//  PIPELINE POSITION:
//    File In Out  →  Work Done  →  Audit Checklist  →  Audit Report Finalization
//    (paper in)      (work done)   (QC sign-off)       (filed with IRD)
//
//  ONE RECORD PER (client, fiscal year), same grain and same auto-match
//  idiom as Audit Checklist — see wdMatchExistingRecord().
//
//  items IS A JSONB ARRAY, not one column per work type — the fixed list
//  (window.WD_WORK_TYPES) can grow without a migration, and custom work rows
//  are inherently variable-shape. Three states per row rather than a plain
//  done-tick: "In Progress" is what stops two staff starting the same job.
//
//  Status and progress are DERIVED from items[] in wdStatusKey() — never
//  stored — so the table badge, the stat cards and the export text can't
//  drift apart from what was actually saved.
//
//  THE PENDING LIST IS A JOIN, NOT A COLUMN. The firm's sheet marks exactly
//  three work types as pending-eligible ("If file is received and work is
//  not done" against Sales Register / Purchase Register / Stock Book, and
//  "Do not show in Pending list" against every other row). Those three
//  labels are three of the nine window.FM_DOC_TYPES that File In Out already
//  records — so "file is received" is answered by document_register rather
//  than by a second checkbox here. Nothing is entered twice and the list
//  can't go stale. See wdPendingRows() for the one gotcha that makes or
//  breaks it: the two tables' fiscal years are in different formats on
//  purpose, so they are joined through NepaliLocale.fyStartYear().
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'workDone', group: 'main', buttonId: 'nav-workDone', panelId: 'tab-workDone-panel' });

const WD_RECORD_STATUSES = {
  not_started: { label: 'Not Started', icon: '⬜', badgeClass: 'badge-neutral' },
  in_progress: { label: 'In Progress', icon: '🟡', badgeClass: 'badge-amber' },
  complete:    { label: 'Complete',    icon: '✅', badgeClass: 'badge-sent' },
};

const WD_FY_START = 2077;
const WD_FY_END = 2085;
const WD_FY_DEFAULT = '2082/83';

// Stat cards double as quick filters — the ARF / Audit Checklist idiom.
const WD_FILTERS = {
  all:        { label: 'Total Records', test: () => true },
  complete:   { label: 'Complete',      test: r => wdStatusKey(r) === 'complete' },
  inProgress: { label: 'In Progress',   test: r => wdStatusKey(r) === 'in_progress' },
  notStarted: { label: 'Not Started',   test: r => wdStatusKey(r) === 'not_started' },
};

const WD_FILTERS_EMPTY = { fiscalYear: '', status: '', staff: '', from: '', to: '' };

let wdRecords = [];
// document_register rows — read ONLY to build the Pending List. Loaded with a
// plain sbFetchAll rather than through DataCache, deliberately: LEDGER_KEYS is
// reserved for the four shared ledger tables (CLAUDE.md §6), and a work
// tracker showing 60-second-stale data is worse than one extra round-trip.
let wdIntakes = [];
let wdTable = null;
let wdPendingTable = null;
let wdSelectedClient = null;
let wdEditingId = null;
// The items[] array for whichever record is open in the drawer — the working
// state the rows read from and write into. Never read back out of the DOM.
let wdItems = [];
let wdCustomSeq = 0;
// True when wdEditingId came from the (client, FY) auto-match rather than the
// user pressing Edit — same ARF/Audit Checklist distinction: an auto-match is
// re-evaluated on every key-field change, an explicit edit is left alone.
let wdAutoMatched = false;
// Set while the drawer is being populated, so the key-field watcher doesn't
// fire on the writes that populating performs.
let wdSuppressKeyWatch = false;
let wdActiveFilter = 'all';
let wdInitDone = false;
let wdView = 'records';           // 'records' | 'pending'
let wdUnknownFyCount = 0;         // intake rows with no readable fiscal year (matched by client instead)
let wdFilters = { ...WD_FILTERS_EMPTY };

function wdUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function wdStatusMsg(html, type) { showStatus(html, type, 'wd-status-area'); }
function wdToday() { return new Date().toISOString().slice(0, 10); }
function wdEl(id) { return document.getElementById(id); }

function wdFyLabel(startYear) { return startYear + '/' + String((startYear + 1) % 100).padStart(2, '0'); }
function wdFyOptions() {
  const opts = [];
  for (let y = WD_FY_END; y >= WD_FY_START; y--) opts.push(wdFyLabel(y));
  return opts;
}

function wdStateMeta(key) {
  return window.WD_STATES.find(s => s.key === key) || window.WD_STATES[0];
}

// ── Derived status & progress (never stored — see header note) ──
function wdProgress(row) {
  const items = row.items || [];
  return { done: items.filter(i => i.state === 'done').length, total: items.length };
}

function wdStatusKey(row) {
  const items = row.items || [];
  const { done, total } = wdProgress(row);
  if (!total) return 'not_started';
  if (done === total) return 'complete';
  if (done === 0 && !items.some(i => i.state === 'in_progress')) return 'not_started';
  return 'in_progress';
}

function wdStatusBadge(row) {
  const meta = WD_RECORD_STATUSES[wdStatusKey(row)];
  return `<span class="log-badge ${meta.badgeClass}">${meta.icon} ${escHtml(meta.label)}</span>`;
}

// How many of a record's file-backed work types are still outstanding — the
// same rows the Pending List is built from, counted per record so the main
// table shows the same signal without switching views.
function wdRecordPendingCount(row) {
  const backed = window.WD_WORK_TYPES.filter(t => (t.fileLabels || []).length).map(t => t.key);
  return (row.items || []).filter(i => backed.includes(i.key) && i.state !== 'done').length;
}

// doc-type label -> the work types it implies. Built from WD_WORK_TYPES rather
// than hardcoded because one received document can imply more than one job:
// the firm's real register uses "Purchase & Sales Files" as a single item
// covering both the sales and the purchase register.
function wdWorkTypesForLabel(label) {
  return window.WD_WORK_TYPES.filter(t => (t.fileLabels || []).includes(label));
}

// Every doc-type entry on an intake row, normalized. Bare strings are the
// pre-quantities legacy shape fmDocSummary() still handles.
function wdIntakeDocs(d) {
  const raw = Array.isArray(d.doc_types) ? d.doc_types : [];
  return raw
    .map(t => (typeof t === 'string' ? { type: t, qty: 1 } : t))
    .filter(t => t && t.type && (t.qty == null || Number(t.qty) > 0));
}

// Intakes belonging to a client. fiscal_year on document_register is an
// OPTIONAL free-text box and is in fact null on every row the firm has
// entered so far, so an unknown year must NOT exclude the intake — it falls
// back to matching the client across all years. Excluding them is what made
// the Pending List come up empty against real data (2026-08-10).
function wdIntakesFor(clientId, startYear) {
  return wdIntakes.filter(d => {
    if (d.client_id !== clientId) return false;
    if (startYear == null) return true;
    const y = NepaliLocale.fyStartYear(d.fiscal_year);
    return y == null || y === startYear;   // unknown year matches any
  });
}

// ── Init & load ──
function wdInit() {
  if (!wdInitDone) {
    SearchEngine.attachAutocomplete(wdEl('wd-client-search'), wdEl('wd-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: wdSelectClient,
    });
    wdPopulateStaticDropdowns();
    wdInitDone = true;
  }
  wdRefresh();
}

function wdPopulateStaticDropdowns() {
  const fyOpts = wdFyOptions().map(fy => `<option value="${fy}">${fy}</option>`).join('');
  wdEl('wd-fiscal-year').innerHTML = fyOpts;
  wdEl('wd-fiscal-year').value = WD_FY_DEFAULT;
  wdEl('wd-filter-fy').innerHTML = '<option value="">All Years</option>' + fyOpts;
  wdEl('wd-filter-status').innerHTML = '<option value="">All Statuses</option>' +
    Object.entries(WD_RECORD_STATUSES).map(([k, m]) => `<option value="${k}">${escHtml(m.label)}</option>`).join('');
}

// Staff options come from the fixed list UNION whatever names are actually in
// the data, so a name typed through "Other" is still filterable.
function wdPopulateStaffFilter() {
  const sel = wdEl('wd-filter-staff');
  if (!sel) return;
  const cur = sel.value;
  const names = new Set(window.ARF_STAFF.filter(s => s !== 'Other'));
  wdRecords.forEach(r => (r.items || []).forEach(i => { if (i.staff) names.add(i.staff); }));
  const sorted = Array.from(names).sort();
  sel.innerHTML = '<option value="">All Staff</option>' +
    sorted.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  if (sorted.includes(cur)) sel.value = cur;
}

async function wdRefresh() {
  wdStatusMsg('<span class="spinner spinner-navy"></span> Loading work records…', 'searching');
  try {
    // Both tables together — the Pending List is a join, so a partial load
    // would render a list that's wrong rather than one that's obviously empty.
    [wdRecords, wdIntakes] = await Promise.all([
      // Newest work first — same rationale as ARF/Audit Checklist: the date
      // filter's whole point is "what did we get through recently".
      sbFetchAll(() => window.sb.from('work_done')
        .select('*').order('recorded_date', { ascending: false }).order('client_name', { ascending: true })),
      sbFetchAll(() => window.sb.from('document_register')
        .select('*').order('date_received', { ascending: true })),
    ]);
    wdPopulateStaffFilter();
    wdRenderStats();
    wdRenderTable();
    wdRenderPending();
    wdEl('wd-status-area').innerHTML = '';
  } catch (e) {
    wdStatusMsg('❌ Failed to load work records: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── View toggle (Work Records ⇄ Pending List) ──
function wdSetView(view) {
  wdView = view;
  wdEl('wd-view-records').classList.toggle('active', view === 'records');
  wdEl('wd-view-pending').classList.toggle('active', view === 'pending');
  wdEl('wd-records-view').style.display = view === 'records' ? '' : 'none';
  wdEl('wd-pending-view').style.display = view === 'pending' ? '' : 'none';
  // Tabulator lays out to zero width while hidden, so the newly-shown table
  // needs a redraw once it actually has a box to measure.
  const t = view === 'records' ? wdTable : wdPendingTable;
  if (t) setTimeout(() => t.redraw(true), 0);
}

function wdUpdatePendingBadge(count) {
  const el = wdEl('wd-pending-count');
  if (el) el.textContent = count ? ` (${count})` : '';
}

// ── Stat cards (also the quick filters) ──
function wdRenderStats() {
  const grid = wdEl('wd-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(WD_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${wdActiveFilter === key ? 'active-filter' : ''}" onclick="wdSetFilter('${key}')" title="Show only these — clears the filters below">
      <div class="stat-num">${wdRecords.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

// A card is a fresh start: its number counts the whole portfolio, so leaving
// stale dropdown filters applied would show fewer rows than the card claims.
function wdSetFilter(key) {
  wdActiveFilter = key;
  wdResetFilterInputs();
  wdRenderStats();
  wdApplyFilters();
  wdSetView('records');
}

function wdResetFilterInputs() {
  ['wd-filter-fy', 'wd-filter-status', 'wd-filter-staff', 'wd-filter-from', 'wd-filter-to', 'wd-search'].forEach(id => {
    const el = wdEl(id); if (el) el.value = '';
  });
  wdFilters = { ...WD_FILTERS_EMPTY };
}

// ── List table ──
function wdRenderTable() {
  const wrap = wdEl('wd-table-wrap');
  if (wdTable) { wdTable.destroy(); wdTable = null; }
  if (!wdRecords.length) {
    wrap.innerHTML = '<div class="log-empty">No work records yet. Click <strong>New Work Record</strong> to start one.</div>';
    return;
  }
  wrap.innerHTML = '';
  wdTable = TableEngine.createTable(wrap, {
    data: wdRecords,
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
          const { done, total } = wdProgress(c.getRow().getData());
          return `<strong>${done}/${total}</strong>`;
        } },
      { title: 'Status', field: 'id', width: 140, headerSort: false, formatter: c => wdStatusBadge(c.getRow().getData()) },
      { title: 'Files Pending', field: 'id', width: 115, headerSort: false, formatter: c => {
          const n = wdRecordPendingCount(c.getRow().getData());
          return n ? `<span style="color:var(--amber-dk); font-weight:600;">${n}</span>` : '<span style="color:var(--green-dk);">—</span>';
        } },
      { title: 'Recorded', field: 'recorded_date', width: 115, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 190, formatter: () => wdRowActions(),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') wdOpenEntry(row);
          else if (btn.dataset.action === 'print') wdPrintOne(row);
          else if (btn.dataset.action === 'delete') wdDeleteEntry(row);
        } },
    ],
  });
  wdApplyFilters();
}

function wdRowActions() {
  const btn = (a, label) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('print', 'Print')}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function wdReadFilters() {
  wdFilters = {
    fiscalYear: wdEl('wd-filter-fy').value,
    status: wdEl('wd-filter-status').value,
    staff: wdEl('wd-filter-staff').value,
    from: wdEl('wd-filter-from').value,
    to: wdEl('wd-filter-to').value,
  };
}

function wdCurrentFilteredRows() {
  const cardTest = WD_FILTERS[wdActiveFilter].test;
  let rows = wdRecords.filter(r => {
    if (!cardTest(r)) return false;
    if (wdFilters.fiscalYear && r.fiscal_year !== wdFilters.fiscalYear) return false;
    if (wdFilters.status && wdStatusKey(r) !== wdFilters.status) return false;
    // "Whose plate is this on" — a record matches if ANY of its work rows is
    // assigned to the person, which is the question the module exists to answer.
    if (wdFilters.staff && !(r.items || []).some(i => i.staff === wdFilters.staff)) return false;
    // ISO dates compare correctly as strings, so no Date parsing needed.
    if (wdFilters.from && (r.recorded_date || '') < wdFilters.from) return false;
    if (wdFilters.to && (r.recorded_date || '') > wdFilters.to) return false;
    return true;
  });
  const q = (wdEl('wd-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['client_name', 'client_pan', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function wdApplyFilters() {
  const rows = wdCurrentFilteredRows();
  if (wdTable) wdTable.replaceData(rows);
}

function wdOnFilterChange() { wdReadFilters(); wdApplyFilters(); }

function wdClearFilters() {
  wdResetFilterInputs();
  wdActiveFilter = 'all';
  wdRenderStats();
  wdApplyFilters();
}

// ════════════════════════════════════════════
//  THE PENDING LIST — File In Out ⋈ Work Done
// ════════════════════════════════════════════

function wdFindRecord(clientId, fy) {
  return wdRecords.find(r => r.client_id === clientId && r.fiscal_year === fy);
}

// Match on the NORMALIZED start year, not the raw string. document_register's
// fiscal_year is a free-text box (dash style, '2081-82') while work_done's is
// a dropdown (slash style, '2082/83') — CLAUDE.md §8 keeps those formats
// deliberately per-module, so this is the boundary normalization §8 calls for.
// Comparing the strings directly would match nothing and fail SILENTLY.
function wdFindRecordByStartYear(clientId, startYear) {
  return wdRecords.find(r => r.client_id === clientId && NepaliLocale.fyStartYear(r.fiscal_year) === startYear);
}

function wdDaysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate + 'T00:00:00');
  if (isNaN(then)) return null;
  const now = new Date(wdToday() + 'T00:00:00');
  return Math.max(0, Math.round((now - then) / 86400000));
}

// Built from document_register OUTWARD, never from work_done — the commonest
// pending case by far is a client whose Work Done record doesn't exist yet, so
// iterating saved records would miss exactly the rows that matter most.
function wdPendingRows() {
  const agg = new Map();
  wdUnknownFyCount = 0;

  wdIntakes.forEach(d => {
    // Walk-in intakes (client_id null — File In Out allows them, this module
    // doesn't) can't be tied to a client's work record.
    if (d.client_id == null) return;

    // Each received document can imply more than one job.
    const jobs = [];
    wdIntakeDocs(d).forEach(t => wdWorkTypesForLabel(t.type).forEach(wt => {
      if (!jobs.some(j => j.key === wt.key)) jobs.push(wt);
    }));
    if (!jobs.length) return;

    const startYear = NepaliLocale.fyStartYear(d.fiscal_year);
    if (startYear == null) wdUnknownFyCount += 1;

    // An intake with no fiscal year is matched against the client's records
    // across ALL years — the year is unknown, not a reason to hide the file.
    const recs = startYear == null
      ? wdRecords.filter(r => r.client_id === d.client_id)
      : wdRecords.filter(r => r.client_id === d.client_id && NepaliLocale.fyStartYear(r.fiscal_year) === startYear);

    jobs.forEach(wt => {
      // Take the most advanced state across matching records: if ANY of the
      // client's records has this job done, the file isn't waiting on it.
      let state = 'not_started', staff = '', rec = null;
      recs.forEach(r => {
        const it = (r.items || []).find(i => i.key === wt.key);
        if (!it) return;
        if (it.state === 'done' || (it.state === 'in_progress' && state !== 'done')) { state = it.state; staff = it.staff || staff; rec = r; }
        else if (!rec) { rec = r; staff = it.staff || staff; }
      });
      if (state === 'done') return;

      // One entry per (client, fiscal year, work type): a client can bring the
      // same register in across several visits, and three register numbers for
      // one outstanding job is one job, not three.
      const key = d.client_id + '|' + (startYear == null ? '?' : startYear) + '|' + wt.key;
      const existing = agg.get(key);
      if (existing) {
        if (d.register_no) existing.registerNos.add(d.register_no);
        if (d.status) existing.fmStatuses.add(d.status);
        if (d.date_received && (!existing.received || d.date_received < existing.received)) existing.received = d.date_received;
      } else {
        agg.set(key, {
          clientId: d.client_id,
          clientName: (rec && rec.client_name) || d.client_name || '—',
          clientPan: (rec && rec.client_pan) || d.client_pan || '',
          fiscalYear: startYear == null ? '—' : wdFyLabel(startYear),
          startYear,
          workKey: wt.key,
          workLabel: wt.label,
          state,
          staff,
          registerNos: new Set(d.register_no ? [d.register_no] : []),
          fmStatuses: new Set(d.status ? [d.status] : []),
          received: d.date_received || '',
        });
      }
    });
  });

  return Array.from(agg.values())
    .map(p => ({
      ...p,
      registerNo: Array.from(p.registerNos).join(', ') || '—',
      fmStatus: Array.from(p.fmStatuses).join(', ') || '—',
      days: wdDaysSince(p.received),
    }))
    // Longest-waiting first — the actual triage order, and the one thing the
    // paper pending list could never do.
    .sort((a, b) => (b.days == null ? -1 : b.days) - (a.days == null ? -1 : a.days));
}

// The join is by LABEL TEXT (document_register stores doc_types[].type as the
// label, not the key), so a document type renamed in FM_DOC_TYPES without its
// spelling being added to WD_WORK_TYPES.fileLabels empties this list without
// any error anywhere. Checked at render time and surfaced, because "nothing
// pending" and "the config broke" look identical on screen otherwise.
// Reported as INFO, not an error: the live register legitimately holds older
// vocabulary ("Purchase & Sales Files") that is no longer on today's picklist,
// and mapping it is the point. What matters is that at least one spelling of
// each file-backed work type still resolves — a work type whose every label
// has fallen off the picklist can never appear in the list again.
function wdOrphanWorkTypes() {
  const fmLabels = (window.FM_DOC_TYPES || []).map(t => t.label);
  const seen = new Set();
  wdIntakes.forEach(d => wdIntakeDocs(d).forEach(t => seen.add(t.type)));
  return window.WD_WORK_TYPES
    .filter(t => (t.fileLabels || []).length)
    .filter(t => !t.fileLabels.some(l => fmLabels.includes(l) || seen.has(l)))
    .map(t => t.label);
}

function wdRenderPending() {
  const rows = wdPendingRows();
  wdUpdatePendingBadge(rows.length);

  // Never swallow rows we couldn't match — a silently short pending list is
  // this module's worst failure mode, since it looks exactly like "nothing
  // is pending".
  const note = wdEl('wd-pending-note');
  if (note) {
    let html = '';
    const orphans = wdOrphanWorkTypes();
    if (orphans.length) {
      html += `<div class="status-box status-error">⚠️ Configuration problem: none of the document labels mapped to ${escHtml(orphans.join(', '))} exist in File In Out or anywhere in the register, so ${orphans.length === 1 ? 'that work type' : 'those work types'} can never appear below. Add the spelling File In Out actually uses to <code>WD_WORK_TYPES[].fileLabels</code> in <code>js/config.js</code>.</div>`;
    }
    if (wdUnknownFyCount) {
      html += `<div class="status-box status-info">ℹ️ ${wdUnknownFyCount} File In Out ${wdUnknownFyCount === 1 ? 'entry has' : 'entries have'} no fiscal year recorded, so ${wdUnknownFyCount === 1 ? 'it is' : 'they are'} matched against the client across all years and shown with <strong>FY —</strong>. Setting the year in <strong>File In Out</strong> will tie ${wdUnknownFyCount === 1 ? 'it' : 'them'} to a specific record.</div>`;
    }
    note.innerHTML = html;
  }

  const wrap = wdEl('wd-pending-wrap');
  if (wdPendingTable) { wdPendingTable.destroy(); wdPendingTable = null; }
  if (!rows.length) {
    // Distinguish "nothing is waiting" from "no file-backed document has ever
    // been logged" — they look identical otherwise, and the second one means
    // the register simply has nothing this module can act on yet.
    const anyBacked = wdIntakes.some(d => d.client_id != null && wdIntakeDocs(d).some(t => wdWorkTypesForLabel(t.type).length));
    wrap.innerHTML = anyBacked
      ? '<div class="log-empty">Nothing pending — every register and stock book received in File In Out has its work marked Done.</div>'
      : `<div class="log-empty">No pending work yet. This list fills from <strong>File In Out</strong>: when an intake records a Sales Register, Purchase Register or Stock Book, it appears here until that work is marked Done.${wdIntakes.length ? ` (${wdIntakes.length} intake${wdIntakes.length === 1 ? '' : 's'} on file, none carrying one of those documents.)` : ''}</div>`;
    return;
  }
  wrap.innerHTML = '';
  wdPendingTable = TableEngine.createTable(wrap, {
    data: rows,
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    columns: [
      { title: 'Waiting', field: 'days', width: 100, formatter: c => {
          const d = c.getValue();
          if (d == null) return '—';
          const color = d >= 30 ? 'var(--red-dk)' : d >= 14 ? 'var(--amber-dk)' : 'var(--text-muted)';
          return `<span style="color:${color}; font-weight:600;">${d} day${d === 1 ? '' : 's'}</span>`;
        } },
      { title: 'Client', field: 'clientName', minWidth: 170, formatter: c => {
          const r = c.getRow().getData();
          return escHtml(r.clientName || '—') + (r.clientPan ? `<br><span style="color:var(--text-faint); font-size:12px;">PAN ${escHtml(r.clientPan)}</span>` : '');
        } },
      { title: 'FY', field: 'fiscalYear', width: 90 },
      { title: 'Work Type', field: 'workLabel', minWidth: 150 },
      { title: 'State', field: 'state', width: 130, formatter: c => {
          const m = wdStateMeta(c.getValue());
          return `<span class="log-badge ${m.badgeClass}">${m.icon} ${escHtml(m.label)}</span>`;
        } },
      { title: 'Staff', field: 'staff', width: 120, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Register', field: 'registerNo', width: 130, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Received', field: 'received', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'File Status', field: 'fmStatus', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: '', field: 'workKey', headerSort: false, width: 90, formatter: () => '<div class="client-actions"><button class="btn btn-outline btn-sm" data-action="open" title="Open this client\'s work record">Open</button></div>',
        cellClick: (e, cell) => {
          if (!e.target.closest('[data-action="open"]')) return;
          wdOpenFromPending(cell.getRow().getData());
        } },
    ],
  });
}

// One click from "this is late" to "I'm doing it" — opens the client+year's
// record, seeding a fresh one when it doesn't exist yet.
function wdOpenFromPending(p) {
  // An intake with no fiscal year can't say which record it belongs to, so
  // fall back to the client's only existing record, or the default year.
  if (p.startYear != null) {
    const existing = wdFindRecord(p.clientId, p.fiscalYear);
    if (existing) { wdOpenEntry(existing); return; }
  } else {
    const mine = wdRecords.filter(r => r.client_id === p.clientId);
    if (mine.length === 1) { wdOpenEntry(mine[0]); return; }
  }
  const client = (window.clientsList || []).find(c => c.id === p.clientId)
    || { id: p.clientId, name: p.clientName, pan: p.clientPan };
  wdOpenEntry(null, { client, fiscalYear: p.startYear != null ? p.fiscalYear : WD_FY_DEFAULT });
}

// ── Entry drawer ──
function wdSelectClient(c) {
  wdSelectedClient = c;
  wdEl('wd-client-search').value = c.name;
  wdEl('wd-client-pan').value = c.pan || '';
  wdOnKeyFieldChange();
}

function wdFreshItem(t, auto) {
  return { key: t.key, label: t.label, state: 'not_started', staff: '', remarks: '', done_date: null, custom: false, auto: !!auto };
}

// Sort a working set back into config order, customs last, so adding a row
// doesn't leave it stranded at the bottom of the wrong group.
function wdSortItems(items) {
  const order = {};
  window.WD_WORK_TYPES.forEach((t, i) => { order[t.key] = i; });
  const fixed = items.filter(i => !i.custom).sort((a, b) => (order[a.key] ?? 999) - (order[b.key] ?? 999));
  return fixed.concat(items.filter(i => i.custom));
}

// Which work types File In Out implies for this client+year. THE record does
// NOT get all 16 rows — the firm doesn't do every job for every client, so a
// new record starts with only what the received files actually imply, and
// everything else is added by hand from the picker.
function wdAutoItemsFor(clientId, fiscalYear) {
  if (clientId == null) return [];
  const startYear = NepaliLocale.fyStartYear(fiscalYear);
  const keys = new Set();
  wdIntakesFor(clientId, startYear).forEach(d =>
    wdIntakeDocs(d).forEach(t => wdWorkTypesForLabel(t.type).forEach(wt => keys.add(wt.key))));
  return window.WD_WORK_TYPES.filter(t => keys.has(t.key)).map(t => wdFreshItem(t, true));
}

// A brand-new record holds ONLY the work its received files imply — possibly
// nothing at all, which is the honest starting point for a client whose files
// haven't arrived yet.
function wdBuildFreshItems(clientId, fiscalYear) {
  return wdAutoItemsFor(clientId, fiscalYear);
}

// Loading an existing record keeps EXACTLY the rows that were saved (labels
// re-read from config so a wording fix propagates), plus any file-backed work
// that File In Out has since implied and the record doesn't carry yet.
//
// It deliberately does NOT top the record up to the full config list: the row
// set is the user's own selection of what this client needs, so adding every
// work type back would undo that choice on every open.
function wdMergeItems(stored, clientId, fiscalYear) {
  const byKey = {};
  const kept = (stored || []).filter(i => i && i.key).map(i => {
    const t = window.WD_WORK_TYPES.find(x => x.key === i.key);
    const merged = { ...i, label: t ? t.label : i.label, custom: !!i.custom };
    byKey[i.key] = merged;
    return merged;
  });
  const added = wdAutoItemsFor(clientId, fiscalYear).filter(i => !byKey[i.key]);
  return wdSortItems(kept.concat(added));
}

// Client or fiscal year changing means "which record am I on?" needs
// recomputing — the ARF / Audit Checklist idea.
function wdOnKeyFieldChange() { wdMatchExistingRecord(); }

function wdMatchExistingRecord() {
  if (wdSuppressKeyWatch) return;
  if (wdEditingId && !wdAutoMatched) return;   // explicit Edit — leave it alone

  const fy = wdEl('wd-fiscal-year').value;
  const existing = (wdSelectedClient && fy) ? wdFindRecord(wdSelectedClient.id, fy) : null;

  if (existing) {
    if (existing.id === wdEditingId) return;
    wdLoadIntoDrawer(existing, true);
    wdAutoMatched = true;
    showStatus('Editing this client’s existing work record for that year.', 'info', 'wd-drawer-status');
  } else if (wdSelectedClient) {
    wdEditingId = null;
    wdAutoMatched = false;
    wdItems = wdBuildFreshItems(wdSelectedClient.id, fy);
    wdRenderItems();
    wdEl('wd-drawer-title').textContent = 'New Work Record';
    wdEl('wd-drawer-status').innerHTML = '';
  }
  wdRenderReceived();
}

// ── What File In Out is holding for this client ──
// Shown in full, including documents that imply no work type, so a staff
// member can see everything that came in rather than only the mapped subset.
function wdRenderReceived() {
  const wrap = wdEl('wd-received');
  if (!wrap) return;
  const client = wdSelectedClient;
  if (!client) { wrap.innerHTML = ''; return; }

  const fy = wdEl('wd-fiscal-year').value;
  const rows = wdIntakesFor(client.id, NepaliLocale.fyStartYear(fy));
  if (!rows.length) {
    wrap.innerHTML = '<div class="wd-received-empty">No files logged in File In Out for this client.</div>';
    return;
  }
  const body = rows.map(d => {
    const docs = wdIntakeDocs(d).map(t => {
      const implied = wdWorkTypesForLabel(t.type).length;
      return `<span class="wd-received-doc${implied ? ' implies' : ''}">${escHtml(t.type)}${t.qty > 1 ? ' ×' + t.qty : ''}</span>`;
    }).join('');
    const other = d.doc_other ? `<span class="wd-received-doc">${escHtml(d.doc_other)}</span>` : '';
    return `<div class="wd-received-row">
      <span class="wd-received-meta">${escHtml(d.register_no || '—')} · ${escHtml(d.date_received || '—')} · FY ${escHtml(d.fiscal_year || '—')}</span>
      <span class="wd-received-docs">${docs}${other}</span>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="wd-received-head">📁 Received in File In Out<span class="wd-received-hint">highlighted documents add a work row automatically</span></div>${body}`;
}

// ── Add-work picker ──
function wdRenderPicker() {
  const sel = wdEl('wd-add-work');
  if (!sel) return;
  const have = new Set(wdItems.map(i => i.key));
  const groups = {};
  window.WD_WORK_TYPES.filter(t => !have.has(t.key)).forEach(t => {
    (groups[t.group] = groups[t.group] || []).push(t);
  });
  const opts = Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${escHtml(g)}">` +
    list.map(t => `<option value="${escHtml(t.key)}">${escHtml(t.label)}</option>`).join('') +
    `</optgroup>`).join('');
  sel.innerHTML = opts
    ? '<option value="">+ Add work…</option>' + opts
    : '<option value="">All work types added</option>';
  sel.disabled = !opts;
}

function wdAddWorkType(key) {
  if (!key) return;
  const t = window.WD_WORK_TYPES.find(x => x.key === key);
  if (!t || wdItems.some(i => i.key === key)) return;
  wdItems = wdSortItems(wdItems.concat([wdFreshItem(t, false)]));
  wdRenderItems();
}

function wdOnAddWork(sel) {
  const key = sel.value;
  sel.value = '';
  wdAddWorkType(key);
}

function wdRemoveItem(key) {
  wdItems = wdItems.filter(i => i.key !== key);
  wdRenderItems();
}

// ── Work item rows ──
function wdItemIndex(key) { return wdItems.findIndex(i => i.key === key); }

function wdItemRowHtml(item) {
  const fixedStaff = window.ARF_STAFF.filter(s => s !== 'Other');
  // item._other is a transient UI flag (never saved — see wdSaveEntry's
  // explicit field list): selecting "Other" clears staff to let the person
  // type a name, so isOther can't be inferred from staff alone right after
  // that change — it would read as "not Other" the instant the box that types
  // the name would otherwise appear. This exact bug shipped in Audit
  // Checklist before the flag was added.
  const isOther = !!item._other || (!!item.staff && !fixedStaff.includes(item.staff));
  const staffOptions = ['<option value="">Staff…</option>'].concat(
    window.ARF_STAFF.map(s => {
      const selected = isOther ? (s === 'Other') : (s === item.staff);
      return `<option value="${escHtml(s)}" ${selected ? 'selected' : ''}>${escHtml(s)}</option>`;
    })
  ).join('');

  const stateOptions = window.WD_STATES.map(s =>
    `<option value="${s.key}" ${item.state === s.key ? 'selected' : ''}>${escHtml(s.icon + ' ' + s.label)}</option>`).join('');

  const labelHtml = item.custom
    ? `<input type="text" class="wd-item-label-input" value="${escHtml(item.label)}" placeholder="Describe this work" oninput="wdOnCustomLabelChange('${item.key}', this.value)" />`
    : `<span class="wd-item-label">${escHtml(item.label)}</span>`;

  // Every row is removable now that the row set is the user's own selection —
  // adding a work type by mistake has to be undoable, not permanent.
  const removeBtn = `<button type="button" class="btn btn-outline btn-sm wd-item-remove" onclick="wdRemoveItem('${item.key}')" title="Remove this work row">🗑</button>`;

  const autoBadge = item.auto
    ? '<span class="wd-item-auto" title="Added automatically because File In Out records this file as received">📁</span>' : '';

  const doneStamp = item.state === 'done' && item.done_date
    ? `<span class="wd-item-done-date" title="Marked done on this date">${escHtml(item.done_date)}</span>` : '';

  return `
    <div class="wd-item-row state-${escHtml(item.state || 'not_started')}" data-key="${escHtml(item.key)}">
      <select class="wd-item-state" onchange="wdOnItemStateChange('${item.key}', this.value)">${stateOptions}</select>
      <div class="wd-item-label-cell">${autoBadge}${labelHtml}${doneStamp}</div>
      <div class="wd-item-staff">
        <select onchange="wdOnItemStaffChange('${item.key}', this)">${staffOptions}</select>
        <input type="text" class="wd-item-staff-other" style="display:${isOther ? '' : 'none'};" value="${isOther ? escHtml(item.staff) : ''}" placeholder="Type name" oninput="wdOnItemStaffOtherChange('${item.key}', this.value)" />
      </div>
      <input type="text" class="wd-item-remarks" value="${escHtml(item.remarks || '')}" placeholder="Remarks" oninput="wdOnItemRemarksChange('${item.key}', this.value)" />
      ${removeBtn}
    </div>`;
}

function wdRenderItems() {
  const wrap = wdEl('wd-items-list');
  if (!wrap) return;
  wdRenderPicker();
  if (!wdItems.length) {
    wrap.innerHTML = wdSelectedClient
      ? '<div class="log-empty" style="padding:14px;">No work rows yet — add the work this client needs from <strong>+ Add work…</strong> above. Rows for Sales/Purchase Registers and Stock Books appear here on their own once File In Out records those files.</div>'
      : '<div class="log-empty" style="padding:14px;">Pick a client above to start.</div>';
    wdUpdateDrawerProgress();
    return;
  }
  const groupOf = {};
  window.WD_WORK_TYPES.forEach(t => { groupOf[t.key] = t.group; });

  let html = '';
  let lastGroup = null;
  wdItems.forEach(item => {
    const group = item.custom ? 'Other Work' : (groupOf[item.key] || 'Other Work');
    if (group !== lastGroup) {
      html += `<div class="wd-group-head">${escHtml(group)}</div>`;
      lastGroup = group;
    }
    html += wdItemRowHtml(item);
  });
  wrap.innerHTML = html;
  wdUpdateDrawerProgress();
}

function wdUpdateDrawerProgress() {
  const el = wdEl('wd-drawer-progress');
  if (!el) return;
  const { done, total } = wdProgress({ items: wdItems });
  el.textContent = total ? `${done} of ${total} done` : '';
}

function wdOnItemStateChange(key, value) {
  const i = wdItemIndex(key); if (i < 0) return;
  wdItems[i].state = value;
  // Stamp the day it was finished, and clear it again if the row moves back —
  // a stale done date on an unfinished row misreports the work.
  wdItems[i].done_date = value === 'done' ? (wdItems[i].done_date || wdToday()) : null;
  wdRenderItems();
}

function wdOnCustomLabelChange(key, value) {
  const i = wdItemIndex(key); if (i < 0) return;
  wdItems[i].label = value;
}

function wdOnItemRemarksChange(key, value) {
  const i = wdItemIndex(key); if (i < 0) return;
  wdItems[i].remarks = value;
}

function wdOnItemStaffChange(key, selectEl) {
  const i = wdItemIndex(key); if (i < 0) return;
  const val = selectEl.value;
  wdItems[i]._other = val === 'Other';
  wdItems[i].staff = val === 'Other' ? '' : val;
  wdRenderItems();
}

function wdOnItemStaffOtherChange(key, value) {
  const i = wdItemIndex(key); if (i < 0) return;
  wdItems[i].staff = value;
}

// Fully open-ended, replacing the paper sheet's single "Other Specify" row.
function wdAddCustomItem() {
  wdCustomSeq += 1;
  wdItems.push({ key: 'custom-' + Date.now() + '-' + wdCustomSeq, label: '', state: 'not_started', staff: '', remarks: '', done_date: null, custom: true, auto: false });
  wdRenderItems();
  const inputs = wdEl('wd-items-list').querySelectorAll('.wd-item-label-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// ── Drawer open/close/load ──
function wdLoadIntoDrawer(existing, keepClientTyped) {
  wdSuppressKeyWatch = true;
  wdEditingId = existing.id;
  wdEl('wd-drawer-title').textContent = `Edit — ${existing.client_name}`;

  if (!keepClientTyped) {
    wdEl('wd-client-search').value = existing.client_name || '';
    wdEl('wd-client-pan').value = existing.client_pan || '';
    wdSelectedClient = (window.clientsList || []).find(c => c.id === existing.client_id) || null;
  }
  wdEl('wd-fiscal-year').value = existing.fiscal_year || WD_FY_DEFAULT;
  wdEl('wd-recorded-date').value = existing.recorded_date || wdToday();
  wdEl('wd-remarks').value = existing.remarks || '';

  wdItems = wdMergeItems(existing.items, existing.client_id, existing.fiscal_year);
  wdRenderItems();
  wdRenderReceived();
  wdSuppressKeyWatch = false;
}

function wdOpenEntry(existing, preset) {
  wdSuppressKeyWatch = true;
  wdEditingId = null;
  wdAutoMatched = false;
  wdSelectedClient = null;
  wdItems = [];
  wdEl('wd-drawer-title').textContent = existing ? `Edit — ${existing.client_name}` : 'New Work Record';
  wdEl('wd-drawer-status').innerHTML = '';

  wdEl('wd-client-search').value = '';
  wdEl('wd-client-pan').value = '';
  wdEl('wd-fiscal-year').value = WD_FY_DEFAULT;
  wdEl('wd-recorded-date').value = wdToday();
  wdEl('wd-remarks').value = '';
  wdRenderItems();
  wdRenderReceived();
  wdSuppressKeyWatch = false;

  // An explicit Edit is never auto-matched, so changing the fiscal year inside
  // it edits THIS record rather than jumping to another one.
  if (existing) {
    wdLoadIntoDrawer(existing, false);
  } else if (preset && preset.client) {
    // Arrived from the Pending List: seed client + year, then let the normal
    // auto-match decide between an existing record and a fresh template.
    wdSuppressKeyWatch = true;
    wdSelectedClient = preset.client;
    wdEl('wd-client-search').value = preset.client.name || '';
    wdEl('wd-client-pan').value = preset.client.pan || '';
    if (preset.fiscalYear) wdEl('wd-fiscal-year').value = preset.fiscalYear;
    wdSuppressKeyWatch = false;
    wdMatchExistingRecord();
  }

  wdEl('wd-entry-drawer').classList.add('open');
}

function wdCloseEntry() { wdEl('wd-entry-drawer').classList.remove('open'); }

async function wdSaveEntry() {
  const drawerErr = msg => showStatus(escHtml(msg), 'info', 'wd-drawer-status');
  const clientName = wdEl('wd-client-search').value.trim();
  if (!clientName) { drawerErr('Enter or select a client.'); return; }
  // Keep client_id only while the typed name still matches the picked client —
  // a hand-edited name means no client_id, and this table requires one.
  const clientId = (wdSelectedClient && wdSelectedClient.name === clientName) ? wdSelectedClient.id : null;
  if (!clientId) { drawerErr('Pick a client from the list — this module only tracks directory clients.'); return; }
  const fiscalYear = wdEl('wd-fiscal-year').value;
  if (!fiscalYear) { drawerErr('Choose a fiscal year.'); return; }

  // Catches every path into a UNIQUE (client, fiscal year) collision so the
  // user sees this instead of a raw Postgres constraint error.
  const clash = wdFindRecord(clientId, fiscalYear);
  if (clash && clash.id !== wdEditingId) {
    drawerErr(`${clientName} already has a work record for ${fiscalYear}. Open that record to edit it.`);
    return;
  }

  if (!wdItems.length) { drawerErr('Add at least one work row before saving — use “+ Add work…” or Add Custom Work.'); return; }
  const blankCustom = wdItems.find(i => i.custom && !(i.label || '').trim());
  if (blankCustom) { drawerErr('Give each custom work row a name, or remove it.'); return; }

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: wdEl('wd-client-pan').value.trim() || null,
    fiscal_year: fiscalYear,
    recorded_date: wdEl('wd-recorded-date').value || wdToday(),
    // Explicit field list — this is what strips the transient _other flag.
    items: wdItems.map(i => ({
      key: i.key,
      label: (i.label || '').trim(),
      state: i.state || 'not_started',
      staff: (i.staff || '').trim(),
      remarks: (i.remarks || '').trim(),
      done_date: i.state === 'done' ? (i.done_date || wdToday()) : null,
      custom: !!i.custom,
      auto: !!i.auto,
    })),
    remarks: wdEl('wd-remarks').value.trim() || null,
    updated_by: wdUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'wd-drawer-status');
  try {
    if (wdEditingId) {
      // Explicit insert-or-update, not upsert — an upsert would silently
      // overwrite created_by on every edit.
      const { error } = await window.sb.from('work_done').update(payload).eq('id', wdEditingId);
      if (error) throw error;
      AuditLog.record('wd_updated', { module: 'workDone', clientName, recordRef: wdEditingId, detail: { fiscalYear } });
    } else {
      payload.created_by = wdUserEmail();
      const { data, error } = await window.sb.from('work_done').insert(payload).select('id').single();
      if (error) throw error;
      AuditLog.record('wd_created', { module: 'workDone', clientName, recordRef: data.id, detail: { fiscalYear } });
    }
    wdCloseEntry();
    await wdRefresh();
    wdStatusMsg(`✅ Work record saved for ${escHtml(clientName)}.`, 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'wd-drawer-status');
  }
}

async function wdDeleteEntry(row) {
  if (!confirm(`Delete the work record for ${row.client_name || 'this client'} (${row.fiscal_year})? This cannot be undone.`)) return;
  const { error } = await window.sb.from('work_done').delete().eq('id', row.id);
  if (error) { wdStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('wd_deleted', { module: 'workDone', clientName: row.client_name, recordRef: row.id });
  await wdRefresh();
}

// ── Export models ──
// Item counts vary per record (custom rows), so the export flattens each
// record's work list into readable text cells rather than one column per type
// — the same reasoning as Audit Checklist's export.
function wdItemsSummary(row, state) {
  const matched = (row.items || []).filter(i => (i.state || 'not_started') === state);
  if (!matched.length) return '—';
  return matched.map(i => {
    const who = i.staff ? ` (${i.staff})` : '';
    const note = i.remarks ? ` — ${i.remarks}` : '';
    return `${i.label}${who}${note}`;
  }).join('; ');
}

function wdBuildModel(rows, titleSuffix) {
  const subtitles = [`Generated ${wdToday()}`];
  if (wdFilters.from || wdFilters.to) {
    subtitles.push(`Recorded ${wdFilters.from || 'the beginning'} to ${wdFilters.to || 'today'}`);
  }
  if (wdFilters.staff) subtitles.push(`Staff: ${wdFilters.staff}`);
  return {
    title: 'Work Done' + (titleSuffix ? ' — ' + titleSuffix : ''),
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'Recorded', w: 1 }, { label: 'FY', w: 0.8 }, { label: 'Client', w: 1.9 }, { label: 'PAN', w: 0.95 },
      { label: 'Progress', w: 0.7 }, { label: 'Status', w: 1.05 },
      { label: 'Done', w: 2.6 }, { label: 'In Progress', w: 1.8 }, { label: 'Not Started', w: 1.8 }, { label: 'Remarks', w: 1.4 },
    ],
    rows: rows.map(r => {
      const { done, total } = wdProgress(r);
      return { cells: [
        r.recorded_date, r.fiscal_year, r.client_name, r.client_pan,
        `${done}/${total}`, WD_RECORD_STATUSES[wdStatusKey(r)].label,
        wdItemsSummary(r, 'done'), wdItemsSummary(r, 'in_progress'), wdItemsSummary(r, 'not_started'),
        r.remarks,
      ] };
    }),
    _filename: 'Work Done' + (titleSuffix ? ' - ' + titleSuffix : ''),
  };
}

function wdBuildPendingModel(rows) {
  const subtitles = ['Files received in File In Out whose work is not yet done', `Generated ${wdToday()}`];
  if (wdUnknownFyCount) {
    subtitles.push(`${wdUnknownFyCount} File In Out entr${wdUnknownFyCount === 1 ? 'y has' : 'ies have'} no fiscal year recorded and ${wdUnknownFyCount === 1 ? 'is' : 'are'} shown as FY —`);
  }
  return {
    title: 'Work Done — Pending List',
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'Waiting (days)', align: 'r', num: true, w: 0.9 },
      { label: 'Client', w: 2.0 }, { label: 'PAN', w: 1.0 }, { label: 'FY', w: 0.75 },
      { label: 'Work Type', w: 1.5 }, { label: 'State', w: 1.0 }, { label: 'Staff', w: 1.0 },
      { label: 'Register No', w: 1.2 }, { label: 'Received', w: 1.0 }, { label: 'File Status', w: 1.0 },
    ],
    rows: rows.map(p => ({ cells: [
      p.days == null ? '—' : p.days,
      p.clientName, p.clientPan, p.fiscalYear,
      p.workLabel, wdStateMeta(p.state).label, p.staff || '—',
      p.registerNo, p.received || '—', p.fmStatus,
    ] })),
    _filename: 'Work Done - Pending List',
  };
}

// Whichever view is on screen is what the header buttons act on, so Print,
// PDF and Excel always match what the user is looking at.
function wdActiveModel() {
  if (wdView === 'pending') {
    const rows = wdPendingRows();
    return rows.length ? wdBuildPendingModel(rows) : null;
  }
  wdReadFilters();
  const rows = wdCurrentFilteredRows();
  return rows.length ? wdBuildModel(rows) : null;
}

async function wdExport(kind) {
  const model = wdActiveModel();
  if (!model) { wdStatusMsg('Nothing to export for the current view.', 'info'); return; }
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'workDone',
      clientName: wdView === 'pending' ? 'Pending List' : 'Filtered Records',
      sheetName: wdView === 'pending' ? 'Pending' : 'Work Done',
    });
  } catch (e) {
    wdStatusMsg('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Print / Preview ──
// Opens a plain print window over the same model the Excel/PDF export uses
// (ReportExport.toHtml), so Preview and an exported file can never disagree —
// the ARF / Audit Checklist idiom.
function wdOpenPrintWindow(model) {
  const w = window.open('', '_blank');
  if (!w) { wdStatusMsg('Allow pop-ups to print.', 'info'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(model.title)}</title>
    <style>body{font-family:Inter,Arial,sans-serif;margin:28px;color:#1a202c;}
    table{border-collapse:collapse;width:100%;font-size:11px;}
    th,td{border:1px solid #d9dce5;padding:5px 8px;}
    th{background:#f3f5fb;color:#0b1f3d;}
    @page{size:A4 landscape;margin:12mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  // The browser's own print dialog offers "Save as PDF" — that is the
  // preview's save-to-PDF path, not a separate feature to build.
  setTimeout(() => w.print(), 300);
  AuditLog.record('wd_printed', { module: 'workDone' });
}

function wdPreviewAll() {
  const model = wdActiveModel();
  if (!model) { wdStatusMsg('Nothing to preview for the current view.', 'info'); return; }
  wdOpenPrintWindow(model);
}

function wdPrintOne(row) {
  wdOpenPrintWindow(wdBuildModel([row], row.client_name));
}

// ════════════════════════════════════════════
//  ACTIVITY LOG — what the firm has done for a client, ACROSS EVERY MODULE
//
//  The rest of this module answers "what work is finished on this client's
//  file". The Activity Log answers the wider question the same person asks
//  next: what has anyone here actually DONE for this client — a projection
//  generated, an invoice raised, a VAT filing updated, a document printed —
//  regardless of which module did it.
//
//  It reads audit_log, which every module already writes to through
//  AuditLog.record() (js/core/auditLog.js), so this is a READ-ONLY VIEW over
//  data that already exists. No new table, no new writes, and no module has
//  to be modified to appear here: anything that records an audit event shows
//  up the day it ships.
//
//  It lives in Work Done rather than the Dashboard because the Dashboard's
//  activity feed is a 10-row "what just happened" glance for the whole firm,
//  while this is the searchable per-client / per-work / per-staff history.
//
//  THE WINDOW IS BOUNDED ON PURPOSE. audit_log only grows (1,800+ rows in
//  the first month, 861 of them one module's corrections), so the log opens
//  on a fixed recent window and widens only when the user asks for a range —
//  an unbounded read here would get slower every week it runs.
// ════════════════════════════════════════════

const WD_ACTIVITY_DEFAULT_DAYS = 90;

// Repeats of the SAME work on the SAME client inside this gap are one entry.
// Re-running a projection eight times while getting the figures right is one
// piece of work, not eight, and logging it eight times buried the days when
// something was actually finished. See wdActivityCollapse().
const WD_ACTIVITY_MERGE_HOURS = 3;

let wdActivityRows = [];       // raw audit_log rows for the loaded window
let wdActivityEntries = [];    // after saved-only filtering + repeat merging
let wdActivityTable = null;
let wdActivityLoaded = false;  // false until the first load, so re-open is instant
let wdActivityFilters = { module: '', staff: '', client: '', from: '', to: '' };

function wdModuleLabel(m) { return (window.MODULE_LABELS || {})[m] || m || '—'; }
function wdEventLabel(e) { return (window.ACTIVITY_EVENT_LABELS || {})[e] || e || '—'; }

// "Staff" in audit_log is the signed-in email — the only identity the log
// carries. The local part is what people recognise; the full address stays
// in the title and in the export, so two staff at the same firm domain are
// still distinguishable.
function wdActivityStaff(row) { return (row.user_email || '').split('@')[0] || '—'; }

function wdDaysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── What counts as work for this module ──
// Some modules log an event per export as well as per save. Where the firm
// has said only the database write counts (window.ACTIVITY_SAVED_ONLY), the
// rest is dropped from the log. A module not listed there is unrestricted,
// so a newly added module shows everything by default rather than silently
// showing nothing.
function wdActivityIsPersisted(row) {
  const allowed = (window.ACTIVITY_SAVED_ONLY || {})[row.module];
  return !allowed || allowed.includes(row.event_type);
}

// ── Merge repeats of the same work on the same client ──
// Keyed on (client, module, event type): the same job done again for the same
// client is a repeat; the same job for a DIFFERENT client is separate work.
//
// The window is measured GAP-TO-GAP, not from the newest event: a continuous
// session with 2-hour pauses is one piece of work however long it runs, which
// is the case the firm actually hit (testing a projection, adjusting it, re-
// running it). An anchor-based window would instead break that session into
// an arbitrary entry every 3 hours.
//
// The NEWEST event of a run is the one kept — "if I altered or re-made the
// work, only the latest counts" — and the ones folded into it are counted on
// the row (×N) rather than silently discarded, so the log never claims work
// happened once when it happened eight times.
function wdActivityCollapse(rows) {
  const windowMs = WD_ACTIVITY_MERGE_HOURS * 3600000;
  // Sort explicitly rather than trusting the query's order — this is the one
  // place where a wrong order would silently keep the wrong event.
  const sorted = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const keptOf = new Map();     // key → the entry the run is folding into
  const lastTsOf = new Map();   // key → timestamp of the most recent event absorbed
  const out = [];

  sorted.forEach(r => {
    const key = [r.client_name || '~', r.module || '~', r.event_type || '~'].join('|');
    const ts = new Date(r.created_at).getTime();
    const prevTs = lastTsOf.get(key);
    if (prevTs != null && (prevTs - ts) <= windowMs) {
      const kept = keptOf.get(key);
      kept._repeats += 1;
      kept._runStart = r.created_at;      // the run's oldest event so far
      lastTsOf.set(key, ts);
      return;
    }
    const entry = { ...r, _repeats: 1, _runStart: r.created_at };
    keptOf.set(key, entry);
    lastTsOf.set(key, ts);
    out.push(entry);
  });
  return out;
}

function wdActivityBuildEntries() {
  wdActivityEntries = wdActivityCollapse(wdActivityRows.filter(wdActivityIsPersisted));
}

function wdActivityOpen() {
  wdEl('wd-activity-modal').classList.add('open');
  if (!wdActivityLoaded) wdActivityLoad();
  else if (wdActivityTable) setTimeout(() => wdActivityTable.redraw(true), 0);
}

function wdActivityClose() { wdEl('wd-activity-modal').classList.remove('open'); }

// The From/To boxes are what widen the window, so the load has to read them —
// an empty From means "the default recent window", not "all history".
async function wdActivityLoad() {
  const from = wdEl('wd-activity-from').value;
  const to = wdEl('wd-activity-to').value;
  wdEl('wd-activity-status').innerHTML = '<div class="log-empty"><span class="spinner spinner-navy"></span> Loading activity…</div>';
  try {
    wdActivityRows = await AuditLog.query({
      sinceIso: from ? new Date(from + 'T00:00:00').toISOString() : wdDaysAgoIso(WD_ACTIVITY_DEFAULT_DAYS),
      // Inclusive of the whole "to" day — a date-only bound would cut that
      // day's events off at midnight and silently drop today's work.
      untilIso: to ? new Date(to + 'T23:59:59').toISOString() : null,
    });
    wdActivityLoaded = true;
    // Saved-only filtering and repeat-merging happen ONCE per load, before
    // any UI filter: the ×N count then means "how many times this was really
    // done", not "how many survived the filter that happens to be applied".
    wdActivityBuildEntries();
    wdActivityPopulateFilters();
    wdEl('wd-activity-status').innerHTML = '';
    wdActivityRenderTable();
  } catch (e) {
    wdEl('wd-activity-status').innerHTML = `<div class="status-box status-error">❌ Failed to load the activity log: ${escHtml(e.message || String(e))}</div>`;
  }
}

// Options come from what's actually in the loaded window, not a fixed list —
// a module nobody has touched this quarter would otherwise sit in the filter
// forever offering zero rows.
function wdActivityPopulateFilters() {
  const fill = (id, values, allLabel, labeller) => {
    const sel = wdEl(id);
    if (!sel) return;
    const cur = sel.value;
    // Sorted by the LABEL, not the raw value — the module list is stored as
    // camelCase ids, so sorting on those puts "Autobooks" (salesPurchaseBook)
    // between Projection and Work Done, which reads as unsorted on screen.
    const sorted = Array.from(new Set(values.filter(Boolean)))
      .sort((a, b) => String(labeller ? labeller(a) : a).localeCompare(String(labeller ? labeller(b) : b)));
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      sorted.map(v => `<option value="${escHtml(v)}">${escHtml(labeller ? labeller(v) : v)}</option>`).join('');
    if (sorted.includes(cur)) sel.value = cur;
  };
  // Built from the ENTRIES, not the raw rows: an option that can only match
  // events the log now hides would filter to nothing and look broken.
  fill('wd-activity-module', wdActivityEntries.map(r => r.module), 'All modules', wdModuleLabel);
  fill('wd-activity-staff', wdActivityEntries.map(r => r.user_email), 'All staff');
  fill('wd-activity-client', wdActivityEntries.map(r => r.client_name), 'All clients');
}

function wdActivityReadFilters() {
  wdActivityFilters = {
    module: wdEl('wd-activity-module').value,
    staff: wdEl('wd-activity-staff').value,
    client: wdEl('wd-activity-client').value,
    from: wdEl('wd-activity-from').value,
    to: wdEl('wd-activity-to').value,
  };
}

// Shared by the table AND the exports, so what's on screen and what leaves
// the app can never disagree (the same idiom as fmFilteredRows /
// wdCurrentFilteredRows).
function wdActivityFilteredRows() {
  let rows = wdActivityEntries.filter(r => {
    if (wdActivityFilters.module && r.module !== wdActivityFilters.module) return false;
    if (wdActivityFilters.staff && r.user_email !== wdActivityFilters.staff) return false;
    if (wdActivityFilters.client && r.client_name !== wdActivityFilters.client) return false;
    return true;
  });
  const q = (wdEl('wd-activity-search').value || '').trim();
  if (q) {
    // Searching the RAW event_type as well as the label: staff search for
    // what they see, but a developer chasing an event searches the code word.
    const indexed = rows.map(r => ({
      ...r,
      _eventLabel: wdEventLabel(r.event_type),
      _moduleLabel: wdModuleLabel(r.module),
    }));
    const fuse = SearchEngine.buildIndex(indexed, ['client_name', '_eventLabel', '_moduleLabel', 'event_type', 'user_email']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function wdActivityApplyFilters() {
  wdActivityReadFilters();
  const rows = wdActivityFilteredRows();
  wdActivityUpdateCount(rows.length);
  if (wdActivityTable) wdActivityTable.replaceData(rows);
}

// Changing the date range needs a re-FETCH, not just a re-filter — the rows
// outside the loaded window aren't in memory to filter.
function wdActivityRangeChanged() { wdActivityLoad(); }

function wdActivityClearFilters() {
  ['wd-activity-module', 'wd-activity-staff', 'wd-activity-client', 'wd-activity-search'].forEach(id => {
    const el = wdEl(id); if (el) el.value = '';
  });
  wdActivityApplyFilters();
}

// Says how much was folded away, so a collapsed log never looks like a log
// that lost data.
function wdActivityUpdateCount(shown) {
  const el = wdEl('wd-activity-count');
  if (!el) return;
  const total = wdActivityEntries.length;
  if (!total) { el.textContent = ''; return; }
  const merged = wdActivityEntries.reduce((n, r) => n + (r._repeats - 1), 0);
  const hidden = wdActivityRows.length - wdActivityRows.filter(wdActivityIsPersisted).length;
  const notes = [];
  if (merged) notes.push(`${merged} repeat${merged === 1 ? '' : 's'} merged`);
  if (hidden) notes.push(`${hidden} non-saved hidden`);
  el.textContent = `${shown} of ${total} entr${total === 1 ? 'y' : 'ies'}` +
    (shown === total ? '' : ' (filtered)') +
    (notes.length ? ` · ${notes.join(', ')}` : '');
}

function wdActivityWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function wdActivityRenderTable() {
  const wrap = wdEl('wd-activity-wrap');
  if (wdActivityTable) { wdActivityTable.destroy(); wdActivityTable = null; }
  if (!wdActivityEntries.length) {
    // "Nothing happened" and "everything that happened was a non-saved step"
    // are different answers, and the second one is the one that looks like a
    // bug if it isn't said out loud.
    const suppressed = wdActivityRows.length;
    wrap.innerHTML = suppressed
      ? `<div class="log-empty">No saved work in this period. ${suppressed} event${suppressed === 1 ? '' : 's'} were recorded, but they were all generate/print/download steps in modules that only log database saves.</div>`
      : `<div class="log-empty">No activity recorded in this period. Widen the date range above to look further back.</div>`;
    wdActivityUpdateCount(0);
    return;
  }
  wrap.innerHTML = '';
  wdActivityTable = TableEngine.createTable(wrap, {
    data: wdActivityFilteredRows(),
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    columns: [
      { title: 'When', field: 'created_at', width: 150, formatter: c => escHtml(wdActivityWhen(c.getValue())) },
      { title: 'Client', field: 'client_name', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Module', field: 'module', width: 165, formatter: c => escHtml(wdModuleLabel(c.getValue())) },
      { title: 'Work Done', field: 'event_type', minWidth: 210, formatter: c => {
          const r = c.getRow().getData();
          const failed = r.status === 'error';
          // The ×N chip is what keeps the merge honest: the entry shows the
          // latest run, and says how many runs it stands for.
          const repeat = r._repeats > 1
            ? `<span class="wd-activity-repeat" title="Done ${r._repeats} times between ${escHtml(wdActivityWhen(r._runStart))} and ${escHtml(wdActivityWhen(r.created_at))} — shown as the latest">×${r._repeats}</span>`
            : '';
          return `<span class="log-badge ${failed ? 'badge-error' : 'badge-sent'}" title="${escHtml(r.event_type || '')}">${failed ? '❌' : '✅'} ${escHtml(wdEventLabel(r.event_type))}</span>${repeat}`;
        } },
      { title: 'Staff', field: 'user_email', width: 130, formatter: c => {
          const r = c.getRow().getData();
          return `<span title="${escHtml(r.user_email || '')}">${escHtml(wdActivityStaff(r))}</span>`;
        } },
      { title: 'Ref', field: 'record_ref', width: 90, formatter: c => escHtml(c.getValue() == null ? '—' : String(c.getValue())) },
    ],
  });
  wdActivityUpdateCount(wdActivityFilteredRows().length);
}

// ── Activity Log export (same ReportExport model → Print / PDF / Excel) ──
function wdActivityBuildModel(rows) {
  const subtitles = ['Work recorded across all modules, newest first'];
  const range = wdActivityFilters.from || wdActivityFilters.to
    ? `${wdActivityFilters.from || 'the beginning'} to ${wdActivityFilters.to || 'today'}`
    : `last ${WD_ACTIVITY_DEFAULT_DAYS} days`;
  subtitles.push(`Period: ${range}`);
  // The exported sheet has to carry the same caveat as the screen, or a
  // printed copy reads as a complete event list when it is a merged one.
  subtitles.push(`Repeats of the same work on the same client within ${WD_ACTIVITY_MERGE_HOURS} hours are shown once, as the latest (Times column)`);
  if (wdActivityFilters.client) subtitles.push(`Client: ${wdActivityFilters.client}`);
  if (wdActivityFilters.module) subtitles.push(`Module: ${wdModuleLabel(wdActivityFilters.module)}`);
  if (wdActivityFilters.staff) subtitles.push(`Staff: ${wdActivityFilters.staff}`);
  subtitles.push(`Generated ${wdToday()}`);
  return {
    title: 'Activity Log',
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'When', w: 1.3 }, { label: 'Client', w: 2.0 }, { label: 'Module', w: 1.4 },
      { label: 'Work Done', w: 1.8 }, { label: 'Times', w: 0.5, align: 'r' }, { label: 'Staff', w: 1.6 },
      { label: 'Status', w: 0.7 }, { label: 'Ref', w: 0.6 },
    ],
    rows: rows.map(r => ({ cells: [
      wdActivityWhen(r.created_at), r.client_name || '—', wdModuleLabel(r.module),
      wdEventLabel(r.event_type), String(r._repeats || 1), r.user_email || '—',
      r.status === 'error' ? 'Failed' : 'Success', r.record_ref == null ? '—' : String(r.record_ref),
    ] })),
    _filename: 'Activity Log' + (wdActivityFilters.client ? ' - ' + wdActivityFilters.client : ''),
  };
}

function wdActivityModel() {
  wdActivityReadFilters();
  const rows = wdActivityFilteredRows();
  return rows.length ? wdActivityBuildModel(rows) : null;
}

function wdActivityPreview() {
  const model = wdActivityModel();
  if (!model) { wdEl('wd-activity-status').innerHTML = '<div class="status-box status-info">Nothing to preview for the current filters.</div>'; return; }
  wdOpenPrintWindow(model);
}

async function wdActivityExport(kind) {
  const model = wdActivityModel();
  if (!model) { wdEl('wd-activity-status').innerHTML = '<div class="status-box status-info">Nothing to export for the current filters.</div>'; return; }
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'workDone',
      clientName: wdActivityFilters.client || 'All Clients',
      sheetName: 'Activity Log',
    });
  } catch (e) {
    wdEl('wd-activity-status').innerHTML = `<div class="status-box status-error">❌ Failed to export: ${escHtml(e.message || String(e))}</div>`;
  }
}
