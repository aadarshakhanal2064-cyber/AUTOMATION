# File In Out — Document Register (§5.20)

**Code:** `js/fileManagement.js` · **Prefix:** `fm-` · **Table:** `document_register`
**Where:** sidebar, Core modules (between Clients and Audit Report Finalization) · **Registry id:** `fileManagement`

**Display renamed to "File In Out" on 2026-08-09** — the sidebar label, page
title and breadcrumb changed; the code did not. File name, function/element
prefixes, table name and registry id all stayed `fileManagement`/`fm-`, the
same label-only precedent already used for Autobooks and Bank Entry
(CLAUDE.md §5's "Two modules were renamed" table — now three).

A custody register for the **physical documents** clients hand over — purchase &
sales files, ledgers, confirmations, interest certificates and the rest. It
answers one question the rest of the app cannot: *what paper is sitting in the
office right now, whose is it, and who do we give it back to?*

The user described it as "kinda like stock maintenance", and that is exactly the
shape: goods in, goods out, and a running list of what is still held.

## The one-row model

**One row per visit, updated in place on handover** — not an intake row plus a
separate returns row. A bundle received and the same bundle given back are one
physical custody, and splitting them across two rows would let the two sides
disagree about what is still held. So the handover fields
(`date_returned`, `returned_to_name`, `returned_to_phone`, `return_remarks`,
`mode_returned`, `email_sent`) live on the intake row and stay null until it
is returned.

`Reopen` (undoing a handover recorded in error) **clears those fields
rather than keeping them as history** — the documents are physically back with
us, and stale collector details on a "with us" row would be read as fact by the
next person to look.

## Status flow

Two statuses only, through `WorkflowEngine.createStatusFlow` (`fmFlow`):

| Key | Label | Badge |
|---|---|---|
| `pending` | With Us | `badge-amber` 📥 |
| `returned` | Returned | `badge-sent` ✅ |

Every transition — Hand Over and Reopen — goes through `fmFlow.transition()`,
which persists the row and writes the `document_register_status_change` audit
entry **together**, so the badge, the stored row and the audit trail can never
disagree. This is the `vatCompliance.js` pattern; don't add a second write path.

## Document types — quantities, not just a tick (2026-08-09)

`window.FM_DOC_TYPES` (`js/config.js`) is now an array of `{key, label, unit}`
matching the firm's actual paper register (Sales Register, Purchase Register,
Sales Bill, Purchase Bill, Stock Book, Ledger, Confirmation, Bank Statement,
Bank Loan / Interest Certificate, plus the pre-existing Cheque Book / Vouchers
and Tax Documents). Each renders as one row with a **quantity input**
(`fm-qty-<key>`) instead of a checkbox — "0 or blank" means not included.
Saved as a jsonb array of `{type, qty}` in `doc_types` (was a flat array of
strings before this date). `fmDocSummary()` renders it as `"Ledger ×2,
Confirmation ×1"`.

**One manually-typed custom entry** (`fm-doc-other-name` + `fm-doc-other-qty`)
covers anything not on the picklist — deliberately singular ("type your own"),
not a repeatable list. On edit, if a saved row has more than one entry that
doesn't match today's picklist (only possible from data older than this
migration), only the first is offered back in that slot; saving normalizes
the rest away. Adding a picklist type needs no migration — extend the config
array.

## Fiscal Year (added 2026-08-09 — reverses the earlier "no FY field" decision)

`fiscal_year` is dash format (`2081-82`, the majority convention — Bank Entry,
Party Ledger, Depreciation, Financial Statement) and **auto-derived from Date
Received** the moment it's picked, via `NepaliLocale.adToBs` →
`NepaliLocale.bsToStr` → `NepaliLocale.bsFyDash` (the same AD→BS chain Party
Ledger uses for `service_memos.memo_date`, since `document_register` also
stores a real Postgres `date`). `fmOnDateReceivedChange()` never overwrites a
value the user already typed or that was loaded from a saved row. Nullable —
the 7 rows that predate this field are simply blank until edited.

## Delivery mode — Online vs Physical, independent per side (2026-08-09)

Intake and handover each carry their own `mode_*` ('physical'/'online') plus
the field it unlocks: physical → `brought_by_name`/`brought_by_phone` or
`returned_to_name`/`returned_to_phone` (unchanged from before); online →
`email_received` or `email_sent`. A client can drop files off in person and
the firm can email the finished work back, or the reverse — the two sides
don't have to match. `fmOnModeChange(side)` toggles which fields show and are
required; `fmContactCell(row, side)` is the one renderer both the "Received
From" and "Returned To" table columns share, so the two sides can't drift
into different display rules. The handover modal defaults its mode to match
the intake's mode as a starting guess, editable.

`brought_by_name` is no longer `NOT NULL` at the database level (an
online-mode intake has no physical person) — the JS layer enforces
name-or-email based on the selected mode instead.

## Ageing

`fmDaysHeld()` counts calendar days from `date_received` to *today* for a
pending row, but to `date_returned` for a returned one — so a closed entry
reports its real custody span rather than an ever-growing age. Anything held
past `FM_AGEING_ALERT_DAYS` (30) turns the Days cell red and is counted by the
"Held 30+ Days" card. That card is the module's actual point: documents quietly
staying in the office forever is the failure mode being prevented.

## Stat cards are the filters

`FM_FILTERS` drives **both** the card counts and the table filtering from one
definition, so they can never disagree (again the `vatCompliance.js` pattern).
Cards compose with the document-type, fiscal-year, date-range filters and the
fuzzy search box; `Clear Filters` resets the active card to `all` as well as
the inputs. The Fiscal Year filter's options are rebuilt from whatever years
are actually present in the loaded rows (`fmPopulateFyFilter()`), not a fixed
list — it has nothing to show until real rows carry a fiscal year.

## Deliberate scope limits

- **No Google Drive link, no document-generation pipeline.** This tracks paper
  the firm is physically holding; a digital copy is not a substitute for knowing
  where the client's original ledger is.
- **`client_id` is nullable.** A walk-in who is not in the directory yet still
  gets registered; the name and PAN are snapshotted either way, and a
  hand-edited name drops the `client_id` link (the `service_memos` discipline).
- **The custom document-type slot is singular by design** — "add one other
  option to manually type" was the explicit ask, not a repeater.

## Gotchas

- `register_no` (`FM-00001`) is assigned by an **AFTER INSERT trigger**, so it is
  not in the insert's returned row — `fmRefresh()` reloads to pick it up. Same
  gotcha as `invoices` and `service_memos`.
- The table sets **no `initialSort`**: the query already returns newest-first,
  and `created_at` isn't a displayed column, so a sort on it would be silently
  ignored by Tabulator (and log a warning).
- Rows created before 2026-08-09 have `doc_types` backfilled to `{type, qty:1}`
  (quantity wasn't captured before, so every backfilled entry defaults to 1)
  and `mode_received: 'physical'` (matching what every existing row actually
  was); `fiscal_year` on those rows is null until edited.

## Verified

Built and exercised 2026-08-01 (original version) and 2026-08-09 (Fiscal
Year, quantities, delivery mode) in the dev server against an in-memory
stand-in for the table (the sandbox has no Supabase session, so RLS blocks
real writes): intake save in both modes, validation rejections, edit
round-trip, fresh-form isolation after an edit, handover in both modes,
reopen, delete, all four stat-card filters, document-type/fiscal-year/date/
search filters, and a full-tab regression sweep. `AuditLog` writes fail in
the sandbox (no session) and are swallowed as designed. **Not verified:**
live Supabase writes under a real signed-in session.
