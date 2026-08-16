// ════════════════════════════════════════════
//  AUTOBOOKS — ANNEXURE-13
//
//  The tax annexure the whole ≥/< 1 lakh tiering exists for. One row per PAN,
//  combining what the client BOUGHT from that party and SOLD to it, split into
//  the six buckets the template's own header row names:
//
//    PAN · TradeName · OpeningBalance
//    · ServicePurchaseCapital · ServicePurchaseOthers
//    · GoodPurchaseCapital    · GoodPurchaseOthers
//    · ServiceSales           · GoodSales
//    · ClosingBalance
//
//  ONE ROW PER PAN, NOT PER PARTY. A party can be both customer and supplier —
//  the reference file's PURCHASE CONFIRMATION sheet carries a "Sale Taxable"
//  column for exactly that case (Party J: purchased 575,575.50, sold
//  96,404). The annexure is keyed on the tax ID, so the two sides meet on one
//  line. It follows that a party with NO PAN cannot be reported at all — those
//  are excluded and listed loudly rather than dropped.
//
//  ONLY THE ≥ 1 LAKH TIER (user decision, 2026-08-16). A PAN qualifies if
//  EITHER of its sides reaches the threshold, since a party can be a large
//  supplier and a trivial customer. The rest stay one checkbox away.
// ════════════════════════════════════════════

// The four purchase buckets are two independent axes, and only one of them is
// a question for a human:
//
//  · Goods vs Service — a property of what the party supplies. Asked.
//  · Capital vs Others — a property of the BILL, and Autobooks already reads a
//    "Capital Purchase" column into `cap` (§ Taxable Import and Capital
//    Purchase). Asking a user to re-classify a party whose own book already
//    says which rupees were capital would be guesswork on top of fact, so this
//    axis is DERIVED. A book with no capital column simply lands everything in
//    Others, which is correct.
//
//  Sales has no capital dimension — the annexure has no ServiceSalesCapital.
const SPB_ANN13_KINDS = [
  { value: 'goods',   label: 'Goods' },
  { value: 'service', label: 'Service' },
];
const SPB_ANN13_DEFAULT = 'goods';   // -> GoodSales / GoodPurchaseOthers

const SPB_ANN13_BUCKETS = [
  { key: 'ServicePurchaseCapital', label: 'Service Purchase — Capital' },
  { key: 'ServicePurchaseOthers',  label: 'Service Purchase — Others' },
  { key: 'GoodPurchaseCapital',    label: 'Good Purchase — Capital' },
  { key: 'GoodPurchaseOthers',     label: 'Good Purchase — Others' },
  { key: 'ServiceSales',           label: 'Service Sales' },
  { key: 'GoodSales',              label: 'Good Sales' },
];

let spbAnnIncludeBelow = false;
let spbAnnSearch = '';
let spbAnnRows = [];
let spbAnnExcluded = [];

function spbAnnStatus(html, type) { showStatus(html, type, 'spb-ann-status'); }

function spbAnnKind(r) {
  return r && r.ann13 === 'service' ? 'service' : SPB_ANN13_DEFAULT;
}

