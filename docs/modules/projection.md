# Projection Report

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the multi-year financial projection engine, solver rules and exports.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.15 Projection Report (`js/projection.js` + `js/projectionEngine.js` + `js/projectionExport.js`, `pj-` prefix, table `projection_reports`)

Bank-ready multi-year **financial projection** generated from an uploaded audited/provisional statement workbook — the automation of the firm's hand-built projection Excel. Automation Hub tab. Three files by concern: `projectionEngine.js` (pure calculation core — **DOM-free, loads in Node** via a `module.exports` guard, which is how it's verified against the real sample files), `projection.js` (UI/orchestration), `projectionExport.js` (ExcelJS + PDF-Lib outputs). The reverse-engineered master spec is `overall important format that will be use in the app and ui and rules.xlsx` (user's Downloads, not committed); reference samples live in `assets/templates/Pashupati*`.

- **Three-step stepper**: Upload & Detect → Assumptions → Review & Export. The parser reads the firm's standard NFRS workbook (SFP/SOI/Sch-PL/Sch-BS/3.1 PPE) by **Note anchors (3.1–3.17) + label regex**, detecting each sheet's current-year value column from its "Particulars" header row — the template uses a *different* column per sheet (SFP→F, Sch-PL→D, Sch-BS→H), so never hardcode one.
- **The parsed PPE pools MUST sum to the SFP fixed-asset total, and the parser now guarantees it** (2026-08-02). Working the year-1 cash flow through algebraically, every term cancels except one: `CF closing cash − BS cash = Σ(pools) − ppeTotal`. So a single unrecognised column in Note 3.1 breaks the cash-flow tie by exactly its carrying amount, and **nothing else in the report shows why** — the depreciation schedule, the balance sheet and the ratios all look plausible. This shipped: Avi Agro's note headed a column **"Other Assects"**, which matched no pool keyword and silently took 7,69,636 of fixed assets with it, breaking year 1 by exactly that. Two-part fix: the plant pool now matches `other ass` (real statements misspell this column as often as not), **and** any residual between the pools and `ppeTotal` is booked to *Plant Machinery & other Assets* (15% — also the correct Income Tax Act 2058 block for unclassified assets) with a warning naming the amount. That makes the tie structural for any input file, however the note is spelled, laid out, or missing. Verified: of the six real sample statements only Avi Agro's pools ever disagreed, and all six now tie to the rupee.
- **The projection is a constraint solver, not a growth multiplier.** Deterministic parts: Sales × growth E/F (year-1 % / later-years %), **bottom-up profit** (CA rule 2026-07-25 — replaced the old target-PBT anchor, which squeezed Gross Profit *downward* year-on-year and made every complex file fail rule 6): Gross Profit **and** Net Profit must each rise **≥5%/yr**, and **purchases is the balancing figure** that plugs COGS to hit the resulting GP target (`gpForTargetNp` inverts `taxFor` numerically so proprietorship slabs work). Rule 1 (PAT > the year's Term+PWC principal repayment) is solved through the same GP target. Every admin line ×1.05/yr **except Rent & Audit Fee** (CA rule 2026-07-23: base rounded to '000, held flat, then stepped ×1.15 re-rounded to '000 every 3rd projection year — bumps on years 3, 6, 9…; `steppedFee`/`STEP_FEE_RE` in projectionEngine.js), 7-pool WDV depreciation (Land 0, Building 5, Plant 15, Office 25, Vehicles 20, Software 15, Leasehold 7%), EMI schedules for **Term / Permanent-WC / Hire-Purchase** loans (short-term OD/CC alone carries a flat rate on a constant balance), rule-9 tax (Pvt Ltd/Partnership 25% flat; Proprietorship progressive slabs 0/10/20/27/29%). **Year-1 opening debt is DERIVED from the audited balance-sheet identity**, never summed from the Note 3.8 detail rows — real statements classify those loans inconsistently (on two of four test files the whole term loan also sat inside Current Liabilities, double-counting it and breaking the year-1 cash-flow tie by exactly that amount). **Sundry Creditors** follow rule 3: when the provisional payable exceeds **10 lakh**, every projected year sits at a seeded **75–80%** of it (unique per client, reproducible; a 10%/yr decay would fall out of the band) — smaller payables keep the 2–8 lakh seeded figure. **Sundry Debtors is ALWAYS the balancing figure** (Sources−FA−cash−stock+CL) and is never user-editable; **Purchases balance the P&L** to hit the profit target.
- **The 10 master rules** (from the spec's NCA sheet) drive auto-levers, bounded-iteration: rule 1 yr-1 closing stock = max(STL÷NCA%×1.05, opening×1.05) (**CA 2026-07-28**: buffer corrected 1.15→1.05, and the divisor now follows the user-entered NCA %); rules 2/3/4 + a debtors≥0 floor → **Additional Capital** (round ↑'000) — but see the last-resort rule below; rule 5 debtor-days>90 → **Dividend** (round ↓'000, < PAT) then **stock-shift** (excess moved into closing stock, purchases re-balance, profit held). Constraints: debtor turnover 30–90 days, current ratio >1.5, debt-equity <2.33, **NCA%·NCA ≥ WC loans + 1 lakh**, NCA ≥ 1 lakh, Sources=Uses (every year, exact).
- **The NCA working's closing line `H = F − G` has a 1 lakh floor, not zero** (CA rule 2026-08-02, `LIMITS.minNcaHeadroom`). A drawing power that only just covers the facility leaves the bank no margin, and the old `≥ 0` test let a year settle at H exactly nil. It costs capital where it binds (one test file rose 3,01,80,000 → 3,03,23,000 — precisely `1,00,000 ÷ NCA%` rounded up to '000, which is the arithmetic confirming the floor is what moved). **H is a consequence, not a lever**: `H = NCA%·(Sources − FA − Cash) − STL − PWC`, so closing stock does not appear in it at all and cannot move it — a stock↔debtors shift is H-invariant. Driving H down is therefore the same objective as minimising capital, not an independent one.
- **Ratio tests are solved STRICTLY** (`LIMITS.ratioEps = 1e-6`, 2026-08-02). The old ±0.005 slack let a year settle at a true current ratio of **1.4950** and print as "1.50 ≥ 1.5" — the export shows two decimals, so the shortfall was invisible in the delivered report and in the review chips.
- **Closing stock may be cut at most 25% below the figure the stock rules produced** (`LIMITS.maxStockCutPct`, CA rule 2026-08-02), on top of the existing 50%-of-purchases bound; `stockFloorFor()` is the single floor both the capital-avoidance lever and debtor-floor step (a) call, so the two can never disagree. The purchases bound alone was not enough — on a file with low purchases relative to inventory it still allowed a collapse in closing stock that no bank would read as genuine.
- **Owner capital is a LAST RESORT and ONE constant figure** (CA rules 2026-07-28). `project()` runs `runAll(pinnedCap)` repeatedly: one unpinned pass bounds the search, then a **binary search finds the smallest single figure that satisfies every year** — zero is tried first. With a figure pinned, a year that falls short may NOT inject; it must reduce **cash down to `LIMITS.minCash` (1 lakh)** first — cash is the only lever that moves NCA, since `NCA = Sources − FA − Cash + STL` — and then **closing stock** (NCA-neutral; it only shifts value into the balancing debtors, which is how debtor-days hold at the 30-day floor). Closing-stock reduction covers BOTH a negative debtor balance and the 30-day turnover floor (every rupee out of stock lands in the balancing debtors, purchases re-balancing so profit is held) — that is what lets the capital level keep falling. Two guards had been blocking it: the <30-day fix was gated on days > 0, so a NEGATIVE debtor balance skipped the whole block and forced capital in instead; and the capital-avoidance branch only reduced stock for negative debtors, never for the 30-day floor. Fixing both cut a test file capital from 6.24cr to 2.65cr. Stock reduction is bounded by LIMITS.minPurchasePct (50%) of the provisional purchases — unbounded, it drives Goods Purchase to nil, which is implausible for a trading company; the floor costs capital (that same file settles at 6.32cr) and the percentage is the dial. Only if all levers are exhausted does the search raise the level. Every test capital can fix is monotone in it, which is what makes the search valid. Two traps found while building this: the generic injection block had to be guarded with `!capPinned` (it was re-injecting after the current-asset levers fell through, defeating the pin), and the rule-5 dividend must be capped so it cannot push debt-equity past its limit — it could, which then blocked the >90-day fix from finishing. **Current ratio and debt-equity cannot be moved by cash or stock at all** (`CA = Sources − FA + CL`, independent of both) — when either is the binding test, capital is genuinely the only lever, and that is the true last-resort case. Director/proprietor **lending is never carried into a projection** (`directorLending: 0`). The **seeded RNG is created per run** — it used to live outside the loop, so each re-run drew further down the stream and produced different creditor/cash figures, breaking both reproducibility and the search.
- **When capital survives, the report says WHICH bank test forced it** (2026-08-02) — `result.capitalDriver` + per-year `binding`/`failed`. The solver already drives the figure to the smallest constant that works, so the only useful thing left is the wall's identity, and that changes what the user can do about it. **Cash and closing stock cannot move the current ratio or the debt-equity ratio at all** — `CA = Sources − FA + CL`, so both cancel out — and when one of those binds, the loan structure is the only remaining lever. The driver is determined **empirically, by re-solving a notch below the answer and seeing what breaks**: picking the tightest ratio at the solution gives the *wrong* test, because the cash and stock levers drive debtor-days and drawing power to sit exactly on their limits and they therefore always look binding (this was the first implementation, and it named the 30-day debtor floor for a file whose real wall was the current ratio).
- **`suggestReclass(input, asm, opts)`** answers the follow-on question: how much of the short-term facility would have to be shown as a **term loan** for owner capital to fall to nil. Computed by **re-solving**, not algebra — a rupee moved out of current liabilities relieves the current-ratio test by ~1.5 rupees of capital, but the drawing-power test takes over partway down and relieves it by far less, so a closed-form answer is wrong exactly at the crossover, which is where the recommendation lands. On Avi Agro it returns 46,30,000 (verified: capital is nil at that figure and reappears at 40,00,000). **The engine never applies this itself** (CA decision, 2026-08-02) — how a facility is classified is a fact about the client, not a lever the report may pull; the review panel states the recommendation and the user re-enters it in Step 2.
- **NCA % is user-entered** (`pj-nca-pct`, default 70) and never recalculated. It drives all three places the old hard-coded 0.70 appeared: the drawing-power line, the shortfall→capital conversion, and the year-1 stock floor; the ratio sheet's label and its live Excel formula both follow the entered value.
- **Review panel**: per-year ratio pass/fail chips, the five levers (cash/creditors/closing stock/additional capital/dividend) editable with **live re-solve** (debtors re-balances); export + save blocked while any validation *error* remains (warnings allowed).
- **Deliberately excluded from the projection** (matches the CA's real delivered sample): non-operating income and SOI expense rows outside notes 3.12–3.15 (e.g. Incentive) — the PBT anchor absorbs them via purchases. **Seeded, not random**: the master asks for "unique" cash (5–9 lakh) and creditors (2–8 lakh) figures; a deterministic RNG seeded from PAN+company+FY makes re-runs reproducible.
- **Master-workbook bugs deliberately corrected** (don't "fix back"): year-3 Dep block re-adding prior closing as an addition, CF operating total omitting the ΔCA row, BS year-1 WDV referencing the net instead of gross total, and the non-cumulative retained-earnings column.
- **Both exports render from ONE shared model** (`pjxBuildReport()` in projectionExport.js — section order, columns, rows, labels, pruning and org terminology), so the Excel is the same document as the PDF rather than a parallel layout that can drift. Sheets are `Cover · Balance Sheet · Profit & Loss · Schedule 1 (Administrative Expenses) · Cash Flow · Depreciation · IRD · Ratio Analysis` — the ~20 admin expense lines sit on their own page/sheet directly after the P&L (which carries only the total, fetched from that schedule), because inline they crowded the statement (+ a **Validation** sheet listing every finding whenever the review flagged something). **Input rows carry NO formula** (Sales, Goods Purchase, Direct Cost, the Schedule-1 admin lines, Cash) — they are the figures the projection is built from, so the sheet stays clean; **every derived line shows its working** (2026-07-25), with Cost of Sales = `Opening+Purchase+Direct−Closing` and Gross Profit = `Sales−COGS` — `xsum` (add these row keys) and `xexpr` (total-row builder) are joined by **`xf`**, a per-cell builder receiving `{R, c, p, ci, yi, rn, X, Xp}` (row map, this/prior column letter, column index, 0-based year, this row number, same-year and prior-year cross-sheet ref helpers). All resolve against the *written* row numbers so pruning can never mis-reference, with the cached value alongside. What that surfaces: **growth rates are visible** (`ROUND(B7*1.08,0)` for sales, `ROUND(B16*1.05,0)` per admin line, `ROUND(C17*1.15,-3)` on a stepped Rent/Audit-Fee bump year, `ROUND(B20*1.1,-1)` cash); **Gross Profit is the driver** carrying the ≥5% target formula, with Cost of Sales = `Sales−GP` and **Purchases visibly the balancing figure** (`COGS−opening−direct−closing`); **Sundry Debtors shows its balancing identity** (`TotalSources−FA−cash−stock+CL`); the **rules are legible** (Expenses Payable = `ROUND(auditFee+salary/12,0)`, TDS = `ROUND(salary*1%+audit*1.5%,0)`, tax = `ROUND(PBT*0.25,0)` for flat-rate entities); the **Depreciation sheet is live arithmetic** (Total = `B+C−D`, Dep = `E*F`, Balance = `E−G`, and each year's Opening = the prior block's Balance for that pool); and **every ratio shows its definition** (debtor days, current, debt-equity, ICR, GP/NP margin all reference their source cells). Each `xf` **re-computes what its formula would evaluate to and emits it only on an exact match**, falling back to the plain figure otherwise — so a formula present in the sheet is always the true derivation (this is why `LIMITS.expenseGrowth` compounds off the prior year's rounded figure, matching the firm's own `=ROUND(<prior cell>*1.05,0)` workbooks). The Audited/Provisional lead column is deliberately **excluded from those formulas** — it holds the client's actual reported totals, which need not foot from the broken-out lines (audited WDV/TDS/expenses-payable aren't itemised in the source statement). **Exports are never gated on validation** — a flagged projection must still leave the app to be corrected in Excel; only *Save to Database* is blocked by errors. **Preview and Print render an HTML document** (`pjxReportHtmlDoc` + `PJX_PRINT_CSS`) built from the same shared model — a white, content-only page mirroring the PDF design (navy band, tinted totals, double-ruled grand totals, signature block, cover). `pjPrintReport()` opens it in a blob tab and auto-prints, exactly like the Audit Report / Notes to Accounts modules (§9.2); the preview iframe loads the *same* document, so what is reviewed is what prints. `<thead>` repeats the header band across printed pages and each sheet is `page-break-after`. The PDF-Lib download remains the bank-ready file. Older note: the previous Excel reproduced the master workbook layout (Dep blocks stacked 12 rows apart) — that geometry is gone with the mirror rewrite. **PDF** via PDF-Lib — A4 **portrait** (2026-07-25; column widths and the number font are fitted to the widest figure the table actually prints, so 1–10 years plus the Audited column all stay aligned, and short statements let their rows breathe to fill the page instead of bunching at the top), mirrors the Excel sheets through shared label consts (`PJX_PL_L`/`PJX_BS_L`/`PJX_CF_L`/`PJX_IRD_ROWS` in projectionExport.js — the single source for both outputs, so texts can never diverge). Excel total rows carry live formulas **including cross-sheet references** (a pass-1 row registry fixes every sheet's row numbers before any formula is written, and references map by YEAR — the Audited lead column shifts BS/P&L columns), so IRD pulls from Profit & Loss / Balance Sheet, BS reserve from the P&L transfer, CF from the P&L, and the NCA working from the BS — every figure shows where it was fetched from. A **Interest Coverage Ratio** row ((PAT+interest)/interest) joins the ratio page; real table grid (navy header band, vertical year separators, tinted total rows, double-ruled grand totals), column widths/font sizes auto-scale for 1–10 years; English labels only (standard fonts can't render Devanagari); ratio rows colour-coded pass/fail. **Bank-submission dressing (2026-07-22):** serif cover page (title/company/FY range/report date + three vertical rules of differing heights, centre tallest, echoing the firm's audit cover); fixed page order Cover→BS→P&L→CF→Dep→IRD→Ratios with each statement **auto-scaled to fit its own page** (row heights/fonts shrink via a two-pass renderer; only Dep may span pages, whole year-blocks kept together); **zero-value rows pruned** with business exceptions (Dividend/Withdrawal, WDV/Depreciation/Fixed-Assets rows always kept; Dep schedule drops inactive asset classes) and ordinal prefixes re-lettered after pruning; **organization-specific terminology** via `pjxTerms(orgType)` — Paid-up vs Registered Capital, Director/Partner/Proprietor — driven by the `pj-org-type` select (auto-set from the client's entity type, also applied to the Excel labels), never showing the three designations together; optional **comparison column** (`pj-include-audited`, default off) leading the BS and P&L, headed by the single uploaded statement type — **Audited OR Provisional, never both** (`pj-statement-type`, auto-detected from the upload filename, flows to the IRD sheet header too); signature footer with dotted lines + auto B.S. date (`NepaliLocale.todayBs`) + place parsed from the client address; ratio page adds **Gross/Net Profit Margin** (also added to the Excel NCA sheet). **Debtor-days band is 30–90** (`LIMITS.minDebtorDays`/`maxDebtorDays`, CA rule 2026-07-22): both bounds validate as warnings and colour the review chips/PDF, and the **solver actively enforces the floor in two ordered steps** — (a) FIRST decrease closing stock (profit held → purchases re-plugs → the balancing debtors rises rupee-for-rupee), bounded so closing stock/purchases stay ≥ 0 and NCA stays ≥ `LIMITS.minNca` (1 lakh; note the shift is NCA-invariant so this is a go/no-go guard); (b) only if (a) can't reach 30 days, raise debtors the rest of the way by injecting Director/Partner/Proprietor **additional capital rounded up to '000**. Both steps keep Sources=Uses and CF=BS-cash exact; levers surface in the review panel's decision log (`debtor-floor step (a)/(b)`). Engine constants (`LIMITS`, `TAX_SLABS`, `DEP_POOLS`) live **in projectionEngine.js**, not config.js, so the engine stays Node-loadable with a single source.
- Fiscal year: **dash** in UI (`2083-84`), **dot full** in sheet columns (`2083.2084`), `YYYY.03.31` as-at headers — per the §9.5 rule.

---

### New Task vs Updation, and who performed it (2026-08-10)

A **Task** card heads Step 2: a New Task / Updation segmented picker
(`.arf-type-picker`, the ARF component), a **Staff Performing This Task**
select, and a status line. All three are **UI-only — none of it is rendered
into the exported report**; `pjxBuildReport()` reads only
`pj-company`/`pj-pan`/`pj-org-type`/`pj-include-audited`/`pj-statement-type`,
and that was asserted directly in verification.

- **The mode decides insert vs update.** Picking a client lists that client's
  saved `projection_reports` rows and **auto-switches to Updation** — the
  record already existing in the database *is* what makes this an updation,
  and requiring the user to notice would just produce duplicates. Each row
  offers **Load & Update**.
- **Loading restores from `inputs`, not from the workbook** — `parsedModel` +
  `assumptions` are everything the engine needs, so a revision months later
  doesn't need the original file, which the firm often no longer has to hand.
  `pjApplyAssumptions()` writes the saved figures back onto the Step 2 form
  (years, growth, NCA %, org/tax type, loans, additions/disposals, share
  capital) so an updation is edited exactly where a new task is built, then
  re-solves from the saved assumptions object — the overrides live only there
  and have no form inputs to read back from yet.
- **`pjRun()` used to null `pjSavedId` on every re-solve**, so any edit turned
  the next Save into a brand-new row. That is right for a New Task and wrong
  for an Updation, where revising the figures *is* the point; it is now
  conditional on the mode. The action button reads **"Update Saved Projection
  #N"** so the two can't be confused.
- **A fresh upload always resets to New Task**, even for a client with saved
  projections: keeping the link would let a workbook for a different year
  silently overwrite an existing record. Switching to Updation and loading is
  the explicit path.
- `pjSetLoans()` **clears each loan group before refilling it** — appending
  would stack loaded loans on top of what the form already showed and double
  the client's debt.
- On an update, **`created_by` is deliberately not in the payload** (it is who
  first created the record); `performed_by` is the staff name, and reuses
  `window.ARF_STAFF` with the usual "Other replaces the value" convention, so
  a name typed by hand restores onto *Other* rather than being blanked.
- Staff is **required to save** — a saved projection with no name attached
  can't answer the question the field exists for.

### Share Capital is an editable input

`pj-share-capital` (Step 2) is prefilled from the parsed statement and feeds
`pjModel.shareCapital` via `pjApplyModelEdits()` before every solve. The
workbook's capital line is regularly stale (a rights issue since the audit, a
figure sitting in the wrong note) and every downstream total keys off it.
**Clearing the box returns to the parsed figure**, which is why
`pjParsedShareCapital` is kept rather than the box merely being seeded once.

Verified against the real `Avi Agro 2082.083 Provisional.xlsx`: at share
capital 20 lakh / 50 lakh / 75 lakh the solver returned Additional Capital of
85.80 / 55.80 / 30.80 lakh — **substituting rupee for rupee**, with Total
Sources correctly unchanged (the solver finds the smallest owner capital that
satisfies the bank tests), and the balance and cash-flow ties exact at every
level.

### The Audited/Provisional comparison column must foot on its own (2026-08-11)

Turning on `pj-include-audited` prints a lead column of the client's **own**
reported figures next to the projected years. It is the first thing a banker
checks, so it has to satisfy the same three identities the projected years do.
It did not: verified against `M M Poultry Breeding Pvt Ltd 82.83 Provisional`,
Total Sources exceeded Total Uses by 5,97,48,356, the current-liability rows
added to 1,55,48,318 against a printed total of 7,54,34,832, and the P&L ran
down to 16,32,280 against a reported PBT of 7,53,082. Ten cells were hard-coded
`null` and printed `–` although the workbook carried a figure for every one.

What the parser now reads, and why each was wrong:

| `model` field | Source | Was |
|---|---|---|
| `loans.nonCurrentTotal` / `currentTotal` | **SFP**, the two same-labelled `Loans and Borrowings` rows, told apart by which liability heading precedes them | dead fields, never read |
| `loans.term` / `overdraft` | Note 3.8, bucketed by its `Non-Current :` / `Current :` headings | headings were skipped without being recorded, so every row was classified by keyword and anything unnamed (`AG WC Loan`, `Demand Loan`) fell through to Long Term Loan |
| `depreciation` | SOI `Depreciation Expenses` (3.1 PPE `Depreciation Charged` as fallback) | never parsed at all |
| `expensesPayable` / `dutiesTaxPayable` | Note 3.9, split at its `Duties and taxes:` sub-heading (the row prints as **TDS Payable**) | only the first `Trade Payables` row was read |
| `loans.permanentWC` / `hirePurchase` | Note 3.8 by keyword, from either section | never parsed — both rows printed blank |
| `financeCostST` / `financeCostLT` | Note 3.14 sub-lines (`OD/CC/STL/DL` vs `TL/PWC/HP`) | the whole finance cost went on the short-term row |
| `retainedOpening` / `dividendPaid` | Note 3.7 roll-forward | never parsed |

**The SFP is the authority for the loan split, not Note 3.8.** The note's labels
vary per client and per year; the balance sheet's own two lines cannot. The
parser reconciles the note detail against them and books any residual, exactly
as the PPE pools are forced to the SFP fixed-asset total — and warns naming the
amount. On `Test 1 2081.082 provisional` the note genuinely disagrees with its
own balance sheet (52,52,145 vs 28,29,090); the SFP figure is what makes Total
Current Liabilities foot, and the warning surfaces the inconsistency.

**Long Term Loan is the bank portion alone.** A director loan shown inside
Non-Current Liabilities (`T3`, `Test 2`) is already on the *Lending* row, so
using the non-current total here counted it twice — Sources overshot by exactly
the director loan.

**The short-term interest is derived by difference** (`financeCost − LT`) once
the note is broken out, so the two printed interest rows always add back to the
note's Total. Bank charges, a subsidy credit or a facility spelled in a way no
keyword catches otherwise vanish from both rows: `Test 2`'s "Interest/ Loan
Expenses Term" is not "term loan" and left 34,702 unallocated.

`addl` (Additional Capital) and `pwc` (Permanent Working Capital) stay `null` —
projection concepts with no counterpart in a filed statement.

**Two statements still do not foot in the P&L, correctly**: `Pashupati Marvel`
and `Test 1` carry non-operating income and out-of-note SOI expenses, which
§5.15 excludes from the projection by CA decision. That residual is the
documented exclusion, not a parsing gap — don't "fix" it.

### Every loan is reported on its own line (2026-08-11, user decision)

The balance sheet shows **Long Term Loan · Permanent Working Capital Loan ·
Hire Purchase (HP) Loan** in Sources and **Short Term Loan /OD/CC** in current
liabilities, and none of them are ever summed together. Only their *interest*
is combined, on the P&L, where term/PWC/HP share one row and short-term/OD/CC
keeps its own — that split was already right and is what the firm wants.

Hire purchase previously had no line at all: `closingLT` folded `hpScheds` in.
It is now `closingLT` + `closingHP` separately, with every total (`sources`,
`debt`, `prevLoans`, `cf.deltaLoans`, IRD `bankLoan`) adding it back
explicitly, so no figure moved — only the reporting split. Verified across four
loan combinations (LT+ST, +HP, +PWC+HP, HP-only): Sources=Uses, CF=BS cash and
the Sources rows footing to their total all hold in every year.

**PWC and HP are matched by KEYWORD from either section, not by section.** Real
statements put them on both sides — T3 lists `Permanent WC` under *Current*,
Test 2 lists `PWC Term Loan` under *Non-Current*. `permanent wc|pwc` and
`hire purchase|hp|vehicle|auto loan`; **plain "WC Loan" is NOT permanent
working capital** (T3's own note lists `WC Loan` and `Permanent WC` as separate
facilities, so a substring match would merge two real facilities), and vehicle
/auto loans count as HP by user decision.

**Moving PWC/HP up into Sources means taking them back out of Current
Liabilities**, or the same money is counted on both sides and Sources stop
equalling Uses. `loans.currentReclassified` records how much came out of the
current section; the audited CL total is reduced by it and the Short Term row
uses **`loans.overdraft`, never `loans.currentTotal`** — the latter still
carries the reclassified amount. Getting that wrong is invisible in the totals
(they still tie) and only shows as the CL rows not adding to their own total,
which is how it was caught on T3.

Each section is reconciled against **its own** SFP row and the residual is
booked to that section's catch-all — Long Term Loan on the non-current side,
Short Term /OD/CC on the current side — so a residual never lands on a facility
that has a line of its own to distort.

### Base fiscal year and Share Capital (2026-08-11, user decision)

`PJ_BASE_FY_DEFAULT = '2082-83'` — a fixed default, same convention as
`ARF_FY_DEFAULT`/`SM_FY_DEFAULT`, **not** derived from the upload or today's
date. An upload no longer overwrites the field; it only fills it when blank,
and Clear restores the default rather than blanking it. Still editable.

**Share Capital is a per-year override row, and has no standalone box**
(2026-08-11). It briefly moved from Step 2 into a single box at the top of the
Balancing Figures card; that box is now **gone** and the figure is an ordinary
per-year row in `PJ_OVERRIDE_FIELDS`, because a rights issue lands in a single
year rather than across the whole projection. An empty box falls back to the
statement's own parsed figure, the same "blank = automatic" idiom as every
other lever. `pjApplyModelEdits()` and `pjParsedShareCapital` went with the box
— nothing rewrites `pjModel.shareCapital` any more, so the parsed value stands
as the base and the comparison column always shows what the statement said.

In the engine `shareCap` is read per year off `ov.shareCapital` and carried on
`state`, so `sources`, `equity`, `bs.shareCapital` and `cf.capitalIssued` all
move together — `prevCap` already read the prior year's balance, so the cash
flow needed no change.

**Sales is a per-year override row too** (2026-08-11) — the top line the whole
projection is built from, and the firm regularly knows a year's turnover better
than a flat growth rate does. **An override carries forward**: the next year
still grows off `prev.pl.sales`, which is now the corrected figure, so setting
year 1 to 12cr makes year 2 12.6cr at 5% growth. It does **not** move the
profit target — `gpTarget` is driven by the prior year's GP/PAT and by debt
service, not by sales — so Gross Profit holds and purchases re-plug COGS around
the new turnover. Only cost of sales, direct cost (a fixed ratio of sales) and
the debtor-day ratio follow it.

Verified on the real workbook with one year overridden, all three overridden,
and sales mixed with a share-capital override: Sources=Uses, CF closing cash =
BS cash, `Sales − COGS = GP`, `GP − admin − interest − dep = PBT` and
`opening + purchases + direct − closing = COGS` all hold in every year.

### The comparison column is headed by a date, not a fiscal year (2026-08-11)

`audCol` was a single `F.Y. 2082-83` used by all three sections, which printed
beside sibling columns headed `2084.03.31`. It is now per-section: the balance
sheet uses `pjBaseAsAt()` (→ `2083.03.31`), the P&L and Schedule 1 use
`pjFyDot(0)` (→ `2082.2083`), each matching its own year columns. The IRD sheet
keeps its `F.Y.` labels — that page is fiscal-year semantics.

`pj-base-asat` overrides the balance-sheet date for a statement drawn to a
non-standard day; blank follows the base fiscal year.

### IRD row definitions (2026-08-11)

Three were wrong, and each needs its audited value, projected value **and**
Excel cross-sheet formula changed together or the sheet drifts:

- **Gross Income is turnover**, the P&L's `Income from Sales/Service` — it was
  `revenue − materials`, i.e. gross *profit*.
- **Paid up Capital is share capital alone.** The projected column added the
  solver's Additional Capital, which is not issued capital.
- **Loan from Bank and Financial Institution is every facility.** The projected
  column omitted `longTermLoan` entirely (where hire purchase also sits) and
  counted `directorLending`, which is related-party, not a bank.

### Signature clearance (2026-08-11)

Staff sign the printed report by hand and the signatures ran back over the last
rows of the statement. All three writers now leave ~20mm above the dotted rules:
`.pjp-sig` uses `margin-top:auto` + `padding-top:20mm` with `.pjp-sheet` a flex
column, the PDF's `sigSpace` is 99pt (the rules sit at `mB + 42`, so clearance
is `sigSpace − 42`), and the Excel gap is 5 rows. **The print `@media` rule must
keep a real `min-height`** (262mm, the height `.pjp-cover-frame` already proves
safe inside the 12mm `@page` margin) — it was `0`, which left `margin-top:auto`
nothing to push against. Measured on the M.M. Poultry report: every sheet fits
the 273mm printable area, the Balance Sheet being tightest at 270.4mm.

### `performed_by` column

`db/2026-08-10_projection_performed_by.sql` adds one nullable text column to
`projection_reports`. Nullable because projections saved before this feature
have no staff attached, and that is a valid state, not an error — the saved
list falls back to `created_by` for those. Saving also now stores
`inputs.ui = { statementType, baseFy }`, the two DOM-read choices that aren't
part of the assumptions object, so reloading reproduces the same report rather
than a defaulted one (jsonb — no migration).

---

