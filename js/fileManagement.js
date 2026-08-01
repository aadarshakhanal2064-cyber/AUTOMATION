// ════════════════════════════════════════════
//  FILE MANAGEMENT — Document Register
//  Custody log for the PHYSICAL documents clients hand over (purchase/sales
//  files, ledgers, confirmations, interest certificates, ...): what came in,
//  who brought it, and — once the work is done — who collected it back. A
//  stock register for paper, so nothing sits in the office unaccounted for.
//
//  One row per visit, updated in place on handover rather than a paired
//  "returns" row: a bundle received and a bundle given back are the same
//  physical custody, and splitting them would let the two sides disagree
//  about what is still held. Everything a return records (date, collector,
//  remarks) is written by the SAME status transition that flips the badge,
//  through fmFlow — the one choke point, mirroring vatCompliance.js.
//
//  Deliberately NOT tied to Google Drive or the document-generation pipeline:
//  this tracks paper the firm is physically holding, which no digital record
//  can substitute for.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'fileManagement', group: 'main', buttonId: 'nav-fileManagement', panelId: 'tab-fileManagement-panel' });

const FM_STATUSES = {
  pending:  { label: 'With Us',  icon: '📥', badgeClass: 'badge-amber' },
  returned: { label: 'Returned', icon: '✅', badgeClass: 'badge-sent' },
};

// Flag intakes still held after this long — the register's whole point is
// that nothing quietly stays in the office forever.
const FM_AGEING_ALERT_DAYS = 30;

// The stat cards double as quick filters: one definition drives both the card
// counts and the table filtering, so they can never disagree (vatCompliance
// pattern).
const FM_FILTERS = {
  all:      { label: 'Total Entries', test: () => true },
  pending:  { label: 'With Us',       test: r => r.status === 'pending' },
  overdue:  { label: 'Held 30+ Days', test: r => fmDaysHeld(r) > FM_AGEING_ALERT_DAYS },
  returned: { label: 'Returned',      test: r => r.status === 'returned' },
};

const FM_FILTERS_EMPTY = { docType: '', from: '', to: '' };

let fmEntries = [];
let fmTable = null;
let fmSelectedClient = null;
let fmEditingId = null;
let fmReturningRow = null;
let fmActiveFilter = 'all';
let fmInitDone = false;
let fmFilters = { ...FM_FILTERS_EMPTY };

function fmUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function fmStatusMsg(html, type) { showStatus(html, type, 'fm-status-area'); }
function fmToday() { return new Date().toISOString().slice(0, 10); }

// Calendar days the firm has held (or held onto) this bundle. Returned rows
// report the actual custody span, not an ever-growing age.
function fmDaysHeld(row) {
  if (!row.date_received) return 0;
  const end = row.status === 'returned' && row.date_returned ? new Date(row.date_returned) : new Date();
  const days = Math.floor((end - new Date(row.date_received)) / 86400000);
  return days > 0 ? days : 0;
}

function fmDocSummary(row) {
  const types = Array.isArray(row.doc_types) ? row.doc_types.slice() : [];
  const list = types.map(t => (t === 'Others' && row.doc_other) ? row.doc_other : t);
  return list.length ? list.join(', ') : '—';
}

// Every status change — mark returned, reopen — goes through this one flow,
// which persists the row and writes the audit entry together.
const fmFlow = WorkflowEngine.createStatusFlow({
  statuses: FM_STATUSES,
  onTransition: async (row, from, to, ctx) => {
    const patch = Object.assign({ status: to, updated_by: fmUserEmail() }, ctx.patch);
    const { data, error } = await window.sb.from('document_register')
      .update(patch).eq('id', row.id).select().single();
    if (error) throw error;
    Object.assign(row, data);
    AuditLog.record('document_register_status_change', {
      module: 'fileManagement', clientName: row.client_name, recordRef: row.id,
      oldStatus: from, newStatus: to, registerNo: row.register_no,
    });
    return row;
  },
});

// ── Load & refresh ──
function fmInit() {
  if (!fmInitDone) {
    SearchEngine.attachAutocomplete(document.getElementById('fm-client-search'), document.getElementById('fm-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: fmSelectClient,
    });
    fmPopulateDocTypes();
    fmInitDone = true;
  }
  fmRefresh();
}

