// ════════════════════════════════════════════
//  UTILS — shared helper functions
// ════════════════════════════════════════════

// The app's only XSS defence — the CSP keeps 'unsafe-inline' for scripts, so
// it cannot stop injected inline script and escaping is what actually covers
// this (CLAUDE.md §13). Used in 615 places.
//
// The apostrophe matters. Without it a value placed inside a SINGLE-quoted
// attribute — title='...', or any hand-built markup — can close the attribute
// and add another. No such interpolation exists today (checked: every
// interpolated attribute in js/ is double-quoted), so this is defence in
// depth rather than a live fix, and it is exactly the kind of gap that opens
// quietly the first time someone writes title='${escHtml(x)}'.
//
// &#39; rather than &apos;: the latter is not in the HTML 4 entity set and is
// unreliable in older parsers, while the numeric form is universal. Safe to
// add because no caller writes escHtml() output into textContent or .value,
// where an entity would show literally instead of rendering (also checked).
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// Supabase/PostgREST caps a single select at 1000 rows — any query that can
// grow past that must page through .range() windows or it silently truncates.
// `buildQuery` is a factory (query builders are single-use), and the query it
// returns must have a stable .order() for the windows to be consistent.
async function sbFetchAll(buildQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) return all;
  }
}

// Money for display: "1,234.50", always two decimals. Was written identically
// as bbAmt (bankBook) and smNum (serviceMemo); Party Ledger and Final Account
// made it four copies, so it lives here now.
function fmtAmount(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ════════════════════════════════════════════
//  STRING SIMILARITY — 0..1, used wherever a human typo has to be told apart
//  from a genuinely different value (party spellings, B.S. month names,
//  mistyped PANs in Autobooks).
//
//  DAMERAU-Levenshtein, not plain Levenshtein: a TRANSPOSITION must cost one
//  edit, not two. Real books are full of them — a client's purchase sheet
//  spelled Bhadra "BHARDA", which plain Levenshtein scores 0.667 (below every
//  sane threshold) while Damerau scores 0.833. That single character pair was
//  dropping a Rs 2,184,000 row out of a VAT book.
//
//  Callers must still gate on a minimum length: at 3 characters almost
//  anything scores well against almost anything.
// ════════════════════════════════════════════
function stringSimilarity(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - damerauLevenshtein(a, b) / max;
}

function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  // Three rows are enough for the optimal-string-alignment variant (the
  // transposition step only ever looks back two rows).
  let prev2 = null, prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev; prev = cur; cur = new Array(n + 1);
  }
  return prev[n];
}

// ════════════════════════════════════════════
//  FIRM PICKER — a click/focus-to-open list of a small FIXED set of items
//  (e.g. the firm's own known audit firms), reusing the same
//  .autocomplete-list/.autocomplete-item visual language as the text-search
//  autocomplete (SearchEngine.attachAutocomplete) without that engine's
//  fuzzy-search-on-typed-input machinery, which doesn't fit a "show the
//  whole fixed list immediately" picker.
// ════════════════════════════════════════════
function attachFirmPicker(triggerEl, listEl, options) {
  function render() {
    const items = options.getItems();
    listEl.innerHTML = items.map(item => `<div class="autocomplete-item">${options.renderItem(item)}</div>`).join('');
    Array.from(listEl.children).forEach((el, i) => {
      el.addEventListener('mousedown', e => { e.preventDefault(); hide(); options.onSelect(items[i], i); });
    });
  }
  function show() { render(); listEl.style.display = 'block'; }
  function hide() { listEl.style.display = 'none'; }
  function toggle() { if (listEl.style.display === 'none' || !listEl.style.display) show(); else hide(); }

  triggerEl.addEventListener(options.openOn === 'focus' ? 'focus' : 'click', options.openOn === 'focus' ? show : toggle);
  document.addEventListener('mousedown', e => {
    if (!triggerEl.contains(e.target) && !listEl.contains(e.target)) hide();
  });
  return { show, hide };
}

// ── Plain-language database errors (Stage 6, 2026-08-21) ──
// Raw PostgREST/Postgres messages ("duplicate key value violates unique
// constraint …", "permission denied for function current_org_id") read as
// gibberish to accountants. This maps the handful of failure classes staff
// actually hit to a sentence naming the fix; anything unrecognized passes
// through untouched, because hiding a real message is worse than jargon.
// Callers still escHtml() the result — this returns plain text.
function friendlyDbError(e) {
  const raw = (e && (e.message || String(e))) || 'unknown error';
  const m = raw.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))
    return 'the connection dropped — check the internet and try again';
  if (m.includes('duplicate key'))
    return 'a record with these details already exists';
  if (m.includes('permission denied') || m.includes('row-level security') || (e && e.code === '42501'))
    return 'your account does not have permission for this — ask your admin';
  if ((m.includes('jwt') && m.includes('expired')) || m.includes('invalid token'))
    return 'your sign-in expired — sign out and back in';
  if (m.includes('violates foreign key'))
    return 'this record is still linked to other records and cannot change this way';
  if (m.includes('value too long'))
    return 'one of the fields is too long to save';
  if (m.includes('timeout') || m.includes('timed out'))
    return 'the server took too long — it may be waking up; try again in a moment';
  return raw;
}