// ── The model ───────────────────────────────────────────────────────────────
function spbAnn13Build() {
  const bySection = {
    sales: (spbGroups && spbGroups.sales) || spbOmitted.some(x => x.section === 'sales') ? spbConfirmRows('sales') : [],
    purchase: (spbGroups && spbGroups.purchase) || spbOmitted.some(x => x.section === 'purchase') ? spbConfirmRows('purchase') : [],
  };

  const byPan = new Map();
  const excluded = [];
  SPB_SECTIONS.forEach(({ key }) => {
    bySection[key].forEach(r => {
      const pan = spbNormPan(r.pan);
      // A well-formed 9-digit PAN is the annexure's only key. A blank or
      // malformed one is not a reporting decision to make silently — the
      // party is set aside and named.
      if (!spbIsValidPan(pan)) {
        if (r.taxable !== 0) excluded.push({ section: key, name: r.name, pan: r.pan || '', taxable: r.taxable, reason: r.pan ? 'PAN is not 9 digits' : 'No PAN recorded' });
        return;
      }
      if (!byPan.has(pan)) {
        byPan.set(pan, {
          pan, names: new Map(), opening: 0, closing: 0, hasOpening: false, hasClosing: false,
          // LISTS, not a single row. One PAN can cover several party groups —
          // a merge not yet applied, or two spellings, or (in the reference
          // file) a mistyped PAN. Holding one row per side dropped everything
          // but the last one, and since `qualifies` keys off these totals a
          // Rs 32.2M line silently fell off the annexure entirely.
          salesRows: [], purchaseRows: [],
          salesTaxable: 0, purchaseTaxable: 0, purchaseCapital: 0,
          ...SPB_ANN13_BUCKETS.reduce((a, b) => (a[b.key] = 0, a), {}),
        });
      }
      const a = byPan.get(pan);
      // Weighted by VALUE, not by how many groups carry the spelling. Under
      // one PAN the reference file has "Party A" (Rs 31.9M) and
      // "Party D" (Rs 25,221) — a typo. A count tie broken on
      // name length picked the wrong one, which would file an annexure line
      // for Rs 32.2M under a company that contributed 0.08% of it.
      a.names.set(r.name, (a.names.get(r.name) || 0) + Math.abs(r.taxable));
      a[key + 'Rows'].push(r);
      a[key + 'Taxable'] += r.taxable;

      // Opening / closing are ledger balances. A PAN trading on BOTH sides has
      // two of them (a receivable and a payable); they are summed, and the row
      // is marked so the figure is never mistaken for a single-ledger balance.
      if (r.opening != null) { a.opening += r.opening; a.hasOpening = true; }
      if (r.closing != null) { a.closing += r.closing; a.hasClosing = true; }

      // Capital is a slice OF taxable, not an addition to it (§ Capital is
      // entered separately but filed inside Taxable Purchase) — so Others is
      // the remainder, never the whole.
      const kind = spbAnnKind(r) === 'service' ? 'Service' : 'Good';
      if (key === 'sales') {
        a[kind + 'Sales'] += r.taxable;
      } else {
        const cap = Math.min(r.capital || 0, r.taxable);
        a.purchaseCapital += cap;
        a[kind + 'PurchaseCapital'] += cap;
        a[kind + 'PurchaseOthers'] += r.taxable - cap;
      }
    });
  });

  const rows = Array.from(byPan.values());
  rows.forEach(a => {
    a.name = Array.from(a.names.entries()).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
    // One PAN over several party names is either a genuine spelling variation
    // or a typo that has quietly merged two companies onto one annexure line.
    // Either way the user has to see it before this is filed.
    a.multiName = a.names.size > 1
      ? Array.from(a.names.entries()).sort((x, y) => y[1] - x[1]).map(e => e[0]) : null;
    a.sales = a.salesRows.length > 0;
    a.purchase = a.purchaseRows.length > 0;
    a.total = SPB_ANN13_BUCKETS.reduce((s, b) => s + a[b.key], 0);
    // Either side reaching the threshold qualifies the PAN: a party can be a
    // large supplier and a trivial customer, and dropping the small side would
    // under-report the line.
    a.qualifies = a.salesTaxable >= SPB_CONFIRM_TIER || a.purchaseTaxable >= SPB_CONFIRM_TIER;
  });
  rows.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
  excluded.sort((a, b) => Math.abs(b.taxable) - Math.abs(a.taxable));
  return { rows, excluded };
}

function spbAnnVisible() {
  const q = spbAnnSearch.trim().toUpperCase();
  return spbAnnRows.filter(a =>
    (spbAnnIncludeBelow || a.qualifies) &&
    (!q || a.name.toUpperCase().includes(q) || a.pan.includes(q)));
}

