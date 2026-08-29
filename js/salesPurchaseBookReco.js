// ════════════════════════════════════════════
//  AUTOBOOKS — RECONCILIATION STATEMENTS
//
//  Rebuilt 2026-08-29 to the CA's own reference workbook (its "Reco" sheet),
//  which the firm asked the app to follow. The change is structural, not
//  cosmetic: the statement used to be a list of free-text adjustment lines a
//  staff member typed (with a "suggest from the monthly differences" button to
//  seed them). In the CA's format there is nothing to type — every adjustment
//  is DERIVED, under two named headings:
//
//      <X> as Per Maskebari                        (the filed return)
//      1. Difference due to Calculation mistake in maskebari
//           Add:   … months where the book exceeds the return
//           Less:  … months where the return exceeds the book
//      2. Difference due to Bill omiited or excess entry
//           Add:   … bills omitted from the return
//           Less:  … amounts entered in excess
//      Less: Rounding Effect
//      <X> as Per Maskebari After Adjustment
//      <X> as Per Accounts                         (the books)
//      Net Difference
//
//  That format is COMPLETE by construction, which is why the free-text lines
//  are gone rather than merely unused. Every month's book-minus-return gap is
//  captured under heading 1 and every late bill under heading 2, so
//  return + Σ(monthly gaps) + omitted IS the book figure — the statement foots
//  arithmetically and Net Difference reads nil unless something upstream is
//  wrong. A hand-typed line on top of that could only double-count.
//
//  Sub-rupee gaps go to Rounding Effect instead of being named month by month:
//  the filed return is truncated to whole rupees, so a 19-paisa gap is not a
//  "calculation mistake". Same threshold the parser already uses for a real gap
//  (SPB_ROUNDING_TOLERANCE), and it reproduces the CA's own −0.30 rounding line.
//
//  Everything runs FROM the return TO the books, so an adjustment is
//  BOOK − RETURN. The Monthly grid prints Return − Book; each is internally
//  consistent and neither is changing (CLAUDE.md §8).
// ════════════════════════════════════════════

// "if Difference is less than 1000 then round off Difference" — the firm's own
// note. At or above a thousand rupees it is not rounding, it is a real
// unexplained difference, and it stays on the face of the statement.
const SPB_RECO_ROUNDING_LIMIT = 1000;

const SPB_RECO_STATEMENTS = [
  { key: 'sales', section: 'sales', title: 'Sales Reconciliation Statement',
    retLabel: 'Sales as Per Maskebari', bookLabel: 'Sales as Per Accounts', noun: 'Sales' },
  { key: 'purchase', section: 'purchase', title: 'Purchase Reconciliation Statement',
    retLabel: 'Purchase as Per Maskebari', bookLabel: 'Purchase as Per Accounts', noun: 'Purchase' },
];

function spbRecoStatus(html, type) { showStatus(html, type, 'spb-reco-status'); }

// ── The two typed figures ───────────────────────────────────────────────────
// The VAT cross-check opens with last year's closing VAT position, which is a
// fact about the FINANCIAL STATEMENTS and cannot be derived from this year's
// register. It rides in the vat_return jsonb (already the home of everything
// "as per the return") rather than a new column, so this needed no migration.
function spbRecoMeta() {
  if (!spbVr) spbVr = spbBlankVr();
  if (!spbVr.meta) spbVr.meta = {};
  return spbVr.meta;
}

function spbRecoSetMeta(field, raw) {
  spbRecoMeta()[field] = String(raw == null ? '' : raw).trim();
  spbVrScheduleDraft();
  spbDirty = true;
  spbRenderReco();
}

// ── Derived adjustments ─────────────────────────────────────────────────────
// One month's gap on one measure. Split by SIGN into the Add and Less buckets
// the CA's headings call for, with sub-rupee gaps routed to rounding.
function spbRecoGaps(section, measure) {
  const out = { add: 0, less: 0, rounding: 0, months: [], unfiled: [] };
  if (!spbBook || !spbVr) return out;
  SPB_MONTH_NAMES.forEach((month, i) => {
    const b = (spbBook[section] || [])[i];
    const v = (spbVr[section] || [])[i];
    if (!b) return;
    const bookVal = measure === 'taxable'
      ? spbReturnTaxable(b) + (b.imp || 0)
      : b.f;
    const retVal = measure === 'taxable'
      ? spbReturnTaxable({ t: spbNum(v && v.t), cap: spbNum(v && v.cap) }) + spbNum(v && v.imp)
      : spbNum(v && v.f);
    // A month whose return was never entered reads as nil, so its whole book
    // figure lands in the gap. That is arithmetically right — the statement
    // still foots — but it is not a "calculation mistake", so the months are
    // named under the table rather than left to look like findings.
    const filed = v && SPB_VR_FIELDS.some(f => String(v[f] == null ? '' : v[f]).trim() !== '');
    if (!filed && (bookVal || retVal)) out.unfiled.push(month);
    const diff = Math.round((bookVal - retVal) * 100) / 100;
    if (!diff) return;
    if (Math.abs(diff) <= SPB_ROUNDING_TOLERANCE) { out.rounding += diff; return; }
    if (diff > 0) out.add += diff; else out.less += diff;
    out.months.push({ month, diff });
  });
  return out;
}

