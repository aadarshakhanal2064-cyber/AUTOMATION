# Audit Checklist (§5.22)

**Code:** `js/auditChecklist.js` · **Prefix:** `achk-` · **Table:** `audit_checklists`
**Where:** sidebar, Core modules (after Audit Report Finalization) · **Registry id:** `auditChecklist`

Digitizes the paper QC sign-off sheet staff filled by hand before an audit
report is finalized — client identity at the top, then a fixed list of items
(P.Y figures tallied, bank balances, loan interest, annexures, etc.), each
ticked off and attributed to whoever checked it. It sits next to **Audit
Report Finalization** in the workflow — this is the QC pass that happens
before that module's IT/Estimate/Tax tracks get finalized — and borrows its
conventions throughout.

## The record model

**One record per `(client_id, fiscal_year)`**, enforced by a UNIQUE
constraint — a single QC pass per client per year, unlike Audit Report
Finalization's per-return-type split, because this is one piece of work, not
three independently-timed ones. `achkMatchExistingRecord()` watches the
client and fiscal-year fields and loads a matching record for editing the
moment both are known, so a save never collides with the constraint in normal
use — the same auto-match-or-fresh idea ARF uses, minus the return-type
dimension.

`client_id` is **NOT NULL, ON DELETE RESTRICT** — directory clients only, no
walk-in case like `document_register`.

### Why `items` is a JSONB array, not one column per item

Each record's `items` column holds:

```json
[{ "key": "py_fig", "label": "P.Y Fig", "checked": false, "checked_by": "", "custom": false }, ...]
```

A fixed-column schema would need a migration both when the firm's checklist
grows and for every custom item a client's record happens to need — jsonb
avoids both. `window.AQC_CHECKLIST_ITEMS` (`js/config.js`) is the fixed
template, in display order: P.Y Fig · Sales/Purchase with VAT Return · Bank
Balances · Bank Loan Interest · P.Y VAT Adjustment · Overall F.S Check ·
Ann-1/2 · Ann-10 · Ann-13 — the same 9 items for every client, every one
unchecked on a brand-new record. Adding a row to the firm's checklist is a
config-array edit, no migration.

`checked_by` holds a name from `window.AQC_STAFF` — the two **firm** names
(`Shailesh & Associates`, `Dallakoti & Company`) plus individual staff
(Aadarsha, Kesav, Dipendra) plus `Other`. Choosing `Other` reveals a
free-text box whose typed name **replaces** `Other` in the saved value —
same convention as `audit_report_finalization.auditor`, so there is no
separate `*_other` field anywhere in `items`.

**Tried and dropped: gating the two VAT items on `clients.vat_status`.** The
first version only seeded "Sales/Purchase with VAT Return" and "P.Y VAT
Adjustment" for VAT-active clients, mirroring the paper form's "Display this
only in case of vat" note literally. In practice `vat_status: 'active'` is a
small hand-picked subset (CLAUDE.md §15) — most clients aren't marked
active — so most checklists silently lost two rows the CA still wanted on
every checklist. Reverted to a flat, always-9-item list per explicit
instruction after seeing it in use.

**Editing an existing record loads exactly what's stored, unchanged** —
`achkBuildFreshItems()` (the seeding function) only ever runs for a
brand-new client+year combination with no existing row, so it can't
retroactively rewrite a checklist someone already filled in.

### Custom items — fully open-ended

The paper form's generic "Others" tick plus two hardcoded blank "Specify
others" slots (with a "+" that did nothing on paper) are replaced by one
mechanism: **+ Add Custom Item** appends a row with an editable label, no
cap, each with its own remove button. This is the one deliberate improvement
over the paper form (confirmed with the user, not assumed).

## Status is derived, never stored

There is no `status` column. `achkStatusKey(row)` reads `items[].checked`
every time it's needed — for the table badge, the stat cards/filters and the
export text — so none of them can drift from what was actually saved:

| Key | Badge | Condition |
|---|---|---|
| `not_started` | `badge-neutral` ⬜ | zero items checked (or no items at all) |
| `in_progress` | `badge-amber` 🟡 | some but not all items checked |
| `complete` | `badge-sent` ✅ | every item checked |

`achkProgress(row)` returns `{checked, total}`, shown in the table as a plain
`7/9` fraction rather than a new progress-bar widget — the status badge's
colour already carries the "how far along" signal, so a new visual
component wasn't needed.

