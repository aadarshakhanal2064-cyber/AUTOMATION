// ════════════════════════════════════════════
//  SUPABASE: LOAD CLIENTS
// ════════════════════════════════════════════
async function loadClients() {
  // sbFetchAll, not a bare .select() — PostgREST caps one select at 1000 rows
  // and this table is at 314 and growing (CLAUDE.md §6). A plain select would
  // silently truncate rather than error, which is the worst failure mode.
  let data;
  try {
    data = await sbFetchAll(() => window.sb.from('clients').select('*').order('name'));
  } catch (e) {
    console.error('Failed to load clients:', e.message);
    document.getElementById('clients-table-wrap').innerHTML =
      '<div class="log-empty" style="color:var(--red);">Failed to load clients. Check your Supabase table and RLS policies.</div>';
    return;
  }

  window.clientsList = data || [];
  window.clientShowAll = false;
  populateClientFilters(window.clientsList);
  renderNatureCategoryStrip(window.clientsList);
  applyClientFilters();
  renderClientStats(window.clientsList);
  cdLoadNonFilers(); // not awaited — its own panel shows a loading state and fills in independently
  cdLoadFileInOut(); // not awaited — the Docs column fills in independently once it resolves
}

// ── File In Out custody status (2026-08-09) ──
// Queried directly from document_register, not from fileManagement.js's
// in-memory fmEntries — that module may never have been opened this session,
// so its state can't be relied on (same reasoning as cdLoadNonFilers reading
// audit_report_finalization directly rather than reaching into that module).
// fmDeriveStatus/fmRemainingByType (js/fileManagement.js) are plain functions
// of a row, safe to call here regardless of the two files' <script> tag
// order — by the time this actually RUNS (post sign-in), every module script
// has already executed and defined its globals, same as finalAccount.js
// calling partyLedger.js's functions.
window.cdFioSummary = {};
async function cdLoadFileInOut() {
  try {
    const rows = await sbFetchAll(() => window.sb.from('document_register')
      .select('client_id, status, doc_types, outtakes').not('client_id', 'is', null));
    const map = {};
    (rows || []).forEach(r => {
      if (r.status === 'returned') return;
      if (!map[r.client_id]) map[r.client_id] = { pending: 0, partial: 0 };
      map[r.client_id][r.status] = (map[r.client_id][r.status] || 0) + 1;
    });
    window.cdFioSummary = map;
  } catch (e) {
    window.cdFioSummary = {};
    console.error('Failed to load File In Out summary for Clients:', e.message);
  }
  if (clientsTable) clientsTable.redraw(true); // reformat the Docs column now the map is populated
}

// Opens the shared Client Report modal (js/fileManagement.js) pre-loaded for
// this client — one implementation of "show me this client's File In Out
// history", reused by both tabs rather than duplicated.
function cdOpenClientFileInOut(client) {
  if (window.fmOpenClientReport) fmOpenClientReport(client);
}

// ════════════════════════════════════════════
//  CLIENT PORTFOLIO DASHBOARD
// ════════════════════════════════════════════
// Every figure is derived from window.clientsList on render — the directory is
// the single source, so the dashboard can never disagree with the table below
// it. Deliberately reports the WHOLE portfolio, not the filtered view: these
// are the firm's headline numbers, and having them move as you type in the
// search box would make them useless.

const CD_MAX_BARS = 6;   // longest tail worth drawing; the rest roll into "Other"
// Blanks are bucketed under one visible label rather than dropped: the 45
// Devanagari records and the 8 kept clients carry no district or IT return,
// and a chart that quietly omitted them would not add up to the client count.
const CD_BLANK = 'Not set';

