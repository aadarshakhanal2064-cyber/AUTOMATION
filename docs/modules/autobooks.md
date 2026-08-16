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
