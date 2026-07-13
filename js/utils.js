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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ════════════════════════════════════════════
//  FUZZY STRING SIMILARITY
//  Returns 0.0 (completely different) to 1.0 (identical)
//  Uses Levenshtein edit distance normalised by string length
// ════════════════════════════════════════════
function stringSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a.length || !b.length) return 0.0;

  // Build Levenshtein distance matrix
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i-1] === b[j-1]) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
  }

  const dist = dp[a.length][b.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}
