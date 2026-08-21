// ════════════════════════════════════════════
//  COMPANY PROFILE  (Company Registrar → Company Profile)
//
//  The firm's register of Nepalese companies, and the ONLY screen that adds,
//  edits or deletes one. Everything the five registrar documents print comes
//  from here: registration number, chairman, shareholders/directors, the three
//  capitals, PAN and address.
//
//  WHAT CHANGED 2026-08-20 (user decision)
//  This used to be an edit-only screen over `clients`: you searched a company
//  that already existed and filled in its statutory fields. There was no way to
//  add one, and because the records lived in `clients` they appeared in every
//  client picker in the app — Bank Entry, Service Memo, Autobooks — where
//  nothing can be done with them. The records now live in their own tables
//  (db/2026-08-20_registrar_companies.sql) and this screen became their full
//  directory: search, browse, add, edit, delete, and bulk import.
//
//  Reads window.registrarCompanies via RegistrarDirectory (js/registrarCompanies.js),
//  NEVER window.clientsList. An English-named audit client cannot be reached
//  from here, and a Nepali company cannot be reached from anywhere else. That
//  is the whole design — see the header of js/registrarCompanies.js.
//
//  Prefix: cp-   (see CLAUDE.md §9)
// ════════════════════════════════════════════

ModuleRegistry.register({
  id: 'companyProfile', group: 'regd',
  buttonId: 'subtab-companyProfile', panelId: 'regd-companyProfile-panel',
});

// The fields this module owns, in form order. One list drives the form build,
// the load, the save payload and the completeness summary, so they cannot
// drift apart.
//
// `wide` fields span both columns of the .form-grid (an address and a
// company's own name need the room; a capital figure does not).
const CP_FIELDS = [
  { key: 'name',                id: 'cp-f-name',            label: 'Company Name',        ph: 'कम्पनीको नाम', required: true, wide: true },
  { key: 'registration_number', id: 'cp-f-regno',           label: 'Registration Number', ph: 'e.g. 123456/078/079', required: true },
  { key: 'pan',                 id: 'cp-f-pan',             label: 'PAN Number',          ph: 'e.g. 601234567' },
  { key: 'chairman_name',       id: 'cp-f-chairman',        label: 'Chairman Name',       ph: 'अध्यक्षको नाम', required: true },
  { key: 'shareholder_name',    id: 'cp-f-shareholder',     label: 'Shareholder Name',    ph: 'सञ्चालकको नाम' },
  { key: 'authorized_capital',  id: 'cp-f-authcap',         label: 'Authorized Capital',  ph: 'e.g. 25,00,000', required: true },
  { key: 'issued_capital',      id: 'cp-f-isscap',          label: 'Issued Capital',      ph: 'e.g. 25,00,000', required: true },
  { key: 'paid_up_capital',     id: 'cp-f-paidcap',         label: 'Paid-up Capital',     ph: 'e.g. 25,00,000', required: true },
  { key: 'address',             id: 'cp-f-address',         label: 'Address',             ph: 'ठेगाना', wide: true },
  { key: 'country',             id: 'cp-f-country',         label: 'Country',             ph: 'Nepal' },
  { key: 'notes',               id: 'cp-f-notes',           label: 'Notes',               ph: 'Optional — anything worth remembering about this company', wide: true },
];

// Which company the editor is open on. null = the editor is closed; a company
// object = editing it; CP_NEW = adding one.
const CP_NEW = { id: null, __new: true };
window.cpEditing = null;

let cpTable = null;

function cpStatus(msg, type) { showStatus(msg, type, 'cp-status'); }

// Amounts are TEXT everywhere in this app (CLAUDE.md §15 — it preserves the
// firm's own "25,00,000" grouping), so this is display-only prettifying of a
// figure that may be Devanagari, may carry commas already, and may be neither.
function cpCapitalCell(v) {
  const s = String(v || '').trim();
  return s ? escHtml(s) : '<span style="color:var(--text-faint);">—</span>';
}

// ════════════════════════════════════════════
//  DIRECTORY
// ════════════════════════════════════════════

// Redraw whenever the directory reloads — including reloads this module did
// not cause, such as the bulk import finishing.
RegistrarDirectory.onChange(() => { if (cpIsVisible()) cpRenderTable(); cpRenderStats(); });

function cpIsVisible() {
  const p = document.getElementById('regd-companyProfile-panel');
  return !!p && p.offsetParent !== null;
}

// Called by tabs.js on open (MODULE_INITS) and after every write.
function cpInit() {
  cpRenderStats();
  cpRenderTable();
}

