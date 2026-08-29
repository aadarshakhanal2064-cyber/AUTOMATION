# Autobooks (Sales & Purchase Book)

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the Autobooks module — everything in code still says `salesPurchaseBook` / `spb-`.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.9 Autobooks (`js/salesPurchaseBook.js`, `spb-` prefix)

> Displayed as **Autobooks** since 2026-07-25 (Automation Hub menu). Everything in code — the file, the `spb-` prefix, the `salesPurchaseBook` module id, every function name — still says Sales & Purchase Book.
Automated reporting workbook from the two raw books a client maintains (Sales / Purchase: Date, Bill No., Party Name, Pan No., Tax Free, Taxable Amount, Vat — B.S. dates `2081.04.01`; the Purchase sheet may also carry Taxable Import, Import VAT, Capital Purchase and Capital VAT). Upload one workbook or two files (sheet names matched by Sales/Bikri · Purchase/Kharid, derived-sheet names skipped so a generated workbook can be re-uploaded); output is a 7-sheet .xlsx via ExcelJS with live formulas: Sales, Sales Summary (party-grouped alphabetical with subtotal rows), Sales Details (one `<Party> Total` row per party, taxable desc, cross-sheet formulas + a Grand Total that ties to the book), the Purchase trio, and Monthly (fiscal-month totals + VAT-return reconciliation).

### 2026-08-14 — the module was completely dead, and what fixing it changed

Autobooks threw on **every** import from 2026-08-10 until this date. Two globals it calls did not exist:

- **`stringSimilarity`** — called in three places and **never defined anywhere in the app**. `spbFuzzyMonthMatch` calls it for any alpha token missing from the alias table, including the word `"total"` in every `TOTAL OF <MONTH>` row, so it threw a `ReferenceError` on the first subtotal row of the first sheet parsed. The module's own comment claimed the parser was "exercised headlessly by the verification harness" — that harness defined the helper and was never committed, which is exactly how this shipped. It now lives in `js/utils.js` as a **Damerau**-Levenshtein ratio; the transposition case is load-bearing (`bharda`↔`bhadra` scores 0.667 under plain Levenshtein and 0.833 under Damerau, and that one pair was dropping a Rs 2,184,000 row out of a real client's purchase book).
- **`VAT_MONTH_ORDER`** — lived in `js/vatCompliance.js` and was deleted with that module on 2026-08-10 (commit `1353f99`). It is now `SPB_MONTH_NAMES`, local to this module (its only consumer). Spellings match the firm's own reconciled file — `Ashwin`, `Mangshir`, `Baishak` — don't "correct" them.

Both threw inside `reader.onload` **outside** the `try/catch`, so the user got a permanent "⏳ Reading…" and no error. `spbFinishRead()` now wraps the whole downstream pipeline, and the reader has an `onerror` so the pending counter always reaches zero.

**`tools/spbVerify.mjs` is the fix for the root cause** — a dependency-free Node harness that `vm`-loads the real module with stubbed engines and asserts against a real client workbook. Run it before touching the parsing path:

```bash
node tools/spbVerify.mjs
```

Measured against `Data entry.xlsx` (Jaya Shree Mahalaxmi Traders 2082.83), the fixes moved these:

| | before | after |
|---|---|---|
| Purchase transactions / taxable | 44 / 64,607,457 | **45 / 66,791,457** — ties to the firm's own reconciled Grand Total |
| Sales transactions / taxable | 264 / 73,802,436.60 | unchanged (must stay unchanged) |
| Phantom "unreadable date" blockers | 270 | **0** |
| Month checksums matched | n/a (crashed) | **12/12 on both books** |
| Data Doctor state | 270 red blockers | 1 amber warning |
- **The raw sheets embed 12 month-subtotal rows that duplicate the transactions** (a naive sum doubles). Stripped on import (dateless rows matching `/total/i`), regenerated in the output as live SUMs.
- **"As Per VAT Return" is typed by the user, never derived** — the reference file proved filed figures differ from book by real amounts (up to 3.7M). Filed figures are whole rupees by **truncation** (not rounding), so the reconciliation tolerance is <1 rupee; anything ≥1 flags as a gap (`SPB_ROUNDING_TOLERANCE`). VAT joins the verdict even though only Taxable/Taxfree get printed Diff columns (the firm's layout). Typed figures autosave to localStorage keyed `(company, FY)`.
- **Party merging is two-level**: trivially-safe normalization (case/whitespace/trailing period/`PVT.LTD` punctuation, `spbSafeKey`) auto-merges; everything looser (shared PAN, similar spelling) goes into a per-name-checkbox review list the user applies per file. PAN suggests but never decides — one PAN in the reference file spans two unrelated companies. Subtotal rows carry a PAN only when the group's rows agree on exactly one.
- **An identical name is NOT proof of one entity either** (a live client file had two real, unrelated companies both named "Muktinath Food Products"): `spbPansBySafeKey`/`spbGroupKey` split a safeKey into one group per distinct PAN whenever it carries more than one, disambiguated in the display as `"<Name> (PAN <pan>)"`, and surfaced in the review list defaulting UNCHECKED — checked-by-default is reserved for identical-fuzzy-text members with NO PAN conflict between them (`clusterHasConflict` in `spbBuildSuggestions`, checked against the whole cluster, not just the anchor). Only a well-formed **9-digit** PAN (`spbIsValidPan`) counts as split/conflict evidence — a typo'd PAN (e.g. one digit dropped) is reported as a data-quality note (`stats.malformedPan`) but never used to split or to flag a conflict, and never dilutes a subtotal's otherwise-unanimous PAN.
- Deliberate fixes vs the firm's hand-built file (output won't tie cell-for-cell): uniform `Return − Book` diff sign in both Monthly sections, Monthly total row sums every column, Details serial header is `S.No.`, plus a Remarks column and Grand Total rows. FY dot format (`2081.2082`) in sheet titles — a fourth FY format, per the §9.5 rule.
- Rows with unreadable dates are **excluded and loudly reported** (they can't be month-grouped); dates outside the chosen FY, VAT≠13% rows, missing PANs and credit notes are surfaced as import warnings.
- **Date parsing falls back to B.S. month names** ("Baishakh", "15 Baishakh 2082") when the strict numeric date fails — some clients' books are kept that way instead of pure date-wise, and some have no per-row date at all: the whole "Date" column is headed "Month"/"Months" (`SPB_DATE_HEADER_RE`, also मिति/महिना) and every cell just names the month, sometimes misspelled ("Sharawan", "Chiatra"). Recognized via an exhaustive alias table (Latin + Devanagari; Devanagari digits normalized) plus a fuzzy-similarity fallback (`spbFuzzyMonthMatch`, `stringSimilarity`) for unanticipated typos — never for unrelated text (min length 4, ≥0.75 similarity). A bare month name only resolves if a fiscal year is selected (year inferred from the month's half of the FY); a missing day defaults to the 1st, always reported in the import summary, never a silent guess. The filename is also cross-checked against the selected FY (`spbGuessFyFromText`) and flagged if they disagree, since a wrong FY selection silently mistags every such row's calendar year (month grouping stays correct either way).
- **Checksum layer**: the stripped embedded subtotals are kept as the client's own independent record and compared per month against the computed totals (`spbComputeChecksums`, tolerance 0.015) — a mismatch means the client's file is internally inconsistent, pointed at the exact month. A pre-generate tie-out (`spbTieOut`) refuses to write a workbook whose transactions/groups/monthly layers disagree. Both reference files pass 24/24 with zero false alarms.
- **Data Doctor** (`spbBuildIssues`/`spbDoctorAction`): detects bad dates, checksum mismatches, outside-FY rows, VAT≠13%, possible duplicate entries (same party+bill+amount), malformed PANs (suggests the party's valid PAN), fillable blank PANs, and sales bill-number continuity gaps (IRD audit point). Each gets an inline fix or an explicit "keep as-is"; fixes are stored as row-level overrides in `spbOverrides` and **re-parsed from source** (`spbReparse`) — never mutated in place — logged to `spbCorrectionLog`, written into the workbook as a "Corrections" sheet, and recorded via AuditLog. Readiness banner: red = rows excluded, amber = warnings, green = ready.
- **Column mapping UI** (`spbRenderMapping`): sheets whose headers aren't auto-recognized are kept (header `null`) and the user assigns Date/Party/Taxable etc. by hand — any column layout becomes importable. "Adjust columns" in the import summary re-opens it for override. The amount half of `SPB_MAP_FIELDS` is derived from `SPB_AMOUNT_FIELDS`, and `spbMapFieldsFor(section)` hides the purchase-only boxes on Sales.
- **Row liveness** (`spbRowIsLive`): a row counts as data only if it names a date, party or bill, **or** carries a non-zero amount. The old test (`any cell !== null && !== ''`) treated a numeric **0** as content, so the ~100 trailing rows Excel keeps alive with a `=F59*13%` formula each became a red *blocking* "unreadable date" issue — 270 of them on one real file, burying every genuine finding. This is also what lets the generated data-entry template (which pre-fills those formulas) round-trip cleanly.
- **Blank VAT is filled at 13%; a typed VAT that disagrees is not** (2026-08-14, user). The fill is counted in `stats.vatFilled` and stated on the face of the import summary — it changes the figures, so it is never silent. A present-but-wrong VAT stays a `vatOutliers` Data Doctor card with a one-click fix, because a disagreeing VAT is often how an entry error is caught. `stats.nonNumeric` reports text typed into an amount column (`"here"`, `"name M"` — all seen in a real book); it still reads as 0, but the user is told which cell.
- **A subtotal's month comes from the rows it sums, not its label.** A real client file labels one block `TOTAL OF SHRAWAN` over Bhadra's rows; keying the checksum off the label checked Shrawan twice and left Bhadra unchecked. `spbMajorityFi()` resolves the block, the label is cross-checked against it (`subtotalLabel` amber issue), and `spbComputeChecksums` compares the client's figure against **the block it covers** rather than the whole fiscal month — exact when a month is written as more than one block.
- **Fiscal year defaults to a fixed `SPB_FY_DEFAULT = '2082-83'`**, matching `ARF_FY_DEFAULT` / `SM_FY_DEFAULT`. Deriving it from `NepaliLocale.todayBs()` opened a book being written in Shrawan 2083 on F.Y. 2083-84, when every such book is for the year just closed. The FY window itself was already right (`mon >= 4 ? fy : fy + 1`, day accepted to 32 — 2082.04.01–2083.03.32 is one year). When ≥80% of rows fall outside the selected year and agree on one other, a single `fySelector` card offers to switch, instead of one card per row.

### Taxable Import and Capital Purchase (2026-08-14, user decision)

Purchase books may carry four extra columns: `Taxable Import`, `Import VAT`, `Capital Purchase`, `Capital VAT`. Sales keeps the firm's original seven.

- Everything is driven by **`SPB_AMOUNT_FIELDS`** — adding a VAT-return box means adding one entry there, not touching the parser, the tie-out, the grid and the workbook separately. `SPB_HEADER_RULES` is ordered **most specific first** and that order is load-bearing: "Taxable Import" contains *taxable*, and "Import VAT"/"Capital VAT" both contain *vat*.
- **Capital is entered separately but filed inside Taxable Purchase** — `spbReturnTaxable()`/`spbReturnVat()` add it back, and that is what the Monthly sheet and the on-screen grid compare against the filed return. Capital is still shown, as a *memo* column ("of which Capital"), so the staff member can see what went into the total. Import is its own box on the return and is **never** folded into taxable.
- `spbVrModel(section)` describes the comparison once and is consumed by both `spbRenderVrGrid` and `spbSheetMonthly`, so the screen and the workbook cannot show different columns. `spbBookLayout(section)` does the same for the Book/Summary/Details sheets.
- The extra columns appear in the output **only when the uploaded sheet had them** (`spbSectionAmountKeys` reads `header.col`). Printing an all-zero Capital column on every book would be noise, and inventing a column the source never had is the sort of silent difference this module exists to avoid. Existing 7-column books import and export byte-identically.
- `spbTieOut()` covers every amount column. A new box that failed to reach the party groups or the monthly totals would otherwise print a wrong workbook silently.
- `spbVr` carries a slot for every comparable field regardless of section, and `spbVrLoadDraft` **tops up** an older `{t,v,f}`-shaped localStorage draft rather than discarding it — a staff member who typed twelve months of a filed return must not lose it to an upgrade.

### PAN-only clients (`spb-regtype`)

A client registered for PAN and not VAT charges no VAT on **sales** but still pays 13% on purchases from a registered vendor. The selector defaults from the client's `tax_registration_type` (a property of the client — **not** `vat_status`, §15) and is always assigned, never conditionally, so a client with the field blank can't inherit the previous client's setting. In PAN-only mode the sales blank-VAT fill is off and a non-zero sales VAT raises a `panOnlyVat` card.

### Download data-entry format (`spbDownloadTemplate`)

A blank workbook in exactly the layout the importer reads: **Sales** (7 columns) and **Purchase** (11), 300 rows with the 13% VAT formulas pre-wired, a month dropdown on the Date column, and a **"How to fill"** sheet covering the date formats, the 2082.04.01–2083.03.32 fiscal-year rule, what Tax Free / Import / Capital mean, and the PAN-only case. Downloads through `DocumentEngine.downloadBlob` so it lands in the Activity Log. `spbClassifySheet` returns null for "How to fill", so a filled template re-uploads without that sheet being misread.

### Auto-corrected typos (`spbAutoFix`) — narrows a §15 rule

Two classes are applied automatically (2026-08-14, user decision):

| Detector | Gate |
|---|---|
| `panOutlier` — one party name, 2+ valid PANs | minority PAN is edit distance ≤ 1 from the majority **and** the majority has ≥5× its rows |
| `nameTypo` — one valid PAN, several spellings | `stringSimilarity(fuzzyKey) ≥ 0.90`, both names ≥ 6 chars after normalization |

This **narrows** "Autobooks never auto-merges parties on PAN"; it does not reverse it. The two cases that rule protects are untouched — one PAN spanning two *unrelated* companies fails the name gate, and one *name* spanning two real entities is a PAN **split**, which neither detector performs. Everything looser still goes to the review list, unticked.

Every auto-fix runs through `spbSetOverride(..., auto=true)`, so it is logged, exported in the Corrections sheet, and cleared by "Reset corrections" — and it appears in the Data Doctor as an `autoFix` card **with an Undo**, so "automatic" never means "invisible". `spbAutoUndone` stops a reparse silently reapplying what the user rejected. `spbReparse` parses, auto-fixes, then parses once more (never a loop — the second parse already has the overrides). On the reference file this collapses `Dipika Trade link`, `Arpit Traders`/`Arpit Trades` and `Shreeganga And Sons Trader(s)` into one party each, and catches three single-digit PAN typos.

**`js/salesPurchaseBook.js` is now ~2,360 lines** (CLAUDE.md §10 rule 5). The Excel-generation half (`SPB_MONEY` onward) is ~600 of them; when it passes ~900 on its own, split it into `salesPurchaseBookExport.js` following the `finStatement.js` / `finStatementExport.js` precedent.
- **Workbook styling**: every total row is highlighted — yellow (`SPB_FILL_YELLOW`) for month/party subtotals and Monthly totals, amber for Details Grand Totals, light red across Monthly mismatch months; credit-note negatives in red font; auto-filters on all header rows.


---

## The ledger layer (`js/salesPurchaseBookLedger.js`, 2026-08-16)

Autobooks was stateless from launch: upload a raw book, generate a workbook,
close the tab, everything gone. That is the correct shape for a converter and
the wrong shape for the work that follows it. A signed confirmation letter
comes back from a customer or supplier **weeks** after the book was imported,
one party at a time, and each figure has to sit beside that party's book total
until the whole list reconciles. Re-uploading the workbook to type one more
figure is exactly the Excel workflow this module exists to end.

So Autobooks now has a database (`db/2026-08-16_autobooks_ledger.sql`, four
tables) and the screens that memory makes possible. The new file owns three
things: the **section switcher**, **save/load of a book**, and the **on-screen
Register and its print output**.

### Why a second file

`salesPurchaseBook.js` was already ~2,360 lines and this doc already called for
splitting before growth, not after. The `spb` function prefix and the `spb-`
element prefix continue unchanged — this is one module in two files, the
`finStatement.js` / `finStatementExport.js` precedent. The load order is
load-bearing: the ledger file reads and writes `spbData`, `spbGroups`,
`spbMergeMap` and friends, so it must come **after**.

Three hooks were added to the original file, all guarded with `typeof … ===
'function'` so the core still works if the ledger file fails to load:
`spbReset()` → `spbLedgerReset()`, `spbOnContextChange()` → `spbLedgerOnContext()`,
`spbReparse()` → `spbLedgerAfterReparse()`.

### Rehydration is the crux

`spbLoadBook()` turns stored bill lines back into parser-shaped transactions and
then runs them through the module's **own** `spbComputeBook()` /
`spbComputeGroups()`. Figures are always re-derived; nothing is read back from a
stored total that could have drifted from its lines. That is also what lets
every screen downstream have exactly one code path whether the book came from an
upload or from the database.

A loaded book deliberately gets **no `spbRaw`**. There is no uploaded sheet
behind it, so Data Doctor, column mapping and reparse are correctly unavailable
— those answer *"is this file being read correctly"*, and the file was read and
corrected before it was saved. The corrections travel with the book
(`correction_log`) and still print in the workbook's Corrections sheet.

`spbLedgerOnContext()` looks for a saved book silently on every client/FY change
— coming back to a client mid-confirmation is the common case and a mandatory
"Open" click would be noise — but it **returns early while `spbRaw` is set**, so
a user mid-correction on a freshly dropped file never has it silently replaced.

### The save contract

| | |
|---|---|
| `autobooks_entries`, `kind='regular'` | **Replaced** on every save. The uploaded file *is* the register, so a re-import supersedes it. |
| `autobooks_entries`, `kind='omitted'` | Untouched. Typed by hand, not in the uploaded file. |
| `autobooks_parties` | Only **missing** rows are created; `party_name`/`pan` are refreshed (a later merge improves both). `confirmed_taxable` / `opening_balance` / `confirmed_closing` are **never** written by a save — they came off a signed letter. |

That one-way contract is why `autobooks_parties` stores no book figures at all:
storing them would let the two drift after a re-import.

Rows insert in chunks of 400 (`SPB_INSERT_CHUNK`) — a real client-year runs to
~1,600 lines and one request that size is both slower and harder to recover from
than five. Reads go through `sbFetchAll()`, since a sales register alone
routinely exceeds PostgREST's 1,000-row cap (the reference file: 989 lines).

### `book_key` is a generated column

A book is one (client, fiscal year), and the client may be a directory client
*or* a name typed by hand — Autobooks legitimately gets used on a company before
anyone adds it to the directory, the same nullable-`client_id` fallback
`service_memo_fee_skips` uses. A plain `UNIQUE (client_id, fiscal_year)` would
not constrain the typed-name case at all, because NULL never conflicts with NULL
in Postgres. Hence `coalesce('c:'||client_id, 'n:'||lower(client_name)) || '|' ||
fiscal_year`, generated and uniquely indexed.

Saving is **select-then-insert-or-update**, not a PostgREST upsert: the
uniqueness that matters lives in a generated column, which an upsert would have
to name as its conflict target while not sending it in the payload. Two round
trips, no ambiguity.

### Saved books — the browse drawer (2026-08-22)

`spbLoadBook()` answers *"is there a book for the client and fiscal year on
screen"*, which is the right question mid-work and the wrong one when the
question is *"which books do we have?"* — reopening last month's work meant
remembering the exact client and year first, and the name typed on a walk-in
book is precisely what nobody remembers a week later. Until this shipped there
was no route to a saved book at all until a client and year were already
selected.

`spbOpenSavedBooks()` is therefore the **same shared drawer** the Audit Report
Builder browses its saved reports through — `DocumentStore.openPicker()` in its
`{fetchRows, describe, onChoose, onDelete}` form, fed from `autobooks_books`
instead of `saved_documents`, exactly as Projection Report and Depreciation
already do it. One list, one search box, one empty state, one delete confirm for
the whole app. Reached from the page header (**Saved books**), from the
saved-book card, and from the empty state on the four gated screens.

- **Search matches what a row RENDERS as** (`DocumentStore.filterRows`), so the
  fiscal year, the PAN and the registers held are in `describe()` precisely to
  make them searchable — the client name alone is not how staff look for a book.
  Substring first, Fuse only as a fallback, which is what stops `2077` scoring
  as a fuzzy hit against every other year.
- **Opening sets the two things that IDENTIFY a book and lets the ordinary
  context path fetch it** (`spbOpenSavedBook()`, the `depLoadSaved()` idiom) —
  there is one rehydration, not two that can drift. It goes through
  `spbScope.select()`, which clears the previous client's import *and* ledger
  state before anything loads; verified by opening a walk-in book and then a
  directory client's, with no bill line surviving the switch.
- **`spbSetFyOption()` adds a year the selector doesn't carry.** The dropdown
  spans a fixed window, so an older book's year has no option and `sel.value =
  fy` would silently leave the year alone — quietly opening a *different* book
  than the one clicked. The same bug `depSetFyOption()` was written for;
  verified against a 2077-78 book with the selector opening at 2078-79.
- **Deleting cascades**, so `spbDeleteSavedBook()` names what went in a toast
  rather than leaving "record deleted" to understate a year of typed
  confirmations. If the deleted book is the one open on screen, `spbBookId` is
  cleared (`spbLedgerReset()`) — left alone it would point at a row that no
  longer exists, the gated screens would keep rendering, and the next Save would
  insert a second book instead of updating. The figures on screen stay; only the
  stored identity drops.

### The Register view

The register as the firm reads it on paper: bills in fiscal-month order, a
`Total Of <Month>` line after each month, and — after the Ashadh total — the
omitted bills, exactly where the firm's own template says they belong
(*"Omiited bill show display in last of Sales Register and Purchase register
after total of month ashad"*).

- **Two totals, always.** `Register total (excluding omitted bills)` and a Grand
  Total that names how many omitted bills it includes. An auditor has to be able
  to see both numbers without arithmetic.
- **A return / debit note carries the opposite sign** (`spbOmittedSign`). This is
  not cosmetic: in the reference file Party G's books (202,328.28) exceeded
  its confirmation (167,432.16) by exactly 34,896, and the explanation was a
  34,896 **debit note**. Applying the sign closes the gap to 0.12.
- **`spbLedgerCols()` is value-driven, `spbSectionAmountKeys()` stays
  header-driven.** They look like duplicates and are not — the workbook must
  mirror the uploaded layout exactly, while a database-loaded book has no
  uploaded sheet to consult, so the screen decides a column by whether any row
  actually carries a figure.
- `spbRegisterModel()` is shared by the on-screen table and the print view, so
  the two can never show different figures.

### `spbPrintDoc()` redefines its own design tokens

The print window is standalone — `css/styles.css` is **not** loaded into it — so
`var(--amber-bg)`, `var(--red-dk)` and `.log-badge` resolve to nothing there.
Left unfixed, the omitted-bill band prints with no highlight and a credit note's
negatives print black instead of red: correct on screen, wrong on the only copy
anyone signs. This is the same failure mode as `.rep-blank-fill` (CLAUDE.md
§15), which reached a client's printed report. The token block at the top of
`spbPrintDoc()`'s stylesheet must stay in step with `:root`.

### Verified 2026-08-16 against a real client file

Driven through the real pipeline with `the reference client workbook`
(989 sales lines / 650 parties, 353 purchase lines / 28 parties):

| | computed | firm's own `Monthly` sheet |
|---|---|---|
| Sales taxable, full year | 77,796,847.785 | 77,796,847.785 ✓ |
| Purchase taxable, full year | 77,456,337.168 | 77,456,337.168 ✓ |

`node tools/spbVerify.mjs` still passes 36/36 — the parsing path is unchanged.

---

## Omitted bills (M2, 2026-08-16)

A bill that wasn't available when the year's register was entered and closed.
It surfaces later, is entered on its own screen rather than back-dated into a
closed month, and still has to reconcile against the party's confirmation.

### The hard part is the party, not the amounts

In the reference file, **three of the seven** omitted-bill parties are spelled
differently from the same party in the purchase register:

| Party | How the two spellings differ |
|---|---|
| A | one extra letter in the company name |
| B | a different transliteration of the same Nepali name, plus a dropped word |
| C | the same extra letter as A (a related company) |

In Excel those silently become separate parties and a human reconciles them by
eye. Here, an omitted bill filed under a new party key would never close the
difference it exists to explain, and nothing would say so. Their **PANs match
exactly in every case**, so:

- the party is **picked** from the book's own party list (`spbOmPartyList()`),
  which sets `party_key` directly;
- typing a PAN that resolves to **exactly one** party links it automatically;
- a PAN on **more than one** party offers the candidates as buttons, largest
  taxable first, instead of refusing and leaving the user to hunt. This is real:
  the client's own book has PAN-A typed onto both *Party A*
  (57 rows, Rs 31.9M) and *Party D* (1 row, Rs 25,221 — a
  data-entry error). Refusing to guess stays right; the dead end did not.
- a genuinely new party is still allowed, and is labelled as one out loud.

**The bill keeps its own spelling.** `party_name` stores what the user typed —
the late bill really is spelled differently — while `party_key` is what
makes the totals combine. The omitted-bill table shows `<bill spelling> →
<register spelling>` so the join is visible rather than implied. `spbOmSetParty()`
therefore fills the name box **only** when the party was picked by name from the
autocomplete; choosing by PAN leaves the typed name alone.

`spbOmPlainName()` strips the `(PAN …)` suffix `spbComputeGroups()` appends to
disambiguate same-named companies — that suffix is a picker device and must
never be stored on a bill or printed beside register rows that don't carry it.

### Entry conveniences, both matching the firm's own sheet

- **Bill Total → taxable + VAT.** The reference sheet's columns are TOTAL,
  TAXABLE, VAT in that order, and 207,774.98 / 1.13 is exactly the
  183,871.6637 it records. `spbOmFromTotal()` offers that, and **never
  overwrites a figure already typed** — a bill with a tax-free part doesn't
  divide out cleanly.
- **Blank VAT filled at 13%** (`spbOmFillVat`), the same rule the importer
  applies to an uploaded sheet, and as there a VAT that is present but
  disagrees is left exactly as typed. Off for sales on a PAN-only client.
- **Dates accept a bare month name.** The reference sheet writes "Magh",
  "Asar" with no day or year, so the field goes through the importer's own
  `spbParseMonthNameDate()` rather than a second date reader.

### Sign, and the two totals

`spbOmittedSign()` gives a return or debit note the opposite sign. The
omitted-bills table shows "Net effect on the … register" rather than a plain sum
for exactly that reason, and the register keeps its two total lines.

### Verified 2026-08-16 against the real file

All seven omitted bills entered from **bill totals alone**, party linked by PAN:

| | computed | firm's own workbook |
|---|---|---|
| Party A, omitted taxable | 342,973.44 | books-vs-confirmation gap 342,973.44 ✓ |
| Party F, omitted taxable | 1,040,793.37 | omitted-sheet total 1,040,793.37 ✓ |
| First bill, taxable / VAT from total 207,774.98 | 183,871.66 / 23,903.32 | 183,871.6637 / 23,903.3163 ✓ |

### `AuditLog` — `record_ref` is a bigint

Every call in this file first passed a descriptive string as `recordRef`, which
made Postgres reject the insert outright: the **whole event was lost**, not just
the reference. `record_ref` takes a numeric row id and nothing else; everything
descriptive belongs in `detail`, and `module: 'salesPurchaseBook'` must be set or
the event can't be attributed (`window.ACTIVITY_MODULES` scopes on it). Event
types are `spb_`-prefixed to match `spb_correction`, and their display labels
live in `window.ACTIVITY_EVENT_LABELS`.

---

## Confirmation ledger (M3, `js/salesPurchaseBookConfirm.js`, 2026-08-16)

The inbound leg of confirmation work, and the reason Autobooks needed a
database at all. A signed letter comes back from a customer or supplier stating
what **they** think the year's taxable trade was; this screen puts that beside
the firm's own books, party by party.

Not to be confused with the **Confirmation** module (`js/confirmationLetters.js`,
`cl-`), which generates the letters that go *out*. This records what comes back.

### Books = register + that party's omitted bills

Deliberate, and the single most important line in the module. In the reference
file every flagged party's gap is explained exactly by a bill that surfaced
after the register closed. If "Taxable as per books" were the register alone, a
fully reconciled party would still read as a gap. So `spbConfirmRows()` sums the
group **plus** its omitted bills (signed), and the on-screen table shows
`Taxable — Books`, `Omitted` and `Taxable — Total` as three separate columns so
the arithmetic is visible rather than asserted.

### Rules, all taken from the workbook

| | |
|---|---|
| `SPB_CONFIRM_TIER` = 100,000 | the Annexure-13 split. Tiering is on taxable **including** omitted bills — that is the party's real trade for the year. |
| `SPB_CONFIRM_TOLERANCE` = 1,000 | *"Mark Green if Difference is Less than 1000"* / *"Mark Red if … more than 1000"*. |
| Difference = **Books − Confirmation** | user decision 2026-08-16, the firm's own reconciled file's convention. Negative = the books are SHORT of what the party confirmed, which is what an omitted bill then fills. |

**A confirmation that hasn't arrived is not a confirmed zero.** `confirmed ==
null` gives status `pending`, never `ok` — keeping those apart is what stops an
unanswered party being reported as agreed. The single-party statement says so in
words on the printed page.

### Tiers are sections, not a sort

The two tiers each get a heading, their own totals row, and a combined Grand
Total, because Annexure-13 reports them differently. The **<1 lakh tier starts
folded** (`spbCfShowMinor`) — its heading, count and totals are always visible,
but a sales register with 650 parties would otherwise render ~2,600 inputs on
open. Folded, the reference purchase book renders 80.

### Editing saves per field, and never re-renders the table

Every figure here is typed off a signed letter, so each saves on `change` rather
than behind a Save button someone can walk away from. `spbCfRecompute(idx)`
patches only the difference cell, the status badge and the totals **in place** —
a full redraw while someone tabs through 200 parties would throw away their
focus and scroll position on every field. Tiers key off books taxable, which
typing can't change, so rows never move and patching stays safe.

A party first met on an **omitted bill** has no `autobooks_parties` row until
its first edit; `spbCfSetField()` inserts one then. Such parties are listed with
an "Only on omitted bills" note — leaving them out is how a late party gets
forgotten.

### Why a party is flagged, when that is knowable (`spbCfHint`)

Two causes account for almost every real difference, and the flag names the
likely one instead of leaving the user to work it out:

- **books short, no omitted bills** → *"try an omitted bill"*;
- **the key is still in an unapplied merge suggestion** → *"possible duplicate
  party — see Import › Possible duplicate parties"*.

The second is not hypothetical. One purchase row in the reference file carries **another party's PAN on a Party A bill**. Autobooks
correctly splits that party into a 57-row group (Rs 31,904,997.07) and a 1-row group
(Rs 626,504.45) — an identical name is not proof of one entity (§15) — and the
confirmation then comes up short by *exactly* that 1-row group. The firm's own
workbook grouped by name alone, summed to 32,531,501.52 and never saw the typo.
The merge review already offers the fix; the hint just points at it.

### Opening balances carried forward (`spbCarryForwardOpenings`)

§2.4's carry-forward. Finds the prior year's saved book for the same client,
matches on `party_key`, and writes last year's `confirmed_closing` into this
year's `opening_balance`. It **only ever fills a blank** — overwriting an
opening balance someone already typed would silently rewrite audited work — and
reports how many were filled, how many parties weren't in last year's book, and
how many had no closing balance recorded.

### Exports go through `ReportExport`

A plain tabular report, so it uses the engine (CLAUDE.md §8) rather than a
hand-rolled generator: `section` rows are the tier headings, `total` the tier
totals, `grand` the combined figure. `ReportExport.download()` builds, saves and
logs through `DocumentEngine` in one call. The per-party and bulk **statements**
are separate — they are a document, not a grid — and print through
`spbPrintDoc()` like every other Autobooks preview.

### Verified 2026-08-16 against the real file

The workbook's own 16 "as per confirmation" figures typed against the purchase
register, with all 11 omitted bills entered: **14 matched, 1 flagged, 14
awaiting** of 29 parties.

| Party | Books | + omitted | = total | Confirmed | Diff | |
|---|---|---|---|---|---|---|
| Party B | 800,508.97 | 531,132.80 | 1,331,641.77 | 1,331,641.77 | **0.00** | matched |
| Party G | 202,328.28 | −34,896.00 *(debit note)* | 167,432.28 | 167,432.16 | **0.12** | matched |
| Party K | 1,965,265.18 | — | 1,965,265.18 | 1,965,265.18 | **0.00** | matched |
| Party A | 31,904,997.07 | 342,973.44 | 32,247,970.51 | 32,874,474.96 | **−626,504.45** | flagged → the PAN typo above |
| Party D | 303,429.71 | — | 303,429.71 | *(none)* | — | awaiting |

Both export formats generate (PDF 12 KB, XLSX 10 KB). `node tools/spbVerify.mjs`
still passes 36/36.

---

## Annexure-13 (M4, `js/salesPurchaseBookAnnexure.js`, 2026-08-16)

The tax annexure the whole ≥/< 1 lakh tiering exists for. Exactly the ten
columns the template's own header row names, in its order — this is the sheet
that gets filed, so it carries no working columns.

### One row per PAN, not per party

A party can be both customer and supplier. The reference file's PURCHASE
CONFIRMATION sheet carries a *Sale Taxable* column for precisely that case
(Party J, PAN-D: purchased 575,575.50, sold 96,404), and the
annexure is keyed on the tax ID, so both sides meet on one line.

It follows that **a party with no usable PAN cannot be reported at all**. Those
are set aside into their own red panel with the party name and the amount at
stake, and pointed at Data Doctor — the difference between a known omission and
a silent one. Six such parties in the reference file.

### The four purchase buckets are two axes, and only one is a question

| Axis | Where it comes from |
|---|---|
| **Goods vs Service** | a property of what the party supplies — **asked**, defaulting to Goods |
| **Capital vs Others** | a property of the **bill**. Autobooks already reads a *Capital Purchase* column into `cap`, so this is **derived** |

Asking a user to re-classify a party whose own book already states which rupees
were capital would be guesswork stacked on fact. A book with no capital column
lands everything in Others, which is correct. Capital is a **slice of** taxable,
not an addition to it (§ *Capital is entered separately but filed inside Taxable
Purchase*), so Others is the remainder — `Capital + Others` always equals the
party's taxable. Sales has no capital dimension; the annexure has no
`ServiceSalesCapital`.

Category is stored per `(book, section, party)` in
`autobooks_parties.ann13_category`. One PAN can cover several party keys, so
setting a category writes **every** row under that PAN on that side.

### Two bugs this module caught during its own verification

**1. The trade name was picked by name length.** `a.names` counted occurrences
and broke ties on the longer string, so PAN-A — Rs 32.2M, of which
99.92% is *Party A* and 0.08% is *Party D* (the mistyped
PAN, above) — was labelled **Party D**. Filing an annexure line for
Rs 32.2M under a company that contributed Rs 25,221 is not a cosmetic problem.
Names are now weighted by **value**.

**2. `a[key] = r` kept one row per side and silently dropped the rest.** When
two party groups share a PAN, the second overwrote the first — and since
`qualifies` keys off those totals, PAN-A read as Rs 25,221.60, fell
below the threshold, and **dropped off the annexure entirely along with its Rs
32.2M**. Seven PANs were affected; qualifying rows went 33 → 40 once each side
became a list (`salesRows`/`purchaseRows`) with accumulated totals. The
regression guard is that every rupee in a bucket must tie back to the taxable it
came from — it does, to 0.00.

A PAN carrying more than one party name now shows *"One PAN, N names — also
entered as: … Check this before filing."*

### Threshold, and the escape hatch

A PAN qualifies if **either** side reaches Rs 1,00,000, since a party can be a
large supplier and a trivial customer and dropping the small side would
under-report the line. *Include parties below Rs 1,00,000* is one checkbox away
and off by default (user decision, 2026-08-16).

### Opening balances from a sheet (`spbAnnImportOpenings`)

The template's own *"Upload opening balance of F.Y for Ann-13"*. The
Confirmation tab's carry-forward covers a client the firm has already run
through this app; a client's **first** year here has no prior book, and typing
two hundred opening balances by hand is exactly the work being replaced. The
header row is located by looking for a *PAN* column and an *opening* column
anywhere in the first 25 rows, matching is on PAN, and — like the carry-forward
— it **only ever fills a blank**, reporting what it filled, what already had a
value, and which PANs aren't in this book.

### Verified 2026-08-16 against the real file

660 PANs, **40 qualifying**, 6 unreportable, 2 parties on both sides.

| Check | Result |
|---|---|
| Party J, both sides on one line | purchase 575,575.50 / sales 96,404 — matches PURCHASE CONFIRMATION exactly |
| Buckets tie back to source taxable | 0.00 difference across all 660 PANs |
| Capital split (synthetic 1,000,000 of 5,090,019.29) | 1,000,000 Capital + 4,090,019.29 Others = 5,090,019.29 |
| Goods → Service toggle | moves the full amount between buckets on both sides |
| Export columns | the template's ten headers, in the template's order |

Both formats generate (PDF ~10 KB, XLSX ~9 KB). `node tools/spbVerify.mjs`
still passes 36/36.

---

## Reconciliation statements (M5, `js/salesPurchaseBookReco.js`, 2026-08-16)

The year-end statements that prove the filed returns and the books tell the same
story, and name every reason they don't. Three of them — Sales, Purchase, VAT —
laid out exactly as the firm's own Reco sheet is.

**Distinct from the Monthly grid**, which compares month by month. This is one
statement for the year, with ad-hoc adjustment lines, because which mistakes
exist varies per client and per year. Nothing is hardcoded to a month.

### It runs from the return to the books, so an adjustment is `book − return`

Verified against the reference sheet before writing a line of it: its Ashadh
adjustment of 87,710.14 is book 887,710.14 less return 800,000, and its Jestha
line of −50,000 is book 200,000 less return 250,000.

⚠ **This is the opposite sign to the Monthly grid**, which prints a uniform
`Return − Book` difference. Each is internally consistent and neither is
changing — the same "formats differ per module, don't unify without asking"
rule as the fiscal-year formats (CLAUDE.md §8).

### Both anchors are derived, never typed

The return figure is the one already entered in the Monthly reconciliation grid
(stored on the book); the books figure is computed from the register. An
override would create a second source of truth for a number this app already
holds — and *"the real figure differs, here is why"* is exactly what an
adjustment line is for. When no filed figures have been entered the statement
says so and points at the Monthly grid, rather than quietly reading nil.

### Rounding, and what is never absorbed

*"if Difference is less than 1000 then round off Difference"* — the sheet's own
note. Below Rs 1,000 the residual is absorbed as Rounding Effect; **at or above
it, nothing is absorbed** and the Net Difference stands on the face of the
statement with a red note naming the amount. A gap of a thousand rupees is not
rounding.

`spbRecoSuggestable()` uses the same threshold the parser already uses for a
real gap (`SPB_ROUNDING_TOLERANCE`, 0.999) rather than suggesting sub-rupee
lines: the filed return is truncated to whole rupees, so a 19-paisa gap is not a
"calculation mistake" worth a named line. On the reference sheet this is exactly
right — Falgun +0.19 and Chaitra −0.07 stay unnamed and net to the **0.12
Rounding Effect the sheet itself prints**.

### Automatic lines vs typed lines

Omitted bills appear as an **automatic** line (`Purchase omitted in Maskebari`),
derived from the Omitted Bills screen rather than stored — a figure copied
across would drift the moment one was edited there. Everything else is a free
text description and a plain amount, added by hand or by *Suggest from monthly
differences*, which creates ordinary editable lines (the firm does this
arithmetic by hand today; the button is the same sums without the retyping).

### A bug the third statement caught

The VAT statement's `books` anchor omitted the VAT on omitted bills while its
automatic line subtracted that VAT from the **return** side — the two ends of
the statement were built differently and it could never foot. Sales and Purchase
had always added their omitted figure to books; VAT now does too.

### Verified 2026-08-16 — reproduces the template's Reco sheet cell for cell

Driven from the template's own Monthly figures:

| | computed | the template's Reco sheet |
|---|---|---|
| Sales as Per Maskebari | 8,368,605.00 | 8,368,605 ✓ |
| Suggested adjustments | Jestha −50,000 · Ashadh +87,710.14 · Jestha exempt −120,000 · Ashadh exempt +10,000 | the same four lines, same wording ✓ |
| Less: Rounding Effect | 0.12 | 0.12 ✓ |
| After Adjustment | 8,296,315.26 | 8,296,315.26 ✓ |
| Sales as Per Accounts | 8,296,315.26 | 8,296,315.26 ✓ |
| **Net Difference** | **0.00** | **0** ✓ |

Purchase (with omitted bills 250,000 less a 50,000 return) and VAT both foot to
0.00 as well; a synthetic Rs 5,000 gap is correctly **not** absorbed and is
flagged unexplained. Both export formats generate.
`node tools/spbVerify.mjs` still passes 36/36.

---

## VAT return import (`js/salesPurchaseBookVatReturn.js`, 2026-08-16)

Fills the **As Per VAT Return** side of the Monthly reconciliation from the
firm's own *VAT Return Detail* sheet, instead of twelve months × up to five
boxes being retyped for every client. Button lives on the Monthly
reconciliation card; the boxes stay editable afterwards.

### This does not break "typed, never derived"

CLAUDE.md §15 says the As-Per-VAT-Return figures are typed by the user and
never derived. That rule exists because **filed figures genuinely differ from
the book** — by millions in the first reference file — so they must never be
*computed from the register*. These are still the filed figures; they are read
from the document that records them rather than copied by hand off the same
document. Nothing in this file looks at the book.

### Three columns are all headed "VAT"

The sheet runs `Taxable Sales · VAT · Tax Free Sales · Taxable Purchase · VAT ·
Tax Free Purchase · Taxable Import Purchase · Vat · …`, so a VAT column means
nothing on its own and everything in relation to the taxable column on its left.
`spbVriMapColumns()` therefore walks the header left to right, and each anchor
claims the **next bare VAT column to its right**. Header text alone cannot do
this.

`SPB_VRI_ANCHORS` is ordered **most specific first**, load-bearing for the same
reason `SPB_HEADER_RULES` is: `/taxable.*purchase/` would swallow *Taxable
Import Purchase*, and `/tax free.*purchase/` would swallow *Tax Free Import
Purchase*.

### What it refuses to guess at

- **"Total" and "Opening" rows are skipped by name**, not left to the month
  matcher. `spbFuzzyMonthMatch` exists precisely because it is willing to guess,
  and a guess here would corrupt a real month.
- **Tax Free Import Purchase has no box** in the reconciliation. A non-zero
  figure there is reported, never silently dropped.
- **An unrecognized column is named in the summary** rather than ignored.
- **A typed figure that disagrees with the file is replaced and listed**, month
  by month, old value → new value. The filed return is the authority for these
  boxes, but overwriting someone's work quietly is not acceptable.
- **The sheet's own Total row is checksummed** against the sum of its twelve
  months — the same idea the raw-book importer applies to embedded subtotals. A
  mismatch means the uploaded file is internally inconsistent, and it is the
  file's own arithmetic saying so.
- **Company name and fiscal year are cross-checked** against the selection above
  and disagreements are surfaced — writing one client's filed figures onto
  another's reconciliation is the failure worth catching — but never blocked.

### Verified 2026-08-16 against a real client's three documents

A client whose folder holds the raw book, a *VAT Return Detail* sheet, and a
hand-reconciled Autobooks workbook — so the import can be checked against
figures a human already produced from the same return.

| | Result |
|---|---|
| Header located | row 5, month column B, past three title lines |
| Columns mapped | 9, including all three ambiguous VAT columns resolved to `sales.v`, `purchase.v`, `purchase.impVat` |
| Months read | 12 · 95 figures filled |
| File's own Total row | ties to the sum of its months, both books |
| Against the hand-reconciled workbook | **23 of 24** month figures identical |

The 24th is a real discrepancy between two of the firm's own documents, not an
import fault: the VAT Return Detail sheet's Ashwin taxable sales is Rs 300,000
higher than the same figure in the reconciled workbook, and the sheet's Total
row carries the higher number too. The import loads what the document says and
the reconciliation flags the month — which is the behaviour wanted.

### The save affordance (fixed 2026-08-17, reported from live use)

The four screens that need a saved book (Omitted Bills, Confirmation,
Annexure-13, Reconciliation) were unreachable in practice, because **the Save
button was not on screen when it mattered**. Three separate faults:

1. `spbRenderBookCard()` rendered a bare sentence and **no button at all** when
   `spbBookIdentity()` was null. Before a client was picked there was therefore
   no save affordance anywhere in the module — which reads as "this app has no
   save", not "you are one step away from it".
2. **The card was never redrawn when the tab opened.** `spbInit()` builds the
   fiscal-year options, which changes the answer to "can this be saved", but the
   card had last been drawn at page load with the selector still empty. It sat
   on "choose a client and fiscal year" even after a year was set.
3. **`spbLoadBook()`'s catch didn't re-render the card**, so any failed lookup
   pinned it on whatever it last showed — on the first lookup, the empty state.

Now: `spbSaveBlockedReason()` is the single answer to "why can't this save yet",
used by the card and by all four gated screens; the button is **always drawn**,
disabled with that reason in place of a vague message; and `spbSaveGateHtml()`
gives each gated screen its **own working Save button**, so the user saves from
where they hit the wall instead of being sent to another tab. Saving then
re-renders the section they were on, rather than leaving them to click back.

---

## In-app Data Entry — the smart sheet (M6, `js/salesPurchaseBookEntry.js`, 2026-08-29)

The step before the upload, brought inside the app. Staff used to type the
year's bills into Excel and upload the file here; the **Data Entry** section
tab (between Import and Register) is a spreadsheet that knows the firm's data,
built because employees' spelling and PAN mistakes in Excel were the single
biggest source of downstream corrections. What Excel cannot do, this sheet
does at the keystroke:

- **Party names autocomplete from everything the client's books already
  hold** — the rows typed so far, the open book's party groups, the stored
  confirmation-ledger parties, and the client's **prior-year saved books**
  (fetched silently from `autobooks_books`/`autobooks_parties`, so the very
  first bill of a new year already knows last year's suppliers). Picking a
  party fills its PAN and jumps focus to the Taxable cell; typing a known PAN
  fills the party back.
- **A PAN that contradicts the party's established PAN goes red on the spot**
  with the known PAN named; a PAN belonging to a *different* party warns. The
  directory's display spelling and PAN are both decided by **weight**, the
  Annexure-13 lesson — a one-row typo never out-votes the real entry — and a
  malformed PAN never becomes a party's PAN.
- **Blank VAT completes at 13% of its taxable while the row is still under the
  user's eyes** (off for a PAN-only client's sales, the importer's own rule).
  A VAT the user typed or corrected is theirs — the autofill lets go the
  moment the cell is hand-edited.
- **Dates carry forward row to row** and accept every form the importer reads:
  `2082.4.1`, `4.15` (year inferred from the F.Y.), a bare `15` (continues the
  row above), month names with all their observed misspellings, Devanagari.
  Normalized on commit to the canonical `YYYY.MM.DD`. **Sales bill numbers
  auto-increment** on a fresh row (zero-padding preserved); purchases get no
  such guess — those are other people's bill numbers.
- **Enter moves down the column** (the spreadsheet reflex), a new seeded row
  is always waiting at the bottom, and the view is **one fiscal month at a
  time** (pills with live counts; "Whole year" available) so a 1,600-line
  register never renders 17,000 inputs — the confirmation grid's lesson.
  Cells are patched in place, never re-rendered mid-typing.

### Not a second parser — the crux

Typed rows are converted to the exact `{rows, header}` shape an uploaded sheet
produces (`spbEnSheet`) and pushed through the module's **own** `spbParseRows`
→ `spbComputeBook` → `spbComputeGroups` on every committed edit — the same
contract `spbLoadBook()` follows for rehydration. `spbData[section].source`
reads `'Manual entry'`. Register, Monthly reconciliation, Confirmation,
Annexure-13, Reco, the generated workbook and Save all read the result with no
new code path. The synthetic header includes a purchase-only column **only
when some row carries a figure in it** (value-driven, the `spbLedgerCols`
idiom), so a typed book cannot invent an all-zero Capital column — and
`spbSectionAmountKeys()` itself gained the same value-driven fallback for any
book without `spbRaw`, fixing a real pre-existing gap where a workbook
generated off a *loaded* book silently dropped its Import/Capital columns.

A typed book carries **no `spbRaw`**, exactly like a loaded one — the grid is
the correction surface, so Data Doctor/column-mapping/reparse are correctly
absent. While an uploaded file IS open, the Data Entry tab gates itself shut
(two editors over one book is how they drift) and offers a one-way,
confirm-guarded switch (`spbEnAdoptImport`): the corrected rows become the
sheet and `spbRaw` closes.

### Rows, drafts, and who wins

- **A row is INERT while it holds only a date and bill number** — exactly what
  the carry-forward seeds a fresh row with. Inert rows are typing surface, not
  data: excluded from the parser, totals, counts and drafts, or every seeded
  blank would print as a zero-amount bill (this shipped as a bug in the first
  browser test and is asserted in the harness).
- **Drafts autosave to localStorage keyed (client, FY)** — the `spbVr` idiom
  (`spbEntryDrafts`, 20 newest kept). A restored draft **re-applies itself as
  the module's book**, or Save/Generate/Register would read "nothing imported"
  while a full sheet sits on screen.
- **Draft vs saved book is decided by timestamp, twice.** At first render the
  book row may not have loaded yet (async), so the decision is re-made in
  `spbEntryOnBookLoaded()` with the real `updated_at` in hand: a newer draft
  re-applies over the loaded book; an older one steps aside for it.
- **Rows typed under "(NO CLIENT)" follow the client picked next** (same FY
  only) — they can only have been typed on purpose. Between two real clients
  nothing ever carries over (§9 scope rules); `spbEntryReset()` clears the
  grid on client switch and the draft stays under its own key.

### The grid's autocomplete is deliberately not SearchEngine.attachAutocomplete

The engine binds a document-level click listener per attached input; a grid
re-issues its cell inputs on every structural render, which would accumulate
dead listeners by design. The grid runs ONE delegated dropdown styled as the
shared `.autocomplete-list`, ranked starts-with → word-start → substring (the
CommandPalette precedent — prefix intent, not fuzzy matching, is what "k" →
"ko" → "kot" means). Every single-input picker elsewhere stays on the engine.

### Verification — `node tools/spbEntryVerify.mjs`

60 assertions, vm-loading the REAL core + ledger + entry files (the
`spbVerify.mjs` pattern): date normalization (16 forms including Devanagari),
bill sequencing, synthetic-sheet column inclusion, directory weighting and
ranking, typed rows through the real pipeline (VAT fill, month grouping,
safeKey merging, capital-slice arithmetic, value-driven workbook columns), the
book → sheet → book round trip, and per-row validation (PAN conflict, VAT
deviation, F.Y. window). **Run it before and after touching the entry sheet or
anything it feeds**, alongside `node tools/spbVerify.mjs` (still 36/36).
Browser-verified 2026-08-29 against the dev server: suggestion pick, PAN-first
entry, conflict flagging, month pills, register totals, draft reload, and a
full section/tab regression sweep with a clean console.

### Full screen (2026-08-29, user ask — "exactly like Excel")

**⛶ Full screen** in the sheet's toolbar expands the card over the whole
viewport (`.spb-en-full`, `position: fixed; inset: 0`), with the grid flexed
to fill, the prose hidden, and the toolbar carrying what is otherwise out of
sight: the client · F.Y. context chip and a **Save book** button
(`spbEnSave()`, which mirrors `spbSaveBook()`'s outcome into a toast — the
ledger status box lives on the Import tab and is invisible here). Esc exits,
after the autocomplete has had its turn. **The choice is sticky**
(`spbEntryFullscreen` in localStorage — a UI preference, not client data), so
once chosen the sheet opens full screen on every visit.

The trap worth remembering: `.tab-panel.active`'s fadeIn animation applies a
`transform`, and a transformed ancestor becomes the containing block for
`position: fixed` — the "full screen" card pinned itself inside the panel.
Worse than a 0.25 s blink: in a non-compositing tab the animation freezes on
its first frame and the transform is permanent. So while full screen is on the
host panel carries `.spb-en-fullhost` (`animation/transform: none`); the
switch animation is untouched otherwise. Body scroll is deliberately NOT
locked — a body class would stick if the user palette-jumped to another tab
while full screen — `overscroll-behavior: contain` on the grid wrap handles
the chaining instead.

### Duplicate bill numbers — the rule is OPPOSITE on the two registers (2026-08-29)

Told to us by the firm, and it is not one test with two labels. The registers
number bills from **different ends of the transaction**:

| | Whose number it is | Duplicate key | A clash means |
|---|---|---|---|
| **Sales** | the firm's OWN invoice number, one sequence for the year | the **bill number alone** | a real mistake — Hanuman Supplier and Lateswori Supplier cannot both hold sales bill 1 |
| **Purchase** | the **supplier's** number, and every supplier counts from their own 1 | **party + bill number** | only the same supplier billing one number twice |

Two suppliers sharing purchase bill 1 is an ordinary day and must never be
flagged; that false alarm is what the old shared test produced. Sales clashes
are `err`, purchase repeats are `warn` (a supplier's own numbering is
occasionally messy, and nothing here blocks output).

**The amount is deliberately no longer part of either key.** The first version
keyed on party + bill + amount, so two bills sharing a number escaped notice
whenever their amounts differed — which is precisely what a mistyped bill
number produces.

`spbEnBillKey()` reads `0012` and `12` as one bill (leading zeros stripped
from the trailing digit run) while a prefix keeps two series apart (`A/1` ≠
`B/1`).

### A finding says WHERE it is, and clicking it goes there

*"1 possible duplicate bill"* left a staff member to find it among 1,600
lines, which is the work this module exists to remove. Every finding now
carries **month · row · party** and its own sentence naming the other side
(*"Sales bill 1 is also on Lateswori Supplier — Bhadra, row 1"*), the Bill
cell itself turns red, and clicking the finding switches to that month,
scrolls to the row, flashes it and puts the cursor in the cell
(`spbEnGoToRow`). The row number is counted **exactly the way the month view
lists rows** (`spbEnRowLabel` — undated rows appear in every month), so it
matches the grid's own `#` column. Missing sales bill numbers are named too
(`5, 9–11`) rather than counted; a jump of 50+ is read as a new series, not a
gap.

`spbEnGoToRow` captures the row OBJECT before re-rendering, never its index —
`spbEnRenderRows()` compacts inert rows out of the array, so an index taken
beforehand can point at a different bill by the time the grid is redrawn.

**The cache stamps what it was built from** (`spbEnDups()` records section and
row-array identity). The duplicate rules being opposites makes a stale cache
worse than a stale number: sales findings read while the purchase sheet is on
screen would flag every supplier sharing a bill number. Caught by the harness,
and now structurally impossible however the accessor is reached.

### Keyboard navigation (2026-08-29, user ask — only Tab worked)

Enter and ↓ move down the column, ↑ up, ← → across; the edge stops rather than
wrapping, as Excel does, and moving down off the end opens the next row.
Leaving a cell commits it, so autofill and validation have run before the next
cell is reached.

The rule that makes one key set serve both jobs: **← and → move a cell only
when the caret has nowhere left to travel** — at the very start, at the very
end, or when the **whole value is selected**, which is how a cell just arrowed
into sits. Without that last case the arrows died at the first cell holding
anything, since landing on a cell selects its text. A caret placed inside a
word still edits text.

Two bugs this surfaced, both real:

- **An open autocomplete survived a re-render**, holding a reference to a
  detached input — and it swallows the arrow keys while it believes it is
  open, which is how the whole grid appeared to have no keyboard navigation.
  `spbEnRenderRows()` now hides it.
- **The "this VAT was auto-filled" flag does not survive a draft reload**
  (drafts store the typed columns, not internal state), so after reopening a
  book, correcting a taxable left yesterday's VAT sitting beside it. Derived-
  ness is now read from the FIGURES as well as the flag: a VAT that is exactly
  13% of the amount being replaced was plainly derived from it and follows the
  correction. A hand-typed VAT is still never touched — it is flagged instead.

### Data Entry is the FIRST tab, and the landing section (2026-08-29, user ask)

Typing the book in the app is how a book starts now; uploading a spreadsheet
is the fallback. `SPB_SECTION_TABS.unshift(...)`, and `spbLedgerReset()` returns
to `SPB_SECTION_TABS[0].key` rather than a hardcoded `'import'`, so the order
follows whichever parts of Autobooks have registered. `spbInit()` re-shows the
current section on every tab open, so its `onShow` runs against the fiscal
year just built rather than the empty selector it was last drawn with.

---

## Following the CA's workbook (2026-08-30)

The firm supplied its CA's own *Sales & Purchase* workbook for a real client
year and asked the app to follow it. It has eight sheets — Sales, Purchase,
Monthly, Sales Details, Purchase Details, omiited, **Classify**, Reco — and
carries instructions written for this project in as many words, including a
column headed *"Remarks for Claud Code"*. What it settles:

| The CA's sheet | What it means for Autobooks |
|---|---|
| **No Confirmation sheet at all** | the as-per-confirmation figures are two COLUMNS on Sales/Purchase Details. Confirmation is something a party HAS, not a screen you visit. |
| `Difference = I + H − G` on Details | difference is **Confirmation − Books**, the reverse of what this app printed. |
| **Classify** (new) | Sales: Goods/Service. Purchase: Goods/Assets/Expenses — and that choice is what fills Annexure-13. |
| omiited derives from the Details difference | a party's unexplained gap IS its omitted amount; the "+" expands to bill-wise detail. |
| Reco's two numbered headings | every adjustment is derived, nothing is typed. |

His own notes, verbatim: *"By Default it should Good Sales"* · *"Remove Total
After Party name"* · *"Goods should auto fill Goods Purchase others in Ann-13"*
· *"Assets should auto fill Goods Purchase Capital in Ann-13"* · *"Expenses
should auto fill Goods Purchase others in Ann-13"* · *"Sales should auto fill
Sales in Ann-13"* · *"Service should auto fill Service in Ann-13"* · *"if we
click + Sign then it will should Bill wise detail of party and entry bill wise
remarks"* · *"Eye Should be there to view individaual confirmation"* · *"If we
have Enter as per Confirmation then Confirmation letter should display Sales
free sales & Taxable Sales as per Confirmation [otherwise as per our
records]"* · *"If Pool A/B/C/D is selected then it should auto fill in
Depreciation module as per Income Date Date Wise"*.

### The reconciliation, rebuilt (`js/salesPurchaseBookReco.js`)

Structural, not cosmetic. The statement used to be free-text adjustment lines
someone typed, seeded by a *"suggest from monthly differences"* button. The
CA's format has **nothing to type**:

```
<X> as Per Maskebari
1. Difference due to Calculation mistake in maskebari
     Add:   / Less:    ← each month's book-minus-return gap, split by sign
2. Difference due to Bill omiited or excess entry
     Add:   / Less:    ← omitted bills, split by sign
Less: Rounding Effect
<X> as Per Maskebari After Adjustment
<X> as Per Accounts
Net Difference
```

**That format is complete by construction**, which is why the free-text lines
were removed rather than left unused: every month's gap is captured under
heading 1 and every late bill under heading 2, so
`return + Σ(gaps) + omitted` **is** the book figure. The statement foots
arithmetically, Net Difference reads nil, and a hand-typed line on top could
only double-count. Sub-rupee gaps route to Rounding Effect rather than being
named month by month — the filed return is truncated to whole rupees, so a
19-paisa gap is not a "calculation mistake".

Two further blocks the app did not have: a **VAT Reconciliation Statement**
(opening position + return VAT, then 13% of the *taxable* adjustments only —
tax-free carries no VAT) and the **Cross Check of VAT Payables (Receivables)**
that rebuilds the closing position from the opening one. `(−)` is a
receivable, `(+)` a payable, printed on the statement as he prints it.

**Two figures are typed, and they ride in the `vat_return` jsonb** rather than
new columns (so this half needed no migration): the opening VAT position from
last year's financial statements, and any prior-year purchase adjustment not
yet adjusted. Neither is derivable from this year's register.

**`node tools/spbRecoVerify.mjs` — 40 assertions replaying his figures.**
Every line of all three statements plus the cross-check reproduces exactly,
including the **−0.30 rounding line**, which the app reaches only by routing
Magh's sub-rupee gap to rounding instead of naming it. The harness also pins
the footing property (with no omitted bills, with an arbitrary one, and with
no return filed at all) and proves the VAT statement still reports a real
divergence it cannot absorb.

### A duplicate-definition bug this uncovered

`js/salesPurchaseBook.js` defined **`spbReturnTaxable` and `spbReturnVat`
twice**: an earlier pair reading `.taxable`/`.vat` (a *transaction's* keys) and
a later pair reading `.t`/`.v` (a *month's*). Function declarations hoist, so
the later pair silently won every call and the earlier one was dead code that
still read as the documented contract. A caller written against it got the
capital figure alone — no error anywhere. Now one definition, month-shaped
because that is what both real callers pass; a transaction adds `taxable + cap`
directly. Both existing harnesses still pass, which is what proves the surviving
behaviour is the one the app already had.

### Confirmation is gone; the screen is now **Parties**

Renamed and reshaped to his Details sheet. Display-name-only, the convention
the four renamed modules follow — the file, the `spbCf` prefix, the `confirm`
section key and the `spb-sec-confirm` panel all keep their names (CLAUDE.md §5).

- **Difference is now `Confirmation − Books`**, reversing the 2026-08-16
  decision. His convention reads the way the work is done: a POSITIVE
  difference means the party reports more trade than the register holds, which
  is a bill still to enter — the figure and the fix now point the same way.
- **`As per Confirmation Tax Free` joins `As Per Confirmation Taxable`.** A
  letter states both, and compared total-to-total as he does. A client with
  exempt trade could never reconcile without it.
- **Either figure arriving counts as the letter having come back** — a party
  with only exempt trade confirms a tax-free figure and nothing else. The
  "a confirmation that hasn't arrived is not a confirmed zero" rule is intact.
- Tier bands, totals and the grand total were a blue band, a cream row and an
  amber row competing on one wide grid; they now use one neutral token, with
  structure from weight and rules.

### Pending: `db/2026-08-30_autobooks_ca_workflow.sql`

Three additive nullable columns on `autobooks_parties` — `confirmed_taxfree`,
`classify`, `classify_note`. **Shipped code-first** (CLAUDE.md §15): a
PostgREST `PGRST204` on one of them is caught, the field reports that the
migration is pending, and every other figure on the screen saves normally. So
the code is a no-op against a database that has not received it.

### Still to do from his workbook

- **Omitted Bills** — party-wise summary derived from the Parties difference,
  with the "+" expanding to the bill-wise entry that already exists.
- **Classify + Annexure-13** — the Goods/Service/Assets/Expenses picker and
  its auto-fill mapping into the annexure's buckets, plus the asset-class hand
  off to Depreciation.
- **Excel output** — *"Remove Total After Party name"*, and Details/Classify/
  omiited/Reco sheets in his layout.

### Classify → Annexure-13 (2026-08-30)

His "Classify" sheet is what fills the annexure, and he wrote the mapping out:

| Classification | Side | Annexure-13 bucket |
|---|---|---|
| Goods *(default)* | Sales | Good Sales |
| Service | Sales | Service Sales |
| Goods *(default)* | Purchase | Good Purchase — Others |
| **Assets** | Purchase | **Good Purchase — Capital** |
| Expenses | Purchase | Good Purchase — Others |

Read by `SPB_ANN13_BUCKET_OF`, one table serving both the Classify card and
the annexure so the screen and the filing cannot disagree. **Service purchase
stays available** even though none of his three values reaches it — dropping it
would make a service purchase unreportable, and the annexure has a bucket for
it.

**This makes Assets a second source of the Capital axis**, which §15 previously
said was derived from the book's Capital Purchase column alone. Both now feed
it, and the column WINS where it exists: a bill stating which rupees were
capital is a fact, and finer-grained than a party-level judgement. Assets is
what answers the same question for a book with no capital column, which is
most of them — and then the whole line is capital. Never both, or the same
rupees file twice. Verified live: a Goods party carrying a 150,000 capital
column on 600,000 taxable splits 150,000 Capital / 450,000 Others, while an
Assets party's 400,000 goes wholly to Capital with nil in Others.

The **Classify card** is a folded `<details>` at the top of Annexure-13 rather
than an eighth tab, and lists **every** party on both sides — his sheet does,
and the annexure's own table shows only the qualifying tier by default, so a
sub-lakh party would otherwise be unclassifiable. Parties with no usable PAN
are listed read-only with the reason: they cannot reach the annexure at all,
and offering a picker there would be a dead end. Choosing Assets or Expenses
reveals the sub-classification he asks for beside it — the SLM depreciation
class (offered from `DEP_SLM_CLASSES`) or the expense head — as a datalist
combo, so the vocabulary is offered without refusing a head it doesn't carry.
Changing away from Assets/Expenses **clears the note**: a depreciation class
left on a party now classified as Goods reads as a live instruction.

`classify` supersedes `ann13_category`, which only ever held the sales pair;
rows saved before this still answer through the old column, and writes keep it
in step so a rollback of the migration leaves Goods/Service working.

### Omitted Bills — what is still missing, by party

His `omiited` sheet is one row per party whose confirmation differs from the
books, tax-free and taxable halves, with a "+" expanding to bill-wise detail.
In his workbook that gap **is** the omitted figure, because he types no bills;
here the bills are real rows with dates that print in the register after the
Ashadh total. So the two meet, and the screen gains the number his sheet
cannot show: the gap **after** the bills already entered — what is still left
to find.

Verified live: a customer confirming 560,000 against books of 500,000 lists
as `Alpha Traders · 60,000.00 · —`, and entering that 60,000 bill drops the
panel to *"Every party with a confirmation agrees with the books"*.
