# Work Done (§5.23)

**Code:** `js/workDone.js` · **Prefix:** `wd-` · **Table:** `work_done`
**Where:** sidebar, after Audit Checklist · **Registry id:** `workDone`

Digitizes the firm's paper "Work done Module" sheet: one page per client per
fiscal year, a fixed list of work types (Sales Register, VAT Reco, Ann-13,
Financial Statement, VAT Return, ETDS, IRD Submission, …), each carrying who
did it, what state it's in, and remarks.

It exists because the firm's work happens in pieces, by several people, over
several days, and nothing recorded which pieces were finished — so work got
forgotten, redone, or started twice.

## Pipeline position

```
File In Out  →  Work Done  →  Audit Checklist  →  Audit Report Finalization
(paper in)      (work done)   (QC sign-off)       (filed with IRD)
```

Work Done was the missing middle step. It borrows Audit Checklist's
conventions throughout — same record grain, same derived status, same drawer,
same auto-match flags.

## The record model

**One record per `(client_id, fiscal_year)`**, enforced by a UNIQUE
constraint. `wdMatchExistingRecord()` watches the client and fiscal-year
fields and loads a matching record for editing the moment both are known, so
a save never collides with the constraint in normal use.

`client_id` is **NOT NULL, ON DELETE RESTRICT** — directory clients only, no
walk-in case like `document_register`.

### Why `items` is a JSONB array

```json
[{ "key": "sales_register", "label": "Sales Register", "state": "done",
   "staff": "Kesav", "remarks": "", "done_date": "2026-08-09", "custom": false }]
```

`window.WD_WORK_TYPES` (`js/config.js`) is the **catalogue** of work types —
16, in five display groups (Books & Records · VAT & Reconciliation · Financial
Statements · Returns & Filing · Review & Advisory). Adding a work type is a
config-array edit, no migration.

**A record holds only the rows it actually needs, not all 16.** The firm
doesn't do every job for every client, so seeding all sixteen made every
record a wall of irrelevant not-started rows and meant "Complete" could never
fire. Instead:

- **File-backed work is added automatically** from File In Out (below).
- **Everything else is added by hand** from the `+ Add work…` picker, which
  lists the grouped work types not already on the record.
- **Every row is removable**, including auto-added ones — the row set is the
  user's own selection of what this client needs.
- Rows carry `auto: true` when they came from a received file, shown as a 📁
  badge.

Rows are kept in catalogue order regardless of the order they were added
(`wdSortItems`), so a late addition still lands in its own group.

`state` is `not_started` / `in_progress` / `done` — **three states, not a
done-tick**, because "I'm on it" is what stops two staff starting the same
job, which is half the reason the module exists. `done_date` is stamped when
a row moves to Done and cleared when it moves back off.

`staff` holds a name from **`window.ARF_STAFF`** — deliberately reused rather
than copied, since it's the same three humans as Audit Report Finalization
and adding a person should stay one config edit. Choosing `Other` reveals a
free-text box whose typed name **replaces** `Other` in the saved value, so
there is no `*_other` field anywhere in `items`.

### Custom work rows

`+ Add Custom Work` appends an unlimited number of named rows, each with its
own state/staff/remarks and a remove button — replacing the paper sheet's
single "Other Specify" line. Same mechanism as Audit Checklist. A blank
custom label blocks save.

### `wdMergeItems()` on load

Stored rows are kept **exactly as saved** (labels re-read from config so a
wording fix propagates), plus any file-backed work File In Out has implied
since that the record doesn't carry yet.

It deliberately does **not** top the record up to the full catalogue — the row
set is the user's selection, so adding every work type back would undo that
choice on every open. Records written by the module's first version (which did
seed all 16) still load all 16 unchanged; nothing is truncated.

## Status is derived, never stored

There is no `status` column. `wdStatusKey(row)` reads `items[].state` every
time it's needed:

| Key | Badge | Condition |
|---|---|---|
| `not_started` | `badge-neutral` ⬜ | nothing done **and** nothing in progress |
| `in_progress` | `badge-amber` 🟡 | anything started but not everything done |
| `complete` | `badge-sent` ✅ | every row done |

Note the `not_started` rule differs from Audit Checklist's: a record with work
underway but nothing finished reads **In Progress**, not Not Started, because
that is the honest answer to "is anyone on this".

## The Pending List — the module's centrepiece

The firm's sheet marks exactly three work types as pending-eligible ("If file
is received and work is not done" against Sales Register / Purchase Register
/ Stock Book, and "Do not show in Pending list" against every other row).

