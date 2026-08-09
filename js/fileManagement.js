// ════════════════════════════════════════════
//  FILE IN OUT — Document Register (display renamed 2026-08-09; code kept
//  as fileManagement.js / fm- / document_register — the Autobooks/Bank Entry
//  label-only precedent, CLAUDE.md §5).
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
//  2026-08-09: added Fiscal Year (auto-derived from Date Received, editable)
//  and an Online (email) / Physical (person) delivery mode, tracked
//  independently for intake and handover — a client can drop files off in
//  person and the firm can email them back, or the reverse. doc_types moved
//  from a flat picklist array to {type, qty} objects so the register can
//  show real counts ("Ledger x2"), matching the firm's paper form.
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

const FM_FILTERS_EMPTY = { docType: '', fy: '', from: '', to: '' };

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

// date_received is a real AD date; the dash fiscal-year format (majority
// convention — Bank Entry, Party Ledger, Depreciation) is B.S.-boundary
// aware, so this goes through the same AD->BS chain as Party Ledger's memo
// dates (NepaliLocale.adToBs is exactly this: a Gregorian Postgres date that
// still needs a B.S. fiscal year).
function fmFyFromDate(dateStr) {
  if (!dateStr) return '';
  const bs = NepaliLocale.adToBs(dateStr);
  return bs ? (NepaliLocale.bsFyDash(NepaliLocale.bsToStr(bs)) || '') : '';
}

function fmDocSummary(row) {
  const types = Array.isArray(row.doc_types) ? row.doc_types : [];
  if (!types.length) return '—';
  return types.map(t => {
    if (typeof t === 'string') return t; // legacy rows saved before quantities existed
    return `${t.type}${t.qty && t.qty !== 1 ? ` ×${t.qty}` : ''}`;
  }).join(', ');
}

