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
    return new Tabulator(container, Object.assign({
      layout: 'fitColumns',
      placeholder: 'No data',
    }, options));
  }

  return { createTable };
})();
