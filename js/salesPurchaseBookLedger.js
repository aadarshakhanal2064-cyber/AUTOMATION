// ════════════════════════════════════════════
//  AUTOBOOKS — LEDGER LAYER
//
//  Autobooks proper (js/salesPurchaseBook.js) turns an uploaded raw book into
//  a workbook and forgets everything the moment the tab closes. That is the
//  right shape for a converter and the wrong shape for the work that follows
//  it: confirmations come back from parties over WEEKS, one signed letter at a
//  time, and each one has to be recorded against a party whose book figures
//  were computed from a file uploaded long before. Re-uploading the workbook
//  to type one more figure is the Excel workflow this module exists to end.
//
//  So this file gives Autobooks a memory (db/2026-08-16_autobooks_ledger.sql)
//  and the screens that memory makes possible. It owns:
//
//   · the section switcher — Autobooks is now several screens, not one very
//     long scroll, and this is what decides which is visible
//   · save / load of a book (client + fiscal year) and the rehydration that
//     puts a saved book back into the SAME module state an upload produces,
//     so everything downstream works identically either way
//   · the in-app Register view and its print/PDF output
//
//  DELIBERATELY A SEPARATE FILE. salesPurchaseBook.js is already ~2,360 lines
//  (CLAUDE.md §10 rule 5) and its own doc calls for splitting before growth,
//  not after. The `spb` function prefix and the `spb-` element prefix continue
//  here unchanged — this is the same module in two files, the
//  finStatement.js / finStatementExport.js precedent (§5).
// ════════════════════════════════════════════

// ── Section switcher ────────────────────────────────────────────────────────
// Registered by each part of Autobooks as it becomes available, so a tab never
// appears before the screen behind it does. Order here is the order on screen,
// and it follows the actual work: import the book, read the register, record
// what came back, report it.
const SPB_SECTION_TABS = [
  { key: 'import',   label: 'Import',   panel: 'spb-sec-import' },
  { key: 'register', label: 'Register', panel: 'spb-sec-register' },
];

let spbSection = 'import';

function spbShowSection(key) {
  if (!SPB_SECTION_TABS.some(t => t.key === key)) return;
  spbSection = key;
  SPB_SECTION_TABS.forEach(t => {
    const el = document.getElementById(t.panel);
    if (el) el.style.display = t.key === key ? '' : 'none';
  });
  spbRenderSectionNav();
  if (key === 'register') spbRenderRegister();
}

function spbRenderSectionNav() {
  const nav = document.getElementById('spb-section-nav');
  if (!nav) return;
  nav.innerHTML = SPB_SECTION_TABS.map(t =>
    `<button type="button" class="rep-view-btn${t.key === spbSection ? ' active' : ''}" ` +
    `onclick="spbShowSection('${t.key}')">${escHtml(t.label)}</button>`
  ).join('');
}

// ════════════════════════════════════════════
//  LEDGER STATE
//
//  Kept separate from spbData/spbGroups (which are DERIVED from the book and
//  recomputed on every reparse) because everything here is either a database
//  identity or a figure a human typed. Recomputing must never touch it.
// ════════════════════════════════════════════
let spbBookId = null;        // autobooks_books.id once saved or loaded
let spbBookMeta = null;      // the saved row itself (updated_at, created_by, …)
let spbOmitted = [];         // autobooks_entries rows with kind='omitted'
let spbLedgerParties = {};   // 'section|partyKey' → autobooks_parties row
let spbAdjustments = [];     // autobooks_adjustments rows
let spbDirty = false;        // book differs from what is stored

function spbLedgerStatus(html, type) { showStatus(html, type, 'spb-ledger-status'); }

// Cleared alongside the derived state whenever the module resets. Called from
// spbReset() in salesPurchaseBook.js — a client switch must not leave the
// previous client's book id pointing at the next client's screen.
function spbLedgerReset() {
  spbBookId = null; spbBookMeta = null;
  spbOmitted = []; spbLedgerParties = {}; spbAdjustments = [];
  spbDirty = false;
  spbShowSection('import');
  spbRenderBookCard();
}

