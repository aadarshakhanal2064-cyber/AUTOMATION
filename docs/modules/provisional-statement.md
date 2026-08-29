# Provisional Statement (`js/provisionalStatement.js`, `ps-`)

> Automation Hub → **Provisional Statement**. Sibling of **Audited Statement**
> — which since 2026-08-22 is **`js/auditedStatement.js`, a verbatim `ps-`→`as-`
> clone of THIS module** (user decision: "same working features, everything the
> same; differences fixed later"). The clone shares the engine, `psrc*` sources,
> `ProvisionalReconcile` and the whole `fsx*` output layer — only the UI file is
> duplicated. It registers under the old `finStatement` module id and saves to
> `financial_statements` with `basis='audited'`. **A fix landing in this module
> almost certainly belongs in the clone too, and vice versa** — keep the two
> files in step until the audited-specific differences are specified. (The
> previous audited UI, `js/finStatement.js`, is no longer loaded — see
> `docs/modules/financial-statement.md`.)

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
> carried over from Projection's `TAX_SLABS`. **This whole table is the
> FALLBACK basis**, used whenever the caller passes no `options.taxRule` —
> which is every Provisional Statement. Audited Statement passes one; see
> §2.3a. The three schedules are deliberately not unified (CLAUDE.md §15).

#### 2.3a Audited Statement charges by the CA's D-1 / D-2 / D-3 rule sheet

*(2026-08-29, user ask — the firm's chartered accountant supplied the rule
sheet. Audited Statement only; Provisional keeps the fallback above.)*

The rule set lives in **`js/core/nepalTax.js`** (CLAUDE.md §4) and is picked in
the **Income Tax Rule** card, which prints the workings rather than asserting a
figure — the CA's sheet has an "Example" column for the same reason.

**That card is the FIRST card in step 2, above Loans, Figures and Rules**
(user ask 2026-08-29; it was briefly the Tax card's first accordion section).
It sits there because it decides the *basis*: on a D-1 or D-2 return the charge
never reads profit at all, so which figures matter is settled before any of
them is typed. Its card header carries the running charge, so the answer stays
visible while the preparer works further down the page. `asRenderTaxRule()`
renders it and is called from `asRenderTax()` **before** that function's caret
guard — the rule card holds no text input of its own, so it can always refresh.

**Why it is an engine and not two more constants.** Two of the three rules do
not read profit at all. A D-1 charge is a flat figure decided by the client's
municipality; a D-2 charge is a percentage of **turnover**. Neither can be
written inside an expression whose only variable is `taxableProfit`, which is
what the tax block used to be.

| Return | Base | Charge |
|---|---|---|
| **D-1** — proprietorship, turnover ≤ Rs 30,00,000 | turnover | Flat: Rs 7,500 metro/sub-metro · Rs 4,000 municipality · Rs 2,500 rural municipality |
| **D-2** — proprietorship, Rs 30,00,000 to Rs 1,00,00,000 | turnover | The location figure **plus** a rate on turnover *above Rs 30,00,000*, marginal and stacking: general goods 1% then 0.8% above 50 lakh · ≤3%-commission goods (gas, cigarette) 0.25% then 0.3% · service 2% throughout |
| **D-3** — everyone else | taxable profit | Company / partnership 25%, or 20% for a special industry. Proprietorship above the D-2 ceiling: the natural-person ladder |

**The D-3 proprietorship ladder** (F.Y. 2082-83, couple — the sheet's own
table). First band **0%, not the 1% social security tax**: that 1% is not
levied on business income (Schedule 1 sec 1(4)), and the published slab table
prints "–" in the proprietorship column.

| Band | Normal | Special industry |
|---|---|---|
| Up to 6,00,000 | 0% | 0% |
| Next 2,00,000 | 10% | 10% |
| Next 3,00,000 | 20% | 20% |
| Next 9,00,000 | 30% | 20% |
| Next 30,00,000 | 36% | 24% |
| Remaining | 39% | 26% |

The concession replaces the 30% base rate with 20%; the two surcharged bands
above it (36% = 30% plus a fifth, 39% = 30% plus three tenths) scale with it.

**Marginal, never pre-summed.** The Act publishes D-2's second band as a fixed
amount plus a rate ("Rs 27,500 + 0.8% of (Turnover − 50,00,000)" for a
metropolitan trader). The engine computes it marginally from the location base
instead — 7,500 + 20,00,000 × 1% = 27,500, and likewise 24,000 and 22,500 —
because storing six pre-summed figures is how the three location tiers drift
apart. `tools/taxVerify.mjs` asserts the marginal form reproduces every
published figure.

**Three extensions beyond the CA's sheet**, each additive, each leaving his own
cases reproduced exactly by the defaults: the **rural municipality Rs 2,500**
tier (the sheet lists two of the Act's three, and reading rural as Rs 4,000
overcharges those clients); the **≤3%-commission goods** band; and an
**Individual / Couple** choice, the sheet's table being the couple ladder.
Both ladders close their 30% band at Rs 20,00,000 and their 36% band at
Rs 50,00,000 — the check that they have not drifted.

**Two rules that follow from the base being turnover.** A D-1 or D-2 charge
**exports as a figure, not a live formula** (`income.taxDerive === null`) —
there is no single-cell expression for a number that reads the turnover line;
the same treatment a typed figure gets. And a turnover charge **is still owed
in a loss-making year**, so the "negative PBT, so no tax has been provided"
warning is raised only where tax is charged on profit.

**A rule that disagrees with the figures warns; it never self-corrects** — a
D-2 return above the Rs 1 crore turnover ceiling or the Rs 10,00,000 taxable
-income ceiling, a D-1 return above Rs 30,00,000, a D-3 proprietor still inside
the D-2 range, a service election the Act bars for consultancy professions.
Same rule as Final Account's Net Difference and the statement's proof rows.

**Prefill.** `returnType` is seeded from the client's own `it_return_type`,
assigned unconditionally (§9). `'D1/D2'` genuinely means "one of the two, the
preparer decides" (§15) and so resolves to nothing rather than a coin-flip
presented as a fact; the caption says so.

**Persistence** is the `inputs` JSON blob — `taxRule` alongside `vatSide` and
`coiTouched`, no migration. It is merged over the defaults on restore so a
record saved before a field existed gains it rather than restoring `undefined`
into a select.

**The sheet's "Name of Auditor (Choose)" block is `window.ARF_AUDITORS`**,
which already matched it exactly. Nothing was changed there, and the Audited
Statement carries no signature block of its own.

> **The Computation of Income was removed from the UI 2026-08-28 by user
> decision** — tax always charges straight off accounting profit, no COI
> sheet prints, and the Tax card's accordion is three sections (Advance Tax ·
> TDS · VAT). The ENGINE keeps the full COI bridge and `tools/psVerify.mjs`
> keeps proving it: `psUseCoi()`/`asUseCoi()` returning `false` is the whole
> removal, and flipping it back is the whole restore.

> **Audit Fee and Rent are recognised by NAME, never by caller key**
> (2026-08-28, `ProvisionalStatementEngine.headKeyFor()`). The prior-year
> reader hands expense lines over without keys, so the modules keyed them
> positionally ('other3') and the engine's `pick('auditFee')` found nothing —
> Audit Fee Payable, TDS-Audit fee and TDS-Rent all derived to 0 and the flat
> rule never applied, on every real upload, while psVerify (which supplies
> keys) stayed green. Both collectors now key through `headKeyFor`, the
> engine re-normalises internally, and psVerify carries a no-keys regression
> block. Audit Fee Payable = fee − its own 1.5% TDS; TDS-Audit fee = 1.5%.

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

**+ Add direct cost** and **+ Add expense line** append heads the firm's
template never listed — the first into note 3.12 inside Materials Consumed, the
second into note 3.15. It
behaves exactly like one read off the prior-year file — same growth rule, same
override, same place in note 3.15.

**Other Contributions** is emitted only when it carries something: an
always-present nil row is a head with no value, which this module drops
everywhere else.

---

## 2.8 Blocking figures — when a statement cannot be issued

*(2026-08-29, user decision. Applies to BOTH clones — the clone rule, §15.)*

Purchases and Trade Receivables are the two figures the see-saws solve for,
and **neither may print negative**. Nobody bought a negative quantity of goods,
and a negative debtor is a creditor — so a statement carrying one is not a
statement that can be issued.

The engine raises both as `level: 'error'` (they used to be warnings):

| Case | Where |
|---|---|
| Purchases solves negative against a held profit | `solveFor: 'purchases'` branch |
| Purchases typed negative | `solveFor: 'pbt'` branch (already an error) |
| Closing Stock solves negative | `solveFor: 'closingStock'` branch |
| Trade Receivables plugs negative | the `balanceVia: 'receivables'` plug |

Both modules then refuse to produce output: `asBlockingIssues()` /
`psBlockingIssues()` filter the errors, `xxSetOutputEnabled(false)` disables
**Print / PDF** and **Download Excel** from `xxRenderReview()`, a red banner
above the Review tables names each figure and its amount, and
`xxGuardOutput(action)` refuses the click as well — so re-enabling a button
from the console changes nothing.

**Clamping to zero was the obvious alternative and is wrong.** Forcing the
figure positive pushes the difference somewhere nobody named and prints a
statement that foots while being untrue — the exact opposite of the rule the
proof rows, Final Account's Net Difference and the reconciliation layer all
follow. The preparer fixes the *inputs*.

**Saving is deliberately still allowed.** A half-finished working paper is
worth keeping; an unissuable statement is not worth printing.

`tools/psVerify.mjs` covers all of it: both cases raise an error, neither is
*also* raised as a warning, and — the regression that actually matters — the
reference workbook, a real issuable year, raises no blocking error at all. A
guard that fired on good data would block every statement the firm produces.

## 2.9 VAT is ticked from the client directory

*(2026-08-29, user ask — "it should automatically be opened without needing to
checkmark". Audited Statement's client scope.)*

`asCy.vatRegistered` is set from **`clients.tax_registration_type === 'VAT'`**
(case-insensitive) when a client is selected, so a VAT-registered client's
Position and Amount fields are present without anyone ticking the box.

- It is **`tax_registration_type`**, the client's own registration — *not*
  `vat_status`, which is whether the firm files their monthly return. The two
  are deliberately different facts (§15).
- **Assigned unconditionally**, so a PAN-only client can never inherit the
  previous client's tick (§9).
- `asSetVat()` now stamps `asTypedOver.vatRegistered`, so a box someone
  unticks by hand is never re-ticked — neither by this prefill nor by the
  Autobooks source load, which has always set it when a VAT position was
  found. That guard was missing before and was a latent bug.

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

**Loans & Borrowings** — each facility by name and balance, in the same four
groups Projection's Loans card uses (Short Term / OD / CC · Long Term ·
Permanent Working Capital · Hire Purchase; user ask 2026-08-21, replacing the
abstract Non-Current / Current pair), *plus the interest each costs*. The
grouping is presentation only: the collector folds Short Term into the engine's
`loansC` and the other three into `loansNC`, so the engine, note 3.8 and its
facility names are untouched. Seeding from the prior year's note 3.8 buckets by
keyword, most specific first — hire/HP/vehicle/auto → HP, permanent/PWC → PWC
(plain "WC Loan" is NOT Permanent WC, the Projection rule), the od/cc/hypo set →
Short Term, everything else Long Term. Interest sits here rather than with the
income figures because it is a fact about a facility, and a finance cost that
lives away from the balance that produced it is one that goes missing.

**This Year's Figures** — Sale of Goods · Commissions & Incentives · Interest
Income · Closing Stock · Trade Receivables · Cash & Bank · Trade Payables ·
Income Tax Paid. Everything marked `grow: true` in `PS_FIGURES` is **seeded at
last year + the default growth** when the prior-year file is read; the seed only
ever fills a box the user has not typed into.

**Tax, TDS & VAT** — Advance Tax, the six withholdings and the VAT position are
each **derived by default and shown greyed**, and each accepts a typed figure.
A month's TDS is often paid on a different base than the year's accounts show,
and the preparer has the deposit slips. **A typed line loses its live Excel
formula and exports as a value** — the honest representation of a figure that
came off a challan rather than out of the accounts.

The card is an **accordion of four sections — Advance Tax · TDS Withholdings ·
VAT · Computation of Income — one open at a time** (`psTaxOpen`, user ask
2026-08-21). Each collapsed header carries a one-line summary (figure +
typed/derived, count of typed TDS lines, VAT side + amount, COI provision) so
nothing is hidden, only folded. Re-rendering on toggle is safe because every
figure lives in `psCy`/`psTds`, never only in the DOM — which is also why the
COI checkbox's touched-override moved off the element into `psCoiTouched`: a
DOM flag unrenders with its collapsed section and would silently revert the
preparer's choice to the automatic rule.

**VAT is only asked for a registered client, and the UI shows ONE side.** A
PAN-only client carries no VAT row at all. A registered one gets a
Payable/Receivable select plus a single amount box (user ask 2026-08-21 — the
two figures never coexist on a return, so showing both boxes was an invitation
to fill both): the select decides which of `vatPayable`/`vatReceivable` the box
writes, defaulting to whichever key holds a value, then the register's own sign
(`psrcVatPosition` — positive net = payable). **Switching sides moves the
figure** and deletes the other key, which is what keeps the engine's
"both sides carry a figure" warning unreachable from this screen; the engine
itself still warns, for input that arrives any other way.

**Drawings / Dividend Paid and Capital Introduced** feed the Statement of
Changes in Equity. The word follows the entity — a company pays a dividend, a
proprietor takes drawings — and `meta.terms.distribution` carries it through to
both the SOCE and the cash flow. (Matching on the string `'Drawing'` missed
`'Drawings'`, which printed "Dividend Paid" on a proprietorship's cash flow.)

### 5.0 Figures the app already holds

`js/provisionalSources.js` (`psrc`) resolves five figures nobody should type
twice. Each returns `{ value, source, detail }` when a source exists and `null`
when it does not, so a client with no saved book carries on typing:

| Figure | Source |
|---|---|
| Revenue from operations | `autobooks_entries` — sales bill lines |
| Purchases of goods | `autobooks_entries` — purchase bill lines |
| VAT receivable / payable | the register's own output less input |
| Debtor / creditor detail | the same rows, per party |
| Depreciation per Income Tax Act | `depreciation_schedules`, scheme `normal`/`special` |

**These read the stored rows; they do NOT call `spbLoadBook()`.** That function
rebuilds Autobooks' global state against *its own* client and fiscal-year
selection, so calling it from here would silently replace whatever the user has
open on that screen. Reading is safe because the rows are already
post-correction — merges, overrides and Data Doctor fixes are baked into
`party_key` and the amounts before they are saved.

**Three of Autobooks' arithmetic rules are carried verbatim** and asserted by
the harness, because drifting from any of them misstates revenue:

- a bill whose `bill_type` ends `_return` carries the **opposite sign**;
- **Taxable Import is its own box**, never folded into taxable;
- **Capital Purchase is a slice of** taxable, never added on top;
- party figures **accumulate** per key — a PAN can cover several party groups,
  and assigning would keep only the last (the bug the Annexure documents).

Nothing is silently overwritten: a sourced box shows where its figure came
from, typing into it claims it, and a reset hands it back.

### 5.1 Two see-saws

Both follow the same idiom: the side you touch is held, the other becomes the
balancing figure and carries a **balancing** badge.

1. **Profit Before Tax ⇄ Purchases of Goods.** Type the profit you need and
   purchases balances to it; type purchases and the profit falls out. One set of
   arithmetic read in either direction (`solveFor` in the engine), so the two
   modes cannot drift. `psVerify` round-trips it: hold the profit the forward
   pass produced and the engine hands back the very purchases figure it started
   from.

   **The PBT box opens at last year's margin carried onto this year's turnover**
   — `profit(CY) = profit(PY) ÷ sales(PY) × sales(CY)`, via
   `ProvisionalStatementEngine.pbtFromMargin()`. That is the firm's own first
   guess at a provisional profit; it is a seed, not a rule.
2. **Trade Receivables balances the balance sheet**, on by default. Profit lands
   in equity, so something on the asset side has to absorb it — the same choice
   the Audited engine makes (§15: cash is seeded, receivables is the plug), and
   unbilled trade is the honest place. Untick it and receivables is typed while
   any residual is *reported* rather than absorbed.

Neither plug is silent: a negative solve warns, and with the receivables plug
off the gap is stated on the review panel.

**Prior year:** uploaded from last year's statement workbook (the same reader
Projection already uses), or carried from a saved Audited Statement.

**The WHOLE `parsePriorYear` output travels to the export layer** (2026-08-28,
fixing a user-reported defect: every prior-year note line printed "–" under a
filled total). `psToOut()`/`asToOut()` pass the full parsed object as
`priorYear`, not just `{ sfp, soi }` — `fsxBuildReport` fills the comparative
detail of notes 3.3/3.9/3.12–3.15 from `payableItems` / `receivableItems` /
`materials` / `employeeItems` / `financeItems` (and the audited clone's cash
flow from `socf`). Three matching rules in `fsxBuildReport`, each earned
against the reference file:

- **3.9 matches by NORMALISED name, exact before inclusion** — the firm spells
  the same head differently across years ("TDS on Wages" vs
  "TDS Payable-Wages"; "payable"/"on" are filler), and raw substring matching
  silently dropped real figures. Exact-first is what stops
  "TDS Payable-Audit fee" swallowing "Audit Fee Payable"'s figure. Each
  prior-year line is claimed ONCE (the engine's spare nil "TDS Payable-Wages"
  row must not double-count the real one), and a line the current year no
  longer carries is appended with a nil CY — dropped, the comparative column
  stops footing to its own total. 3.3 works the same way; its trade line's
  comparative is the SFP total less the parsed other-receivable lines, which
  is exactly the figure the prior-year note itself printed.
- **3.14 matches by KEYWORD, never index** — the prior year's note orders its
  lines per client, so index pairing put a commission figure on the Term row.
- **3.12/3.13/3.15 prefer the engine's own per-line `py`** (keyword-matched /
  alias-merged when the lines were built) over blind index or name pairing.

