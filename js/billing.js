// ════════════════════════════════════════════
//  BILLING
//  Tracks what clients owe for the firm's own services (audit, VAT return
//  prep, registration work, ...) — separate from VAT Compliance, which
//  tracks CLIENTS' VAT filing obligations to IRD, not money owed to the
//  firm. Invoices are created here, rendered to PDF (PDF-Lib) with the
//  firm's bank details + payment QR, optionally emailed via Gmail
//  (Integrations), and reconciled against payments recorded here — Supabase
//  triggers keep invoices.amount_paid/status in sync with invoice_payments,
//  so "amount due" can never drift between the two tables.
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Financial Management" menu, not a sidebar button.
ModuleRegistry.register({ id: 'billing', group: 'main', buttonId: null, panelId: 'tab-billing-panel' });

const BILLING_STATUSES = {
  draft:          { label: 'Draft',           icon: '📝', badgeClass: 'badge-neutral' },
  sent:           { label: 'Sent',            icon: '📤', badgeClass: 'badge-blue' },
  partially_paid: { label: 'Partially Paid',  icon: '🟡', badgeClass: 'badge-amber' },
  paid:           { label: 'Paid',            icon: '✅', badgeClass: 'badge-sent' },
  void:           { label: 'Void',            icon: '🚫', badgeClass: 'badge-error' },
};

// Explicit, human-driven status changes only (Draft -> Sent, -> Void).
// partially_paid/paid are set by the sync_invoice_payment_totals DB trigger
// whenever a payment is recorded — never through this flow.
const billingFlow = WorkflowEngine.createStatusFlow({
  statuses: BILLING_STATUSES,
  onTransition: async (row, from, to) => {
    const { error } = await window.sb.from('invoices').update({
      status: to, updated_by: (window.currentUser && window.currentUser.email) || null,
    }).eq('id', row.id);
    if (error) throw error;
    row.status = to;
    AuditLog.record('invoice_status_change', {
      module: 'billing', clientName: row.clients && row.clients.name, recordRef: row.id,
      oldStatus: from, newStatus: to,
    });
    return row;
  },
});

function billingIsOverdue(row) {
  if (['paid', 'void'].includes(row.status) || !row.due_date) return false;
  return row.due_date < new Date().toISOString().slice(0, 10);
}

function billingAmountDue(row) {
  return Number(row.total_amount || 0) - Number(row.amount_paid || 0);
}

const BILLING_FILTERS = {
  all:         { label: 'All Invoices',    test: () => true },
  draft:       { label: 'Draft',           test: r => r.status === 'draft' },
  sent:        { label: 'Sent',            test: r => r.status === 'sent' },
  outstanding: { label: 'Outstanding',     test: r => !['paid', 'void'].includes(r.status) && billingAmountDue(r) > 0.005 },
  overdue:     { label: 'Overdue',         test: billingIsOverdue },
  partial:     { label: 'Partially Paid',  test: r => r.status === 'partially_paid' },
  paid:        { label: 'Paid',            test: r => r.status === 'paid' },
};

let billingInvoices = [];
let billingTable = null;
let billingArTable = null;
let billingIncomeChart = null;
let billingActiveFilter = 'all';
let billingFirmDetails = null;   // { shailesh: {...}, dallakoti: {...} } from firm_bank_details
let billingSelectedClient = null;
let billingEditingInvoiceId = null;
let billingDraftItems = [];      // [{ description, quantity, rate }]
let billingPaymentRow = null;
let billingInitDone = false;
let billingLastStats = {};

function billingStatusMsg(html, type) {
  showStatus(html, type, 'billing-status-area');
}

// ── Load & refresh ──
async function loadBilling() {
  if (!billingInitDone) {
    SearchEngine.attachAutocomplete(document.getElementById('billing-client-search'), document.getElementById('billing-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: billingSelectClient,
    });
    billingInitDone = true;
  }
  await billingLoadFirmDetails();
  await billingRefresh();
}

async function billingLoadFirmDetails() {
  const { data, error } = await window.sb.from('firm_bank_details').select('*');
  if (error) { billingFirmDetails = {}; return; }
  billingFirmDetails = {};
  (data || []).forEach(row => { billingFirmDetails[row.firm_key] = row; });
}