// ── Book identity ──
// A book is one (client, fiscal year). The client may be a directory client or
// a name typed by hand — the same nullable-client_id fallback
// service_memo_fee_skips uses, because Autobooks legitimately gets used on a
// company before anyone adds it to the directory.
function spbBookIdentity() {
  const name = spbVal('spb-company');
  const fy = spbVal('spb-fy');
  if (!name || !fy) return null;
  return {
    client_id: spbClientId != null ? spbClientId : null,
    client_name: name,
    pan: spbVal('spb-pan') || null,
    fiscal_year: fy,
    reg_type: spbIsPanOnly() ? 'pan' : 'vat',
  };
}

// ════════════════════════════════════════════
//  SAVE
//
//  Deliberately select-then-insert-or-update rather than a PostgREST upsert:
//  the uniqueness that matters lives in `book_key`, a GENERATED column, and a
//  merge-duplicates upsert would have to name it as the conflict target while
//  not sending it in the payload. Two round trips, no ambiguity.
// ════════════════════════════════════════════
async function spbFindBookRow(ident) {
  let q = supabaseClient.from('autobooks_books').select('*').eq('fiscal_year', ident.fiscal_year);
  q = ident.client_id != null
    ? q.eq('client_id', ident.client_id)
    : q.is('client_id', null).ilike('client_name', ident.client_name);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Everything the parser decided, so a reopened book reproduces the same
// figures instead of asking the user to re-approve every merge and correction.
function spbBookPayload(ident) {
  const sections = {};
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData || !spbData[key]) return;
    sections[key] = { stats: spbData[key].stats, source: spbData[key].source || '' };
  });
  return {
    ...ident,
    merge_map: spbMergeMap || {},
    overrides: spbOverrides || {},
    correction_log: spbCorrectionLog || [],
    vat_return: spbVr || {},
    import_notes: spbImportNotes || [],
    sections,
    updated_by: (window.currentUser && window.currentUser.email) || null,
  };
}

// One transaction → one autobooks_entries row. The parser's short amount keys
// (taxfree/imp/cap…) become the table's spelled-out columns here and ONLY
// here, so neither side has to know the other's naming.
function spbEntryRow(bookId, section, x, i) {
  return {
    book_id: bookId, section, kind: 'regular',
    bs_date: x.date || null,
    fiscal_month: x.fi != null ? x.fi + 1 : null,   // 1 = Shrawan (CLAUDE.md §8)
    bill_no: x.bill != null && x.bill !== '' ? String(x.bill) : null,
    party_name: x.party || '',
    party_key: x.groupKey || '',
    pan: x.pan || null,
    tax_free: x.taxfree || 0, taxable: x.taxable || 0, vat: x.vat || 0,
    taxable_import: x.imp || 0, import_vat: x.impVat || 0,
    capital: x.cap || 0, capital_vat: x.capVat || 0,
    source: 'import', excel_row: x.xr != null ? x.xr : null, sort_order: i,
  };
}

// The party key a transaction ends up under, AFTER approved merges — the same
// key spbComputeGroups() uses, so a stored row and a live group agree.
function spbStampGroupKeys() {
  const pansBySafeKey = spbPansBySafeKey(spbAllTxns());
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData || !spbData[key]) return;
    spbData[key].txns.forEach(x => {
      const k = spbGroupKey(x, pansBySafeKey);
      x.groupKey = spbMergeMap[k] || k;
    });
  });
}

// Inserted in chunks: a real client-year runs to ~1,600 lines and a single
// request that large is both slower and harder to recover from than five.
const SPB_INSERT_CHUNK = 400;

async function spbInsertChunked(table, rows) {
  for (let i = 0; i < rows.length; i += SPB_INSERT_CHUNK) {
    const { error } = await supabaseClient.from(table).insert(rows.slice(i, i + SPB_INSERT_CHUNK));
    if (error) throw error;
  }
}

