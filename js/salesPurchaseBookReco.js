// ════════════════════════════════════════════
//  AUTOBOOKS — RECONCILIATION STATEMENT
//
//  The year-end statement that proves the filed VAT returns and the books tell
//  the same story, and names every reason they don't. Three of them — Sales,
//  Purchase, VAT — each laid out the way the firm's own Reco sheet is:
//
//      <X> as Per Maskebari                      (the filed return)
//      Add:   … reasons the return is short
//      Less:  … reasons the return is over
//      Less:  Rounding Effect
//      <X> as Per Maskebari After Adjustment
//      <X> as Per Accounts                       (the books)
//      Net Difference
//
//  It runs FROM the return TO the books, so every adjustment is
//  BOOK − RETURN. Verified against the reference sheet: its Ashadh line of
//  87,710.14 is book 887,710.14 less return 800,000, and its Jestha line of
//  −50,000 is book 200,000 less return 250,000. Note this is the opposite sign
//  to the Monthly grid, which prints a uniform Return − Book difference — each
//  is internally consistent and neither is being changed (CLAUDE.md §8).
//
//  DISTINCT FROM the Monthly grid, which compares month by month. This is one
//  statement for the year, with ad-hoc adjustment lines, because which mistakes
//  exist varies per client and per year — nothing here is hardcoded to a month.
// ════════════════════════════════════════════

// "if Difference is less than 1000 then round off Difference" — the sheet's own
// note. At or above a thousand rupees it is not a rounding effect, it is a real
// unexplained difference, and it stays on the face of the statement.
const SPB_RECO_ROUNDING_LIMIT = 1000;

const SPB_RECO_STATEMENTS = [
  { key: 'sales', title: 'Sales Reconciliation Statement',
    retLabel: 'Sales as Per Maskebari', bookLabel: 'Sales as Per Accounts', section: 'sales' },
  { key: 'purchase', title: 'Purchase Reconciliation Statement',
    retLabel: 'Purchase as Per Maskebari', bookLabel: 'Purchase as Per Accounts', section: 'purchase' },
  { key: 'vat', title: 'VAT Reconciliation Statement',
    retLabel: 'VAT Payable as per Return', bookLabel: 'VAT Payable as Per Books', section: null },
];

function spbRecoStatus(html, type) { showStatus(html, type, 'spb-reco-status'); }

// ── Anchors ─────────────────────────────────────────────────────────────────
// Both ends are DERIVED, never typed. The return figure is the one already
// entered in the Monthly reconciliation grid (and stored on the book); the
// books figure is computed from the register. Giving either an override would
// create a second source of truth for a number this app already holds — and an
// adjustment line is the correct way to say "the real figure differs, here is
// why", which is what the statement is for.
function spbRecoAnchors(st) {
  const vr = spbVr || spbBlankVr();
  const book = spbBook || {};
  let ret = 0, books = 0, retTyped = false;

  if (st.key === 'vat') {
    SPB_SECTIONS.forEach(({ key }) => {
      const sign = key === 'sales' ? 1 : -1;   // VAT payable = output − input
      (vr[key] || []).forEach(m => {
        const v = spbReturnVat({ v: spbNum(m.v), capVat: spbNum(m.capVat) }) + spbNum(m.impVat);
        if (String(m.v).trim() !== '') retTyped = true;
        ret += sign * v;
      });
      (book[key] || []).forEach(m => {
        books += sign * ((m.v || 0) + (m.capVat || 0) + (m.impVat || 0));
      });
      // The VAT on omitted bills is booked too. Leaving it out here while the
      // automatic line below subtracts it from the RETURN side meant the two
      // ends of this statement were built differently, and it could never foot
      // — the Sales and Purchase statements already add their omitted figure
      // to books for exactly this reason.
      books += sign * spbRecoOmittedVat(key);
    });
  } else {
    const k = st.section;
    (vr[k] || []).forEach(m => {
      if (String(m.t).trim() !== '' || String(m.f).trim() !== '') retTyped = true;
      ret += spbReturnTaxable({ t: spbNum(m.t), cap: spbNum(m.cap) }) + spbNum(m.f) + spbNum(m.imp);
    });
    (book[k] || []).forEach(m => { books += m.t + m.f + (m.imp || 0); });
    // The books include bills entered after the register was closed — they are
    // booked, they are simply not in the filed return. That is precisely what
    // the "omitted in Maskebari" line below adds back on the return side.
    books += spbRecoOmitted(k);
  }
  return { ret, books, retTyped };
}

