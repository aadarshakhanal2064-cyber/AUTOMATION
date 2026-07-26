// ════════════════════════════════════════════
//  CLIENT AUTOCOMPLETE
// ════════════════════════════════════════════
function selectClient(c) {
  document.getElementById('clientName').value  = c.name;
  document.getElementById('clientEmail').value = c.email || '';
}

SearchEngine.attachAutocomplete(document.getElementById('clientName'), document.getElementById('autocomplete-list'), {
  getList: () => window.clientsList,
  keys: ['name', 'email'],
  renderItem: c => `
    <div class="ac-name">${escHtml(c.name)}</div>
    <div class="ac-email">${escHtml(c.email || 'No email on file')}</div>
  `,
  onSelect: selectClient,
});

// ════════════════════════════════════════════
//  SUPABASE: LOAD CLIENTS
// ════════════════════════════════════════════
async function loadClients() {
  const { data, error } = await window.sb
    .from('clients')
    .select('*')
    .order('name');

  if (error) {
    console.error('Failed to load clients:', error.message);
    document.getElementById('clients-table-wrap').innerHTML =
      '<div class="log-empty" style="color:var(--red);">Failed to load clients. Check your Supabase table and RLS policies.</div>';
    return;
  }

  window.clientsList = data || [];
  populateClientFilters(window.clientsList);
  applyClientFilters();
  renderClientStats(window.clientsList);
}

// ════════════════════════════════════════════
//  CLIENT PORTFOLIO DASHBOARD
// ════════════════════════════════════════════
// Every figure is derived from window.clientsList on render — the directory is
// the single source, so the dashboard can never disagree with the table below
// it. Deliberately reports the WHOLE portfolio, not the filtered view: these
// are the firm's headline numbers, and having them move as you type in the
// search box would make them useless.

const CD_MAX_BARS = 6;   // longest tail worth drawing; the rest roll into "Other"
// Blanks are bucketed under one visible label rather than dropped: the 45
// Devanagari records and the 8 kept clients carry no district or IT return,
// and a chart that quietly omitted them would not add up to the client count.
const CD_BLANK = 'Not set';