Those work types map onto the document types File In Out already records
against `document_register`. So **"file is received" is answered by the
document register, not by a second checkbox**. Nothing is entered twice and
the list cannot go stale.

### What the live register actually contains (checked 2026-08-10)

The first version of this module was written against `FM_DOC_TYPES` and
verified with **seeded data matching that assumption**. Against the real seven
rows it returned nothing, for two reasons worth recording:

| Assumption | Reality |
|---|---|
| Intakes carry a fiscal year | `fiscal_year` is **null on every row** — it's an optional free-text box |
| Doc types are spelled as in `FM_DOC_TYPES` | Real values are `Purchase & Sales Files` ×4, `Others` ×3, `Ledger` ×3, `Bank Statement` ×2. **Sales Register / Purchase Register / Stock Book appear nowhere** — every row predates the 2026-08-09 picklist rework |

Both are handled rather than wished away:

- **`fileLabels` is a list, not one string.** The firm's register uses
  `Purchase & Sales Files` as a *single* item covering both registers, so one
  received document legitimately implies two jobs. Older vocabulary is mapped
  alongside current spellings instead of rewriting history.
- **An intake with no fiscal year is matched on client across all years** and
  shown as `FY —`, never excluded. The year being unrecorded is not a reason
  to hide a file that is demonstrably sitting in the office. A note above the
  list says how many are matched this way.

A document that implies no work type (`Ledger`, `Bank Statement`, `Others`) is
still **shown in the drawer's received panel** — it just doesn't create a row.
Nothing about an intake is hidden from the person deciding what work is needed.

`wdPendingRows()` builds the list from `document_register` **outward, never
from `work_done`** — the commonest pending case by far is a client whose Work
Done record doesn't exist yet, so iterating saved records would miss exactly
the rows that matter most. Then:

- Rows with `client_id: null` (File In Out's walk-in case) are skipped —
  there's no client record to be pending against.
- `doc_types` entries that are bare strings (the pre-quantities legacy shape
  `fmDocSummary()` still handles) are read as qty 1; `qty: 0` is ignored.
- **One row per File In Out entry** (2026-08-15, superseding the earlier grain
  below). Every job the intake implies (still fanned out through
  `wdWorkTypesForLabel` — one document can legitimately imply two jobs) is
  carried inside that one row as a `jobs` array, rendered as one badge per
  job. **This drops the old reverse-aggregation**: several intakes of the same
  work type for the same client in the same year used to collapse into one
  row listing every `register_no`; that read as "one job, several visits" but
  the firm reads the list as "which physical files are still waiting", and a
  single intake carrying Sales Register + Purchase Register + Stock Book was
  printing as three separate rows for the same file. Two real intakes still
  get two rows.
- Sorted **longest-waiting first**, which is the actual triage order and the
  one thing the paper list could never do.
- A row whose file has already been returned still appears; "returned but
  never worked on" is a real finding, so the File In Out status is shown
  rather than used to exclude.

Clicking **Open** loads that client+year's record, seeding a fresh one when it
doesn't exist — one click from "this is late" to "I'm doing it".

### The fiscal-year join is the load-bearing part

`document_register.fiscal_year` is a **free-text box in dash format**
(`e.g. 2081-82`); `work_done.fiscal_year` is a **dropdown in slash format**
(`2082/83`). CLAUDE.md §8 keeps per-module formats deliberately distinct, so
the join normalizes both through **`NepaliLocale.fyStartYear()`** (added with
this module) rather than comparing strings.

**A string-equality join here matches nothing and fails silently** — the
Pending List renders empty and looks perfectly correct. Three guards exist
because of that, all of them about making emptiness *explainable*:

1. Intakes with no readable fiscal year are **counted and reported** in a note,
   and matched on client rather than dropped.
2. `wdOrphanWorkTypes()` flags a work type whose every `fileLabels` spelling
   has fallen out of both the picklist and the live register — that work type
   can never appear again, which is a config bug, not an empty list.
3. The empty state distinguishes **"nothing is waiting"** from **"no
   file-backed document has ever been logged"**, and in the second case says
   how many intakes exist. Those two look identical otherwise.

## The Activity Log — cross-module, per client (2026-08-10)

A header button beside *Export Excel* opens a read-only view over
**`audit_log`**: what anyone at the firm has actually **done for a client**
— a projection generated, a file intake recorded, a return finalized —
filterable **client-wise**, **work/module-wise** and **staff-wise**.

**Scoped to seven modules** (`window.ACTIVITY_MODULES`, `js/config.js`,
2026-08-15): Financial Statement, Projection Report, Confirmation, Autobooks,
File In Out, Audit Report Finalization and Audit Checklist — the modules that
make up the firm's per-client work history. Everything else (Bank Entry,
Billing, Clients, Depreciation, ...) still writes to `audit_log` as before, it
simply isn't part of what this view answers. This is what keeps the Client
filter to real directory clients: `audit_log.client_name` is free text, and
`bankBook` in particular writes a **bank account name**
("Dallakoti & Company(current)") or a free-typed expense/person particular
("Bank Charges", "Bank Deposit") into that column — neither is a client, and
excluding `bankBook` from the scope is what removes them. The Client dropdown
additionally intersects its options with `window.clientsList` as a second
guard, so a stray non-client string from an in-scope module still can't
appear as a filter option (the row itself stays visible in the table).
`wdActivityInScope()` mirrors `wdActivityIsPersisted()`'s "absent = shown"
idiom: if `window.ACTIVITY_MODULES` is ever missing, the log falls back to
showing everything rather than silently going blank.

