// ════════════════════════════════════════════
//  AUTOBOOKS — CONFIRMATION LEDGER
//
//  The inbound leg of confirmation work, and the reason Autobooks needed a
//  database at all. A signed confirmation letter comes back from a customer or
//  supplier stating what THEY think the year's taxable trade was; this screen
//  puts that figure beside the firm's own books, party by party, and shows what
//  is left over.
//
//  Not to be confused with the Confirmation module (js/confirmationLetters.js,
//  `cl-`), which generates the letters that go OUT. This records what comes
//  back and reconciles it.
//
//  THE DIFFERENCE IS THE POINT, AND OMITTED BILLS ARE HOW IT CLOSES. In the
//  reference file every flagged party's gap is explained exactly by a bill that
//  surfaced after the register was closed — Party A's 342,973.44,
//  Party B's 531,132.80, Party H's 237,748.20. So "Taxable as per
//  books" here is deliberately the register PLUS that party's omitted bills:
//  the figure being compared has to be everything the firm has booked, or a
//  reconciled party still reads as a gap.
//
//  Sign: Difference = CONFIRMATION − BOOKS (2026-08-30), the convention on the
//  CA's own Details sheet, which the firm asked the app to follow. This
//  REVERSES the 2026-08-16 decision to print Books − Confirmation; the figure
//  and the fix now point the same way, since a POSITIVE difference means the
//  party reports more trade than the register holds and an omitted bill is
//  what closes it. Compared total-to-total (taxable + tax free), as he does.
//
//  SHOWN AS "PARTIES", NOT "CONFIRMATION" (2026-08-30, user ask). His workbook
//  has no Confirmation sheet at all: the as-per-confirmation figures are two
//  columns on Sales/Purchase Details, beside each party's own book totals.
//  This screen IS that sheet — everything in code still says `spbCf`/`confirm`,
//  the display-name-only convention the four renamed modules follow
//  (CLAUDE.md §5).
// ════════════════════════════════════════════

// Both thresholds are the workbook's own, not invented here (CLAUDE.md §15 —
// don't add tax rules these files don't contain).
const SPB_CONFIRM_TIER = 100000;      // the Annexure-13 split: >= 1 lakh reports separately
const SPB_CONFIRM_TOLERANCE = 1000;   // "Mark Green if Difference is Less than 1000"

const SPB_CONFIRM_STATUS = {
  pending: { label: 'Awaiting',  badge: 'badge-neutral' },
  ok:      { label: 'Matched',   badge: 'badge-sent' },
  flag:    { label: 'Difference', badge: 'badge-error' },
};

let spbCfSection = 'sales';
let spbCfSearch = '';
let spbCfStatusFilter = 'all';
let spbCfShowMinor = false;   // the <1 lakh tier starts folded — see spbRenderConfirm
let spbCfRows = [];           // the rendered model, indexed exactly as the table

function spbCfStatus(html, type) { showStatus(html, type, 'spb-cf-status'); }

