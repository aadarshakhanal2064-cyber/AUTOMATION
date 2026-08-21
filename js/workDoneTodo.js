// ════════════════════════════════════════════
//  WORK DONE → TO-DO LIST
//  The third view beside Work Records and Pending List.
//
//  Its own file rather than more of workDone.js, which is already ~1,500
//  lines (CLAUDE.md §10 rule 5). It registers itself onto that file's
//  WD_VIEWS array and otherwise leaves it alone — the same idiom as
//  salesPurchaseBookConfirm.js pushing onto SPB_SECTION_TABS, which is why
//  the <script> tag must come AFTER workDone.js in index.html.
//
//  WHY A THIRD VIEW AND A THIRD TABLE. The other two answer questions about
//  work the firm has already committed to a record:
//    · Work Records — one page per client per fiscal year, catalogue rows.
//    · Pending List — derived, never typed, a join over document_register.
//  Neither can hold "ring the client about the missing Falgun bills before
//  Thursday": short-lived, free-typed, possibly not against a catalogue work
//  type, possibly not against a fiscal year, and quite possibly six at once
//  for the same client — which work_done's UNIQUE (client_id, fiscal_year)
//  forbids outright. So work_todos is one row per task and nothing else.
//
//  THREE THINGS MAKE THIS A TO-DO LIST RATHER THAN A FORM:
//
//  1. ADDING ONE TAKES ONE LINE, NOT A DRAWER. Every other module in this app
//     opens a drawer to create a record, which is right for a service memo
//     and wrong for "call Ram about the bank statement". The quick-add bar is
//     the primary surface; Enter in the description box files the task. The
//     client, date and staff boxes stay filled after an add, because people
//     add three tasks for one client in a row, and re-picking the client each
//     time is what makes staff stop using the list.
//
//  2. EVERYTHING SAVES ITSELF. There is no Save button anywhere in this view.
//     A to-do list you have to remember to save is a to-do list that loses
//     work. Selects and dates save on change; text saves on `change`, which
//     the browser fires on blur only if the value actually differs — so
//     typing never round-trips per keystroke, and `oninput` only ever touches
//     the in-memory model. That last part is load-bearing: re-rendering while
//     someone is typing throws away focus and caret position, the exact bug
//     Autobooks' confirmation grid was built to avoid (CLAUDE.md §15).
//
//  3. IT SORTS ITSELF BY WHAT'S ACTUALLY LATE. Sections are Overdue → Due
//     Today → This Week → Later → No Due Date → Completed, not insertion
//     order. Undated tasks get their own section rather than being hidden or
//     counted as overdue — "someday" is a real category, and a list that
//     forces a due date just gets fake dates typed into it.
//
//  STATUS IS STORED HERE, and that is not a violation of the "derive, never
//  store" rule the neighbouring modules follow (§15). They derive because the
//  underlying fact already exists elsewhere and a stored copy could drift from
//  it. A to-do has no underlying fact — its state IS the record. The three
//  keys are window.WD_STATES verbatim so the firm reads one vocabulary across
//  all three views, and completed_at is CHECK-tied to status in Postgres so a
//  reopened task can never keep a stale completion stamp.
//
//  Migration: db/2026-08-17_work_todos.sql
// ════════════════════════════════════════════

// Sections, in display order. `key` is what wtDueClass() returns.
const WT_SECTIONS = [
  { key: 'overdue', label: 'Overdue',       icon: '🔴', tone: 'overdue' },
  { key: 'today',   label: 'Due Today',     icon: '🟠', tone: 'today' },
  { key: 'week',    label: 'Due This Week', icon: '🔵', tone: 'week' },
  { key: 'later',   label: 'Later',         icon: '📅', tone: 'later' },
  { key: 'none',    label: 'No Due Date',   icon: '⚪', tone: 'none' },
  { key: 'done',    label: 'Completed',     icon: '✅', tone: 'done' },
];

