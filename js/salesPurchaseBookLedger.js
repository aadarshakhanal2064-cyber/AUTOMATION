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
// `onShow` names the function that draws the section, rather than this file
// growing an if-chain that every later part of Autobooks has to come back and
// edit. A section registers itself with its own screen.
const SPB_SECTION_TABS = [
  { key: 'import',   label: 'Import',        panel: 'spb-sec-import' },
  { key: 'register', label: 'Register',      panel: 'spb-sec-register', onShow: 'spbRenderRegister' },
  { key: 'omitted',  label: 'Omitted Bills', panel: 'spb-sec-omitted',  onShow: 'spbRenderOmitted' },
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
  const tab = SPB_SECTION_TABS.find(t => t.key === key);
  if (tab && tab.onShow && typeof window[tab.onShow] === 'function') window[tab.onShow]();
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
  // The omitted-bill form is built once and kept, so it has to be emptied by
  // hand here — otherwise the previous client's half-typed bill stays on screen
  // under the next client's name.
  if (document.getElementById('spb-om-form')) spbOmResetForm();
  spbShowSection('import');
  spbRenderBookCard();
  spbRenderOmittedTable();
  if (typeof spbRenderConfirm === 'function') spbRenderConfirm();
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
  let q = window.sb.from('autobooks_books').select('*').eq('fiscal_year', ident.fiscal_year);
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
    const { error } = await window.sb.from(table).insert(rows.slice(i, i + SPB_INSERT_CHUNK));
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
      const { data, error } = await window.sb.from('autobooks_books')
        .update(payload).eq('id', existing.id).select().limit(1);
      if (error) throw error;
      row = (data && data[0]) || existing;
    } else {
      payload.created_by = (window.currentUser && window.currentUser.email) || null;
      const { data, error } = await window.sb.from('autobooks_books')
        .insert(payload).select().limit(1);
      if (error) throw error;
      row = data && data[0];
    }
    if (!row) throw new Error('the book row came back empty');
    spbBookId = row.id; spbBookMeta = row;

    // 2. Bill lines. Replace, never merge: the uploaded file IS the register,
    //    so a re-import supersedes it outright. Only kind='regular' is touched
    //    — omitted bills are typed by hand and are not in the uploaded file.
    const { error: delErr } = await window.sb.from('autobooks_entries')
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
    // record_ref is a BIGINT column — a string there fails the insert outright
    // and the whole event is lost, not just the reference. Numeric id only;
    // everything descriptive belongs in `detail` (the convention every other
    // module already follows).
    AuditLog.record('spb_book_saved', {
      module: 'salesPurchaseBook', clientName: ident.client_name, recordRef: spbBookId,
      detail: { fiscalYear: ident.fiscal_year, entries: entries.length,
                parties: Object.keys(spbLedgerParties).length },
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

  const rows = await sbFetchAll(() => window.sb.from('autobooks_parties')
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
    const { error } = await window.sb.from('autobooks_parties')
      .update({ party_name: u.party_name, pan: u.pan }).eq('id', u.id);
    if (error) throw error;
  }
  await spbLoadPartyRows();
}

async function spbLoadPartyRows() {
  if (!spbBookId) { spbLedgerParties = {}; return; }
  const rows = await sbFetchAll(() => window.sb.from('autobooks_parties')
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

    const rows = await sbFetchAll(() => window.sb.from('autobooks_entries')
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

    const { data: adj, error: adjErr } = await window.sb.from('autobooks_adjustments')
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
    spbRenderOmittedTable();
    if (typeof spbRenderConfirm === 'function') spbRenderConfirm();
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
  AuditLog.record('spb_register_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), register: label, partyFilter: spbRegPartyFilter || null },
  });
}

// ════════════════════════════════════════════
//  OMITTED BILLS
//
//  A bill that wasn't available when the year's register was entered and
//  closed. It surfaces later, is entered here rather than back-dated into a
//  closed month, and still has to reconcile against the party's confirmation.
//
//  THE HARD PART IS THE PARTY, NOT THE AMOUNTS. In the reference file, three of
//  the seven omitted-bill parties are spelled differently from the same party
//  in the purchase register — an inserted letter in two of them and a
//  different transliteration of the same Nepali name in the third. In
//  Excel those silently become separate
//  parties and a human reconciles them by eye. Here, an omitted bill filed
//  under a new party key would never close the difference it exists to
//  explain, and nothing would say so.
//
//  Their PANs match exactly in every case. So the party is PICKED from the
//  book's own party list (which sets the key directly), and typing a PAN that
//  resolves to exactly one existing party links it automatically. A genuinely
//  new party is still allowed — it is just labelled as one, out loud.
// ════════════════════════════════════════════
const SPB_BILL_TYPES = [
  { value: 'sales',           label: 'Sales bill',      section: 'sales',    sign: 1 },
  { value: 'sales_return',    label: 'Sales return',    section: 'sales',    sign: -1 },
  { value: 'purchase',        label: 'Purchase bill',   section: 'purchase', sign: 1 },
  { value: 'purchase_return', label: 'Purchase return', section: 'purchase', sign: -1 },
];

// The party the form is currently linked to: null while free-typed.
let spbOmParty = null;
let spbOmEditId = null;   // set while editing an existing row

function spbOmStatus(html, type) { showStatus(html, type, 'spb-om-status'); }

function spbOmBillType() {
  return SPB_BILL_TYPES.find(t => t.value === spbVal('spb-om-type')) || SPB_BILL_TYPES[2];
}

// The parties already in the book, for the register this bill belongs to.
function spbOmPartyList() {
  const section = spbOmBillType().section;
  return ((spbGroups && spbGroups[section]) || []).map(g => ({
    key: g.key, name: g.display, pan: g.pan || '', taxable: g.taxable || 0,
  }));
}

// spbComputeGroups() appends "(PAN …)" to a display name when one safeKey
// carries several PANs, so the picker can tell two same-named companies apart.
// That suffix is a UI device, not part of anyone's name — it must not end up
// stored on a bill or printed in the register beside rows that don't have it.
function spbOmPlainName(s) {
  return String(s || '').replace(/\s*\(PAN (?:\d+|not specified)\)\s*$/, '').trim();
}

// `fillName` only when the user picked the party by NAME (the autocomplete).
// Choosing by PAN must leave the typed name alone: it is what the bill itself
// says, and in the reference file the late bill genuinely spells the party
// one letter differently from the register. Keeping the bill's
// own spelling is provenance; the key is what makes the totals combine.
function spbOmSetParty(p, fillName) {
  spbOmParty = p ? { key: p.key, name: spbOmPlainName(p.name), pan: p.pan } : null;
  if (p) {
    const nameEl = document.getElementById('spb-om-party');
    const panEl = document.getElementById('spb-om-pan');
    if (nameEl && fillName) nameEl.value = spbOmPlainName(p.name);
    if (panEl && p.pan && !panEl.value.trim()) panEl.value = p.pan;
  }
  spbOmRenderHint();
}

// A typed PAN that resolves to exactly one party in this register IS the link —
// it is what reaches a party the register spells differently. One PAN can
// legitimately span two unrelated companies in this app's data (§15), so an
// ambiguous PAN links nothing and says why.
function spbOmOnPanInput() {
  const pan = spbNormPan(spbVal('spb-om-pan'));
  if (!spbIsValidPan(pan)) { spbOmRenderHint(); return; }
  const hits = spbOmPartyList().filter(p => p.pan === pan);
  if (hits.length === 1 && (!spbOmParty || spbOmParty.key !== hits[0].key)) {
    spbOmSetParty(hits[0], false);
    return;
  }
  spbOmRenderHint();
}

function spbOmOnPartyInput() {
  // Typing over a linked name breaks the link unless it still matches exactly;
  // the PAN box can re-establish it.
  const typed = spbVal('spb-om-party');
  if (spbOmParty && spbSafeKey(typed) !== spbSafeKey(spbOmParty.name)) spbOmParty = null;
  spbOmRenderHint();
}

// Candidates offered when a PAN lands on more than one party. Held here rather
// than encoded into the buttons because a party key contains a NUL separator
// and arbitrary spacing — it has no business inside an onclick attribute (§10
// rule 13).
let spbOmPanCandidates = [];

function spbOmPickCandidate(i) {
  const p = spbOmPanCandidates[i];
  if (p) spbOmSetParty(p, false);
}

function spbOmRenderHint() {
  const el = document.getElementById('spb-om-hint');
  if (!el) return;
  const typed = spbVal('spb-om-party');
  spbOmPanCandidates = [];
  if (!typed) { el.innerHTML = ''; return; }
  if (spbOmParty) {
    const differs = spbSafeKey(typed) !== spbSafeKey(spbOmParty.name);
    el.innerHTML = `<span class="log-badge badge-sent">Linked</span> ` +
      `This bill will be added to <strong>${escHtml(spbOmParty.name)}</strong>` +
      (spbOmParty.pan ? ` (PAN ${escHtml(spbOmParty.pan)})` : '') + ` in the register.` +
      ` The bill keeps its own spelling; only the totals combine.` +
      (differs ? ` <em>The register spells this party differently — that is fine, the totals still combine.</em>` : '');
    return;
  }
  const pan = spbNormPan(spbVal('spb-om-pan'));
  const hits = spbIsValidPan(pan) ? spbOmPartyList().filter(p => p.pan === pan) : [];
  if (hits.length > 1) {
    // A PAN on two parties is real — usually one of them is a typo in the
    // client's own book (here, 57 rows / Rs 31.9M against 1 row / Rs 25,221).
    // Refusing to guess is right; making the user hunt for the answer is not,
    // so the candidates are offered outright, biggest first.
    spbOmPanCandidates = hits.slice().sort((a, b) => b.taxable - a.taxable);
    el.innerHTML = `<span class="log-badge badge-amber">Which party?</span> ` +
      `PAN ${escHtml(pan)} is on ${hits.length} parties in this register, so it can't decide on its own. Pick one:` +
      `<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">` +
      spbOmPanCandidates.map((p, i) =>
        `<button type="button" class="btn btn-outline btn-sm" onclick="spbOmPickCandidate(${i})">` +
        `${escHtml(p.name)} <span style="color:var(--text-muted);">· ${spbFmt(p.taxable)}</span></button>`).join('') +
      `</div>`;
    return;
  }
  el.innerHTML = `<span class="log-badge badge-amber">New party</span> ` +
    `<strong>${escHtml(typed)}</strong> is not in this register. It will be added as a new party.` +
    ` If it is really one of the existing parties under another spelling, pick it from the list or type its PAN.`;
}

// The firm enters an omitted bill from the bill's TOTAL and backs out the
// taxable figure — the reference sheet's own columns are TOTAL, TAXABLE, VAT in
// that order, and 207,774.98 / 1.13 is exactly the 183,871.6637 it records.
// Offered as a helper, never as the only way in: a bill with a tax-free part
// doesn't divide out cleanly and must be typed directly.
function spbOmFromTotal() {
  const total = spbNum(spbVal('spb-om-total'));
  if (!total) return;
  const taxEl = document.getElementById('spb-om-taxable');
  const vatEl = document.getElementById('spb-om-vat');
  if (!taxEl || !vatEl) return;
  if (taxEl.value.trim() || vatEl.value.trim()) return;   // never overwrite typed figures
  const free = spbNum(spbVal('spb-om-taxfree'));
  const taxable = (total - free) / 1.13;
  taxEl.value = (Math.round(taxable * 100) / 100).toFixed(2);
  vatEl.value = (Math.round((total - free - taxable) * 100) / 100).toFixed(2);
}

// Blank VAT beside a taxable figure is completed at 13%, the same rule the
// importer applies to an uploaded sheet — and, as there, a VAT that is present
// but disagrees is left exactly as typed.
function spbOmFillVat() {
  const vatEl = document.getElementById('spb-om-vat');
  const taxable = spbNum(spbVal('spb-om-taxable'));
  if (!vatEl || vatEl.value.trim() || !taxable) return;
  if (spbIsPanOnly() && spbOmBillType().section === 'sales') return;   // PAN-only: no VAT on sales
  vatEl.value = (Math.round(taxable * 0.13 * 100) / 100).toFixed(2);
}

function spbOmResetForm() {
  spbOmEditId = null; spbOmParty = null;
  ['spb-om-date', 'spb-om-bill', 'spb-om-party', 'spb-om-pan', 'spb-om-total',
   'spb-om-taxfree', 'spb-om-taxable', 'spb-om-vat', 'spb-om-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  spbOmRenderHint();
  const btn = document.getElementById('spb-om-submit');
  if (btn) btn.textContent = 'Add omitted bill';
  const cancel = document.getElementById('spb-om-cancel');
  if (cancel) cancel.style.display = 'none';
}

// Accepts a full B.S. date (2082.11.01) or a bare month name — the reference
// sheet uses month names alone ("Magh", "Asar"), so both go through the
// importer's own parser rather than a second date reader.
function spbOmParseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, msg: 'Enter a date or a month name (for example 2082.11.01, or Magh).' };
  const m = s.match(SPB_DATE_RE);
  if (m) {
    const mon = parseInt(m[2], 10);
    const fi = SPB_BS_MONTHS.indexOf(mon);
    if (fi < 0) return { ok: false, msg: `"${s}" has month ${mon}, which isn't a B.S. month.` };
    return { ok: true, date: s, fi };
  }
  const parsed = spbParseMonthNameDate(s, spbFyStartYear());
  if (!parsed) return { ok: false, msg: `Couldn't read "${s}" as a date or a B.S. month name.` };
  const fi = SPB_BS_MONTHS.indexOf(parsed.mon);
  return { ok: true, date: `${parsed.year}.${String(parsed.mon).padStart(2, '0')}.${String(parsed.day).padStart(2, '0')}`, fi };
}

async function spbSaveOmitted() {
  if (!spbBookId) {
    spbOmStatus('❌ Save the book first (Import tab → Save book to database) — an omitted bill has to hang off a stored book.', 'error');
    return;
  }
  const type = spbOmBillType();
  const d = spbOmParseDate(spbVal('spb-om-date'));
  if (!d.ok) { spbOmStatus('❌ ' + escHtml(d.msg), 'error'); return; }

  const name = spbVal('spb-om-party');
  if (!name) { spbOmStatus('❌ Enter the party name.', 'error'); return; }

  spbOmFromTotal();
  spbOmFillVat();
  const taxable = spbNum(spbVal('spb-om-taxable'));
  const taxfree = spbNum(spbVal('spb-om-taxfree'));
  if (!taxable && !taxfree) { spbOmStatus('❌ Enter the taxable amount (or the bill total, and it will be worked out).', 'error'); return; }

  const pan = spbNormPan(spbVal('spb-om-pan'));
  const row = {
    book_id: spbBookId, section: type.section, kind: 'omitted', bill_type: type.value,
    bs_date: d.date, fiscal_month: d.fi + 1,
    bill_no: spbVal('spb-om-bill') || null,
    party_name: name,
    // The linked party's key when one was chosen — this is what puts the bill
    // on the same party as the register despite a different spelling.
    party_key: spbOmParty ? spbOmParty.key : spbSafeKey(name),
    pan: pan || null,
    tax_free: taxfree, taxable, vat: spbNum(spbVal('spb-om-vat')),
    note: spbVal('spb-om-note') || null,
    source: 'manual',
  };

  const btn = document.getElementById('spb-om-submit');
  if (btn) btn.disabled = true;
  try {
    if (spbOmEditId) {
      const { error } = await window.sb.from('autobooks_entries').update(row).eq('id', spbOmEditId);
      if (error) throw error;
    } else {
      const { error } = await window.sb.from('autobooks_entries').insert(row);
      if (error) throw error;
    }
    AuditLog.record(spbOmEditId ? 'spb_omitted_updated' : 'spb_omitted_added', {
      module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbOmEditId || spbBookId,
      detail: { fiscalYear: spbVal('spb-fy'), billType: type.label, billNo: row.bill_no,
                party: name, taxable: row.taxable },
    });
    const wasEdit = !!spbOmEditId;
    spbOmResetForm();
    await spbReloadOmitted();
    spbOmStatus(`✅ ${wasEdit ? 'Updated' : 'Added'} — it now shows after the Ashadh total in the ` +
      `${escHtml(type.section === 'sales' ? 'Sales' : 'Purchase')} register and counts toward that party's total.`, 'success');
  } catch (err) {
    console.error('[Autobooks] omitted bill save failed', err);
    spbOmStatus('❌ Could not save: ' + escHtml(err.message || String(err)), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function spbReloadOmitted() {
  if (!spbBookId) { spbOmitted = []; return; }
  const rows = await sbFetchAll(() => window.sb.from('autobooks_entries')
    .select('*').eq('book_id', spbBookId).eq('kind', 'omitted').order('id', { ascending: true }));
  spbOmitted = rows.map(spbTxnFromRow);
  spbRenderOmittedTable();
  spbRenderBookCard();
  if (spbSection === 'register') spbRenderRegisterTable();
  // An omitted bill moves its party's books total, which is the very figure a
  // confirmation is compared against — the reconciliation has to follow.
  if (spbSection === 'confirm' && typeof spbRenderConfirmTable === 'function') spbRenderConfirmTable();
}

function spbOmittedById(id) { return spbOmitted.find(x => x.rowId === id); }

function spbEditOmitted(id) {
  const x = spbOmittedById(id);
  if (!x) return;
  spbOmEditId = id;
  const set = (k, v) => { const el = document.getElementById(k); if (el) el.value = v == null ? '' : v; };
  set('spb-om-type', x.billType || 'purchase');
  set('spb-om-date', x.date); set('spb-om-bill', x.bill);
  set('spb-om-party', x.party); set('spb-om-pan', x.pan);
  set('spb-om-total', ''); set('spb-om-taxfree', x.taxfree);
  set('spb-om-taxable', x.taxable); set('spb-om-vat', x.vat);
  set('spb-om-note', x.note);
  // Re-link to the party the row was filed under, so an edit can't quietly
  // move a reconciled bill onto a different party.
  const hit = spbOmPartyList().find(p => p.key === x.groupKey);
  spbOmParty = hit ? { key: hit.key, name: spbOmPlainName(hit.name), pan: hit.pan } : null;
  spbOmRenderHint();
  const btn = document.getElementById('spb-om-submit');
  if (btn) btn.textContent = 'Save changes';
  const cancel = document.getElementById('spb-om-cancel');
  if (cancel) cancel.style.display = '';
  document.getElementById('spb-om-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function spbDeleteOmitted(id) {
  const x = spbOmittedById(id);
  if (!x) return;
  if (!confirm(`Delete this omitted bill?\n\n${x.party}\nBill ${x.bill || '—'} · Taxable ${spbFmt(x.taxable)}\n\nIt will stop counting toward that party's total.`)) return;
  try {
    const { error } = await window.sb.from('autobooks_entries').delete().eq('id', id);
    if (error) throw error;
    AuditLog.record('spb_omitted_deleted', {
      module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: id,
      detail: { fiscalYear: spbVal('spb-fy'), billNo: x.bill, party: x.party, taxable: x.taxable },
    });
    await spbReloadOmitted();
    spbOmStatus('✅ Deleted.', 'success');
  } catch (err) {
    spbOmStatus('❌ Could not delete: ' + escHtml(err.message || String(err)), 'error');
  }
}

// The form is rendered ONCE and kept — re-rendering it on every table refresh
// would blow away what the user is halfway through typing, and would detach
// the party autocomplete.
function spbRenderOmitted() {
  const host = document.getElementById('spb-omitted-form-host');
  if (!host) return;
  if (!host.dataset.built) {
    host.innerHTML = spbOmFormHtml();
    host.dataset.built = '1';
    SearchEngine.attachAutocomplete(
      document.getElementById('spb-om-party'),
      document.getElementById('spb-om-party-list'),
      {
        getList: () => spbOmPartyList(),
        keys: ['name', 'pan'],
        renderItem: p => `<div class="ac-name">${escHtml(p.name)}</div>` +
          `<div class="ac-email">${escHtml(p.pan ? 'PAN: ' + p.pan : 'No PAN in the register')} · Taxable ${spbFmt(p.taxable)}</div>`,
        onSelect: p => spbOmSetParty(p, true),
      });
  }
  spbRenderOmittedTable();
}

function spbOmFormHtml() {
  return `<div id="spb-om-form">
    <div class="form-grid" style="gap:16px;">
      <div class="form-group">
        <label>Bill Type</label>
        <select id="spb-om-type" onchange="spbOmParty=null; spbOmRenderHint();">
          ${SPB_BILL_TYPES.map(t => `<option value="${t.value}"${t.value === 'purchase' ? ' selected' : ''}>${escHtml(t.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Date (B.S.)</label>
        <input type="text" id="spb-om-date" placeholder="2082.11.01 — or just Magh" />
      </div>
      <div class="form-group">
        <label>Bill No.</label>
        <input type="text" id="spb-om-bill" placeholder="1525" />
      </div>
      <div class="form-group" style="position:relative;">
        <label>Party Name</label>
        <input type="text" id="spb-om-party" placeholder="Start typing — pick the party from the register" autocomplete="off" oninput="spbOmOnPartyInput()" />
        <div class="autocomplete-list" id="spb-om-party-list" style="display:none;"></div>
      </div>
      <div class="form-group">
        <label>PAN No.</label>
        <input type="text" id="spb-om-pan" placeholder="600000000" oninput="spbOmOnPanInput()" />
      </div>
      <div class="form-group">
        <label>Bill Total <span style="font-weight:400; color:var(--text-muted);">(optional)</span></label>
        <input type="text" id="spb-om-total" inputmode="decimal" placeholder="207774.98" onchange="spbOmFromTotal()" />
      </div>
      <div class="form-group">
        <label>Tax Free</label>
        <input type="text" id="spb-om-taxfree" inputmode="decimal" placeholder="0" />
      </div>
      <div class="form-group">
        <label>Taxable Amount</label>
        <input type="text" id="spb-om-taxable" inputmode="decimal" placeholder="183871.66" onchange="spbOmFillVat()" />
      </div>
      <div class="form-group">
        <label>Vat</label>
        <input type="text" id="spb-om-vat" inputmode="decimal" placeholder="23903.32" />
      </div>
      <div class="form-group">
        <label>Note <span style="font-weight:400; color:var(--text-muted);">(optional)</span></label>
        <input type="text" id="spb-om-note" placeholder="Debit Note" />
      </div>
    </div>
    <div id="spb-om-hint" class="log-sub" style="margin-top:12px;"></div>
    <p style="font-size:12.5px; color:var(--text-muted); margin-top:10px;">
      Type the <strong>Bill Total</strong> and leave Taxable and Vat blank to have them worked out at 13%, the way the firm's own omitted-bill sheet records them. A blank Vat beside a taxable figure is filled at 13%; a Vat you type is never changed.
    </p>
    <div class="action-row">
      <button class="btn btn-primary btn-sm" id="spb-om-submit" onclick="spbSaveOmitted()">Add omitted bill</button>
      <button class="btn btn-outline btn-sm" id="spb-om-cancel" style="display:none;" onclick="spbOmResetForm()">Cancel edit</button>
    </div>
    <div id="spb-om-status"></div>
  </div>`;
}

function spbRenderOmittedTable() {
  const el = document.getElementById('spb-omitted-body');
  if (!el) return;
  if (!spbBookId) {
    el.innerHTML = '<p class="log-empty">Save the book first — an omitted bill has to hang off a stored book. Go to <strong>Import</strong> → <em>Save book to database</em>.</p>';
    return;
  }
  if (!spbOmitted.length) {
    el.innerHTML = '<p class="log-empty">No omitted bills recorded for this book yet.</p>';
    return;
  }
  const bySection = {};
  spbOmitted.forEach(x => { (bySection[x.section] = bySection[x.section] || []).push(x); });

  let html = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    const rows = bySection[key];
    if (!rows || !rows.length) return;
    const signed = rows.map(x => ({ ...x, __sign: spbOmittedSign(x) }));
    const tot = spbSumOver(signed, [{ key: 'taxfree' }, { key: 'taxable' }, { key: 'vat' }]);
    const known = new Set(((spbGroups && spbGroups[key]) || []).map(g => g.key));
    html += `<div style="margin-bottom:22px;">
      <div style="font-weight:700; color:var(--brand-navy); margin-bottom:10px;">${escHtml(label)} — ${rows.length} bill${rows.length === 1 ? '' : 's'}</div>
      <div class="table-wrap" style="overflow-x:auto;"><table class="client-table" style="font-size:12.5px;">
        <thead><tr><th>Date</th><th>Bill No.</th><th>Party</th><th>Pan No.</th><th>Type</th>
          <th style="text-align:right;">Tax Free</th><th style="text-align:right;">Taxable</th><th style="text-align:right;">Vat</th>
          <th style="text-align:right;">Actions</th></tr></thead><tbody>`;
    signed.forEach(x => {
      const linked = ((spbGroups && spbGroups[key]) || []).find(g => g.key === x.groupKey);
      const isNew = !known.has(x.groupKey);
      // A late bill legitimately spells its party differently from the
      // register. Saying which party it joins is the difference between a
      // reconciled total and a mystery.
      const joins = linked && spbSafeKey(spbOmPlainName(linked.display)) !== spbSafeKey(x.party)
        ? ` <span style="color:var(--text-muted);">&rarr; ${escHtml(spbOmPlainName(linked.display))}</span>` : '';
      html += `<tr>
        <td style="white-space:nowrap;">${escHtml(x.date)}</td>
        <td>${escHtml(String(x.bill == null ? '' : x.bill))}</td>
        <td>${escHtml(x.party)}${joins}${isNew ? ' <span class="log-badge badge-amber" style="font-size:10px; padding:2px 7px;">new party</span>' : ''}${x.note ? ` <span style="color:var(--text-muted);">· ${escHtml(x.note)}</span>` : ''}</td>
        <td>${escHtml(x.pan || '')}</td>
        <td>${escHtml(SPB_BILL_TYPE_LABELS[x.billType] || '')}</td>
        <td style="text-align:right;">${spbFmt(x.taxfree * x.__sign)}</td>
        <td style="text-align:right;${x.__sign < 0 ? 'color:var(--red-dk);' : ''}">${spbFmt(x.taxable * x.__sign)}</td>
        <td style="text-align:right;${x.__sign < 0 ? 'color:var(--red-dk);' : ''}">${spbFmt(x.vat * x.__sign)}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-outline btn-sm" onclick="spbEditOmitted(${x.rowId})">Edit</button>
          <button class="btn btn-outline btn-sm" onclick="spbDeleteOmitted(${x.rowId})">Delete</button>
        </td></tr>`;
    });
    html += `<tr style="background:#fffbe6; font-weight:700;">
        <td colspan="5">Net effect on the ${escHtml(label)} register</td>
        <td style="text-align:right;">${spbFmt(tot.taxfree)}</td>
        <td style="text-align:right;">${spbFmt(tot.taxable)}</td>
        <td style="text-align:right;">${spbFmt(tot.vat)}</td>
        <td></td></tr></tbody></table></div></div>`;
  });
  el.innerHTML = html + `<div class="action-row" style="margin-top:0;">
    <button class="btn btn-outline btn-sm" onclick="spbPrintOmitted()">Print / Preview omitted bills</button>
  </div>`;
}

// The auditor's question — "these totals include N bills entered after close;
// which ones?" — answered as its own sheet rather than only as a band inside
// the register.
function spbPrintOmitted() {
  if (!spbOmitted.length) return;
  const cols = [{ key: 'taxfree', label: 'Tax Free' }, { key: 'taxable', label: 'Taxable Amount' }, { key: 'vat', label: 'Vat' }];
  let body = '';
  SPB_SECTIONS.forEach(({ key, label }) => {
    const rows = spbOmitted.filter(x => x.section === key).map(x => ({ ...x, __sign: spbOmittedSign(x) }));
    if (!rows.length) return;
    const tot = spbSumOver(rows, cols);
    body += `<h3 style="font-size:12px; margin:16px 0 6px;">${escHtml(label)} — ${rows.length} omitted bill${rows.length === 1 ? '' : 's'}</h3>
      <table><thead><tr><th>Date</th><th>Bill No.</th><th>Party</th><th>Pan No.</th><th>Type</th>
      ${cols.map(c => `<th style="text-align:right;">${escHtml(c.label)}</th>`).join('')}</tr></thead><tbody>`;
    rows.forEach(x => {
      body += `<tr><td>${escHtml(x.date)}</td><td>${escHtml(String(x.bill == null ? '' : x.bill))}</td>
        <td>${escHtml(x.party)}${x.note ? ' · ' + escHtml(x.note) : ''}</td><td>${escHtml(x.pan || '')}</td>
        <td>${escHtml(SPB_BILL_TYPE_LABELS[x.billType] || '')}</td>
        ${cols.map(c => `<td style="text-align:right;${x.__sign < 0 ? 'color:var(--red-dk);' : ''}">${spbFmt((x[c.key] || 0) * x.__sign)}</td>`).join('')}</tr>`;
    });
    body += `<tr style="background:#fffbe6; font-weight:700;"><td colspan="5">Net effect on the ${escHtml(label)} register</td>
      ${cols.map(c => `<td style="text-align:right;">${spbFmt(tot[c.key])}</td>`).join('')}</tr></tbody></table>`;
  });
  spbOpenPrint(spbPrintDoc('Omitted Bills',
    `Bills received after the register was closed · F.Y. ${spbVal('spb-fy')}`, body));
  AuditLog.record('spb_omitted_printed', {
    module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
    detail: { fiscalYear: spbVal('spb-fy'), count: spbOmitted.length },
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