// Omitted bills, signed (a return or debit note subtracts) and split the same
// way. Derived from the Omitted Bills screen, never a stored figure — a copy
// would drift the moment one was edited there.
function spbRecoOmitted(section, measure) {
  const out = { add: 0, less: 0, count: 0 };
  spbOmitted.filter(x => x.section === section).forEach(x => {
    const v = (measure === 'taxable'
      ? ((x.taxable || 0) + (x.cap || 0)) + (x.imp || 0)
      : (x.taxfree || 0)) * spbOmittedSign(x);
    if (!v) return;
    out.count++;
    if (v > 0) out.add += v; else out.less += v;
  });
  return out;
}

function spbRecoOmittedVat(section) {
  return spbOmitted.filter(x => x.section === section)
    .reduce((a, x) => a + ((x.vat || 0) + (x.capVat || 0) + (x.impVat || 0)) * spbOmittedSign(x), 0);
}

// Everything one statement needs, in the CA's own row order.
function spbRecoModel(st) {
  const vr = spbVr || spbBlankVr();
  const book = spbBook || {};
  const sec = st.section;

  let ret = 0, retTyped = false;
  (vr[sec] || []).forEach(m => {
    if (SPB_VR_FIELDS.some(f => String(m[f] == null ? '' : m[f]).trim() !== '')) retTyped = true;
    ret += spbReturnTaxable({ t: spbNum(m.t), cap: spbNum(m.cap) }) + spbNum(m.imp) + spbNum(m.f);
  });

  let books = 0;
  (book[sec] || []).forEach(m => {
    books += spbReturnTaxable(m) + (m.imp || 0) + m.f;
  });
  const omT = spbRecoOmitted(sec, 'taxable');
  const omF = spbRecoOmitted(sec, 'taxfree');
  books += omT.add + omT.less + omF.add + omF.less;

  const gapT = spbRecoGaps(sec, 'taxable');
  const gapF = spbRecoGaps(sec, 'taxfree');

  const noun = st.noun;
  const rows = [
    { kind: 'anchor', label: st.retLabel, amount: ret },
    { kind: 'heading', label: '1. Difference due to Calculation mistake in maskebari' },
    { kind: 'sub', label: 'Add:' },
    { kind: 'line', label: `Calculation Mistake of Taxable ${noun} in Masebari`, amount: gapT.add },
    { kind: 'line', label: `Calculation Mistake of Tax free ${noun} in Masebari`, amount: gapF.add },
    { kind: 'sub', label: 'Less:' },
    { kind: 'line', label: `Calculation Mistake of Taxable ${noun} in Masebari`, amount: gapT.less },
    { kind: 'line', label: `Calculation Mistake of Tax free ${noun} in Masebari`, amount: gapF.less },
    { kind: 'heading', label: '2. Difference due to Bill omiited or excess entry' },
    { kind: 'sub', label: 'Add:' },
    { kind: 'line', label: `Taxable ${noun} Omiited in Maskebari`, amount: omT.add },
    { kind: 'line', label: `Tax Free ${noun} Omiited in Maskebari`, amount: omF.add },
    { kind: 'sub', label: 'Less:' },
    { kind: 'line', label: `Taxable ${noun} Excess in Maskebari`, amount: omT.less },
    { kind: 'line', label: `Tax Free ${noun} Excess in Maskebari`, amount: omF.less },
  ];

  const named = gapT.add + gapT.less + gapF.add + gapF.less + omT.add + omT.less + omF.add + omF.less;
  const rounding = gapT.rounding + gapF.rounding;
  const after = ret + named + rounding;
  const net = after - books;

  rows.push({ kind: 'line', label: 'Less: Rounding Effect', amount: rounding });
  rows.push({ kind: 'total', label: st.retLabel + ' After Adjustment', amount: after });
  rows.push({ kind: 'anchor', label: st.bookLabel, amount: books });
  rows.push({ kind: 'net', label: 'Net Difference', amount: net });

  return {
    st, rows, ret, books, after, rounding, net, retTyped,
    // The taxable adjustments alone carry VAT — tax-free ones never do. This is
    // what the VAT statement's Sales/Purchase Adjustment lines are 13% of.
    taxableAdjustment: gapT.add + gapT.less + omT.add + omT.less,
    unfiled: [...new Set([...gapT.unfiled, ...gapF.unfiled])],
    unexplained: Math.abs(net) >= SPB_RECO_ROUNDING_LIMIT,
  };
}