function spbAnnTotals(rows) {
  const t = { opening: 0, closing: 0, total: 0 };
  SPB_ANN13_BUCKETS.forEach(b => { t[b.key] = 0; });
  rows.forEach(a => {
    t.opening += a.opening; t.closing += a.closing; t.total += a.total;
    SPB_ANN13_BUCKETS.forEach(b => { t[b.key] += a[b.key]; });
  });
  return t;
}

// ── Category ────────────────────────────────────────────────────────────────
// Stored per (book, section, party) in autobooks_parties.ann13_category. One
// PAN can cover several party keys (a merge not yet applied, or two spellings),
// so setting a category writes every row under that PAN on that side.
async function spbAnnSetKind(pan, section, value) {
  const a = spbAnnRows.find(x => x.pan === pan);
  if (!a || !a[section + 'Rows'].length || !spbBookId) return;
  const keys = spbConfirmRows(section).filter(r => spbNormPan(r.pan) === pan).map(r => ({ key: r.key, name: r.name }));
  try {
    for (const k of keys) {
      const led = spbLedgerParties[section + '|' + k.key];
      if (led && led.id) {
        const { error } = await window.sb.from('autobooks_parties')
          .update({ ann13_category: value }).eq('id', led.id);
        if (error) throw error;
        led.ann13_category = value;
      } else {
        const { data, error } = await window.sb.from('autobooks_parties').insert({
          book_id: spbBookId, section, party_key: k.key, party_name: k.name,
          pan, ann13_category: value,
          updated_by: (window.currentUser && window.currentUser.email) || null,
        }).select().limit(1);
        if (error) throw error;
        if (data && data[0]) spbLedgerParties[section + '|' + k.key] = data[0];
      }
    }
    spbRenderAnn13Table();
  } catch (err) {
    console.error('[Autobooks] annexure category save failed', err);
    spbAnnStatus('❌ Could not save that category: ' + escHtml(err.message || String(err)), 'error');
  }
}

// ── Opening balances from a sheet ───────────────────────────────────────────
// The template's own "Upload opening balance of F.Y for Ann-13". The
// carry-forward in the Confirmation tab covers a client the firm has run
// through this app before; a client's FIRST year here has no prior book, and
// typing two hundred opening balances by hand is exactly the work being
// replaced. Matched on PAN, and — like the carry-forward — it only ever FILLS
// a blank.
function spbAnnImportOpenings(input) {
  const file = (input.files || [])[0];
  if (!file) return;
  input.value = '';
  spbAnnStatus('⏳ Reading ' + escHtml(file.name) + '…', 'searching');
  const reader = new FileReader();
  reader.onerror = () => spbAnnStatus('❌ The browser could not read that file.', 'error');
  reader.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const found = spbAnnFindOpeningCols(rows);
      if (!found) {
        spbAnnStatus('❌ Could not find a PAN column and an opening-balance column in "' +
          escHtml(wb.SheetNames[0]) + '". The sheet needs a header row naming both.', 'error');
        return;
      }
      await spbAnnApplyOpenings(rows, found);
    } catch (err) {
      console.error('[Autobooks] opening-balance import failed', err);
      spbAnnStatus('❌ Could not read that file: ' + escHtml(err.message || String(err)), 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function spbAnnFindOpeningCols(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i] || [];
    let pan = null, amt = null;
    r.forEach((cell, c) => {
      const h = String(cell == null ? '' : cell).trim().toLowerCase();
      if (!h) return;
      if (pan == null && /\bpan\b|pan\s*no/.test(h)) pan = c;
      if (amt == null && /opening/.test(h)) amt = c;
    });
    if (pan != null && amt != null) return { row: i, pan, amt };
  }
  return null;
}

