// ════════════════════════════════════════════
//  PROJECTION REPORT
//  Bank-ready multi-year financial projection generated from an uploaded
//  audited/provisional statement workbook. Three-step flow: Upload & Detect
//  (ProjectionEngine.parseStatement) → Assumptions (growth, loans, additions)
//  → Review & Export (auto-solved statements, editable balancing figures,
//  ratio pass/fail strip, Excel/PDF/DB outputs).
//
//  All calculation lives in js/projectionEngine.js (pure, DOM-free, master-
//  workbook rules); this file owns UI + orchestration only. Exports live in
//  js/projectionExport.js. Sundry Debtors is ALWAYS the balancing figure
//  (rule 8/10) — the review panel edits every other lever, never that one.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'projection', group: 'main', buttonId: null, panelId: 'tab-projection-panel' });

// The base fiscal year the firm is projecting FROM. A fixed default rather
// than one derived from the upload or today's date: the workbook's own "as at"
// year is regularly a year the firm isn't reporting on, and a projection built
// in Shrawan is for the year just closed. Same convention as ARF_FY_DEFAULT /
// SM_FY_DEFAULT. The field stays editable for the cases that differ.
// Reads window.FY_DEFAULT_START (config.js) — see that constant's comment.
// Built inline (not via pjFyLabel) because pjFyLabel takes a YEAR OFFSET from
// the base year, not a raw start year — it would be circular here.
const PJ_BASE_FY_DEFAULT = window.FY_DEFAULT_START + '-' + String((window.FY_DEFAULT_START + 1) % 100).padStart(2, '0');

let pjModel = null;          // parsed InputModel
let pjParseIssues = [];
let pjResult = null;         // last ProjectionEngine.project() output
let pjIssues = [];           // last validate() output
let pjSelectedClient = null;
let pjStatementView = 'pl';
let pjInitDone = false;
let pjRecalcTimer = null;
let pjSavedId = null;        // projection_reports row id once saved

// ── New Task vs Updation ──
// A projection is either being built for the first time or REVISED — the
// firm re-runs a client's projection when the bank asks for changed figures,
// and that is an update to the same record, not a second record. The mode is
// therefore what decides insert-vs-update on save, and it flips to 'update'
// automatically the moment a saved projection for the picked client is
// found: the record already existing in the database IS the fact that makes
// this an updation, so making the user notice and set it by hand would just
// be a way to end up with duplicates.
let pjTaskMode = 'new';      // 'new' | 'update'
let pjSavedList = [];        // this client's saved projection_reports rows
let pjLoadedRow = null;      // the saved row currently open, when updating

function pjStatus(html, type) { showStatus(html, type, 'pj-status-area'); }
function pjEl(id) { return document.getElementById(id); }
// Accounting display: lakh/crore grouping, negatives in parentheses, 0 → "–".
function pjAmt(v) {
  if (v == null || isNaN(v)) return '–';
  const n = Math.round(v);
  if (n === 0) return '–';
  const s = Math.abs(n).toLocaleString('en-IN');
  return n < 0 ? `(${s})` : s;
}

// ── Fiscal-year labels. Audited B.S. year 2083 → base FY "2082-83",
//    projection year 1 → "2083-84" (dash format per §9.5). ──
function pjBsYear() {
  const typed = (pjEl('pj-base-fy').value || '').match(/(20[6-9]\d)/);
  if (typed) return parseInt(typed[1], 10) + 1;      // "2082-83" → audited year-end 2083
  return parseInt(PJ_BASE_FY_DEFAULT.match(/(20[6-9]\d)/)[1], 10) + 1;
}
function pjFyLabel(y) { const b = pjBsYear(); return `${b + y - 1}-${String(b + y).slice(2)}`; }
function pjFyDot(y)   { const b = pjBsYear(); return `${b + y - 1}.${b + y}`; }
function pjAsAt(y)    { const b = pjBsYear(); return `${b + y}.03.31`; }

// The comparison column's as-at date. It heads the client's own reported
// figures, so it follows the same convention as the projected columns beside it
// rather than a fiscal-year label — and a statement drawn to a non-standard
// date needs to say so, which is why the box can override it. Empty =
// automatic, the same idiom as every other override in this module.
function pjBaseAsAt() {
  const el = pjEl('pj-base-asat');
  const typed = el ? (el.value || '').trim() : '';
  return typed || pjAsAt(0);
}

function pjInit() {
  if (pjInitDone) return;
  SearchEngine.attachAutocomplete(pjEl('pj-client-search'), pjEl('pj-client-autocomplete'), {
    getList: () => window.clientsList,
    keys: ['name', 'pan'],
    renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
    onSelect: pjSelectClient,
  });
  // Typing over the picked name detaches the screen from that client record,
  // so a later Save can't attach to it.
  pjEl('pj-client-search').addEventListener('input', () => { pjScope.invalidate(); pjSelectedClient = null; });
  // The company name is what saved projections are stored under, so it — not
  // just the directory picker — is what surfaces them. This module deliberately
  // allows projections for names that aren't in the client master, and those
  // were previously unreachable: nothing ever re-queried after a typed name.
  const companyEl = pjEl('pj-company');
  if (companyEl) companyEl.addEventListener('input', pjSavedLookupDebounced);
  pjPopulateStaff();
  pjRenderAdditionsRows();
  pjAddLoanRow('st');          // one starter row for the common case
  pjInitDone = true;
}

// ── Who performed this task ──
// Reuses window.ARF_STAFF rather than defining a projection-specific list —
// the same people, so adding a staff member stays one config edit (the same
// decision Work Done made). 'Other' reveals a free-text box whose typed name
// REPLACES 'Other' in what gets saved, so there is no *_other column.
function pjPopulateStaff() {
  const sel = pjEl('pj-staff');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select staff…</option>' +
    window.ARF_STAFF.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
}

function pjStaffChanged() {
  const isOther = pjEl('pj-staff').value === 'Other';
  const other = pjEl('pj-staff-other');
  other.style.display = isOther ? '' : 'none';
  if (!isOther) other.value = '';
}

function pjStaffName() {
  const sel = pjEl('pj-staff').value;
  if (!sel) return '';
  return sel === 'Other' ? pjEl('pj-staff-other').value.trim() : sel;
}

// Restores the picker from a saved name, which may be a typed one that isn't
// on the fixed list — that case has to land on 'Other' with the box shown,
// or re-saving would silently blank the person who did the work.
function pjSetStaff(name) {
  const sel = pjEl('pj-staff');
  const other = pjEl('pj-staff-other');
  if (!name) { sel.value = ''; other.value = ''; other.style.display = 'none'; return; }
  if (window.ARF_STAFF.includes(name) && name !== 'Other') {
    sel.value = name; other.value = ''; other.style.display = 'none';
  } else {
    sel.value = 'Other'; other.value = name; other.style.display = '';
  }
}

