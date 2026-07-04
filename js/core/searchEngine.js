// ════════════════════════════════════════════
//  SEARCH ENGINE
//  Owns the filter-on-input, render-matches, arrow-key nav, Enter-to-select,
//  and outside-click-close behavior that clients.js, report.js (x2 fields),
//  and bmAgmMinutes.js each independently hand-rolled as near-identical
//  copies. Backed by Fuse.js instead of plain .includes() substring
//  matching, so search is typo-tolerant as a side effect of deduplicating.
// ════════════════════════════════════════════
window.SearchEngine = (function () {
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

    function hide() {
      listEl.style.display = 'none';
      selectedIdx = -1;
    }

    function select(item) {
      hide();
      config.onSelect(item);
    }

    function render(matches) {
      currentMatches = matches;
      listEl.innerHTML = matches.map(item => `<div class="autocomplete-item">${config.renderItem(item)}</div>`).join('');
      Array.from(listEl.children).forEach((el, i) => {
        el.addEventListener('mousedown', () => select(matches[i]));
      });
      listEl.style.display = 'block';
    }

    function search(rawVal) {
      selectedIdx = -1;
      const val = config.normalizeQuery ? config.normalizeQuery(rawVal) : rawVal;
      if (!val || val.length < (config.minChars || 1)) { hide(); return; }

      const list = config.getList();
      if (!Array.isArray(list) || !list.length) { hide(); return; }

      const indexList = config.normalizeItem
        ? list.map(item => Object.assign(config.normalizeItem(item), { __orig: item }))
        : list;
      const fuse = buildIndex(indexList, config.keys, config.fuseOptions);
      const matches = fuse.search(val).slice(0, config.maxResults || 8)
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
        hide();
        return;
      }
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIdx));
    }

    inputEl.addEventListener('input', () => search(inputEl.value));
    inputEl.addEventListener('keydown', handleKey);
    document.addEventListener('click', (e) => {
      if (!inputEl.contains(e.target) && !listEl.contains(e.target)) hide();
    });

    return { search, hide };
  }

  return { buildIndex, attachAutocomplete };
})();
