// ════════════════════════════════════════════
//  BANK BOOK
//  Receipts & payments ledger for the firm's OWN bank accounts — internal
//  bookkeeping (the firm's cash/bank position), NOT a client document. Three
//  sub-sections in one panel: Accounts (CRUD master), Transactions (record
//  receipts & payments), and Reports (per-account Receipt / Payment registers
//  and a running Statement/passbook).
//
//  An inter-bank transfer between two of the firm's own accounts is entered
//  ONCE (From → To) and stored as TWO paired rows sharing a transfer_group_id:
//  a `payment` leg on the source account and a `receipt` leg on the destination.
//  Editing or deleting either leg always acts on BOTH (bbTransferSiblings), so
//  the two can never disagree — this is the module's key integrity rule.
//
//  Running balances are derived here at read time (opening_balance + ordered
//  receipts − payments), never stored — the same derive-don't-store discipline
//  the removed Billing module used for its overdue figures.
//  Modeled on serviceMemo.js (TableEngine list, client autocomplete, AuditLog).
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'bankBook', group: 'main', buttonId: null, panelId: 'tab-bankBook-panel' });

let bbAccounts = [];
let bbTxns = [];
let bbAccountsTable = null;
let bbTxnTable = null;
let bbSection = 'accounts';
let bbEditingAccountId = null;
let bbTxnMode = null;          // 'receipt' | 'payment' while the txn drawer is open
let bbEditingTxn = null;       // the transaction row being edited, or null
let bbSelectedClient = null;   // client picked for a Fee Receipt
let bbLastReport = null;       // last generated report, for PDF/Excel export
let bbInitDone = false;
let bbFilters = { account: '', type: '', particular: '', fy: '', from: '', to: '' };

// ── Small helpers ──
function bbUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function bbAmt(n) { return fmtAmount(n); }
function bbStatus(html, type) { showStatus(html, type, 'bb-status-area'); }
function bbAccountById(id) { return bbAccounts.find(a => a.id === id) || null; }
function bbAccountLabel(acc) { return acc ? `${acc.account_name} — ${acc.bank_name}` : '—'; }
function bbAccountLabelById(id) { return bbAccountLabel(bbAccountById(id)); }
function bbFirmName(key) { const f = window.SERVICE_MEMO_FIRMS[key]; return f ? f.name : (key || '—'); }
// Does this particular's counterparty come from the client directory?
function bbIsClientParticular(p) { return window.BANK_CLIENT_PARTICULARS.includes(p); }

// All particular types (both registers), for label lookups regardless of type.
function bbParticularLabel(key) {
  const all = [...(window.BANK_RECEIPT_TYPES || []), ...(window.BANK_PAYMENT_TYPES || [])];
  const f = all.find(t => t.key === key);
  return f ? f.label : (key || '—');
}
// The "Name of Client/Person/Bank" cell for a transaction.
function bbTxnCounterparty(t) {
  if (t.particular === 'inter_bank_transfer') return bbAccountLabelById(t.counterparty_account_id);
  return t.counterparty_name || '—';
}

// B.S. date-string handling now lives in NepaliLocale (Party Ledger and Final
// Account need the same four); these stay as local aliases so the call sites
// below read the same as they always did.
const bbDateOrd = NepaliLocale.bsDateOrd;
const bbValidBsDate = NepaliLocale.isValidBsDate;
const bbFyFromDate = NepaliLocale.bsFyDash;
const bbTodayBsStr = NepaliLocale.todayBsStr;

// The two legs of a transfer share transfer_group_id; loaded from bbTxns.
function bbTransferSiblings(groupId) {
  return bbTxns.filter(t => t.transfer_group_id && t.transfer_group_id === groupId);
}

// Current balance of an account across ALL its transactions (both legs of any
// transfer are ordinary receipt/payment rows on their respective accounts).
function bbAccountBalance(accountId) {
  const acc = bbAccountById(accountId);
  let bal = acc ? Number(acc.opening_balance || 0) : 0;
  bbTxns.forEach(t => {
    if (t.account_id !== accountId) return;
    bal += (t.txn_type === 'receipt' ? 1 : -1) * Number(t.amount || 0);
  });
  return bal;
}

// ── Entry point (called by openModule) ──
function bbInit() {
  if (!bbInitDone) {
    SearchEngine.attachAutocomplete(
      document.getElementById('bb-txn-client-search'),
      document.getElementById('bb-txn-client-autocomplete'),
      {
        getList: () => window.clientsList,
        keys: ['name', 'pan'],
        renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
        onSelect: bbSelectClient,
      }
    );
    bbInitDone = true;
  }
  bbRefresh();
}

// Every write path calls bbReload(), never bbRefresh() directly. It drops
// Party Ledger's keys as well as its own: those modules read the same rows, and
// a saved transaction that showed up only in Bank Entry would be worse than no
// cache at all. bbRefresh() itself must NEVER invalidate — opening the tab
// would then defeat the very cache it is meant to be using.
async function bbReload() {
  DataCache.invalidate(
    window.LEDGER_KEYS.accountsBb, window.LEDGER_KEYS.txns,
    window.LEDGER_KEYS.accountsPl,
  );
  await bbRefresh();
}

