# VAT Return Automation — Handoff Document

**Generated:** 2026-07-04 (end of the session that built this feature)
**Repository:** `C:\AUTOMATION AI APP` (local), `https://github.com/aadarshakhanal2064-cyber/AUTOMATION` (remote)
**Live site:** `https://aadarshakhanal2064-cyber.github.io/AUTOMATION/`
**Branch:** `main` (only branch in use)
**HEAD at time of writing:** `1e02381` — local and `origin/main` are in sync (verified: `git rev-parse main` and `git rev-parse origin/main` both return `1e023816b30392fe3f82f3fd7c602b044e6abd57`), working tree clean.

This document is written to be fully self-contained. A new Claude Code session should be able to read this file alone and continue work with zero prior context. It covers only the VAT Return module; the broader application (BM/AGM Minutes, Send Document, Clients, etc.) is documented in `HANDOFF.md` at the project root — read that too if you need context on the rest of the app, though it predates this feature and won't mention it.

---

## 1. Project Overview

### What this application is

An internal web tool for **Shailesh & Associates** and **Dallakoti & Company**, chartered-accountancy/registered-auditor firms in Nepal (max 8 users, all staff). It automates document generation and client-management workflows: sending audit documents via Gmail, generating audit reports, managing a client directory, generating BM/AGM Minutes as Word documents, and — the subject of this document — **automating VAT Return preparation**: reading a client's IRD-issued VAT Return PDF and producing the firm's standard "Detail of Sale & Purchase" Excel workbook, without any AI/LLM involvement at runtime.

### Architecture

- Everything runs client-side in the browser. There is **no server-side code** at all. Supabase's anon/publishable key is used directly in `js/config.js` (intentional for this app's threat model: 8 trusted internal users).
- Page structure: one `index.html` containing all tab panels, shown/hidden via JS (not separate page loads). Tabs: Send Document, Generate Report, Company Registrar (with sub-tabs: Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset, BM/AGM Minutes, **VAT Return**), Clients, Send Logs.
- Each feature area has its own JS file, loaded in a specific order in `index.html` (order matters — later files depend on `window.*` globals set up earlier). State is managed via `window.*` globals (`window.clientsList`, `window.currentUser`, `window.vatExtractedPages`, etc.) — no framework, no build step, no bundler.
- **No `package.json` at the repo root.** All third-party libraries are loaded via CDN `<script>` tags directly in `index.html`, pinned to exact versions (matching `jsdelivr`/`cdnjs` URLs).

### Tech stack

- **Frontend:** Static HTML/CSS/vanilla JavaScript.
- **Backend:** Supabase (Postgres + REST API via `supabase-js`). No custom backend server.
- **Auth:** Google OAuth (Google Identity Services), not Supabase Auth.
- **Hosting/CI:** GitHub Pages, auto-deploys via a "pages build and deployment" GitHub Actions workflow on every push to `main`.
- **VAT module specifically, all CDN-loaded, zero AI/API dependency:**
  - `pdfjs-dist@3.11.174` (`build/pdf.min.js` + `build/pdf.worker.min.js`) — PDF page rendering. Pinned to this version deliberately: pdf.js dropped its plain-`<script>`-tag-friendly UMD build in more recent versions (they moved to ES-module-only builds), and this app never uses `type="module"` scripts, so 3.11.174 is the newest version confirmed (by checking jsdelivr directly) to still ship a working non-module build.
  - `tesseract.js@7.0.0` (`dist/tesseract.min.js`) — OCR engine (WASM), runs fully offline in-browser after its one-time language-data download.
  - `exceljs@4.4.0` (`dist/exceljs.min.js`) — Excel workbook generation, chosen over the app's existing `xlsx`/SheetJS dependency (used elsewhere for CSV/Excel *import*) because ExcelJS round-trips formulas, merged cells, and number formats faithfully on *write*, which SheetJS does not do as reliably.
  - Reuses `bmDownloadBlob()` from `js/bmAgmMinutes.js` for the final file download (no new download-handling code was written).

### Coding conventions

- `escHtml()` (in `js/utils.js`) used everywhere untrusted/dynamic strings are injected into HTML, to avoid XSS.
- Form field IDs are prefixed per module to avoid collisions (`bm-` for BM/AGM, `rep-` for Report Generator, `ac-` for Add Client, `vat-` for this module).
- UI reuses existing CSS component classes: `.card`, `.card-header`, `.form-group`, `.form-grid`, `.status-box` (with `status-success`/`status-error`/`status-info`/`status-searching` variants), `.client-table`/`.table-wrap`, `.btn`/`.btn-primary`/`.btn-outline`. No new visual language was introduced for this module.
- Status/progress messages go through a per-module `xxStatus(html, type)` helper (`vatStatus()` here), matching the existing `bmStatus()` pattern in `bmAgmMinutes.js`.
- Minimal comments: only explaining *why* something non-obvious is the way it is (a calibration finding, a root-cause bug fix, a deliberate trade-off), never restating *what* the code does.

### Standing project rules (from `CLAUDE.md`, unchanged, apply to all future work)

1. Never duplicate code — reuse existing logic before writing parallel versions.
2. Always check `js/utils.js` and existing UI patterns before building something new.
3. Keep files modular — one concern per file.
4. Never create unnecessary files.
5. Flag files that are getting too large rather than letting them grow silently (`js/vatReturn.js` is currently ~620 lines — worth watching if Phase 4+ adds significantly more).
6. Prefer reusable helper functions over copy-paste.
7. No comments explaining *what*, only *why*, when genuinely non-obvious.
8. Reuse existing CSS variables/components.
9. Never break existing features — every change checked against existing functionality.
10. Think about scalability (app expected to grow to 60–80+ features).
11. Every feature must feel native to the project (naming/structure/UI language).
12. Self-review every feature for bugs/improvements before presenting it as done.

**Git workflow rules (hard rules, not suggestions):**
1. Feature → Review → Commit → Push, strictly in that order.
2. One logical change per commit.
3. Never rewrite history (`--amend`, `rebase`, force-push) without explicit approval, every time.
4. **Never push without explicit approval, every single time** — no standing permission, regardless of how many times it's been granted before.
5. Never execute SQL migrations yourself — generate them, explain where to run them, wait for the user to confirm they ran it. (Not applicable to this module so far — no new tables were created.)

---