It lives here rather than on the Dashboard because the Dashboard's feed is a
10-row "what just happened" glance for the whole firm; this is the searchable
history. The rest of Work Done answers "what work is finished on this client's
file"; this answers the question the same person asks next.

**Nothing new is written.** Every module already calls `AuditLog.record()`, so
this is a view over data that exists, and a module added later appears in it
the day it ships without touching this code.

- `window.MODULE_LABELS` / `window.ACTIVITY_EVENT_LABELS` (`js/config.js`) turn
  the stored `module` id and snake_case `event_type` into the firm's own
  words. **An unmapped value falls back to the raw string rather than being
  hidden** — a new module's events must never be silently missing from the log
  just because nobody has added a label yet.
- Filter options are built from **what's actually in the loaded window**, not
  a fixed list, and are **sorted by label, not by raw value** (sorting the ids
  puts Autobooks — `salesPurchaseBook` — between Projection and Work Done).
- The window is **bounded on purpose**: `audit_log` passed 1,800 rows in its
  first month (861 of them one module's `spb_correction` events) and only
  grows, so it opens on the last **90 days** and widens only when a From/To
  range is set. Changing the range **re-fetches** — those rows aren't in
  memory to filter.
- `staff` is the signed-in `user_email` (the only identity the log carries):
  the local part is displayed, the full address is in the tooltip and export.
- Print / PDF / Excel go through `ReportExport` over the **filtered** rows, so
  what's exported is what's on screen.

### Repeats are merged into one entry (2026-08-10)

Re-running a projection eight times while getting the figures right is **one
piece of work, not eight**, and logging it eight times buried the days when
something was actually finished. `wdActivityCollapse()` keys on
**(client, module, event type)** — the same job for a *different* client is
separate work — and keeps only the **latest** run.

The window (`WD_ACTIVITY_MERGE_HOURS`, 3h) is measured **gap-to-gap, not from
the newest event**: a working session with two-hour pauses is one entry
however long it runs, which is the case the firm actually hit. An
anchor-based window would instead chop that session into an arbitrary entry
every three hours.

**Nothing is silently dropped.** The kept row carries `×N` (with the run's
start and end in its tooltip), the count line reports how many repeats were
merged, and the export gains a **Times** column plus a subtitle stating the
rule — a printed copy must not read as a complete event list when it is a
merged one.

Measured against the live table: **1,886 raw events in 90 days → 350
entries.** The largest single merge is 713 `spb_correction` events from one
2-hour Autobooks session; a 5½-hour run of 26 `projection_generated` events
becomes one row marked ×26.

**Caveat on historical rows:** events written before the camelCase fix have a
null client, so they can only be keyed on module + event type — two clients'
projections in the same afternoon merge into one entry there. Rows written
from now on carry the client and merge per client, as intended.

### Depreciation and Generate Report show saves only

`window.ACTIVITY_SAVED_ONLY` (`js/config.js`) restricts a module to the events
that actually **wrote to the database**. Both modules emit an event per export,
so they filled the log with attempts rather than results:

| Module | Kept | Dropped |
|---|---|---|
| Depreciation | `depreciation_saved`, `depreciation_deleted` | `document_generated` (23 live rows), `depreciation_printed` |
| Generate Report | `audit_report_saved` | `document_generated` (13 live rows) |

Deletes are kept deliberately — a delete *is* a database write, and hiding it
would leave the log asserting a schedule exists after it was removed.

A module **absent** from the map is unrestricted, so a new module shows
everything by default rather than silently showing nothing.

> **Generate Report currently shows nothing at all.** `saved_documents` is
> empty — no audit report has ever been saved to the database, so all 13 of
> that module's events are generate/download. This is the requested
> behaviour, not a bug: the module will start appearing once staff use its
> **Save** button. The empty state says so explicitly rather than reading as
> "nothing happened".

### The client column was empty for six modules

`AuditLog.record()` reads `detail.clientName` / `detail.recordRef`, but
`companyProfile`, `depreciation`, `depreciationSlm`, `notesToAccounts`,
`report`, `projection` and `projectionExport` were passing **snake_case**
`client_name` / `record_ref`. Those keys are silently dropped, so every one of
those events had written a **null client name** — visible in the live table as
`projection_saved` / `projection_printed` rows with no client against them.
Fixed at all call sites in the same change; historical rows keep their nulls.

## Views, filters and export

A segmented toggle (`.rep-view-btn`) switches between **Work Records** and
**Pending List (N)**; the header Print / PDF / Excel buttons act on whichever
view is showing, so what you export always matches what you're looking at.

- Four stat cards (Total / Complete / In Progress / Not Started) double as
  quick filters and clear the other filters when clicked.
- Filters: FY · Status · **Staff** · Recorded From/To · free-text search.
  The Staff filter matches a record where **any** work row is assigned to that
  person — "what's on my plate", the module's stated purpose. Its options are
  the fixed list UNION every name actually in the data, so a name typed
  through "Other" is still filterable.
- The records table's **Files Pending** column shows the same file-backed
  outstanding count per record, so the signal is visible without switching
  views.
- Exports flatten `items` into three text cells (Done / In Progress / Not
  Started, each `label (staff) — remarks`) rather than one column per type,
  since custom rows make the count vary per record.

## Resolved: the "Complete never fires" limitation

The first version seeded all 16 work types on every record, so most clients
carried rows they'd never do (Excise Return, ETDS) and the record read *In
Progress* forever. A fourth `not_applicable` state was offered and declined.

**Selecting rows instead of seeding all 16 fixed it properly** — progress is
now over the rows the client actually needs, so a finished record reads
*Complete*, and the fourth state isn't needed. A row that doesn't apply is
simply not added.

## Gotchas

- Saving uses an explicit `if (wdEditingId) update else insert`, **not**
  `upsert` — an upsert would silently overwrite `created_by` on every edit.
- `item._other` is a transient UI flag stripped by the save payload's explicit
  field list. Selecting "Other" clears `staff`, so the reveal can't be
  inferred from the saved value — that exact bug shipped in Audit Checklist
  before the flag was added.
- `wdOnItemRemarksChange` / `wdOnCustomLabelChange` / `wdOnItemStaffOtherChange`
  update the in-memory item **without** re-rendering, so typing doesn't steal
  its own focus. State/staff selects and add/remove do re-render.
- `wdSetView()` calls `redraw(true)` on a `setTimeout` — Tabulator lays out to
  zero width while its container is `display:none`, so the newly-shown table
  renders no rows until it has a box to measure.
- Neither table goes through `DataCache`, deliberately: `LEDGER_KEYS` is
  reserved for the four shared ledger tables (CLAUDE.md §6), and a work
  tracker showing 60-second-stale data is worse than one extra round-trip.
- `AuditLog.record` silently drops snake_case detail keys — use the camelCase
  form (`clientName`, `recordRef`).

## Verified

Migration applied and checked live via the Supabase MCP **before any JS was
written against it**: all 12 columns with correct types/nullability/defaults,
RLS enabled, all four `private.is_app_user()` policies, the
`set_wd_updated_at` trigger, three indexes plus the UNIQUE and the FK's
`ON DELETE RESTRICT` — confirmed against the actual Postgres catalog.

Exercised in the dev server with the auth wall bypassed via DOM manipulation
and the data layer stubbed so the **real `wdRefresh()` path** ran against
seeded rows (CLAUDE.md §2/§12 — no real Supabase session in this sandbox):

- **`NepaliLocale.fyStartYear` across 15 inputs**: all five formats in
  CLAUDE.md §8 (`2081-82`, `2081/82`, `2081/082`, `2081.2082`, `2081`), both
  Devanagari forms, whitespace and prefixed text — all correct; `''`, `null`,
  `undefined`, `'81-82'` and `'abc'` all returned `null` rather than a wrong
  year.
- **The Pending List against seeded data, all seven cases**: an intake with no
  `work_done` row at all appeared; an item marked done disappeared while a
  second type on the *same intake row* stayed; **a dash-format intake matched
  a slash-format record** (the join this module depends on); an unreadable
  fiscal year landed in the note and not the list; a walk-in
  (`client_id: null`) was skipped; two intakes of the same type in one year
  aggregated to one row with both register numbers, the earlier date and both
  file statuses; and a fully-returned intake with work outstanding still
  appeared. A `Ledger` intake (an FM doc type that is *not* a work type) and a
  `qty: 0` entry were both correctly ignored. Sort order confirmed
  longest-waiting first (211d → 100d → 69d → 39d).
- **Both inherited bug classes re-tested explicitly.** Auto-match bound to the
  existing record, then **released to a fresh unchecked seed for the current
  client** when the fiscal year changed to one with no match; inside an
  explicit Edit, changing the fiscal year left `wdEditingId` untouched. The
  "Other" staff box stayed open after selection, captured the typed name, was
  stripped of `_other` in the save payload, and re-showed correctly on
  reload.
- **`wdMergeItems`**: a stored record holding 1 fixed + 1 custom row merged to
  17, the stored row's state/staff/done_date preserved exactly, the 15
  newly-added types seeded not-started, the custom row kept last.
- **Focus retention**: typing character-by-character into both a remarks box
  and a custom label kept focus and tracked the model.
- **Exports**: both models built correctly; the print window received the same
  `ReportExport.toHtml` output; real binaries generated (7.5 KB `.xlsx`,
  2.6 KB `.pdf`). Devanagari client names are the expected failure mode to
  watch — PDF-Lib's standard fonts are WinAnsi-only (`pdfSafe()` in
  `reportExport.js`) — and none were in the test set.
