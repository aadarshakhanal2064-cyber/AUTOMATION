// ════════════════════════════════════════════
//  AUTOBOOKS — IN-APP DATA ENTRY (the "smart sheet")
//
//  Until now every book started life in Excel: staff typed the year's bills
//  into a spreadsheet and uploaded it here. This screen replaces that first
//  step with a sheet that lives inside the app and KNOWS the firm's data —
//  typing "kot" offers "KOTHESWORI SUPPLIERS" with its PAN attached, typing a
//  PAN fills in the party it belongs to, a blank VAT completes itself at 13%,
//  dates carry forward row to row, and a PAN that contradicts what the party
//  was entered with before goes red on the spot. The spelling and PAN
//  mistakes this module's Data Doctor exists to catch downstream are instead
//  prevented at the keystroke.
//
//  DELIBERATELY NOT A SECOND PARSER. The typed rows are converted into the
//  exact sheet shape an upload produces (spbEnSheet) and pushed through the
//  module's OWN spbParseRows → spbComputeBook → spbComputeGroups — the same
//  contract spbLoadBook() follows for rehydration. Every screen downstream
//  (Register, Monthly reconciliation, Confirmations, Annexure-13, Reco, the
//  generated workbook, Save) works identically whether the book was uploaded,
//  loaded from the database, or typed here.
//
//  A typed book carries no spbRaw, exactly like a loaded one — Data Doctor,
//  column mapping and reparse answer "is this FILE being read correctly", and
//  there is no file: the grid itself is the correction surface. Conversely,
//  while an UPLOADED file is open (spbRaw set) this screen gates itself shut:
//  editing the same book in two places at once is how the two drift, so the
//  user is offered an explicit one-way switch instead.
//
//  Same module, another file — the salesPurchaseBookLedger.js precedent
//  (CLAUDE.md §5): `spb` prefix continues, loads AFTER the ledger file (it
//  splices its tab into SPB_SECTION_TABS and reads/writes spbData & friends).
// ════════════════════════════════════════════

// ── PURE LAYER ──────────────────────────────────────────────────────────────
// No DOM access — exercised headlessly by tools/spbEntryVerify.mjs, the same
// rule spbParseRows lives by. Keep it that way.

function spbEnBlankRow() {
  return { date: '', bill: '', party: '', pan: '', taxfree: '', taxable: '', vat: '', imp: '', impVat: '', cap: '', capVat: '' };
}

const SPB_EN_KEYS = ['date', 'bill', 'party', 'pan', 'taxfree', 'taxable', 'vat', 'imp', 'impVat', 'cap', 'capVat'];

function spbEnRowEmpty(r) {
  return SPB_EN_KEYS.every(k => String(r[k] == null ? '' : r[k]).trim() === '');
}

// A row is INERT while it holds nothing beyond a date and bill number — which
// is exactly what a fresh row is born with (the carry-forward seeds both).
// Inert rows are typing surface, not data: they never reach the parser, the
// totals, the counts or the draft, or every seeded blank would print as a
// zero-amount bill in the register.
function spbEnRowInert(r) {
  return SPB_EN_KEYS.every(k => k === 'date' || k === 'bill' ||
    String(r[k] == null ? '' : r[k]).trim() === '');
}

// Date normalization — every form staff actually type, folded to the
// importer's canonical YYYY.MM.DD. `prevDate` (the row above's normalized
// date) is what lets a bare day number ("15") complete itself: books are
// entered chronologically and retyping "2082.04." per row is Excel work.
//  · 2082.4.1 / 2082/04/01 / 2082-04-01  → full date
//  · 4.15  (month.day)                   → year inferred from the F.Y.
//  · 15    (day only)                    → prev row's year+month, day 15
//  · "magh", "15 Baishakh", "भदौ"        → spbParseMonthNameDate (day → 1st)
// Returns { value, fi, mon, approx, error } — value is the normalized date
// (or the raw text when unreadable, so nothing typed is ever thrown away).
function spbEnNormDate(raw, fyStartYear, prevDate) {
  const t = NepaliLocale.toEnglishDigits(String(raw == null ? '' : raw)).trim();
  if (!t) return { value: '', fi: null };
  const pack = (year, mon, day, approx) => {
    if (!(mon >= 1 && mon <= 12 && day >= 1 && day <= 32)) return { value: t, fi: null, error: 'bad' };
    return {
      value: `${year}.${String(mon).padStart(2, '0')}.${String(day).padStart(2, '0')}`,
      fi: SPB_BS_MONTHS.indexOf(mon), mon, year, approx: !!approx,
    };
  };
  let m = SPB_DATE_RE.exec(t);
  if (m) return pack(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  m = /^(\d{1,2})[.\/\-](\d{1,2})$/.exec(t);
  if (m && fyStartYear) {
    const mon = parseInt(m[1], 10);
    return pack(mon >= 4 ? fyStartYear : fyStartYear + 1, mon, parseInt(m[2], 10));
  }
  m = /^(\d{1,2})$/.exec(t);
  if (m && prevDate) {
    const p = SPB_DATE_RE.exec(String(prevDate));
    if (p) return pack(parseInt(p[1], 10), parseInt(p[2], 10), parseInt(m[1], 10));
  }
  const alt = spbParseMonthNameDate(t, fyStartYear);
  if (alt) return pack(alt.year, alt.mon, alt.day, alt.approxDay);
  return { value: t, fi: null, error: 'bad' };
}

// The next bill number for a fresh SALES row — the firm's own invoices run
// sequentially (the Data Doctor's continuity check exists because of it).
// Purchases are other people's bill numbers and get no such guess.
// Zero-padding survives ("0012" → "0013"); a non-numeric tail suggests nothing.
function spbEnNextBill(bill) {
  const m = /^(.*?)(\d+)\s*$/.exec(String(bill == null ? '' : bill));
  if (!m) return '';
  const next = String(parseInt(m[2], 10) + 1);
  return m[1] + (m[2].length > next.length ? next.padStart(m[2].length, '0') : next);
}

// ── Excel → grid rows ───────────────────────────────────────────────────────
// The user's raw spreadsheet, loaded into the sheet AS TYPED so its mistakes
// can be seen and fixed here (2026-08-30, user ask). This is deliberately NOT
// spbParseRows: the parser is built to produce a clean book, so it EXCLUDES a
// row whose date it cannot read and silently reads a text amount as zero —
// exactly the rows a mistake hunt is looking for. Here every live row lands in
// the grid verbatim, and the grid's own validation puts the red on it.
//
// Only two kinds of row are dropped, and both are counted, never silent:
// rows with no data at all (formula leftovers), and the embedded month
// subtotal rows ("Total Of Shrawan") — the client's own arithmetic, not bills.
//
// A readable date is normalized to the canonical form (with the row above as
// context, the same as typing); an unreadable one is kept raw and flags red.
// A zero amount renders blank the way seeding does — but only when the cell
// really is a number: text typed into an amount column ("here", seen in a real
// book) is kept so it can be seen and fixed.
function spbEnRowsFromSheet(rows, headerInfo, fyStartYear) {
  const { row: hRow, col } = headerInfo;
  const amountCols = SPB_AMOUNT_KEYS.map(k => col[k]).filter(c => c != null);
  const out = [];
  let subtotals = 0, blanks = 0, prevDate = '';
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!spbRowIsLive(r, col, amountCols)) { blanks++; continue; }
    const cell = k => col[k] != null && r[col[k]] != null ? String(r[col[k]]).trim() : '';
    const dateRaw = NepaliLocale.toEnglishDigits(cell('date'));
    const party = cell('party');
    const looksDate = SPB_DATE_RE.test(dateRaw) || spbMonthFromText(dateRaw) != null;
    if (!looksDate && /total|जम्मा/i.test(party)) { subtotals++; continue; }
    const row = spbEnBlankRow();
    const d = spbEnNormDate(dateRaw, fyStartYear, prevDate);
    row.date = d.error ? dateRaw : d.value;
    if (!d.error && d.value) prevDate = d.value;
    row.bill = cell('bill');
    row.party = party;
    row.pan = spbNormPan(cell('pan'));
    SPB_AMOUNT_KEYS.forEach(k => {
      const v = cell(k);
      row[k] = (v !== '' && /^[\d.,\s-]+$/.test(v) && spbNum(v) === 0) ? '' : v;
    });
    out.push(row);
  }
  return { rows: out, subtotals, blanks };
}

// ── Duplicate bill numbers — the rule is OPPOSITE on the two registers ──────
// This is not a shared test with a different label on it; the two registers
// number bills from different ends of the transaction:
//
//  SALES — the bill number is the FIRM'S OWN invoice number, one running
//    sequence for the whole year. Bill no. 1 exists exactly once in the
//    register, whoever the customer is. Hanuman Supplier and Lateswori
//    Supplier both holding sales bill 1 means one of them is wrong, so the
//    key is the BILL NUMBER ALONE.
//  PURCHASE — the bill number is written by the SUPPLIER, and every supplier
//    numbers from their own 1. Hanuman's purchase bill 1 and Lateswori's
//    purchase bill 1 are two ordinary bills and must never be flagged. Only
//    the SAME supplier billing one number twice is suspicious, so the key is
//    PARTY + BILL NUMBER.
//
// (The amount is deliberately NOT part of either key. Keying on it meant two
// bills sharing a number escaped notice whenever their amounts differed —
// which is the case a wrong bill number actually produces.)
function spbEnBillKey(bill) {
  return String(bill == null ? '' : bill).toUpperCase().replace(/\s+/g, '')
    .replace(/(\d+)$/, d => d.replace(/^0+(?=\d)/, ''));   // "0012" and "12" are one bill
}