// Net effect of this register's omitted bills, signed (a return or debit note
// subtracts). Derived, never a stored adjustment — a figure copied out of the
// Omitted Bills screen would drift the moment one was edited there.
function spbRecoOmitted(section) {
  return spbOmitted.filter(x => x.section === section)
    .reduce((a, x) => a + (x.taxable || 0) * spbOmittedSign(x) + (x.taxfree || 0) * spbOmittedSign(x), 0);
}

function spbRecoOmittedVat(section) {
  return spbOmitted.filter(x => x.section === section)
    .reduce((a, x) => a + (x.vat || 0) * spbOmittedSign(x), 0);
}

// ── The statement ───────────────────────────────────────────────────────────
function spbRecoModel(st) {
  const { ret, books, retTyped } = spbRecoAnchors(st);
  const auto = [], adds = [], lessers = [];

  // Automatic lines: things the app already knows, shown as lines rather than
  // silently folded into an anchor, so the statement explains itself.
  if (st.key === 'vat') {
    SPB_SECTIONS.forEach(({ key, label }) => {
      const v = spbRecoOmittedVat(key) * (key === 'sales' ? 1 : -1);
      if (v) auto.push({ label: `VAT on ${label.toLowerCase()} bills omitted in Maskebari`, amount: v });
    });
  } else {
    const om = spbRecoOmitted(st.section);
    if (om) auto.push({ label: `${st.section === 'sales' ? 'Sales' : 'Purchase'} omitted in Maskebari`, amount: om });
  }

  spbAdjustments.filter(a => a.statement === st.key)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .forEach(a => (a.direction === 'add' ? adds : lessers).push(a));

  const autoTotal = auto.reduce((s, l) => s + l.amount, 0);
  const addTotal = adds.reduce((s, a) => s + Number(a.amount || 0), 0);
  const lessTotal = lessers.reduce((s, a) => s + Number(a.amount || 0), 0);

  const adjusted = ret + autoTotal + addTotal - lessTotal;
  const residual = books - adjusted;
  // Under a thousand rupees it is rounding and is absorbed; at or above it is a
  // real difference and is reported. Never silently absorbed either way.
  const rounding = Math.abs(residual) < SPB_RECO_ROUNDING_LIMIT ? residual : 0;
  const after = adjusted + rounding;

  return {
    st, ret, books, retTyped, auto, adds, lessers,
    autoTotal, addTotal, lessTotal, adjusted, rounding, after,
    net: books - after,
    absorbed: rounding !== 0,
    unexplained: Math.abs(books - after) >= SPB_RECO_ROUNDING_LIMIT,
  };
}

// ── Adjustment lines ────────────────────────────────────────────────────────
async function spbRecoAdd(key) {
  if (!spbBookId) return;
  try {
    const { data, error } = await window.sb.from('autobooks_adjustments').insert({
      book_id: spbBookId, statement: key, direction: 'add', description: '', amount: 0,
      sort_order: spbAdjustments.filter(a => a.statement === key).length,
    }).select().limit(1);
    if (error) throw error;
    if (data && data[0]) spbAdjustments.push(data[0]);
    spbRenderReco();
  } catch (err) {
    spbRecoStatus('❌ Could not add a line: ' + escHtml(err.message || String(err)), 'error');
  }
}

async function spbRecoSetField(id, field, raw) {
  const row = spbAdjustments.find(a => a.id === id);
  if (!row) return;
  const value = field === 'amount' ? Math.abs(spbNum(raw)) : String(raw);
  try {
    const { error } = await window.sb.from('autobooks_adjustments')
      .update({ [field]: value }).eq('id', id);
    if (error) throw error;
    row[field] = value;
    spbRenderReco();
  } catch (err) {
    spbRecoStatus('❌ Could not save that line: ' + escHtml(err.message || String(err)), 'error');
  }
}

