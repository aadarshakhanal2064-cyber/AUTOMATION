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
| NepaliLocale | `nepaliLocale.js` | `toEnglishDigits`, `toDevanagari`, `formatAmount` (lakh/crore), `parseBsDate`, `fiscalParts`, `todayBs`, `NEPALI_MONTHS`, **`fyStartYear`**. B.S. calendar table covers **2080–2090 — extend before 2090**.<br>`fyStartYear(value)` returns the start year as a number from a fiscal year written in **any** of the firm's five formats (`2081-82` · `2081/82` · `2081/082` · `2081.2082` · `2081`), Devanagari included, or `null` when no 4-digit year is present. Those formats differ per module by decision (CLAUDE.md §8) — this is the boundary normalizer that lets two modules be **joined** on fiscal year without unifying how either displays it. Added 2026-08-09 for Work Done's Pending List, which joins `document_register` (free text, dash) to `work_done` (dropdown, slash); comparing the raw strings there matches nothing and fails *silently*. Returning `null` rather than guessing is deliberate, so callers can report unmatchable rows instead of dropping them unnoticed. |
| DocumentEngine | `documentEngine.js` | `downloadBlob(blob, filename, meta?)` (meta fires an AuditLog event), `getTemplate(url)` (fetch-once cache), `renderWord(buffer, data)` (PizZip+docxtemplater), `previewWordAsHtml(...)` (docx-preview). **`buildPrintableHtml` waits for docx-preview's tab stops to settle before serializing** (2026-08-24) — in `experimental` mode docx-preview emits every real tab as a bare `<span class="…-tab-stop"> </span>` and sizes it in a **`setTimeout(500)`** fired at the end of `renderAsync`, measuring the live DOM and writing the width back as an inline `word-spacing`. An offscreen render that serialized immediately therefore captured every tab as a single SPACE, so print / Save-as-PDF bunched tabbed columns together while the on-screen preview — a live DOM still attached when the pass ran — showed them correctly. `settleTabStops()` polls for the first sized span (one timer covers the whole document, and a document with no tabs returns at once) with a 2s backstop that resolves rather than throws, since losing tab widths beats never opening the print window. It runs **after** fitting and pagination on purpose: non-flow documents are scaled there, and the pass has to measure the final geometry. Live previews deliberately do NOT wait — settling asynchronously on screen is exactly right. Consumers: BM/AGM (22 tab spans), Company Secretary (2), Company Registration (the founder-pair block). `auditorChange.js` builds its two-page print document through its OWN offscreen render (`acRenderDocForPrint`) and has the identical latent trap — it is safe today only because those two templates contain zero tab spans, so anything tabbed added there must call this first. |
| SearchEngine | `searchEngine.js` | `attachAutocomplete(inputEl, listEl, config)` / `buildIndex` wrapping Fuse.js. One shared autocomplete (keyboard nav included); supports `normalizeQuery/normalizeItem` for digit-agnostic search. |
| TableEngine | `tableEngine.js` | `createTable(container, options)` wrapping Tabulator with the app's `.app-table` look. Only the Clients directory uses it (deliberate — don't migrate other tables without cause). |
| WorkflowEngine | `workflowEngine.js` | `attachFormWatcher`, `createDebouncedRefresh` (staleness-guarded live preview), `createAutosave` (localStorage draft), `updateCompletionIndicator`, `createZoomControl`, `createStatusFlow` (one `transition()` choke point per status-tracked module — badge, persistence, and audit entry can never disagree), `createClientScope` (one choke point per module for "which client is this screen showing?" — see below). |
| AuditLog | `auditLog.js` | `record(eventType, detail)`, `recent`, `countSince`, `query({sinceIso, untilIso})` → Supabase `audit_log`. Every call is try/catch-wrapped and never throws — a logging failure must not break the feature. **`record()` reads camelCase detail keys** (`clientName`, `recordRef`) and silently drops snake_case ones — six modules were passing `client_name`/`record_ref` and writing null client names for a month (fixed 2026-08-10). **`query()` is bounded on purpose**: `audit_log` only grows, so callers pass a window rather than pulling the table; Work Done's Activity Log defaults to 90 days. |
| WorkbookReader | `workbookReader.js` | `num`, `norm`, `grid(ws, XLSX)`, `findSheet(wb, keys)`, `findRowIdx(g, re, from, labelCol)`, `findHeader(g, from)`, `labelValue(...)`, `noteSection(g, titleRe, endRe?)`. Locating figures inside the firm's hand-maintained NFRS workbooks — extracted from `projectionEngine.js` on 2026-07-26 when Financial Statement needed the same locators. **Everything is label-driven, never positional**: `findHeader` finds the literal `particulars` cell and takes the first non-empty non-`notes` column right of it as `valCol`, the second as `prevCol`, which is why SFP→F, Sch-PL→D and Sch-BS→H all work from one function — **never hardcode a value column**. `noteSection` fences a numbered note at the CLOSER of its own Total row and the next numbered note, because not every note has a Total (Sch-BS 3.2 ends at "Current portion", and a Total-only fence read 3.3 and 3.4 as its own). **`HEADS` is the shared account-head vocabulary** (2026-08-29): one table of per-head regexes (capital, reserves, ppe, receivables, payables, cash, loans, provisions, investments, the SOCF distribution row, the totals) that BOTH parsers of this workbook family match against, tested against `norm()`'d labels. It exists because per-caller regexes drifted twice in the same way — most recently the Provisional module began printing "Proprietors Capital" (entity-worded capital, 2026-08-28) and Projection Report, still matching /share capital/ alone, read a nil capital off a file this app had generated itself. The capital pattern demands a qualifier (share/proprietors/partners/promoters/owner's) or the bare word alone, so it can never catch "Capital Work in Progress" or "Permanent Working Capital Loan". **`entityFromCapitalLabel(label)`** turns that wording into an entity — `'proprietorship'` / `'partnership'` / `null` — so a module can learn what a statement IS from the document itself rather than from a client record that may be blank; it is asymmetric on purpose, since plain "Share Capital" was printed for every entity by the older template and therefore declares nothing. **A new spelling goes in `HEADS`, never in a caller**, and `node tools/headsVerify.mjs` proves the matrix, the write-read round trip and (with `CORPUS=<dir>`) a sweep over real files. Node-loadable. |
| EngineMath | `engineMath.js` | `seededRng(key)`, `round1000Up/Down`, `deRound`. Pure numerics shared by the two financial engines, kept separate from WorkbookReader because parsing and arithmetic are different concerns. `seededRng` is what makes the "unique on each case" figures the firm's sheets ask for (projection's cash and creditors, Financial Statement's cash) **reproducible per client** rather than different on every run. Node-loadable. |
| NepalTax | `nepalTax.js` | `compute({returnType, location, d2Nature, entity, special, filing, turnover, taxableProfit})` → `{returnType, base, rate, tax, label, workings[], warnings[]}`, plus the tables themselves (`LOCATIONS`, `RETURN_TYPES`, `D2_NATURES`, `LADDERS`, `ENTITY_RATES`), `returnTypeFromClient(itReturnType)` and **`autoReturnType({entity, turnover, taxableProfit})`** — the statute as a decision tree (entity → 30-lakh presumptive ceiling → 1-crore / 10-lakh-income turnover-tax gate → D-3), each answer naming the threshold that decided it; `compute()` with no `returnType` resolves through it and returns the resolution as `auto`. Added 2026-08-29 for Audited Statement, from a rule sheet the firm's chartered accountant supplied, cross-checked line by line against the Income Tax Act 2058 for **F.Y. 2082-83**. **It is an engine rather than two more constants in the statement engine because two of the three rules do not read profit at all** — a D-1 charge is a flat figure decided by the client's municipality and a D-2 charge is a percentage of *turnover*, neither of which can be written inside an expression whose only variable is `taxableProfit`. Turnover bands are computed **marginally over Rs 30,00,000 on top of the location base** rather than stored as the six pre-summed figures the Act publishes, because six stored figures is how the three location tiers drift apart — `tools/taxVerify.mjs` asserts the marginal form reproduces every published one. `workings[]` is returned so a screen can *show* the arithmetic instead of asserting a figure (the CA's sheet has an "Example" column for the same reason) and so the harness can assert the workings foot to the charge. `warnings[]` fires where the RULE and the FIGURES disagree — a D-2 return over the Rs 1 crore turnover or Rs 10,00,000 income ceiling, a D-3 proprietor still inside the D-2 range — and is **shown, never silently corrected**, the same rule the statement's proof rows follow. `returnTypeFromClient` maps the directory's `'D-01'/'D-02'/'D-03'` and returns **null for `'D1/D2'`**, which genuinely means "one of the two, the preparer decides" (CLAUDE.md §15) — a prefilled guess there would be a guess nobody could see. Node-loadable; the statement engine `require`s it in Node and reads the global in the browser, so `tools/psVerify.mjs` keeps working by requiring the statement engine alone. |
| DataCache | `dataCache.js` | `get`, `invalidate`, `invalidateAll` — see below. |
| DocumentStore | `documentStore.js` | `save(id, payload)` / `list(module)` / `get(id)` / `remove(id)` / `openPicker({module, label, onOpen})` / `search(q)` over the `saved_documents` table. Added 2026-08-02 so the HTML document builders can be re-opened, edited and reprinted after the fact. **Saves BOTH the form state and the rendered HTML**: the state alone loses every hand-edit made in the contenteditable preview — which is the document the firm actually issued — and the HTML alone could be reprinted but never edited again. `list()` deliberately selects a column subset: `doc_html` is often tens of KB and the picker never draws it. **Nothing here caches** — a stale list in a "find the report I lost" screen is the one thing it must never show. The picker is one shared drawer in `index.html` (`ds-` ids) rather than per-module markup, so the list, the empty state and the delete confirm exist once. `save(null, …)` inserts, `save(id, …)` updates; consuming modules null their saved id when the client or fiscal year changes, since those two are the document's identity (the same stale-id trap `pjSavedId` hit). **The picker takes records from anywhere** (2026-08-11): passing `{fetchRows, describe, onChoose, onDelete}` instead of `{module, onOpen}` lists rows from a different table entirely — the Projection Report browses `projection_reports`, whose shape has nothing in common with `saved_documents`. Only the *source* is swapped; the drawer, its markup, its CSS, its empty state and its delete confirm stay shared, which is the whole reason not to build a second drawer. Callers passing `module` are untouched. **`search(q)` filters the already-fetched rows in memory** (2026-08-15) rather than re-querying — it matches against what a row actually *renders as* (`describe(r).title + meta`) rather than a hardcoded field name, since callers' row shapes differ (`saved_documents.client_name` vs `projection_reports.company_name`); this is what let Report Builder, Notes to Accounts and Projection Report all gain a client-name search box for the cost of one change to the shared drawer, with zero changes to any of the three callers. **Search tries a plain substring FIRST and only falls back to Fuse** (2026-08-17): Fuse's typo tolerance is right for a half-remembered company name and actively wrong for a fiscal year — at `threshold: 0.3` with `ignoreLocation`, `"2078"` scores as a match against `"2082-83"`, so typing a year returned the entire list. An exact substring is never a worse match than a fuzzy one, so when any row literally contains what was typed, those rows *are* the answer; the fuzzy pass still catches `Halling` → *Hauling Co.* Callers may also pass `searchPlaceholder` to say what their rows can be searched by (default keeps the original "Search by client name…"). Callers today: Report Builder, Notes to Accounts, Projection Report, **Depreciation** (`depreciation_schedules`, 2026-08-17). |
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
record-creation drawer (Bank Entry, Service Memo) reset on form open
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

## LibLoader (`libLoader.js`) — added Stage 4, 2026-08-21

On-demand loading for the five heavy vendor libraries (xlsx, exceljs,
pdf-lib, html-docx, docx-preview — ~890 KB gzip / ~2.9 MB raw). They are no
longer `<script>` tags in `index.html`.

- **`ensure(name)`** → Promise resolving to the library's global. Injects the
  same pinned CDN URL with the same SRI `integrity` + `crossorigin` the old
  tag carried; concurrent calls share one in-flight promise; a FAILED load is
  not cached, so a retry after a network blip injects a fresh tag. Names:
  `'xlsx' | 'exceljs' | 'pdflib' | 'htmldocx' | 'docxpreview'`.
- **`prefetchAll()`** — fired once from `js/auth.js` at boot-idle. In
  practice every global exists within seconds of the page settling, so the
  `await LibLoader.ensure(...)` guards at the import/export/preview entry
  points are already-resolved no-ops; they exist for the race window (a file
  import seconds after login on a slow connection), not as the normal path.
- **Where the guards live:** every `XLSX.read` file handler (9), every
  `new ExcelJS.Workbook()` generator, every PDF-Lib builder (including
  `ReportExport.toPdf`/`toExcel`, which cover all six ReportExport views),
  both html-docx Word saves, and `DocumentEngine.previewWordAsHtml`.
  Final Account's guard is unconditional for both export kinds because its
  report model bakes `PDFLib.rgb` colours in at build time.
- **A new heavy vendor goes into this registry, not into `index.html`.**
  When bumping a version, recompute the SRI hash exactly as for the
  remaining tags (CLAUDE.md §2). jszip stays an eager tag — docx-preview
  expects JSZip to exist at parse time — as do pizzip/docxtemplater
  (DocumentEngine's Word templating, small and load-bearing).

## Keyboard (`keyboard.js`) & CommandPalette (`commandPalette.js`) — Stage 6, 2026-08-21

**Keyboard** — one document-level handler:
- **Esc** closes the topmost open overlay (`.modal-overlay.open, .cd-modal.open`,
  highest z-index, then DOM order) by clicking its own `.modal-close` /
  `.cd-modal-close` — so each module's close function and cleanup run exactly
  as if the mouse had done it. SearchEngine stops Escape's propagation while
  an autocomplete list is open, so Esc there closes the list only.
- **Ctrl/Cmd+S** clicks the topmost overlay's visible, enabled
  `.action-row .btn-primary` (the real Save, busy-button contract included);
  with no overlay open it only preventDefaults the browser save dialog.
- Enter-to-save on drawer forms was deliberately not added — Enter already
  means "choose" in the pickers, and an accidental save (plus its
  duplicate-confirm dialog) mid-entry is worse than no shortcut.

**CommandPalette** — Ctrl/Cmd+K, plus the topbar "Jump to…" button:
- Three groups, never merged into one list: **Modules** (labels and go()
  actions mirror the nav buttons' own onclick exactly, init calls included —
  a nav change means updating the palette's MODULES list too), **Clients**
  (opens the Clients tab with `client-search-bar` prefilled), **Registrar
  companies** (via `RegistrarDirectory.list()` — the §15 two-directory
  separation holds here as everywhere).
- Ranking is plain lowercase starts-with > substring > all-words — a palette
  query is a prefix; Fuse's typo tolerance is the wrong trade at these
  lengths.
- DOM is built once on first open, inside `.cmdk-overlay` following the
  Stage 5 overlay convention (visibility+opacity, never display).
- `open()` no-ops before sign-in; the global Ctrl+K handler defers to the
  palette's own key handling while it is open (`isOpen()`).

**SearchEngine recents (same stage):** `attachAutocomplete` records each
selection per input (`config.recentsKey || inputEl.id`), session-scoped and
in-memory only, and offers up to 5 on focus of an empty field under a
"Recent" header — stale entries are re-resolved against the live list by
identity-or-id so a recent can never select a deleted record.

**friendlyDbError (`js/utils.js`, same stage):** every user-facing database
error string goes through it — duplicate key, permission denied, dropped
connection, expired session, FK violation, too-long value and timeouts map
to plain sentences; anything unrecognized passes through untouched.