function cdGroup(list, pick) {
  const counts = new Map();
  list.forEach(c => {
    const raw = pick(c);
    const key = (raw === null || raw === undefined || String(raw).trim() === '')
      ? CD_BLANK : String(raw).trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  // Blanks sort last regardless of size — they are an absence, not a category.
  return [...counts.entries()].sort((a, b) =>
    (a[0] === CD_BLANK) - (b[0] === CD_BLANK) || b[1] - a[1] || a[0].localeCompare(b[0]));
}

function cdRenderBars(elId, countId, groups, noun) {
  const el = document.getElementById(elId);
  if (!el) return;
  // The blank bucket is not one of the categories, so it must not be counted
  // as one — "7 types" when six are real would be wrong.
  const real = groups.filter(([name]) => name !== CD_BLANK).length;
  const label = document.getElementById(countId);
  if (label) label.textContent = `${real} ${noun}${real === 1 ? '' : 's'}`;

  if (!groups.length) { el.innerHTML = '<div class="log-empty">No data yet.</div>'; return; }

  // "Not set" is held out of the ranking and always drawn as its own last bar.
  // Letting it fall into "Other" would bury the count of records still missing
  // the field, which is the one number this panel is most useful for.
  const blank = groups.find(([name]) => name === CD_BLANK);
  const ranked = groups.filter(([name]) => name !== CD_BLANK);
  const slots = CD_MAX_BARS - (blank ? 1 : 0);

  let shown = ranked;
  if (ranked.length > slots) {
    const rest = ranked.slice(slots - 1).reduce((s, g) => s + g[1], 0);
    shown = ranked.slice(0, slots - 1).concat([[`Other (${ranked.length - slots + 1})`, rest]]);
  }
  if (blank) shown = shown.concat([blank]);

  const top = Math.max(...shown.map(g => g[1]), 1);
  const total = groups.reduce((s, g) => s + g[1], 0) || 1;

  el.innerHTML = shown.map(([name, n]) => `
    <div class="cd-bar-row">
      <div class="cd-bar-label" title="${escHtml(name)}">${escHtml(name)}</div>
      <div class="cd-bar-track"><div class="cd-bar-fill${name === CD_BLANK ? ' blank' : ''}" style="width:${(n / top * 100).toFixed(1)}%"></div></div>
      <div class="cd-bar-val">${n}<span class="cd-bar-pct">${Math.round(n / total * 100)}%</span></div>
    </div>`).join('');
}

function cdRenderCompleteness(list) {
  const el = document.getElementById('cd-completeness');
  if (!el) return;
  const total = list.length || 1;
  // The fields other modules actually need before they can do their job.
  const fields = [
    ['PAN',           c => c.pan],
    ['Address',       c => c.address],
    ['Entity Type',   c => c.entity_type],
    ['District',      c => c.district],
    ['IT Return',     c => c.it_return_type],
    ['Email',         c => c.email],
    ['Phone',         c => c.phone],
  ];
  el.innerHTML = fields.map(([label, pick]) => {
    const n = list.filter(c => { const v = pick(c); return v !== null && v !== undefined && String(v).trim() !== ''; }).length;
    const pct = Math.round(n / total * 100);
    const tone = pct >= 90 ? 'good' : pct >= 50 ? 'mid' : 'low';
    return `
      <div class="cd-meter-row">
        <div class="cd-meter-label">${escHtml(label)}</div>
        <div class="cd-meter-track"><div class="cd-meter-fill ${tone}" style="width:${pct}%"></div></div>
        <div class="cd-meter-val">${pct}%</div>
      </div>`;
  }).join('');
}

function renderClientStats(list) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const isD3  = c => String(c.it_return_type || '') === 'D-03';
  // D1/D2 is one value, but a client narrowed to D-01 or D-02 still belongs
  // in this count — it is the same filing family.
  const isD12 = c => /^D(1\/D2|-01|-02)$/.test(String(c.it_return_type || ''));

  set('stat-total-clients', list.length);
  set('stat-d12',        list.filter(isD12).length);
  set('stat-d3',         list.filter(isD3).length);
  set('stat-vat-active', list.filter(c => c.vat_status === 'active').length);

  const unset = list.filter(c => !c.it_return_type).length;
  set('stat-total-sub', unset ? `${unset} without an IT return type` : 'All classified');

  cdRenderBars('cd-entity-bars',   'cd-entity-count',   cdGroup(list, c => c.entity_type),     'type');
  cdRenderBars('cd-district-bars', 'cd-district-count', cdGroup(list, c => c.district),        'district');
  cdRenderBars('cd-nature-bars',   'cd-nature-count',   cdGroup(list, c => c.business_nature), 'sector');
  cdRenderCompleteness(list);
}

// ── Filters ──────────────────────────────────
// The search box and the three dropdowns are one predicate, so they compose
// instead of each overwriting the other's result.
function populateClientFilters(list) {
  const fill = (id, groups) => {
    const el = document.getElementById(id);
    if (!el) return;
    const keep = el.value;
    const first = el.options[0];
    el.innerHTML = '';
    el.appendChild(first);
    groups.filter(([name]) => name !== CD_BLANK).forEach(([name, n]) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = `${name} (${n})`;
      el.appendChild(o);
    });
    el.value = keep;                       // survive a reload mid-filter
    if (el.value !== keep) el.value = '';  // unless that option is now gone
  };
  fill('client-filter-entity',   cdGroup(list, c => c.entity_type));
  fill('client-filter-district', cdGroup(list, c => c.district));

  const dl = document.getElementById('ac-district-list');
  if (dl) {
    dl.innerHTML = cdGroup(list, c => c.district)
      .filter(([name]) => name !== CD_BLANK)
      .map(([name]) => `<option value="${escHtml(name)}"></option>`).join('');
  }
}