async function bbRefresh() {
  bbStatus('<span class="spinner spinner-navy"></span> Loading bank book…', 'searching');
  try {
    [bbAccounts, bbTxns] = await Promise.all([
      DataCache.get(window.LEDGER_KEYS.accountsBb, () => sbFetchAll(() => window.sb.from('bank_accounts').select('*').order('sort_order').order('account_name'))),
      DataCache.get(window.LEDGER_KEYS.txns,       () => sbFetchAll(() => window.sb.from('bank_transactions').select('*').order('txn_date').order('id'))),
    ]);
    bbPopulateAccountSelects();
    bbPopulateExpenseNames();
    bbRenderAccounts();
    bbRenderTxns();
    document.getElementById('bb-status-area').innerHTML = '';
  } catch (e) {
    bbStatus('❌ Failed to load bank book: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Section toggle ──
function bbShowSection(name) {
  bbSection = name;
  ['accounts', 'txns', 'reports'].forEach(s => {
    const sec = document.getElementById('bb-section-' + s);
    if (sec) sec.style.display = s === name ? '' : 'none';
    const btn = document.getElementById('bb-tab-' + s);
    if (btn) btn.classList.toggle('active', s === name);
  });
}

// ── Account selects (txn drawer, report, filters) ──
function bbPopulateAccountSelects() {
  const active = bbAccounts.filter(a => a.is_active);
  const opts = list => list.map(a => `<option value="${a.id}">${escHtml(bbAccountLabel(a))}</option>`).join('');
  const fill = (id, placeholder, list) => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') + opts(list || active);
    if (prev && el.querySelector(`option[value="${prev}"]`)) el.value = prev;
  };
  fill('bb-txn-account', 'Select account…', active);
  fill('bb-txn-counter-account', 'Select account…', active);
  fill('bb-report-account', null, active);
  fill('bb-filter-account', 'All accounts', bbAccounts);

  // Firm selects (account drawer + accounts filter) come from config, not data.
  const firmOpts = Object.values(window.SERVICE_MEMO_FIRMS)
    .map(f => `<option value="${escHtml(f.key)}">${escHtml(f.name)}</option>`).join('');
  const drawerFirm = document.getElementById('bb-account-firm');
  if (drawerFirm) drawerFirm.innerHTML = '<option value="">Select firm…</option>' + firmOpts;
  const filterFirm = document.getElementById('bb-filter-account-firm');
  if (filterFirm) {
    const prev = filterFirm.value;
    filterFirm.innerHTML = '<option value="">All firms</option>' + firmOpts;
    filterFirm.value = prev;
  }
}

// Expense names already used, for the entry drawer's datalist. Free text is
// still allowed — this just stops the Expenses Ledger fragmenting because the
// same expense was typed three slightly different ways.
function bbPopulateExpenseNames() {
  const dl = document.getElementById('bb-expense-names');
  if (!dl) return;
  const names = [...new Set(bbTxns
    .filter(t => t.particular === 'expenses' && t.counterparty_name)
    .map(t => t.counterparty_name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

// ════════════════════════════════════════════
//  SECTION 1 — ACCOUNTS
// ════════════════════════════════════════════
function bbRenderAccounts() {
  const wrap = document.getElementById('bb-accounts-table-wrap');
  if (!wrap) return;
  if (bbAccountsTable) { bbAccountsTable.destroy(); bbAccountsTable = null; }
  const firmFilter = (document.getElementById('bb-filter-account-firm') || {}).value || '';
  const rows = bbAccounts
    .filter(a => !firmFilter || a.firm_key === firmFilter)
    .map(a => ({ ...a, _balance: bbAccountBalance(a.id) }));
  if (!rows.length) {
    wrap.innerHTML = bbAccounts.length
      ? '<div class="log-empty">No accounts for this firm.</div>'
      : '<div class="log-empty">No bank accounts yet. Click <strong>Add Account</strong> to create one.</div>';
    return;
  }
  wrap.innerHTML = '';
  bbAccountsTable = TableEngine.createTable(wrap, {
    data: rows,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    columns: [
      { title: 'Firm', field: 'firm_key', width: 170, formatter: c => escHtml(c.getValue() ? bbFirmName(c.getValue()) : '—') },
      { title: 'Account Name', field: 'account_name', minWidth: 190, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Bank', field: 'bank_name', minWidth: 150, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'A/C No.', field: 'account_number', width: 140, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Opening Balance', field: 'opening_balance', width: 150, hozAlign: 'right', formatter: c => bbAmt(c.getValue()) },
      { title: 'Current Balance', field: '_balance', width: 150, hozAlign: 'right', formatter: c => {
          const v = c.getValue();
          return `<span style="font-weight:600; color:${v < -0.005 ? 'var(--red)' : 'var(--text)'};">${bbAmt(v)}</span>`;
        } },
      { title: 'Status', field: 'is_active', width: 90, formatter: c => c.getValue()
          ? '<span class="log-badge badge-sent">Active</span>'
          : '<span class="log-badge badge-neutral">Inactive</span>' },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 150, formatter: () => {
          const btn = (a, l) => `<button class="btn btn-outline btn-sm" data-action="${a}">${l}</button>`;
          return `<div class="client-actions">${btn('edit', 'Edit')}${btn('delete', 'Delete')}</div>`;
        },
        cellClick: (e, cell) => {
          const b = e.target.closest('[data-action]'); if (!b) return;
          const row = cell.getRow().getData();
          if (b.dataset.action === 'edit') bbOpenAccount(row);
          else if (b.dataset.action === 'delete') bbDeleteAccount(row);
        } },
    ],
  });
}

function bbOpenAccount(existing) {
  bbEditingAccountId = existing ? existing.id : null;
  document.getElementById('bb-account-drawer-title').textContent = existing ? 'Edit Account' : 'Add Account';
  document.getElementById('bb-account-delete-btn').style.display = existing ? '' : 'none';
  document.getElementById('bb-account-firm').value = existing ? (existing.firm_key || '') : '';
  document.getElementById('bb-account-name').value = existing ? (existing.account_name || '') : '';
  document.getElementById('bb-account-bank').value = existing ? (existing.bank_name || '') : '';
  document.getElementById('bb-account-number').value = existing ? (existing.account_number || '') : '';
  document.getElementById('bb-account-opening').value = existing ? (existing.opening_balance ?? '') : '';
  document.getElementById('bb-account-opening-date').value = existing ? (existing.opening_date || '') : bbTodayBsStr();
  document.getElementById('bb-account-active').checked = existing ? !!existing.is_active : true;
  document.getElementById('bb-account-drawer-status').innerHTML = '';
  document.getElementById('bb-account-drawer').classList.add('open');
}
function bbCloseAccount() { document.getElementById('bb-account-drawer').classList.remove('open'); }

async function bbSaveAccount(btn) {
  const name = document.getElementById('bb-account-name').value.trim();
  const bank = document.getElementById('bb-account-bank').value.trim();
  const errEl = 'bb-account-drawer-status';
  const firmKey = document.getElementById('bb-account-firm').value;
  // Required: Final Account's per-firm Bank Balance can't place an unassigned
  // account, so it would silently vanish from the Balance Sheet.
  if (!firmKey) { showStatus('Select the firm this account belongs to.', 'info', errEl); return; }
  if (!name) { showStatus('Enter the account name (holder).', 'info', errEl); return; }
  if (!bank) { showStatus('Enter the bank name.', 'info', errEl); return; }
  const openDate = document.getElementById('bb-account-opening-date').value.trim();
  if (openDate && !bbValidBsDate(openDate)) { showStatus('Opening date must be a valid B.S. date (YYYY.MM.DD).', 'info', errEl); return; }

  const payload = {
    firm_key: firmKey,
    account_name: name,
    bank_name: bank,
    account_number: document.getElementById('bb-account-number').value.trim() || null,
    opening_balance: parseFloat(document.getElementById('bb-account-opening').value) || 0,
    opening_date: openDate || null,
    is_active: document.getElementById('bb-account-active').checked,
    updated_by: bbUserEmail(),
  };

  // Save contract (Stage 3): busy button, drawer closes at write-complete,
  // reload in the background — see smSaveMemo.
  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      if (bbEditingAccountId) {
        const { error } = await window.sb.from('bank_accounts').update(payload).eq('id', bbEditingAccountId);
        if (error) throw error;
        AuditLog.record('bank_account_updated', { module: 'bankBook', clientName: name, recordRef: bbEditingAccountId });
      } else {
        payload.created_by = payload.updated_by;
        payload.sort_order = bbAccounts.length;
        const { data, error } = await window.sb.from('bank_accounts').insert(payload).select('id').single();
        if (error) throw error;
        AuditLog.record('bank_account_created', { module: 'bankBook', clientName: name, recordRef: data.id });
      }
      bbCloseAccount();
      showToast(`✅ Account <strong>${escHtml(name)}</strong> saved.`, 'success');
      bbReload().catch(e => showToast('❌ Saved, but the list failed to refresh: ' + escHtml(e.message || String(e)), 'error'));
    } catch (e) {
      showStatus('❌ Could not save the account: ' + escHtml(e.message || 'unknown error'), 'error', errEl);
    }
  });
}

async function bbDeleteAccount(row) {
  // Preserve history: an account with transactions can't be hard-deleted (the
  // FK is ON DELETE RESTRICT anyway). Offer soft-deactivation instead.
  const count = bbTxns.filter(t => t.account_id === row.id).length;
  if (count > 0) {
    if (confirm(`"${bbAccountLabel(row)}" has ${count} transaction(s), so it can't be deleted (that would break history).\n\nDeactivate it instead? It stays in reports but is hidden from new-entry dropdowns.`)) {
      const { error } = await window.sb.from('bank_accounts').update({ is_active: false, updated_by: bbUserEmail() }).eq('id', row.id);
      if (error) { bbStatus('❌ ' + escHtml(error.message), 'error'); return; }
      AuditLog.record('bank_account_deactivated', { module: 'bankBook', clientName: row.account_name, recordRef: row.id });
      bbCloseAccount();
      await bbReload();
      bbStatus('✅ Account deactivated.', 'success');
    }
    return;
  }
  if (!confirm(`Delete account "${bbAccountLabel(row)}"? This cannot be undone.`)) return;
  const { error } = await window.sb.from('bank_accounts').delete().eq('id', row.id);
  if (error) { bbStatus('❌ ' + escHtml(error.message), 'error'); return; }
  AuditLog.record('bank_account_deleted', { module: 'bankBook', clientName: row.account_name, recordRef: row.id });
  bbCloseAccount();
  await bbReload();
  bbStatus('✅ Account deleted.', 'success');
}

// ════════════════════════════════════════════
//  SECTION 2 — TRANSACTIONS
// ════════════════════════════════════════════
function bbRenderTxns() {
  const wrap = document.getElementById('bb-txn-table-wrap');
  if (!wrap) return;
  if (bbTxnTable) { bbTxnTable.destroy(); bbTxnTable = null; }
  if (!bbTxns.length) {
    wrap.innerHTML = '<div class="log-empty">No transactions yet. Use <strong>New Receipt</strong> or <strong>New Payment</strong> to record one.</div>';
    return;
  }
  wrap.innerHTML = '';
  bbTxnTable = TableEngine.createTable(wrap, {
    data: bbTxns,
    index: 'id',
    pagination: true,
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100],
    initialSort: [{ column: 'txn_date', dir: 'desc' }],
    columns: [
      { title: 'Date', field: 'txn_date', width: 110, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Account', field: 'account_id', minWidth: 170, formatter: c => escHtml(bbAccountLabelById(c.getValue())) },
      { title: 'Type', field: 'txn_type', width: 100, formatter: c => c.getValue() === 'receipt'
          ? '<span class="log-badge badge-sent">Receipt</span>'
          : '<span class="log-badge badge-error">Payment</span>' },
      { title: 'Particular', field: 'particular', width: 140, formatter: c => escHtml(bbParticularLabel(c.getValue())) },
      { title: 'Amount', field: 'amount', width: 120, hozAlign: 'right', formatter: c => bbAmt(c.getValue()) },
      { title: 'Name of Client/Person/Bank', field: 'counterparty_name', minWidth: 180, formatter: c => escHtml(bbTxnCounterparty(c.getRow().getData())) },
      { title: 'Description', field: 'description', minWidth: 160, formatter: c => escHtml(c.getValue() || '—') },
      { title: 'Actions', field: 'id', headerSort: false, minWidth: 150, formatter: () => {
          const btn = (a, l) => `<button class="btn btn-outline btn-sm" data-action="${a}">${l}</button>`;
          return `<div class="client-actions">${btn('edit', 'Edit')}${btn('delete', 'Delete')}</div>`;
        },
        cellClick: (e, cell) => {
          const b = e.target.closest('[data-action]'); if (!b) return;
          const row = cell.getRow().getData();
          if (b.dataset.action === 'edit') bbOpenTxn(row.txn_type, row);
          else if (b.dataset.action === 'delete') bbDeleteTxn(row);
        } },
    ],
  });
  bbApplyTxnFilters();
}

// Filters
function bbReadTxnFilters() {
  bbFilters = {
    account: document.getElementById('bb-filter-account').value,
    type: document.getElementById('bb-filter-type').value,
    particular: document.getElementById('bb-filter-particular').value,
    fy: document.getElementById('bb-filter-fy').value.trim(),
    from: document.getElementById('bb-filter-from').value.trim(),
    to: document.getElementById('bb-filter-to').value.trim(),
  };
}
function bbApplyTxnFilters() {
  if (!bbTxnTable) return;
  const fromOrd = bbFilters.from ? bbDateOrd(bbFilters.from) : null;
  const toOrd = bbFilters.to ? bbDateOrd(bbFilters.to) : null;
  let rows = bbTxns.filter(t => {
    if (bbFilters.account && String(t.account_id) !== bbFilters.account) return false;
    if (bbFilters.type && t.txn_type !== bbFilters.type) return false;
    if (bbFilters.particular && t.particular !== bbFilters.particular) return false;
    if (bbFilters.fy && (t.fiscal_year || '') !== bbFilters.fy) return false;
    const ord = bbDateOrd(t.txn_date);
    if (fromOrd != null && ord != null && ord < fromOrd) return false;
    if (toOrd != null && ord != null && ord > toOrd) return false;
    return true;
  });
  const q = (document.getElementById('bb-txn-search').value || '').trim();
  if (q) {
    const enriched = rows.map(t => ({ ...t, _acc: bbAccountLabelById(t.account_id), _party: bbTxnCounterparty(t) }));
    const fuse = SearchEngine.buildIndex(enriched, ['_acc', '_party', 'description', 'counterparty_name']);
    rows = fuse.search(q).map(r => r.item);
  }
  bbTxnTable.replaceData(rows);
}
function bbOnTxnFilterChange() { bbReadTxnFilters(); bbApplyTxnFilters(); }
function bbClearTxnFilters() {
  ['bb-filter-account', 'bb-filter-type', 'bb-filter-particular', 'bb-filter-fy', 'bb-filter-from', 'bb-filter-to', 'bb-txn-search']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  bbFilters = { account: '', type: '', particular: '', fy: '', from: '', to: '' };
  bbApplyTxnFilters();
}

// ── Transaction drawer ──
function bbSelectClient(c) {
  bbSelectedClient = c;
  document.getElementById('bb-txn-client-search').value = c.name;
}

function bbOpenTxn(mode, existing) {
  bbTxnMode = mode;                 // 'receipt' | 'payment'
  bbEditingTxn = existing || null;
  bbSelectedClient = null;
  const isEdit = !!existing;
  const title = (isEdit ? 'Edit ' : 'New ') + (mode === 'receipt' ? 'Receipt' : 'Payment');
  document.getElementById('bb-txn-drawer-title').textContent = title;
  document.getElementById('bb-txn-delete-btn').style.display = isEdit ? '' : 'none';
  document.getElementById('bb-txn-drawer-status').innerHTML = '';

  // Particular options depend on receipt vs payment
  const types = mode === 'receipt' ? window.BANK_RECEIPT_TYPES : window.BANK_PAYMENT_TYPES;
  document.getElementById('bb-txn-particular').innerHTML =
    types.map(t => `<option value="${t.key}">${escHtml(t.label)}</option>`).join('');

  // Values. For a transfer being edited, present From = payment leg's account,
  // To = receipt leg's account (regardless of which leg was clicked).
  let accountId = existing ? existing.account_id : '';
  let counterId = existing ? existing.counterparty_account_id : '';
  if (existing && existing.particular === 'inter_bank_transfer' && existing.transfer_group_id) {
    const sibs = bbTransferSiblings(existing.transfer_group_id);
    const pay = sibs.find(s => s.txn_type === 'payment');
    const rec = sibs.find(s => s.txn_type === 'receipt');
    if (pay) accountId = pay.account_id;
    if (rec) counterId = rec.account_id;
  }

  document.getElementById('bb-txn-account').value = accountId || '';
  document.getElementById('bb-txn-counter-account').value = counterId || '';
  document.getElementById('bb-txn-date').value = existing ? (existing.txn_date || '') : bbTodayBsStr();
  document.getElementById('bb-txn-amount').value = existing ? existing.amount : '';
  document.getElementById('bb-txn-particular').value = existing ? existing.particular : (types[0] && types[0].key);
  document.getElementById('bb-txn-party').value = (existing && existing.particular !== 'inter_bank_transfer') ? (existing.counterparty_name || '') : '';
  document.getElementById('bb-txn-client-search').value = (existing && bbIsClientParticular(existing.particular)) ? (existing.counterparty_name || '') : '';
  document.getElementById('bb-txn-description').value = existing ? (existing.description || '') : '';

  if (existing && existing.client_id) {
    const c = (window.clientsList || []).find(x => x.id === existing.client_id);
    if (c) bbSelectedClient = c;
  }

  bbOnParticularChange();
  document.getElementById('bb-txn-drawer').classList.add('open');
}
function bbCloseTxn() { document.getElementById('bb-txn-drawer').classList.remove('open'); }

// Swap the contextual party field to match the chosen particular.
function bbOnParticularChange() {
  const particular = document.getElementById('bb-txn-particular').value;
  const types = bbTxnMode === 'receipt' ? window.BANK_RECEIPT_TYPES : window.BANK_PAYMENT_TYPES;
  const def = types.find(t => t.key === particular);
  const isTransfer = particular === 'inter_bank_transfer';
  const isClient = bbIsClientParticular(particular);

  document.getElementById('bb-txn-transfer-group').style.display = isTransfer ? '' : 'none';
  document.getElementById('bb-txn-client-group').style.display = isClient ? '' : 'none';
  document.getElementById('bb-txn-party-group').style.display = (!isTransfer && !isClient) ? '' : 'none';
  const partyLabel = document.getElementById('bb-txn-party-label');
  if (partyLabel && def) partyLabel.textContent = def.party;
  const clientLabel = document.getElementById('bb-txn-client-label');
  if (clientLabel && def) clientLabel.textContent = def.party + ' (search by name or PAN)';
  // Only the free-text Expenses field offers the used-names datalist.
  document.getElementById('bb-txn-party').setAttribute('list', particular === 'expenses' ? 'bb-expense-names' : '');

  // For a transfer, the source-account field is labelled "From" account.
  document.getElementById('bb-txn-account-label').textContent = isTransfer
    ? (bbTxnMode === 'receipt' ? 'To Account (money in)' : 'From Account (money out)')
    : 'Account';
}

function bbDrawerErr(msg) { showStatus(escHtml(msg), 'info', 'bb-txn-drawer-status'); }

async function bbSaveTxn(btn) {
  const accountId = parseInt(document.getElementById('bb-txn-account').value, 10);
  if (!accountId) { bbDrawerErr('Select an account.'); return; }
  const date = document.getElementById('bb-txn-date').value.trim();
  if (!bbValidBsDate(date)) { bbDrawerErr('Enter a valid B.S. date (YYYY.MM.DD).'); return; }
  const amount = parseFloat(document.getElementById('bb-txn-amount').value);
  if (!(amount > 0)) { bbDrawerErr('Enter an amount greater than zero.'); return; }
  const particular = document.getElementById('bb-txn-particular').value;

  if (particular === 'inter_bank_transfer') { bbSaveTransfer(accountId, date, amount, btn); return; }

  // Counterparty: the client particulars (Fee Receipt / For Tax / Tax Payment)
  // link a directory client; others are free text.
  let counterpartyName, clientId = null;
  if (bbIsClientParticular(particular)) {
    counterpartyName = document.getElementById('bb-txn-client-search').value.trim();
    if (!counterpartyName) { bbDrawerErr('Enter or select the client.'); return; }
    if (bbSelectedClient && bbSelectedClient.name === counterpartyName) clientId = bbSelectedClient.id;
  } else {
    counterpartyName = document.getElementById('bb-txn-party').value.trim() || null;
  }

  const payload = {
    account_id: accountId,
    txn_type: bbTxnMode,
    txn_date: date,
    particular,
    amount,
    counterparty_name: counterpartyName,
    client_id: clientId,
    counterparty_account_id: null,
    transfer_group_id: null,
    description: document.getElementById('bb-txn-description').value.trim() || null,
    fiscal_year: bbFyFromDate(date),
    updated_by: bbUserEmail(),
  };

  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      if (bbEditingTxn) {
        // Editing a plain txn that used to be a transfer leg shouldn't happen (a
        // transfer's particular can't change to non-transfer without both legs) —
        // guard anyway by clearing any stray group id above.
        const { error } = await window.sb.from('bank_transactions').update(payload).eq('id', bbEditingTxn.id);
        if (error) throw error;
        AuditLog.record('bank_txn_updated', { module: 'bankBook', clientName: counterpartyName || '', recordRef: bbEditingTxn.id });
      } else {
        payload.created_by = payload.updated_by;
        const { data, error } = await window.sb.from('bank_transactions').insert(payload).select('id').single();
        if (error) throw error;
        AuditLog.record('bank_txn_created', { module: 'bankBook', clientName: counterpartyName || '', recordRef: data.id });
      }
      bbCloseTxn();
      showToast('✅ Transaction saved.', 'success');
      bbReload().catch(e => showToast('❌ Saved, but the ledger failed to refresh: ' + escHtml(e.message || String(e)), 'error'));
    } catch (e) {
      showStatus('❌ Could not save the transaction: ' + escHtml(e.message || 'unknown error'), 'error', 'bb-txn-drawer-status');
    }
  });
}