## 2. Current VAT Module Architecture

Single file: `js/vatReturn.js` (~620 lines), plus a UI panel in `index.html` (`#regd-vatReturn-panel`, lines ~709–774) and one line in `js/tabs.js` registering the sub-tab. No other files contain VAT-specific logic.

### Why this document type requires OCR at all (verified, not assumed)

Direct byte-level inspection of the reference test PDF confirmed: **zero embedded text, zero AcroForm fields, zero XFA, zero embedded files, zero XMP metadata, zero tagged-structure (`StructTreeRoot`).** Every one of the PDF's pages is a single embedded JPEG image (`/Subtype /Image`, `DCTDecode` filter) painted via one `paintImageXObject` operator, with `0` font objects and `0` text-show (`Tj`/`TJ`) operators anywhere in the file. This was checked before Phase 1 was built (per an explicit instruction to check for a better deterministic method before writing more OCR code) — there is no better deterministic extraction path for this specific document family. OCR is the only option.

### Data flow, end to end

1. User fills **Company Name**, **Address** (both manual text entry — deliberately *not* OCR'd; Devanagari-script OCR was never validated as reliable in this project, only digit OCR was, so company identity fields stay manual), **Opening Balance** (manual, since it's last year's closing figure and isn't present in this year's PDF).
2. User selects a PDF file (`#vat-pdfFile`) and clicks **Extract from PDF** → `vatExtractPdf()`.
3. **Structural validation** (`vatValidatePdf()`) runs first, before any OCR. If it fails, extraction stops immediately with an itemized error list.
4. If valid: a single Tesseract.js worker is created (`Tesseract.createWorker('eng')`), configured once (`tessedit_char_whitelist: '0123456789'`), and reused for every OCR call across every page.
5. For each PDF page: `vatRenderPageCanvas()` renders it via pdf.js, `vatGetImagePlacement()` computes that page's specific margin-correction factors, then all 14 fields in `VAT_FIELD_BOXES` are cropped (`vatCropField()`) and OCR'd (`vatOcrDigits()`) using the shared worker.
6. The worker is terminated (`finally` block, guaranteed even on error).
7. Each page's "अवधि" (period) digit is mapped to a fiscal month via `VAT_PERIOD_TO_MONTH`; if unrecognized, it's inferred from the previous page's month + 1 (`monthGuessed: true`), since filings are sequential monthly pages.
8. Results populate `window.vatExtractedPages` (the single in-memory state object for this module — not persisted anywhere) and render the review table (`vatRenderReviewTable()`).
9. Fiscal Year field auto-fills from the **first** period's tax year (handles IRD's tax-year rollover at Baishak, mid-fiscal-year).
10. User reviews the table: every extracted value is shown with a confidence-tier icon and is directly editable; every row shows a status indicator summarizing all detected issues, each with a specific reason on hover.
11. User clicks **Generate & Download Excel** → `vatGenerateExcel()`. This first re-checks every row for *blocking* issues (via the same `vatRowWarnings()` the table used) and refuses to proceed, with an itemized explanation, if any remain unresolved.
12. If clear: `vatBuildMonthRows()` applies the business rules (period mapping already done; now the VAT-Paid carry-forward and running-Total formula chain), and `vatGenerateExcel()` builds the workbook via ExcelJS, matching the firm's real template's structure, fonts, number formats, and formulas exactly (see §"Business rules" below for the exact formulas).
13. File downloads via `bmDownloadBlob()` (reused from the BM/AGM module).

### Structural validation (`vatValidatePdf()`, lines ~168–205)