Two related seeds: `psSeedLoans()`/`asSeedLoans()` carry `py` on each facility
(what note 3.8's comparative prints), and `parsePriorYear`'s 3.8 fence ends at
"Total loans and borrowings" rather than the first bare "Total" — the note
holds a Total after EACH block, so the default fence dropped the whole current
side (Bank Overdrafts) from `loanItems`.

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

### 5.2 Supporting schedules — detail that rolls up

The firm's own working sheets, so a figure is entered **once, as the working
behind it**, rather than twice as a summary:

- **Closing stock** (`stock`) — one amount per group line (user ask 2026-08-21,
  dropping the Particular / Quantity / Rate columns from the UI). The grand
  total becomes Sch-PL's closing stock and the **group totals become note
  3.4**, exactly as the firm's `stock!E11` / `stock!E19` land on separate
  Sch-BS rows. Each row rides the engine's existing amount-override (an amount
  always won over qty × rate), so the engine kept qty/rate support unchanged
  and `psVerify` still proves that path. With no schedule the typed figure
  stands and note 3.4 keeps its three standard heads.
- **Advance tax** (`adv`) — **the voucher-schedule UI was removed 2026-08-21 by
  user decision**; Advance Tax is now the typed/derived box alone. The engine
  keeps its full three-source precedence (schedule → typed → the §2.3 formula)
  and `tools/psVerify.mjs` keeps asserting it, so restoring the screen is a UI
  change only.