// ── The model ───────────────────────────────────────────────────────────────
// One row per party per register. Parties come from the imported book, PLUS
// any party that exists only on an omitted bill — a party first met on a late
// bill still has to be confirmed, and leaving it out is how it gets forgotten.
function spbConfirmRows(section) {
  const groups = (spbGroups && spbGroups[section]) || [];
  const omitted = spbOmitted.filter(x => x.section === section);

  const rows = groups.map(g => ({
    key: g.key, name: spbOmPlainName(g.display), pan: g.pan || '',
    bookTaxfree: g.taxfree || 0, bookTaxable: g.taxable || 0, bookVat: g.vat || 0,
    // Carried for Annexure-13, which splits purchases into Capital vs Others.
    // That axis is a property of the BILL (the book's own Capital Purchase
    // column), not of the party, so it is derived rather than asked for.
    bookCapital: g.cap || 0,
    fromBook: true,
  }));
  const seen = new Set(rows.map(r => r.key));
  omitted.forEach(x => {
    if (seen.has(x.groupKey)) return;
    seen.add(x.groupKey);
    rows.push({
      key: x.groupKey, name: x.party, pan: x.pan || '',
      bookTaxfree: 0, bookTaxable: 0, bookVat: 0, bookCapital: 0, fromBook: false,
    });
  });

  rows.forEach(r => {
    const mine = omitted.filter(x => x.groupKey === r.key);
    const sign = x => spbOmittedSign(x);
    r.omCount = mine.length;
    r.omTaxfree = mine.reduce((a, x) => a + (x.taxfree || 0) * sign(x), 0);
    r.omTaxable = mine.reduce((a, x) => a + (x.taxable || 0) * sign(x), 0);
    r.omVat = mine.reduce((a, x) => a + (x.vat || 0) * sign(x), 0);

    r.taxfree = r.bookTaxfree + r.omTaxfree;
    r.taxable = r.bookTaxable + r.omTaxable;
    r.vat = r.bookVat + r.omVat;
    r.total = r.taxfree + r.taxable + r.vat;

    r.capital = r.bookCapital;   // omitted bills carry no capital column
    const led = spbLedgerParties[section + '|' + r.key] || {};
    r.ledgerId = led.id != null ? led.id : null;
    r.opening = led.opening_balance != null ? Number(led.opening_balance) : null;
    r.confirmed = led.confirmed_taxable != null ? Number(led.confirmed_taxable) : null;
    r.confirmedFree = led.confirmed_taxfree != null ? Number(led.confirmed_taxfree) : null;
    r.closing = led.confirmed_closing != null ? Number(led.confirmed_closing) : null;
    r.remarks = led.remarks || '';
    r.ann13 = led.ann13_category || null;
    // The CA's Classify sheet. `classify` supersedes `ann13_category`, which
    // held only the sales pair; a row saved before 2026-08-30 still answers
    // through the old column so nothing has to be re-classified.
    r.classify = led.classify || led.ann13_category || null;
    r.classifyNote = led.classify_note || '';

    // A confirmation that hasn't arrived is NOT a confirmed zero. Keeping the
    // two apart is what stops an unanswered party being reported as agreed.
    // Either figure arriving counts as the letter having come back — a party
    // with only exempt trade confirms a tax-free figure and nothing else.
    r.hasConfirmation = r.confirmed != null || r.confirmedFree != null;
    // Sign: CONFIRMATION − BOOKS, the CA's own reference workbook (2026-08-30,
    // user ask to follow that file). This REVERSES the 2026-08-16 decision to
    // print Books − Confirmation. His convention reads the way the work is
    // actually done: a POSITIVE difference means the party says they traded
    // more than the register holds, which is a bill still to be entered —
    // so the figure and the fix point the same way. Compared total-to-total
    // (taxable + tax free), as his Details sheet does.
    r.diff = r.hasConfirmation
      ? ((r.confirmed || 0) + (r.confirmedFree || 0)) - (r.taxable + r.taxfree)
      : null;
    r.status = !r.hasConfirmation ? 'pending'
             : (Math.abs(r.diff) <= SPB_CONFIRM_TOLERANCE ? 'ok' : 'flag');
    // Tiering is on the taxable figure INCLUDING omitted bills, because that is
    // the party's real trade for the year and what the annexure reports.
    r.tier = r.taxable >= SPB_CONFIRM_TIER ? 'major' : 'minor';
  });

  rows.sort((a, b) => b.taxable - a.taxable || (a.name < b.name ? -1 : 1));
  return rows;
}

// Why a party is flagged, when the answer is knowable. Two causes account for
// almost every real difference:
//
//  · a bill that surfaced after the register closed — the books are SHORT of
//    what the party confirmed, and an omitted bill is what fills the gap;
//  · one party split in two by a mistyped PAN. This is not hypothetical: in the
//    reference file a single purchase row carries Party E's
//    PAN on a Party A bill, which splits that party into a 57-row group
//    and a 1-row group and leaves the confirmation short by exactly the 1-row
//    group's Rs 626,504.45. The firm's own workbook grouped by name and never
//    saw it. Autobooks' duplicate-party review already offers the merge, so the
//    flag points at it rather than leaving the user to work it out.
function spbCfHint(r) {
  if (r.status !== 'flag') return '';
  if (spbCfInOpenMerge(r.key)) {
    return ' <span style="color:var(--text-muted); font-size:11px;">possible duplicate party — see Import › Possible duplicate parties</span>';
  }
  // Positive means the party confirms MORE than the register holds — under the
  // CA's sign that is the direction an omitted bill fixes.
  if (r.diff > 0 && r.omCount === 0) {
    return ' <span style="color:var(--text-muted); font-size:11px;">books are short — try an omitted bill</span>';
  }
  return '';
}

// A party key still sitting in an unapplied merge suggestion.
function spbCfInOpenMerge(key) {
  return (spbSuggestions || []).some(s => (s.members || []).some(m => m.key === key));
}

function spbCfVisible(rows) {
  const q = spbCfSearch.trim().toUpperCase();
  return rows.filter(r =>
    (!q || r.name.toUpperCase().includes(q) || String(r.pan).includes(q)) &&
    (spbCfStatusFilter === 'all' || r.status === spbCfStatusFilter));
}

const SPB_CF_SUM_KEYS = ['opening', 'taxfree', 'bookTaxable', 'omTaxable', 'taxable', 'vat', 'confirmedFree', 'confirmed', 'diff', 'closing'];

function spbCfTotals(rows) {
  const t = {};
  SPB_CF_SUM_KEYS.forEach(k => { t[k] = 0; });
  rows.forEach(r => SPB_CF_SUM_KEYS.forEach(k => { t[k] += Number(r[k]) || 0; }));
  return t;
}