async function spbAnnApplyOpenings(rows, found) {
  const wanted = new Map();
  for (let i = found.row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const pan = spbNormPan(r[found.pan]);
    if (!spbIsValidPan(pan)) continue;
    const v = spbNum(r[found.amt]);
    if (!wanted.has(pan)) wanted.set(pan, v);
  }
  if (!wanted.size) { spbAnnStatus('❌ No rows with a 9-digit PAN were found in that sheet.', 'error'); return; }

  let filled = 0, skipped = 0, unmatched = 0;
  const cfRows = { sales: spbConfirmRows('sales'), purchase: spbConfirmRows('purchase') };
  for (const [pan, amount] of wanted) {
    let hit = false;
    for (const section of ['sales', 'purchase']) {
      for (const r of cfRows[section]) {
        if (spbNormPan(r.pan) !== pan) continue;
        hit = true;
        if (r.opening != null) { skipped++; continue; }
        await spbAnnWriteOpening(section, r, amount);
        filled++;
      }
    }
    if (!hit) unmatched++;
  }
  spbRenderAnn13();
  AuditLog.record('spb_openings_imported', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), filled, skipped, unmatched },
  });
  spbAnnStatus(`✅ Filled ${filled} opening balance${filled === 1 ? '' : 's'} from the sheet.` +
    (skipped ? ` ${skipped} already had one and were left alone.` : '') +
    (unmatched ? ` ${unmatched} PAN(s) in the sheet aren't in this book.` : ''), filled ? 'success' : 'info');
}

async function spbAnnWriteOpening(section, r, amount) {
  const led = spbLedgerParties[section + '|' + r.key];
  if (led && led.id) {
    const { error } = await window.sb.from('autobooks_parties')
      .update({ opening_balance: amount }).eq('id', led.id);
    if (error) throw error;
    led.opening_balance = amount;
    return;
  }
  const { data, error } = await window.sb.from('autobooks_parties').insert({
    book_id: spbBookId, section, party_key: r.key, party_name: r.name,
    pan: r.pan || null, opening_balance: amount,
    updated_by: (window.currentUser && window.currentUser.email) || null,
  }).select().limit(1);
  if (error) throw error;
  if (data && data[0]) spbLedgerParties[section + '|' + r.key] = data[0];
}

// ── Screen ──────────────────────────────────────────────────────────────────
function spbRenderAnn13() {
  const el = document.getElementById('spb-ann-body');
  if (!el) return;
  if (!spbBookId) {
    el.innerHTML = spbSaveGateHtml('The annexure reads the confirmation ledger, which is');
    return;
  }
  if (!spbGroups || (!spbGroups.sales && !spbGroups.purchase)) {
    el.innerHTML = '<p class="log-empty">No parties yet — import a book first.</p>';
    return;
  }
  el.innerHTML = `
    <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px;">
      <div class="form-group" style="margin:0; min-width:220px;">
        <label>Search party or PAN</label>
        <input type="text" id="spb-ann-q" value="${escHtml(spbAnnSearch)}" placeholder="Type to filter…"
               oninput="spbAnnSearch=this.value; spbRenderAnn13Table();" />
      </div>
      <label style="display:flex; align-items:center; gap:7px; font-size:13px; padding-bottom:9px;">
        <input type="checkbox" id="spb-ann-below" ${spbAnnIncludeBelow ? 'checked' : ''}
               onchange="spbAnnIncludeBelow=this.checked; spbRenderAnn13Table();" />
        Include parties below Rs ${spbFmt(SPB_CONFIRM_TIER)}
      </label>
      <input type="file" id="spb-ann-open-file" accept=".xlsx,.xls,.csv,.ods" style="display:none;" onchange="spbAnnImportOpenings(this)" />
      <button class="btn btn-outline btn-sm" onclick="document.getElementById('spb-ann-open-file').click()">Upload opening balances</button>
      <button class="btn btn-outline btn-sm" onclick="spbPrintAnn13()">Print / Preview</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportAnn13('pdf')">Export PDF</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportAnn13('excel')">Export Excel</button>
    </div>
    <div id="spb-ann-status"></div>
    <div id="spb-ann-table"></div>`;
  spbRenderAnn13Table();
}

