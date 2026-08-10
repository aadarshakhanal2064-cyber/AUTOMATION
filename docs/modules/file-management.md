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

### Three of these labels are now load-bearing outside this module

`document_register` gained a **second reader** on 2026-08-09: the
[Work Done](work-done.md) module's Pending List answers "is a file received?"
from this register rather than from a second checkbox of its own, and its
drawer shows a client's whole intake history. It matches on
`doc_types[].type`, which stores the **label text**, not the key — so those
strings are now shared vocabulary between two modules.

**Renaming a document type can silently empty Work Done's Pending List** — no
error anywhere, it just looks like nothing is pending. `WD_WORK_TYPES[]` in
`js/config.js` therefore carries a **`fileLabels` list** per work type rather
than a single string, holding every spelling that has ever meant that
document. When renaming here, add the new spelling there; don't replace the
old one, or historical rows stop matching. `wdOrphanWorkTypes()` surfaces a
work type whose every spelling has fallen out of use.

This matters more than it sounds: as of 2026-08-10 the live register contains
`Purchase & Sales Files` (×4), `Others` (×3), `Ledger` (×3) and
`Bank Statement` (×2) — **none of today's nine picklist labels**, because every
row predates the 2026-08-09 rework. `Purchase & Sales Files` is one combined
item implying *both* the sales and purchase register jobs.

Note also that `fiscal_year` here is **optional free text** and is null on
every row entered so far, while Work Done's is a required slash-format
dropdown. That join goes through `NepaliLocale.fyStartYear()`, and an intake
with no year is matched on the client across all years rather than skipped —
but filling the year in is what ties a file to a specific work record.

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

## View Details — the answer to "what did I give vs what's still with me"

