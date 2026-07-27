# Project Handoff — Audit Doc Sender / BM-AGM Minutes Generator

**Generated:** 2026-07-03
**Repository:** `C:\AUTOMATION AI APP` (local), `https://github.com/aadarshakhanal2064-cyber/AUTOMATION` (remote)
**Live site:** `https://aadarshakhanal2064-cyber.github.io/AUTOMATION/`
**Branch:** `main` (only branch in use)
**HEAD at time of writing:** `cbe088f` — local and `origin/main` are in sync, working tree clean.

This document is written to be fully self-contained. A new Claude Code session should be able to read this file alone and continue work with zero prior context.

---

## 1. Project Overview

### What this application is

An internal web tool for **Shailesh & Associates**, a chartered-accountancy/audit firm in Nepal (max 8 users, all staff). It automates document generation and client-management workflows that the firm previously did manually: sending audit documents to clients via Gmail, generating audit reports, managing a client directory (with Excel import), and — the module most of this session's work is on — generating **BM/AGM Minutes** (Board Meeting and Annual General Meeting minutes) as Word documents in **Nepali using Preeti-legacy-font-derived, now Unicode/Mangal-rendered** text.

### Tech stack

- **Frontend:** Static HTML/CSS/vanilla JavaScript. **No build tooling** (no bundler, no npm project at the app level — dependencies are loaded via CDN `<script>` tags directly in `index.html`).
- **Backend:** Supabase (Postgres database + REST API via `supabase-js` client library). No custom backend server.
- **Auth:** Google OAuth (Google Identity Services), scoped to Drive (readonly) and Gmail (send). Not Supabase Auth — Google's own OAuth flow is used directly, with the user's Google account treated as the identity.
- **Hosting/CI:** GitHub Pages, auto-deploys via a "pages build and deployment" GitHub Actions workflow on every push to `main`. A `.nojekyll` file is present (added because this is a plain static site, not a Jekyll site, and Jekyll processing is unnecessary/was implicated in one deployment hiccup).
- **Document generation:** Client-side, in the browser. `PizZip` (unzips/rezips the `.docx` as a ZIP) + `docxtemplater` (fills `{{token}}` placeholders in the Word XML), both loaded from CDN (jsDelivr).
- **Excel import:** `xlsx` (SheetJS), loaded from CDN (cdnjs), full build (`xlsx.full.min.js` — needed because it includes `.ods` OpenDocument Spreadsheet read support, which this firm's data source uses).

### Architecture

- Everything runs client-side in the browser. There is no server-side code at all — Supabase's anon/publishable key is used directly in `js/config.js` (this is intentional for this app's threat model: 8 trusted internal users, RLS presumably enforced Supabase-side, though RLS policies themselves were never inspected/audited in this conversation).
- Page structure: one `index.html` containing all tab panels (hidden/shown via JS, not separate page loads). Tabs: Send Document, Generate Report, Company Registrar (with sub-tabs: Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset, **BM/AGM Minutes**), Clients, Send Logs.
- Each major feature area has its own JS file, loaded in a specific order (see Repository Structure below) — this ordering matters because later files depend on `window.*` globals set up in `js/config.js`.
- State is managed via `window.*` globals (no framework, no state management library) — e.g. `window.clientsList`, `window.currentUser`, `window.bmSelectedIdx`.

### Repository structure

```
C:\AUTOMATION AI APP\
├── .claude/
│   ├── scheduled_tasks.lock       ← harness-managed, git-ignored implicitly (not tracked)
│   └── settings.local.json        ← git-ignored (session-local Claude Code settings)
├── .gitignore
├── .nojekyll                      ← empty file, tells GitHub Pages to skip Jekyll processing
├── CLAUDE.md                      ← permanent project rules (read this — summarized in section 8 below)
├── README.md                      ← project documentation (schema, auth flow, integrations)
├── assets/
│   └── templates/
│       └── bm-agm-minutes.docx    ← the BM/AGM Word template (binary, Unicode/Mangal, tokenized)
├── css/
│   └── styles.css                 ← all styling; reuse existing classes (status-box, card, autocomplete-list, btn-*, etc.)
├── index.html                     ← single HTML file, all tabs/panels, all CDN + local script tags
├── js/
│   ├── auth.js                    ← Google OAuth flow, boot sequence, session persistence
│   ├── bmAgmMinutes.js            ← BM/AGM search, shareholder UI, document generation (THE FILE for this module)
│   ├── clients.js                 ← Client directory CRUD, Excel/ODS import wizard
│   ├── config.js                  ← constants, window.* state init, Supabase client init, IMPORT_FIELDS, REP_FIRMS
│   ├── logs.js                    ← Send Logs tab
│   ├── registrar.js               ← Company Registrar tab shell (non-BM/AGM sub-tabs are still stubs)
│   ├── report.js                  ← Audit Report Generator (pre-existing feature; BM/AGM search pattern was modeled on this file's PAN-search)
│   ├── sendDocument.js            ← Send Document tab (pre-existing; its autocomplete was the original model for keyboard nav)
│   ├── tabs.js                    ← top-level tab switching, switchRegdSub() sub-tab switching
│   └── utils.js                   ← escHtml() and other shared helpers
```