function spbRenderAnn13Table() {
  const host = document.getElementById('spb-ann-table');
  if (!host) return;
  const built = spbAnn13Build();
  spbAnnRows = built.rows; spbAnnExcluded = built.excluded;
  const visible = spbAnnVisible();
  const t = spbAnnTotals(visible);
  const below = spbAnnRows.filter(a => !a.qualifies).length;

  let html = `<div class="log-sub" style="margin-bottom:14px;">
    <span class="log-badge badge-blue">${visible.length} PAN${visible.length === 1 ? '' : 's'} on the annexure</span>
    ${below && !spbAnnIncludeBelow ? `<span class="log-badge badge-neutral" style="margin-left:6px;">${below} below Rs ${spbFmt(SPB_CONFIRM_TIER)}, excluded</span>` : ''}
    ${spbAnnExcluded.length ? `<span class="log-badge badge-error" style="margin-left:6px;">${spbAnnExcluded.length} cannot be reported</span>` : ''}
    <br>One row per PAN, combining what was bought from and sold to that party. Amounts are taxable value including omitted bills; Capital is the slice of it the book's own Capital Purchase column carries.
  </div>`;

  if (spbAnnExcluded.length) {
    // A party with no usable PAN cannot go on a PAN-keyed annexure. Saying so,
    // with the amount at stake, is the difference between a known omission and
    // a silent one.
    html += `<div class="card" style="background:var(--red-bg); border-color:var(--red-border); margin-bottom:16px;">
      <div style="font-weight:700; color:var(--red-dk); margin-bottom:8px;">
        ${spbAnnExcluded.length} part${spbAnnExcluded.length === 1 ? 'y' : 'ies'} cannot be put on the annexure</div>
      <div class="log-sub" style="margin-bottom:10px;">Annexure-13 is keyed on PAN. Fix the PAN in <strong>Import › Data Doctor</strong> and it will appear here.</div>
      <div class="table-wrap" style="overflow-x:auto;"><table class="client-table" style="font-size:12px;">
        <thead><tr><th>Register</th><th>Party</th><th>PAN as entered</th><th style="text-align:right;">Taxable</th><th>Why</th></tr></thead><tbody>
        ${spbAnnExcluded.slice(0, 40).map(x => `<tr><td>${escHtml(x.section === 'sales' ? 'Sales' : 'Purchase')}</td>
          <td>${escHtml(x.name)}</td><td>${escHtml(x.pan || '—')}</td>
          <td style="text-align:right;">${spbFmt(x.taxable)}</td><td>${escHtml(x.reason)}</td></tr>`).join('')}
      </tbody></table></div>
      ${spbAnnExcluded.length > 40 ? `<div class="log-sub" style="margin-top:8px;">…and ${spbAnnExcluded.length - 40} more.</div>` : ''}
    </div>`;
  }

  html += `<div class="table-wrap" style="overflow-x:auto;"><table class="client-table spb-cf-table" style="font-size:12px;">
    <thead><tr>
      <th>PAN</th><th>Trade Name</th>
      <th style="text-align:right;">Opening Balance</th>
      <th>Purchase</th><th style="text-align:right;">Purchase Taxable</th>
      <th>Sales</th><th style="text-align:right;">Sales Taxable</th>
      ${SPB_ANN13_BUCKETS.map(b => `<th style="text-align:right;">${escHtml(b.label)}</th>`).join('')}
      <th style="text-align:right;">Closing Balance</th>
    </tr></thead><tbody>`;

  if (!visible.length) {
    html += `<tr><td colspan="${9 + SPB_ANN13_BUCKETS.length}" style="text-align:center; color:var(--text-muted); padding:22px;">No parties match the current filter.</td></tr>`;
  }

  visible.forEach(a => {
    const sel = (section) => {
      const list = a[section + 'Rows'];
      if (!list.length) return '<span style="color:var(--text-muted);">—</span>';
      const cur = spbAnnKind(list[0]);
      return `<select class="spb-ann-kind" onchange="spbAnnSetKind('${escHtml(a.pan)}', '${section}', this.value)">
        ${SPB_ANN13_KINDS.map(k => `<option value="${k.value}"${k.value === cur ? ' selected' : ''}>${escHtml(k.label)}</option>`).join('')}
      </select>`;
    };
    const cap = a.purchaseCapital;
    html += `<tr>
      <td style="white-space:nowrap;">${escHtml(a.pan)}</td>
      <td><div style="font-weight:600;">${escHtml(a.name)}</div>
        ${a.multiName ? `<div style="font-size:11px; color:var(--amber-dk);">One PAN, ${a.multiName.length} names — also entered as: ${escHtml(a.multiName.filter(n => n !== a.name).join(', '))}. Check this before filing.</div>` : ''}
        ${a.sales && a.purchase ? '<div style="font-size:11px; color:var(--text-muted);">Both customer and supplier</div>' : ''}
        ${!a.qualifies ? `<div style="font-size:11px; color:var(--text-muted);">Below Rs ${spbFmt(SPB_CONFIRM_TIER)}</div>` : ''}</td>
      <td style="text-align:right;">${a.hasOpening ? spbFmt(a.opening) : '—'}</td>
      <td>${sel('purchase')}</td>
      <td style="text-align:right;">${a.purchase ? spbFmt(a.purchaseTaxable) : '—'}${cap ? `<div style="font-size:11px; color:var(--text-muted);">of which capital ${spbFmt(cap)}</div>` : ''}</td>
      <td>${sel('sales')}</td>
      <td style="text-align:right;">${a.sales ? spbFmt(a.salesTaxable) : '—'}</td>
      ${SPB_ANN13_BUCKETS.map(b => `<td style="text-align:right;${a[b.key] ? '' : 'color:var(--text-muted);'}">${a[b.key] ? spbFmt(a[b.key]) : '—'}</td>`).join('')}
      <td style="text-align:right;">${a.hasClosing ? spbFmt(a.closing) : '—'}</td>
    </tr>`;
  });

  html += `<tr style="background:var(--amber-bg); color:var(--amber-dk); font-weight:800;">
    <td colspan="2">Total — ${visible.length} PAN${visible.length === 1 ? '' : 's'}</td>
    <td style="text-align:right;">${spbFmt(t.opening)}</td>
    <td></td><td style="text-align:right;">${spbFmt(visible.reduce((s, a) => s + a.purchaseTaxable, 0))}</td>
    <td></td><td style="text-align:right;">${spbFmt(visible.reduce((s, a) => s + a.salesTaxable, 0))}</td>
    ${SPB_ANN13_BUCKETS.map(b => `<td style="text-align:right;">${spbFmt(t[b.key])}</td>`).join('')}
    <td style="text-align:right;">${spbFmt(t.closing)}</td>
  </tr></tbody></table></div>`;
  host.innerHTML = html;
}

