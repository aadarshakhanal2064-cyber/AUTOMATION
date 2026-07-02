# Audit Doc Sender — Project Documentation

Internal workflow automation platform for **Shailesh & Associates** and **Dallakoti & Company**, Chartered Accountants / Registered Auditors, Nepal.

> This is a living document. Update it whenever a feature, table, or integration changes — don't let it drift out of sync with the code. See [CLAUDE.md](CLAUDE.md) for the permanent engineering rules that govern how this project is built.

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Current Features](#current-features)
3. [Folder Structure](#folder-structure)
4. [Technology Stack](#technology-stack)
5. [Database Overview](#database-overview)
6. [Authentication Flow](#authentication-flow)
7. [Google Integrations](#google-integrations)
8. [Current Automations](#current-automations)
9. [Future Modules](#future-modules)
10. [Known Limitations](#known-limitations)
11. [Potential Improvements](#potential-improvements)

---

## Project Overview

A browser-based internal tool (max 8 users) that automates day-to-day accounting/audit firm workflows: finding and emailing client documents from Google Drive, generating audit reports, managing a client directory, and (in progress) generating statutory Company Registrar filings for clients in Nepal.

It is a single-page application with no backend server — the browser talks directly to Google APIs (Drive, Gmail) using the signed-in user's own OAuth token, and to Supabase (Postgres) for all application data (clients, logs, users).

**Scale target:** designed to grow from its current ~6 modules to 60-80+ features covering compliance automation, practice management, and AI-assisted workflows. See [Future Modules](#future-modules).

---

## Current Features

| Feature | Status | Location |
|---|---|---|
| Google sign-in with Supabase-based authorization | ✅ Working | `js/auth.js` |
| Send Document — find a client's file in Drive and email it | ✅ Working | `js/sendDocument.js` |
| Generate Report — Independent Auditor's Report builder + print/PDF | ✅ Working | `js/report.js` |
| Client directory — CRUD, search, Excel/CSV import | ✅ Working | `js/clients.js` |
| Send Logs — audit trail of sent documents | ✅ Working | `js/logs.js` |
| Company Registrar — Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset | 🚧 UI built, logic stubbed (`regdComingSoon()`) | `js/registrar.js` |

---

## Folder Structure

```
AUTOMATION AI APP/
├── index.html          # Single-page app shell — all tab panels live here
├── css/
│   └── styles.css       # Entire design system (CSS variables, components)
├── js/
│   ├── config.js         # Constants, global state (window.*), Supabase client init, static config data
│   ├── utils.js           # Shared helpers: escHtml, blobToBase64, showStatus, stringSimilarity
│   ├── tabs.js             # Top-level tab + Company Registrar sub-tab switching
│   ├── auth.js              # Boot sequence, Google sign-in/out, Supabase authorization check
│   ├── clients.js            # Client CRUD, autocomplete, Excel/CSV import wizard
│   ├── logs.js                 # Send-log loading, filtering, rendering
│   ├── sendDocument.js          # Drive search (fuzzy match), Gmail send
│   ├── report.js                  # Audit report builder — client search, template rendering, print
│   └── registrar.js                # Company Registrar stubs (logic not yet implemented)
├── CLAUDE.md            # Permanent engineering rules for this project
└── README.md            # This file
```

**Conventions in use:**
- One file per feature module; functions attach implicitly to `window` (no bundler/modules yet).
- Form field IDs are prefixed per module to avoid collisions across tabs: `ac-` (add client), `st-` (share transfer), `ic-` (increase capital), `cr-` (company registration), `pr-` (PIN reset), `rep-` (report builder).
- Script load order in `index.html` matters: `config.js` → `utils.js` → `tabs.js` → `registrar.js` → `clients.js` → `logs.js` → `sendDocument.js` → `report.js` → `auth.js`.

---

## Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JavaScript | No framework, no bundler, no build step |
| Styling | Hand-written CSS with custom properties | Single stylesheet, consistent design tokens |
| Database | Supabase (hosted Postgres) | Accessed directly from the browser via `@supabase/supabase-js` |
| Auth (identity) | Google Identity Services (GIS) OAuth2 token client | Scopes: `drive.readonly`, `gmail.send`, `email`, `profile` |
| Auth (authorization) | Supabase `app_users` table lookup by email | Role: `admin` \| `staff` |
| File storage | Google Drive (client's own Drive, via OAuth) | No files stored in Supabase |
| Email delivery | Gmail API (raw MIME send) | Sent as the signed-in staff member, not a service account |
| Spreadsheet import | `xlsx` (SheetJS), CDN-loaded | Excel/CSV parsing for client import |
| Hosting | Not yet defined — currently runs as static files | No CI/CD, no environment separation |

All third-party libraries are loaded from public CDNs at runtime with no version pinning or integrity hashes (see [Known Limitations](#known-limitations)).

---

## Database Overview

> Schema below is **inferred from client-side query usage**, not a verified dump from Supabase. Treat as a starting reference and confirm/update against the actual Supabase schema as it evolves.

### `app_users`
| Column | Purpose |
|---|---|
| `email` | Matched against the Google-authenticated user's email |
| `role` | `admin` or `staff` — drives UI visibility (not yet confirmed to be enforced at the RLS level) |

### `clients`
| Column | Purpose |
|---|---|
| `id` | Primary key |
| `name` | Client/entity name (required) |
| `email` | Used for Send Document + report defaults |
| `pan` | Nepal PAN number |
| `phone` | Contact number |
| `entity_type` | Free-text (e.g. "Pvt. Ltd. Company") — reconciled to report profiles via a hardcoded map in `config.js` |
| `business_nature` | Free-text description |
| `address` | Free-text address |

### `send_logs`
| Column | Purpose |
|---|---|
| `id` | Primary key |
| `sent_by` | Staff email who performed the send |
| `client_name`, `client_email` | Snapshot at time of send (not FK'd to `clients` — intentional, keeps the audit trail immutable even if the client record later changes) |
| `doc_type`, `fiscal_year`, `file_name`, `drive_file_id` | What was sent and where it came from |
| `status` | `sent` \| `error` \| `pending` |
| `error_msg` | Populated on failure |
| `sent_at` | Timestamp, used for ordering |

**Not yet implemented:** any table backing the Company Registrar automations (Share Transfer, Increase Capital, etc.) — currently the UI collects input but nothing is persisted.

---

## Authentication Flow

1. On page load, `auth.js` polls for Google Identity Services readiness (up to 5s), then checks `localStorage` for a cached, non-expired access token ("remember me").
2. If no valid cached token: show the sign-in screen. User clicks **Sign in with Google** → `google.accounts.oauth2.initTokenClient` requests an access token with the app's scopes.
3. On success, the token is optionally cached in `localStorage` (if "remember me" is checked) with a ~55-minute expiry.
4. `afterGoogleSignIn()` fetches the user's Google profile (`/oauth2/v3/userinfo`), then looks up that email in Supabase `app_users`.
   - **Not found** → Access Denied screen, sign-out only option.
   - **Found** → `window.currentUser = { email, role }` is set, sidebar/topbar populate, admin-only UI elements are conditionally shown, and `loadClients()` + `loadLogs()` run.
5. Sign-out clears local state, revokes the Google token, and returns to the sign-in screen.

**Authorization model:** role-based UI visibility only, driven entirely by the client-side `app_users` lookup. Actual data-access enforcement depends on Supabase RLS policies, which should be independently verified (see [Known Limitations](#known-limitations)).

---

## Google Integrations

### Drive
- Scope: `drive.readonly`.
- All Drive API calls go through `driveGet()` in `sendDocument.js`, which appends `supportsAllDrives=true&includeItemsFromAllDrives=true` to every request — required so files in Shared Drives aren't invisible to the search.
- Folder resolution walks a fixed path: `My Drive → Audit Data → <fiscal year folder> → Scan → <sign folder or Tax clearance>`, matching against hardcoded name-variant lists to tolerate inconsistent real-world folder naming.
- File matching uses a tiered fuzzy-matching algorithm (exact substring → all-words-present → Levenshtein similarity via `stringSimilarity()` in `utils.js`) to find the right file for a given client name, with a `_warning` flag surfaced to the user on low-confidence matches.

### Gmail
- Scope: `gmail.send`.
- Documents are downloaded from Drive as a blob, base64-encoded, and assembled into a raw multipart MIME message client-side, then sent via `gmail/v1/users/me/messages/send`.
- Emails are sent **as the signed-in staff member**, not a shared service account — recipients see the actual staff Gmail address.

### Not yet integrated
- Google Calendar (for the planned compliance deadline calendar)
- Google Sheets API (currently uses client-side `xlsx` parsing instead)

---

## Current Automations

| Automation | What it does | Status |
|---|---|---|
| **Document Find & Send** | Locates a client's document in Drive by fuzzy name/fiscal-year match and emails it with a default or custom message | Live |
| **Audit Report Generation** | Builds a full Independent Auditor's Report + Notes to Accounts from firm/entity/fiscal-year inputs, with optional Emphasis of Matter / Key Audit Matters sections; print-to-PDF via a generated standalone HTML document | Live |
| **Client Import** | Maps an uploaded Excel/CSV's columns to client fields (with auto-detection by header keyword), previews duplicates/invalid rows, and bulk-inserts | Live |
| **Company Registrar filings** (5 types) | Intended to auto-generate statutory documents for Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset | **Stubbed** — forms exist, submission shows a "coming soon" message |

---

## Future Modules

Full detail lives in the phased roadmap discussed with the project owner. Summary by phase:

- **Phase 1 — Foundation & CRM:** fix known security findings, complete Company Registrar automations, client 360° profile, granular roles, real notifications.
- **Phase 2 — Compliance Automation:** VAT/TDS/income tax tracking, compliance calendar + reminders, invoicing, engagement letters, trial balance/bank reconciliation tools.
- **Phase 3 — Practice Management:** task management, time tracking, client portal, e-signature, approval workflows, internal notifications.
- **Phase 4 — Intelligence & Integrations:** OCR/document auto-classification, IRD/Company Registrar status sync (feasibility TBD), natural-language search, AI-assisted drafting (always human-reviewed before client-facing use), risk scoring.
- **Phase 5 — Scale & Enterprise Hardening:** multi-branch support, BI dashboards, SSO enforcement, disaster recovery, possible framework migration once the vanilla-JS architecture stops scaling comfortably (estimated somewhere in the Phase 2-3 feature range).

---

## Known Limitations

Full architecture review with severities is available in project history; highlights to keep in mind while building:

- **Security:** a client-name script-injection vector exists in `clients.js` (single quotes aren't escaped in inline `onclick` handlers); the raw email construction in `sendDocument.js` has no CRLF/header-injection sanitization on `To`/`Subject`; Supabase RLS enforcement has not been independently verified; the OAuth token is cached in `localStorage` with no CSP in place.
- **Engineering infrastructure:** no version control, no automated tests, no environment separation between dev and production, third-party CDN dependencies are unpinned.
- **Data model:** `entity_type` is free text reconciled via a hand-maintained lookup map rather than a constrained schema; client duplicate detection on import is client-side only.
- **Architecture:** every function is an implicit global (no modules) — collision risk grows with every new feature file added.
- **Feature completeness:** Company Registrar is UI-only; no compliance calendar, task management, or client portal exists yet.

---

## Potential Improvements

- Harden the security findings above before layering on significant new feature volume.
- Introduce version control and a dev/staging/prod split as a baseline requirement for Phase 1.
- Replace inline `onclick` handlers with event delegation to remove the injection class of bug entirely rather than patching instances.
- Generalize the reusable patterns already in the codebase (autocomplete, status boxes, Excel import) into shared components before they get re-implemented a third and fourth time as more modules are added.
- Revisit the vanilla-JS/global-function architecture decision once the feature count approaches the 20-35 range — plan the framework-migration decision proactively rather than reactively.

---

*Keep this document current: update the relevant section whenever a feature ships, a table changes, or a limitation is resolved. If any section grows large enough to be unwieldy, split it into its own file under a `docs/` folder and link it from here — don't let this file balloon past the point of being a useful map.*