- **The config guard was tested by breaking it** *(then named
  `wdBrokenFileLabels`; replaced by `wdOrphanWorkTypes` in the second pass)*: simulating a
  File In Out rename dropped the pending list from 1 row to 0, and the error
  box correctly named the offending label instead of the list just looking
  empty.
- **Layout confirmed structurally** (computed styles, not by eye): the item
  row is a five-column grid, no label overflows at the real 860px drawer
  width, the state/done tints apply, and the staff cell doesn't overflow when
  the "Other" box is revealed. The column widths were **rebalanced during
  verification** — the longest label ("S/P as per VAT Return") originally had
  16px of slack while the staff select had 30px more than it needed.
- **Regression sweep**: all 21 main modules and all 7 registrar sub-panels
  switch and render cleanly. `NepaliLocale.bsFyDash` and `fiscalParts` still
  behave (the engine was edited), `ARF_STAFF` is unchanged (shared with Audit
  Report Finalization), and all three `fileLabel`s resolve against
  `FM_DOC_TYPES`. Console showed only the documented no-session 401s.

**Not verified:** a live authenticated insert/update/delete succeeding end to
end against Supabase; the delete button's `confirm()` path (skipped to avoid a
blocking native dialog); and the **visual appearance** — the browser pane
could not composite a screenshot in this session, so everything above is
structural. Worth a real save pass and an eyeball check after deploying.