// ── Persistence ─────────────────────────────────────────────────────────────
// Every figure on this screen is typed off a signed letter, so each one is
// saved the moment the field is left rather than behind a Save button someone
// can walk away from.
async function spbCfSetField(idx, field, raw) {
  const r = spbCfRows[idx];
  if (!r || !spbBookId) return;
  const value = String(raw).trim() === '' ? null
              : (field === 'remarks' ? String(raw) : spbNum(raw));
  const col = { opening: 'opening_balance', confirmed: 'confirmed_taxable',
                confirmedFree: 'confirmed_taxfree',
                closing: 'confirmed_closing', remarks: 'remarks' }[field];
  if (!col) return;
  // Columns added by db/2026-08-30_autobooks_ca_workflow.sql. Code ships before
  // the migration (CLAUDE.md §15), so writing one before it lands must fail
  // softly and say why — never lose the rest of the row's edit.
  if (SPB_CF_NEW_COLUMNS.includes(col) && spbCfMissingColumns.has(col)) {
    spbCfStatus(spbCfMigrationNote(col), 'info');
    return;
  }

  const cell = document.getElementById('spb-cf-save-' + idx);
  if (cell) cell.textContent = '…';
  try {
    let led = spbLedgerParties[spbCfSection + '|' + r.key];
    if (led && led.id) {
      const { error } = await window.sb.from('autobooks_parties')
        .update({ [col]: value, updated_by: (window.currentUser && window.currentUser.email) || null })
        .eq('id', led.id);
      if (error) throw error;
      led[col] = value;
    } else {
      // A party first met on an omitted bill has no ledger row until now.
      const { data, error } = await window.sb.from('autobooks_parties').insert({
        book_id: spbBookId, section: spbCfSection, party_key: r.key,
        party_name: r.name, pan: r.pan || null, [col]: value,
        updated_by: (window.currentUser && window.currentUser.email) || null,
      }).select().limit(1);
      if (error) throw error;
      led = (data && data[0]) || null;
      if (led) spbLedgerParties[spbCfSection + '|' + r.key] = led;
    }
    r[field] = value;
    spbCfRecompute(idx);
    if (cell) { cell.textContent = '✓'; setTimeout(() => { if (cell) cell.textContent = ''; }, 1400); }
  } catch (err) {
    console.error('[Autobooks] confirmation save failed', err);
    if (cell) cell.textContent = '!';
    // PostgREST answers PGRST204 for a column its schema cache doesn't know —
    // i.e. the migration hasn't been applied to this database yet. That is a
    // deployment state, not a fault the user caused, so it is reported as such
    // and the field is disabled rather than failing again on every keystroke.
    if (SPB_CF_NEW_COLUMNS.includes(col) && spbCfIsMissingColumn(err)) {
      spbCfMissingColumns.add(col);
      spbCfStatus(spbCfMigrationNote(col), 'info');
      spbRenderConfirmTable();
      return;
    }
    spbCfStatus('❌ Could not save that figure: ' + escHtml(friendlyDbError(err)), 'error');
  }
}

// ── While the migration is pending ──────────────────────────────────────────
const SPB_CF_NEW_COLUMNS = ['confirmed_taxfree', 'classify', 'classify_note'];
const spbCfMissingColumns = new Set();

function spbCfIsMissingColumn(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 'PGRST204' || code === '42703' ||
    /could not find .* column|column .* does not exist/i.test(msg);
}

function spbCfMigrationNote(col) {
  return `ℹ️ This column isn't in the database yet — <code>${escHtml(col)}</code> arrives with ` +
    `<code>db/2026-08-30_autobooks_ca_workflow.sql</code>. Everything else on this screen saves normally; ` +
    `apply that migration and this field starts working, with nothing to re-enter.`;
}

// Patch the derived cells in place rather than re-rendering — a full redraw
// while someone is tabbing through 200 parties would throw away their focus
// and their scroll position on every single field.
function spbCfRecompute(idx) {
  const r = spbCfRows[idx];
  r.hasConfirmation = r.confirmed != null || r.confirmedFree != null;
  r.diff = r.hasConfirmation
    ? ((r.confirmed || 0) + (r.confirmedFree || 0)) - (r.taxable + r.taxfree)
    : null;
  r.status = !r.hasConfirmation ? 'pending'
           : (Math.abs(r.diff) <= SPB_CONFIRM_TOLERANCE ? 'ok' : 'flag');
  const diffEl = document.getElementById('spb-cf-diff-' + idx);
  if (diffEl) {
    diffEl.textContent = r.diff == null ? '—' : spbFmt(r.diff);
    diffEl.style.color = r.status === 'flag' ? 'var(--red-dk)' : (r.status === 'ok' ? 'var(--green-dk)' : '');
    diffEl.style.fontWeight = r.status === 'flag' ? '700' : '';
  }
  const stEl = document.getElementById('spb-cf-st-' + idx);
  if (stEl) {
    const s = SPB_CONFIRM_STATUS[r.status];
    stEl.innerHTML = `<span class="log-badge ${s.badge}">${escHtml(s.label)}</span>` + spbCfHint(r);
  }
  spbCfPatchTotals();
}