// Everything on this screen belongs to one client: the uploaded statement,
// the parsed model, the computed projection AND pjSavedId. That last one is
// why the clear is not cosmetic — a stale pjSavedId made pjSave() UPDATE the
// previous client's projection_reports row with the new client's figures.
const pjScope = WorkflowEngine.createClientScope({
  clear() {
    const hadUpload = !!pjModel;
    pjSelectedClient = null;
    pjModel = null; pjParseIssues = [];
    pjResult = null; pjIssues = [];
    pjSavedId = null;
    // The saved-projection list and the task mode belong to the previous
    // client just as much as the parsed statement does — leaving them
    // standing would offer to "update" another client's record.
    pjSavedList = []; pjLoadedRow = null;
    pjSetTaskMode('new');
    ['pj-company', 'pj-pan'].forEach(id => { const el = pjEl(id); if (el) el.value = ''; });
    // After the name is cleared, not before — the empty state reads off it.
    pjRenderSavedList();
    const fyEl = pjEl('pj-base-fy');
    if (fyEl) fyEl.value = PJ_BASE_FY_DEFAULT;   // back to the default, not blank
    const fileEl = pjEl('pj-file');
    if (fileEl) fileEl.value = '';
    pjRenderDetectSummary();
    pjShowSection('upload');
    pjStatus(hadUpload
      ? "Cleared the previous client's imported statement — upload this client's workbook to continue."
      : '', 'info');
  },
  load(c) {
    pjSelectedClient = c;
    pjEl('pj-client-search').value = c.name;
    pjEl('pj-company').value = c.name;
    pjEl('pj-pan').value = c.pan || '';
    const profile = (window.CLIENT_ENTITY_TO_REP_PROFILE || {})[String(c.entity_type || '').toLowerCase().trim()];
    pjEl('pj-org-type').value = profile === 'partnership' ? 'partnership'
      : profile === 'proprietorship' ? 'proprietorship' : 'private';
    pjOrgTypeChanged();
    // Fire-and-forget: the rest of the screen must not wait on this lookup,
    // and a failure downgrades to "no saved projections found", never blocks.
    pjLoadSavedForClient();
  },
});

// ════════════════════════════════════════════
//  TASK MODE — New Task vs Updation
// ════════════════════════════════════════════

function pjSetTaskMode(mode) {
  pjTaskMode = mode === 'update' ? 'update' : 'new';
  document.querySelectorAll('input[name="pj-task-mode"]').forEach(r => {
    r.checked = r.value === pjTaskMode;
    const opt = r.closest('.arf-type-option');
    if (opt) opt.classList.toggle('active', r.checked);
  });
  // A New Task must never overwrite the record that was loaded for updating
  // — dropping the id is what turns the next Save back into an insert.
  if (pjTaskMode === 'new') { pjSavedId = null; pjLoadedRow = null; }
  pjRenderTaskNote();
}

function pjTaskModeChanged() {
  const checked = document.querySelector('input[name="pj-task-mode"]:checked');
  pjSetTaskMode(checked ? checked.value : 'new');
  pjRenderSavedList();
}

function pjRenderTaskNote() {
  const el = pjEl('pj-task-note');
  if (!el) return;
  if (pjTaskMode === 'update' && pjLoadedRow) {
    const who = pjLoadedRow.performed_by || pjLoadedRow.created_by || 'not recorded';
    const when = (pjLoadedRow.updated_at || pjLoadedRow.created_at || '').slice(0, 10);
    el.innerHTML = `<span class="pj-task-chip">Updating saved projection #${pjLoadedRow.id}</span>` +
      `<span class="pj-task-sub">Last performed by <strong>${escHtml(who)}</strong>${when ? ' on ' + escHtml(when) : ''}</span>`;
  } else if (pjTaskMode === 'update') {
    el.innerHTML = '<span class="pj-task-sub">Pick a saved projection below to load its figures for updating.</span>';
  } else {
    el.innerHTML = '<span class="pj-task-sub">A first generation — saving creates a new projection record.</span>';
  }
}

// Which saved projections exist for the client on screen. Matched on
// client_id when there is one; a typed-only company (this module allows
// projections for non-directory names) falls back to the company name,
// which is what those rows were saved under.
//
// The name match is a case-insensitive CONTAINS, not equality: the point of
// this list is to answer "have we done this client before?" while the name is
// being typed, and an exact match answers that only once the last character
// lands — and misses entirely when the saved row reads "M.M. Poultry Breeding
// Pvt Ltd" and the typed name is "M.M. Poultry". Each row prints the company
// it belongs to, so a partial name matching two clients is legible rather than
// misleading.
let pjSavedQueryToken = 0;

async function pjLoadSavedForClient() {
  const company = ((pjEl('pj-company') || {}).value || '').trim();
  // Below 3 characters nearly every client matches, which is noise, not a list.
  if (!pjSelectedClient && company.length < 3) {
    pjSavedList = [];
    pjRenderSavedList();
    return;
  }
  // Typing fires these faster than they return; only the newest may render, or
  // an earlier reply can overwrite the list with a shorter prefix's results.
  const token = ++pjSavedQueryToken;
  try {
    let q = window.sb.from('projection_reports')
      .select('id, client_id, company_name, pan, fiscal_year_base, years, performed_by, created_by, created_at, updated_at')
      .order('updated_at', { ascending: false });
    q = pjSelectedClient
      ? q.eq('client_id', pjSelectedClient.id)
      : q.ilike('company_name', `%${company.replace(/[%_]/g, '')}%`);
    const { data, error } = await q;
    if (error) throw error;
    if (token !== pjSavedQueryToken) return;          // a newer query is in flight
    pjSavedList = data || [];
    // Already in the database ⇒ this is an updation. Auto-switching is the
    // whole point: it's what stops a revision being saved as a duplicate.
    // Only on a match that is certainly THIS client though — a partial-name
    // hit may belong to someone else, and the mode drives what Save does.
    const exact = pjSelectedClient
      || pjSavedList.some(r => (r.company_name || '').trim().toLowerCase() === company.toLowerCase());
    if (pjSavedList.length && exact && !pjLoadedRow) pjSetTaskMode('update');
    pjRenderSavedList();
  } catch (e) {
    console.error('projection: could not list saved reports', e);
    if (token === pjSavedQueryToken) { pjSavedList = []; pjRenderSavedList(); }
  }
}

// Typing a company name shouldn't fire a query per keystroke.
let pjSavedLookupTimer = null;
function pjSavedLookupDebounced() {
  clearTimeout(pjSavedLookupTimer);
  pjSavedLookupTimer = setTimeout(() => pjLoadSavedForClient(), 300);
}

function pjRenderSavedList() {
  const el = pjEl('pj-saved-list');
  if (!el) return;
  const company = ((pjEl('pj-company') || {}).value || '').trim();
  if (!pjSavedList.length) {
    // The box says something whenever a name is on screen. It used to render
    // nothing at all unless a directory client was picked, so a typed-in
    // company looked as though the feature did not exist.
    el.innerHTML = (pjSelectedClient || company.length >= 3)
      ? '<div class="pj-saved-empty">No saved projection found for this name yet — this will be a new task.</div>'
      : '<div class="pj-saved-empty">Pick or type a client name to see projections saved for them.</div>';
    return;
  }
  el.innerHTML = `<div class="pj-saved-head">${pjSavedList.length} saved projection${pjSavedList.length === 1 ? '' : 's'}</div>` +
    pjSavedList.map(r => {
      const who = r.performed_by || r.created_by || '—';
      const when = (r.updated_at || r.created_at || '').slice(0, 10);
      const isOpen = pjLoadedRow && pjLoadedRow.id === r.id;
      // The company is printed because a partial-name search can span clients;
      // without it two similarly named companies are indistinguishable here.
      return `
        <div class="pj-saved-row${isOpen ? ' open' : ''}">
          <div class="pj-saved-main">
            <div class="pj-saved-title"><strong>#${r.id}</strong> · ${escHtml(r.company_name || '—')}</div>
            <div class="pj-saved-meta">Base F.Y. ${escHtml(r.fiscal_year_base || '—')} · ${r.years} year${r.years === 1 ? '' : 's'}
              · performed by <strong>${escHtml(who)}</strong>${when ? ' · ' + escHtml(when) : ''}</div>
          </div>
          <div class="pj-saved-actions">
            <button class="btn btn-outline btn-sm" onclick="pjLoadSaved(${r.id})">${isOpen ? 'Reload' : 'Load & Update'}</button>
            <button class="btn btn-danger btn-sm" onclick="pjDeleteSaved(${r.id})">Delete</button>
          </div>
        </div>`;
    }).join('');
}