// One transfer = two paired legs sharing transfer_group_id. `srcAccount` is the
// account the drawer was opened on: the From account when entered from Payment,
// the To account when entered from Receipt. The counterpart is the other one.
async function bbSaveTransfer(srcAccount, date, amount, btn) {
  const counter = parseInt(document.getElementById('bb-txn-counter-account').value, 10);
  if (!counter) { bbDrawerErr('Select the other account for the transfer.'); return; }
  if (counter === srcAccount) { bbDrawerErr('The two accounts must be different.'); return; }

  // Resolve From (payment leg) and To (receipt leg) regardless of entry mode.
  const fromId = bbTxnMode === 'payment' ? srcAccount : counter;
  const toId = bbTxnMode === 'payment' ? counter : srcAccount;
  const description = document.getElementById('bb-txn-description').value.trim() || null;
  const fy = bbFyFromDate(date);
  const who = bbUserEmail();
  const groupId = (bbEditingTxn && bbEditingTxn.transfer_group_id) || crypto.randomUUID();

  const payLeg = {
    account_id: fromId, txn_type: 'payment', txn_date: date, particular: 'inter_bank_transfer',
    amount, counterparty_name: null, client_id: null, counterparty_account_id: toId,
    transfer_group_id: groupId, description, fiscal_year: fy, updated_by: who,
  };
  const recLeg = {
    account_id: toId, txn_type: 'receipt', txn_date: date, particular: 'inter_bank_transfer',
    amount, counterparty_name: null, client_id: null, counterparty_account_id: fromId,
    transfer_group_id: groupId, description, fiscal_year: fy, updated_by: who,
  };

  await WorkflowEngine.withBusyButton(btn, 'Saving transfer…', async () => {
    try {
      if (bbEditingTxn && bbEditingTxn.transfer_group_id) {
        // Update BOTH existing legs so they can never desync.
        const sibs = bbTransferSiblings(bbEditingTxn.transfer_group_id);
        const pay = sibs.find(s => s.txn_type === 'payment');
        const rec = sibs.find(s => s.txn_type === 'receipt');
        if (pay) { const { error } = await window.sb.from('bank_transactions').update(payLeg).eq('id', pay.id); if (error) throw error; }
        if (rec) { const { error } = await window.sb.from('bank_transactions').update(recLeg).eq('id', rec.id); if (error) throw error; }
        // Safety: if somehow only one leg existed, create the missing one.
        if (!pay) { payLeg.created_by = who; const { error } = await window.sb.from('bank_transactions').insert(payLeg); if (error) throw error; }
        if (!rec) { recLeg.created_by = who; const { error } = await window.sb.from('bank_transactions').insert(recLeg); if (error) throw error; }
        AuditLog.record('bank_transfer_updated', { module: 'bankBook', recordRef: pay ? pay.id : null, detail: { groupId } });
      } else {
        payLeg.created_by = who; recLeg.created_by = who;
        const { error } = await window.sb.from('bank_transactions').insert([payLeg, recLeg]);
        if (error) throw error;
        AuditLog.record('bank_transfer_created', { module: 'bankBook', detail: { groupId, from: fromId, to: toId } });
      }
      bbCloseTxn();
      showToast('✅ Transfer saved (recorded on both accounts).', 'success');
      bbReload().catch(e => showToast('❌ Saved, but the ledger failed to refresh: ' + escHtml(e.message || String(e)), 'error'));
    } catch (e) {
      showStatus('❌ Could not save the transfer: ' + escHtml(e.message || 'unknown error'), 'error', 'bb-txn-drawer-status');
    }
  });
}