async function spbRecoDelete(id) {
  const row = spbAdjustments.find(a => a.id === id);
  if (!row) return;
  if (row.description || Number(row.amount)) {
    if (!confirm(`Remove this adjustment?\n\n${row.description || '(no description)'}\n${spbFmt(row.amount)}`)) return;
  }
  try {
    const { error } = await window.sb.from('autobooks_adjustments').delete().eq('id', id);
    if (error) throw error;
    spbAdjustments = spbAdjustments.filter(a => a.id !== id);
    spbRenderReco();
  } catch (err) {
    spbRecoStatus('❌ Could not delete: ' + escHtml(err.message || String(err)), 'error');
  }
}

// ── Suggest from the monthly differences ────────────────────────────────────
// The firm's own sheet does exactly this by hand: each adjustment on the Reco
// sheet is one month's book-versus-return gap, described in words. Its Ashadh
// line of 87,710.14 IS book 887,710.14 less return 800,000. Offering it as a
// button is the same arithmetic without the retyping — and it creates ordinary
// editable lines, so a wrong one can be reworded or removed like any other.
function spbRecoSuggestable(st) {
  if (!spbBook || !spbVr) return [];
  const out = [];
  const push = (section, field, label) => {
    SPB_MONTH_NAMES.forEach((month, i) => {
      const b = (spbBook[section] || [])[i];
      const v = (spbVr[section] || [])[i];
      if (!b || !v) return;
      if (String(v[field] == null ? '' : v[field]).trim() === '') return;   // month not filed yet
      const bookVal = field === 't' ? b.t + (b.cap || 0) : (field === 'v' ? b.v + (b.capVat || 0) : b[field]);
      const retVal = field === 't' ? spbNum(v.t) + spbNum(v.cap) : (field === 'v' ? spbNum(v.v) + spbNum(v.capVat) : spbNum(v[field]));
      const diff = Math.round((bookVal - retVal) * 100) / 100;
      // Sub-rupee gaps are not "calculation mistakes" — they are the filed
      // return's whole-rupee truncation, and the firm's own sheet leaves them
      // to the Rounding Effect line rather than naming a month for each. Same
      // threshold the module already uses for a real gap (SPB_ROUNDING_TOLERANCE).
      // On the reference sheet this is exactly right: Falgun +0.19 and Chaitra
      // −0.07 stay unnamed and net to the 0.12 rounding line it prints.
      if (Math.abs(diff) <= SPB_ROUNDING_TOLERANCE) return;
      out.push({ month, amount: diff, label: `Calculation Mistake of ${label} in month of ${month} in Maskebari` });
    });
  };
  if (st.key === 'vat') {
    push('sales', 'v', 'VAT on Sales');
    push('purchase', 'v', 'VAT on Purchase');
  } else {
    push(st.section, 't', st.section === 'sales' ? 'Taxable Sales' : 'Taxable Purchase');
    push(st.section, 'f', 'VAT Exempted');
  }
  return out;
}

async function spbRecoSuggest(key) {
  const st = SPB_RECO_STATEMENTS.find(s => s.key === key);
  const sugg = spbRecoSuggestable(st);
  if (!sugg.length) {
    spbRecoStatus('ℹ️ No month differs between the book and the filed return, so there is nothing to suggest. (If the VAT-return figures haven\'t been entered, do that in <strong>Import › Monthly reconciliation</strong> first.)', 'info');
    return;
  }
  const existing = new Set(spbAdjustments.filter(a => a.statement === key).map(a => a.description));
  const fresh = sugg.filter(s => !existing.has(s.label));
  if (!fresh.length) { spbRecoStatus('ℹ️ Every monthly difference is already on the statement.', 'info'); return; }
  if (!confirm(`Add ${fresh.length} adjustment line${fresh.length === 1 ? '' : 's'} from the monthly differences?\n\nEach is that month's book figure less its filed figure. They become ordinary lines you can reword, change or remove.`)) return;
  try {
    let order = spbAdjustments.filter(a => a.statement === key).length;
    const rows = fresh.map(s => ({
      book_id: spbBookId, statement: key,
      direction: s.amount >= 0 ? 'add' : 'less',
      description: s.label, amount: Math.abs(s.amount), sort_order: order++,
    }));
    const { data, error } = await window.sb.from('autobooks_adjustments').insert(rows).select();
    if (error) throw error;
    (data || []).forEach(r => spbAdjustments.push(r));
    AuditLog.record('spb_reco_suggested', {
      module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
      detail: { fiscalYear: spbVal('spb-fy'), statement: key, lines: rows.length },
    });
    spbRenderReco();
    spbRecoStatus(`✅ Added ${rows.length} line${rows.length === 1 ? '' : 's'} from the monthly differences.`, 'success');
  } catch (err) {
    spbRecoStatus('❌ Could not add the lines: ' + escHtml(err.message || String(err)), 'error');
  }
}

