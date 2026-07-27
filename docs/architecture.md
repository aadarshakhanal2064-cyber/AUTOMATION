# Architecture, Auth & Document Generation — deep reference

> Loaded on demand, not in every session. **CLAUDE.md §2, §7 and §8** carry the
> always-loaded summaries (stack in one line, script load order, the fiscal-year format
> table, which generation path to pick); this file holds the detail behind them.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

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


---

## Security hardening — resolved 2026-07-16

Recorded here because it is the changelog entry behind CLAUDE.md §13's current
posture, not a live rule:

> **Resolved 2026-07-16** (security hardening pass): RLS enabled on all tables
> (§6.6); `supabase-js` pinned + SRI on all CDN deps; CSP + security headers
> added; email header-injection + Drive-query sanitization added;
> `_tmp_click_test.pdf` removed from the repo.