async function bbDeleteTxn(row) {
  // Deleting either leg of a transfer removes BOTH.
  if (row.transfer_group_id) {
    const sibs = bbTransferSiblings(row.transfer_group_id);
    if (!confirm(`Delete this inter-bank transfer? Both legs (payment and receipt) will be removed.`)) return;
    const ids = sibs.map(s => s.id);
    const { error } = await window.sb.from('bank_transactions').delete().in('id', ids);
    if (error) { bbStatus('❌ ' + escHtml(error.message), 'error'); return; }
    AuditLog.record('bank_transfer_deleted', { module: 'bankBook', detail: { groupId: row.transfer_group_id } });
  } else {
    if (!confirm('Delete this transaction? This cannot be undone.')) return;
    const { error } = await window.sb.from('bank_transactions').delete().eq('id', row.id);
    if (error) { bbStatus('❌ ' + escHtml(error.message), 'error'); return; }
    AuditLog.record('bank_txn_deleted', { module: 'bankBook', clientName: row.counterparty_name || '', recordRef: row.id });
  }
  await bbReload();
}
async function bbDeleteTxnFromDrawer() {
  if (!bbEditingTxn) return;
  await bbDeleteTxn(bbEditingTxn);
  const stillExists = bbTxns.some(t => t.id === bbEditingTxn.id);
  if (!stillExists) bbCloseTxn();
}