// "This week" is the next 7 days, not the calendar week — a task due Monday
// shouldn't drop out of the near-term section just because Sunday passed.
const WT_SOON_DAYS = 7;

// Stat cards, which double as the due-based quick filter. The dropdown
// filters below cover staff/status/priority, so the cards deliberately cover
// the axis they don't: how urgent it is.
const WT_BUCKETS = {
  open:    { label: 'Open',       test: t => t.status !== 'done' },
  overdue: { label: 'Overdue',    test: t => t.status !== 'done' && wtDueClass(t) === 'overdue' },
  today:   { label: 'Due Today',  test: t => t.status !== 'done' && wtDueClass(t) === 'today' },
  done:    { label: 'Completed',  test: t => t.status === 'done' },
};

const WT_FILTERS_EMPTY = { staff: '', status: '', priority: '' };

let wtTodos = [];
let wtInitDone = false;
let wtLoaded = false;
let wtQuickClient = null;                 // client picked from the quick-add autocomplete
let wtBucket = 'open';
let wtFilters = { ...WT_FILTERS_EMPTY };
// Sections the user has folded. Nothing is folded by default: the Open bucket
// already excludes completed work, so the unbounded section that would have
// justified it never renders alongside the open work anyway. Folding stays
// available for "Later" and "No Due Date", which are the two that get long —
// and a folded section keeps its heading and its count, so it is never a
// hidden row set (the Autobooks confirmation-tier rule).
let wtCollapsed = new Set();

function wtEl(id) { return document.getElementById(id); }
function wtUserEmail() { return (window.currentUser && window.currentUser.email) || null; }
function wtToday() { return NepaliLocale.todayISO(); }
function wtStatus(html, type) { showStatus(html, type, 'wt-status-area'); }
function wtFind(id) { return wtTodos.find(t => t.id === id); }

function wtPriorityMeta(key) {
  return (window.WD_TODO_PRIORITIES || []).find(p => p.key === key) ||
         (window.WD_TODO_PRIORITIES || [])[1] || { key: 'normal', label: 'Normal', icon: '' };
}
function wtStateMeta(key) {
  return window.WD_STATES.find(s => s.key === key) || window.WD_STATES[0];
}

// ── Due-date maths ──
// ISO date strings compare correctly as strings, so no Date parsing is needed
// for the ordering; the day count does need it.
function wtDaysUntil(due) {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.round((d - new Date(wtToday() + 'T00:00:00')) / 86400000);
}

function wtDueClass(t) {
  if (t.status === 'done') return 'done';
  if (!t.due_date) return 'none';
  const n = wtDaysUntil(t.due_date);
  if (n == null) return 'none';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return n <= WT_SOON_DAYS ? 'week' : 'later';
}