function applyClientFilters() {
  const val = id => (document.getElementById(id) || {}).value || '';
  const q        = val('client-search-bar').trim().toLowerCase();
  const entity   = val('client-filter-entity');
  const district = val('client-filter-district');
  const itType   = val('client-filter-it');

  const filtered = (window.clientsList || []).filter(c => {
    if (entity   && (c.entity_type || '') !== entity)   return false;
    if (district && (c.district || '')    !== district) return false;
    if (itType === '__none') { if (c.it_return_type) return false; }
    else if (itType && (c.it_return_type || '') !== itType) return false;
    if (!q) return true;
    return [c.name, c.email, c.pan, c.registration_number, c.entity_type,
            c.district, c.business_nature, c.it_return_type]
      .some(v => (v || '').toLowerCase().includes(q));
  });

  renderClientsTable(filtered);
  const el = document.getElementById('client-filter-summary');
  if (el) {
    const n = filtered.length, total = (window.clientsList || []).length;
    el.textContent = n === total ? `${total} clients` : `${n} of ${total} clients`;
  }
}

function clientInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// Tabulator instance for the clients directory — rebuilt from scratch on
// every render (matching the previous wipe-and-rebuild-innerHTML behavior),
// so the client list is never in an ambiguous partially-updated state
// (e.g. after a role change affects whether the Actions column shows).
let clientsTable = null;

function renderClientsTable(list) {
  const wrap = document.getElementById('clients-table-wrap');
  if (clientsTable) { clientsTable.destroy(); clientsTable = null; }

  if (!list.length) {
    wrap.innerHTML = '<div class="log-empty">No clients yet. Add your first client above.</div>';
    return;
  }

  const isAdmin = window.currentUser?.role === 'admin';
  wrap.innerHTML = '';
  clientsTable = TableEngine.createTable(wrap, {
    data: list,
    columns: [
      { title: 'Client Name', field: 'name', minWidth: 200, formatter: cell => {
          const c = cell.getRow().getData();
          return `<div class="client-name-row"><div class="client-avatar">${escHtml(clientInitials(c.name))}</div><div class="client-name-cell">${escHtml(c.name)}</div></div>`;
        } },
      { title: 'Entity Type', field: 'entity_type', minWidth: 140, formatter: cell => {
          const v = cell.getValue();
          return v ? `<span class="entity-badge">${escHtml(v)}</span>` : '—';
        } },
      { title: 'PAN', field: 'pan', minWidth: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'District', field: 'district', minWidth: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'IT Return', field: 'it_return_type', minWidth: 110, formatter: cell => {
          const v = cell.getValue();
          if (!v) return '<span style="color:var(--text-faint);">—</span>';
          return `<span class="log-badge ${v === 'D-03' ? 'badge-yellow' : 'badge-sent'}">${escHtml(v)}</span>`;
        } },
      { title: 'Email', field: 'email', minWidth: 170, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'VAT', field: 'vat_status', minWidth: 110, formatter: cell => {
          const v = cell.getValue();
          return v === 'active' ? '<span class="log-badge badge-sent">Active</span>'
            : v === 'inactive' ? '<span class="log-badge badge-yellow">Inactive</span>'
            : '<span style="color:var(--text-faint);">—</span>';
        } },
      { title: 'Phone', field: 'phone', minWidth: 130, formatter: cell => escHtml(cell.getValue() || '—') },
      ...(isAdmin ? [{
        title: 'Actions', field: 'id', headerSort: false, minWidth: 150,
        formatter: () => `<div class="client-actions"><button class="btn btn-outline btn-sm" data-action="edit">Edit</button><button class="btn btn-danger btn-sm" data-action="delete">Delete</button></div>`,
        cellClick: (e, cell) => {
          const action = e.target.closest('[data-action]') && e.target.closest('[data-action]').dataset.action;
          const c = cell.getRow().getData();
          if (action === 'edit') editClient(c.id);
          else if (action === 'delete') deleteClient(c.id);
        },
      }] : []),
    ],
  });
}