// ════════════════════════════════════════════
//  SECTION 3 — REPORTS
// ════════════════════════════════════════════
// Build the report model (shared by on-screen render + PDF + Excel exports).
function bbBuildReport() {
  const accountId = parseInt(document.getElementById('bb-report-account').value, 10);
  const type = document.getElementById('bb-report-type').value;      // receipt | payment | statement
  const from = document.getElementById('bb-report-from').value.trim();
  const to = document.getElementById('bb-report-to').value.trim();
  if (!accountId) return { error: 'Select an account.' };
  if (from && !bbValidBsDate(from)) return { error: 'From date must be a valid B.S. date (YYYY.MM.DD).' };
  if (to && !bbValidBsDate(to)) return { error: 'To date must be a valid B.S. date (YYYY.MM.DD).' };
  const fromOrd = from ? bbDateOrd(from) : null;
  const toOrd = to ? bbDateOrd(to) : null;

  const acc = bbAccountById(accountId);
  const inRange = t => {
    if (t.account_id !== accountId) return false;
    const ord = bbDateOrd(t.txn_date);
    if (fromOrd != null && ord != null && ord < fromOrd) return false;
    if (toOrd != null && ord != null && ord > toOrd) return false;
    return true;
  };
  const bySeq = (a, b) => (bbDateOrd(a.txn_date) - bbDateOrd(b.txn_date)) || (a.id - b.id);

  const meta = { type, account: acc, accountLabel: bbAccountLabel(acc), from, to };

  if (type === 'statement') {
    // Opening balance for the range = account opening + net of everything before `from`.
    let opening = Number(acc.opening_balance || 0);
    if (fromOrd != null) {
      bbTxns.forEach(t => {
        if (t.account_id !== accountId) return;
        const ord = bbDateOrd(t.txn_date);
        if (ord != null && ord < fromOrd) opening += (t.txn_type === 'receipt' ? 1 : -1) * Number(t.amount || 0);
      });
    }
    const rows = bbTxns.filter(inRange).sort(bySeq);
    let bal = opening;
    const lines = rows.map(t => {
      const payment = t.txn_type === 'payment' ? Number(t.amount || 0) : null;
      const receipt = t.txn_type === 'receipt' ? Number(t.amount || 0) : null;
      bal += (receipt || 0) - (payment || 0);
      return { date: t.txn_date, particular: bbParticularLabel(t.particular), payment, receipt, balance: bal, name: bbTxnCounterparty(t), description: t.description || '' };
    });
    return { ...meta, opening, lines, closing: bal };
  }

  // Receipt / Payment register
  const rows = bbTxns.filter(t => inRange(t) && t.txn_type === type).sort(bySeq);
  const lines = rows.map(t => ({ date: t.txn_date, particular: bbParticularLabel(t.particular), amount: Number(t.amount || 0), name: bbTxnCounterparty(t), description: t.description || '' }));
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { ...meta, lines, total };
}