async function spbSaveBook() {
  const ident = spbBookIdentity();
  if (!ident) { spbLedgerStatus('❌ Choose a client and a fiscal year before saving.', 'error'); return; }
  if (!spbData || !SPB_SECTIONS.some(s => spbData[s.key])) {
    spbLedgerStatus('❌ Nothing to save — import a Sales or Purchase book first.', 'error'); return;
  }
  const btn = document.getElementById('spb-save-btn');
  if (btn) btn.disabled = true;
  spbLedgerStatus('⏳ Saving the book…', 'searching');
  try {
    spbStampGroupKeys();

    // 1. The book row.
    const existing = await spbFindBookRow(ident);
    const payload = spbBookPayload(ident);
    let row;
    if (existing) {
      const { data, error } = await supabaseClient.from('autobooks_books')
        .update(payload).eq('id', existing.id).select().limit(1);
      if (error) throw error;
      row = (data && data[0]) || existing;
    } else {
      payload.created_by = (window.currentUser && window.currentUser.email) || null;
      const { data, error } = await supabaseClient.from('autobooks_books')
        .insert(payload).select().limit(1);
      if (error) throw error;
      row = data && data[0];
    }
    if (!row) throw new Error('the book row came back empty');
    spbBookId = row.id; spbBookMeta = row;

    // 2. Bill lines. Replace, never merge: the uploaded file IS the register,
    //    so a re-import supersedes it outright. Only kind='regular' is touched
    //    — omitted bills are typed by hand and are not in the uploaded file.
    const { error: delErr } = await supabaseClient.from('autobooks_entries')
      .delete().eq('book_id', spbBookId).eq('kind', 'regular');
    if (delErr) throw delErr;

    const entries = [];
    SPB_SECTIONS.forEach(({ key }) => {
      if (!spbData[key]) return;
      spbData[key].txns.forEach((x, i) => entries.push(spbEntryRow(spbBookId, key, x, i)));
    });
    await spbInsertChunked('autobooks_entries', entries);

    // 3. Confirmation-ledger rows — one per party per register. Only MISSING
    //    ones are created. An existing row holds figures typed off a signed
    //    letter and is never overwritten by a re-import; its display name and
    //    PAN are refreshed, because a later merge can improve both.
    await spbSyncPartyRows();

    spbDirty = false;
    spbRenderBookCard();
    AuditLog.record('autobooks_book_saved', {
      clientName: ident.client_name, fiscalYear: ident.fiscal_year,
      recordRef: 'Book #' + spbBookId, entries: entries.length,
    });
    spbLedgerStatus(`✅ Saved — ${entries.length.toLocaleString('en-US')} bill lines and ` +
      `${Object.keys(spbLedgerParties).length} parties are now stored for ` +
      `${escHtml(ident.client_name)}, F.Y. ${escHtml(ident.fiscal_year)}.`, 'success');
  } catch (err) {
    console.error('[Autobooks] save failed', err);
    spbLedgerStatus('❌ Could not save: ' + escHtml(err.message || String(err)), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Creates the confirmation-ledger row for any party that doesn't have one yet
// and refreshes the display name/PAN of those that do. Never touches a typed
// figure — that is the whole contract of this table.
async function spbSyncPartyRows() {
  const wanted = [];
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbGroups || !spbGroups[key]) return;
    spbGroups[key].forEach(g => wanted.push({ section: key, party_key: g.key, party_name: g.display, pan: g.pan || null }));
  });

  const rows = await sbFetchAll(() => supabaseClient.from('autobooks_parties')
    .select('*').eq('book_id', spbBookId).order('id', { ascending: true }));
  const have = new Map(rows.map(r => [r.section + '|' + r.party_key, r]));

  const toInsert = [], toUpdate = [];
  wanted.forEach(w => {
    const cur = have.get(w.section + '|' + w.party_key);
    if (!cur) { toInsert.push({ book_id: spbBookId, ...w }); return; }
    if (cur.party_name !== w.party_name || (cur.pan || null) !== w.pan) toUpdate.push({ id: cur.id, ...w });
  });

  if (toInsert.length) await spbInsertChunked('autobooks_parties', toInsert);
  for (const u of toUpdate) {
    const { error } = await supabaseClient.from('autobooks_parties')
      .update({ party_name: u.party_name, pan: u.pan }).eq('id', u.id);
    if (error) throw error;
  }
  await spbLoadPartyRows();
}

async function spbLoadPartyRows() {
  if (!spbBookId) { spbLedgerParties = {}; return; }
  const rows = await sbFetchAll(() => supabaseClient.from('autobooks_parties')
    .select('*').eq('book_id', spbBookId).order('id', { ascending: true }));
  spbLedgerParties = {};
  rows.forEach(r => { spbLedgerParties[r.section + '|' + r.party_key] = r; });
}