// ── The annexure itself ─────────────────────────────────────────────────────
// Exactly the template's ten columns, in the template's order — this is the
// sheet that gets filed, so it carries no extra working columns.
function spbAnn13Model() {
  const visible = spbAnnVisible();
  const t = spbAnnTotals(visible);
  const columns = [
    { label: 'PAN', align: 'l', w: 10 },
    { label: 'TradeName', align: 'l', w: 24 },
    { label: 'OpeningBalance', align: 'r', num: true, w: 11 },
    ...SPB_ANN13_BUCKETS.map(b => ({ label: b.key, align: 'r', num: true, w: 12 })),
    { label: 'ClosingBalance', align: 'r', num: true, w: 11 },
  ];
  const rows = visible.map(a => ({
    cells: [a.pan, a.name, a.hasOpening ? a.opening : null,
      ...SPB_ANN13_BUCKETS.map(b => a[b.key] || null),
      a.hasClosing ? a.closing : null],
  }));
  rows.push({
    cells: ['', 'Total', t.opening, ...SPB_ANN13_BUCKETS.map(b => t[b.key]), t.closing],
    style: 'grand',
  });
  return {
    title: 'Annexure-13',
    subtitleLines: [
      spbVal('spb-company') + (spbVal('spb-pan') ? '  ·  PAN ' + spbVal('spb-pan') : ''),
      'F.Y. ' + spbVal('spb-fy'),
      spbAnnIncludeBelow
        ? 'All parties with a valid PAN.'
        : `Parties transacting Rs ${spbFmt(SPB_CONFIRM_TIER)} or more on either side.`,
    ],
    columns, rows, landscape: true,
    note: spbAnnExcluded.length
      ? `${spbAnnExcluded.length} part(y/ies) are not listed because their PAN is missing or not 9 digits.`
      : '',
  };
}

