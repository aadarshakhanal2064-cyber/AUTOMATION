# Financial Management

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for Service Memo, Bank Entry, Party Ledger and Final Account — the four modules that together answer what a client owes.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.13 Service Memo (`js/serviceMemo.js`, `sm-` prefix, table `service_memos`)

Internal **service record** — the firm's guarantee that no professional work is completed without a recorded fee to collect. Deliberately **not** an accounting/tax invoice (that is Billing, §5.3, which carries bank details, a payment QR and a reconciled payments subtable); a Service Memo is one lightweight row: who did what work for which client, and the Fee. Financial Management tab, seeded from the firm's `Work Performed.xlsx` (a field-spec/dropdown sheet, not data). Architecturally a *lighter Billing* — same client autocomplete, TableEngine list, PDF-Lib generation, AuditLog, self-registration.
- **A memo records the work, NOT the collection** (2026-07-26, department-head spec). Its own `payment_status`/`amount_received`/`payment_date` were **dropped** — money received is entered once as a Bank Entry **Fee Receipt** and netted per client by the **Party Ledger** (§5.16). Don't reintroduce payment fields here: two places to record one payment is exactly what this removed. Verified before dropping — 5 memo rows existed, none with a payment.
- **Five selectable firms** (`SERVICE_MEMO_FIRMS` in config.js): Shailesh & Associates, Dallakoti & Company, Ratnanagar Offset Screen Print, Ratnanagar Tax Consultancy, and **Other — specify** (`typed: true`, name entered per memo into `firm_other`; `smFirmName()` is the one resolver, used by the list, the PDF letterhead and the Party Ledger). SA/DC reference `REP_FIRMS` for full PDF letterhead; the sister concerns carry their own name + memo prefix, address/PAN blank until filled in config (PDF prints "—"). This is the ONE source for both the firm dropdown and the PDF letterhead — a new firm needs **no migration**.
- **Memo number** assigned by an AFTER INSERT trigger (`set_service_memo_number`, mirrors `set_invoice_number`): the app sends `memo_prefix` from config (`SM-SA`/`SM-DC`/`SM-ROSP`/`SM-RTC`/`SM-OT`) and the trigger builds `prefix || '-' || lpad(id,5,'0')` → `SM-SA-00001`. Re-fetch after insert (memo_number isn't in the INSERT RETURNING — same gotcha as invoices).
- **Nature of Task** is a category → sub-category tree (`SERVICE_MEMO_TASKS`, seeded from the Excel with typos fixed and "OCR" relabeled "Company Registrar (OCR)"); every category ends in "Others" → a free-text `nature_other` box appears. Easily extended in config.
- **VAT stays per-memo**: the `apply_vat` checkbox drives `vat_amount`/`total_amount`. The Party Ledger prints **that stored figure**, not a blanket 13% (which is what the department head's sheet hardcoded) — so a non-VAT memo never shows the client a VAT charge it was never billed.
- **In-panel list only** — Recent Memos + the filter/table block, behind a `.rep-view-toggle` (**Memos** / **Audit Fees**, 2026-08-10, renamed from "Pending Audit Fees" 2026-08-15 once the list stopped being audit-only). The stat grid went with the payment columns (its one card, "Total Collected", had no source left).
- **PDF** via PDF-Lib (pattern of `billingBuildInvoicePdf`), re-skinned as a formal **SERVICE MEMO** stamped **"Internal service record — not a tax invoice."**
- Fiscal year: **dash** (`2081-82`), free text so one memo can still span several years (`2080-81/2081-82`) as the firm's sheet does — `sm-fiscal-year` also carries a `<datalist>` of suggested years (`smFyOptions()`) so it's pick-or-type, not a closed dropdown. **Default fixed at `SM_FY_DEFAULT = smFyLabel(window.FY_DEFAULT_START)`** (2026-08-10, replacing the earlier `NepaliLocale.todayBs()`-derived default; reads the shared `window.FY_DEFAULT_START` since 2026-08-15) — matches Audit Report Finalization's own `ARF_FY_DEFAULT` and every other module's fiscal-year default, so a year rollover is a single-line change in `js/config.js` instead of drifting to whatever today's actual B.S. date computes to. Selecting **Audit → Statutory Audit** caps the datalist at `SM_FY_AUDIT_CAP = 2082` and below (an audit is always for a completed year) and fills the field with the default **only if it's still blank** — never overwrites a year already typed or prefilled. Filters: firm, category, FY, date range + fuzzy search. `client_id` is a **nullable** FK (typed-only clients still save; name/PAN/address always snapshotted). Migrations: `db/2026-07-21_service_memos.sql`, then `db/2026-07-26_financial_suite.sql`.
- **Audit Fees — two sources, never stored twice** (2026-08-10, extended to Projection Report 2026-08-15). The moment ANY of a client's three ARF tracks (IT Return / Estimate Return / Tax Clearance, §5.21) is verified for a fiscal year, that year's statutory audit fee is due to be memoed — regardless of which track got there first. `smLoadArfVerified()` reads `audit_report_finalization` directly (the same idiom Work Done uses for its own Pending List over `document_register`, CLAUDE.md §15) rather than caching a second copy of the fact. **A second source, saved Projection Reports, was added 2026-08-10 — updating an existing report writes to the SAME `projection_reports` row (Projection's own New Task / Updation split, §5.20), so deriving the fee-due list straight from that table is what keeps a re-run or an update from ever appearing twice; nothing about "was this saved before" is stored here.** `smFeeDueRows()` (renamed from `smPendingAuditRows()`) unions both sources with a `kind: 'audit' | 'projection'` tag: audit groups verified ARF rows by `(client_id, fiscal_year)` and drops once an **Audit / Statutory Audit** memo exists for that client+FY; projection groups saved reports by `(client_id or lower-cased company name, fiscal_year_base)` and drops once a **Bank Loan Related / Provisional/Projected** memo exists for that client+FY (the category picked was the closest existing `SERVICE_MEMO_TASKS` fit — user decision 2026-08-15, not a new picklist entry). Both sides match years via `NepaliLocale.fyStartYear()` since ARF's fiscal year is slash format (`2082/83`) and Service Memo's/Projection's is dash (`2082-83`). Clicking **Add Fee** opens the ordinary New Service Memo drawer via `smOpenCreate(null, prefill)` prefilled with client, Nature of Task, fiscal year **and now a description** (`Statutory Audit of the Financial Statements for F.Y. …` / `Preparation of Projected Financial Statements for N years, based on F.Y. …`) — the user only has to type the Professional Fee. Neither source is cached through `DataCache` (§4) — small tables, re-fetched fresh on every Service Memo refresh.

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