// ── VAT ─────────────────────────────────────────────────────────────────────
// Two blocks, exactly as the CA draws them: the reconciliation itself, and a
// cross-check that rebuilds the closing VAT position from the opening one.
//
// Sign convention throughout, printed on the statement: (−) is a RECEIVABLE
// and (+) a PAYABLE. So output VAT on sales adds and input VAT on purchases
// subtracts.
function spbRecoVatModel() {
  const vr = spbVr || spbBlankVr();
  const book = spbBook || {};
  const meta = spbRecoMeta();
  const opening = spbNum(meta.openingVat);
  const pyAdj = spbNum(meta.pyPurchaseAdj);

  // "As per return" reads the FILED VAT column when it has been entered — the
  // filed figure is typed, never derived (CLAUDE.md §15) — and falls back to
  // 13% of the filed taxable, which is how the CA's own sheet computes it.
  const retVat = key => {
    let sum = 0, typed = false;
    (vr[key] || []).forEach(m => {
      const v = spbReturnVat({ v: spbNum(m.v), capVat: spbNum(m.capVat) }) + spbNum(m.impVat);
      if (String(m.v == null ? '' : m.v).trim() !== '') typed = true;
      sum += v;
    });
    if (typed) return sum;
    let fallback = 0;
    (vr[key] || []).forEach(m => {
      fallback += (spbReturnTaxable({ t: spbNum(m.t), cap: spbNum(m.cap) }) + spbNum(m.imp)) * 0.13;
    });
    return fallback;
  };
  const bookVat = key => {
    let sum = 0;
    (book[key] || []).forEach(m => { sum += (m.v || 0) + (m.capVat || 0) + (m.impVat || 0); });
    return sum + spbRecoOmittedVat(key);
  };

  const retSalesVat = retVat('sales'), retPurVat = retVat('purchase');
  const bookSalesVat = bookVat('sales'), bookPurVat = bookVat('purchase');

  const asPerReturn = opening + retSalesVat - retPurVat;
  const salesAdj = spbRecoModel(SPB_RECO_STATEMENTS[0]).taxableAdjustment * 0.13;
  const purAdj = -spbRecoModel(SPB_RECO_STATEMENTS[1]).taxableAdjustment * 0.13;

  // The cross-check IS the books figure — one number, computed once.
  const closing = opening - bookPurVat + bookSalesVat - pyAdj;

  const beforeRound = asPerReturn + salesAdj + purAdj;
  const residual = closing - beforeRound;
  const rounding = Math.abs(residual) < SPB_RECO_ROUNDING_LIMIT ? residual : 0;
  const after = beforeRound + rounding;

  return {
    opening, pyAdj, retSalesVat, retPurVat, bookSalesVat, bookPurVat,
    asPerReturn, salesAdj, purAdj, rounding, after, closing,
    net: after - closing,
    unexplained: Math.abs(after - closing) >= SPB_RECO_ROUNDING_LIMIT,
    rows: [
      { kind: 'anchor', label: 'VAT Payables (Receivables) as per Return', amount: asPerReturn },
      { kind: 'line', label: 'Sales Adjustment', amount: salesAdj },
      { kind: 'line', label: 'Purchase Adjustment', amount: purAdj },
      { kind: 'line', label: 'Round off', amount: rounding },
      { kind: 'total', label: 'VAT Payables (Receivables) as per Return After Adjustment', amount: after },
      { kind: 'anchor', label: 'VAT Payables (Receivables) as Per Books', amount: closing },
      { kind: 'net', label: 'Net Difference', amount: after - closing },
    ],
    crossRows: [
      { kind: 'typed', label: 'Opening VAT Payables (Receivables) as Per Financial Statement',
        amount: opening, field: 'openingVat' },
      { kind: 'line', label: 'Add: VAT on Purchase', amount: -bookPurVat },
      { kind: 'line', label: 'Less: VAT on Sales', amount: bookSalesVat },
      { kind: 'typed', label: 'Less: Previous Year Purchase adjustment not adjusted',
        amount: -pyAdj, field: 'pyPurchaseAdj' },
      { kind: 'total', label: 'Closing VAT Payables (Receivables)', amount: closing },
    ],
  };
}