// Superseded by applyClientFilters(), which folds the search box and the three
// dropdowns into one predicate. Kept as a thin alias because it was the public
// name for this behaviour.
function filterClientTable() { applyClientFilters(); }

// ════════════════════════════════════════════
//  SUPABASE: ADD / EDIT / DELETE CLIENTS
// ════════════════════════════════════════════
function toggleAddClient() {
  const form = document.getElementById('add-client-form');
  form.classList.toggle('open');
  if (form.classList.contains('open') && !window.editingClientId) {
    clearClientForm();
    document.getElementById('add-client-title').textContent = 'Add New Client';
  }
}

function cancelAddClient() {
  window.editingClientId = null;
  clearClientForm();
  document.getElementById('add-client-form').classList.remove('open');
}

function clearClientForm() {
  ['ac-name','ac-email','ac-pan','ac-phone','ac-entity-type','ac-business','ac-registration-number','ac-chairman-name','ac-shareholder-name','ac-authorized-capital','ac-issued-capital','ac-paidup-capital','ac-address','ac-district','ac-it-return-type','ac-tax-type-d3'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ac-vat-status').value = 'not_registered';
  // Every client on file is Nepal-based; typing it 300 times is not a feature.
  document.getElementById('ac-country').value = 'Nepal';
  document.getElementById('client-form-status').innerHTML = '';
}

async function saveClient() {
  const name  = document.getElementById('ac-name').value.trim();
  const email = document.getElementById('ac-email').value.trim();
  if (!name) {
    document.getElementById('client-form-status').innerHTML =
      '<div class="status-box status-info" style="margin-top:0;">Client Name is required.</div>';
    return;
  }

  const payload = {
    name,
    email:         email || null,
    pan:           document.getElementById('ac-pan').value.trim() || null,
    phone:         document.getElementById('ac-phone').value.trim() || null,
    entity_type:   document.getElementById('ac-entity-type').value.trim() || null,
    vat_status:    document.getElementById('ac-vat-status').value,
    business_nature: document.getElementById('ac-business').value.trim() || null,
    registration_number: document.getElementById('ac-registration-number').value.trim() || null,
    chairman_name:       document.getElementById('ac-chairman-name').value.trim() || null,
    shareholder_name:    document.getElementById('ac-shareholder-name').value.trim() || null,
    authorized_capital:  document.getElementById('ac-authorized-capital').value.trim() || null,
    issued_capital:      document.getElementById('ac-issued-capital').value.trim() || null,
    paid_up_capital:     document.getElementById('ac-paidup-capital').value.trim() || null,
    address:       document.getElementById('ac-address').value.trim() || null,
    district:      document.getElementById('ac-district').value.trim() || null,
    country:       document.getElementById('ac-country').value.trim() || null,
    it_return_type: document.getElementById('ac-it-return-type').value.trim() || null,
    tax_type_d3:   document.getElementById('ac-tax-type-d3').value.trim() || null,
  };

  let error;
  if (window.editingClientId) {
    ({ error } = await window.sb.from('clients').update(payload).eq('id', window.editingClientId));
  } else {
    ({ error } = await window.sb.from('clients').insert(payload));
  }

  if (error) {
    document.getElementById('client-form-status').innerHTML =
      `<div class="status-box status-error" style="margin-top:0;">❌ ${escHtml(error.message)}</div>`;
    return;
  }

  cancelAddClient();
  await loadClients();
}

function editClient(id) {
  const c = window.clientsList.find(x => x.id == id);
  if (!c) return;
  window.editingClientId = id;
  document.getElementById('ac-name').value        = c.name || '';
  document.getElementById('ac-email').value       = c.email || '';
  document.getElementById('ac-pan').value         = c.pan || '';
  document.getElementById('ac-phone').value       = c.phone || '';
  document.getElementById('ac-entity-type').value = c.entity_type || '';
  document.getElementById('ac-vat-status').value  = c.vat_status || 'not_registered';
  document.getElementById('ac-business').value    = c.business_nature || '';
  document.getElementById('ac-registration-number').value = c.registration_number || '';
  document.getElementById('ac-chairman-name').value       = c.chairman_name || '';
  document.getElementById('ac-shareholder-name').value    = c.shareholder_name || '';
  document.getElementById('ac-authorized-capital').value  = c.authorized_capital || '';
  document.getElementById('ac-issued-capital').value      = c.issued_capital || '';
  document.getElementById('ac-paidup-capital').value      = c.paid_up_capital || '';
  document.getElementById('ac-address').value     = c.address || '';
  document.getElementById('ac-district').value    = c.district || '';
  document.getElementById('ac-country').value     = c.country || 'Nepal';
  document.getElementById('ac-it-return-type').value = c.it_return_type || '';
  document.getElementById('ac-tax-type-d3').value = c.tax_type_d3 || '';
  document.getElementById('add-client-title').textContent = 'Edit Client';
  document.getElementById('add-client-form').classList.add('open');
  document.getElementById('add-client-form').scrollIntoView({ behavior: 'smooth' });
}

async function deleteClient(id) {
  const c = window.clientsList.find(x => String(x.id) === String(id));
  const name = c ? c.name : '';
  if (!confirm(`Delete client "${name}"? This cannot be undone.`)) return;
  const { error } = await window.sb.from('clients').delete().eq('id', id);
  if (error) { alert('Failed to delete: ' + error.message); return; }
  await loadClients();
}

// ════════════════════════════════════════════
//  IMPORT CLIENTS FROM EXCEL
// ════════════════════════════════════════════

function openImportModal() {
  window.importHeaders = []; 
  window.importDataRows = []; 
  window.importFieldMap = {}; 
  window.importPreviewRows = [];
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-status').innerHTML = '';
  document.getElementById('import-result-status').innerHTML = '';
  showImportStep(1);
  document.getElementById('import-modal').classList.add('open');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('open');
}

function showImportStep(n) {
  [1,2,3].forEach(i => document.getElementById('import-step-' + i).classList.toggle('active', i === n));
}

function handleImportFile(file) {
  if (!file) return;
  document.getElementById('import-file-status').innerHTML =
    '<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Reading file…</div>';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: '' });
      if (!rows.length) throw new Error('The file appears to be empty.');

      window.importHeaders  = rows[0].map(h => String(h || '').trim());
      window.importDataRows = rows.slice(1).filter(r => r.some(cell => String(cell || '').trim() !== ''));

      if (!window.importDataRows.length) throw new Error('No data rows found below the header row.');

      document.getElementById('import-file-status').innerHTML =
        `<div class="status-box status-success">✅ Loaded <strong>${window.importDataRows.length}</strong> rows from <strong>${escHtml(file.name)}</strong></div>`;

      autoMapColumns();
      renderColumnMapping();
      showImportStep(2);
    } catch (err) {
      document.getElementById('import-file-status').innerHTML =
        `<div class="status-box status-error">❌ Could not read file: ${escHtml(err.message)}</div>`;
    }
  };
  reader.onerror = () => {
    document.getElementById('import-file-status').innerHTML =
      '<div class="status-box status-error">❌ Failed to read the file.</div>';
  };
  reader.readAsBinaryString(file);
}

