# CLAUDE.md — Project Guide

Internal workflow-automation platform for **Shailesh & Associates** (Chartered Accountants) and **Dallakoti & Company** (Registered Auditors) — two affiliated audit firms in Chitwan, Nepal. Max 8 users, all staff. It automates document generation (audit reports, statutory minutes, registrar filings, invoices), VAT return preparation and tracking, client management, and Drive/Gmail document delivery.

> **Keep this file current.** When a feature ships, a table changes, or a convention is added, update the relevant section here in the same commit. This document is the single authority; `README.md` and the `HANDOFF*.md` files are historical (see §18).

---

## 1. Quick Orientation

**Stack in one line:** static HTML/CSS/vanilla-JS single-page app (no framework, no build step, no bundler), talking directly to Supabase Postgres (publishable key, no Supabase Auth) and Google Drive/Gmail APIs (user's own OAuth token), hosted on GitHub Pages.

**Hard rules that must never be broken:**

1. **Never `git push` without explicit user approval** — every time, no standing permission. Committing locally is fine proactively.
2. **SQL migrations: show the SQL, then apply via the Supabase MCP.** *(User approved 2026-07-16, during the RLS lockdown work.)* Keep the annotated migration + a rollback script as files under `db/` in the same commit; the MCP is also fine for read-only schema verification. Never run destructive DDL without the SQL having been shown first.
3. **Never rewrite pushed history** (`--amend`, rebase, force-push) without explicit approval each time.
4. **Bump the cache-busting `?v=` version** on `index.html`'s local script/CSS tags when shipping changes — GitHub Pages serves stale files otherwise.
5. **Never break existing features** — regression-check before calling anything done.
6. **Don't "fix" the deliberate decisions in §16.**

**30-second map:** `index.html` is the whole UI shell (all panels, all script tags). `js/config.js` holds constants/state/Supabase init. `js/core/` holds 12 reusable engines — check there before writing anything new. Each feature is one file in `js/`. All styling is `css/styles.css`. Word/Excel templates live in `assets/templates/`. Database is Supabase (17 tables, §6).

---

## 2. Tech Stack & Architecture

### 2.1 Runtime architecture

Everything runs client-side in the browser; there is **no server-side code**. The browser talks to:

- **Supabase Postgres** via `supabase-js` with the publishable key in `config.js`. No Supabase Auth; RLS is currently disabled on every table (§6.6, §15).
- **Google Drive (readonly) + Gmail (send)** via the signed-in staff member's own OAuth access token (Google Identity Services). Emails are sent as the actual staff member, not a service account.

State is `window.*` globals (`window.clientsList`, `window.currentUser`, …) — no modules, no state library. Functions attach implicitly to `window`.

### 2.2 Script load order (load-bearing)

Later files depend on globals set up by earlier ones. Order in `index.html`:

```
CDN libraries → config.js → utils.js → js/core/* (12 engines) → tabs.js
→ feature modules (dashboard, registrar, clients, logs, vatCompliance,
  billing, sendDocument, report, notesToAccounts, depreciation,
  bmAgmMinutes, auditorChange, salesPurchaseBook, bankBook,
  partyLedger, finalAccount, finStatement) → auth.js (LAST — triggers the boot sequence)
```

`finStatementEngine.js` must load **before** `finStatement.js` and
`finStatementExport.js`, and all three after `js/core/workbookReader.js` +
`engineMath.js` (which `projectionEngine.js` also now depends on).

`finalAccount.js` must load **after** `partyLedger.js` — it reads that module's
state and calls its `plBuildParties`/`plReceivablesFor`/`plExpenseTotalsFor`.

### 2.3 CDN dependencies

All third-party libraries are `<script>` tags in `index.html` — no `package.json`, no npm at the app level.

| Library | Version | Used for / notes |
|---|---|---|
| Google API + GSI clients | (Google-hosted) | OAuth token client, Drive/Gmail |
| `@supabase/supabase-js` | `2.110.7` (pinned + SRI, UMD build) | Postgres REST client + Supabase Auth |
| `xlsx` (SheetJS) | 0.18.5 full build | Excel/CSV/**ODS** *import* (full build needed for ODS). Read-only — its free build can't write styles/merges/formats. |
| `exceljs` | 4.4.0 | Excel *generation* with faithful merges/borders/number-formats/formulas (Depreciation). SheetJS can't do this on write. |
| `pizzip` + `docxtemplater` | 3.1.7 / 3.50.0 | Word template filling (`{{token}}`) |
| `jszip` | 3.10.1 | ZIP handling |
| `docx-preview` | 0.3.7 | Live in-browser preview of generated Word docs |
| `fuse.js` | 7.0.0 | Fuzzy search (SearchEngine) |
| `pdf-lib` | 1.17.1 | PDF construction (Billing invoices) |
| `tabulator-tables` | 6.3.0 | Clients directory table (TableEngine) |
| `chart.js` | 4.4.0 | Dashboard doughnut chart |
| `html-docx-js` | 0.3.1 | HTML → OOXML .docx export (Report, Notes to Accounts) |

All pinned CDN deps carry Subresource Integrity (`sha384`) + `crossorigin` hashes (added 2026-07-16). The two Google loaders (`apis.google.com/js/api.js`, `accounts.google.com/gsi/client`) are dynamic and can't be SRI-pinned — constrained by the CSP `script-src` allow-list instead. When bumping any pinned version, recompute its hash (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) and update the tag, or the file won't load.

### 2.4 Hosting & deployment

- **Remote:** `https://github.com/aadarshakhanal2064-cyber/AUTOMATION` — branch `main` only.
- **Live site:** `https://aadarshakhanal2064-cyber.github.io/AUTOMATION/` — GitHub Pages auto-deploys on every push to `main` ("pages build and deployment" workflow). `.nojekyll` is present and required.
- **Cache-busting:** every local `<script>`/`<link>` carries `?v=YYYYMMDDHHMM`. Bump it when shipping front-end changes.

### 2.5 Local development

- Dev server: `.claude/launch.json` defines `static-site` (`npx serve -l 5173 .`). Use the browser-preview tooling, never Bash, to run it.
- **Real Google OAuth cannot run in the sandbox.** Established testing pattern: bypass the auth wall via direct DOM manipulation and, where needed, mock Drive/Gmail calls.
- **Microsoft Word / LibreOffice are not installed** in the dev environment. Generated `.docx` verification is structural (XML-level) only; the user does the final visual check in Word.

---

## 3. Folder & File Structure

```
AUTOMATION AI APP/
├── index.html               # Entire UI shell: all tab panels, modals, script tags (~1800 lines)
├── css/styles.css           # Entire design system (tokens + components)
├── assets/
│   ├── logo.jpeg, logo-lockup.png       # Firm logos (lockup = Shailesh & Associates only)
│   └── templates/
│       ├── bm-agm-minutes.docx          # BM/AGM Word template (Unicode/Mangal, tokenized)
│       ├── auditor-change-resolution.docx
│       └── auditor-change-registrar-letter.docx
├── js/
│   ├── config.js            # Constants, window.* state, Supabase init, REP_FIRMS/REP_ENTITY_PROFILES/NTA_*/IMPORT_FIELDS
│   ├── utils.js             # escHtml, sbFetchAll, attachFirmPicker, blobToBase64, stringSimilarity
│   ├── tabs.js              # Tab switching driven by ModuleRegistry; Company Registrar topbar dropdown
│   ├── auth.js              # Boot sequence, Google sign-in/out, app_users authorization
│   ├── core/                # 12 reusable engines — see §4
│   └── <feature>.js         # One file per feature module — see §5
├── CLAUDE.md                # This file
├── README.md                # OUTDATED — superseded by this file (§18)
└── HANDOFF*.md              # Historical session handoffs — deep forensic detail (§18)
```

---

## 4. The Engine Layer (`js/core/`) — reuse before you build

Feature code **never calls vendor libraries directly** (Tesseract, PizZip, Fuse, Tabulator, pdf.js, PDF-Lib) — always through the owning engine. Check this table before writing anything new:

| Engine | File | Responsibility / key API |
|---|---|---|
| ModuleRegistry | `moduleRegistry.js` | `register({id, group, buttonId, panelId})` / `getGroup()`. Groups: `'main'` (tabs) and `'regd'` (Company Registrar sub-modules). Pre-registry modules are registered centrally in this file (transitional); **new modules self-register from their own file** — `dashboard.js` is the model. |
| StatusBox | `statusBox.js` | `showStatus(msg, type, targetId)`. Each module wraps it in a one-line `xxStatus()` pointing at its own status element (`vatStatus`, `bmStatus`, …). |
| NepaliLocale | `nepaliLocale.js` | `toEnglishDigits`, `toDevanagari`, `formatAmount` (lakh/crore), `parseBsDate`, `fiscalParts`, `todayBs`, `NEPALI_MONTHS`. B.S. calendar table covers **2080–2090 — extend before 2090**. |
| DocumentEngine | `documentEngine.js` | `downloadBlob(blob, filename, meta?)` (meta fires an AuditLog event), `getTemplate(url)` (fetch-once cache), `renderWord(buffer, data)` (PizZip+docxtemplater), `previewWordAsHtml(...)` (docx-preview). |
| SearchEngine | `searchEngine.js` | `attachAutocomplete(inputEl, listEl, config)` / `buildIndex` wrapping Fuse.js. One shared autocomplete (keyboard nav included); supports `normalizeQuery/normalizeItem` for digit-agnostic search. |
| TableEngine | `tableEngine.js` | `createTable(container, options)` wrapping Tabulator with the app's `.app-table` look. Only the Clients directory uses it (deliberate — don't migrate other tables without cause). |
| WorkflowEngine | `workflowEngine.js` | `attachFormWatcher`, `createDebouncedRefresh` (staleness-guarded live preview), `createAutosave` (localStorage draft), `updateCompletionIndicator`, `createZoomControl`, `createStatusFlow` (one `transition()` choke point per status-tracked module — badge, persistence, and audit entry can never disagree). |
| AuditLog | `auditLog.js` | `record(eventType, detail)`, `recent`, `countSince` → Supabase `audit_log`. Every call is try/catch-wrapped and never throws — a logging failure must not break the feature. |
| Integrations | `integrations.js` | `driveGet`, `findFolderByName`, `listAllFilesInFolder`, `downloadDriveFile`, `sendEmailWithAttachment`. All Drive calls append `supportsAllDrives=true&includeItemsFromAllDrives=true` (Shared Drive visibility). |
| WorkbookReader | `workbookReader.js` | `num`, `norm`, `grid(ws, XLSX)`, `findSheet(wb, keys)`, `findRowIdx(g, re, from, labelCol)`, `findHeader(g, from)`, `labelValue(...)`, `noteSection(g, titleRe, endRe?)`. Locating figures inside the firm's hand-maintained NFRS workbooks — extracted from `projectionEngine.js` on 2026-07-26 when Financial Statement needed the same locators. **Everything is label-driven, never positional**: `findHeader` finds the literal `particulars` cell and takes the first non-empty non-`notes` column right of it as `valCol`, the second as `prevCol`, which is why SFP→F, Sch-PL→D and Sch-BS→H all work from one function — **never hardcode a value column**. `noteSection` fences a numbered note at the CLOSER of its own Total row and the next numbered note, because not every note has a Total (Sch-BS 3.2 ends at "Current portion", and a Total-only fence read 3.3 and 3.4 as its own). Node-loadable. |
| EngineMath | `engineMath.js` | `seededRng(key)`, `round1000Up/Down`, `deRound`. Pure numerics shared by the two financial engines, kept separate from WorkbookReader because parsing and arithmetic are different concerns. `seededRng` is what makes the "unique on each case" figures the firm's sheets ask for (projection's cash and creditors, Financial Statement's cash) **reproducible per client** rather than different on every run. Node-loadable. |
| ReportExport | `reportExport.js` | `toHtml` / `toPdf` / `toExcel` / `download(model, kind, filename, meta)` over one tabular model (`{title, subtitleLines, columns, rows, landscape, note}`; row styles `section`/`subtle`/`total`/`grand`). Added 2026-07-26 for Party Ledger's 4 views + Final Account's 2 statements — six consumers that would otherwise each have copied the drawing code already sitting twice in `bankBook.js`. It knows nothing about ledgers or firms: callers hand it finished cells. **`pdfSafe()` inside it is load-bearing** — PDF-Lib's standard fonts are WinAnsi and *throw* on any character they can't encode (a true minus `−`, a curly quote, Devanagari), so every string is folded to ASCII/Latin-1 on the way into the PDF. |

**Adding a new tab/sub-module:** create `js/<module>.js`, call `ModuleRegistry.register()` from it, add the panel + nav button to `index.html`, add the `<script>` tag in load order, prefix all element IDs (§10.2). No edits to `tabs.js`.

---

## 5. Feature Modules

Navigation is split between a short sidebar and three **topbar dropdowns** (Xero-style menus, shared open/close mechanic in `tabs.js` `toggleTopbarMenu` — opening one closes the others). Reorganized 2026-07-25 at the user's request; each module has exactly one home, never both a sidebar button and a menu entry.

| Where | Entries |
|---|---|
| **Sidebar** (`main` group, `nav-*` buttons) | Dashboard, VAT Compliance, Send Document, Clients, Send Logs |
| **Company Registrar** (topbar) | Its own `regd` sub-module group — Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset, BM/AGM Minutes |
| **Financial Management** (topbar, key `fin`) | Service Memo, Billing, Party Ledger, Bank Entry, Final Account |
| **Automation Hub** (topbar, key `auto`) | Financial Statement, Projection Report, Depreciation, Confirmation, Generate Report, Notes to Accounts, Autobooks |

Everything in the last two menus is an ordinary `main`-group tab registered with `buttonId: null` and launched via **`openModule(tab)`** in `tabs.js` — one launcher for both menus, with `MODULE_INITS` holding only the modules that need an init/refresh call on open (a tab absent from the map simply switches).

**Two modules were renamed in that pass — display name only.** File names, function prefixes, element-ID prefixes, table names and the `ModuleRegistry` ids all keep their originals, so `spb-`/`salesPurchaseBook` and `bb-`/`bankBook` still mean what they always did in code:

| Menu / page label | Module in code |
|---|---|
| **Autobooks** | Sales & Purchase Book — `js/salesPurchaseBook.js`, `spb-` (§5.9) |
| **Bank Entry** | Bank Book — `js/bankBook.js`, `bb-`, tables `bank_accounts`/`bank_transactions` (§5.14) |

"Confirmation" is the menu label for Confirmation Letters (§5.12); the panel keeps the fuller title.

### 5.1 Dashboard (`js/dashboard.js`)
Stat cards (client count, documents this month, OCR jobs this month — the OCR card only reflects historical `audit_log` rows now that the VAT Return module is removed), recent-activity feed, Chart.js doughnut of documents by module — all fed by `AuditLog.recent()/countSince()`. Not the default landing tab (deliberate — Send Document stays default). First self-registering module; the pattern model.

### 5.2 VAT Compliance (`js/vatCompliance.js`, table `vat_filings`)
Portfolio-wide tracker of monthly VAT filing status per client. `VAT_MONTH_ORDER` (fiscal-order month names, index 1 = Shrawan) lives at the top of this file.
- **VAT clients are a hand-picked subset** of the directory (`clients.vat_status = 'active'`), managed via the "Manage VAT Clients" picker. Never bulk-activate the directory — most of the ~309 clients do not file VAT with the firm.
- **Rows are lazy**: no `vat_filings` row = "Not Started". Upsert on the `(client_id, fiscal_year, month)` unique constraint; never pre-create months.
- Statuses: `not_started → waiting_docs → ocr_processing → under_review → ready_to_file → filed / filed_adjustments`, plus `on_hold`, `not_required`. Every change goes through `vatcFlow.transition()` (WorkflowEngine.createStatusFlow) which persists + writes the audit entry with `record_ref` = filing id. Auto-progress (`vatcAutoProgress`) only moves **forward** and never touches filed/on_hold/not_required. **Filed is always manual.**
- Deadline = 25th of the following B.S. month; **overdue is derived at render time, never stored**.
- Fiscal year format here is **slash**: `2083/84` (`vatcFyLabel`).

### 5.3 Billing (`js/billing.js`, tables `invoices`/`invoice_items`/`invoice_payments`/`firm_bank_details`)
Tracks money clients owe **the firm** for services. Invoice PDF built with PDF-Lib (firm bank details + payment QR), optionally emailed via Integrations/Gmail, reconciled against recorded payments.
- **Status is DB-trigger-derived** (§6.2): app code only sets `draft→sent` and `→void` via `billingFlow`; never write `paid`/`partially_paid` from JS.
- Invoice numbers `SA-00001`/`DC-00001` assigned by an AFTER INSERT trigger — re-fetch the row, never trust INSERT's RETURNING.
- Bank QR is a **static uploaded image** (`firm_bank_details.qr_image`, starts NULL); the PDF draws a dashed placeholder until uploaded. Never seed a fake QR that looks scannable.
- `firm_bank_details` upserts must always re-send `invoice_prefix` (NOT-NULL is validated before ON CONFLICT resolution — omitting it 400s).
- Fiscal year format here is **dash**: `2082-83`.

### 5.4 Send Document (`js/sendDocument.js`)
Finds a client's document in Drive and emails it. Drive folder walk: `My Drive → "Audit Data" → <fiscal year folder, e.g. 2081.082> → "Scan" → <doc-type folder or "Tax clearance">`, matching hardcoded name-variant lists. File matching is tiered fuzzy (exact substring → all-words-present → Levenshtein via `stringSimilarity`), with a low-confidence `_warning` surfaced to the user. Sends raw multipart MIME via Gmail as the signed-in user; every send is logged to `send_logs`.

### 5.5 Audit Report Builder (`js/report.js`, `rep-` namespace)
Full Independent Auditor's Report generator. Client search auto-fills from `clientsList`; `entity_type` free text maps to a report profile via `CLIENT_ENTITY_TO_REP_PROFILE`.
- **Five report types:** Unqualified, Qualified, Disclaimer of Opinion, Adverse, and "Section 57 – Change of Control" (internally `review` — renders the title "Report on the Financial Statement").
- Entity profiles (`REP_ENTITY_PROFILES`): private/public company, proprietorship, partnership, NGO, NPO, cooperative — each with salutation, governing body, act. **Only Private Company cites its act by name** (`citeSpecificAct`); others say "the applicable law".
- Edit/Preview toggle, on-demand render; optional EOM/KAM/Basis sections with inline writing boxes under their checkboxes; cover page; letterhead uses `assets/logo-lockup.png` (Shailesh firm only — no equivalent asset for Dallakoti).
- Exports: **Save as Word** (true OOXML via `htmlDocx.asBlob`) and **Save as PDF** (standalone print window). Print CSS is carefully tuned (orphans/widows, page-break control) — regression-check pagination when touching it.

### 5.6 Notes to Accounts (`js/notesToAccounts.js`, `nta-` namespace)
Significant Accounting Policies & Notes generator. Mirrors report.js 1:1 (same Edit/Preview shape, same two exports). Driven parts: client details, accounting standard (`NTA_ACCOUNTING_STANDARDS`: NAS for MEs / NFRS for SMEs / NAS — `full` wording on first mention, `short` after), depreciation method (SLM/WDV), editable PPE useful-life table (`NTA_PPE_DEFAULTS`), optional Related Party section. The rest is fixed boilerplate policy text.

### 5.7 Clients Directory (`js/clients.js`)
CRUD + search over `clients` (Tabulator via TableEngine), plus the Excel/CSV/ODS import wizard: header auto-mapping by keyword (`IMPORT_FIELDS` in config.js), duplicate/invalid preview, **backfill-on-duplicate** (re-importing fills blank fields on existing clients, never overwrites non-blank), and nameless-rows-after-a-company-row attach as extra shareholders (`client_shareholders`).

**The Add/Edit Client form is deliberately trimmed (2026-07-27)** — it holds the fields every client needs (name, email, PAN, phone, entity type, tax registration, nature of business, address, district, country, IT return type). The seven Nepalese company-registration fields — registration number, chairman name, shareholder name, authorized/issued/paid-up capital, plus VAT status — **still live as columns on `clients`**, still feed BM/AGM Minutes and Auditor Change exactly as before, but are edited only from **Company Registrar → Company Profile** (§5.11d). `saveClient()`'s payload omits those keys entirely rather than sending them null, so saving from the general form can never blank out data entered in Company Profile.
- **Entity Type is exactly eight values** (`CLIENT_ENTITY_TYPES` in config.js: Private Limited Company, Public Limited Company, Proprietorship Firm, NPO, NGO, Cooperative Organization, Individual, Others). A client already holding an off-list value — the 7 `Partnership Firm` records, or a legacy import spelling — gets that value injected as an extra `<option>` by `acFillEntityTypes(currentValue)` when opened for edit, so viewing a record can never silently rewrite its entity type; only an explicit re-selection changes it. The **filter dropdown** is unaffected — it's built from the real distinct values in the data (`cdGroup`), not from this fixed list, so `Partnership Firm` still appears there.
- **Type of Tax Registration** (`tax_registration_type`: `VAT`/`PAN`) is a client *property* — whether it is registered for VAT or holds a PAN only — and is **not** `vat_status`, which is whether the firm itself files that client's monthly VAT returns (a hand-picked subset, §5.2). A client can be VAT-registered without the firm filing for it; conflating the two would have merged two different questions into one field.

**Client portfolio dashboard** (2026-07-26, redesigned 2026-07-27): three KPI cards — Total Clients, **D-1/D-2 filers**, **D-3 filers** — over four **clickable** breakdown panels (Entity Type, District, Nature of Business, Record Completeness). Everything is derived from `window.clientsList` at render time; nothing is stored, so the dashboard can never disagree with the table under it. Deliberately reports the **whole portfolio, not the filtered view** — these are the firm's headline numbers and having them move while you type in the search box would make them useless. The **VAT Active** card was removed by user decision (2026-07-27) — VAT filing status is VAT Compliance's own concern, not a client-directory headline.
- Plain CSS bars (`.cd-bar-*`), not Chart.js: these are ranked category counts, which a div width states as well as a canvas, and it avoids building/tearing down a chart instance on every reload. The doughnut on the Dashboard tab stays Chart.js.
- **`CD_BLANK` ("Not set") is held out of the ranking and always drawn as its own last bar**, greyed. The 45 Devanagari records and the 8 kept clients carry no district or IT return type; letting them fall into the "Other (n)" rollup buried the very number the panel is most useful for. Every chart therefore sums to exactly the client count. Blanks are also excluded from the "N types/districts" caption and from the filter dropdowns.
- **Every bar and meter is clickable** (2026-07-27), via one delegated `click` listener keyed off `data-cd-kind`/`data-cd-name` attributes — never an inline `onclick` built from the bar's own label, since a district or category name is free text that could carry a quote (CLAUDE.md §11 rule 13). Entity Type / District bars set that filter dropdown and jump to the table. Nature of Business bars open a **drill-down modal** (`nbOpenCategoryDrilldown`) showing the category's real sub-types before committing to a table filter — "Trading" alone doesn't say grocery vs. hardware vs. petroleum. Record Completeness meters open a modal listing every client missing that field (`cdOpenIncompleteModal`), reusing the same modal shell (`#cd-modal`).
- **Search + the three dropdowns (entity / district / IT return) + the Nature-of-Business category filter are one predicate** (`applyClientFilters`), so they compose instead of each overwriting the other's result. The search box and dropdowns call `clientFiltersChanged()` (a thin wrapper that also collapses "Show All" back to the summary view), not `applyClientFilters` directly. `filterClientTable()` survives as a thin alias for the same reason. The `__none` option on the IT-return filter finds unclassified clients.
- **Nature of Business categories** (`NATURE_CATEGORY_RULES` in config.js, 2026-07-27) — ~70 distinct `business_nature` spellings collapse into 15 parent sectors (Trading, Agriculture & Livestock, Poultry, Manufacturing, Health, Hotel & Restaurant, Transport & Freight, Education & Consultancy, Construction & Engineering, Investment & Finance, Real Estate, Mining, Import & Distribution, Other Services), derived from the actual 261-client dataset — every value matches a rule, nothing falls into a junk "Other". **Rule order is load-bearing**: specific sectors are tested before the broad Trading/Manufacturing verbs, so "Manufacturing of Feed of birds" lands in Poultry and "Trading of Medicines" lands in Health, not their literal verb. A second list, `NATURE_CANON_RULES`, merges spelling variants for **display only** inside the drill-down (e.g. "Trading Hardware items" / "Trading of Hardware Items" → one line) — `business_nature` itself is never rewritten. A **filter pill strip** below the search bar (`renderNatureCategoryStrip`) is a second entry point onto the identical category filter the dashboard bar drives — clicking a pill toggles `window.nbActiveCategory` directly (no drill-down step, since the strip is already showing every category at a glance).
- **The directory doesn't render all 314+ rows by default** (2026-07-27) — `renderClientsTable` caps an unfiltered/wide result to the first 25 (`CLIENTS_PAGE_SIZE`) with a **"Show All N Clients"** button (`clientsShowAllToggle`); a filtered/searched result already under that size shows in full. `window.clientShowAll` resets to `false` on every deliberate filter change (search, dropdown, category pill, dashboard bar click) so expanding to the full list is never "sticky" across an unrelated filter.

**Client master reload (2026-07-26)** — `db/2026-07-26_client_master_reload.sql`, from the firm's `Client_Data_For_App_1_Cleaned.xlsx`. The directory had drifted to 451 rows: 261 hand-entered originals (ids 1–262), 45 Nepali-language records (263–307), 8 later additions (314–324), and a **partial re-import of that same workbook (325–461) that duplicated 137 originals by PAN**.
- The migration **updates the originals in place, matched on PAN, and deletes only the 137 duplicates**. That direction is load-bearing: the originals carry 41 rows of real work across nine referencing tables, three of those FKs are `ON DELETE RESTRICT` and three `ON DELETE CASCADE`, so deleting them would either be blocked or silently destroy saved workings. Result 451 → **314** clients with zero work rows lost and zero FKs re-pointed.
- **The Devanagari records (263–307) are never merged away**, even though 37 share a PAN with an English row — they are the Nepali twin that BM/AGM Minutes and its 55 `client_shareholders` rows read. Compare PANs with `NepaliLocale.toEnglishDigits` (or SQL `translate`) before concluding anything about duplication here.
- **`it_return_type` came only from a cell fill.** Columns "Tax Type for only D3" and "Type of IT return" are blank on all 261 rows; the workbook's yellow highlighting is the sole carrier and it is not row-consistent (197 rows are partially filled). Per the user: any yellow cell ⇒ `D1/D2` (deliberately one value — "it can be both"), no fill at all ⇒ `D-03`. That is 233/28. Free text, not a CHECK, so the firm can narrow to `D-01`/`D-02` per client without a migration.
- **The client rows themselves are gitignored** — this repo is public, and the workbook is real names/PANs/addresses. `db/2026-07-26_client_master_reload.sql` carries the annotation, DDL, guards and update/delete logic; its step 2 (the 261-row INSERT) lives in `db/backups/2026-07-26_client_master_rows.sql`, and the full pre-reload snapshot of all 451 rows in `db/backups/2026-07-26_clients_pre_reload.sql`. `db/backups/` is ignored wholesale. Re-running the migration means running the DDL, then the row file, then the rest — the header explains it. If those local files are lost, the old rows are **not** recoverable from the repo.
- **The workbook's `Proprietorship Firm` / `Partnership Firm` spellings were added to `CLIENT_ENTITY_TO_REP_PROFILE`** in the same change. Without them 155 of the 261 reloaded clients would silently stop auto-filling the entity profile in Audit Report, Notes to Accounts and Projection Report. The legacy `Firms`/`Pvt. Ltd. Company` keys stay — older records still carry them.

**Client master correction pass (2026-07-27b)** — a corrected version of the same workbook arrived same-day with a new **"VAT/PAN"** column and 56 spelling corrections to `business_nature`. Same 261 PANs (zero added, zero removed), applied via `client_master_v2` staging exactly like the first reload, scoped to `id <= 262` only (never touching the Devanagari twins or the 8 kept clients). Result: 118 clients VAT-registered, 143 PAN-only; IT return split moved to 234 D1/D2 / 27 D-03 (one client's classification changed between the two workbook versions). `entity_type` was also normalized to the new 8-value vocabulary (`NPOs`→`NPO`, `Cooperatives`→`Cooperative Organization`) for the 261 originals — `Partnership Firm` (7 clients) was deliberately left as-is, since it has no equivalent in the new list.

### 5.8 Depreciation (`js/depreciation.js` + `js/depreciationSlm.js`, `dep-` prefix)
Two **methods** in one panel, chosen by a top-level toggle (`depSetMethod`, reusing `.rep-view-toggle`): **As per Income Tax** (this file) and **As per Accounting Standard (SLM)** (`depreciationSlm.js`, `dep-slm-` sub-namespace). The Client / PAN / Fiscal-Year selectors, Save/Delete buttons, `dep-status` and the carry-forward banner are **shared**; the header Import/Generate buttons and `depReloadForContext`/`depSave`/`depDelete`/`depImportExcel`/`depGenerateExcel` branch on `depMethod` and delegate to the `depSlm*` engine when SLM is active.

**Income Tax method** — pool-depreciation schedule (Nepal). Editable grid of 7 statutory pools; user enters opening value, three timing-bucketed additions, and disposals; the module live-computes Total Value, Depreciation Base, Depreciation, and closing WDV. Empty pools render as "–" (accounting format). Formulas: `Total = Opening + ΣAdditions − Disposal`; `Base = Opening + Add₁ − Disposal + Add₂·⅔ + Add₃·⅓`; `Depreciation = Base×rate` (WDV) or `Base÷years` (SLM); `WDV = Total − Depreciation`.
- **Two schemes, one engine** (`DEP_SCHEMES`, toggled by a segmented control): **normal** = standard Income Tax rates (A Building 5%, B Furniture 25%, C Vehicles 20%, D Plant 15% — reducing balance); **special** = Special Industries, where A–D depreciate at the accelerated rate (normal × 4/3 = the 1/3 additional depreciation the Act grants → A 6.667%, B 33.333%, C 26.667%, D 20%). The special rates derive from the normal ones via `DEP_SPECIAL_FACTOR` (not four magic constants). Reducing-balance rates are not user-editable.
- **Software & Leasehold years are user-editable** (SLM, any positive number of years — no longer fixed at 5); Land is never depreciated.
- **Client search** wired via `SearchEngine.attachAutocomplete` over `clientsList` (name/PAN) — selecting a client fills company + PAN and drives carry-forward. Fiscal Year is a generated dropdown (a few back years through current + 6, dash format, from `NepaliLocale.todayBs`).
- **Year-over-year carry-forward** (`depreciation_schedules` table, §6): **manual save only** — a Save button upserts on `(client_id, scheme, fiscal_year)`; **generating Excel never saves** (so testing is safe), and there's a Delete button. On client/FY/scheme change: load this year's saved sheet if present, else prefill each pool's **Opening from last year's stored closing WDV** (with a banner), else blank. Saving requires a *selected* client (stable `client_id` key); a manually-typed company name still generates Excel but can't be saved.
- **Import from Excel/ODS** (matches pools by particular text, any row order), **Addition-details helper** (itemize purchases by B.S. date → auto-bucketed into the three columns: Shrawan–Poush full, Magh–Chaitra ⅔, Baishakh–Ashadh ⅓), and **Generate Excel** via ExcelJS reproducing the template (merged headers, borders, formulas, accounting number format; scheme + editable years flow into the rate cell/formulas). The source sheet's Land Total-Value formula pointed at the Leasehold row (a real bug); the generator writes it correctly.

**Accounting-Standard (SLM) method** (`depreciationSlm.js`) — the firm's book depreciation ("Dep as Books") plus the NAS 16 **3.1 PPE note**, generated as one two-sheet `.xlsx`. **Per-asset line items** (not pooled): one row per asset, grouped by the standard PPE classes (`DEP_SLM_CLASSES` in config.js: Land, Building & Structures, Machine & Other Assets, Vehicles, Office Equipment, Furniture & Fixtures, Software, Leasehold; useful-life defaults mirror `NTA_PPE_DEFAULTS`). User enters class, particular, **Date of Use** (B.S.), **Useful Life**, **Original Cost**, and — for assets already in service — **Opening WDV** / **Opening Depreciation**.
- **The one correct formula** (reverse-engineered from the firm's `Book1.xlsx`, whose own rows had three disagreeing formula variants — only this one satisfies its `Check` column): `Depreciation = Balance × DaysInYear ÷ RemainingLifeDays`, where `Balance = OpeningWDV + Addition − (DelCost − DelDep)`. It reduces to true straight-line (`Cost ÷ Life`) for whole years, prorates partial (acquisition/disposal) years by actual B.S. days, and writes to exactly 0 at end of life. `Addition` is AUTO = Original Cost in the acquisition year (Date-of-Use's F.Y. == selected), else 0; **Land** never depreciates. `Total Dep = OpeningDep + Depreciation + Impairment − DelDep`; `Closing WDV = Balance − Depreciation − Impairment`; the **Check** column verifies `(OrigCost − DelCost) − TotalDep == Closing WDV` every row.
- **Day counts** use new `NepaliLocale` helpers (`daysInServiceThisFy`, `bsOrdinal`, `daysBetweenBs`, `fyStartBs`/`fyEndBs`) over the existing `BS_MONTH_LENGTHS` table (2080–2090). Whole years use the **365 basis** (firm's template convention); only partial periods use actual calendar days.
- **Live 3.1 PPE note preview** — a class-rollup (classes as columns: Cost open→additions→disposals→close; Depreciation open→charge→impairment→disposals→close; Carrying open/close) rebuilt on every edit. Always ties out: each class's closing carrying == Σ of its assets' closing WDV, and the grand-total closing carrying == the schedule's grand-total Closing WDV.
- **Persistence & carry-forward** reuse `depreciation_schedules` with **`scheme='slm'`** (the per-asset array lives in `pools` jsonb, with `_closingWDV/_totalDep/_remainDays/_days/_costHeldClosing` snapshots for next year). Carry-forward: Opening WDV ← prior Closing WDV, Opening Dep ← prior Total Dep, Remaining Life ← prior remaining − days used, cost constant; fully-disposed assets drop off. **Manual save only** (generating Excel never writes). Same load→carry→blank flow and banner as the Income-Tax method.
- **Import** seeds the grid from an uploaded "Dep as Books" sheet (header-mapped by keyword, rows matched to classes by particular text). **Generate Excel** writes both sheets via ExcelJS with faithful merges/borders/accounting format, **live formulas + cached results** (so the file reads correctly before recalc), class subtotals, a Grand Total, and the internal Check column.

### 5.9 Autobooks (`js/salesPurchaseBook.js`, `spb-` prefix)

> Displayed as **Autobooks** since 2026-07-25 (Automation Hub menu). Everything in code — the file, the `spb-` prefix, the `salesPurchaseBook` module id, every function name — still says Sales & Purchase Book.
Automated reporting workbook from the two raw books a client maintains (Sales / Purchase: Date, Bill No., Party Name, Pan No., Tax Free, Taxable Amount, Vat — B.S. dates `2081.04.01`). Upload one workbook or two files (sheet names matched by Sales/Bikri · Purchase/Kharid, derived-sheet names skipped so a generated workbook can be re-uploaded); output is a 7-sheet .xlsx via ExcelJS with live formulas: Sales, Sales Summary (party-grouped alphabetical with subtotal rows), Sales Details (one `<Party> Total` row per party, taxable desc, cross-sheet formulas + a Grand Total that ties to the book), the Purchase trio, and Monthly (fiscal-month totals + VAT-return reconciliation).
- **The raw sheets embed 12 month-subtotal rows that duplicate the transactions** (a naive sum doubles). Stripped on import (dateless rows matching `/total/i`), regenerated in the output as live SUMs.
- **"As Per VAT Return" is typed by the user, never derived** — the reference file proved filed figures differ from book by real amounts (up to 3.7M). Filed figures are whole rupees by **truncation** (not rounding), so the reconciliation tolerance is <1 rupee; anything ≥1 flags as a gap (`SPB_ROUNDING_TOLERANCE`). VAT joins the verdict even though only Taxable/Taxfree get printed Diff columns (the firm's layout). Typed figures autosave to localStorage keyed `(company, FY)`.
- **Party merging is two-level**: trivially-safe normalization (case/whitespace/trailing period/`PVT.LTD` punctuation, `spbSafeKey`) auto-merges; everything looser (shared PAN, similar spelling) goes into a per-name-checkbox review list the user applies per file. PAN suggests but never decides — one PAN in the reference file spans two unrelated companies. Subtotal rows carry a PAN only when the group's rows agree on exactly one.
- **An identical name is NOT proof of one entity either** (a live client file had two real, unrelated companies both named "Muktinath Food Products"): `spbPansBySafeKey`/`spbGroupKey` split a safeKey into one group per distinct PAN whenever it carries more than one, disambiguated in the display as `"<Name> (PAN <pan>)"`, and surfaced in the review list defaulting UNCHECKED — checked-by-default is reserved for identical-fuzzy-text members with NO PAN conflict between them (`clusterHasConflict` in `spbBuildSuggestions`, checked against the whole cluster, not just the anchor). Only a well-formed **9-digit** PAN (`spbIsValidPan`) counts as split/conflict evidence — a typo'd PAN (e.g. one digit dropped) is reported as a data-quality note (`stats.malformedPan`) but never used to split or to flag a conflict, and never dilutes a subtotal's otherwise-unanimous PAN.
- Deliberate fixes vs the firm's hand-built file (output won't tie cell-for-cell): uniform `Return − Book` diff sign in both Monthly sections, Monthly total row sums every column, Details serial header is `S.No.`, plus a Remarks column and Grand Total rows. FY dot format (`2081.2082`) in sheet titles — a fourth FY format, per the §9.5 rule.
- Rows with unreadable dates are **excluded and loudly reported** (they can't be month-grouped); dates outside the chosen FY, VAT≠13% rows, missing PANs and credit notes are surfaced as import warnings.
- **Date parsing falls back to B.S. month names** ("Baishakh", "15 Baishakh 2082") when the strict numeric date fails — some clients' books are kept that way instead of pure date-wise, and some have no per-row date at all: the whole "Date" column is headed "Month"/"Months" (`SPB_DATE_HEADER_RE`, also मिति/महिना) and every cell just names the month, sometimes misspelled ("Sharawan", "Chiatra"). Recognized via an exhaustive alias table (Latin + Devanagari; Devanagari digits normalized) plus a fuzzy-similarity fallback (`spbFuzzyMonthMatch`, `stringSimilarity`) for unanticipated typos — never for unrelated text (min length 4, ≥0.75 similarity). A bare month name only resolves if a fiscal year is selected (year inferred from the month's half of the FY); a missing day defaults to the 1st, always reported in the import summary, never a silent guess. The filename is also cross-checked against the selected FY (`spbGuessFyFromText`) and flagged if they disagree, since a wrong FY selection silently mistags every such row's calendar year (month grouping stays correct either way).
- **Checksum layer**: the stripped embedded subtotals are kept as the client's own independent record and compared per month against the computed totals (`spbComputeChecksums`, tolerance 0.015) — a mismatch means the client's file is internally inconsistent, pointed at the exact month. A pre-generate tie-out (`spbTieOut`) refuses to write a workbook whose transactions/groups/monthly layers disagree. Both reference files pass 24/24 with zero false alarms.
- **Data Doctor** (`spbBuildIssues`/`spbDoctorAction`): detects bad dates, checksum mismatches, outside-FY rows, VAT≠13%, possible duplicate entries (same party+bill+amount), malformed PANs (suggests the party's valid PAN), fillable blank PANs, and sales bill-number continuity gaps (IRD audit point). Each gets an inline fix or an explicit "keep as-is"; fixes are stored as row-level overrides in `spbOverrides` and **re-parsed from source** (`spbReparse`) — never mutated in place — logged to `spbCorrectionLog`, written into the workbook as a "Corrections" sheet, and recorded via AuditLog. Readiness banner: red = rows excluded, amber = warnings, green = ready.
- **Column mapping UI** (`spbRenderMapping`): sheets whose headers aren't auto-recognized are kept (header `null`) and the user assigns Date/Party/Taxable etc. by hand — any column layout becomes importable. "Adjust columns" in the import summary re-opens it for override.
- **Workbook styling**: every total row is highlighted — yellow (`SPB_FILL_YELLOW`) for month/party subtotals and Monthly totals, amber for Details Grand Totals, light red across Monthly mismatch months; credit-note negatives in red font; auto-filters on all header rows.

### 5.10 Send Logs (`js/logs.js`)
Audit trail of sent documents from `send_logs`. Staff see only their own sends; admins see all with a staff filter. Client name/email are snapshots, intentionally not FK'd.

### 5.11 Company Registrar (topbar dropdown → `regd` group)

**a) BM/AGM Minutes (`js/bmAgmMinutes.js`, `bm-` prefix)** — generates Board Meeting + AGM minutes (plus Section 51 report and two registrar letters, all in one document) as a Word file in Nepali. Fills `assets/templates/bm-agm-minutes.docx` via DocumentEngine/docxtemplater (`{{token}}` delimiters, `paragraphLoop` for the shareholder list — loop markers must each be their own paragraph). Client search by registration number/PAN (digit-agnostic); shareholders = `clients.shareholder_name` + `client_shareholders` rows; chairman unnumbered, shareholders numbered from १. Live docx preview, autosave draft, completion indicator, zoom, print (one page per sub-document via `transform:scale`, not zoom). The template's history (Preeti→Unicode conversion, formatting-group rebuild pipeline) is in `HANDOFF.md` §4–5 — **the build tooling was never committed**; rebuilding the template requires recreating it from that description and re-validating.

**b) Auditor Change (`js/auditorChange.js`, `ac-` prefix — shares the prefix with Add Client, §10.2)** — two documents from one shared form: Board Resolution + registrar notification letter (`auditor-change-*.docx` templates). Same DocumentEngine architecture as BM/AGM, same UI pattern as the Report Builder (Edit/Preview, per-document preview tabs); B.S. date validation on blur; known-firm quick-fill picker (`attachFirmPicker` over `REGD_AUDIT_FIRMS`). No autosave/inline-edit yet (deliberate trim).

**c) Stubs** — Share Transfer, Increase Capital, Company Registration, PIN Reset: UI built, logic is `moduleComingSoon()` in `js/registrar.js`. Real remaining product surface. (Party Ledger used to share this stub; it became a real module on 2026-07-26 — §5.16.)

**d) Company Profile (`js/companyProfile.js`, `cp-` prefix)** — added 2026-07-27 as the new home for the seven statutory fields removed from the general Add/Edit Client form (§5.7): registration number, chairman name, shareholder name, authorized/issued/paid-up capital, and VAT status. **Same `clients` columns, same data** — only the editing surface moved, because this data is Nepalese company-registration lookup material that was noise on the form for the ~150 proprietorship firms that carry none of it. A client search (digit-agnostic, by name/registration number/PAN — this screen is reached holding a registration number, not a name) loads the record into a form; a **Profile completeness meter** (reusing the `.cd-meter-*` look) tracks how many of the six non-VAT fields are filled. Saving updates `clients` directly and patches `window.clientsList` in place so BM/AGM Minutes and Auditor Change see the new values without a reload, and logs `company_profile_saved` to AuditLog.