// ════════════════════════════════════════════
//  LOAD + REHYDRATE
//
//  A loaded book must land in the SAME state an upload produces, or every
//  screen downstream would need two code paths. So the stored bill lines are
//  turned back into parser-shaped transactions and then run through the
//  module's OWN spbComputeBook() / spbComputeGroups() — the figures are
//  re-derived, never read back from a stored total that could have drifted.
//
//  What a loaded book deliberately does NOT get is spbRaw. There is no
//  uploaded sheet behind it, so Data Doctor, column mapping and reparse are
//  correctly unavailable: those answer "is this file being read correctly",
//  and the file was already read and corrected before it was saved. The
//  corrections themselves travel with the book (correction_log) and still
//  print in the workbook's Corrections sheet.
// ════════════════════════════════════════════
function spbTxnFromRow(r, i) {
  const d = String(r.bs_date || '');
  const m = d.match(SPB_DATE_RE);
  return {
    date: d,
    y: m ? parseInt(m[1], 10) : 0,
    mo: m ? parseInt(m[2], 10) : 0,
    m: m ? parseInt(m[2], 10) : 0,
    d: m ? parseInt(m[3], 10) : 0,
    fi: r.fiscal_month != null ? r.fiscal_month - 1 : 0,
    xr: r.excel_row != null ? r.excel_row : 0,
    bill: r.bill_no != null ? r.bill_no : '',
    party: r.party_name || '(UNNAMED)',
    pan: r.pan || '',
    groupKey: r.party_key || '',
    taxfree: Number(r.tax_free) || 0,
    taxable: Number(r.taxable) || 0,
    vat: Number(r.vat) || 0,
    imp: Number(r.taxable_import) || 0,
    impVat: Number(r.import_vat) || 0,
    cap: Number(r.capital) || 0,
    capVat: Number(r.capital_vat) || 0,
    src: i,
    section: r.section,
    // Only on omitted bills; carried so the register can label them.
    kind: r.kind, billType: r.bill_type || null, note: r.note || null, rowId: r.id,
  };
}

async function spbLoadBook(silent) {
  const ident = spbBookIdentity();
  if (!ident) return false;
  try {
    const row = await spbFindBookRow(ident);
    if (!row) {
      if (!silent) spbLedgerStatus('ℹ️ No saved book for this client and fiscal year yet.', 'info');
      spbRenderBookCard();
      return false;
    }
    spbBookId = row.id; spbBookMeta = row;

    const rows = await sbFetchAll(() => supabaseClient.from('autobooks_entries')
      .select('*').eq('book_id', row.id).order('id', { ascending: true }));

    spbOmitted = rows.filter(r => r.kind === 'omitted').map(spbTxnFromRow);

    // Rebuild the parser's state from the stored regular lines.
    spbMergeMap = row.merge_map || {};
    spbOverrides = row.overrides || { sales: {}, purchase: {} };
    spbCorrectionLog = row.correction_log || [];
    spbImportNotes = row.import_notes || [];
    spbVr = Object.keys(row.vat_return || {}).length ? row.vat_return : spbBlankVr();
    spbDismissed = new Set();
    spbData = { sales: null, purchase: null };
    SPB_SECTIONS.forEach(({ key }) => {
      const mine = rows.filter(r => r.section === key && r.kind === 'regular');
      if (!mine.length) return;
      const meta = (row.sections || {})[key] || {};
      spbData[key] = {
        txns: mine.map(spbTxnFromRow),
        stats: meta.stats || {},
        source: meta.source || 'Saved book',
      };
    });
    spbBook = spbComputeBook();
    spbGroups = spbComputeGroups();
    await spbLoadPartyRows();

    const { data: adj, error: adjErr } = await supabaseClient.from('autobooks_adjustments')
      .select('*').eq('book_id', row.id).order('sort_order', { ascending: true });
    if (adjErr) throw adjErr;
    spbAdjustments = adj || [];

    spbDirty = false;
    const regEl = document.getElementById('spb-regtype');
    if (regEl) regEl.value = row.reg_type || 'vat';

    const counts = SPB_SECTIONS.filter(s => spbData[s.key])
      .map(s => `${s.label}: ${spbData[s.key].txns.length.toLocaleString('en-US')}`);
    const genBtn = document.getElementById('spb-generate-btn');
    if (genBtn) genBtn.disabled = counts.length === 0;
    spbRenderVrGrid();
    spbRenderBookCard();
    spbRenderRegister();
    spbLedgerStatus(`✅ Opened the saved book — ${escHtml(counts.join(' · '))} bill lines` +
      (spbOmitted.length ? ` · ${spbOmitted.length} omitted` : '') + '.', 'success');
    return true;
  } catch (err) {
    console.error('[Autobooks] load failed', err);
    spbLedgerStatus('❌ Could not open the saved book: ' + escHtml(err.message || String(err)), 'error');
    return false;
  }
}