function cpFiltered() {
  const q = NepaliLocale.toEnglishDigits(
    String((document.getElementById('cp-search') || {}).value || '').trim().toLowerCase());
  const list = RegistrarDirectory.list();
  if (!q) return list;
  // Plain substring, not Fuse: the user is filtering a list already on screen,
  // and a half-typed registration number must not fuzzy-match a different
  // company's PAN. Same reasoning as the saved-documents picker (§4).
  return list.filter(c => [
    c.name,
    NepaliLocale.toEnglishDigits(c.registration_number || ''),
    NepaliLocale.toEnglishDigits(c.pan || ''),
    c.chairman_name, c.shareholder_name, c.address,
  ].some(v => String(v || '').toLowerCase().includes(q)));
}

function cpSearchChanged() { cpRenderTable(); }

// A company that cannot produce a document is the thing worth counting here —
// the registrar minutes need a registration number, a chairman and the three
// capitals, so "incomplete" means exactly "a document generated from this row
// would print blanks".
function cpRequiredKeys() { return CP_FIELDS.filter(f => f.required).map(f => f.key); }

function cpIsComplete(c) {
  return cpRequiredKeys().every(k => String(c[k] || '').trim() !== '');
}

function cpRenderStats() {
  const el = document.getElementById('cp-stats');
  if (!el) return;
  const list = RegistrarDirectory.list();
  const complete = list.filter(cpIsComplete).length;
  const withShareholders = list.filter(c => (c.shareholders || []).length).length;
  el.innerHTML = `
    <div class="import-stat"><div class="num">${list.length}</div><div class="lbl">Companies</div></div>
    <div class="import-stat"><div class="num">${complete}</div><div class="lbl">Ready to Generate</div></div>
    <div class="import-stat warn"><div class="num">${list.length - complete}</div><div class="lbl">Missing Details</div></div>
    <div class="import-stat"><div class="num">${withShareholders}</div><div class="lbl">With Shareholders</div></div>
  `;
}

function cpRenderTable() {
  const wrap = document.getElementById('cp-table-wrap');
  const summary = document.getElementById('cp-filter-summary');
  if (!wrap) return;

  const list = cpFiltered();
  const total = RegistrarDirectory.list().length;
  if (summary) {
    summary.textContent = !total ? ''
      : (list.length === total ? `${total} companies` : `${list.length} of ${total} companies`);
  }

  if (cpTable) { cpTable.destroy(); cpTable = null; }

  if (!list.length) {
    wrap.innerHTML = total
      ? '<div class="log-empty">No company matches your search.</div>'
      : '<div class="log-empty">No companies yet. Use <strong>Add Company</strong> to enter one, or <strong>Import from Excel</strong> to load your register.</div>';
    return;
  }

  const isAdmin = window.currentUser?.role === 'admin' || window.currentUser?.role === 'owner';
  wrap.innerHTML = '';
  cpTable = TableEngine.createTable(wrap, {
    data: list,
    columns: [
      { title: 'Company', field: 'name', minWidth: 220, formatter: cell => {
          const c = cell.getRow().getData();
          const warn = cpIsComplete(c) ? ''
            : ' <span class="log-badge badge-yellow" title="Missing details a registrar document needs">incomplete</span>';
          return `<div class="cp-name-cell">${escHtml(c.name)}${warn}</div>`;
        } },
      { title: 'Registration No.', field: 'registration_number', minWidth: 150,
        formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'PAN', field: 'pan', minWidth: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Chairman', field: 'chairman_name', minWidth: 150, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Shareholders', field: 'id', headerSort: false, minWidth: 110, formatter: cell => {
          const n = RegistrarDirectory.attendeeNames(cell.getRow().getData().id).length;
          return n ? `<span class="log-badge badge-blue">${n}</span>`
                   : '<span style="color:var(--text-faint);">—</span>';
        } },
      { title: 'Paid-up Capital', field: 'paid_up_capital', minWidth: 140, formatter: cell => cpCapitalCell(cell.getValue()) },
      {
        title: 'Actions', field: 'id', headerSort: false, minWidth: 150,
        formatter: () => `<div class="client-actions"><button class="btn btn-outline btn-sm" data-action="edit">Edit</button>${
          isAdmin ? '<button class="btn btn-danger btn-sm" data-action="delete">Delete</button>' : ''}</div>`,
        cellClick: (e, cell) => {
          const hit = e.target.closest('[data-action]');
          if (!hit) return;
          const c = cell.getRow().getData();
          if (hit.dataset.action === 'edit') cpOpenEditor(c.id);
          else if (hit.dataset.action === 'delete') cpDelete(c.id);
        },
      },
    ],
  });
}