### Second pass (2026-08-10) — real-data corrections

The first pass's Pending List verification used **seeded rows that matched the
implementation's own assumptions**, so it passed while the feature returned
nothing against production. Both root causes are documented above. This is the
exact failure mode CLAUDE.md §12 warns about, and the fix was re-verified
against a **verbatim copy of all seven live `document_register` rows** pulled
via the Supabase MCP:

- 8 pending rows now produced from the real register (the four
  `Purchase & Sales Files` intakes each correctly yielding both a Sales
  Register and a Purchase Register job), all shown as `FY —` with the
  match-on-client note; the `Ledger`/`Bank Statement`-only intake, the
  `Others`-only intake and the `client_id: null` walk-in all correctly absent.
- A new record for a client with received files opened with **2 auto rows, not
  16**; a client with no file-backed documents opened with **0** and the
  guidance empty state. The received panel showed *every* document including
  the unmapped ones, with only the mapped one highlighted.
- The picker offered the remaining 14 in 5 groups, additions sorted back into
  catalogue order, removals worked, and the count tracked.
- A legacy 16-row record still loaded all 16 with its done row intact
  (**nothing truncated**), while a hand-picked 2-row record stayed at 2 and
  derived **Complete**.
- Layout re-measured (no overflow, chip tints correct) and all 21 modules
  still switch cleanly.
