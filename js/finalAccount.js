// ════════════════════════════════════════════
//  FINAL ACCOUNT
//  The firm's own Income Statement and Balance Sheet for a period, assembled
//  entirely from figures the other Financial Management modules already hold.
//  Nothing is entered here and nothing is stored — it is a view over:
//
//    Income      ← Service Memo, grouped by Sub-Category/Category
//    Expenses    ← Bank Entry payments (particular = Expenses), grouped by name
//    Bank        ← Bank Entry accounts belonging to the firm
//    Receivables ← Party Ledger balances  (plReceivablesFor / plPartyBalance)
//    Sapati      ← Bank Entry sapati rows, netted per person
//
//  The Balance Sheet ends in a Net Difference row the workbook labels
//  "Always Zero": Net Income − Bank − Receivables − Sapati. That row is the
//  point of the module — it proves the four modules agree. It is shown, never
//  forced: a non-zero figure is a real finding (usually an opening balance
//  that hasn't been entered), so it renders in red rather than being hidden.
//
//  The Income Statement follows the firm selector; the Balance Sheet is drawn
//  with one column per audit firm side by side, exactly as the sheet lays it
//  out (FINAL_ACCOUNT_FIRM_KEYS in js/config.js).
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'finalAccount', group: 'main', buttonId: null, panelId: 'tab-finalAccount-panel' });

let faView = 'income';       // 'income' | 'balance'
let faLastModel = null;
let faInitDone = false;

function faStatus(html, type) { showStatus(html, type, 'fa-status-area'); }
function faVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function faFirmName(key) { const f = window.SERVICE_MEMO_FIRMS[key]; return f ? f.name : (key || '—'); }

// ── Entry point ──
// Reads through the Party Ledger's already-loaded state, so opening this tab
// refreshes that module first rather than keeping a second copy of the data.
async function faInit() {
  if (!faInitDone) {
    const sel = document.getElementById('fa-firm');
    sel.innerHTML = Object.values(window.SERVICE_MEMO_FIRMS)
      .map(f => `<option value="${escHtml(f.key)}">${escHtml(f.name)}</option>`).join('');
    const bs = NepaliLocale.todayBs();
    if (bs) {
      const startYear = bs.month >= 4 ? bs.year : bs.year - 1;
      document.getElementById('fa-from').value = `${startYear}.04.01`;
      document.getElementById('fa-to').value = NepaliLocale.todayBsStr();
    }
    faInitDone = true;
  }
  faStatus('<span class="spinner spinner-navy"></span> Loading…', 'searching');
  try {
    await plRefresh();                       // one source of ledger data for both modules
    document.getElementById('fa-status-area').innerHTML = '';
    faGenerate();
  } catch (e) {
    faStatus('❌ Failed to load: ' + escHtml(e.message || String(e)), 'error');
  }
}

function faShowView(name) {
  faView = name;
  ['income', 'balance'].forEach(v => {
    const b = document.getElementById('fa-tab-' + v);
    if (b) b.classList.toggle('active', v === name);
  });
  faGenerate();
}
function faPeriod() { return { from: faVal('fa-from'), to: faVal('fa-to') }; }
function faPeriodText() { const p = faPeriod(); return `From ${p.from || '(beginning)'} to ${p.to || '(to date)'}`; }

// ════════════════════════════════════════════
//  FIGURES  (all read through partyLedger.js state)
// ════════════════════════════════════════════
// Income: service memos for the firm in the period, grouped as the sheet
// writes them — "<Sub-Category>/<Category>".
function faIncomeGroups(firmKey) {
  const p = faPeriod();
  const range = plMakeRange(p.from, p.to);
  const map = new Map();
  plMemos.forEach(m => {
    if (m.firm_key !== firmKey) return;
    if (!plInRange(plMemoOrd(m), range)) return;
    const sub = (m.nature_subcategory === 'Others' || m.nature_category === 'Others') && m.nature_other
      ? m.nature_other : (m.nature_subcategory || 'Others');
    const label = `${sub}/${m.nature_category || 'Others'}`;
    map.set(label, (map.get(label) || 0) + Number(m.total_amount || 0));
  });
  return [...map.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => a.label.localeCompare(b.label));
}

// plExpenseTotalsFor returns { name, amount }; every block here is drawn from
// { label, amount }, so normalise on the way in.
function faExpenseGroups(firmKey) {
  const p = faPeriod();
  return plExpenseTotalsFor(firmKey, p.from, p.to).map(g => ({ label: g.name, amount: g.amount }));
}

function faNetIncome(firmKey) {
  const income = faIncomeGroups(firmKey).reduce((s, g) => s + g.amount, 0);
  const expense = faExpenseGroups(firmKey).reduce((s, g) => s + g.amount, 0);
  return { income, expense, net: income - expense };
}