// "For the year ended 32nd Ashadh 2083" — the firm's own wording. The last day
// is READ from the calendar rather than assumed: five of the eleven tabulated
// B.S. years have a 31-day Ashadh, and printing 32nd on one of those would put
// a date on the statement that does not exist.
function spbRecoPeriod() {
  const y = spbFyStartYear();
  if (!y) return '';
  let last = 32;
  if (NepaliLocale.bsMonthEnd) {
    const e = NepaliLocale.bsMonthEnd(y + 1, 3);
    if (e) last = e;
  }
  return `For the year ended ${last}${last === 31 ? 'st' : 'nd'} Ashadh ${y + 1}`;
}

// ── Screen ──────────────────────────────────────────────────────────────────
// Deliberately quiet. This is a statement an auditor reads top to bottom, so
// it gets one typeface weight for structure, generous row spacing, figures in
// a single right-aligned column — and colour ONLY where something is wrong.
function spbRenderReco() {
  const el = document.getElementById('spb-reco-body');
  if (!el) return;
  if (!spbBook) { el.innerHTML = '<p class="log-empty">No book loaded yet.</p>'; return; }

  let html = `<div class="spb-reco-actions">
      <button class="btn btn-outline btn-sm" onclick="spbPrintReco()">Print / Preview</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportReco('pdf')">Export PDF</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportReco('excel')">Export Excel</button>
    </div><div id="spb-reco-status"></div>`;

  const notes = [];
  SPB_RECO_STATEMENTS.forEach(st => {
    const m = spbRecoModel(st);
    if (!m.retTyped) {
      notes.push(`No filed figures have been entered for ${st.noun.toLowerCase()}, so "${st.retLabel}" reads nil and the whole book shows as a difference. Enter them in <strong>Import › Monthly reconciliation</strong>.`);
    } else if (m.unfiled.length) {
      notes.push(`${st.noun}: no filed figures for ${escHtml(m.unfiled.join(', '))} — those months' book figures appear under <em>Calculation mistake</em>.`);
    }
    html += spbRecoStatementHtml(st.title, m.rows, m);
  });

  const v = spbRecoVatModel();
  html += spbRecoStatementHtml('VAT Reconciliation Statement', v.rows, v,
    `<p class="spb-reco-legend">(−) indicates VAT Receivables &nbsp;·&nbsp; (+) indicates VAT Payables</p>`);
  html += spbRecoStatementHtml('Cross Check of VAT Payables (Receivables)', v.crossRows, null,
    `<p class="spb-reco-legend">The opening position comes from last year's financial statements — it is the one
     figure here that cannot be derived from this year's register.</p>`);

  if (notes.length) {
    html += `<div class="spb-reco-notes">${notes.map(n => `<p>${n}</p>`).join('')}</div>`;
  }
  el.innerHTML = html;
}

function spbRecoStatementHtml(title, rows, m, footHtml) {
  let html = `<section class="spb-reco-card">
    <header class="spb-reco-head">
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(spbRecoPeriod())}</p>
    </header>
    <table class="spb-reco-table">
      <thead><tr><th>Particulars</th><th>Amount (Rs.)</th></tr></thead><tbody>`;
  rows.forEach(r => {
    if (r.kind === 'heading') {
      html += `<tr class="spb-reco-h"><td colspan="2">${escHtml(r.label)}</td></tr>`;
      return;
    }
    if (r.kind === 'sub') {
      html += `<tr class="spb-reco-s"><td colspan="2">${escHtml(r.label)}</td></tr>`;
      return;
    }
    if (r.kind === 'typed') {
      html += `<tr class="spb-reco-typed"><td>${escHtml(r.label)}</td>
        <td><input type="text" inputmode="decimal" class="spb-reco-in"
          value="${escHtml(String(spbRecoMeta()[r.field] || ''))}" placeholder="0.00"
          onchange="spbRecoSetMeta('${r.field}', this.value)" /></td></tr>`;
      return;
    }
    const cls = r.kind === 'anchor' ? 'spb-reco-a'
      : r.kind === 'total' ? 'spb-reco-t'
      : r.kind === 'net' ? 'spb-reco-n' : '';
    const nil = r.kind === 'net' && Math.abs(r.amount) < 0.005;
    const bad = r.kind === 'net' && m && m.unexplained;
    html += `<tr class="${cls}"><td>${escHtml(r.label)}</td>
      <td class="${bad ? 'spb-reco-bad' : (nil ? 'spb-reco-ok' : '')}">${spbFmt(r.amount)}</td></tr>`;
  });
  html += `</tbody></table>`;
  if (footHtml) html += footHtml;
  if (m && m.unexplained) {
    html += `<p class="spb-reco-warn">Rs ${spbFmt(Math.abs(m.net))} is unexplained — it exceeds
      Rs ${spbFmt(SPB_RECO_ROUNDING_LIMIT)}, so it is not absorbed as rounding. Check the filed figures
      and the omitted bills.</p>`;
  }
  return html + `</section>`;
}