async function billingRefresh() {
  billingStatusMsg('<span class="spinner spinner-navy"></span> Loading invoices…', 'searching');
  try {
    const invoices = await sbFetchAll(() => window.sb.from('invoices')
      .select('*, clients(name, email, pan, address)').order('created_at', { ascending: false }));
    billingInvoices = invoices;

    const { data: stats } = await window.sb.rpc('get_billing_stats');
    billingRenderStats((stats && stats[0]) || {});
    billingRenderTable(invoices);
    billingApplyFilters();
    billingRenderAr(invoices);
    await billingRenderIncomeChart();
    document.getElementById('billing-status-area').innerHTML = '';
  } catch (e) {
    billingStatusMsg('❌ Failed to load invoices: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Stat cards ──
function billingRenderStats(s) {
  billingLastStats = s;
  const grid = document.getElementById('billing-stat-grid');
  if (!grid) return;
  const money = n => 'Rs. ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cards = [
    { key: 'outstanding', label: 'Total Outstanding',          value: money(s.total_outstanding), clickable: true },
    { key: 'overdue',     label: 'Overdue Amount',             value: money(s.overdue_amount), clickable: true },
    { key: null,          label: "This Month's Income",        value: money(s.month_income), clickable: false },
    { key: null,          label: 'Invoices Sent This Month',   value: s.invoices_sent_month || 0, clickable: false },
    { key: 'draft',       label: 'Draft Invoices',             value: s.draft_count || 0, clickable: true },
    { key: 'paid',        label: 'Paid This Month',            value: s.paid_month_count || 0, clickable: false },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="stat-card ${c.clickable ? 'clickable' : ''} ${c.clickable && billingActiveFilter === c.key ? 'active-filter' : ''}"
      ${c.clickable ? `onclick="billingSetFilter('${c.key}')" title="Click to filter the table below"` : ''}>
      <div class="stat-num" style="font-size:20px;">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join('');
}

function billingSetFilter(key) {
  billingActiveFilter = billingActiveFilter === key ? 'all' : key;
  billingRenderStats(billingLastStats || {});
  billingApplyFilters();
}

// ── Invoices table ──
function billingRenderTable(invoices) {
  const wrap = document.getElementById('billing-table-wrap');
  if (billingTable) { billingTable.destroy(); billingTable = null; }

  if (!invoices.length) {
    wrap.innerHTML = '<div class="log-empty">No invoices yet. Click <strong>New Invoice</strong> to bill a client for your services.</div>';
    return;
  }

  wrap.innerHTML = '';
  billingTable = TableEngine.createTable(wrap, {
    data: invoices,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    rowFormatter: row => row.getElement().classList.toggle('billing-row-overdue', billingIsOverdue(row.getData())),
    columns: [
      { title: 'Invoice #', field: 'invoice_number', width: 120, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Client', field: 'clients.name', minWidth: 180, formatter: cell => escHtml((cell.getRow().getData().clients || {}).name || '—') },
      { title: 'Issue Date', field: 'issue_date', width: 110 },
      { title: 'Due Date', field: 'due_date', width: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Total', field: 'total_amount', width: 110, hozAlign: 'right', formatter: cell => Number(cell.getValue() || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      { title: 'Due', field: 'total_amount', width: 110, hozAlign: 'right', formatter: cell => {
          const d = cell.getRow().getData();
          const due = billingAmountDue(d);
          return due > 0.005 ? `<span style="font-weight:600; color:${billingIsOverdue(d) ? 'var(--red)' : 'var(--text-main)'};">${due.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>` : '—';
        } },
      { title: 'Status', field: 'status', width: 170, formatter: cell => {
          const d = cell.getRow().getData();
          const m = BILLING_STATUSES[d.status] || { label: d.status, icon: '', badgeClass: '' };
          const overdueTag = billingIsOverdue(d) ? ' <span class="log-badge badge-error">⏰ Overdue</span>' : '';
          return `<span class="log-badge ${m.badgeClass}">${m.icon} ${escHtml(m.label)}</span>${overdueTag}`;
        } },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 260, formatter: cell => billingRowActions(cell.getRow().getData()),
        cellClick: (e, cell) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const row = cell.getRow().getData();
          const action = btn.dataset.action;
          if (action === 'edit') billingOpenCreate(row);
          else if (action === 'send') billingSendDraft(row);
          else if (action === 'delete') billingDeleteDraft(row);
          else if (action === 'download') billingDownloadInvoice(row);
          else if (action === 'email') billingEmailInvoice(row);
          else if (action === 'payment') billingOpenPayment(row);
          else if (action === 'void') billingVoidInvoice(row);
        } },
    ],
  });
}

function billingRowActions(row) {
  const btn = (action, label, title) => `<button class="btn btn-outline btn-sm" data-action="${action}" title="${title || label}">${label}</button>`;
  if (row.status === 'draft') return `<div class="client-actions">${btn('edit', 'Edit')}${btn('send', 'Send', 'Generate PDF & send/mark sent')}${btn('delete', 'Delete')}</div>`;
  if (row.status === 'void') return `<div class="client-actions">${btn('download', 'Download')}</div>`;
  const common = `${btn('download', 'PDF')}${btn('email', 'Email')}`;
  const paymentBtn = row.status !== 'paid' ? btn('payment', '💰 Payment', 'Record Payment') : '';
  return `<div class="client-actions">${common}${paymentBtn}${btn('void', 'Void')}</div>`;
}

function billingApplyFilters() {
  if (!billingTable) return;
  const test = (BILLING_FILTERS[billingActiveFilter] || BILLING_FILTERS.all).test;
  let rows = billingInvoices.filter(test);
  const q = (document.getElementById('billing-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['invoice_number', 'notes', 'clients.name']);
    rows = fuse.search(q).map(r => r.item);
  }
  billingTable.replaceData(rows);
}
function billingFilterTable() { billingApplyFilters(); }

// ── Amount Due by client (AR view) ──
function billingRenderAr(invoices) {
  const wrap = document.getElementById('billing-ar-wrap');
  if (billingArTable) { billingArTable.destroy(); billingArTable = null; }

  const byClient = new Map();
  invoices.filter(i => i.status !== 'void').forEach(inv => {
    const c = inv.clients || {};
    const key = inv.client_id;
    if (!byClient.has(key)) byClient.set(key, { client_id: key, client_name: c.name || '—', invoiced: 0, paid: 0, oldestOverdue: null });
    const agg = byClient.get(key);
    agg.invoiced += Number(inv.total_amount || 0);
    agg.paid += Number(inv.amount_paid || 0);
    if (billingIsOverdue(inv) && (!agg.oldestOverdue || inv.due_date < agg.oldestOverdue)) agg.oldestOverdue = inv.due_date;
  });
  const rows = [...byClient.values()].map(r => ({ ...r, due: r.invoiced - r.paid })).filter(r => r.due > 0.005);

  if (!rows.length) {
    wrap.innerHTML = '<div class="log-empty">No outstanding balances.</div>';
    return;
  }
  wrap.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  billingArTable = TableEngine.createTable(wrap, {
    data: rows,
    index: 'client_id',
    pagination: true,
    paginationSize: 10,
    initialSort: [{ column: 'due', dir: 'desc' }],
    columns: [
      { title: 'Client', field: 'client_name', minWidth: 160 },
      { title: 'Invoiced', field: 'invoiced', width: 110, hozAlign: 'right', formatter: c => Number(c.getValue()).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      { title: 'Paid', field: 'paid', width: 110, hozAlign: 'right', formatter: c => Number(c.getValue()).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      { title: 'Due', field: 'due', width: 110, hozAlign: 'right', formatter: c => `<strong>${Number(c.getValue()).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>` },
      { title: 'Overdue', field: 'oldestOverdue', width: 110, formatter: c => {
          const v = c.getValue();
          if (!v) return '—';
          const days = Math.floor((new Date(today) - new Date(v)) / 86400000);
          return `<span class="log-badge badge-error">${days}d</span>`;
        } },
    ],
  });
}

// ── Income chart ──
async function billingRenderIncomeChart() {
  const el = document.getElementById('billing-income-chart');
  if (!el || !window.Chart) return;
  const { data, error } = await window.sb.rpc('get_monthly_income', { p_months: 6 });
  if (billingIncomeChart) { billingIncomeChart.destroy(); billingIncomeChart = null; }
  const rows = error ? [] : (data || []);
  const labels = rows.map(r => new Date(r.month_start).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
  billingIncomeChart = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: { labels: labels.length ? labels : ['No data yet'], datasets: [{ label: 'Income', data: labels.length ? rows.map(r => Number(r.total)) : [0], backgroundColor: '#10b981' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { precision: 0 } } } },
  });
}

// ── Create / Edit Invoice drawer ──
function billingSelectClient(c) {
  billingSelectedClient = c;
  document.getElementById('billing-client-selected').textContent = `Selected: ${c.name}${c.email ? ' (' + c.email + ')' : ' — no email on file'}`;
  document.getElementById('billing-client-search').value = c.name;
}

function billingAddItemRow(item) {
  billingDraftItems.push(item || { description: '', quantity: 1, rate: 0 });
  billingRenderItemRows();
}
function billingRemoveItemRow(idx) {
  billingDraftItems.splice(idx, 1);
  billingRenderItemRows();
}
function billingRenderItemRows() {
  const wrap = document.getElementById('billing-items-wrap');
  wrap.innerHTML = `<div class="billing-item-row" style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">
      <div>Description</div><div>Qty</div><div>Rate</div><div>Amount</div><div></div>
    </div>` + billingDraftItems.map((it, i) => `
    <div class="billing-item-row">
      <input type="text" placeholder="e.g. VAT Return filing — Jestha 2083" value="${escHtml(it.description)}" oninput="billingDraftItems[${i}].description=this.value" />
      <input type="number" min="0" step="0.01" value="${it.quantity}" oninput="billingDraftItems[${i}].quantity=parseFloat(this.value)||0; billingRenderTotals();" />
      <input type="number" min="0" step="0.01" value="${it.rate}" oninput="billingDraftItems[${i}].rate=parseFloat(this.value)||0; billingRenderTotals();" />
      <div style="font-weight:600;">${(it.quantity * it.rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
      <button class="billing-item-remove" onclick="billingRemoveItemRow(${i})" title="Remove">×</button>
    </div>`).join('');
  billingRenderTotals();
}
function billingRenderTotals() {
  const subtotal = billingDraftItems.reduce((s, it) => s + (it.quantity || 0) * (it.rate || 0), 0);
  const applyVat = document.getElementById('billing-apply-vat').checked;
  const tax = applyVat ? subtotal * window.VAT_STANDARD_RATE : 0;
  document.getElementById('billing-total-subtotal').textContent = subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 });
  document.getElementById('billing-total-tax').textContent = tax.toLocaleString('en-US', { minimumFractionDigits: 2 });
  document.getElementById('billing-total-amount').textContent = (subtotal + tax).toLocaleString('en-US', { minimumFractionDigits: 2 });
  return { subtotal, tax, total: subtotal + tax };
}

async function billingOpenCreate(existingRow) {
  billingEditingInvoiceId = existingRow ? existingRow.id : null;
  billingSelectedClient = null;
  document.getElementById('billing-drawer-title').textContent = existingRow ? `Edit Invoice ${existingRow.invoice_number || ''}` : 'New Invoice';
  document.getElementById('billing-client-search').value = '';
  document.getElementById('billing-client-selected').textContent = '';
  document.getElementById('billing-drawer-status').innerHTML = '';
  document.getElementById('billing-notes').value = existingRow ? (existingRow.notes || '') : '';
  document.getElementById('billing-apply-vat').checked = existingRow ? Number(existingRow.tax_amount) > 0 : true;

  const today = new Date();
  const due = new Date(today.getTime() + 15 * 86400000);
  document.getElementById('billing-issue-date').value = existingRow ? existingRow.issue_date : today.toISOString().slice(0, 10);
  document.getElementById('billing-due-date').value = existingRow ? (existingRow.due_date || '') : due.toISOString().slice(0, 10);
  document.getElementById('billing-firm-key').value = existingRow ? existingRow.firm_key : 'shailesh';

  const bs = NepaliLocale.todayBs();
  const defaultFy = bs ? NepaliLocale.bsFiscal(bs).fy.replace('/', '-') : '';
  document.getElementById('billing-fiscal-year').value = existingRow ? (existingRow.fiscal_year || '') : defaultFy;

  if (existingRow) {
    const client = (window.clientsList || []).find(c => c.id === existingRow.client_id);
    if (client) billingSelectClient(client);
    const { data: items } = await window.sb.from('invoice_items').select('*').eq('invoice_id', existingRow.id).order('sort_order');
    billingDraftItems = (items || []).map(it => ({ description: it.description, quantity: Number(it.quantity), rate: Number(it.rate) }));
    if (!billingDraftItems.length) billingDraftItems = [{ description: '', quantity: 1, rate: 0 }];
  } else {
    billingDraftItems = [{ description: '', quantity: 1, rate: 0 }];
  }
  billingRenderItemRows();
  document.getElementById('billing-invoice-drawer').classList.add('open');
}

function billingCloseCreate() {
  document.getElementById('billing-invoice-drawer').classList.remove('open');
}

async function billingSaveInvoice(targetStatus) {
  if (!billingSelectedClient) { billingStatusMsg2('Please select a client.'); return; }
  const items = billingDraftItems.filter(it => it.description.trim() && (it.quantity * it.rate) > 0);
  if (!items.length) { billingStatusMsg2('Add at least one line item with a description and a positive amount.'); return; }

  const totals = billingRenderTotals();
  const payload = {
    client_id: billingSelectedClient.id,
    firm_key: document.getElementById('billing-firm-key').value,
    issue_date: document.getElementById('billing-issue-date').value || new Date().toISOString().slice(0, 10),
    due_date: document.getElementById('billing-due-date').value || null,
    fiscal_year: document.getElementById('billing-fiscal-year').value.trim() || null,
    subtotal: totals.subtotal,
    tax_rate: window.VAT_STANDARD_RATE,
    tax_amount: totals.tax,
    total_amount: totals.total,
    notes: document.getElementById('billing-notes').value.trim() || null,
    updated_by: (window.currentUser && window.currentUser.email) || null,
  };

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'billing-drawer-status');
  try {
    let invoiceRow;
    if (billingEditingInvoiceId) {
      const { data, error } = await window.sb.from('invoices').update(payload).eq('id', billingEditingInvoiceId).select('*, clients(name, email, pan, address)').single();
      if (error) throw error;
      invoiceRow = data;
      await window.sb.from('invoice_items').delete().eq('invoice_id', invoiceRow.id);
    } else {
      payload.created_by = payload.updated_by;
      const { data, error } = await window.sb.from('invoices').insert(payload).select('*, clients(name, email, pan, address)').single();
      if (error) throw error;
      invoiceRow = data;
      AuditLog.record('invoice_created', { module: 'billing', clientName: invoiceRow.clients.name, recordRef: invoiceRow.id });
    }

    const itemRows = items.map((it, i) => ({ invoice_id: invoiceRow.id, description: it.description.trim(), quantity: it.quantity, rate: it.rate, amount: it.quantity * it.rate, sort_order: i }));
    const { error: itemsErr } = await window.sb.from('invoice_items').insert(itemRows);
    if (itemsErr) throw itemsErr;

    if (targetStatus === 'sent' && invoiceRow.status !== 'sent') {
      await billingFlow.transition(invoiceRow, 'sent');
    }

    billingCloseCreate();
    await billingRefresh();

    if (targetStatus === 'sent') {
      const fresh = billingInvoices.find(i => i.id === invoiceRow.id) || invoiceRow;
      await billingDownloadInvoice(fresh);
      if (billingSelectedClient.email) await billingEmailInvoice(fresh);
      billingStatusMsg(`✅ Invoice ${escHtml(fresh.invoice_number || '')} sent.${billingSelectedClient.email ? '' : ' (No email on file — PDF downloaded for you to send manually.)'}`, 'success');
    } else {
      billingStatusMsg('✅ Draft saved.', 'success');
    }
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'billing-drawer-status');
  }
}
function billingStatusMsg2(msg) {
  showStatus(escHtml(msg), 'info', 'billing-drawer-status');
}