// One cell renderer for both "Received From" and "Returned To" — same shape,
// different field prefix, so intake and handover contact info never drift
// into two different display rules.
function fmContactCell(row, side) {
  if (side === 'returned' && row.status !== 'returned') return '—';
  const mode = side === 'received' ? row.mode_received : row.mode_returned;
  if (mode === 'online') {
    const email = side === 'received' ? row.email_received : row.email_sent;
    return `📧 ${escHtml(email || '—')}`;
  }
  const name = side === 'received' ? row.brought_by_name : row.returned_to_name;
  const phone = side === 'received' ? row.brought_by_phone : row.returned_to_phone;
  return `🧍 ${escHtml(name || '—')}` + (phone ? `<br><span style="color:var(--text-faint); font-size:12px;">${escHtml(phone)}</span>` : '');
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
    fmPopulateFyFilter();
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
      { title: 'Ref #', field: 'register_no', width: 100, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'FY', field: 'fiscal_year', width: 85, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Received', field: 'date_received', width: 105 },
      { title: 'Client', field: 'client_name', minWidth: 160, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'PAN', field: 'client_pan', width: 105, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Documents', field: 'doc_types', minWidth: 220, headerSort: false, formatter: c => escHtml(fmDocSummary(c.getRow().getData())) },
      { title: 'Received From', field: 'brought_by_name', minWidth: 160, headerSort: false, formatter: c => fmContactCell(c.getRow().getData(), 'received') },
      { title: 'Days', field: 'id', width: 75, hozAlign: 'right', headerSort: false, formatter: c => {
          const r = c.getRow().getData();
          const d = fmDaysHeld(r);
          const alert = r.status === 'pending' && d > FM_AGEING_ALERT_DAYS;
          return alert ? `<span style="color:var(--red); font-weight:700;">${d}</span>` : String(d);
        } },
      { title: 'Status', field: 'status', width: 120, formatter: c => fmFlow.badgeHtml(c.getValue()) },
      { title: 'Returned To', field: 'returned_to_name', minWidth: 160, headerSort: false, formatter: c => fmContactCell(c.getRow().getData(), 'returned') },
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
    window.FM_DOC_TYPES.map(t => `<option value="${escHtml(t.label)}">${escHtml(t.label)}</option>`).join('');
  document.getElementById('fm-doc-types').innerHTML = window.FM_DOC_TYPES.map(t => `
    <div class="fm-doctype-row">
      <label for="fm-qty-${t.key}">${escHtml(t.label)}</label>
      <div class="fm-doctype-qty">
        <input type="number" min="0" id="fm-qty-${t.key}" placeholder="0" />
        <span class="fm-doctype-unit">${escHtml(t.unit)}</span>
      </div>
    </div>`).join('');
}

// The Fiscal Year filter's options depend on what's actually in the data, so
// it's rebuilt from fmEntries on every refresh rather than a fixed list.
function fmPopulateFyFilter() {
  const sel = document.getElementById('fm-filter-fy');
  if (!sel) return;
  const cur = sel.value;
  const years = Array.from(new Set(fmEntries.map(r => r.fiscal_year).filter(Boolean))).sort().reverse();
  sel.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${escHtml(y)}">${escHtml(y)}</option>`).join('');
  if (years.includes(cur)) sel.value = cur;
}

function fmReadFilters() {
  fmFilters = {
    docType: document.getElementById('fm-filter-doctype').value,
    fy: document.getElementById('fm-filter-fy').value,
    from: document.getElementById('fm-filter-from').value,
    to: document.getElementById('fm-filter-to').value,
  };
}

function fmApplyFilters() {
  if (!fmTable) return;
  const cardTest = FM_FILTERS[fmActiveFilter].test;
  let rows = fmEntries.filter(r => {
    if (!cardTest(r)) return false;
    if (fmFilters.docType && !(Array.isArray(r.doc_types) && r.doc_types.some(t => (typeof t === 'string' ? t : t.type) === fmFilters.docType))) return false;
    if (fmFilters.fy && (r.fiscal_year || '') !== fmFilters.fy) return false;
    if (fmFilters.from && (r.date_received || '') < fmFilters.from) return false;
    if (fmFilters.to && (r.date_received || '') > fmFilters.to) return false;
    return true;
  });
  const q = (document.getElementById('fm-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['register_no', 'fiscal_year', 'client_name', 'client_pan', 'brought_by_name', 'brought_by_phone', 'email_received', 'returned_to_name', 'email_sent', 'remarks']);
    rows = fuse.search(q).map(r => r.item);
  }
  fmTable.replaceData(rows);
}

function fmOnFilterChange() { fmReadFilters(); fmApplyFilters(); }

function fmClearFilters() {
  ['fm-filter-doctype', 'fm-filter-fy', 'fm-filter-from', 'fm-filter-to', 'fm-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  fmFilters = { ...FM_FILTERS_EMPTY };
  fmActiveFilter = 'all';
  fmRenderStats();
  fmApplyFilters();
}

// ── Delivery mode toggle (intake and handover, kept independent) ──
// Physical <-> Online swaps which contact fields are shown/required; the
// active class mirrors ARF's type-picker (arf-type-picker/arf-type-option —
// same visual component, reused rather than re-invented).
function fmOnModeChange(side) {
  const name = side === 'received' ? 'fm-mode-received' : 'fm-mode-returned';
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  const mode = checked ? checked.value : 'physical';
  document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
    const opt = r.closest('.arf-type-option');
    if (opt) opt.classList.toggle('active', r.checked);
  });
  if (side === 'received') {
    document.getElementById('fm-received-physical-group').style.display = mode === 'physical' ? '' : 'none';
    document.getElementById('fm-received-online-group').style.display = mode === 'online' ? '' : 'none';
  } else {
    document.getElementById('fm-return-physical-name-group').style.display = mode === 'physical' ? '' : 'none';
    document.getElementById('fm-return-physical-phone-group').style.display = mode === 'physical' ? '' : 'none';
    document.getElementById('fm-return-online-group').style.display = mode === 'online' ? '' : 'none';
  }
}

// Auto-fills Fiscal Year from Date Received, but never clobbers a value the
// user already typed or that was loaded from a saved record.
function fmOnDateReceivedChange() {
  const fyEl = document.getElementById('fm-fiscal-year');
  if (fyEl.value.trim()) return;
  fyEl.value = fmFyFromDate(document.getElementById('fm-date-received').value);
}

// ── Document-type quantities ──
function fmSetDocTypeQtys(list) {
  const arr = Array.isArray(list) ? list : [];
  const byLabel = {};
  arr.forEach(item => {
    if (typeof item === 'string') { byLabel[item] = (byLabel[item] || 0) + 1; return; } // legacy string entries
    if (item && item.type) byLabel[item.type] = item.qty || 1;
  });
  window.FM_DOC_TYPES.forEach(t => {
    const el = document.getElementById(`fm-qty-${t.key}`);
    if (el) el.value = byLabel[t.label] || '';
    delete byLabel[t.label];
  });
  // Anything left didn't match today's picklist (a legacy label, or a
  // previously-typed custom entry) — the single Others row can only carry
  // one, so the first is offered back for editing.
  const leftover = Object.keys(byLabel);
  document.getElementById('fm-doc-other-name').value = leftover[0] || '';
  document.getElementById('fm-doc-other-qty').value = leftover[0] ? byLabel[leftover[0]] : '';
}

function fmReadDocTypeQtys() {
  const list = [];
  window.FM_DOC_TYPES.forEach(t => {
    const el = document.getElementById(`fm-qty-${t.key}`);
    const qty = el ? parseInt(el.value, 10) : 0;
    if (qty > 0) list.push({ type: t.label, qty });
  });
  const otherName = document.getElementById('fm-doc-other-name').value.trim();
  if (otherName) {
    const otherQtyRaw = parseInt(document.getElementById('fm-doc-other-qty').value, 10);
    list.push({ type: otherName, qty: otherQtyRaw > 0 ? otherQtyRaw : 1 });
  }
  return list;
}

// ── Intake drawer (create / edit) ──
function fmSelectClient(c) {
  fmSelectedClient = c;
  document.getElementById('fm-client-search').value = c.name;
  document.getElementById('fm-client-pan').value = c.pan || '';
}

function fmOpenEntry(existing) {
  fmEditingId = existing ? existing.id : null;
  fmSelectedClient = null;
  document.getElementById('fm-drawer-title').textContent = existing ? `Edit ${existing.register_no || 'Intake'}` : 'Record Document Intake';
  document.getElementById('fm-drawer-status').innerHTML = '';

  fmSetDocTypeQtys(existing ? existing.doc_types : []);

  document.getElementById('fm-date-received').value = existing ? existing.date_received : fmToday();
  document.getElementById('fm-fiscal-year').value = existing ? (existing.fiscal_year || '') : '';
  if (!existing) fmOnDateReceivedChange();
  document.getElementById('fm-client-search').value = existing ? (existing.client_name || '') : '';
  document.getElementById('fm-client-pan').value = existing ? (existing.client_pan || '') : '';
  document.getElementById('fm-brought-name').value = existing ? (existing.brought_by_name || '') : '';
  document.getElementById('fm-brought-phone').value = existing ? (existing.brought_by_phone || '') : '';
  document.getElementById('fm-email-received').value = existing ? (existing.email_received || '') : '';
  document.getElementById('fm-remarks').value = existing ? (existing.remarks || '') : '';

  const modeReceived = (existing && existing.mode_received === 'online') ? 'online' : 'physical';
  const modeInput = document.querySelector(`input[name="fm-mode-received"][value="${modeReceived}"]`);
  if (modeInput) modeInput.checked = true;
  fmOnModeChange('received');

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

  const docTypes = fmReadDocTypeQtys();
  if (!docTypes.length) { drawerErr('Add a quantity for at least one document, or type a custom one.'); return; }

  const modeReceived = (document.querySelector('input[name="fm-mode-received"]:checked') || {}).value || 'physical';
  let broughtName = null, broughtPhone = null, emailReceived = null;
  if (modeReceived === 'physical') {
    broughtName = document.getElementById('fm-brought-name').value.trim();
    if (!broughtName) { drawerErr('Enter who brought the documents.'); return; }
    broughtPhone = document.getElementById('fm-brought-phone').value.trim() || null;
  } else {
    emailReceived = document.getElementById('fm-email-received').value.trim();
    if (!emailReceived) { drawerErr('Enter the email ID the documents came from.'); return; }
  }

  // Keep client_id only while the name still matches the picked client — a
  // hand-edited name becomes a typed-only (nullable) client.
  const clientId = (fmSelectedClient && fmSelectedClient.name === clientName) ? fmSelectedClient.id : null;

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_pan: document.getElementById('fm-client-pan').value.trim() || null,
    fiscal_year: document.getElementById('fm-fiscal-year').value.trim() || null,
    date_received: document.getElementById('fm-date-received').value || fmToday(),
    doc_types: docTypes,
    mode_received: modeReceived,
    brought_by_name: broughtName,
    brought_by_phone: broughtPhone,
    email_received: emailReceived,
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
    `<span style="color:var(--text-faint); font-size:12.5px;">Received ${escHtml(row.date_received || '—')} from ${escHtml(row.brought_by_name || row.email_received || '—')} · held ${fmDaysHeld(row)} days</span>`;
  document.getElementById('fm-return-date').value = fmToday();
  document.getElementById('fm-return-name').value = row.brought_by_name || '';
  document.getElementById('fm-return-phone').value = row.brought_by_phone || '';
  document.getElementById('fm-return-email').value = row.email_received || '';
  document.getElementById('fm-return-remarks').value = '';
  document.getElementById('fm-return-status').innerHTML = '';

  // Default the handover mode to how the documents came in — usually the
  // same channel, and easy to switch if not.
  const modeReturned = row.mode_received === 'online' ? 'online' : 'physical';
  const modeInput = document.querySelector(`input[name="fm-mode-returned"][value="${modeReturned}"]`);
  if (modeInput) modeInput.checked = true;
  fmOnModeChange('returned');

  document.getElementById('fm-return-modal').classList.add('open');
}

function fmCloseReturn() { document.getElementById('fm-return-modal').classList.remove('open'); }

async function fmConfirmReturn() {
  if (!fmReturningRow) return;
  const modeReturned = (document.querySelector('input[name="fm-mode-returned"]:checked') || {}).value || 'physical';
  let name = null, phone = null, email = null;
  if (modeReturned === 'physical') {
    name = document.getElementById('fm-return-name').value.trim();
    if (!name) { showStatus('Enter who collected the documents.', 'info', 'fm-return-status'); return; }
    phone = document.getElementById('fm-return-phone').value.trim() || null;
  } else {
    email = document.getElementById('fm-return-email').value.trim();
    if (!email) { showStatus('Enter the email ID the documents were sent to.', 'info', 'fm-return-status'); return; }
  }

  showStatus('<span class="spinner spinner-navy"></span> Recording handover…', 'searching', 'fm-return-status');
  try {
    await fmFlow.transition(fmReturningRow, 'returned', { patch: {
      date_returned: document.getElementById('fm-return-date').value || fmToday(),
      mode_returned: modeReturned,
      returned_to_name: name,
      returned_to_phone: phone,
      email_sent: email,
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
      date_returned: null, returned_to_name: null, returned_to_phone: null,
      mode_returned: null, email_sent: null, return_remarks: null,
    } });
    await fmRefresh();
    fmStatusMsg('✅ Entry reopened — shown as still with us.', 'success');
  } catch (e) {
    fmStatusMsg('❌ ' + escHtml(e.message || 'Failed to reopen the entry'), 'error');
  }
}
