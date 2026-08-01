# File Management — Document Register (§5.20)

**Code:** `js/fileManagement.js` · **Prefix:** `fm-` · **Table:** `document_register`
**Where:** sidebar, Core modules (between Clients and Send Logs) · **Registry id:** `fileManagement`

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
(`date_returned`, `returned_to_name`, `returned_to_phone`, `return_remarks`)
live on the intake row and stay null until it is returned.

`Reopen` (undoing a handover recorded in error) **clears those four fields
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

## Document types

`window.FM_DOC_TYPES` (`js/config.js`) is the picklist, rendered as checkboxes
because one visit routinely brings several kinds. Stored as a **jsonb array** in
`doc_types`; ticking `Others` reveals the free-text `doc_other` field (the same
show/hide idea as Service Memo's nature-of-task "Others"). **Adding a document
type needs no migration** — extend the config array.

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
Cards compose with the document-type and date-range filters and the fuzzy search
box; `Clear Filters` resets the active card to `all` as well as the inputs.

## Deliberate scope limits

- **No Google Drive link, no document-generation pipeline.** This tracks paper
  the firm is physically holding; a digital copy is not a substitute for knowing
  where the client's original ledger is.
- **No fiscal year field.** Documents arrive against a job, not a year, and the
  register's questions ("is it still here? who took it?") are all date-based.
  Add one only if the firm actually asks.
- **`client_id` is nullable.** A walk-in who is not in the directory yet still
  gets registered; the name and PAN are snapshotted either way, and a
  hand-edited name drops the `client_id` link (the `service_memos` discipline).

## Gotchas

- `register_no` (`FM-00001`) is assigned by an **AFTER INSERT trigger**, so it is
  not in the insert's returned row — `fmRefresh()` reloads to pick it up. Same
  gotcha as `invoices` and `service_memos`.
- The table sets **no `initialSort`**: the query already returns newest-first,
  and `created_at` isn't a displayed column, so a sort on it would be silently
  ignored by Tabulator (and log a warning).

## Verified

Built and exercised 2026-08-01 in the dev server against an in-memory stand-in
for the table (the sandbox has no Google OAuth session, so RLS blocks real
writes): intake save, validation rejections, edit round-trip, fresh-form
isolation after an edit, handover, reopen, delete, all four stat-card filters,
document-type/date/search filters, and a 20-tab + 7-sub-panel regression sweep.
`AuditLog` writes fail in the sandbox (no session) and are swallowed as designed.
**Not verified:** live Supabase writes under a real signed-in session.