// Bank balance per account, as at the period's To date (opening + everything
// up to that date — a balance-sheet figure is cumulative, not period-only).
function faBankAccounts(firmKey) {
  const toOrd = faVal('fa-to') ? NepaliLocale.bsDateOrd(faVal('fa-to')) : null;
  return plAccounts
    .filter(a => a.firm_key === firmKey)
    .map(a => {
      let bal = Number(a.opening_balance || 0);
      plTxns.forEach(t => {
        if (t.account_id !== a.id) return;
        const ord = NepaliLocale.bsDateOrd(t.txn_date);
        if (toOrd != null && ord != null && ord > toOrd) return;
        bal += (t.txn_type === 'receipt' ? 1 : -1) * Number(t.amount || 0);
      });
      return { label: `${a.account_name} — ${a.bank_name}`, amount: bal };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function faReceivables(firmKey) {
  const p = faPeriod();
  return plReceivablesFor(firmKey, p.from, p.to).map(r => ({ label: r.name, amount: r.balance }));
}

// Sapati, netted per person. The sheet's rule: a sapati RECEIVED shows as (−),
// a sapati PAID shows as (+) — i.e. what the firm is owed by that person.
function faSapati(firmKey) {
  const p = faPeriod();
  const range = plMakeRange(p.from, p.to);
  const accIds = plFirmAccountIds(firmKey);
  const map = new Map();
  plTxns.forEach(t => {
    if (t.particular !== 'sapati' || !accIds.has(t.account_id)) return;
    if (!plInRange(NepaliLocale.bsDateOrd(t.txn_date), range)) return;
    const name = (t.counterparty_name || 'Unnamed').trim();
    const k = name.toLowerCase();
    const signed = (t.txn_type === 'payment' ? 1 : -1) * Number(t.amount || 0);
    if (!map.has(k)) map.set(k, { label: name, amount: 0 });
    map.get(k).amount += signed;
  });
  return [...map.values()].filter(x => Math.abs(x.amount) > 0.005).sort((a, b) => a.label.localeCompare(b.label));
}

// ════════════════════════════════════════════
//  MODELS
// ════════════════════════════════════════════
function faModelIncome() {
  const firmKey = faVal('fa-firm');
  const inc = faIncomeGroups(firmKey);
  const exp = faExpenseGroups(firmKey);
  const t = faNetIncome(firmKey);
  const rows = [];

  rows.push({ style: 'total', cells: ['Income', t.income] });
  if (inc.length) inc.forEach(g => rows.push({ style: 'subtle', cells: [g.label, g.amount] }));
  else rows.push({ style: 'subtle', cells: ['No service memos in this period', null] });

  rows.push({ style: 'total', cells: ['Expenses', t.expense] });
  if (exp.length) exp.forEach(g => rows.push({ style: 'subtle', cells: [g.label, g.amount] }));
  else rows.push({ style: 'subtle', cells: ['No expenses in this period', null] });

  rows.push({ style: 'grand', cells: ['Net Income', t.net] });

  return {
    title: 'Income Statement',
    subtitleLines: [faFirmName(firmKey), faPeriodText()],
    columns: [{ label: 'Particular', w: 4, xw: 46 }, { label: 'Amount', w: 1.4, align: 'r', num: true, xw: 18 }],
    rows,
    note: 'Income is the total of Service Memos by sub-category; Expenses come from Bank Entry payments recorded as Expenses.',
    _filename: `Income Statement - ${faFirmName(firmKey)}`,
  };
}

// One block of a firm's Balance Sheet column: the rows plus its proof figure.
function faBalanceBlock(firmKey) {
  const net = faNetIncome(firmKey).net;
  const bank = faBankAccounts(firmKey);
  const recv = faReceivables(firmKey);
  const sap = faSapati(firmKey);
  const sum = list => list.reduce((s, x) => s + x.amount, 0);
  const bankT = sum(bank), recvT = sum(recv), sapT = sum(sap);
  return {
    firmKey, net, bank, recv, sap, bankT, recvT, sapT,
    diff: net - bankT - recvT - sapT,
  };
}

function faModelBalance() {
  const keys = window.FINAL_ACCOUNT_FIRM_KEYS.filter(k => window.SERVICE_MEMO_FIRMS[k]);
  const blocks = keys.map(faBalanceBlock);

  // Each firm is a Particular/Amount pair of columns, laid out side by side.
  const columns = [];
  blocks.forEach(() => {
    columns.push({ label: 'Particular', w: 2.6, xw: 34 });
    columns.push({ label: 'Amount', w: 1.3, align: 'r', num: true, xw: 16 });
  });

  // Build each firm's rows independently, then pad to the tallest so the two
  // columns stay aligned however different their account/party counts are.
  const perFirm = blocks.map(b => {
    const rows = [];
    const push = (label, amount, style) => rows.push({ label, amount, style });
    push('Net Income', b.net, 'total');
    push('', null);
    push('Bank Balance', b.bankT, 'total');
    if (b.bank.length) b.bank.forEach(x => push(x.label, x.amount, 'subtle'));
    else push('No accounts for this firm', null, 'subtle');
    push('', null);
    push('Total Receivables', b.recvT, 'total');
    if (b.recv.length) b.recv.forEach(x => push(x.label, x.amount, 'subtle'));
    else push('No outstanding parties', null, 'subtle');
    push('', null);
    push('Total Sapati', b.sapT, 'total');
    if (b.sap.length) b.sap.forEach(x => push(x.label, x.amount, 'subtle'));
    else push('No sapati outstanding', null, 'subtle');
    push('', null);
    push('Net Difference (always zero)', b.diff, 'grand');
    return rows;
  });

  const height = Math.max(...perFirm.map(r => r.length));
  const rows = [];
  // Firm-name banner row.
  rows.push({ style: 'section', cells: [blocks.map(b => faFirmName(b.firmKey)).join('     |     ')] });
  for (let i = 0; i < height; i++) {
    const cells = [];
    let style;
    const colors = [], pdfColors = [];
    perFirm.forEach((fr, fi) => {
      const r = fr[i];
      cells.push(r ? r.label : '', r ? r.amount : null);
      if (r && r.style && r.style !== 'subtle') style = r.style;
      // The proof figure is the one cell that carries its own colour.
      if (r && r.style === 'grand') {
        const ok = Math.abs(r.amount) < 0.005;
        // Literal hex, not a CSS var — this same HTML is reused in the
        // standalone print window, which has none of the app's variables.
        colors[fi * 2 + 1] = ok ? '#0F7B3C' : '#C81E1E';
        pdfColors[fi * 2 + 1] = ok ? PDFLib.rgb(0.05, 0.5, 0.24) : PDFLib.rgb(0.8, 0.1, 0.1);
      }
    });
    if (cells.every(c => c == null || c === '')) continue;      // skip padded blank rows
    // A row is only "subtle" when every firm's cell at this index is.
    const allSubtle = perFirm.every(fr => !fr[i] || fr[i].style === 'subtle');
    rows.push({ cells, style: style || (allSubtle ? 'subtle' : undefined), colors, pdfColors });
  }

  return {
    title: 'Balance Sheet',
    subtitleLines: [blocks.map(b => faFirmName(b.firmKey)).join('  ·  '), faPeriodText()],
    columns,
    rows,
    landscape: true,
    note: 'Net Difference = Net Income − Bank Balance − Total Receivables − Total Sapati, and reads zero when the period covers everything from the start. A party opening balance brought in from an earlier period has no matching income or bank movement inside this period, so it shows up here as a difference of exactly that amount — widen the period, or read the figure as the balance carried in.',
    _filename: 'Balance Sheet',
  };
}

// ── Render / export / print ──
function faGenerate() {
  const out = document.getElementById('fa-report-output');
  if (!out) return;
  const p = faPeriod();
  if (p.from && !NepaliLocale.isValidBsDate(p.from)) { out.innerHTML = '<div class="status-box status-info">From date must be a valid B.S. date (YYYY.MM.DD).</div>'; faSetExports(false); return; }
  if (p.to && !NepaliLocale.isValidBsDate(p.to)) { out.innerHTML = '<div class="status-box status-info">To date must be a valid B.S. date (YYYY.MM.DD).</div>'; faSetExports(false); return; }

  faLastModel = faView === 'income' ? faModelIncome() : faModelBalance();
  out.innerHTML = ReportExport.toHtml(faLastModel);
  faSetExports(true);
}
function faSetExports(on) {
  ['fa-pdf-btn', 'fa-excel-btn', 'fa-print-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !on; });
}

async function faExport(kind) {
  // The report model itself bakes PDFLib.rgb colours in, whichever kind runs.
  await LibLoader.ensure('pdflib');
  if (!faLastModel) return;
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(faLastModel, kind, `${faLastModel._filename}.${ext}`, {
      module: 'finalAccount', clientName: faLastModel._filename, sheetName: faLastModel.title,
    });
  } catch (e) {
    faStatus('❌ Failed to export: ' + escHtml(e.message || String(e)), 'error');
  }
}

// The sheet's "Save/Print" — a standalone print window, same approach as the
// Report Builder's PDF export (js/report.js).
function faPrint() {
  if (!faLastModel) return;
  const w = window.open('', '_blank');
  if (!w) { faStatus('Allow pop-ups to print this statement.', 'info'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(faLastModel.title)}</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 28px; color: #1a202c; }
      table { border-collapse: collapse; width: 100%; font-size: 12px; }
      th, td { border: 1px solid #d9dce5; padding: 5px 8px; }
      th { background: #f3f5fb; color: #0b1f3d; }
      @page { size: ${faLastModel.landscape ? 'A4 landscape' : 'A4'}; margin: 14mm; }
    </style></head><body>${ReportExport.toHtml(faLastModel)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('final_account_printed', { module: 'finalAccount', detail: { view: faView } });
}