// ── Screen ──────────────────────────────────────────────────────────────────
function spbRenderReco() {
  const el = document.getElementById('spb-reco-body');
  if (!el) return;
  if (!spbBookId) {
    el.innerHTML = '<p class="log-empty">Save the book first — adjustment lines are stored against it. Go to <strong>Import</strong> → <em>Save book to database</em>.</p>';
    return;
  }
  if (!spbBook) { el.innerHTML = '<p class="log-empty">No book loaded yet.</p>'; return; }

  let html = `<div class="action-row" style="margin:0 0 16px;">
      <button class="btn btn-outline btn-sm" onclick="spbPrintReco()">Print / Preview</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportReco('pdf')">Export PDF</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportReco('excel')">Export Excel</button>
    </div><div id="spb-reco-status"></div>`;

  SPB_RECO_STATEMENTS.forEach(st => {
    const m = spbRecoModel(st);
    html += `<div class="card" style="margin-bottom:20px;">
      <div class="card-header" style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
        <div>
          <div class="card-title" style="font-size:14px;">${escHtml(st.title)}</div>
          <div class="card-desc">${escHtml(spbRecoPeriod())}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="spbRecoSuggest('${st.key}')">Suggest from monthly differences</button>
          <button class="btn btn-outline btn-sm" onclick="spbRecoAdd('${st.key}')">+ Add line</button>
        </div>
      </div>`;

    if (!m.retTyped) {
      html += `<div class="log-sub" style="margin-bottom:12px; color:var(--amber-dk);">
        No filed figures have been entered for this statement, so "${escHtml(st.retLabel)}" reads nil.
        Enter them in <strong>Import › Monthly reconciliation</strong>.</div>`;
    }

    html += `<div class="table-wrap"><table class="client-table" style="font-size:13px;">
      <thead><tr><th>Particulars</th><th style="text-align:right; width:190px;">Amount (Rs.)</th><th style="width:60px;"></th></tr></thead><tbody>`;
    html += spbRecoRow(escHtml(st.retLabel), m.ret, { bold: true });

    if (m.auto.length || m.adds.length) html += spbRecoHead('Add:');
    m.auto.filter(l => l.amount > 0).forEach(l => {
      html += spbRecoRow(escHtml(l.label) + spbRecoAutoTag(), l.amount, { indent: true });
    });
    m.adds.forEach(a => { html += spbRecoEditRow(a); });

    const negAuto = m.auto.filter(l => l.amount < 0);
    if (negAuto.length || m.lessers.length) html += spbRecoHead('Less:');
    negAuto.forEach(l => {
      html += spbRecoRow(escHtml(l.label) + spbRecoAutoTag(), Math.abs(l.amount), { indent: true });
    });
    m.lessers.forEach(a => { html += spbRecoEditRow(a); });

    html += spbRecoRow('Less: Rounding Effect' +
      (m.absorbed ? '' : ` <span style="color:var(--text-muted); font-size:11.5px;">(only applied below Rs ${spbFmt(SPB_RECO_ROUNDING_LIMIT)})</span>`),
      m.rounding, { muted: !m.absorbed });
    html += spbRecoRow(escHtml(st.retLabel) + ' After Adjustment', m.after, { bold: true, rule: true });
    html += spbRecoRow(escHtml(st.bookLabel), m.books, { bold: true });
    html += spbRecoRow('Net Difference', m.net, {
      bold: true, grand: true,
      color: m.unexplained ? 'var(--red-dk)' : (Math.abs(m.net) < 0.005 ? 'var(--green-dk)' : ''),
    });
    html += `</tbody></table></div>`;

    if (m.unexplained) {
      html += `<div class="log-sub" style="margin-top:12px; color:var(--red-dk);">
        <strong>Rs ${spbFmt(Math.abs(m.net))} is unexplained.</strong> It exceeds Rs ${spbFmt(SPB_RECO_ROUNDING_LIMIT)},
        so it is not absorbed as rounding — add an adjustment line naming the reason, or check the figures.</div>`;
    }
    html += `</div>`;
  });
  el.innerHTML = html;
}

