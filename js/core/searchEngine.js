// ════════════════════════════════════════════
//  SEARCH ENGINE
//  Owns the filter-on-input, render-matches, arrow-key nav, Enter-to-select,
//  and outside-click-close behavior that clients.js, report.js (x2 fields),
//  and bmAgmMinutes.js each independently hand-rolled as near-identical
//  copies. Backed by Fuse.js instead of plain .includes() substring
//  matching, so search is typo-tolerant as a side effect of deduplicating.
// ════════════════════════════════════════════
window.SearchEngine = (function () {
  // Session-scoped recent picks, shared across every autocomplete and keyed
  // per input element (Stage 6, 2026-08-21). Staff record an intake, a work
  // record, an ARF row and a memo for the SAME client back to back — the
  // recents list turns the 2nd-4th retype of that name into one click.
  // Deliberately in-memory only: nothing about clients touches localStorage
  // on a shared office machine.
  const recentPicks = {};
  const RECENTS_MAX = 5;

  function buildIndex(list, keys, fuseOptions) {
    return new Fuse(list, Object.assign({ keys, threshold: 0.3, ignoreLocation: true }, fuseOptions));
  }

  // config:
  //   getList()           -> array to search (e.g. () => window.clientsList)
  //   keys                -> Fuse.js keys to match against
  //   renderItem(item)    -> inner HTML for one result row
  //   onSelect(item)      -> called with the selected item (always the
  //                          original, un-normalized record — see normalizeItem)
  //   minChars            -> default 1
  //   maxResults          -> default 8
  //   normalizeQuery(q)   -> optional, transforms the typed value before matching
  //   normalizeItem(item) -> optional, returns the record actually indexed
  //                          against (e.g. digit-normalized); onSelect still
  //                          always receives the original item
  //   fuseOptions         -> optional, merged into the Fuse constructor options
  function attachAutocomplete(inputEl, listEl, config) {
    let selectedIdx = -1;
    let currentMatches = [];
    // Fuse index cache. Building one is O(list) — over 314 clients, per
    // keystroke, in each of the ~17 autocompletes, that was the single
    // hottest path in the app. Keyed on the *identity* of the array getList()
    // returns: loadClients() replaces window.clientsList wholesale rather
    // than mutating it, so a new reference is an exact "the data changed"
    // signal. Length is checked too, so a caller that does mutate in place
    // still gets a rebuild in the common case.
    let cachedFuse = null, cachedSrc = null, cachedLen = -1;

    function indexFor(list) {
      if (cachedFuse && list === cachedSrc && list.length === cachedLen) return cachedFuse;
      const indexList = config.normalizeItem
        ? list.map(item => Object.assign(config.normalizeItem(item), { __orig: item }))
        : list;
      cachedFuse = buildIndex(indexList, config.keys, config.fuseOptions);
      cachedSrc = list;
      cachedLen = list.length;
      return cachedFuse;
    }

    function hide() {
      listEl.style.display = 'none';
      selectedIdx = -1;
    }

    function select(item) {
      hide();
      const key = config.recentsKey || inputEl.id || '';
      if (key) {
        const cur = (recentPicks[key] || []).filter(x => x !== item);
        cur.unshift(item);
        recentPicks[key] = cur.slice(0, RECENTS_MAX);
      }
      config.onSelect(item);
    }

    function render(matches, headerHtml) {
      currentMatches = matches;
      listEl.innerHTML = (headerHtml || '') +
        matches.map(item => `<div class="autocomplete-item">${config.renderItem(item)}</div>`).join('');
      // Bind by .autocomplete-item, not children — a header row may sit first.
      listEl.querySelectorAll('.autocomplete-item').forEach((el, i) => {
        el.addEventListener('mousedown', () => select(matches[i]));
      });
      listEl.style.display = 'block';
    }

    // Focusing an empty picker offers this field's recent selections. Stale
    // records (deleted client, reloaded list) are filtered against the live
    // list by identity-or-id so a recent can never select a ghost row.
    function showRecents() {
      if ((inputEl.value || '').trim()) return;
      const key = config.recentsKey || inputEl.id || '';
      const rec = recentPicks[key];
      if (!rec || !rec.length) return;
      const list = config.getList();
      if (!Array.isArray(list) || !list.length) return;
      const live = rec
        .map(r => list.includes(r) ? r : list.find(x => r && x && x.id != null && x.id === r.id))
        .filter(Boolean).slice(0, RECENTS_MAX);
      if (!live.length) return;
      selectedIdx = -1;
      render(live, '<div class="autocomplete-recent-label">Recent</div>');
    }

    function search(rawVal) {
      selectedIdx = -1;
      const val = config.normalizeQuery ? config.normalizeQuery(rawVal) : rawVal;
      if (!val || val.length < (config.minChars || 1)) { hide(); return; }

      const list = config.getList();
      if (!Array.isArray(list) || !list.length) { hide(); return; }

      const matches = indexFor(list).search(val).slice(0, config.maxResults || 8)
        .map(r => config.normalizeItem ? r.item.__orig : r.item);

      if (!matches.length) { hide(); return; }
      render(matches);
    }

    function handleKey(e) {
      const items = listEl.querySelectorAll('.autocomplete-item');
      if (!items.length || listEl.style.display === 'none') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
      } else if (e.key === 'Enter' && selectedIdx >= 0) {
        e.preventDefault();
        select(currentMatches[selectedIdx]);
        return;
      } else if (e.key === 'Escape') {
        // Contain the Escape: with the list open it means "close this list",
        // and must not bubble to the global handler that closes the whole
        // drawer (js/core/keyboard.js).
        e.stopPropagation();
        hide();
        return;
      }
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
    }

    inputEl.addEventListener('input', () => search(inputEl.value));
    inputEl.addEventListener('focus', showRecents);
    inputEl.addEventListener('keydown', handleKey);
    document.addEventListener('click', (e) => {
      if (!inputEl.contains(e.target) && !listEl.contains(e.target)) hide();
    });

    return { search, hide };
  }

  return { buildIndex, attachAutocomplete };
})();