function spbEnDupMap(rows, section) {
  const groups = new Map();
  rows.forEach((r, i) => {
    if (spbEnRowInert(r)) return;
    const bill = spbEnBillKey(r.bill);
    if (!bill) return;
    const key = section === 'sales' ? bill : spbSafeKey(r.party) + '|' + bill;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const out = new Map();
  groups.forEach(list => {
    if (list.length < 2) return;
    list.forEach(i => out.set(i, { peers: list.filter(x => x !== i) }));
  });
  return out;
}

// Where a row sits as the user SEES it — "Bhadra, row 4". Counted exactly the
// way the month view lists rows (undated rows appear in every month), so the
// number printed here is the number in the grid's own # column.
function spbEnRowLabel(rows, idx, fyStartYear) {
  const fi = spbEnNormDate(rows[idx].date, fyStartYear).fi;
  let n = 0;
  for (let i = 0; i <= idx; i++) {
    if (spbEnRowInert(rows[i])) continue;
    const di = spbEnNormDate(rows[i].date, fyStartYear).fi;
    if (di == null || di === fi) n++;
  }
  return { fi, n, month: fi == null ? 'no date' : SPB_MONTH_NAMES[fi] };
}

// The duplicate finding as the user reads it: which party, which month, which
// row — never a bare count. Saying "1 possible duplicate bill" leaves the
// staff member to find it among 1,600 lines, which is the work being replaced.
function spbEnDupFindings(rows, section, fyStartYear) {
  const out = new Map();
  spbEnDupMap(rows, section).forEach((info, i) => {
    const r = rows[i];
    const bill = String(r.bill || '').trim();
    const peer = rows[info.peers[0]];
    const at = spbEnRowLabel(rows, info.peers[0], fyStartYear);
    const where = `${at.month}, row ${at.n}`;
    const more = info.peers.length > 1 ? ` and ${info.peers.length - 1} more` : '';
    const peerName = String(peer.party || '').trim() || '(no party)';
    if (section !== 'sales') {
      out.set(i, { level: 'warn', msg: `${peerName} already has purchase bill ${bill} — ${where}${more}` });
      return;
    }
    if (spbSafeKey(peer.party) !== spbSafeKey(r.party)) {
      out.set(i, { level: 'err', msg: `Sales bill ${bill} is also on ${peerName} — ${where}${more}. One sales bill number, one bill.` });
    } else if (spbNum(peer.taxable) === spbNum(r.taxable)) {
      out.set(i, { level: 'err', msg: `Same bill ${bill}, same amount as ${where}${more} — looks entered twice` });
    } else {
      out.set(i, { level: 'err', msg: `Sales bill ${bill} is used again at ${where}${more}, for a different amount` });
    }
  });
  return out;
}

// Which purchase-only amount columns this sheet actually uses — value-driven,
// the spbLedgerCols idiom. What decides the synthetic header below, and via
// that header what spbSectionAmountKeys prints: a typed book must not invent
// an all-zero Capital column any more than an uploaded one may (§15).
function spbEnUsedKeys(rows, section) {
  const used = {};
  SPB_AMOUNT_FIELDS.forEach(f => {
    if (!f.purchaseOnly) { used[f.key] = true; return; }
    used[f.key] = section === 'purchase' && rows.some(r => spbNum(r[f.key]) !== 0);
  });
  return used;
}

// Typed rows → the exact {rows, header} shape an uploaded sheet produces, so
// spbParseRows consumes them without knowing this screen exists.
function spbEnSheet(rows, section) {
  const used = spbEnUsedKeys(rows, section);
  const col = {};
  const labels = [];
  const put = (key, label) => { col[key] = labels.length; labels.push(label); };
  put('date', 'Date'); put('bill', 'Bill No.'); put('party', 'Party Name'); put('pan', 'Pan No.');
  SPB_AMOUNT_FIELDS.forEach(f => { if (used[f.key]) put(f.key, f.label); });
  const data = rows.filter(r => !spbEnRowInert(r)).map(r => {
    const arr = new Array(labels.length).fill(null);
    Object.keys(col).forEach(k => {
      const v = String(r[k] == null ? '' : r[k]).trim();
      arr[col[k]] = v === '' ? null : v;
    });
    return arr;
  });
  return { rows: [labels, ...data], header: { row: 0, col } };
}

// ── The party directory the smart fill reads ──
// sources: [{ name, pan, weight }] — grid rows (weight 3), the open book's
// party groups (2), the client's PRIOR-YEAR saved books (1). Aggregated per
// spbSafeKey: the display spelling and the PAN are both decided by WEIGHT,
// the Annexure-13 lesson — a one-row typo must not out-vote the real entry.
function spbEnDirectoryBuild(sources) {
  const bySafe = new Map();
  sources.forEach(s => {
    const name = String(s.name || '').trim();
    if (!name) return;
    const safe = spbSafeKey(name);
    let e = bySafe.get(safe);
    if (!e) { e = { spellings: new Map(), pans: new Map(), weight: 0 }; bySafe.set(safe, e); }
    const w = s.weight || 1;
    e.weight += w;
    e.spellings.set(name, (e.spellings.get(name) || 0) + w);
    const pan = spbNormPan(s.pan);
    if (spbIsValidPan(pan)) e.pans.set(pan, (e.pans.get(pan) || 0) + w);
  });
  const top = map => {
    let best = null, bw = -1;
    map.forEach((w, k) => { if (w > bw) { bw = w; best = k; } });
    return best;
  };
  const list = [];
  bySafe.forEach((e, safe) => {
    list.push({ safe, name: top(e.spellings), pan: top(e.pans) || '', weight: e.weight });
  });
  list.sort((a, b) => b.weight - a.weight);
  return list;
}

// Ranked name suggestions: starts-with beats word-start beats substring, ties
// by weight — the CommandPalette ranking, deliberately not Fuse: while typing
// "k" → "ko" → "kot" the user wants prefixes, and fuzzy scoring on two
// characters is noise.
function spbEnSuggest(directory, query, max) {
  const q = spbSafeKey(query);
  if (!q) return [];
  const ranked = [];
  directory.forEach(e => {
    const name = spbSafeKey(e.name);
    let rank = null;
    if (name.startsWith(q)) rank = 0;
    else if (name.split(' ').some(w => w.startsWith(q))) rank = 1;
    else if (name.includes(q)) rank = 2;
    if (rank != null) ranked.push({ e, rank });
  });
  ranked.sort((a, b) => a.rank - b.rank || b.e.weight - a.e.weight);
  return ranked.slice(0, max || 8).map(x => x.e);
}

// PAN → candidate parties, largest first (the omitted-bill idiom: a PAN on
// more than one party offers the candidates rather than refusing).
function spbEnPanMatches(directory, pan, prefixOk) {
  const p = spbNormPan(pan);
  if (p.length < 3) return [];
  return directory.filter(e => e.pan && (prefixOk ? e.pan.startsWith(p) : e.pan === p));
}

// ── STATE ───────────────────────────────────────────────────────────────────
let spbEnRows = { sales: [], purchase: [] };  // raw strings, exactly as typed
let spbEnSection = 'sales';
let spbEnMonth = 0;              // fi 0..11, or -1 = whole year
let spbEnIdentity = null;        // spbDraftId() the rows on screen belong to
let spbEnLastIdentity = null;    // survives reset — the (NO CLIENT) carry-over
let spbEnShowExtra = false;      // purchase Import/Capital columns visible
let spbEnView = [];              // absolute row indices currently rendered
let spbEnPrior = [];             // prior-year autobooks_parties for this client
let spbEnPriorFor = null;        // identity the prior fetch answered
let spbEnDirty = false;          // sheet has been edited since load/seed
let spbEnFull = false;           // the sheet covers the whole viewport

// Full screen is a sticky preference, not a per-visit toggle — the user asked
// for the sheet to BE full screen like Excel, so once chosen it opens that
// way every time. A UI preference, not client data, so localStorage is fine.
const SPB_EN_FULL_PREF = 'spbEntryFullscreen';

function spbEnToggleFull(on) {
  spbEnFull = on == null ? !spbEnFull : !!on;
  try { localStorage.setItem(SPB_EN_FULL_PREF, spbEnFull ? '1' : '0'); } catch (e) { /* best-effort */ }
  spbRenderEntry();
}

function spbEnApplyFullClass() {
  const card = document.getElementById('spb-en-card');
  if (card) card.classList.toggle('spb-en-full', spbEnFull);
  // The tab panel's fadeIn animation applies a transform, and a transformed
  // ancestor becomes the containing block for position:fixed — the "full
  // screen" card would pin itself inside the panel instead of the viewport.
  // Neutralized only while full screen is on, so the switch animation is
  // untouched the rest of the time.
  const panel = document.getElementById('tab-salesPurchaseBook-panel');
  if (panel) panel.classList.toggle('spb-en-fullhost', spbEnFull);
}

// The save affordance inside full screen. spbSaveBook() reports into the
// ledger status box, which lives on the Import tab and is invisible here —
// mirror its outcome into a toast where the user actually is.
async function spbEnSave() {
  const why = spbSaveBlockedReason();
  if (why) { showToast(why, 'error', 6000); return; }
  await spbSaveBook();
  const box = document.getElementById('spb-ledger-status');
  const msg = box ? box.textContent.trim() : '';
  if (msg && typeof showToast === 'function') {
    showToast(msg, box.className.includes('status-error') ? 'error' : 'success', 6000);
  }
}

function spbEnStatus(html, type) { showStatus(html, type, 'spb-en-status'); }

// ── DRAFTS — the spbVr localStorage idiom, keyed (client, FY) ───────────────
const SPB_EN_DRAFT_KEY = 'spbEntryDrafts';
let spbEnDraftTimer = null;

function spbEnScheduleDraft() {
  clearTimeout(spbEnDraftTimer);
  spbEnDraftTimer = setTimeout(() => {
    try {
      const map = JSON.parse(localStorage.getItem(SPB_EN_DRAFT_KEY) || '{}');
      map[spbEnIdentity || spbDraftId()] = { rows: spbEnRows, ts: Date.now() };
      const ids = Object.keys(map).sort((a, b) => map[b].ts - map[a].ts);
      ids.slice(20).forEach(id => delete map[id]);
      localStorage.setItem(SPB_EN_DRAFT_KEY, JSON.stringify(map));
    } catch (e) { /* best-effort only */ }
  }, 600);
}

function spbEnReadDraft(key) {
  try {
    const map = JSON.parse(localStorage.getItem(SPB_EN_DRAFT_KEY) || '{}');
    const d = map[key];
    if (!d || !d.rows) return null;
    const rows = { sales: [], purchase: [] };
    SPB_SECTIONS.forEach(({ key: s }) => {
      (d.rows[s] || []).forEach(r => {
        const row = spbEnBlankRow();
        SPB_EN_KEYS.forEach(k => { if (r[k] != null) row[k] = String(r[k]); });
        if (!spbEnRowInert(row)) rows[s].push(row);
      });
    });
    return { rows, ts: d.ts || 0 };
  } catch (e) { return null; }
}

function spbEnDeleteDraft(key) {
  try {
    const map = JSON.parse(localStorage.getItem(SPB_EN_DRAFT_KEY) || '{}');
    delete map[key];
    localStorage.setItem(SPB_EN_DRAFT_KEY, JSON.stringify(map));
  } catch (e) { /* ignore */ }
}

// ── LIFECYCLE — the guarded hooks the core files call ───────────────────────
// Client switch (spbReset). In-memory rows go; the draft stays for the
// identity they belonged to, which is the whole point of keying drafts.
function spbEntryReset() {
  spbEnLastIdentity = spbEnIdentity;
  spbEnRows = { sales: [], purchase: [] };
  spbEnIdentity = null; spbEnDirty = false;
  spbEnPrior = []; spbEnPriorFor = null;
  if (spbSection === 'entry') spbRenderEntry();
}

// Client / FY / registration change (spbOnContextChange).
function spbEntryOnContext() {
  if (spbEnSyncIdentity() && spbSection === 'entry') spbRenderEntry();
}

// A saved book finished loading (spbLoadBook). The draft-vs-book decision was
// first made BEFORE the book row existed (the load is async), so it is
// re-made here with the real updated_at in hand: a newer draft re-applies
// itself over the loaded book; an older one steps aside for it.
function spbEntryOnBookLoaded() {
  spbEnSyncIdentity(true);
  if (spbSection === 'entry') spbRenderEntry();
}

// Rows on screen for the current section.
function spbEnSectionRows() { return spbEnRows[spbEnSection] || []; }

// Make the rows on screen belong to the identity on screen. Returns true when
// they changed. Draft wins over the stored book only when it is NEWER — a
// stale draft on a second machine must not shadow work saved from the first.
function spbEnSyncIdentity(force) {
  const key = spbDraftId();
  if (!force && key === spbEnIdentity) return false;
  const prevKey = spbEnIdentity || spbEnLastIdentity;
  spbEnIdentity = key;
  spbEnLastIdentity = null;
  spbEnDirty = false;

  let draft = spbEnReadDraft(key);

  // Rows typed before any client was picked follow the client just picked —
  // they can only have been typed on purpose, and losing them to the picker
  // would teach staff to fear it. Never fires between two real clients.
  if ((!draft || spbEnDraftEmpty(draft)) && prevKey && prevKey.startsWith('(NO CLIENT)|')
      && prevKey.split('|')[1] === key.split('|')[1]) {
    const orphan = spbEnReadDraft(prevKey);
    if (orphan && !spbEnDraftEmpty(orphan)) {
      draft = orphan;
      spbEnDeleteDraft(prevKey);
      spbEnDirty = true;
    }
  }

  const bookTs = spbBookMeta && spbBookMeta.updated_at ? Date.parse(spbBookMeta.updated_at) || 0 : 0;
  if (draft && !spbEnDraftEmpty(draft) && draft.ts >= bookTs) {
    spbEnRows = draft.rows;
    // A restored draft must become the module's book again, or the Register,
    // the Save button and Generate all read "nothing imported" while a full
    // sheet sits on screen. Not while an uploaded file is open — that book
    // belongs to the import pipeline.
    if (!spbRaw) spbEnApplyBook();
  } else {
    spbEnRows = { sales: [], purchase: [] };
    if (!spbRaw) spbEnSeedFromBook();
  }
  spbEnMonth = spbEnDefaultMonth();
  spbEnShowExtra = spbEnRows.purchase.some(r =>
    ['imp', 'impVat', 'cap', 'capVat'].some(k => String(r[k] || '').trim() !== ''));
  spbEnLoadPrior();
  return true;
}

function spbEnDraftEmpty(d) {
  return !SPB_SECTIONS.some(({ key }) => (d.rows[key] || []).length);
}

// A book already in memory (loaded from the database) becomes the sheet, so
// fixing one typo doesn't mean retyping a year. Amounts of 0 render blank —
// a page of zeros is Excel noise this screen exists to leave behind.
function spbEnSeedFromBook() {
  if (!spbData) return;
  SPB_SECTIONS.forEach(({ key }) => {
    if (!spbData[key]) return;
    spbEnRows[key] = spbData[key].txns.map(x => {
      const r = spbEnBlankRow();
      r.date = x.date || '';
      r.bill = x.bill != null && x.bill !== '' ? String(x.bill) : '';
      r.party = x.party === '(UNNAMED)' ? '' : (x.party || '');
      r.pan = x.pan || '';
      SPB_AMOUNT_KEYS.forEach(k => { r[k] = x[k] ? String(x[k]) : ''; });
      return r;
    });
  });
}

// Open the view on the month being worked on — the last row's month, not
// Shrawan, because entry resumes where it stopped.
function spbEnDefaultMonth() {
  const rows = spbEnSectionRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (spbEnRowInert(rows[i])) continue;
    const d = spbEnNormDate(rows[i].date, spbFyStartYear());
    if (d.fi != null) return d.fi;
  }
  return 0;
}

// ── APPLY — the typed sheet becomes the module's book ───────────────────────
// Mirrors what spbLoadBook does after rehydration. Only sections the sheet
// actually holds are touched: a purchase register loaded from the database
// survives a sales register being typed beside it.
function spbEnApplyBook() {
  const fyStart = spbFyStartYear();
  let touched = false;
  SPB_SECTIONS.forEach(({ key }) => {
    const live = (spbEnRows[key] || []).filter(r => !spbEnRowInert(r));
    if (!live.length) {
      if (spbData && spbData[key] && spbData[key].source === 'Manual entry') {
        spbData[key] = null; touched = true;
      }
      return;
    }
    if (!spbData) spbData = { sales: null, purchase: null };
    const sheet = spbEnSheet(spbEnRows[key], key);
    const parsed = spbParseRows(sheet.rows, sheet.header, fyStart, null,
      { section: key, panOnly: spbIsPanOnly() });
    parsed.source = 'Manual entry';
    spbData[key] = parsed;
    touched = true;
  });
  if (!touched) return;
  if (!spbVr) { spbVr = spbBlankVr(); spbVrLoadDraft(); }
  spbBook = spbData && SPB_SECTIONS.some(s => spbData[s.key]) ? spbComputeBook() : null;
  spbGroups = spbBook ? spbComputeGroups() : null;
  const genBtn = document.getElementById('spb-generate-btn');
  if (genBtn) genBtn.disabled = !(spbData && SPB_SECTIONS.some(s => spbData[s.key]));
  spbRenderVrGrid();
  if (spbBookId) spbDirty = true;
  spbRenderBookCard();
}

// ── PRIOR-YEAR PARTIES ──────────────────────────────────────────────────────
// The client's suppliers and customers barely change between years, so the
// autocomplete should know them from bill one of a NEW year — that is what
// makes the first hour of entry fast, not just the last. Reads the stored
// party rows of the client's OTHER saved books; silent and best-effort.
async function spbEnLoadPrior() {
  const ident = spbBookIdentity();
  const key = spbEnIdentity;
  if (!ident || !window.sb) { spbEnPrior = []; spbEnPriorFor = key; return; }
  if (spbEnPriorFor === key) return;
  spbEnPriorFor = key;
  try {
    let q = window.sb.from('autobooks_books').select('id, fiscal_year');
    q = ident.client_id != null
      ? q.eq('client_id', ident.client_id)
      : q.is('client_id', null).ilike('client_name', ident.client_name);
    const { data: books, error } = await q;
    if (error) throw error;
    const ids = (books || []).filter(b => b.fiscal_year !== ident.fiscal_year).map(b => b.id);
    if (!ids.length) { spbEnPrior = []; return; }
    const rows = await sbFetchAll(() => window.sb.from('autobooks_parties')
      .select('section, party_name, pan').in('book_id', ids).order('id', { ascending: true }));
    if (spbEnPriorFor !== key) return;   // identity moved on mid-flight
    spbEnPrior = rows || [];
  } catch (e) {
    console.warn('[Autobooks] prior-year party lookup failed', e);
    spbEnPrior = [];
  }
}

// The directory the suggestions and PAN checks read, rebuilt on demand.
function spbEnDirectory() {
  const src = [];
  SPB_SECTIONS.forEach(({ key }) => {
    (spbEnRows[key] || []).forEach(r => {
      if (String(r.party || '').trim()) src.push({ name: r.party, pan: r.pan, weight: 3 });
    });
    if (spbGroups && spbGroups[key]) {
      spbGroups[key].forEach(g => src.push({ name: spbOmPlainName(g.display), pan: g.pan, weight: 2 }));
    }
  });
  Object.keys(spbLedgerParties || {}).forEach(k => {
    const p = spbLedgerParties[k];
    src.push({ name: p.party_name, pan: p.pan, weight: 2 });
  });
  spbEnPrior.forEach(p => src.push({ name: p.party_name, pan: p.pan, weight: 1 }));
  return spbEnDirectoryBuild(src);
}

// ── RENDER ──────────────────────────────────────────────────────────────────
const SPB_EN_BASE_COLS = [
  { k: 'date', label: 'Date', w: 104, hint: '2082.04.15, "15", or a month name' },
  { k: 'bill', label: 'Bill No.', w: 84 },
  { k: 'party', label: 'Party Name', w: 0 },
  { k: 'pan', label: 'PAN', w: 104 },
  { k: 'taxfree', label: 'Tax Free', w: 104, num: true },
  { k: 'taxable', label: 'Taxable', w: 116, num: true },
  { k: 'vat', label: 'VAT', w: 104, num: true },
];
const SPB_EN_EXTRA_COLS = [
  { k: 'imp', label: 'Taxable Import', w: 110, num: true },
  { k: 'impVat', label: 'Import VAT', w: 100, num: true },
  { k: 'cap', label: 'Capital Purch.', w: 110, num: true },
  { k: 'capVat', label: 'Capital VAT', w: 100, num: true },
];

function spbEnCols() {
  return spbEnSection === 'purchase' && spbEnShowExtra
    ? SPB_EN_BASE_COLS.concat(SPB_EN_EXTRA_COLS) : SPB_EN_BASE_COLS;
}

function spbRenderEntry() {
  const host = document.getElementById('spb-en-body');
  if (!host) return;
  // The full-screen preference is sticky: once chosen, the sheet opens that
  // way on every visit until turned off.
  if (!spbEnFull) {
    try { spbEnFull = localStorage.getItem(SPB_EN_FULL_PREF) === '1'; } catch (e) { /* ignore */ }
  }
  spbEnApplyFullClass();
  spbEnSyncIdentity();

  // An uploaded file is open — its corrections belong in Data Doctor, and two
  // editors over one book is how they drift. One explicit door through.
  if (spbRaw) {
    host.innerHTML = `<div class="log-empty" style="padding:30px 22px;">
      <div style="margin-bottom:6px;">An uploaded file is open — corrections to it belong in the Import tab's Data Doctor.</div>
      <div style="color:var(--text-muted); font-size:13px; margin-bottom:16px;">
        The data-entry sheet is for books typed directly into the app. You can switch this book over:
        the rows as corrected so far become the sheet, and the uploaded file (with Data Doctor and
        column mapping) is closed.</div>
      <button class="btn btn-outline btn-sm" onclick="spbEnAdoptImport()">Edit this book as a sheet instead</button>
    </div>`;
    return;
  }

  const ident = spbBookIdentity();
  const cols = spbEnCols();
  const rows = spbEnSectionRows();
  const fyStart = spbFyStartYear();

  // Month pills with live counts.
  const counts = new Array(12).fill(0);
  let undated = 0;
  rows.forEach(r => {
    if (spbEnRowInert(r)) return;
    const d = spbEnNormDate(r.date, fyStart);
    if (d.fi != null) counts[d.fi]++; else undated++;
  });
  const total = counts.reduce((a, b) => a + b, 0) + undated;

  const pills = SPB_MONTH_NAMES.map((nm, fi) =>
    `<button type="button" class="spb-en-pill${spbEnMonth === fi ? ' active' : ''}" onclick="spbEnSetMonth(${fi})">` +
    `${escHtml(nm)}${counts[fi] ? `<span class="spb-en-pill-n">${counts[fi]}</span>` : ''}</button>`
  ).join('') +
  `<button type="button" class="spb-en-pill${spbEnMonth === -1 ? ' active' : ''}" onclick="spbEnSetMonth(-1)">` +
  `Whole year${total ? `<span class="spb-en-pill-n">${total}</span>` : ''}</button>`;

  const secBtns = SPB_SECTIONS.map(s =>
    `<button type="button" class="rep-view-btn${spbEnSection === s.key ? ' active' : ''}" ` +
    `onclick="spbEnSetSection('${s.key}')">${escHtml(s.label)}${(spbEnRows[s.key] || []).filter(r => !spbEnRowInert(r)).length
      ? ` (${(spbEnRows[s.key] || []).filter(r => !spbEnRowInert(r)).length})` : ''}</button>`).join('');

  const extraToggle = spbEnSection === 'purchase'
    ? `<label class="spb-en-toggle"><input type="checkbox" ${spbEnShowExtra ? 'checked' : ''} ` +
      `onchange="spbEnToggleExtra(this.checked)"> Import / Capital columns</label>` : '';

  const hasBookRows = spbData && spbData[spbEnSection] && spbData[spbEnSection].txns.length &&
    !rows.some(r => !spbEnRowInert(r));

  // In full screen the rest of the app is out of sight, so the toolbar has to
  // carry the context (whose book, which year) and the Save that normally
  // lives on the Import tab.
  const ctxChip = spbEnFull && ident
    ? `<span class="spb-en-ctx">${escHtml(ident.client_name)} · F.Y. ${escHtml(ident.fiscal_year)}</span>` : '';
  const fullBtns =
    (spbEnFull ? `<button class="btn btn-primary btn-sm" onclick="spbEnSave()">Save book</button>` : '') +
    `<button class="btn btn-outline btn-sm" onclick="spbEnToggleFull()">` +
    `${spbEnFull ? 'Exit full screen (Esc)' : '⛶ Full screen'}</button>`;

  host.innerHTML = `
    <div class="spb-en-toolbar">
      <div class="spb-en-tools">
        <div class="rep-view-toggle" style="margin:0;">${secBtns}</div>
        ${ctxChip}
      </div>
      <div class="spb-en-tools">
        ${extraToggle}
        ${hasBookRows ? `<button class="btn btn-outline btn-sm" onclick="spbEnLoadFromBook()">Load the ${escHtml(spbEnSection)} register into the sheet</button>` : ''}
        <input type="file" id="spb-en-file" accept=".xlsx,.xls,.ods,.csv" style="display:none;" onchange="spbEnImportFile(this)" />
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('spb-en-file').click()"
          title="Load a raw Excel book into this sheet exactly as typed — every mistake in it gets flagged here, row by row">
          Check an Excel file here</button>
        <button class="btn btn-outline btn-sm" onclick="spbEnClearSheet()">Clear this sheet</button>
        ${fullBtns}
      </div>
    </div>
    ${ident ? '' : `<div class="status-box status-info" style="display:block; margin-bottom:10px;">
      Pick a client and fiscal year at the top of the page — you can start typing now,
      but saving to the database needs both.</div>`}
    <div class="spb-en-pills">${pills}</div>
    <div id="spb-en-summary"></div>
    <div class="spb-en-wrap" id="spb-en-wrap">${spbEnTableHtml(cols)}</div>
    <p class="spb-en-help">Type a few letters of a party used before and pick it — the PAN fills itself; typing a
      known PAN fills the party. A blank VAT completes at 13% of its taxable when you leave the row.
      Dates accept <strong>2082.04.15</strong>, a bare day (<strong>15</strong> continues the row above),
      or a month name. <strong>Arrow keys move between cells</strong> and <strong>Enter</strong> moves down a
      column — a new row appears as you reach the end; ← and → keep editing the text while your cursor is
      inside a word.
      Everything autosaves as a draft on this computer — <strong>Save book to database</strong> (Import tab)
      makes it permanent and opens the Register, Parties and Annexure screens.
      <strong>Check an Excel file here</strong> loads a raw book into the sheet exactly as typed, so every
      date, PAN, VAT and bill-number mistake in the file gets flagged row by row — the Import tab, by
      contrast, is the clean-and-convert pipeline with Data Doctor.</p>`;

  spbEnRenderRows();
  spbEnRenderSummary();
}

function spbEnTableHtml(cols) {
  const colgroup = '<colgroup><col style="width:44px;">' +
    cols.map(c => `<col${c.w ? ` style="width:${c.w}px;"` : ''}>`).join('') +
    '<col style="width:36px;"></colgroup>';
  const head = '<tr><th class="spb-en-num">#</th>' +
    cols.map(c => `<th${c.num ? ' class="spb-en-r"' : ''}>${escHtml(c.label)}</th>`).join('') +
    '<th></th></tr>';
  const foot = `<tr><td class="spb-en-num"></td>` +
    cols.map(c => c.num
      ? `<td class="spb-en-r spb-en-tot" id="spb-en-tot-${c.k}">0.00</td>`
      : `<td class="spb-en-tot"${c.k === 'party' ? ' id="spb-en-tot-label"' : ''}>${c.k === 'party' ? 'Total (view)' : ''}</td>`).join('') +
    '<td></td></tr>';
  return `<table class="app-table spb-en-table" id="spb-en-table">
    ${colgroup}<thead>${head}</thead><tbody id="spb-en-tbody"></tbody><tfoot>${foot}</tfoot></table>`;
}

// Which absolute rows the current month view shows. Rows whose date cannot be
// read appear in EVERY view — hiding a broken row inside an unselected month
// is how it would never get fixed.
function spbEnComputeView() {
  const rows = spbEnSectionRows();
  const fyStart = spbFyStartYear();
  const view = [];
  rows.forEach((r, i) => {
    if (spbEnRowInert(r)) return;
    if (spbEnMonth === -1) { view.push(i); return; }
    const d = spbEnNormDate(r.date, fyStart);
    if (d.fi == null || d.fi === spbEnMonth) view.push(i);
  });
  return view;
}

function spbEnRenderRows() {
  const tbody = document.getElementById('spb-en-tbody');
  if (!tbody) return;
  // Deletions and abandoned trailing rows leave empty rows in the array —
  // compact them here, where indices are about to be re-issued anyway. Never
  // done mid-typing: this runs only on structural renders.
  spbEnRows[spbEnSection] = spbEnSectionRows().filter(r => !spbEnRowInert(r));
  // A structural render is exactly the moment the rows or the section may have
  // been swapped underneath the caches (section switch, client switch, draft
  // restore, seeding from a book) — so they are dropped here unconditionally
  // rather than at each of those call sites, where one omission is invisible.
  spbEnInvalidate();
  // The dropdown holds a reference to the input it was opened from. A render
  // replaces every cell, so an open list would be left pointing at a detached
  // element — and it swallows the arrow keys while it thinks it is open, which
  // is how the whole grid appeared to lose keyboard navigation.
  spbEnAcHide();
  spbEnView = spbEnComputeView();
  const cols = spbEnCols();
  const html = spbEnView.map((idx, n) => spbEnRowHtml(idx, n, cols));
  // One trailing blank row, always — typing into it is how the next bill
  // starts, the way a spreadsheet's next line is simply there.
  const blankIdx = spbEnEnsureTrailingRow();
  html.push(spbEnRowHtml(blankIdx, spbEnView.length, cols));
  spbEnView.push(blankIdx);
  tbody.innerHTML = html.join('');
  spbEnView.forEach(i => spbEnValidateRow(i));
  spbEnPatchTotals();
}

// The trailing blank row lives in the array so indices stay stable while it
// is being typed into.
function spbEnEnsureTrailingRow() {
  const rows = spbEnSectionRows();
  if (!rows.length || !spbEnRowInert(rows[rows.length - 1])) {
    rows.push(spbEnSeededBlank());
  }
  return rows.length - 1;
}

// A fresh row already knows what barely changes bill to bill: the date rides
// forward, and a SALES bill number counts on from the one above.
function spbEnSeededBlank() {
  const rows = spbEnSectionRows();
  const r = spbEnBlankRow();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (spbEnRowInert(rows[i])) continue;
    const fyStart = spbFyStartYear();
    const d = spbEnNormDate(rows[i].date, fyStart);
    if (spbEnMonth === -1 || d.fi == null || d.fi === spbEnMonth) {
      r.date = d.fi != null ? d.value : '';
      if (spbEnSection === 'sales') r.bill = spbEnNextBill(rows[i].bill);
      break;
    }
  }
  if (!r.date && spbEnMonth >= 0 && spbFyStartYear()) {
    const mon = SPB_BS_MONTHS[spbEnMonth];
    const year = mon >= 4 ? spbFyStartYear() : spbFyStartYear() + 1;
    r.date = `${year}.${String(mon).padStart(2, '0')}.01`;
  }
  return r;
}

