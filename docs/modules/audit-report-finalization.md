# Audit Report Finalization (§5.21)

**Code:** `js/auditReportFinalization.js` · **Prefix:** `arf-` · **Table:** `audit_report_finalization`
**Where:** sidebar, Core modules (after File In Out) · **Registry id:** `auditReportFinalization`

A shared status tracker used by multiple staff to record where a client's **IT
return, estimate return and tax clearance** stand for a fiscal year. It answers
"what's still outstanding before this client's audit report can close out"
without relying on people's memory or scattered notes. **Not tied to document
generation** — pure task-status tracking.

## The record model

**One record per `(client_id, fiscal_year, return_type)`**, enforced by a UNIQUE
constraint. The three tracks are separate pieces of work, entered by different
staff at different times, so each gets its own row and its own independent
status — a client can hold an IT Return record, an Estimate Return record *and*
a Tax Clearance record for the same year.

> Superseded 2026-08-09: v1 used one row per `(client, fiscal year)` covering
> all three tracks. The migration `db/2026-08-09_arf_v2_return_types.sql`
> backfilled every existing row to `return_type = 'it_return'`.

`client_id` is **NOT NULL, ON DELETE RESTRICT** — this module tracks directory
clients only (no walk-in case like `document_register`), and deleting a client
with tracking history fails loudly rather than silently losing it.

### The duplicate guard, and why it re-evaluates

`arfOnKeyFieldChange()` watches all three key fields — client, fiscal year and
**return type** — and loads a matching record for editing rather than letting a
save collide with the UNIQUE constraint.

The subtlety is that it must **re-evaluate when any of the three changes**, and
release an auto-matched record when the new combination has no match. `arfAutoMatched`
distinguishes a record the guard picked (re-evaluate freely) from one the user
opened with **Edit** (leave alone — they chose it deliberately). Without that
split, picking a client would latch onto their IT Return row and then switching
to Estimate Return would keep editing the IT row — a real bug caught in testing.
`arfSuppressKeyWatch` stops the watcher firing on the writes that populating the
drawer performs.

`arfSaveEntry()` **also** checks for a collision independently, so no path —
including changing the type inside an explicit Edit — can reach a raw Postgres
UNIQUE error.

## The finalization chain

The three tracks are **sequential in the firm's real workflow**: the estimate
return is only verified *after* the IT return is, and a **D-3** filing
additionally needs a tax clearance. So verifying an IT return is what makes the
follow-on work due, and the module opens it as a real record rather than leaving
it to memory:

| Saving an IT Return as **Verified** | Opens |
|---|---|
| `it_return_type = 'D-2'` | Estimate Return |
| `it_return_type = 'D-3'` | Estimate Return **and** Tax Clearance |

`arfCreateFollowOns()` runs after a successful IT-return save (insert *or*
update) whenever `it_verified === true`, inheriting the client, PAN, fiscal year
and auditor.

**The follow-ons are created as explicitly NOT verified / NOT cleared, not
merely blank.** A blank estimate row would derive to `not_submitted` and would
not appear under the *Estimate Not Verified* card — but the work genuinely *is*
outstanding the moment the IT return is verified, so `estimate_verified` is set
to `false` and `tax_clearance` to `false`. That is what makes the counts line
up: *N* verified IT returns produce *N* rows under Estimate Not Verified, and
each verified D-3 produces one under Tax Not Cleared.

**Idempotent by design** — a type that already has a record for that client and
year is skipped, so re-saving an already-verified IT return creates nothing. A
`23505` from a concurrent insert by another staff member is caught and ignored
rather than failing the save.

### The chain runs in both directions

`arfSyncFollowOns()` reconciles the follow-ons with the IT return's **current**
state on every IT-return save, so the link is reversible:

| Change to the IT return | Effect |
|---|---|
| Verified → **not** verified | Estimate Return *and* Tax Clearance withdrawn — both read **Not recorded** again |
| **D-3** → **D-2**, still verified | Tax Clearance withdrawn; Estimate Return stays |
| **D-2** → **D-3**, still verified | Tax Clearance opened alongside the existing Estimate Return |
| Re-verified after un-verifying | Both open again |

