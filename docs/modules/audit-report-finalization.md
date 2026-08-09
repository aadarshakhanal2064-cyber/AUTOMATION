# Audit Report Finalization (§5.21)

**Code:** `js/auditReportFinalization.js` · **Prefix:** `arf-` · **Table:** `audit_report_finalization`
**Where:** sidebar, Core modules (after File Management) · **Registry id:** `auditReportFinalization`

A shared status tracker used by multiple staff to record where a client's **IT
return submission, Estimate return submission, and tax clearance** stand for
a fiscal year. It answers "what's still outstanding before this client's
audit report can close out" without relying on people's memory or scattered
notes. **Not tied to document generation** — pure task-status tracking.

## The one-evolving-record model

**One row per `(client_id, fiscal_year)`**, enforced by a UNIQUE constraint —
not a new row per edit. Staff update the same record over the life of a
filing season as the picture changes (submission filed, then verified, then
tax clearance obtained).

Because of the UNIQUE constraint, the form itself guards against creating a
duplicate: `arfOnClientOrFyChange()` fires the moment both a client and a
fiscal year are set, looks for an existing record, and — if found — switches
the drawer into editing that record (with an on-screen notice) instead of
letting a second "New Record" collide with the constraint on save.

`client_id` is **NOT NULL, ON DELETE RESTRICT** — this module tracks
directory clients only (no walk-in case like `document_register`), and
deleting a client with tracking history fails loudly rather than silently
losing it.

## Status is derived, never stored

There is no `status` column for either the IT Return or Estimate Return
track. `arfItStatusKey(row)` / `arfEstimateStatusKey(row)` compute a 4-key
badge state from the raw fields every time they're needed — for the table
badge, the status filter dropdown, and the print/export column text — so the
three can never disagree with each other or with what was actually saved:

| Key | IT Return label | Estimate Return label | Derived when |
|---|---|---|---|
| `not_submitted` | Not Submitted | Not Submitted | Verified flag unset and no submission text/checked-by name |
| `submitted` | Submitted | Checked | Verified flag unset but submission no./entered-by (IT) or checked-by (Estimate) is present |
| `verified` | Verified | Verified | Verified flag is `true` |
| `not_verified` | Not Verified | Not Verified | Verified flag is `false` |