// Called when the client or fiscal year changes. Looks for a saved book
// silently — finding one is the common case when a staff member comes back to
// a client mid-confirmation, and making them click "Open" first would be noise.
async function spbLedgerOnContext() {
  spbBookId = null; spbBookMeta = null;
  spbOmitted = []; spbLedgerParties = {}; spbAdjustments = [];
  if (!spbBookIdentity()) { spbRenderBookCard(); return; }
  // An unsaved import in progress must never be silently replaced by a stored
  // book — the user is mid-correction on a file they just dropped.
  if (spbRaw) { spbRenderBookCard(); return; }
  await spbLoadBook(true);
}

// ── The saved-book card ──
function spbRenderBookCard() {
  const el = document.getElementById('spb-book-body');
  if (!el) return;
  const ident = spbBookIdentity();
  if (!ident) {
    el.innerHTML = '<p class="log-empty" style="padding:22px;">Choose a client and fiscal year above to save or open a book.</p>';
    return;
  }
  const canSave = !!(spbData && SPB_SECTIONS.some(s => spbData[s.key]));
  let meta = '';
  if (spbBookId && spbBookMeta) {
    const when = spbBookMeta.updated_at ? new Date(spbBookMeta.updated_at).toLocaleString() : '';
    const lines = SPB_SECTIONS.filter(s => spbData && spbData[s.key])
      .map(s => `${s.label} ${spbData[s.key].txns.length.toLocaleString('en-US')}`).join(' · ');
    meta = `<div class="log-sub" style="margin-bottom:14px;">
      <span class="log-badge ${spbDirty ? 'badge-amber">Unsaved changes' : 'badge-sent">Saved'}</span>
      &nbsp;${escHtml(lines)}${spbOmitted.length ? ' · ' + spbOmitted.length + ' omitted' : ''}
      ${when ? ' · last saved ' + escHtml(when) : ''}
      ${spbBookMeta.updated_by ? ' by ' + escHtml(spbBookMeta.updated_by) : ''}
      ${spbDirty ? '<br>The figures on screen have changed since the last save.' : ''}
    </div>`;
  } else {
    meta = `<div class="log-sub" style="margin-bottom:14px;">
      <span class="log-badge badge-neutral">Not saved</span>
      &nbsp;Nothing is stored for ${escHtml(ident.client_name)}, F.Y. ${escHtml(ident.fiscal_year)} yet.
      Saving keeps the register, the party list and every confirmation figure so you can come back to them without re-uploading.
    </div>`;
  }
  el.innerHTML = meta + `<div class="action-row" style="margin-top:0;">
      <button class="btn btn-primary btn-sm" id="spb-save-btn" onclick="spbSaveBook()"${canSave ? '' : ' disabled'}>
        ${spbBookId ? 'Save changes' : 'Save book to database'}
      </button>
      <button class="btn btn-outline btn-sm" onclick="spbLoadBook(false)">Open saved book</button>
    </div>
    <div id="spb-ledger-status"></div>`;
}

// ════════════════════════════════════════════
//  REGISTER VIEW
//
//  The Sales / Purchase register as the firm reads it on paper: bills in
//  fiscal-month order, a "Total Of <Month>" line after each month, and — after
//  the Ashadh total — the omitted bills, exactly where the firm's own template
//  says they belong ("Omiited bill show display in last of Sales Register and
//  Purchase register after total of month ashad"). They are appended, never
//  merged into the month they logically belong to, and then counted once in a
//  grand total that says so on its face.
// ════════════════════════════════════════════