// Browse EVERY saved projection, not just the ones matching the name on screen
// — the same "Saved reports" drawer the Audit Report Builder uses, through the
// shared picker in js/core/documentStore.js. The inline list below the Task
// card answers "has this client been done before?"; this answers "where is
// that projection I saved last month?", which is a different question and the
// reason the drawer lists everything.
const PJ_SAVED_COLS = 'id, client_id, company_name, pan, fiscal_year_base, years, performed_by, created_by, created_at, updated_at';

function pjOpenSavedDrawer() {
  DocumentStore.openPicker({
    label: 'Saved projection reports',
    empty: 'Nothing saved yet. Use <strong>Save to Database</strong> on a projection and it will be listed here.',
    fetchRows: async () => {
      const { data, error } = await window.sb.from('projection_reports')
        .select(PJ_SAVED_COLS).order('updated_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    },
    describe: r => {
      const when = r.updated_at || r.created_at;
      const d = when ? new Date(when) : null;
      const stamp = d && !isNaN(d)
        ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      return {
        title: `${r.company_name || '—'} (Base F.Y. ${r.fiscal_year_base || '—'})`,
        meta: `${r.years} year${r.years === 1 ? '' : 's'}`
            + (stamp ? ` · saved ${stamp}` : '')
            + ` · ${r.performed_by || r.created_by || 'not recorded'}`,
      };
    },
    onChoose: id => pjLoadSaved(id),
    onDelete: async id => {
      const { error } = await window.sb.from('projection_reports').delete().eq('id', id);
      if (error) throw error;
      // Same orphan guard as the inline list: a stale pjSavedId would make the
      // next Save issue an UPDATE matching nothing.
      if (pjSavedId === id || (pjLoadedRow && pjLoadedRow.id === id)) {
        pjSavedId = null; pjLoadedRow = null;
        pjSetTaskMode('new');
        if (pjResult) pjRenderReview();
      }
      AuditLog.record('projection_deleted', {
        module: 'projection', clientName: pjEl('pj-company').value || '', status: 'success', recordRef: id,
      });
      pjLoadSavedForClient();      // keep the inline list in step
    },
  });
}

// Deleting the record that is currently open has to reset the task mode too:
// pjSavedId would otherwise still point at a row that no longer exists, and the
// next Save would issue an UPDATE that silently matches nothing.
async function pjDeleteSaved(id) {
  const row = pjSavedList.find(r => r.id === id);
  const name = row ? (row.company_name || '') : '';
  if (!confirm(`Delete saved projection #${id}${name ? ' for ' + name : ''}? This cannot be undone.`)) return;
  try {
    pjStatus('Deleting saved projection…', 'searching');
    const { error } = await window.sb.from('projection_reports').delete().eq('id', id);
    if (error) throw error;
    if (pjSavedId === id || (pjLoadedRow && pjLoadedRow.id === id)) {
      pjSavedId = null; pjLoadedRow = null;
      pjSetTaskMode('new');
      if (pjResult) pjRenderReview();     // the action button must stop saying "Update #id"
    }
    await pjLoadSavedForClient();
    pjStatus(`Saved projection #${id} deleted.`, 'success');
    AuditLog.record('projection_deleted', {
      module: 'projection', clientName: name || (pjEl('pj-company').value || ''),
      status: 'success', recordRef: id,
    });
  } catch (e) {
    console.error(e);
    pjStatus('Could not delete: ' + escHtml(e.message), 'error');
  }
}

// ── Load a saved projection back onto the screen ──
// inputs.parsedModel + inputs.assumptions are everything the engine needs to
// reproduce the projection exactly, so an updation re-solves from the SAME
// statement rather than asking for the workbook again — which the firm often
// no longer has to hand months later.
async function pjLoadSaved(id) {
  pjStatus('Loading saved projection…', 'searching');
  try {
    const { data, error } = await window.sb.from('projection_reports').select('*').eq('id', id).single();
    if (error) throw error;
    const inputs = data.inputs || {};
    if (!inputs.parsedModel || !inputs.assumptions) {
      pjStatus('That saved record does not carry its parsed statement, so it cannot be re-opened for updating. Upload the workbook and save it again as a new task.', 'error');
      return;
    }
    pjModel = inputs.parsedModel;
    pjParseIssues = [];
    pjLoadedRow = data;
    pjSavedId = data.id;
    pjSetTaskMode('update');

    pjEl('pj-company').value = data.company_name || '';
    pjEl('pj-pan').value = data.pan || '';
    if (data.performed_by) pjSetStaff(data.performed_by);
    pjApplyAssumptions(inputs.assumptions, inputs.ui || {});
    pjRenderDetectSummary();
    pjRenderSavedList();

    // Re-solve from the saved assumptions rather than re-reading the form:
    // the form was just populated from them, but the overrides live in the
    // assumptions only and have no inputs to read back from yet.
    pjRunAsm(JSON.parse(JSON.stringify(inputs.assumptions)));
    pjShowSection('review');
    pjStatus(`Loaded saved projection #${data.id} — change any figure and Save to update this record.`, 'success');
  } catch (e) {
    console.error(e);
    pjStatus('Could not load that projection: ' + escHtml(e.message || String(e)), 'error');
  }
}

// Writes a saved assumptions object back onto the Step 2 form, so an
// updation is edited in exactly the same place a new task is built.
function pjApplyAssumptions(asm, ui) {
  const set = (id, v) => { const el = pjEl(id); if (el != null && v != null) el.value = v; };
  set('pj-years', asm.years);
  set('pj-org-type', asm.orgType);
  set('pj-growth1', asm.growthY1Pct);
  set('pj-growth-rest', asm.growthRestPct);
  set('pj-nca-pct', asm.ncaPct);
  set('pj-tax-profile', asm.taxProfile);
  if (ui.baseFy) set('pj-base-fy', ui.baseFy);
  if (ui.statementType) set('pj-statement-type', ui.statementType);
  const inc = pjEl('pj-include-audited');
  if (inc) inc.checked = !!asm.includeAudited;

  pjSetLoans('st', asm.stLoans); pjSetLoans('lt', asm.ltLoans);
  pjSetLoans('pwc', asm.pwcLoans); pjSetLoans('hp', asm.hpLoans);

  pjRenderAdditionsRows();
  ProjectionEngine.DEP_POOLS.forEach(p => {
    const a = pjEl('pj-add-' + p.key), d = pjEl('pj-dis-' + p.key);
    if (a) a.value = (asm.additions && asm.additions[p.key]) || '';
    if (d) d.value = (asm.disposals && asm.disposals[p.key]) || '';
  });
}

// Rebuilds a loan group from saved rows. Clearing first matters: appending
// would stack the loaded loans on top of whatever the form already showed
// and silently double the client's debt.
function pjSetLoans(kind, list) {
  const wrap = pjEl('pj-loans-' + kind);
  if (!wrap) return;
  wrap.innerHTML = '';
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) { if (kind === 'st') pjAddLoanRow('st'); return; }
  rows.forEach(l => {
    pjAddLoanRow(kind);
    const row = wrap.lastElementChild;
    const put = (f, v) => { const el = row.querySelector(`[data-f="${f}"]`); if (el && v) el.value = v; };
    put('amount', l.amount); put('rate', l.ratePct); put('years', l.years);
  });
}

function pjSelectClient(c) { pjScope.select(c); }

// Organization type drives both the report terminology (Director/Partner/
// Proprietor, Paid-up vs Registered Capital) and the rule-9 tax profile.
function pjOrgTypeChanged() {
  pjEl('pj-tax-profile').value = pjEl('pj-org-type').value === 'proprietorship' ? 'progressive' : 'corporate';
}

// ── Step 1: Upload & Detect ──

async function pjHandleFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  pjStatus('Reading workbook…', 'searching');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    // Auto-detect Audited vs Provisional from the uploaded filename so the
    // report labels the single correct statement type (never both). User can
    // still override via the selector.
    if (/provision/i.test(file.name)) pjEl('pj-statement-type').value = 'provisional';
    else if (/audit/i.test(file.name)) pjEl('pj-statement-type').value = 'audited';
    const { model, issues } = ProjectionEngine.parseStatement(wb, XLSX);
    pjModel = model;
    pjParseIssues = issues;
    pjResult = null; pjIssues = [];
    // A freshly uploaded statement is a NEW task, even for a client who has
    // saved projections: keeping the update link here would let an upload
    // for a different year silently overwrite an existing record. Switching
    // to Updation and loading that record is the explicit way to revise it.
    pjSetTaskMode('new');
    pjRenderSavedList();

    const errors = issues.filter(i => i.level === 'error');
    pjRenderDetectSummary();
    if (errors.length) {
      pjStatus(`Workbook read, but ${errors.length} required figure(s) could not be extracted — see below.`, 'error');
      return;
    }
    // Prefill assumptions from the detected statement
    if (!pjEl('pj-company').value) pjEl('pj-company').value = model.company.name;
    // The base year is the firm's choice, not the workbook's — an upload only
    // fills it when the user has cleared it, never overwrites what is there.
    if (!pjEl('pj-base-fy').value.trim()) pjEl('pj-base-fy').value = PJ_BASE_FY_DEFAULT;
    pjRenderAdditionsRows();
    // The workbook names the company, so an upload alone is enough to know
    // whether this client already has projections on file — no need to make
    // the user re-type a name the statement just supplied.
    pjLoadSavedForClient();
    pjStatus(`Statement detected — ${issues.length ? issues.length + ' warning(s), see summary.' : 'all figures extracted cleanly.'} Continue to Assumptions.`, 'success');
    AuditLog.record('projection_statement_parsed', { module: 'projection', clientName: model.company.name, status: 'success' });
    pjShowSection('assumptions');
  } catch (e) {
    console.error(e);
    pjStatus('Could not read this file as an Excel workbook: ' + escHtml(e.message), 'error');
  }
}

