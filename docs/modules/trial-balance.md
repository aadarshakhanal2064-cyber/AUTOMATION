# Trial Balance — `js/trialBalanceSheet.js` (`tbs-`) + `js/core/trialBalanceModel.js`

**Automation Hub → Trial Balance.** Added 2026-08-30.

Type the firm's own trial balance and the balance sheet and income statement draw
themselves off it — and typing on either statement writes straight back to the
ledger.

| | |
|---|---|
| Module id | `trialBalance` · panel `tab-trialBalance-panel` · prefix `tbs-` |
| Engine | `js/core/trialBalanceModel.js` (`TrialBalanceModel`) — no DOM, Node-loadable |
| Table | `trial_balances` (`db/2026-08-30_trial_balances.sql`) |
| Harness | `node tools/tbsVerify.mjs` — **run before and after any change to either file** |
| Reads | `TrialBalanceReader` (vocabulary), `fsxTbSheet`/`fsxLinkToTb`/`fsxPreviewHtml`/`fsxWriteWorkbook`/`FSX_GEOM` (pages) |

---

## 1. Why this is not a fourth statement module

Audited Statement and Provisional Statement take a **finished year apart**: last
year from the prior-year workbook, this year figure by figure, a solver plugging
whatever is left over. Both need two years, an upload, and a set of rules.

This screen does the opposite and much smaller thing. There is **one set of
numbers** — the trial balance — and the statements are a second view of it.
Nothing is solved, nothing is plugged, and no figure on either statement is one
the ledger does not carry.

That is what makes the binding work in both directions, and it is the only
reason it can. A solver-based module could not accept an edit on its output,
because the output is a consequence rather than a restatement.

## 2. The identity everything rests on

A trial balance foots when

```
Assets + Expenses  =  Revenue + Equity and Liabilities
```

and a balance sheet balances when

```
Assets  =  Equity and Liabilities + (Revenue − Expenses)
```

Those are the same statement rearranged. So **the balance sheet balances if and
only if the trial balance foots, and the difference is the same number on both
screens** — which is why the workbench shows one figure and says so in words.
The reference file the format came from proves it:

```
3,19,66,597.69  =  4,07,48,258.01 + (8,86,18,378.80 − 9,74,00,039.12)
```

Two consequences worth stating plainly:

- **The year's profit is not typed by anyone.** It is Revenue less Expenses and
  it lands in Reserves. That is the only place equity gets it from.
- **`derive()` computes the balance-sheet gap independently rather than copying
  the trial difference.** They must agree, and `tbsVerify` asserts it — a
  trial-balance section that stops reaching the balance sheet shows up there and
  nowhere else. Deliberately redundant arithmetic, as a tripwire.

## 3. What is deliberately absent

- **No opening stock.** This trial balance is post-closing — inventories is a
  balance-sheet asset and purchases is the expense — so profit really is
  Revenue − Expenses. An opening-stock box would break §2 unless it were also a
  trial-balance row, and it is not one. *(User decision 2026-08-30: the
  alternative, a typed opening-stock figure, was offered and declined.)*
- **No depreciation line on the income statement.** The trial balance decides
  the expense heads; whatever the client charged sits inside one of its own five
  expense sections. Printing a sixth head their ledger does not carry would be
  the statement inventing a figure.
- **No income tax charge unless the preparer NAMES the ledger line that is one.**
  Nothing here can tell an income-tax provision from a road tax, and guessing
  misstates profit before tax on a statement someone signs. The picker sits
  under Other Expenses, defaults to *none*, and when nothing is named the SOI's
  tax row is **omitted entirely** rather than printed at nil — a nil tax row on
  a statement that in fact charges tax inside Other Expenses is worse than no
  row at all.
- **No prior-year column.** A typed trial balance is one year. The sheets carry
  one value column, which is why `buildSheets` passes a single-entry `cols`.
- **No Provisions rows, and no current Investments row.** The audited SFP draws
  both; this ledger has no head for either, so a row backed by nothing is not
  drawn. The trial balance's single Investments head is reported **non-current**
  — the conventional reading and the only one the ledger supports.

## 4. Shared, not copied

| What | Whose | Why not a copy |
|---|---|---|
| Section ids, revenue split, loan groups | `TrialBalanceReader` | A typed trial balance and an imported one are the same document. One set of spellings, or the two drift the first time a client writes "Commission Income". The reader exports `REVENUE_LINES` and `classify` for exactly this. |
| The Trial Balance **page** and the `='Trial Balance'!E11` linking pass | `fsxTbSheet` / `fsxLinkToTb` (`js/finStatementExport.js`) | Extracted out of `fsxBuildReport` 2026-08-30 when this became a second caller. A statement set built from an *imported* trial balance and one built from a *typed* one must render the same trial balance, not two versions of it. |
| Preview, print, Excel | `fsxPreviewHtml` / `fsxReportHtmlDoc` / `fsxWriteWorkbook` | One renderer, so this module's pages and the Audited Statement's are the same document family. |

`FSX_GEOM` is **passed into** `buildSheets(state, opts, GEOM)` rather than
imported: the engine is in `js/core/` and must not depend on the feature layer,
and it stays loadable in Node so the harness can replay a ledger through it.