// Which amount columns to draw. Value-driven, not header-driven: a book loaded
// from the database has no uploaded sheet behind it, so spbSectionAmountKeys()
// (which reads header.col, and stays that way — the workbook must mirror the
// uploaded layout exactly) cannot answer this. Printing an all-zero Import
// column on every book would be noise, so a column appears only if some row in
// this section actually carries a figure.
function spbLedgerCols(section) {
  const rows = spbRegisterRows(section);
  return SPB_AMOUNT_FIELDS.filter(f =>
    f.key === 'taxfree' || f.key === 'taxable' || f.key === 'vat' ||
    rows.some(x => (x[f.key] || 0) !== 0));
}

function spbRegisterRows(section) {
  const live = (spbData && spbData[section] && spbData[section].txns) || [];
  return live;
}

function spbOmittedFor(section) {
  return spbOmitted.filter(x => x.section === section);
}

// A return / debit note carries the opposite sign. This is what makes a
// party's books-vs-confirmation difference actually close: in the reference
// file, Party G's books exceeded its confirmation by 34,896 and the
// explanation was a 34,896 DEBIT NOTE, which reduces purchases.
function spbOmittedSign(x) {
  return /_return$/.test(String(x.billType || '')) ? -1 : 1;
}

function spbSumOver(list, cols) {
  const out = {};
  cols.forEach(c => { out[c.key] = 0; });
  list.forEach(x => {
    const s = x.__sign != null ? x.__sign : 1;
    cols.forEach(c => { out[c.key] += (x[c.key] || 0) * s; });
  });
  return out;
}