Third pass, 2026-08-09. The table's cells are necessarily narrow; `fmOpenDetail(row)`
opens a drawer with three unambiguous sections built from the same
`fmReceivedByType`/`fmRemainingByType`/`outtakes` data the table cells use:
**Documents Received** (full per-type table), **Outtake History** (one card
per event — date, mode/contact, exactly what went out, remarks), and
**Currently Remaining With Us** (per-type table, amber, or a green "Everything
has been returned" once `status === 'returned'`). The drawer's Outtake button
hides once nothing remains. This is also the entry point for **Print This
Entry** — a single-row pass through `fmBuildRegisterModel`/`fmOpenPrintWindow`,
not a separate hand-rolled receipt renderer.

## Outtake picker — the header-level "Outtake" button

Beside "Record Intake" in the page header (`fmOpenOuttakePicker`). Finishing a
job for a client used to mean finding their row and its small per-row button;
this picks the entry directly instead.

### Reworked 2026-08-10 — it opens showing the list

The first version rendered **nothing** until a client was chosen from the
autocomplete, so the modal opened as a lone search box at 520px (the state in
the user's screenshot) and the commonest case — someone at the desk, find
their file — was a blind search. Worse, a **walk-in intake** (`client_id`
null, which this module deliberately allows) could never be reached at all,
because the only way in was picking a directory client.

It now opens listing **every entry still with the firm** (`fmOpenEntries()`,
`status !== 'returned'`), **longest held first** — the same triage order the
ageing cards use, and the row most likely to be wanted. Each row carries
client + status badge, ref #/FY/received date, days held (red past
`FM_AGEING_ALERT_DAYS`), and what's still remaining, with one **Outtake**
button.

- Typing filters the visible list (`fmOuttakePickerRows`) across ref, client,
  PAN, FY and document names. **Plain substring, not Fuse** — the user is
  filtering against text they can already see, where a fuzzy near-miss reads
  as a bug.
- The client autocomplete still works and still **jumps straight in** when
  that client has exactly one open entry (`fmOuttakePickerSelect`).
- Empty states distinguish "nothing is with us at all" from "nothing matches
  that search", and the second one says how many entries clearing the box
  would show.

### The modal's own sizing (same pass)

`fm-outtake-modal` went 580px → **720px** (`.fm-outtake-modal`), and its
quantity list is now **one full-width row per document type**
(`.fm-outtake-items`, a 1-column override of `.fm-doctype-grid`) with larger
inputs (84×34, 14px). The intake form keeps the paired 2-column grid — only
the outtake copy changed, because it's the one filled at the counter while a
client waits. **All remaining / Clear** buttons (`fmOuttakeSetAll`) cover the
two ways it is actually filled; `All` reads each input's `max`, so it can
never exceed what is still with the firm.

## Register-wide Print / Preview / Export, and the Client Report

Same `ReportExport` engine (§4) and header-button shape as Audit Checklist /
Audit Report Finalization — **Print/Preview**, **Export PDF**, **Export
Excel** all read `fmFilteredRows()` (the exact same predicate the table
itself renders through, extracted once so the two can't disagree) and build
through **one** model builder, `fmBuildRegisterModel(rows, titleSuffix)` —
one row per `document_register` row, with `Outtake History` and `Remaining`
as full text (`fmOuttakeHistoryText`/`fmRemainingCellText`), not a truncated
preview. `fmOpenPrintWindow` is the achk/ARF `window.open('', '_blank')` +
`ReportExport.toHtml` + delayed `.print()` idiom verbatim.

**Client Report** (`fmOpenClientReport`) is the same model builder pointed at
one client's **entire** history instead — every `document_register` row for
that `client_id`, fetched fresh from Supabase (not from `fmEntries`, which
may be filtered, paginated, or simply not loaded if the tab was opened
elsewhere) and **ignoring the table's current filters on purpose**: this
answers "what has this client ever brought in and taken out", not "what's on
screen right now". Rendered on-screen via `ReportExport.toHtml` inside the
modal itself, plus the same Print/PDF/Excel buttons.

**This one feature serves two entry points, not two implementations.**
`fmOpenClientReport(client)` is called directly (header "Client Report"
button, client search, empty by default) and reused by `clients.js`'s
`cdOpenClientFileInOut(client)` — see [clients.md](clients.md) — so there is
exactly one "show me everything File In Out has on this client" code path,
not a File-In-Out-tab version and a separate Clients-tab version.

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

Built and exercised across four 2026-08-09 passes (Fiscal Year/quantities/
delivery mode → Outtake/partial-return → View Details/Outtake picker/Client
Report/exports) in the dev server against an in-memory stand-in for the table
(the sandbox has no Supabase session, so RLS blocks real writes): intake save
in both modes, validation rejections (including the reduce-below-sent guard),
edit round-trip with legacy picklist labels correctly falling into the Others
slot, status derivation across pending → partial → returned and back via
undo, the outtake modal's remaining-quantity defaults and caps, all 5
stat-card filters, document-type/fiscal-year/date/search filters, and a
full-tab regression sweep. `AuditLog` writes fail in the sandbox (no session)
and are swallowed as designed.

**Fourth-pass additions specifically verified**: `fmOpenDetail` renders
correct received/remaining per-type tables from a partially-outtaken row
(spot-checked: 2 received/1 sent → 1 remaining); `fmDetailPrint` opens a
window whose written HTML contains the register number, client name, the
outtake's contact name and the plain-text remaining figures; the outtake
picker's three paths (one open entry jumps straight in, several list for a
pick, zero says so) all confirmed with fabricated multi-entry data;
`fmPreviewAll`/`fmExport('pdf'/'excel')` ran to completion without throwing
over `fmFilteredRows()`; `fmOpenClientReport` correctly degrades to "No File
In Out records for this client yet" when Supabase returns zero rows (RLS with
no session denies rows silently rather than erroring, which is real Postgres
RLS behaviour, not a bug in this pass); a hand-built `ReportExport.toHtml`
render over two fabricated rows confirmed both appear with correct Outtake
History and Remaining text.

**Not verified**: the Clients-tab Docs column and `cdOpenClientFileInOut`
against a live `cdLoadFileInOut()` fetch (RLS blocks the read in this sandbox
too) — verified instead by directly seeding `window.cdFioSummary` and
confirming the badge renders and its click opens the shared Client Report
modal pre-loaded with the right client. Also not verified: live Supabase
writes under a real signed-in session, or a visual screenshot (this
sandbox's Browser pane doesn't render one).
