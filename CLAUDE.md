# CLAUDE.md — Project Guide

Internal workflow-automation platform for **Shailesh & Associates** (Chartered Accountants) and **Dallakoti & Company** (Registered Auditors) — two affiliated audit firms in Chitwan, Nepal. Max 8 users, all staff. It automates document generation (audit reports, statutory minutes, registrar filings, invoices), VAT return preparation and tracking, client management, and document delivery.

---

## 0. How to use this file

This file is loaded into **every** session, so it holds only what protects work regardless of which file you open. Module detail, the full schema and the deep engine notes live in `docs/` and are read **on demand**.

**Two routing rules:**

1. **Before editing a feature module, read its doc** — the §5 index maps every module to a file in `docs/modules/`. Those docs are the same text that used to be in this file (moved verbatim 2026-07-27), so working without them means working with less than previous sessions had.
2. **Before schema work, read `docs/database.md`** and re-verify against live Supabase via the MCP rather than trusting any snapshot.

**Keep it current.** When a feature ships or a convention changes, update the relevant doc **in the same commit**. Hard rules, deliberate decisions, ID prefixes and fiscal-year formats belong in *this* file; everything else belongs in `docs/`. See §17 for the full map.

---

## 1. Quick Orientation

**Stack in one line:** static HTML/CSS/vanilla-JS single-page app (no framework, no build step, no bundler), talking directly to Supabase Postgres (publishable key) and Supabase Auth (email + password), hosted on GitHub Pages. **No third-party APIs at all** since Google auth was dropped 2026-08-01.

**Hard rules that must never be broken:**

1. **Never `git push` without explicit user approval** — every time, no standing permission. Committing locally is fine proactively.
2. **SQL migrations: show the SQL, then apply via the Supabase MCP.** *(User approved 2026-07-16, during the RLS lockdown work.)* Keep the annotated migration + a rollback script as files under `db/` in the same commit; the MCP is also fine for read-only schema verification. Never run destructive DDL without the SQL having been shown first.
3. **Never rewrite pushed history** (`--amend`, rebase, force-push) without explicit approval each time.
4. **Bump the cache-busting `?v=` version** on `index.html`'s local script/CSS tags when shipping changes — GitHub Pages serves stale files otherwise.
5. **Never break existing features** — regression-check before calling anything done.
6. **Don't "fix" the deliberate decisions in §15.**
7. **This repo is PUBLIC** — real client names, PANs and addresses never get committed. See `.gitignore`.

**30-second map:** `index.html` is the whole UI shell (all panels, all script tags). `js/config.js` holds constants/state/Supabase init. `js/core/` holds 14 reusable engines — check there before writing anything new. Each feature is one file in `js/`. All styling is `css/styles.css`. Word/Excel templates live in `assets/templates/`. Database is Supabase (21 tables, §6).

---

## 2. Tech Stack & Architecture

> Full detail — runtime architecture, the CDN table with per-library rationale, hosting, local dev: **`docs/architecture.md`**.

The app itself runs **entirely client-side**, and **Supabase is now its only backend** — `supabase-js` for Postgres (publishable key in `config.js`; RLS enabled on every table, §6) and Supabase Auth for sign-in. Google Drive/Gmail were removed 2026-08-01 along with Google OAuth (§7). State is `window.*` globals — no modules, no state library.