function spbEnRowHtml(idx, viewN, cols) {
  const r = spbEnSectionRows()[idx];
  const cells = cols.map(c => {
    const v = r[c.k] == null ? '' : String(r[c.k]);
    return `<td class="spb-en-td"><input class="spb-en-in${c.num ? ' spb-en-r' : ''}" ` +
      `data-r="${idx}" data-k="${c.k}" value="${escHtml(v)}" autocomplete="off" spellcheck="false"` +
      `${c.hint ? ` title="${escHtml(c.hint)}"` : ''}></td>`;
  }).join('');
  return `<tr id="spb-en-row-${idx}"><td class="spb-en-num" id="spb-en-st-${idx}">${viewN + 1}</td>${cells}` +
    `<td class="spb-en-td"><button type="button" class="spb-en-del" data-del="${idx}" title="Delete this row" tabindex="-1">×</button></td></tr>`;
}

function spbEnPatchTotals() {
  const rows = spbEnSectionRows();
  const cols = spbEnCols();
  const tot = {};
  cols.forEach(c => { if (c.num) tot[c.k] = 0; });
  spbEnView.forEach(i => {
    const r = rows[i];
    if (!r || spbEnRowInert(r)) return;
    Object.keys(tot).forEach(k => { tot[k] += spbNum(r[k]); });
  });
  Object.keys(tot).forEach(k => {
    const el = document.getElementById('spb-en-tot-' + k);
    if (el) el.textContent = spbFmt(tot[k]);
  });
  const lbl = document.getElementById('spb-en-tot-label');
  if (lbl) lbl.textContent = spbEnMonth === -1 ? 'Total — whole year' : 'Total — ' + SPB_MONTH_NAMES[spbEnMonth];
}

