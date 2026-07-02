// ════════════════════════════════════════════
//  CLIENT AUTOCOMPLETE
// ════════════════════════════════════════════
function handleClientSearch(val) {
  window.acSelectedIdx = -1;
  const list = document.getElementById('autocomplete-list');
  if (!val || val.length < 1) { list.style.display = 'none'; return; }

  const matches = window.clientsList.filter(c =>
    c.name.toLowerCase().includes(val.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(val.toLowerCase())
  ).slice(0, 8);

  if (matches.length === 0) { list.style.display = 'none'; return; }

  list.innerHTML = matches.map((c, i) => `
    <div class="autocomplete-item" data-idx="${i}" onmousedown="selectClient('${c.id}')">
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.email || 'No email on file')}</div>
    </div>
  `).join('');
  list.style.display = 'block';
}

function handleClientKey(e) {
  const list = document.getElementById('autocomplete-list');
  const items = list.querySelectorAll('.autocomplete-item');
  if (!items.length || list.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    window.acSelectedIdx = Math.min(window.acSelectedIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    window.acSelectedIdx = Math.max(window.acSelectedIdx - 1, 0);
  } else if (e.key === 'Enter' && window.acSelectedIdx >= 0) {
    e.preventDefault();
    items[window.acSelectedIdx].dispatchEvent(new Event('mousedown'));
    return;
  } else if (e.key === 'Escape') {
    list.style.display = 'none'; return;
  }
  items.forEach((el, i) => el.classList.toggle('selected', i === window.acSelectedIdx));
}

function selectClient(id) {
  const c = window.clientsList.find(x => String(x.id) === String(id));
  if (!c) return;
  document.getElementById('clientName').value  = c.name;
  document.getElementById('clientEmail').value = c.email || '';
  document.getElementById('autocomplete-list').style.display = 'none';
}

// Close autocomplete on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('#clientName-group')) {
    const list = document.getElementById('autocomplete-list');
    if (list) list.style.display = 'none';
  }
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
  renderClientsTable(window.clientsList);
  renderClientStats(window.clientsList);
}

function renderClientStats(list) {
  const total       = list.length;
  const withEmail   = list.filter(c => c.email).length;
  const missingEmail= total - withEmail;
  const entityTypes = new Set(list.filter(c => c.entity_type).map(c => c.entity_type.trim().toLowerCase())).size;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-total-clients', total);
  set('stat-with-email', withEmail);
  set('stat-missing-email', missingEmail);
  set('stat-entity-types', entityTypes);
}

function clientInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function renderClientsTable(list) {
  const wrap = document.getElementById('clients-table-wrap');
  if (!list.length) {
    wrap.innerHTML = '<div class="log-empty">No clients yet. Add your first client above.</div>';
    return;
  }

  const isAdmin = window.currentUser?.role === 'admin';
  wrap.innerHTML = `
    <table class="client-table">
      <thead>
        <tr>
          <th>Client Name</th>
          <th>Entity Type</th>
          <th>Email</th>
          <th>PAN</th>
          <th>Phone</th>
          ${isAdmin ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${list.map(c => `
          <tr>
            <td>
              <div class="client-name-row">
                <div class="client-avatar">${escHtml(clientInitials(c.name))}</div>
                <div class="client-name-cell">${escHtml(c.name)}</div>
              </div>
            </td>
            <td>${c.entity_type ? `<span class="entity-badge">${escHtml(c.entity_type)}</span>` : '—'}</td>
            <td>${escHtml(c.email || '—')}</td>
            <td>${escHtml(c.pan || '—')}</td>
            <td>${escHtml(c.phone || '—')}</td>
            ${isAdmin ? `
            <td>
              <div class="client-actions">
                <button class="btn btn-outline btn-sm" onclick="editClient('${c.id}')">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteClient('${c.id}')">Delete</button>
              </div>
            </td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function filterClientTable(val) {
  const v = val.toLowerCase();
  const filtered = window.clientsList.filter(c =>
    c.name.toLowerCase().includes(v) ||
    (c.email || '').toLowerCase().includes(v) ||
    (c.pan || '').toLowerCase().includes(v) ||
    (c.entity_type || '').toLowerCase().includes(v)
  );
  renderClientsTable(filtered);
}

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
  ['ac-name','ac-email','ac-pan','ac-phone','ac-entity-type','ac-business','ac-address'].forEach(id => document.getElementById(id).value = '');
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
    business_nature: document.getElementById('ac-business').value.trim() || null,
    address:       document.getElementById('ac-address').value.trim() || null,
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
  document.getElementById('ac-business').value    = c.business_nature || '';
  document.getElementById('ac-address').value     = c.address || '';
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

  const existingNames = new Set(window.clientsList.map(c => (c.name || '').trim().toLowerCase()));
  const seenInFile = new Set();

  window.importPreviewRows = window.importDataRows.map(row => {
    const rec = {};
    window.IMPORT_FIELDS.forEach(f => {
      const idx = window.importFieldMap[f.key];
      rec[f.key] = (idx !== undefined && idx !== -1) ? String(row[idx] || '').trim() : '';
    });

    let status = 'valid';
    if (!rec.name) {
      status = 'bad';
    } else {
      const key = rec.name.toLowerCase();
      if (existingNames.has(key) || seenInFile.has(key)) {
        status = 'dupe';
      }
      seenInFile.add(key);
    }
    return { ...rec, status };
  });

  renderImportPreview();
  showImportStep(3);
}

function renderImportPreview() {
  const valid = window.importPreviewRows.filter(r => r.status === 'valid').length;
  const dupes = window.importPreviewRows.filter(r => r.status === 'dupe').length;
  const bad   = window.importPreviewRows.filter(r => r.status === 'bad').length;
  const noEmail = window.importPreviewRows.filter(r => r.status === 'valid' && !r.email).length;

  document.getElementById('import-stats').innerHTML = `
    <div class="import-stat"><div class="num">${window.importPreviewRows.length}</div><div class="lbl">Rows in File</div></div>
    <div class="import-stat"><div class="num">${valid}</div><div class="lbl">Will Import</div></div>
    <div class="import-stat warn"><div class="num">${dupes}</div><div class="lbl">Duplicates Skipped</div></div>
    <div class="import-stat bad"><div class="num">${bad}</div><div class="lbl">Missing Name</div></div>
  `;

  document.getElementById('import-warning').innerHTML = noEmail
    ? `<div class="status-box status-info">⚠️ ${noEmail} of the clients being imported have no email address. You can add emails later from the Client Directory — the "Send Document" feature needs an email before it can be used for that client.</div>`
    : '';

  document.getElementById('import-preview-head').innerHTML = `
    <tr><th></th><th>Name</th><th>Entity Type</th><th>Email</th><th>PAN</th><th>Phone</th></tr>
  `;

  const MAX_SHOW = 60;
  const rowsToShow = window.importPreviewRows.slice(0, MAX_SHOW);
  document.getElementById('import-preview-body').innerHTML = rowsToShow.map(r => {
    const cls = r.status === 'dupe' ? 'row-dupe' : (r.status === 'bad' ? 'row-bad' : '');
    const tag = r.status === 'dupe'
      ? '<span class="import-row-tag" style="background:#fde89a;color:#8a6200;">DUPLICATE</span>'
      : r.status === 'bad'
        ? '<span class="import-row-tag" style="background:#f5b7b1;color:var(--red);">NO NAME</span>'
        : '<span class="import-row-tag" style="background:#b7dfc9;color:var(--green);">NEW</span>';
    return `<tr class="${cls}">
      <td>${tag}</td>
      <td>${escHtml(r.name || '—')}</td>
      <td>${escHtml(r.entity_type || '—')}</td>
      <td>${escHtml(r.email || '—')}</td>
      <td>${escHtml(r.pan || '—')}</td>
      <td>${escHtml(r.phone || '—')}</td>
    </tr>`;
  }).join('') + (window.importPreviewRows.length > MAX_SHOW
    ? `<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:10px;">…and ${window.importPreviewRows.length - MAX_SHOW} more rows not shown (all will still be processed)</td></tr>`
    : '');

  document.getElementById('import-confirm-btn').disabled = valid === 0;
  document.getElementById('import-confirm-btn').textContent = valid
    ? `Import ${valid} Client${valid === 1 ? '' : 's'}`
    : 'Nothing to Import';
}

async function confirmImport() {
  const rowsToInsert = window.importPreviewRows
    .filter(r => r.status === 'valid')
    .map(r => ({
      name:            r.name,
      email:           r.email || null,
      pan:             r.pan || null,
      phone:           r.phone || null,
      entity_type:     r.entity_type || null,
      business_nature: r.business_nature || null,
      address:         r.address || null,
    }));

  if (!rowsToInsert.length) return;

  const btn = document.getElementById('import-confirm-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('import-result-status');

  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
    statusEl.innerHTML = `<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Importing ${inserted}/${rowsToInsert.length}…</div>`;
    const { error } = await window.sb.from('clients').insert(chunk);
    if (error) {
      statusEl.innerHTML = `<div class="status-box status-error">❌ Stopped after ${inserted} rows: ${escHtml(error.message)}</div>`;
      btn.disabled = false;
      await loadClients();
      return;
    }
    inserted += chunk.length;
  }

  statusEl.innerHTML = `<div class="status-box status-success">✅ Imported ${inserted} client${inserted === 1 ? '' : 's'} successfully.</div>`;
  await loadClients();
  setTimeout(closeImportModal, 1200);
}