This matters because a follow-on left behind after its trigger was undone
reports outstanding work the firm does not actually owe.

**A follow-on that anyone has worked on is never removed.**
`arfIsUntouchedFollowOn()` gates every delete: a submission number, a name, a
date or a remark is enough to keep the row, and the save message then says it
was *kept, already has work recorded* rather than dropping it silently. Only a
row still in the exact state the chain created it — which carries no
information — can be withdrawn.

One consequence worth knowing: a **manually** created estimate or tax-clearance
record that is still completely blank is indistinguishable from a chain
placeholder, so saving an unverified IT return for that client and year will
withdraw it. Nothing is lost (the row held no data), but it can surprise.

### The chain banner

`arfRenderChainBanner()` draws a three-up strip in the drawer as soon as a
client and fiscal year are known, showing where all three tracks stand (with
"Not recorded" distinguished from "Not Verified") and outlining whichever track
is currently selected. It re-renders on every key-field change, and reads state
only — so it renders even while the record matcher is suppressed.

## Status is derived, never stored

There is no `status` column. `arfStatusKey(row)` computes a 4-key badge state
from the raw fields of whichever track the row belongs to, every time it's
needed — for the table badge, the status filter, the chart and the export text —
so none of them can drift apart from what was actually saved:

| Key | Badge | IT Return / Estimate Return | Tax Clearance |
|---|---|---|---|
| `not_submitted` | `badge-neutral` ⬜ | nothing entered yet | *(unreachable)* |
| `submitted` | `badge-amber` 📤 | submission no. or entered-by present, verified flag still null | *(unreachable)* |
| `verified` | `badge-sent` ✅ | verified flag is `true` | `tax_clearance` is `true` → **Cleared** |
| `not_verified` | `badge-error` ❌ | verified flag is `false` | `tax_clearance` is `false` → **Not Cleared** |

Tax Clearance relabels the two keys it can reach via `ARF_TAX_LABELS`
("Cleared"/"Not Cleared" — "verified" reads wrong for it) while sharing the same
badge colours. `WorkflowEngine.createStatusFlow` is used **only** for its badge
metadata; there is no `.transition()` call, because status here is a read of
saved fields, not a button-driven workflow.

## The form

A segmented **Type of Return** control (`.arf-type-picker`, styled after the
`.rep-view-btn` Edit/Preview toggle) reveals exactly one section:

- **Always:** Client + PAN, Fiscal Year (`ARF_FY_DEFAULT`, currently **2082/83**
  — the year the firm is working through), Date Recorded (defaults to today),
  Auditor (+ Other), Remarks
- **IT Return:** Type of IT Return (D-2/D-3) · IT Submission No. · Submission
  Entered By · Return Checked By · IT Verified
- **Estimate Return:** Entered By · Estimate Submission No. · Verification Status
- **Tax Clearance:** Obtained Yes/No → **Yes** reveals the date, **No** reveals a
  "Reason Not Cleared" textarea (`tax_clearance_remarks`). Switching clears the
  other field, so a stale date can't sit under a "No".

**Submission numbers are exactly 12 digits.** An input handler strips non-digits
and caps the length as you type, a live hint shows `8/12 digits` → `✓ 12/12`,
save rejects a partial number with a plain-English message, and a
`~ '^[0-9]{12}$'` CHECK enforces it in the database too — the UI is not the only
way in.

**"Other" replaces the value, on every picker.** The auditor list and both staff
lists end in `Other`, which reveals a free-text box; the typed name is written
directly into the column, replacing the literal `"Other"`. There is no
`*_other` column anywhere in this table. On reload, `arfFillStaffField()`
detects a saved name that isn't one of the fixed options and re-shows it in its
Other box. This is why **`auditor` has no CHECK constraint** — the list is open.

## Overview chart