- **Party detail** (`p`, `s`) — REMOVED 2026-08-28 by user decision, along
  with the whole Party Detail & Reconciliation card. The register-level
  comparison in `provisionalReconcile.js` stays; only the per-party panel
  went. Recoverable from git history.
- **Extra 3.9 payable and 3.3 receivable lines** (2026-08-28, user ask
  "editable, can add lines, like other expenses") — the **Other Payables &
  Receivables card** (`ps-extras`/`as-extras`, replacing the party panel).
  Seeded from whatever last year's notes carried beyond the standard set
  (Salary Payable, Expenses Payable, Advance to Suppliers, Deposits…), each
  row showing the prior-year figure with this year's balance typed; add-line
  and remove per row. State `psExtraPay`/`psExtraRecv` → engine
  `cy.extraPayables`/`cy.extraReceivables` → `payableLines` (spliced between
  the trading payables and the duties block) and `receivableLines` (after
  impairment), inside the note totals and therefore the balance sheet and
  cash flow. `pyName` keeps the prior-year spelling so a renamed line keeps
  its comparative; a nil-both-years extra drops under zero-suppression even
  above the duties split. Trade Payables / Trade Receivables stay in the
  figures card; **Audit Fee Payable and the TDS lines stay derived**.

### 5.3 Reconciliation

