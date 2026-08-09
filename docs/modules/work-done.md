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

`window.WD_WORK_TYPES` (`js/config.js`) is the fixed template — 16 rows in
five display groups (Books & Records · VAT & Reconciliation · Financial
Statements · Returns & Filing · Review & Advisory). Adding a work type is a
config-array edit, no migration.

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

### `wdMergeItems()` — a deliberate difference from Audit Checklist

Audit Checklist loads a stored record **verbatim**. Work Done instead does a
**non-destructive merge** against the current `WD_WORK_TYPES` on drawer load:
stored rows are kept exactly as saved, work types added to the config since
the record was written are appended as not-started, and custom rows keep
their order at the end. Labels are re-read from config so a wording fix
propagates.

The reason for diverging: this module's whole point is "nobody forgets what's
outstanding". If the firm adds a work type and every existing record silently
never shows it, the module reintroduces exactly the problem it was built to
solve. Nothing stored is ever altered or dropped, and the merge only touches
the drawer's working copy until the user saves.

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

Those three labels are exactly three of the nine `window.FM_DOC_TYPES` that
File In Out already records against `document_register`. So **"file is
received" is answered by the document register, not by a second checkbox**.
Nothing is entered twice and the list cannot go stale.

`wdPendingRows()` builds the list from `document_register` **outward, never
from `work_done`** — the commonest pending case by far is a client whose Work
Done record doesn't exist yet, so iterating saved records would miss exactly
the rows that matter most. Then:

- Rows with `client_id: null` (File In Out's walk-in case) are skipped.
- `doc_types` entries that are bare strings (the pre-quantities legacy shape
  `fmDocSummary()` still handles) are read as qty 1; `qty: 0` is ignored.
- Entries are aggregated to **one row per `(client, fiscal year, work type)`**
  carrying every contributing `register_no`, the **earliest** `date_received`
  and days waiting — a client can bring the same register in across several
  visits, and three register numbers for one outstanding job is one job.
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
Pending List renders empty and looks perfectly correct. Two guards exist
because of that:

1. Intake rows carrying a file-backed type whose fiscal year can't be parsed
   are **counted and reported** in a note above the list, never dropped
   quietly.
2. `wdBrokenFileLabels()` checks every `WD_WORK_TYPES[].fileLabel` still
   resolves to an `FM_DOC_TYPES[].label` at render time and shows an error
   box if not. `document_register` stores `doc_types[].type` as the **label
   text**, not the key, so renaming a document type in File In Out would
   otherwise empty the list with no error anywhere.

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

## Known limitation

With 16 fixed work types and no *Not Applicable* state, **"Complete" will
rarely fire** — most clients never need Excise Return or ETDS, so those rows
stay not-started forever and the record reads *In Progress* indefinitely.

This is acceptable because the module's primary signal is the Pending List,
which is file-backed and unaffected. A four-state version (adding
`not_applicable`) was offered and declined in favour of the simpler three; if
it proves noisy in real use it's a config + one-line-derivation change, no
migration.

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
- **The `wdBrokenFileLabels` guard was tested by breaking it**: simulating a
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