**No `package.json` at the repo root** (confirmed — this is a build-tooling-free static site). Scratchpad/POC scripts used during development (Preeti-to-Unicode converter, template-build pipeline, forensic-comparison scripts) live **outside the repo**, in the Claude Code session's temp scratchpad directory, and were never committed — see Section 4 (BM/AGM Module → Template Architecture) for what those scripts do, since a future session rebuilding the template will need to recreate this tooling.

---

## 2. Current Progress

### Every completed phase, in chronological order, with commit hashes

All commits below are on `main`, in this exact order (oldest first), and **all are pushed to `origin/main`** — nothing is local-only as of this writing.

| # | Commit | Type | Summary |
|---|---|---|---|
| 1 | `22e6ef8` | chore | Initial commit of the Audit Doc Sender platform (pre-existing app, before this session's BM/AGM work) |
| 2 | `da6cab8` | docs | Added `CLAUDE.md` documenting Git workflow rules |
| 3 | `25421dd` | fix | Corrected asset paths in `index.html` (were missing `css/`/`js/` folder prefixes after a reorg — this had been silently breaking the entire app, stuck on "Authenticating session…") |
| 4 | `f3c98b3` | feat | BM/AGM Minutes sub-tab UI shell added to Company Registrar (form fields, no logic yet) |
| 5 | `8d6908e` | feat | 6 new client fields added end-to-end: `registration_number`, `chairman_name`, `shareholder_name`, `authorized_capital`, `issued_capital`, `paid_up_capital` — Add/Edit form, Excel import mapping, save/load logic, directory search |
| 6 | `5fb1d4e` | feat | Registration-number search + client auto-fill in BM/AGM tab (mirrors Report Generator's PAN-search pattern + Send Document's keyboard nav) |
| 7 | `46d93ac` | feat | BM/AGM meeting dates switched from AD date-pickers to B.S. (Bikram Sambat) text inputs; added Time of AGM field |
| 8 | `d304fd1` | feat | The BM/AGM Word template itself: converted from the firm's original **Preeti**-font `.docx` to **Unicode Devanagari (Mangal font)**, with `{{token}}` placeholders inserted at every dynamic field |
| 9 | `b3b9725` | feat | Wired the "Generate & Download" button: fetches the template, fills via docxtemplater, downloads the result. Added Devanagari-digit conversion, B.S.-date-to-Nepali-month-name conversion, fiscal-year-derivation helpers |
| 10 | `8bb334c` | chore | Added `.nojekyll` (unrelated to a specific bug — a good practice for a static-only site; incidentally also re-triggered a stuck GitHub Pages deployment) |
| 11 | `da27ef5` | chore | Added `~$*.docx` to `.gitignore` (Word lock files, noticed one appear while proofreading the template) |
| 12 | `aad0339` | feat | Multiple-shareholders-per-company support: "+ Add Shareholder" UI control, `client_shareholders` DB table (migration — see Section 3), `selectBmClient()` made async to load them |
| 13 | `2104df2` | feat | Excel import wizard: nameless rows following a company row (a real pattern in the firm's actual spreadsheet — one shareholder per row) are now attached as additional shareholders instead of being silently discarded as "no name" bad rows |
| 14 | `e89a77d` | feat | Template's attendee list (उपस्थिति) converted from two fixed lines to a docxtemplater `{{#shareholders}}` paragraph-loop, rendering any number of shareholders |
| 15 | `7fef711` | fix | Fixed a real bug: "Company Reg" (the user's actual spreadsheet header) wasn't recognized by the import auto-mapping keywords, so registration numbers imported as blank for every client |
| 16 | `1fc8364` | feat | Import wizard now backfills blank fields on *already-imported* clients when a duplicate name is re-imported (instead of just skipping), so re-uploading the same file after a mapping fix actually fixes existing records |
| 17 | `fd10753` | feat | Search made digit-agnostic (English digits now match Devanagari-numeral-stored data and vice versa); added PAN as a second searchable field alongside registration number |
| 18 | `967a9f8` | fix | Attendee-numbering correction: chairman is now listed **unnumbered**; shareholders get independent numbering starting at **1** (was previously one continuous 1,2,3... sequence including the chairman) |
| 19 | `72de62b` | fix | Repaired several real Preeti→Unicode conversion gaps found via forensic audit of a real generated document (see Section 5 for full list — रजिष्ट्रार, डिवेञ्चर, several pre-existing template typos, and tokenization gaps for chairman name/fiscal year in one letter) |
| 20 | `a9bb66d` | fix | Rebuilt the template from a **reconfirmed** reference file the user re-uploaded (confirmed near-identical to the original except one added space; picked up automatically) |
| 21 | `2fca346` | fix | Fixed the last 3 words affected by an unmapped Preeti character (`Aयक्ति`→`व्यक्ति`, `Aयय`→`व्यय`, `Aाोधार्थ`→`बोधार्थ`) — confirmed correct by the user rather than guessed |
| 22 | `b13c30d` | feat | Auditor free-text field replaced with a dropdown of 2 pre-configured audit firms (CA and RA — genuinely different professional designations in Nepal with different title phrasing in the document) |
| 23 | `cbe088f` | fix | **Major formatting-fidelity fix** (this session's biggest single piece of work) — see Section 5 for full detail. Template-rebuild pipeline changed from collapsing every paragraph into one run to a formatting-group-preserving rebuild, restoring bold/enlarged inline emphasis on dynamic values that had been silently lost |

**Nothing is currently uncommitted or unpushed.** `git status` shows a clean tree; `git rev-parse main` equals `git rev-parse origin/main`.

---

## 3. Database

**Important caveat: I have never had direct SQL/query access to the live Supabase database in this conversation.** All schema knowledge below comes from (a) migrations I wrote and the user confirmed running, and (b) reading the app's own JS code that queries/inserts against these tables. A new session should **not** assume this is 100% currently accurate without a quick sanity check (e.g., ask the user, or have them paste `\d clients` / `\d client_shareholders` output from the Supabase SQL editor).

### `clients` table — current known schema

Original columns (pre-existing, before this session): `id` (int8, PK), `name`, `email`, `pan`, `phone`, `entity_type`, `business_nature`, `address`.

**New columns added this session** (migration run by the user — confirmed applied):
```sql
ALTER TABLE clients ADD COLUMN registration_number text,
                     ADD COLUMN chairman_name text,
                     ADD COLUMN shareholder_name text,
                     ADD COLUMN authorized_capital text,
                     ADD COLUMN issued_capital text,
                     ADD COLUMN paid_up_capital text;
```
All 6 are nullable `text` columns (deliberately not numeric, to preserve the firm's existing comma-grouped number formatting like `"25,00,000"` as entered).

### `client_shareholders` table — new table, migration run by the user (confirmed applied)

```sql
CREATE TABLE client_shareholders (
  id bigint generated by default as identity primary key,
  client_id bigint not null references clients(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);
```
Purpose: `clients.shareholder_name` holds the *first* shareholder (rendered as attendee #2, chairman being #1/unnumbered). Any *additional* shareholders (a company can have any number) live in this child table, ordered by `sort_order`. Populated either by the "+ Add Shareholder" UI control (Board Meeting/AGM screen) or automatically during Excel import (see commit `2104df2`).

### Migrations already applied
1. The 6-column `clients` ALTER (above) — confirmed run.
2. The `client_shareholders` CREATE TABLE (above) — confirmed run (the app's `selectBmClient()` and `confirmImport()` functions query/insert against it successfully in production, per user testing).

### Migrations still required
**None known to be outstanding.** If a new session needs to add anything, follow the same pattern established in this conversation: generate the SQL, explain exactly where to run it (Supabase Dashboard → SQL Editor), and **do not execute it yourself** — the user runs it and confirms.

---

## 4. BM/AGM Module — Full Detail

### Current implementation summary

The BM/AGM Minutes sub-tab (under Company Registrar) lets a user:
1. Search a client by **registration number or PAN** (digit-agnostic — English or Devanagari numerals both work).
2. Selecting a match auto-fills: company name, PAN, address, chairman name, shareholder name (the primary one), authorized/issued/paid-up capital, and loads any **additional shareholders** from `client_shareholders` into dynamically-added "+ Add Shareholder" rows.
3. User manually enters: Date of Board Meeting (B.S.), Date of AGM (B.S.), Time of AGM, Nepal Fiscal Year (dropdown), **Upcoming Auditor** (dropdown of 2 pre-configured firms), Audit Fee.
4. Clicking **"⚙️ Generate & Download"** fetches the template `.docx`, fills it via docxtemplater, and downloads the result as `BM-AGM {companyName} {fiscalYear}.docx`.

### How document generation works (exact flow, in `js/bmAgmMinutes.js`)

```
generateBmAgmMinutes()
  → validates company selected + both dates entered
  → bmBuildData() — gathers everything from the form into a flat data object
      → bmParseBsDate() for both dates (splits on / - . , validates month 1-12)
      → bmFiscalParts() derives current + next fiscal year in Devanagari
      → bmBuildShareholderList() — numbers chairman as unnumbered, shareholders 1,2,3...
      → looks up the selected BM_AUDIT_FIRMS entry for firm name / auditor name / title
  → fetch(BM_TEMPLATE_URL) — assets/templates/bm-agm-minutes.docx
  → new PizZip(arrayBuffer) → new docxtemplater(zip, {delimiters:{start:'{{',end:'}}'}, paragraphLoop:true, linebreaks:true})
  → doc.render(data)
  → doc.getZip().generate({type:'blob', mimeType:...}) → bmDownloadBlob()
```

### Search logic

`handleBmRegNoSearch(val)`: filters `window.clientsList` (already loaded in memory by `clients.js`'s `loadClients()` — **no extra Supabase query for search itself**) by registration number OR PAN, after normalizing both the typed value and the stored value to plain English digits via `bmToEnglishDigits()`. Requires ≥2 characters typed. Caps results at 8. Keyboard navigation (`handleBmRegNoKey`) mirrors `clients.js`'s `handleClientKey` pattern (arrow up/down, Enter to select, Escape to close).

### Shareholder system

- `bm-shareholderName` (a fixed text input, always present) = the *first* shareholder, attendee #2 in the document (chairman is #1, unnumbered).
- "+ Add Shareholder" button (`bmAddShareholderRow()`) dynamically appends `<div class="bm-shareholder-row">` elements to `#bm-extra-shareholders`, each with a text input + Remove button.
- `bmGetAllShareholderNames()` collects the fixed field + all dynamic rows, filtering blanks, in DOM order.
- `bmBuildShareholderList()` numbers them 1, 2, 3... in Devanagari, for the template's `{{#shareholders}}...{{/shareholders}}` docxtemplater loop.
- On selecting a client (`selectBmClient`), any existing rows are cleared (`bmClearExtraShareholders()`) then repopulated from a `client_shareholders` query for that client, ordered by `sort_order`.

### Template architecture — the most complex part, read carefully

The template file `assets/templates/bm-agm-minutes.docx` is a **pre-built binary asset** — it is NOT generated at runtime by the app. It was built **offline**, once, by a custom Node.js pipeline that lived in the Claude Code scratchpad directory (never committed to the repo — a future session that needs to modify the template's fixed wording or add new tokens will need to **recreate this tooling from scratch**, using the description below).

**Original source:** the firm's real BM/AGM Word template, authored in the legacy **Preeti font** (a pre-Unicode encoding where ASCII characters map to Devanagari glyphs when rendered in that specific font — this is NOT the same as Unicode Devanagari text). The template contains **5 sub-documents** back to back in one file: Board Meeting minutes, AGM minutes, a Section 51 capital report (Company Act requirement), and two letters to the Company Registrar (AGM notice, auditor appointment notice).

**The build pipeline (conceptually — scripts no longer exist on disk, described here for reconstruction):**

1. **`preeti2unicode.js`** — a hand-built character-mapping table converting Preeti ASCII byte sequences to Unicode Devanagari codepoints. Handles: direct consonant/vowel/matra mappings, i-kar reordering (Preeti writes the ि vowel sign *before* its consonant; Unicode requires it *after*), reph reordering (र् needs to move backward to attach to the correct consonant), vowel-pair normalization (ा+े → ो, ा+ै → ौ). **Known gaps found and fixed during this session:** `~`→`ञ्`, `i`→`ष्`, `«`→`्र`, capital `I`→`क्ष्`. **One known-unmapped character remains:** capital `A` — could not be reverse-engineered to a single consistent rule (two observed cases implied one mapping, a third case implied something different); the 3 specific words it broke were fixed via targeted string replacement instead (`Aयक्ति`→`व्यक्ति`, `Aयय`→`व्यय`, `Aाोधार्थ`→`बोधार्थ`) rather than a general character-level fix. **If new Preeti text needs converting in the future and produces a literal capital "A" in the output, that specific word will need the same manual find-and-confirm-with-user treatment.**

2. **`tokenize.js`** — two functions:
   - `normalize(unicodeText)`: fixes known **pre-existing typos in the original template** (not conversion bugs) — e.g. `निर्णाय`→`निर्णय`, `साधारणा`→`साधारण`, `कम्पन्ाी`→`कम्पनी`, `लेखापरिणा`→`लेखापरीक्षण` (this one was a genuinely dropped `क्ष` in the original author's typing, confirmed by comparing against a correctly-spelled occurrence of the same word elsewhere in the same document).
   - `tokenize(unicodeText)`: replaces specific known sample values with `{{tokenName}}` placeholders. This is fragile-by-construction — it matches **exact decoded strings** (e.g. `/तेजराज सेढाई/g` → `{{chairmanName}}`), so if the template's sample data ever changes, these regexes need updating to match the new sample text.

3. **`build_template.js`** — the orchestrator. For each paragraph in the source `document.xml`:
   - Extracts each `<w:r>` run's text AND its verbatim `<w:rPr>` (formatting) XML.
   - **Groups consecutive runs sharing identical formatting** (bold/italic/underline/size/color/font signature) into "formatting groups" — this is the critical fix from commit `cbe088f` (see Section 5 for why).
   - For each group-to-group boundary, verifies independently converting each side produces the same result as converting jointly; if not (a Preeti ligature/reph/vowel-normalization spans the boundary), **automatically shifts 1-3 characters** between the groups to find a safe split point; falls back to merging the two groups only if no shift resolves it (this fallback was validated as never actually needed for this specific document — 0 merge-fallbacks across all 116 real paragraphs).
   - Converts + normalizes + tokenizes **each group's text independently**, then emits **one `<w:r>` per group, reusing that group's exact original `<w:rPr>` XML verbatim** (no formatting is manually reconstructed — always copied).
   - Globally swaps `w:ascii="Preeti"` → `w:ascii="Mangal"` (and `hAnsi`, `cs` variants) in `document.xml`, `styles.xml`, `fontTable.xml`, `settings.xml`.

4. **Two structural post-patches** (also orchestrator-adjacent, ran after `build_template.js`):
   - **Chairman-numbering removal**: strips the literal `"१."` prefix from the (non-bold) run preceding `{{chairmanName}}`, leaving the chairman's own (bold) run completely untouched.
   - **Shareholder-loop restructuring**: converts the single paragraph containing `"२. {{shareholderName}}"` (two runs: a bold numbering run + a non-bold name run — a real distinction, previously incorrectly collapsed) into **3 separate paragraphs**: an opening `{{#shareholders}}` marker (its own paragraph, consumed/removed by docxtemplater's `paragraphLoop`), a content paragraph with the same bold-number/non-bold-name run split (now using `{{num}}` and `{{name}}`), and a closing `{{/shareholders}}` marker paragraph. This exact 3-paragraph shape (marker / content / marker) is **required** for docxtemplater's `paragraphLoop: true` to repeat the *content paragraph* correctly — putting the loop tags inside the same paragraph as the content does NOT work (proven empirically; see Section 5).

**This entire pipeline is validated by a proof-of-concept process** (see Section 5) proving that formatting-group-based (not naive per-character) mapping is reliable for this specific document. A future session touching the template must re-run an equivalent validation before trusting any changes — do not assume the approach generalizes to arbitrarily different documents without re-checking.

### Token system — full list of tokens the template currently uses

`{{companyName}}`, `{{registrationNumber}}`, `{{chairmanName}}`, `{{shareholders}}` (a loop: each item has `{{num}}` and `{{name}}`), `{{auditFirmName}}`, `{{auditorName}}`, `{{auditorTitle}}`, `{{auditFee}}`, `{{authorizedCapital}}`, `{{issuedCapital}}`, `{{paidUpCapital}}`, `{{fiscalYear}}`, `{{nextFiscalYear}}`, `{{bmYear}}`, `{{bmMonthName}}`, `{{bmDay}}`, `{{agmDateFull}}`, `{{agmMonthName}}`, `{{agmDay}}`, `{{agmTime}}`, `{{letterDate}}`. All are supplied by `bmBuildData()` in `js/bmAgmMinutes.js`.

**One known incomplete area:** the "collected amount" figure in the Section 51 report (a third occurrence of the same sample value as issued/paid-up capital) is deliberately left as static sample text (`lakhCounter` in the old build script capped token assignment at the first 2 occurrences) — never made dynamic. Low priority, but worth knowing if the Section 51 report's numbers look wrong to the user.

---

## 5. Problems Solved (Every Major Bug, Root Cause, Final Solution)

### 5.1 Asset paths broken after folder reorg
- **Root cause:** `index.html` referenced `styles.css`/`config.js` etc. without the `css/`/`js/` folder prefixes, after those folders were introduced.
- **Fix:** added the correct prefixes throughout. (Commit `25421dd`.)

### 5.2 Script-injection vulnerability in client name handling (pre-existing, fixed early this session, not in the commit list above since it predates the tracked log I have full detail on — flagged here for completeness: `selectClient()`/`deleteClient()` were interpolating free-text client names into inline `onclick` attributes; `escHtml()` doesn't escape single quotes, so a crafted name could break out of the JS string. Fixed by passing only the numeric ID and looking up the full record from the in-memory `window.clientsList` array — the same safe pattern `editClient()` already used.

### 5.3 "Company Reg" not recognized during Excel import
- **Root cause:** the `IMPORT_FIELDS` keyword list for `registration_number` had entries like "registration number", "regd no" — none of which matched the firm's actual literal header text "Company Reg" as an exact match or substring.
- **Fix:** added "company reg" (and adjacent short forms) to the keyword list. (Commit `7fef711`.)
- **Consequence handled separately:** clients already imported before this fix had blank registration numbers — commit `1fc8364` added backfill-on-duplicate-import logic so re-uploading the same file fixes them without manual editing, without ever overwriting a field that already has a value.

### 5.4 Shareholder attendee list — multiple compounding bugs, fixed across several commits
- Companies can have any number of shareholders, but the schema only had one `shareholder_name` field → solved with the `client_shareholders` child table (5.4a, commit `aad0339`).
- Import wizard was discarding "extra shareholder" rows (nameless rows following a company row in the firm's real spreadsheet) as bad data → fixed to attach them instead (commit `2104df2`).
- Template's attendee list was two fixed lines, couldn't grow → converted to a docxtemplater paragraph-loop (commit `e89a77d`) — **and this loop implementation itself had a real bug found later**: `docxtemplater`'s `paragraphLoop: true` only correctly repeats a paragraph if the `{{#tag}}` and `{{/tag}}` markers are each in their **own dedicated paragraph** — putting them in the same paragraph as the content (as first implemented) causes the content to just get concatenated inline with no paragraph break, silently merging all shareholder names onto one line with no separator. This was proven empirically (not assumed) via a minimal docx-construction test before being trusted. Fixed by restructuring into the 3-paragraph marker/content/marker shape described in Section 4.
- Chairman/shareholder numbering was wrong: originally one continuous 1,2,3,4... sequence *including* the chairman. User corrected the requirement: chairman unnumbered, shareholders independently numbered from 1 (commit `967a9f8`).

### 5.5 Digit-system mismatch in search
- **Root cause:** client data (registration numbers, PAN) is stored with Devanagari numerals, but users naturally type English digits on a keyboard — the search did plain substring matching with no normalization.
- **Fix:** `bmToEnglishDigits()` normalizes both sides before comparing. Also added PAN as a second searchable field. (Commit `fd10753`.)

### 5.6 Major formatting-fidelity bug — the biggest single piece of work in this conversation

This deserves full detail since it's the most architecturally significant fix and the one most likely to need follow-up.

**Symptom reported by the user:** a real generated `.docx` had garbled Nepali in some spots, content that looked like it was "bleeding" from one page to another, and general formatting that didn't match the original template.

**Investigation (forensic, evidence-based, not guessed):**
1. Compared the original template's `document.xml` against a real generated document across ~25 categories (font, size, bold, spacing, tables, borders, alignment, etc.) using targeted regex-based extraction scripts.
2. Found bold-run count dropped from 156 (original) to 58 (generated), and one font size ("30") disappeared entirely.
3. Traced this to the root cause: the original `build_template.js` **collapsed every paragraph's multiple runs into a single run**, using only the *first* run's formatting for the entire paragraph. This was originally done because Word's spell-checker (`<w:proofErr>` markers) fragments text into many runs, and converting Preeti text correctly requires seeing a paragraph's full text in context (a single Preeti glyph sequence can span what Word arbitrarily split into 2+ runs).
4. **Concretely found**: the original template author had **bolded and enlarged company name and chairman name inline**, mid-sentence, as a deliberate style choice (e.g., "...कम्पनीको कार्यालय **[bold, 24pt] अजय अटो डिस्ट्रिब्युटर्स प्रा.लि.** कम्पनीका अध्यक्ष **[bold, 18pt] तेजराज सेढाई**..."). The single-run-collapse approach was silently flattening this to plain, non-bold body text on every dynamic-value insertion throughout the whole document. Confirmed systemic: 14 of 94 multi-run paragraphs had genuinely different (not just spell-checker-fragmented-but-identical) formatting within them.

**User explicitly required a validation gate before implementing** — did not want an assumed fix for something this architecturally complex. This is a good practice this session established: **before implementing a nontrivial pipeline change, prove it with a proof-of-concept against real data first.**

**POC process:**
1. Tested whether converting each of a paragraph's runs *independently* (then concatenating) matches converting the *whole paragraph jointly* (the known-correct baseline). Result: **22 of 184 tested run-boundaries broke** under independent conversion (i-kar/reph/vowel-normalization crossing a boundary) — proving a naive per-run approach is unreliable.
2. Refined to: group consecutive runs by **identical formatting** first, only worry about boundaries *between* distinct formatting groups. Found **26 of 27 real formatting transitions in the whole document were already safe**; exactly 1 was not (a bold auditor-name run transitioning to normal text, where a reph marker for "लाई" sat right at the boundary).
3. Tested whether a small **boundary shift** (moving 1-3 characters between the two groups) could resolve the one unsafe case — it did, on the first try.
4. Validated the **complete algorithm** (group by formatting → verify boundary safety → auto-shift → merge as absolute last resort) against **all 116 real paragraphs in the whole document**: 0 merge-fallbacks needed, and the final text output was **byte-identical** to the prior (known-correct) single-run pipeline.
5. Also validated that `tokenize()`/`normalize()` can be safely run **per formatting group** independently (not just the raw conversion) — 0 mismatches across all 116 paragraphs, confirming no token's matched text spans a formatting-group boundary in this document.

**Implementation:** rewrote `build_template.js`'s paragraph-rebuild logic per the validated algorithm. Updated the two structural post-patches (chairman-numbering, shareholder-loop) to work against the new multi-run paragraph structure.

**A real XML-corruption bug was found and fixed during verification, not before shipping:** the updated shareholder-loop patch left 2 `<w:r>` tags unclosed, because the patch's "before" text now matched complete runs (including their own closing `</w:r>`), but the replacement text didn't add a corresponding closing tag back. **This was caught by a strict full-document XML tag-nesting check** (a hand-written scanner verifying every open tag has a matching, correctly-ordered close tag across the entire document — not just spot-checking), not by visual inspection. Fixed, then reverified: 0 nesting errors across 4,000+ scanned tags, confirmed both before and after a real `docxtemplater` render.

**Final verification performed (all passed):**
- Forensic re-comparison against the original template: every remaining count-level difference (bold run count, underline count, one "missing" font size) was individually traced and proven harmless (either a genuinely empty/invisible Word artifact run being correctly excluded, or spell-checker-fragmented-but-identically-formatted runs being correctly merged with zero visual effect — bold *character coverage* was actually higher in the generated doc, 632 vs 573, since real substituted names are often longer than the original sample placeholders).
- `docxtemplater` (a real, independent OOXML-consuming library) loads and renders the rebuilt template without error.
- 0 unresolved `{{tokens}}` in generated output.
- 0 XML nesting errors, checked via strict tag-stack validation, both on the unrendered template and on a real rendered output.
- The real app itself (not just Node scripts) was used to generate a document end-to-end successfully.

**Explicitly NOT verified — a known limitation, stated honestly to the user, not glossed over:** **Microsoft Word and LibreOffice are both unavailable in this development environment** (confirmed via `which`/`where.exe` checks, no installation found). Therefore **true visual rendering has never been directly confirmed** — all verification above is structural/XML-level. The user was told this explicitly and advised to open a real generated document in Word themselves as the final check. **As of the last message in this conversation, the user had not yet reported back on that visual check.**

---

## 6. Things Intentionally Left Unchanged

- **Preeti → Mangal font swap** is intentional (an explicit user decision, "Path B" from an earlier design discussion): the firm's client data is stored in Unicode Nepali already, so converting the *template* to Unicode (rather than converting Unicode data to Preeti at generation time) avoids per-document conversion risk. Do not "fix" this back to Preeti.
- **Excel import preview table** does not show all 13 possible fields as columns (only a curated subset: tag, name, entity_type, email, pan, phone, shareholders) — this matches an existing precedent (business_nature/address weren't shown either, before this session's changes) and was a deliberate choice to avoid an unwieldy wide table, not an oversight.
- **The Clients directory table** does not show the 6 new statutory fields as columns either — same reasoning, deliberate, not an oversight. Editing a client still shows/edits them.
- **Autocomplete is implemented three separate times** (`clients.js`, `report.js`, `bmAgmMinutes.js`) rather than as one shared component. This was an **explicit user instruction early in this session**: "Do NOT refactor the existing autocomplete into utils.js during this feature. Reuse the existing Audit Report Generator autocomplete implementation for now. We can refactor into a shared component later as a dedicated task." **Do not consolidate these without the user explicitly asking for that as its own task.**
- **The "collected amount" figure** in the Section 51 report is left as static sample text, not tokenized (see Section 4, Token System).
- **CDN dependencies have no version pinning beyond the exact URL already used, and no integrity hashes** — a known, pre-existing architectural gap, never addressed in this session (out of scope for everything worked on).

---

## 7. Known Issues

1. **Visual rendering of the reformatted template has not been directly confirmed** (no Word/LibreOffice available in this dev environment). This is the single most important open item — see Section 9.
2. **Capital letter `A` in the Preeti source has no general character mapping** — 3 specific words it broke were fixed via targeted string replacement, confirmed correct by the user. If new/different Preeti text is converted in the future (e.g., editing the template further, or converting a *different* Preeti document with this same tooling) and a literal capital "A" appears in the Unicode output, treat it the same way: trace to source, propose candidates, get user confirmation — do not guess a general mapping rule from limited evidence (this was tried and shown unreliable — see Section 5.6's POC and the earlier attempt in this conversation).
3. **The Section 51 "collected amount" figure is not tokenized** (static sample text) — low priority, but a real gap if the user ever notices the number doesn't match the actual company.
4. **No Excel *export* feature exists** in the Clients module (confirmed via grep, not assumed) — only import. If a future task asks for export, it's genuinely new, not a bug.
5. **RLS policies on the Supabase tables were never inspected or audited in this conversation.** Given the anon/publishable key is used client-side, this is worth a security review at some point, though out of scope for everything done here.
6. **The template-build tooling (Preeti converter, tokenizer, build orchestrator, forensic-comparison scripts) lives only in the ephemeral Claude Code scratchpad directory and was never committed to the repository.** If the template ever needs to be rebuilt or modified again, this tooling must be recreated from the description in Section 4 — there is no committed source for it. **This is worth fixing as a follow-up**: consider committing a `tools/` or `scripts/` directory with this pipeline so it's reproducible without re-deriving it from a conversation transcript.

## Technical debt
- Three duplicate autocomplete implementations (see Section 6 — deliberately deferred, not forgotten).
- No version pinning/integrity hashes on CDN dependencies.
- No automated test suite of any kind — all verification in this conversation was done via ad hoc Node scripts and a headless browser preview tool, run manually each time. Consider whether a lightweight regression-test script (even just a Node script that renders the template with known inputs and asserts on the output) would be worth committing, given how many subtle regressions were caught by manual, one-off verification in this session.
- Template-build pipeline not committed (see Known Issue #6).

## Future improvements (not yet requested by the user, just observed as opportunities)
- Consolidate the three autocomplete implementations into one shared component (explicitly deferred by the user, not rejected).
- Make the Section 51 "collected amount" dynamic.
- Consider adding a proper multi-shareholder UI affordance for editing an *existing* client's shareholder list directly from the Clients tab (currently only reachable via the BM/AGM screen's "+ Add Shareholder", not from Edit Client).

---

## 8. Coding Standards

### Existing architecture rules (from `CLAUDE.md` — read the full file, this is a condensed version)

1. **Never duplicate code** — reuse existing logic (autocomplete, status messages, table rendering) rather than writing parallel versions.
2. **Always check `js/utils.js` and existing UI patterns** (`status-box`, `card`, autocomplete list) before building something new.
3. **One concern per file** — don't mix UI + API + business logic in one file.
4. **Never create unnecessary files** — only add one for a genuinely new, distinct concern.
5. **Flag files that are getting too large** rather than letting them grow silently.
6. **Prefer reusable helper functions** over copy-paste, even for small snippets.
7. **No comments explaining *what* code does** — only *why*, when genuinely non-obvious. Never multi-paragraph doc comments.
8. **Reuse existing CSS variables/components/interaction patterns** from `css/styles.css`.
9. **Never break existing features** — check every change against existing functionality.
10. **Think about scalability** — this app is expected to grow to 60-80+ features.
11. **Every feature must feel native to the project** — consistent naming/structure/UI language.
12. **Self-review every feature for bugs/improvements before presenting it as done.**

### Git workflow (also from `CLAUDE.md` — these are hard rules, not suggestions)

1. **Feature → Review → Commit → Push**, strictly in that order. Never push unreviewed or uncommitted work.
2. **One logical change per commit.** Split unrelated changes into separate commits, even mid-conversation.
3. **Never rewrite history** (`--amend`, `rebase`, force-push on already-pushed commits) without explicit approval each time.
4. **Never push without explicit approval, every time** — committing locally is fine proactively; `git push` always needs a fresh go-ahead, no standing permission.

### Things that must never be changed without the user's explicit go-ahead

- The autocomplete-triplication (see Section 6) — do not consolidate unprompted.
- The Preeti→Mangal font decision — do not revert to Preeti.
- Do not `git push` without asking first, every single time, regardless of how many times it's been approved before.
- Do not rewrite git history.
- Do not execute SQL migrations yourself — generate them, explain where to run them, wait for the user to confirm they ran it.

---

## 9. Current State — Exactly Where This Session Left Off

**What I was working on immediately before context ran out:** the formatting-fidelity fix (commit `cbe088f`) had just been committed **and pushed**, with GitHub Pages deployment confirmed successful (verified via the GitHub API, not assumed). I told the user to hard-refresh the live site, generate a real BM/AGM document, and **open it in Word themselves** — the one verification step I could not do in this sandboxed environment (no Word/LibreOffice installed here).

**What should be done next, in order:**

1. **Wait for / ask the user for the outcome of their manual Word-open check.** This is the single most important next step. Specifically ask:
   - Does the document open without a "Word found unreadable content" repair-mode warning?
   - Does the company name and chairman name render **bold and visibly larger** inline within sentences (not plain body text)?
   - Do shareholder entries show the number in bold but the name itself in regular (non-bold) weight?
   - Does anything else look visually wrong — page breaks, spacing, alignment?
2. **If the user reports a problem:** don't guess — ask for the specific generated `.docx` file (they've done this before in this conversation, e.g. uploading `"C:\CHROME DOWNLOADS\BM-AGM ... .docx"`), unzip it, and do the same kind of forensic, evidence-based investigation documented in Section 5.6 rather than a speculative fix.
3. **If the user confirms everything looks correct:** the BM/AGM module is functionally complete for its originally-scoped requirements (Phases 1 through the "Phase 6" formatting-correction phase). At that point, worth proactively asking the user whether they want to:
   - Address any of the "Known Issues" in Section 7 (especially #6 — committing the template-build tooling so it's reproducible).
   - Move on to a different module/feature entirely.
4. **Nothing is currently blocking further work** — the repo is clean, pushed, and deployed.

### Important warnings for whoever picks this up

- **Do not assume you can render `.docx` to an image/PDF in this environment.** It has been confirmed multiple times across this conversation that neither LibreOffice nor Word is installed. Any verification must be structural (XML-level) unless the user explicitly provides visual confirmation, or the environment changes.
- **Do not touch the database schema without generating a migration and having the user run it themselves.** This has been the pattern every single time in this conversation, and the user has been consistent about it.
- **Do not push without asking, every time**, even though pushing has happened many times already in this conversation — there is no standing approval.
- **If you need to modify the BM/AGM template again** (new tokens, wording changes, additional dynamic fields), you must recreate the build pipeline described in Section 4 from scratch (it's not in the repo) — and you must re-run an equivalent proof-of-concept validation (Section 5.6) before trusting the output, especially if the change involves run-splitting/formatting-group logic. Do not skip this step even if it feels like it should "obviously" still work — it was empirically proven necessary once already in this exact codebase.
- **The two audit firms in the dropdown (`BM_AUDIT_FIRMS` in `js/bmAgmMinutes.js`) are hardcoded**, not database-driven. If the user asks to add a third firm, or make these configurable, that's a small, well-scoped follow-up task, not a bug.

---

## 10. First Prompt for the New Session

Paste exactly this into a new Claude Code conversation:

```
Read HANDOFF.md in the project root (C:\AUTOMATION AI APP) — it's a complete,
self-contained handoff document for this project (an internal document-
automation tool for a Nepali audit firm, currently focused on a BM/AGM Minutes
generator module). Read the whole file before doing anything else.

After reading it, here's where things stand: the last piece of work (commit
cbe088f, already pushed, GitHub Pages deployment confirmed live) was a
significant formatting-fidelity fix to the BM/AGM Word template's generation
pipeline. I asked the user (me) to generate a real document through the live
app and open it in Microsoft Word to do a visual check that couldn't be done
in the previous session's sandboxed environment (no Word/LibreOffice
available there).

Start by asking me directly: did I check the generated document in Word, and
if so, what did I see? Specifically ask about (a) whether Word opened it
without a repair-mode warning, (b) whether the company name and chairman
name render bold and visibly enlarged inline within sentences, and (c)
whether shareholder entries show a bold number but a non-bold name.

Depending on my answer, either help me fix whatever's wrong (following the
evidence-based, no-guessing investigation approach documented in section
5.6 of HANDOFF.md - forensic comparison first, proof-of-concept before any
nontrivial pipeline change, never claim something works without actually
verifying it), or move on to whatever I ask for next.

Follow every rule in CLAUDE.md and in HANDOFF.md section 8/9 exactly -
especially: never push to GitHub without asking me first every single time,
never execute SQL migrations yourself (generate them and tell me where to
run them), and don't consolidate the three duplicate autocomplete
implementations unless I explicitly ask for that as its own task.
```