function spbCfPatchTotals() {
  ['major', 'minor', 'all'].forEach(scope => {
    const rows = scope === 'all' ? spbCfRows : spbCfRows.filter(r => r.tier === scope);
    const t = spbCfTotals(spbCfVisible(rows));
    SPB_CF_SUM_KEYS.forEach(k => {
      const el = document.getElementById(`spb-cf-t-${scope}-${k}`);
      if (el) el.textContent = spbFmt(t[k]);
    });
  });
}

// ── Opening balances carried from the prior year ────────────────────────────
// "with the ability to carry forward each party's opening balance from the
// prior year" (§2.4). Matched on party_key, and it only ever FILLS a blank —
// overwriting an opening balance someone already typed would silently rewrite
// audited work.
async function spbCarryForwardOpenings() {
  const ident = spbBookIdentity();
  if (!ident || !spbBookId) return;
  const y = spbFyStartYear();
  if (!y) return;
  const prevFy = (y - 1) + '-' + String(y % 100).padStart(2, '0');
  if (!confirm(`Carry each party's closing balance from F.Y. ${prevFy} into this year's Opening Balance?\n\nOnly parties whose opening balance is still blank are filled. Nothing already typed is changed.`)) return;
  spbCfStatus('⏳ Looking for last year\'s book…', 'searching');
  try {
    const prev = await spbFindBookRow({ ...ident, fiscal_year: prevFy });
    if (!prev) { spbCfStatus(`ℹ️ No saved Autobooks book for ${escHtml(ident.client_name)}, F.Y. ${escHtml(prevFy)} — nothing to carry forward.`, 'info'); return; }
    const prevRows = await sbFetchAll(() => window.sb.from('autobooks_parties')
      .select('*').eq('book_id', prev.id).order('id', { ascending: true }));
    const byKey = new Map(prevRows.map(p => [p.section + '|' + p.party_key, p]));

    let filled = 0, noMatch = 0, noClosing = 0;
    for (const r of spbCfRows) {
      if (r.opening != null) continue;
      const p = byKey.get(spbCfSection + '|' + r.key);
      if (!p) { noMatch++; continue; }
      if (p.confirmed_closing == null) { noClosing++; continue; }
      const idx = spbCfRows.indexOf(r);
      await spbCfSetField(idx, 'opening', p.confirmed_closing);
      filled++;
    }
    spbRenderConfirmTable();
    AuditLog.record('spb_openings_carried', {
      module: 'salesPurchaseBook', clientName: ident.client_name, recordRef: spbBookId,
      detail: { fiscalYear: ident.fiscal_year, fromFiscalYear: prevFy, section: spbCfSection, filled },
    });
    spbCfStatus(`✅ Filled ${filled} opening balance${filled === 1 ? '' : 's'} from F.Y. ${escHtml(prevFy)}.` +
      (noMatch ? ` ${noMatch} party(ies) weren't in last year's book.` : '') +
      (noClosing ? ` ${noClosing} had no closing balance recorded.` : ''), filled ? 'success' : 'info');
  } catch (err) {
    spbCfStatus('❌ Could not carry forward: ' + escHtml(friendlyDbError(err)), 'error');
  }
}