function autoMapColumns() {
  window.importFieldMap = {};
  const lowerHeaders = window.importHeaders.map(h => h.toLowerCase());
  window.IMPORT_FIELDS.forEach(f => {
    let bestIdx = -1;
    for (const kw of f.keywords) {
      const idx = lowerHeaders.findIndex(h => h === kw);
      if (idx !== -1) { bestIdx = idx; break; }
    }
    if (bestIdx === -1) {
      for (const kw of f.keywords) {
        const idx = lowerHeaders.findIndex(h => h.includes(kw));
        if (idx !== -1) { bestIdx = idx; break; }
      }
    }
    window.importFieldMap[f.key] = bestIdx;
  });
}

function renderColumnMapping() {
  const wrap = document.getElementById('import-map-rows');
  wrap.innerHTML = window.IMPORT_FIELDS.map(f => `
    <div class="import-map-row">
      <div class="col-label">${f.label}</div>
      <select id="import-map-${f.key}" onchange="window.importFieldMap['${f.key}'] = parseInt(this.value)">
        <option value="-1">— Not in file / Skip —</option>
        ${window.importHeaders.map((h, i) => `<option value="${i}" ${window.importFieldMap[f.key] === i ? 'selected' : ''}>${escHtml(h || '(column ' + (i+1) + ')')}</option>`).join('')}
      </select>
    </div>
  `).join('');
}