`WorkflowEngine.createStatusFlow` (`arfItFlow`/`arfEstimateFlow`) is used
**only for its `badgeHtml()` mapping** — there's no `.transition()` call
anywhere in this module. Status isn't a button-driven workflow here; staff
just fill in the form and save, and the badge is a read of what's already
there. This mirrors how `billing.js` uses the same engine purely for display
off a column JS never writes through `transition()` (there it's
trigger-owned; here it's derived).

Tax Clearance is a plain 2-state boolean + conditional date — no tri-state
"not reviewed" state is needed there (the user's own framing: "yes or no, if
yes then a date").

## Staff pickers — "Other" replaces the value, no `*_other` column

`window.ARF_STAFF` (`js/config.js`) is `['Aadarsha', 'Kesav', 'Dipendra',
'Other']`, used for both **IT Entered By** and **Estimate Checked By**.
Picking `Other` reveals a free-text box (same show/hide idiom as File
Management's document-type "Others"), but unlike that module there is **no
separate `*_other` database column** — the typed name is written directly
into `it_entered_by`/`estimate_checked_by`, replacing the literal `"Other"`.
On reload, `arfLoadIntoDrawer()` detects a saved name that isn't one of the
three fixed staff names and re-shows it in the "Other" text box.

`window.ARF_AUDITORS` (`js/config.js`) is the fixed 5-name list — `Shailesh
Dallakoti`, `Non-Sign`, `Devi Prasad Dallakoti`, `Lila Adhikari`, `Surya
Poudel` — CHECK-constrained identically in the database; change both
together.

## Stat cards, filters, print/export

Four stat cards (`ARF_FILTERS`) double as quick filters, same pattern as
File Management's `FM_FILTERS`: Total Records / IT Verified / Estimate
Verified / Tax Cleared. They compose with the Auditor / Fiscal Year / IT
Status / Estimate Status / Tax Clearance dropdown filters and the fuzzy
search box (client name, PAN, submission no., remarks).

**Print/export has two scopes, using one code path:** the toolbar's Print /
Preview, Export PDF and Export Excel buttons act on the **currently
filtered** row-set — so searching or filtering down to one client and then
exporting *is* the "specific client" scope. Each table row additionally has
its own **Print** action for a one-click single-record printout. There is no
separate scope-picker control. Both paths build one `ReportExport` tabular
model (`arfBuildModel`) — the same 12-column shape whether it's one row or
the whole filtered portfolio.

## Table

Uses `TableEngine` (Tabulator), pagination 25/page — the same choice File
Management, Service Memo, Bank Book, Billing and VAT Compliance already
made. (CLAUDE.md §15 used to say only the Clients table uses Tabulator; that
line was stale by the time this module was built and was corrected in the
same commit.)

## Gotchas

- `it_verified`/`estimate_verified` are **nullable** booleans (`null` = not
  yet reviewed) — don't default them to `false`, that would make every new
  record read as "Not Verified" instead of "Not Submitted".
- Saving uses an explicit `if (arfEditingId) update else insert`, **not**
  `upsert` — an upsert would silently overwrite `created_by` on every edit.
  The duplicate-record guard above is what makes the explicit branch safe.
- `arf-client-pan` is `readonly` in the drawer — it's always the picked
  client's PAN, never hand-typed, so there's nothing to reconcile with the
  hand-typed-name-drops-`client_id` rule that the *name* field follows.

## Deliberate scope limits

- **Directory clients only** — unlike File Management's `document_register`,
  there's no walk-in case; a client not yet in the directory can't get a
  record here.
- **Not linked to document generation or the OCR pipeline** — this tracks
  status, not documents. A future ask to link a submitted return's actual
  file is a separate feature, not an extension of this one.
- **No per-auditor row separation** — one record per client per fiscal year,
  regardless of how many auditors touch it over the season; reassigning the
  auditor just edits the existing record's `auditor` field.

## Verified

Built and exercised 2026-08-09 in the dev server with the auth wall bypassed
via DOM manipulation and a hand-seeded `window.clientsList` (no real Supabase
session in this sandbox, per CLAUDE.md §2/§12):

- Client autocomplete + PAN autofill; hand-editing the name after picking a
  client correctly drops `client_id` and blocks save with "Pick a client
  from the list".
- Fiscal-year dropdown: 9 options, `2085/86` → `2077/78`, default `2083/84`.
- "Other" show/hide on both staff pickers (IT Entered By, Estimate Checked
  By), including re-detecting a saved custom name as "Other" on edit-load.
- Tax Clearance checkbox reveal/hide, auto-filling today's date on first
  reveal and clearing the date when unchecked.
- `arfItStatusKey`/`arfEstimateStatusKey` verified against 9 input
  combinations (unset / submission-only / verified true / verified false),
  all matching the expected 4-key state.
- The duplicate-record guard (`arfOnClientOrFyChange`): picking a client +
  fiscal year that already has a record switches the drawer into editing
  that record with the "editing the existing record" notice, rather than
  risking a UNIQUE-constraint collision on save.
- All 4 stat-card filters and all 5 dropdown filters individually, plus the
  fuzzy search box and Clear Filters resetting everything including the
  active card — each confirmed against a 3-row seeded dataset (including a
  Devanagari client name).
- `arfBuildModel` → `ReportExport.toHtml`/`.toExcel`/`.toPdf` all produce
  correct output; the exported `.xlsx` was re-read via ExcelJS and its
  header row + data row matched exactly.
- A real (expected) RLS rejection was exercised: saving as an unauthenticated
  request correctly surfaced "new row violates row-level security policy"
  instead of failing silently or crashing — confirms both the payload path
  and the RLS policy are working.
- Regression sweep across Dashboard, VAT Compliance, Clients and File
  Management: all switch cleanly, no console errors, File Management's nav
  position/behavior undisturbed by the new sidebar entry.

**Not verified:** a live authenticated Supabase write (insert/update/delete
succeeding end-to-end), since this sandbox has no real signed-in session —
same limitation every other module's dev-server verification carries. The
user should do one real save/edit/delete pass after deploying.
