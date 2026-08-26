# Document Builders

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the Audit Report Builder, Notes to Accounts,
> the Audit Engagement Letter and Confirmation Letters.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.4 Send Document — REMOVED 2026-08-01
Deleted by user decision along with the Send Logs viewer (5.10). It searched Google Drive
for a client's document and emailed it via Gmail, and was the app's only Drive consumer.
The `send_logs` table was kept, not dropped — see `docs/database.md`. Removing it is what
made dropping Google OAuth possible; don't restore it without revisiting that.

### 5.5 Audit Report Builder (`js/report.js`, `rep-` namespace)
Full Independent Auditor's Report generator. Client search auto-fills from `clientsList`; `entity_type` free text maps to a report profile via `CLIENT_ENTITY_TO_REP_PROFILE`.
- **Five report types:** Unqualified, Qualified, Disclaimer of Opinion, Adverse, and "Section 57 – Change of Control" (internally `review` — renders the title "Report on the Financial Statement").
- Entity profiles (`REP_ENTITY_PROFILES`): private/public company, proprietorship, partnership, NGO, NPO, cooperative — each with salutation, governing body, act. **Only Private Company cites its act by name** (`citeSpecificAct`); others say "the applicable law".
- Edit/Preview toggle, on-demand render; optional EOM/KAM/Basis sections with inline writing boxes under their checkboxes; cover page; letterhead uses `assets/logo-lockup.png` (Shailesh firm only — no equivalent asset for Dallakoti).
- Exports: **Save as Word** (true OOXML via `htmlDocx.asBlob`) and **Save as PDF** (standalone print window). Print CSS is carefully tuned (orphans/widows, page-break control) — regression-check pagination when touching it.
- **The cover page is the Projection Report's cover** (CA request, 2026-08-02) — navy frame with an offset outline rule, Times/Georgia serif, the rule under the title, the three vertical rules, the report date on the bottom edge. The design lives in `.rep-cover-*` (css/styles.css), mirrored point-for-point from `PJX_PRINT_CSS`'s `.pjp-cover-*`; only the content is remapped (title → "Audit Report", the projection's year-count sub-line → the report-type title, plus an "Audited By" firm block the projection has no counterpart for). **Keep the two in sync** — a change to one without the other is what makes them drift.
- **The fill-in blocks print as ordinary black body text** (fixed 2026-08-02). `.rep-blank-fill` used to be styled grey-italic-on-tint by default and black only on `:focus`, so every filled Emphasis of Matter and every KAM cell rendered washed-out in the preview, the print window, the PDF **and** the Word export — none of which has focus. That reached a client's printed report. The placeholder chrome now belongs to the `:empty` state alone. `repExportHtml()` additionally strips unfilled blocks from every export path, because html-docx-js honours neither `:empty` nor `@media print`; an unfilled KAM table **cell** is only emptied, never removed, since dropping it would collapse the row.
- **Print rules live in one `@media print` block in `css/styles.css`**, not per module: both print builders copy every stylesheet rule into their blob document, so that block is the single definition of how these documents print (black text, `print-color-adjust:exact` so table header bands survive, repeating `<thead>`, black table rules). The builders repeat the two most critical lines inline as a fallback for a failed `cssRules` read.
- **Save to database / Saved reports** (2026-08-02) via the DocumentStore engine → `saved_documents`. A saved report restores its form fields *and* its rendered document, so it can be reprinted verbatim or taken back into the form and re-generated. Re-saving amends the same record; changing client or fiscal year starts a new one.

### 5.6 Notes to Accounts (`js/notesToAccounts.js`, `nta-` namespace)
Significant Accounting Policies & Notes generator. Mirrors report.js 1:1 (same Edit/Preview shape, same two exports, the same print-ready rules and the same Save to database / Saved notes pair — see §5.5). Driven parts: client details, accounting standard (`NTA_ACCOUNTING_STANDARDS`: NAS for MEs / NFRS for SMEs / NAS — `full` wording on first mention, `short` after), depreciation method (SLM/WDV), editable PPE useful-life table (`NTA_PPE_DEFAULTS`), optional Related Party section. The rest is fixed boilerplate policy text.

- **The PPE useful-life table is FILLED FROM the SLM depreciation schedule** (2026-08-17).
  Every class and every life in that table is already stated, per asset, in Depreciation →
  As per Accounting Standard (SLM) — and that schedule is what the depreciation charge in the
  accounts was actually computed on. Typed twice, the two drift, and the note is the document
  the client keeps. `ntaFetchPpeFromSlm()` calls `depSlmFetchUsefulLives()` (see
  `modules/depreciation.md`) and rebuilds the rows from what comes back: one row per class the
  client genuinely holds an asset in, named exactly as the 3.1 PPE note names it.
  - **Runs on client select and on a fiscal-year change**, plus a ⟳ button for re-running it
    after the schedule itself is edited. `ntaApplyState()` assigns programmatically and fires
    no change event, so **reopening a saved set of notes can never have its rows overwritten**.
  - **Rows are replaced, not merged** — a row left standing is a class this client doesn't own,
    and the `NTA_PPE_DEFAULTS` seeded at load are generic placeholders (Building *49 years*)
    that are wrong for almost every client. This is the same "always assign" rule the rest of
    the form already follows on client select (CLAUDE.md §9).
  - **Nothing is touched when there is no schedule to read** — the status box says so and names
    where to save one. Same for a hand-typed company that isn't a directory client: the schedule
    is keyed on `client_id`, so there is nothing to look up. `ntaMatchedClient()` resolves the
    typed name (exact, then case-insensitive) or the PAN.
- **Section B's notes are numbered by a running counter, not by literal text** (2026-08-02). `ntaRenderNotesSection()` owns the six fixed notes and a counter; Related Party takes the next number when ticked, and everything renumbers itself when a note is added, removed or toggled. Writing "1."–"6." into the strings is what made the old block impossible to extend.
- **"Include additional notes to accounts"** reveals a row editor with two row kinds. A **note** continues the running number (so 6 → 7, 8, 9…); a **bold title** renders as a heading and **resets the counter to 1**, so its own notes read 1, 2, 3 beneath it. Rows are part of the saved state. **Deliberately Notes-only** — the audit report's sections are prescribed by the NSAs and are not the auditor's to extend (CA instruction, 2026-08-02), so no equivalent exists in report.js.

### 5.12 Confirmation Letters (`js/confirmationLetters.js`, `cl-` prefix)

Bulk-generates "Confirmation of Account Balance & Transaction" letters — one per customer/supplier of an audit client — as an audit-fieldwork follow-on to the Sales & Purchase Book (§5.9). Automation Hub tab, labelled **Confirmation** in the menu (not a live-session extension of Autobooks): the user uploads an already-generated Autobooks workbook each time.

- **Data source**: reads the uploaded workbook's `Sales Details`/`Purchase Details` sheets back via SheetJS, using the exact column layout `spbSheetDetails()` writes (`B` `"<Party> Total"`, `C` Pan, `D` Tax Free, `E` Taxable, `F` Vat; stops at the `Grand Total` row). Parties are merged by normalized name across both sheets so a party can qualify by Sales alone, Purchase alone, or both.
- **Threshold** (`cl-threshold`, default 100000/1 lakh on Taxable) is user-editable per run; a party crossing it on either side is pre-checked in the review grid, everything else stays hidden unless "show parties below threshold" is ticked.
- **Nothing generates without an explicit per-party choice** — the review grid is a checklist (include/exclude), with Sales/Purchase **Tax Free + Taxable + Vat** all editable (pre-filled from the workbook, not recomputed at a flat 13%) and Opening/Closing Balance always manual (the workbook carries no ledger-balance data).
- **Letter format** (the firm's newer 5-column layout, matched from `conformation letter new.xlsx`): the table is `Particulars | Tax Free Value (Rs) | Taxable Value (RS) | Vat (RS) | Total (RS)`, rows Opening Balance / Sales / Purchase / Closing Balance (Dr). **Row Total = Tax Free + Taxable + Vat** (`clDash()`/`clBuildLetterData` — a zero amount prints as "-", accounting style). The header carries a **Letter Date** (`cl-date`, B.S. `YYYY.MM.DD`, defaults to today, editable). Opening/Closing rows render "-" across unless a balance is typed.
- **Firm identity** (letterhead Name/Address/PAN/Phone + Date — the audit client's own, not S&A/Dallakoti's) auto-fills from the matched `clients` row when the company search resolves to one, editable either way. Firm block + date live in the Word header (constant per run, repeats every page natively).
- **Template** (`assets/templates/confirmation-letter.docx`) is tokenized from a real firm letter: the per-party body (To/Subject/table/signature) is wrapped in a docxtemplater loop `{{#letters}}...{{/letters}}` with a `{{^last}}`-guarded page break, so **one render function (`clRenderLetters`) serves both outputs** — a combined multi-page `.docx` (all selected letters) and a ZIP of individual `.docx` files (JSZip), one call per party with a single-item array.
- **Fixed a wording bug present in every real sample** (including the firm's own blank master): the Subject line and the paragraph below it referenced fiscal years one year apart. The template uses one `{{fyLabel}}` token in both places. Also corrected the firm's baked-in "Conformation" → "Confirmation" typo.

### 5.20 Audit Engagement Letter (`js/auditEngagement.js`, `ae-` prefix)

The NSA 210 engagement letter and its client acknowledgement. Automation Hub tab, labelled
**Engagement Letter** in the menu. Built 2026-08-26 from the firm's own `Audit Engagements.docx`;
mirrors the Audit Report Builder 1:1 (§5.5) — same Edit/Preview toggle, same
Saved / Save to database / Save as Word / Save as PDF header row, same `saved_documents`
persistence through DocumentStore, same two export paths. Its `.rep-sheet` / `.rep-title` /
`.rep-sec` / `.rname` presentation and `renderRepFirmHeader()` are **shared with report.js, not
copied** — the letterhead is one implementation (hence the load-order convention: this file
comes after `js/report.js`).

**What varies is exactly what the source document highlighted in yellow**, and that list is the
form: client, engagement type, fiscal years, firm + signatory, governing act, fee per year,
payment window, acknowledgement signatory. Everything else is fixed boilerplate reproduced
verbatim.

- **The engagement years are a ROW EDITOR, and that one list drives four sections.** The source's
  fee table is one row per year (five drawn, one filled), §5 lists the years, the Subject line
  names them and the acknowledgement repeats them — four places a multi-year engagement would
  otherwise be typed into and could disagree between. One row carries the year *and* its fee;
  `aeGetYearRows()` is read by the Subject line, §5 Audit Period, the §6 fee table and the
  acknowledgement. `aeJoinList()` produces the "A, B and C" form so the years read as prose.
  **The last row is blanked rather than removed** — every year-driven section renders an empty
  list without one, so the form can never reach that state.
- **Section numbers run off a counter, not literal text** — the same lesson
  `ntaRenderNotesSection()` records (§5.6). The optional clause is inserted **before Acceptance**,
  which stays last because it is the clause the client signs against, and everything below it
  renumbers itself.
- **The addressee and the governing act follow the ENTITY TYPE, not the source document.**
  The source is typed for a private company ("The Board of Directors", "Companies Act, 2063");
  on a proprietorship both are wrong. The act comes from `REP_ENTITY_PROFILES[].act` — note this
  is **not** the audit report's `citeSpecificAct` binary (§5.5), which prints "the applicable law"
  for everything but a private company: an engagement letter's §11 *Applicable Law* is a list of
  named statutes, so a generic phrase there would say nothing. The addressee comes from
  `window.AE_ENTITY_ADDRESSEE`, a new map keyed the same way — the existing `salutationTo` is
  shaped for the report's "To the Shareholders of the <Company>", not a letter's block address.
  An unmapped key falls back to "The Management" rather than printing `undefined`.
- **`AE_ENGAGEMENT_TYPES` carries an `auditorRole` beside its `label`** — the Subject line prints
  the label ("Statutory Audit") while the appointment paragraph and the acknowledgement print the
  role ("as the statutory auditor of…"). The source only ever had the statutory wording typed, and
  "appointing us as the statutory auditor" is wrong on a tax or internal engagement.
- **A fee is TEXT** (§15 — the firm's own comma grouping is worth preserving, and "As mutually
  agreed" is a real answer), but a bare number is formatted: typing `25000` and printing
  `NPR 25000` on a fee schedule reads as a draft. **The Total row prints only when every row
  carries a real figure** — a total that silently skipped an "As mutually agreed" line would
  understate what the client is signing for — and only when there is more than one year.
- **`doc_html` is STORED, and it matters more here than in the other two builders.** An engagement
  letter is countersigned and returned, so "reprint exactly what they signed" has to be literally
  true, not approximately. The preview is contenteditable, so the form state alone cannot
  reproduce a hand-edited letter.
- **`fiscal_year` holds the FIRST engagement year**, in the dash form every other module's column
  uses. The full list lives in `state`; this column is the picker's sort/search handle, so a
  joined string no other module's column would match belongs nowhere near it. The **title** does
  carry the full list.
- **Two optional blocks and a letterhead switch**: *Print the firm letterhead* (off for
  pre-printed paper), *Include the client acknowledgement*, and *Include an additional clause*
  (a free heading + body, rendered through the same `.rep-blank-fill` mechanism the report's
  Emphasis of Matter uses — `aeExportHtml()` drops it when unfilled, because html-docx-js honours
  neither `:empty` nor `@media print`).
- **The acknowledgement and the fee table are `page-break-inside: avoid`** — the acknowledgement is
  the page the client signs and returns, and a fee schedule split across a page break invites a
  dispute about which figures were on the page.
- **Adding the module was one value on the `saved_documents.module` CHECK**
  (`db/2026-08-26_saved_documents_audit_engagement.sql`), not a table — the standing decision that
  saved documents are one table with a discriminator (CLAUDE.md §15).
- **`OrgIdentity.fillReportFirmSelect()` now rewrites BOTH `#rep-firm` and `#ae-firm`** via a
  `FIRM_SELECT_IDS` list. index.html hardcodes this firm's two names as `<option>`s on each; left
  unfilled, a second organisation would pick from this firm's names. A new screen with a
  `REP_FIRMS` picker belongs in that list.

### 5.19 OCR Extract — REMOVED 2026-08-18

> **Removed module** (2026-08-18, user decision — it wasn't earning its keep).
> It uploaded a scanned PDF or image to a local FastAPI + PaddleOCR service and
> returned the text. The removal took `js/ocrExtract.js`, `js/core/ocrEngine.js`,
> the whole `ocr_service/` directory (the project's only server-side code),
> `window.OCR_SERVICE_URL`, the Automation Hub menu entry, the
> `tab-ocrExtract-panel` panel, its `MODULE_INITS` entry, and the two loopback
> origins in the CSP `connect-src` — which is Supabase alone again. All of it is
> recoverable from git history. Historical `audit_log` rows (`module:
> 'ocrExtract'`, `event_type: 'ocr_extract_run'` — six of them) remain valid and
> `js/config.js` keeps their display labels, the same treatment the two removed
> VAT modules got. Don't restore it without an explicit ask.

What it was, and the findings that would apply again to any future OCR attempt:

- **It is the only module backed by a server process.** All the OCR work happens
  in `ocr_service/` (FastAPI + PaddleOCR), which each staff member ran locally
  (that directory and `architecture.md` §2.6 are gone — see git history). The browser side
  is deliberately thin — file picking, calling the service, rendering text.
- **`js/core/ocrEngine.js` owns the transport**, not this module. Its one real job
  is telling *"the service isn't running"* apart from *"OCR failed"*: a `fetch()`
  to a dead loopback port rejects with a bare "Failed to fetch", which tells the
  user nothing, so the engine rewrites it into an actionable message naming the
  start script. `ocrInit()` calls `/health` on every tab open so that message
  appears **before** the user picks a file rather than after they wait on an
  upload.
- **Deliberately not wired to anything** — no client picker, no `clients` row, no
  document pipeline. It extracts text and hands it over. This keeps the service's
  availability a local concern: if it's stopped, only this tab is affected.
- **Nepali (Devanagari) text is handled by default** — the service runs
  `OCR_LANG=ne`, verified 2026-08-01 to read both Devanagari and plain
  Latin/English text correctly from one model. Do not point this at `en`: it has
  no Devanagari support and silently returns confident-looking garbage instead
  of an error (see `docs/architecture.md` §2.6 for a real before/after example).
- **Expect ~15–40 seconds per page** on CPU (Devanagari's detection model is a
  larger tier than the English-only one, and CPU contention from other running
  processes matters a lot — a busy machine can push this well past a minute).
  The status box says so during a run; the Extract button disables while
  `ocrBusy` is set so a slow page can't be
  double-submitted.
- This is **not** a revival of the removed VAT Return OCR module (see
  `modules/registrar.md` §5.11) — that was in-browser, digit-only, Tesseract-based,
  and wired into the VAT workbook. This is a general-purpose text extractor with a
  different engine and no VAT coupling. The 2026-07-14 decision to drop the VAT
  module still stands.

