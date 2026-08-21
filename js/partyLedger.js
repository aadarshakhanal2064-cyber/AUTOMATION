// ════════════════════════════════════════════
//  PARTY LEDGER
//  The join between Service Memo and Bank Entry. Neither module alone can say
//  what a client owes: the memo records work done, the bank records money
//  moved. This module nets them per party, and adds the one figure that can't
//  be derived — the saved opening balance (party_opening_balances).
//
//  Four views, matching the four buttons on the workbook's "Party Ledger"
//  sheet, all sharing the Firm + From/To controls:
//    · Party Ledger      one client's statement (services + tax − payments)
//    · Party List        every party's balance, with a Total row
//    · Expenses Ledger   one expense name's entries across the firm's accounts
//    · Expenses Name List  every expense name with its period total
//
//  Sign convention (from the sheet's Net Payable formula):
//    Total Payable = Opening
//                  + Service Provided   (service_memos, incl. their own VAT)
//                  + Tax Payment        (bank payments made on the client's behalf)
//                  − Payment            (bank receipts: Fee Receipt + For Tax)
//
//  Nothing here is stored. plPartyBalance() is the single balance function, and
//  Final Account calls it too, so the two modules can never report a different
//  receivable for the same client.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'partyLedger', group: 'main', buttonId: null, panelId: 'tab-partyLedger-panel' });

const PL_VIEWS = {
  ledger:     { label: 'Party Ledger',       title: 'Party Ledger' },
  partyList:  { label: 'Party List',         title: 'Party List' },
  expLedger:  { label: 'Expenses Ledger',    title: 'Expenses Ledger' },
  expList:    { label: 'Expenses Name List', title: 'Expenses List' },
};

let plMemos = [];
let plTxns = [];
let plAccounts = [];
let plOpenings = [];
let plView = 'ledger';
let plSelectedClient = null;
let plLastModel = null;        // last rendered report model, for the exports
let plInitDone = false;

function plUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function plStatus(html, type) { showStatus(html, type, 'pl-status-area'); }
function plNorm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function plVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

// ── Entry point ──
function plInit() {
  if (!plInitDone) {
    const firmSel = document.getElementById('pl-firm');
    firmSel.innerHTML = Object.values(window.SERVICE_MEMO_FIRMS)
      .map(f => `<option value="${escHtml(f.key)}">${escHtml(f.name)}</option>`).join('');

    SearchEngine.attachAutocomplete(
      document.getElementById('pl-client-search'),
      document.getElementById('pl-client-autocomplete'),
      {
        getList: () => window.clientsList,
        keys: ['name', 'pan'],
        renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
        onSelect: plSelectClient,
      }
    );

    // Default the period to the current fiscal year (Shrawan 1 → today).
    const bs = NepaliLocale.todayBs();
    if (bs) {
      const startYear = bs.month >= 4 ? bs.year : bs.year - 1;
      document.getElementById('pl-from').value = `${startYear}.04.01`;
      document.getElementById('pl-to').value = NepaliLocale.todayBsStr();
    }
    plInitDone = true;
  }
  plRefresh();
}