async function billingSendDraft(row) {
  await billingOpenCreate(row);
  await billingSaveInvoice('sent');
}

async function billingDeleteDraft(row) {
  if (row.status !== 'draft') return;
  if (!confirm(`Delete draft invoice ${row.invoice_number || ''}? This cannot be undone.`)) return;
  const { error } = await window.sb.from('invoices').delete().eq('id', row.id);
  if (error) { billingStatusMsg('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('invoice_deleted', { module: 'billing', clientName: row.clients && row.clients.name, recordRef: row.id });
  await billingRefresh();
}

async function billingVoidInvoice(row) {
  if (!confirm(`Void invoice ${row.invoice_number}? It will stay on record but stop counting toward amounts due.`)) return;
  try {
    await billingFlow.transition(row, 'void');
    await billingRefresh();
  } catch (e) {
    billingStatusMsg('❌ ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── PDF generation ──
async function billingFetchItems(invoiceId) {
  const { data } = await window.sb.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('sort_order');
  return data || [];
}

function billingWrapText(font, size, text, maxWidth) {
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

async function billingEmbedQr(pdfDoc, dataUrl) {
  if (!dataUrl) return null;
  try {
    const isJpg = /^data:image\/jpe?g/i.test(dataUrl);
    const bytes = await (await fetch(dataUrl)).arrayBuffer();
    return isJpg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
  } catch (e) {
    console.error('billing: failed to embed QR image', e);
    return null;
  }
}

async function billingBuildInvoicePdf(invoice, items, client, firm, bank) {
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

  draw(firm.name, marginL, 16, bold, navy); y -= 15;
  draw(firm.title, marginL, 9.5, font, muted); y -= 12;
  draw(firm.address, marginL, 9, font, muted); y -= 12;
  draw(`Phone: ${firm.phone}  ·  Email: ${firm.email}`, marginL, 9, font, muted); y -= 12;
  draw(`PAN: ${firm.pan}`, marginL, 9, font, muted);

  y = 792;
  drawRight('INVOICE', marginR, 20, bold, navy); y -= 20;
  drawRight(invoice.invoice_number || '(pending)', marginR, 11, bold); y -= 14;
  drawRight(`Issue Date: ${invoice.issue_date || '—'}`, marginR, 9.5, font, muted); y -= 12;
  drawRight(`Due Date: ${invoice.due_date || '—'}`, marginR, 9.5, font, muted); y -= 12;
  if (invoice.fiscal_year) { drawRight(`F.Y. ${invoice.fiscal_year}`, marginR, 9.5, font, muted); }

  y = 700;
  draw('Bill To:', marginL, 10, bold, navy); y -= 14;
  draw(client.name || '—', marginL, 11, bold); y -= 13;
  if (client.address) { draw(client.address, marginL, 9.5, font, muted); y -= 12; }
  if (client.pan) { draw(`PAN: ${client.pan}`, marginL, 9.5, font, muted); y -= 12; }

  y -= 14;
  const colDesc = marginL, colQty = 360, colRate = 420, colAmt = 545;
  draw('Description', colDesc, 9.5, bold, muted);
  page.drawText('Qty', { x: colQty, y, size: 9.5, font: bold, color: muted });
  page.drawText('Rate', { x: colRate, y, size: 9.5, font: bold, color: muted });
  drawRight('Amount', colAmt, 9.5, bold, muted);
  y -= 6;
  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line });
  y -= 14;

  const fmt = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  items.forEach(it => {
    const descLines = billingWrapText(font, 9.5, it.description, colQty - colDesc - 10);
    descLines.forEach((ln, i) => { page.drawText(ln, { x: colDesc, y: y - i * 11, size: 9.5, font, color: black }); });
    page.drawText(String(it.quantity), { x: colQty, y, size: 9.5, font, color: black });
    page.drawText(fmt(it.rate), { x: colRate, y, size: 9.5, font, color: black });
    drawRight(fmt(it.amount), colAmt, 9.5, font, black);
    y -= Math.max(descLines.length, 1) * 11 + 6;
    if (y < 260) { page = doc.addPage([595, 842]); y = 792; } // long invoices spill to a new page before the payment block
  });

  page.drawLine({ start: { x: marginL, y }, end: { x: marginR, y }, thickness: 1, color: line });
  y -= 16;
  draw('Subtotal', 420, 9.5, font, muted); drawRight(fmt(invoice.subtotal), colAmt, 9.5, font, muted); y -= 13;
  if (Number(invoice.tax_amount) > 0) { draw(`VAT (${(invoice.tax_rate * 100).toFixed(0)}%)`, 420, 9.5, font, muted); drawRight(fmt(invoice.tax_amount), colAmt, 9.5, font, muted); y -= 13; }
  draw('Total', 420, 11, bold, navy); drawRight(fmt(invoice.total_amount), colAmt, 11, bold, navy);

  if (y < 220) { page = doc.addPage([595, 842]); y = 792; }
  y -= 34;
  draw('Payment Details', marginL, 10, bold, navy); y -= 15;
  draw(`Bank: ${bank.bank_name || '—'}`, marginL, 9.5, font, black); y -= 13;
  draw(`Account Name: ${bank.account_name || '—'}`, marginL, 9.5, font, black); y -= 13;
  draw(`Account Number: ${bank.account_number || '—'}`, marginL, 9.5, font, black); y -= 13;
  draw(`Branch: ${bank.branch || '—'}`, marginL, 9.5, font, black);

  const qrImg = await billingEmbedQr(doc, bank.qr_image);
  const qrX = marginR - 100, qrTop = y + 60;
  if (qrImg) {
    page.drawImage(qrImg, { x: qrX, y: qrTop - 100, width: 100, height: 100 });
  } else {
    page.drawRectangle({ x: qrX, y: qrTop - 100, width: 100, height: 100, borderColor: line, borderWidth: 1.5, borderDashArray: [4, 3] });
    page.drawText('Scan to Pay', { x: qrX + 20, y: qrTop - 45, size: 9, font, color: muted });
    page.drawText('(QR pending upload)', { x: qrX + 8, y: qrTop - 58, size: 7.5, font, color: muted });
  }

  if (invoice.notes) {
    y -= 40;
    draw('Notes', marginL, 9.5, bold, muted); y -= 12;
    billingWrapText(font, 9, invoice.notes, marginR - marginL).forEach(ln => { draw(ln, marginL, 9, font, black); y -= 11; });
  }

  page.drawText('Thank you for your business.', { x: marginL, y: 60, size: 9, font, color: muted });
  page.drawText(firm.signatoryName, { x: marginR - font.widthOfTextAtSize(firm.signatoryName, 9.5), y: 74, size: 9.5, font: bold, color: black });
  page.drawText(firm.signatoryTitle, { x: marginR - font.widthOfTextAtSize(firm.signatoryTitle, 8.5), y: 62, size: 8.5, font, color: muted });

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function billingInvoiceBlob(row) {
  const items = await billingFetchItems(row.id);
  const firm = window.REP_FIRMS[row.firm_key] || window.REP_FIRMS.shailesh;
  const bank = (billingFirmDetails && billingFirmDetails[row.firm_key]) || {};
  return billingBuildInvoicePdf(row, items, row.clients || {}, firm, bank);
}

async function billingDownloadInvoice(row) {
  try {
    const blob = await billingInvoiceBlob(row);
    const fname = `Invoice ${row.invoice_number || row.id} - ${(row.clients && row.clients.name) || 'Client'}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'billing', clientName: row.clients && row.clients.name });
    if (row.pdf_filename !== fname) {
      await window.sb.from('invoices').update({ pdf_filename: fname }).eq('id', row.id);
      row.pdf_filename = fname;
    }
  } catch (e) {
    billingStatusMsg('❌ Failed to generate PDF: ' + escHtml(e.message || String(e)), 'error');
  }
}

async function billingEmailInvoice(row) {
  const client = row.clients || {};
  if (!client.email) {
    billingStatusMsg(`⚠️ ${escHtml(client.name || 'This client')} has no email on file — add one in the Clients tab, or download and send the PDF manually.`, 'error');
    return;
  }
  try {
    billingStatusMsg('<span class="spinner spinner-navy"></span> Sending…', 'searching');
    const blob = await billingInvoiceBlob(row);
    const fname = `Invoice ${row.invoice_number || row.id}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    const bodyText = `Dear ${client.name},\n\nPlease find attached invoice ${row.invoice_number || ''} for Rs. ${Number(row.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}${row.due_date ? ', due by ' + row.due_date : ''}.\n\nIf you have any questions, please do not hesitate to contact us.\n\nBest regards,\n${(window.REP_FIRMS[row.firm_key] || {}).name || 'Audit Team'}`;
    await Integrations.sendEmailWithBlobAttachment({ blob, filename: fname, mimeType: 'application/pdf', toEmail: client.email, subject: `Invoice ${row.invoice_number || ''} — ${client.name}`, bodyText });
    AuditLog.record('invoice_emailed', { module: 'billing', clientName: client.name, recordRef: row.id, toEmail: client.email });
    billingStatusMsg(`✅ Invoice emailed to ${escHtml(client.email)}.`, 'success');
  } catch (e) {
    billingStatusMsg('❌ Failed to send email: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Record Payment ──
function billingOpenPayment(row) {
  billingPaymentRow = row;
  const due = Number(row.total_amount) - Number(row.amount_paid);
  document.getElementById('billing-payment-invoice-summary').textContent =
    `${row.invoice_number || ''} — ${(row.clients && row.clients.name) || ''} — Due: Rs. ${due.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('billing-payment-amount').value = due > 0 ? due.toFixed(2) : '';
  document.getElementById('billing-payment-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('billing-payment-method').value = 'bank_transfer';
  document.getElementById('billing-payment-note').value = '';
  document.getElementById('billing-payment-status').innerHTML = '';
  document.getElementById('billing-payment-modal').classList.add('open');
}
function billingClosePayment() {
  document.getElementById('billing-payment-modal').classList.remove('open');
  billingPaymentRow = null;
}
async function billingSavePayment() {
  const row = billingPaymentRow;
  if (!row) return;
  const amount = parseFloat(document.getElementById('billing-payment-amount').value);
  if (!(amount > 0)) { showStatus('Enter an amount greater than 0.', 'info', 'billing-payment-status'); return; }

  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', 'billing-payment-status');
  try {
    const { error } = await window.sb.from('invoice_payments').insert({
      invoice_id: row.id, client_id: row.client_id, amount,
      paid_date: document.getElementById('billing-payment-date').value || new Date().toISOString().slice(0, 10),
      method: document.getElementById('billing-payment-method').value,
      note: document.getElementById('billing-payment-note').value.trim() || null,
      recorded_by: (window.currentUser && window.currentUser.email) || null,
    });
    if (error) throw error;
    AuditLog.record('invoice_payment_recorded', { module: 'billing', clientName: row.clients && row.clients.name, recordRef: row.id, amount });
    billingClosePayment();
    await billingRefresh();
    billingStatusMsg('✅ Payment recorded.', 'success');
  } catch (e) {
    showStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error', 'billing-payment-status');
  }
}

// ── Bank Details / Settings ──
let billingSettingsPendingQr = {}; // firmKey -> data URL staged before Save

function billingOpenSettings() {
  billingSettingsPendingQr = {};
  billingRenderSettingsBody();
  document.getElementById('billing-settings-modal').classList.add('open');
}
function billingCloseSettings() {
  document.getElementById('billing-settings-modal').classList.remove('open');
}
function billingRenderSettingsBody() {
  const body = document.getElementById('billing-settings-body');
  const firms = Object.keys(window.REP_FIRMS);
  // Bank details + payment QR are the payment-fraud target, so writes are
  // admin-only (enforced by RLS in the DB — this read-only rendering for
  // staff just keeps the UI honest about it).
  const isAdmin = window.currentUser && window.currentUser.role === 'admin';
  body.innerHTML = firms.map(key => {
    const firm = window.REP_FIRMS[key];
    const bank = (billingFirmDetails && billingFirmDetails[key]) || {};
    const qrSrc = billingSettingsPendingQr[key] || bank.qr_image;
    return `
    <div class="card" style="margin-bottom:16px; padding:16px;">
      <h4 style="margin:0 0 12px; color:var(--brand-navy);">${escHtml(firm.name)}</h4>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <div class="form-group"><label>Bank Name</label><input type="text" id="billing-bank-name-${key}" value="${escHtml(bank.bank_name || '')}" ${isAdmin ? '' : 'disabled'} /></div>
        <div class="form-group"><label>Account Name</label><input type="text" id="billing-bank-acname-${key}" value="${escHtml(bank.account_name || '')}" ${isAdmin ? '' : 'disabled'} /></div>
        <div class="form-group"><label>Account Number</label><input type="text" id="billing-bank-acno-${key}" value="${escHtml(bank.account_number || '')}" ${isAdmin ? '' : 'disabled'} /></div>
        <div class="form-group"><label>Branch</label><input type="text" id="billing-bank-branch-${key}" value="${escHtml(bank.branch || '')}" ${isAdmin ? '' : 'disabled'} /></div>
      </div>
      <div class="form-group">
        <label>Payment QR Image</label>
        ${isAdmin ? `<input type="file" accept="image/png,image/jpeg" onchange="billingHandleQrUpload('${key}', this)" />` : ''}
        ${qrSrc ? `<img class="billing-qr-preview" src="${qrSrc}" />` : `<div class="billing-qr-placeholder">No QR uploaded yet — an example placeholder box will print on invoices until one is added here.</div>`}
      </div>
      ${isAdmin ? `
      <div class="action-row">
        <button class="btn btn-primary btn-sm" onclick="billingSaveFirmDetails('${key}')">Save</button>
      </div>` : `
      <p style="font-size:12.5px; color:var(--text-muted); margin:8px 0 0;">Only admins can change bank details or the payment QR.</p>`}
      <div id="billing-settings-status-${key}"></div>
    </div>`;
  }).join('');
}
function billingHandleQrUpload(firmKey, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    billingSettingsPendingQr[firmKey] = e.target.result;
    billingRenderSettingsBody();
  };
  reader.readAsDataURL(file);
}
async function billingSaveFirmDetails(firmKey) {
  const statusId = `billing-settings-status-${firmKey}`;
  showStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching', statusId);
  const payload = {
    firm_key: firmKey,
    // Postgres validates NOT NULL on the upsert's candidate row before it even
    // resolves the conflict, so invoice_prefix (no default, set once when the
    // row was seeded) must be re-sent on every save or the upsert 400s.
    invoice_prefix: ((billingFirmDetails && billingFirmDetails[firmKey]) || {}).invoice_prefix,
    bank_name: document.getElementById(`billing-bank-name-${firmKey}`).value.trim() || null,
    account_name: document.getElementById(`billing-bank-acname-${firmKey}`).value.trim() || null,
    account_number: document.getElementById(`billing-bank-acno-${firmKey}`).value.trim() || null,
    branch: document.getElementById(`billing-bank-branch-${firmKey}`).value.trim() || null,
    updated_by: (window.currentUser && window.currentUser.email) || null,
  };
  if (billingSettingsPendingQr[firmKey]) payload.qr_image = billingSettingsPendingQr[firmKey];

  const { data, error } = await window.sb.from('firm_bank_details').upsert(payload, { onConflict: 'firm_key' }).select().single();
  if (error) { showStatus('❌ ' + escHtml(error.message), 'error', statusId); return; }
  billingFirmDetails[firmKey] = data;
  delete billingSettingsPendingQr[firmKey];
  AuditLog.record('firm_bank_details_updated', { module: 'billing', firmKey });
  showStatus('✅ Saved.', 'success', statusId);
}