**One exception, added 2026-08-01: `ocr_service/`** — a FastAPI + PaddleOCR process backing the OCR Extract module (§5). It is **optional, local-only, and not deployed** (GitHub Pages can't run Python): each staff member starts it on their own machine with `ocr_service/start.ps1` when they want OCR. Nothing else depends on it — if it's stopped, only that one tab is affected. It does not make this a client/server app; treat it as an optional companion process, and don't move other features onto it without asking. Needs **Python 3.10–3.12** (PaddlePaddle publishes no wheel for 3.13/3.14). Detail: `docs/architecture.md` §2.6 and `ocr_service/README.md`.

### Script load order (load-bearing)

Later files depend on globals set up by earlier ones. Order in `index.html`:

```
CDN libraries → config.js → utils.js → js/core/* (14 engines) → tabs.js
→ feature modules (dashboard, registrar, clients, vatCompliance,
  billing, report, notesToAccounts, depreciation,
  bmAgmMinutes, auditorChange, salesPurchaseBook, bankBook,
  partyLedger, finalAccount, finStatement, ocrExtract, fileManagement,
  auditReportFinalization, auditChecklist) → auth.js (LAST — triggers the boot sequence)
```

- `finStatementEngine.js` before `finStatement.js` and `finStatementExport.js`; all three after `js/core/workbookReader.js` + `engineMath.js` (which `projectionEngine.js` also depends on).
- `finalAccount.js` **after** `partyLedger.js` — it reads that module's state and calls its `plBuildParties`/`plReceivablesFor`/`plExpenseTotalsFor`.

### CDN dependencies

No `package.json`, no npm at the app level — all libraries are `<script>` tags. Pinned: `@supabase/supabase-js` 2.110.7 · `xlsx` (SheetJS) 0.18.5 full build (import only, read-only) · `exceljs` 4.4.0 (generation) · `pizzip` 3.1.7 + `docxtemplater` 3.50.0 · `jszip` 3.10.1 · `docx-preview` 0.3.7 · `fuse.js` 7.0.0 · `pdf-lib` 1.17.1 · `tabulator-tables` 6.3.0 · `chart.js` 4.4.0 · `html-docx-js` 0.3.1. **Every script tag now carries SRI** — the two Google loaders were the only unpinnable ones and both went with Google auth.

**Every pinned dep carries SRI (`sha384`) + `crossorigin`.** When bumping a version, recompute the hash (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) or the file silently won't load.

### Hosting & local dev

- Remote `https://github.com/aadarshakhanal2064-cyber/AUTOMATION`, branch `main` only. GitHub Pages auto-deploys on push; `.nojekyll` is required.
- Dev server: `.claude/launch.json` defines `static-site`. Use the browser-preview tooling, never Bash.
- **Sign-in needs a real Supabase account** — for anything other than the login screen itself, bypass the auth wall via DOM manipulation (set `window.currentUser`, unhide `#app-section`/`#topbar`/`#sidebar`) and seed `window.clientsList` by hand; RLS returns nothing without a session.
- **Word / LibreOffice are not installed** — `.docx` verification is structural (XML-level) only; the user does the final visual check.

---

## 3. Folder & File Structure

```
AUTOMATION AI APP/
├── index.html               # Entire UI shell: all tab panels, modals, script tags
├── css/styles.css           # Entire design system (tokens + components)
├── assets/
│   ├── logo.jpeg, logo-lockup.png       # Firm logos (lockup = Shailesh & Associates only)
│   └── templates/                       # bm-agm-minutes.docx, auditor-change-*.docx,
│                                        # confirmation-letter.docx
├── js/
│   ├── config.js            # Constants, window.* state, Supabase init,
│   │                        # REP_FIRMS/REP_ENTITY_PROFILES/NTA_*/IMPORT_FIELDS
│   ├── utils.js             # escHtml, sbFetchAll, attachFirmPicker, fmtAmount
│   ├── tabs.js              # Tab switching via ModuleRegistry; topbar dropdowns
│   ├── auth.js              # Boot sequence, email/password sign-in/out, app_users authorization
│   ├── core/                # 14 reusable engines — §4
│   └── <feature>.js         # One file per feature module — §5
├── db/                      # Annotated migrations + rollbacks (db/backups/ is gitignored)
├── ocr_service/             # Optional local FastAPI + PaddleOCR service — §2
│                            # (venv/ is gitignored; not deployed with the app)
├── docs/                    # On-demand documentation — §17
│   ├── architecture.md, database.md, engines.md
│   ├── modules/             # One doc per module group
│   └── history/             # Superseded documents — NOT current state
├── CLAUDE.md                # This file — always loaded
└── README.md                # Public repo front page
```

---

## 4. The Engine Layer (`js/core/`) — reuse before you build

Feature code **never calls vendor libraries directly** (PizZip, Fuse, Tabulator, PDF-Lib, ExcelJS) — always through the owning engine. Check this table before writing anything new; the full API notes and design rationale are in **`docs/engines.md`**.

| Engine | File | Responsibility |
|---|---|---|
| ModuleRegistry | `moduleRegistry.js` | `register({id, group, buttonId, panelId})`. Groups `'main'` (tabs) and `'regd'` (Registrar sub-modules). **New modules self-register from their own file** — `dashboard.js` is the model. |
| StatusBox | `statusBox.js` | `showStatus(msg, type, targetId)`. Each module wraps it in a one-line `xxStatus()`. |
| NepaliLocale | `nepaliLocale.js` | B.S. dates, Devanagari digits, lakh/crore formatting, fiscal parts, day counts. **Calendar table covers 2080–2090 — extend before 2090.** |
| DocumentEngine | `documentEngine.js` | `downloadBlob` (fires an AuditLog event), `getTemplate` (fetch-once cache), `renderWord` (PizZip+docxtemplater), `previewWordAsHtml`. |
| SearchEngine | `searchEngine.js` | `attachAutocomplete(inputEl, listEl, config)` / `buildIndex` over Fuse.js. One shared autocomplete; supports digit-agnostic search. |
| TableEngine | `tableEngine.js` | `createTable(container, options)` over Tabulator. **Only the Clients directory uses it** — deliberate. |
| WorkflowEngine | `workflowEngine.js` | Form watchers, debounced live preview, localStorage autosave, completion indicator, zoom, `createStatusFlow` — one `transition()` choke point per status-tracked module so badge, persistence and audit entry can never disagree — and `createClientScope`, the same idea for client switching: `clear()` runs unconditionally before every `load()`, so no loader path can leak the previous client's data. **Any screen with a client picker goes through a scope.** |
| AuditLog | `auditLog.js` | `record(eventType, detail)`, `recent`, `countSince`, `query({sinceIso, untilIso})` → Supabase `audit_log`. Every call is try/catch-wrapped and **never throws**. **Detail keys are camelCase** (`clientName`, `recordRef`) — snake_case is silently dropped, which wrote null client names from six modules for a month. `query()` must always be given a window: the table only grows. |
| WorkbookReader | `workbookReader.js` | Locating figures inside the firm's hand-maintained NFRS workbooks. **Everything is label-driven, never positional — never hardcode a value column.** Node-loadable. |
| EngineMath | `engineMath.js` | `seededRng(key)`, `round1000Up/Down`, `deRound`. What makes the "unique per case" figures **reproducible per client**. Node-loadable. |
| ReportExport | `reportExport.js` | `toHtml`/`toPdf`/`toExcel`/`download` over one tabular model. Knows nothing about ledgers — callers hand it finished cells. **`pdfSafe()` inside it is load-bearing** (PDF-Lib standard fonts throw on non-WinAnsi characters). |
| DataCache | `dataCache.js` | `get(key, loader)` / `invalidate(...keys)` / `invalidateAll()`. 60s TTL in front of the shared full-table ledger loads. Caches the **promise**, so concurrent opens share one round-trip; a rejected load is never cached. **Keys live in `config.js` as `window.LEDGER_KEYS` and encode the ORDER BY, not just the table** — Bank Entry and Party Ledger sort `bank_accounts` differently and Final Account renders that array in order. Write paths call a module's `xxReload()` (invalidate + refresh); `xxRefresh()` must never invalidate. |
| DocumentStore | `documentStore.js` | `save`/`list`/`get`/`remove`/`openPicker` over `saved_documents` — save, browse and re-open for the HTML document builders (Audit Report, Notes to Accounts). Stores **both** the form state (re-editable) and the rendered HTML (reprintable exactly as issued). One shared picker drawer (`ds-` ids); **never caches**. The picker also lists records from **other** tables — pass `{fetchRows, describe, onChoose, onDelete}` instead of `{module, onOpen}` (Projection Report browses `projection_reports` this way) so there is one drawer, not one per module. |
| OcrEngine | `ocrEngine.js` | `checkHealth`, `extractText(file)` against the local OCR service (`ocr_service/`, §2). Translates a dead-port `fetch()` rejection into an actionable "service not running" message while preserving the API's own error text. Base URL is `window.OCR_SERVICE_URL`. |

**Adding a new tab/sub-module:** create `js/<module>.js`, call `ModuleRegistry.register()` from it, add the panel + nav button to `index.html`, add the `<script>` tag in load order, prefix all element IDs (§9). No edits to `tabs.js`.

---

## 5. Feature Modules — index

> **Read the module's doc before editing it.** Each doc holds the calibration findings, formulas, gotchas and deliberate trade-offs that this table cannot.

Navigation is a short sidebar plus three **topbar dropdowns** (shared open/close mechanic in `tabs.js` `toggleTopbarMenu`). Each module has exactly one home — never both a sidebar button and a menu entry. Everything in the last two menus is an ordinary `main`-group tab registered with `buttonId: null` and launched via **`openModule(tab)`**, with `MODULE_INITS` holding only the modules needing an init call on open.

| Module | Where | File(s) | Prefix | Table(s) | Doc |
|---|---|---|---|---|---|
| Dashboard | Sidebar *(default tab)* | `dashboard.js` | `dash-` | *(reads `audit_log`)* | [compliance-billing](docs/modules/compliance-billing.md) |
| *(shared)* Saved documents picker | — | `js/core/documentStore.js` | `ds-` | `saved_documents` | [engines](docs/engines.md) |
| Clients | Sidebar | `clients.js` | `ac-` `cd-` `nb-` | `clients`, `client_shareholders` | [clients](docs/modules/clients.md) |
| File In Out | Sidebar | `fileManagement.js` | `fm-` | `document_register` | [file-management](docs/modules/file-management.md) |
| Audit Report Finalization | Sidebar | `auditReportFinalization.js` | `arf-` | `audit_report_finalization` | [audit-report-finalization](docs/modules/audit-report-finalization.md) |
| Audit Checklist | Sidebar | `auditChecklist.js` | `achk-` | `audit_checklists` | [audit-checklist](docs/modules/audit-checklist.md) |
| Work Done *(+ cross-module Activity Log)* | Sidebar | `workDone.js` | `wd-` | `work_done` *(+ reads `document_register`, `audit_log`)* | [work-done](docs/modules/work-done.md) |
| Company Registrar *(5 sub-modules)* | Topbar → Registrar | `registrar.js`, `bmAgmMinutes.js`, `auditorChange.js`, `companyProfile.js` | `bm-` `ac-` `cp-` `cr-` `cs-` | `clients`, `client_shareholders` | [registrar](docs/modules/registrar.md) |
| Service Memo | Financial Management | `serviceMemo.js` | `sm-` | `service_memos` | [financial-management](docs/modules/financial-management.md) |
| Billing | Financial Management | `billing.js` | `billing-` | `invoices`, `invoice_items`, `invoice_payments`, `firm_bank_details` | [compliance-billing](docs/modules/compliance-billing.md) |
| Party Ledger | Financial Management | `partyLedger.js` | `pl-` | `party_opening_balances` | [financial-management](docs/modules/financial-management.md) |
| Bank Entry | Financial Management | `bankBook.js` | `bb-` | `bank_accounts`, `bank_transactions` | [financial-management](docs/modules/financial-management.md) |
| Final Account | Financial Management | `finalAccount.js` | `fa-` | *(none — pure view)* | [financial-management](docs/modules/financial-management.md) |
| Financial Statement | Automation Hub | `finStatement.js` + `finStatementEngine.js` + `finStatementExport.js` | `fs-` | `financial_statements` | [financial-statement](docs/modules/financial-statement.md) |
| Projection Report | Automation Hub | `projection.js` + `projectionEngine.js` + `projectionExport.js` | `pj-` | `projection_reports` | [projection](docs/modules/projection.md) |
| Depreciation | Automation Hub | `depreciation.js` + `depreciationSlm.js` | `dep-` `dep-slm-` | `depreciation_schedules` | [depreciation](docs/modules/depreciation.md) |
| Confirmation | Automation Hub | `confirmationLetters.js` | `cl-` | *(none)* | [documents](docs/modules/documents.md) |
| Generate Report | Automation Hub | `report.js` | `rep-` | `saved_documents` | [documents](docs/modules/documents.md) |
| Notes to Accounts | Automation Hub | `notesToAccounts.js` | `nta-` | `saved_documents` | [documents](docs/modules/documents.md) |
| Autobooks | Automation Hub | `salesPurchaseBook.js` | `spb-` | *(none)* | [autobooks](docs/modules/autobooks.md) |
| OCR Extract | Automation Hub | `ocrExtract.js` | `ocr-` | *(none)* | [documents](docs/modules/documents.md) |

### Three modules were renamed — display name only

File names, function prefixes, element-ID prefixes, table names and `ModuleRegistry` ids all keep their originals. This trips up every first encounter with any of the three:

| Menu / page label | Module in code |
|---|---|
| **Autobooks** | Sales & Purchase Book — `js/salesPurchaseBook.js`, `spb-` |
| **Bank Entry** | Bank Book — `js/bankBook.js`, `bb-`, tables `bank_accounts`/`bank_transactions` |
| **File In Out** | File Management — `js/fileManagement.js`, `fm-`, table `document_register` (renamed 2026-08-09) |

"Confirmation" is the menu label for Confirmation Letters; the panel keeps the fuller title.

**Two Company Registrar stubs remain** (Company Registration, Company Secretary Appointment — the latter added 2026-08-10) — UI built, logic is `moduleComingSoon()`. **Share Transfer, Increase Capital and PIN Reset were removed** 2026-08-10 by user decision — the firm doesn't do that work; recoverable from git history. **The VAT Return OCR module was removed** 2026-07-14 by user decision; see `docs/modules/registrar.md` for what went with it and how to recover it. **The VAT Compliance module was removed** 2026-08-10 by user decision, along with its `vat_filings` table; see `docs/modules/compliance-billing.md`.

---

## 6. Database (Supabase Postgres)

> **Full column-level reference: `docs/database.md`.** Project `rennqzmwyhkdsizvlqwd.supabase.co`. Re-verify live via the Supabase MCP before schema-dependent work.

**21 tables:** `app_users` · `clients` (314 rows) · `client_shareholders` · `send_logs` · `audit_log` · `firm_bank_details` · `invoices` · `invoice_items` · `invoice_payments` · `service_memos` · `depreciation_schedules` · `bank_accounts` · `bank_transactions` · `party_opening_balances` · `financial_statements` · `projection_reports` · `document_register` · `saved_documents` · `audit_report_finalization` · `audit_checklists` · `work_done`. (`vat_filings` dropped 2026-08-10 with the VAT Compliance module — `db/2026-08-10_drop_vat_filings.sql`.)

### Trigger-owned logic (never replicate in JS)

- `sync_invoice_payment_totals()` — recomputes `invoices.amount_paid`/`status` from `invoice_payments` on every insert/update/delete.
- `set_invoice_number` — AFTER INSERT, assigns `{SA|DC}-{id padded}`; **re-fetch the row after insert**, it isn't in INSERT's RETURNING.
- `set_service_memo_number` — AFTER INSERT on `service_memos`, assigns `{memo_prefix}-{id padded}`; same re-fetch gotcha.
- `set_document_register_number` — AFTER INSERT on `document_register`, assigns `FM-{id padded}`; same re-fetch gotcha.

### Data conventions

- Capital amounts are formatted **text**, deliberately (preserves `"25,00,000"`).
- Registration numbers/PANs may be **Devanagari numerals** — normalize with `NepaliLocale.toEnglishDigits` before comparing.
- Log tables **snapshot** client data rather than FK it (immutable trail).

### Query rules

PostgREST caps a single select at **1000 rows** — any query that can grow past that must use `sbFetchAll()` (`utils.js`) with a stable `.order()`. `clients` is at 314 and growing (`loadClients()` was a bare `.select()` until 2026-08-01 — it would have truncated silently, never errored).

**The shared ledger tables go through `DataCache` (§4)**, not a bare `sbFetchAll`: `bank_transactions`, `bank_accounts`, `service_memos` and `party_opening_balances` are read by Bank Entry, Party Ledger *and* Final Account, and `tabs.js` re-runs a module's init on every open. Any new write path to those four tables **must invalidate its key** or the save won't show until the TTL expires.

### Migration workflow

Show the SQL (annotated migration + rollback as files under `db/`) → apply via Supabase MCP (`apply_migration`) → verify → commit the SQL files with the change (§1 rule 2).

### RLS — ENABLED on all 21 tables (since 2026-07-16)

**Membership, not authentication, grants access.** Anyone who can authenticate holds an `authenticated` JWT, so every policy checks membership via `private.is_app_user()` / `private.is_admin()` (SECURITY DEFINER helpers in the non-exposed `private` schema). `anon` has no policies → zero access. The policy matrix mirrors the UI: members get CRUD where the UI offers it; `clients` INSERT/DELETE is admin-only; `send_logs`/`audit_log` are immutable; **`firm_bank_details` writes are admin-only** (payment-fraud target).

**When adding a new table: enable RLS + add membership policies in the same migration, or the app can't read it at all.**

---

## 7. Authentication

> Full lifecycle detail: **`docs/architecture.md`**.

**Supabase Auth, email + password** (since 2026-08-01). `signIn()` calls `signInWithPassword`; `onAuthStateChange` routes `INITIAL_SESSION`/`SIGNED_IN` into `afterSupabaseSignIn(session)`, which looks the email up in `app_users` — not found = Access Denied **and** the session is ended.

**Accounts are admin-created in the Supabase dashboard.** Signup is disabled there deliberately; there is no self-serve password reset (a handful of staff, and Supabase's built-in SMTP is rate-limited to a few mails an hour) — an admin resets it instead. Adding a user means **two** steps: an `auth.users` entry *and* an `app_users` row, or they authenticate and are then denied.

**The membership lookup uses `.ilike()`, not `.eq()`** — `private.jwt_email()` lowercases before matching, so a case-sensitive lookup here would reject a mixed-case address that RLS accepts, and the two layers would disagree.

**Authentication is identity — RLS is what gates data** (§6). `role` affects UI visibility only, and is deliberately *not* what protects anything.

**Google OAuth was removed 2026-08-01** — with it went `provider_token`, the GIS silent-renewal loop, `window.CLIENT_ID`, the Developer Setup modal, the `Integrations` engine, both Google script loaders and every Google origin in the CSP. **No database migration was needed**: RLS gates on `auth.jwt() ->> 'email'`, which is provider-independent. Don't reintroduce a Google dependency without re-reading §15.

---

## 8. Document Generation

Three distinct paths — pick the one matching the document family. Detail in **`docs/architecture.md`**.

| Path | Used by | How |
|---|---|---|
| **Word via templates** | BM/AGM, Auditor Change, Confirmation Letters | Tokenized `.docx` in `assets/templates/` through `DocumentEngine.renderWord` (`{{ }}` delimiters, `paragraphLoop`). **Loop markers must each occupy their own paragraph.** |
| **Word/PDF via HTML** | Report Builder, Notes to Accounts, Financial Statement | Styled HTML → `htmlDocx.asBlob()` for `.docx`, standalone print window for PDF. Print CSS controls pagination — verify page breaks after any layout change. |
| **PDF via PDF-Lib** | Billing invoices, Service Memo | Drawn programmatically. Standard fonts are WinAnsi and **throw** on Devanagari/curly quotes — fold to ASCII first. |
| **Excel via ExcelJS** | Depreciation, Autobooks, Bank Entry, Financial Statement, Projection | Bespoke layouts: merged headers, thin borders, accounting format `#,##0.00;(#,##0.00);"–"`, live formulas + cached results. Excel/ODS *import* uses SheetJS, read-only. |

**For plain tabular reports use `ReportExport` (§4)** rather than hand-rolling — Party Ledger and Final Account render all six views through it. The bespoke generators above were left alone deliberately: their merged multi-block geometry isn't a simple grid.

The BM/AGM template is a Preeti→Unicode (Mangal) conversion — **never revert to Preeti**, and treat any template modification as a re-validation project (`docs/history/HANDOFF.md` §4–5; tooling was never committed).

### Nepali locale — fiscal-year formats are deliberately inconsistent

All B.S. date / Devanagari digit / fiscal-year / lakh-crore formatting goes through `NepaliLocale`. **Normalize at boundaries; never unify these without asking:**

| Format | Used by |
|---|---|
| `2081-82` (dash) | Send Document, Report Builder, Notes, Billing, Service Memo, Bank Entry, Party Ledger, Depreciation, Financial Statement, Projection (UI) |
| `2083/84` (slash) | Audit Report Finalization, Audit Checklist, Work Done |
| `2083.084` (dot, 3-digit) | Drive year folders (Send Document folder walk) |
| `2081.2082` (dot, full 4-digit) | Autobooks sheet titles (`spbFyDot()`), Projection sheet columns |
| `2081/082` (slash, 3-digit) | Confirmation Letters (`clFyLabel()`) — matches the firm's own real letters |

Fiscal month index is **1–12 with 1 = Shrawan** (not the B.S. calendar month number).

---

## 9. UI Standards

### Design system
Single stylesheet `css/styles.css`, Inter font, CSS custom properties on `:root` (`--brand-navy`, `--accent-blue`, status colors `--green/--red/--yellow` with `-bg/-border/-dk` variants, `--radius*`, `--shadow-*`). Layout: fixed topbar (68px) + sidebar (264px). Reuse existing classes — `.card`, `.card-header`, `.form-group`, `.form-grid`, `.status-box` (+ `status-success/error/info/searching`), `.btn`/`.btn-primary`/`.btn-outline`, `.client-table`/`.table-wrap`/`.app-table`, `.autocomplete-list`/`.autocomplete-item`, `.log-badge` (+ `badge-*` variants), `.modal`/`.drawer-panel`, `.rep-view-btn` (Edit/Preview toggles). **Never introduce a new visual language.**

### Element ID prefixes (collision guard — no bundler, one global DOM)

| Prefix | Module | | Prefix | Module |
|---|---|---|---|---|
| `rep-` | Audit Report Builder | | `cr-`/`cs-` | Registrar stubs (Company Registration / Company Secretary Appointment) |
| `nta-` | Notes to Accounts | | | |
| `bm-` | BM/AGM Minutes | | `billing-` | Billing |
| `dep-` | Depreciation | | `spb-` | Sales & Purchase Book (Autobooks) |
| `ac-` | **BOTH** Auditor Change and Add Client (historical overlap — no live collision, but check both before adding any `ac-*` id) | | `dash-` | Dashboard |
| `cl-` | Confirmation Letters | | `sm-` | Service Memo |
| `bb-` | Bank Book (Bank Entry) | | `pj-` | Projection Report |
| `pl-` | Party Ledger | | `fa-` | Final Account |
| `fs-` | Financial Statement | | `cp-` | Company Profile |
| `nb-`/`cd-` | Clients dashboard (Nature of Business categories / general dashboard) | | `ocr-` | OCR Extract |
| `fm-` | File In Out (File Management / Document Register in code) | | `ds-` | Saved-documents picker (shared drawer, `js/core/documentStore.js`) |
| `arf-` | Audit Report Finalization | | `achk-` | Audit Checklist |
| `wd-` | Work Done | | | |

### Interaction patterns
Autocomplete = `SearchEngine.attachAutocomplete` (never hand-roll). Fixed-list pickers = `attachFirmPicker`. Status messages = module `xxStatus()` wrapper. Status badges = `createStatusFlow().badgeHtml()`. Edit/Preview split with on-demand render = the report.js pattern.

**Client switching = `WorkflowEngine.createClientScope`** (§4). Two rules that hold everywhere, scope or not: **always assign** — `el.value = c.x || ''`, never `if (c.x) el.value = c.x`, which leaves the *previous* client's value standing whenever the new one's field is blank — and **a per-client loader must clear before it can return early**, or "nothing saved for this client" leaves the last client's grid on screen under the new name. Both shipped as real bugs across eleven modules (fixed 2026-07-28); see `docs/engines.md`.

---

## 10. Coding Standards (permanent rules)

1. **Never duplicate code.** Extend or reuse existing logic rather than writing a parallel version.
2. **Always check `js/core/` and `js/utils.js` first** — the engines are the component library (§4).
3. **Keep files modular** — one concern per file; UI + API + business logic don't pile into one file.
4. **Never create unnecessary files** — new file only for a genuinely distinct concern.
5. **Flag files that grow too large** explicitly rather than letting them grow silently (`vatCompliance.js` and `billing.js`, ~700+ lines each, are the current largest).
6. **Prefer reusable helpers** over copy-paste, even for small snippets.
7. **Readable over clever. Comments explain *why*, never *what*** — and only when non-obvious. Calibration findings, root-cause notes, and deliberate trade-offs are exactly what belongs in comments.
8. **Reuse the design system** (§9) — no new visual styles.
9. **Never break existing features** — regression-check every change.
10. **Think at 60–80+ features scale** — avoid decisions that only work at today's size.
11. **Every feature must feel native** — consistent naming (`xx`-prefixed functions, `xx-` ids), structure, and UI language.
12. **Self-review before presenting anything as done.**
13. **`escHtml()` every dynamic string injected into HTML.** Never interpolate free-text values into inline `onclick` attributes — pass IDs and look records up from state (this exact bug shipped once).

---

## 11. Git Workflow (hard rules)

1. **Feature → Review → Commit → Push**, strictly in order. Never push unreviewed work.
2. **One logical change per commit** — split unrelated fixes/features/cleanups even within one conversation. Messages follow `type(scope): summary`.
3. **Never rewrite pushed history without explicit approval** each time.
4. **Never push without explicit approval, every time.** Committing locally proactively is fine.
5. Bump the `?v=` cache-bust version in `index.html` as part of any front-end change being shipped.

---

## 12. Testing & Verification Checklist

The established pattern — **investigate with real evidence → implement only what the evidence justifies → verify against real data → regression-check → self-review → commit**:

- Verify in the **real running app** (dev server + browser tools), not just by reading code. Bypass auth via DOM manipulation; mock Drive/Gmail where OAuth can't run.
- For document generation: render with real inputs; check output structurally (unzip `.docx`, re-read `.xlsx` via ExcelJS). **No Word/LibreOffice here** — ask the user for the final visual check and say so plainly.
- For nontrivial pipeline changes: **proof-of-concept against real documents before implementing** — this project has repeatedly proven assumptions wrong.
- Regression sweep after every change: activate every tab and registrar sub-panel, confirm rendering, check the console for errors.
- **Report failures honestly, including what was *not* tested.** Never claim verification that didn't happen.

---

## 13. Security Practices

- **RLS is the server-side enforcement layer** (§6) — enabled on all 21 tables, membership-checked. The publishable key alone grants nothing. **Don't disable it.**
- `escHtml()` on all dynamic HTML (rule 13); no free-text in inline event handlers.
- **CSP** (meta tag in `index.html`; `connect-src` is now just Supabase + the OCR loopback — every Google origin was removed 2026-08-01) + **SRI** on every pinned CDN dep + security headers (`vercel.json`). CSP keeps `'unsafe-inline'` for scripts, so it does **not** stop inline XSS — escHtml is what covers that. `connect-src` is the exfiltration guard: adding an integration to a new external host means adding it there or the call is blocked.
- Supabase session tokens live in `localStorage` — readable by any successful XSS (residual risk).
- No secrets in this repo beyond the publishable key. User passwords are Supabase's to store — the app never persists one.

---

## 14. Known Technical Debt

| Item | Severity | Notes |
|---|---|---|
| BM/AGM template-build tooling never committed | High | Exists only as prose in `docs/history/HANDOFF.md`. Any template rebuild starts by recreating it. |
| CSP keeps `'unsafe-inline'` for scripts | Medium | Full fix = refactoring hundreds of inline `onclick=` handlers off inline script; a separate project. escHtml audit is the mitigation. |
| No automated tests | Medium | All verification is manual/ad-hoc per §12. |
| No self-serve password reset | Low | Deliberate for a handful of users (§15) — an admin resets in the Supabase dashboard. Revisit if staff count grows or resets get frequent; needs custom SMTP, since Supabase's built-in sender is rate-limited. |
| 4 Company Registrar stubs | Feature gap | UI-only, `moduleComingSoon()`. |
| Financial Statement per-class depreciation is allocated, not per-asset | Low | A helper allocates figure `M` by opening balance and warns on disagreement; reading the per-class split from the SLM schedule's `pools` jsonb would be exact. |
| Section 51 "collected amount" in BM/AGM template is static sample text | Low | Known, deliberate cap during tokenization. |

---

## 15. Deliberate Decisions — Do NOT "Fix"

- **Auth is Supabase email + password, and the app has no Google dependency at all** (2026-08-01, user decision) — see §7. Accounts are admin-created with signup disabled; there is deliberately no self-serve password reset. Don't reintroduce Google OAuth, Drive, Gmail, the `Integrations` engine or any Google origin in the CSP without an explicit ask.
- **Billing does not email invoices** (2026-08-01) — it downloads the PDF for the staff member to attach. That was the last Gmail caller. Never re-add a send button as a "convenience"; it drags the whole OAuth stack back in.
- **Preeti → Mangal (Unicode) template conversion** — explicit user decision. Never revert to Preeti.
- **Billing QR is a static uploaded image** — never add a QR-generation library or a scannable-looking placeholder.
- **Invoice status is trigger-owned** — never set `paid`/`partially_paid` from JS.
- **Fiscal-year formats differ per module** (§8) — don't unify without asking.
- **Capital amounts are text** — preserves the firm's comma grouping.
- **VAT "Filed" status is always manual.**
- **VAT clients are a hand-picked subset** — never bulk-activate.
- **Clients table / import preview show a curated column subset**, not all fields.
- **The 45 Devanagari client records are kept alongside their English twins** (2026-07-26) — 37 share a PAN, but they are what BM/AGM Minutes and `client_shareholders` read. Never de-duplicate the directory on PAN alone.
- **The 8 clients absent from the client master were kept** (2026-07-26, user decision) — 5 carry live VAT filings, service memos or bank transactions.
- **`it_return_type` is free text, not CHECK-constrained**, and `D1/D2` is a real single value meaning "either" — not a placeholder to be split.
- **The Clients dashboard reports the whole portfolio, not the filtered table**, and always draws its "Not set" bucket.
- **The 7 statutory registration fields stay on `clients`** (2026-07-27) — only their editing surface moved to Company Registrar → Company Profile. Never re-add them to the general Add/Edit Client form, and never have `saveClient()` send those keys (even as null) from that form.
- **`tax_registration_type` (VAT/PAN) is not `vat_status`** — one is a client property, the other is whether the firm files that client's monthly VAT return. Don't merge them.
- **Entity Type on the client form is exactly 8 values** (`CLIENT_ENTITY_TYPES`) — the 7 `Partnership Firm` clients are a deliberate exception preserved via injection; don't add a 9th option.
- **Dashboard is the default landing tab** (2026-08-01, user decision) — it took that role when Send Document was removed. This supersedes the earlier "Dashboard is not the default" decision; `afterSupabaseSignIn()` calls `loadDashboard()` on boot because the nav button's `onclick` never fires on the landing tab.
- **Tabulator (`TableEngine`) is the default for any list-style table** — Clients, Service Memo, Bank Book, Billing, File Management and Audit Report Finalization all use it. (This line previously said only the Clients table used it; that was stale by 2026-08-09 and corrected here. VAT Compliance, an earlier Tabulator consumer, was removed 2026-08-10.)
- **Service Memo records work, not collection** (2026-07-26) — its payment columns were dropped deliberately. A payment is recorded once, in Bank Entry, and netted by the Party Ledger. Never re-add payment fields to the memo.
- **Financial Statement's cash is seeded, and Trade Receivables is the plug** (2026-07-26, user decision) — the spec asks for cash "unique on Each case", so it is seeded from client identity to stay reproducible, and receivables absorbs the balance. A negative plug raises a Director/Proprietor loan; it is never fixed by nudging cash.
- **Financial Statement's three proof rows are shown, not forced** — a non-zero figure is a finding about the inputs, not a rendering bug.
- **The Statement of Changes in Equity is NEVER titled "Provisional"**, even on a provisional set — the other three statements are.
- **Financial Statement's D3 slabs (`0/10/20/30`) are not Projection's `TAX_SLABS` (`0/10/20/27/29`)** — two different schedules for two different purposes. Don't unify them.
- **Final Account's `Net Difference` is shown, not forced** — a non-zero figure is a real finding, not a rendering bug to suppress.
- **Party List carries Opening + Tax Paid columns the department head's sheet didn't draw** (user-approved) so the Balance foots on screen. Don't trim it back to five columns.
- **Projection's master-workbook bugs are deliberately corrected** (year-3 Dep block, CF operating total, BS year-1 WDV reference, non-cumulative retained earnings) — don't "fix" them back.
- **Projection never restructures the client's loans to avoid owner capital** (2026-08-02, user decision) — when the current ratio or debt-equity forces Additional Capital, the review panel *states* how much of the short-term facility would have to be shown as a term loan to bring it to nil, and the user re-enters it in Step 2. How a facility is classified is a fact about the client, not a lever the report may pull. Don't make `suggestReclass()` self-applying.
- **Projection excludes non-operating income and out-of-note SOI expense rows** — matches the CA's real delivered sample.
- **Autobooks' "As Per VAT Return" figures are typed by the user, never derived** — filed figures genuinely differ from book, and are truncated to whole rupees.
- **Autobooks never auto-merges parties on PAN** — one PAN spanned two unrelated companies, and one name spanned two real entities.
- **Depreciation's grid is built once per scheme, not per tab open** (2026-08-01) — `depBuildGrid()` writes fresh EMPTY inputs, so the old unguarded `depInit()` wiped figures a user had typed and navigated away from. The guard is the `tbody.dataset.scheme` stamp it already sets. A scheme switch still rebuilds, which is the point.
- **`xxRefresh()` never invalidates the DataCache; `xxReload()` does** (§4) — they look interchangeable and are not. Refresh-invalidates would make the cache a no-op; reload-forgets makes saves invisible.
- **Depreciation carry-forward is manual-save only** — generating Excel never writes, so testing is safe.
- **The VAT Return OCR module was removed on purpose** (2026-07-14, user decision) — don't restore it, its four engines, or the `pdfjs-dist`/`tesseract.js` CDN libraries unless the user asks. (`exceljs` legitimately came back for Depreciation.) **The OCR Extract module added 2026-08-01 is not that module returning** — different engine (server-side PaddleOCR, not in-browser Tesseract), general-purpose text extraction, no VAT coupling. That removal decision still stands.
- **The VAT Compliance module was removed on purpose** (2026-08-10, user decision) — the firm stopped tracking clients' monthly VAT filing status in this app. Removal took `js/vatCompliance.js`, its sidebar tab, its two modals, its `.vatc-*` CSS, and the `vat_filings` table itself (`db/2026-08-10_drop_vat_filings.sql` — data is gone; the rollback restores structure only). **`clients.vat_status` stays** — it's still edited via Company Registrar → Company Profile and is a distinct client property (§15 `tax_registration_type` note), not owned by the module that read/wrote it. Historical `audit_log` rows with `module: 'vatCompliance'` remain valid; `js/config.js` keeps their display labels. Don't restore the module without an explicit ask — it's recoverable from git history.
- **Share Transfer, Increase Capital and PIN Reset stubs were removed** (2026-08-10, user decision) — the firm doesn't do that work; **Company Secretary Appointment** (`cs-` prefix) was added as a stub in their place, alongside the surviving Company Registration stub. Same `moduleComingSoon()` treatment as before — UI built, logic not yet wired up.
- **`enable_mkldnn=False` in `ocr_service/ocr_engine.py` is load-bearing** — with oneDNN on, paddlepaddle 3.3.1 aborts mid-inference (`ConvertPirAttribute2RuntimeAttribute not support`). It is not a stray performance flag; re-test before removing it on a paddlepaddle bump.
- **File In Out (File Management in code) is one row per visit** (2026-08-01) — an intake and everything given back out of it are the same physical custody, so there is no paired "returns" row; it all lives on the intake row (`doc_types` in, `outtakes` out).
- **File In Out's status is 3-way and DERIVED, never hand-set** (`fmDeriveStatus`, 2026-08-09 second pass) — pending/partial/returned is computed from `doc_types` vs `outtakes` on every change and then written through `fmFlow`, mirroring Audit Report Finalization's "never a stored status column drifting from the raw data" idiom. Don't set `status` directly from a button value.
- **File In Out replaced single-shot "Hand Over" with repeatable "Outtake" events** (2026-08-09) — the firm doesn't always give everything back at once. Each outtake records exactly which document types/quantities went out, defaulting to (and capped at) what's still remaining. `Undo Last Outtake` only ever pops the most recent event, never an arbitrary earlier one. Don't reintroduce a single all-or-nothing return action.
- **File In Out is deliberately not linked to Drive or the document pipeline** — it tracks the paper the firm is physically holding, which a digital copy doesn't substitute for.
- **File In Out's custom document-type slot is one manually-typed entry, not a repeater** (2026-08-09, explicit user ask) — a single "type another document" row alongside the fixed picklist, not an "add another" list.
- **File In Out's Fiscal Year field was added 2026-08-09, reversing the module's original "no FY field" decision** — the firm's own paper register carries one, so the earlier reasoning ("documents arrive against a job, not a year") no longer holds for this module. Don't re-remove it citing the old decision.
- **File In Out's document-type list excludes Cheque Book/Vouchers and Tax Documents** (2026-08-09, explicit user ask) — unused by the firm's real register. Bank Statement and Bank Loan/Interest Certificate are placed at an even list index on purpose so they land in the same row of the 2-column intake grid, side by side.
- **File In Out's Client Report is one implementation, reused from two entry points** (2026-08-09, third pass) — File In Out's own header button and the Clients tab's "Docs" indicator both open the exact same `fmOpenClientReport()` modal; the Clients tab has no separate rendering of a client's document history. Don't build a second one there.
- **File In Out's Client Report ignores the table's current filters on purpose** — it answers "what has this client ever brought in and taken out", a different question from the register-wide Print/Preview/Export, which deliberately respects whatever is currently filtered.
- **Audit Report Finalization is one record per `(client, fiscal year, RETURN TYPE)`** (2026-08-09, superseding the same-day "one record per client+year") — IT return, estimate return and tax clearance are separate work done by different staff at different times, so each gets its own row. Its status is a **derived** 4-key badge computed per track from raw columns (submission text + a nullable verified flag), never a stored status column, so the badge, the filter, the chart and the export text can't drift apart. `client_id` is NOT NULL / ON DELETE RESTRICT — directory clients only, no walk-in case like File Management's. `auditor` is deliberately **free text with no CHECK** (the UI offers "Other, type a name") and holds FIRM names — `Shailesh & Associates`, `Dallakoti & Company` — not partner names. Don't add a stored status column, relax the FK, or re-add a CHECK to `auditor` without asking.
- **Verifying an IT return auto-opens its follow-on records** (2026-08-09) — a D-2 opens the Estimate Return, a D-3 opens Estimate Return *and* Tax Clearance, because the firm verifies the estimate only after the IT return. They are created explicitly **not verified / not cleared** rather than blank: a blank row derives to "Not Submitted" and would drop out of the *Not Verified* counts, but the work really is outstanding. **The link is reversible** (corrected 2026-08-09 after shipping one-directional): un-verifying the IT return, or switching D-3 to D-2, withdraws the follow-ons so those tracks read "Not recorded" again — a row left behind after its trigger was undone reports work the firm doesn't owe. **But a follow-on anyone has worked on is never deleted**: `arfIsUntouchedFollowOn()` gates every removal and the save message reports what was kept. Creation is idempotent.
- **`audit_report_finalization.recorded_date` is deliberately NOT `created_at`** — `created_at` is the immutable insert timestamp; `recorded_date` is user-editable because staff routinely log on Monday work actually done on Friday, and the From/To range filter has to reflect the work, not the typing. Don't collapse the two.
- **Service Memo's Pending Audit Fees list fires on ANY verified ARF track, not full completion** (2026-08-10, user decision) — the moment a client's IT Return, Estimate Return *or* Tax Clearance is first verified in Audit Report Finalization, one pending item appears for that client+FY (showing which tracks are done), rather than waiting for the whole filing (IT+Estimate, or IT+Estimate+Tax for a D-3) to finish. Derived the same way as Work Done's Pending List — reads `audit_report_finalization` directly, nothing stored twice — and a group drops off once an **Audit / Statutory Audit** memo exists for that client+FY (matched via `NepaliLocale.fyStartYear()` across ARF's slash format and Service Memo's dash format). **`SM_FY_DEFAULT` (`'2082-83'`) replaced the old `NepaliLocale.todayBs()`-derived default** the same day, deliberately matching ARF's `ARF_FY_DEFAULT` — a memo written in Shrawan is routinely for the year just closed, not the one that just started. Selecting **Statutory Audit** caps the FY datalist at `SM_FY_AUDIT_CAP` (2082) and below and fills the field **only if blank**, never overwriting a typed or prefilled year. Don't change the trigger to "full completion only" or make the FY auto-fill unconditional without asking.
- **Work Done's Pending List is DERIVED from the File In Out register, never hand-ticked** (2026-08-09) — the firm's own sheet says three work types show in a pending list "if file is received and work is not done", and those three labels (Sales Register, Purchase Register, Stock Book) are exactly three of the nine `FM_DOC_TYPES`, so "file is received" is answered by `document_register` rather than a second checkbox. Nothing is entered twice and the list can't go stale. **Only those three are pending-eligible** — every other work type is explicitly excluded by the sheet; don't generalize it to all 16, and don't add a manual "file received" field.
- **`WD_WORK_TYPES[].fileLabels` is a LIST of document-type spellings, not one string** (2026-08-10, corrected against live data) — `document_register.doc_types[].type` stores the label *text*, not the key, and the firm's real register uses **`Purchase & Sales Files`** as one combined item covering both registers, with every pre-2026-08-09 row carrying that older vocabulary. One received document legitimately implies two jobs. Map new spellings here rather than rewriting historical rows; `wdOrphanWorkTypes()` flags a work type whose every spelling has fallen out of use.
- **Work Done joins fiscal years on `NepaliLocale.fyStartYear()`, never string equality, and an intake with NO fiscal year is matched on client across all years** (2026-08-10) — `document_register.fiscal_year` is an optional free-text box and is in fact null on every row the firm has entered. Excluding those is what made the Pending List come up empty against real data. A file demonstrably sitting in the office is not hidden because nobody typed a year; it shows as `FY —` with a note. Don't "tighten" this back to requiring a year.
- **Work Done records hold only the rows the client actually needs, never all 16** (2026-08-10, user decision) — file-backed work is added automatically from File In Out, everything else by hand from the `+ Add work…` picker, and every row is removable. Seeding all 16 buried each record in irrelevant not-started rows and meant "Complete" could never fire. This **supersedes** the earlier `wdMergeItems` decision: loading a record no longer tops it up to the full catalogue, because the row set is the user's own selection. Records saved by the first version still load all 16 unchanged.
- **Work Done reuses `ARF_STAFF` rather than defining its own `WD_STAFF`** (2026-08-09, user decision) — same humans as Audit Report Finalization, so adding a staff member stays one config edit for both modules.
- **Work Done's rows are 3-state (Not Started / In Progress / Done), not a done-tick** (2026-08-09, user decision) — "In Progress" is what stops two staff starting the same job, which is half the reason the module exists. A 4th `not_applicable` state was offered and declined, and is no longer needed: selecting rows rather than seeding all 16 is what made "Complete" fire properly.
- **Work Done's Activity Log is a READ-ONLY VIEW over `audit_log`, not a new record type** (2026-08-10) — every module already writes its events through `AuditLog.record()`, so "what has the firm done for this client, across all modules" needs no table, no writes, and no change to any other module: anything that logs an event appears there the day it ships. It lives in Work Done, not the Dashboard, because the Dashboard's 10-row feed is a whole-firm glance and this is the searchable per-client / per-work / per-staff history. Its window is **bounded (90 days by default)** on purpose — `audit_log` only grows — and an unmapped module or event label **falls back to the raw value rather than being hidden**, so a new module is never silently missing from the log. Don't give it its own table or make it write.
- **The Activity Log merges repeats of the same work on the same client within 3 hours, showing only the latest** (2026-08-10, user decision) — re-running a projection eight times while getting the figures right is one piece of work, and logging it eight times buried the days something was actually finished. Keyed on `(client, module, event_type)`; the window is measured **gap-to-gap, not from the newest event**, so a session with two-hour pauses stays one entry however long it runs. **Nothing is hidden silently**: the kept row shows `×N` with the run's span, the count line reports the merge, and the export carries a *Times* column. Live effect: 1,886 raw events in 90 days → 350 entries. Don't switch it to an anchor-based window or drop the ×N.
- **Depreciation and Generate Report appear in the Activity Log only when work is SAVED to the database** (2026-08-10, user decision) — `window.ACTIVITY_SAVED_ONLY` in `config.js`; both modules log an event per export, which filled the log with attempts rather than results. Deletes are kept (a delete is a database write; hiding it would leave the log asserting a record still exists). A module **absent** from that map is unrestricted, so new modules show everything by default. Note **Generate Report shows nothing today** — `saved_documents` is empty, so every one of its events is a generate/download; that is the requested behaviour and the empty state says so.
- **`AuditLog.record()` detail keys are camelCase** (`clientName`, `recordRef`) — snake_case keys are silently dropped, and six modules (`companyProfile`, `depreciation`, `depreciationSlm`, `notesToAccounts`, `report`, `projection`/`projectionExport`) had been writing **null client names** for a month because of it. Fixed 2026-08-10; historical rows keep their nulls. Check the key casing when adding a `record()` call — nothing errors when it's wrong.
- **Number-input spinner arrows are removed app-wide** (2026-08-10, user request) — every number field in this app is typed, never stepped, and the native stepper sits exactly where the caret goes on a right-aligned amount. It's one global rule in `css/styles.css`, not a per-module class; keyboard arrows still step. Don't re-add `appearance: auto` to "fix" a field.
- **File In Out's Outtake picker opens showing every entry still with the firm** (2026-08-10, user feedback that it was "too small and very hard to navigate") — the first version rendered nothing until a directory client was chosen from the autocomplete, which made the common case a blind search and left **walk-in intakes (`client_id` null) unreachable entirely**. Typing now filters the visible list by plain substring (not Fuse — the user is filtering text they can already see); the client autocomplete still jumps straight in on a single open entry. Don't revert it to a search-first empty box.
- **Projection's New Task / Updation mode decides insert-vs-update, and auto-switches to Updation when the picked client already has saved projections** (2026-08-10, user decision) — the record existing in the database *is* what makes a re-run an updation, so requiring the user to set it by hand would only produce duplicates. Re-solving in Updation mode **keeps** `pjSavedId` (it used to be nulled on every re-solve, which turned every edit into a new row); a **fresh upload always resets to New Task**, so a workbook for a different year can't silently overwrite an existing record. An updation deliberately does not resend `created_by`.
- **Projection's Audited/Provisional comparison column is read from the client's own statement and MUST foot** (2026-08-11) — Sources = Uses, the current-liability rows add to their total, and the P&L runs down to the reported PBT. **The SFP is the authority for the loan split, not Note 3.8**: the balance sheet's two `Loans and Borrowings` rows (one per liability heading) decide long-term vs short-term, the note supplies the detail, and any residual is booked with a warning exactly as the PPE pools are forced to the SFP fixed-asset total. **Long Term Loan is the bank portion alone** — a director loan sitting inside Non-Current Liabilities is already on the Lending row, and counting the non-current total there showed it twice. **Short-term interest is derived by difference** (`financeCost − LT`) so the two interest rows always add back to Note 3.14's Total. Statements carrying non-operating income or out-of-note SOI expenses still won't foot in the P&L — that is the §15 exclusion above, not a parsing gap. Don't re-derive any of this from note labels alone; they vary per client and per year.
- **Projection's IRD Gross Income is turnover, Paid up Capital is share capital alone, and Loan from Bank is every bank facility** (2026-08-11, user decision) — Gross Income was gross *profit*, Paid up Capital added the solver's Additional Capital (which is not issued capital), and the loan row omitted `longTermLoan` while counting `directorLending` (related-party, not a bank — now excluded from both columns). Each row's audited value, projected value **and** Excel cross-sheet formula must change together or the sheet drifts.
- **Projection reports every loan on its own balance-sheet line and never sums them** (2026-08-11, user decision) — Long Term Loan, Permanent Working Capital Loan, Hire Purchase (HP) Loan and Short Term Loan /OD/CC are four separate rows; **only their interest is combined**, on the P&L, where term/PWC/HP share one row and short-term/OD/CC keeps its own. HP used to be folded into `closingLT` and had no line; it is now split out with every total adding it back explicitly, so no figure moved. **PWC and HP are matched by KEYWORD from either section** — real statements put Permanent WC under Current (T3) *and* under Non-Current (Test 2) — and **plain "WC Loan" is not Permanent WC** (T3's note lists both as separate facilities). Vehicle/auto loans count as HP. **Moving PWC/HP into Sources requires taking them back out of Current Liabilities** (`loans.currentReclassified`), and the Short Term row must use `loans.overdraft`, never `loans.currentTotal` — otherwise the money is counted twice and only the CL rows-vs-total check catches it.
- **Projection's base fiscal year is a fixed `PJ_BASE_FY_DEFAULT = '2082-83'`, and Share Capital is edited in Review & Export** (2026-08-11, user decision) — the base year is no longer derived from the upload or today's date (an upload only fills it when blank, and Clear restores the default), matching the `ARF_FY_DEFAULT`/`SM_FY_DEFAULT` convention; both fields stay editable. Share Capital moved out of Step 2 and is now a **per-year override row** in the Step 3 Balancing Figures table with no standalone box (a rights issue lands in one year, not across the projection); blank falls back to the statement's parsed figure, and `pjApplyModelEdits`/`pjParsedShareCapital` are gone with the box, so nothing rewrites `pjModel.shareCapital` any more. **Sales is a per-year override row too** — an override **carries forward** (the next year grows off the corrected figure) and deliberately does **not** move the profit target, since `gpTarget` keys off the prior year's GP/PAT and debt service; purchases re-plug COGS around the new turnover.
- **Projection's comparison column is headed by its own section's date convention, not a fiscal-year label** (2026-08-11, user decision) — the balance sheet reads `2083.03.31` (overridable via `pj-base-asat` for a statement drawn to a non-standard day), the P&L and Schedule 1 read `2082.2083`; a single `F.Y. 2082-83` used to print beside sibling columns headed `2084.03.31`. The IRD sheet keeps `F.Y.` labels — that page is fiscal-year semantics.
- **Projection's `performed_by` staff name is UI-only and must never reach the report output** (2026-08-10, explicit user ask) — it identifies who did the work for the firm's own tracking; the bank-facing document has no business carrying it. `pjxBuildReport()` reads only the company/PAN/org-type/comparison/statement-type fields, and that boundary is what keeps this true.
- **Projection's Share Capital is an editable input, not a read-only parsed figure** (2026-08-10, user ask) — the workbook's capital line is regularly stale, and every downstream total keys off it. **Clearing the box returns to the figure the statement actually carried**, which is why the parsed value is retained separately rather than the box just being seeded. Note this is not the same field as the per-year **Additional Capital** override in the review panel, which was already editable and is solver-owned.
- **The OCR service is deliberately standalone** — no client picker, no `clients` row, no document pipeline. That's what keeps it optional: a stopped service breaks one tab, nothing else. Don't make another module depend on it without asking.
- **Saved documents are ONE table with a `module` discriminator** (2026-08-02) — not one table per builder. Every HTML document builder stores the same two things (form state + rendered HTML), so per-module tables would duplicate the schema, the RLS block and the entire save/list/restore UI. Adding a builder means adding one value to the CHECK, not a migration and a drawer.
- **A saved document stores BOTH its form state and its rendered HTML** — the preview is contenteditable, so the state alone loses every hand-edit, which is exactly the document the firm issued. Don't "simplify" either one away.
- **Additional notes belong to Notes to Accounts only** (2026-08-02, CA instruction) — the audit report's sections are prescribed by the NSAs and are not the auditor's to extend. Don't add an equivalent to `report.js`.
- **`.rep-blank-fill`'s placeholder styling belongs to `:empty` alone** — styling it grey-italic by default and black only on `:focus` is what made filled Emphasis-of-Matter and KAM text print washed out in every export (none of which has focus). It reached a client's printed report; don't restore the `:focus`-based version.
- **`OCR_LANG` defaults to `ne` (Nepali/Devanagari), not `en`** — verified 2026-08-01 to read plain English correctly too, so one model serves both. This isn't a preference: `en` has no Devanagari support and returns confident-looking garbage on a Nepali page instead of erroring, which is easy to miss. Don't "optimize" it back to `en` for speed.

---

## 16. AI Assistant Instructions

**Session startup:** read §0 and §1; check the §5 index for whatever module you're touching and **open its doc**; `git log --oneline -15` and `git status` to orient. For schema work, read `docs/database.md` and re-verify against live Supabase.

**Do:**
- Follow the evidence-first pattern (§12) — this project's history is full of assumptions that real data disproved.
- Ask before anything in the Needs-User-Confirmation register: pushing (§1 rule 1), migrations (§1 rule 2), history rewrites (§1 rule 3).
- Keep the docs updated in the same commit as the change they document (§0).
- State honestly what was and wasn't verified.

**Don't:**
- Push, migrate, or rewrite history without explicit approval (§1).
- Guess at Nepali-language/legal wording — propose and get user confirmation.
- Consolidate or refactor things the user deferred, without a fresh explicit ask.
- Treat `docs/history/` as current state — it is explicitly historical.

---

## 17. Document Map

| Path | Loaded | What it's for |
|---|---|---|
| `CLAUDE.md` | **Every session** | This file — hard rules, standards, indexes, deliberate decisions. |
| `docs/README.md` | On demand | Map of the docs tree and the rule for what goes where. |
| `docs/modules/*.md` | On demand | Per-module detail — **read before editing that module** (§5 index). |
| `docs/database.md` | On demand | All 21 tables column by column, triggers, the full RLS matrix. |
| `docs/architecture.md` | On demand | Runtime architecture, CDN rationale, auth lifecycle, doc-generation detail. |
| `docs/engines.md` | On demand | The 14 engines in full. |
| `ocr_service/README.md` | On demand | The local OCR service — setup, endpoints, the Python-version constraint (§2). |
| `docs/history/` | Rarely | **Superseded — not current state.** `HANDOFF.md` §4–5 is the only record of the BM/AGM template pipeline. See `docs/history/README.md`. |
| `README.md` | Never (public front page) | Short public description of the project. |
| Memory (`~/.claude/projects/.../memory/`) | Index every session | Cross-session behavioural conventions. Module facts live in `docs/`, not here. |