`js/provisionalReconcile.js` (`psrec`) runs after every recalculation. A
statement set that says *"difference: 27,65,951.95"* and stops is barely better
than no check at all — every check here returns a **where** as well as a
**what**: which section moved, which note disagrees with its face figure, which
parties are largest, which working-capital movement drove a cash gap.

Ten identities: the balance sheet - the cash flow - notes 3.1/3.3/3.9 and the
stock schedule against their face figures - profit reaching equity - the COI
bridge - revenue and purchases against the register - each opening against last
year's closing.

Two levels, and the distinction matters:

- **not balancing** — the arithmetic disagrees and the engine can name where.
- **for review** — needs a person. The register comparison is always this: a
  provisional set may deliberately differ from the filed register, and the
  engine can say two figures disagree but not which one is right. Same rule as
  §15's *shown, never forced*.

### 6.0 Seven sheets, in this order

**SFP → SOI → SOCE → SOCF → 3.1 PPE → Sch-BS → Sch-PL**, identically in the
on-screen preview, the print/PDF document and the Excel workbook.

**The COI (Return of Income) page is the eighth sheet, and conditional.** It
appears when the client has an Income-Tax depreciation schedule to bridge to
(or the preparer ticks it on), via `meta.omitCoi`. Six of the firm's eight
reference reports have no COI and charge tax straight off accounting profit;
the two fullest bridge to taxable income, which is what §2.3 implements. Two things follow from the omission: `Sch-PL`'s tax row must carry its own
rate formula (`inc.taxDerive`) since the `X('COI','tax')` fallback would be a
dead reference, and a self-banded schedule prints no sheet-wide title in
HTML/PDF either, or the page would carry a heading the Excel does not have.

