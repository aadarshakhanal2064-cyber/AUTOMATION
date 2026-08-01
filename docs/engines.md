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
| WorkflowEngine | `workflowEngine.js` | `attachFormWatcher`, `createDebouncedRefresh` (staleness-guarded live preview), `createAutosave` (localStorage draft), `updateCompletionIndicator`, `createZoomControl`, `createStatusFlow` (one `transition()` choke point per status-tracked module — badge, persistence, and audit entry can never disagree), `createClientScope` (one choke point per module for "which client is this screen showing?" — see below). |
| AuditLog | `auditLog.js` | `record(eventType, detail)`, `recent`, `countSince` → Supabase `audit_log`. Every call is try/catch-wrapped and never throws — a logging failure must not break the feature. |
| WorkbookReader | `workbookReader.js` | `num`, `norm`, `grid(ws, XLSX)`, `findSheet(wb, keys)`, `findRowIdx(g, re, from, labelCol)`, `findHeader(g, from)`, `labelValue(...)`, `noteSection(g, titleRe, endRe?)`. Locating figures inside the firm's hand-maintained NFRS workbooks — extracted from `projectionEngine.js` on 2026-07-26 when Financial Statement needed the same locators. **Everything is label-driven, never positional**: `findHeader` finds the literal `particulars` cell and takes the first non-empty non-`notes` column right of it as `valCol`, the second as `prevCol`, which is why SFP→F, Sch-PL→D and Sch-BS→H all work from one function — **never hardcode a value column**. `noteSection` fences a numbered note at the CLOSER of its own Total row and the next numbered note, because not every note has a Total (Sch-BS 3.2 ends at "Current portion", and a Total-only fence read 3.3 and 3.4 as its own). Node-loadable. |
| EngineMath | `engineMath.js` | `seededRng(key)`, `round1000Up/Down`, `deRound`. Pure numerics shared by the two financial engines, kept separate from WorkbookReader because parsing and arithmetic are different concerns. `seededRng` is what makes the "unique on each case" figures the firm's sheets ask for (projection's cash and creditors, Financial Statement's cash) **reproducible per client** rather than different on every run. Node-loadable. |
| DataCache | `dataCache.js` | `get`, `invalidate`, `invalidateAll` — see below. |
| OcrEngine | `ocrEngine.js` | `checkHealth()`, `extractText(file)`, `NOT_RUNNING`. Client for the local PaddleOCR service (`ocr_service/`) — the only engine that talks to something other than a CDN library, Supabase or Google. Added 2026-08-01. Its real job is **error translation**: that service legitimately isn't running most of the time (staff start it on demand), and a `fetch()` to a dead loopback port rejects with a bare "Failed to fetch" that tells the user nothing — so every network-level rejection becomes `NOT_RUNNING`, which names the start script. Service-returned errors keep the API's own `detail` message instead, so "unsupported file type" isn't reported as "not running". Base URL comes from `window.OCR_SERVICE_URL` (`js/config.js`); it must agree with the CSP `connect-src` in `index.html` and `ALLOWED_ORIGINS` in `ocr_service/config.py` or the call never leaves the page. |
| ReportExport | `reportExport.js` | `toHtml` / `toPdf` / `toExcel` / `download(model, kind, filename, meta)` over one tabular model (`{title, subtitleLines, columns, rows, landscape, note}`; row styles `section`/`subtle`/`total`/`grand`). Added 2026-07-26 for Party Ledger's 4 views + Final Account's 2 statements — six consumers that would otherwise each have copied the drawing code already sitting twice in `bankBook.js`. It knows nothing about ledgers or firms: callers hand it finished cells. **`pdfSafe()` inside it is load-bearing** — PDF-Lib's standard fonts are WinAnsi and *throw* on any character they can't encode (a true minus `−`, a curly quote, Devanagari), so every string is folded to ASCII/Latin-1 on the way into the PDF. |

**Adding a new tab/sub-module:** create `js/<module>.js`, call `ModuleRegistry.register()` from it, add the panel + nav button to `index.html`, add the `<script>` tag in load order, prefix all element IDs (§10.2). No edits to `tabs.js`.

### `WorkflowEngine.createClientScope({ clear, load })` — client switching