Runs before any OCR. Order of checks (first failure per page stops that page's checks, but other pages are still checked so the user gets a full error list):

1. **Page count**: `1 ≤ numPages ≤ 12` (a VAT filing has at most 12 monthly pages). Immediate hard stop if violated — no per-page checks run.
2. **Page size**: each page's `page.view` bounding box must be `595×842pt ± 5pt` (A4). `VAT_PDF_PAGE_W`/`VAT_PDF_PAGE_H` constants.
3. **Image structure**: exactly one embedded image XObject per page (`vatGetImagePlacement()`'s `imageCount`), and it must be placed full-width (`ctm[0]` within 5pt of 595, `ctm[4]` — the horizontal offset — within 5pt of 0).
4. **Structural anchors** (dark-pixel-density check, `vatCheckPageAnchors()`): three regions — `titleBlock`, `tableHeaderRow`, `tableBorderVertical` — each with a measured min/max dark-pixel-density range. Requires **at least 2 of 3** anchors to pass. If fewer than 2 pass, that page is rejected.

**Exact calibration data behind the anchor thresholds** (measured directly, not guessed — see §4 for the full investigation):
- Real form pages (3 pages checked, all different data): `titleBlock` 0.035–0.039, `tableHeaderRow` 0.090–0.119, `tableBorderVertical` 0.073–0.100.
- Synthetic blank page: `0.0000` in all three.
- Synthetic fully-dark/photo-like page: `1.0000` in all three.
- Thresholds set with generous margin: `titleBlock` [0.015, 0.10], `tableHeaderRow` [0.05, 0.25], `tableBorderVertical` [0.03, 0.25].
- Verified against 5 synthetic negative-control PDFs (wrong page count, wrong page size, blank page, unrelated vector document, unrelated full-page image) — all correctly rejected, each with a distinct, accurate reason.

### PDF rendering & the per-page margin correction (`vatGetImagePlacement()`, lines ~74–101)

This is the single most important, non-obvious piece of engineering in this module. **Each page's scanned image sits inside the fixed 595×842pt PDF page with its own, non-constant vertical margin.** Confirmed via three real pages' content-stream placement matrices (`cm` operator before `Do`):
- Page 1: `[595, 0, 0, 754.57855, 0, 43.71072]` (top margin ≈43.71pt)
- Page 5: `[595, 0, 0, 739.85016, 0, 51.07492]` (top margin ≈51.07pt)
- Page 10: `[595, 0, 0, 735.80151, 0, 53.09924]` (top margin ≈53.10pt)

A fixed-margin assumption would misplace every field crop by a page-dependent amount. `vatGetImagePlacement()` walks the PDF page's **operator list** (via `page.getOperatorList()`), tracking the transform stack (`save`/`restore`/`transform` operators) to find the exact CTM (current transformation matrix) active at the `paintImageXObject` call — this gives the exact per-page `(f, d)` values, from which `topFraction`/`heightFraction`/`widthFraction`/`leftFraction` are derived. `vatCropField()` then applies these correction factors to every field's calibrated (raw-image-relative) coordinate before cropping. **Horizontal placement was found and verified to be flush-left with zero margin (`e≈0`) on all pages checked, and is not independently corrected — this is a real, disclosed assumption, not verified across a different scan/printer pipeline (see §4/§7).**

### Field coordinates (`VAT_FIELD_BOXES`, lines ~40–62)

14 fields, each `{ left, top, width, height }` as **fractions of the raw scanned image** (0.0–1.0), not fixed pixels — necessary because different pages of the same document rendered at slightly different pixel dimensions in testing (e.g., 1044×1324 vs 1068×1328 vs 1048×1296 for pages 1/5/10 of the reference document) even before the PDF-page-margin issue above.

| Field | Excel column it feeds | Notes |
|---|---|---|
| `period` | (used only to derive month, not written directly) | Least reliable field — see §4 |
| `taxYear` | (used only to derive Fiscal Year label from the *first* period) | |
| `taxableSalesValue` | C | |
| `taxableSalesVat` | D | |
| `taxFreeSales` | E | |
| `taxablePurchaseValue` | F | |
| `taxablePurchaseVat` | G | |
| `exemptPurchase` | H | |
| `taxableImportValue` | I | |
| `taxableImportVat` | J | |
| `exemptImport` | K | |
| `adjustmentSalesDebit` | L | From PDF's "३.१ अन्य थपघट" row, debit-side column |
| `adjustmentPurchaseCredit` | M | Same PDF row, credit-side column |
| `item5DebitCredit` | (not written — supplementary cross-check only) | See §4, this field's box was widened in Phase 3 |

Every crop is fed through `Tesseract.recognize()`/`worker.recognize()` with `tessedit_char_whitelist: '0123456789'` — digit-only OCR. **No Devanagari text OCR is performed anywhere in this module.**

### Worker lifecycle (Phase 2)

One `Tesseract.createWorker('eng')` worker is created **per `vatExtractPdf()` call** (not a page-level or app-level singleton), configured once via `setParameters()`, reused for all ~140 recognitions in a typical 10-page filing (14 fields × 10 pages), and terminated in a `finally` block that runs even if extraction throws mid-loop. Benchmarked at 4.1× faster than the original per-call `Tesseract.recognize()` convenience API (21.3s → 5.1s on the same 10-page PDF), with confirmed zero memory leak (`performance.memory.usedJSHeapSize` delta was **−1.0MB** after `worker.terminate()`, i.e., heap was not higher after extraction than before). See §3 Phase 2 and §4 for the important caveat: this API switch was found to produce *different* (not necessarily worse) OCR results on already-marginal fields, not because the worker "leaks state" in a way that degrades results generally.

### Confidence system (Phase 3)

`vatConfidenceTier(confidence)` maps Tesseract's 0–100 confidence score to one of three tiers, replacing raw percentages in the UI:
- 🟢 **High**: `confidence ≥ 80`
- 🟡 **Medium**: `50 ≤ confidence < 80`
- 🔴 **Low**: `confidence < 50`

Shown per-field in the review table as a small icon beside each editable input, with the exact percentage still available on hover (tooltip). The input's border/background also turns red for any non-High tier (redundant-but-complementary visual signal, not relying on color alone).

### Validation & blocking logic (Phase 3) — the core of "prevent incorrect data reaching the Excel"

**`vatRowWarnings(pg, dupIdxs)`** (lines ~385–419) is the single source of truth. It returns an array of `{ severity: 'block' | 'warn', message }` for one page, and is called from *both* `vatRenderReviewTable()` (what the user sees) and `vatGenerateExcel()` (what actually blocks generation) — guaranteeing the two can never disagree.

**Checks performed, in order, each independent:**

1. **Month resolution** — `block` if period wasn't recognized and no fallback was possible; `block` if this page's assigned month collides with another page's (duplicate); `warn` (non-blocking) if the month was inferred by sequence rather than read directly.
2. **VAT-rate check, sales pair** (`vatRateCheck(taxableSalesValue, taxableSalesVat)`) — **`block`** if it fails. This is the *primary*, most trusted validator (see §4 for why).
3. **VAT-rate check, purchase pair** — same, **`block`**.
4. **VAT-rate check, import pair** — same relationship, but **`warn`** only (import is usually zero for the one company tested; kept non-blocking pending more real-world evidence in Phase 6).
5. **Total extraction failure** — `block` if *both* `taxableSalesValue` and `taxablePurchaseValue` are empty strings (OCR read nothing at all on this page).
6. **item5 checksum** (`vatChecksum()`) — `warn` only, never blocking. Explicitly downgraded in Phase 3 after investigation showed this specific field is the least reliable one to OCR (see §4).
7. **Low-confidence fields** — `warn`, lists every field (excluding `taxYear`) with `0 < confidence < 50`.

`vatGenerateExcel()` collects every page's `block`-severity warnings, and if any exist, refuses to generate — showing the exact same messages, itemized per page, that are visible as 🔴 in the review table. There is no way to force-generate past a blocking issue; the only path forward is fixing it in the table (editing a field, or picking a different month from the dropdown), which live-updates the warnings.

**`vatRateCheck(value, vat)`** (lines ~336–342): Nepal's VAT rate is a fixed 13%. `expected = Math.round(value * 0.13)`; passes if `|vat - expected| ≤ 2` (rupees). Special-cased: `value === 0 && vat === 0` always passes (a legitimately empty category, e.g. no imports that month).

### Duplicate-month detection (`vatDuplicateMonthIdxs()`, lines ~365–373)

Two pages resolving to the same fiscal-month index is always a mistake — almost always caused by a misread period digit (the concrete example found in this project: "11" misread as "1", colliding with the real page whose period genuinely is "1"). Left unresolved, since the business-rules step (`vatBuildMonthRows()`) merges pages into month slots by index, the second page silently overwrites the first's real data with no error. `vatDuplicateMonthIdxs()` scans all pages' resolved `monthInfo.idx` values and returns the `Set` of indices that appear more than once; both the review table (per-row 🔴) and `vatGenerateExcel()`'s block check consult this set every time (recomputed fresh on every render/edit, never cached/stale).

### Business rules (`vatBuildMonthRows()`, lines ~492–515) — verbatim from the reverse-engineered original template

- **Difference** (Excel column O) = `D - G - J + L - M` (VAT collected on sales, minus VAT paid on purchase, minus VAT paid on import, plus/minus adjustments).
- **VAT Paid** (column N) = the *previous month's computed Total* if it was positive, else `0`. **Not** copied from the PDF's own item-6 figure per page — computed independently from the running Total, per explicit original design intent (verified against the real prior-year template's actual formulas, not assumed).
- **Total** (column P) = `previousTotal + Difference − VatPaid`, a running balance seeded from the manually-entered Opening Balance.
- Missing months (no page resolved to that index) are left with blank C–N cells; Excel treats blank cells as `0` in arithmetic, so the O/P formula chain (still written for every row, including missing ones) naturally carries the running Total forward unchanged across a gap — verified this holds correctly including for a missing *first* month (Total stays at the Opening Balance until the first real month is processed).

### Excel generation (`vatGenerateExcel()`, lines ~519–618)

Builds a fresh workbook via ExcelJS (no uploaded reference template needed — the shape is fully known and hardcoded) matching the firm's real "Detail of Sale & Purchase" template:

- `A1:P1` merged — company name, Arial bold 19.
- `A2:P2` merged — address, Arial bold 11.
- `A3:P3` merged — `"                  Detail of Sale & Purchase as per VAT Return for F.Y {fyLabel}"`, Arial 14. **Known cosmetic gap**: the real template's header cell for column E ("Tax Free Sales ") has a trailing space; the generated one does not. Disclosed, not fixed (harmless).
- Row 5 — 16 column headers, Century Gothic 11, number format applied to columns C onward.
- Row 6 — "Opening" row; only `P6` populated (the manual Opening Balance).
- Rows 7–18 — the 12 fixed months, **Shrawan through Ashadh, always in that order** regardless of how many PDF pages were actually present. Column O/P formulas written for every row (`D{r}-G{r}-J{r}+L{r}-M{r}` and `P{r-1}+O{r}-N{r}`); C–N values written only for non-missing months. A missing month gets a cell note on its Month cell explaining why it's blank.
- Row 19 — "Total"; `SUM({col}7:{col}18)` for every additive column (C through N); **no formula for O or P** (correctly matches the original — those are running balances, not additive).
- **Known, disclosed, unresolved gap**: the real reference template also has rows 21–22 (a hardcoded duplicate total in `C21` and a `=+C21-C19` tie-out check in `C22`) whose exact purpose was never fully determined during the original reverse-engineering pass. **These rows are not reproduced in the generator at all.** This is explicitly in-scope for Phase 4 ("Complete Workbook").
- Downloaded as `VAT Return {companyName} {fyLabel}.xlsx` via `bmDownloadBlob()`.

---

## 3. Every Completed Phase

All three phases follow the same working pattern established throughout this project: investigate first (with real evidence, often via a Node.js scratchpad harness using the same libraries — `pdfjs-dist`, `tesseract.js`, `canvas`, `pdf-lib` — installed in the session's temp scratchpad directory, never committed), implement only what's justified by that evidence, verify in the real browser against the real reference PDF (not just unit-style assertions), regression-check the rest of the app, self-review, then one commit per phase.

### Phase 1 — Structural Validation

**Objective:** verify the uploaded PDF is actually the supported VAT Return form *before* any OCR runs, and stop with a clear explanation if not.

**Investigation performed:** Before writing any code, re-confirmed (per an explicit instruction to check for a better deterministic method before doing more OCR work) that this PDF family has zero AcroForm/XFA/embedded-file/metadata/tagged-structure content — see §2's opening note. Then empirically derived the dark-pixel-density anchor thresholds by rendering 3 real pages and measuring actual density in candidate regions (title block, table header row, a table column divider), and separately measuring the same regions on synthetic blank and fully-dark pages to confirm real separation between "valid form" and "not a valid form" — not guessed.

**What changed:** Added `vatValidatePdf()`, `vatGetImagePlacement()` (extended to also return `imageCount`), `vatCheckPageAnchors()`, `vatDarkDensity()`, and the `VAT_STRUCTURAL_ANCHORS`/`VAT_PAGE_SIZE_TOLERANCE_PT` constants. Wired into `vatExtractPdf()` as a hard gate before the extraction loop.

**Verification performed:** In-browser, against the real reference PDF (unchanged extraction: same 10 pages, same values, e.g. page 1 taxable sales still `57612642`) and against **5 synthetic negative-control PDFs** generated via `pdf-lib`: wrong page count (15 pages), wrong page size (US Letter), a blank page, an unrelated vector document (an "invoice"-style PDF with text/shapes, no image), and an unrelated full-page raster image (a gray photo-like PNG embedded as the sole page image). All 5 correctly rejected before any OCR call, each with a distinct, accurate reason. Other tabs regression-checked. Console clean.

**Commit:** `f78ddf1` — `feat(vatReturn): structural validation before OCR (Phase 1 hardening)`

**Why this design:** page count/size/image-structure checks are exact and free (no OCR needed). The density-anchor approach was chosen over attempting Devanagari OCR of the title text specifically because Devanagari-script OCR was never validated as reliable anywhere in this project (only digit OCR was) — a pixel-density structural proxy achieves the same goal (confirm this looks like the expected form) without introducing that unvalidated risk.

### Phase 2 — OCR Reliability Improvements (worker reuse)

**Objective:** replace the per-call `Tesseract.recognize()` convenience API (which spins up and tears down a full WASM engine instance on every single call) with one reusable worker for the whole extraction; benchmark; verify no accuracy regression.

**Investigation performed:** none needed up front (the inefficiency was already known/flagged from earlier testing) — the investigation happened *during verification*, when the "identical values" check failed and had to be root-caused (see §4).

**What changed:** `vatOcrDigits()`, `vatExtractField()`, and `vatExtractPage()` all now take a `worker` parameter instead of calling the static API. `vatExtractPdf()` creates one `Tesseract.createWorker('eng')` worker, sets `tessedit_char_whitelist` once, passes it through the whole extraction loop, and terminates it in a `finally` block.

**Verification performed:** Benchmarked in-browser via `performance.now()` and `performance.memory.usedJSHeapSize`, before/after, on the identical real 10-page PDF: **21.3s → 5.1s (4.1× faster)**; memory delta **−1.0MB** post-`terminate()` (no leak). Then discovered and investigated a real discrepancy: extraction was *not* byte-identical to the pre-Phase-2 run. Isolated A/B testing (same crop, same page, both APIs called back-to-back in the same browser session) confirmed `Tesseract.recognize()` and `worker.recognize()` can genuinely return different results on marginal/low-confidence input — concretely, page 2's period digit read as empty via the old API and as `"4"` (at 0% confidence) via the new one. Confirmed the new approach is internally deterministic (re-ran it twice on the same PDF, identical results both times). Confirmed every field that read reliably before (9 of 10 pages' `taxableSalesValue`, spot-checked) remained byte-identical — the divergence was confined to fields already known to be unreliable (period, item5). Confirmed the pre-existing duplicate-month guard correctly caught and blocked the resulting collision. Other tabs regression-checked. Console clean.

**Commit:** `495df26` — `perf(vatReturn): reuse one Tesseract worker for the whole extraction (Phase 2)`

**Why this design:** a worker is scoped to one `vatExtractPdf()` call (not an app-lifetime singleton) — simplest lifecycle, no dangling state between unrelated uploads, matches "one worker for the entire extraction" as "one extraction run." A `try/finally` guarantees cleanup even on a mid-loop error, which matters since `vatValidatePdf()` and `vatExtractPage()` both throw on unexpected conditions.

### Phase 3 — Confidence, Validation & Real Blocking

**Objective:** strengthen OCR reliability signals and the review workflow so incorrect data cannot reach the generated Excel — explicitly given latitude to design this "your own way" rather than following a fixed checklist.

**Investigation performed:** Rather than building a confidence-tier UI on top of the already-known-unreliable item5 checksum, investigated *why* it was failing on nearly every page. Cropped and visually inspected item5's region across 5 pages — found the coordinate box itself was landing on the wrong content on some pages (catching the जम्मा/Total row instead), a genuine calibration gap (item5 had only ever been validated on page 1 before this). Separately, computed by hand what item5's *true* expected value should be for a page with a real, verified negative Difference — and discovered the digit-only OCR whitelist strips minus signs, so a legitimately negative computed value could never match an OCR'd (always-positive) reading; also found Tesseract can report 0% confidence on a digit string it read *correctly* (verified directly: page 1's item5 read "444349" — exactly right — yet failed the old `confidence > 0` gate). Separately, hypothesized and then **verified with real numbers before writing any code** that Nepal's VAT rate (13%) holds reliably across every correctly-read value/VAT pair captured during this project — checked 14 real pairs, max deviation ₨1 (mostly exact matches).

**What changed:** Added `vatRateCheck()` (the new primary validator), `vatConfidenceTier()`, `vatRowWarnings()` (single source of truth for both display and blocking), `vatRowStatusHtml()`. Fixed `vatChecksum()`'s two bugs (absolute-value comparison; removed the confidence gate). Widened `item5DebitCredit`'s coordinate box (taller, to tolerate the per-page position drift found). Rewrote `vatRenderReviewTable()` to show tier icons instead of raw percentages and a consolidated per-row status/reason indicator. Rewrote `vatGenerateExcel()`'s blocking check to use `vatRowWarnings()` across all pages instead of only the duplicate-month check.

**Verification performed:** In-browser, against the real reference PDF. The new checks correctly flagged **every genuine problem already known to exist** in this document: both duplicate-month collisions (page1/page2 → Shrawan; page8/page10 → Baishak), page 3's total OCR failure ("no sales or purchase figures read"), and page 6's garbled purchase-VAT misread (flagged precisely: "expected ~1838, read 42000") — with **zero false positives** on the 4 cleanly-read pages (4, 5, 7, 9). Then resolved every flagged issue using the actual UI (month `<select>` dropdowns, field `<input>` edits) exactly as a real user would — including discovering and correctly resolving a *cascading* stale-guess collision that my own sequence of test edits triggered (fixing page 2's month didn't automatically recompute page 3/4/5's fallback-derived guesses, which is expected, correct behavior, and the duplicate-detector caught it every time). Confirmed `vatGenerateExcel()` then succeeded, producing a valid workbook. Other tabs regression-checked. Console clean throughout.

**Commit:** `1e02381` — `feat(vatReturn): confidence tiers, VAT-rate validation, real blocking (Phase 3)`

**Why this design:** the VAT-rate check was chosen as the *primary* blocking validator over item5 specifically because it only depends on two fields already read reliably (no separate, hard-to-calibrate field to trust), and its reliability was proven with real data before it was trusted. item5 was deliberately *not* deleted — it's still useful supplementary information — but demoted to non-blocking given its now-well-understood unreliability, rather than either removing it or pretending it's more trustworthy than it is.

---

## 4. Important Discoveries

Everything in this section exists only in this conversation's history (as tool-call evidence and reasoning), not as code comments — captured here so it isn't lost.

### OCR limitations

- **Digit-only whitelist mode (`tessedit_char_whitelist: '0123456789'`) is reliable when a crop is tightly isolated to just the target digits, but degrades sharply if the crop includes nearby non-digit content** (a label, an adjacent line) — confusion isn't limited to outputting garbage characters that then get filtered; it can corrupt the *segmentation* of the actual digits too, producing wrong digits, not just noise. Verified directly: a "generous" crop around a known digit produced completely wrong output despite the whitelist.
- **Isolated single-character crops sometimes fail entirely** (empty result, 0% confidence) even when the digit is clearly legible to the eye and correctly positioned. Attempted several `tessedit_pageseg_mode` (PSM) values (`SINGLE_CHAR`, `SINGLE_LINE`, tried via both the one-shot and `createWorker`+`setParameters` APIs) as a fix — **none resolved it**. This remains an open, unexplained Tesseract.js behavior, not something this project found a fix for. The mitigation in place is architectural (confidence tiers + sequential fallback + duplicate detection), not a Tesseract configuration fix.
- **No Nepali/Devanagari-script OCR was attempted or validated anywhere in this project.** Company name, address, and PAN are deliberately manual-entry fields for this reason.

### Worker API behavior (Tesseract.js)

- `Tesseract.recognize(image, lang, options)` (one-shot convenience API) and `Tesseract.createWorker(lang)` + `worker.setParameters()` + `worker.recognize(image)` (persistent worker) **are not guaranteed to return identical results on the same input image**, specifically on marginal/low-confidence crops. Concretely reproduced: the same crop from page 2's period field, tested back-to-back in the same browser session, returned `""` (one-shot) vs `"4"` at 0% confidence (worker). This was unexpected and is not documented behavior this project could confirm the root cause of (worker warm-state vs. fresh-instance internal differences is the working hypothesis, not confirmed).
- The persistent-worker approach **is internally deterministic** — re-running the same extraction twice on the same PDF via the worker API gave identical results both times.
- **Practical implication:** any future OCR work in this codebase should assume small, non-deterministic-feeling variance is possible on genuinely marginal input, and should lean on independent validation signals (like the VAT-rate check) rather than trusting any single OCR read as ground truth, however it was obtained.

### VAT-rate validation

Nepal's standard VAT rate is a fixed **13%**. Verified against 14 real, independently-confirmed-correct value/VAT pairs extracted during this project (spanning 7 different PDF pages): the relationship `vat ≈ round(value × 0.13)` held with a **maximum deviation of ₨1**, and was exact in 10 of 14 cases. This makes it a far stronger validation signal than any single OCR'd field, because it cross-checks two independently-read fields against a known mathematical constant rather than relying on a third field's own (separately fallible) OCR read.

### item5 investigation (full detail)

The `५. डेबिट-क्रेडिट` (item5) field's checksum was found, during Phase 2's verification, to fail on nearly every page of the real test document. Rather than accepting "OCR is just noisy," this was investigated in Phase 3 and attributed to **three separate, distinct root causes**, not one:
1. **Coordinate drift**: item5's box was only ever validated against page 1 before Phase 3 (unlike the main table fields, which were cross-validated against pages 1, 5, and 10). Visual inspection across 5 pages in Phase 3 found the original tight box landing on the wrong row's content on some pages (specifically appearing to catch the जम्मा/Total row's debit-column value instead) — fixed by widening the box's height.
2. **Sign-stripping bug**: item5 can legitimately be negative (a credit-carrying month), but the digit-only OCR whitelist cannot represent a minus sign, so the OCR'd value is always non-negative. The old code compared `computed === printed` directly, which is mathematically guaranteed to fail whenever the true computed difference is negative, *regardless of how well OCR read the digits*. Fixed via absolute-value comparison.
3. **Over-strict confidence gate**: the old code required `confidence > 0` for the checksum to even be considered. Directly falsified: page 1's item5 crop OCR'd to `"444349"` — the exactly correct value — yet Tesseract reported 0% confidence for that read. Fixed by removing the gate; confidence is now surfaced as separate, non-gating information.

Even after all three fixes, item5 remains a **supplementary, non-blocking** signal by design — it was never made a hard-blocking check, unlike the VAT-rate relationship, because its reliability, while improved, was not established with the same rigor (14 verified real pairs) that justified the VAT-rate check's blocking status.

### PDF assumptions (what this module currently assumes, all evidence-based but scoped to one document)

- Every page is exactly one full-width (`a≈595`, `e≈0`) embedded image, no other content.
- Page size is always `595×842pt` (A4).
- The image's vertical placement margin varies per page (confirmed, corrected for) but its horizontal placement is always flush-left with zero margin (confirmed on the pages checked, **not independently corrected in code** — if a future PDF has a horizontal margin, X-coordinates would silently misalign with no detection).
- Numerals are always Western Arabic digits (confirmed for this document; a different filer/scanner using Devanagari numerals would simply produce empty/low-confidence OCR reads for every numeric field, which — while safe, since it would get flagged rather than silently trusted — has never actually been tested).
- Pages are monthly and appear in strict chronological order within the PDF (load-bearing for the sequential month-inference fallback).
- The internal row/column layout (where "१.१ कर लाग्ने विक्री" sits relative to the page) is assumed identical to the one document calibrated against — untested against any other filer, scanner, or IRD form revision.

### Calibration process (how the coordinates in `VAT_FIELD_BOXES` were actually derived — not committed as reproducible tooling, see §7)

Coordinates were derived through an iterative, empirical crop-and-view process using a Node.js scratchpad harness (never committed to the repo): `pdfjs-dist` (Node build) + the `canvas` npm package to render pages and crop regions, `tesseract.js` to OCR the crops, and `pdf-lib` to inspect raw PDF structure (content streams, image placement matrices). The general method for any one field: crop a generously-sized region around the expected position, view it (via the `Read` tool on the saved PNG/JPEG), narrow the crop iteratively until it tightly isolates just the target digits with no adjacent content, then confirm with a real OCR test. This took multiple iterations per field in some cases (the period field specifically took roughly 8 iterations across several test sessions before landing on a reliable box). The single most important structural discovery from this process was the per-page CTM margin variance described in §2 — found by comparing three pages' raw content-stream placement matrices directly, not assumed.

### Remaining technical debt

- **The calibration tooling described above has never been committed to the repository.** It exists only as this conversation's tool-call history. If IRD changes the form, or a recalibration is ever needed, there is currently no reproducible starting point beyond this document's prose description — re-deriving the CTM-tracking approach, the margin-variance finding, and the coordinate grid would have to be redone from scratch. **This is explicitly Phase 5's objective** — see §6.
- **Only one real PDF (one company, 10 pages) has ever been used for testing**, throughout Phases 0–3. Every claim about accuracy, calibration robustness, and validation-check reliability is grounded in that single document. **This is explicitly Phase 6's objective.**
- Rows 21–22 of the real reference template are not reproduced in the generated workbook (§2, §6 Phase 4).
- The review table's last column header still literally says "Checksum" in `index.html` (line ~763) even though it now renders the consolidated `vatRowWarnings()`-based status indicator, not a raw checksum result. Cosmetic, not functionally wrong, not yet fixed.

---

## 5. Current Production Readiness

### What's production-ready

- The **business-rule / Excel-formula layer** (`vatBuildMonthRows()`, the ExcelJS generation in `vatGenerateExcel()`) is deterministic, formula-verified against the real reference template (Difference/Total/VAT-Paid formulas confirmed identical to the original, cell-by-cell), and handles missing months correctly.
- The **structural validation gate** reliably rejects wrong-document uploads before any OCR runs, verified against 5 distinct synthetic failure scenarios plus the real valid document.
- The **duplicate-month detection and blocking mechanism** is robust — proven to catch cascading collisions correctly even across multiple sequential user edits, not just the original single-collision case.
- The **VAT-rate validation** is a strong, well-evidenced safety net that has been shown to correctly flag every genuine data-quality problem found in the one real test document, with zero false positives.
- **Zero AI/API dependency, zero data leaves the browser** — confirmed by full code-path inspection (the only network calls anywhere in this module's execution are the CDN library loads at page-load time and, once, Tesseract.js's own one-time generic English language-model download from its default CDN — never the uploaded PDF or any extracted figures).

### What's not production-ready

- **Only tested against one real client's PDF.** No evidence yet about how well the structural anchors, coordinate calibration, or OCR accuracy generalize to a different filer, scanner, or IRD form revision. This is the single biggest open risk.
- **item5's coordinate box was widened based on visual inspection, not re-validated with a full OCR accuracy re-test after the change** — the Phase 3 verification confirmed the *blocking logic* works correctly end-to-end, but did not specifically re-measure item5's raw OCR pass rate after the coordinate widening.
- **Rows 21–22 of the real template are missing from generated output** — anyone comparing byte-for-byte against a real prior-year file will notice.
- **No calibration tooling is committed** — a real maintainability risk if this needs to be touched again without this conversation's context (mitigated by this document, but the actual *tooling* — scripts, not just prose — doesn't exist in the repo).
- **The header row's "Tax Free Sales " trailing-space mismatch** and the "Checksum" column-header staleness are known, low-priority cosmetic gaps.
- **Horizontal image placement is not independently corrected** — untested against any document where it might not be flush-left.

### Priority order for closing these gaps

1. Phase 6 (multi-document validation) — until this happens, "production ready" cannot honestly be claimed at all, regardless of how solid the single-document testing looks.
2. Phase 5 (commit the calibration tooling) — cheap, prevents the debt from compounding, and is a prerequisite for anyone (including a future Claude session) doing Phase 6 efficiently.
3. Phase 4 (complete workbook — rows 21/22) — a real gap but lower risk than the above two (it's a known, bounded, cosmetic-to-moderate omission, not a correctness-under-uncertainty risk).

---

## 6. Remaining Roadmap

As explicitly planned with the user, phases are worked one at a time, each requiring approval before the next starts. **None of the phases below have been started.**

### Phase 4 — Complete Workbook
- Compare the generated workbook against the real original template line-by-line (a real reference file exists at `G:\My Drive\2081.82\Vat Return 2081.2082\Parewashwori Oil Stores 2081.082.xlsx` — read via ExcelJS during the original feasibility investigation, not yet re-diffed against current generator output).
- Reproduce every missing row — specifically investigate rows 21–22 (their exact purpose was never conclusively determined; do not guess, verify against the real workbook's actual behavior/intent before implementing).

### Phase 5 — Calibration Tooling
- Commit the calibration process (currently only in scratchpad/conversation history) as real, reproducible tooling in the repository.
- Document: coordinate calibration methodology, the CTM per-page margin correction approach, OCR assumptions, why each coordinate was chosen, and exactly how a future developer should recalibrate if IRD changes the form layout.
- Goal stated explicitly by the user: future sessions must be able to reproduce the template/calibration without relying on conversation history — this document (§4's "Calibration process") is a start, but Phase 5 should produce actual runnable scripts, not just prose.

### Phase 6 — Multi-document Validation
- Do not claim production-ready from testing against one PDF.
- Build a validation checklist/framework for testing against many real VAT Return PDFs (the user has several more sitting in `C:\CHROME DOWNLOADS\`, seen during the original feasibility investigation: `COenergyprivatelimited 2080.pdf`, `JAY NEPAL KHADYANA STORE VAT RETURN VERIFY OF JESTHA.pdf`, `NAWA ASHRYA STORE VAT RETURN.pdf`, `parmeswori oil stores put Ltd. vat return documents (1).pdf`/`(2).pdf`/no-suffix variant, `popular oil distributor vat return.pdf` — these have not yet been tested against this module, only the `(2)` variant of the Parewashwori file was used throughout Phases 0–3).
- Record, per document: pass/fail on structural validation, OCR confidence distribution, which specific fields were problematic, and overall extraction accuracy.
- Explicit instruction from the user: **do not fabricate results — only report what was actually tested.**

---

## 7. Open Issues

- Horizontal PDF-page placement margin is assumed zero and not independently corrected (§4).
- The Tesseract.js one-shot-vs-worker API divergence (§4) has no confirmed root cause, only a documented workaround (architectural validation, not a Tesseract fix).
- The `tessedit_pageseg_mode` (PSM) experiments in Phase 0/3-era investigation did not resolve isolated-single-character OCR failures — this remains unexplained.
- item5's coordinate box widening (Phase 3) was visually verified but not re-benchmarked for raw OCR pass-rate improvement specifically.
- No calibration tooling is committed to the repo (Phase 5's whole purpose).
- Only one real document has been used for all testing to date (Phase 6's whole purpose).
- Rows 21–22 of the real template are unreproduced (Phase 4's whole purpose).
- Minor cosmetic: header trailing-space mismatch (§2), stale "Checksum" column header text in `index.html`.

---

## 8. Files Modified

| File | What changed and why |
|---|---|
| `js/vatReturn.js` | **New file.** The entire VAT Return module: structural validation, PDF rendering/margin correction, OCR extraction, confidence/validation/blocking logic, business rules, Excel generation. ~620 lines as of `1e02381`. |
| `index.html` | Added 3 CDN `<script>` tags (`pdfjs-dist@3.11.174` × 2 files, `tesseract.js@7.0.0`, `exceljs@4.4.0`) and one local `<script src="js/vatReturn.js">` tag (ordered after `clients.js`, before `sendDocument.js`/`report.js`/`bmAgmMinutes.js`/`auth.js` — after `clients.js` since the module may reference `window.clientsList` in future work, before `auth.js` since that triggers the app's boot sequence). Added the `#regd-vatReturn-panel` sub-tab markup (~lines 709–774): company/opening-balance/fiscal-year inputs, PDF upload + extract button, review table shell, generate button. |
| `js/tabs.js` | Added `'vatReturn'` to the `subs` array in `switchRegdSub()` (line 19) so the new sub-tab participates in the existing Company Registrar sub-tab switching logic. One-line change. |

No other files were touched. No database schema changes. No new Supabase tables.

---

## 9. Testing Performed

**Every claim below reflects testing actually performed and directly observed in this project's session(s) — nothing here is inferred or assumed.**

### Real-PDF end-to-end testing
The same one real reference PDF (`C:\CHROME DOWNLOADS\parmeswori oil stores put Ltd. vat return documents  (2).pdf` — 10 pages, company "Parewashwori Oil Stores Pvt.Ltd", PAN `609570966`, periods spanning Shrawan 2082 through Baishak 2083) was used throughout Phases 0–3, temporarily copied into the served app directory for browser `fetch()` access during each testing session and deleted immediately afterward (never committed).

- **Phase 0 (initial build)**: full pipeline exercised end-to-end via `preview_eval` against the real running app (not a mock) — file upload simulated via `DataTransfer`/`File`, `vatExtractPdf()` called directly, results inspected via `window.vatExtractedPages`. Generated workbook read back via ExcelJS to confirm exact formulas (`D7-G7-J7+L7-M7`, `P6+O7-N7`, `SUM(C7:C18)`) and values against known-correct source data.
- **Phase 1**: structural validation tested against the real PDF (still passes, extraction unchanged) and 5 synthetic negative-control PDFs generated via `pdf-lib` (wrong page count, wrong page size, blank page, unrelated vector document, unrelated raster-image document) — all 5 correctly rejected pre-OCR with distinct, accurate reasons.
- **Phase 2**: timed via `performance.now()` (21.3s → 5.1s), memory via `performance.memory.usedJSHeapSize` (delta −1.0MB). Full 10-page extraction re-run twice for internal-determinism check. Isolated single-crop A/B test (`Tesseract.recognize()` vs `worker.recognize()` on the identical image) run directly in-browser to root-cause the "not identical to before" finding.
- **Phase 3**: full 10-page extraction with the new validation layer; every page's warnings inspected directly (`window.vatRowWarnings()`); `vatGenerateExcel()` confirmed to block with the exact expected itemized reasons; every flagged issue then resolved through the actual review-table UI elements (`<select>`/`<input>` `change`/`input` events dispatched, exactly as a real user's interaction would fire them, not by mutating state directly) until generation succeeded, producing a valid workbook (confirmed by size).

### OCR-specific testing (outside the shipped code, via Node.js scratchpad harness)
Extensive per-field coordinate calibration and accuracy testing was performed in a Node.js harness (`pdfjs-dist`, `canvas`, `tesseract.js`, `pdf-lib` — all installed via `npm install` in the session's temp scratchpad directory, never committed) across many iterations, including: individual field crop-and-OCR tests on pages 1, 5, 6, 8, 10; the discovery and verification of the per-page CTM margin variance (compared 3 pages' raw content-stream matrices directly); the discovery that fixed-pixel coordinates fail across pages with differing rendered dimensions, fixed via proportional coordinates; multiple `tessedit_pageseg_mode` experiments (unsuccessful); and the 14-pair VAT-rate verification computation (plain arithmetic, not OCR-dependent, run directly in Node).

### Regression testing
After every phase, all other tabs and Company Registrar sub-tabs (Send Document, Generate Report, Clients, Send Logs, Share Transfer, Increase Capital, Company Registration, Auditor Change, PIN Reset, BM/AGM Minutes) were checked via `preview_eval` (activating each panel and confirming non-zero rendered height) and browser console logs checked for errors (`preview_console_logs`) — clean (zero errors) after every single phase.

### What was explicitly NOT tested
- Any PDF other than the one reference document.
- Real Google-OAuth-authenticated browser usage (all testing bypassed the auth wall via direct DOM manipulation, a pattern established earlier in this project's session for testing gated UI — this is standard practice in this project, not a VAT-specific limitation).
- Performance/memory on any machine other than the development sandbox (Phase 2's benchmark numbers are real but from one machine, not a spread of hardware tiers).
- Visual/pixel-level screenshot verification for parts of this session — the `preview_screenshot` tool exhibited intermittent unexplained timeouts during this project's later sessions (confirmed environmental/tool-level, not code-related, by observing that `preview_eval`/`preview_console_logs` continued working normally throughout); DOM-level (`outerHTML`) inspection was used as a reliable substitute where visual confirmation was needed.

---

## 10. Exact Opening Prompt for the Next Session

Paste exactly this into a new Claude Code conversation:

```
Read HANDOFF_VAT.md in the project root (C:\AUTOMATION AI APP) completely
before doing anything else — it's a complete, self-contained handoff
document for the VAT Return Automation module, an OCR-based, zero-AI
feature that reads Nepali IRD VAT Return PDFs and generates the firm's
standard Excel workbook. Also skim HANDOFF.md in the same directory for
context on the rest of the application (it predates this module).

Three phases are complete and pushed to origin/main (commits f78ddf1,
495df26, 1e02381 — verify this with git log before assuming anything).
Phases 4, 5, and 6 are planned but not started (see HANDOFF_VAT.md
section 6 for exact scope of each).

Do not start any new phase yet. First, confirm you've read and understood
HANDOFF_VAT.md by summarizing back to me: the current architecture, what
each completed phase did and why, the most important engineering
discoveries (especially the per-page PDF margin variance, the
Tesseract.js worker-API discrepancy, the VAT-rate validation, and the
item5 investigation), and what's explicitly NOT yet production-ready.
Wait for my confirmation that your summary is accurate before proceeding
to any phase.

Follow the same working pattern used throughout this project: investigate
first with real evidence (a Node.js scratchpad harness using pdfjs-dist,
tesseract.js, canvas, and pdf-lib has been used throughout — reusable if
still present in the session temp directory, otherwise reinstall as
needed, never commit it directly, that's Phase 5's job), implement only
what's justified by that evidence, verify in the real browser against
real PDFs (not just assumptions), regression-check the rest of the app,
self-review, then exactly one commit per logical phase/step.

Hard rules, unchanged from the whole project: never push without asking
me first, every single time, no standing approval. Never execute SQL
migrations yourself. Never rewrite git history without explicit approval.
One logical change per commit. Do not modify working code unnecessarily.
If you find a better deterministic method than OCR for anything, stop
and tell me before writing more OCR-dependent code.
```