### 5.4 Account-head spelling

The firm writes the same head several ways across clients — `Printing &
Stationery` / `Printing and Stationeries`, `Traveling` / `Travelling`, `Misc.`
/ `Miscellaneous`, `Salary` / `Salary Expenses`, and one outright typo
(`Bank comission`). Left alone these are two heads: one grows 5% while the
other sits at nil, and note 3.15 prints both.

`window.PS_HEAD_ALIASES` (`js/config.js`) canonicalises the spellings; the
head LIST stays data-driven, read from the prior-year file. Duplicates are
merged **before** the lines become rows, so a head written two ways is one line
carrying both years rather than two lines each missing one.

**The map's keys are normalised on read**, so an author writes them the way the
head is actually spelled. Writing keys by hand in stripped form is how half the
aliases silently never matched the first time this was written — a key
containing `&` or `.` could never match a lookup that strips punctuation.

Matching is case- and punctuation-insensitive on trimmed word content, the same
conservative rule `wdWorkTypesForLabel()` follows. It must never invent a
meaning: two heads collapse only when they are the same head spelled
differently, which is why the map is an explicit list and not a fuzzy match.

### 6.0b The print renderer must know every row kind

`fsxSheetHtml` builds the on-screen preview AND the print/PDF document, and it
is a **separate implementation** from `fsxWriteWorkbook`. Row kinds added for
Excel therefore have to be taught to it as well, or the printed set quietly
comes out wrong while the workbook is perfect:

- `band` printed as an ordinary row instead of a note's header;
- `fignpr` printed as a stray line;
- worst, a `quad` row carries **four** values into a table sized for **two**, so
  note 3.6 silently lost its comparative Number/NPR pair.

A sheet carrying quad rows is now laid out on **label + 4 columns**, with every
ordinary value cell spanning the pair it sits above, so both kinds of row line
up. The regression check is arithmetic: every `<tr>`'s total colspan must equal
the table's `<col>` count.

**The print document is the monochrome cousin of Projection's** (2026-08-21,
user ask: "just like the projection report format, but no colours"). Same
chrome — white A4 paper cards on a grey ground in the print window, centred
header hierarchy (company 16.5pt, address small and unbolded, title 12.5pt),
bordered tables, and a signature band pinned to the physical foot of each
statement page — every rule in black, white and hairline grey. Three
structural rules came with it, each fixing a reported defect:

- **Statement sheets are flex columns with a page-height minimum in print**
  (`FSX_PAGE_CSS`), which is what pins the signature band (and its Date/Place
  lines) to the same page as its statement instead of letting them spill onto
  the next. Schedule sheets stay block display — flex containers fragment
  poorly, and a schedule legitimately runs past one page.
- **Sch-BS and Sch-PL render one table per 3.x note, each in a
  `.fsp-note-block` keep-together wrapper** — a note either fits where it is
  or moves whole to the next page, never half-and-half. The chunks split at
  each note's own `head` row; 3.1 PPE is one whole block. Verified with
  headless Edge print-to-pdf: all 16 notes of the reference set land on
  single pages.
