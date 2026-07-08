// ════════════════════════════════════════════
//  TABLE ENGINE
//  Wraps Tabulator with this app's default look (see the .app-table
//  override block in css/styles.css, which maps Tabulator's own classes
//  onto the same header/row/cell styling client-table already used) so any
//  future large list gets virtualized rendering plus built-in sort/filter
//  without rediscovering the right Tabulator config from scratch.
// ════════════════════════════════════════════
window.TableEngine = (function () {
  function createTable(container, options) {
    container.classList.add('app-table');
    const table = new Tabulator(container, Object.assign({
      layout: 'fitColumns',
      placeholder: 'No data',
    }, options));

    // Tabulator builds its internal row/column managers asynchronously —
    // calling replaceData() before its own `tableBuilt` event fires throws
    // (RowManager isn't set up yet). Every module immediately re-filters
    // after creating a table (e.g. to apply an active stat-card filter), so
    // rather than making every call site await table readiness, queue the
    // data here and flush it once Tabulator is actually ready.
    let isBuilt = false;
    let pendingData = null;
    table.on('tableBuilt', () => {
      isBuilt = true;
      if (pendingData !== null) { table.replaceData(pendingData); pendingData = null; }
    });
    const nativeReplaceData = table.replaceData.bind(table);
    table.replaceData = (data) => {
      if (isBuilt) return nativeReplaceData(data);
      pendingData = data;
      return Promise.resolve();
    };

    return table;
  }

  return { createTable };
})();