// ── VALIDATION — per row, patched in place (the confirmation-grid rule:
//    never re-render under someone's fingers) ─────────────────────────────
function spbEnRowIssues(idx) {
  const r = spbEnSectionRows()[idx];
  if (!r || spbEnRowInert(r)) return [];
  const fyStart = spbFyStartYear();
  const issues = [];
  const d = spbEnNormDate(r.date, fyStart);
  if (String(r.date || '').trim() && d.error) {
    issues.push({ level: 'err', k: 'date', msg: 'Date not understood — use 2082.04.15 or a month name' });
  } else if (d.fi != null && fyStart) {
    const expected = d.mon >= 4 ? fyStart : fyStart + 1;
    if (d.year !== expected) issues.push({ level: 'warn', k: 'date', msg: `Outside F.Y. ${spbVal('spb-fy')}` });
  } else if (!String(r.date || '').trim()) {
    issues.push({ level: 'err', k: 'date', msg: 'No date — the row cannot be placed in a month' });
  }
  const pan = spbNormPan(r.pan);
  if (pan && !spbIsValidPan(pan)) {
    issues.push({ level: 'warn', k: 'pan', msg: 'A PAN is exactly 9 digits' });
  } else if (pan && String(r.party || '').trim()) {
    const dir = spbEnDirCache || spbEnDirectory();
    const mine = dir.find(e => e.safe === spbSafeKey(r.party));
    if (mine && mine.pan && mine.pan !== pan) {
      issues.push({ level: 'err', k: 'pan', msg: `This party has been entered with PAN ${mine.pan}` });
    } else {
      const owners = dir.filter(e => e.pan === pan && e.safe !== spbSafeKey(r.party));
      if (owners.length && (!mine || !mine.pan)) {
        issues.push({ level: 'warn', k: 'pan', msg: `PAN ${pan} is used by ${owners[0].name}` });
      }
    }
  }
  if (!String(r.party || '').trim()) issues.push({ level: 'warn', k: 'party', msg: 'No party name' });
  const panOnly = spbIsPanOnly();
  const vatExpected = !(spbEnSection === 'sales' && panOnly);
  SPB_VAT_PAIRS.forEach(([base, vk]) => {
    const b = spbNum(r[base]), v = spbNum(r[vk]);
    if (!vatExpected) {
      if (vk === 'vat' && v !== 0) issues.push({ level: 'warn', k: 'vat', msg: 'PAN-only client — sales carry no VAT' });
      return;
    }
    if (b === 0 || String(r[vk] || '').trim() === '') return;
    const exp = b * 0.13;
    if (Math.abs(v - exp) > Math.max(1, Math.abs(exp) * 0.01)) {
      issues.push({ level: 'warn', k: vk, msg: `VAT differs from 13% (expected ${spbFmt(exp)})` });
    }
  });
  // A duplicate is a cross-row fact, so it is computed once per edit and read
  // here — the Bill cell itself turns red, rather than the news of it living
  // only in a summary line.
  const dup = spbEnDups().get(idx);
  if (dup) issues.push({ level: dup.level, k: 'bill', msg: dup.msg });
  return issues;
}

