// ════════════════════════════════════════════
//  DOCUMENT STORE
//  Save / browse / re-open for the HTML document builders — the Audit Report
//  Builder and Notes to Accounts today, any future builder for the cost of one
//  value in the `saved_documents.module` CHECK.
//
//  Every builder stores the same two things, which is why this is one engine
//  and one table rather than a per-module pair of each:
//
//    state     the form field values → a saved document can be re-opened,
//              EDITED and re-generated.
//    doc_html  the rendered document at the moment of saving. The preview is
//              contenteditable, so the state alone cannot reproduce a
//              hand-edited document; this is what makes "reprint exactly what
//              I sent the client" true rather than approximately true.
//
//  The picker is one shared drawer in index.html (`ds-` ids), rendered per
//  call — a module supplies its id, a label and what to do with a chosen row.
//  Registering per-module markup instead would put the same list, the same
//  empty state and the same delete confirm in every builder.
//
//  Nothing here caches: these are small, per-user, rarely-read lists, and a
//  stale list in a "find the report I lost" screen is the one thing it must
//  never show.
// ════════════════════════════════════════════
window.DocumentStore = (function () {
  const TABLE = 'saved_documents';

  // Only the columns the picker draws — doc_html is often tens of KB and the
  // list never renders it, so it is fetched on open, not on list.
  const LIST_COLS = 'id, module, client_id, client_name, pan, fiscal_year, doc_type, title, created_by, created_at, updated_at';

  // id === null inserts, otherwise updates that row (re-saving in the same
  // session amends the same document, matching pjSave()'s behaviour).
  async function save(id, payload) {
    const row = Object.assign({
      created_by: (window.currentUser && window.currentUser.email) || null,
    }, payload);
    const q = id
      ? window.sb.from(TABLE).update(row).eq('id', id).select('id').single()
      : window.sb.from(TABLE).insert(row).select('id').single();
    const { data, error } = await q;
    if (error) throw error;
    return data.id;
  }

  async function list(module, limit) {
    const { data, error } = await window.sb.from(TABLE)
      .select(LIST_COLS)
      .eq('module', module)
      .order('created_at', { ascending: false })
      .limit(limit || 200);
    if (error) throw error;
    return data || [];
  }

  async function get(id) {
    const { data, error } = await window.sb.from(TABLE).select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  }

  async function remove(id) {
    const { error } = await window.sb.from(TABLE).delete().eq('id', id);
    if (error) throw error;
  }

  // ── Shared picker drawer ──
  //
  // Two kinds of caller:
  //   · saved_documents modules pass `{ module, onOpen }` and get the default
  //     list/open/delete against this table.
  //   · a module whose records live elsewhere (Projection Report → the
  //     `projection_reports` table, a different shape entirely) passes
  //     `{ fetchRows, describe, onChoose, onDelete }`. The drawer, its markup
  //     and its CSS are shared either way — building a second drawer would
  //     duplicate the same list, empty state and delete confirm.
  let ctx = null;   // { module, label, onOpen } | { label, fetchRows, describe, onChoose, onDelete }
  let allRows = []; // the last fetch, unfiltered — search re-filters this, never re-fetches
  let query = '';

  function el(id) { return document.getElementById(id); }

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function openPicker(options) {
    ctx = options;
    query = '';
    const searchEl = el('ds-search');
    if (searchEl) {
      searchEl.value = '';
      // Search matches the whole rendered row, not just the client name, so a
      // caller whose rows carry more than that can say so. Default keeps the
      // wording every existing caller already had.
      searchEl.placeholder = options.searchPlaceholder || 'Search by client name…';
    }
    el('ds-drawer-title').textContent = options.label || 'Saved documents';
    el('ds-drawer').classList.add('open');
    await refresh();
  }

  function closePicker() {
    el('ds-drawer').classList.remove('open');
    ctx = null;
    allRows = [];
    query = '';
  }

  // What a row reads as in the list. The saved_documents shape is the default;
  // a caller with its own table supplies `describe`.
  function defaultDescribe(r) {
    return {
      title: r.title || r.client_name,
      meta: `${r.client_name || ''}${r.fiscal_year ? ' · F.Y. ' + r.fiscal_year : ''}`
          + ` · saved ${fmtWhen(r.updated_at || r.created_at)}`
          + (r.created_by ? ' · ' + r.created_by : ''),
    };
  }

  async function refresh() {
    if (!ctx) return;
    const host = el('ds-list');
    host.innerHTML = `<div class="log-empty">Loading…</div>`;
    try {
      allRows = ctx.fetchRows ? await ctx.fetchRows() : await list(ctx.module);
      renderList();
    } catch (e) {
      console.error(e);
      host.innerHTML = `<div class="log-empty">Could not load saved documents: ${escHtml(e.message)}</div>`;
    }
  }

  // Filters the already-fetched rows against `query` — search re-filters
  // in memory rather than re-fetching, so typing stays instant and the
  // Supabase side of a caller's `fetchRows` never needs to know search
  // exists. Matched against what the row actually RENDERS AS (title + meta)
  // rather than a hardcoded field name, since callers' row shapes differ
  // (saved_documents' client_name vs projection_reports' company_name) —
  // this is what lets one search box work for every caller with no changes
  // to any of them.
  function filterRows(rows) {
    const q = query.trim();
    if (!q) return rows;
    const describe = ctx.describe || defaultDescribe;
    const indexed = rows.map(r => {
      const d = describe(r) || {};
      return { _row: r, _text: `${d.title || ''} ${d.meta || ''}` };
    });
    // Plain substring FIRST, Fuse only as the fallback. Fuse is typo-tolerant,
    // which is right for a half-remembered company name and actively wrong for
    // a fiscal year: at threshold 0.3 with ignoreLocation, "2078" scores as a
    // match against "2082-83" and a four-digit year returns the whole list. An
    // exact substring is never a worse match than a fuzzy one, so when any row
    // literally contains what was typed, those rows ARE the answer.
    const needle = q.toLowerCase();
    const exact = indexed.filter(x => x._text.toLowerCase().includes(needle));
    if (exact.length) return exact.map(x => x._row);
    return SearchEngine.buildIndex(indexed, ['_text']).search(q).map(x => x.item._row);
  }

  function renderList() {
    const host = el('ds-list');
    if (!allRows.length) {
      host.innerHTML = `<div class="log-empty">${ctx.empty
        || 'Nothing saved yet. Use <strong>Save to database</strong> on a document and it will be listed here.'}</div>`;
      return;
    }
    const rows = filterRows(allRows);
    if (!rows.length) {
      host.innerHTML = `<div class="log-empty">No saved records match "${escHtml(query.trim())}".</div>`;
      return;
    }
    const describe = ctx.describe || defaultDescribe;
    // Row ids only in the inline handler — never free text (§10 rule 13).
    host.innerHTML = rows.map(r => {
      const d = describe(r) || {};
      return `
      <div class="ds-item">
        <div class="ds-item-main">
          <div class="ds-item-title">${escHtml(d.title || '')}</div>
          <div class="ds-item-meta">${escHtml(d.meta || '')}</div>
        </div>
        <div class="ds-item-actions">
          <button class="btn btn-primary btn-sm" onclick="DocumentStore.choose(${r.id})">Open</button>
          <button class="btn btn-danger btn-sm" onclick="DocumentStore.discard(${r.id})">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  function search(q) {
    query = q || '';
    renderList();
  }

  async function choose(id) {
    if (!ctx) return;
    // A caller owning its own table loads the record itself — only it knows
    // how to put that row back on screen.
    if (ctx.onChoose) { const h = ctx.onChoose; closePicker(); h(id); return; }
    if (!ctx.onOpen) return;
    const handler = ctx.onOpen;
    try {
      const row = await get(id);
      closePicker();
      handler(row);
    } catch (e) {
      console.error(e);
      alert('Could not open that document: ' + e.message);
    }
  }

  async function discard(id) {
    if (!confirm('Delete this saved record? This cannot be undone.')) return;
    try {
      if (ctx && ctx.onDelete) await ctx.onDelete(id);
      else await remove(id);
      await refresh();
    } catch (e) {
      console.error(e);
      alert('Could not delete: ' + e.message);
    }
  }

  return { save, list, get, remove, openPicker, closePicker, choose, discard, refresh, search };
})();