// ── Output ──────────────────────────────────────────────────────────────────
function spbRecoAllStatements() {
  const out = SPB_RECO_STATEMENTS.map(st => ({ title: st.title, m: spbRecoModel(st) }));
  const v = spbRecoVatModel();
  out.push({ title: 'VAT Reconciliation Statement', m: v, rows: v.rows });
  out.push({ title: 'Cross Check of VAT Payables (Receivables)', m: null, rows: v.crossRows });
  return out;
}

function spbRecoExportModel() {
  const rows = [];
  spbRecoAllStatements().forEach(({ title, m, rows: only }) => {
    rows.push({ cells: [title], style: 'section' });
    rows.push({ cells: [spbRecoPeriod()], style: 'subtle' });
    (only || m.rows).forEach(r => {
      if (r.kind === 'heading' || r.kind === 'sub') { rows.push({ cells: [r.label], style: 'subtle' }); return; }
      const label = (r.kind === 'line' || r.kind === 'typed') ? '   ' + r.label : r.label;
      rows.push({
        cells: [label, r.amount],
        style: r.kind === 'total' ? 'total' : (r.kind === 'net' ? 'grand' : undefined),
      });
    });
    rows.push({ cells: [''] });
  });
  return {
    title: 'Reconciliation Statements',
    subtitleLines: [
      spbVal('spb-company') + (spbVal('spb-pan') ? '  ·  PAN ' + spbVal('spb-pan') : ''),
      spbRecoPeriod(),
      '(−) indicates VAT Receivables · (+) indicates VAT Payables',
    ],
    columns: [
      { label: 'Particulars', align: 'l', w: 66 },
      { label: 'Amount (Rs.)', align: 'r', num: true, w: 34 },
    ],
    rows, landscape: false,
  };
}

function spbPrintReco() {
  let body = '';
  spbRecoAllStatements().forEach(({ title, m, rows: only }) => {
    body += `<h2 class="reco-t">${escHtml(title)}</h2>
      <p class="reco-p">${escHtml(spbRecoPeriod())}</p>
      <table class="reco"><thead><tr><th>Particulars</th><th class="r">Amount (Rs.)</th></tr></thead><tbody>`;
    (only || m.rows).forEach(r => {
      if (r.kind === 'heading') { body += `<tr><td colspan="2" class="h">${escHtml(r.label)}</td></tr>`; return; }
      if (r.kind === 'sub') { body += `<tr><td colspan="2" class="s">${escHtml(r.label)}</td></tr>`; return; }
      const cls = r.kind === 'anchor' || r.kind === 'total' ? ' class="b"'
        : (r.kind === 'net' ? ' class="n"' : '');
      const indent = (r.kind === 'line' || r.kind === 'typed') ? ' class="i"' : '';
      body += `<tr${cls}><td${indent}>${escHtml(r.label)}</td><td class="r">${spbFmt(r.amount)}</td></tr>`;
    });
    body += `</tbody></table>`;
  });
  body += `<p class="reco-p">(−) indicates VAT Receivables &nbsp;·&nbsp; (+) indicates VAT Payables</p>`;
  spbOpenPrint(spbPrintDoc('Reconciliation Statements', spbRecoPeriod(), body, { portrait: true, css: `
    .reco { max-width: 640px; margin-bottom: 26px; }
    .reco-t { font-size: 13px; margin: 26px 0 2px; }
    .reco-p { font-size: 10.5px; color: #444; margin: 0 0 10px; }
    .reco td, .reco th { padding: 5px 10px; }
    .reco td.r, .reco th.r { text-align: right; }
    .reco td.i { padding-left: 26px; }
    .reco td.h { font-weight: 700; padding-top: 12px; }
    .reco td.s { font-weight: 600; padding-left: 14px; }
    .reco tr.b td { font-weight: 700; }
    .reco tr.n td { font-weight: 800; border-top: 1px solid #999; }
  ` }));
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
    spbRecoStatus('❌ Could not export: ' + escHtml(friendlyDbError(err)), 'error');
  }
}

// ── Registration ──
SPB_SECTION_TABS.push({ key: 'reco', label: 'Reconciliation', panel: 'spb-sec-reco', onShow: 'spbRenderReco' });
spbRenderSectionNav();