async function fmRefresh() {
  fmStatusMsg('<span class="spinner spinner-navy"></span> Loading document register…', 'searching');
  try {
    fmEntries = await sbFetchAll(() => window.sb.from('document_register')
      .select('*').order('created_at', { ascending: false }));
    fmRenderStats();
    fmRenderTable();
    document.getElementById('fm-status-area').innerHTML = '';
  } catch (e) {
    fmStatusMsg('❌ Failed to load the document register: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Stat cards (also the quick filters) ──
function fmRenderStats() {
  const grid = document.getElementById('fm-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(FM_FILTERS).map(([key, f]) => `
    <div class="stat-card clickable ${fmActiveFilter === key ? 'active-filter' : ''}" onclick="fmSetFilter('${key}')" title="Click to filter the table below">
      <div class="stat-num">${fmEntries.filter(f.test).length}</div>
      <div class="stat-label">${f.label}</div>
    </div>`).join('');
}

function fmSetFilter(key) {
  fmActiveFilter = key;
  fmRenderStats();
  fmApplyFilters();
}

// ── List table ──
function fmRenderTable() {
  const wrap = document.getElementById('fm-table-wrap');
  if (fmTable) { fmTable.destroy(); fmTable = null; }
  if (!fmEntries.length) {
    wrap.innerHTML = '<div class="log-empty">No documents recorded yet. Click <strong>Record Intake</strong> when a client brings files in.</div>';
    return;
  }
  wrap.innerHTML = '';
  fmTable = TableEngine.createTable(wrap, {
    data: fmEntries,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    // No initialSort: the query already returns newest-first, and created_at
    // isn't a displayed column so Tabulator would ignore a sort on it anyway.
    columns: [
      { title: 'Ref #', field: 'register_no', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Received', field: 'date_received', width: 110 },
      { title: 'Client', field: 'client_name', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'PAN', field: 'client_pan', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Documents', field: 'doc_types', minWidth: 210, headerSort: false, formatter: c => escHtml(fmDocSummary(c.getRow().getData())) },
      { title: 'Brought By', field: 'brought_by_name', minWidth: 150, formatter: c => {
          const r = c.getRow().getData();
          return escHtml(r.brought_by_name || '—') + (r.brought_by_phone ? `<br><span style="color:var(--text-faint); font-size:12px;">${escHtml(r.brought_by_phone)}</span>` : '');
        } },
      { title: 'Days', field: 'id', width: 80, hozAlign: 'right', headerSort: false, formatter: c => {
          const r = c.getRow().getData();
          const d = fmDaysHeld(r);
          const alert = r.status === 'pending' && d > FM_AGEING_ALERT_DAYS;
          return alert ? `<span style="color:var(--red); font-weight:700;">${d}</span>` : String(d);
        } },
      { title: 'Status', field: 'status', width: 130, formatter: c => fmFlow.badgeHtml(c.getValue()) },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 230, formatter: c => fmRowActions(c.getRow().getData()),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') fmOpenEntry(row);
          else if (btn.dataset.action === 'return') fmOpenReturn(row);
          else if (btn.dataset.action === 'reopen') fmReopen(row);
          else if (btn.dataset.action === 'delete') fmDeleteEntry(row);
        } },
    ],
  });
  fmApplyFilters();
}

function fmRowActions(row) {
  const btn = (a, label, title) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${title || label}">${label}</button>`;
  const mid = row.status === 'pending'
    ? btn('return', 'Hand Over', 'Record handover back to the client')
    : btn('reopen', 'Reopen', 'Undo the handover — documents are with us again');
  return `<div class="client-actions">${btn('edit', 'Edit')}${mid}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function fmPopulateDocTypes() {
  document.getElementById('fm-filter-doctype').innerHTML = '<option value="">All documents</option>' +
    window.FM_DOC_TYPES.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
  document.getElementById('fm-doc-types').innerHTML = window.FM_DOC_TYPES.map(t => `
    <label class="checkbox-label">
      <input type="checkbox" class="fm-doc-type" value="${escHtml(t)}" onchange="fmOnDocTypeChange()" /> ${escHtml(t)}
    </label>`).join('');
}

function fmReadFilters() {
  fmFilters = {
    docType: document.getElementById('fm-filter-doctype').value,
    from: document.getElementById('fm-filter-from').value,
    to: document.getElementById('fm-filter-to').value,
  };
}

function fmApplyFilters() {
  if (!fmTable) return;
  const cardTest = FM_FILTERS[fmActiveFilter].test;
  let rows = fmEntries.filter(r => {
    if (!cardTest(r)) return false;
    if (fmFilters.docType && !(Array.isArray(r.doc_types) && r.doc_types.includes(fmFilters.docType))) return false;
    if (fmFilters.from && (r.date_received || '') < fmFilters.from) return false;
    if (fmFilters.to && (r.date_received || '') > fmFilters.to) return false;
    return true;
  });
  const q = (document.getElementById('fm-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['register_no', 'client_name', 'client_pan', 'brought_by_name', 'brought_by_phone', 'returned_to_name', 'doc_other', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  fmTable.replaceData(rows);
}

function fmOnFilterChange() { fmReadFilters(); fmApplyFilters(); }

function fmClearFilters() {
  ['fm-filter-doctype', 'fm-filter-from', 'fm-filter-to', 'fm-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  fmFilters = { ...FM_FILTERS_EMPTY };
  fmActiveFilter = 'all';
  fmRenderStats();
  fmApplyFilters();
}

// ── Intake drawer (create / edit) ──
function fmSelectClient(c) {
  fmSelectedClient = c;
  document.getElementById('fm-client-search').value = c.name;
  document.getElementById('fm-client-pan').value = c.pan || '';
}

function fmOnDocTypeChange() {
  const others = Array.from(document.querySelectorAll('.fm-doc-type')).some(cb => cb.checked && cb.value === 'Others');
  document.getElementById('fm-doc-other-group').style.display = others ? '' : 'none';
}

function fmCheckedDocTypes() {
  return Array.from(document.querySelectorAll('.fm-doc-type')).filter(cb => cb.checked).map(cb => cb.value);
}

function fmOpenEntry(existing) {
  fmEditingId = existing ? existing.id : null;
  fmSelectedClient = null;
  document.getElementById('fm-drawer-title').textContent = existing ? `Edit ${existing.register_no || 'Intake'}` : 'Record Document Intake';
  document.getElementById('fm-drawer-status').innerHTML = '';

  const types = existing && Array.isArray(existing.doc_types) ? existing.doc_types : [];
  document.querySelectorAll('.fm-doc-type').forEach(cb => { cb.checked = types.includes(cb.value); });
  fmOnDocTypeChange();

  document.getElementById('fm-date-received').value = existing ? existing.date_received : fmToday();
  document.getElementById('fm-client-search').value = existing ? (existing.client_name || '') : '';
  document.getElementById('fm-client-pan').value = existing ? (existing.client_pan || '') : '';
  document.getElementById('fm-doc-other').value = existing ? (existing.doc_other || '') : '';
  document.getElementById('fm-brought-name').value = existing ? (existing.brought_by_name || '') : '';
  document.getElementById('fm-brought-phone').value = existing ? (existing.brought_by_phone || '') : '';
  document.getElementById('fm-remarks').value = existing ? (existing.remarks || '') : '';

  if (existing && existing.client_id) {
    const c = (window.clientsList || []).find(x => x.id === existing.client_id);
    if (c) fmSelectedClient = c;
  }

  document.getElementById('fm-entry-drawer').classList.add('open');
}

function fmCloseEntry() { document.getElementById('fm-entry-drawer').classList.remove('open'); }

async function fmSaveEntry() {
  const drawerErr = msg => showStatus(escHtml(msg), 'info', 'fm-drawer-status');
  const clientName = document.getElementById('fm-client-search').value.trim();
  if (!clientName) { drawerErr('Enter or select a client.'); return; }
  const broughtBy = document.getElementById('fm-brought-name').value.trim();
  if (!broughtBy) { drawerErr('Enter who brought the documents.'); return; }
  const docTypes = fmCheckedDocTypes();
  if (!docTypes.length) { drawerErr('Tick at least one document type.'); return; }
  const docOther = document.getElementById('fm-doc-other').value.trim();
  if (docTypes.includes('Others') && !docOther) { drawerErr('Describe the "Others" document.'); return; }

  // Keep client_id only while the name still matches the picked client — a
  // hand-edited name becomes a typed-only (nullable) client.
  const clientId = (fmSelectedClient && fmSelectedClient.name === clientName) ? fmSelectedClient.id : null;

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: document.getElementById('fm-client-pan').value.trim() || null,
    date_received: document.getElementById('fm-date-received').value || fmToday(),
    doc_types: docTypes,
    doc_other: docOther || null,
    brought_by_name: broughtBy,
    brought_by_phone: document.getElementById('fm-brought-phone').value.trim() || null,
    remarks: document.getElementById('fm-remarks').value.trim() || null,
    updated_by: fmUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'fm-drawer-status');
  try {
    if (fmEditingId) {
      const { error } = await window.sb.from('document_register').update(payload).eq('id', fmEditingId);
      if (error) throw error;
      AuditLog.record('document_register_updated', { module: 'fileManagement', clientName, recordRef: fmEditingId });
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('document_register').insert(payload).select('id').single();
      if (error) throw error;
      // register_no is filled by an AFTER INSERT trigger, so it isn't in this
      // returned row — fmRefresh() below reloads it. (Same gotcha as invoices.)
      AuditLog.record('document_register_created', { module: 'fileManagement', clientName, recordRef: data.id });
    }
    fmCloseEntry();
    await fmRefresh();
    fmStatusMsg('✅ Document intake saved.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'fm-drawer-status');
  }
}

async function fmDeleteEntry(row) {
  if (!confirm(`Delete register entry ${row.register_no || ''} for ${row.client_name || 'this client'}? This cannot be undone.`)) return;
  const { error } = await window.sb.from('document_register').delete().eq('id', row.id);
  if (error) { fmStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('document_register_deleted', { module: 'fileManagement', clientName: row.client_name, recordRef: row.id });
  await fmRefresh();
}

// ── Handover (pending -> returned) ──
function fmOpenReturn(row) {
  fmReturningRow = row;
  document.getElementById('fm-return-summary').innerHTML =
    `<strong>${escHtml(row.register_no || '—')}</strong> · ${escHtml(row.client_name || '—')}<br>` +
    `<span style="color:var(--text-muted);">${escHtml(fmDocSummary(row))}</span><br>` +
    `<span style="color:var(--text-faint); font-size:12.5px;">Received ${escHtml(row.date_received || '—')} from ${escHtml(row.brought_by_name || '—')} · held ${fmDaysHeld(row)} days</span>`;
  document.getElementById('fm-return-date').value = fmToday();
  document.getElementById('fm-return-name').value = row.brought_by_name || '';
  document.getElementById('fm-return-phone').value = row.brought_by_phone || '';
  document.getElementById('fm-return-remarks').value = '';
  document.getElementById('fm-return-status').innerHTML = '';
  document.getElementById('fm-return-modal').classList.add('open');
}

function fmCloseReturn() { document.getElementById('fm-return-modal').classList.remove('open'); }

async function fmConfirmReturn() {
  if (!fmReturningRow) return;
  const name = document.getElementById('fm-return-name').value.trim();
  if (!name) { showStatus('Enter who collected the documents.', 'info', 'fm-return-status'); return; }

  showStatus('<span class="spinner spinner-navy"></span> Recording handover…', 'searching', 'fm-return-status');
  try {
    await fmFlow.transition(fmReturningRow, 'returned', { patch: {
      date_returned: document.getElementById('fm-return-date').value || fmToday(),
      returned_to_name: name,
      returned_to_phone: document.getElementById('fm-return-phone').value.trim() || null,
      return_remarks: document.getElementById('fm-return-remarks').value.trim() || null,
    } });
    fmCloseReturn();
    await fmRefresh();
    fmStatusMsg('✅ Handover recorded — documents returned to the client.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Failed to record the handover'), 'error', 'fm-return-status');
  }
}

// Undo a handover recorded in error: the documents are physically back with
// us, so the collector details are cleared rather than kept as stale history.
async function fmReopen(row) {
  if (!confirm(`Reopen ${row.register_no || 'this entry'}? It will show as still with us, and the handover details will be cleared.`)) return;
  try {
    await fmFlow.transition(row, 'pending', { patch: {
      date_returned: null, returned_to_name: null, returned_to_phone: null, return_remarks: null,
    } });
    await fmRefresh();
    fmStatusMsg('✅ Entry reopened — shown as still with us.', 'success');
  } catch (e) {
    fmStatusMsg('❌ ' + escHtml(e.message || 'Failed to reopen the entry'), 'error');
  }
}