function pjRenderDetectSummary() {
  const el = pjEl('pj-detect-summary');
  if (!pjModel) { el.innerHTML = ''; return; }
  const m = pjModel;
  const rows = [
    ['Company', m.company.name], ['Address', m.company.address],
    ['Statement as at', m.company.bsYear ? `Ashadh end ${m.company.bsYear}` : '—'],
    ['Revenue from Operations', pjAmt(m.revenue.operations)],
    ['Profit Before Tax', pjAmt(m.profitBeforeTax)],
    ['Closing Stock', pjAmt(m.inventory.closing)],
    ['Share Capital', pjAmt(m.shareCapital)], ['Reserves', pjAmt(m.reserves)],
    ['Fixed Assets (PPE)', pjAmt(m.ppeTotal)],
    ['Salary (3.13)', pjAmt(m.salary)], ['Other Expense lines (3.15)', String(m.otherExpenses.length)],
    ['Overdraft', pjAmt(m.loans.overdraft)], ['Term loans', pjAmt(m.loans.term.reduce((s, l) => s + l.amount, 0))],
  ];
  const issueHtml = pjParseIssues.length
    ? `<div style="margin-top:12px;">${pjParseIssues.map(i =>
        `<div class="status-box ${i.level === 'error' ? 'status-error' : 'status-info'}" style="margin-bottom:6px;">${escHtml(i.msg)}</div>`).join('')}</div>`
    : '';
  el.innerHTML = `
    <div class="table-wrap"><table class="client-table">
      <tbody>${rows.map(r => `<tr><td style="font-weight:600; width:40%;">${escHtml(r[0])}</td><td>${escHtml(String(r[1]))}</td></tr>`).join('')}</tbody>
    </table></div>${issueHtml}`;
}

// ── Step 2: Assumptions ──

function pjRenderAdditionsRows() {
  const body = pjEl('pj-additions-body');
  if (!body) return;
  body.innerHTML = ProjectionEngine.DEP_POOLS.map(p => `
    <tr>
      <td>${escHtml(p.name)}</td>
      <td>${p.rate === 0 ? '—' : (p.rate * 100).toFixed(p.rate === 0.07 ? 0 : 0) + '%'}</td>
      <td style="text-align:right;">${pjModel ? pjAmt(pjModel.ppe[p.key] || 0) : '–'}</td>
      <td><input type="number" id="pj-add-${p.key}" min="0" step="1000" placeholder="0" style="width:130px;" /></td>
      <td><input type="number" id="pj-dis-${p.key}" min="0" step="1000" placeholder="0" style="width:130px;" /></td>
    </tr>`).join('');
}

function pjAddLoanRow(kind) {
  const wrap = pjEl('pj-loans-' + kind);
  const row = document.createElement('div');
  row.className = 'pj-loan-row';
  row.style.cssText = 'display:flex; gap:10px; align-items:flex-end; margin-bottom:8px; flex-wrap:wrap;';
  row.innerHTML = `
    <div class="form-group" style="margin:0;"><label>Amount (Rs)</label><input type="number" data-f="amount" min="0" step="10000" style="width:150px;" /></div>
    <div class="form-group" style="margin:0;"><label>Interest Rate %</label><input type="number" data-f="rate" min="0" step="0.25" style="width:110px;" /></div>
    ${kind === 'st' ? '' : '<div class="form-group" style="margin:0;"><label>Remaining Years</label><input type="number" data-f="years" min="1" max="30" step="1" style="width:110px;" /></div>'}
    <button class="btn btn-outline btn-sm" onclick="this.parentElement.remove()">Remove</button>`;
  wrap.appendChild(row);
}

function pjCollectLoans(kind) {
  return Array.from(pjEl('pj-loans-' + kind).querySelectorAll('.pj-loan-row')).map(row => {
    const g = f => parseFloat((row.querySelector(`[data-f="${f}"]`) || {}).value) || 0;
    return { amount: g('amount'), ratePct: g('rate'), years: g('years') };
  }).filter(l => l.amount > 0);
}