- **A self-banded schedule gets NO sheet-level thead** — the "Particulars +
  years" header the HTML used to print above Sch-BS was furniture the Excel
  (and the firm's own workbook) never had; each note's own band carries it.
- **Every statement is fitted to its page by a scale pass inside the print
  window** (`FSX_FIT_JS`, second round of the same ask: signatures were still
  landing alone on a following page whenever a real SFP ran taller than the
  reference one). Each non-schedule sheet is measured against the printable
  A4 height and its real font sizes are scaled — down (floor 0.72) when the
  sheet would spill, up (cap 1.22) when it would leave half the page empty —
  the `DocumentEngine.fitPagesToSheet` idea, standalone because the print
  document loads no app code, and like it scaling real font sizes, never CSS
  zoom/transform. Matrix and quad sheets (`data-matrix`) may shrink but never
  grow into their own column rules.
- **Vertical rules run between the year columns** on every value cell, and
  blank spacer rows render per-column cells so the rules run unbroken.
  Quad half-columns get the width the label can spare (a 240px label floor,
  ~115px halves) instead of half an ordinary pair — 71px halves made 3.6's
  figures collide across the rules. Narrow columns step the table font down
  (`fsp-mid` under 125px, `fsp-tight` under 100px).

Third round (same day, user feedback on the second):

- **A note's headings print ABOVE its box and its closing notes BELOW it** —
  `shiftHeadings`/`popFootnotes` in `fsxSheetHtml`. The box (and its year
  rules) wraps only columnar rows, so "3.6 Share Capital" (always that
  heading, even for a proprietorship — user decision 2026-08-22; the entity
  word drives only the note's layout), "Figures in
  NPR" and a statement's "The notes are an integral part…" lines are no
  longer trapped inside the border, and the rules stop exactly at the last
  total row. 3.6's three share-capital sections each get their own
  sub-heading + box.
- **SFP/SOI fix the label column at 300px** so the Notes number sits beside
  the account head instead of across a gulf; the year columns share what
  the label gives up.
- **A provisional cash flow reports the latest year alone** (sliced in
  `fsxBuildReport` so preview, print AND Excel agree — the reference
  workbook's own prior column was a broken `=+#REF!`). The audited set
  keeps both years.
- **3.1 PPE drops the vertical rules in its body** (`fsp-novlines`); only
  its header band is boxed (band top rule + underline + column rules).
- **The "Finished goods include an amount of NIL…" boilerplate is removed**
  from note 3.4 (user decision — both HTML and Excel).
- Base font stepped down to 12px (headers scaled with it) and the fit
  pass's upscale cap lowered to 1.1.

**The see-saw's third end — Closing Stock** (2026-08-22, user ask "both
purchases and closing stock should be balancing figures for each other").
With a profit target held, typing Purchases makes Closing Stock the residual
(`solveFor: 'closingStock'` in the engine — the same 3.12 arithmetic read
backwards once more, in the same solve block, so the modes cannot drift) and
typing Closing Stock hands the balance back to Purchases. Both boxes stay
fully editable; the derived one carries the *balancing* badge and live value.
A stock SCHEDULE always wins (§15 — the schedule IS the figure): the engine
guard falls back to deriving the profit, `psStockAdd` drops the mode, and
`psVerify` proves the round trip plus the guard (140 assertions).

**Typing must never fight the debounced recalc** (2026-08-22, user report:
the Interest & Bank Charges boxes were impossible to type into). Those boxes
and the tax panel's fire `oninput`, and `psRecalcDebounced` re-rendered both
blocks 220ms into a pause — destroying the focused input. Both renderers now
follow the Autobooks confirmation-grid rule: while an input inside them holds
the caret, `psRenderInterest` patches only the running Finance Cost total
(`#ps-fin-total`) and `psRenderTax` skips entirely (its `onchange` re-renders
on blur). Checkboxes and selects still re-render immediately.

**Save to database** (2026-08-22, user ask "reuse the projection report
database saved and search system") — the module is no longer stateless.
`provisional_statements` (see `docs/database.md`) stores identity columns
plus one `inputs` jsonb from `psCollectSaveState()`; **figures are always
re-derived on load** through `psRun()`, never read back from a stored total.
The pieces, each a deliberate reuse:

- **Save** (`psSaveToDb`) — one row per (company, fiscal year): with no
  `psSavedId` it first adopts an existing match by `ilike` name + year, so a
  re-open-and-save can never duplicate; an update never resends
  `created_by` (the projection idiom). Every clear nulls `psSavedId` — a
  stale id once made Projection UPDATE the previous client's row.
- **Browse/search/delete** — the shared `ds-` drawer via
  `DocumentStore.openPicker({fetchRows, describe, onChoose, onDelete})`,
  exactly Projection's shape, with the same orphan guard on delete.
- **Load** (`psLoadSaved`) — clears through `psScope.reset()` first (§9),
  restores every state var and UI field (`psSetFyOption` adds a missing
  fiscal-year option — the `depSetFyOption` lesson), re-runs the engine,
  then calls `psLoadSources({keepTyped: true})`: sources come back for
  provenance badges, party detail and the register reconciliation but
  **never write a figure** — a saved statement's own figures are the
  record, and `psApplySources` would overwrite any the preparer never
  claimed. `psLoadDepreciation()` is deliberately NOT called on load, for
  the same reason: the saved PPE grid is authoritative.
- Audit events `provisional_saved` / `provisional_deleted` (numeric
  `recordRef`, labels in `config.js`); `tools/dbBackup.mjs` `TABLE_ORDER`
  extended in the same commit, or the guard refuses to back up.

**Zero-line suppression, provisional sets only** (2026-08-22, user's
per-note ruleset; gated on `meta.basis === 'provisional'` in
`fsxBuildReport`, so preview, print and Excel agree and the audited set is
untouched). Every note (3.2–3.16) stays visible even at nil — only DETAIL
lines nil in BOTH years drop, so a line real last year keeps its
comparative:

- **3.3** — extra receivable lines (advance tax etc.) drop at nil; Trade
  Receivables, the impairment provision and the portion rows always print.
- **3.8** — a nil non-current facility drops, and when every one is nil the
  whole Non-Current block (sub-heading + Total) goes with them, the grand
  total then summing the current side alone. The current OD/CC side always
  prints, even at nil.
- **3.9** — nil lines at/after the first TDS line (the duties-and-taxes
  block, VAT included) drop; if none survive, the "Duties and taxes:"
  sub-heading goes too. Trading payables above the split always print.
- **3.12** — nil direct-cost lines (Labour, Clearing & Freight, extras)
  drop — they pair with their prior-year figure BY INDEX, so the nil test
  runs on the pair before anything renumbers. Opening, purchases and
  closing always print.
- **3.15** — a head nil in both years drops (otherwise a client's note
  lists every head the firm has ever used at "–").

Dropped rows simply never register their key, and every X() lookup of a
missing key already falls back to a written value — the same degradation
path the quad removal proved. Proven by
`scratchpad zeroLines` assertions (22 checks: nil facilities/duties/heads
gone, structural rows and nil current OD present) plus the standing
pagination suite.

Fifth round (user, with the firm's own reference note): **3.6 Share Capital
is ONE box, not three quad sub-tables.** An italic sub-heading (Authorized /
Issued / Paid-Up Share Capital) and a single "{count} Equity Shares @ Rs.
{face} each" line per section, both years side by side, one Total — and a
proprietorship/partnership (detected from `terms.entity`/`terms.capital`)
carries a single capital line instead. Changed in
`fsxBuildReport`, so preview, print and Excel all agree; the Number×NPR quad
machinery stays in the renderer and writer for reversion but nothing emits
quad rows any more. (The SOCE's `capOpen`/`capAdd` Excel formula lookups
already resolved to nothing — the quad rows never carried keys — so those
cells keep writing values, unchanged.)

**Entity wording & prefilled capital (2026-08-28, user ask — REVERSING the
2026-08-22 "always Share Capital heading" decision).** The Step-1 select is
now three-way — Pvt. Ltd. / Partnership Firm / Proprietorship — carrying both
the tax rule (proprietorship → progressive slabs, the other two → 25% flat)
and the entity wording (`psEntity()`/`asEntity()`; the legacy stored values
`corporate`/`progressive` still map, so old saves restore):

- **The capital heading and line follow the entity**: `T.capital` is
  "Proprietors Capital" / "Partners Capital" / "Share Capital" (the firm's
  own spellings, apostrophe-free), and it drives note 3.6's heading and
  single line, the SFP equity line and the SOCE's first column header — one
  authority, four surfaces. Authorized/Issued/Paid-Up sections print for a
  company ONLY.
- **The three company amounts are prefilled, editable boxes** (`ps-cap-auth`
  / `ps-cap-issued` / `ps-cap-paid`, shown only for a company): on upload all
  three prefill to the prior year's paid-up figure, a typed figure is never
  overwritten, and blank falls back down the ladder (issued → paid-up,
  authorized → issued) in `fsxBuildReport` (`m.authorisedCapital` /
  `m.issuedCapital`; a pre-change save's authorised share COUNT is still
  honoured). **Editing Paid-Up writes `psCy.shareCapital`**, so the note can
  never disagree with the balance sheet — the same rule share counts already
  keep by being derived from the capital.
- **Distribution word**: proprietorship → "Drawings"; partnership AND company
  → "Dividend Paid" (user decision — a partnership says Dividend).
- **Read-back tolerance**: the generated file is next year's upload, so
  `parsePriorYear` accepts every spelling the app now prints — the SFP/SOCE
  capital regexes take "Proprietors/Proprietor's/Partners/Partner's Capital"
  and the SOCF drawing row takes "Drawings". Since 2026-08-29 those patterns
  live in **`WorkbookReader.HEADS`, the shared account-head vocabulary**, and
  Projection Report matches the identical table — the day-one gap was exactly
  that: Projection still matched /share capital/ alone and read a nil capital
  off a proprietorship file this module had generated. A new spelling goes in
  `HEADS`, and `node tools/headsVerify.mjs` proves the matrix, the write-read
  round trip and (with `CORPUS=`) a sweep over real files.

Fourth round (user: "consume less of the page, no format change"): base font
11.5px, tighter cell padding and header spacing, the Notes column 40px, and
**SFP/SOI now fix every column (270px label + 40 + 2 × 150) and the table
hugs that width, centred** — width:100% would hand the slack back to a
column and reopen the gap. Footnotes ride inside the centred wrapper so they
stay flush with the box. **The fit pass no longer scales anything UP**
(maxUp 1) — the compact natural size is the look; it only shrinks a
statement that would spill.

**Column widths are budgeted against the A4 page, never a flat 142px**
(2026-08-21). The print document is `@page A4` with 12mm side margins — about
703 CSS px — and the tables are `table-layout: fixed`, so the unclassed label
`<col>` gets only what the fixed columns leave over. A flat
`col.fsp-c-num { width: 142px }` was tuned for the two-column statements; on
SOCE (five columns + a 46px note column = 756px) the label column resolved to
**zero width** and `overflow-wrap` printed every row label one letter per line,
and a 3.1 PPE with four or more asset classes broke the same way. `fsxSheetHtml`
now computes the width per sheet — `min(142, (700 − note − 170) / columns)`,
emitted inline on each `<col>`, quad half-columns at half a pair — so the
two-column sheets keep exactly 142px/71px and only the matrix sheets shrink.
Two supporting rules: a matrix sheet never renders the (always empty) Notes
column even when its Excel geometry carries `note`, and a sheet whose budgeted
width falls under 100px gets `table.fsp-tight`, one font step down, so figures
still fit unclipped.

Print hygiene lives in `FSX_PRINT_CSS`: a heading stays with the band and rows
beneath it (`break-after: avoid`), a total never splits from the lines it sums
(`break-before: avoid`), and no row breaks across a page.

**A schedule is a run of short 3.x notes, not a page of table.** Breaking after
every sheet is right for the four statements and wrong for the schedules — it
would give Sch-BS's nine notes a page each. Schedule sheets carry `.fsp-sched`
and flow, breaking between notes rather than after every one.

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