// ════════════════════════════════════════════
//  EDITOR  (add / edit)
// ════════════════════════════════════════════

// Built once, from CP_FIELDS, rather than written out in index.html — the list
// above is then the only place a field is declared.
function cpBuildForm() {
  const grid = document.getElementById('cp-form-grid');
  if (!grid || grid.dataset.built === '1') return;
  grid.innerHTML = CP_FIELDS.map(f => `
    <div class="form-group${f.wide ? ' form-group-wide' : ''}">
      <label for="${f.id}">${escHtml(f.label)}${f.required ? ' <span class="cp-req">*</span>' : ''}</label>
      <input type="text" id="${f.id}" placeholder="${escHtml(f.ph || '')}" autocomplete="off" />
    </div>
  `).join('');
  grid.dataset.built = '1';
}

function cpOpenEditor(id) {
  cpBuildForm();
  const c = id ? RegistrarDirectory.byId(id) : null;
  if (id && !c) { cpStatus('That company is no longer in the register.', 'error'); return; }

  window.cpEditing = c || CP_NEW;

  // Always assign, never `if (value) el.value = value` — a company whose field
  // is blank would otherwise keep the PREVIOUSLY edited company's value, and
  // that value goes straight into a signed document (CLAUDE.md §9).
  CP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    el.value = c ? (c[f.key] || '') : (f.key === 'country' ? 'Nepal' : '');
  });

  cpRenderShareholders(c ? (c.shareholders || []).map(s => s.name) : []);

  document.getElementById('cp-editor-title').textContent = c ? 'Edit Company' : 'Add Company';
  document.getElementById('cp-delete-btn').style.display =
    (c && (window.currentUser?.role === 'admin' || window.currentUser?.role === 'owner')) ? '' : 'none';
  document.getElementById('cp-editor').classList.add('open');
  document.getElementById('cp-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  cpRenderCompleteness();
  cpStatus('', 'info');
  const first = document.getElementById(CP_FIELDS[0].id);
  if (first) first.focus();
}

function cpCloseEditor() {
  window.cpEditing = null;
  document.getElementById('cp-editor').classList.remove('open');
  cpStatus('', 'info');
}

// ── Shareholder / director rows ──
// The fixed `shareholder_name` field is shareholder #2 (the chairman is #1);
// every row here is #3 onward, in order — the same contract BM/AGM Minutes and
// Company Secretary read them back under.
function cpRenderShareholders(names) {
  const wrap = document.getElementById('cp-shareholders');
  if (!wrap) return;
  wrap.innerHTML = '';
  (names || []).forEach(n => cpAddShareholderRow(n));
}

function cpAddShareholderRow(name) {
  const wrap = document.getElementById('cp-shareholders');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'cp-shareholder-row';
  row.innerHTML = `
    <input type="text" class="cp-shareholder-input" placeholder="Additional shareholder / director name" />
    <button type="button" class="btn btn-danger btn-sm" data-cp-remove>Remove</button>
  `;
  wrap.appendChild(row);
  if (name) row.querySelector('input').value = name;
  row.querySelector('[data-cp-remove]').addEventListener('click', () => {
    row.remove();
    cpRenderCompleteness();
  });
}

function cpShareholderNames() {
  return Array.from(document.querySelectorAll('#cp-shareholders .cp-shareholder-input'))
    .map(i => i.value.trim())
    .filter(Boolean);
}

// A small on-screen count of how much of the registrar record is filled in —
// these documents can't be generated from a half-empty profile.
function cpRenderCompleteness() {
  const el = document.getElementById('cp-completeness');
  if (!el) return;
  if (!window.cpEditing) { el.innerHTML = ''; return; }
  const checked = CP_FIELDS.filter(f => f.required);
  const filled = checked.filter(f => {
    const v = (document.getElementById(f.id) || {}).value;
    return v && String(v).trim() !== '';
  }).length;
  const pct = Math.round(filled / checked.length * 100);
  const tone = pct === 100 ? 'good' : pct >= 50 ? 'mid' : 'low';
  el.innerHTML = `
    <div class="cd-meter-row">
      <div class="cd-meter-label">Ready to generate</div>
      <div class="cd-meter-track"><div class="cd-meter-fill ${tone}" style="width:${pct}%"></div></div>
      <div class="cd-meter-val">${filled}/${checked.length}</div>
    </div>`;
}

