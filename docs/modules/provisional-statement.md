# Provisional Statement (`js/provisionalStatement.js`, `ps-`)

> Automation Hub → **Provisional Statement**. Sibling of **Audited Statement**
> (`finStatement`, `fs-` — renamed from "Financial Statement" 2026-08-19, display
> name only; file names, prefixes, ids and the `financial_statements` table all
> keep their originals, same convention as Autobooks / Bank Entry / File In Out).

The Audited Statement module takes a *finished* year and lays it out. This module
takes **last year's statement plus a handful of this year's real figures** and
*derives* the rest by formula — the same way the firm's own provisional workbook
does it in Excel.

---

## 1. Where the rules come from

Reverse-engineered cell-by-cell from the firm's own **reference provisional
workbook** (7 sheets, 1,464 populated cells), read via a dependency-free XLSX
dumper. That file is a real client's and is deliberately **not in this repo** —
`assets/templates/` is gitignored, because the repo is public (§1 rule 7). **Every formula below is quoted
from that file**, not inferred. The workbook's own colour code:

| Colour | Meaning in the firm's workbook |
|---|---|
| 🟡 Yellow `#FFFF00` | typed by the preparer this year |
| 🟢 Green `#00B050` / `#92D050` | derived, but overridden/checked by hand |
| no fill | ordinary formula or carried figure |

Only 16 cells carry a fill — the colour marks *exceptions*, not a whole-column
scheme. The real "is this typed or derived" split is: **a cell holding a literal
is an input; a cell holding a formula is derived.** That is what this module
implements.

---

## 2. The derivation rules (the whole engine)

`PY` = prior-year column, `CY` = current-year column.

### 2.1 Growth rules

| Line | Workbook formula | Rule |
|---|---|---|
| Salary Expenses | `Sch-PL D33 =ROUND(F33*1.05,-3)` | **PY × 1.05, rounded to nearest 1,000** |
| Every Other Expense except Audit Fee and Rent | `Sch-PL D55 =ROUND(F55*1.05,)` *(shared D55:D70)* | **PY × 1.05, rounded to whole rupee** |
| Cleaning Expenses | `Sch-PL D54 =ROUND(F54*1.05,)` | same 1.05 rule |
| **Audit Fee** | `Sch-PL D53 = 75000` literal (PY also 75000) | **flat — carried, not grown** |
| **Rent expenses** | `Sch-PL D61 = 840000` literal (PY also 840000) | **flat — carried, not grown** |

> The 5% growth factor and the two flat lines are **defaults, each editable per
> line** — Audit Fee and Rent are the two the firm renegotiates rather than
> indexes, which is why the workbook types them.

### 2.2 Revenue-scaled rules — SUPPORTED, NOT THE DEFAULT

The source workbook scales three lines off a driver rather than off inflation:

| Line | Workbook formula | Rule |
|---|---|---|
| Labour Charges | `Sch-PL D25 =+F25/F6*D6` | PY amount × (CY sales ÷ PY sales) |
| Clearing & Freight | `Sch-PL D26 =+F26/F6*D6` | same |
| Incentive Expenses | `SOI F23 =+ROUND(H23/H15*F15,)` | PY incentive × (CY other income ÷ PY other income) |

**The engine still implements all three** — `tools/psVerify.mjs` proves them
against the workbook, and `applyRule`/`ruleDescriptor` carry the `turnover` and
`driver` rules. **The UI no longer offers them** (user decision 2026-08-19): the
rule dropdown was cut to nothing and every line is now "last year + growth %".
So Labour and Clearing & Freight ship on growth, and their exported formula is
`=ROUND(F23*1.05,0)` rather than `=+F23/F6*D6`.

Restoring turnover-scaling as their default is a one-line change per line in
`psRenderRules()` — the engine side needs nothing.

**The dedicated Incentive Expenses row is retired.** A book that carries one
adds it through *+ Add expense line*, which lands it in note 3.15. The SOI
expense block is emitted from a list, so it renders `a)`–`e)` without the row
and `a)`–`f)` with it — `fsxBuildReport`'s `hasIncentive` decides.

### 2.3 Tax

| Line | Workbook formula | Rule |
|---|---|---|
| Tax on profits | `Sch-PL D75 =+SOI!F27*0.25` | **25% flat on Profit Before Tax** |
| Income Tax Expense (SOI) | `= Sch-PL D77` | tax on profits + prior-period adjustment |
| Provision for Income Tax | `Sch-BS H102 =SOI!F29` | equals the year's tax expense |
| Advance Tax | `Sch-BS H18 =+J18-SOI!H29+SOI!F15*15%` | **PY advance tax − PY tax expense + (CY other income × 15%)** |

> 25% is the Pvt. Ltd. / Partnership rate. Proprietorship uses progressive slabs
> — carried over from Projection's `TAX_SLABS`, selectable on the form, and
> **deliberately not unified** with Financial Statement's D3 slabs (§15).

### 2.4 TDS / statutory payables — all derived

