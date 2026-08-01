# Document Builders

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for Send Document, Audit Report Builder, Notes to Accounts and Confirmation Letters.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

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

### 5.12 Confirmation Letters (`js/confirmationLetters.js`, `cl-` prefix)

Bulk-generates "Confirmation of Account Balance & Transaction" letters — one per customer/supplier of an audit client — as an audit-fieldwork follow-on to the Sales & Purchase Book (§5.9). Automation Hub tab, labelled **Confirmation** in the menu (not a live-session extension of Autobooks): the user uploads an already-generated Autobooks workbook each time.

- **Data source**: reads the uploaded workbook's `Sales Details`/`Purchase Details` sheets back via SheetJS, using the exact column layout `spbSheetDetails()` writes (`B` `"<Party> Total"`, `C` Pan, `D` Tax Free, `E` Taxable, `F` Vat; stops at the `Grand Total` row). Parties are merged by normalized name across both sheets so a party can qualify by Sales alone, Purchase alone, or both.
- **Threshold** (`cl-threshold`, default 100000/1 lakh on Taxable) is user-editable per run; a party crossing it on either side is pre-checked in the review grid, everything else stays hidden unless "show parties below threshold" is ticked.
- **Nothing generates without an explicit per-party choice** — the review grid is a checklist (include/exclude), with Sales/Purchase **Tax Free + Taxable + Vat** all editable (pre-filled from the workbook, not recomputed at a flat 13%) and Opening/Closing Balance always manual (the workbook carries no ledger-balance data).
- **Letter format** (the firm's newer 5-column layout, matched from `conformation letter new.xlsx`): the table is `Particulars | Tax Free Value (Rs) | Taxable Value (RS) | Vat (RS) | Total (RS)`, rows Opening Balance / Sales / Purchase / Closing Balance (Dr). **Row Total = Tax Free + Taxable + Vat** (`clDash()`/`clBuildLetterData` — a zero amount prints as "-", accounting style). The header carries a **Letter Date** (`cl-date`, B.S. `YYYY.MM.DD`, defaults to today, editable). Opening/Closing rows render "-" across unless a balance is typed.
- **Firm identity** (letterhead Name/Address/PAN/Phone + Date — the audit client's own, not S&A/Dallakoti's) auto-fills from the matched `clients` row when the company search resolves to one, editable either way. Firm block + date live in the Word header (constant per run, repeats every page natively).
- **Template** (`assets/templates/confirmation-letter.docx`) is tokenized from a real firm letter: the per-party body (To/Subject/table/signature) is wrapped in a docxtemplater loop `{{#letters}}...{{/letters}}` with a `{{^last}}`-guarded page break, so **one render function (`clRenderLetters`) serves both outputs** — a combined multi-page `.docx` (all selected letters) and a ZIP of individual `.docx` files (JSZip), one call per party with a single-item array.
- **Fixed a wording bug present in every real sample** (including the firm's own blank master): the Subject line and the paragraph below it referenced fiscal years one year apart. The template uses one `{{fyLabel}}` token in both places. Also corrected the firm's baked-in "Conformation" → "Confirmation" typo.

### 5.19 OCR Extract (`js/ocrExtract.js`, `ocr-` prefix)

Added 2026-08-01. Upload a scanned PDF or an image, get its text back — copy it
or download it as `.txt`. Automation Hub tab.

- **It is the only module backed by a server process.** All the OCR work happens
  in `ocr_service/` (FastAPI + PaddleOCR), which each staff member runs locally;
  see `docs/architecture.md` §2.6 and `ocr_service/README.md`. The browser side
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
- **Nepali (Devanagari) text is not handled today.** The service runs the English
  model (`OCR_LANG=en`). PaddleOCR ships Devanagari models, so this is a config
  change plus real-document calibration, not a rewrite — but it has **not** been
  tested against the firm's Nepali documents, so don't assume it works.
- **Expect ~10–20 seconds per page** on CPU. The status box says so during a run;
  the Extract button disables while `ocrBusy` is set so a slow page can't be
  double-submitted.
- This is **not** a revival of the removed VAT Return OCR module (see
  `modules/registrar.md` §5.11) — that was in-browser, digit-only, Tesseract-based,
  and wired into the VAT workbook. This is a general-purpose text extractor with a
  different engine and no VAT coupling. The 2026-07-14 decision to drop the VAT
  module still stands.