// Cache keys are shared with Bank Entry and defined in config.js
// (window.LEDGER_KEYS) — see the comment there for why a key carries its
// ORDER BY. Final Account calls plRefresh() too, so this one function is the
// single load path for both modules.
//
// Like bbRefresh(), this must never invalidate: plReload() below is the write
// path.
async function plRefresh() {
  plStatus('<span class="spinner spinner-navy"></span> Loading ledger data…', 'searching');
  try {
    [plMemos, plTxns, plAccounts, plOpenings] = await Promise.all([
      DataCache.get(window.LEDGER_KEYS.memosPl,    () => sbFetchAll(() => window.sb.from('service_memos').select('*').order('memo_date').order('id'))),
      DataCache.get(window.LEDGER_KEYS.txns,       () => sbFetchAll(() => window.sb.from('bank_transactions').select('*').order('txn_date').order('id'))),
      DataCache.get(window.LEDGER_KEYS.accountsPl, () => sbFetchAll(() => window.sb.from('bank_accounts').select('*').order('sort_order').order('id'))),
      DataCache.get(window.LEDGER_KEYS.openings,   () => sbFetchAll(() => window.sb.from('party_opening_balances').select('*').order('id'))),
    ]);
    plPopulateExpenseNames();
    document.getElementById('pl-status-area').innerHTML = '';
    plGenerate();
  } catch (e) {
    plStatus('❌ Failed to load ledger data: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// ════════════════════════════════════════════
//  SHARED SELECTION / MATCHING
// ════════════════════════════════════════════
function plFirmKey() { return plVal('pl-firm'); }
function plFirm() { return window.SERVICE_MEMO_FIRMS[plFirmKey()] || {}; }
// Letterhead lines for the selected firm — REP_FIRMS carries address/PAN for
// the two audit firms; the sister concerns fall back to their own blank fields.
function plFirmHeader() {
  const f = plFirm();
  const base = f.ref ? window.REP_FIRMS[f.ref] : null;
  return { name: f.name || '—', address: (base ? base.address : f.address) || '' };
}

// Accounts belonging to a firm. Bank rows are attributed to a firm through
// their account, never directly.
function plFirmAccountIds(firmKey) {
  return new Set(plAccounts.filter(a => a.firm_key === firmKey).map(a => a.id));
}
function plAccountLabel(id) {
  const a = plAccounts.find(x => x.id === id);
  return a ? `${a.account_name} — ${a.bank_name}` : '—';
}

// Period. Both bounds are optional; an unparseable row date never excludes the
// row (same tolerance as bankBook's range filters).
function plMakeRange(from, to) {
  return { from: from || '', to: to || '',
           fromOrd: from ? NepaliLocale.bsDateOrd(from) : null,
           toOrd: to ? NepaliLocale.bsDateOrd(to) : null };
}
function plRange() { return plMakeRange(plVal('pl-from'), plVal('pl-to')); }
function plInRange(ord, range) {
  if (ord == null) return true;
  if (range.fromOrd != null && ord < range.fromOrd) return false;
  if (range.toOrd != null && ord > range.toOrd) return false;
  return true;
}
function plPeriodText(range) {
  return `From ${range.from || '(beginning)'} to ${range.to || '(to date)'}`;
}
// Fiscal year the period belongs to — keys the saved opening balance.
function plFiscalYear(range) {
  return NepaliLocale.bsFyDash(range.from) || NepaliLocale.bsFyDash(range.to) || NepaliLocale.bsFyDash(NepaliLocale.todayBsStr()) || '';
}

// Service memos carry a Gregorian date; bank rows carry B.S. text. Both are
// reduced to a B.S. ordinal + display string so one ledger can list them.
function plMemoBs(memo) { return NepaliLocale.adToBs(memo.memo_date); }
function plMemoOrd(memo) { const b = plMemoBs(memo); return b ? NepaliLocale.bsOrdinal(b) : null; }

// A party is a directory client where one can be resolved, else the typed name.
// Memos and bank rows both snapshot the name, so a typed-only client still
// collects its own rows instead of scattering.
function plResolveClientId(name) {
  const n = plNorm(name);
  if (!n) return null;
  const hit = (window.clientsList || []).find(c => plNorm(c.name) === n);
  return hit ? hit.id : null;
}
function plPartyKey(clientId, name) {
  const id = clientId || plResolveClientId(name);
  return id ? 'id:' + id : 'nm:' + plNorm(name);
}

function plOpeningFor(clientId, firmKey, range) {
  if (!clientId) return null;
  const fy = plFiscalYear(range);
  return plOpenings.find(o => o.client_id === clientId && o.firm_key === firmKey && o.fiscal_year === fy) || null;
}

// ════════════════════════════════════════════
//  THE LEDGER MODEL — one party's rows and totals
// ════════════════════════════════════════════
// Every party with activity in the firm + period, keyed by plPartyKey.
// Takes its scope as arguments (never reads the DOM) so Final Account can ask
// for a different firm/period than the one currently on screen.
function plBuildParties(firm, range) {
  const accIds = plFirmAccountIds(firm);
  const parties = new Map();

  const get = (clientId, name) => {
    const key = plPartyKey(clientId, name);
    if (!parties.has(key)) {
      const id = clientId || plResolveClientId(name);
      const c = id ? (window.clientsList || []).find(x => x.id === id) : null;
      parties.set(key, {
        key, clientId: id || null,
        name: (c && c.name) || name || '—',
        pan: (c && c.pan) || '',
        address: (c && c.address) || '',
        services: [], taxes: [], payments: [],
      });
    }
    return parties.get(key);
  };

  plMemos.forEach(m => {
    if (m.firm_key !== firm) return;
    const ord = plMemoOrd(m);
    if (!plInRange(ord, range)) return;
    const p = get(m.client_id, m.client_name);
    if (!p.pan && m.client_pan) p.pan = m.client_pan;
    if (!p.address && m.client_address) p.address = m.client_address;
    p.services.push({
      ord,
      date: NepaliLocale.bsToStr(plMemoBs(m)) || m.memo_date,
      particular: (m.nature_subcategory === 'Others' || m.nature_category === 'Others') && m.nature_other
        ? m.nature_other : (m.nature_subcategory || m.nature_category || '—'),
      taxable: Number(m.professional_fee || 0),
      vat: Number(m.vat_amount || 0),
      total: Number(m.total_amount || 0),
      description: [m.description, m.fiscal_year ? 'F.Y. ' + m.fiscal_year : ''].filter(Boolean).join(' · '),
    });
  });

  plTxns.forEach(t => {
    if (!accIds.has(t.account_id)) return;
    const ord = NepaliLocale.bsDateOrd(t.txn_date);
    if (!plInRange(ord, range)) return;
    const amount = Number(t.amount || 0);
    if (t.txn_type === 'payment' && t.particular === 'tax_payment') {
      const p = get(t.client_id, t.counterparty_name);
      p.taxes.push({ ord, date: t.txn_date, particular: t.description || 'Tax Paid', total: amount, description: plAccountLabel(t.account_id) });
    } else if (t.txn_type === 'receipt' && (t.particular === 'fee_receipt' || t.particular === 'for_tax')) {
      const p = get(t.client_id, t.counterparty_name);
      p.payments.push({ ord, date: t.txn_date, particular: plAccountLabel(t.account_id), total: amount, description: t.description || '' });
    }
  });

  const bySeq = (a, b) => (a.ord == null ? 1 : b.ord == null ? -1 : a.ord - b.ord);
  parties.forEach(p => {
    p.services.sort(bySeq); p.taxes.sort(bySeq); p.payments.sort(bySeq);
    const open = plOpeningFor(p.clientId, firm, range);
    p.opening = open ? Number(open.opening_amount || 0) : 0;
    p.openingAsOn = open ? (open.as_on_date || '') : '';
    p.totalService = p.services.reduce((s, x) => s + x.total, 0);
    p.totalTax = p.taxes.reduce((s, x) => s + x.total, 0);
    p.totalPayment = p.payments.reduce((s, x) => s + x.total, 0);
    p.netPayable = p.totalService + p.totalTax - p.totalPayment;
    p.totalPayable = p.netPayable + p.opening;
  });
  return parties;
}

// THE balance function. Final Account calls this (via plPartyBalance below) so
// receivables can never differ between the two modules.
function plPartyBalance(party) { return party.totalPayable; }

// Every party's balance for a firm + period — Final Account's Total
// Receivables. Returns [{ name, pan, balance }] with zero balances dropped.
function plReceivablesFor(firmKey, from, to) {
  return [...plBuildParties(firmKey, plMakeRange(from, to)).values()]
    .map(p => ({ name: p.name, pan: p.pan, balance: plPartyBalance(p) }))
    .filter(p => Math.abs(p.balance) > 0.005)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Expenses (bank payments with particular = 'expenses' on this firm) ──
function plExpenseRows(firmKey, range) {
  const accIds = plFirmAccountIds(firmKey);
  return plTxns
    .filter(t => t.txn_type === 'payment' && t.particular === 'expenses' && accIds.has(t.account_id))
    .filter(t => plInRange(NepaliLocale.bsDateOrd(t.txn_date), range))
    .map(t => ({
      ord: NepaliLocale.bsDateOrd(t.txn_date),
      date: t.txn_date,
      name: (t.counterparty_name || 'Unnamed').trim(),
      account: plAccountLabel(t.account_id),
      amount: Number(t.amount || 0),
      description: t.description || '',
    }))
    .sort((a, b) => (a.ord == null ? 1 : b.ord == null ? -1 : a.ord - b.ord));
}

// Grouped expense totals — the Name List view and Final Account's Expenses
// block are the same figures, so both come from here.
function plExpenseTotalsFor(firmKey, from, to) {
  const map = new Map();
  plExpenseRows(firmKey, plMakeRange(from, to)).forEach(r => {
    const k = plNorm(r.name);
    if (!map.has(k)) map.set(k, { name: r.name, amount: 0 });
    map.get(k).amount += r.amount;
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function plPopulateExpenseNames() {
  const dl = document.getElementById('pl-expense-names');
  if (!dl) return;
  const names = [...new Set(plTxns
    .filter(t => t.particular === 'expenses' && t.counterparty_name)
    .map(t => t.counterparty_name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

// ════════════════════════════════════════════
//  VIEWS
// ════════════════════════════════════════════
function plShowView(name) {
  plView = name;
  Object.keys(PL_VIEWS).forEach(v => {
    const btn = document.getElementById('pl-tab-' + v);
    if (btn) btn.classList.toggle('active', v === name);
  });
  // Only the Party Ledger view needs a client + opening balance.
  document.getElementById('pl-client-controls').style.display = name === 'ledger' ? '' : 'none';
  document.getElementById('pl-expense-controls').style.display = name === 'expLedger' ? '' : 'none';
  plGenerate();
}

function plSelectClient(c) {
  plSelectedClient = c;
  document.getElementById('pl-client-search').value = c.name;
  document.getElementById('pl-client-pan').value = c.pan || '';
  plLoadOpening();
  plGenerate();
}

// Show the saved opening balance for the picked client + firm + fiscal year.
function plLoadOpening() {
  const range = plRange();
  const open = plOpeningFor(plSelectedClient ? plSelectedClient.id : null, plFirmKey(), range);
  document.getElementById('pl-opening').value = open ? open.opening_amount : '';
  document.getElementById('pl-opening-date').value = open
    ? (open.as_on_date || '')
    : (range.from || '');
}

async function plSaveOpening() {
  if (!plSelectedClient) { plStatus('Select a client from the list first — an opening balance is saved against a directory client.', 'info'); return; }
  const range = plRange();
  const fy = plFiscalYear(range);
  if (!fy) { plStatus('Set a From date so the opening balance can be filed under a fiscal year.', 'info'); return; }
  const asOn = plVal('pl-opening-date');
  if (asOn && !NepaliLocale.isValidBsDate(asOn)) { plStatus('"As on" must be a valid B.S. date (YYYY.MM.DD).', 'info'); return; }

  const payload = {
    client_id: plSelectedClient.id,
    firm_key: plFirmKey(),
    fiscal_year: fy,
    as_on_date: asOn || null,
    opening_amount: parseFloat(plVal('pl-opening')) || 0,
    client_name: plSelectedClient.name,
    updated_by: plUserEmail(),
  };
  plStatus('<span class="spinner spinner-navy"></span> Saving opening balance…', 'searching');
  try {
    const { error } = await window.sb.from('party_opening_balances')
      .upsert({ ...payload, created_by: plUserEmail() }, { onConflict: 'client_id,firm_key,fiscal_year' });
    if (error) throw error;
    AuditLog.record('party_opening_saved', { module: 'partyLedger', clientName: plSelectedClient.name, detail: { fy, firm: payload.firm_key } });
    // Drop the cached copy before re-reading, or the row just written would be
    // served from cache and the save would look like it did nothing.
    DataCache.invalidate(window.LEDGER_KEYS.openings);
    plOpenings = await DataCache.get(window.LEDGER_KEYS.openings,
      () => sbFetchAll(() => window.sb.from('party_opening_balances').select('*').order('id')));
    plStatus('✅ Opening balance saved.', 'success');
    plGenerate();
  } catch (e) {
    plStatus('❌ ' + escHtml(e.message || 'Save failed'), 'error');
  }
}

// ── Model builders (one per view) ──
function plModelLedger() {
  const range = plRange();
  const fh = plFirmHeader();
  const name = plVal('pl-client-search');
  if (!name) return null;

  const parties = plBuildParties(plFirmKey(), range);
  const key = plPartyKey(plSelectedClient ? plSelectedClient.id : null, name);
  const p = parties.get(key) || {
    name, pan: plVal('pl-client-pan'), address: '', services: [], taxes: [], payments: [],
    opening: 0, openingAsOn: '', totalService: 0, totalTax: 0, totalPayment: 0, netPayable: 0, totalPayable: 0,
  };

  const rows = [];
  rows.push({ style: 'section', cells: ['Add: Service Provided'] });
  p.services.forEach(s => rows.push({ cells: [s.date, s.particular, s.taxable, s.vat, s.total, s.description] }));
  if (!p.services.length) rows.push({ style: 'subtle', cells: ['', 'No services in this period', null, null, null, ''] });
  rows.push({ style: 'total', cells: ['', 'Total Service Provided', null, null, p.totalService, ''] });

  rows.push({ style: 'section', cells: ['Add: Tax Paid on Behalf'] });
  p.taxes.forEach(t => rows.push({ cells: [t.date, t.particular, t.total, null, t.total, t.description] }));
  if (!p.taxes.length) rows.push({ style: 'subtle', cells: ['', 'No tax payments in this period', null, null, null, ''] });
  rows.push({ style: 'total', cells: ['', 'Total Tax Payment', null, null, p.totalTax, ''] });

  rows.push({ style: 'section', cells: ['Less: Payment'] });
  p.payments.forEach(x => rows.push({ cells: [x.date, x.particular, x.total, null, x.total, x.description] }));
  if (!p.payments.length) rows.push({ style: 'subtle', cells: ['', 'No payments received in this period', null, null, null, ''] });
  rows.push({ style: 'total', cells: ['', 'Total Payment', null, null, p.totalPayment, ''] });

  rows.push({ style: 'total', cells: ['', 'Net Payable', null, null, p.netPayable, ''] });
  rows.push({ cells: ['', `Opening Amount${p.openingAsOn ? ' as on ' + p.openingAsOn : ''}`, null, null, p.opening, ''] });
  rows.push({ style: 'grand', cells: ['', 'Total Payable', null, null, p.totalPayable, ''] });

  return {
    title: 'Party Ledger',
    subtitleLines: [fh.name, fh.address, p.name, p.address, p.pan ? 'PAN: ' + p.pan : '', plPeriodText(range)].filter(Boolean),
    columns: [
      { label: 'Date', w: 1.1, xw: 14 },
      { label: 'Particular', w: 2.4, xw: 34 },
      { label: 'Taxable Amount', w: 1.3, align: 'r', num: true, xw: 16 },
      { label: 'VAT', w: 1.0, align: 'r', num: true, xw: 14 },
      { label: 'Total', w: 1.3, align: 'r', num: true, xw: 16 },
      { label: 'Description', w: 2.2, xw: 34 },
    ],
    rows,
    landscape: true,
    _filename: `Party Ledger - ${p.name}`,
  };
}

function plModelPartyList() {
  const range = plRange();
  const fh = plFirmHeader();
  const parties = [...plBuildParties(plFirmKey(), range).values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = parties.map(p => ({
    cells: [p.name, p.pan || '', p.opening, p.totalService, p.totalTax, p.totalPayment, plPartyBalance(p)],
  }));
  const sum = f => parties.reduce((s, p) => s + f(p), 0);
  rows.push({
    style: 'grand',
    cells: ['Total', '', sum(p => p.opening), sum(p => p.totalService), sum(p => p.totalTax), sum(p => p.totalPayment), sum(p => plPartyBalance(p))],
  });

  return {
    title: 'Party List',
    subtitleLines: [fh.name, fh.address, plPeriodText(range)].filter(Boolean),
    columns: [
      { label: 'Party Name', w: 2.6, xw: 34 },
      { label: 'PAN', w: 1.1, xw: 14 },
      { label: 'Opening', w: 1.2, align: 'r', num: true, xw: 15 },
      { label: 'Work Performed Amount', w: 1.5, align: 'r', num: true, xw: 18 },
      { label: 'Tax Paid', w: 1.2, align: 'r', num: true, xw: 15 },
      { label: 'Payment Received', w: 1.4, align: 'r', num: true, xw: 17 },
      { label: 'Balance', w: 1.3, align: 'r', num: true, xw: 16 },
    ],
    rows,
    landscape: true,
    note: 'Balance = Opening + Work Performed + Tax Paid − Payment Received, and equals the Total Payable on that party\'s ledger.',
    _filename: 'Party List',
  };
}

function plModelExpenseLedger() {
  const range = plRange();
  const fh = plFirmHeader();
  const wanted = plNorm(plVal('pl-expense-name'));
  if (!wanted) return null;
  const rows0 = plExpenseRows(plFirmKey(), range).filter(r => plNorm(r.name) === wanted);
  const total = rows0.reduce((s, r) => s + r.amount, 0);
  const rows = rows0.map(r => ({ cells: [r.date, r.account, r.amount, r.description] }));
  rows.push({ style: 'grand', cells: ['', 'Total', total, ''] });

  return {
    title: 'Expenses Ledger',
    subtitleLines: [fh.name, fh.address, plVal('pl-expense-name'), plPeriodText(range)].filter(Boolean),
    columns: [
      { label: 'Date', w: 1.1, xw: 14 },
      { label: 'Particular', w: 2.6, xw: 36 },
      { label: 'Amount', w: 1.3, align: 'r', num: true, xw: 16 },
      { label: 'Description', w: 2.6, xw: 36 },
    ],
    rows,
    _filename: `Expenses Ledger - ${plVal('pl-expense-name')}`,
  };
}

function plModelExpenseList() {
  const range = plRange();
  const fh = plFirmHeader();
  const groups = plExpenseTotalsFor(plFirmKey(), range.from, range.to);
  const rows = groups.map(g => ({ cells: [g.name, g.amount] }));
  rows.push({ style: 'grand', cells: ['Total', groups.reduce((s, g) => s + g.amount, 0)] });

  return {
    title: 'Expenses List',
    subtitleLines: [fh.name, fh.address, plPeriodText(range)].filter(Boolean),
    columns: [
      { label: 'Expenses Name', w: 3, xw: 40 },
      { label: 'Amount', w: 1.3, align: 'r', num: true, xw: 18 },
    ],
    rows,
    _filename: 'Expenses List',
  };
}

// ── Render + export ──
function plGenerate() {
  const out = document.getElementById('pl-report-output');
  if (!out) return;
  const range = plRange();
  if (range.from && !NepaliLocale.isValidBsDate(range.from)) { out.innerHTML = '<div class="status-box status-info">From date must be a valid B.S. date (YYYY.MM.DD).</div>'; plSetExports(false); return; }
  if (range.to && !NepaliLocale.isValidBsDate(range.to)) { out.innerHTML = '<div class="status-box status-info">To date must be a valid B.S. date (YYYY.MM.DD).</div>'; plSetExports(false); return; }

  let model = null;
  if (plView === 'ledger') model = plModelLedger();
  else if (plView === 'partyList') model = plModelPartyList();
  else if (plView === 'expLedger') model = plModelExpenseLedger();
  else model = plModelExpenseList();

  if (!model) {
    out.innerHTML = `<div class="log-empty">${plView === 'ledger' ? 'Choose a client to see their ledger.' : 'Choose an expense name to see its ledger.'}</div>`;
    plLastModel = null; plSetExports(false); return;
  }
  plLastModel = model;
  out.innerHTML = ReportExport.toHtml(model);
  plSetExports(true);
}

function plSetExports(on) {
  ['pl-pdf-btn', 'pl-excel-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !on; });
}

async function plExport(kind) {
  if (!plLastModel) return;
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(plLastModel, kind, `${plLastModel._filename} - ${plFirm().name}.${ext}`, {
      module: 'partyLedger', clientName: plLastModel._filename, sheetName: PL_VIEWS[plView].title,
    });
  } catch (e) {
    plStatus('❌ Failed to export: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// Firm / period changed — every view depends on both.
function plOnContextChange() {
  if (plView === 'ledger') plLoadOpening();
  plGenerate();
}