| Line | Workbook formula | Rule |
|---|---|---|
| TDS Payable-Salary (SST) | `Sch-BS H92 =+SOI!F20*1%` | 1% of Employee Benefit Expenses |
| TDS Payable-Rent | `Sch-BS H93 =+'Sch-PL'!D61*10%` | 10% of Rent |
| TDS on Incentives | `Sch-BS H94 =+SOI!F23*15%` | 15% of Incentive Expenses |
| TDS Payable-Wages | `Sch-BS H95 =+'Sch-PL'!D25*1%` | 1% of Labour Charges |
| TDS Payable-Audit fee | `Sch-BS H97 =+'Sch-PL'!D53*1.5%` | 1.5% of Audit Fee |
| TDS Payable-Clearing & Freight | `Sch-BS H98 =+'Sch-PL'!D26*1.5%` | 1.5% of Clearing & Freight |
| Audit Fee Payable | `Sch-BS H89 ='Sch-PL'!D53-H97` | Audit Fee **net of** its own TDS |

### 2.5 Cost of goods sold

`Sch-PL D29 =SUM(D22:D26)-D28` — opening stock + purchases + labour + freight
− closing stock. Opening stock is `=+F28` (**PY closing stock**, never typed).

### 2.6 Depreciation — 3.1 PPE

Rates read off the workbook's own formulas (`=+F11*5%` etc.), applied to the
**closing gross block**:

| Class | Rate |
|---|---|
| Land | 0% (never depreciated) |
| Building & Structures | 5% |
| Plant and Machinery | 15% |
| Vehicles | 20% |
| Office Equipment | 25% |
| Software | 25% |

**The workbook restates each year**: opening gross cost = *prior year's carrying
amount*, opening accumulated depreciation = 0. So `carrying = gross − this
year's charge`. That is a reducing-balance schedule expressed as a fresh block
per year, and it is what makes `3.1 PPE!P25` tie to `SFP!F13`.

Source of the schedule, in order:
1. a **saved SLM schedule** for that client+year in the Depreciation module
   (`depreciation_schedules`, `scheme='slm'`, via `depSlmPpeAggregate`-shaped
   `pools`), falling back to the most recent earlier year — the same rule
   `depSlmFetchUsefulLives()` already uses, and for the same reason: a useful
   life is a policy, not a yearly figure;
2. otherwise the **built-in rate table above**, on an editable grid.

Either way the grid is **editable in place**, like Projection's, and a class with
no assets is dropped from the note (§3).

**Every column is editable, including the two computed ones.** Depreciation and
Carrying Amount accept an override per class, shown with a ↺ to return them to
the rate. A schedule is a working, and a preparer occasionally has to force a
class to a figure the rate does not produce — a part-year asset, or a carrying
amount agreed with the client. An override is stored as typed, so clearing the
box returns the cell to the rate rather than pinning it at zero.

### 2.7 The rules grid has no dropdown

Every expense line is **last year + a growth %**, with both the rate and the
resulting figure editable on the row. Typing a figure into the right-hand box
overrides that line outright; ↺ puts it back on the rate. Rent and Audit Fee
simply arrive at **0%** — which is what "flat" meant before — so nothing about
them is special-cased any more.

Setting a rate has to switch the line onto the growth rule, or a line that
arrived flat silently ignores the rate typed on it. **0% stays `flat`** so the
exported formula remains `=+F41` rather than `=ROUND(F41*1,0)`.

**+ Add expense line** appends a head the firm's template never listed. It
behaves exactly like one read off the prior-year file — same growth rule, same
override, same place in note 3.15.

**Other Contributions** is emitted only when it carries something: an
always-present nil row is a head with no value, which this module drops
everywhere else.

---

## 3. Empty account heads are removed

Like Projection, a head carrying **no value in either year** is not printed. The
uploaded workbook shows the firm doing this by hand — `Sch-PL` rows 47/48
(Interest on Term, Bank Charges) are captioned but blank, and `Sch-BS` rows 5-10
(Investment) are all empty. A total row is kept even when its section is empty
only if the statement's arithmetic needs it.

---

## 4. Two things in the source workbook that are NOT copied

Faithfulness to the format does not mean copying its mistakes:

- **`SOCF E44 =E38+E40+E42+0.01`** — a hand-typed one-paisa plug, which is why
  the sheet's own proof row `E47` reads `0.0121` instead of nil. This module
  computes closing cash properly and **shows** any residual as a finding, the
  same way Final Account shows its Net Difference and Financial Statement shows
  its three proof rows (§15) — a non-zero figure is a fact about the inputs, not
  a rendering bug to suppress.
- **`SOCF G38 =+#REF!-F38`** — a broken reference left in a working column.

---

## 5. What the preparer actually types

Step 2 runs **Loans & Borrowings → This Year's Figures → Expense Lines & Rules →
Depreciation**. Loans come first because every other figure leans on them.

**Loans & Borrowings** — each facility by name and balance, non-current and
current, *plus the interest each costs*. Interest sits here rather than with the
income figures because it is a fact about a facility, and a finance cost that
lives away from the balance that produced it is one that goes missing.