let spbEnDirCache = null;
let spbEnDupCache = null;

// Both caches are derived from (rows × section), so ANY change to either has
// to drop them. Getting this wrong is not a stale-number problem: the two
// registers' duplicate rules are opposites, so a sales cache read while the
// purchase sheet is on screen would flag every supplier sharing a bill number
// — the exact false alarm the rule exists to prevent.
function spbEnInvalidate() {
  spbEnDirCache = null;
  spbEnDupCache = null;
}

// The cache stamps what it was built FROM, so a stale one can never be handed
// back across a section or row-array swap however this is reached. The
// explicit invalidations above still matter for edits, which mutate the rows
// in place and so leave both stamps unchanged.
function spbEnDups() {
  const rows = spbEnSectionRows();
  if (!spbEnDupCache || spbEnDupCache.section !== spbEnSection || spbEnDupCache.rows !== rows) {
    spbEnDupCache = {
      section: spbEnSection, rows,
      map: spbEnDupFindings(rows, spbEnSection, spbFyStartYear()),
    };
  }
  return spbEnDupCache.map;
}

function spbEnValidateRow(idx) {
  const tr = document.getElementById('spb-en-row-' + idx);
  if (!tr) return;
  const r = spbEnSectionRows()[idx];
  const issues = r && !spbEnRowInert(r) ? spbEnRowIssues(idx) : [];
  tr.querySelectorAll('.spb-en-in').forEach(inp => {
    inp.classList.remove('spb-en-bad', 'spb-en-warnc');
    const mine = issues.filter(x => x.k === inp.dataset.k);
    if (!mine.length) { inp.title = ''; return; }
    inp.classList.add(mine.some(x => x.level === 'err') ? 'spb-en-bad' : 'spb-en-warnc');
    inp.title = mine.map(x => x.msg).join(' · ');
  });
  const st = document.getElementById('spb-en-st-' + idx);
  if (st) {
    st.classList.remove('spb-en-st-err', 'spb-en-st-warn');
    if (issues.some(x => x.level === 'err')) st.classList.add('spb-en-st-err');
    else if (issues.length) st.classList.add('spb-en-st-warn');
    st.title = issues.map(x => x.msg).join(' · ');
  }
}