function spbRecoAutoTag() {
  return ' <span class="log-badge badge-blue" style="font-size:10px; padding:2px 7px;">automatic</span>';
}

function spbRecoHead(label) {
  return `<tr><td colspan="3" style="font-weight:700; padding-top:12px;">${escHtml(label)}</td></tr>`;
}

function spbRecoRow(labelHtml, amount, opts) {
  const o = opts || {};
  return `<tr${o.grand ? ' style="background:var(--amber-bg);"' : (o.rule ? ' style="border-top:2px solid var(--border);"' : '')}>
    <td${o.indent ? ' style="padding-left:30px;"' : ''}${o.bold ? ' class="spb-reco-b"' : ''}>${labelHtml}</td>
    <td style="text-align:right;${o.bold ? 'font-weight:700;' : ''}${o.muted ? 'color:var(--text-muted);' : ''}${o.color ? 'color:' + o.color + ';' : ''}">${spbFmt(amount)}</td>
    <td></td></tr>`;
}

// An adjustment is free text and a plain amount on purpose — which mistakes
// exist varies per client and per year, so nothing is hardcoded to a month.
function spbRecoEditRow(a) {
  return `<tr>
    <td style="padding-left:30px;">
      <input type="text" class="spb-reco-desc" value="${escHtml(a.description || '')}"
             placeholder="Reason for the difference…" onchange="spbRecoSetField(${a.id}, 'description', this.value)" />
    </td>
    <td style="text-align:right;">
      <input type="text" class="spb-cf-in" inputmode="decimal" value="${a.amount ? escHtml(String(a.amount)) : ''}"
             onchange="spbRecoSetField(${a.id}, 'amount', this.value)" />
    </td>
    <td style="text-align:right;">
      <button class="btn btn-outline btn-sm" onclick="spbRecoDelete(${a.id})" title="Remove this line">✕</button>
    </td></tr>`;
}

// "For the year ended 32nd Ashadh 2083" — the fiscal year's last day, in the
// firm's own wording on its Reco sheet.
function spbRecoPeriod() {
  const y = spbFyStartYear();
  return y ? `For the year ended 32nd Ashadh ${y + 1}` : '';
}

// ── Output ──────────────────────────────────────────────────────────────────
function spbRecoExportModel() {
  const columns = [
    { label: 'Particulars', align: 'l', w: 62 },
    { label: 'Amount (Rs.)', align: 'r', num: true, w: 38 },
  ];
  const rows = [];
  SPB_RECO_STATEMENTS.forEach(st => {
    const m = spbRecoModel(st);
    rows.push({ cells: [st.title], style: 'section' });
    rows.push({ cells: [st.retLabel, m.ret] });
    if (m.auto.length || m.adds.length) rows.push({ cells: ['Add:'], style: 'subtle' });
    m.auto.filter(l => l.amount > 0).forEach(l => rows.push({ cells: ['   ' + l.label, l.amount] }));
    m.adds.forEach(a => rows.push({ cells: ['   ' + (a.description || '(not described)'), Number(a.amount) || 0] }));
    const neg = m.auto.filter(l => l.amount < 0);
    if (neg.length || m.lessers.length) rows.push({ cells: ['Less:'], style: 'subtle' });
    neg.forEach(l => rows.push({ cells: ['   ' + l.label, Math.abs(l.amount)] }));
    m.lessers.forEach(a => rows.push({ cells: ['   ' + (a.description || '(not described)'), Number(a.amount) || 0] }));
    rows.push({ cells: ['Less: Rounding Effect', m.rounding] });
    rows.push({ cells: [st.retLabel + ' After Adjustment', m.after], style: 'total' });
    rows.push({ cells: [st.bookLabel, m.books] });
    rows.push({ cells: ['Net Difference', m.net], style: 'grand' });
  });
  return {
    title: 'Reconciliation Statements',
    subtitleLines: [
      spbVal('spb-company') + (spbVal('spb-pan') ? '  ·  PAN ' + spbVal('spb-pan') : ''),
      spbRecoPeriod(),
      `Rounding is absorbed only below Rs ${spbFmt(SPB_RECO_ROUNDING_LIMIT)}.`,
    ],
    columns, rows, landscape: false,
  };
}