**This Year's Figures** — Sale of Goods · Commissions & Incentives · Interest
Income · Closing Stock · Trade Receivables · Cash & Bank · Trade Payables ·
Income Tax Paid. Everything marked `grow: true` in `PS_FIGURES` is **seeded at
last year + the default growth** when the prior-year file is read; the seed only
ever fills a box the user has not typed into.

### 5.1 Two see-saws

Both follow the same idiom: the side you touch is held, the other becomes the
balancing figure and carries a **balancing** badge.

1. **Profit Before Tax ⇄ Purchases of Goods.** Type the profit you need and
   purchases balances to it; type purchases and the profit falls out. One set of
   arithmetic read in either direction (`solveFor` in the engine), so the two
   modes cannot drift. `psVerify` round-trips it: hold the profit the forward
   pass produced and the engine hands back the very purchases figure it started
   from.
2. **Trade Receivables balances the balance sheet**, on by default. Profit lands
   in equity, so something on the asset side has to absorb it — the same choice
   the Audited engine makes (§15: cash is seeded, receivables is the plug), and
   unbilled trade is the honest place. Untick it and receivables is typed while
   any residual is *reported* rather than absorbed.

Neither plug is silent: a negative solve warns, and with the receivables plug
off the gap is stated on the review panel.

**Prior year:** uploaded from last year's statement workbook (the same reader
Projection already uses), or carried from a saved Audited Statement.

---

## 6. Output

Rendered through the **existing `finStatementExport.js`** — `fsxBuildReport()` →
`fsxWriteWorkbook()` / `fsxPreviewHtml()`. That layer was already built
cell-by-cell against a workbook of exactly this family (`T3 Pvt.Ltd 2081.082
Provisional.xlsx`) and its geometry matches the reference file exactly:

| Sheet | Label | Note | Current | Prior |
|---|---|---|---|---|
| SFP | B | D | F | H |
| SOI | B | D | F | H |
| SOCF | B | — | E | G |
| Sch-BS | B | — | H | J |
| Sch-PL | B | — | D | F |
| 3.1 PPE | B | — | D, F, H, J, L, N, P (step 2) | — |

Book Antiqua throughout, no fills, borders on value cells only, medium-rule
header band, thin+double subtotal rule, double-only grand total — all already
implemented there. **Do not fork that file**; extend it if a row type is missing.

### 6.0 Seven sheets, in this order

**SFP → SOI → SOCE → SOCF → 3.1 PPE → Sch-BS → Sch-PL**, identically in the
on-screen preview, the print/PDF document and the Excel workbook.

**The COI (Return of Income) page is not part of a provisional set** — that tax
computation belongs to the return, not to the statements. It is opted out of
via `meta.omitCoi` rather than deleted, because the Audited module still issues
it. Two things follow from the omission: `Sch-PL`'s tax row must carry its own
rate formula (`inc.taxDerive`) since the `X('COI','tax')` fallback would be a
dead reference, and a self-banded schedule prints no sheet-wide title in
HTML/PDF either, or the page would carry a heading the Excel does not have.

### 6.1 Row-for-row alignment

**All 288 labelled rows across the seven sheets land on the same row numbers as
the firm's own workbook**, verified by diffing the generated workbook against a
map extracted from the reference provisional workbook. Getting
there needed five structural corrections to the export layer, every one of
which also fixes the **Audited Statement**, since both reference files agree:

1. **A blank spacer row between the header band and the first data row.** Every
   statement's data was one row high without it.
2. **A schedule bands EVERY note, not the sheet.** `Sch-PL` carries a
   "Particulars" band at rows 4, 21, 32, 39, 45, 52 and 74 — one per 3.x note —
   so schedules now write no title block of their own (`selfBanded`) and the
   row list holds the headings, the bands and the blanks. `firstRow` is where
   the firm's file starts: row 3 on Sch-PL, row 2 on Sch-BS and 3.1 PPE.
3. **`3.6 Share Capital` is three sub-tables split Number × NPR**, needing its
   own `quadhead` / `quadsub` / `quad` row kinds over columns D/F (this year)
   and H/J (last). Share counts are the face value divided into the capital, so
   the note cannot disagree with the balance sheet; **authorised** is a
   constitutional figure and is asked for.
4. **`3.7 Reserves` is a sentence, not a table** — the roll-forward already has
   a home in the SOCE, and `SFP!Reserves` points there, so a second table would
   state the same movement twice.
5. **Fixed signature rows per statement** (`sigRows`), because the gap below the
   last note differs per sheet — SOI leaves far more room than SFP.

Two deliberate carries from the source file, both **layout-only**:

- its `3.9` has a **second, nil `TDS Payable-Wages` row** — a spare slot in the
  firm's template. It is reproduced because it sets where `3.10 Provisions`
  starts, and nil changes no total. This is a different case from the `+0.01`
  cash plug in §4, which moves a figure and is *not* reproduced.
- whether the word **"Provisional"** appears in the three statement titles is a
  house choice, not a rule: the firm's T3 file prints it and the second
  reference file does not. It is a checkbox, defaulting to on (§15 keeps the SOCE clean either
  way).

**The A.D. date in brackets is typed, not converted.** `NepaliLocale` carries
`adToBs` but no B.S.-to-A.D. table, and a guessed date on a signed statement is
worse than none.
