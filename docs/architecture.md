# Architecture, Auth & Document Generation — deep reference

> Loaded on demand, not in every session. **CLAUDE.md §2, §7 and §8** carry the
> always-loaded summaries (stack in one line, script load order, the fiscal-year format
> table, which generation path to pick); this file holds the detail behind them.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

## 2. Tech Stack & Architecture

### 2.1 Runtime architecture

Everything runs client-side in the browser; there is **no server-side code**. The browser talks to:

- **Supabase Postgres** via `supabase-js` with the publishable key in `config.js`, and **Supabase Auth** (email + password) for sign-in. RLS is enabled on every table (§6).

That is the entire list. Google Drive/Gmail were removed on 2026-08-01 with Google auth (§7), and the optional local OCR service went on 2026-08-18 with the OCR Extract module, so **Supabase is now the only external service the app talks to** — and the only one the CSP lets it talk to (§8).

State is `window.*` globals (`window.clientsList`, `window.currentUser`, …) — no modules, no state library. Functions attach implicitly to `window`.

### 2.2 Script load order (load-bearing)

Later files depend on globals set up by earlier ones. Order in `index.html`:

```
CDN libraries → config.js → utils.js → js/core/* (12 engines) → tabs.js
→ feature modules (dashboard, registrar, clients, vatCompliance,
  billing, report, notesToAccounts, depreciation,
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

**Every** CDN dep carries Subresource Integrity (`sha384`) + `crossorigin` (added 2026-07-16). The two Google loaders were the only exceptions — dynamic, therefore unpinnable — and both went with Google auth on 2026-08-01, so there is no longer an un-SRI'd script tag in the app. When bumping any pinned version, recompute its hash (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) and update the tag, or the file won't load.

### 2.4 Hosting & deployment

- **Remote:** `https://github.com/aadarshakhanal2064-cyber/AUTOMATION` — branch `main` only.
- **Live site:** `https://aadarshakhanal2064-cyber.github.io/AUTOMATION/` — GitHub Pages auto-deploys on every push to `main` ("pages build and deployment" workflow). `.nojekyll` is present and required.
- **Cache-busting:** every local `<script>`/`<link>` carries `?v=YYYYMMDDHHMM`. Bump it when shipping front-end changes.

### 2.5 Local development

- Dev server: `.claude/launch.json` defines `static-site` (`npx serve -l 5173 .`). Use the browser-preview tooling, never Bash, to run it.
- **Sign-in needs a real Supabase account.** To test anything past the login screen, bypass the auth wall via direct DOM manipulation — set `window.currentUser = {email, role}`, hide `#loading-screen`/`#auth-section-wrap`, show `#app-section`/`#topbar`/`#sidebar`, and seed `window.clientsList` by hand (RLS returns nothing without a session).
- **Microsoft Word / LibreOffice are not installed** in the dev environment. Generated `.docx` verification is structural (XML-level) only; the user does the final visual check in Word.

## 7. Authentication & Authorization

**Supabase Auth, email + password.** Google OAuth was removed on 2026-08-01; see the end of this section for what went with it.

1. Sign-in screen → `signIn()` reads `#auth-email`/`#auth-password` and calls `window.sb.auth.signInWithPassword({ email, password })`. The submit button disables while in flight and re-enables only on failure; the error text lands in `#auth-status`. There is no redirect — the whole flow is one XHR.
2. `window.sb.auth.onAuthStateChange()` fires (`INITIAL_SESSION` / `SIGNED_IN` / `SIGNED_OUT`) and routes into `afterSupabaseSignIn(session)`. `INITIAL_SESSION` is what restores a session across a page reload. `SIGNED_OUT` is skipped while the Access Denied screen is up, because that sign-out is the app's own.
3. `afterSupabaseSignIn()` looks the email up in `app_users` with **`.ilike()`** — `private.jwt_email()` lowercases before matching, so `.eq()` would reject a mixed-case address that RLS accepts. Not found → Access Denied **and** `sb.auth.signOut()`, so a rejected user keeps no session. Found → `window.currentUser = {email, role}`, admin-only UI shown conditionally, then `loadClients()` + `loadDashboard()` + `loadSidebarStorageUsage()`.
4. Sign-out clears `currentUser`/`clientsList`, calls `sb.auth.signOut()`, resets the form and re-enables the submit button.

**Account management is manual and admin-only, in the Supabase dashboard:**

- Authentication → Providers → Email: enabled, with **"Allow new users to sign up" OFF**. Left on, anyone could self-register; RLS would give them no rows, but they'd still hold a valid session.
- Authentication → Users → Add user, with "Auto Confirm User" so no confirmation mail is needed.
- **Adding a staff member takes two steps** — an `auth.users` entry *and* an `app_users` row. One without the other means they authenticate and are then denied.
- No self-serve password reset: the firm has a handful of users and Supabase's built-in SMTP is rate-limited to a few mails an hour, so an admin resets it instead. The login screen says so.

**Authentication is identity — RLS is what gates data** (§6). `role` drives UI visibility only (admin-only buttons, bank-detail editing) and protects nothing on its own.

### What the Google removal took with it (2026-08-01)

`signInWithOAuth` → `signInWithPassword`; `session.provider_token`; the GIS silent-renewal loop (`handleTokenResponse`/`ensureTokenClient`/`scheduleTokenRenewal`/`renewTokenSilently`); `window.accessToken`, `window.tokenClient`, `window.CLIENT_ID`, `SCOPES`; the "Developer Setup" modal and its `gClientId` localStorage key; the `Integrations` engine (`js/core/integrations.js`, deleted) and `blobToBase64`; both Google script tags; and every Google origin from the CSP's `script-src`, `connect-src` and `frame-src`.

**No database migration was required.** RLS gates on `auth.jwt() ->> 'email'` via `private.jwt_email()`, which is provider-independent — an email/password JWT carries `email` exactly as a Google one did. That is the single fact that made the swap cheap, and it is worth remembering before anyone proposes changing provider again.

The trigger was removing Send Document, which was the only Drive consumer. Billing's "Email Invoice" button was the last Gmail caller; it now downloads the PDF for the staff member to attach themselves (`billingDownloadInvoice`, which already existed).

---

## 8. External integrations

**None.** Supabase is the only remote service the app calls, and since 2026-08-18 it is the only process of any kind — the OCR service that used to sit on loopback went with its module, and with it the project's only server-side code. This is enforced, not just conventional: the CSP's `connect-src` is exactly `'self' https://*.supabase.co`, so adding an integration to a new host means widening it there first or the call is simply blocked.

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
| `2083/84` (slash) | Audit Report Finalization, Audit Checklist, Work Done |
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