// The sheet-level findings a single row can't see: duplicates, sales
// bill-number gaps, and what the parser will exclude.
function spbEnRenderSummary() {
  const el = document.getElementById('spb-en-summary');
  if (!el) return;
  const rows = spbEnSectionRows().filter(r => !spbEnRowInert(r));
  if (!rows.length) { el.innerHTML = ''; return; }
  const all = spbEnSectionRows();
  const fy = spbFyStartYear();
  const notes = [];
  // Every finding carries WHERE it is — month, row and party — and clicking it
  // jumps to that cell. A bare count ("1 possible duplicate bill") leaves the
  // staff member to hunt through 1,600 lines, which is the work this module
  // exists to remove.
  const found = [];
  all.forEach((r, i) => {
    if (spbEnRowInert(r)) return;
    spbEnRowIssues(i).forEach(x => found.push({ idx: i, ...x }));
  });
  const errs = found.filter(f => f.level === 'err').length;
  const warns = found.length - errs;
  const SHOW = 12;
  const shown = found.slice().sort((a, b) =>
    (a.level === b.level ? a.idx - b.idx : a.level === 'err' ? -1 : 1)).slice(0, SHOW);
  const findingHtml = shown.map(f => {
    const at = spbEnRowLabel(all, f.idx, fy);
    const party = String(all[f.idx].party || '').trim();
    return `<div class="spb-en-finding${f.level === 'err' ? ' spb-en-finding-err' : ''}" ` +
      `onclick="spbEnGoToRow(${f.idx})" title="Go to this row">` +
      `<span class="spb-en-finding-at">${escHtml(at.month)} · row ${at.n}` +
      `${party ? ' · ' + escHtml(party) : ''}</span> ${escHtml(f.msg)}</div>`;
  }).join('');
  const moreN = found.length - shown.length;

  if (spbEnSection === 'sales') {
    const bills = rows.map(r => parseInt(String(r.bill || '').replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    if (bills.length > 1) {
      const uniq = [...new Set(bills)].sort((a, b) => a - b);
      const missing = [];
      for (let i = 1; i < uniq.length; i++) {
        const from = uniq[i - 1] + 1, to = uniq[i] - 1;
        if (to < from || to - from >= 50) continue;      // a 50+ jump is a new series, not a gap
        missing.push(from === to ? String(from) : `${from}–${to}`);
      }
      // Naming the missing numbers is the difference between a note and an
      // instruction — the IRD asks which bills are missing, not how many.
      if (missing.length) {
        notes.push(`Missing sales bill no. ${missing.slice(0, 8).join(', ')}` +
          `${missing.length > 8 ? ` and ${missing.length - 8} more` : ''} (IRD audit point)`);
      }
    }
  }
  const chips = [];
  chips.push(`<span class="log-badge">${rows.length.toLocaleString('en-US')} bill line${rows.length > 1 ? 's' : ''}</span>`);
  if (errs) chips.push(`<span class="log-badge badge-error">${errs} to fix</span>`);
  if (warns) chips.push(`<span class="log-badge badge-yellow">${warns} to check</span>`);
  if (!errs && !warns) chips.push('<span class="log-badge badge-sent">clean</span>');
  el.innerHTML = `<div class="spb-en-summary">${chips.join(' ')}` +
    (notes.length ? `<span class="spb-en-notes">${notes.map(escHtml).join(' · ')}</span>` : '') + '</div>' +
    (findingHtml ? `<div class="spb-en-findings">${findingHtml}` +
      (moreN > 0 ? `<div class="spb-en-finding-more">and ${moreN} more — the ● beside a row number marks it in the grid</div>` : '') +
      '</div>' : '');
}

// Jump to the row a finding names. The row OBJECT is captured before the
// re-render, not its index: spbEnRenderRows() compacts inert rows out of the
// array, so an index taken beforehand can point at a different bill by the
// time the grid is redrawn.
function spbEnGoToRow(idx) {
  const row = spbEnSectionRows()[idx];
  if (!row) return;
  const fi = spbEnNormDate(row.date, spbFyStartYear()).fi;
  if (fi != null && spbEnMonth !== -1 && spbEnMonth !== fi) {
    spbEnMonth = fi;
    spbRenderEntry();
  }
  const at = spbEnSectionRows().indexOf(row);
  const tr = document.getElementById('spb-en-row-' + at);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr.classList.add('spb-en-flash');
  setTimeout(() => tr.classList.remove('spb-en-flash'), 1600);
  const inp = tr.querySelector('input[data-k="bill"]');
  if (inp) { inp.focus(); inp.select(); }
}

// ── EVENTS — delegated once; rows are patched, never re-rendered mid-typing ─
function spbEnOnChange(inp) {
  const idx = parseInt(inp.dataset.r, 10);
  const k = inp.dataset.k;
  const rows = spbEnSectionRows();
  const r = rows[idx];
  if (!r) return;
  const prevVal = r[k];
  r[k] = inp.value;
  spbEnDirty = true;

  if (k === 'date') {
    const prev = spbEnPrevDated(idx);
    const d = spbEnNormDate(inp.value, spbFyStartYear(), prev);
    if (!d.error && d.value !== inp.value) { r.date = d.value; inp.value = d.value; }
  }
  if (k === 'pan') {
    const pan = spbNormPan(inp.value);
    if (pan !== inp.value.trim()) { r.pan = pan; inp.value = pan; }
    if (spbIsValidPan(pan) && !String(r.party || '').trim()) {
      const hits = spbEnPanMatches(spbEnDirCache || spbEnDirectory(), pan, false);
      if (hits.length === 1) spbEnSetCell(idx, 'party', hits[0].name);
    }
  }
  if (k === 'party') {
    const dir = spbEnDirCache || spbEnDirectory();
    const hit = dir.find(e => e.safe === spbSafeKey(inp.value));
    if (hit && hit.pan && !String(r.pan || '').trim()) spbEnSetCell(idx, 'pan', hit.pan);
  }
  // A blank VAT beside its taxable completes at 13% — the importer's own rule,
  // running while the row is still under the user's eyes. A VAT the user typed
  // is theirs and is never touched.
  //
  // Whether the sitting VAT was ours is read from the FIGURES, not only from
  // the `_auto` flag: a VAT that is exactly 13% of the amount being replaced
  // was plainly derived from it, so it follows the correction. The flag alone
  // could not answer this — it does not survive a draft reload (drafts store
  // the typed columns, not internal state), so after reopening a book,
  // correcting a taxable left yesterday's VAT sitting beside it.
  const pair = SPB_VAT_PAIRS.find(([base]) => base === k);
  if (pair) {
    const [base, vk] = pair;
    const vatExpected = !(spbEnSection === 'sales' && spbIsPanOnly());
    r._auto = r._auto || {};
    const sitting = String(r[vk] || '').trim();
    const wasDerived = sitting === '' || r._auto[vk] ||
      (spbNum(prevVal) !== 0 && Math.abs(spbNum(sitting) - spbNum(prevVal) * 0.13) < 0.005);
    if (vatExpected && wasDerived) {
      const b = spbNum(r[base]);
      const v = b ? String(Math.round(b * 0.13 * 100) / 100) : '';
      spbEnSetCell(idx, vk, v);
      r._auto[vk] = true;
    }
  }
  if (SPB_VAT_PAIRS.some(([, vk]) => vk === k)) {
    r._auto = r._auto || {};
    r._auto[k] = false;      // hand-typed VAT — the autofill lets go
  }

  if (idx === rows.length - 1 && !spbEnRowInert(r)) spbEnAppendTrailing();
  spbEnInvalidate();
  spbEnValidateRow(idx);
  spbEnApplyBook();
  spbEnPatchTotals();
  spbEnRenderSummary();
  spbEnScheduleDraft();
}

function spbEnPrevDated(idx) {
  const rows = spbEnSectionRows();
  for (let i = idx - 1; i >= 0; i--) {
    if (spbEnRowInert(rows[i])) continue;
    const d = spbEnNormDate(rows[i].date, spbFyStartYear());
    if (d.fi != null) return d.value;
  }
  return '';
}

// Writes a cell into both the model and, when rendered, the input — the only
// way autofill may touch the DOM, so model and screen cannot disagree.
function spbEnSetCell(idx, k, v) {
  const rows = spbEnSectionRows();
  if (!rows[idx]) return;
  rows[idx][k] = v;
  const inp = document.querySelector(`#spb-en-row-${idx} input[data-k="${k}"]`);
  if (inp) inp.value = v;
}

function spbEnAppendTrailing() {
  const rows = spbEnSectionRows();
  rows.push(spbEnSeededBlank());
  const idx = rows.length - 1;
  const tbody = document.getElementById('spb-en-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.id = 'spb-en-row-' + idx;
  tr.innerHTML = spbEnRowHtml(idx, spbEnView.length, spbEnCols()).replace(/^<tr[^>]*>|<\/tr>$/g, '');
  tbody.appendChild(tr);
  spbEnView.push(idx);
}

function spbEnDeleteRow(idx) {
  const rows = spbEnSectionRows();
  if (!rows[idx]) return;
  rows.splice(idx, 1);
  spbEnDirty = true;
  spbEnInvalidate();
  spbEnRenderRows();
  spbEnApplyBook();
  spbEnRenderSummary();
  spbEnScheduleDraft();
}

// ── Keyboard navigation — the spreadsheet reflexes ─────────────────────────
// Enter and ↓ move down the column, ↑ moves up, ← → move across. Tab keeps
// its native behaviour.
//
// Left/Right move a CELL only when the caret is already at the end of the
// text it would otherwise travel through (and nothing is selected) — inside a
// half-typed party name those keys still have to edit text. Up/Down always
// move, since a single-line input has no vertical text meaning. That split is
// what lets one key set serve both editing and navigation.
//
// The autocomplete owns the arrows while its list is open, and is asked first.
// Landing on a cell selects its whole value, and a fully-selected cell counts
// as NOT being edited — ← and → navigate straight out of it, the way Excel
// moves across a row of filled cells. Without this the arrows died at the
// first cell that had anything in it. Clicking into the text or typing
// collapses the selection, and text editing takes over again.
function spbEnWholeSelected(inp) {
  const n = (inp.value || '').length;
  return n > 0 && inp.selectionStart === 0 && inp.selectionEnd === n;
}

function spbEnCaretAtStart(inp) {
  return (inp.selectionStart === 0 && inp.selectionEnd === 0) || spbEnWholeSelected(inp);
}

function spbEnCaretAtEnd(inp) {
  const n = (inp.value || '').length;
  return (inp.selectionStart === n && inp.selectionEnd === n) || spbEnWholeSelected(inp);
}

function spbEnOnKeydown(e) {
  const inp = e.target;
  if (!inp.classList || !inp.classList.contains('spb-en-in')) return;
  if (spbEnAcOpen()) { spbEnAcKey(e); return; }
  let dRow = 0, dCol = 0;
  if (e.key === 'Enter' || e.key === 'ArrowDown') dRow = 1;
  else if (e.key === 'ArrowUp') dRow = -1;
  else if (e.key === 'ArrowLeft' && spbEnCaretAtStart(inp)) dCol = -1;
  else if (e.key === 'ArrowRight' && spbEnCaretAtEnd(inp)) dCol = 1;
  else return;
  e.preventDefault();
  spbEnMove(inp, dRow, dCol);
}

function spbEnMove(inp, dRow, dCol) {
  // Leaving a cell commits it, so autofill and validation have run before the
  // next cell is reached — the same order Enter has always followed.
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  const cols = spbEnCols().map(c => c.k);
  let ci = cols.indexOf(inp.dataset.k) + dCol;
  if (ci < 0 || ci >= cols.length) return;         // stops at the edge, as Excel does
  let pos = spbEnView.indexOf(parseInt(inp.dataset.r, 10)) + dRow;
  if (pos < 0) return;
  if (pos >= spbEnView.length) {
    // Moving down off the end opens the next row — unless the row already
    // sitting there is the untouched blank one, or arrowing down would breed
    // empty rows forever.
    const last = spbEnSectionRows()[spbEnView[spbEnView.length - 1]];
    if (!last || spbEnRowInert(last)) return;
    spbEnAppendTrailing();
    pos = spbEnView.length - 1;
  }
  const next = document.querySelector(`#spb-en-row-${spbEnView[pos]} input[data-k="${cols[ci]}"]`);
  if (next) { next.focus(); next.select(); }
}

// ── AUTOCOMPLETE — one floating list for the whole grid ─────────────────────
// A grid re-renders its cells, and SearchEngine.attachAutocomplete binds a
// document-level listener per input — attached per cell per render that is a
// slow leak by design. So the grid runs ONE delegated dropdown styled as the
// shared .autocomplete-list, with the CommandPalette's ranking (prefixes, not
// Fuse). The single-input pickers everywhere else stay on SearchEngine.
let spbEnAc = { el: null, items: [], idx: -1, input: null };

function spbEnAcOpen() { return !!(spbEnAc.el && spbEnAc.el.style.display !== 'none'); }

function spbEnAcHide() {
  if (spbEnAc.el) spbEnAc.el.style.display = 'none';
  spbEnAc.items = []; spbEnAc.idx = -1; spbEnAc.input = null;
}

function spbEnAcShow(inp, items) {
  if (!items.length) { spbEnAcHide(); return; }
  let el = spbEnAc.el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'autocomplete-list spb-en-ac';
    document.body.appendChild(el);
    spbEnAc.el = el;
  }
  spbEnAc.items = items; spbEnAc.idx = -1; spbEnAc.input = inp;
  el.innerHTML = items.map(it =>
    `<div class="autocomplete-item"><strong>${escHtml(it.name)}</strong>` +
    (it.pan ? `<span class="spb-en-ac-pan">PAN ${escHtml(it.pan)}</span>` : '') + '</div>').join('');
  el.querySelectorAll('.autocomplete-item').forEach((row, i) => {
    row.addEventListener('mousedown', ev => { ev.preventDefault(); spbEnAcPick(i); });
  });
  const rect = inp.getBoundingClientRect();
  el.style.display = 'block';
  el.style.position = 'fixed';
  el.style.left = rect.left + 'px';
  el.style.top = rect.bottom + 2 + 'px';
  el.style.minWidth = Math.max(rect.width, 240) + 'px';
}

function spbEnAcPick(i) {
  const it = spbEnAc.items[i];
  const inp = spbEnAc.input;
  spbEnAcHide();
  if (!it || !inp) return;
  const idx = parseInt(inp.dataset.r, 10);
  const rows = spbEnSectionRows();
  const r = rows[idx];
  if (!r) return;
  spbEnSetCell(idx, 'party', it.name);
  // The picked party's PAN fills a blank PAN. One the user already typed
  // differently stays — the conflict shows red instead of being overwritten,
  // the same only-fill-a-blank contract the carry-forward follows.
  if (it.pan && !String(r.pan || '').trim()) spbEnSetCell(idx, 'pan', it.pan);
  r.party = it.name;
  spbEnDirty = true;
  spbEnInvalidate();
  spbEnValidateRow(idx);
  spbEnApplyBook();
  spbEnPatchTotals();
  spbEnRenderSummary();
  spbEnScheduleDraft();
  const target = document.querySelector(`#spb-en-row-${idx} input[data-k="taxable"]`);
  if (target) { target.focus(); target.select(); }
}

function spbEnAcKey(e) {
  const n = spbEnAc.items.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); spbEnAc.idx = Math.min(spbEnAc.idx + 1, n - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); spbEnAc.idx = Math.max(spbEnAc.idx - 1, 0); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (spbEnAc.idx >= 0) { spbEnAcPick(spbEnAc.idx); return; }
    spbEnAcHide();
    spbEnOnKeydown(e);
    return;
  } else if (e.key === 'Escape') { e.stopPropagation(); spbEnAcHide(); return; }
  else return;
  if (spbEnAc.el) spbEnAc.el.querySelectorAll('.autocomplete-item')
    .forEach((row, i) => row.classList.toggle('selected', i === spbEnAc.idx));
}

