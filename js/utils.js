// ════════════════════════════════════════════
//  UTILS — shared helper functions
// ════════════════════════════════════════════

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