function spbRenderRegister() {
  const el = document.getElementById('spb-register-body');
  if (!el) return;
  const available = SPB_SECTIONS.filter(s => spbData && spbData[s.key]);
  if (!available.length) {
    el.innerHTML = '<p class="log-empty">No book loaded. Import a Sales or Purchase file, or open a saved book, from the <strong>Import</strong> tab.</p>';
    return;
  }
  const sel = document.getElementById('spb-reg-section');
  let section = sel && sel.value;
  if (!available.some(s => s.key === section)) section = available[0].key;

  el.innerHTML = `
    <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px;">
      <div class="form-group" style="margin:0; min-width:180px;">
        <label>Register</label>
        <select id="spb-reg-section" onchange="spbRenderRegister()">
          ${available.map(s => `<option value="${s.key}"${s.key === section ? ' selected' : ''}>${escHtml(s.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0; min-width:240px;">
        <label>Filter by party (optional)</label>
        <input type="text" id="spb-reg-party" placeholder="Type part of a party name…"
               oninput="spbRenderRegisterTable()" value="${escHtml(spbRegPartyFilter)}" />
      </div>
      <button class="btn btn-outline btn-sm" onclick="spbPrintRegister()">Print / Preview</button>
    </div>
    <div id="spb-register-table"></div>`;
  spbRenderRegisterTable();
}

let spbRegPartyFilter = '';

function spbRegisterSection() {
  const sel = document.getElementById('spb-reg-section');
  return (sel && sel.value) || (SPB_SECTIONS.find(s => spbData && spbData[s.key]) || {}).key;
}

// The full register model, shared by the on-screen table and the print view so
// the two can never show different figures.
function spbRegisterModel(section, filter) {
  const cols = spbLedgerCols(section);
  const f = String(filter || '').trim().toUpperCase();
  const match = x => !f || String(x.party || '').toUpperCase().includes(f);

  const body = [];
  const regular = spbRegisterRows(section).filter(match);
  SPB_MONTH_NAMES.forEach((name, fi) => {
    const mine = regular.filter(x => x.fi === fi).sort((a, b) => a.d - b.d || a.src - b.src);
    if (!mine.length) return;
    mine.forEach(x => body.push({ type: 'txn', x }));
    body.push({ type: 'subtotal', label: 'Total Of ' + name, sums: spbSumOver(mine, cols) });
  });

  const omitted = spbOmittedFor(section).filter(match)
    .map(x => ({ ...x, __sign: spbOmittedSign(x) }));
  if (omitted.length) {
    body.push({ type: 'heading', label: 'Omitted bills — received after the register was closed' });
    omitted.forEach(x => body.push({ type: 'txn', x, omitted: true }));
    body.push({ type: 'subtotal', label: 'Total Of Omitted Bills', sums: spbSumOver(omitted, cols) });
  }

  const all = regular.concat(omitted);
  return {
    cols, body, omittedCount: omitted.length,
    grand: spbSumOver(all, cols),
    bookOnly: spbSumOver(regular, cols),
  };
}

function spbRegCellHtml(x, cols) {
  const s = x.__sign != null ? x.__sign : 1;
  return cols.map(c => {
    const v = (x[c.key] || 0) * s;
    return `<td style="text-align:right;${v < 0 ? 'color:var(--red-dk);' : ''}">${spbFmt(v)}</td>`;
  }).join('');
}

function spbRegisterTableHtml(model, opts) {
  const o = opts || {};
  const cols = model.cols;
  const span = 4;
  let html = `<table class="client-table" style="font-size:12.5px;">
    <thead><tr>
      <th>Date</th><th>Bill No.</th><th>Party Name</th><th>Pan No.</th>
      ${cols.map(c => `<th style="text-align:right;">${escHtml(c.label)}</th>`).join('')}
    </tr></thead><tbody>`;
  model.body.forEach(r => {
    if (r.type === 'heading') {
      html += `<tr><td colspan="${span + cols.length}" style="background:var(--amber-bg); color:var(--amber-dk); font-weight:700; padding:11px 16px;">${escHtml(r.label)}</td></tr>`;
      return;
    }
    if (r.type === 'subtotal') {
      html += `<tr style="background:#fffbe6; font-weight:700;">
        <td colspan="${span}">${escHtml(r.label)}</td>
        ${cols.map(c => `<td style="text-align:right;">${spbFmt(r.sums[c.key])}</td>`).join('')}
      </tr>`;
      return;
    }
    const x = r.x;
    const tag = r.omitted && x.billType
      ? ` <span class="log-badge badge-amber" style="font-size:10.5px; padding:2px 8px;">${escHtml(SPB_BILL_TYPE_LABELS[x.billType] || x.billType)}</span>` : '';
    const note = r.omitted && x.note ? ` <span style="color:var(--text-muted);">· ${escHtml(x.note)}</span>` : '';
    html += `<tr>
      <td style="white-space:nowrap;">${escHtml(x.date || '')}</td>
      <td>${escHtml(String(x.bill == null ? '' : x.bill))}</td>
      <td>${escHtml(x.party || '')}${tag}${note}</td>
      <td>${escHtml(x.pan || '')}</td>
      ${spbRegCellHtml(x, cols)}
    </tr>`;
  });
  if (model.omittedCount) {
    html += `<tr style="background:#f1f5f9; font-weight:600;">
      <td colspan="${span}">Register total (excluding omitted bills)</td>
      ${cols.map(c => `<td style="text-align:right;">${spbFmt(model.bookOnly[c.key])}</td>`).join('')}
    </tr>`;
  }
  html += `<tr style="background:var(--amber-bg); color:var(--amber-dk); font-weight:800;">
      <td colspan="${span}">Grand Total${model.omittedCount ? ` — includes ${model.omittedCount} omitted bill${model.omittedCount === 1 ? '' : 's'}` : ''}</td>
      ${cols.map(c => `<td style="text-align:right;">${spbFmt(model.grand[c.key])}</td>`).join('')}
    </tr></tbody></table>`;
  if (!o.print) html = `<div class="table-wrap" style="overflow-x:auto;">${html}</div>`;
  return html;
}

const SPB_BILL_TYPE_LABELS = {
  sales: 'Sales bill', sales_return: 'Sales return',
  purchase: 'Purchase bill', purchase_return: 'Purchase return',
};

function spbRenderRegisterTable() {
  const host = document.getElementById('spb-register-table');
  if (!host) return;
  const input = document.getElementById('spb-reg-party');
  spbRegPartyFilter = input ? input.value : '';
  const section = spbRegisterSection();
  if (!section) { host.innerHTML = ''; return; }
  const model = spbRegisterModel(section, spbRegPartyFilter);
  if (!model.body.length) {
    host.innerHTML = '<p class="log-empty">No bills match that party name.</p>';
    return;
  }
  host.innerHTML = spbRegisterTableHtml(model, { print: false });
}

// ── Print / Preview ──
// One shared builder: every Autobooks preview (register now, party statement
// and the annexure next) prints through this, so they share one page setup and
// one set of print rules rather than each inventing its own.
function spbPrintDoc(title, subtitle, bodyHtml) {
  const ident = spbBookIdentity() || {};
  const head = `
    <div style="text-align:center; margin-bottom:18px;">
      <div style="font-size:17px; font-weight:800; letter-spacing:.2px;">${escHtml(ident.client_name || '')}</div>
      ${ident.pan ? `<div style="font-size:12px;">PAN: ${escHtml(ident.pan)}</div>` : ''}
      <div style="font-size:14px; font-weight:700; margin-top:10px;">${escHtml(title)}</div>
      <div style="font-size:12px; color:#444;">${escHtml(subtitle)}</div>
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escHtml(title)}</title><style>
    /* The print document is STANDALONE — css/styles.css is not loaded into it.
       Every design token and shared class the table markup uses therefore has
       to be redefined here, or it silently resolves to nothing: the omitted-
       bill band prints with no highlight and a credit note's negative figures
       print black instead of red. This is the same failure the audit report's
       .rep-blank-fill hit (CLAUDE.md §15) — it looks perfect on screen and is
       wrong on the only copy anyone signs. Keep these in step with :root. */
    :root {
      --amber-bg:#fff3e0; --amber-dk:#c2760a; --red-dk:#b91c1c;
      --text-muted:#64748b; --green-bg:#ecfdf5; --green-dk:#047857;
    }
    .log-badge { display:inline-block; padding:1px 7px; border-radius:20px; font-size:9px; font-weight:700; }
    .badge-amber { background:var(--amber-bg); color:var(--amber-dk); border:1px solid #fbd38d; }
    .badge-sent  { background:var(--green-bg); color:var(--green-dk); border:1px solid #a7f3d0; }

    @page { size: A4 landscape; margin: 10mm 8mm; }
    body { margin:0; padding:16px; background:#fff; color:#000; font-family:'Inter',Arial,sans-serif; font-size:11px; }
    table { width:100%; border-collapse:collapse; }
    th, td { border:1px solid #94a3b8; padding:4px 6px; }
    th { background:#e2e8f0; font-size:9.5px; text-transform:uppercase; letter-spacing:.3px; text-align:left; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    @media print { html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } body { padding:0; } }
  </style></head><body>${head}${bodyHtml}
  <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
  </body></html>`;
}

function spbOpenPrint(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  if (!window.open(url, '_blank')) {
    alert('Pop-up blocked — allow pop-ups for this site, then click Print / Preview again.');
  }
}

function spbPrintRegister() {
  const section = spbRegisterSection();
  if (!section) return;
  const label = (SPB_SECTIONS.find(s => s.key === section) || {}).label || section;
  const model = spbRegisterModel(section, spbRegPartyFilter);
  const sub = `${label} Register · F.Y. ${spbVal('spb-fy')}` +
    (spbRegPartyFilter ? ` · party filter: "${spbRegPartyFilter}"` : '');
  spbOpenPrint(spbPrintDoc(label + ' Register', sub, spbRegisterTableHtml(model, { print: true })));
  AuditLog.record('autobooks_register_printed', {
    clientName: spbVal('spb-company'), fiscalYear: spbVal('spb-fy'), recordRef: label + ' Register',
  });
}

// Called by spbReparse() once the derived state has been rebuilt. A reparse
// changes the figures, so anything stored is now out of date — say so rather
// than letting the card keep claiming "Saved".
function spbLedgerAfterReparse() {
  if (spbBookId) spbDirty = true;
  spbRenderBookCard();
  if (spbSection === 'register') spbRenderRegister();
}

// ── Boot ──
// The panel exists before any book does, so the nav and the (empty) book card
// must render on load rather than waiting for an import.
(function spbLedgerBoot() {
  spbRenderSectionNav();
  spbRenderBookCard();
})();