function spbEnOnInput(inp) {
  if (!inp.classList || !inp.classList.contains('spb-en-in')) return;
  const k = inp.dataset.k;
  if (k === 'party') {
    if (!spbEnDirCache) spbEnDirCache = spbEnDirectory();
    const q = inp.value.trim();
    if (q.length >= 1) spbEnAcShow(inp, spbEnSuggest(spbEnDirCache, q, 8));
    else spbEnAcHide();
  } else if (k === 'pan') {
    if (!spbEnDirCache) spbEnDirCache = spbEnDirectory();
    const hits = spbEnPanMatches(spbEnDirCache, inp.value, true);
    if (hits.length) spbEnAcShow(inp, hits.slice(0, 8));
    else spbEnAcHide();
  }
}

// ── TOOLBAR ACTIONS ─────────────────────────────────────────────────────────
function spbEnSetSection(key) {
  if (!SPB_SECTIONS.some(s => s.key === key)) return;
  spbEnSection = key;
  spbEnMonth = spbEnDefaultMonth();
  spbEnShowExtra = key === 'purchase' && spbEnRows.purchase.some(r =>
    ['imp', 'impVat', 'cap', 'capVat'].some(k => String(r[k] || '').trim() !== ''));
  spbRenderEntry();
}

function spbEnSetMonth(fi) {
  spbEnMonth = fi;
  spbRenderEntry();
}