## Stat cards clear the filters

Four cards — Total Checklists · Complete · In Progress · Not Started —
driven by one `ACHK_FILTERS` definition that feeds both the counts and the
table filtering (the ARF/File Management idiom). **Clicking a card clears
every other filter first**, so its number always matches what's shown.

## The form

- Client search (`SearchEngine.attachAutocomplete`, keys `['name','pan']`,
  literally ARF's pattern) fills Name + read-only PAN.
- Fiscal Year select (`achkFyOptions()`, slash format, default `2082/83` —
  same range and format as Audit Report Finalization, confirmed with the
  user rather than assumed, since CLAUDE.md §8 treats fiscal-year format as a
  deliberate per-module choice).
- Date Recorded (defaults to today, editable) — same reasoning as ARF's
  `recorded_date`: separate from the immutable `created_at`, drives the
  From/To range filter, exists because staff log work on a different day than
  they did it.
- The checklist itself, rendered into `#achk-items-list` from the in-memory
  `achkItems` working array (not the DOM) — each item is a row with a
  checkbox, a label (static for fixed items, an editable text input for
  custom ones), a "Checked by" select + Other box, and a remove button on
  custom rows only.
- Remarks, then Save.

Picking a client with no existing checklist for the selected year seeds
`achkItems` fresh via `achkBuildFreshItems()` — the full fixed template,
every item unchecked. Picking a client+year that already has a row loads it via
`achkLoadIntoDrawer()` instead — the auto-match releases back to a fresh
seed the moment the combination stops matching, exactly the ARF bug class
("switching client keeps editing the previous client's record") that a
`achkAutoMatched` flag exists specifically to prevent.

## Print / Preview / PDF

Added after the first ship, at the user's request. Three entry points, all
built on the same `achkBuildModel()` the Excel export already used, so
Preview, PDF export and Excel export can never show different data for the
same filters:

- **Print / Preview** (page header) — previews every currently-filtered
  record in a print window.
- **Export PDF** (page header) — `ReportExport.download(model, 'pdf', ...)`,
  same filtered set, direct download instead of a preview window.
- **Print** (per table row) — `achkPrintOne(row)` previews just that one
  client's checklist, the single-record case the paper form actually existed
  for.

`achkOpenPrintWindow()` is ARF's exact idiom: `window.open('', '_blank')`,
write `ReportExport.toHtml(model)` into it, then `w.print()` after a short
delay so the new document has finished laying out. **The browser's own print
dialog's "Save as PDF" destination is the actual preview→PDF path** — there
is no separate "convert preview to PDF" feature to build, since every
browser's print dialog already offers it.

## Gotchas

- Saving uses an explicit `if (achkEditingId) update else insert`, **not**
  `upsert` — an upsert would silently overwrite `created_by` on every edit
  (same reasoning as ARF).
- A custom item with a blank label blocks save (`Give each custom item a
  name, or remove it`) — an unlabeled custom row would be indistinguishable
  from a mistake on reload.
- `achkOnCustomLabelChange` / `achkOnItemStaffOtherChange` update the
  in-memory item **without** re-rendering the list, so typing in either box
  doesn't steal its own focus; every other item mutation (`toggle`,
  `staff select`, `add`, `remove`) does re-render, since none of those are
  free-text inputs mid-keystroke.