function buildImportPreview() {
  const nameIdx = window.importFieldMap['name'];
  if (nameIdx === -1 || nameIdx === undefined) {
    alert('Please map a column to "Client Name" before continuing — it\'s required.');
    return;
  }

  const existingByName = new Map(window.clientsList.map(c => [(c.name || '').trim().toLowerCase(), c]));
  const seenInFile = new Set();
  const BACKFILLABLE_FIELDS = window.IMPORT_FIELDS.map(f => f.key).filter(k => k !== 'name');

  window.importPreviewRows = [];
  let currentMainRow = null; // reference to the most recent valid/dupe row, for attaching extra shareholders

  window.importDataRows.forEach(row => {
    const rec = {};
    window.IMPORT_FIELDS.forEach(f => {
      const idx = window.importFieldMap[f.key];
      rec[f.key] = (idx !== undefined && idx !== -1) ? String(row[idx] || '').trim() : '';
    });

    // A nameless row that follows a company row and carries a shareholder-column
    // value is treated as an additional shareholder for that company, not a
    // separate (broken) client record — this is the actual shape of company
    // spreadsheets that list every shareholder, one per row, under one company.
    if (!rec.name && currentMainRow && rec.shareholder_name) {
      currentMainRow.extraShareholders.push(rec.shareholder_name);
      window.importPreviewRows.push({ ...rec, status: 'extra-shareholder' });
      return;
    }

    let status = 'valid';
    let existingClient = null;
    let fieldsToBackfill = {};
    if (!rec.name) {
      status = 'bad';
    } else {
      const key = rec.name.toLowerCase();
      existingClient = existingByName.get(key) || null;
      if (existingClient || seenInFile.has(key)) {
        status = 'dupe';
        // Only a true existing-database match can be backfilled — a same-file
        // repeat with no DB record has nothing to update.
        if (existingClient) {
          BACKFILLABLE_FIELDS.forEach(k => {
            if (!existingClient[k] && rec[k]) fieldsToBackfill[k] = rec[k];
          });
        }
      }
      seenInFile.add(key);
    }
    const fullRec = { ...rec, status, extraShareholders: [], existingClientId: existingClient ? existingClient.id : null, fieldsToBackfill };
    window.importPreviewRows.push(fullRec);
    currentMainRow = (status === 'valid' || status === 'dupe') ? fullRec : null;
  });

  renderImportPreview();
  showImportStep(3);
}