// ════════════════════════════════════════════
//  SAVE / DELETE
// ════════════════════════════════════════════
async function cpSave(btn) {
  const editing = window.cpEditing;
  if (!editing) return;

  const payload = {};
  CP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const v = String(el.value || '').trim();
    payload[f.key] = v || null;
  });

  if (!payload.name) { cpStatus('Company Name is required.', 'error'); return; }

  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    let companyId = editing.id;
    if (editing.__new) {
      const { data, error } = await window.sb
        .from('registrar_companies').insert(payload).select('id').single();
      if (error) {
        // Adding is admin-only at the database (mirrors `clients`), so name that
        // rather than showing a raw policy violation.
        cpStatus(error.code === '42501'
          ? 'Only an admin can add a company to the register.'
          : 'Failed to save: ' + error.message, 'error');
        return;
      }
      companyId = data.id;
    } else {
      const { error } = await window.sb
        .from('registrar_companies').update(payload).eq('id', companyId);
      if (error) { cpStatus('Failed to save: ' + error.message, 'error'); return; }
    }

    // Shareholders are replaced wholesale rather than diffed: the rows on screen
    // ARE the company's shareholder list, a removed row means removed, and 3–4
    // rows per company make a diff pure complexity. Delete-then-insert is safe
    // here because both statements are scoped to this one company.
    //
    // But only when the list actually CHANGED (Stage 3): the delete+insert
    // used to run unconditionally, so editing a phone number burned two extra
    // round-trips rewriting an identical shareholder list.
    const names = cpShareholderNames();
    const existingNames = (editing.shareholders || []).map(s => String(s.name || '').trim());
    const unchanged = !editing.__new
      && names.length === existingNames.length
      && names.every((n, i) => n === existingNames[i]);
    if (!unchanged) {
      const { error: delErr } = await window.sb
        .from('registrar_shareholders').delete().eq('company_id', companyId);
      if (delErr) { cpStatus('Saved the company, but its shareholder list did not update: ' + delErr.message, 'error'); return; }

      if (names.length) {
        const rows = names.map((name, i) => ({ company_id: companyId, name, sort_order: i }));
        const { error: insErr } = await window.sb.from('registrar_shareholders').insert(rows);
        if (insErr) { cpStatus('Saved the company, but its shareholders did not save: ' + insErr.message, 'error'); return; }
      }
    }

    AuditLog.record(editing.__new ? 'registrar_company_added' : 'registrar_company_saved', {
      module: 'companyProfile',
      clientName: payload.name,
      recordRef: companyId,
      detail: { registrationNumber: payload.registration_number, shareholders: names.length },
    });

    cpCloseEditor();
    showToast(`✅ ${editing.__new ? 'Company added' : 'Company saved'}: <strong>${escHtml(payload.name)}</strong>.`, 'success');
    // Background reload; the RegistrarDirectory.onChange listener re-renders
    // the table and stats when it lands. The extra cpInit() that used to
    // follow was a second render of the same data in the same tick.
    RegistrarDirectory.reload().catch(e => showToast('❌ Saved, but the register failed to refresh: ' + escHtml(friendlyDbError(e)), 'error'));
  });
}

async function cpDelete(id) {
  const c = RegistrarDirectory.byId(id || (window.cpEditing || {}).id);
  if (!c) return;
  if (!confirm(`Remove "${c.name}" from the company register?\n\nIts shareholder list goes with it. Documents already generated are unaffected.`)) return;

  cpStatus('Deleting…', 'searching');
  const { error } = await window.sb.from('registrar_companies').delete().eq('id', c.id);
  if (error) {
    cpStatus(error.code === '42501'
      ? 'Only an admin can remove a company from the register.'
      : 'Failed to delete: ' + error.message, 'error');
    return;
  }

  AuditLog.record('registrar_company_deleted', {
    module: 'companyProfile', clientName: c.name, recordRef: c.id,
    detail: { registrationNumber: c.registration_number },
  });

  cpCloseEditor();
  showToast(`🗑️ Removed <strong>${escHtml(c.name)}</strong> from the register.`, 'success');
  // Background reload; the onChange listener re-renders — the trailing
  // cpInit() was a second render of the same data (Stage 3).
  RegistrarDirectory.reload().catch(e => showToast('❌ Removed, but the register failed to refresh: ' + escHtml(friendlyDbError(e)), 'error'));
}

// ── Bulk import ──
// Reuses the one spreadsheet wizard (js/clients.js) under the 'registrar'
// profile in window.IMPORT_PROFILES, so the firm's company sheet — every
// shareholder on its own row under the company — imports exactly as it always
// did, into the register instead of into the client directory.
function cpOpenImport() { openImportModal('registrar'); }

// Recompute the meter as the user types, so the header reflects the form
// rather than the last save.
document.addEventListener('input', e => {
  if (e.target && String(e.target.id || '').startsWith('cp-f-')) cpRenderCompleteness();
});
