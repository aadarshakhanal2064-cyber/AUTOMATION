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

**30-second map:** `index.html` is the whole UI shell (all panels, all script tags). `js/config.js` holds constants/state/Supabase init. `js/core/` holds 9 reusable engines — check there before writing anything new. Each feature is one file in `js/`. All styling is `css/styles.css`. Word/Excel templates live in `assets/templates/`. Database is Supabase (10 tables, §6).

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
CDN libraries → config.js → utils.js → js/core/* (9 engines) → tabs.js
→ feature modules (dashboard, registrar, clients, logs, vatCompliance,
  billing, sendDocument, report, notesToAccounts, depreciation,
  bmAgmMinutes, auditorChange) → auth.js (LAST — triggers the boot sequence)
```

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
│   ├── core/                # 9 reusable engines — see §4
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

**Adding a new tab/sub-module:** create `js/<module>.js`, call `ModuleRegistry.register()` from it, add the panel + nav button to `index.html`, add the `<script>` tag in load order, prefix all element IDs (§10.2). No edits to `tabs.js`.

---

## 5. Feature Modules

Main navigation tabs: Dashboard, VAT Compliance, Billing, Send Document, Audit Report, Notes to Accounts, Depreciation, Clients, Send Logs — plus **Company Registrar**, opened from a topbar dropdown (Xero-style menu, not sidebar), containing its own sub-modules.

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
CRUD + search over `clients` (Tabulator via TableEngine), plus the Excel/CSV/ODS import wizard: header auto-mapping by keyword (`IMPORT_FIELDS` in config.js), duplicate/invalid preview, **backfill-on-duplicate** (re-importing fills blank fields on existing clients, never overwrites non-blank), and nameless-rows-after-a-company-row attach as extra shareholders (`client_shareholders`). Statutory fields (registration number, chairman, shareholder, three capitals) are deliberately not table columns but are editable per client.

### 5.8 Depreciation (`js/depreciation.js`, `dep-` prefix)
Income Tax pool-depreciation schedule (Nepal). Editable grid of 7 statutory pools (Building 5%, Furniture 25%, Vehicles 20%, Plant 15% — reducing balance; Software & Leasehold — 5-year straight line; Land — none). User enters opening value, three timing-bucketed additions, and disposals; the module live-computes Total Value, Depreciation Base, Depreciation, and closing WDV. Empty pools render as "–" (accounting format). Formulas: `Total = Opening + ΣAdditions − Disposal`; `Base = Opening + Add₁ − Disposal + Add₂·⅔ + Add₃·⅓`; `Depreciation = Base×rate` (WDV) or `Base÷years` (SLM); `WDV = Total − Depreciation`. Features: **Import from Excel/ODS** (matches pools by particular text, any row order), **Addition-details helper** (itemize purchases by B.S. date → auto-bucketed into the three columns: Shrawan–Poush full, Magh–Chaitra ⅔, Baishakh–Ashadh ⅓), and **Generate Excel** via ExcelJS reproducing the template (merged headers, borders, formulas, accounting number format). Pool rates are statutory constants in `DEP_POOLS`, not user-editable. The source sheet's Land Total-Value formula pointed at the Leasehold row (a real bug); the generator writes it correctly.

### 5.9 Send Logs (`js/logs.js`)
Audit trail of sent documents from `send_logs`. Staff see only their own sends; admins see all with a staff filter. Client name/email are snapshots, intentionally not FK'd.

### 5.10 Company Registrar (topbar dropdown → `regd` group)

**a) BM/AGM Minutes (`js/bmAgmMinutes.js`, `bm-` prefix)** — generates Board Meeting + AGM minutes (plus Section 51 report and two registrar letters, all in one document) as a Word file in Nepali. Fills `assets/templates/bm-agm-minutes.docx` via DocumentEngine/docxtemplater (`{{token}}` delimiters, `paragraphLoop` for the shareholder list — loop markers must each be their own paragraph). Client search by registration number/PAN (digit-agnostic); shareholders = `clients.shareholder_name` + `client_shareholders` rows; chairman unnumbered, shareholders numbered from १. Live docx preview, autosave draft, completion indicator, zoom, print (one page per sub-document via `transform:scale`, not zoom). The template's history (Preeti→Unicode conversion, formatting-group rebuild pipeline) is in `HANDOFF.md` §4–5 — **the build tooling was never committed**; rebuilding the template requires recreating it from that description and re-validating.

**b) Auditor Change (`js/auditorChange.js`, `ac-` prefix — shares the prefix with Add Client, §10.2)** — two documents from one shared form: Board Resolution + registrar notification letter (`auditor-change-*.docx` templates). Same DocumentEngine architecture as BM/AGM, same UI pattern as the Report Builder (Edit/Preview, per-document preview tabs); B.S. date validation on blur; known-firm quick-fill picker (`attachFirmPicker` over `REGD_AUDIT_FIRMS`). No autosave/inline-edit yet (deliberate trim).

**c) Stubs** — Share Transfer, Increase Capital, Company Registration, PIN Reset: UI built, logic is `regdComingSoon()` in `js/registrar.js`. Real remaining product surface.

> **Removed module — VAT Return OCR** (removed 2026-07-14 by user decision; the firm won't use it). It read scanned IRD VAT Return PDFs via digit-only OCR and filled the firm's Excel workbook. The removal took with it `js/vatReturn.js`, four engines whose only consumer it was (`ocrEngine`, `pdfEngine`, `visionEngine`, `validationEngine`), `DocumentEngine.workbookToBlob`, the `pdfjs-dist`/`tesseract.js`/`exceljs` CDN tags, and `assets/templates/vat-detail.xlsx`. (`exceljs` was re-added shortly after for the Depreciation module — §5.8 — but the four engines and the OCR/PDF CDN libraries stay gone.) All of it is recoverable from git history (last commit containing it: `ad0e9f2`); its engineering record lives in `HANDOFF_VAT.md` / `HANDOFF_2026-07-05.md`. Historical `audit_log` rows with `module: 'vatReturn'` remain valid; `vat_filings.status` keeps `ocr_processing` as a manual status.

---

## 6. Database (Supabase Postgres)

Project: `rennqzmwyhkdsizvlqwd.supabase.co`. Schema below **verified live on 2026-07-14** via the Supabase MCP — re-verify before schema-dependent work rather than trusting this snapshot.

### 6.1 Tables (10)

| Table | Purpose / key columns |
|---|---|
| `app_users` | Authorization list. `email` (unique), `role` (`admin`/`staff`, default staff). Checked after Google sign-in; not in the list = Access Denied. |
| `clients` | Directory (~309 rows). `name`, `email`, `pan`, `phone`, `address`, `entity_type` (free text), `business_nature`, `registration_number`, `chairman_name`, `shareholder_name`, `authorized_capital`/`issued_capital`/`paid_up_capital` (**text, not numeric** — preserves `"25,00,000"` formatting), `vat_status` (`active`/`inactive`/`not_registered`, CHECK-constrained). |
| `client_shareholders` | Extra shareholders beyond `clients.shareholder_name`. `client_id` (FK, cascade delete), `name`, `sort_order`. |
| `send_logs` | Send Document audit trail. Client name/email snapshotted (not FK'd — immutable trail). `status` `sent`/`error`/`pending`. |
| `audit_log` | App-wide event log (AuditLog engine). `event_type`, `module`, `status`, `user_email`, `client_name`, `record_ref` (bigint), `detail` (jsonb). Feeds the Dashboard. History starts 2026-07-08 (table created after the engine). |
| `vat_filings` | One row per client per month, lazy (§5.2). Unique on `(client_id, fiscal_year, month)`; `month` 1–12 CHECK; `status` CHECK-constrained to the nine §5.2 values; `assigned_staff_id` FK → app_users; `validation_summary` jsonb. |
| `firm_bank_details` | PK `firm_key`. `invoice_prefix` (NOT NULL — see upsert gotcha §5.3), bank fields, `qr_image`. One row per firm. |
| `invoices` | `invoice_number` (unique, trigger-assigned), `client_id`/`firm_key` FKs, `status` CHECK (`draft`/`sent`/`partially_paid`/`paid`/`void`), amounts numeric, `tax_rate` default 0.13. |
| `invoice_items` | Line items: `description`, `quantity`, `rate`, `amount`, `sort_order`. |
| `invoice_payments` | `amount > 0` CHECK, `method` CHECK (`cash`/`bank_transfer`/`qr`/`cheque`/`other`). |

### 6.2 Trigger-owned logic (never replicate in JS)

- `sync_invoice_payment_totals()` — recomputes `invoices.amount_paid`/`status` from `invoice_payments` on every insert/update/delete.
- `set_invoice_number` — AFTER INSERT, assigns `{SA|DC}-{id padded}`; re-fetch the row after insert.

### 6.3 Data conventions

- Capital amounts are formatted **text**, deliberately.
- Registration numbers/PANs may be stored in **Devanagari numerals** — normalize with `NepaliLocale.toEnglishDigits` before comparing.
- Log tables snapshot client data rather than FK it.
- Lazy row creation for `vat_filings` (never pre-create).

### 6.4 Query rules

Supabase/PostgREST caps a single select at **1000 rows** — any query that can grow past that must use `sbFetchAll()` (`utils.js`) with a stable `.order()`. `clients` is at ~309 and growing.

### 6.5 Migration workflow

Show the SQL (annotated migration + rollback script as files under `db/`) → apply via the Supabase MCP (`apply_migration`) → verify → commit the SQL files with the change (§1 rule 2).

### 6.6 RLS — ENABLED everywhere (since 2026-07-16)

All 10 tables have RLS **enabled** (migration `db/2026-07-16_rls_lockdown.sql`; rollback script alongside it). The permission model:

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

### 9.4 Excel via ExcelJS (Depreciation)
`js/depreciation.js` builds the workbook programmatically with ExcelJS (no template asset) — merged headers, thin borders, accounting number format (`#,##0.00;(#,##0.00);"–"`), live formulas, and percent/`" yrs"` rate formats. There is no shared Excel engine (the removed VAT Return module had one, `DocumentEngine.workbookToBlob`); Depreciation is the only Excel generator, so it owns its layout. Excel/ODS *import* uses SheetJS (`XLSX.read`, read-only). If a second Excel-generating module appears, extract a shared workbook→Blob helper then (the same "generalize after two consumers" rule the engines followed).

### 9.5 Nepali locale
All B.S. date / Devanagari digit / fiscal-year / lakh-crore formatting goes through `NepaliLocale`. **Fiscal-year string formats are deliberately inconsistent per module** — normalize at boundaries, never unify without asking:

| Format | Used by |
|---|---|
| `2081-82` (dash) | Send Document, Report Builder, Notes, Billing |
| `2083/84` (slash) | VAT Compliance (canonical: `vatcFyLabel`) |
| `2083.084` (dot) | Drive year folders (Send Document folder walk) |

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
| `dep-` | Depreciation | | | |
| `ac-` | **BOTH** Auditor Change and Add Client (historical overlap — no live collision, but check both before adding any `ac-*` id) | | `dash-` | Dashboard |

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

- **RLS is the server-side enforcement layer** (§6.6) — enabled on all 10 tables, membership-checked. The publishable key alone now grants nothing. Anon and non-member JWTs get zero rows. This is the single most important control; don't disable it.
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
| 4 Company Registrar stubs (Share Transfer, Increase Capital, Company Registration, PIN Reset) | Feature gap | UI-only, `regdComingSoon()`. |
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
- **Dashboard is not the default landing tab** — Send Document stays default.
- **Only the Clients table uses Tabulator** — other tables were deliberately not migrated.
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
| `HANDOFF_VAT.md` (2026-07-04) | Historical | VAT Return OCR engineering record (module removed 2026-07-14 — §5.9). |
| `HANDOFF_2026-07-05.md` | Historical | The engine-layer rebuild rationale and per-engine migration notes (four of those engines were removed with the VAT Return module). |
| Memory (`~/.claude/projects/.../memory/`) | Live | Cross-session conventions for VAT Compliance and Billing (mirrored into §5.2/§5.3). |