function cdGroup(list, pick) {
  const counts = new Map();
  list.forEach(c => {
    const raw = pick(c);
    const key = (raw === null || raw === undefined || String(raw).trim() === '')
      ? CD_BLANK : String(raw).trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  // Blanks sort last regardless of size — they are an absence, not a category.
  return [...counts.entries()].sort((a, b) =>
    (a[0] === CD_BLANK) - (b[0] === CD_BLANK) || b[1] - a[1] || a[0].localeCompare(b[0]));
}

// kind: 'entity' | 'district' | 'nature' — drives what a bar click does
// (see the delegated listener near the bottom of this section). Omit for a
// non-clickable panel.
function cdRenderBars(elId, countId, groups, noun, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  // The blank bucket is not one of the categories, so it must not be counted
  // as one — "7 types" when six are real would be wrong.
  const real = groups.filter(([name]) => name !== CD_BLANK).length;
  const label = document.getElementById(countId);
  // Plain 's' pluralization doesn't fit "category" — pass the exact word for
  // the single case ("1 category") and let the simple form cover every noun
  // that IS just +s ("1 type", "1 district").
  const plural = real === 1 ? noun : (noun === 'category' ? 'categories' : noun + 's');
  if (label) label.textContent = `${real} ${plural}`;

  if (!groups.length) { el.innerHTML = '<div class="log-empty">No data yet.</div>'; return; }

  // "Not set" is held out of the ranking and always drawn as its own last bar.
  // Letting it fall into "Other" would bury the count of records still missing
  // the field, which is the one number this panel is most useful for.
  const blank = groups.find(([name]) => name === CD_BLANK);
  const ranked = groups.filter(([name]) => name !== CD_BLANK);
  const slots = CD_MAX_BARS - (blank ? 1 : 0);

  let shown = ranked;
  if (ranked.length > slots) {
    const rest = ranked.slice(slots - 1).reduce((s, g) => s + g[1], 0);
    shown = ranked.slice(0, slots - 1).concat([[`Other (${ranked.length - slots + 1})`, rest]]);
  }
  if (blank) shown = shown.concat([blank]);

  const top = Math.max(...shown.map(g => g[1]), 1);
  const total = groups.reduce((s, g) => s + g[1], 0) || 1;

  // A bar is clickable when it names a real, filterable value — not the
  // blank bucket and not the "Other (n)" rollup, which is nothing the filter
  // dropdowns can express. Values go through data-* attributes rather than an
  // inline onclick string (CLAUDE.md §11 rule 13) since a district or
  // category name is free text and could carry a quote.
  el.innerHTML = shown.map(([name, n]) => {
    const clickable = kind && name !== CD_BLANK && !/^Other \(/.test(name);
    const attrs = clickable ? ` class="cd-bar-row clickable" data-cd-kind="${kind}" data-cd-name="${escHtml(name)}" role="button" tabindex="0"` : ' class="cd-bar-row"';
    return `
    <div${attrs}>
      <div class="cd-bar-label" title="${escHtml(name)}">${escHtml(name)}</div>
      <div class="cd-bar-track"><div class="cd-bar-fill${name === CD_BLANK ? ' blank' : ''}" style="width:${(n / top * 100).toFixed(1)}%"></div></div>
      <div class="cd-bar-val">${n}<span class="cd-bar-pct">${Math.round(n / total * 100)}%</span></div>
    </div>`;
  }).join('');
}

// The fields other modules actually need before they can do their job. Kept
// as a module-level list (not built fresh inside the render function) so the
// click handler can look a field up by key without recomputing anything.
const CD_COMPLETENESS_FIELDS = [
  ['pan',                   'PAN',              c => c.pan],
  ['address',               'Address',          c => c.address],
  ['entity_type',           'Entity Type',      c => c.entity_type],
  ['district',              'District',         c => c.district],
  ['it_return_type',        'IT Return Type',   c => c.it_return_type],
  ['tax_registration_type', 'Tax Registration', c => c.tax_registration_type],
  ['email',                 'Email',            c => c.email],
  ['phone',                 'Phone',            c => c.phone],
];
function cdIsFilled(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }

function cdRenderCompleteness(list) {
  const el = document.getElementById('cd-completeness');
  if (!el) return;
  const total = list.length || 1;
  el.innerHTML = CD_COMPLETENESS_FIELDS.map(([key, label, pick]) => {
    const n = list.filter(c => cdIsFilled(pick(c))).length;
    const pct = Math.round(n / total * 100);
    const tone = pct >= 90 ? 'good' : pct >= 50 ? 'mid' : 'low';
    return `
      <div class="cd-meter-row clickable" data-cd-kind="completeness" data-cd-name="${key}" role="button" tabindex="0">
        <div class="cd-meter-label">${escHtml(label)}</div>
        <div class="cd-meter-track"><div class="cd-meter-fill ${tone}" style="width:${pct}%"></div></div>
        <div class="cd-meter-val">${pct}%</div>
      </div>`;
  }).join('');
}

function renderClientStats(list) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const isD3  = c => String(c.it_return_type || '') === 'D-03';
  // D1/D2 is one value, but a client narrowed to D-01 or D-02 still belongs
  // in this count — it is the same filing family.
  const isD12 = c => /^D(1\/D2|-01|-02)$/.test(String(c.it_return_type || ''));

  set('stat-total-clients', list.length);
  set('stat-d12', list.filter(isD12).length);
  set('stat-d3',  list.filter(isD3).length);

  const unset = list.filter(c => !c.it_return_type).length;
  set('stat-total-sub', unset ? `${unset} without an IT return type` : 'All classified');

  cdRenderBars('cd-entity-bars',   'cd-entity-count',   cdGroup(list, c => c.entity_type), 'type',     'entity');
  cdRenderBars('cd-district-bars', 'cd-district-count', cdGroup(list, c => c.district),    'district', 'district');
  cdRenderBars('cd-nature-bars',   'cd-nature-count',   cdGroup(list, c => nbCategorize(c.business_nature)), 'category', 'nature');
  cdRenderCompleteness(list);
}

// ════════════════════════════════════════════
//  NON-FILERS LIST — IT Return audit progress
// ════════════════════════════════════════════
// Sourced from audit_report_finalization (Audit Report Finalization module,
// docs/modules/audit-report-finalization.md), it_return track only. Reads
// that table directly rather than depending on any of its JS — clients.js
// loads BEFORE auditReportFinalization.js (index.html script order), and
// this only needs the raw columns, not arfStatusKey()'s full 4-key
// derivation (tax-clearance labels etc. don't apply to the IT track).
//
// UI is a small widget top-right of the page header (button styled as a
// card) showing just the three counts, plus a modal (#cd-nf-modal) for the
// full unpaginated list and Print/PDF/Excel export — kept out of the cd-grid
// dashboard entirely so it doesn't compete for space with the breakdown
// panels below it.
// Derived from window.FY_DEFAULT_START (config.js), same slash format as
// ARF_FY_DEFAULT in auditReportFinalization.js. Computed inline rather than
// read from that module's constant because clients.js loads BEFORE
// auditReportFinalization.js (§2 script order) — ARF_FY_DEFAULT doesn't
// exist yet at this point in the boot sequence.
const CD_NF_FY = window.FY_DEFAULT_START + '/' + String((window.FY_DEFAULT_START + 1) % 100).padStart(2, '0');
window.cdNonFilerRecords = new Map(); // client_id -> that client's it_return row for CD_NF_FY, if any
window.cdNfGroups = { notVerified: [], pending: [] }; // filled by cdRenderNonFilers, read by the modal + export

async function cdLoadNonFilers() {
  [document.getElementById('cd-nf-fy'), document.getElementById('cd-nf-modal-fy')]
    .forEach(el => { if (el) el.textContent = CD_NF_FY; });
  try {
    const rows = await sbFetchAll(() => window.sb.from('audit_report_finalization')
      .select('client_id, it_submission_no, it_entered_by, it_checked_by, it_verified, it_return_type')
      .eq('return_type', 'it_return').eq('fiscal_year', CD_NF_FY).order('client_id'));
    window.cdNonFilerRecords = new Map((rows || []).map(r => [r.client_id, r]));
  } catch (e) {
    window.cdNonFilerRecords = new Map();
    console.error('Failed to load audit finalization records for Non-Filers List:', e.message);
  }
  cdRenderNonFilers(window.clientsList || []);
}

// Mirrors just the it_return slice of arfStatusKey() (auditReportFinalization.js)
// — a record that's never been created is 'no_record' (arfStatusKey would call
// this 'not_submitted' since it always has a row to read; here "no row at all"
// is itself informative, so it gets its own key).
function cdNfStatus(arfRow) {
  if (!arfRow) return 'no_record';
  if (arfRow.it_verified === false) return 'not_verified';
  if (arfRow.it_verified === true) return 'verified';
  return ((arfRow.it_submission_no || '').trim() || (arfRow.it_entered_by || '').trim()) ? 'submitted' : 'no_record';
}

const CD_NF_STATUS_META = {
  not_verified: ['badge-error',   '❌ Not Verified'],
  submitted:    ['badge-amber',   '📤 Submitted'],
  no_record:    ['badge-neutral', '⬜ Not Submitted'],
  verified:     ['badge-sent',    '✅ Verified'],
};

// Only updates counts (widget + modal header) and recomputes the two groups
// — never touches the modal's tables, which are built lazily on open (see
// cdOpenNonFilerModal) since a Tabulator sized against a display:none
// container measures zero width.
function cdRenderNonFilers(list) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const withStatus = list.map(c => {
    const arf = window.cdNonFilerRecords.get(c.id);
    return { client: c, arf, status: cdNfStatus(arf) };
  });

  const verifiedCount = withStatus.filter(x => x.status === 'verified').length;
  ['cd-nf-total', 'cd-nf-modal-total'].forEach(id => set(id, list.length));
  ['cd-nf-verified', 'cd-nf-modal-verified'].forEach(id => set(id, verifiedCount));
  ['cd-nf-notverified', 'cd-nf-modal-notverified'].forEach(id => set(id, list.length - verifiedCount));

  // "Not Verified" is kept apart from "Not Yet Filed / Pending" on purpose —
  // a return the firm checked and flagged is a different problem (needs
  // follow-up with the client) from one nobody has started yet.
  window.cdNfGroups = {
    notVerified: withStatus.filter(x => x.status === 'not_verified'),
    pending:     withStatus.filter(x => x.status === 'submitted' || x.status === 'no_record'),
  };

  set('cd-nf-notverified-count', window.cdNfGroups.notVerified.length);
  set('cd-nf-pending-count', window.cdNfGroups.pending.length);

  // If the modal happens to already be open (e.g. an admin reloads clients
  // from another tab action while it's up), keep its tables in sync too.
  if (document.getElementById('cd-nf-modal').classList.contains('open')) cdRenderNfTables();
}

let cdNfTables = { notVerified: null, pending: null };
function cdRenderNfTable(elId, rows, key, emptyMsg) {
  const wrap = document.getElementById(elId);
  if (!wrap) return;
  if (cdNfTables[key]) { cdNfTables[key].destroy(); cdNfTables[key] = null; }

  if (!rows.length) {
    wrap.innerHTML = `<div class="log-empty">${escHtml(emptyMsg)}</div>`;
    return;
  }

  wrap.innerHTML = '';
  cdNfTables[key] = TableEngine.createTable(wrap, {
    data: rows,
    // No pagination here — this view exists specifically so staff can see
    // the WHOLE list at once; the modal itself scrolls.
    columns: [
      { title: 'Client Name', field: 'client.name', minWidth: 190, formatter: cell => {
          const c = cell.getRow().getData().client;
          return `<div class="client-name-row"><div class="client-avatar">${escHtml(clientInitials(c.name))}</div><div class="client-name-cell">${escHtml(c.name)}</div></div>`;
        } },
      { title: 'PAN', field: 'client.pan', minWidth: 100, formatter: cell => escHtml(cell.getRow().getData().client.pan || '—') },
      { title: 'Entity Type', field: 'client.entity_type', minWidth: 140, formatter: cell => escHtml(cell.getRow().getData().client.entity_type || '—') },
      { title: 'District', field: 'client.district', minWidth: 100, formatter: cell => escHtml(cell.getRow().getData().client.district || '—') },
      { title: 'IT Return Type', field: 'client.it_return_type', minWidth: 110, formatter: cell => escHtml(cell.getRow().getData().client.it_return_type || '—') },
      { title: 'Status', field: 'status', minWidth: 140, formatter: cell => {
          const meta = CD_NF_STATUS_META[cell.getValue()] || CD_NF_STATUS_META.no_record;
          return `<span class="log-badge ${meta[0]}">${meta[1]}</span>`;
        } },
      { title: 'Submission No.', field: 'arf.it_submission_no', minWidth: 120, formatter: cell => {
          const arf = cell.getRow().getData().arf;
          return escHtml((arf && arf.it_submission_no) || '—');
        } },
    ],
  });
}

function cdRenderNfTables() {
  cdRenderNfTable('cd-nf-notverified-table', window.cdNfGroups.notVerified, 'notVerified',
    'No IT returns are currently flagged Not Verified.');
  cdRenderNfTable('cd-nf-pending-table', window.cdNfGroups.pending, 'pending',
    'Every client has an IT return on file for this fiscal year.');
}

function cdOpenNonFilerModal() {
  cdRenderNfTables();
  document.getElementById('cd-nf-modal').classList.add('open');
}
function cdCloseNonFilerModal() {
  document.getElementById('cd-nf-modal').classList.remove('open');
}

// ── Print / Export (ReportExport engine, §4 — same shape as
//    arfBuildModel/arfExport in auditReportFinalization.js) ──
function cdNfBuildModel() {
  const rowOf = x => ({ cells: [
    x.client.name, x.client.pan, x.client.entity_type, x.client.district,
    x.client.it_return_type, CD_NF_STATUS_META[x.status][1].replace(/^\S+\s/, ''),
    (x.arf && x.arf.it_submission_no) || null,
  ] });
  const rows = [
    { cells: [`Not Verified (${window.cdNfGroups.notVerified.length})`], style: 'section' },
    ...window.cdNfGroups.notVerified.map(rowOf),
    { cells: [`Not Yet Filed / Pending Review (${window.cdNfGroups.pending.length})`], style: 'section' },
    ...window.cdNfGroups.pending.map(rowOf),
  ];
  return {
    title: 'Non-Filers List — IT Return',
    subtitleLines: [`Fiscal Year ${CD_NF_FY}`, `Generated ${new Date().toISOString().slice(0, 10)}`],
    landscape: true,
    columns: [
      { label: 'Client Name', w: 1.8 }, { label: 'PAN', w: 1 }, { label: 'Entity Type', w: 1.4 },
      { label: 'District', w: 1 }, { label: 'IT Return Type', w: 1 }, { label: 'Status', w: 1 },
      { label: 'Submission No.', w: 1.2 },
    ],
    rows,
    _filename: `Non-Filers List - IT Return - FY ${CD_NF_FY}`.replace(/\//g, '-'),
  };
}

function cdNfPrint() {
  const model = cdNfBuildModel();
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print.'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${escHtml(model.title)}</title>
    <style>body{font-family:Inter,Arial,sans-serif;margin:28px;color:#1a202c;}
    table{border-collapse:collapse;width:100%;font-size:11px;}
    th,td{border:1px solid #d9dce5;padding:5px 8px;}
    th{background:#f3f5fb;color:#0b1f3d;}
    @page{size:A4 landscape;margin:12mm;}</style></head>
    <body>${ReportExport.toHtml(model)}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
  AuditLog.record('clients_nonfilers_printed', { module: 'clients' });
}

async function cdNfExport(kind) {
  const model = cdNfBuildModel();
  if (!window.cdNfGroups.notVerified.length && !window.cdNfGroups.pending.length) {
    alert('Nothing to export — every client is IT Verified for this fiscal year.');
    return;
  }
  try {
    const ext = kind === 'pdf' ? 'pdf' : 'xlsx';
    await ReportExport.download(model, kind, `${model._filename}.${ext}`, {
      module: 'clients', clientName: 'Non-Filers List', sheetName: 'Non-Filers',
    });
  } catch (e) {
    alert('Failed to export: ' + (e.message || String(e)));
  }
}

// ════════════════════════════════════════════
//  NATURE OF BUSINESS — categories + drill-down
// ════════════════════════════════════════════
// The raw business_nature column has ~70 distinct spellings for the same 261
// clients. NATURE_CATEGORY_RULES (config.js) groups them into parent sectors
// derived from the actual data; NATURE_CANON_RULES merges spelling variants
// for DISPLAY only inside the drill-down — the stored value is never rewritten.
function nbCategorize(nature) {
  const s = (nature || '').trim();
  if (!s) return CD_BLANK;
  for (const [name, re] of (window.NATURE_CATEGORY_RULES || [])) if (re.test(s)) return name;
  return 'Other';
}
function nbCanon(nature) {
  const s = (nature || '').trim();
  if (!s) return '(blank)';
  for (const [re, name] of (window.NATURE_CANON_RULES || [])) if (re.test(s)) return name;
  return s;
}

// Filter pill strip below the search bar — a second entry point onto the same
// category filter the dashboard bar uses. Counts are always whole-portfolio
// (like the dropdowns), so the strip doesn't shrink as you narrow the search.
function renderNatureCategoryStrip(list) {
  const el = document.getElementById('nb-category-strip');
  if (!el) return;
  const groups = cdGroup(list, c => nbCategorize(c.business_nature));
  const active = window.nbActiveCategory || '';
  const pills = groups.map(([name, n]) => {
    const isActive = name === active;
    return `<button type="button" class="nb-pill${isActive ? ' active' : ''}" data-nb-pill="${escHtml(name)}">
      ${escHtml(name)}<span class="nb-pill-count">${n}</span>
    </button>`;
  }).join('');
  el.innerHTML = pills + (active
    ? `<button type="button" class="nb-pill nb-pill-clear" data-nb-pill="">✕ Clear filter</button>`
    : '');
}

function nbFilterByCategory(name) {
  window.clientShowAll = false;
  window.nbActiveCategory = (window.nbActiveCategory === name) ? '' : name;
  renderNatureCategoryStrip(window.clientsList || []);
  applyClientFilters();
}

// Clicking a category bar/pill drills into its sub-types before committing to
// the table filter — "Trading" alone doesn't say whether that means grocery,
// hardware, or petroleum.
function nbOpenCategoryDrilldown(name) {
  const list = window.clientsList || [];
  const clients = list.filter(c => nbCategorize(c.business_nature) === name);
  const subs = new Map();
  clients.forEach(c => { const s = nbCanon(c.business_nature); subs.set(s, (subs.get(s) || 0) + 1); });
  const rows = [...subs.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `
    <div class="cd-modal-row"><span>${escHtml(s)}</span><span class="cd-modal-count">${n}</span></div>
  `).join('') || '<div class="log-empty">No clients in this category.</div>';

  const safe = String(name).replace(/'/g, "\\'");
  cdOpenModal(name, `
    <p class="cd-modal-sub">${clients.length} client${clients.length === 1 ? '' : 's'} in <strong>${escHtml(name)}</strong>, by sub-type</p>
    <div class="cd-modal-list">${rows}</div>
    <button class="btn btn-primary cd-modal-action" onclick="cdCloseModal(); nbFilterByCategory('${safe}');">
      View these ${clients.length} clients in the table
    </button>
  `);
}

// ── Dashboard drill-down modal — shared by Nature of Business, and used
//    directly (no drill-down step) by the completeness meters. ──
function cdOpenModal(title, bodyHtml) {
  document.getElementById('cd-modal-title').textContent = title;
  document.getElementById('cd-modal-body').innerHTML = bodyHtml;
  document.getElementById('cd-modal').classList.add('open');
}
function cdCloseModal() {
  document.getElementById('cd-modal').classList.remove('open');
}

function cdFilterByEntity(name) {
  window.clientShowAll = false;
  const el = document.getElementById('client-filter-entity');
  if (el) el.value = name;
  applyClientFilters();
  document.getElementById('clients-table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cdFilterByDistrict(name) {
  window.clientShowAll = false;
  const el = document.getElementById('client-filter-district');
  if (el) el.value = name;
  applyClientFilters();
  document.getElementById('clients-table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cdOpenIncompleteModal(fieldKey) {
  const entry = CD_COMPLETENESS_FIELDS.find(f => f[0] === fieldKey);
  if (!entry) return;
  const [, label, pick] = entry;
  const missing = (window.clientsList || []).filter(c => !cdIsFilled(pick(c)));
  const SHOW = 200;
  const rows = missing.slice(0, SHOW).map(c => `
    <div class="cd-modal-row"><span>${escHtml(c.name)}</span><span class="cd-modal-count">${escHtml(c.entity_type || '—')}</span></div>
  `).join('') || '<div class="log-empty">Every client has this field filled in.</div>';
  const more = missing.length > SHOW ? `<p class="cd-modal-sub">…and ${missing.length - SHOW} more.</p>` : '';
  cdOpenModal(`Missing ${label} (${missing.length})`, `<div class="cd-modal-list">${rows}</div>${more}`);
}

// One delegated listener for every clickable dashboard element — bars,
// meters, and the category pill strip all read their target out of data-*
// attributes rather than a name baked into an inline onclick string.
document.addEventListener('click', e => {
  const pill = e.target.closest('[data-nb-pill]');
  if (pill) { nbFilterByCategory(pill.dataset.nbPill); return; }

  const row = e.target.closest('[data-cd-kind]');
  if (!row) return;
  const kind = row.dataset.cdKind, name = row.dataset.cdName;
  if (kind === 'entity') cdFilterByEntity(name);
  else if (kind === 'district') cdFilterByDistrict(name);
  else if (kind === 'nature') nbOpenCategoryDrilldown(name);
  else if (kind === 'completeness') cdOpenIncompleteModal(name);
});

// ── Filters ──────────────────────────────────
// The search box and the three dropdowns are one predicate, so they compose
// instead of each overwriting the other's result.
function populateClientFilters(list) {
  const fill = (id, groups) => {
    const el = document.getElementById(id);
    if (!el) return;
    const keep = el.value;
    const first = el.options[0];
    el.innerHTML = '';
    el.appendChild(first);
    groups.filter(([name]) => name !== CD_BLANK).forEach(([name, n]) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = `${name} (${n})`;
      el.appendChild(o);
    });
    el.value = keep;                       // survive a reload mid-filter
    if (el.value !== keep) el.value = '';  // unless that option is now gone
  };
  fill('client-filter-entity',   cdGroup(list, c => c.entity_type));
  fill('client-filter-district', cdGroup(list, c => c.district));

  const dl = document.getElementById('ac-district-list');
  if (dl) {
    dl.innerHTML = cdGroup(list, c => c.district)
      .filter(([name]) => name !== CD_BLANK)
      .map(([name]) => `<option value="${escHtml(name)}"></option>`).join('');
  }
  const bl = document.getElementById('ac-business-list');
  if (bl) {
    const seen = new Set();
    bl.innerHTML = list.map(c => nbCanon(c.business_nature)).filter(v => v !== '(blank)')
      .filter(v => (seen.has(v) ? false : (seen.add(v), true))).sort()
      .map(v => `<option value="${escHtml(v)}"></option>`).join('');
  }
}

// Wired to the search box and the three filter dropdowns in index.html
// instead of applyClientFilters directly, so any deliberate filter change
// collapses the table back to the summary page — "Show All" only stays
// expanded for a filter set the user hasn't just changed.
function clientFiltersChanged() {
  window.clientShowAll = false;
  applyClientFilters();
}

// The dropdowns above call clientFiltersChanged() directly — one click, one
// rebuild, and it should feel instant. Typing is different: applyClientFilters()
// destroys and rebuilds the whole Tabulator (deliberately, see renderClientsTable),
// so firing it per keystroke made the search bar drop characters on a fast typist.
// 180ms is below the threshold where the delay reads as lag, and it collapses a
// burst of keystrokes into one rebuild.
let clientSearchTimer = null;
function clientSearchChanged() {
  clearTimeout(clientSearchTimer);
  clientSearchTimer = setTimeout(clientFiltersChanged, 180);
}

function applyClientFilters() {
  const val = id => (document.getElementById(id) || {}).value || '';
  const q        = val('client-search-bar').trim().toLowerCase();
  const entity   = val('client-filter-entity');
  const district = val('client-filter-district');
  const itType   = val('client-filter-it');
  const category = window.nbActiveCategory || '';

  const filtered = (window.clientsList || []).filter(c => {
    if (entity   && (c.entity_type || '') !== entity)   return false;
    if (district && (c.district || '')    !== district) return false;
    if (itType === '__none') { if (c.it_return_type) return false; }
    else if (itType && (c.it_return_type || '') !== itType) return false;
    if (category && nbCategorize(c.business_nature) !== category) return false;
    if (!q) return true;
    return [c.name, c.email, c.pan, c.registration_number, c.entity_type,
            c.district, c.business_nature, c.it_return_type, c.tax_registration_type]
      .some(v => (v || '').toLowerCase().includes(q));
  });

  renderClientsTable(filtered);
  const el = document.getElementById('client-filter-summary');
  if (el) {
    const n = filtered.length, total = (window.clientsList || []).length;
    el.textContent = n === total ? `${total} clients` : `${n} of ${total} clients`;
  }
}

function clientInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// Tabulator instance for the clients directory — rebuilt from scratch on
// every render (matching the previous wipe-and-rebuild-innerHTML behavior),
// so the client list is never in an ambiguous partially-updated state
// (e.g. after a role change affects whether the Actions column shows).
let clientsTable = null;

// The directory doesn't load or scroll all 314+ clients by default — a
// filtered/searched result under this size shows in full anyway, so the cap
// only bites on the unfiltered "all clients" view.
const CLIENTS_PAGE_SIZE = 25;
window.clientShowAll = false;

function clientsShowAllToggle(showAll) {
  window.clientShowAll = showAll;
  applyClientFilters();
  if (!showAll) document.getElementById('clients-table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderClientsTable(list) {
  const wrap = document.getElementById('clients-table-wrap');
  const moreWrap = document.getElementById('clients-showall-wrap');
  if (clientsTable) { clientsTable.destroy(); clientsTable = null; }

  if (!list.length) {
    wrap.innerHTML = '<div class="log-empty">No clients match your search and filters.</div>';
    if (moreWrap) moreWrap.innerHTML = '';
    return;
  }

  const showAll = window.clientShowAll || list.length <= CLIENTS_PAGE_SIZE;
  const visible = showAll ? list : list.slice(0, CLIENTS_PAGE_SIZE);

  const isAdmin = window.currentUser?.role === 'admin';
  wrap.innerHTML = '';
  clientsTable = TableEngine.createTable(wrap, {
    data: visible,
    columns: [
      { title: 'Client Name', field: 'name', minWidth: 200, formatter: cell => {
          const c = cell.getRow().getData();
          return `<div class="client-name-row"><div class="client-avatar">${escHtml(clientInitials(c.name))}</div><div class="client-name-cell">${escHtml(c.name)}</div></div>`;
        } },
      { title: 'Entity Type', field: 'entity_type', minWidth: 140, formatter: cell => {
          const v = cell.getValue();
          return v ? `<span class="entity-badge">${escHtml(v)}</span>` : '—';
        } },
      { title: 'PAN', field: 'pan', minWidth: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'District', field: 'district', minWidth: 110, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Tax Reg.', field: 'tax_registration_type', minWidth: 95, formatter: cell => {
          const v = cell.getValue();
          return v ? `<span class="log-badge ${v === 'VAT' ? 'badge-sent' : 'badge-blue'}">${escHtml(v)}</span>` : '<span style="color:var(--text-faint);">—</span>';
        } },
      { title: 'IT Return', field: 'it_return_type', minWidth: 110, formatter: cell => {
          const v = cell.getValue();
          if (!v) return '<span style="color:var(--text-faint);">—</span>';
          return `<span class="log-badge ${v === 'D-03' ? 'badge-yellow' : 'badge-sent'}">${escHtml(v)}</span>`;
        } },
      { title: 'Email', field: 'email', minWidth: 170, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Phone', field: 'phone', minWidth: 130, formatter: cell => escHtml(cell.getValue() || '—') },
      { title: 'Docs', field: 'id', headerSort: false, minWidth: 110, formatter: cell => {
          const c = cell.getRow().getData();
          const s = window.cdFioSummary[c.id];
          const n = s ? (s.pending || 0) + (s.partial || 0) : 0;
          if (!n) return '<span style="color:var(--text-faint); font-size:12px;">—</span>';
          return `<span class="log-badge badge-amber" style="cursor:pointer;" title="View this client's File In Out history">📥 ${n} with us</span>`;
        }, cellClick: (e, cell) => cdOpenClientFileInOut(cell.getRow().getData()) },
      ...(isAdmin ? [{
        title: 'Actions', field: 'id', headerSort: false, minWidth: 150,
        formatter: () => `<div class="client-actions"><button class="btn btn-outline btn-sm" data-action="edit">Edit</button><button class="btn btn-danger btn-sm" data-action="delete">Delete</button></div>`,
        cellClick: (e, cell) => {
          const action = e.target.closest('[data-action]') && e.target.closest('[data-action]').dataset.action;
          const c = cell.getRow().getData();
          if (action === 'edit') editClient(c.id);
          else if (action === 'delete') deleteClient(c.id);
        },
      }] : []),
    ],
  });

  if (moreWrap) {
    moreWrap.innerHTML = !showAll
      ? `<button class="btn btn-outline" onclick="clientsShowAllToggle(true)">Show All ${list.length} Clients</button>
         <span class="clients-showall-hint">Showing ${visible.length} of ${list.length}</span>`
      : (list.length > CLIENTS_PAGE_SIZE
          ? `<button class="btn btn-outline" onclick="clientsShowAllToggle(false)">Show Less</button>`
          : '');
  }
}

// Superseded by applyClientFilters(), which folds the search box and the three
// dropdowns into one predicate. Kept as a thin alias because it was the public
// name for this behaviour.
function filterClientTable() { applyClientFilters(); }

// ════════════════════════════════════════════
//  SUPABASE: ADD / EDIT / DELETE CLIENTS
// ════════════════════════════════════════════
function toggleAddClient() {
  const form = document.getElementById('add-client-form');
  form.classList.toggle('open');
  if (form.classList.contains('open') && !window.editingClientId) {
    clearClientForm();
    document.getElementById('add-client-title').textContent = 'Add New Client';
  }
}

function cancelAddClient() {
  window.editingClientId = null;
  clearClientForm();
  document.getElementById('add-client-form').classList.remove('open');
}

// Populates #ac-entity-type from CLIENT_ENTITY_TYPES. When editing a client
// whose stored value isn't one of the eight (the 7 Partnership Firms, or a
// legacy import spelling), that value is injected as an extra option so
// opening the record for edit can never silently rewrite its entity type —
// only an explicit re-selection changes it.
function acFillEntityTypes(currentValue) {
  const el = document.getElementById('ac-entity-type');
  if (!el) return;
  const base = window.CLIENT_ENTITY_TYPES || [];
  const extra = currentValue && !base.includes(currentValue) ? [currentValue] : [];
  el.innerHTML = '<option value="">— Select —</option>'
    + base.map(v => `<option${v === currentValue ? ' selected' : ''}>${escHtml(v)}</option>`).join('')
    + extra.map(v => `<option selected>${escHtml(v)}</option>`).join('');
}
acFillEntityTypes(); // populate on script load so Add Client has options before anything is edited

function clearClientForm() {
  ['ac-name','ac-email','ac-pan','ac-phone','ac-business','ac-address','ac-district','ac-it-return-type','ac-tax-type-d3','ac-tax-registration-type']
    .forEach(id => document.getElementById(id).value = '');
  acFillEntityTypes();
  // Every client on file is Nepal-based; typing it 300 times is not a feature.
  document.getElementById('ac-country').value = 'Nepal';
  document.getElementById('client-form-status').innerHTML = '';
}

async function saveClient() {
  const name  = document.getElementById('ac-name').value.trim();
  const email = document.getElementById('ac-email').value.trim();
  if (!name) {
    document.getElementById('client-form-status').innerHTML =
      '<div class="status-box status-info" style="margin-top:0;">Client Name is required.</div>';
    return;
  }

  // Registration number, chairman, shareholder, the three capitals and VAT
  // status are NOT in this payload — they moved to Company Registrar →
  // Company Profile (js/companyProfile.js) and are edited there. Omitting the
  // keys leaves them untouched in the database; this form must never send
  // them as null.
  const payload = {
    name,
    email:         email || null,
    pan:           document.getElementById('ac-pan').value.trim() || null,
    phone:         document.getElementById('ac-phone').value.trim() || null,
    entity_type:   document.getElementById('ac-entity-type').value.trim() || null,
    business_nature: document.getElementById('ac-business').value.trim() || null,
    address:       document.getElementById('ac-address').value.trim() || null,
    district:      document.getElementById('ac-district').value.trim() || null,
    country:       document.getElementById('ac-country').value.trim() || null,
    it_return_type: document.getElementById('ac-it-return-type').value.trim() || null,
    tax_type_d3:   document.getElementById('ac-tax-type-d3').value.trim() || null,
    tax_registration_type: document.getElementById('ac-tax-registration-type').value.trim() || null,
  };

  let error;
  if (window.editingClientId) {
    ({ error } = await window.sb.from('clients').update(payload).eq('id', window.editingClientId));
  } else {
    // A brand-new client has no VAT status yet; the column is NOT NULL with
    // a default, but an explicit insert value keeps intent obvious here.
    payload.vat_status = 'not_registered';
    ({ error } = await window.sb.from('clients').insert(payload));
  }

  if (error) {
    document.getElementById('client-form-status').innerHTML =
      `<div class="status-box status-error" style="margin-top:0;">❌ ${escHtml(error.message)}</div>`;
    return;
  }

  cancelAddClient();
  await loadClients();
}

function editClient(id) {
  const c = window.clientsList.find(x => x.id == id);
  if (!c) return;
  window.editingClientId = id;
  document.getElementById('ac-name').value        = c.name || '';
  document.getElementById('ac-email').value       = c.email || '';
  document.getElementById('ac-pan').value         = c.pan || '';
  document.getElementById('ac-phone').value       = c.phone || '';
  acFillEntityTypes(c.entity_type || '');
  document.getElementById('ac-business').value    = c.business_nature || '';
  document.getElementById('ac-address').value     = c.address || '';
  document.getElementById('ac-district').value    = c.district || '';
  document.getElementById('ac-country').value     = c.country || 'Nepal';
  document.getElementById('ac-it-return-type').value = c.it_return_type || '';
  document.getElementById('ac-tax-type-d3').value = c.tax_type_d3 || '';
  document.getElementById('ac-tax-registration-type').value = c.tax_registration_type || '';
  document.getElementById('add-client-title').textContent = 'Edit Client';
  document.getElementById('add-client-form').classList.add('open');
  document.getElementById('add-client-form').scrollIntoView({ behavior: 'smooth' });
}

async function deleteClient(id) {
  const c = window.clientsList.find(x => String(x.id) === String(id));
  const name = c ? c.name : '';
  if (!confirm(`Delete client "${name}"? This cannot be undone.`)) return;
  const { error } = await window.sb.from('clients').delete().eq('id', id);
  if (error) { alert('Failed to delete: ' + error.message); return; }
  await loadClients();
}

// ════════════════════════════════════════════
//  IMPORT CLIENTS FROM EXCEL
// ════════════════════════════════════════════

function openImportModal() {
  window.importHeaders = []; 
  window.importDataRows = []; 
  window.importFieldMap = {}; 
  window.importPreviewRows = [];
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-status').innerHTML = '';
  document.getElementById('import-result-status').innerHTML = '';
  showImportStep(1);
  document.getElementById('import-modal').classList.add('open');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('open');
}

function showImportStep(n) {
  [1,2,3].forEach(i => document.getElementById('import-step-' + i).classList.toggle('active', i === n));
}

function handleImportFile(file) {
  if (!file) return;
  document.getElementById('import-file-status').innerHTML =
    '<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Reading file…</div>';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: '' });
      if (!rows.length) throw new Error('The file appears to be empty.');

      window.importHeaders  = rows[0].map(h => String(h || '').trim());
      window.importDataRows = rows.slice(1).filter(r => r.some(cell => String(cell || '').trim() !== ''));

      if (!window.importDataRows.length) throw new Error('No data rows found below the header row.');

      document.getElementById('import-file-status').innerHTML =
        `<div class="status-box status-success">✅ Loaded <strong>${window.importDataRows.length}</strong> rows from <strong>${escHtml(file.name)}</strong></div>`;

      autoMapColumns();
      renderColumnMapping();
      showImportStep(2);
    } catch (err) {
      document.getElementById('import-file-status').innerHTML =
        `<div class="status-box status-error">❌ Could not read file: ${escHtml(err.message)}</div>`;
    }
  };
  reader.onerror = () => {
    document.getElementById('import-file-status').innerHTML =
      '<div class="status-box status-error">❌ Failed to read the file.</div>';
  };
  reader.readAsBinaryString(file);
}

function autoMapColumns() {
  window.importFieldMap = {};
  const lowerHeaders = window.importHeaders.map(h => h.toLowerCase());
  window.IMPORT_FIELDS.forEach(f => {
    let bestIdx = -1;
    for (const kw of f.keywords) {
      const idx = lowerHeaders.findIndex(h => h === kw);
      if (idx !== -1) { bestIdx = idx; break; }
    }
    if (bestIdx === -1) {
      for (const kw of f.keywords) {
        const idx = lowerHeaders.findIndex(h => h.includes(kw));
        if (idx !== -1) { bestIdx = idx; break; }
      }
    }
    window.importFieldMap[f.key] = bestIdx;
  });
}

function renderColumnMapping() {
  const wrap = document.getElementById('import-map-rows');
  wrap.innerHTML = window.IMPORT_FIELDS.map(f => `
    <div class="import-map-row">
      <div class="col-label">${f.label}</div>
      <select id="import-map-${f.key}" onchange="window.importFieldMap['${f.key}'] = parseInt(this.value)">
        <option value="-1">— Not in file / Skip —</option>
        ${window.importHeaders.map((h, i) => `<option value="${i}" ${window.importFieldMap[f.key] === i ? 'selected' : ''}>${escHtml(h || '(column ' + (i+1) + ')')}</option>`).join('')}
      </select>
    </div>
  `).join('');
}

function buildImportPreview() {
  const nameIdx = window.importFieldMap['name'];
  if (nameIdx === -1 || nameIdx === undefined) {
    alert('Please map a column to "Client Name" before continuing — it\'s required.');
    return;
  }

  const existingByName = new Map(window.clientsList.map(c => [(c.name || '').trim().toLowerCase(), c]));
  const seenInFile = new Set();
  const BACKFILLABLE_FIELDS = window.IMPORT_FIELDS.map(f => f.key).filter(k => k !== 'name');

  window.importPreviewRows = [];
  let currentMainRow = null; // reference to the most recent valid/dupe row, for attaching extra shareholders

  window.importDataRows.forEach(row => {
    const rec = {};
    window.IMPORT_FIELDS.forEach(f => {
      const idx = window.importFieldMap[f.key];
      rec[f.key] = (idx !== undefined && idx !== -1) ? String(row[idx] || '').trim() : '';
    });

    // A nameless row that follows a company row and carries a shareholder-column
    // value is treated as an additional shareholder for that company, not a
    // separate (broken) client record — this is the actual shape of company
    // spreadsheets that list every shareholder, one per row, under one company.
    if (!rec.name && currentMainRow && rec.shareholder_name) {
      currentMainRow.extraShareholders.push(rec.shareholder_name);
      window.importPreviewRows.push({ ...rec, status: 'extra-shareholder' });
      return;
    }

    let status = 'valid';
    let existingClient = null;
    let fieldsToBackfill = {};
    if (!rec.name) {
      status = 'bad';
    } else {
      const key = rec.name.toLowerCase();
      existingClient = existingByName.get(key) || null;
      if (existingClient || seenInFile.has(key)) {
        status = 'dupe';
        // Only a true existing-database match can be backfilled — a same-file
        // repeat with no DB record has nothing to update.
        if (existingClient) {
          BACKFILLABLE_FIELDS.forEach(k => {
            if (!existingClient[k] && rec[k]) fieldsToBackfill[k] = rec[k];
          });
        }
      }
      seenInFile.add(key);
    }
    const fullRec = { ...rec, status, extraShareholders: [], existingClientId: existingClient ? existingClient.id : null, fieldsToBackfill };
    window.importPreviewRows.push(fullRec);
    currentMainRow = (status === 'valid' || status === 'dupe') ? fullRec : null;
  });

  renderImportPreview();
  showImportStep(3);
}

function renderImportPreview() {
  const mainRows = window.importPreviewRows.filter(r => r.status !== 'extra-shareholder');
  const valid = mainRows.filter(r => r.status === 'valid').length;
  const dupes = mainRows.filter(r => r.status === 'dupe').length;
  const bad   = mainRows.filter(r => r.status === 'bad').length;
  const noEmail = mainRows.filter(r => r.status === 'valid' && !r.email).length;
  const extraShareholderCount = window.importPreviewRows.filter(r => r.status === 'extra-shareholder').length;
  const backfillRows = mainRows.filter(r => r.status === 'dupe' && Object.keys(r.fieldsToBackfill || {}).length > 0);

  document.getElementById('import-stats').innerHTML = `
    <div class="import-stat"><div class="num">${mainRows.length}</div><div class="lbl">Companies in File</div></div>
    <div class="import-stat"><div class="num">${valid}</div><div class="lbl">Will Import</div></div>
    <div class="import-stat warn"><div class="num">${dupes}</div><div class="lbl">Duplicates Found</div></div>
    <div class="import-stat bad"><div class="num">${bad}</div><div class="lbl">Missing Name</div></div>
  `;

  const noEmailMsg = noEmail
    ? `⚠️ ${noEmail} of the clients being imported have no email address. You can add emails later from the Client Directory — the "Send Document" feature needs an email before it can be used for that client.`
    : '';
  const extraMsg = extraShareholderCount
    ? `ℹ️ Found ${extraShareholderCount} additional shareholder name${extraShareholderCount === 1 ? '' : 's'} in the file (rows with no company name, listed under the company above them) — these will be attached to their company, not imported as separate clients. Check the "Shareholders" column below.`
    : '';
  const backfillMsg = backfillRows.length
    ? `ℹ️ ${backfillRows.length} existing client${backfillRows.length === 1 ? '' : 's'} ${backfillRows.length === 1 ? 'is' : 'are'} already in your directory but ${backfillRows.length === 1 ? 'is' : 'are'} missing some fields this file has — those blank fields will be filled in. Nothing already on file will be overwritten.`
    : '';
  document.getElementById('import-warning').innerHTML = [noEmailMsg, extraMsg, backfillMsg]
    .filter(Boolean).map(m => `<div class="status-box status-info">${m}</div>`).join('');

  document.getElementById('import-preview-head').innerHTML = `
    <tr><th></th><th>Name</th><th>Entity Type</th><th>Email</th><th>PAN</th><th>Phone</th><th>Shareholders</th></tr>
  `;

  const MAX_SHOW = 60;
  const rowsToShow = mainRows.slice(0, MAX_SHOW);
  document.getElementById('import-preview-body').innerHTML = rowsToShow.map(r => {
    const cls = r.status === 'dupe' ? 'row-dupe' : (r.status === 'bad' ? 'row-bad' : '');
    const backfillCount = Object.keys(r.fieldsToBackfill || {}).length;
    const tag = r.status === 'dupe'
      ? (backfillCount
          ? `<span class="import-row-tag" style="background:#cfe8fb;color:#1a5f8a;">WILL BACKFILL ${backfillCount}</span>`
          : '<span class="import-row-tag" style="background:#fde89a;color:#8a6200;">DUPLICATE</span>')
      : r.status === 'bad'
        ? '<span class="import-row-tag" style="background:#f5b7b1;color:var(--red);">NO NAME</span>'
        : '<span class="import-row-tag" style="background:#b7dfc9;color:var(--green);">NEW</span>';
    const shareholders = [r.shareholder_name, ...(r.extraShareholders || [])].filter(Boolean);
    return `<tr class="${cls}">
      <td>${tag}</td>
      <td>${escHtml(r.name || '—')}</td>
      <td>${escHtml(r.entity_type || '—')}</td>
      <td>${escHtml(r.email || '—')}</td>
      <td>${escHtml(r.pan || '—')}</td>
      <td>${escHtml(r.phone || '—')}</td>
      <td>${shareholders.length ? escHtml(shareholders.join(', ')) : '—'}</td>
    </tr>`;
  }).join('') + (mainRows.length > MAX_SHOW
    ? `<tr><td colspan="7" style="text-align:center; color:var(--muted); padding:10px;">…and ${mainRows.length - MAX_SHOW} more rows not shown (all will still be processed)</td></tr>`
    : '');

  document.getElementById('import-confirm-btn').disabled = valid === 0 && backfillRows.length === 0;
  document.getElementById('import-confirm-btn').textContent = valid
    ? `Import ${valid} Client${valid === 1 ? '' : 's'}`
    : backfillRows.length
      ? `Update ${backfillRows.length} Existing Client${backfillRows.length === 1 ? '' : 's'}`
      : 'Nothing to Import';
}

async function confirmImport() {
  // Keep the original preview row alongside its payload so extraShareholders
  // can be linked to the client id Supabase generates on insert.
  const rowsToInsert = window.importPreviewRows
    .filter(r => r.status === 'valid')
    .map(r => ({
      sourceRow: r,
      payload: {
        name:            r.name,
        email:           r.email || null,
        pan:             r.pan || null,
        phone:           r.phone || null,
        entity_type:     r.entity_type || null,
        business_nature: r.business_nature || null,
        registration_number: r.registration_number || null,
        chairman_name:       r.chairman_name || null,
        shareholder_name:    r.shareholder_name || null,
        authorized_capital:  r.authorized_capital || null,
        issued_capital:      r.issued_capital || null,
        paid_up_capital:     r.paid_up_capital || null,
        address:         r.address || null,
        district:        r.district || null,
        country:         r.country || null,
        it_return_type:  r.it_return_type || null,
        tax_type_d3:     r.tax_type_d3 || null,
      },
    }));

  // Duplicates whose existing record is missing fields this file has — filled
  // in, never overwriting anything already on file.
  const rowsToBackfill = window.importPreviewRows.filter(
    r => r.status === 'dupe' && r.existingClientId && Object.keys(r.fieldsToBackfill || {}).length > 0
  );

  if (!rowsToInsert.length && !rowsToBackfill.length) return;

  const btn = document.getElementById('import-confirm-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('import-result-status');

  const CHUNK = 100;
  let inserted = 0;
  let shareholdersLinked = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
    statusEl.innerHTML = `<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Importing ${inserted}/${rowsToInsert.length}…</div>`;
    const { data, error } = await window.sb.from('clients').insert(chunk.map(c => c.payload)).select('id');
    if (error) {
      statusEl.innerHTML = `<div class="status-box status-error">❌ Stopped after ${inserted} rows: ${escHtml(error.message)}</div>`;
      btn.disabled = false;
      await loadClients();
      return;
    }
    inserted += chunk.length;

    // Postgres/PostgREST returns inserted rows in the same order they were sent.
    const shareholderRows = [];
    (data || []).forEach((row, idx) => {
      (chunk[idx].sourceRow.extraShareholders || []).forEach((name, sIdx) => {
        shareholderRows.push({ client_id: row.id, name, sort_order: sIdx });
      });
    });
    if (shareholderRows.length) {
      const { error: shErr } = await window.sb.from('client_shareholders').insert(shareholderRows);
      if (!shErr) shareholdersLinked += shareholderRows.length;
    }
  }

  let backfilled = 0;
  for (const row of rowsToBackfill) {
    statusEl.innerHTML = `<div class="status-box status-searching"><span class="spinner spinner-navy"></span> Updating existing clients ${backfilled}/${rowsToBackfill.length}…</div>`;
    const { error } = await window.sb.from('clients').update(row.fieldsToBackfill).eq('id', row.existingClientId);
    if (!error) {
      backfilled++;
      if (row.extraShareholders && row.extraShareholders.length) {
        // Only add if this client has no shareholders on file yet, so re-running
        // the same import doesn't create duplicate entries.
        const { data: existing } = await window.sb.from('client_shareholders').select('id').eq('client_id', row.existingClientId).limit(1);
        if (!existing || !existing.length) {
          const shareholderRows = row.extraShareholders.map((name, sIdx) => ({ client_id: row.existingClientId, name, sort_order: sIdx }));
          const { error: shErr } = await window.sb.from('client_shareholders').insert(shareholderRows);
          if (!shErr) shareholdersLinked += shareholderRows.length;
        }
      }
    }
  }

  const parts = [];
  if (inserted) parts.push(`imported ${inserted} client${inserted === 1 ? '' : 's'}`);
  if (backfilled) parts.push(`updated ${backfilled} existing client${backfilled === 1 ? '' : 's'}`);
  if (shareholdersLinked) parts.push(`linked ${shareholdersLinked} additional shareholder${shareholdersLinked === 1 ? '' : 's'}`);
  statusEl.innerHTML = `<div class="status-box status-success">✅ ${parts.join(', ')}.</div>`;
  await loadClients();
  setTimeout(closeImportModal, 1200);
}
