# CLAUDE.md — Project Guide

Internal workflow-automation platform for **Shailesh & Associates** (Chartered Accountants) and **Dallakoti & Company** (Registered Auditors) — two affiliated audit firms in Chitwan, Nepal. Max 8 users, all staff. It automates document generation (audit reports, statutory minutes, registrar filings, invoices), VAT return preparation and tracking, client management, and Drive/Gmail document delivery.

---

## 0. How to use this file

This file is loaded into **every** session, so it holds only what protects work regardless of which file you open. Module detail, the full schema and the deep engine notes live in `docs/` and are read **on demand**.

**Two routing rules:**

1. **Before editing a feature module, read its doc** — the §5 index maps every module to a file in `docs/modules/`. Those docs are the same text that used to be in this file (moved verbatim 2026-07-27), so working without them means working with less than previous sessions had.
2. **Before schema work, read `docs/database.md`** and re-verify against live Supabase via the MCP rather than trusting any snapshot.

**Keep it current.** When a feature ships or a convention changes, update the relevant doc **in the same commit**. Hard rules, deliberate decisions, ID prefixes and fiscal-year formats belong in *this* file; everything else belongs in `docs/`. See §17 for the full map.

---

## 1. Quick Orientation

**Stack in one line:** static HTML/CSS/vanilla-JS single-page app (no framework, no build step, no bundler), talking directly to Supabase Postgres (publishable key, no Supabase Auth) and Google Drive/Gmail APIs (user's own OAuth token), hosted on GitHub Pages.

**Hard rules that must never be broken:**

1. **Never `git push` without explicit user approval** — every time, no standing permission. Committing locally is fine proactively.
2. **SQL migrations: show the SQL, then apply via the Supabase MCP.** *(User approved 2026-07-16, during the RLS lockdown work.)* Keep the annotated migration + a rollback script as files under `db/` in the same commit; the MCP is also fine for read-only schema verification. Never run destructive DDL without the SQL having been shown first.
3. **Never rewrite pushed history** (`--amend`, rebase, force-push) without explicit approval each time.
4. **Bump the cache-busting `?v=` version** on `index.html`'s local script/CSS tags when shipping changes — GitHub Pages serves stale files otherwise.
5. **Never break existing features** — regression-check before calling anything done.
6. **Don't "fix" the deliberate decisions in §15.**
7. **This repo is PUBLIC** — real client names, PANs and addresses never get committed. See `.gitignore`.

**30-second map:** `index.html` is the whole UI shell (all panels, all script tags). `js/config.js` holds constants/state/Supabase init. `js/core/` holds 13 reusable engines — check there before writing anything new. Each feature is one file in `js/`. All styling is `css/styles.css`. Word/Excel templates live in `assets/templates/`. Database is Supabase (17 tables, §6).

---

## 2. Tech Stack & Architecture

> Full detail — runtime architecture, the CDN table with per-library rationale, hosting, local dev: **`docs/architecture.md`**.

The app itself runs **entirely client-side**. The browser talks to **Supabase Postgres** via `supabase-js` (publishable key in `config.js`; RLS enabled on every table, §6) and to **Google Drive (readonly) + Gmail (send)** via the signed-in staff member's own OAuth token. Emails send as the actual staff member, not a service account. State is `window.*` globals — no modules, no state library.

**One exception, added 2026-08-01: `ocr_service/`** — a FastAPI + PaddleOCR process backing the OCR Extract module (§5). It is **optional, local-only, and not deployed** (GitHub Pages can't run Python): each staff member starts it on their own machine with `ocr_service/start.ps1` when they want OCR. Nothing else depends on it — if it's stopped, only that one tab is affected. It does not make this a client/server app; treat it as an optional companion process, and don't move other features onto it without asking. Needs **Python 3.10–3.12** (PaddlePaddle publishes no wheel for 3.13/3.14). Detail: `docs/architecture.md` §2.6 and `ocr_service/README.md`.

### Script load order (load-bearing)

Later files depend on globals set up by earlier ones. Order in `index.html`:

```
CDN libraries → config.js → utils.js → js/core/* (13 engines) → tabs.js
→ feature modules (dashboard, registrar, clients, logs, vatCompliance,
  billing, sendDocument, report, notesToAccounts, depreciation,
  bmAgmMinutes, auditorChange, salesPurchaseBook, bankBook,
  partyLedger, finalAccount, finStatement, ocrExtract) → auth.js (LAST — triggers the boot sequence)
```

- `finStatementEngine.js` before `finStatement.js` and `finStatementExport.js`; all three after `js/core/workbookReader.js` + `engineMath.js` (which `projectionEngine.js` also depends on).
- `finalAccount.js` **after** `partyLedger.js` — it reads that module's state and calls its `plBuildParties`/`plReceivablesFor`/`plExpenseTotalsFor`.

### CDN dependencies

No `package.json`, no npm at the app level — all libraries are `<script>` tags. Pinned: `@supabase/supabase-js` 2.110.7 · `xlsx` (SheetJS) 0.18.5 full build (import only, read-only) · `exceljs` 4.4.0 (generation) · `pizzip` 3.1.7 + `docxtemplater` 3.50.0 · `jszip` 3.10.1 · `docx-preview` 0.3.7 · `fuse.js` 7.0.0 · `pdf-lib` 1.17.1 · `tabulator-tables` 6.3.0 · `chart.js` 4.4.0 · `html-docx-js` 0.3.1. Plus the two Google loaders (dynamic, can't be SRI-pinned — constrained by CSP `script-src` instead).

**Every pinned dep carries SRI (`sha384`) + `crossorigin`.** When bumping a version, recompute the hash (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) or the file silently won't load.

### Hosting & local dev

- Remote `https://github.com/aadarshakhanal2064-cyber/AUTOMATION`, branch `main` only. GitHub Pages auto-deploys on push; `.nojekyll` is required.
- Dev server: `.claude/launch.json` defines `static-site`. Use the browser-preview tooling, never Bash.
- **Real Google OAuth cannot run in the sandbox** — bypass the auth wall via DOM manipulation, mock Drive/Gmail where needed.
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
│   ├── utils.js             # escHtml, sbFetchAll, attachFirmPicker, blobToBase64, stringSimilarity
│   ├── tabs.js              # Tab switching via ModuleRegistry; topbar dropdowns
│   ├── auth.js              # Boot sequence, Google sign-in/out, app_users authorization
│   ├── core/                # 13 reusable engines — §4
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
| AuditLog | `auditLog.js` | `record(eventType, detail)`, `recent`, `countSince` → Supabase `audit_log`. Every call is try/catch-wrapped and **never throws**. |
| Integrations | `integrations.js` | `driveGet`, `findFolderByName`, `listAllFilesInFolder`, `downloadDriveFile`, `sendEmailWithAttachment`. All Drive calls append `supportsAllDrives=true&includeItemsFromAllDrives=true`. |
| WorkbookReader | `workbookReader.js` | Locating figures inside the firm's hand-maintained NFRS workbooks. **Everything is label-driven, never positional — never hardcode a value column.** Node-loadable. |
| EngineMath | `engineMath.js` | `seededRng(key)`, `round1000Up/Down`, `deRound`. What makes the "unique per case" figures **reproducible per client**. Node-loadable. |
| ReportExport | `reportExport.js` | `toHtml`/`toPdf`/`toExcel`/`download` over one tabular model. Knows nothing about ledgers — callers hand it finished cells. **`pdfSafe()` inside it is load-bearing** (PDF-Lib standard fonts throw on non-WinAnsi characters). |
| OcrEngine | `ocrEngine.js` | `checkHealth`, `extractText(file)` against the local OCR service (`ocr_service/`, §2). Translates a dead-port `fetch()` rejection into an actionable "service not running" message while preserving the API's own error text. Base URL is `window.OCR_SERVICE_URL`. |

**Adding a new tab/sub-module:** create `js/<module>.js`, call `ModuleRegistry.register()` from it, add the panel + nav button to `index.html`, add the `<script>` tag in load order, prefix all element IDs (§9). No edits to `tabs.js`.

---

## 5. Feature Modules — index

> **Read the module's doc before editing it.** Each doc holds the calibration findings, formulas, gotchas and deliberate trade-offs that this table cannot.

Navigation is a short sidebar plus three **topbar dropdowns** (shared open/close mechanic in `tabs.js` `toggleTopbarMenu`). Each module has exactly one home — never both a sidebar button and a menu entry. Everything in the last two menus is an ordinary `main`-group tab registered with `buttonId: null` and launched via **`openModule(tab)`**, with `MODULE_INITS` holding only the modules needing an init call on open.

| Module | Where | File(s) | Prefix | Table(s) | Doc |
|---|---|---|---|---|---|
| Dashboard | Sidebar | `dashboard.js` | `dash-` | *(reads `audit_log`)* | [compliance-billing](docs/modules/compliance-billing.md) |
| VAT Compliance | Sidebar | `vatCompliance.js` | `vatc-` | `vat_filings` | [compliance-billing](docs/modules/compliance-billing.md) |
| Send Document | Sidebar *(default tab)* | `sendDocument.js` | — | `send_logs` | [documents](docs/modules/documents.md) |
| Clients | Sidebar | `clients.js` | `ac-` `cd-` `nb-` | `clients`, `client_shareholders` | [clients](docs/modules/clients.md) |
| Send Logs | Sidebar | `logs.js` | — | `send_logs` | [compliance-billing](docs/modules/compliance-billing.md) |
| Company Registrar *(6 sub-modules)* | Topbar → Registrar | `registrar.js`, `bmAgmMinutes.js`, `auditorChange.js`, `companyProfile.js` | `bm-` `ac-` `cp-` `st-` `ic-` `cr-` `pr-` | `clients`, `client_shareholders` | [registrar](docs/modules/registrar.md) |
| Service Memo | Financial Management | `serviceMemo.js` | `sm-` | `service_memos` | [financial-management](docs/modules/financial-management.md) |
| Billing | Financial Management | `billing.js` | `billing-` | `invoices`, `invoice_items`, `invoice_payments`, `firm_bank_details` | [compliance-billing](docs/modules/compliance-billing.md) |
| Party Ledger | Financial Management | `partyLedger.js` | `pl-` | `party_opening_balances` | [financial-management](docs/modules/financial-management.md) |
| Bank Entry | Financial Management | `bankBook.js` | `bb-` | `bank_accounts`, `bank_transactions` | [financial-management](docs/modules/financial-management.md) |
| Final Account | Financial Management | `finalAccount.js` | `fa-` | *(none — pure view)* | [financial-management](docs/modules/financial-management.md) |
| Financial Statement | Automation Hub | `finStatement.js` + `finStatementEngine.js` + `finStatementExport.js` | `fs-` | `financial_statements` | [financial-statement](docs/modules/financial-statement.md) |
| Projection Report | Automation Hub | `projection.js` + `projectionEngine.js` + `projectionExport.js` | `pj-` | `projection_reports` | [projection](docs/modules/projection.md) |
| Depreciation | Automation Hub | `depreciation.js` + `depreciationSlm.js` | `dep-` `dep-slm-` | `depreciation_schedules` | [depreciation](docs/modules/depreciation.md) |
| Confirmation | Automation Hub | `confirmationLetters.js` | `cl-` | *(none)* | [documents](docs/modules/documents.md) |
| Generate Report | Automation Hub | `report.js` | `rep-` | *(none)* | [documents](docs/modules/documents.md) |
| Notes to Accounts | Automation Hub | `notesToAccounts.js` | `nta-` | *(none)* | [documents](docs/modules/documents.md) |
| Autobooks | Automation Hub | `salesPurchaseBook.js` | `spb-` | *(none)* | [autobooks](docs/modules/autobooks.md) |
| OCR Extract | Automation Hub | `ocrExtract.js` | `ocr-` | *(none)* | [documents](docs/modules/documents.md) |

### Two modules were renamed — display name only

File names, function prefixes, element-ID prefixes, table names and `ModuleRegistry` ids all keep their originals. This trips up every first encounter with either module:

| Menu / page label | Module in code |
|---|---|
| **Autobooks** | Sales & Purchase Book — `js/salesPurchaseBook.js`, `spb-` |
| **Bank Entry** | Bank Book — `js/bankBook.js`, `bb-`, tables `bank_accounts`/`bank_transactions` |

"Confirmation" is the menu label for Confirmation Letters; the panel keeps the fuller title.

**Four Company Registrar stubs remain** (Share Transfer, Increase Capital, Company Registration, PIN Reset) — UI built, logic is `moduleComingSoon()`. **The VAT Return OCR module was removed** 2026-07-14 by user decision; see `docs/modules/registrar.md` for what went with it and how to recover it.

---

## 6. Database (Supabase Postgres)

> **Full column-level reference: `docs/database.md`.** Project `rennqzmwyhkdsizvlqwd.supabase.co`. Re-verify live via the Supabase MCP before schema-dependent work.

**17 tables:** `app_users` · `clients` (314 rows) · `client_shareholders` · `send_logs` · `audit_log` · `vat_filings` · `firm_bank_details` · `invoices` · `invoice_items` · `invoice_payments` · `service_memos` · `depreciation_schedules` · `bank_accounts` · `bank_transactions` · `party_opening_balances` · `financial_statements` · `projection_reports`.

### Trigger-owned logic (never replicate in JS)

- `sync_invoice_payment_totals()` — recomputes `invoices.amount_paid`/`status` from `invoice_payments` on every insert/update/delete.
- `set_invoice_number` — AFTER INSERT, assigns `{SA|DC}-{id padded}`; **re-fetch the row after insert**, it isn't in INSERT's RETURNING.
- `set_service_memo_number` — AFTER INSERT on `service_memos`, assigns `{memo_prefix}-{id padded}`; same re-fetch gotcha.

### Data conventions

- Capital amounts are formatted **text**, deliberately (preserves `"25,00,000"`).
- Registration numbers/PANs may be **Devanagari numerals** — normalize with `NepaliLocale.toEnglishDigits` before comparing.
- Log tables **snapshot** client data rather than FK it (immutable trail).
- **Lazy row creation** for `vat_filings` — never pre-create months.

### Query rules

PostgREST caps a single select at **1000 rows** — any query that can grow past that must use `sbFetchAll()` (`utils.js`) with a stable `.order()`. `clients` is at 314 and growing.

### Migration workflow

Show the SQL (annotated migration + rollback as files under `db/`) → apply via Supabase MCP (`apply_migration`) → verify → commit the SQL files with the change (§1 rule 2).

### RLS — ENABLED on all 17 tables (since 2026-07-16)

**Membership, not authentication, grants access.** Any Google account can hold an `authenticated` JWT, so every policy checks membership via `private.is_app_user()` / `private.is_admin()` (SECURITY DEFINER helpers in the non-exposed `private` schema). `anon` has no policies → zero access. The policy matrix mirrors the UI: members get CRUD where the UI offers it; `clients` INSERT/DELETE is admin-only; `send_logs`/`audit_log` are immutable; **`firm_bank_details` writes are admin-only** (payment-fraud target).

**When adding a new table: enable RLS + add membership policies in the same migration, or the app can't read it at all.**

---

## 7. Authentication & Google APIs

> Full lifecycle and folder-walk detail: **`docs/architecture.md`**.

Login and the Drive/Gmail token come from **one** Google consent screen brokered by Supabase Auth (`signInWithOAuth`, full-page redirect, Drive/Gmail scopes requested alongside login). `onAuthStateChange` routes into `afterSupabaseSignIn(session)`, which looks the email up in `app_users` — not found = Access Denied. `session.provider_token` seeds `window.accessToken`.

**Supabase does not auto-refresh `provider_token`** (a Google limitation). GIS's silent-renewal loop reissues it every ~50 min, which is why `window.CLIENT_ID` must still be configured via the Developer Setup modal even though it is no longer needed to log in.

**Google OAuth is identity for Drive/Gmail — RLS is what gates data** (§6). `role` affects UI visibility only.

All Drive/Gmail calls go through `Integrations` (§4). Folder resolution matches name-variant lists (real folder naming is inconsistent), each step with a specific, user-actionable error.

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
| `2083/84` (slash) | VAT Compliance (canonical: `vatcFyLabel`) |
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
| `rep-` | Audit Report Builder | | `vatc-` | VAT Compliance |
| `nta-` | Notes to Accounts | | `st-`/`ic-`/`cr-`/`pr-` | Registrar stubs |
| `bm-` | BM/AGM Minutes | | `billing-` | Billing |
| `dep-` | Depreciation | | `spb-` | Sales & Purchase Book (Autobooks) |
| `ac-` | **BOTH** Auditor Change and Add Client (historical overlap — no live collision, but check both before adding any `ac-*` id) | | `dash-` | Dashboard |
| `cl-` | Confirmation Letters | | `sm-` | Service Memo |
| `bb-` | Bank Book (Bank Entry) | | `pj-` | Projection Report |
| `pl-` | Party Ledger | | `fa-` | Final Account |
| `fs-` | Financial Statement | | `cp-` | Company Profile |
| `nb-`/`cd-` | Clients dashboard (Nature of Business categories / general dashboard) | | `ocr-` | OCR Extract |

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

- **RLS is the server-side enforcement layer** (§6) — enabled on all 17 tables, membership-checked. The publishable key alone grants nothing. **Don't disable it.**
- `escHtml()` on all dynamic HTML (rule 13); no free-text in inline event handlers. Google Drive filenames are untrusted.
- **Email raw-MIME construction is sanitized** — `Integrations.sendRawEmailWithBlob` CRLF-strips every header value and RFC 2047-encodes Subject/filename. Don't reintroduce raw interpolation.
- **Drive `q` strings are escaped** via `escDriveQuery` — keep using it for any interpolated name.
- **CSP** (meta tag in `index.html`) + **SRI** on every pinned CDN dep + security headers (`vercel.json`). CSP keeps `'unsafe-inline'` for scripts, so it does **not** stop inline XSS — escHtml is what covers that. `connect-src` is the exfiltration guard: adding an integration to a new external host means adding it there or the call is blocked.
- OAuth/Supabase tokens live in `localStorage` — readable by any successful XSS (residual risk).
- No secrets in this repo beyond the publishable key. The Google **Client Secret** lives only in the Supabase Dashboard.

---

## 14. Known Technical Debt

| Item | Severity | Notes |
|---|---|---|
| BM/AGM template-build tooling never committed | High | Exists only as prose in `docs/history/HANDOFF.md`. Any template rebuild starts by recreating it. |
| CSP keeps `'unsafe-inline'` for scripts | Medium | Full fix = refactoring hundreds of inline `onclick=` handlers off inline script; a separate project. escHtml audit is the mitigation. |
| No automated tests | Medium | All verification is manual/ad-hoc per §12. |
| 4 Company Registrar stubs | Feature gap | UI-only, `moduleComingSoon()`. |
| Financial Statement per-class depreciation is allocated, not per-asset | Low | A helper allocates figure `M` by opening balance and warns on disagreement; reading the per-class split from the SLM schedule's `pools` jsonb would be exact. |
| Section 51 "collected amount" in BM/AGM template is static sample text | Low | Known, deliberate cap during tokenization. |

---

## 15. Deliberate Decisions — Do NOT "Fix"

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
- **Dashboard is not the default landing tab** — Send Document stays default.
- **Only the Clients table uses Tabulator** — other tables were deliberately not migrated.
- **Service Memo records work, not collection** (2026-07-26) — its payment columns were dropped deliberately. A payment is recorded once, in Bank Entry, and netted by the Party Ledger. Never re-add payment fields to the memo.
- **Financial Statement's cash is seeded, and Trade Receivables is the plug** (2026-07-26, user decision) — the spec asks for cash "unique on Each case", so it is seeded from client identity to stay reproducible, and receivables absorbs the balance. A negative plug raises a Director/Proprietor loan; it is never fixed by nudging cash.
- **Financial Statement's three proof rows are shown, not forced** — a non-zero figure is a finding about the inputs, not a rendering bug.
- **The Statement of Changes in Equity is NEVER titled "Provisional"**, even on a provisional set — the other three statements are.
- **Financial Statement's D3 slabs (`0/10/20/30`) are not Projection's `TAX_SLABS` (`0/10/20/27/29`)** — two different schedules for two different purposes. Don't unify them.
- **Final Account's `Net Difference` is shown, not forced** — a non-zero figure is a real finding, not a rendering bug to suppress.
- **Party List carries Opening + Tax Paid columns the department head's sheet didn't draw** (user-approved) so the Balance foots on screen. Don't trim it back to five columns.
- **Projection's master-workbook bugs are deliberately corrected** (year-3 Dep block, CF operating total, BS year-1 WDV reference, non-cumulative retained earnings) — don't "fix" them back.
- **Projection excludes non-operating income and out-of-note SOI expense rows** — matches the CA's real delivered sample.
- **Autobooks' "As Per VAT Return" figures are typed by the user, never derived** — filed figures genuinely differ from book, and are truncated to whole rupees.
- **Autobooks never auto-merges parties on PAN** — one PAN spanned two unrelated companies, and one name spanned two real entities.
- **Depreciation carry-forward is manual-save only** — generating Excel never writes, so testing is safe.
- **The VAT Return OCR module was removed on purpose** (2026-07-14, user decision) — don't restore it, its four engines, or the `pdfjs-dist`/`tesseract.js` CDN libraries unless the user asks. (`exceljs` legitimately came back for Depreciation.) **The OCR Extract module added 2026-08-01 is not that module returning** — different engine (server-side PaddleOCR, not in-browser Tesseract), general-purpose text extraction, no VAT coupling. That removal decision still stands.
- **`enable_mkldnn=False` in `ocr_service/ocr_engine.py` is load-bearing** — with oneDNN on, paddlepaddle 3.3.1 aborts mid-inference (`ConvertPirAttribute2RuntimeAttribute not support`). It is not a stray performance flag; re-test before removing it on a paddlepaddle bump.
- **The OCR service is deliberately standalone** — no client picker, no `clients` row, no document pipeline. That's what keeps it optional: a stopped service breaks one tab, nothing else. Don't make another module depend on it without asking.
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
| `docs/database.md` | On demand | All 17 tables column by column, triggers, the full RLS matrix. |
| `docs/architecture.md` | On demand | Runtime architecture, CDN rationale, auth lifecycle, Drive/Gmail, doc-generation detail. |
| `docs/engines.md` | On demand | The 13 engines in full. |
| `ocr_service/README.md` | On demand | The local OCR service — setup, endpoints, the Python-version constraint (§2). |
| `docs/history/` | Rarely | **Superseded — not current state.** `HANDOFF.md` §4–5 is the only record of the BM/AGM template pipeline. See `docs/history/README.md`. |
| `README.md` | Never (public front page) | Short public description of the project. |
| Memory (`~/.claude/projects/.../memory/`) | Index every session | Cross-session behavioural conventions. Module facts live in `docs/`, not here. |