One grouped bar chart above the table (`arfRenderChart`, Chart.js — already
loaded and pinned in `index.html`): three groups (IT Return / Estimate Return /
Tax Clearance) × three datasets (Verified/Cleared green, Not Verified/Not
Cleared red, Pending amber). It reflects the **currently filtered** rows, so it
answers "how is this auditor doing" as well as the whole portfolio. Tax
Clearance has no Pending bar by design — it is a two-state field.

Destroy-before-recreate on every render, the `vatCompliance.js` chart idiom.

## Date recorded

`recorded_date` answers "which day did we do this work?" — the module's second
axis alongside fiscal year. It defaults to today on a new record, is **editable**
(staff routinely log on Monday work actually done on Friday), and the filter bar
carries a **Recorded From / Recorded To** range so a week's or a day's work can
be pulled up and printed.

It is deliberately a **separate column from `created_at`**: `created_at` is the
immutable insert timestamp, `recorded_date` is what the user says happened.
Existing rows were backfilled from `created_at::date`, which was accurate since
nothing had been backdated yet.

The table's default order is `recorded_date desc` — newest work first, which is
the question the date filter exists to answer. Range endpoints are **inclusive**
on both sides (a From = To = one day shows that day's work), and the comparison
is plain ISO string comparison, no `Date` parsing. When a range is active the
printed/exported sheet gains a `Recorded <from> to <to>` subtitle, so an export
is still readable a month later.

Chain-created follow-on records are stamped with **today**, not the IT return's
recorded date — they become due when the IT return is verified, which may be
long after the return itself was logged.

## Stat cards clear the filters

Seven cards: Total Records · IT Verified · IT Not Verified · Estimate Verified ·
Estimate Not Verified · Tax Cleared · Tax Not Cleared. `ARF_FILTERS` drives both
the counts and the filtering from one definition, so they can't disagree.

**Clicking a card clears every dropdown filter, the date range and the search
box first.** A
card's number counts the whole portfolio, so leaving stale filters applied would
show fewer rows than the card advertises — which reads as a bug.

## Table

`TableEngine` (Tabulator), 25/page. Columns: FY · Client (+PAN) · Type (badge,
with the D-2/D-3 suffix on IT rows) · Auditor · Entered By · Checked By ·
Submission No. · Status (badge) · Recorded · Actions. `arfRowEnteredBy`/`arfRowSubmissionNo`
pick the right column for the row's track, so one column serves both IT and
Estimate; fields that don't apply to a type render the em-dash.

## Gotchas

- `it_verified`/`estimate_verified` are **nullable** booleans (`null` = not yet
  reviewed). Don't default them to `false` — every new record would read as "Not
  Verified" instead of "Not Submitted". `tax_clearance` is deliberately NOT NULL
  and two-state.
- Saving uses an explicit `if (arfEditingId) update else insert`, **not**
  `upsert` — an upsert would silently overwrite `created_by` on every edit.
- Writes to non-applicable tracks are nulled on save: an Estimate Return record
  never carries IT columns, so a type changed mid-edit can't leave the previous
  track's data behind.
- The v2 rollback (`..._rollback.sql`) **cannot** cleanly reverse the auditor
  rename or per-type rows — read its header before running it.

## Deliberate scope limits

- **Directory clients only** — no walk-in case.
- **Not linked to document generation or the OCR pipeline** — this tracks
  status, not documents.
- **The auditor list holds FIRM names, not partner names** (renamed 2026-08-09):
  `Shailesh & Associates` and `Dallakoti & Company`, matching `REP_FIRMS` in
  `js/config.js`. `Non-Sign`, `Lila Adhikari` and `Surya Poudel` sit alongside
  them, plus `Other`.

## Verified

Built 2026-08-09 (v1) and reworked the same day (v2). Exercised in the dev
server with the auth wall bypassed via DOM manipulation and a hand-seeded
7-record dataset covering all three types (no real Supabase session in this
sandbox, per CLAUDE.md §2/§12):

- Migration verified live via the Supabase MCP **before** the JS changed: all 7
  live rows survived, carry `return_type='it_return'`, and the 6 renamed auditor
  values read as the new firm names.
- Type switching reveals exactly one section; the duplicate guard follows the
  type (IT → id 1, Estimate → id 4, Tax → id 6 for the same client+year) and
  releases to a blank New Record when the combination has no match. **This is
  where the auto-match bug was caught and fixed.**
- Save-time collision check rejects a type change inside an explicit Edit that
  would collide with an existing record.
- 12-digit enforcement: letters stripped, length capped at 12, live hint
  correct, partial number rejected on save.
- Tax Clearance Yes/No reveals the right field and clears the other.
- Auditor "Other" round-trips (typed name saves and re-opens in the Other box).
- All 7 stat cards: counts match a hand count, and each clears all four
  dropdowns plus the search box on click.
- Chart datasets match the hand-counted seed exactly and re-render on filter
  change.
- Excel export re-read via ExcelJS — all 12 columns correct across all three
  record types, including "Cleared"/"Not Cleared" and the not-cleared reason
  landing in Remarks. PDF generates without throwing.
- Regression sweep across Dashboard, VAT Compliance, Clients and File
  Management; no console errors beyond the expected 401 from a deliberate
  unauthenticated-save test.

The finalization chain was exercised against an in-memory stub of the table
(so inserts could actually land without a session):

- **D-2 verified** → exactly one follow-on, Estimate Return, deriving to
  `not_verified`. No tax clearance created.
- **D-3 verified** → both Estimate Return and Tax Clearance, both outstanding.
- **Idempotency** — re-saving an already-verified IT return created 0 rows.
- **Not verified** — saving an IT return with `it_verified = false` created no
  follow-ons at all.

Reversibility (added after the one-directional version shipped and the gap was
reported) was verified over a full round trip:

- **Verify → un-verify → re-verify** a D-3: both follow-ons appear, both are
  withdrawn, both come back; the drawer banner reads **Not recorded** for both
  tracks while un-verified.
- **Real work is protected** — with a submission number and staff name on the
  estimate row, un-verifying withdrew only the untouched Tax Clearance and
  reported *"Estimate Return kept, already has work recorded"*.
- **D-3 → D-2 while still verified** withdrew Tax Clearance and left Estimate
  Return in place.
- Resulting stat cards: 2 IT Verified → 2 Estimate Not Verified, 1 Tax Not
  Cleared (the single D-3), which is the count relationship the chain is for.
- Banner: hidden with no client; full three-track chain once client+year are
  set; the `current` outline follows the selected type; "Not recorded" shown
  for tracks with no row.
- `AuditLog` writes failed against real RLS during this test and were swallowed
  without breaking the save — the documented behaviour, confirmed incidentally.

`recorded_date` (added the same day) was verified against a 4-record seed
spanning four dates:

- Migration checked live first — all 20 production rows backfilled from
  `created_at::date`, column NOT NULL with a `current_date` default.
- Range filter: From-only, To-only, a closed window, a single day (From = To,
  **inclusive** at both ends) and a no-match range all returned exactly the
  right rows; the chart followed the filtered set.
- Clicking a stat card clears the date range along with the other filters.
- Form: new record defaults to today and FY **2082/83**; opening an existing
  record loads *its* stored date (2026-07-20) rather than overwriting with today.
- Export/print: `Recorded` is the leading column, all 13 headers present, and an
  active range adds a `Recorded <from> to <to>` subtitle.

**Not verified this round:** the `.xlsx` binary could not be re-read via ExcelJS
— the promise stalled under browser-tab throttling with the preview pane not
compositing. The model feeding it was verified through the synchronous HTML
path, and the identical `toExcel` call was re-read successfully in the two
earlier rounds, so this is a harness limitation rather than a known defect.

**Not verified:** a live authenticated write (insert/update/delete succeeding
end-to-end), and the **visual** appearance of the new chart card and segmented
picker — the browser pane could not composite a screenshot in this session, so
layout/spacing was confirmed structurally only. Worth a real save pass and an
eyeball check after deploying.