function pjCollectOverrides() {
  const overrides = {};
  document.querySelectorAll('#pj-overrides input[data-year]').forEach(inp => {
    if (inp.value === '') return;
    const y = parseInt(inp.dataset.year, 10);
    overrides[y] = overrides[y] || {};
    overrides[y][inp.dataset.field] = parseFloat(inp.value) || 0;
  });
  return overrides;
}

function pjCollectAsm(keepOverrides) {
  const additions = {}, disposals = {};
  ProjectionEngine.DEP_POOLS.forEach(p => {
    additions[p.key] = parseFloat((pjEl('pj-add-' + p.key) || {}).value) || 0;
    disposals[p.key] = parseFloat((pjEl('pj-dis-' + p.key) || {}).value) || 0;
  });
  return {
    years: Math.min(10, Math.max(1, parseInt(pjEl('pj-years').value, 10) || 3)),
    orgType: pjEl('pj-org-type').value,
    includeAudited: pjEl('pj-include-audited').checked,
    growthY1Pct: parseFloat(pjEl('pj-growth1').value) || 0,
    growthRestPct: parseFloat(pjEl('pj-growth-rest').value) || 0,
    // Drawing-power percentage — entered by the user, never recalculated.
    ncaPct: Math.min(100, Math.max(1, parseFloat(pjEl('pj-nca-pct').value) || 70)),
    stLoans: pjCollectLoans('st'),
    ltLoans: pjCollectLoans('lt'),
    pwcLoans: pjCollectLoans('pwc'),
    hpLoans: pjCollectLoans('hp'),
    additions, disposals,
    taxProfile: pjEl('pj-tax-profile').value,
    seedKey: `${pjEl('pj-pan').value}|${pjEl('pj-company').value}|${pjFyLabel(1)}`,
    overrides: keepOverrides ? pjCollectOverrides() : {},
  };
}

function pjCalculate() {
  if (!pjModel) { pjStatus('Upload a financial statement first (Step 1).', 'error'); return; }
  if (pjParseIssues.some(i => i.level === 'error')) { pjStatus('The uploaded statement is missing required figures — fix the file and re-upload.', 'error'); return; }
  pjRun(false);
  pjShowSection('review');
  AuditLog.record('projection_generated', { module: 'projection', clientName: pjEl('pj-company').value, status: 'success', detail: { years: pjEl('pj-years').value } });
}

// Share Capital used to have a single box here that rewrote the parsed figure
// for every year at once. It is now a per-year row in the Balancing Figures
// table instead (PJ_OVERRIDE_FIELDS), because a rights issue lands in one year
// rather than across the projection — so the parsed figure stands as the base
// and each year overrides it on its own.
function pjRun(keepOverrides) {
  pjRunAsm(pjCollectAsm(keepOverrides));
}

function pjRunAsm(asm) {
  pjResult = ProjectionEngine.project(pjModel, asm);
  pjResult.asm = asm;
  pjIssues = ProjectionEngine.validate(pjModel, pjResult);
  // Re-solving used to unconditionally drop pjSavedId, so every edit turned
  // the next Save into a brand-new row. That is right for a New Task and
  // wrong for an Updation — revising the figures is the entire purpose of an
  // updation, and it must still write back to the record it was loaded from.
  if (pjTaskMode !== 'update') pjSavedId = null;
  pjRenderReview();
}

function pjRecalcDebounced() {
  clearTimeout(pjRecalcTimer);
  pjRecalcTimer = setTimeout(() => pjRun(true), 350);
}

// ── Step 3: Review rendering ──

function pjRenderReview() {
  if (!pjResult) return;
  pjRenderValidation();
  pjRenderRatioStrip();
  pjRenderOverrides();
  pjRenderLevers();
  pjRenderStatement();
  // Exports stay available even when validation flags something — a flagged
  // projection still needs to leave the app so it can be corrected in Excel
  // (the workbook carries a Validation sheet listing every finding). Only
  // saving to the database is gated, so bad figures never become a record.
  const hasErrors = pjIssues.some(i => i.level === 'error');
  pjEl('pj-print-btn').disabled = false;
  pjEl('pj-excel-btn').disabled = false;
  const saveBtn = pjEl('pj-save-btn');
  saveBtn.disabled = hasErrors;
  // The button says which of the two it will do, so an updation can never be
  // mistaken for a save that quietly creates a second record.
  saveBtn.textContent = (pjTaskMode === 'update' && pjSavedId)
    ? `Update Saved Projection #${pjSavedId}` : 'Save to Database';
}

function pjRenderValidation() {
  const el = pjEl('pj-validation');
  if (!pjIssues.length) {
    el.innerHTML = '<div class="status-box status-success">All checks pass — balance ties, cash flow ties, and every banker ratio is within limits for all years.</div>';
    return;
  }
  el.innerHTML = pjIssues.map(i =>
    `<div class="status-box ${i.level === 'error' ? 'status-error' : 'status-info'}" style="margin-bottom:6px;">${escHtml(i.msg)}</div>`).join('');
}

function pjRenderRatioStrip() {
  const L = ProjectionEngine.LIMITS;
  const pct = Math.round(((pjResult.meta && pjResult.meta.ncaFactor) || L.ncaFactor) * 100);
  const chip = (ok, label, value) =>
    `<span class="log-badge ${ok ? 'badge-sent' : 'badge-error'}" style="margin:2px 4px 2px 0;">${escHtml(label)}: ${escHtml(value)}</span>`;
  pjEl('pj-ratio-strip').innerHTML = pjResult.years.map(yr => {
    const r = yr.ratios;
    return `<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:6px 0; border-bottom:1px solid var(--border-light);">
      <strong style="font-size:12.5px; width:90px;">F.Y. ${escHtml(pjFyLabel(yr.year))}</strong>
      ${chip(r.debtorDays >= L.minDebtorDays - 0.5 && r.debtorDays <= L.maxDebtorDays + 0.5, 'Debtor days', r.debtorDays.toFixed(0) + ' (' + L.minDebtorDays + '–' + L.maxDebtorDays + ')')}
      ${chip(r.currentRatio >= L.minCurrentRatio - L.ratioEps, 'Current ratio', r.currentRatio.toFixed(2) + ' ≥ ' + L.minCurrentRatio)}
      ${chip(r.debtEquity <= L.maxDebtEquity + L.ratioEps, 'Debt-equity', r.debtEquity.toFixed(2) + ' ≤ ' + L.maxDebtEquity)}
      ${chip(r.ncaHeadroom >= L.minNcaHeadroom - 0.5, `${pct}% NCA headroom (H)`, pjAmt(r.ncaHeadroom) + ' ≥ ' + pjAmt(L.minNcaHeadroom))}
      ${chip(Math.abs(yr.bs.totalSources - yr.bs.totalUses) <= 1, 'Balance', 'ties')}
    </div>`;
  }).join('');
}

// The editable levers, one column per year. Empty box = automatic.
// Share Capital is per-year because a rights issue lands in a single year — an
// empty box falls back to the base figure in the Share Capital box above.
const PJ_OVERRIDE_FIELDS = [
  { field: 'sales',             label: 'Income from Sales/Service' },
  { field: 'shareCapital',      label: 'Share Capital' },
  { field: 'cash',              label: 'Cash at Hand & Bank' },
  { field: 'creditors',         label: 'Sundry Creditors' },
  { field: 'closingStock',      label: 'Closing Stock' },
  { field: 'additionalCapital', label: 'Additional Capital' },
  { field: 'dividend',          label: 'Dividend / Withdrawal' },
];