// "3 days late" / "in 4 days" reads faster than a bare date when triaging,
// so the row shows both.
function wtDueText(t) {
  const n = wtDaysUntil(t.due_date);
  if (n == null) return '';
  if (t.status === 'done') return '';
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} late`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

// ── Init / load ──
// The date box says "today", and wtInit() runs once — so a tab left open
// overnight would keep offering yesterday, which is the same class of bug as
// File In Out's and Autobooks' stale fiscal-year defaults (CLAUDE.md §15).
// wtAutoDate remembers the value this function last wrote, so re-seeding on
// every open can tell an untouched box from a date the user chose on purpose
// and must not overwrite.
let wtAutoDate = '';
function wtSeedQuickDate() {
  const el = wtEl('wt-q-date');
  if (!el) return;
  if (el.value && el.value !== wtAutoDate) return;   // deliberately set — leave it
  wtAutoDate = wtToday();
  el.value = wtAutoDate;
}

function wtInit() {
  if (wtInitDone) { wtSeedQuickDate(); return; }
  SearchEngine.attachAutocomplete(wtEl('wt-q-client'), wtEl('wt-q-client-autocomplete'), {
    getList: () => window.clientsList,
    keys: ['name', 'pan'],
    renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
    onSelect: c => { wtQuickClient = c; wtEl('wt-q-client').value = c.name; },
  });
  wtSeedQuickDate();
  wtEl('wt-q-priority').innerHTML = (window.WD_TODO_PRIORITIES || [])
    .map(p => `<option value="${escHtml(p.key)}" ${p.key === 'normal' ? 'selected' : ''}>${escHtml(p.icon + ' ' + p.label)}</option>`).join('');
  wtEl('wt-filter-status').innerHTML = '<option value="">All Statuses</option>' +
    window.WD_STATES.map(s => `<option value="${escHtml(s.key)}">${escHtml(s.label)}</option>`).join('');
  wtEl('wt-filter-priority').innerHTML = '<option value="">All Priorities</option>' +
    (window.WD_TODO_PRIORITIES || []).map(p => `<option value="${escHtml(p.key)}">${escHtml(p.label)}</option>`).join('');
  wtInitDone = true;
}

async function wtLoad() {
  wtInit();
  try {
    // sbFetchAll, not a bare select: this table only grows, and PostgREST
    // caps a single select at 1000 rows (CLAUDE.md §6). Ordered by id so the
    // paging is stable; display order is computed below, not asked of the
    // database.
    wtTodos = await sbFetchAll(() => window.sb.from('work_todos')
      .select('*').order('id', { ascending: true }));
    wtLoaded = true;
    wtPopulateDatalists();
    wtRender();
  } catch (e) {
    wtStatus('❌ Failed to load the to-do list: ' + escHtml(e.message || String(e)), 'error');
  }
}

// Three typeable combo boxes, each backed by a datalist rather than a closed
// dropdown — the bbPopulateExpenseNames idiom (Bank Entry), which stops the
// vocabulary fragmenting on near-duplicate spellings without ever refusing a
// value the firm actually needs.
//
// Staff deliberately does NOT use the select + "Other" pattern Work Done's
// own rows use. That pattern needs a second revealed input per row and the
// transient _other flag that has now shipped as a bug twice (Audit Checklist,
// then Work Done); a datalist gets the same result with neither. ARF_STAFF is
// still the source, so adding a staff member remains one config edit.
function wtPopulateDatalists() {
  const fill = (id, values) => {
    const el = wtEl(id);
    if (!el) return;
    el.innerHTML = Array.from(new Set(values.filter(v => String(v || '').trim())))
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map(v => `<option value="${escHtml(v)}"></option>`).join('');
  };
  fill('wt-staff-datalist', window.ARF_STAFF.filter(s => s !== 'Other').concat(wtTodos.map(t => t.assigned_to)));
  fill('wt-client-datalist', (window.clientsList || []).map(c => c.name));
  // The 16 catalogue work types plus anything already typed — so a to-do that
  // later becomes a Work Records row is likely to be spelled the same way.
  fill('wt-nature-datalist', window.WD_WORK_TYPES.map(t => t.label).concat(wtTodos.map(t => t.nature_of_work)));
}

// ── Client resolution ──
// A typed name that exactly matches a directory client (case-insensitively)
// keeps its client_id and PAN; anything else is kept as free text with a null
// id. That is what lets an internal task ("renew the firm registration") and
// a walk-in be recorded at all, which work_done's NOT NULL client_id forbids.
// Always assigns every field (CLAUDE.md §9) — a conditional assignment here
// would leave the previous client's PAN standing against a new name.
function wtResolveClient(name) {
  const typed = String(name || '').trim();
  if (!typed) return { client_id: null, client_name: null, client_pan: null };
  const match = (window.clientsList || [])
    .find(c => String(c.name || '').trim().toLowerCase() === typed.toLowerCase());
  return match
    ? { client_id: match.id, client_name: match.name, client_pan: match.pan || null }
    : { client_id: null, client_name: typed, client_pan: null };
}

// ── Quick add ──
function wtQuickKey(e) { if (e.key === 'Enter') { e.preventDefault(); wtQuickAdd(); } }

async function wtQuickAdd() {
  const natureEl = wtEl('wt-q-nature');
  const nature = natureEl.value.trim();
  if (!nature) { wtStatus('Type what needs doing, then press Enter.', 'info'); natureEl.focus(); return; }

  const email = wtUserEmail();
  const payload = {
    task_date: wtEl('wt-q-date').value || wtToday(),
    ...wtResolveClient(wtEl('wt-q-client').value),
    nature_of_work: nature,
    due_date: wtEl('wt-q-due').value || null,
    assigned_to: wtEl('wt-q-staff').value.trim() || null,
    priority: wtEl('wt-q-priority').value || 'normal',
    status: 'not_started',
    completed_at: null,
    created_by: email,
    updated_by: email,
  };

  wtStatus('<span class="spinner spinner-navy"></span> Adding…', 'searching');
  try {
    const { data, error } = await window.sb.from('work_todos').insert(payload).select('*').single();
    if (error) throw error;
    wtTodos.push(data);
    // recordRef is a BIGINT column — a descriptive string there kills the whole
    // event, not just the reference (CLAUDE.md §15). Everything descriptive
    // goes in detail, and the keys are camelCase or they're silently dropped.
    AuditLog.record('wd_todo_created', {
      module: 'workDone', clientName: payload.client_name, recordRef: data.id,
      detail: { natureOfWork: nature, dueDate: payload.due_date, assignedTo: payload.assigned_to },
    });
    // Client, date and staff stay filled: adding several tasks for one client
    // in a row is the common case, and re-picking each time is what makes
    // people stop using the list. What describes THIS task is cleared.
    natureEl.value = '';
    wtEl('wt-q-due').value = '';
    wtEl('wt-q-priority').value = 'normal';
    wtPopulateDatalists();
    wtRender();
    wtEl('wt-status-area').innerHTML = '';
    natureEl.focus();
  } catch (e) {
    wtStatus('❌ Could not add the to-do: ' + escHtml(e.message || String(e)), 'error');
  }
}

function wtClearQuickAdd() {
  wtQuickClient = null;
  // The date is blanked first so wtSeedQuickDate() re-fills it: its guard
  // deliberately refuses to overwrite a date the user picked, and Clear is
  // the one action that means "including that one".
  ['wt-q-client', 'wt-q-nature', 'wt-q-due', 'wt-q-staff', 'wt-q-date'].forEach(id => { wtEl(id).value = ''; });
  wtAutoDate = '';
  wtSeedQuickDate();
  wtEl('wt-q-priority').value = 'normal';
  wtEl('wt-status-area').innerHTML = '';
  wtEl('wt-q-nature').focus();
}

// ── Saving ──
// One choke point for every field edit, so the in-memory row, the database
// and the row's own save indicator can never disagree. A failed write reloads
// from the server rather than leaving the screen asserting a change that
// didn't land.
async function wtPatch(id, patch, rerender) {
  const t = wtFind(id);
  if (!t) return;
  Object.assign(t, patch);
  if (rerender) wtRender();
  wtFlash(id, 'saving');
  try {
    const { error } = await window.sb.from('work_todos')
      .update({ ...patch, updated_by: wtUserEmail() }).eq('id', id);
    if (error) throw error;
    wtFlash(id, 'saved');
  } catch (e) {
    wtStatus('❌ Could not save that change: ' + escHtml(e.message || String(e)) + ' — reloading.', 'error');
    await wtLoad();
  }
}

// A row-level tick rather than a status message per keystroke: the point of
// autosave is that it stays out of the way until it fails.
function wtFlash(id, state) {
  const el = document.querySelector(`.wt-row[data-id="${id}"] .wt-save`);
  if (!el) return;
  el.className = 'wt-save wt-save-' + state;
  el.textContent = state === 'saving' ? '…' : '✓';
  if (state === 'saved') setTimeout(() => { if (el.className === 'wt-save wt-save-saved') el.className = 'wt-save'; }, 1600);
}

// ── Field handlers ──
// Text fields: oninput touches ONLY the model (no save, no re-render, so the
// caret survives); onchange fires on blur when the value actually differs and
// is what persists. Selects and dates persist on change directly.

// What was in the box when editing started, so a REJECTED edit can be put
// back. Without this the rejection below re-renders from a model that
// oninput has already overwritten with the bad value, and paints it straight
// back — which is exactly how it first shipped.
let wtPristine = {};
function wtPristineKey(id, field) { return id + '|' + field; }
function wtOnFocus(id, field, value) { wtPristine[wtPristineKey(id, field)] = value; }

function wtOnText(id, field, value) {
  const t = wtFind(id);
  if (t) t[field] = value;
}

function wtCommitText(id, field, value) {
  const t = wtFind(id);
  if (!t) return;
  const clean = String(value || '').trim();
  if (field === 'nature_of_work' && !clean) {
    // The one required field. Putting the text back is kinder than saving a
    // nameless task — but only the snapshot can say what to put back.
    const prev = wtPristine[wtPristineKey(id, field)];
    if (prev == null) { wtStatus('A to-do needs a description — reloading.', 'info'); wtLoad(); return; }
    t[field] = prev;
    wtStatus('A to-do needs a description — the previous text has been kept.', 'info');
    wtRender();
    return;
  }
  wtPatch(id, { [field]: clean || null }, false);
}

function wtCommitClient(id, value) {
  wtPatch(id, wtResolveClient(value), false).then(wtPopulateDatalists);
}

function wtOnStatusChange(id, value) {
  const t = wtFind(id);
  if (!t) return;
  // completed_at is CHECK-tied to status in Postgres: done ⇔ stamped. Sending
  // one without the other is rejected by the database, which is the point —
  // a reopened task can never keep a stale completion stamp.
  const patch = { status: value, completed_at: value === 'done' ? new Date().toISOString() : null };
  wtPatch(id, patch, true);
  if (value === 'done') {
    AuditLog.record('wd_todo_completed', {
      module: 'workDone', clientName: t.client_name, recordRef: id,
      detail: { natureOfWork: t.nature_of_work, assignedTo: t.assigned_to },
    });
  }
}

function wtOnDueChange(id, value) { wtPatch(id, { due_date: value || null }, true); }
function wtOnPriorityChange(id, value) { wtPatch(id, { priority: value }, true); }
function wtOnStaffChange(id, value) {
  wtPatch(id, { assigned_to: String(value || '').trim() || null }, false).then(wtPopulateDatalists);
}

// One-click complete, because reaching for a dropdown to tick something off
// is the single most-repeated action on this screen.
function wtToggleDone(id) {
  const t = wtFind(id);
  if (!t) return;
  wtOnStatusChange(id, t.status === 'done' ? 'not_started' : 'done');
}

async function wtDelete(id) {
  const t = wtFind(id);
  if (!t) return;
  if (!confirm(`Delete this to-do?\n\n${t.nature_of_work}${t.client_name ? '\n' + t.client_name : ''}\n\nThis cannot be undone.`)) return;
  try {
    const { error } = await window.sb.from('work_todos').delete().eq('id', id);
    if (error) throw error;
    AuditLog.record('wd_todo_deleted', {
      module: 'workDone', clientName: t.client_name, recordRef: id,
      detail: { natureOfWork: t.nature_of_work },
    });
    wtTodos = wtTodos.filter(x => x.id !== id);
    wtRender();
  } catch (e) {
    wtStatus('❌ Could not delete that to-do: ' + escHtml(e.message || String(e)), 'error');
  }
}

// ── Filters ──
function wtReadFilters() {
  wtFilters = {
    staff: wtEl('wt-filter-staff').value.trim(),
    status: wtEl('wt-filter-status').value,
    priority: wtEl('wt-filter-priority').value,
  };
}

// Shared by the on-screen list AND the exports, so what leaves the app is
// always what was on screen (the fmFilteredRows / wdCurrentFilteredRows idiom).
function wtFilteredRows() {
  const bucket = WT_BUCKETS[wtBucket] || WT_BUCKETS.open;
  let rows = wtTodos.filter(t => {
    if (!bucket.test(t)) return false;
    if (wtFilters.staff && (t.assigned_to || '') !== wtFilters.staff) return false;
    if (wtFilters.status && t.status !== wtFilters.status) return false;
    if (wtFilters.priority && t.priority !== wtFilters.priority) return false;
    return true;
  });
  const q = (wtEl('wt-search').value || '').trim();
  if (q) {
    const fuse = SearchEngine.buildIndex(rows, ['nature_of_work', 'client_name', 'client_pan', 'remarks', 'assigned_to']);
    rows = fuse.search(q).map(r => r.item);
  }
  return rows;
}

function wtOnFilterChange() { wtReadFilters(); wtRender(); }

function wtSetBucket(key) {
  wtBucket = key;
  // A card is a fresh start — leaving stale dropdowns applied would show
  // fewer rows than the number just clicked (the wdSetFilter rule).
  wtResetFilterInputs();
  wtRender();
}

function wtResetFilterInputs() {
  ['wt-filter-staff', 'wt-filter-status', 'wt-filter-priority', 'wt-search'].forEach(id => {
    const el = wtEl(id); if (el) el.value = '';
  });
  wtFilters = { ...WT_FILTERS_EMPTY };
}

function wtClearFilters() {
  wtResetFilterInputs();
  wtBucket = 'open';
  wtRender();
}

function wtToggleSection(key) {
  if (wtCollapsed.has(key)) wtCollapsed.delete(key); else wtCollapsed.add(key);
  wtRender();
}

// ── Ordering ──
// Soonest due first, then most urgent, then oldest task — the order someone
// clearing a backlog actually works in. Undated tasks sort last within their
// own section rather than being interleaved with dated ones.
function wtSortRows(rows) {
  const pri = { high: 0, normal: 1, low: 2 };
  return rows.slice().sort((a, b) => {
    const ad = a.due_date || '9999-99-99', bd = b.due_date || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ap = pri[a.priority] ?? 1, bp = pri[b.priority] ?? 1;
    if (ap !== bp) return ap - bp;
    return String(a.task_date || '').localeCompare(String(b.task_date || '')) || (a.id - b.id);
  });
}

// Completed reads newest-first: the useful question about finished work is
// "what did we get through recently", not "what did we finish first".
function wtSortDone(rows) {
  return rows.slice().sort((a, b) =>
    String(b.completed_at || '').localeCompare(String(a.completed_at || '')) || (b.id - a.id));
}

// ── Rendering ──
function wtRender() {
  wtRenderStats();
  wtRenderBadge();
  wtRenderList();
}

function wtRenderStats() {
  const grid = wtEl('wt-stat-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(WT_BUCKETS).map(([key, b]) => {
    const n = wtTodos.filter(b.test).length;
    const alarm = key === 'overdue' && n ? ' wt-stat-alarm' : '';
    return `<div class="stat-card clickable${alarm} ${wtBucket === key ? 'active-filter' : ''}" onclick="wtSetBucket('${key}')" title="Show only these — clears the filters below">
      <div class="stat-num">${n}</div>
      <div class="stat-label">${escHtml(b.label)}</div>
    </div>`;
  }).join('');
}

// The toggle button carries the open count, matching "Pending List (9)". The
// dot is the alarm: a number alone can't say that six of the twelve are late.
function wtRenderBadge() {
  const el = wtEl('wt-todo-count');
  if (!el) return;
  const open = wtTodos.filter(WT_BUCKETS.open.test).length;
  const late = wtTodos.filter(WT_BUCKETS.overdue.test).length;
  el.innerHTML = (open ? ` (${open})` : '') +
    (late ? `<span class="wt-alarm-dot" title="${late} overdue"></span>` : '');
}

function wtRowHtml(t) {
  const due = wtDueClass(t);
  const st = wtStateMeta(t.status);
  const pri = wtPriorityMeta(t.priority);
  const dueNote = wtDueText(t);

  const stateOptions = window.WD_STATES.map(s =>
    `<option value="${escHtml(s.key)}" ${t.status === s.key ? 'selected' : ''}>${escHtml(s.icon + ' ' + s.label)}</option>`).join('');
  const priOptions = (window.WD_TODO_PRIORITIES || []).map(p =>
    `<option value="${escHtml(p.key)}" ${t.priority === p.key ? 'selected' : ''}>${escHtml(p.icon + ' ' + p.label)}</option>`).join('');

  const stamp = t.status === 'done' && t.completed_at
    ? `<span class="wt-done-stamp" title="Completed">${escHtml(String(t.completed_at).slice(0, 10))}</span>` : '';

  return `
    <div class="wt-row due-${escHtml(due)} pri-${escHtml(t.priority || 'normal')}" data-id="${t.id}">
      <button type="button" class="wt-tick ${t.status === 'done' ? 'is-done' : ''}"
              onclick="wtToggleDone(${t.id})"
              title="${t.status === 'done' ? 'Reopen this to-do' : 'Mark done'}"
              aria-label="${t.status === 'done' ? 'Reopen this to-do' : 'Mark done'}">${t.status === 'done' ? '✓' : ''}</button>

      <select class="wt-state" onchange="wtOnStatusChange(${t.id}, this.value)" title="${escHtml(st.label)}">${stateOptions}</select>

      <div class="wt-main">
        <input type="text" class="wt-nature" list="wt-nature-datalist" value="${escHtml(t.nature_of_work || '')}"
               placeholder="What needs doing"
               onfocus="wtOnFocus(${t.id}, 'nature_of_work', this.value)"
               oninput="wtOnText(${t.id}, 'nature_of_work', this.value)"
               onchange="wtCommitText(${t.id}, 'nature_of_work', this.value)" />
        <input type="text" class="wt-client" list="wt-client-datalist" value="${escHtml(t.client_name || '')}"
               placeholder="Client (optional)"
               oninput="wtOnText(${t.id}, 'client_name', this.value)"
               onchange="wtCommitClient(${t.id}, this.value)" />
      </div>

      <input type="text" class="wt-staff" list="wt-staff-datalist" value="${escHtml(t.assigned_to || '')}"
             placeholder="Staff"
             oninput="wtOnText(${t.id}, 'assigned_to', this.value)"
             onchange="wtOnStaffChange(${t.id}, this.value)" />

      <div class="wt-due-cell">
        <input type="date" class="wt-due" value="${escHtml(t.due_date || '')}" onchange="wtOnDueChange(${t.id}, this.value)" />
        ${dueNote ? `<span class="wt-due-note">${escHtml(dueNote)}</span>` : stamp}
      </div>

      <select class="wt-pri" onchange="wtOnPriorityChange(${t.id}, this.value)" title="Priority: ${escHtml(pri.label)}">${priOptions}</select>

      <input type="text" class="wt-remarks" value="${escHtml(t.remarks || '')}" placeholder="Remarks"
             oninput="wtOnText(${t.id}, 'remarks', this.value)"
             onchange="wtCommitText(${t.id}, 'remarks', this.value)" />

      <span class="wt-save"></span>
      <button type="button" class="btn btn-outline btn-sm wt-del" onclick="wtDelete(${t.id})" title="Delete this to-do">🗑</button>
    </div>`;
}

function wtRenderList() {
  const wrap = wtEl('wt-list');
  if (!wrap) return;

  if (!wtLoaded) { wrap.innerHTML = '<div class="log-empty">Loading…</div>'; return; }

  const rows = wtFilteredRows();
  if (!rows.length) {
    // "Nothing here" and "nothing matches what you asked for" are different
    // answers, and only one of them means the list is empty.
    const anyAtAll = wtTodos.length > 0;
    wrap.innerHTML = anyAtAll
      ? `<div class="log-empty">No to-dos match these filters. <button class="btn btn-outline btn-sm" onclick="wtClearFilters()">Clear filters</button></div>`
      : '<div class="log-empty">Nothing on the list yet — type what needs doing in the bar above and press <strong>Enter</strong>. A to-do doesn\'t need a client or a due date; both are optional.</div>';
    return;
  }

  const bySection = {};
  rows.forEach(t => { (bySection[wtDueClass(t)] = bySection[wtDueClass(t)] || []).push(t); });

  wrap.innerHTML = WT_SECTIONS.map(sec => {
    const list = bySection[sec.key];
    if (!list || !list.length) return '';
    const folded = wtCollapsed.has(sec.key);
    const ordered = sec.key === 'done' ? wtSortDone(list) : wtSortRows(list);
    return `
      <div class="wt-section tone-${escHtml(sec.tone)}">
        <button type="button" class="wt-section-head" onclick="wtToggleSection('${sec.key}')" aria-expanded="${!folded}">
          <span class="wt-caret">${folded ? '▸' : '▾'}</span>
          <span class="wt-section-title">${sec.icon} ${escHtml(sec.label)}</span>
          <span class="wt-section-count">${list.length}</span>
        </button>
        ${folded ? '' : `<div class="wt-rows">${ordered.map(wtRowHtml).join('')}</div>`}
      </div>`;
  }).join('');
}

// ── Export ──
function wtBuildModel(rows) {
  const subtitles = [`${WT_BUCKETS[wtBucket].label} to-dos, soonest due first`, `Generated ${wtToday()}`];
  if (wtFilters.staff) subtitles.push(`Staff: ${wtFilters.staff}`);
  if (wtFilters.status) subtitles.push(`Status: ${wtStateMeta(wtFilters.status).label}`);
  if (wtFilters.priority) subtitles.push(`Priority: ${wtPriorityMeta(wtFilters.priority).label}`);

  // Grouped exactly as the screen groups them, with the section named on each
  // row — a printed copy sorted differently from the screen is a printed copy
  // nobody trusts.
  const ordered = [];
  WT_SECTIONS.forEach(sec => {
    const list = rows.filter(t => wtDueClass(t) === sec.key);
    (sec.key === 'done' ? wtSortDone(list) : wtSortRows(list)).forEach(t => ordered.push({ t, sec }));
  });

  return {
    title: 'Work Done — To-Do List',
    subtitleLines: subtitles,
    landscape: true,
    columns: [
      { label: 'When', w: 1.4 }, { label: 'Date', w: 1.0 }, { label: 'Client', w: 1.9 },
      { label: 'Nature of Work', w: 2.4 }, { label: 'Due', w: 1.0 }, { label: 'Due In', w: 1.0 },
      { label: 'Status', w: 1.05 }, { label: 'Priority', w: 0.85 }, { label: 'Staff', w: 1.1 },
      { label: 'Remarks', w: 2.0 },
    ],
    rows: ordered.map(({ t, sec }) => ({ cells: [
      sec.label, t.task_date || '—', t.client_name || '—',
      t.nature_of_work || '—', t.due_date || '—', wtDueText(t) || '—',
      wtStateMeta(t.status).label, wtPriorityMeta(t.priority).label, t.assigned_to || '—',
      t.remarks || '—',
    ] })),
    _filename: 'Work Done - To-Do List',
  };
}

// ── Register with Work Done's view toggle ──
// Nothing in workDone.js knows this view exists; it supplies its own pane,
// its own refresh and its own export model (see WD_VIEWS there).
wdRegisterView({
  id: 'todo',
  btnId: 'wd-view-todo',
  paneId: 'wd-todo-view',
  table: () => null,               // a grid of live inputs, not a Tabulator
  onShow: () => { wtInit(); if (!wtLoaded) wtLoad(); },
  onRefresh: () => wtLoad(),
  model: () => {
    wtReadFilters();
    const rows = wtFilteredRows();
    return rows.length ? wtBuildModel(rows) : null;
  },
  exportAs: { clientName: 'To-Do List', sheetName: 'To-Do List' },
});
