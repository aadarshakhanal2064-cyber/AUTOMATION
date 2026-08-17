# Depreciation

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for both depreciation methods (Income Tax pools and Accounting-Standard SLM).
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.8 Depreciation (`js/depreciation.js` + `js/depreciationSlm.js`, `dep-` prefix)
Two **methods** in one panel, chosen by a top-level toggle (`depSetMethod`, reusing `.rep-view-toggle`): **As per Income Tax** (this file) and **As per Accounting Standard (SLM)** (`depreciationSlm.js`, `dep-slm-` sub-namespace). The Client / PAN / Fiscal-Year selectors, Save/Delete buttons, `dep-status` and the carry-forward banner are **shared**; the header Import/Generate buttons and `depReloadForContext`/`depSave`/`depDelete`/`depImportExcel`/`depGenerateExcel` branch on `depMethod` and delegate to the `depSlm*` engine when SLM is active.

**Income Tax method** — pool-depreciation schedule (Nepal). Editable grid of 7 statutory pools; user enters opening value, three timing-bucketed additions, and disposals; the module live-computes Total Value, Depreciation Base, Depreciation, and closing WDV. Empty pools render as "–" (accounting format). Formulas: `Total = Opening + ΣAdditions − Disposal`; `Base = Opening + Add₁ − Disposal + Add₂·⅔ + Add₃·⅓`; `Depreciation = Base×rate` (WDV) or `Base÷years` (SLM); `WDV = Total − Depreciation`.
- **Two schemes, one engine** (`DEP_SCHEMES`, toggled by a segmented control): **normal** = standard Income Tax rates (A Building 5%, B Furniture 25%, C Vehicles 20%, D Plant 15% — reducing balance); **special** = Special Industries, where A–D depreciate at the accelerated rate (normal × 4/3 = the 1/3 additional depreciation the Act grants → A 6.667%, B 33.333%, C 26.667%, D 20%). The special rates derive from the normal ones via `DEP_SPECIAL_FACTOR` (not four magic constants). Reducing-balance rates are not user-editable.
- **Software & Leasehold years are user-editable** (SLM, any positive number of years — no longer fixed at 5); Land is never depreciated.
- **Client search** wired via `SearchEngine.attachAutocomplete` over `clientsList` (name/PAN) — selecting a client fills company + PAN and drives carry-forward. Fiscal Year is a generated dropdown (a few back years through current + 6, dash format, from `NepaliLocale.todayBs`).
- **Year-over-year carry-forward** (`depreciation_schedules` table, §6): **manual save only** — a Save button upserts on `(client_id, scheme, fiscal_year)`; **generating Excel never saves** (so testing is safe), and there's a Delete button. On client/FY/scheme change: load this year's saved sheet if present, else prefill each pool's **Opening from last year's stored closing WDV** (with a banner), else blank. Saving requires a *selected* client (stable `client_id` key); a manually-typed company name still generates Excel but can't be saved.
- **Import from Excel/ODS** (matches pools by particular text, any row order), **Addition-details helper** (itemize purchases by B.S. date → auto-bucketed into the three columns: Shrawan–Poush full, Magh–Chaitra ⅔, Baishakh–Ashadh ⅓), and **Generate Excel** via ExcelJS reproducing the template (merged headers, borders, formulas, accounting number format; scheme + editable years flow into the rate cell/formulas). The source sheet's Land Total-Value formula pointed at the Leasehold row (a real bug); the generator writes it correctly.