function spbEnToggleExtra(on) {
  spbEnShowExtra = !!on;
  spbRenderEntry();
}

function spbEnLoadFromBook() {
  if (!spbData || !spbData[spbEnSection]) return;
  spbEnRows[spbEnSection] = [];
  spbEnSeedFromBook();
  spbEnMonth = spbEnDefaultMonth();
  spbRenderEntry();
}

function spbEnClearSheet() {
  const n = spbEnSectionRows().filter(r => !spbEnRowInert(r)).length;
  if (n && !confirm(`Clear all ${n} typed ${spbEnSection} row${n > 1 ? 's' : ''} from the sheet? ` +
    'Rows already saved to the database stay saved until the next Save.')) return;
  spbEnRows[spbEnSection] = [];
  spbEnDirty = true;
  spbEnInvalidate();
  spbEnApplyBook();
  spbEnScheduleDraft();
  spbRenderEntry();
}

// ── Import an Excel file straight into the sheet ────────────────────────────
// The mistake-hunting flow: the raw file lands in the grid as typed, and the
// grid's validation — bad dates, PAN conflicts, VAT off 13%, duplicate bill
// numbers with month/row/party locations — does the finding. Distinct from the
// Import tab on purpose: that pipeline produces a CLEAN book via Data Doctor;
// this one shows the dirt. spbRaw is never set, so the two paths cannot mix.
async function spbEnImportFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  spbEnStatus(`⏳ Reading ${escHtml(file.name)}…`, 'searching');
  try {
    await LibLoader.ensure('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const found = {};
    const notes = [];
    wb.SheetNames.forEach(sn => {
      let kind = spbClassifySheet(sn);
      // Single-sheet exports often carry a generic sheet name — the file name
      // decides (the spbHandleFiles rule).
      if (!kind && wb.SheetNames.length === 1) kind = spbClassifySheet(file.name);
      if (!kind || found[kind]) return;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
      const header = spbFindHeader(rows);
      if (!header) {
        notes.push(`"${escHtml(sn)}" looks like a ${kind} sheet but its columns weren't recognized — for a non-standard layout, upload it on the Import tab and assign the columns there.`);
        return;
      }
      found[kind] = spbEnRowsFromSheet(rows, header, spbFyStartYear());
    });
    if (!found.sales && !found.purchase) {
      spbEnStatus('❌ No Sales or Purchase sheet recognized in that file' +
        (notes.length ? ' — ' + notes.join(' ') : ` (sheets: ${escHtml(wb.SheetNames.join(', '))}).`), 'error');
      return;
    }
    const replacing = SPB_SECTIONS.filter(s =>
      found[s.key] && (spbEnRows[s.key] || []).some(r => !spbEnRowInert(r)));
    if (replacing.length && !confirm(
      `Replace the ${replacing.map(s => s.label).join(' and ')} rows already on the sheet with the file's rows?\n\n` +
      'Rows already saved to the database stay saved until the next Save.')) {
      spbEnStatus('ℹ️ Import cancelled — the sheet is unchanged.', 'info');
      return;
    }
    SPB_SECTIONS.forEach(({ key }) => { if (found[key]) spbEnRows[key] = found[key].rows; });
    if (!found[spbEnSection]) spbEnSection = found.sales ? 'sales' : 'purchase';
    spbEnDirty = true;
    spbEnInvalidate();
    spbEnMonth = spbEnDefaultMonth();
    spbEnShowExtra = spbEnRows.purchase.some(r =>
      ['imp', 'impVat', 'cap', 'capVat'].some(k => String(r[k] || '').trim() !== ''));
    spbEnApplyBook();
    spbEnScheduleDraft();
    spbRenderEntry();
    const parts = SPB_SECTIONS.filter(s => found[s.key])
      .map(s => `${s.label}: ${found[s.key].rows.length.toLocaleString('en-US')} rows` +
        (found[s.key].subtotals ? ` (${found[s.key].subtotals} month-total lines skipped)` : ''));
    spbEnStatus(`✅ Loaded into the sheet — ${parts.join(' · ')}.` +
      (notes.length ? ' ' + notes.join(' ') : '') +
      ' Anything flagged below is exactly as it reads in the file.', 'success');
    AuditLog.record('spb_entry_imported', {
      module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
      detail: { fiscalYear: spbVal('spb-fy'), file: file.name,
        rows: SPB_SECTIONS.reduce((a, s) => a + (found[s.key] ? found[s.key].rows.length : 0), 0) },
    });
  } catch (err) {
    console.error('[Autobooks] sheet import failed', err);
    spbEnStatus('❌ Could not read that file: ' + escHtml(err && err.message ? err.message : String(err)), 'error');
  }
}

// The one-way door out of an uploaded file: its corrected rows become the
// sheet and spbRaw closes, so there is exactly one editor at a time.
function spbEnAdoptImport() {
  if (!spbRaw) return;
  if (!confirm('Switch this book to sheet editing? The uploaded file closes — Data Doctor, column ' +
    'mapping and re-parse go with it — and the rows as corrected so far become the editable sheet.')) return;
  spbRaw = null;
  spbEnRows = { sales: [], purchase: [] };
  spbEnSeedFromBook();
  spbEnDirty = true;
  spbEnMonth = spbEnDefaultMonth();
  spbEnScheduleDraft();
  spbRenderEntry();
}

// ── BOOT — panel exists at parse time (deferred scripts), wire once ─────────
(function spbEnBoot() {
  const host = document.getElementById('spb-en-body');
  if (!host) return;
  host.addEventListener('input', e => { if (e.target.matches && e.target.matches('.spb-en-in')) spbEnOnInput(e.target); });
  host.addEventListener('change', e => { if (e.target.matches && e.target.matches('.spb-en-in')) spbEnOnChange(e.target); });
  host.addEventListener('keydown', spbEnOnKeydown, true);
  host.addEventListener('click', e => {
    const del = e.target.closest && e.target.closest('.spb-en-del');
    if (del) spbEnDeleteRow(parseInt(del.dataset.del, 10));
  });
  host.addEventListener('focusin', e => {
    // Tab moves focus without a click — a list left open would then act on
    // the wrong cell.
    if (spbEnAcOpen() && spbEnAc.input !== e.target) spbEnAcHide();
    if (e.target.matches && e.target.matches('.spb-en-in.spb-en-r')) e.target.select();
  });
  // A fixed-position dropdown must not float free of a scrolled cell.
  host.addEventListener('scroll', spbEnAcHide, true);
  window.addEventListener('resize', spbEnAcHide);
  // Esc leaves full screen — but only once the autocomplete has had its turn
  // (its own Escape closes the list and stops propagation, the searchEngine
  // rule), and only while the sheet is actually on screen.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !spbEnFull || spbEnAcOpen()) return;
    if (spbSection !== 'entry') return;
    const panel = document.getElementById('tab-salesPurchaseBook-panel');
    if (!panel || !panel.classList.contains('active')) return;   // another tab is fronted
    spbEnToggleFull(false);
  });
  document.addEventListener('click', e => {
    if (spbEnAcOpen() && spbEnAc.input !== e.target &&
        !(spbEnAc.el && spbEnAc.el.contains(e.target))) spbEnAcHide();
  });

  // FIRST, ahead of Import (2026-08-29, user ask). Typing the book in the app
  // is now the way a book starts; uploading a spreadsheet is the fallback, so
  // the order follows the work rather than the module's own history. This is
  // also the landing section — a first tab that isn't the one you land on
  // reads as a mis-click.
  SPB_SECTION_TABS.unshift({ key: 'entry', label: 'Data Entry', panel: 'spb-sec-entry', onShow: 'spbRenderEntry' });
  spbShowSection('entry');
})();
