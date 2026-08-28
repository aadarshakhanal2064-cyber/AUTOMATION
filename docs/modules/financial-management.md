# Financial Management

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for Service Memo, VAT Register, Bank Entry, Party Ledger and Final Account — Service Memo, Bank Entry, Party Ledger and Final Account together answer what a client owes; VAT Register (added 2026-08-22) is the firm's own VAT book, which derives its sales side from Service Memo.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.13 Service Memo (`js/serviceMemo.js`, `sm-` prefix, table `service_memos`)

Internal **service record** — the firm's guarantee that no professional work is completed without a recorded fee to collect. Deliberately **not** an accounting/tax invoice (that is Billing, §5.3, which carries bank details, a payment QR and a reconciled payments subtable); a Service Memo is one lightweight row: who did what work for which client, and the Fee. Financial Management tab, seeded from the firm's `Work Performed.xlsx` (a field-spec/dropdown sheet, not data). Architecturally a *lighter Billing* — same client autocomplete, TableEngine list, PDF-Lib generation, AuditLog, self-registration.
- **A memo records the work, NOT the collection** (2026-07-26, department-head spec). Its own `payment_status`/`amount_received`/`payment_date` were **dropped** — money received is entered once as a Bank Entry **Fee Receipt** and netted per client by the **Party Ledger** (§5.16). Don't reintroduce payment fields here: two places to record one payment is exactly what this removed. Verified before dropping — 5 memo rows existed, none with a payment.
- **Five selectable firms** (`SERVICE_MEMO_FIRMS` in config.js): Shailesh & Associates, Dallakoti & Company, Ratnanagar Offset Screen Print, Ratnanagar Tax Consultancy, and **Other — specify** (`typed: true`, name entered per memo into `firm_other`; `smFirmName()` is the one resolver, used by the list, the PDF letterhead and the Party Ledger). SA/DC reference `REP_FIRMS` for full PDF letterhead; the sister concerns carry their own name + memo prefix, address/PAN blank until filled in config (PDF prints "—"). This is the ONE source for both the firm dropdown and the PDF letterhead — a new firm needs **no migration**.
- **Memo number** assigned by an AFTER INSERT trigger (`set_service_memo_number`, mirrors `set_invoice_number`): the app sends `memo_prefix` from config (`SM-SA`/`SM-DC`/`SM-ROSP`/`SM-RTC`/`SM-OT`) and the trigger builds `prefix || '-' || lpad(id,5,'0')` → `SM-SA-00001`. Re-fetch after insert (memo_number isn't in the INSERT RETURNING — same gotcha as invoices).
- **Nature of Task** is a category → sub-category tree (`SERVICE_MEMO_TASKS`, seeded from the Excel with typos fixed and "OCR" relabeled "Company Registrar (OCR)"); every category ends in "Others" → a free-text `nature_other` box appears. Easily extended in config.
- **VAT stays per-memo**: the `apply_vat` checkbox drives `vat_amount`/`total_amount`. The Party Ledger prints **that stored figure**, not a blanket 13% (which is what the department head's sheet hardcoded) — so a non-VAT memo never shows the client a VAT charge it was never billed.
- **In-panel list only** — Recent Memos + the filter/table block, behind a `.rep-view-toggle` (**Memos** / **Pending Memos**, 2026-08-10, relabeled from "Pending Audit Fees" → "Audit Fees" → "Pending Memos" over 2026-08-15 as the list stopped being audit-only and the columns got clearer names). The stat grid went with the payment columns (its one card, "Total Collected", had no source left).
- **PDF** via PDF-Lib (the pattern came from the old `billingBuildInvoicePdf`, removed 2026-08-18 — this is now the app's only PDF-Lib caller), re-skinned as a formal **SERVICE MEMO** stamped **"Internal service record — not a tax invoice."**
- Fiscal year: **dash** (`2081-82`), free text so one memo can still span several years (`2080-81/2081-82`) as the firm's sheet does — `sm-fiscal-year` also carries a `<datalist>` of suggested years (`smFyOptions()`) so it's pick-or-type, not a closed dropdown. **Default fixed at `SM_FY_DEFAULT = smFyLabel(window.FY_DEFAULT_START)`** (2026-08-10, replacing the earlier `NepaliLocale.todayBs()`-derived default; reads the shared `window.FY_DEFAULT_START` since 2026-08-15) — matches Audit Report Finalization's own `ARF_FY_DEFAULT` and every other module's fiscal-year default, so a year rollover is a single-line change in `js/config.js` instead of drifting to whatever today's actual B.S. date computes to. Selecting **Audit → Statutory Audit** caps the datalist at `SM_FY_AUDIT_CAP = 2082` and below (an audit is always for a completed year) and fills the field with the default **only if it's still blank** — never overwrites a year already typed or prefilled. Filters: firm, category, FY, date range + fuzzy search. `client_id` is a **nullable** FK (typed-only clients still save; name/PAN/address always snapshotted). Migrations: `db/2026-07-21_service_memos.sql`, then `db/2026-07-26_financial_suite.sql`.
- **Pending Memos — two sources, never stored twice** (2026-08-10, extended to Projection Report and relabeled 2026-08-15; briefly narrowed to ARF-only on 2026-08-22 and reverted the same day — that removal was a mistake, don't repeat it). The moment a client's IT Return or Tax Clearance track (§5.21) is verified for a fiscal year, that year's statutory audit fee is due to be memoed — regardless of which of the two got there first. **Estimate Return is deliberately NOT a trigger and never appears in the list — verified or not** (2026-08-21, user decision): it is interim work inside the same engagement, not separately billable, so `smFeeDueRows()` skips `return_type === 'estimate_return'` rows outright, which also keeps its badge out of the Detail column. `smLoadArfVerified()` reads `audit_report_finalization` directly (the same idiom Work Done uses for its own Pending List over `document_register`, CLAUDE.md §15) rather than caching a second copy of the fact. **A second source, saved Projection Reports, was added 2026-08-10 — updating an existing report writes to the SAME `projection_reports` row (Projection's own New Task / Updation split, §5.20), so deriving the fee-due list straight from that table is what keeps a re-run or an update from ever appearing twice; nothing about "was this saved before" is stored here.** `smFeeDueRows()` unions both sources with a `kind: 'audit' | 'projection'` tag: audit groups verified ARF rows by `(client_id, fiscal_year)` and drops once an **Audit / Statutory Audit** memo exists for that client+FY; projection groups saved reports by `(client_id or lower-cased company name, fiscal_year_base)` and drops once a **Bank Loan Related / Provisional/Projected** memo exists for that client+FY (the category picked was the closest existing `SERVICE_MEMO_TASKS` fit — user decision 2026-08-15, not a new picklist entry). Both sides match years via `NepaliLocale.fyStartYear()` since ARF's fiscal year is slash format (`2082/83`) and Service Memo's/Projection's is dash (`2082-83`). The table's **Detail** column spells out the actual work (ARF track badges, or "N-year Projected Financial Statements, based on F.Y. …") and **Done By** names who performed it (ARF's `auditor` or Projection's `performed_by`, "—" when blank). Clicking **Add Fee** opens the ordinary New Service Memo drawer via `smOpenCreate(null, prefill)` prefilled with client, Nature of Task, fiscal year and a description — the user only has to type the Professional Fee. Neither source is cached through `DataCache` (§4) — small tables, re-fetched fresh on every Service Memo refresh.
- **The Firm on a memo created from Pending Memos' ARF ('audit') side is LOCKED to Audit Report Finalization's own `auditor` value** (2026-08-22, user decision) — `smFirmKeyForAuditor()` matches ARF's `auditor` string against `window.SERVICE_MEMO_FIRMS[].name` (by name, not `firm_key` — ARF has never stored a firm_key). ARF's `auditor` dropdown (`window.ARF_AUDITORS`) is wider than the two real firms (also `'Non-Sign'`, staff names, `'Other'` free text), so when a pending row's auditor doesn't resolve to a firm, `smOpenCreateFromPending()` **blocks** — no drawer opens, and `#sm-pending-status-area` names the record's current auditor value — rather than leaving the firm editable or guessing. When it does resolve, `smOpenCreate()` sets `#sm-firm-key` to that firm and **disables the select** (`prefill.lockedFirmKey`), with `#sm-firm-locked-note` explaining why; the only way to change it is to edit the Auditor field back in ARF and re-open "Add Fee". **A projection-sourced row has no auditor concept and is unaffected** — it opens with the Firm select fully editable, exactly as before, same as a manually-started blank memo or editing an already-saved memo directly. Editing ARF's Auditor after a memo already exists does not rewrite that memo; it only changes what the next "Add Fee" for that client+FY locks to.
- **Pending Memos' "Delete" dismisses the reminder, backed by `service_memo_fee_skips`** (2026-08-15) — the list above is derived, so there is no record to delete when a reminder isn't wanted (billed a different way, genuinely not due). `smDismissFeeDue()` inserts one row keyed on `(client_id or client_name, fy_start_year, kind)` after a confirm; `smIsFeeSkipped()` excludes a match in `smFeeDueRows()` the same way an existing memo does. No undo UI — a skip only reverses if the underlying ARF/Projection record changes and re-derives the same group.
- **Duplicate guard on save** (2026-08-21, user ask — part of the app-wide "one client + one fiscal year must not be entered twice" pass). A NEW memo whose client, fiscal year (matched via `NepaliLocale.fyStartYear()`, so `2082-83` and a multi-year string starting there compare equal) and nature category + sub-category all match an existing memo raises a `confirm()` naming that memo (number, nature, amount); cancelling aborts with a status pointing at it. **A confirm, not a hard block** — two genuine memos for the same nature can exist (e.g. two phases of one engagement) — and edits are exempt. This also protects the Pending Memos derivation: an accidental second Statutory Audit memo is exactly what its drop-off logic keys on.
- **Print / Preview, Export PDF, Export Excel** (2026-08-15) act on whichever view is showing — Memos (the currently filtered/searched table) or Pending Memos — the ARF/Work Done idiom (`smActiveModel()` picks the model, `smBuildMemosModel()`/`smBuildPendingModel()` build it, both over `ReportExport`). `smCurrentFilteredRows()` is shared by the on-screen table and the export, so what's exported always matches what's on screen.

### 5.22 VAT Register (`js/vatRegister.js`, `vr-` prefix, tables `vat_purchases` + `vat_returns` + `vat_collections`)

> Numbered 5.22 because it was the next free number, not because of where it sits — in the
> menu and in reading order it comes straight after Service Memo, whose output it consumes.

The firm's **own** VAT book. Both audit practices are VAT-registered, and until 2026-08-22 their
register was a spreadsheet (`VAT Registar.ods`) re-typed from data this app already held. A
**client's** VAT book is Autobooks (`docs/modules/autobooks.md`) — nothing here reads or writes
client VAT, and the two must not be confused. Financial Management menu, between Service Memo
and Party Ledger; `vrInit()` in `MODULE_INITS`. Reuses `ReportExport`, `TableEngine`,
`NepaliLocale`, `DataCache`, `WorkflowEngine.withBusyButton`, `AuditLog` and self-registration.

**Four views** behind one `.rep-view-toggle`, sharing a **Firm + F.Y.** context bar (plus a
**Period** picker that appears only on the Masebari):

| View | Source | Stored? |
|---|---|---|
| **Sales Register** | `service_memos where apply_vat` | **nothing** — derived |
| **Purchase Register** | typed | `vat_purchases` |
| **Masebari** | computed from the two above | `vat_returns` — adjustments + opening only |
| **VAT Collected** | derived worklist + typed receipt | `vat_collections` |

- **THE SCOPE RULE, and it is the least obvious thing in the module.** A VAT return is about the
  date a bill was **issued**, never the fiscal year the work relates to. A memo dated Bhadra 2083
  for FY 2081-82 audit work is a Bhadra 2083 VAT sale. So every view scopes on the **date's**
  fiscal year (`memo_date` / `bill_date` / `payment_date`), while the sheet's **F.Y column prints
  the memo's own `fiscal_year`** as a work reference — a different fact that happens to share a
  name. Scoping on `service_memos.fiscal_year` would silently file sales in the wrong year, and
  the register would still look plausible. `vat_purchases.fiscal_year` and
  `vat_collections.fiscal_year` are therefore **derived from the date on save, never typed** — a
  denormalisation that exists for the index and cannot disagree with the date it came from.
- **The sales register stores nothing** (the ODS says so outright: *"If we add Tick VAT in Service
  memo then this sheet will be auto generated"*). Same idiom as Work Done's Pending List over
  `document_register` and Service Memo's Pending Memos over `audit_report_finalization`. It reads
  through the **existing shared key** `LEDGER_KEYS.memosSm` with the byte-identical loader
  `smRefresh()` uses, so the two tabs are one round-trip and a memo write already invalidates it.
  Its **VAT column prints each memo's stored `vat_amount`, never a recomputed 13%** — the Party
  Ledger rule (§5.13); the ODS formula `=+F11*0.13` is a sketch, and a memo billed at a different
  figure must print what was billed.
- **Edit on a sales row opens the Service Memo drawer; there is no Delete** (user decision
  2026-08-22). The row *is* a memo, so editing it means editing the memo — the drawer lives at
  body level, outside every tab panel, so it opens over the VAT Register correctly (verified).
  Deleting from here would also destroy the fee record and the Party Ledger entry.
  **`smReload()` calls `vrOnMemosChanged()`** (guarded with `typeof`, the
  `salesPurchaseBookConfirm.js` / `workDoneTodo.js` idiom) — without it a figure corrected from
  this very screen would stay stale until the tab was reopened.
- **Periods are bucketed by B.S. MONTH, never by day arithmetic.** T1 = fiscal months 1–4
  (Shrawan–Kartik), T2 = 5–8, T3 = 9–12, off `window.VR_PERIODS`. **This is the module's one real
  correction to the spec sheet**, which wrote its periods as literal spans ending
  `07.30 / 11.30 / 03.31`: five of the eleven tabulated B.S. years (2081, 2083, 2084, 2087, 2088)
  have a **32-day Ashadh**, so a bill dated Ashadh 32 belongs to no period under those literals
  and vanishes from the return with nothing on screen saying so. A month number cannot be wrong.
  The printed span *label* is rebuilt from the calendar via the new
  **`NepaliLocale.bsMonthEnd(year, month)`** and degrades to blank outside 2080–2090 — bucketing
  never depends on it.
- **Filing is trimester-only** (user decision) and the return is **deliberately not lockable** —
  no filed flag, no snapshot; it always recomputes from current data, exactly as the spreadsheet
  does. **The opening credit is typed by hand** every period, not carried forward; deriving it was
  offered and declined.
- **The Masebari draws TWO total rows where the sheet draws one.** The ODS's single `Total` mixes
  the two sides (`B20 = C15+C18` is a purchase amount, `C20 = D11+D17` a sales VAT), which cannot
  be read. Split into *Total Sales / Output VAT* and *Total Taxable Purchase / Input VAT*, the
  Difference is visibly Output − Input. Same answer, and both totals foot to their own components
  (asserted). **Tax-free purchase is shown on its own line and excluded from the input total** —
  there is no VAT on it to claim; the sheet's own formula excludes it the same way. Each
  adjustment carries a **reason**, printed inline: an adjustment with no stated reason is what
  makes a filed return unauditable a year later.
- **Purchase heads: assets read `DEP_SLM_CLASSES`, expenses are an open datalist.** Asset classes
  are offered as a **closed select** of the depreciable classes, so a firm asset bought here and
  the SLM schedule that writes it off name it identically and a class added to that config list
  reaches this picker for free. **Land is correctly absent** — not depreciable, and a land purchase
  is not a VAT purchase. Expense heads merge `VR_EXPENSE_HEADS` (the sheet's ten) + heads already
  typed here + **expense names already used in Bank Entry** — the sheet's *"Option to add
  expenses"*, via the `bbPopulateExpenseNames` idiom. That last source is the user's 2026-08-22
  decision that the two modules share the **vocabulary and deliberately not the figures**.
- **No VAT Register figure reaches Final Account** (same decision), and this is verified by
  construction: `finalAccount.js`, `partyLedger.js` and `bankBook.js` contain **zero** references
  to this module or its tables. VAT Register reads only `bbTxns`/`bbAccounts` for vocabulary and
  `smNatureText`/`smOpenCreate` for display and editing. A bill entered here and also paid through
  Bank Entry would otherwise be counted twice.
- **`total` is never stored** — `tax_free + taxable + vat`, derived at read time (the Bank Entry
  "no stored balances or numbers" rule). **VAT auto-fills at `VAT_STANDARD_RATE` but only ever
  fills a blank box** and stops auto-filling once touched: a supplier bill rounds its own way, and
  the register must print the bill.
- **The bill drawer names the period the typed date actually lands in**, in red when it falls
  outside the selected fiscal year. The bill is filed by its date, so a wrong year is a real
  mistake worth showing before the save rather than after.
- **Duplicate guard is a warn-and-confirm, not a block** (CLAUDE.md §15): same bill number + same
  party (matched on PAN when present, **normalised through `toEnglishDigits`** so a Devanagari PAN
  matches its English twin) in the same fiscal year raises a `confirm()` naming the existing bill.
  Two suppliers legitimately issue the same number. Editing a bill never flags itself.
- **VAT Collected is standalone** — the sheet states twice that it "has no link with Sales,
  Purchase, Maskebari". *Outstanding* is derived (every VAT memo with no `service_memo_id` row
  against it) so it cannot go stale; the receipt half (date, voucher, bank) is typed. `bank_name`
  is an open datalist seeded from `bank_accounts`, **not** an FK — the sheet asks for where a
  voucher was deposited, which need not be one of the firm's own accounts. `service_memo_id` and
  `client_id` are both `on delete set null` with the name/PAN snapshotted: deleting a memo must
  not erase the record of money that actually came in.
  **Open question, flagged not acted on:** a VAT receipt from a client is in substance money in,
  which Bank Entry's *Fee Receipt* already records (its `total_amount` includes VAT) and Party
  Ledger already nets. Built standalone as the sheet demands and the user confirmed; worth a later
  conversation about whether the two should be one record.
- **Firms are the two audit practices only** — reuses `FINAL_ACCOUNT_FIRM_KEYS`, the same set
  Final Account draws a Balance Sheet for, rather than a second list that could drift. Read inside
  a function, never at file load (OrgIdentity fills it after sign-in).
- Fiscal year: **dash** (`2083-84`), defaulted from `window.FY_DEFAULT_START`. Every view exports
  **Print / Preview + PDF + Excel** through `ReportExport` off `vrLastModel`, so the export always
  matches what is on screen. The print window redefines its own colours as literals — it does not
  load `css/styles.css` (the `.rep-blank-fill` lesson).
- **Harness: `node tools/vrVerify.mjs`** — 85 dependency-free assertions covering period
  bucketing (including a walk of every day of F.Y. 2083-84 proving no orphans), the Masebari
  arithmetic against hand-worked figures, the duplicate guard, the head vocabulary and the report
  models' colspan arithmetic. It loads the real `js/vatRegister.js` in a `vm` context rather than
  copying its logic. **Run it before and after any change to the derivation rules.**
  Migration: `db/2026-08-22_vat_register.sql`.

### 5.14 Bank Entry (`js/bankBook.js`, `bb-` prefix, tables `bank_accounts` + `bank_transactions`)

> Displayed as **Bank Entry** since 2026-07-25 (Financial Management menu). Everything in code — the file, the `bb-` prefix, the `bankBook` module id, both table names — still says Bank Book.

Receipts & payments ledger for the firm's **own** bank accounts — internal bookkeeping (the firm's cash/bank position), **not** a client-facing document. Launched from the topbar **Financial Management** menu (`buttonId: null`, `bbInit()` in `MODULE_INITS`). Seeded from the CA's `Work Performed.xlsx` sketch. One panel with three sections toggled by a `.rep-view-toggle`: **Accounts**, **Transactions**, **Reports**. Reuses TableEngine, `SearchEngine.attachAutocomplete` (client link on Fee Receipt), NepaliLocale (B.S. dates), PDF-Lib + ExcelJS (exports), AuditLog, self-registration.
- **Accounts master** (`bank_accounts`, user-managed CRUD — the holder/bank list is **data, not JS config**, unlike `SERVICE_MEMO_FIRMS`): **Firm** (required, `firm_key`), Account Name (holder), Bank Name, Account Number (text, preserves leading zeros), Opening Balance + opening date (B.S., FY start). Sample holders span both firms + two individuals (Devi Prasad Dallakoti, Shailesh Dallakoti). **Firm is required on save** — Final Account splits Bank Balance per firm, so an unassigned account would silently vanish from the Balance Sheet. It is also how every bank row is attributed to a firm: transactions carry no firm of their own, only an account. A cash balance is just an account row (e.g. "Cash in Hand") — no `is_cash` flag. An account **with transactions can't be hard-deleted** (FK `on delete restrict` + a JS guard) — it offers **soft-deactivate** (`is_active=false`) instead, so history survives; zero-transaction accounts delete outright.
- **Transactions** (`bank_transactions`): one row per receipt/payment. `particular` ∈ receipts `fee_receipt`/**`for_tax`**/`sapati`/`inter_bank_transfer`, payments `expenses`/**`tax_payment`**/`sapati`/`inter_bank_transfer` (config maps `BANK_RECEIPT_TYPES`/`BANK_PAYMENT_TYPES`). The two tax particulars were added 2026-07-26 (the sheet marks both "to be add"): **For Tax** = money taken from a client earmarked for tax, **Tax Payment** = tax the firm paid on a client's behalf. The drawer's contextual party field relabels per particular — the three **client particulars** (`BANK_CLIENT_PARTICULARS` = `fee_receipt`/`for_tax`/`tax_payment`) show the client autocomplete and set `client_id` + snapshot; Sapati → person; Expenses → free-text name backed by a **datalist of expense names already used** (`bbPopulateExpenseNames`, so the Expenses Ledger doesn't fragment on near-duplicate spellings); Transfer → counterpart-account select.
- **Inter-bank transfer** is entered **once** (From → To) and stored as **TWO paired rows** sharing `transfer_group_id` (a `crypto.randomUUID()`): a `payment` leg on the source (`counterparty_account_id` = dest) and a `receipt` leg on the dest (`counterparty_account_id` = source). **Editing or deleting either leg acts on BOTH** (`bbTransferSiblings`) so they can never desync — the module's key integrity rule.
- **Reports** (per account, B.S. `From→To`): **Receipt register**, **Payment register**, and a running **Statement** (opening balance for the range = account opening + net of everything before `From`, then running balance per row, closing at the end). B.S. dates ordered/compared via `NepaliLocale.bsOrdinal` (2080–2090 table). On-screen HTML table + **PDF** (PDF-Lib, A4 landscape, page-breaking) + **Excel** (ExcelJS, merged header/borders/accounting format `#,##0.00;(#,##0.00);"–"`, live SUM/opening/closing).
- **No stored balances or numbers**: running balances derived at read time (billing-overdue discipline); no memo-number trigger (transactions carry no external number). Fiscal year: **dash** (`2083-84`), derived from `txn_date`. RLS member-CRUD on both tables. Migrations: `db/2026-07-22_bank_book.sql`, then `db/2026-07-26_financial_suite.sql`.
- **Bank Entry is the only place a payment is recorded.** Fee Receipt / For Tax / Tax Payment all flow into the Party Ledger (§5.16); Expenses and Sapati flow into Final Account (§5.17).

### 5.16 Party Ledger (`js/partyLedger.js`, `pl-` prefix, table `party_opening_balances`)

**The join between Service Memo and Bank Entry.** Neither alone can say what a client owes: the memo records work done, the bank records money moved. Built 2026-07-26 from the department head's `Work Performed.xlsx` (replacing the `moduleComingSoon()` stub). Financial Management tab, `plInit()` in `MODULE_INITS`. Reuses `SearchEngine.attachAutocomplete`, `NepaliLocale`, `AuditLog`, **ReportExport** (§4) and self-registration.

**Four views** behind one `.rep-view-toggle` (the four buttons drawn on the sheet), sharing the **Firm** + **From/To (B.S.)** controls:

| View | Shows |
|---|---|
| **Party Ledger** | one client's statement — `Date · Particular · Taxable Amount · VAT · Total · Description`, sectioned Add: Service Provided → Add: Tax Paid on Behalf → Less: Payment, then Net Payable / Opening / **Total Payable** |
| **Party List** | every party: `Party Name · PAN · Opening · Work Performed · Tax Paid · Payment Received · Balance` + Total |
| **Expenses Ledger** | one expense name's entries: `Date · Particular (bank account) · Amount · Description` + Total |
| **Expenses Name List** | `Expenses Name · Amount` grouped, + Total |

- **The sign convention** (from the sheet's Net Payable formula) — `Total Payable = Opening + Service Provided + Tax Payment − Payment`. Services come from `service_memos` (their own stored `vat_amount`, §5.13); Tax Payment from bank payments made on the client's behalf (it *increases* what they owe); Payment from bank receipts `fee_receipt` + `for_tax`.
- **`plPartyBalance()` is THE balance function** and `plBuildParties(firm, range)` takes its scope as arguments rather than reading the DOM — that is what lets Final Account ask for a different firm/period and still get an identical figure. Party List's Balance column and Final Account's Total Receivables are literally the same call, so the three views can never disagree. Party List deliberately carries **Opening and Tax Paid columns the sheet didn't draw** (user-approved) so each row visibly foots to that Balance.
- **The date-format bridge**: `service_memos.memo_date` is a Postgres `date` while every bank row and every range bound is B.S. text. `NepaliLocale.adToBs()`/`bsToStr()` (added here) convert memos into B.S. so one ledger can list both. An unparseable row date never excludes the row.
- **Party matching**: `client_id` when set, otherwise the typed name resolved against `clientsList` (`plPartyKey`) — a typed-only client still collects its own rows instead of scattering.
- **Only the opening balance is stored** (`party_opening_balances`, upsert on `(client_id, firm_key, fiscal_year)`) — it is the one figure that can't be derived. Saving requires a *selected* directory client. Everything else is computed at read time.
- Every view exports **PDF + Excel** through `ReportExport`. Fiscal year: **dash** (`2083-84`), derived from the From date.

### 5.17 Final Account (`js/finalAccount.js`, `fa-` prefix, no table)

The firm's own **Income Statement** and **Balance Sheet** for a period. Financial Management tab, `faInit()` in `MODULE_INITS`. **Nothing is entered here and nothing is stored** — it is purely a view over the other three modules, reading through `partyLedger.js`'s loaded state (`faInit` calls `plRefresh()` rather than keeping a second copy of the data).

- **Income Statement** (follows the firm selector): `Income` = service memos grouped as `<Sub-Category>/<Category>`; `Expenses` = bank Expenses payments grouped by name (via `plExpenseTotalsFor`); `Net Income` = the difference. Income uses each memo's **`total_amount` (fee + VAT)**, not the fee alone — the receivable and the bank receipt both include VAT, so anything else breaks the proof below by exactly the VAT.
- **Balance Sheet** — drawn as the sheet lays it out: **one column per audit firm, side by side** (`FINAL_ACCOUNT_FIRM_KEYS` in config.js), each independent of the Income-Statement selector. Rows: Net Income · Bank Balance (per account, cumulative to the To date) · Total Receivables (per party, `plReceivablesFor`) · Total Sapati · **Net Difference**.
- **Sapati sign** (the sheet's own note): a sapati **received** shows as (−), a sapati **paid** as (+) — i.e. net owed *to* the firm, per person.
- **`Net Difference` is the point of the module.** `Net Income − Bank − Receivables − Sapati`, labelled "always zero", green at zero and red otherwise. It proves the four modules agree. It is **shown, never forced**: a party opening balance carried in from an earlier period has no matching income or bank movement inside the period, so it surfaces here as a difference of exactly that amount. Verified: with no carried-in opening the figure is exactly `0.00`; with a 2,500 opening it is exactly `−2,500`. Don't "fix" that by hiding it.
- Exports **PDF + Excel** via `ReportExport`, plus **Print** (a standalone print window, the sheet's "Save/Print" — which is why the proof row's colours are literal hex, not CSS variables).


---

## Shared ledger data is cached (2026-08-01)

Bank Entry, Party Ledger and Final Account read the same four tables, and
`tabs.js` re-runs a module's init on **every** tab open. Opening the three in a
row used to download `bank_transactions` in full three times; measured after
the change, that sequence is 5 round-trips instead of 10.

All four loads now go through `DataCache` (`docs/engines.md`), keyed by
`window.LEDGER_KEYS` in `config.js`. Two rules matter when editing these
modules:

- **`plRefresh()` / `bbRefresh()` / `smRefresh()` read only — they must never
  invalidate.** Invalidating there would make opening a tab discard the cache
  it is supposed to be using.
- **Every write path calls `bbReload()` / `smReload()`** (invalidate + refresh),
  and those drop the *other* module's keys for the same table too. A Service
  Memo write drops Party Ledger's `service_memos` key as well as its own,
  because the two read that table under different queries; without it a new
  memo wouldn't reach the ledger until the 60s TTL expired.

Party Ledger's opening-balance save invalidates `openings` before re-reading,
for the same reason.

---

## 5.16b VAT Collected — the two ways a memo's VAT is resolved (2026-08-29)

The Outstanding list is derived: every VAT memo with nothing recorded against
it. It used to have exactly one exit — **Record collection**, meaning the
client paid the firm. The firm's real practice has two:

> *"sometimes client pays the vat themselves and sometimes i pay for them
> which i already include in my fee"*

So each outstanding row now offers **Add to Party Ledger** beside Record
collection. It marks that memo's VAT as **borne by the firm**, and the row
leaves Outstanding by that second route.

**The mark lives on the memo** — `service_memos.vat_ledger_at` /
`vat_ledger_by` (`db/2026-08-29_service_memo_vat_party_ledger.sql`), not in a
new table. Which of the two happened is a fact *about that memo's VAT*;
`vat_collections` exists because a collection has its own date, voucher, bank
and amount, and "the firm bore this" has none of those. **Presence of
`vat_ledger_at` IS the flag** — no separate boolean, so the two cannot
disagree.

Marked memos are shown in their own **Carried to Party Ledger** block with an
**Undo**, not silently dropped — the same rule the Activity Log follows. The
block hides itself entirely when empty, so it costs nothing for a firm that
never uses it.

This module now **writes** to `service_memos`, so `vrReloadMemos()` invalidates
**both** `LEDGER_KEYS.memosSm` and `memosPl` before refetching (§ the DataCache
rules at the end of this file) — Party Ledger reads that table under a
different ORDER BY and would otherwise show the stale memo for up to 60s.

### The arithmetic is deliberately NOT wired yet

User decision: *"we will add features later where to connect and all."* The
marker records what happened and the screen says plainly that nothing is
posted. That restraint is deliberate, not laziness — **the sign is genuinely
ambiguous and a wrong one misstates a receivable:**

`plBuildParties()` already pushes each memo's `total_amount` onto the party's
`services`, and **that figure includes `vat_amount`**. So the client is
*already* charged this VAT in the ledger. When the firm bears it instead,
either:

- **it should raise the balance again** — the firm paid tax on the client's
  behalf, which is exactly what the existing `p.taxes` bucket models (fed today
  only by Bank Entry payments with `particular = 'tax_payment'`); or
- **it should leave the service line alone** — the fee already covered the VAT,
  so what the client owes is unchanged and the marker is purely informational.

Those differ by twice the VAT. It is a question about the firm's own billing,
not something to infer from the schema. **Answer it before wiring
`plBuildParties()`**, and add the resulting rule to CLAUDE.md §15.

---

## 5.17 The section lock (`js/core/sectionLock.js`, `sl-` prefix)

Added **2026-08-29** on the user's ask: *"lock the financial management section
so that no one is able to see what's inside it, only a specific person — a
personalised lock, only openable with a password, and resettable if I ever
forget it."*

### Where the lock actually is

**In the database, not in this file.** The app is entirely client-side, so a
password checked in JavaScript stops nobody: any signed-in member could read
`service_memos`, `bank_transactions` or the firm's VAT book straight off
PostgREST with the publishable key, never loading the UI at all. So all **31
RLS policies** over the section's **eight tables** gained one more conjunct:

```
and (select private.fin_unlocked())
```

`js/core/sectionLock.js` is the door in front of that: it exists so a locked
member sees a password box rather than five modules that render empty. Deleting
it, or flipping any of its flags from the console, yields empty modules — never
open ones. Nothing in it is trusted, and nothing in it needs to be.

The eight tables are exactly the ones these five modules own, verified by
grepping every `from('<table>')` in `js/` before the migration was written:
`service_memos`, `service_memo_fee_skips`, `vat_purchases`, `vat_returns`,
`vat_collections`, `party_opening_balances`, `bank_accounts`,
`bank_transactions`. Final Account queries nothing itself — it is a pure view
over Party Ledger's state (§5.17 above) — so those eight close the whole
section. **Autobooks is a *client's* VAT book in different tables and is
deliberately not locked.**

### Three facts decide access

All on `org_members`, all read in one call to `fin_status()`:

| Column | Meaning |
|---|---|
| `fin_access` | An owner or admin ticked this member in **Team → Financial**. Default false. |
| `fin_password_hash` | That member's **own** bcrypt section password. Two granted members have two passwords and neither opens the section with the other's. |
| `fin_unlocked_until` | Deadline on the current unlock (4 h). **This is what RLS reads.** |

Plus `fin_failed_attempts` / `fin_lockout_until`: five wrong tries costs a
fifteen-minute wait. A section password is short by nature — people pick
something they can type twenty times a day — and an RPC can be called in a loop.

`unlocked()` is computed from the deadline rather than from the server's own
`unlocked` boolean, so a window that expires while a tab sits open closes itself
with no polling and can never disagree with what RLS decides on the next
request. `refresh()` **fails closed**: a status call that did not answer is not
permission.

### The back door that nearly made it decorative

Found while verifying the policies, and worth remembering as a class of bug.
`org_members` carries `org_members_update_admin` (`db/2026-08-18_stage3_
invitations.sql`), which lets **any admin or owner UPDATE any member row** in
their organisation. That policy is right for what it was written for — Team's
role and status controls — but it meant an admin could run

```sql
update org_members set fin_access = true,
       fin_unlocked_until = now() + interval '99 years' where email = '…';
```

over PostgREST and read the entire section without ever knowing a password. RLS
was gating the rows while nothing was gating the gate.

The fix is a **privilege, not another policy** — a policy decides *which rows*,
and the problem was *which columns*. Postgres cannot subtract a column from a
table-wide UPDATE grant, so the grant is withdrawn and re-issued for the two
columns Team actually writes:

```sql
revoke update on public.org_members from authenticated, anon;
grant  update (role, status) on public.org_members to authenticated;
```

The six `fin_*` RPCs are `SECURITY DEFINER` and execute as their owner, so they
are unaffected. **The general lesson: when a policy starts depending on a
column, check who can write that column.**

### The six RPCs

Nothing writes the five `fin_*` columns directly; every transition goes through
a `SECURITY DEFINER` function that decides for itself what is allowed. Each
returns `json` rather than raising, because "wrong password" is an ordinary
answer and not an error.

| Function | Notes |
|---|---|
| `fin_status()` | granted / hasPassword / unlockedUntil / lockedOut. Returns null with no membership row — the engine treats that as denied. |
| `fin_set_password(current, new)` | First-time set, or a change. A password already set can only be changed by someone who knows it, or an unattended signed-in tab is enough to take the section over. Unlocks on success. |
| `fin_unlock(password)` | Opens a 4-hour window. Counts failures; returns `attemptsLeft`. |
| `fin_lock()` | Clears the window. Takes no password — locking is never the dangerous direction. |
| `fin_reset_password(account_password, new)` | The forgot path. Verifies the caller's **own Supabase account password** against `auth.users` inside Postgres rather than re-signing-in from the browser, which would churn the session token on every reset. |
| `fin_set_access(email, grant)` | Owner/admin only, own org only. **Revoking wipes the password and the window in the same statement**, so a revoked member is shut out now rather than at the end of their window. |

### Deliberate UI choices

- **`lockNow()` reloads the page.** Switching tabs only toggles a panel's
  `active` class: every row Bank Entry or Service Memo rendered is still in the
  DOM, and the module globals still hold the arrays behind them. A "Lock now"
  that leaves the ledger one devtools panel away is theatre. Locking is always a
  deliberate act, so a reload costs nothing anyone was relying on.
- **`signOut()` calls `fin_lock()`** — the deadline lives on the member row, not
  in the tab, so without it the next person on a shared machine would still be
  inside a window opened hours ago.
- **The topbar menu and the command-palette entries are hidden** for an
  ungranted member. Presentation only: their `go()` actions call `openModule()`,
  which gates on the same lock. Filtering there means *don't advertise it*, not
  *don't allow it*.
- **The gate lives in `openModule()`** (`js/tabs.js`), not in each module —
  that is the one funnel every entry point already goes through, so no future
  screen can reach those panels without passing it.
- **Team's Financial column is shown to everyone**, not only admins, and reads
  as a state (`Allowed` / `Blocked`) rather than an action. A member who cannot
  see the section still benefits from knowing who can, and an action label on a
  row you are scanning for status is the classic way to revoke the wrong
  person's access.

### Deploying it — order matters, and it bit once

**Push the code first, then apply the migration.** Never the other way round.

On 2026-08-29 the migration went in ahead of the front end and Financial
Management broke for everyone, the owner included: the policies were enforcing
a lock that no deployed screen could open. Two symptoms, both alarming and
neither a data loss —

- The five modules rendered **empty**, with no password box to explain why.
- **Pending Memos jumped to ~60.** That list is derived (§5.13): verified ARF
  tracks plus saved projections, *minus* the ones that already have a memo and
  *minus* dismissed reminders. Both subtractions read locked tables, so both
  became zero and every reminder the firm had already dealt with came back.
  A derived list is only as scoped as the tables it subtracts with — worth
  remembering before locking any table that another module subtracts against.

`refresh()` now tells the two failures apart, which is what makes the safe
order work:

| Failure | Meaning | Behaviour |
|---|---|---|
| `PGRST202` (no such function) | The migration is not applied — so `private.fin_unlocked()` does not exist, no policy references it, and the eight tables are open to every member anyway | **Behave as if this file did not exist**: menu shown, palette entries listed, `openModule()` straight through. Hiding the section would protect nothing and take it from everyone. |
| Anything else (network, permission, timeout) | The lock exists and we could not read our standing | **Fail closed.** |

That is not a general fail-open. It is the single case where the database has
told us there is nothing to gate. Deploying the engine against a database
without the migration is therefore a complete no-op, which is what makes
push-then-migrate safe.

### Known limit

The unlock window is one timestamp **per member**, not per session, so
unlocking in one browser unlocks that person's other signed-in tabs and devices
for the rest of the four hours. Right for one person at one desk; revisit if a
granted member routinely works from two machines. Sign-out and the Lock button
both close it immediately.

Migration: `db/2026-08-29_financial_section_lock.sql` ·
rollback: `db/2026-08-29_financial_section_lock_rollback.sql`.