## 5. The two editing rules, and why they differ

- **A ledger amount commits on `input` and only PATCHES the derived cells.**
  Typing into a ledger box can never change the shape of anything, so a
  re-render would throw away the caret for no reason — the rule Autobooks'
  confirmation grid and the To-Do list already follow. `tbsPatchStatement()`
  additionally never writes into a box that is `document.activeElement`.
- **A statement amount commits on `change` and re-renders everything.** It has
  to: typing into an aggregated row *adds a line to the trial balance*, so the
  left pane genuinely changes shape. Committing on blur means the caret has
  already left.

## 6. Write-back: the adjustment rule

*(User decision 2026-08-30, choosing between three offered options.)*

A statement figure that is the **sum of several typed ledger lines never
rewrites those lines.** The difference goes to a named adjustment line inside
the section, so the section still foots to the figure on the statement and
nothing anyone typed off a ledger is silently changed.

Pro-rata apportionment across the detail was the obvious alternative and was
rejected for exactly that reason: a VAT receivable typed off a filed return must
stay what the return said.

- The line is named `(Adjustment from Balance Sheet)` /
  `(Adjustment from Income Statement)` — one per statement per section, so the
  two can never collide.
- It is **updated in place**, not stacked; typing the original figure back
  **removes** it rather than leaving a nil row behind. Both are asserted.
- It renders on amber (`--amber-bg`) and the module states in words what it did.
  An adjustment nobody notices is the failure mode this design exists to avoid.
- A section with **no** detail lines has nothing to protect, so its bare amount
  is simply set.

Three rows are special, and each is special for a reason:

| Row | Rule |
|---|---|
| **Reserves** | Writes `value − profit` to the ledger. The year's result is not the preparer's to change from the balance sheet; the figure typed is the *closing* reserve and what is written back is the brought-forward balance under it. The message says so. |
| **Loans (non-current / current)** | Each side moves alone. Moving a bare amount into a split writes the existing balance out as a real *current* line first — otherwise a non-current figure would immediately read back as current, since a loans section with no detail is all current. |
| **Other Expenses** | The statement row is the section *less* the named tax line, so the tax is added back before the section is set. Without that, typing the statement figure would quietly delete the tax charge. |

Derived rows (`Total Assets`, `Profit Before Tax`, …) carry no input at all —
the refusal is the absence of a box, not an error message.

## 7. The Excel audit trail

The workbook is three sheets: **SFP · SOI · Trial Balance**, the ledger **last**,
because it is the working behind the other two.

`fsxLinkToTb` then writes every statement cell the ledger supplied as a live
`='Trial Balance'!E11` reference. A cell links only when its **label** matches a
ledger row **and** its **value** still equals that row's figure — so an
aggregated row (Trade and Other Receivables) correctly links to nothing, and the
two identically-labelled *Loans and Borrowings* rows cannot both claim the
section's figure. Verified in the real app: 5 references on the SFP of the
reference ledger, and the nil non-current loan row is not one of them.

## 8. Persistence

`trial_balances`, one row per **(client, fiscal year)** — enforced by a partial
unique index, not just by habit, because a second trial balance for the same
year is always a mistake.

- Picking a client, or changing the year, **opens the sheet already saved** for
  that client-year rather than letting a second be started beside it
  (`tbsTryLoadExisting`). Silent when there is none — an empty result is the
  normal case, not a failure.
- Save **adopts** an existing row before inserting: by `client_id` where there
  is one, since an `ilike` miss on a respelt company name would otherwise
  collide with the unique index.
- `data` carries the typed state whole; every **figure** is re-derived on load
  and none is stored. A saved total is a total that can drift from the lines
  under it (the Autobooks rule).
- `tbsLoadSaved` sets the identity **before** the client, because selecting a
  client clears the screen — the `depLoadSaved` lesson.
- **Not** part of Financial Management, so no `private.fin_unlocked()` conjunct:
  a client's trial balance is a client's book, the way Autobooks is, and the
  locked section is the firm's own money.

## 9. Gotchas found in the build

- **A ledger line's name lives in an `<input value>`, which `textContent` never
  sees.** A first verification pass reported the adjustment line as missing from
  the ledger pane when it was rendered correctly. Check `.value`, not text.
- **Renaming a line must carry its tax nomination and loan-side override with
  it** (`tbsSetLineName`), or naming a line "Income Tax" and then correcting the
  spelling silently drops the tax charge.
- **Removing a section's last line resets its bare amount to nil.** Otherwise
  the figure that was there before the section was broken out comes back.
- **Adding the first line to a section writes the bare amount out as a line**
  rather than dropping it.
- `REVENUE_ADJ` names its adjustment lines after the bucket they feed, so
  `TrialBalanceReader.REVENUE_LINES` reads each one back into the same bucket it
  was written for.

## 10. Not built, deliberately

- **No import from a trial-balance workbook.** `TrialBalanceReader.parse` would
  make it about twenty lines and the Audited Statement already offers it, but
  the ask was specifically a sheet to *type*. An obvious next step if wanted.
- **No carry-forward from last year's sheet.** Same reason.