- The table's "Progress" and "Status" columns both key off `field: 'id'`
  with `headerSort: false` (like ARF's Status column) — neither is sortable
  on a real column, so this avoids Tabulator logging a sort warning.

## Deliberate scope limits

- **Directory clients only** — no walk-in case, matching Audit Report
  Finalization rather than File Management's nullable `client_id`.
- **No overview chart** — a single client+year status doesn't need one; ARF's
  three-track grouped bar chart exists because it compares three tracks at
  once, which doesn't apply here.
- **Export flattens `items` into two text cells** (`Completed Items` /
  `Pending Items`, each `label (checked_by)` joined with `; `) rather than one
  column per item — the item count still varies per record because of custom
  items, so a fixed-column export isn't possible without either truncating
  data or one column per *possible* item across every record.

## Verified

Migration applied and checked live via the Supabase MCP (columns, defaults
and all 4 RLS policies confirmed against the actual Postgres catalog before
any JS was written against it). Exercised in the dev server with the auth
wall bypassed via DOM manipulation and two hand-seeded clients — one
`vat_status: 'active'`, one `'not_registered'` — per CLAUDE.md §2/§12 (no real
Supabase session in this sandbox):

- *(First pass, since superseded — see the VAT-gating note above)* VAT-active
  client seeded exactly 9 items including both VAT-only rows; non-VAT client
  seeded exactly 7, both VAT-only rows omitted. Re-verified after the revert:
  **both** clients now seed the same 9 items, all unchecked, regardless of
  `vat_status`.
- **Found and fixed a real bug during this pass**: selecting "Other" on a
  checklist item's staff picker cleared `checked_by` to let the name be
  typed, but the free-text box's visibility was (re)computed from
  `checked_by`'s content on every re-render — so it collapsed shut the
  instant it appeared, because the value that would have proven "this is
  Other" had just been cleared. Fixed by tracking `item._other` as an
  explicit transient UI flag (stripped before save, never persisted) instead
  of inferring the reveal from the resolved value. Re-verified after the fix:
  the box now stays open, the typed name is captured, and it round-trips
  correctly through a save→reload→edit cycle (a name not in the fixed list
  re-shows in the Other box, matching `arfFillStaffField`'s behaviour).
- Add Custom Item / Remove Custom Item both verified: adding appends a
  labeled, checkable row with a remove button that fixed rows never get;
  removing drops exactly that row and no other.
- Client-side validation guards fire correctly: no client picked, and a
  custom item left with a blank label after Add.
- The ARF bug class specifically re-tested here: with an existing record
  auto-matched into the drawer, changing the fiscal year to one with no
  match released it back to a **fresh, unchecked** seed for the current
  client (not the previous record's data). Inside an **explicit** Edit
  (opened via the table's Edit button), changing the fiscal year left
  `achkEditingId` untouched — confirmed the explicit-edit guard does not get
  pulled out from under the user the way the pre-fix ARF bug did.
- Save reached the real `audit_checklists` insert and failed only on
  `new row violates row-level security policy` — expected with no
  authenticated session, and the error surfaced as a clean one-line message
  in the drawer rather than an unhandled rejection.
- Stat cards filter correctly (a card showing 0 for a non-matching status
  renders Tabulator's own "No data" placeholder, same as every other
  TableEngine-based module) and Clear Filters restores the full set.
- `achkExport()` ran `ReportExport.download` to completion without throwing;
  the built model's cells were spot-checked (`Completed Items` /
  `Pending Items` correctly join `label (checked_by)` and plain labels
  respectively). The generated `.xlsx` binary itself was not re-read via
  ExcelJS in this pass.
- Regression sweep: Dashboard, VAT Compliance, Clients, File Management and
  Audit Report Finalization all switch and initialize cleanly alongside the
  new tab; the only console output was the documented AuditLog-swallowed-RLS
  and 401 pattern that appears throughout this app without a real session —
  nothing attributable to this module.

Print/Preview/PDF (added after the first ship) verified by stubbing
`window.open` and checking what was actually written and called, since a
real popup can't be inspected directly in this sandbox:

- `achkPrintOne()` (row-level Print) opened exactly one window, wrote HTML
  containing that client's name and its pending item, and called `.print()`.
- `achkPreviewAll()` (header Print/Preview) opened one window over the full
  filtered set, HTML included the title and a completed item.
- `achkExport('pdf')` ran `ReportExport.download` through to completion
  without throwing (PDF-Lib's WinAnsi-only standard fonts are the usual
  failure mode with Devanagari/curly-quote content — none hit here). The
  generated PDF binary itself was not re-opened/inspected.
- Console showed the same AuditLog-swallowed-RLS pattern for the new
  `achk_printed` and `document_generated` events — expected, not a defect.

**Not verified:** a live authenticated write (insert/update/delete
succeeding end-to-end against Supabase), the delete button's confirm-dialog
path (skipped to avoid a blocking native dialog in headless automation — the
underlying call is `confirm()` + delete, identical to ARF's own shipped
pattern), and the visual appearance of the item rows / green "checked" tint —
the browser pane could not composite a screenshot in this session, so layout
was confirmed structurally (DOM classes, computed `display`, values) rather
than by eye. Worth a real save pass and a quick eyeball check after
deploying.