function bbGenerateReport() {
  const out = document.getElementById('bb-report-output');
  const rep = bbBuildReport();
  if (rep.error) { out.innerHTML = `<div class="status-box status-info">${escHtml(rep.error)}</div>`; bbLastReport = null; bbSetExportEnabled(false); return; }
  bbLastReport = rep;
  out.innerHTML = bbReportHtml(rep);
  bbSetExportEnabled(true);
}
function bbSetExportEnabled(on) {
  ['bb-report-pdf-btn', 'bb-report-excel-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !on; });
}

function bbReportTitle(rep) {
  return rep.type === 'statement' ? 'Bank Statement' : (rep.type === 'receipt' ? 'Receipt Report' : 'Payment Report');
}
function bbPeriodText(rep) {
  const from = rep.from || (rep.account && rep.account.opening_date) || '—';
  return `From ${from} to ${rep.to || '—'}`;
}

function bbReportHtml(rep) {
  const head = `
    <div style="margin:6px 0 14px;">
      <div style="font-size:16px; font-weight:700; color:var(--brand-navy);">${escHtml(bbReportTitle(rep))}</div>
      <div style="font-size:13px; color:var(--text-muted);">${escHtml(rep.account.account_name)} — ${escHtml(rep.account.bank_name)}${rep.account.account_number ? ' · A/C ' + escHtml(rep.account.account_number) : ''}</div>
      <div style="font-size:12.5px; color:var(--text-muted);">${escHtml(bbPeriodText(rep))}</div>
    </div>`;

  if (rep.type === 'statement') {
    const body = rep.lines.map(l => `
      <tr>
        <td>${escHtml(l.date)}</td>
        <td>${escHtml(l.particular)}</td>
        <td style="text-align:right;">${l.payment != null ? bbAmt(l.payment) : '—'}</td>
        <td style="text-align:right;">${l.receipt != null ? bbAmt(l.receipt) : '—'}</td>
        <td style="text-align:right; font-weight:600; ${l.balance < -0.005 ? 'color:var(--red);' : ''}">${bbAmt(l.balance)}</td>
        <td>${escHtml(l.name)}</td>
        <td>${escHtml(l.description)}</td>
      </tr>`).join('');
    return head + `
      <div style="overflow-x:auto;"><table class="client-table">
        <thead><tr><th>Date</th><th>Particular</th><th style="text-align:right;">Payment</th><th style="text-align:right;">Receipt</th><th style="text-align:right;">Balance</th><th>Name of Client/Person/Bank</th><th>Description</th></tr></thead>
        <tbody>
          <tr style="background:var(--bg-page-alt); font-weight:600;"><td colspan="4">Opening Balance</td><td style="text-align:right;">${bbAmt(rep.opening)}</td><td colspan="2"></td></tr>
          ${body || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No transactions in this period.</td></tr>`}
          <tr style="background:var(--bg-page-alt); font-weight:700; color:var(--brand-navy);"><td colspan="4">Closing Balance</td><td style="text-align:right;">${bbAmt(rep.closing)}</td><td colspan="2"></td></tr>
        </tbody>
      </table></div>`;
  }

  const body = rep.lines.map(l => `
    <tr>
      <td>${escHtml(l.date)}</td>
      <td>${escHtml(l.particular)}</td>
      <td style="text-align:right;">${bbAmt(l.amount)}</td>
      <td>${escHtml(l.name)}</td>
      <td>${escHtml(l.description)}</td>
    </tr>`).join('');
  const nameHead = rep.type === 'payment' ? 'Name of Client/Person/Bank/Nature of Expense' : 'Name of Client/Person/Bank';
  return head + `
    <div style="overflow-x:auto;"><table class="client-table">
      <thead><tr><th>Date</th><th>Particular of ${rep.type === 'payment' ? 'Payment' : 'Receipt'}</th><th style="text-align:right;">Amount</th><th>${nameHead}</th><th>Description</th></tr></thead>
      <tbody>
        ${body || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No ${escHtml(rep.type)}s in this period.</td></tr>`}
        <tr style="background:var(--bg-page-alt); font-weight:700; color:var(--brand-navy);"><td colspan="2">Total</td><td style="text-align:right;">${bbAmt(rep.total)}</td><td colspan="2"></td></tr>
      </tbody>
    </table></div>`;
}

// ── PDF export (PDF-Lib, with page breaks) ──
async function bbReportToPdf() {
  await LibLoader.ensure('pdflib');
  if (!bbLastReport) return;
  const rep = bbLastReport;
  try {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const navy = PDFLib.rgb(0.043, 0.122, 0.239);
    const muted = PDFLib.rgb(0.392, 0.455, 0.545);
    const black = PDFLib.rgb(0.1, 0.12, 0.16);
    const lineC = PDFLib.rgb(0.85, 0.87, 0.92);
    const red = PDFLib.rgb(0.8, 0.1, 0.1);
    const marginL = 40, marginR = 802;              // A4 landscape (842 wide)
    let page, y;

    // Column layout per report type: [x, width, align]
    const isStmt = rep.type === 'statement';
    const cols = isStmt
      ? [['Date', 40, 70, 'l'], ['Particular', 112, 95, 'l'], ['Payment', 210, 85, 'r'], ['Receipt', 300, 85, 'r'], ['Balance', 390, 90, 'r'], ['Name', 486, 170, 'l'], ['Description', 660, 142, 'l']]
      : [['Date', 40, 75, 'l'], ['Particular', 120, 120, 'l'], ['Amount', 245, 95, 'r'], ['Name of Client/Person/Bank' + (rep.type === 'payment' ? '/Nature' : ''), 345, 240, 'l'], ['Description', 590, 212, 'l']];

    const drawAt = (text, x, size, f, color) => page.drawText(String(text), { x, y, size, font: f || font, color: color || black });
    const drawCell = (text, x, w, align, size, f, color) => {
      let s = String(text == null ? '' : text);
      const ff = f || font;
      while (s && ff.widthOfTextAtSize(s, size) > w - 4) s = s.slice(0, -1);
      const tw = ff.widthOfTextAtSize(s, size);
      const px = align === 'r' ? x + w - tw : x + 2;
      page.drawText(s, { x: px, y, size, font: ff, color: color || black });
    };

    const newPage = () => {
      page = doc.addPage([842, 595]);
      y = 560;
      drawAt(bbReportTitle(rep), marginL, 16, bold, navy); y -= 16;
      drawAt(`${rep.account.account_name} — ${rep.account.bank_name}${rep.account.account_number ? '  ·  A/C ' + rep.account.account_number : ''}`, marginL, 10, font, muted); y -= 13;
      drawAt(bbPeriodText(rep), marginL, 9.5, font, muted); y -= 16;
      // header row
      page.drawRectangle({ x: marginL, y: y - 3, width: marginR - marginL, height: 16, color: PDFLib.rgb(0.95, 0.96, 0.98) });
      cols.forEach(([label, x, w, a]) => drawCell(label, x, w, a, 8.5, bold, navy));
      y -= 18;
    };
    newPage();

    const rowH = 14;
    const ensure = () => { if (y < 50) { newPage(); } };
    const dashOr = v => (v == null ? '—' : bbAmt(v));

    if (isStmt) {
      // Opening
      drawCell('Opening Balance', cols[0][1], cols[1][1] + cols[1][2] - cols[0][1], 'l', 9, bold, black);
      drawCell(bbAmt(rep.opening), cols[4][1], cols[4][2], 'r', 9, bold, black); y -= rowH;
      rep.lines.forEach(l => {
        ensure();
        drawCell(l.date, cols[0][1], cols[0][2], 'l', 8.5, font);
        drawCell(l.particular, cols[1][1], cols[1][2], 'l', 8.5, font);
        drawCell(dashOr(l.payment), cols[2][1], cols[2][2], 'r', 8.5, font);
        drawCell(dashOr(l.receipt), cols[3][1], cols[3][2], 'r', 8.5, font);
        drawCell(bbAmt(l.balance), cols[4][1], cols[4][2], 'r', 8.5, bold, l.balance < -0.005 ? red : black);
        drawCell(l.name, cols[5][1], cols[5][2], 'l', 8.5, font);
        drawCell(l.description, cols[6][1], cols[6][2], 'l', 8.5, font);
        y -= rowH;
      });
      ensure();
      page.drawLine({ start: { x: marginL, y: y + 4 }, end: { x: marginR, y: y + 4 }, thickness: 0.7, color: lineC });
      drawCell('Closing Balance', cols[0][1], cols[1][1] + cols[1][2] - cols[0][1], 'l', 9, bold, navy);
      drawCell(bbAmt(rep.closing), cols[4][1], cols[4][2], 'r', 9, bold, navy);
    } else {
      rep.lines.forEach(l => {
        ensure();
        drawCell(l.date, cols[0][1], cols[0][2], 'l', 8.5, font);
        drawCell(l.particular, cols[1][1], cols[1][2], 'l', 8.5, font);
        drawCell(bbAmt(l.amount), cols[2][1], cols[2][2], 'r', 8.5, font);
        drawCell(l.name, cols[3][1], cols[3][2], 'l', 8.5, font);
        drawCell(l.description, cols[4][1], cols[4][2], 'l', 8.5, font);
        y -= rowH;
      });
      ensure();
      page.drawLine({ start: { x: marginL, y: y + 4 }, end: { x: marginR, y: y + 4 }, thickness: 0.7, color: lineC });
      drawCell('Total', cols[0][1], cols[1][1] + cols[1][2] - cols[0][1], 'l', 9.5, bold, navy);
      drawCell(bbAmt(rep.total), cols[2][1], cols[2][2], 'r', 9.5, bold, navy);
    }

    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const fname = `${bbReportTitle(rep)} - ${rep.account.account_name} - ${rep.account.bank_name}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'bankBook', clientName: rep.account.account_name });
  } catch (e) {
    bbStatus('❌ Failed to generate PDF: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Excel export (ExcelJS — mirrors depGenerateExcel styling) ──
async function bbReportToExcel() {
  if (!bbLastReport) return;
  const rep = bbLastReport;
  try {
    await LibLoader.ensure('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(bbReportTitle(rep).slice(0, 31));
    const MONEY = '#,##0.00;(#,##0.00);"–"';
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
    const NAVY = 'FF0B1F3D';
    const isStmt = rep.type === 'statement';

    const headers = isStmt
      ? ['Date', 'Particular', 'Payment', 'Receipt', 'Balance', 'Name of Client/Person/Bank', 'Description']
      : ['Date', 'Particular of ' + (rep.type === 'payment' ? 'Payment' : 'Receipt'), 'Amount',
         'Name of Client/Person/Bank' + (rep.type === 'payment' ? '/Nature of Expense' : ''), 'Description'];
    const nCol = headers.length;
    ws.columns = isStmt
      ? [{ width: 13 }, { width: 20 }, { width: 15 }, { width: 15 }, { width: 16 }, { width: 30 }, { width: 30 }]
      : [{ width: 13 }, { width: 24 }, { width: 16 }, { width: 34 }, { width: 30 }];
    const colLetter = i => String.fromCharCode(65 + i);
    const last = colLetter(nCol - 1);

    // Title block
    ws.mergeCells(`A1:${last}1`);
    ws.getCell('A1').value = `${rep.account.account_name} — ${rep.account.bank_name}${rep.account.account_number ? '  ·  A/C ' + rep.account.account_number : ''}`;
    ws.getCell('A1').font = { bold: true, size: 13, color: { argb: NAVY } };
    ws.getCell('A1').alignment = { horizontal: 'center' };
    ws.mergeCells(`A2:${last}2`);
    ws.getCell('A2').value = `${bbReportTitle(rep)}   |   ${bbPeriodText(rep)}`;
    ws.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    // Header row (row 4)
    const H = 4;
    headers.forEach((h, i) => {
      const c = ws.getCell(`${colLetter(i)}${H}`);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: NAVY } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
      c.border = allBorders;
    });

    let r = H + 1;
    const border = (rowNum) => { for (let i = 0; i < nCol; i++) ws.getCell(`${colLetter(i)}${rowNum}`).border = allBorders; };

    if (isStmt) {
      // Opening row
      ws.mergeCells(`A${r}:D${r}`);
      ws.getCell(`A${r}`).value = 'Opening Balance';
      ws.getCell(`A${r}`).font = { bold: true };
      ws.getCell(`E${r}`).value = rep.opening; ws.getCell(`E${r}`).numFmt = MONEY; ws.getCell(`E${r}`).font = { bold: true };
      border(r); r++;
      rep.lines.forEach(l => {
        ws.getCell(`A${r}`).value = l.date;
        ws.getCell(`B${r}`).value = l.particular;
        if (l.payment != null) { ws.getCell(`C${r}`).value = l.payment; ws.getCell(`C${r}`).numFmt = MONEY; }
        if (l.receipt != null) { ws.getCell(`D${r}`).value = l.receipt; ws.getCell(`D${r}`).numFmt = MONEY; }
        ws.getCell(`E${r}`).value = l.balance; ws.getCell(`E${r}`).numFmt = MONEY; ws.getCell(`E${r}`).font = { bold: true };
        ws.getCell(`F${r}`).value = l.name;
        ws.getCell(`G${r}`).value = l.description;
        border(r); r++;
      });
      ws.mergeCells(`A${r}:D${r}`);
      ws.getCell(`A${r}`).value = 'Closing Balance';
      ws.getCell(`E${r}`).value = rep.closing; ws.getCell(`E${r}`).numFmt = MONEY;
      ws.getRow(r).eachCell(c => { c.font = { bold: true, color: { argb: NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1FA' } }; });
      border(r);
    } else {
      const first = r;
      rep.lines.forEach(l => {
        ws.getCell(`A${r}`).value = l.date;
        ws.getCell(`B${r}`).value = l.particular;
        ws.getCell(`C${r}`).value = l.amount; ws.getCell(`C${r}`).numFmt = MONEY;
        ws.getCell(`D${r}`).value = l.name;
        ws.getCell(`E${r}`).value = l.description;
        border(r); r++;
      });
      ws.mergeCells(`A${r}:B${r}`);
      ws.getCell(`A${r}`).value = 'Total';
      const totalCell = ws.getCell(`C${r}`);
      totalCell.value = rep.lines.length ? { formula: `SUM(C${first}:C${r - 1})`, result: rep.total } : rep.total;
      totalCell.numFmt = MONEY;
      ws.getRow(r).eachCell(c => { c.font = { bold: true, color: { argb: NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1FA' } }; });
      border(r);
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = `${bbReportTitle(rep)} - ${rep.account.account_name} - ${rep.account.bank_name}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    DocumentEngine.downloadBlob(blob, fname, { module: 'bankBook', clientName: rep.account.account_name });
  } catch (e) {
    bbStatus('❌ Failed to generate Excel: ' + escHtml(e.message || String(e)), 'error');
  }
}