function spbPrintReco() {
  let body = '';
  SPB_RECO_STATEMENTS.forEach(st => {
    const m = spbRecoModel(st);
    const row = (label, amount, bold) =>
      `<tr><td${bold ? ' style="font-weight:700;"' : ''}>${escHtml(label)}</td>` +
      `<td style="text-align:right;${bold ? 'font-weight:700;' : ''}">${spbFmt(amount)}</td></tr>`;
    body += `<h2 style="font-size:13px; margin:22px 0 2px;">${escHtml(st.title)}</h2>
      <p style="font-size:11px; color:#444; margin:0 0 8px;">${escHtml(spbRecoPeriod())}</p>
      <table style="max-width:620px;"><thead><tr><th>Particulars</th><th style="text-align:right;">Amount (Rs.)</th></tr></thead><tbody>`;
    body += row(st.retLabel, m.ret, true);
    if (m.auto.length || m.adds.length) body += `<tr><td colspan="2" style="font-weight:700;">Add:</td></tr>`;
    m.auto.filter(l => l.amount > 0).forEach(l => { body += row('    ' + l.label, l.amount); });
    m.adds.forEach(a => { body += row('    ' + (a.description || '(not described)'), Number(a.amount) || 0); });
    const neg = m.auto.filter(l => l.amount < 0);
    if (neg.length || m.lessers.length) body += `<tr><td colspan="2" style="font-weight:700;">Less:</td></tr>`;
    neg.forEach(l => { body += row('    ' + l.label, Math.abs(l.amount)); });
    m.lessers.forEach(a => { body += row('    ' + (a.description || '(not described)'), Number(a.amount) || 0); });
    body += row('Less: Rounding Effect', m.rounding);
    body += row(st.retLabel + ' After Adjustment', m.after, true);
    body += row(st.bookLabel, m.books, true);
    body += `<tr style="background:#fff3e0;"><td style="font-weight:800;">Net Difference</td>
      <td style="text-align:right; font-weight:800;${m.unexplained ? 'color:var(--red-dk);' : ''}">${spbFmt(m.net)}</td></tr>`;
    body += `</tbody></table>`;
    if (m.unexplained) {
      body += `<p style="font-size:11px; color:#444; margin-top:6px;">Rs ${spbFmt(Math.abs(m.net))} remains unexplained; it exceeds Rs ${spbFmt(SPB_RECO_ROUNDING_LIMIT)} and is not absorbed as rounding.</p>`;
    }
  });
  spbOpenPrint(spbPrintDoc('Reconciliation Statements', spbRecoPeriod(), body));
  AuditLog.record('spb_reco_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy') },
  });
}

async function spbExportReco(kind) {
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(spbRecoExportModel(), kind,
      `Reconciliation Statements - ${spbVal('spb-company')} ${spbVal('spb-fy')}.${ext}`,
      { module: 'salesPurchaseBook', clientName: spbVal('spb-company'), sheetName: 'Reco' });
    spbRecoStatus('✅ Exported.', 'success');
  } catch (err) {
    console.error('[Autobooks] reconciliation export failed', err);
    spbRecoStatus('❌ Could not export: ' + escHtml(err.message || String(err)), 'error');
  }
}

// ── Registration ──
SPB_SECTION_TABS.push({ key: 'reco', label: 'Reconciliation', panel: 'spb-sec-reco', onShow: 'spbRenderReco' });
spbRenderSectionNav();