// ── Screen ──────────────────────────────────────────────────────────────────
function spbRenderConfirm() {
  const el = document.getElementById('spb-confirm-body');
  if (!el) return;
  if (!spbBookId) {
    el.innerHTML = spbSaveGateHtml('Confirmation figures are');
    return;
  }
  const available = SPB_SECTIONS.filter(s => (spbGroups && spbGroups[s.key]) || spbOmitted.some(x => x.section === s.key));
  if (!available.length) { el.innerHTML = '<p class="log-empty">No parties yet — import a book first.</p>'; return; }
  if (!available.some(s => s.key === spbCfSection)) spbCfSection = available[0].key;

  el.innerHTML = `
    <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px;">
      <div class="form-group" style="margin:0; min-width:170px;">
        <label>Register</label>
        <select id="spb-cf-sec" onchange="spbCfSection=this.value; spbRenderConfirmTable();">
          ${available.map(s => `<option value="${s.key}"${s.key === spbCfSection ? ' selected' : ''}>${escHtml(s.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0; min-width:200px;">
        <label>Search party or PAN</label>
        <input type="text" id="spb-cf-q" value="${escHtml(spbCfSearch)}" placeholder="Type to filter…"
               oninput="spbCfSearch=this.value; spbRenderConfirmTable();" />
      </div>
      <div class="form-group" style="margin:0; min-width:170px;">
        <label>Status</label>
        <select id="spb-cf-st" onchange="spbCfStatusFilter=this.value; spbRenderConfirmTable();">
          <option value="all">All parties</option>
          <option value="pending">Awaiting confirmation</option>
          <option value="ok">Matched</option>
          <option value="flag">Difference</option>
        </select>
      </div>
      <button class="btn btn-outline btn-sm" onclick="spbCarryForwardOpenings()">Carry forward openings</button>
      <button class="btn btn-outline btn-sm" onclick="spbPrintAllConfirmations()">Print / Preview all</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportConfirm('pdf')">Export PDF</button>
      <button class="btn btn-outline btn-sm" onclick="spbExportConfirm('excel')">Export Excel</button>
    </div>
    <div id="spb-cf-status"></div>
    <div id="spb-cf-summary"></div>
    <div id="spb-confirm-table"></div>`;
  const sel = document.getElementById('spb-cf-st');
  if (sel) sel.value = spbCfStatusFilter;
  spbRenderConfirmTable();
}

function spbCfMoneyInput(idx, field, value) {
  return `<input type="text" inputmode="decimal" class="spb-cf-in" value="${value == null ? '' : escHtml(String(value))}" ` +
    `onchange="spbCfSetField(${idx}, '${field}', this.value)" />`;
}

function spbRenderConfirmTable() {
  const host = document.getElementById('spb-confirm-table');
  if (!host) return;
  spbCfRows = spbConfirmRows(spbCfSection);
  const visible = spbCfVisible(spbCfRows);
  const anyOmitted = spbCfRows.some(r => r.omCount > 0);

  // Summary strip — the answer to "how much of this year's confirmation work
  // is actually done", which the row list alone never states.
  const counts = { pending: 0, ok: 0, flag: 0 };
  spbCfRows.forEach(r => { counts[r.status]++; });
  const sum = document.getElementById('spb-cf-summary');
  if (sum) {
    sum.innerHTML = `<div class="log-sub" style="margin-bottom:14px;">
      <span class="log-badge badge-sent">${counts.ok} matched</span>
      <span class="log-badge badge-error" style="margin-left:6px;">${counts.flag} with a difference</span>
      <span class="log-badge badge-neutral" style="margin-left:6px;">${counts.pending} awaiting</span>
      <span style="margin-left:10px;">of ${spbCfRows.length} parties in the ${escHtml(spbCfSection === 'sales' ? 'Sales' : 'Purchase')} register</span>
      ${anyOmitted ? '<br>Taxable below is the register <strong>plus</strong> that party\'s omitted bills — that is the figure a confirmation is compared against.' : ''}
    </div>`;
  }

  const tiers = [
    { key: 'major', title: `Transactions of Rs ${spbFmt(SPB_CONFIRM_TIER)} and above`,
      note: 'Reported separately on Annexure-13.', open: true },
    { key: 'minor', title: `Transactions below Rs ${spbFmt(SPB_CONFIRM_TIER)}`,
      note: 'Kept apart from the tier above; totalled on its own.', open: spbCfShowMinor },
  ];

  const cols = 12 + (anyOmitted ? 1 : 0);
  let html = `<div class="table-wrap" style="overflow-x:auto;"><table class="client-table spb-cf-table" style="font-size:12.5px;">
    <thead><tr>
      <th>#</th><th>Party Name</th><th>Pan No.</th>
      <th style="text-align:right;">Opening Balance</th>
      <th style="text-align:right;">Tax Free</th>
      <th style="text-align:right;">Taxable — Books</th>
      ${anyOmitted ? '<th style="text-align:right;">Omitted</th>' : ''}
      <th style="text-align:right;">Taxable — Total</th>
      <th style="text-align:right;">As per Confirmation Tax Free</th>
      <th style="text-align:right;">As Per Confirmation Taxable</th>
      <th style="text-align:right;">Difference</th>
      <th style="text-align:right;">Closing Balance</th>
      <th>Remarks</th>
    </tr></thead><tbody>`;

  tiers.forEach(tier => {
    const mine = visible.filter(r => r.tier === tier.key);
    const t = spbCfTotals(mine);
    html += `<tr class="spb-cf-tier"><td colspan="${cols}">
      <button type="button" class="btn btn-outline btn-sm" style="margin-right:10px;"
        onclick="spbCfToggleTier('${tier.key}')">${tier.open ? '▾' : '▸'}</button>
      <strong>${escHtml(tier.title)}</strong>
      <span class="spb-cf-tier-note"> — ${mine.length} part${mine.length === 1 ? 'y' : 'ies'} · ${escHtml(tier.note)}</span>
    </td></tr>`;

    if (tier.open) {
      if (!mine.length) {
        html += `<tr><td colspan="${cols}" style="text-align:center; color:var(--text-muted); padding:18px;">No parties in this tier match the current filter.</td></tr>`;
      }
      mine.forEach((r, n) => {
        const idx = spbCfRows.indexOf(r);
        const s = SPB_CONFIRM_STATUS[r.status];
        html += `<tr>
          <td>${n + 1}</td>
          <td><div style="font-weight:600;">${escHtml(r.name)}</div>
              <div id="spb-cf-st-${idx}" style="margin-top:3px;"><span class="log-badge ${s.badge}">${escHtml(s.label)}</span>${spbCfHint(r)}</div>
              ${!r.fromBook ? '<div style="font-size:11px; color:var(--amber-dk);">Only on omitted bills</div>' : ''}</td>
          <td>${escHtml(r.pan)}</td>
          <td style="text-align:right;">${spbCfMoneyInput(idx, 'opening', r.opening)}</td>
          <td style="text-align:right;">${spbFmt(r.taxfree)}</td>
          <td style="text-align:right;">${spbFmt(r.bookTaxable)}</td>
          ${anyOmitted ? `<td style="text-align:right;${r.omTaxable < 0 ? 'color:var(--red-dk);' : ''}">${r.omCount ? spbFmt(r.omTaxable) : '—'}</td>` : ''}
          <td style="text-align:right; font-weight:600;">${spbFmt(r.taxable)}</td>
          <td style="text-align:right;">${spbCfMoneyInput(idx, 'confirmedFree', r.confirmedFree)}</td>
          <td style="text-align:right;">${spbCfMoneyInput(idx, 'confirmed', r.confirmed)}</td>
          <td id="spb-cf-diff-${idx}" style="text-align:right;${r.status === 'flag' ? 'color:var(--red-dk); font-weight:700;' : (r.status === 'ok' ? 'color:var(--green-dk);' : '')}">${r.diff == null ? '—' : spbFmt(r.diff)}</td>
          <td style="text-align:right;">${spbCfMoneyInput(idx, 'closing', r.closing)}</td>
          <td><input type="text" class="spb-cf-in spb-cf-remarks" value="${escHtml(r.remarks)}" onchange="spbCfSetField(${idx}, 'remarks', this.value)" />
              <button class="btn btn-outline btn-sm" style="margin-top:5px;" onclick="spbPrintConfirmStatement(${idx})">Statement</button>
              <span id="spb-cf-save-${idx}" style="margin-left:6px; color:var(--green-dk); font-weight:700;"></span></td>
        </tr>`;
      });
    }

    html += `<tr class="spb-cf-tot">
      <td colspan="3">Total — ${escHtml(tier.title)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-opening">${spbFmt(t.opening)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-taxfree">${spbFmt(t.taxfree)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-bookTaxable">${spbFmt(t.bookTaxable)}</td>
      ${anyOmitted ? `<td style="text-align:right;" id="spb-cf-t-${tier.key}-omTaxable">${spbFmt(t.omTaxable)}</td>` : ''}
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-taxable">${spbFmt(t.taxable)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-confirmedFree">${spbFmt(t.confirmedFree)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-confirmed">${spbFmt(t.confirmed)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-diff">${spbFmt(t.diff)}</td>
      <td style="text-align:right;" id="spb-cf-t-${tier.key}-closing">${spbFmt(t.closing)}</td>
      <td></td></tr>`;
  });

  const all = spbCfTotals(visible);
  html += `<tr class="spb-cf-grand">
      <td colspan="3">Grand Total</td>
      <td style="text-align:right;" id="spb-cf-t-all-opening">${spbFmt(all.opening)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-taxfree">${spbFmt(all.taxfree)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-bookTaxable">${spbFmt(all.bookTaxable)}</td>
      ${anyOmitted ? `<td style="text-align:right;" id="spb-cf-t-all-omTaxable">${spbFmt(all.omTaxable)}</td>` : ''}
      <td style="text-align:right;" id="spb-cf-t-all-taxable">${spbFmt(all.taxable)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-confirmedFree">${spbFmt(all.confirmedFree)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-confirmed">${spbFmt(all.confirmed)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-diff">${spbFmt(all.diff)}</td>
      <td style="text-align:right;" id="spb-cf-t-all-closing">${spbFmt(all.closing)}</td>
      <td></td></tr></tbody></table></div>`;
  host.innerHTML = html;
}

function spbCfToggleTier(key) {
  if (key === 'minor') spbCfShowMinor = !spbCfShowMinor;
  spbRenderConfirmTable();
}

// ── Statements ──────────────────────────────────────────────────────────────
// One party's reconciliation, laid out the way the firm reads it: what the
// books say, what the confirmation says, and the gap between them named
// explicitly rather than left to be worked out.
function spbConfirmStatementHtml(r) {
  const line = (label, value, opts) => {
    const o = opts || {};
    return `<tr${o.style || ''}><td${o.indent ? ' style="padding-left:22px;"' : ''}>${escHtml(label)}</td>` +
      `<td style="text-align:right;${o.color ? 'color:' + o.color + ';' : ''}${o.bold ? 'font-weight:700;' : ''}">` +
      `${value == null ? '–' : spbFmt(value)}</td></tr>`;
  };
  const s = SPB_CONFIRM_STATUS[r.status];
  let html = `<div style="page-break-after:always;">
    <div style="margin:14px 0 8px;">
      <div style="font-weight:800; font-size:13px;">${escHtml(r.name)}</div>
      <div style="font-size:11px; color:#444;">${r.pan ? 'PAN: ' + escHtml(r.pan) : 'PAN not recorded'} ·
        ${escHtml(r.tier === 'major' ? 'Rs ' + spbFmt(SPB_CONFIRM_TIER) + ' and above' : 'Below Rs ' + spbFmt(SPB_CONFIRM_TIER))} ·
        <span class="log-badge ${s.badge}">${escHtml(s.label)}</span></div>
    </div>
    <table style="max-width:560px;"><thead><tr><th>Particulars</th><th style="text-align:right;">Amount (Rs.)</th></tr></thead><tbody>`;
  html += line('Opening Balance', r.opening);
  html += line('Tax Free', r.taxfree);
  html += line('Taxable Amount as per Books', r.bookTaxable);
  if (r.omCount) {
    html += line(`Add: omitted bills entered after close (${r.omCount})`, r.omTaxable,
      { indent: true, color: r.omTaxable < 0 ? 'var(--red-dk)' : '' });
    html += line('Taxable Amount as per Books (including omitted)', r.taxable, { bold: true });
  }
  html += line('VAT', r.vat);
  html += line('Total as per Books', r.total, { bold: true });
  html += line('Tax Free Amount as per Confirmation', r.confirmedFree);
  html += line('Taxable Amount as per Confirmation', r.confirmed);
  html += line('Difference (Confirmation − Books)', r.diff,
    { bold: true, color: r.status === 'flag' ? 'var(--red-dk)' : (r.status === 'ok' ? 'var(--green-dk)' : '') });
  html += line('Closing Balance', r.closing);
  html += `</tbody></table>`;
  if (r.status === 'pending') {
    html += `<p style="font-size:11px; color:#444; margin-top:8px;">No confirmation has been received from this party yet. The difference is not a nil difference.</p>`;
  } else if (r.status === 'flag') {
    html += `<p style="font-size:11px; color:#444; margin-top:8px;">The difference exceeds Rs ${spbFmt(SPB_CONFIRM_TOLERANCE)} and requires explanation.</p>`;
  }
  if (r.remarks) html += `<p style="font-size:11px; margin-top:6px;"><strong>Remarks:</strong> ${escHtml(r.remarks)}</p>`;
  return html + `</div>`;
}

function spbCfSectionLabel() {
  return (SPB_SECTIONS.find(s => s.key === spbCfSection) || {}).label || spbCfSection;
}

function spbPrintConfirmStatement(idx) {
  const r = spbCfRows[idx];
  if (!r) return;
  spbOpenPrint(spbPrintDoc('Confirmation Reconciliation',
    `${spbCfSectionLabel()} · F.Y. ${spbVal('spb-fy')}`, spbConfirmStatementHtml(r)));
  AuditLog.record('spb_confirmation_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), section: spbCfSection, party: r.name, scope: 'single' },
  });
}

function spbPrintAllConfirmations() {
  const visible = spbCfVisible(spbCfRows);
  if (!visible.length) return;
  let body = '';
  [['major', `Transactions of Rs ${spbFmt(SPB_CONFIRM_TIER)} and above`],
   ['minor', `Transactions below Rs ${spbFmt(SPB_CONFIRM_TIER)}`]].forEach(([tier, title]) => {
    const mine = visible.filter(r => r.tier === tier);
    if (!mine.length) return;
    // The two tiers are reported differently on the annexure, so they are
    // separated here by a real heading and their own total — never just sorted
    // together.
    body += `<h2 style="font-size:13px; margin:20px 0 4px; border-bottom:2px solid #0b1f3d; padding-bottom:4px;">${escHtml(title)}</h2>
      <p style="font-size:11px; color:#444; margin:0 0 8px;">${mine.length} part${mine.length === 1 ? 'y' : 'ies'}</p>`;
    mine.forEach(r => { body += spbConfirmStatementHtml(r); });
    const t = spbCfTotals(mine);
    body += `<table style="max-width:560px;"><tbody>
      <tr style="background:#fffbe6; font-weight:700;"><td>Total — ${escHtml(title)}</td>
      <td style="text-align:right;">Taxable ${spbFmt(t.taxable)} · Confirmed ${spbFmt(t.confirmed)} · Difference ${spbFmt(t.diff)}</td></tr>
      </tbody></table>`;
  });
  const all = spbCfTotals(visible);
  body += `<table style="max-width:560px; margin-top:14px;"><tbody>
    <tr style="background:#fff3e0; font-weight:800;"><td>Grand Total — both tiers</td>
    <td style="text-align:right;">Taxable ${spbFmt(all.taxable)} · Confirmed ${spbFmt(all.confirmed)} · Difference ${spbFmt(all.diff)}</td></tr>
    </tbody></table>`;
  spbOpenPrint(spbPrintDoc('Confirmation Reconciliation — all parties',
    `${spbCfSectionLabel()} · F.Y. ${spbVal('spb-fy')}`, body));
  AuditLog.record('spb_confirmation_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), section: spbCfSection, parties: visible.length, scope: 'all' },
  });
}

// ── PDF / Excel via ReportExport ────────────────────────────────────────────
// A plain tabular report goes through the engine rather than a hand-rolled
// generator (CLAUDE.md §8) — it already knows the firm's column styling, the
// accounting number format and the section/total/grand row idiom.
function spbConfirmExportModel() {
  const visible = spbCfVisible(spbCfRows);
  const anyOmitted = spbCfRows.some(r => r.omCount > 0);
  const columns = [
    { label: 'S.No.', align: 'l', w: 5 },
    { label: 'Party Name', align: 'l', w: 26 },
    { label: 'Pan No.', align: 'l', w: 10 },
    { label: 'Opening Balance', align: 'r', num: true, w: 11 },
    { label: 'Tax Free', align: 'r', num: true, w: 9 },
    { label: 'Taxable — Books', align: 'r', num: true, w: 12 },
  ];
  if (anyOmitted) columns.push({ label: 'Omitted', align: 'r', num: true, w: 10 });
  columns.push(
    { label: 'Taxable — Total', align: 'r', num: true, w: 12 },
    { label: 'As per Confirmation Tax Free', align: 'r', num: true, w: 12 },
    { label: 'As Per Confirmation Taxable', align: 'r', num: true, w: 12 },
    { label: 'Difference', align: 'r', num: true, w: 11 },
    { label: 'Closing Balance', align: 'r', num: true, w: 11 },
    { label: 'Status', align: 'l', w: 9 });

  const rows = [];
  [['major', `Transactions of Rs ${spbFmt(SPB_CONFIRM_TIER)} and above`],
   ['minor', `Transactions below Rs ${spbFmt(SPB_CONFIRM_TIER)}`]].forEach(([tier, title]) => {
    const mine = visible.filter(r => r.tier === tier);
    if (!mine.length) return;
    rows.push({ cells: [title], style: 'section' });
    mine.forEach((r, i) => {
      const cells = [i + 1, r.name, r.pan, r.opening, r.taxfree, r.bookTaxable];
      if (anyOmitted) cells.push(r.omCount ? r.omTaxable : null);
      cells.push(r.taxable, r.confirmedFree, r.confirmed, r.diff, r.closing, SPB_CONFIRM_STATUS[r.status].label);
      rows.push({ cells });
    });
    const t = spbCfTotals(mine);
    const tc = ['', 'Total — ' + title, '', t.opening, t.taxfree, t.bookTaxable];
    if (anyOmitted) tc.push(t.omTaxable);
    tc.push(t.taxable, t.confirmedFree, t.confirmed, t.diff, t.closing, '');
    rows.push({ cells: tc, style: 'total' });
  });
  const all = spbCfTotals(visible);
  const gc = ['', 'Grand Total', '', all.opening, all.taxfree, all.bookTaxable];
  if (anyOmitted) gc.push(all.omTaxable);
  gc.push(all.taxable, all.confirmedFree, all.confirmed, all.diff, all.closing, '');
  rows.push({ cells: gc, style: 'grand' });

  return {
    title: spbCfSectionLabel() + ' Details',
    subtitleLines: [
      spbVal('spb-company') + (spbVal('spb-pan') ? '  ·  PAN ' + spbVal('spb-pan') : ''),
      'F.Y. ' + spbVal('spb-fy') + '  ·  Difference = Confirmation − Books',
      `Matched within Rs ${spbFmt(SPB_CONFIRM_TOLERANCE)}; anything beyond is reported as a difference.`,
    ],
    columns, rows, landscape: true,
    note: anyOmitted ? 'Taxable — Total includes bills entered after the register was closed.' : '',
  };
}

async function spbExportConfirm(kind) {
  if (!spbCfRows.length) return;
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    const name = `Confirmation Reconciliation - ${spbCfSectionLabel()} - ${spbVal('spb-company')} ${spbVal('spb-fy')}.${ext}`;
    // download() builds, saves AND logs through DocumentEngine in one call —
    // the engine's own convenience path, so this doesn't hand-roll a blob or a
    // second AuditLog entry.
    await ReportExport.download(spbConfirmExportModel(), kind, name, {
      module: 'salesPurchaseBook', clientName: spbVal('spb-company'),
      sheetName: 'Confirmation ' + spbCfSectionLabel(),
    });
    spbCfStatus('✅ Exported.', 'success');
  } catch (err) {
    console.error('[Autobooks] confirmation export failed', err);
    spbCfStatus('❌ Could not export: ' + escHtml(friendlyDbError(err)), 'error');
  }
}

// ── Registration ──
// Appended rather than declared in the ledger file, so this section only exists
// once the screen behind it does.
// Registered as "Parties", not "Confirmation" (2026-08-30, user ask backed by
// the CA's workbook). He has no Confirmation sheet: the as-per-confirmation
// figures are two COLUMNS on his Sales/Purchase Details sheet, beside the
// party's own book totals, because that is the only place they mean anything.
// The screen is the same one — this is the party ledger, and a confirmation is
// something a party has, not a place you go.
SPB_SECTION_TABS.push({ key: 'confirm', label: 'Parties', panel: 'spb-sec-confirm', onShow: 'spbRenderConfirm' });
spbRenderSectionNav();
