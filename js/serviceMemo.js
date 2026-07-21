// ════════════════════════════════════════════
//  SERVICE MEMO
//  Internal service record + fee tracking — the firm's guarantee that no
//  professional work is completed without a recorded fee to collect. This is
//  deliberately NOT an accounting/tax invoice (that is Billing, js/billing.js,
//  which carries bank details, a payment QR and a reconciled payments table).
//  A memo is one lightweight row: who did what work for which client, the fee,
//  and a single amount_received for collection tracking. Modeled on billing.js
//  but simpler — no line-item or payments subtable.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'serviceMemo', group: 'main', buttonId: 'nav-serviceMemo', panelId: 'tab-serviceMemo-panel' });

// Payment status is the ONE source for badge + label everywhere (list, PDF,
// dashboard). meta()/badgeHtml() come from the shared WorkflowEngine so the
// badge a table shows can never disagree with what's persisted.
const SM_PAYMENT_STATUSES = {
  pending:        { label: 'Pending',        icon: '🕒', badgeClass: 'badge-amber' },
  partially_paid: { label: 'Partially Paid', icon: '🟡', badgeClass: 'badge-blue' },
  paid:           { label: 'Paid',           icon: '✅', badgeClass: 'badge-sent' },
};
const smStatusFlow = WorkflowEngine.createStatusFlow({ statuses: SM_PAYMENT_STATUSES, onTransition: r => r });

const SM_FILTERS_EMPTY = { firm: '', category: '', fy: '', from: '', to: '' };

let smMemos = [];
let smTable = null;
let smSelectedClient = null;
let smEditingId = null;
let smEditingRow = null;
let smInitDone = false;
let smFilters = { ...SM_FILTERS_EMPTY };

function smUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function smMoney(n) { return 'Rs. ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function smNum(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function smBalance(m) { return Number(m.total_amount || 0) - Number(m.amount_received || 0); }
function smNatureText(m) {
  const sub = (m.nature_subcategory === 'Others' || m.nature_category === 'Others') && m.nature_other
    ? m.nature_other
    : m.nature_subcategory;
  return sub ? `${m.nature_category} — ${sub}` : (m.nature_category || '—');
}
function smStatusMsg(html, type) { showStatus(html, type, 'sm-status-area'); }

// ── Load & refresh ──
async function loadServiceMemo() {
  if (!smInitDone) {
    SearchEngine.attachAutocomplete(document.getElementById('sm-client-search'), document.getElementById('sm-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: smSelectClient,
    });
    smPopulateFilterOptions();
    smInitDone = true;
  }
  await smRefresh();
}

async function smRefresh() {
  smStatusMsg('<span class="spinner spinner-navy"></span> Loading service memos…', 'searching');
  try {
    smMemos = await sbFetchAll(() => window.sb.from('service_memos')
      .select('*, clients(name, email, pan, address)').order('created_at', { ascending: false }));
    smRenderStats();
    smRenderRecent();
    smRenderTable();
    document.getElementById('sm-status-area').innerHTML = '';
  } catch (e) {
    smStatusMsg('❌ Failed to load service memos: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Dashboard (computed client-side — memo volume is small) ──
function smRenderStats() {
  const grid = document.getElementById('sm-stat-grid');
  if (!grid) return;
  let paidAmt = 0;
  smMemos.forEach(m => { paidAmt += Number(m.amount_received || 0); });
  const cards = [
    { label: 'Total Collected', value: smMoney(paidAmt) },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-num" style="font-size:20px;">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join('');
}

function smRenderRecent() {
  const el = document.getElementById('sm-recent-list');
  if (!el) return;
  const rows = smMemos.slice(0, 8);
  if (!rows.length) { el.innerHTML = '<div class="log-empty">No memos yet.</div>'; return; }
  el.innerHTML = rows.map(m => `
    <div class="log-item">
      ${smStatusFlow.badgeHtml(m.payment_status)}
      <div class="log-details">
        <div class="log-client">${escHtml(m.memo_number || '—')} — ${escHtml(m.client_name || '—')}</div>
        <div class="log-sub">${escHtml(smNatureText(m))}</div>
      </div>
      <div class="log-time">${smMoney(m.total_amount)}</div>
    </div>`).join('');
}

// ── List table ──
function smRenderTable() {
  const wrap = document.getElementById('sm-table-wrap');
  if (smTable) { smTable.destroy(); smTable = null; }
  if (!smMemos.length) {
    wrap.innerHTML = '<div class="log-empty">No service memos yet. Click <strong>New Service Memo</strong> to record work performed and the fee to collect.</div>';
    return;
  }
  wrap.innerHTML = '';
  smTable = TableEngine.createTable(wrap, {
    data: smMemos,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    columns: [
      { title: 'Memo #', field: 'memo_number', width: 130, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Date', field: 'memo_date', width: 110 },
      { title: 'Client', field: 'client_name', minWidth: 170, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Firm', field: 'firm_key', width: 90, formatter: c => escHtml((window.SERVICE_MEMO_FIRMS[c.getValue()] || {}).name || c.getValue() || '—') },
      { title: 'Nature', field: 'nature_category', minWidth: 180, formatter: c => escHtml(smNatureText(c.getRow().getData())) },
      { title: 'F.Y.', field: 'fiscal_year', width: 90, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Total', field: 'total_amount', width: 110, hozAlign: 'right', formatter: c => smNum(c.getValue()) },
      { title: 'Received', field: 'amount_received', width: 110, hozAlign: 'right', formatter: c => smNum(c.getValue()) },
      { title: 'Balance', field: 'total_amount', width: 110, hozAlign: 'right', formatter: c => {
          const bal = smBalance(c.getRow().getData());
          return bal > 0.005 ? `<span style="font-weight:600; color:var(--red);">${smNum(bal)}</span>` : '—';
        } },
      { title: 'Status', field: 'payment_status', width: 150, formatter: c => smStatusFlow.badgeHtml(c.getValue()) },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 210, formatter: () => smRowActions(),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          if (btn.dataset.action === 'edit') smOpenCreate(row);
          else if (btn.dataset.action === 'pdf') smDownloadPdf(row);
          else if (btn.dataset.action === 'delete') smDeleteMemo(row);
        } },
    ],
  });
}

function smRowActions() {
  const btn = (a, label, title) => `<button class="btn btn-outline btn-sm" data-action="${a}" title="${title || label}">${label}</button>`;
  return `<div class="client-actions">${btn('edit', 'Edit')}${btn('pdf', 'PDF', 'Download Service Memo PDF')}${btn('delete', 'Delete')}</div>`;
}

// ── Filters ──
function smPopulateFilterOptions() {
  const firmSel = document.getElementById('sm-filter-firm');
  firmSel.innerHTML = '<option value="">All firms</option>' +
    Object.values(window.SERVICE_MEMO_FIRMS).map(f => `<option value="${escHtml(f.key)}">${escHtml(f.name)}</option>`).join('');
  const catSel = document.getElementById('sm-filter-category');
  catSel.innerHTML = '<option value="">All categories</option>' +
    window.SERVICE_MEMO_TASKS.map(t => `<option value="${escHtml(t.category)}">${escHtml(t.category)}</option>`).join('');
}

function smReadFilters() {
  smFilters = {
    firm: document.getElementById('sm-filter-firm').value,
    category: document.getElementById('sm-filter-category').value,
    fy: document.getElementById('sm-filter-fy').value.trim(),
    from: document.getElementById('sm-filter-from').value,
    to: document.getElementById('sm-filter-to').value,
  };
}

function smApplyFilters() {
  if (!smTable) return;
  let rows = smMemos.filter(m => {
    if (smFilters.firm && m.firm_key !== smFilters.firm) return false;
    if (smFilters.category && m.nature_category !== smFilters.category) return false;
    if (smFilters.fy && (m.fiscal_year || '') !== smFilters.fy) return false;
    if (smFilters.from && (m.memo_date || '') < smFilters.from) return false;
    if (smFilters.to && (m.memo_date || '') > smFilters.to) return false;
    return true;
  });
  const q = (document.getElementById('sm-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['memo_number', 'client_name', 'client_pan', 'nature_category', 'nature_subcategory', 'nature_other', 'description']);
    rows = fuse.search(q).map(r => r.item);
  }
  smTable.replaceData(rows);
}
function smOnFilterChange() { smReadFilters(); smApplyFilters(); }
function smClearFilters() {
  ['sm-filter-firm', 'sm-filter-category', 'sm-filter-fy', 'sm-filter-from', 'sm-filter-to', 'sm-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  smFilters = { ...SM_FILTERS_EMPTY };
  smApplyFilters();
}

// ── Create / Edit drawer ──
function smSelectClient(c) {
  smSelectedClient = c;
  document.getElementById('sm-client-search').value = c.name;
  document.getElementById('sm-client-pan').value = c.pan || '';
  document.getElementById('sm-client-address').value = c.address || '';
}

function smPopulateCategorySelect() {
  const cat = document.getElementById('sm-nature-category');
  cat.innerHTML = '<option value="">Select category…</option>' +
    window.SERVICE_MEMO_TASKS.map(t => `<option value="${escHtml(t.category)}">${escHtml(t.category)}</option>`).join('');
}
function smOnCategoryChange() {
  const catVal = document.getElementById('sm-nature-category').value;
  const sub = document.getElementById('sm-nature-subcategory');
  const found = window.SERVICE_MEMO_TASKS.find(t => t.category === catVal);
  const subs = found ? found.subs : [];
  sub.innerHTML = '<option value="">Select sub-category…</option>' +
    subs.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  smOnSubcategoryChange();
}
function smOnSubcategoryChange() {
  const cat = document.getElementById('sm-nature-category').value;
  const sub = document.getElementById('sm-nature-subcategory').value;
  const showOther = cat === 'Others' || sub === 'Others';
  document.getElementById('sm-nature-other-group').style.display = showOther ? '' : 'none';
}

function smComputeTotals() {
  const fee = parseFloat(document.getElementById('sm-fee').value) || 0;
  const applyVat = document.getElementById('sm-apply-vat').checked;
  const vat = applyVat ? fee * window.VAT_STANDARD_RATE : 0;
  return { fee, vat, total: fee + vat };
}
function smRenderTotals() {
  const t = smComputeTotals();
  document.getElementById('sm-total-vat').textContent = smNum(t.vat);
  document.getElementById('sm-total-amount').textContent = smNum(t.total);
  smDeriveStatus();
}
// Payment status is fully derived from amount received vs total — no manual
// control or visible label in the drawer at all (removed per user feedback);
// it's computed here purely so smSaveMemo has a valid value to persist. The
// Status badge still shows in the main list table, just not during entry.
function smDeriveStatus() {
  const total = smComputeTotals().total;
  const recv = parseFloat(document.getElementById('sm-amount-received').value) || 0;
  const status = (recv >= total && total > 0) ? 'paid' : recv > 0 ? 'partially_paid' : 'pending';
  const balance = Math.max(total - recv, 0);
  const balEl = document.getElementById('sm-balance-due');
  balEl.textContent = smNum(balance);
  balEl.style.color = balance > 0.005 ? 'var(--red)' : 'var(--green-dk)';
  return status;
}

function smOpenCreate(existing) {
  smEditingId = existing ? existing.id : null;
  smEditingRow = existing || null;
  smSelectedClient = null;
  document.getElementById('sm-delete-btn').style.display = existing ? '' : 'none';
  document.getElementById('sm-drawer-title').textContent = existing ? `Edit ${existing.memo_number || 'Service Memo'}` : 'New Service Memo';
  document.getElementById('sm-drawer-status').innerHTML = '';

  smPopulateCategorySelect();

  document.getElementById('sm-firm-key').value = existing ? existing.firm_key : 'shailesh';
  document.getElementById('sm-memo-date').value = existing ? existing.memo_date : new Date().toISOString().slice(0, 10);
  document.getElementById('sm-client-search').value = existing ? (existing.client_name || '') : '';
  document.getElementById('sm-client-pan').value = existing ? (existing.client_pan || '') : '';
  document.getElementById('sm-client-address').value = existing ? (existing.client_address || '') : '';
  document.getElementById('sm-nature-category').value = existing ? (existing.nature_category || '') : '';
  smOnCategoryChange();
  document.getElementById('sm-nature-subcategory').value = existing ? (existing.nature_subcategory || '') : '';
  smOnSubcategoryChange();
  document.getElementById('sm-nature-other').value = existing ? (existing.nature_other || '') : '';
  document.getElementById('sm-description').value = existing ? (existing.description || '') : '';
  document.getElementById('sm-fee').value = existing ? existing.professional_fee : '';
  document.getElementById('sm-apply-vat').checked = existing ? !!existing.apply_vat : false;
  document.getElementById('sm-amount-received').value = existing ? (Number(existing.amount_received) || '') : '';
  document.getElementById('sm-payment-date').value = existing ? (existing.payment_date || '') : '';
  document.getElementById('sm-remarks').value = existing ? (existing.remarks || '') : '';

  const bs = NepaliLocale.todayBs();
  const defaultFy = bs ? NepaliLocale.bsFiscal(bs).fy.replace('/', '-') : '';
  document.getElementById('sm-fiscal-year').value = existing ? (existing.fiscal_year || '') : defaultFy;

  if (existing && existing.client_id) {
    const c = (window.clientsList || []).find(x => x.id === existing.client_id);
    if (c) smSelectedClient = c;
  }

  smRenderTotals();
  document.getElementById('sm-memo-drawer').classList.add('open');
}
function smCloseCreate() { document.getElementById('sm-memo-drawer').classList.remove('open'); }

async function smDeleteFromDrawer() {
  if (!smEditingRow) return;
  await smDeleteMemo(smEditingRow);
  // smDeleteMemo no-ops (keeps the drawer open) if the user cancels the
  // confirm() prompt — only close once the row is actually gone.
  const stillExists = smMemos.some(m => m.id === smEditingRow.id);
  if (!stillExists) smCloseCreate();
}

function smDrawerErr(msg) { showStatus(escHtml(msg), 'info', 'sm-drawer-status'); }

async function smSaveMemo() {
  const clientName = document.getElementById('sm-client-search').value.trim();
  if (!clientName) { smDrawerErr('Enter or select a client.'); return; }
  const firmKey = document.getElementById('sm-firm-key').value;
  const firm = window.SERVICE_MEMO_FIRMS[firmKey];
  if (!firm) { smDrawerErr('Select a firm.'); return; }
  const category = document.getElementById('sm-nature-category').value;
  if (!category) { smDrawerErr('Select the nature of task.'); return; }

  const t = smComputeTotals();
  const recv = parseFloat(document.getElementById('sm-amount-received').value) || 0;
  // Keep client_id only while the name still matches the picked client — a
  // hand-edited name becomes a typed-only (nullable) client.
  const clientId = (smSelectedClient && smSelectedClient.name === clientName) ? smSelectedClient.id : null;

  const payload = {
    memo_prefix: firm.prefix,
    firm_key: firmKey,
    memo_date: document.getElementById('sm-memo-date').value || new Date().toISOString().slice(0, 10),
    client_id: clientId,
    client_name: clientName,
    client_pan: document.getElementById('sm-client-pan').value.trim() || null,
    client_address: document.getElementById('sm-client-address').value.trim() || null,
    nature_category: category,
    nature_subcategory: document.getElementById('sm-nature-subcategory').value || null,
    nature_other: document.getElementById('sm-nature-other').value.trim() || null,
    description: document.getElementById('sm-description').value.trim() || null,
    fiscal_year: document.getElementById('sm-fiscal-year').value.trim() || null,
    professional_fee: t.fee,
    apply_vat: document.getElementById('sm-apply-vat').checked,
    vat_amount: t.vat,
    total_amount: t.total,
    payment_status: smDeriveStatus(),
    amount_received: recv,
    payment_date: document.getElementById('sm-payment-date').value || null,
    remarks: document.getElementById('sm-remarks').value.trim() || null,
    updated_by: smUserEmail(),
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'sm-drawer-status');
  try {
    if (smEditingId) {
      const { error } = await window.sb.from('service_memos').update(payload).eq('id', smEditingId);
      if (error) throw error;
      AuditLog.record('service_memo_updated', { module: 'serviceMemo', clientName, recordRef: smEditingId });
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('service_memos').insert(payload).select('id').single();
      if (error) throw error;
      // memo_number is filled by an AFTER INSERT trigger, so it isn't in this
      // returned row — smRefresh() below reloads it. (Same gotcha as invoices.)
      AuditLog.record('service_memo_created', { module: 'serviceMemo', clientName, recordRef: data.id });
    }
    smCloseCreate();
    await smRefresh();
    smStatusMsg('✅ Service memo saved.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'sm-drawer-status');
  }
}

async function smDeleteMemo(row) {
  if (!confirm(`Delete service memo ${row.memo_number || ''} for ${row.client_name || 'this client'}? This cannot be undone.`)) return;
  const { error } = await window.sb.from('service_memos').delete().eq('id', row.id);
  if (error) { smStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('service_memo_deleted', { module: 'serviceMemo', clientName: row.client_name, recordRef: row.id });
  await smRefresh();
}

// ── PDF (formal Service Memo — reuses the PDF-Lib approach of billing.js) ──
function smFirmIdentity(firmKey) {
  const f = window.SERVICE_MEMO_FIRMS[firmKey] || window.SERVICE_MEMO_FIRMS.shailesh;
  const base = f.ref ? window.REP_FIRMS[f.ref] : null;
  return {
    name: f.name,
    title: base ? base.title : '',
    address: (base ? base.address : f.address) || '',
    phone: (base ? base.phone : f.phone) || '',
    email: (base ? base.email : f.email) || '',
    pan: (base ? base.pan : f.pan) || '',
    signatoryName: base ? base.signatoryName : '',
    signatoryTitle: base ? base.signatoryTitle : '',
  };
}

function smWrapText(font, size, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach(w => {
    const test = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  });
  if (line) lines.push(line);
  return lines;
}

async function smBuildMemoPdf(memo) {
  const firm = smFirmIdentity(memo.firm_key);
  const doc = await PDFLib.PDFDocument.create();
  let page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const navy = PDFLib.rgb(0.043, 0.122, 0.239);
  const muted = PDFLib.rgb(0.392, 0.455, 0.545);
  const black = PDFLib.rgb(0.1, 0.12, 0.16);
  const line = PDFLib.rgb(0.9, 0.91, 0.95);
  const marginL = 50, marginR = 545;
  let y = 792;
  const draw = (text, x, size, f, color) => page.drawText(String(text), { x, y, size, font: f || font, color: color || black });
  const drawRight = (text, xEnd, size, f, color) => {
    const w = (f || font).widthOfTextAtSize(String(text), size);
    page.drawText(String(text), { x: xEnd - w, y, size, font: f || font, color: color || black });
  };
  const dash = v => (v == null || v === '' ? '—' : v);

  // Letterhead (left)
  draw(firm.name, marginL, 16, bold, navy); y -= 15;
  if (firm.title) { draw(firm.title, marginL, 9.5, font, muted); y -= 12; }
  draw(dash(firm.address), marginL, 9, font, muted); y -= 12;
  if (firm.phone || firm.email) { draw(`${firm.phone ? 'Phone: ' + firm.phone : ''}${firm.phone && firm.email ? '  ·  ' : ''}${firm.email ? 'Email: ' + firm.email : ''}`, marginL, 9, font, muted); y -= 12; }
  draw(`PAN: ${dash(firm.pan)}`, marginL, 9, font, muted);

  // Title block (right)
  y = 792;
  drawRight('SERVICE MEMO', marginR, 19, bold, navy); y -= 19;
  drawRight(memo.memo_number || '(pending)', marginR, 11, bold); y -= 14;
  drawRight(`Date: ${dash(memo.memo_date)}`, marginR, 9.5, font, muted); y -= 12;
  if (memo.fiscal_year) drawRight(`F.Y. ${memo.fiscal_year}`, marginR, 9.5, font, muted);

  // Client block
  y = 700;
  draw('Client:', marginL, 10, bold, navy); y -= 14;
  draw(dash(memo.client_name), marginL, 11, bold); y -= 13;
  if (memo.client_address) { draw(memo.client_address, marginL, 9.5, font, muted); y -= 12; }
  if (memo.client_pan) { draw(`PAN: ${memo.client_pan}`, marginL, 9.5, font, muted); y -= 12; }

  // Nature + description
  y -= 8;
  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line }); y -= 16;
  draw('Nature of Task', marginL, 9.5, bold, muted); y -= 13;
  draw(smNatureText(memo), marginL, 11, font, black); y -= 18;
  if (memo.description) {
    draw('Description', marginL, 9.5, bold, muted); y -= 13;
    smWrapText(font, 10, memo.description, marginR - marginL).forEach(ln => { draw(ln, marginL, 10, font, black); y -= 13; });
    y -= 4;
  }

  // Fee table
  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line }); y -= 16;
  draw('Professional Fee', marginL, 10, font, black); drawRight(smNum(memo.professional_fee), marginR, 10, font, black); y -= 14;
  if (Number(memo.vat_amount) > 0) { draw('VAT (13%)', marginL, 10, font, muted); drawRight(smNum(memo.vat_amount), marginR, 10, font, muted); y -= 14; }
  page.drawLine({ start: { x: marginL, y: y + 3 }, end: { x: marginR, y: y + 3 }, thickness: 1, color: line }); y -= 3;
  draw('Total', marginL, 12, bold, navy); drawRight(smNum(memo.total_amount), marginR, 12, bold, navy); y -= 24;

  // Payment status
  draw('Payment Status', marginL, 9.5, bold, muted); y -= 15;
  const st = SM_PAYMENT_STATUSES[memo.payment_status] || { label: memo.payment_status };
  draw(st.label, marginL, 11, bold, black);
  drawRight(`Received: ${smNum(memo.amount_received)}`, 400, 10, font, black);
  drawRight(`Balance: ${smNum(smBalance(memo))}`, marginR, 10, bold, smBalance(memo) > 0.005 ? PDFLib.rgb(0.8, 0.1, 0.1) : black);
  y -= 14;
  if (memo.payment_date) { draw(`Payment Date: ${memo.payment_date}`, marginL, 9.5, font, muted); y -= 14; }
  if (memo.remarks) {
    y -= 4; draw('Remarks', marginL, 9.5, bold, muted); y -= 12;
    smWrapText(font, 9, memo.remarks, marginR - marginL).forEach(ln => { draw(ln, marginL, 9, font, black); y -= 11; });
  }

  // Footer — this is the whole point: NOT a tax invoice.
  page.drawLine({ start: { x: marginL, y: 92 }, end: { x: marginR, y: 92 }, thickness: 1, color: line });
  page.drawText('Internal service record — not a tax invoice.', { x: marginL, y: 78, size: 8.5, font, color: muted });
  if (firm.signatoryName) {
    page.drawText(firm.signatoryName, { x: marginR - bold.widthOfTextAtSize(firm.signatoryName, 9.5), y: 74, size: 9.5, font: bold, color: black });
    page.drawText(firm.signatoryTitle, { x: marginR - font.widthOfTextAtSize(firm.signatoryTitle, 8.5), y: 62, size: 8.5, font, color: muted });
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function smDownloadPdf(row) {
  try {
    const blob = await smBuildMemoPdf(row);
    const fname = `Service Memo ${row.memo_number || row.id} - ${row.client_name || 'Client'}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'serviceMemo', clientName: row.client_name });
  } catch (e) {
    smStatusMsg('❌ Failed to generate PDF: ' + escHtml(e.message || String(e)), 'error');
  }
}