**Accounting-Standard (SLM) method** (`depreciationSlm.js`) — the firm's book depreciation ("Dep as Books") plus the NAS 16 **3.1 PPE note**, generated as one two-sheet `.xlsx`. **Per-asset line items** (not pooled): one row per asset, grouped by the standard PPE classes (`DEP_SLM_CLASSES` in config.js: Land, Building & Structures, Machine & Other Assets, Vehicles, Office Equipment, Furniture & Fixtures, Software, Leasehold; useful-life defaults mirror `NTA_PPE_DEFAULTS`). User enters class, particular, **Date of Use** (B.S.), **Useful Life**, **Original Cost**, and — for assets already in service — **Opening WDV** / **Opening Depreciation**.
- **The one correct formula** (reverse-engineered from the firm's `Book1.xlsx`, whose own rows had three disagreeing formula variants — only this one satisfies its `Check` column): `Depreciation = Balance × DaysInYear ÷ RemainingLifeDays`, where `Balance = OpeningWDV + Addition − (DelCost − DelDep)`. It reduces to true straight-line (`Cost ÷ Life`) for whole years, prorates partial (acquisition/disposal) years by actual B.S. days, and writes to exactly 0 at end of life. `Addition` is AUTO = Original Cost in the acquisition year (Date-of-Use's F.Y. == selected), else 0; **Land** never depreciates. `Total Dep = OpeningDep + Depreciation + Impairment − DelDep`; `Closing WDV = Balance − Depreciation − Impairment`; the **Check** column verifies `(OrigCost − DelCost) − TotalDep == Closing WDV` every row.
- **Day counts** use new `NepaliLocale` helpers (`daysInServiceThisFy`, `bsOrdinal`, `daysBetweenBs`, `fyStartBs`/`fyEndBs`) over the existing `BS_MONTH_LENGTHS` table (2080–2090). Whole years use the **365 basis** (firm's template convention); only partial periods use actual calendar days.
- **Live 3.1 PPE note preview** — a class-rollup (classes as columns: Cost open→additions→disposals→close; Depreciation open→charge→impairment→disposals→close; Carrying open/close) rebuilt on every edit. Always ties out: each class's closing carrying == Σ of its assets' closing WDV, and the grand-total closing carrying == the schedule's grand-total Closing WDV.
- **Persistence & carry-forward** reuse `depreciation_schedules` with **`scheme='slm'`** (the per-asset array lives in `pools` jsonb, with `_closingWDV/_totalDep/_remainDays/_days/_costHeldClosing` snapshots for next year). Carry-forward: Opening WDV ← prior Closing WDV, Opening Dep ← prior Total Dep, Remaining Life ← prior remaining − days used, cost constant; fully-disposed assets drop off. **Manual save only** (generating Excel never writes). Same load→carry→blank flow and banner as the Income-Tax method.
- **Addition-details helper** — the SLM counterpart of the Income-Tax one, but structurally different: SLM has no pools, so *an addition IS an asset line*. Each helper line (B.S. date, class, particular, **useful life**, amount) becomes a row in the schedule, where the Date of Use drives `Addition = cost`, a full life and the day proration. Three deliberate behaviours: **Apply is a sync, not an append** — every line carries a stable `aid` stamped onto the row it created (`fromAdd`, persisted with the row), so re-applying edits that row instead of duplicating it; **deleting a line never deletes its asset** (removal is the grid's ✕ button — a helper edit must not silently destroy a saved asset); and a date **outside the selected F.Y.** is added *with a warning* rather than skipped, because the row is visible and fixable, and the ✓ column already flags it as inconsistent. Lines persist in `addition_details` (previously hard-coded `[]` for `scheme='slm'`) and are cleared on carry-forward — last year's purchases aren't this year's additions. The Excel block lists only lines dated **inside** the F.Y., so its total always equals the grid's Addition grand total.
- **Import** seeds the grid from an uploaded "Dep as Books" sheet (header-mapped by keyword, rows matched to classes by particular text). **Generate Excel** writes both sheets via ExcelJS with faithful merges/borders/accounting format, **live formulas + cached results** (so the file reads correctly before recalc), class subtotals, a Grand Total, and the internal Check column.

### The SLM schedule is where useful lives live — Notes to Accounts reads them (2026-08-17)

`depSlmFetchUsefulLives(clientId, fy)` → `{ fiscalYear, rows:[{type, life}] }` is the one
reader Notes to Accounts calls to fill its **Property, Plant & Equipment — Estimated Useful
Life** table (`docs/modules/documents.md` §5.6). It lives here, not there, because the shape
of `pools` and the `DEP_SLM_CLASSES` vocabulary belong to this module; the consumer only ever
sees `{type, life}` and never learns the table name.

- `depSlmLifeRollup(pools)` collapses the per-asset lines to **one row per class**, in
  `DEP_SLM_CLASSES` order — the same order and the same names as the 3.1 PPE note's columns,
  so the note filed with the accounts and the schedule behind it read as one document.
- A class holding assets on **different lives prints a range** (`10–12 years`) — that is how a
  note states a mixed class. Fractional lives are real (`6.67 years` is live data) and survive.
- **Land is labelled `Not depreciated`, never `0 years`** — it sits on the schedule at a zero
  life, and printing that as a life would be a false claim in a filed note.
- A class with **no life typed comes back blank**, never falling back to the class default: the
  note may not state a figure the schedule doesn't. The caller counts the blanks and warns.
- The lookup **falls back to the most recent earlier fiscal year** (dash-format years sort
  lexicographically, which is what makes `.lt()` mean "earlier") — a useful life is an
  accounting policy, not a yearly figure, and the notes are regularly drafted before the
  year's schedule is saved. The year actually read comes back with the rows so the caller
  states it; it is never silent.

### Client identity on every output (2026-08-02)

An **Address** field (`dep-address`) sits beside Client and PAN, auto-filled from the selected client's `clients.address` and editable. `depIdentity()` is the single reader; `depXlHeader()` writes the same three-line block — company / address · PAN / schedule title · F.Y. — onto **rows 1-3 of every generated sheet**, with row 4 the separator and the grid from row 5.

The `3.1 PPE` sheet previously opened straight on its own title with **no company on it anywhere**, which made a note that had been detached and filed with the financial statements impossible to attribute; `Dep as Books` and the Income-Tax sheet carried the name but no address. Shifting the grids down one row re-based every formula automatically (they are written from the row counters, not hardcoded) — verified by reading a generated workbook back through ExcelJS.

### Output order and the signature block (2026-08-17, user decisions)

- **The 3.1 PPE note comes first, in both outputs** — Excel tab 1 and printed page 1, with the
  per-asset schedule behind it. The note is the page that goes into the financial statements;
  the schedule is the working paper supporting it. In `depSlmGenerateExcel()` **both worksheets
  are created up front**, before either is populated, because ExcelJS orders tabs by
  `addWorksheet()` call order — the population code below is unchanged and still reads top to
  bottom as schedule-then-note. `depSlmPrint()` simply concatenates `notePage + gridPage`;
  `.dp-page` already breaks between them, so the note keeps a page to itself.
- **There is no Prepared By / Checked By / For the Client block on either method's printout.**
  Nobody at the firm signs a depreciation schedule, so the rules printed as three empty lines on
  every page. `depSignBlock()` and the `.dp-sign` CSS are gone from `DEP_PRINT_CSS`.

### SLM addition lines feed the Income-Tax addition helper (2026-08-17)

`depSyncAdditionsFromSlm()` (in `depreciation.js`, which owns `dep-add-tbody`) copies each SLM
addition line's **date, particular and amount** across; only the **Pool** is left to the user.
The same purchases were being typed twice, and the second copy is the one that ends up a rupee off.

- **The pool is pre-selected from `DEP_SLM_CLASSES[].itPool`** but never re-touched afterwards.
  It is a suggestion, not a derivation — which pool an asset belongs in is a tax judgement —
  but it is a well-founded one: each Income-Tax pool's own name states the classes it covers
  (Pool B is *"Furniture, Fixture & Office Equipment"*, Pool D *"Plant & Machinery & Other
  Assets"*), which is why both `office` and `furniture` map to B and `machine` to D.
- **A sync, not an append**, the same idiom as `depSlmApplyAdditions()`: each row carries its
  SLM line's `aid` in `data-slm-aid`, so re-running updates that row rather than duplicating it,
  and a **pool the user has changed survives every re-sync**.
- **Rows typed by hand here have no aid and are never touched.** A row whose SLM line has been
  **deleted is removed** — deliberately unlike the SLM side, where a helper line's asset
  survives: the only work invested in one of these rows is the pool choice, whereas a stale line
  silently inflates the year's additions in a tax computation. The count is always reported.
- **`slmAid` is persisted in `addition_details`.** Without it a saved sheet reloads with no
  links, and the next sync duplicates every line. No migration — the column is jsonb.
- Runs automatically on **Apply to schedule** on the SLM side (reported in that status line,
  since the Income-Tax table is hidden at that moment) and on **switching back to the Income-Tax
  method**, where it waits on `depReloadForContext()` — that rebuilds the table from the saved
  sheet and would otherwise wipe the sync. The `⟳ Pull from SLM additions` button re-runs it.

### Save as PDF / Print (2026-08-02)

`depPrint()` (delegating to `depSlmPrint()` when SLM is active) builds a self-contained HTML document and opens it in a blob tab that auto-prints — the same mechanism as the Audit Report and Notes to Accounts (§8), so "Save as PDF" is the browser's own PDF writer and needs no extra library. **A4 landscape**: portrait squeezes the twelve money columns into an unreadable ribbon. SLM prints two pages, the asset schedule then the 3.1 PPE note, each carrying the full identity block.

Built from the computed figures (`p._inp` / `p._c`, `depSlmRows[]._c`) rather than by scraping the on-screen grid — **the grid is a form of `<input>` elements, which print as empty boxes.** `DEP_PRINT_CSS`, `depPrintHead()`, `depSignBlock()` and `depOpenPrintDoc()` live in `depreciation.js` and are shared by both methods.