function renderImportPreview() {
  const mainRows = window.importPreviewRows.filter(r => r.status !== 'extra-shareholder');
  const valid = mainRows.filter(r => r.status === 'valid').length;
  const dupes = mainRows.filter(r => r.status === 'dupe').length;
  const bad   = mainRows.filter(r => r.status === 'bad').length;
  const noEmail = mainRows.filter(r => r.status === 'valid' && !r.email).length;
  const extraShareholderCount = window.importPreviewRows.filter(r => r.status === 'extra-shareholder').length;
  const backfillRows = mainRows.filter(r => r.status === 'dupe' && Object.keys(r.fieldsToBackfill || {}).length > 0);

  document.getElementById('import-stats').innerHTML = `
    <div class="import-stat"><div class="num">${mainRows.length}</div><div class="lbl">Companies in File</div></div>
    <div class="import-stat"><div class="num">${valid}</div><div class="lbl">Will Import</div></div>
    <div class="import-stat warn"><div class="num">${dupes}</div><div class="lbl">Duplicates Found</div></div>
    <div class="import-stat bad"><div class="num">${bad}</div><div class="lbl">Missing Name</div></div>
  `;

  const noEmailMsg = noEmail
    ? `⚠️ ${noEmail} of the clients being imported have no email address. You can add emails later from the Client Directory — the "Send Document" feature needs an email before it can be used for that client.`
    : '';
  const extraMsg = extraShareholderCount
    ? `ℹ️ Found ${extraShareholderCount} additional shareholder name${extraShareholderCount === 1 ? '' : 's'} in the file (rows with no company name, listed under the company above them) — these will be attached to their company, not imported as separate clients. Check the "Shareholders" column below.`
    : '';
  const backfillMsg = backfillRows.length
    ? `ℹ️ ${backfillRows.length} existing client${backfillRows.length === 1 ? '' : 's'} ${backfillRows.length === 1 ? 'is' : 'are'} already in your directory but ${backfillRows.length === 1 ? 'is' : 'are'} missing some fields this file has — those blank fields will be filled in. Nothing already on file will be overwritten.`
    : '';
  document.getElementById('import-warning').innerHTML = [noEmailMsg, extraMsg, backfillMsg]
    .filter(Boolean).map(m => `<div class="status-box status-info">${m}</div>`).join('');

  document.getElementById('import-preview-head').innerHTML = `
    <tr><th></th><th>Name</th><th>Entity Type</th><th>Email</th><th>PAN</th><th>Phone</th><th>Shareholders</th></tr>
  `;

  const MAX_SHOW = 60;
  const rowsToShow = mainRows.slice(0, MAX_SHOW);
  document.getElementById('import-preview-body').innerHTML = rowsToShow.map(r => {
    const cls = r.status === 'dupe' ? 'row-dupe' : (r.status === 'bad' ? 'row-bad' : '');
    const backfillCount = Object.keys(r.fieldsToBackfill || {}).length;
    const tag = r.status === 'dupe'
      ? (backfillCount
          ? `<span class="import-row-tag" style="background:#cfe8fb;color:#1a5f8a;">WILL BACKFILL ${backfillCount}</span>`
          : '<span class="import-row-tag" style="background:#fde89a;color:#8a6200;">DUPLICATE</span>')
      : r.status === 'bad'
        ? '<span class="import-row-tag" style="background:#f5b7b1;color:var(--red);">NO NAME</span>'
        : '<span class="import-row-tag" style="background:#b7dfc9;color:var(--green);">NEW</span>';
    const shareholders = [r.shareholder_name, ...(r.extraShareholders || [])].filter(Boolean);
    return `<tr class="${cls}">
      <td>${tag}</td>
      <td>${escHtml(r.name || '—')}</td>
      <td>${escHtml(r.entity_type || '—')}</td>
      <td>${escHtml(r.email || '—')}</td>
      <td>${escHtml(r.pan || '—')}</td>
      <td>${escHtml(r.phone || '—')}</td>
      <td>${shareholders.length ? escHtml(shareholders.join(', ')) : '—'}</td>
    </tr>`;
  }).join('') + (mainRows.length > MAX_SHOW
    ? `<tr><td colspan="7" style="text-align:center; color:var(--muted); padding:10px;">…and ${mainRows.length - MAX_SHOW} more rows not shown (all will still be processed)</td></tr>`
    : '');

  document.getElementById('import-confirm-btn').disabled = valid === 0 && backfillRows.length === 0;
  document.getElementById('import-confirm-btn').textContent = valid
    ? `Import ${valid} Client${valid === 1 ? '' : 's'}`
    : backfillRows.length
      ? `Update ${backfillRows.length} Existing Client${backfillRows.length === 1 ? '' : 's'}`
      : 'Nothing to Import';
}

