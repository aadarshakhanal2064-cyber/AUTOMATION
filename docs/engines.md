# The Engine Layer (`js/core/`) — deep reference

> Loaded on demand, not in every session. **CLAUDE.md §4** carries the always-loaded
> catalogue (one line per engine, which is what you need to know an engine exists);
> this file keeps the full rationale and the load-bearing implementation notes.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

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