function spbPrintAnn13() {
  const visible = spbAnnVisible();
  if (!visible.length) return;
  const t = spbAnnTotals(visible);
  let body = `<table><thead><tr>
    <th>PAN</th><th>TradeName</th><th style="text-align:right;">OpeningBalance</th>
    ${SPB_ANN13_BUCKETS.map(b => `<th style="text-align:right;">${escHtml(b.key)}</th>`).join('')}
    <th style="text-align:right;">ClosingBalance</th></tr></thead><tbody>`;
  visible.forEach(a => {
    body += `<tr><td>${escHtml(a.pan)}</td><td>${escHtml(a.name)}</td>
      <td style="text-align:right;">${a.hasOpening ? spbFmt(a.opening) : '–'}</td>
      ${SPB_ANN13_BUCKETS.map(b => `<td style="text-align:right;">${a[b.key] ? spbFmt(a[b.key]) : '–'}</td>`).join('')}
      <td style="text-align:right;">${a.hasClosing ? spbFmt(a.closing) : '–'}</td></tr>`;
  });
  body += `<tr style="background:#fffbe6; font-weight:700;"><td colspan="2">Total</td>
    <td style="text-align:right;">${spbFmt(t.opening)}</td>
    ${SPB_ANN13_BUCKETS.map(b => `<td style="text-align:right;">${spbFmt(t[b.key])}</td>`).join('')}
    <td style="text-align:right;">${spbFmt(t.closing)}</td></tr></tbody></table>`;
  if (spbAnnExcluded.length) {
    body += `<p style="font-size:11px; margin-top:10px;"><strong>Note:</strong> ${spbAnnExcluded.length}
      part(y/ies) are not listed because their PAN is missing or not 9 digits.</p>`;
  }
  spbOpenPrint(spbPrintDoc('Annexure-13',
    `F.Y. ${spbVal('spb-fy')} · ${spbAnnIncludeBelow ? 'all parties with a valid PAN' : 'Rs ' + spbFmt(SPB_CONFIRM_TIER) + ' and above'}`, body));
  AuditLog.record('spb_ann13_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), pans: visible.length, excluded: spbAnnExcluded.length },
  });
}

async function spbExportAnn13(kind) {
  if (!spbAnnVisible().length) return;
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(spbAnn13Model(), kind,
      `Annexure-13 - ${spbVal('spb-company')} ${spbVal('spb-fy')}.${ext}`,
      { module: 'salesPurchaseBook', clientName: spbVal('spb-company'), sheetName: 'Ann-13' });
    spbAnnStatus('✅ Exported.', 'success');
  } catch (err) {
    console.error('[Autobooks] annexure export failed', err);
    spbAnnStatus('❌ Could not export: ' + escHtml(err.message || String(err)), 'error');
  }
}

// ── Registration ──
SPB_SECTION_TABS.push({ key: 'ann13', label: 'Annexure-13', panel: 'spb-sec-ann13', onShow: 'spbRenderAnn13' });
spbRenderSectionNav();