function pjRenderOverrides() {
  const ov = (pjResult.asm && pjResult.asm.overrides) || {};
  const auto = (yr, f) => ({
    sales: yr.pl.sales, shareCapital: yr.bs.shareCapital,
    cash: yr.bs.cash, creditors: yr.bs.creditors, closingStock: yr.pl.closingStock,
    additionalCapital: yr.bs.additionalCapital, dividend: yr.pl.dividend,
  })[f];
  // pjRecalcDebounced re-runs the solver and calls back in here on every
  // keystroke (debounced), which rebuilds the whole table via innerHTML —
  // that destroys the focused <input> and replaces it with a brand-new DOM
  // node, so the browser drops focus, and a fresh node focused
  // programmatically starts its caret at position 0. type="number" inputs
  // don't support selectionStart/setSelectionRange at all (both throw
  // InvalidStateError unconditionally — not just report null), so the caret
  // can't be repositioned via JS after the fact; every following keystroke
  // was inserting BEFORE what was already typed, reversing digits typed in
  // one run ("123456" landed as "654321"). The only real fix is to keep
  // reusing the SAME live <input> node rather than letting the rebuild
  // recreate it — a node's native caret position survives being detached
  // and reattached, just not being destroyed and recreated.
  const container = pjEl('pj-overrides');
  const active = container.querySelector('input:focus');
  const activeKey = active ? { year: active.dataset.year, field: active.dataset.field } : null;
  container.innerHTML = `<div class="table-wrap"><table class="client-table">
    <thead><tr><th>Figure</th>${pjResult.years.map(yr => `<th style="text-align:right;">F.Y. ${escHtml(pjFyLabel(yr.year))}</th>`).join('')}</tr></thead>
    <tbody>
      ${PJ_OVERRIDE_FIELDS.map(fd => `<tr>
        <td style="font-weight:600;">${escHtml(fd.label)}</td>
        ${pjResult.years.map(yr => {
          const set = ov[yr.year] && ov[yr.year][fd.field] != null;
          return `<td><input type="number" data-year="${yr.year}" data-field="${fd.field}"
            value="${set ? ov[yr.year][fd.field] : ''}" placeholder="${Math.round(auto(yr, fd.field))}"
            oninput="pjRecalcDebounced()" style="width:100%; min-width:110px; text-align:right;${set ? ' border-color:var(--accent-blue);' : ''}" /></td>`;
        }).join('')}
      </tr>`).join('')}
      <tr>
        <td style="font-weight:600;">Sundry Debtors <span style="color:var(--text-muted); font-weight:400;">(balancing — automatic)</span></td>
        ${pjResult.years.map(yr => `<td style="text-align:right; color:var(--text-muted);">${pjAmt(yr.bs.debtors)}</td>`).join('')}
      </tr>
    </tbody></table></div>`;
  if (activeKey) {
    const fresh = container.querySelector(`input[data-year="${activeKey.year}"][data-field="${activeKey.field}"]`);
    if (fresh) {
      // Reusing the live node means it keeps whatever border-color it had
      // before this render — sync the "set" highlight the fresh node would
      // have carried so it doesn't lag a render behind while typing.
      const isSet = ov[activeKey.year] && ov[activeKey.year][activeKey.field] != null;
      active.style.borderColor = isSet ? 'var(--accent-blue)' : '';
      fresh.replaceWith(active);
      active.focus();
    }
  }
}

// Why is there owner capital on this balance sheet, and what would remove it?
// The solver already drives the figure to the smallest constant that works, so
// when one survives, the only useful thing left to show is WHICH bank test is
// the wall — cash and closing stock cannot touch the current ratio or the
// debt-equity ratio at all (Current Assets = Sources − Fixed Assets + Current
// Liabilities, so both cancel out), and when one of those binds, the loan
// structure is the only remaining lever. The engine never restructures the
// loans itself: how a facility is classified is a fact about the client.
function pjCapitalNote() {
  const d = pjResult.capitalDriver;
  if (!d) {
    return '<div class="status-box status-success" style="margin-bottom:10px;">'
      + 'No Additional Capital is required — every ratio is satisfied on the client\'s own funds.</div>';
  }
  const cannotMove = d.test === 'currentRatio' || d.test === 'debtEquity';
  let html = `<div class="status-box status-info" style="margin-bottom:10px;">`
    + `<strong>Additional Capital of Rs ${escHtml(pjAmt(d.amount))}</strong> is the smallest single figure that works for every year. `
    + `It is forced by the <strong>${escHtml(d.label)}</strong> in F.Y. ${escHtml(pjFyLabel(d.year))}`
    + (cannotMove
        ? ' — a test that cash and closing stock cannot move at all, because both cancel out of Current Assets = Sources − Fixed Assets + Current Liabilities.'
        : ' — the cash and closing-stock levers are already at their limits.');
  let sug = null;
  try { sug = ProjectionEngine.suggestReclass(pjModel, pjResult.asm, { years: 5 }); } catch (e) { console.error(e); }
  if (sug && sug.feasible) {
    html += ` <br><br>Showing <strong>Rs ${escHtml(pjAmt(sug.amount))}</strong> of the short-term facility as a `
      + `${escHtml(String(sug.years))}-year term loan at ${escHtml(sug.ratePct.toFixed(2))}% instead would bring Additional Capital to <strong>nil</strong> `
      + `— it leaves Current Liabilities and joins Sources. Enter it that way in Step 2 if that matches the client's actual facility.`;
  } else if (sug) {
    html += ` Reclassifying the short-term facility as a term loan would not remove it either.`;
  }
  return html + '</div>';
}

function pjRenderLevers() {
  const applied = [];
  const describe = (l) => {
    if (l.action === 'additionalCapital') return 'injected Additional Capital';
    if (l.action === 'dividend') return 'declared Dividend/Withdrawal';
    return (l.amount < 0 ? 'reduced' : 'raised') + ' Closing Stock';   // closingStock
  };
  const ruleLabel = (r) => (r === 'a' || r === 'b') ? `debtor-floor step (${r})` : `rule ${r}`;
  pjResult.years.forEach(yr => yr.levers.forEach(l => applied.push(
    `F.Y. ${pjFyLabel(yr.year)} — ${ruleLabel(l.rule)}: ${describe(l)} of Rs ${pjAmt(Math.abs(l.amount))}`)));
  pjEl('pj-levers').innerHTML = pjCapitalNote() + (applied.length
    ? `<div style="font-size:12.5px; color:var(--text-muted);"><strong>Auto-solver decisions:</strong><ul style="margin:6px 0 0 18px;">${applied.map(a => `<li>${escHtml(a)}</li>`).join('')}</ul></div>`
    : '<div style="font-size:12.5px; color:var(--text-muted);">No rule adjustments were needed — the projection satisfies every constraint as computed.</div>');
}

function pjShowStatement(view) {
  pjStatementView = view;
  ['pl', 'bs', 'cf', 'dep', 'ird'].forEach(v => {
    const btn = pjEl('pj-view-' + v);
    if (btn) btn.classList.toggle('active', v === view);
  });
  pjRenderStatement();
}

