# File In Out — Document Register (§5.20)

**Code:** `js/fileManagement.js` · **Prefix:** `fm-` · **Table:** `document_register`
**Where:** sidebar, Core modules (between Clients and Audit Report Finalization) · **Registry id:** `fileManagement`

**Display renamed to "File In Out" on 2026-08-09** — the sidebar label, page
title and breadcrumb changed; the code did not. File name, function/element
prefixes, table name and registry id all stayed `fileManagement`/`fm-`, the
same label-only precedent already used for Autobooks and Bank Entry
(CLAUDE.md §5's "Two/Three modules were renamed" table).

A custody register for the **physical documents** clients hand over — purchase &
sales files, ledgers, confirmations, interest certificates and the rest. It
answers one question the rest of the app cannot: *what paper is sitting in the
office right now, whose is it, and who do we give it back to?*

The user described it as "kinda like stock maintenance", and that is exactly the
shape: goods in, goods out, and a running list of what is still held.

## The one-row model

**One row per visit** — not an intake row plus separate return rows. A bundle
received and everything given back out of it (in one go or several) are one
physical custody, so it all lives on the intake row: `doc_types` is what came
in, `outtakes` is everything that's gone back out.

## Outtake — repeatable partial returns (2026-08-09, second pass)

The firm doesn't always hand everything back at once — a client's Ledger
might go out today and their Confirmation letters a week later. The original
single-shot "Hand Over" (pending → returned in one move) couldn't represent
that, so it was replaced with **Outtake**: a repeatable event, each one
recording exactly which document types and quantities went out, when, and to
whom.

`outtakes` is a jsonb array on the row, one entry per event:
```
{ date, mode: 'physical'|'online', name, phone, email, remarks,
  items: [{ type, qty }], by }
```

**Status is 3-way and DERIVED, never hand-set** (`fmDeriveStatus()`, the same
"never a stored status column drifting from the raw data" idiom as Audit
Report Finalization — except here the derived value still gets *written* to
`status` on every change, because the table's own filtering keys off it):

| Key | Label | Badge | Derived when |
|---|---|---|---|
| `pending` | With Us | `badge-amber` 📥 | `outtakes` is empty |
| `partial` | Partially Returned | `badge-blue` 📤 | some outtakes exist, but something remains |
| `returned` | Returned | `badge-sent` ✅ | everything received has now gone out |

`fmReceivedByType()` sums `doc_types`, `fmSentByType()` sums every outtake's
`items`, `fmRemainingByType()` is their difference (floored at 0) — every
other computation in the module (status, the Remaining column, the outtake
modal's default quantities) reduces to these three.

Every status change — recording an outtake, undoing the last one — still
goes through `fmFlow.transition()` (`WorkflowEngine.createStatusFlow`), which
persists the row and writes the `document_register_status_change` audit entry
**together**. What changed is that `to` is now computed by the caller
(`fmDeriveStatus`) instead of being a fixed value tied to a button; the choke
point itself didn't move.

### The Outtake modal

Shows only document types with `remaining > 0`, quantity inputs **defaulting
to the full remaining amount and capped there** — so a normal complete return
is still one click, and a partial one is just turning a number down. Mode
(Physical/Online) works exactly like intake's, independently: a client can
drop files off in person and the firm can email the finished work back.
Defaults its mode to the previous outtake's mode if there's one, else to how
the documents came in.

### Undo Last Outtake

Replaces "Reopen". Pops only the **most recent** outtake event (not the whole
history) and recomputes status — a mistake is almost always in the last
entry, and earlier ones already genuinely happened. There's no "undo a
specific earlier outtake" — if that's ever needed, undo forward from the end.

### Editing an intake after an outtake exists

`fmSaveEntry()` blocks reducing a document type's received quantity below
what's already been sent out in an outtake (`Can't reduce X below Y — that
many have already been given out`) — otherwise `fmRemainingByType` would
silently floor to 0 and hide that something doesn't add up.

## Document types — quantities, not just a tick

`window.FM_DOC_TYPES` (`js/config.js`) is an array of `{key, label, unit}`
matching the firm's actual paper register: Sales Register, Purchase Register,
Sales Bill, Purchase Bill, Stock Book, Ledger, Bank Statement, Bank Loan /
Interest Certificate, Confirmation. (Cheque Book/Vouchers and Tax Documents
were removed 2026-08-09 — unused by the firm's real register; the free-typed
Others row covers them if ever needed.) **Bank Statement and Bank Loan /
Interest Certificate are placed at an even list index on purpose** — the
intake grid is 2 columns, so the two bank-related items land in the same row,
side by side, rather than split across rows.

Each type renders as one row with a **quantity input** (`fm-qty-<key>`)
instead of a checkbox — "0 or blank" means not included. Saved as a jsonb
array of `{type, qty}` in `doc_types`. `fmDocSummary()` renders it as
`"Ledger ×2, Confirmation ×1"`.

**One manually-typed custom entry** (`fm-doc-other-name` + `fm-doc-other-qty`)
covers anything not on the picklist — deliberately singular ("type your
own"), not a repeatable list. On edit, if a saved row has more than one entry
that doesn't match today's picklist (only possible from data predating the
2026-08-09 quantity migration), only the first is offered back in that slot;
saving normalizes the rest away. Adding a picklist type needs no migration —
extend the config array.

## Fiscal Year

`fiscal_year` is dash format (`2081-82`, the majority convention — Bank Entry,
Party Ledger, Depreciation, Financial Statement) and **auto-derived from Date
Received** the moment it's picked, via `NepaliLocale.adToBs` →
`NepaliLocale.bsToStr` → `NepaliLocale.bsFyDash` (the same AD→BS chain Party
Ledger uses for `service_memos.memo_date`, since `document_register` also
stores a real Postgres `date`). `fmOnDateReceivedChange()` never overwrites a
value the user already typed or that was loaded from a saved row. Nullable —
rows that predate this field are simply blank until edited.

## Delivery mode — Online vs Physical on intake

`mode_received` ('physical'/'online') plus the field it unlocks: physical →
`brought_by_name`/`brought_by_phone`; online → `email_received`.
`fmOnModeChange('received')` toggles which fields show and are required.
`brought_by_name` is not `NOT NULL` at the database level (an online-mode
intake has no physical person) — the JS layer enforces name-or-email based on
the selected mode instead. The outtake side has its own independent mode per
event (see above), not tied to the intake's mode.

## Ageing

`fmDaysHeld()` counts calendar days from `date_received` to *today* while
anything remains (`pending`/`partial`), but to the **last outtake's date**
once `returned` — so a closed entry reports its real custody span rather than
an ever-growing age. Anything still not fully returned past
`FM_AGEING_ALERT_DAYS` (30) turns the Days cell red and is counted by the
"Held 30+ Days" card. That card is the module's actual point: documents
quietly staying in the office forever is the failure mode being prevented.

## Stat cards are the filters

`FM_FILTERS` (now 5: Total, With Us, Partially Returned, Held 30+ Days,
Returned) drives **both** the card counts and the table filtering from one
definition, so they can never disagree (the `vatCompliance.js` pattern).
Cards compose with the document-type, fiscal-year, date-range filters and the
fuzzy search box; `Clear Filters` resets the active card to `all` as well as
the inputs. The Fiscal Year filter's options are rebuilt from whatever years
are actually present in the loaded rows (`fmPopulateFyFilter()`).

## Deliberate scope limits

- **No Google Drive link, no document-generation pipeline.** This tracks paper
  the firm is physically holding; a digital copy is not a substitute for knowing
  where the client's original ledger is.
- **`client_id` is nullable.** A walk-in who is not in the directory yet still
  gets registered; the name and PAN are snapshotted either way, and a
  hand-edited name drops the `client_id` link (the `service_memos` discipline).
- **The custom document-type slot is singular by design** — "add one other
  option to manually type" was the explicit ask, not a repeater.
- **Undo only ever targets the last outtake.** No arbitrary mid-history edit
  or delete of an earlier outtake event.

## Gotchas

- `register_no` (`FM-00001`) is assigned by an **AFTER INSERT trigger**, so it is
  not in the insert's returned row — `fmRefresh()` reloads to pick it up. Same
  gotcha as `invoices` and `service_memos`.
- The table sets **no `initialSort`**: the query already returns newest-first,
  and `created_at` isn't a displayed column, so a sort on it would be silently
  ignored by Tabulator (and log a warning).
- Rows created before 2026-08-09's quantity migration have `doc_types`
  backfilled to `{type, qty:1}` and `mode_received: 'physical'`; `fiscal_year`
  on those rows is null until edited.
- The original single-shot handover columns (`date_returned`,
  `returned_to_name`, `returned_to_phone`, `return_remarks`, `mode_returned`,
  `email_sent`) were **dropped**, not deprecated, when `outtakes` replaced
  them — safe because every row was still `pending` at the time.

## Verified

Built and exercised across three 2026-08-09 passes (Fiscal Year/quantities/
delivery mode, then Outtake/partial-return) in the dev server against an
in-memory stand-in for the table (the sandbox has no Supabase session, so RLS
blocks real writes): intake save in both modes, validation rejections
(including the reduce-below-sent guard), edit round-trip with legacy
picklist labels correctly falling into the Others slot, status derivation
across pending → partial → returned and back via undo, the outtake modal's
remaining-quantity defaults and caps, all 5 stat-card filters, document-type/
fiscal-year/date/search filters, and a full-tab regression sweep. `AuditLog`
writes fail in the sandbox (no session) and are swallowed as designed.
**Not verified:** live Supabase writes under a real signed-in session, or a
visual screenshot (this sandbox's Browser pane doesn't render one).