> **Removed module — VAT Return OCR** (removed 2026-07-14 by user decision; the firm won't use it). It read scanned IRD VAT Return PDFs via digit-only OCR and filled the firm's Excel workbook. The removal took with it `js/vatReturn.js`, four engines whose only consumer it was (`ocrEngine`, `pdfEngine`, `visionEngine`, `validationEngine`), `DocumentEngine.workbookToBlob`, the `pdfjs-dist`/`tesseract.js`/`exceljs` CDN tags, and `assets/templates/vat-detail.xlsx`. (`exceljs` was re-added shortly after for the Depreciation module — §5.8 — but the four engines and the OCR/PDF CDN libraries stay gone.) All of it is recoverable from git history (last commit containing it: `ad0e9f2`); its engineering record lives in `HANDOFF_VAT.md` / `HANDOFF_2026-07-05.md`. Historical `audit_log` rows with `module: 'vatReturn'` remain valid; `vat_filings.status` keeps `ocr_processing` as a manual status.

### 5.12 Confirmation Letters (`js/confirmationLetters.js`, `cl-` prefix)

Bulk-generates "Confirmation of Account Balance & Transaction" letters — one per customer/supplier of an audit client — as an audit-fieldwork follow-on to the Sales & Purchase Book (§5.9). Automation Hub tab, labelled **Confirmation** in the menu (not a live-session extension of Autobooks): the user uploads an already-generated Autobooks workbook each time.

- **Data source**: reads the uploaded workbook's `Sales Details`/`Purchase Details` sheets back via SheetJS, using the exact column layout `spbSheetDetails()` writes (`B` `"<Party> Total"`, `C` Pan, `D` Tax Free, `E` Taxable, `F` Vat; stops at the `Grand Total` row). Parties are merged by normalized name across both sheets so a party can qualify by Sales alone, Purchase alone, or both.
- **Threshold** (`cl-threshold`, default 100000/1 lakh on Taxable) is user-editable per run; a party crossing it on either side is pre-checked in the review grid, everything else stays hidden unless "show parties below threshold" is ticked.
- **Nothing generates without an explicit per-party choice** — the review grid is a checklist (include/exclude), with Sales/Purchase **Tax Free + Taxable + Vat** all editable (pre-filled from the workbook, not recomputed at a flat 13%) and Opening/Closing Balance always manual (the workbook carries no ledger-balance data).
- **Letter format** (the firm's newer 5-column layout, matched from `conformation letter new.xlsx`): the table is `Particulars | Tax Free Value (Rs) | Taxable Value (RS) | Vat (RS) | Total (RS)`, rows Opening Balance / Sales / Purchase / Closing Balance (Dr). **Row Total = Tax Free + Taxable + Vat** (`clDash()`/`clBuildLetterData` — a zero amount prints as "-", accounting style). The header carries a **Letter Date** (`cl-date`, B.S. `YYYY.MM.DD`, defaults to today, editable). Opening/Closing rows render "-" across unless a balance is typed.
- **Firm identity** (letterhead Name/Address/PAN/Phone + Date — the audit client's own, not S&A/Dallakoti's) auto-fills from the matched `clients` row when the company search resolves to one, editable either way. Firm block + date live in the Word header (constant per run, repeats every page natively).
- **Template** (`assets/templates/confirmation-letter.docx`) is tokenized from a real firm letter: the per-party body (To/Subject/table/signature) is wrapped in a docxtemplater loop `{{#letters}}...{{/letters}}` with a `{{^last}}`-guarded page break, so **one render function (`clRenderLetters`) serves both outputs** — a combined multi-page `.docx` (all selected letters) and a ZIP of individual `.docx` files (JSZip), one call per party with a single-item array.
- **Fixed a wording bug present in every real sample** (including the firm's own blank master): the Subject line and the paragraph below it referenced fiscal years one year apart. The template uses one `{{fyLabel}}` token in both places. Also corrected the firm's baked-in "Conformation" → "Confirmation" typo.

### 5.13 Service Memo (`js/serviceMemo.js`, `sm-` prefix, table `service_memos`)

Internal **service record** — the firm's guarantee that no professional work is completed without a recorded fee to collect. Deliberately **not** an accounting/tax invoice (that is Billing, §5.3, which carries bank details, a payment QR and a reconciled payments subtable); a Service Memo is one lightweight row: who did what work for which client, and the Fee. Financial Management tab, seeded from the firm's `Work Performed.xlsx` (a field-spec/dropdown sheet, not data). Architecturally a *lighter Billing* — same client autocomplete, TableEngine list, PDF-Lib generation, AuditLog, self-registration.
- **A memo records the work, NOT the collection** (2026-07-26, department-head spec). Its own `payment_status`/`amount_received`/`payment_date` were **dropped** — money received is entered once as a Bank Entry **Fee Receipt** and netted per client by the **Party Ledger** (§5.16). Don't reintroduce payment fields here: two places to record one payment is exactly what this removed. Verified before dropping — 5 memo rows existed, none with a payment.
- **Five selectable firms** (`SERVICE_MEMO_FIRMS` in config.js): Shailesh & Associates, Dallakoti & Company, Ratnanagar Offset Screen Print, Ratnanagar Tax Consultancy, and **Other — specify** (`typed: true`, name entered per memo into `firm_other`; `smFirmName()` is the one resolver, used by the list, the PDF letterhead and the Party Ledger). SA/DC reference `REP_FIRMS` for full PDF letterhead; the sister concerns carry their own name + memo prefix, address/PAN blank until filled in config (PDF prints "—"). This is the ONE source for both the firm dropdown and the PDF letterhead — a new firm needs **no migration**.
- **Memo number** assigned by an AFTER INSERT trigger (`set_service_memo_number`, mirrors `set_invoice_number`): the app sends `memo_prefix` from config (`SM-SA`/`SM-DC`/`SM-ROSP`/`SM-RTC`/`SM-OT`) and the trigger builds `prefix || '-' || lpad(id,5,'0')` → `SM-SA-00001`. Re-fetch after insert (memo_number isn't in the INSERT RETURNING — same gotcha as invoices).
- **Nature of Task** is a category → sub-category tree (`SERVICE_MEMO_TASKS`, seeded from the Excel with typos fixed and "OCR" relabeled "Company Registrar (OCR)"); every category ends in "Others" → a free-text `nature_other` box appears. Easily extended in config.
- **VAT stays per-memo**: the `apply_vat` checkbox drives `vat_amount`/`total_amount`. The Party Ledger prints **that stored figure**, not a blanket 13% (which is what the department head's sheet hardcoded) — so a non-VAT memo never shows the client a VAT charge it was never billed.
- **In-panel list only** — Recent Memos + the filter/table block. The stat grid went with the payment columns (its one card, "Total Collected", had no source left).
- **PDF** via PDF-Lib (pattern of `billingBuildInvoicePdf`), re-skinned as a formal **SERVICE MEMO** stamped **"Internal service record — not a tax invoice."**
- Fiscal year: **dash** (`2081-82`), default from `NepaliLocale.todayBs` — free text, so one memo can span several years (`2080-81/2081-82`) as the firm's sheet does. Filters: firm, category, FY, date range + fuzzy search. `client_id` is a **nullable** FK (typed-only clients still save; name/PAN/address always snapshotted). Migrations: `db/2026-07-21_service_memos.sql`, then `db/2026-07-26_financial_suite.sql`.

### 5.14 Bank Entry (`js/bankBook.js`, `bb-` prefix, tables `bank_accounts` + `bank_transactions`)

> Displayed as **Bank Entry** since 2026-07-25 (Financial Management menu). Everything in code — the file, the `bb-` prefix, the `bankBook` module id, both table names — still says Bank Book.

Receipts & payments ledger for the firm's **own** bank accounts — internal bookkeeping (the firm's cash/bank position), **not** a client-facing document. Launched from the topbar **Financial Management** menu (`buttonId: null`, `bbInit()` in `MODULE_INITS`). Seeded from the CA's `Work Performed.xlsx` sketch. One panel with three sections toggled by a `.rep-view-toggle`: **Accounts**, **Transactions**, **Reports**. Reuses TableEngine, `SearchEngine.attachAutocomplete` (client link on Fee Receipt), NepaliLocale (B.S. dates), PDF-Lib + ExcelJS (exports), AuditLog, self-registration.
- **Accounts master** (`bank_accounts`, user-managed CRUD — the holder/bank list is **data, not JS config**, unlike `SERVICE_MEMO_FIRMS`): **Firm** (required, `firm_key`), Account Name (holder), Bank Name, Account Number (text, preserves leading zeros), Opening Balance + opening date (B.S., FY start). Sample holders span both firms + two individuals (Devi Prasad Dallakoti, Shailesh Dallakoti). **Firm is required on save** — Final Account splits Bank Balance per firm, so an unassigned account would silently vanish from the Balance Sheet. It is also how every bank row is attributed to a firm: transactions carry no firm of their own, only an account. A cash balance is just an account row (e.g. "Cash in Hand") — no `is_cash` flag. An account **with transactions can't be hard-deleted** (FK `on delete restrict` + a JS guard) — it offers **soft-deactivate** (`is_active=false`) instead, so history survives; zero-transaction accounts delete outright.
- **Transactions** (`bank_transactions`): one row per receipt/payment. `particular` ∈ receipts `fee_receipt`/**`for_tax`**/`sapati`/`inter_bank_transfer`, payments `expenses`/**`tax_payment`**/`sapati`/`inter_bank_transfer` (config maps `BANK_RECEIPT_TYPES`/`BANK_PAYMENT_TYPES`). The two tax particulars were added 2026-07-26 (the sheet marks both "to be add"): **For Tax** = money taken from a client earmarked for tax, **Tax Payment** = tax the firm paid on a client's behalf. The drawer's contextual party field relabels per particular — the three **client particulars** (`BANK_CLIENT_PARTICULARS` = `fee_receipt`/`for_tax`/`tax_payment`) show the client autocomplete and set `client_id` + snapshot; Sapati → person; Expenses → free-text name backed by a **datalist of expense names already used** (`bbPopulateExpenseNames`, so the Expenses Ledger doesn't fragment on near-duplicate spellings); Transfer → counterpart-account select.
- **Inter-bank transfer** is entered **once** (From → To) and stored as **TWO paired rows** sharing `transfer_group_id` (a `crypto.randomUUID()`): a `payment` leg on the source (`counterparty_account_id` = dest) and a `receipt` leg on the dest (`counterparty_account_id` = source). **Editing or deleting either leg acts on BOTH** (`bbTransferSiblings`) so they can never desync — the module's key integrity rule.
- **Reports** (per account, B.S. `From→To`): **Receipt register**, **Payment register**, and a running **Statement** (opening balance for the range = account opening + net of everything before `From`, then running balance per row, closing at the end). B.S. dates ordered/compared via `NepaliLocale.bsOrdinal` (2080–2090 table). On-screen HTML table + **PDF** (PDF-Lib, A4 landscape, page-breaking) + **Excel** (ExcelJS, merged header/borders/accounting format `#,##0.00;(#,##0.00);"–"`, live SUM/opening/closing).
- **No stored balances or numbers**: running balances derived at read time (billing-overdue discipline); no memo-number trigger (transactions carry no external number). Fiscal year: **dash** (`2083-84`), derived from `txn_date`. RLS member-CRUD on both tables. Migrations: `db/2026-07-22_bank_book.sql`, then `db/2026-07-26_financial_suite.sql`.
- **Bank Entry is the only place a payment is recorded.** Fee Receipt / For Tax / Tax Payment all flow into the Party Ledger (§5.16); Expenses and Sapati flow into Final Account (§5.17).

### 5.15 Projection Report (`js/projection.js` + `js/projectionEngine.js` + `js/projectionExport.js`, `pj-` prefix, table `projection_reports`)

Bank-ready multi-year **financial projection** generated from an uploaded audited/provisional statement workbook — the automation of the firm's hand-built projection Excel. Automation Hub tab. Three files by concern: `projectionEngine.js` (pure calculation core — **DOM-free, loads in Node** via a `module.exports` guard, which is how it's verified against the real sample files), `projection.js` (UI/orchestration), `projectionExport.js` (ExcelJS + PDF-Lib outputs). The reverse-engineered master spec is `overall important format that will be use in the app and ui and rules.xlsx` (user's Downloads, not committed); reference samples live in `assets/templates/Pashupati*`.

- **Three-step stepper**: Upload & Detect → Assumptions → Review & Export. The parser reads the firm's standard NFRS workbook (SFP/SOI/Sch-PL/Sch-BS/3.1 PPE) by **Note anchors (3.1–3.17) + label regex**, detecting each sheet's current-year value column from its "Particulars" header row — the template uses a *different* column per sheet (SFP→F, Sch-PL→D, Sch-BS→H), so never hardcode one.
- **The projection is a constraint solver, not a growth multiplier.** Deterministic parts: Sales × growth E/F (year-1 % / later-years %), **bottom-up profit** (CA rule 2026-07-25 — replaced the old target-PBT anchor, which squeezed Gross Profit *downward* year-on-year and made every complex file fail rule 6): Gross Profit **and** Net Profit must each rise **≥5%/yr**, and **purchases is the balancing figure** that plugs COGS to hit the resulting GP target (`gpForTargetNp` inverts `taxFor` numerically so proprietorship slabs work). Rule 1 (PAT > the year's Term+PWC principal repayment) is solved through the same GP target. Every admin line ×1.05/yr **except Rent & Audit Fee** (CA rule 2026-07-23: base rounded to '000, held flat, then stepped ×1.15 re-rounded to '000 every 3rd projection year — bumps on years 3, 6, 9…; `steppedFee`/`STEP_FEE_RE` in projectionEngine.js), 7-pool WDV depreciation (Land 0, Building 5, Plant 15, Office 25, Vehicles 20, Software 15, Leasehold 7%), EMI schedules for **Term / Permanent-WC / Hire-Purchase** loans (short-term OD/CC alone carries a flat rate on a constant balance), rule-9 tax (Pvt Ltd/Partnership 25% flat; Proprietorship progressive slabs 0/10/20/27/29%). **Year-1 opening debt is DERIVED from the audited balance-sheet identity**, never summed from the Note 3.8 detail rows — real statements classify those loans inconsistently (on two of four test files the whole term loan also sat inside Current Liabilities, double-counting it and breaking the year-1 cash-flow tie by exactly that amount). **Sundry Creditors** follow rule 3: when the provisional payable exceeds **10 lakh**, every projected year sits at a seeded **75–80%** of it (unique per client, reproducible; a 10%/yr decay would fall out of the band) — smaller payables keep the 2–8 lakh seeded figure. **Sundry Debtors is ALWAYS the balancing figure** (Sources−FA−cash−stock+CL) and is never user-editable; **Purchases balance the P&L** to hit the profit target.
- **The 10 master rules** (from the spec's NCA sheet) drive auto-levers, bounded-iteration: rule 1 yr-1 closing stock = max(STL÷0.7×1.15, opening×1.15); rules 2/3/4 + a debtors≥0 floor → **Additional Capital** (round ↑'000); rule 5 debtor-days>90 → **Dividend** (round ↓'000, < PAT) then **stock-shift** (excess moved into closing stock, purchases re-balance, profit held). Constraints: debtor turnover <90 days, current ratio >1.5, debt-equity <2.33, 70%·NCA ≥ WC loans, Sources=Uses (every year, exact).
- **Review panel**: per-year ratio pass/fail chips, the five levers (cash/creditors/closing stock/additional capital/dividend) editable with **live re-solve** (debtors re-balances); export + save blocked while any validation *error* remains (warnings allowed).
- **Deliberately excluded from the projection** (matches the CA's real delivered sample): non-operating income and SOI expense rows outside notes 3.12–3.15 (e.g. Incentive) — the PBT anchor absorbs them via purchases. **Seeded, not random**: the master asks for "unique" cash (5–9 lakh) and creditors (2–8 lakh) figures; a deterministic RNG seeded from PAN+company+FY makes re-runs reproducible.
- **Master-workbook bugs deliberately corrected** (don't "fix back"): year-3 Dep block re-adding prior closing as an addition, CF operating total omitting the ΔCA row, BS year-1 WDV referencing the net instead of gross total, and the non-cumulative retained-earnings column.
- **Both exports render from ONE shared model** (`pjxBuildReport()` in projectionExport.js — section order, columns, rows, labels, pruning and org terminology), so the Excel is the same document as the PDF rather than a parallel layout that can drift. Sheets are `Cover · Balance Sheet · Profit & Loss · Schedule 1 (Administrative Expenses) · Cash Flow · Depreciation · IRD · Ratio Analysis` — the ~20 admin expense lines sit on their own page/sheet directly after the P&L (which carries only the total, fetched from that schedule), because inline they crowded the statement (+ a **Validation** sheet listing every finding whenever the review flagged something). **Input rows carry NO formula** (Sales, Goods Purchase, Direct Cost, the Schedule-1 admin lines, Cash) — they are the figures the projection is built from, so the sheet stays clean; **every derived line shows its working** (2026-07-25), with Cost of Sales = `Opening+Purchase+Direct−Closing` and Gross Profit = `Sales−COGS` — `xsum` (add these row keys) and `xexpr` (total-row builder) are joined by **`xf`**, a per-cell builder receiving `{R, c, p, ci, yi, rn, X, Xp}` (row map, this/prior column letter, column index, 0-based year, this row number, same-year and prior-year cross-sheet ref helpers). All resolve against the *written* row numbers so pruning can never mis-reference, with the cached value alongside. What that surfaces: **growth rates are visible** (`ROUND(B7*1.08,0)` for sales, `ROUND(B16*1.05,0)` per admin line, `ROUND(C17*1.15,-3)` on a stepped Rent/Audit-Fee bump year, `ROUND(B20*1.1,-1)` cash); **Gross Profit is the driver** carrying the ≥5% target formula, with Cost of Sales = `Sales−GP` and **Purchases visibly the balancing figure** (`COGS−opening−direct−closing`); **Sundry Debtors shows its balancing identity** (`TotalSources−FA−cash−stock+CL`); the **rules are legible** (Expenses Payable = `ROUND(auditFee+salary/12,0)`, TDS = `ROUND(salary*1%+audit*1.5%,0)`, tax = `ROUND(PBT*0.25,0)` for flat-rate entities); the **Depreciation sheet is live arithmetic** (Total = `B+C−D`, Dep = `E*F`, Balance = `E−G`, and each year's Opening = the prior block's Balance for that pool); and **every ratio shows its definition** (debtor days, current, debt-equity, ICR, GP/NP margin all reference their source cells). Each `xf` **re-computes what its formula would evaluate to and emits it only on an exact match**, falling back to the plain figure otherwise — so a formula present in the sheet is always the true derivation (this is why `LIMITS.expenseGrowth` compounds off the prior year's rounded figure, matching the firm's own `=ROUND(<prior cell>*1.05,0)` workbooks). The Audited/Provisional lead column is deliberately **excluded from those formulas** — it holds the client's actual reported totals, which need not foot from the broken-out lines (audited WDV/TDS/expenses-payable aren't itemised in the source statement). **Exports are never gated on validation** — a flagged projection must still leave the app to be corrected in Excel; only *Save to Database* is blocked by errors. **Preview and Print render an HTML document** (`pjxReportHtmlDoc` + `PJX_PRINT_CSS`) built from the same shared model — a white, content-only page mirroring the PDF design (navy band, tinted totals, double-ruled grand totals, signature block, cover). `pjPrintReport()` opens it in a blob tab and auto-prints, exactly like the Audit Report / Notes to Accounts modules (§9.2); the preview iframe loads the *same* document, so what is reviewed is what prints. `<thead>` repeats the header band across printed pages and each sheet is `page-break-after`. The PDF-Lib download remains the bank-ready file. Older note: the previous Excel reproduced the master workbook layout (Dep blocks stacked 12 rows apart) — that geometry is gone with the mirror rewrite. **PDF** via PDF-Lib — A4 **portrait** (2026-07-25; column widths and the number font are fitted to the widest figure the table actually prints, so 1–10 years plus the Audited column all stay aligned, and short statements let their rows breathe to fill the page instead of bunching at the top), mirrors the Excel sheets through shared label consts (`PJX_PL_L`/`PJX_BS_L`/`PJX_CF_L`/`PJX_IRD_ROWS` in projectionExport.js — the single source for both outputs, so texts can never diverge). Excel total rows carry live formulas **including cross-sheet references** (a pass-1 row registry fixes every sheet's row numbers before any formula is written, and references map by YEAR — the Audited lead column shifts BS/P&L columns), so IRD pulls from Profit & Loss / Balance Sheet, BS reserve from the P&L transfer, CF from the P&L, and the NCA working from the BS — every figure shows where it was fetched from. A **Interest Coverage Ratio** row ((PAT+interest)/interest) joins the ratio page; real table grid (navy header band, vertical year separators, tinted total rows, double-ruled grand totals), column widths/font sizes auto-scale for 1–10 years; English labels only (standard fonts can't render Devanagari); ratio rows colour-coded pass/fail. **Bank-submission dressing (2026-07-22):** serif cover page (title/company/FY range/report date + three vertical rules of differing heights, centre tallest, echoing the firm's audit cover); fixed page order Cover→BS→P&L→CF→Dep→IRD→Ratios with each statement **auto-scaled to fit its own page** (row heights/fonts shrink via a two-pass renderer; only Dep may span pages, whole year-blocks kept together); **zero-value rows pruned** with business exceptions (Dividend/Withdrawal, WDV/Depreciation/Fixed-Assets rows always kept; Dep schedule drops inactive asset classes) and ordinal prefixes re-lettered after pruning; **organization-specific terminology** via `pjxTerms(orgType)` — Paid-up vs Registered Capital, Director/Partner/Proprietor — driven by the `pj-org-type` select (auto-set from the client's entity type, also applied to the Excel labels), never showing the three designations together; optional **comparison column** (`pj-include-audited`, default off) leading the BS and P&L, headed by the single uploaded statement type — **Audited OR Provisional, never both** (`pj-statement-type`, auto-detected from the upload filename, flows to the IRD sheet header too); signature footer with dotted lines + auto B.S. date (`NepaliLocale.todayBs`) + place parsed from the client address; ratio page adds **Gross/Net Profit Margin** (also added to the Excel NCA sheet). **Debtor-days band is 30–90** (`LIMITS.minDebtorDays`/`maxDebtorDays`, CA rule 2026-07-22): both bounds validate as warnings and colour the review chips/PDF, and the **solver actively enforces the floor in two ordered steps** — (a) FIRST decrease closing stock (profit held → purchases re-plugs → the balancing debtors rises rupee-for-rupee), bounded so closing stock/purchases stay ≥ 0 and NCA stays ≥ `LIMITS.minNca` (1 lakh; note the shift is NCA-invariant so this is a go/no-go guard); (b) only if (a) can't reach 30 days, raise debtors the rest of the way by injecting Director/Partner/Proprietor **additional capital rounded up to '000**. Both steps keep Sources=Uses and CF=BS-cash exact; levers surface in the review panel's decision log (`debtor-floor step (a)/(b)`). Engine constants (`LIMITS`, `TAX_SLABS`, `DEP_POOLS`) live **in projectionEngine.js**, not config.js, so the engine stays Node-loadable with a single source.
- Fiscal year: **dash** in UI (`2083-84`), **dot full** in sheet columns (`2083.2084`), `YYYY.03.31` as-at headers — per the §9.5 rule.

---

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

### 5.18 Financial Statement (`js/finStatement.js` + `js/finStatementEngine.js` + `js/finStatementExport.js`, `fs-` prefix, table `financial_statements`)

A client's full NFRS statement set — **COI · SFP · SOI · SOCE · SOCF · 3.1 PPE · Sch-BS · Sch-PL** — built from last year's statement plus fourteen current-year summary figures. Automation Hub tab, `fsInit()` in `MODULE_INITS`. Built 2026-07-26. Three files by concern, mirroring Projection (§5.15): `finStatementEngine.js` (pure calculation core, **DOM-free and Node-loadable** via a `module.exports` guard — which is how the whole solver is verified against real client files), `finStatement.js` (UI/stepper), `finStatementExport.js` (shared model → Excel/preview/print).

**This module is the inverse of Projection Report.** Projection takes an audited statement and projects years forward; this constructs *one* year from summary figures, using the prior year only as the comparative column. Spec: `Work Performed (9).xlsx`, sheet `provisional.Audited` (the department head's written rules — inputs A–N, tax logic per return type, the two naming rules). The output format is the **yellow-tabbed** sheets of the sample workbooks, several of which carry the spec inline: `"Fill (A)"` on Sale of Goods, `"Balance Fig "` on Purchases and Trade Receivables, `"Fill H/I/J/G"` on the loan rows, `"As per SLM Module"` on depreciation, `"Between 2 -9 lakh but unique on Each case"` on cash. `Test 1 for VAT.xlsx` is the **annotated blank template**, not test data — its formulas cache `#VALUE!` because placeholder text sits where numbers belong.

- **Inputs A–N**: `A` Sales · `B` Closing Stock · `C` Profit (=PBT) · `D` Tax *(computed)* · `E1`/`E2` interest on Term-PWC-HP / OD-CC-STL-DL · `F` Capital addition · `G` OD/CC/STL · `H` Term · `I` PWC · `J` HP · `K` Advance Tax · `L` VAT receivable/(payable) · `M` Dep as per SLM · `N` Dep as per Income Tax. **`M`/`N` auto-fill from `depreciation_schedules`** for that `(client_id, fiscal_year)` — `scheme='slm'` for M, `normal`/`special` for N.
- **Two balancing figures, both named as such in the template.** **Purchases plugs the P&L** so PBT lands exactly on `C`; **Trade Receivables plugs the balance sheet**. Cash is **seeded 2–9 lakh** from PAN+company+FY via `EngineMath.seededRng` — unique per client, reproducible on re-run. If receivables solves negative a **Director/Proprietor loan** is raised (round up to '000) until it clears — Work Performed G31.
- **The cash flow needs no adjustment to tie.** The template's own SOCF formulas expand algebraically to the balance-sheet delta identity (finance cost and interest income cancel), so with receivables as the plug the closing cash equals the seeded figure by construction. **Income Tax Paid is the prior year's balance-sheet provision**, not its tax expense as the template writes it — the same figure whenever provisions carry current tax only, but it is the provision that actually leaves, and using it is what holds the tie.
- **Three proof rows, shown and never forced** (the Final Account precedent, §5.17): balance sheet, cash flow, and PBT-vs-`C`. All exactly `0.00` on real data.
- **Expense growth**: every P&L line grows `ROUND(×1.05, 0)` off the prior year **except Rent and Audit Fee, held flat** (rule 1) — both still editable as levers. The 3.15 line set is whatever the client's own file carries (6–13 lines, differing per client). Verified against real files: **Salary Payable = salary ÷ 12**, TDS on salary 1%, on rent 10%, on audit fee 1.5%, Audit Fee Payable = fee − its TDS.
- **Tax (COI)**: `TaxableIncome = PBT + M − N`. **Audited returns tax the taxable profit; provisional returns tax the PBT** (Work Performed row 60). D1 presumptive Rs 4,000 municipality / 7,500 metropolitan; D2 presumptive `(Sales−30L)×1%+4,000` up to 50 lakh then `(Sales−50L)×0.8%+24,000` — the two are **continuous at exactly 50 lakh** (both 24,000), which is what proves the first reads off Sales; D3 progressive `[6L@0, 2L@10, 3L@20, rest@30]`; partnerships and companies 25%, or **20% if Special Industry**. D1/D2 exist for **proprietorships only** — the UI offers only the return types the turnover qualifies for. **These slabs are deliberately NOT `projectionEngine.TAX_SLABS`** (`0/10/20/27/29`), which encode a different schedule for a different purpose.
- **Titles by basis** (rows 65–69): Audited → *Statement of …*; Provisional → *Provisional Statement of …* on SFP/SOI/SOCF but the **Statement of Changes in Equity is never prefixed**.
- **The comparative column is READ from the uploaded file, never re-derived** — including the prior year's cash flow (`py.socf`), because a cash flow needs two balance sheets and the year before last isn't in the file. The prior year's own `3.8` loan lines, `3.6` capital rows and `3.7` reserve rows are parsed too, so those notes show the client's real split rather than a fabricated one. Label matching here is **case-insensitive**: the files write "Term Loan", and a `/term/` pattern silently returned 0.
- **A statement set builds with no current-year figures at all.** Entering nothing lays out every sheet with the comparative year in full and the current-year column blank, so the firm can start the file at year end and fill figures in as they arrive. `blankCurrentYear` (auto-detected, or forced via input) makes the export emit `null` — a genuinely empty cell, never a formula or a zero, since "not entered yet" is a different claim from "nil". Two exceptions keep their figures because they are last year's closing by definition: the **SOCE opening balance** and the **3.1 PPE opening** cost/depreciation/carrying rows. The three proofs are suppressed — there is nothing yet to prove.
- **Every current-year figure is editable from the Levers panel** as well as from step 2, plus `tradePayables` (note 3.9 Trade Payables, which defaults to the uploaded purchase detail's closing-balance total and flows to the SFP line, the cash-flow payables movement and hence the balancing receivable). The figures live in `fsFigures` state, **not in the DOM**, precisely because they are edited from two places — two inputs bound to one value drift apart.
- **Re-rendering must not destroy the input being typed in.** The debounced re-solve rebuilds the levers, fixed-asset and expense grids; that detached the focused element and dropped focus to `<body>`, so every keystroke after the first was lost and the fields read as uneditable. `fsPreserveFocus()` restores focus, the caret and the **raw in-progress text** by `data-fsk`, and the money fields are `text` + `inputmode="decimal"` rather than `number` because number inputs expose no selection API to restore a caret with.
- **Entity terminology** flows through `TERMS` — a Pvt Ltd's SOCE row reads "Dividend Paid", a proprietorship's "Drawing", exactly as the sample files differ; likewise Director/Partner/Proprietor on the signature block. "Non Sign" is proprietorship-only.
- **Outputs**: `fsxBuildReport()` builds one declarative sheet model that the Excel workbook, the on-screen preview and the print document all render, so they cannot drift. The **Excel reproduces the template's geometry cell for cell** (label B, notes D, CY F, PY H on the statements; D/F on Sch-PL; H/J on Sch-BS) — which is what lets the cross-sheet formulas be literally the firm's own wiring, with a pass-1 row registry fixing every row number before any formula is written and references resolving by row **key** and column **index**, never a literal letter. Every formula carries its cached result. **Only the current-year column carries formulas** — the comparative holds the prior year's reported figures, which need not foot from the lines a sheet breaks out. Uploaded sales/purchase details ride along as sheets `p` and `s`; the purchase closing-balance total becomes Trade Payables. **PDF comes from printing the HTML document (§9.2), not PDF-Lib** — the browser owns pagination and can render Devanagari, which PDF-Lib's WinAnsi standard fonts cannot.
- Fiscal year: **dash** (`2082-83`), defaulting to the year just **closed** via `NepaliLocale.bsFyDash`. Ashadh year-end wording comes from the calendar table (31 or 32 days by year). Migration: `db/2026-07-26_financial_statements.sql`.

**Findings about the firm's own files, reported rather than absorbed** — the parser flags each: 3.1 PPE opening rows read `"Balance as at"` while closing rows read `"Balance at"`; the SFP carries **Investments, Loans and Provisions twice** (non-current then current) so label-only reads drop the second; `Avi Agro`'s note 3.12 comparative column repeats the current year and disagrees with its own SFP inventories by 25,98,270 (**the SFP wins** — it is the statement, the note is its breakdown); and an unbalanced prior-year balance sheet is caught at parse time because it would otherwise surface only as a cash-flow difference of exactly that amount.

## 6. Database (Supabase Postgres)

Project: `rennqzmwyhkdsizvlqwd.supabase.co`. Schema below **verified live on 2026-07-26** via the Supabase MCP — re-verify before schema-dependent work rather than trusting this snapshot.

### 6.1 Tables (17)

| Table | Purpose / key columns |
|---|---|
| `app_users` | Authorization list. `email` (unique), `role` (`admin`/`staff`, default staff). Checked after Google sign-in; not in the list = Access Denied. |
| `clients` | Directory (**314 rows** since the 2026-07-26 master reload — 261 workbook + 45 Devanagari + 8 kept; §5.7). `name`, `email`, `pan`, `phone`, `address`, `entity_type` (free text), `business_nature`, `registration_number`, `chairman_name`, `shareholder_name`, `authorized_capital`/`issued_capital`/`paid_up_capital` (**text, not numeric** — preserves `"25,00,000"` formatting), `vat_status` (`active`/`inactive`/`not_registered`, CHECK-constrained), plus `district`, `country`, `it_return_type` (`D1/D2`/`D-01`/`D-02`/`D-03`, free text by design) and `tax_type_d3` — added by `db/2026-07-26_client_master_reload.sql`. **PANs may be Devanagari** on the 45 Nepali records, so normalize before comparing (§6.3). |
| `client_shareholders` | Extra shareholders beyond `clients.shareholder_name`. `client_id` (FK, cascade delete), `name`, `sort_order`. |
| `send_logs` | Send Document audit trail. Client name/email snapshotted (not FK'd — immutable trail). `status` `sent`/`error`/`pending`. |
| `audit_log` | App-wide event log (AuditLog engine). `event_type`, `module`, `status`, `user_email`, `client_name`, `record_ref` (bigint), `detail` (jsonb). Feeds the Dashboard. History starts 2026-07-08 (table created after the engine). |
| `vat_filings` | One row per client per month, lazy (§5.2). Unique on `(client_id, fiscal_year, month)`; `month` 1–12 CHECK; `status` CHECK-constrained to the nine §5.2 values; `assigned_staff_id` FK → app_users; `validation_summary` jsonb. |
| `firm_bank_details` | PK `firm_key`. `invoice_prefix` (NOT NULL — see upsert gotcha §5.3), bank fields, `qr_image`. One row per firm. |
| `invoices` | `invoice_number` (unique, trigger-assigned), `client_id`/`firm_key` FKs, `status` CHECK (`draft`/`sent`/`partially_paid`/`paid`/`void`), amounts numeric, `tax_rate` default 0.13. |
| `invoice_items` | Line items: `description`, `quantity`, `rate`, `amount`, `sort_order`. |
| `invoice_payments` | `amount > 0` CHECK, `method` CHECK (`cash`/`bank_transfer`/`qr`/`cheque`/`other`). |
| `service_memos` | Internal service records (§5.13). One row per memo (no line-item/payments subtable). `memo_number` (trigger-assigned `SM-{firm}-{id}`), `memo_prefix` (NOT NULL, from config), `firm_key`, `firm_other` (typed name for the "other" firm), `client_id` (**nullable** FK → clients, on delete set null), client name/pan/address snapshots, `nature_category`/`nature_subcategory`/`nature_other`, `description`, `fiscal_year`, `professional_fee`/`apply_vat`/`vat_amount`/`total_amount`, `remarks`. **No payment columns** — `payment_status`/`amount_received`/`payment_date` were dropped 2026-07-26; collection lives in `bank_transactions` (§5.13). Member-CRUD RLS. `set_service_memo_number` AFTER INSERT trigger + shared `set_updated_at`. `db/2026-07-21_service_memos.sql`, `db/2026-07-26_financial_suite.sql`. |
| `depreciation_schedules` | Saved depreciation working for carry-forward (§5.8). `client_id` (FK, cascade), `scheme` CHECK (`normal`/`special`/`slm`), `fiscal_year` (text, dash format), `company_name`/`pan` snapshots, `pools` jsonb (Income-Tax: per-pool inputs + closing WDV; **SLM: per-asset line array** + carry-forward snapshots → next year's Opening), `addition_details` jsonb (Income-Tax only; `[]` for SLM), `created_by`. Unique on `(client_id, scheme, fiscal_year)`. Manual save only. `slm` added by `db/2026-07-21_slm_scheme.sql`. |
| `bank_accounts` | Bank Book master (§5.14). `firm_key` (owning firm — drives Final Account's per-firm Bank Balance), `account_name` (holder), `bank_name`, `account_number` (text), `opening_balance` numeric, `opening_date` (B.S. text), `is_active` (soft-deactivate), `sort_order`. User-managed CRUD; holder/bank list is data, not config. Member-CRUD RLS. `db/2026-07-22_bank_book.sql`, `db/2026-07-26_financial_suite.sql`. |
| `bank_transactions` | Bank Book receipts & payments (§5.14). `account_id` FK → bank_accounts (**on delete restrict**), `txn_type` CHECK (`receipt`/`payment`), `txn_date` (B.S. text), `particular` CHECK (`fee_receipt`/`for_tax`/`expenses`/`tax_payment`/`sapati`/`inter_bank_transfer`), `amount` numeric (>0), `counterparty_name` snapshot, `client_id` (nullable FK — set for all three client particulars), `counterparty_account_id` (nullable FK, transfer's other leg), `transfer_group_id` uuid (pairs the two legs of a transfer), `fiscal_year` (dash). Member-CRUD RLS. Same migrations. |
| `party_opening_balances` | Per-client opening balance for the Party Ledger (§5.16) — the only figure in that ledger that is stored rather than derived. `client_id` FK (cascade), `firm_key`, `fiscal_year` (dash), `as_on_date` (B.S. text), `opening_amount` numeric, `client_name` snapshot. Unique on `(client_id, firm_key, fiscal_year)`. Member-CRUD RLS + shared `set_updated_at`. `db/2026-07-26_financial_suite.sql`. |
| `financial_statements` | Saved statement workings (§5.18). `client_id` (nullable FK, on delete set null), `company_name`/`pan` snapshots, `fiscal_year` (dash), `basis` CHECK (`provisional`/`audited`), `return_type` (free text like `clients.it_return_type`), `entity_type`, `inputs` jsonb (figures A–N + levers + PPE movement + the parsed prior year — everything needed to re-run `build()` identically), `computed` jsonb (the solved statements, COI computation, proofs), `created_by`. Unique on `(client_id, fiscal_year, basis)` where client_id is not null — `basis` is part of the key because a client legitimately holds both a provisional and an audited set for one year, and it decides both the titles and what gets taxed. Member-CRUD RLS + shared `set_updated_at`. `db/2026-07-26_financial_statements.sql`. |
| `projection_reports` | Saved Projection Report workings (§5.15). `client_id` (nullable FK, on delete set null), `company_name`/`pan` snapshots, `fiscal_year_base` (dash), `years` (1–10 CHECK), `inputs` jsonb (parsed statement model + assumptions — everything needed to re-run the engine exactly), `computed` jsonb (full engine output: statements/ratios/levers per year), `created_by`. Member-CRUD RLS. `db/2026-07-22_projection_reports.sql`. |

### 6.2 Trigger-owned logic (never replicate in JS)

- `sync_invoice_payment_totals()` — recomputes `invoices.amount_paid`/`status` from `invoice_payments` on every insert/update/delete.
- `set_invoice_number` — AFTER INSERT, assigns `{SA|DC}-{id padded}`; re-fetch the row after insert.
- `set_service_memo_number` — AFTER INSERT on `service_memos`, assigns `{memo_prefix}-{id padded}` (prefix sent from JS config); re-fetch after insert (§5.13).

### 6.3 Data conventions

- Capital amounts are formatted **text**, deliberately.
- Registration numbers/PANs may be stored in **Devanagari numerals** — normalize with `NepaliLocale.toEnglishDigits` before comparing.
- Log tables snapshot client data rather than FK it.
- Lazy row creation for `vat_filings` (never pre-create).

### 6.4 Query rules

Supabase/PostgREST caps a single select at **1000 rows** — any query that can grow past that must use `sbFetchAll()` (`utils.js`) with a stable `.order()`. `clients` is at 314 and growing.

### 6.5 Migration workflow

Show the SQL (annotated migration + rollback script as files under `db/`) → apply via the Supabase MCP (`apply_migration`) → verify → commit the SQL files with the change (§1 rule 2).

### 6.6 RLS — ENABLED everywhere (since 2026-07-16)

All tables have RLS **enabled** (base migration `db/2026-07-16_rls_lockdown.sql` covered the original 10; `depreciation_schedules`, `service_memos`, the Bank Book pair `bank_accounts`/`bank_transactions`, `projection_reports` and `financial_statements` added their own member-CRUD policies in `db/2026-07-17_depreciation_schedules.sql`, `db/2026-07-21_service_memos.sql`, `db/2026-07-22_bank_book.sql`, `db/2026-07-22_projection_reports.sql` and `db/2026-07-26_financial_statements.sql`). The permission model:

- **Membership, not authentication, grants access.** Any Google account can complete Supabase sign-in and hold an `authenticated` JWT — so every policy checks membership via `private.is_app_user()` / `private.is_admin()` (SECURITY DEFINER helpers in the non-exposed `private` schema, matching `lower(auth.jwt()->>'email')` against `app_users`). `anon` has no policies → zero access.
- **Policy matrix mirrors the UI's permission model**: members get working CRUD where the UI offers it; `clients` INSERT/DELETE and `client_shareholders` INSERT are admin-only (Add/Import/Delete are admin-gated UI); `send_logs` SELECT is own-rows-or-admin and INSERT requires `sent_by` = own email (no spoofing); `send_logs`/`audit_log` are immutable (no UPDATE/DELETE policies); **`firm_bank_details` writes are admin-only** (deliberate tightening, user-approved 2026-07-16 — bank details + payment QR are the payment-fraud target; `billing.js` renders the settings read-only for staff).
- Triggers (`set_invoice_number`, `sync_invoice_payment_totals`) run as the invoking member — the member UPDATE policy on `invoices` is what lets them work. Don't remove it.
- The 4 RPCs are EXECUTE-revoked for `anon`; `get_db_storage_usage` (SECURITY DEFINER) additionally guards internally on `is_app_user()`.
- When adding a **new table**: enable RLS + add membership policies in the same migration, or the app can't read it at all.

---

## 7. Authentication & Authorization

Login and the Drive/Gmail access token come from **one** Google consent screen, brokered by Supabase Auth — but Supabase and Google Identity Services (GIS) each own a different half of the lifecycle:

1. Sign-in screen → `signIn()` calls `window.sb.auth.signInWithOAuth({ provider: 'google', options: { scopes: SCOPES, redirectTo } })` — a full-page redirect (not a popup), requesting the Drive/Gmail scopes alongside login itself. Supabase's Google provider is configured with its own Client ID + Secret in the Supabase Dashboard (Authentication → Providers), reusing the **same Google Cloud OAuth Client** GIS uses.
2. On load and after the redirect back, `window.sb.auth.onAuthStateChange()` fires (`INITIAL_SESSION` / `SIGNED_IN` / `SIGNED_OUT`) and routes into `afterSupabaseSignIn(session)`. `session.user.email` is already Google-verified by Supabase — no separate userinfo fetch needed.
3. `afterSupabaseSignIn()` looks the email up in `app_users`. Not found → Access Denied. Found → `window.currentUser = {email, role}`, admin-only UI shown conditionally, `loadClients()` + `loadLogs()` run. `session.provider_token` (Google's raw access token) seeds `window.accessToken` for Drive/Gmail calls.
4. **Supabase does not auto-refresh `provider_token`** — that's a Google limitation, not a Supabase one. GIS's silent-renewal loop (`ensureTokenClient`/`scheduleTokenRenewal`/`renewTokenSilently`, using `requestAccessToken({ prompt: '' })`) keeps reissuing that same token every ~50 min without a visible prompt, because Google ties a consent grant to (user, client_id, scope, origin) — not to which SDK asked for it. This requires `window.CLIENT_ID` to still be configured via the "Developer Setup" modal (`gClientId` in `localStorage`) even though it's no longer needed to log in.
5. Sign-out calls both `window.sb.auth.signOut()` and revokes the Google token, then clears state.

**Google OAuth is identity for Drive/Gmail only — it is not what gates access.** Authorization is client-side UI gating from the `app_users` lookup; with RLS off there is no server-side enforcement (§6.6) — moving login onto Supabase Auth is groundwork for eventually enabling RLS (a real `auth.uid()` to write policies against), not a fix for it by itself. `role` affects UI visibility (admin sections, all-staff logs), nothing more.

---

## 8. Google API Integrations

- All Drive/Gmail calls go through `Integrations` (§4). Every Drive request includes `supportsAllDrives=true&includeItemsFromAllDrives=true` — required for Shared Drive visibility.
- Folder resolution matches against name-variant lists (real-world folder naming is inconsistent); each step has a specific, user-actionable error message.
- Email: attachment downloaded from Drive as blob → base64 → raw multipart MIME → `gmail/v1/users/me/messages/send`. **No CRLF/header-injection sanitization on To/Subject yet** (known debt, §15).
- Not integrated: Google Calendar, Google Sheets API.

---

## 9. Document Generation

Three distinct generation paths — pick the one that matches the document family:

### 9.1 Word via templates (BM/AGM, Auditor Change)
Pre-built tokenized `.docx` in `assets/templates/` filled through `DocumentEngine.renderWord` (PizZip + docxtemplater, `{{ }}` delimiters, `paragraphLoop: true`). Loop markers (`{{#items}}`/`{{/items}}`) must each occupy their **own paragraph**. Live preview via `DocumentEngine.previewWordAsHtml` (docx-preview). The BM/AGM template is a Preeti→Unicode (Mangal) conversion with a formatting-group-preserving rebuild — never revert to Preeti, and treat any template modification as a re-validation project (`HANDOFF.md` §4–5; tooling not committed).

### 9.2 Word/PDF via HTML (Report Builder, Notes to Accounts)
The document is rendered as styled HTML in a preview root, then exported two ways: `htmlDocx.asBlob(html, {margins})` for `.docx`, and a standalone print window (auto-`window.print()` after 300ms) for PDF. Print CSS controls pagination — verify page breaks after any layout change.

### 9.3 PDF via PDF-Lib (Billing invoices)
Drawn programmatically: firm letterhead, line items, bank details, QR image (or dashed placeholder).

### 9.4 Excel via ExcelJS (Depreciation, Sales & Purchase Book, Bank Book)
`js/depreciation.js` builds its workbook programmatically with ExcelJS (no template asset) — merged headers, thin borders, accounting number format (`#,##0.00;(#,##0.00);"–"`), live formulas, and percent/`" yrs"` rate formats. `js/salesPurchaseBook.js` (7-sheet workbook) and `js/bankBook.js` (report exports) do the same with the same conventions. These three own their bespoke layouts. Excel/ODS *import* uses SheetJS (`XLSX.read`, read-only).

`js/finStatementExport.js` builds the 8-sheet NFRS statement workbook (§5.18) reproducing the firm template+s cell geometry so its cross-sheet formulas match the original wiring.

**For plain tabular reports, use `ReportExport` (§4) instead of hand-rolling** — Party Ledger and Final Account render all six of their views (HTML + PDF + Excel) through it. The three bespoke generators above were left alone deliberately: their merged/multi-block geometry isn't a simple grid, and migrating five shipped generators belongs in its own change.

### 9.5 Nepali locale
All B.S. date / Devanagari digit / fiscal-year / lakh-crore formatting goes through `NepaliLocale`. **Fiscal-year string formats are deliberately inconsistent per module** — normalize at boundaries, never unify without asking:

| Format | Used by |
|---|---|
| `2081-82` (dash) | Send Document, Report Builder, Notes, Billing |
| `2083/84` (slash) | VAT Compliance (canonical: `vatcFyLabel`) |
| `2083.084` (dot, 3-digit) | Drive year folders (Send Document folder walk) |
| `2081.2082` (dot, full 4-digit) | Sales & Purchase Book sheet titles (`spbFyDot()`) |
| `2081/082` (slash, 3-digit) | Confirmation Letters (`clFyLabel()`) — matches the firm's own real letters |

Fiscal month index is **1–12 with 1 = Shrawan** (not the B.S. calendar month number).

---

## 10. UI Standards

### 10.1 Design system
Single stylesheet `css/styles.css`, Inter font, CSS custom properties on `:root` (`--brand-navy`, `--accent-blue`, status colors `--green/--red/--yellow` with `-bg/-border/-dk` variants, `--radius*`, `--shadow-*`). Layout: fixed topbar (68px) + sidebar (264px). Reuse existing classes — `.card`, `.card-header`, `.form-group`, `.form-grid`, `.status-box` (+ `status-success/error/info/searching`), `.btn`/`.btn-primary`/`.btn-outline`, `.client-table`/`.table-wrap`/`.app-table`, `.autocomplete-list`/`.autocomplete-item`, `.log-badge` (+ `badge-*` variants), `.modal`/`.drawer-panel`, `.rep-view-btn` (Edit/Preview toggles). Never introduce a new visual language.

### 10.2 Element ID prefixes (collision guard — no bundler, one global DOM)

| Prefix | Module | | Prefix | Module |
|---|---|---|---|---|
| `rep-` | Audit Report Builder | | `vatc-` | VAT Compliance |
| `nta-` | Notes to Accounts | | `st-`/`ic-`/`cr-`/`pr-` | Registrar stubs |
| `bm-` | BM/AGM Minutes | | `billing-` | Billing |
| `dep-` | Depreciation | | `spb-` | Sales & Purchase Book |
| `ac-` | **BOTH** Auditor Change and Add Client (historical overlap — no live collision, but check both before adding any `ac-*` id) | | `dash-` | Dashboard |
| `cl-` | Confirmation Letters | | `sm-` | Service Memo |
| `bb-` | Bank Book | | `pj-` | Projection Report |
| `pl-` | Party Ledger | | `fa-` | Final Account |
| `fs-` | Financial Statement | | `cp-` | Company Profile |
| `nb-`/`cd-` | Clients dashboard (Nature of Business categories / general dashboard) | | | |

### 10.3 Interaction patterns
Autocomplete = `SearchEngine.attachAutocomplete` (never hand-roll). Fixed-list pickers = `attachFirmPicker`. Status messages = module `xxStatus()` wrapper. Status badges = `createStatusFlow().badgeHtml()`. Edit/Preview split with on-demand render = the report.js pattern (Notes and Auditor Change already mirror it — copy it for new document builders).

---

## 11. Coding Standards (permanent rules)

1. **Never duplicate code.** Extend or reuse existing logic rather than writing a parallel version.
2. **Always check `js/core/` and `js/utils.js` first** — the engines are the component library (§4).
3. **Keep files modular** — one concern per file; UI + API + business logic don't pile into one file.
4. **Never create unnecessary files** — new file only for a genuinely distinct concern.
5. **Flag files that grow too large** explicitly rather than letting them grow silently (`vatCompliance.js` and `billing.js`, ~700+ lines each, are the current largest).
6. **Prefer reusable helpers** over copy-paste, even for small snippets.
7. **Readable over clever. Comments explain *why*, never *what*** — and only when non-obvious. Calibration findings, root-cause notes, and deliberate trade-offs are exactly what belongs in comments.
8. **Reuse the design system** (§10) — no new visual styles.
9. **Never break existing features** — regression-check every change.
10. **Think at 60–80+ features scale** — avoid decisions that only work at today's size.
11. **Every feature must feel native** — consistent naming (`xx`-prefixed functions, `xx-` ids), structure, and UI language.
12. **Self-review before presenting anything as done.**
13. **`escHtml()` every dynamic string injected into HTML.** Never interpolate free-text values into inline `onclick` attributes — pass IDs and look records up from state (this exact bug shipped once).

## 12. Git Workflow (hard rules)

1. **Feature → Review → Commit → Push**, strictly in order. Never push unreviewed work.
2. **One logical change per commit** — split unrelated fixes/features/cleanups even within one conversation. Commit messages follow `type(scope): summary` (`feat(report): …`, `fix(bmAgm): …`).
3. **Never rewrite pushed history without explicit approval** each time.
4. **Never push without explicit approval, every time.** Committing locally proactively is fine.
5. Bump the `?v=` cache-bust version in `index.html` as part of any front-end change being shipped.

---

## 13. Testing & Verification Checklist

The established working pattern — **investigate with real evidence → implement only what the evidence justifies → verify against real data → regression-check → self-review → commit**:

- Verify in the **real running app** (dev server + browser tools), not just by reading code. Bypass auth via DOM manipulation; mock Drive/Gmail where OAuth can't run.
- For document generation: render with real inputs; check output structurally (unzip `.docx`, re-read `.xlsx` via ExcelJS). Remember: **no Word/LibreOffice here** — ask the user for the final visual check and say so plainly.
- For nontrivial pipeline changes (OCR, template rebuilds): **proof-of-concept against real documents before implementing** — this project has repeatedly proven assumptions wrong (per-page margins, run-boundary conversion breaks, worker-API divergence).
- Regression sweep after every change: activate every tab and registrar sub-panel, confirm rendering, check the console for errors.
- Report failures honestly, including what was *not* tested. Never claim verification that didn't happen; never fabricate results.

## 14. Security Practices

Hardened 2026-07-16 (see §6.6, and the `db/` migration). Current posture:

- **RLS is the server-side enforcement layer** (§6.6) — enabled on all 17 tables, membership-checked. The publishable key alone now grants nothing. Anon and non-member JWTs get zero rows. This is the single most important control; don't disable it.
- `escHtml()` on all dynamic HTML (rule 13); no free-text in inline event handlers. Google Drive filenames are untrusted — escape them in any HTML context (`sendDocument.js`).
- **Email raw-MIME construction is sanitized** — `Integrations.sendRawEmailWithBlob` CRLF-strips every header value and RFC 2047-encodes Subject/filename. Don't reintroduce raw interpolation into header lines.
- **Drive `q` strings are escaped** via `escDriveQuery` in `integrations.js` — keep using it for any name interpolated into a Drive query.
- **CSP** (meta tag in `index.html`) + **SRI** on every pinned CDN dependency + **security headers** (`vercel.json`). CSP keeps `'unsafe-inline'` for scripts (inline handlers + blob print windows), so it does NOT stop inline XSS — escHtml is what covers that. `connect-src` is the exfiltration guard; when adding an integration to a new external host, add it there or the call is blocked.
- OAuth/Supabase session tokens live in `localStorage` — readable by any successful XSS (residual risk; the escHtml audit + CSP `connect-src` are the mitigations).
- No secrets belong in this repo beyond the publishable key — anything else the user manages. (The Google **Client Secret** now lives only in the Supabase Dashboard, never in the repo.)

---

## 15. Known Technical Debt

| Item | Severity | Notes |
|---|---|---|
| BM/AGM template-build tooling never committed | High | Exists only as prose in `HANDOFF.md`. Any template rebuild starts by recreating it. |
| CSP keeps `'unsafe-inline'` for scripts | Medium | Full fix = refactoring the ~hundreds of inline `onclick=` handlers + blob print windows off inline script; a separate project. escHtml audit is the current mitigation (§14). |
| No automated tests | Medium | All verification is manual/ad-hoc per §13. |
| 4 Company Registrar stubs (Share Transfer, Increase Capital, Company Registration, PIN Reset) | Feature gap | UI-only, `moduleComingSoon()`. Party Ledger is no longer among them — built 2026-07-26 (§5.16). |
| Financial Statement per-class depreciation is allocated, not per-asset | Low | The 3.1 PPE note needs depreciation per asset class while figure `M` is one total. A helper allocates `M` by opening balance and the engine warns when the class total disagrees with `M`, but reading the per-class split straight from the SLM schedule+s `pools` jsonb would be exact (§5.8). |
| `README.md` badly outdated | Low | Superseded by this file (§18). |
| Section 51 "collected amount" in BM/AGM template is static sample text | Low | Known, deliberate cap during tokenization. |

**Resolved 2026-07-16** (security hardening pass): RLS now enabled on all 10 tables (§6.6); `supabase-js` pinned + SRI on all CDN deps; CSP + security headers added; email header-injection + Drive-query sanitization added; `_tmp_click_test.pdf` gone.

## 16. Deliberate Decisions — Do NOT "Fix"

- **Preeti → Mangal (Unicode) template conversion** — explicit user decision. Never revert to Preeti.
- **Billing QR is a static uploaded image** — never add a QR-generation library or a scannable-looking placeholder.
- **Invoice status is trigger-owned** — never set `paid`/`partially_paid` from JS.
- **Fiscal-year formats differ per module** (§9.5) — don't unify without asking.
- **Capital amounts are text** — preserves the firm's comma grouping.
- **VAT "Filed" status is always manual.**
- **VAT clients are a hand-picked subset** — never bulk-activate.
- **Clients table / import preview show a curated column subset**, not all fields.
- **The 45 Devanagari client records are kept alongside their English twins** (2026-07-26) — 37 share a PAN, but they are what BM/AGM Minutes and `client_shareholders` read. Never de-duplicate the directory on PAN alone.
- **The 8 clients absent from the client master were kept** (2026-07-26, user decision) — 5 carry live VAT filings, service memos or bank transactions.
- **`it_return_type` is free text, not CHECK-constrained**, and `D1/D2` is a real single value meaning "either" — not a placeholder to be split.
- **The Clients dashboard reports the whole portfolio, not the filtered table**, and always draws its "Not set" bucket (§5.7).
- **The 7 statutory registration fields stay on `clients`** (2026-07-27) — only their editing surface moved to Company Registrar → Company Profile. Never re-add them to the general Add/Edit Client form, and never have `saveClient()` send those keys (even as null) from that form.
- **`tax_registration_type` (VAT/PAN) is not `vat_status`** — one is a client property from the workbook, the other is whether the firm files that client's monthly VAT return. Don't merge them into one field.
- **Entity Type on the client form is exactly 8 values** (`CLIENT_ENTITY_TYPES`) — the 7 `Partnership Firm` clients are a deliberate exception, preserved via injection rather than folded into the list; don't add a 9th option to accommodate them.
- **Dashboard is not the default landing tab** — Send Document stays default.
- **Only the Clients table uses Tabulator** — other tables were deliberately not migrated.
- **Service Memo records work, not collection** (2026-07-26) — its payment columns were dropped deliberately. A payment is recorded once, in Bank Entry, and netted by the Party Ledger. Never re-add payment fields to the memo.
- **Financial Statement's cash is seeded, and Trade Receivables is the plug** (2026-07-26, user decision) — the spec asks for cash "unique on Each case", so it is seeded from client identity to stay reproducible, and receivables absorbs the balance. A negative plug raises a Director/Proprietor loan; it is never fixed by nudging cash.
- **Financial Statement's three proof rows are shown, not forced** — like Final Account below. A non-zero figure is a finding about the inputs (an unbalanced prior-year file, or a per-class depreciation total that disagrees with figure M), not a rendering bug.
- **The Statement of Changes in Equity is NEVER titled "Provisional"**, even on a provisional set — the other three statements are. Straight from Work Performed rows 66–69.
- **Financial Statement's D3 slabs (`0/10/20/30`) are not Projection's `TAX_SLABS` (`0/10/20/27/29`)** — two different schedules for two different purposes. Don't unify them.
- **Final Account's `Net Difference` is shown, not forced** — a non-zero figure is a real finding (§5.17), not a rendering bug to suppress.
- **Party List carries Opening + Tax Paid columns the department head's sheet didn't draw** (user-approved) so the Balance foots on screen. Don't trim it back to the sheet's five columns.
- **The VAT Return OCR module was removed on purpose** (2026-07-14, user decision) — don't restore it, its four engines, or the `pdfjs-dist`/`tesseract.js` CDN libraries unless the user asks. (`exceljs` legitimately came back for Depreciation.)

## 17. AI Assistant Instructions

**Session startup:** read §1; skim the section for whatever module you're touching; `git log --oneline -15` and `git status` to orient. For schema work, re-verify against live Supabase rather than trusting §6's snapshot.

**Do:**
- Follow the evidence-first pattern (§13) — this project's history is full of assumptions that real data disproved.
- Ask before anything in the Needs-User-Confirmation register: (1) migrations via MCP vs. user-run (§1).
- Keep this file updated in the same commit as the change it documents.
- State honestly what was and wasn't verified.

**Don't:**
- Push, migrate, or rewrite history without explicit approval (§1).
- Guess at Nepali-language/legal wording — propose and get user confirmation (established pattern for Preeti gaps and statutory text).
- Consolidate or refactor things the user deferred, without a fresh explicit ask.
- Trust `README.md` or the HANDOFF files as current state — they are historical.

## 18. Related Documents

| File | Status | What it's still good for |
|---|---|---|
| `README.md` | **Outdated** (pre-engine era) | Nothing authoritative; update or retire it as a separate task. |
| `HANDOFF.md` (2026-07-03) | Historical | The only record of the BM/AGM Preeti→Unicode template pipeline, token list, and formatting-group rebuild — required reading before touching that template. |
| `HANDOFF_VAT.md` (2026-07-04) | Historical | VAT Return OCR engineering record (module removed 2026-07-14 — removal note at the end of §5). |
| `HANDOFF_2026-07-05.md` | Historical | The engine-layer rebuild rationale and per-engine migration notes (four of those engines were removed with the VAT Return module). |
| Memory (`~/.claude/projects/.../memory/`) | Live | Cross-session conventions for VAT Compliance and Billing (mirrored into §5.2/§5.3). |