function pjRow(label, vals, opts = {}) {
  const b = opts.bold ? ' font-weight:700;' : '';
  const ind = opts.indent ? ' padding-left:24px;' : '';
  return `<tr><td style="${b}${ind}">${escHtml(label)}</td>${vals.map(v =>
    `<td style="text-align:right;${b}">${typeof v === 'string' ? escHtml(v) : pjAmt(v)}</td>`).join('')}</tr>`;
}

function pjStatementTable(headLabel, headCols, bodyHtml) {
  return `<table class="client-table"><thead><tr><th>${escHtml(headLabel)}</th>${headCols.map(h =>
    `<th style="text-align:right;">${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function pjRenderStatement() {
  const wrap = pjEl('pj-statement-wrap');
  if (!pjResult) { wrap.innerHTML = ''; return; }
  const Y = pjResult.years;
  const v = f => Y.map(f);
  const fyCols = Y.map(yr => pjFyDot(yr.year));

  if (pjStatementView === 'pl') {
    let html = '';
    html += pjRow('Income from Sales/Service', v(y => y.pl.sales), { bold: true });
    html += pjRow('Opening Stock', v(y => y.pl.openingStock), { indent: true });
    html += pjRow('Goods Purchase', v(y => y.pl.purchases), { indent: true });
    html += pjRow('Direct Cost', v(y => y.pl.directCost), { indent: true });
    html += pjRow('(-) Closing Stock', v(y => -y.pl.closingStock), { indent: true });
    html += pjRow('Cost of Goods Sold', v(y => y.pl.cogs), { bold: true });
    html += pjRow('Gross Profit', v(y => y.pl.grossProfit), { bold: true });
    Y[0].pl.adminLines.forEach((_, i) => {
      html += pjRow(Y[0].pl.adminLines[i].name, v(y => y.pl.adminLines[i].amount), { indent: true });
    });
    html += pjRow('Administrative Expenses', v(y => y.pl.adminTotal), { bold: true });
    html += pjRow('Profit before Interest/Depreciation', v(y => y.pl.grossProfit - y.pl.adminTotal), { bold: true });
    html += pjRow('Bank Interest on Short term/OD', v(y => y.pl.interestST));
    html += pjRow('Bank Interest on Term Loan', v(y => y.pl.interestLT));
    html += pjRow('Depreciation', v(y => y.pl.dep));
    html += pjRow('Net Profit before tax', v(y => y.pl.pbt), { bold: true });
    html += pjRow('Provision for tax', v(y => y.pl.tax));
    html += pjRow('Net Profit after tax', v(y => y.pl.pat), { bold: true });
    html += pjRow('Profit/loss upto last year', v(y => y.pl.retainedOpening));
    html += pjRow('Dividend/Withdrawal', v(y => y.pl.dividend));
    html += pjRow('Transferred to Balance Sheet', v(y => y.pl.retainedClosing), { bold: true });
    wrap.innerHTML = pjStatementTable('Projected Profit & Loss', fyCols, html);

  } else if (pjStatementView === 'bs') {
    let html = '';
    html += pjRow('Sources of Funds:', Y.map(() => ''), { bold: true });
    html += pjRow('Share Capital', v(y => y.bs.shareCapital), { indent: true });
    html += pjRow('Additional Capital', v(y => y.bs.additionalCapital), { indent: true });
    html += pjRow('Reserve & Surplus', v(y => y.bs.reserves), { indent: true });
    html += pjRow('Long Term Loan', v(y => y.bs.longTermLoan), { indent: true });
    html += pjRow('Permanent Working Capital', v(y => y.bs.permanentWC), { indent: true });
    html += pjRow('Director/Proprietor Lending', v(y => y.bs.directorLending), { indent: true });
    html += pjRow('Total Sources of Funds', v(y => y.bs.totalSources), { bold: true });
    html += pjRow('Uses of Funds:', Y.map(() => ''), { bold: true });
    html += pjRow('Fixed Assets (net of depreciation)', v(y => y.bs.fixedAssetsNet), { indent: true });
    html += pjRow('Cash at Hand & Bank', v(y => y.bs.cash), { indent: true });
    html += pjRow('Sundry Debtors', v(y => y.bs.debtors), { indent: true });
    html += pjRow('Closing Stock', v(y => y.bs.closingStock), { indent: true });
    html += pjRow('Total Current Assets', v(y => y.bs.totalCurrentAssets), { bold: true });
    html += pjRow('Sundry Creditors', v(y => y.bs.creditors), { indent: true });
    html += pjRow('Provision for Tax', v(y => y.bs.provisionTax), { indent: true });
    html += pjRow('Expenses Payable', v(y => y.bs.expPayable), { indent: true });
    html += pjRow('TDS Payable', v(y => y.bs.tdsPayable), { indent: true });
    html += pjRow('Short Term Loan / OD / CC', v(y => y.bs.shortTermLoan), { indent: true });
    html += pjRow('Total Current Liabilities', v(y => y.bs.totalCurrentLiabilities), { bold: true });
    html += pjRow('Net Current Assets', v(y => y.bs.netCurrentAssets), { bold: true });
    html += pjRow('Total Uses of Funds', v(y => y.bs.totalUses), { bold: true });
    wrap.innerHTML = pjStatementTable('Projected Balance Sheet (as at ' + Y.map(yr => pjAsAt(yr.year)).join(' · ') + ')', fyCols, html);

  } else if (pjStatementView === 'cf') {
    let html = '';
    html += pjRow('A. Cash flow from Operating Activities', Y.map(() => ''), { bold: true });
    html += pjRow('Net Profit before interest & tax', v(y => y.cf.pbtPlusInterest), { indent: true });
    html += pjRow('Depreciation', v(y => y.cf.depreciation), { indent: true });
    html += pjRow('Income tax', v(y => y.cf.incomeTax), { indent: true });
    html += pjRow('Increase/(Decrease) in Working Capital', v(y => y.cf.deltaCurrentAssets + y.cf.deltaCurrentLiabilities), { indent: true });
    html += pjRow('Net cash from Operating Activities', v(y => y.cf.operating), { bold: true });
    html += pjRow('B. Cash flow from Investing Activities', Y.map(() => ''), { bold: true });
    html += pjRow('Purchase of Fixed Assets', v(y => y.cf.capex), { indent: true });
    html += pjRow('Liquidated non-current investments', v(y => y.cf.liquidatedNC), { indent: true });
    html += pjRow('Net cash from Investing Activities', v(y => y.cf.investing), { bold: true });
    html += pjRow('C. Cash flow from Financing Activities', Y.map(() => ''), { bold: true });
    html += pjRow('Issuance of Share/Additional Capital', v(y => y.cf.capitalIssued), { indent: true });
    html += pjRow('Dividend/Withdrawal', v(y => y.cf.dividend), { indent: true });
    html += pjRow('Payment of Interest', v(y => y.cf.interestPaid), { indent: true });
    html += pjRow('Increase/(Decrease) in Director Lending', v(y => y.cf.deltaDirector), { indent: true });
    html += pjRow('Increase/(Decrease) in Bank Loans', v(y => y.cf.deltaLoans), { indent: true });
    html += pjRow('Net cash from Financing Activities', v(y => y.cf.financing), { bold: true });
    html += pjRow('Increase/(Decrease) in cash (A+B+C)', v(y => y.cf.netChange), { bold: true });
    html += pjRow('Opening cash & bank', v(y => y.cf.openingCash));
    html += pjRow('Closing cash & bank', v(y => y.cf.closingCash), { bold: true });
    wrap.innerHTML = pjStatementTable('Projected Cash Flow', fyCols, html);

  } else if (pjStatementView === 'dep') {
    wrap.innerHTML = Y.map(yr => {
      const rows = yr.dep.rows.map(r => `<tr>
        <td>${escHtml(r.name)}</td><td style="text-align:right;">${pjAmt(r.opening)}</td>
        <td style="text-align:right;">${pjAmt(r.addition)}</td><td style="text-align:right;">${pjAmt(r.disposal)}</td>
        <td style="text-align:right;">${pjAmt(r.total)}</td><td style="text-align:right;">${(r.rate * 100).toFixed(r.rate === 0.07 ? 0 : 0)}%</td>
        <td style="text-align:right;">${pjAmt(r.dep)}</td><td style="text-align:right;">${pjAmt(r.closing)}</td></tr>`).join('');
      return `<h4 style="margin:14px 0 8px; font-size:13.5px; color:var(--brand-navy);">Depreciation — F.Y. ${escHtml(pjFyDot(yr.year))}</h4>
        <table class="client-table"><thead><tr><th>Particulars</th><th style="text-align:right;">Opening</th><th style="text-align:right;">Additional</th><th style="text-align:right;">Sales</th><th style="text-align:right;">Total</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Depreciation</th><th style="text-align:right;">Balance</th></tr></thead>
        <tbody>${rows}<tr style="font-weight:700;"><td>Total</td><td style="text-align:right;">${pjAmt(yr.dep.opening)}</td><td style="text-align:right;">${pjAmt(yr.dep.addition)}</td><td style="text-align:right;">${pjAmt(yr.dep.disposal)}</td><td style="text-align:right;">${pjAmt(yr.dep.total)}</td><td></td><td style="text-align:right;">${pjAmt(yr.dep.dep)}</td><td style="text-align:right;">${pjAmt(yr.dep.closing)}</td></tr></tbody></table>`;
    }).join('');

  } else if (pjStatementView === 'ird') {
    const ird = pjResult.ird;
    const labels = [
      ['grossIncome', 'कुल आम्दानी (Gross Income)'], ['pbt', 'कर अगाडिको खुद मुनाफा/नोक्सानी (Net Profit/Loss Before Tax)'],
      ['tax', 'आयकर दायित्व (Tax Liability)'], ['paidUpCapital', 'चुक्ता पुँजी (Paid up Capital)'],
      ['reserves', 'जगेडा (Reserve)'], ['bankLoan', 'ऋण (Loan from Bank & Financial Institution)'],
      ['currentLiabilities', 'चालु दायित्व (Current Liabilities)'], ['provision', 'व्यवस्था (Provision)'],
      ['currentAssets', 'चालु सम्पत्ति (Current Assets)'], ['fixedAssets', 'स्थिर सम्पत्ति (Fixed Assets)'],
    ];
    wrap.innerHTML = `<table class="client-table"><thead><tr><th>विवरण</th>
      <th style="text-align:right;">आ.व. ${escHtml(pjFyLabel(0))} (Audited/Provisional)</th>
      <th style="text-align:right;">आ.व. ${escHtml(pjFyLabel(1))} (Projected)</th></tr></thead>
      <tbody>${labels.map(([k, label]) =>
        `<tr><td>${escHtml(label)}</td><td style="text-align:right;">${pjAmt(ird.audited[k])}</td><td style="text-align:right;">${ird.projected ? pjAmt(ird.projected[k]) : '–'}</td></tr>`).join('')}
      </tbody></table>`;
  }
}

// ── Section switching ──

function pjShowSection(name) {
  ['upload', 'assumptions', 'review'].forEach(s => {
    pjEl('pj-section-' + s).style.display = s === name ? '' : 'none';
    pjEl('pj-step-' + s).classList.toggle('active', s === name);
  });
  if (name === 'review' && pjModel && !pjResult) pjRun(false);
}

// ── Persistence (projection_reports) ──
// One row per saved projection: the parsed model + assumptions (`inputs`,
// enough to re-run the engine exactly) and the computed output (`computed`).
// Re-saving in the same session updates the existing row.

async function pjSave() {
  if (!pjResult || !pjModel) return;
  if (pjIssues.some(i => i.level === 'error')) { pjStatus('Fix the validation errors before saving.', 'error'); return; }
  // Who did the work is the point of the New Task / Updation split — a saved
  // record with no name attached can't answer "who ran this projection?",
  // which is exactly the question it exists to answer.
  const staff = pjStaffName();
  if (!staff) { pjStatus('Choose the staff member performing this task before saving (Step 2 → Task).', 'error'); return; }

  const company = pjEl('pj-company').value || pjModel.company.name;
  const updating = pjTaskMode === 'update' && pjSavedId;
  try {
    pjStatus(updating ? 'Updating saved projection…' : 'Saving projection…', 'searching');
    const row = {
      client_id: pjSelectedClient ? pjSelectedClient.id : null,
      company_name: company,
      pan: pjEl('pj-pan').value || null,
      fiscal_year_base: pjFyLabel(0),
      years: pjResult.years.length,
      // `ui` carries the two Step-1/2 choices that are read straight from the
      // DOM at export time rather than living in the assumptions object, so
      // reloading this record restores the same report, not a default one.
      inputs: {
        parsedModel: pjModel,
        assumptions: pjResult.asm,
        ui: { statementType: pjEl('pj-statement-type').value, baseFy: pjEl('pj-base-fy').value },
      },
      computed: { years: pjResult.years, ird: pjResult.ird },
      performed_by: staff,
    };
    let resp;
    if (updating) {
      // created_by is deliberately NOT in the payload on an update — it is
      // who first created the record, and an updation must not rewrite it.
      resp = await window.sb.from('projection_reports').update(row).eq('id', pjSavedId).select('*').single();
    } else {
      row.created_by = (window.currentUser && window.currentUser.email) || null;
      resp = await window.sb.from('projection_reports').insert(row).select('*').single();
    }
    if (resp.error) throw resp.error;
    pjSavedId = resp.data.id;
    // A saved record is by definition updatable from here on, so the next
    // Save revises this row instead of creating a second one.
    pjLoadedRow = resp.data;
    pjSetTaskMode('update');
    // Re-render so the action button stops saying "Save to Database" the
    // instant the record exists — the next press updates it, and the button
    // is the only thing on screen that says which.
    pjRenderReview();
    await pjLoadSavedForClient();
    pjStatus(updating
      ? `Projection #${pjSavedId} updated by ${escHtml(staff)}.`
      : `Projection saved (record #${pjSavedId}) by ${escHtml(staff)}.`, 'success');
    AuditLog.record('projection_saved', {
      module: 'projection', clientName: company, status: 'success', recordRef: pjSavedId,
      detail: { years: pjResult.years.length, taskMode: updating ? 'update' : 'new', staff },
    });
  } catch (e) {
    console.error(e);
    pjStatus('Save failed: ' + escHtml(e.message), 'error');
  }
}

// pjDownloadExcel / pjDownloadPdf live in js/projectionExport.js