async function confirmImport() {
  // Keep the original preview row alongside its payload so extraShareholders
  // can be linked to the client id Supabase generates on insert.
  const rowsToInsert = window.importPreviewRows
    .filter(r => r.status === 'valid')
    .map(r => ({
      sourceRow: r,
      payload: {
        name:            r.name,
        email:           r.email || null,
        pan:             r.pan || null,
        phone:           r.phone || null,
        entity_type:     r.entity_type || null,
        business_nature: r.business_nature || null,
        registration_number: r.registration_number || null,
        chairman_name:       r.chairman_name || null,
        shareholder_name:    r.shareholder_name || null,
        authorized_capital:  r.authorized_capital || null,
        issued_capital:      r.issued_capital || null,
        paid_up_capital:     r.paid_up_capital || null,
        address:         r.address || null,
        district:        r.district || null,
        country:         r.country || null,
        it_return_type:  r.it_return_type || null,
        tax_type_d3:     r.tax_type_d3 || null,
      },
    }));

  // Duplicates whose existing record is missing fields this file has — filled
  // in, never overwriting anything already on file.
  const rowsToBackfill = window.importPreviewRows.filter(
    r => r.status === 'dupe' && r.existingClientId && Object.keys(r.fieldsToBackfill || {}).length > 0
  );

  if (!rowsToInsert.length && !rowsToBackfill.length) return;

  const btn = document.getElementById('import-confirm-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('import-result-status');

  const CHUNK = 100;
  let inserted = 0;
  let shareholdersLinked = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
    statusEl.innerHTML = `<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Importing ${inserted}/${rowsToInsert.length}…</div>`;
    const { data, error } = await window.sb.from('clients').insert(chunk.map(c => c.payload)).select('id');
    if (error) {
      statusEl.innerHTML = `<div class="status-box status-error">❌ Stopped after ${inserted} rows: ${escHtml(error.message)}</div>`;
      btn.disabled = false;
      await loadClients();
      return;
    }
    inserted += chunk.length;

    // Postgres/PostgREST returns inserted rows in the same order they were sent.
    const shareholderRows = [];
    (data || []).forEach((row, idx) => {
      (chunk[idx].sourceRow.extraShareholders || []).forEach((name, sIdx) => {
        shareholderRows.push({ client_id: row.id, name, sort_order: sIdx });
      });
    });
    if (shareholderRows.length) {
      const { error: shErr } = await window.sb.from('client_shareholders').insert(shareholderRows);
      if (!shErr) shareholdersLinked += shareholderRows.length;
    }
  }

  let backfilled = 0;
  for (const row of rowsToBackfill) {
    statusEl.innerHTML = `<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Updating existing clients ${backfilled}/${rowsToBackfill.length}…</div>`;
    const { error } = await window.sb.from('clients').update(row.fieldsToBackfill).eq('id', row.existingClientId);
    if (!error) {
      backfilled++;
      if (row.extraShareholders && row.extraShareholders.length) {
        // Only add if this client has no shareholders on file yet, so re-running
        // the same import doesn't create duplicate entries.
        const { data: existing } = await window.sb.from('client_shareholders').select('id').eq('client_id', row.existingClientId).limit(1);
        if (!existing || !existing.length) {
          const shareholderRows = row.extraShareholders.map((name, sIdx) => ({ client_id: row.existingClientId, name, sort_order: sIdx }));
          const { error: shErr } = await window.sb.from('client_shareholders').insert(shareholderRows);
          if (!shErr) shareholdersLinked += shareholderRows.length;
        }
      }
    }
  }

  const parts = [];
  if (inserted) parts.push(`imported ${inserted} client${inserted === 1 ? '' : 's'}`);
  if (backfilled) parts.push(`updated ${backfilled} existing client${backfilled === 1 ? '' : 's'}`);
  if (shareholdersLinked) parts.push(`linked ${shareholdersLinked} additional shareholder${shareholdersLinked === 1 ? '' : 's'}`);
  statusEl.innerHTML = `<div class="status-box status-success">✅ ${parts.join(', ')}.</div>`;
  await loadClients();
  setTimeout(closeImportModal, 1200);
}