Added 2026-07-28 after the same defect was found in eleven modules at once: every
`xxSelectClient` only ever *wrote* the newly picked client's values, so anything
the new client didn't supply kept the previous client's. It surfaced three ways —
a conditional fill (`if (c.chairman_name) …`) leaving the last company's chairman
on a signed resolution; a loader returning early ("no saved schedule for this
client") and leaving the previous client's grid on screen under the new name;
and module state (`pjSavedId`, Send Document's `window.foundFile`, an imported
workbook) outliving the client it belonged to. Two of those were data-integrity bugs, not
cosmetic: a stale `pjSavedId` made Save **UPDATE the previous client's**
`projection_reports` row, and a stale `window.foundFile` would have emailed one
client's document to another's address. (Send Document was removed 2026-08-01,
so that second example is historical — the lesson it taught is not.)

The scope inverts the order so the failure mode is structurally impossible:

```js
const xxScope = WorkflowEngine.createClientScope({
  clear(reason) { /* 'client' → identity fields + data; 'context' → data only */ },
  load(c, reason) { /* fill from the record, then fetch what's saved */ },
});

xxScope.select(client);   // clear('client')  then load()  — client picked
xxScope.refresh();        // clear('context') then load()  — FY / scheme changed
xxScope.invalidate();     // free-typing over the picked name; nothing may save against the old id
xxScope.reset();          // back to empty
```

**`clear()` runs unconditionally before every `load()`.** That is the whole
point: because the surface is already blank when the loader runs, no path
through it — an early return, a thrown error, a slow network — can leak the
previous client's data, and `load()` never needs to clear anything itself.

Two rules go with it, and they are what the point-fixes enforce:

1. **Always assign.** `el.value = c.x || ''`, never `if (c.x) el.value = c.x`.
   Give selects an explicit default rather than leaving them untouched.
2. **A loader's early returns are safe only because the clear already ran** —
   don't move clearing back inside the loader.

Consumers: Depreciation (both workings share one scope), Financial Statement,
Projection, Autobooks, Confirmation Letters. Modules whose picker lives in a
record-creation drawer (Billing, Bank Entry, Service Memo) reset on form open
instead and need no scope; Party Ledger and Final Account regenerate their whole
view every time and are already safe.

**Uploaded workbooks are discarded on a client switch** (user decision,
2026-07-28) with a status line saying so, rather than kept or guarded by a
confirm dialog — an import belongs to exactly one client, and re-uploading is
cheap next to generating a workbook for the wrong one.

---


---

### `DataCache` — the shared ledger loads

`js/core/dataCache.js`. A 60-second, key-addressed cache in front of the
full-table loads that Bank Entry, Party Ledger and Final Account share.

**The problem it solves.** `tabs.js` `openModule()` calls a module's init on
*every* open with no "already opened" guard, and those three modules each
refetched unconditionally. Opening Bank Entry → Party Ledger → Final Account
downloaded `bank_transactions` in full **three times**. Measured after the
change: 10 round-trips → 5, with `bank_transactions` down to 1.

**Two design choices worth knowing:**

- It caches the **promise**, not the resolved rows, so two modules opening in
  quick succession share one round-trip instead of racing two.
- A **rejected load is evicted immediately** (guarded so a later success isn't
  thrown away by an older failure), so a network blip can't be served from
  cache for the rest of the TTL.

**Keys live in `config.js` as `window.LEDGER_KEYS`, not in a module**, because
they are cross-module by definition and `config.js` loads first. A key encodes
its **ORDER BY**, not just the table — this is load-bearing, not decoration:
Bank Entry loads `bank_accounts` ordered by `(sort_order, account_name)` while
Party Ledger uses `(sort_order, id)`, and `faBankAccounts()` renders that array
in order, so a single shared key would silently reorder Final Account's bank
list. `bank_accounts` is a handful of rows, so two keys cost nothing;
`bank_transactions` is the big one and its query is byte-identical in both
modules, so it genuinely shares.

**The invalidation rule — this is the part that breaks if you get it wrong.**

- `xxRefresh()` **reads only**. It must never invalidate, or opening the tab
  would defeat the cache it is meant to be using.
- `xxReload()` = invalidate + refresh. **Every write path calls this.**
- A reload drops **every key for the affected table, across modules**. A
  Service Memo write drops `memosSm` *and* `memosPl`, because Party Ledger
  reads the same table under a different query — otherwise a new memo would
  not appear on the ledger until the TTL expired.
- `signOut()` calls `invalidateAll()`. Cached ledger rows are user data, the
  same as `window.clientsList`, and must not survive into the next session on
  a shared machine.

**Adding a write path to one of these four tables means adding its
invalidation.** The TTL is a safety net for *another* staff member's writes,
not a substitute for invalidating your own.
