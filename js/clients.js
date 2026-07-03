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
    (c.registration_number || '').toLowerCase().includes(v) ||
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
  ['ac-name','ac-email','ac-pan','ac-phone','ac-entity-type','ac-business','ac-registration-number','ac-chairman-name','ac-shareholder-name','ac-authorized-capital','ac-issued-capital','ac-paidup-capital','ac-address'].forEach(id => document.getElementById(id).value = '');
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
    registration_number: document.getElementById('ac-registration-number').value.trim() || null,
    chairman_name:       document.getElementById('ac-chairman-name').value.trim() || null,
    shareholder_name:    document.getElementById('ac-shareholder-name').value.trim() || null,
    authorized_capital:  document.getElementById('ac-authorized-capital').value.trim() || null,
    issued_capital:      document.getElementById('ac-issued-capital').value.trim() || null,
    paid_up_capital:     document.getElementById('ac-paidup-capital').value.trim() || null,
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
  document.getElementById('ac-registration-number').value = c.registration_number || '';
  document.getElementById('ac-chairman-name').value       = c.chairman_name || '';
  document.getElementById('ac-shareholder-name').value    = c.shareholder_name || '';
  document.getElementById('ac-authorized-capital').value  = c.authorized_capital || '';
  document.getElementById('ac-issued-capital').value      = c.issued_capital || '';
  document.getElementById('ac-paidup-capital').value      = c.paid_up_capital || '';
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
